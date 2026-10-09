import { expect, test } from "bun:test";
import {
	getOrCreateSessionMeta,
	getPendingOps,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
	addMergedReasoningStrippedIds,
	getThinkingBindingRecoveryTarget,
	THINKING_BINDING_STRIP_ORDER_END_MARKER,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	applyPiProactiveThinkingStrip,
	handlePiProviderFailure,
} from "./provider-error-recovery-pi";
import { clearOldReasoningPi } from "./reasoning-replay-pi";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

test("Pi thinking spans every tool round until the next real user", () => {
	const messages = [
		{ role: "user", content: "task" },
		{
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "first",
					thinkingSignature: "signed-first",
				},
				{ type: "toolCall", id: "t1" },
			],
		},
		{
			role: "toolResult",
			toolCallId: "t1",
			content: [{ type: "text", text: "result" }],
		},
		{
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "last",
					thinkingSignature: "signed-last",
				},
				{ type: "text", text: "done" },
			],
		},
	];
	const before = JSON.stringify(messages);
	const db = createTestDb();
	try {
		applyPiProactiveThinkingStrip({
			db,
			sessionId: "latest-turn",
			messages,
			entryIds: ["u", "a", "r", "b"],
			provider: "anthropic",
			model: "claude-opus-5-5",
			cacheBustingPass: true,
		});
		clearOldReasoningPi({
			protectLatestTurn: true,
			messages,
			messageIdToMaxTag: new Map([
				["a", 2],
				["b", 80],
			]),
			clearReasoningAge: 5,
			piMessageStableId: (_m, i) => ["u", "a", "r", "b"][i],
		});
		expect(JSON.stringify(messages)).toBe(before);
	} finally {
		closeQuietly(db);
	}
});

test("Pi Anthropic task retains queued drops at execute, force and 95% without refusing", async () => {
	const db = createTestDb();
	const sessionId = "pi-latest-turn-pipeline";
	getOrCreateSessionMeta(db, sessionId);
	updateSessionMeta(db, sessionId, {
		isSubagent: true,
		lastResponseTime: Date.now(),
		cacheTtl: "59m",
	});
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		tagger: createTagger(),
		protectedTokens: 4000,
		heuristics: { clearReasoningAge: 1 },
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: never[] },
		ctx: never,
	) => Promise<{ messages: unknown[] }>;
	let tokens = 20_000;
	const ctx = {
		...fakeContext(sessionId),
		model: {
			provider: "anthropic",
			id: "claude-opus-5-5",
			api: "anthropic-messages",
			contextWindow: 100_000,
		},
		getContextUsage: () => ({
			tokens,
			percent: tokens / 1000,
			contextWindow: 100_000,
		}),
	};
	const messages = [
		userMessage("task", 1),
		assistantMessage("spent", 2, {
			provider: "anthropic",
			model: "claude-opus-5-5",
			content: [
				{
					type: "thinking",
					thinking: "signed-one",
					thinkingSignature: "signature-one",
				},
				{ type: "text", text: "spent" },
			],
		}),
		assistantMessage("newest", 3, {
			provider: "anthropic",
			model: "claude-opus-5-5",
			content: [
				{
					type: "thinking",
					thinking: "signed-two",
					thinkingSignature: "signature-two",
				},
				{ type: "text", text: "newest" },
			],
		}),
	];
	const pass = () =>
		handler({ messages: structuredClone(messages) as never[] }, ctx as never);
	try {
		await pass();
		const before = JSON.stringify((await pass()).messages);
		queuePendingOp(db, sessionId, 2, "drop");
		for (const n of [76_000, 85_000]) {
			tokens = n;
			expect(JSON.stringify((await pass()).messages)).toBe(before);
			expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toContain(2);
		}
		tokens = 95_000;
		// Holding the unsafe drop never refuses the turn on its own: the unchanged
		// turn is served, because only a proven final-wire overflow refuses.
		expect(JSON.stringify((await pass()).messages)).toBe(before);
		expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toContain(2);
		messages.push(userMessage("next real user", 4));
		tokens = 76_000;
		await pass();
		expect(getPendingOps(db, sessionId)).toHaveLength(0);
	} finally {
		clearContextHandlerSession(sessionId);
		closeQuietly(db);
	}
});

for (const order of ["start", "end"] as const) {
	test(`Pi ${order}-order recovery keeps the restored original for the rejected turn and omits it again after a real user`, async () => {
		const sessionId = `pi-recovery-durable-${order}`;
		const db = createTestDb();
		getOrCreateSessionMeta(db, sessionId);
		updateSessionMeta(db, sessionId, {
			isSubagent: true,
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
		});
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTokens: 4000,
			heuristics: { clearReasoningAge: 1000 },
		});
		const handler = fake.handlers.get("context") as (
			event: { messages: never[] },
			ctx: never,
		) => Promise<{ messages: unknown[] }>;
		const original = {
			type: "thinking",
			thinking: "signed-2",
			thinkingSignature: "signature-2",
		};
		const source: unknown[] = [
			userMessage("task", 1),
			assistantMessage("answer-2", 2, {
				provider: "anthropic",
				model: "claude-opus-5-5",
				content: [original, { type: "text", text: "answer-2" }],
			}),
			assistantMessage("answer-3", 3, {
				provider: "anthropic",
				model: "claude-opus-5-5",
				content: [
					{
						type: "thinking",
						thinking: "signed-3",
						thinkingSignature: "signature-3",
					},
					{ type: "text", text: "answer-3" },
				],
			}),
		];
		const ids = ["u", "a", "b"];
		const pass = async () => {
			const messages = structuredClone(source);
			const ctx = {
				...fakeContext(sessionId, process.cwd(), ids, messages),
				model: {
					provider: "anthropic",
					id: "claude-opus-5-5",
					api: "anthropic-messages",
					contextWindow: 100_000,
				},
				getContextUsage: () => ({
					tokens: 20_000,
					percent: 20,
					contextWindow: 100_000,
				}),
			};
			return (await handler({ messages: messages as never[] }, ctx as never))
				.messages;
		};
		const thinkingOf = (messages: unknown[], text: string) =>
			messages
				.flatMap((message) => {
					const content = (message as { content?: unknown }).content;
					return Array.isArray(content) ? content : [];
				})
				.find((part) => (part as { thinking?: unknown }).thinking === text);
		try {
			await pass();
			addMergedReasoningStrippedIds(db, sessionId, [
				"binding_mismatch:a",
				...(order === "end" ? [THINKING_BINDING_STRIP_ORDER_END_MARKER] : []),
			]);
			expect(thinkingOf(await pass(), "signed-2")).toBeUndefined();
			handlePiProviderFailure({
				db,
				sessionId,
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-opus-5-5",
					errorMessage:
						"400: thinking or redacted_thinking blocks in the latest assistant message cannot be modified",
				},
			});
			// The retry and every later pass of the rejected turn carry the exact
			// original block; no pass removes it again.
			for (let n = 0; n < 2; n++)
				expect(thinkingOf(await pass(), "signed-2")).toEqual(original);
			expect(getThinkingBindingRecoveryTarget(db, sessionId)).toBe(
				"latest_thinking_original:u",
			);
			source.push(userMessage("next real user", 4));
			ids.push("next");
			const next = await pass();
			// The rejected turn ended: its accepted older-turn omission applies again.
			expect(thinkingOf(next, "signed-2")).toBeUndefined();
			expect(getThinkingBindingRecoveryTarget(db, sessionId) ?? "").toBe("");
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});
}
