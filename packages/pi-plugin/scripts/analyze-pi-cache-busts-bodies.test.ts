import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type PiBodySnapshot,
	normalizeRequestBody,
} from "../../plugin/scripts/cache-bust-body-sources";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	capturePiServedArray,
	flushPiServedArrayLedger,
} from "../src/served-array-ledger";
import {
	__test,
	analyzePiCacheBustSession,
	passBodyKey,
} from "./analyze-pi-cache-busts";

const directories: string[] = [];
const epoch = Date.parse("2026-09-04T10:00:00Z");
let fixtureNumber = 0;

function directory(): string {
	const root = createTestTempDirFromPath(join(tmpdir(), "pi-window-bodies-"));
	directories.push(root);
	return root;
}

afterEach(() => {
	for (const root of directories.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

/** The original full loader, kept independent of metadata-first selection. */
function referenceBodies(root: string): Map<number, PiBodySnapshot> {
	const bodies = new Map<number, PiBodySnapshot>();
	for (const file of fs.readdirSync(root)) {
		const match = /^(\d+)-req\.json$/.exec(file);
		if (!match) continue;
		const path = join(root, file);
		try {
			const body = JSON.parse(fs.readFileSync(path, "utf8"));
			const sequence = Number.parseInt(match[1], 10);
			bodies.set(sequence, {
				sequence,
				path,
				writtenAtMs: fs.statSync(path).mtimeMs,
				wireModel:
					typeof body.model === "string" && body.model.length > 0
						? body.model
						: undefined,
				messages: normalizeRequestBody(body, "openai").messages,
			});
		} catch {
			/* Partial writes are absent from the old map. */
		}
	}
	return bodies;
}

function fixture(sequenceFallback = false, payloadBytes = 32) {
	const piDir = directory();
	const ledgerDir = directory();
	const bodiesDir = directory();
	const sessionId = `window-bodies-${fixtureNumber++}`;
	const sessionPath = join(piDir, "session.jsonl");
	const entries: unknown[] = [{ type: "session", id: sessionId, cwd: piDir }];
	const paths: string[] = [];
	for (let index = 0; index < 6; index += 1) {
		const at = epoch + index * 60_000;
		const messages = [
			{ role: "user", content: `request ${index} ${"x".repeat(payloadBytes)}` },
		];
		capturePiServedArray(sessionId, messages, {
			storageDir: ledgerDir,
			now: new Date(at),
		});
		entries.push({
			type: "message",
			id: `assistant-${index}`,
			timestamp: new Date(at + 500).toISOString(),
			message: {
				role: "assistant",
				usage: {
					input: 100,
					cacheRead: index < 2 ? 10_000 : 500,
					cacheWrite: 100,
				},
				api: "anthropic-messages",
			},
		});
		const file = join(
			bodiesDir,
			`${sequenceFallback ? index + 1 : index + 1001}-req.json`,
		);
		fs.writeFileSync(
			file,
			JSON.stringify({ model: "test-model", input: messages }),
		);
		const writtenAt = sequenceFallback ? epoch + 86_400_000 : at + 100;
		fs.utimesSync(file, new Date(writtenAt), new Date(writtenAt));
		paths.push(file);
	}
	flushPiServedArrayLedger();
	fs.writeFileSync(
		sessionPath,
		entries.map((entry) => JSON.stringify(entry)).join("\n"),
	);
	const ledgers = __test.loadLedger(sessionId, ledgerDir);
	const session = __test.parsePiSessionFile(sessionPath);
	if (!session || ledgers.length !== 6)
		throw new Error("Incomplete synthetic session fixture");
	const options = {
		sessionId,
		piDir,
		ompDir: piDir,
		ledgerDir,
		bodiesDir,
		decisions: [],
		sinceExclusiveMs: epoch + 2 * 60_000 + 500,
		untilInclusiveMs: epoch + 4 * 60_000 + 500,
	};
	const joined = __test.joinPasses(ledgers, session).slice(1, 5);
	const required = new Set(joined.map((pass) => passBodyKey(pass.ledger)));
	return { options, paths, ledgers, joined, required, bodiesDir };
}

function assertParity(input: ReturnType<typeof fixture>) {
	const full = __test.joinPassBodies(
		input.ledgers,
		referenceBodies(input.bodiesDir),
	);
	const expected = new Map(
		[...full.byPass].filter(([key]) => input.required.has(key)),
	);
	const selected = __test.loadWindowPassBodies(
		input.ledgers,
		input.bodiesDir,
		input.required,
	);
	expect(selected.byPass).toEqual(expected);
	expect(selected.join).toBe(full.join);
	return full;
}

describe("Pi windowed body loading", () => {
	test("matches the full-load analysis with many old captures, future passes, and corrupt candidates", async () => {
		const input = fixture();
		for (let index = 0; index < 100; index += 1) {
			const path = join(input.bodiesDir, `${2000 + index}-req.json`);
			fs.writeFileSync(
				path,
				JSON.stringify({
					input: [{ role: "user", content: `old ${index}` }],
				}),
			);
			fs.utimesSync(
				path,
				new Date(epoch - 86_400_000),
				new Date(epoch - 86_400_000),
			);
		}
		const malformed = join(input.bodiesDir, "99999-req.json");
		fs.writeFileSync(malformed, "{partial");
		fs.utimesSync(
			malformed,
			new Date(epoch + 3 * 60_000 + 50),
			new Date(epoch + 3 * 60_000 + 50),
		);
		const full = assertParity(input);
		const rows = __test.analyzeJoinedPasses(input.joined, {
			bodies: full.byPass,
			decisions: [],
		});
		const expected = rows
			.filter(
				(row) => row.current.usage.timestamp > input.options.sinceExclusiveMs,
			)
			.map((row) => ({
				session: input.options.sessionId,
				at: row.current.usage.createdAt,
				timestampMs: row.current.usage.timestamp,
				verdict: row.verdict,
				rewrittenTokens: row.rewrittenTokens,
				divergenceClass: row.divergenceClass,
				...(row.cause ? { cause: row.cause } : {}),
				firstDivergence: row.attribution,
			}));
		const analysis = await analyzePiCacheBustSession(input.options);
		expect(
			analysis.requests.map(({ analyzerCmd: _command, ...request }) => request),
		).toEqual(expected);
		expect(analysis.requests).toHaveLength(2);
		expect(
			rows.some(
				(row) =>
					row.previousBody?.messages.length && row.currentBody?.messages.length,
			),
		).toBe(true);
		expect(
			analysis.requests.every((request) =>
				request.firstDivergence?.startsWith("message["),
			),
		).toBe(true);
	});

	test("preserves global sequence fallback and duplicate numeric filenames", () => {
		const input = fixture(true);
		expect(assertParity(input).join).toBe("file_number");
		const duplicate = join(input.bodiesDir, "0002-req.json");
		fs.writeFileSync(
			duplicate,
			JSON.stringify({
				input: [{ role: "user", content: "older duplicate" }],
			}),
		);
		fs.utimesSync(
			duplicate,
			new Date(epoch + 60_100),
			new Date(epoch + 60_100),
		);
		assertParity(input);
		// Directory enumeration order is filesystem-specific. Make its last copy
		// invalid so the earlier valid copy must supply the time-matched snapshot.
		const copies = fs
			.readdirSync(input.bodiesDir)
			.filter((file) => /^(?:0002|2)-req\.json$/.test(file));
		fs.writeFileSync(join(input.bodiesDir, copies[1]), "null");
		fs.utimesSync(
			join(input.bodiesDir, copies[0]),
			new Date(epoch + 60_100),
			new Date(epoch + 60_100),
		);
		expect(assertParity(input).join).toBe("write_time");
	});

	test("probes outward only until the first valid global time match, without retaining it", () => {
		const input = fixture(true);
		for (const index of [0, 5])
			fs.utimesSync(
				input.paths[index],
				new Date(epoch + index * 60_000 + 100),
				new Date(epoch + index * 60_000 + 100),
			);
		const read = spyOn(fs, "readFileSync");
		try {
			const selected = __test.loadWindowPassBodies(
				input.ledgers,
				input.bodiesDir,
				input.required,
			);
			expect(selected).toEqual({ byPass: new Map(), join: "write_time" });
			expect(read.mock.calls.map(([path]) => path)).toEqual([input.paths[5]]);
		} finally {
			read.mockRestore();
		}
		assertParity(input);
	});

	test("reads no body for an empty ledger or a window with no joined request", async () => {
		const input = fixture();
		const emptyLedger = directory();
		for (const options of [
			{ ...input.options, ledgerDir: emptyLedger },
			{
				...input.options,
				sinceExclusiveMs: epoch + 86_400_000,
				untilInclusiveMs: epoch + 86_500_000,
			},
		]) {
			const read = spyOn(fs, "readFileSync");
			try {
				expect((await analyzePiCacheBustSession(options)).requests).toEqual([]);
				expect(
					read.mock.calls.filter(([path]) =>
						String(path).endsWith("-req.json"),
					),
				).toHaveLength(0);
			} finally {
				read.mockRestore();
			}
		}
	});
});

// This is a separate subprocess so imports, fixture generation, and full-load
// parity checks in the parent cannot contaminate the analyzer's RSS high water.
test.skipIf(process.env.MC_PI_CACHE_BUST_MEMORY !== "1")(
	"Pi analyzer window with hundreds of old bodies stays below 128 MiB RSS growth",
	() => {
		const input = fixture(false, 1024 * 1024);
		const outsideCount = 256;
		const payload = "z".repeat(1024 * 1024);
		let outsideBytes = 0;
		for (let index = 0; index < outsideCount; index += 1) {
			const body = JSON.stringify({
				model: "test-model",
				input: [{ role: "user", content: `${index} ${payload}` }],
			});
			outsideBytes += Buffer.byteLength(body);
			const path = join(input.bodiesDir, `${2000 + index}-req.json`);
			fs.writeFileSync(path, body);
			const at = epoch + (index % 2 ? -86_400_000 : 86_400_000);
			fs.utimesSync(path, new Date(at), new Date(at));
		}
		const program = `
		import { analyzePiCacheBustSession } from ${JSON.stringify(join(import.meta.dir, "analyze-pi-cache-busts.ts"))};
		const baselineRss = process.memoryUsage().rss;
		const started = performance.now();
		const analysis = await analyzePiCacheBustSession(${JSON.stringify(input.options)});
		const peakRss = process.resourceUsage().maxRSS * 1024;
		console.log(JSON.stringify({ baselineRss, peakRss, growthRss: peakRss - baselineRss, elapsedMs: performance.now() - started,
			requests: analysis.requests.length, attributedBodies: analysis.requests.every(request => request.firstDivergence?.startsWith("message[")), highWaterMarkMs: analysis.highWaterMarkMs, bunVersion: Bun.version }));
	`;
		const child = Bun.spawnSync([process.execPath, "--eval", program], {
			stdout: "pipe",
			stderr: "pipe",
			timeout: 90_000,
		});
		expect(child.exitCode, child.stderr.toString()).toBe(0);
		const measured = JSON.parse(child.stdout.toString());
		console.log(
			JSON.stringify({
				kind: "pi_body_window_memory",
				outsideCount,
				outsideBytes,
				...measured,
			}),
		);
		expect(measured.requests).toBe(2);
		expect(measured.attributedBodies).toBe(true);
		expect(measured.highWaterMarkMs).toBe(input.options.untilInclusiveMs);
		expect(measured.growthRss).toBeLessThan(128 * 1024 * 1024);
	},
	180_000,
);
