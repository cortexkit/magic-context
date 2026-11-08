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

const SESSION = "issue-683-chat-history";
const model = {
	api: "openai-completions",
	provider: "cline-pass",
	id: "muse-spark-1.3-contributor",
	input: ["text", "image"],
	compat: { thinkingFormat: "openai", replayReasoningContent: false },
};
const header = {
	...userMessage("<session-history>current managed pass</session-history>", 1),
};
const prompt = { ...userMessage("latest user", 10) };
const assistant = (content: unknown[], timestamp: number) => ({
	role: "assistant",
	content,
	timestamp,
	api: model.api,
	provider: model.provider,
	model: model.id,
	stopReason: "stop",
});
const note =
	'<stale-tool-result tool="retired" id="orphan">\n§3§ exact old output\n</stale-tool-result>';
const orphan = {
	role: "toolResult",
	toolCallId: "orphan",
	toolName: "retired",
	content: [{ type: "text", text: "§3§ exact old output" }],
	isError: false,
	timestamp: 3,
};
const call = assistant(
	[{ type: "toolCall", id: "call", name: "Read", arguments: {} }],
	2,
);
const result = {
	role: "toolResult",
	toolCallId: "call",
	toolName: "Read",
	content: [
		{ type: "text", text: "output" },
		{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
	],
	isError: false,
	timestamp: 3,
};
const image = {
	role: "user",
	content: [
		{ type: "text", text: "Attached image(s) from tool result:" },
		{ type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZQ==" } },
	],
};
const wireCall = {
	role: "assistant",
	content: "",
	tool_calls: [
		{
			id: "call",
			type: "function",
			function: { name: "Read", arguments: "{}" },
		},
	],
};
const wireResult = { role: "tool", tool_call_id: "call", content: "output" };
function harness(messages: unknown[]) {
	__setPiHarnessKindForTesting("omp");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let current = messages;
	let aborts = 0;
	const refusals: string[] = [];
	const ctx = { ...fakeContext(SESSION), model, abort: () => aborts++ };
	registerPiGuardedContext(
		{
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(name, handler),
			appendEntry: (_type: string, data: { message: string }) =>
				refusals.push(data.message),
		} as never,
		async () => ({ messages: structuredClone(current) as never }),
	);
	const emit = (name: string, event: unknown = {}) => {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`missing ${name}`);
		return handler(event, ctx);
	};
	return {
		refusals,
		get stops() {
			return aborts + piBlockedDispatches(ctx);
		},
		async prepare(next = messages) {
			current = next;
			emit("agent_start");
			await emit("context", { messages: [prompt] });
		},
		dispatch(messages: unknown[]) {
			emit("before_provider_request", { payload: { messages } });
		},
	};
}
afterEach(() => {
	clearPiContextReceipt(SESSION);
	__setPiHarnessKindForTesting(undefined);
});

test("issue 683 chat history: empty and unsupported same-model reasoning rows disappear", async () => {
	const source = [
		header,
		assistant([], 2),
		assistant([{ type: "thinking", thinking: "private reasoning" }], 3),
		prompt,
	];
	const h = harness(source);
	await h.prepare();
	h.dispatch([header, prompt]);
	expect(h.stops).toBe(0);
	expect(h.refusals).toEqual([]);
});

test("issue 683 chat history: a dropped non-empty assistant must refuse", async () => {
	const source = [
		header,
		assistant([{ type: "text", text: "must survive" }], 2),
		prompt,
	];
	const h = harness(source);
	await h.prepare();
	h.dispatch([header, prompt]);
	expect(h.stops).toBe(1);
	expect(h.refusals[0]).toContain("prepared turn structure");
});

test("issue 683 chat history: supported or foreign reasoning cannot be silently omitted", () => {
	const source = [
		header,
		assistant([{ type: "thinking", thinking: "reasoning" }], 2),
		prompt,
	];
	expect(
		piMatchesPreparedStructure(
			{ messages: [header, prompt] },
			piPreparedStructure(source, {
				...model,
				compat: { replayReasoningContent: true },
			}),
		),
	).toBe(false);
	const foreign = [header, { ...source[1], provider: "other" }, prompt];
	expect(
		piMatchesPreparedStructure(
			{ messages: [header, prompt] },
			piPreparedStructure(foreign, model),
		),
	).toBe(false);
	expect(
		piMatchesPreparedStructure(
			{ messages: [header, prompt] },
			piPreparedStructure(source, { ...model, api: "anthropic-messages" }),
		),
	).toBe(false);
});

test("issue 683 chat history: latest prepared user remains required after empty-row omission", async () => {
	const h = harness([header, assistant([], 2), prompt]);
	await h.prepare();
	h.dispatch([header]);
	expect(h.stops).toBe(1);
});

test("issue 683 chat history: exact tool images follow the complete consecutive result run", async () => {
	const second = {
		...result,
		toolCallId: "second",
		content: [{ type: "text", text: "second output" }],
	};
	const both = assistant(
		[
			{ type: "toolCall", id: "call", name: "Read", arguments: {} },
			{ type: "toolCall", id: "second", name: "Read", arguments: {} },
		],
		2,
	);
	const h = harness([header, both, result, second, prompt]);
	await h.prepare();
	h.dispatch([
		header,
		{
			...wireCall,
			tool_calls: [
				...wireCall.tool_calls,
				{ ...wireCall.tool_calls[0], id: "second" },
			],
		},
		wireResult,
		{ ...wireResult, tool_call_id: "second", content: "second output" },
		image,
		prompt,
	]);
	expect(h.stops).toBe(0);
	expect(h.refusals).toEqual([]);
});

test("issue 683 chat history: an image row in the wrong place must refuse", async () => {
	const h = harness([header, call, result, prompt]);
	await h.prepare();
	h.dispatch([header, wireCall, image, wireResult, prompt]);
	expect(h.stops).toBe(1);
	expect(h.refusals[0]).toContain("prepared turn structure");
});

test("issue 683 chat history: image caption and bytes remain exact", () => {
	const prepared = piPreparedStructure([header, call, result, prompt], model);
	const changed = {
		...image,
		content: [
			image.content[0],
			{
				type: "image_url",
				image_url: { url: "data:image/png;base64,ZmFrZR==" },
			},
		],
	};
	expect(
		piMatchesPreparedStructure(
			{ messages: [header, wireCall, wireResult, changed, prompt] },
			prepared,
		),
	).toBe(false);
	expect(
		piMatchesPreparedStructure(
			{
				messages: [
					header,
					wireCall,
					wireResult,
					{
						...image,
						content: [
							{ type: "text", text: "other caption" },
							image.content[1],
						],
					},
					prompt,
				],
			},
			prepared,
		),
	).toBe(false);
});

test("issue 683 chat history: orphan note uses OMP's exact template from the managed result", async () => {
	const h = harness([header, orphan, prompt]);
	await h.prepare();
	h.dispatch([header, { role: "user", content: note }, prompt]);
	expect(h.stops).toBe(0);
	expect(h.refusals).toEqual([]);
});

test("issue 683 chat history: an orphan note differing by one byte must refuse", async () => {
	const h = harness([header, orphan, prompt]);
	await h.prepare();
	h.dispatch([
		header,
		{ role: "user", content: note.replace("exact", "exAct") },
		prompt,
	]);
	expect(h.stops).toBe(1);
	expect(h.refusals[0]).toContain("comparison=content");
	for (const privateValue of ["retired", "orphan", "old output"])
		expect(h.refusals[0]).not.toContain(privateValue);
});

test("issue 683 chat history: orphan error attribute and Unicode rendering match native bytes", () => {
	const malformed = {
		...orphan,
		isError: true,
		content: [{ type: "text", text: "bad\ud800unicode" }],
	};
	const expected =
		'<stale-tool-result tool="retired" id="orphan" is-error="true">\nbad\ufffdunicode\n</stale-tool-result>';
	expect(
		piMatchesPreparedStructure(
			{ messages: [header, { role: "user", content: expected }, prompt] },
			piPreparedStructure([header, malformed, prompt], model),
		),
	).toBe(true);
	expect(
		piMatchesPreparedStructure(
			{
				messages: [
					header,
					{ role: "user", content: expected.replace(' is-error="true"', "") },
					prompt,
				],
			},
			piPreparedStructure([header, malformed, prompt], model),
		),
	).toBe(false);
});

test("issue 683 chat history: an older pass's orphan note cannot establish current-pass identity", async () => {
	const h = harness([header, orphan, prompt]);
	await h.prepare();
	await h.prepare([header, { ...orphan, toolCallId: "replacement" }, prompt]);
	h.dispatch([header, { role: "user", content: note }, prompt]);
	expect(h.stops).toBe(1);
});

test("issue 683 chat history: paired results and elevated instructions cannot borrow orphan-note equivalence", () => {
	const prepared = piPreparedStructure([header, orphan, prompt], model);
	expect(
		piMatchesPreparedStructure(
			{ messages: [header, { role: "developer", content: note }, prompt] },
			prepared,
		),
	).toBe(false);
	const paired = piPreparedStructure(
		[
			header,
			assistant(
				[{ type: "toolCall", id: "orphan", name: "retired", arguments: {} }],
				2,
			),
			orphan,
			prompt,
		],
		model,
	);
	expect(
		piMatchesPreparedStructure(
			{
				messages: [
					header,
					{ role: "assistant", tool_calls: [{ id: "orphan" }] },
					{ role: "user", content: note },
					prompt,
				],
			},
			paired,
		),
	).toBe(false);
});

test("issue 683 chat history: raw history still refuses with a valid normalization plan", async () => {
	const h = harness([header, assistant([], 2), orphan, prompt]);
	await h.prepare();
	h.dispatch([
		{ role: "user", content: "raw older history" },
		{ role: "user", content: note },
		prompt,
	]);
	expect(h.stops).toBe(1);
	expect(h.refusals[0]).toContain("missing current receipt signature");
});
