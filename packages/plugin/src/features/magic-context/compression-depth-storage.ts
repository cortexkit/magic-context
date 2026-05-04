import { getHarness } from "../../shared/harness";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";

const incrementDepthStatements = new WeakMap<Database, PreparedStatement>();
const totalDepthStatements = new WeakMap<Database, PreparedStatement>();
const maxDepthStatements = new WeakMap<Database, PreparedStatement>();
const clearDepthStatements = new WeakMap<Database, PreparedStatement>();

interface TotalDepthRow {
    total_depth: number;
}

interface MaxDepthRow {
    max_depth: number;
}

function getIncrementDepthStatement(db: Database): PreparedStatement {
    let stmt = incrementDepthStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO compression_depth (session_id, message_ordinal, depth, harness) VALUES (?, ?, 1, ?) ON CONFLICT(session_id, message_ordinal) DO UPDATE SET depth = depth + 1",
        );
        incrementDepthStatements.set(db, stmt);
    }
    return stmt;
}

function getTotalDepthStatement(db: Database): PreparedStatement {
    let stmt = totalDepthStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT COALESCE(SUM(depth), 0) AS total_depth FROM compression_depth WHERE session_id = ? AND message_ordinal BETWEEN ? AND ?",
        );
        totalDepthStatements.set(db, stmt);
    }
    return stmt;
}

function getMaxDepthStatement(db: Database): PreparedStatement {
    let stmt = maxDepthStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT COALESCE(MAX(depth), 0) AS max_depth FROM compression_depth WHERE session_id = ?",
        );
        maxDepthStatements.set(db, stmt);
    }
    return stmt;
}

function getClearDepthStatement(db: Database): PreparedStatement {
    let stmt = clearDepthStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("DELETE FROM compression_depth WHERE session_id = ?");
        clearDepthStatements.set(db, stmt);
    }
    return stmt;
}

export function incrementCompressionDepth(
    db: Database,
    sessionId: string,
    startOrdinal: number,
    endOrdinal: number,
): void {
    if (endOrdinal < startOrdinal) {
        return;
    }

    db.transaction(() => {
        const stmt = getIncrementDepthStatement(db);
        for (let ordinal = startOrdinal; ordinal <= endOrdinal; ordinal += 1) {
            stmt.run(sessionId, ordinal, getHarness());
        }
    })();
}

export function getAverageCompressionDepth(
    db: Database,
    sessionId: string,
    startOrdinal: number,
    endOrdinal: number,
): number {
    if (endOrdinal < startOrdinal) {
        return 0;
    }

    const row = getTotalDepthStatement(db).get(
        sessionId,
        startOrdinal,
        endOrdinal,
    ) as TotalDepthRow | null;
    const totalDepth = typeof row?.total_depth === "number" ? row.total_depth : 0;
    const messageCount = endOrdinal - startOrdinal + 1;
    return totalDepth / messageCount;
}

export function getMaxCompressionDepth(db: Database, sessionId: string): number {
    const row = getMaxDepthStatement(db).get(sessionId) as MaxDepthRow | null;
    return typeof row?.max_depth === "number" ? row.max_depth : 0;
}

export function clearCompressionDepth(db: Database, sessionId: string): void {
    getClearDepthStatement(db).run(sessionId);
}

/**
 * Clear compression depth counters for a specific message range.
 * Used by partial recomp: rebuilt compartments start fresh at depth 0, so
 * depth rows for the rebuilt ordinals must be removed. Existing depth for
 * ordinals outside the range (prior and tail compartments) is preserved.
 */
export function clearCompressionDepthRange(
    db: Database,
    sessionId: string,
    startOrdinal: number,
    endOrdinal: number,
): void {
    if (endOrdinal < startOrdinal) {
        return;
    }
    db.prepare(
        "DELETE FROM compression_depth WHERE session_id = ? AND message_ordinal BETWEEN ? AND ?",
    ).run(sessionId, startOrdinal, endOrdinal);
}
