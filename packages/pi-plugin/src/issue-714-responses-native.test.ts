import { afterEach, expect, test } from "bun:test";
import {
	clearPiContextReceipt,
	piBlockedDispatches,
	registerPiGuardedContext,
} from "./__tests__/dispatch-probe";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext, userMessage } from "./test-utils.test";

// A Codex session refused every turn at the first assistant row whose stored
// native payload held reasoning and function_call items next to its message.
// The shapes below are what OMP 18.10.4, 18.11.1 and 18.11.3 persist for a
// Codex turn and what OMP's Codex Responses encoder puts on the wire for them.
const session = "issue-714-responses";
const model = {
	api: "openai-codex-responses",
	provider: "openai-codex",
	id: "gpt-5.6-luna",
};
const own = { api: model.api, provider: model.provider, model: model.id };
const signature = (id: string, phase: string) =>
	JSON.stringify({ v: 1, id, phase });
const reasoningItem = (id: string) => ({
	type: "reasoning",
	id,
	summary: [],
	encrypted_content: `opaque-${id}`,
});
const messageItem = (text: string, id: string, phase: string) => ({
	type: "message",
	role: "assistant",
	id,
	phase,
	status: "completed",
	content: [{ type: "output_text", text, annotations: [] }],
});
const callItem = (callId: string, itemId: string) => ({
	type: "function_call",
	id: itemId,
	call_id: callId,
	name: "read",
	arguments: "{}",
});
const wireText = (text: string, phase?: string) => ({
	type: "message",
	role: "assistant",
	...(phase ? { phase } : {}),
	content: [{ type: "output_text", text, annotations: [] }],
});

/** A Codex tool turn as OMP stores it after its own SSE parser finalizes. */
function codexToolTurn(overrides: { items?: unknown[]; dt?: boolean } = {}) {
	return {
		role: "assistant",
		...own,
		stopReason: "toolUse",
		content: [
			{
				type: "thinking",
				thinking: "",
				thinkingSignature: JSON.stringify(reasoningItem("rs_own")),
				summary: false,
			},
			{
				type: "text",
				text: "§2§ checking the file",
				textSignature: signature("msg_own", "commentary"),
			},
			{ type: "toolCall", id: "call_own|fc_own", name: "read", arguments: {} },
		],
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: model.provider,
			...(overrides.dt === false ? {} : { dt: true }),
			items: overrides.items ?? [
				reasoningItem("rs_own"),
				messageItem("checking the file", "msg_own", "commentary"),
				callItem("call_own", "fc_own"),
			],
		},
	};
}
const toolResult = {
	role: "toolResult",
	toolCallId: "call_own|fc_own",
	toolName: "read",
	content: [{ type: "text", text: "§3§ file body" }],
};
const prepared = (turn: unknown = codexToolTurn()) => [
	userMessage("<session-history>managed</session-history>", 1),
	turn,
	toolResult,
	userMessage("§4§ current prompt", 2),
];
/** The input array OMP's Codex encoder sends for the prepared messages. */
const wire = (assistantItems: unknown[] = nativeWire()) => ({
	input: [
		{
			role: "user",
			content: [
				{
					type: "input_text",
					text: "<session-history>managed</session-history>",
				},
			],
		},
		...assistantItems,
		{
			type: "function_call_output",
			call_id: "call_own",
			output: "§3§ file body",
		},
		{
			role: "user",
			content: [{ type: "input_text", text: "§4§ current prompt" }],
		},
	],
});
const nativeWire = (text = "checking the file") => [
	{ type: "reasoning", summary: [], encrypted_content: "opaque-rs_own" },
	wireText(text, "commentary"),
	{ type: "function_call", call_id: "call_own", name: "read", arguments: "{}" },
];

function harness(messages: unknown[]) {
	__setPiHarnessKindForTesting("omp");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const refusals: string[] = [];
	let aborts = 0;
	const ctx = { ...fakeContext(session), model, abort: () => aborts++ };
	registerPiGuardedContext(
		{
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(name, handler),
			appendEntry: (_: string, data: { message: string }) =>
				refusals.push(data.message),
		} as never,
		async () => ({ messages: structuredClone(messages) }) as never,
	);
	const emit = (name: string, event: unknown = {}) => {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`missing handler ${name}`);
		return handler(event, ctx);
	};
	return {
		refusals,
		get stops() {
			return aborts + piBlockedDispatches(ctx);
		},
		async prepare() {
			emit("agent_start");
			await emit("context", { messages: [userMessage("current prompt", 2)] });
		},
		dispatch(body: unknown) {
			emit("before_provider_request", { payload: body });
		},
	};
}

afterEach(() => {
	clearPiContextReceipt(session);
	__setPiHarnessKindForTesting(undefined);
});

async function dispatch(messages: unknown[], body: unknown) {
	const h = harness(messages);
	await h.prepare();
	h.dispatch(body);
	return h;
}

test("issue 714 Codex native replay: own turn with reasoning, commentary and a call admits", async () => {
	const h = await dispatch(prepared(), wire());
	expect(h.refusals).toEqual([]);
	expect(h.stops).toBe(0);
});

test("issue 714 Codex native replay: whitespace-only final_answer that OMP drops admits", async () => {
	// gpt-5.6 Codex can end a commentary-only turn with an empty final_answer
	// message; OMP drops it from replay (utils.ts:343-420 in 18.11.3).
	const turn = {
		role: "assistant",
		...own,
		stopReason: "stop",
		content: [
			{
				type: "text",
				text: "§2§ checking the file",
				textSignature: signature("msg_own", "commentary"),
			},
			{
				type: "text",
				text: "",
				textSignature: signature("msg_empty", "final_answer"),
			},
		],
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: model.provider,
			dt: true,
			items: [
				messageItem("checking the file", "msg_own", "commentary"),
				messageItem("", "msg_empty", "final_answer"),
			],
		},
	};
	const head = {
		role: "user",
		content: [
			{
				type: "input_text",
				text: "<session-history>managed</session-history>",
			},
		],
	};
	const h = await dispatch(
		[
			userMessage("<session-history>managed</session-history>", 1),
			turn,
			userMessage("§4§ current prompt", 2),
		],
		{
			input: [
				head,
				wireText("checking the file", "commentary"),
				{
					role: "user",
					content: [{ type: "input_text", text: "§4§ current prompt" }],
				},
			],
		},
	);
	expect(h.refusals).toEqual([]);
	expect(h.stops).toBe(0);
});

test("issue 714 Codex native replay guard: cached text the prepared block does not own refuses", async () => {
	const turn = codexToolTurn({
		items: [
			reasoningItem("rs_own"),
			messageItem("UNMANAGED cached text", "msg_own", "commentary"),
			callItem("call_own", "fc_own"),
		],
	});
	const h = await dispatch(
		prepared(turn),
		wire(nativeWire("UNMANAGED cached text")),
	);
	expect(h.stops).toBe(1);
	expect(h.refusals[0]).toContain("comparison=content");
});

test("issue 714 Codex native replay guard: an extra cached message refuses", async () => {
	const turn = codexToolTurn({
		items: [
			reasoningItem("rs_own"),
			messageItem("checking the file", "msg_own", "commentary"),
			messageItem("UNMANAGED extra", "msg_extra", "final_answer"),
			callItem("call_own", "fc_own"),
		],
	});
	const [reasoning, text, call] = nativeWire();
	const h = await dispatch(
		prepared(turn),
		wire([reasoning, text, wireText("UNMANAGED extra", "final_answer"), call]),
	);
	expect(h.stops).toBe(1);
	expect(h.refusals[0]).toContain("comparison=content");
});

test("issue 714 Codex native replay guard: a cached user item refuses", async () => {
	const turn = codexToolTurn({
		items: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "UNMANAGED user" }],
			},
			reasoningItem("rs_own"),
			messageItem("checking the file", "msg_own", "commentary"),
			callItem("call_own", "fc_own"),
		],
	});
	const h = await dispatch(
		prepared(turn),
		wire([
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "UNMANAGED user" }],
			},
			...nativeWire(),
		]),
	);
	expect(h.stops).toBe(1);
	expect(h.refusals[0]).toContain("prepared turn structure");
});

test("issue 714 Codex native replay guard: a replacement cache without dt refuses", async () => {
	const h = await dispatch(prepared(codexToolTurn({ dt: false })), wire());
	expect(h.stops).toBe(1);
	expect(h.refusals[0]).toContain("comparison=content");
});

test("issue 714 Codex native replay guard: a cached call the prepared turn lacks refuses", async () => {
	const turn = codexToolTurn({
		items: [
			reasoningItem("rs_own"),
			messageItem("checking the file", "msg_own", "commentary"),
			callItem("call_own", "fc_own"),
			callItem("call_foreign", "fc_foreign"),
		],
	});
	const h = await dispatch(
		prepared(turn),
		wire([
			...nativeWire(),
			{
				type: "function_call",
				call_id: "call_foreign",
				name: "read",
				arguments: "{}",
			},
		]),
	);
	expect(h.stops).toBe(1);
	expect(h.refusals[0]).toContain("prepared turn structure");
});

// An assistant turn from another model with thinking and a phase-signed text.
// OMP's transformMessages demotes that thinking into the target model's
// <think> wrapper and strips the text signature, so neither a reasoning item
// nor a phase reaches the wire (transform-messages.ts:1056-1106,1161-1166 in
// 18.11.3).
const foreign = {
	role: "assistant",
	api: "openai-completions",
	provider: "openrouter",
	model: "z-ai/glm-5.3",
	stopReason: "toolUse",
	content: [
		{ type: "thinking", thinking: "foreign reasoning" },
		{
			type: "text",
			text: "§2§ foreign answer",
			textSignature: signature("msg_foreign", "final_answer"),
		},
		{ type: "toolCall", id: "call_own|fc_own", name: "read", arguments: {} },
	],
};
const foreignWire = (phase?: string) => [
	wireText("<think>\nforeign reasoning\n</think>"),
	wireText("§2§ foreign answer", phase),
	{ type: "function_call", call_id: "call_own", name: "read", arguments: "{}" },
];

test("issue 714 cross-model Responses history: demoted thinking and phase-free text admit", async () => {
	const h = await dispatch(prepared(foreign), wire(foreignWire()));
	expect(h.refusals).toEqual([]);
	expect(h.stops).toBe(0);
});

test("issue 714 cross-model Responses history guard: a phase OMP never sends refuses", async () => {
	const h = await dispatch(
		prepared(foreign),
		wire(foreignWire("final_answer")),
	);
	expect(h.stops).toBe(1);
	expect(h.refusals[0]).toContain("comparison=content");
});
