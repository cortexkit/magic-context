import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import {
	getOrCreateSessionMeta,
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage";
import {
	getNativeReplayState,
	saveNativeToolInputs,
} from "@magic-context/core/features/magic-context/storage-native-replay";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { applyPendingOperations } from "@magic-context/core/hooks/magic-context/apply-operations";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { NATIVE_TOOL_REMOVAL_MARKER } from "./native-replay-pi";
import {
	applyNativeToolInputReplayPi,
	authorizePiToolRemoval,
	withPiToolRemovalBatch,
} from "./native-replay-state-pi";
import {
	assistantMessage,
	createTestDb,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

const require = createRequire(import.meta.url);
const anthropicRoot = require
	.resolve("omp-pi-ai-18126/package.json")
	.slice(0, -12);
const { convertAnthropicMessages } = (await import(
	`${anthropicRoot}src/providers/anthropic.ts`
)) as {
	convertAnthropicMessages: (
		messages: unknown[],
		model: unknown,
		oauth: boolean,
	) => unknown;
};
const { buildResponsesInput } = (await import(
	`${anthropicRoot}src/providers/openai-shared.ts`
)) as {
	buildResponsesInput: (options: Record<string, unknown>) => unknown;
};
const sessionId = "independent-removal-review";

function fixture(legacy: boolean, anthropic: boolean) {
	const db = createTestDb();
	getOrCreateSessionMeta(db, sessionId);
	const initial = legacy
		? '{"version":"keep","legacy":"strip"}'
		: JSON.stringify({
				future: { signed: "opaque", order: [3, 1, 2] },
				version: 2,
				piNative: {
					unknown: { signature: "do-not-normalize" },
					toolInputs: { "2": "{}", "call-7": '{"path":"previous"}' },
					reasoningIds: ["retired-reasoning"],
				},
				trailingBlank: { old: "keep" },
			});
	db.prepare(
		"UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ?",
	).run(initial, sessionId);
	const model = {
		provider: anthropic ? "anthropic" : "openai",
		api: anthropic ? "anthropic-messages" : "openai-responses",
		id: "test",
		input: ["text"],
		compat: {},
		identity: { class: "gpt", family: "gpt", vendor: "openai" },
	};
	const source = [
		userMessage("start", 1),
		...Array.from({ length: 71 }, (_, index) => [
			assistantMessage("retained prose", index * 3 + 2, {
				...model,
				model: model.id,
				content: [
					{
						type: "thinking",
						thinking: `reason-${index}`,
						thinkingSignature: anthropic
							? `sig-${index}`
							: JSON.stringify({
									type: "reasoning",
									id: `r-${index}`,
									encrypted_content: `canonical-cipher-${index}`,
									summary: [],
								}),
					},
					{ type: "text", text: "retained prose" },
					{
						type: "toolCall",
						id: `call-${index}`,
						name: "read",
						arguments: { path: `${index}.ts` },
						thoughtSignature: "tool-signature",
					},
				],
				...(anthropic
					? {}
					: {
							providerPayload: {
								type: "openaiResponsesHistory",
								dt: true,
								provider: "openai",
								items: [
									{
										type: "reasoning",
										id: `r-${index}`,
										encrypted_content: `cipher-${index}`,
										summary: [],
									},
									{
										type: "function_call",
										id: `fc-${index}`,
										call_id: `call-${index}`,
										name: "read",
										arguments: JSON.stringify({ path: `${index}.ts` }),
									},
								],
							},
						}),
			}),
			toolResultMessage(
				`call-${index}`,
				`independent result ${index}`,
				index * 3 + 3,
			),
			userMessage("continue", index * 3 + 4),
		]).flat(),
	];
	const saved = getNativeReplayState(db, sessionId).toolInputs;
	const authorize = (callId: string, canApply = true) =>
		authorizePiToolRemoval({ db, sessionId, saved, callId, canApply });
	const transcript = createPiTranscript(
		source,
		sessionId,
		source.map((_, i) => `entry-${i}`),
		{
			preserveReasoningToolArcs: false,
			authorizeToolRemoval: authorize,
		},
	);
	const tagger = createTagger();
	tagger.initFromDb(sessionId, db);
	const { targets } = tagTranscript(sessionId, transcript, tagger, db);
	const tools = getTagsBySession(db, sessionId).filter(
		(tag) => tag.type === "tool",
	);
	// Queued operations run in chunks of 64. This 70-target permutation distinguishes insertion order from sorting.
	const order = Array.from({ length: 70 }, (_, i) => (i * 31) % 70);
	for (const index of order) {
		const tag = tools[index];
		if (!tag) throw new Error("tool fixture missing");
		queuePendingOp(db, sessionId, tag.tagNumber, "drop");
	}
	const raw = () =>
		(
			db
				.prepare(
					"SELECT trailing_blank_decisions FROM session_meta WHERE session_id=?",
				)
				.get(sessionId) as { trailing_blank_decisions: string }
		).trailing_blank_decisions;
	const writeUnrelated = () =>
		saveNativeToolInputs(
			db,
			sessionId,
			new Map([["call-70", '{"path":"rewritten"}']]),
		);
	const apply = (interleave = false) => {
		let written = false;
		return applyPendingOperations(
			sessionId,
			db,
			targets,
			new Set(),
			undefined,
			undefined,
			[],
			new Set(),
			() => {
				if (interleave && !written) {
					written = true;
					writeUnrelated();
				}
			},
		);
	};
	const batch = (interleave = false, afterFlush = () => {}) =>
		withPiToolRemovalBatch({ db, sessionId, saved }, (flush) =>
			db
				.transaction(() => {
					const result = apply(interleave);
					// Repeated targets reuse the pending-removal plan instead of adding another marker.
					expect(authorize("call-0")).toBe(true);
					expect(authorize("call-0", false)).toBe(true);
					flush();
					afterFlush();
					return result;
				})
				.immediate(),
		);
	const request = () => {
		transcript.commit();
		applyNativeToolInputReplayPi(
			{ db, sessionId, messages: source, changes: new Map(), canApply: false },
			getNativeReplayState(db, sessionId).toolInputs,
		);
		transcript.finalizeToolRemovals();
		return JSON.stringify(
			anthropic
				? convertAnthropicMessages(source, model, false)
				: [
						convertResponsesMessages(
							model as never,
							{ messages: source } as never,
							new Set(["openai"]),
						),
						buildResponsesInput({
							model,
							context: { messages: source },
							strictResponsesPairing: true,
							supportsImageDetailOriginal: false,
							nativeHistory: { replay: true, filterReasoning: false },
						}),
					],
		);
	};
	return {
		db,
		saved,
		tools,
		raw,
		initial,
		authorize,
		apply,
		batch,
		request,
		writeUnrelated,
	};
}

for (const legacy of [false, true]) {
	for (const anthropic of [false, true]) {
		test(`independent native bytes: ${legacy ? "legacy" : "v2"} ${anthropic ? "Anthropic" : "Responses"} ordered drops and same-pass input replacement`, () => {
			const old = fixture(legacy, anthropic);
			const batch = fixture(legacy, anthropic);
			try {
				expect(old.apply()).toBe(true);
				expect(batch.batch()).toBe(true);
				old.writeUnrelated();
				batch.writeUnrelated();
				expect(batch.raw()).toBe(old.raw());
				const oldWire = old.request();
				expect(batch.request()).toBe(oldWire);
				expect(oldWire).toContain(
					anthropic ? "sig-70" : '"encrypted_content":"cipher-70"',
				);
				expect(getPendingOps(batch.db, sessionId)).toHaveLength(0);
			} finally {
				old.db.close();
				batch.db.close();
			}
		});
	}
}

test("review witness: a native input write between queued removals preserves stored document bytes", () => {
	const old = fixture(false, false);
	const batch = fixture(false, false);
	try {
		expect(old.apply(true)).toBe(true);
		expect(batch.batch(true)).toBe(true);
		expect(batch.request()).toBe(old.request());
		// The callback passed to applyPendingOperations also writes an unrelated native input.
		// Moving its unrelated input ahead of the first marker violates exact document identity.
		expect(batch.raw()).toBe(old.raw());
	} finally {
		old.db.close();
		batch.db.close();
	}
});

for (const failure of ["tag", "queue", "marker", "thinking"] as const) {
	test(`independent rollback: ${failure} failure leaves no permissions for a later defer`, () => {
		const lane = fixture(false, false);
		// Index 39 is last in the 70-target queue permutation, after the first 64 operations.
		const last = lane.tools[39];
		if (!last) throw new Error("fault target missing");
		try {
			if (failure === "tag")
				lane.db.exec(
					`CREATE TEMP TRIGGER review_fault BEFORE UPDATE OF status ON tags WHEN NEW.tag_number=${last.tagNumber} AND NEW.status='dropped' BEGIN SELECT RAISE(ABORT,'review tag fault'); END`,
				);
			if (failure === "queue")
				lane.db.exec(
					`CREATE TEMP TRIGGER review_fault BEFORE DELETE ON pending_ops WHEN OLD.tag_id=${last.tagNumber} BEGIN SELECT RAISE(ABORT,'review queue fault'); END`,
				);
			if (failure === "marker")
				lane.db.exec(
					"CREATE TEMP TRIGGER review_marker_fault BEFORE UPDATE OF trailing_blank_decisions ON session_meta BEGIN SELECT RAISE(ABORT,'review marker fault'); END",
				);
			expect(() =>
				lane.batch(false, () => {
					if (failure === "thinking") throw new Error("review thinking fault");
				}),
			).toThrow();
			expect(lane.raw()).toBe(lane.initial);
			expect([...lane.saved]).toEqual([
				["2", "{}"],
				["call-7", '{"path":"previous"}'],
			]);
			expect(getPendingOps(lane.db, sessionId)).toHaveLength(70);
			expect(
				getTagsBySession(lane.db, sessionId).filter(
					(tag) => tag.status === "dropped",
				),
			).toHaveLength(0);
			expect(lane.authorize("call-0", false)).toBe(false);
			expect(
				getNativeReplayState(lane.db, sessionId).toolInputs.get("call-0"),
			).not.toBe(NATIVE_TOOL_REMOVAL_MARKER);
		} finally {
			lane.db.close();
		}
	});
}
