import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	cpSync,
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	readdirSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	firstDifference,
	integrity,
	inventory,
	snapshotRoot,
	version,
	versionAfterCrash,
	hashFile,
} from "./lib/upgrade-audit";

import { EFFECTS, CONTEXT_CRASH_VERSIONS, STORE_CRASH_VERSIONS, assertEffects, assertCrashCoverage, assertBundles, assertDoctor, assertFullDoctorTarget, assertMigrationMetrics, assertArtifactIdentity, type MigrationMetric } from "./lib/upgrade-contract";
import type { PayloadProof } from "./lib/upgrade-payloads";
import { HOSTS, assertHostCoverage } from "./lib/upgrade-seats";
import { openInterval, type OpenInterval } from "./lib/upgrade-roots";
import { assertApplicationSchema, LEGACY_TABLES, LEGACY_COLUMNS, LEGACY_INDEXES } from "./lib/upgrade-schema";

const repo = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	if (!args[index + 1] || args[index + 1].startsWith("--"))
		throw new Error(`${name} needs a value`);
	return args[index + 1];
};
if (args.includes("--help")) {
	console.log(
		"bun scripts/rehearse-upgrade.ts [--snapshot <offline-pair-directory>] [--release-archive <v0.49.7.tar>] [--report <markdown-path>] [--artifacts <prebuilt-directory>] [--candidate <full-git-sha>] [--export-artifacts <directory>]\nRequires Linux, Bun and GNU /usr/bin/time. Cargo offline dependencies are needed unless --artifacts is supplied. --candidate is required with prebuilt artifacts when Git metadata is not mounted. All execution and stores live under $TMPDIR/magic-context/rehearsal-early/run-*/.",
	);
	process.exit(0);
}
for (let i = 0; i < args.length; i += 2)
	if (!["--snapshot", "--release-archive", "--report", "--artifacts", "--candidate", "--export-artifacts"].includes(args[i]))
		throw new Error(`Unknown option ${args[i]}`);
// Resolve and reject live locations before changing HOME for child processes.
const snapshot = option("--snapshot")
	? snapshotRoot(option("--snapshot")!)
	: undefined;
const artifacts = option("--artifacts") ? resolve(option("--artifacts")!) : undefined;
if (option("--candidate") && !artifacts) throw new Error("--candidate is only valid with --artifacts");
if (snapshot && option("--export-artifacts")) throw new Error("Export binaries only from a synthetic run, never from private snapshot execution");
const parent = join(tmpdir(), "magic-context", "rehearsal-early");
mkdirSync(parent, { recursive: true });
const root = realpathSync(mkdtempSync(join(parent, "run-")));
const oldTree = join(root, "release");
const baseline = join(root, "baseline");
const host = join(repo, "scripts/lib/upgrade-host.ts");
const reportPath = resolve(
	option("--report") ??
		join(
			repo,
			".cortexkit/internal-docs/investigations",
			`upgrade-rehearsal-${new Date().toISOString().slice(0, 10)}.md`,
		),
);
const steps: {
	name: string;
	seconds: number;
	peakKiB: number;
	exit: number;
	output: string;
}[] = [];
const findings: string[] = [];
const evidence: Record<string, unknown> = {
	root,
	snapshot: snapshot ?? "synthetic v0.49.7",
	candidate: "",
	checks: {},
	versions: {},
	toolchain: {},
	tables: {},
	integrity: {},
	fingerprints: {},
	crashes: [],
	prompts: [],
	refusals: [],
	preservation: [],
	storeOpens: [],
	schemaCompatibility: [],
	doctor: [],
};
const env: NodeJS.ProcessEnv = {
	...process.env,
	HOME: join(root, "home"),
	XDG_DATA_HOME: join(root, "data"),
	XDG_CONFIG_HOME: join(root, "config"),
	XDG_STATE_HOME: join(root, "state"),
	XDG_CACHE_HOME: join(root, "cache"),
	XDG_RUNTIME_DIR: join(root, "runtime"),
	MAGIC_CONTEXT_STORAGE_DIR: baseline,
	OPENCODE_DB: join(root, "unused-opencode.db"),
	MAGIC_CONTEXT_LOG_PATH: join(root, "rehearsal.log"),
	NODE_ENV: "test",
	RUSTC_WRAPPER: "",
	CARGO_BUILD_RUSTC_WRAPPER: "",
};
// Cargo's dependency cache is an input, not the isolated runtime HOME.
env.CARGO_HOME = process.env.CARGO_HOME ?? join(process.env.HOME!, ".cargo");
env.RUSTUP_HOME = process.env.RUSTUP_HOME ?? join(process.env.HOME!, ".rustup");
delete env.SUBC_MODULE_ID;
delete env.SUBC_LAUNCH_NONCE;
delete env.SUBC_LAUNCH_NONCE_FD;
for (const dir of [oldTree, baseline, env.HOME, env.XDG_RUNTIME_DIR])
	mkdirSync(dir!, { recursive: true, mode: 0o700 });

function run(
	name: string,
	command: string[],
	cwd = repo,
	extra: Record<string, string> = {},
	allowedFailure = false,
): string {
	const usage = join(root, `${steps.length}-usage.txt`);
	const result = spawnSync(
		artifacts ? join(artifacts, "gnu-time") : "/usr/bin/time",
		["-f", "%e %M", "-o", usage, ...command],
		{
			cwd,
			env: { ...env, ...extra },
			encoding: "utf8",
			timeout: 1_200_000,
			maxBuffer: 32 * 1024 * 1024,
		},
	);
	const text = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error}` : ""}`;
	const metrics = existsSync(usage)
		? readFileSync(usage, "utf8")
				.trim()
				.split("\n")
				.at(-1)!
				.split(" ")
				.map(Number)
		: [NaN, NaN];
	const step = {
		name,
		seconds: metrics[0],
		peakKiB: metrics[1],
		exit: result.status ?? -1,
		output: text,
	};
	steps.push(step);
	writeFileSync(
		join(root, `${steps.length}-${name.replaceAll(/[^a-z0-9-]/gi, "_")}.log`),
		text,
	);
	console.log(
		`${name}: ${step.seconds}s, peak ${step.peakKiB} KiB, exit ${step.exit}`,
	);
	if (step.exit !== 0 && !allowedFailure)
		throw new Error(`${name}: exit ${step.exit}\n${text.slice(-5000)}`);
	return result.stdout ?? "";
}

function pairCopy(source: string, name: string): string {
	const dest = join(root, name);
	mkdirSync(dest, { recursive: true, mode: 0o700 });
	for (const db of ["context.db", "store.db"])
		copyFileSync(join(source, db), join(dest, db), constants.COPYFILE_FICLONE);
	return dest;
}

function check(label: string, body: () => void): boolean {
	try {
		body();
		(evidence.checks as Record<string, string>)[label] = "passed";
		console.log(`${label}: passed`);
		return true;
	} catch (error) {
		(evidence.checks as Record<string, string>)[label] = "finding";
		findings.push(`${label}: ${String(error)}`);
		console.log(`${label}: finding`);
		return false;
	}
}

function hash(path: string): string {
	return hashFile(path);
}
function fileHashes(dir: string): Record<string, string> {
	return Object.fromEntries(
		["context.db", "store.db", "context.db-wal", "store.db-wal"]
			.filter((f) => existsSync(join(dir, f)))
			.map((f) => [f, hash(join(dir, f))]),
	);
}
function assertPreserved(before: string, after: string, storeBefore = before): void {
	if (!storeOpens.has(after)) throw new Error(`Missing McStore opener clock interval: ${after}`);
	for (const name of ["context.db", "store.db"]) {
		const proof = { payloads: [] as PayloadProof[], tables: [] as {name: string; rows: number; sha256: string}[] };
		const difference = firstDifference(join(name === "store.db" ? storeBefore : before, name), join(after, name), undefined, proof, name === "store.db" ? storeOpens.get(after) : undefined);
		(evidence.preservation as unknown[]).push({ route: after.split("/").at(-1), database: name, ...proof });
		if (difference)
			throw new Error(
				`${name} migrations ${name === "context.db" ? "96+" : "64+"}: ${difference}`,
			);
	}
}

type Fingerprints = {
	context: string;
	store: string;
	context_version: number;
	store_version: number;
	context_schema: unknown;
	store_schema: unknown;
};
let helper = "";
const storeOpens = new Map<string, OpenInterval>();
function openStore(step: string, dir: string): void {
	const interval = openInterval(run(step, [helper, "store", dir]));
	storeOpens.set(dir, interval);
	(evidence.storeOpens as unknown[]).push({ step, route: dir.split("/").at(-1), ...interval });
}
function fingerprints(dir: string): Fingerprints {
	return JSON.parse(
		run(`fingerprint-${dir.split("/").at(-1)}`, [helper, "fingerprint", dir]),
	);
}
function assertFingerprint(expected: Fingerprints, actual: Fingerprints): void {
	const differences: string[] = [];
	for (const db of ["context", "store"] as const) {
		if (expected[db] === actual[db]) continue;
		const left = expected[`${db}_schema`] as {
			master: unknown[][];
			tables: { name: string; columns: unknown[][] }[];
		};
		const right = actual[`${db}_schema`] as typeof left;
		const object = left.master.find(
			(row) =>
				JSON.stringify(row) !==
				JSON.stringify(
					right.master.find((next) => next[0] === row[0] && next[1] === row[1]),
				),
		);
		const table = left.tables.find(
			(row) =>
				JSON.stringify(row.columns) !==
				JSON.stringify(
					right.tables.find((next) => next.name === row.name)?.columns,
				),
		);
		const next = right.tables.find((row) => row.name === table?.name);
		const namePosition = db === "context" ? 0 : 1;
		const names = new Set([
			...(table?.columns ?? []).map((row) => row[namePosition]),
			...(next?.columns ?? []).map((row) => row[namePosition]),
		]);
		const name = [...names].find(
			(name) =>
				JSON.stringify(table?.columns.find((row) => row[namePosition] === name)) !==
				JSON.stringify(next?.columns.find((row) => row[namePosition] === name)),
		);
		const column = table?.columns.find((row) => row[namePosition] === name);
		const nextColumn = next?.columns.find((row) => row[namePosition] === name);
		differences.push(
			`${db}.db fingerprint ${actual[db]} != reference ${expected[db]}; first differing schema object ${object?.[0]}/${object?.[1]}, table ${table?.name}, column ${String(name)}: reference=${JSON.stringify(column)} upgraded=${JSON.stringify(nextColumn)}. Cause requires migration review.`,
		);
	}
	if (differences.length) throw new Error(differences.join("; "));
}

async function crash(
	name: string,
	command: string[],
	dir: string,
	migration: number,
	dbName = "context.db",
): Promise<void> {
	const started = performance.now();
	const marker = join(dir, "crash-ready");
	rmSync(marker, {force: true});
	const child = Bun.spawn(command, {
		env: {
			...env,
			MAGIC_CONTEXT_STORAGE_DIR: dir,
			REHEARSAL_ROOT: dir,
			REHEARSAL_CRASH_VERSION: String(migration),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	const deadline = performance.now() + 30_000;
	// Wait for a transaction-internal barrier, not an estimated startup delay.
	while (
		!existsSync(marker) &&
		child.exitCode === null &&
		performance.now() < deadline
	)
		await Bun.sleep(10);
	const reached = existsSync(marker);
	const aliveAtBarrier = child.exitCode === null;
	const status = existsSync(`/proc/${child.pid}/status`)
		? readFileSync(`/proc/${child.pid}/status`, "utf8")
		: "";
	const peakKiB = Number(status.match(/VmHWM:\s+(\d+)/)?.[1] ?? 0);
	child.kill("SIGKILL");
	await child.exited;
	const text = `${await stdout}${await stderr}`;
	writeFileSync(join(dir, "crash.log"), text);
	steps.push({
		name: `kill-${name}-${migration}`,
		seconds: (performance.now() - started) / 1000,
		peakKiB,
		exit: -9,
		output: text,
	});
	if (!reached || !aliveAtBarrier || child.signalCode !== "SIGKILL")
		throw new Error(
			`${name} migration ${migration}: transaction barrier not reached; ${text.slice(-2000)}`,
		);
	const barrier = readFileSync(marker, "utf8");
	if (!barrier.includes(`${dbName} migration ${migration}`)) throw new Error(`Wrong crash barrier: ${barrier}`);
	const recorded = versionAfterCrash(join(dir, dbName));
	if (recorded !== migration - 1)
		throw new Error(
			`${name}: barrier transaction unexpectedly committed v${recorded}`,
		);
	(evidence.crashes as unknown[]).push({
		name,
		migration,
		barrier,
		signal: "SIGKILL",
		recordedAfterKill: recorded,
		complete: false,
	});
}

function writeReport(): void {
	evidence.steps = steps;
	evidence.findings = findings;
	writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
	const summaryFingerprints = Object.fromEntries(
		Object.entries(evidence.fingerprints as Record<string, Fingerprints>).map(
			([name, fp]) => [
				name,
				{
					context: fp.context,
					store: fp.store,
					context_version: fp.context_version,
					store_version: fp.store_version,
				},
			],
		),
	);
	const lines = [
		"# Upgrade rehearsal",
		"",
		`Date: ${new Date().toISOString()}`,
		`Candidate: ${evidence.candidate}`,
		"Release source: v0.49.7 (context 95 / store 63)",
		`Input: ${snapshot ?? "synthetic"}`,
		`Temporary execution root (removed after recording this report): ${root}`,
		`Safety findings: ${findings.length}`,
		"",
		"## Measurements",
		"",
		"| Step | Wall seconds | Peak RSS KiB | Exit |",
		"| --- | ---: | ---: | ---: |",
		...steps.map(
			(s) => `| ${s.name} | ${s.seconds} | ${s.peakKiB} | ${s.exit} |`,
		),
		"",
		"Peak RSS is GNU time's maximum resident set for each child process (builds include descendants), not incremental memory. Migration timings include process startup/open/checkpoint; fixture, compilation, rendering and audit timings are separate.",
		"",
		"## Intended migration effects",
		"",
		...Object.entries(EFFECTS).flatMap(([kind, effects]) => Object.entries(effects).map(([version, effect]) => `- ${kind} ${version}: ${effect}.`)),
		"",
		"## Coverage",
		"",
		"TypeScript owns context.db migration on first host open; Rust McStore owns store.db on both paired routes. The other route uses Rust context_schema::migrations_legacy::upgrade. Fresh context bootstraps are independently produced by TypeScript and Rust. Context fingerprints use parity-1A's exact Rust snapshot/digest. Store fingerprints use the same digest and equivalent structural metadata with the mc_cache namespace ledger.",
		"",
		"Every retained original column is compared in both directions, with row counts and row-level SHA-256 streams. Removed session_meta payloads must match their original bytes, SQLite storage class and NULL/empty distinction through production accessors; every chunk is reconstructed. Unknown removed columns fail. Ordinary tables include rowid to preserve identity and duplicates. FTS shadow counts are reported but their physical bytes are not content contracts. All original context ledger rows must be unchanged; mc_cache version advancement and SQLite bookkeeping are excluded from content equality.",
		"Fresh-to-upgraded application compatibility requires every fresh table, column and index, including declared types, defaults, nullability, keys, constraints, triggers and views. SQL whitespace, comments, keyword case, identifier quotation, outer table-declaration order and index column ordinals are cosmetic. Types must match after case/whitespace normalization except session_meta.system_prompt_hash TEXT DEFAULT '' may remain INTEGER DEFAULT 0; thinking_binding_recovery_target may remain nullable. Only exact reviewed legacy table/column/index names and column-type profiles are admitted; unknown objects or other declaration changes fail. Fingerprints remain diagnostic evidence and same-route parity checks, not a fresh-to-upgraded compatibility requirement.",
		`Reviewed legacy tables: ${JSON.stringify(LEGACY_TABLES)}. Reviewed session_meta columns: ${JSON.stringify(LEGACY_COLUMNS)}. Reviewed legacy indexes: ${JSON.stringify(LEGACY_INDEXES)}. Actual allowances are recorded under schemaCompatibility.`,
		"McStore opener wall-clock intervals bracket its strict 30-day lineage-root expiry. A deleted root must be expired by the interval's end, with no move fence and no cache activity at or after the cutoff; a root already eligible at the interval's start must not survive. Boundary-crossing roots are counted explicitly, and a single clock inside the interval must explain every deletion and survivor. Every retained row and rowid is unchanged; all existing fence/cache dependency rows remain in the ordinary preservation audit. Migration 64 introduces the fence table, so released-63 inputs use the newly migrated fence table. Crash store audits compare against the original baseline using their own opener interval, never against an earlier pruned reference.",
		"",
		"Five ordered sessions use the real old/candidate materializeM0 renderer, both m[0] and m[1], defaults, frozen clock and an empty project-docs directory. This is the prefix renderer, not a live provider request. Rendering runs on separate copies so cache/render side effects cannot conceal migration loss.",
		"",
		"Crash barriers cover four uncommitted context migration transactions per implementation (including 103) and eight store migration transactions (including 75). Store crashes use an ignored unit-test helper to install a ledger hook on the real cortexkit-store migrator and McStore SQL chain; reopen uses McStore::open. SIGKILL step peak RSS is the paused child process VmHWM from /proc; all other peaks come from GNU time.",
		"",
		"Old plugin refusal and the placed release ck-mc offline command are checked on both paired and individually advanced stores, with DB/WAL hashes before/after. The release McStore opener is checked separately; the offline command is not a live subc handshake.",
		"",
		"## Results and findings",
		"",
		...(findings.length
			? findings.map((f) => `- ${f}`)
			: ["No findings recorded."]),
		"",
		"## Detailed evidence",
		"",
		"```json",
		JSON.stringify(
			{
				...evidence,
				fingerprints: summaryFingerprints,
				steps: steps.map(({ output, ...step }) => ({ ...step, ...(step.exit !== 0 ? { output } : {}) })),
			},
			null,
			2,
		),
		"```",
		"",
	];
	mkdirSync(dirname(reportPath), { recursive: true });
	writeFileSync(reportPath, lines.join("\n"));
	console.log(
		`Report: ${reportPath}\nTemporary evidence: ${root}/evidence.json (removed after report)\n${findings.length} findings`,
	);
}

try {
	if (process.platform !== "linux")
		throw new Error("Rehearsal requires Linux and GNU /usr/bin/time");
	evidence.candidate = option("--candidate") ?? spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: repo,
		encoding: "utf8",
	}).stdout.trim();
	evidence.toolchain = Object.fromEntries(
		(artifacts ? ["bun"] : ["bun", "cargo", "rustc"]).map((tool) => [
			tool,
			run(`${tool}-version`, [tool, "--version"]).trim(),
		]),
	);
	if (artifacts) {
		const manifest = JSON.parse(readFileSync(join(artifacts, "manifest.json"), "utf8"));
		assertArtifactIdentity(manifest, String(evidence.candidate), process.arch);
		for (const [name, expected] of Object.entries(manifest.files as Record<string, string>))
			if (hash(join(artifacts, name)) !== expected) throw new Error(`Prebuilt artifact checksum mismatch: ${name}`);
		evidence.artifacts = manifest;
	} else run("build-plugin-pi-cli-bundles", [process.execPath, "run", "build"], repo, {NODE_ENV: "production", MAGIC_CONTEXT_TEST_DATA_DIR: ""});
	const bundleRoot = artifacts ?? join(repo, "packages");
	const loadedBundles = run("load-plugin-pi-bundles", [process.execPath, "-e", `const loaded=[]; await import(${JSON.stringify(join(bundleRoot, "plugin/dist/index.js"))}); loaded.push('plugin'); await import(${JSON.stringify(join(bundleRoot, "pi-plugin/dist/index.js"))}); loaded.push('pi-plugin'); console.log(JSON.stringify(loaded));`]);
	assertBundles(JSON.parse(loadedBundles));
	const archive = option("--release-archive") ?? (artifacts ? join(artifacts, "release.tar") : join(root, "release.tar"));
	if (!option("--release-archive") && !artifacts)
		run("archive-release", ["git", "-c", `safe.directory=${repo}`, "archive", "v0.49.7", "-o", archive]);
	run("extract-release", ["tar", "-xf", resolve(archive), "-C", oldTree]);
	evidence.releaseArchiveSha256 = hash(resolve(archive));
	const pkg = JSON.parse(
		readFileSync(join(oldTree, "packages/plugin/package.json"), "utf8"),
	);
	if (pkg.version !== "0.49.7")
		throw new Error("Release archive does not identify v0.49.7");
	for (const path of [
		"node_modules",
		"packages/plugin/node_modules",
		"packages/retina-local-fs/node_modules",
	]) {
		if (existsSync(join(repo, path))) {
			mkdirSync(dirname(join(oldTree, path)), { recursive: true });
			symlinkSync(join(repo, path), join(oldTree, path), "dir");
		}
	}
	const examples = join(oldTree, "crates/mc-store/examples");
	mkdirSync(examples, { recursive: true });
	copyFileSync(
		join(repo, "scripts/lib/upgrade-release-store.rs"),
		join(examples, "upgrade_release_store.rs"),
	);
	// Compile the release helper in the tagged tree so its schema ceiling cannot come from the candidate.
	if (!artifacts) run(
		"build-release",
		[
			"cargo",
			"build",
			"--offline",
			"--locked",
			"-j",
			"4",
			"-p",
			"mc-store",
			"--example",
			"upgrade_release_store",
			"--target-dir",
			join(repo, "target/rehearsal-release"),
		],
		oldTree,
	);
	if (!artifacts) run(
		"build-release-ck-mc",
		[
			"cargo",
			"build",
			"--offline",
			"--locked",
			"-j",
			"4",
			"-p",
			"mc-module",
			"--bin",
			"ck-mc",
			"--target-dir",
			join(repo, "target/rehearsal-release"),
		],
		oldTree,
	);
	if (!artifacts) run("build-candidate-helper", [
		"cargo",
		"build",
		"--offline",
		"--locked",
		"-j",
		"4",
		"-p",
		"mc-store",
		"--example",
		"rehearse_upgrade",
		"--target-dir",
		join(repo, "target"),
	]);
	const testBuild = artifacts ? JSON.stringify({reason: "compiler-artifact", target: {name: "mc_store"}, profile: {test: true}, executable: join(artifacts, "store-tests")}) : run("build-store-crash-helper", [
		"cargo",
		"test",
		"--offline",
		"--locked",
		"-j",
		"4",
		"-p",
		"mc-store",
		"--lib",
		"--no-run",
		"--message-format=json",
		"--target-dir",
		join(repo, "target"),
	]);
	const testArtifact = testBuild
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line))
		.find(
			(row) =>
				row.reason === "compiler-artifact" &&
				row.target.name === "mc_store" &&
				row.profile.test &&
				row.executable,
		);
	if (!testArtifact)
		throw new Error("Store crash helper test binary not produced");
	const storeCrashHelper: string = testArtifact.executable;
	helper = artifacts ? join(artifacts, "candidate-helper") : join(repo, "target/debug/examples/rehearse_upgrade");
	const oldHelper = artifacts ? join(artifacts, "release-helper") : join(
		repo,
		"target/rehearsal-release/debug/examples/upgrade_release_store",
	);
	const bin = join(root, "bin");
	mkdirSync(bin);
	const oldBinary = join(bin, "ckdev-rehearsal-049");
	copyFileSync(artifacts ? join(artifacts, "release-ck-mc") : join(repo, "target/rehearsal-release/debug/ck-mc"), oldBinary);
	evidence.placedReleaseVersion = run("placed-release-version", [
		oldBinary,
		"--version",
	]).trim();
	if (snapshot) {
		for (const name of ["context.db", "store.db"]) {
			if (existsSync(join(snapshot, `${name}-wal`))) throw new Error("Snapshot must be a consistent offline VACUUM INTO pair without WAL sidecars");
			copyFileSync(join(snapshot, name), join(baseline, name), constants.COPYFILE_FICLONE);
		}
	} else {
		run("seed-release-context", [
			process.execPath,
			host,
			"seed",
			oldTree,
			baseline,
		]);
		run("seed-release-store", [oldHelper, "seed", baseline]);
		const seedStore = new Database(join(baseline, "store.db"));
		try {
			// The first host pass must preserve newer Rust tag numbers rather than replace them with older TypeScript numbers.
			for (let s = 0; s < 20; s++) seedStore.query("INSERT INTO mc_tags(session_id,tag_number,block_id,kind,created_at_ms) VALUES(?,?,?,'message',?)").run(`session-${String(s).padStart(2,"0")}`, 60001+s, `signed-${s}#1`, 1_800_000_001_000);
		} finally { seedStore.close(); }
	}
	if (
		version(join(baseline, "context.db")) !== 95 ||
		version(join(baseline, "store.db")) !== 63
	)
		throw new Error("Input must be exactly context.db 95 / store.db 63");
	for (const name of ["context.db", "store.db"]) {
		(evidence.tables as Record<string, unknown>)[`before/${name}`] = inventory(
			join(baseline, name),
		);
		(evidence.integrity as Record<string, unknown>)[`before/${name}`] =
			integrity(join(baseline, name));
	}
	const measurementDir = pairCopy(baseline, "per-migration-measurements");
	const measurementOutput = run("measure-context-migrations", [process.execPath, host, "measure-context", repo, measurementDir]) + run("measure-store-migrations", [storeCrashHelper, "--exact", "upgrade_rehearsal::measure_store_process", "--ignored", "--nocapture"], repo, {REHEARSAL_ROOT: measurementDir});
	evidence.migrations = [...measurementOutput.matchAll(/REHEARSAL_METRIC (\{[^\n]+\})/g)].map((match) => JSON.parse(match[1]));
	assertMigrationMetrics(evidence.migrations as MigrationMetric[]);
	rmSync(measurementDir, {recursive: true, force: true});
	const oldState = snapshot ? undefined : run("release-lkg-recovery-state", [process.execPath, host, "state", oldTree, baseline]);
	const oldRender = pairCopy(baseline, "old-render");
	run("render-release", [
		process.execPath,
		host,
		"render",
		oldTree,
		oldRender,
		join(root, "prompts-old"),
	]);
	rmSync(oldRender, {recursive: true, force: true});
	const fresh = join(root, "fresh-rust");
	mkdirSync(fresh);
	run("fresh-rust-context", [helper, "fresh-context", fresh]);
	openStore("fresh-rust-store", fresh);
	const freshFp = fingerprints(fresh);
	(evidence.fingerprints as Record<string, unknown>).freshRust = freshFp;
	const freshHost = pairCopy(fresh, "fresh-host");
	// A genuinely empty context.db exercises the host's full bootstrap, not a current-schema reopen.
	const empty = new Database(join(root, "empty.db"));
	empty.close();
	copyFileSync(join(root, "empty.db"), join(freshHost, "context.db"));
	run("fresh-typescript-context", [
		process.execPath,
		host,
		"migrate",
		repo,
		freshHost,
	]);
	const hostFp = fingerprints(freshHost);
	check("fresh TypeScript/Rust parity", () =>
		assertFingerprint(freshFp, hostFp),
	);
	assertEffects(freshFp.context_version, freshFp.store_version);
	for (const route of ["typescript", "rust"]) {
		const dir = pairCopy(baseline, route);
		run(
			`${route}-context-migrate`,
			route === "typescript"
				? [process.execPath, host, "migrate", repo, dir]
				: [helper, "context", dir],
		);
		openStore(`${route}-store-migrate`, dir);
		for (const name of ["context.db", "store.db"]) {
			(evidence.tables as Record<string, unknown>)[`${route}/${name}`] =
				inventory(join(dir, name));
			(evidence.integrity as Record<string, unknown>)[`${route}/${name}`] =
				integrity(join(dir, name));
		}
		(evidence.versions as Record<string, unknown>)[route] = {
			context: version(join(dir, "context.db")),
			store: version(join(dir, "store.db")),
		};
		check(`${route} target versions`, () => {
			if (
				version(join(dir, "context.db")) !== freshFp.context_version ||
				version(join(dir, "store.db")) !== freshFp.store_version
			)
				throw new Error("Migration did not reach candidate schema ceilings");
		});
		check(`${route} data preservation`, () => assertPreserved(baseline, dir));
		if (oldState) check(`${route} LKG and recovery state`, () => {
			const state = run(`${route}-lkg-recovery-state`, [process.execPath, host, "state", repo, dir]);
			if (state !== oldState) throw new Error("Loaded LKG bytes, identities, digests/signatures or recovery state changed");
		});
		const fp = fingerprints(dir);
		(evidence.fingerprints as Record<string, unknown>)[route] = fp;
		check(`${route} application schema compatibility`, () => {
			for (const name of ["context.db", "store.db"])
				(evidence.schemaCompatibility as unknown[]).push({ route, database: name, allowances: assertApplicationSchema(join(fresh, name), join(dir, name), name === "context.db") });
		});
		const renderDir = pairCopy(dir, `${route}-render`);
		const output = join(root, `prompts-${route}`);
		run(`render-${route}`, [
			process.execPath,
			host,
			"render",
			repo,
			renderDir,
			output,
		]);
		for (const file of readdirSync(join(root, "prompts-old"))) {
			const old = JSON.parse(
				readFileSync(join(root, "prompts-old", file), "utf8"),
			);
			const next = JSON.parse(readFileSync(join(output, file), "utf8"));
			for (const part of ["m0", "m1"]) {
				const equal = old[part] === next[part];
				const beforeBytes = Buffer.from(old[part]);
				const afterBytes = Buffer.from(next[part]);
				let offset = 0;
				while (
					offset < beforeBytes.length &&
					beforeBytes[offset] === afterBytes[offset]
				)
					offset++;
				(evidence.prompts as unknown[]).push({
					route,
					session: old.session,
					part,
					equal,
					bytesBefore: Buffer.byteLength(old[part]),
					bytesAfter: Buffer.byteLength(next[part]),
					firstDifference: equal ? null : offset,
					beforeExcerpt: equal
						? null
						: beforeBytes
								.subarray(Math.max(0, offset - 80), offset + 240)
								.toString(),
					afterExcerpt: equal
						? null
						: afterBytes
								.subarray(Math.max(0, offset - 80), offset + 240)
								.toString(),
				});
				if (!equal)
					findings.push(
						`${route} prompt ${old.session} ${part}: differs at byte ${offset}; cause unapproved renderer change, compare ${join(root, "prompts-old", file)} and ${join(output, file)}`,
					);
			}
		}
		const refused = pairCopy(dir, `${route}-old-plugin`);
		const before = fileHashes(refused);
		const refusal = run(
			`${route}-old-plugin-refusal`,
			[process.execPath, host, "refuse", oldTree, refused],
			repo,
			{},
			true,
		);
		check(`${route} old plugin refusal without writes`, () => {
			if (steps.at(-1)!.exit !== 0 || !refusal.includes("context.db"))
				throw new Error(
					`No named context.db schema refusal: ${steps.at(-1)!.output}`,
				);
			if (JSON.stringify(fileHashes(refused)) !== JSON.stringify(before))
				throw new Error("Old plugin modified DB/WAL bytes");
		});
		(evidence.refusals as unknown[]).push({ route, plugin: refusal });
		rmSync(refused, {recursive: true, force: true});
		const oldStore = pairCopy(dir, `${route}-old-store`);
		const storeBefore = fileHashes(oldStore);
		run(
			`${route}-old-store-refusal`,
			[oldHelper, "open", oldStore],
			repo,
			{},
			true,
		);
		(evidence.refusals as unknown[]).push({
			route,
			storeOpener: steps.at(-1)!.output,
		});
		check(`${route} old McStore refusal without writes`, () => {
			const last = steps.at(-1)!;
			if (last.exit === 0 || !last.output.includes("StoreAheadOfBinary"))
				throw new Error(last.output);
			if (JSON.stringify(fileHashes(oldStore)) !== JSON.stringify(storeBefore))
				throw new Error("Old McStore modified DB/WAL bytes");
		});
		rmSync(oldStore, {recursive: true, force: true});
		rmSync(renderDir, {recursive: true, force: true});
	}
	const sessionRunner = join(repo, "scripts/lib/upgrade-session-pass.ts");
	const samplePath = join(root, "session-sample.json");
	const planDir = pairCopy(join(root, "typescript"), "session-plan");
	run("select-real-session-sample", [process.execPath, sessionRunner, planDir, "plan", samplePath]);
	rmSync(planDir, {recursive: true, force: true});
	evidence.sessionSample = JSON.parse(readFileSync(samplePath, "utf8"));
	const sessionResults: {host: typeof HOSTS[number]; session: string; status: string}[] = [];
	for (const adapter of HOSTS) {
		const dir = pairCopy(join(root, "typescript"), `session-pass-${adapter}`);
		const outputPath = join(root, `session-results-${adapter}.json`);
		run(`real-session-pass-${adapter}`, [process.execPath, sessionRunner, dir, adapter, samplePath, outputPath], repo, {}, true);
		const rows = existsSync(outputPath) ? JSON.parse(readFileSync(outputPath, "utf8")) : [];
		sessionResults.push(...rows);
		check(`${adapter} TypeScript session reads without refusal`, () => {
			if (steps.at(-1)!.exit !== 0 || rows.length === 0 || rows.some((r: {status: string}) => r.status !== "passed")) throw new Error(`Session replay failed: ${JSON.stringify(rows)}`);
		});
		rmSync(dir, {recursive: true, force: true});
	}
	evidence.sessionPasses = sessionResults;
	check("all selected sessions on all three host adapters", () => {
		const sample = evidence.sessionSample as {largest: {session: string}[]; random: {session: string}[]};
		assertHostCoverage([...sample.largest, ...sample.random].map((s) => s.session), sessionResults.filter((r) => r.status === "passed"));
	});
	for (const route of ["typescript", "rust"]) {
		const dir = pairCopy(join(root, route), `doctor-${route}`);
		const scoped = run(`database-doctor-${route}`, [process.execPath, join(repo, "scripts/lib/upgrade-doctor.ts"), dir]);
		assertDoctor(scoped);
		const doctors: unknown[] = [];
		for (const adapter of ["opencode", "pi"]) {
			const output = run(`full-doctor-${route}-${adapter}`, [process.execPath, join(bundleRoot, "cli/dist/index.js"), "doctor", "--harness", adapter], dir, {MAGIC_CONTEXT_STORAGE_DIR: dir, MAGIC_CONTEXT_TEST_DATA_DIR: "", NODE_ENV: "production"}, true);
			assertFullDoctorTarget(steps.at(-1)!.output, dir, adapter);
			doctors.push({host: adapter, exit: steps.at(-1)!.exit, output: steps.at(-1)!.output || output});
		}
		(evidence.doctor as unknown[]).push({route, database: JSON.parse(scoped), full: doctors});
		rmSync(dir, {recursive: true, force: true});
	}
	check("TypeScript/Rust upgraded schema parity", () =>
		assertFingerprint(
			(evidence.fingerprints as Record<string, Fingerprints>).typescript,
			(evidence.fingerprints as Record<string, Fingerprints>).rust,
		),
	);
	for (const shape of ["pair", "context-only", "store-only"]) {
		const dir = pairCopy(
			shape === "pair" ? join(root, "rust") : baseline,
			`old-binary-${shape}`,
		);
		if (shape !== "pair")
			copyFileSync(
				join(
					root,
					"rust",
					shape === "context-only" ? "context.db" : "store.db",
				),
				join(dir, shape === "context-only" ? "context.db" : "store.db"),
			);
		const before = fileHashes(dir);
		const output = run(
			`old-ck-mc-${shape}-refusal`,
			[
				oldBinary,
				"single-store-migrate",
				"--context-db",
				join(dir, "context.db"),
				"--store-db",
				join(dir, "store.db"),
				"--backup-dir",
				join(dir, "backup"),
			],
			repo,
			{ MAGIC_CONTEXT_STORAGE_DIR: dir },
			true,
		);
		check(`placed release ck-mc ${shape} refusal without writes`, () => {
			const step = steps.at(-1)!;
			const result = JSON.parse(output) as {
				status: string;
				refusal?: { code: string; message: string };
			};
			if (
				step.exit !== 2 ||
				result.status !== "refused" ||
				!result.refusal ||
				![
					"single_store_version_mismatch",
					"single_store_fingerprint_mismatch",
				].includes(result.refusal.code) ||
				!/context\.db|store\.db/.test(result.refusal.message)
			)
				throw new Error(
					`Expected named schema refusal, exit ${step.exit}: ${output}`,
				);
			if (JSON.stringify(fileHashes(dir)) !== JSON.stringify(before))
				throw new Error("Release ck-mc modified DB/WAL bytes");
		});
		(evidence.refusals as unknown[]).push({ binary: shape, output });
		rmSync(dir, {recursive: true, force: true});
	}
	for (const route of ["typescript", "rust"])
		for (const migration of CONTEXT_CRASH_VERSIONS) {
			const dir = pairCopy(baseline, `crash-${route}-${migration}`);
			const command =
				route === "typescript"
					? [process.execPath, host, "migrate", repo, dir]
					: [helper, "context", dir];
			try {
				await crash(route, command, dir, migration);
				run(`reopen-${route}-${migration}`, command);
				openStore(`reopen-store-${route}-${migration}`, dir);
				const preserved = check(`crash ${route} v${migration} preservation`, () =>
					assertPreserved(join(root, route), dir, baseline),
				);
				const schema = check(`crash ${route} v${migration} schema`, () =>
					assertFingerprint(
						(evidence.fingerprints as Record<string, Fingerprints>)[route],
						fingerprints(dir),
					),
				);
				for (const name of ["context.db", "store.db"])
					integrity(join(dir, name));
				(evidence.crashes as {complete: boolean}[]).at(-1)!.complete = preserved && schema;
			} catch (error) {
				findings.push(
					`Crash ${route} context migration ${migration}: ${String(error)}`,
				);
			} finally { rmSync(dir, {recursive: true, force: true}); }
		}
	for (const migration of STORE_CRASH_VERSIONS) {
		const dir = pairCopy(baseline, `crash-store-${migration}`);
		try {
			await crash(
				"store",
				[
					storeCrashHelper,
					"--exact",
					"upgrade_rehearsal::store_process",
					"--ignored",
					"--nocapture",
				],
				dir,
				migration,
				"store.db",
			);
			openStore(`reopen-store-${migration}`, dir);
			run(`reopen-context-store-${migration}`, [helper, "context", dir]);
			const preserved = check(`crash store v${migration} preservation`, () =>
				assertPreserved(join(root, "rust"), dir, baseline),
			);
			const schema = check(`crash store v${migration} schema`, () =>
				assertFingerprint(
					(evidence.fingerprints as Record<string, Fingerprints>).rust,
					fingerprints(dir),
				),
			);
			for (const name of ["context.db", "store.db"]) integrity(join(dir, name));
			(evidence.crashes as {complete: boolean}[]).at(-1)!.complete = preserved && schema;
		} catch (error) {
			findings.push(`Crash store migration ${migration}: ${String(error)}`);
		} finally { rmSync(dir, {recursive: true, force: true}); }
	}
	assertCrashCoverage(evidence.crashes as {name: string; migration: number}[]);
	if (!snapshot) check("candidate module post-upgrade transforms", () => {
		const dir = pairCopy(join(root, "rust"), "module-drill");
		const output = run("module-post-upgrade-transforms", artifacts ? [join(artifacts, "module-tests"), "single_store_drill_post_migration_passes", "--ignored", "--nocapture"] : ["cargo", "test", "--offline", "--locked", "-j", "4", "-p", "mc-module", "--lib", "single_store_drill_post_migration_passes", "--", "--ignored", "--nocapture"], repo, { MC_DRILL_DIR: dir, MC_DRILL_PROJECT: "git:upgrade-rehearsal" });
		evidence.moduleDrillOutput = output;
		if (!output.includes("1 passed") || !output.includes("DRILL pass4")) throw new Error(`Transform drill did not run: ${output}`);
	});
	if (!artifacts) run("build-candidate-ck-mc", ["cargo", "build", "--offline", "--locked", "-j", "4", "-p", "mc-module", "--bin", "ck-mc"]);
	evidence.candidateBinaryVersion = run("candidate-ck-mc-version", [artifacts ? join(artifacts, "ck-mc") : join(repo, "target/debug/ck-mc"), "--version"]).trim();
	if (option("--export-artifacts")) {
		if (artifacts) throw new Error("Cannot re-export prebuilt artifacts");
		const destination = resolve(option("--export-artifacts")!);
		mkdirSync(destination, {recursive: true, mode: 0o700});
		const moduleBuild = run("build-module-test-artifact", ["cargo", "test", "--offline", "--locked", "-j", "4", "-p", "mc-module", "--lib", "--no-run", "--message-format=json"]);
		const moduleTest = moduleBuild.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line)).find((row) => row.reason === "compiler-artifact" && row.target.name === "mc_module" && row.profile.test && row.executable)?.executable;
		if (!moduleTest) throw new Error("Module test artifact not found");
		for (const [name, file] of Object.entries({"release.tar": archive, "release-helper": oldHelper, "release-ck-mc": oldBinary, "candidate-helper": helper, "store-tests": storeCrashHelper, "module-tests": moduleTest, "ck-mc": join(repo, "target/debug/ck-mc"), "gnu-time": "/usr/bin/time"})) copyFileSync(file, join(destination, name));
		for (const pkg of ["plugin", "pi-plugin", "cli"]) cpSync(join(repo, "packages", pkg, "dist"), join(destination, pkg, "dist"), {recursive: true});
		writeFileSync(join(destination, "manifest.json"), JSON.stringify({candidate: evidence.candidate, arch: process.arch, platform: process.platform, toolchain: evidence.toolchain, files: Object.fromEntries(readdirSync(destination).filter((name) => !["plugin", "pi-plugin", "cli", "manifest.json"].includes(name)).map((name) => [name, hash(join(destination, name))]))}, null, 2));
		console.log(`Exported Linux rehearsal artifacts: ${destination}`);
	}
} catch (error) {
	findings.push(`Rehearsal execution: ${String(error)}`);
} finally {
	writeReport();
	rmSync(root, { recursive: true, force: true });
}
process.exitCode = findings.length ? 1 : 0;
console.log(findings.length ? `REHEARSAL_FAIL findings=${findings.length}` : "REHEARSAL_PASS context=103 store=75 session_hosts=3 sample=10 crash_proofs=15 database_doctor=clean");
