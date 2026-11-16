import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import {
	piBlockedDispatches,
	registerPiGuardedContext,
} from "./__tests__/dispatch-probe";
import {
	exerciseOmpLoggerFiles,
	pinOmpLoggerFiles,
	reportOmpLogDescriptors,
} from "./__tests__/omp-log-files";
import {
	isOmpUnmanagedCaptureRequest,
	OMP_AUTOLEARN_CAPTURE_PROMPT,
	piWithoutOmpJuice,
} from "./omp-request-kind";
import {
	piChainResponse,
	piExpandChainedRequest,
	piPreparedHistory,
} from "./pi-dispatch-chain";
import { preparePiDispatch } from "./pi-dispatch-structure";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext } from "./test-utils.test";

// Two more Oh My Pi request shapes the dispatch check must handle:
// - OMP's reasoning-off Juice item, appended after the whole Responses input;
// - OMP's auto-learn capture, which resends the raw conversation through the
//   main session's request hook after a run ends.
// Requests are built with the real builders of every pinned @oh-my-pi/pi-ai
// release, and models are resolved by its own catalog (@oh-my-pi/pi-catalog).
const { dir: root, cleanup } = createTestTempDir("mc-issue-931-requests-");
const keys = [
	"HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
	"XDG_RUNTIME_DIR",
	"MAGIC_CONTEXT_STORAGE_DIR",
	"PI_CODING_AGENT_DIR",
];
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
for (const key of keys) {
	process.env[key] = join(root, key);
	mkdirSync(process.env[key] as string, { recursive: true });
}
const require = createRequire(import.meta.url);
const pins = [
	{ alias: "omp-pi-ai-18190", version: "18.19.0" },
	{ alias: "omp-pi-ai-18200", version: "18.20.0" },
	{ alias: "omp-pi-ai-18203", version: "18.20.3" },
] as const;
await pinOmpLoggerFiles(
	root,
	pins.map((pin) => pin.alias),
);
type Builder = (...args: any[]) => any;
interface Host {
	version: string;
	buildParams: Builder;
	delta: Builder;
	sanitize: Builder;
	anthropic: Builder;
	completions: Builder;
	resolve: Builder;
}
const hosts: Host[] = [];
for (const pin of pins) {
	const path = require.resolve(`${pin.alias}/package.json`).slice(0, -12);
	expect(require(`${path}package.json`).version).toBe(pin.version);
	const shared = await import(`${path}src/providers/openai-shared.ts`);
	hosts.push({
		version: pin.version,
		buildParams: (await import(`${path}src/providers/openai-responses.ts`))
			.buildParams,
		delta: shared.buildResponsesDeltaInput,
		sanitize: (await import(`${path}src/utils.ts`))
			.sanitizeOpenAIResponsesAssistantHistoryItemsForReplay,
		anthropic: (await import(`${path}src/providers/anthropic.ts`))
			.convertAnthropicMessages,
		completions: (await import(`${path}src/providers/openai-completions.ts`))
			.convertMessages,
		resolve: (await import(`${path}../pi-catalog/src/compat/resolve.ts`))
			.resolveModelPolicy,
	});
}
await exerciseOmpLoggerFiles(pins.map((pin) => pin.alias));
reportOmpLogDescriptors();
afterEach(() => __setPiHarnessKindForTesting(undefined));
afterAll(() => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	cleanup();
});

/** A model as OMP resolves it: the spec plus its catalog policy. */
function resolved(host: Host, spec: Record<string, unknown>) {
	const policy = host.resolve(spec);
	return {
		...spec,
		identity: policy.identity,
		compat: policy.compat,
		thinking: policy.thinking,
	} as any;
}

const spec = {
	name: "model",
	reasoning: true,
	input: ["text"],
	contextWindow: 200000,
	maxTokens: 8192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
// The catalog requires the Juice item for GPT 5.6 and later on Responses
// (pi-catalog src/compat/rules/classes/openai.kdl, revision ">=5.6").
const gpt = (host: Host) =>
	resolved(host, {
		...spec,
		api: "openai-responses",
		provider: "openai",
		id: "gpt-5.6",
		baseUrl: "https://api.openai.com/v1",
	});
const plain = (host: Host) =>
	resolved(host, {
		...spec,
		api: "openai-responses",
		provider: "mock",
		id: "mock-model",
		baseUrl: "http://127.0.0.1:9/v1",
	});

// The capture agent's tool list: every main-session tool, then the capture
// tools (captureToolList). A main request of the same session has the same.
const tools = ["read", "bash", "manage_skill"].map((name) => ({
	name,
	description: `${name} tool`,
	parameters: { type: "object", properties: {}, additionalProperties: false },
}));

/** The provider request OMP's openai-responses provider sends (buildParams). */
function request(
	host: Host,
	model: unknown,
	messages: unknown[],
	options: Record<string, unknown> = {},
) {
	return host.buildParams(
		model,
		{ systemPrompt: ["system prompt"], messages, tools },
		options,
		undefined,
	);
}

function harness(model: unknown) {
	__setPiHarnessKindForTesting("omp");
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const entries: string[] = [];
	registerPiGuardedContext(
		{
			on: (name: string, fn: (...args: unknown[]) => unknown) =>
				handlers.set(name, fn),
			appendEntry: (_type: string, data: { message: string }) =>
				entries.push(data.message),
		} as never,
		async (event) => ({ messages: event.messages }),
	);
	const ctx = {
		...fakeContext("issue-931"),
		model,
		ui: { notify: () => {} },
		abort: () => {},
	};
	const emit = (name: string, event: unknown = {}) => {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`missing ${name} handler`);
		return handler(event, ctx);
	};
	return {
		entries,
		get blocked() {
			return piBlockedDispatches(ctx);
		},
		emit,
		/** One context pass; returns the messages it prepared. */
		async pass(messages: unknown[]) {
			const result = (await emit("context", {
				messages: structuredClone(messages),
			})) as { messages: unknown[] };
			return result.messages;
		},
		send(payload: unknown) {
			emit("before_provider_request", { payload });
		},
	};
}

const prompt = (text: string, timestamp = 1) => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp,
});

const juiceItem = (n: number) => ({
	role: "developer",
	content: [{ type: "input_text", text: `# Juice: ${n} !important` }],
});

for (const host of hosts)
	describe(`issue 931 Juice item on OMP ${host.version}`, () => {
		test("the catalog asks for it on GPT 5.6 Responses models only", () => {
			expect(gpt(host).compat.requiresReasoningOffJuiceInstruction).toBe(true);
			expect(plain(host).compat.requiresReasoningOffJuiceInstruction).toBe(
				false,
			);
		});

		test("OMP appends it after the input when reasoning is forced off", () => {
			const built = request(host, gpt(host), [prompt("hello")], {
				forceReasoningOff: true,
				reasoning: "high",
			});
			expect(built.trailingScaffoldingItems).toBe(1);
			expect(built.params.input.at(-1)).toEqual(juiceItem(48));
			expect(built.params.reasoning).toEqual({ effort: "none" });
			const unforced = request(host, gpt(host), [prompt("hello")]);
			expect(unforced.trailingScaffoldingItems).toBe(0);
		});

		for (const reasoning of ["minimal", "low", "medium", "high", "xhigh"])
			test(`a ${reasoning} request with the Juice item is admitted`, async () => {
				const h = harness(gpt(host));
				h.emit("agent_start");
				const prepared = await h.pass([prompt("hello")]);
				const built = request(host, gpt(host), prepared, {
					forceReasoningOff: true,
					reasoning,
				});
				expect(built.trailingScaffoldingItems).toBe(1);
				h.send(built.params);
				expect(h.blocked).toBe(0);
				expect(h.entries).toEqual([]);
			});

		const altered: [string, (input: any[]) => void][] = [
			["another value", (input) => input.splice(-1, 1, juiceItem(7))],
			[
				"a user role",
				(input) => input.splice(-1, 1, { ...juiceItem(8), role: "user" }),
			],
			[
				"other text",
				(input) =>
					input.splice(-1, 1, {
						role: "developer",
						content: [{ type: "input_text", text: "# Juice: 8 !important." }],
					}),
			],
			["an extra field", (input) => Object.assign(input.at(-1), { id: "x" })],
			[
				"a second copy before it",
				(input) => input.splice(-1, 1, juiceItem(8), juiceItem(8)),
			],
		];
		for (const [name, change] of altered)
			test(`a Juice item with ${name} is still refused`, async () => {
				const h = harness(gpt(host));
				h.emit("agent_start");
				const prepared = await h.pass([prompt("hello")]);
				const built = request(host, gpt(host), prepared, {
					forceReasoningOff: true,
					reasoning: "medium",
				});
				change(built.params.input);
				h.send(built.params);
				expect(h.blocked).toBe(1);
				expect(h.entries.at(-1)).toContain("prepared turn structure");
			});

		test("a Juice item is refused for a model whose catalog does not ask for it", async () => {
			const h = harness(plain(host));
			h.emit("agent_start");
			const prepared = await h.pass([prompt("hello")]);
			const built = request(host, plain(host), prepared);
			built.params.input.push(juiceItem(8));
			h.send(built.params);
			expect(h.blocked).toBe(1);
		});

		test("a chained continuation ending in the Juice item is admitted", () => {
			// OMP records the chain without the Juice item and appends it again
			// after the delta (buildOpenAIResponsesChainedParams).
			const model = gpt(host);
			const first = [prompt("hello", 1)];
			const answer = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				responseId: "resp_1",
				timestamp: 2,
				content: [{ type: "text", text: "hi" }],
				providerPayload: {
					type: "openaiResponsesHistory",
					provider: model.provider,
					dt: true,
					items: [
						{
							type: "message",
							id: "msg_1",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "hi", annotations: [] }],
						},
					],
				},
			};
			const options = { forceReasoningOff: true, reasoning: "medium" };
			const before = preparePiDispatch(
				structuredClone(first),
				model,
				true,
				"/work",
			);
			const current = preparePiDispatch(
				structuredClone([...first, answer, prompt("again", 3)]),
				model,
				true,
				"/work",
			);
			const previousSent = request(
				host,
				model,
				before.messages,
				options,
			).params;
			const currentFull = request(
				host,
				model,
				current.messages,
				options,
			).params;
			const strip = (input: unknown[]) => input.slice(0, -1);
			const delta = host.delta(
				{ input: strip(previousSent.input) },
				host.sanitize(structuredClone(answer.providerPayload.items)),
				{ input: strip(currentFull.input) },
			);
			expect(delta?.length).toBeGreaterThan(0);
			const frame = {
				...currentFull,
				previous_response_id: "resp_1",
				input: [...delta, juiceItem(8)],
			};
			const recorded = piChainResponse(current.messages[1]);
			const prepared = piPreparedHistory(before.messages, model);
			if (!recorded || !prepared) throw new Error("fixture cannot chain");
			// The dispatch hook records what it admitted without the Juice item.
			const anchor = {
				input: (piWithoutOmpJuice(previousSent, model) as { input: unknown[] })
					.input,
				prepared,
				...recorded,
			};
			const expand = (payload: { input: unknown[] }) =>
				piExpandChainedRequest(
					payload as never,
					{ previousResponseId: "resp_1", delta: payload.input },
					anchor,
					piPreparedHistory(current.messages, model),
					{ current: undefined, resend: false },
				);
			const admitted = expand(piWithoutOmpJuice(frame, model) as typeof frame);
			expect("refusal" in admitted ? admitted.refusal : undefined).toBe(
				undefined,
			);
			const unstripped = expand(frame);
			expect("refusal" in unstripped ? unstripped.refusal : undefined).toBe(
				"delta differs from the prepared provider input tail",
			);
		});
	});

// The raw history the capture agent copies: OMP drops the assistant turns'
// provider payloads and response ids (createAutoLearnCaptureRunner).
function rawHistory(model: { api: string; provider: string; id: string }) {
	const assistant = (timestamp: number, content: unknown[], stop: string) => ({
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: stop,
		timestamp,
		content,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	return [
		prompt("read f1.txt", 1),
		assistant(
			2,
			[
				{
					type: "toolCall",
					id: "call_a",
					name: "read",
					arguments: { path: "f1.txt" },
				},
			],
			"toolUse",
		),
		{
			role: "toolResult",
			toolCallId: "call_a",
			toolName: "read",
			content: [{ type: "text", text: "first file" }],
			isError: false,
			timestamp: 3,
		},
		assistant(4, [{ type: "text", text: "MAIN DONE." }], "stop"),
	];
}

// The capture prompt as OMP's convertToLlm hands it to the provider: the
// autolearn-nudge custom message becomes an agent-attributed user turn (seen
// on the wire of real OMP 18.19.0, 18.20.0 and 18.20.3 runs).
const capturePrompt = (
	content: unknown[] = [{ type: "text", text: OMP_AUTOLEARN_CAPTURE_PROMPT }],
) => ({ role: "user", content, attribution: "agent", timestamp: 5 });
const reminder =
	"<system-reminder>\nToday: 2026-11-16; current working directory: '/work'. Do not repeat this information in your reply.\n</system-reminder>";
// The capture agent's second request, after its first reply called a tool.
const captureReply = (model: { api: string; provider: string; id: string }) => [
	{
		...rawHistory(model)[1],
		timestamp: 6,
		content: [
			{
				type: "toolCall",
				id: "call_c",
				name: "manage_skill",
				arguments: {},
			},
		],
	},
	{
		role: "toolResult",
		toolCallId: "call_c",
		toolName: "manage_skill",
		content: [{ type: "text", text: "saved" }],
		isError: false,
		timestamp: 7,
	},
];

/** The capture request on each API, built with OMP's own converters. */
function captureRequests(host: Host, tail: (model: any) => unknown[]) {
	const responses = plain(host);
	const anthropic = resolved(host, {
		...spec,
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-sonnet-4-5",
		baseUrl: "https://api.anthropic.com",
	});
	const completions = resolved(host, {
		...spec,
		api: "openai-completions",
		provider: "mock",
		id: "mock-chat",
		baseUrl: "http://127.0.0.1:9/v1",
	});
	const messages = (model: any) => [...rawHistory(model), ...tail(model)];
	return {
		responses: request(host, responses, messages(responses)).params,
		juice: request(host, gpt(host), messages(gpt(host)), {
			forceReasoningOff: true,
			reasoning: "medium",
		}).params,
		anthropic: {
			model: anthropic.id,
			system: [{ type: "text", text: "system prompt" }],
			messages: host.anthropic(messages(anthropic), anthropic, false),
			tools: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				input_schema: tool.parameters,
			})),
		},
		completions: {
			model: completions.id,
			messages: host.completions(
				completions,
				{ systemPrompt: ["system prompt"], messages: messages(completions) },
				completions.compat,
			),
			tools: tools.map((tool) => ({ type: "function", function: tool })),
		},
	};
}

describe("issue 931 auto-learn capture prompt", () => {
	test("matches OMP's prompt file", () => {
		// The 18.19.0 coding agent is a pinned test dependency; 18.20.0 and
		// 18.20.3 ship the same file (checked against their packages and wire).
		const path = require
			.resolve("omp-coding-agent-18190/package.json")
			.slice(0, -12);
		expect(
			readFileSync(
				`${path}src/prompts/system/autolearn-nudge-autocontinue.md`,
				"utf8",
			).trim(),
		).toBe(OMP_AUTOLEARN_CAPTURE_PROMPT);
	});
});

for (const host of hosts)
	describe(`issue 931 auto-learn capture on OMP ${host.version}`, () => {
		const shapes: [string, (model: any) => unknown[]][] = [
			["first", () => [capturePrompt()]],
			["second", (model) => [capturePrompt(), ...captureReply(model)]],
			[
				"date-prefixed",
				() => [
					capturePrompt([
						{ type: "text", text: reminder },
						{ type: "text", text: OMP_AUTOLEARN_CAPTURE_PROMPT },
					]),
				],
			],
			[
				"date-joined",
				() => [
					capturePrompt([
						{
							type: "text",
							text: `${reminder}\n${OMP_AUTOLEARN_CAPTURE_PROMPT}`,
						},
					]),
				],
			],
		];
		for (const [name, tail] of shapes)
			for (const [api, body] of Object.entries(captureRequests(host, tail)))
				test(`the ${name} capture request on ${api} is recognised`, () => {
					expect(isOmpUnmanagedCaptureRequest(body)).toBe(true);
				});

		const notCapture: [string, (model: any) => unknown[]][] = [
			["an ordinary prompt", () => [prompt("capture what you learned", 5)]],
			[
				"a changed capture prompt",
				() => [
					capturePrompt([
						{ type: "text", text: `${OMP_AUTOLEARN_CAPTURE_PROMPT} ` },
					]),
				],
			],
			[
				"a user turn after the capture prompt",
				() => [capturePrompt(), prompt("go on", 6)],
			],
			[
				"extra text beside the capture prompt",
				() => [
					capturePrompt([
						{ type: "text", text: OMP_AUTOLEARN_CAPTURE_PROMPT },
						{ type: "text", text: "and more" },
					]),
				],
			],
		];
		for (const [name, tail] of notCapture)
			for (const [api, body] of Object.entries(captureRequests(host, tail)))
				test(`${name} on ${api} is not a capture`, () => {
					expect(isOmpUnmanagedCaptureRequest(body)).toBe(false);
				});

		test("a capture prompt without the capture tools is not a capture", () => {
			const body = captureRequests(host, () => [capturePrompt()]).responses;
			body.tools = body.tools.filter(
				(tool: { name?: string }) => tool.name !== "manage_skill",
			);
			expect(isOmpUnmanagedCaptureRequest(body)).toBe(false);
		});

		test("a capture leaves the main operation and session entries untouched", async () => {
			const model = plain(host);
			const h = harness(model);
			h.emit("agent_start");
			const prepared = await h.pass(rawHistory(model));
			// The capture arrives while the main run's request is still prepared.
			h.send(captureRequests(host, () => [capturePrompt()]).responses);
			expect(h.blocked).toBe(1);
			expect(h.entries).toEqual([]);
			// The main operation's receipt still admits its own request.
			h.send(request(host, model, prepared).params);
			expect(h.blocked).toBe(1);
			h.emit("agent_end", { messages: rawHistory(model) });
			// After the run ends: refused, still without an entry.
			h.send(
				captureRequests(host, (m) => [capturePrompt(), ...captureReply(m)])
					.responses,
			);
			expect(h.blocked).toBe(2);
			expect(h.entries).toEqual([]);
		});

		test("a main request with the capture tools is still managed", async () => {
			const model = plain(host);
			const h = harness(model);
			h.emit("agent_start");
			// No context pass prepared this request: refused as unmanaged.
			h.send(request(host, model, rawHistory(model)).params);
			expect(h.blocked).toBe(1);
			expect(h.entries.at(-1)).toContain("no context pass ran");
			const prepared = await h.pass(rawHistory(model));
			h.send(request(host, model, prepared).params);
			expect(h.blocked).toBe(1);
		});
	});
