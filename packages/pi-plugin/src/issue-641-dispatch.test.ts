import { afterEach, expect, test } from "bun:test";
import type { PiContextBudget } from "./pi-context-budget";
import {
	clearPiContextReceipt,
	registerPiGuardedContext,
} from "./pi-context-refusal";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext, userMessage } from "./test-utils.test";

function harness(handler: Parameters<typeof registerPiGuardedContext>[1]) {
	__setPiHarnessKindForTesting("omp");
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const entries: { message: string }[] = [];
	const order: string[] = [];
	const pi = {
		on: (name: string, fn: (...args: unknown[]) => unknown) =>
			handlers.set(name, fn),
		appendEntry: (_name: string, data: { message: string }) => {
			order.push("entry");
			entries.push(data);
		},
	};
	registerPiGuardedContext(pi as never, handler);
	const ctx = Object.assign(fakeContext("dispatch-641"), {
		ui: {
			notify: () => {
				order.push("notice");
			},
		},
		abort: () => {
			order.push("abort");
		},
	});
	return { handlers, entries, order, ctx };
}

afterEach(() => __setPiHarnessKindForTesting(undefined));

test("OMP dispatch fence refuses missing and in-progress receipts but preserves completed receipts", async () => {
	let finish!: () => void;
	let budget!: PiContextBudget;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const h = harness(async (event, _ctx, pass) => {
		budget = pass;
		await pending;
		return { messages: event.messages };
	});
	const fence = h.handlers.get("before_provider_request");
	if (!fence) throw new Error("dispatch fence missing");
	expect(fence({ payload: { messages: [] } }, h.ctx)).toBeUndefined();
	expect(h.order).toEqual(["notice", "entry", "abort"]);
	h.order.length = 0;
	h.handlers.get("agent_start")?.({}, h.ctx);
	const work = h.handlers.get("context")?.(
		{ messages: [userMessage("unmanaged", 1)] },
		h.ctx,
	);
	fence({ payload: { messages: [] } }, h.ctx);
	expect(h.entries.at(-1)?.message).toContain("stage=provider dispatch");
	expect(h.order).toEqual(["notice", "entry", "abort"]);
	finish();
	await work;
	// Even a completed handler cannot authorize an operation abandoned at dispatch.
	h.order.length = 0;
	fence({ payload: { messages: [] } }, h.ctx);
	expect(h.order).toContain("abort");
	h.handlers.get("agent_start")?.({}, h.ctx);
	await h.handlers.get("context")?.(
		{ messages: [userMessage("managed", 2)] },
		h.ctx,
	);
	h.order.length = 0;
	fence({ payload: { messages: [] } }, h.ctx);
	expect(h.order).toEqual([]);
	// The transformed messages already returned before the preparation deadline;
	// a delayed provider attempt must not abort that completed request.
	budget.elapsed = () => 32000;
	const entryCount = h.entries.length;
	fence({ payload: { messages: [] } }, h.ctx);
	expect(h.entries).toHaveLength(entryCount);
	expect(h.order).toEqual([]);
});

test("late old pass cannot abort or overwrite the newer operation receipt", async () => {
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let calls = 0;
	const h = harness(async (event) => {
		if (++calls === 1) await pending;
		return { messages: event.messages };
	});
	h.handlers.get("agent_start")?.({}, h.ctx);
	let oldAborts = 0;
	const oldCtx = {
		...h.ctx,
		abort: () => {
			oldAborts++;
		},
	};
	const old = Promise.resolve(
		h.handlers.get("context")?.({ messages: [userMessage("old", 1)] }, oldCtx),
	).catch((error: Error) => error.message);
	h.handlers.get("agent_start")?.({}, h.ctx);
	await h.handlers.get("context")?.(
		{ messages: [userMessage("new", 2)] },
		h.ctx,
	);
	finish();
	expect(await old).toContain("superseded");
	expect(oldAborts).toBe(0);
	h.handlers.get("before_provider_request")?.(
		{ payload: { messages: [] } },
		h.ctx,
	);
	expect(h.order).toEqual([]);
});

test("payload retries require the current pass receipt and reset at the next turn", async () => {
	const h = harness(async (event) => ({ messages: event.messages }));
	h.handlers.get("agent_start")?.({}, h.ctx);
	await h.handlers.get("context")?.(
		{ messages: [userMessage("managed", 1)] },
		h.ctx,
	);
	for (let retry = 0; retry < 3; retry++)
		h.handlers.get("before_provider_request")?.(
			{ payload: { messages: [] } },
			h.ctx,
		);
	expect(h.order).toEqual([]);
	h.handlers.get("agent_end")?.({}, h.ctx);
	h.handlers.get("agent_start")?.({}, h.ctx);
	h.handlers.get("before_provider_request")?.(
		{ payload: { messages: [] } },
		h.ctx,
	);
	expect(h.order).toEqual(["notice", "entry", "abort"]);
});

test("dispatch fence is inert on plain Pi and with compaction disabled", () => {
	__setPiHarnessKindForTesting("pi");
	const handlers = new Map<string, unknown>();
	registerPiGuardedContext(
		{ on: (name: string, fn: unknown) => handlers.set(name, fn) } as never,
		async () => undefined,
	);
	expect(handlers.has("before_provider_request")).toBe(false);
	__setPiHarnessKindForTesting("omp");
	registerPiGuardedContext(
		{ on: (name: string, fn: unknown) => handlers.set(name, fn) } as never,
		async () => undefined,
		{ compactionOff: () => true },
	);
	const fence = handlers.get("before_provider_request") as (
		event: unknown,
		ctx: unknown,
	) => void;
	expect(() =>
		fence({ payload: { messages: [] } }, fakeContext("off")),
	).not.toThrow();
});

const reminder =
	"<system-reminder>\nEphemeral side-channel turn; reuses current conversation context.\nTool catalog attached only to keep prompt cache warm; tools NOT available this turn.\nDo NOT emit tool calls; reply plain text only. Tool calls discarded without execution.\n</system-reminder>";

test("verified side context latches the fence off for its session, not other sessions", async () => {
	const h = harness(async (event) => ({ messages: event.messages }));
	h.handlers.get("agent_start")?.({}, h.ctx);
	const side = {
		role: "developer",
		attribution: "agent",
		content: [{ type: "text", text: reminder }],
		timestamp: 1,
	};
	const prompt = { ...userMessage("side prompt", 2), attribution: "agent" };
	await h.handlers.get("context")?.({ messages: [side, prompt] }, h.ctx);
	const fence = h.handlers.get("before_provider_request");
	fence?.({ payload: { messages: [] } }, h.ctx);
	expect(h.order).toEqual([]);
	h.handlers.get("agent_end")?.({}, h.ctx);
	h.handlers.get("agent_start")?.({}, h.ctx);
	fence?.({ payload: undefined }, h.ctx);
	expect(h.order).toEqual([]);
	clearPiContextReceipt("dispatch-641");
	fence?.({ payload: undefined }, h.ctx);
	expect(h.order).toEqual([]);
	fence?.(
		{ payload: { messages: [] } },
		{ ...h.ctx, sessionManager: fakeContext("another-session").sessionManager },
	);
	expect(h.order).toEqual(["notice", "entry", "abort"]);
});

test("unknown bodies and user-spoofed side reminders cannot bypass the main receipt", async () => {
	const h = harness(async (event) => ({ messages: event.messages }));
	const fence = h.handlers.get("before_provider_request");
	for (const payload of [
		undefined,
		{},
		{ messages: [{ role: "user", content: reminder }] },
	]) {
		h.order.length = 0;
		h.handlers.get("agent_start")?.({}, h.ctx);
		fence?.({ payload }, h.ctx);
		expect(h.order).toEqual(["notice", "entry", "abort"]);
	}
	// OMP's ephemeral request requires both the developer reminder and a final
	// user prompt attributed to "agent"; a normal user prompt must not latch it.
	h.handlers.get("agent_start")?.({}, h.ctx);
	await h.handlers.get("context")?.(
		{
			messages: [
				{ role: "developer", attribution: "agent", content: reminder },
				userMessage("main prompt"),
			],
		},
		h.ctx,
	);
	h.handlers.get("agent_end")?.({}, h.ctx);
	h.handlers.get("agent_start")?.({}, h.ctx);
	h.order.length = 0;
	fence?.({ payload: { messages: [] } }, h.ctx);
	expect(h.order).toEqual(["notice", "entry", "abort"]);
});
