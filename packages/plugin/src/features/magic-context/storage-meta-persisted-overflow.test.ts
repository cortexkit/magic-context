/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import {
    clearEmergencyRecovery,
    getOverflowState,
    recordDetectedContextLimit,
    recordOverflowDetected,
} from "./storage-meta-persisted";
import { ensureSessionMetaRow } from "./storage-meta-shared";

/**
 * Minimal session_meta schema for unit tests. We don't need the full plugin
 * DB machinery — just enough to exercise the overflow state functions.
 */
function createTestDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE session_meta (
            session_id TEXT PRIMARY KEY,
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
            detected_context_limit INTEGER NOT NULL DEFAULT 0,
            needs_emergency_recovery INTEGER NOT NULL DEFAULT 0,
            harness TEXT NOT NULL DEFAULT 'opencode'
        )
    `);
    return db;
}

describe("recordDetectedContextLimit", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    it("records the detected limit WITHOUT arming recovery", () => {
        ensureSessionMetaRow(db, "ses_subagent_1");
        recordDetectedContextLimit(db, "ses_subagent_1", 120_000);

        const state = getOverflowState(db, "ses_subagent_1");
        expect(state.detectedContextLimit).toBe(120_000);
        expect(state.needsEmergencyRecovery).toBe(false);
    });

    it("is a no-op when reportedLimit is zero or negative", () => {
        ensureSessionMetaRow(db, "ses_subagent_2");
        recordDetectedContextLimit(db, "ses_subagent_2", 0);
        recordDetectedContextLimit(db, "ses_subagent_2", -1);

        const state = getOverflowState(db, "ses_subagent_2");
        expect(state.detectedContextLimit).toBe(0);
        expect(state.needsEmergencyRecovery).toBe(false);
    });

    it("creates the session_meta row when missing (like recordOverflowDetected)", () => {
        // Do NOT call ensureSessionMetaRow first.
        recordDetectedContextLimit(db, "ses_fresh", 64_000);

        const state = getOverflowState(db, "ses_fresh");
        expect(state.detectedContextLimit).toBe(64_000);
        expect(state.needsEmergencyRecovery).toBe(false);
    });

    it("does NOT overwrite an existing recovery flag set by primary path", () => {
        ensureSessionMetaRow(db, "ses_mixed");
        recordOverflowDetected(db, "ses_mixed", 100_000); // primary: sets both

        recordDetectedContextLimit(db, "ses_mixed", 80_000); // subagent-style write

        const state = getOverflowState(db, "ses_mixed");
        expect(state.detectedContextLimit).toBe(80_000); // updated
        expect(state.needsEmergencyRecovery).toBe(true); // preserved
    });

    it("can be cleared via clearEmergencyRecovery without touching the limit", () => {
        ensureSessionMetaRow(db, "ses_clear_recovery");
        recordOverflowDetected(db, "ses_clear_recovery", 128_000);
        expect(getOverflowState(db, "ses_clear_recovery").needsEmergencyRecovery).toBe(true);

        clearEmergencyRecovery(db, "ses_clear_recovery");
        const after = getOverflowState(db, "ses_clear_recovery");
        expect(after.detectedContextLimit).toBe(128_000); // preserved
        expect(after.needsEmergencyRecovery).toBe(false); // cleared
    });
});
