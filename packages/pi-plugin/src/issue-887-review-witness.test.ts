import { afterAll, expect, test } from "bun:test";
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
	signalPiPendingMaterialization,
} from "./context-handler";
import {
	piPreparedStructureMismatch,
	preparePiDispatch,
} from "./pi-dispatch-structure";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { drainPiTagSnapshotSession } from "./tag-snapshot-pi";
import { createFakePi, createTestDb, fakeContext } from "./test-utils.test";

// Oh My Pi stores a generated image twice: as an `image` block in the typed
// content and as an `image_generation_call` item in the native Responses
// history. A same-model turn is replayed from the native items, so the request
// carries the image_generation_call item. Modeling the `image` block as dropped
// must not turn such an ordinary turn, with no drop at all, into a refusal.
const { dir: root, cleanup } = createTestTempDir("mc-887-image-turn-");
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
const aliases = ["omp-pi-ai-18181"];
await pinOmpLoggerFiles(root, aliases);
const path = require.resolve("omp-pi-ai-18181/package.json").slice(0, -12);
expect(require(`${path}package.json`).version).toBe("18.18.1");
const { convertCodexResponsesMessages } = await import(
	`${path}src/providers/openai-codex-responses.ts`
);
const { buildResponsesInput } = await import(
	`${path}src/providers/openai-shared.ts`
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

const codex = {
	id: "gpt-5",
	provider: "openai-codex",
	api: "openai-codex-responses",
	input: ["text"],
	identity: { class: "gpt" },
	compat: { supportsDeveloperRole: true, supportsImageDetailOriginal: false },
	supportsComputerUse: false,
};
const responses = {
	id: "gpt-5",
	provider: "openai",
	api: "openai-responses",
	input: ["text"],
	identity: { class: "gpt", model: "gpt-5" },
	compat: {},
};
const IMAGE = "c3ludGhldGlj";
const user = (text: string, timestamp: number) => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp,
});

/** A same-model turn in which the model generated an image, as Oh My Pi stores it. */
function imageTurn(model: typeof codex | typeof responses, text: string) {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: 2,
		content: [
			{
				type: "text",
				text,
				textSignature: JSON.stringify({
					v: 1,
					id: "msg_c",
					phase: "final_answer",
				}),
			},
			{ type: "image", data: IMAGE, mimeType: "image/png" },
		],
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: model.provider,
			dt: true,
			items: [
				{
					type: "image_generation_call",
					id: "ig_synthetic",
					status: "completed",
					result: IMAGE,
				},
				{
					type: "message",
					id: "msg_c",
					role: "assistant",
					status: "completed",
					phase: "final_answer",
					content: [
						{ type: "output_text", text: "Here it is.", annotations: [] },
					],
				},
			],
		},
	};
}

/** The dispatch checks in the hook's order: the native-drop check, then the turn comparison. */
function refusal(messages: unknown[], model: any, input: unknown[]) {
	const prepared = preparePiDispatch(messages, model, true, "/work");
	if (prepared.nativeDrop) return prepared.nativeDrop;
	if (!prepared.structure || prepared.structure.structuralSkipReason)
		return undefined;
	return piPreparedStructureMismatch({ input }, prepared.structure);
}

for (const [lane, model, encode] of [
	[
		"Codex",
		codex,
		(messages: unknown[]) =>
			convertCodexResponsesMessages(codex, {
				systemPrompt: ["system"],
				messages,
			}),
	],
	[
		"OpenAI Responses",
		responses,
		(messages: unknown[]) =>
			buildResponsesInput({
				model: responses,
				context: { messages },
				strictResponsesPairing: false,
				supportsImageDetailOriginal: false,
				nativeHistory: { replay: true, filterReasoning: false },
			}),
	],
] as const) {
	test(`${lane}: a same-model turn that generated an image, with no drop, is admitted`, () => {
		__setPiHarnessKindForTesting("omp");
		// The tagged text Magic Context prepares, beside the native item's own text.
		const messages = [
			user("§1§ Draw a cat.", 1),
			imageTurn(model, "§2§ Here it is."),
			user("§3§ Thanks.", 3),
		];
		const input = (encode as (messages: unknown[]) => unknown[])(messages);
		// Oh My Pi replays the turn from its native items, image call included.
		expect(JSON.stringify(input)).toContain('"type":"image_generation_call"');
		expect(refusal(messages, model, input)).toBeUndefined();
	});
}

test("a Codex session with an image turn and no drop is never refused by the dispatch hook", async () => {
	__setPiHarnessKindForTesting("omp");
	const raw = [
		user("Draw a cat.", 1),
		imageTurn(codex, "Here it is."),
		user("Thanks.", 3),
	];
	const sessionId = "codex-image-turn-no-drop";
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
			model: codex,
			abort: () => {},
		};
		const result = await (fake.handlers.get("context") as any)(
			{ messages },
			ctx,
		);
		expect(result?.messages).toBeDefined();
		const input = convertCodexResponsesMessages(codex, {
			systemPrompt: ["system"],
			messages: result.messages,
		});
		const refused = await (fake.handlers.get("before_provider_request") as any)(
			{ payload: { input } },
			ctx,
		);
		if (refused === undefined) return undefined;
		try {
			return JSON.stringify(refused);
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
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
	} finally {
		clearContextHandlerSession(sessionId);
		await drainPiTagSnapshotSession(sessionId);
		db.close();
	}
});
