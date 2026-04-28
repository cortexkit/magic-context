/**
 * Magic Context — Pi coding agent extension.
 *
 * Loaded once per Pi session via `pi.extensions` in package.json. Boots
 * Magic Context's shared SQLite store and registers session lifecycle
 * hooks: tools, transform pipeline (tagging + drops), historian trigger,
 * /ctx-aug command, system-prompt injection, dreamer scheduling, and
 * agent_end cleanup.
 *
 * Storage: shares one SQLite database with the OpenCode plugin at
 *   ~/.local/share/cortexkit/magic-context/context.db
 * so project memories, embedding cache, dreamer runs, and other
 * project-scoped state are visible across both harnesses. Session-scoped
 * tables carry a `harness` column ('opencode' or 'pi') so per-session
 * data stays correctly attributed.
 *
 * Config: read from $cwd/.pi/magic-context.jsonc (project) and
 *   ~/.pi/agent/magic-context.jsonc (user) via `loadPiConfig()`. Falls
 *   back to schema defaults when neither file exists.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import type {
	DreamerConfig,
	HistorianConfig,
	MagicContextConfig,
	SidekickConfig,
} from "@magic-context/core/config/schema/magic-context";
import { initializeEmbedding } from "@magic-context/core/features/magic-context/memory/embedding";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { openDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { log } from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type PiSidekickConfig,
	registerCtxAugCommand,
} from "./commands/ctx-aug";
import { loadPiConfig } from "./config";
import {
	awaitInFlightHistorians,
	type PiAutoSearchHandlerOptions,
	type PiHistorianOptions,
	type PiNudgeOptions,
	registerPiContextHandler,
} from "./context-handler";
import {
	awaitInFlightDreamers,
	registerPiDreamerProject,
	unregisterPiDreamerProject,
} from "./dreamer";
import { PiSubagentRunner } from "./subagent-runner";
import { buildMagicContextBlock } from "./system-prompt";
import { registerMagicContextTools } from "./tools";

const PREFIX = "[magic-context][pi]";

function info(message: string, data?: unknown): void {
	log(`${PREFIX} ${message}`, data);
}

function warn(message: string, data?: unknown): void {
	log(`${PREFIX} WARN ${message}`, data);
}

/** Plugin version from package.json. */
const PLUGIN_VERSION: string = (() => {
	try {
		const req = createRequire(import.meta.url);
		return (req("../package.json") as { version: string }).version;
	} catch {
		return "0.0.0";
	}
})();

/** Lock the harness at module load. Safe to import this file in tests; the
 * lock is idempotent and will throw only on a conflicting reset. */
setHarness("pi");

// ---------------------------------------------------------------------------
// Config-driven resolvers
//
// Step 5b replaced the env-var stop-gaps with `loadPiConfig()` which reads
// $cwd/.pi/magic-context.jsonc (project) + ~/.pi/agent/magic-context.jsonc
// (user) and merges them through the shared Zod schema. The resolvers below
// adapt the schema-shaped config into the Pi-specific options the various
// registration helpers expect.
//
// Each resolver returns `undefined` when the relevant feature is disabled
// in config, so the registration helpers can short-circuit cleanly.
// ---------------------------------------------------------------------------

function resolveSidekickFromConfig(
	config: MagicContextConfig,
): PiSidekickConfig | undefined {
	const sidekick = config.sidekick as SidekickConfig | undefined;
	if (!sidekick?.enabled) return undefined;
	const model = sidekick.model?.trim();
	if (!model || model.length === 0) return undefined;
	// Pi's PiSidekickConfig is intentionally narrower than OpenCode's
	// SidekickConfig — no fallback_models because PiSubagentRunner currently
	// runs a single model (fallback chain handling would need a wrapper
	// retry loop, see `subagent-runner.ts`). System prompt + timeout are
	// supported.
	return {
		model,
		systemPrompt: sidekick.system_prompt,
		timeoutMs: sidekick.timeout_ms,
	};
}

function resolveHistorianFromConfig(
	config: MagicContextConfig,
): PiHistorianOptions | undefined {
	const historian = config.historian as HistorianConfig;
	const model = historian.model?.trim();
	if (!model || model.length === 0) return undefined;

	// Trigger budget is derived from the OpenCode-style execute_threshold
	// math but Pi sessions don't have provider-reported context limits at
	// load time. Use a conservative default of 8000 tokens, matching the
	// previous env-var stop-gap.
	const triggerBudget = 8_000;

	const executeThreshold =
		typeof config.execute_threshold_percentage === "number"
			? config.execute_threshold_percentage
			: (config.execute_threshold_percentage as { default: number }).default;

	// Schema's `fallback_models` is `string | string[] | undefined`; Pi
	// expects readonly `string[] | undefined`. Normalize a single-string
	// fallback into a one-element array. (OpenCode does the same in its
	// agent-override resolver — single-string is shorthand for one fallback.)
	const fallbackModels: readonly string[] | undefined =
		typeof historian.fallback_models === "string"
			? [historian.fallback_models]
			: historian.fallback_models;

	return {
		runner: new PiSubagentRunner(),
		model,
		fallbackModels,
		historianChunkTokens: triggerBudget,
		timeoutMs: config.historian_timeout_ms,
		executeThresholdPercentage: executeThreshold,
		triggerBudget,
		memoryEnabled: config.memory.enabled,
		autoPromote: config.memory.auto_promote,
	};
}

function resolveNudgeFromConfig(
	config: MagicContextConfig,
): PiNudgeOptions | undefined {
	if (!config.ctx_reduce_enabled) return undefined;
	const executeThreshold =
		typeof config.execute_threshold_percentage === "number"
			? config.execute_threshold_percentage
			: (config.execute_threshold_percentage as { default: number }).default;
	return {
		protectedTags: config.protected_tags ?? 20,
		nudgeIntervalTokens: config.nudge_interval_tokens,
		iterationNudgeThreshold: config.iteration_nudge_threshold,
		executeThresholdPercentage: executeThreshold,
	};
}

function resolveAutoSearchFromConfig(
	config: MagicContextConfig,
): PiAutoSearchHandlerOptions {
	const auto = config.experimental?.auto_search;
	const enabled = auto?.enabled ?? false;
	return {
		enabled,
		scoreThreshold: auto?.score_threshold ?? 0.55,
		minPromptChars: auto?.min_prompt_chars ?? 20,
		// Memory + embedding gates flow from the top-level config keys; the
		// auto-search runner uses these to decide which sources to query.
		memoryEnabled: config.memory.enabled,
		embeddingEnabled: config.embedding.provider !== "off",
		gitCommitsEnabled:
			config.experimental?.git_commit_indexing?.enabled ?? false,
	};
}

function resolveDreamerFromConfig(
	config: MagicContextConfig,
): DreamerConfig | undefined {
	return config.dreamer;
}

/**
 * Pi extension default export. Called once per Pi session.
 *
 * Registers the full Magic Context Pi runtime: tools, transform pipeline
 * (tagging + drops), historian trigger, nudges, auto-search hint,
 * /ctx-aug command, system-prompt injection, and dreamer scheduling.
 * All driven by the user's `magic-context.jsonc` (Pi convention paths).
 */
export default async function (pi: ExtensionAPI): Promise<void> {
	const storageDir = getMagicContextStorageDir();
	const dbPath = join(storageDir, "context.db");

	let db: ContextDatabase | undefined;
	try {
		db = openDatabase();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		warn(
			`Magic Context (pi) failed to open SQLite store at ${dbPath}: ${message}. ` +
				"Plugin will not register hooks; storage path is unwritable or corrupt.",
		);
		return;
	}

	// Snapshot project identity at boot. Used downstream for memory/
	// embedding scoping. Resolution is cached for the process lifetime, so
	// calling here just primes the cache.
	const projectDir = process.cwd();
	const projectIdentity = resolveProjectIdentity(projectDir);

	info(
		`loaded v${PLUGIN_VERSION} | harness=pi | db=${dbPath} | ` +
			`project=${projectIdentity} | dir=${projectDir}`,
	);

	// Step 5b: load the user's full magic-context.jsonc config. The loader
	// reads $cwd/.pi/magic-context.jsonc and ~/.pi/agent/magic-context.jsonc
	// (Pi convention), validates them through the shared Zod schema, falls
	// back to defaults for invalid fields per-key, and returns merged
	// config + warnings.
	//
	// We surface warnings via the standard `warn()` channel so users see
	// them in the magic-context log. Loading never throws — bad config
	// gracefully degrades to defaults.
	const { config, warnings, loadedFromPaths } = loadPiConfig({
		cwd: projectDir,
	});
	if (loadedFromPaths.length > 0) {
		info(`config loaded from: ${loadedFromPaths.join(", ")}`);
	} else {
		info("config: no magic-context.jsonc found, using schema defaults");
	}
	for (const w of warnings) {
		warn(`config: ${w}`);
	}

	// Top-level disable: when `enabled: false` is set in config, register
	// nothing — same fail-closed posture the OpenCode plugin uses.
	if (!config.enabled) {
		info("plugin DISABLED via config (enabled: false) — skipping registration");
		return;
	}

	// Initialize the embedding runtime BEFORE registering tools. Without this,
	// `embedText()` returns null for every query, so semantic search produces
	// zero candidates and only FTS runs.
	//
	// CROSS-HARNESS COHERENCE: The shared cortexkit/magic-context DB stores
	// memory embeddings tagged with model_id. Pi must use the same embedding
	// model as OpenCode for cosine similarity to work against existing
	// vectors — otherwise every search returns 0 hits. The schema's
	// `embedding` block is shared between harnesses, so users only need to
	// set it once (typically in the user-level magic-context.jsonc).
	initializeEmbedding(config.embedding);
	info(
		`initialized embedding runtime: provider=${config.embedding.provider}` +
			(config.embedding.provider !== "off"
				? ` model=${(config.embedding as { model?: string }).model ?? "(default)"}`
				: ""),
	);

	// Register the agent-facing tools. Reuses the same business logic
	// the OpenCode plugin uses (insertMemory, unifiedSearch, addNote, …)
	// via the shared cortexkit DB. Cross-harness memory sharing is automatic
	// because both plugins resolve the same project identity for the same
	// directory.
	registerMagicContextTools(pi, {
		db,
		memoryEnabled: config.memory.enabled,
		embeddingEnabled: config.embedding.provider !== "off",
		gitCommitsEnabled:
			config.experimental?.git_commit_indexing?.enabled ?? false,
	});
	info("registered tools: ctx_search, ctx_memory, ctx_note");

	// Register the per-LLM-call transform pipeline. Tags eligible message
	// parts via the shared Tagger and applies queued drops from
	// `pending_ops` so /ctx-flush and ctx_reduce work against Pi sessions.
	const historianConfig = resolveHistorianFromConfig(config);
	const nudgeConfig = resolveNudgeFromConfig(config);
	const autoSearchConfig = resolveAutoSearchFromConfig(config);
	registerPiContextHandler(pi, {
		db,
		ctxReduceEnabled: config.ctx_reduce_enabled,
		historian: historianConfig,
		nudge: nudgeConfig,
		autoSearch: autoSearchConfig,
	});
	info(
		historianConfig
			? `registered historian trigger (model=${historianConfig.model}, executeThreshold=${historianConfig.executeThresholdPercentage ?? 65}%)`
			: "registered historian trigger: DISABLED (set historian.model in magic-context.jsonc)",
	);
	info(
		nudgeConfig
			? `registered nudges (protected=${nudgeConfig.protectedTags}, interval=${nudgeConfig.nudgeIntervalTokens}, iter=${nudgeConfig.iterationNudgeThreshold})`
			: "registered nudges: DISABLED (ctx_reduce_enabled=false)",
	);
	info(
		autoSearchConfig.enabled
			? `registered auto-search hint (threshold=${autoSearchConfig.scoreThreshold}, minChars=${autoSearchConfig.minPromptChars})`
			: "registered auto-search hint: DISABLED (experimental.auto_search.enabled=false)",
	);

	// Register the /ctx-aug slash command. Sidekick config is read straight
	// from `config.sidekick` — when disabled or missing a model, the command
	// surfaces a "not configured" message instead of attempting to run.
	const sidekickConfig: PiSidekickConfig | undefined =
		resolveSidekickFromConfig(config);
	registerCtxAugCommand(pi, sidekickConfig);
	info(
		sidekickConfig
			? `registered /ctx-aug (sidekick model=${sidekickConfig.model})`
			: "registered /ctx-aug (sidekick disabled — set sidekick.enabled=true and sidekick.model in config)",
	);

	// Register Pi project with the singleton dreamer timer. When dreamer is
	// disabled in config (default) this is a no-op. When enabled, the timer
	// schedules dream runs based on config.dreamer.schedule and uses
	// PiSubagentRunner to spawn child sessions for each task.
	const dreamerConfig = resolveDreamerFromConfig(config);
	if (dreamerConfig) {
		registerPiDreamerProject({
			db,
			projectDir,
			projectIdentity,
			config: dreamerConfig,
		});
		info(
			dreamerConfig.enabled
				? `registered dreamer (schedule=${dreamerConfig.schedule}, tasks=[${dreamerConfig.tasks.join(",")}])`
				: "registered dreamer: DISABLED (dreamer.enabled=false)",
		);
	} else {
		info("registered dreamer: DISABLED (no dreamer config)");
	}

	// Inject project memories and dreamer-maintained docs into the system
	// prompt for every agent turn. This is the user-visible "memories show
	// up" behavior — without it, the tools work but the agent has no
	// background context until it explicitly calls ctx_search.
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			// Pi exposes `sessionManager.getSessionId()` once a session is
			// active. We resolve it here defensively because before_agent_start
			// fires once per agent turn and the session ID is what scopes
			// `<session-history>` (compartments + facts published by historian).
			const sm = ctx.sessionManager;
			let sessionId: string | undefined;
			if (sm !== undefined) {
				const getId = (sm as { getSessionId?: () => string | undefined })
					.getSessionId;
				if (typeof getId === "function") {
					try {
						const id = getId.call(sm);
						if (typeof id === "string" && id.length > 0) sessionId = id;
					} catch {
						// Fail open — sessionId stays undefined, session-history is skipped.
					}
				}
			}

			const block = buildMagicContextBlock({
				db,
				cwd: ctx.cwd,
				sessionId,
				memoryEnabled: true,
				injectDocs: true,
			});
			if (!block) return;
			return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
		} catch (error) {
			warn("failed to build magic-context block:", error);
			return;
		}
	});
	info("registered before_agent_start system prompt injector");

	// Best-effort wait for in-flight historian runs at agent_end.
	//
	// IMPORTANT LIMITATION: This works in interactive Pi sessions, where
	// the process stays alive between turns and historian runs from a
	// previous turn complete naturally before the next one starts. It
	// does NOT work reliably in `pi --print` mode (single-turn, exits
	// after agent_end). Pi's @mariozechner/pi-agent-core uses synchronous
	// listener fanout (`agent.emit(e) { for (const l of listeners) l(e); }`)
	// — async listeners return a Promise that the agent never awaits, so
	// the parent process exits while our await chain is still pending and
	// the spawned subprocess gets killed mid-run.
	//
	// Production users running interactive `pi` are unaffected. The fix
	// for `--print` mode would either need pi-coding-agent to await async
	// emit listeners (upstream patch) or magic-context to do its own
	// process.exit gating (fragile). For now we keep the wait — it helps
	// where it can, and is harmless where it can't.
	pi.on("agent_end", async () => {
		try {
			await awaitInFlightHistorians();
		} catch (err) {
			warn("agent_end: awaitInFlightHistorians threw:", err);
		}
		try {
			await awaitInFlightDreamers();
		} catch (err) {
			warn("agent_end: awaitInFlightDreamers threw:", err);
		}
	});

	// Close the shared DB on session shutdown (fires on reload). Other
	// sessions in the same process keep their own handle and are
	// unaffected. We don't need to await historians here because
	// agent_end already did that on the way out.
	pi.on("session_shutdown", async () => {
		// Unregister this project from the singleton dreamer timer first so
		// the next 15-minute tick doesn't enqueue work for a session that's
		// already shutting down.
		try {
			unregisterPiDreamerProject({ projectIdentity });
		} catch (err) {
			warn("shutdown: unregisterPiDreamerProject threw:", err);
		}
		if (db) {
			closeQuietly(db);
			info("shutdown: SQLite store closed");
		}
	});
}
