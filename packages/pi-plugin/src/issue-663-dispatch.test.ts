import { afterEach, expect, test } from "bun:test";
import {
	clearPiContextReceipt,
	PiContextSupersededError,
	piBlockedDispatches,
	registerPiGuardedContext,
} from "./__tests__/dispatch-probe";
import type { PiContextBudget } from "./pi-context-budget";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext, userMessage } from "./test-utils.test";

function harness(handler: Parameters<typeof registerPiGuardedContext>[1]) {
	__setPiHarnessKindForTesting("omp");
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const refusals: string[] = [];
	let aborts = 0;
	registerPiGuardedContext(
		{
			on: (name: string, fn: (...args: unknown[]) => unknown) =>
				handlers.set(name, fn),
			appendEntry: (_type: string, data: { message: string }) =>
				refusals.push(data.message),
		} as never,
		handler,
	);
	const ctx = {
		...fakeContext("dispatch-663"),
		ui: { notify: () => {} },
		abort: () => aborts++,
	};
	return {
		ctx,
		refusals,
		get stops() {
			return aborts + piBlockedDispatches(ctx);
		},
		emit: (name: string, event: unknown = {}) => {
			const handler = handlers.get(name);
			if (!handler) throw new Error(`missing ${name} handler`);
			return handler(event, ctx);
		},
	};
}
const conversation = { messages: [userMessage("raw history", 1)] };
const payload = {
	payload: { messages: [{ role: "user", content: "managed history" }] },
};
afterEach(() => __setPiHarnessKindForTesting(undefined));

test("issue 663: a late first agent_start preserves the completed pass and its clock", async () => {
	let budget!: PiContextBudget;
	const managed = [userMessage("managed history", 1)];
	const h = harness(async (_event, _ctx, pass) => {
		budget = pass;
		return { messages: managed };
	});
	const result = await h.emit("context", conversation);
	expect(result).toEqual({ messages: managed });
	h.emit("agent_start");
	budget.elapsed = () => 32000;
	h.emit("before_provider_request", payload);
	expect(h.refusals).toEqual([]);
	expect(h.stops).toBe(0);
	expect(budget.completed).toBe(true);
});

test("issue 663: a late first agent_start preserves in-flight writer ownership", async () => {
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const h = harness(async (event, _ctx, budget) => {
		await pending;
		budget.assertOwner();
		return { messages: event.messages };
	});
	const work = h.emit("context", conversation);
	h.emit("agent_start");
	finish();
	await work;
	h.emit("before_provider_request", {
		payload: { messages: conversation.messages },
	});
	expect(h.stops).toBe(0);
	expect(h.refusals).toEqual([]);
});

test("issue 663: context before the next start cannot reuse an ended operation", async () => {
	const h = harness(async (event) => ({ messages: event.messages }));
	h.emit("agent_start");
	await h.emit("context", conversation);
	h.emit("agent_end");
	await h.emit("context", conversation);
	h.emit("agent_start");
	h.emit("before_provider_request", {
		payload: { messages: conversation.messages },
	});
	expect(h.refusals).toEqual([]);
	expect(h.stops).toBe(0);
});

test("issue 663: another start or cache eviction cannot borrow a previous receipt", async () => {
	const h = harness(async (event) => ({ messages: event.messages }));
	h.emit("agent_start");
	await h.emit("context", conversation);
	h.emit("agent_start");
	h.emit("before_provider_request", payload);
	expect(h.refusals.at(-1)).toContain("no context pass ran for this operation");
	expect(h.stops).toBe(1);
	await h.emit("context", conversation);
	clearPiContextReceipt("dispatch-663");
	h.emit("before_provider_request", payload);
	expect(h.refusals.at(-1)).toContain("no context pass ran for this operation");
	expect(h.stops).toBe(2);
});

test("issue 663: no-pass conversation and unknown bodies stay refused", () => {
	for (const body of [
		payload,
		{ payload: undefined },
		{ payload: {} },
		{ payload: { messages: [] } },
	]) {
		const h = harness(async (event) => ({ messages: event.messages }));
		h.emit("agent_start");
		h.emit("before_provider_request", body);
		expect(h.refusals.at(-1)).toContain(
			"no context pass ran for this operation",
		);
		expect(h.stops).toBe(1);
	}
});

test("issue 663: a pass without a result has a distinct receipt refusal", async () => {
	const h = harness(async () => undefined);
	h.emit("agent_start");
	await h.emit("context", conversation);
	h.emit("before_provider_request", payload);
	expect(h.refusals.at(-1)).toContain(
		"context pass ran without a managed context receipt",
	);
	expect(h.refusals.at(-1)).not.toContain("no context pass ran");
	expect(h.stops).toBe(1);
});

test("issue 663: ended run refusal preserves its ownership origin and preparation stage", async () => {
	let budget!: PiContextBudget;
	const h = harness(async (_event, _ctx, pass) => {
		budget = pass;
		pass.stage = "final publication";
		return { messages: [userMessage("managed history", 1)] };
	});
	h.emit("agent_start");
	await h.emit("context", conversation);
	h.emit("agent_end");
	budget.elapsed = () => 115468;
	h.emit("before_provider_request", payload);
	expect(h.stops).toBe(1);
	expect(h.refusals).toHaveLength(1);
	expect(h.refusals[0]).toContain(
		"stage=provider dispatch (origin=agent_end; context stage=final publication)",
	);
	expect(h.refusals[0]).toContain("elapsed=115468ms");
	expect(h.refusals[0]).toContain("recovery=no managed result; refused");
	expect(h.refusals[0]).toContain(
		"the run that owned the latest context pass has ended; no managed result for this request",
	);
	expect(h.refusals[0]).not.toContain("superseded context result");
	expect(h.refusals[0]).not.toContain("before writer admission");
});

test("issue 663: completed managed pass stays admitted when its writer owner guard reports supersession", async () => {
	let superseded = false;
	let ownerChecks = 0;
	const managed = [userMessage("managed history", 1)];
	const h = harness(async (_event, _ctx, budget) => {
		const owner = budget.assertOwner;
		budget.stage = "tagging";
		budget.assertOwner = () => {
			ownerChecks++;
			owner();
			if (superseded)
				throw new PiContextSupersededError(
					"Pi context pass superseded by a newer context generation",
					"context generation",
				);
		};
		return { messages: managed };
	});
	h.emit("agent_start");
	expect(await h.emit("context", conversation)).toEqual({ messages: managed });
	const preparationChecks = ownerChecks;
	const bytes = JSON.stringify(payload);
	superseded = true;
	h.emit("before_provider_request", payload);
	expect(ownerChecks).toBe(preparationChecks);
	expect(JSON.stringify(payload)).toBe(bytes);
	expect(h.stops).toBe(0);
	expect(h.refusals).toEqual([]);
});

test("issue 663: completed retry keeps managed bytes and the original clock after 115 seconds", async () => {
	let budget!: PiContextBudget;
	const h = harness(async (_event, _ctx, pass) => {
		budget = pass;
		return { messages: [userMessage("managed history", 1)] };
	});
	h.emit("agent_start");
	await h.emit("context", conversation);
	const bytes = JSON.stringify(payload);
	h.emit("before_provider_request", payload);
	budget.elapsed = () => 115468;
	h.emit("before_provider_request", payload);
	expect(JSON.stringify(payload)).toBe(bytes);
	expect(budget.elapsed()).toBe(115468);
	expect(h.stops).toBe(0);
	expect(h.refusals).toEqual([]);
});

const advisorPayload = {
	system: [
		{
			type: "text",
			text: "<conventions>\nRFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER`=`MUST NOT`; `AVOID`=`SHOULD NOT`.\n</conventions>\n\nUser, code-quality, robustness advocate; peer-shadow main agent.\n<workflow>\nReceive incremental agent transcript, including thoughts.\n",
		},
	],
	tools: [{ name: "_advise" }],
	messages: [
		{
			role: "user",
			content: [
				{ type: "text", text: "### Session update\n\n**user**:\nraw history" },
			],
		},
	],
};

test("issue 663: an identified advisor request needs no main pass and grants no receipt", () => {
	const h = harness(async (event) => ({ messages: event.messages }));
	for (const body of [
		advisorPayload,
		{
			instructions: advisorPayload.system[0].text,
			tools: [{ type: "function", name: "advise" }],
			input: [
				{
					role: "user",
					content: [
						{
							type: "input_text",
							text: "<system-reminder>\nToday: 2026-10-11; current working directory: '/throwaway'. Do not repeat this information in your reply.\n</system-reminder>",
						},
						{
							type: "input_text",
							text: "### Session update\n\n**user**:\nraw history",
						},
					],
				},
			],
		},
	])
		h.emit("before_provider_request", { payload: body });
	expect(h.stops).toBe(0);
	expect(h.refusals).toEqual([]);
	h.emit("agent_start");
	h.emit("before_provider_request", payload);
	expect(h.stops).toBe(1);
	expect(h.refusals.at(-1)).toContain("no context pass ran for this operation");
});

test("issue 663: advisor-looking user text and incomplete envelopes cannot bypass the fence", () => {
	for (const body of [
		{ ...advisorPayload, input: [] },
		{
			instructions: advisorPayload.system[0].text,
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: "### Session update\n\nraw history" },
					],
				},
			],
			messages: [],
			tools: [{ type: "function", name: "advise" }],
		},
		{
			instructions: "ordinary conversation system",
			input: [
				{
					role: "user",
					content: [
						{
							type: "input_text",
							text:
								advisorPayload.system[0].text +
								"\n### Session update\n\nraw history",
						},
					],
				},
			],
			tools: [{ type: "function", name: "advise" }],
		},
		{ ...advisorPayload, system: "ordinary conversation system" },
		{ ...advisorPayload, tools: [{ name: "_read" }] },
		{
			...advisorPayload,
			messages: [{ role: "user", content: "ordinary conversation" }],
		},
		{
			...advisorPayload,
			system: [],
			messages: [
				{
					role: "user",
					content:
						advisorPayload.system[0].text +
						"\n### Session update\n\nraw history",
				},
			],
		},
		{
			instructions: advisorPayload.system[0].text,
			input: advisorPayload.messages,
			tools: advisorPayload.tools,
		},
	]) {
		const h = harness(async (event) => ({ messages: event.messages }));
		h.emit("before_provider_request", { payload: body });
		expect(h.stops).toBe(1);
	}
});

test("issue 663: raw auto-learn capture cannot borrow a completed conversation receipt", async () => {
	const h = harness(async (event) => ({ messages: event.messages }));
	h.emit("agent_start");
	await h.emit("context", conversation);
	h.emit("before_provider_request", {
		payload: {
			system: "ordinary conversation system",
			tools: [{ name: "_manage_skill" }],
			messages: [
				{ role: "user", content: "raw history" },
				{
					role: "user",
					content:
						"Automated capture turn — not a user reply; user has not responded to your previous turn.\n\nCapture output then stop.",
				},
			],
		},
	});
	expect(h.stops).toBe(1);
	expect(h.refusals.at(-1)).toContain(
		"no context pass ran for OMP auto-learn capture; raw conversation refused",
	);
});

test("issue 663: ordinary context and dispatch preserve managed bytes", async () => {
	const managed = [userMessage("managed history", 1)];
	const h = harness(async () => ({ messages: managed }));
	h.emit("agent_start");
	const result = (await h.emit("context", conversation)) as {
		messages: typeof managed;
	};
	expect(result.messages).toBe(managed);
	const request = {
		payload: {
			system: "ordinary",
			messages: [{ role: "user", content: "managed history" }],
			tools: [],
		},
	};
	h.emit("before_provider_request", request);
	expect(request).toEqual({
		payload: {
			system: "ordinary",
			messages: [{ role: "user", content: "managed history" }],
			tools: [],
		},
	});
	expect(h.stops).toBe(0);
});

test("issue 663: Responses auto-learn capture cannot borrow a completed receipt", async () => {
	const h = harness(async (event) => ({ messages: event.messages }));
	h.emit("agent_start");
	await h.emit("context", conversation);
	h.emit("before_provider_request", {
		payload: {
			instructions: "ordinary conversation system",
			tools: [{ type: "function", name: "manage_skill" }],
			input: [
				{
					role: "user",
					content: [{ type: "input_text", text: "raw history" }],
				},
				{
					role: "user",
					content: [
						{
							type: "input_text",
							text: "Automated capture turn — not a user reply; user has not responded to your previous turn.\n\nCapture output then stop.",
						},
					],
				},
			],
		},
	});
	expect(h.stops).toBe(1);
	expect(h.refusals.at(-1)).toContain(
		"no context pass ran for OMP auto-learn capture; raw conversation refused",
	);
});
