import type { ProtectedTokensTierOverrides } from "../../config/project-security";
import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage";
import {
    resolveProjectIdentityForSession,
    takeDubiousOwnershipProjectIdentityWarning,
} from "../../features/magic-context/memory/project-identity";
import {
    type MessageReconciliationSource,
    scheduleReconciliation,
} from "../../features/magic-context/message-index-async";
import { isPrefixBoundThinkingModel } from "../../features/magic-context/overflow-detection";
import { getProtectionWindowForSession } from "../../features/magic-context/protection-window";
import type { Scheduler } from "../../features/magic-context/scheduler";
import { computeHardCacheExpired } from "../../features/magic-context/scheduler";
import { resolveSessionCacheTtl } from "../../features/magic-context/session-cache-ttl";
import { sessionDecisionCalibration } from "../../features/magic-context/session-decision-calibration";
import {
    hasRecordedSessionProjectIdentity,
    recordSessionProjectIdentity,
} from "../../features/magic-context/session-project-storage";
import {
    type ContextDatabase,
    deriveTagLoadFloor,
    getActiveTagsBySession,
    getActiveTagTokenTotalsByMessage,
    getDroppedTagsByNumbers,
    getMaxDroppedTagNumber,
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    casChannel2NudgeState,
    clearDetectedContextLimit,
    clearEmergencyDropSample,
    clearEmergencyRecovery,
    clearHistorianFailureState,
    clearPersistedReasoningWatermark,
    clearThinkingBindingRecoveryIf,
    getChannel1NudgeState,
    getChannel2NudgeState,
    getEmergencyInputSample,
    getHistorianFailureState,
    getLastNudgeUndropped,
    getOverflowState,
    getPersistedCompactionMarkerState,
    loadTransformPassStateSnapshot,
    recordOverflowDetected,
    resetProtectedTailNoEligibleHead,
    resolveEpochFloorForPass,
} from "../../features/magic-context/storage-meta-persisted";
import type { CoordinateGeneration } from "../../features/magic-context/store-generation-rebase";
import {
    readCoordinateGeneration,
    rebaseSessionCoordinatesAsync,
} from "../../features/magic-context/store-generation-rebase";
import type { Tagger } from "../../features/magic-context/tagger";
import { observeTemporalDecisions } from "../../features/magic-context/temporal-decisions";
import {
    clearOpenCodePendingTransformDecision,
    normalizeMaterializeReason,
    recordPendingTransformDecision,
} from "../../features/magic-context/transform-decision-log";
import type { ContextUsage } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { getErrorMessage } from "../../shared/error-message";
import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import { sessionLog } from "../../shared/logger";
import type { ModelInput } from "../../shared/model-resolution";
import { getSdkContextLimit } from "../../shared/models-dev-cache";
import type { PromptSurfaceConfig } from "../../shared/prompt-surface";
import type { PromptSurfaceRuntime } from "../../shared/prompt-surface-runtime";
import { withoutSqliteTransformPass } from "../../shared/sqlite";
import { canConsumeDeferredOnThisPass } from "./cache-busting-signals";
import type { CavemanWordRules } from "./caveman";
import { replayCavemanCompression } from "./caveman-cleanup";
import { commitCompactionModeRecord, reconcileCompactionMode } from "./compaction-off-transition";
import { getActiveCompartmentRun, startCompartmentAgent } from "./compartment-runner";
import {
    buildTriggerInMemoryTail,
    checkCompartmentTrigger,
    getProactiveCompartmentTriggerPercentage,
} from "./compartment-trigger";
import {
    type CtxReduceAvailabilityVerdict,
    primeCtxReduceSpawnPermission,
    resolveCtxReduceAvailabilityFromMessages,
    resolveTodowriteAvailabilityFromMessages,
    spawnAgentFromMessages,
    type ToolAvailabilityVerdict,
} from "./ctx-reduce-availability";
import {
    decideChannel1,
    evaluateChannel2,
    formatChannel1Evaluation,
    formatChannel2Evaluation,
} from "./ctx-reduce-nudge";
import { DegradedPassRefusalError, degradedPassError } from "./degraded-pass-refusal";
import { deriveTriggerBudget } from "./derive-budgets";
import { contextRefusalError, EmergencyFailClosedError } from "./emergency-fail-closed";
import {
    escalationBands,
    historyBudgetPolicyIdentity,
    resolveContextWindowGeometry,
    resolveExecuteThreshold,
    resolveExecuteThresholdDetail,
    resolveModelKey,
    resolveTrustedContextLimit,
} from "./event-resolvers";
import {
    createFinalWireUsageTracker,
    describeFinalWireTail,
    estimateFinalWireInputTokens,
    estimateMessageTokens,
} from "./final-wire-token-estimate";
import type { LiveModelBySession } from "./hook-handlers";
import {
    capturePrefixTrimSourceOrder,
    findHostCompactionWindow,
    type HostCompactionWindow,
    mustMaterialize,
    type PreparedCompartmentInjection,
    prepareCompartmentInjection,
    selectHiddenMessagesAtCompactionSeam,
} from "./inject-compartments";
import { saveLkgSlotToDb } from "./lkg-persist";
import { captureLkgSlot, createLkgEntryProjector, resolveLkgModelKeys } from "./lkg-replay";
import { recordServedCapture } from "./lkg-served-marker";
import { beginLkgPass, dropSlot, getInMemorySlot } from "./lkg-slot";
import { onNoteTrigger } from "./note-nudger";
import {
    createPassOutcome,
    degradationChangesRequest,
    type PassDegradationKind,
    type PassDegradationSite,
} from "./pass-outcome";
import {
    createDefaultBoundarySnapshotForTests,
    hasRunnableCompartmentWindow,
    type ProtectedTailBoundarySnapshot,
    RECOVERY_NO_HEAD_LIMIT,
    recordHighPressureNoEligibleHead,
    resolveOpenCodeProtectedTailBoundary,
} from "./protected-tail-boundary";
import { readRawSessionMessages } from "./read-session-chunk";
import { findLastAssistantModelFromOpenCodeDb } from "./read-session-db";
import { extractInMemoryMessageViews } from "./read-session-raw";
import { createRustModeTransform, type RustModeModuleClient } from "./rust-mode-transform";
import { sendStatusNotification } from "./send-session-notification";
import { isAnthropicFamilyRoute, modelAcceptsEmptyContent } from "./sentinel";
import {
    replayClearedReasoning,
    replayStrippedInlineThinking,
    snapshotTrailingBlankSourceDecisions,
    stripClearedReasoning,
} from "./strip-content";
import { collectTemporalCandidates, injectTemporalMarkers } from "./temporal-awareness";
import { readServedTemporalDecisions } from "./temporal-served-projection";
import { createPreAdoptionToolSweepResolver, useScopedToolSweep } from "./tool-sweep-policy";
import { historianJoinFailClosedMessage, runCompartmentPhase } from "./transform-compartment-phase";
import {
    contextUsagePassSnapshot,
    loadContextUsage,
    resolveSchedulerDecision,
    resolveUnknownUsageFromWireEstimate,
} from "./transform-context-state";
import { findLastUserMessageId, findSessionId } from "./transform-message-helpers";
import {
    applyFlushedStatuses,
    hasRecentAssistantCommit,
    type MessageLike,
    stripStructuralNoise,
    type TagTarget,
    tagMessages,
} from "./transform-operations";
import {
    abortSessionFailClosed,
    type CompactionMarkerStrategy,
    clearRustModeBoundaryRecord,
    defaultCompactionMarkerStrategy,
    evaluateEmergencyFailClosed,
    runPostTransformPhase,
} from "./transform-postprocess-phase";
import { logTransformTiming } from "./transform-stage-logger";
import { isClearlyOverWindow, UnmanagedOverWindowError } from "./unmanaged-over-window";
import { UnresolvedHistoryBoundaryError } from "./unresolved-history-boundary";

export { EmergencyFailClosedError } from "./emergency-fail-closed";

// Per-session message token cache. Keyed by message ID, value is the token
// contribution of that message split into conversation (text/reasoning/images)
// and tool call (tool_use/tool_result/tool/tool-invocation) buckets.
//
// Messages are append-only once streaming completes, so the cached value is
// stable across transform passes. Cleared on session.deleted and entries are
// invalidated on message.removed via clearMessageTokensCache().
//
// Bounded LRU on the outer key: sessions that are never explicitly deleted
// (crashed OpenCode, archived but not deleted sessions, sessions outliving
// the plugin process's interest) would otherwise leak their inner Maps
// forever. 100 sessions is generously above any realistic active working
// set — evicted entries are recomputed lazily on the next transform pass.
const MESSAGE_TOKENS_CACHE_MAX = 100;
const messageTokensBySession = new BoundedSessionMap<
    Map<string, { conversation: number; toolCall: number }>
>(MESSAGE_TOKENS_CACHE_MAX);

function getMessageTokensCache(
    sessionId: string,
): Map<string, { conversation: number; toolCall: number }> {
    let cache = messageTokensBySession.get(sessionId);
    if (!cache) {
        cache = new Map();
        messageTokensBySession.set(sessionId, cache);
    }
    return cache;
}

function maybeSendProjectIdentityWarning(
    deps: TransformDeps,
    sessionId: string,
    directory: string,
    notificationParams: import("./send-session-notification").NotificationParams,
): void {
    if (!deps.client) return;
    const warning = takeDubiousOwnershipProjectIdentityWarning(directory);
    if (!warning) return;
    void withoutSqliteTransformPass(() =>
        sendStatusNotification(deps.client, sessionId, warning, notificationParams),
    ).catch((error) => {
        sessionLog(
            sessionId,
            `project identity warning delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    });
}

export function clearMessageTokensCache(sessionId: string, messageId?: string): void {
    if (messageId === undefined) {
        messageTokensBySession.delete(sessionId);
        return;
    }
    const cache = messageTokensBySession.get(sessionId);
    if (cache) cache.delete(messageId);
}

// Hot-path guard: the session→project ownership binding is immutable per session,
// so the DB upsert+repair only needs to run when the resolved identity first
// appears (or changes) for a session in this process — not on every transform
// pass. Bounded so crashed/abandoned sessions can't leak the guard forever.
const recordedSessionProjectIdentity = new BoundedSessionMap<string>(MESSAGE_TOKENS_CACHE_MAX);

// Summary id of the native host compaction last logged per session, so the
// window head is reported once per compaction rather than on every pass.
const hostCompactionLoggedBySession = new BoundedSessionMap<string>(MESSAGE_TOKENS_CACHE_MAX);

// Tagger / trigger load-scoping floor (OpenCode only). Several hot-path reads
// preload an in-memory map or aggregate over a session's tags; on a large/old
// session that is the full tag history (100K+ rows): the tagger's content-key
// map (~32ms), the boundary's stored-token map (~52ms), the trigger pre-gate's
// upper-bound sum (~37ms). The wire passed to the transform is the
// post-compaction-boundary tail (m[0]/m[1] are prepended LATER, in postprocess),
// and tag_number is monotonic with message order, so the front of the wire holds
// the lowest tags — everything below is compacted-away history not in the wire.
// We derive one floor per pass and scope every such read to `tag_number >= floor`.
//
// `deriveTagLoadFloor` takes the MIN over the first K id-bearing messages, NOT
// the first one's tag: a tagged leading compaction-summary has a RECENTLY-assigned
// (high) tag despite sitting at the front, so the first message's tag could wrongly
// exclude the genuinely-oldest message behind it. A small margin is subtracted —
// a LOWER floor only ever loads MORE (strictly safe; never excludes an in-wire
// tag) and absorbs near-boundary tool-result straddles and minor id reordering.
// Deriving live every pass (not memoized) is ~K×2.8µs and is inherently
// revert-safe: it tracks the actual post-cleanup wire with no stored state to go
// stale. Returns 0 (today's full load) when nothing is tagged yet.
function activeAgentFromMessages(messages: readonly MessageLike[]): string | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const info = messages[index]?.info as { role?: unknown; agent?: unknown } | undefined;
        if (info?.role !== "user") continue;
        return typeof info.agent === "string" && info.agent.length > 0 ? info.agent : undefined;
    }
    return undefined;
}

function deriveTaggerLoadFloor(
    messages: MessageLike[],
    sessionId: string,
    db: ContextDatabase,
): number {
    return deriveTagLoadFloor(
        db,
        sessionId,
        (function* () {
            for (const message of messages) yield message.info?.id;
        })(),
    );
}

/**
 * Test-only accessor that returns (and lazily creates) the per-session token
 * cache map so tests can seed and inspect entries without running the full
 * transform pipeline. Not exported from any barrel.
 */
export function __getMessageTokensCacheForTest(
    sessionId: string,
): Map<string, { conversation: number; toolCall: number }> {
    return getMessageTokensCache(sessionId);
}

export { computeHardCacheExpired } from "../../features/magic-context/scheduler";

/**
 * Extract the provider/model from the last assistant message in the array.
 * Used for early model-change detection before loadContextUsage.
 */
function findLastAssistantModel(
    messages: MessageLike[],
): { providerID: string; modelID: string } | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        // OpenCode message objects have providerID/modelID under info, though
        // our narrow MessageInfo type doesn't declare them.
        const info = messages[i].info as {
            role?: string;
            providerID?: string;
            modelID?: string;
        };
        if (info.role === "assistant" && info.providerID && info.modelID) {
            return { providerID: info.providerID, modelID: info.modelID };
        }
    }
    return null;
}

/**
 * Extract the selected model from the newest USER message in the array. This is
 * the model the outgoing request will ACTUALLY go to: OpenCode's loop resolves
 * the request model from `lastUser.model` (verified with the OpenCode
 * maintainer). On a mid-session model switch, the array ends with
 * `[..., OLD-model assistant, NEW user message]` (the new model has not
 * produced an assistant message yet), so the last ASSISTANT still carries the
 * OLD model while the newest USER carries the NEW one. Preferring this over the
 * last-assistant model is what stops the model-change detector from false-firing
 * on the switching turn.
 *
 * Note the role asymmetry in OpenCode's schema: user messages nest the model
 * under `info.model.{providerID,modelID}`, whereas assistant messages carry it
 * flat as `info.providerID`/`info.modelID`.
 */
function findNewestUserModel(
    messages: MessageLike[],
): { providerID: string; modelID: string } | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const info = messages[i].info as {
            role?: string;
            model?: { providerID?: string; modelID?: string };
        };
        if (info.role !== "user") continue;
        // The NEWEST (last) user message is the one OpenCode resolves the
        // outgoing request model from (`lastUser.model`). Return its model, or
        // null if it carries none (do NOT keep scanning to an OLDER user, whose
        // model is not what this request goes to). A null return lets the caller
        // fall back to the last-assistant model.
        if (info.model?.providerID && info.model.modelID) {
            return { providerID: info.model.providerID, modelID: info.model.modelID };
        }
        return null;
    }
    return null;
}

export const EMERGENCY_REFUSAL_NOTICE = "Context full — /ctx-flush or /clear to continue.";

export type HostRefusalNotice = (
    client: PluginContext["client"] | undefined,
    sessionId: string,
    message: string,
    notificationParams: import("./send-session-notification").NotificationParams,
) => Promise<void>;

export async function sendEmergencyRefusalNotice(
    client: PluginContext["client"] | undefined,
    sessionId: string,
    message: string,
    notificationParams: import("./send-session-notification").NotificationParams,
): Promise<void> {
    if (!client) throw new Error("OpenCode client is unavailable");
    const notification = await sendStatusNotification(
        client,
        sessionId,
        message,
        notificationParams,
    );
    if (notification !== "sent" && notification !== "queued") {
        throw new Error(`Emergency recovery notification was ${notification}`);
    }
}

export interface TransformDeps {
    cacheTtlConfig?: import("../../shared/model-cache-ttl").CacheTtlConfig;
    cacheTtlConfigured?: boolean;
    sampleCacheTtlConfig?: () => {
        cache_ttl: import("../../shared/model-cache-ttl").CacheTtlConfig;
        cacheTtlConfigured?: boolean;
    };
    hiddenCompletionExecutor?: import("./compartment-runner-types").HiddenCompletionExecutor;
    /** Host marker lifecycle; omission preserves OpenCode 1 marker writes and replay. */
    compactionMarkerStrategy?: CompactionMarkerStrategy & {
        setPending?: typeof import("../../features/magic-context/storage").setPendingCompactionMarkerState;
        publish?: typeof import("./compaction-marker-manager").updateCompactionMarkerAfterPublication;
    };
    /** Host storage and cancellation adapters; omitted callbacks retain OpenCode 1 behavior. */
    hostRawMessages?: (sessionId: string) => ReturnType<typeof readRawSessionMessages>;
    hostMessageReconciliationSource?: MessageReconciliationSource;
    hostProtectedTailBoundary?: typeof resolveOpenCodeProtectedTailBoundary;
    hostModelFallback?: typeof findLastAssistantModelFromOpenCodeDb;
    hostRefusalNotice?: HostRefusalNotice;
    hostRefuse?: typeof abortSessionFailClosed;
    tagger: Tagger;
    scheduler: Scheduler;
    contextUsageMap: Map<
        string,
        {
            usage: ContextUsage;
            updatedAt: number;
            lastResponseTime?: number;
            hasUsageTokens?: boolean;
        }
    >;
    db: ContextDatabase;
    /**
     * Channel 1 (ctx_reduce tool-output nudge) per-session metric baseline,
     * refreshed at the end of each transform pass where ctx_reduce is callable
     * and read in tool.execute.after.
     */
    channel1StateBySession?: Map<string, import("./ctx-reduce-nudge").Channel1State>;
    /** Module-authored Channel 2 text held until the terminal `message.updated` event, when the host delivers the pending nudge. */
    channel2DirectiveTextBySession?: Map<string, string>;
    /** Direct absolute override for callers that do not load tiered config. */
    protectedTokens?: number;
    /** User/project values retained until the pass supplies usableSoft geometry. */
    protectedTokenTierOverrides?: ProtectedTokensTierOverrides;
    /**
     * ctx_reduce visibility is resolved per session from the session's tool
     * allow-list. Tag DB rows are still maintained when the tool is unavailable,
     * but §N§ prefixes and nudges are suppressed. See tag-messages.ts for the gate.
     */
    /** Smart-drops (experimental, default off): also reclaim tool output that a
     *  later call supersedes, on top of the age-based auto-drop. Off → messages
     *  sent to the model are byte-identical to the age-based-only behavior. */
    smartDrops?: boolean;
    protectedTools?: Readonly<Record<string, number>>;
    clearReasoningAge: number;
    /** Commit-cluster historian trigger config (`commit_cluster_trigger`). */
    commitClusterTrigger?: { enabled: boolean; min_clusters: number };
    /**
     * One-shot signal that `<session-history>` injection cache is stale and
     * `prepareCompartmentInjection` should rebuild on this pass. Drained
     * after the rebuild so subsequent defer passes hit the fresh cache.
     * See Oracle review 2026-04-26 for the three-set split rationale.
     */
    historyRefreshSessions: Set<string>;
    deferredHistoryRefreshSessions?: Set<string>;
    /**
     * Persistent signal that pending ops + heuristics need to materialize.
     * Survives across defer passes when `compartmentRunning` blocks the
     * heuristic pass. Drained only after `shouldRunHeuristics` succeeds.
     */
    pendingMaterializationSessions: Set<string>;
    deferredMaterializationSessions?: Set<string>;
    /** Live OpenCode reasoning variant, forwarded only as a provider-cache identity signal. */
    variantBySession?: Map<string, string | undefined>;
    lastHeuristicsTurnId: Map<string, string>;
    commitSeenLastPass?: Map<string, boolean>;
    client?: PluginContext["client"];
    directory?: string;
    /** Whether user-level configuration lets this session use the canonical home directory as its project. */
    allowHomeProject?: boolean;
    memoryConfig?: {
        enabled: boolean;
        injectionBudgetTokens: number;
        /** When true, historian/recomp auto-promote eligible session facts
         *  to project memories. When false, promotion is skipped — agents can
         *  still write memories explicitly via `ctx_memory write`. Issue #44. */
        autoPromote: boolean;
    };
    /** Defaults true. When false, m[0] omits the <project-docs> block and docs hash. */
    injectDocs?: boolean;
    ensureProjectRegistered?: (directory: string, db: ContextDatabase) => Promise<void>;
    /**
     * Returns the historian chunk budget. Called at each historian spawn site
     * so the value is always derived from current config — keeping hook,
     * RPC, and TUI trigger paths consistent and honoring runtime config changes.
     * Optional for tests; production (hook.ts) always provides it.
     */
    getHistorianChunkTokens?: () => number;
    historyBudgetPercentage?: number;
    executeThresholdPercentage?: number | { default: number; [modelKey: string]: number };
    executeThresholdTokens?: { default?: number; [modelKey: string]: number | undefined };
    historianTimeoutMs?: number;
    /** Active OpenCode historian entry, including its outbound request variant. */
    historianModel?: ModelInput;
    historianContextLimit?: number;
    historianMaxOutputTokens?: number;
    /** Resolved fallback chain for historian-family calls. */
    fallbackModels?: readonly ModelInput[];
    resolveHistorianRun?: () => {
        model?: ModelInput;
        fallbackModels: readonly ModelInput[];
        contextLimit?: number;
        maxOutputTokens?: number;
        timeoutMs: number;
        twoPass: boolean;
        expandTools?: Record<string, string | false>;
        autoPromote: boolean;
        userMemoriesEnabled: boolean;
        commitClusterTrigger?: { enabled: boolean; min_clusters: number };
        toastDurationMs?: number;
        chunkTokens: number;
    };
    /** False when historian.disable=true, blocking historian-backed child agents. */
    historianRunnable?: boolean;
    /**
     * Which side runs the historian completion in Rust transform mode
     * (`historian.runner`). Absent means the harness default, which for OpenCode 1
     * and OpenCode 2 is the host: the module queues the completion and this
     * process's pull loop runs it. Only "broca" leaves the pull loop unbuilt.
     */
    historianRunner?: "broca" | "host";
    /**
     * Operator kill switch for this process's historian pull loop
     * (`historian.host_runner.enabled`). Absent means enabled; it only matters
     * when `historianRunner` is not "broca".
     */
    historianHostRunnerEnabled?: boolean;
    /**
     * Compaction-off mode (issue #266), boot-resolved and process-stable.
     * When true the transform runs additive-only: m[0]/m[1] memory/docs
     * injection, measurement and identity recording stay; every mutating
     * compaction gate (historian, drops, strips, nudges, emergency, markers,
     * tag writes) is off. Precedence: every mutating gate becomes
     * `existingGate && !compactionOff` — the mode wins over both the primary
     * and the subagent path. It does NOT alias fullFeatureMode=false: the
     * m[0]/m[1] injection gate is re-expressed as identity-present AND
     * (fullFeatureMode || compactionOff) so the mode cannot swallow memory
     * delivery.
     */
    compactionOff?: boolean;
    hostCleanupCompactionMarkers?: Parameters<typeof reconcileCompactionMode>[0]["cleanupMarkers"];
    getNotificationParams?: (
        sessionId: string,
    ) => import("./send-session-notification").NotificationParams;
    getModelKey?: (sessionId: string) => string | undefined;
    /**
     * Observed provider-tool-set fingerprint for the session route. This is
     * telemetry only: a change is recorded but never asks m[0] to fold.
     */
    getToolSetHash?: (sessionId: string) => string;
    getFallbackModelId?: (sessionId: string) => string | undefined;
    projectPath?: string;
    experimentalUserMemories?: boolean;

    /** When true, inject wall-clock gap markers (<!-- +Xm -->) on user messages and
     *  add compact date ranges to compartment headings in <session-history>.
     *  Controlled by `experimental.temporal_awareness` config. */
    experimentalTemporalAwareness?: boolean;
    /** mural.enabled — when true (and the fold's model accepts
     *  images), materializeM0 renders the deterministic mural on demand and folds
     *  its image into the m[0] baseline. */
    muralEnabled?: boolean;
    /** When true, run a second editor pass after historian to clean U: lines.
     *  Enables the historian-editor agent. Controlled by `historian.two_pass` config. */
    historianTwoPass?: boolean;
    historianExpandTools?: Record<string, string | false>;
    liveModelBySession?: LiveModelBySession;
    /**
     * Process-scoped cache of resolved session.directory values. When provided,
     * we look up here before hitting OpenCode's API and populate after a
     * successful lookup. The session→project binding is immutable in OpenCode,
     * so this cache lives until the session is deleted.
     */
    sessionDirectoryBySession?: Map<string, string>;
    /**
     * Process-scoped set of Magic Context's OWN hidden child sessions
     * (historian/dreamer), detected by title prefix
     * at `session.created`. When a session is in this set the transform returns
     * immediately (messages unmodified) — these children have their own fixed
     * agent identity and never use any MC feature, so even reduced-mode work
     * (tagging, heuristic drops) is pure overhead. See live-session-state.ts.
     */
    internalChildSessions?: Set<string>;
    /** Experimental auto-search hint — transform-time ctx_search on each new
     *  user message; when top hit clears the threshold, append a compact
     *  fragment hint to the user message. Controlled by
     *  `experimental.auto_search.*` config. */
    autoSearch?: {
        enabled: boolean;
        scoreThreshold: number;
        minPromptChars: number;
        directory?: string;
        ensureProjectRegistered?: (directory: string, db: ContextDatabase) => Promise<void>;
        /** Caveman word rules for hint fragments, from the user-level `language` setting. */
        wordRules?: CavemanWordRules;
    };
    /**
     * Experimental age-tier caveman text compression — rewrites long
     * user/assistant text parts with progressively aggressive caveman
     * rules based on their position in the eligible tag window. Only runs for
     * primary sessions; subagents are excluded because their context is curated
     * by the parent and they have no ctx_expand recovery path.
     */
    cavemanTextCompression?: {
        enabled: boolean;
        minChars: number;
        /** From the user-level `language` setting; English word rules when absent. */
        wordRules?: CavemanWordRules;
    };
    /** Fire-and-forget active-session embed backfill after transform returns. */
    maybeAutoEmbedSession?: (sessionId: string) => void;
    /** Resolved project mode. Rust mode bypasses every TS mutation below. */
    transformMode?: "ts" | "rust";
    /** Prompt-surface routing and USER description overrides forwarded to Rust mode. */
    promptSurface?: PromptSurfaceConfig;
    /** Resolves trusted USER guidance files before crossing the module boundary. */
    promptSurfaceRuntime?: PromptSurfaceRuntime;
    /** Module transport injected by the hook; tests use a deterministic mock. */
    rustModeModuleClient?: RustModeModuleClient;
    rustModeProjectRoot?: string;
    onRustModeParked?: (sessionId: string, message: string) => void;
    onRustEngineReconnectRefusal?: (args: {
        sessionId: string;
        projectRoot: string;
        refusedUserMessageId: string;
        providerProvenEmergency: boolean;
        compactionOff: boolean;
    }) => void;
    rustMemorySyncRequestedSessions?: Set<string>;
    /**
     * Which projection of the OpenCode store this host serves. Supplied by the
     * OpenCode 1 and OpenCode 2 hooks; omitted by every other harness, which
     * keeps them (Pi in particular) out of the coordinate rebase entirely.
     */
    storeGeneration?: CoordinateGeneration;
}

export function resolveTransformHostSeams(
    deps: Pick<
        TransformDeps,
        | "hostRawMessages"
        | "hostMessageReconciliationSource"
        | "hostProtectedTailBoundary"
        | "hostModelFallback"
        | "hostRefusalNotice"
        | "hostRefuse"
    >,
) {
    return {
        hostRawMessages: deps.hostRawMessages ?? readRawSessionMessages,
        hostMessageReconciliationSource:
            deps.hostMessageReconciliationSource ?? readRawSessionMessages,
        hostProtectedTailBoundary:
            deps.hostProtectedTailBoundary ?? resolveOpenCodeProtectedTailBoundary,
        hostModelFallback: deps.hostModelFallback ?? findLastAssistantModelFromOpenCodeDb,
        hostRefusalNotice: deps.hostRefusalNotice ?? sendEmergencyRefusalNotice,
        hostRefuse: deps.hostRefuse ?? abortSessionFailClosed,
    };
}

export function createTransform(deps: TransformDeps) {
    const finalWireUsage = createFinalWireUsageTracker();
    const host = resolveTransformHostSeams(deps);
    const loadedSessions = new Set<string>();
    // Sessions whose history was clearly over the model's window, with no
    // Magic Context state to send in its place, on a pass that could not bring
    // it under. Each later pass is checked again until one is served under the
    // window, because the usage reading such a pass sees is not this request's:
    // it is missing, or on an OpenCode 2 fork it is the parent's last reply.
    const unmanagedOverWindowSessions = new Set<string>();
    const rustModeTransform =
        deps.transformMode === "rust" && deps.rustModeModuleClient
            ? createRustModeTransform(deps, {
                  moduleClient: deps.rustModeModuleClient,
                  hostClient: deps.client,
                  projectRoot: deps.rustModeProjectRoot,
                  notifyParked: deps.onRustModeParked,
                  onEngineReconnectRefusal: deps.onRustEngineReconnectRefusal,
                  memorySyncRequestedSessions: deps.rustMemorySyncRequestedSessions,
              })
            : undefined;
    let entryReuse: { reused: number; retained: number; retainedBytes: number } | undefined;
    const projectEntry = createLkgEntryProjector({
        onReuse: (stats) => {
            entryReuse = stats;
        },
    });
    const deferredHistoryRefreshSessions = deps.deferredHistoryRefreshSessions ?? new Set<string>();
    const deferredMaterializationSessions =
        deps.deferredMaterializationSessions ?? new Set<string>();

    const observeCommitNudgeTransition = (
        sessionId: string,
        hasRecentCommit: boolean,
        isSubagent: boolean,
    ): void => {
        const hadPriorCommitState = deps.commitSeenLastPass?.has(sessionId) ?? false;
        const sawCommitLastPass = deps.commitSeenLastPass?.get(sessionId) ?? false;
        // The first pass establishes a restart-safe baseline. Only a later
        // absent→present edge is a new commit, and subagents never deliver note nudges.
        if (!isSubagent && hadPriorCommitState && hasRecentCommit && !sawCommitLastPass) {
            onNoteTrigger(deps.db, sessionId, "commit_detected");
        }
        deps.commitSeenLastPass?.set(sessionId, hasRecentCommit);
    };

    const transform = async (
        _input: Record<string, never>,
        output: { messages: unknown[] },
    ): Promise<void> => {
        const startTime = performance.now();
        const historianRun = deps.resolveHistorianRun?.();
        const messages = output.messages as MessageLike[];
        const passOutcome = createPassOutcome();
        const tSessionId = performance.now();
        const sessionId = findSessionId(messages);
        if (!sessionId) {
            return;
        }
        const temporalCandidates = deps.experimentalTemporalAwareness
            ? collectTemporalCandidates(messages)
            : undefined;
        const temporalReplayIds = temporalCandidates
            ? messages.flatMap((message) => (message.info.id ? [message.info.id] : []))
            : undefined;
        logTransformTiming(sessionId, "findSessionId", tSessionId, `messages=${messages.length}`);
        const tLkgEntry = performance.now();
        // The Rust adapter captures its own last-known-good input snapshot and returns
        // before the TypeScript capture, so it does not need this entry projection.
        const lkgInput = deps.transformMode === "rust" ? [] : projectEntry(sessionId, messages);
        logTransformTiming(
            sessionId,
            "lkg.entryProjection",
            tLkgEntry,
            deps.transformMode === "rust" || !entryReuse
                ? undefined
                : `reused=${entryReuse.reused} retained=${entryReuse.retained} retainedBytes=${entryReuse.retainedBytes}`,
        );
        const resolvedSessionId = sessionId;
        const runNotificationParams = (sid: string) => {
            const params = deps.getNotificationParams?.(sid) ?? {};
            return historianRun?.toastDurationMs === undefined
                ? params
                : { ...params, toastDurationMs: historianRun.toastDurationMs };
        };
        beginLkgPass(sessionId);
        clearOpenCodePendingTransformDecision(sessionId);

        const db = deps.db;

        // A stage this pass cannot be served without has failed: the session's
        // saved drops, truncations, history cut or emergency state would be
        // missing from the output, so the request could be far larger than the
        // last one (or differ from it on a pass that must replay it unchanged).
        // Record the degradation and stop the pass; the messages wrapper then
        // replays the last good request or refuses the turn. Compaction-off
        // mode keeps going instead: native compaction owns the window there,
        // the pass only adds blocks, and on any thrown error the wrapper would
        // serve the input unchanged anyway.
        const failPass = (
            site: PassDegradationSite,
            error: unknown,
            kind?: PassDegradationKind,
        ): void => {
            passOutcome.record(site, kind);
            if (deps.compactionOff === true) return;
            throw degradedPassError(site, error);
        };

        // Runs before anything reads a saved coordinate. Every ordinal this
        // session stored is a position in the message list some host served; if
        // the host in front of us serves a different projection of the same
        // conversation, those positions must be re-derived from the surviving
        // message ids first. A failure stops this pass rather than trimming
        // against stale positions; the generation stamp is only written on
        // success, so the next pass retries.
        if (deps.storeGeneration !== undefined) {
            try {
                // The module keeps its own copy of this conversation, keyed on the
                // numbering the previous host served. Nothing re-derives that copy,
                // so it is deleted before the host rows are renumbered and re-seeded
                // cold from the rebased rows on this same pass. Doing it first is
                // what makes a failure recoverable: the generation stamp is written
                // by the rebase below, so throwing here leaves the session on its old
                // generation and the next pass tries the whole sequence again.
                if (
                    rustModeTransform &&
                    readCoordinateGeneration(db, sessionId) !== deps.storeGeneration
                ) {
                    clearRustModeBoundaryRecord(db, sessionId);
                    await rustModeTransform.clearSession(sessionId);
                    sessionLog(
                        sessionId,
                        `rust module session deleted before the store projection rebase to ${deps.storeGeneration}; the next serve seeds cold`,
                    );
                }
                await rebaseSessionCoordinatesAsync({
                    db,
                    sessionId,
                    generation: deps.storeGeneration,
                    readMessages: host.hostRawMessages,
                });
            } catch (error) {
                sessionLog(
                    sessionId,
                    "store projection rebase failed (retrying next pass):",
                    error,
                );
                failPass("store-generation-rebase-failure", error);
            }
        }

        if (deps.client !== undefined) {
            withoutSqliteTransformPass(() =>
                scheduleReconciliation(db, sessionId, host.hostMessageReconciliationSource),
            );
        }

        const tUserMsg = performance.now();
        const currentTurnId = findLastUserMessageId(messages);
        const activeAgent = activeAgentFromMessages(messages);
        logTransformTiming(sessionId, "findLastUserMessageId", tUserMsg);

        const tMeta = performance.now();
        let sessionMeta: import("../../features/magic-context/types").SessionMeta | undefined;
        try {
            sessionMeta = getOrCreateSessionMeta(db, sessionId);
            const ttlModel =
                findNewestUserModel(messages) ??
                deps.liveModelBySession?.get(sessionId) ??
                findLastAssistantModel(messages);
            const ttlConfig = deps.sampleCacheTtlConfig?.();
            sessionMeta.cacheTtl = resolveSessionCacheTtl(
                db,
                sessionId,
                ttlConfig?.cache_ttl ?? deps.cacheTtlConfig,
                ttlModel ? `${ttlModel.providerID}/${ttlModel.modelID}` : undefined,
                ttlConfig?.cacheTtlConfigured ?? deps.cacheTtlConfigured,
            ).value;
        } catch (error) {
            sessionLog(sessionId, "transform failed reading session meta:", error);
            // Returning here would hand the host its raw messages, without any
            // of the session's saved reductions.
            failPass("session-meta-early-return", error, "fatal");
            return;
        }
        logTransformTiming(sessionId, "getOrCreateSessionMeta", tMeta);

        // Read before anything in this pass trims the messages: a native host
        // compaction is recognised by the rows at the head of the host window.
        let hostCompaction: HostCompactionWindow | null = null;
        try {
            hostCompaction = findHostCompactionWindow(
                messages,
                () => getPersistedCompactionMarkerState(db, sessionId)?.summaryMessageId || null,
            );
            if (
                hostCompaction &&
                hostCompactionLoggedBySession.get(sessionId) !== hostCompaction.summaryMessageId
            ) {
                hostCompactionLoggedBySession.set(sessionId, hostCompaction.summaryMessageId);
                sessionLog(
                    sessionId,
                    `transform: native host compaction heads the window (request ${hostCompaction.compactionMessageId}, summary ${hostCompaction.summaryMessageId}, completed ${hostCompaction.completedAt}); a baseline older than it folds on this pass`,
                );
            }
        } catch (error) {
            sessionLog(sessionId, "transform: reading the host compaction head failed:", error);
        }

        // Magic Context's OWN hidden children (historian/dreamer)
        // are fully exempt from the transform. They have a
        // fixed agent identity + single-shot/bounded job and use zero MC
        // features, so even reduced-mode work (tagging, heuristic drops) is
        // pure overhead and conceptual noise. Detected at session.created by
        // the `magic-context-` title prefix. Returning here leaves messages
        // unmodified. (Worst case the very first pass races the session.created
        // event and runs reduced-mode once — harmless for these short sessions.)
        if (deps.internalChildSessions?.has(sessionId)) {
            sessionLog(sessionId, "transform skipped (internal magic-context child session)");
            return;
        }

        // Compaction mode is session hygiene shared by both renderer authorities.
        // Resolve it before either mode can return so stale markers and latches are
        // reconciled even when Rust owns normal transform rendering.
        const compactionOff = deps.compactionOff === true;

        // Mode-transition reconciliation runs on every pass and is a no-op
        // once the session's durable record matches the boot-resolved mode —
        // so the transition work (marker cleanup, latch/intent/pending-op
        // clears, catch-up signal) happens exactly once per session, on the
        // first pass after a restart that changed the resolved value. A notice
        // transition first stages a durable pending record, then commits its
        // settled value only after delivery; a failure therefore retries the
        // same logical transition across process restarts.
        try {
            const transition = reconcileCompactionMode({
                db,
                sessionId,
                compactionOff,
                historianRunnable: deps.historianRunnable !== false,
                compartmentInProgress: sessionMeta.compartmentInProgress,
                cleanupMarkers: deps.hostCleanupCompactionMarkers,
            });
            const hasTransitionEffects =
                transition.recordToWrite !== null ||
                transition.notice !== null ||
                transition.invalidatedM0Baseline ||
                transition.clearedCompartmentInProgress ||
                transition.historianCatchUpSignaled;
            if (hasTransitionEffects) {
                if (transition.invalidatedM0Baseline) {
                    // The persisted baseline bytes were nulled; drop the
                    // pass-local copies too so this pass re-materializes
                    // instead of replaying the pre-flip render.
                    sessionMeta = {
                        ...sessionMeta,
                        cachedM0Bytes: null,
                        cachedM1Bytes: null,
                        cachedM0MuralDataUrl: null,
                        cachedM0MuralHash: null,
                    };
                }
                if (transition.clearedCompartmentInProgress) {
                    sessionMeta = { ...sessionMeta, compartmentInProgress: false };
                }
                if (transition.historianCatchUpSignaled) {
                    sessionMeta = { ...sessionMeta, compartmentInProgress: true };
                }
                const notice = transition.notice;
                // A missing client is the existing no-notification test/headless
                // seam. Production OpenCode transforms always provide one; when
                // present, its delivery result controls whether the settled record
                // commits. The reconciler has already persisted a pending notice
                // record, so a restart retries instead of losing this delivery.
                let noticeDelivered = notice === null || deps.client === undefined;
                if (notice && deps.client) {
                    // Out-of-band only — never the message array or nudge
                    // channels. A failed delivery leaves the durable pending
                    // record in place, accepting a duplicate after a crash
                    // rather than permanently losing the notice.
                    noticeDelivered =
                        (await sendStatusNotification(
                            deps.client,
                            sessionId,
                            notice,
                            runNotificationParams(sessionId) ?? {},
                        )) === "sent";
                }
                if (noticeDelivered && transition.recordToWrite !== null) {
                    commitCompactionModeRecord(db, sessionId, transition.recordToWrite);
                } else if (!noticeDelivered) {
                    sessionLog(
                        sessionId,
                        "compaction mode notice was not delivered; durable pending record will retry on the next pass",
                    );
                }
            }
        } catch (error) {
            sessionLog(sessionId, "compaction mode transition failed (retrying next pass):", error);
            // A half-applied transition leaves this pass on a stale m[0]/m[1]
            // baseline or marker state that a completed one would have replaced.
            failPass("compaction-mode-transition-failure", error);
        }

        // Read the agent and session permissions for ctx_reduce before either
        // renderer freezes the ctx_reduce verdict below. OpenCode keeps those
        // permissions off the first user message's tools map, so without this
        // read a session whose agent denies ctx_reduce would still get §N§ tags,
        // reduce guidance, and nudges. This is a no-op once the verdict froze,
        // so a later permission change never flips provider-visible bytes.
        if (deps.client !== undefined && !compactionOff) {
            await primeCtxReduceSpawnPermission(
                deps.client,
                sessionId,
                spawnAgentFromMessages(messages),
            );
        }

        // Rust mode is an authority adapter, not a second implementation of the
        // TypeScript renderer. Compaction-off still dispatches so the module can
        // provide the shared additive-only memory/docs contract.
        if (deps.transformMode === "rust") {
            if (!rustModeTransform) {
                // Production wiring always builds a module client in Rust mode,
                // so this is a wiring fault. Returning would serve the raw input.
                sessionLog(sessionId, "rust transform unavailable; not serving raw messages");
                failPass(
                    "rust-transform-unavailable",
                    new Error("Rust mode is configured without a module client"),
                );
                return;
            }
            if (!compactionOff) {
                observeCommitNudgeTransition(
                    sessionId,
                    hasRecentAssistantCommit(messages),
                    sessionMeta.isSubagent,
                );
            }
            await rustModeTransform.run(sessionId, messages, output, sessionMeta);
            // Rust returns before the TypeScript post-pass hook below. Run the
            // host-owned embedding trigger after either implementation publishes.
            withoutSqliteTransformPass(() => deps.maybeAutoEmbedSession?.(sessionId));
            return;
        }

        // System prompt change detection is handled in experimental.chat.system.transform
        // (see system-prompt-hash.ts), not here. The messages transform only receives
        // user/assistant messages, not the system prompt.

        // Freeze the harness-derived suffix shape before tagging, structural-noise
        // sentinels, and synthetic injections can alter the live message graph.
        const trailingBlankSourceDecisions = snapshotTrailingBlankSourceDecisions(messages);

        const reducedMode = sessionMeta.isSubagent;
        const fullFeatureMode = !reducedMode;
        // Compaction-off mode (issue #266) is a THIRD flag, orthogonal to the
        // subagent split above: every mutating gate below becomes
        // `existingGate && !compactionOff`, and the m[0]/m[1] injection gate
        // is re-expressed as identity-present AND (fullFeatureMode ||
        // compactionOff) so the mode cannot swallow memory delivery.

        // §N§ prefix + ctx_reduce + Channel 1 are gated on this single signal,
        // NOT on subagent status. `ctx_reduce` is registered process-globally
        // (tool-registry.ts), so subagents may have the tool — they just need
        // the §N§ prefix + Channel 1 baseline + guidance to use it.
        //
        // ALSO gated on the session's actual tool availability: a parent agent
        // can spawn this session with an explicit allow-list tools map that
        // filters ctx_reduce out entirely — §N§ prefixes and nudges for a tool
        // the model can't call are pure overhead plus cargo-cult risk. The
        // verdict is frozen per session (first user message's tools map) so it
        // can never flap mid-session and bust the cache.
        const ctxReduceAvailability: CtxReduceAvailabilityVerdict =
            resolveCtxReduceAvailabilityFromMessages(sessionId, messages);
        const ctxReduceCallable = ctxReduceAvailability.callable;

        // Same frozen-per-session verdict for the native `todowrite` tool. When
        // a session's tools map filters todowrite out, the synthetic todo-pair
        // injection (postprocess B7 block) must not replay a pair for a tool the
        // model cannot call. Resolved here from the same first-user-message map
        // so the verdict is frozen identically and never flaps mid-session.
        const todowriteAvailability: ToolAvailabilityVerdict =
            resolveTodowriteAvailabilityFromMessages(sessionId, messages);

        // Resolve the *session's* working directory, not the OpenCode launch
        // directory. When the user runs `opencode -s <id>` from outside the
        // project, `deps.directory` (captured at plugin init) reflects the
        // launch dir (often $HOME) while the session itself is bound to the
        // project. Historian/dreamer/recomp child sessions and project-scoped
        // memory all need the session's real directory.
        //
        // We call `client.session.get(...)` (OpenCode's public SDK) once per
        // session per plugin-process lifetime and cache the result in
        // `liveSessionState.sessionDirectoryBySession`. The session→project
        // binding is immutable in OpenCode (the `directory` field is set at
        // session create time and never modified), so caching for the entire
        // session lifetime is safe.
        //
        // Without the cache, this HTTP round trip ran on every transform pass
        // and was observed to take 1.5s+ for large sessions under Electron
        // Desktop, dominating transform latency. We deliberately keep using
        // the public SDK rather than reading OpenCode's internal SQLite
        // directly — the schema is OpenCode's private contract and could
        // change without notice.
        //
        // session.get failure is non-fatal — fall back to deps.directory so
        // transform never blocks on a permanent SDK error.
        let sessionDirectory: string = deps.directory ?? "";
        let sessionDirectoryResolvedFromHost = false;
        let sessionDirectoryFellBack = false;
        const cachedDirectory = deps.sessionDirectoryBySession?.get(sessionId);
        if (cachedDirectory && cachedDirectory.length > 0) {
            sessionDirectory = cachedDirectory;
            sessionDirectoryResolvedFromHost = true;
        } else if (deps.client !== undefined) {
            try {
                const sessionResponse = await deps.client.session
                    .get({ path: { id: sessionId } })
                    .catch(() => null);
                const sessionInfo = (sessionResponse as { data?: { directory?: string } } | null)
                    ?.data;
                if (
                    sessionInfo &&
                    typeof sessionInfo.directory === "string" &&
                    sessionInfo.directory.length > 0
                ) {
                    sessionDirectory = sessionInfo.directory;
                    // Populate cache for future transforms in this session.
                    // Don't cache the fallback (deps.directory) — it might be
                    // wrong for `opencode -s <id>` launches from a different
                    // cwd, and the next transform should retry the SDK lookup.
                    deps.sessionDirectoryBySession?.set(sessionId, sessionDirectory);
                    sessionDirectoryResolvedFromHost = true;
                }
            } catch (error) {
                passOutcome.record("session-directory-fallback");
                sessionLog(sessionId, "session directory lookup failed; using fallback:", error);
            }
            if (!sessionDirectoryResolvedFromHost) {
                passOutcome.record("session-directory-fallback");
                sessionDirectoryFellBack = true;
            }
        }
        // The launch directory can belong to a different project than the
        // session (`opencode -s <id>` started elsewhere). A pass that fell back
        // to it must not render that project's memories and docs into m[0]/m[1]:
        // a rebuild is persisted and replayed by every later pass. When a frozen
        // pair exists, this pass replays it byte-identically, as a defer pass
        // does, and leaves every rebuild signal pending for the next pass that
        // resolves the directory. Two cases render with the launch directory,
        // as they always have: a session with nothing frozen yet, and one the
        // host has never resolved (no stored project binding), whose frozen
        // pair was itself rendered with the launch directory.
        const freezeM0M1 =
            sessionDirectoryFellBack &&
            sessionMeta.cachedM0Bytes != null &&
            sessionMeta.cachedM1Bytes != null &&
            (() => {
                try {
                    return hasRecordedSessionProjectIdentity(db, sessionId);
                } catch {
                    // Unknown: keep the frozen pair rather than risk a rebuild.
                    return true;
                }
            })();
        if (freezeM0M1) {
            sessionLog(
                sessionId,
                "session directory unresolved; replaying the frozen m[0]/m[1] and deferring any rebuild",
            );
        }
        const compartmentDirectory = sessionDirectory;
        const historianRunnable = deps.historianRunnable !== false;
        const canRunCompartments =
            fullFeatureMode &&
            !compactionOff &&
            historianRunnable &&
            (deps.client !== undefined || deps.hiddenCompletionExecutor !== undefined) &&
            compartmentDirectory.length > 0;
        const fallbackModelId = deps.getFallbackModelId?.(sessionId);

        const tModelDetect = performance.now();
        // Snapshot persisted usage BEFORE any reset this pass. Both the
        // model-change clear (just below) and the first-pass reset (further down)
        // zero last_context_percentage / last_input_tokens; the proactive
        // shrinking-switch arm and the protected-tail boundary sizing need the
        // pre-reset values, so capture them once, here, up front.
        const persistedUsageBeforeResets = contextUsagePassSnapshot(sessionMeta).persistedUsage;

        // Detect model changes early in the transform, BEFORE loading context
        // usage, so threshold checks (95% blocking, 80% emergency nudge) and the
        // history budget don't run on the previous model's numbers.
        if (deps.liveModelBySession) {
            // The model the request will ACTUALLY go to. The newest USER message
            // carries the selected (possibly just-switched) model, and OpenCode
            // resolves the outgoing request from it (`lastUser.model`). On a
            // switching turn the array ends with [..., OLD assistant, NEW user]:
            // the last ASSISTANT still reads OLD (assistant model is flat
            // info.providerID/modelID) while the newest USER reads NEW (nested
            // info.model). Prefer the newest user; if that message somehow
            // carries no model, prefer the live map (chat.message set it to the
            // just-selected model BEFORE this pass) over the last assistant. The
            // last assistant still reads the OLD model on a switching turn, so
            // falling straight to it would reintroduce the mis-resolution. Use the
            // last assistant only when neither is available (fork / cold-start
            // replay with an empty live map).
            const currentOutgoingModel =
                findNewestUserModel(messages) ??
                deps.liveModelBySession.get(sessionId) ??
                findLastAssistantModel(messages);
            if (currentOutgoingModel) {
                // Always track the outgoing model as the live model (seeds an
                // empty map after restart; keeps it current otherwise).
                deps.liveModelBySession.set(sessionId, currentOutgoingModel);

                // Model-change detection drives stale per-model state clearing.
                // Trigger off the model that produced the LAST PERSISTED USAGE
                // (lastObservedModelKey), NOT the volatile liveModelBySession: on
                // a LIVE switch chat.message has already set liveModelBySession to
                // the new model before transform runs, so a liveModel-vs-outgoing
                // comparison never sees the change, and hook-handlers.ts does not
                // clear on a live switch either. The persisted usage's model is
                // the authoritative "what the last measured turn ran on" signal;
                // when it differs from the outgoing model the model genuinely
                // changed since the last turn, so the old model's detected-limit /
                // reasoning watermark / emergency state must be cleared. One
                // trigger covers live switch, cold start, and fork alike.
                const outgoingModelKey = resolveModelKey(
                    currentOutgoingModel.providerID,
                    currentOutgoingModel.modelID,
                );
                const lastUsageModelKey = persistedUsageBeforeResets?.lastObservedModelKey ?? null;
                if (
                    lastUsageModelKey != null &&
                    outgoingModelKey != null &&
                    piModelRefToCanonical(lastUsageModelKey) !==
                        piModelRefToCanonical(outgoingModelKey)
                ) {
                    const outgoingOverflow = getOverflowState(db, sessionId, outgoingModelKey);
                    const preserveOutgoingOverflow =
                        outgoingOverflow.detectedContextLimit > 0 &&
                        outgoingOverflow.detectedContextLimitModelKey !== null;
                    dropSlot(sessionId, "model-change", deps.compactionOff !== true);
                    sessionLog(
                        sessionId,
                        `transform: model change since last usage (${lastUsageModelKey} -> ${outgoingModelKey}), clearing stale per-model state`,
                    );
                    updateSessionMeta(db, sessionId, {
                        lastContextPercentage: 0,
                        lastInputTokens: 0,
                        observedSafeInputTokens: 0,
                        cacheAlertSent: false,
                        clearedReasoningThroughTag: 0,
                    });
                    clearHistorianFailureState(db, sessionId);
                    clearPersistedReasoningWatermark(db, sessionId);
                    // The emergency-drop watermark is keyed to the prior model's
                    // ceiling (contextLimit × executeThreshold), so re-evaluate the
                    // full tail. Clear overflow state only when it is also keyed to
                    // the prior model; a provider error may already have recorded a
                    // detected limit for the outgoing model before stale usage is reset.
                    clearEmergencyDropSample(db, sessionId);
                    if (preserveOutgoingOverflow) {
                        sessionLog(
                            sessionId,
                            `transform: preserving detected limit ${outgoingOverflow.detectedContextLimit} and overflow recovery for outgoing model ${outgoingModelKey}`,
                        );
                    } else {
                        clearDetectedContextLimit(db, sessionId);
                        clearEmergencyRecovery(db, sessionId);
                    }
                    // Clear the in-memory usage map so loadContextUsage recomputes.
                    deps.contextUsageMap.delete(sessionId);
                    sessionMeta = {
                        ...sessionMeta,
                        lastContextPercentage: 0,
                        lastInputTokens: 0,
                        clearedReasoningThroughTag: 0,
                        observedSafeInputTokens: 0,
                        cacheAlertSent: false,
                    };
                }
            }
        }

        logTransformTiming(sessionId, "modelChangeDetection", tModelDetect);
        logTransformTiming(sessionId, "schedulerAndUsage", tModelDetect);
        const tFirstPass = performance.now();
        const isFirstTransformPassForSession = !loadedSessions.has(sessionId);
        loadedSessions.add(sessionId);

        // First-pass reset MUST run BEFORE loadContextUsage so threshold checks
        // (95% blocking, 80% emergency nudge) don't fire on stale data from a
        // different model, reverted message, or previous session state.
        // `persistedUsageBeforeResets` (captured above, before the model-change
        // clear too) holds the pre-reset usage that restart recovery and
        // protected-tail boundary sizing rely on.
        const earlyStateSnapshot = loadTransformPassStateSnapshot(db, sessionId);
        const historianFailureState = earlyStateSnapshot.historianFailure;

        if (isFirstTransformPassForSession && sessionMeta) {
            const persistedPct = sessionMeta.lastContextPercentage ?? 0;
            if (persistedPct > 0) {
                sessionLog(
                    sessionId,
                    `transform: first pass reset — percentage=${persistedPct.toFixed(1)}% — clearing stale usage state`,
                );
                updateSessionMeta(db, sessionId, {
                    lastContextPercentage: 0,
                    lastInputTokens: 0,
                    // Do NOT clear compartmentInProgress here — runCompartmentPhase needs it
                    // to resume a historian run that was in progress when the process restarted.
                    // The compartment phase checks hasEligibleHistoryForCompartment() and either
                    // starts a new run or clears the flag if there's no eligible history.
                });
                // Do NOT clear historian failure state here — restart recovery uses it
                deps.contextUsageMap.delete(sessionId);
                // Update local sessionMeta copy so downstream checks don't use stale values
                sessionMeta = { ...sessionMeta, lastContextPercentage: 0, lastInputTokens: 0 };
            }
        }

        // Compute context usage AFTER first-pass reset so threshold checks use
        // clean state (0%) instead of stale values from a previous model/session.
        let contextUsageEarly = loadContextUsage(
            deps.contextUsageMap,
            db,
            sessionId,
            contextUsagePassSnapshot(sessionMeta),
        );

        let recoveryNoHeadEscapeActive = false;
        let emergencyRecoveryArmed = false;
        let overflowStateMutatedThisPass = false;
        let recoveryNoEligibleHeadCount =
            earlyStateSnapshot.protectedTail.recoveryNoEligibleHeadCount;
        let emergencyRecoveryOrigin: "provider_overflow" | "proactive_model_shrink" | null = null;
        let usagePercentageSynthetic = false;

        // Overflow-triggered emergency recovery: if a prior provider response
        // included a context-overflow error, the event handler persisted
        // needs_emergency_recovery=1. On the very next transform pass we bump
        // the effective percentage to 95% so the existing emergency path
        // (abort + historian + aggressive drops) fires regardless of what
        // pressure math says. Without this, an overflow on a session whose
        // limit resolver over-reported the real limit would never enter the
        // emergency path — we'd just keep hitting the same overflow error.
        //
        // Compaction-off mode: the whole overflow/emergency machinery is
        // gated off — no proactive arming, no synthetic 95% bump, no
        // no-head escape notice. A persisted latch is cleared by the
        // off-transition, never consumed; overflow propagates to native
        // compaction instead.
        if (fullFeatureMode && !compactionOff) {
            try {
                // Proactive arm for a shrinking model switch (large->small
                // context). After switching to a smaller-context model, the
                // last-measured input (produced by the previous, larger model)
                // can already exceed the new model's hard cap. On this first pass
                // the pressure math still reads the OLD model's ratio (well under
                // threshold), so without this the oversized prompt is sent and
                // rejected, and recovery only arms on the NEXT pass from the
                // provider error. Detect it here: if the last input (measured on
                // a DIFFERENT model) exceeds the CURRENT model's catalog cap, the
                // next request will overflow, so arm recovery now and let the bump
                // below compact before the request goes out.
                //
                // Guards (each prevents a gratuitous compaction/cache bust):
                //  - DIFFERENT-model only: lastObservedModelKey !== current. A
                //    same-model "input > limit" is NOT an overflow: that input
                //    was already ACCEPTED under this model, so a now-smaller limit
                //    is cache regression (#179), not a real shrink.
                //  - getSdkContextLimit (NOT resolveTrustedContextLimit): the new
                //    model's catalog/auth cap only, never a detected-overflow
                //    limit. A stale unkeyed detected limit from the old model
                //    could otherwise read low and false-arm.
                //  - flag-only arm: never writes detected_context_limit from a
                //    catalog value (that would pin a stale-low cap).
                const armModel = deps.liveModelBySession?.get(sessionId);
                const armModelKey = deps.getModelKey?.(sessionId);
                const armSnapshot = persistedUsageBeforeResets;
                const lastMeasuredInput =
                    armSnapshot?.usage.inputTokens ?? sessionMeta?.lastInputTokens ?? 0;
                const lastMeasuredModelKey = armSnapshot?.lastObservedModelKey ?? null;
                const armCatalogLimit = armModel
                    ? getSdkContextLimit(armModel.providerID, armModel.modelID)
                    : undefined;
                if (
                    !sessionMeta?.isSubagent &&
                    armModel &&
                    typeof armCatalogLimit === "number" &&
                    armCatalogLimit > 0 &&
                    lastMeasuredInput > armCatalogLimit &&
                    // different-model guard: the prior input was measured on a
                    // model other than the one we're about to send to.
                    lastMeasuredModelKey != null &&
                    armModelKey != null &&
                    piModelRefToCanonical(lastMeasuredModelKey) !==
                        piModelRefToCanonical(armModelKey) &&
                    !earlyStateSnapshot.overflow.needsEmergencyRecovery
                ) {
                    sessionLog(
                        sessionId,
                        `transform: last input ${lastMeasuredInput} (model ${lastMeasuredModelKey}) exceeds new model ${armModelKey} catalog limit ${armCatalogLimit}; arming overflow recovery proactively for the shrinking switch`,
                    );
                    // Flag-only arm: undefined reportedLimit sets
                    // needs_emergency_recovery WITHOUT writing
                    // detected_context_limit.
                    dropSlot(sessionId, "overflow-recovery-arm", deps.compactionOff !== true);
                    recordOverflowDetected(
                        db,
                        sessionId,
                        undefined,
                        armModelKey,
                        "proactive_model_shrink",
                    );
                    // recordOverflowDetected does NOT reset the no-eligible-head
                    // count. A stale count from the prior model would make
                    // noHeadEscape (below) suppress the bump we just armed, so
                    // reset it for a fresh evaluation against the new model.
                    resetProtectedTailNoEligibleHead(db, sessionId);
                    recoveryNoEligibleHeadCount = 0;
                    overflowStateMutatedThisPass = true;
                }

                // A proactive arm is a deliberate write-after-read boundary. Only
                // that path re-reads; otherwise the pass uses its coherent snapshot.
                const overflowState = overflowStateMutatedThisPass
                    ? getOverflowState(db, sessionId)
                    : earlyStateSnapshot.overflow;
                emergencyRecoveryArmed = overflowState.needsEmergencyRecovery;
                emergencyRecoveryOrigin = overflowState.emergencyRecoveryOrigin;
                if (contextUsageEarly.percentage < 80 && !overflowState.needsEmergencyRecovery) {
                    resetProtectedTailNoEligibleHead(db, sessionId);
                    recoveryNoEligibleHeadCount = 0;
                }
                const noHeadEscape =
                    overflowState.needsEmergencyRecovery &&
                    recoveryNoEligibleHeadCount >= RECOVERY_NO_HEAD_LIMIT;
                recoveryNoHeadEscapeActive = noHeadEscape;
                if (
                    overflowState.needsEmergencyRecovery &&
                    contextUsageEarly.percentage < 95 &&
                    !noHeadEscape
                ) {
                    sessionLog(
                        sessionId,
                        `transform: bumping percentage to 95% due to overflow recovery flag (was ${contextUsageEarly.percentage.toFixed(1)}%, detectedLimit=${overflowState.detectedContextLimit || "unknown"})`,
                    );
                    contextUsageEarly = {
                        ...contextUsageEarly,
                        percentage: 95,
                    };
                    usagePercentageSynthetic = true;
                } else if (recoveryNoHeadEscapeActive && deps.client) {
                    void withoutSqliteTransformPass(() =>
                        sendStatusNotification(
                            deps.client,
                            sessionId,
                            "Magic Context can't compact yet — the recent history is a single in-progress block. Continuing; it will compact once the block completes. Run `/ctx-recomp` if this persists.",
                            runNotificationParams(sessionId) ?? {},
                        ),
                    );
                }
            } catch (error) {
                sessionLog(
                    sessionId,
                    "transform: overflow recovery state read failed:",
                    getErrorMessage(error),
                );
                // Without it a provider-overflow latch is not seen, so the
                // emergency drops that shrink an over-limit request never run.
                failPass("overflow-state-read-failure", error);
            }
        }
        // Resolve the model's stable context limit directly so the history
        // budget does not depend on volatile live-usage percentage (which is 0
        // on the first pass after restart). Mirrors how the event handler
        // computes percentage — same (providerID, modelID) + detected-overflow
        // override from session_meta.
        //
        // Model resolution order: the in-memory live map (seeded above from the
        // visible message array) first, then a read-only OpenCode-DB recovery
        // (findLastAssistantModelFromOpenCodeDb) for the case where older
        // messages — including the last assistant tuple — are NOT in the visible
        // array (trimmed window). Without the DB fallback a compartmented
        // session could miss its model on a cold pass and fall back to 60K.
        //
        // We use resolveTrustedContextLimit (NOT resolveContextLimit): it
        // returns a limit only on a real models.dev hit or a detected-overflow
        // limit, and `undefined` for an unknown model. Passing the generic 128K
        // default for an unknown large-context model would shrink history below
        // what the live-usage back-derivation yields — so for unknown models we
        // deliberately fall through to the live-usage path inside the resolver.
        let modelForBudget = deps.liveModelBySession?.get(sessionId);
        if (!modelForBudget) {
            const recovered = host.hostModelFallback(sessionId);
            if (recovered) {
                modelForBudget = recovered;
                // Seed the live map so the scheduler / notification / sidebar
                // paths reuse it this process without re-hitting the DB.
                deps.liveModelBySession?.set(sessionId, recovered);
            }
        }
        // Single pass-local provider resolution for every empty-sentinel producer.
        // A cold pass may recover the model from OpenCode's DB above; hot passes hit
        // the live map. Reusing this value keeps cold/hot output identical and keeps
        // postprocess from making a divergent provider decision later in the pass.
        const resolvedProviderID = modelForBudget?.providerID;
        const canUseEmptySentinels = modelAcceptsEmptyContent(resolvedProviderID);
        const resolvedContextLimit = modelForBudget
            ? resolveTrustedContextLimit(modelForBudget.providerID, modelForBudget.modelID, {
                  db,
                  sessionID: sessionId,
              })
            : undefined;
        const windowGeometry = modelForBudget
            ? resolveContextWindowGeometry(modelForBudget.providerID, modelForBudget.modelID, {
                  db,
                  sessionID: sessionId,
              })
            : undefined;
        // A session Magic Context holds no state for (no compartment and no
        // dropped tag yet) sends its raw history as is, so on its first pass in
        // this process the incoming messages are the request. Nothing else
        // measures that request before it goes out: the usage reading is reset
        // on a first pass, absent for a session never served, and on an
        // OpenCode 2 fork it is the parent's last reply. When the local count
        // is clearly over the model's window, the pass is put in the emergency
        // band, so the historian is started and awaited and the emergency drops
        // run, and the final check below refuses it if that was not enough.
        // Sessions with compartments or drops are not checked here: their
        // incoming array still holds the history and tool output the pass is
        // about to replace, so its size says nothing about the request.
        let unmanagedOverWindowPass: { tokens: number; limit: number } | null = null;
        const unmanagedOverWindowCarried = unmanagedOverWindowSessions.has(sessionId);
        if (
            fullFeatureMode &&
            !compactionOff &&
            typeof resolvedContextLimit === "number" &&
            resolvedContextLimit > 0 &&
            (unmanagedOverWindowCarried ||
                (isFirstTransformPassForSession &&
                    getLastCompartmentEndMessage(db, sessionId) < 0 &&
                    getMaxDroppedTagNumber(db, sessionId) === 0))
        ) {
            try {
                const incoming = estimateFinalWireInputTokens({
                    messages,
                    systemPromptTokens: sessionMeta.systemPromptTokens,
                    providerID: modelForBudget?.providerID,
                    modelID: modelForBudget?.modelID,
                    agentName: runNotificationParams(sessionId)?.agent,
                });
                // The history alone, unscaled: system prompt and tool
                // definitions are not something this pass can reduce, and the
                // fit ratios the estimate applies for unknown models are upper
                // envelopes that would flag sessions that fit.
                const incomingTokens =
                    incoming.messageTokens.conversation + incoming.messageTokens.toolCall;
                // A session refused on an earlier pass stays in the emergency
                // band until a pass is served under the window. Its incoming
                // array can shrink below the margin without the request
                // fitting: on OpenCode 1 the host cuts the visible window at the
                // compaction marker the historian's publication placed, while
                // the system prompt and tool definitions stay as large as ever.
                if (
                    unmanagedOverWindowCarried ||
                    isClearlyOverWindow(incomingTokens, resolvedContextLimit)
                ) {
                    unmanagedOverWindowPass = {
                        tokens: incomingTokens,
                        limit: resolvedContextLimit,
                    };
                    unmanagedOverWindowSessions.add(sessionId);
                    const percentage = (incomingTokens / resolvedContextLimit) * 100;
                    sessionLog(
                        sessionId,
                        `transform: over-window first pass${unmanagedOverWindowCarried ? " (refused before; checked until a pass fits)" : ""}: the incoming history is about ${incomingTokens} tokens (${percentage.toFixed(1)}% of the ${resolvedContextLimit}-token window) and Magic Context has nothing to send in its place; treating the pass as at the emergency band so it is reduced or refused, never sent as is`,
                    );
                    contextUsageEarly = {
                        inputTokens: incomingTokens,
                        percentage: Math.max(95, percentage),
                    };
                    usagePercentageSynthetic = true;
                }
            } catch (error) {
                sessionLog(
                    sessionId,
                    `transform: over-window first-pass check could not estimate the incoming history: ${getErrorMessage(error)}`,
                );
            }
        }
        const emergencyUsagePercentageEarly = usagePercentageSynthetic
            ? Math.max(95, contextUsageEarly.percentage)
            : windowGeometry?.usableHard && contextUsageEarly.inputTokens > 0
              ? (contextUsageEarly.inputTokens / windowGeometry.usableHard) * 100
              : contextUsageEarly.percentage;
        const currentModelKeyForBoundary = deps.getModelKey?.(sessionId);
        const providerProvenLimitForRecovery =
            earlyStateSnapshot.overflow.needsEmergencyRecovery &&
            earlyStateSnapshot.overflow.emergencyRecoveryOrigin === "provider_overflow" &&
            typeof currentModelKeyForBoundary === "string" &&
            currentModelKeyForBoundary.length > 0 &&
            earlyStateSnapshot.overflow.detectedContextLimit > 0 &&
            piModelRefToCanonical(
                earlyStateSnapshot.overflow.detectedContextLimitModelKey ?? "",
            ) === piModelRefToCanonical(currentModelKeyForBoundary)
                ? earlyStateSnapshot.overflow.detectedContextLimit
                : undefined;
        const providerProvenInputForRecovery = persistedUsageBeforeResets?.usage.inputTokens;
        const thresholdContextLimit =
            resolvedContextLimit && resolvedContextLimit > 0
                ? resolvedContextLimit
                : contextUsageEarly.percentage > 0
                  ? contextUsageEarly.inputTokens / (contextUsageEarly.percentage / 100)
                  : undefined;
        const executeThresholdDetail = resolveExecuteThresholdDetail(
            deps.executeThresholdPercentage ?? 65,
            currentModelKeyForBoundary,
            65,
            {
                tokensConfig: deps.executeThresholdTokens,
                contextLimit: thresholdContextLimit,
                sessionId,
            },
        );
        const effectiveExecuteThresholdPercentage = executeThresholdDetail.percentage;
        sessionLog(
            sessionId,
            `transform threshold: model=${currentModelKeyForBoundary ?? "unknown"} matchedModel=${executeThresholdDetail.matchedKey ?? "scalar"} mode=${executeThresholdDetail.mode} threshold=${effectiveExecuteThresholdPercentage}% proactiveFloor=${getProactiveCompartmentTriggerPercentage(effectiveExecuteThresholdPercentage)}%`,
        );
        const { forceMaterializationPercentage } = escalationBands(
            effectiveExecuteThresholdPercentage,
        );
        const persistedUsageFreshForBoundary =
            persistedUsageBeforeResets &&
            Date.now() - persistedUsageBeforeResets.updatedAt <= 10 * 60 * 1000 &&
            (persistedUsageBeforeResets.lastObservedModelKey === null ||
                currentModelKeyForBoundary === undefined ||
                piModelRefToCanonical(persistedUsageBeforeResets.lastObservedModelKey) ===
                    piModelRefToCanonical(currentModelKeyForBoundary)) &&
            (resolvedContextLimit === undefined ||
                persistedUsageBeforeResets.lastUsageContextLimit === 0 ||
                persistedUsageBeforeResets.lastUsageContextLimit === resolvedContextLimit)
                ? persistedUsageBeforeResets.usage
                : null;
        const boundaryUsageForProtectedTail = persistedUsageFreshForBoundary ?? contextUsageEarly;
        const boundaryUsageSource = persistedUsageFreshForBoundary ? "persisted" : "live";

        const historyPolicyIdentity = historyBudgetPolicyIdentity(
            deps.historyBudgetPercentage,
            deps.executeThresholdPercentage,
            currentModelKeyForBoundary,
            deps.executeThresholdTokens,
        );
        // A cold-pass usage reset must not hide the last matched usable window.
        // For catalog-absent models, rendering against the 60K default here would
        // manufacture a larger baseline, then force a shrink on the next pass.
        // A newly resolved live/catalog/overflow limit always takes precedence.
        const historyContextLimit =
            resolvedContextLimit ??
            (currentModelKeyForBoundary &&
            persistedUsageBeforeResets?.lastObservedModelKey &&
            piModelRefToCanonical(currentModelKeyForBoundary) ===
                piModelRefToCanonical(persistedUsageBeforeResets.lastObservedModelKey) &&
            persistedUsageBeforeResets.lastUsageContextLimit > 0
                ? persistedUsageBeforeResets.lastUsageContextLimit
                : undefined);
        const historyBudgetTokens = resolveHistoryBudgetTokens(
            deps.historyBudgetPercentage,
            contextUsageEarly,
            deps.executeThresholdPercentage,
            deps.getModelKey?.(sessionId),
            deps.executeThresholdTokens,
            historyContextLimit,
        );
        // Ceiling for the tiered emergency drop = contextLimit × executeThreshold%
        // (the usable working ceiling, NOT scaled by history_budget_percentage).
        // Resolve the limit the same way resolveHistoryBudgetTokens does: prefer
        // the model's stable limit, else back-derive from live usage. The
        // emergency drop only fires at the derived force band, where percentage is reliably high,
        // so the back-derivation is sound (it would only be unreliable at the
        // percentage=0 cold start, which is far below the trigger). Undefined
        // when neither is available → emergency drop skips, 95% block backstops.
        const emergencyCeilingLimit = thresholdContextLimit ?? 0;
        const emergencyCeilingTokens =
            Number.isFinite(emergencyCeilingLimit) && emergencyCeilingLimit > 0
                ? Math.floor(emergencyCeilingLimit * (effectiveExecuteThresholdPercentage / 100))
                : undefined;
        // Compaction-off: drop scheduling is gated off — the scheduler never
        // approves an execute pass, so no pending-op drain, heuristic cleanup,
        // age sweep or smart drop can fire, and the execute-only
        // lastResponseTime watermark write below stays quiet too.
        const schedulerDecision = compactionOff
            ? ("defer" as const)
            : resolveSchedulerDecision(
                  deps.scheduler,
                  sessionMeta,
                  contextUsageEarly,
                  sessionId,
                  deps.getModelKey?.(sessionId),
                  resolvedContextLimit,
              );
        const schedulerDeferReason =
            schedulerDecision === "defer" ? ("scheduler_defer" as const) : null;
        // Capture explicit history refresh immediately before the first
        // prepareCompartmentInjection consumer and before any drain. This is a
        // per-pass local, not shared deps state: concurrent transforms must not
        // overwrite each other's explicit/deferred attribution.
        //
        // A frozen m[0]/m[1] pass neither sees nor consumes a history refresh:
        // rebuilding history would move the trim past the frozen baseline.
        const historyRefreshExplicitBeforePrepare =
            !freezeM0M1 && deps.historyRefreshSessions.has(sessionId);
        const deferredHistoryWasPendingAtPassStart =
            !freezeM0M1 && deferredHistoryRefreshSessions.has(sessionId);
        const prefixTrimSourceOrder = deferredHistoryWasPendingAtPassStart
            ? capturePrefixTrimSourceOrder(messages)
            : undefined;
        const earlyActiveRunBlocksMaterialization =
            (getActiveCompartmentRun(sessionId) !== undefined ||
                sessionMeta.compartmentInProgress) &&
            contextUsageEarly.percentage < forceMaterializationPercentage;
        const canConsumeDeferredEarly = canConsumeDeferredOnThisPass({
            schedulerDecision,
            contextPercentage: contextUsageEarly.percentage,
            justAwaitedPublication: false,
            activeRunBlocksMaterialization: earlyActiveRunBlocksMaterialization,
            forceMaterializationPercentage,
        });
        const consumingDeferredEarly =
            canConsumeDeferredEarly && deferredHistoryWasPendingAtPassStart;
        const isCacheBusting = historyRefreshExplicitBeforePrepare || consumingDeferredEarly;
        const notificationParams = runNotificationParams(sessionId) ?? {};
        const boundaryContextLimit =
            resolvedContextLimit && resolvedContextLimit > 0
                ? resolvedContextLimit
                : emergencyCeilingLimit > 0
                  ? emergencyCeilingLimit
                  : contextUsageEarly.percentage > 0
                    ? Math.round(
                          contextUsageEarly.inputTokens / (contextUsageEarly.percentage / 100),
                      )
                    : 128_000;
        const boundaryExecuteThreshold = resolveExecuteThreshold(
            deps.executeThresholdPercentage ?? 65,
            deps.getModelKey?.(sessionId),
            65,
            {
                tokensConfig: deps.executeThresholdTokens,
                contextLimit: boundaryContextLimit,
            },
        );
        let _boundarySnapshotCache: ProtectedTailBoundarySnapshot | null | undefined;
        const getRunnableBoundaryForCompartment = (
            emergencyTailScale?: 0.5 | 0.25,
        ): ProtectedTailBoundarySnapshot | null => {
            if (!canRunCompartments) return null;
            if (_boundarySnapshotCache === undefined || emergencyTailScale) {
                const snapshot = host.hostProtectedTailBoundary({
                    db,
                    sessionId: resolvedSessionId,
                    mode: "transform-force",
                    contextLimit: boundaryContextLimit,
                    executeThresholdPercentage: boundaryExecuteThreshold,
                    usage: boundaryUsageForProtectedTail,
                    usageSource: boundaryUsageSource,
                    emergencyTailScale,
                    protectedTailMeta: earlyStateSnapshot.protectedTail,
                });
                if (emergencyTailScale) return snapshot;
                _boundarySnapshotCache = snapshot;
            }
            return _boundarySnapshotCache;
        };
        const getEligibleHistoryForCompartment = (): boolean => {
            const snapshot = getRunnableBoundaryForCompartment();
            if (snapshot !== null && hasRunnableCompartmentWindow(snapshot)) return true;
            if (process.env.NODE_ENV === "test" && !emergencyRecoveryArmed) {
                return hasRunnableCompartmentWindow(
                    createDefaultBoundarySnapshotForTests(sessionId),
                );
            }
            return false;
        };
        const startRecoveryRun = (): boolean => {
            const scale = emergencyUsagePercentageEarly >= 95 ? 0.25 : 0.5;
            let boundarySnapshot = getRunnableBoundaryForCompartment();
            if (!boundarySnapshot || !hasRunnableCompartmentWindow(boundarySnapshot)) {
                boundarySnapshot = getRunnableBoundaryForCompartment(scale);
            }
            if (
                process.env.NODE_ENV === "test" &&
                !emergencyRecoveryArmed &&
                (!boundarySnapshot || !hasRunnableCompartmentWindow(boundarySnapshot))
            ) {
                const legacyTestSnapshot = createDefaultBoundarySnapshotForTests(sessionId);
                if (hasRunnableCompartmentWindow(legacyTestSnapshot)) {
                    boundarySnapshot = legacyTestSnapshot;
                }
            }
            if (
                !canRunCompartments ||
                (!deps.client && !deps.hiddenCompletionExecutor) ||
                !boundarySnapshot ||
                !hasRunnableCompartmentWindow(boundarySnapshot)
            ) {
                return false;
            }
            if (getActiveCompartmentRun(sessionId)) {
                return false;
            }

            updateSessionMeta(db, sessionId, { compartmentInProgress: true });
            startCompartmentAgent({
                client: deps.client,
                hiddenCompletionExecutor: deps.hiddenCompletionExecutor,
                compactionMarkerStrategy: deps.compactionMarkerStrategy,
                db,
                sessionId,
                historianChunkTokens:
                    historianRun?.chunkTokens ?? deps.getHistorianChunkTokens?.() ?? 20_000,
                boundarySnapshot,
                currentContextLimit: boundaryContextLimit,
                historyBudgetTokens,
                historianTimeoutMs: historianRun?.timeoutMs ?? deps.historianTimeoutMs,
                model: historianRun?.model ?? deps.historianModel,
                fallbackModels: historianRun?.fallbackModels ?? deps.fallbackModels,
                directory: compartmentDirectory,
                fallbackModelId,
                getNotificationParams: () => notificationParams,
                experimentalUserMemories:
                    historianRun?.userMemoriesEnabled ?? deps.experimentalUserMemories,
                experimentalTemporalAwareness: deps.experimentalTemporalAwareness,
                historianTwoPass: historianRun?.twoPass ?? deps.historianTwoPass,
                historianExpandTools: historianRun?.expandTools ?? deps.historianExpandTools,
                // Issue #44: gate historian-driven memory promotion so users
                // who disable the feature actually see no memories created.
                memoryEnabled: deps.memoryConfig?.enabled,
                autoPromote: historianRun?.autoPromote ?? deps.memoryConfig?.autoPromote,
                ensureProjectRegistered: deps.ensureProjectRegistered,
                // Historian publication invalidates the injection cache AND
                // changes compartments/facts that render into message[0]. We
                // signal:
                //   - deferredHistoryRefreshSessions: rebuilds only when a
                //     materializing pass can consume history + drops together.
                //   - deferredMaterializationSessions: queues drops that
                //     historian published until heuristics actually run.
                // We deliberately do NOT signal systemPromptRefreshSessions —
                // historian doesn't change disk-backed adjuncts (docs/profile/
                // key-files), so re-reading them would burn IO for nothing.
                preserveInjectionCacheUntilConsumed: true,
                onCompartmentStatePublished: (sid) => {
                    deferredHistoryRefreshSessions.add(sid);
                    deferredMaterializationSessions.add(sid);
                },
            });
            return true;
        };

        if (
            fullFeatureMode &&
            !compactionOff &&
            historianFailureState.failureCount > 0 &&
            emergencyUsagePercentageEarly >= 95 &&
            !recoveryNoHeadEscapeActive
        ) {
            const emergencyPercentage = contextUsageEarly.percentage.toFixed(1);
            const recoveryStarted = startRecoveryRun();
            // If recovery can't start because there is no eligible pre-tail
            // history to compact, the runner no-op that normally counts this
            // condition never fires. Count it here too so a genuinely in-progress
            // tail can escape the abort loop after a bounded number of passes;
            // keep recovery armed so compaction still happens once the arc closes.
            if (!recoveryStarted && !getEligibleHistoryForCompartment()) {
                const noHeadSnapshot =
                    getRunnableBoundaryForCompartment(
                        emergencyUsagePercentageEarly >= 95 ? 0.25 : 0.5,
                    ) ?? getRunnableBoundaryForCompartment();
                if (noHeadSnapshot) {
                    recordHighPressureNoEligibleHead(db, noHeadSnapshot);
                }
                sessionLog(
                    sessionId,
                    "transform: emergency recovery remains armed — no complete eligible head before protected tail",
                );
            }
            sessionLog(
                sessionId,
                `EMERGENCY: historian recovery requested at ${emergencyPercentage}%, failures: ${historianFailureState.failureCount}`,
            );
        } else if (
            fullFeatureMode &&
            !compactionOff &&
            isFirstTransformPassForSession &&
            historianFailureState.failureCount > 0 &&
            getEligibleHistoryForCompartment() &&
            startRecoveryRun()
        ) {
            sessionLog(
                sessionId,
                `transform: historian recovery triggered on session load after ${historianFailureState.failureCount} failure(s)`,
            );
            if (deps.client) {
                void withoutSqliteTransformPass(() =>
                    sendStatusNotification(
                        deps.client,
                        sessionId,
                        `## Historian recovery\n\nHistorian previously failed ${historianFailureState.failureCount} time(s), so Magic Context is retrying history comparting immediately after restart.`,
                        notificationParams,
                    ),
                );
            }
        }

        logTransformTiming(sessionId, "emergencyRecoveryBlock", tFirstPass);

        // Resolve project identity ONCE per transform pass. Used by both
        // prepareCompartmentInjection (memory filtering by project) and
        // runCompartmentPhase (historian memory resolution). Computing it
        // twice per turn is wasteful — resolveProjectIdentity caches by
        // directory but still does a cache lookup on each call, and the
        // first call per directory in a new process spawns `git rev-list`.
        const memoryProjectDirectory = compartmentDirectory || process.cwd();
        const projectIdentity = deps.memoryConfig?.enabled
            ? resolveProjectIdentityForSession(memoryProjectDirectory, deps.allowHomeProject)
            : undefined;
        if (deps.memoryConfig?.enabled) {
            maybeSendProjectIdentityWarning(
                deps,
                sessionId,
                memoryProjectDirectory,
                notificationParams,
            );
        }
        // Session-scoped project identity for note-nudge and auto-search, which
        // must target the SESSION's project — not the launch cwd. `deps.projectPath`
        // is resolved once at hook init from the launch directory; on
        // `opencode -s <id>` started from a different repo it points at the wrong
        // project, so note nudges and auto-search would query the launch project's
        // notes/memories. Reuse the memory identity when memory is enabled
        // (identical value, no extra resolve); otherwise resolve from the session
        // directory, falling back to the launch identity only when unavailable.
        // resolveProjectIdentity is per-directory cached, so the common case
        // (session dir == launch dir) costs nothing extra.
        const sessionProjectIdentity =
            projectIdentity ??
            (sessionDirectory
                ? resolveProjectIdentityForSession(sessionDirectory, deps.allowHomeProject)
                : deps.projectPath);
        const sessionIdentityForBinding = sessionDirectory
            ? resolveProjectIdentityForSession(sessionDirectory, deps.allowHomeProject)
            : undefined;
        if (sessionDirectory) {
            maybeSendProjectIdentityWarning(deps, sessionId, sessionDirectory, notificationParams);
        }
        // Keep the marker lookup in the same identity vocabulary that Rust authority
        // setup used: memory-enabled projects use their MC identity, never a raw path.
        // Scheduling only starts background recovery; this transform continues normally.
        const authorityProjectPath =
            (deps.memoryConfig?.enabled ? projectIdentity : undefined) ??
            deps.projectPath ??
            sessionProjectIdentity;
        if (authorityProjectPath) {
        }
        // Persist only host-resolved session bindings. The launch-directory
        // fallback keeps transforms non-fatal, but storing it as ownership would
        // let a transient SDK failure permanently mis-scope chunk backfills.
        // Guarded to fire once per (session, identity) in this process so the
        // hot path carries no per-pass DB write once the binding is recorded.
        if (
            sessionIdentityForBinding &&
            sessionDirectoryResolvedFromHost &&
            recordedSessionProjectIdentity.get(sessionId) !== sessionIdentityForBinding
        ) {
            recordSessionProjectIdentity(db, sessionId, sessionIdentityForBinding);
            recordedSessionProjectIdentity.set(sessionId, sessionIdentityForBinding);
        }

        // Historian trigger decision — relocated here from the message.updated
        // event handler. The event handler has no message array, so it re-read
        // the session tail from opencode.db on EVERY streaming delta (~186ms of
        // synchronous SQLite per event on a large session, freezing the event
        // loop and making parallel hooks like tool.definition measure seconds).
        // The transform already receives the post-compaction-marker tail —
        // the exact eligible window — as parsed objects, so the inspection runs
        // from memory with zero opencode.db reads (live-verified byte-identical
        // boundary on every decision field before the cutover). Cadence is
        // once per LLM request (this hook) instead of per streaming delta,
        // which is when the decision inputs actually change. Runs here because
        // `messages` is still the clean pre-injection, pre-mutation tail.
        // On shouldFire we set the flag AND mutate the local sessionMeta so
        // runCompartmentPhase starts the historian in this same pass (the same
        // pass it would have started under the event-handler flow). The
        // resolved boundary snapshot is handed through so the phase doesn't
        // re-resolve it.
        // Tag load-scoping floor: derived once per pass from the raw wire ids and
        // reused by the trigger's tag scans (below) AND the tagger initFromDb
        // (later). Computed here — NOT inside the trigger from inMemoryTail —
        // because the trigger's in-memory tail is gated on the compaction-marker
        // anchor and bails (undefined) post-restart / during marker-drain lag;
        // the floor only needs the leading wire ids, which are always present, so
        // deriving it here keeps both tag scans scoped on every pass (those
        // anchor-miss passes were the residual ~90ms full-scan regression).
        const taggerFloor = compactionOff ? 0 : deriveTaggerLoadFloor(messages, sessionId, db);
        // floor 0 = no leading wire message resolved to a tag → BOTH tag scans
        // (tagger initFromDb + the trigger's token scans) fall back to the full
        // ~O(session) load. On a large session that's the ~70ms compartmentTrigger
        // we are trying to avoid, so surface it as a one-line health signal rather
        // than letting it hide as silent latency.
        if (!compactionOff && taggerFloor === 0 && messages.length > 0) {
            sessionLog(
                sessionId,
                `tag floor: 0 (full-scan fallback) — no leading wire message resolved a tag across ${messages.length} msgs`,
            );
        }

        let triggerBoundarySnapshot: ProtectedTailBoundarySnapshot | undefined;
        if (
            fullFeatureMode &&
            !compactionOff &&
            historianRunnable &&
            !sessionMeta.compartmentInProgress
        ) {
            const tTrigger = performance.now();
            try {
                const inMemoryTail = buildTriggerInMemoryTail(
                    db,
                    sessionId,
                    extractInMemoryMessageViews(messages),
                );
                const triggerResult = checkCompartmentTrigger(
                    db,
                    sessionId,
                    sessionMeta,
                    boundaryUsageForProtectedTail,
                    sessionMeta.lastContextPercentage,
                    boundaryExecuteThreshold,
                    deriveTriggerBudget(boundaryContextLimit, boundaryExecuteThreshold),
                    deps.clearReasoningAge,
                    historianRun?.commitClusterTrigger ?? deps.commitClusterTrigger,
                    undefined,
                    boundaryContextLimit,
                    inMemoryTail,
                    taggerFloor,
                    { providerID: resolvedProviderID },
                    {
                        hardFold: false,
                        force:
                            contextUsageEarly.percentage >= forceMaterializationPercentage &&
                            (contextUsageEarly.percentage >= 95 ||
                                getEmergencyInputSample(db, sessionId) === 0),
                        explicitFlush: deps.pendingMaterializationSessions.has(sessionId),
                        publishedHistory: isCacheBusting,
                    },
                );
                if (triggerResult.shouldFire) {
                    sessionLog(
                        sessionId,
                        `compartment trigger: firing (reason=${triggerResult.reason})`,
                    );
                    updateSessionMeta(db, sessionId, { compartmentInProgress: true });
                    sessionMeta.compartmentInProgress = true;
                    triggerBoundarySnapshot = triggerResult.boundarySnapshot;
                }
            } catch (error) {
                passOutcome.record("compartment-trigger-failure");
                sessionLog(sessionId, "compartment trigger failed (non-fatal):", error);
            }
            logTransformTiming(sessionId, "compartmentTrigger", tTrigger);
        }

        let pendingCompartmentInjection: PreparedCompartmentInjection | null = null;
        let rebuiltHistoryFromInitialPrepare = false;
        let hiddenMessagesAtCompactionSeam: MessageLike[] = [];
        let trimmedMessagesAtCompactionBoundary: MessageLike[] = [];
        const messagesBeforeInitialPrepare =
            isCacheBusting && deferredHistoryWasPendingAtPassStart ? [...messages] : null;
        // Compaction-off bypasses compartment-history preparation entirely,
        // even when historical compartment rows exist: no <session-history>
        // render, no raw-tail trim, no boundary splice, no marker write.
        // Memory/docs surfaces materialize independently through the
        // zero-compartment m[0]/m[1] path in postprocess.
        if (fullFeatureMode && !compactionOff) {
            const tInj = performance.now();
            pendingCompartmentInjection = prepareCompartmentInjection(
                db,
                sessionId,
                messages,
                isCacheBusting,
                projectIdentity,
                deps.memoryConfig?.injectionBudgetTokens,
                deps.experimentalTemporalAwareness,
            );
            if (messagesBeforeInitialPrepare) {
                const skippedVisibleMessages =
                    pendingCompartmentInjection?.skippedVisibleMessages ?? 0;
                trimmedMessagesAtCompactionBoundary = messagesBeforeInitialPrepare.slice(
                    0,
                    skippedVisibleMessages,
                );
                hiddenMessagesAtCompactionSeam = selectHiddenMessagesAtCompactionSeam(
                    messagesBeforeInitialPrepare,
                    skippedVisibleMessages,
                );
            }
            logTransformTiming(sessionId, "prepareCompartmentInjection", tInj);

            // ── Drain historyRefreshSessions (one-shot semantics) ──
            // The injection rebuild — the only consumer of this signal in
            // the messages-transform path — has now run. Future defer
            // passes within the same TTL window MUST hit the cached
            // injection result so the Anthropic prompt-cache prefix
            // stays stable. The captured local `isCacheBusting` const
            // above retains its value for downstream background-compressor
            // gating, so this drain doesn't affect later behavior in this
            // pass — only future passes.
            //
            // This is the core of the Oracle 2026-04-26 fix: the previous
            // single-set design left the flush flag alive whenever
            // compartmentRunning blocked heuristics, so every defer pass
            // re-fired prepareCompartmentInjection with isCacheBusting=true
            // and burned cache reuse for nothing.
            if (isCacheBusting) {
                // Cache-busting pass invoked prepareCompartmentInjection. Treat
                // this as a history rebuild regardless of whether the prepare
                // returned a populated injection — even a null result (no
                // compartments yet) consumes the deferred-history signal
                // because the next pass will get a fresh prepare. The
                // separate `compartmentInjectionRebuiltFromDb` flag (plan v6)
                // exposes the narrower "real rebuild happened" signal to
                // postprocess for the marker-drain decision.
                rebuiltHistoryFromInitialPrepare = true;
            }
            if (historyRefreshExplicitBeforePrepare) {
                deps.historyRefreshSessions.delete(sessionId);
            }
        }

        let targets = new Map<number, TagTarget>();
        // ──────────────────────────────────────────────────────────────────────

        let reasoningByMessage = new Map<
            MessageLike,
            { type: string; thinking?: string; text?: string }[]
        >();
        let messageTagNumbers = new Map<MessageLike, number>();
        let batch: { finalize: () => void } | null = null;
        let hasRecentReduceCall = false;
        // Replay before tagging. New choices wait for the independently priced
        // rebuild permission in postprocess; a cut never recomputes an old gap.
        let temporalObservedDecisions: ReadonlyMap<string, string> | undefined;
        if (deps.experimentalTemporalAwareness && !compactionOff) {
            const tTemporal = performance.now();
            temporalObservedDecisions = observeTemporalDecisions(
                db,
                sessionId,
                temporalCandidates ?? new Map(),
                (ids) => readServedTemporalDecisions(db, sessionId, "opencode", ids),
                temporalReplayIds,
            );
            const injected = injectTemporalMarkers(messages, temporalObservedDecisions);
            if (injected > 0) {
                sessionLog(sessionId, `temporal: injected ${injected} gap markers`);
            }
            logTransformTiming(sessionId, "injectTemporalMarkers", tTemporal);
        }

        let taggingSucceeded = false;
        // Compaction-off mode: the tagger writes ZERO tag rows and emits no
        // §N§ prefixes (spec #266 decision #6). Every consumer of the tag
        // walk's outputs (drops, heuristics, nudges, caveman, flushed-status
        // replay) is itself gated off in this mode, so the whole walk is
        // skipped — no rows, no prefixes, no commit scan. Flip-back
        // self-heals: the tagger lazily mints on first observation of
        // untagged wire content once this gate reopens.
        if (!compactionOff) {
            try {
                const t0 = performance.now();
                const tInitFromDb = performance.now();
                // taggerFloor was derived once above (before the trigger block) and is
                // reused here so the tagger map and the trigger's tag scans scope to
                // the identical live-wire floor.
                deps.tagger.initFromDb(sessionId, db, taggerFloor);
                logTransformTiming(sessionId, "tag.initFromDb", tInitFromDb);
                // Skip §N§ prefix injection only when ctx_reduce is unavailable in
                // this session's tool allow-list. Subagents with the tool DO get
                // prefixes now — they self-manage tool bloat. DB tag records are
                // maintained either way so heuristics and drops continue to work;
                // only the agent-visible prefix is gated.
                const skipPrefixInjection = !ctxReduceCallable;
                // History preparation trims a prefix before the compaction marker is
                // written later in this pass. OpenCode uses that new marker to build
                // the next request, where rows hidden only from this transform can
                // return. Tag the pre-trim objects now so persisted drops mutate them
                // and postprocess can save their empty-sentinel decisions. Ordinary
                // passes keep the smaller post-trim walk.
                const messagesForTagging =
                    messagesBeforeInitialPrepare && hiddenMessagesAtCompactionSeam.length > 0
                        ? messagesBeforeInitialPrepare
                        : messages;
                const canAdoptScopedToolSweep = isCacheBusting || canConsumeDeferredEarly;
                // A pass that may not change bytes and has not adopted yet
                // cannot pick a sweep from a default: which array this session
                // was last served decides it. The resolver runs at finalize,
                // where both candidate arrays exist.
                const scopedToolSweep = useScopedToolSweep(db, sessionId, canAdoptScopedToolSweep)
                    ? true
                    : createPreAdoptionToolSweepResolver(db, sessionId);
                const result = tagMessages(sessionId, messagesForTagging, deps.tagger, db, {
                    skipPrefixInjection,
                    scopedToolSweep,
                    servedMessages: messages,
                });
                targets = result.targets;
                reasoningByMessage = result.reasoningByMessage;
                messageTagNumbers = result.messageTagNumbers;
                batch = result.batch;
                // The forced call skeleton beside reasoning protects Anthropic
                // signed turns from merging (issue 423). Other routes have no
                // such rule, so their drops remove the whole pair. An unknown
                // provider keeps the protective skeleton.
                if (
                    resolvedProviderID &&
                    !isAnthropicFamilyRoute(resolvedProviderID, modelForBudget?.modelID)
                ) {
                    for (const target of targets.values()) {
                        if (target.requiresToolArcSkeleton) target.requiresToolArcSkeleton = false;
                    }
                }
                hasRecentReduceCall = result.hasRecentReduceCall;
                observeCommitNudgeTransition(sessionId, result.hasRecentCommit, !fullFeatureMode);
                logTransformTiming(sessionId, "tagMessages", t0);
                taggingSucceeded = true;
            } catch (error) {
                sessionLog(
                    sessionId,
                    "transform tag persistence failed; not serving this pass:",
                    error,
                );
                // Drop in-memory tagger state for this session so the next pass
                // re-loads from the DB. Without this, a stale counter or stale
                // assignments map can keep producing the same UNIQUE collision
                // turn after turn until the process restarts. With the DB-
                // authoritative allocation in tagger.assignTag, a fresh load
                // typically self-heals in one pass.
                try {
                    deps.tagger.cleanup(sessionId);
                } catch (cleanupError) {
                    sessionLog(sessionId, "tagger cleanup after failure threw:", cleanupError);
                }
                // Without tag targets none of the session's persisted drops,
                // truncations, reasoning clears or caveman rewrites can be
                // replayed, so this pass would send the conversation unreduced.
                // A busy writer goes to the storage-busy path; any other error
                // (a UNIQUE collision, for example) is refused the same way.
                failPass("tagging-persistence-failure", error);
            }
        }

        // Load only the tag subsets each consumer can act on:
        //   activeTags          → heuristic cleanup, nudger and caveman replay.
        //                         Caveman further filters to visible message tags
        //                         with persisted compression depth > 0.
        //   targetsSliceTags    → applyFlushedStatuses: dropped visible targets
        //                         only, using the dropped-tag partial index.
        //   maxDroppedTagNumber → watermark via a single MAX() aggregate.
        // Fetching active/compacted rows again for status replay would hydrate
        // the whole visible window just to discard those rows in its drop gate.
        const t1 = performance.now();
        const activeTags = compactionOff ? [] : getActiveTagsBySession(db, sessionId);
        logTransformTiming(sessionId, "getActiveTagsBySession", t1, `count=${activeTags.length}`);

        const t1b = performance.now();
        const targetTagNumbers = [...targets.keys()];
        const targetsSliceTags = compactionOff
            ? []
            : getDroppedTagsByNumbers(db, sessionId, targetTagNumbers);
        logTransformTiming(
            sessionId,
            "getDroppedTagsByNumbers",
            t1b,
            `targets=${targetTagNumbers.length} fetched=${targetsSliceTags.length}`,
        );

        let didMutateFromFlushedStatuses = false;
        // Only run mutation stages when tagging succeeded. With targets={}
        // applyFlushedStatuses can't drive any of the persisted drops/
        // truncates/source restores it's responsible for, and running it
        // anyway risks fanning out partial work that can't be undone on the
        // next pass. Skip it cleanly so the session enters the next pass
        // with consistent state and the next initFromDb refresh re-binds
        // tags from the DB.
        if (taggingSucceeded) {
            try {
                const t2 = performance.now();
                didMutateFromFlushedStatuses = applyFlushedStatuses(
                    sessionId,
                    db,
                    targets,
                    targetsSliceTags,
                );
                logTransformTiming(sessionId, "applyFlushedStatuses", t2);
                batch?.finalize();
                logTransformTiming(sessionId, "batchFinalize:flushed", t2);
            } catch (error) {
                sessionLog(sessionId, "transform failed applying flushed statuses:", error);
                // The replay mutates messages as it goes and has no rollback, so
                // some persisted drops may be applied and others not.
                failPass("flushed-status-failure", error);
            }
        }

        const t3 = performance.now();
        // Empty text part sentinels are safe only for canonical Anthropic, where
        // OpenCode filters them before the wire. Other providers keep native
        // structural parts so an empty text block cannot break tool adjacency.
        const strippedStructuralNoise =
            canUseEmptySentinels && !compactionOff ? stripStructuralNoise(messages) : 0;
        logTransformTiming(
            sessionId,
            "stripStructuralNoise",
            t3,
            `strippedParts=${strippedStructuralNoise}`,
        );

        // Tagging restores pristine source on every request, so replay persisted
        // caveman compression even when no new cleanup is allowed. Replay it before
        // inline-reasoning removal: compression would otherwise bring back thinking
        // that an earlier request removed. Fresh cleanup uses the same ordering.
        if (!reducedMode && !compactionOff && deps.cavemanTextCompression?.enabled) {
            const tCavemanReplay = performance.now();
            const replayedCaveman = replayCavemanCompression(sessionId, db, targets, activeTags);
            if (replayedCaveman > 0) {
                sessionLog(sessionId, `caveman replay: re-applied ${replayedCaveman} text tags`);
            }
            logTransformTiming(sessionId, "replayCavemanCompression", tCavemanReplay);
        }

        // Replay persisted reasoning clearing on EVERY pass (including defer).
        // This ensures reasoning cleared on a previous cache-busting pass stays cleared
        // even when OpenCode rebuilds messages fresh from its own DB.
        const persistedReasoningWatermark = sessionMeta?.clearedReasoningThroughTag ?? 0;
        if (persistedReasoningWatermark > 0 && !compactionOff) {
            const tReplay = performance.now();
            // Typed reasoning replay is canonical-Anthropic-only, matching the
            // clearOldReasoning WRITE gate (transform-postprocess-phase.ts). The
            // watermark can outlive a provider switch (anthropic → proxy), so
            // gating the replay on the CURRENT provider prevents re-applying
            // "[cleared]" reasoning text onto a non-canonical Claude proxy wire.
            // Inline-thinking replay stays provider-independent — it strips
            // literal <thinking> tags from text, never typed reasoning parts.
            const replayed = canUseEmptySentinels
                ? replayClearedReasoning(
                      messages,
                      reasoningByMessage,
                      messageTagNumbers,
                      persistedReasoningWatermark,
                  )
                : 0;
            const replayedInline = replayStrippedInlineThinking(
                messages,
                messageTagNumbers,
                persistedReasoningWatermark,
            );
            if (replayed > 0 || replayedInline > 0) {
                sessionLog(
                    sessionId,
                    `reasoning replay: cleared=${replayed} inlineStripped=${replayedInline} (watermark=${persistedReasoningWatermark})`,
                );
            }
            logTransformTiming(sessionId, "replayReasoningClearing", tReplay);
        }

        const t4 = performance.now();
        // `clearOldReasoning` replays `[cleared]` as native reasoning text for all
        // providers. Only Anthropic may replace those shells with empty text
        // sentinels; other providers can forward the empty part to the wire.
        const strippedClearedReasoning =
            canUseEmptySentinels && !compactionOff ? stripClearedReasoning(messages) : 0;
        logTransformTiming(
            sessionId,
            "stripClearedReasoning",
            t4,
            `strippedParts=${strippedClearedReasoning}`,
        );

        // Watermark = highest dropped tag_number for this session. Backed by
        // the partial index `idx_tags_dropped_session_tag_number` (migration
        // v8) so SQLite resolves this with a single backward index seek
        // instead of the full-array scan we used to do here.
        const watermark = getMaxDroppedTagNumber(db, sessionId);

        let contextUsage = contextUsageEarly;
        const rawGetNotifParams = runNotificationParams;
        const tCompartmentPhase = performance.now();
        const compartmentPhase = await runCompartmentPhase({
            hiddenCompletionExecutor: deps.hiddenCompletionExecutor,
            compactionMarkerStrategy: deps.compactionMarkerStrategy,
            canRunCompartments,
            fullFeatureMode,
            compactionOff,
            historianRunnable,
            sessionMeta,
            contextUsage,
            boundaryContextLimit,
            boundaryExecuteThresholdPercentage: boundaryExecuteThreshold,
            boundaryUsage: boundaryUsageForProtectedTail,
            boundaryUsageSource,
            preResolvedBoundarySnapshot: triggerBoundarySnapshot,
            client: deps.client,
            db,
            sessionId,
            resolvedSessionId,
            historianChunkTokens:
                historianRun?.chunkTokens ?? deps.getHistorianChunkTokens?.() ?? 20_000,
            historyBudgetTokens,
            historianTimeoutMs: historianRun?.timeoutMs ?? deps.historianTimeoutMs,
            historianModel: historianRun?.model ?? deps.historianModel,
            historianContextLimit: historianRun?.contextLimit ?? deps.historianContextLimit,
            historianMaxOutputTokens: historianRun
                ? historianRun.maxOutputTokens
                : deps.historianMaxOutputTokens,
            fallbackModels: historianRun?.fallbackModels ?? deps.fallbackModels,
            compartmentDirectory,
            messages,
            pendingCompartmentInjection,
            fallbackModelId,
            projectPath: projectIdentity,
            injectionBudgetTokens: deps.memoryConfig?.injectionBudgetTokens,
            getNotificationParams: rawGetNotifParams
                ? () => rawGetNotifParams(sessionId)
                : undefined,
            // The compressor needs to know if this is a safe pass to run on.
            // Scheduler "execute" passes are safe for compressor (they already bust cache
            // via pending ops); snapshot-drain keeps same-pass compressor signals safe.
            safeForBackgroundCompression:
                historianRunnable && (isCacheBusting || schedulerDecision === "execute"),
            deferredHistoryRefreshSessions,
            experimentalUserMemories:
                historianRun?.userMemoriesEnabled ?? deps.experimentalUserMemories,
            experimentalTemporalAwareness: deps.experimentalTemporalAwareness,
            historianTwoPass: historianRun?.twoPass ?? deps.historianTwoPass,
            historianExpandTools: historianRun?.expandTools ?? deps.historianExpandTools,
            // Issue #44: forward memory gating so the normal historian path
            // (not just the recovery path above) honors memory.enabled and
            // memory.auto_promote.
            memoryEnabled: deps.memoryConfig?.enabled,
            autoPromote: historianRun?.autoPromote ?? deps.memoryConfig?.autoPromote,
            ensureProjectRegistered: deps.ensureProjectRegistered,
            // See startRecoveryRun above for the full rationale —
            // historian/recomp publication signals history rebuild +
            // pending materialization, but NOT system-prompt adjuncts.
            onCompartmentStatePublished: (sid) => {
                deferredHistoryRefreshSessions.add(sid);
                deferredMaterializationSessions.add(sid);
            },
        });
        pendingCompartmentInjection = compartmentPhase.pendingCompartmentInjection;
        const awaitedCompartmentRun = compartmentPhase.awaitedCompartmentRun;
        const compartmentInProgress = compartmentPhase.compartmentInProgress;
        sessionMeta = { ...sessionMeta, compartmentInProgress };
        logTransformTiming(sessionId, "compartmentPhase", tCompartmentPhase);

        // Layer-B fallback (#264): the injection stayed degraded and no durable
        // compartment boundary is visible, so there was no safe re-anchor splice.
        // Queue a fresh materialization so the baseline is re-cut on the next
        // bust instead of the session silently looping in degraded mode.
        if (pendingCompartmentInjection?.needsFreshMaterialization) {
            deps.pendingMaterializationSessions.add(sessionId);
            deferredMaterializationSessions.add(sessionId);
        }

        // HARD-bust signals for the m[0]/m[1] materialization decision capture
        // provider-side cache eviction, such as a model switch or system-block
        // change, plus the TTL idle window. The tool-set fingerprint is observed
        // alongside them but never folds m[0] because its process-global scope
        // would create false-positive folds across sessions. When system.transform
        // follows messages.transform, systemHash is the persisted last-turn hash;
        // a warm system change is then detected on the next pass.
        const hardModel = deps.liveModelBySession?.get(sessionId);
        const hardModelKey = hardModel ? `${hardModel.providerID}/${hardModel.modelID}` : "";
        const hardToolSetHash = deps.getToolSetHash?.(sessionId) ?? "";
        const hardSystemHash =
            typeof sessionMeta.systemPromptHash === "string" ? sessionMeta.systemPromptHash : "";
        const hardCacheExpired = computeHardCacheExpired(
            sessionMeta.cacheTtl,
            sessionMeta.lastResponseTime,
            Date.now(),
            (error) => {
                passOutcome.record("invalid-cache-ttl-fallback");
                sessionLog(sessionId, "invalid cache_ttl; using the 5m default:", error);
            },
        );
        const m0HardSignals = {
            systemHash: hardSystemHash,
            toolSetHash: hardToolSetHash,
            modelKey: hardModelKey,
            cacheExpired: hardCacheExpired,
            lastResponseTime: sessionMeta.lastResponseTime,
            ...(hostCompaction ? { hostCompaction } : {}),
        };

        const lateActiveRunBlocksMaterialization =
            getActiveCompartmentRun(sessionId) !== undefined &&
            contextUsageEarly.percentage < forceMaterializationPercentage;
        const canConsumeDeferredLate = canConsumeDeferredOnThisPass({
            schedulerDecision,
            contextPercentage: contextUsageEarly.percentage,
            justAwaitedPublication: compartmentPhase.justAwaitedPublication,
            activeRunBlocksMaterialization: lateActiveRunBlocksMaterialization,
            forceMaterializationPercentage,
        });
        const wasEmergencyBlock =
            contextUsageEarly.percentage >= forceMaterializationPercentage &&
            compartmentPhase.justAwaitedPublication;
        const historyRebuiltThisPass = wasEmergencyBlock
            ? compartmentPhase.rebuiltHistoryThisPass
            : rebuiltHistoryFromInitialPrepare || compartmentPhase.rebuiltHistoryThisPass;

        const protectionFoldWillBust =
            !freezeM0M1 &&
            (!!projectIdentity || !!sessionDirectory) &&
            (fullFeatureMode || compactionOff) &&
            mustMaterialize({
                db,
                sessionId,
                state: sessionMeta,
                projectPath: projectIdentity,
                projectDirectory: sessionDirectory,
                injectDocs: deps.injectDocs,
                memoryEnabled: deps.memoryConfig?.enabled,
                muralEnabled: deps.muralEnabled,
                memoryInjectionBudgetTokens: deps.memoryConfig?.injectionBudgetTokens,
                historyBudgetTokens,
                historyBudgetPolicyIdentity: historyPolicyIdentity,
                hardSignals: m0HardSignals,
            }).value;
        const protectionCacheBustingPass =
            !compactionOff &&
            (schedulerDecision === "execute" ||
                isCacheBusting ||
                contextUsage.percentage >= forceMaterializationPercentage ||
                deps.pendingMaterializationSessions.has(sessionId) ||
                (canConsumeDeferredLate && deferredMaterializationSessions.has(sessionId)) ||
                protectionFoldWillBust);
        const calibrationBustReason = protectionFoldWillBust
            ? "fold"
            : contextUsage.percentage >= forceMaterializationPercentage
              ? "force"
              : deps.pendingMaterializationSessions.has(sessionId)
                ? "flush"
                : consumingDeferredEarly || compartmentPhase.justAwaitedPublication
                  ? "refresh"
                  : schedulerDecision === "execute"
                    ? "execute"
                    : "unknown";
        sessionDecisionCalibration(db, sessionId, {
            bustPermitted: protectionCacheBustingPass,
            modelKey: hardModelKey || currentModelKeyForBoundary,
            bustReason: calibrationBustReason,
            onAdopt: (message) => sessionLog(sessionId, message),
        });
        // A cache-busting pass can lack input-token usage for the selected model
        // after a switch or overflow. Estimate from the transformed payload so
        // emergency tool-output reclaim does not skip the pass as unknown usage.
        if (contextUsage.inputTokens <= 0 && protectionCacheBustingPass) {
            try {
                const pressureEstimate = estimateFinalWireInputTokens({
                    messages,
                    systemPromptTokens: sessionMeta.systemPromptTokens,
                    providerID: modelForBudget?.providerID,
                    modelID: modelForBudget?.modelID,
                    agentName: notificationParams.agent,
                });
                contextUsage = resolveUnknownUsageFromWireEstimate({
                    usage: contextUsage,
                    pricedPass: true,
                    wireEstimateTokens: pressureEstimate.tokens,
                    wireEstimateTrusted: pressureEstimate.trusted,
                    providerProvenInputTokens: providerProvenInputForRecovery,
                    providerProvenLimitTokens: providerProvenLimitForRecovery,
                    usableHardLimit: windowGeometry?.usableHard,
                });
                if (contextUsage.inputTokens > 0) {
                    const usedProviderInput =
                        !pressureEstimate.trusted &&
                        providerProvenLimitForRecovery !== undefined &&
                        providerProvenInputForRecovery !== undefined &&
                        contextUsage.inputTokens >= providerProvenInputForRecovery;
                    sessionLog(
                        sessionId,
                        `transform: unknown provider usage; using ${usedProviderInput ? "provider-proven input" : "wire estimate"} for priced pass inputTokens=${contextUsage.inputTokens} percentage=${contextUsage.percentage.toFixed(1)} trusted=${pressureEstimate.trusted} wireTokens=${pressureEstimate.tokens}`,
                    );
                }
            } catch (error) {
                sessionLog(
                    sessionId,
                    `transform: wire-estimate pressure fallback unavailable: ${getErrorMessage(error)}`,
                );
            }
        }
        const protectionUsableSoft = windowGeometry?.usableSoft ?? boundaryContextLimit;
        const protectionFloor = resolveEpochFloorForPass(db, sessionId, {
            configuredOverride: deps.protectedTokens,
            tierOverrides: deps.protectedTokenTierOverrides,
            usableSoft: protectionUsableSoft,
            isCacheBustingPass: protectionCacheBustingPass,
            onRejectedProjectOverride: (warning) => sessionLog(sessionId, warning),
        });
        if (protectionFloor.snapshotChanged) {
            sessionLog(
                sessionId,
                `protected token floor snapshot: floor=${protectionFloor.floor} provenance=${protectionFloor.provenance === "override" ? "absolute" : protectionFloor.provenance} usableSoft=${protectionUsableSoft}`,
            );
        } else if (protectionFloor.preSnapshotInputChanged) {
            sessionLog(
                sessionId,
                `protected token floor remains frozen until next priced pass: floor=${protectionFloor.floor} reason=${protectionFloor.preSnapshotBustReason}`,
            );
        }
        const protectionWindow = getProtectionWindowForSession(
            db,
            sessionId,
            protectionFloor.floor,
        );
        const protectedTagNumbers = protectionWindow.protectedTagNumbers;
        // Pending operation IDs use tag-number coordinates despite the older "ID" name.
        const protectedTagIds = protectedTagNumbers;
        const protectedCutoff = protectionWindow.cutoff;

        const tPostProcess = performance.now();
        const postTransformResult = await runPostTransformPhase({
            compactionMarkerStrategy:
                deps.compactionMarkerStrategy ?? defaultCompactionMarkerStrategy,
            sessionId,
            db,
            messages,
            // P0 perf: pass active-only tags. The downstream consumers
            // (applyHeuristicCleanup, nudger) both filter on
            // status === "active" and short-circuit otherwise — feeding
            // them active-only is identical behavior with much smaller
            // input. applyPendingOperations is the only consumer that
            // genuinely needs all statuses; it already handles a missing
            // preload by lazy-loading via getTagsBySession() internally,
            // and pending-op execution is the rare case (most passes have
            // 0 pending ops and skip applyPendingOperations entirely).
            tags: activeTags,
            targets,
            reasoningByMessage,
            messageTagNumbers,
            tagger: deps.tagger,
            ctxReduceAvailability,
            channel1StateBySession: deps.channel1StateBySession,
            todowriteAvailability,
            client: deps.client,
            activeAgent,
            batch,
            contextUsage,
            usableWindow: resolvedContextLimit ?? 0,
            schedulerDecision,
            schedulerDeferReason,
            fullFeatureMode,
            temporalCandidates,
            temporalReplayIds,
            temporalObservedDecisions,
            compactionOff,
            canRunCompartments,
            awaitedCompartmentRun,
            phaseJustAwaitedPublication: compartmentPhase.justAwaitedPublication,
            compartmentInProgress,
            historyRefreshExplicitBeforePrepare,
            freezeM0M1,
            deferredHistoryWasPendingAtPassStart,
            compartmentInjectionRebuiltFromDb: pendingCompartmentInjection?.rebuiltFromDb === true,
            rebuiltHistoryFromInitialPrepare,
            historyRebuiltThisPass,
            canConsumeDeferredLate,
            sessionMeta,
            currentTurnId,
            // Postprocess reads pendingMaterializationSessions to decide
            // whether `/ctx-flush`-style materialization is queued, and
            // drains it after heuristics actually run. NOT the history
            // set — postprocess doesn't refresh `<session-history>`.
            pendingMaterializationSessions: deps.pendingMaterializationSessions,
            deferredHistoryRefreshSessions,
            deferredMaterializationSessions,
            lastHeuristicsTurnId: deps.lastHeuristicsTurnId,
            clearReasoningAge: deps.clearReasoningAge,
            protectedTagIds,
            protectedTagNumbers,
            protectedCutoff,
            protectedCount: protectionWindow.status.protectedCount,
            emergencyCeilingTokens,
            pendingCompartmentInjection,
            prefixTrimSourceOrder,
            hiddenMessagesAtCompactionSeam,
            trimmedMessagesAtCompactionBoundary,
            didMutateFromFlushedStatuses,
            watermark,
            forceMaterializationPercentage,
            hasRecentReduceCall,
            // Session-scoped (not launch) identity so note-nudge + auto-search
            // target the resumed session's real project. See sessionProjectIdentity.
            projectPath: sessionProjectIdentity,
            sessionDirectory,
            autoSearch: deps.autoSearch,
            // Only forward caveman config for primary sessions. Subagents should
            // never receive their own caveman compression because they have no
            // equivalent recovery path and their context is already curated by
            // the primary agent that spawned them.
            cavemanTextCompression: !reducedMode ? deps.cavemanTextCompression : undefined,
            smartDrops: deps.smartDrops === true,
            protectedTools: deps.protectedTools,
            // Pass the single resolved provider through to postprocess so every
            // empty-sentinel gate and whole-message placeholder choice agrees for
            // this transform pass, including cold DB-recovered passes.
            resolvedProviderID,
            thinkingBindingRecoveryEnabledForModel: isPrefixBoundThinkingModel(
                modelForBudget?.providerID,
                modelForBudget?.modelID,
            ),
            trailingBlankSourceDecisions,
            passOutcome,
            historyRefreshSessions: deps.historyRefreshSessions,
            m0M1: {
                // Memory identity ONLY (drives <project-memory> selection in
                // materializeM0). Must stay undefined when memory.enabled=false —
                // falling back to deps.projectPath here re-enabled memory injection
                // despite the config being off (materializeM0 renders memory purely
                // on projectPath presence). projectDirectory below independently
                // drives docs/key-files/history, so dropping the fallback does not
                // disable those.
                projectPath: projectIdentity,
                projectDirectory: sessionDirectory,
                injectDocs: deps.injectDocs,
                memoryEnabled: deps.memoryConfig?.enabled,
                memoryInjectionBudgetTokens: deps.memoryConfig?.injectionBudgetTokens,
                historyBudgetTokens,
                historyBudgetPolicyIdentity: historyPolicyIdentity,
                temporalAwareness: deps.experimentalTemporalAwareness,
                hardSignals: m0HardSignals,
                muralEnabled: deps.muralEnabled,
            },
        });
        passOutcome.markFinalized();
        // Compaction-off: the emergency/overflow machinery is fully disarmed
        // (derived force-band tiered drop, absolute 95% fail-closed block, overflow-recovery latch).
        // A persisted latch is cleared by the off-transition, never consumed
        // here; overflow propagates to native compaction instead of blocking.
        const finalWireTail = describeFinalWireTail(messages);
        let finalWireEstimate: ReturnType<typeof estimateFinalWireInputTokens> | undefined;
        if (postTransformResult.bustedThisPass) {
            try {
                finalWireEstimate = finalWireUsage.estimate(
                    sessionId,
                    {
                        messages,
                        systemPromptTokens: sessionMeta.systemPromptTokens,
                        providerID: modelForBudget?.providerID,
                        modelID: modelForBudget?.modelID,
                        agentName: notificationParams.agent,
                        systemPromptHash: sessionMeta.systemPromptHash,
                    },
                    boundaryContextLimit,
                );
            } catch {
                sessionLog(
                    sessionId,
                    "calibration: completeness=partial reason=unavailable-returned-array-count",
                );
            }
        }
        if (!compactionOff) {
            // Recovery estimates provider input even while reusing cached messages.
            // Cache-busting passes also retain raw counts for telemetry; samples never drive decisions.
            const emergencyUsagePercentage = usagePercentageSynthetic
                ? Math.max(95, contextUsage.percentage)
                : windowGeometry?.usableHard && contextUsage.inputTokens > 0
                  ? (contextUsage.inputTokens / windowGeometry.usableHard) * 100
                  : contextUsage.percentage;
            finalWireEstimate =
                finalWireEstimate ??
                (emergencyUsagePercentage >= 95 || schedulerDecision === "execute"
                    ? finalWireUsage.estimate(
                          sessionId,
                          {
                              messages,
                              systemPromptTokens: sessionMeta.systemPromptTokens,
                              providerID: modelForBudget?.providerID,
                              modelID: modelForBudget?.modelID,
                              agentName: notificationParams.agent,
                              systemPromptHash: sessionMeta.systemPromptHash,
                          },
                          boundaryContextLimit,
                      )
                    : undefined);
            if (finalWireEstimate) {
                sessionLog(
                    sessionId,
                    `transform: final-wire telemetry estimate=${finalWireEstimate.tokens} trusted=${finalWireEstimate.trusted} conversation=${finalWireEstimate.messageTokens.conversation} tools=${finalWireEstimate.messageTokens.toolCall} system=${finalWireEstimate.systemTokens} toolDefinitions=${finalWireEstimate.toolDefinitionTokens ?? "unknown"} tail=${finalWireTail}`,
                );
            }
            // The prefix trim could not find the history boundary, so the whole
            // window is about to go out uncut. That is harmless while it fits and
            // a guaranteed provider rejection when it does not; in the second case
            // stop, so the wrapper replays the last good request or refuses.
            if (postTransformResult.prefixTrimStatus === "refused") {
                const untrimmed =
                    finalWireEstimate ??
                    estimateFinalWireInputTokens({
                        messages,
                        systemPromptTokens: sessionMeta.systemPromptTokens,
                        providerID: modelForBudget?.providerID,
                        modelID: modelForBudget?.modelID,
                        agentName: notificationParams.agent,
                    });
                if (untrimmed.tokens > boundaryContextLimit) {
                    sessionLog(
                        sessionId,
                        `history boundary unresolved: prefix trim refused and the untrimmed request estimate ${untrimmed.tokens} (trusted=${untrimmed.trusted}) exceeds the context limit ${boundaryContextLimit}; not sending it`,
                    );
                    throw new UnresolvedHistoryBoundaryError(
                        untrimmed.tokens,
                        boundaryContextLimit,
                    );
                }
            }
            // The pass began clearly over the window with nothing to replace the
            // history (see the check before the scheduler decision). Whatever
            // this pass reclaimed, a request still over the window does not go
            // out: the wrapper replays the last good request or refuses.
            if (unmanagedOverWindowPass) {
                const served = estimateFinalWireInputTokens({
                    messages,
                    systemPromptTokens: sessionMeta.systemPromptTokens,
                    providerID: modelForBudget?.providerID,
                    modelID: modelForBudget?.modelID,
                    agentName: notificationParams.agent,
                });
                // Count the request the way it will really go out: system
                // prompt, history and this route's measured tool definitions,
                // unscaled. When the route's tool definitions are not measured
                // yet, the estimate's figure is an upper envelope (the largest
                // tool set seen on any route, scaled up), which would refuse
                // a request that fits and keep the session flagged; leave it
                // out then, as the entry check does. The system prompt and
                // history stay in, so a carried session whose host-cut history
                // shrank while the request is still over the window is still
                // refused.
                const servedTokens = served.toolDefinitionsMeasured
                    ? (served.rawTokens ?? served.tokens)
                    : Math.max(0, sessionMeta.systemPromptTokens) +
                      served.messageTokens.conversation +
                      served.messageTokens.toolCall;
                if (
                    !Number.isFinite(servedTokens) ||
                    servedTokens > unmanagedOverWindowPass.limit
                ) {
                    sessionLog(
                        sessionId,
                        `over-window first pass not sent: the request is still about ${servedTokens} tokens after this pass, over the ${unmanagedOverWindowPass.limit}-token window (history started at ${unmanagedOverWindowPass.tokens}) (MC-H06)`,
                    );
                    throw new UnmanagedOverWindowError(servedTokens, unmanagedOverWindowPass.limit);
                }
                unmanagedOverWindowSessions.delete(sessionId);
                sessionLog(
                    sessionId,
                    `over-window first pass reduced: the request is about ${servedTokens} tokens (history started at ${unmanagedOverWindowPass.tokens}), under the ${unmanagedOverWindowPass.limit}-token window`,
                );
            }
            const timedOutHistorianFailure = compartmentPhase.historianJoinTimedOut
                ? historianJoinFailClosedMessage({
                      timedOut: true,
                      budgetMs: compartmentPhase.historianJoinBudgetMs,
                      finalWireEstimate,
                      contextLimitTokens: boundaryContextLimit,
                      lastHistorianError: getHistorianFailureState(db, sessionId).lastError,
                  })
                : null;
            if (timedOutHistorianFailure) {
                sessionLog(
                    sessionId,
                    `transform: ${timedOutHistorianFailure}; finalEstimate=${finalWireEstimate?.tokens ?? "unavailable"} estimateTrusted=${finalWireEstimate?.trusted ?? false} contextLimit=${boundaryContextLimit} emergencyReclaimed=${postTransformResult.emergencyReclaimedTokens}`,
                );
                throw new EmergencyFailClosedError(timedOutHistorianFailure);
            }
            if (compartmentPhase.historianJoinTimedOut) {
                sessionLog(
                    sessionId,
                    `transform: proceeding after bounded historian join; trusted final-wire ${finalWireEstimate?.tokens} fits context limit ${boundaryContextLimit} after emergency reclaim=${postTransformResult.emergencyReclaimedTokens}`,
                );
            }
            const currentModelKeyForRecovery = deps.getModelKey?.(sessionId);
            const overflowStateForFinalWire = getOverflowState(
                db,
                sessionId,
                currentModelKeyForRecovery,
            );
            // A catalog or user-configured limit is useful for budgeting, but it cannot
            // prove that this provider accepts the recovered wire shape. Only the limit
            // parsed from this model's own overflow response may disarm recovery.
            const providerProvenLimitTokens =
                typeof currentModelKeyForRecovery === "string" &&
                currentModelKeyForRecovery.length > 0 &&
                overflowStateForFinalWire.detectedContextLimit > 0 &&
                piModelRefToCanonical(
                    overflowStateForFinalWire.detectedContextLimitModelKey ?? "",
                ) === piModelRefToCanonical(currentModelKeyForRecovery)
                    ? overflowStateForFinalWire.detectedContextLimit
                    : undefined;
            const emergencyFailClosed = evaluateEmergencyFailClosed({
                usagePercentage: emergencyUsagePercentage,
                emergencyRecoveryArmed,
                emergencyRecoveryOrigin,
                foldMaterializedThisPass: postTransformResult.historianFoldMaterializedThisPass,
                finalWireEstimate,
                providerProvenLimitTokens,
                contextLimitTokens: boundaryContextLimit,
                protectedToolTokens: protectedToolTokenCount(
                    getActiveTagsBySession(db, sessionId),
                    deps.protectedTools,
                    resolveDecisionCalibration(modelForBudget?.providerID, modelForBudget?.modelID),
                ),
            });
            if (emergencyFailClosed.disarm) {
                clearEmergencyRecovery(db, sessionId);
                sessionLog(
                    sessionId,
                    `emergency disarm: trusted final-wire ${emergencyFailClosed.disarm.finalWireTokens} under limit ${emergencyFailClosed.disarm.provenLimitTokens}`,
                );
            }
            if (emergencyFailClosed.shouldAbort) {
                if (emergencyFailClosed.refusalMessage) {
                    throw contextRefusalError(emergencyFailClosed.refusalMessage);
                }
                // The notice must finish before host refusal so recovery instructions survive interruption.
                try {
                    await host.hostRefusalNotice(
                        deps.client,
                        sessionId,
                        EMERGENCY_REFUSAL_NOTICE,
                        notificationParams,
                    );
                } catch (error) {
                    throw new EmergencyFailClosedError("Emergency recovery notification failed", {
                        cause: error,
                    });
                }
                try {
                    // OpenCode 2 supplies a refusal callback because it has no v1 client abort method.
                    await host.hostRefuse(deps.client, sessionId);
                } catch (error) {
                    sessionLog(
                        sessionId,
                        "transform: emergency fail-closed abort failed; refusing to return a sendable prompt:",
                        getErrorMessage(error),
                    );
                    throw new EmergencyFailClosedError("Emergency recovery abort failed", {
                        cause: error,
                    });
                }
                // The abort prevents a fresh provider usage sample. Release the
                // stale-sample latch so the retry can reclaim additional tools.
                try {
                    clearEmergencyDropSample(db, sessionId);
                } catch (error) {
                    throw new EmergencyFailClosedError("Emergency recovery cleanup failed", {
                        cause: error,
                    });
                }
                sessionLog(
                    sessionId,
                    `EMERGENCY: fail-closed (reason=${emergencyFailClosed.reason}, recoveryOrigin=${emergencyRecoveryOrigin ?? "unknown"}, finalEstimate=${finalWireEstimate?.tokens ?? "unavailable"}, estimateTrusted=${finalWireEstimate?.trusted ?? false}, syntheticUsage=${usagePercentageSynthetic})`,
                );
                return;
            }
            // Last-resort size guard. A pass that recorded a degradation able
            // to grow or change its request (PASS_DEGRADATION_EFFECTS) has not
            // shown that it matches what a healthy pass would send. If its
            // request is over the model's limit, stop: the wrapper replays the
            // last good request or refuses, instead of sending a request the
            // provider rejects. Any other pass is served exactly as a healthy
            // one, over the limit or not, and the emergency drop and
            // provider-overflow recovery handle it as before. That includes a
            // pass whose estimate is untrusted, i.e. missing a part it could
            // not count, such as a system prompt not yet measured on a
            // session's first pass: a missing measurement says nothing about
            // whether the pass is degraded. A missing part can only make the
            // estimate smaller, so on a degraded pass an untrusted estimate
            // already over the limit is over it for certain. A healthy pass
            // pays nothing here: it is only estimated when such a degradation
            // was recorded and no estimate exists yet.
            const requestChangingDegradations = passOutcome.degradations.filter((degradation) =>
                degradationChangesRequest(degradation.site),
            );
            if (requestChangingDegradations.length > 0) {
                try {
                    finalWireEstimate ??= estimateFinalWireInputTokens({
                        messages,
                        systemPromptTokens: sessionMeta.systemPromptTokens,
                        providerID: modelForBudget?.providerID,
                        modelID: modelForBudget?.modelID,
                        agentName: notificationParams.agent,
                    });
                } catch (error) {
                    sessionLog(sessionId, "degraded pass size guard could not estimate:", error);
                }
                // The limit falls back to inputTokens / percentage, which is
                // 0 when a synthetic usage bump meets an empty input sample;
                // no limit proves nothing about fit.
                if (
                    finalWireEstimate &&
                    boundaryContextLimit > 0 &&
                    (!Number.isFinite(finalWireEstimate.tokens) ||
                        finalWireEstimate.tokens > boundaryContextLimit)
                ) {
                    sessionLog(
                        sessionId,
                        `degraded pass over the context limit: estimate=${finalWireEstimate.tokens} trusted=${finalWireEstimate.trusted} limit=${boundaryContextLimit} degradations=${requestChangingDegradations.map((item) => item.site).join(",")}; not sending it`,
                    );
                    throw new DegradedPassRefusalError("served-request-over-limit", {
                        estimatedTokens: finalWireEstimate.tokens,
                        contextLimitTokens: boundaryContextLimit,
                    });
                }
            }
        }
        if (!finalWireEstimate) {
            sessionLog(
                sessionId,
                `transform: final-wire telemetry estimate=unavailable trusted=false conversation=unknown tools=unknown system=unknown toolDefinitions=unknown tail=${finalWireTail}`,
            );
        }

        if (passOutcome.captureEligible) {
            const keys = resolveLkgModelKeys(messages);
            const modelKey = modelForBudget
                ? `${modelForBudget.providerID}/${modelForBudget.modelID}`
                : keys.modelKey;
            const providerKey = modelForBudget?.providerID ?? keys.providerKey;
            const captured = captureLkgSlot({
                sessionId,
                input: lkgInput,
                output: messages,
                modelKey,
                providerKey,
                systemPromptTokens: sessionMeta.systemPromptTokens,
                agentName: notificationParams?.agent,
                onPrepared: deps.compactionOff
                    ? undefined
                    : (slot, fullCoverage) => {
                          slot.servedCaptureId = recordServedCapture(db, sessionId, fullCoverage);
                      },
            });
            if (captured) {
                // Keep the durable snapshot in step with the TS-mode capture too:
                // replay consumes the last successful capture of either mode, and
                // drops clear the durable row regardless of mode. Deferred so the
                // pass tail does not pay a synchronous multi-MB write; the slot
                // copy is detached from live messages.
                const capturedSlot = getInMemorySlot(sessionId);
                if (capturedSlot) {
                    withoutSqliteTransformPass(() =>
                        setImmediate(() => saveLkgSlotToDb(db, sessionId, capturedSlot)),
                    );
                }
            }
            if (!captured) {
                dropSlot(sessionId, "lkg_refresh_declined", deps.compactionOff !== true);
            }
        } else if (passOutcome.degradations.length > 0) {
            sessionLog(
                sessionId,
                `lkg_capture_declined degradations=${passOutcome.degradations.map((item) => item.site).join(",")}`,
            );
        }

        // An idle-expired retry can replay a fold prepared by an aborted attempt.
        // The provider still rebuilds the whole prefix, so record the expiry on
        // the retry's own assistant even when this pass changed no message bytes.
        if (postTransformResult.bustedThisPass || hardCacheExpired) {
            recordPendingTransformDecision(sessionId, {
                tsMs: Date.now(),
                decision: schedulerDecision,
                materialized: postTransformResult.materialized,
                materializeReason: normalizeMaterializeReason(
                    "opencode",
                    postTransformResult.materializeReason ?? (hardCacheExpired ? "ttl_idle" : null),
                    postTransformResult.materialized,
                ),
                systemHashPrev: postTransformResult.systemHashPrev,
                systemHashNew: postTransformResult.systemHashNew,
                m0ToolSetHashPrev: postTransformResult.m0ToolSetHashPrev,
                m0ToolSetHashNew: postTransformResult.m0ToolSetHashNew,
                m0ModelKeyPrev: postTransformResult.m0ModelKeyPrev,
                m0ModelKeyNew: postTransformResult.m0ModelKeyNew,
                emergency: postTransformResult.emergency,
                droppedTokens: postTransformResult.droppedTokens,
                droppedCount: postTransformResult.droppedCount,
                inputTokens: contextUsage.inputTokens,
                bustedThisPass: true,
            });
        }
        logTransformTiming(sessionId, "postTransformPhase", tPostProcess);

        // Estimate the total token size of the transformed messages array so
        // the sidebar / dashboard can attribute inputTokens between System
        // (from system.transform), Tool Definitions (inferred as the
        // remainder), and Conversation (actual messages minus injected
        // compartments/facts/memories).
        //
        // Counts every token-bearing field across all part types Anthropic
        // serializes: text, reasoning (signed thinking we still forward for
        // the latest assistant), tool inputs, tool outputs, tool_result
        // content. Previously only `text` parts were counted, which produced
        // ~10x underestimates on sessions with long tool traces and pushed
        // the delta into Tool Definitions. This value intentionally includes
        // the injected <session-history> block — the display layer subtracts
        // compartmentTokens/factTokens/memoryTokens to isolate real
        // user/assistant conversation.
        // Split message content into two honest buckets for the sidebar:
        //   conversationTokens = real user/assistant discussion
        //                        (text, reasoning, images) — the part users
        //                        actually wrote/read
        //   toolCallTokens     = tool call I/O inside messages
        //                        (tool, tool_use, tool_result, tool-invocation)
        //                        — actionable, can be compacted by ctx_reduce
        // Tool DEFINITIONS (schemas OpenCode sends in the separate `tools`
        // parameter) are not in messages — they surface as a residual at
        // display time (inputTokens − system − messagesBlock − toolCalls).
        //
        // Cached per message ID. Messages are append-only once streaming
        // completes, so the token contribution of a completed message is
        // stable across transform passes. Cleared on message.removed events
        // (see hook-handlers.ts). On the rare mid-transform mutation (e.g.
        // historian-driven drop), the cache will be ~slightly stale until
        // the next cache-busting pass; acceptable drift for a display
        // estimate.
        const msgTokens = getMessageTokensCache(sessionId);
        // Durable second tier: the tag store holds per-message real-token counts
        // computed ONCE at tag-insert time and persisted, so a cold pass (empty
        // in-process cache after restart) reads them instead of re-tokenizing the
        // tail. Injected m[0]/m[1] blocks and synthetic-todowrite are never
        // tagged, so they fall through to the live walk below and stay counted in
        // conversation_tokens — preserving the display-layer subtraction contract
        // (the RPC handler subtracts compartments/memories/docs/profile from this
        // total to isolate real conversation). A message with any NULL-count tag
        // (legacy, mid-backfill) is absent here this pass and live-tokenizes,
        // converging to the stored path once the tagger backfills it.
        let storedByMessage = new Map<
            string,
            { conversation: number; toolCall: number; hasNull: boolean }
        >();
        const uncachedMessageIds = messages.flatMap((message) => {
            const messageId = (message.info as { id?: string }).id;
            return messageId !== undefined && !msgTokens.has(messageId) ? [messageId] : [];
        });
        if (uncachedMessageIds.length > 0) {
            try {
                storedByMessage = getActiveTagTokenTotalsByMessage(
                    db,
                    sessionId,
                    uncachedMessageIds,
                );
            } catch {
                storedByMessage = new Map();
            }
        }
        let conversationTokens = 0;
        let toolCallTokens = 0;
        for (const message of messages) {
            const mid = (message.info as { id?: string }).id;
            if (mid) {
                const cached = msgTokens.get(mid);
                if (cached) {
                    conversationTokens += cached.conversation;
                    toolCallTokens += cached.toolCall;
                    continue;
                }
                const stored = storedByMessage.get(mid);
                if (stored && !stored.hasNull) {
                    conversationTokens += stored.conversation;
                    toolCallTokens += stored.toolCall;
                    msgTokens.set(mid, {
                        conversation: stored.conversation,
                        toolCall: stored.toolCall,
                    });
                    continue;
                }
            }
            const estimated = estimateMessageTokens(message);
            if (mid) msgTokens.set(mid, estimated);
            conversationTokens += estimated.conversation;
            toolCallTokens += estimated.toolCall;
        }
        try {
            updateSessionMeta(db, sessionId, { conversationTokens, toolCallTokens });
        } catch (error) {
            // Pure display/telemetry optimization — never fail transform on a
            // BUSY/transient error here. Next pass will refresh the value.
            const code = (error as { code?: string } | null)?.code;
            if (code !== "SQLITE_BUSY") {
                sessionLog(sessionId, "conversation_tokens UPDATE failed:", error);
            }
        }

        // The final-array walk runs inside runPostTransformPhase after its last
        // byte mutation. Report both channel verdicts from that same baseline;
        // only Channel 2 mutates its lease here because Channel 1 delivers at a
        // later tool-result boundary.
        const channelBaseline = deps.channel1StateBySession?.get(sessionId);
        if (ctxReduceCallable && !compactionOff && channelBaseline) {
            try {
                const channel1State = getChannel1NudgeState(db, sessionId);
                const channel1Decision = decideChannel1({
                    ...channelBaseline,
                    lastNudgeUndropped: getLastNudgeUndropped(db, sessionId),
                    lastNudgeLevel: channel1State.level,
                    lastFireOrdinal: channel1State.ordinal,
                    currentRealUserTurnCount: channelBaseline.realUserTurnCount,
                    hasRecentReduce: channelBaseline.reducedSinceRefresh,
                    agentDropsAppliedThisPass: channelBaseline.agentDropsAppliedThisPass,
                    postReduceGracePending: channel1State.postReduceGracePending,
                    postReduceGraceBaselineU: channel1State.postReduceGraceBaselineU,
                    postReduceGracePreLevel: channel1State.postReduceGracePreLevel,
                });
                sessionLog(sessionId, formatChannel1Evaluation(channel1Decision));

                const channel2Evaluation = evaluateChannel2(channelBaseline);
                const leaseBefore = getChannel2NudgeState(db, sessionId);
                if (
                    channelBaseline.evaluable &&
                    !channelBaseline.generationInvalidated &&
                    !channelBaseline.reducedSinceRefresh
                ) {
                    if (channel2Evaluation.shouldTrigger) {
                        casChannel2NudgeState(db, sessionId, "", "pending");
                    } else {
                        casChannel2NudgeState(db, sessionId, "pending", "");
                    }
                }
                const leaseAfter = getChannel2NudgeState(db, sessionId);
                sessionLog(
                    sessionId,
                    formatChannel2Evaluation(channel2Evaluation, {
                        leaseBefore,
                        leaseAfter,
                        gateHoldReason: channelBaseline.reducedSinceRefresh
                            ? "recent-reduce-refresh"
                            : undefined,
                    }),
                );
            } catch (error) {
                sessionLog(sessionId, "nudge evaluation/CAS failed (ignored):", error);
            }
        }

        const elapsed = (performance.now() - startTime).toFixed(1);
        sessionLog(
            sessionId,
            `transform completed in ${elapsed}ms (${messages.length} messages, ${targets.size} targets, watermark: ${watermark})`,
        );

        withoutSqliteTransformPass(() => deps.maybeAutoEmbedSession?.(sessionId));

        const bindingRecovery = postTransformResult.thinkingBindingRecovery;
        if (bindingRecovery) {
            const cleared = clearThinkingBindingRecoveryIf(
                db,
                sessionId,
                bindingRecovery.flagTarget,
            );
            sessionLog(
                sessionId,
                `thinking binding recovery: stripped bound reasoning from ${bindingRecovery.messageIds.length} assistant(s) [${bindingRecovery.messageIds.join(",")}]; flag=${cleared ? "cleared" : "rearmed"}`,
            );
        }
        if (passOutcome.captureEligible)
            finalWireUsage.capture(sessionId, {
                messages,
                systemPromptTokens: sessionMeta.systemPromptTokens,
                providerID: modelForBudget?.providerID,
                modelID: modelForBudget?.modelID,
                agentName: notificationParams.agent,
                systemPromptHash: sessionMeta.systemPromptHash,
            });
    };

    return Object.assign(transform, {
        invalidateRustWireState(sessionId: string): void {
            rustModeTransform?.invalidateWireState(sessionId);
        },
        async clearRustSession(sessionId: string): Promise<void> {
            await rustModeTransform?.clearSession(sessionId);
        },
        /** The host disposed this instance; release the Rust adapter's process-wide registrations. */
        disposeRust(): void {
            rustModeTransform?.dispose();
        },
        /** This instance's Rust adapter, for its own messages-transform wrapper; null in TypeScript mode. */
        getRustReplayParticipant() {
            return rustModeTransform?.replayParticipant ?? null;
        },
        getRustWireCacheHeapStats() {
            return (
                rustModeTransform?.getHeapStats() ?? {
                    snapshots: 0,
                    rawContentSnapshots: 0,
                    estimatedBytes: 0,
                    sessions: [],
                }
            );
        },
    });
}

export function resolveHistoryBudgetTokens(
    historyBudgetPercentage: number | undefined,
    contextUsage: ContextUsage,
    executeThresholdPercentage:
        | number
        | { default: number; [modelKey: string]: number }
        | undefined,
    modelKey: string | undefined,
    executeThresholdTokens?: { default?: number; [modelKey: string]: number | undefined },
    resolvedContextLimit?: number,
): number | undefined {
    if (!historyBudgetPercentage) {
        return undefined;
    }

    // Derive the budget from the model's STABLE context limit, resolved
    // directly (models.dev + any detected-overflow override). The previous
    // design back-derived the limit from live usage as inputTokens/percentage,
    // which collapses to 0/0 on the FIRST transform pass after a restart
    // (percentage=0, inputTokens=0). When a re-materialize was forced on that
    // very pass (e.g. the m[1] cache was cleared by a migration), the budget
    // fell through to the hard-coded 60K default — far below a large model's
    // real history budget — and the decay renderer archived the oldest
    // compartments to fit 60K, then stuck there via cache_hit replay. The
    // resolved limit is available even at percentage=0 (recovered from the
    // OpenCode DB), so it removes the hole. The live-usage back-derivation is
    // kept only as a last-resort fallback if a limit couldn't be resolved.
    let contextLimit = resolvedContextLimit && resolvedContextLimit > 0 ? resolvedContextLimit : 0;
    if (contextLimit <= 0) {
        if (contextUsage.percentage <= 0) {
            return undefined;
        }
        contextLimit = contextUsage.inputTokens / (contextUsage.percentage / 100);
    }
    if (!Number.isFinite(contextLimit) || contextLimit <= 0) {
        return undefined;
    }

    return Math.floor(
        contextLimit *
            (resolveExecuteThreshold(executeThresholdPercentage ?? 65, modelKey, 65, {
                tokensConfig: executeThresholdTokens,
                contextLimit,
            }) /
                100) *
            historyBudgetPercentage,
    );
}

import { protectedToolTokenCount } from "../../features/magic-context/reclaim-protection";
import { resolveDecisionCalibration } from "./decision-calibration";
