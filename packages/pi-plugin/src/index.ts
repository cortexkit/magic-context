/**
 * Magic Context — Pi coding agent extension.
 *
 * Loaded once per Pi session via `pi.extensions` in package.json. Boots
 * Magic Context's shared SQLite store and registers session lifecycle
 * hooks. Tool registration, message transforms, and historian/dreamer/
 * sidekick wiring follow in later steps.
 *
 * Storage: shares one SQLite database with the OpenCode plugin at
 *   ~/.local/share/cortexkit/magic-context/context.db
 * so project memories, embedding cache, dreamer runs, and other
 * project-scoped state are visible across both harnesses. Session-scoped
 * tables carry a `harness` column ('opencode' or 'pi') so per-session
 * data stays correctly attributed.
 *
 * Config: read from $project/.pi/magic-context.jsonc (project) and
 *   ~/.pi/agent/magic-context.jsonc (user) — Pi convention. Falls back to
 *   defaults when neither file exists.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { initializeEmbedding } from "@magic-context/core/features/magic-context/memory/embedding";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { openDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { log } from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parse as parseJsonc } from "comment-json";
import {
	type PiSidekickConfig,
	registerCtxAugCommand,
} from "./commands/ctx-aug";
import {
	awaitInFlightHistorians,
	type PiHistorianOptions,
	registerPiContextHandler,
} from "./context-handler";
import { PiSubagentRunner } from "./subagent-runner";
import { buildMagicContextBlock } from "./system-prompt";
import { registerMagicContextTools } from "./tools";

/**
 * Embedding config shape accepted by `initializeEmbedding`. We re-declare it
 * loosely here rather than importing the Zod-derived `EmbeddingConfig` type
 * because Step 5b will replace this whole resolver with a proper Pi config
 * loader that uses the schema directly.
 */
type StopGapEmbeddingConfig =
	| { provider: "local"; model: string }
	| {
			provider: "openai-compatible";
			model: string;
			endpoint: string;
			api_key?: string;
	  }
	| { provider: "off" };

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

/**
 * Step 5a stop-gap config resolver for sidekick. The real config-loading
 * pipeline is wired in Step 5b (mirrors `magic-context.jsonc` discovery
 * from the OpenCode plugin's `src/config/`). Until then, two paths get the
 * `/ctx-aug` flow exercised in real environments without committing config
 * loading to a half-baked design:
 *
 *   1. `MAGIC_CONTEXT_PI_SIDEKICK_MODEL` env var — sets only the model.
 *      Useful for quick local tests: `MAGIC_CONTEXT_PI_SIDEKICK_MODEL=
 *      anthropic/claude-haiku-4-5 pi`.
 *   2. Returns undefined otherwise — `/ctx-aug` registers but reports
 *      "not configured" when invoked, which is the same behavior the
 *      OpenCode plugin has when sidekick is missing from config.
 *
 * Notes for Step 5b:
 * - This whole function should disappear once `loadPiConfig()` lands.
 * - The env-var stays valid as an explicit override for testing — that's
 *   how the OpenCode plugin treats env vars in dreamer/historian config.
 * - Add timeout + system-prompt overrides to the env-var path if needed
 *   for Step 5a debugging; for now the runner default of 30s is fine.
 */
function resolveSidekickConfig(): PiSidekickConfig | undefined {
	const envModel = process.env.MAGIC_CONTEXT_PI_SIDEKICK_MODEL?.trim();
	if (envModel && envModel.length > 0) {
		return { model: envModel };
	}
	return undefined;
}

/**
 * Step 4b.3b stop-gap historian config resolver. Returns config when
 * `MAGIC_CONTEXT_PI_HISTORIAN_MODEL` env var is set; the historian
 * subagent will be invoked when the compartment trigger fires.
 *
 * Same pattern as `resolveSidekickConfig`. Step 5b's full config
 * loader will replace this with `magic-context.jsonc` discovery.
 *
 * Env vars supported:
 *   - `MAGIC_CONTEXT_PI_HISTORIAN_MODEL` (required) — provider/model id
 *   - `MAGIC_CONTEXT_PI_HISTORIAN_FALLBACKS` — comma-separated chain
 *   - `MAGIC_CONTEXT_PI_HISTORIAN_CHUNK_TOKENS` — chunk budget; default 8000
 *   - `MAGIC_CONTEXT_PI_HISTORIAN_TIMEOUT_MS` — per-call timeout
 *   - `MAGIC_CONTEXT_PI_HISTORIAN_EXECUTE_THRESHOLD` — % (1-100); default 65
 *   - `MAGIC_CONTEXT_PI_HISTORIAN_TRIGGER_BUDGET` — token target; default 8000
 */
function resolveHistorianConfig(): PiHistorianOptions | undefined {
	const model = process.env.MAGIC_CONTEXT_PI_HISTORIAN_MODEL?.trim();
	if (!model || model.length === 0) return undefined;

	const fallbackEnv = process.env.MAGIC_CONTEXT_PI_HISTORIAN_FALLBACKS;
	const fallbackModels = fallbackEnv
		? fallbackEnv
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0)
		: undefined;

	const chunkTokens = parsePositiveInt(
		process.env.MAGIC_CONTEXT_PI_HISTORIAN_CHUNK_TOKENS,
		8000,
	);
	const timeoutMs = parsePositiveInt(
		process.env.MAGIC_CONTEXT_PI_HISTORIAN_TIMEOUT_MS,
		120_000,
	);
	const executeThreshold = parsePositiveInt(
		process.env.MAGIC_CONTEXT_PI_HISTORIAN_EXECUTE_THRESHOLD,
		65,
	);
	const triggerBudget = parsePositiveInt(
		process.env.MAGIC_CONTEXT_PI_HISTORIAN_TRIGGER_BUDGET,
		8000,
	);

	return {
		runner: new PiSubagentRunner(),
		model,
		fallbackModels,
		historianChunkTokens: chunkTokens,
		timeoutMs,
		executeThresholdPercentage: executeThreshold,
		triggerBudget,
		// Conservative defaults — Step 5b config will surface these.
		memoryEnabled: true,
		autoPromote: true,
	};
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Step 5a stop-gap: read the OpenCode plugin's `magic-context.jsonc` to
 * discover the user's existing embedding configuration so Pi initializes
 * compatible vector dimensions.
 *
 * Resolution order:
 *   1. Explicit Pi env vars (none defined yet — leave for Step 5b).
 *   2. `$XDG_CONFIG_HOME/opencode/magic-context.jsonc` or
 *      `~/.config/opencode/magic-context.jsonc`.
 *   3. Local default: `local` provider + `Xenova/all-MiniLM-L6-v2`.
 *
 * Why read OpenCode's config from a Pi plugin?
 * Because the shared cortexkit/magic-context SQLite DB stores embeddings
 * tagged with their model_id. If users run both OpenCode and Pi against
 * the same project (the explicit cross-harness goal), they need to use
 * the same embedding model — otherwise vectors live in different spaces
 * and cosine similarity is always 0. The OpenCode config is treated as
 * authoritative because:
 *   - It almost always exists (Magic Context users install OpenCode first).
 *   - Its embeddings are already in the shared DB.
 *   - Pi-only users (no OpenCode) fall through to the local default.
 *
 * Step 5b will replace this with a real Pi config loader that respects
 * `$project/.pi/magic-context.jsonc` and `~/.pi/agent/magic-context.jsonc`
 * with proper schema validation. For Step 5a we only parse the embedding
 * subtree because that's what blocks ctx_search.
 */
function resolveEmbeddingConfig(): StopGapEmbeddingConfig {
	const candidatePaths = [
		process.env.XDG_CONFIG_HOME
			? join(process.env.XDG_CONFIG_HOME, "opencode", "magic-context.jsonc")
			: null,
		join(homedir(), ".config", "opencode", "magic-context.jsonc"),
	].filter((p): p is string => p !== null);

	for (const path of candidatePaths) {
		if (!existsSync(path)) continue;
		try {
			const raw = readFileSync(path, "utf-8");
			const parsed = parseJsonc(raw) as { embedding?: unknown };
			const emb = parsed?.embedding;
			if (!emb || typeof emb !== "object") continue;
			const e = emb as {
				provider?: string;
				model?: string;
				endpoint?: string;
				api_key?: string;
			};

			if (e.provider === "off") {
				info(`embedding config: read provider=off from ${path}`);
				return { provider: "off" };
			}
			if (
				e.provider === "openai-compatible" &&
				typeof e.model === "string" &&
				typeof e.endpoint === "string" &&
				e.model.length > 0 &&
				e.endpoint.length > 0
			) {
				info(`embedding config: read openai-compatible from ${path}`);
				return {
					provider: "openai-compatible",
					model: e.model,
					endpoint: e.endpoint,
					...(typeof e.api_key === "string" && e.api_key.length > 0
						? { api_key: e.api_key }
						: {}),
				};
			}
			if (e.provider === "local" || e.provider === undefined) {
				info(`embedding config: read local from ${path}`);
				return {
					provider: "local",
					model:
						typeof e.model === "string" && e.model.length > 0
							? e.model
							: "Xenova/all-MiniLM-L6-v2",
				};
			}
		} catch (err) {
			warn(
				`failed to parse embedding config at ${path}: ${err instanceof Error ? err.message : String(err)} — falling back to default`,
			);
		}
	}

	info(
		"embedding config: no OpenCode magic-context.jsonc found — using local default",
	);
	return { provider: "local", model: "Xenova/all-MiniLM-L6-v2" };
}

/**
 * Pi extension default export. Called once per Pi session.
 *
 * The extension registers itself synchronously, opens the shared SQLite
 * store, and hooks shutdown for orderly cleanup. Heavy work (tool
 * registration, transform pipeline, historian/dreamer) is deferred to
 * later steps so the spike can validate the architectural seams in
 * isolation.
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

	// Initialize the embedding runtime BEFORE registering tools. Without this,
	// `embedText()` returns null for every query, so semantic search produces
	// zero candidates and only FTS runs. FTS uses AND-of-tokens semantics, so
	// natural-language phrases like "what is the purpose of historian" return
	// no matches even though semantically-related memories exist — exactly
	// the failure mode hit during Step 5a /ctx-aug live testing.
	//
	// CROSS-HARNESS COHERENCE REQUIREMENT:
	// The shared cortexkit/magic-context DB stores memory embeddings tagged
	// with their model_id. Memories embedded by the OpenCode plugin under
	// (e.g.) qwen3-embedding-8b live in a 4096-dim space; if Pi initializes
	// a 384-dim local MiniLM model, every cosine similarity against existing
	// embeddings is 0 — so semantic search returns nothing for ALL queries
	// even though the data is there. This was the actual root cause of the
	// Step 5a "/ctx-aug returns no results" symptom.
	//
	// Step 5a stop-gap: read the OpenCode magic-context.jsonc embedding
	// section if present and reuse it. Step 5b will replace this with a
	// proper Pi-side config loader that respects $project/.pi/ and
	// ~/.pi/agent/ overrides. For now the OpenCode config wins because:
	//   - Magic Context users already have it configured.
	//   - It's the source of the existing embeddings in the shared DB.
	//   - Pi-only users (no OpenCode) get a sensible local default.
	const embeddingConfig = resolveEmbeddingConfig();
	initializeEmbedding(embeddingConfig);
	info(
		`initialized embedding runtime: provider=${embeddingConfig.provider}` +
			(embeddingConfig.provider !== "off"
				? ` model=${(embeddingConfig as { model?: string }).model ?? "(default)"}`
				: ""),
	);

	// Register the agent-facing tools. Reuses the same business logic
	// the OpenCode plugin uses (insertMemory, unifiedSearch, addNote, …)
	// via the shared cortexkit DB. Cross-harness memory sharing is automatic
	// because both plugins resolve the same project identity for the same
	// directory.
	registerMagicContextTools(pi, {
		db,
		// TODO(step 4b): wire to a real config loader. For the spike, ship
		// with the same defaults the OpenCode plugin uses out of the box.
		memoryEnabled: true,
		embeddingEnabled: true,
		gitCommitsEnabled: false,
	});
	info("registered tools: ctx_search, ctx_memory, ctx_note");

	// Register the per-LLM-call transform pipeline (Step 4b.2). Tags
	// eligible message parts via the shared Tagger and applies queued
	// drops from `pending_ops` so /ctx-flush and ctx_reduce both work
	// against Pi sessions. ctx_reduce is exposed in the tool registry so
	// agents can invoke it; ctx_reduce_enabled is hardcoded to `true`
	// here pending the Step 5b config loader.
	const historianConfig = resolveHistorianConfig();
	registerPiContextHandler(pi, {
		db,
		ctxReduceEnabled: true,
		historian: historianConfig,
	});
	info(
		historianConfig
			? `registered historian trigger (model=${historianConfig.model}, executeThreshold=${historianConfig.executeThresholdPercentage ?? 65}%)`
			: "registered historian trigger: DISABLED (set MAGIC_CONTEXT_PI_HISTORIAN_MODEL to enable)",
	);

	// Register the /ctx-aug slash command. Sidekick is "off" by default
	// for Step 5a — users opt in by writing a sidekick.model setting in
	// magic-context.jsonc. When config loading lands in Step 4b/5b, we
	// resolve the real config here. Until then, the command registers but
	// surfaces a helpful "not configured" message when invoked.
	const sidekickConfig: PiSidekickConfig | undefined = resolveSidekickConfig();
	registerCtxAugCommand(pi, sidekickConfig);
	info(
		sidekickConfig
			? `registered /ctx-aug (sidekick model=${sidekickConfig.model})`
			: "registered /ctx-aug (sidekick disabled — set sidekick.model in config)",
	);

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
	});

	// Close the shared DB on session shutdown (fires on reload). Other
	// sessions in the same process keep their own handle and are
	// unaffected. We don't need to await historians here because
	// agent_end already did that on the way out.
	pi.on("session_shutdown", async () => {
		if (db) {
			closeQuietly(db);
			info("shutdown: SQLite store closed");
		}
	});
}
