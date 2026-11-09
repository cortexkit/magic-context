import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
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
import { drainPiTagSnapshotSession } from "./tag-snapshot-pi";
import { createFakePi, createTestDb, fakeContext } from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

// The prepared-turn check compares a Responses request with Magic Context's
// projection of it only when it can model every assistant turn; one block it
// cannot model skips that comparison for the whole request. Blocks that Oh My
// Pi itself drops for a Responses target are modeled as dropped. A second
// check reads only the prepared messages: Oh My Pi's encoder replays a
// same-model turn from its stored native items, so a drop that never reached
// the native item would go out as the original text, skip or not.
const { dir: root, cleanup } = createTestTempDir("mc-codex-unmodeled-");
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
// Every Oh My Pi version the suite pins. All of them build the OpenAI
// Responses input; the two newest also serve the Codex lane below.
const pinned = [
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
await pinOmpLoggerFiles(
	root,
	pinned.map(([alias]) => alias),
);
const roots = new Map<string, string>();
for (const [alias, version] of pinned) {
	const path = require.resolve(`${alias}/package.json`).slice(0, -12);
	expect(require(`${path}package.json`).version).toBe(version);
	roots.set(version, path);
}
const responsesHosts: { version: string; build: any }[] = [];
for (const [, version] of pinned)
	responsesHosts.push({
		version,
		build: (await import(`${roots.get(version)}src/providers/openai-shared.ts`))
			.buildResponsesInput,
	});
const encoders: { version: string; convert: any }[] = [];
for (const version of ["18.13.2", "18.18.1"])
	encoders.push({
		version,
		convert: (
			await import(
				`${roots.get(version)}src/providers/openai-codex-responses.ts`
			)
		).convertCodexResponsesMessages,
	});
await exerciseOmpLoggerFiles(pinned.map(([alias]) => alias));
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
const responsesModel = {
	id: "gpt-5",
	provider: "openai",
	api: "openai-responses",
	input: ["text"],
	identity: { class: "gpt", model: "gpt-5" },
	compat: {},
};
const ORIGINAL = "Synthetic secret-shaped reply body.";
const PLACEHOLDER = "[dropped §42§]";
const user = (text: string, timestamp: number) => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp,
});

/** Each block kind Oh My Pi drops from another model's turn for a Responses target. */
const droppedKinds: Record<string, Record<string, unknown>> = {
	redactedThinking: { type: "redactedThinking", data: "synthetic-redacted" },
	image: { type: "image", data: "c3ludGhldGlj", mimeType: "image/png" },
	anthropicServerTool: {
		type: "anthropicServerTool",
		block: {
			type: "server_tool_use",
			id: "srvtoolu_synthetic",
			name: "web_search",
			input: { query: "synthetic-server-tool" },
		},
	},
	fallback: { type: "fallback", from: "synthetic-fallback-model" },
};

/** An Anthropic turn from before the switch to the Responses model. */
function foreign(
	block: Record<string, unknown> = droppedKinds.redactedThinking,
) {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-synthetic",
		stopReason: "stop",
		timestamp: 2,
		content: [block, { type: "text", text: "Earlier answer." }],
	};
}

/** A same-model Codex reply whose stored native item holds `nativeText`. */
function codexReply(
	typed: Record<string, unknown>,
	nativeText: string,
	extraItems: unknown[] = [],
): any {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: 4,
		content: [typed],
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: model.provider,
			dt: true,
			items: [
				...extraItems,
				{
					type: "message",
					id: "msg_c",
					role: "assistant",
					status: "completed",
					phase: "final_answer",
					content: [{ type: "output_text", text: nativeText, annotations: [] }],
				},
			],
		},
	};
}
const signed = (id: string) => ({
	type: "text",
	text: ORIGINAL,
	textSignature: JSON.stringify({ v: 1, id, phase: "final_answer" }),
});
/** The signature names an id that is not the stored native item's id. */
const signedMismatch = () => codexReply(signed("msg_other"), ORIGINAL);
/** Oh My Pi's hook removed the signature after Magic Context cleaned an echoed tag. */
const hookCleaned = () =>
	codexReply({ type: "text", text: ORIGINAL }, `§41§ ${ORIGINAL}`);
/**
 * A Codex turn that keeps redacted thinking. Oh My Pi keeps that block for the
 * target model's own turn, so the dispatch projection cannot model it.
 */
function unmodeled() {
	const turn = codexReply(
		{
			type: "text",
			text: "Kept answer.",
			textSignature: JSON.stringify({
				v: 1,
				id: "msg_kept",
				phase: "final_answer",
			}),
		},
		"Kept answer.",
	);
	turn.timestamp = 2;
	turn.providerPayload.items[0].id = "msg_kept";
	turn.content.unshift({ type: "redactedThinking", data: "synthetic-kept" });
	return turn;
}

function request(reply: unknown, earlier?: unknown): any[] {
	return [
		user("first", 1),
		...(earlier ? [earlier] : []),
		user("second", 3),
		reply,
		user("next", 5),
	];
}

/** Replace the reply's text with the placeholder through the transcript, as a drop does. */
function drop(messages: any[]) {
	const index = messages.findIndex(
		(message) => message.timestamp === 4 && message.role === "assistant",
	);
	const transcript = createPiTranscript(messages, undefined);
	const part = transcript.messages[index].parts.find(
		(candidate) => candidate.kind === "text",
	);
	expect(part).toBeDefined();
	part?.setText(PLACEHOLDER);
	transcript.commit();
	return messages;
}

/** Send through an encoder and apply the dispatch checks in the hook's order. */
function dispatch(messages: unknown[], convert: any) {
	const before = JSON.stringify(messages);
	const prepared = preparePiDispatch(messages, model, true, "/work");
	expect(JSON.stringify(prepared.messages)).toBe(before);
	const input = convert(model, {
		systemPrompt: ["system"],
		messages: prepared.messages,
	});
	const skipped =
		!prepared.structure || !!prepared.structure.structuralSkipReason;
	return {
		input,
		prepared,
		skipped,
		bytes: JSON.stringify(input),
		refusal:
			prepared.nativeDrop ??
			(skipped
				? undefined
				: piPreparedStructureMismatch({ input }, prepared.structure)),
	};
}

for (const encoder of encoders) {
	describe(`${encoder.version} Codex lane`, () => {
		test("another model's redacted thinking is modeled, so the comparison runs", () => {
			__setPiHarnessKindForTesting("omp");
			const sent = dispatch(
				request(codexReply(signed("msg_c"), ORIGINAL), foreign()),
				encoder.convert,
			);
			expect(sent.skipped).toBe(false);
			expect(sent.refusal).toBeUndefined();
			expect(sent.bytes).not.toContain("synthetic-redacted");
		});

		test("redacted thinking that the target model's own turn keeps stays unmodeled", () => {
			__setPiHarnessKindForTesting("omp");
			const sent = dispatch(
				request(codexReply(signed("msg_c"), ORIGINAL), unmodeled()),
				encoder.convert,
			);
			expect(sent.prepared.structure?.structuralSkipReason).toBe(
				"Responses history transform is not modeled",
			);
			expect(sent.refusal).toBeUndefined();
		});

		test("an added request row is refused once redacted thinking is modeled", () => {
			__setPiHarnessKindForTesting("omp");
			const sent = dispatch(
				drop(request(hookCleaned(), foreign())),
				encoder.convert,
			);
			expect(sent.refusal).toBeUndefined();
			const input = [...sent.input, user("injected", 6)];
			expect(
				piPreparedStructureMismatch({ input }, sent.prepared.structure),
			).toBeDefined();
		});

		test("a dropped reply's original text is refused even when the comparison is skipped", () => {
			__setPiHarnessKindForTesting("omp");
			const sent = dispatch(
				drop(request(signedMismatch(), unmodeled())),
				encoder.convert,
			);
			expect(sent.skipped).toBe(true);
			expect(sent.bytes).toContain(ORIGINAL);
			expect(sent.refusal).toBe("message=3 comparison=native_drop");
		});

		test("a modeled request refuses the same stale text in both checks", () => {
			__setPiHarnessKindForTesting("omp");
			const sent = dispatch(drop(request(signedMismatch())), encoder.convert);
			expect(sent.bytes).toContain(ORIGINAL);
			expect(sent.refusal).toContain("comparison=native_drop");
			expect(
				piPreparedStructureMismatch(
					{ input: sent.input },
					sent.prepared.structure,
				),
			).toContain("comparison=content");
		});

		test("a hook-cleaned reply sends its placeholder and passes under the skip", () => {
			__setPiHarnessKindForTesting("omp");
			const sent = dispatch(
				drop(request(hookCleaned(), unmodeled())),
				encoder.convert,
			);
			expect(sent.skipped).toBe(true);
			expect(sent.bytes).toContain(PLACEHOLDER);
			expect(sent.bytes).not.toContain(ORIGINAL);
			expect(sent.refusal).toBeUndefined();
		});

		test("without positional pairing a signed drop is found by id and phase", () => {
			__setPiHarnessKindForTesting("omp");
			// An item kind the pairing does not model leaves only the signed lookup.
			const search = {
				type: "web_search_call",
				id: "ws_synthetic",
				status: "completed",
			};
			const mirrored = dispatch(
				drop(request(codexReply(signed("msg_c"), ORIGINAL, [search]))),
				encoder.convert,
			);
			expect(mirrored.prepared.nativeDrop).toBeUndefined();
			const stale = dispatch(
				drop(request(codexReply(signed("msg_other"), ORIGINAL, [search]))),
				encoder.convert,
			);
			expect(stale.prepared.nativeDrop).toBe(
				"message=2 comparison=native_drop",
			);
		});
	});
}

describe("blocks Oh My Pi drops from another model's turn", () => {
	for (const [kind, block] of Object.entries(droppedKinds)) {
		test(`${kind} is modeled as dropped by every pinned version`, () => {
			__setPiHarnessKindForTesting("omp");
			const messages = [user("first", 1), foreign(block), user("second", 3)];
			const check = (input: any[], target: unknown) => {
				const prepared = preparePiDispatch(messages, target as never, true);
				expect(prepared.structure?.structuralSkipReason).toBeUndefined();
				expect(
					piPreparedStructureMismatch({ input }, prepared.structure),
				).toBeUndefined();
				expect(
					piPreparedStructureMismatch(
						{ input: [...input, user("injected", 4)] },
						prepared.structure,
					),
				).toBeDefined();
				const assistant = input.filter((row) => row.role === "assistant");
				expect(
					assistant.map((row) => row.content.map((part: any) => part.text)),
				).toEqual([["Earlier answer."]]);
				expect(JSON.stringify(input)).not.toContain("synthetic");
			};
			for (const host of responsesHosts)
				check(
					host.build({
						model: responsesModel,
						context: { messages },
						strictResponsesPairing: false,
						supportsImageDetailOriginal: false,
						nativeHistory: { replay: true, filterReasoning: false },
					}),
					responsesModel,
				);
			for (const encoder of encoders)
				check(
					encoder.convert(model, { systemPrompt: ["system"], messages }),
					model,
				);
		});
	}

	test("Pi stays unmodeled for those blocks", () => {
		__setPiHarnessKindForTesting("pi");
		const prepared = preparePiDispatch(
			[user("first", 1), foreign(), user("second", 3)],
			model,
			false,
		);
		expect(prepared.structure?.structuralSkipReason).toBe(
			"Responses history transform is not modeled",
		);
	});
});

/** The refusal a dispatch hook returned: its payload throws the reason when read. */
function refusalText(refused: unknown): string | undefined {
	if (refused === undefined) return undefined;
	try {
		return JSON.stringify(refused);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

test("the dispatch hook refuses a drop that never reached its native item, under the skip", async () => {
	__setPiHarnessKindForTesting("omp");
	const raw = [
		user("first", 1),
		unmodeled(),
		user("second", 3),
		signedMismatch(),
		user("next", 5),
	];
	const sessionId = "codex-unmodeled-stale-drop";
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
		const input = encoders[1].convert(model, {
			systemPrompt: ["system"],
			messages: result.messages,
		});
		const refused = await (fake.handlers.get("before_provider_request") as any)(
			{ payload: { input } },
			ctx,
		);
		return { wire: JSON.stringify(input), refused: refusalText(refused) };
	};
	try {
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			injection: { injectionBudgetTokens: 10000 },
		});
		expect((await pass()).refused).toBeUndefined();
		const reply = getTagsBySession(db, sessionId).find(
			(tag) => tag.type === "message" && tag.messageId.startsWith("e3"),
		);
		expect(reply).toBeDefined();
		queuePendingOp(db, sessionId, reply?.tagNumber ?? -1, "drop");
		signalPiPendingMaterialization(sessionId, "user_flush");
		const stale = await pass();
		expect(stale.wire).toContain(ORIGINAL);
		expect(stale.refused).toContain("comparison=native_drop");
		// The drop is saved, so the next pass meets the same stale native item.
		expect((await pass()).refused).toContain("comparison=native_drop");
	} finally {
		clearContextHandlerSession(sessionId);
		await drainPiTagSnapshotSession(sessionId);
		db.close();
	}
});

test("a session with an unmodeled turn and no applied drop is never refused", async () => {
	__setPiHarnessKindForTesting("omp");
	const raw = [
		user("first", 1),
		unmodeled(),
		user("second", 3),
		// Neither reply is dropped: one whose native item the mirror could not
		// bind, one cleaned by Oh My Pi's hook.
		signedMismatch(),
		user("third", 5),
		{ ...hookCleaned(), timestamp: 6 },
		user("next", 7),
	];
	const sessionId = "codex-unmodeled-no-drop";
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
		// The structural comparison is skipped for this request, as intended.
		expect(
			preparePiDispatch(result.messages, model, true).structure
				?.structuralSkipReason,
		).toBe("Responses history transform is not modeled");
		const input = encoders[1].convert(model, {
			systemPrompt: ["system"],
			messages: result.messages,
		});
		return (fake.handlers.get("before_provider_request") as any)(
			{ payload: { input } },
			ctx,
		);
	};
	try {
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			injection: { injectionBudgetTokens: 10000 },
		});
		expect(await pass()).toBeUndefined();
		signalPiPendingMaterialization(sessionId, "user_flush");
		expect(await pass()).toBeUndefined();
		expect(await pass()).toBeUndefined();
		expect(aborted).toBe(false);
	} finally {
		clearContextHandlerSession(sessionId);
		await drainPiTagSnapshotSession(sessionId);
		db.close();
	}
});
