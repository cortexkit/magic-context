import { Worker } from "node:worker_threads";
import { log, writeForwardedLogLine } from "../../shared/logger";
import { beginOffThreadMigration } from "../../shared/off-thread-migration-clock";
import { reuseWorker } from "../../shared/reusable-worker";
import type { MigrationWorkerData, MigrationWorkerMessage } from "./migration-worker-protocol";

/**
 * - `migrated`: the worker applied every pending migration, or found none left.
 * A missing or unloadable worker rejects the open. Running a long SQLite batch
 * on the host thread instead can trip a supervisor's health watchdog, whose
 * restart rolls back the batch and repeats the same stall indefinitely.
 */
export type OffThreadMigrationOutcome = "migrated";

function workerStartError(detail: string): Error {
    return new Error(
        `the migration worker could not start (${detail}); reinstall or rebuild the plugin`,
    );
}

function defaultWorkerEntry(): URL {
    // Tests run the TypeScript sources; packaged builds emit migration-worker.js
    // next to the chunk that contains this module.
    return new URL(
        new URL(import.meta.url).pathname.endsWith(".ts")
            ? "./migration-worker.ts"
            : "./migration-worker.js",
        import.meta.url,
    );
}

let workerEntryOverride: URL | null = null;

/** Test seam: point the client at another worker script, or null to restore. */
export function __setMigrationWorkerEntryForTests(entry: URL | null): void {
    workerEntryOverride = entry;
}

/**
 * Apply pending schema migrations to `data.dbPath` on a worker thread with its
 * own SQLite connection, so the host's event loop keeps running meanwhile.
 *
 * Resolves once the worker has committed (or found nothing to do) and closed
 * its connection. Rejects with the worker's error message when a migration
 * fails, so the caller fails closed exactly as it did for an in-thread failure.
 * While the worker runs, boot deadlines do not count the time (see
 * off-thread-migration-clock.ts), except while it waits to retry another
 * process's write lock.
 * The migration body deliberately has no deadline: a large store can take a
 * long time to migrate, and aborting it would roll back legitimate progress.
 * Its dedicated worker pool never serves another kind of background job.
 */
export function runMigrationsOffThread(
    data: MigrationWorkerData,
): Promise<OffThreadMigrationOutcome> {
    return new Promise<OffThreadMigrationOutcome>((resolve, reject) => {
        let worker: Worker;
        try {
            worker = inRootAsyncContext(() =>
                workerEntryOverride
                    ? new Worker(workerEntryOverride, { workerData: data })
                    : reuseWorker(defaultWorkerEntry(), { workerData: data }),
            );
        } catch (error) {
            reject(workerStartError(error instanceof Error ? error.message : String(error)));
            return;
        }
        log(`[migrations] applying pending migrations on a worker thread: ${data.dbPath}`);

        let ready = false;
        let settled = false;
        let endBusy: (() => void) | null = beginOffThreadMigration();
        const setBusy = (busy: boolean): void => {
            if (busy && !endBusy) endBusy = beginOffThreadMigration();
            if (!busy && endBusy) {
                endBusy();
                endBusy = null;
            }
        };
        const settle = (finish: () => void): void => {
            if (settled) return;
            settled = true;
            setBusy(false);
            finish();
        };
        const unavailable = (detail: string): void => {
            settle(() => {
                reject(workerStartError(detail));
            });
        };

        worker.on("message", (message: MigrationWorkerMessage) => {
            switch (message.type) {
                case "ready":
                    ready = true;
                    log(`[migrations] migration worker ready: ${data.dbPath}`);
                    return;
                case "log":
                    writeForwardedLogLine(message.line);
                    return;
                case "lock-wait":
                    if (!settled) setBusy(!message.waiting);
                    return;
                case "done":
                    if (!ready) {
                        unavailable("reported completion before ready");
                        return;
                    }
                    settle(() => resolve("migrated"));
                    return;
                case "failed":
                    if (!ready) {
                        unavailable(message.message);
                        return;
                    }
                    settle(() => reject(new Error(message.message)));
                    return;
            }
        });
        worker.on("error", (error: Error) => {
            if (!ready) {
                unavailable(error.message);
                void worker.terminate();
                return;
            }
            settle(() => reject(new Error(`migration worker failed: ${error.message}`)));
        });
        worker.on("exit", (code: number) => {
            if (!ready) {
                unavailable(`exited with code ${code} before loading`);
                return;
            }
            settle(() =>
                reject(
                    new Error(`migration worker exited (code ${code}) before reporting a result`),
                ),
            );
        });
    });
}

import { inRootAsyncContext } from "../../shared/sqlite";
