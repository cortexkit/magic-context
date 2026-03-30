import type { createCompactionHandler } from "../../features/magic-context/compaction";
import {
    clearSession,
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import type { Tagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import { log, sessionLog } from "../../shared/logger";
import { checkCompartmentTrigger } from "./compartment-trigger";
import {
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
import type { NudgePlacementStore } from "./transform";

const CONTEXT_USAGE_TTL_MS = 60 * 60 * 1000;

type CacheTtlConfig = string | Record<string, string>;

interface ContextUsageEntry {
    usage: ContextUsage;
    updatedAt: number;
}

export interface EventHandlerDeps {
    contextUsageMap: Map<string, ContextUsageEntry>;
    compactionHandler: ReturnType<typeof createCompactionHandler>;
    nudgePlacements: NudgePlacementStore;
    onSessionCacheInvalidated?: (sessionId: string) => void;
    config: {
        protected_tags: number;
        execute_threshold_percentage?: number | { default: number; [modelKey: string]: number };
        cache_ttl: CacheTtlConfig;
        modelContextLimitsCache?: Map<string, number>;
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
