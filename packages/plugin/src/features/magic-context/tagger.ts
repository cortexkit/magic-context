import type { Database } from "bun:sqlite";
import { insertTag } from "./storage-tags";
import type { TagEntry } from "./types";
export interface Tagger {
    assignTag(
        sessionId: string,
        messageId: string,
        type: TagEntry["type"],
        byteSize: number,
        db: Database,
        reasoningByteSize?: number,
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

const UPSERT_COUNTER_SQL = `
  INSERT INTO session_meta (session_id, counter)
  VALUES (?, ?)
  ON CONFLICT(session_id) DO UPDATE SET counter = excluded.counter
`;

type PreparedStatement = ReturnType<Database["prepare"]>;

const upsertCounterStatements = new WeakMap<Database, PreparedStatement>();

function getUpsertCounterStatement(db: Database): PreparedStatement {
    let stmt = upsertCounterStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(UPSERT_COUNTER_SQL);
        upsertCounterStatements.set(db, stmt);
    }
    return stmt;
}

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

    function assignTag(
        sessionId: string,
        messageId: string,
        type: TagEntry["type"],
        byteSize: number,
        db: Database,
        reasoningByteSize: number = 0,
    ): number {
        const sessionAssignments = getSessionAssignments(sessionId);

        const existing = sessionAssignments.get(messageId);
        if (existing !== undefined) {
            return existing;
        }

        const current = counters.get(sessionId) ?? 0;
        const next = current + 1;

        try {
            db.transaction(() => {
                insertTag(db, sessionId, messageId, type, byteSize, next, reasoningByteSize);
                getUpsertCounterStatement(db).run(sessionId, next);
            })();
        } catch (error: unknown) {
            // Benign duplicate: the tag already exists in the DB from a previous pass
            // whose in-memory state was lost (e.g., error in a different tag within the
            // same batch). Recover by binding the existing tag number from DB.
            if (
                error instanceof Error &&
                "code" in error &&
                error.code === "SQLITE_CONSTRAINT_UNIQUE"
            ) {
                const row = db
                    .prepare("SELECT tag_number FROM tags WHERE session_id = ? AND message_id = ?")
                    .get(sessionId, messageId) as { tag_number: number } | null;
                if (row) {
                    sessionAssignments.set(messageId, row.tag_number);
                    return row.tag_number;
                }
            }
            throw error;
        }

        counters.set(sessionId, next);
        sessionAssignments.set(messageId, next);
        return next;
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
        counters.set(sessionId, 0);
        assignments.delete(sessionId);
        getUpsertCounterStatement(db).run(sessionId, 0);
    }

    function getCounter(sessionId: string): number {
        return counters.get(sessionId) ?? 0;
    }

    function initFromDb(sessionId: string, db: Database): void {
        if (counters.has(sessionId)) {
            return;
        }

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

        const counter = Math.max(row?.counter ?? 0, maxTagNumber);
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
