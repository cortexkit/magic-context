import { getHarness } from "../../shared/harness";
import type { Database } from "../../shared/sqlite";

interface SourceContentRow {
    tag_id: number;
    content: string;
}

function isSourceContentRow(row: unknown): row is SourceContentRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.tag_id === "number" && typeof r.content === "string";
}

export function saveSourceContent(
    db: Database,
    sessionId: string,
    tagId: number,
    content: string,
): void {
    db.prepare(
        "INSERT OR IGNORE INTO source_contents (tag_id, session_id, content, created_at, harness) VALUES (?, ?, ?, ?, ?)",
    ).run(tagId, sessionId, content, Date.now(), getHarness());
}

export function replaceSourceContent(
    db: Database,
    sessionId: string,
    tagId: number,
    content: string,
): void {
    db.prepare(
        `INSERT INTO source_contents (tag_id, session_id, content, created_at, harness)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id, tag_id)
     DO UPDATE SET content = excluded.content, created_at = excluded.created_at`,
    ).run(tagId, sessionId, content, Date.now(), getHarness());
}

export function getSourceContents(
    db: Database,
    sessionId: string,
    tagIds: number[],
): Map<number, string> {
    if (tagIds.length === 0) {
        return new Map();
    }

    const placeholders = tagIds.map(() => "?").join(", ");
    const rows = db
        .prepare(
            `SELECT tag_id, content FROM source_contents WHERE session_id = ? AND tag_id IN (${placeholders})`,
        )
        .all(sessionId, ...tagIds)
        .filter(isSourceContentRow);

    const sources = new Map<number, string>();
    for (const row of rows) {
        sources.set(row.tag_id, row.content);
    }

    return sources;
}
