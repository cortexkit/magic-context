import { expect, test } from "bun:test";
import { getNativeReplayState } from "@magic-context/core/features/magic-context/storage-native-replay";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { applyFlushedStatuses } from "@magic-context/core/hooks/magic-context/apply-operations";
import {
	buildPersistedDropTargets,
	tagTranscript,
} from "@magic-context/core/shared/tag-transcript";
import {
	authorizePiToolRemoval,
	preparePiToolRemovalChecks,
	preparePiToolRemovalMeasurements,
} from "./native-replay-state-pi";
import { projectPiReplayDrops } from "./pass-tag-projection-pi";
import { getPiPassTagSnapshotView } from "./tag-snapshot-pi";
import { measurePiTailHygiene } from "./tail-hygiene-walk-pi";
import {
	assistantToolCall,
	createTestDb,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

test("review witness: LKG projection preserves empty-owner tool fallback", () => {
	const db = createTestDb();
	const sessionId = "review-empty-owner";
	try {
		db.prepare(
			`INSERT INTO tags(session_id, tag_number, message_id, type, status,
			byte_size, tool_owner_message_id, drop_mode)
			VALUES (?, 7, 'call', 'tool', 'dropped', 100, '', 'skeleton_real')`,
		).run(sessionId);
		const original = [
			assistantToolCall("call", "Read", { path: "original" }, 1),
			toolResultMessage(
				"call",
				"The original bulky output must stay dropped.",
				2,
			),
			userMessage("Continue.", 3),
		];
		const replay = (project: boolean) => {
			const transcript = createPiTranscript(
				structuredClone(original),
				sessionId,
				["owner", "result", "user"],
			);
			const rows = project
				? projectPiReplayDrops(
						transcript,
						getPiPassTagSnapshotView(db, sessionId),
					)
				: getTagsBySession(db, sessionId).filter(
						(row) => row.status === "dropped",
					);
			applyFlushedStatuses(
				sessionId,
				db,
				buildPersistedDropTargets(transcript, rows),
				rows,
			);
			transcript.commit();
			return JSON.stringify(transcript.getOutputMessages());
		};
		const full = replay(false);
		expect(full).toContain("[dropped §7§]");
		expect(replay(true)).toBe(full);
	} finally {
		db.close();
	}
});

function interruptedReplay(batch: boolean) {
	const db = createTestDb();
	const sessionId = "review-interrupted-replay";
	try {
		const original = [
			...Array.from({ length: 3 }, (_, index) => [
				assistantToolCall(
					`call-${index}`,
					"Read",
					{ path: `${index}` },
					index * 2,
				),
				toolResultMessage(`call-${index}`, `output-${index}`, index * 2 + 1),
			]).flat(),
			userMessage("Continue.", 7),
		];
		const ids = original.map((_, index) => `entry-${index}`);
		const saved = getNativeReplayState(db, sessionId).toolInputs;
		const transcript = createPiTranscript(
			structuredClone(original),
			sessionId,
			ids,
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
		const rows = getTagsBySession(db, sessionId).filter(
			(row) => row.type === "tool",
		);
		const middle = targets.get(rows[1]?.tagNumber ?? -1);
		if (!middle) throw new Error("middle tool target missing");
		// Interrupt rendering after one target, before the other authorizations run.
		middle.drop = () => {
			throw new Error("injected status replay interruption");
		};
		if (batch)
			preparePiToolRemovalChecks({
				rows: rows.map((row) => ({
					tagNumber: row.tagNumber,
					callId: row.messageId,
				})),
				targets,
				messages: original,
				prepare: transcript.prepareToolRemovalMeasurements,
			});
		expect(() => applyFlushedStatuses(sessionId, db, targets, rows)).toThrow(
			"injected status replay interruption",
		);
		const recovered = getNativeReplayState(db, sessionId).toolInputs;
		const retry = createPiTranscript(
			structuredClone(original),
			sessionId,
			ids,
			{
				authorizeToolRemoval: (callId) =>
					authorizePiToolRemoval({
						db,
						sessionId,
						callId,
						saved: recovered,
						canApply: false,
					}),
			},
		);
		applyFlushedStatuses(
			sessionId,
			db,
			buildPersistedDropTargets(retry, rows),
			rows,
		);
		retry.commit();
		retry.finalizeToolRemovals();
		return {
			markers: [...recovered.keys()],
			wire: JSON.stringify(retry.getOutputMessages()),
		};
	} finally {
		db.close();
	}
}

test("review witness: interrupted flushed replay preserves sequential recovery bytes", () => {
	const sequential = interruptedReplay(false);
	const batched = interruptedReplay(true);
	expect(sequential.markers).toEqual(["call-0"]);
	expect(batched.wire).toBe(sequential.wire);
	expect(batched.markers).toEqual(sequential.markers);
});

test("review witness: unchanged 1000-tag attribution does not rescan historical rows", () => {
	const db = createTestDb();
	try {
		const insert = db.prepare(
			`INSERT INTO tags(session_id,tag_number,message_id,type,status,byte_size)
			VALUES ('review-small', ?, ?, 'message', 'active', 10)`,
		);
		for (let number = 1; number <= 1000; number++)
			insert.run(number, `entry-${number}:p0`);
		let historicalRowReads = 0;
		const tags = getTagsBySession(db, "review-small").map(
			(row) =>
				new Proxy(row, {
					get(target, key, receiver) {
						if (key === "tagNumber") historicalRowReads++;
						return Reflect.get(target, key, receiver);
					},
				}),
		);
		const input = {
			messages: [userMessage("The visible tail.", 1001)],
			stableId: () => "entry-1000",
			tags,
			tagCacheKey: {},
			protectedTagNumbers: new Set<number>(),
		};
		const first = measurePiTailHygiene(input);
		historicalRowReads = 0;
		expect(measurePiTailHygiene(input)).toEqual(first);
		// Reusing the same tag array previously avoided rereading unchanged tag numbers.
		expect(historicalRowReads).toBeLessThan(1000);
	} finally {
		db.close();
	}
});
