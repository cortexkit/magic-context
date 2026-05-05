import type { Database } from "../../shared/sqlite";

export interface RawMessage {
    ordinal: number;
    id: string;
    role: string;
    parts: unknown[];
}

interface RawMessageRow {
    id: string;
    data: string;
    time_created?: number;
}

interface RawPartRow {
    message_id: string;
    data: string;
}

interface OrdinalRow {
    ordinal?: number;
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

function parseJsonRecord(value: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(value);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

function parseJsonUnknown(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
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

    // Filter out compaction summary messages injected by magic-context.
    // These exist only for OpenCode's filterCompacted boundary and must not
    // be visible to historian, trigger evaluation, FTS indexing, or ctx_expand.
    const filtered = messageRows.filter((row) => {
        const info = parseJsonRecord(row.data);
        return !(info?.summary === true && info?.finish === "stop");
    });

    return filtered.flatMap((row, index) => {
        const info = parseJsonRecord(row.data);
        if (!info) return [];
        const role = typeof info.role === "string" ? info.role : "unknown";
        return {
            ordinal: index + 1,
            id: row.id,
            role,
            parts: partsByMessageId.get(row.id) ?? [],
        };
    });
}

export function readRawSessionMessageByIdFromDb(
    db: Database,
    sessionId: string,
    messageId: string,
): RawMessage | null {
    const row = db
        .prepare("SELECT id, data, time_created FROM message WHERE session_id = ? AND id = ?")
        .get(sessionId, messageId) as RawMessageRow | null;
    if (!row || !isRawMessageRow(row) || typeof row.time_created !== "number") {
        return null;
    }

    const info = parseJsonRecord(row.data);
    if (!info || (info.summary === true && info.finish === "stop")) {
        return null;
    }

    const ordinalRow = db
        .prepare(
            `SELECT COUNT(*) AS ordinal FROM message
             WHERE session_id = ?
               AND NOT (COALESCE(json_extract(data, '$.summary'), 0) = 1
                        AND COALESCE(json_extract(data, '$.finish'), '') = 'stop')
               AND (time_created < ? OR (time_created = ? AND id <= ?))`,
        )
        .get(sessionId, row.time_created, row.time_created, messageId) as OrdinalRow | null;
    const ordinal = typeof ordinalRow?.ordinal === "number" ? ordinalRow.ordinal : 0;
    if (ordinal <= 0) {
        return null;
    }

    const partRows = db
        .prepare(
            "SELECT message_id, data FROM part WHERE session_id = ? AND message_id = ? ORDER BY time_created ASC, id ASC",
        )
        .all(sessionId, messageId)
        .filter(isRawPartRow);

    const role = typeof info.role === "string" ? info.role : "unknown";
    return {
        ordinal,
        id: row.id,
        role,
        parts: partRows.map((part) => parseJsonUnknown(part.data)),
    };
}
