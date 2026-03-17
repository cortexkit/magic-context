import type { Scheduler } from "../../features/magic-context/scheduler";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { loadPersistedUsage } from "../../features/magic-context/storage";
import type { ContextUsage, SessionMeta } from "../../features/magic-context/types";
import { log } from "../../shared/logger";

export function loadContextUsage(
    contextUsageMap: Map<string, { usage: ContextUsage; updatedAt: number }>,
    db: ContextDatabase,
    sessionId: string,
): ContextUsage {
    let contextUsageEntry = contextUsageMap.get(sessionId);
    if (!contextUsageEntry) {
        try {
            const persisted = loadPersistedUsage(db, sessionId);
            if (persisted) {
                contextUsageMap.set(sessionId, persisted);
                contextUsageEntry = persisted;
            }
        } catch (error) {
            log("[magic-context] transform failed loading persisted usage:", error);
        }
    }
    return contextUsageEntry?.usage ?? { percentage: 0, inputTokens: 0 };
}

export function resolveSchedulerDecision(
    scheduler: Scheduler,
    sessionMeta: SessionMeta,
    contextUsage: ContextUsage,
    sessionId: string,
): "execute" | "defer" {
    try {
        const schedulerDecision = scheduler.shouldExecute(sessionMeta, contextUsage);
        log(
            `[magic-context] transform scheduler: session=${sessionId} percentage=${contextUsage.percentage.toFixed(1)}% inputTokens=${contextUsage.inputTokens} cacheTtl=${sessionMeta.cacheTtl} lastResponseTime=${sessionMeta.lastResponseTime} decision=${schedulerDecision}`,
        );
        return schedulerDecision;
    } catch (error) {
        log("[magic-context] transform scheduler failed; defaulting to defer:", error);
        return "defer";
    }
}
