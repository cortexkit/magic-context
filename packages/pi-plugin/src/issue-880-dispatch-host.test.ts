import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { pinOmpLoggerFiles } from "./__tests__/omp-log-files";
import { registerPiGuardedContext } from "./pi-context-refusal";
import { piCursorManagedRoots } from "./pi-dispatch-cursor";
import {
	piConversationFields,
	piHasManagedSignature,
} from "./pi-dispatch-identity";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext, userMessage } from "./test-utils.test";

const parent = join(tmpdir(), "magic-context");
mkdirSync(parent, { recursive: true });
const root = createTestTempDirFromPath(join(parent, "dispatch-880-"));
const saved = new Map<string, string | undefined>();
for (const key of [
	"HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
	"PI_CODING_AGENT_DIR",
	"OMP_CODING_AGENT_DIR",
	"MAGIC_CONTEXT_STORAGE_DIR",
]) {
	saved.set(key, process.env[key]);
	process.env[key] = join(root, key);
	mkdirSync(process.env[key], { recursive: true });
}
const require = createRequire(import.meta.url);
const packageRoot = (alias: string) =>
	require.resolve(`${alias}/package.json`).slice(0, -12);
const cursorVersions = [
	{ version: "18.13.2", alias: "omp-pi-ai-18132", rulesEntry: false },
	{ version: "18.18.0", alias: "omp-pi-ai-18180", rulesEntry: true },
	{ version: "18.18.1", alias: "omp-pi-ai-18181", rulesEntry: true },
] as const;
await pinOmpLoggerFiles(root, [
	"omp-coding-agent-18132",
	...cursorVersions.map(({ alias }) => alias),
]);
const ompRoot = packageRoot("omp-coding-agent-18132");
const aiRoot = packageRoot("omp-pi-ai-18132");
const { ExtensionRunner: OmpRunner } = await import(
	`${ompRoot}src/extensibility/extensions/runner.ts`
);
const { ExtensionRunner: PiRunner } = await import(
	new URL(
		"./core/extensions/runner.js",
		import.meta.resolve("@earendil-works/pi-coding-agent"),
	).href
);
const cursorBuilders = await Promise.all(
	cursorVersions.map(async (entry) => ({
		...entry,
		buildGrpcRequest: (
			await import(`${packageRoot(entry.alias)}src/providers/cursor.ts`)
		).buildGrpcRequest,
	})),
);
const { streamAnthropic } = await import(`${aiRoot}src/providers/anthropic.ts`);
const { streamOpenAIResponses } = await import(
	`${aiRoot}src/providers/openai-responses.ts`
);
const { DateCwdReminderInjector } = await import(
	`${ompRoot}src/session/date-cwd-reminder.ts`
);
const { Agent } = await import("pi-agent-core-087");
const { createAssistantMessageEventStream } = await import("pi-ai-087");

function toolResponse(api: string, first: boolean): Response {
	const event = (type: string, data: unknown) =>
		`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
	if (api === "anthropic-messages") {
		return new Response(
			[
				event("message_start", {
					type: "message_start",
					message: {
						id: "msg_fixture",
						type: "message",
						role: "assistant",
						model: "fixture-model",
						content: [],
						usage: { input_tokens: 1, output_tokens: 0 },
					},
				}),
				...(first
					? [
							event("content_block_start", {
								type: "content_block_start",
								index: 0,
								content_block: {
									type: "tool_use",
									id: "call_fixture",
									name: "record_tool",
									input: {},
								},
							}),
							event("content_block_delta", {
								type: "content_block_delta",
								index: 0,
								delta: { type: "input_json_delta", partial_json: "{}" },
							}),
							event("content_block_stop", {
								type: "content_block_stop",
								index: 0,
							}),
						]
					: []),
				event("message_delta", {
					type: "message_delta",
					delta: { stop_reason: first ? "tool_use" : "end_turn" },
					usage: { output_tokens: 1 },
				}),
				event("message_stop", { type: "message_stop" }),
			].join(""),
			{ headers: { "content-type": "text/event-stream" } },
		);
	}
	const call = {
		type: "function_call",
		id: "fc_fixture",
		call_id: "call_fixture",
		name: "record_tool",
		arguments: "{}",
		status: "completed",
	};
	return new Response(
		[
			event("response.created", {
				type: "response.created",
				response: { id: "resp_fixture", status: "in_progress", output: [] },
			}),
			...(first
				? [
						event("response.output_item.added", {
							type: "response.output_item.added",
							output_index: 0,
							item: { ...call, arguments: "", status: "in_progress" },
						}),
						event("response.function_call_arguments.delta", {
							type: "response.function_call_arguments.delta",
							output_index: 0,
							item_id: call.id,
							delta: "{}",
						}),
						event("response.output_item.done", {
							type: "response.output_item.done",
							output_index: 0,
							item: call,
						}),
					]
				: []),
			event("response.completed", {
				type: "response.completed",
				response: {
					id: "resp_fixture",
					status: "completed",
					output: first ? [call] : [],
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			}),
		].join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

afterAll(() => {
	__setPiHarnessKindForTesting(undefined);
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const managed = "<session-history>managed text</session-history>";
const prepared = [userMessage(managed, 1), userMessage("active user", 2)];
function model(api: string) {
	return {
		api,
		provider: api === "cursor-agent" ? "cursor" : "fixture",
		id: api === "cursor-agent" ? "claude-sonnet-4.6" : "fixture-model",
		name: "fixture",
		baseUrl: "https://provider.invalid/v1",
		input: ["text"],
		contextWindow: 200000,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {},
		identity: { class: "claude", model: "claude-sonnet-4.6" },
	};
}

function harness(
	kind: "pi" | "omp",
	api: string,
	failPreparation = false,
	messages = prepared,
) {
	__setPiHarnessKindForTesting(kind);
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const entries: string[] = [];
	const notices: string[] = [];
	const errors: unknown[] = [];
	let controller = new AbortController();
	const ctx = {
		...fakeContext(`880-${kind}-${api}`),
		cwd: root,
		get signal() {
			return controller.signal;
		},
		model: model(api),
		abort: () => controller.abort(),
		ui: { notify: (message: string) => notices.push(message) },
	};
	let fail = failPreparation;
	registerPiGuardedContext(
		{
			on: (name: string, fn: (...args: unknown[]) => unknown) =>
				handlers.set(name, [fn]),
			appendEntry: (_type: string, data: { message: string }) =>
				entries.push(data.message),
		} as never,
		async () => {
			if (fail) throw new Error("fixture preparation failed");
			return { messages: structuredClone(messages) };
		},
	);
	const extensions = [{ path: "magic-context", handlers }];
	const runner =
		kind === "omp"
			? new OmpRunner(extensions, {}, root, {}, {})
			: new PiRunner(extensions, {}, root, {}, {});
	runner.createContext = () => ctx;
	runner.onError((error: unknown) => errors.push(error));
	return {
		ctx,
		entries,
		notices,
		errors,
		runner,
		async prepare() {
			return runner.emitContext([userMessage("raw", 1)]);
		},
		async recover() {
			fail = false;
			controller = new AbortController();
			return runner.emitContext([userMessage("next prompt", 3)]);
		},
		send: (payload: unknown) =>
			runner.emitBeforeProviderRequest(payload, ctx.model, ctx.signal),
	};
}

for (const { version, rulesEntry, buildGrpcRequest } of cursorBuilders) {
	for (const blocks of [false, true]) {
		for (const system of [false, true]) {
			test(`Cursor real OMP ${version} builder: managed m0/m1 hashes, ${blocks ? "blocks" : "strings"} ${system ? "with system and date injection" : "without system"}, and retry identity`, async () => {
				const delta =
					"<session-history-since>managed delta</session-history-since>";
				const messages = [managed, delta, "active user"].map((text, index) =>
					userMessage(blocks ? [{ type: "text", text }] : text, index + 1),
				);
				const h = harness("omp", "cursor-agent", false, messages);
				await h.prepare();
				const date = new Date();
				const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
				const reminder = `<system-reminder>\nToday: ${day}; current working directory: '${root.replace(/\\/gu, "/")}'. Do not repeat this information in your reply.\n</system-reminder>`;
				const systemPrompt = system
					? ["system instructions", "extra instructions"]
					: [];
				const systemRoots = system
					? systemPrompt
					: ["You are a helpful assistant."];
				const expectedContents = [
					!system
						? [{ type: "text", text: managed }]
						: blocks
							? [
									{ type: "text", text: reminder },
									{ type: "text", text: managed },
								]
							: [{ type: "text", text: `${reminder}\n\n${managed}` }],
					[{ type: "text", text: delta }],
				];
				const context = new DateCwdReminderInjector().transform(
					{ messages, systemPrompt },
					day,
					root,
				);
				let firstFields: ReturnType<typeof piConversationFields>;
				let firstMessageId: string | undefined;
				for (let attempt = 0; attempt < 2; attempt++) {
					let intercepted = false;
					const state = {
						conversationId: "fixture",
						blobStore: new Map<string, Uint8Array>(),
					};
					await buildGrpcRequest(
						h.ctx.model,
						context,
						{
							onPayload: async (payload: unknown) => {
								intercepted = true;
								const request = payload as {
									conversationState: { rootPromptMessagesJson: Uint8Array[] };
									action: {
										action: { value: { userMessage: { messageId: string } } };
									};
								};
								const ids =
									request.conversationState.rootPromptMessagesJson.map((id) =>
										Buffer.from(id).toString("hex"),
									);
								// Decode the roots OMP actually sent, not candidates kept only in its blob store.
								const roots = ids.map((id) =>
									JSON.parse(new TextDecoder().decode(state.blobStore.get(id))),
								);
								const rules = system && rulesEntry;
								expect(roots).toHaveLength(
									systemRoots.length + (rules ? 1 : 0) + 2,
								);
								expect(roots.slice(0, systemRoots.length)).toEqual(
									systemRoots.map((content) => ({ role: "system", content })),
								);
								if (rules)
									expect(roots[systemRoots.length]).toEqual({
										role: "user",
										content:
											"<rules>\nsystem instructions\n\nextra instructions\n</rules>",
									});
								for (const [index, signature] of [
									"<session-history>",
									"<session-history-since>",
								].entries()) {
									const expected = piCursorManagedRoots(
										messages,
										signature,
										root,
									);
									const position = systemRoots.length + (rules ? 1 : 0) + index;
									expect(expected).toContain(ids[position]);
									expect(roots[position]).toEqual({
										role: "user",
										content: expectedContents[index],
									});
									expect(
										piHasManagedSignature(payload, signature, expected),
									).toBe(true);
								}
								const fields = piConversationFields(payload);
								expect(fields).toBeDefined();
								const messageId =
									request.action.action.value.userMessage.messageId;
								if (attempt === 0) {
									firstFields = fields;
									firstMessageId = messageId;
								} else {
									expect(fields).toEqual(firstFields);
									expect(messageId).not.toBe(firstMessageId);
								}
								expect(await h.send(payload)).toBe(payload);
								return payload;
							},
						},
						state,
					);
					expect(intercepted).toBe(true);
				}
				expect(h.notices).toEqual([]);
				expect(h.errors).toEqual([]);
			});
		}
	}
	for (const stale of [false, true]) {
		test(`Cursor real OMP ${version} builder: ${stale ? "stale managed" : "raw"} root without the current receipt is refused`, async () => {
			const h = harness("omp", "cursor-agent");
			await h.prepare();
			await expect(
				buildGrpcRequest(
					h.ctx.model,
					{
						systemPrompt: ["system instructions"],
						messages: [
							userMessage(stale ? `${managed} stale` : "raw history", 1),
							userMessage("active user", 2),
						],
					},
					{
						onPayload: (payload: unknown) => h.send(payload),
					},
					{ conversationId: "fixture", blobStore: new Map() },
				),
			).rejects.toThrow("Magic Context could not safely prepare this turn");
			expect(h.notices).toHaveLength(1);
			expect(h.notices[0]).toContain("Cursor root hash did not match");
			expect(h.notices[0]).toContain("provider API=cursor-agent");
			expect(h.entries).toEqual(h.notices);
			expect(h.errors).toEqual([]);
		});
	}
}

for (const kind of ["omp", "pi"] as const) {
	for (const { api, version, buildGrpcRequest } of [
		{ api: "anthropic-messages", version: "18.13.2" },
		{ api: "openai-responses", version: "18.13.2" },
		...cursorBuilders.map((builder) => ({ ...builder, api: "cursor-agent" })),
	]) {
		for (const refuses of [true, false]) {
			test(`${kind} real runner: ${api} ${version} ${refuses ? "refusal stops transport and tools, shows reason, and next turn works" : "mock transport can execute a real agent tool"}`, async () => {
				// Stock Pi has no managed-shape fence. Exercise its failed-preparation
				// backstop; OMP exercises the payload-time missing-receipt refusal.
				const h = harness(kind, api, kind === "pi" && refuses);
				await h.prepare();
				let requests = 0;
				let tools = 0;
				const previousFetch = globalThis.fetch;
				globalThis.fetch = (async () => {
					requests++;
					return toolResponse(api, requests === 1);
				}) as typeof fetch;
				try {
					let hookCalls = 0;
					const onPayload = async (payload: unknown) => {
						hookCalls++;
						return refuses ? h.send(payload) : payload;
					};
					let recovering = false;
					const agent = new Agent({
						initialState: {
							model: h.ctx.model,
							systemPrompt: "system",
							tools: [
								{
									name: "record_tool",
									label: "record tool",
									description: "record execution",
									parameters: { type: "object", properties: {} },
									execute: async () => {
										tools++;
										return {
											content: [{ type: "text", text: "executed" }],
											details: {},
										};
									},
								},
							],
						},
						streamFn: ((
							selected: unknown,
							context: unknown,
							options: object,
						) => {
							if (recovering)
								context = {
									...(context as object),
									messages: structuredClone(prepared),
								};
							if (api !== "cursor-agent")
								return (
									api === "anthropic-messages"
										? streamAnthropic
										: streamOpenAIResponses
								)(selected, context, {
									...options,
									apiKey: "fixture-not-a-key",
									onPayload,
									maxRetries: 0,
								});
							// Cursor's real serializer runs before the transport boundary. The
							// mock transport supplies a tool call to the real agent loop only
							// if serialization succeeds; no Cursor credentials are needed.
							const stream = createAssistantMessageEventStream();
							void (async () => {
								const output = {
									role: "assistant",
									api,
									provider: "cursor",
									model: "fixture",
									timestamp: 1,
									content: [],
									usage: {
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										totalTokens: 0,
										cost: {
											input: 0,
											output: 0,
											cacheRead: 0,
											cacheWrite: 0,
											total: 0,
										},
									},
									stopReason: "stop",
								} as any;
								try {
									const built = await buildGrpcRequest(
										selected,
										context,
										{ onPayload },
										{ conversationId: "fixture", blobStore: new Map() },
									);
									await fetch("https://provider.invalid/cursor", {
										method: "POST",
										body: built.requestBytes,
									});
									if (requests === 1) {
										output.content = [
											{
												type: "toolCall",
												id: "call_fixture",
												name: "record_tool",
												arguments: {},
											},
										];
										output.stopReason = "toolUse";
									}
									stream.push({
										type: "done",
										reason: output.stopReason,
										message: output,
									});
								} catch (error) {
									output.stopReason = "error";
									output.errorMessage = (error as Error).message;
									stream.push({
										type: "error",
										reason: "error",
										error: output,
									});
								}
								stream.end();
							})();
							return stream;
						}) as never,
					} as never);
					await agent.prompt("raw");
					const output = agent.state.messages.at(-1) as {
						errorMessage?: string;
					};
					const errorText = output.errorMessage ?? "";
					expect(hookCalls).toBeGreaterThan(0);
					if (!refuses) {
						expect(errorText).toBe("");
						expect(requests).toBeGreaterThanOrEqual(2);
						expect(tools).toBe(1);
						return;
					}
					expect(requests).toBe(0);
					expect(tools).toBe(0);
					expect(h.entries).toHaveLength(1);
					expect(h.notices).toEqual(h.entries);
					expect(h.errors).toEqual([]);
					expect(errorText).toContain(h.notices[0]);
					expect(errorText).not.toContain("at piRefusedPayload");
					// A repeated callback stays blocked without another notice.
					const repeated = await h.send({});
					expect(() => JSON.stringify(repeated)).toThrow();
					await h.recover();
					const admitted = {
						messages: prepared.map(({ role, content }) => ({ role, content })),
					};
					expect(await h.send(admitted)).toBe(admitted);
					// Use the same agent after its refused reply, with the next
					// context pass's managed messages reaching the real serializer.
					await h.recover();
					recovering = true;
					await agent.prompt("next turn");
					expect(
						(agent.state.messages.at(-1) as { errorMessage?: string })
							.errorMessage,
					).toBeUndefined();
					expect(requests).toBeGreaterThanOrEqual(2);
					expect(tools).toBe(1);
					expect(h.notices).toHaveLength(1);
				} finally {
					globalThis.fetch = previousFetch;
				}
			});
		}
	}
}
