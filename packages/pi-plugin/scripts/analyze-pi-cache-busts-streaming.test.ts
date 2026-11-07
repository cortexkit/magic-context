import { afterEach, describe, expect, test } from "bun:test";
import {
	closeSync,
	mkdirSync,
	openSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { getPiServedArrayLedgerPath } from "../src/served-array-ledger";
import { __test } from "./analyze-pi-cache-busts";
import { referenceParsePiSessionFile } from "./analyze-pi-cache-busts-reference.test-support";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = createTestTempDirFromPath(
		join(tmpdir(), "pi-cache-streaming-"),
	);
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Pi cache-bust streaming parser", () => {
	test("matches the original parser across byte, line, and UTF-8 boundaries", () => {
		const filePath = join(temporaryDirectory(), "session.jsonl");
		const header = JSON.stringify({
			type: "session",
			id: "original",
			cwd: "/a/東京",
		});
		const prefix = `${header}\r\n  \r\n{broken\n${JSON.stringify({ type: "compaction" })}\n`;
		const beforeCharacter = `${prefix}{"type":"message","message":{"role":"toolResult","content":[{"name":"`;
		// Put the first byte of a three-byte character at the end of a 64-byte chunk.
		const padding = "x".repeat(
			(63 - (Buffer.byteLength(beforeCharacter) % 64) + 64) % 64,
		);
		const splitCharacterOffset = Buffer.byteLength(beforeCharacter + padding);
		expect(splitCharacterOffset % 64).toBe(63);
		const content = `${beforeCharacter}${padding}€工具😀"}]}}\r\n${[
			{
				type: "message",
				id: "later",
				timestamp: "2026-09-04T10:02:00Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "payload".repeat(4000) }],
					usage: { input: 17, cacheRead: 100, cacheWrite: 20 },
					api: "anthropic-messages",
					provider: "anthropic",
					model: "model-€",
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					timestamp: "2026-09-04T10:01:00Z",
					tokens: { inputTokens: 23, cache: { read: 40, write: 50 } },
				},
			},
			{
				type: "message",
				id: "tie",
				timestamp: "2026-09-04T10:01:00Z",
				message: {
					role: "assistant",
					usage: { input: -1, cache_read: 12, cache_write: 3 },
				},
			},
			{ name: "unknown-tool" },
			{ type: "message", message: { role: "assistant", usage: { input: 1 } } },
			{ type: "session", id: "final", cwd: "/b/😀" },
			{ type: "session", id: "final-without-cwd" },
		]
			.map((entry) => JSON.stringify(entry))
			.join("\r\n")}`;
		writeFileSync(filePath, content);
		const expected = referenceParsePiSessionFile(filePath);
		expect(expected?.sessionId).toBe("final-without-cwd");
		expect(expected?.cwd).toBe("/b/😀");
		expect(expected?.usage.map((row) => row.messageId)).toEqual([
			"line-7",
			"tie",
			"later",
		]);
		expect(expected?.entries.map((entry) => entry.ordinal)).toEqual(
			Array.from({ length: 10 }, (_, index) => index),
		);
		for (const bufferBytes of [
			1,
			2,
			3,
			7,
			31,
			64,
			127,
			1024,
			8 * 1024 * 1024,
		]) {
			expect(__test.parsePiSessionFile(filePath, bufferBytes)).toEqual(
				expected,
			);
		}
		writeFileSync(filePath, `${content}\n\n`);
		expect(__test.parsePiSessionFile(filePath, 64)).toEqual(
			referenceParsePiSessionFile(filePath),
		);
	});

	test("matches empty, missing-header, unreadable, and invalid UTF-8 inputs", () => {
		const filePath = join(temporaryDirectory(), "session.jsonl");
		expect(__test.parsePiSessionFile(filePath, 3)).toBeUndefined();
		for (const content of [
			Buffer.alloc(0),
			Buffer.from(" \r\n{bad\n{}"),
			Buffer.concat([
				Buffer.from('{"type":"session","id":"s","cwd":"/'),
				Buffer.from([0xe2, 0x82]),
				Buffer.from('"}\n'),
			]),
		]) {
			writeFileSync(filePath, content);
			expect(__test.parsePiSessionFile(filePath, 3)).toEqual(
				referenceParsePiSessionFile(filePath),
			);
		}
		writeFileSync(filePath, '{"type":"session","id":"s"}\nnull');
		expect(() => referenceParsePiSessionFile(filePath)).toThrow(TypeError);
		expect(() => __test.parsePiSessionFile(filePath, 3)).toThrow(TypeError);
	});

	test("streams ledger lines without changing validation, bounds, or sorting", () => {
		const root = temporaryDirectory();
		const sessionId = "ledger-session";
		const filePath = getPiServedArrayLedgerPath(sessionId, root);
		mkdirSync(dirname(filePath), { recursive: true });
		const record = (
			sequence: number,
			minute: string,
			session_id = sessionId,
		) => ({
			version: 1 as const,
			session_id,
			pass_ts: `2026-09-04T10:${minute}:00Z`,
			sequence,
			message_count: 1,
			sha256: "€".repeat(300),
			previous_sha256: null,
			first_divergence_message_index: null,
			block_vector_start: 0,
			block_vectors: [],
		});
		const first = record(1, "01");
		const second = record(2, "01");
		const third = record(3, "02");
		writeFileSync(
			filePath,
			[
				JSON.stringify(third),
				"",
				"{broken",
				"{}",
				JSON.stringify(record(0, "00")),
				JSON.stringify(second),
				JSON.stringify(record(4, "03", "other")),
				JSON.stringify(first),
				'{"version":1',
			].join("\r\n"),
		);
		for (const bufferBytes of [1, 7, 64, 1024]) {
			expect(
				__test.loadLedger(
					sessionId,
					root,
					Date.parse(first.pass_ts),
					Date.parse(third.pass_ts),
					bufferBytes,
				),
			).toEqual([first, second, third]);
		}
	});

	test.skipIf(process.env.MC_PI_CACHE_BUST_MEMORY !== "1")(
		"300 MiB session stays below 400 MiB peak RSS growth",
		() => {
			const filePath = join(temporaryDirectory(), "large.jsonl");
			const rowCount = 4800;
			const row = {
				type: "message",
				id: "entry",
				timestamp: "2026-09-04T10:00:00Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					usage: { input: 10, cacheRead: 1000, cacheWrite: 20 },
				},
			};
			row.message.content[0].text = "x".repeat(
				64 * 1024 - Buffer.byteLength(JSON.stringify(row)) - 1,
			);
			const line = Buffer.from(`${JSON.stringify(row)}\n`);
			expect(line.length).toBe(64 * 1024);
			const fd = openSync(filePath, "w");
			try {
				writeSync(fd, '{"type":"session","id":"memory-session"}\n');
				for (let index = 0; index < rowCount; index += 1) writeSync(fd, line);
			} finally {
				closeSync(fd);
			}
			// A fresh process isolates the parser peak from fixture generation and other tests.
			const run = Bun.spawnSync(
				[
					process.execPath,
					"--eval",
					`
			import { __test } from ${JSON.stringify(join(import.meta.dir, "analyze-pi-cache-busts.ts"))};
			const baselineRss = process.memoryUsage().rss;
			const started = performance.now();
			const session = __test.parsePiSessionFile(${JSON.stringify(filePath)});
			const peakRss = process.resourceUsage().maxRSS * 1024;
			console.log(JSON.stringify({ baselineRss, peakRss, growthRss: peakRss - baselineRss,
				elapsedMs: performance.now() - started, entries: session?.entries.length,
				usage: session?.usage.length, bunVersion: Bun.version }));
		`,
				],
				{ stdout: "pipe", stderr: "pipe", timeout: 60_000 },
			);
			expect(run.exitCode, run.stderr.toString()).toBe(0);
			const measurement = JSON.parse(run.stdout.toString());
			console.log(
				JSON.stringify({
					kind: "pi_cache_bust_memory",
					fileBytes: statSync(filePath).size,
					...measurement,
				}),
			);
			expect(measurement.entries).toBe(rowCount + 1);
			expect(measurement.usage).toBe(rowCount);
			expect(measurement.growthRss).toBeGreaterThan(0);
			expect(measurement.growthRss).toBeLessThan(400 * 1024 * 1024);
		},
		90_000,
	);
});
