import { describe, expect, it } from "bun:test";
import {
	getOrCreateSessionMeta,
	getTagsBySession,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	textOf,
	userMessage,
} from "./test-utils.test";

// Caveman compression and inline-thinking removal on Pi across an execute pass
// and the defer pass that follows it. The cache contract requires the defer
// pass to send the bytes that execute pass sent.

const PROSE =
	"Please review the implementation and verify the results carefully before we continue with the next step.";

function conversation(extraTurns: number) {
	let timestamp = 1;
	const messages = [
		userMessage(`first request: ${PROSE}`, timestamp++),
		assistantMessage(
			"The implementation has been completed <think>stale private thought</think> and the verification results are available for the reviewer.",
			timestamp++,
		),
	];
	for (let turn = 2; turn < 2 + extraTurns; turn++) {
		messages.push(
			userMessage(`request ${turn}: ${PROSE}`, timestamp++),
			assistantMessage(`answer ${turn}: ${PROSE}`, timestamp++),
		);
	}
	messages.push(
		userMessage("Continue with the implementation.", timestamp++),
		assistantMessage("ok", timestamp++),
		userMessage("latest request", timestamp++),
	);
	return messages;
}

type ContextHandler = (
	event: { messages: never[] },
	ctx: never,
) => Promise<{ messages: never[] } | undefined>;

function register(
	db: ReturnType<typeof createTestDb>,
	clearReasoningAge: number,
): ContextHandler {
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		heuristics: {
			caveman: { enabled: true, minChars: 20 },
			keepReasoningTokens: clearReasoningAge === 1 ? 0 : 100_000,
		},
		scheduler: { executeThresholdPercentage: 80 },
		historianContextLimit: 1_000_000,
		historianChunkTokens: 32_000,
	});
	return fake.handlers.get("context") as ContextHandler;
}

describe("Pi caveman replay order review", () => {
	it("serves the same answer bytes on the defer pass after a raised clear_reasoning_age lets an execute pass deepen caveman below the persisted watermark", async () => {
		const db = createTestDb();
		const sessionId = "ses-pi-caveman-age-raise";
		try {
			const runPass = async (
				handler: ContextHandler,
				percent: number,
				extraTurns: number,
			) => {
				const messages = conversation(extraTurns);
				const result = await handler({ messages: messages as never[] }, {
					...fakeContext(
						sessionId,
						process.cwd(),
						messages.map((_, i) => `entry-${i}`),
						messages as never,
					),
					getContextUsage: () => ({
						tokens: percent * 1_000,
						percent,
						contextWindow: 100_000,
					}),
				} as never);
				if (!result) throw new Error("expected transformed messages");
				return result.messages;
			};
			const answerText = (messages: never[]) =>
				textOf(
					messages.find((message) => textOf(message).includes("verification")),
				);
			const answerTag = () =>
				getTagsBySession(db, sessionId).find(
					(tag) =>
						tag.type === "message" && tag.messageId.startsWith("entry-1"),
				);

			// Execute with clear_reasoning_age=1: the inline strip removes the
			// answer's <think> block and persists the shared reasoning watermark,
			// and caveman compresses the answer.
			const first = await runPass(register(db, 1), 90, 1);
			expect(JSON.stringify(first)).not.toContain("stale private thought");
			const firstDepth = answerTag()?.cavemanDepth ?? 0;
			expect(firstDepth).toBeGreaterThan(0);
			const watermark = getOrCreateSessionMeta(
				db,
				sessionId,
			).clearedReasoningThroughTag;
			expect(watermark).toBeGreaterThanOrEqual(
				answerTag()?.tagNumber ?? Number.POSITIVE_INFINITY,
			);

			// Restart with clear_reasoning_age=100. The persisted watermark still
			// covers the answer, but this pass's fresh inline strip no longer
			// reaches it. More turns move the answer into a deeper caveman tier,
			// and fresh compression rebuilds it from source, <think> included.
			clearContextHandlerSession(sessionId);
			const after = register(db, 100);
			signalPiPendingMaterialization(sessionId);
			const executed = await runPass(after, 90, 6);
			expect(answerTag()?.cavemanDepth ?? 0).toBeGreaterThan(firstDepth);
			expect(
				getOrCreateSessionMeta(db, sessionId).clearedReasoningThroughTag,
			).toBe(watermark);

			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 1,
				lastInputTokens: 1_000,
			});
			const deferred = await runPass(after, 1, 6);

			expect(answerText(deferred)).toBe(answerText(executed));
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});
});
