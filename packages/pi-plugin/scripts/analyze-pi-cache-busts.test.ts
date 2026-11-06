import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRequestBody } from "../../plugin/scripts/cache-bust-body-sources";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	capturePiServedArray,
	flushPiServedArrayLedger,
} from "../src/served-array-ledger";
import { __test, analyzePiCacheBustSession } from "./analyze-pi-cache-busts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function temporaryDirectory(label: string): string {
	const directory = createTestTempDirFromPath(join(tmpdir(), label));
	temporaryDirectories.push(directory);
	return directory;
}

function assistant(
	id: string,
	timestamp: string,
	usage: { input: number; cacheRead: number; cacheWrite: number },
): Record<string, unknown> {
	return {
		type: "message",
		id,
		timestamp,
		message: {
			role: "assistant",
			timestamp,
			content: [{ type: "text", text: id }],
			usage: { ...usage, output: 10, totalTokens: 999_999 },
		},
	};
}

function writeJsonl(
	root: string,
	project: string,
	filename: string,
	entries: readonly unknown[],
): string {
	const directory = join(root, project);
	mkdirSync(directory, { recursive: true });
	const filePath = join(directory, filename);
	writeFileSync(
		filePath,
		`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
	return filePath;
}

describe("Pi cache-bust analyzer discovery", () => {
	test("discovers Pi and OMP layouts and uses the session header id", async () => {
		const piRoot = temporaryDirectory("pi-cache-analyzer-pi-");
		const ompRoot = temporaryDirectory("pi-cache-analyzer-omp-");
		writeJsonl(piRoot, "--project--", "filename-is-not-id.jsonl", [
			{
				type: "session",
				id: "pi-header-id",
				timestamp: "2026-09-04T09:00:00Z",
			},
		]);
		writeJsonl(ompRoot, "project", "also-not-id.jsonl", [
			{ type: "title", title: "OMP title" },
			{
				type: "session",
				id: "omp-header-id",
				timestamp: "2026-09-04T09:00:00Z",
			},
		]);

		const sessions = await __test.discoverPiSessionFiles([piRoot, ompRoot]);

		expect(sessions.map((session) => session.sessionId).sort()).toEqual([
			"omp-header-id",
			"pi-header-id",
		]);
	});

	test("lists ambiguous cross-root candidates and selects the newest", () => {
		const piRoot = temporaryDirectory("pi-cache-ambiguous-pi-");
		const ompRoot = temporaryDirectory("pi-cache-ambiguous-omp-");
		const storageDir = temporaryDirectory("pi-cache-ambiguous-ledger-");
		const oldSession = "ambiguous-session-old";
		const newSession = "ambiguous-session-new";
		const oldPath = writeJsonl(piRoot, "--old--", "old.jsonl", [
			{ type: "session", id: oldSession },
		]);
		const newPath = writeJsonl(ompRoot, "--new--", "new.jsonl", [
			{ type: "session", id: newSession },
			assistant("a1", "2026-09-04T10:00:00Z", {
				input: 20,
				cacheRead: 10_000,
				cacheWrite: 0,
			}),
		]);
		utimesSync(oldPath, new Date(1_000), new Date(1_000));
		utimesSync(newPath, new Date(2_000), new Date(2_000));
		capturePiServedArray(newSession, [{ role: "user", content: "new" }], {
			storageDir,
			now: new Date("2026-09-04T09:59:59Z"),
		});
		flushPiServedArrayLedger();

		const run = Bun.spawnSync([
			process.execPath,
			join(import.meta.dir, "analyze-pi-cache-busts.ts"),
			"--session",
			"ambiguous-session-",
			"--pi-dir",
			piRoot,
			"--omp-dir",
			ompRoot,
			"--ledger-dir",
			storageDir,
			"--all-rows",
		]);

		expect(run.exitCode).toBe(0);
		const output = run.stdout.toString();
		expect(output).toContain("Ambiguous session prefix");
		expect(output).toContain(`${oldSession} mtime=`);
		expect(output).toContain(`${newSession} mtime=`);
		expect(output).toContain("size=");
		expect(output).toContain(`Using newest candidate ${newPath}.`);
	});
});

describe("Pi cache-bust analyzer body attribution", () => {
	test("discovers pi-llm-debugging Responses bodies and prints the real message diff", () => {
		const sessionRoot = temporaryDirectory("pi-cache-body-session-");
		const ompRoot = temporaryDirectory("pi-cache-body-omp-");
		const storageDir = temporaryDirectory("pi-cache-body-ledger-");
		const sessionId = "pi-body-fixture";
		writeJsonl(sessionRoot, "--project--", "body.jsonl", [
			{ type: "session", id: sessionId, cwd: "/unused/by-override" },
			assistant("a1", "2026-09-04T10:00:00Z", {
				input: 20,
				cacheRead: 10_000,
				cacheWrite: 0,
			}),
			assistant("a2", "2026-09-04T10:00:02Z", {
				input: 20,
				cacheRead: 100,
				cacheWrite: 0,
			}),
		]);
		capturePiServedArray(sessionId, [{ role: "user", content: "before" }], {
			storageDir,
			now: new Date("2026-09-04T09:59:59Z"),
		});
		capturePiServedArray(sessionId, [{ role: "user", content: "after" }], {
			storageDir,
			now: new Date("2026-09-04T10:00:01Z"),
		});
		flushPiServedArrayLedger();
		const bodiesDir = join(
			import.meta.dir,
			"test-fixtures",
			"cache-bust-bodies",
			"pi-llm-debugging",
		);

		const run = Bun.spawnSync([
			process.execPath,
			join(import.meta.dir, "analyze-pi-cache-busts.ts"),
			"--session",
			sessionId,
			"--pi-dir",
			sessionRoot,
			"--omp-dir",
			ompRoot,
			"--ledger-dir",
			storageDir,
			"--bodies-dir",
			bodiesDir,
			"--all-rows",
			"--show-diff",
		]);

		expect(run.exitCode).toBe(0);
		const output = run.stdout.toString();
		expect(output).toContain("Bodies:  2");
		// Checked-in fixture files carry git checkout times, which match no pass,
		// so the analyzer falls back to pairing bodies by file number.
		expect(output).toContain("Body join: by file number");
		expect(output).toContain(
			'message[1] role=user parts=[input_text(13)] text="pi body after"',
		);
		expect(output).toContain(
			'prev: {"role":"user","content":[{"type":"input_text","text":"pi body [before]"}]}',
		);
		expect(output).toContain("Meter rule (Pi host)");
	});
});

describe("Pi cache-bust analyzer meter", () => {
	test("flags session A's consecutive rewrite instead of forgiving the previous bust input", () => {
		const readings = [
			[254592, 1054],
			[16896, 173076],
			[16896, 173524],
			[190336, 493],
		];
		const passes = readings.map(([cacheRead, input], index) => ({
			ledger: {
				version: 1 as const,
				session_id: "A",
				pass_ts: new Date(index * 1000).toISOString(),
				sequence: index,
				message_count: 2,
				sha256: String(index),
				previous_sha256: null,
				first_divergence_message_index: 0,
				block_vector_start: 0,
				block_vectors: ["user:text(1)"],
			},
			usage: {
				timestamp: index * 1000,
				createdAt: new Date(index * 1000).toISOString(),
				line: index,
				ordinal: index,
				messageId: String(index),
				input,
				cacheRead,
				cacheWrite: 0,
				total: input + cacheRead,
			},
			intervening: [],
		}));
		const rows = __test.analyzeJoinedPasses(passes);
		expect(rows.map((row) => row.verdict)).toEqual([
			"BASE",
			"BUST",
			"BUST",
			"STABLE",
		]);
		expect(rows[2].rewrittenTokens).toBe(173524);
	});
	test("skips a zero-usage pass as a baseline and busts the next real short read", () => {
		const pass = (sequence: number, timestamp: number, cacheRead: number, input: number) => ({
			ledger: {
				version: 1 as const,
				session_id: "usage-missing-baseline",
				pass_ts: new Date(timestamp).toISOString(),
				sequence,
				message_count: 2,
				sha256: String(sequence),
				previous_sha256: sequence === 0 ? null : String(sequence - 1),
				first_divergence_message_index: 0,
				block_vector_start: 0,
				block_vectors: ["user:text(1)"],
			},
			usage: {
				timestamp,
				createdAt: new Date(timestamp).toISOString(),
				line: sequence,
				ordinal: sequence,
				messageId: String(sequence),
				input,
				cacheRead,
				cacheWrite: 0,
				total: input + cacheRead,
			},
			intervening: [],
		});
		const rows = __test.analyzeJoinedPasses(
			[pass(0, 0, 20_000, 100), pass(1, 1_000, 0, 0), pass(2, 2_000, 100, 100)],
			{
				decisions: [
					{
						timestampMs: 2_000,
						decision: "defer",
						materialized: false,
						materializeReason: null,
						emergency: false,
						droppedTokens: 0,
						droppedCount: 0,
						inputTokens: 100,
						flush: false,
						source: "fixture",
					},
				],
			},
		);

		expect(rows[1]?.verdict).toBe("UNMETERED");
		expect(rows[1]?.divergenceClass).toBe("usage_missing");
		expect(rows[2]?.prevTotal).toBe(20_100);
		expect(rows[2]?.verdict).toBe("BUST");
		expect(rows[2]?.divergenceClass).toBe("unaccounted_defer_pass");
	});

	test("classifies a zero cache read with a large prior meter as a provider full miss", () => {
		const passes = [
			{
				ledger: {
					version: 1 as const,
					session_id: "provider-full-miss",
					pass_ts: new Date(0).toISOString(),
					sequence: 0,
					message_count: 2,
					sha256: "previous",
					previous_sha256: null,
					first_divergence_message_index: 0,
					block_vector_start: 0,
					block_vectors: ["user:text(1)"],
				},
				usage: {
					timestamp: 0,
					createdAt: new Date(0).toISOString(),
					line: 0,
					ordinal: 0,
					messageId: "previous",
					input: 100,
					cacheRead: 20_000,
					cacheWrite: 0,
					total: 20_100,
				},
				intervening: [],
			},
			{
				ledger: {
					version: 1 as const,
					session_id: "provider-full-miss",
					pass_ts: new Date(1_000).toISOString(),
					sequence: 1,
					message_count: 2,
					sha256: "current",
					previous_sha256: "previous",
					first_divergence_message_index: 0,
					block_vector_start: 0,
					block_vectors: ["user:text(2)"],
				},
				usage: {
					timestamp: 1_000,
					createdAt: new Date(1_000).toISOString(),
					line: 1,
					ordinal: 1,
					messageId: "current",
					input: 100,
					cacheRead: 0,
					cacheWrite: 0,
					total: 100,
				},
				intervening: [],
			},
		];

		const rows = __test.analyzeJoinedPasses(passes, {
			decisions: [
				{
					timestampMs: 1_000,
					decision: "defer",
					materialized: false,
					materializeReason: null,
					emergency: false,
					droppedTokens: 0,
					droppedCount: 0,
					inputTokens: 100,
					flush: false,
					source: "fixture",
				},
			],
		});

		expect(rows[1]?.divergenceClass).toBe("provider_full_miss");
	});

	test("detector control reports a known post-compaction collapse as BUST at the seam", () => {
		const sessionRoot = temporaryDirectory("pi-cache-positive-session-");
		const storageDir = temporaryDirectory("pi-cache-positive-ledger-");
		const sessionId = "019e8905-post-compaction-control";
		const entries = [
			{ type: "session", id: sessionId, timestamp: "2026-09-04T09:59:00Z" },
			assistant("a-prev", "2026-09-04T10:00:00Z", {
				input: 1_924,
				cacheRead: 185_856,
				cacheWrite: 0,
			}),
			{
				type: "compaction",
				id: "compact-1",
				timestamp: "2026-09-04T10:00:01Z",
				firstKeptEntryId: "997b8008",
			},
			assistant("a-next", "2026-09-04T10:00:02Z", {
				input: 95_420,
				cacheRead: 16_896,
				cacheWrite: 0,
			}),
		];
		const filePath = writeJsonl(
			sessionRoot,
			"--project--",
			"positive.jsonl",
			entries,
		);
		const before = [
			{ role: "system", content: "system" },
			{ role: "user", content: [{ type: "text", text: "kept" }] },
			{ role: "assistant", content: [{ type: "text", text: "old history" }] },
		];
		const after = [
			before[0],
			before[1],
			{
				role: "assistant",
				content: [{ type: "text", text: "compacted history" }],
			},
		];
		capturePiServedArray(sessionId, before, {
			storageDir,
			now: new Date("2026-09-04T09:59:59Z"),
		});
		capturePiServedArray(sessionId, after, {
			storageDir,
			now: new Date("2026-09-04T10:00:01.500Z"),
		});
		flushPiServedArrayLedger();
		const session = __test.parsePiSessionFile(filePath);
		expect(session).toBeDefined();
		const ledger = __test.loadLedger(sessionId, storageDir);

		const rows = __test.analyzeJoinedPasses(
			__test.joinPasses(ledger, session as NonNullable<typeof session>),
		);

		expect(rows[1].verdict).toBe("BUST");
		expect(rows[1].current.ledger.first_divergence_message_index).toBe(2);
		expect(rows[1].attribution).toContain("message[2] (compaction seam)");
		expect(rows[1].divergenceClass).toBe("no_mc_pass_row");
		expect(rows[1].rewrittenTokens).toBe(170_884);
	});

	test("uses input plus cache read and cache write as prior meter total", () => {
		const sessionRoot = temporaryDirectory("pi-cache-meter-session-");
		const storageDir = temporaryDirectory("pi-cache-meter-ledger-");
		const sessionId = "meter-total";
		const filePath = writeJsonl(sessionRoot, "project", "meter.jsonl", [
			{ type: "session", id: sessionId },
			assistant("a1", "2026-09-04T10:00:00Z", {
				input: 20,
				cacheRead: 10_000,
				cacheWrite: 500,
			}),
			assistant("a2", "2026-09-04T10:00:02Z", {
				input: 20,
				cacheRead: 10_450,
				cacheWrite: 50,
			}),
		]);
		const served = [{ role: "user", content: "same" }];
		capturePiServedArray(sessionId, served, {
			storageDir,
			now: new Date("2026-09-04T09:59:59Z"),
		});
		capturePiServedArray(sessionId, served, {
			storageDir,
			now: new Date("2026-09-04T10:00:01Z"),
		});
		flushPiServedArrayLedger();
		const session = __test.parsePiSessionFile(filePath);
		const rows = __test.analyzeJoinedPasses(
			__test.joinPasses(
				__test.loadLedger(sessionId, storageDir),
				session as NonNullable<typeof session>,
			),
		);

		expect(rows[1].prevTotal).toBe(10_520);
		// Only the cache read is compared, against the previous read + write - 64.
		expect(rows[1].comparableRead).toBe(10_450);
		expect(rows[1].meterFloor).toBe(10_436);
		expect(rows[1].verdict).toBe("STABLE");
		expect(rows[1].attribution).toBe("identical digest");
	});
});


describe("Pi cache-bust analyzer: uncached input never counts as reuse", () => {
	type Reading = readonly [at: string, input: number, read: number, write: number];
	const anthropic = {
		api: "cortexkit-anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
	};
	const openai = {
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-fixture",
	};
	function passes(
		readings: readonly Reading[],
		names: { api: string; provider: string; model: string },
	) {
		return readings.map(([at, input, cacheRead, cacheWrite], index) => {
			const timestamp = Date.parse(at);
			return {
				ledger: {
					version: 1 as const,
					session_id: "uncached-input",
					pass_ts: new Date(timestamp - 500).toISOString(),
					sequence: index,
					message_count: index + 2,
					sha256: String(index),
					previous_sha256: index === 0 ? null : String(index - 1),
					first_divergence_message_index: index + 1,
					block_vector_start: 0,
					block_vectors: ["user:text(1)"],
				},
				usage: {
					timestamp,
					createdAt: new Date(timestamp).toISOString(),
					line: index,
					ordinal: index,
					messageId: String(index),
					input,
					cacheRead,
					cacheWrite,
					total: input + cacheRead + cacheWrite,
					...names,
				},
				intervening: [],
			};
		});
	}

	test("flags the 2026-10-17 requests that read only the 47k head and wrote nothing", () => {
		// Session 019de471-4fdc-762d-9286-624dfad0b5fe, exact usage numbers. The old
		// "read + input" meter labelled 14:05:06, 14:09:55 and 14:10:11 STABLE.
		const rows = __test.analyzeJoinedPasses(
			passes(
				[
					["2026-10-17T14:04:44.317Z", 2, 519_900, 506],
					["2026-10-17T14:05:06.355Z", 474_229, 47_083, 0],
					["2026-10-17T14:05:11.503Z", 2, 520_406, 1_260],
					["2026-10-17T14:09:55.464Z", 474_788, 47_083, 0],
					["2026-10-17T14:10:11.085Z", 479_189, 47_083, 0],
					["2026-10-17T14:10:23.287Z", 2, 47_083, 483_683],
					["2026-10-17T14:10:34.445Z", 2, 530_766, 1_126],
				],
				anthropic,
			),
		);

		expect(rows.map((row) => row.verdict)).toEqual([
			"BASE",
			"BUST",
			"STABLE",
			"BUST",
			"BUST",
			"BUST",
			"STABLE",
		]);
		expect(rows.map((row) => row.divergenceClass)).toEqual([
			undefined,
			"missing_breakpoint_after_read",
			undefined,
			"missing_breakpoint_after_read",
			"missing_breakpoint_after_read",
			// 14:10:23 wrote the rest, but the 521k prefix was last read at
			// 14:05:11, 5 min 12 s earlier: the two head-only reads in between did
			// not refresh it, so it had expired.
			"idle_cache_expiry",
			undefined,
		]);
		expect(rows[3].comparableRead).toBe(47_083);
		expect(rows[3].meterFloor).toBe(521_602);
		expect(rows[3].explicitBreakpoints).toBe(true);
	});

	test("flags the 019e8905 13:52 request that read 47k of a 621k prompt", () => {
		const rows = __test.analyzeJoinedPasses(
			passes(
				[
					["2026-10-17T13:51:37.698Z", 2, 614_837, 2_869],
					["2026-10-17T13:52:16.089Z", 573_919, 47_081, 0],
					["2026-10-17T13:52:21.895Z", 2, 617_706, 3_741],
				],
				anthropic,
			),
		);

		expect(rows.map((row) => row.verdict)).toEqual(["BASE", "BUST", "STABLE"]);
		expect(rows[1].divergenceClass).toBe("missing_breakpoint_after_read");
	});

	test("keeps a warm tool loop STABLE", () => {
		const rows = __test.analyzeJoinedPasses(
			passes(
				[
					["2026-10-17T14:10:34.445Z", 2, 530_766, 1_126],
					["2026-10-17T14:10:41.091Z", 2, 531_892, 784],
					["2026-10-17T14:11:01.762Z", 2, 532_676, 1_688],
					["2026-10-17T14:15:58.303Z", 2, 534_364, 1_950],
				],
				anthropic,
			),
		);

		expect(rows.map((row) => row.verdict)).toEqual([
			"BASE",
			"STABLE",
			"STABLE",
			"STABLE",
		]);
	});

	test("labels a short read after more than the TTL idle as expiry", () => {
		// Session 019e8905: 17 min idle after 13:28:40, then a turn start that
		// read nothing and rewrote the prompt over two requests.
		const rows = __test.analyzeJoinedPasses(
			passes(
				[
					["2026-10-17T13:28:40.073Z", 2, 600_452, 719],
					["2026-10-17T13:46:00.084Z", 554_630, 0, 47_081],
					["2026-10-17T13:46:24.402Z", 2, 47_081, 555_984],
					["2026-10-17T13:46:44.637Z", 2, 603_065, 648],
				],
				anthropic,
			),
		);

		expect(rows[1].verdict).toBe("BUST");
		expect(rows[1].divergenceClass).toBe("idle_cache_expiry");
		expect(rows[1].idleGapMs).toBe(1_040_011);
		expect(rows.slice(2).map((row) => row.verdict)).toEqual([
			"STABLE",
			"STABLE",
		]);
		// A 1 h TTL keeps the same gap from counting as expiry.
		const longTtl = __test.analyzeJoinedPasses(
			passes(
				[
					["2026-10-17T13:28:40.073Z", 2, 600_452, 719],
					["2026-10-17T13:46:00.084Z", 554_630, 0, 47_081],
				],
				anthropic,
			),
			{ cacheTtlMs: 3_600_000 },
		);
		expect(longTtl[1].divergenceClass).not.toBe("idle_cache_expiry");
	});

	test("reads an OpenAI implicit cache by cached tokens alone and never names a missing breakpoint", () => {
		// pi-ai reports OpenAI usage as input = prompt - cached, cacheRead = cached,
		// cacheWrite = 0. A full re-prefill (read 0) used to pass because read +
		// input still added up to the whole prompt.
		const rows = __test.analyzeJoinedPasses(
			passes(
				[
					["2026-10-17T12:00:00.000Z", 50_000, 0, 0],
					["2026-10-17T12:00:10.000Z", 1_280, 49_920, 0],
					["2026-10-17T12:00:20.000Z", 928, 51_072, 0],
					["2026-10-17T12:00:30.000Z", 42_888, 10_112, 0],
					["2026-10-17T12:00:40.000Z", 53_800, 0, 0],
					["2026-10-17T12:00:50.000Z", 808, 53_120, 0],
				],
				openai,
			),
		);

		expect(rows.map((row) => row.verdict)).toEqual([
			"BASE",
			"STABLE",
			"STABLE",
			"BUST",
			"BUST",
			"STABLE",
		]);
		expect(rows[3].explicitBreakpoints).toBe(false);
		expect(rows[3].divergenceClass).not.toBe("missing_breakpoint_after_read");
		expect(rows[4].divergenceClass).toBe("provider_full_miss");
	});
});

describe("Pi cache-bust analyzer context.db join and attribution", () => {
	function setupBustFixture(options: {
		sessionId: string;
		decisionRow?: {
			tsMs: number;
			decision: string;
			droppedCount: number;
			droppedTokens?: number;
			messageId?: string;
		};
		assistant2Id?: string;
	}) {
		const sessionRoot = temporaryDirectory("pi-cache-db-session-");
		const storageDir = temporaryDirectory("pi-cache-db-ledger-");
		const bodiesDir = join(
			import.meta.dir,
			"test-fixtures",
			"cache-bust-bodies",
			"pi-llm-debugging",
		);
		const sessionId = options.sessionId;
		const a2Id = options.assistant2Id ?? "a2";

		writeJsonl(sessionRoot, "--project--", "session.jsonl", [
			{ type: "session", id: sessionId },
			assistant("a1", "2026-09-04T10:00:00Z", {
				input: 20,
				cacheRead: 10_000,
				cacheWrite: 0,
			}),
			assistant(a2Id, "2026-09-04T10:00:02Z", {
				input: 20,
				cacheRead: 100,
				cacheWrite: 0,
			}),
		]);

		capturePiServedArray(sessionId, [{ role: "user", content: "before" }], {
			storageDir,
			now: new Date("2026-09-04T09:59:59Z"),
		});
		capturePiServedArray(sessionId, [{ role: "user", content: "after" }], {
			storageDir,
			now: new Date("2026-09-04T10:00:01Z"),
		});
		flushPiServedArrayLedger();

		const db = new Database(join(storageDir, "context.db"));
		db.run(
			"CREATE TABLE transform_decisions (session_id TEXT, harness TEXT, message_id TEXT, ts_ms INTEGER, decision TEXT, materialized INTEGER, materialize_reason TEXT, emergency INTEGER, dropped_tokens INTEGER, dropped_count INTEGER, input_tokens INTEGER)",
		);
		if (options.decisionRow) {
			db.run(
				"INSERT INTO transform_decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					sessionId,
					"pi",
					options.decisionRow.messageId ?? a2Id,
					options.decisionRow.tsMs,
					options.decisionRow.decision,
					0,
					null,
					0,
					options.decisionRow.droppedTokens ?? 500,
					options.decisionRow.droppedCount,
					1_000,
				],
			);
		}
		db.close();

		return { sessionRoot, storageDir, bodiesDir, sessionId };
	}

	test("attributes a bust request to the nearest-preceding MC pass row in context.db 1 s before request", () => {
		const fixture = setupBustFixture({
			sessionId: "pi-bust-1s-before",
			decisionRow: {
				tsMs: Date.parse("2026-09-04T10:00:01Z"), // 1s before 10:00:02Z request
				decision: "execute",
				droppedCount: 50,
			},
		});

		const run = Bun.spawnSync([
			process.execPath,
			join(import.meta.dir, "analyze-pi-cache-busts.ts"),
			"--session",
			fixture.sessionId,
			"--pi-dir",
			fixture.sessionRoot,
			"--ledger-dir",
			fixture.storageDir,
			"--bodies-dir",
			fixture.bodiesDir,
			"--all-rows",
		]);

		expect(run.exitCode).toBe(0);
		const output = run.stdout.toString();
		expect(output).toContain("accounted_drop_applied");
		expect(output).not.toContain("no_mc_pass_row");
	});

	test("attributes to nearest-preceding pass even when Pi rows carry synthesized or detached message IDs", () => {
		const fixture = setupBustFixture({
			sessionId: "pi-bust-detached-id",
			assistant2Id: "line-42", // synthesized / detached ID in JSONL
			decisionRow: {
				messageId: "turn-resolved-target", // different ID in transform_decisions
				tsMs: Date.parse("2026-09-04T10:00:01Z"), // 1s before 10:00:02Z request
				decision: "execute",
				droppedCount: 16,
			},
		});

		const run = Bun.spawnSync([
			process.execPath,
			join(import.meta.dir, "analyze-pi-cache-busts.ts"),
			"--session",
			fixture.sessionId,
			"--pi-dir",
			fixture.sessionRoot,
			"--ledger-dir",
			fixture.storageDir,
			"--bodies-dir",
			fixture.bodiesDir,
			"--all-rows",
		]);

		expect(run.exitCode).toBe(0);
		const output = run.stdout.toString();
		expect(output).toContain("accounted_drop_applied");
		expect(output).not.toContain("no_mc_pass_row");
	});

	test("negative: reports no_mc_pass_row when no MC pass exists within the request's pass window", () => {
		// Decision row is 60 seconds before request (outside the 30s pass window)
		const fixture = setupBustFixture({
			sessionId: "pi-bust-outside-window",
			decisionRow: {
				tsMs: Date.parse("2026-09-04T09:59:00Z"), // 62s before request
				decision: "execute",
				droppedCount: 50,
			},
		});

		const run = Bun.spawnSync([
			process.execPath,
			join(import.meta.dir, "analyze-pi-cache-busts.ts"),
			"--session",
			fixture.sessionId,
			"--pi-dir",
			fixture.sessionRoot,
			"--ledger-dir",
			fixture.storageDir,
			"--bodies-dir",
			fixture.bodiesDir,
			"--all-rows",
		]);

		expect(run.exitCode).toBe(0);
		const output = run.stdout.toString();
		expect(output).toContain("no_mc_pass_row");
		expect(output).not.toContain("accounted_drop_applied");
	});
});

describe("Pi cache-bust analyzer reclaim pair", () => {
	// Shape of 2026-10-12 15:27:37–15:29:12Z on session 019e8905: the capture
	// extension's file counter ran one ahead of the ledger sequence, the 15:28:51
	// reclaim rewrote m[1] and trimmed the tail, and the 15:29:12 request only
	// appended to it while openai-codex read just the instructions+tools prefix.
	const base = Date.parse("2026-10-12T15:27:37.292Z");
	const reclaim = Date.parse("2026-10-12T15:28:51.740Z");
	const next = Date.parse("2026-10-12T15:29:12.681Z");
	const item = (role: string, text: string) => ({
		role,
		content: [
			{ type: role === "assistant" ? "output_text" : "input_text", text },
		],
	});
	const m0 = item("user", "<project-docs>stable m[0]</project-docs>");
	const oldM1 = item(
		"user",
		"<session-history-since>…I made no file changes.</session-history-since>",
	);
	const newM1 = item(
		"user",
		"<session-history-since>## 38073-38120 · Built and verified</session-history-since>",
	);
	const covered = [
		item("user", "§1§ covered"),
		item("assistant", "§2§ covered answer"),
	];
	const tail = [item("user", "§3§ keep going"), item("assistant", "§4§ going")];
	const appended = [
		item("user", "§5§ next"),
		item("assistant", "§6§ next answer"),
	];
	const bodyInputs = {
		unrecorded: [m0, oldM1, ...covered],
		base: [m0, oldM1, ...covered, ...tail],
		reclaim: [m0, newM1, ...tail],
		next: [m0, newM1, ...tail, ...appended],
	};

	function writeBody(
		directory: string,
		number: number,
		input: unknown[],
		writtenAt: number,
	): void {
		const path = join(directory, `${String(number).padStart(4, "0")}-req.json`);
		writeFileSync(
			path,
			JSON.stringify({
				model: "gpt-6.1-sol",
				instructions: "same instructions",
				input,
			}),
		);
		utimesSync(path, new Date(writtenAt), new Date(writtenAt));
	}

	function fixture(sessionId: string) {
		const sessionRoot = temporaryDirectory("pi-reclaim-pair-session-");
		const storageDir = temporaryDirectory("pi-reclaim-pair-ledger-");
		const bodiesDir = temporaryDirectory("pi-reclaim-pair-bodies-");
		writeJsonl(sessionRoot, "--project--", "reclaim.jsonl", [
			{ type: "session", id: sessionId, cwd: "/unused/by-override" },
			assistant("a-base", new Date(base + 2_000).toISOString(), {
				input: 473,
				cacheRead: 279_760,
				cacheWrite: 0,
			}),
			assistant("a-reclaim", new Date(reclaim + 2_000).toISOString(), {
				input: 173_485,
				cacheRead: 24_448,
				cacheWrite: 0,
			}),
			assistant("a-next", new Date(next + 2_000).toISOString(), {
				input: 174_344,
				cacheRead: 24_448,
				cacheWrite: 0,
			}),
		]);
		// The ledger records each pass's served array; the reclaim pass's array is
		// shorter than the base pass's because it trimmed the covered turn.
		capturePiServedArray(sessionId, bodyInputs.base, {
			storageDir,
			now: new Date(base),
		});
		capturePiServedArray(sessionId, bodyInputs.reclaim, {
			storageDir,
			now: new Date(reclaim),
		});
		capturePiServedArray(sessionId, bodyInputs.next, {
			storageDir,
			now: new Date(next),
		});
		flushPiServedArrayLedger();
		// File numbers run one ahead of ledger sequences 1-3 because of one
		// request the ledger never recorded, written long before the first pass.
		writeBody(bodiesDir, 1, bodyInputs.unrecorded, base - 60_000);
		writeBody(bodiesDir, 2, bodyInputs.base, base + 14);
		writeBody(bodiesDir, 3, bodyInputs.reclaim, reclaim + 9);
		writeBody(bodiesDir, 4, bodyInputs.next, next + 21);
		return { sessionRoot, storageDir, bodiesDir };
	}

	test("joins each pass to the body written right after it, not to the same file number", async () => {
		const sessionId = "pi-reclaim-pair-join";
		const paths = fixture(sessionId);

		const analysis = await analyzePiCacheBustSession({
			sessionId,
			piDir: paths.sessionRoot,
			ompDir: paths.sessionRoot,
			ledgerDir: paths.storageDir,
			bodiesDir: paths.bodiesDir,
			decisions: [],
		});

		const [reclaimRow, nextRow] = analysis.requests.slice(1);
		// The reclaim itself rewrote m[1] (normalized message[2]: message[0] is
		// the instructions), so it is not a provider short read.
		expect(reclaimRow).toMatchObject({ verdict: "BUST" });
		expect(reclaimRow?.firstDivergence).toContain("message[2] role=user");
		expect(reclaimRow?.firstDivergence).toContain("38073-38120");
		expect(reclaimRow?.divergenceClass).not.toBe(
			"provider_short_read_identical_bytes",
		);
		// The next request only appended to the reclaim request, so its short read
		// is the provider's, not a prompt rewrite.
		expect(nextRow?.firstDivergence).toContain("§5§ next");
		expect(nextRow?.divergenceClass).toBe(
			"provider_short_read_identical_bytes",
		);
	});

	test("names the pure append right after a recorded reclaim as a provider short read after reclaim", async () => {
		const sessionId = "pi-reclaim-pair-decision";
		const paths = fixture(sessionId);

		const analysis = await analyzePiCacheBustSession({
			sessionId,
			piDir: paths.sessionRoot,
			ompDir: paths.sessionRoot,
			ledgerDir: paths.storageDir,
			bodiesDir: paths.bodiesDir,
			// The transform_decisions row Pi writes for a completed reclaim pass; it is
			// what lets the analyzer recognise the first bust as a reclaim.
			decisions: [
				{
					timestampMs: reclaim - 3_000,
					messageId: "a-reclaim",
					decision: "execute",
					materialized: false,
					materializeReason: null,
					emergency: false,
					droppedTokens: 80_000,
					droppedCount: 98,
					inputTokens: 281_591,
					flush: false,
					source: "context.db.transform_decisions",
				},
			],
		});

		expect(
			analysis.requests.slice(1).map((row) => [row.divergenceClass, row.cause]),
		).toEqual([
			["accounted_drop_applied", undefined],
			[
				"provider_short_read_after_reclaim",
				"provider_short_read_identical_bytes",
			],
		]);
	});

	test("ignores a body pair that reads as a pure append when the ledger shows a shorter served array", () => {
		const record = (
			sequence: number,
			messageCount: number,
			passTs: number,
		) => ({
			version: 1 as const,
			session_id: "contradiction",
			pass_ts: new Date(passTs).toISOString(),
			sequence,
			message_count: messageCount,
			sha256: String(sequence),
			previous_sha256: null,
			first_divergence_message_index: sequence === 1 ? null : 0,
			block_vector_start: 0,
			block_vectors: [],
		});
		const usage = (timestamp: number, cacheRead: number, input: number) => ({
			timestamp,
			createdAt: new Date(timestamp).toISOString(),
			line: timestamp,
			ordinal: timestamp,
			messageId: String(timestamp),
			input,
			cacheRead,
			cacheWrite: 0,
			total: input + cacheRead,
		});
		const body = (sequence: number, input: unknown[]) => ({
			sequence,
			path: `${sequence}-req.json`,
			writtenAtMs: 0,
			messages: normalizeRequestBody({ instructions: "same", input }, "openai")
				.messages,
		});
		const previous = {
			ledger: record(1, 845, base),
			usage: usage(base + 1_000, 279_760, 473),
			intervening: [],
		};
		const current = {
			ledger: record(2, 589, reclaim),
			usage: usage(reclaim + 1_000, 24_448, 173_485),
			intervening: [],
		};
		// Bodies from the two requests before these passes, as a file-number join
		// would pair them: they read as a pure append although the ledger shrank.
		const bodies = new Map([
			[__test.passBodyKey(previous.ledger), body(1, bodyInputs.unrecorded)],
			[__test.passBodyKey(current.ledger), body(2, bodyInputs.base)],
		]);

		const rows = __test.analyzeJoinedPasses([previous, current], { bodies });

		expect(rows[1].verdict).toBe("BUST");
		expect(rows[1].divergenceClass).not.toBe(
			"provider_short_read_identical_bytes",
		);
		expect(rows[1].attribution).toContain(
			"request bodies contradict the ledger",
		);
	});
});
