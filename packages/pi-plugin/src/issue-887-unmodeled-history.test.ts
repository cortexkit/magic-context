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
	piPreparedStructureMismatch,
	preparePiDispatch,
} from "./pi-dispatch-structure";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { createPiTranscript } from "./transcript-pi";

// The prepared-turn check compares a Responses request with Magic Context's
// projection of it only when it can model every assistant turn. One block it
// cannot model (here an Anthropic redactedThinking block kept from before a
// switch to Codex) skips the comparison for the whole request. Oh My Pi's Codex
// encoder still replays each same-model turn from its stored native items, so
// a drop that never reached the native item is sent as the original text.
// The `test.failing` cases record that hazard; they pass while it remains.
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
const aliases = ["omp-pi-ai-18132", "omp-pi-ai-18181"];
await pinOmpLoggerFiles(root, aliases);
const encoders: { version: string; convert: any }[] = [];
for (const [alias, version] of [
	["omp-pi-ai-18132", "18.13.2"],
	["omp-pi-ai-18181", "18.18.1"],
]) {
	const path = require.resolve(`${alias}/package.json`).slice(0, -12);
	expect(require(`${path}package.json`).version).toBe(version);
	encoders.push({
		version,
		convert: (await import(`${path}src/providers/openai-codex-responses.ts`))
			.convertCodexResponsesMessages,
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

const model = {
	id: "gpt-5",
	provider: "openai-codex",
	api: "openai-codex-responses",
	input: ["text"],
	identity: { class: "gpt" },
	compat: { supportsDeveloperRole: true, supportsImageDetailOriginal: false },
	supportsComputerUse: false,
};
const ORIGINAL = "Synthetic secret-shaped reply body.";
const PLACEHOLDER = "[dropped §42§]";
const user = (text: string, timestamp: number) => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp,
});

/** An Anthropic turn from before the switch to Codex, with redacted thinking. */
const foreign = {
	role: "assistant",
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-synthetic",
	stopReason: "stop",
	timestamp: 2,
	content: [
		{ type: "redactedThinking", data: "synthetic-redacted-payload" },
		{ type: "text", text: "Earlier answer." },
	],
};

/** A same-model Codex reply whose stored native item holds `nativeText`. */
function codexReply(typed: Record<string, unknown>, nativeText: string): any {
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
const signedMismatch = () =>
	codexReply(
		{
			type: "text",
			text: ORIGINAL,
			// The id the signature names is not the stored native item's id.
			textSignature: JSON.stringify({
				v: 1,
				id: "msg_other",
				phase: "final_answer",
			}),
		},
		ORIGINAL,
	);
const hookCleaned = () =>
	codexReply({ type: "text", text: ORIGINAL }, `§41§ ${ORIGINAL}`);

function request(reply: unknown, unmodeled: boolean): any[] {
	return [
		user("first", 1),
		...(unmodeled ? [foreign] : []),
		user("second", 3),
		reply,
		user("next", 5),
	];
}

/** Replace the reply's text with the placeholder through the transcript, then dispatch it. */
function dropAndSend(messages: any[], convert: any) {
	const index = messages.findIndex((message) => message.api === model.api);
	const transcript = createPiTranscript(messages, undefined);
	transcript.messages[index].parts[0].setText(PLACEHOLDER);
	transcript.commit();
	const prepared = preparePiDispatch(messages, model, true, "/work");
	const input = convert(model, {
		systemPrompt: ["system"],
		messages: prepared.messages,
	});
	return {
		input,
		prepared,
		bytes: JSON.stringify(input),
		mismatch: piPreparedStructureMismatch({ input }, prepared.structure),
	};
}

for (const encoder of encoders) {
	test(`${encoder.version}: one unmodeled turn skips the comparison for the whole request`, () => {
		__setPiHarnessKindForTesting("omp");
		const sent = dropAndSend(request(signedMismatch(), true), encoder.convert);
		expect(sent.prepared.structure?.structuralSkipReason).toBe(
			"Responses history transform is not modeled",
		);
		// The redacted block never reaches Codex; Oh My Pi drops it for a foreign model.
		expect(sent.bytes).not.toContain("synthetic-redacted-payload");
	});

	test(`${encoder.version}: a modeled request refuses a drop that never reached the native item`, () => {
		__setPiHarnessKindForTesting("omp");
		const sent = dropAndSend(request(signedMismatch(), false), encoder.convert);
		expect(sent.bytes).toContain(ORIGINAL);
		expect(sent.mismatch).toContain("comparison=content");
	});

	test.failing(`${encoder.version}: an unmodeled turn must not let a dropped reply's original text through`, () => {
		__setPiHarnessKindForTesting("omp");
		const sent = dropAndSend(request(signedMismatch(), true), encoder.convert);
		const leaked = sent.bytes.includes(ORIGINAL);
		expect(leaked && sent.mismatch === undefined).toBe(false);
	});

	test.failing(`${encoder.version}: an unmodeled turn must not admit an added request row`, () => {
		__setPiHarnessKindForTesting("omp");
		const sent = dropAndSend(request(hookCleaned(), true), encoder.convert);
		const input = [...sent.input, user("injected", 6)];
		expect(
			piPreparedStructureMismatch({ input }, sent.prepared.structure),
		).toBeDefined();
	});

	test(`${encoder.version}: a hook-cleaned reply sends its placeholder even when the comparison is skipped`, () => {
		__setPiHarnessKindForTesting("omp");
		const sent = dropAndSend(request(hookCleaned(), true), encoder.convert);
		expect(sent.prepared.structure?.structuralSkipReason).toBeDefined();
		expect(sent.bytes).toContain(PLACEHOLDER);
		expect(sent.bytes).not.toContain(ORIGINAL);
	});
}
