import { describe, expect, it, mock, spyOn } from "bun:test";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import type { PendingPiCompactionMarker } from "@magic-context/core/features/magic-context/storage";
import * as logger from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	adaptPiAppendCompaction,
	applyDeferredPiCompactionMarker,
	clearPiCompactionMarkerDrainLogState,
	findLatestCompactionFirstKept,
} from "./compaction-marker-manager-pi";
import { createTestDb } from "./test-utils.test";

function pending(
	overrides: Partial<PendingPiCompactionMarker> = {},
): PendingPiCompactionMarker {
	return {
		firstKeptEntryId: "entry-3",
		endMessageId: "m2",
		ordinal: 2,
		tokensBefore: 200,
		summary: "summary",
		publishedAt: 1,
		...overrides,
	};
}

function branch(extra: unknown[] = []): unknown[] {
	return [
		{ type: "message", id: "entry-1" },
		{ type: "message", id: "entry-2" },
		{ type: "message", id: "entry-3" },
		...extra,
	];
}

describe("Pi deferred compaction marker manager", () => {
	it("blocks an indexed end with an uncovered remainder even with a precomputed kept entry", () => {
		const db = createTestDb();
		try {
			appendCompartments(db, "ses", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "m1",
					endMessageId: "m2",
					endBlockIndex: 0,
					title: "partial",
					content: "partial",
				},
			]);
			const appendCompaction = mock(() => "compact-1");
			expect(
				applyDeferredPiCompactionMarker(
					{ db, readBranchEntries: () => branch(), appendCompaction },
					"ses",
					pending(),
				),
			).toEqual({ kind: "stale-skip", reason: "partial-message-boundary" });
			expect(appendCompaction).not.toHaveBeenCalled();
		} finally {
			closeQuietly(db);
		}
	});

	it("advances past older indexed ends whose successor covers the remainder", () => {
		const db = createTestDb();
		try {
			appendCompartments(db, "ses", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "m1",
					endMessageId: "m1",
					endBlockIndex: 0,
					title: "indexed",
					content: "indexed",
				},
				{
					sequence: 1,
					startMessage: 2,
					endMessage: 2,
					startMessageId: "m2",
					endMessageId: "m2",
					startBlockIndex: 3,
					title: "successor",
					content: "successor",
				},
			]);
			const appendCompaction = mock(() => "compact-1");
			expect(
				applyDeferredPiCompactionMarker(
					{ db, readBranchEntries: () => branch(), appendCompaction },
					"ses",
					pending(),
				).kind,
			).toBe("applied");
			expect(appendCompaction).toHaveBeenCalledTimes(1);
		} finally {
			closeQuietly(db);
		}
	});
	it("findLatestCompactionFirstKept walks newest-first", () => {
		expect(
			findLatestCompactionFirstKept([
				{ type: "compaction", firstKeptEntryId: "old" },
				{ type: "message", id: "entry" },
				{ type: "compaction", firstKeptEntryId: "new" },
			]),
		).toBe("new");
		expect(
			findLatestCompactionFirstKept([{ type: "message", id: "x" }]),
		).toBeNull();
	});

	it("applies pending marker with Pi appendCompaction arguments", () => {
		const db = createTestDb();
		try {
			appendCompartments(db, "ses", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "A",
					content: "B",
				},
			]);
			const appendCompaction = mock(() => "compact-1");
			const outcome = applyDeferredPiCompactionMarker(
				{
					db,
					readBranchEntries: () => branch(),
					appendCompaction,
				},
				"ses",
				pending(),
			);
			expect(outcome).toEqual({
				kind: "applied",
				firstKeptEntryId: "entry-3",
				compactionId: "compact-1",
			});
			expect(appendCompaction).toHaveBeenCalledWith(
				"summary",
				"entry-3",
				200,
				{ source: "magic-context", lastCompactedOrdinal: 2 },
				true,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("returns already-current without appending when latest compaction matches", () => {
		const db = createTestDb();
		try {
			appendCompartments(db, "ses", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "A",
					content: "B",
				},
			]);
			const appendCompaction = mock(() => "compact-1");
			expect(
				applyDeferredPiCompactionMarker(
					{
						db,
						readBranchEntries: () =>
							branch([
								{
									type: "compaction",
									id: "compact-0",
									firstKeptEntryId: "entry-3",
								},
							]),
						appendCompaction,
					},
					"ses",
					pending(),
				).kind,
			).toBe("already-current");
			expect(appendCompaction).not.toHaveBeenCalled();
		} finally {
			closeQuietly(db);
		}
	});

	it("uses stale-reason precedence: compartment-removed before all later checks", () => {
		const db = createTestDb();
		try {
			const outcome = applyDeferredPiCompactionMarker(
				{
					db,
					readBranchEntries: () =>
						branch([{ type: "compaction", firstKeptEntryId: "entry-3" }]),
					appendCompaction: mock(() => "compact"),
				},
				"ses",
				pending({ firstKeptEntryId: "missing" }),
			);
			expect(outcome).toEqual({
				kind: "stale-skip",
				reason: "compartment-removed",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("uses stale-reason precedence: target-superseded before entry-removed/already-current", () => {
		const db = createTestDb();
		try {
			appendCompartments(db, "ses", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 99,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "A",
					content: "B",
				},
			]);
			const outcome = applyDeferredPiCompactionMarker(
				{
					db,
					readBranchEntries: () =>
						branch([{ type: "compaction", firstKeptEntryId: "entry-3" }]),
					appendCompaction: mock(() => "compact"),
				},
				"ses",
				pending({ firstKeptEntryId: "missing" }),
			);
			expect(outcome).toEqual({
				kind: "stale-skip",
				reason: "target-superseded",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("uses stale-reason precedence: entry-removed before already-current", () => {
		const db = createTestDb();
		try {
			appendCompartments(db, "ses", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "A",
					content: "B",
				},
			]);
			const outcome = applyDeferredPiCompactionMarker(
				{
					db,
					readBranchEntries: () =>
						branch([{ type: "compaction", firstKeptEntryId: "missing" }]),
					appendCompaction: mock(() => "compact"),
				},
				"ses",
				pending({ firstKeptEntryId: "missing" }),
			);
			expect(outcome).toEqual({ kind: "stale-skip", reason: "entry-removed" });
		} finally {
			closeQuietly(db);
		}
	});

	it("treats duplicate target compartments as compartment-removed and converts throws to retryable-failure", () => {
		const db = createTestDb();
		try {
			appendCompartments(db, "ses", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "A",
					content: "B",
				},
				{
					sequence: 1,
					startMessage: 3,
					endMessage: 2,
					startMessageId: "m3",
					endMessageId: "m2",
					title: "C",
					content: "D",
				},
			]);
			expect(
				applyDeferredPiCompactionMarker(
					{
						db,
						readBranchEntries: () => branch(),
						appendCompaction: mock(() => "compact"),
					},
					"ses",
					pending(),
				),
			).toEqual({ kind: "stale-skip", reason: "compartment-removed" });
			appendCompartments(db, "ses-throw", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "A",
					content: "B",
				},
			]);
			const retry = applyDeferredPiCompactionMarker(
				{
					db,
					readBranchEntries: () => branch(),
					appendCompaction: () => {
						throw new Error("busy");
					},
				},
				"ses-throw",
				pending(),
			);
			expect(retry.kind).toBe("retryable-failure");
		} finally {
			closeQuietly(db);
		}
	});
	it("treats a newer branch-order compaction as already current", () => {
		const db = createTestDb();
		try {
			appendCompartments(db, "ses", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "A",
					content: "B",
				},
			]);
			const appendCompaction = mock(() => "compact-1");
			const outcome = applyDeferredPiCompactionMarker(
				{
					db,
					readBranchEntries: () =>
						branch([
							{ type: "message", id: "entry-4" },
							{
								type: "compaction",
								id: "compact-0",
								firstKeptEntryId: "entry-4",
							},
						]),
					appendCompaction,
				},
				"ses",
				pending(),
			);
			expect(outcome.kind).toBe("already-current");
			expect(appendCompaction).not.toHaveBeenCalled();
		} finally {
			closeQuietly(db);
		}
	});

	it("retries when appendCompaction returns no id", () => {
		const db = createTestDb();
		try {
			appendCompartments(db, "ses", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "A",
					content: "B",
				},
			]);
			const outcome = applyDeferredPiCompactionMarker(
				{
					db,
					readBranchEntries: () => branch(),
					appendCompaction: mock(() => undefined),
				},
				"ses",
				pending(),
			);
			expect(outcome.kind).toBe("retryable-failure");
		} finally {
			closeQuietly(db);
		}
	});

	it("logs every manager gate once per marker and emits no gate on success", () => {
		const sessionId = "ses-pi-marker-gate-dedupe";
		const db = createTestDb();
		const logSpy = spyOn(logger, "sessionLog").mockImplementation(
			() => undefined,
		);
		const target = (endMessage = 2, endBlockIndex?: number) =>
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage,
					startMessageId: "m1",
					endMessageId: "m2",
					...(endBlockIndex === undefined ? {} : { endBlockIndex }),
					title: "title",
					content: "stored compartment content",
				},
			]);
		const scenarios: Array<{
			gate: string;
			setup: () => {
				pending: PendingPiCompactionMarker;
				entries: unknown[];
				appendCompaction: () => string | undefined;
			};
		}> = [
			{
				gate: "compartment-not-found",
				setup: () => ({
					pending: pending(),
					entries: branch(),
					appendCompaction: () => "compact-1",
				}),
			},
			{
				gate: "duplicate-compartment-end",
				setup: () => {
					appendCompartments(db, sessionId, [
						{
							sequence: 0,
							startMessage: 1,
							endMessage: 2,
							startMessageId: "m1",
							endMessageId: "m2",
							title: "one",
							content: "one",
						},
						{
							sequence: 1,
							startMessage: 3,
							endMessage: 2,
							startMessageId: "m3",
							endMessageId: "m2",
							title: "two",
							content: "two",
						},
					]);
					return {
						pending: pending(),
						entries: branch(),
						appendCompaction: () => "compact-1",
					};
				},
			},
			{
				gate: "target-superseded",
				setup: () => {
					target(99);
					return {
						pending: pending(),
						entries: branch(),
						appendCompaction: () => "compact-1",
					};
				},
			},
			{
				gate: "partial-message-boundary",
				setup: () => {
					target(2, 0);
					return {
						pending: pending(),
						entries: branch(),
						appendCompaction: () => "compact-1",
					};
				},
			},
			{
				gate: "ordinal-alignment-unavailable",
				setup: () => {
					target();
					return {
						pending: pending({ firstKeptEntryId: null }),
						entries: [],
						appendCompaction: () => "compact-1",
					};
				},
			},
			{
				gate: "no-replay-safe-kept-entry",
				setup: () => {
					target();
					return {
						pending: pending({ firstKeptEntryId: null }),
						entries: [
							{
								type: "message",
								id: "m1",
								message: { role: "user", content: "first" },
							},
							{
								type: "message",
								id: "m2",
								message: { role: "assistant", content: "second" },
							},
							{
								type: "message",
								id: "result-entry",
								message: { role: "toolResult", toolCallId: "call-1" },
							},
						],
						appendCompaction: () => "compact-1",
					};
				},
			},
			{
				gate: "kept-entry-not-on-branch",
				setup: () => {
					target();
					return {
						pending: pending({ firstKeptEntryId: "missing-entry" }),
						entries: branch(),
						appendCompaction: () => "compact-1",
					};
				},
			},
			{
				gate: "current-compaction-id-unavailable",
				setup: () => {
					target();
					return {
						pending: pending(),
						entries: branch([
							{ type: "compaction", firstKeptEntryId: "entry-3" },
						]),
						appendCompaction: () => "compact-1",
					};
				},
			},
			{
				gate: "append-compaction-returned-no-id",
				setup: () => {
					target();
					return {
						pending: pending(),
						entries: branch(),
						appendCompaction: () => undefined,
					};
				},
			},
			{
				gate: "manager-threw",
				setup: () => {
					target();
					return {
						pending: pending(),
						entries: [],
						appendCompaction: () => "compact-1",
					};
				},
			},
		];

		try {
			for (const scenario of scenarios) {
				clearPiCompactionMarkerDrainLogState(sessionId);
				db.prepare("DELETE FROM compartments WHERE session_id = ?").run(
					sessionId,
				);
				const configured = scenario.setup();
				for (let pass = 0; pass < 2; pass++) {
					applyDeferredPiCompactionMarker(
						{
							db,
							readBranchEntries:
								scenario.gate === "manager-threw"
									? () => {
											throw Object.assign(
												new Error("private transcript text"),
												{ code: "TEST_MANAGER_FAILURE" },
											);
										}
									: () => configured.entries,
							appendCompaction: configured.appendCompaction,
						},
						sessionId,
						configured.pending,
					);
				}
				const lines = logSpy.mock.calls
					.filter(
						([loggedSession, message]) =>
							loggedSession === sessionId &&
							String(message).includes(`gate=${scenario.gate}`),
					)
					.map(([, message]) => String(message));
				expect(lines, scenario.gate).toHaveLength(1);
				expect(lines[0]).toContain("endMessageId=m2 ordinal=2");
				expect(lines[0]).not.toContain("private transcript text");
				if (scenario.gate === "manager-threw") {
					expect(lines[0]).toContain('errorName="Error"');
					expect(lines[0]).toContain('errorCode="TEST_MANAGER_FAILURE"');
				}
				if (scenario.gate === "append-compaction-returned-no-id")
					expect(lines[0]).toContain('errorName="Error"');
			}

			clearPiCompactionMarkerDrainLogState(sessionId);
			db.prepare("DELETE FROM compartments WHERE session_id = ?").run(
				sessionId,
			);
			target();
			const success = applyDeferredPiCompactionMarker(
				{
					db,
					readBranchEntries: () => branch(),
					appendCompaction: () => "compact-success",
				},
				sessionId,
				pending(),
			);
			expect(success.kind).toBe("applied");
			expect(
				logSpy.mock.calls.filter(([, message]) =>
					String(message).includes("gate="),
				),
			).toHaveLength(scenarios.length);
		} finally {
			clearPiCompactionMarkerDrainLogState(sessionId);
			logSpy.mockRestore();
			closeQuietly(db);
		}
	});
});

// Pi and OMP declare different appendCompaction signatures. MC speaks pi's;
// handing that shape to OMP shifts every argument one slot, so the persisted
// boundary becomes a token count, no entry id matches it, and the compaction
// reclaims nothing. The adapter translates at the host binding.
describe("adaptPiAppendCompaction", () => {
	it("translates pi's argument shape into OMP's", () => {
		const calls: unknown[][] = [];
		function ompHost(
			summary: string,
			shortSummary: string | undefined,
			firstKeptEntryId: string,
			tokensBefore: number,
			options: {
				details?: unknown;
				fromExtension?: boolean;
			} = {},
		): string {
			calls.push([
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				options,
			]);
			return "compact-omp";
		}

		const adapted = adaptPiAppendCompaction(ompHost);
		expect(
			adapted("summary", "entry-3", 200, { source: "magic-context" }, true),
		).toBe("compact-omp");
		expect(calls).toEqual([
			[
				"summary",
				undefined,
				"entry-3",
				200,
				{
					details: { source: "magic-context" },
					fromExtension: true,
				},
			],
		]);
	});

	it("passes pi-shaped hosts through untouched", () => {
		const calls: unknown[][] = [];
		function piHost(
			summary: string,
			firstKeptEntryId: string,
			tokensBefore: number,
			_details?: unknown,
			_fromHook?: boolean,
			_usage?: unknown,
		): string {
			calls.push([summary, firstKeptEntryId, tokensBefore]);
			return "compact-pi";
		}

		const adapted = adaptPiAppendCompaction(piHost);
		expect(adapted("summary", "entry-3", 200)).toBe("compact-pi");
		expect(calls).toEqual([["summary", "entry-3", 200]]);
	});
});
