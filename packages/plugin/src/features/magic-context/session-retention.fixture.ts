import { getHarness } from "../../shared/harness";
import type { Database } from "../../shared/sqlite";
import { recordMessageFtsRowid } from "./message-fts-rowid-map";
import { advanceSessionActivity } from "./session-activity";
import { writeSessionRenderCache } from "./storage-session-cache";
import { writeSessionMetaCollection } from "./storage-session-collections";

export function seedRetainedSession(db: Database, sessionId: string, updatedAt: number): void {
    const harness = getHarness();
    db.prepare(
        `INSERT INTO session_meta(session_id, harness, last_response_time) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET harness = excluded.harness,
             last_response_time = excluded.last_response_time`,
    ).run(sessionId, harness, updatedAt);
    writeSessionRenderCache(db, sessionId, "cached_m0_bytes", Buffer.from("Retained baseline"));
    writeSessionMetaCollection(db, sessionId, "memory_block_ids", "[1]");
    db.prepare("INSERT INTO tags(session_id, tag_number, harness) VALUES (?, 1, ?)").run(
        sessionId,
        harness,
    );
    db.prepare(
        "INSERT INTO source_contents(session_id, tag_id, content, created_at, harness) VALUES (?, 1, ?, ?, ?)",
    ).run(sessionId, "Original raw history that must remain recoverable", updatedAt, harness);
    const summary = db.prepare(`INSERT INTO compartments
        (session_id, sequence, start_message, end_message, title, content, created_at, harness)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 1; i <= 40; i++) {
        summary.run(
            sessionId,
            i,
            i,
            i,
            `Summary ${i}`,
            `Retained summary ${i}`,
            updatedAt,
            harness,
        );
    }
    db.prepare(`INSERT INTO message_history_index
        (session_id, last_indexed_ordinal, updated_at, harness) VALUES (?, 1, ?, ?)`).run(
        sessionId,
        updatedAt,
        harness,
    );
    db.prepare(`INSERT INTO message_history_source
        (session_id, message_id, message_ordinal, source_version, normalized_content_hash, role, harness, updated_at)
        VALUES (?, 'm1', 1, 'v1', 'raw-hash', 'user', ?, ?)`).run(sessionId, harness, updatedAt);
    const row = db
        .prepare(`INSERT INTO message_history_fts
        (session_id, message_ordinal, message_id, role, content) VALUES (?, 1, 'm1', 'user', ?)`)
        .run(sessionId, "Original searchable raw history");
    recordMessageFtsRowid(db, sessionId, 1, row.lastInsertRowid);
    advanceSessionActivity(db, sessionId, updatedAt);
}

export function snapshotSessionRows(db: Database, sessionId: string): Record<string, unknown[]> {
    const snapshot: Record<string, unknown[]> = {};
    const tables = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[];
    // Discover rows from the schema so the assertion also covers trigger-created
    // state and session tables added after this fixture was written.
    for (const { name } of tables) {
        const columns = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
        if (columns.some((column) => column.name === "session_id")) {
            snapshot[name] = db
                .prepare(`SELECT * FROM ${name} WHERE session_id = ?`)
                .all(sessionId);
        }
    }
    snapshot.sessionKeys = db
        .prepare("SELECT * FROM schema_migrations_meta WHERE instr(key, ?) > 0 ORDER BY key")
        .all(sessionId);
    return snapshot;
}
