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
 * Config: read from the shared CortexKit location —
 *   $cwd/.cortexkit/magic-context.jsonc (project) and
 *   ~/.config/cortexkit/magic-context.jsonc (user) via `loadPiConfig()`.
 *   Falls back to schema defaults when neither file exists.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	isCompactionEnabled,
	isDreamerRunnable,
} from "@magic-context/core/config/agent-disable";
import { migrateMagicContextConfigLocations } from "@magic-context/core/config/migrate-config-location";
import type {
	DreamerConfig,
	HistorianConfig,
	MagicContextConfig,
	SidekickConfig,
} from "@magic-context/core/config/schema/magic-context";
import {
	summarizeDreamSchedule,
	userMemoryCollectionEnabled,
} from "@magic-context/core/features/magic-context/dreamer/task-config";
import {
	type FailClosedReason,
	formatFailClosedBlockingMessage,
} from "@magic-context/core/features/magic-context/fail-closed-block";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { scheduleIncrementalIndex } from "@magic-context/core/features/magic-context/message-index-async";
import { detectOverflow } from "@magic-context/core/features/magic-context/overflow-detection";
import { runSessionProjectBackfill } from "@magic-context/core/features/magic-context/session-project-backfill";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	getOrCreateSessionMeta,
	getPendingPiCompactionMarkerState,
	getSessionsWithPendingPiMarker,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
	applySqliteTuningPragmas,
	getMigrationOnOpenRefusal,
	getSchemaFenceRejection,
	openDatabaseAsync,
	setSqlitePragmaConfig,
} from "@magic-context/core/features/magic-context/storage-db";
import { getOverflowState } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { runDeferredV22Backfill } from "@magic-context/core/features/magic-context/v22-deferred-backfill";
import { setCtxReduceRegisteredGlobally } from "@magic-context/core/hooks/magic-context/ctx-reduce-availability";
import {
	deriveHistorianChunkTokens,
	resolveHistorianContextLimit,
	resolveKnownHistorianContextLimit,
} from "@magic-context/core/hooks/magic-context/derive-budgets";
import { resolveCacheTtl } from "@magic-context/core/hooks/magic-context/event-resolvers";
import {
	clearNoteNudgeTriggerAndCooldown,
	onNoteTrigger,
} from "@magic-context/core/hooks/magic-context/note-nudger";
import { preloadTokenizer } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { normalizeTodoStateJson } from "@magic-context/core/hooks/magic-context/todo-view";
import { maybeSendUpgradeReminder } from "@magic-context/core/hooks/magic-context/upgrade-reminder";
import {
	beginBootQuietPeriod,
	scheduleAfterBootQuiet,
} from "@magic-context/core/plugin/boot-quiet";
import {
	ANNOUNCEMENT_FEATURES,
	ANNOUNCEMENT_FOOTER,
	ANNOUNCEMENT_VERSION,
	markAnnouncementSeen,
	shouldShowAnnouncement,
} from "@magic-context/core/shared/announcement";
import { seedSessionCacheTtlIfUnsynced } from "@magic-context/core/shared/cache-ttl-seed";
import {
	claimConfigParseFailuresOnce,
	formatConfigParseNotice,
} from "@magic-context/core/shared/config-diagnostics";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { piModelRefToCanonical } from "@magic-context/core/shared/harness-provider-map";
import { setKeepSubagents } from "@magic-context/core/shared/keep-subagents";
import { flushLogger, log } from "@magic-context/core/shared/logger";
import { resolveHistorianModel } from "@magic-context/core/shared/model-resolution";
import {
	createPromptSurfaceGuidanceEpochCache,
	createPromptSurfaceRuntime,
} from "@magic-context/core/shared/prompt-surface-runtime";
import { resolveFallbackChain } from "@magic-context/core/shared/resolve-fallbacks";
import { setStoragePrivatePermissionEnforcement } from "@magic-context/core/shared/storage-permissions";
import { reloadWindowOverlay } from "@magic-context/core/shared/window-geometry";

import { handlePiCloneSessionStart } from "./clone-inheritance";
import {
	type PiSidekickConfig,
	registerCtxAugCommand,
} from "./commands/ctx-aug";
import { registerCtxDreamCommand } from "./commands/ctx-dream";
import {
	maybeAutoEmbedPiSession,
	registerCtxEmbedCommand,
} from "./commands/ctx-embed";
import { registerCtxFlushCommand } from "./commands/ctx-flush";
import { registerCtxRecompCommand } from "./commands/ctx-recomp";
import { registerCtxSessionUpgradeCommand } from "./commands/ctx-session-upgrade";
import { registerCtxStatusCommand } from "./commands/ctx-status";
import { registerCtxWrapupCommand } from "./commands/ctx-wrapup";
import {
	registerCtxStatusEntryRenderer,
	registerCtxStatusLifecycleSignal,
	resolveSessionId,
	sendCtxStatusMessage,
} from "./commands/pi-command-utils";
import { loadPiConfig } from "./config";
import {
	awaitInFlightHistorians,
	clearContextHandlerSession,
	clearPiM0Cache,
	clearSystemPromptRefresh,
	hasSystemPromptRefresh,
	type PiAutoSearchHandlerOptions,
	type PiContextHandlerOptions,
	type PiHistorianOptions,
	recordPiLiveModel,
	registerPiContextHandler,
	signalPiDeferredHistoryRefresh,
	signalPiDeferredMaterialization,
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
	signalPiSystemPromptRefresh,
	signalPiSystemPromptRefreshForProject,
	trackSessionForProject,
} from "./context-handler";
import {
	markPiChannel1Reduced,
	maybeChannel1ReminderForToolResult,
	maybeDeliverChannel2Pi,
} from "./ctx-reduce-nudge-pi";
import {
	awaitInFlightDreamers,
	registerPiDreamerProject,
	unregisterPiDreamerProject,
} from "./dreamer";
import { loadDefaultPiSessionApi } from "./dreamer/pi-session-api";
import { ensureProjectRegisteredFromPiDirectory } from "./embedding-bootstrap";
import { registerPiFailClosedSurface } from "./fail-closed-pi";
import { bootPiRuntimeWithDeadline } from "./pi-boot-deadline";
import { resolvePiUsableContextLimit } from "./pi-context-limit";
import {
	type PiHarnessKind,
	resolvePiHarnessDetection,
} from "./pi-harness-kind";
import { computePiPressure, extractAssistantUsage } from "./pi-pressure";
import { abortInFlightRecomps, awaitInFlightRecomps } from "./pi-recomp-runner";
import { handlePiProviderFailure } from "./provider-error-recovery-pi";
import { readPiSessionMessages } from "./read-session-pi";
import { registerStatusLine, updateStatusLine } from "./status-line";
import { stripTagPrefixFromAssistantMessage } from "./strip-tag-prefix";
import {
	configurePiSubagentExtensions,
	MAGIC_CONTEXT_PI_SUBAGENT_ENV,
	PiSubagentRunner,
} from "./subagent-runner";
import {
	buildMagicContextBlock,
	clearPiSystemPromptSession,
	composeMagicContextSystemPrompt,
	processSystemPromptForCache,
} from "./system-prompt";
import { withTimeout } from "./timeout";
import { registerMagicContextTools, syncCtxMemoryToolEnabled } from "./tools";
import {
	parseTodos,
	registerTodoOverlay,
	registerTodoStateLifecycle,
	rememberTodowriteToolCallTodos,
	setTodoSnapshot,
} from "./tools/todo-view-pi";

const PI_HARNESS_DETECTION = await resolvePiHarnessDetection();
const PI_HARNESS_KIND = PI_HARNESS_DETECTION.kind;
const PREFIX = `[magic-context][${PI_HARNESS_KIND}]`;
const PI_BOOT_DEADLINE_MS = 15_000;

// ---------------------------------------------------------------------------
// In-process child guard (issue #247)
//
// `@gotgenes/pi-subagents` runs child agent sessions IN-PROCESS inside the
// parent Pi process. Each child inherits the parent's user packages, so Pi
// re-imports and re-runs this extension factory for every child session. The
// existing recursion guard (`MAGIC_CONTEXT_PI_SUBAGENT=1`) only covers
// SPAWNED subprocess children because in-process children share the parent's
// env without that variable. Without a process-wide signal, every in-process
// child re-ran the full Magic Context init — opening the DB, wiring timers /
// watchers / event handlers, and scheduling background session scans. Four
// parallel children fanned out concurrent `SessionManager.listAll` scans over
// ~392 JSONL sessions and crashed the parent with heap OOM.
//
// The marker below is a `Symbol.for` key on `globalThis` so it survives the
// duplicate module instances Pi's jiti loader creates per session
// (`moduleCache: false` resets module-level state on every re-import, but a
// Symbol.for key is process-global). The `session-created` lifecycle event sets
// it only in the child's async context; that child factory sees it and no-ops
// with the SAME contract as a spawned subagent child — no watchers, no timers,
// no background scans. The parent's already-registered extension instance keeps
// serving its session, while independent same-process sessions initialize normally.
//
// Dispose / re-arm: `subagents:child:disposed` clears the child's marker after
// its run. Since the marker is scoped with AsyncLocalStorage, a child cannot
// suppress unrelated sessions hosted by pi-web.
// ---------------------------------------------------------------------------
const PI_CHILD_INIT_CONTEXT = Symbol.for("magic-context.pi.child-init-context");
const SUBAGENT_CHILD_SESSION_CREATED = "subagents:child:session-created";
const SUBAGENT_CHILD_DISPOSED = "subagents:child:disposed";
const PI_STARTUP_MAINTENANCE_SCHEDULED = Symbol.for(
	"magic-context.pi.startup-maintenance-scheduled",
);

function getPiChildInitContext(): AsyncLocalStorage<boolean> {
	const globals = globalThis as Record<symbol, unknown>;
	const existing = globals[PI_CHILD_INIT_CONTEXT];
	if (existing instanceof AsyncLocalStorage) return existing;
	const context = new AsyncLocalStorage<boolean>();
	globals[PI_CHILD_INIT_CONTEXT] = context;
	return context;
}

function isPiInProcessSubagentInit(): boolean {
	return getPiChildInitContext().getStore() === true;
}

function clearPiInProcessSubagentInitContext(): void {
	getPiChildInitContext().enterWith(false);
}

function registerPiSubagentInitContext(pi: ExtensionAPI): () => void {
	const context = getPiChildInitContext();
	// session-created fires after child creation has its own async branch but before
	// bindExtensions(); marking on spawning would leak into the parent's call chain.
	const unsubscribeCreated = pi.events.on(SUBAGENT_CHILD_SESSION_CREATED, () =>
		context.enterWith(true),
	);
	const unsubscribeDisposed = pi.events.on(SUBAGENT_CHILD_DISPOSED, () =>
		context.enterWith(false),
	);
	return () => {
		unsubscribeCreated();
		unsubscribeDisposed();
	};
}

function claimPiStartupMaintenance(): boolean {
	const globals = globalThis as Record<symbol, unknown>;
	if (globals[PI_STARTUP_MAINTENANCE_SCHEDULED] === true) return false;
	globals[PI_STARTUP_MAINTENANCE_SCHEDULED] = true;
	return true;
}

function clearPiStartupMaintenanceClaim(): void {
	delete (globalThis as Record<symbol, unknown>)[
		PI_STARTUP_MAINTENANCE_SCHEDULED
	];
}

function resolveCurrentProject(
	ctx: { cwd: string },
	allowHomeProject = false,
): {
	projectDir: string;
	projectIdentity: string;
} {
	const projectDir = ctx.cwd;
	const projectIdentity =
		resolveProjectIdentityForSession(projectDir, allowHomeProject) ?? "";
	return { projectDir, projectIdentity };
}

export function signalPiDeferredCompactionMarkerDrain(sessionId: string): void {
	signalPiDeferredHistoryRefresh(sessionId);
	signalPiDeferredMaterialization(sessionId);
}

/**
 * Pi native compaction invalidates MC's cached m[0]/m[1] bytes. In normal mode
 * MC still owns compaction and cancels this event; compaction-off mode clears
 * only that cache and deliberately returns no cancellation result.
 */
export async function handlePiSessionBeforeCompact(args: {
	db: ContextDatabase;
	compactionOff: boolean;
	ctx: { sessionManager?: { getSessionId?: () => string | undefined } };
}): Promise<{ cancel: true } | undefined> {
	try {
		const sessionId = args.ctx.sessionManager?.getSessionId?.();
		if (typeof sessionId === "string" && sessionId.length > 0) {
			clearPiM0Cache(args.db, sessionId, "session_before_compact");
		}
	} catch {
		// Cache invalidation is best-effort; it must not suppress Pi's native path.
	}
	if (args.compactionOff) {
		info(
			"session_before_compact: native Pi compaction proceeds (compaction-off mode)",
		);
		return;
	}
	info("session_before_compact: cancelling — magic-context owns compaction");
	return { cancel: true };
}

export function canonicalPiModelKey(provider: string, model: string): string {
	return piModelRefToCanonical(`${provider}/${model}`);
}

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
		timestamp?: number;
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
	const modelKey = canonicalPiModelKey(msg.provider, msg.model);
	if (!recordPiLiveModel(args.sessionId, modelKey, msg.timestamp)) return;
	const cacheTtl = resolveCacheTtl(args.cacheTtlConfig, modelKey);
	const currentMeta = getOrCreateSessionMeta(args.db, args.sessionId);
	updateSessionMeta(args.db, args.sessionId, {
		...(currentMeta.cacheTtl === cacheTtl ? {} : { cacheTtl }),
		lastObservedModelKey: modelKey,
	});
}

type TodoOverlayUpdater = { update: (sessionId?: string) => void };

type CompatiblePiTodoCapture = {
	normalized: string;
	todos: Exclude<ReturnType<typeof parseTodos>, null>;
};

function getCompatiblePiTodoCapture(
	todos: unknown,
): CompatiblePiTodoCapture | null {
	if (!Array.isArray(todos)) return null;
	const normalized = normalizeTodoStateJson(todos);
	if (normalized === null) return null;
	const parsed = parseTodos(todos);
	if (parsed === null) return null;
	return { normalized, todos: parsed };
}

function applyCompatiblePiTodoCapture(args: {
	db: ContextDatabase;
	sessionId: string;
	todowriteEnabled: boolean;
	todoOverlay?: TodoOverlayUpdater;
	persist: boolean;
	toolCallId?: string;
	capture: CompatiblePiTodoCapture;
}): void {
	rememberTodowriteToolCallTodos(args.toolCallId, args.capture.todos);
	if (args.todowriteEnabled) {
		setTodoSnapshot(args.sessionId, args.capture.todos);
		args.todoOverlay?.update(args.sessionId);
	}
	if (args.persist) {
		updateSessionMeta(args.db, args.sessionId, {
			lastTodoState: args.capture.normalized,
		});
	}
}

/**
 * Capture a `todowrite` args.todos payload only when it matches Magic Context's
 * exact todo enum contract. Third-party Pi extensions can reuse the same tool
 * name, so incompatible shapes must not update `last_todo_state` or the
 * transcript render cache.
 */
export function capturePiTodowriteArgsIfCompatible(args: {
	db: ContextDatabase;
	sessionId: string;
	todos: unknown;
	todowriteEnabled: boolean;
	todoOverlay?: TodoOverlayUpdater;
	persist: boolean;
	toolCallId?: string;
}): boolean {
	const capture = getCompatiblePiTodoCapture(args.todos);
	if (capture === null) return false;
	applyCompatiblePiTodoCapture({ ...args, capture });
	return true;
}

/**
 * Scan an assistant `message_end` payload for the first compatible `todowrite`
 * call. This keeps interop with third-party tools that share the name but only
 * captures state when their payload matches Magic Context's todo enums exactly.
 */
export function capturePiTodowriteMessageIfCompatible(args: {
	db: ContextDatabase;
	sessionId: string;
	message: unknown;
	todowriteEnabled: boolean;
	todoOverlay?: TodoOverlayUpdater;
	persist: boolean;
}): boolean {
	const msg = args.message as { role?: unknown; content?: unknown } | undefined;
	if (msg?.role !== "assistant" || !Array.isArray(msg.content)) {
		return false;
	}

	for (const block of msg.content) {
		if (!block || typeof block !== "object") continue;
		const b = block as {
			type?: unknown;
			name?: unknown;
			arguments?: unknown;
		};
		if (b.type !== "toolCall") continue;
		if (typeof b.name !== "string") continue;
		if (b.name !== "todowrite") continue;
		const capture = getCompatiblePiTodoCapture(
			(b.arguments as { todos?: unknown } | null | undefined)?.todos,
		);
		if (capture === null) continue;
		applyCompatiblePiTodoCapture({ ...args, capture });
		return true;
	}

	return false;
}

function info(message: string, data?: unknown): void {
	log(`${PREFIX} ${message}`, data);
}

function warn(message: string, data?: unknown): void {
	log(`${PREFIX} WARN ${message}`, data);
}

// Migrate config from the legacy per-harness locations to the shared CortexKit
// location BEFORE any loadPiConfig. The loader prefers the shared CortexKit
// paths and only falls back to Pi-owned legacy files when that base is absent.
// Memoized per directory so the per-cwd switch sites don't re-run the
// (idempotent, lock-guarded) migration on every pass. Fails open.
const migratedConfigDirs = new Set<string>();
// Memoized per directory so repeated /cd lookups do not spam the same config
// summary/warning lines on every hot-path config resolution.
const loggedPiConfigDirs = new Set<string>();
function ensureConfigLocationsMigrated(dir: string): void {
	if (migratedConfigDirs.has(dir)) return;
	migratedConfigDirs.add(dir);
	migrateMagicContextConfigLocations(dir, {
		warn: (m) => warn(m),
		info: (m) => info(m),
	});
}

function logPiConfigLoad(args: {
	dir: string;
	loadedFromPaths: string[];
	warnings: string[];
	dedupe?: boolean;
}): void {
	const key = resolve(args.dir);
	if (args.dedupe && loggedPiConfigDirs.has(key)) return;
	if (args.dedupe) {
		loggedPiConfigDirs.add(key);
	}
	if (args.loadedFromPaths.length > 0) {
		info(`config loaded from: ${args.loadedFromPaths.join(", ")}`);
	} else {
		info("config: no magic-context.jsonc found, using schema defaults");
	}
	for (const warning of args.warnings) {
		warn(`config: ${warning}`);
	}
}

export function formatProtectedTagsDeprecationNotice(): string {
	return '⚠️ Magic Context: The "protected_tags" setting is deprecated and ignored. Use "protected_tokens" instead.';
}

let protectedTagsDeprecationClaimed = false;

export function claimProtectedTagsDeprecationNoticeOnce(): boolean {
	if (protectedTagsDeprecationClaimed) return false;
	protectedTagsDeprecationClaimed = true;
	return true;
}

export function resetClaimedProtectedTagsDeprecationNoticeForTesting(): void {
	protectedTagsDeprecationClaimed = false;
}

export const __test = {
	logPiConfigLoad,
	resetLoggedPiConfigDirs(): void {
		loggedPiConfigDirs.clear();
	},
	clearPiInProcessSubagentInitContext,
	claimPiStartupMaintenance,
	clearPiStartupMaintenanceClaim,
	formatProtectedTagsDeprecationNotice,
	claimProtectedTagsDeprecationNoticeOnce,
	resetClaimedProtectedTagsDeprecationNoticeForTesting,
};

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
	piContextWindow: number;
	model?: { provider?: string; id?: string; maxTokens?: number };
}): number {
	// Pi reports the model's context window directly (ctx.getContextUsage() /
	// ctx.model.contextWindow) — its own authoritative source. We no longer
	// consult models.dev for Pi. Sanity-bound the reported value so a transient
	// garbage window can't poison pressure (mirrors OpenCode's SDK sane bound).
	let detectedContextLimit: number | undefined;
	try {
		const overflowState = getOverflowState(args.db, args.sessionId);
		if (overflowState.detectedContextLimit > 0) {
			detectedContextLimit = overflowState.detectedContextLimit;
		}
	} catch (err) {
		warn("message_end: getOverflowState failed:", err);
	}
	return (
		resolvePiUsableContextLimit({
			rawContextWindow: args.piContextWindow,
			model: args.model,
			detectedContextLimit,
		}) ?? 0
	);
}

export async function persistPiPressureFromMessageEnd(args: {
	db: ContextDatabase;
	sessionId: string;
	message: unknown;
	piContextWindow: number;
	piModel?: { provider?: string; id?: string; maxTokens?: number };
	piTokens?: number;
	notifyIssue?: (message: string) => unknown | Promise<unknown>;
}): Promise<void> {
	const { provider, model } = getPiMessageModel(args.message);
	const effectiveContextLimit = resolvePiPressureContextLimit({
		db: args.db,
		sessionId: args.sessionId,
		piContextWindow: args.piContextWindow,
		model: args.piModel ?? { provider, id: model },
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
		const percentage = pressure.percentage;
		const contextLimit = effectiveContextLimit;
		const meta = getOrCreateSessionMeta(args.db, args.sessionId);
		const observedSafeInputTokens = meta.observedSafeInputTokens ?? 0;
		if (
			percentage > 100 &&
			observedSafeInputTokens > 0 &&
			pressure.inputTokens <= observedSafeInputTokens * 2
		) {
			// Pi resolves the window from its own runtime, not a cache we could
			// reload — so a >100% reading with a known-good safe baseline means
			// Pi's reported contextWindow is genuinely wrong. There's nothing to
			// re-fetch; surface the alert (overflow detection still captures a
			// real lower cap separately).
			if (!meta.cacheAlertSent) {
				updates.cacheAlertSent = true;
				const safeTokens = Math.max(
					observedSafeInputTokens,
					pressure.inputTokens,
				);
				const modelLabel =
					provider && model ? `${provider}/${model}` : "the active model";
				await args.notifyIssue?.(
					`⚠️ Magic Context: Pi reports a context limit of ${formatTokens(contextLimit)} tokens for ${modelLabel} but you've successfully sent ${formatTokens(safeTokens)} tokens in this session — the reported limit looks wrong. Restart Pi if you suspect this is incorrect.`,
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
		if (effectiveContextLimit > 0) {
			updates.lastContextPercentage =
				(args.piTokens / effectiveContextLimit) * 100;
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
setHarness(PI_HARNESS_KIND);

// ---------------------------------------------------------------------------
// Config-driven resolvers
//
// Step 5b replaced the env-var stop-gaps with `loadPiConfig()`, which reads
// the shared CortexKit config paths (project `.cortexkit/`, user `~/.config/`)
// and falls back to Pi-owned legacy files only until migration completes. The
// resolvers below
// adapt the schema-shaped config into the Pi-specific options the various
// registration helpers expect.
//
// Each resolver returns `undefined` when the relevant feature is disabled
// in config, so the registration helpers can short-circuit cleanly.
// ---------------------------------------------------------------------------

export function resolveSidekickFromConfig(
	config: MagicContextConfig,
): PiSidekickConfig | undefined {
	const sidekick = config.sidekick as SidekickConfig | undefined;
	if (!sidekick || sidekick.disable === true) return undefined;
	const model = sidekick.model?.trim();
	if (!model || model.length === 0) return undefined;
	return {
		model,
		systemPrompt: sidekick.system_prompt,
		timeoutMs: sidekick.timeout_ms,
		thinking_level: sidekick.thinking_level,
		fallbackModels: resolveFallbackChain(sidekick.fallback_models),
		language: config.language,
		allowHomeProject: config.allow_home_project,
	};
}

export function resolveHistorianFromConfig(
	config: MagicContextConfig,
	harness: PiHarnessKind = PI_HARNESS_KIND,
): PiHistorianOptions | undefined {
	// Defensive: schema declares `historian` required with default {}, but the
	// runtime config can come from a malformed JSONC merge that drops the
	// field. Fall back to undefined-safe access so plugin load never crashes.
	const historian = config.historian as HistorianConfig | undefined;
	if (historian?.disable === true) return undefined;
	const resolved = resolveHistorianModel(config, harness);
	const model = resolved.primary?.model;
	if (!model) return undefined;

	// The historian chunk budget is anchored to the HISTORIAN model because
	// it bounds one summarizer call. The trigger budget is intentionally NOT
	// derived at startup: Pi resolves it per context pass from the live main
	// session model + effective execute threshold to match OpenCode.
	const historianContextLimit = resolveHistorianContextLimit(model);
	const historianChunkTokens = deriveHistorianChunkTokens(
		historianContextLimit,
	);

	const fallbackModels = resolved.fallbacks;

	return {
		runner: new PiSubagentRunner(),
		model,
		fallbackModels,
		historianChunkTokens,
		historianContextLimit: resolveKnownHistorianContextLimit(model),
		timeoutMs: config.historian_timeout_ms,
		temperature: historian?.temperature,
		maxOutputTokens: historian?.maxTokens ?? 32_000,
		// `historian.two_pass` runs an editor pass after a successful
		// first pass to clean low-signal U: lines and cross-compartment
		// duplicates. Mirrors OpenCode's config flag — defaults to false
		// on the schema side because the editor pass adds a second
		// historian round-trip's latency and token cost. Enable for
		// long sessions where chunk dedupe matters more than speed.
		twoPass: historian?.two_pass === true,
		// Pi and OMP: explicit thinking level for historian subagent invocations.
		// When set, passed as --thinking <level> to Pi subprocess.
		// Required for providers like GitHub Copilot that apply bad defaults.
		thinkingLevel: resolved.primary?.qualifier,
		executeThresholdPercentage: config.execute_threshold_percentage,
		executeThresholdTokens: config.execute_threshold_tokens,
		commitClusterTrigger: config.commit_cluster_trigger,
		protectedTags: config.protected_tags,
		clearReasoningAge: config.clear_reasoning_age,
		historyBudgetPercentage: config.history_budget_percentage,
		memoryEnabled: config.memory.enabled,
		autoPromote: config.memory.auto_promote,
		userMemoriesEnabled: userMemoryCollectionEnabled(config.dreamer),
		language: config.language,
		allowHomeProject: config.allow_home_project,
	};
}

function resolveAutoSearchFromConfig(
	config: MagicContextConfig,
): PiAutoSearchHandlerOptions {
	const auto = config.memory.auto_search;
	const enabled = auto?.enabled ?? false;
	return {
		enabled,
		scoreThreshold: auto?.score_threshold ?? 0.55,
		minPromptChars: auto?.min_prompt_chars ?? 20,
	};
}

export function resolveDreamerFromConfig(
	config: MagicContextConfig,
): DreamerConfig | undefined {
	return config.dreamer?.disable === true ? undefined : config.dreamer;
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
	if (process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV] === "1") {
		log(
			`${PREFIX} subagent child detected (${MAGIC_CONTEXT_PI_SUBAGENT_ENV}=1); skipping full extension registration`,
		);
		return;
	}
	// In-process child guard (issue #247): `@gotgenes/pi-subagents` runs child
	// agent sessions in the SAME process as the parent. They share the parent's
	// env (so the spawned-child env guard above never fires) and re-trigger this
	// factory for every child session. The lifecycle marker scopes the no-op to
	// that child: no database, watchers, timers, or background scans. Independent
	// same-process sessions remain unmarked and initialize normally.
	if (isPiInProcessSubagentInit()) {
		log(
			`${PREFIX} in-process subagent child detected; skipping full extension registration`,
		);
		return;
	}
	const unregisterPiSubagentInitContext = registerPiSubagentInitContext(pi);
	registerPiSubagentInitContextCleanup(pi, unregisterPiSubagentInitContext);

	// Flush before any filesystem or SQLite work. A boot lock that outlives the
	// regular logger's batching interval must still leave a diagnostic breadcrumb.
	log(`${PREFIX} boot: entering pid=${process.pid} dir=${process.cwd()}`);
	flushLogger();
	beginBootQuietPeriod();

	// Resolve the user-tier storage policy before opening the shared database.
	// Project config cannot alter it, so every project in this process shares the
	// operator's chosen owner-private or externally managed permission policy.
	const bootProjectDir = process.cwd();
	ensureConfigLocationsMigrated(bootProjectDir);
	const bootConfig = loadPiConfig({ cwd: bootProjectDir });
	if (!bootConfig.config.enabled) {
		info("plugin DISABLED via config (enabled: false) — skipping registration");
		return;
	}
	reloadWindowOverlay(bootConfig.config.models?.window_overlay_path);
	setStoragePrivatePermissionEnforcement(
		bootConfig.config.storage.enforce_private_permissions,
	);
	setSqlitePragmaConfig({
		cacheSizeMb: bootConfig.config.sqlite.cache_size_mb,
		mmapSizeMb: bootConfig.config.sqlite.mmap_size_mb,
	});

	const storageDir = getMagicContextStorageDir();
	const dbPath = join(storageDir, "context.db");
	let openFailureCause: string | null = null;
	const openStorage = async (): Promise<ContextDatabase | null> => {
		try {
			return await openDatabaseAsync();
		} catch (error) {
			openFailureCause = error instanceof Error ? error.message : String(error);
			return null;
		}
	};
	const unavailableReason = (): FailClosedReason => {
		const migration = getMigrationOnOpenRefusal();
		const blockingProcesses =
			migration?.blockingProcesses ??
			migration?.serverPids.map((pid) => ({ kind: "process" as const, pid })) ??
			[];
		const fence = getSchemaFenceRejection();
		if (migration && blockingProcesses.length > 0) {
			return {
				kind: "migration_guard",
				persistedVersion: migration.persistedVersion,
				supportedVersion: migration.supportedVersion,
				blockingProcesses,
			};
		}
		if (fence) {
			return {
				kind: "schema_fence",
				persistedVersion: fence.persistedVersion,
				supportedVersion: fence.supportedVersion,
			};
		}
		return {
			kind: "storage_failure",
			cause: migration?.unreadableFile
				? `migration guard could not read RPC discovery file ${migration.unreadableFile}`
				: (openFailureCause ??
					`storage unavailable at ${dbPath} (cache schema newer than this binary, or open failed)`),
		};
	};

	const bootResult = await bootPiRuntimeWithDeadline<
		ContextDatabase,
		FailClosedReason
	>({
		deadlineMs: PI_BOOT_DEADLINE_MS,
		openStorage,
		startRuntime: (db) => startPiMagicContextRuntime(pi, db, dbPath),
		unavailableReason,
		deadlineReason: {
			kind: "storage_failure",
			cause: `Pi storage boot phase exceeded its ${PI_BOOT_DEADLINE_MS}ms deadline`,
		},
		registerFailClosed: (registration) => {
			if (
				bootConfig.config.fail_closed_blocking === false ||
				!isCompactionEnabled(bootConfig.config)
			) {
				warn(
					`Magic Context (${PI_HARNESS_KIND}) storage unavailable at ${dbPath}: ${formatFailClosedBlockingMessage(registration.reason)}. ` +
						"fail_closed_blocking=false — degrading silently (hooks not registered).",
				);
				return {
					adoptRecovered: async (recoveredDb) => {
						try {
							await registration.onRecovered(recoveredDb);
							info(
								"storage boot settled after its deadline; full Magic Context runtime installed",
							);
							return true;
						} catch (error) {
							warn(
								`late storage adoption failed: ${error instanceof Error ? error.message : String(error)}`,
							);
							return false;
						}
					},
				};
			}
			warn(
				`Magic Context (${PI_HARNESS_KIND}) storage unavailable at ${dbPath}: ${formatFailClosedBlockingMessage(registration.reason)}`,
			);
			return registerPiFailClosedSurface(pi, registration);
		},
		report: log,
	});

	// The timed-out phase owns a caught late-adoption promise. Returning here is
	// what releases the host extension loader; a healthy late open installs the
	// runtime through the registered recovery surface.
	if (bootResult.status !== "ready") return;
}

/**
 * Full Pi Magic Context registration after a successful storage open.
 * Extracted so a healed re-probe from the fail-closed surface can start the
 * runtime without requiring a process restart.
 */
async function startPiMagicContextRuntime(
	pi: ExtensionAPI,
	database: ContextDatabase,
	dbPath: string,
): Promise<void> {
	const db = database;

	// v22 deferred legacy-memory identity backfill. openDatabase() has already
	// run migrations; the runner is fire-and-forget and logs failures without
	// blocking Pi startup. Multiple independent AgentSessions share one process, so
	// only the first full runtime schedules process-wide startup maintenance.
	if (claimPiStartupMaintenance()) {
		scheduleAfterBootQuiet(() => {
			runDeferredV22Backfill(db).catch((err) => {
				warn(`[v22-backfill] background runner failed: ${err}`);
			});
		});

		scheduleAfterBootQuiet(() => {
			void (async () => {
				try {
					let sessions:
						| Array<{ sessionId: string; directory: string }>
						| undefined;
					await runSessionProjectBackfill(
						database,
						async (afterSessionId, limit) => {
							if (!sessions) {
								const api = await loadDefaultPiSessionApi();
								const sessionsById = new Map<
									string,
									{ sessionId: string; directory: string }
								>();
								for (const session of (await api.listSessions()) as Array<{
									id?: unknown;
									cwd?: unknown;
								}>) {
									const sessionId =
										typeof session?.id === "string" ? session.id : "";
									const directory =
										typeof session?.cwd === "string" ? session.cwd : "";
									if (
										sessionId &&
										(!sessionsById.has(sessionId) || directory)
									) {
										sessionsById.set(sessionId, { sessionId, directory });
									}
								}
								sessions = [...sessionsById.values()];
							}
							const offset =
								afterSessionId === null
									? 0
									: sessions.findIndex(
											(session) => session.sessionId === afterSessionId,
										) + 1;
							return sessions.slice(offset, offset + limit);
						},
					);
				} catch (err) {
					warn(`[session-projects] background runner failed: ${err}`);
				}
			})();
		}, 0);
	}

	// Capture boot project for initial config load and logging only. Runtime
	// identity/path resolution uses ctx.cwd per hook/command so session cwd
	// switches follow the active project. Session starts invalidate their cwd's
	// cached dependencies so changed project config is visible in the next session.
	const projectDir = process.cwd();
	const seenDreamerProjectIdentities = new Set<string>();
	const dreamerRegistrationOwner = {};
	const commandLifecycleController = new AbortController();
	registerCtxStatusLifecycleSignal(pi, commandLifecycleController.signal);
	let sessionShuttingDown = false;
	// Step 5b: load the user's full magic-context.jsonc config. The loader
	// reads the shared CortexKit project/user paths, validates them through the
	// shared Zod schema, falls back to Pi-owned legacy files only while migration
	// is incomplete, and uses defaults for invalid fields per-key. It returns
	// the merged config plus warnings.
	//
	// We surface warnings via the standard `warn()` channel so users see
	// them in the magic-context log. Loading never throws — bad config
	// gracefully degrades to defaults.
	ensureConfigLocationsMigrated(projectDir);
	const {
		config,
		warnings,
		loadedFromPaths,
		registrationPromptSurface,
		configParseFailures,
		cacheTtlConfigured,
		hasDeprecatedProtectedTags,
	} = loadPiConfig({
		cwd: projectDir,
	});
	const promptSurfaceRuntime = createPromptSurfaceRuntime({
		harness: PI_HARNESS_KIND,
		directory: projectDir,
		warn: (message) => warn(`config: ${message}`),
	});
	const promptSurfaceGuidanceEpochs =
		createPromptSurfaceGuidanceEpochCache(promptSurfaceRuntime);
	const projectIdentity =
		resolveProjectIdentityForSession(projectDir, config.allow_home_project) ??
		"";
	if (projectIdentity) seenDreamerProjectIdentities.add(projectIdentity);
	info(
		`loaded v${PLUGIN_VERSION} | harness=${PI_HARNESS_KIND} (via ${PI_HARNESS_DETECTION.via}) | db=${dbPath} | ` +
			`project=${projectIdentity} | dir=${projectDir}`,
	);
	// Pi tools are registered once per process, so this mode is intentionally
	// boot-resolved rather than following later /cd project config changes.
	const compactionOff = !isCompactionEnabled(config);
	setCtxReduceRegisteredGlobally(!compactionOff);
	if (!compactionOff) {
		try {
			const pendingPiMarkerSessions = getSessionsWithPendingPiMarker(db);
			for (const sid of pendingPiMarkerSessions) {
				signalPiDeferredCompactionMarkerDrain(sid);
			}
			if (pendingPiMarkerSessions.length > 0) {
				log(
					`${PREFIX} rehydrated ${pendingPiMarkerSessions.length} Pi deferred compaction marker session(s)`,
				);
			}
		} catch (err) {
			warn(
				`Magic Context (pi) failed to rehydrate deferred Pi compaction markers: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	// The allowlist is user-tier only, so configure all child runners once at
	// boot. Project config is stripped before this merged config is returned.
	configurePiSubagentExtensions(config.pi?.subagent_extensions);
	logPiConfigLoad({
		dir: projectDir,
		loadedFromPaths,
		warnings,
		dedupe: true,
	});

	// Reapply boot-resolved storage and SQLite settings in case config changed
	// between the initial open and runtime registration. cache_size / mmap_size
	// take effect live; future opens in this process pick them up via
	// setSqlitePragmaConfig.
	setStoragePrivatePermissionEnforcement(
		config.storage.enforce_private_permissions,
	);
	setSqlitePragmaConfig({
		cacheSizeMb: config.sqlite.cache_size_mb,
		mmapSizeMb: config.sqlite.mmap_size_mb,
	});
	applySqliteTuningPragmas(db);

	// Debug data-collection toggle: keep subagent child sessions instead of
	// deleting on success (parity with the OpenCode plugin).
	setKeepSubagents(config.keep_subagents === true);

	// Top-level disable: when `enabled: false` is set in config, register
	// nothing — same fail-closed posture the OpenCode plugin uses.
	if (!config.enabled) {
		info("plugin DISABLED via config (enabled: false) — skipping registration");
		return;
	}

	await ensureProjectRegisteredFromPiDirectory(projectDir, db);
	info(
		`registered embedding config for project ${projectIdentity ?? "(no project identity; cwd is $HOME)"}`,
	);

	type ResolvedPiProjectDeps = {
		projectDir: string;
		projectIdentity: string;
		config: MagicContextConfig;
		historianConfig: PiHistorianOptions | undefined;
		autoSearchConfig: PiAutoSearchHandlerOptions;
		contextOptions: PiContextHandlerOptions;
		sidekickConfig: PiSidekickConfig | undefined;
		dreamerConfig: DreamerConfig | undefined;
		dreamerEnabled: boolean;
		configParseFailures: typeof configParseFailures;
		cacheTtlConfigured: boolean;
		hasDeprecatedProtectedTags: boolean;
	};

	// Per-cwd runtime deps. Pi can switch projects mid-process (`/cd`,
	// multi-root), while tools and slash commands are registered only once.
	// Resolve all project-sensitive config through this memoized accessor so
	// every invocation reads the active cwd's config instead of the launch cwd's.
	const projectDepsByDir = new Map<string, ResolvedPiProjectDeps>();

	const buildContextOptions = (
		cfg: MagicContextConfig,
		hist: PiHistorianOptions | undefined,
		auto: PiAutoSearchHandlerOptions,
	): PiContextHandlerOptions => ({
		db: database,
		smartDrops: cfg.smart_drops === true,
		protectedTags: cfg.protected_tags ?? 20,
		heuristics: {
			caveman: cfg.caveman_text_compression
				? {
						enabled: cfg.caveman_text_compression.enabled,
						minChars: cfg.caveman_text_compression.min_chars,
					}
				: undefined,
			clearReasoningAge: cfg.clear_reasoning_age,
		},
		injection: {
			memoryEnabled: cfg.memory.enabled,
			injectDocs: cfg.dreamer?.inject_docs !== false,
			injectionBudgetTokens: cfg.memory.injection_budget_tokens,
			temporalAwareness: cfg.temporal_awareness === true,
			muralEnabled: cfg.mural.enabled === true,
		},
		scheduler: {
			executeThresholdPercentage: cfg.execute_threshold_percentage,
			executeThresholdTokens: cfg.execute_threshold_tokens,
		},
		historian: hist,
		language: cfg.language,
		autoSearch: auto,
		resolveForProject: resolveContextOptionsForProject,
		compactionOff,
		allowHomeProject: cfg.allow_home_project,
		maybeAutoEmbedSession: (sessionId, dir, identity) => {
			maybeAutoEmbedPiSession(
				{
					db: database,
					projectDir: dir,
					projectIdentity: identity,
					memoryEnabled: cfg.memory.enabled,
				},
				sessionId,
				dir,
				identity,
				(text) => {
					sendCtxStatusMessage(pi, {
						title: "/ctx-embed",
						text,
						level: "info",
					});
				},
			);
		},
	});

	function buildProjectDeps(
		dir: string,
		identity: string,
		cfg: MagicContextConfig,
		loadMetadata: {
			configParseFailures: typeof configParseFailures;
			cacheTtlConfigured: boolean;
			hasDeprecatedProtectedTags?: boolean;
		},
	): ResolvedPiProjectDeps {
		const hist = resolveHistorianFromConfig(cfg);
		if (hist) {
			hist.onStatusChange = (ctx) => {
				updateStatusLine(ctx, {
					db: database,
					projectIdentity:
						resolveCurrentProject(ctx, cfg.allow_home_project)
							.projectIdentity ?? "",
				});
			};
		}
		const auto = resolveAutoSearchFromConfig(cfg);
		return {
			projectDir: dir,
			projectIdentity: identity,
			config: cfg,
			historianConfig: hist,
			autoSearchConfig: auto,
			contextOptions: buildContextOptions(cfg, hist, auto),
			sidekickConfig: resolveSidekickFromConfig(cfg),
			dreamerConfig: resolveDreamerFromConfig(cfg),
			dreamerEnabled: isDreamerRunnable(cfg),
			configParseFailures: loadMetadata.configParseFailures,
			cacheTtlConfigured: loadMetadata.cacheTtlConfigured,
			hasDeprecatedProtectedTags:
				loadMetadata.hasDeprecatedProtectedTags ?? false,
		};
	}

	function resolveProjectDepsForDir(
		dir: string,
		identityOverride?: string,
	): ResolvedPiProjectDeps {
		const cached = projectDepsByDir.get(dir);
		if (cached) return cached;
		ensureConfigLocationsMigrated(dir);
		const switchedLoad = loadPiConfig({ cwd: dir });
		logPiConfigLoad({
			dir,
			loadedFromPaths: switchedLoad.loadedFromPaths,
			warnings: switchedLoad.warnings,
			dedupe: true,
		});
		const switchedConfig = switchedLoad.config;
		const switchedIdentity =
			identityOverride ??
			resolveProjectIdentityForSession(
				dir,
				switchedConfig.allow_home_project,
			) ??
			"";
		const built = buildProjectDeps(dir, switchedIdentity, switchedConfig, {
			configParseFailures: switchedLoad.configParseFailures,
			cacheTtlConfigured: switchedLoad.cacheTtlConfigured,
			hasDeprecatedProtectedTags: switchedLoad.hasDeprecatedProtectedTags,
		});
		projectDepsByDir.set(dir, built);
		return built;
	}

	function resolveCurrentProjectDeps(ctx: {
		cwd: string;
	}): ResolvedPiProjectDeps {
		return resolveProjectDepsForDir(ctx.cwd);
	}

	function resolveContextOptionsForProject(
		dir: string,
	): PiContextHandlerOptions {
		return resolveProjectDepsForDir(dir).contextOptions;
	}

	const bootProjectDeps = buildProjectDeps(
		projectDir,
		projectIdentity,
		config,
		{
			configParseFailures,
			cacheTtlConfigured,
			hasDeprecatedProtectedTags,
		},
	);
	projectDepsByDir.set(projectDir, bootProjectDeps);

	function syncDreamerProjectRegistration(
		current: ResolvedPiProjectDeps,
	): void {
		if (sessionShuttingDown) return;
		seenDreamerProjectIdentities.add(current.projectIdentity);
		if (!current.dreamerConfig) {
			unregisterPiDreamerProject({
				projectIdentity: current.projectIdentity,
				registrationOwner: dreamerRegistrationOwner,
			});
			return;
		}
		registerPiDreamerProject({
			db,
			projectDir: current.projectDir,
			projectIdentity: current.projectIdentity,
			registrationOwner: dreamerRegistrationOwner,
			config: current.dreamerConfig,
			harness: PI_HARNESS_KIND,
			// Council finding #7: thread real embedding + memory config so
			// dreamer can do semantic dedup AND can write memory updates.
			// Previously hardcoded to off/false, making most dreamer tasks
			// useless on Pi.
			embeddingConfig: current.config.embedding,
			memoryEnabled: current.config.memory.enabled,
			retinaHandoff: current.config.smart_notes.retina_handoff,
			mural: current.config.mural,
			language: current.config.language,
			gitCommitIndexing: current.config.memory.git_commit_indexing,
			onAdjunctsRefreshNeeded: signalPiSystemPromptRefreshForProject,
		});
	}
	const todowriteEnabled = bootProjectDeps.config.todowrite.enabled !== false;
	const todowriteOverlayEnabled =
		todowriteEnabled && bootProjectDeps.config.todowrite.overlay !== false;

	// Register the agent-facing tools. Reuses the same business logic
	// the OpenCode plugin uses (insertMemory, unifiedSearch, addNote, …)
	// via the shared cortexkit DB. Cross-harness memory sharing is automatic
	// because both plugins resolve the same project identity for the same
	// directory.
	// Pi registers tools, commands, and widgets once at extension boot. Therefore
	// `todowrite.enabled` follows the boot project's config: after `/cd` into a
	// project with a different value, users need `/reload` or a Pi restart for the
	// tool/command/overlay surface to change, matching Pi's registration lifecycle.
	registerMagicContextTools(pi, {
		db,
		ensureProjectRegistered: ensureProjectRegisteredFromPiDirectory,
		// Main extension entry never gets the dreamer-only ctx_memory
		// surface — those actions are reserved for dreamer subagents
		// loaded via subagent-entry.ts with the
		// `--magic-context-dreamer-actions` flag.
		allowDreamerActions: false,
		// Keep the definition registered so Pi can activate it in a later session
		// after a project config flip. session_start below removes it from the
		// active tool set when the resolved project disables memory. (The subagent
		// entry still uses memoryToolEnabled to keep ctx_memory off the retrieval-
		// only sidekick, a separate security concern.)
		memoryToolEnabled: true,
		protectedTags: config.protected_tags ?? 20,
		resolveProtectedTags: (ctx) =>
			resolveCurrentProjectDeps(ctx).config.protected_tags ?? 20,
		resolveProjectIdentity: (ctx) =>
			resolveCurrentProjectDeps(ctx).projectIdentity,
		// Smart notes (surface_condition) only work when dreamer is
		// running — otherwise the note sits `pending` forever with no
		// path to surface. Match the user's dreamer config flag.
		dreamerEnabled: isDreamerRunnable(config),
		resolveDreamerEnabled: (ctx) =>
			resolveCurrentProjectDeps(ctx).dreamerEnabled,
		todowriteEnabled,
		compactionOff,
		promptSurface: registrationPromptSurface,
		promptSurfaceRuntime,
	});
	info(
		compactionOff
			? todowriteEnabled
				? "registered tools: ctx_search, ctx_memory, ctx_note, ctx_expand, todowrite; registered /todos (ctx_reduce unavailable in compaction-off mode)"
				: "registered tools: ctx_search, ctx_memory, ctx_note, ctx_expand (ctx_reduce unavailable in compaction-off mode; todowrite disabled)"
			: todowriteEnabled
				? "registered tools: ctx_search, ctx_memory, ctx_note, ctx_expand, todowrite, ctx_reduce; registered /todos"
				: "registered tools: ctx_search, ctx_memory, ctx_note, ctx_expand, ctx_reduce (todowrite disabled)",
	);

	pi.on("session_start", async (event, ctx) => {
		// Pi emits session_start for new, resumed, and reloaded sessions. Re-read
		// this cwd's config before setting the active tools so a memory.enabled
		// change takes effect at the next session without restarting Pi.
		projectDepsByDir.delete(ctx.cwd);
		const current = resolveCurrentProjectDeps(ctx);
		syncCtxMemoryToolEnabled(pi, current.config.memory.enabled);

		const failuresToShow = claimConfigParseFailuresOnce(
			"pi",
			current.configParseFailures,
		);
		if (ctx.hasUI && failuresToShow.length > 0) {
			ctx.ui.notify(formatConfigParseNotice(failuresToShow), "error");
		}
		if (
			ctx.hasUI &&
			current.hasDeprecatedProtectedTags &&
			claimProtectedTagsDeprecationNoticeOnce()
		) {
			ctx.ui.notify(formatProtectedTagsDeprecationNotice(), "warning");
		}

		const sessionId = resolveSessionId(ctx);
		const model = ctx.model;
		if (sessionId && model?.provider && model.id) {
			seedSessionCacheTtlIfUnsynced({
				db,
				sessionId,
				configured: current.config.cache_ttl,
				modelKey: canonicalPiModelKey(model.provider, model.id),
			});
		}

		await handlePiCloneSessionStart(event, ctx, {
			db,
			signalPendingMarker: signalPiDeferredCompactionMarkerDrain,
		});
	});

	const readLastTodoState = (sessionId: string) =>
		getOrCreateSessionMeta(db, sessionId).lastTodoState;
	if (todowriteEnabled) {
		registerTodoStateLifecycle(pi, { readLastTodoState });
	}
	const todoOverlay = todowriteOverlayEnabled
		? registerTodoOverlay(pi, {
				readLastTodoState,
			})
		: undefined;
	info(
		todowriteOverlayEnabled
			? "registered todowrite overlay"
			: "registered todowrite overlay: DISABLED (todowrite.enabled=false or todowrite.overlay=false)",
	);

	// Register the per-LLM-call transform pipeline. Tags eligible message
	// parts via the shared Tagger and applies queued drops from
	// `pending_ops` so /ctx-flush and ctx_reduce work against Pi sessions.
	registerPiContextHandler(pi, bootProjectDeps.contextOptions);
	info(
		bootProjectDeps.historianConfig
			? `registered historian trigger (model=${bootProjectDeps.historianConfig.model}, executeThreshold=${formatExecuteThresholdForLog(bootProjectDeps.historianConfig.executeThresholdPercentage)})`
			: "registered historian trigger: DISABLED (configure the active harness's historian model in magic-context.jsonc)",
	);
	info(
		bootProjectDeps.autoSearchConfig.enabled
			? `registered auto-search hint (threshold=${bootProjectDeps.autoSearchConfig.scoreThreshold}, minChars=${bootProjectDeps.autoSearchConfig.minPromptChars})`
			: "registered auto-search hint: DISABLED (memory.auto_search.enabled=false)",
	);

	// Register /ctx-aug once, but resolve sidekick config from the active cwd
	// every invocation so `/cd` follows the current project's model/language.
	registerCtxAugCommand(
		pi,
		(ctx) => resolveCurrentProjectDeps(ctx).sidekickConfig,
	);
	info(
		bootProjectDeps.sidekickConfig
			? `registered /ctx-aug (sidekick model=${bootProjectDeps.sidekickConfig.model})`
			: "registered /ctx-aug (sidekick disabled — set sidekick.disable=false and sidekick.model in config)",
	);

	// Register the shared renderer before any command can append a status entry.
	// Plain custom entries render in interactive Pi without entering model context.
	const statusEntryRendererAvailable = registerCtxStatusEntryRenderer(pi);
	info(
		statusEntryRendererAvailable
			? "registered model-invisible ctx-status entry renderer"
			: "ctx-status entry renderer unavailable; using legacy visible-message fallback",
	);

	// Step 5c: register the diagnostic/admin slash commands so Pi reaches
	// command-surface parity with the OpenCode plugin. Their user-facing output
	// uses model-invisible custom entries when the runtime can render them.
	const recompRunner = new PiSubagentRunner();
	const wrapupRunner = new PiSubagentRunner();
	const upgradeRunner = new PiSubagentRunner();
	registerCtxStatusCommand(pi, {
		db,
		projectIdentity,
		resolveProject: resolveCurrentProject,
		protectedTags: bootProjectDeps.config.protected_tags,
		executeThresholdPercentage:
			bootProjectDeps.config.execute_threshold_percentage,
		historyBudgetPercentage: bootProjectDeps.config.history_budget_percentage,
		injectionBudgetTokens:
			bootProjectDeps.config.memory?.injection_budget_tokens,
		commitClusterTrigger: bootProjectDeps.config.commit_cluster_trigger,
		executeThresholdTokens: bootProjectDeps.config.execute_threshold_tokens,
		dreamer: {
			runnable: bootProjectDeps.dreamerEnabled,
			scheduleSummary: summarizeDreamSchedule(bootProjectDeps.config.dreamer),
		},
		activeProfile: bootProjectDeps.config.profile,
		cacheTtlConfig: bootProjectDeps.config.cache_ttl,
		cacheTtlConfigured: bootProjectDeps.cacheTtlConfigured,
		configParseFailures: bootProjectDeps.configParseFailures,
		hasDeprecatedProtectedTags: bootProjectDeps.hasDeprecatedProtectedTags,
		resolveStatusDeps: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			return {
				db,
				projectIdentity: current.projectIdentity,
				protectedTags: current.config.protected_tags,
				executeThresholdPercentage: current.config.execute_threshold_percentage,
				historyBudgetPercentage: current.config.history_budget_percentage,
				injectionBudgetTokens: current.config.memory?.injection_budget_tokens,
				commitClusterTrigger: current.config.commit_cluster_trigger,
				executeThresholdTokens: current.config.execute_threshold_tokens,
				dreamer: {
					runnable: current.dreamerEnabled,
					scheduleSummary: summarizeDreamSchedule(current.config.dreamer),
				},
				activeProfile: current.config.profile,
				cacheTtlConfig: current.config.cache_ttl,
				cacheTtlConfigured: current.cacheTtlConfigured,
				configParseFailures: current.configParseFailures,
				hasDeprecatedProtectedTags: current.hasDeprecatedProtectedTags,
			};
		},
	});
	info("registered /ctx-status");
	registerStatusLine(pi, { db, projectIdentity });
	info("registered magic-context status line");

	registerCtxFlushCommand(pi, { db, compactionOff });
	info("registered /ctx-flush");

	// /ctx-recomp uses its own PiSubagentRunner instance — recomp can run
	// concurrently with normal historian, and giving each its own runner
	// avoids cross-cancellation. Same model + fallback chain as historian.
	registerCtxRecompCommand(pi, {
		db,
		runner: recompRunner,
		historianModel: bootProjectDeps.historianConfig?.model,
		historianChunkTokens: deriveHistorianChunkTokens(
			resolveHistorianContextLimit(bootProjectDeps.historianConfig?.model),
		),
		historianFallbacks: bootProjectDeps.historianConfig?.fallbackModels,
		historianTimeoutMs: bootProjectDeps.config.historian_timeout_ms,
		historianThinkingLevel: bootProjectDeps.historianConfig?.thinkingLevel,
		language: bootProjectDeps.config.language,
		memoryEnabled: bootProjectDeps.config.memory.enabled,
		autoPromote: bootProjectDeps.config.memory.auto_promote,
		compactionOff,
		resolveRuntimeDeps: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			return {
				db,
				runner: recompRunner,
				historianModel: current.historianConfig?.model,
				historianChunkTokens: deriveHistorianChunkTokens(
					resolveHistorianContextLimit(current.historianConfig?.model),
				),
				historianFallbacks: current.historianConfig?.fallbackModels,
				historianTimeoutMs: current.config.historian_timeout_ms,
				historianThinkingLevel: current.historianConfig?.thinkingLevel,
				language: current.config.language,
				memoryEnabled: current.config.memory.enabled,
				autoPromote: current.config.memory.auto_promote,
				compactionOff,
			};
		},
	});
	info("registered /ctx-recomp");

	registerCtxWrapupCommand(pi, {
		db,
		runner: wrapupRunner,
		historianModel: bootProjectDeps.historianConfig?.model,
		historianChunkTokens: deriveHistorianChunkTokens(
			resolveHistorianContextLimit(bootProjectDeps.historianConfig?.model),
		),
		historianFallbacks: bootProjectDeps.historianConfig?.fallbackModels,
		historianTimeoutMs: bootProjectDeps.config.historian_timeout_ms,
		historianThinkingLevel: bootProjectDeps.historianConfig?.thinkingLevel,
		language: bootProjectDeps.config.language,
		memoryEnabled: bootProjectDeps.config.memory.enabled,
		autoPromote: bootProjectDeps.config.memory.auto_promote,
		compactionOff,
		userMemoriesEnabled: userMemoryCollectionEnabled(
			bootProjectDeps.config.dreamer,
		),
		executeThresholdPercentage:
			bootProjectDeps.config.execute_threshold_percentage,
		executeThresholdTokens: bootProjectDeps.config.execute_threshold_tokens,
		resolveRuntimeDeps: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			return {
				db,
				runner: wrapupRunner,
				historianModel: current.historianConfig?.model,
				historianChunkTokens: deriveHistorianChunkTokens(
					resolveHistorianContextLimit(current.historianConfig?.model),
				),
				historianFallbacks: current.historianConfig?.fallbackModels,
				historianTimeoutMs: current.config.historian_timeout_ms,
				historianThinkingLevel: current.historianConfig?.thinkingLevel,
				language: current.config.language,
				memoryEnabled: current.config.memory.enabled,
				autoPromote: current.config.memory.auto_promote,
				compactionOff,
				userMemoriesEnabled: userMemoryCollectionEnabled(
					current.config.dreamer,
				),
				executeThresholdPercentage: current.config.execute_threshold_percentage,
				executeThresholdTokens: current.config.execute_threshold_tokens,
			};
		},
	});
	info("registered /ctx-wrapup");

	// E6b/E6c: /ctx-session-upgrade — full recomp (legacy→v2 tiered) + once-per-
	// project memory migration into the 5-category taxonomy. Own runner instance
	// for the same isolation reasons as /ctx-recomp.
	registerCtxSessionUpgradeCommand(pi, {
		db,
		runner: upgradeRunner,
		historianModel: bootProjectDeps.historianConfig?.model,
		historianChunkTokens: deriveHistorianChunkTokens(
			resolveHistorianContextLimit(bootProjectDeps.historianConfig?.model),
		),
		historianFallbacks: bootProjectDeps.historianConfig?.fallbackModels,
		historianTimeoutMs: bootProjectDeps.config.historian_timeout_ms,
		historianThinkingLevel: bootProjectDeps.historianConfig?.thinkingLevel,
		language: bootProjectDeps.config.language,
		memoryEnabled: bootProjectDeps.config.memory.enabled,
		allowHomeProject: bootProjectDeps.config.allow_home_project,
		autoPromote: bootProjectDeps.config.memory.auto_promote,
		compactionOff,
		userMemoriesEnabled: userMemoryCollectionEnabled(
			bootProjectDeps.config.dreamer,
		),
		resolveRuntimeDeps: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			return {
				db,
				runner: upgradeRunner,
				historianModel: current.historianConfig?.model,
				historianChunkTokens: deriveHistorianChunkTokens(
					resolveHistorianContextLimit(current.historianConfig?.model),
				),
				historianFallbacks: current.historianConfig?.fallbackModels,
				historianTimeoutMs: current.config.historian_timeout_ms,
				historianThinkingLevel: current.historianConfig?.thinkingLevel,
				language: current.config.language,
				memoryEnabled: current.config.memory.enabled,
				allowHomeProject: current.config.allow_home_project,
				autoPromote: current.config.memory.auto_promote,
				compactionOff,
				userMemoriesEnabled: userMemoryCollectionEnabled(
					current.config.dreamer,
				),
			};
		},
	});
	info("registered /ctx-session-upgrade");

	registerCtxDreamCommand(pi, {
		db,
		projectDir,
		projectIdentity,
		resolveProject: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			return {
				projectDir: current.projectDir,
				projectIdentity: current.projectIdentity,
			};
		},
		dreamerEnabled: bootProjectDeps.dreamerEnabled,
		resolveDreamerEnabled: (ctx) =>
			resolveCurrentProjectDeps(ctx).dreamerEnabled,
		onProjectSeen: (identity) => seenDreamerProjectIdentities.add(identity),
		ensureRegistered: (ctx) =>
			syncDreamerProjectRegistration(resolveCurrentProjectDeps(ctx)),
		registrationOwner: dreamerRegistrationOwner,
	});
	info("registered /ctx-dream");

	registerCtxEmbedCommand(pi, {
		db,
		projectDir,
		projectIdentity,
		memoryEnabled: bootProjectDeps.config.memory.enabled,
		resolveMemoryEnabled: (ctx) =>
			resolveCurrentProjectDeps(ctx).config.memory.enabled,
		resolveProject: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			return {
				projectDir: current.projectDir,
				projectIdentity: current.projectIdentity,
			};
		},
	});
	info("registered /ctx-embed");

	// Register Pi project with the singleton dreamer timer. When dreamer is
	// disabled in config (default) this is a no-op. When enabled, the timer
	// schedules dream runs based on config.dreamer.schedule and uses
	// PiSubagentRunner to spawn child sessions for each task.
	const dreamerConfig = bootProjectDeps.dreamerConfig;
	if (dreamerConfig) {
		syncDreamerProjectRegistration(bootProjectDeps);
		info(`registered dreamer (${summarizeDreamSchedule(dreamerConfig)})`);
	} else {
		info(
			bootProjectDeps.dreamerEnabled
				? "registered dreamer: DISABLED (no dreamer config)"
				: "registered dreamer: DISABLED (dreamer.disable=true or no dreamer config)",
		);
	}

	// Inject the magic-context guidance block into the system prompt for every agent
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
		// Match OpenCode's first-prompt lazy-load boundary so synchronous token
		// estimates below never depend on a virtual bundled-module resolution base.
		await preloadTokenizer();
		// Startup release announcement (Pi parity with OpenCode TUI dialog +
		// Desktop ignored message). Fires once per ANNOUNCEMENT_VERSION across
		// the whole machine — persistence file is shared with the OpenCode
		// plugin via `getMagicContextStorageDir()/last_announced_version`.
		//
		// Skipped silently when:
		//   - announcement constants are empty (bugfix-only release)
		//   - the current ANNOUNCEMENT_VERSION was already dismissed (here or
		//     in OpenCode TUI/Desktop)
		//   - ctx.hasUI is false (print/rpc subagent — no point notifying)
		//
		// Fire-and-forget: storage write happens inside markAnnouncementSeen,
		// any failure is swallowed. Worst case is a duplicate notification
		// the next time the user starts an interactive Pi session.
		try {
			if (ctx.hasUI && shouldShowAnnouncement()) {
				// URLs render as plain text. Modern terminals auto-detect and
				// let users Cmd-click; older terminals require manual copy.
				// We previously wrapped URLs in OSC 8 hyperlink escapes, but
				// not all terminals support them and `ctx.ui.notify` may also
				// re-render the message through pi-tui's text pipeline that
				// strips raw escapes. Plain text is the most reliable surface.
				const featureText = ANNOUNCEMENT_FEATURES.map(
					(line) => `  • ${line}`,
				).join("\n");
				const sections = [
					`✨ Magic Context v${ANNOUNCEMENT_VERSION} — what's new:`,
					"",
					featureText,
				];
				if (ANNOUNCEMENT_FOOTER && ANNOUNCEMENT_FOOTER.trim().length > 0) {
					// Blank-line separator distinguishes the persistent footer
					// (Discord invite, etc.) from the version-specific bullets.
					sections.push("", ANNOUNCEMENT_FOOTER);
				}
				ctx.ui.notify(sections.join("\n"), "info");
				markAnnouncementSeen(ANNOUNCEMENT_VERSION);
			}
		} catch {
			// Never block agent start on announcement delivery.
		}

		try {
			const effectiveProjectDeps = resolveCurrentProjectDeps(ctx);
			const currentProject = {
				projectDir: effectiveProjectDeps.projectDir,
				projectIdentity: effectiveProjectDeps.projectIdentity,
			};
			const effectiveConfig = effectiveProjectDeps.config;

			// Re-register the dreamer for the CURRENT project. The boot-time
			// registration above used process.cwd(), but Pi can switch projects
			// mid-process (`/cd`, multi-root). Without this, a switched-into
			// project is never dreamed and `/ctx-dream` there throws
			// "not registered". registerPiDreamerProject is idempotent for the
			// same identity+dir, and rebuilds against the new checkout when the
			// directory changed (worktree/clone of the same repo).
			//
			// All project-sensitive config comes from resolveCurrentProjectDeps(ctx),
			// the same per-cwd accessor used by tools, commands, and the context
			// pipeline. A switched-into project may carry its own config (different
			// model/schedule, or its own `dreamer.disable`), so boot config must not
			// leak into this registration.
			// The current checkout may also disable the dreamer. This instance may own a
			// registration created while another checkout's config was active, so the
			// shared helper releases that ownership explicitly.
			try {
				syncDreamerProjectRegistration(effectiveProjectDeps);
			} catch (err) {
				warn("before_agent_start: dreamer registration sync threw:", err);
			}
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
			if (sessionId) {
				trackSessionForProject(currentProject.projectIdentity, sessionId);

				// Re-arm a pending Pi compaction-marker drain on session ACTIVATION,
				// not just at process startup. session_before_switch clears the
				// in-memory deferred-refresh/materialization sets for the outgoing
				// session (those Sets are per-process and would otherwise leak); but
				// the durable pending marker in session_meta survives. On switch-BACK
				// the marker would then sit undrained (the drain is signal-driven, and
				// startup-only rehydration never re-fires). Re-signal here when this
				// session has a durable pending marker so the next eligible materializing
				// pass drains it, using the same deferred signal shape as startup.
				//
				// Gate on the same APIs the drain itself requires
				// (sessionManager.appendCompaction + getBranch): when they're
				// unavailable the drain skips-and-PRESERVES the signal, so re-signaling
				// every turn would keep an undrainable signal armed. Only re-arm when the
				// marker can actually be applied.
				try {
					const smForDrain = sm as {
						appendCompaction?: unknown;
						getBranch?: unknown;
					};
					const canDrain =
						typeof smForDrain.appendCompaction === "function" &&
						typeof smForDrain.getBranch === "function";
					if (
						!compactionOff &&
						canDrain &&
						getPendingPiCompactionMarkerState(db, sessionId)
					) {
						signalPiDeferredCompactionMarkerDrain(sessionId);
					}
				} catch {
					// Best-effort: a read failure must not block agent start.
				}

				// E6d: one-time upgrade reminder for sessions with legacy (pre-v2)
				// compartments. Model-invisible (ctx.ui.notify), self-gating via the
				// durable + per-process guards in the shared helper. Only when the
				// historian can run (so /ctx-session-upgrade is actionable).
				if (
					!compactionOff &&
					ctx.hasUI &&
					effectiveProjectDeps.historianConfig?.model
				) {
					void maybeSendUpgradeReminder(
						{
							client: null,
							db,
							sendIgnoredMessage: async (_client, _sid, text) => {
								ctx.ui.notify(text, "info");
								return "sent";
							},
							getNotificationParams: () => ({}),
							// Pi's ctx.ui.notify is a TRANSIENT toast (no scrollback),
							// so the durable stamp must not suppress after one missed
							// toast — re-prompt each Pi start until the session upgrades.
							deliveryPersists: false,
						},
						sessionId,
					).catch(() => {
						// Never block agent start on reminder delivery.
					});
				}
			}

			// Use effectiveConfig (re-resolved from the CURRENT checkout's cwd on
			// a project switch) for every system-prompt decision below — a
			// switched-into project may carry its own .cortexkit/magic-context.jsonc
			// (memory/docs/key-files/injection toggles). Reusing boot `config`
			// would render the launch project's adjuncts in the new checkout.
			if (effectiveConfig.system_prompt_injection?.enabled === false) {
				return;
			}
			const skipSigs =
				effectiveConfig.system_prompt_injection?.skip_signatures ?? [];
			if (
				skipSigs.some(
					(sig) => sig.length > 0 && event.systemPrompt.includes(sig),
				)
			) {
				return;
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

			const promptSurfaceModel = (
				ctx as { model?: { provider?: unknown; id?: unknown } }
			).model;
			const promptSurfaceModelKey =
				typeof promptSurfaceModel?.provider === "string" &&
				promptSurfaceModel.provider.length > 0 &&
				typeof promptSurfaceModel.id === "string" &&
				promptSurfaceModel.id.length > 0
					? canonicalPiModelKey(
							promptSurfaceModel.provider,
							promptSurfaceModel.id,
						)
					: undefined;
			const promptSurface = sessionId
				? promptSurfaceGuidanceEpochs.resolve(
						sessionId,
						effectiveConfig.prompt_surface,
						promptSurfaceModelKey,
					)
				: promptSurfaceRuntime.resolveGuidance(
						effectiveConfig.prompt_surface,
						promptSurfaceModelKey,
					);

			const block = buildMagicContextBlock({
				db,
				cwd: currentProject.projectDir,
				sessionId,
				memoryEnabled: effectiveConfig.memory.enabled,
				includeGuidance: true,
				protectedTags: effectiveConfig.protected_tags,
				ctxReduceCallable: !compactionOff,
				dreamerEnabled: effectiveProjectDeps.dreamerEnabled,
				temporalAwarenessEnabled: effectiveConfig.temporal_awareness ?? false,
				cavemanTextCompressionEnabled:
					effectiveConfig.caveman_text_compression?.enabled === true,
				language: effectiveConfig.language,
				promptSurfacePreset: promptSurface.preset,
				primaryGuidanceOverride: promptSurface.primaryOverride,
				// Stable user memories rendered as <user-profile> — dreamer
				// promotes recurring observations into this set, then the
				// system prompt surfaces them across all sessions in the
				// project. Gated on dreamer.user_memories.enabled.
				userMemoriesEnabled: userMemoryCollectionEnabled(
					effectiveConfig.dreamer,
				),
				isCacheBusting,
				existingSystemPrompt: event.systemPrompt,
			});

			// Compose the final system prompt: base prompt from Pi + our
			// magic-context block. We always run hash detection on the
			// composed string so even sessions with no data block (e.g.
			// memories disabled, no docs, no key files) still get
			// sticky-date freezing and hash-change tracking.
			const composedPrompt = composeMagicContextSystemPrompt(
				event.systemPrompt,
				block,
			);

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
				promptSurfacePreset: promptSurface.preset,
			});

			if (result.hashChanged) {
				// Real prompt-content or preset change. Signal all three
				// independent refresh sets so the next pi.on("context") event
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
	pi.on("agent_end", (event, ctx) => {
		// Synchronous return — DO NOT await background work here.
		// awaitInFlightHistorians()/awaitInFlightDreamers() are still
		// invoked at session_shutdown where they belong (and where pi
		// gives us a window before tearing down stdio). Errors from
		// background runs are handled by their own try/catch chains
		// (runPiHistorian wraps everything; spawnPiHistorianRun's
		// .finally cleans up the inFlight map).
		log("agent_end: returning synchronously (background work continues)");

		// Channel 2 (ceiling) nudge delivery — the Pi analog of OpenCode's
		// event-handler delivery on terminal message.updated. The pipeline
		// records a `pending` intent near the threshold; deliver it here as a
		// steer. On a busy run the host appends it at the next model boundary;
		// on a clean idle stop triggerTurn starts the continuation immediately.
		// Internally CAS-gated to one delivery per tail-reset cycle and no-ops
		// unless `pending`.
		// Fire-and-forget; never block agent_end.
		//
		// Deliver ONLY on a clean final stop. Pi emits agent_end for error /
		// aborted responses and for retry attempts too (agent-loop); delivering
		// on those would inject the follow-up mid-retry and consume the cycle
		// before the turn actually completed. OpenCode's equivalent gates on
		// finish === "stop". Mirror that with the final assistant's stopReason.
		try {
			const msgs = (
				event as { messages?: Array<{ role?: string; stopReason?: string }> }
			)?.messages;
			const lastAssistant = Array.isArray(msgs)
				? [...msgs].reverse().find((m) => m?.role === "assistant")
				: undefined;
			if (lastAssistant?.stopReason === "stop") {
				const sessionId = ctx.sessionManager?.getSessionId?.();
				if (sessionId && db && !compactionOff)
					maybeDeliverChannel2Pi(pi, db, sessionId);
			}
		} catch (err) {
			log(`agent_end: channel2 delivery skipped: ${String(err)}`);
		}
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
				const toolCallId =
					typeof (event as { toolCallId?: unknown }).toolCallId === "string"
						? (event as { toolCallId: string }).toolCallId
						: undefined;
				const todos = todoArgs?.todos;
				const sessionMeta = Array.isArray(todos)
					? getOrCreateSessionMeta(db, sessionId)
					: null;

				// Synthetic-todowrite snapshot capture (Pi parity with
				// OpenCode hook-handlers.ts:386-401). Persist normalized
				// state on EVERY todowrite call so the transform-time
				// injection path in pi-pipeline.ts always has a current
				// snapshot to replay on the next cache-busting pass.
				// Render-safe: this only stores validated todos in shared
				// session state and the local tool-call cache; it does not
				// mutate Pi messages. Subagents skip — they do not get synthetic
				// todowrite injection. Foreign Pi extensions can share the
				// `todowrite` name, so only the exact Magic Context todo
				// shape updates the stored snapshot.
				capturePiTodowriteArgsIfCompatible({
					db,
					sessionId,
					todos,
					todowriteEnabled,
					todoOverlay,
					persist: Boolean(sessionMeta && !sessionMeta.isSubagent),
					toolCallId,
				});

				if (
					Array.isArray(todos) &&
					todos.length > 0 &&
					todos.every(
						(t) => t.status === "completed" || t.status === "cancelled",
					)
				) {
					if (!compactionOff && sessionMeta && !sessionMeta.isSubagent) {
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
			if (!compactionOff && event.toolName === "ctx_reduce") {
				markPiChannel1Reduced(sessionId, db);
			}
		} catch (err) {
			log(
				`tool_execution_end hook failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

	// Channel 1 (ctx_reduce in-turn nudge), Pi parity with OpenCode's
	// `tool.execute.after` → `output.output` append. `tool_result` lets an
	// extension REPLACE the recorded tool result content; returning the original
	// content plus an appended `<system-reminder>` block persists to the session
	// JSONL (via `appendMessage` on `message_end`) and replays verbatim on every
	// later `context` pass — "free sticky", no anchor/CAS/replay machinery. The
	// metric baseline is computed in the pipeline (`pi.on("context")`) and read
	// here, exactly mirroring OpenCode's transform→tool.execute.after split.
	pi.on("tool_result", async (event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (typeof sessionId !== "string" || sessionId.length === 0) return;
			// Channel 2 mid-turn delivery: steer a pending ceiling intent into the
			// active run. The host finishes ordinary tools in this step before
			// appending the nudge ahead of the next model call. Under oh-my-pi (OMP),
			// an explicitly interruptible wait that is cancelled gets a paired
			// synthetic result. No-ops unless pending and revalidated; agent_end stays
			// as the fallback delivery site.
			if (compactionOff) return;
			const block = maybeChannel1ReminderForToolResult({
				db,
				sessionId,
				toolName: event.toolName,
				content: event.content,
			});
			if (db) maybeDeliverChannel2Pi(pi, db, sessionId);
			if (!block) return;
			return { content: [...event.content, block] };
		} catch (err) {
			log(
				`tool_result hook failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

	// In normal mode MC owns compaction and cancels Pi's native hook. In
	// compaction-off mode the same hook must return nothing: native Pi compaction
	// is the selected context manager and cancelling it would leave no manager.
	pi.on("session_before_compact", async (_event, ctx) =>
		handlePiSessionBeforeCompact({ db, compactionOff, ctx }),
	);

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
			if (!compactionOff && msg !== null && typeof msg === "object") {
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
			const endedMsg = event.message as unknown as {
				id?: string;
				role?: string;
			};
			if (
				endedMsg?.role === "assistant" &&
				typeof endedMsg.id === "string" &&
				endedMsg.id.length > 0
			) {
				const messageId = endedMsg.id;
				scheduleIncrementalIndex(db, sessionId, messageId, () => {
					const rawMessages = readPiSessionMessages(ctx);
					return (
						rawMessages.find((message) => message.id === messageId) ?? null
					);
				});
			}
			persistPiMessageEndModelMeta({
				db,
				sessionId,
				message: event.message,
				cacheTtlConfig: resolveCurrentProjectDeps(ctx).config.cache_ttl,
			});
			// Compute pressure with OpenCode-equivalent semantics: pull
			// the assistant's `usage` field and use
			// `input + cacheRead + cacheWrite` (NOT output) divided by
			// the effective context limit. The window comes from Pi's own
			// runtime — `getContextUsage().contextWindow`, falling back to
			// `ctx.model.contextWindow` if usage hasn't populated — NOT
			// models.dev. `session_meta.detected_context_limit` still overrides
			// it (in persistPiPressureFromMessageEnd) so post-overflow pressure
			// reflects the real, lower limit. See `pi-pressure.ts` for rationale.
			const piUsage = ctx.getContextUsage?.();
			const piContextWindow =
				piUsage &&
				typeof piUsage.contextWindow === "number" &&
				piUsage.contextWindow > 0
					? piUsage.contextWindow
					: (ctx.model?.contextWindow ?? 0);
			await persistPiPressureFromMessageEnd({
				db,
				sessionId,
				message: event.message,
				piContextWindow,
				piModel: ctx.model,
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
					capturePiTodowriteMessageIfCompatible({
						db,
						sessionId,
						message: event.message,
						todowriteEnabled,
						todoOverlay,
						persist: true,
					});
				}
			} catch (err) {
				warn("message_end: synthetic todowrite capture failed:", err);
			}
		} catch (err) {
			warn("message_end: persist session_meta usage failed:", err);
		}

		// Pi has no `session.error` event. Provider failures arrive on the assistant
		// `message_end` payload, so classify both overflow and Fable thinking-binding
		// failures here and persist the decision for the next context pass.
		try {
			const sm = ctx.sessionManager as
				| { getSessionId?: () => string | undefined }
				| undefined;
			const sessionId = sm?.getSessionId?.();
			if (typeof sessionId !== "string" || sessionId.length === 0) return;
			const recovery = handlePiProviderFailure({
				db,
				sessionId,
				message: event.message,
				compactionOff,
			});
			if (recovery.kind === "overflow") {
				log(
					`[magic-context][${sessionId}] overflow detected: reportedLimit=${
						recovery.reportedLimit ?? "?"
					} provenance=${recovery.reportedLimitProvenance ?? "?"} pattern=${recovery.matchedPattern ?? "?"}`,
				);
			}
		} catch (err) {
			warn("message_end: provider failure classification failed:", err);
		}
	});

	// Release this extension instance's dreamer registrations on session shutdown.
	// Pi's `/reload` command tears down extensions and re-runs this default
	// export — without releasing them, the dreamer timer would hold a
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
		sessionShuttingDown = true;
		commandLifecycleController.abort();
		// Bounded drain of in-flight historian / dreamer runs that were
		// kicked off by recent turns. We moved the drain here from
		// `agent_end` because Pi awaits agent_end handlers and was
		// stalling the UI loader on every turn that triggered historian.
		// session_shutdown only fires when the user is actually leaving
		// the session, so a brief wait is acceptable — and lets the
		// JSONL session state reach a consistent compartment boundary
		// before that session's cleanup completes.
		//
		// 5-second cap per drain protects interactive shutdown from a hung
		// subagent. In `pi --print` mode the process exits after
		// agent_end before this handler fires anyway, so the cap
		// doesn't help that mode (and we don't pretend it does — see
		// the comment block on the agent_end handler above).
		const SHUTDOWN_DRAIN_MS = 5_000;
		const sessionId = resolveSessionId(ctx);
		// Stop this owner from admitting new Dreamer runs before snapshotting its
		// in-flight work. A command that already started remains owner-tracked and
		// is drained below; a later command fails instead of outliving shutdown.
		try {
			for (const identity of seenDreamerProjectIdentities) {
				unregisterPiDreamerProject({
					projectIdentity: identity,
					registrationOwner: dreamerRegistrationOwner,
				});
			}
		} catch (err) {
			warn("shutdown: unregisterPiDreamerProject threw:", err);
		}
		if (sessionId) {
			try {
				await withTimeout(
					awaitInFlightHistorians(sessionId),
					SHUTDOWN_DRAIN_MS,
				);
			} catch (err) {
				warn("shutdown: historian drain threw:", err);
			}
			try {
				await withTimeout(awaitInFlightRecomps(sessionId), SHUTDOWN_DRAIN_MS);
			} catch (err) {
				warn("shutdown: recomp drain threw:", err);
			}
			// Timeout only stops waiting. Fence and cancel any run still alive before
			// this handler returns and Pi disposes its command context.
			abortInFlightRecomps(sessionId);
		}
		try {
			await withTimeout(
				awaitInFlightDreamers(dreamerRegistrationOwner),
				SHUTDOWN_DRAIN_MS,
			);
		} catch (err) {
			warn("shutdown: dreamer drain threw:", err);
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
				promptSurfaceGuidanceEpochs.clear(sessionId);
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
				// Clear ONLY the in-memory per-session maps (the actual leak that
				// grows one entry per swap). Do NOT clear the durable DB m[0] cache
				// here: session_before_switch is REVERSIBLE (the user can switch
				// back), unlike OpenCode's session.deleted. The DB cache is bounded
				// (one session_meta row per session) and self-invalidates via
				// epoch/version/docs-hash checks in mustMaterializePi, so preserving
				// it lets a switch-back reuse the cached prefix instead of forcing a
				// full m[0] re-materialization (an avoidable prompt-cache bust).
				clearPiSystemPromptSession(outgoingSessionId);
				promptSurfaceGuidanceEpochs.clear(outgoingSessionId);
				clearContextHandlerSession(outgoingSessionId);
			}
		} catch {
			// best-effort — Pi proceeds with the switch regardless
		}
	});
}

function registerPiSubagentInitContextCleanup(
	pi: ExtensionAPI,
	unsubscribe: () => void,
): void {
	pi.on("session_shutdown", unsubscribe);
}

/**
 * Format `execute_threshold_percentage` for the boot log. The config accepts
 * either a bare number or a per-model map (`{ default: 65, "provider/model": 50 }`);
 * naive interpolation printed the map form as `[object Object]%`.
 */
function formatExecuteThresholdForLog(
	value: number | { default: number; [modelKey: string]: number } | undefined,
): string {
	if (value === undefined) return "65%";
	if (typeof value === "number") return `${value}%`;
	const overrides = Object.entries(value)
		.filter(([key]) => key !== "default")
		.map(([key, pct]) => `${key}=${pct}%`);
	const base = `${value.default}%`;
	return overrides.length > 0 ? `${base} (${overrides.join(", ")})` : base;
}
