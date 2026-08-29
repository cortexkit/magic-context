import { log } from "./logger";

/**
 * A one-second threshold catches transactions that can noticeably hold back
 * sibling writers without turning normal SQLite work into log noise.
 */
export const SLOW_WRITE_TRANSACTION_THRESHOLD_MS = 1_000;

/**
 * Log a slow write only after its COMMIT has completed. The timing diagnostic is
 * deliberately best-effort so it can never change the transaction's behavior.
 */
export function logSlowWriteTransaction(
    site: string,
    startedAt: number,
    thresholdMs = SLOW_WRITE_TRANSACTION_THRESHOLD_MS,
): void {
    try {
        const durationMs = performance.now() - startedAt;
        if (durationMs < thresholdMs) return;
        log(`[magic-context] slow write transaction: site=${site} held=${durationMs.toFixed(1)}ms`);
    } catch {
        // Timing diagnostics must never make a committed write appear to fail.
    }
}
