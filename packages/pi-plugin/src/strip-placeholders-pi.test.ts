import { describe, expect, it } from "bun:test";
import { getStrippedPlaceholderIds } from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { stripPiDroppedPlaceholderMessages } from "./strip-placeholders-pi";
import { assistantMessage, createTestDb, userMessage } from "./test-utils.test";

describe("stripPiDroppedPlaceholderMessages", () => {
	it("discovers placeholder-only Pi messages on cache-busting passes", () => {
		const db = createTestDb();
		try {
			const messages = [
				userMessage("keep", 1),
				assistantMessage("[dropped §2§]", 2),
				userMessage([{ type: "text", text: "[dropped §3§]" }], 3),
				assistantMessage("real answer", 4),
			];

			const result = stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-placeholders",
				messages,
				isCacheBusting: true,
			});

			expect(result).toEqual({ removed: 2, discovered: 2 });
			expect(messages.map((m) => (m as { role: string }).role)).toEqual([
				"user",
				"assistant",
			]);
			expect(getStrippedPlaceholderIds(db, "ses-placeholders").size).toBe(2);
		} finally {
			closeQuietly(db);
		}
	});

	it("replays persisted stripping on defer passes without discovering new ids", () => {
		const db = createTestDb();
		try {
			const first = [
				userMessage("keep", 1),
				assistantMessage("[dropped §2§]", 2),
			];
			stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-placeholders",
				messages: first,
				isCacheBusting: true,
			});

			const replay = [
				userMessage("keep", 1),
				assistantMessage("[dropped §2§]", 2),
				assistantMessage("[dropped §3§]", 3),
			];
			const result = stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-placeholders",
				messages: replay,
				isCacheBusting: false,
			});

			expect(result).toEqual({ removed: 1, discovered: 0 });
			expect(replay).toHaveLength(2);
		} finally {
			closeQuietly(db);
		}
	});
});
