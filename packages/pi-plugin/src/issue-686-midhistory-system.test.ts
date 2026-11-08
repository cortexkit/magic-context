import { afterEach, expect, test } from "bun:test";
import {
	clearPiContextReceipt,
	piBlockedDispatches,
	registerPiGuardedContext,
} from "./__tests__/dispatch-probe";
import {
	piMatchesPreparedStructure,
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext } from "./test-utils.test";

const session = "issue-686-midhistory-system";
const reminderText =
	"<system-reminder> Eval runtime state is host-retained, not reconstructed from transcript text. </system-reminder>";
const reminder = {
	role: "custom",
	customType: "eval-state-context",
	display: false,
	attribution: "agent",
	content: reminderText,
	timestamp: 4,
};
const head = {
	role: "user",
	content: "<session-history>managed</session-history>",
	timestamp: 1,
};
const assistant = (id: string) => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name: "read", arguments: {} }],
	timestamp: 2,
});
const result = (id: string) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text", text: "body" }],
	timestamp: 3,
});
const preparedMessages = [
	head,
	assistant("one"),
	result("one"),
	reminder,
	assistant("two"),
	result("two"),
];
const anthropic = {
	api: "anthropic-messages",
	compat: { supportsMidConversationSystem: true },
	input: ["text", "image"],
};
const anthropicCall = (id: string) => ({
	role: "assistant",
	content: [{ type: "tool_use", id, name: "read", input: {} }],
});
const anthropicResult = (...ids: string[]) => ({
	role: "user",
	content: ids.map((id) => ({
		type: "tool_result",
		tool_use_id: id,
		content: "body",
	})),
});
const anthropicSystem = {
	role: "system",
	content: [{ type: "text", text: reminderText }],
};
const wireMessages = [
	head,
	anthropicCall("one"),
	anthropicResult("one"),
	anthropicSystem,
	anthropicCall("two"),
	anthropicResult("two"),
];

afterEach(() => {
	clearPiContextReceipt(session);
	__setPiHarnessKindForTesting(undefined);
});

test("issue 686 mid-history system: reporter layout has 172 normalized rows in 171 wire messages", () => {
	const prefix = [
		head,
		...Array.from({ length: 136 }, (_, index) => ({
			role: "user",
			content: `prior ${index}`,
		})),
	];
	const calls = {
		...assistant("one"),
		content: [...assistant("one").content, ...assistant("extra").content],
	};
	const suffix = Array.from({ length: 29 }, (_, index) => ({
		role: "user",
		content: `later ${index}`,
	}));
	const prepared = piPreparedStructure(
		[
			...prefix,
			calls,
			result("one"),
			result("extra"),
			reminder,
			assistant("two"),
			result("two"),
			...suffix,
		],
		anthropic,
	);
	const body = {
		system: "instructions",
		max_tokens: 4096,
		messages: [
			...prefix,
			{
				role: "assistant",
				content: [
					...anthropicCall("one").content,
					...anthropicCall("extra").content,
				],
			},
			anthropicResult("one", "extra"),
			anthropicSystem,
			anthropicCall("two"),
			anthropicResult("two"),
			...suffix,
		],
	};
	expect(body.messages).toHaveLength(171);
	expect(body.messages[138]).toMatchObject({
		role: "user",
		content: [{ type: "tool_result" }, { type: "tool_result" }],
	});
	expect(body.messages[139]).toEqual(anthropicSystem);
	expect(body.messages[140]).toEqual(anthropicCall("two"));
	expect(prepared?.messages).toHaveLength(172);
	expect(prepared?.messages[140].role).toBe("system");
	expect(piPreparedStructureMismatch(body, prepared)).toBeUndefined();
});

test("issue 686 mid-history system: resumed hidden notice is admitted on Anthropic and Ollama", async () => {
	for (const api of ["anthropic-messages", "ollama-chat"]) {
		__setPiHarnessKindForTesting("omp");
		const handlers = new Map<
			string,
			(event: unknown, ctx: unknown) => unknown
		>();
		const refusals: string[] = [];
		let aborts = 0;
		const model = { ...anthropic, api };
		const ctx = { ...fakeContext(session), model, abort: () => aborts++ };
		registerPiGuardedContext(
			{
				on: (
					name: string,
					handler: (event: unknown, ctx: unknown) => unknown,
				) => handlers.set(name, handler),
				appendEntry: (_type: string, data: { message: string }) =>
					refusals.push(data.message),
			} as never,
			async () => ({ messages: structuredClone(preparedMessages) }) as never,
		);
		const emit = (name: string, event: unknown = {}) => {
			const handler = handlers.get(name);
			if (!handler) throw new Error(`missing ${name}`);
			return handler(event, ctx);
		};
		const messages =
			api === "anthropic-messages"
				? wireMessages
				: [
						head,
						{
							role: "assistant",
							content: "",
							tool_calls: [{ function: { name: "read", arguments: {} } }],
						},
						{ role: "tool", tool_name: "read", content: "body" },
						{ role: "system", content: reminderText },
						{
							role: "assistant",
							content: "",
							tool_calls: [{ function: { name: "read", arguments: {} } }],
						},
						{ role: "tool", tool_name: "read", content: "body" },
					];
		const body = {
			...(api === "anthropic-messages" ? { system: "instructions" } : {}),
			messages,
		};
		for (let run = 0; run < 2; run++) {
			if (run) emit("agent_end", { messages: [] });
			emit("agent_start");
			await emit("context", { messages: structuredClone(preparedMessages) });
			emit("before_provider_request", { payload: structuredClone(body) });
		}
		expect(refusals).toEqual([]);
		expect(aborts).toBe(0);
		// A later context pass must still bind the notice text, not just its role.
		await emit("context", { messages: structuredClone(preparedMessages) });
		const changed = structuredClone(body);
		changed.messages[3] = {
			role: "system",
			content: "not the prepared notice",
		};
		emit("before_provider_request", { payload: changed });
		expect(aborts + piBlockedDispatches(ctx)).toBe(1);
		expect(refusals[0]).toContain("comparison=content");
		clearPiContextReceipt(session);
	}
});

test("issue 686 mid-history system: unprepared, changed, removed and unknown rows still refuse", () => {
	const prepared = piPreparedStructure(preparedMessages, anthropic);
	for (const replacement of [
		{
			role: "system",
			content: [{ type: "text", text: "unprepared instructions" }],
		},
		{ role: "unknown", content: [{ type: "text", text: reminderText }] },
		{ role: "system", content: [{ type: "image", text: reminderText }] },
		{
			role: "system",
			content: [
				{ type: "text", text: reminderText },
				{ type: "text", text: "extra" },
			],
		},
	]) {
		const messages = [...wireMessages];
		messages[3] = replacement as typeof anthropicSystem;
		expect(piMatchesPreparedStructure({ messages }, prepared)).toBe(false);
	}
	expect(
		piMatchesPreparedStructure(
			{ messages: wireMessages },
			piPreparedStructure(
				preparedMessages.filter((message) => message !== reminder),
				anthropic,
			),
		),
	).toBe(false);
	expect(
		piMatchesPreparedStructure(
			{ messages: wireMessages.filter((_, index) => index !== 3) },
			prepared,
		),
	).toBe(false);
});

test("issue 686 mid-history system: Anthropic promotion follows capability, attribution and neighbours", () => {
	const systemRole = (messages: unknown[], model = anthropic) =>
		piPreparedStructure(messages, model)?.messages.map((row) => row.role);
	expect(systemRole(preparedMessages)).toEqual([
		"user",
		"assistant",
		"toolResult",
		"system",
		"assistant",
		"toolResult",
	]);
	expect(
		systemRole(preparedMessages, {
			...anthropic,
			compat: { supportsMidConversationSystem: false },
		})?.[3],
	).toBe("user");
	expect(systemRole([head, { ...reminder, attribution: "user" }])?.[1]).toBe(
		"user",
	);
	expect(systemRole([head, reminder, head])?.[1]).toBe("user");
	expect(
		systemRole([
			head,
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
			reminder,
		])?.at(-1),
	).toBe("user");
	expect(
		systemRole([
			head,
			reminder,
			reminder,
			assistant("two"),
			result("two"),
		])?.slice(1, 3),
	).toEqual(["user", "system"]);
	expect(systemRole([head, { ...reminder, role: "developer" }])?.at(-1)).toBe(
		"system",
	);
});

test("issue 686 mid-history system: leading instructions are still skipped but a positioned system is counted", () => {
	const prefix = [
		{ role: "system", content: "head" },
		{ role: "developer", content: "head developer" },
	];
	const messages = [head, { role: "system", content: reminderText }, head];
	const prepared = piPreparedStructure([...prefix, ...messages]);
	expect(prepared?.messages.map((row) => row.role)).toEqual([
		"user",
		"system",
		"user",
	]);
	expect(
		piMatchesPreparedStructure(
			{ messages: [...prefix, ...messages] },
			prepared,
		),
	).toBe(true);
	expect(
		piMatchesPreparedStructure({ messages: [...prefix, head, head] }, prepared),
	).toBe(false);
});

test("issue 686 mid-history system: provider text normalization preserves blank filtering and Unicode", () => {
	const prepared = piPreparedStructure(
		[
			head,
			{
				...reminder,
				content: [
					{ type: "text", text: " " },
					{ type: "text", text: "one\uD800" },
					{ type: "text", text: "two" },
				],
			},
		],
		anthropic,
	);
	for (const content of [
		"one\uFFFD\ntwo",
		[
			{ type: "text", text: "one\uFFFD" },
			{ type: "text", text: "two" },
		],
	]) {
		expect(
			piMatchesPreparedStructure(
				{ messages: [head, { role: "system", content }] },
				prepared,
			),
		).toBe(true);
	}
	const ollama = piPreparedStructure(
		[
			head,
			{
				...reminder,
				content: [
					{ type: "text", text: " " },
					{ type: "text", text: "two" },
				],
			},
		],
		{ api: "ollama-chat" },
	);
	expect(
		piMatchesPreparedStructure(
			{ messages: [head, { role: "system", content: " \ntwo" }] },
			ollama,
		),
	).toBe(true);
	expect(
		piMatchesPreparedStructure(
			{ messages: [head, { role: "system", content: "two" }] },
			ollama,
		),
	).toBe(false);
});
