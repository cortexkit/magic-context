import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lkgContentFields } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	exerciseOmpLoggerFiles,
	pinOmpLoggerFiles,
} from "./__tests__/omp-log-files";
import {
	clearPiContextReceipt,
	registerPiGuardedContext,
} from "./pi-context-refusal";
import { piExpandChainedRequest, piPreparedHistory } from "./pi-dispatch-chain";
import {
	PI_OMP_STEERING_TEMPLATE,
	piOmpUserHistory,
} from "./pi-dispatch-omp-user";
import {
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext } from "./test-utils.test";

const parent = join(tmpdir(), "magic-context");
mkdirSync(parent, { recursive: true });
const root = createTestTempDirFromPath(join(parent, "omp-head-host-"));
const previous: Record<string, string | undefined> = {};
for (const key of [
	"HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
	"PI_CODING_AGENT_DIR",
	"MAGIC_CONTEXT_STORAGE_DIR",
]) {
	previous[key] = process.env[key];
	const path = join(root, key);
	process.env[key] = path;
	mkdirSync(path, { recursive: true });
}
const require = createRequire(import.meta.url);
const definitions = [
	{ version: "18.12.3", agent: "omp-coding-agent-1812", ai: "omp-pi-ai-1812" },
	{
		version: "18.12.6",
		agent: "omp-coding-agent-18126",
		ai: "omp-pi-ai-18126",
	},
];
const aliases = definitions.flatMap(({ agent, ai }) => [agent, ai]);
// Open OMP log files of this process as `<fd> <path>`. lsof's field output is
// used because its table pads columns to the widest row, so the same
// descriptor prints differently once other files are open.
const ompLogDescriptors = (): string[] => {
	if (process.platform !== "linux") return [];
	const fields = execFileSync(
		"lsof",
		["-nP", "-p", String(process.pid), "-F", "fn"],
		{ encoding: "utf8", windowsHide: true },
	).split("\n");
	const open: string[] = [];
	let fd = "";
	for (const field of fields) {
		if (field.startsWith("f")) fd = field.slice(1);
		else if (field.startsWith("n") && /omp\..*\.log/.test(field)) {
			open.push(`${fd} ${field.slice(1).replace(/ \(deleted\)$/, "")}`);
		}
	}
	return open;
};
// Another OMP fixture that ran earlier in this Bun process can leave its own
// log descriptor open after its temporary root is deleted. Only descriptors
// this file's pin opens are checked against this root.
const inheritedOmpLogs = new Set(ompLogDescriptors());
await pinOmpLoggerFiles(root, aliases);
const hosts = await Promise.all(
	definitions.map(async (definition) => {
		const path = (alias: string) =>
			require.resolve(`${alias}/package.json`).slice(0, -12);
		expect(require(`${path(definition.agent)}package.json`).version).toBe(
			definition.version,
		);
		expect(require(`${path(definition.ai)}package.json`).version).toBe(
			definition.version,
		);
		return {
			...definition,
			agentRoot: path(definition.agent),
			messages: await import(
				`${path(definition.agent)}src/session/messages.ts`
			),
			Runner: (
				await import(
					`${path(definition.agent)}src/extensibility/extensions/runner.ts`
				)
			).ExtensionRunner,
			codex: (
				await import(
					`${path(definition.ai)}src/providers/openai-codex-responses.ts`
				)
			).buildTransformedCodexRequestBody,
		};
	}),
);
await exerciseOmpLoggerFiles(aliases);
const descriptors =
	process.platform === "linux"
		? execFileSync("lsof", ["-nP", "-p", String(process.pid)], {
				encoding: "utf8",
				windowsHide: true,
			})
		: "";
const pinnedOmpLogs = ompLogDescriptors().filter(
	(line) => !inheritedOmpLogs.has(line),
);
if (process.platform === "linux") {
	expect(pinnedOmpLogs.length).toBeGreaterThan(0);
}
for (const line of pinnedOmpLogs) {
	expect(line).toContain(root);
	console.log("isolated OMP host descriptor:", line);
}
for (const line of descriptors.split("\n")) {
	expect(line).not.toMatch(/\/(?:context|store)\.db\b/);
}
afterAll(() => {
	__setPiHarnessKindForTesting(undefined);
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const model = {
	api: "openai-codex-responses",
	provider: "openai-codex",
	id: "gpt-5",
	input: ["text", "image"],
	compat: {},
	identity: { class: "gpt", model: "gpt-5" },
};
const user = (text: string, timestamp: number) => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp,
});
const pair = (timestamp: number) => [
	user("<session-history>managed</session-history>", timestamp - 2),
	user(
		"<session-history-since>(no new content since last materialization)</session-history-since>",
		timestamp - 1,
	),
];
const call = {
	type: "function_call",
	call_id: "call_1",
	id: "fc_1",
	name: "read",
	arguments: "{}",
};
const assistant = {
	role: "assistant",
	api: model.api,
	provider: model.provider,
	model: model.id,
	timestamp: 1001,
	stopReason: "toolUse",
	responseId: "resp_1",
	content: [
		{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: {} },
	],
	providerPayload: {
		type: "openaiResponsesHistory",
		provider: model.provider,
		dt: true,
		items: [call],
	},
};
const result = {
	role: "toolResult",
	toolCallId: "call_1|fc_1",
	toolName: "read",
	timestamp: 1002,
	content: [{ type: "text", text: "file body" }],
};

function harness(host: (typeof hosts)[number]) {
	__setPiHarnessKindForTesting("omp");
	const session = `omp-head-${host.version}`;
	const handlers = new Map();
	const refusals: string[] = [];
	let aborts = 0;
	let prepared: unknown[] = [];
	const ctx = { ...fakeContext(session), model, abort: () => aborts++ };
	registerPiGuardedContext(
		{
			on: (name: string, fn: unknown) => handlers.set(name, [fn]),
			appendEntry: (_: string, data: { message: string }) =>
				refusals.push(data.message),
		} as never,
		async () => ({ messages: prepared }) as never,
	);
	const runner = new host.Runner(
		[{ path: "managed", handlers }],
		{},
		root,
		{},
		{},
	);
	runner.createContext = () => ctx;
	runner.onError((error: unknown) => {
		throw new Error(JSON.stringify(error));
	});
	const emit = async (name: string, event: unknown = {}) => {
		for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
	};
	return {
		refusals,
		get aborts() {
			return aborts;
		},
		async pass(messages: unknown[]) {
			prepared = structuredClone(messages);
			const returned = await runner.emitContext(messages);
			// This is the SDK transformContext order: emitContext, then steering wrap.
			return host.messages.convertToLlm(
				host.messages.wrapSteeringForModel(returned),
			);
		},
		async start() {
			await emit("agent_start");
		},
		async respond() {
			await runner.emitAssistantMessage(structuredClone(assistant));
		},
		send: (payload: unknown) =>
			runner.emitBeforeProviderRequest(payload, model),
		close: () => clearPiContextReceipt(session),
	};
}

for (const host of hosts) {
	test(`${host.version}: injected timestamps are chain-only identity; defer bytes and m0/m1 text stay identical`, async () => {
		const h = harness(host);
		try {
			const before = [...pair(100), user("read", 1000)];
			const after = [...pair(533), user("read", 1000)];
			const beforeBytes = JSON.stringify(before);
			const afterBytes = JSON.stringify(after);
			const body = (messages: unknown[]) =>
				host.codex(
					model,
					{ messages, systemPrompt: "system" },
					undefined,
					"fixture-cache",
				);
			const expectedWire = JSON.stringify(await body(before));
			expect(JSON.stringify(await body(after))).toBe(expectedWire);
			piPreparedHistory(before, model);
			piPreparedHistory(after, model);
			expect(JSON.stringify(before)).toBe(beforeBytes);
			expect(JSON.stringify(after)).toBe(afterBytes);
			expect(before.slice(0, 2).map((row) => row.content)).toEqual(
				after.slice(0, 2).map((row) => row.content),
			);
			expect(JSON.stringify(await body(before))).toBe(expectedWire);
			expect(JSON.stringify(await body(after))).toBe(expectedWire);
			await h.start();
			const first = await body(await h.pass(before));
			await h.send(first);
			await h.respond();
			const next = await body(await h.pass([...after, assistant, result]));
			const delta = [
				{
					type: "function_call_output",
					call_id: "call_1",
					output: "file body",
				},
			];
			expect(next.input.at(-1)).toEqual(delta[0]);
			// Recreate the original prepared-history snapshots, which included every
			// timestamp, while retaining the real host's encoded provider request.
			const baseline = (messages: unknown[]) => {
				const prepared = piPreparedHistory(messages, model);
				if (!prepared) throw new Error("fixture history unavailable");
				return {
					...prepared,
					snapshots: messages.map((message) => {
						const fields = lkgContentFields(message);
						if (!fields) throw new Error("fixture snapshot unavailable");
						return { id: "", fields };
					}),
				};
			};
			expect(
				piExpandChainedRequest(
					{ input: delta },
					{ previousResponseId: "resp_1", delta },
					{
						input: first.input,
						prepared: baseline(before),
						responseId: "resp_1",
						responseItems: [call],
					},
					baseline([...after, assistant, result]),
					{ current: {}, resend: false },
				),
			).toEqual({
				refusal:
					"prepared history does not extend the previous managed request",
			});
			await h.send({
				...first,
				type: "response.create",
				previous_response_id: "resp_1",
				input: delta,
			});
			expect(h.refusals).toEqual([]);
			expect(h.aborts).toBe(0);
		} finally {
			h.close();
		}
	});
}

for (const host of hosts) {
	test(`${host.version}: steering template and SDK transform order remain pinned`, () => {
		expect(
			readFileSync(
				join(host.agentRoot, "src/prompts/steering/user-interjection.md"),
				"utf8",
			),
		).toBe(PI_OMP_STEERING_TEMPLATE);
		const sdk = readFileSync(join(host.agentRoot, "src/sdk.ts"), "utf8");
		expect(sdk).toMatch(
			/const withContext = await extensionRunner.emitContext\(messages, signal\);\s*return wrapSteeringForModel\(withContext\)/,
		);
	});
	test(`${host.version}: shared steering encoding matches the real host, including formatting and images`, async () => {
		const texts = [
			"redirect work",
			"",
			" ",
			"  first  \nsecond\t\n",
			"one\n\n\nthree",
			"<x>\n\nbody\n\n</x>",
			"| A | B |\n| :--- | ---: |\n| 1 | 2 |",
			"```\n| A | B |\n\n\n</x>\n```",
			"~~~\nbody\n~~~",
			"$& {{message}} <&> →",
		];
		for (const text of texts) {
			for (const content of [
				text,
				[
					{ type: "text", text },
					{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
					{ type: "text", text: "tail" },
				],
			]) {
				const raw = { role: "user", steering: true, content, timestamp: 1003 };
				const before = JSON.stringify(raw);
				expect(piOmpUserHistory(raw)).toEqual(
					host.messages.wrapSteeringForModel([raw])[0],
				);
				expect(JSON.stringify(raw)).toBe(before);
				const converted = host.messages.convertToLlm(
					host.messages.wrapSteeringForModel([raw]),
				);
				const full = await host.codex(
					model,
					{ messages: converted },
					undefined,
					"fixture-cache",
				);
				expect(
					piPreparedStructureMismatch(
						full,
						piPreparedStructure([raw], model, "omp"),
					),
				).toBeUndefined();
			}
		}
	});
	for (const steering of [false, true]) {
		test(`${host.version}: tool result plus ${steering ? "steering" : "ordinary"} user tail admits through the real runner and Codex converter`, async () => {
			const h = harness(host);
			try {
				const initial = [...pair(100), user("read", 1000)];
				const body = (messages: unknown[]) =>
					host.codex(
						model,
						{ messages, systemPrompt: "system" },
						undefined,
						"fixture-cache",
					);
				await h.start();
				const first = await body(await h.pass(initial));
				await h.send(first);
				await h.respond();
				const interjection = { ...user("change direction", 1003), steering };
				const messages = [...initial, assistant, result, interjection];
				const full = await body(await h.pass(messages));
				const tail = full.input.slice(-2);
				expect(tail[0]).toEqual({
					type: "function_call_output",
					call_id: "call_1",
					output: "file body",
				});
				expect(tail[1].content[0].text).toBe(
					steering
						? PI_OMP_STEERING_TEMPLATE.replace(
								"{{message}}",
								"change direction",
							).trimEnd()
						: "change direction",
				);
				expect(
					piPreparedStructureMismatch(
						full,
						piPreparedStructure(messages, model, "omp"),
					),
				).toBeUndefined();
				await h.send({
					...first,
					type: "response.create",
					previous_response_id: "resp_1",
					input: tail,
				});
				expect(h.refusals).toEqual([]);
				expect(h.aborts).toBe(0);
			} finally {
				h.close();
			}
		});
	}
	test(`${host.version}: a wrong steering envelope still refuses`, async () => {
		const h = harness(host);
		try {
			const initial = [...pair(100), user("read", 1000)];
			const body = (messages: unknown[]) =>
				host.codex(
					model,
					{ messages, systemPrompt: "system" },
					undefined,
					"fixture-cache",
				);
			await h.start();
			const first = await body(await h.pass(initial));
			await h.send(first);
			await h.respond();
			const full = await body(
				await h.pass([
					...initial,
					assistant,
					result,
					{ ...user("redirect", 1003), steering: true },
				]),
			);
			const tail = full.input.slice(-2);
			tail[1].content[0].text =
				"<system-notice>wrong envelope</system-notice>\nredirect";
			await h.send({
				...first,
				type: "response.create",
				previous_response_id: "resp_1",
				input: tail,
			});
			expect(h.aborts).toBe(1);
			expect(h.refusals[0]).toContain(
				"delta differs from the prepared provider input tail",
			);
		} finally {
			h.close();
		}
	});
}

test("plain Pi's user conversion leaves steering text raw", async () => {
	for (const alias of ["pi-coding-agent-087", "pi-coding-agent-130"]) {
		const path = require.resolve(`${alias}/package.json`).slice(0, -12);
		const { convertToLlm } = await import(`${path}dist/core/messages.js`);
		const raw = { ...user("plain Pi input", 1), steering: true };
		expect(convertToLlm([raw])[0]).toEqual(raw);
		const payload = {
			input: [
				{
					role: "user",
					content: [{ type: "input_text", text: "plain Pi input" }],
				},
			],
		};
		expect(
			piPreparedStructureMismatch(
				payload,
				piPreparedStructure([raw], { ...model, api: "openai-responses" }, "pi"),
			),
		).toBeUndefined();
	}
});

const STEERING_RANDOM_SEED = 0x79218126;
const STEERING_RANDOM_TEXTS = 1024;

function seededSteeringMessages(seed: number) {
	let state = seed >>> 0;
	const random = (bound: number) => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) % bound;
	};
	const whitespace = ["", " ", "  ", "\t", " \t", "\r", "\u00a0", "\u2003"];
	const endings = ["\n", "\r\n", "\r"];
	const lines = [
		"",
		" ",
		"\t",
		"plain text",
		"{{message}}",
		"$& $` $'",
		"雪 🐈 café",
		"\u200b",
		"<x>",
		'<x key="value">',
		"<X>",
		"<tag-name>",
		"<self/>",
		"</x>",
		"</X>",
		"</tag-name>",
		"</x >",
		'</x attr="v">',
		"| A | B |",
		"| :--- | ---: |",
		"| :---: | --- |",
		"| a\\|b | c |",
		"| |",
		"||",
		"```",
		"```ts",
		"~~~",
		"~~~md",
		"`inline`",
		"text\rinside",
		"\r```",
		"\r</x>",
	];
	const image = (index: number) => ({
		type: "image",
		data: `image-${index}`,
		mimeType: "image/png",
	});
	const messages: Record<string, unknown>[] = [];
	for (let index = 0; index < STEERING_RANDOM_TEXTS; index++) {
		const chunks: string[] = [];
		for (let count = 1 + random(14); count > 0; count--) {
			chunks.push(
				whitespace[random(whitespace.length)] +
					lines[random(lines.length)] +
					whitespace[random(whitespace.length)],
			);
			if (count > 1)
				chunks.push(endings[random(endings.length)].repeat(1 + random(4)));
		}
		const text = index % 32 === 0 ? "" : chunks.join("");
		messages.push({
			role: "user",
			steering: true,
			content: text,
			timestamp: index,
		});
		const split = random(text.length + 1);
		const content: unknown[] = [
			{ type: "text", text: text.slice(0, split) },
			{ type: "text", text: text.slice(split) },
		];
		content.splice(random(content.length + 1), 0, { type: "text", text: "" });
		content.splice(random(content.length + 1), 0, image(index));
		if (random(2))
			content.splice(random(content.length + 1), 0, image(index + 1));
		messages.push({ role: "user", steering: true, content, timestamp: index });
	}
	return messages;
}

for (const host of hosts) {
	test(`${host.version}: seeded steering formatter comparison (${STEERING_RANDOM_TEXTS} texts, seed=${STEERING_RANDOM_SEED.toString(16)})`, () => {
		const messages = seededSteeringMessages(STEERING_RANDOM_SEED);
		for (const [index, message] of messages.entries()) {
			const before = JSON.stringify(message);
			const expected = host.messages.wrapSteeringForModel([message])[0];
			expect(
				piOmpUserHistory(message),
				`seed=${STEERING_RANDOM_SEED.toString(16)} message=${index} input=${before}`,
			).toEqual(expected);
			expect(JSON.stringify(message)).toBe(before);
		}
		console.log(
			`OMP ${host.version} seed=${STEERING_RANDOM_SEED.toString(16)}: ${STEERING_RANDOM_TEXTS} generated texts, ${messages.length} string/multipart comparisons`,
		);
	});
}
