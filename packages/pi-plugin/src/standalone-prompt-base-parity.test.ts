import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	cleanupTestTempDir,
	createTestTempDir,
} from "@magic-context/core/shared/test-temp-dir";
import { standaloneParitySequences } from "./fixtures/standalone-prompt-parity-cases";

const BASE_HANDLER_SHA256 =
	"c2bc50b99ebbec58802e9b4580ef4f2f988976ad015a35a41abd370b5537a0cd";
const BASE_HELPER_SHA256 =
	"feb4918e54f132a4bf385a8aff324f1016ae1dafa05b4085e3ae2c2b487f0d93";
const sha = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

// The callback excerpt and complete cache helper are unformatted git-show bytes,
// not a rewritten legacy renderer. The callback is from
// 3debe36204b0605bfe881d613777781c557e330f and is unchanged through master
// 9d4fb56b. The helper is from 9d4fb56b (release 0.49.44): it is 3debe36's
// helper with the 0.49.44 date rule, under which an expired provider cache no
// longer lets the date move, so the base follows the same rule as the extraction.

test("standalone parity fixtures pin the verbatim base registered hook and cache helper", () => {
	expect(
		sha(
			readFileSync(
				join(import.meta.dir, "fixtures/before-agent-start-3debe36.ts.txt"),
			),
		),
	).toBe(BASE_HANDLER_SHA256);
	expect(
		sha(
			readFileSync(
				join(import.meta.dir, "fixtures/system-prompt-9d4fb56b.ts.txt"),
			),
		),
	).toBe(BASE_HELPER_SHA256);
});

interface WorkerSummary {
	host: string;
	sequences: number;
	turns: number;
	events: number;
	confirmedSwitches: number;
	canceledSwitches: number;
	hookCalls: number;
	traceDigest: string;
	inputDigest: string;
	handlerDigest: string;
	helperDigest: string;
}

async function run(
	root: string,
	revision: "base" | "current",
	host: "pi" | "omp",
	sequences: ReturnType<typeof standaloneParitySequences>,
) {
	mkdirSync(root, { recursive: true });
	const path = join(root, "input.json");
	writeFileSync(path, JSON.stringify({ root, revision, host, sequences }));
	const child = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "fixtures/standalone-prompt-parity-worker.ts"),
			path,
		],
		{
			windowsHide: true,
			cwd: join(import.meta.dir, ".."),
			env: {
				...process.env,
				MAGIC_CONTEXT_TEST_DATA_DIR: root,
				XDG_DATA_HOME: root,
				XDG_CONFIG_HOME: join(root, "config"),
				MAGIC_CONTEXT_CONFIG_PATH: join(
					root,
					"config/cortexkit/magic-context.json",
				),
				XDG_CACHE_HOME: join(root, "cache"),
				MAGIC_CONTEXT_STORAGE_DIR: join(root, "storage"),
				OPENCODE_DB: join(root, "no-opencode.db"),
				MAGIC_CONTEXT_PI_SUBAGENT: "",
				TZ: "UTC",
				RUSTC_WRAPPER: "",
				CARGO_BUILD_RUSTC_WRAPPER: "",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exit !== 0)
		throw new Error(
			`Parity worker ${revision}/${host} exited ${exit}: ${stderr}\n${stdout}`,
		);
	const line = stdout
		.split("\n")
		.find((row) => row.startsWith("STANDALONE_PARITY_WORKER "));
	if (!line)
		throw new Error(
			`Parity worker ${revision}/${host} returned no summary: ${stdout}`,
		);
	return JSON.parse(
		line.slice("STANDALONE_PARITY_WORKER ".length),
	) as WorkerSummary;
}

/** Compare the actual transcript bytes, not just a digest or a reconstructed expectation. */
function compareEveryStep(base: Buffer, current: Buffer, host: string) {
	if (base.equals(current)) return;
	const oldRows = base.toString("utf8").trimEnd().split("\n");
	const newRows = current.toString("utf8").trimEnd().split("\n");
	const index = oldRows.findIndex((row, at) => row !== newRows[at]);
	const old = JSON.parse(oldRows[index] ?? "null") as Record<
		string,
		unknown
	> | null;
	const next = JSON.parse(newRows[index] ?? "null") as Record<
		string,
		unknown
	> | null;
	const fields = new Set([
		...Object.keys(old ?? {}),
		...Object.keys(next ?? {}),
	]);
	const field = [...fields].find(
		(key) => JSON.stringify(old?.[key]) !== JSON.stringify(next?.[key]),
	);
	throw new Error(
		`STANDALONE_BASE_DIFFERENTIAL_MISMATCH ${JSON.stringify({
			host,
			index,
			seed: old?.seed,
			field,
			base: JSON.stringify(field ? old?.[field] : old)?.slice(0, 1600),
			current: JSON.stringify(field ? next?.[field] : next)?.slice(0, 1600),
		})}`,
	);
}

test("standalone extraction preserves base bytes and state across 320 randomized sequences per host", async () => {
	const root = createTestTempDir("standalone-base-parity-").dir;
	const sequences = standaloneParitySequences();
	expect(sequences).toHaveLength(320);
	const profiles = sequences.flatMap((sequence) => sequence.profiles);
	const flags = [
		"injection",
		"skip",
		"memory",
		"temporal",
		"caveman",
		"dreamer",
		"smartNotes",
		"compaction",
		"override",
	] as const;
	for (const flag of flags)
		expect(new Set(profiles.map((profile) => profile[flag]))).toEqual(
			new Set([true, false]),
		);
	console.log(
		"STANDALONE_BASE_PARITY_INPUTS",
		JSON.stringify({
			profiles: profiles.length,
			flags: Object.fromEntries(
				flags.map((flag) => [
					flag,
					{
						on: profiles.filter((profile) => profile[flag]).length,
						off: profiles.filter((profile) => !profile[flag]).length,
					},
				]),
			),
			languages: [
				...new Set(profiles.map((profile) => profile.language ?? "default")),
			].sort(),
			emptyBases: sequences
				.flatMap((sequence) => sequence.turns)
				.filter((turn) => turn.base === "").length,
		}),
	);
	try {
		for (const host of ["pi", "omp"] as const) {
			const baseRoot = join(root, host, "base");
			const currentRoot = join(root, host, "current");
			const base = await run(baseRoot, "base", host, sequences);
			const current = await run(currentRoot, "current", host, sequences);
			expect(base.handlerDigest).toBe(BASE_HANDLER_SHA256);
			expect(base.helperDigest).toBe(BASE_HELPER_SHA256);
			for (const summary of [base, current]) {
				expect(summary.sequences).toBe(320);
				expect(summary.turns).toBe(3840);
				expect(summary.hookCalls).toBe(3840);
				expect(summary.events).toBe(5760);
				expect(summary.confirmedSwitches).toBe(640);
				expect(summary.canceledSwitches).toBe(320);
			}
			compareEveryStep(
				readFileSync(join(baseRoot, "trace.ndjson")),
				readFileSync(join(currentRoot, "trace.ndjson")),
				host,
			);
			expect(current.traceDigest).toBe(base.traceDigest);
			expect(current.inputDigest).toBe(base.inputDigest);
			console.log(
				"STANDALONE_BASE_PARITY",
				JSON.stringify({
					host,
					sequences: base.sequences,
					turns: base.turns,
					events: base.events,
					confirmedSwitches: base.confirmedSwitches,
					canceledSwitches: base.canceledSwitches,
					inputDigest: base.inputDigest,
					baseTraceDigest: base.traceDigest,
					currentTraceDigest: current.traceDigest,
				}),
			);
		}
	} finally {
		cleanupTestTempDir(root);
	}
}, 600_000);
