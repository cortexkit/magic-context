/**
 * Worker-thread entry that applies pending schema migrations to context.db.
 *
 * A migration can rewrite hundreds of megabytes inside one SQLite transaction,
 * which takes seconds to tens of seconds on a large store. SQLite calls are
 * synchronous, so on the host's main thread that time froze the host: OpenCode
 * stopped answering `/health` and a supervisor could kill it. Here the work runs
 * on its own thread with its own connection, with exactly the code the main
 * thread used to run (`initializeDatabase` then `runMigrationsWithRetry`). So each
 * migration still takes SQLite's write lock with BEGIN IMMEDIATE, a version another
 * process applied first is still skipped, and a failed migration still rolls back
 * and fails the open. The caller (migration-worker-client.ts) runs the schema fence
 * and the old-holder guard before starting this worker and the fence again after it
 * finishes.
 */

import { log, setLogLineForwarder } from "../../shared/logger";
import { serveWorkerJobs } from "../../shared/reusable-worker-entry";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import type { MigrationWorkerData, MigrationWorkerMessage } from "./migration-worker-protocol";
import { runMigrationsWithRetry } from "./migrations";
import { initializeDatabase, setSqlitePragmaConfig } from "./storage-db";

serveWorkerJobs<MigrationWorkerData>(async (data, port) => {
    function post(message: MigrationWorkerMessage): void {
        port.postMessage(message);
    }

    async function main(): Promise<void> {
        setLogLineForwarder((line) => post({ type: "log", line }));
        setSqlitePragmaConfig(data.sqlitePragmaConfig);
        post({ type: "ready" });
        let db: Database | undefined;
        try {
            db = new Database(data.dbPath);
            initializeDatabase(db, data.busyTimeoutMs);
            await runMigrationsWithRetry(db, {
                // Report the wait so the boot deadline keeps counting it: a lock held
                // by another process is the stuck case the deadline exists to bound.
                sleep: async (delayMs) => {
                    post({ type: "lock-wait", waiting: true });
                    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
                    post({ type: "lock-wait", waiting: false });
                },
            });
            // Close before reporting done. Closing the last connection checkpoints the
            // WAL under a lock, and the caller reads the schema as soon as it hears
            // "done": reporting first let that read race this checkpoint and fail
            // with SQLITE_BUSY when the caller's busy timeout is short.
            const finished = db;
            db = undefined;
            finished.close();
            log(`[migrations] migration worker connection closed: ${data.dbPath}`);
            post({ type: "done" });
        } catch (error) {
            post({
                type: "failed",
                message: error instanceof Error ? error.message : String(error),
            });
        } finally {
            if (db) closeQuietly(db);
            setLogLineForwarder(null);
        }
    }

    await main();
    port.close();
});
