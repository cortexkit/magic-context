import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import {
	exerciseOmpLoggerFiles,
	pinOmpLoggerFiles,
	reportOmpLogDescriptors,
} from "./__tests__/omp-log-files";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
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

// Witnesses for the dispatch check on Oh My Pi's OpenAI Responses route, which
// refuses a request whose assistant rows differ from what the context pass
// prepared. The first describe block fails today: an edited reply that lost its
// text signature is refused on every later request, because the edit never
// reaches the stored native item Oh My Pi replays. The control shows a signed
// reply under the same edit is admitted. The last block passes: tag-free text
// with surrounding whitespace keeps its signature and is admitted after real
// tagging passes.
const { dir: root, cleanup } = createTestTempDir("mc-issue-909-witness-");
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
const packageRoot = (alias: string) =>
	require.resolve(`${alias}/package.json`).slice(0, -12);
const aliases = ["omp-pi-ai-18190", "omp-coding-agent-18190"];
await pinOmpLoggerFiles(root, aliases);
const ai = packageRoot(aliases[0]);
expect(require(`${ai}package.json`).version).toBe("18.19.0");
const { buildResponsesInput } = await import(
	`${ai}src/providers/openai-shared.ts`
);
const { syncOpenAIResponsesHistoryTexts } = await import(`${ai}src/utils.ts`);
const { ExtensionRunner } = await import(
	`${packageRoot(aliases[1])}src/extensibility/extensions/runner.ts`
);
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
	api: "openai-responses",
	provider: "example",
	id: "gpt-example",
	input: ["text"],
	identity: { class: "gpt" },
	compat: {},
};
const NATIVE = "Checking the proposal against the code before writing it up.";
// A shorter rewrite of the same reply, standing in for a pass edit that is not
// a drop, such as caveman compression of older assistant text.
const COMPRESSED = "Check proposal vs code before write-up.";

function turn(text: string, native: string, signed: boolean): any {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "toolUse",
		timestamp: 2,
		content: [
			{ type: "thinking", thinking: "", summary: false },
			{
				type: "text",
				text,
				...(signed
					? {
							textSignature: JSON.stringify({
								v: 1,
								id: "msg_example",
								phase: "commentary",
							}),
						}
					: {}),
			},
			{
				type: "toolCall",
				id: "call_example|fc_example",
				name: "example_tool",
				arguments: { value: 1 },
			},
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
					phase: "commentary",
					status: "completed",
					content: [{ type: "output_text", text: native, annotations: [] }],
				},
				{
					type: "function_call",
					id: "fc_example",
					call_id: "call_example",
					name: "example_tool",
					arguments: '{"value":1}',
					status: "completed",
				},
			],
		},
	};
}
const history = (assistant: any): any[] => [
	{ role: "user", content: [{ type: "text", text: "question" }], timestamp: 1 },
	assistant,
	{
		role: "toolResult",
		toolCallId: "call_example|fc_example",
		toolName: "example_tool",
		timestamp: 3,
		content: [{ type: "text", text: "tool output" }],
		isError: false,
	},
	{ role: "user", content: [{ type: "text", text: "next" }], timestamp: 4 },
];
const native = (message: any) => message.providerPayload.items[1];
const encode = (messages: unknown[]) =>
	buildResponsesInput({
		model,
		context: { systemPrompt: ["system"], messages },
		strictResponsesPairing: false,
		supportsImageDetailOriginal: false,
		nativeHistory: { replay: true, filterReasoning: false },
	});

/** Edit the reply's text block through the transcript, as a pass would. */
function editAndPrepare(message: any, text: string) {
	__setPiHarnessKindForTesting("omp");
	const messages = history(structuredClone(message));
	const transcript = createPiTranscript(messages, undefined);
	expect(transcript.messages[1].parts[1].kind).toBe("text");
	transcript.messages[1].parts[1].setText(text);
	transcript.commit();
	const prepared = preparePiDispatch(messages, model, true, "/work");
	return {
		next: prepared.messages[1] as any,
		mismatch: piPreparedStructureMismatch(
			{ input: encode(prepared.messages) },
			prepared.structure,
		),
	};
}

describe("WITNESS (fails today): a non-drop edit of a hook-cleaned reply", () => {
	// 18.19.0 stored shape after the hook removed an echoed tag: the block lost
	// its signature and Oh My Pi copied the cleaned text into the native item.
	test("an unsigned reply's edited text reaches its native item and the warm request is admitted", () => {
		const { next, mismatch } = editAndPrepare(
			turn(NATIVE, NATIVE, false),
			`§42§ ${COMPRESSED}`,
		);
		// rewriteNativeAssistantTexts mirrors only a drop placeholder into an
		// unsigned block's native item. When Oh My Pi replays stored native
		// history (its warm path), it still sends the uncompressed text, and the
		// dispatch check refuses every request.
		expect(mismatch).toBeUndefined();
		expect(native(next).content[0].text).toBe(COMPRESSED);
	});
});

describe("control: the same edit of a signed reply", () => {
	test("is mirrored by id and phase, and the warm request is admitted", () => {
		const { next, mismatch } = editAndPrepare(
			turn(NATIVE, NATIVE, true),
			`§42§ ${COMPRESSED}`,
		);
		expect(native(next).content[0].text).toBe(`§42§ ${COMPRESSED}`);
		expect(mismatch).toBeUndefined();
	});
});

describe("checked: tag-free text with surrounding whitespace through real passes", () => {
	test("18.19.0 keeps the signature, tags the block, and admits both passes", async () => {
		__setPiHarnessKindForTesting("omp");
		const raw = turn(`\n${NATIVE}\n`, `\n${NATIVE}\n`, true);
		const handlers = new Map();
		registerOmpAssistantMessageStrip(
			{ on: (name: string, fn: unknown) => handlers.set(name, [fn]) },
			() => true,
		);
		const runner = new ExtensionRunner(
			[{ path: "strip", handlers }],
			{},
			root,
			{},
			{},
		);
		runner.createContext = () => ({ ui: {} });
		const message = structuredClone(raw);
		const content = await runner.emitAssistantMessage(message);
		expect(content).toBeUndefined();
		expect(
			syncOpenAIResponsesHistoryTexts(message.providerPayload, [
				`\n${NATIVE}\n`,
			]),
		).toBeUndefined();
		const sessionId = "issue-909-witness-whitespace";
		const db = createTestDb();
		const fake = createFakePi();
		const pass = async () => {
			const messages = structuredClone(history(message));
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
			const block = result.messages.find(
				(entry: any) => entry.role === "assistant",
			).content[1];
			const input = encode(result.messages);
			const refused = await (
				fake.handlers.get("before_provider_request") as any
			)({ payload: { input } }, ctx);
			return { block, wire: JSON.stringify(input), refused };
		};
		try {
			registerPiContextHandler(fake.pi as never, {
				db,
				protectedTags: 0,
				injection: { injectionBudgetTokens: 10000 },
			});
			const first = await pass();
			expect(first.block.text).toMatch(/^§\d+§ \n/u);
			expect(first.block.textSignature).toBeString();
			expect(first.wire).toContain(JSON.stringify(`\n${NATIVE}\n`));
			expect(first.refused).toBeUndefined();
			const second = await pass();
			expect(second.wire).toBe(first.wire);
			expect(second.refused).toBeUndefined();
		} finally {
			clearContextHandlerSession(sessionId);
			await drainPiTagSnapshotSession(sessionId);
			db.close();
		}
	});
});
