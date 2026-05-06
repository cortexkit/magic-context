/**
 * Tool-owner backfill (plan v3.3.1, Layer B).
 *
 * Migration v10 added `tool_owner_message_id` to the tags table. The
 * runtime carries every new tool tag with a non-NULL owner, but the
 * 185k+ existing rows in user DBs need their owner column populated to
 * make the v10 fix fully effective. The backfill pass iterates each
 * session that has tool tags with NULL owner, queries the OpenCode DB
 * for the temporally-earliest assistant message that invoked each
 * callID, and writes the owner via a NULL-guarded UPDATE so the
 * runtime can lazily adopt rows the backfill couldn't see (e.g. Pi
 * sessions, deleted OC sessions, transient OC-DB-unavailable cases).
 *
 * Concurrency model:
 *   - Per-session advisory lease via `tool_owner_backfill_state`.
 *   - 5-minute lease, renewed every 60s during chunked execution.
 *   - Sibling instances skip sessions whose lease is held and active.
 *   - Process-death cleanup falls out for free: better-sqlite3 + WAL
 *     drops all locks at process exit, and the `lease_expires_at`
 *     column is the only durable state. A crashed process's session
 *     becomes claimable as soon as the lease wall-clock expires.
 *   - NULL-guarded UPDATE: backfill never clobbers a row already
 *     adopted at runtime.
 *
 * Skip vs fail semantics:
 *   - When OpenCode DB is missing (e.g. Pi-only install), every
 *     session gets marked 'skipped' in the state table. Lazy adoption
 *     handles the orphans at runtime.
 *   - When OpenCode DB exists but a specific session is missing or
 *     yields zero matches, that session is marked 'skipped' too.
 *     Same lazy-adoption fallback covers it.
 *   - A session error during backfill (SQLITE_BUSY, malformed JSON,
 *     anything) is logged and the session is left in 'pending'/
 *     'running' for a retry on next plugin start. Backfill never
 *     fail-closes the plugin — it's defense-in-depth on top of
 *     Layer C lazy adoption.
 *
 * Idempotency:
 *   - The NULL guard makes UPDATE idempotent: re-running against an
 *     already-backfilled row matches zero rows and moves on.
 *   - The state table makes session bookkeeping idempotent: a
 *     completed session is never re-processed.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../../shared/data-path";
import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";

/**
 * Lease duration: 5 minutes per session. The slowest session in the
 * playground DB took 2.78s; 5min is comfortable padding for the
 * worst case.
 */
const LEASE_DURATION_MS = 5 * 60 * 1000;

/**
 * Lease renewal cadence: every 60s while a session is being
 * processed. Per-session backfills are typically <100ms so this
 * almost never fires for normal sessions; it matters for the rare
 * 30k+ tag session that takes seconds.
 */
const LEASE_RENEWAL_MS = 60 * 1000;

interface BackfillStateRow {
    session_id: string;
    status: string;
    started_at: number | null;
    lease_expires_at: number | null;
    completed_at: number | null;
    last_error: string | null;
}

interface BackfillResult {
    sessionsProcessed: number;
    sessionsSkippedNoOcDb: number;
    sessionsSkippedNoMatches: number;
    sessionsCompleted: number;
    sessionsBlockedByLease: number;
    sessionsErrored: number;
    rowsUpdated: number;
    rowsLeftNull: number;
    durationMs: number;
}

/**
 * Resolve the OpenCode DB path. Mirrors `getOpenCodeDbPath()` in
 * `dreamer/runner.ts` and `compaction-marker.ts` — one source of truth
 * eventually, but staying duplicated for now to avoid an import cycle
 * at startup.
 */
function resolveOpencodeDbPath(): string {
    return join(getDataDir(), "opencode", "opencode.db");
}

function ensureBackfillStateTable(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS tool_owner_backfill_state (
            session_id TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'skipped')),
            started_at INTEGER,
            lease_expires_at INTEGER,
            completed_at INTEGER,
            last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tool_owner_backfill_state_status
        ON tool_owner_backfill_state(status);
    `);
}

/**
 * Top-level entry point. Called from `openDatabase()` after
 * `runMigrations()` returns. Synchronous; runs to completion before
 * returning so the first transform pass on a fresh upgrade sees a
 * mostly-backfilled DB.
 *
 * Worst-case runtime on the user's playground DB (3,276 sessions,
 * 185,716 tool tags): ~25 seconds. Well under the 60-second budget.
 */
export function runToolOwnerBackfill(db: Database): BackfillResult {
    const startedAt = performance.now();
    ensureBackfillStateTable(db);

    const result: BackfillResult = {
        sessionsProcessed: 0,
        sessionsSkippedNoOcDb: 0,
        sessionsSkippedNoMatches: 0,
        sessionsCompleted: 0,
        sessionsBlockedByLease: 0,
        sessionsErrored: 0,
        rowsUpdated: 0,
        rowsLeftNull: 0,
        durationMs: 0,
    };

    if (!isToolOwnerBackfillNeeded(db)) {
        result.durationMs = performance.now() - startedAt;
        return result;
    }

    const opencodeDbPath = resolveOpencodeDbPath();
    if (!existsSync(opencodeDbPath)) {
        log(
            `[backfill] OpenCode DB not found at ${opencodeDbPath} — marking all unbackfilled sessions as skipped. Lazy adoption (defense-in-depth) handles legacy rows at runtime.`,
        );
        markAllUnbackfilledSessionsSkipped(db);
        result.sessionsSkippedNoOcDb = countSessionsByStatus(db, "skipped");
        result.durationMs = performance.now() - startedAt;
        return result;
    }

    db.exec(`ATTACH '${opencodeDbPath}' AS oc_backfill`);
    try {
        backfillToolOwnersInChunks(db, result);
    } finally {
        // DETACH is safe even if ATTACH partially failed; SQLite
        // reports an explicit error if there's nothing attached.
        try {
            db.exec("DETACH DATABASE oc_backfill");
        } catch (error) {
            log(
                `[backfill] failed to detach oc_backfill database: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    result.durationMs = performance.now() - startedAt;
    log(
        `[backfill] sessions=${result.sessionsProcessed} completed=${result.sessionsCompleted} skipped_no_oc=${result.sessionsSkippedNoOcDb} skipped_no_matches=${result.sessionsSkippedNoMatches} blocked_by_lease=${result.sessionsBlockedByLease} errored=${result.sessionsErrored} rows_updated=${result.rowsUpdated} rows_left_null=${result.rowsLeftNull} duration_ms=${Math.round(result.durationMs)}`,
    );

    return result;
}

/**
 * Returns true when at least one tool tag exists with NULL owner that
 * isn't already marked completed/skipped in the state table.
 *
 * Treating "no NULL-owner tags" as "no work" lets us short-circuit on
 * fresh DBs (every row is born with a non-NULL owner) and on already-
 * backfilled DBs (re-running is a no-op).
 */
export function isToolOwnerBackfillNeeded(db: Database): boolean {
    ensureBackfillStateTable(db);
    const row = db
        .prepare(
            `SELECT 1 AS hit
             FROM tags
             WHERE type = 'tool' AND tool_owner_message_id IS NULL
               AND NOT EXISTS (
                   SELECT 1 FROM tool_owner_backfill_state s
                   WHERE s.session_id = tags.session_id
                     AND s.status IN ('completed', 'skipped')
               )
             LIMIT 1`,
        )
        .get() as { hit: number } | null | undefined;
    // SQLite returns null (not undefined) when no row matches; treat
    // both as "no work pending".
    return row !== null && row !== undefined;
}

function markAllUnbackfilledSessionsSkipped(db: Database): void {
    const now = Date.now();
    db.prepare(
        `INSERT INTO tool_owner_backfill_state(session_id, status, started_at, completed_at, last_error)
         SELECT DISTINCT session_id, 'skipped', NULL, ?, NULL
         FROM tags
         WHERE type = 'tool' AND tool_owner_message_id IS NULL
         ON CONFLICT(session_id) DO UPDATE SET
             status = 'skipped',
             completed_at = excluded.completed_at,
             last_error = NULL
         WHERE tool_owner_backfill_state.status NOT IN ('completed', 'running')`,
    ).run(now);
}

function countSessionsByStatus(db: Database, status: string): number {
    const row = db
        .prepare("SELECT COUNT(*) AS c FROM tool_owner_backfill_state WHERE status = ?")
        .get(status) as { c: number };
    return row.c;
}

/**
 * Try to acquire the per-session lease. Returns true if we won the
 * race (state row is now ours), false if a sibling holds an unexpired
 * lease.
 *
 * The UPSERT is conditional: we'll claim a session that's
 *   - never seen before (INSERT path), or
 *   - in 'pending'/'skipped' status, or
 *   - in 'running' but with an expired lease (sibling crashed).
 *
 * We won't clobber a 'completed' row (that's terminal) or a 'running'
 * row whose lease is still alive.
 */
function acquireSessionLease(db: Database, sessionId: string, now: number): boolean {
    const expiresAt = now + LEASE_DURATION_MS;
    const result = db
        .prepare(
            `INSERT INTO tool_owner_backfill_state(session_id, status, started_at, lease_expires_at)
             VALUES (?, 'running', ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
                 status = 'running',
                 started_at = excluded.started_at,
                 lease_expires_at = excluded.lease_expires_at,
                 last_error = NULL
             WHERE tool_owner_backfill_state.status IN ('pending', 'skipped')
                OR (tool_owner_backfill_state.status = 'running'
                    AND tool_owner_backfill_state.lease_expires_at < ?)`,
        )
        .run(sessionId, now, expiresAt, now);
    return (result.changes ?? 0) === 1;
}

function renewSessionLease(db: Database, sessionId: string, now: number): void {
    const expiresAt = now + LEASE_DURATION_MS;
    db.prepare(
        `UPDATE tool_owner_backfill_state
         SET lease_expires_at = ?
         WHERE session_id = ? AND status = 'running'`,
    ).run(expiresAt, sessionId);
}

function markSessionCompleted(db: Database, sessionId: string, now: number): void {
    db.prepare(
        `UPDATE tool_owner_backfill_state
         SET status = 'completed', completed_at = ?, lease_expires_at = NULL, last_error = NULL
         WHERE session_id = ?`,
    ).run(now, sessionId);
}

function markSessionSkipped(db: Database, sessionId: string, now: number, reason: string): void {
    db.prepare(
        `INSERT INTO tool_owner_backfill_state(session_id, status, completed_at, last_error)
         VALUES (?, 'skipped', ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
             status = 'skipped',
             completed_at = excluded.completed_at,
             last_error = excluded.last_error,
             lease_expires_at = NULL`,
    ).run(sessionId, now, reason);
}

function markSessionErrored(db: Database, sessionId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare(
        `UPDATE tool_owner_backfill_state
         SET last_error = ?, lease_expires_at = NULL
         WHERE session_id = ?`,
    ).run(message, sessionId);
}

function getSessionsNeedingBackfill(db: Database): string[] {
    const rows = db
        .prepare(
            `SELECT DISTINCT t.session_id
             FROM tags t
             LEFT JOIN tool_owner_backfill_state s ON s.session_id = t.session_id
             WHERE t.type = 'tool' AND t.tool_owner_message_id IS NULL
               AND (s.status IS NULL OR s.status NOT IN ('completed', 'skipped'))
             ORDER BY t.session_id ASC`,
        )
        .all() as Array<{ session_id: string }>;
    return rows.map((r) => r.session_id);
}

interface OwnerExtractorRow {
    callid: string | null;
    owner_id: string;
    owner_t_created: number;
    part_id: string;
    part_t_created: number;
}

/**
 * Build the deterministic per-session callID → first-seen owner map.
 *
 * Mirrors `extractToolCallObservation()` shape coverage:
 *   - OpenCode `tool` and `tool-invocation` parts → callID at $.callID
 *   - Anthropic `tool_use` parts → callID at $.id
 *
 * The four-key ORDER BY (m.time_created, m.id, p.time_created, p.id)
 * locks total order so two backfill runs against identical data
 * select the same first-seen owner. Without this, mixed-shape
 * sessions could pick different rows depending on JS reducer
 * iteration order.
 */
function buildSessionOwnerMap(db: Database, sessionId: string): Map<string, string> {
    const rows = db
        .prepare(
            `SELECT
                COALESCE(
                    CASE WHEN json_extract(p.data, '$.type') = 'tool_use'
                        THEN json_extract(p.data, '$.id')
                    END,
                    json_extract(p.data, '$.callID')
                ) AS callid,
                m.id AS owner_id,
                m.time_created AS owner_t_created,
                p.id AS part_id,
                p.time_created AS part_t_created
             FROM oc_backfill.message m
             INNER JOIN oc_backfill.part p ON p.message_id = m.id
             WHERE m.session_id = ?
               AND json_extract(m.data, '$.role') = 'assistant'
               AND (
                   (json_extract(p.data, '$.type') IN ('tool', 'tool-invocation')
                       AND json_extract(p.data, '$.callID') IS NOT NULL)
                   OR (json_extract(p.data, '$.type') = 'tool_use'
                       AND json_extract(p.data, '$.id') IS NOT NULL)
               )
             ORDER BY
                 m.time_created ASC,
                 m.id ASC,
                 p.time_created ASC,
                 p.id ASC`,
        )
        .all(sessionId) as OwnerExtractorRow[];

    const oldestByCallId = new Map<string, string>();
    for (const r of rows) {
        if (typeof r.callid !== "string" || r.callid.length === 0) continue;
        if (!oldestByCallId.has(r.callid)) {
            // First-seen wins thanks to the ORDER BY; no further
            // comparison needed.
            oldestByCallId.set(r.callid, r.owner_id);
        }
    }
    return oldestByCallId;
}

/**
 * NULL-guarded UPDATE for one session's tool tags. Returns the count
 * of rows actually updated.
 *
 * Wrapped in a single SQLite transaction so the per-session COMMIT is
 * atomic. SQLite holds a write lock for the duration; on the
 * playground DB's largest sessions (~30k tags) this is ~50ms — short
 * enough that other plugin instances barely notice.
 */
function applyOwnersForSession(
    db: Database,
    sessionId: string,
    ownersByCallId: Map<string, string>,
): { rowsUpdated: number; rowsLeftNull: number } {
    if (ownersByCallId.size === 0) {
        // No matches in OC DB; everything stays NULL and the runtime
        // lazy-adopts as it observes them.
        const leftNull = (
            db
                .prepare(
                    `SELECT COUNT(*) AS c FROM tags
                     WHERE session_id = ? AND type = 'tool'
                       AND tool_owner_message_id IS NULL`,
                )
                .get(sessionId) as { c: number }
        ).c;
        return { rowsUpdated: 0, rowsLeftNull: leftNull };
    }

    // Update the SINGLE lowest-tag_number NULL-owner row per callID.
    //
    // Rationale: the partial UNIQUE on (session_id, message_id,
    // tool_owner_message_id) rejects multiple non-NULL rows with the
    // same composite triple. When a session contains multiple
    // NULL-owner tag rows for the same callID (a collision-bug
    // legacy artifact), naively running one UPDATE for all of them
    // fails the partial UNIQUE on the second row, rolling back the
    // entire UPDATE.
    //
    // We instead claim the lowest-numbered orphan with a row-scoped
    // UPDATE keyed by `id`. The remaining NULL-owner rows are the
    // collision-bug "ghost" rows: by definition they were already
    // wrong (their drop status was bound to the wrong tag), and the
    // runtime lazy-adoption + partial UNIQUE together push them
    // toward correct owners as they're observed in fresh windows.
    const findOrphanStmt = db.prepare(
        `SELECT id FROM tags
         WHERE session_id = ? AND message_id = ? AND type = 'tool'
           AND tool_owner_message_id IS NULL
         ORDER BY tag_number ASC
         LIMIT 1`,
    );
    const updateRowStmt = db.prepare(
        `UPDATE tags
         SET tool_owner_message_id = ?
         WHERE id = ? AND tool_owner_message_id IS NULL`,
    );

    let rowsUpdated = 0;
    db.transaction(() => {
        for (const [callId, ownerId] of ownersByCallId) {
            const orphan = findOrphanStmt.get(sessionId, callId) as { id: number } | undefined;
            if (!orphan) continue;
            const result = updateRowStmt.run(ownerId, orphan.id);
            rowsUpdated += result.changes ?? 0;
        }
    })();

    const rowsLeftNull = (
        db
            .prepare(
                `SELECT COUNT(*) AS c FROM tags
                 WHERE session_id = ? AND type = 'tool'
                   AND tool_owner_message_id IS NULL`,
            )
            .get(sessionId) as { c: number }
    ).c;
    return { rowsUpdated, rowsLeftNull };
}

function backfillToolOwnersInChunks(db: Database, result: BackfillResult): void {
    const sessionIds = getSessionsNeedingBackfill(db);
    let lastRenewedAt = Date.now();

    for (const sessionId of sessionIds) {
        const now = Date.now();
        result.sessionsProcessed += 1;

        const acquired = acquireSessionLease(db, sessionId, now);
        if (!acquired) {
            result.sessionsBlockedByLease += 1;
            continue;
        }

        try {
            const owners = buildSessionOwnerMap(db, sessionId);
            const { rowsUpdated, rowsLeftNull } = applyOwnersForSession(db, sessionId, owners);
            result.rowsUpdated += rowsUpdated;
            result.rowsLeftNull += rowsLeftNull;

            if (owners.size === 0) {
                // OC DB had no matching assistant message for this
                // session's tool tags. Mark skipped so we don't retry
                // forever; lazy adoption handles them at runtime.
                markSessionSkipped(db, sessionId, Date.now(), "no_oc_matches");
                result.sessionsSkippedNoMatches += 1;
            } else {
                markSessionCompleted(db, sessionId, Date.now());
                result.sessionsCompleted += 1;
            }
        } catch (error) {
            log(
                `[backfill] session=${sessionId} errored: ${error instanceof Error ? error.message : String(error)}`,
            );
            markSessionErrored(db, sessionId, error);
            result.sessionsErrored += 1;
        }

        // Periodic lease renewal — only relevant on the rare giant
        // session that takes longer than a minute. Cheap to check.
        const sinceRenew = Date.now() - lastRenewedAt;
        if (sinceRenew > LEASE_RENEWAL_MS) {
            renewSessionLease(db, sessionId, Date.now());
            lastRenewedAt = Date.now();
        }
    }
}

/**
 * Test-only: read the backfill state for a session. Exposed via the
 * normal export but namespaced by underscore so it doesn't show up in
 * the public surface area outside tests.
 */
export function _getBackfillState(db: Database, sessionId: string): BackfillStateRow | null {
    ensureBackfillStateTable(db);
    const row = db
        .prepare("SELECT * FROM tool_owner_backfill_state WHERE session_id = ?")
        .get(sessionId);
    if (row === null || row === undefined) return null;
    return row as BackfillStateRow;
}
