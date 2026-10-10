import { expect, mock, spyOn, test } from "bun:test";
import { incrementHistorianFailure } from "@magic-context/core/features/magic-context/storage";
import {
	getSlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import * as historian from "./pi-historian-runner";
import { getPiServedTagNumbers } from "./served-array-ledger";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

test("mandatory work beyond 25s refuses without storage waits or managed publication", async () => {
	const db = createTestDb();
	const sessionId = "outcome-641";
	let now = 0;
	let aborted = false;
	const calls: string[] = [];
	const onPostprocess = mock(() => undefined);
	const clock = spyOn(performance, "now").mockImplementation(() => now);
	const prepare = db.prepare.bind(db);
	const sql = spyOn(db, "prepare").mockImplementation((statement) => {
		if (now >= 25000 && !aborted) calls.push("storage");
		return prepare(statement);
	});
	const restore = __test.setBeforePipelineForTests(async () => {
		now = 26000;
	});
	__setPiHarnessKindForTesting("omp");
	try {
		const fake = createFakePi();
		const entries: Array<{ message: string }> = [];
		registerPiContextHandler(
			{
				...fake.pi,
				appendEntry: (_name: string, data: { message: string }) => {
					calls.push("entry");
					entries.push(data);
				},
			} as never,
			{ db, onPostprocess },
		);
		const raw = [userMessage("never publish this overrun")];
		const ctx = {
			...fakeContext(sessionId, process.cwd(), ["u"], raw),
			ui: {
				notify: () => {
					calls.push("notice");
				},
			},
			abort: () => {
				aborted = true;
				calls.push("abort");
			},
		};
		const handler = fake.handlers.get("context");
		if (!handler) throw new Error("context handler missing");
		await handler({ messages: raw } as never, ctx as never);
		expect(calls).toEqual(["notice", "entry", "abort"]);
		expect(entries[0].message).toContain("elapsed=26000ms");
		expect(entries[0].message).toContain("recovery=no managed result; refused");
		expect(
			db.prepare("SELECT * FROM tags WHERE session_id=?").all(sessionId),
		).toEqual([]);
		expect(
			db
				.prepare("SELECT * FROM transform_decisions WHERE session_id=?")
				.all(sessionId),
		).toEqual([]);
		expect(getSlot(sessionId)).toBeUndefined();
		expect(getPiServedTagNumbers(sessionId).size).toBe(0);
		expect(onPostprocess).not.toHaveBeenCalled();
	} finally {
		restore();
		sql.mockRestore();
		clock.mockRestore();
		__setPiHarnessKindForTesting(undefined);
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
	}
});

test("postprocess observer participates in the outcome budget and leaves dispatch refused", async () => {
	const db = createTestDb();
	const sessionId = "observer-outcome-merge";
	let now = 0;
	const clock = spyOn(performance, "now").mockImplementation(() => now);
	const observer = mock(({ bustedThisPass }: { bustedThisPass: boolean }) => {
		expect(bustedThisPass).toBe(true);
		now = 26000;
	});
	const abort = mock(() => undefined);
	__setPiHarnessKindForTesting("omp");
	try {
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, { db, onPostprocess: observer });
		const messages = [userMessage("complete, then observe")];
		const ctx = {
			...fakeContext(sessionId, process.cwd(), ["u"], messages),
			abort,
			ui: { notify: mock(() => undefined) },
		};
		const handler = fake.handlers.get("context");
		if (!handler) throw new Error("context handler missing");
		const result = await handler({ messages } as never, ctx as never);
		expect(observer).toHaveBeenCalledTimes(1);
		expect(abort).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ messages });
		const dispatch = fake.handlers.get("before_provider_request");
		if (!dispatch) throw new Error("dispatch fence missing");
		await dispatch({} as never, ctx as never);
		expect(abort).toHaveBeenCalledTimes(2);
	} finally {
		clock.mockRestore();
		__setPiHarnessKindForTesting(undefined);
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
	}
});

test("deferred historian startup respects the originating pass optional cutoff", async () => {
	const db = createTestDb();
	const sessionId = "historian-start-cutoff";
	let now = 0;
	const clock = spyOn(performance, "now").mockImplementation(() => now);
	const scheduled = mock(() => undefined);
	const start = spyOn(historian, "runPiHistorian").mockResolvedValue(undefined);
	try {
		incrementHistorianFailure(db, sessionId, "retry prior history summary");
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			historian: {
				onStatusChange: scheduled,
				runner: {
					harness: "pi",
					run: mock(async () => ({
						ok: true,
						assistantText: "",
						durationMs: 1,
					})),
				} as unknown as SubagentRunner,
				model: "test/model",
				historianChunkTokens: 20_000,
			},
		});
		const messages = Array.from({ length: 12 }, (_, index) =>
			index % 2 === 0
				? userMessage(`user ${index}`, index + 1)
				: assistantMessage(`assistant ${index}`, index + 1),
		);
		const ctx = {
			...fakeContext(
				sessionId,
				process.cwd(),
				messages.map((_, i) => `entry-${i + 1}`),
				messages,
			),
			ui: { notify: mock(() => undefined) },
			getContextUsage: () => ({
				tokens: 100,
				percent: 10,
				contextWindow: 10_000,
			}),
		};
		const handler = fake.handlers.get("context");
		if (!handler) throw new Error("context handler missing");
		const result = (await handler({ messages } as never, ctx as never)) as {
			messages: unknown[];
		};
		expect(result.messages.length).toBeGreaterThan(0);
		expect(scheduled).toHaveBeenCalledTimes(1);
		now = 21_001;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(start).not.toHaveBeenCalled();
	} finally {
		clock.mockRestore();
		start.mockRestore();
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
	}
});
