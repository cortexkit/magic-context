import {
    cleanUserText,
    extractTexts,
    hasMeaningfulUserText,
} from "../../hooks/magic-context/read-session-chunk";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import { getHarness } from "../../shared/harness";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import { removeSystemReminders } from "../../shared/system-directive";
import { clearCompressionDepth } from "./compression-depth-storage";

interface MessageHistoryIndexRow {
    last_indexed_ordinal?: number;
}

const lastIndexedStatements = new WeakMap<Database, PreparedStatement>();
const insertMessageStatements = new WeakMap<Database, PreparedStatement>();
const upsertIndexStatements = new WeakMap<Database, PreparedStatement>();
const deleteFtsStatements = new WeakMap<Database, PreparedStatement>();
const deleteIndexStatements = new WeakMap<Database, PreparedStatement>();
const countIndexedMessageStatements = new WeakMap<Database, PreparedStatement>();

function normalizeIndexText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function getLastIndexedStatement(db: Database): PreparedStatement {
    let stmt = lastIndexedStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT last_indexed_ordinal FROM message_history_index WHERE session_id = ?",
        );
        lastIndexedStatements.set(db, stmt);
    }
    return stmt;
}

function getInsertMessageStatement(db: Database): PreparedStatement {
    let stmt = insertMessageStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
        );
        insertMessageStatements.set(db, stmt);
    }
    return stmt;
}

function getUpsertIndexStatement(db: Database): PreparedStatement {
    let stmt = upsertIndexStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO message_history_index (session_id, last_indexed_ordinal, updated_at, harness) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET last_indexed_ordinal = excluded.last_indexed_ordinal, updated_at = excluded.updated_at",
        );
        upsertIndexStatements.set(db, stmt);
    }
    return stmt;
}

function getDeleteFtsStatement(db: Database): PreparedStatement {
    let stmt = deleteFtsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("DELETE FROM message_history_fts WHERE session_id = ?");
        deleteFtsStatements.set(db, stmt);
    }
    return stmt;
}

function getDeleteIndexStatement(db: Database): PreparedStatement {
    let stmt = deleteIndexStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("DELETE FROM message_history_index WHERE session_id = ?");
        deleteIndexStatements.set(db, stmt);
    }
    return stmt;
}

function getCountIndexedMessageStatement(db: Database): PreparedStatement {
    let stmt = countIndexedMessageStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT COUNT(*) AS count FROM message_history_fts WHERE session_id = ? AND message_id = ?",
        );
        countIndexedMessageStatements.set(db, stmt);
    }
    return stmt;
}

interface CountRow {
    count: number;
}

function getLastIndexedOrdinal(db: Database, sessionId: string): number {
    const row = getLastIndexedStatement(db).get(sessionId) as MessageHistoryIndexRow | null;
    return typeof row?.last_indexed_ordinal === "number" ? row.last_indexed_ordinal : 0;
}

export function deleteIndexedMessage(db: Database, sessionId: string, messageId: string): number {
    const row = getCountIndexedMessageStatement(db).get(sessionId, messageId) as CountRow | null;
    const count = typeof row?.count === "number" ? row.count : 0;

    // Full reindex on next search: ordinals are positional (not stable IDs), so removing
    // a message shifts all subsequent ordinals. Keeping a stale tracker would cause
    // ensureMessagesIndexed() to skip newly added messages when the count matches.
    // Clearing both FTS rows and the tracker forces a complete rebuild on next search.
    clearIndexedMessages(db, sessionId);
    return count;
}

export function clearIndexedMessages(db: Database, sessionId: string): void {
    db.transaction(() => {
        getDeleteFtsStatement(db).run(sessionId);
        getDeleteIndexStatement(db).run(sessionId);
        clearCompressionDepth(db, sessionId);
    })();
}

function getIndexableContent(role: string, parts: unknown[]): string {
    if (role === "user") {
        if (!hasMeaningfulUserText(parts)) {
            return "";
        }

        return extractTexts(parts)
            .map(cleanUserText)
            .map(normalizeIndexText)
            .filter((text) => text.length > 0)
            .join(" / ");
    }

    if (role === "assistant") {
        return extractTexts(parts)
            .map(removeSystemReminders)
            .map(normalizeIndexText)
            .filter((text) => text.length > 0)
            .join(" / ");
    }

    return "";
}

export function ensureMessagesIndexed(
    db: Database,
    sessionId: string,
    readMessages: (sessionId: string) => RawMessage[],
): void {
    const messages = readMessages(sessionId);

    if (messages.length === 0) {
        db.transaction(() => clearIndexedMessages(db, sessionId))();
        return;
    }

    let lastIndexedOrdinal = getLastIndexedOrdinal(db, sessionId);
    if (lastIndexedOrdinal > messages.length) {
        db.transaction(() => clearIndexedMessages(db, sessionId))();
        lastIndexedOrdinal = 0;
    }

    if (lastIndexedOrdinal >= messages.length) {
        return;
    }

    const messagesToInsert = messages
        .filter((message) => message.ordinal > lastIndexedOrdinal)
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({
            ordinal: message.ordinal,
            id: message.id,
            role: message.role,
            content: getIndexableContent(message.role, message.parts),
        }))
        .filter((message) => message.content.length > 0);

    const now = Date.now();
    db.transaction(() => {
        const insertMessage = getInsertMessageStatement(db);
        for (const message of messagesToInsert) {
            insertMessage.run(
                sessionId,
                message.ordinal,
                message.id,
                message.role,
                message.content,
            );
        }

        getUpsertIndexStatement(db).run(sessionId, messages.length, now, getHarness());
    })();
}
