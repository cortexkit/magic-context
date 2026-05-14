import * as crypto from "node:crypto";
import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { scheduleReconciliation } from "../../features/magic-context/message-index-async";
import type { Scheduler } from "../../features/magic-context/scheduler";

import {
    type ContextDatabase,
    getActiveTagsBySession,
    getHistorianFailureState,
    getMaxDroppedTagNumber,
    getOrCreateSessionMeta,
    getTagsByNumbers,
    type getTopNBySize,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import type { Tagger } from "../../features/magic-context/tagger";
import type { ContextUsage, TagEntry } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import { applyMidTurnDeferral, detectMidTurnBypassReason } from "./boundary-execution";
import { canConsumeDeferredOnThisPass } from "./cache-busting-signals";
import { replayCavemanCompression } from "./caveman-cleanup";
import { getActiveCompartmentRun, startCompartmentAgent } from "./compartment-runner";
import { FORCE_MATERIALIZE_PERCENTAGE } from "./compartment-trigger";
import { resolveExecuteThreshold } from "./event-resolvers";
import { estimateImageTokensFromDataUrl } from "./image-token-estimate";
import {
    type PreparedCompartmentInjection,
    prepareCompartmentInjection,
} from "./inject-compartments";
import { onNoteTrigger } from "./note-nudger";
import type { NudgePlacementStore } from "./nudge-placement-store";
import type { ContextNudge } from "./nudger";
import {
    getProtectedTailStartOrdinal,
    getRawSessionMessageCount,
    readRawSessionMessages,
} from "./read-session-chunk";
import { isMidTurn } from "./read-session-db";
import { estimateTokens } from "./read-session-formatting";

import { sendIgnoredMessage } from "./send-session-notification";
import {
    replayClearedReasoning,
    replayStrippedInlineThinking,
    stripClearedReasoning,
    stripReasoningFromMergedAssistants,
} from "./strip-content";
import { injectTemporalMarkers } from "./temporal-awareness";
import { runCompartmentPhase } from "./transform-compartment-phase";
import { loadContextUsage, resolveSchedulerDecision } from "./transform-context-state";
import { findLastUserMessageId, findSessionId } from "./transform-message-helpers";
import {
    applyFlushedStatuses,
    type MessageLike,
    stripStructuralNoise,
    type TagTarget,
    tagMessages,
} from "./transform-operations";
import { runPostTransformPhase } from "./transform-postprocess-phase";
import { logTransformTiming } from "./transform-stage-logger";

export { createNudgePlacementStore, type NudgePlacementStore } from "./nudge-placement-store";

import {
    clearDetectedContextLimit,
    clearEmergencyRecovery,
    clearHistorianFailureState,
    clearPersistedReasoningWatermark,
    getOverflowState,
    setDeferredExecutePendingIfAbsent,
} from "../../features/magic-context/storage-meta-persisted";
import type { LiveModelBySession } from "./hook-handlers";

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

export function clearMessageTokensCache(sessionId: string, messageId?: string): void {
    if (messageId === undefined) {
        messageTokensBySession.delete(sessionId);
        return;
    }
    const cache = messageTokensBySession.get(sessionId);
    if (cache) cache.delete(messageId);
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

export interface TransformDeps {
    tagger: Tagger;
    scheduler: Scheduler;
    contextUsageMap: Map<
        string,
        { usage: ContextUsage; updatedAt: number; lastResponseTime?: number }
    >;
    nudger: (
        sessionId: string,
        contextUsage: ContextUsage,
        db: ContextDatabase,
        topNFn: typeof getTopNBySize,
        preloadedTags?: TagEntry[],
        messagesSinceLastUser?: number,
        preloadedSessionMeta?: import("../../features/magic-context/types").SessionMeta,
    ) => ContextNudge | null;
    db: ContextDatabase;
    nudgePlacements: NudgePlacementStore;
    protectedTags: number;
    /**
     * Primary-session ctx_reduce setting. When false, tag prefix injection is
     * skipped for ALL sessions (primary + subagent). When true, primary sessions
     * get prefixes but subagent sessions still skip (subagents are always
     * treated as ctx_reduce_enabled=false). See tag-messages.ts for the gate.
     * Defaults to true when omitted (preserves legacy behavior for tests).
     */
    ctxReduceEnabled?: boolean;
    autoDropToolAge: number;
    dropToolStructure?: boolean;
    clearReasoningAge: number;
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
    lastHeuristicsTurnId: Map<string, string>;
    commitSeenLastPass?: Map<string, boolean>;
    client?: PluginContext["client"];
    directory?: string;
    memoryConfig?: {
        enabled: boolean;
        injectionBudgetTokens: number;
        /** When true, historian/recomp auto-promote eligible session facts
         *  to project memories. When false, promotion is skipped — agents can
         *  still write memories explicitly via `ctx_memory write`. Issue #44. */
        autoPromote: boolean;
    };
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
    /** Resolved fallback chain for historian-family calls. */
    fallbackModels?: readonly string[];
    getNotificationParams?: (
        sessionId: string,
    ) => import("./send-session-notification").NotificationParams;
    getModelKey?: (sessionId: string) => string | undefined;
    getFallbackModelId?: (sessionId: string) => string | undefined;
    projectPath?: string;
    experimentalCompactionMarkers?: boolean;
    experimentalUserMemories?: boolean;
    /** When true, inject wall-clock gap markers (<!-- +Xm -->) on user messages and
     *  add start/end date attributes to <compartment> elements in <session-history>.
     *  Controlled by `experimental.temporal_awareness` config. */
    experimentalTemporalAwareness?: boolean;
    /** When true, run a second editor pass after historian to clean U: lines.
     *  Enables the historian-editor agent. Controlled by `historian.two_pass` config. */
    historianTwoPass?: boolean;
    /** Compressor floor ratio: floor = ceil(lastEndMessage / minCompartmentRatio).
     *  Controlled by `compressor.min_compartment_ratio` config. */
    compressorMinCompartmentRatio?: number;
    /** Compressor max merge depth (1-5). Controlled by `compressor.max_merge_depth` config. */
    compressorMaxMergeDepth?: number;
    /** Compressor cooldown in milliseconds. Controlled by `compressor.cooldown_ms` config. */
    compressorCooldownMs?: number;
    liveModelBySession?: LiveModelBySession;
    /**
     * Process-scoped cache of resolved session.directory values. When provided,
     * we look up here before hitting OpenCode's API and populate after a
     * successful lookup. The session→project binding is immutable in OpenCode,
     * so this cache lives until the session is deleted.
     */
    sessionDirectoryBySession?: Map<string, string>;
    /** Experimental auto-search hint — transform-time ctx_search on each new
     *  user message; when top hit clears the threshold, append a compact
     *  fragment hint to the user message. Controlled by
     *  `experimental.auto_search.*` config. */
    autoSearch?: {
        enabled: boolean;
        scoreThreshold: number;
        minPromptChars: number;
        memoryEnabled: boolean;
        embeddingEnabled: boolean;
        gitCommitsEnabled: boolean;
    };
    /**
     * Experimental age-tier caveman text compression — rewrites long
     * user/assistant text parts with progressively aggressive caveman
     * rules based on their position in the eligible tag window. Only
     * honored when `ctx_reduce_enabled: false` (transform zeroes this
     * out when ctx_reduce is on so the postprocess path stays unaware).
     */
    cavemanTextCompression?: {
        enabled: boolean;
        minChars: number;
    };
}

export function createTransform(deps: TransformDeps) {
    const loadedSessions = new Set<string>();
    const lastEmergencyNotificationCount = new Map<string, number>();
    const deferredHistoryRefreshSessions = deps.deferredHistoryRefreshSessions ?? new Set<string>();
    const deferredMaterializationSessions =
        deps.deferredMaterializationSessions ?? new Set<string>();

    return async (
        _input: Record<string, never>,
        output: { messages: unknown[] },
    ): Promise<void> => {
        const startTime = performance.now();
        const messages = output.messages as MessageLike[];
        const sessionId = findSessionId(messages);
        if (!sessionId) {
            return;
        }
        const resolvedSessionId = sessionId;
        logTransformTiming(sessionId, "findSessionId", startTime, `messages=${messages.length}`);

        const db = deps.db;
        if (deps.client !== undefined) {
            scheduleReconciliation(db, sessionId, readRawSessionMessages);
        }

        const tUserMsg = performance.now();
        const currentTurnId = findLastUserMessageId(messages);
        logTransformTiming(sessionId, "findLastUserMessageId", tUserMsg);

        const tMeta = performance.now();
        let sessionMeta: import("../../features/magic-context/types").SessionMeta | undefined;
        try {
            // Intentional fail-open: magic-context should not block live chat if session state read fails.
            sessionMeta = getOrCreateSessionMeta(db, sessionId);
        } catch (error) {
            sessionLog(sessionId, "transform failed reading session meta:", error);
            return;
        }
        logTransformTiming(sessionId, "getOrCreateSessionMeta", tMeta);

        // System prompt change detection is handled in experimental.chat.system.transform
        // (see system-prompt-hash.ts), not here. The messages transform only receives
        // user/assistant messages, not the system prompt.

        const reducedMode = sessionMeta.isSubagent;
        const fullFeatureMode = !reducedMode;

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
        const cachedDirectory = deps.sessionDirectoryBySession?.get(sessionId);
        if (cachedDirectory && cachedDirectory.length > 0) {
            sessionDirectory = cachedDirectory;
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
                }
            } catch {
                // ignore; fallback already in place
            }
        }
        const compartmentDirectory = sessionDirectory;
        const canRunCompartments =
            fullFeatureMode && deps.client !== undefined && compartmentDirectory.length > 0;
        const fallbackModelId = deps.getFallbackModelId?.(sessionId);

        const tModelDetect = performance.now();
        // Detect model changes early in the transform — BEFORE loading context usage.
        // When a user switches models (e.g., 128K→1M), the persisted lastContextPercentage
        // reflects the old model's context limit. If we don't clear it, the 95% blocking
        // threshold can deadlock the session: transform blocks awaiting historian,
        // but no message.updated event fires to clear the stale percentage because
        // the transform never completes.
        // NOTE: This detection only works AFTER the first assistant response on the new model,
        // because findLastAssistantModel reads the latest assistant message in history.
        // Before that first response, the last assistant message is still from the old model.
        // The first-pass reset (below) handles the restart case. Mid-session model switches
        // without restart rely on the first message.updated to trigger hook-handler clearing.
        // A brief stale-percentage window exists between the model switch and first response.
        if (deps.liveModelBySession) {
            const lastAssistantModel = findLastAssistantModel(messages);
            if (lastAssistantModel) {
                const knownModel = deps.liveModelBySession.get(sessionId);
                if (!knownModel) {
                    // No known model yet — populate from message history so the
                    // scheduler can resolve per-model execute_threshold_percentage
                    // immediately. Without this, after a plugin restart the map
                    // stays empty until a new message.updated event fires, and
                    // any transform in between uses the default threshold even
                    // for sessions with explicit per-model config.
                    deps.liveModelBySession.set(sessionId, lastAssistantModel);
                } else if (
                    knownModel.providerID !== lastAssistantModel.providerID ||
                    knownModel.modelID !== lastAssistantModel.modelID
                ) {
                    sessionLog(
                        sessionId,
                        `transform: model change detected (${knownModel.providerID}/${knownModel.modelID} -> ${lastAssistantModel.providerID}/${lastAssistantModel.modelID}), clearing stale context state`,
                    );
                    deps.liveModelBySession.set(sessionId, lastAssistantModel);
                    updateSessionMeta(db, sessionId, {
                        lastContextPercentage: 0,
                        lastInputTokens: 0,
                        clearedReasoningThroughTag: 0,
                    });
                    clearHistorianFailureState(db, sessionId);
                    clearPersistedReasoningWatermark(db, sessionId);
                    // Clear any detected context limit from a prior overflow — the
                    // old limit was specific to the previous model and must not
                    // leak into pressure math for the new model. The recovery
                    // flag is cleared too; the new model gets a fresh chance
                    // to overflow (and a fresh detection cycle) if it must.
                    clearDetectedContextLimit(db, sessionId);
                    clearEmergencyRecovery(db, sessionId);
                    // Also clear the in-memory usage map so loadContextUsage gets fresh values
                    deps.contextUsageMap.delete(sessionId);
                    sessionMeta = {
                        ...sessionMeta,
                        lastContextPercentage: 0,
                        lastInputTokens: 0,
                        clearedReasoningThroughTag: 0,
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
        // Snapshot failure state BEFORE reset — restart recovery needs it.
        const historianFailureState = getHistorianFailureState(db, sessionId);

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
        let contextUsageEarly = loadContextUsage(deps.contextUsageMap, db, sessionId);

        // Overflow-triggered emergency recovery: if a prior provider response
        // included a context-overflow error, the event handler persisted
        // needs_emergency_recovery=1. On the very next transform pass we bump
        // the effective percentage to 95% so the existing emergency path
        // (abort + historian + aggressive drops) fires regardless of what
        // pressure math says. Without this, an overflow on a session whose
        // limit resolver over-reported the real limit would never enter the
        // emergency path — we'd just keep hitting the same overflow error.
        if (fullFeatureMode) {
            try {
                const overflowState = getOverflowState(db, sessionId);
                if (overflowState.needsEmergencyRecovery && contextUsageEarly.percentage < 95) {
                    sessionLog(
                        sessionId,
                        `transform: bumping percentage to 95% due to overflow recovery flag (was ${contextUsageEarly.percentage.toFixed(1)}%, detectedLimit=${overflowState.detectedContextLimit || "unknown"})`,
                    );
                    contextUsageEarly = {
                        ...contextUsageEarly,
                        percentage: 95,
                    };
                }
            } catch (error) {
                sessionLog(
                    sessionId,
                    "transform: overflow recovery state read failed:",
                    getErrorMessage(error),
                );
            }
        }
        const historyBudgetTokens = resolveHistoryBudgetTokens(
            deps.historyBudgetPercentage,
            contextUsageEarly,
            deps.executeThresholdPercentage,
            deps.getModelKey?.(sessionId),
            deps.executeThresholdTokens,
        );
        const schedulerDecisionEarly = resolveSchedulerDecision(
            deps.scheduler,
            sessionMeta,
            contextUsageEarly,
            sessionId,
            deps.getModelKey?.(sessionId),
        );
        const midTurn = isMidTurn(deps, resolvedSessionId);
        const bypassReason = detectMidTurnBypassReason({
            contextUsage: contextUsageEarly,
            sessionMeta,
            historyRefreshSessions: deps.historyRefreshSessions,
            sessionId,
        });

        const { midTurnAdjustedSchedulerDecision, sideEffect } = applyMidTurnDeferral({
            base: schedulerDecisionEarly,
            bypassReason,
            midTurn,
        });

        if (sideEffect === "set-flag") {
            const flagPayload = {
                id: crypto.randomUUID(),
                reason: `${schedulerDecisionEarly}-${bypassReason}`,
                recordedAt: Date.now(),
            };
            setDeferredExecutePendingIfAbsent(db, sessionId, flagPayload);
        }

        sessionLog(
            sessionId,
            `[boundary-exec] base=${schedulerDecisionEarly} bypass=${bypassReason} midTurn=${midTurn} effective=${midTurnAdjustedSchedulerDecision} sideEffect=${sideEffect}`,
        );
        // Capture explicit history refresh immediately before the first
        // prepareCompartmentInjection consumer and before any drain. This is a
        // per-pass local, not shared deps state: concurrent transforms must not
        // overwrite each other's explicit/deferred attribution.
        //
        const historyRefreshExplicitBeforePrepare = deps.historyRefreshSessions.has(sessionId);
        const earlyActiveRunBlocksMaterialization =
            (getActiveCompartmentRun(sessionId) !== undefined ||
                sessionMeta.compartmentInProgress) &&
            contextUsageEarly.percentage < FORCE_MATERIALIZE_PERCENTAGE;
        const canConsumeDeferredEarly = canConsumeDeferredOnThisPass({
            schedulerDecision: midTurnAdjustedSchedulerDecision,
            contextPercentage: contextUsageEarly.percentage,
            justAwaitedPublication: false,
            activeRunBlocksMaterialization: earlyActiveRunBlocksMaterialization,
        });
        const consumingDeferredEarly =
            canConsumeDeferredEarly && deferredHistoryRefreshSessions.has(sessionId);
        const isCacheBusting = historyRefreshExplicitBeforePrepare || consumingDeferredEarly;
        const historyBustThisPass = isCacheBusting;
        if (historianFailureState.failureCount === 0) {
            lastEmergencyNotificationCount.delete(sessionId);
        }

        const notificationParams = deps.getNotificationParams?.(sessionId) ?? {};
        // Lazy: only compute when emergency/recovery blocks need it (failureCount > 0)
        let _eligibleHistoryCache: boolean | undefined;
        const getEligibleHistoryForCompartment = (): boolean => {
            if (_eligibleHistoryCache === undefined) {
                _eligibleHistoryCache = canRunCompartments
                    ? hasEligibleCompartmentHistory(db, resolvedSessionId)
                    : false;
            }
            return _eligibleHistoryCache;
        };
        let skipCompartmentAwaitForThisPass = false;

        const startRecoveryRun = (): boolean => {
            if (!canRunCompartments || !deps.client || !getEligibleHistoryForCompartment()) {
                return false;
            }
            if (getActiveCompartmentRun(sessionId)) {
                return false;
            }

            updateSessionMeta(db, sessionId, { compartmentInProgress: true });
            startCompartmentAgent({
                client: deps.client,
                db,
                sessionId,
                historianChunkTokens: deps.getHistorianChunkTokens?.() ?? 20_000,
                historyBudgetTokens,
                historianTimeoutMs: deps.historianTimeoutMs,
                fallbackModels: deps.fallbackModels,
                directory: compartmentDirectory,
                fallbackModelId,
                getNotificationParams: () => notificationParams,
                experimentalCompactionMarkers: deps.experimentalCompactionMarkers,
                experimentalUserMemories: deps.experimentalUserMemories,
                experimentalTemporalAwareness: deps.experimentalTemporalAwareness,
                historianTwoPass: deps.historianTwoPass,
                compressorMinCompartmentRatio: deps.compressorMinCompartmentRatio,
                compressorMaxMergeDepth: deps.compressorMaxMergeDepth,
                // Issue #44: gate historian-driven memory promotion so users
                // who disable the feature actually see no memories created.
                memoryEnabled: deps.memoryConfig?.enabled,
                autoPromote: deps.memoryConfig?.autoPromote,
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
            skipCompartmentAwaitForThisPass = true;
            return true;
        };

        if (
            fullFeatureMode &&
            historianFailureState.failureCount > 0 &&
            contextUsageEarly.percentage >= 95
        ) {
            skipCompartmentAwaitForThisPass = true;
            const emergencyPercentage = contextUsageEarly.percentage.toFixed(1);
            const abortingClient = deps.client as
                | {
                      session?: { abort?: (input: { path: { id: string } }) => Promise<unknown> };
                  }
                | undefined;
            if (typeof abortingClient?.session?.abort === "function") {
                void abortingClient.session
                    .abort({ path: { id: sessionId } })
                    .catch((error: unknown) => {
                        sessionLog(
                            sessionId,
                            "transform: emergency abort failed:",
                            getErrorMessage(error),
                        );
                    });
            }

            const lastNotifiedCount = lastEmergencyNotificationCount.get(sessionId) ?? 0;
            if (deps.client && historianFailureState.failureCount > lastNotifiedCount) {
                lastEmergencyNotificationCount.set(sessionId, historianFailureState.failureCount);
                void sendIgnoredMessage(
                    deps.client,
                    sessionId,
                    `⚠️ Context Emergency — Context is at ${emergencyPercentage}% and historian has failed ${historianFailureState.failureCount} times (last error: ${truncateHistorianEmergencyError(historianFailureState.lastError)}). Aborting this message to prevent context overflow. Historian will retry automatically. If this persists, change your historian model in magic-context.jsonc and restart OpenCode.`,
                    notificationParams,
                );
            }

            startRecoveryRun();
            sessionLog(
                sessionId,
                `EMERGENCY: aborting session at ${emergencyPercentage}%, historian failures: ${historianFailureState.failureCount}`,
            );
        } else if (
            fullFeatureMode &&
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
                void sendIgnoredMessage(
                    deps.client,
                    sessionId,
                    `## Historian recovery\n\nHistorian previously failed ${historianFailureState.failureCount} time(s), so magic-context is retrying compaction immediately after restart.`,
                    notificationParams,
                );
            }
        }

        logTransformTiming(sessionId, "emergencyRecoveryBlock", tFirstPass);

        // Resolve project identity ONCE per transform pass. Used by both
        // prepareCompartmentInjection (memory filtering by project) and
        // runCompartmentPhase (historian memory resolution). Computing it
        // twice per turn is wasteful — resolveProjectIdentity caches by
        // directory but still does a cache lookup on each call, and the
        // first call per directory in a new process spawns `git rev-parse`.
        const projectIdentity = deps.memoryConfig?.enabled
            ? resolveProjectIdentity(compartmentDirectory || process.cwd())
            : undefined;

        let pendingCompartmentInjection: PreparedCompartmentInjection | null = null;
        let rebuiltHistoryFromInitialPrepare = false;
        if (fullFeatureMode) {
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
        // Inject temporal markers before tagging so the §N§ tag prefix wraps
        // around our marker.
        //
        // Intentional — this runs on EVERY transform pass, including defer /
        // cache-safe passes that are otherwise gated. Three invariants make
        // that safe:
        //   1. Idempotent: injectTemporalMarkers detects existing markers by
        //      regex and will not double-prefix.
        //   2. Deterministic: the marker value derives from immutable
        //      message.time.created / time.completed timestamps — same input,
        //      same output, every pass.
        //   3. Required every pass: OpenCode rebuilds the messages array from
        //      its DB for every transform, so markers must be re-applied on
        //      each pass or they would disappear on defer passes. Skipping
        //      defer passes here would cause the marker to flicker in/out and
        //      bust cache when it reappeared.
        //
        // The retroactive-on-flag-flip behavior is the same mechanism — when
        // the flag turns on, the first pass marks every eligible user message
        // and subsequent passes just observe the already-marked content.
        if (deps.experimentalTemporalAwareness) {
            const tTemporal = performance.now();
            const injected = injectTemporalMarkers(messages);
            if (injected > 0) {
                sessionLog(sessionId, `temporal: injected ${injected} gap markers`);
            }
            logTransformTiming(sessionId, "injectTemporalMarkers", tTemporal);
        }

        let taggingSucceeded = false;
        try {
            const t0 = performance.now();
            deps.tagger.initFromDb(sessionId, db);
            // Skip §N§ prefix injection when either:
            // - ctx_reduce_enabled is false (agents have no tool to act on tags)
            // - This is a subagent session (always treated as ctx_reduce_enabled=false)
            // DB tag records are still maintained either way so heuristics and
            // drops continue to work — only the agent-visible prefix is skipped.
            // ctxReduceEnabled defaults to true (undefined === true for this gate).
            const ctxReduceEnabledEffective = deps.ctxReduceEnabled !== false;
            const skipPrefixInjection = !ctxReduceEnabledEffective || reducedMode;
            const result = tagMessages(sessionId, messages, deps.tagger, db, {
                skipPrefixInjection,
            });
            targets = result.targets;
            reasoningByMessage = result.reasoningByMessage;
            messageTagNumbers = result.messageTagNumbers;
            batch = result.batch;
            hasRecentReduceCall = result.hasRecentReduceCall;
            const hadPriorCommitState = deps.commitSeenLastPass?.has(sessionId) ?? false;
            const sawCommitLastPass = deps.commitSeenLastPass?.get(sessionId) ?? false;
            // Only trigger on NEW commits — not on first pass after restart where
            // we have no baseline. First pass establishes the baseline silently.
            // Subagents never deliver note nudges (gated in postprocess), so skip
            // accumulating orphan trigger state.
            if (
                fullFeatureMode &&
                hadPriorCommitState &&
                result.hasRecentCommit &&
                !sawCommitLastPass
            ) {
                onNoteTrigger(db, sessionId, "commit_detected");
            }
            deps.commitSeenLastPass?.set(sessionId, result.hasRecentCommit);
            logTransformTiming(sessionId, "tagMessages", t0);
            taggingSucceeded = true;
        } catch (error) {
            sessionLog(
                sessionId,
                "transform tag persistence failed; continuing without tagging:",
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
        }

        // P0 perf: replace single SELECT-everything load with three
        // targeted queries. The hot transform path used to load every
        // tag in the session (~50k rows on long-lived sessions) every
        // pass; benchmark in scripts/benchmark-tag-queries.ts showed
        // this single change recovers ~67ms per pass.
        //
        //   activeTags          → drives heuristic cleanup, nudger,
        //                         caveman scope (active subset only;
        //                         partial-index scan, ~0.6ms)
        //   targetsSliceTags    → drives applyFlushedStatuses + caveman
        //                         replay (visible target subset only;
        //                         IN-list lookup against the existing
        //                         (session_id, tag_number) index)
        //   maxDroppedTagNumber → replaces the watermark for-loop with
        //                         a single MAX() aggregate
        //
        // applyHeuristicCleanup and nudger both filter on
        // status === "active" and short-circuit otherwise, so feeding
        // them active-only is identical behavior. applyFlushedStatuses
        // and caveman replay both filter to targets.has(tagNumber), so
        // pre-filtering by tag_number is a no-op for correctness.
        const t1 = performance.now();
        const activeTags = getActiveTagsBySession(db, sessionId);
        logTransformTiming(sessionId, "getActiveTagsBySession", t1, `count=${activeTags.length}`);

        const t1b = performance.now();
        const targetTagNumbers = [...targets.keys()];
        const targetsSliceTags = getTagsByNumbers(db, sessionId, targetTagNumbers);
        logTransformTiming(
            sessionId,
            "getTagsByNumbers",
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
                // Only clear on cache-busting passes to avoid re-anchor on next defer (Finding 2).
                if (isCacheBusting) deps.nudgePlacements.clear(sessionId);
            }
        }
        if (didMutateFromFlushedStatuses && isCacheBusting) {
            deps.nudgePlacements.clear(sessionId);
        }

        const t3 = performance.now();
        const strippedStructuralNoise = stripStructuralNoise(messages);
        logTransformTiming(
            sessionId,
            "stripStructuralNoise",
            t3,
            `strippedParts=${strippedStructuralNoise}`,
        );

        // Replay persisted reasoning clearing on EVERY pass (including defer).
        // This ensures reasoning cleared on a previous cache-busting pass stays cleared
        // even when OpenCode rebuilds messages fresh from its own DB.
        const persistedReasoningWatermark = sessionMeta?.clearedReasoningThroughTag ?? 0;
        if (persistedReasoningWatermark > 0) {
            const tReplay = performance.now();
            const replayed = replayClearedReasoning(
                messages,
                reasoningByMessage,
                messageTagNumbers,
                persistedReasoningWatermark,
            );
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

        // Re-apply persisted caveman compression on EVERY pass (defer too).
        // tagMessages restores the pristine original from source_contents on
        // every pass, so without this replay step compressed text would
        // oscillate between compressed (post-execute) and original (defer),
        // busting the provider prompt cache. Cheap when no tags carry
        // caveman_depth > 0 (early exit). Only forwarded when ctx_reduce
        // is disabled AND not a subagent — matches the gate that lets
        // applyCavemanCleanup deepen depth in the first place.
        //
        // We feed the targets-slice subset (already loaded above for
        // applyFlushedStatuses) — replay only acts on tags whose
        // tag_number is in `targets` anyway, so passing the wider list
        // would just give it more rows to filter and discard.
        if (!deps.ctxReduceEnabled && !reducedMode && deps.cavemanTextCompression?.enabled) {
            const tCavemanReplay = performance.now();
            const replayedCaveman = replayCavemanCompression(
                sessionId,
                db,
                targets,
                targetsSliceTags,
            );
            if (replayedCaveman > 0) {
                sessionLog(sessionId, `caveman replay: re-applied ${replayedCaveman} text tags`);
            }
            logTransformTiming(sessionId, "replayCavemanCompression", tCavemanReplay);
        }

        const t4 = performance.now();
        // OpenCode's provider/transform.ts (PR #24146, 2026-04-24) always emits
        // the interleaved `reasoning_content`/`reasoning_details` field for
        // providers that declare `capabilities.interleaved.field` — even when
        // empty. So neutralizing aged reasoning parts to sentinels is safe
        // for Moonshot/Kimi and the rest; OpenCode emits an empty interleaved
        // field rather than leaking stale `[cleared]` text into the wire.
        const strippedClearedReasoning = stripClearedReasoning(messages);
        logTransformTiming(
            sessionId,
            "stripClearedReasoning",
            t4,
            `strippedParts=${strippedClearedReasoning}`,
        );

        // Anthropic groupIntoBlocks workaround. @ai-sdk/anthropic requires
        // thinking blocks at index 0 of an assistant message; when Magic
        // Context drops a tool call and `pruneEmptyMessages` removes the
        // now-empty message, two assistant messages can become adjacent and
        // the second one's `thinking` part triggers an index-0 rejection.
        //
        // Gated to canonical Anthropic only. openai-compatible providers
        // like Kimi/Moonshot enforce the OPPOSITE rule (every assistant
        // tool-call message must have non-empty `reasoning_content`), so
        // stripping there triggers "thinking is enabled but reasoning_content
        // is missing in assistant tool call message". Bedrock-Claude and
        // Google-Vertex-Anthropic may need the workaround if they hit
        // merged-assistant scenarios; broaden the gate then.
        const tMergeStrip = performance.now();
        const liveProviderID = deps.liveModelBySession?.get(sessionId)?.providerID;
        const strippedMergedReasoning = stripReasoningFromMergedAssistants(
            messages,
            liveProviderID,
        );
        if (strippedMergedReasoning > 0) {
            sessionLog(
                sessionId,
                `stripped ${strippedMergedReasoning} reasoning parts from merged assistants (anthropic groupIntoBlocks workaround)`,
            );
        }
        logTransformTiming(
            sessionId,
            "stripReasoningFromMergedAssistants",
            tMergeStrip,
            `strippedParts=${strippedMergedReasoning}`,
        );

        // Watermark = highest dropped tag_number for this session. Backed by
        // the partial index `idx_tags_dropped_session_tag_number` (migration
        // v8) so SQLite resolves this with a single backward index seek
        // instead of the full-array scan we used to do here.
        const watermark = getMaxDroppedTagNumber(db, sessionId);

        // Reuse the early scheduler result — inputs haven't changed.
        const contextUsage = contextUsageEarly;
        const schedulerDecision = midTurnAdjustedSchedulerDecision;
        const rawGetNotifParams = deps.getNotificationParams;
        const tCompartmentPhase = performance.now();
        const compartmentPhase = await runCompartmentPhase({
            canRunCompartments,
            fullFeatureMode,
            sessionMeta,
            contextUsage,
            client: deps.client,
            db,
            sessionId,
            resolvedSessionId,
            historianChunkTokens: deps.getHistorianChunkTokens?.() ?? 20_000,
            historyBudgetTokens,
            historianTimeoutMs: deps.historianTimeoutMs,
            fallbackModels: deps.fallbackModels,
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
            // via pending ops), but standalone compression is suppressed when
            // this pass itself is consuming a history refresh.
            safeForBackgroundCompression:
                isCacheBusting || midTurnAdjustedSchedulerDecision === "execute",
            suppressBackgroundCompressionThisPass: historyBustThisPass,
            deferredHistoryRefreshSessions,
            skipAwaitForThisPass: skipCompartmentAwaitForThisPass,
            experimentalCompactionMarkers: deps.experimentalCompactionMarkers,
            experimentalUserMemories: deps.experimentalUserMemories,
            experimentalTemporalAwareness: deps.experimentalTemporalAwareness,
            historianTwoPass: deps.historianTwoPass,
            compressorMinCompartmentRatio: deps.compressorMinCompartmentRatio,
            compressorMaxMergeDepth: deps.compressorMaxMergeDepth,
            compressorCooldownMs: deps.compressorCooldownMs,
            // Issue #44: forward memory gating so the normal historian path
            // (not just the recovery path above) honors memory.enabled and
            // memory.auto_promote.
            memoryEnabled: deps.memoryConfig?.enabled,
            autoPromote: deps.memoryConfig?.autoPromote,
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

        const lateActiveRunBlocksMaterialization =
            getActiveCompartmentRun(sessionId) !== undefined &&
            contextUsageEarly.percentage < FORCE_MATERIALIZE_PERCENTAGE;
        const canConsumeDeferredLate = canConsumeDeferredOnThisPass({
            schedulerDecision: midTurnAdjustedSchedulerDecision,
            contextPercentage: contextUsageEarly.percentage,
            justAwaitedPublication: compartmentPhase.justAwaitedPublication,
            activeRunBlocksMaterialization: lateActiveRunBlocksMaterialization,
        });
        const wasEmergencyBlock =
            contextUsageEarly.percentage >= FORCE_MATERIALIZE_PERCENTAGE &&
            compartmentPhase.justAwaitedPublication;
        const historyRebuiltThisPass = wasEmergencyBlock
            ? compartmentPhase.rebuiltHistoryThisPass
            : rebuiltHistoryFromInitialPrepare || compartmentPhase.rebuiltHistoryThisPass;

        const tPostProcess = performance.now();
        await runPostTransformPhase({
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
            batch,
            contextUsage,
            schedulerDecision,
            fullFeatureMode,
            canRunCompartments,
            awaitedCompartmentRun,
            phaseJustAwaitedPublication: compartmentPhase.justAwaitedPublication,
            compartmentInProgress,
            historyRefreshExplicitBeforePrepare,
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
            autoDropToolAge: deps.autoDropToolAge,
            dropToolStructure: deps.dropToolStructure ?? true,
            clearReasoningAge: deps.clearReasoningAge,
            protectedTags: deps.protectedTags,
            nudgePlacements: deps.nudgePlacements,
            nudger: deps.nudger,
            pendingCompartmentInjection,
            didMutateFromFlushedStatuses,
            watermark,
            forceMaterializationPercentage: FORCE_MATERIALIZE_PERCENTAGE,
            hasRecentReduceCall,
            projectPath: deps.projectPath,
            sessionDirectory,
            autoSearch: deps.autoSearch,
            // Only forward caveman config when ctx_reduce is disabled — the
            // feature replaces manual ctx_reduce text-dropping for users
            // who opted out of agent-driven reduction. Keeping it gated here
            // means the postprocess/heuristic paths can stay config-agnostic.
            // Only forward caveman config when ctx_reduce is explicitly
            // disabled AND this is not a subagent. The feature replaces
            // manual ctx_reduce text-dropping for users who opted out of
            // agent-driven reduction; subagents should never receive their
            // own caveman compression because they have no equivalent
            // recovery path and their context is already curated by the
            // primary agent that spawned them.
            cavemanTextCompression:
                deps.ctxReduceEnabled === false && !reducedMode
                    ? deps.cavemanTextCompression
                    : undefined,
            // Live provider for whole-message sentinel selection. Anthropic
            // gets `""` (their normalizeMessages filters it out of the wire);
            // every other provider gets `[dropped]` so empty assistant
            // messages don't reach providers that reject them (Kimi/Moonshot
            // returns 400 "must not be empty"). See sentinel.ts for details.
            liveProviderID,
        });
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
            }
            let conv = 0;
            let tool = 0;
            for (const part of message.parts) {
                if (!part || typeof part !== "object") continue;
                const p = part as {
                    type?: string;
                    text?: string;
                    thinking?: string;
                    signature?: string;
                    data?: string;
                    ignored?: boolean;
                    state?: { input?: unknown; output?: unknown };
                    args?: unknown;
                    input?: unknown;
                    content?: unknown;
                    mime?: string;
                    metadata?: { anthropic?: { signature?: string } };
                };
                if (p.ignored) continue;
                switch (p.type) {
                    case "text": {
                        if (typeof p.text === "string") {
                            conv += estimateTokens(p.text);
                        }
                        break;
                    }
                    case "reasoning": {
                        // OpenCode's internal representation of reasoning.
                        // Content is in `text`, signature is in metadata.
                        if (typeof p.text === "string") conv += estimateTokens(p.text);
                        const sig = p.metadata?.anthropic?.signature;
                        if (typeof sig === "string") conv += estimateTokens(sig);
                        break;
                    }
                    case "thinking": {
                        // Anthropic wire-format thinking part. Content is in
                        // `thinking`, signature is in `signature`. Typical
                        // signature ~3,500 chars / ~600 tokens per block.
                        if (typeof p.thinking === "string") conv += estimateTokens(p.thinking);
                        if (typeof p.signature === "string") conv += estimateTokens(p.signature);
                        break;
                    }
                    case "redacted_thinking": {
                        // Redacted thinking: opaque `data` blob, billed as input.
                        if (typeof p.data === "string") conv += estimateTokens(p.data);
                        break;
                    }
                    case "file": {
                        // Images: Anthropic bills by visual tokens using
                        // (width × height) / 750. Parse PNG/JPEG/WebP/GIF
                        // headers from the data URL to get real dimensions
                        // instead of over-estimating from base64 char length.
                        // https://docs.claude.com/en/build-with-claude/vision
                        if (typeof p.mime === "string" && p.mime.startsWith("image/")) {
                            const url =
                                typeof (p as { url?: unknown }).url === "string"
                                    ? (p as { url: string }).url
                                    : undefined;
                            if (url?.startsWith("data:")) {
                                conv += estimateImageTokensFromDataUrl(url);
                            } else {
                                conv += 1200; // fallback for non-data-url refs
                            }
                        }
                        break;
                    }
                    case "tool": {
                        // OpenCode format: { state: { input, output } }
                        if (p.state && typeof p.state === "object") {
                            if (p.state.input !== undefined) {
                                const s =
                                    typeof p.state.input === "string"
                                        ? p.state.input
                                        : JSON.stringify(p.state.input);
                                if (s) tool += estimateTokens(s);
                            }
                            if (p.state.output !== undefined) {
                                const s =
                                    typeof p.state.output === "string"
                                        ? p.state.output
                                        : JSON.stringify(p.state.output);
                                if (s) tool += estimateTokens(s);
                            }
                        }
                        break;
                    }
                    case "tool-invocation": {
                        if (p.args !== undefined) {
                            const s = typeof p.args === "string" ? p.args : JSON.stringify(p.args);
                            if (s) tool += estimateTokens(s);
                        }
                        break;
                    }
                    case "tool_use": {
                        if (p.input !== undefined) {
                            const s =
                                typeof p.input === "string" ? p.input : JSON.stringify(p.input);
                            if (s) tool += estimateTokens(s);
                        }
                        break;
                    }
                    case "tool_result": {
                        if (p.content !== undefined) {
                            const s =
                                typeof p.content === "string"
                                    ? p.content
                                    : JSON.stringify(p.content);
                            if (s) tool += estimateTokens(s);
                        }
                        break;
                    }
                }
            }
            if (mid) msgTokens.set(mid, { conversation: conv, toolCall: tool });
            conversationTokens += conv;
            toolCallTokens += tool;
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

        const elapsed = (performance.now() - startTime).toFixed(1);
        sessionLog(
            sessionId,
            `transform completed in ${elapsed}ms (${messages.length} messages, ${targets.size} targets, watermark: ${watermark})`,
        );
    };
}

function hasEligibleCompartmentHistory(db: ContextDatabase, sessionId: string): boolean {
    try {
        const lastCompartmentEnd = getLastCompartmentEndMessage(db, sessionId);
        const nextStartOrdinal = Math.max(1, lastCompartmentEnd + 1);
        const rawMessageCount = getRawSessionMessageCount(sessionId);
        const protectedTailStart = getProtectedTailStartOrdinal(sessionId);

        return rawMessageCount >= nextStartOrdinal && nextStartOrdinal < protectedTailStart;
    } catch (error) {
        sessionLog(sessionId, "transform: failed checking eligible compartment history:", error);
        return false;
    }
}

function resolveHistoryBudgetTokens(
    historyBudgetPercentage: number | undefined,
    contextUsage: ContextUsage,
    executeThresholdPercentage:
        | number
        | { default: number; [modelKey: string]: number }
        | undefined,
    modelKey: string | undefined,
    executeThresholdTokens?: { default?: number; [modelKey: string]: number | undefined },
): number | undefined {
    if (!historyBudgetPercentage || contextUsage.percentage <= 0) {
        return undefined;
    }

    const derivedContextLimit = contextUsage.inputTokens / (contextUsage.percentage / 100);
    return Math.floor(
        derivedContextLimit *
            (resolveExecuteThreshold(executeThresholdPercentage ?? 65, modelKey, 65, {
                tokensConfig: executeThresholdTokens,
                contextLimit: derivedContextLimit,
            }) /
                100) *
            historyBudgetPercentage,
    );
}

function truncateHistorianEmergencyError(error: string | null): string {
    const normalized = (error ?? "unknown error").replace(/\s+/g, " ").trim();
    if (normalized.length <= 100) {
        return normalized;
    }

    return `${normalized.slice(0, 100)}…`;
}
