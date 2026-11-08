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

// Regressions for the OMP dispatch fence's agent_end attribution.
// OMP's extension agent_end carries the
// agent's full message state at the end of the run; these tests replay that.

const SESSION = "issue-667-review";

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

// The real Magic Context handler rewrites the context event's message array in
// place: prependM0M1Messages adds two synthetic user messages stamped just
// before the first message (inject-compartments-pi.ts), and the todo and
// system-entry steps insert synthetic messages too. None of them exist in
// OMP's agent state, so they never appear in the run's agent_end messages.
const rewritesInPlace = async (event: { messages: unknown[] }) => {
	const first = event.messages[0] as { timestamp: number };
	event.messages.unshift(
		{
			role: "user",
			content: "<session-history/>",
			timestamp: first.timestamp - 2,
		},
		{ role: "user", content: "<memory/>", timestamp: first.timestamp - 1 },
	);
	return { messages: event.messages as never };
};

afterEach(() => {
	__setPiHarnessKindForTesting(undefined);
	clearPiContextReceipt(SESSION);
});

test("issue 667 review: a run that ends before its request goes out invalidates its receipt even when the pass rewrote its input in place", async () => {
	// endBelongsToEarlierRun must compare the end with the input as it was
	// before the handler rewrote it; otherwise the synthetic messages make the
	// run's own end look like an earlier run's and the receipt survives it.
	const h = harness(rewritesInPlace);
	const prompt = userMessage("aborted before dispatch", 100);
	h.emit("agent_start");
	await h.emit("context", { messages: [prompt] });
	// The user aborted between the context result and provider dispatch. OMP's
	// agent_end carries its state: the prompt and the aborted assistant turn.
	h.emit("agent_end", {
		messages: [prompt, assistantMessage("aborted", 101)],
	});
	// Any later request without its own context pass must be refused.
	h.dispatch();
	expect(h.refusals.at(-1)).toContain(
		"the run that owned the latest context pass has ended",
	);
	expect(h.stops).toBe(1);
});

test("issue 667 review: a dispatched pass's own run end invalidates its receipt even when the pass rewrote its input in place", async () => {
	// The dispatched check is the only thing that attributes this end to the
	// pass's own run: the rewritten input holds messages OMP never had.
	const h = harness(rewritesInPlace);
	const prompt = userMessage("dispatched prompt", 100);
	h.emit("agent_start");
	await h.emit("context", { messages: [prompt] });
	h.dispatch();
	expect(h.refusals).toEqual([]);
	h.emit("agent_end", {
		messages: [prompt, assistantMessage("done", 101)],
	});
	h.dispatch();
	expect(h.refusals.at(-1)).toContain(
		"the run that owned the latest context pass has ended",
	);
	expect(h.stops).toBe(1);
});

test("issue 667 review: a kept continuation pass is not adopted by a later run's agent_start", async () => {
	const h = harness(async (event) => ({ messages: event.messages as never }));
	const prompt = userMessage("retry me", 1);
	h.emit("agent_start");
	await h.emit("context", { messages: [prompt] });
	h.dispatch();
	// The continuation started and ran its pass before the failed run's
	// willContinue end arrived. Its start was already delivered.
	h.emit("agent_start");
	await h.emit("context", { messages: [prompt] });
	h.emit("agent_end", {
		messages: [prompt, assistantMessage("overloaded", 2)],
		willContinue: true,
	});
	h.dispatch();
	expect(h.refusals).toEqual([]);
	// A new run starts while the continuation's own end is still in flight.
	// Its first request has no context pass of its own and must not borrow
	// the continuation's receipt.
	h.emit("agent_start");
	h.dispatch();
	expect(h.refusals.at(-1)).toContain("no context pass ran for this operation");
	expect(h.stops).toBe(1);
});

test("issue 667 review: a kept pass whose own start was delivered is not adopted by the next run's start", async () => {
	const h = harness(async (event) => ({ messages: event.messages as never }));
	const first = userMessage("first", 1);
	const reply = assistantMessage("reply", 2);
	h.emit("agent_start");
	await h.emit("context", { messages: [first] });
	h.dispatch();
	// Run 2 starts and runs its pass; run 1's end is still in flight.
	h.emit("agent_start");
	await h.emit("context", {
		messages: [first, reply, userMessage("second", 3)],
	});
	h.emit("agent_end", { messages: [first, reply] });
	h.dispatch();
	expect(h.refusals).toEqual([]);
	// starts (2) exceed ends (1): run 2's start was seen, so a third start is a
	// new run that must not adopt run 2's receipt.
	h.emit("agent_start");
	h.dispatch();
	expect(h.refusals.at(-1)).toContain("no context pass ran for this operation");
});

test("issue 667 review: a pass refused while waiting for its SQLite reservation writes nothing once its handler finally starts", async () => {
	const db = createTestDb();
	const sessionId = "issue-667-review-late-writes";
	// Row counts for every table, plus the session_meta rows themselves: a late
	// handler could update an existing session_meta row without adding one.
	const rowCounts = () => ({
		sessionMeta: JSON.stringify(db.query("SELECT * FROM session_meta").all()),
		...Object.fromEntries(
			(
				db
					.query(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
					)
					.all() as { name: string }[]
			).map(({ name }) => [
				name,
				(
					db.query(`SELECT count(*) AS n FROM "${name}"`).get() as {
						n: number;
					}
				).n,
			]),
		),
	});
	let reads = 0;
	let later = 24_990;
	// The pass clock starts at 0. Later reads sit 10 ms before the outcome
	// deadline, so the wrapper's race fires while the reservation waits. Once
	// the pass is refused, the clock reads 1 s: the late handler then sees
	// time left on both cutoffs, so only the refusal itself (the abandoned flag
	// and the handler's entry check) can stop it from writing.
	const clock = spyOn(performance, "now").mockImplementation(() =>
		reads++ === 0 ? 0 : later,
	);
	let releaseChunk!: () => void;
	const held = new Promise<void>((resolve) => {
		releaseChunk = resolve;
	});
	let chunkStarted!: () => void;
	const chunkRunning = new Promise<void>((resolve) => {
		chunkStarted = resolve;
	});
	// Index maintenance owns the coordination slot, so the pass waits in its
	// foreground reservation before its handler can start.
	const chunk = withIndexChunk(indexCoordinationInput(), () => {
		chunkStarted();
		return held;
	});
	__setPiHarnessKindForTesting("omp");
	try {
		await chunkRunning;
		const fake = createFakePi();
		registerPiContextHandler({ ...fake.pi, appendEntry: () => {} } as never, {
			db,
		});
		const raw = [userMessage("held behind maintenance", 1)];
		let aborts = 0;
		const ctx = {
			...fakeContext(sessionId, process.cwd(), ["u"], raw),
			ui: { notify: () => {} },
			abort: () => {
				aborts++;
				later = 1_000;
			},
		};
		const on = (name: string) => {
			const fn = fake.handlers.get(name) as
				| ((event: unknown, ctx: unknown) => unknown)
				| undefined;
			if (!fn) throw new Error(`${name} handler missing`);
			return (event: unknown) => fn(event, ctx);
		};
		on("agent_start")({});
		const outcome = await Promise.race([
			Promise.resolve(on("context")({ messages: raw })),
			new Promise((resolve) =>
				setTimeout(() => resolve("still waiting"), 2000),
			),
		]);
		expect(outcome).not.toBe("still waiting");
		expect(aborts).toBe(1);
		// The refusal queues its own diagnostic (session_meta.last_transform_error)
		// on the next macrotask. That write is intended; record the store after it.
		await new Promise((resolve) => setImmediate(resolve));
		const atRefusal = rowCounts();
		expect(atRefusal.sessionMeta).toContain("no managed result; refused");
		// Maintenance releases the slot; the abandoned pass's handler starts now.
		releaseChunk();
		await chunk;
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(rowCounts()).toEqual(atRefusal);
	} finally {
		releaseChunk();
		clock.mockRestore();
		__setPiHarnessKindForTesting(undefined);
		clearContextHandlerSession(sessionId);
		db.close();
	}
});

test("issue 667 review: an agent_end without a delivered start does not make later kept passes adoptable", async () => {
	const h = harness(async (event) => ({ messages: event.messages as never }));
	// The extension loaded during a run: its end arrives with no start seen.
	h.emit("agent_end", { messages: [userMessage("before load", 1)] });
	const first = userMessage("first", 2);
	const reply = assistantMessage("reply", 3);
	h.emit("agent_start");
	await h.emit("context", { messages: [first] });
	h.dispatch();
	// Run 2 starts and runs its pass; run 1's end is still in flight.
	h.emit("agent_start");
	await h.emit("context", {
		messages: [first, reply, userMessage("second", 4)],
	});
	h.emit("agent_end", { messages: [first, reply] });
	h.dispatch();
	expect(h.refusals).toEqual([]);
	// Run 2's start was delivered, so a third start is a new run that must
	// not adopt run 2's receipt, whatever the unmatched end did to the counts.
	h.emit("agent_start");
	h.dispatch();
	expect(h.refusals.at(-1)).toContain("no context pass ran for this operation");
	expect(h.stops).toBe(1);
});

test("issue 667 review: clearing a session's receipt also resets its lifecycle counts", async () => {
	const h = harness(async (event) => ({ messages: event.messages as never }));
	// Two runs whose ends were never delivered before the cache was cleared.
	h.emit("agent_start");
	h.emit("agent_start");
	clearPiContextReceipt(SESSION);
	const first = userMessage("first", 1);
	const reply = assistantMessage("reply", 2);
	h.emit("agent_start");
	await h.emit("context", { messages: [first] });
	h.dispatch();
	// Run 2's pass lands before run 1's end, and run 2's start arrives last.
	await h.emit("context", {
		messages: [first, reply, userMessage("second", 3)],
	});
	h.emit("agent_end", { messages: [first, reply] });
	h.emit("agent_start");
	h.dispatch();
	expect(h.refusals).toEqual([]);
	expect(h.stops).toBe(0);
});

test("issue 667 review: a dispatched pass's own run end invalidates its receipt even when OMP rewrote the run's messages", async () => {
	// Once the fence admitted the pass's request, the next end is that run's
	// own: the input comparison is not needed, and it would fail here because
	// OMP compacted the run's state before ending, so the end no longer holds
	// the pass's input messages.
	const h = harness(async (event) => ({ messages: event.messages as never }));
	const prompt = userMessage("before compaction", 100);
	h.emit("agent_start");
	await h.emit("context", { messages: [prompt] });
	h.dispatch();
	expect(h.refusals).toEqual([]);
	h.emit("agent_end", {
		messages: [
			userMessage("<summary of earlier turns>", 102),
			assistantMessage("done", 103),
		],
	});
	h.dispatch();
	expect(h.refusals.at(-1)).toContain(
		"the run that owned the latest context pass has ended",
	);
	expect(h.stops).toBe(1);
});
