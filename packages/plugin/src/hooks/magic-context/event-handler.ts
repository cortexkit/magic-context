import type { createCompactionHandler } from "../../features/magic-context/compaction";
import {
    clearPersistedNoteNudge,
    clearPersistedNudgePlacement,
    clearPersistedStickyTurnReminder,
    clearSession,
    deleteIndexedMessage,
    deleteTagsByMessageId,
    getMaxTagNumberBySession,
    getOrCreateSessionMeta,
    getPersistedNoteNudge,
    getPersistedNudgePlacement,
    getPersistedReasoningWatermark,
    getPersistedStickyTurnReminder,
    removeStrippedPlaceholderId,
    setPersistedReasoningWatermark,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import type { Tagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import { log, sessionLog } from "../../shared/logger";
import { checkCompartmentTrigger } from "./compartment-trigger";
import {
    getMessageRemovedInfo,
    getMessageUpdatedAssistantInfo,
    getSessionCreatedInfo,
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
import type { NudgePlacementStore } from "./transform";

const CONTEXT_USAGE_TTL_MS = 60 * 60 * 1000;

type CacheTtlConfig = string | Record<string, string>;

interface ContextUsageEntry {
    usage: ContextUsage;
    updatedAt: number;
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
    config: {
        protected_tags: number;
        auto_drop_tool_age?: number;
        clear_reasoning_age?: number;
        execute_threshold_percentage?: number | { default: number; [modelKey: string]: number };
        cache_ttl: CacheTtlConfig;
        modelContextLimitsCache?: Map<string, number>;
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
                        modelContextLimitsCache: deps.config.modelContextLimitsCache,
                    });
                    const percentage = (totalInputTokens / contextLimit) * 100;

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
                    });

                    updates.lastContextPercentage = percentage;
                    updates.lastInputTokens = totalInputTokens;

                    const sessionMeta = getOrCreateSessionMeta(deps.db, info.sessionID);
                    const previousPercentage = sessionMeta.lastContextPercentage;
                    if (!sessionMeta.isSubagent) {
                        const triggerResult = checkCompartmentTrigger(
                            deps.db,
                            info.sessionID,
                            sessionMeta,
                            { percentage, inputTokens: totalInputTokens },
                            previousPercentage,
                            resolveExecuteThreshold(
                                deps.config.execute_threshold_percentage ?? 65,
                                modelKey,
                                65,
                            ),
                            undefined, // compartmentTokenBudget — use default
                            deps.config.auto_drop_tool_age ?? 100,
                            deps.config.protected_tags,
                            deps.config.clear_reasoning_age ?? 50,
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
                clearSession(deps.db, sessionId);
            } catch (error) {
                sessionLog(sessionId, "event session.deleted persistence failed:", error);
            }
            deps.onSessionCacheInvalidated?.(sessionId);
            deps.contextUsageMap.delete(sessionId);
            deps.tagger.cleanup(sessionId);
            return;
        }
    };
}
