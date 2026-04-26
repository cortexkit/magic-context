import { getHarness } from "../../shared/harness";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import { getMaxTagNumberBySession, getTagNumberByMessageId, insertTag } from "./storage-tags";
import type { TagEntry } from "./types";

export interface Tagger {
    assignTag(
        sessionId: string,
        messageId: string,
        type: TagEntry["type"],
        byteSize: number,
        db: Database,
        reasoningByteSize?: number,
        toolName?: string | null,
        inputByteSize?: number,
    ): number;
    getTag(sessionId: string, messageId: string): number | undefined;
    bindTag(sessionId: string, messageId: string, tagNumber: number): void;
    getAssignments(sessionId: string): ReadonlyMap<string, number>;
    resetCounter(sessionId: string, db: Database): void;
    getCounter(sessionId: string): number;
    initFromDb(sessionId: string, db: Database): void;
    cleanup(sessionId: string): void;
}

const GET_COUNTER_SQL = `SELECT counter FROM session_meta WHERE session_id = ?`;
const GET_ASSIGNMENTS_SQL =
    "SELECT message_id, tag_number FROM tags WHERE session_id = ? ORDER BY tag_number ASC";

interface AssignmentRow {
    message_id: string;
    tag_number: number;
}

function isAssignmentRow(row: unknown): row is AssignmentRow {
    if (row === null || typeof row !== "object") {
        return false;
    }

    const candidate = row as Record<string, unknown>;
    return typeof candidate.message_id === "string" && typeof candidate.tag_number === "number";
}

/**
 * Counter upsert is monotonic: ON CONFLICT we keep MAX(existing, new) so
 * concurrent writers (or a stale process catching up) cannot accidentally
 * roll the counter backwards. Combined with the DB-authoritative allocation
 * in assignTag(), this prevents a stale in-memory counter from re-issuing
 * tag numbers that another writer already claimed.
 *
 * `harness` is written on first INSERT only. On conflict we don't update it —
 * a session is created by exactly one harness (OpenCode or Pi) and that origin
 * doesn't change for the lifetime of the row.
 */
const UPSERT_COUNTER_SQL = `
  INSERT INTO session_meta (session_id, counter, harness)
  VALUES (?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET counter = MAX(session_meta.counter, excluded.counter)
`;

const upsertCounterStatements = new WeakMap<Database, PreparedStatement>();

function getUpsertCounterStatement(db: Database): PreparedStatement {
    let stmt = upsertCounterStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(UPSERT_COUNTER_SQL);
        upsertCounterStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Force-reset to 0. Distinct from the monotonic upsert above because callers
 * like /ctx-recomp need to roll the counter back to rebuild a session from
 * scratch. Includes harness on first INSERT for the same reason as the
 * monotonic upsert.
 */
const RESET_COUNTER_SQL = `
  INSERT INTO session_meta (session_id, counter, harness)
  VALUES (?, 0, ?)
  ON CONFLICT(session_id) DO UPDATE SET counter = 0
`;

const resetCounterStatements = new WeakMap<Database, PreparedStatement>();

function getResetCounterStatement(db: Database): PreparedStatement {
    let stmt = resetCounterStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(RESET_COUNTER_SQL);
        resetCounterStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Maximum retries when a tag_number INSERT collides with an existing row
 * for a different message_id (i.e. our counter is behind the DB max). Each
 * retry re-reads the DB max and tries the next slot. In practice 1-2 retries
 * are enough; the cap protects against pathological state divergence.
 */
const MAX_TAG_ALLOC_RETRIES = 5;

export function createTagger(): Tagger {
    // per-session monotonic counter
    const counters = new Map<string, number>();
    // per-session tag assignments: messageId → tag number
    const assignments = new Map<string, Map<string, number>>();

    function getSessionAssignments(sessionId: string): Map<string, number> {
        let map = assignments.get(sessionId);
        if (!map) {
            map = new Map();
            assignments.set(sessionId, map);
        }
        return map;
    }

    function isUniqueConstraintError(error: unknown): boolean {
        return (
            error instanceof Error &&
            "code" in error &&
            (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
        );
    }

    /**
     * Persist a counter value at least as large as `value`, both in memory
     * and in the session_meta table. The DB upsert is monotonic (MAX-based)
     * so this never moves the counter backwards, even under concurrent
     * writers from another process touching the same session.
     */
    function syncCounterAtLeast(sessionId: string, db: Database, value: number): void {
        if (value <= 0) return;
        const next = Math.max(counters.get(sessionId) ?? 0, value);
        counters.set(sessionId, next);
        getUpsertCounterStatement(db).run(sessionId, next, getHarness());
    }

    function assignTag(
        sessionId: string,
        messageId: string,
        type: TagEntry["type"],
        byteSize: number,
        db: Database,
        reasoningByteSize: number = 0,
        toolName: string | null = null,
        inputByteSize: number = 0,
    ): number {
        const sessionAssignments = getSessionAssignments(sessionId);

        const existing = sessionAssignments.get(messageId);
        if (existing !== undefined) {
            return existing;
        }

        // Fast path: this messageId already has a row in DB from a previous
        // pass. Bind the existing tag back into memory and bump the counter
        // to at least that value. This handles the case where the in-memory
        // assignments map was lost (cleanup/restart) but the DB still has
        // the row.
        const dbExisting = getTagNumberByMessageId(db, sessionId, messageId);
        if (dbExisting !== null) {
            sessionAssignments.set(messageId, dbExisting);
            syncCounterAtLeast(sessionId, db, dbExisting);
            return dbExisting;
        }

        // Allocation loop. The counter we have in memory may be stale relative
        // to what's in the DB (another process inserted, or an outer
        // transaction in a previous pass rolled back the counter upsert but
        // the inner SAVEPOINT had already committed the tag rows). Each
        // attempt:
        //   1. Re-read the live DB max
        //   2. Allocate one slot beyond max(memory_counter, db_max)
        //   3. Insert + upsert counter atomically inside a SAVEPOINT
        //   4. On UNIQUE collision: re-bind if the row now belongs to this
        //      messageId (race with another writer), else advance counter
        //      past the conflict and retry
        for (let attempt = 0; attempt < MAX_TAG_ALLOC_RETRIES; attempt += 1) {
            const memCounter = counters.get(sessionId) ?? 0;
            const dbMax = getMaxTagNumberBySession(db, sessionId);
            const next = Math.max(memCounter, dbMax) + 1;

            try {
                db.transaction(() => {
                    insertTag(
                        db,
                        sessionId,
                        messageId,
                        type,
                        byteSize,
                        next,
                        reasoningByteSize,
                        toolName,
                        inputByteSize,
                    );
                    getUpsertCounterStatement(db).run(sessionId, next, getHarness());
                })();
            } catch (error: unknown) {
                if (!isUniqueConstraintError(error)) {
                    throw error;
                }

                // UNIQUE collision. Two possible causes:
                //   (a) Another writer just claimed `next` for a DIFFERENT
                //       messageId — recovery: advance our counter past the
                //       new DB max and retry.
                //   (b) This messageId was raced and now has its own row —
                //       recovery: bind the existing tag and return it.
                const racedRow = getTagNumberByMessageId(db, sessionId, messageId);
                if (racedRow !== null) {
                    sessionAssignments.set(messageId, racedRow);
                    syncCounterAtLeast(sessionId, db, racedRow);
                    return racedRow;
                }

                // Case (a): advance counter and try again. Bumping past the
                // current DB max prevents an immediate re-collision on the
                // next attempt while still allocating the smallest available
                // unused slot.
                const advancedDbMax = getMaxTagNumberBySession(db, sessionId);
                counters.set(sessionId, Math.max(memCounter, advancedDbMax));
                continue;
            }

            counters.set(sessionId, next);
            sessionAssignments.set(messageId, next);
            return next;
        }

        // Give up after retries — surface the failure so the transform
        // catch can log it and continue with reduced functionality.
        throw new Error(
            `tagger.assignTag: failed to allocate tag for session=${sessionId} message=${messageId} after ${MAX_TAG_ALLOC_RETRIES} retries`,
        );
    }

    function getTag(sessionId: string, messageId: string): number | undefined {
        return assignments.get(sessionId)?.get(messageId);
    }

    function bindTag(sessionId: string, messageId: string, tagNumber: number): void {
        getSessionAssignments(sessionId).set(messageId, tagNumber);
    }

    function getAssignments(sessionId: string): ReadonlyMap<string, number> {
        return getSessionAssignments(sessionId);
    }

    function resetCounter(sessionId: string, db: Database): void {
        // Force-reset uses a non-monotonic UPDATE so callers can rebuild a
        // session from scratch (e.g. /ctx-recomp full rebuild). Bypass the
        // monotonic upsert by using a dedicated statement.
        counters.set(sessionId, 0);
        assignments.delete(sessionId);
        getResetCounterStatement(db).run(sessionId, getHarness());
    }

    function getCounter(sessionId: string): number {
        return counters.get(sessionId) ?? 0;
    }

    /**
     * Load (or refresh) per-session tagger state from the DB.
     *
     * Always re-reads the assignments and counter from disk so we pick up
     * any inserts another writer may have made since this process last
     * looked. The previous `if (counters.has(sessionId)) return` short-
     * circuit was a long-lived bug: once the in-memory counter drifted
     * behind the DB max (stale process, prior outer-transaction rollback,
     * concurrent writer), it could never self-heal — every assignTag would
     * keep proposing already-claimed tag numbers and either go through the
     * collision-recovery slow path or fail outright.
     *
     * This refresh is cheap: one indexed SELECT for the counter, one
     * indexed SELECT for the per-session assignments. Called once per
     * transform pass.
     */
    function initFromDb(sessionId: string, db: Database): void {
        const row = db.prepare(GET_COUNTER_SQL).get(sessionId) as
            | { counter: number }
            | null
            | undefined;
        const assignmentRows = db
            .prepare(GET_ASSIGNMENTS_SQL)
            .all(sessionId)
            .filter(isAssignmentRow);
        const sessionAssignments = getSessionAssignments(sessionId);
        sessionAssignments.clear();

        let maxTagNumber = 0;
        for (const assignment of assignmentRows) {
            sessionAssignments.set(assignment.message_id, assignment.tag_number);
            if (assignment.tag_number > maxTagNumber) {
                maxTagNumber = assignment.tag_number;
            }
        }

        // Counter is the largest of three signals: persisted counter (what
        // we last wrote), DB max from the assignments table (what's actually
        // claimed), and current in-memory counter (what we already allocated
        // in this process). Taking the max of all three guarantees we never
        // hand out a number some other writer has already taken.
        const counter = Math.max(row?.counter ?? 0, maxTagNumber, counters.get(sessionId) ?? 0);
        counters.set(sessionId, counter);
    }

    function cleanup(sessionId: string): void {
        counters.delete(sessionId);
        assignments.delete(sessionId);
    }

    return {
        assignTag,
        getTag,
        bindTag,
        getAssignments,
        resetCounter,
        getCounter,
        initFromDb,
        cleanup,
    };
}
