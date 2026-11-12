import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import {
	exerciseOmpLoggerFiles,
	pinOmpLoggerFiles,
	reportOmpLogDescriptors,
} from "./__tests__/omp-log-files";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import {
	type PiResponsesUnsignedAlternatives,
	piResponsesAssistantTexts,
	piResponsesWireTexts,
} from "./pi-dispatch-responses-history";
import {
	piPreparedStructureMismatch,
	preparePiDispatch,
} from "./pi-dispatch-structure";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { registerOmpAssistantMessageStrip } from "./strip-tag-prefix";
import { drainPiTagSnapshotSession } from "./tag-snapshot-pi";
import { createFakePi, createTestDb, fakeContext } from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

// An OpenAI Responses reply whose text Magic Context's assistant-message hook
// cleaned loses its textSignature in Oh My Pi. Up to 18.18 the stored native
// item keeps the model's original bytes; from 18.19.0 Oh My Pi also copies the
// cleaned text into it (sdk.ts:4943-4953, utils.ts:712-746), so the stored
// block and native item hold the same bytes. Warm native replay sends that
// item with its phase either way. These tests run the real hook runner and
// Responses encoder of both pinned releases.
const { dir: root, cleanup } = createTestTempDir("mc-responses-synced-");
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
	mkdirSync(process.env[key]!, { recursive: true });
}
const require = createRequire(import.meta.url);
const packageRoot = (alias: string, version: string) => {
	const path = require.resolve(`${alias}/package.json`).slice(0, -12);
	expect(require(`${path}package.json`).version).toBe(version);
	return path;
};
const pins = [
	{
		ai: "omp-pi-ai-18186",
		agent: "omp-coding-agent-18186",
		version: "18.18.6",
	},
	{
		ai: "omp-pi-ai-18190",
		agent: "omp-coding-agent-18190",
		version: "18.19.0",
	},
] as const;
const aliases = pins.flatMap((pin) => [pin.ai, pin.agent]);
await pinOmpLoggerFiles(root, aliases);
type Host = {
	version: string;
	build: (options: unknown) => any[];
	Runner: any;
	sync?: (payload: unknown, texts: readonly string[]) => unknown;
};
const hosts: Host[] = [];
for (const pin of pins) {
	const ai = packageRoot(pin.ai, pin.version);
	const utils = await import(`${ai}src/utils.ts`);
	hosts.push({
		version: pin.version,
		build: (await import(`${ai}src/providers/openai-shared.ts`))
			.buildResponsesInput,
		Runner: (
			await import(
				`${packageRoot(pin.agent, pin.version)}src/extensibility/extensions/runner.ts`
			)
		).ExtensionRunner,
		// Only 18.19.0 exports the step that copies hook rewrites into the
		// stored native items; 18.18.6 sets the rewritten content alone.
		sync: utils.syncOpenAIResponsesHistoryTexts,
	});
}
await exerciseOmpLoggerFiles(aliases);
reportOmpLogDescriptors();
afterAll(() => {
	__setPiHarnessKindForTesting(undefined);
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	cleanup();
});

test("only 18.19.0 ships the native text sync", () => {
	expect(hosts.map((host) => [host.version, typeof host.sync])).toEqual([
		["18.18.6", "undefined"],
		["18.19.0", "function"],
	]);
});

const model = {
	api: "openai-responses",
	provider: "example",
	id: "gpt-example",
	input: ["text"],
	identity: { class: "gpt" },
	compat: {},
};
const NATIVE = "Checking the proposal against the code before writing it up.";
const PLACEHOLDER = "[dropped §42§]";
type Phase = "commentary" | "final_answer";
const phases: Phase[] = ["commentary", "final_answer"];

const user = (text = "question", timestamp = 1) => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp,
});
const toolResult = {
	role: "toolResult",
	toolCallId: "call_example|fc_example",
	toolName: "example_tool",
	timestamp: 3,
	content: [{ type: "text", text: "tool output" }],
	isError: false,
};

/** One Responses turn as Oh My Pi stores it straight from the provider. */
function turn(
	text: string,
	native: string,
	phase: Phase,
	{ signed = true, tool = phase === "commentary" } = {},
): any {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: tool ? "toolUse" : "stop",
		timestamp: 2,
		content: [
			{ type: "thinking", thinking: "", summary: false },
			{
				type: "text",
				text,
				...(signed
					? {
							textSignature: JSON.stringify({ v: 1, id: "msg_example", phase }),
						}
					: {}),
			},
			...(tool
				? [
						{
							type: "toolCall",
							id: "call_example|fc_example",
							name: "example_tool",
							arguments: { value: 1 },
						},
					]
				: []),
		],
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: model.provider,
			dt: true,
			items: [
				{
					type: "reasoning",
					id: "rs_example",
					summary: [],
					content: [],
					encrypted_content: "opaque",
				},
				{
					type: "message",
					role: "assistant",
					id: "msg_example",
					phase,
					status: "completed",
					content: [{ type: "output_text", text: native, annotations: [] }],
				},
				...(tool
					? [
							{
								type: "function_call",
								id: "fc_example",
								call_id: "call_example",
								name: "example_tool",
								arguments: '{"value":1}',
								status: "completed",
							},
						]
					: []),
			],
		},
	};
}
const history = (assistant: any): any[] =>
	assistant.stopReason === "toolUse"
		? [user(), assistant, toolResult, user("next", 4)]
		: [user(), assistant, user("next", 4)];
const native = (message: any) => message.providerPayload.items[1];

/**
 * Finish a provider reply the way the host's finished-message transform does:
 * run Magic Context's assistant-message hook through the real runner, then on
 * 18.19.0 copy the rewrite into the stored native items (sdk.ts:4943-4953).
 */
async function finish(host: Host, raw: any) {
	const handlers = new Map();
	registerOmpAssistantMessageStrip(
		{ on: (name: string, fn: unknown) => handlers.set(name, [fn]) },
		() => true,
	);
	const runner = new host.Runner(
		[{ path: "strip", handlers }],
		{},
		root,
		{},
		{},
	);
	// Only unused context dependencies are stubbed; rewrite validation is the host's.
	runner.createContext = () => ({ ui: {} });
	runner.onError((error: unknown) => {
		throw new Error(JSON.stringify(error));
	});
	const message = structuredClone(raw);
	const content = await runner.emitAssistantMessage(message);
	if (content) {
		const synced = host.sync?.(
			message.providerPayload,
			content
				.filter((block: any) => block.type === "text")
				.map((block: any) => block.text),
		);
		message.content = content;
		if (synced) message.providerPayload = synced;
	}
	return {
		rewritten: content !== undefined,
		message: JSON.parse(JSON.stringify(message)),
	};
}

function encode(host: Host, messages: unknown[], replay = true) {
	return host.build({
		model,
		context: { systemPrompt: ["system"], messages },
		strictResponsesPairing: false,
		supportsImageDetailOriginal: false,
		nativeHistory: { replay, filterReasoning: false },
	});
}
const wireTexts = (input: any[]) =>
	input
		.filter((item) => item.type === "message" && item.role === "assistant")
		.flatMap((item) => piResponsesWireTexts(item.content, item.phase));
const pair = (text: string, phase: Phase | null) =>
	JSON.stringify([text, phase]);

/** Prepare a request the way the dispatch hook does and compare a wire to it. */
function prepare(messages: unknown[]) {
	const before = JSON.stringify(messages);
	const prepared = preparePiDispatch(messages, model, true, "/work");
	expect(JSON.stringify(prepared.messages)).toBe(before);
	return {
		messages: prepared.messages,
		mismatch: (input: unknown[]) =>
			piPreparedStructureMismatch({ input }, prepared.structure),
	};
}

/** Set the reply's text block through the transcript, then commit. */
function edit(messages: unknown[], text: string) {
	const transcript = createPiTranscript(messages, undefined);
	expect(transcript.messages[1].parts[1].kind).toBe("text");
	transcript.messages[1].parts[1].setText(text);
	transcript.commit();
	return messages[1] as any;
}

describe("assistant-message hook through the real runner", () => {
	for (const host of hosts)
		for (const phase of phases) {
			test(`${host.version} ${phase}: tag-free text with surrounding whitespace keeps its bytes and signature`, async () => {
				__setPiHarnessKindForTesting("omp");
				const raw = turn(`\n${NATIVE}\n`, `\n${NATIVE}\n`, phase);
				const { rewritten, message } = await finish(host, raw);
				expect(rewritten).toBe(false);
				expect(message.content[1]).toEqual(raw.content[1]);
				expect(native(message).content[0].text).toBe(`\n${NATIVE}\n`);
				const request = prepare(history(message));
				expect(
					request.mismatch(encode(host, request.messages)),
				).toBeUndefined();
			});
			test(`${host.version} ${phase}: an echoed tag is still removed, and the signature with it`, async () => {
				const { rewritten, message } = await finish(
					host,
					turn(`§12§ ${NATIVE}\n`, `§12§ ${NATIVE}\n`, phase),
				);
				expect(rewritten).toBe(true);
				expect(message.content[1]).toEqual({ type: "text", text: NATIVE });
				expect(native(message).content[0].text).toBe(
					host.sync ? NATIVE : `§12§ ${NATIVE}\n`,
				);
			});
		}
});

describe("planner cases from the bug report", () => {
	const cases = [
		{ label: "signed, no context tag", signed: true, text: NATIVE },
		{ label: "unsigned, no context tag", signed: false, text: NATIVE },
		{
			label: "unsigned, context tag 42",
			signed: false,
			text: `§42§ ${NATIVE}`,
		},
	];
	for (const host of hosts)
		for (const check of cases)
			test(`${host.version} ${check.label}: warm replay matches the plan`, () => {
				__setPiHarnessKindForTesting("omp");
				const message = turn(check.text, NATIVE, "commentary", {
					signed: check.signed,
				});
				const alternatives: PiResponsesUnsignedAlternatives = {};
				const planned = piResponsesAssistantTexts(
					message,
					model,
					"omp",
					alternatives,
				);
				const warm = wireTexts(encode(host, [message]));
				expect(warm).toEqual([pair(NATIVE, "commentary")]);
				expect(planned).toEqual(warm);
				if (check.signed) {
					expect(alternatives).toEqual({});
					return;
				}
				// The cold alternative is the block text: encrypted reasoning
				// keeps Oh My Pi from replaying this turn's native items cold.
				expect(alternatives).toEqual({
					fallback: [pair(check.text, null)],
					cold: [pair(check.text, null)],
				});
				expect(wireTexts(encode(host, [message], false))).toEqual(
					alternatives.cold as string[],
				);
				// The whole request, warm and cold, passes the dispatch check.
				const request = prepare(history(message));
				expect(
					request.mismatch(encode(host, request.messages)),
				).toBeUndefined();
				expect(
					request.mismatch(encode(host, request.messages, false)),
				).toBeUndefined();
			});
});

describe("guarded context after a hook-cleaned reply", () => {
	for (const host of hosts)
		for (const phase of phases)
			test(`${host.version} ${phase}: later requests are admitted, before and after the reply is dropped`, async () => {
				__setPiHarnessKindForTesting("omp");
				const { message } = await finish(
					host,
					turn(`§7§ ${NATIVE}`, `§7§ ${NATIVE}`, phase),
				);
				expect(message.content[1]).toEqual({ type: "text", text: NATIVE });
				const raw = history(message);
				const sessionId = `synced-unsigned-${host.version}-${phase}`;
				const db = createTestDb();
				const fake = createFakePi();
				const pass = async () => {
					const messages = structuredClone(raw);
					const ctx = {
						...fakeContext(
							sessionId,
							root,
							messages.map((_, index) => `e${index}`),
							messages as never,
						),
						model,
						abort: () => {},
					};
					const result = await (fake.handlers.get("context") as any)(
						{ messages },
						ctx,
					);
					const input = encode(host, result.messages);
					const refused = await (
						fake.handlers.get("before_provider_request") as any
					)({ payload: { input } }, ctx);
					return { wire: JSON.stringify(input), refused };
				};
				try {
					registerPiContextHandler(fake.pi as never, {
						db,
						protectedTags: 0,
						injection: { injectionBudgetTokens: 10000 },
					});
					const first = await pass();
					expect(first.wire).toContain(NATIVE);
					expect(first.refused).toBeUndefined();
					const second = await pass();
					expect(second.wire).toBe(first.wire);
					expect(second.refused).toBeUndefined();
					const reply = getTagsBySession(db, sessionId).find(
						(tag) => tag.type === "message" && tag.messageId.startsWith("e1"),
					);
					queuePendingOp(db, sessionId, reply!.tagNumber, "drop");
					signalPiPendingMaterialization(sessionId, "user_flush");
					const rebuilt = await pass();
					expect(getPendingOps(db, sessionId)).toEqual([]);
					expect(rebuilt.wire).not.toContain(NATIVE);
					expect(rebuilt.refused).toBeUndefined();
				} finally {
					clearContextHandlerSession(sessionId);
					await drainPiTagSnapshotSession(sessionId);
					db.close();
				}
			});
});

describe("a drop is written into the replayed native item", () => {
	for (const host of hosts)
		for (const phase of phases)
			test(`${host.version} ${phase}: the placeholder request is admitted and the stored native bytes are refused`, async () => {
				__setPiHarnessKindForTesting("omp");
				const { message } = await finish(
					host,
					turn(`§7§ ${NATIVE}`, `§7§ ${NATIVE}`, phase),
				);
				const stored = native(message).content[0].text;
				expect(stored).toBe(host.sync ? NATIVE : `§7§ ${NATIVE}`);
				const messages = history(structuredClone(message));
				const next = edit(messages, PLACEHOLDER);
				expect(native(next).content[0].text).toBe(PLACEHOLDER);
				expect(native(next).phase).toBe(phase);
				const request = prepare(messages);
				const input = encode(host, request.messages);
				expect(JSON.stringify(input)).not.toContain(NATIVE);
				expect(request.mismatch(input)).toBeUndefined();
				const stale = structuredClone(input);
				const item = stale.find(
					(entry: any) =>
						entry.type === "message" && entry.role === "assistant",
				);
				item.content[0].text = stored;
				expect(request.mismatch(stale)).toContain("comparison=content");
			});
});

describe("unsigned replies the hook cannot explain stay refused", () => {
	const synced = () => turn(NATIVE, NATIVE, "commentary", { signed: false });
	const refusals: {
		name: string;
		change?: (message: any) => void;
		wire?: (input: any[]) => void;
	}[] = [
		{
			name: "a block text that differs from the native text",
			change: (m) => {
				m.content[1].text = "Checking the proposal against something else.";
			},
		},
		{
			name: "a block text that differs beyond its leading tag",
			change: (m) => {
				m.content[1].text = `§42§ ${NATIVE} Later edit.`;
			},
		},
		{
			name: "mid-text tag notation on both sides",
			change: (m) => {
				m.content[1].text = native(m).content[0].text =
					"Checking §3§ the proposal.";
			},
		},
		{
			name: "a stray section sign on both sides",
			change: (m) => {
				m.content[1].text = native(m).content[0].text =
					"Checking § the proposal.";
			},
		},
		{
			name: "surrounding whitespace on both sides",
			change: (m) => {
				m.content[1].text = native(m).content[0].text = `${NATIVE}\n`;
			},
		},
		{
			name: "a signed block whose native text differs",
			change: (m) => {
				m.content[1].textSignature = JSON.stringify({
					v: 1,
					id: "msg_example",
					phase: "commentary",
				});
				native(m).content[0].text = "Checking something else.";
			},
		},
		{
			name: "a wire phase that differs from the stored item",
			wire: (input) => {
				input.find((entry) => entry.type === "message").phase = "final_answer";
			},
		},
		{
			name: "a wire text that differs from the stored item",
			wire: (input) => {
				input.find((entry) => entry.type === "message").content[0].text =
					"Checking something else.";
			},
		},
		{
			name: "an unsigned sibling whose text differs from its native item",
			change: (m) => {
				m.content.splice(2, 0, { type: "text", text: "Another." });
				m.providerPayload.items.splice(2, 0, {
					type: "message",
					role: "assistant",
					id: "msg_other",
					phase: "commentary",
					status: "completed",
					content: [{ type: "output_text", text: "Other.", annotations: [] }],
				});
			},
		},
	];
	for (const host of hosts)
		for (const check of refusals)
			test(`${host.version}: ${check.name}`, () => {
				__setPiHarnessKindForTesting("omp");
				const message = synced();
				check.change?.(message);
				const request = prepare(history(message));
				const input = encode(host, request.messages);
				check.wire?.(input);
				expect(request.mismatch(input)).toContain("comparison=content");
			});
});
