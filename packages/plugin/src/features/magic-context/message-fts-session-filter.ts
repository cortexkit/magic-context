import type { Database, Statement } from "../../shared/sqlite";

// Screen posting rowids before reading any UNINDEXED content columns. Unary +
// prevents SQLite from restarting MATCH for each mapped rowid, which is much
// slower on warm stores. Bind the session id once for this fragment, then again
// for the ordinary session predicate, in each compound branch's SQL text order.
// Numbered placeholders reject positional arguments on supported older node:sqlite
// runtimes. Keep the ordinary predicate so a stale message_fts_rowid_map row
// cannot expose another session's content.
export const MESSAGE_FTS_SESSION_FILTER_SQL = `+message_history_fts.rowid IN (
    SELECT fts_rowid FROM message_fts_rowid_map WHERE session_id = ?
) AND `;

interface CoverageCache {
    pin: Statement;
    stamp: Statement;
    missing: Statement;
    version?: number;
    changes?: number;
    incompleteSessions?: Set<string>;
}

const coverageCaches = new WeakMap<Database, CoverageCache>();
let coverageScansOnThisThread = 0;

/** @internal Worker modules have independent counters, unlike serving-thread reads. */
export function getMessageFtsCoverageScansOnThisThreadForTest(): number {
    return coverageScansOnThisThread;
}

function getCoverageCache(db: Database): CoverageCache {
    let cache = coverageCaches.get(db);
    if (!cache) {
        cache = {
            // BEGIN DEFERRED alone does not pin a WAL snapshot. Even a cached
            // proof must read main before checking data_version and running FTS.
            pin: db.prepare("SELECT fts_rowid FROM message_fts_rowid_map LIMIT 1"),
            stamp: db.prepare(
                "SELECT total_changes() AS changes, data_version AS version FROM pragma_data_version",
            ),
            // FTS5's docsize table is the compact inventory of physical rowids.
            // Compare identities, not counts or the backfill watermark: an ordinal
            // collision can replace one map entry while leaving both FTS rows alive.
            // Only missing rowids need content reads to discover their sessions.
            missing: db.prepare(`SELECT DISTINCT session_id AS sessionId
                FROM message_history_fts WHERE rowid IN (
                    SELECT id FROM message_history_fts_docsize
                    EXCEPT SELECT fts_rowid FROM message_fts_rowid_map
                )`),
        };
        coverageCaches.set(db, cache);
    }
    return cache;
}

/**
 * Use the sidecar only for sessions with every physical FTS row mapped. Legacy
 * sessions retain the global MATCH query, including duplicate ordinals; no
 * backfill, deduplication, or durable schema change happens during search.
 *
 * Coverage and the synchronous queries share a read transaction so another
 * connection cannot add an unmapped row between the proof and the filtered read.
 * Local writes and external commits invalidate the connection-local proof. Never
 * retain a caller's uncommitted proof: total_changes does not advance on rollback.
 */
export function withMessageFtsSessionFilter<T>(
    db: Database,
    sessionId: string,
    read: (sessionFirst: boolean) => T,
): T {
    let cacheable = false;
    try {
        const transaction = db as unknown as { inTransaction?: boolean; isTransaction?: boolean };
        cacheable = transaction.inTransaction === false || transaction.isTransaction === false;
        if (!cacheable) coverageCaches.delete(db);
    } catch {
        coverageCaches.delete(db);
    }

    return db
        .transaction(() => {
            let sessionFirst = false;
            try {
                const cache = getCoverageCache(db);
                cache.pin.get();
                const stamp = cache.stamp.get() as { version: number; changes: number };
                let incomplete = cache.incompleteSessions;
                if (
                    !cacheable ||
                    !incomplete ||
                    cache.version !== stamp.version ||
                    cache.changes !== stamp.changes
                ) {
                    coverageScansOnThisThread += 1;
                    const rows = cache.missing.all() as Array<{ sessionId: string }>;
                    incomplete = new Set(rows.map((row) => row.sessionId));
                    if (cacheable) {
                        cache.version = stamp.version;
                        cache.changes = stamp.changes;
                        cache.incompleteSessions = incomplete;
                    }
                }
                sessionFirst = !incomplete.has(sessionId);
            } catch {
                // Older/nonstandard FTS tables may omit docsize. Without a physical
                // coverage proof, the global query remains the completeness authority.
                coverageCaches.delete(db);
            }
            return read(sessionFirst);
        })
        .deferred();
}
