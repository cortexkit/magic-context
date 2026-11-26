import { afterEach, expect, test } from "bun:test";
import { closeSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertRetrospectiveHeap,
	measureRetrospective,
} from "@magic-context/core/features/magic-context/dreamer/__tests__/retrospective-heap-fixture.test";
import {
	_resetHarnessForTesting,
	setHarness,
} from "@magic-context/core/shared/harness";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { PiRetrospectiveRawProvider } from "./retrospective-raw-provider-pi";

const dirs: string[] = [];
afterEach(() => {
	_resetHarnessForTesting();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fixture(turns: number): string {
	const dir = createTestTempDirFromPath(join(tmpdir(), "mc-pi-primer-heap-"));
	dirs.push(dir);
	const fd = openSync(join(dir, "session.jsonl"), "w");
	const line = (entry: unknown) => writeSync(fd, `${JSON.stringify(entry)}\n`);
	try {
		line({
			type: "session",
			version: 3,
			id: "ses_primer",
			cwd: "/fixture/retro",
			timestamp: new Date(0).toISOString(),
		});
		const start = Date.now() - 10_000_000;
		const output = "x".repeat(16_384);
		const diagnostics = Array.from({ length: 40 }, (_, i) => ({
			message: `Unresolved reference: symbol${i}`,
			severity: 1,
		}));
		for (let i = 1; i <= turns; i++) {
			const base = {
				type: "message",
				timestamp: new Date(i * 1000).toISOString(),
			};
			line({
				...base,
				id: `u${i}`,
				message: {
					role: "user",
					timestamp: start + i * 1000,
					content: `question ${i}`,
				},
			});
			line({
				...base,
				id: `a${i}`,
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: `answer ${i}` },
						{
							type: "toolCall",
							id: `call${i}`,
							name: "read",
							arguments: { filePath: `/src/File${i}.kt` },
						},
					],
				},
			});
			line({
				...base,
				id: `t${i}`,
				message: {
					role: "toolResult",
					toolCallId: `call${i}`,
					toolName: "read",
					content: [{ type: "text", text: output }],
					details: { diagnostics },
				},
			});
		}
	} finally {
		closeSync(fd);
	}
	return dir;
}

test("Pi retrospective peak heap does not grow with same-project history", async () => {
	setHarness("pi");
	const measurements = [];
	for (const turns of [500, 5_000]) {
		const sessionDir = fixture(turns);
		measurements.push(
			await measureRetrospective(
				new PiRetrospectiveRawProvider({
					sessionDir,
					projectCwd: "/fixture/retro",
				}),
			),
		);
	}
	expect(measurements).toHaveLength(2);
	assertRetrospectiveHeap(measurements[0], measurements[1]);
}, 60_000);

test("Pi retrospective input is byte-identical to whole-file reads under caps", async () => {
	const { readFileSync, writeFileSync } = await import("node:fs");
	const { loadDefaultPiSessionApi } = await import("./pi-session-api");
	const { readRetrospectiveScanWindow } = await import(
		"@magic-context/core/features/magic-context/dreamer/retrospective-raw-provider"
	);
	const { buildFrictionGatePrompt } = await import(
		"@magic-context/core/features/magic-context/dreamer/task-prompts"
	);
	const sessionDir = fixture(12);
	const file = join(sessionDir, "session.jsonl");
	// Importing sessions can leave timestamps out of order; selection must still
	// use timestamp/ordinal order, not stop at the first eligible JSONL prefix.
	const rows = readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	rows[1].message.content = [
		{ type: "text", text: "  Unicode 🐈  " },
		{ type: "image", data: "ignored" },
		{ type: "text", text: "second" },
	];
	const first = rows[1].message.timestamp;
	rows[1].message.timestamp = rows[7].message.timestamp;
	rows[7].message.timestamp = first;
	writeFileSync(
		file,
		`${rows.map((row) => JSON.stringify(row)).join("\n")}\nmalformed\n`,
	);
	const api = await loadDefaultPiSessionApi();
	const entries = (await api.loadEntriesFromFile(file)) as typeof rows;
	const firstUserIndex = entries.findIndex(
		(entry) => entry?.type === "message" && entry.message?.role === "user",
	);
	const all = entries
		.flatMap((e, i) => {
			const m = e?.message;
			if (
				e?.type !== "message" ||
				m?.role !== "user" ||
				typeof m.timestamp !== "number"
			)
				return [];
			const text = (
				typeof m.content === "string"
					? m.content
					: m.content
							.filter((p: { type: string }) => p.type === "text")
							.map((p: { text: string }) => p.text)
							.join("\n")
			).trim();
			// Derive reply history from file order before sorting by timestamp.
			const followsAssistantReply =
				firstUserIndex >= 0 &&
				entries
					.slice(firstUserIndex + 1, i)
					.some(
						(entry) =>
							entry?.type === "message" && entry.message?.role === "assistant",
					);
			return text
				? [
						{
							sessionId: "ses_primer",
							ordinal: i + 1,
							role: "user" as const,
							text,
							ts: m.timestamp,
							...(followsAssistantReply ? { followsAssistantReply: true } : {}),
						},
					]
				: [];
		})
		.sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal);
	const legacy = {
		listProjectSessions: () => [{ sessionId: "ses_primer" }],
		readOldestMessageTimesSince: (_ids: readonly string[], since: number) =>
			new Map(
				all
					.filter((m) => m.ts > since)
					.slice(0, 1)
					.map((m) => [m.sessionId, m.ts]),
			),
		readUserMessagesSince: (_id: string, since: number, cap: number) => {
			const eligible = all.filter((m) => m.ts > since);
			const firstOmitted = eligible[cap];
			return {
				messages: eligible.slice(0, cap),
				truncated: eligible.length > cap,
				...(firstOmitted ? { firstOmittedTs: firstOmitted.ts } : {}),
			};
		},
		readUserMessagesBefore: (_id: string, before: number, count: number) =>
			all.filter((m) => m.ts <= before).slice(-count),
	};
	const provider = new PiRetrospectiveRawProvider({
		sessionDir,
		projectCwd: "/fixture/retro",
	});
	for (const watermark of [0, first + 4000]) {
		const actual = await readRetrospectiveScanWindow(
			provider,
			"project",
			watermark,
			3,
		);
		const expected = await readRetrospectiveScanWindow(
			legacy,
			"project",
			watermark,
			3,
		);
		expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
		const render = (messages: typeof actual.messages) =>
			buildFrictionGatePrompt({
				userLines: messages.map((m, i) => `${i + 1}: ${m.text}`),
			});
		expect(render(actual.messages)).toBe(render(expected.messages));
	}
	await provider.listProjectSessions("project");
	expect(await provider.readUserMessagesSince("ses_primer", 0, 3)).toEqual(
		legacy.readUserMessagesSince("ses_primer", 0, 3),
	);
});
