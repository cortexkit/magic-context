import { expect, spyOn, test } from "bun:test";
import {
	getTagsBySession,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

test("emergency prose pass applies historian drops published inside the shared budget", async () => {
	const db = createTestDb();
	const sessionId = "emergency-prose-publication";
	let restore: (() => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
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
		let published = false;
		const historian = new Promise<void>((resolve) => {
			timer = setTimeout(() => {
				queuePendingOp(db, sessionId, tag.tagNumber, "drop", 1);
				published = true;
				resolve();
			}, 30);
		});
		restore = __test.setInFlightHistorianForTests(sessionId, historian);
		const raw = messages();
		const result = await handler(
			{ messages: raw },
			{
				...context(raw),
				getContextUsage: () => ({
					tokens: 96000,
					percent: 96,
					contextWindow: 100000,
				}),
			},
		);
		expect(published).toBe(true);
		expect(
			getTagsBySession(db, sessionId).find(
				(row) => row.tagNumber === tag.tagNumber,
			)?.status,
		).toBe("dropped");
		expect(JSON.stringify(result)).not.toContain("old prose to summarize");
	} finally {
		clearTimeout(timer);
		restore?.();
		clearContextHandlerSession(sessionId);
		db.close();
	}
});

test("emergency historian exceeding remaining optional budget refuses before provider dispatch", async () => {
	const db = createTestDb();
	const sessionId = "emergency-historian-budget";
	let now = 0;
	const clock = spyOn(performance, "now").mockImplementation(() => now);
	let finish!: () => void;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const historian = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const restore = __test.setInFlightHistorianForTests(sessionId, historian);
	try {
		const fake = createFakePi();
		const entries: unknown[] = [];
		registerPiContextHandler(
			{
				...fake.pi,
				appendEntry: (_type: string, data: unknown) => entries.push(data),
			} as never,
			{ db },
		);
		let aborted = false;
		const raw = [userMessage("must not send without a summary", 1)];
		const ctx = {
			...fakeContext(sessionId, process.cwd(), ["u"], raw),
			getContextUsage: () => {
				// Earlier preparation and writer admission have spent almost all 21s.
				now = 20960;
				return { tokens: 96000, percent: 96, contextWindow: 100000 };
			},
			abort: () => {
				aborted = true;
			},
		};
		const handler = fake.handlers.get("context");
		if (!handler) throw new Error("context handler missing");
		// The historian can finish inside a fresh timeout, but not the remaining one.
		timer = setTimeout(finish, 200);
		await handler({ messages: raw }, ctx);
		expect(aborted).toBe(true);
		expect(JSON.stringify(entries)).toContain("elapsed=20960ms");
		expect(getTagsBySession(db, sessionId)).toEqual([]);
	} finally {
		clearTimeout(timer);
		finish();
		restore();
		clock.mockRestore();
		await new Promise<void>((resolve) => setImmediate(resolve));
		clearContextHandlerSession(sessionId);
		db.close();
	}
});
