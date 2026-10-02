/// <reference types="bun-types" />

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { join } from "node:path";
import {
	acquireCompartmentLease,
	COMPARTMENT_LEASE_TTL_MS,
	releaseCompartmentLease,
} from "@magic-context/core/features/magic-context/compartment-lease";
import {
	appendCompartments,
	getCompartments,
	getLastCompartmentEndMessage,
} from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { promoteSessionFactsDurable } from "@magic-context/core/features/magic-context/memory/promotion";
import { getMemoriesByProject } from "@magic-context/core/features/magic-context/memory/storage-memory";
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
import { getSubagentInvocations } from "@magic-context/core/features/magic-context/storage-subagent-invocations";
import { recordChildInvocation } from "@magic-context/core/features/magic-context/subagent-token-capture";
import {
	clearProducerModelObservations,
	observeProducerModelsForTest,
} from "@magic-context/core/hooks/magic-context/producer-window-test-support";
import { hasRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import * as logger from "@magic-context/core/shared/logger";
import { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type {
	SubagentRunner,
	SubagentRunOptions,
} from "@magic-context/core/shared/subagent-runner";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
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

	it("promotes facts from every non-final wrapup window and skips only the final window", async () => {
		const db = createDb();
		try {
			const sessionId = "pi-wrapup-multi-promotion";
			const project = resolveProjectIdentity("/tmp/pi-wrapup");
			const forceKeepFlags: boolean[] = [];
			const runPiHistorianForWrapup = mock(async (args) => {
				const finalWindow = args.forceKeepLastCompartment === true;
				forceKeepFlags.push(finalWindow);
				const chunkNumber = forceKeepFlags.length;
				if (!finalWindow) {
					promoteSessionFactsDurable(db, sessionId, project, [
						{
							category: "PROJECT_RULES",
							content: `Durable Pi wrapup fact from chunk ${chunkNumber}.`,
						},
					]);
				}
				const start = Math.max(
					1,
					getLastCompartmentEndMessage(db, sessionId) + 1,
				);
				const end = args.boundarySnapshot.eligibleEndOrdinal - 1;
				appendRange(db, sessionId, start, end);
				args.onPublished?.();
			});

			const longBranch = branch(12).map((entry) => ({
				...entry,
				message: {
					...entry.message,
					content: `${entry.message.content} ${"alpha beta gamma delta ".repeat(5_000)}`,
				},
			}));
			const result = await runPiWrapup(
				pi().api,
				deps(db, { runPiHistorianForWrapup }),
				ctx(sessionId, longBranch),
				sessionId,
				3,
			);

			expect(result).not.toContain("Magic Wrapup — Partial");
			expect(forceKeepFlags.length).toBeGreaterThan(1);
			expect(forceKeepFlags.at(-1)).toBe(true);
			expect(forceKeepFlags.slice(0, -1).every((flag) => !flag)).toBe(true);
			const promoted = getMemoriesByProject(db, project).map(
				(memory) => memory.content,
			);
			expect(promoted).toHaveLength(forceKeepFlags.length - 1);
			expect(promoted).not.toContain(
				`Durable Pi wrapup fact from chunk ${forceKeepFlags.length}.`,
			);
		} finally {
			closeQuietly(db);
		}
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

	it("shutdown interrupts the lease wait and releases the wrapup marker", async () => {
		const db = createDb();
		const sessionId = "pi-wrapup-shutdown-wait";
		const controller = new AbortController();
		try {
			expect(acquireCompartmentLease(db, sessionId, "foreign")).not.toBeNull();
			const run = runPiWrapup(
				pi().api,
				deps(db, {
					shutdownSignal: controller.signal,
					wrapupLeaseWaitTimeoutMs: 60_000,
				}),
				ctx(sessionId, 8),
				sessionId,
				2,
			);
			await Promise.resolve();
			controller.abort();
			const result = await run;
			expect(result).toContain("## Magic Wrapup — Partial");
			expect(getWrapupInProgressState(db, sessionId)).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("contains SQLITE_BUSY while releasing a wrapup compartment lease", async () => {
		const { dir, cleanup } = createTestTempDir(
			"mc-test-temp-dir-helper-",
			"pi-wrapup-lease-release-",
		);
		const path = join(dir, "context.db");
		const db = new Database(path);
		initializeDatabase(db);
		runMigrations(db);
		db.exec("PRAGMA busy_timeout = 1");
		const blocker = new Database(path);
		blocker.exec("PRAGMA busy_timeout = 1");
		const sessionId = "pi-wrapup-release-contention";
		const now = 2_000_000;
		const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
		let holderId = "";
		let resolveRun!: () => void;
		const underlyingRun = new Promise<void>((resolve) => {
			resolveRun = resolve;
		});
		const runPiHistorianForWrapup = mock(async (args) => {
			holderId = args.compartmentLeaseHolderId ?? "";
			const start = getLastCompartmentEndMessage(db, sessionId) + 1;
			appendRange(
				db,
				sessionId,
				start,
				args.boundarySnapshot.eligibleEndOrdinal - 1,
			);
			await underlyingRun;
		});
		let blockerTransactionOpen = false;
		let releaseFailure: string | undefined;
		const logSpy = spyOn(logger, "sessionLog").mockImplementation(
			(_sid, message) => {
				if (!message.startsWith("lease release failed (")) return;
				releaseFailure = message;
				blocker.exec("ROLLBACK");
				blockerTransactionOpen = false;
			},
		);
		try {
			const wrapup = runPiWrapup(
				pi().api,
				deps(db, { runPiHistorianForWrapup }),
				ctx(sessionId, 8),
				sessionId,
				2,
			);
			while (runPiHistorianForWrapup.mock.calls.length === 0)
				await Promise.resolve();
			expect(holderId).not.toBe("");

			blocker.exec("BEGIN IMMEDIATE");
			blockerTransactionOpen = true;
			resolveRun();

			await expect(wrapup).resolves.toContain("## Magic Wrapup");
			expect(releaseFailure).toMatch(
				/^lease release failed \(.+\); row expires on its TTL$/,
			);
			nowSpy.mockImplementation(() => now + COMPARTMENT_LEASE_TTL_MS + 1);
			expect(
				acquireCompartmentLease(db, sessionId, "replacement-holder"),
			).not.toBeNull();
		} finally {
			if (blockerTransactionOpen) blocker.exec("ROLLBACK");
			logSpy.mockRestore();
			nowSpy.mockRestore();
			closeQuietly(blocker);
			closeQuietly(db);
			cleanup();
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

	it.each([
		[8, 100_000],
		[24, 100],
	])("persists tokens and covers the full target with the real Pi historian (%i messages, %i tokens)", async (messageCount, historianChunkTokens) => {
		const db = createDb();
		try {
			const sessionId = `pi-wrapup-persisted-tokens-${messageCount}`;
			const runner = {
				harness: "pi",
				run: mock(async (options: SubagentRunOptions) => {
					const model = options.model?.split("/") ?? [];
					recordChildInvocation({
						db,
						parentSessionId: options.accountingSessionId ?? "",
						harness: "pi",
						subagent: options.accountingSubagent ?? "historian",
						startedAt: Date.now(),
						status: "completed",
						tokens: { input: 900, output: 100, cacheRead: 200, cacheWrite: 10 },
						providerId: model[0] ?? null,
						modelId: model.slice(1).join("/") || null,
					});
					const ranges = [
						...options.userMessage.matchAll(/Messages (\d+)-(\d+):/g),
					];
					const range = ranges.at(-1);
					if (!range)
						throw new Error("historian prompt did not include a message range");
					const start = Number(range[1]);
					const end = Number(range[2]);
					// Non-final chunks need lookahead so the runner can discard only the last compartment.
					const head =
						start < end
							? `<compartment start="${start}" end="${end - 1}" title="Pi wrapup"><p1>Summarized the eligible Pi history.</p1></compartment>`
							: "";
					return {
						ok: true as const,
						assistantText: `${head}<compartment start="${end}" end="${end}" title="Pi wrapup lookahead"><p1>Summarized the last message.</p1></compartment>`,
						durationMs: 1,
					};
				}),
			} as SubagentRunner;

			const result = await runPiWrapup(
				pi().api,
				deps(db, {
					runner,
					runPiHistorianForWrapup: undefined,
					historianChunkTokens,
				}),
				ctx(
					sessionId,
					branch(messageCount).map((entry, index) => ({
						...entry,
						message: {
							role: index % 2 === 0 ? "user" : "assistant",
							content: [{ type: "text", text: entry.message.content }],
						},
					})),
				),
				sessionId,
				2,
			);

			expect(result).toContain("## Magic Wrapup");
			expect(result).not.toContain("## Magic Wrapup — Partial");
			expect(getLastCompartmentEndMessage(db, sessionId)).toBe(
				messageCount - 2,
			);
			expect(getPendingPiCompactionMarkerState(db, sessionId)?.ordinal).toBe(
				messageCount - 2,
			);
			expect(getWrapupInProgressState(db, sessionId)).toBeNull();
			expect(hasRawMessageProvider(sessionId)).toBe(false);
			const compartments = getCompartments(db, sessionId);
			expect(compartments[0].startMessage).toBe(1);
			for (let i = 1; i < compartments.length; i++) {
				expect(compartments[i].startMessage).toBe(
					compartments[i - 1].endMessage + 1,
				);
			}
			const rows = getSubagentInvocations(db, sessionId);
			if (messageCount === 8) expect(rows).toHaveLength(1);
			else expect(rows.length).toBeGreaterThan(1);
			expect(rows[0]).toMatchObject({
				harness: "pi",
				subagent: "historian",
				providerId: "test",
				modelId: "model",
				inputTokens: 900,
				outputTokens: 100,
				cacheReadTokens: 200,
				cacheWriteTokens: 10,
			});
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

beforeEach(async () => {
	await observeProducerModelsForTest(["test/model"]);
});
afterEach(clearProducerModelObservations);
