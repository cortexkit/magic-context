/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { addSessionNote } from "../../features/magic-context/storage-notes";
import {
    clearNoteNudgeState,
    getNoteNudgeText,
    getStickyNoteNudge,
    markNoteNudgeDelivered,
    onNoteTrigger,
    peekNoteNudgeText,
} from "./note-nudger";

const dbs: Database[] = [];

afterEach(() => {
    for (const db of dbs) {
        db.close(false);
    }
    dbs.length = 0;
});

function makeDb(): Database {
    const db = new Database(":memory:");
    db.run(`
        CREATE TABLE session_meta (
            session_id TEXT PRIMARY KEY,
            last_response_time INTEGER DEFAULT 0,
            cache_ttl TEXT DEFAULT '5m',
            counter INTEGER DEFAULT 0,
            last_nudge_tokens INTEGER DEFAULT 0,
            last_nudge_band TEXT DEFAULT '',
            last_transform_error TEXT DEFAULT '',
            is_subagent INTEGER DEFAULT 0,
            last_context_percentage REAL DEFAULT 0,
            last_input_tokens INTEGER DEFAULT 0,
            times_execute_threshold_reached INTEGER DEFAULT 0,
            compartment_in_progress INTEGER DEFAULT 0,
            system_prompt_hash TEXT DEFAULT '',
            note_nudge_trigger_pending INTEGER DEFAULT 0,
            note_nudge_trigger_message_id TEXT DEFAULT '',
            note_nudge_sticky_text TEXT DEFAULT '',
            note_nudge_sticky_message_id TEXT DEFAULT '',
            cleared_reasoning_through_tag INTEGER DEFAULT 0
        );

        CREATE TABLE session_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
    `);
    dbs.push(db);
    return db;
}

function getPersistedRow(db: Database, sessionId: string) {
    return db
        .prepare(
            "SELECT note_nudge_trigger_pending AS triggerPending, note_nudge_trigger_message_id AS triggerMessageId, note_nudge_sticky_text AS stickyText, note_nudge_sticky_message_id AS stickyMessageId FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as {
        triggerPending: number;
        triggerMessageId: string;
        stickyText: string;
        stickyMessageId: string;
    } | null;
}

describe("note-nudger", () => {
    it("persists trigger deferral and sticky delivery state in session_meta", () => {
        const db = makeDb();
        addSessionNote(db, "ses-trigger", "Follow up later.");

        onNoteTrigger(db, "ses-trigger", "historian_complete");

        expect(peekNoteNudgeText(db, "ses-trigger", "u-1")).toBeNull();
        expect(getPersistedRow(db, "ses-trigger")).toEqual({
            triggerPending: 1,
            triggerMessageId: "u-1",
            stickyText: "",
            stickyMessageId: "",
        });

        const text = peekNoteNudgeText(db, "ses-trigger", "u-2");
        expect(text).toContain("You have 1 deferred note");

        markNoteNudgeDelivered(db, "ses-trigger", text!, "u-2");

        expect(getPersistedRow(db, "ses-trigger")).toEqual({
            triggerPending: 0,
            triggerMessageId: "",
            stickyText: text,
            stickyMessageId: "u-2",
        });
        expect(getStickyNoteNudge(db, "ses-trigger")).toEqual({ text, messageId: "u-2" });
        expect(peekNoteNudgeText(db, "ses-trigger", "u-3")).toBeNull();
    });

    it("returns null when no notes exist even if triggered", () => {
        const db = makeDb();

        onNoteTrigger(db, "ses-empty", "todos_complete");

        expect(getNoteNudgeText(db, "ses-empty")).toBeNull();
    });

    it("clears persisted state so prior triggers and stickies no longer produce nudges", () => {
        const db = makeDb();
        addSessionNote(db, "ses-clear", "Circle back.");

        onNoteTrigger(db, "ses-clear", "historian_complete");
        const text = peekNoteNudgeText(db, "ses-clear", "u-2");
        markNoteNudgeDelivered(db, "ses-clear", text!, "u-2");

        clearNoteNudgeState(db, "ses-clear");

        expect(getPersistedRow(db, "ses-clear")).toEqual({
            triggerPending: 0,
            triggerMessageId: "",
            stickyText: "",
            stickyMessageId: "",
        });
        expect(getStickyNoteNudge(db, "ses-clear")).toBeNull();
        expect(getNoteNudgeText(db, "ses-clear")).toBeNull();

        onNoteTrigger(db, "ses-clear", "todos_complete");

        expect(getNoteNudgeText(db, "ses-clear")).toContain("You have 1 deferred note");
    });
});
