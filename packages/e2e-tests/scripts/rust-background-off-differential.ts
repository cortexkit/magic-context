#!/usr/bin/env bun
import { openTestDb } from "../src/test-db";
/**
 * Switch-off differential: with `rust_background_enabled` off, a host must serve
 * byte-identical provider requests, and leave identical dreamer schedule rows,
 * on two refs (a base and a change that only adds Rust background wiring).
 *
 * For each ref this extracts the tree into a throwaway directory, builds the
 * plugin the host loads, boots ONE host, and drives N randomized passes in it.
 * A pass is a fresh session with 1-4 turns; each turn's prompt size and the
 * usage the mock provider reports (which decides whether the next pass defers
 * or executes) come from a seeded generator, so both refs see the same script.
 * Every main-agent request carrying the turn's marker is captured, normalised
 * only for per-run identity (session/message ids, throwaway paths), and
 * compared byte for byte. After the passes the `task_schedule_state` rows of
 * context.db are compared with timestamps reduced to null / present (the two
 * refs run minutes apart, so absolute slot times are not comparable).
 *
 * Usage:
 *   bun packages/e2e-tests/scripts/rust-background-off-differential.ts --host oc1|oc2|pi [--passes 200] [--seed 7] <left-ref> <right-ref>
 * OC1 needs `opencode` (1.x) on PATH. Run with TMPDIR pointed at a throwaway
 * directory: every host root and both extracted trees are created under it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_NAME = "rust-background-off-differential.ts";
const RESULT_PREFIX = "RBG_OFF_DIFF_RESULT=";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function valueAfter(flag: string): string | undefined {
	const index = Bun.argv.indexOf(flag);
	return index === -1 ? undefined : Bun.argv[index + 1];
}
const hostKind = (valueAfter("--host") ?? "pi") as "oc1" | "oc2" | "pi";
const passes = Number(valueAfter("--passes") ?? "200");
const seed = Number(valueAfter("--seed") ?? "7");
// The extracted tree's root when this runs as a single-ref child; otherwise the
// checkout this is run from (the current directory).
const treeRoot = valueAfter("--tree") ?? process.cwd();

type Turn = { pass: number; turn: number; bytes: number; sha256: string; normalized: string };
type Capture = { ref: string; turns: Turn[]; scheduleRows: string[]; transformed: number };

/** Replace per-run identity so two runs of the same code compare equal. */
function normalizer(roots: string[]) {
	const ids = new Map<string, string>();
	const mapped = (match: string, kind: string) => {
		let value = ids.get(match);
		if (!value) {
			value = `<${kind}#${ids.size}>`;
			ids.set(match, value);
		}
		return value;
	};
	return (text: string): string => {
		let out = text;
		for (const root of roots.filter(Boolean).sort((a, b) => b.length - a.length))
			out = out.split(root).join("<ROOT>");
		out = out.replace(
			/\b(ses|msg|prt|call|toolu|evt|cmp|resp|fc|rs)_[A-Za-z0-9_]{6,}/g,
			(match) => mapped(match, match.split("_")[0]!),
		);
		// A directory project identity is a hash of the throwaway workdir path.
		out = out.replace(/\bdir:[0-9a-f]{12}\b/g, (m) => mapped(m, "dir"));
		return out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (m) =>
			mapped(m, "uuid"),
		);
	};
}

/** mulberry32: a small seeded generator, identical on both refs. */
function generator(start: number) {
	let state = start >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORDS = ["boundary", "historian", "compartment", "schedule", "pressure", "tokens",
	"window", "publish", "transform", "session", "marker", "budget", "eligible", "dream"];
function ballast(tokens: number, random: () => number): string {
	const parts: string[] = [];
	let length = 0;
	while (length < tokens * 4) {
		const word = WORDS[Math.floor(random() * WORDS.length)]!;
		parts.push(random() < 0.06 ? `${word}.` : word);
		length += word.length + 1;
	}
	return parts.join(" ");
}

type Step = { pass: number; turn: number; marker: string; text: string; usage: number };
function script(): Step[] {
	const random = generator(seed);
	const steps: Step[] = [];
	for (let pass = 0; pass < passes; pass += 1) {
		const turns = 1 + Math.floor(random() * 4);
		for (let turn = 0; turn < turns; turn += 1) {
			const tokens = [10, 300, 1_500][Math.floor(random() * 3)]!;
			const usage = [1_000, 5_000, 12_000, 23_000][Math.floor(random() * 4)]!;
			const marker = `[[rbg-off-${pass}-${turn}]]`;
			steps.push({ pass, turn, marker, text: `${marker} ${ballast(tokens, random)}`, usage });
		}
	}
	return steps;
}

// Rust background explicitly off; the dreamer and memory stay on so the dreamer
// keeps its schedule rows. Historian and the other model-backed features stay
// off so every provider request is a main-agent turn.
const MC_CONFIG = {
	rust_background_enabled: false,
	memory: { enabled: true, auto_search: { enabled: false } },
	dreamer: { inject_docs: false },
	historian: { disable: true },
	temporal_awareness: false,
	compressor: { enabled: false },
	execute_threshold_percentage: 40,
	history_budget_percentage: 0.15,
};

function lastRequestWith(requests: Array<{ body: Record<string, unknown> }>, marker: string) {
	return [...requests].reverse().find((r) => JSON.stringify(r.body).includes(marker));
}

/** task_schedule_state with timestamps reduced to null / present. */
async function scheduleRows(contextDb: string, normalize: (t: string) => string): Promise<string[]> {
	if (!existsSync(contextDb)) return ["<no context.db>"];
	const db = openTestDb(contextDb, { readonly: true });
	try {
		const rows = db
			.prepare("SELECT * FROM task_schedule_state ORDER BY project_path, task")
			.all() as Array<Record<string, unknown>>;
		return rows.map((row) =>
			normalize(
				JSON.stringify(
					Object.fromEntries(
						Object.entries(row).map(([key, value]) => [
							key,
							/_at(_ms)?$|watermark/.test(key) && typeof value === "number"
								? "<time>"
								: value,
						]),
					),
				),
			),
		);
	} finally {
		db.close();
	}
}

function findContextDb(root: string): string {
	const pending = [root];
	while (pending.length > 0) {
		const dir = pending.pop()!;
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of entries) {
			const path = join(dir, name);
			if (name === "context.db" && dir.endsWith(join("cortexkit", "magic-context"))) return path;
			try {
				if (statSync(path).isDirectory() && name !== "node_modules") pending.push(path);
			} catch {}
		}
	}
	return join(root, "<missing>/context.db");
}

/** One pass loop over a booted host: each pass opens a session and sends its turns. */
async function drive(
	steps: Step[],
	setUsage: (usage: number) => void,
	newSession: () => Promise<string>,
	send: (session: string, text: string) => Promise<void>,
	requests: () => Array<{ body: Record<string, unknown> }>,
	normalize: (text: string) => string,
	afterFirstPass: () => Promise<void>,
): Promise<Turn[]> {
	const turns: Turn[] = [];
	let session = "";
	let currentPass = -1;
	for (const step of steps) {
		if (step.pass !== currentPass) {
			if (currentPass === 0) await afterFirstPass();
			currentPass = step.pass;
			session = await newSession();
		}
		await send(session, step.text);
		const request = lastRequestWith(requests(), step.marker);
		const wire = request ? JSON.stringify(request.body) : "";
		const normalized = request ? normalize(wire) : "NO-PROVIDER-REQUEST";
		turns.push({
			pass: step.pass,
			turn: step.turn,
			bytes: Buffer.byteLength(wire),
			sha256: sha(normalized),
			normalized,
		});
		// The usage the provider reports for this turn decides the next pass.
		setUsage(step.usage);
	}
	return turns;
}

const transformedCount = (turns: Turn[]) =>
	turns.filter((t) => /<session-history>|<conversation-checkpoint>|§\d+§/.test(t.normalized)).length;

/**
 * Give the project one memory after the first pass, so the dreamer's startup
 * pass (two minutes after boot) has input and seeds its memory-task schedule
 * rows. Uses the extracted tree's own storage code and project identity.
 */
async function seedMemory(contextDb: string, directory: string): Promise<void> {
	const { resolveProjectIdentity } = await import(
		"../../plugin/src/features/magic-context/memory/project-identity"
	);
	const { insertMemory } = await import("../../plugin/src/features/magic-context/memory/storage-memory");
	const db = openTestDb(contextDb);
	try {
		db.exec("PRAGMA busy_timeout = 10000");
		insertMemory(db as never, {
			projectPath: resolveProjectIdentity(directory),
			category: "ARCHITECTURE",
			content: "The cache drops its least recently used entry first.",
		});
	} finally {
		db.close();
	}
}

/**
 * Wait for the dreamer's startup pass to have seeded schedule rows (it runs a
 * boot quiet period after the host starts), then read them. Gives up after six
 * minutes from boot, so a ref that never seeds shows as an empty row list.
 */
async function settledScheduleRows(
	contextDb: string,
	bootedAt: number,
	normalize: (text: string) => string,
): Promise<string[]> {
	for (;;) {
		const rows = await scheduleRows(contextDb, normalize);
		const seeded = rows.length > 0 && rows[0] !== "<no context.db>";
		if (seeded || Date.now() - bootedAt > 6 * 60_000) {
			// Let a pass that is still seeding finish its writes.
			await Bun.sleep(5_000);
			return scheduleRows(contextDb, normalize);
		}
		await Bun.sleep(5_000);
	}
}

async function captureOc1(ref: string): Promise<Capture> {
	const { TestHarness } = await import("../src/harness");
	let usage = 1_000;
	const harness = await TestHarness.create({ modelContextLimit: 24_000, magicContextConfig: MC_CONFIG });
	const bootedAt = Date.now();
	harness.mock.addMatcher(() => ({ text: "ok", usage: { input_tokens: usage, output_tokens: 20 } }));
	const normalize = normalizer([harness.dataDir, harness.workdir]);
	try {
		const turns = await drive(
			script(),
			(next) => {
				usage = next;
			},
			() => harness.createSession(),
			async (session, text) => {
				await harness.sendPrompt(session, text);
			},
			() => harness.mock.requests(),
			normalize,
			() => seedMemory(harness.contextDbPath(), harness.workdir),
		);
		const scheduleRowsNow = await settledScheduleRows(harness.contextDbPath(), bootedAt, normalize);
		return { ref, turns, scheduleRows: scheduleRowsNow, transformed: transformedCount(turns) };
	} finally {
		await harness.dispose();
	}
}

async function capturePi(ref: string): Promise<Capture> {
	const { PiTestHarness } = await import("../src/pi-harness");
	let usage = 1_000;
	const harness = await PiTestHarness.create({ modelContextLimit: 24_000, magicContextConfig: MC_CONFIG });
	const bootedAt = Date.now();
	harness.mock.addMatcher(() => ({ text: "ok", usage: { input_tokens: usage, output_tokens: 20 } }));
	const normalize = normalizer([harness.env.baseDir, harness.env.workdir]);
	try {
		const turns = await drive(
			script(),
			(next) => {
				usage = next;
			},
			() => harness.createSession(),
			async (session, text) => {
				await harness.sendPrompt(session, text);
			},
			() => harness.mock.requests(),
			normalize,
			() => seedMemory(harness.contextDbPath(), harness.env.workdir),
		);
		const scheduleRowsNow = await settledScheduleRows(harness.contextDbPath(), bootedAt, normalize);
		return { ref, turns, scheduleRows: scheduleRowsNow, transformed: transformedCount(turns) };
	} finally {
		await harness.dispose();
	}
}

async function captureOc2(ref: string): Promise<Capture> {
	const { isolation, spawnOpencode2 } = await import("../src/opencode2-runner/spawn");
	const { OpenCode } = await import("@opencode/client");
	const fixture = isolation();
	let usage = 1_000;
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		modelContextLimit: 24_000,
		modelOutputLimit: 1_024,
		magicContextConfig: MC_CONFIG,
	});
	const bootedAt = Date.now();
	host.mock.addMatcher(() => ({ text: "ok", usage: { input_tokens: usage, output_tokens: 20 } }));
	const normalize = normalizer([fixture.root, host.cwd, fixture.env.XDG_DATA_HOME!]);
	const client = OpenCode.make({
		baseUrl: host.url,
		headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
	});
	try {
		const turns = await drive(
			script(),
			(next) => {
				usage = next;
			},
			async () =>
				(
					await client.session.create({
						location: { directory: host.cwd },
						model: { providerID: "openai", id: "mock-model" },
					})
				).id,
			async (session, text) => {
				await client.session.prompt({ sessionID: session, text });
				await client.session.wait({ sessionID: session }, { signal: AbortSignal.timeout(180_000) });
			},
			() => host.mock.requests(),
			normalize,
			() => seedMemory(findContextDb(fixture.root), host.cwd),
		);
		const scheduleRowsNow = await settledScheduleRows(findContextDb(fixture.root), bootedAt, normalize);
		return { ref, turns, scheduleRows: scheduleRowsNow, transformed: transformedCount(turns) };
	} finally {
		await host.stop();
	}
}

function extractAndBuild(ref: string, destination: string): void {
	mkdirSync(destination, { recursive: true });
	const archive = execFileSync("git", ["archive", "--format=tar", ref], {
		cwd: treeRoot,
		maxBuffer: 512 * 1024 * 1024,
	});
	execFileSync("tar", ["-xf", "-", "-C", destination], { input: archive, maxBuffer: 512 * 1024 * 1024 });
	if (existsSync(join(treeRoot, "node_modules")))
		symlinkSync(join(treeRoot, "node_modules"), join(destination, "node_modules"), "dir");
	for (const name of ["e2e-tests", "plugin", "pi-plugin", "retina-local-fs"]) {
		const source = join(treeRoot, "packages", name, "node_modules");
		if (existsSync(source)) symlinkSync(source, join(destination, "packages", name, "node_modules"), "dir");
	}
	copyFileSync(SCRIPT_PATH, join(destination, "packages/e2e-tests/scripts", SCRIPT_NAME));
	const build = (cwd: string) => {
		const child = spawnSync(process.execPath, ["run", "build"], {
			cwd,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
		if (child.status !== 0) throw new Error(`build failed in ${cwd}\n${child.stdout}\n${child.stderr}`);
	};
	build(join(destination, hostKind === "pi" ? "packages/pi-plugin" : "packages/plugin"));
}

const singleRef = valueAfter("--single-ref");
if (singleRef) {
	const result =
		hostKind === "oc1"
			? await captureOc1(singleRef)
			: hostKind === "oc2"
				? await captureOc2(singleRef)
				: await capturePi(singleRef);
	// A host that never loaded the plugin serves the raw conversation, and two raw
	// conversations compare equal for the wrong reason. Refuse that outcome.
	if (result.transformed === 0)
		throw new Error(`Magic Context never transformed a request on ${singleRef}; the plugin did not load`);
	console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
	process.exit(0);
}

const refs = Bun.argv
	.slice(2)
	.filter((arg, index, all) => !arg.startsWith("--") && !all[index - 1]?.startsWith("--"));
if (refs.length !== 2) {
	console.error(`usage: ${SCRIPT_NAME} --host oc1|oc2|pi [--passes N] [--seed S] <left-ref> <right-ref>`);
	process.exit(2);
}
const sharedRoot = mkdtempSync(join(tmpdir(), `rbg-off-diff-${hostKind}-`));
const captures: Capture[] = [];
try {
	for (const [slot, ref] of [
		["left", refs[0]!],
		["right", refs[1]!],
	] as const) {
		const destination = join(sharedRoot, slot);
		extractAndBuild(ref, destination);
		const started = Date.now();
		const child = spawnSync(
			process.execPath,
			[
				`packages/e2e-tests/scripts/${SCRIPT_NAME}`,
				"--host",
				hostKind,
				"--passes",
				String(passes),
				"--seed",
				String(seed),
				"--tree",
				destination,
				"--single-ref",
				ref,
			],
			{ cwd: destination, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, env: process.env },
		);
		const line = child.stdout.split("\n").find((entry) => entry.startsWith(RESULT_PREFIX));
		if (child.status !== 0 || !line)
			throw new Error(`capture failed for ${ref}\n${child.stdout.slice(-4000)}\n${child.stderr.slice(-4000)}`);
		const capture = JSON.parse(line.slice(RESULT_PREFIX.length)) as Capture;
		console.log(
			`CAPTURED ${slot} ${ref} turns=${capture.turns.length} transformed=${capture.transformed} schedule_rows=${capture.scheduleRows.length} seconds=${Math.round((Date.now() - started) / 1000)}`,
		);
		captures.push(capture);
	}
	const [left, right] = captures as [Capture, Capture];
	let divergent = 0;
	const count = Math.max(left.turns.length, right.turns.length);
	for (let index = 0; index < count; index += 1) {
		const l = left.turns[index];
		const r = right.turns[index];
		if (l && r && l.sha256 === r.sha256 && l.pass === r.pass && l.turn === r.turn) continue;
		divergent += 1;
		if (divergent <= 5) {
			console.log(`DIVERGENT pass=${l?.pass ?? r?.pass} turn=${l?.turn ?? r?.turn} left_bytes=${l?.bytes} right_bytes=${r?.bytes}`);
			if (l && r) {
				let at = 0;
				while (at < l.normalized.length && l.normalized[at] === r.normalized[at]) at += 1;
				console.log(`  left : ${l.normalized.slice(Math.max(0, at - 120), at + 200)}\n  right: ${r.normalized.slice(Math.max(0, at - 120), at + 200)}`);
			}
		}
	}
	const noRequest = left.turns.filter((t) => t.normalized === "NO-PROVIDER-REQUEST").length;
	const passesSeen = new Set(left.turns.map((t) => t.pass)).size;
	console.log(`REQUESTS compared=${count} divergent=${divergent} passes=${passesSeen} left_no_request=${noRequest}`);
	const rowsSame = JSON.stringify(left.scheduleRows) === JSON.stringify(right.scheduleRows);
	console.log(`SCHEDULE ROWS ${rowsSame ? "IDENTICAL" : "DIVERGENT"} left=${JSON.stringify(left.scheduleRows)} right=${JSON.stringify(right.scheduleRows)}`);
	const identical = divergent === 0 && rowsSame && left.turns.length === right.turns.length;
	console.log(`RESULT ${identical ? "IDENTICAL" : "DIVERGENT"} host=${hostKind} passes=${passes} seed=${seed}`);
	process.exitCode = identical ? 0 : 1;
} finally {
	if (!process.env.KEEP_DIFF_ROOT) rmSync(sharedRoot, { recursive: true, force: true });
	else console.log(`kept ${sharedRoot}`);
}
