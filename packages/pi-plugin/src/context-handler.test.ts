import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
	__resetMessageIndexAsyncForTests,
	isSessionReconciled,
} from "@magic-context/core/features/magic-context/message-index-async";
import * as searchModule from "@magic-context/core/features/magic-context/search";
import {
	addNote,
	getOrCreateSessionMeta,
	getPendingOps,
	getPersistedStickyTurnReminder,
	getTagsBySession,
	incrementHistorianFailure,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { onNoteTrigger } from "@magic-context/core/hooks/magic-context/note-nudger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import { clearAutoSearchForPiSession } from "./auto-search-pi";
import {
	clearContextHandlerSession,
	getPiToolUsageSinceUserTurnForTest,
	recordPiCtxReduceExecution,
	recordPiLiveModel,
	recordPiToolExecution,
	registerPiContextHandler,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	textOf,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

describe("registerPiContextHandler", () => {
	afterEach(() => {
		__resetMessageIndexAsyncForTests();
		clearContextHandlerSession("ses-context");
		clearContextHandlerSession("ses-sticky-context");
		clearAutoSearchForPiSession("ses-context");
		clearAutoSearchForPiSession("ses-sticky-context");
	});

	it("schedules first-touch message index reconciliation", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = [userMessage("hello", 1)] as never[];

			await handler({ messages }, fakeContext("ses-context") as never);
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(isSessionReconciled("ses-context")).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	it("clears stale compartmentInProgress on first context pass after restart", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-zombie-historian";
			clearContextHandlerSession(sessionId);
			updateSessionMeta(db, sessionId, { compartmentInProgress: true });
			expect(getOrCreateSessionMeta(db, sessionId).compartmentInProgress).toBe(
				true,
			);

			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: false,
				historian: {
					runner: {} as SubagentRunner,
					model: "test/historian",
					historianChunkTokens: 8000,
					executeThresholdPercentage: 65,
					triggerBudget: 8000,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = [userMessage("hello", 1)] as never[];
			const ctx = {
				...fakeContext(sessionId),
				getContextUsage: () => ({
					tokens: 1000,
					percent: 1,
					contextWindow: 100_000,
				}),
			};

			await handler({ messages }, ctx as never);

			expect(getOrCreateSessionMeta(db, sessionId).compartmentInProgress).toBe(
				false,
			);
		} finally {
			clearContextHandlerSession("ses-pi-zombie-historian");
			closeQuietly(db);
		}
	});

	it("tags user, assistant, and toolResult messages through the Pi adapter", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;

			const result = await handler(
				{
					messages: [
						userMessage("hello", 1),
						assistantMessage("answer", 2),
						toolResultMessage("call-1", "tool output", 3),
						userMessage("next", 4),
					] as never[],
				},
				fakeContext("ses-context") as never,
			);

			expect(textOf(result.messages[0] as never)).toMatch(/^§1§ hello/);
			expect(textOf(result.messages[1] as never)).toMatch(/^§2§ answer/);
			expect(textOf(result.messages[2] as never)).toMatch(/^§3§ tool output/);
			expect(
				getTagsBySession(db, "ses-context").map((tag) => tag.type),
			).toEqual(["message", "message", "tool", "message"]);
		} finally {
			closeQuietly(db);
		}
	});

	it("applies and drains pending drops for the session", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				// Disable protection so the immediate drop on tag #2 actually
				// materializes; otherwise the schema default (20) defers the
				// drop because tag #2 is in the protected window.
				protectedTags: 0,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;

			// Force scheduler to "execute" by pushing usage above the
			// default 65% threshold. Pi pending-ops materialization is
			// gated on schedulerDecision === "execute" || forceMaterialization
			// (mirrors OpenCode); without an over-threshold context, the
			// scheduler returns "defer" and drops correctly stay queued.
			const overThresholdCtx = {
				...fakeContext("ses-context"),
				getContextUsage: () => ({
					tokens: 70_000,
					percent: 70,
					contextWindow: 100_000,
				}),
			};
			await handler(
				{
					messages: [
						userMessage("keep user", 1),
						assistantMessage("drop assistant", 2),
					] as never[],
				},
				overThresholdCtx as never,
			);
			queuePendingOp(db, "ses-context", 2, "drop");
			const result = await handler(
				{
					messages: [
						userMessage("keep user", 1),
						assistantMessage("drop assistant", 2),
					] as never[],
				},
				overThresholdCtx as never,
			);

			expect(textOf(result.messages[1] as never)).toBe("[dropped §2§]");
			expect(getPendingOps(db, "ses-context")).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});

	it("injects a rolling nudge when the shared nudger band fires", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				nudge: {
					protectedTags: 0,
					nudgeIntervalTokens: 100,
					iterationNudgeThreshold: 10,
					executeThresholdPercentage: 65,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const ctx = {
				...fakeContext("ses-context"),
				getContextUsage: () => ({
					tokens: 100,
					percent: 30,
					contextWindow: 10_000,
				}),
			};

			const result = await handler(
				{
					messages: [
						assistantMessage("answer", 1),
						userMessage("latest prompt", 2),
					] as never[],
				},
				ctx as never,
			);

			expect(result.messages).toHaveLength(3);
			expect(textOf(result.messages[1] as never)).toContain("CONTEXT REMINDER");
			expect(result.messages[2]?.role).toBe("user");
		} finally {
			closeQuietly(db);
		}
	});

	it("injects deferred-note text into the latest new user message", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			addNote(db, "session", {
				sessionId: "ses-context",
				content: "Remember to update docs.",
			});
			onNoteTrigger(db, "ses-context", "historian_complete");

			await handler(
				{ messages: [userMessage("trigger turn", 1)] as never[] },
				fakeContext("ses-context") as never,
			);
			const result = await handler(
				{ messages: [userMessage("new turn", 2)] as never[] },
				fakeContext("ses-context") as never,
			);

			expect(textOf(result.messages[0] as never)).toContain(
				'<instruction name="deferred_notes">',
			);
			expect(textOf(result.messages[0] as never)).toContain("1 deferred note");
		} finally {
			closeQuietly(db);
		}
	});

	it("replays sticky note nudges idempotently across passes", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-sticky-context";
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			addNote(db, "session", {
				sessionId,
				content: "Sticky reminder.",
			});
			onNoteTrigger(db, sessionId, "historian_complete");
			await handler(
				{ messages: [userMessage("trigger turn", 1)] as never[] },
				fakeContext(sessionId) as never,
			);
			await handler(
				{ messages: [userMessage("new turn", 2)] as never[] },
				fakeContext(sessionId) as never,
			);

			const result = await handler(
				{ messages: [userMessage("new turn", 2)] as never[] },
				fakeContext(sessionId) as never,
			);
			const onceMore = await handler(
				{ messages: result.messages },
				fakeContext(sessionId) as never,
			);

			expect(
				textOf(result.messages[0] as never).match(/deferred_notes/g),
			).toHaveLength(1);
			expect(
				textOf(onceMore.messages[0] as never).match(/deferred_notes/g),
			).toHaveLength(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("appends an auto-search hint to the latest user message when the threshold is met", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () =>
				[
					{
						source: "memory",
						content: "Relevant Pi search wiring",
						score: 0.9,
						memoryId: 1,
						category: "WORKFLOW_RULES",
						matchType: "fts",
					},
				] as never,
		);
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				autoSearch: {
					enabled: true,
					scoreThreshold: 0.6,
					minPromptChars: 10,
					memoryEnabled: true,
					embeddingEnabled: false,
					gitCommitsEnabled: false,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;

			const result = await handler(
				{ messages: [userMessage("explain pi search wiring", 1)] as never[] },
				fakeContext("ses-context") as never,
			);

			expect(spy).toHaveBeenCalledTimes(1);
			expect(textOf(result.messages[0] as never)).toContain(
				"<ctx-search-hint>",
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("clearContextHandlerSession clears auto-search per-session caches", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [],
		);
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				autoSearch: {
					enabled: true,
					scoreThreshold: 0.6,
					minPromptChars: 10,
					memoryEnabled: true,
					embeddingEnabled: false,
					gitCommitsEnabled: false,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;

			await handler(
				{ messages: [userMessage("explain pi search wiring", 1)] as never[] },
				fakeContext("ses-context") as never,
			);
			await handler(
				{ messages: [userMessage("explain pi search wiring", 1)] as never[] },
				fakeContext("ses-context") as never,
			);
			clearContextHandlerSession("ses-context");
			await handler(
				{ messages: [userMessage("explain pi search wiring", 1)] as never[] },
				fakeContext("ses-context") as never,
			);

			expect(spy).toHaveBeenCalledTimes(2);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("persists model-resolved cache_ttl from Pi message_end assistant metadata", async () => {
		const db = createTestDb();
		try {
			const { persistPiMessageEndModelMeta } = await import("./index");

			persistPiMessageEndModelMeta({
				db,
				sessionId: "ses-context",
				message: assistantMessage("done", 1, {
					provider: "anthropic",
					model: "claude-sonnet-4-5",
				}),
				cacheTtlConfig: {
					default: "5m",
					"anthropic/claude-sonnet-4-5": "1h",
				},
			});

			expect(getOrCreateSessionMeta(db, "ses-context").cacheTtl).toBe("1h");
		} finally {
			clearContextHandlerSession("ses-context");
			closeQuietly(db);
		}
	});

	it("uses the live model key for scheduler execute_threshold_percentage resolution", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			recordPiLiveModel("ses-context", "anthropic/claude-sonnet-4-5");
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				protectedTags: 0,
				scheduler: {
					executeThresholdPercentage: {
						default: 90,
						"anthropic/claude-sonnet-4-5": 40,
					},
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const ctx = {
				...fakeContext("ses-context"),
				getContextUsage: () => ({
					tokens: 45_000,
					percent: 45,
					contextWindow: 100_000,
				}),
			};

			await handler(
				{
					messages: [
						userMessage("keep", 1),
						assistantMessage("drop", 2),
					] as never[],
				},
				ctx as never,
			);
			queuePendingOp(db, "ses-context", 2, "drop");
			const result = await handler(
				{
					messages: [
						userMessage("keep", 1),
						assistantMessage("drop", 2),
					] as never[],
				},
				ctx as never,
			);

			expect(textOf(result.messages[1] as never)).toBe("[dropped §2§]");
		} finally {
			clearContextHandlerSession("ses-context");
			closeQuietly(db);
		}
	});

	it("records ctx_reduce executions and suppresses rolling nudges during cooldown", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				nudge: {
					protectedTags: 0,
					nudgeIntervalTokens: 100,
					iterationNudgeThreshold: 10,
					executeThresholdPercentage: 65,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const ctx = {
				...fakeContext("ses-context"),
				getContextUsage: () => ({
					tokens: 100,
					percent: 30,
					contextWindow: 10_000,
				}),
			};
			recordPiCtxReduceExecution("ses-context");

			const result = await handler(
				{
					messages: [
						assistantMessage("answer", 1),
						userMessage("latest prompt", 2),
					] as never[],
				},
				ctx as never,
			);

			expect(result.messages).toHaveLength(2);
			expect(textOf(result.messages[0] as never)).not.toContain(
				"CONTEXT REMINDER",
			);
		} finally {
			clearContextHandlerSession("ses-context");
			closeQuietly(db);
		}
	});

	it("sets sticky tool-heavy reminders on the next user turn and resets tool usage", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			for (let i = 0; i < 5; i += 1) {
				recordPiToolExecution("ses-context");
			}

			await handler(
				{ messages: [userMessage("new turn", 100)] as never[] },
				fakeContext("ses-context") as never,
			);

			const sticky = getPersistedStickyTurnReminder(db, "ses-context");
			expect(sticky?.text).toContain("ctx_reduce_turn_cleanup");
			expect(getPiToolUsageSinceUserTurnForTest("ses-context")).toBe(0);
		} finally {
			clearContextHandlerSession("ses-context");
			closeQuietly(db);
		}
	});

	it("persists and clears top-level transform errors", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] } | undefined>;
			const throwingEvent = {} as { messages: never[] };
			Object.defineProperty(throwingEvent, "messages", {
				get: () => {
					throw new Error("boom messages");
				},
			});

			await handler(throwingEvent, fakeContext("ses-context") as never);
			expect(getOrCreateSessionMeta(db, "ses-context").lastTransformError).toBe(
				"boom messages",
			);

			await handler(
				{ messages: [userMessage("ok", 2)] as never[] },
				fakeContext("ses-context") as never,
			);
			expect(getOrCreateSessionMeta(db, "ses-context").lastTransformError).toBe(
				null,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("fires a recovery historian on the first pass after persisted failure", async () => {
		const db = createTestDb();
		try {
			incrementHistorianFailure(db, "ses-context", "previous failure");
			const runner = {
				harness: "pi",
				run: mock(async () => ({
					ok: true as const,
					assistantText:
						'<compartment start="1" end="2" title="Recovered">Recovered prior Pi history.</compartment>',
					durationMs: 1,
				})),
			} as unknown as SubagentRunner;
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				historian: {
					runner,
					model: "test/model",
					historianChunkTokens: 20_000,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = Array.from({ length: 12 }, (_, index) =>
				index % 2 === 0
					? userMessage(`user ${index}`, index + 1)
					: assistantMessage(`assistant ${index}`, index + 1),
			) as never[];
			const notify = mock(() => undefined);
			const ctx = {
				...fakeContext("ses-context"),
				ui: { notify },
				sessionManager: {
					getSessionId: () => "ses-context",
					getBranch: () =>
						messages.map((message, index) => ({
							type: "message",
							id: `entry-${index + 1}`,
							message,
						})),
				},
				getContextUsage: () => ({
					tokens: 100,
					percent: 10,
					contextWindow: 10_000,
				}),
			};

			await handler({ messages }, ctx as never);
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(runner.run).toHaveBeenCalledTimes(1);
			expect(notify).toHaveBeenCalledWith(
				expect.stringContaining("Historian recovery"),
			);
		} finally {
			closeQuietly(db);
		}
	});
});
