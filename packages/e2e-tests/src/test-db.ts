import { Database } from "bun:sqlite";

class TestDatabase extends Database {
    override close(): void {
        super.close(true);
    }
}

/**
 * Open a SQLite handle for an e2e test with a bounded `busy_timeout` and synchronous disposal.
 *
 * The e2e suite runs many files in parallel against a per-test shared
 * `context.db` while the plugin under test writes to the same file. A handle
 * opened with the default `busy_timeout = 0` fails immediately with SQLITE_BUSY
 * the instant any other connection holds the write lock, which surfaces as
 * flaky "database is locked" failures under load rather than a real regression.
 * Setting a timeout makes the handle WAIT for the lock instead of failing.
 *
 * Closing finalizes one-shot `prepare()` statements as well as cached queries.
 * Otherwise Bun can defer the native close until garbage collection. The
 * store uses SQLite's write-ahead log, and the last connection to close
 * folds that log back into the database under an exclusive lock. If that
 * late close is the last connection, it can take the lock just as a
 * restarted host opens the store, before the host sets its busy timeout.
 *
 * Open test readers and writers here, or set a timeout of at least five seconds
 * before the handle's first use. For a deliberately fail-fast connection, put
 * `// sqlite-busy-timeout: no-wait -- <reason>` directly above the open.
 */
export function openTestDb(
    path: string,
    options?: ConstructorParameters<typeof Database>[1],
): Database {
    const db = new TestDatabase(path, options);
    db.exec("PRAGMA busy_timeout=5000");
    return db;
}
