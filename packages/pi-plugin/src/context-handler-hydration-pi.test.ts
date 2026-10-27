import { afterEach, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getTagsBySession,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import {
	getInMemorySlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { setPiTransformTimingObserver } from "./context-perf-hooks";
import { PI_CONTEXT_BUDGET, PiContextBudget } from "./pi-context-budget";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
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
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	setPiTransformTimingObserver(undefined);
	__setPiHarnessKindForTesting(undefined);
	resetLkgSlotsForTest();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function harness(messages = [userMessage("Deterministic first prompt.", 1)]) {
	__setPiHarnessKindForTesting("omp");
	const root = createTestTempDirFromPath(
		join(tmpdir(), "pi-handler-hydration-"),
	);
	const path = join(root, "context.db");
	const db = createTestDb(path);
	const foreign = new Database(path);
	initializeDatabase(foreign);
	const sessionId = "hydration-handler";
	const fake = createFakePi();
	const refusals: string[] = [];
	let blocked = false;
	let dispatches = 0;
	const jobs: ReturnType<typeof startPiTagSnapshotWorker>[] = [];
	Object.assign(fake.pi, {
		appendEntry: (_type: string, data: { message?: string }) => {
			if (data.message) refusals.push(data.message);
		},
	});
	registerPiContextHandler(fake.pi as never, { db, protectedTags: 0 });
	const ctx = Object.assign(
		fakeContext(
			sessionId,
			root,
			messages.map((_, index) => `entry-${index + 1}`),
			messages,
		),
		{
			abort: () => {
				blocked = true;
			},
			model: {
				provider: "openai",
				id: "gpt-4.1",
				api: "openai-completions",
				contextWindow: 100000,
				maxTokens: 16000,
			},
		},
	);
	const handler = fake.handlers.get("context") as (
		event: { messages: unknown[] },
		ctx: unknown,
	) => Promise<{ messages: unknown[] } | undefined>;
	const call = async () => {
		blocked = false;
		fake.handlers.get("agent_start")?.({} as never, ctx as never);
		const raw = structuredClone(messages);
		ctx.sessionManager.getBranch = () =>
			raw.map((message, index) => ({
				type: "message",
				id: `entry-${index + 1}`,
				message,
			}));
		const result = await handler({ messages: raw }, ctx);
		const fence = fake.handlers.get("before_provider_request");
		if (!fence) throw new Error("real provider dispatch fence missing");
		fence(
			{ payload: { messages: result?.messages ?? messages } } as never,
			ctx as never,
		);
		if (!blocked) dispatches++;
		return result;
	};
	const slowWorker = (openDelayMs: number) => {
		__setPiTagSnapshotWorkerForTests(db, (request, cached) => {
			const job = startPiTagSnapshotWorker(
				{ ...request, test: { openDelayMs } },
				{ cached },
			);
			jobs.push(job);
			return job;
		});
	};
	cleanups.push(async () => {
		clearContextHandlerSession(sessionId);
		for (const job of jobs) {
			job.cancel();
			await job.released;
		}
		foreign.close();
		db.close();
		rmSync(root, { recursive: true, force: true });
	});
	return {
		db,
		foreign,
		sessionId,
		call,
		slowWorker,
		refusals,
		messages,
		track: (job: ReturnType<typeof startPiTagSnapshotWorker>) => {
			jobs.push(job);
			return job;
		},
		get dispatches() {
			return dispatches;
		},
		get starts() {
			return jobs.length;
		},
	};
}

it("own first allocation after empty hydration serves a complete canonical snapshot", async () => {
	const h = harness();
	const result = await h.call();
	expect(h.dispatches).toBe(1);
	expect(h.refusals).toEqual([]);
	expect(result?.messages.length).toBeGreaterThan(0);
	expect(getPiTagSnapshotView(h.db, h.sessionId)).toEqual(
		getTagsBySession(h.db, h.sessionId),
	);
	expect(
		h.db
			.prepare("SELECT seen FROM pi_tag_first_allocation WHERE session_id = ?")
			.get(h.sessionId),
	).toEqual({ seen: 1 });
});

for (const mode of [
	"foreign first allocation",
	"foreign write interleaved with own allocation",
	"incarnation ABA",
] as const) {
	it(`${mode} after empty hydration refuses through the provider fence`, async () => {
		const h = harness();
		let injected = false;
		setPiTransformTimingObserver((sample) => {
			if (
				injected ||
				sample.sessionId !== h.sessionId ||
				sample.stage !==
					(mode === "foreign first allocation"
						? "tagSnapshotSync"
						: "tagMessages")
			)
				return;
			injected = true;
			if (mode === "incarnation ABA") {
				h.foreign
					.prepare("DELETE FROM schema_migrations_meta WHERE key = ?")
					.run(`tag_revision:${h.sessionId}`);
				h.foreign
					.prepare(
						"UPDATE tags SET byte_size = byte_size + 1 WHERE session_id = ?",
					)
					.run(h.sessionId);
			} else
				h.foreign
					.prepare(
						"INSERT INTO tags (session_id, tag_number, message_id, type, status, byte_size) VALUES (?, 1000000, 'foreign-entry', 'message', 'dropped', 13)",
					)
					.run(h.sessionId);
		});
		await h.call();
		expect(injected).toBe(true);
		expect(h.dispatches).toBe(0);
		expect(h.refusals.join("\n")).toContain("Pi tag hydration");
		expect(getTagsBySession(h.foreign, h.sessionId).length).toBeGreaterThan(0);
	});
}

it("a five second cold load waits asynchronously and serves normally", async () => {
	const h = harness();
	h.slowWorker(5000);
	let heartbeats = 0;
	const heartbeat = setInterval(() => {
		heartbeats++;
	}, 10);
	try {
		await h.call();
		expect(h.starts).toBe(1);
		expect(h.dispatches).toBe(1);
		expect(h.refusals).toEqual([]);
		expect(heartbeats).toBeGreaterThan(100);
	} finally {
		clearInterval(heartbeat);
	}
}, 15000);

it("not-ready hydration refuses even with a valid LKG", async () => {
	const h = harness();
	await h.call();
	expect(h.dispatches).toBe(1);
	expect(getInMemorySlot(h.sessionId)).toBeDefined();
	h.foreign
		.prepare("UPDATE tags SET status = 'dropped' WHERE session_id = ?")
		.run(h.sessionId);
	queuePendingOp(h.db, h.sessionId, 999, "drop", 1);
	const tags = JSON.stringify(getTagsBySession(h.db, h.sessionId));
	const pending = JSON.stringify(
		h.db
			.prepare("SELECT * FROM pending_ops WHERE session_id = ? ORDER BY id")
			.all(h.sessionId),
	);
	const slot = getInMemorySlot(h.sessionId);
	h.slowWorker(5000);
	const started = performance.now();
	const elapsed = spyOn(
		PiContextBudget.prototype,
		"elapsed",
	).mockImplementation(
		() =>
			PI_CONTEXT_BUDGET.workMs -
			PI_CONTEXT_BUDGET.completionReserveMs -
			500 +
			performance.now() -
			started,
	);
	try {
		await h.call();
	} finally {
		elapsed.mockRestore();
	}
	expect(h.starts).toBe(1);
	expect(h.dispatches).toBe(1);
	expect(h.refusals.join("\n")).toContain(
		"remaining pass budget exhausted waiting for tag snapshot",
	);
	expect(JSON.stringify(getTagsBySession(h.db, h.sessionId))).toBe(tags);
	expect(
		JSON.stringify(
			h.db
				.prepare("SELECT * FROM pending_ops WHERE session_id = ? ORDER BY id")
				.all(h.sessionId),
		),
	).toBe(pending);
	expect(getInMemorySlot(h.sessionId)).toEqual(slot);
});

it("hydration never serves a partial tag snapshot", async () => {
	const h = harness();
	h.db.transaction(() => {
		const insert = h.db.prepare(
			"INSERT INTO tags(session_id, tag_number, message_id, type, status, byte_size) VALUES (?, ?, ?, 'message', 'active', 13)",
		);
		for (let n = 1; n <= 600; n++) insert.run(h.sessionId, n, `older-${n}`);
	})();
	let entered!: () => void;
	let release!: () => void;
	const first = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const credit = new Promise<void>((resolve) => {
		release = resolve;
	});
	let held = false;
	__setPiTagSnapshotWorkerForTests(h.db, (request, cached) =>
		h.track(
			startPiTagSnapshotWorker(request, {
				cached,
				beforeAck: async (message) => {
					if (message.type === "packet" && !held) {
						held = true;
						entered();
						await credit;
					}
				},
			}),
		),
	);
	const pending = h.call();
	try {
		await first;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(h.dispatches).toBe(0);
		expect(() => getPiTagSnapshotView(h.db, h.sessionId)).toThrow("not ready");
	} finally {
		release();
		await pending;
	}
	expect(h.dispatches).toBe(1);
	expect(getPiTagSnapshotView(h.db, h.sessionId)).toEqual(
		getTagsBySession(h.db, h.sessionId),
	);
});

it("cold hydration preserves main-thread heartbeat", async () => {
	const h = harness();
	h.slowWorker(200);
	const gaps = new Float64Array(1000);
	let count = 0;
	let last = performance.now();
	const heartbeat = setInterval(() => {
		const now = performance.now();
		gaps[count++] = now - last;
		last = now;
	}, 5);
	try {
		await ensurePiTagSnapshotReady(h.db, h.sessionId, new PiContextBudget());
		expect(h.starts).toBe(1);
		expect(count).toBeGreaterThan(10);
		expect(
			Math.max(performance.now() - last, ...gaps.subarray(0, count)),
		).toBeLessThan(50);
	} finally {
		clearInterval(heartbeat);
	}
	await h.call();
	expect(h.dispatches).toBe(1);
});

it("warm hydration serves baseline-identical bytes", async () => {
	const h = harness();
	const first = await h.call();
	__setPiTagSnapshotWorkerForTests(h.db, () => {
		throw new Error("warm read started a worker");
	});
	const second = await h.call();
	expect(h.dispatches).toBe(2);
	expect(JSON.stringify(second?.messages)).toBe(
		JSON.stringify(first?.messages),
	);
});

it("a failed hydration rejects without awaiting native worker release", async () => {
	const h = harness();
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const failure = new PiTagHydrationError("injected worker failure");
	__setPiTagSnapshotWorkerForTests(h.db, () => ({
		result: Promise.reject(failure),
		released,
		cancel: () => {},
	}));
	try {
		// Only 100 ms of the existing pass allowance remains. A failure must
		// keep its identity, not turn into a timeout while native exit is pending.
		await expect(
			ensurePiTagSnapshotReady(
				h.db,
				h.sessionId,
				new PiContextBudget(0, () => 18900),
			),
		).rejects.toBe(failure);
		let drained = false;
		const drain = drainPiTagSnapshotSession(h.sessionId).then(() => {
			drained = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(drained).toBe(false);
		release();
		await drain;
		expect(drained).toBe(true);
	} finally {
		release();
		await new Promise((resolve) => setImmediate(resolve));
	}
});

it("a cancelled hydration never backoffs the next session on the same connection", async () => {
	const h = harness();
	let release!: () => void;
	let reject!: (error: Error) => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const result = new Promise<never>((_resolve, rejectResult) => {
		reject = rejectResult;
	});
	__setPiTagSnapshotWorkerForTests(h.db, () => ({
		result,
		released,
		cancel: () => reject(new PiTagHydrationError("cancelled")),
	}));
	prewarmPiTagSnapshot(h.db, "outgoing-session");
	cancelPiTagSnapshotSession("outgoing-session");
	release();
	await drainPiTagSnapshotSession("outgoing-session");
	__setPiTagSnapshotWorkerForTests(h.db, (request, cached) =>
		h.track(startPiTagSnapshotWorker(request, { cached })),
	);
	await h.call();
	expect(h.dispatches).toBe(1);
	expect(h.starts).toBe(1);
	expect(h.refusals).toEqual([]);
});

it("a stale hydration retries with a fresh worker and serves the turn", async () => {
	const h = harness();
	let committed = false;
	__setPiTagSnapshotWorkerForTests(h.db, (request, cached) =>
		h.track(
			startPiTagSnapshotWorker(request, {
				cached,
				beforeAck: async () => {
					if (committed) return;
					committed = true;
					// Only a write to this session makes its in-flight read stale.
					h.foreign
						.prepare(
							"INSERT INTO tags(session_id, tag_number, message_id, type, status, byte_size) VALUES (?, 99, 'older-99', 'message', 'active', 13)",
						)
						.run(h.sessionId);
				},
			}),
		),
	);
	await h.call();
	expect(committed).toBe(true);
	expect(h.starts).toBe(2);
	expect(h.refusals).toEqual([]);
	expect(h.dispatches).toBe(1);
});

it("a clone prewarm queues behind the active session and its first turn is served", async () => {
	const h = harness();
	h.slowWorker(100);
	prewarmPiTagSnapshot(h.db, h.sessionId);
	prewarmPiTagSnapshot(h.db, "startup-clone");
	await h.call();
	expect(h.refusals).toEqual([]);
	expect(h.dispatches).toBe(1);
	expect(getPiTagSnapshotView(h.db, h.sessionId)).toEqual(
		getTagsBySession(h.db, h.sessionId),
	);
	await ensurePiTagSnapshotReady(h.db, "startup-clone", new PiContextBudget());
	await drainPiTagSnapshotSession("startup-clone");
	expect(h.starts).toBe(2);
});

it("an independently cancelled prewarm retries and serves the first turn", async () => {
	const h = harness();
	let starts = 0;
	__setPiTagSnapshotWorkerForTests(h.db, (request, cached) => {
		const job = h.track(
			startPiTagSnapshotWorker(
				{ ...request, test: { openDelayMs: 100 } },
				{ cached },
			),
		);
		if (++starts === 1) setImmediate(() => job.cancel());
		return job;
	});
	prewarmPiTagSnapshot(h.db, h.sessionId);
	await h.call();
	expect(h.refusals).toEqual([]);
	expect(h.dispatches).toBe(1);
	expect(starts).toBe(2);
});

for (const kind of ["cancel", "abort"] as const) {
	it(`a pass's own ${kind} still stops hydration without retrying`, async () => {
		const h = harness();
		const budget = new PiContextBudget();
		const controller = new AbortController();
		budget.signal = controller.signal;
		__setPiTagSnapshotWorkerForTests(h.db, (request, cached) => {
			const job = h.track(
				startPiTagSnapshotWorker(
					{ ...request, test: { openDelayMs: 100 } },
					{ cached },
				),
			);
			setImmediate(() => {
				if (kind === "cancel") budget.cancel();
				else controller.abort(new Error("user abort"));
				job.cancel();
			});
			return job;
		});
		await expect(
			ensurePiTagSnapshotReady(h.db, h.sessionId, budget),
		).rejects.toThrow();
		expect(h.starts).toBe(1);
		expect(h.dispatches).toBe(0);
	});
}

it("closing the connection stops a cancelled hydration wait without restarting", async () => {
	const db = createTestDb();
	let reject!: (error: Error) => void;
	let starts = 0;
	__setPiTagSnapshotWorkerForTests(db, () => {
		starts++;
		return {
			result: new Promise<never>((_resolve, fail) => {
				reject = fail;
			}),
			released: Promise.resolve(),
			cancel: () => reject(new PiTagHydrationError("cancelled", "cancelled")),
		};
	});
	const pending = ensurePiTagSnapshotReady(
		db,
		"closing-session",
		new PiContextBudget(),
	);
	db.close();
	await expect(pending).rejects.toThrow("connection closed");
	expect(starts).toBe(1);
});

for (const evidence of ["allocator observer", "insert journal"] as const) {
	it(`own first allocation refuses without ${evidence} evidence`, async () => {
		const h = harness();
		setPiTransformTimingObserver((sample) => {
			if (sample.sessionId === h.sessionId && sample.stage === "tagMessages") {
				h.db
					.prepare(
						`DELETE FROM ${evidence === "allocator observer" ? "pi_tag_first_allocation" : "pi_tag_changes"} WHERE session_id = ?`,
					)
					.run(h.sessionId);
			}
		});
		await h.call();
		expect(h.dispatches).toBe(0);
		expect(h.refusals.join("\n")).toContain("Pi tag hydration");
	});
}

it("fallback permutations preserve adoption and literal served bytes", async () => {
	const records: unknown[] = [];
	for (const order of [
		[1, 2, 3],
		[3, 1, 2],
		[2, 3, 1],
	]) {
		const h = harness([
			userMessage("First adoption target.", 1),
			assistantMessage("Second adoption target.", 2),
			userMessage("Third adoption target.", 3),
		]);
		const fingerprints = __test.buildEntryFingerprintMap(
			h.messages,
			(_message, index) => `entry-${index + 1}`,
		);
		for (let n = 1; n <= 3; n++) {
			const fingerprint = fingerprints.get(`entry-${n}`);
			expect(fingerprint).toBeDefined();
			h.db
				.prepare(
					"INSERT INTO tags(id,session_id,tag_number,message_id,type,status,byte_size,entry_fingerprint) VALUES (?, ?, ?, ?, 'message', 'active', 13, ?)",
				)
				.run(
					n,
					h.sessionId,
					n,
					`pi-msg-${n + 8}-${n}-${n === 2 ? "assistant" : "user"}:p0`,
					fingerprint,
				);
		}
		__setPiTagSnapshotWorkerForTests(h.db, (request, cached) => {
			const job = h.track(startPiTagSnapshotWorker(request, { cached }));
			return {
				...job,
				result: job.result.then((result) => ({
					...result,
					candidate: {
						...result.candidate,
						fallback: order.map(
							(n) =>
								result.candidate.fallback.find((row) => row.tag_number === n)!,
						),
					},
				})),
			};
		});
		const adoption: boolean[] = [];
		const restore = __test.setAfterFallbackAdoptionForTests((cutover) =>
			adoption.push(cutover),
		);
		try {
			const result = await h.call();
			expect(h.dispatches).toBe(1);
			const tags = getTagsBySession(h.db, h.sessionId);
			// Require tag numbers 1–3 to move from pi-msg-* onto entry-*:p0.
			// The semantic text-key lane also creates three current rows; counting
			// six rows alone would pass even if none of the legacy ids changed.
			expect(tags).toHaveLength(6);
			expect(
				tags
					.filter((tag) => tag.tagNumber <= 3)
					.map((tag) => ({
						tagNumber: tag.tagNumber,
						messageId: tag.messageId,
					})),
			).toEqual([
				{ tagNumber: 1, messageId: "entry-1:p0" },
				{ tagNumber: 2, messageId: "entry-2:p0" },
				{ tagNumber: 3, messageId: "entry-3:p0" },
			]);
			expect(tags.every((tag) => tag.messageId.startsWith("entry-"))).toBe(
				true,
			);
			records.push({
				bytes: JSON.stringify(result?.messages),
				adoption,
				tags,
			});
		} finally {
			restore();
			clearContextHandlerSession(h.sessionId);
		}
	}
	expect(records[1]).toEqual(records[0]);
	expect(records[2]).toEqual(records[0]);
});
