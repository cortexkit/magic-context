/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import {
    clearDeferredExecutePendingIfMatches,
    type DeferredExecutePayload,
    peekDeferredExecutePending,
    setDeferredExecutePendingIfAbsent,
} from "./storage-meta-persisted";
import { ensureSessionMetaRow } from "./storage-meta-shared";

function createTestDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE session_meta (
            session_id TEXT PRIMARY KEY,
            harness TEXT NOT NULL DEFAULT 'opencode',
            last_response_time INTEGER NOT NULL DEFAULT 0,
            cache_ttl TEXT NOT NULL DEFAULT '5m',
            counter INTEGER NOT NULL DEFAULT 0,
            last_nudge_tokens INTEGER NOT NULL DEFAULT 0,
            last_nudge_band TEXT NOT NULL DEFAULT '',
            last_transform_error TEXT NOT NULL DEFAULT '',
            is_subagent INTEGER NOT NULL DEFAULT 0,
            last_context_percentage REAL NOT NULL DEFAULT 0,
            last_input_tokens INTEGER NOT NULL DEFAULT 0,
            times_execute_threshold_reached INTEGER NOT NULL DEFAULT 0,
            compartment_in_progress INTEGER NOT NULL DEFAULT 0,
            system_prompt_hash TEXT NOT NULL DEFAULT '',
            system_prompt_tokens INTEGER NOT NULL DEFAULT 0,
            conversation_tokens INTEGER NOT NULL DEFAULT 0,
            tool_call_tokens INTEGER NOT NULL DEFAULT 0,
            cleared_reasoning_through_tag INTEGER NOT NULL DEFAULT 0,
            last_todo_state TEXT NOT NULL DEFAULT '',
            deferred_execute_state TEXT
        )
    `);
    return db;
}

const payload: DeferredExecutePayload = {
    id: "flag-1",
    reason: "execute-none",
    recordedAt: 1_700_000_000_000,
};

describe("deferred execute state", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    it("peeks null when no deferred execute state is present", () => {
        ensureSessionMetaRow(db, "session-1");

        expect(peekDeferredExecutePending(db, "session-1")).toBeNull();
    });

    it("peeks non-null deferred execute state", () => {
        ensureSessionMetaRow(db, "session-1");
        db.prepare("UPDATE session_meta SET deferred_execute_state = ? WHERE session_id = ?").run(
            JSON.stringify(payload),
            "session-1",
        );

        expect(peekDeferredExecutePending(db, "session-1")).toEqual(payload);
    });

    it("set-then-set fails when a deferred execute state already exists", () => {
        expect(setDeferredExecutePendingIfAbsent(db, "session-1", payload)).toBe(true);

        const second: DeferredExecutePayload = { ...payload, id: "flag-2" };
        expect(setDeferredExecutePendingIfAbsent(db, "session-1", second)).toBe(false);
    });

    it("set-then-peek returns the recorded deferred execute payload", () => {
        setDeferredExecutePendingIfAbsent(db, "session-1", payload);

        expect(peekDeferredExecutePending(db, "session-1")).toEqual(payload);
    });

    it("clear-matches removes the deferred execute payload", () => {
        setDeferredExecutePendingIfAbsent(db, "session-1", payload);

        expect(clearDeferredExecutePendingIfMatches(db, "session-1", payload)).toBe(true);
        expect(peekDeferredExecutePending(db, "session-1")).toBeNull();
    });

    it("clear-stale-fails leaves the deferred execute payload intact", () => {
        setDeferredExecutePendingIfAbsent(db, "session-1", payload);

        const stale: DeferredExecutePayload = { ...payload, id: "stale" };
        expect(clearDeferredExecutePendingIfMatches(db, "session-1", stale)).toBe(false);
        expect(peekDeferredExecutePending(db, "session-1")).toEqual(payload);
    });
});
