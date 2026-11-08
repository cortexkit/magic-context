import { afterEach, expect, test } from "bun:test";
import {
	clearPiContextReceipt,
	piBlockedDispatches,
	registerPiGuardedContext,
} from "./__tests__/dispatch-probe";
import {
	piConversationFields,
	piHasManagedSignature,
} from "./pi-dispatch-identity";
import {
	piMatchesPreparedStructure,
	piPreparedStructure,
} from "./pi-dispatch-structure";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext, userMessage } from "./test-utils.test";

const session = "issue-683";
const signature = "<session-history>";
const managed = [
	userMessage(`${signature}prepared</session-history>`, 1),
	userMessage("current prompt", 2),
];
type Body = Record<string, unknown>;
const transports: Record<string, (messages: typeof managed) => Body> = {
	"google-generative-ai": (messages) => ({
		contents: messages.map((message) => ({
			role: "user",
			parts: [{ text: message.content }],
		})),
		config: { systemInstruction: { parts: [{ text: "instructions" }] } },
	}),
	"google-vertex": (messages) => ({
		contents: messages.map((message) => ({
			role: "user",
			parts: [{ text: message.content }],
		})),
		config: { systemInstruction: { parts: [{ text: "instructions" }] } },
	}),
	"google-gemini-cli": (messages) => ({
		project: "probe",
		request: {
			contents: messages.map((message) => ({
				role: "user",
				parts: [{ text: message.content }],
			})),
			systemInstruction: { parts: [{ text: "instructions" }] },
		},
	}),
	"bedrock-converse-stream": (messages) => ({
		inferenceConfig: { maxTokens: 128 },
		system: [{ text: "instructions" }],
		messages: messages.map((message) => ({
			role: "user",
			content: [{ text: message.content }],
		})),
	}),
	"azure-openai-responses": (messages) => ({
		input: [
			{ role: "system", content: "instructions" },
			...messages.map((message) => ({
				role: message.role,
				content: message.content,
			})),
		],
	}),
};

function harness() {
	__setPiHarnessKindForTesting("omp");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const refusals: string[] = [];
	let aborts = 0;
	const ctx = { ...fakeContext(session), abort: () => aborts++ };
	registerPiGuardedContext(
		{
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(name, handler),
			appendEntry: (_type: string, data: { message: string }) =>
				refusals.push(data.message),
		} as never,
		async () => ({ messages: structuredClone(managed) }),
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
		dispatch(payload: Body) {
			return emit("before_provider_request", { payload });
		},
	};
}

afterEach(() => {
	clearPiContextReceipt(session);
	__setPiHarnessKindForTesting(undefined);
});

for (const [api, transport] of Object.entries(transports)) {
	const native = transport;
	test(`issue 683 ${api}: native prepared conversation is admitted`, async () => {
		const h = harness();
		await h.prepare();
		const payload = native(managed);
		expect(piHasManagedSignature(payload, signature)).toBe(true);
		expect(piConversationFields(payload)).toBeDefined();
		expect(
			piMatchesPreparedStructure(payload, piPreparedStructure(managed)),
		).toBe(true);
		h.dispatch(payload);
		expect(h.stops).toBe(0);
		expect(h.refusals).toEqual([]);
	});
	test(`issue 683 ${api}: same-shape raw conversation is refused`, async () => {
		const h = harness();
		await h.prepare();
		const raw = [
			userMessage("unmanaged older transcript", 1),
			userMessage("current prompt", 2),
		];
		h.dispatch(native(raw));
		expect(h.stops).toBe(1);
		expect(h.refusals[0]).toContain("missing current receipt signature");
	});
	test(`issue 683 ${api}: missing prepared turn is refused despite a managed marker`, async () => {
		const h = harness();
		await h.prepare();
		h.dispatch(native(managed.slice(0, 1)));
		expect(h.stops).toBe(1);
		expect(h.refusals[0]).toContain("prepared turn structure");
	});
	test(`issue 683 ${api}: changed retry content is refused`, async () => {
		const h = harness();
		await h.prepare();
		h.dispatch(native(managed));
		const changed = [managed[0], userMessage("another prompt", 2)];
		h.dispatch(native(changed));
		expect(h.stops).toBe(1);
		expect(h.refusals[0]).toContain("does not match");
	});
	test(`issue 683 ${api}: changed retry instructions are refused`, async () => {
		const h = harness();
		await h.prepare();
		const payload = native(managed);
		h.dispatch(payload);
		const changed = JSON.parse(
			JSON.stringify(payload).replace("instructions", "other instructions"),
		);
		h.dispatch(changed);
		expect(h.stops).toBe(1);
	});
}

const withTools = [
	managed[0],
	{
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call:one", name: "Read", arguments: {} },
			{ type: "toolCall", id: "call:two", name: "Write", arguments: {} },
		],
		timestamp: 3,
	},
	{
		role: "toolResult",
		toolCallId: "call:one",
		toolName: "Read",
		content: [{ type: "text", text: "read result" }],
		timestamp: 4,
	},
	{
		role: "toolResult",
		toolCallId: "call:two",
		toolName: "Write",
		content: [{ type: "text", text: "write result" }],
		timestamp: 5,
	},
	managed[1],
];

test("issue 683 Google equivalence: model role and packed function responses retain ordered IDs or names", () => {
	for (const ids of [false, true]) {
		const payload = {
			contents: [
				{ role: "user", parts: [{ text: "managed" }] },
				{
					role: "model",
					parts: [
						{
							functionCall: {
								name: "Read",
								...(ids ? { id: "call_one" } : {}),
							},
						},
						{
							functionCall: {
								name: "Write",
								...(ids ? { id: "call_two" } : {}),
							},
						},
					],
				},
				{
					role: "user",
					parts: [
						{
							functionResponse: {
								name: "Read",
								...(ids ? { id: "call_one" } : {}),
							},
						},
						{
							functionResponse: {
								name: "Write",
								...(ids ? { id: "call_two" } : {}),
							},
						},
					],
				},
				{ role: "user", parts: [{ text: "current" }] },
			],
		};
		const prepared = piPreparedStructure(withTools);
		expect(piMatchesPreparedStructure(payload, prepared)).toBe(true);
		payload.contents[2].parts.reverse();
		expect(piMatchesPreparedStructure(payload, prepared)).toBe(false);
		payload.contents[2].parts.reverse();
		payload.contents[1].parts.reverse();
		expect(piMatchesPreparedStructure(payload, prepared)).toBe(false);
	}
});

test("issue 683 Bedrock equivalence: toolUse and packed toolResult keep normalized ordered IDs", () => {
	const payload = {
		inferenceConfig: { maxTokens: 128 },
		system: [{ text: "instructions" }],
		messages: [
			{ role: "user", content: [{ text: "managed" }] },
			{
				role: "assistant",
				content: [
					{ toolUse: { toolUseId: "call_one", name: "Read", input: {} } },
					{ toolUse: { toolUseId: "call_two", name: "Write", input: {} } },
				],
			},
			{
				role: "user",
				content: [
					{
						toolResult: {
							toolUseId: "call_one",
							content: [{ text: "result" }],
						},
					},
					{
						toolResult: {
							toolUseId: "call_two",
							content: [{ text: "result" }],
						},
					},
				],
			},
			{ role: "user", content: [{ text: "current" }] },
		],
	};
	const prepared = piPreparedStructure(withTools);
	expect(piMatchesPreparedStructure(payload, prepared)).toBe(true);
	expect(
		piMatchesPreparedStructure({ ...payload, system: undefined }, prepared),
	).toBe(true);
	payload.messages[2].content.reverse();
	expect(piMatchesPreparedStructure(payload, prepared)).toBe(false);
});
