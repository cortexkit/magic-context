import { resolveExecuteThreshold } from "../../hooks/magic-context/event-resolvers";
import { log } from "../../shared/logger";
import type { ContextUsage, SchedulerDecision, SessionMeta } from "./types";

const TTL_PATTERN = /^(\d+)([smh])$/;
const NUMERIC_PATTERN = /^\d+$/;

const UNIT_TO_MS: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
};

export interface Scheduler {
    shouldExecute(
        sessionMeta: SessionMeta,
        contextUsage: ContextUsage,
        currentTime?: number,
    ): SchedulerDecision;
}

interface SchedulerConfig {
    executeThresholdPercentage: number | { default: number; [modelKey: string]: number };
}

export function parseCacheTtl(ttl: string): number {
    const normalizedTtl = ttl.trim();

    if (NUMERIC_PATTERN.test(normalizedTtl)) {
        return Number(normalizedTtl);
    }

    const match = normalizedTtl.match(TTL_PATTERN);
    if (!match) {
        throw new Error(`Invalid cache TTL format: ${ttl}`);
    }

    const value = Number(match[1]);
    const unit = match[2];
    return value * UNIT_TO_MS[unit];
}

export function createScheduler(config: SchedulerConfig): Scheduler {
    return {
        shouldExecute(
            sessionMeta: SessionMeta,
            contextUsage: ContextUsage,
            currentTime: number = Date.now(),
        ): SchedulerDecision {
            const threshold = resolveExecuteThreshold(
                config.executeThresholdPercentage,
                undefined,
                65,
            );
            if (contextUsage.percentage >= threshold) {
                return "execute";
            }

            let ttlMs: number;
            try {
                ttlMs = parseCacheTtl(sessionMeta.cacheTtl);
            } catch (error) {
                log(
                    `[magic-context] invalid cache_ttl "${sessionMeta.cacheTtl}"; falling back to default 5m`,
                    error,
                );
                ttlMs = parseCacheTtl("5m");
            }
            const elapsedTime = currentTime - sessionMeta.lastResponseTime;
            if (elapsedTime > ttlMs) {
                return "execute";
            }

            return "defer";
        },
    };
}
