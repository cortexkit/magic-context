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

const { dir: root, cleanup } = createTestTempDir("mc-codex-dispatch-");
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
const aliases = ["omp-pi-ai-18132"];
await pinOmpLoggerFiles(root, aliases);
const ai = require.resolve(`${aliases[0]}/package.json`).slice(0, -12);
const { convertCodexResponsesMessages: convert } = await import(
	`${ai}src/providers/openai-codex-responses.ts`
);
await exerciseOmpLoggerFiles(aliases);
reportOmpLogDescriptors();
afterAll(() => {
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
const user = (text = "question", timestamp = 1) => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp,
});
function blank(text = ""): any {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: 2,
		content: [
			{ type: "thinking", thinking: "", thinkingSignature: "", summary: [] },
			{
				type: "text",
				text,
				textSignature: JSON.stringify({
					v: 1,
					id: "msg_fixture",
					phase: "final_answer",
				}),
			},
		],
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: model.provider,
			dt: true,
			items: [
				{
					type: "reasoning",
					id: "rs_fixture",
					summary: [],
					encrypted_content: "synthetic-not-a-signature",
				},
				{
					type: "message",
					id: "msg_fixture",
					role: "assistant",
					status: "completed",
					phase: "final_answer",
					content: [{ type: "output_text", text, annotations: [] }],
				},
			],
		},
	};
}
const wire = (messages: unknown[], target = model) => ({
	input: convert(target, { systemPrompt: ["system"], messages }),
});
function admits(messages: unknown[], target = model) {
	const before = JSON.stringify(messages);
	const prepared = preparePiDispatch(messages, target, true, cwd);
	const payload = wire(prepared.messages, target);
	const bytes = JSON.stringify(payload);
	expect(
		piPreparedStructureMismatch(payload, prepared.structure),
	).toBeUndefined();
	expect(JSON.stringify(messages)).toBe(before);
	expect(JSON.stringify(prepared.messages)).toBe(before);
	expect(JSON.stringify(wire(prepared.messages, target))).toBe(bytes);
	return { payload, plan: prepared.structure };
}

for (const shape of [
	"empty",
	"whitespace",
	"unsigned whitespace",
	"multipart",
] as const) {
	test(`Codex hidden-only ${shape} omits the assistant row without changing prepared bytes`, () => {
		const message = blank(shape === "empty" ? "" : " \n");
		if (shape === "unsigned whitespace") {
			delete message.content[1].textSignature;
			message.content[1].text = " ";
		}
		if (shape === "multipart")
			message.providerPayload.items[1].content = [
				{ type: "output_text", text: " ", annotations: [] },
				{ type: "output_text", text: "\n", annotations: [] },
			];
		const { payload } = admits([user(), message, user("next", 3)]);
		expect(payload.input.map((row: any) => row.role)).toEqual(["user", "user"]);
	});
}

test("Codex keeps visible native output and refuses a removed row or altered text", () => {
	const messages = [user(), blank("visible reply"), user("next", 3)];
	const { payload, plan } = admits(messages);
	expect(
		payload.input.find((row: any) => row.role === "assistant"),
	).toBeDefined();
	const removed = {
		input: payload.input.filter((row: any) => row.role !== "assistant"),
	};
	expect(piPreparedStructureMismatch(removed, plan)).toBeDefined();
	payload.input.find((row: any) => row.role === "assistant").content[0].text =
		"other reply";
	expect(piPreparedStructureMismatch(payload, plan)).toContain(
		"comparison=content",
	);
});

test("Codex only suppresses hidden native fallback for the replay-compatible model and provider", () => {
	for (const change of ["model", "provider"] as const) {
		const message = blank();
		if (change === "model") message.model = "other-model";
		else message.providerPayload.provider = "other-provider";
		const { payload, plan } = admits([user(), message, user("next", 3)]);
		expect(payload.input.some((row: any) => row.role === "assistant")).toBe(
			true,
		);
		expect(
			piPreparedStructureMismatch(
				{ input: payload.input.filter((row: any) => row.role !== "assistant") },
				plan,
			),
		).toBeDefined();
	}
});

test("Codex foreign thinking stays visible even with no prepared text blocks", () => {
	const message = blank();
	message.provider = "foreign-provider";
	message.content = [
		{ type: "thinking", thinking: "important reasoning", summary: true },
	];
	message.providerPayload.items[1].content = [];
	const { payload, plan } = admits([user(), message, user("next", 3)]);
	expect(payload.input.some((row: any) => row.role === "assistant")).toBe(true);
	expect(
		piPreparedStructureMismatch(
			{ input: payload.input.filter((row: any) => row.role !== "assistant") },
			plan,
		),
	).toBeDefined();
});

test("Codex mixed blank/visible native items keep text, calls and results fenced", () => {
	const message = blank();
	const visible = blank("visible reply");
	visible.content[1].textSignature = JSON.stringify({
		v: 1,
		id: "msg_visible",
		phase: "final_answer",
	});
	visible.providerPayload.items[1].id = "msg_visible";
	message.content.push(visible.content[1], {
		type: "toolCall",
		id: "call_a|fc_a",
		name: "read",
		arguments: {},
	});
	message.stopReason = "toolUse";
	message.providerPayload.items.push(visible.providerPayload.items[1], {
		type: "function_call",
		id: "fc_a",
		call_id: "call_a",
		name: "read",
		arguments: "{}",
	});
	const result = {
		role: "toolResult",
		toolCallId: "call_a|fc_a",
		toolName: "read",
		timestamp: 3,
		content: [{ type: "text", text: "result" }],
		isError: false,
	};
	const { payload, plan } = admits([user(), message, result, user("next", 4)]);
	expect(
		payload.input.find((row: any) => row.role === "assistant").content[0].text,
	).toBe("visible reply");
	for (const type of ["function_call", "function_call_output", "message"]) {
		const altered = {
			input: payload.input.filter((row: any) =>
				type === "message" ? row.role !== "assistant" : row.type !== type,
			),
		};
		expect(piPreparedStructureMismatch(altered, plan)).toBeDefined();
	}
	const hiddenTool = structuredClone(message);
	hiddenTool.content.splice(2, 1);
	hiddenTool.providerPayload.items.splice(2, 1);
	const kept = admits([user(), hiddenTool, result]);
	expect(
		kept.payload.input.some((row: any) => row.type === "function_call"),
	).toBe(true);
	expect(
		piPreparedStructureMismatch(
			{
				input: kept.payload.input.filter(
					(row: any) => row.type !== "function_call",
				),
			},
			kept.plan,
		),
	).toBeDefined();
});
