import { getHarness } from "../../shared/harness";
import type { Database } from "../../shared/sqlite";

export type NoteType = "session" | "smart";
export type NoteStatus = "active" | "pending" | "ready" | "dismissed";

export interface Note {
    id: number;
    type: NoteType;
    status: NoteStatus;
    content: string;
    sessionId: string | null;
    projectPath: string | null;
    surfaceCondition: string | null;
    createdAt: number;
    updatedAt: number;
    lastCheckedAt: number | null;
    readyAt: number | null;
    readyReason: string | null;
}

export interface GetNotesOptions {
    sessionId?: string;
    projectPath?: string;
    type?: NoteType;
    status?: NoteStatus | NoteStatus[];
}

export interface UpdateNoteOptions {
    content?: string;
    sessionId?: string | null;
    projectPath?: string | null;
    surfaceCondition?: string | null;
    status?: NoteStatus;
    lastCheckedAt?: number | null;
    readyAt?: number | null;
    readyReason?: string | null;
}

interface NoteRow {
    id: number;
    type: string;
    status: string;
    content: string;
    session_id: string | null;
    project_path: string | null;
    surface_condition: string | null;
    created_at: number;
    updated_at: number;
    last_checked_at: number | null;
    ready_at: number | null;
    ready_reason: string | null;
}

interface SessionNoteInput {
    sessionId: string;
    content: string;
}

interface SmartNoteInput {
    content: string;
    sessionId?: string;
    projectPath: string;
    surfaceCondition: string;
}

const NOTE_TYPES = new Set<NoteType>(["session", "smart"]);
const NOTE_STATUSES = new Set<NoteStatus>(["active", "pending", "ready", "dismissed"]);
const DEFAULT_SMART_STATUSES: NoteStatus[] = ["pending", "ready"];

function toNullableString(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function toNullableNumber(value: unknown): number | null {
    return typeof value === "number" ? value : null;
}

function isNoteRow(row: unknown): row is NoteRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.id === "number" &&
        typeof candidate.type === "string" &&
        NOTE_TYPES.has(candidate.type as NoteType) &&
        typeof candidate.status === "string" &&
        NOTE_STATUSES.has(candidate.status as NoteStatus) &&
        typeof candidate.content === "string" &&
        (candidate.session_id === null || typeof candidate.session_id === "string") &&
        (candidate.project_path === null || typeof candidate.project_path === "string") &&
        (candidate.surface_condition === null || typeof candidate.surface_condition === "string") &&
        typeof candidate.created_at === "number" &&
        typeof candidate.updated_at === "number" &&
        (candidate.last_checked_at === null || typeof candidate.last_checked_at === "number") &&
        (candidate.ready_at === null || typeof candidate.ready_at === "number") &&
        (candidate.ready_reason === null || typeof candidate.ready_reason === "string")
    );
}

function toNote(row: NoteRow): Note {
    return {
        id: row.id,
        type: row.type as NoteType,
        status: row.status as NoteStatus,
        content: row.content,
        sessionId: toNullableString(row.session_id),
        projectPath: toNullableString(row.project_path),
        surfaceCondition: toNullableString(row.surface_condition),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastCheckedAt: toNullableNumber(row.last_checked_at),
        readyAt: toNullableNumber(row.ready_at),
        readyReason: toNullableString(row.ready_reason),
    };
}

function getNoteById(db: Database, noteId: number): Note | null {
    const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId);
    return isNoteRow(row) ? toNote(row) : null;
}

function buildStatusClause(status: GetNotesOptions["status"]): {
    sql: string;
    params: NoteStatus[];
} | null {
    if (status === undefined) {
        return null;
    }
    const statuses = Array.isArray(status) ? status : [status];
    if (statuses.length === 0) {
        return null;
    }
    const placeholders = statuses.map(() => "?").join(", ");
    return {
        sql: `status IN (${placeholders})`,
        params: statuses,
    };
}

export function getNotes(db: Database, options: GetNotesOptions = {}): Note[] {
    const clauses: string[] = [];
    const params: Array<string | NoteStatus> = [];

    if (options.sessionId !== undefined) {
        clauses.push("session_id = ?");
        params.push(options.sessionId);
    }
    if (options.projectPath !== undefined) {
        clauses.push("project_path = ?");
        params.push(options.projectPath);
    }
    if (options.type !== undefined) {
        clauses.push("type = ?");
        params.push(options.type);
    }

    const statusClause = buildStatusClause(options.status);
    if (statusClause) {
        clauses.push(statusClause.sql);
        params.push(...statusClause.params);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (
        db
            .prepare(`SELECT * FROM notes${where} ORDER BY created_at ASC, id ASC`)
            .all(...params) as unknown[]
    )
        .filter(isNoteRow)
        .map(toNote);
}

export function addNote(db: Database, type: "session", options: SessionNoteInput): Note;
export function addNote(db: Database, type: "smart", options: SmartNoteInput): Note;
export function addNote(
    db: Database,
    type: NoteType,
    options: SessionNoteInput | SmartNoteInput,
): Note {
    const now = Date.now();
    const result =
        type === "session"
            ? db
                  .prepare(
                      "INSERT INTO notes (type, status, content, session_id, created_at, updated_at, harness) VALUES ('session', 'active', ?, ?, ?, ?, ?) RETURNING *",
                  )
                  .get(
                      options.content,
                      (options as SessionNoteInput).sessionId,
                      now,
                      now,
                      getHarness(),
                  )
            : db
                  .prepare(
                      "INSERT INTO notes (type, status, content, session_id, project_path, surface_condition, created_at, updated_at, harness) VALUES ('smart', 'pending', ?, ?, ?, ?, ?, ?, ?) RETURNING *",
                  )
                  .get(
                      options.content,
                      (options as SmartNoteInput).sessionId ?? null,
                      (options as SmartNoteInput).projectPath,
                      (options as SmartNoteInput).surfaceCondition,
                      now,
                      now,
                      getHarness(),
                  );

    if (!isNoteRow(result)) {
        throw new Error("[notes] failed to insert note");
    }

    return toNote(result);
}

export function getSessionNotes(db: Database, sessionId: string): Note[] {
    return getNotes(db, { sessionId, type: "session", status: "active" });
}

export function getSmartNotes(db: Database, projectPath: string, status?: NoteStatus): Note[] {
    return getNotes(db, {
        projectPath,
        type: "smart",
        status: status ?? DEFAULT_SMART_STATUSES,
    });
}

export function getPendingSmartNotes(db: Database, projectPath: string): Note[] {
    return getSmartNotes(db, projectPath, "pending");
}

export function getReadySmartNotes(db: Database, projectPath: string): Note[] {
    return getSmartNotes(db, projectPath, "ready");
}

export function updateNote(db: Database, noteId: number, updates: UpdateNoteOptions): Note | null {
    const existing = getNoteById(db, noteId);
    if (!existing) {
        return null;
    }

    const now = Date.now();
    const sets: string[] = ["updated_at = ?"];
    const params: Array<string | number | null> = [now];

    if (updates.content !== undefined) {
        sets.push("content = ?");
        params.push(updates.content);
    }
    if (updates.sessionId !== undefined) {
        sets.push("session_id = ?");
        params.push(updates.sessionId);
    }
    if (updates.status !== undefined) {
        sets.push("status = ?");
        params.push(updates.status);
    }

    if (existing.type === "smart") {
        if (updates.projectPath !== undefined) {
            sets.push("project_path = ?");
            params.push(updates.projectPath);
        }
        if (updates.surfaceCondition !== undefined) {
            sets.push("surface_condition = ?");
            params.push(updates.surfaceCondition);
        }
        if (updates.lastCheckedAt !== undefined) {
            sets.push("last_checked_at = ?");
            params.push(updates.lastCheckedAt);
        }
        if (updates.readyAt !== undefined) {
            sets.push("ready_at = ?");
            params.push(updates.readyAt);
        }
        if (updates.readyReason !== undefined) {
            sets.push("ready_reason = ?");
            params.push(updates.readyReason);
        }
    }

    if (sets.length === 1) {
        return null;
    }

    params.push(noteId);
    const result = db
        .prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
        .get(...params);
    return isNoteRow(result) ? toNote(result) : null;
}

// Intentional: dismiss/update operate by note ID without session/project scope checks.
// Session notes are only discoverable via `ctx_note read` which filters by current sessionId;
// smart notes are filtered by project_path. No cross-session discovery path exists for the agent.
export function dismissNote(db: Database, noteId: number): boolean {
    const result = db
        .prepare(
            "UPDATE notes SET status = 'dismissed', updated_at = ? WHERE id = ? AND status != 'dismissed'",
        )
        .run(Date.now(), noteId);
    return result.changes > 0;
}

export function markNoteReady(db: Database, noteId: number, reason?: string): void {
    const now = Date.now();
    db.prepare(
        "UPDATE notes SET status = 'ready', ready_at = ?, ready_reason = ?, updated_at = ?, last_checked_at = ? WHERE id = ? AND type = 'smart'",
    ).run(now, reason ?? null, now, now, noteId);
}

export function markNoteChecked(db: Database, noteId: number): void {
    const now = Date.now();
    db.prepare(
        "UPDATE notes SET last_checked_at = ?, updated_at = ? WHERE id = ? AND type = 'smart'",
    ).run(now, now, noteId);
}

export function deleteNote(db: Database, noteId: number): boolean {
    const result = db.prepare("DELETE FROM notes WHERE id = ?").run(noteId);
    return result.changes > 0;
}

export function replaceAllSessionNotes(db: Database, sessionId: string, notes: string[]): void {
    const now = Date.now();
    db.transaction(() => {
        db.prepare("DELETE FROM notes WHERE session_id = ? AND type = 'session'").run(sessionId);
        const insert = db.prepare(
            "INSERT INTO notes (type, status, content, session_id, created_at, updated_at, harness) VALUES ('session', 'active', ?, ?, ?, ?, ?)",
        );
        for (const note of notes) {
            insert.run(note, sessionId, now, now, getHarness());
        }
    })();
}
