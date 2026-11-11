import { expect, test } from "bun:test";
import { piCheckPreparedDispatch } from "./pi-dispatch-acceptance";
import {
	piForeignEvidence,
	piProtectPreparedRows,
} from "./pi-dispatch-foreign";
import {
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";

const model = { api: "anthropic-messages", provider: "test", id: "test" };
const user = (text: string) => ({ role: "user", content: text });
const native = {
	role: "bashExecution",
	command: "echo key",
	output: "original-key",
	timestamp: 1,
	exitCode: 0,
};
const nativeText = "Ran `echo key`\n```\noriginal-key\n```";
const rewritten = nativeText.replace("original-key", "#SECRET_1#");
const prompt = { ...user("prompt"), timestamp: 2 };
const managed = { ...prompt, content: "§1§ prompt" };
const assistant = {
	role: "assistant",
	api: model.api,
	provider: "test",
	model: "test",
	timestamp: 3,
	content: [{ type: "text", text: "original secret" }],
	stopReason: "stop",
};

function setup(output: unknown[], history: unknown[] = [native, prompt]) {
	const prepared = piPreparedStructure(output, model);
	const evidence = piForeignEvidence(
		{
			getEntries: () =>
				history.map((message, index) => ({
					type: "message",
					id: String(index),
					message,
				})),
		},
		history,
	);
	piProtectPreparedRows(evidence, output, prepared);
	const payload = (messages: unknown[]) => ({ system: "system", messages });
	return {
		check: (rows: unknown[]) =>
			piCheckPreparedDispatch(payload(rows), prepared, evidence),
		base: (rows: unknown[]) =>
			piPreparedStructureMismatch(payload(rows), prepared),
	};
}

test("a rewritten native row cannot be deleted so leaked session content fills its slot", () => {
	const leaked = { ...user("cut prompt"), timestamp: 0 };
	const f = setup([native], [leaked, native]);
	expect(f.base([user(rewritten)])).toBeUndefined();
	expect(f.check([user(rewritten), user("cut prompt")]).mismatch).toContain(
		"session-content",
	);
});

test("a small rewritten native row cannot hide an oversized novel insertion", () => {
	const f = setup([native], [native]);
	expect(
		f.check([user(rewritten), user("x".repeat(32769))]).mismatch,
	).toContain("ambiguous-rewrite");
});

test("a non-text user row cannot take an untagged text slot while its rewrite is deleted", () => {
	const f = setup([native], [native]);
	for (const content of [
		[
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: "AAAA" },
			},
		],
		[{ type: "thinking", thinking: "inserted reasoning" }],
	]) {
		expect(
			f.check([user(rewritten), { role: "user", content }]).mismatch,
		).toContain("not-text-user");
	}
});

test("a printed tag anchors its own slot, not an earlier untagged slot", () => {
	const f = setup([native, managed]);
	expect(
		f.check([managed, user(rewritten), user("foreign")]).mismatch,
	).toContain("prepared-row");
});

test("the same prepared tag cannot appear in an additional row", () => {
	const f = setup([managed], [prompt]);
	expect(f.check([managed, user("§1§ other text")]).mismatch).toContain(
		"prepared-row",
	);
});

test("a small novel ambiguous gap accepts an obfuscated execution beside a bootstrap", () => {
	const f = setup([native, managed]);
	expect(
		f.check([user("bootstrap"), user(rewritten), managed]).mismatch,
	).toBeUndefined();
});

test("rewritten gaps of equal size use exactly the existing comparator", () => {
	const f = setup([native, managed, assistant]);
	const rows = [
		user(rewritten),
		managed,
		{ role: "assistant", content: [{ type: "text", text: "#SECRET_1#" }] },
	];
	expect(f.base(rows)).toBeUndefined();
	expect(f.check([...rows, user("bootstrap")]).mismatch).toBeUndefined();
});

test("an oversized rewritten native row next to an insertion diagnoses the ambiguity", () => {
	const huge = { ...native, output: "a".repeat(40000) };
	const f = setup([huge], [huge]);
	const wire = `Ran \`echo key\`\n\`\`\`\n${"b".repeat(40000)}\n\`\`\``;
	expect(f.base([user(wire)])).toBeUndefined();
	const mismatch = f.check([user(wire), user("bootstrap")]).mismatch;
	expect(mismatch).toContain("reason=ambiguous-rewrite");
	expect(mismatch).toContain("gapPrepared=1 gapWire=2");
	expect(mismatch).toContain("gapChars=40023");
});

test("ambiguous gaps share the character budget, rather than each receiving 32k", () => {
	const second = { ...native, timestamp: 4 };
	const f = setup([native, managed, second]);
	expect(
		f.check([
			user(rewritten),
			user("x".repeat(20000)),
			managed,
			user(rewritten),
			user("y".repeat(20000)),
		]).mismatch,
	).toContain("ambiguous-rewrite");
});

test("an obfuscated replay assistant is a structural anchor beside an insertion", () => {
	const next = { ...user("next"), timestamp: 4 };
	const taggedNext = { ...next, content: "§2§ next" };
	const f = setup([managed, assistant, taggedNext], [prompt, assistant, next]);
	const rows = [
		managed,
		{ role: "assistant", content: [{ type: "text", text: "#SECRET_1#" }] },
		taggedNext,
	];
	expect(f.base(rows)).toBeUndefined();
	expect(
		f.check([rows[0], user("bootstrap"), ...rows.slice(1)]).mismatch,
	).toBeUndefined();
	expect(
		f.check([
			rows[0],
			{ role: "assistant", content: "extra" },
			user("bootstrap"),
			...rows.slice(1),
		]).mismatch,
	).toBeDefined();
});

test("a user-role tool result is structural and an insertion cannot split its pair", () => {
	const call = {
		...assistant,
		content: [
			{
				type: "toolCall",
				id: "call",
				name: "read",
				arguments: { path: "file" },
			},
		],
		stopReason: "toolUse",
	};
	const result = {
		role: "toolResult",
		toolCallId: "call",
		toolName: "read",
		content: [{ type: "text", text: "result" }],
		timestamp: 4,
	};
	const f = setup([managed, call, result], [prompt, call, result]);
	const rows = [
		managed,
		{
			role: "assistant",
			content: [
				{ type: "tool_use", id: "call", name: "read", input: { path: "file" } },
			],
		},
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "call", content: "result" },
			],
		},
	];
	expect(f.check([...rows, user("bootstrap")]).mismatch).toBeUndefined();
	expect(
		f.check([rows[0], rows[1], user("bootstrap"), rows[2]]).mismatch,
	).toContain("tool-pair");
	expect(
		f.check([
			...rows,
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "extra",
						content: "foreign result",
					},
				],
			},
		]).mismatch,
	).toBeDefined();
});

test("optional Anthropic assistants and their exact Continue pads keep the comparator's winning alignment", () => {
	const thinking = {
		...assistant,
		timestamp: 2.5,
		content: [
			{
				type: "thinking",
				thinking: "prior private thought",
				thinkingSignature: "sig",
			},
		],
	};
	const next = { ...user("next"), timestamp: 4 };
	const taggedNext = { ...next, content: "§2§ next" };
	const f = setup(
		[managed, thinking, assistant, taggedNext],
		[prompt, thinking, assistant, next],
	);
	const replay = {
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
	};
	for (const middle of [
		[],
		[
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "prior private thought",
						signature: "sig",
					},
				],
			},
			user("Continue."),
		],
	]) {
		const rows = [managed, ...middle, replay, taggedNext];
		expect(f.base(rows)).toBeUndefined();
		expect(f.check([user("bootstrap"), ...rows]).mismatch).toBeUndefined();
	}
});

test("native date controls are outside the four foreign-row budget", () => {
	const next = { ...user("next"), timestamp: 4 };
	const taggedNext = { ...next, content: "§2§ next" };
	const f = setup([managed, assistant, taggedNext], [prompt, assistant, next]);
	const reminder =
		"<system-reminder>\nToday: 2026-11-11; current working directory: '/work'. Do not repeat this information in your reply.\n</system-reminder>";
	const rows = [
		managed,
		...Array.from({ length: 6 }, () => user(reminder)),
		{ role: "assistant", content: [{ type: "text", text: "answer" }] },
		taggedNext,
	];
	expect(f.base(rows)).toBeUndefined();
	expect(f.check([user("bootstrap"), ...rows]).mismatch).toBeUndefined();
});

test("a separate first date block does not hide a prepared Google row's printed tag", () => {
	const google = { ...model, api: "google-generative-ai" };
	const prepared = piPreparedStructure([managed], google);
	const evidence = piForeignEvidence({ getEntries: () => [] }, [prompt]);
	piProtectPreparedRows(evidence, [managed], prepared);
	const parts = [
		{
			text: "<system-reminder>\nToday: 2026-11-11; current working directory: '/work'. Do not repeat this information in your reply.\n</system-reminder>",
		},
		{ text: "§1§ prompt" },
	];
	expect(
		piCheckPreparedDispatch(
			{
				contents: [
					{ role: "user", parts },
					{ role: "user", parts: [{ text: "bootstrap" }] },
				],
			},
			prepared,
			evidence,
		).mismatch,
	).toBeUndefined();
});

for (const api of [
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
])
	test(`${api}: native developer-origin file text stays structural without making user images eligible`, () => {
		const file = {
			role: "fileMention",
			files: [{ path: "notes.md", content: "project rules" }],
			timestamp: 3,
		};
		const output = [managed, file];
		const prepared = piPreparedStructure(output, { ...model, api });
		const evidence = piForeignEvidence(
			{ getEntries: () => [{ type: "message", id: "file", message: file }] },
			[prompt, file],
		);
		piProtectPreparedRows(evidence, output, prepared);
		const first = {
			role: "user",
			content: [{ type: "input_text", text: "§1§ prompt" }],
		};
		const second = {
			role: "developer",
			content: [
				{
					type: "input_text",
					text: '<file path="notes.md">\nproject rules\n</file>',
				},
			],
		};
		const payload = (input: unknown[]) => ({ input });
		expect(
			piPreparedStructureMismatch(payload([first, second]), prepared),
		).toBeUndefined();
		const foreign = {
			role: "user",
			content: [{ type: "input_text", text: "bootstrap" }],
		};
		expect(
			piCheckPreparedDispatch(
				payload([foreign, first, second]),
				prepared,
				evidence,
			).mismatch,
		).toBeUndefined();
		expect(
			piCheckPreparedDispatch(
				payload([
					foreign,
					first,
					{
						role: "user",
						content: [
							{ type: "input_image", image_url: "data:image/png;base64,AAAA" },
						],
					},
				]),
				prepared,
				evidence,
			).mismatch,
		).toBeDefined();
	});
