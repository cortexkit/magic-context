import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as embeddingModule from "@magic-context/core/features/magic-context/memory/embedding";
import type { UnifiedSearchResult } from "@magic-context/core/features/magic-context/search";
import {
	appendAutoSearchHintDecision,
	getAutoSearchHintDecisions,
} from "@magic-context/core/features/magic-context/storage";
import { autoSearchTestSnapshot } from "@magic-context/core/hooks/magic-context/auto-search-snapshot.fixture";
import * as searchModule from "@magic-context/core/hooks/magic-context/auto-search-worker-client";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearAutoSearchForPiSession,
	runAutoSearchHintForPi,
} from "./auto-search-pi";
import {
	assistantMessage,
	createTestDb,
	textOf,
	userMessage,
} from "./test-utils.test";

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
	let snapshotSpy: ReturnType<
		typeof spyOn<typeof embeddingModule, "getProjectEmbeddingSnapshot">
	>;
	beforeEach(() => {
		snapshotSpy = spyOn(
			embeddingModule,
			"getProjectEmbeddingSnapshot",
		).mockReturnValue(autoSearchTestSnapshot(baseOptions.projectPath));
	});
	afterEach(() => {
		snapshotSpy.mockRestore();
		clearAutoSearchForPiSession("ses-auto");
		clearAutoSearchForPiSession("ses-auto-2");
	});

	it("coalesces concurrent Pi passes and replays into each caller's own array", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "searchAutoHint").mockResolvedValue([
			memoryResult(),
		]);
		try {
			const first = [userMessage("explain the historian cache wiring", 1)];
			const second = [userMessage("explain the historian cache wiring", 1)];
			const results = await Promise.all([
				runAutoSearchHintForPi({
					db,
					sessionId: "ses-auto",
					messages: first,
					entryIds: ["same-user"],
					decisions: [],
					options: baseOptions,
				}),
				runAutoSearchHintForPi({
					db,
					sessionId: "ses-auto",
					messages: second,
					entryIds: ["same-user"],
					decisions: [],
					options: baseOptions,
				}),
			]);
			expect(results[0]).toBe(first);
			expect(results[1]).toBe(second);
			expect(textOf(first[0])).toContain("<ctx-search-hint>");
			expect(textOf(second[0])).toBe(textOf(first[0]));
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("reuses the per-turn cached hint for the same user message id", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
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

	it("excludes Primers from transform-time auto-search hints", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
			async () => [],
		);
		try {
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: [
					userMessage("explain how durable primer questions are maintained", 1),
				],
				options: baseOptions,
			});

			const options = spy.mock.calls[0]?.[4];
			expect(options?.sources).toEqual(["memory", "message", "git_commit"]);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("replays persisted hints but skips fresh decisions when strict entry ids fail", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
			async () => [memoryResult()],
		);
		try {
			appendAutoSearchHintDecision(db, "ses-auto", {
				messageId: "entry-replay",
				decision: "hint",
				text: "\n\n<ctx-search-hint>stored hint</ctx-search-hint>",
			});
			const replay = [
				{ ...userMessage("explain cached hint", 1), id: "entry-replay" },
			];
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: replay as never,
				entryIds: null,
				options: baseOptions,
			});
			expect(textOf(replay[0] as never)).toContain("stored hint");

			const fresh = [
				{ ...userMessage("explain new hint", 2), id: "entry-fresh" },
			];
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: fresh as never,
				entryIds: null,
				options: baseOptions,
			});

			expect(spy).not.toHaveBeenCalled();
			expect(textOf(fresh[0] as never)).not.toContain("<ctx-search-hint>");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("resolves the anchor by reference when the positional entryIds is stale (post-splice)", async () => {
		// Simulates the runPipeline splice: `entryIds` was resolved against a
		// PRE-splice array where the latest user message sat at a higher index.
		// After the splice, the latest user message is at index 0 of the current
		// array, but the stale positional entryIds[0] points at a DIFFERENT,
		// now-removed message's id ("entry-OLD-WRONG"). The reference-keyed map
		// must win and anchor the hint to the real id ("entry-REAL").
		const db = createTestDb();
		const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
			async () => [memoryResult()],
		);
		try {
			const latest = userMessage("explain the historian cache wiring", 1);
			const currentMessages = [latest];
			// Stale positional array (wrong id at index 0).
			const stalePositionalEntryIds = ["entry-OLD-WRONG"];
			// Splice-safe reference map: the actual current message -> real id.
			const entryIdByRef = new Map<object, string>([
				[latest as object, "entry-REAL"],
			]);

			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: currentMessages,
				entryIds: stalePositionalEntryIds,
				entryIdByRef,
				options: baseOptions,
			});

			// The hint was injected onto the latest message...
			expect(textOf(currentMessages[0])).toContain("<ctx-search-hint>");
			// ...and the persisted decision is keyed to the REAL id, not the stale
			// positional one — proving reference resolution took precedence.
			const decisions = getAutoSearchHintDecisions(db, "ses-auto");
			expect(decisions.some((d) => d.messageId === "entry-REAL")).toBe(true);
			expect(decisions.some((d) => d.messageId === "entry-OLD-WRONG")).toBe(
				false,
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("does NOT fall back to stale positional entryIds when the ref-map MISSES", async () => {
		// When a ref-map is supplied but the current latest user message is NOT in
		// it (e.g. an injection-cloned object, or a synthetic prepend), the resolver
		// must treat it as unresolved — NOT silently use the stale positional
		// entryIds[i], which after a splice points at a different message. A wrong
		// anchor would persist a decision against the wrong turn and replay the hint
		// onto the wrong message on later passes.
		const db = createTestDb();
		const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
			async () => [memoryResult()],
		);
		try {
			const latest = userMessage("explain the historian cache wiring", 1);
			const currentMessages = [latest];
			const stalePositionalEntryIds = ["entry-STALE-WRONG"];
			// Ref-map present but does NOT contain `latest` (simulates a clone/
			// synthetic the map was not built for).
			const entryIdByRef = new Map<object, string>([
				[{} as object, "entry-SOMETHING-ELSE"],
			]);

			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: currentMessages,
				entryIds: stalePositionalEntryIds,
				entryIdByRef,
				options: baseOptions,
			});

			// No hint injected (unresolved → degraded, no fresh anchor)...
			expect(textOf(currentMessages[0])).not.toContain("<ctx-search-hint>");
			// ...and crucially NO decision was persisted to the stale positional id.
			const decisions = getAutoSearchHintDecisions(db, "ses-auto");
			expect(decisions.some((d) => d.messageId === "entry-STALE-WRONG")).toBe(
				false,
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("runs a fresh search for a new user message id", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
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
		const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
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
		const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
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

	it("skips stacked search augmentation without searching", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
			async () => [memoryResult()],
		);
		try {
			const messages = [
				userMessage(
					"Implement this\n\n<ctx-search-hint>context</ctx-search-hint>",
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
			expect(textOf(messages[0])).toBe(
				"Implement this\n\n<ctx-search-hint>context</ctx-search-hint>",
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("strips plugin markers from the prompt before searching", async () => {
		const db = createTestDb();
		let capturedPrompt = "";
		const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
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
						"<system-reminder>outer <system-reminder>inner</system-reminder> tail</system-reminder>",
						"</system-reminder>",
						'<instruction name="ctx_reduce_turn_cleanup">drop</instruction>',
						"<custom-tag>actual project prompt survives</custom-tag>",
						"<!-- arbitrary <tag> commented noise -->",
						"<!-- OMO_INTERNAL_INITIATOR -->",
						"<!-- ALFONSO_INTERNAL_INITIATOR -->",
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

	it("does not append a recovered hint to a buried user message", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "searchAutoHint")
			.mockImplementationOnce(async () => {
				throw new Error("temporary search failure");
			})
			.mockImplementationOnce(async () => [memoryResult()]);
		try {
			const firstPass = [userMessage("explain the historian cache wiring", 1)];
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: firstPass,
				entryIds: ["entry-user"],
				options: baseOptions,
			});

			const secondPass = [
				userMessage("explain the historian cache wiring", 1),
				assistantMessage("already served answer", 2),
			];
			const beforeHash = createHash("sha256")
				.update(JSON.stringify(secondPass))
				.digest("hex");
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: secondPass,
				entryIds: ["entry-user", "entry-assistant"],
				options: baseOptions,
			});

			expect(spy).toHaveBeenCalledTimes(1);
			expect(
				createHash("sha256").update(JSON.stringify(secondPass)).digest("hex"),
			).toBe(beforeHash);
			expect(getAutoSearchHintDecisions(db, "ses-auto")).toHaveLength(0);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("does not persist no-hint decisions for retryable search errors", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
			async () => {
				throw new Error("temporary search failure");
			},
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

			expect(spy).toHaveBeenCalledTimes(2);
			expect(getAutoSearchHintDecisions(db, "ses-auto")).toHaveLength(0);
			expect(textOf(messages[0])).not.toContain("<ctx-search-hint>");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("persists a sticky no-hint decision after serving a deadline skip", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
			() => new Promise<UnifiedSearchResult[]>(() => undefined),
		);
		try {
			const messages = [userMessage("explain the historian cache wiring", 1)];
			const started = Date.now();
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				options: baseOptions,
			});
			const elapsed = Date.now() - started;

			expect(elapsed).toBeLessThan(4_000);
			expect(getAutoSearchHintDecisions(db, "ses-auto")[0]?.reason).toBe(
				"timeout",
			);
			expect(textOf(messages[0])).not.toContain("<ctx-search-hint>");

			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				options: baseOptions,
			});
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	}, 10_000);

	it("does not serve a synchronous search result after the whole-operation deadline", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
			async () => {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3100);
				return [memoryResult()];
			},
		);
		try {
			const messages = [userMessage("What's the current status ?", 1)];
			const before = JSON.stringify(messages);
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				entryIds: ["user"],
				options: baseOptions,
				ensureProjectRegistered: () =>
					new Promise((resolve) => setTimeout(resolve, 2900)),
			});
			expect(JSON.stringify(messages)).toBe(before);
			expect(getAutoSearchHintDecisions(db, "ses-auto")[0]?.reason).toBe(
				"timeout",
			);
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	}, 6000);

	it("aborts at the embedding checkpoint before an overdue search can scan vectors", async () => {
		const db = createTestDb();
		let observedAborted = false;
		const embed = spyOn(
			embeddingModule,
			"embedTextForProject",
		).mockImplementation(async () => {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3100);
			return null;
		});
		const search = spyOn(searchModule, "searchAutoHint").mockImplementation(
			async (_db, _session, _project, prompt, options) => {
				await options?.embedQuery?.(prompt, options.signal);
				observedAborted = options?.signal?.aborted ?? false;
				return [memoryResult()];
			},
		);
		try {
			const messages = [userMessage("What's the current status ?", 1)];
			const before = JSON.stringify(messages);
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				entryIds: ["user"],
				options: baseOptions,
				ensureProjectRegistered: () =>
					new Promise((resolve) => setTimeout(resolve, 2900)),
			});
			expect(observedAborted).toBe(true);
			expect(JSON.stringify(messages)).toBe(before);
			expect(getAutoSearchHintDecisions(db, "ses-auto")[0]?.reason).toBe(
				"timeout",
			);
		} finally {
			embed.mockRestore();
			search.mockRestore();
			closeQuietly(db);
		}
	});

	it("cold preparation is deferred and a later registered turn can hint", async () => {
		snapshotSpy.mockReturnValue(null);
		const db = createTestDb();
		const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
			async () => [memoryResult()],
		);
		let release: (() => void) | undefined;
		const preparation = new Promise<void>((resolve) => {
			release = resolve;
		});
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		try {
			const messages = [userMessage("What's the current status ?", 1)];
			const before = JSON.stringify(messages);
			const pass = runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages,
				entryIds: ["user"],
				options: baseOptions,
				ensureProjectRegistered: () => preparation,
			});
			const result = await Promise.race([
				pass.then(() => "served"),
				new Promise<string>((resolve) => {
					watchdog = setTimeout(() => resolve("watchdog"), 3500);
				}),
			]);
			expect(result).toBe("served");
			expect(JSON.stringify(messages)).toBe(before);
			expect(getAutoSearchHintDecisions(db, "ses-auto")[0]?.reason).toBe(
				"empty",
			);
			release?.();
			await pass;
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(spy).toHaveBeenCalledTimes(0);
			snapshotSpy.mockReturnValue(
				autoSearchTestSnapshot(baseOptions.projectPath),
			);
			const next = [
				...messages,
				assistantMessage("already served", 2),
				userMessage("Let's go with the implementation.", 3),
			];
			await runAutoSearchHintForPi({
				sessionId: "ses-auto",
				db,
				messages: next,
				entryIds: ["user", "assistant", "next-user"],
				options: baseOptions,
			});
			expect(JSON.stringify(next.slice(0, 1))).toBe(before);
			expect(textOf(next[2])).toContain("<ctx-search-hint>");
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			release?.();
			if (watchdog) clearTimeout(watchdog);
			spy.mockRestore();
			closeQuietly(db);
		}
	}, 6000);

	it("does not double-append an already present cached hint", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "searchAutoHint").mockImplementation(
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
