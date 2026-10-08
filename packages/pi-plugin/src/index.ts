/**
 * Magic Context — Pi coding agent extension.
 *
 * Loaded once per Pi session via `pi.extensions` in package.json. Boots
 * Magic Context's shared SQLite store and registers session lifecycle
 * hooks: tools, transform pipeline (tagging + drops), historian trigger,
 * system-prompt injection, dreamer scheduling, and
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
import {
	changedLiveKeys,
	dreamerRunConfig,
	historianRunConfig,
} from "@magic-context/core/config/live-run-config";
import { LiveConfigReader } from "@magic-context/core/config/live-snapshot";
import { migrateMagicContextConfigLocations } from "@magic-context/core/config/migrate-config-location";
import { getProtectedTokensTierOverrides } from "@magic-context/core/config/project-security";
import type {
	DreamerConfig,
	HistorianConfig,
	MagicContextConfig,
} from "@magic-context/core/config/schema/magic-context";
import { createSubcCheckoutClaimGate } from "@magic-context/core/features/magic-context/checkout-claim";
import {
	summarizeDreamSchedule,
	userMemoryCollectionEnabled,
} from "@magic-context/core/features/magic-context/dreamer/task-config";
import {
	type FailClosedReason,
	formatFailClosedBlockingMessage,
} from "@magic-context/core/features/magic-context/fail-closed-block";
import {
	isUsableProjectIdentity,
	resolveProjectIdentityForSession,
	setHomeProjectPermission,
} from "@magic-context/core/features/magic-context/memory/project-identity";
import { detectOverflow } from "@magic-context/core/features/magic-context/overflow-detection";
import { resolveSessionCacheTtl } from "@magic-context/core/features/magic-context/session-cache-ttl";
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
	closeDatabase,
	openDatabaseAsync,
	setSqlitePragmaConfig,
} from "@magic-context/core/features/magic-context/storage-db";
import {
	clearDetectedContextLimit,
	getOverflowState,
	loadProtectedTailMeta,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { describeStorageUnavailability } from "@magic-context/core/features/magic-context/storage-unavailable-reason";
import { runDeferredV22Backfill } from "@magic-context/core/features/magic-context/v22-deferred-backfill";
import { cavemanWordRulesForLanguage } from "@magic-context/core/hooks/magic-context/caveman";
import { setCtxReduceRegisteredGlobally } from "@magic-context/core/hooks/magic-context/ctx-reduce-availability";
import {
	deriveHistorianChunkTokens,
	resolveHistorianContextLimit,
	resolveKnownHistorianContextLimit,
} from "@magic-context/core/hooks/magic-context/derive-budgets";
import { getDefaultSubcConnectionFile } from "@magic-context/core/hooks/magic-context/module-transport";
import {
	clearNoteNudgeTriggerAndCooldown,
	onNoteTrigger,
} from "@magic-context/core/hooks/magic-context/note-nudger";
import { preloadTokenizer } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { normalizeTodoStateJson } from "@magic-context/core/hooks/magic-context/todo-view";
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
import { setEmbeddingSessionBusy } from "@magic-context/core/shared/embedding-activity";
import { setHarness } from "@magic-context/core/shared/harness";
import { piModelRefToCanonical } from "@magic-context/core/shared/harness-provider-map";
import { setKeepSubagents } from "@magic-context/core/shared/keep-subagents";
import { flushLogger, log } from "@magic-context/core/shared/logger";
import { resolveHistorianModel } from "@magic-context/core/shared/model-resolution";
import {
	createPromptSurfaceGuidanceEpochCache,
	createPromptSurfaceRuntime,
} from "@magic-context/core/shared/prompt-surface-runtime";
import {
	isSuccessfulProviderCompletion,
	providerResponseFailed,
} from "@magic-context/core/shared/provider-response-completion";
import { setStoragePrivatePermissionEnforcement } from "@magic-context/core/shared/storage-permissions";
import {
	hasTrustedAbsoluteWall,
	reloadWindowOverlay,
} from "@magic-context/core/shared/window-geometry";
import { gatePiEventsByCheckoutClaim } from "./checkout-claim-pi";
import { handlePiCloneSessionStart } from "./clone-inheritance";
import { registerCtxDreamCommand } from "./commands/ctx-dream";
import {
	maybeAutoEmbedPiSession,
	registerCtxEmbedCommand,
} from "./commands/ctx-embed";
import { registerCtxFlushCommand } from "./commands/ctx-flush";
import { registerCtxRecompCommand } from "./commands/ctx-recomp";
import { registerCtxStatusCommand } from "./commands/ctx-status";
import { registerCtxWrapupCommand } from "./commands/ctx-wrapup";
import {
	registerCtxStatusEntryRenderer,
	registerCtxStatusLifecycleSignal,
	resolveSessionId,
} from "./commands/pi-command-utils";
import { loadPiConfig, loadPiConfigDetailed } from "./config";
import {
	abortInFlightHistorians,
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
import { stopStatusDialogRefresh } from "./dialogs/status-dialog";
import {
	abortInFlightDreamers,
	awaitInFlightDreamers,
	registerPiDreamerProject,
	unregisterPiDreamerProject,
	validatePiDreamerModels,
} from "./dreamer";
import { loadDefaultPiSessionApi } from "./dreamer/pi-session-api";
import {
	backfillPiSessionActivity,
	observePiMessageActivity,
} from "./dreamer/session-activity-pi";
import { registerPiDroppedInputGuard } from "./dropped-input-guard-pi";
import {
	ensureProjectRegisteredFromPiDirectory,
	unregisterPiProjectEmbeddings,
} from "./embedding-bootstrap";
import { registerPiFailClosedSurface } from "./fail-closed-pi";
import { schedulePiAssistantIndexOnMessageEnd } from "./message-end-index-pi";
import {
	describeInertEmergencyDrainLatch,
	emptyPiModelChainsKey,
	findEmptyPiModelChains,
	formatEmptyPiModelChain,
	formatEmptyPiModelChainsNotice,
	type PiModelRegistryLike,
} from "./model-chain-health";
import { bootPiRuntimeWithDeadline } from "./pi-boot-deadline";
import {
	resolvePiUsableContextLimit,
	resolvePiWindowGeometry,
} from "./pi-context-limit";
import {
	type PiHarnessKind,
	resolvePiHarnessDetection,
} from "./pi-harness-kind";
import { notePiLkgProviderUsage } from "./pi-lkg";
import {
	computePiPressure,
	extractAssistantUsage,
	isPiContextUsageRawBranchEstimate,
	notePiUsageReadingUsed,
	noteRawBranchEstimateSetAside,
	piMessageAnchorsLiveUsage,
	recordPiLiveUsageClassification,
} from "./pi-pressure";
import {
	piProvenFloorModelKey,
	readPiProvenFloorRecord,
	recordPiProvenFloorModel,
	resolvePiProvenInputFloor,
} from "./pi-proven-floor";
import { abortInFlightRecomps, awaitInFlightRecomps } from "./pi-recomp-runner";
import { handlePiProviderFailure } from "./provider-error-recovery-pi";
import { bindStaleBuildNotice } from "./stale-build-notice";
import { registerStatusLine, updateStatusLine } from "./status-line";
import { stripTagPrefixFromAssistantMessage } from "./strip-tag-prefix";
import { registerPiSubagentHostTools } from "./subagent-host-tools";
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
let databaseExitHookRegistered = false;
const activePiRuntimes = new Set<object>();
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
 * Only an allowed native compaction invalidates MC's cached m[0]/m[1].
 * A cancelled attempt changes no history; clearing its cache would manufacture
 * a first_render HARD fold on the next context pass.
 */
export async function handlePiSessionBeforeCompact(args: {
	db: ContextDatabase;
	compactionOff: boolean;
	ctx: { sessionManager?: { getSessionId?: () => string | undefined } };
}): Promise<{ cancel: true } | undefined> {
	if (!args.compactionOff) {
		info("session_before_compact: cancelling — magic-context owns compaction");
		return { cancel: true };
	}
	try {
		const sessionId = args.ctx.sessionManager?.getSessionId?.();
		if (typeof sessionId === "string" && sessionId.length > 0) {
			clearPiM0Cache(args.db, sessionId, "session_before_compact");
		}
	} catch {
		// Cache invalidation is best-effort; it must not suppress Pi's native path.
	}
	info(
		"session_before_compact: native Pi compaction proceeds (compaction-off mode)",
	);
}

export function canonicalPiModelKey(provider: string, model: string): string {
	return piModelRefToCanonical(`${provider}/${model}`);
}

export function persistPiMessageEndModelMeta(args: {
	db: ContextDatabase;
	sessionId: string;
	message: unknown;
	cacheTtlConfig: MagicContextConfig["cache_ttl"];
	cacheTtlConfigured?: boolean;
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
	const cacheTtl = resolveSessionCacheTtl(
		args.db,
		args.sessionId,
		args.cacheTtlConfig,
		modelKey,
		args.cacheTtlConfigured,
	).value;
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

const loggedNoProjectIdentityDirs = new Set<string>();

/**
 * Say once per directory that it has no project identity. The resolver refuses
 * the home directory (and folders inside a dotfiles repository rooted at home)
 * unless `allow_home_project` is set; such a directory gets no memory, search,
 * embeddings, or dreamer, and nothing is keyed by an empty project name.
 */
function logNoProjectIdentityOnce(directory: string): void {
	if (loggedNoProjectIdentityDirs.has(directory)) return;
	loggedNoProjectIdentityDirs.add(directory);
	info(
		`no project identity for ${directory}: it is not treated as a project, so memory, search, ` +
			"embeddings and the dreamer stay off here. Start Pi inside a project folder, or set " +
			"`allow_home_project: true` in the user-level magic-context.jsonc to give home sessions their own project.",
	);
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

export function registerConfiguredTodoLifecycle(
	pi: ExtensionAPI,
	options: {
		configured: boolean;
		overlay: boolean;
		readLastTodoState: (sessionId: string) => string | null | undefined;
	},
): TodoOverlayUpdater | undefined {
	if (!options.configured) return undefined;
	registerTodoStateLifecycle(pi, {
		readLastTodoState: options.readLastTodoState,
	});
	return options.overlay
		? registerTodoOverlay(pi, { readLastTodoState: options.readLastTodoState })
		: undefined;
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

const piUsageBoundLogSeen = new Set<string>();

function logPiUsageBoundOnce(
	sessionId: string,
	reading: number,
	absoluteWall: number,
	reason: "current reading" | "persisted floor",
): void {
	const key = `${sessionId}|${reason}`;
	if (piUsageBoundLogSeen.has(key)) return;
	piUsageBoundLogSeen.add(key);
	info(
		`message_end: session=${sessionId} bounded ${reason} ${reading} at trusted absolute wall ${absoluteWall}; pressure_proof_not_capacity`,
	);
}

function logPiUsageAboveWindowOnce(
	sessionId: string,
	reading: number,
	absoluteWall: number,
): void {
	const key = `${sessionId}|accepted above window`;
	if (piUsageBoundLogSeen.has(key)) return;
	piUsageBoundLogSeen.add(key);
	info(
		`message_end: session=${sessionId} provider usage ${reading} exceeds configured window ${absoluteWall}; counted as real pressure against the configured limit`,
	);
}

function resolvePiPressureContextLimit(args: {
	db: ContextDatabase;
	sessionId: string;
	piContextWindow: number;
	piContextWindowSource?: "observed" | "catalog";
	model?: { provider?: string; id?: string; maxTokens?: number };
	provenInputTokens?: number;
}): number {
	// Pi reports the model's context window directly (ctx.getContextUsage() /
	// ctx.model.contextWindow) — its own authoritative source. We no longer
	// consult models.dev for Pi. Sanity-bound the reported value so a transient
	// garbage window can't poison pressure (mirrors OpenCode's SDK sane bound).
	let detectedContextLimit: number | undefined;
	try {
		const modelKey =
			args.model?.provider && args.model.id
				? piModelRefToCanonical(`${args.model.provider}/${args.model.id}`)
				: undefined;
		const overflowState = getOverflowState(args.db, args.sessionId, modelKey);
		if (overflowState.detectedContextLimit > 0) {
			detectedContextLimit = overflowState.detectedContextLimit;
		}
	} catch (err) {
		warn("message_end: getOverflowState failed:", err);
	}
	return (
		resolvePiUsableContextLimit({
			rawContextWindow: args.piContextWindow,
			rawContextWindowSource: args.piContextWindowSource,
			model: args.model,
			detectedContextLimit,
			provenInputTokens: args.provenInputTokens,
		}) ?? 0
	);
}

export async function persistPiPressureFromMessageEnd(args: {
	db: ContextDatabase;
	sessionId: string;
	message: unknown;
	piContextWindow: number;
	piContextWindowSource?: "observed" | "catalog";
	piModel?: {
		provider?: string;
		id?: string;
		maxTokens?: number;
		contextWindow?: number;
	};
	piTokens?: number;
	/** `piTokens` is Pi's raw-branch estimate (see isPiLiveUsageRawBranchEstimate). */
	piTokensIsRawBranchEstimate?: boolean;
	notifyIssue?: (message: string) => unknown | Promise<unknown>;
}): Promise<void> {
	// Pi emits message_end before it appends the message to the branch, so the
	// branch read for the flag does not hold this message yet. A reply with
	// provider usage becomes the anchor of Pi's live figure once appended.
	if (piMessageAnchorsLiveUsage(args.message)) {
		recordPiLiveUsageClassification(args.sessionId, false);
	} else if (typeof args.piTokensIsRawBranchEstimate === "boolean") {
		recordPiLiveUsageClassification(
			args.sessionId,
			args.piTokensIsRawBranchEstimate,
		);
	}
	const { provider, model } = getPiMessageModel(args.message);
	const activeModel = args.piModel ?? { provider, id: model };
	const modelKey =
		activeModel.provider && activeModel.id
			? piModelRefToCanonical(`${activeModel.provider}/${activeModel.id}`)
			: undefined;
	const usage = extractAssistantUsage(args.message);
	const reportedGeometry = resolvePiWindowGeometry({
		rawContextWindow: args.piContextWindow,
		rawContextWindowSource: args.piContextWindowSource,
		model: activeModel,
	});
	const trustedAbsoluteWall =
		reportedGeometry && hasTrustedAbsoluteWall(reportedGeometry)
			? reportedGeometry.derivation.absoluteWall
			: undefined;
	const unboundedPressure = computePiPressure(usage, args.piContextWindow);
	const msg =
		args.message && typeof args.message === "object"
			? (args.message as { errorMessage?: unknown })
			: undefined;
	const messageHadOverflowError =
		typeof msg?.errorMessage === "string" &&
		detectOverflow(msg.errorMessage).isOverflow;
	const readingAboveTrustedWall =
		unboundedPressure !== null &&
		trustedAbsoluteWall !== undefined &&
		unboundedPressure.inputTokens > trustedAbsoluteWall;
	// Provider usage on a request the provider accepted is the real prompt
	// size, so it counts in full whatever its size. The trusted window is a
	// configured figure that can be smaller than what the model serves; a
	// reading past it is real overflow of the user's limit. Only after an
	// overflow error (no accepted request) is the reading clamped at the wall.
	const requestAccepted = !messageHadOverflowError;
	if (readingAboveTrustedWall && unboundedPressure && trustedAbsoluteWall) {
		if (requestAccepted) {
			logPiUsageAboveWindowOnce(
				args.sessionId,
				unboundedPressure.inputTokens,
				trustedAbsoluteWall,
			);
		} else {
			logPiUsageBoundOnce(
				args.sessionId,
				unboundedPressure.inputTokens,
				trustedAbsoluteWall,
				"current reading",
			);
		}
	}
	// Only a reading within the configured window proves capacity: one past it
	// is pressure, and recording it as proven would widen the configured window.
	const requestSucceeded = requestAccepted && !readingAboveTrustedWall;
	// A limit learned from an earlier overflow error is stale once the provider
	// accepts a larger request, whatever the configured window says.
	if (requestAccepted && unboundedPressure) {
		const rawOverflow = getOverflowState(args.db, args.sessionId);
		const detectedLimitMatchesModel =
			rawOverflow.detectedContextLimitModelKey === null ||
			(modelKey !== undefined &&
				rawOverflow.detectedContextLimitModelKey === modelKey);
		if (
			rawOverflow.detectedContextLimit > 0 &&
			detectedLimitMatchesModel &&
			unboundedPressure.inputTokens > rawOverflow.detectedContextLimit
		) {
			clearDetectedContextLimit(args.db, args.sessionId);
			info(
				`message_end: detected limit ${rawOverflow.detectedContextLimit} invalidated by a successful ${unboundedPressure.inputTokens}-token request; using Pi contextWindow`,
			);
		}
	}

	// The floor is proof about the model that served it; see pi-proven-floor.ts.
	// Resolved before the row is read, because an unkeyed floor is cleared here.
	const floorModelKey = piProvenFloorModelKey(activeModel);
	let observedSafeInputTokens = resolvePiProvenInputFloor({
		db: args.db,
		sessionId: args.sessionId,
		modelKey: floorModelKey,
	});
	const meta = getOrCreateSessionMeta(args.db, args.sessionId);
	const updates: Partial<{
		lastResponseTime: number;
		lastContextPercentage: number;
		lastInputTokens: number;
		lastUsageContextLimit: number;
		observedSafeInputTokens: number;
		cacheAlertSent: boolean;
	}> = {};
	// last_response_time is the idle clock for the provider cache: the
	// scheduler's TTL execute and the ttl_idle HARD fold both measure from it.
	// Usage or successful terminal completion proves a served response. Pi's
	// timestamp is the message start, so stamp at message_end, not at that start.
	// Pi also emits message_end for the user's own prompt (before that
	// prompt's context pass), for tool results, and for failed requests (a
	// quota error arrives as an assistant message with zero usage). Stamping
	// on those made a pass after a long idle look like it followed a fresh
	// response, so it deferred and queued drops never applied.
	const assistant =
		args.message && typeof args.message === "object"
			? (args.message as {
					role?: unknown;
					stopReason?: unknown;
					errorMessage?: unknown;
				})
			: undefined;
	const completion = {
		finish: assistant?.stopReason,
		error: assistant?.errorMessage,
	};
	if (
		assistant?.role === "assistant" &&
		!providerResponseFailed(completion) &&
		(unboundedPressure !== null || isSuccessfulProviderCompletion(completion))
	) {
		updates.lastResponseTime = Math.max(meta.lastResponseTime, Date.now());
	}

	if (
		trustedAbsoluteWall !== undefined &&
		observedSafeInputTokens > trustedAbsoluteWall
	) {
		logPiUsageBoundOnce(
			args.sessionId,
			observedSafeInputTokens,
			trustedAbsoluteWall,
			"persisted floor",
		);
		observedSafeInputTokens = 0;
		updates.observedSafeInputTokens = 0;
		updates.cacheAlertSent = false;
		updates.lastUsageContextLimit = reportedGeometry?.usableSoft ?? 0;
		if (meta.lastInputTokens > trustedAbsoluteWall) {
			updates.lastInputTokens = trustedAbsoluteWall;
			updates.lastContextPercentage =
				reportedGeometry && reportedGeometry.usableSoft > 0
					? (trustedAbsoluteWall / reportedGeometry.usableSoft) * 100
					: 0;
		}
	}

	const effectiveContextLimit = resolvePiPressureContextLimit({
		db: args.db,
		sessionId: args.sessionId,
		piContextWindow: args.piContextWindow,
		piContextWindowSource: args.piContextWindowSource,
		model: activeModel,
		provenInputTokens: observedSafeInputTokens,
	});
	const reportedContextLimit = reportedGeometry?.usableSoft ?? 0;
	const pressure = computePiPressure(
		usage,
		effectiveContextLimit,
		requestAccepted ? undefined : trustedAbsoluteWall,
	);

	// Sent only after the reading is stored below, so a slow notification
	// cannot hold the reading back from the next context pass.
	let cacheAlert: string | undefined;
	if (pressure) {
		notePiUsageReadingUsed(args.sessionId);
		const provenSafeInputTokens = requestSucceeded
			? Math.max(observedSafeInputTokens, pressure.inputTokens)
			: observedSafeInputTokens;
		const contextLimit = requestSucceeded
			? resolvePiPressureContextLimit({
					db: args.db,
					sessionId: args.sessionId,
					piContextWindow: args.piContextWindow,
					piContextWindowSource: args.piContextWindowSource,
					model: activeModel,
					provenInputTokens: provenSafeInputTokens,
				})
			: effectiveContextLimit;
		const percentage =
			contextLimit > 0 ? (pressure.inputTokens / contextLimit) * 100 : 0;
		if (
			requestSucceeded &&
			reportedContextLimit > 0 &&
			reportedContextLimit < provenSafeInputTokens &&
			!meta.cacheAlertSent
		) {
			updates.cacheAlertSent = true;
			const modelLabel =
				activeModel.provider && activeModel.id
					? `${activeModel.provider}/${activeModel.id}`
					: "the active model";
			cacheAlert = `⚠️ Magic Context: Pi reports a context limit of ${formatTokens(reportedContextLimit)} tokens for ${modelLabel}, but this session has sent ${formatTokens(provenSafeInputTokens)} tokens successfully. Magic Context will keep using the larger proven value for its pressure math. If Pi's model metadata is wrong for your provider, set contextWindow for that model in Pi's model configuration.`;
		}
		updates.lastContextPercentage = percentage;
		updates.lastInputTokens = pressure.inputTokens;
		updates.lastUsageContextLimit = contextLimit;
		if (requestSucceeded) {
			updates.observedSafeInputTokens = provenSafeInputTokens;
		}
	} else if (
		usage === null &&
		typeof args.piTokens === "number" &&
		(trustedAbsoluteWall === undefined || args.piTokens <= trustedAbsoluteWall)
	) {
		// Non-assistant message_end events (tool results, user messages) carry
		// no provider usage, so Pi's own figure stands in. Normally it is the
		// last provider usage plus an estimate of the messages added since. After
		// a retried request, though, Pi re-estimates the whole raw, unreduced
		// branch: that figure is blind to the reductions in the served request,
		// so at any size it never replaces the last provider reading.
		if (args.piTokensIsRawBranchEstimate === true) {
			noteRawBranchEstimateSetAside(
				args.sessionId,
				args.piTokens,
				"message_end estimate",
			);
		} else {
			notePiUsageReadingUsed(args.sessionId);
			updates.lastInputTokens = args.piTokens;
			if (effectiveContextLimit > 0) {
				updates.lastContextPercentage =
					(args.piTokens / effectiveContextLimit) * 100;
				updates.lastUsageContextLimit = effectiveContextLimit;
			}
		}
	}

	updateSessionMeta(args.db, args.sessionId, updates);
	if (
		floorModelKey !== undefined &&
		typeof updates.observedSafeInputTokens === "number" &&
		updates.observedSafeInputTokens > 0
	) {
		const recorded = readPiProvenFloorRecord(args.db, args.sessionId);
		if (
			recorded?.modelKey !== floorModelKey ||
			recorded.tokens !== updates.observedSafeInputTokens
		) {
			recordPiProvenFloorModel(
				args.db,
				args.sessionId,
				floorModelKey,
				updates.observedSafeInputTokens,
			);
		}
	}
	if (cacheAlert !== undefined) {
		await args.notifyIssue?.(cacheAlert);
	}
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

// Model-chain reports already made in this process. Kept on globalThis so an
// extension reload in the same Pi process does not repeat them.
const PI_MODEL_CHAIN_REPORTS = Symbol.for(
	"magic-context.pi.model-chain-reports",
);
function piModelChainReports(): {
	notified: Set<string>;
	logged: Set<string>;
} {
	const globals = globalThis as Record<symbol, unknown>;
	const existing = globals[PI_MODEL_CHAIN_REPORTS] as
		| { notified: Set<string>; logged: Set<string> }
		| undefined;
	if (existing) return existing;
	const created = { notified: new Set<string>(), logged: new Set<string>() };
	globals[PI_MODEL_CHAIN_REPORTS] = created;
	return created;
}
const notifiedPiModelChainKeys = piModelChainReports().notified;
const loggedPiModelChainLines = piModelChainReports().logged;

/** Forget the model-chain reports made in this process (tests only). */
export function resetPiModelChainReportsForTest(): void {
	notifiedPiModelChainKeys.clear();
	loggedPiModelChainLines.clear();
}

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

export function resolveHistorianFromConfig(
	config: MagicContextConfig,
	harness: PiHarnessKind = PI_HARNESS_KIND,
	modelRegistry?: { find(provider: string, modelId: string): unknown },
): PiHistorianOptions | undefined {
	// Defensive: schema declares `historian` required with default {}, but the
	// runtime config can come from a malformed JSONC merge that drops the
	// field. Fall back to undefined-safe access so plugin load never crashes.
	const historian = config.historian as HistorianConfig | undefined;
	if (historian?.disable === true) return undefined;
	const resolved = resolveHistorianModel(config, harness);
	const validated =
		modelRegistry && resolved.primary
			? validatePiDreamerModels(
					[
						{
							task: "classify-memories",
							schedule: "",
							timeoutMinutes: 20,
							model: resolved.primary,
							fallbackModels: resolved.fallbacks,
						},
					],
					modelRegistry,
					harness,
				)[0]
			: undefined;
	const primary = validated
		? typeof validated.model === "string"
			? { model: validated.model }
			: validated.model
		: resolved.primary;
	const model = primary?.model;
	if (!model) return undefined;

	// The historian chunk budget is anchored to the HISTORIAN model because
	// it bounds one summarizer call. The trigger budget is intentionally NOT
	// derived at startup: Pi resolves it per context pass from the live main
	// session model + effective execute threshold to match OpenCode.
	const historianContextLimit = resolveHistorianContextLimit(model);
	const historianChunkTokens = deriveHistorianChunkTokens(
		historianContextLimit,
	);

	const fallbackModels = validated?.fallbackModels ?? resolved.fallbacks;

	return {
		runner: new PiSubagentRunner(),
		model,
		fallbackModels,
		historianChunkTokens,
		historianContextLimit: resolveKnownHistorianContextLimit(model),
		timeoutMs: config.historian_timeout_ms,
		temperature: historian?.temperature,
		maxOutputTokens: historian?.maxTokens,
		// `historian.two_pass` runs an editor pass after a successful
		// first pass to clean low-signal U: lines and cross-compartment
		// duplicates. Mirrors OpenCode's config flag — defaults to false
		// on the schema side because the editor pass adds a second
		// historian round-trip's latency and token cost. Enable for
		// long sessions where chunk dedupe matters more than speed.
		twoPass: historian?.two_pass === true,
		expandTools: historian?.expand_tools,
		// Pi and OMP: explicit thinking level for historian subagent invocations.
		// When set, passed as --thinking <level> to Pi subprocess.
		// Required for providers like GitHub Copilot that apply bad defaults.
		thinkingLevel: primary?.qualifier,
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
 * system-prompt injection and dreamer scheduling.
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
	registerPiSubagentHostTools(pi, PI_HARNESS_KIND);
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
	setHomeProjectPermission(bootConfig.config.allow_home_project);
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

	// The handle is shared by same-process sessions and /reload. Close it only
	// when Pi actually exits, after extension shutdown has released its workers.
	if (!databaseExitHookRegistered) {
		process.once("exit", closeDatabase);
		databaseExitHookRegistered = true;
	}
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
	const unavailableReason = (): FailClosedReason =>
		describeStorageUnavailability(
			openFailureCause ??
				`storage unavailable at ${dbPath} (cache schema newer than this binary, or open failed)`,
		);

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
	hostPi: ExtensionAPI,
	database: ContextDatabase,
	dbPath: string,
): Promise<void> {
	// One checkout-claim gate per runtime: Magic Context must not write for a
	// session whose agent another machine holds. Session start and every context
	// pass check it explicitly (session start tells the user, the context pass
	// refuses the turn); every other event handler registered through `pi` below
	// skips such a session. Verdicts are cached per session, so a pass pays for
	// at most one check per cache period. The connection file is resolved per
	// check, so the configured one applies once the config below has loaded.
	let subcConnectionFile: string | undefined;
	const checkoutClaim = createSubcCheckoutClaimGate(
		"pi",
		() => subcConnectionFile ?? getDefaultSubcConnectionFile(),
	);
	const pi = gatePiEventsByCheckoutClaim(hostPi, () => checkoutClaim);
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
					const api = await loadDefaultPiSessionApi();
					const paths = new Map<string, string>();
					for (const session of (await api.listSessions()) as Array<{
						id?: unknown;
						path?: unknown;
					}>) {
						if (
							typeof session.id === "string" &&
							typeof session.path === "string"
						)
							paths.set(session.id, session.path);
					}
					await backfillPiSessionActivity(database, PI_HARNESS_KIND, paths);
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
	activePiRuntimes.add(dreamerRegistrationOwner);
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
			`project=${projectIdentity || "(none)"} | dir=${projectDir}`,
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
	if (isUsableProjectIdentity(projectIdentity)) {
		info(`registered embedding config for project ${projectIdentity}`);
	} else {
		logNoProjectIdentityOnce(projectDir);
	}

	type ResolvedPiProjectDeps = {
		projectDir: string;
		projectIdentity: string;
		config: MagicContextConfig;
		historianConfig: PiHistorianOptions | undefined;
		autoSearchConfig: PiAutoSearchHandlerOptions;
		contextOptions: PiContextHandlerOptions;
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
	const liveReaders = new Map<string, LiveConfigReader<MagicContextConfig>>();
	function liveReaderFor(dir: string, boot: MagicContextConfig) {
		let reader = liveReaders.get(dir);
		if (!reader) {
			reader = new LiveConfigReader(
				dir,
				boot,
				() => {
					const loaded = loadPiConfigDetailed({ cwd: dir }, false);
					if (
						[
							"project-file-parse-error",
							"project-file-io-error",
							"schema-recovery",
						].includes(loaded.loadOutcome)
					) {
						throw new Error(
							`invalid configuration: ${loaded.warnings.join("; ")}`,
						);
					}
					return loaded.config;
				},
				warn,
				changedLiveKeys,
			);
			reader.poll();
			liveReaders.set(dir, reader);
		}
		return reader;
	}

	const buildContextOptions = (
		cfg: MagicContextConfig,
		hist: PiHistorianOptions | undefined,
		auto: PiAutoSearchHandlerOptions,
	): PiContextHandlerOptions => ({
		db: database,
		cacheTtlConfig: cfg.cache_ttl,
		cacheTtlConfigured: cfg.cacheTtlConfigured,
		protectedTools: cfg.protected_tools,
		protectedTokens: cfg.protected_tokens,
		protectedTokenTierOverrides: getProtectedTokensTierOverrides(cfg) ?? {},
		protectedTags: cfg.protected_tags ?? 20,
		heuristics: {
			caveman: cfg.caveman_text_compression
				? {
						enabled: cfg.caveman_text_compression.enabled,
						minChars: cfg.caveman_text_compression.min_chars,
						// `language` is user-level only; a project config cannot set it.
						wordRules: cavemanWordRulesForLanguage(cfg.language),
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
		todowriteEnabled: cfg.todowrite.enabled,
		compactionOff,
		allowHomeProject: cfg.allow_home_project,
		// Automatic history embedding: silent (no timeline messages) and not
		// gated on `memory.enabled`; only the embedding provider decides.
		maybeAutoEmbedSession: (sessionId, dir, identity) => {
			maybeAutoEmbedPiSession(
				{
					db: database,
					projectDir: dir,
					projectIdentity: identity,
				},
				sessionId,
				dir,
				identity,
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
		liveReaderFor(dir, cfg);
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

	let activeModelRegistry:
		| { find(provider: string, modelId: string): unknown }
		| undefined;

	// Config generation last checked per project directory.
	const modelChainsCheckedGeneration = new Map<string, number>();
	/**
	 * Validate the historian and dreamer chains against Pi's model registry:
	 * log the historian chain that will actually run, and notify the session
	 * once per process for each set of chains left empty (see
	 * model-chain-health.ts). Runs at session start and after a config reload.
	 */
	function reportPiModelChains(
		ctx: {
			modelRegistry?: PiModelRegistryLike;
			hasUI?: boolean;
			ui?: { notify?: (message: string, level?: "warning") => unknown };
		},
		project: ResolvedPiProjectDeps,
	): void {
		const registry = ctx.modelRegistry;
		if (!registry) return;
		try {
			const live = liveReaderFor(project.projectDir, project.config).poll();
			modelChainsCheckedGeneration.set(project.projectDir, live.generation);
			const checked = historianRunConfig(project.config, live.effective);
			const historian = resolveHistorianFromConfig(
				checked,
				PI_HARNESS_KIND,
				registry,
			);
			const empty = findEmptyPiModelChains({
				config: checked,
				registry,
				harness: PI_HARNESS_KIND,
			});
			const emptyHistorian = empty.find((chain) => chain.owner === "historian");
			const historianLine = historian
				? `registered historian trigger (model=${historian.model}${historian.fallbackModels?.length ? `, fallbacks=${historian.fallbackModels.join(",")}` : ""}, executeThreshold=${formatExecuteThresholdForLog(historian.executeThresholdPercentage)})`
				: emptyHistorian
					? `registered historian trigger: DISABLED (no configured model is registered in Pi: ${formatEmptyPiModelChain(emptyHistorian)})`
					: undefined;
			if (historianLine && !loggedPiModelChainLines.has(historianLine)) {
				loggedPiModelChainLines.add(historianLine);
				info(historianLine);
			}
			if (empty.length === 0) return;
			const key = emptyPiModelChainsKey(empty);
			if (notifiedPiModelChainKeys.has(key)) return;
			const notice = formatEmptyPiModelChainsNotice(empty);
			if (!loggedPiModelChainLines.has(notice)) {
				loggedPiModelChainLines.add(notice);
				warn(notice);
			}
			if (ctx.hasUI && typeof ctx.ui?.notify === "function") {
				notifiedPiModelChainKeys.add(key);
				ctx.ui.notify(notice, "warning");
			}
		} catch (err) {
			warn("model chain check failed:", err);
		}
	}
	function resolveContextOptionsForProject(
		dir: string,
	): PiContextHandlerOptions {
		const project = resolveProjectDepsForDir(dir);
		const sampled = historianRunConfig(
			project.config,
			liveReaderFor(dir, project.config).poll().effective,
		);
		const historian = resolveHistorianFromConfig(
			sampled,
			PI_HARNESS_KIND,
			activeModelRegistry,
		);
		return {
			...project.contextOptions,
			historian,
			cacheTtlConfig: sampled.cache_ttl,
			cacheTtlConfigured: sampled.cacheTtlConfigured,
		};
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
	subcConnectionFile = config.subc?.connection_file;

	function syncDreamerProjectRegistration(
		current: ResolvedPiProjectDeps,
		modelRegistry?: { find(provider: string, modelId: string): unknown },
	): void {
		if (sessionShuttingDown) return;
		// No identity means this directory is not a project (for example the home
		// directory). Nothing is registered for it, so there is nothing to track.
		if (!isUsableProjectIdentity(current.projectIdentity)) {
			logNoProjectIdentityOnce(current.projectDir);
			return;
		}
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
			modelRegistry,
			sampleDreamRun: () => {
				const fresh = liveReaderFor(current.projectDir, current.config).poll()
					.effective;
				const sampled = dreamerRunConfig(current.config, fresh);
				return {
					dreamerConfig: sampled.dreamer,
					mural: sampled.mural,
					gitCommitIndexing: sampled.memory.git_commit_indexing,
				};
			},
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
	registerPiDroppedInputGuard(pi);
	const todowriteEnabled = bootProjectDeps.config.todowrite.enabled;
	const todowriteOverlayEnabled =
		todowriteEnabled && bootProjectDeps.config.todowrite.overlay;

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
		expandTools: config.historian?.expand_tools,
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
		// entry still uses memoryToolEnabled to keep ctx_memory off read-only
		// Dreamer tasks, a separate security concern.)
		memoryToolEnabled: true,
		protectedTags: config.protected_tags ?? 20,
		protectedTools: config.protected_tools,
		resolveProtectedTools: (ctx) =>
			resolveCurrentProjectDeps(ctx).config.protected_tools,
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
		bindStaleBuildNotice(ctx, import.meta.url);
		// Pi emits session_start for new, resumed, and reloaded sessions. Re-read
		// this cwd's config before setting the active tools so a memory.enabled
		// change takes effect at the next session without restarting Pi.
		projectDepsByDir.delete(ctx.cwd);
		const current = resolveCurrentProjectDeps(ctx);
		activeModelRegistry = ctx.modelRegistry;
		reportPiModelChains(ctx, current);
		if (ctx.hasUI) syncDreamerProjectRegistration(current, ctx.modelRegistry);
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
		// Session start is Magic Context's first write for a session in this
		// process. Skip every write below when another machine holds the
		// session's agent; the first turn is then refused by the context handler.
		if (sessionId) {
			const claimRefusal = await checkoutClaim.refusal(sessionId, ctx.cwd);
			if (claimRefusal) {
				if (ctx.hasUI) ctx.ui.notify(claimRefusal.message, "error");
				return;
			}
		}
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

	pi.on("agent_start", (_event, ctx) => {
		setEmbeddingSessionBusy(ctx.sessionManager.getSessionId(), true);
		// A config reload adopted since the last check gets the same report.
		const current = resolveCurrentProjectDeps(ctx);
		const generation = liveReaderFor(current.projectDir, current.config).poll()
			.generation;
		if (modelChainsCheckedGeneration.get(current.projectDir) !== generation) {
			reportPiModelChains(ctx, current);
		}
	});
	const readLastTodoState = (sessionId: string) =>
		getOrCreateSessionMeta(db, sessionId).lastTodoState;
	const todoOverlay = registerConfiguredTodoLifecycle(pi, {
		configured: todowriteEnabled,
		overlay: bootProjectDeps.config.todowrite.overlay,
		readLastTodoState,
	});
	info(
		todowriteOverlayEnabled
			? "registered todowrite overlay"
			: "registered todowrite overlay: DISABLED (todowrite.enabled=false or todowrite.overlay=false)",
	);

	// Register the per-LLM-call transform pipeline. Tags eligible message
	// parts via the shared Tagger and applies queued drops from
	// `pending_ops` so /ctx-flush and ctx_reduce work against Pi sessions.
	registerPiContextHandler(pi, bootProjectDeps.contextOptions, {
		checkoutClaim,
	});
	// Pi's model registry reaches the extension only with the first session
	// context, so the chain the historian will actually use is logged by
	// reportPiModelChains at session start. Logging the configured model here
	// would name a model that registry validation may still drop.
	if (!bootProjectDeps.historianConfig) {
		info(
			"registered historian trigger: DISABLED (configure the active harness's historian model in magic-context.jsonc)",
		);
	}
	info(
		bootProjectDeps.autoSearchConfig.enabled
			? `registered auto-search hint (threshold=${bootProjectDeps.autoSearchConfig.scoreThreshold}, minChars=${bootProjectDeps.autoSearchConfig.minPromptChars})`
			: "registered auto-search hint: DISABLED (memory.auto_search.enabled=false)",
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
		compactionEnabled: isCompactionEnabled(bootProjectDeps.config),
		resolveStatusDeps: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			const live = liveReaderFor(current.projectDir, current.config);
			const fresh = live.poll().effective;
			const failure = live.lastFailure();
			return {
				configGeneration: live.current().generation,
				configAdoptedAt: live.current().adoptedAt,
				configReloadFailure: failure
					? { path: failure.path, message: failure.message }
					: undefined,
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
				modelChainWarning: (() => {
					const registry = activeModelRegistry;
					if (!registry) return undefined;
					// Only chains that would run: unscheduled dreamer tasks are left out.
					const empty = findEmptyPiModelChains({
						config: current.config,
						registry,
						harness: PI_HARNESS_KIND,
					});
					if (empty.length === 0) return undefined;
					const parts = empty.map(formatEmptyPiModelChain);
					if (empty.some((chain) => chain.owner === "historian")) {
						const sessionId = resolveSessionId(ctx);
						const latch = sessionId
							? describeInertEmergencyDrainLatch(
									loadProtectedTailMeta(db, sessionId).emergencyDrainActive,
								)
							: undefined;
						if (latch) parts.push(latch);
					}
					return `Pi model chain empty (no model found): ${parts.join("; ")}`;
				})(),
				activeProfile: current.config.profile,
				cacheTtlConfig: fresh.cache_ttl,
				cacheTtlConfigured: fresh.cacheTtlConfigured,
				configParseFailures: current.configParseFailures,
				hasDeprecatedProtectedTags: current.hasDeprecatedProtectedTags,
				compactionEnabled: isCompactionEnabled(current.config),
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
			const fresh = historianRunConfig(
				current.config,
				liveReaderFor(current.projectDir, current.config).poll().effective,
			);
			const historian = resolveHistorianFromConfig(
				fresh,
				PI_HARNESS_KIND,
				activeModelRegistry,
			);
			return {
				db,
				runner: recompRunner,
				historianModel: historian?.model,
				historianChunkTokens:
					historian?.historianChunkTokens ??
					deriveHistorianChunkTokens(
						resolveHistorianContextLimit(historian?.model),
					),
				historianFallbacks: historian?.fallbackModels,
				historianTimeoutMs:
					historian?.timeoutMs ?? current.config.historian_timeout_ms,
				historianThinkingLevel: historian?.thinkingLevel,
				language: current.config.language,
				memoryEnabled: current.config.memory.enabled,
				autoPromote: fresh.memory.auto_promote,
				compactionOff,
			};
		},
	});
	info("registered /ctx-recomp");

	registerCtxWrapupCommand(pi, {
		shutdownSignal: commandLifecycleController.signal,
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
			const fresh = historianRunConfig(
				current.config,
				liveReaderFor(current.projectDir, current.config).poll().effective,
			);
			const historian = resolveHistorianFromConfig(
				fresh,
				PI_HARNESS_KIND,
				activeModelRegistry,
			);
			return {
				db,
				runner: wrapupRunner,
				historianModel: historian?.model,
				historianChunkTokens:
					historian?.historianChunkTokens ??
					deriveHistorianChunkTokens(
						resolveHistorianContextLimit(historian?.model),
					),
				historianFallbacks: historian?.fallbackModels,
				historianTimeoutMs:
					historian?.timeoutMs ?? current.config.historian_timeout_ms,
				historianThinkingLevel: historian?.thinkingLevel,
				language: current.config.language,
				memoryEnabled: current.config.memory.enabled,
				autoPromote: fresh.memory.auto_promote,
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
		ensureRegistered: (ctx) => {
			if ((ctx as typeof ctx & { hasUI?: boolean }).hasUI)
				syncDreamerProjectRegistration(
					resolveCurrentProjectDeps(ctx),
					ctx.modelRegistry,
				);
		},
		registrationOwner: dreamerRegistrationOwner,
	});
	info("registered /ctx-dream");

	registerCtxEmbedCommand(pi, {
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
	});
	info("registered /ctx-embed");

	// Register Pi project with the singleton dreamer timer. When dreamer is
	// disabled in config (default) this is a no-op. When enabled, the timer
	// schedules dream runs based on config.dreamer.schedule and uses
	// PiSubagentRunner to spawn child sessions for each task.
	const dreamerConfig = bootProjectDeps.dreamerConfig;
	if (dreamerConfig) {
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
				activeModelRegistry = ctx.modelRegistry;
				if (ctx.hasUI)
					syncDreamerProjectRegistration(
						effectiveProjectDeps,
						ctx.modelRegistry,
					);
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
	// Headless Pi exits after agent_end. The context handler leaves eligible
	// history queued rather than launching a child that would outlive Pi.
	pi.on("agent_end", (event, ctx) => {
		setEmbeddingSessionBusy(ctx.sessionManager.getSessionId(), false);
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
		// Print mode never receives session_shutdown. Flush the buffered log now
		// so its 500 ms logger timer does not keep a completed one-shot Pi alive.
		if (!ctx.hasUI) flushLogger();
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

	// In normal mode MC owns compaction and cancels Pi's native hook. Pi's
	// ExtensionRunner checks session-before handlers in registration order, ignores
	// undefined, and short-circuits on the first truthy `cancel`; listener order
	// therefore cannot undo this veto. In compaction-off mode the same hook must
	// return nothing because native Pi compaction is the selected context manager.
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
			const leafId = ctx.sessionManager.getLeafId();
			const leaf = leafId ? ctx.sessionManager.getEntry(leafId) : undefined;
			// Pi normally appends after this event. Also accept runtimes that have
			// already appended this exact reply and expose its explicit parent.
			const parentId =
				leaf?.type === "message" && leaf.message === event.message
					? leaf.parentId
					: leafId;
			notePiLkgProviderUsage(
				ctx.sessionManager.getSessionId(),
				parentId,
				event.message,
			);
		} catch {
			/* Usage without a verifiable request boundary is not a replay basis. */
		}
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
				timestamp?: number;
			};
			observePiMessageActivity(db, sessionId, endedMsg?.timestamp);
			schedulePiAssistantIndexOnMessageEnd(db, sessionId, event.message, {
				readBranch: () => {
					const branch = (
						ctx.sessionManager as { getBranch?: () => unknown[] } | undefined
					)?.getBranch?.();
					return Array.isArray(branch) ? branch : undefined;
				},
			});
			persistPiMessageEndModelMeta({
				db,
				sessionId,
				message: event.message,
				...(() => {
					const project = resolveCurrentProjectDeps(ctx);
					const fresh = liveReaderFor(project.projectDir, project.config).poll()
						.effective;
					return {
						cacheTtlConfig: fresh.cache_ttl,
						cacheTtlConfigured: fresh.cacheTtlConfigured,
					};
				})(),
			});
			// Compute pressure with OpenCode-equivalent semantics: pull
			// the assistant's `usage` field, normalize inclusive OpenAI
			// cached-input shapes against `totalTokens - output`, and reject
			// impossible prompt readings above the observed hard wall. The
			// accepted prompt count is divided by the effective context limit.
			// The window comes from Pi's own
			// runtime — `getContextUsage().contextWindow`, falling back to
			// `ctx.model.contextWindow` if usage hasn't populated — NOT
			// models.dev. `session_meta.detected_context_limit` still overrides
			// it (in persistPiPressureFromMessageEnd) so post-overflow pressure
			// reflects the real, lower limit. See `pi-pressure.ts` for rationale.
			const piUsage = ctx.getContextUsage?.();
			const hasObservedContextWindow =
				piUsage &&
				typeof piUsage.contextWindow === "number" &&
				piUsage.contextWindow > 0;
			const piContextWindow = hasObservedContextWindow
				? piUsage.contextWindow
				: (ctx.model?.contextWindow ?? 0);
			await persistPiPressureFromMessageEnd({
				db,
				sessionId,
				message: event.message,
				piContextWindow,
				// Both Pi hosts report the configured model window here, not a provider-observed limit.
				piContextWindowSource: "catalog",
				piModel: ctx.model,
				piTokens:
					piUsage && typeof piUsage.tokens === "number"
						? piUsage.tokens
						: undefined,
				piTokensIsRawBranchEstimate: isPiContextUsageRawBranchEstimate(
					ctx.sessionManager,
				),
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
	// Other sessions and /reload share the SQLite handle. The process exit
	// hook closes it after every extension has finished shutdown.
	pi.on("session_shutdown", async (_event, ctx) => {
		setEmbeddingSessionBusy(ctx.sessionManager.getSessionId(), false);
		sessionShuttingDown = true;
		commandLifecycleController.abort();
		stopStatusDialogRefresh();
		// Bounded drain of in-flight historian / dreamer runs that were
		// kicked off by recent turns. We moved the drain here from
		// `agent_end` because Pi awaits agent_end handlers and was
		// stalling the UI loader on every turn that triggered historian.
		// session_shutdown only fires when the user is actually leaving
		// the session, so a brief wait is acceptable — and lets the
		// JSONL session state reach a consistent compartment boundary
		// before that session's cleanup completes.
		//
		// A five-second cap protects interactive shutdown from a hung child.
		// Headless runs do not launch background maintenance.
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
			abortInFlightHistorians(sessionId);
			abortInFlightRecomps(sessionId);
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
			// Keep the cancellation idempotent if the drain timed out.
			abortInFlightRecomps(sessionId);
		}
		abortInFlightDreamers(dreamerRegistrationOwner);
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
		activePiRuntimes.delete(dreamerRegistrationOwner);
		if (activePiRuntimes.size === 0) unregisterPiProjectEmbeddings(db);
	});

	// Pi has no `session_deleted` event; a switch to another session within
	// the same process is the moment to drain caches keyed by the OUTGOING
	// session id, or every swap in a long-running process leaks one entry per
	// cache. Cleanup mirrors OpenCode's `session.deleted` handler in
	// `event-handler.ts`, minus the durable state (see below).
	//
	// `session_before_switch` only announces a switch: another extension can
	// cancel it and opening the target can still fail, leaving the user in the
	// current session. Clearing there would drop that session's pending refresh
	// signals and warm caches. So it only records the outgoing id, and the
	// drain runs once the switch has happened:
	//   - stock Pi tears the outgoing runtime down with `session_shutdown`
	//     (handled above);
	//   - OMP keeps the runtime and emits `session_switch` instead.
	//
	// Only the in-memory per-session maps are cleared. The durable DB m[0]
	// cache stays: a switch is reversible (the user can switch back), unlike
	// OpenCode's session.deleted. It is bounded (one session_meta row per
	// session) and self-invalidates via epoch/version/docs-hash checks in
	// mustMaterializePi, so keeping it lets a switch-back reuse the cached
	// prefix instead of forcing a full m[0] re-materialization (an avoidable
	// prompt-cache bust).
	let switchOutgoingSessionId: string | undefined;
	const readSessionId = (ctx: unknown): string | undefined => {
		const sm = (
			ctx as {
				sessionManager?: { getSessionId?: () => string | undefined };
			}
		).sessionManager;
		const id =
			typeof sm?.getSessionId === "function" ? sm.getSessionId() : undefined;
		return typeof id === "string" && id.length > 0 ? id : undefined;
	};
	pi.on("session_before_switch", (_event, ctx) => {
		try {
			switchOutgoingSessionId = readSessionId(ctx);
		} catch {
			// best-effort — Pi proceeds with the switch regardless
		}
	});
	// `session_switch` is OMP-only and absent from stock Pi's typed event map.
	(
		pi.on as (
			event: string,
			handler: (event: unknown, ctx: unknown) => void,
		) => void
	)("session_switch", (_event, ctx) => {
		const outgoingSessionId = switchOutgoingSessionId;
		switchOutgoingSessionId = undefined;
		try {
			if (!outgoingSessionId || outgoingSessionId === readSessionId(ctx))
				return;
			clearPiSystemPromptSession(outgoingSessionId);
			promptSurfaceGuidanceEpochs.clear(outgoingSessionId);
			clearContextHandlerSession(outgoingSessionId);
		} catch {
			// best-effort cleanup
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
