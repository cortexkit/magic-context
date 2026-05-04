import { resolveExecuteThreshold } from "../../hooks/magic-context/event-resolvers";
import { log, sessionLog } from "../../shared/logger";
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
        sessionId?: string,
        modelKey?: string,
        contextLimit?: number,
    ): SchedulerDecision;
}

interface SchedulerConfig {
    executeThresholdPercentage: number | { default: number; [modelKey: string]: number };
    executeThresholdTokens?: { default?: number; [modelKey: string]: number | undefined };
}

export function parseCacheTtl(ttl: string): number {
    const normalizedTtl = ttl.trim();

    // Intentional: bare numeric strings are treated as milliseconds. The setup CLI writes
    // "5m" or "59m" so users don't encounter bare numbers through normal config paths.
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
            sessionId?: string,
            modelKey?: string,
            contextLimit?: number,
        ): SchedulerDecision {
            // Brand-new sessions (no usage, no baseline) have nothing to execute.
            // Skip the TTL check that would always fire due to lastResponseTime=0.
            if (contextUsage.percentage === 0 && sessionMeta.lastResponseTime === 0) {
                return "defer";
            }

            // Tokens-based config requires contextLimit to convert to effective %.
            // When the caller doesn't have it handy we derive it from usage:
            // contextLimit = inputTokens / (percentage / 100). This is the same
            // denominator event-handler used to compute contextUsage.percentage,
            // so both resolutions stay consistent on the same pass.
            const effectiveContextLimit =
                contextLimit ??
                (contextUsage.percentage > 0 && contextUsage.inputTokens > 0
                    ? contextUsage.inputTokens / (contextUsage.percentage / 100)
                    : undefined);

            const threshold = resolveExecuteThreshold(
                config.executeThresholdPercentage,
                modelKey,
                65,
                {
                    tokensConfig: config.executeThresholdTokens,
                    contextLimit: effectiveContextLimit,
                    sessionId,
                },
            );
            if (contextUsage.percentage >= threshold) {
                return "execute";
            }

            let ttlMs: number;
            try {
                ttlMs = parseCacheTtl(sessionMeta.cacheTtl);
            } catch (error) {
                if (sessionId) {
                    sessionLog(
                        sessionId,
                        `invalid cache_ttl "${sessionMeta.cacheTtl}"; falling back to default 5m`,
                        error,
                    );
                } else {
                    log(
                        `[magic-context] invalid cache_ttl "${sessionMeta.cacheTtl}"; falling back to default 5m`,
                        error,
                    );
                }
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
