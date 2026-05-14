/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import {
    type DeferredExecutePayload,
    peekDeferredExecutePending,
    setDeferredExecutePendingIfAbsent,
} from "./storage-meta-persisted";

function createRaceDb(path: string): Database {
    const db = new Database(path);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(`
        CREATE TABLE IF NOT EXISTS session_meta (
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

function payload(id: string): DeferredExecutePayload {
    return { id, reason: "execute-none", recordedAt: 1_700_000_000_000 };
}

describe("deferred execute CAS race", () => {
    it("15. one WAL handle wins set-if-absent and the other no-ops", () => {
        const dir = mkdtempSync(join(tmpdir(), "boundary-exec-race-"));
        try {
            const path = join(dir, "context.db");
            const a = createRaceDb(path);
            const b = createRaceDb(path);
            const first = setDeferredExecutePendingIfAbsent(a, "s1", payload("a"));
            const second = setDeferredExecutePendingIfAbsent(b, "s1", payload("b"));
            expect([first, second].filter(Boolean)).toHaveLength(1);
            expect(peekDeferredExecutePending(a, "s1")?.id).toBe(first ? "a" : "b");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
