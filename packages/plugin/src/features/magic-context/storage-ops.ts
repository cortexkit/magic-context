import { getHarness } from "../../shared/harness";
import { sessionLog } from "../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import type { PendingOp } from "./types";

const queuePendingOpStatements = new WeakMap<Database, PreparedStatement>();
const getPendingOpsStatements = new WeakMap<Database, PreparedStatement>();
const clearPendingOpsStatements = new WeakMap<Database, PreparedStatement>();
const removePendingOpStatements = new WeakMap<Database, PreparedStatement>();

function getQueuePendingOpStatement(db: Database): PreparedStatement {
    let stmt = queuePendingOpStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, ?, ?, ?)",
        );
        queuePendingOpStatements.set(db, stmt);
    }
    return stmt;
}

function getPendingOpsStatement(db: Database): PreparedStatement {
    let stmt = getPendingOpsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT id, session_id, tag_id, operation, queued_at FROM pending_ops WHERE session_id = ? ORDER BY queued_at ASC, id ASC",
        );
        getPendingOpsStatements.set(db, stmt);
    }
    return stmt;
}

function getClearPendingOpsStatement(db: Database): PreparedStatement {
    let stmt = clearPendingOpsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("DELETE FROM pending_ops WHERE session_id = ?");
        clearPendingOpsStatements.set(db, stmt);
    }
    return stmt;
}

function getRemovePendingOpStatement(db: Database): PreparedStatement {
    let stmt = removePendingOpStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("DELETE FROM pending_ops WHERE session_id = ? AND tag_id = ?");
        removePendingOpStatements.set(db, stmt);
    }
    return stmt;
}

interface PendingOpRow {
    id: number;
    session_id: string;
    tag_id: number;
    operation: string;
    queued_at: number;
}

function isPendingOpRow(row: unknown): row is PendingOpRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.id === "number" &&
        typeof r.session_id === "string" &&
        typeof r.tag_id === "number" &&
        typeof r.operation === "string" &&
        typeof r.queued_at === "number"
    );
}

function toPendingOp(row: PendingOpRow): PendingOp | null {
    if (row.operation !== "drop") {
        sessionLog(row.session_id, `unknown pending operation "${row.operation}"; ignoring`);
        return null;
    }

    return {
        id: row.id,
        sessionId: row.session_id,
        tagId: row.tag_id,
        operation: row.operation,
        queuedAt: row.queued_at,
    };
}

export function queuePendingOp(
    db: Database,
    sessionId: string,
    tagId: number,
    operation: PendingOp["operation"],
    queuedAt: number = Date.now(),
): void {
    getQueuePendingOpStatement(db).run(sessionId, tagId, operation, queuedAt, getHarness());
}

export function getPendingOps(db: Database, sessionId: string): PendingOp[] {
    const rows = getPendingOpsStatement(db).all(sessionId).filter(isPendingOpRow);

    return rows.map(toPendingOp).filter((op): op is PendingOp => op !== null);
}

export function clearPendingOps(db: Database, sessionId: string): void {
    getClearPendingOpsStatement(db).run(sessionId);
}

export function removePendingOp(db: Database, sessionId: string, tagId: number): void {
    getRemovePendingOpStatement(db).run(sessionId, tagId);
}
