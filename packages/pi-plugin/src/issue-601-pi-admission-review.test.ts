import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { resetEmergencyRecoveryRegistryForTest } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	__test as contextHandlerInternals,
	registerPiContextHandler,
} from "./context-handler";
import { contextHost } from "./pi-context-host.test";
import { notePiLkgProviderUsage } from "./pi-lkg";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

// Explicit transactions and autocommit writes share a 250 ms synchronous
// acquisition budget for later writes in the turn. The first session-meta write
// also has the shared 16.5 s yielding budget, after trying a valid LKG.
// Pi's 5000 ms connection setting must be restored after every bounded attempt.
const PRODUCTION_PI_BUSY_TIMEOUT_MS = 5000;
const BACKGROUND_HOLD_MS = 3200;
const TURN_BUDGET_MS = 1500;

function holdWriter(path: string, holdMs?: number) {
	const state = new Int32Array(new SharedArrayBuffer(8));
	const errorBytes = new Uint8Array(new SharedArrayBuffer(4096));
	// A synchronous rendezvous stops deferred writes from the preceding context
	// pass racing a zero-timeout BEGIN in the holder. SQLite still runs on another
	// thread, so it can release the lock while the tested turn blocks in SQLite.
	const writer = new Worker(
		`const { workerData } = require('node:worker_threads');
		const { Database } = require('bun:sqlite');
		const state = new Int32Array(workerData.state);
		try {
			const db = new Database(workerData.path);
			db.exec('BEGIN IMMEDIATE');
			Atomics.store(state, 0, 1); Atomics.notify(state, 0);
			Atomics.wait(state, 1, 0, workerData.holdMs);
			db.exec('COMMIT'); db.close();
			Atomics.store(state, 0, 2);
		} catch (error) {
			new Uint8Array(workerData.errorBytes).set(new TextEncoder().encode(String(error)).subarray(0, 4095));
			Atomics.store(state, 0, 3); Atomics.notify(state, 0);
			process.exitCode = 1;
		}`,
		{
			eval: true,
			workerData: {
				path,
				holdMs,
				state: state.buffer,
				errorBytes: errorBytes.buffer,
			},
		},
	);
	let workerError: Error | undefined;
	writer.on("error", (error) => {
		workerError = error;
	});
	const exited = new Promise<number>((resolve) => writer.once("exit", resolve));
	const detail = () =>
		workerError?.message ??
		new TextDecoder().decode(errorBytes).replace(/\0.*$/s, "");
	Atomics.wait(state, 0, 0, PRODUCTION_PI_BUSY_TIMEOUT_MS);
	if (Atomics.load(state, 0) !== 1) {
		void writer.terminate();
		throw new Error(`writer did not acquire lock: ${detail()}`);
	}
	return {
		isHeld: () => Atomics.load(state, 0) === 1,
		release: async () => {
			Atomics.store(state, 1, 1);
			Atomics.notify(state, 1);
			const code = await exited;
			if (code !== 0) throw new Error(`writer exit ${code}: ${detail()}`);
		},
	};
}

describe("Pi in-turn lock wait at the production busy timeout", () => {
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

	it("lock holder acquires before deferred writes and keeps a real SQLite writer lock", async () => {
		const dir = createTestTempDirFromPath(
			join(tmpdir(), "pi-production-timeout-"),
		);
		tempDirs.push(dir);
		const path = join(dir, "context.db");
		const db = createTestDb(path);
		db.exec("PRAGMA busy_timeout=0");
		let deferredRan = false;
		setImmediate(() => {
			deferredRan = true;
		});
		try {
			const writer = holdWriter(path);
			try {
				expect(deferredRan).toBe(false);
				expect(() => db.exec("BEGIN IMMEDIATE")).toThrow("database is locked");
				expect(writer.isHeld()).toBe(true);
			} finally {
				await writer.release();
			}
			db.exec("BEGIN IMMEDIATE; COMMIT");
			// Releasing the lock doesn't guarantee the event loop has reached the
			// check phase yet, so yield once before asserting the deferred work ran.
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(deferredRan).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	it("lock holder reports a competing setup writer instead of losing the ready signal", () => {
		const dir = createTestTempDirFromPath(
			join(tmpdir(), "pi-production-timeout-"),
		);
		tempDirs.push(dir);
		const path = join(dir, "context.db");
		const db = createTestDb(path);
		try {
			db.exec("BEGIN IMMEDIATE");
			expect(() => holdWriter(path)).toThrow("database is locked");
			db.exec("COMMIT");
		} finally {
			closeQuietly(db);
		}
	});

	for (const mode of [
		"complete",
		"measured usage",
		"steady-state measured usage",
		"different-model usage",
		"missing tools API",
		"throwing system API",
		"oversized tools",
	] as const) {
		it(`a production-timeout busy turn ${mode === "complete" ? "replays its last served prefix and new tail" : mode === "different-model usage" ? "ignores different-model usage and replays" : `refuses ${mode}`}`, async () => {
			const dir = createTestTempDirFromPath(
				join(tmpdir(), "pi-production-timeout-"),
			);
			tempDirs.push(dir);
			const path = join(dir, "context.db");
			const db = createTestDb(path);
			const sessionId = `pi-envelope-${mode}`;
			sessions.add(sessionId);
			const host = contextHost();
			const fake = createFakePi();
			Object.assign(fake.pi, host.api, { getAllTools: () => [] });
			const logs: string[] = [];
			const restoreLog =
				contextHandlerInternals.setLkgRecoveryLogObserverForTests((line) =>
					logs.push(line),
				);
			try {
				updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
				db.exec(`PRAGMA busy_timeout=${PRODUCTION_PI_BUSY_TIMEOUT_MS}`);
				registerPiContextHandler(fake.pi as never, { db });
				const handler = fake.handlers.get("context");
				const raw = [userMessage("last served prefix", 1)];
				const ctx = fakeContext(sessionId, dir, ["entry-1"], raw);
				Object.assign(ctx, {
					model: {
						provider: "openai-codex",
						id: "gpt-5.6-sol",
						contextWindow: 272000,
						maxTokens: 68000,
					},
					getSystemPrompt: () => "Complete current system prompt.",
				});
				const first = await host.emit(handler as never, raw, ctx);
				expect(host.controller.signal.aborted).toBe(false);
				await new Promise<void>((resolve) => setImmediate(resolve));
				if (mode === "steady-state measured usage") {
					const unchangedRaw = [userMessage("last served prefix", 1)];
					const unchangedCtx = fakeContext(
						sessionId,
						dir,
						["entry-1"],
						unchangedRaw,
					);
					Object.assign(unchangedCtx, {
						model: ctx.model,
						getSystemPrompt: ctx.getSystemPrompt,
					});
					expect(
						await host.emit(handler as never, unchangedRaw, unchangedCtx),
					).toEqual(first);
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
				const secondRaw = [
					userMessage("last served prefix", 1),
					assistantMessage("new tail", 2),
				];
				if (
					mode === "measured usage" ||
					mode === "steady-state measured usage" ||
					mode === "different-model usage"
				) {
					Object.assign(secondRaw[1], {
						provider: "openai-codex",
						model:
							mode === "different-model usage"
								? "different-model"
								: "gpt-5.6-sol",
						timestamp: Date.now() + 1,
						stopReason: "stop",
						usage: {
							input: 300000,
							cacheRead: 0,
							cacheWrite: 0,
							output: 10,
							totalTokens: 300010,
						},
					});
					expect(
						notePiLkgProviderUsage(sessionId, "entry-1", secondRaw[1]),
					).toBe(mode !== "different-model usage");
				}
				const secondCtx = fakeContext(
					sessionId,
					dir,
					["entry-1", "entry-2"],
					secondRaw,
				);
				Object.assign(secondCtx.sessionManager, {
					getEntry: (id: string) =>
						id === "entry-2"
							? {
									id,
									parentId: "entry-1",
									type: "message",
									message: secondRaw[1],
								}
							: undefined,
				});
				Object.assign(secondCtx, {
					model: ctx.model,
					getSystemPrompt: ctx.getSystemPrompt,
				});
				if (mode === "missing tools API")
					Object.assign(fake.pi, { getAllTools: undefined });
				if (mode === "throwing system API")
					Object.assign(secondCtx, {
						getSystemPrompt: () => {
							throw new Error("unavailable system prompt");
						},
					});
				if (mode === "oversized tools")
					Object.assign(fake.pi, {
						getAllTools: () => [
							{
								name: "huge",
								description: "word ".repeat(220000),
								parameters: { type: "object", properties: {} },
							},
						],
					});
				// Keep replay/refusal turns locked until their assertions finish;
				// a wall-clock release can make a loaded runner test an unlocked turn.
				const writer = holdWriter(path);
				try {
					const started = performance.now();
					const served = await host.emit(
						handler as never,
						secondRaw,
						secondCtx,
					);
					const elapsedMs = performance.now() - started;
					if (process.env.MC_BACKGROUND_BENCHMARK === "1")
						console.info(
							JSON.stringify({
								scenario: mode,
								turnMs: elapsedMs,
								refused: host.controller.signal.aborted,
							}),
						);
					const replayable =
						mode === "complete" || mode === "different-model usage";
					expect(elapsedMs).toBeLessThan(replayable ? TURN_BUDGET_MS : 18000);
					if (!replayable) expect(elapsedMs).toBeGreaterThanOrEqual(16500);
					expect(writer.isHeld()).toBe(true);
					if (mode === "complete" || mode === "different-model usage") {
						expect(logs.join("\n")).toContain("LKG replay served");
						expect(served).toEqual([...first, secondRaw[1]]);
						expect(host.controller.signal.aborted).toBe(false);
					} else host.assertRefused(served, secondRaw);
					if (
						mode === "measured usage" ||
						mode === "steady-state measured usage"
					)
						expect(logs.join("\n")).toContain(
							"lkg_fit_basis=provider_input measured_input=300000",
						);
					if (mode === "different-model usage")
						expect(logs.join("\n")).toContain("lkg_fit_basis=host_metadata");
					expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({
						timeout: PRODUCTION_PI_BUSY_TIMEOUT_MS,
					});
				} finally {
					await writer.release();
				}
			} finally {
				restoreLog();
				closeQuietly(db);
			}
		}, 30000);
	}

	it("waits for a 3.2 s writer and serves a managed first turn without refusal", async () => {
		const dir = createTestTempDirFromPath(
			join(tmpdir(), "pi-production-timeout-"),
		);
		tempDirs.push(dir);
		const path = join(dir, "context.db");
		const db = createTestDb(path);
		try {
			const sessionId = "pi-production-timeout";
			sessions.add(sessionId);
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			db.exec(`PRAGMA busy_timeout=${PRODUCTION_PI_BUSY_TIMEOUT_MS}`);
			const host = contextHost();
			const fake = createFakePi();
			Object.assign(fake.pi, host.api);
			registerPiContextHandler(fake.pi as never, { db });
			const handler = fake.handlers.get("context");
			const writer = holdWriter(path, BACKGROUND_HOLD_MS);
			try {
				const raw = [userMessage("first turn", 1)];
				const ctx = fakeContext(sessionId, dir, ["entry-1"], raw);
				const startedAt = performance.now();
				const served = await host.emit(handler as never, raw, ctx);
				const elapsedMs = performance.now() - startedAt;
				if (process.env.MC_BACKGROUND_BENCHMARK === "1")
					console.info(
						JSON.stringify({
							scenario: "first-turn-3200ms-holder",
							turnMs: elapsedMs,
							refused: host.controller.signal.aborted,
						}),
					);
				expect(elapsedMs).toBeGreaterThanOrEqual(BACKGROUND_HOLD_MS);
				expect(elapsedMs).toBeLessThan(5500);
				expect(writer.isHeld()).toBe(false);
				expect(host.controller.signal.aborted).toBe(false);
				expect(host.entries).toHaveLength(0);
				expect(JSON.stringify(served)).toContain("§1§ first turn");
				expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({
					timeout: PRODUCTION_PI_BUSY_TIMEOUT_MS,
				});
			} finally {
				await writer.release();
			}
		} finally {
			closeQuietly(db);
		}
	}, 30000);
});
