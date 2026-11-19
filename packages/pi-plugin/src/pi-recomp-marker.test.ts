import { describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getPendingPiCompactionMarkerState,
	setPendingPiCompactionMarkerState,
} from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { applyDeferredPiCompactionMarker } from "./compaction-marker-manager-pi";
import {
	queueAndApplyPiRecompMarker,
	stagePiRecompMarker,
} from "./pi-recomp-marker";
import { iterateEntriesToRawMessageRange } from "./read-session-pi";
import { createTestDb } from "./test-utils.test";

/**
 * queueAndApplyPiRecompMarker is the EAGER marker path: it writes AND applies
 * the native compaction marker immediately, bypassing the rendered-coverage
 * gate the pipeline's deferred drain enforces. Its safety depends on the
 * caller having just republished the compartments (a recomp/upgrade is a HARD
 * bust, so the same pass's m[0] re-materialization covers the marker). These
 * tests pin both halves of that contract: application happens ONLY when the
 * branch already contains the entries covering the marker boundary (i.e. the
 * recomp materialization rendered them), and the live background commands
 * stay on the deferred staging path instead of this eager bypass.
 */

function branchEntry(id: string, role: "user" | "assistant", text: string) {
	return { type: "message", id, message: { role, content: text } };
}

describe("queueAndApplyPiRecompMarker (eager path coverage precondition)", () => {
	it("keeps a failed read-back pending instead of retiring it as already-current on rebinding", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-recomp-read-back";
		const entries: unknown[] = [
			branchEntry("e1", "user", "one"),
			branchEntry("e2", "assistant", "two"),
			branchEntry("e3", "user", "three"),
		];
		const appendCompaction = mock(
			(
				_summary: unknown,
				firstKeptEntryId: unknown,
				_tokensBefore: unknown,
				_details: unknown,
				_fromHook: unknown,
				_usage: unknown,
			) => {
				entries.push({
					type: "compaction",
					id: "corrupt",
					firstKeptEntryId,
					details: {},
				});
				return "corrupt";
			},
		);
		const ctx = {
			sessionManager: {
				appendCompaction,
				getBranch: () => entries,
				getEntry: (id: string) =>
					entries.find((entry) => (entry as { id?: string }).id === id),
			},
		};
		try {
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "e1",
					endMessageId: "e2",
					title: "Recomp",
					content: "body",
				},
			]);
			for (let pass = 0; pass < 3; pass++) {
				queueAndApplyPiRecompMarker({ db, sessionId, ctx });
				expect(getPendingPiCompactionMarkerState(db, sessionId)).not.toBeNull();
			}
			expect(appendCompaction).toHaveBeenCalledTimes(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("applies the marker when the branch covers the recomp boundary", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-recomp-eager-covered";
		try {
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "e1",
					endMessageId: "e2",
					title: "Recomp chunk",
					content: "recomp body",
				},
			]);
			const entries: unknown[] = [
				branchEntry("e1", "user", "one"),
				branchEntry("e2", "assistant", "two"),
				branchEntry("e3", "user", "three"),
			];
			const appendCompaction = mock(
				(
					_summary: unknown,
					firstKeptEntryId: unknown,
					_tokensBefore: unknown,
					details: unknown,
					_fromHook: unknown,
					_usage: unknown,
				) => {
					entries.push({
						type: "compaction",
						id: "compact-1",
						firstKeptEntryId,
						details,
					});
					return "compact-1";
				},
			);
			const ctx = {
				sessionManager: {
					appendCompaction,
					getEntry: (id: string) =>
						entries.find((entry) => (entry as { id?: string }).id === id),
					// The recomp materialization rendered the compartment; the
					// branch still carries the kept tail starting at ordinal 3
					// (lastCompactedOrdinal 2 + 1), so the boundary resolves to
					// a real, replay-safe entry id.
					getBranch: () => entries,
				},
			};

			queueAndApplyPiRecompMarker({ db, sessionId, ctx });

			expect(appendCompaction).toHaveBeenCalledTimes(1);
			const call = appendCompaction.mock.calls[0] as unknown[];
			expect(call[1]).toBe("e3"); // firstKeptEntryId heads the kept tail
			expect(call[4]).toBe(true); // fromHook
			// Applied AND CAS-cleared in the same call — no pending marker left.
			expect(getPendingPiCompactionMarkerState(db, sessionId)).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("does not apply or stage anything when the branch lacks the covering entry", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-recomp-eager-uncovered";
		try {
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "e1",
					endMessageId: "e2",
					title: "Recomp chunk",
					content: "recomp body",
				},
			]);
			const appendCompaction = mock(
				(
					_summary: unknown,
					_firstKeptEntryId: unknown,
					_tokensBefore: unknown,
					_details: unknown,
					_fromHook: unknown,
					_usage: unknown,
				) => "compact-1",
			);
			const ctx = {
				sessionManager: {
					appendCompaction,
					getEntry: () => undefined,
					// No entry at ordinal 3: the rendered content covering the
					// marker boundary does not exist (no recomp materialization
					// in this context), so nothing may be trimmed.
					getBranch: () => [
						branchEntry("e1", "user", "one"),
						branchEntry("e2", "assistant", "two"),
					],
				},
			};

			queueAndApplyPiRecompMarker({ db, sessionId, ctx });

			expect(appendCompaction).not.toHaveBeenCalled();
			// The guard runs BEFORE staging, so no unmatchable marker persists.
			expect(getPendingPiCompactionMarkerState(db, sessionId)).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("no-ops when the session manager exposes no compaction surface", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-recomp-eager-no-surface";
		try {
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "e1",
					endMessageId: "e2",
					title: "Recomp chunk",
					content: "recomp body",
				},
			]);

			queueAndApplyPiRecompMarker({
				db,
				sessionId,
				ctx: { sessionManager: {} },
			});

			expect(getPendingPiCompactionMarkerState(db, sessionId)).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});
});

describe("recomp marker command wiring stays on the deferred path", () => {
	// The eager bypass is only safe inside a same-pass rendered-coverage
	// context that the background commands cannot guarantee (they run
	// DETACHED, during a cache-stable pass). They must stage + defer so the pipeline's
	// coverage-gated drain applies the marker on the next busting pass.
	for (const name of ["ctx-recomp.ts"]) {
		it(`${name} stages the marker and never calls the eager apply path`, () => {
			const src = readFileSync(join(import.meta.dir, "commands", name), "utf8");
			const codeOnly = src
				.split("\n")
				.filter((line) => !line.trim().startsWith("//"))
				.join("\n");
			expect(codeOnly).toContain("stagePiRecompMarker(");
			expect(codeOnly).not.toContain("queueAndApplyPiRecompMarker(");
		});
	}
});

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
