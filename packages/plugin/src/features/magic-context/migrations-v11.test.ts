/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "./storage";
import {
    clearPersistedTodoSyntheticAnchor,
    getPersistedTodoSyntheticAnchor,
    setPersistedTodoSyntheticAnchor,
} from "./storage-meta-persisted";

const TODO_COLUMNS = [
    "last_todo_state",
    "todo_synthetic_call_id",
    "todo_synthetic_anchor_message_id",
    "todo_synthetic_state_json",
];

const tempDirs: string[] = [];

function useTempDataHome(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    return dir;
}

afterEach(() => {
    closeDatabase();
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            // Ignore EBUSY on Windows where closeDatabase doesn't synchronously release locks
        }
    }
    tempDirs.length = 0;
    process.env.XDG_DATA_HOME = undefined;
});

describe("migration v11 — todo state synthesis schema", () => {
    test("fresh database has all three todo columns", () => {
        useTempDataHome("v11-fresh-");
        const db = openDatabase();
        const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name: string }>;
        const names = new Set(cols.map((c) => c.name));
        for (const col of TODO_COLUMNS) {
            expect(names.has(col)).toBe(true);
        }
    });

    test("session_meta read/write round-trips lastTodoState", () => {
        useTempDataHome("v11-snapshot-");
        const db = openDatabase();
        // ensureSessionMetaRow happens implicitly via storage helpers
        db.prepare(
            "INSERT INTO session_meta (session_id, last_todo_state) VALUES ('ses-1', '[]')",
        ).run();
        const row = db
            .prepare("SELECT last_todo_state FROM session_meta WHERE session_id = ?")
            .get("ses-1") as { last_todo_state: string };
        expect(row.last_todo_state).toBe("[]");
    });

    test("getPersistedTodoSyntheticAnchor returns null when unset", () => {
        useTempDataHome("v11-anchor-empty-");
        const db = openDatabase();
        expect(getPersistedTodoSyntheticAnchor(db, "ses-empty")).toBeNull();
    });

    test("setPersistedTodoSyntheticAnchor / get round-trip", () => {
        useTempDataHome("v11-anchor-rw-");
        const db = openDatabase();
        const stateJson = '[{"content":"x","status":"pending","priority":"high"}]';
        setPersistedTodoSyntheticAnchor(
            db,
            "ses-rw",
            "mc_synthetic_todo_abc123def456789a",
            "msg-asst-42",
            stateJson,
        );
        const got = getPersistedTodoSyntheticAnchor(db, "ses-rw");
        expect(got).toEqual({
            callId: "mc_synthetic_todo_abc123def456789a",
            messageId: "msg-asst-42",
            stateJson,
        });
    });

    test("clearPersistedTodoSyntheticAnchor resets the anchor", () => {
        useTempDataHome("v11-anchor-clear-");
        const db = openDatabase();
        setPersistedTodoSyntheticAnchor(db, "ses-clear", "mc_synthetic_todo_x", "msg-1", "[]");
        clearPersistedTodoSyntheticAnchor(db, "ses-clear");
        expect(getPersistedTodoSyntheticAnchor(db, "ses-clear")).toBeNull();
    });

    test("getPersistedTodoSyntheticAnchor returns null when only one field is set", () => {
        // Defensive: if migration rolls forward partially or row was hand-edited,
        // getter must return null rather than half-populated object.
        useTempDataHome("v11-anchor-half-");
        const db = openDatabase();
        db.prepare(
            "INSERT INTO session_meta (session_id, todo_synthetic_call_id) VALUES ('ses-half', 'mc_synthetic_todo_x')",
        ).run();
        expect(getPersistedTodoSyntheticAnchor(db, "ses-half")).toBeNull();
    });
});
