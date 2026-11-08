import { afterEach, expect, test } from "bun:test";
import {
	clearPiContextReceipt,
	piBlockedDispatches,
	registerPiGuardedContext,
} from "./__tests__/dispatch-probe";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { assistantMessage, fakeContext, userMessage } from "./test-utils.test";

const SESSION = "issue-674";
const first = userMessage("first goal run", 10);
const reply = assistantMessage("goal progress", 20);
const goal = {
	role: "custom",
	customType: "goal-mode-context",
	content: "objective",
	display: false,
	attribution: "agent",
	timestamp: 30,
};
const continuation = {
	...goal,
	customType: "goal-continuation",
	content: "continue the objective",
	timestamp: 40,
};
const input = [first, reply, goal, continuation];
type Entry = {
	type: string;
	id: string;
	message?: unknown;
	timestamp?: string;
	customType?: string;
	content?: unknown;
	display?: boolean;
	attribution?: string;
	details?: unknown;
};

function native(messages: readonly unknown[]): Entry[] {
	return structuredClone(messages).map((message, index) => {
		const row = message as typeof goal;
		return row.role === "custom"
			? {
					type: "custom_message",
					id: `entry-${index}`,
					timestamp: new Date(row.timestamp).toISOString(),
					customType: row.customType,
					content: row.content,
					display: row.display,
					attribution: row.attribution,
				}
			: { type: "message", id: `entry-${index}`, message };
	});
}

function harness(persisted = input.length) {
	__setPiHarnessKindForTesting("omp");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const refusals: string[] = [];
	let branch = native(input).slice(0, persisted);
	let managed: unknown[] = [];
	let aborts = 0;
	const ctx = {
		...fakeContext(SESSION),
		isIdle: () => false,
		sessionManager: { getSessionId: () => SESSION, getBranch: () => branch },
		abort: () => aborts++,
	};
	registerPiGuardedContext(
		{
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(name, handler),
			appendEntry: (_type: string, data: { message: string }) =>
				refusals.push(data.message),
		} as never,
		async (event, _ctx, budget) => {
			event.messages.unshift(userMessage("<memory/>", 1));
			managed = structuredClone(event.messages);
			budget.stage = "LKG/served publication";
			return { messages: event.messages };
		},
	);
	const emit = (name: string, event: unknown = {}) => {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`missing ${name}`);
		return handler(event, ctx);
	};
	return {
		refusals,
		emit,
		get stops() {
			return aborts + piBlockedDispatches(ctx);
		},
		get branch() {
			return branch;
		},
		set branch(value: Entry[]) {
			branch = value;
		},
		payload: () => ({ messages: structuredClone(managed) }),
		dispatch(payload?: unknown) {
			emit("before_provider_request", { payload: payload ?? this.payload() });
		},
		async prepare() {
			emit("agent_start");
			emit("agent_start");
			await emit("context", { messages: structuredClone(input) });
			this.dispatch();
			expect(refusals).toEqual([]);
		},
	};
}

afterEach(() => {
	clearPiContextReceipt(SESSION);
	__setPiHarnessKindForTesting(undefined);
});

test("issue 674: goal inner run end preserves the parent's exact managed continuation", async () => {
	const h = harness();
	await h.prepare();
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch();
	expect(h.stops).toBe(0);
	expect(h.refusals).toEqual([]);
});

test("issue 674: a persisted goal preface anchors a later-persisted continuation", async () => {
	const h = harness(3);
	await h.prepare();
	h.branch = native(input);
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch();
	expect(h.stops).toBe(0);
});

test("issue 674: an anchor inside the ended transcript cannot identify the later run", async () => {
	const h = harness(2);
	await h.prepare();
	h.branch = native(input);
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch();
	expect(h.stops).toBe(1);
});

test("issue 674: an incompletely persisted continuation cannot preserve a receipt", async () => {
	const h = harness(3);
	await h.prepare();
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch();
	expect(h.stops).toBe(1);
});

test("issue 674: changing the persisted goal preface ID refuses the stale continuation", async () => {
	const h = harness(3);
	await h.prepare();
	h.branch = native(input);
	h.branch[2].id = "other-goal";
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch();
	expect(h.stops).toBe(1);
});

test("issue 674: same custom timestamps and IDs do not authorize changed goal content", async () => {
	const h = harness();
	await h.prepare();
	h.branch[2].content = "different objective";
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch();
	expect(h.stops).toBe(1);
});

test("issue 674: invalid custom timestamps leave the end effective", async () => {
	const h = harness();
	await h.prepare();
	h.branch[2].timestamp = "not a timestamp";
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch();
	expect(h.stops).toBe(1);
});

test("issue 674: the goal continuation's own end still refuses its managed payload", async () => {
	const h = harness();
	await h.prepare();
	h.emit("agent_end", { messages: structuredClone(input) });
	h.dispatch();
	expect(h.stops).toBe(1);
});

test("issue 674: a new model pass within the same run gets a fresh receipt without another start", async () => {
	const h = harness();
	await h.prepare();
	const followup = [
		...input,
		assistantMessage("another model pass", 50),
		userMessage("tool result", 60),
	];
	h.branch = native(followup);
	await h.emit("context", { messages: structuredClone(followup) });
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch();
	expect(h.stops).toBe(0);
});

test("issue 674: raw history cannot borrow a receipt retained after an earlier end", async () => {
	const h = harness();
	await h.prepare();
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch({ messages: structuredClone(input) });
	expect(h.stops).toBe(1);
	expect(h.refusals[0]).toContain(
		"does not match this pass's managed dispatch",
	);
});

test("issue 674: changed provider system content cannot borrow a retained receipt", async () => {
	const h = harness();
	await h.prepare();
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch({ ...h.payload(), system: "different request" });
	expect(h.stops).toBe(1);
});

test("issue 674: retry controls can change while the managed conversation stays identical", async () => {
	const h = harness();
	await h.prepare();
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch({
		...h.payload(),
		tools: [{ name: "retry-without-strict" }],
		max_tokens: 256,
	});
	expect(h.stops).toBe(0);
});

test("issue 674: unknown provider shapes cannot use a retained receipt", async () => {
	const h = harness();
	await h.prepare();
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch({ input: "unproven opaque request" });
	expect(h.stops).toBe(1);
});

test("issue 674: repeated stale callbacks still abort but notify once without nested stages", async () => {
	const h = harness();
	await h.prepare();
	h.emit("agent_end", { messages: structuredClone(input) });
	h.dispatch();
	h.dispatch();
	expect(h.stops).toBe(2);
	expect(h.refusals).toHaveLength(1);
	expect(h.refusals[0]).toContain("context stage=LKG/served publication");
	expect(h.refusals[0]).not.toContain("context stage=provider dispatch");
});

test("issue 674: persisting a tail cannot replace a changed prefix anchor", async () => {
	const h = harness(3);
	h.emit("agent_start");
	h.emit("agent_start");
	await h.emit("context", { messages: structuredClone(input) });
	h.branch = native(input);
	h.branch[2].id = "changed-before-dispatch";
	h.dispatch();
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch();
	expect(h.stops).toBe(1);
});

test("issue 674: response-chain identifiers cannot change under a retained receipt", async () => {
	const h = harness();
	h.emit("agent_start");
	h.emit("agent_start");
	await h.emit("context", { messages: structuredClone(input) });
	// A previous_response_id is now admitted only when it names the response
	// recorded for the last admitted managed request, so the admitted request
	// here is the full one and the resend introduces the chain identifier.
	const payload = {
		input: h.payload().messages,
		instructions: "managed",
	};
	h.dispatch(payload);
	h.emit("agent_end", { messages: structuredClone([first, reply]) });
	h.dispatch({ ...payload, previous_response_id: "stale-chain" });
	expect(h.stops).toBe(1);
});
