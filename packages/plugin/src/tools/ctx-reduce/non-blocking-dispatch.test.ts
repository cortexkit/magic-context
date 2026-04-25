import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { createCtxReduceTools } from "./tools";

function createDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY,
      message_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      drop_mode TEXT DEFAULT 'full',
      tool_name TEXT,
      input_byte_size INTEGER DEFAULT 0,
      byte_size INTEGER NOT NULL DEFAULT 0,
      session_id TEXT NOT NULL,
      tag_number INTEGER NOT NULL,
      reasoning_byte_size INTEGER NOT NULL DEFAULT 0,
      caveman_depth INTEGER NOT NULL DEFAULT 0,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
    CREATE TABLE pending_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tag_id INTEGER NOT NULL,
      operation TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
    CREATE TABLE source_contents (
      tag_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
            harness TEXT NOT NULL DEFAULT 'opencode',
      PRIMARY KEY (tag_id, session_id)
    );
    CREATE TABLE session_meta (
      session_id TEXT PRIMARY KEY,
      last_response_time INTEGER,
      cache_ttl TEXT,
      counter INTEGER DEFAULT 0,
      last_nudge_tokens INTEGER DEFAULT 0,
      last_nudge_band TEXT DEFAULT '',
      last_transform_error TEXT DEFAULT '',
      is_subagent INTEGER DEFAULT 0,
      last_context_percentage REAL DEFAULT 0,
      last_input_tokens INTEGER DEFAULT 0,
      times_execute_threshold_reached INTEGER DEFAULT 0,
      compartment_in_progress INTEGER DEFAULT 0,
      historian_failure_count INTEGER DEFAULT 0,
      historian_last_error TEXT DEFAULT NULL,
      historian_last_failure_at INTEGER DEFAULT NULL,
      system_prompt_hash INTEGER DEFAULT 0,
      system_prompt_tokens INTEGER DEFAULT 0,
      conversation_tokens INTEGER DEFAULT 0,
      tool_call_tokens INTEGER DEFAULT 0,
      cleared_reasoning_through_tag INTEGER DEFAULT 0,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
  `);
    return db;
}

function seedTag(db: Database, id: number, sessionId = "ses-1"): void {
    db.prepare(
        "INSERT INTO tags (id, message_id, type, status, byte_size, session_id, tag_number) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(id, `msg-${id}`, "message", "active", 100, sessionId, id);
}

describe("ctx_reduce drop queueing", () => {
    let db: Database;

    beforeEach(() => {
        db = createDb();
        seedTag(db, 1);
        seedTag(db, 2);
        seedTag(db, 8);
        seedTag(db, 9);
        seedTag(db, 10);
    });

    it("returns queued ack immediately and stores pending drops", async () => {
        const tools = createCtxReduceTools({
            db,
            protectedTags: 3,
        });

        const result = await tools.ctx_reduce.execute({ drop: "1,2" }, {
            sessionID: "ses-1",
        } as never);

        expect(result).toContain("Queued");
        const pendingCount = db
            .prepare("SELECT COUNT(*) AS count FROM pending_ops WHERE session_id = ?")
            .get("ses-1") as { count: number };
        expect(pendingCount.count).toBe(2);
    });
});
