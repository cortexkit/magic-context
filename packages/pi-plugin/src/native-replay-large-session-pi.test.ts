import { expect, spyOn, test } from "bun:test";
import { getNativeReplayState } from "@magic-context/core/features/magic-context/storage-native-replay";
import * as sessionCollections from "@magic-context/core/features/magic-context/storage-session-collections";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	applyFlushedStatuses,
	convertLegacyToolSkeletons,
} from "@magic-context/core/hooks/magic-context/apply-operations";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { NATIVE_TOOL_REMOVAL_MARKER } from "./native-replay-pi";
import {
	authorizePiToolRemoval,
	preparePiToolRemovalChecks,
	preparePiToolRemovalMeasurements,
} from "./native-replay-state-pi";
import {
	assistantMessage,
	assistantToolCall,
	createTestDb,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

function replay(batch: boolean, count: number, rejectWrites = false) {
	const db = createTestDb();
	const sessionId = "batched-native-replay";
	try {
		const messages = Array.from({ length: count }, (_, index) => [
			assistantToolCall(
				`call-${index}`,
				"Read",
				{ path: `file-${index}` },
				index * 2 + 1,
			),
			toolResultMessage(`call-${index}`, `result-${index}`, index * 2 + 2),
		]).flat();
		const input = [
			...messages,
			userMessage("Keep the final user turn.", count * 2 + 1),
		];
		const saved = getNativeReplayState(db, sessionId).toolInputs;
		const transcript = createPiTranscript(
			input,
			sessionId,
			input.map((_, index) => `entry-${index}`),
			{
				authorizeToolRemoval: (callId) =>
					authorizePiToolRemoval({
						db,
						sessionId,
						callId,
						saved,
						canApply: true,
					}),
				authorizeToolRemovals: (callIds) =>
					preparePiToolRemovalMeasurements({
						db,
						sessionId,
						callIds,
						saved,
						canApply: true,
					}),
			},
		);
		const tagger = createTagger();
		tagger.initFromDb(sessionId, db);
		const { targets } = tagTranscript(sessionId, transcript, tagger, db);
		db.prepare(
			"UPDATE tags SET status='dropped', drop_mode='full' WHERE session_id=? AND type='tool'",
		).run(sessionId);
		let writes = 0;
		const update = sessionCollections.updateSessionMetaCollection;
		const instrumentation = spyOn(
			sessionCollections,
			"updateSessionMetaCollection",
		).mockImplementation((target, id, column, value, expected) => {
			if (
				target === db &&
				id === sessionId &&
				column === "trailing_blank_decisions"
			) {
				writes++;
				if (rejectWrites) throw new Error("replay write rejected");
			}
			return update(target, id, column, value, expected);
		});
		try {
			db.transaction(() =>
				convertLegacyToolSkeletons(db, sessionId, targets, {
					keepFullDrop: (callId) =>
						callId !== null && saved.get(callId) === NATIVE_TOOL_REMOVAL_MARKER,
					prepareRemovals: batch
						? (rows) =>
								preparePiToolRemovalChecks({
									db,
									rows,
									targets,
									messages: input,
									prepare: transcript.prepareToolRemovalMeasurements,
								})
						: undefined,
				}),
			).immediate();
			const tags = getTagsBySession(db, sessionId);
			if (batch)
				preparePiToolRemovalChecks({
					rows: tags
						.filter((tag) => tag.type === "tool" && tag.dropMode === "full")
						.map((tag) => ({
							tagNumber: tag.tagNumber,
							callId: tag.messageId,
						})),
					targets,
					messages: input,
					prepare: transcript.prepareToolRemovalMeasurements,
				});
			applyFlushedStatuses(sessionId, db, targets, tags);
			transcript.commit();
			transcript.finalizeToolRemovals();
			return {
				writes,
				wire: JSON.stringify(transcript.getOutputMessages()),
				tags: getTagsBySession(db, sessionId),
				inputs: [...getNativeReplayState(db, sessionId).toolInputs],
			};
		} finally {
			instrumentation.mockRestore();
		}
	} finally {
		db.close();
	}
}

test("legacy full-drop marker activation batches one durable document without changing replay", () => {
	const old = replay(false, 200);
	const batched = replay(true, 200);
	// The old path expands the same JSON document once for every new marker.
	expect(old.writes).toBe(200);
	expect(batched.writes).toBe(1);
	expect(batched.wire).toBe(old.wire);
	expect(batched.tags).toEqual(old.tags);
	expect(batched.inputs).toEqual(old.inputs);
});

test("failed marker batches retain the ordinary per-call fail-closed replay", () => {
	const old = replay(false, 3, true);
	const batched = replay(true, 3, true);
	expect(batched.inputs).toEqual([]);
	expect(batched.wire).toBe(old.wire);
	expect(batched.tags).toEqual(old.tags);
});

test("removal batches exclude repeated call IDs signed arcs incomplete arcs and mismatched targets", () => {
	const db = createTestDb();
	try {
		const messages = [
			assistantToolCall("plain", "Read", {}, 1),
			toolResultMessage("plain", "result", 2),
			assistantToolCall("reused", "Read", {}, 3),
			toolResultMessage("reused", "first", 4),
			assistantToolCall("reused", "Read", {}, 5),
			toolResultMessage("reused", "second", 6),
			assistantMessage("", 7, {
				content: [
					{
						type: "thinking",
						thinking: "signed",
						thinkingSignature: "synthetic-signature",
					},
					{ type: "toolCall", id: "signed", name: "Read", arguments: {} },
				],
			}),
			toolResultMessage("signed", "held", 8),
			assistantToolCall("open", "Read", {}, 9),
		];
		const transcript = createPiTranscript(
			messages,
			"guarded-batch",
			messages.map((_, index) => `entry-${index}`),
		);
		const tagger = createTagger();
		tagger.initFromDb("guarded-batch", db);
		const { targets } = tagTranscript("guarded-batch", transcript, tagger, db);
		const rows = getTagsBySession(db, "guarded-batch")
			.filter((tag) => tag.type === "tool")
			.map((tag) => ({ tagNumber: tag.tagNumber, callId: tag.messageId }));
		const prepared: string[][] = [];
		db.transaction(() =>
			preparePiToolRemovalChecks({
				db,
				rows: [
					...rows,
					{ tagNumber: rows[0]?.tagNumber ?? -1, callId: "signed" },
				],
				targets,
				messages,
				prepare: (ids) => prepared.push([...ids]),
			}),
		).immediate();
		expect(prepared).toEqual([["plain"]]);
	} finally {
		db.close();
	}
});
