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
	piChainResponse,
	piExpandChainedRequest,
	piPreparedHistory,
} from "./pi-dispatch-chain";
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
const hosts: {
	version: string;
	build: (options: unknown) => any[];
	delta: (previous: unknown, items: unknown, current: unknown) => any[] | null;
	sanitize: (items: unknown[]) => any[] | undefined;
}[] = [];
for (const pin of pins) {
	const path = require.resolve(`${pin.alias}/package.json`).slice(0, -12);
	expect(require(`${path}package.json`).version).toBe(pin.version);
	const shared = await import(`${path}src/providers/openai-shared.ts`);
	hosts.push({
		version: pin.version,
		build: shared.buildResponsesInput,
		delta: shared.buildResponsesDeltaInput,
		sanitize: (await import(`${path}src/utils.ts`))
			.sanitizeOpenAIResponsesAssistantHistoryItemsForReplay,
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
// buildResponsesInput and the chain encoder read the catalog identity OMP
// attaches to models.
const hostModel = { ...model, identity: { class: "gpt" } };

const user = {
	role: "user",
	content: [
		{ type: "text", text: "Complete assignment: read f1.txt and f2.txt." },
	],
	attribution: "agent",
	timestamp: 1,
};

/**
 * A tool-call reply as OMP stores it: composite ids, the provider's own items
 * in providerPayload. `stored` lists the order of the stored call items by
 * index into `calls`; OMP takes content order from each item's
 * output_item.added event and stored order from its output_item.done event
 * (processResponsesStream, openai-responses.ts onOutputItemDone), so a
 * provider that finishes parallel calls out of order stores them reordered.
 */
function reply(
	timestamp: number,
	response: string,
	calls: string[],
	stored = calls.map((_, index) => index),
): any {
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
				...stored.map((index) => ({
					id: `fc_${response}_${index + 1}`,
					status: "completed",
					type: "function_call",
					call_id: calls[index],
					name: "read",
					arguments: JSON.stringify({ path: `f${index + 1}.txt` }),
				})),
			],
		},
	};
}

function result(
	timestamp: number,
	response: string,
	index: number,
	id: string,
) {
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
	// Parallel calls whose stored items are in the reverse of content order.
	"parallel calls stored out of order": [
		user,
		reply(2, "r1", ["call_a", "call_b"], [1, 0]),
		result(3, "r1", 1, "call_a"),
		result(4, "r1", 2, "call_b"),
	],
} as const;
type Case = keyof typeof histories;

/**
 * The Responses input OMP's openai-responses provider builds, with the options
 * it passes (openai-responses.ts:1804-1824 in 18.19.0 and 18.20.0, 1851-1872
 * in 18.20.3). `warm` is its native-history state for the session.
 */
function encode(
	host: (typeof hosts)[number],
	messages: unknown[],
	warm: boolean,
) {
	return host.build({
		model: hostModel,
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
const expectedWire: Record<
	Case,
	Record<"warm" | "cold", [string[], string[]]>
> = {
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
	// OMP replays the stored order; rebuilt from the message, content order.
	"parallel calls stored out of order": {
		warm: [
			["call_b", "call_a"],
			["call_a", "call_b"],
		],
		cold: [
			["call_a", "call_b"],
			["call_a", "call_b"],
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
				"parallel calls stored out of order",
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

// A chained continuation (previous_response_id) sends only what follows the
// response it continues. After a replayed turn with a reused id that is the
// appended renamed call, the renamed outputs and, across replies, the
// placeholder output. OMP computes it with buildResponsesDeltaInput against the
// previous request and the response's sanitized items (openai-responses.ts
// :1454-1479 in 18.19.0 and 18.20.0, :1500-1525 in 18.20.3).
const expectedDelta: Record<Case, unknown[]> = {
	"duplicates within one reply": [
		{
			type: "function_call",
			call_id: "call_0_dup1",
			name: "read",
			arguments: '{"path":"f2.txt"}',
		},
		{
			type: "function_call_output",
			call_id: "call_0",
			output: "contents r1 1",
		},
		{
			type: "function_call_output",
			call_id: "call_0_dup1",
			output: "contents r1 2",
		},
	],
	"duplicates across replies": [
		{
			type: "function_call_output",
			call_id: "call_0",
			output:
				"[No tool output recorded: the tool call was interrupted before it produced a result.]",
		},
		{
			type: "function_call",
			call_id: "call_0_dup1",
			name: "read",
			arguments: '{"path":"f2.txt"}',
		},
		{
			type: "function_call_output",
			call_id: "call_1",
			output: "contents r2 1",
		},
		{
			type: "function_call_output",
			call_id: "call_0_dup1",
			output: "contents r2 2",
		},
	],
	"unique ids": [
		{
			type: "function_call_output",
			call_id: "call_b",
			output: "contents r2 1",
		},
		{
			type: "function_call_output",
			call_id: "call_c",
			output: "contents r2 2",
		},
	],
	"parallel calls stored out of order": [
		{
			type: "function_call_output",
			call_id: "call_a",
			output: "contents r1 1",
		},
		{
			type: "function_call_output",
			call_id: "call_b",
			output: "contents r1 2",
		},
	],
};

/** The previous request, its response and the continuation OMP sends after it. */
function chained(host: (typeof hosts)[number], name: Case) {
	const history = histories[name] as readonly any[];
	const at = history.findLastIndex((message) => message.role === "assistant");
	const before = preparePiDispatch(
		structuredClone(history.slice(0, at)) as unknown[],
		model,
		true,
		"/work",
	);
	const current = prepare(name);
	const previousInput = encode(host, before.messages, true);
	const response = current.messages[at] as any;
	const delta = host.delta(
		{ input: previousInput },
		host.sanitize(structuredClone(response.providerPayload.items)),
		{ input: encode(host, current.messages, true) },
	);
	const recorded = piChainResponse(response);
	if (!recorded) throw new Error("fixture reply is not a continuation point");
	const anchor = {
		input: previousInput,
		prepared: piPreparedHistory(before.messages, hostModel)!,
		...recorded,
	};
	const expand = (input: unknown[]) =>
		piExpandChainedRequest(
			{ previous_response_id: recorded.responseId, input },
			{ previousResponseId: recorded.responseId, delta: input },
			anchor,
			piPreparedHistory(current.messages, hostModel),
			{ current: undefined, resend: false },
		);
	return { delta, current, expand };
}

for (const host of hosts)
	describe(`issue 931 chained continuation on OMP ${host.version}`, () => {
		for (const name of Object.keys(histories) as Case[])
			test(`${name}: the continuation OMP sends is admitted`, () => {
				const { delta, current, expand } = chained(host, name);
				expect(delta).toEqual(expectedDelta[name]);
				const expanded = expand(delta!);
				expect("refusal" in expanded ? expanded.refusal : undefined).toBe(
					undefined,
				);
				if ("payload" in expanded)
					expect(
						piPreparedStructureMismatch(expanded.payload, current.structure),
					).toBeUndefined();
			});

		for (const name of [
			"duplicates within one reply",
			"duplicates across replies",
			"unique ids",
			"parallel calls stored out of order",
		] as const)
			test(`${name}: any other continuation is still refused`, () => {
				const { delta, expand } = chained(host, name);
				const changes: ((items: any[]) => void)[] = [
					(items) => {
						items.at(-1).call_id = "call_9";
					},
					(items) => {
						items.at(-1).output = "other output";
					},
					(items) => {
						items.splice(0, 1);
					},
					(items) => {
						items.push({ ...items.at(-1) });
					},
				];
				for (const change of changes) {
					const items = structuredClone(delta!);
					change(items);
					const expanded = expand(items);
					expect("refusal" in expanded ? expanded.refusal : undefined).toBe(
						"delta differs from the prepared provider input tail",
					);
				}
			});
	});
