import type { Database } from "bun:sqlite";
import type { TagEntry } from "./types";

type PreparedStatement = ReturnType<Database["prepare"]>;

const insertTagStatements = new WeakMap<Database, PreparedStatement>();

function getInsertTagStatement(db: Database): PreparedStatement {
    let stmt = insertTagStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, ?, ?, ?)",
        );
        insertTagStatements.set(db, stmt);
    }
    return stmt;
}

interface TagRow {
    id: number;
    message_id: string;
    type: string;
    status: string;
    byte_size: number;
    session_id: string;
    tag_number: number;
}

function isTagRow(row: unknown): row is TagRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.id === "number" &&
        typeof r.message_id === "string" &&
        typeof r.type === "string" &&
        typeof r.status === "string" &&
        typeof r.byte_size === "number" &&
        typeof r.session_id === "string" &&
        typeof r.tag_number === "number"
    );
}

function toTagEntry(row: TagRow): TagEntry {
    const type = row.type === "tool" ? "tool" : row.type === "file" ? "file" : "message";
    const status = row.status === "dropped" || row.status === "compacted" ? row.status : "active";

    return {
        tagNumber: row.tag_number,
        messageId: row.message_id,
        type,
        status,
        byteSize: row.byte_size,
        sessionId: row.session_id,
    };
}

export function insertTag(
    db: Database,
    sessionId: string,
    messageId: string,
    type: TagEntry["type"],
    byteSize: number,
    tagNumber: number,
): number {
    getInsertTagStatement(db).run(sessionId, messageId, type, byteSize, tagNumber);

    return tagNumber;
}

export function updateTagStatus(
    db: Database,
    sessionId: string,
    tagId: number,
    status: TagEntry["status"],
): void {
    db.prepare("UPDATE tags SET status = ? WHERE session_id = ? AND tag_number = ?").run(
        status,
        sessionId,
        tagId,
    );
}

export function updateTagMessageId(
    db: Database,
    sessionId: string,
    tagId: number,
    messageId: string,
): void {
    db.prepare("UPDATE tags SET message_id = ? WHERE session_id = ? AND tag_number = ?").run(
        messageId,
        sessionId,
        tagId,
    );
}

export function getTagsBySession(db: Database, sessionId: string): TagEntry[] {
    const rows = db
        .prepare(
            "SELECT id, message_id, type, status, byte_size, session_id, tag_number FROM tags WHERE session_id = ? ORDER BY tag_number ASC, id ASC",
        )
        .all(sessionId)
        .filter(isTagRow);

    return rows.map(toTagEntry);
}

export function getTagById(db: Database, sessionId: string, tagId: number): TagEntry | null {
    const result = db
        .prepare(
            "SELECT id, message_id, type, status, byte_size, session_id, tag_number FROM tags WHERE session_id = ? AND tag_number = ?",
        )
        .get(sessionId, tagId);

    if (!isTagRow(result)) {
        return null;
    }

    return toTagEntry(result);
}

export function getTopNBySize(db: Database, sessionId: string, n: number): TagEntry[] {
    if (n <= 0) {
        return [];
    }

    const rows = db
        .prepare(
            "SELECT id, message_id, type, status, byte_size, session_id, tag_number FROM tags WHERE session_id = ? AND status = 'active' ORDER BY byte_size DESC, tag_number ASC LIMIT ?",
        )
        .all(sessionId, n)
        .filter(isTagRow);

    return rows.map(toTagEntry);
}
