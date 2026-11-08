import { afterEach, expect, test } from "bun:test";
import {
	clearPiContextReceipt,
	piBlockedDispatches,
	registerPiGuardedContext,
} from "./__tests__/dispatch-probe";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { assistantMessage, fakeContext, userMessage } from "./test-utils.test";

const SESSION = "issue-673";
const first = userMessage("first prompt", 10);
const reply = assistantMessage("first reply", 20);
const second = userMessage("second prompt", 30);
const raw = [first, reply, second];

function harness() {
	__setPiHarnessKindForTesting("omp");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const refusals: string[] = [];
	let aborts = 0;
	let idle = false;
	let managedMessages: unknown[] = [];
	let branch = structuredClone(raw).map((message, index) => ({
		type: "message" as const,
		id: `native-${index}`,
		message,
	}));
	const ctx = {
		...fakeContext(SESSION),
		isIdle: () => idle,
		sessionManager: {
			getSessionId: () => SESSION,
			getBranch: () => branch,
		},
		abort: () => aborts++,
	};
	registerPiGuardedContext(
		{
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(name, handler),
			appendEntry: (_type: string, data: { message: string }) =>
				refusals.push(data.message),
		} as never,
		async (event) => {
			// The added <memory/> message is absent from the host's stored history.
			// Capture the original input first, or the histories cannot be compared.
			event.messages.unshift(userMessage("<memory/>", 1));
			managedMessages = structuredClone(event.messages);
			return { messages: event.messages };
		},
	);
	const emit = (name: string, event: unknown = {}) => {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`missing ${name}`);
		return handler(event, ctx);
	};
	return {
		ctx,
		refusals,
		emit,
		get stops() {
			return aborts + piBlockedDispatches(ctx);
		},
		set idle(value: boolean) {
			idle = value;
		},
		get branch() {
			return branch;
		},
		set branch(value: typeof branch) {
			branch = value;
		},
		dispatch: () =>
			emit("before_provider_request", {
				payload: { messages: structuredClone(managedMessages) },
			}),
		async prepare(withEarlierStart = true) {
			// A previous agent_start was delivered, but that run's agent_end is delayed.
			if (withEarlierStart) emit("agent_start");
			emit("agent_start");
			await emit("context", { messages: structuredClone(raw) });
			this.dispatch();
			expect(refusals).toEqual([]);
		},
	};
}

afterEach(() => {
	clearPiContextReceipt(SESSION);
	__setPiHarnessKindForTesting(undefined);
});

test("issue 673: a dispatched current pass survives an earlier end before provider fallback", async () => {
	const h = harness();
	await h.prepare();
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch();
	expect(h.refusals).toEqual([]);
	expect(h.stops).toBe(0);
});

test("issue 673: an owning end refuses even the identical previously managed payload", async () => {
	const h = harness();
	await h.prepare();
	h.emit("agent_end", {
		messages: [...structuredClone(raw), assistantMessage("done", 40)],
	});
	h.dispatch();
	expect(h.stops).toBe(1);
	expect(h.refusals[0]).toContain("origin=agent_end");
});

test("issue 673: an idle aborted run cannot retain a dispatched receipt", async () => {
	const h = harness();
	await h.prepare();
	h.idle = true;
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch();
	expect(h.stops).toBe(1);
});

test("issue 673: a changed native anchor refuses a stale request with identical messages", async () => {
	const h = harness();
	await h.prepare();
	h.branch[2].id = "new-run-anchor";
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch();
	expect(h.stops).toBe(1);
});

test("issue 673: same keys and anchor do not authorize changed native content", async () => {
	const h = harness();
	await h.prepare();
	h.branch[0].message = userMessage(
		"edited content with the same timestamp",
		10,
	);
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch();
	expect(h.stops).toBe(1);
});

test("issue 673: matching keys without matching end content are not an earlier transcript", async () => {
	const h = harness();
	await h.prepare();
	h.emit("agent_end", {
		messages: [userMessage("different first prompt", 10), reply],
	});
	h.dispatch();
	expect(h.stops).toBe(1);
});

test("issue 673: an end containing the whole input is not a strict earlier prefix", async () => {
	const h = harness();
	await h.prepare();
	h.emit("agent_end", { messages: structuredClone(raw) });
	h.dispatch();
	expect(h.stops).toBe(1);
});

test("issue 673: an empty end proves no earlier transcript", async () => {
	const h = harness();
	await h.prepare();
	h.emit("agent_end", { messages: [] });
	h.dispatch();
	expect(h.stops).toBe(1);
});

test("issue 673: a pruned owning run cannot be mistaken for the earlier prefix", async () => {
	const h = harness();
	await h.prepare();
	h.branch = h.branch.slice(0, 2);
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch();
	expect(h.stops).toBe(1);
});

test("issue 673: unreadable native history leaves the end effective", async () => {
	const h = harness();
	await h.prepare();
	h.ctx.sessionManager.getBranch = () => {
		throw new Error("unreadable branch");
	};
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch();
	expect(h.stops).toBe(1);
});

test("issue 673: a pass without a matching native input cannot preserve a dispatched receipt", async () => {
	const h = harness();
	h.branch[0].message = userMessage("not the context input", 10);
	await h.prepare();
	h.branch[0].message = structuredClone(first);
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch();
	expect(h.stops).toBe(1);
});

test("issue 673: a new start without a pass cannot borrow the kept receipt", async () => {
	const h = harness();
	await h.prepare();
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.emit("agent_start");
	h.dispatch();
	expect(h.stops).toBe(1);
	expect(h.refusals[0]).toContain("no context pass ran");
});

test("issue 673: no earlier outstanding start means a dispatched end stays effective", async () => {
	const h = harness();
	await h.prepare(false);
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch();
	expect(h.stops).toBe(1);
});

test("issue 673: native prompt persistence can finish after context publication but before dispatch", async () => {
	const h = harness();
	const full = h.branch;
	h.branch = full.slice(0, 2);
	h.emit("agent_start");
	h.emit("agent_start");
	await h.emit("context", { messages: structuredClone(raw) });
	h.branch = full;
	h.dispatch();
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch();
	expect(h.refusals).toEqual([]);
});

test("issue 673: willContinue alone does not preserve an already dispatched owning pass", async () => {
	const h = harness();
	await h.prepare();
	h.emit("agent_end", { messages: structuredClone(raw), willContinue: true });
	h.dispatch();
	expect(h.stops).toBe(1);
});
