// Review witnesses for Pi overflow recovery armed from the host's overflow
// signal, and for images priced per image. Each test states a property and is
// expected to fail on the code it was written against; see
// .cortexkit/internal-docs/audits/issue-938-cut-review.md for the findings.
import { afterEach, describe, expect, it } from "bun:test";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
	getOverflowState,
	resetEmergencyRecoveryRegistryForTest,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { handlePiSessionBeforeCompact } from "./index";
import {
	assertPiRawFallbackFits,
	classifyPiOutgoingFit,
	estimatePiOutgoingInputTokens,
} from "./pi-raw-fallback";
import { createTestDb } from "./test-utils.test";

const databases: ReturnType<typeof createTestDb>[] = [];

afterEach(() => {
	for (const db of databases.splice(0)) closeQuietly(db);
	resetEmergencyRecoveryRegistryForTest();
});

function db() {
	const value = createTestDb();
	databases.push(value);
	return value;
}

describe("overflow recovery armed from Pi's overflow compaction", () => {
	it("a compaction Pi starts because a successful reply's usage exceeded its configured window arms nothing", async () => {
		// Pi's _checkCompaction calls isContextOverflow(reply, model.contextWindow).
		// A reply that completed (stopReason "stop") but reported more input than
		// Pi's configured window starts an "overflow" compaction with
		// willRetry: false. The provider accepted that request, and Magic Context
		// may serve a larger window than Pi's metadata (its proven input floor).
		const database = db();
		const sessionId = "review938-silent-overflow";
		// The largest prompt the provider accepted in this session, above Pi's
		// configured window; Magic Context serves up to it.
		getOrCreateSessionMeta(database, sessionId);
		updateSessionMeta(database, sessionId, {
			observedSafeInputTokens: 786_000,
		});
		const args = {
			db: database,
			compactionOff: false,
			ctx: {
				sessionManager: { getSessionId: () => sessionId },
				model: { provider: "google", id: "gemini-3.8-flash" },
			},
			event: { reason: "overflow", willRetry: false },
		} as Parameters<typeof handlePiSessionBeforeCompact>[0];
		expect(await handlePiSessionBeforeCompact(args)).toEqual({ cancel: true });
		const armed = getOverflowState(database, sessionId).needsEmergencyRecovery;
		const floor = getOrCreateSessionMeta(
			database,
			sessionId,
		).observedSafeInputTokens;
		console.log(
			`after Pi's overflow compaction: recovery armed=${armed} proven input floor=${floor}`,
		);
		expect(armed).toBe(false);
		expect(floor).toBe(786_000);
	});
});

describe("images in the replay fit check", () => {
	const envelope = {
		modelKey: "google/gemini-3.8-flash",
		systemTokens: 100,
		toolDefinitionTokens: 100,
		refusalToolDefinitionTokens: 100,
		toolDefinitionsMeasured: true,
	};
	// One tiny image in a tool result: a few tokens of a 983k window.
	const replay = [
		{ role: "user", content: "make an image" },
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "c1",
					name: "generate_image",
					arguments: { prompt: "a dot" },
				},
			],
		},
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "generate_image",
			content: [
				{ type: "text", text: "generated" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			],
			isError: false,
		},
	];

	it("a saved request with a small image passes the replay fit check that the outgoing estimate passes", () => {
		const limit = 983_040;
		const estimate = estimatePiOutgoingInputTokens(
			replay,
			envelope,
			undefined,
			limit,
		);
		console.log(
			`outgoing estimate: tokens=${estimate.tokens} fit=${classifyPiOutgoingFit(estimate, limit)}`,
		);
		const lines: string[] = [];
		let refusal: unknown;
		try {
			assertPiRawFallbackFits(
				replay,
				limit,
				(line) => lines.push(line),
				null,
				envelope,
			);
		} catch (error) {
			refusal = error;
		}
		if (refusal)
			console.log(
				`replay fit refused: ${refusal instanceof Error ? refusal.message : String(refusal)}; ${lines.join("; ")}`,
			);
		expect(refusal).toBeUndefined();
	});
});
