import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import {
	recordOverflowDetected,
	resetEmergencyRecoveryRegistryForTest,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { EmergencyFailClosedError } from "@magic-context/core/hooks/magic-context/emergency-fail-closed";
import {
	getInMemorySlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";

import {
	clearContextHandlerSession,
	__test as contextHandlerInternals,
	registerPiContextHandler,
} from "./context-handler";
import { setPiTransformTimingObserver } from "./context-perf-hooks";
import { contextHost } from "./pi-context-host.test";
import { reconcilePiLkgEntryIds } from "./pi-lkg";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

type PiHandler = (
	event: { messages: never[] },
	ctx: never,
) => Promise<{ messages: never[] } | undefined>;

function handlerFor(
	db: ReturnType<typeof createTestDb>,
	host?: ReturnType<typeof contextHost>,
): PiHandler {
	const fake = createFakePi();
	if (host) Object.assign(fake.pi, host.api);
	registerPiContextHandler(fake.pi as never, { db });
	return fake.handlers.get("context") as PiHandler;
}

async function runPass(
	handler: PiHandler,
	sessionId: string,
	messages: unknown[],
	entryIds: string[],
): Promise<{ messages: never[] } | undefined> {
	return handler(
		{ messages: messages as never[] },
		fakeContext(sessionId, process.cwd(), entryIds, messages as never) as never,
	);
}

function nextImmediate(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

describe("Pi LKG JSONL entry-id projection", () => {
	it("fills only unambiguous spans between stable JSONL anchors", () => {
		expect(
			reconcilePiLkgEntryIds(
				["entry-1", undefined, "entry-3", undefined, "entry-5"],
				["entry-1", "entry-2", "entry-3", "entry-4", "entry-5", "extra"],
			),
		).toEqual(["entry-1", "entry-2", "entry-3", "entry-4", "entry-5"]);
	});
});

describe("Pi context handler LKG replay", () => {
	const tempDirs: string[] = [];
	const sessions = new Set<string>();

	afterEach(() => {
		for (const sessionId of sessions) clearContextHandlerSession(sessionId);
		sessions.clear();
		resetLkgSlotsForTest();
		resetEmergencyRecoveryRegistryForTest();
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
		tempDirs.length = 0;
	});

	it("admits first Pi turns during bounded background holds without a saved request", async () => {
		const dir = createTestTempDirFromPath(join(tmpdir(), "pi-bounded-writer-"));
		tempDirs.push(dir);
		const path = join(dir, "context.db");
		const db = createTestDb(path);
		let refused = 0;
		try {
			for (let trial = 0; trial < 3; trial++) {
				const sessionId = `pi-bounded-${trial}`;
				sessions.add(sessionId);
				updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
				db.exec("PRAGMA busy_timeout=5000");
				const host = contextHost();
				const handler = handlerFor(db, host);
				// A separate process can release the lock while the main thread waits
				// synchronously in SQLite. A timer on this thread could not do that.
				const writer = spawn(
					process.execPath,
					[
						"-e",
						`import { Database } from 'bun:sqlite';
					const db = new Database(${JSON.stringify(path)});
					db.exec('BEGIN IMMEDIATE'); console.log('locked');
					setTimeout(() => { db.exec('COMMIT'); db.close(); }, 80);`,
					],
					{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
				);
				const exited = new Promise<void>((resolve, reject) => {
					writer.once("error", reject);
					writer.once("exit", (code) =>
						code === 0 ? resolve() : reject(new Error(`writer exit ${code}`)),
					);
				});
				try {
					await new Promise<void>((resolve, reject) => {
						writer.stdout.once("data", () => resolve());
						writer.once("error", reject);
					});
					const raw = [userMessage(`first turn ${trial}`, 1)];
					const ctx = fakeContext(sessionId, dir, ["entry-1"], raw);
					const startedAt = performance.now();
					await host.emit(handler as never, raw, ctx);
					const elapsedMs = performance.now() - startedAt;
					if (process.env.MC_BACKGROUND_BENCHMARK === "1")
						console.info(
							JSON.stringify({
								scenario: "first-turn-80ms-holder",
								trial,
								turnMs: elapsedMs,
								refused: host.controller.signal.aborted,
							}),
						);
					expect(elapsedMs).toBeLessThan(1500);
					if (host.controller.signal.aborted) refused++;
				} finally {
					await exited;
				}
			}
			expect(refused).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});

	for (const emergency of [true, false]) {
		it(`installed host ${emergency ? "aborts emergency refusals" : "aborts ordinary failures even when raw messages fit"}`, async () => {
			const db = createTestDb();
			const sessionId = `pi-failure-${emergency}`;
			sessions.add(sessionId);
			try {
				const fake = createFakePi();
				const host = contextHost();
				Object.assign(fake.pi, host.api);
				registerPiContextHandler(fake.pi as never, {
					db,
					resolveForProject: () => {
						throw emergency
							? new EmergencyFailClosedError("emergency refusal")
							: new Error("ordinary transform defect");
					},
				});
				const raw = [userMessage("word ".repeat(170000), 1)];
				const ctx = fakeContext(sessionId, process.cwd(), ["entry-1"], raw);
				Object.assign(ctx, {
					model: {
						provider: "openai-codex",
						id: "gpt-5.6-sol",
						contextWindow: 272000,
						maxTokens: 68000,
					},
					// The host reports the same window as the model, so the raw
					// messages (about 170K tokens) fit its 204K usable limit, while
					// their serialized bytes divided by four (the byte proxy the
					// storage-busy fallback uses) do not. Raw messages whose tokens
					// are over the limit are refused instead; that case is in
					// context-handler-degraded-pass.test.ts.
					getContextUsage: () => ({
						tokens: 0,
						percent: 0,
						contextWindow: 272000,
					}),
				});
				const served = await host.emit(
					fake.handlers.get("context") as never,
					raw,
					ctx,
				);
				host.assertRefused(served, raw);
			} finally {
				closeQuietly(db);
			}
		});
	}

	for (const mode of ["handler", "host"]) {
		for (const count of [2812, 300]) {
			it(`fit-guards ${count} raw messages after snapshot, boundary contraction, and SQLITE_BUSY (${mode})`, async () => {
				const dir = createTestTempDirFromPath(join(tmpdir(), "pi-lkg-fit-"));
				tempDirs.push(dir);
				const dbPath = join(dir, "context.db");
				const db = createTestDb(dbPath);
				const sessionId = `pi-lkg-fit-${count}`;
				sessions.add(sessionId);
				const locker = new Database(dbPath);
				const logLines: string[] = [];
				const restoreLog =
					contextHandlerInternals.setLkgRecoveryLogObserverForTests((line) =>
						logLines.push(line),
					);
				try {
					updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
					const host = contextHost();
					const handler = handlerFor(db, mode === "host" ? host : undefined);
					const head = Array.from({ length: 268 }, (_, i) =>
						userMessage(`covered ${i}`, i),
					);
					const raw = Array.from({ length: count }, (_, i) =>
						userMessage("x".repeat(1850), i + 268),
					);
					const ids = Array.from(
						{ length: count },
						(_, i) => `entry-${i + 268}`,
					);
					const firstRaw = [...head, ...raw.slice(0, 1)];
					const firstCtx = fakeContext(
						sessionId,
						process.cwd(),
						[...head.map((_, i) => `entry-${i}`), "entry-268"],
						firstRaw as never,
					);
					const model = {
						provider: "openai-codex",
						id: "gpt-5.6-sol",
						contextWindow: 272000,
						maxTokens: 68000,
					};
					Object.assign(firstCtx, { model });
					const firstServed = await handler(
						{ messages: firstRaw as never[] },
						firstCtx as never,
					);
					expect(firstServed).toBeDefined();
					if (!firstServed) throw new Error("Expected an applied capture pass");

					await nextImmediate();
					appendCompartments(db, sessionId, [
						{
							sequence: 0,
							startMessage: 1,
							endMessage: 268,
							startMessageId: "entry-0",
							endMessageId: "entry-267",
							title: "Published head",
							content: "Covered history",
							p1: "Covered history",
						},
					]);
					// Publication removes only the covered head; replay retains the captured
					// surviving entry and appends untouched new entries.
					db.exec("PRAGMA busy_timeout=0");
					locker.exec("BEGIN IMMEDIATE");
					const ctx = fakeContext(sessionId, process.cwd(), ids, raw as never);
					Object.assign(ctx, {
						model,
						getContextUsage: () => ({
							tokens: 184856,
							percent: 90.6,
							contextWindow: 272000,
						}),
					});
					const pristine = structuredClone(raw);
					const pass =
						mode === "host"
							? host.emit(handler as never, raw, ctx)
							: handler({ messages: raw as never[] }, ctx as never);
					// Requests without measured system and tool definitions are refused even when their byte proxy is small.
					if (mode === "host") host.assertRefused(await pass, pristine);
					else {
						await expect(pass).rejects.toMatchObject({
							name: "PiStorageBusyError",
							message: "Magic Context storage is busy; send your message again",
						});
					}

					expect(logLines).toContain(
						"raw_fallback_refused completeness=partial",
					);
					expect(logLines.join("\n")).not.toContain("LKG replay served");
				} finally {
					if (locker.inTransaction) locker.exec("ROLLBACK");
					restoreLog();
					closeQuietly(locker);
					closeQuietly(db);
				}
			});
		}
	}

	for (const tailBytes of [17, 1_700_000]) {
		it(`host fit-guards LKG replay with ${tailBytes}-byte appended tail`, async () => {
			const dir = createTestTempDirFromPath(join(tmpdir(), "pi-lkg-busy-"));
			tempDirs.push(dir);
			const dbPath = join(dir, "context.db");
			const db = createTestDb(dbPath);
			const sessionId = "pi-lkg-busy";
			const logLines: string[] = [];
			const restoreLog =
				contextHandlerInternals.setLkgRecoveryLogObserverForTests((message) =>
					logLines.push(message),
				);
			sessions.add(sessionId);
			try {
				updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
				const host = contextHost();
				const handler = handlerFor(db, host);
				const firstRaw = [userMessage("original prompt", 1)];
				const model = {
					provider: "openai-codex",
					id: "gpt-5.6-sol",
					contextWindow: 272000,
					maxTokens: 68000,
				};
				const firstCtx = fakeContext(
					sessionId,
					process.cwd(),
					["entry-u1"],
					firstRaw,
				);
				Object.assign(firstCtx, { model });
				const first = await handler(
					{ messages: firstRaw as never[] },
					firstCtx as never,
				);
				expect(first).toBeDefined();
				await nextImmediate();

				const secondRaw = [
					userMessage("original prompt", 1),
					assistantMessage(
						"word ".repeat(Math.ceil(tailBytes / 5)).slice(0, tailBytes),
						2,
					),
				];

				const locker = new Database(dbPath);
				try {
					db.exec("PRAGMA busy_timeout=0");
					locker.exec("PRAGMA busy_timeout=0");
					locker.exec("BEGIN IMMEDIATE");
					const ctx = fakeContext(
						sessionId,
						process.cwd(),
						["entry-u1", "entry-a1"],
						secondRaw,
					);
					Object.assign(ctx, {
						model,
						getContextUsage: () => ({
							tokens: 0,
							percent: 0,
							contextWindow: 272000,
						}),
					});
					const served = await host.emit(handler as never, secondRaw, ctx);

					host.assertRefused(served, secondRaw);
					expect(logLines).toContain(
						"raw_fallback_refused completeness=partial",
					);
					expect(getInMemorySlot(sessionId)).toBeDefined();
				} finally {
					locker.exec("ROLLBACK");
					closeQuietly(locker);
				}
			} finally {
				restoreLog();
				closeQuietly(db);
			}
		});
	}

	it("fails closed instead of serving LKG or raw when emergency recovery meets SQLITE_BUSY", async () => {
		const dir = createTestTempDirFromPath(
			join(tmpdir(), "pi-lkg-emergency-busy-"),
		);
		tempDirs.push(dir);
		const dbPath = join(dir, "context.db");
		const db = createTestDb(dbPath);
		const sessionId = "pi-lkg-emergency-busy";
		sessions.add(sessionId);
		const locker = new Database(dbPath);
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			recordOverflowDetected(db, sessionId, 100_000, "anthropic/fable-5-1");
			const host = contextHost();
			const handler = handlerFor(db, host);
			db.exec("PRAGMA busy_timeout=0");
			locker.exec("PRAGMA busy_timeout=0");
			locker.exec("BEGIN IMMEDIATE");

			await expect(
				runPass(
					handler,
					sessionId,
					[userMessage("overflow retry", 1)],
					["entry-u1"],
				),
			).rejects.toBeInstanceOf(EmergencyFailClosedError);
			const raw = [userMessage("overflow retry", 1)];
			const served = await host.emit(
				handler as never,
				raw,
				fakeContext(sessionId, process.cwd(), ["entry-u1"], raw),
			);
			host.assertRefused(served, raw);
		} finally {
			if (locker.inTransaction) locker.exec("ROLLBACK");
			closeQuietly(locker);
			closeQuietly(db);
		}
	});

	it("refuses divergent LKG and unmeasured raw fallback", async () => {
		const dir = createTestTempDirFromPath(join(tmpdir(), "pi-lkg-diverged-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "context.db");
		const db = createTestDb(dbPath);
		const sessionId = "pi-lkg-diverged";
		sessions.add(sessionId);
		const logLines: string[] = [];
		const restoreLog =
			contextHandlerInternals.setLkgRecoveryLogObserverForTests((message) =>
				logLines.push(message),
			);
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const handler = handlerFor(db);
			const firstRaw = [userMessage("original prompt", 1)];
			expect(
				await runPass(handler, sessionId, firstRaw, ["entry-u1"]),
			).toBeDefined();
			await nextImmediate();

			const editedRaw = [userMessage("edited prompt", 1)];
			const locker = new Database(dbPath);
			try {
				db.exec("PRAGMA busy_timeout=0");
				locker.exec("PRAGMA busy_timeout=0");
				locker.exec("BEGIN IMMEDIATE");
				await expect(
					runPass(handler, sessionId, editedRaw, ["entry-u1-edited"]),
				).rejects.toMatchObject({ code: "PI_STORAGE_BUSY" });

				expect(logLines).toContain(
					"TRANSIENT STORAGE FAILURE SQLITE_BUSY: LKG unavailable (lkg_invalidated_reshape); refusing unreduced 1-message input",
				);
			} finally {
				locker.exec("ROLLBACK");
				closeQuietly(locker);
			}
		} finally {
			restoreLog();
			closeQuietly(db);
		}
	});

	it("logs the exact reason and raw count when a transient lock has no LKG", async () => {
		const dir = createTestTempDirFromPath(join(tmpdir(), "pi-lkg-miss-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "context.db");
		const db = createTestDb(dbPath);
		const sessionId = "pi-lkg-miss";
		sessions.add(sessionId);
		const logLines: string[] = [];
		const restoreLog =
			contextHandlerInternals.setLkgRecoveryLogObserverForTests((message) =>
				logLines.push(message),
			);
		const locker = new Database(dbPath);
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const handler = handlerFor(db);
			db.exec("PRAGMA busy_timeout=0");
			locker.exec("PRAGMA busy_timeout=0");
			locker.exec("BEGIN IMMEDIATE");
			const replay = runPass(
				handler,
				sessionId,
				[
					userMessage("first locked pass", 1),
					assistantMessage("unserved locked tail", 2),
				],
				["entry-u1", "entry-a1"],
			);
			await expect(replay).rejects.toMatchObject({ code: "PI_STORAGE_BUSY" });

			expect(logLines).toContain(
				"TRANSIENT STORAGE FAILURE SQLITE_BUSY: LKG unavailable (lkg_miss); refusing unreduced 2-message input",
			);
		} finally {
			if (locker.inTransaction) locker.exec("ROLLBACK");
			closeQuietly(locker);
			restoreLog();
			closeQuietly(db);
		}
	});

	it("hydrates the durable LKG slot in a fresh handler after a simulated process restart", async () => {
		const dir = createTestTempDirFromPath(join(tmpdir(), "pi-lkg-restart-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "context.db");
		const db = createTestDb(dbPath);
		const sessionId = "pi-lkg-restart";
		sessions.add(sessionId);
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const firstHandler = handlerFor(db);
			const firstRaw = [userMessage("persist this prefix", 1)];
			const first = await runPass(firstHandler, sessionId, firstRaw, [
				"entry-u1",
			]);
			expect(first).toBeDefined();
			await nextImmediate();
			expect(
				db
					.prepare("SELECT session_id FROM lkg_slots WHERE session_id = ?")
					.get(sessionId),
			).toBeDefined();

			clearContextHandlerSession(sessionId);
			resetLkgSlotsForTest();
			const restartedHandler = handlerFor(db);
			const secondRaw = [
				userMessage("persist this prefix", 1),
				assistantMessage("tail after restart", 2),
			];

			const locker = new Database(dbPath);
			try {
				db.exec("PRAGMA busy_timeout=0");
				locker.exec("PRAGMA busy_timeout=0");
				locker.exec("BEGIN IMMEDIATE");
				expect(getInMemorySlot(sessionId)).toBeUndefined();
				await expect(
					runPass(restartedHandler, sessionId, secondRaw, [
						"entry-u1",
						"entry-a1",
					]),
				).rejects.toMatchObject({ code: "PI_STORAGE_BUSY" });
				expect(getInMemorySlot(sessionId)?.jsonPrefix).toContain(
					"persist this prefix",
				);
				expect(getInMemorySlot(sessionId)?.jsonPrefix).not.toContain(
					"tail after restart",
				);
			} finally {
				locker.exec("ROLLBACK");
				closeQuietly(locker);
			}
		} finally {
			closeQuietly(db);
		}
	});

	it("reports deferred LKG capture as the lkgCapture timing stage", async () => {
		const db = createTestDb();
		const sessionId = "pi-lkg-capture-timing";
		const samples: Array<{ stage: string; elapsedMs: number; extra?: string }> =
			[];
		const restoreTiming = setPiTransformTimingObserver((sample) =>
			samples.push(sample),
		);
		sessions.add(sessionId);
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const handler = handlerFor(db);
			expect(
				await runPass(
					handler,
					sessionId,
					[userMessage("timed prompt", 1)],
					["entry-u1"],
				),
			).toBeDefined();
			await nextImmediate();

			const capture = samples.find((sample) => sample.stage === "lkgCapture");
			expect(capture?.elapsedMs).toBeGreaterThanOrEqual(0);
			expect(capture?.extra).toBe("reusedPrefix=0");
		} finally {
			restoreTiming();
			closeQuietly(db);
		}
	});

	it("refreshes LKG on every successful SOFT+ applied pass", async () => {
		const dir = createTestTempDirFromPath(join(tmpdir(), "pi-lkg-refresh-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "context.db");
		const db = createTestDb(dbPath);
		const sessionId = "pi-lkg-refresh";
		sessions.add(sessionId);
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const handler = handlerFor(db);
			const firstRaw = [userMessage("prompt", 1)];
			expect(
				await runPass(handler, sessionId, firstRaw, ["entry-u1"]),
			).toBeDefined();
			await nextImmediate();

			const secondRaw = [
				userMessage("prompt", 1),
				assistantMessage("first tail", 2),
			];
			const second = await runPass(handler, sessionId, secondRaw, [
				"entry-u1",
				"entry-a1",
			]);
			expect(second).toBeDefined();
			await nextImmediate();

			const thirdRaw = [
				userMessage("prompt", 1),
				assistantMessage("first tail", 2),
				userMessage("raw newest tail", 3),
			];

			const locker = new Database(dbPath);
			try {
				db.exec("PRAGMA busy_timeout=0");
				locker.exec("PRAGMA busy_timeout=0");
				locker.exec("BEGIN IMMEDIATE");
				await expect(
					runPass(handler, sessionId, thirdRaw, [
						"entry-u1",
						"entry-a1",
						"entry-u2",
					]),
				).rejects.toMatchObject({ code: "PI_STORAGE_BUSY" });
				expect(getInMemorySlot(sessionId)?.jsonPrefix).toContain("first tail");
				expect(getInMemorySlot(sessionId)?.jsonPrefix).not.toContain(
					"raw newest tail",
				);
			} finally {
				locker.exec("ROLLBACK");
				closeQuietly(locker);
			}
		} finally {
			closeQuietly(db);
		}
	});
});
