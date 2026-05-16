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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	DreamerConfig,
	HistorianConfig,
	MagicContextConfig,
	SidekickConfig,
} from "@magic-context/core/config/schema/magic-context";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { scheduleIncrementalIndex } from "@magic-context/core/features/magic-context/message-index-async";
import { detectOverflow } from "@magic-context/core/features/magic-context/overflow-detection";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { openDatabase } from "@magic-context/core/features/magic-context/storage-db";
import {
	getOverflowState,
	recordOverflowDetected,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import {
	deriveHistorianChunkTokens,
	deriveTriggerBudget,
	resolveHistorianContextLimit,
} from "@magic-context/core/hooks/magic-context/derive-budgets";
import { resolveCacheTtl } from "@magic-context/core/hooks/magic-context/event-resolvers";
import {
	clearNoteNudgeTriggerAndCooldown,
	onNoteTrigger,
} from "@magic-context/core/hooks/magic-context/note-nudger";
import { normalizeTodoStateJson } from "@magic-context/core/hooks/magic-context/todo-view";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { log } from "@magic-context/core/shared/logger";
import {
	clearModelsDevCache,
	getModelsDevContextLimit,
} from "@magic-context/core/shared/models-dev-cache";
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
	clearContextHandlerSession,
	clearSystemPromptRefresh,
	hasSystemPromptRefresh,
	type PiAutoSearchHandlerOptions,
	type PiHistorianOptions,
	type PiNudgeOptions,
	recordPiCtxReduceExecution,
	recordPiLiveModel,
	recordPiToolExecution,
	registerPiContextHandler,
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
	signalPiSystemPromptRefresh,
} from "./context-handler";
import {
	awaitInFlightDreamers,
	registerPiDreamerProject,
	unregisterPiDreamerProject,
} from "./dreamer";
import { ensureProjectRegisteredFromPiDirectory } from "./embedding-bootstrap";
import { computePiPressure, extractAssistantUsage } from "./pi-pressure";
import { readPiSessionMessages } from "./read-session-pi";
import { registerStatusLine, updateStatusLine } from "./status-line";
import { stripTagPrefixFromAssistantMessage } from "./strip-tag-prefix";
import { PiSubagentRunner } from "./subagent-runner";
import {
	buildMagicContextBlock,
	clearPiSystemPromptSession,
	processSystemPromptForCache,
} from "./system-prompt";
import { registerMagicContextTools } from "./tools";

const PREFIX = "[magic-context][pi]";

export function persistPiMessageEndModelMeta(args: {
	db: ContextDatabase;
	sessionId: string;
	message: unknown;
	cacheTtlConfig: MagicContextConfig["cache_ttl"];
}): void {
	if (!args.message || typeof args.message !== "object") return;
	const msg = args.message as {
		role?: string;
		provider?: string;
		model?: string;
	};
	if (
		msg.role !== "assistant" ||
		typeof msg.provider !== "string" ||
		msg.provider.length === 0 ||
		typeof msg.model !== "string" ||
		msg.model.length === 0
	) {
		return;
	}
	const modelKey = `${msg.provider}/${msg.model}`;
	recordPiLiveModel(args.sessionId, modelKey);
	const cacheTtl = resolveCacheTtl(args.cacheTtlConfig, modelKey);
	const currentMeta = getOrCreateSessionMeta(args.db, args.sessionId);
	if (currentMeta.cacheTtl !== cacheTtl) {
		updateSessionMeta(args.db, args.sessionId, { cacheTtl });
	}
}

function info(message: string, data?: unknown): void {
	log(`${PREFIX} ${message}`, data);
}

function warn(message: string, data?: unknown): void {
	log(`${PREFIX} WARN ${message}`, data);
}

function formatTokens(value: number): string {
	return value.toLocaleString();
}

function getPiMessageModel(message: unknown): {
	provider: string | undefined;
	model: string | undefined;
} {
	if (!message || typeof message !== "object") {
		return { provider: undefined, model: undefined };
	}
	const msg = message as { provider?: unknown; model?: unknown };
	return {
		provider: typeof msg.provider === "string" ? msg.provider : undefined,
		model: typeof msg.model === "string" ? msg.model : undefined,
	};
}

function resolvePiPressureContextLimit(args: {
	db: ContextDatabase;
	sessionId: string;
	provider: string | undefined;
	model: string | undefined;
	piContextWindow: number;
}): number {
	const cachedLimit =
		args.provider && args.model
			? getModelsDevContextLimit(args.provider, args.model)
			: undefined;
	let effectiveContextLimit = cachedLimit ?? args.piContextWindow;
	try {
		const overflowState = getOverflowState(args.db, args.sessionId);
		if (overflowState.detectedContextLimit > 0) {
			effectiveContextLimit =
				effectiveContextLimit > 0
					? Math.min(effectiveContextLimit, overflowState.detectedContextLimit)
					: overflowState.detectedContextLimit;
		}
	} catch (err) {
		warn("message_end: getOverflowState failed:", err);
	}
	return effectiveContextLimit;
}

export async function persistPiPressureFromMessageEnd(args: {
	db: ContextDatabase;
	sessionId: string;
	message: unknown;
	piContextWindow: number;
	piTokens?: number;
	notifyIssue?: (message: string) => unknown | Promise<unknown>;
}): Promise<void> {
	const { provider, model } = getPiMessageModel(args.message);
	const effectiveContextLimit = resolvePiPressureContextLimit({
		db: args.db,
		sessionId: args.sessionId,
		provider,
		model,
		piContextWindow: args.piContextWindow,
	});
	const usage = extractAssistantUsage(args.message);
	const pressure = computePiPressure(usage, effectiveContextLimit);
	const msg =
		args.message && typeof args.message === "object"
			? (args.message as { errorMessage?: unknown })
			: undefined;
	const messageHadOverflowError =
		typeof msg?.errorMessage === "string" &&
		detectOverflow(msg.errorMessage).isOverflow;
	const updates: Partial<{
		lastResponseTime: number;
		lastContextPercentage: number;
		lastInputTokens: number;
		observedSafeInputTokens: number;
		cacheAlertSent: boolean;
	}> = { lastResponseTime: Date.now() };

	if (pressure) {
		let percentage = pressure.percentage;
		let contextLimit = effectiveContextLimit;
		const meta = getOrCreateSessionMeta(args.db, args.sessionId);
		const observedSafeInputTokens = meta.observedSafeInputTokens ?? 0;
		if (
			percentage > 100 &&
			observedSafeInputTokens > 0 &&
			pressure.inputTokens <= observedSafeInputTokens * 2
		) {
			const oldLimit = contextLimit;
			clearModelsDevCache();
			contextLimit = resolvePiPressureContextLimit({
				db: args.db,
				sessionId: args.sessionId,
				provider,
				model,
				piContextWindow: args.piContextWindow,
			});
			if (contextLimit >= pressure.inputTokens) {
				percentage = (pressure.inputTokens / contextLimit) * 100;
				log(
					`${PREFIX} models-dev-cache: regression recovered for ${provider}/${model} via Pi cache reload (was=${oldLimit}, now=${contextLimit})`,
				);
			} else if (!meta.cacheAlertSent) {
				updates.cacheAlertSent = true;
				const safeTokens = Math.max(
					observedSafeInputTokens,
					pressure.inputTokens,
				);
				const modelLabel =
					provider && model ? `${provider}/${model}` : "the active model";
				await args.notifyIssue?.(
					`⚠️ Magic Context: Pi reports a context limit of ${formatTokens(contextLimit)} tokens for ${modelLabel} but you've successfully sent ${formatTokens(safeTokens)} tokens in this session — the cached limit looks wrong. Restart Pi if you suspect this is incorrect.`,
				);
			}
		}
		updates.lastContextPercentage = percentage;
		updates.lastInputTokens = pressure.inputTokens;
		if (!messageHadOverflowError) {
			updates.observedSafeInputTokens = Math.max(
				observedSafeInputTokens,
				pressure.inputTokens,
			);
		}
	} else if (typeof args.piTokens === "number") {
		updates.lastInputTokens = args.piTokens;
		if (args.piContextWindow > 0) {
			updates.lastContextPercentage =
				(args.piTokens / args.piContextWindow) * 100;
		}
	}

	updateSessionMeta(args.db, args.sessionId, updates);
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
		thinking_level: sidekick.thinking_level,
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
	const triggerBudget = deriveTriggerBudget(historianContextLimit, 65);
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
		// `historian.two_pass` runs an editor pass after a successful
		// first pass to clean low-signal U: lines and cross-compartment
		// duplicates. Mirrors OpenCode's config flag — defaults to false
		// on the schema side because the editor pass adds a second
		// historian round-trip's latency and token cost. Enable for
		// long sessions where chunk dedupe matters more than speed.
		twoPass: historian?.two_pass === true,
		// Pi only: explicit thinking level for historian subagent invocations.
		// When set, passed as --thinking <level> to Pi subprocess.
		// Required for providers like GitHub Copilot that apply bad defaults.
		thinkingLevel: historian?.thinking_level,
		executeThresholdPercentage: config.execute_threshold_percentage,
		triggerBudget,
		historyBudgetPercentage: config.history_budget_percentage,
		compressor: {
			enabled: config.compressor.enabled,
			minCompartmentRatio: config.compressor.min_compartment_ratio,
			maxMergeDepth: config.compressor.max_merge_depth,
			cooldownMs: config.compressor.cooldown_ms,
			maxCompartmentsPerPass: config.compressor.max_compartments_per_pass,
			graceCompartments: config.compressor.grace_compartments,
		},
		memoryEnabled: config.memory.enabled,
		autoPromote: config.memory.auto_promote,
	};
}

function resolveNudgeFromConfig(
	config: MagicContextConfig,
): PiNudgeOptions | undefined {
	if (!config.ctx_reduce_enabled) return undefined;
	return {
		protectedTags: config.protected_tags ?? 20,
		nudgeIntervalTokens: config.nudge_interval_tokens,
		iterationNudgeThreshold: config.iteration_nudge_threshold,
		executeThresholdPercentage: config.execute_threshold_percentage,
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

	await ensureProjectRegisteredFromPiDirectory(projectDir, db);
	info(`registered embedding config for project ${projectIdentity}`);

	// Register the agent-facing tools. Reuses the same business logic
	// the OpenCode plugin uses (insertMemory, unifiedSearch, addNote, …)
	// via the shared cortexkit DB. Cross-harness memory sharing is automatic
	// because both plugins resolve the same project identity for the same
	// directory.
	registerMagicContextTools(pi, {
		db,
		ensureProjectRegistered: ensureProjectRegisteredFromPiDirectory,
		// Main extension entry never gets the dreamer-only ctx_memory
		// surface — those actions are reserved for dreamer subagents
		// loaded via subagent-entry.ts with the
		// `--magic-context-dreamer-actions` flag.
		allowDreamerActions: false,
		// Match OpenCode's gating: when ctx_reduce_enabled is false,
		// we don't surface the tool at all (along with disabling §N§
		// prefix injection and stripping ctx_reduce mentions from the
		// system prompt). When true, register ctx_reduce.
		ctxReduceEnabled: config.ctx_reduce_enabled === true,
		protectedTags: config.protected_tags ?? 20,
		// Smart notes (surface_condition) only work when dreamer is
		// running — otherwise the note sits `pending` forever with no
		// path to surface. Match the user's dreamer config flag.
		dreamerEnabled: config.dreamer?.enabled === true,
	});
	info(
		`registered tools: ctx_search, ctx_memory, ctx_note, ctx_expand${
			config.ctx_reduce_enabled === true ? ", ctx_reduce" : ""
		}`,
	);

	// Register the per-LLM-call transform pipeline. Tags eligible message
	// parts via the shared Tagger and applies queued drops from
	// `pending_ops` so /ctx-flush and ctx_reduce work against Pi sessions.
	const historianConfig = resolveHistorianFromConfig(config);
	if (historianConfig) {
		historianConfig.onStatusChange = (ctx) => {
			updateStatusLine(ctx, { db, projectIdentity });
		};
	}
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
		// Heuristic-cleanup config — drops aged tools, dedups, strips
		// system injections, age-tier caveman compression. The biggest
		// reduction lever: a session that just loaded 3000 tagged
		// messages immediately drops everything older than
		// auto_drop_tool_age outside the protected tail. Only forwarded
		// when ctx_reduce_enabled=false for caveman (the feature
		// replaces manual ctx_reduce text dropping).
		heuristics: {
			autoDropToolAge: config.auto_drop_tool_age,
			dropToolStructure: config.drop_tool_structure,
			caveman:
				config.ctx_reduce_enabled === false &&
				config.experimental?.caveman_text_compression
					? {
							enabled: config.experimental.caveman_text_compression.enabled,
							minChars: config.experimental.caveman_text_compression.min_chars,
						}
					: undefined,
			// Forward the user's clear_reasoning_age. Pi previously hardcoded
			// 30, ignoring this config entirely. Schema default is 50 (matches
			// OpenCode `magic-context.ts:303`).
			clearReasoningAge: config.clear_reasoning_age,
		},
		// <session-history> injection — writes compartments + facts +
		// project memories into message[0]. Cross-harness coherent:
		// memories shared with OpenCode show up here automatically.
		injection: {
			injectionBudgetTokens: config.memory.injection_budget_tokens,
			temporalAwareness: config.experimental?.temporal_awareness === true,
		},
		// Scheduler config — TTL + threshold gating for cache-busting
		// stages. Heuristic cleanup runs only on execute passes so
		// provider prompt cache stays warm on defer passes.
		scheduler: {
			executeThresholdPercentage: config.execute_threshold_percentage,
			executeThresholdTokens: config.execute_threshold_tokens,
		},
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
	registerStatusLine(pi, { db, projectIdentity });
	info("registered magic-context status line");

	registerCtxFlushCommand(pi, { db });
	info("registered /ctx-flush");

	// /ctx-recomp uses its own PiSubagentRunner instance — recomp can run
	// concurrently with normal historian, and giving each its own runner
	// avoids cross-cancellation. Same model + fallback chain as historian.
	registerCtxRecompCommand(pi, {
		db,
		runner: new PiSubagentRunner(),
		historianModel: historianConfig?.model,
		historianChunkTokens: deriveHistorianChunkTokens(
			resolveHistorianContextLimit(historianConfig?.model),
		),
		historianFallbacks: historianConfig?.fallbackModels,
		historianTimeoutMs: config.historian_timeout_ms,
		historianThinkingLevel: historianConfig?.thinkingLevel,
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
			gitCommitIndexing: config.experimental.git_commit_indexing,
		});
		info(
			dreamerConfig.enabled
				? `registered dreamer (schedule=${dreamerConfig.schedule}, tasks=[${dreamerConfig.tasks.join(",")}])`
				: "registered dreamer: DISABLED (dreamer.enabled=false)",
		);
	} else {
		info("registered dreamer: DISABLED (no dreamer config)");
	}

	// Inject the magic-context block (guidance + project-docs +
	// user-profile + key-files) into the system prompt for every agent
	// turn, then run hash-detection + sticky-date freezing so the
	// resulting prompt stays cache-stable across turns when nothing
	// material has changed.
	//
	// Pi has prefix caching the same way OpenCode does — every major
	// LLM provider (Anthropic, OpenAI, Codex, GitHub Copilot, etc.)
	// caches the system prompt portion of the prefix. Drift between
	// turns busts the cache and the user pays full input price for the
	// next call. The protections here mirror OpenCode's
	// `experimental.chat.system.transform` handler in
	// `system-prompt-hash.ts`.
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			// Pi exposes `sessionManager.getSessionId()` once a session is
			// active. We resolve it here defensively because before_agent_start
			// fires once per agent turn.
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
						// Fail open — sessionId stays undefined.
					}
				}
			}

			// PEEK the system-prompt refresh signal. Set by:
			//   - `/ctx-flush`
			//   - dreamer publication of new ARCHITECTURE.md / STRUCTURE.md
			//   - user-memory promotion (dreamer)
			//   - hash-change detection on the previous turn (signaled below)
			//
			// When set, we re-read disk-backed adjuncts on this turn. When
			// not set, cached values are reused.
			//
			// PEEK-then-drain-on-success (Oracle audit Round 8 #6): we
			// only `clearSystemPromptRefresh(...)` AFTER the rebuild
			// (`buildMagicContextBlock` + `processSystemPromptForCache`)
			// completes successfully. If either throws, the flag survives
			// so the next prompt retries the rebuild.
			const isCacheBusting = sessionId
				? hasSystemPromptRefresh(sessionId)
				: true; // first-pass-no-session: act as cache-busting (force fresh read)

			const block = buildMagicContextBlock({
				db,
				cwd: ctx.cwd,
				sessionId,
				memoryEnabled: config.memory.enabled,
				injectDocs: config.dreamer?.inject_docs ?? true,
				includeGuidance: true,
				protectedTags: config.protected_tags,
				ctxReduceEnabled: config.ctx_reduce_enabled,
				dreamerEnabled: config.dreamer?.enabled ?? false,
				dropToolStructure: config.drop_tool_structure,
				temporalAwarenessEnabled:
					config.experimental?.temporal_awareness ?? false,
				cavemanTextCompressionEnabled:
					config.ctx_reduce_enabled === false &&
					config.experimental?.caveman_text_compression?.enabled === true,
				// Stable user memories rendered as <user-profile> — dreamer
				// promotes recurring observations into this set, then the
				// system prompt surfaces them across all sessions in the
				// project. Gated on dreamer.user_memories.enabled.
				userMemoriesEnabled:
					(config.dreamer?.enabled ?? false) &&
					(config.dreamer?.user_memories?.enabled ?? false),
				// Pinned key files rendered as <key-files> — dreamer selects
				// frequently-read files per session, then we read them off
				// disk with path-traversal + token-budget guards.
				pinKeyFilesEnabled:
					(config.dreamer?.enabled ?? false) &&
					(config.dreamer?.pin_key_files?.enabled ?? false),
				pinKeyFilesTokenBudget:
					config.dreamer?.pin_key_files?.token_budget ?? 10_000,
				isCacheBusting,
			});

			// Compose the final system prompt: base prompt from Pi + our
			// magic-context block. We always run hash detection on the
			// composed string so even sessions with no data block (e.g.
			// memories disabled, no docs, no key files) still get
			// sticky-date freezing and hash-change tracking.
			const composedPrompt = block
				? `${event.systemPrompt}\n\n${block}`
				: event.systemPrompt;

			if (!sessionId) {
				// No session id yet — return the composed prompt without
				// cache logic. The next turn (with a session id) will
				// compute the first hash and set sticky date.
				if (block) return { systemPrompt: composedPrompt };
				return;
			}

			const result = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: composedPrompt,
				isCacheBusting,
			});

			if (result.hashChanged) {
				// Real prompt-content change. Cache prefix is already
				// busted on this turn. Signal all three independent
				// refresh sets so the next pi.on("context") event
				// rebuilds <session-history> + lets queued ops
				// materialize, AND the next before_agent_start refreshes
				// adjuncts (since this turn's adjunct read used the
				// cached values that are now potentially stale).
				signalPiHistoryRefresh(sessionId);
				signalPiSystemPromptRefresh(sessionId);
				signalPiPendingMaterialization(sessionId);
			}

			// PEEK-then-drain-on-success (Oracle audit Round 8 #6):
			// drain only if the start-of-pass peek was true. Using the
			// CAPTURED boolean (not a re-read of the set) so that a
			// signal added later in the same pass — e.g. `result.hashChanged`
			// just above — survives to the next prompt for retry.
			if (isCacheBusting) {
				clearSystemPromptRefresh(sessionId);
			}

			return { systemPrompt: result.systemPrompt };
		} catch (error) {
			warn("failed to build magic-context block:", error);
			return;
		}
	});
	info("registered before_agent_start system prompt injector");

	// agent_end MUST be fire-and-forget for in-flight historian / dreamer
	// runs.
	//
	// REGRESSION FIXED HERE: Earlier code awaited `awaitInFlightHistorians()`
	// inside this handler with the (incorrect) assumption that Pi's event
	// fanout is synchronous and ignores returned Promises. In reality
	// pi-coding-agent's `extensions/runner.js` does `await handler(event, ctx)`
	// for every extension `agent_end` handler, and `agent-session.js`
	// awaits its own emit before delivering the UI-facing `agent_end`.
	// The TUI loader stops only after that UI event. Net effect: every
	// turn that triggered a historian (a 30s+ background subagent) left
	// the user staring at "Working..." with `historian` pinned in the
	// footer until the background run finished — the OPPOSITE of the
	// "compact in the background while the main agent keeps working"
	// invariant magic-context is supposed to provide.
	//
	// Why fire-and-forget is safe in interactive mode:
	//   - The Pi process stays alive between turns. The next turn's
	//     `pi.on("context")` handler checks `inFlightHistorian.has(sessionId)`
	//     and skips re-firing while a previous historian is still
	//     running, so we never double-spawn.
	//   - Historian publication paths register the run promise in
	//     `inFlightHistorian` so emergency 95% waits and `session_shutdown`
	//     drainage can still join the background work when actually
	//     needed.
	//   - All work historian does is durable (compartment + fact rows,
	//     publish marker, signalPiHistoryRefresh). Even if the user
	//     closes Pi mid-historian and the subprocess gets killed, the
	//     next session start re-evaluates and either picks up where the
	//     prior run left off or recovers from `historian_failure_count`.
	//
	// `pi --print` (single-turn, exits after agent_end) is the one mode
	// where backgrounding is genuinely incompatible with subprocess
	// lifetime — Pi's process exits and SIGKILLs the still-running
	// historian. That tradeoff is intentional: print mode is for
	// scripting / one-shot tasks where blocking the user's interactive
	// shell on a 30s historian is also wrong, just in a different way.
	// We let print mode skip the wait too. Users who want guaranteed
	// historian completion in print mode should run interactive Pi
	// instead.
	pi.on("agent_end", () => {
		// Synchronous return — DO NOT await background work here.
		// awaitInFlightHistorians()/awaitInFlightDreamers() are still
		// invoked at session_shutdown where they belong (and where pi
		// gives us a window before tearing down stdio). Errors from
		// background runs are handled by their own try/catch chains
		// (runPiHistorian wraps everything; spawnPiHistorianRun's
		// .finally cleans up the inFlight map).
		log("agent_end: returning synchronously (background work continues)");
	});

	// Tool-execution-start hook: detect note-nudge triggers from
	// agent tool usage. Mirrors OpenCode's `tool.execute.after` hook in
	// `hook-handlers.ts` (`createToolExecuteAfterHook`). We use Pi's
	// `tool_execution_start` event because (a) it fires before the tool
	// runs (so we can inspect args without waiting for output, matching
	// OpenCode's `tool.execute.before`/`after` that have full args
	// available), and (b) `tool_execution_end` is fire-and-forget and
	// could race with the next pipeline pass.
	//
	// What we wire:
	//
	//   - `todowrite` with all-terminal todos → `todos_complete` trigger.
	//     The agent's `todos` arg is an array of {id, content, status}
	//     items. Note nudges should fire only when EVERY item is in a
	//     terminal state (`completed` or `cancelled`) — firing on every
	//     todowrite is too eager since agents call it repeatedly during
	//     work to mark intermediate progress.
	//
	//   - `ctx_note` (any action) → `clearNoteNudgeState(sessionId)`.
	//     The agent already saw / acted on notes, so we kill any
	//     pending sticky reminder for this session right away. Subagents
	//     never deliver note nudges (gated upstream in postprocess),
	//     so we still skip the trigger for them. Mirrors OpenCode's
	//     `if (typedInput.tool === "ctx_note") clearNoteNudgeState(...)`.
	pi.on("tool_execution_start", async (event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (event.toolName === "todowrite") {
				const todoArgs = event.args as
					| { todos?: Array<{ status?: string }> }
					| undefined;
				const todos = todoArgs?.todos;
				const sessionMeta = Array.isArray(todos)
					? getOrCreateSessionMeta(db, sessionId)
					: null;

				// Synthetic-todowrite snapshot capture (Pi parity with
				// OpenCode hook-handlers.ts:386-401). Persist normalized
				// state on EVERY todowrite call so the transform-time
				// injection path in pi-pipeline.ts always has a current
				// snapshot to replay on the next cache-busting pass.
				// Cache-safe: this is a pure DB write with no message
				// mutation. Subagents skip — they do not get synthetic
				// todowrite injection.
				if (sessionMeta && !sessionMeta.isSubagent) {
					const normalizedTodos = normalizeTodoStateJson(todos);
					if (normalizedTodos !== null) {
						updateSessionMeta(db, sessionId, {
							lastTodoState: normalizedTodos,
						});
					}
				}

				if (
					Array.isArray(todos) &&
					todos.length > 0 &&
					todos.every(
						(t) => t.status === "completed" || t.status === "cancelled",
					)
				) {
					if (sessionMeta && !sessionMeta.isSubagent) {
						onNoteTrigger(db, sessionId, "todos_complete");
					}
				}
			} else if (event.toolName === "ctx_note") {
				clearNoteNudgeTriggerAndCooldown(db, sessionId);
			}
		} catch (err) {
			// tool-event hook is opportunistic; failure should not break
			// the agent loop.
			log(
				`tool_execution_start hook failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (typeof sessionId !== "string" || sessionId.length === 0) return;
			if (event.toolName === "ctx_reduce") {
				recordPiCtxReduceExecution(sessionId);
			}
			recordPiToolExecution(sessionId);
		} catch (err) {
			log(
				`tool_execution_end hook failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

	// Cancel Pi's native context compaction. Magic Context owns the
	// compacted view of conversation history through its own historian
	// pipeline (compartments + facts + memories rendered as
	// `<session-history>` in `pi.on("context")`). If Pi's auto-compaction
	// were to run, it would:
	//   1. Pack the full conversation into a single plain-text user
	//      message and ask the LLM to summarize it. For sessions with a
	//      lot of accumulated history (especially after `doctor migrate`)
	//      that summarization request itself overflows the model's
	//      context window — the failure mode that surfaced as
	//      "Context overflow recovery failed" on migrated sessions.
	//   2. Replace history with that flat summary and lose the structured
	//      compartment / fact / memory state we depend on.
	//
	// Returning `{ cancel: true }` aborts both the threshold-driven
	// auto-compact and the post-overflow recovery compact. Pi treats
	// the abort as a no-op and proceeds with the unmodified branch on
	// the next turn — at which point our `pi.on("context")` transform
	// shrinks the prompt via tag drops, caveman compression, and
	// `<session-history>` injection over the much smaller live tail.
	//
	// Steady-state sessions normally don't hit this path because our
	// historian writes a Pi compaction marker at the boundary
	// (`sessionManager.appendCompaction()`), so `getBranch()` already
	// trims the prefix before Pi ever evaluates `shouldCompact`. The
	// hook is the safety net for everything else: migrated sessions
	// without a compaction marker, sessions where historian failed,
	// or any future flow where Pi's heuristic decides to compact.
	pi.on("session_before_compact", async () => {
		info("session_before_compact: cancelling — magic-context owns compaction");
		return { cancel: true };
	});

	// Strip injected `§N§` tag prefix from assistant text BEFORE Pi
	// persists the message to disk and renders it to the UI. Mirrors
	// OpenCode's `experimental.text.complete` handler which scrubs the
	// prefix from `output.text` before the assistant message lands in
	// `opencode.db`.
	//
	// Pi's `agent-session.ts` emits `message_end` to extensions BEFORE
	// calling `sessionManager.appendMessage(event.message)`. Mutating
	// the message reference in this handler is therefore visible to
	// the persistence call — same effect as OpenCode's hook on a
	// different harness.
	//
	// Why this matters: LLMs frequently mimic the `§N§` prefix they
	// see on prior assistant messages and emit `§4§ Yes...` at the
	// start of a fresh response. The mimicry is harmless for cache
	// (we re-strip and re-inject on the next transform pass), but the
	// stored text is what Pi's UI renders — without this scrub, users
	// see internal tag IDs at the start of every assistant turn.
	pi.on("message_end", async (event, ctx) => {
		try {
			const msg = event.message as unknown;
			if (msg !== null && typeof msg === "object") {
				stripTagPrefixFromAssistantMessage(
					msg as { role: string; content: unknown },
				);
			}
		} catch (err) {
			warn("message_end: stripTagPrefixFromAssistantMessage threw:", err);
		}

		// Update last_response_time + last_input_tokens + last_context_percentage
		// so the scheduler's TTL gating can decide between execute and defer
		// on the next transform pass. Without this, every Pi pass would either
		// always execute (stale lastResponseTime=0 → TTL elapsed) or always
		// defer (no usage data) — neither matches OpenCode parity.
		try {
			const sm = ctx.sessionManager as
				| { getSessionId?: () => string | undefined }
				| undefined;
			const sessionId = sm?.getSessionId?.();
			if (typeof sessionId !== "string" || sessionId.length === 0) return;
			const rawMessages = readPiSessionMessages(ctx);
			const latest = rawMessages[rawMessages.length - 1];
			if (latest?.role === "assistant" && latest.id.length > 0) {
				scheduleIncrementalIndex(db, sessionId, latest.id, () => latest);
			}
			persistPiMessageEndModelMeta({
				db,
				sessionId,
				message: event.message,
				cacheTtlConfig: config.cache_ttl,
			});
			// Compute pressure with OpenCode-equivalent semantics: pull
			// the assistant's `usage` field and use
			// `input + cacheRead + cacheWrite` (NOT output) divided by
			// the effective context limit. Prefer
			// `session_meta.detected_context_limit` over Pi's
			// `getContextUsage().contextWindow` so that after a
			// provider context-overflow, the next pass's pressure
			// reflects the real, lower limit the provider reported.
			// See `pi-pressure.ts` for the full rationale.
			const piUsage = ctx.getContextUsage?.();
			const piContextWindow =
				piUsage && typeof piUsage.contextWindow === "number"
					? piUsage.contextWindow
					: 0;
			await persistPiPressureFromMessageEnd({
				db,
				sessionId,
				message: event.message,
				piContextWindow,
				piTokens:
					piUsage && typeof piUsage.tokens === "number"
						? piUsage.tokens
						: undefined,
				notifyIssue: async (message) => {
					const uiNotify = (
						ctx as { ui?: { notify?: (message: string) => unknown } }
					).ui?.notify;
					if (typeof uiNotify === "function") {
						void uiNotify.call(ctx.ui, message);
					} else {
						warn(message);
					}
				},
			});

			// Synthetic-todowrite capture (Pi parity with OpenCode
			// hook-handlers.ts `tool.execute.after` for `todowrite`).
			//
			// Why message_end and not tool_execution_start:
			//   Pi's `tool_execution_start` only fires for tools Pi has
			//   actually executed (i.e. tools the agent registered).
			//   The mocked todowrite in tests — and any user-driven
			//   custom todowrite-shaped tool that isn't in Pi's registry
			//   — would not trigger `tool_execution_start`. Reading the
			//   assistant message at `message_end` catches every
			//   todowrite-shaped `toolCall` block regardless of whether
			//   Pi could execute it locally, matching what OpenCode
			//   captures via `tool.execute.after` on every visible tool
			//   call.
			//
			// Cache safety: pure DB write, no message mutation.
			// Subagents skip — they don't get synthetic todowrite
			// injection downstream (mirrors OpenCode `fullFeatureMode`
			// gate).
			try {
				const sessionMetaForTodo = getOrCreateSessionMeta(db, sessionId);
				if (!sessionMetaForTodo.isSubagent) {
					const msg = event.message as
						| { role?: string; content?: unknown }
						| undefined;
					if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
						for (const block of msg.content) {
							if (!block || typeof block !== "object") continue;
							const b = block as {
								type?: unknown;
								name?: unknown;
								arguments?: unknown;
							};
							if (b.type !== "toolCall") continue;
							if (typeof b.name !== "string") continue;
							if (!/^todo.*write$|^write.*todo$|^todowrite$/i.test(b.name)) {
								continue;
							}
							const args = b.arguments as
								| { todos?: unknown }
								| null
								| undefined;
							const todos = args?.todos;
							if (!Array.isArray(todos)) continue;
							const normalized = normalizeTodoStateJson(todos);
							if (normalized === null) continue;
							updateSessionMeta(db, sessionId, {
								lastTodoState: normalized,
							});
							// First valid todowrite block wins — mirrors OpenCode's
							// `tool.execute.after` behavior of capturing one
							// snapshot per tool invocation.
							break;
						}
					}
				}
			} catch (err) {
				warn("message_end: synthetic todowrite capture failed:", err);
			}
		} catch (err) {
			warn("message_end: persist session_meta usage failed:", err);
		}

		// Overflow recovery: if Pi's assistant message ended with a
		// provider context-overflow error (`message.errorMessage` matches
		// a known overflow pattern), record the recovery flag in
		// session_meta so the next transform pass treats this session as
		// "needs emergency recovery" — historian fires immediately, drop-
		// all-tools applies, and pressure math uses the real
		// detected_context_limit if the error reported one.
		//
		// Pi populates `errorMessage` on the assistant message when the
		// underlying API call fails (we saw exactly this pattern in the
		// Codex `context_length_exceeded` failure that motivated this
		// work). The provider-agnostic `detectOverflow` helper from
		// shared core matches Anthropic, OpenAI, Codex/OpenAI, xAI,
		// Cerebras, GitHub Copilot, OpenRouter, Ollama, vLLM, Mistral,
		// MiniMax, Kimi, Gemini, and a generic fallback.
		try {
			const sm = ctx.sessionManager as
				| { getSessionId?: () => string | undefined }
				| undefined;
			const sessionId = sm?.getSessionId?.();
			if (typeof sessionId !== "string" || sessionId.length === 0) return;
			const msgRaw = event.message as unknown;
			if (!msgRaw || typeof msgRaw !== "object") return;
			const msg = msgRaw as { role?: string; errorMessage?: string };
			if (msg.role !== "assistant") return;
			if (
				typeof msg.errorMessage !== "string" ||
				msg.errorMessage.length === 0
			) {
				return;
			}
			const detection = detectOverflow(msg.errorMessage);
			if (!detection.isOverflow) return;
			recordOverflowDetected(db, sessionId, detection.reportedLimit);
			log(
				`[magic-context][${sessionId}] overflow detected: reportedLimit=${
					detection.reportedLimit ?? "?"
				} pattern=${detection.matchedPattern ?? "?"}`,
			);
		} catch (err) {
			warn("message_end: overflow detection failed:", err);
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
	pi.on("session_shutdown", async (_event, ctx) => {
		// Bounded drain of in-flight historian / dreamer runs that were
		// kicked off by recent turns. We moved the drain here from
		// `agent_end` because Pi awaits agent_end handlers and was
		// stalling the UI loader on every turn that triggered historian.
		// session_shutdown only fires when the user is actually leaving
		// the session, so a brief wait is acceptable — and lets the
		// JSONL session state reach a consistent compartment boundary
		// before the process exits.
		//
		// 5-second cap protects interactive shutdown from a hung
		// subagent. In `pi --print` mode the process exits after
		// agent_end before this handler fires anyway, so the cap
		// doesn't help that mode (and we don't pretend it does — see
		// the comment block on the agent_end handler above).
		const SHUTDOWN_DRAIN_MS = 5_000;
		try {
			await Promise.race([
				awaitInFlightHistorians(),
				new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS)),
			]);
		} catch (err) {
			warn("shutdown: historian drain threw:", err);
		}
		try {
			await Promise.race([
				awaitInFlightDreamers(),
				new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS)),
			]);
		} catch (err) {
			warn("shutdown: dreamer drain threw:", err);
		}
		try {
			unregisterPiDreamerProject({ projectIdentity });
		} catch (err) {
			warn("shutdown: unregisterPiDreamerProject threw:", err);
		}
		// Clear per-session system-prompt adjunct caches (sticky date,
		// project docs, user profile, key files). Pi's
		// `_extensionRunner.invalidate` resets module state on session
		// swap, but on plain shutdown the maps would otherwise hold
		// their last entries. Best-effort: if sessionId can't be
		// resolved we just skip — Pi resets module state on /reload
		// anyway.
		try {
			const sm = (
				ctx as unknown as {
					sessionManager?: { getSessionId?: () => string | undefined };
				}
			).sessionManager;
			const sessionId =
				typeof sm?.getSessionId === "function" ? sm.getSessionId() : undefined;
			if (typeof sessionId === "string" && sessionId.length > 0) {
				clearPiSystemPromptSession(sessionId);
				// Drain context-handler session-keyed maps too. Without
				// this, sessions accumulate state across `session_shutdown`
				// in long-lived Pi processes that re-init the extension.
				clearContextHandlerSession(sessionId);
			}
		} catch {
			// best-effort cleanup
		}
	});

	// Pi has no `session_deleted` event, but `session_before_switch`
	// fires when the user switches to a different session within the
	// same Pi process. That's the right moment to drain caches keyed
	// by the OUTGOING session id — without this, every session swap
	// in a long-running Pi process leaks one entry per cache, and
	// after dozens of swaps the maps balloon. Cleanup here mirrors
	// OpenCode's `session.deleted` handler in `event-handler.ts`.
	pi.on("session_before_switch", (_event, ctx) => {
		try {
			const sm = (
				ctx as unknown as {
					sessionManager?: { getSessionId?: () => string | undefined };
				}
			).sessionManager;
			const outgoingSessionId =
				typeof sm?.getSessionId === "function" ? sm.getSessionId() : undefined;
			if (
				typeof outgoingSessionId === "string" &&
				outgoingSessionId.length > 0
			) {
				clearPiSystemPromptSession(outgoingSessionId);
				clearContextHandlerSession(outgoingSessionId);
			}
		} catch {
			// best-effort — Pi proceeds with the switch regardless
		}
	});
}
