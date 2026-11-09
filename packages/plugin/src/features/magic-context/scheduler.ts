import { resolveExecuteThreshold } from "../../hooks/magic-context/event-resolvers";
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

    // "never" sentinel: lanes kept warm by external keepwarm proxies — the idle
    // heuristic is disabled, so MC never initiates a rebuild based on elapsed time.
    if (normalizedTtl.toLowerCase() === "never") {
        return Number.POSITIVE_INFINITY;
    }

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
            _currentTime?: number,
            sessionId?: string,
            modelKey?: string,
            contextLimit?: number,
        ): SchedulerDecision {
            // Brand-new sessions (no usage, no baseline) have nothing to execute,
            // even under a threshold that resolves to zero.
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

            // An expired provider cache is deliberately not an execute pass.
            // When only the provider forgot the cache, resending the same bytes
            // keeps every signed thinking block valid, and the re-read costs the
            // same either way, so rebuilding then would only land queued drops
            // and cleanup before the execute threshold the agent was promised.
            return "defer";
        },
    };
}

/** The idle clock is the last served response, not the last prepared request. */
export function computeHardCacheExpired(
    cacheTtl: string,
    lastResponseTime: number,
    now: number,
    onInvalid?: (error: unknown) => void,
): boolean {
    let ttlMs: number;
    try {
        ttlMs = parseCacheTtl(cacheTtl);
    } catch (error) {
        onInvalid?.(error);
        ttlMs = 5 * 60 * 1000;
    }
    // Strict > matches the scheduler and Rust; "never" parses as Infinity.
    return lastResponseTime > 0 && now - lastResponseTime > ttlMs;
}
