import { describe, expect, it } from "bun:test";
import {
	getPersistedTodoSyntheticAnchor,
	setPersistedTodoSyntheticAnchor,
} from "@magic-context/core/features/magic-context/storage-meta";
import { computeSyntheticCallId } from "@magic-context/core/hooks/magic-context/todo-view";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { injectSyntheticTodowriteForPi } from "./pi-todo-inject";
import { assistantMessage, createTestDb } from "./test-utils.test";

describe("injectSyntheticTodowriteForPi", () => {
	it("skips defer replay when the persisted anchor is outside the visible window", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-todo-defer-missing-anchor";
			const stateJson = JSON.stringify([
				{
					content: "Keep stable anchor",
					status: "in_progress",
					priority: "high",
				},
			]);
			const callId = computeSyntheticCallId(stateJson);
			setPersistedTodoSyntheticAnchor(
				db,
				sessionId,
				callId,
				"old-anchor-not-visible",
				stateJson,
			);
			const messages = [
				assistantMessage("latest visible assistant", 2, {
					responseId: "new-visible-anchor",
				}),
			] as Parameters<typeof injectSyntheticTodowriteForPi>[0]["messages"];

			const result = injectSyntheticTodowriteForPi({
				db,
				sessionId,
				isSubagent: false,
				isCacheBusting: false,
				lastTodoState: stateJson,
				messages,
			});

			expect(result).toBe(messages);
			expect(messages).toHaveLength(1);
			expect(JSON.stringify(messages)).not.toContain(callId);
			expect(getPersistedTodoSyntheticAnchor(db, sessionId)?.messageId).toBe(
				"old-anchor-not-visible",
			);
		} finally {
			closeQuietly(db);
		}
	});
});
