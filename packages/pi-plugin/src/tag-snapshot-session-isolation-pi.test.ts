import { expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { PiContextBudget } from "./pi-context-budget";
import {
	__setPiTagSnapshotWorkerForTests,
	cancelPiTagSnapshotSession,
	drainPiTagSnapshotSession,
	ensurePiTagSnapshotReady,
	getPiTagSnapshotView,
	prewarmPiTagSnapshot,
} from "./tag-snapshot-pi";
import {
	PiTagHydrationError,
	startPiTagSnapshotWorker,
} from "./tag-snapshot-worker-client-pi";

it("a deadline-terminated session cannot refuse another session's hydration", async () => {
	const root = createTestTempDirFromPath(
		join(tmpdir(), "pi-hydration-isolation-"),
	);
	const path = join(root, "context.db");
	const db = new Database(path);
	const sessions = ["deadline-slow", "deadline-small", "deadline-third"];
	try {
		initializeDatabase(db);
		runMigrations(db);
		const insert = db.prepare(`INSERT INTO tags
			(session_id, tag_number, message_id, type, status, byte_size)
			VALUES (?, ?, ?, 'message', 'active', 100)`);
		db.transaction(() => {
			for (let n = 1; n <= 4096; n++) insert.run(sessions[0], n, `entry-${n}`);
			for (const session of sessions.slice(1))
				insert.run(session, 1, "entry-1");
		})();
		const constructed: string[] = [];
		let packets = 0;
		__setPiTagSnapshotWorkerForTests(db, (request, cached) => {
			constructed.push(request.sessionId);
			const slow = request.sessionId === sessions[0];
			return startPiTagSnapshotWorker(
				{ ...request, test: slow ? { pageDelayMs: 50 } : undefined },
				{
					cached,
					deadlineMs: slow ? 600 : 5000,
					beforeAck: async (message) => {
						if (slow && message.type === "packet") packets++;
					},
				},
			);
		});
		let failure: unknown;
		try {
			await ensurePiTagSnapshotReady(db, sessions[0], new PiContextBudget());
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(PiTagHydrationError);
		expect(failure).toMatchObject({ code: "deadline" });
		expect(packets).toBeGreaterThan(0);
		await drainPiTagSnapshotSession(sessions[0]);
		// The failed session still backs off; another session must not inherit it.
		await expect(
			ensurePiTagSnapshotReady(db, sessions[0], new PiContextBudget()),
		).rejects.toBe(failure);
		expect(constructed).toEqual([sessions[0]]);
		cancelPiTagSnapshotSession(sessions[0]);
		for (const session of sessions.slice(1)) {
			let nextFailure: unknown;
			try {
				await ensurePiTagSnapshotReady(db, session, new PiContextBudget());
			} catch (error) {
				nextFailure = error;
			}
			expect(constructed).toContain(session);
			expect(nextFailure).toBeUndefined();
			expect(getPiTagSnapshotView(db, session)).toHaveLength(1);
			cancelPiTagSnapshotSession(session);
			await drainPiTagSnapshotSession(session);
		}
		expect(constructed).toEqual(sessions);
	} finally {
		for (const session of sessions) cancelPiTagSnapshotSession(session);
		await Promise.all(sessions.map(drainPiTagSnapshotSession));
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

function priorityHarness(sessions = ["priority-a", "priority-b"]) {
	const root = createTestTempDirFromPath(
		join(tmpdir(), "pi-hydration-priority-"),
	);
	const db = new Database(join(root, "context.db"));
	initializeDatabase(db);
	runMigrations(db);
	for (const session of sessions) {
		db.prepare(
			"INSERT INTO tags(session_id, tag_number, message_id, type, status, byte_size) VALUES (?, 1, 'entry-1', 'message', 'active', 10)",
		).run(session);
	}
	let entered!: () => void;
	let resume!: () => void;
	const readingA = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const allowA = new Promise<void>((resolve) => {
		resume = resolve;
	});
	const jobs: ReturnType<typeof startPiTagSnapshotWorker>[] = [];
	const starts: string[] = [];
	const cancellations: string[] = [];
	const budgets: PiContextBudget[] = [];
	const turns: Promise<void>[] = [];
	__setPiTagSnapshotWorkerForTests(db, (request, cached) => {
		starts.push(request.sessionId);
		const job = startPiTagSnapshotWorker(request, {
			cached,
			beforeAck: async (message) => {
				if (request.sessionId === "priority-a" && message.type === "packet") {
					entered();
					await allowA;
				}
			},
		});
		jobs.push(job);
		return {
			...job,
			cancel: () => {
				cancellations.push(request.sessionId);
				job.cancel();
			},
		};
	});
	return {
		db,
		starts,
		cancellations,
		readingA,
		resume,
		turn(sessionId: string) {
			const budget = new PiContextBudget();
			budgets.push(budget);
			const pending = Promise.resolve(
				ensurePiTagSnapshotReady(db, sessionId, budget),
			);
			turns.push(pending);
			void pending.catch(() => {});
			return pending;
		},
		async close() {
			for (const budget of budgets) budget.cancel();
			resume();
			db.close();
			for (const job of jobs) job.cancel();
			await Promise.all(jobs.map((job) => job.released));
			await Promise.allSettled(turns);
			rmSync(root, { recursive: true, force: true });
		},
	};
}

it("turn priority: B preempts A's unclaimed prewarm without waiting for its read to finish", async () => {
	const h = priorityHarness();
	try {
		prewarmPiTagSnapshot(h.db, "priority-a");
		await h.readingA;
		const b = h.turn("priority-b");
		expect(h.cancellations).toEqual(["priority-a"]);
		// A's packet acknowledgement is still held: B must not need A to finish.
		await b;
		expect(h.starts).toEqual(["priority-a", "priority-b"]);
		expect(getPiTagSnapshotView(h.db, "priority-b")).toHaveLength(1);
		h.resume();
		await h.turn("priority-a");
		expect(h.starts).toEqual(["priority-a", "priority-b", "priority-a"]);
		expect(getPiTagSnapshotView(h.db, "priority-a")).toHaveLength(1);
	} finally {
		await h.close();
	}
});

it("turn priority: B's prewarm queues without cancelling A's turn", async () => {
	const h = priorityHarness();
	try {
		const a = h.turn("priority-a");
		await h.readingA;
		prewarmPiTagSnapshot(h.db, "priority-b");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(h.cancellations).toEqual([]);
		expect(h.starts).toEqual(["priority-a"]);
		h.resume();
		await a;
		await h.turn("priority-b");
		expect(h.cancellations).toEqual([]);
		expect(h.starts).toEqual(["priority-a", "priority-b"]);
	} finally {
		await h.close();
	}
});

// Subagents run in the parent's process and share one reader, which runs one
// snapshot hydration at a time. A parent
// that starts several children at once sends their first turns within a few
// milliseconds of each other; every one of them has to be served, none
// cancelled.
it("turn priority: first turns of five sessions started together are all served", async () => {
	const children = ["child-1", "child-2", "child-3", "child-4", "child-5"];
	const h = priorityHarness(children);
	try {
		const results = await Promise.allSettled(
			children.map((child) => h.turn(child)),
		);
		expect(results.map((result) => result.status)).toEqual(
			children.map(() => "fulfilled"),
		);
		expect(h.cancellations).toEqual([]);
		expect([...h.starts].sort()).toEqual(children);
		for (const child of children)
			expect(getPiTagSnapshotView(h.db, child)).toHaveLength(1);
	} finally {
		await h.close();
	}
});

it("turn priority: A's joined prewarm becomes a turn that B's turn cannot cancel", async () => {
	const h = priorityHarness();
	try {
		prewarmPiTagSnapshot(h.db, "priority-a");
		await h.readingA;
		const a = h.turn("priority-a");
		const b = h.turn("priority-b");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(h.cancellations).toEqual([]);
		expect(h.starts).toEqual(["priority-a"]);
		h.resume();
		await Promise.all([a, b]);
		expect(h.cancellations).toEqual([]);
		expect(h.starts).toEqual(["priority-a", "priority-b"]);
		expect(getPiTagSnapshotView(h.db, "priority-a")).toHaveLength(1);
		expect(getPiTagSnapshotView(h.db, "priority-b")).toHaveLength(1);
	} finally {
		await h.close();
	}
});
