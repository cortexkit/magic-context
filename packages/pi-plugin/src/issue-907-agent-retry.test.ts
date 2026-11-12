import { afterEach, expect, test } from "bun:test";
import {
	clearPiContextReceipt,
	piBlockedDispatches,
	registerPiGuardedContext,
} from "./__tests__/dispatch-probe";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { assistantMessage, fakeContext, userMessage } from "./test-utils.test";

const SESSION = "issue-907";
const prompt = userMessage("retry me", 10);
const raw = [prompt];

function harness() {
	__setPiHarnessKindForTesting("omp");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const refusals: string[] = [];
	let aborts = 0;
	let idle = false;
	let managedMessages: unknown[] = [];
	const branch = structuredClone(raw).map((message, index) => ({
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
		async (event, _ctx, budget) => {
			// The synthetic leading row is OMP's injection, not stored history.
			event.messages.unshift(userMessage("<memory/>", 1));
			managedMessages = structuredClone(event.messages);
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
		set idle(value: boolean) {
			idle = value;
		},
		dispatch: () =>
			emit("before_provider_request", {
				payload: { messages: structuredClone(managedMessages) },
			}),
		async prepare() {
			emit("agent_start");
			await emit("context", { messages: structuredClone(raw) });
			this.dispatch();
			expect(this.refusals).toEqual([]);
		},
	};
}

afterEach(() => {
	clearPiContextReceipt(SESSION);
	__setPiHarnessKindForTesting(undefined);
});

test("issue 907: a retryable provider end keeps the managed pass until agent_settled", async () => {
	const h = harness();
	await h.prepare();

	h.emit("agent_end", {
		messages: [
			...structuredClone(raw),
			assistantMessage("429", 20, {
				stopReason: "error",
				errorMessage: "429 Free model daily limit exceeded",
			}),
		],
	});

	// OMP retries the same low-level run without a new agent_start or context pass.
	h.dispatch();
	expect(h.refusals).toEqual([]);
	expect(h.stops).toBe(0);

	h.idle = true;
	h.emit("agent_settled");
	h.dispatch();
	expect(h.stops).toBe(1);
	expect(h.refusals[0]).toContain("origin=agent_end");
});

test("issue 907: a normal end still closes the pass before agent_settled", async () => {
	const h = harness();
	await h.prepare();

	h.emit("agent_end", {
		messages: [...structuredClone(raw), assistantMessage("done", 20)],
	});
	h.dispatch();

	expect(h.stops).toBe(1);
	expect(h.refusals[0]).toContain("origin=agent_end");
});
