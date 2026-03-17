import type { Database } from "bun:sqlite";

export interface SessionNote {
    id: number;
    sessionId: string;
    content: string;
    createdAt: number;
}

interface SessionNoteRow {
    id: number;
    session_id: string;
    content: string;
    created_at: number;
}

function isSessionNoteRow(row: unknown): row is SessionNoteRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.id === "number" &&
        typeof candidate.session_id === "string" &&
        typeof candidate.content === "string" &&
        typeof candidate.created_at === "number"
    );
}

function toSessionNote(row: SessionNoteRow): SessionNote {
    return {
        id: row.id,
        sessionId: row.session_id,
        content: row.content,
        createdAt: row.created_at,
    };
}

export function getSessionNotes(db: Database, sessionId: string): SessionNote[] {
    const rows = db
        .prepare("SELECT * FROM session_notes WHERE session_id = ? ORDER BY id ASC")
        .all(sessionId)
        .filter(isSessionNoteRow);
    return rows.map(toSessionNote);
}

export function addSessionNote(db: Database, sessionId: string, content: string): void {
    db.prepare("INSERT INTO session_notes (session_id, content, created_at) VALUES (?, ?, ?)").run(
        sessionId,
        content,
        Date.now(),
    );
}

export function clearSessionNotes(db: Database, sessionId: string): void {
    db.prepare("DELETE FROM session_notes WHERE session_id = ?").run(sessionId);
}

export function replaceAllSessionNotes(db: Database, sessionId: string, notes: string[]): void {
    const now = Date.now();
    db.transaction(() => {
        db.prepare("DELETE FROM session_notes WHERE session_id = ?").run(sessionId);
        const insert = db.prepare(
            "INSERT INTO session_notes (session_id, content, created_at) VALUES (?, ?, ?)",
        );
        for (const note of notes) {
            insert.run(sessionId, note, now);
        }
    })();
}
