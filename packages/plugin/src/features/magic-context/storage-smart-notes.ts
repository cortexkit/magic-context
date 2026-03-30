import type { Database } from "bun:sqlite";

export type SmartNoteStatus = "pending" | "ready" | "dismissed";

export interface SmartNote {
    id: number;
    projectPath: string;
    content: string;
    surfaceCondition: string;
    status: SmartNoteStatus;
    createdSessionId: string | null;
    createdAt: number;
    updatedAt: number;
    lastCheckedAt: number | null;
    readyAt: number | null;
    readyReason: string | null;
}

interface SmartNoteRow {
    id: number;
    project_path: string;
    content: string;
    surface_condition: string;
    status: string;
    created_session_id: string | null;
    created_at: number;
    updated_at: number;
    last_checked_at: number | null;
    ready_at: number | null;
    ready_reason: string | null;
}

function isSmartNoteRow(row: unknown): row is SmartNoteRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.id === "number" &&
        typeof r.project_path === "string" &&
        typeof r.content === "string" &&
        typeof r.surface_condition === "string" &&
        typeof r.status === "string" &&
        typeof r.created_at === "number" &&
        typeof r.updated_at === "number"
    );
}

function toSmartNote(row: SmartNoteRow): SmartNote {
    return {
        id: row.id,
        projectPath: row.project_path,
        content: row.content,
        surfaceCondition: row.surface_condition,
        status: row.status as SmartNoteStatus,
        createdSessionId:
            row.created_session_id && row.created_session_id.length > 0
                ? row.created_session_id
                : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastCheckedAt: row.last_checked_at,
        readyAt: row.ready_at,
        readyReason: row.ready_reason && row.ready_reason.length > 0 ? row.ready_reason : null,
    };
}

export function addSmartNote(
    db: Database,
    projectPath: string,
    content: string,
    surfaceCondition: string,
    sessionId?: string,
): SmartNote {
    const now = Date.now();
    const result = db
        .prepare(
            "INSERT INTO smart_notes (project_path, content, surface_condition, status, created_session_id, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?) RETURNING *",
        )
        .get(projectPath, content, surfaceCondition, sessionId ?? null, now, now);
    if (!isSmartNoteRow(result)) {
        throw new Error("[smart-notes] failed to insert smart note");
    }
    return toSmartNote(result);
}

export function getSmartNotes(
    db: Database,
    projectPath: string,
    status?: SmartNoteStatus,
): SmartNote[] {
    const query = status
        ? "SELECT * FROM smart_notes WHERE project_path = ? AND status = ? ORDER BY created_at ASC"
        : "SELECT * FROM smart_notes WHERE project_path = ? AND status != 'dismissed' ORDER BY created_at ASC";
    const params = status ? [projectPath, status] : [projectPath];
    return (db.prepare(query).all(...params) as unknown[]).filter(isSmartNoteRow).map(toSmartNote);
}

export function getPendingSmartNotes(db: Database, projectPath: string): SmartNote[] {
    return getSmartNotes(db, projectPath, "pending");
}

export function getReadySmartNotes(db: Database, projectPath: string): SmartNote[] {
    return getSmartNotes(db, projectPath, "ready");
}

export function markSmartNoteReady(db: Database, noteId: number, readyReason?: string): void {
    const now = Date.now();
    db.prepare(
        "UPDATE smart_notes SET status = 'ready', ready_at = ?, ready_reason = ?, updated_at = ?, last_checked_at = ? WHERE id = ?",
    ).run(now, readyReason ?? null, now, now, noteId);
}

export function markSmartNoteChecked(db: Database, noteId: number): void {
    const now = Date.now();
    db.prepare("UPDATE smart_notes SET last_checked_at = ?, updated_at = ? WHERE id = ?").run(
        now,
        now,
        noteId,
    );
}

export function dismissSmartNote(db: Database, noteId: number): boolean {
    const result = db
        .prepare("UPDATE smart_notes SET status = 'dismissed', updated_at = ? WHERE id = ?")
        .run(Date.now(), noteId);
    return result.changes > 0;
}

export function deleteSmartNote(db: Database, noteId: number): boolean {
    const result = db.prepare("DELETE FROM smart_notes WHERE id = ?").run(noteId);
    return result.changes > 0;
}
