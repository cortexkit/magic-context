import type { createCompactionHandler } from "../../features/magic-context/compaction";
import { scheduleClearAndReindex } from "../../features/magic-context/message-index-async";
import {
    detectOverflow,
    detectThinkingBindingMismatch,
    isFable51ThinkingBindingModel,
} from "../../features/magic-context/overflow-detection";
import {
    armThinkingBindingRecovery,
    clearDetectedContextLimit,
    clearHistorianFailureState,
    clearPendingCompactionMarkerStateIf,
    clearSession,
    deleteIndexedMessage,
    deleteTagsByMessageId,
    getHistorianFailureState,
    getMaxTagNumberBySession,
    getOrCreateSessionMeta,
    getOverflowState,
    getPendingCompactionMarkerState,
    getPersistedNoteNudge,
    getPersistedReasoningWatermark,
    markSessionCleanupPending,
    recordDetectedContextLimit,
    recordOverflowDetected,
    removeAutoSearchHintDecisionByMessageId,
    removeNoteNudgeAnchorByMessageId,
    removeStrippedPlaceholderId,
    setPersistedReasoningWatermark,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    getChannel2NudgeState,
    getPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import type { Tagger } from "../../features/magic-context/tagger";
import {
    clearTransformDecisionSession,
    scheduleOpenCodeTransformDecisionWrite,
} from "../../features/magic-context/transform-decision-log";
import type { ContextUsage, SessionMeta } from "../../features/magic-context/types";
import { captureWindowReport } from "../../features/magic-context/window-report-ledger";
import { log, sessionLog } from "../../shared/logger";
import {
    getSdkContextLimit,
    refreshModelLimitsAfterAuthOnce,
    refreshModelLimitsFromApi,
} from "../../shared/models-dev-cache";
import { hasTrustedAbsoluteWall } from "../../shared/window-geometry";
import { maybeDeliverChannel2 } from "./channel2-delivery";
import { removeCompactionMarkerForSession } from "./compaction-marker-manager";
import {
    getMessageRemovedInfo,
    getMessageUpdatedAssistantInfo,
    getMessageUpdatedInfo,
    getSessionCreatedInfo,
    getSessionErrorInfo,
    getSessionProperties,
} from "./event-payloads";
import {
    resolveCacheTtl,
    resolveContextLimit,
    resolveContextWindowGeometry,
    resolveModelKey,
    resolveSessionId,
} from "./event-resolvers";
import { dropSlot } from "./lkg-slot";
import { clearNoteNudgeTriggerOnly } from "./note-nudger";
import { readRawSessionMessages } from "./read-session-chunk";
import {
    clearTrackedOpenCodeSession,
    findLastAssistantModelFromOpenCodeDb,
    observeOpenCodeTurnEvent,
} from "./read-session-db";
import { invalidateTrueRawTokenCache } from "./read-session-true-raw-tokens";
import { type NotificationParams, sendStatusNotification } from "./send-session-notification";
import { clearMessageTokensCache } from "./transform";
import { resetDegradedCacheCount } from "./transform-postprocess-phase";

const CONTEXT_USAGE_TTL_MS = 60 * 60 * 1000;
const usageRefusalLogSeen = new Set<string>();

type CacheTtlConfig = string | Record<string, string>;

interface ContextUsageEntry {
    usage: ContextUsage;
    updatedAt: number;
    lastResponseTime?: number;
    hasUsageTokens?: boolean;
}

interface MessageRemovedCleanupResult {
    clearedNoteNudge: boolean;
}

export interface EventHandlerDeps {
    subagentReconciliation?: boolean;
    contextUsageMap: Map<string, ContextUsageEntry>;
    compactionHandler: ReturnType<typeof createCompactionHandler>;
    /**
     * Compaction-off mode (issue #266), boot-resolved. Overflow recovery is
     * never armed in this mode (record the provider-reported limit only, so
     * raw-usage math stays accurate) and Channel-2 delivery stays silent;
     * the off-transition clears any persisted intent.
     */
    compactionOff?: boolean;
    /** The host-side recovery arm is TS-only until the module protocol carries this flag. */
    thinkingBindingRecoveryEnabled?: boolean;
    onSessionCacheInvalidated?: (sessionId: string) => void;
    onRustWireInvalidated?: (sessionId: string) => void;
    onSessionDeleted?: (sessionId: string) => Promise<void> | void;
    rustSessionCleanup?: boolean;
    config: {
        clear_reasoning_age?: number;
        execute_threshold_percentage?: number | { default: number; [modelKey: string]: number };
        execute_threshold_tokens?: {
            default?: number;
            [modelKey: string]: number | undefined;
        };
        cache_ttl: CacheTtlConfig;
        commit_cluster_trigger?: { enabled: boolean; min_clusters: number };
    };
    tagger: Tagger;
    // openDatabase() returns Database | null, but the hook only constructs these
    // deps after it has already null-checked and disabled MC on storage failure,
    // so by this point db is always a live handle.
    db: import("../../shared/sqlite").Database;
    /** The in-process client OpenCode hands the plugin; Channel 2 delivers through it. */
    client?: unknown;
    /** Channel 1 per-session metric baseline; read for the Channel 2 ceiling-nudge wording. */
    channel1StateBySession?: Map<string, import("./ctx-reduce-nudge").Channel1State>;
    /** Hold Rust module directives until the terminal `message.updated` event, just like TypeScript nudge directives, so both use the same host-side delivery path. */
    channel2DirectiveTextBySession?: Map<string, string>;
    getNotificationParams?: (sessionId: string) => NotificationParams;
    /**
     * Process-scoped set of Magic Context's own hidden child sessions, keyed by
     * sessionId. Populated here at `session.created` when the child's title
     * starts with `magic-context-`; read by the transform + system-prompt hooks
     * to fully exempt these sessions from the MC pipeline.
     */
    internalChildSessions?: Set<string>;
}

/** Title prefix used by every Magic Context hidden child session. */
const INTERNAL_CHILD_TITLE_PREFIX = "magic-context-";

function formatTokens(value: number): string {
    return value.toLocaleString();
}

function evictExpiredUsageEntries(contextUsageMap: Map<string, ContextUsageEntry>): void {
    const now = Date.now();
    for (const [sessionId, entry] of contextUsageMap) {
        if (now - entry.updatedAt > CONTEXT_USAGE_TTL_MS) {
            contextUsageMap.delete(sessionId);
        }
    }
}

/**
 * Fire-and-forget Channel 2 ceiling-nudge delivery for an assistant step-boundary
 * event. Primary sessions keep their existing final-stop fallback; subagents are
 * delivered only while their run is still active. No-ops unless a `pending`
 * intent exists; reads the undropped-token count from the Channel 1 baseline for
 * the nudge wording.
 */
async function deliverChannel2IfPending(deps: EventHandlerDeps, sessionId: string): Promise<void> {
    try {
        // Channel 2 fires for primaries AND subagents. Delivery routes through the
        // in-process client (input.client), which on OpenCode >= 1.17.7 coalesces
        // the synthetic-user nudge into the in-flight runner; it no-ops unless a
        // `pending` intent exists, a client is wired, and a subagent run is still
        // active.
        const baseline = deps.channel1StateBySession?.get(sessionId);
        // A reduce after the persisted generation invalidates its U/T values.
        // Hold the pending intent until a cache-busting pass rewalks the final
        // rendered tail; delivery must never burn the cap from stale mass.
        if (baseline?.reducedSinceRefresh) return;
        const delivered = await maybeDeliverChannel2(sessionId, {
            db: deps.db,
            client: deps.client,
            directiveText: deps.channel2DirectiveTextBySession?.get(sessionId),
            baseline,
            oldestReclaimableToolTags: baseline?.oldestReclaimableToolTags,
        });
        if (delivered || getChannel2NudgeState(deps.db, sessionId) !== "pending") {
            deps.channel2DirectiveTextBySession?.delete(sessionId);
        }
    } catch (error) {
        sessionLog(sessionId, "channel2 delivery wrapper failed (ignored):", error);
    }
}

function cleanupRemovedMessageState(
    deps: EventHandlerDeps,
    sessionId: string,
    messageId: string,
): MessageRemovedCleanupResult {
    return deps.db.transaction(() => {
        const removedTagNumbers = deleteTagsByMessageId(deps.db, sessionId, messageId);
        sessionLog(
            sessionId,
            `event message.removed: deleted ${removedTagNumbers.length} tag(s) for message ${messageId}`,
        );

        const strippedPlaceholderRemoved = removeStrippedPlaceholderId(
            deps.db,
            sessionId,
            messageId,
        );
        sessionLog(
            sessionId,
            strippedPlaceholderRemoved
                ? `event message.removed: removed ${messageId} from stripped placeholder ids`
                : `event message.removed: stripped placeholder ids unchanged for ${messageId}`,
        );

        const removedNoteNudgeAnchor = removeNoteNudgeAnchorByMessageId(
            deps.db,
            sessionId,
            messageId,
        );
        const removedAutoSearchDecision = removeAutoSearchHintDecisionByMessageId(
            deps.db,
            sessionId,
            messageId,
        );
        const persistedNoteNudge = getPersistedNoteNudge(deps.db, sessionId);
        const clearedNoteNudgeTrigger = persistedNoteNudge.triggerMessageId === messageId;
        if (clearedNoteNudgeTrigger) {
            clearNoteNudgeTriggerOnly(deps.db, sessionId);
        }
        const clearedNoteNudge = removedNoteNudgeAnchor || clearedNoteNudgeTrigger;
        sessionLog(
            sessionId,
            clearedNoteNudge
                ? `event message.removed: pruned note nudge state for ${messageId}`
                : `event message.removed: note nudge state unchanged for ${messageId}`,
        );
        sessionLog(
            sessionId,
            removedAutoSearchDecision
                ? `event message.removed: pruned auto-search decision for ${messageId}`
                : `event message.removed: auto-search decision unchanged for ${messageId}`,
        );

        const currentWatermark = getPersistedReasoningWatermark(deps.db, sessionId);
        const maxRemainingTag = getMaxTagNumberBySession(deps.db, sessionId);
        if (currentWatermark > maxRemainingTag) {
            setPersistedReasoningWatermark(deps.db, sessionId, maxRemainingTag);
            sessionLog(
                sessionId,
                `event message.removed: reset reasoning watermark ${currentWatermark}→${maxRemainingTag}`,
            );
        } else {
            sessionLog(
                sessionId,
                `event message.removed: reasoning watermark unchanged at ${currentWatermark} (max tag ${maxRemainingTag})`,
            );
        }

        const removedIndexedMessages = deleteIndexedMessage(deps.db, sessionId, messageId);
        sessionLog(
            sessionId,
            `event message.removed: deleted ${removedIndexedMessages} indexed message row(s) for ${messageId}`,
        );

        return {
            clearedNoteNudge,
        };
    })();
}

export function createEventHandler(deps: EventHandlerDeps) {
    return async (input: { event: { type: string; properties?: unknown } }): Promise<void> => {
        evictExpiredUsageEntries(deps.contextUsageMap);
        observeOpenCodeTurnEvent(input.event.type, input.event.properties);

        const properties = getSessionProperties(input.event.properties);

        if (input.event.type === "session.created") {
            const info = getSessionCreatedInfo(input.event.properties);
            if (!info) {
                return;
            }

            // Flag our own hidden children (historian/dreamer/memory-migration)
            // by their `magic-context-` title prefix so the
            // transform + system-prompt hooks can fully exempt them. In-memory
            // only — these sessions never span a restart.
            if (
                deps.internalChildSessions &&
                info.parentID.length > 0 &&
                typeof info.title === "string" &&
                info.title.startsWith(INTERNAL_CHILD_TITLE_PREFIX)
            ) {
                deps.internalChildSessions.add(info.id);
                sessionLog(
                    info.id,
                    `marked internal magic-context child (title="${info.title}") — exempt from transform + injection`,
                );
            }

            try {
                const modelKey = resolveModelKey(info.providerID, info.modelID);
                updateSessionMeta(deps.db, info.id, {
                    isSubagent: info.parentID.length > 0,
                    cacheTtl: resolveCacheTtl(deps.config.cache_ttl, modelKey),
                });
            } catch (error) {
                sessionLog(info.id, "event session.created persistence failed:", error);
            }
            return;
        }

        if (input.event.type === "session.error") {
            const errInfo = getSessionErrorInfo(input.event.properties);
            if (!errInfo) {
                return;
            }
            try {
                const bindingMismatch = detectThinkingBindingMismatch(errInfo.error);
                if (bindingMismatch.isBindingMismatch) {
                    const model = findLastAssistantModelFromOpenCodeDb(errInfo.sessionID);
                    if (
                        deps.thinkingBindingRecoveryEnabled !== false &&
                        !deps.compactionOff &&
                        isFable51ThinkingBindingModel(model?.providerID, model?.modelID)
                    ) {
                        armThinkingBindingRecovery(
                            deps.db,
                            errInfo.sessionID,
                            bindingMismatch.messageId,
                        );
                        dropSlot(errInfo.sessionID, "thinking-binding-recovery-arm");
                        deps.onSessionCacheInvalidated?.(errInfo.sessionID);
                    }
                    return;
                }

                const detection = detectOverflow(errInfo.error);
                if (!detection.isOverflow) {
                    return;
                }
                captureWindowReport({
                    db: deps.db,
                    sessionID: errInfo.sessionID,
                    providerID: errInfo.providerID,
                    modelID: errInfo.modelID,
                    matchedPattern: detection.matchedPattern,
                    reportedLimit: detection.reportedLimit,
                    reportedLimitProvenance: detection.reportedLimitProvenance,
                    error: errInfo.error,
                });
                // Subagents cannot recover from overflow themselves — the
                // transform-side emergency path (`needs_emergency_recovery` →
                // 95% → historian) is gated by `fullFeatureMode` and skips
                // subagents anyway. Recording the flag would just leave
                // orphan state that nothing ever consumes, and if the session
                // were ever re-classified as a primary it would silently
                // trigger unwarranted emergency recovery. The overflow error
                // still propagates to OpenCode / the parent agent through the
                // normal event pipeline; that's the right recovery surface.
                const sessionMeta = getOrCreateSessionMeta(deps.db, errInfo.sessionID);
                const overflowModelKey =
                    resolveModelKey(errInfo.providerID, errInfo.modelID) ??
                    sessionMeta.lastObservedModelKey ??
                    undefined;
                if (
                    sessionMeta.isSubagent &&
                    (deps.subagentReconciliation !== true ||
                        deps.internalChildSessions?.has(errInfo.sessionID))
                ) {
                    // Subagents can't run historian, so we skip the recovery
                    // flag — but the reported limit is still useful data for
                    // pressure math (consumed by resolveContextLimit via
                    // getOverflowState). Record it without arming recovery.
                    if (
                        typeof detection.reportedLimit === "number" &&
                        detection.reportedLimit > 0
                    ) {
                        recordDetectedContextLimit(
                            deps.db,
                            errInfo.sessionID,
                            detection.reportedLimit,
                            overflowModelKey,
                            detection.reportedLimitProvenance,
                        );
                    }
                    sessionLog(
                        errInfo.sessionID,
                        `overflow detected on subagent: reportedLimit=${detection.reportedLimit ?? "unknown"} provenance=${detection.reportedLimitProvenance ?? "n/a"} pattern=${detection.matchedPattern ?? "n/a"} — recorded limit only (subagents cannot run historian)`,
                    );
                    return;
                }
                const existing = getOverflowState(deps.db, errInfo.sessionID);
                if (deps.compactionOff) {
                    // Compaction-off: never arm MC emergency recovery — the
                    // latch machinery is gated off and the off-transition
                    // clears any persisted latch. The provider-reported limit
                    // is still useful for raw-usage math (the sidebar's only
                    // numeric source in this mode), so record it without
                    // arming, exactly like the subagent path above.
                    if (
                        typeof detection.reportedLimit === "number" &&
                        detection.reportedLimit > 0
                    ) {
                        recordDetectedContextLimit(
                            deps.db,
                            errInfo.sessionID,
                            detection.reportedLimit,
                            overflowModelKey,
                            detection.reportedLimitProvenance,
                        );
                    }
                    sessionLog(
                        errInfo.sessionID,
                        `overflow detected in compaction-off mode: reportedLimit=${detection.reportedLimit ?? "unknown"} provenance=${detection.reportedLimitProvenance ?? "n/a"} pattern=${detection.matchedPattern ?? "n/a"} — recorded limit only (recovery disarmed; native compaction owns the window)`,
                    );
                    return;
                }
                dropSlot(errInfo.sessionID, "overflow-recovery-arm");
                recordOverflowDetected(
                    deps.db,
                    errInfo.sessionID,
                    detection.reportedLimit,
                    overflowModelKey,
                    "provider_overflow",
                    detection.reportedLimitProvenance,
                );
                sessionLog(
                    errInfo.sessionID,
                    `overflow detected via session.error: reportedLimit=${detection.reportedLimit ?? "unknown"} provenance=${detection.reportedLimitProvenance ?? "n/a"} pattern=${detection.matchedPattern ?? "n/a"} (previousRecovery=${existing.needsEmergencyRecovery})`,
                );
                deps.onSessionCacheInvalidated?.(errInfo.sessionID);
            } catch (error) {
                sessionLog(errInfo.sessionID, "event session.error handling failed:", error);
            }
            return;
        }

        if (input.event.type === "message.updated") {
            const info = getMessageUpdatedAssistantInfo(input.event.properties);
            if (!info) {
                const genericInfo = getMessageUpdatedInfo(input.event.properties);
                if (genericInfo?.role === "user") return;
                const sessionId = properties ? resolveSessionId(properties) : null;
                if (sessionId) {
                    sessionLog(
                        sessionId,
                        "event message.updated: no assistant info extracted from event",
                    );
                } else {
                    log(
                        "[magic-context] event message.updated: no assistant info extracted from event",
                    );
                }
                return;
            }

            // Invalidate this message's cached token contribution. The message
            // content is finalized at this event — if a prior transform pass
            // happened to cache partial/streaming content (or the message is
            // being edited/retried), the next pass must recompute. We fall
            // back to session-wide clear when the event lacks a message id.
            if (info.messageID) {
                clearMessageTokensCache(info.sessionID, info.messageID);
                invalidateTrueRawTokenCache({
                    sessionId: info.sessionID,
                    messageId: info.messageID,
                    reason: "message.updated",
                });
            } else {
                clearMessageTokensCache(info.sessionID);
                invalidateTrueRawTokenCache({
                    sessionId: info.sessionID,
                    reason: "message.updated",
                });
            }

            let messageHadOverflowError = false;

            if (info.error !== undefined && info.error !== null) {
                const bindingMismatch = detectThinkingBindingMismatch(info.error);
                if (
                    bindingMismatch.isBindingMismatch &&
                    deps.thinkingBindingRecoveryEnabled !== false &&
                    !deps.compactionOff &&
                    isFable51ThinkingBindingModel(info.providerID, info.modelID)
                ) {
                    try {
                        armThinkingBindingRecovery(
                            deps.db,
                            info.sessionID,
                            bindingMismatch.messageId,
                        );
                        dropSlot(info.sessionID, "thinking-binding-recovery-arm");
                        deps.onSessionCacheInvalidated?.(info.sessionID);
                    } catch (error) {
                        sessionLog(
                            info.sessionID,
                            "event message.updated thinking binding recovery persistence failed:",
                            error,
                        );
                    }
                }
            }

            // Secondary overflow-detection path: OpenCode attaches overflow
            // errors to the assistant message itself in addition to emitting
            // session.error. Checking both ensures we catch the error no
            // matter which event arrives first or fails to arrive at all.
            // Same subagent skip as the session.error path — subagents have
            // no emergency recovery machinery that can consume this flag.
            if (info.error !== undefined && info.error !== null) {
                const detection = detectOverflow(info.error);
                if (detection.isOverflow) {
                    messageHadOverflowError = true;
                    try {
                        captureWindowReport({
                            db: deps.db,
                            sessionID: info.sessionID,
                            providerID: info.providerID,
                            modelID: info.modelID,
                            matchedPattern: detection.matchedPattern,
                            reportedLimit: detection.reportedLimit,
                            reportedLimitProvenance: detection.reportedLimitProvenance,
                            attemptedTokens:
                                (info.tokens?.input ?? 0) +
                                (info.tokens?.cache?.read ?? 0) +
                                (info.tokens?.cache?.write ?? 0),
                            error: info.error,
                        });
                        const overflowModelKey = resolveModelKey(info.providerID, info.modelID);
                        const metaForOverflow = getOrCreateSessionMeta(deps.db, info.sessionID);
                        if (
                            metaForOverflow.isSubagent &&
                            (deps.subagentReconciliation !== true ||
                                deps.internalChildSessions?.has(info.sessionID))
                        ) {
                            // Still record the detected limit (useful for
                            // pressure math), but don't arm recovery — see
                            // session.error path above.
                            if (
                                typeof detection.reportedLimit === "number" &&
                                detection.reportedLimit > 0
                            ) {
                                recordDetectedContextLimit(
                                    deps.db,
                                    info.sessionID,
                                    detection.reportedLimit,
                                    overflowModelKey,
                                    detection.reportedLimitProvenance,
                                );
                            }
                            sessionLog(
                                info.sessionID,
                                `overflow detected on subagent via message.updated: reportedLimit=${detection.reportedLimit ?? "unknown"} provenance=${detection.reportedLimitProvenance ?? "n/a"} pattern=${detection.matchedPattern ?? "n/a"} — recorded limit only`,
                            );
                        } else if (deps.compactionOff) {
                            // Compaction-off: record the limit only, never arm
                            // recovery (mirrors the session.error path above).
                            if (
                                typeof detection.reportedLimit === "number" &&
                                detection.reportedLimit > 0
                            ) {
                                recordDetectedContextLimit(
                                    deps.db,
                                    info.sessionID,
                                    detection.reportedLimit,
                                    overflowModelKey,
                                    detection.reportedLimitProvenance,
                                );
                            }
                            sessionLog(
                                info.sessionID,
                                `overflow detected in compaction-off mode via message.updated: reportedLimit=${detection.reportedLimit ?? "unknown"} provenance=${detection.reportedLimitProvenance ?? "n/a"} pattern=${detection.matchedPattern ?? "n/a"} — recorded limit only`,
                            );
                        } else {
                            dropSlot(info.sessionID, "overflow-recovery-arm");
                            recordOverflowDetected(
                                deps.db,
                                info.sessionID,
                                detection.reportedLimit,
                                overflowModelKey,
                                "provider_overflow",
                                detection.reportedLimitProvenance,
                            );
                            sessionLog(
                                info.sessionID,
                                `overflow detected via message.updated: reportedLimit=${detection.reportedLimit ?? "unknown"} provenance=${detection.reportedLimitProvenance ?? "n/a"} pattern=${detection.matchedPattern ?? "n/a"}`,
                            );
                            deps.onSessionCacheInvalidated?.(info.sessionID);
                        }
                    } catch (error) {
                        sessionLog(
                            info.sessionID,
                            "event message.updated overflow persistence failed:",
                            error,
                        );
                    }
                }
            }

            const now = Date.now();
            const usageTokens = [
                info.tokens?.input,
                info.tokens?.cache?.read,
                info.tokens?.cache?.write,
            ];
            const hasUsageTokens = usageTokens.some(
                (value) => typeof value === "number" && value > 0,
            );
            const terminalAssistantUpdate =
                info.messageID !== undefined &&
                hasUsageTokens &&
                (typeof info.finish === "string" || typeof info.completedAt === "number");
            if (terminalAssistantUpdate && info.messageID) {
                scheduleOpenCodeTransformDecisionWrite({
                    db: deps.db,
                    sessionId: info.sessionID,
                    messageId: info.messageID,
                    inputTokens:
                        (info.tokens?.input ?? 0) +
                        (info.tokens?.cache?.read ?? 0) +
                        (info.tokens?.cache?.write ?? 0),
                });
            }

            sessionLog(
                info.sessionID,
                `event message.updated: provider=${info.providerID} model=${info.modelID} hasUsageTokens=${hasUsageTokens} tokens.input=${info.tokens?.input} cache.read=${info.tokens?.cache?.read} cache.write=${info.tokens?.cache?.write}`,
            );

            const hasKnownUsage = hasUsageTokens || deps.contextUsageMap.has(info.sessionID);
            if (!hasKnownUsage) {
                sessionLog(
                    info.sessionID,
                    "event message.updated: skipping — no usage tokens and no known usage",
                );
                return;
            }

            try {
                const modelKey = resolveModelKey(info.providerID, info.modelID);
                const updates: Partial<SessionMeta> & { lastResponseTime: number } = {
                    lastResponseTime: now,
                };

                if (typeof deps.config.cache_ttl === "string") {
                    updates.cacheTtl = resolveCacheTtl(deps.config.cache_ttl, modelKey);
                } else if (modelKey) {
                    updates.cacheTtl = resolveCacheTtl(deps.config.cache_ttl, modelKey);
                }

                if (hasUsageTokens) {
                    const totalInputTokens =
                        (info.tokens?.input ?? 0) +
                        (info.tokens?.cache?.read ?? 0) +
                        (info.tokens?.cache?.write ?? 0);
                    const baseGeometry = resolveContextWindowGeometry(
                        info.providerID,
                        info.modelID,
                    );
                    const trustedAbsoluteWall =
                        baseGeometry && hasTrustedAbsoluteWall(baseGeometry)
                            ? baseGeometry.derivation.absoluteWall
                            : undefined;
                    const usageReadingValid =
                        trustedAbsoluteWall === undefined ||
                        totalInputTokens <= trustedAbsoluteWall;
                    if (!usageReadingValid && trustedAbsoluteWall !== undefined) {
                        const refusalKey = `${info.sessionID}|${modelKey ?? "unknown"}`;
                        if (!usageRefusalLogSeen.has(refusalKey)) {
                            usageRefusalLogSeen.add(refusalKey);
                            sessionLog(
                                info.sessionID,
                                `usage accounting refused reading ${totalInputTokens} above trusted absolute wall ${trustedAbsoluteWall}; sample ignored`,
                            );
                        }
                    }
                    const pressureInputTokens = usageReadingValid ? totalInputTokens : 0;
                    // Auth is provably live now (a request returned usage), so
                    // re-warm the model-limit cache once per process to overwrite
                    // any stale pre-auth limit (e.g. gpt-5.5 cached at the raw
                    // 922k before the OAuth 272k downshift applied, #179). No-op
                    // after the first successful warm.
                    if (deps.client) {
                        await refreshModelLimitsAfterAuthOnce(
                            deps.client as Parameters<typeof refreshModelLimitsAfterAuthOnce>[0],
                        );
                    }
                    const requestSucceeded = !messageHadOverflowError;
                    const successfulUsageProof = requestSucceeded && usageReadingValid;
                    if (successfulUsageProof) {
                        const rawOverflow = getOverflowState(deps.db, info.sessionID);
                        const detectedLimitMatchesModel =
                            rawOverflow.detectedContextLimitModelKey === null ||
                            (modelKey !== undefined &&
                                rawOverflow.detectedContextLimitModelKey === modelKey);
                        if (
                            rawOverflow.detectedContextLimit > 0 &&
                            detectedLimitMatchesModel &&
                            pressureInputTokens > rawOverflow.detectedContextLimit
                        ) {
                            clearDetectedContextLimit(deps.db, info.sessionID);
                            sessionLog(
                                info.sessionID,
                                `detected limit ${rawOverflow.detectedContextLimit} invalidated by a successful ${pressureInputTokens}-token request; using catalog/default`,
                            );
                            deps.onSessionCacheInvalidated?.(info.sessionID);
                        }
                    }

                    let contextLimit = resolveContextLimit(info.providerID, info.modelID, {
                        db: deps.db,
                        sessionID: info.sessionID,
                    });
                    const sessionMeta = getOrCreateSessionMeta(deps.db, info.sessionID);
                    const observedSafeInputTokens = sessionMeta.observedSafeInputTokens ?? 0;
                    const provenSafeInputTokens = successfulUsageProof
                        ? Math.max(observedSafeInputTokens, pressureInputTokens)
                        : observedSafeInputTokens;
                    let catalogLimit =
                        info.providerID && info.modelID
                            ? getSdkContextLimit(info.providerID, info.modelID)
                            : undefined;

                    if (
                        successfulUsageProof &&
                        catalogLimit !== undefined &&
                        catalogLimit < provenSafeInputTokens
                    ) {
                        const oldLimit = catalogLimit;
                        if (deps.client) {
                            await refreshModelLimitsFromApi(
                                deps.client as Parameters<typeof refreshModelLimitsFromApi>[0],
                            );
                            catalogLimit =
                                info.providerID && info.modelID
                                    ? getSdkContextLimit(info.providerID, info.modelID)
                                    : undefined;
                            contextLimit = resolveContextLimit(info.providerID, info.modelID, {
                                db: deps.db,
                                sessionID: info.sessionID,
                            });
                            if (
                                catalogLimit !== undefined &&
                                catalogLimit >= provenSafeInputTokens
                            ) {
                                sessionLog(
                                    info.sessionID,
                                    `models-dev-cache: regression recovered for ${info.providerID}/${info.modelID} via refresh (was=${oldLimit}, now=${catalogLimit})`,
                                );
                            }
                        }

                        if (
                            catalogLimit !== undefined &&
                            catalogLimit < provenSafeInputTokens &&
                            !sessionMeta.cacheAlertSent
                        ) {
                            const delivery = await sendStatusNotification(
                                deps.client,
                                info.sessionID,
                                `⚠️ Magic Context: OpenCode's catalog reports a context limit of ${formatTokens(catalogLimit)} tokens for ${info.providerID}/${info.modelID}, but this session has sent ${formatTokens(provenSafeInputTokens)} tokens successfully. Magic Context will keep using the larger proven value for its pressure math. If the catalog is wrong for your provider, set provider.<provider-id>.models.<model-id>.limit.context in opencode.json.`,
                                deps.getNotificationParams?.(info.sessionID) ?? {},
                            );
                            // Retry only if the RPC notification could not be enqueued.
                            if (delivery === "sent") {
                                updates.cacheAlertSent = true;
                            }
                        }
                    }

                    if (successfulUsageProof) {
                        contextLimit = Math.max(contextLimit, provenSafeInputTokens);
                    }
                    const percentage =
                        contextLimit > 0 ? (pressureInputTokens / contextLimit) * 100 : 0;
                    sessionLog(
                        info.sessionID,
                        `event message.updated: totalInputTokens=${pressureInputTokens} contextLimit=${contextLimit} percentage=${percentage.toFixed(1)}%`,
                    );

                    deps.contextUsageMap.set(info.sessionID, {
                        usage: {
                            percentage,
                            inputTokens: pressureInputTokens,
                        },
                        updatedAt: now,
                        lastResponseTime: now,
                        hasUsageTokens: true,
                    });

                    updates.lastContextPercentage = percentage;
                    updates.lastInputTokens = pressureInputTokens;
                    updates.lastUsageContextLimit = contextLimit;
                    updates.lastObservedModelKey = modelKey ?? null;
                    if (successfulUsageProof) {
                        updates.observedSafeInputTokens = provenSafeInputTokens;
                    }

                    const historianFailureState = getHistorianFailureState(deps.db, info.sessionID);
                    if (historianFailureState.failureCount > 0 && percentage < 90) {
                        clearHistorianFailureState(deps.db, info.sessionID);
                        sessionLog(
                            info.sessionID,
                            `event message.updated: cleared historian failure state at ${percentage.toFixed(1)}%`,
                        );
                    }

                    // NOTE: the historian trigger decision used to run here on
                    // every message.updated event — but this handler has no
                    // message array, so it re-read the session tail from
                    // opencode.db per streaming delta (~186ms of synchronous
                    // SQLite on a large session, freezing the event loop and
                    // making parallel hooks like tool.definition measure
                    // seconds). The decision moved into the transform
                    // (transform.ts, before prepareCompartmentInjection), which
                    // receives the post-marker tail in memory and runs once per
                    // LLM request — the cadence at which the decision inputs
                    // actually change. This handler keeps usage tracking only.
                }

                updateSessionMeta(deps.db, info.sessionID, updates);
            } catch (error) {
                sessionLog(info.sessionID, "event message.updated persistence failed:", error);
            }

            // Channel 2 ceiling nudge delivery. Fire on STEP boundaries — both
            // mid-turn ("tool-calls") and turn-end ("stop") assistant events for
            // primaries; the delivery helper rejects terminal subagent runs.
            // Mid-turn delivery is the point of the channel: the reclaimable
            // pile grows WHILE the agent works, and a queued user message is
            // picked up by OpenCode's run loop at the next step boundary
            // (runLoop re-reads the message table every iteration), so the
            // agent gets warned while it can still act this turn — waiting for
            // idle would deliver the warning after all the growth already
            // happened. promptAsync is mid-turn-safe: the in-process client
            // (input.client) coalesces into the in-flight run on OpenCode
            // >= 1.17.7, never splicing mid-prefix. Fires for primaries and
            // subagents alike, but a subagent must still have an active run; it
            // no-ops unless a `pending` intent exists.
            // Fire-and-forget, never blocking the event loop.
            if (
                (info.finish === "stop" || info.finish === "tool-calls") &&
                deps.client &&
                deps.channel1StateBySession &&
                !deps.compactionOff
            ) {
                void deliverChannel2IfPending(deps, info.sessionID);
            }
            return;
        }

        if (input.event.type === "message.removed") {
            const info = getMessageRemovedInfo(input.event.properties);
            if (!info) {
                const sessionId = properties ? resolveSessionId(properties) : null;
                if (sessionId) {
                    sessionLog(
                        sessionId,
                        "event message.removed: no message removal info extracted from event",
                    );
                } else {
                    log(
                        "[magic-context] event message.removed: no message removal info extracted from event",
                    );
                }
                return;
            }

            dropSlot(info.sessionID, "message.removed");
            deps.onRustWireInvalidated?.(info.sessionID);
            sessionLog(
                info.sessionID,
                `event message.removed: invalidating state for message ${info.messageID}`,
            );

            try {
                cleanupRemovedMessageState(deps, info.sessionID, info.messageID);
                scheduleClearAndReindex(deps.db, info.sessionID, readRawSessionMessages);

                deps.tagger.cleanup(info.sessionID);
                sessionLog(
                    info.sessionID,
                    "event message.removed: invalidated tagger session cache",
                );

                // If the removed message is the compaction marker boundary, remove the marker
                const markerState = getPersistedCompactionMarkerState(deps.db, info.sessionID);
                if (
                    markerState &&
                    (markerState.boundaryMessageId === info.messageID ||
                        markerState.summaryMessageId === info.messageID)
                ) {
                    removeCompactionMarkerForSession(deps.db, info.sessionID);
                    sessionLog(
                        info.sessionID,
                        `event message.removed: cleared compaction marker (boundary or summary message removed)`,
                    );
                }

                // Invalidate this message's cached token contribution so the
                // next transform pass recomputes without stale data.
                clearMessageTokensCache(info.sessionID, info.messageID);
                invalidateTrueRawTokenCache({
                    sessionId: info.sessionID,
                    messageId: info.messageID,
                    reason: "message.removed",
                });

                deps.onSessionCacheInvalidated?.(info.sessionID);
                sessionLog(
                    info.sessionID,
                    "event message.removed: cleared session injection cache",
                );
            } catch (error) {
                sessionLog(info.sessionID, "event message.removed cleanup failed:", error);
            }
            return;
        }

        if (input.event.type === "session.compacted") {
            const sessionId = resolveSessionId(properties);
            if (!sessionId) {
                return;
            }

            dropSlot(sessionId, "session.compacted");
            try {
                deps.compactionHandler.onCompacted(sessionId, deps.db);
            } catch (error) {
                sessionLog(sessionId, "event session.compacted handling failed:", error);
            }
            // Native compaction may have deleted the boundary message — remove our marker
            // to avoid stale/orphaned rows. The next historian run will re-inject if needed.
            try {
                removeCompactionMarkerForSession(deps.db, sessionId);
            } catch (error) {
                sessionLog(sessionId, "event session.compacted marker cleanup failed:", error);
            }
            // Plan v6 §8: a user-driven OpenCode compaction makes any deferred
            // pending marker stale (we no longer own that boundary). CAS-clear
            // any pending blob and reset the degraded-cache counter so the
            // next pass starts fresh.
            try {
                const pending = getPendingCompactionMarkerState(deps.db, sessionId);
                if (pending) {
                    clearPendingCompactionMarkerStateIf(deps.db, sessionId, pending);
                }
            } catch (error) {
                sessionLog(
                    sessionId,
                    "event session.compacted pending-marker cleanup failed:",
                    error,
                );
            }
            resetDegradedCacheCount(sessionId);
            // Compaction restructures messages (deletes/replaces some). Clear the
            // per-message token cache for the whole session so the next transform
            // pass recomputes against the new shape instead of serving stale counts.
            clearMessageTokensCache(sessionId);
            invalidateTrueRawTokenCache({ sessionId, reason: "session.compacted" });
            deps.onSessionCacheInvalidated?.(sessionId);
            return;
        }

        if (input.event.type === "session.deleted") {
            const sessionId = resolveSessionId(properties);
            if (!sessionId) {
                return;
            }

            dropSlot(sessionId, "session.deleted");
            clearTrackedOpenCodeSession(sessionId);
            try {
                // Commit the retry marker before any deletion work. clearSession removes
                // it in the same transaction as the session data, so a BUSY/rollback
                // leaves a durable retry for the next maintenance tick.
                // Rust cleanup is distinguished in the initial durable write. If the
                // module call fails, the ordinary sweeper must retain both this marker
                // and the session→project binding needed for a project-scoped retry.
                const rustCleanupPending = markSessionCleanupPending(
                    deps.db,
                    sessionId,
                    deps.rustSessionCleanup === true,
                );
                await deps.onSessionDeleted?.(sessionId);
                // A duplicate deletion may arrive after cleanup switches to TypeScript.
                // Preserve host rows until the pending Rust module deletion succeeds.
                if (!rustCleanupPending || deps.rustSessionCleanup === true) {
                    // Read and remove compaction marker BEFORE clearSession destroys session_meta.
                    // Plan v6: pending_compaction_marker_state lives on the same row, so
                    // clearSession's session_meta DELETE wipes it automatically — no
                    // separate CAS-clear needed here.
                    removeCompactionMarkerForSession(deps.db, sessionId);
                    clearSession(deps.db, sessionId, deps.rustSessionCleanup === true);
                }
            } catch (error) {
                sessionLog(sessionId, "event session.deleted persistence failed:", error);
            }
            resetDegradedCacheCount(sessionId);
            deps.onSessionCacheInvalidated?.(sessionId);
            deps.contextUsageMap.delete(sessionId);
            deps.tagger.cleanup(sessionId);
            clearTransformDecisionSession(sessionId);
            clearMessageTokensCache(sessionId);
            invalidateTrueRawTokenCache({ sessionId, reason: "session.deleted" });
            return;
        }
    };
}
