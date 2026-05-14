import type { Scheduler } from "../../features/magic-context/scheduler";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { loadPersistedUsage } from "../../features/magic-context/storage";
import type { ContextUsage, SessionMeta } from "../../features/magic-context/types";
import { sessionLog } from "../../shared/logger";

type ContextUsageCacheEntry = {
    usage: ContextUsage;
    updatedAt: number;
    lastResponseTime?: number;
};

function loadPersistedUsageWatermark(db: ContextDatabase, sessionId: string): number | null {
    const result = db
        .prepare("SELECT last_response_time FROM session_meta WHERE session_id = ?")
        .get(sessionId);

    if (result === null || typeof result !== "object") return null;
    const lastResponseTime = (result as { last_response_time?: unknown }).last_response_time;
    return typeof lastResponseTime === "number" ? lastResponseTime : null;
}

export function loadContextUsage(
    contextUsageMap: Map<string, ContextUsageCacheEntry>,
    db: ContextDatabase,
    sessionId: string,
): ContextUsage {
    const contextUsageEntry = contextUsageMap.get(sessionId);
    try {
        const persistedLastResponseTime = loadPersistedUsageWatermark(db, sessionId);
        const cachedLastResponseTime =
            contextUsageEntry?.lastResponseTime ?? contextUsageEntry?.updatedAt;
        if (
            contextUsageEntry &&
            contextUsageEntry.lastResponseTime === undefined &&
            (persistedLastResponseTime === null || persistedLastResponseTime === 0)
        ) {
            return contextUsageEntry.usage;
        }
        if (contextUsageEntry && cachedLastResponseTime === persistedLastResponseTime) {
            return contextUsageEntry.usage;
        }

        const persisted = loadPersistedUsage(db, sessionId);
        if (persisted) {
            contextUsageMap.set(sessionId, {
                ...persisted,
                lastResponseTime: persistedLastResponseTime ?? persisted.updatedAt,
            });
            return persisted.usage;
        }

        contextUsageMap.delete(sessionId);
    } catch (error) {
        sessionLog(sessionId, "transform failed loading persisted usage:", error);
        return contextUsageEntry?.usage ?? { percentage: 0, inputTokens: 0 };
    }
    return { percentage: 0, inputTokens: 0 };
}

export function resolveSchedulerDecision(
    scheduler: Scheduler,
    sessionMeta: SessionMeta,
    contextUsage: ContextUsage,
    sessionId: string,
    modelKey?: string,
): "execute" | "defer" {
    try {
        const schedulerDecision = scheduler.shouldExecute(
            sessionMeta,
            contextUsage,
            undefined,
            sessionId,
            modelKey,
        );
        sessionLog(
            sessionId,
            `transform scheduler: percentage=${contextUsage.percentage.toFixed(1)}% inputTokens=${contextUsage.inputTokens} cacheTtl=${sessionMeta.cacheTtl} lastResponseTime=${sessionMeta.lastResponseTime} decision=${schedulerDecision}`,
        );
        return schedulerDecision;
    } catch (error) {
        sessionLog(sessionId, "transform scheduler failed; defaulting to defer:", error);
        return "defer";
    }
}
