import { afterEach, expect, spyOn, test } from "bun:test";
import {
	indexCoordinationInput,
	withIndexChunk,
} from "@magic-context/core/shared/sqlite";
import {
	clearPiContextReceipt,
	piBlockedDispatches,
	registerPiGuardedContext,
} from "./__tests__/dispatch-probe";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

// OMP delivers the extension agent_end notification detached, after post-turn
// maintenance. These tests replay the orders a real OMP 18.7 host produced
// against the guarded context.

const SESSION = "issue-667";

function harness(handler: Parameters<typeof registerPiGuardedContext>[1]) {
	__setPiHarnessKindForTesting("omp");
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const refusals: string[] = [];
	let aborts = 0;
	let managedMessages: unknown[] = [];
	let generation = 0;
	registerPiGuardedContext(
		{
			on: (name: string, fn: (...args: unknown[]) => unknown) =>
				handlers.set(name, fn),
			appendEntry: (_type: string, data: { message: string }) =>
				refusals.push(data.message),
		} as never,
		async (event, ctx, budget) => {
			const pass = ++generation;
			const result = await handler(event, ctx, budget);
			if (pass === generation && result?.messages)
				managedMessages = structuredClone(result.messages);
			return result;
		},
	);
	const ctx = {
		...fakeContext(SESSION),
		ui: { notify: () => {} },
		abort: () => aborts++,
	};
	const emit = (name: string, event: unknown = {}) => {
		const fn = handlers.get(name);
		if (!fn) throw new Error(`missing ${name} handler`);
		return fn(event, ctx);
	};
	return {
		refusals,
		get stops() {
			return aborts + piBlockedDispatches(ctx);
		},
		emit,
		dispatch: () =>
			emit("before_provider_request", {
				payload: { messages: structuredClone(managedMessages) },
			}),
	};
}

const managed = async (event: { messages: unknown[] }) => ({
	messages: event.messages as never,
});

afterEach(() => {
	__setPiHarnessKindForTesting(undefined);
	clearPiContextReceipt(SESSION);
});

test("issue 667: a previous run's late agent_end does not refuse the next run's managed request", async () => {
	const h = harness(managed);
	const first = userMessage("first prompt", 1);
	const reply = assistantMessage("first reply", 2);
	h.emit("agent_start");
	await h.emit("context", { messages: [first] });
	h.dispatch();
	// The next prompt's context pass runs before OMP delivers the first run's end.
	await h.emit("context", {
		messages: [first, reply, userMessage("second prompt", 3)],
	});
	h.emit("agent_end", { messages: [first, reply] });
	h.dispatch();
	expect(h.refusals).toEqual([]);
	expect(h.stops).toBe(0);
	// The second run's own agent_start, delivered late, adopts the operation
	// holding the second run's completed pass instead of replacing it with an
	// empty one, so a retried dispatch is still admitted.
	h.emit("agent_start");
	h.dispatch();
	expect(h.refusals).toEqual([]);
	expect(h.stops).toBe(0);
});

test("issue 667: a retried run's late willContinue agent_end does not refuse the continuation", async () => {
	const h = harness(managed);
	const prompt = userMessage("retry me", 1);
	h.emit("agent_start");
	await h.emit("context", { messages: [prompt] });
	h.dispatch();
	// OMP schedules the continuation before notifying extensions of the failed
	// run's end; the continuation's input drops the failed assistant message.
	h.emit("agent_start");
	await h.emit("context", { messages: [prompt] });
	h.emit("agent_end", {
		messages: [prompt, assistantMessage("overloaded", 2)],
		willContinue: true,
	});
	h.dispatch();
	expect(h.refusals).toEqual([]);
	expect(h.stops).toBe(0);
});

test("issue 667: a slow pass refused at dispatch does not refuse the newer pass that replaces it", async () => {
	let finishSlow!: () => void;
	const slowDone = new Promise<void>((resolve) => {
		finishSlow = resolve;
	});
	let calls = 0;
	const h = harness(async (event) => {
		if (++calls === 1) await slowDone;
		return { messages: event.messages as never };
	});
	const first = userMessage("slow prompt", 1);
	h.emit("agent_start");
	const slow = Promise.resolve(h.emit("context", { messages: [first] })).catch(
		(error: Error) => error.message,
	);
	// OMP stopped waiting for the slow pass and dispatched its raw messages.
	h.dispatch();
	expect(h.stops).toBe(1);
	// The user resends before OMP delivers the aborted run's end.
	const resent = userMessage("resent prompt", 3);
	await h.emit("context", { messages: [first, resent] });
	h.emit("agent_end", { messages: [first] });
	h.dispatch();
	finishSlow();
	await slow;
	h.dispatch();
	expect(h.stops).toBe(1);
	expect(h.refusals).toHaveLength(1);
});

test("issue 667: a run's own end still invalidates its receipt", async () => {
	const prompt = userMessage("only prompt", 1);
	const dispatched = harness(managed);
	dispatched.emit("agent_start");
	await dispatched.emit("context", { messages: [prompt] });
	dispatched.dispatch();
	dispatched.emit("agent_end", {
		messages: [prompt, assistantMessage("done", 2)],
	});
	dispatched.dispatch();
	expect(dispatched.refusals.at(-1)).toContain(
		"the run that owned the latest context pass has ended",
	);
	expect(dispatched.refusals.at(-1)).not.toContain("superseded");
	expect(dispatched.stops).toBe(1);

	// A pass whose run ended before its request went out (its input is entirely
	// part of the ended run) authorizes nothing afterwards.
	clearPiContextReceipt(SESSION);
	const undispatched = harness(managed);
	undispatched.emit("agent_start");
	await undispatched.emit("context", { messages: [prompt] });
	undispatched.emit("agent_end", { messages: [prompt] });
	undispatched.dispatch();
	expect(undispatched.refusals.at(-1)).toContain(
		"the run that owned the latest context pass has ended",
	);
	expect(undispatched.stops).toBe(1);
});

test("issue 667: the outcome deadline covers a pass whose handler never settles", async () => {
	let reads = 0;
	// The pass clock starts at 0; every later read is 10 ms before the deadline.
	const clock = spyOn(performance, "now").mockImplementation(() =>
		reads++ === 0 ? 0 : 24_990,
	);
	let settle!: () => void;
	// Settled only after the assertions: an unsettled handler keeps its
	// foreground SQLite reservation, which would block later index chunks.
	const stuck = new Promise<undefined>((resolve) => {
		settle = () => resolve(undefined);
	});
	try {
		const h = harness(() => stuck);
		h.emit("agent_start");
		const outcome = await Promise.race([
			Promise.resolve(h.emit("context", { messages: [userMessage("x", 1)] })),
			new Promise((resolve) =>
				setTimeout(() => resolve("still running"), 2000),
			),
		]);
		expect(outcome).not.toBe("still running");
		expect(h.stops).toBe(1);
		expect(h.refusals.at(-1)).toContain("recovery=no managed result; refused");
		h.dispatch();
		expect(h.stops).toBe(2);
	} finally {
		settle();
		await stuck;
		clock.mockRestore();
	}
});

test("issue 667: a pass held behind index maintenance refuses by its deadline and cannot supersede the next pass", async () => {
	const db = createTestDb();
	const sessionId = "issue-667-reservation";
	let reads = 0;
	// The first pass's clock starts at 0; every later read sits 10 ms before
	// that pass's deadline. Later passes start at that same reading, so their
	// own elapsed time stays 0.
	const clock = spyOn(performance, "now").mockImplementation(() =>
		reads++ === 0 ? 0 : 24_990,
	);
	let releaseChunk!: () => void;
	const held = new Promise<void>((resolve) => {
		releaseChunk = resolve;
	});
	const owner = indexCoordinationInput();
	let chunkStarted!: () => void;
	const chunkRunning = new Promise<void>((resolve) => {
		chunkStarted = resolve;
	});
	// An index maintenance chunk owns the coordination slot, so the next
	// foreground pass waits in its reservation before its handler starts.
	const chunk = withIndexChunk(owner, () => {
		chunkStarted();
		return held;
	});
	// Keeps the newer pass inside its pipeline long enough for the old waiter's
	// 1 ms reservation poll to fire.
	const restorePipeline = __test.setBeforePipelineForTests(
		() => new Promise((resolve) => setTimeout(resolve, 10)),
	);
	__setPiHarnessKindForTesting("omp");
	try {
		await chunkRunning;
		const fake = createFakePi();
		const entries: string[] = [];
		registerPiContextHandler(
			{
				...fake.pi,
				appendEntry: (_name: string, data: { message: string }) =>
					entries.push(data.message),
			} as never,
			{ db },
		);
		let aborts = 0;
		const raw = [userMessage("held behind maintenance", 1)];
		const ctx = {
			...fakeContext(sessionId, process.cwd(), ["u"], raw),
			ui: { notify: () => {} },
			abort: () => aborts++,
		};
		const on = (name: string) => {
			const fn = fake.handlers.get(name) as
				| ((event: unknown, ctx: unknown) => unknown)
				| undefined;
			if (!fn) throw new Error(`${name} handler missing`);
			return (event: unknown) => fn(event, ctx);
		};
		on("agent_start")({});
		const old = await Promise.race([
			Promise.resolve(on("context")({ messages: raw })),
			new Promise((resolve) =>
				setTimeout(() => resolve("still waiting"), 2000),
			),
		]);
		expect(old).not.toBe("still waiting");
		expect(aborts).toBe(1);
		expect(entries.at(-1)).toContain("recovery=no managed result; refused");

		// The user resends. Maintenance releases the slot just as the new pass
		// arrives, so the new pass starts before the old waiter's next poll.
		on("agent_start")({});
		releaseChunk();
		await chunk;
		const next = [userMessage("resent prompt", 2)];
		const result = (await on("context")({ messages: next })) as
			| { messages?: unknown[] }
			| undefined;
		expect(result?.messages?.length).toBeGreaterThan(0);
		on("before_provider_request")({
			payload: { messages: result?.messages },
		});
		expect(aborts).toBe(1);
	} finally {
		releaseChunk();
		restorePipeline();
		clock.mockRestore();
		__setPiHarnessKindForTesting(undefined);
		clearContextHandlerSession(sessionId);
		db.close();
	}
});
