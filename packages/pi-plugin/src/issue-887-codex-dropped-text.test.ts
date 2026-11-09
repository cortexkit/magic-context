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

// Oh My Pi's Codex lane replays an earlier assistant turn from the native
// Responses items it stored, not from the typed blocks. When the model echoes a
// tag, Magic Context's assistant-message hook cleans the typed text and Oh My
// Pi removes that block's text signature, leaving the native item untouched.
// These tests cover dropping such a reply, with Oh My Pi's real hook runner and
// its real Codex request encoder at two pinned versions.
const { dir: root, cleanup } = createTestTempDir("mc-codex-dropped-text-");
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
const aliases = [
	"omp-pi-ai-18132",
	"omp-pi-ai-18181",
	"omp-coding-agent-18132",
];
await pinOmpLoggerFiles(root, aliases);
// 18.18.3 has the same Codex message conversion and text phase handling as
// 18.18.1; its encoder changes only add tool namespaces.
const encoders = [
	{ version: "18.13.2", alias: "omp-pi-ai-18132" },
	{ version: "18.18.1", alias: "omp-pi-ai-18181" },
].map(({ version, alias }) => ({ version, alias, convert: undefined as any }));
for (const encoder of encoders)
	encoder.convert = (
		await import(
			`${packageRoot(encoder.alias, encoder.version)}src/providers/openai-codex-responses.ts`
		)
	).convertCodexResponsesMessages;
const { ExtensionRunner } = await import(
	`${packageRoot("omp-coding-agent-18132", "18.13.2")}src/extensibility/extensions/runner.ts`
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
	id: "gpt-5",
	provider: "openai-codex",
	api: "openai-codex-responses",
	input: ["text"],
	identity: { class: "gpt" },
	compat: { supportsDeveloperRole: true, supportsImageDetailOriginal: false },
	supportsComputerUse: false,
};
const cwd = "C:/work/project";
const ORIGINAL = "Checking the parser now.";
const PLACEHOLDER = "[dropped §42§]";
type Phase = "commentary" | "final_answer" | undefined;

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

/**
 * One Codex turn as Oh My Pi stores it: hidden reasoning, one visible message
 * and, for a commentary reply, the tool call it introduces.
 */
function codexTurn(
	typed: Record<string, unknown>,
	nativeText: string,
	phase: Phase,
): any {
	const tool = phase !== "final_answer";
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: tool ? "toolUse" : "stop",
		timestamp: 2,
		content: [
			{ type: "thinking", thinking: "", thinkingSignature: "", summary: [] },
			typed,
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
				{
					type: "message",
					id: "msg_c",
					role: "assistant",
					status: "completed",
					...(phase ? { phase } : {}),
					content: [{ type: "output_text", text: nativeText, annotations: [] }],
				},
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
const history = (assistant: unknown, phase: Phase): any[] =>
	phase === "final_answer"
		? [user(), assistant, user("next", 4)]
		: [user(), assistant, toolResult, user("next", 4)];

/** The reply after Oh My Pi's real hook runner applied Magic Context's cleanup. */
async function hookRewritten(phase: Phase, echoed = `§41§ ${ORIGINAL}`) {
	const raw = codexTurn(
		{
			type: "text",
			text: echoed,
			textSignature: JSON.stringify({
				v: 1,
				id: "msg_c",
				...(phase ? { phase } : {}),
			}),
		},
		echoed,
		phase,
	);
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
	// Only the unused UI context is stubbed; the rewrite rules are the host's.
	runner.createContext = () => ({ ui: {} });
	runner.onError((error: unknown) => {
		throw new Error(JSON.stringify(error));
	});
	const content = await runner.emitAssistantMessage(raw);
	const saved = JSON.parse(JSON.stringify({ ...raw, content }));
	expect(saved.content[1]).toEqual({ type: "text", text: ORIGINAL });
	expect(saved.providerPayload.items[1].content[0].text).toBe(echoed);
	return saved;
}

/** Replace the reply's text with the placeholder through the transcript, as a drop does. */
function dropText(messages: unknown[], text = PLACEHOLDER) {
	const transcript = createPiTranscript(messages, undefined);
	expect(transcript.messages[1].parts[1].kind).toBe("text");
	transcript.messages[1].parts[1].setText(text);
	transcript.commit();
	return messages[1] as any;
}

function dispatch(messages: unknown[], convert: any) {
	const before = JSON.stringify(messages);
	const prepared = preparePiDispatch(messages, model, true, cwd);
	// The dispatch preparation itself never changes what is sent.
	expect(JSON.stringify(prepared.messages)).toBe(before);
	const input = convert(model, {
		systemPrompt: ["system"],
		messages: prepared.messages,
	});
	const assistant = input.filter(
		(row: any) => row.type === "message" && row.role === "assistant",
	);
	return {
		input,
		bytes: JSON.stringify(input),
		assistant,
		mismatch: piPreparedStructureMismatch({ input }, prepared.structure),
	};
}

const phases: Phase[] = ["commentary", "final_answer", undefined];

describe("a dropped reply whose signature Oh My Pi removed", () => {
	for (const harness of ["omp", "pi"] as const) {
		for (const phase of phases) {
			test(`${harness} ${phase ?? "no phase"}: the drop ${harness === "omp" ? "reaches" : "leaves"} the native item`, async () => {
				__setPiHarnessKindForTesting(harness);
				const saved = await hookRewritten(phase);
				const messages = history(structuredClone(saved), phase);
				const next = dropText(messages);
				expect(next.content[1]).toEqual({ type: "text", text: PLACEHOLDER });
				const items = next.providerPayload.items;
				if (harness === "pi") {
					// Only Oh My Pi's hook removes signatures; Pi keeps native bytes.
					expect(items).toEqual(saved.providerPayload.items);
					return;
				}
				const expected = structuredClone(saved.providerPayload.items);
				expected[1].content[0].text = PLACEHOLDER;
				expect(items).toEqual(expected);
				expect(items[1].phase).toBe(phase);
				expect(items[1].id).toBe("msg_c");
				for (const encoder of encoders) {
					const sent = dispatch(messages, encoder.convert);
					expect(sent.mismatch).toBeUndefined();
					expect(
						sent.assistant.map((row: any) => [row.content[0].text, row.phase]),
					).toEqual([[PLACEHOLDER, phase]]);
					expect(sent.bytes).not.toContain(ORIGINAL);
					// A later pass that replays the same drop sends the same bytes.
					const again = history(structuredClone(saved), phase);
					dropText(again);
					expect(dispatch(again, encoder.convert).bytes).toBe(sent.bytes);
				}
			});
		}
	}

	test("each pinned encoder still refuses the stale native text when nothing mirrors the drop", async () => {
		__setPiHarnessKindForTesting("pi");
		const saved = await hookRewritten("commentary");
		const messages = history(structuredClone(saved), "commentary");
		dropText(messages);
		for (const encoder of encoders) {
			const sent = dispatch(messages, encoder.convert);
			expect(sent.bytes).toContain(ORIGINAL);
			expect(sent.mismatch).toContain("comparison=content");
		}
	});

	const guards: [string, (message: any) => void, string?][] = [
		["an edit that is not a drop placeholder", () => {}, "Checking parser."],
		[
			"native text that the hook did not change",
			(message) => {
				message.providerPayload.items[1].content[0].text = ORIGINAL;
			},
		],
		[
			"a native item with a second output part",
			(message) => {
				message.providerPayload.items[1].content.push({
					type: "output_text",
					text: "more",
					annotations: [],
				});
				message.content.splice(2, 0, { type: "text", text: "more" });
			},
		],
		[
			"native items that do not pair with the typed blocks",
			(message) => {
				message.providerPayload.items.splice(2, 0, {
					type: "message",
					id: "msg_extra",
					role: "assistant",
					status: "completed",
					phase: "commentary",
					content: [{ type: "output_text", text: "extra", annotations: [] }],
				});
			},
		],
		[
			"a replacement payload rather than an append-only one",
			(message) => {
				message.providerPayload.dt = false;
			},
		],
		[
			"a block that still carries a signature",
			(message) => {
				message.content[1].textSignature = "legacy-plain-id";
			},
		],
	];
	for (const [name, change, text] of guards) {
		test(`never writes native text for ${name}`, async () => {
			__setPiHarnessKindForTesting("omp");
			const saved = await hookRewritten("commentary");
			const messages = history(structuredClone(saved), "commentary");
			change(messages[1]);
			const before = structuredClone(messages[1].providerPayload);
			const next = dropText(messages, text);
			expect(next.content[1].text).toBe(text ?? PLACEHOLDER);
			expect(next.providerPayload).toEqual(before);
		});
	}
});

describe("a placeholder that the native item already holds", () => {
	for (const encoder of encoders) {
		for (const phase of phases) {
			test(`${encoder.version} ${phase ?? "no phase"}: admitted with the native item's phase`, () => {
				const messages = history(
					codexTurn({ type: "text", text: PLACEHOLDER }, PLACEHOLDER, phase),
					phase,
				);
				const sent = dispatch(messages, encoder.convert);
				expect(
					sent.assistant.map((row: any) => [row.content[0].text, row.phase]),
				).toEqual([[PLACEHOLDER, phase]]);
				expect(sent.mismatch).toBeUndefined();
			});
		}
		for (const [name, nativeText] of [
			["another tag's placeholder", "[dropped §41§]"],
			["the original reply", ORIGINAL],
			["the echoed original reply", `§41§ ${ORIGINAL}`],
		] as const) {
			test(`${encoder.version}: refuses ${name} on the wire`, () => {
				const messages = history(
					codexTurn(
						{ type: "text", text: PLACEHOLDER },
						nativeText,
						"commentary",
					),
					"commentary",
				);
				expect(dispatch(messages, encoder.convert).mismatch).toContain(
					"comparison=content",
				);
			});
		}
		test(`${encoder.version}: a placeholder does not admit a clean unsigned sibling`, () => {
			const turn = codexTurn(
				{ type: "text", text: PLACEHOLDER },
				PLACEHOLDER,
				"commentary",
			);
			turn.content.splice(2, 0, { type: "text", text: "Second" });
			turn.providerPayload.items.splice(2, 0, {
				type: "message",
				id: "msg_second",
				role: "assistant",
				status: "completed",
				phase: "commentary",
				content: [{ type: "output_text", text: "Second", annotations: [] }],
			});
			expect(
				dispatch(history(turn, "commentary"), encoder.convert).mismatch,
			).toContain("comparison=content");
		});
	}
});

test("the real pass mirrors the drop on its rebuild and a defer pass replays the same bytes", async () => {
	__setPiHarnessKindForTesting("omp");
	const saved = await hookRewritten("commentary");
	const raw = history(saved, "commentary");
	const sessionId = "codex-unsigned-drop";
	const db = createTestDb();
	const fake = createFakePi();
	let aborted = false;
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
			abort: () => {
				aborted = true;
			},
		};
		const result = await (fake.handlers.get("context") as any)(
			{ messages },
			ctx,
		);
		expect(result?.messages).toBeDefined();
		const input = encoders[1].convert(model, {
			systemPrompt: ["system"],
			messages: result.messages,
		});
		// Oh My Pi's dispatch hook runs the prepared-turn check on what it sends.
		const refused = await (fake.handlers.get("before_provider_request") as any)(
			{ payload: { input } },
			ctx,
		);
		return {
			messages: JSON.stringify(result.messages),
			wire: JSON.stringify(input),
			refused,
		};
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
		const later = tags.find((tag) => tag.messageId.startsWith("e3"));
		expect(reply).toBeDefined();
		expect(later).toBeDefined();
		queuePendingOp(db, sessionId, reply!.tagNumber, "drop");
		signalPiPendingMaterialization(sessionId, "user_flush");
		const rebuilt = await pass();
		expect(getPendingOps(db, sessionId)).toEqual([]);
		const placeholder = `[dropped §${reply!.tagNumber}§]`;
		expect(rebuilt.wire).toContain(placeholder);
		expect(rebuilt.wire).not.toContain(ORIGINAL);
		expect(rebuilt.refused).toBeUndefined();
		expect(aborted).toBe(false);
		// A drop queued now waits for the next rebuild, so the following pass
		// is a defer: it must send exactly the bytes of the rebuilt pass.
		queuePendingOp(db, sessionId, later!.tagNumber, "drop");
		const deferred = await pass();
		expect(getPendingOps(db, sessionId)).toHaveLength(1);
		expect(deferred.messages).toBe(rebuilt.messages);
		expect(deferred.wire).toBe(rebuilt.wire);
		expect(deferred.refused).toBeUndefined();
		expect(aborted).toBe(false);
	} finally {
		clearContextHandlerSession(sessionId);
		await drainPiTagSnapshotSession(sessionId);
		db.close();
	}
});
