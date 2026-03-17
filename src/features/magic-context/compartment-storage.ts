import type { Database } from "bun:sqlite";
import type { SessionNote } from "./storage-notes";

export interface Compartment {
    id: number;
    sessionId: string;
    sequence: number;
    startMessage: number;
    endMessage: number;
    startMessageId: string;
    endMessageId: string;
    title: string;
    content: string;
    createdAt: number;
}

export interface SessionFact {
    id: number;
    sessionId: string;
    category: string;
    content: string;
    createdAt: number;
    updatedAt: number;
}

interface CompartmentRow {
    id: number;
    session_id: string;
    sequence: number;
    start_message: number;
    end_message: number;
    start_message_id: string;
    end_message_id: string;
    title: string;
    content: string;
    created_at: number;
}

interface SessionFactRow {
    id: number;
    session_id: string;
    category: string;
    content: string;
    created_at: number;
    updated_at: number;
}

function isCompartmentRow(row: unknown): row is CompartmentRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.id === "number" &&
        typeof candidate.session_id === "string" &&
        typeof candidate.sequence === "number" &&
        typeof candidate.start_message === "number" &&
        typeof candidate.end_message === "number" &&
        typeof candidate.start_message_id === "string" &&
        typeof candidate.end_message_id === "string" &&
        typeof candidate.title === "string" &&
        typeof candidate.content === "string" &&
        typeof candidate.created_at === "number"
    );
}

function isSessionFactRow(row: unknown): row is SessionFactRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.id === "number" &&
        typeof candidate.session_id === "string" &&
        typeof candidate.category === "string" &&
        typeof candidate.content === "string" &&
        typeof candidate.created_at === "number" &&
        typeof candidate.updated_at === "number"
    );
}

export interface CompartmentInput {
    sequence: number;
    startMessage: number;
    endMessage: number;
    startMessageId: string;
    endMessageId: string;
    title: string;
    content: string;
}

function toCompartment(row: CompartmentRow): Compartment {
    return {
        id: row.id,
        sessionId: row.session_id,
        sequence: row.sequence,
        startMessage: row.start_message,
        endMessage: row.end_message,
        startMessageId: row.start_message_id,
        endMessageId: row.end_message_id,
        title: row.title,
        content: row.content,
        createdAt: row.created_at,
    };
}

function toSessionFact(row: SessionFactRow): SessionFact {
    return {
        id: row.id,
        sessionId: row.session_id,
        category: row.category,
        content: row.content,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function getCompartments(db: Database, sessionId: string): Compartment[] {
    const rows = db
        .prepare("SELECT * FROM compartments WHERE session_id = ? ORDER BY sequence ASC")
        .all(sessionId)
        .filter(isCompartmentRow);
    return rows.map(toCompartment);
}

export function getLastCompartmentEndMessage(db: Database, sessionId: string): number {
    const row = db
        .prepare("SELECT MAX(end_message) as max_end FROM compartments WHERE session_id = ?")
        .get(sessionId) as { max_end: number | null } | null;
    return row?.max_end ?? -1;
}

export function replaceAllCompartments(
    db: Database,
    sessionId: string,
    compartments: CompartmentInput[],
): void {
    const now = Date.now();
    db.transaction(() => {
        db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
        const stmt = db.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const c of compartments) {
            stmt.run(
                sessionId,
                c.sequence,
                c.startMessage,
                c.endMessage,
                c.startMessageId,
                c.endMessageId,
                c.title,
                c.content,
                now,
            );
        }
    })();
}

export function getSessionFacts(db: Database, sessionId: string): SessionFact[] {
    const rows = db
        .prepare("SELECT * FROM session_facts WHERE session_id = ? ORDER BY category ASC, id ASC")
        .all(sessionId)
        .filter(isSessionFactRow);
    return rows.map(toSessionFact);
}

export function replaceAllCompartmentState(
    db: Database,
    sessionId: string,
    compartments: CompartmentInput[],
    facts: Array<{ category: string; content: string }>,
    notes: string[] = [],
): void {
    const now = Date.now();
    db.transaction(() => {
        db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM session_facts WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM session_notes WHERE session_id = ?").run(sessionId);

        const compartmentStmt = db.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const c of compartments) {
            compartmentStmt.run(
                sessionId,
                c.sequence,
                c.startMessage,
                c.endMessage,
                c.startMessageId,
                c.endMessageId,
                c.title,
                c.content,
                now,
            );
        }

        const factStmt = db.prepare(
            "INSERT INTO session_facts (session_id, category, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        );
        for (const f of facts) {
            factStmt.run(sessionId, f.category, f.content, now, now);
        }

        const noteStmt = db.prepare(
            "INSERT INTO session_notes (session_id, content, created_at) VALUES (?, ?, ?)",
        );
        for (const note of notes) {
            noteStmt.run(sessionId, note, now);
        }
    })();
}

export function buildCompartmentBlock(
    compartments: Compartment[],
    facts: SessionFact[],
    notes: SessionNote[] = [],
): string {
    const lines: string[] = [];

    for (const c of compartments) {
        lines.push(`<compartment title="${escapeXmlAttr(c.title)}">`);
        lines.push(escapeXmlContent(c.content));
        lines.push("</compartment>");
        lines.push("");
    }

    const factsByCategory = new Map<string, string[]>();
    for (const f of facts) {
        const existing = factsByCategory.get(f.category) ?? [];
        existing.push(f.content);
        factsByCategory.set(f.category, existing);
    }

    for (const [category, items] of factsByCategory) {
        lines.push(`${category}:`);
        for (const item of items) {
            lines.push(`* ${escapeXmlContent(item)}`);
        }
        lines.push("");
    }

    if (notes.length > 0) {
        lines.push("SESSION_NOTES:");
        for (const note of notes) {
            lines.push(`* ${escapeXmlContent(note.content)}`);
        }
        lines.push("");
    }

    return lines.join("\n").trimEnd();
}

export function escapeXmlAttr(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export function escapeXmlContent(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
