import { describe, expect, it, mock } from "bun:test";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getPendingPiCompactionMarkerState,
	setPendingPiCompactionMarkerState,
} from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { applyDeferredPiCompactionMarker } from "./compaction-marker-manager-pi";
import * as recompMarker from "./pi-recomp-marker";
import { stagePiRecompMarker } from "./pi-recomp-marker";
import { iterateEntriesToRawMessageRange } from "./read-session-pi";
import { createTestDb } from "./test-utils.test";

it("exports only the deferred recomp marker path", () => {
	expect(Object.keys(recompMarker)).toEqual(["stagePiRecompMarker"]);
});

function branchEntry(id: string, role: "user" | "assistant", text: string) {
	return { type: "message", id, message: { role, content: text } };
}

/**
 * A session generating images: a tool call whose result Pi folds into a
 * synthetic user message (`synth-user-<result entry id>`), then plain turns.
 */
function imageSessionEntries(): unknown[] {
	return [
		branchEntry("u1", "user", "draw a cat"),
		{
			type: "message",
			id: "a1",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-1",
						name: "generate_image",
						arguments: { prompt: "cat" },
					},
				],
			},
		},
		{
			type: "message",
			id: "r1",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "generate_image",
				content: [{ type: "text", text: "saved cat.png" }],
			},
		},
		branchEntry("a2", "assistant", "Here is the cat."),
		branchEntry("u2", "user", "now a dog"),
		branchEntry("a3", "assistant", "Done."),
	];
}

function rawIds(entries: readonly unknown[]): string[] {
	return [
		...iterateEntriesToRawMessageRange(
			entries,
			0,
			Number.MAX_SAFE_INTEGER,
			Number.MAX_SAFE_INTEGER,
		),
	].map((message) => message.id);
}

describe("stagePiRecompMarker (deferred recomp marker)", () => {
	it("stages the rebuilt history's marker when its newest summary ends the branch", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-recomp-stage-at-tail";
		try {
			const entries = imageSessionEntries();
			expect(rawIds(entries)).toEqual([
				"u1",
				"a1",
				"synth-user-r1",
				"a2",
				"u2",
				"a3",
			]);
			// The marker an earlier historian run staged for its summary of 1-3,
			// ending on the folded tool result; no busting pass drained it yet.
			const stale = {
				firstKeptEntryId: "a2",
				endMessageId: "synth-user-r1",
				ordinal: 3,
				tokensBefore: 0,
				summary: "older history",
				publishedAt: 1,
			};
			setPendingPiCompactionMarkerState(db, sessionId, stale);
			// /ctx-recomp replaced that summary: its rebuilt history covers every
			// message of the snapshot, so nothing after it exists yet to keep.
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "u1",
					endMessageId: "a1",
					title: "Cat",
					content: "cat",
				},
				{
					sequence: 1,
					startMessage: 3,
					endMessage: 6,
					startMessageId: "synth-user-r1",
					endMessageId: "a3",
					title: "Dog",
					content: "dog",
				},
			]);

			stagePiRecompMarker({ db, sessionId, branchEntries: entries.slice() });

			const staged = getPendingPiCompactionMarkerState(db, sessionId);
			expect(staged).toMatchObject({
				endMessageId: "a3",
				ordinal: 6,
				firstKeptEntryId: null,
			});
			if (!staged) throw new Error("recomp staged no marker");

			// The person's next message is the first entry the summaries leave.
			entries.push(branchEntry("u3", "user", "and a bird"));
			const appendCompaction = mock(
				(
					_summary: string,
					firstKeptEntryId: string,
					_tokensBefore: number,
					_details?: unknown,
					_fromHook?: boolean,
				) => {
					entries.push({
						type: "compaction",
						id: "compact-recomp",
						firstKeptEntryId,
					});
					return "compact-recomp";
				},
			);
			const outcome = applyDeferredPiCompactionMarker(
				{ db, appendCompaction, readBranchEntries: () => entries },
				sessionId,
				staged,
			);
			expect(outcome).toEqual({
				kind: "applied",
				firstKeptEntryId: "u3",
				compactionId: "compact-recomp",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("names the kept entry when the branch already holds one", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-recomp-stage-resolved";
		try {
			const entries = [
				...imageSessionEntries(),
				branchEntry("u3", "user", "and a bird"),
			];
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 6,
					startMessageId: "u1",
					endMessageId: "a3",
					title: "Images",
					content: "images",
				},
			]);

			stagePiRecompMarker({ db, sessionId, branchEntries: entries });

			expect(getPendingPiCompactionMarkerState(db, sessionId)).toMatchObject({
				endMessageId: "a3",
				ordinal: 6,
				firstKeptEntryId: "u3",
			});
		} finally {
			closeQuietly(db);
		}
	});
});
