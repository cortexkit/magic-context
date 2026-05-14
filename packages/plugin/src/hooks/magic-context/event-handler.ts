import type { createCompactionHandler } from "../../features/magic-context/compaction";
import { scheduleClearAndReindex } from "../../features/magic-context/message-index-async";
import { detectOverflow } from "../../features/magic-context/overflow-detection";
import {
    clearHistorianFailureState,
    clearPendingCompactionMarkerStateIf,
    clearPersistedNoteNudge,
    clearPersistedNudgePlacement,
    clearPersistedStickyTurnReminder,
    clearSession,
    deleteIndexedMessage,
    deleteTagsByMessageId,
    getHistorianFailureState,
    getMaxTagNumberBySession,
    getOrCreateSessionMeta,
    getOverflowState,
    getPendingCompactionMarkerState,
    getPersistedNoteNudge,
    getPersistedNudgePlacement,
    getPersistedReasoningWatermark,
    getPersistedStickyTurnReminder,
    recordDetectedContextLimit,
    recordOverflowDetected,
    removeStrippedPlaceholderId,
    setPersistedReasoningWatermark,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { getPersistedCompactionMarkerState } from "../../features/magic-context/storage-meta-persisted";
import type { Tagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import { log, sessionLog } from "../../shared/logger";
import { removeCompactionMarkerForSession } from "./compaction-marker-manager";
import { checkCompartmentTrigger } from "./compartment-trigger";
import { deriveTriggerBudget } from "./derive-budgets";
import {
    getMessageRemovedInfo,
    getMessageUpdatedAssistantInfo,
    getSessionCreatedInfo,
    getSessionErrorInfo,
    getSessionProperties,
} from "./event-payloads";
import {
    resolveCacheTtl,
    resolveContextLimit,
    resolveExecuteThreshold,
    resolveModelKey,
    resolveSessionId,
} from "./event-resolvers";
import { clearNoteNudgeState } from "./note-nudger";
import { readRawSessionMessages } from "./read-session-chunk";
import { clearMessageTokensCache, type NudgePlacementStore } from "./transform";
import { clearCompressorCooldown } from "./transform-compartment-phase";
import { resetDegradedCacheCount } from "./transform-postprocess-phase";

const CONTEXT_USAGE_TTL_MS = 60 * 60 * 1000;

type CacheTtlConfig = string | Record<string, string>;

interface ContextUsageEntry {
    usage: ContextUsage;
    updatedAt: number;
    lastResponseTime?: number;
}

interface MessageRemovedCleanupResult {
    clearedNudgePlacement: boolean;
    clearedNoteNudge: boolean;
}

export interface EventHandlerDeps {
    contextUsageMap: Map<string, ContextUsageEntry>;
    compactionHandler: ReturnType<typeof createCompactionHandler>;
    nudgePlacements: NudgePlacementStore;
    onSessionCacheInvalidated?: (sessionId: string) => void;
    onSessionDeleted?: (sessionId: string) => void;
    config: {
        protected_tags: number;
        auto_drop_tool_age?: number;
        drop_tool_structure?: boolean;
        clear_reasoning_age?: number;
        execute_threshold_percentage?: number | { default: number; [modelKey: string]: number };
        execute_threshold_tokens?: { default?: number; [modelKey: string]: number | undefined };
        cache_ttl: CacheTtlConfig;
        commit_cluster_trigger?: { enabled: boolean; min_clusters: number };
    };
    tagger: Tagger;
    db: ReturnType<typeof import("../../features/magic-context/storage").openDatabase>;
}

function evictExpiredUsageEntries(contextUsageMap: Map<string, ContextUsageEntry>): void {
    const now = Date.now();
    for (const [sessionId, entry] of contextUsageMap) {
        if (now - entry.updatedAt > CONTEXT_USAGE_TTL_MS) {
            contextUsageMap.delete(sessionId);
        }
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

        const persistedNudgePlacement = getPersistedNudgePlacement(deps.db, sessionId);
        const clearedNudgePlacement = persistedNudgePlacement?.messageId === messageId;
        if (clearedNudgePlacement) {
            clearPersistedNudgePlacement(deps.db, sessionId);
        }
        sessionLog(
            sessionId,
            clearedNudgePlacement
                ? `event message.removed: cleared nudge anchor for ${messageId}`
                : `event message.removed: nudge anchor unchanged for ${messageId}`,
        );

        const persistedNoteNudge = getPersistedNoteNudge(deps.db, sessionId);
        const clearedNoteNudge =
            persistedNoteNudge.triggerMessageId === messageId ||
            persistedNoteNudge.stickyMessageId === messageId;
        if (clearedNoteNudge) {
            clearPersistedNoteNudge(deps.db, sessionId);
        }
        sessionLog(
            sessionId,
            clearedNoteNudge
                ? `event message.removed: cleared note nudge state for ${messageId}`
                : `event message.removed: note nudge state unchanged for ${messageId}`,
        );

        const persistedStickyTurnReminder = getPersistedStickyTurnReminder(deps.db, sessionId);
        const clearedStickyTurnReminder = persistedStickyTurnReminder?.messageId === messageId;
        if (clearedStickyTurnReminder) {
            clearPersistedStickyTurnReminder(deps.db, sessionId);
        }
        sessionLog(
            sessionId,
            clearedStickyTurnReminder
                ? `event message.removed: cleared sticky turn reminder for ${messageId}`
                : `event message.removed: sticky turn reminder unchanged for ${messageId}`,
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
            clearedNudgePlacement,
            clearedNoteNudge,
        };
    })();
}

export function createEventHandler(deps: EventHandlerDeps) {
    return async (input: { event: { type: string; properties?: unknown } }): Promise<void> => {
        evictExpiredUsageEntries(deps.contextUsageMap);

        const properties = getSessionProperties(input.event.properties);

        if (input.event.type === "session.created") {
            const info = getSessionCreatedInfo(input.event.properties);
            if (!info) {
                return;
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
                const detection = detectOverflow(errInfo.error);
                if (!detection.isOverflow) {
                    return;
                }
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
                if (sessionMeta.isSubagent) {
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
                        );
                    }
                    sessionLog(
                        errInfo.sessionID,
                        `overflow detected on subagent: reportedLimit=${detection.reportedLimit ?? "unknown"} pattern=${detection.matchedPattern ?? "n/a"} — recorded limit only (subagents cannot run historian)`,
                    );
                    return;
                }
                const existing = getOverflowState(deps.db, errInfo.sessionID);
                recordOverflowDetected(deps.db, errInfo.sessionID, detection.reportedLimit);
                sessionLog(
                    errInfo.sessionID,
                    `overflow detected via session.error: reportedLimit=${detection.reportedLimit ?? "unknown"} pattern=${detection.matchedPattern ?? "n/a"} (previousRecovery=${existing.needsEmergencyRecovery})`,
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
            } else {
                clearMessageTokensCache(info.sessionID);
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
                    try {
                        const metaForOverflow = getOrCreateSessionMeta(deps.db, info.sessionID);
                        if (metaForOverflow.isSubagent) {
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
                                );
                            }
                            sessionLog(
                                info.sessionID,
                                `overflow detected on subagent via message.updated: reportedLimit=${detection.reportedLimit ?? "unknown"} pattern=${detection.matchedPattern ?? "n/a"} — recorded limit only`,
                            );
                        } else {
                            recordOverflowDetected(
                                deps.db,
                                info.sessionID,
                                detection.reportedLimit,
                            );
                            sessionLog(
                                info.sessionID,
                                `overflow detected via message.updated: reportedLimit=${detection.reportedLimit ?? "unknown"} pattern=${detection.matchedPattern ?? "n/a"}`,
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
                const updates: {
                    lastResponseTime: number;
                    cacheTtl?: string;
                    lastContextPercentage?: number;
                    lastInputTokens?: number;
                } = {
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
                    const contextLimit = resolveContextLimit(info.providerID, info.modelID, {
                        db: deps.db,
                        sessionID: info.sessionID,
                    });
                    const percentage =
                        contextLimit > 0 ? (totalInputTokens / contextLimit) * 100 : 0;

                    sessionLog(
                        info.sessionID,
                        `event message.updated: totalInputTokens=${totalInputTokens} contextLimit=${contextLimit} percentage=${percentage.toFixed(1)}%`,
                    );

                    deps.contextUsageMap.set(info.sessionID, {
                        usage: {
                            percentage,
                            inputTokens: totalInputTokens,
                        },
                        updatedAt: now,
                        lastResponseTime: now,
                    });

                    updates.lastContextPercentage = percentage;
                    updates.lastInputTokens = totalInputTokens;

                    const historianFailureState = getHistorianFailureState(deps.db, info.sessionID);
                    if (historianFailureState.failureCount > 0 && percentage < 90) {
                        clearHistorianFailureState(deps.db, info.sessionID);
                        sessionLog(
                            info.sessionID,
                            `event message.updated: cleared historian failure state at ${percentage.toFixed(1)}%`,
                        );
                    }

                    const sessionMeta = getOrCreateSessionMeta(deps.db, info.sessionID);
                    const previousPercentage = sessionMeta.lastContextPercentage;
                    if (!sessionMeta.isSubagent) {
                        const effectiveExecuteThreshold = resolveExecuteThreshold(
                            deps.config.execute_threshold_percentage ?? 65,
                            modelKey,
                            65,
                            {
                                tokensConfig: deps.config.execute_threshold_tokens,
                                contextLimit,
                                sessionId: info.sessionID,
                            },
                        );
                        // Derive trigger_budget from the MAIN model's usable working
                        // space (contextLimit × executeThreshold). This drives the
                        // size-based historian triggers (tail_size, commit_clusters).
                        const triggerBudget = deriveTriggerBudget(
                            contextLimit,
                            effectiveExecuteThreshold,
                        );
                        const triggerResult = checkCompartmentTrigger(
                            deps.db,
                            info.sessionID,
                            sessionMeta,
                            { percentage, inputTokens: totalInputTokens },
                            previousPercentage,
                            effectiveExecuteThreshold,
                            triggerBudget,
                            deps.config.auto_drop_tool_age ?? 100,
                            deps.config.protected_tags,
                            deps.config.clear_reasoning_age ?? 50,
                            deps.config.drop_tool_structure ?? true,
                            deps.config.commit_cluster_trigger,
                        );

                        if (triggerResult.shouldFire) {
                            sessionLog(
                                info.sessionID,
                                `compartment trigger: firing (reason=${triggerResult.reason})`,
                            );
                            updateSessionMeta(deps.db, info.sessionID, {
                                compartmentInProgress: true,
                            });
                        }
                    }
                }

                updateSessionMeta(deps.db, info.sessionID, updates);
            } catch (error) {
                sessionLog(info.sessionID, "event message.updated persistence failed:", error);
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

            sessionLog(
                info.sessionID,
                `event message.removed: invalidating state for message ${info.messageID}`,
            );

            try {
                const cleanup = cleanupRemovedMessageState(deps, info.sessionID, info.messageID);
                scheduleClearAndReindex(deps.db, info.sessionID, readRawSessionMessages);

                deps.tagger.cleanup(info.sessionID);
                sessionLog(
                    info.sessionID,
                    "event message.removed: invalidated tagger session cache",
                );

                if (cleanup.clearedNudgePlacement) {
                    deps.nudgePlacements.clear(info.sessionID, { persist: false });
                    sessionLog(
                        info.sessionID,
                        "event message.removed: cleared in-memory nudge placement cache",
                    );
                }

                if (cleanup.clearedNoteNudge) {
                    clearNoteNudgeState(deps.db, info.sessionID, { persist: false });
                    sessionLog(
                        info.sessionID,
                        "event message.removed: cleared in-memory note nudge state",
                    );
                }

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
            deps.onSessionCacheInvalidated?.(sessionId);
            return;
        }

        if (input.event.type === "session.deleted") {
            const sessionId = resolveSessionId(properties);
            if (!sessionId) {
                return;
            }

            deps.nudgePlacements.clear(sessionId);

            try {
                // Read and remove compaction marker BEFORE clearSession destroys session_meta.
                // Plan v6: pending_compaction_marker_state lives on the same row, so
                // clearSession's session_meta DELETE wipes it automatically — no
                // separate CAS-clear needed here.
                removeCompactionMarkerForSession(deps.db, sessionId);
                clearSession(deps.db, sessionId);
            } catch (error) {
                sessionLog(sessionId, "event session.deleted persistence failed:", error);
            }
            resetDegradedCacheCount(sessionId);
            deps.onSessionCacheInvalidated?.(sessionId);
            deps.onSessionDeleted?.(sessionId);
            deps.contextUsageMap.delete(sessionId);
            deps.tagger.cleanup(sessionId);
            clearCompressorCooldown(sessionId);
            clearMessageTokensCache(sessionId);
            return;
        }
    };
}
