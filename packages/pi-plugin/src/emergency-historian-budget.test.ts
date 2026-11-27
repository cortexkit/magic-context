import { afterEach, expect, jest, spyOn, test } from "bun:test";
import {
	getTagsBySession,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { PiContextBudget } from "./pi-context-budget";
import { ensurePiTagSnapshotReady } from "./tag-snapshot-pi";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

let clock: ReturnType<typeof spyOn<typeof performance, "now">> | undefined;
afterEach(() => {
	clock?.mockRestore();
	clock = undefined;
	jest.useRealTimers();
});

function usePassClock() {
	jest.useFakeTimers({ doNotFake: ["setImmediate", "performance"] });
	const started = Date.now();
	let preparationMs = 0;
	const now = () => Date.now() - started + preparationMs;
	clock = spyOn(performance, "now").mockImplementation(now);
	return {
		now,
		spendPreparation: (ms: number) => {
			preparationMs = ms;
		},
	};
}

function historianFixture() {
	const { promise, resolve } = Promise.withResolvers<void>();
	const joined = Promise.withResolvers<void>();
	// The pass has installed its wait and deadline when Promise.race subscribes.
	const then = promise.then.bind(promise);
	Object.assign(promise, {
		// biome-ignore lint/suspicious/noThenProperty: Observe subscription to this native promise without replacing its behavior.
		then: (...args: Parameters<typeof promise.then>) => {
			joined.resolve();
			return then(...args);
		},
	});
	return { promise, finish: resolve, joined: joined.promise };
}

const flushPass = () => new Promise<void>((resolve) => setImmediate(resolve));

test("emergency prose pass applies historian drops published inside the shared budget", async () => {
	const db = createTestDb();
	const sessionId = "emergency-prose-publication";
	let restore: (() => void) | undefined;
	const historian = historianFixture();
	try {
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, { db, protectedTags: 0 });
		const handler = fake.handlers.get("context");
		if (!handler) throw new Error("context handler missing");
		const messages = () => [
			userMessage("old request", 1),
			assistantMessage("old prose to summarize", 2),
			userMessage("continue", 3),
		];
		const context = (raw: unknown[]) =>
			fakeContext(sessionId, process.cwd(), ["u1", "a1", "u2"], raw);
		const warm = messages();
		await handler({ messages: warm }, context(warm));
		const tag = getTagsBySession(db, sessionId).find((tag) =>
			tag.messageId.startsWith("a1"),
		);
		if (!tag) throw new Error("historian drop target missing");
		const { now } = usePassClock();
		restore = __test.setInFlightHistorianForTests(sessionId, historian.promise);
		const raw = messages();
		let settled = false;
		const pending = handler(
			{ messages: raw },
			{
				...context(raw),
				getContextUsage: () => ({
					tokens: 96000,
					percent: 96,
					contextWindow: 100000,
				}),
			},
		).then((result) => {
			settled = true;
			return result;
		});
		await Promise.race([historian.joined, pending]);
		expect(settled).toBe(false);
		jest.advanceTimersByTime(30);
		expect(now()).toBe(30);
		queuePendingOp(db, sessionId, tag.tagNumber, "drop", 1);
		historian.finish();
		const result = await pending;
		expect(
			getTagsBySession(db, sessionId).find(
				(row) => row.tagNumber === tag.tagNumber,
			)?.status,
		).toBe("dropped");
		expect(JSON.stringify(result)).not.toContain("old prose to summarize");
	} finally {
		historian.finish();
		restore?.();
		clearContextHandlerSession(sessionId);
		db.close();
	}
});

test("emergency historian exceeding remaining optional budget refuses before provider dispatch", async () => {
	const db = createTestDb();
	const sessionId = "emergency-historian-budget";
	const historian = historianFixture();
	const restore = __test.setInFlightHistorianForTests(
		sessionId,
		historian.promise,
	);
	try {
		// A cold snapshot would already refuse with only 40 ms left, before
		// reaching the historian. Load it without tagging or serving a turn.
		await ensurePiTagSnapshotReady(
			db,
			sessionId,
			new PiContextBudget(),
			"pass",
		);
		const { now, spendPreparation } = usePassClock();
		const fake = createFakePi();
		const entries: unknown[] = [];
		const admissions: unknown[] = [];
		registerPiContextHandler(
			{
				...fake.pi,
				appendEntry: (_type: string, data: unknown) => entries.push(data),
			} as never,
			{
				db,
				maybeAutoEmbedSession: (id, directory, identity) => {
					admissions.push([id, directory, identity, now()]);
				},
			},
		);
		let aborted = false;
		const raw = [userMessage("must not send without a summary", 1)];
		const ctx = {
			...fakeContext(sessionId, process.cwd(), ["u"], raw),
			getContextUsage: () => {
				// Earlier preparation and writer admission have spent almost all 21s.
				spendPreparation(20_960);
				return { tokens: 96000, percent: 96, contextWindow: 100000 };
			},
			abort: () => {
				aborted = true;
			},
		};
		const handler = fake.handlers.get("context");
		if (!handler) throw new Error("context handler missing");
		const pending = handler({ messages: raw }, ctx);
		await Promise.race([historian.joined, pending]);
		expect(aborted).toBe(false);
		jest.advanceTimersByTime(39);
		await flushPass();
		expect(aborted).toBe(false);
		jest.advanceTimersByTime(1);
		await flushPass();
		expect(aborted).toBe(true);
		await pending;
		expect(admissions).toEqual([
			[sessionId, ctx.cwd, expect.any(String), 20_960],
		]);
		expect(JSON.stringify(entries)).toContain("elapsed=21000ms");
		expect(getTagsBySession(db, sessionId)).toEqual([]);
	} finally {
		historian.finish();
		restore();
		await flushPass();
		clearContextHandlerSession(sessionId);
		db.close();
	}
});
