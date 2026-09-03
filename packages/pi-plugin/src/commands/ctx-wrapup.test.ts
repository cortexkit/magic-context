/// <reference types="bun-types" />

import { describe, expect, it, mock } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireCompartmentLease,
	releaseCompartmentLease,
} from "@magic-context/core/features/magic-context/compartment-lease";
import {
	appendCompartments,
	getCompartments,
	getLastCompartmentEndMessage,
} from "@magic-context/core/features/magic-context/compartment-storage";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import {
	getOverflowState,
	getPendingPiCompactionMarkerState,
	getWrapupInProgressState,
	recordOverflowDetected,
	setPendingPiCompactionMarkerState,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	consumeDeferredHistoryRefresh,
	consumeDeferredMaterialization,
} from "../context-handler";
import {
	parseWrapupArgs,
	type RegisterCtxWrapupDeps,
	runPiWrapup,
} from "./ctx-wrapup";

function createDb(): Database {
	const db = new Database(":memory:");
	initializeDatabase(db);
	runMigrations(db);
	return db;
}

function createFileDb(name: string): Database {
	const path = join(tmpdir(), `${name}-${crypto.randomUUID()}.db`);
	const db = new Database(path);
	initializeDatabase(db);
	runMigrations(db);
	return db;
}

function branch(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		id: `m-${index + 1}`,
		type: "message",
		timestamp: index + 1,
		message: {
			role: "user",
			content: `message ${index + 1} alpha beta gamma delta`,
		},
	}));
}

function ctx(sessionId: string, source: number | unknown[] = 8) {
	const entries = typeof source === "number" ? branch(source) : source;
	return {
		cwd: "/tmp/pi-wrapup",
		model: { provider: "anthropic", id: "claude" },
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => entries,
		},
		getContextUsage: () => ({ contextWindow: 20, tokens: 1, percent: 1 }),
		ui: { setStatus() {} },
	} as never;
}

function fencedToolArcBranch(): unknown[] {
	return [
		{
			id: "m-1",
			type: "message",
			timestamp: 1,
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-1",
						name: "bash",
						arguments: { cmd: "echo start" },
					},
				],
			},
		},
		{
			id: "m-2",
			type: "message",
			timestamp: 2,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "assistant while tool is pending" }],
			},
		},
		{
			id: "m-3",
			type: "message",
			timestamp: 3,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "more assistant while pending" }],
			},
		},
		{
			id: "m-4",
			type: "message",
			timestamp: 4,
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "tool output" }],
			},
		},
		{
			id: "m-5",
			type: "message",
			timestamp: 5,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "assistant after tool result" }],
			},
		},
		{
			id: "m-6",
			type: "message",
			timestamp: 6,
			message: { role: "user", content: "protected live tail" },
		},
	];
}

function pi() {
	const sent: Array<{ message: { content: string } }> = [];
	return {
		api: {
			sendMessage(message: { content: string }) {
				sent.push({ message });
			},
		} as never,
		sent,
	};
}

function appendRange(
	db: Database,
	sessionId: string,
	start: number,
	end: number,
): void {
	if (end < start) return;
	appendCompartments(db, sessionId, [
		{
			sequence: getCompartments(db, sessionId).length,
			startMessage: start,
			endMessage: end,
			startMessageId: `m-${start}`,
			endMessageId: `m-${end}`,
			title: `Pi ${start}-${end}`,
			content: `Pi ${start}-${end}`,
		},
	]);
}

function deps(
	db: Database,
	overrides: Partial<RegisterCtxWrapupDeps> = {},
): RegisterCtxWrapupDeps {
	return {
		db,
		runner: {} as never,
		historianModel: "test/model",
		historianChunkTokens: 10,
		memoryEnabled: false,
		autoPromote: false,
		runPiHistorianForWrapup: mock(async (args) => {
			const sessionId = args.sessionId;
			const start = getLastCompartmentEndMessage(db, sessionId) + 1;
			const end = Math.min(
				args.boundarySnapshot.eligibleEndOrdinal - 1,
				start + 2,
			);
			appendRange(db, sessionId, start, end);
			args.onPublished?.();
		}),
		...overrides,
	};
}

describe("Pi /ctx-wrapup", () => {
	it("parses optional positive messages_to_keep", () => {
		expect(parseWrapupArgs("")).toEqual({ ok: true, messagesToKeep: 20 });
		expect(parseWrapupArgs(" 7 ")).toEqual({ ok: true, messagesToKeep: 7 });
		expect(parseWrapupArgs("0").ok).toBe(false);
		expect(parseWrapupArgs("two").ok).toBe(false);
	});

	it("refuses subagent sessions", async () => {
		const db = createDb();
		try {
			const sessionId = "pi-subagent-wrapup";
			updateSessionMeta(db, sessionId, { isSubagent: true });
			const runPiHistorianForWrapup = mock(async () => {});

			const result = await runPiWrapup(
				pi().api,
				deps(db, { runPiHistorianForWrapup }),
				ctx(sessionId, 8),
				sessionId,
				2,
			);

			expect(result).toContain("only available in primary sessions");
			expect(runPiHistorianForWrapup).not.toHaveBeenCalled();
		} finally {
			closeQuietly(db);
		}
	});

	it("stops on no progress and releases the durable marker", async () => {
		const db = createDb();
		try {
			const sessionId = "pi-no-progress";
			const result = await runPiWrapup(
				pi().api,
				deps(db, {
					runPiHistorianForWrapup: mock(async () => {}),
				}),
				ctx(sessionId, 8),
				sessionId,
				2,
			);

			expect(result).toContain("## Magic Wrapup — Partial");
			expect(result).toContain("No forward progress");
			expect(result).toContain("Run /ctx-wrapup again to continue");
			const row = db
				.prepare(
					"SELECT wrapup_in_progress_state FROM session_meta WHERE session_id = ?",
				)
				.get(sessionId) as { wrapup_in_progress_state: string | null } | null;
			expect(row?.wrapup_in_progress_state ?? null).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("bounds waiting for a foreign compartment lease and clears the wrapup marker", async () => {
		const db = createDb();
		try {
			const sessionId = "pi-wrapup-lease-timeout";
			const foreignHolder = "foreign-lease-holder";
			expect(
				acquireCompartmentLease(db, sessionId, foreignHolder),
			).not.toBeNull();
			const runPiHistorianForWrapup = mock(async () => {});

			const result = await runPiWrapup(
				pi().api,
				deps(db, {
					runPiHistorianForWrapup,
					wrapupLeaseWaitTimeoutMs: 0,
				}),
				ctx(sessionId, 8),
				sessionId,
				2,
			);

			expect(result).toContain("## Magic Wrapup — Partial");
			expect(result).toContain("Timed out waiting");
			expect(runPiHistorianForWrapup).not.toHaveBeenCalled();
			expect(getWrapupInProgressState(db, sessionId)).toBeNull();
			releaseCompartmentLease(db, sessionId, foreignHolder);
		} finally {
			closeQuietly(db);
		}
	});

	it("survives a busy-database lease release failure without rejecting", async () => {
		// Cross-connection lock contention requires a shared file; two :memory:
		// databases never contend. Mirrors the production shape: a second
		// connection (omp session, dreamer, FTS indexer) holds BEGIN IMMEDIATE
		// past busy_timeout while wrapup releases its compartment lease.
		const db = createFileDb("pi-wrapup-busy-release");
		try {
			const sessionId = "pi-wrapup-busy-release";
			const runPiHistorianForWrapup = mock(async (args) => {
				const start = getLastCompartmentEndMessage(db, sessionId) + 1;
				const end = Math.min(
					args.boundarySnapshot.eligibleEndOrdinal - 1,
					start + 2,
				);
				appendRange(db, sessionId, start, end);
				args.onPublished?.();
				// Simulate the production contention window: another process holds
				// the writer lock past busy_timeout while wrapup releases its lease.
				const blocker = new Database(db.filename);
				blocker.exec("PRAGMA busy_timeout=1; BEGIN IMMEDIATE;");
				try {
					// Shrink the release connection's busy wait so the expected
					// SQLITE_BUSY lands well inside bun's 5s default test timeout
					// (initializeDatabase sets 5000ms; plain `bun test` in CI has
					// no override — project constraint #5917).
					db.exec("PRAGMA busy_timeout=250");
					releaseCompartmentLease(db, sessionId, "stale-holder");
				} finally {
					blocker.exec("ROLLBACK");
					blocker.close();
				}
			});

			const result = await runPiWrapup(
				pi().api,
				deps(db, { runPiHistorianForWrapup }),
				ctx(sessionId, 8),
				sessionId,
				2,
			);

			expect(result).toContain("## Magic Wrapup");
			expect(getWrapupInProgressState(db, sessionId)).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("signals deferred history and materialization after a wrapup publish", async () => {
		const db = createDb();
		try {
			const sessionId = "pi-wrapup-signals";
			const result = await runPiWrapup(
				pi().api,
				deps(db, {
					runPiHistorianForWrapup: mock(async (args) => {
						appendRange(db, sessionId, 1, 3);
						args.onPublished?.();
					}),
				}),
				ctx(sessionId, 8),
				sessionId,
				2,
			);

			expect(result).toContain("## Magic Wrapup");
			expect(consumeDeferredHistoryRefresh(sessionId)).toBe(true);
			expect(consumeDeferredMaterialization(sessionId)).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	it("passes the active session model as the wrapup historian last-resort fallback", async () => {
		const db = createDb();
		try {
			const sessionId = "pi-wrapup-session-model";
			const runPiHistorianForWrapup = mock(async (args) => {
				appendRange(db, sessionId, 1, 3);
				args.onPublished?.();
			});

			await runPiWrapup(
				pi().api,
				deps(db, { runPiHistorianForWrapup }),
				ctx(sessionId, 8),
				sessionId,
				2,
			);

			expect(runPiHistorianForWrapup).toHaveBeenCalledWith(
				expect.objectContaining({ fallbackModelId: "anthropic/claude" }),
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("aborts when wrapup marker ownership is lost and leaves the foreign marker", async () => {
		const db = createDb();
		try {
			const sessionId = "pi-ownership-lost";
			let calls = 0;
			const result = await runPiWrapup(
				pi().api,
				deps(db, {
					runPiHistorianForWrapup: mock(async (args) => {
						calls += 1;
						appendRange(db, sessionId, 1, 3);
						args.onPublished?.();
						const state = getWrapupInProgressState(db, sessionId);
						expect(state).not.toBeNull();
						db.prepare(
							"UPDATE session_meta SET wrapup_in_progress_state = ? WHERE session_id = ?",
						).run(
							JSON.stringify({
								...state,
								holderId: "foreign-holder",
								updatedAt: Date.now(),
								expiresAt: Date.now() + 60_000,
							}),
							sessionId,
						);
					}),
				}),
				ctx(sessionId, 10),
				sessionId,
				2,
			);

			expect(result).toContain("## Magic Wrapup — Partial");
			expect(result).toContain(
				"another process took over this session's wrapup",
			);
			expect(calls).toBe(1);
			expect(getWrapupInProgressState(db, sessionId)?.holderId).toBe(
				"foreign-holder",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("leaves the pending Pi marker queued until the next consuming context pass", async () => {
		const db = createDb();
		try {
			const sessionId = "pi-marker-pending";
			const result = await runPiWrapup(
				pi().api,
				deps(db, {
					runPiHistorianForWrapup: mock(async (args) => {
						const start = getLastCompartmentEndMessage(db, sessionId) + 1;
						const end = Math.min(
							args.boundarySnapshot.eligibleEndOrdinal - 1,
							start + 2,
						);
						appendRange(db, sessionId, start, end);
						setPendingPiCompactionMarkerState(db, sessionId, {
							firstKeptEntryId: `m-${end + 1}`,
							endMessageId: `m-${end}`,
							ordinal: end,
							tokensBefore: 123 + end,
							summary: `pending marker ${end}`,
							publishedAt: Date.now(),
						});
						args.onPublished?.();
					}),
				}),
				ctx(sessionId, 8),
				sessionId,
				2,
			);

			expect(result).toContain("## Magic Wrapup");
			expect(result).not.toContain("## Magic Wrapup — Partial");
			expect(getLastCompartmentEndMessage(db, sessionId)).toBe(6);
			expect(getPendingPiCompactionMarkerState(db, sessionId)).toEqual(
				expect.objectContaining({ ordinal: 6, endMessageId: "m-6" }),
			);
			expect(consumeDeferredHistoryRefresh(sessionId)).toBe(true);
			expect(consumeDeferredMaterialization(sessionId)).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	it("reports partial when a fenced boundary has no runnable wrapup window", async () => {
		const db = createDb();
		try {
			const sessionId = "pi-wrapup-fenced-zero-progress";
			recordOverflowDetected(db, sessionId, 20, "anthropic/claude");
			const result = await runPiWrapup(
				pi().api,
				deps(db),
				ctx(sessionId, fencedToolArcBranch()),
				sessionId,
				3,
			);

			expect(result).toContain("## Magic Wrapup — Partial");
			expect(result).toContain("No runnable wrapup boundary");
			expect(result).toContain("Run /ctx-wrapup again");
			expect(getLastCompartmentEndMessage(db, sessionId)).toBe(-1);
			expect(getOverflowState(db, sessionId).needsEmergencyRecovery).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});
});
