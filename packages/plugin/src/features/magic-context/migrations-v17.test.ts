import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";

function createPreV17Db(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );
        INSERT INTO schema_migrations (version, description, applied_at)
        VALUES (16, 'pre-v17 fixture', 1);

        CREATE TABLE session_meta (
            session_id TEXT PRIMARY KEY,
            note_nudge_trigger_pending INTEGER DEFAULT 0,
            note_nudge_trigger_message_id TEXT DEFAULT '',
            note_nudge_sticky_text TEXT DEFAULT '',
            note_nudge_sticky_message_id TEXT DEFAULT ''
        );
    `);
    return db;
}

describe("migration v17 — sticky-injection multi-anchor storage", () => {
    test("backfills legacy note-nudge sticky tuple into one anchor", () => {
        const db = createPreV17Db();
        db.prepare(
            "INSERT INTO session_meta (session_id, note_nudge_sticky_text, note_nudge_sticky_message_id) VALUES (?, ?, ?)",
        ).run("ses-sticky", "nudge text", "msg-1");

        runMigrations(db);

        const row = db
            .prepare(
                "SELECT note_nudge_anchors, auto_search_hint_decisions FROM session_meta WHERE session_id = ?",
            )
            .get("ses-sticky") as {
            note_nudge_anchors: string;
            auto_search_hint_decisions: string;
        };
        expect(JSON.parse(row.note_nudge_anchors)).toEqual([
            { messageId: "msg-1", text: "nudge text" },
        ]);
        expect(row.auto_search_hint_decisions).toBe("[]");
        closeQuietly(db);
    });

    test("heals empty and null upgraded columns to empty arrays", () => {
        const db = createPreV17Db();
        db.exec("ALTER TABLE session_meta ADD COLUMN note_nudge_anchors TEXT");
        db.exec("ALTER TABLE session_meta ADD COLUMN auto_search_hint_decisions TEXT");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-null");

        runMigrations(db);

        const row = db
            .prepare(
                "SELECT note_nudge_anchors, auto_search_hint_decisions FROM session_meta WHERE session_id = ?",
            )
            .get("ses-null") as {
            note_nudge_anchors: string;
            auto_search_hint_decisions: string;
        };
        expect(row.note_nudge_anchors).toBe("[]");
        expect(row.auto_search_hint_decisions).toBe("[]");
        closeQuietly(db);
    });

    test("is idempotent after sibling-conflict resume", () => {
        const db = createPreV17Db();
        db.prepare(
            "INSERT INTO session_meta (session_id, note_nudge_sticky_text, note_nudge_sticky_message_id) VALUES (?, ?, ?)",
        ).run("ses-idempotent", "nudge text", "msg-1");

        runMigrations(db);
        db.prepare("DELETE FROM schema_migrations WHERE version = 17").run();
        runMigrations(db);

        const row = db
            .prepare("SELECT note_nudge_anchors FROM session_meta WHERE session_id = ?")
            .get("ses-idempotent") as { note_nudge_anchors: string };
        expect(JSON.parse(row.note_nudge_anchors)).toEqual([
            { messageId: "msg-1", text: "nudge text" },
        ]);
        closeQuietly(db);
    });

    test("column list includes sticky-injection columns", () => {
        const db = createPreV17Db();

        runMigrations(db);

        const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name: string }>;
        expect(cols.map((col) => col.name)).toEqual(
            expect.arrayContaining(["note_nudge_anchors", "auto_search_hint_decisions"]),
        );
        closeQuietly(db);
    });
});
