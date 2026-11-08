import { afterEach, expect, test } from "bun:test";
import {
	clearPiContextReceipt,
	piBlockedDispatches,
	registerPiGuardedContext,
} from "./__tests__/dispatch-probe";
import {
	piMatchesPreparedStructure,
	piPreparedStructure,
} from "./pi-dispatch-structure";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext, userMessage } from "./test-utils.test";

const session = "issue-686-responses";
const model = { api: "openai-responses", provider: "zen", id: "mock" };
const signed = (text: string, id: string) => ({
	role: "assistant",
	...model,
	model: model.id,
	content: [
		{
			type: "text",
			text,
			textSignature: JSON.stringify({ v: 1, id, phase: "commentary" }),
		},
	],
});
const item = (text: string, phase?: string) => ({
	type: "message",
	role: "assistant",
	...(phase ? { phase } : {}),
	content: [{ type: "output_text", text, annotations: [] }],
});
const thinkingAssistant = (content: unknown[]) => ({
	role: "assistant",
	api: model.api,
	provider: model.provider,
	model: model.id,
	content,
});
const thinkingBlock = () => ({
	type: "thinking",
	thinking: "private signed reasoning",
	thinkingSignature: "opaque-signature",
});
const cache = () => ({
	...signed("§3§ cached commentary", "rs_cached"),
	providerPayload: {
		type: "openaiResponsesHistory",
		provider: "zen",
		dt: true,
		items: [{ ...item("cached commentary", "commentary"), id: "rs_cached" }],
	},
});
const prepared = () => [
	userMessage("<session-history>managed</session-history>", 1),
	signed("§2§ signed commentary", "rs_signed"),
	cache(),
	{
		role: "assistant",
		api: "openai-completions",
		content: [{ type: "text", text: "§4§ completion-lane answer" }],
	},
	{
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call_686|fc_686", name: "Read", arguments: {} },
		],
	},
	{
		role: "toolResult",
		toolCallId: "call_686|fc_686",
		content: [{ type: "text", text: "answer" }],
	},
	userMessage("current prompt", 2),
];
const payload = () => ({
	input: [
		{ role: "user", content: "<session-history>managed</session-history>" },
		item("§2§ signed commentary", "commentary"),
		item("cached commentary", "commentary"),
		item("§4§ completion-lane answer"),
		{
			type: "function_call",
			call_id: "call_686",
			name: "Read",
			arguments: "{}",
		},
		{ type: "function_call_output", call_id: "call_686", output: "answer" },
		{ role: "user", content: "current prompt" },
	],
});

function harness(messages: unknown[] = prepared()) {
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

test("issue 686 Responses text-item equivalence: adjacent signed, cached and completion-lane text admits", async () => {
	const h = harness();
	await h.prepare();
	expect(
		piMatchesPreparedStructure(
			payload(),
			piPreparedStructure(prepared(), model),
		),
	).toBe(true);
	h.dispatch(payload());
	expect(h.refusals).toEqual([]);
	expect(h.stops).toBe(0);
});

for (const [name, index] of [
	["signed commentary", 1],
	["cached commentary", 2],
	["completion-lane answer", 3],
] as const) {
	test(`issue 686 Responses text-item guard: dropped ${name} refuses`, async () => {
		const h = harness();
		await h.prepare();
		const body = payload();
		body.input.splice(index, 1);
		h.dispatch(body);
		expect(h.stops).toBe(1);
		expect(h.refusals[0]).toContain("comparison=content");
	});
}

test("issue 686 Responses text-item guard: reordered text refuses", async () => {
	const h = harness();
	await h.prepare();
	const body = payload();
	[body.input[1], body.input[2]] = [body.input[2], body.input[1]];
	h.dispatch(body);
	expect(h.stops).toBe(1);
	expect(h.refusals[0]).toContain("comparison=content");
});

test("issue 686 Responses text-item guard: changed phase refuses", async () => {
	const h = harness();
	await h.prepare();
	const body = payload();
	body.input[1] = item("§2§ signed commentary", "final_answer");
	h.dispatch(body);
	expect(h.stops).toBe(1);
	expect(h.refusals[0]).toContain("comparison=content");
});

for (const field of [
	"api",
	"model",
	"provider",
	"dt",
	"signature",
	"text",
	"native-phase",
] as const) {
	test(`issue 686 Responses native replay guard: mismatched ${field} refuses`, async () => {
		const messages = prepared();
		const cached = messages[2] as ReturnType<typeof cache>;
		if (field === "api") cached.api = "openai-completions";
		if (field === "model") cached.model = "other-model";
		if (field === "provider")
			cached.providerPayload.provider = "other-provider";
		if (field === "dt") cached.providerPayload.dt = false;
		if (field === "signature")
			cached.content[0].textSignature = JSON.stringify({
				v: 1,
				id: "rs_other",
				phase: "commentary",
			});
		if (field === "text") cached.content[0].text = "§3§ changed managed text";
		if (field === "native-phase")
			cached.providerPayload.items[0].phase = "final_answer";
		const h = harness(messages);
		await h.prepare();
		const body = payload();
		if (field === "native-phase")
			body.input[2] = item("cached commentary", "final_answer");
		h.dispatch(body);
		expect(h.stops).toBe(1);
		expect(h.refusals[0]).toContain("comparison=content");
	});
}

test("issue 686 Responses native replay guard: truncated text payload refuses", async () => {
	const messages = prepared();
	(messages[2] as ReturnType<typeof cache>).providerPayload.items = [];
	const h = harness(messages);
	await h.prepare();
	const body = payload();
	body.input.splice(2, 1);
	h.dispatch(body);
	expect(h.stops).toBe(1);
	expect(h.refusals[0]).toContain("comparison=content");
});

for (const boundary of ["user", "toolResult"] as const) {
	test(`issue 686 Responses grouping guard: merging across ${boundary} refuses`, async () => {
		const messages = [
			prepared()[0],
			{
				role: "assistant",
				content: [
					{ type: "text", text: "first answer" },
					...(boundary === "toolResult"
						? [
								{
									type: "toolCall",
									id: "boundary_call",
									name: "Read",
									arguments: {},
								},
							]
						: []),
				],
			},
			boundary === "user"
				? userMessage("intermediate prompt", 3)
				: {
						role: "toolResult",
						toolCallId: "boundary_call",
						content: [{ type: "text", text: "boundary result" }],
					},
			{ role: "assistant", content: [{ type: "text", text: "second answer" }] },
			userMessage("current prompt", 4),
		];
		const h = harness(messages);
		await h.prepare();
		h.dispatch({
			input: [
				{ role: "user", content: "<session-history>managed</session-history>" },
				item("first answer"),
				...(boundary === "toolResult"
					? [
							{
								type: "function_call",
								call_id: "boundary_call",
								name: "Read",
								arguments: "{}",
							},
						]
					: []),
				item("second answer"),
				{ role: "user", content: "current prompt" },
			],
		});
		expect(h.stops).toBe(1);
		expect(h.refusals[0]).toContain("prepared turn structure");
	});
}

test("issue 686 Responses text-item guard: raw request still refuses", async () => {
	const h = harness();
	await h.prepare();
	const body = payload();
	body.input[0] = { role: "user", content: "raw older history" };
	h.dispatch(body);
	expect(h.stops).toBe(1);
	expect(h.refusals[0]).toContain("missing current receipt signature");
});

test("issue 686 Responses text-item guard: latest turn and ordered call IDs remain required", async () => {
	for (const change of ["latest", "call", "result"] as const) {
		const h = harness();
		await h.prepare();
		const body = payload();
		if (change === "latest") body.input.pop();
		if (change === "call")
			body.input[4] = {
				type: "function_call",
				call_id: "foreign",
				name: "Read",
				arguments: "{}",
			};
		if (change === "result")
			body.input[5] = {
				type: "function_call_output",
				call_id: "foreign",
				output: "answer",
			};
		h.dispatch(body);
		expect(h.stops).toBe(1);
		expect(h.refusals[0]).toContain("prepared turn structure");
	}
});

test("issue 686 Responses grouping: same-model signed thinking, text and tool calls match reasoning, output text and calls", async () => {
	const messages = [
		userMessage("earlier prompt", 1),
		thinkingAssistant([
			thinkingBlock(),
			{
				type: "text",
				text: "visible answer",
				textSignature: JSON.stringify({
					v: 1,
					id: "rs_visible",
					phase: "commentary",
				}),
			},
			{ type: "toolCall", id: "call_686|fc_686", name: "Read", arguments: {} },
		]),
		signed("follow-up answer", "rs_followup"),
		{
			role: "toolResult",
			toolCallId: "call_686|fc_686",
			content: [{ type: "text", text: "read result" }],
		},
		userMessage("current prompt", 2),
	];
	const h = harness(messages);
	await h.prepare();
	h.dispatch({
		input: [
			{ role: "user", content: "earlier prompt" },
			{ type: "reasoning", id: "rs_reasoning", encrypted_content: "opaque" },
			item("visible answer", "commentary"),
			{
				type: "function_call",
				call_id: "call_686",
				name: "Read",
				arguments: "{}",
			},
			// The follow-up assistant closes the call's window, so Oh My Pi moves
			// the later result ahead of it (transformMessages takeRealToolResult).
			{
				type: "function_call_output",
				call_id: "call_686",
				output: "read result",
			},
			item("follow-up answer", "commentary"),
			{ role: "user", content: "current prompt" },
		],
	});
	expect(h.stops).toBe(0);
	expect(h.refusals).toEqual([]);
});

test("issue 686 Responses grouping: thinking-only assistant adds no row between assistants", async () => {
	const messages = [
		userMessage("earlier prompt", 1),
		signed("first answer", "rs_first"),
		thinkingAssistant([thinkingBlock()]),
		signed("second answer", "rs_second"),
		userMessage("current prompt", 2),
	];
	const h = harness(messages);
	await h.prepare();
	h.dispatch({
		input: [
			{ role: "user", content: "earlier prompt" },
			item("first answer", "commentary"),
			{ type: "reasoning", id: "rs_reasoning", encrypted_content: "opaque" },
			item("second answer", "commentary"),
			{ role: "user", content: "current prompt" },
		],
	});
	expect(h.stops).toBe(0);
	expect(h.refusals).toEqual([]);
});

test("issue 686 Responses grouping guard: thinking exemption retains every prepared text block", async () => {
	const messages = [
		userMessage("earlier prompt", 1),
		thinkingAssistant([
			thinkingBlock(),
			{
				type: "text",
				text: "first answer",
				textSignature: JSON.stringify({
					v: 1,
					id: "rs_first",
					phase: "commentary",
				}),
			},
			{
				type: "text",
				text: "second answer",
				textSignature: JSON.stringify({
					v: 1,
					id: "rs_second",
					phase: "commentary",
				}),
			},
		]),
		userMessage("current prompt", 2),
	];
	const variants = [
		[item("second answer", "commentary"), item("first answer", "commentary")],
		[item("first answer", "commentary")],
		[
			item("first answer", "commentary"),
			item("<thinking>unprepared wire text</thinking>", "commentary"),
		],
	];
	for (const textItems of variants) {
		const h = harness(messages);
		await h.prepare();
		h.dispatch({
			input: [
				{ role: "user", content: "earlier prompt" },
				{ type: "reasoning", id: "rs_reasoning", encrypted_content: "opaque" },
				...textItems,
				{ role: "user", content: "current prompt" },
			],
		});
		expect(h.stops).toBe(1);
		expect(h.refusals[0]).toContain("comparison=content");
	}
});

test("issue 686 Responses grouping: unknown and cross-model thinking keep representation unavailable", () => {
	const unknown = piPreparedStructure(
		[thinkingAssistant([{ type: "unknown", text: "not canonical thinking" }])],
		model,
	);
	expect(unknown?.responsesMessages).toBeUndefined();

	const crossModel = thinkingAssistant([thinkingBlock()]);
	crossModel.model = "other-model";
	expect(
		piPreparedStructure([crossModel], model)?.responsesMessages,
	).toBeUndefined();

	const incompleteModelMessage = {
		role: "assistant",
		api: model.api,
		content: [thinkingBlock()],
	};
	expect(
		piPreparedStructure([incompleteModelMessage], { api: model.api })
			?.responsesMessages,
	).toBeUndefined();
});
