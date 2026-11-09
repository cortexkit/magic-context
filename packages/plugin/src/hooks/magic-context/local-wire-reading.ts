import type { ContextUsage } from "../../features/magic-context/types";

/**
 * A local pressure reading for sessions whose provider reports no usage.
 *
 * OpenCode keeps no usage reading for a provider that omits usage from its
 * replies, so without this the scheduler reads 0% on every pass and never
 * reaches the execute threshold: queued drops and cleanup would wait for
 * `/ctx-flush` or a provider overflow error. While a session has no provider
 * reading, each pass records the local count of the request it served (the
 * same request a provider reading would describe, after this pass's own
 * reductions), and the next pass's execute decision reads it. The served
 * request is counted rather than the incoming messages, because the incoming
 * messages still carry tool outputs that were already dropped. The reading is
 * a percentage of the same limit a provider reading uses, so the execute
 * threshold falls at the same request size whether or not usage is reported.
 *
 * Only the scheduler reads it, but its "execute" decision prices the pass, and
 * a priced pass with no provider reading is sized from a local count of its own
 * request (transform.ts). Every later pressure check on that pass reads the
 * sized reading, but a reading that only a local count produced takes the
 * force ride, runs the tiered emergency tool drop and lifts the signed-thinking
 * hold only at 95% or more. Below 95% the execute pass's own bounded rebuild
 * stays available, so queued drops do not wait for a provider measurement
 * that never comes.
 *
 * A reading taken on another model or against another usable window is
 * ignored. Known limits: the readings live in memory only, so no reading
 * survives a restart and the scheduler reads 0% on the first pass after one;
 * and the historian trigger does not see the local count, so for such a session
 * it fires on tail size alone, never on pressure.
 */
export interface LocalWireReadings {
    /** The usage the scheduler should see on this pass. */
    schedulerUsage(input: {
        sessionId: string;
        providerUsage: ContextUsage;
        providerReadingMissing: boolean;
        modelKey: string | undefined;
        usableWindow: number | undefined;
    }): ContextUsage;
    /**
     * Records the calibrated local count of the request this pass served, or
     * clears the session's reading when a provider reading exists.
     */
    record(input: {
        sessionId: string;
        providerReadingMissing: boolean;
        modelKey: string | undefined;
        usableWindow: number | undefined;
        pressureTokens: number | undefined;
    }): void;
}

export function createLocalWireReadings(): LocalWireReadings {
    const readings = new Map<
        string,
        { modelKey: string; usableWindow: number; usage: ContextUsage }
    >();
    const isWindow = (value: number | undefined): value is number =>
        typeof value === "number" && Number.isFinite(value) && value > 0;
    return {
        schedulerUsage({
            sessionId,
            providerUsage,
            providerReadingMissing,
            modelKey,
            usableWindow,
        }) {
            if (!providerReadingMissing) return providerUsage;
            const reading = readings.get(sessionId);
            if (
                !reading ||
                reading.modelKey !== modelKey ||
                !isWindow(usableWindow) ||
                reading.usableWindow !== usableWindow ||
                reading.usage.percentage <= providerUsage.percentage
            ) {
                return providerUsage;
            }
            return reading.usage;
        },
        record({ sessionId, providerReadingMissing, modelKey, usableWindow, pressureTokens }) {
            // A provider reading supersedes any local one. Clearing it keeps a
            // later pass whose provider reading was reset from reading an old count.
            if (
                !providerReadingMissing ||
                !modelKey ||
                !isWindow(usableWindow) ||
                typeof pressureTokens !== "number" ||
                !Number.isFinite(pressureTokens) ||
                pressureTokens <= 0
            ) {
                readings.delete(sessionId);
                return;
            }
            readings.set(sessionId, {
                modelKey,
                usableWindow,
                usage: {
                    inputTokens: pressureTokens,
                    percentage: (pressureTokens / usableWindow) * 100,
                },
            });
        },
    };
}
