import { expect, test } from "bun:test";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
	addMergedReasoningStrippedIds,
	THINKING_BINDING_STRIP_ORDER_END_MARKER,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { handlePiProviderFailure } from "./provider-error-recovery-pi";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

function fixture(sessionId: string) {
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
	const source = [
		userMessage("task", 1),
		...[2, 3].map((n) =>
			assistantMessage(`answer-${n}`, n, {
				provider: "anthropic",
				model: "claude-opus-5-5",
				content: [
					{
						type: "thinking",
						thinking: `signed-${n}`,
						thinkingSignature: `signature-${n}`,
					},
					{ type: "text", text: `answer-${n}` },
				],
			}),
		),
	];
	const pass = (tokens = 20_000) => {
		const messages = structuredClone(source);
		const ctx = {
			...fakeContext(sessionId, process.cwd(), ["u", "a", "b"], messages),
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
		return handler({ messages: messages as never[] }, ctx as never);
	};
	return { db, pass };
}

for (const order of ["start", "end"] as const) {
	test(`review issue630 Pi ${order} legacy strip order restores the rejected active turn`, async () => {
		const sessionId = `review-pi-recovery-${order}`;
		const { db, pass } = fixture(sessionId);
		try {
			await pass();
			addMergedReasoningStrippedIds(db, sessionId, [
				"binding_mismatch:a",
				...(order === "end" ? [THINKING_BINDING_STRIP_ORDER_END_MARKER] : []),
			]);
			expect(JSON.stringify((await pass()).messages)).not.toContain("signed-2");
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
			const restored = await pass();
			expect(JSON.stringify(restored.messages)).toContain("signed-2");
			expect(JSON.stringify(restored.messages)).toContain("signed-3");
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});
}

test("review issue630 Pi 95 percent without unsafe work still serves unchanged thinking", async () => {
	const sessionId = "review-pi-no-held-work";
	const { db, pass } = fixture(sessionId);
	try {
		const before = (await pass()).messages;
		const after = (await pass(95_000)).messages;
		expect(JSON.stringify(after)).toBe(JSON.stringify(before));
	} finally {
		clearContextHandlerSession(sessionId);
		closeQuietly(db);
	}
});
