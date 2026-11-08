import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
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
import { fakeContext, userMessage } from "./test-utils.test";

const session = "issue-686-images";
const apis = [
	"openai-completions",
	"anthropic-messages",
	"openai-responses",
] as const;
const image = (index: number) => ({
	type: "image",
	data: `image-${index}`,
	mimeType: "image/png",
});
const url = (index: number) => `data:image/png;base64,image-${index}`;
const model = (api: string) => ({
	api,
	provider: "mock",
	id: "vision",
	input: ["text", "image"],
});
const history = () => [
	userMessage("<session-history>managed</session-history>", 1),
	...Array.from({ length: 4 }, (_, index) => [
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: `call_${index}`, name: "Read", arguments: {} },
			],
		},
		{
			role: "toolResult",
			toolCallId: `call_${index}`,
			toolName: "Read",
			content: [{ type: "text", text: `result ${index}` }, image(index)],
		},
	]).flat(),
	userMessage("current", 2),
];

function wire(api: string, kept = [2, 3]): Record<string, any> {
	const messages: any[] = [
		{ role: "user", content: "<session-history>managed</session-history>" },
	];
	for (let index = 0; index < 4; index++) {
		const id = `call_${index}`;
		const images = kept
			.filter((value) => value === index)
			.map(() =>
				api === "anthropic-messages"
					? {
							type: "image",
							source: {
								type: "base64",
								media_type: "image/png",
								data: `image-${index}`,
							},
						}
					: { type: "input_image", image_url: url(index), detail: "auto" },
			);
		if (api === "openai-completions") {
			messages.push(
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id,
							type: "function",
							function: { name: "Read", arguments: "{}" },
						},
					],
				},
				{ role: "tool", tool_call_id: id, content: `result ${index}` },
			);
			if (images.length)
				messages.push({
					role: "user",
					content: [
						{ type: "text", text: "Attached image(s) from tool result:" },
						...images.map(() => ({
							type: "image_url",
							image_url: { url: url(index) },
						})),
					],
				});
		} else if (api === "anthropic-messages") {
			messages.push(
				{
					role: "assistant",
					content: [{ type: "tool_use", id, name: "Read", input: {} }],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: id,
							content: [{ type: "text", text: `result ${index}` }, ...images],
						},
					],
				},
			);
		} else {
			messages.push(
				{ type: "function_call", call_id: id, name: "Read", arguments: "{}" },
				{
					type: "function_call_output",
					call_id: id,
					output: images.length
						? [{ type: "input_text", text: `result ${index}` }, ...images]
						: `result ${index}`,
				},
			);
		}
	}
	messages.push({ role: "user", content: "current" });
	return api === "openai-responses"
		? { input: messages }
		: {
				messages,
				...(api === "anthropic-messages"
					? { system: [], max_tokens: 100 }
					: {}),
			};
}
const matches = (api: string, body: unknown) =>
	piMatchesPreparedStructure(body, piPreparedStructure(history(), model(api)));

afterEach(() => {
	clearPiContextReceipt(session);
	__setPiHarnessKindForTesting(undefined);
});

test("issue 686 image budget accepts exactly the oldest prefix removal on every image layout", () => {
	for (const api of apis) {
		for (const kept of [[0, 1, 2, 3], [1, 2, 3], [2, 3], []])
			expect(matches(api, wire(api, kept))).toBe(true);
		const counts: unknown[] = [];
		expect(
			piPreparedStructureMismatch(
				wire(api),
				piPreparedStructure(history(), model(api)),
				(value) => counts.push(value),
			),
		).toBeUndefined();
		expect(counts).toEqual([{ planned: 4, actual: 2, trimmed: 2 }]);
	}
});

test("issue 686 image budget drops a newer image instead of the oldest refuses", () => {
	for (const api of apis) expect(matches(api, wire(api, [0, 3]))).toBe(false);
});

test("issue 686 image budget drops an image and changes a tool id refuses", () => {
	const body = wire("openai-completions");
	body.messages.find((row: any) => row.role === "tool").tool_call_id =
		"different";
	expect(matches("openai-completions", body)).toBe(false);
});

test("issue 686 image budget extra images refuse", () => {
	for (const api of apis)
		expect(matches(api, wire(api, [0, 1, 2, 3, 3]))).toBe(false);
});

test("issue 686 image budget preserves existing provider text rewrite equivalences", () => {
	for (const api of apis) {
		const body = wire(api);
		const rows = body.messages ?? body.input;
		const row = rows[2];
		if (api === "openai-completions") row.content = "changed result";
		else if (api === "anthropic-messages")
			row.content[0].content[0].text = "changed result";
		else row.output = "changed result";
		expect(matches(api, body)).toBe(true);
	}
});

async function guarded(
	messages: unknown[] = history(),
	api = "openai-completions",
) {
	__setPiHarnessKindForTesting("omp");
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const refusals: string[] = [];
	let aborts = 0;
	const ctx = {
		...fakeContext(session),
		model: model(api),
		abort: () => aborts++,
	};
	registerPiGuardedContext(
		{
			on: (name: string, handler: any) => handlers.set(name, handler),
			appendEntry: (_: string, data: { message: string }) =>
				refusals.push(data.message),
		} as never,
		async () => ({ messages }) as never,
	);
	const emit = (name: string, event: unknown) => {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`missing handler ${name}`);
		return handler(event, ctx);
	};
	emit("agent_start", {});
	await emit("context", { messages: [userMessage("current", 2)] });
	return {
		refusals,
		get stops() {
			return aborts + piBlockedDispatches(ctx);
		},
		dispatch: (payload: unknown) =>
			emit("before_provider_request", { payload }),
	};
}

test("issue 686 image budget managed request sends and raw request without opener refuses", async () => {
	const managed = await guarded();
	managed.dispatch(wire("openai-completions"));
	expect(managed.stops).toBe(0);
	expect(managed.refusals).toEqual([]);
	clearPiContextReceipt(session);
	const raw = await guarded();
	const body = wire("openai-completions");
	body.messages[0].content = "raw old history without managed opener";
	raw.dispatch(body);
	expect(raw.stops).toBe(1);
	expect(raw.refusals[0]).toContain("missing current receipt signature");
});

test("issue 686 image budget partially trims a multi-image user and preserves image-only omission text", () => {
	for (const api of apis) {
		const messages = [
			userMessage("<session-history>managed</session-history>", 1),
			{ role: "user", content: [image(0)] },
			{
				role: "user",
				content: [{ type: "text", text: "kept text" }, image(1), image(2)],
			},
		];
		const nativeImage =
			api === "anthropic-messages"
				? {
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "image-2",
						},
					}
				: api === "openai-completions"
					? { type: "image_url", image_url: { url: url(2) } }
					: { type: "input_image", image_url: url(2), detail: "auto" };
		const rows = [
			{ role: "user", content: "<session-history>managed</session-history>" },
			{ role: "user", content: "[image omitted: provider image limit]" },
			{
				role: "user",
				content: [
					{
						type: api === "openai-responses" ? "input_text" : "text",
						text: "kept text",
					},
					nativeImage,
				],
			},
		];
		const payload =
			api === "openai-responses"
				? { input: rows }
				: {
						messages: rows,
						...(api === "anthropic-messages" ? { system: [] } : {}),
					};
		expect(
			piMatchesPreparedStructure(
				payload,
				piPreparedStructure(messages, model(api)),
			),
		).toBe(true);
	}
});

function otherWire(api: string, kept: number[]) {
	const rows: any[] = [];
	const user = (text: string) =>
		api.startsWith("google-")
			? { role: "user", parts: [{ text }] }
			: api === "bedrock-converse-stream"
				? { role: "user", content: [{ text }] }
				: { role: "user", content: text };
	rows.push(user("<session-history>managed</session-history>"));
	for (let index = 0; index < 4; index++) {
		const id = `call_${index}`;
		const text = `result ${index}`;
		const images = kept.filter((value) => value === index);
		if (api.startsWith("google-"))
			rows.push(
				{
					role: "model",
					parts: [{ functionCall: { id, name: "Read", args: {} } }],
				},
				{
					role: "user",
					parts: [
						{
							functionResponse: {
								id,
								name: "Read",
								response: { output: text },
								parts: images.map(() => ({
									inlineData: { mimeType: "image/png", data: `image-${index}` },
								})),
							},
						},
					],
				},
			);
		else if (api === "bedrock-converse-stream")
			rows.push(
				{
					role: "assistant",
					content: [{ toolUse: { toolUseId: id, name: "Read", input: {} } }],
				},
				{
					role: "user",
					content: [
						{
							toolResult: {
								toolUseId: id,
								content: [
									{ text },
									...images.map(() => ({
										image: {
											format: "png",
											source: { bytes: `image-${index}` },
										},
									})),
								],
								status: "success",
							},
						},
					],
				},
			);
		else
			rows.push(
				{
					role: "assistant",
					content: "",
					tool_calls: [{ function: { name: "Read", arguments: {} } }],
				},
				{
					role: "tool",
					tool_name: "Read",
					content: text,
					...(images.length
						? { images: images.map(() => `image-${index}`) }
						: {}),
				},
			);
	}
	rows.push(user("current"));
	return api.startsWith("google-")
		? { contents: rows }
		: {
				messages: rows,
				...(api === "bedrock-converse-stream" ? { inferenceConfig: {} } : {}),
			};
}

test("issue 686 image budget mirrors nested Google and Bedrock images and Ollama image arrays", () => {
	for (const api of [
		"google-generative-ai",
		"google-gemini-cli",
		"google-vertex",
		"bedrock-converse-stream",
		"ollama-chat",
	]) {
		const prepared = piPreparedStructure(history(), {
			...model(api),
			compat: {
				supportsFunctionPartId: true,
				multimodalFunctionResponse: true,
			},
		});
		expect(piMatchesPreparedStructure(otherWire(api, [2, 3]), prepared)).toBe(
			true,
		);
		expect(piMatchesPreparedStructure(otherWire(api, [0, 3]), prepared)).toBe(
			false,
		);
		expect(
			piMatchesPreparedStructure(otherWire(api, [0, 1, 2, 3, 3]), prepared),
		).toBe(false);
	}
	for (const api of ["azure-openai-responses", "openai-codex-responses"]) {
		expect(
			piMatchesPreparedStructure(
				wire("openai-responses"),
				piPreparedStructure(history(), model(api)),
			),
		).toBe(true);
		expect(
			piMatchesPreparedStructure(
				wire("openai-responses", [0, 3]),
				piPreparedStructure(history(), model(api)),
			),
		).toBe(false);
	}
});

test("issue 686 image budget mirrors hoisted error images and older Gemini image turns", () => {
	for (const api of [
		"anthropic-messages",
		"bedrock-converse-stream",
		"google-generative-ai",
	]) {
		const messages = history().map((message) =>
			message.role === "toolResult" ? { ...message, isError: true } : message,
		);
		const body: any =
			api === "anthropic-messages" ? wire(api) : otherWire(api, [2, 3]);
		const rows = body.messages ?? body.contents;
		for (let index = rows.length - 1; index >= 0; index--) {
			const row = rows[index];
			if (
				api === "anthropic-messages" &&
				row.content?.[0]?.type === "tool_result"
			) {
				const result = row.content[0];
				const images = result.content.filter(
					(part: any) => part.type === "image",
				);
				result.content = result.content.filter(
					(part: any) => part.type !== "image",
				);
				result.is_error = true;
				row.content.push(...images);
			} else if (
				api === "bedrock-converse-stream" &&
				row.content?.[0]?.toolResult
			) {
				const result = row.content[0].toolResult;
				const images = result.content.filter((part: any) => part.image);
				result.content = result.content.map((part: any) =>
					part.image ? { text: "(see attached image)" } : part,
				);
				result.status = "error";
				row.content.push(...images);
			} else if (
				api.startsWith("google-") &&
				row.parts?.[0]?.functionResponse
			) {
				const result = row.parts[0].functionResponse;
				const images = result.parts;
				delete result.parts;
				result.response = { error: result.response.output };
				if (images.length)
					rows.splice(index + 1, 0, {
						role: "user",
						parts: [{ text: "Tool result image:" }, ...images],
					});
			}
		}
		expect(
			piMatchesPreparedStructure(
				body,
				piPreparedStructure(messages, {
					...model(api),
					compat: {
						supportsFunctionPartId: true,
						multimodalFunctionResponse: false,
					},
				}),
			),
		).toBe(true);
	}
});

test("issue 686 image budget captures scalar image metadata without cloning history", () => {
	const messages = history();
	(messages[1] as any).content.push(image(99));
	const clone = globalThis.structuredClone;
	globalThis.structuredClone = () => {
		throw new Error("history cloning is forbidden");
	};
	let prepared: ReturnType<typeof piPreparedStructure>;
	try {
		prepared = piPreparedStructure(messages, model("openai-completions"));
	} finally {
		globalThis.structuredClone = clone;
	}
	(messages[2] as any).content[1].data = "changed after preparation";
	expect(prepared?.imageBudget?.count).toBe(4);
	expect(Reflect.has(prepared?.imageBudget ?? {}, "messages")).toBe(false);
	expect(piMatchesPreparedStructure(wire("openai-completions"), prepared)).toBe(
		true,
	);
});

test("issue 686 image budget equal counts never enter image projection", () => {
	for (const api of apis) {
		const prepared = piPreparedStructure(history(), model(api));
		if (!prepared?.imageBudget) throw new Error("missing image metadata");
		prepared.imageBudget.rows.get = () => {
			throw new Error("equal counts must not project images");
		};
		const body = wire(api, [0, 1, 2, 3]);
		(body.messages ?? body.input)[0].content = "provider-rewritten text";
		const notices: unknown[] = [];
		expect(
			piPreparedStructureMismatch(body, prepared, (value) =>
				notices.push(value),
			),
		).toBeUndefined();
		expect(notices).toEqual([]);
	}
});

test("issue 686 image budget counts developer images in the same oldest-first order", () => {
	for (const api of apis) {
		const messages = history();
		messages.splice(1, 0, {
			role: "developer",
			content: [{ type: "text", text: "developer instruction" }, image(100)],
		} as any);
		const body = wire(api);
		(body.messages ?? body.input).splice(1, 0, {
			role: "user",
			content: "developer instruction",
		});
		expect(
			piMatchesPreparedStructure(
				body,
				piPreparedStructure(messages, model(api)),
			),
		).toBe(true);
	}
});

test("issue 686 image budget logs counts only once per session across retries and passes", () => {
	const base = join(
		tmpdir(),
		"magic-context/omp-686-r4/unit/magic-context/issue-673",
	);
	mkdirSync(base, { recursive: true });
	const root = createTestTempDirFromPath(join(base, "logging-"));
	const source = (file: string) =>
		JSON.stringify(new URL(file, import.meta.url).href);
	const script = `
		import {registerPiGuardedContext, clearPiContextReceipt} from ${source("./pi-context-refusal.ts")};
		import {__setPiHarnessKindForTesting} from ${source("./pi-harness-kind.ts")};
		import {setLogLineForwarder} from ${source("../../plugin/src/shared/logger.ts")};
		const lines=[]; setLogLineForwarder(line=>lines.push(line)); __setPiHarnessKindForTesting('omp');
		const handlers=new Map(); let aborts=0;
		const ctx={cwd:process.env.HOME,hasUI:false,signal:new AbortController().signal,ui:{notify(){}},model:${JSON.stringify(model("openai-completions"))},abort(){aborts++},sessionManager:{getSessionId:()=>"image-logging",getBranch:()=>[]},getContextUsage:()=>({tokens:0,percent:0,contextWindow:100000})};
		registerPiGuardedContext({on:(name,handler)=>handlers.set(name,handler),appendEntry(){}},async()=>({messages:${JSON.stringify(history())}}));
		const emit=(name,event={})=>handlers.get(name)(event,ctx);
		emit('agent_start');
		for(let pass=0;pass<2;pass++) {
			await emit('context',{messages:[{role:'user',content:'current',timestamp:2}]});
			for(let retry=0;retry<2;retry++) emit('before_provider_request',{payload:${JSON.stringify(wire("openai-completions"))}});
		}
		clearPiContextReceipt('image-logging');
		console.log(JSON.stringify({aborts,lines:lines.filter(line=>line.includes('OMP provider images trimmed:')).map(line=>line.replace(/^\\[[^\\]]+\\] /,''))}));
	`;
	try {
		const env = {
			PATH: process.env.PATH ?? "",
			NODE_ENV: "development",
			HOME: root,
			CFFIXED_USER_HOME: root,
			TMPDIR: root,
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_DATA_HOME: join(root, "data"),
			XDG_CACHE_HOME: join(root, "cache"),
			XDG_STATE_HOME: join(root, "state"),
			XDG_RUNTIME_DIR: join(root, "runtime"),
			PI_CODING_AGENT_DIR: join(root, ".omp/agent"),
			MAGIC_CONTEXT_STORAGE_DIR: join(root, "data/cortexkit/magic-context"),
		};
		const result = Bun.spawnSync([process.execPath, "-e", script], {
			env,
			cwd: import.meta.dir,
			windowsHide: true,
		});
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toEqual({
			aborts: 0,
			lines: [
				"[magic-context][pi] OMP provider images trimmed: planned=4 actual=2 trimmed=2\n",
			],
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("issue 686 image budget rejects a newer image dropped inside one user row", () => {
	for (const api of apis) {
		const messages = history();
		messages.splice(messages.length - 1, 0, {
			role: "user",
			content: [
				{ type: "text", text: "before" },
				image(4),
				image(5),
				{ type: "text", text: "after" },
			],
		} as any);
		const body = wire(api, []);
		const nativeImage = (index: number) =>
			api === "anthropic-messages"
				? {
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: `image-${index}`,
						},
					}
				: api === "openai-completions"
					? { type: "image_url", image_url: { url: url(index) } }
					: { type: "input_image", image_url: url(index), detail: "auto" };
		const row = { role: "user", content: [nativeImage(5)] };
		const rows = body.messages ?? body.input;
		rows.splice(rows.length - 1, 0, row);
		const prepared = piPreparedStructure(messages, model(api));
		expect(piMatchesPreparedStructure(body, prepared)).toBe(true);
		row.content = [nativeImage(4)];
		expect(piMatchesPreparedStructure(body, prepared)).toBe(false);
	}
});

test("issue 686 image budget trimmed sessions send with an obfuscated user secret", async () => {
	for (const api of apis) {
		clearPiContextReceipt(session);
		const messages = history();
		messages.splice(
			messages.length - 1,
			0,
			userMessage("API_KEY=sk-example-secret-before-provider-rewrite", 3),
		);
		const body = wire(api);
		const rows = body.messages ?? body.input;
		rows.splice(rows.length - 1, 0, {
			role: "user",
			content: "API_KEY=[REDACTED:credential]",
		});
		const h = await guarded(messages, api);
		h.dispatch(body);
		expect(h.stops).toBe(0);
		expect(h.refusals).toEqual([]);
	}
});

test("issue 686 image budget no-trim inline images retain legacy comparison outcomes", () => {
	for (const api of apis) {
		const messages = history();
		messages.splice(messages.length - 1, 0, {
			role: "user",
			content: [image(4)],
		} as any);
		const body = wire(api, [0, 1, 2, 3]);
		const native =
			api === "anthropic-messages"
				? {
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "provider-rewritten-image",
						},
					}
				: api === "openai-completions"
					? {
							type: "image_url",
							image_url: { url: "https://provider.example/rewritten" },
						}
					: {
							type: "input_image",
							image_url: "https://provider.example/rewritten",
						};
		const rows = body.messages ?? body.input;
		rows.splice(rows.length - 1, 0, { role: "user", content: [native] });
		expect(
			piMatchesPreparedStructure(
				body,
				piPreparedStructure(messages, model(api)),
			),
		).toBe(true);
	}
});
