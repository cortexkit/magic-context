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
	piPreparedStructureMismatch,
	preparePiDispatch,
} from "./pi-dispatch-structure";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { registerOmpAssistantMessageStrip } from "./strip-tag-prefix";
import { drainPiTagSnapshotSession } from "./tag-snapshot-pi";
import { createFakePi, createTestDb, fakeContext } from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

// Dropping a reply whose signature Oh My Pi's assistant-message hook removed,
// across every pinned Oh My Pi Codex encoder (17.1.7 to 18.18.1) and hook
// runner (18.12.3 to 18.13.2), and in reply shapes with more than one block.
const { dir: root, cleanup } = createTestTempDir("mc-887-review-");
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
const aiPins = [
	["omp-pi-ai-171", "17.1.7"],
	["omp-pi-ai-1889", "18.8.9"],
	["omp-pi-ai-1811", "18.11.3"],
	["omp-pi-ai-1812", "18.12.3"],
	["omp-pi-ai-18126", "18.12.6"],
	["omp-pi-ai-1813", "18.13.0"],
	["omp-pi-ai-18132", "18.13.2"],
	["omp-pi-ai-18180", "18.18.0"],
	["omp-pi-ai-18181", "18.18.1"],
] as const;
const agentPins = [
	["omp-coding-agent-1812", "18.12.3"],
	["omp-coding-agent-18126", "18.12.6"],
	["omp-coding-agent-18132", "18.13.2"],
] as const;
const aliases = [...aiPins, ...agentPins].map(([alias]) => alias);
await pinOmpLoggerFiles(root, aliases);
const encoders: { version: string; convert: any }[] = [];
for (const [alias, version] of aiPins)
	encoders.push({
		version,
		convert: (
			await import(
				`${packageRoot(alias, version)}src/providers/openai-codex-responses.ts`
			)
		).convertCodexResponsesMessages,
	});
const runners: { version: string; Runner: any }[] = [];
for (const [alias, version] of agentPins)
	runners.push({
		version,
		Runner: (
			await import(
				`${packageRoot(alias, version)}src/extensibility/extensions/runner.ts`
			)
		).ExtensionRunner,
	});
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

const model = {
	id: "gpt-5",
	provider: "openai-codex",
	api: "openai-codex-responses",
	input: ["text"],
	identity: { class: "gpt" },
	compat: { supportsDeveloperRole: true, supportsImageDetailOriginal: false },
	supportsComputerUse: false,
};
const ORIGINAL = "Checking the parser now.";
const PLACEHOLDER = "[dropped §42§]";
type Phase = "commentary" | "final_answer" | undefined;
const phases: Phase[] = ["commentary", "final_answer", undefined];

const user = (text = "question", timestamp = 1) => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp,
});
const toolResult = {
	role: "toolResult",
	toolCallId: "call_a|fc_a",
	toolName: "read",
	timestamp: 3,
	content: [{ type: "text", text: "file body" }],
	isError: false,
};
const signature = (id: string, phase: Phase) =>
	JSON.stringify({ v: 1, id, ...(phase ? { phase } : {}) });

/** A Codex turn with one message item per text block, as Oh My Pi stores it. */
function codexTurn(
	blocks: { text: string; native: string; id: string; phase: Phase }[],
	tool: boolean,
	modelId = model.id,
): any {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: modelId,
		stopReason: tool ? "toolUse" : "stop",
		timestamp: 2,
		content: [
			{ type: "thinking", thinking: "", thinkingSignature: "", summary: [] },
			...blocks.map((block) => ({
				type: "text",
				text: block.text,
				textSignature: signature(block.id, block.phase),
			})),
			...(tool
				? [{ type: "toolCall", id: "call_a|fc_a", name: "read", arguments: {} }]
				: []),
		],
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: model.provider,
			dt: true,
			items: [
				{
					type: "reasoning",
					id: "rs_a",
					summary: [],
					encrypted_content: "synthetic-not-a-signature",
				},
				...blocks.map((block) => ({
					type: "message",
					id: block.id,
					role: "assistant",
					status: "completed",
					...(block.phase ? { phase: block.phase } : {}),
					content: [
						{ type: "output_text", text: block.native, annotations: [] },
					],
				})),
				...(tool
					? [
							{
								type: "function_call",
								id: "fc_a",
								call_id: "call_a",
								name: "read",
								arguments: "{}",
							},
						]
					: []),
			],
		},
	};
}
const history = (assistant: unknown, tool: boolean): any[] =>
	tool
		? [user(), assistant, toolResult, user("next", 4)]
		: [user(), assistant, user("next", 4)];

/** Run Magic Context's strip through one pinned Oh My Pi hook runner. */
async function throughHook(raw: any, Runner: any) {
	const handlers = new Map();
	registerOmpAssistantMessageStrip(
		{ on: (name: string, fn: unknown) => handlers.set(name, [fn]) },
		() => true,
	);
	const runner = new Runner([{ path: "strip", handlers }], {}, root, {}, {});
	runner.createContext = () => ({ ui: {} });
	runner.onError((error: unknown) => {
		throw new Error(JSON.stringify(error));
	});
	const content = await runner.emitAssistantMessage(raw);
	return JSON.parse(
		JSON.stringify({ ...raw, content: content ?? raw.content }),
	);
}

/** Set typed text blocks (by content index) through the transcript, then commit. */
function edit(messages: unknown[], edits: [number, string][]) {
	const transcript = createPiTranscript(messages, undefined);
	for (const [part, text] of edits) {
		expect(transcript.messages[1].parts[part].kind).toBe("text");
		transcript.messages[1].parts[part].setText(text);
	}
	transcript.commit();
	return messages[1] as any;
}

function dispatch(messages: unknown[], convert: any, target = model) {
	const before = JSON.stringify(messages);
	const prepared = preparePiDispatch(messages, target, true, "/work");
	expect(JSON.stringify(prepared.messages)).toBe(before);
	const input = convert(target, {
		systemPrompt: ["system"],
		messages: prepared.messages,
	});
	return {
		bytes: JSON.stringify(input),
		assistant: input
			.filter((row: any) => row.type === "message" && row.role === "assistant")
			.map((row: any) => [row.content[0].text, row.phase]),
		mismatch: piPreparedStructureMismatch({ input }, prepared.structure),
	};
}

describe("every pinned runner and encoder", () => {
	for (const runner of runners) {
		for (const phase of phases) {
			test(`runner ${runner.version} ${phase ?? "no phase"}: hook-cleaned drop mirrors and every encoder admits it`, async () => {
				__setPiHarnessKindForTesting("omp");
				const tool = phase !== "final_answer";
				const saved = await throughHook(
					codexTurn(
						[
							{
								text: `§41§ ${ORIGINAL}`,
								native: `§41§ ${ORIGINAL}`,
								id: "msg_c",
								phase,
							},
						],
						tool,
					),
					runner.Runner,
				);
				expect(saved.content[1]).toEqual({ type: "text", text: ORIGINAL });
				expect(saved.providerPayload.items[1].content[0].text).toBe(
					`§41§ ${ORIGINAL}`,
				);
				const messages = history(structuredClone(saved), tool);
				const next = edit(messages, [[1, PLACEHOLDER]]);
				expect(next.providerPayload.items[1].content[0].text).toBe(PLACEHOLDER);
				expect(next.providerPayload.items[1].phase).toBe(phase);
				for (const encoder of encoders) {
					const sent = dispatch(messages, encoder.convert);
					expect([encoder.version, sent.mismatch]).toEqual([
						encoder.version,
						undefined,
					]);
					expect([encoder.version, sent.assistant]).toEqual([
						encoder.version,
						[[PLACEHOLDER, phase]],
					]);
					expect(sent.bytes).not.toContain(ORIGINAL);
				}
				// Without the mirror every encoder replays the stale native text.
				__setPiHarnessKindForTesting("pi");
				const stale = history(structuredClone(saved), tool);
				edit(stale, [[1, PLACEHOLDER]]);
				for (const encoder of encoders) {
					const sent = dispatch(stale, encoder.convert);
					expect([encoder.version, sent.bytes.includes(ORIGINAL)]).toEqual([
						encoder.version,
						true,
					]);
					if (phase !== undefined)
						expect([encoder.version, sent.mismatch]).toEqual([
							encoder.version,
							expect.stringContaining("comparison=content"),
						]);
				}
			});
		}
	}
	for (const encoder of encoders)
		for (const phase of phases)
			test(`${encoder.version} ${phase ?? "no phase"}: reporter fixture admitted with the native phase`, () => {
				const turn = codexTurn(
					[{ text: PLACEHOLDER, native: PLACEHOLDER, id: "msg_c", phase }],
					true,
				);
				delete turn.content[1].textSignature;
				const sent = dispatch(history(turn, true), encoder.convert);
				expect(sent.assistant).toEqual([[PLACEHOLDER, phase]]);
				expect(sent.mismatch).toBeUndefined();
			});
});

describe("reply shapes with more than one text block", () => {
	const runner = runners[2];
	const encoder = encoders[8];

	test("two hook-cleaned replies in one message, both dropped", async () => {
		__setPiHarnessKindForTesting("omp");
		const saved = await throughHook(
			codexTurn(
				[
					{
						text: "§41§ First.",
						native: "§41§ First.",
						id: "msg_1",
						phase: "commentary",
					},
					{
						text: "§43§ Second.",
						native: "§43§ Second.",
						id: "msg_2",
						phase: "commentary",
					},
				],
				true,
			),
			runner.Runner,
		);
		expect(saved.content[1]).toEqual({ type: "text", text: "First." });
		expect(saved.content[2]).toEqual({ type: "text", text: "Second." });
		const messages = history(structuredClone(saved), true);
		const next = edit(messages, [
			[1, "[dropped §7§]"],
			[2, "[dropped §8§]"],
		]);
		expect(next.providerPayload.items[1].content[0].text).toBe("[dropped §7§]");
		expect(next.providerPayload.items[2].content[0].text).toBe("[dropped §8§]");
		const sent = dispatch(messages, encoder.convert);
		expect(sent.mismatch).toBeUndefined();
		expect(sent.bytes).not.toContain("First.");
		expect(sent.bytes).not.toContain("Second.");
	});

	test("a hook-cleaned drop beside a signed sibling that is also dropped", async () => {
		__setPiHarnessKindForTesting("omp");
		const saved = await throughHook(
			codexTurn(
				[
					{
						text: "§41§ First.",
						native: "§41§ First.",
						id: "msg_1",
						phase: "commentary",
					},
					{
						text: "Second.",
						native: "Second.",
						id: "msg_2",
						phase: "commentary",
					},
				],
				true,
			),
			runner.Runner,
		);
		expect(saved.content[1]).toEqual({ type: "text", text: "First." });
		expect(typeof saved.content[2].textSignature).toBe("string");
		const messages = history(structuredClone(saved), true);
		edit(messages, [
			[1, "[dropped §7§]"],
			[2, "[dropped §8§]"],
		]);
		const sent = dispatch(messages, encoder.convert);
		expect(sent.mismatch).toBeUndefined();
		expect(sent.bytes).not.toContain("First.");
		expect(sent.bytes).not.toContain("Second.");
	});

	test("a hook-cleaned drop beside a signed sibling whose tag label is added", async () => {
		__setPiHarnessKindForTesting("omp");
		const saved = await throughHook(
			codexTurn(
				[
					{
						text: "§41§ First.",
						native: "§41§ First.",
						id: "msg_1",
						phase: "commentary",
					},
					{
						text: "Second.",
						native: "Second.",
						id: "msg_2",
						phase: "commentary",
					},
				],
				true,
			),
			runner.Runner,
		);
		const messages = history(structuredClone(saved), true);
		edit(messages, [
			[1, "[dropped §7§]"],
			[2, "§8§ Second."],
		]);
		const sent = dispatch(messages, encoder.convert);
		expect(sent.mismatch).toBeUndefined();
		expect(sent.bytes).not.toContain("First.");
	});

	test("a whitespace-only difference keeps the signature, and the drop is still mirrored", async () => {
		__setPiHarnessKindForTesting("omp");
		const raw = codexTurn(
			[
				{
					text: `${ORIGINAL}\n`,
					native: `${ORIGINAL}\n`,
					id: "msg_c",
					phase: "commentary",
				},
			],
			true,
		);
		const saved = await throughHook(raw, runner.Runner);
		// The hook leaves tag-free text alone, so the block stays signed.
		expect(saved.content[1]).toEqual(raw.content[1]);
		const messages = history(structuredClone(saved), true);
		const next = edit(messages, [[1, PLACEHOLDER]]);
		expect(next.providerPayload.items[1].content[0].text).toBe(PLACEHOLDER);
		const sent = dispatch(messages, encoder.convert);
		expect(sent.mismatch).toBeUndefined();
		expect(sent.bytes).not.toContain(ORIGINAL);
	});

	test("a reply from another Codex model: the mirror does not change the wire", async () => {
		const saved = await throughHook(
			codexTurn(
				[
					{
						text: `§41§ ${ORIGINAL}`,
						native: `§41§ ${ORIGINAL}`,
						id: "msg_c",
						phase: "commentary",
					},
				],
				true,
				"gpt-5-mini",
			),
			runner.Runner,
		);
		const wires: string[] = [];
		for (const harness of ["omp", "pi"] as const) {
			__setPiHarnessKindForTesting(harness);
			const messages = history(structuredClone(saved), true);
			edit(messages, [[1, PLACEHOLDER]]);
			const sent = dispatch(messages, encoder.convert);
			expect(sent.mismatch).toBeUndefined();
			expect(sent.bytes).not.toContain(ORIGINAL);
			wires.push(sent.bytes);
		}
		expect(wires[0]).toBe(wires[1]);
	});
});

test("final_answer through the real handler: rebuild and defer agree", async () => {
	__setPiHarnessKindForTesting("omp");
	const saved = await throughHook(
		codexTurn(
			[
				{
					text: `§41§ ${ORIGINAL}`,
					native: `§41§ ${ORIGINAL}`,
					id: "msg_c",
					phase: "final_answer",
				},
			],
			false,
		),
		runners[2].Runner,
	);
	const raw = history(saved, false);
	const sessionId = "codex-unsigned-final";
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
		const input = encoders[8].convert(model, {
			systemPrompt: ["system"],
			messages: result.messages,
		});
		const refused = await (fake.handlers.get("before_provider_request") as any)(
			{ payload: { input } },
			ctx,
		);
		return { wire: JSON.stringify(input), refused };
	};
	try {
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			injection: { injectionBudgetTokens: 10000 },
		});
		const first = await pass();
		expect(first.wire).toContain(ORIGINAL);
		const tags = getTagsBySession(db, sessionId).filter(
			(tag) => tag.type === "message",
		);
		const reply = tags.find((tag) => tag.messageId.startsWith("e1"));
		const later = tags.find((tag) => tag.messageId.startsWith("e2"));
		queuePendingOp(db, sessionId, reply!.tagNumber, "drop");
		signalPiPendingMaterialization(sessionId, "user_flush");
		const rebuilt = await pass();
		expect(getPendingOps(db, sessionId)).toEqual([]);
		expect(rebuilt.wire).not.toContain(ORIGINAL);
		expect(rebuilt.refused).toBeUndefined();
		queuePendingOp(db, sessionId, later!.tagNumber, "drop");
		const deferred = await pass();
		expect(getPendingOps(db, sessionId)).toHaveLength(1);
		expect(deferred.wire).toBe(rebuilt.wire);
		expect(deferred.refused).toBeUndefined();
	} finally {
		clearContextHandlerSession(sessionId);
		await drainPiTagSnapshotSession(sessionId);
		db.close();
	}
});
