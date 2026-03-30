import type { Database } from "bun:sqlite";

export interface RawMessage {
    ordinal: number;
    id: string;
    role: string;
    parts: unknown[];
}

interface RawMessageRow {
    id: string;
    data: string;
}

interface RawPartRow {
    message_id: string;
    data: string;
}

function isRawMessageRow(row: unknown): row is RawMessageRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return typeof candidate.id === "string" && typeof candidate.data === "string";
}

function isRawPartRow(row: unknown): row is RawPartRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return typeof candidate.message_id === "string" && typeof candidate.data === "string";
}

function parseJsonRecord(value: string): Record<string, unknown> {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Expected JSON object");
    }
    return parsed as Record<string, unknown>;
}

function parseJsonUnknown(value: string): unknown {
    return JSON.parse(value);
}

export function readRawSessionMessagesFromDb(db: Database, sessionId: string): RawMessage[] {
    const messageRows = db
        .prepare(
            "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC",
        )
        .all(sessionId)
        .filter(isRawMessageRow);

    const partRows = db
        .prepare(
            "SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC",
        )
        .all(sessionId)
        .filter(isRawPartRow);

    const partsByMessageId = new Map<string, unknown[]>();
    for (const part of partRows) {
        const list = partsByMessageId.get(part.message_id) ?? [];
        list.push(parseJsonUnknown(part.data));
        partsByMessageId.set(part.message_id, list);
    }

    return messageRows.map((row, index) => {
        const info = parseJsonRecord(row.data);
        const role = typeof info.role === "string" ? info.role : "unknown";
        return {
            ordinal: index + 1,
            id: row.id,
            role,
            parts: partsByMessageId.get(row.id) ?? [],
        };
    });
}
