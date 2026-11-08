import { afterEach, expect, spyOn, test } from "bun:test";
import * as logger from "@magic-context/core/shared/logger";
import {
	clearPiContextReceipt,
	piBlockedDispatches,
	registerPiGuardedContext,
} from "./__tests__/dispatch-probe";
import { piAgentHistory } from "./pi-dispatch-agent-history";
import { piResponsesAssistantTexts } from "./pi-dispatch-responses-history";
import {
	piMatchesPreparedStructure,
	piPreparedStructure,
} from "./pi-dispatch-structure";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext, userMessage } from "./test-utils.test";

const model = {
	api: "openai-responses",
	provider: "opencode-zen",
	id: "muse-spark-1.3-contributor-free",
};
const head = userMessage(
	"<session-history>current managed head</session-history>",
	1,
);
const prompt = userMessage("current prompt", 2);
const custom = (content: unknown, extra: object = {}) => ({
	role: "custom",
	customType: "notice",
	content,
	...extra,
});
const item = (text: string) => ({
	role: "assistant",
	type: "message",
	content: [{ type: "output_text", text }],
});
const foreign = (content: unknown[]) => ({
	role: "assistant",
	api: "openai-completions",
	provider: "deepseek",
	model: "deepseek-v4.1-flash",
	content,
});

afterEach(() => {
	clearPiContextReceipt("issue-686-r3");
	__setPiHarnessKindForTesting(undefined);
});

test("issue 686 custom display flags never filter valid context content", () => {
	for (const display of [true, false, undefined]) {
		const rows = piAgentHistory([custom("visible to the model", { display })]);
		expect(rows).toEqual([
			expect.objectContaining({
				role: "user",
				content: [{ type: "text", text: "visible to the model" }],
			}),
		]);
	}
});

test("issue 686 invalid custom content vanishes before provider planning", () => {
	expect(piAgentHistory([custom({ not: "content" }), custom(null)])).toEqual(
		[],
	);
});

test("issue 686 ordinary custom images split while user skill and steering stay one row", () => {
	const content = [
		{ type: "text", text: "instruction" },
		{ type: "image", data: "aA==", mimeType: "image/png" },
	];
	expect(piAgentHistory([custom(content)])).toEqual([
		expect.objectContaining({ role: "user", content: [content[0]] }),
		expect.objectContaining({
			role: "user",
			content: [
				{ type: "text", text: "Images attached to notice." },
				content[1],
			],
		}),
	]);
	for (const customType of ["skill-prompt", "collab-prompt"]) {
		expect(
			piAgentHistory([custom(content, { customType, attribution: "user" })]),
		).toHaveLength(1);
		expect(
			piAgentHistory([custom(content, { customType, attribution: "agent" })]),
		).toHaveLength(2);
	}
});

test("issue 686 summary wrappers survive but empty literal blocks vanish on filtering lanes", () => {
	for (const api of [
		"openai-completions",
		"openai-responses",
		"azure-openai-responses",
		"openai-codex-responses",
	]) {
		for (const prefix of [[], [head]]) {
			const messages = [
				...prefix,
				{ role: "compactionSummary", summary: "", blocks: [] },
				prompt,
			];
			const structure = piPreparedStructure(messages, { ...model, api });
			const rows =
				api === "openai-completions"
					? structure?.chatMessages
					: structure?.responsesMessages;
			expect(rows).toHaveLength(prefix.length + 1);
			const wrapped = piPreparedStructure(
				[...prefix, { role: "compactionSummary", summary: "" }, prompt],
				{ ...model, api },
			);
			expect(
				api === "openai-completions"
					? wrapped?.chatMessages
					: wrapped?.responsesMessages,
			).toHaveLength(prefix.length + 2);
		}
	}
});

test("issue 686 custom and summaries project on every lane including Ollama system placement", () => {
	for (const api of [
		"openai-completions",
		"openai-responses",
		"azure-openai-responses",
		"openai-codex-responses",
		"openrouter",
		"anthropic-messages",
		"bedrock-converse-stream",
		"google-generative-ai",
		"google-gemini-cli",
		"google-vertex",
		"ollama-chat",
	]) {
		const snapshot = piPreparedStructure(
			[
				head,
				custom("context", { display: false }),
				{ role: "compactionSummary", summary: "", blocks: [] },
				prompt,
			],
			{ ...model, api },
		);
		expect(snapshot?.messages).toHaveLength(api === "ollama-chat" ? 4 : 3);
		expect(piAgentHistory([custom("prefix")], api)[0]).toMatchObject({
			role: api === "ollama-chat" ? "developer" : "user",
		});
	}
	const ollama = piPreparedStructure(
		[custom("prefix"), head, custom("middle"), prompt],
		{ api: "ollama-chat" },
	);
	expect(
		piMatchesPreparedStructure(
			{
				messages: [
					{ role: "system", content: "prefix" },
					{ role: "user", content: head.content },
					{ role: "system", content: "middle" },
					{ role: "user", content: "current prompt" },
				],
			},
			ollama,
		),
	).toBe(true);
});

test("issue 686 blank custom rows follow provider omission not display or customType", () => {
	for (const api of ["openai-completions", "openai-responses"]) {
		const snapshot = piPreparedStructure(
			[
				head,
				custom(" \n", { display: true }),
				custom([], { display: false }),
				prompt,
			],
			{ ...model, api },
		);
		expect(
			api === "openai-completions"
				? snapshot?.chatMessages
				: snapshot?.responsesMessages,
		).toHaveLength(2);
	}
});

test("issue 686 foreign Responses thinking becomes target dialect text before ordered text and calls", () => {
	const source = foreign([
		{ type: "thinking", thinking: "earlier reasoning\ud800" },
		{
			type: "text",
			text: "answer",
			textSignature: JSON.stringify({ v: 1, id: "old", phase: "commentary" }),
		},
		{ type: "toolCall", id: "call_686", name: "Read", arguments: {} },
	]);
	expect(piResponsesAssistantTexts(source, model)).toEqual([
		JSON.stringify(["<thinking>\nearlier reasoning�\n</thinking>", null]),
		JSON.stringify(["answer", null]),
	]);
	expect(
		piResponsesAssistantTexts(source, { ...model, id: "gpt-5" })?.[0],
	).toBe(JSON.stringify(["<think>\nearlier reasoning�\n</think>", null]));
	const prepared = piPreparedStructure(
		[
			head,
			foreign([{ type: "text", text: "adjacent answer" }]),
			source,
			prompt,
		],
		model,
	);
	expect(prepared?.responsesMessages).toHaveLength(4);
	const body = {
		input: [
			{ role: "user", content: head.content },
			item("adjacent answer"),
			item("<thinking>\nearlier reasoning�\n</thinking>"),
			item("answer"),
			{
				type: "function_call",
				call_id: "call_686",
				name: "Read",
				arguments: "{}",
			},
			{
				type: "function_call_output",
				call_id: "call_686",
				output: "No result provided",
			},
			{ role: "user", content: "current prompt" },
		],
	};
	expect(piMatchesPreparedStructure(body, prepared)).toBe(true);
	const changed = structuredClone(body);
	changed.input.splice(2, 1);
	expect(piMatchesPreparedStructure(changed, prepared)).toBe(false);
});

test("issue 686 blank foreign thinking and interrupted thinking-only Responses emit no text row", () => {
	expect(
		piResponsesAssistantTexts(
			foreign([{ type: "thinking", thinking: " \n" }]),
			model,
		),
	).toEqual([]);
	for (const stopReason of ["length", "error", "aborted"]) {
		expect(
			piResponsesAssistantTexts(
				{
					...foreign([{ type: "thinking", thinking: "unfinished" }]),
					stopReason,
				},
				model,
			),
		).toEqual([]);
	}
});

function harness(api: string, unsupported = true, extra?: unknown[]) {
	__setPiHarnessKindForTesting("omp");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let aborts = 0;
	const ctx = {
		...fakeContext("issue-686-r3"),
		model: { ...model, api },
		abort: () => aborts++,
	};
	const history = [
		head,
		...(extra ??
			(unsupported
				? [foreign([{ type: "unknown", text: "not modeled" }])]
				: [])),
		prompt,
	];
	registerPiGuardedContext(
		{
			on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(name, fn),
			appendEntry: () => {},
		} as never,
		async () => ({ messages: history }) as never,
	);
	const emit = (name: string, event: unknown = {}) =>
		handlers.get(name)?.(event, ctx);
	return {
		emit,
		get stops() {
			return aborts + piBlockedDispatches(ctx);
		},
		async prepare() {
			emit("agent_start");
			await emit("context", { messages: [prompt] });
		},
	};
}

test("issue 686 unmodeled Chat plan keeps the signature fence without per-message fallback", async () => {
	const h = harness("openai-completions", false, [
		{
			role: "toolResult",
			toolCallId: "orphan",
			content: [{ type: "text", text: "orphan output" }],
		},
	]);
	await h.prepare();
	const body = {
		messages: [
			{ role: "user", content: head.content },
			{ role: "user", content: "provider stale-result note" },
			{ role: "user", content: "current prompt" },
		],
	};
	h.emit("before_provider_request", { payload: body });
	expect(h.stops).toBe(0);
	await h.prepare();
	h.emit("before_provider_request", {
		payload: { messages: body.messages.slice(1) },
	});
	expect(h.stops).toBe(1);
});

test("issue 686 entirely unmodeled prepared history retains raw refusal", async () => {
	const h = harness("openai-responses", false, [
		{ role: "future-agent-role", content: "context" },
	]);
	await h.prepare();
	h.emit("before_provider_request", {
		payload: {
			input: [
				{ role: "user", content: head.content },
				item("transformed context"),
			],
		},
	});
	expect(h.stops).toBe(0);
	await h.prepare();
	h.emit("before_provider_request", {
		payload: { input: [item("raw history")] },
	});
	expect(h.stops).toBe(1);
});

test("issue 686 provider-selected Responses items never fall back to per-message rows", async () => {
	const h = harness("openrouter", false, [
		foreign([{ type: "text", text: "first" }]),
		foreign([{ type: "text", text: "second" }]),
	]);
	await h.prepare();
	h.emit("before_provider_request", {
		payload: {
			input: [
				{ role: "user", content: head.content },
				item("first"),
				item("second"),
				{ role: "user", content: "current prompt" },
			],
		},
	});
	expect(h.stops).toBe(0);
	await h.prepare();
	h.emit("before_provider_request", {
		payload: {
			input: [
				item("first"),
				item("second"),
				{ role: "user", content: "current prompt" },
			],
		},
	});
	expect(h.stops).toBe(1);
});

for (const api of [
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"openrouter",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-gemini-cli",
	"google-vertex",
	"ollama-chat",
]) {
	test(`issue 686 signature-only ${api} refuses raw but admits stale managed history`, async () => {
		const h = harness(api, false, [{ role: "future-agent-role" }]);
		const body = (text: string, includeNewTurn = false) => {
			const texts = [
				text,
				...(includeNewTurn ? ["newer prepared turn"] : []),
				"current prompt",
			];
			return api.startsWith("google-")
				? api === "google-gemini-cli"
					? {
							request: {
								contents: texts.map((text) => ({
									role: "user",
									parts: [{ text }],
								})),
							},
						}
					: {
							contents: texts.map((text) => ({
								role: "user",
								parts: [{ text }],
							})),
						}
				: api.endsWith("responses")
					? { input: texts.map((text) => ({ role: "user", content: text })) }
					: api === "bedrock-converse-stream"
						? {
								inferenceConfig: {},
								messages: texts.map((text) => ({
									role: "user",
									content: [{ text }],
								})),
							}
						: {
								messages: texts.map((text) => ({
									role: "user",
									content: text,
								})),
							};
		};
		await h.prepare();
		h.emit("before_provider_request", {
			payload: body("<session-history>current managed head</session-history>"),
		});
		expect(h.stops).toBe(0);
		await h.prepare();
		h.emit("before_provider_request", {
			payload: body("raw unmanaged history"),
		});
		expect(h.stops).toBe(1);
		const stale = body(
			"<session-history>stale prepared head</session-history>",
		);
		await h.prepare();
		h.emit("before_provider_request", { payload: stale });
		expect(h.stops).toBe(1);
		// An older managed request still has the opener. With a modeled history,
		// the missing newer turn is detectable; without a plan it is a known limit.
		const modeled = harness(api, false, [
			userMessage("newer prepared turn", 3),
		]);
		await modeled.prepare();
		modeled.emit("before_provider_request", {
			payload: body(
				"<session-history>current managed head</session-history>",
				true,
			),
		});
		expect(modeled.stops).toBe(0);
		await modeled.prepare();
		modeled.emit("before_provider_request", { payload: stale });
		expect(modeled.stops).toBe(1);
	});
}

test("issue 686 unmodeled Responses skips incomparable rows once per session but retains opener, lifecycle and retry checks", async () => {
	const log = spyOn(logger, "log");
	try {
		const h = harness("openai-responses");
		await h.prepare();
		const body = {
			input: [
				{ role: "user", content: head.content },
				item("provider transformed history"),
				{ role: "user", content: "current prompt" },
			],
		};
		h.emit("before_provider_request", { payload: body });
		h.emit("before_provider_request", { payload: body });
		expect(h.stops).toBe(0);
		expect(
			log.mock.calls.filter(([line]) =>
				line.includes("structural comparison skipped"),
			),
		).toHaveLength(1);
		expect(
			log.mock.calls.some(([line]) =>
				line.includes("Responses history transform is not modeled"),
			),
		).toBe(true);
		expect(
			log.mock.calls.some(([line]) =>
				line.includes("stale prepared requests are not detected on this pass"),
			),
		).toBe(true);
		h.emit("before_provider_request", {
			payload: {
				input: [...body.input, { role: "user", content: "changed retry" }],
			},
		});
		expect(h.stops).toBe(1);
		await h.prepare();
		h.emit("before_provider_request", {
			payload: { input: [{ role: "user", content: "raw without head" }] },
		});
		expect(h.stops).toBe(2);
		await h.prepare();
		h.emit("agent_end", { messages: [] });
		h.emit("before_provider_request", { payload: body });
		expect(h.stops).toBe(3);
	} finally {
		log.mockRestore();
	}
});
