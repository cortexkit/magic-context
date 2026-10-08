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
    completedAtMs = performance.now(),
    steps?: Readonly<Record<string, number>>,
): void {
    try {
        const durationMs = completedAtMs - startedAt;
        if (durationMs < thresholdMs) return;
        const detail = steps
            ? Object.entries(steps)
                  .map(([name, ms]) => `${name}=${ms.toFixed(1)}ms`)
                  .join(" ")
            : "";
        log(
            `[magic-context] slow write transaction: site=${site} held=${durationMs.toFixed(1)}ms${detail ? ` ${detail}` : ""}`,
        );
    } catch {
        // Timing diagnostics must never make a committed write appear to fail.
    }
}

/** Step durations include precomputation when named `pre_*`; held time never does. */
export class WriteTransactionSteps {
    readonly durations: Record<string, number> = {};
    private last = performance.now();

    mark(name: string): void {
        const now = performance.now();
        this.durations[name] = now - this.last;
        this.last = now;
    }

    reset(): void {
        this.last = performance.now();
    }
}
