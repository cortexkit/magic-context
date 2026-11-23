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
 * Otherwise Bun can defer the native close until garbage collection. If it
 * is the last WAL connection, its cleanup can take an exclusive lock just
 * as a restarted host opens the store, before the host sets its busy timeout.
 *
 * Every test that opens a DB directly (reader or writer) must use this helper
 * unless it immediately sets its own longer timeout. The test-db guard checks
 * each constructor so a bare `new Database(...)` cannot reintroduce the flake.
 */
export function openTestDb(
    path: string,
    options?: ConstructorParameters<typeof Database>[1],
): Database {
    const db = new TestDatabase(path, options);
    db.exec("PRAGMA busy_timeout=5000");
    return db;
}
