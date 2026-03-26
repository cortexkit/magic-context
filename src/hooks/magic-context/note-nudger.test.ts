/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { addSessionNote } from "../../features/magic-context/storage-notes";
import { clearNoteNudgeState, getNoteNudgeText, onNoteTrigger } from "./note-nudger";

const dbs: Database[] = [];

afterEach(() => {
    for (const db of dbs) {
        db.close(false);
    }
    dbs.length = 0;
    clearNoteNudgeState("ses-trigger");
    clearNoteNudgeState("ses-empty");
    clearNoteNudgeState("ses-clear");
});

function makeDb(): Database {
    const db = new Database(":memory:");
    db.run(`
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

describe("note-nudger", () => {
    it("fires after a trigger when notes exist, then suppresses until the next trigger", () => {
        const db = makeDb();
        addSessionNote(db, "ses-trigger", "Follow up later.");

        onNoteTrigger("ses-trigger", "historian_complete");

        expect(getNoteNudgeText(db, "ses-trigger")).toContain("You have 1 deferred note");
        expect(getNoteNudgeText(db, "ses-trigger")).toBeNull();

        onNoteTrigger("ses-trigger", "commit_detected");

        expect(getNoteNudgeText(db, "ses-trigger")).toContain("You have 1 deferred note");
    });

    it("returns null when no notes exist even if triggered", () => {
        const db = makeDb();

        onNoteTrigger("ses-empty", "todos_complete");

        expect(getNoteNudgeText(db, "ses-empty")).toBeNull();
    });

    it("clears session state so prior triggers no longer produce nudges", () => {
        const db = makeDb();
        addSessionNote(db, "ses-clear", "Circle back.");

        onNoteTrigger("ses-clear", "historian_complete");
        clearNoteNudgeState("ses-clear");

        expect(getNoteNudgeText(db, "ses-clear")).toBeNull();

        onNoteTrigger("ses-clear", "todos_complete");

        expect(getNoteNudgeText(db, "ses-clear")).toContain("You have 1 deferred note");
    });
});
