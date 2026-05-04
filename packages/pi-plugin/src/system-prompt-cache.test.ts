/**
 * Tests for `processSystemPromptForCache` — Pi's parity port of OpenCode's
 * Step 2 + Step 3 in `system-prompt-hash.ts`. Locks in:
 *
 *   - Sticky-date freezing on cache-stable turns (date drift replaced with
 *     first-observed date so prefix cache survives midnight boundaries).
 *   - Date adoption on cache-busting turns (sticky updates to live date).
 *   - Hash detection vs `session_meta.system_prompt_hash`.
 *   - First-pass hash initialization (no spurious hashChanged report).
 *   - Persistence of `system_prompt_hash` and `system_prompt_tokens` to
 *     session_meta.
 */

import { describe, expect, it } from "bun:test";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearPiSystemPromptSession,
	processSystemPromptForCache,
} from "./system-prompt";
import { createTestDb } from "./test-utils.test";

describe("processSystemPromptForCache", () => {
	it("initializes hash on first pass without reporting hashChanged", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-init";
			getOrCreateSessionMeta(db, sessionId);

			const result = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "You are a helpful assistant.\nToday's date: 2026-05-01",
				isCacheBusting: false,
			});

			expect(result.hashChanged).toBe(false);
			expect(result.currentHash).toMatch(/^[0-9a-f]{32}$/);

			const meta = getOrCreateSessionMeta(db, sessionId);
			expect(meta.systemPromptHash).toBe(result.currentHash);
			expect(meta.systemPromptTokens).toBeGreaterThan(0);
		} finally {
			clearPiSystemPromptSession("ses-init");
			closeQuietly(db);
		}
	});

	it("freezes the date on subsequent stable turns when not cache-busting", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-freeze";
			getOrCreateSessionMeta(db, sessionId);

			// Turn 1: live date is 2026-05-01.
			const turn1 = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "You are a helpful assistant.\nToday's date: 2026-05-01",
				isCacheBusting: false,
			});
			expect(turn1.systemPrompt).toContain("2026-05-01");

			// Turn 2: live date flipped to 2026-05-02 BUT cache is not
			// busting for any other reason. We should freeze to the
			// first-observed date so the prefix cache survives.
			const turn2 = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "You are a helpful assistant.\nToday's date: 2026-05-02",
				isCacheBusting: false,
			});
			// Frozen back to first date, hash unchanged.
			expect(turn2.systemPrompt).toContain("2026-05-01");
			expect(turn2.systemPrompt).not.toContain("2026-05-02");
			expect(turn2.hashChanged).toBe(false);
			expect(turn2.currentHash).toBe(turn1.currentHash);
		} finally {
			clearPiSystemPromptSession("ses-freeze");
			closeQuietly(db);
		}
	});

	it("adopts the live date on cache-busting turns and updates the sticky", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-adopt";
			getOrCreateSessionMeta(db, sessionId);

			// Turn 1: prime sticky to 2026-05-01.
			processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "You are a helpful assistant.\nToday's date: 2026-05-01",
				isCacheBusting: false,
			});

			// Turn 2: live is 2026-05-02 AND we're cache-busting (e.g.
			// dreamer just published new docs). We should adopt the
			// live date so future stable turns freeze on it.
			const turn2 = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "You are a helpful assistant.\nToday's date: 2026-05-02",
				isCacheBusting: true,
			});
			expect(turn2.systemPrompt).toContain("2026-05-02");
			// Hash is over the new live date.
			expect(turn2.hashChanged).toBe(true);

			// Turn 3: live is still 2026-05-02, not cache-busting. We
			// should keep using the new sticky (no re-freeze to
			// 2026-05-01).
			const turn3 = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "You are a helpful assistant.\nToday's date: 2026-05-02",
				isCacheBusting: false,
			});
			expect(turn3.systemPrompt).toContain("2026-05-02");
			expect(turn3.hashChanged).toBe(false);
		} finally {
			clearPiSystemPromptSession("ses-adopt");
			closeQuietly(db);
		}
	});

	it("reports hashChanged on real prompt content change", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-content-change";
			getOrCreateSessionMeta(db, sessionId);

			// Turn 1.
			const turn1 = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "First prompt.\nToday's date: 2026-05-01",
				isCacheBusting: false,
			});
			expect(turn1.hashChanged).toBe(false); // first pass

			// Turn 2: prompt content changed (e.g. dreamer published new docs).
			const turn2 = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt:
					"Second prompt with different content.\nToday's date: 2026-05-01",
				isCacheBusting: false,
			});
			expect(turn2.hashChanged).toBe(true);
			expect(turn2.currentHash).not.toBe(turn1.currentHash);

			// session_meta should now reflect the new hash.
			const meta = getOrCreateSessionMeta(db, sessionId);
			expect(meta.systemPromptHash).toBe(turn2.currentHash);
		} finally {
			clearPiSystemPromptSession("ses-content-change");
			closeQuietly(db);
		}
	});

	it("does NOT report hashChanged when only the date drifted (sticky restores it)", () => {
		// This is the critical cache-safety case: a midnight date flip on
		// an otherwise identical prompt should NOT bust prefix cache.
		const db = createTestDb();
		try {
			const sessionId = "ses-midnight";
			getOrCreateSessionMeta(db, sessionId);

			processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "Stable prompt.\nToday's date: 2026-05-01",
				isCacheBusting: false,
			});

			// Date flipped to 2026-05-02 — sticky-date freeze should
			// rewrite the prompt back to 2026-05-01 BEFORE hashing, so
			// hash stays identical.
			const turn2 = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "Stable prompt.\nToday's date: 2026-05-02",
				isCacheBusting: false,
			});

			expect(turn2.hashChanged).toBe(false);
			expect(turn2.systemPrompt).toContain("2026-05-01");
		} finally {
			clearPiSystemPromptSession("ses-midnight");
			closeQuietly(db);
		}
	});

	it("clearPiSystemPromptSession resets the sticky date", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-clear";
			getOrCreateSessionMeta(db, sessionId);

			processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "Prompt.\nToday's date: 2026-05-01",
				isCacheBusting: false,
			});

			clearPiSystemPromptSession(sessionId);

			// After clearing, the next pass acts like a first pass —
			// no freezing of a previous date, sticky takes the new
			// value.
			const turn = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "Prompt.\nToday's date: 2026-06-15",
				isCacheBusting: false,
			});
			expect(turn.systemPrompt).toContain("2026-06-15");
		} finally {
			clearPiSystemPromptSession("ses-clear");
			closeQuietly(db);
		}
	});

	it("treats previousHash='' / '0' as first-pass (no spurious hashChanged)", () => {
		// Newly-created sessions have system_prompt_hash='' or '0'
		// before the first pass writes a real value. Hash detection
		// must not report hashChanged on that first comparison.
		const db = createTestDb();
		try {
			const sessionId = "ses-zero-hash";
			getOrCreateSessionMeta(db, sessionId);
			// Force previousHash='0' to simulate legacy session_meta state.
			updateSessionMeta(db, sessionId, { systemPromptHash: "0" });

			const result = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "Prompt.\nToday's date: 2026-05-01",
				isCacheBusting: false,
			});

			expect(result.hashChanged).toBe(false);
			expect(result.currentHash).toMatch(/^[0-9a-f]{32}$/);
			expect(result.currentHash).not.toBe("0");
		} finally {
			clearPiSystemPromptSession("ses-zero-hash");
			closeQuietly(db);
		}
	});
});
