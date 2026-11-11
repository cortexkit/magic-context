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
import { piOmpSessionTexts } from "./pi-foreign-native-text";

const model = { api: "anthropic-messages", provider: "test", id: "test" };
const prompt = { role: "user", content: "prompt", timestamp: 1 };
const managed = { ...prompt, content: "§1§ prompt" };
const image = { type: "image", mimeType: "image/png", data: "AAAA" };
const cases: {
	name: string;
	message: Record<string, unknown>;
	text: string;
}[] = [
	{
		name: "custom image caption",
		message: {
			role: "custom",
			customType: "illustration",
			content: [image],
			display: false,
		},
		text: "Images attached to illustration.\n[image omitted: the active model does not support image input]",
	},
	{
		name: "hook image caption",
		message: {
			role: "hookMessage",
			customType: "illustration",
			content: [image],
		},
		text: "Images attached to illustration.\n[image omitted: the active model does not support image input]",
	},
	{
		name: "bash output",
		message: {
			role: "bashExecution",
			command: "ls",
			output: "a.txt",
			exitCode: 0,
		},
		text: "Ran `ls`\n```\na.txt\n```",
	},
	{
		name: "cancelled bash",
		message: {
			role: "bashExecution",
			command: "ls",
			output: "",
			cancelled: true,
		},
		text: "Ran `ls`\n(no output)\n\n(command cancelled)",
	},
	{
		name: "failed Python",
		message: {
			role: "pythonExecution",
			code: "raise Exception()",
			output: "failed",
			exitCode: 1,
		},
		text: "Ran Python:\n```python\nraise Exception()\n```\nOutput:\n```\nfailed\n```\n\nExecution failed with code 1",
	},
	{
		name: "file wrapper",
		message: {
			role: "fileMention",
			files: [{ path: "notes.md", content: "notes" }],
		},
		text: '<file path="notes.md">\nnotes\n</file>',
	},
	{
		name: "text-only image mention",
		message: { role: "fileMention", files: [{ path: "image.png", image }] },
		text: '<file path="image.png">\n</file>\n[image omitted: the active model does not support image input]',
	},
	{
		name: "native compaction summary",
		message: { role: "compactionSummary", summary: "earlier work" },
		text: "Prior model work/tool state available.\nMUST build on prior work; NEVER duplicate prior work.\n\n<summary>\nearlier work\n</summary>",
	},
	{
		name: "native summary blocks",
		message: {
			role: "compactionSummary",
			summary: "summary",
			blocks: [{ type: "text", text: "frame" }],
		},
		text: "summary\nframe",
	},
	{
		name: "native branch summary",
		message: {
			role: "branchSummary",
			summary: "abandoned path",
			fromId: "old",
		},
		text: "Branch-return summary:\n\n<summary>\nabandoned path\n</summary>",
	},
];

test("a persisted custom image entry protects its generated caption without an image placeholder", () => {
	const source = {
		getEntries: () => [
			{
				type: "custom_message",
				id: "custom",
				customType: "illustration",
				content: [image],
				display: false,
				timestamp: 0,
			},
		],
	};
	const prepared = piPreparedStructure([managed], model);
	const evidence = piForeignEvidence(source, [prompt]);
	piProtectPreparedRows(evidence, [managed], prepared);
	expect(
		piCheckPreparedDispatch(
			{
				system: "system",
				messages: [
					{ role: "user", content: "Images attached to illustration." },
					managed,
				],
			},
			prepared,
			evidence,
		).mismatch ?? "accepted",
	).toContain("session-content");
});

for (const fixture of cases) {
	test(`${fixture.name}: native rendered text is protected even after its entry is cut`, () => {
		const message = { ...fixture.message, timestamp: 0 };
		expect(piOmpSessionTexts(message)).toContain(fixture.text);
		const source = {
			getEntries: () => [
				{ type: "message", id: "native", message },
				{ type: "message", id: "prompt", message: prompt },
			],
		};
		const prepared = piPreparedStructure([managed], model);
		const evidence = piForeignEvidence(source, [prompt]);
		piProtectPreparedRows(evidence, [managed], prepared);
		const payload = {
			system: "system",
			messages: [{ role: "user", content: fixture.text }, managed],
		};
		expect(
			piCheckPreparedDispatch(payload, prepared, evidence).mismatch,
		).toContain("session-content");
	});
	test(`${fixture.name}: a served native row does not become a removable foreign row`, () => {
		const message = { ...fixture.message, timestamp: 0 };
		const source = {
			getEntries: () => [{ type: "message", id: "native", message }],
		};
		const output = [message, managed];
		const prepared = piPreparedStructure(output, model);
		expect(prepared).toBeDefined();
		const rows = [{ role: "user", content: fixture.text }, managed];
		expect(
			piPreparedStructureMismatch(
				{ system: "system", messages: rows },
				prepared,
			),
		).toBeUndefined();
		const evidence = piForeignEvidence(source, [message, prompt]);
		piProtectPreparedRows(evidence, output, prepared);
		expect(
			piCheckPreparedDispatch(
				{
					system: "system",
					messages: [{ role: "user", content: "foreign" }, ...rows],
				},
				prepared,
				evidence,
			).mismatch,
		).toBeUndefined();
	});
}

test("execution notices retain exact truncation, artifact and diagnostic formatting", () => {
	const message = {
		role: "bashExecution",
		command: "cat file",
		output: "head",
		meta: {
			truncation: {
				direction: "head",
				truncatedBy: "bytes",
				totalLines: 10,
				totalBytes: 2048,
				outputLines: 1,
				outputBytes: 1024,
				maxBytes: 1024,
				shownRange: { start: 1, end: 1 },
				artifactId: "capture",
				nextOffset: 2,
			},
			diagnostics: {
				summary: "one error",
				messages: ["pkg/src/file.ts:1:2 [error] broken"],
			},
		},
	};
	expect(piOmpSessionTexts(message)).toContain(
		"Ran `cat file`\n```\nhead\n```\n\n[Showing lines 1-1 of 10 (1.0KB limit). Use :2 to continue. Read artifact://capture for full output]\n\nLSP Diagnostics (one error):\n# pkg/src/\n## file.ts\n  1:2 [error] broken",
	);
});

test("native summary formatting preserves code while compacting tables and blank runs", () => {
	const message = {
		role: "compactionSummary",
		summary: "heading\n\n\n| a | b |\n| :-- | --: |\n```\n  code  \n```",
	};
	expect(piOmpSessionTexts(message)).toContain(
		"Prior model work/tool state available.\nMUST build on prior work; NEVER duplicate prior work.\n\n<summary>\nheading\n|a|b|\n|:---|---:|\n```\n  code\n```\n</summary>",
	);
});
