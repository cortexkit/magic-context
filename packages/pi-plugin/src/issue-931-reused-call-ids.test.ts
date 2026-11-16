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
	piPreparedStructureMismatch,
	preparePiDispatch,
} from "./pi-dispatch-structure";

// Issue 931: a provider that reuses a tool-call id. Oh My Pi renames the later
// call in the message (call_0 -> call_0_dup1), but when it replays a turn's
// stored Responses output items it sends their original ids, appends the
// renamed call, and gives a stored call left without an output a placeholder
// output. These tests encode requests with the real buildResponsesInput of
// every pinned release and check the dispatch fence against them. The message
// shapes are those of a real OMP 18.20.0 task child (session file of the
// reproduction, mock openai-responses provider).
const { dir: root, cleanup } = createTestTempDir("mc-issue-931-");
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
const pins = [
	{ alias: "omp-pi-ai-18190", version: "18.19.0" },
	{ alias: "omp-pi-ai-18200", version: "18.20.0" },
	{ alias: "omp-pi-ai-18203", version: "18.20.3" },
] as const;
await pinOmpLoggerFiles(
	root,
	pins.map((pin) => pin.alias),
);
const hosts: { version: string; build: (options: unknown) => any[] }[] = [];
for (const pin of pins) {
	const path = require.resolve(`${pin.alias}/package.json`).slice(0, -12);
	expect(require(`${path}package.json`).version).toBe(pin.version);
	hosts.push({
		version: pin.version,
		build: (await import(`${path}src/providers/openai-shared.ts`))
			.buildResponsesInput,
	});
}
await exerciseOmpLoggerFiles(pins.map((pin) => pin.alias));
reportOmpLogDescriptors();
afterAll(() => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	cleanup();
});

const model = {
	api: "openai-responses",
	provider: "mock",
	id: "mock-model",
	input: ["text"],
	compat: {},
};

const user = {
	role: "user",
	content: [{ type: "text", text: "Complete assignment: read f1.txt and f2.txt." }],
	attribution: "agent",
	timestamp: 1,
};

/** A tool-call reply as OMP stores it: composite ids, the provider's own items in providerPayload. */
function reply(timestamp: number, response: string, calls: string[]): any {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "toolUse",
		responseId: `resp_${response}`,
		timestamp,
		content: [
			{ type: "thinking", thinking: "", summary: false },
			...calls.map((id, index) => ({
				type: "toolCall",
				id: `${id}|fc_${response}_${index + 1}`,
				name: "read",
				arguments: { path: `f${index + 1}.txt` },
			})),
		],
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: model.provider,
			dt: true,
			items: [
				{
					id: `rs_${response}`,
					status: "completed",
					type: "reasoning",
					summary: [],
					encrypted_content: `enc-${response}`,
				},
				...calls.map((id, index) => ({
					id: `fc_${response}_${index + 1}`,
					status: "completed",
					type: "function_call",
					call_id: id,
					name: "read",
					arguments: JSON.stringify({ path: `f${index + 1}.txt` }),
				})),
			],
		},
	};
}

function result(timestamp: number, response: string, index: number, id: string) {
	return {
		role: "toolResult",
		toolCallId: `${id}|fc_${response}_${index}`,
		toolName: "read",
		content: [{ type: "text", text: `contents ${response} ${index}` }],
		isError: false,
		timestamp,
	};
}

const histories = {
	// One reply whose two calls share an id.
	"duplicates within one reply": [
		user,
		reply(2, "r1", ["call_0", "call_0"]),
		result(3, "r1", 1, "call_0"),
		result(4, "r1", 2, "call_0"),
	],
	// A later reply reuses an earlier reply's id.
	"duplicates across replies": [
		user,
		reply(2, "r1", ["call_0"]),
		result(3, "r1", 1, "call_0"),
		reply(4, "r2", ["call_1", "call_0"]),
		result(5, "r2", 1, "call_1"),
		result(6, "r2", 2, "call_0"),
	],
	"unique ids": [
		user,
		reply(2, "r1", ["call_a"]),
		result(3, "r1", 1, "call_a"),
		reply(4, "r2", ["call_b", "call_c"]),
		result(5, "r2", 1, "call_b"),
		result(6, "r2", 2, "call_c"),
	],
} as const;
type Case = keyof typeof histories;

/**
 * The Responses input OMP's openai-responses provider builds, with the options
 * it passes (openai-responses.ts:1804-1824 in 18.19.0 and 18.20.0, 1851-1871
 * in 18.20.3). `warm` is its native-history state for the session.
 */
function encode(host: (typeof hosts)[number], messages: unknown[], warm: boolean) {
	return host.build({
		// buildResponsesInput reads the catalog identity OMP attaches to models.
		model: { ...model, identity: { class: "gpt" } },
		context: { systemPrompt: ["system"], messages },
		strictResponsesPairing: false,
		supportsImageDetailOriginal: false,
		nativeHistory: { replay: warm, filterReasoning: false },
		includeThinkingSignatures: warm,
		repairOrphanOutputs: true,
	});
}

function prepare(name: Case) {
	const messages = structuredClone(histories[name]) as unknown[];
	return preparePiDispatch(messages, model, true, "/work");
}

const calls = (input: any[]) =>
	input
		.filter((item) => item.type === "function_call")
		.map((item) => item.call_id);
const outputs = (input: any[]) =>
	input
		.filter((item) => item.type === "function_call_output")
		.map((item) => item.call_id);

// OMP's own wire, per release: these pin the behaviour the fence must model.
const expectedWire: Record<Case, Record<"warm" | "cold", [string[], string[]]>> = {
	"duplicates within one reply": {
		warm: [
			["call_0", "call_0", "call_0_dup1"],
			["call_0", "call_0_dup1"],
		],
		cold: [
			["call_0", "call_0_dup1"],
			["call_0", "call_0_dup1"],
		],
	},
	"duplicates across replies": {
		// The second reply's stored call_0 has no later output of its own, so
		// OMP adds a placeholder output for it.
		warm: [
			["call_0", "call_1", "call_0", "call_0_dup1"],
			["call_0", "call_0", "call_1", "call_0_dup1"],
		],
		cold: [
			["call_0", "call_1", "call_0_dup1"],
			["call_0", "call_1", "call_0_dup1"],
		],
	},
	"unique ids": {
		warm: [
			["call_a", "call_b", "call_c"],
			["call_a", "call_b", "call_c"],
		],
		cold: [
			["call_a", "call_b", "call_c"],
			["call_a", "call_b", "call_c"],
		],
	},
};

for (const host of hosts)
	describe(`issue 931 on OMP ${host.version}`, () => {
		for (const name of Object.keys(histories) as Case[])
			for (const state of ["warm", "cold"] as const) {
				test(`${name}: the ${state} native-history request is admitted`, () => {
					const prepared = prepare(name);
					const input = encode(host, prepared.messages, state === "warm");
					expect([calls(input), outputs(input)]).toEqual(
						expectedWire[name][state],
					);
					expect(
						piPreparedStructureMismatch({ input }, prepared.structure),
					).toBeUndefined();
				});
			}

		test("unique ids keep the rebuilt layout and add no alternative plans", () => {
			const prepared = prepare("unique ids");
			expect(prepared.structure?.responsesAlternatives).toBeUndefined();
			expect(
				prepared.structure?.responsesMessages?.map((row) => [
					row.role,
					row.calls,
					row.results,
				]),
			).toEqual([
				["user", [], []],
				["assistant", ["call_a|fc_r1_1"], []],
				["toolResult", [], ["call_a|fc_r1_1"]],
				["assistant", ["call_b|fc_r2_1", "call_c|fc_r2_2"], []],
				["toolResult", [], ["call_b|fc_r2_1"]],
				["toolResult", [], ["call_c|fc_r2_2"]],
			]);
		});

		test("a changed call id after the replayed ones is still refused", () => {
			for (const name of [
				"duplicates within one reply",
				"duplicates across replies",
			] as const) {
				const prepared = prepare(name);
				const input = encode(host, prepared.messages, true);
				const renamed = input.findLast(
					(item: any) => item.type === "function_call",
				);
				renamed.call_id = "call_9";
				expect(
					piPreparedStructureMismatch({ input }, prepared.structure),
				).toContain("comparison=call id");
			}
		});

		test("a missing placeholder output is still refused", () => {
			const prepared = prepare("duplicates across replies");
			const input = encode(host, prepared.messages, true);
			const placeholder = input.findIndex(
				(item: any) =>
					item.type === "function_call_output" &&
					String(item.output).startsWith("[No tool output recorded"),
			);
			expect(placeholder).toBeGreaterThan(0);
			input.splice(placeholder, 1);
			expect(
				piPreparedStructureMismatch({ input }, prepared.structure),
			).toContain("expectedRows=");
		});

		test("a stored call the prepared turn does not have is still refused", () => {
			const prepared = prepare("duplicates within one reply");
			const input = encode(host, prepared.messages, true);
			const at = input.findIndex((item: any) => item.type === "function_call");
			input.splice(at, 0, { ...input[at], call_id: "call_extra" });
			expect(
				piPreparedStructureMismatch({ input }, prepared.structure),
			).toBeDefined();
		});
	});
