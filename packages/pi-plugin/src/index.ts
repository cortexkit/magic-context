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
import {
	deriveHistorianChunkTokens,
	deriveTriggerBudget,
	resolveHistorianContextLimit,
} from "@magic-context/core/hooks/magic-context/derive-budgets";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { log } from "@magic-context/core/shared/logger";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type PiSidekickConfig,
	registerCtxAugCommand,
} from "./commands/ctx-aug";
import { registerCtxDreamCommand } from "./commands/ctx-dream";
import { registerCtxFlushCommand } from "./commands/ctx-flush";
import { registerCtxRecompCommand } from "./commands/ctx-recomp";
import { registerCtxStatusCommand } from "./commands/ctx-status";
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
	// Defensive: schema declares `historian` required with default {}, but the
	// runtime config can come from a malformed JSONC merge that drops the
	// field. Fall back to undefined-safe access so plugin load never crashes.
	const historian = config.historian as HistorianConfig | undefined;
	const model = historian?.model?.trim();
	if (!model || model.length === 0) return undefined;

	const executeThreshold =
		typeof config.execute_threshold_percentage === "number"
			? config.execute_threshold_percentage
			: (config.execute_threshold_percentage as { default: number }).default;

	// Step 5c: replace the previous hardcoded 8K trigger budget with the
	// OpenCode-style derivation. The trigger budget anchors size-based
	// historian triggers (tail_size, commit_clusters); the chunk budget
	// scales with the HISTORIAN model's own context window so a single
	// historian call doesn't overflow.
	//
	// We don't know the main session's model at boot (Pi reports it via
	// `ctx.getContextUsage()` per turn), so we approximate `mainContextLimit`
	// using the historian model's resolved limit. For most users the
	// session model has equal-or-larger context than the historian model
	// (Sonnet/Opus session, Haiku historian), so this is safe — the
	// trigger budget will scale to the smaller of the two contexts and
	// fire historian sooner rather than later. The OpenCode plugin uses
	// the live session model here because it has direct access; that's a
	// minor parity gap, not a correctness issue.
	const historianContextLimit = resolveHistorianContextLimit(model);
	const triggerBudget = deriveTriggerBudget(
		historianContextLimit,
		executeThreshold,
	);
	const historianChunkTokens = deriveHistorianChunkTokens(
		historianContextLimit,
	);

	// Schema's `fallback_models` is `string | string[] | undefined`; Pi
	// expects readonly `string[] | undefined`. Normalize a single-string
	// fallback into a one-element array. (OpenCode does the same in its
	// agent-override resolver — single-string is shorthand for one fallback.)
	// `historian` is guaranteed defined here because we returned early on
	// `!model` above (model is derived from `historian?.model`).
	const fbRaw = historian?.fallback_models;
	const fallbackModels: readonly string[] | undefined =
		typeof fbRaw === "string" ? [fbRaw] : fbRaw;

	return {
		runner: new PiSubagentRunner(),
		model,
		fallbackModels,
		historianChunkTokens,
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

	// Council finding #5: warn loudly if Pi's configured embedding model
	// disagrees with the model that the project's stored embedding vectors
	// were produced under. Cross-harness search relies on cosine similarity
	// between vectors from the SAME model — a mismatch silently returns
	// zero hits because the embedding spaces are unrelated.
	//
	// We only warn (don't crash) because:
	//   - The user may be intentionally rotating embedding models.
	//   - Existing vectors will be re-embedded as part of the periodic
	//     dreamer sweep + on-demand re-embedding when memories update.
	//   - Hard-failing on mismatch would prevent the upgrade path from
	//     ever completing.
	//
	// The warning surfaces in `magic-context.log` so users debugging
	// "why is search returning nothing?" see a clear pointer.
	if (config.embedding.provider !== "off") {
		try {
			const { getStoredModelId } = await import(
				"@magic-context/core/features/magic-context/memory/storage-memory-embeddings"
			);
			const { getEmbeddingModelId } = await import(
				"@magic-context/core/features/magic-context/memory/embedding"
			);
			const stored = getStoredModelId(db, projectIdentity);
			const current = getEmbeddingModelId();
			if (stored && current && stored !== current) {
				warn(
					`embedding model mismatch detected for project ${projectIdentity}: ` +
						`stored vectors use "${stored}" but Pi is configured with "${current}". ` +
						"Cross-harness search will return zero results until vectors are re-embedded. " +
						"Either restore the previous embedding model in magic-context.jsonc, or wait " +
						"for the dreamer's periodic embedding sweep to backfill new vectors.",
				);
			}
		} catch (err) {
			// Embedding-model lookup is best-effort — if it throws (e.g. DB
			// schema race during first boot), don't block plugin load.
			warn("embedding model coherence check failed (non-fatal):", err);
		}
	}

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
		// `protected_tags` flows here from the loaded magic-context.jsonc
		// config (Step 5b). Defaults to schema value (20) when unset.
		// Council finding #1 (unanimous CRITICAL): a hardcoded `0` here
		// silently let recent-turn drops mid-task; use real config value.
		protectedTags: config.protected_tags ?? 20,
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

	// Step 5c: register the four diagnostic/admin slash commands so Pi
	// reaches command-surface parity with the OpenCode plugin. All four
	// commands emit `pi.sendMessage(..., { triggerTurn: false })` — they
	// are never visible to the LLM and never trigger a turn. They mirror
	// the behavior of OpenCode's command-handler.ts but use Pi-native
	// surfaces (registerCommand + sendMessage) instead of OpenCode's
	// command.execute.before hook.
	registerCtxStatusCommand(pi, {
		db,
		projectIdentity,
		protectedTags: config.protected_tags,
		nudgeIntervalTokens: config.nudge_interval_tokens,
		executeThresholdPercentage: config.execute_threshold_percentage,
		historyBudgetPercentage: config.history_budget_percentage,
		commitClusterTrigger: config.commit_cluster_trigger,
		executeThresholdTokens: config.execute_threshold_tokens,
	});
	info("registered /ctx-status");

	registerCtxFlushCommand(pi, { db });
	info("registered /ctx-flush");

	// /ctx-recomp uses its own PiSubagentRunner instance — recomp can run
	// concurrently with normal historian, and giving each its own runner
	// avoids cross-cancellation. Same model + fallback chain as historian.
	registerCtxRecompCommand(pi, {
		db,
		runner: new PiSubagentRunner(),
		historianModel: historianConfig?.model,
		historianFallbacks: historianConfig?.fallbackModels,
		historianTimeoutMs: config.historian_timeout_ms,
		memoryEnabled: config.memory.enabled,
		autoPromote: config.memory.auto_promote,
	});
	info("registered /ctx-recomp");

	registerCtxDreamCommand(pi, {
		db,
		projectDir,
		projectIdentity,
	});
	info("registered /ctx-dream");

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
			// Council finding #7: thread real embedding + memory config so
			// dreamer can do semantic dedup AND can write memory updates.
			// Previously hardcoded to off/false, making most dreamer tasks
			// useless on Pi.
			embeddingConfig: config.embedding,
			memoryEnabled: config.memory.enabled,
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
				// Council finding #3: respect memory.enabled and dreamer.inject_docs
				// from config. Hardcoded `true` previously meant the user's explicit
				// disable was ignored — memories injected into every prompt even
				// when memory.enabled=false. Same for project docs.
				memoryEnabled: config.memory.enabled,
				injectDocs: config.dreamer?.inject_docs ?? true,
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

	// Unregister project from dreamer timer on session shutdown. Pi's
	// `/reload` command tears down extensions and re-runs this default
	// export — without unregistering, the dreamer timer would hold a
	// stale reference to the previous extension instance.
	//
	// IMPORTANT: We do NOT close the SQLite handle here. `openDatabase()`
	// caches handles in a process-lifetime Map keyed by path; closing
	// the handle invalidates the cache entry, but the Map still returns
	// the closed handle on the next `openDatabase()` call after reload,
	// causing every tool/hook to fail with "database is not open". The
	// DB handle is intentionally process-lifetime — Pi's `/reload`
	// re-runs the extension code but keeps the host process alive, so
	// the cached handle is still valid across reload boundaries.
	pi.on("session_shutdown", async () => {
		try {
			unregisterPiDreamerProject({ projectIdentity });
		} catch (err) {
			warn("shutdown: unregisterPiDreamerProject threw:", err);
		}
	});
}
