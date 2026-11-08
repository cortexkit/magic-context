import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	clearPiContextReceipt,
	registerPiGuardedContext,
} from "./pi-context-refusal";
import { piCursorManagedReceipt } from "./pi-dispatch-identity";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext, userMessage } from "./test-utils.test";

const session = "issue-880";
const signature = "<session-history>";
const managed = [
	userMessage(`${signature}prepared</session-history>`, 1),
	userMessage("current prompt", 2),
];

function cursorPayload() {
	const receipt = piCursorManagedReceipt(managed);
	if (!receipt) throw new Error("managed Cursor receipt missing");
	const system = createHash("sha256")
		.update(JSON.stringify({ role: "system", content: "instructions" }), "utf8")
		.digest("hex");
	return {
		conversationState: {
			rootPromptMessagesJson: [system, ...receipt],
			turns: [],
		},
		action: {
			action: {
				case: "userMessageAction",
				value: {
					userMessage: {
						text: "current prompt",
						messageId: "random-cursor-message-id",
					},
				},
			},
		},
	};
}

function harness() {
	__setPiHarnessKindForTesting("omp");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const refusals: string[] = [];
	let aborts = 0;
	const ctx = {
		...fakeContext(session),
		model: { api: "cursor-agent", id: "claude-opus-5-5", provider: "cursor" },
		abort: () => aborts++,
	};
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
		get aborts() {
			return aborts;
		},
		async prepare() {
			emit("agent_start");
			await emit("context", { messages: [userMessage("current prompt", 2)] });
		},
		dispatch(payload: unknown) {
			return emit("before_provider_request", { payload });
		},
	};
}

afterEach(() => {
	clearPiContextReceipt(session);
	__setPiHarnessKindForTesting(undefined);
});

test("issue 880 cursor-agent: managed AgentRunRequest is admitted", async () => {
	const h = harness();
	await h.prepare();
	h.dispatch(cursorPayload());
	expect(h.aborts).toBe(0);
	expect(h.refusals).toEqual([]);
});

test("issue 880 cursor-agent: a raw AgentRunRequest without the receipt is refused", async () => {
	const h = harness();
	await h.prepare();
	const payload = cursorPayload();
	payload.conversationState.rootPromptMessagesJson = [
		payload.conversationState.rootPromptMessagesJson[0],
	];
	h.dispatch(payload);
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain("missing current receipt signature");
});
