/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
	clearDeferredExecutePendingIfMatches,
	type DeferredExecutePayload,
	peekDeferredExecutePending,
	setDeferredExecutePendingIfAbsent,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { ensureSessionMetaRow } from "@magic-context/core/features/magic-context/storage-meta-shared";
import { applyMidTurnDeferral } from "@magic-context/core/hooks/magic-context/boundary-execution";
import { Database } from "@magic-context/core/shared/sqlite";
import { isMidTurnPi } from "./read-session-pi";

function createDb(): Database {
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

function flag(): DeferredExecutePayload {
	return {
		id: "flag-1",
		reason: "execute-none",
		recordedAt: 1_700_000_000_000,
	};
}

describe("boundary execution Pi integration", () => {
	it("12. Pi mid-turn execute defers and sets a flag", () => {
		const db = createDb();
		const midTurn = isMidTurnPi(
			{
				messages: [
					{ role: "assistant", content: [{ type: "toolCall", id: "call-1" }] },
				],
			},
			"s1",
		);
		const result = applyMidTurnDeferral({
			base: "execute",
			bypassReason: "none",
			midTurn,
		});
		if (result.sideEffect === "set-flag")
			setDeferredExecutePendingIfAbsent(db, "s1", flag());
		expect(result.midTurnAdjustedSchedulerDecision).toBe("defer");
		expect(peekDeferredExecutePending(db, "s1")?.id).toBe("flag-1");
	});

	it("13. Pi boundary execute drains prior flag when work executes", () => {
		const db = createDb();
		setDeferredExecutePendingIfAbsent(db, "s1", flag());
		const current = peekDeferredExecutePending(db, "s1");
		expect(current).not.toBeNull();
		if (current !== null) {
			clearDeferredExecutePendingIfMatches(db, "s1", current);
		}
		expect(peekDeferredExecutePending(db, "s1")).toBeNull();
	});

	it("14. Pi preserves flag when execute-gated work fails", () => {
		const db = createDb();
		ensureSessionMetaRow(db, "s1");
		setDeferredExecutePendingIfAbsent(db, "s1", flag());
		const executedWorkThisPass = false;
		if (executedWorkThisPass) {
			const current = peekDeferredExecutePending(db, "s1");
			if (current) clearDeferredExecutePendingIfMatches(db, "s1", current);
		}
		expect(peekDeferredExecutePending(db, "s1")?.id).toBe("flag-1");
	});
});
