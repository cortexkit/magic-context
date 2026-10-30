import { expect, it, spyOn } from "bun:test";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import {
	getOrCreateSessionMeta,
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage";
import { getNativeReplayState } from "@magic-context/core/features/magic-context/storage-native-replay";
import * as replayDocument from "@magic-context/core/features/magic-context/storage-replay-document";
import {
	sessionMetaCollectionSelect,
	updateSessionMetaCollection,
} from "@magic-context/core/features/magic-context/storage-session-collections";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { applyPendingOperations } from "@magic-context/core/hooks/magic-context/apply-operations";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { NATIVE_TOOL_REMOVAL_MARKER } from "./native-replay-pi";
import {
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

const sessionId = "native-batch";
const model = {
	id: "test",
	api: "openai-responses",
	provider: "openai",
	input: ["text"],
};

function fixture(legacy = false) {
	const db = createTestDb();
	getOrCreateSessionMeta(db, sessionId);
	const initial = legacy
		? '{"legacy-blank":"keep"}'
		: JSON.stringify({
				future: { untouched: ["ordered", "namespace"] },
				version: 2,
				piNative: {
					futureNative: { signature: "opaque" },
					toolInputs: { "prior|fc-prior": '{"path":"old"}', "2": "{}" },
					reasoningIds: ["signed-reasoning"],
				},
				trailingBlank: { blank: "keep" },
			});
	updateSessionMetaCollection(
		db,
		sessionId,
		"trailing_blank_decisions",
		initial,
	);
	const source = [
		userMessage("start", 1),
		...Array.from({ length: 70 }, (_, index) => {
			const id = index === 0 ? "prior|fc-prior" : `call-${index}|fc-${index}`;
			const nativeId = id.split("|")[1];
			return [
				assistantMessage("answer", index * 3 + 2, {
					...model,
					content: [
						{
							type: "thinking",
							thinking: "signed",
							thinkingSignature: "signature",
						},
						{
							type: "toolCall",
							id,
							name: "read",
							arguments: { path: id },
							thoughtSignature: "call-signature",
						},
					],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: "openai",
						items: [
							{
								type: "reasoning",
								id: `reason-${index}`,
								encrypted_content: "ciphertext",
								summary: [],
							},
							{
								type: "function_call",
								id: nativeId,
								call_id: id.split("|")[0],
								name: "read",
								arguments: JSON.stringify({ path: id }),
							},
						],
					},
				}),
				toolResultMessage(id, "result ".repeat(100), index * 3 + 3),
				userMessage("continue", index * 3 + 4),
			];
		}).flat(),
	];
	const saved = getNativeReplayState(db, sessionId).toolInputs;
	const transcript = createPiTranscript(
		source,
		sessionId,
		source.map((_, i) => `entry-${i}`),
		{
			preserveReasoningToolArcs: false,
			authorizeToolRemoval: (callId) =>
				authorizePiToolRemoval({
					db,
					sessionId,
					saved,
					callId,
					canApply: true,
				}),
		},
	);
	const tagger = createTagger();
	tagger.initFromDb(sessionId, db);
	const { targets } = tagTranscript(sessionId, transcript, tagger, db);
	// Non-sorted queue order must become native marker insertion order, including
	// across the shared helper's 64-operation chunk boundary.
	const tools = getTagsBySession(db, sessionId).filter(
		(tag) => tag.type === "tool",
	);
	for (const tag of [tools[1], tools[0], ...tools.slice(2)]) {
		if (!tag) throw new Error("Missing tool fixture");
		queuePendingOp(db, sessionId, tag.tagNumber, "drop");
	}
	const raw = () =>
		(
			db
				.prepare(
					`SELECT ${sessionMetaCollectionSelect("trailing_blank_decisions")} FROM session_meta WHERE session_id = ?`,
				)
				.get(sessionId) as { trailing_blank_decisions: string }
		).trailing_blank_decisions;
	const apply = () => applyPendingOperations(sessionId, db, targets, new Set());
	const request = () => {
		transcript.commit();
		transcript.finalizeToolRemovals();
		return JSON.stringify(
			convertResponsesMessages(
				model as never,
				{ messages: source } as never,
				new Set(["openai"]),
			),
		);
	};
	return { db, saved, source, raw, apply, request, initial };
}

function applyBatch(lane: ReturnType<typeof fixture>): boolean {
	return withPiToolRemovalBatch({ ...lane, sessionId }, (flush) =>
		lane.db
			.transaction(() => {
				const result = lane.apply();
				flush();
				return result;
			})
			.immediate(),
	);
}

it("batched queued drops preserve exact native document and provider request bytes", () => {
	for (const legacy of [false, true]) {
		const old = fixture(legacy);
		const batched = fixture(legacy);
		try {
			expect(old.apply()).toBe(true);
			expect(applyBatch(batched)).toBe(true);
			expect(batched.raw()).toBe(old.raw());
			expect(batched.request()).toBe(old.request());
			expect(getPendingOps(batched.db, sessionId)).toHaveLength(0);
			expect(getNativeReplayState(batched.db, sessionId).toolInputs.size).toBe(
				legacy ? 70 : 71,
			);
		} finally {
			old.db.close();
			batched.db.close();
		}
	}
});

it("a queued-drop lane merges native markers once across operation chunks", () => {
	const lane = fixture();
	const merge = spyOn(replayDocument, "updateReplayDocument");
	try {
		expect(applyBatch(lane)).toBe(true);
		expect(merge).toHaveBeenCalledTimes(1);
	} finally {
		merge.mockRestore();
		lane.db.close();
	}
});

it("a failed caller transaction rolls back planned markers, tags, queue and published authorization", () => {
	const lane = fixture();
	const before = lane.raw();
	const saved = [...lane.saved];
	try {
		expect(() =>
			withPiToolRemovalBatch({ ...lane, sessionId }, (flush) =>
				lane.db
					.transaction(() => {
						expect(lane.apply()).toBe(true);
						flush();
						expect(lane.raw()).not.toBe(before);
						expect([...lane.saved]).toEqual(saved);
						throw new Error("companion failed");
					})
					.immediate(),
			),
		).toThrow("companion failed");
		expect(lane.raw()).toBe(before);
		expect([...lane.saved]).toEqual(saved);
		expect(getPendingOps(lane.db, sessionId)).toHaveLength(70);
		expect(
			getTagsBySession(lane.db, sessionId).filter(
				(tag) => tag.status === "dropped",
			),
		).toHaveLength(0);
	} finally {
		lane.db.close();
	}
});

it("batch planning is ordered and pure, including replay-only and unavailable native state", () => {
	const db = createTestDb();
	const saved = new Map([["prior", NATIVE_TOOL_REMOVAL_MARKER]]);
	try {
		withPiToolRemovalBatch({ db, sessionId, saved }, (flush) =>
			db
				.transaction(() => {
					const authorize = (
						callId: string,
						canApply: boolean,
						state: Map<string, string> | undefined = saved,
					) =>
						authorizePiToolRemoval({
							db,
							sessionId,
							saved: state,
							callId,
							canApply,
						});
					expect(authorize("prior", false)).toBe(true);
					expect(authorize("new", false)).toBe(false);
					expect(authorize("new", true)).toBe(true);
					expect(authorize("new", false)).toBe(true);
					expect(
						authorizePiToolRemoval({
							db,
							sessionId,
							saved: undefined,
							callId: "missing",
							canApply: true,
						}),
					).toBe(false);
					expect(saved.has("new")).toBe(false);
					expect(getNativeReplayState(db, sessionId).toolInputs.size).toBe(0);
					flush();
				})
				.immediate(),
		);
		expect(saved.get("new")).toBe(NATIVE_TOOL_REMOVAL_MARKER);
	} finally {
		db.close();
	}
});
