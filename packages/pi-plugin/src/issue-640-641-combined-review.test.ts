import { afterEach, expect, test } from "bun:test";
import type { PiContextBudget } from "./pi-context-budget";
import { registerPiGuardedContext } from "./pi-context-refusal";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext, userMessage } from "./test-utils.test";

function dispatchHarness() {
	__setPiHarnessKindForTesting("omp");
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const refusals: string[] = [];
	let budget!: PiContextBudget;
	const pi = {
		on: (name: string, fn: (...args: unknown[]) => unknown) =>
			handlers.set(name, fn),
		appendEntry: (_name: string, data: { message: string }) =>
			refusals.push(data.message),
	};
	registerPiGuardedContext(pi as never, async (event, _ctx, pass) => {
		budget = pass;
		return { messages: event.messages };
	});
	let aborts = 0;
	const ctx = {
		...fakeContext("combined-dispatch"),
		ui: { notify: () => undefined },
		abort: () => aborts++,
	};
	return {
		ctx,
		refusals,
		get budget() {
			return budget;
		},
		get aborts() {
			return aborts;
		},
		invoke: (name: string, event: unknown) => {
			const handler = handlers.get(name);
			if (!handler) throw new Error(`missing ${name} handler`);
			return handler(event, ctx);
		},
	};
}

afterEach(() => __setPiHarnessKindForTesting(undefined));

test("combined review: a completed managed receipt survives delayed provider retries", async () => {
	const h = dispatchHarness();
	h.invoke("agent_start", {});
	await h.invoke("context", { messages: [userMessage("managed", 1)] });
	expect(h.budget.completed).toBe(true);
	h.invoke("before_provider_request", { payload: { messages: [] } });
	expect(h.aborts).toBe(0);
	// Provider backoff does not restart context preparation. Its completed result
	// remains managed even when the next payload attempt is more than 25s later.
	h.budget.elapsed = () => 26_000;
	h.invoke("before_provider_request", { payload: { messages: [] } });
	expect(h.refusals).toEqual([]);
	expect(h.aborts).toBe(0);
});

test("combined review control: an unfinished receipt is refused at dispatch", () => {
	const h = dispatchHarness();
	h.invoke("agent_start", {});
	h.invoke("before_provider_request", { payload: undefined });
	expect(h.refusals).toHaveLength(1);
	expect(h.aborts).toBe(1);
});

const sideReminder =
	"<system-reminder>\nEphemeral side-channel turn; reuses current conversation context.\nTool catalog attached only to keep prompt cache warm; tools NOT available this turn.\nDo NOT emit tool calls; reply plain text only. Tool calls discarded without execution.\n</system-reminder>";

// The session latch disables receipt enforcement after a verified side context.
// Oh My Pi (OMP) 18.8.6 runner.ts:1993-2004,2052-2065 withholds the side request's
// cancellation signal from context and payload hooks. runEphemeralTurn
// (agent-session.ts:10943-11121) emits no side completion event. A main agent_end
// therefore cannot justify clearing the latch: the session-wide abort could
// cancel a side retry still running. Retain this expected failure until the host
// supplies IDs distinguishing main and side requests, or side completion events.
test.failing("combined review: a previous side context must not authorize a later unmanaged main request", async () => {
	const h = dispatchHarness();
	h.invoke("agent_start", {});
	await h.invoke("context", {
		messages: [
			{
				role: "developer",
				attribution: "agent",
				content: sideReminder,
				timestamp: 1,
			},
			{ ...userMessage("side prompt", 2), attribution: "agent" },
		],
	});
	h.invoke("agent_end", {});
	h.invoke("agent_start", {});
	// OMP may dispatch after a mandatory context callback timed out without
	// returning. The prior turn's side-channel classification is not a receipt.
	h.invoke("before_provider_request", {
		payload: { messages: [{ role: "user", content: "unmanaged main" }] },
	});
	expect(h.refusals).toHaveLength(1);
	expect(h.aborts).toBe(1);
});

test.skipIf(process.env.MC_COMBINED_TIMING !== "1")(
	"combined review timing: a 20s writer refuses before OMP's 30s deadline",
	async () => {
		const { join } = await import("node:path");
		const { createTestTempDir } = await import(
			"../../plugin/src/shared/test-temp-dir"
		);
		const { createFakePi, createTestDb, textOf } = await import(
			"./test-utils.test"
		);
		const { registerPiContextHandler, clearContextHandlerSession, __test } =
			await import("./context-handler");
		const { getSlot, resetLkgSlotsForTest } = await import(
			"../../plugin/src/hooks/magic-context/lkg-slot"
		);
		const { getPiServedTagNumbers } = await import("./served-array-ledger");
		const { dir, cleanup } = createTestTempDir("combined-writer-20s-");
		const db = createTestDb(join(dir, "context.db"));
		const sessionId = "combined-writer-20s";
		const raw = Array.from({ length: 6000 }, (_, index) =>
			userMessage(`message ${index} ${"ordinary words ".repeat(7)}`, index + 1),
		);
		const holder = Bun.spawn(
			[
				"python3",
				"-u",
				"-c",
				'import sqlite3,sys,time;c=sqlite3.connect(sys.argv[1]);c.execute("BEGIN IMMEDIATE");print("locked",flush=True);time.sleep(20);c.rollback()',
				join(dir, "context.db"),
			],
			{ stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
		);
		const restoreHistory = __test.setInFlightHistorianForTests(
			sessionId,
			new Promise<void>(() => {}),
		);
		try {
			const reader = holder.stdout.getReader();
			expect(new TextDecoder().decode((await reader.read()).value)).toContain(
				"locked",
			);
			reader.releaseLock();
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				protectedTags: 6100,
				autoSearch: { enabled: true, scoreThreshold: 0.5, minPromptChars: 10 },
			});
			const ctx = {
				...fakeContext(
					sessionId,
					process.cwd(),
					raw.map((_, i) => `entry-${i}`),
					raw,
				),
				getContextUsage: () => ({
					tokens: 960000,
					percent: 96,
					contextWindow: 1000000,
				}),
			};
			const start = performance.now();
			const handler = fake.handlers.get("context");
			if (!handler) throw new Error("context handler missing");
			const error = await Promise.resolve(
				handler({ messages: raw } as never, ctx as never),
			).then(
				() => null,
				(reason: unknown) => reason,
			);
			const elapsed = performance.now() - start;
			expect(error).not.toBeNull();
			expect(elapsed).toBeLessThan(30000);
			expect(holder.exitCode).toBeNull();
			expect(
				db.prepare("SELECT * FROM tags WHERE session_id=?").all(sessionId),
			).toEqual([]);
			expect(getSlot(sessionId)).toBeUndefined();
			expect(getPiServedTagNumbers(sessionId).size).toBe(0);
			console.log(
				"COMBINED_WRITER_20S",
				JSON.stringify({
					elapsedMs: elapsed,
					holdMs: 20000,
					messages: raw.length,
					outcome: String(error),
					managedPrefix: textOf(raw[0]).includes("§"),
				}),
			);
		} finally {
			await holder.exited;
			restoreHistory();
			clearContextHandlerSession(sessionId);
			resetLkgSlotsForTest();
			db.close();
			cleanup();
		}
	},
	40000,
);

test("combined review: expired cold auto-search must not freeze an unserved skip", async () => {
	const { spyOn } = await import("bun:test");
	const snapshots = await import(
		"@magic-context/core/features/magic-context/memory/embedding"
	);
	const { guardSqliteTransformPass, withSqliteTransformPass } = await import(
		"@magic-context/core/shared/sqlite"
	);
	const { wasAutoSearchSkipped } = await import(
		"@magic-context/core/hooks/magic-context/auto-search-deadline"
	);
	const { getAutoSearchHintDecisions } = await import(
		"@magic-context/core/features/magic-context/storage"
	);
	const { createTestDb } = await import("./test-utils.test");
	const { runAutoSearchHintForPi, clearAutoSearchForPiSession } = await import(
		"./auto-search-pi"
	);
	const { PiContextBudget } = await import("./pi-context-budget");
	const db = createTestDb();
	const sessionId = "combined-cold-search";
	let now = 0;
	const budget = new PiContextBudget(0, () => now);
	const snapshot = spyOn(
		snapshots,
		"getProjectEmbeddingSnapshot",
	).mockImplementation(() => {
		// Simulate cold search preparation crossing the outcome deadline. SQLite
		// blocks the hint row, but the in-memory skipped-turn cache must also stay
		// empty: otherwise a retry of this unserved user turn will not search.
		now = 26000;
		return null;
	});
	try {
		const pending = withSqliteTransformPass(() => {
			guardSqliteTransformPass({
				assert: budget.assert,
				remainingMs: () => budget.remainingWork(),
			});
			return runAutoSearchHintForPi({
				sessionId,
				db,
				messages: [userMessage("Explain writer admission for this fixture", 1)],
				entryIds: ["u1"],
				options: {
					enabled: true,
					projectPath: "github.com/example/combined",
					scoreThreshold: 0.5,
					minPromptChars: 10,
				},
				passGuard: { assert: budget.assert, wait: budget.wait },
			});
		});
		await expect(pending).rejects.toThrow();
		expect(getAutoSearchHintDecisions(db, sessionId)).toEqual([]);
		expect(wasAutoSearchSkipped(db, sessionId, "u1")).toBe(false);
	} finally {
		snapshot.mockRestore();
		clearAutoSearchForPiSession(sessionId);
		db.close();
	}
});

test.skipIf(process.env.MC_COMBINED_STALL !== "1")(
	"combined review timing: synchronous branch projection stays below OMP's deadline",
	async () => {
		const { createFakePi, createTestDb } = await import("./test-utils.test");
		const { registerPiContextHandler, clearContextHandlerSession } =
			await import("./context-handler");
		const db = createTestDb();
		const sessionId = "combined-blocked-branch";
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, { db });
		const raw = [userMessage("branch projection stall", 1)];
		const ctx = fakeContext(sessionId, process.cwd(), ["u1"], raw);
		const readBranch = ctx.sessionManager.getBranch;
		let calls = 0;
		ctx.sessionManager.getBranch = () => {
			calls++;
			// A host callback is synchronous; the plugin cannot preempt its disk or
			// CPU work with Promise.race. Exercise that boundary with real time.
			Bun.sleepSync(31000);
			return readBranch();
		};
		try {
			const handler = fake.handlers.get("context");
			if (!handler) throw new Error("context handler missing");
			const start = performance.now();
			const error = await Promise.resolve(
				handler({ messages: raw } as never, ctx as never),
			).then(
				() => null,
				(reason: unknown) => reason,
			);
			const elapsed = performance.now() - start;
			expect(calls).toBe(1);
			expect(error).not.toBeNull();
			expect(
				db.prepare("SELECT * FROM tags WHERE session_id=?").all(sessionId),
			).toEqual([]);
			console.log(
				"COMBINED_SYNC_STALL",
				JSON.stringify({
					elapsedMs: elapsed,
					stallMs: 31000,
					outcome: String(error),
				}),
			);
			expect(elapsed).toBeLessThan(30000);
		} finally {
			clearContextHandlerSession(sessionId);
			db.close();
		}
	},
	45000,
);
