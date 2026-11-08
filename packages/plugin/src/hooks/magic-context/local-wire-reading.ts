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
 * messages still carry tool outputs that were already dropped.
 *
 * Only the execute decision reads it. The force band, the emergency paths and
 * the historian trigger keep using the provider reading, so a reading that
 * only a local count produced still waits for the provider below 95%.
 *
 * The readings live in memory only: the first pass after a restart reads no
 * local reading, and a reading taken on another model or against another
 * usable window is ignored.
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
