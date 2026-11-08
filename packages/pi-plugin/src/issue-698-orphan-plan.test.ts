import { afterEach, expect, test } from "bun:test";
import {
	clearPiContextReceipt,
	piBlockedDispatches,
	registerPiGuardedContext,
} from "./__tests__/dispatch-probe";
import {
	piMatchesPreparedStructure,
	piPreparedStructure,
	preparePiDispatch,
} from "./pi-dispatch-structure";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext } from "./test-utils.test";

const apis = [
	"openai-completions",
	"openai-responses",
	"openrouter",
	"openai-codex-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-gemini-cli",
	"google-vertex",
	"ollama-chat",
	"factory-droid-agent",
	"devin-agent",
	"apple-foundation-models",
] as const;
const header = {
	role: "user",
	content: "<session-history>managed</session-history>",
	timestamp: 1,
};
const tail = { role: "user", content: "next", timestamp: 6 };
const orphan = {
	role: "toolResult",
	toolCallId: "orphan",
	toolName: "Read",
	isError: true,
	timestamp: 4,
	content: [
		{ type: "text", text: " first " },
		{ type: "text", text: " \n " },
		{ type: "image", data: "ignored", mimeType: "image/png" },
		{ type: "text", text: "second" },
	],
};
// Write Oh My Pi's expected user note literally so a planner bug cannot also
// change the test's expected value.
const note =
	'<stale-tool-result tool="Read" id="orphan" is-error="true">\n first \nsecond\n</stale-tool-result>';
const noteMessage = { role: "user", content: note, timestamp: 4 };
const model = (api: string) => ({
	api,
	provider: "mock",
	id: "mock",
	compat: { supportsFunctionPartId: true },
});
const call = (api: string, stopReason = "toolUse") => ({
	role: "assistant",
	api,
	provider: "mock",
	model: "mock",
	timestamp: 2,
	stopReason,
	content: [{ type: "toolCall", id: "paired", name: "Read", arguments: {} }],
});
const result = {
	role: "toolResult",
	toolCallId: "paired",
	toolName: "Read",
	timestamp: 3,
	content: [{ type: "text", text: "result" }],
};

function wire(api: string, messages: Record<string, unknown>[]): unknown {
	if (
		[
			"openai-responses",
			"openai-codex-responses",
			"azure-openai-responses",
			"openrouter",
		].includes(api)
	) {
		return {
			input: messages.flatMap((message): unknown[] => {
				if (message.role === "assistant")
					return [
						{
							type: "function_call",
							call_id: "paired",
							name: "Read",
							arguments: "{}",
						},
					];
				if (message.role === "toolResult")
					return [
						{
							type: "function_call_output",
							call_id: message.toolCallId,
							output: "result",
						},
					];
				return [
					{
						role: message.role,
						content: [{ type: "input_text", text: message.content }],
					},
				];
			}),
		};
	}
	if (api.startsWith("google-"))
		return {
			contents: messages.map((message) => ({
				role:
					message.role === "assistant"
						? "model"
						: message.role === "toolResult"
							? "user"
							: message.role,
				parts:
					message.role === "assistant"
						? [{ functionCall: { id: "paired", name: "Read", args: {} } }]
						: message.role === "toolResult"
							? [
									{
										functionResponse: {
											id: message.toolCallId,
											name: "Read",
											response: {},
										},
									},
								]
							: [{ text: message.content }],
			})),
		};
	if (api === "bedrock-converse-stream")
		return {
			inferenceConfig: {},
			messages: messages.map((message) => ({
				role: message.role === "toolResult" ? "user" : message.role,
				content:
					message.role === "assistant"
						? [{ toolUse: { toolUseId: "paired", name: "Read", input: {} } }]
						: message.role === "toolResult"
							? [
									{
										toolResult: {
											toolUseId: message.toolCallId,
											content: [{ text: "result" }],
										},
									},
								]
							: [{ text: message.content }],
			})),
		};
	if (api === "anthropic-messages")
		return {
			system: [],
			max_tokens: 100,
			messages: messages.map((message) => ({
				role: message.role === "toolResult" ? "user" : message.role,
				content:
					message.role === "assistant"
						? [{ type: "tool_use", id: "paired", name: "Read", input: {} }]
						: message.role === "toolResult"
							? [
									{
										type: "tool_result",
										tool_use_id: message.toolCallId,
										content: "result",
									},
								]
							: [
									{
										type: "text",
										text: message.content,
										cache_control: { type: "ephemeral" },
									},
								],
			})),
		};
	return {
		messages: messages.map((message) =>
			message.role === "assistant"
				? {
						role: "assistant",
						tool_calls: [{ id: "paired", function: { name: "Read" } }],
					}
				: message.role === "toolResult"
					? {
							role: "tool",
							tool_call_id: message.toolCallId,
							content: "result",
						}
					: { role: message.role, content: message.content },
		),
	};
}

for (const api of apis) {
	test(`issue 698 orphan plan ${api}: exact user note without changing managed history`, () => {
		const messages = [header, orphan, tail];
		const before = JSON.stringify(messages);
		const prepared = preparePiDispatch(messages, model(api), true);
		expect(prepared.messages).toBe(messages);
		expect(JSON.stringify(messages)).toBe(before);
		expect(prepared.structure?.messages.map((row) => row.role)).toEqual([
			"user",
			"user",
			"user",
		]);
		expect(
			piMatchesPreparedStructure(
				wire(api, [header, noteMessage, tail]),
				prepared.structure,
			),
		).toBe(true);
		expect(
			piMatchesPreparedStructure(
				wire(api, [
					header,
					{ ...noteMessage, content: note.replace("first", "FIRST") },
					tail,
				]),
				prepared.structure,
			),
		).toBe(false);
		expect(
			piMatchesPreparedStructure(
				wire(api, [header, { ...noteMessage, role: "developer" }, tail]),
				prepared.structure,
			),
		).toBe(false);
	});
	for (const stopReason of ["toolUse", "aborted", "error"]) {
		test(`issue 698 orphan plan ${api}: drops orphan in ${stopReason} pending window`, () => {
			const assistant = call(api, stopReason);
			const prepared = piPreparedStructure(
				[header, assistant, orphan, result, tail],
				model(api),
			);
			expect(
				piMatchesPreparedStructure(
					wire(api, [header, assistant, result, tail]),
					prepared,
				),
			).toBe(true);
			expect(
				piMatchesPreparedStructure(
					wire(api, [header, assistant, noteMessage, result, tail]),
					prepared,
				),
			).toBe(false);
			const closed = piPreparedStructure(
				[header, assistant, result, orphan, tail],
				model(api),
			);
			expect(
				piMatchesPreparedStructure(
					wire(api, [header, assistant, result, noteMessage, tail]),
					closed,
				),
			).toBe(true);
		});
	}
	test(`issue 698 orphan plan ${api}: paired result cannot become a user row`, () => {
		const assistant = call(api);
		const prepared = piPreparedStructure(
			[header, assistant, result, tail],
			model(api),
		);
		expect(prepared?.messages[2].role).toBe("toolResult");
		expect(
			piMatchesPreparedStructure(
				wire(api, [header, assistant, result, tail]),
				prepared,
			),
		).toBe(true);
		expect(
			piMatchesPreparedStructure(
				wire(api, [header, assistant, noteMessage, tail]),
				prepared,
			),
		).toBe(false);
	});
	test(`issue 698 orphan plan ${api}: blank text and image-only orphans disappear`, () => {
		const blank = {
			...orphan,
			content: [
				{ type: "text", text: " \n " },
				{ type: "image", data: "ignored", mimeType: "image/png" },
			],
		};
		const prepared = piPreparedStructure([header, blank, tail], model(api));
		expect(
			piMatchesPreparedStructure(wire(api, [header, tail]), prepared),
		).toBe(true);
		expect(
			piMatchesPreparedStructure(
				wire(api, [header, noteMessage, tail]),
				prepared,
			),
		).toBe(false);
	});
}

for (const api of [
	undefined,
	"cursor-agent",
	"gitlab-duo-agent",
	"custom-api",
]) {
	test(`issue 698 orphan plan ${api ?? "unknown"}: non-transform lane stays a tool result`, () => {
		const prepared = piPreparedStructure(
			[header, orphan, tail],
			api ? model(api) : undefined,
		);
		expect(prepared?.messages[1].role).toBe("toolResult");
		expect(
			piMatchesPreparedStructure(
				{ messages: [header, noteMessage, tail] },
				prepared,
			),
		).toBe(false);
	});
}

test("issue 698 orphan plan: a partially resolved call window still drops orphans", () => {
	const assistant = call("openai-responses");
	assistant.content.push({
		type: "toolCall",
		id: "second",
		name: "Read",
		arguments: {},
	});
	const second = { ...result, toolCallId: "second" };
	const prepared = piPreparedStructure(
		[header, assistant, result, orphan, second, tail],
		model("openai-responses"),
	);
	expect(prepared?.messages.map((row) => row.role)).toEqual([
		"user",
		"assistant",
		"toolResult",
		"toolResult",
		"user",
	]);
});

test("issue 698 orphan plan: Responses composite call identities remain paired", () => {
	const assistant = call("openai-responses");
	assistant.content[0].id = "paired|item1";
	const paired = { ...result, toolCallId: "paired|item2" };
	const prepared = piPreparedStructure(
		[header, assistant, paired, orphan, tail],
		model("openai-responses"),
	);
	expect(prepared?.messages.map((row) => row.role)).toEqual([
		"user",
		"assistant",
		"toolResult",
		"user",
		"user",
	]);
});

afterEach(() => {
	clearPiContextReceipt("issue-698-orphan");
	__setPiHarnessKindForTesting(undefined);
});
for (const api of ["openai-codex-responses", "openai-completions"]) {
	test(`issue 698 orphan plan ${api}: raw request still refuses`, async () => {
		__setPiHarnessKindForTesting("omp");
		const handlers = new Map<
			string,
			(event: unknown, ctx: unknown) => unknown
		>();
		const refusals: string[] = [];
		let aborts = 0;
		const ctx = {
			...fakeContext("issue-698-orphan"),
			model: model(api),
			abort: () => aborts++,
		};
		registerPiGuardedContext(
			{
				on: (
					name: string,
					handler: (event: unknown, ctx: unknown) => unknown,
				) => handlers.set(name, handler),
				appendEntry: (_type: string, data: { message: string }) =>
					refusals.push(data.message),
			} as never,
			async () => ({ messages: [header, orphan, tail] }) as never,
		);
		const emit = (name: string, event: unknown = {}) =>
			handlers.get(name)?.(event, ctx);
		emit("agent_start");
		await emit("context", { messages: [tail] });
		emit("before_provider_request", {
			payload: wire(api, [
				{ role: "user", content: "raw history" },
				noteMessage,
				tail,
			]),
		});
		expect(aborts + piBlockedDispatches(ctx)).toBe(1);
		expect(refusals[0]).toContain("missing current receipt signature");
	});
}
