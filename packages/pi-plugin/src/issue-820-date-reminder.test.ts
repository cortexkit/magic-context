import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupTestTempDir,
	createTestTempDirFromPath,
} from "@magic-context/core/shared/test-temp-dir";
import {
	exerciseOmpLoggerFiles,
	pinOmpLoggerFiles,
	reportOmpLogDescriptors,
} from "./__tests__/omp-log-files";
import {
	piPreparedStructure,
	piPreparedStructureMismatch,
	preparePiDispatch,
} from "./pi-dispatch-structure";

const parent = join(tmpdir(), "magic-context", "issue-820");
mkdirSync(parent, { recursive: true });
const root = createTestTempDirFromPath(join(parent, "date-reminder-"));
const environment = Object.fromEntries(
	[
		"HOME",
		"XDG_CONFIG_HOME",
		"XDG_DATA_HOME",
		"XDG_CACHE_HOME",
		"XDG_STATE_HOME",
		"XDG_RUNTIME_DIR",
		"MAGIC_CONTEXT_STORAGE_DIR",
		"PI_CODING_AGENT_DIR",
	].map((key) => [key, join(root, key)]),
);
const previous = Object.fromEntries(
	Object.keys(environment).map((key) => [key, process.env[key]]),
);
for (const [key, value] of Object.entries(environment)) {
	mkdirSync(value, { recursive: true });
	process.env[key] = value;
}
const require = createRequire(import.meta.url);
const agents = [
	"omp-coding-agent-1812",
	"omp-coding-agent-18126",
	"omp-coding-agent-18132",
];
const ais = [
	"omp-pi-ai-171",
	"omp-pi-ai-1889",
	"omp-pi-ai-1811",
	"omp-pi-ai-1812",
	"omp-pi-ai-18126",
	"omp-pi-ai-1813",
	"omp-pi-ai-18132",
];
await pinOmpLoggerFiles(root, [...agents, ...ais]);
const hosts = await Promise.all(
	agents.map(async (alias) => {
		const path = require.resolve(`${alias}/package.json`).slice(0, -12);
		return {
			version: require(`${path}package.json`).version,
			...(await import(`${path}src/session/date-cwd-reminder.ts`)),
		};
	}),
);
const converters = await Promise.all(
	ais.map(async (alias) => {
		const path = require.resolve(`${alias}/package.json`).slice(0, -12);
		return {
			version: require(`${path}package.json`).version,
			convert: (await import(`${path}src/providers/anthropic.ts`))
				.convertAnthropicMessages,
		};
	}),
);
const otherConverters = await Promise.all(
	ais.map(async (alias) => {
		const path = require.resolve(`${alias}/package.json`).slice(0, -12);
		return {
			version: require(`${path}package.json`).version,
			chat: (await import(`${path}src/providers/openai-completions.ts`))
				.convertMessages,
			responses: (await import(`${path}src/providers/openai-shared.ts`))
				.buildResponsesInput,
			google: (await import(`${path}src/providers/google-shared.ts`))
				.convertMessages,
		};
	}),
);
await exerciseOmpLoggerFiles([...agents, ...ais]);
reportOmpLogDescriptors();
afterAll(() => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	cleanupTestTempDir(root);
});

const cwd = "/work/project";
function history() {
	return [
		{
			role: "user",
			content: "Run the long task.",
			timestamp: 1,
			attribution: "user",
		},
		{
			role: "assistant",
			api: "anthropic-messages",
			provider: "example",
			model: "claude-example",
			stopReason: "toolUse",
			timestamp: 2,
			content: [
				{ type: "toolCall", id: "toolu_example", name: "wait", arguments: {} },
			],
		},
		{
			role: "toolResult",
			toolCallId: "toolu_example",
			toolName: "wait",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 3,
		},
	];
}
const model = (upgrade: boolean) => ({
	api: "anthropic-messages",
	provider: "example",
	id: "claude-example",
	input: ["text"],
	compat: { supportsMidConversationSystem: upgrade },
});
const payload = (
	convert: (...args: any[]) => any,
	messages: unknown[],
	target: unknown,
) => ({
	model: "claude-example",
	max_tokens: 1024,
	system: [{ type: "text", text: "system" }],
	messages: convert(messages, target, false),
});

for (const host of hosts) {
	for (const converter of converters) {
		for (const upgrade of [false, true]) {
			test(`issue 820: injector ${host.version}, converter ${converter.version}, system=${upgrade} admits rollover and anchored replay without changing prepared bytes`, () => {
				const injector = new host.DateCwdReminderInjector();
				const target = model(upgrade);
				const messages: any[] = history();
				const request = (turns: any[], date: string) => {
					const before = JSON.stringify(turns);
					const prepared = preparePiDispatch(turns, target, true, cwd);
					expect(JSON.stringify(prepared.messages)).toBe(before);
					const sent = injector.transform(
						{ systemPrompt: ["system"], messages: prepared.messages },
						date,
						cwd,
					).messages;
					const wire = payload(converter.convert, sent, target);
					const bytes = JSON.stringify(wire);
					expect(
						piPreparedStructureMismatch(wire, prepared.structure),
					).toBeUndefined();
					expect(JSON.stringify(wire)).toBe(bytes);
					expect(JSON.stringify(turns)).toBe(before);
					return { wire, prepared };
				};
				request(messages.slice(0, 2), "2026-01-01");
				const first = request(messages, "2026-01-02");
				expect(first.wire.messages.at(-1).role).toBe(
					upgrade ? "system" : "user",
				);
				expect(first.wire.messages.at(-1).content).toBe(
					"<system-reminder>\nToday: 2026-01-02; current working directory: '/work/project'. Do not repeat this information in your reply.\n</system-reminder>",
				);
				request(messages, "2026-01-03");
				messages.push({
					role: "developer",
					content: "Continue.",
					timestamp: 4,
					attribution: "agent",
					synthetic: true,
				});
				request(messages, "2026-01-03");
				messages.push({
					role: "user",
					content: "Any progress?",
					timestamp: 5,
					attribution: "user",
				});
				request(messages, "2026-01-03");
				request(messages, "2026-01-04");
			});
		}
	}
}

test("issue 820: every non-template extra row, illegal position/role, and real-row mismatch refuses", () => {
	const host = hosts[0];
	const converter = converters.at(-1)!;
	for (const upgrade of [false, true]) {
		const target = model(upgrade);
		const messages = history();
		const injector = new host.DateCwdReminderInjector();
		injector.transform(
			{ systemPrompt: ["system"], messages: messages.slice(0, 2) },
			"2026-01-01",
			cwd,
		);
		const sent = injector.transform(
			{ systemPrompt: ["system"], messages },
			"2026-01-02",
			cwd,
		).messages;
		const wire = payload(converter.convert, sent, target);
		const plan = preparePiDispatch(messages, target, true, cwd).structure;
		for (const change of [
			(row: any) => {
				row.content += "\nextra";
			},
			(row: any) => {
				row.content = row.content.replace("2026-01-02", "2026-02-30");
			},
			(row: any) => {
				row.content = row.content.replace(cwd, "/other/project");
			},
			(row: any) => {
				row.content = row.content.replace(cwd, "/work/§123§");
			},
			(row: any) => {
				row.content = row.content.replace("Today:", "Date:");
			},
			(row: any) => {
				row.content = [
					{ type: "text", text: row.content },
					{ type: "text", text: "extra" },
				];
			},
			(row: any) => {
				row.content = [{ type: "text", text: row.content, extra: "unmanaged" }];
			},
			(row: any) => {
				row.role = "developer";
			},
			(row: any) => {
				row.role = upgrade ? "user" : "system";
			},
		]) {
			const altered = structuredClone(wire);
			change(altered.messages.at(-1));
			expect(piPreparedStructureMismatch(altered, plan)).toBeDefined();
		}
		const leading = structuredClone(wire);
		const reminder = leading.messages.pop();
		reminder.role = "user";
		leading.messages.unshift(reminder);
		expect(piPreparedStructureMismatch(leading, plan)).toBeDefined();
		leading.messages[0].role = "system";
		expect(piPreparedStructureMismatch(leading, plan)).toBeDefined();
		const cached = structuredClone(wire);
		cached.messages.at(-1).content = [
			{
				type: "text",
				text: cached.messages.at(-1).content,
				cache_control: { type: "ephemeral", ttl: "1h" },
			},
		];
		expect(piPreparedStructureMismatch(cached, plan)).toBeUndefined();
		const altered = structuredClone(wire);
		altered.messages[1].content[0].id = "toolu_wrong";
		expect(piPreparedStructureMismatch(altered, plan)).toContain(
			"comparison=call id",
		);
		expect(
			piPreparedStructureMismatch(
				wire,
				piPreparedStructure(messages, target, "pi"),
			),
		).toBeDefined();
	}
});

test("issue 820: controls retain legal user/assistant anchors and recompute developer promotion and pads", () => {
	const host = hosts[0];
	const converter = converters[3];
	const target = model(true);
	const user = { role: "user", content: "hello", timestamp: 1 };
	const assistant = {
		role: "assistant",
		api: target.api,
		provider: target.provider,
		model: target.id,
		timestamp: 2,
		stopReason: "stop",
		content: [{ type: "text", text: "working" }],
	};
	for (const tail of [
		[],
		[assistant],
		[
			{
				role: "developer",
				content: "Continue.",
				synthetic: true,
				timestamp: 2,
			},
		],
	]) {
		const messages = [user, ...tail];
		const injector = new host.DateCwdReminderInjector();
		injector.transform(
			{ systemPrompt: ["system"], messages },
			"2026-01-01",
			cwd,
		);
		injector.transform(
			{ systemPrompt: ["system"], messages },
			"2026-01-02",
			cwd,
		);
		messages.push({ ...assistant, timestamp: 3 });
		const sent = injector.transform(
			{ systemPrompt: ["system"], messages },
			"2026-01-02",
			cwd,
		).messages;
		const prepared = preparePiDispatch(messages, target, true, cwd);
		expect(
			piPreparedStructureMismatch(
				payload(converter.convert, sent, target),
				prepared.structure,
			),
		).toBeUndefined();
	}
});

for (const converter of otherConverters) {
	for (const api of [
		"openai-completions",
		"openai-responses",
		"azure-openai-responses",
		"openai-codex-responses",
		"google-generative-ai",
		"google-vertex",
		"google-gemini-cli",
	]) {
		test(`issue 820: ${converter.version} ${api} real developer serialization admits only the date control`, () => {
			const messages = [
				{ role: "user", content: "hello", timestamp: 1 },
				{
					role: "assistant",
					api,
					provider: "example",
					model: "example",
					stopReason: "stop",
					timestamp: 2,
					content: [{ type: "text", text: "working" }],
				},
			];
			const injector = new hosts[0].DateCwdReminderInjector();
			const context = { systemPrompt: ["system"], messages };
			injector.transform(context, "2026-01-01", cwd);
			const sent = injector.transform(context, "2026-01-02", cwd);
			const target = {
				api,
				provider: "example",
				id: "example",
				input: ["text"],
				identity: { class: "gpt" },
				compat: { supportsDeveloperRole: true },
			};
			const prepared = preparePiDispatch(messages, target, true, cwd);
			const encode = (ctx: unknown) =>
				api.startsWith("google-")
					? { contents: converter.google(target, ctx) }
					: api.endsWith("responses")
						? {
								input: converter.responses({
									model: target,
									context: ctx,
									strictResponsesPairing: false,
									supportsImageDetailOriginal: false,
									nativeHistory: { replay: true, filterReasoning: false },
								}),
							}
						: { messages: converter.chat(target, ctx, target.compat) };
			const wire = encode(sent);
			expect(
				piPreparedStructureMismatch(wire, prepared.structure),
			).toBeUndefined();
			expect(JSON.stringify(prepared.messages)).toBe(JSON.stringify(messages));
			const field = api.startsWith("google-")
				? "contents"
				: api.endsWith("responses")
					? "input"
					: "messages";
			const altered = structuredClone(wire) as Record<string, any[]>;
			altered[field].push({
				role: "user",
				content: "other extra row",
				parts: [{ text: "other extra row" }],
			});
			expect(
				piPreparedStructureMismatch(altered, prepared.structure),
			).toBeDefined();
		});
	}
}

test("issue 820: a date control preserves the existing oldest-image trim allowance", () => {
	const target = { ...model(false), input: ["text", "image"] };
	const messages = [
		{
			role: "user",
			timestamp: 1,
			content: [
				{ type: "text", text: "hello" },
				{ type: "image", data: "image-0", mimeType: "image/png" },
			],
		},
		{
			role: "assistant",
			timestamp: 2,
			api: target.api,
			provider: target.provider,
			model: target.id,
			stopReason: "stop",
			content: [{ type: "text", text: "working" }],
		},
	];
	const injector = new hosts[0].DateCwdReminderInjector();
	const context = { systemPrompt: ["system"], messages };
	injector.transform(context, "2026-01-01", cwd);
	const sent = injector.transform(context, "2026-01-02", cwd);
	const prepared = preparePiDispatch(messages, target, true, cwd);
	const wire = payload(converters[3].convert, sent.messages, target);
	wire.messages[0].content = wire.messages[0].content.filter(
		(part: { type: string }) => part.type !== "image",
	);
	const trimmed: unknown[] = [];
	expect(
		piPreparedStructureMismatch(wire, prepared.structure, (counts) =>
			trimmed.push(counts),
		),
	).toBeUndefined();
	expect(trimmed).toEqual([{ planned: 1, actual: 0, trimmed: 1 }]);
});

for (const api of [
	"openai-completions",
	"openai-responses",
	"google-generative-ai",
]) {
	for (const hasUser of [false, true]) {
		test(`issue 820: ${api} refuses a control before the first real user, present=${hasUser}`, () => {
			const converter = otherConverters[otherConverters.length - 1];
			const target = {
				api,
				provider: "example",
				id: "example",
				input: ["text"],
				identity: { class: "gpt" },
				compat: { supportsDeveloperRole: false },
			};
			const prefix = [
				{
					role: "assistant",
					api,
					provider: target.provider,
					model: target.id,
					timestamp: 1,
					stopReason: "stop",
					content: [{ type: "text", text: "working" }],
				},
				{ role: "developer", content: "agent preface", timestamp: 2 },
			];
			const tail = hasUser
				? [{ role: "user", content: "first real user", timestamp: 3 }]
				: [];
			const messages = [...prefix, ...tail];
			const encode = (turns: unknown[]) => {
				const context = { messages: turns };
				return api.startsWith("google-")
					? { contents: converter.google(target, context) }
					: api.endsWith("responses")
						? {
								input: converter.responses({
									model: target,
									context,
									strictResponsesPairing: false,
									supportsImageDetailOriginal: false,
								}),
							}
						: { messages: converter.chat(target, context, target.compat) };
			};
			const plan = preparePiDispatch(messages, target, true, cwd).structure;
			expect(
				piPreparedStructureMismatch(encode(messages), plan),
			).toBeUndefined();
			const invalid = encode([
				...prefix,
				{
					role: "developer",
					content: hosts[0].renderDateCwdReminder("2026-01-02", cwd),
					synthetic: true,
					timestamp: 4,
				},
				...tail,
			]);
			expect(piPreparedStructureMismatch(invalid, plan)).toBeDefined();
		});
	}
}

for (const api of ["bedrock-converse-stream", "ollama-chat"]) {
	test(`issue 820: ${api} exact source-pinned control shape and role`, () => {
		const text = hosts[0].renderDateCwdReminder("2026-01-02", cwd);
		const messages = [{ role: "user", content: "hello", timestamp: 1 }];
		const target = { api, provider: "example", id: "example", input: ["text"] };
		const plan = preparePiDispatch(messages, target, true, cwd).structure;
		const wire =
			api === "ollama-chat"
				? {
						messages: [
							{ role: "user", content: "hello" },
							{ role: "system", content: text },
						],
					}
				: {
						inferenceConfig: {},
						messages: [
							{ role: "user", content: [{ text: "hello" }] },
							{ role: "user", content: [{ text }] },
						],
					};
		expect(piPreparedStructureMismatch(wire, plan)).toBeUndefined();
		const altered = structuredClone(wire);
		altered.messages[1].role = "assistant";
		expect(piPreparedStructureMismatch(altered, plan)).toBeDefined();
	});
}
