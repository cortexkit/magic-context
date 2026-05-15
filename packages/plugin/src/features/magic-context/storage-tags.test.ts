/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    getActiveTagsBySession,
    getMaxDroppedTagNumber,
    getTagById,
    getTagsByNumbers,
    getTagsBySession,
    getTopNBySize,
    insertTag,
    updateTagDropMode,
    updateTagStatus,
} from "./storage-tags";

let db: Database;

function makeMemoryDatabase(): Database {
    const d = new Database(":memory:");
    d.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      message_id TEXT,
      type TEXT,
      status TEXT DEFAULT 'active',
      drop_mode TEXT DEFAULT 'full',
      tool_name TEXT,
      input_byte_size INTEGER DEFAULT 0,
      byte_size INTEGER,
      tag_number INTEGER NOT NULL,
      reasoning_byte_size INTEGER NOT NULL DEFAULT 0,
      caveman_depth INTEGER NOT NULL DEFAULT 0,
            harness TEXT NOT NULL DEFAULT 'opencode',
      tool_owner_message_id TEXT DEFAULT NULL,
      UNIQUE(session_id, id)
    );
    CREATE TABLE IF NOT EXISTS pending_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tag_id INTEGER,
      operation TEXT,
      queued_at INTEGER,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
    CREATE TABLE IF NOT EXISTS session_meta (
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
      observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_alert_sent INTEGER NOT NULL DEFAULT 0,
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
    return d;
}

afterEach(() => {
    if (db) closeQuietly(db);
});

describe("storage-tags", () => {
    describe("#given insertTag", () => {
        it("#when inserting a valid tag #then returns the row id", () => {
            db = makeMemoryDatabase();
            const id = insertTag(db, "ses-1", "msg-1", "message", 100, 1);

            expect(id).toBe(1);
            expect(typeof id).toBe("number");
        });

        it("#when inserting multiple tags #then returns incrementing ids", () => {
            db = makeMemoryDatabase();
            const id1 = insertTag(db, "ses-1", "msg-1", "message", 100, 1);
            const id2 = insertTag(db, "ses-1", "msg-2", "tool", 200, 2);

            expect(id1).toBe(1);
            expect(id2).toBe(2);
        });
    });

    describe("#given updateTagStatus", () => {
        it("#when updating status #then persists the new status", () => {
            db = makeMemoryDatabase();
            const id = insertTag(db, "ses-1", "msg-1", "message", 100, 1);

            updateTagStatus(db, "ses-1", id, "dropped");

            const tag = getTagById(db, "ses-1", id);
            expect(tag?.status).toBe("dropped");
        });
    });

    describe("#given getTagsBySession", () => {
        it("#when session has tags #then returns all tags ordered by id", () => {
            db = makeMemoryDatabase();
            insertTag(db, "ses-1", "msg-1", "message", 100, 1);
            insertTag(db, "ses-1", "msg-2", "tool", 200, 2);

            const tags = getTagsBySession(db, "ses-1");

            expect(tags).toHaveLength(2);
            expect(tags[0].messageId).toBe("msg-1");
            expect(tags[0].type).toBe("message");
            expect(tags[0].dropMode).toBe("full");
            expect(tags[0].toolName).toBeNull();
            expect(tags[0].inputByteSize).toBe(0);
            expect(tags[1].messageId).toBe("msg-2");
            expect(tags[1].type).toBe("tool");
        });

        it("#when session has no tags #then returns empty array", () => {
            db = makeMemoryDatabase();
            const tags = getTagsBySession(db, "nonexistent");
            expect(tags).toEqual([]);
        });

        it("#when row has NULL message_id #then filters it out via isTagRow", () => {
            db = makeMemoryDatabase();
            insertTag(db, "ses-1", "msg-1", "message", 100, 1);
            db.prepare(
                "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, NULL, ?, ?, ?)",
            ).run("ses-1", "message", 200, 99);

            const tags = getTagsBySession(db, "ses-1");

            expect(tags).toHaveLength(1);
            expect(tags[0].messageId).toBe("msg-1");
        });

        it("#when tags span multiple sessions #then only returns matching session", () => {
            db = makeMemoryDatabase();
            insertTag(db, "ses-1", "msg-1", "message", 100, 1);
            insertTag(db, "ses-2", "msg-2", "tool", 200, 1);

            const tags = getTagsBySession(db, "ses-1");

            expect(tags).toHaveLength(1);
            expect(tags[0].sessionId).toBe("ses-1");
        });
    });

    describe("#given getTagById", () => {
        it("#when tag exists #then returns the tag entry", () => {
            db = makeMemoryDatabase();
            const id = insertTag(db, "ses-1", "msg-1", "message", 150, 1);

            const tag = getTagById(db, "ses-1", id);

            expect(tag).not.toBeNull();
            expect(tag?.tagNumber).toBe(id);
            expect(tag?.messageId).toBe("msg-1");
            expect(tag?.byteSize).toBe(150);
        });

        it("#when tag does not exist #then returns null", () => {
            db = makeMemoryDatabase();
            const tag = getTagById(db, "ses-1", 999);
            expect(tag).toBeNull();
        });

        it("#when tag exists in different session #then returns null", () => {
            db = makeMemoryDatabase();
            const id = insertTag(db, "ses-1", "msg-1", "message", 100, 1);

            const tag = getTagById(db, "ses-2", id);

            expect(tag).toBeNull();
        });
    });

    describe("#given getTopNBySize", () => {
        it("#when n > 0 #then returns top N tags by byte_size descending", () => {
            db = makeMemoryDatabase();
            insertTag(db, "ses-1", "msg-1", "message", 100, 1);
            insertTag(db, "ses-1", "msg-2", "tool", 500, 2);
            insertTag(db, "ses-1", "msg-3", "message", 300, 3);

            const top = getTopNBySize(db, "ses-1", 2);

            expect(top).toHaveLength(2);
            expect(top[0].byteSize).toBe(500);
            expect(top[1].byteSize).toBe(300);
        });

        it("#when n <= 0 #then returns empty array", () => {
            db = makeMemoryDatabase();
            insertTag(db, "ses-1", "msg-1", "message", 100, 1);

            expect(getTopNBySize(db, "ses-1", 0)).toEqual([]);
            expect(getTopNBySize(db, "ses-1", -1)).toEqual([]);
        });

        it("#when tags have non-active status #then only returns active tags", () => {
            db = makeMemoryDatabase();
            const active = insertTag(db, "ses-1", "msg-1", "message", 500, 1);
            const dropped = insertTag(db, "ses-1", "msg-2", "tool", 300, 2);
            const compacted = insertTag(db, "ses-1", "msg-3", "message", 200, 3);
            updateTagStatus(db, "ses-1", dropped, "dropped");
            updateTagStatus(db, "ses-1", compacted, "compacted");

            const top = getTopNBySize(db, "ses-1", 10);

            expect(top).toHaveLength(1);
            expect(top[0].tagNumber).toBe(active);
            expect(top[0].status).toBe("active");
        });

        it("#when no active tags exist #then returns empty array", () => {
            db = makeMemoryDatabase();
            const id = insertTag(db, "ses-1", "msg-1", "message", 100, 1);
            updateTagStatus(db, "ses-1", id, "dropped");

            const top = getTopNBySize(db, "ses-1", 10);

            expect(top).toEqual([]);
        });
    });

    describe("#given toTagEntry normalization", () => {
        it("#when type is not 'tool' #then normalizes to 'message'", () => {
            db = makeMemoryDatabase();
            db.prepare(
                "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, ?, ?, ?)",
            ).run("ses-1", "msg-1", "unknown-type", 100, 1);

            const tags = getTagsBySession(db, "ses-1");

            expect(tags).toHaveLength(1);
            expect(tags[0].type).toBe("message");
        });

        it("#when status is unknown #then normalizes to 'active'", () => {
            db = makeMemoryDatabase();
            insertTag(db, "ses-1", "msg-1", "message", 100, 1);
            db.prepare("UPDATE tags SET status = ? WHERE session_id = ? AND tag_number = ?").run(
                "some-unknown-status",
                "ses-1",
                1,
            );

            const tag = getTagById(db, "ses-1", 1);

            expect(tag?.status).toBe("active");
        });

        it("#when status is 'compacted' or 'dropped' #then preserves it", () => {
            db = makeMemoryDatabase();
            const id1 = insertTag(db, "ses-1", "msg-1", "message", 100, 1);
            const id2 = insertTag(db, "ses-1", "msg-2", "message", 200, 2);
            updateTagStatus(db, "ses-1", id1, "compacted");
            updateTagStatus(db, "ses-1", id2, "dropped");

            const tags = getTagsBySession(db, "ses-1");

            const s = tags.find((t) => t.tagNumber === id1);
            const d = tags.find((t) => t.tagNumber === id2);
            expect(s?.status).toBe("compacted");
            expect(d?.status).toBe("dropped");
        });

        it("#when drop_mode is NULL #then normalizes to full", () => {
            db = makeMemoryDatabase();
            db.prepare(
                "INSERT INTO tags (session_id, message_id, type, status, drop_mode, byte_size, tag_number) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ).run("ses-1", "msg-1", "tool", "dropped", null, 100, 1);

            const tag = getTagById(db, "ses-1", 1);

            expect(tag?.dropMode).toBe("full");
        });

        it("#when tool metadata is stored #then returns toolName and inputByteSize", () => {
            db = makeMemoryDatabase();
            insertTag(db, "ses-1", "call-1", "tool", 100, 1, 0, "read", 321);
            updateTagDropMode(db, "ses-1", 1, "truncated");

            const tag = getTagById(db, "ses-1", 1);

            expect(tag?.dropMode).toBe("truncated");
            expect(tag?.toolName).toBe("read");
            expect(tag?.inputByteSize).toBe(321);
        });
    });

    // P0 perf: targeted helpers for the hot transform path.
    // Each test asserts a) the new helper returns an equivalent slice
    // of getTagsBySession, b) it filters correctly when dropped/compacted
    // tags exist alongside active ones, and c) it never silently
    // mis-translates fields (status, type, dropMode, etc).

    describe("#given getActiveTagsBySession", () => {
        it("#when session has mixed statuses #then returns only active rows", () => {
            db = makeMemoryDatabase();
            const a1 = insertTag(db, "ses-1", "msg-1", "message", 100, 1);
            const a2 = insertTag(db, "ses-1", "msg-2", "tool", 200, 2);
            const d = insertTag(db, "ses-1", "msg-3", "message", 300, 3);
            const c = insertTag(db, "ses-1", "msg-4", "tool", 400, 4);
            updateTagStatus(db, "ses-1", d, "dropped");
            updateTagStatus(db, "ses-1", c, "compacted");

            const active = getActiveTagsBySession(db, "ses-1");

            expect(active).toHaveLength(2);
            expect(active.map((t) => t.tagNumber).sort((a, b) => a - b)).toEqual([a1, a2]);
            expect(active.every((t) => t.status === "active")).toBe(true);
        });

        it("#when session has no active tags #then returns empty array", () => {
            db = makeMemoryDatabase();
            const id = insertTag(db, "ses-1", "msg-1", "message", 100, 1);
            updateTagStatus(db, "ses-1", id, "dropped");

            expect(getActiveTagsBySession(db, "ses-1")).toEqual([]);
        });

        it("#when session is unknown #then returns empty array", () => {
            db = makeMemoryDatabase();
            insertTag(db, "ses-1", "msg-1", "message", 100, 1);

            expect(getActiveTagsBySession(db, "unknown")).toEqual([]);
        });

        it("#when ordering by tag_number #then result is ascending", () => {
            db = makeMemoryDatabase();
            insertTag(db, "ses-1", "msg-c", "message", 300, 7);
            insertTag(db, "ses-1", "msg-a", "message", 100, 3);
            insertTag(db, "ses-1", "msg-b", "tool", 200, 5);

            const active = getActiveTagsBySession(db, "ses-1");

            expect(active.map((t) => t.tagNumber)).toEqual([3, 5, 7]);
        });

        it("#when result must match getTagsBySession-active-filter exactly #then equivalent", () => {
            db = makeMemoryDatabase();
            insertTag(db, "ses-1", "msg-1", "message", 100, 1);
            insertTag(db, "ses-1", "msg-2", "tool", 200, 2);
            const d = insertTag(db, "ses-1", "msg-3", "tool", 300, 3, 0, "read", 50);
            updateTagStatus(db, "ses-1", d, "dropped");

            const fromHelper = getActiveTagsBySession(db, "ses-1");
            const fromFull = getTagsBySession(db, "ses-1").filter((t) => t.status === "active");

            expect(fromHelper).toEqual(fromFull);
        });
    });

    describe("#given getTagsByNumbers", () => {
        it("#when tagNumbers is empty #then returns empty array without hitting SQL", () => {
            db = makeMemoryDatabase();
            insertTag(db, "ses-1", "msg-1", "message", 100, 1);

            expect(getTagsByNumbers(db, "ses-1", [])).toEqual([]);
        });

        it("#when tagNumbers match #then returns those rows regardless of status", () => {
            db = makeMemoryDatabase();
            insertTag(db, "ses-1", "msg-1", "message", 100, 1);
            const d = insertTag(db, "ses-1", "msg-2", "tool", 200, 2);
            insertTag(db, "ses-1", "msg-3", "message", 300, 3);
            updateTagStatus(db, "ses-1", d, "dropped");

            const slice = getTagsByNumbers(db, "ses-1", [1, 2]);

            expect(slice).toHaveLength(2);
            expect(slice.find((t) => t.tagNumber === 1)?.status).toBe("active");
            expect(slice.find((t) => t.tagNumber === 2)?.status).toBe("dropped");
        });

        it("#when tagNumbers contain unknown ids #then silently skips them", () => {
            db = makeMemoryDatabase();
            insertTag(db, "ses-1", "msg-1", "message", 100, 1);

            const slice = getTagsByNumbers(db, "ses-1", [1, 999, 1000]);

            expect(slice).toHaveLength(1);
            expect(slice[0].tagNumber).toBe(1);
        });

        it("#when tagNumbers exist in another session #then never returned", () => {
            db = makeMemoryDatabase();
            insertTag(db, "ses-1", "msg-1", "message", 100, 1);
            insertTag(db, "ses-2", "msg-2", "message", 200, 1);

            const slice = getTagsByNumbers(db, "ses-1", [1]);

            expect(slice).toHaveLength(1);
            expect(slice[0].sessionId).toBe("ses-1");
        });

        it("#when list exceeds 900 entries #then chunks transparently", () => {
            db = makeMemoryDatabase();
            // SQLite parameter limit is 999. Helper chunks at 900.
            // Insert 1500 tags and request all 1500 numbers in one call.
            for (let i = 1; i <= 1500; i++) {
                insertTag(db, "ses-1", `msg-${i}`, "message", 10, i);
            }
            const tagNumbers = Array.from({ length: 1500 }, (_, i) => i + 1);

            const slice = getTagsByNumbers(db, "ses-1", tagNumbers);

            expect(slice).toHaveLength(1500);
            // Sanity: returned tag numbers exactly match the requested set.
            expect(new Set(slice.map((t) => t.tagNumber))).toEqual(new Set(tagNumbers));
        });

        it("#when result must match the targets-filtered slice #then equivalent to getTagsBySession", () => {
            db = makeMemoryDatabase();
            insertTag(db, "ses-1", "msg-1", "message", 100, 1);
            const d = insertTag(db, "ses-1", "msg-2", "tool", 200, 2, 0, "read", 50);
            insertTag(db, "ses-1", "msg-3", "message", 300, 3);
            updateTagStatus(db, "ses-1", d, "dropped");
            updateTagDropMode(db, "ses-1", d, "truncated");

            const targetNumbers = [1, 2];
            const fromHelper = getTagsByNumbers(db, "ses-1", targetNumbers);
            const fromFull = getTagsBySession(db, "ses-1").filter((t) =>
                targetNumbers.includes(t.tagNumber),
            );

            // Order matches by ORDER BY tag_number ASC, id ASC in both.
            expect(fromHelper).toEqual(fromFull);
        });
    });

    describe("#given getMaxDroppedTagNumber", () => {
        it("#when no dropped tags exist #then returns 0", () => {
            db = makeMemoryDatabase();
            insertTag(db, "ses-1", "msg-1", "message", 100, 1);
            insertTag(db, "ses-1", "msg-2", "tool", 200, 2);

            expect(getMaxDroppedTagNumber(db, "ses-1")).toBe(0);
        });

        it("#when one dropped tag exists #then returns its tag_number", () => {
            db = makeMemoryDatabase();
            const id = insertTag(db, "ses-1", "msg-1", "message", 100, 5);
            updateTagStatus(db, "ses-1", id, "dropped");

            expect(getMaxDroppedTagNumber(db, "ses-1")).toBe(5);
        });

        it("#when multiple dropped tags exist #then returns the maximum tag_number", () => {
            db = makeMemoryDatabase();
            const a = insertTag(db, "ses-1", "msg-a", "tool", 100, 3);
            const b = insertTag(db, "ses-1", "msg-b", "tool", 100, 7);
            const c = insertTag(db, "ses-1", "msg-c", "tool", 100, 5);
            updateTagStatus(db, "ses-1", a, "dropped");
            updateTagStatus(db, "ses-1", b, "dropped");
            updateTagStatus(db, "ses-1", c, "dropped");

            expect(getMaxDroppedTagNumber(db, "ses-1")).toBe(7);
        });

        it("#when active and compacted tags have higher numbers #then they're ignored", () => {
            db = makeMemoryDatabase();
            // tag_number 3 dropped, tag_number 5 active, tag_number 7 compacted
            const a = insertTag(db, "ses-1", "msg-a", "tool", 100, 3);
            insertTag(db, "ses-1", "msg-b", "message", 200, 5);
            const c = insertTag(db, "ses-1", "msg-c", "tool", 100, 7);
            updateTagStatus(db, "ses-1", a, "dropped");
            updateTagStatus(db, "ses-1", c, "compacted");

            // The MAX over status='dropped' is 3, not 5 or 7.
            expect(getMaxDroppedTagNumber(db, "ses-1")).toBe(3);
        });

        it("#when dropped tags belong to other sessions #then they're ignored", () => {
            db = makeMemoryDatabase();
            const a = insertTag(db, "ses-1", "msg-a", "tool", 100, 3);
            const b = insertTag(db, "ses-2", "msg-b", "tool", 100, 99);
            updateTagStatus(db, "ses-1", a, "dropped");
            updateTagStatus(db, "ses-2", b, "dropped");

            expect(getMaxDroppedTagNumber(db, "ses-1")).toBe(3);
            expect(getMaxDroppedTagNumber(db, "ses-2")).toBe(99);
        });

        it("#when result must match the for-loop watermark #then equivalent", () => {
            db = makeMemoryDatabase();
            const a = insertTag(db, "ses-1", "msg-a", "tool", 100, 3);
            const b = insertTag(db, "ses-1", "msg-b", "tool", 100, 7);
            insertTag(db, "ses-1", "msg-c", "message", 200, 12);
            updateTagStatus(db, "ses-1", a, "dropped");
            updateTagStatus(db, "ses-1", b, "dropped");

            const fromHelper = getMaxDroppedTagNumber(db, "ses-1");
            // Reproduce the exact watermark loop the new helper replaces.
            let watermark = 0;
            for (const tag of getTagsBySession(db, "ses-1")) {
                if (tag.status === "dropped" && tag.tagNumber > watermark) {
                    watermark = tag.tagNumber;
                }
            }

            expect(fromHelper).toBe(watermark);
        });
    });
});
