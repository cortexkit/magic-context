import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { UnifiedSearchResult } from "@magic-context/core/features/magic-context/search";
import * as searchModule from "@magic-context/core/features/magic-context/search";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearAutoSearchForPiSession,
	runAutoSearchHintForPi,
} from "./auto-search-pi";
import { createTestDb, textOf, userMessage } from "./test-utils.test";

const baseOptions = {
	enabled: true,
	scoreThreshold: 0.6,
	minPromptChars: 12,
	projectPath: "git:test",
	memoryEnabled: true,
	embeddingEnabled: false,
	gitCommitsEnabled: false,
};

function memoryResult(
	score = 0.9,
	content = "historian cache wiring details",
): UnifiedSearchResult {
	return {
		source: "memory",
		content,
		score,
		memoryId: 1,
		category: "WORKFLOW_RULES",
		matchType: "fts",
	};
}

describe("runAutoSearchHintForPi", () => {
	afterEach(() => {
		clearAutoSearchForPiSession("ses-auto");
		clearAutoSearchForPiSession("ses-auto-2");
	});

	it("reuses the per-turn cached hint for the same user message id", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [memoryResult()],
		);
		try {
			const firstMessages = [
				userMessage("explain the historian cache wiring", 1),
			];
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: firstMessages,
				options: baseOptions,
			});

			const replayMessages = [
				userMessage("explain the historian cache wiring", 1),
			];
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: replayMessages,
				options: baseOptions,
			});

			expect(spy).toHaveBeenCalledTimes(1);
			expect(textOf(replayMessages[0])).toContain("<ctx-search-hint>");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("runs a fresh search for a new user message id", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [memoryResult()],
		);
		try {
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: [userMessage("first long prompt", 1)],
				options: baseOptions,
			});
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: [userMessage("second long prompt", 2)],
				options: baseOptions,
			});

			expect(spy).toHaveBeenCalledTimes(2);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("does not append a hint when top score is below threshold", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [memoryResult(0.2)],
		);
		try {
			const messages = [userMessage("long prompt with weak matches", 1)];

			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				options: baseOptions,
			});

			expect(spy).toHaveBeenCalledTimes(1);
			expect(textOf(messages[0])).not.toContain("<ctx-search-hint>");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("skips empty user messages", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [memoryResult()],
		);
		try {
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: [userMessage("   ", 1)],
				options: baseOptions,
			});

			expect(spy).toHaveBeenCalledTimes(0);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("skips stacked sidekick augmentation without searching", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [memoryResult()],
		);
		try {
			const messages = [
				userMessage(
					"Implement this\n\n<sidekick-augmentation>context</sidekick-augmentation>",
					1,
				),
			];

			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				options: baseOptions,
			});

			expect(spy).toHaveBeenCalledTimes(0);
			expect(textOf(messages[0])).not.toContain("<ctx-search-hint>");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("strips plugin markers from the prompt before searching", async () => {
		const db = createTestDb();
		let capturedPrompt = "";
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async (_db, _session, _project, prompt) => {
				capturedPrompt = prompt;
				return [];
			},
		);
		try {
			const messages = [
				userMessage(
					[
						"§42§ <!-- +5m -->",
						"<system-reminder>ignore me</system-reminder>",
						'<instruction name="ctx_reduce_turn_cleanup">drop</instruction>',
						"actual project prompt survives",
						"<!-- OMO_INTERNAL_INITIATOR -->",
					].join("\n"),
					1,
				),
			];

			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				options: baseOptions,
			});

			expect(capturedPrompt).toBe("actual project prompt survives");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("does not double-append an already present cached hint", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [memoryResult()],
		);
		try {
			const messages = [userMessage("explain the historian cache wiring", 1)];

			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				options: baseOptions,
			});
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				options: baseOptions,
			});

			expect(spy).toHaveBeenCalledTimes(1);
			expect(textOf(messages[0]).match(/<ctx-search-hint>/g)).toHaveLength(1);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});
});
