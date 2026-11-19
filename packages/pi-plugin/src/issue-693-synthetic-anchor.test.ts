import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	clearPendingPiCompactionMarkerStateIf,
	clearSession,
	getPendingPiCompactionMarkerState,
	setPendingPiCompactionMarkerState,
} from "@magic-context/core/features/magic-context/storage";
import { copySessionStateForClone } from "@magic-context/core/features/magic-context/storage-clone";
import {
	_resetHarnessForTesting,
	setHarness,
} from "@magic-context/core/shared/harness";
import * as logger from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	applyDeferredPiCompactionMarker,
	clearPiCompactionMarkerDrainLogState,
} from "./compaction-marker-manager-pi";
import { repairPiHistoryBoundary } from "./history-boundary-repair-pi";
import { createTestDb } from "./test-utils.test";

afterEach(() => {
	_resetHarnessForTesting();
	setHarness("pi");
});

const captured = {
	endMessageId: "synth-user-30b2dcd1",
	firstKeptEntryId: null,
	ordinal: 6988,
	publishedAt: 1791620493881,
	summary:
		"Magic Context compacted: Disk backlog implemented and fully qualified offline; staged for independent review",
	tokensBefore: 2151,
};

function entries(withAnswer: boolean) {
	return [
		{
			type: "message",
			id: "u1",
			message: { role: "user", content: "mock request" },
		},
		{
			type: "message",
			id: "a1",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call", name: "read", arguments: {} },
				],
			},
		},
		{
			type: "message",
			id: "30b2dcd1",
			message: {
				role: "toolResult",
				toolCallId: "call",
				toolName: "read",
				content: [{ type: "text", text: "mock result" }],
			},
		},
		...(withAnswer
			? [
					{
						type: "message",
						id: "a2",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "mock answer" }],
						},
					},
				]
			: []),
	];
}

for (const harness of ["pi", "omp"] as const) {
	describe(`issue 693 ${harness} synthetic anchors`, () => {
		for (const shape of ["resolved", "tail", "missing"] as const) {
			it(`${shape}: captured synthetic end is resolved or diagnosed without guessing`, () => {
				_resetHarnessForTesting();
				const db = createTestDb();
				_resetHarnessForTesting();
				setHarness(harness);
				const sessionId = `issue-693-${harness}-${shape}`;
				const log = spyOn(logger, "sessionLog").mockImplementation(
					() => undefined,
				);
				try {
					appendCompartments(db, sessionId, [
						{
							sequence: 0,
							startMessage: 6986,
							endMessage: 6988,
							startMessageId: "u1",
							endMessageId: captured.endMessageId,
							title: "History",
							content: "Mock history",
						},
					]);
					setPendingPiCompactionMarkerState(db, sessionId, captured);
					const appendCompaction = mock(() => "compact");
					const deps = {
						db,
						readBranchEntries: () =>
							shape === "missing" ? [] : entries(shape === "resolved"),
						appendCompaction,
					};
					const outcome = applyDeferredPiCompactionMarker(
						deps,
						sessionId,
						captured,
					);
					if (shape === "resolved") {
						// The summary ends on the tool result and the reply continues the
						// turn, so the request's history cut keeps the turn's prompt u1;
						// the marker keeps it too instead of hiding it.
						expect(outcome).toEqual({
							kind: "applied",
							firstKeptEntryId: "u1",
							compactionId: "compact",
						});
						expect(appendCompaction).toHaveBeenCalledWith(
							captured.summary,
							"u1",
							2151,
							{ source: "magic-context", lastCompactedOrdinal: 6988 },
							true,
						);
					} else {
						expect(outcome).toEqual({ kind: "waiting-for-entry" });
						applyDeferredPiCompactionMarker(deps, sessionId, captured);
						expect(appendCompaction).not.toHaveBeenCalled();
						const gates = log.mock.calls
							.map(([, text]) => text)
							.filter((text) =>
								text.startsWith("Pi compaction-marker drain gate="),
							);
						expect(gates).toHaveLength(1);
						expect(gates[0]).toContain(
							`gate=${shape === "tail" ? "no-replay-safe-kept-entry" : "ordinal-alignment-unavailable"}`,
						);
						expect(gates[0]).toContain("boundaryKind=folded-tool-result");
						if (shape === "missing")
							expect(gates[0]).toContain("alignmentReason=anchor-missing");
						expect(getPendingPiCompactionMarkerState(db, sessionId)).toEqual(
							captured,
						);
					}
				} finally {
					log.mockRestore();
					clearPiCompactionMarkerDrainLogState(sessionId);
					closeQuietly(db);
				}
			});
		}

		it("keeps the turn's prompt for a summary ending on a call whose result follows, then the next prompt once the turn closes", () => {
			_resetHarnessForTesting();
			const db = createTestDb();
			_resetHarnessForTesting();
			setHarness(harness);
			const sessionId = `issue-693-${harness}-kept`;
			try {
				const marker = { ...captured, endMessageId: "a1", ordinal: 2 };
				appendCompartments(db, sessionId, [
					{
						sequence: 0,
						startMessage: 1,
						endMessage: 2,
						startMessageId: "u1",
						endMessageId: "a1",
						title: "History",
						content: "Mock history",
					},
				]);
				const appendCompaction = mock(() => "compact");
				// The history cut drops the call and its result and keeps the turn's
				// prompt u1 while the turn goes on, with or without the reply yet.
				for (const withAnswer of [true, false])
					expect(
						applyDeferredPiCompactionMarker(
							{
								db,
								readBranchEntries: () => entries(withAnswer),
								appendCompaction,
							},
							sessionId,
							marker,
						),
					).toEqual({
						kind: "applied",
						firstKeptEntryId: "u1",
						compactionId: "compact",
					});
				expect(appendCompaction).toHaveBeenCalledTimes(2);
				// A next prompt right after the result closes the turn: the cut keeps
				// nothing before it, and the marker starts there.
				expect(
					applyDeferredPiCompactionMarker(
						{
							db,
							readBranchEntries: () => [
								...entries(false),
								{
									type: "message",
									id: "u2",
									message: { role: "user", content: "next mock request" },
								},
							],
							appendCompaction,
						},
						sessionId,
						marker,
					),
				).toEqual({
					kind: "applied",
					firstKeptEntryId: "u2",
					compactionId: "compact",
				});
			} finally {
				clearPiCompactionMarkerDrainLogState(sessionId);
				closeQuietly(db);
			}
		});

		it("retires the captured synthetic end after its result merges into a real user", () => {
			_resetHarnessForTesting();
			const db = createTestDb();
			_resetHarnessForTesting();
			setHarness(harness);
			const sessionId = `issue-693-${harness}-merged`;
			try {
				appendCompartments(db, sessionId, [
					{
						sequence: 0,
						startMessage: 6986,
						endMessage: 6988,
						startMessageId: "u1",
						endMessageId: captured.endMessageId,
						title: "History",
						content: "Mock history",
					},
				]);
				setPendingPiCompactionMarkerState(db, sessionId, captured);
				const appendCompaction = mock(() => "compact");
				const branch = [
					...entries(false),
					{
						type: "message",
						id: "u2",
						message: { role: "user", content: "unsummarized request" },
					},
				];
				expect(
					applyDeferredPiCompactionMarker(
						{ db, readBranchEntries: () => branch, appendCompaction },
						sessionId,
						captured,
					),
				).toEqual({ kind: "stale-skip", reason: "synthetic-boundary-merged" });
				expect(appendCompaction).not.toHaveBeenCalled();
			} finally {
				clearPiCompactionMarkerDrainLogState(sessionId);
				closeQuietly(db);
			}
		});

		it("logs a successful clear once with its reason, never a lost CAS", () => {
			_resetHarnessForTesting();
			const db = createTestDb();
			_resetHarnessForTesting();
			setHarness(harness);
			const sessionId = `issue-693-${harness}-clear`;
			const log = spyOn(logger, "sessionLog").mockImplementation(
				() => undefined,
			);
			try {
				setPendingPiCompactionMarkerState(db, sessionId, captured);
				expect(
					clearPendingPiCompactionMarkerStateIf(db, sessionId, {
						...captured,
						ordinal: 1,
					}),
				).toBe(false);
				expect(log.mock.calls).toHaveLength(0);
				expect(
					clearPendingPiCompactionMarkerStateIf(db, sessionId, captured),
				).toBe(true);
				expect(
					clearPendingPiCompactionMarkerStateIf(db, sessionId, captured),
				).toBe(false);
				expect(log.mock.calls).toHaveLength(1);
				expect(log.mock.calls[0]?.[1]).toContain(
					"Pi compaction-marker clear: reason=explicit-clear endMessageId=synth-user-30b2dcd1 ordinal=6988",
				);
				expect(log.mock.calls[0]?.[1]).not.toContain(captured.summary);
			} finally {
				log.mockRestore();
				closeQuietly(db);
			}
		});

		it("logs explicit reset and malformed-state cleanup once without stored text", () => {
			_resetHarnessForTesting();
			const db = createTestDb();
			_resetHarnessForTesting();
			setHarness(harness);
			const sessionId = `issue-693-${harness}-reset`;
			const log = spyOn(logger, "sessionLog").mockImplementation(
				() => undefined,
			);
			try {
				setPendingPiCompactionMarkerState(db, sessionId, captured);
				setPendingPiCompactionMarkerState(db, sessionId, null);
				setPendingPiCompactionMarkerState(db, sessionId, null);
				expect(log.mock.calls).toHaveLength(1);
				expect(log.mock.calls[0]?.[1]).toContain("reason=explicit-reset");
				db.prepare(
					"UPDATE session_meta SET pending_pi_compaction_marker_state = ? WHERE session_id = ?",
				).run("private malformed state", sessionId);
				expect(getPendingPiCompactionMarkerState(db, sessionId)).toBeNull();
				expect(getPendingPiCompactionMarkerState(db, sessionId)).toBeNull();
				expect(log.mock.calls).toHaveLength(2);
				expect(log.mock.calls[1]?.[1]).toBe(
					"Pi compaction-marker clear: reason=malformed-state",
				);
			} finally {
				log.mockRestore();
				closeQuietly(db);
			}
		});

		it("logs session deletion of a pending marker once", () => {
			_resetHarnessForTesting();
			const db = createTestDb();
			_resetHarnessForTesting();
			setHarness(harness);
			const sessionId = `issue-693-${harness}-delete`;
			const log = spyOn(logger, "sessionLog").mockImplementation(
				() => undefined,
			);
			try {
				setPendingPiCompactionMarkerState(db, sessionId, captured);
				clearSession(db, sessionId, true);
				clearSession(db, sessionId, true);
				expect(
					log.mock.calls.filter(([, text]) =>
						text.startsWith("Pi compaction-marker clear:"),
					),
				).toEqual([
					[
						sessionId,
						"Pi compaction-marker clear: reason=session-reset endMessageId=synth-user-30b2dcd1 ordinal=6988 firstKeptEntryId=<none>",
					],
				]);
			} finally {
				log.mockRestore();
				closeQuietly(db);
			}
		});

		it("logs clone replacement of a destination marker once", () => {
			_resetHarnessForTesting();
			const db = createTestDb();
			_resetHarnessForTesting();
			setHarness(harness);
			const sessionId = `issue-693-${harness}-clone`;
			const log = spyOn(logger, "sessionLog").mockImplementation(
				() => undefined,
			);
			try {
				setPendingPiCompactionMarkerState(db, sessionId, captured);
				const copy = () =>
					copySessionStateForClone(db, "empty-source", sessionId, {
						resolveBoundaryOrdinal: () => undefined,
						includeTag: () => false,
						includeMessageId: () => false,
						selectPendingPiMarker: () => null,
					});
				copy();
				copy();
				expect(getPendingPiCompactionMarkerState(db, sessionId)).toBeNull();
				expect(
					log.mock.calls.filter(([, text]) =>
						text.startsWith("Pi compaction-marker clear:"),
					),
				).toEqual([
					[
						sessionId,
						"Pi compaction-marker clear: reason=clone-replaced endMessageId=synth-user-30b2dcd1 ordinal=6988 firstKeptEntryId=<none>",
					],
				]);
			} finally {
				log.mockRestore();
				closeQuietly(db);
			}
		});

		it("logs branch retirement only after commit, not on a rolled-back clear", () => {
			_resetHarnessForTesting();
			const db = createTestDb();
			_resetHarnessForTesting();
			setHarness(harness);
			const sessionId = `issue-693-${harness}-branch`;
			const log = spyOn(logger, "sessionLog").mockImplementation(
				() => undefined,
			);
			try {
				appendCompartments(db, sessionId, [
					{
						sequence: 0,
						startMessage: 6986,
						endMessage: 6988,
						startMessageId: "u1",
						endMessageId: captured.endMessageId,
						title: "History",
						content: "Mock history",
					},
				]);
				setPendingPiCompactionMarkerState(db, sessionId, captured);
				const ctx = {
					sessionManager: {
						getBranch: () => [{ ...entries(false)[0], parentId: null }],
						getLeafId: () => "u1",
					},
				};
				db.exec(
					"CREATE TRIGGER refuse_prefix_clear BEFORE UPDATE OF cached_m0_bytes ON session_meta BEGIN SELECT RAISE(ABORT, 'mock rollback'); END",
				);
				expect(() => repairPiHistoryBoundary(db, sessionId, ctx)).toThrow();
				expect(getPendingPiCompactionMarkerState(db, sessionId)).toEqual(
					captured,
				);
				expect(
					log.mock.calls.filter(([, text]) =>
						text.startsWith("Pi compaction-marker clear:"),
					),
				).toHaveLength(0);
				db.exec("DROP TRIGGER refuse_prefix_clear");
				repairPiHistoryBoundary(db, sessionId, ctx);
				repairPiHistoryBoundary(db, sessionId, ctx);
				expect(getPendingPiCompactionMarkerState(db, sessionId)).toBeNull();
				expect(
					log.mock.calls.filter(([, text]) =>
						text.startsWith("Pi compaction-marker clear:"),
					),
				).toEqual([
					[
						sessionId,
						"Pi compaction-marker clear: reason=active-branch-retired endMessageId=synth-user-30b2dcd1 ordinal=6988 firstKeptEntryId=<none>",
					],
				]);
			} finally {
				log.mockRestore();
				closeQuietly(db);
			}
		});
	});
}
