import type { Database } from "bun:sqlite";
import { log } from "../../shared/logger";
import type { PendingOp } from "./types";

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
        log(
            `[magic-context] unknown pending operation "${row.operation}" for session ${row.session_id}; ignoring`,
        );
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
    db.prepare(
        "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES (?, ?, ?, ?)",
    ).run(sessionId, tagId, operation, queuedAt);
}

export function getPendingOps(db: Database, sessionId: string): PendingOp[] {
    const rows = db
        .prepare(
            "SELECT id, session_id, tag_id, operation, queued_at FROM pending_ops WHERE session_id = ? ORDER BY queued_at ASC, id ASC",
        )
        .all(sessionId)
        .filter(isPendingOpRow);

    return rows.map(toPendingOp).filter((op): op is PendingOp => op !== null);
}

export function hasPendingOps(db: Database, sessionId: string): boolean {
    const result = db
        .prepare("SELECT 1 FROM pending_ops WHERE session_id = ? LIMIT 1")
        .get(sessionId);

    return result !== null && result !== undefined;
}

export function clearPendingOps(db: Database, sessionId: string): void {
    db.prepare("DELETE FROM pending_ops WHERE session_id = ?").run(sessionId);
}

export function removePendingOp(db: Database, sessionId: string, tagId: number): void {
    db.prepare("DELETE FROM pending_ops WHERE session_id = ? AND tag_id = ?").run(sessionId, tagId);
}
