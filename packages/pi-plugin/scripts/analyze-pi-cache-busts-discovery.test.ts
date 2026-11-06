import { afterEach, describe, expect, test } from "bun:test";
import {
	closeSync,
	mkdirSync,
	openSync,
	rmSync,
	utimesSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	__test,
	analyzePiCacheBustSession,
	type PiSessionFile,
} from "./analyze-pi-cache-busts";
import { referenceParsePiSessionFile } from "./analyze-pi-cache-busts-reference.test-support";

const temporaryDirectories: string[] = [];
const targetId = "019de471-4fdc-762d-9286-624dfad0b5fe";
const otherId = "019de471-4fdc-762d-9286-624dfad0b5ff";

function temporaryDirectory(): string {
	const directory = createTestTempDirFromPath(
		join(tmpdir(), "pi-cache-discovery-"),
	);
	temporaryDirectories.push(directory);
	return directory;
}

function sessionFile(
	root: string,
	name: string,
	ids: string[],
	cwd = root,
): string {
	const filePath = join(root, name);
	writeFileSync(
		filePath,
		ids.map((id) => JSON.stringify({ type: "session", id, cwd })).join("\n"),
	);
	return filePath;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("Pi cache-bust targeted discovery", () => {
	test("skips the bodies of native non-matches after confirming their first header", async () => {
		const root = temporaryDirectory();
		const nonmatch = sessionFile(
			root,
			`2026-09-04T10-00-00-000Z_${otherId}.jsonl`,
			[otherId],
		);
		writeFileSync(
			nonmatch,
			`${JSON.stringify({ type: "session", id: otherId })}\nnull`,
		);
		const match = sessionFile(
			root,
			`2026-09-04T10-01-00-000Z_${targetId}.jsonl`,
			[targetId],
		);
		// The old parser throws on JSON null, so reaching the tail would fail this scan.
		expect(() => referenceParsePiSessionFile(nonmatch)).toThrow(TypeError);
		expect(
			await __test.discoverPiSessionFiles([root], (id) => id === targetId),
		).toEqual([referenceParsePiSessionFile(match)!]);
	});

	test("skips a native OMP non-match after its fixed title slot and session header", async () => {
		const root = temporaryDirectory();
		const filePath = join(root, `2026-09-04T10-00-00-000Z_${otherId}.jsonl`);
		writeFileSync(
			filePath,
			`${JSON.stringify({ type: "title", title: "OMP session" }).padEnd(1024)}\r\n${JSON.stringify({ type: "session", id: otherId })}\r\nnull`,
		);
		expect(() => referenceParsePiSessionFile(filePath)).toThrow(TypeError);
		expect(
			await __test.discoverPiSessionFiles([root], (id) => id === targetId),
		).toEqual([]);
	});

	test("matches old final-header semantics for legacy names and native filename/header mismatches", async () => {
		const root = temporaryDirectory();
		const files = [
			sessionFile(root, "legacy.jsonl", [otherId, targetId]),
			sessionFile(root, `2026-09-04T10-00-00-000Z_${otherId}.jsonl`, [
				targetId,
			]),
			sessionFile(root, `2026-09-04T10-01-00-000Z_${targetId}.jsonl`, [
				targetId,
				otherId,
			]),
			sessionFile(root, "nonmatch.jsonl", [otherId]),
		];
		const expected = files
			.map(referenceParsePiSessionFile)
			.filter(
				(session): session is PiSessionFile => session?.sessionId === targetId,
			)
			.sort((left, right) => left!.path.localeCompare(right!.path));
		const actual = await __test.discoverPiSessionFiles(
			[root, root],
			(id) => id === targetId,
		);
		expect(
			actual.sort((left, right) => left.path.localeCompare(right.path)),
		).toEqual(expected);
		const prefix = await __test.discoverPiSessionFiles([root], (id) =>
			id.startsWith("019de471"),
		);
		expect(prefix).toHaveLength(files.length);
	});

	test("keeps mtime, size, then path ordering across roots", async () => {
		const piDir = temporaryDirectory();
		const ompDir = temporaryDirectory();
		const ledgerDir = temporaryDirectory();
		const oldest = sessionFile(
			piDir,
			"old.jsonl",
			[targetId],
			"old".repeat(100),
		);
		const smaller = sessionFile(piDir, "small.jsonl", [targetId], "s");
		const first = sessionFile(piDir, "a.jsonl", [targetId], "first");
		const second = sessionFile(ompDir, "z.jsonl", [targetId], "other");
		utimesSync(oldest, new Date(1000), new Date(1000));
		for (const file of [smaller, first, second])
			utimesSync(file, new Date(2000), new Date(2000));
		const expectedPath = [first, second].sort((left, right) =>
			left.localeCompare(right),
		)[0];
		const analysis = await analyzePiCacheBustSession({
			sessionId: targetId,
			piDir,
			ompDir,
			ledgerDir,
			bodiesDir: ledgerDir,
			decisions: [],
		});
		expect(analysis).toEqual({
			requests: [],
			highWaterMarkMs: null,
			directory: referenceParsePiSessionFile(expectedPath)?.cwd,
		});
	});

	test.skipIf(process.env.MC_PI_CACHE_BUST_MEMORY !== "1")(
		"targeted analysis keeps corpus-sized non-matches below 96 MiB RSS growth",
		() => {
			const root = temporaryDirectory();
			const ledgerDir = temporaryDirectory();
			const matchingRoot = join(root, "matching");
			mkdirSync(matchingRoot);
			const fileCount = 8;
			const rowsPerFile = 131072;
			const row = {
				type: "message",
				id: "entry",
				timestamp: "2026-09-04T10:00:00Z",
				message: {
					role: "assistant",
					content: "",
					usage: { input: 10, cacheRead: 1000, cacheWrite: 20 },
				},
			};
			row.message.content = "x".repeat(
				256 - Buffer.byteLength(JSON.stringify(row)) - 1,
			);
			const line = Buffer.from(`${JSON.stringify(row)}\n`);
			expect(line.length).toBe(256);
			const block = Buffer.concat(Array.from({ length: 1024 }, () => line));
			for (let index = 0; index < fileCount; index += 1) {
				const id = `019de471-4fdc-762d-9286-${String(index).padStart(12, "0")}`;
				const fd = openSync(
					join(root, `2026-09-04T10-00-00-000Z_${id}.jsonl`),
					"w",
				);
				try {
					writeSync(fd, `${JSON.stringify({ type: "session", id })}\n`);
					for (
						let blockIndex = 0;
						blockIndex < rowsPerFile / 1024;
						blockIndex += 1
					)
						writeSync(fd, block);
				} finally {
					closeSync(fd);
				}
			}
			const matchingPath = sessionFile(
				matchingRoot,
				`2026-09-04T10-01-00-000Z_${targetId}.jsonl`,
				[targetId],
			);
			writeFileSync(
				matchingPath,
				`${JSON.stringify({ type: "session", id: targetId, cwd: matchingRoot })}\n${JSON.stringify(row)}\n`,
			);
			const options = {
				sessionId: targetId,
				piDir: root,
				ompDir: root,
				ledgerDir,
				bodiesDir: ledgerDir,
				decisions: [],
			};
			const imports = `import { __test, analyzePiCacheBustSession } from ${JSON.stringify(join(import.meta.dir, "analyze-pi-cache-busts.ts"))};`;
			const run = (program: string) => {
				const child = Bun.spawnSync(
					[process.execPath, "--eval", imports + program],
					{ stdout: "pipe", stderr: "pipe", timeout: 90_000 },
				);
				expect(child.exitCode, child.stderr.toString()).toBe(0);
				return JSON.parse(child.stdout.toString());
			};
			// Unfiltered discovery preserves the old collect-every-parse path. Run it in
			// a separate process so its allocations cannot contaminate the real-path peak.
			const reference = run(`
			const candidates = (await __test.discoverPiSessionFiles([${JSON.stringify(root)}]))
				.filter(session => session.sessionId === ${JSON.stringify(targetId)});
			if (candidates.length !== 1) throw new Error("Reference fixture must have exactly one match");
			const selected = candidates[0];
			console.log(JSON.stringify({ requests: [], highWaterMarkMs: Math.max(...selected.usage.map(row => row.timestamp)), directory: selected.cwd }));
		`);
			const measurement = run(`
			const baselineRss = process.memoryUsage().rss;
			const started = performance.now();
			const analysis = await analyzePiCacheBustSession(${JSON.stringify(options)});
			const peakRss = process.resourceUsage().maxRSS * 1024;
			console.log(JSON.stringify({ analysis, baselineRss, peakRss, growthRss: peakRss - baselineRss, elapsedMs: performance.now() - started, bunVersion: Bun.version }));
		`);
			console.log(
				JSON.stringify({
					kind: "pi_cache_bust_discovery_memory",
					nonmatchingBytes: fileCount * rowsPerFile * line.length,
					...measurement,
				}),
			);
			expect(measurement.analysis).toEqual(reference);
			expect(measurement.analysis.highWaterMarkMs).toBe(
				Date.parse("2026-09-04T10:00:00Z"),
			);
			expect(measurement.analysis.directory).toBe(matchingRoot);
			expect(measurement.growthRss).toBeLessThan(96 * 1024 * 1024);
		},
		180_000,
	);
});
