import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import {
	closeDatabase,
	LATEST_SUPPORTED_VERSION,
	openDatabase,
} from "../../../plugin/src/features/magic-context/storage-db";
import {
	CLI,
	PLUGIN,
	isolation,
	spawnOpencode2,
	waitForPluginActive,
	waitForPluginLog,
} from "../../src/opencode2-runner/spawn";

async function checkStorageBoot(blocked: boolean) {
	const probeDelayMs = blocked ? 10_000 : 2_000;
	const parent = join(tmpdir(), "magic-context", "boot-readiness");
	mkdirSync(parent, { recursive: true });
	const previousTmp = process.env.TMPDIR;
	process.env.TMPDIR = parent;
	const fixture = isolation();
	if (previousTmp === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = previousTmp;
	const cliVersion = execFileSync(CLI, ["--version"], {
		env: fixture.env,
		encoding: "utf8",
	}).trim();
	console.log(`OpenCode CLI: ${CLI}; version: ${cliVersion}`);
	const storage = fixture.env.MAGIC_CONTEXT_STORAGE_DIR!;
	mkdirSync(join(storage, "rpc", "older-host"), { recursive: true });
	const dbPath = join(storage, "context.db");
	if (!openDatabase(dbPath)) throw new Error("could not seed isolated storage");
	closeDatabase();
	const db = new Database(dbPath);
	db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(
		LATEST_SUPPORTED_VERSION,
	);
	if (blocked) db.exec("BEGIN IMMEDIATE");
	const blockerPid = process.pid;
	if (blocked)
		writeFileSync(
			join(storage, "rpc", "older-host", `port-${blockerPid}.json`),
			JSON.stringify({
				pid: blockerPid,
				port: 43123,
				started_at: Date.now(),
				kind: "OpenCode server",
			}),
		);
	const source =
		process.env.MC_BOOT_SOURCE_ROOT ??
		resolve(import.meta.dir, "../../../plugin/src");
	const plugin = join(fixture.root, "probe-plugin");
	mkdirSync(plugin);
	symlinkSync(
		resolve(import.meta.dir, "../../../plugin/node_modules"),
		join(plugin, "node_modules"),
	);
	const trace = join(fixture.root, "probes.log");
	writeFileSync(
		join(plugin, "package.json"),
		JSON.stringify({
			name: "storage-readiness-probe",
			type: "module",
			main: "index.js",
		}),
	);
	// Keep the source outside the plugin package: the host prefers server.ts to
	// server.js when both exist, which would bypass the bundle under test.
	const entry = join(fixture.root, "server.ts");
	writeFileSync(
		entry,
		`
import { appendFileSync } from "node:fs";
import { setup } from ${JSON.stringify(join(source, "v2/server.ts"))};
import * as probes from ${JSON.stringify(join(source, "shared/rpc-utils.ts"))};
const facts = JSON.stringify([{ ProcessId: ${blockerPid}, ParentProcessId: 1, CommandLine: "opencode serve", CreationDate: "2026-01-01T00:00:00Z" }]);
const mark = (text) => appendFileSync(${JSON.stringify(trace)}, text + "\\n");
probes.__setRpcIdentityTestHooks({ platform: "win32", execFileSync: (file) => file === "powershell" ? facts : '"opencode.exe","${blockerPid}"', processListExecFileSync: () => { mark("sync-start"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000); mark("sync-end"); return facts; } });
const asyncHook = probes["__setAsyncProcessProbeForTests"];
if (asyncHook) asyncHook(async () => { mark("async-start"); await new Promise(resolve => setTimeout(resolve, ${probeDelayMs})); mark("async-end"); return ${blocked ? "facts" : 'JSON.stringify([{ ProcessId: process.pid, ParentProcessId: 1, CommandLine: "opencode serve", CreationDate: "2026-01-01T00:00:00Z" }])'}; });
export default { id: "opencode-magic-context", async setup(context) { mark("setup-start " + Date.now()); let lastBeat = Date.now(); let maxGap = 0; const beat = () => { const now = Date.now(); maxGap = Math.max(maxGap, now - lastBeat); lastBeat = now; }; const heartbeat = setInterval(beat, 10); try { const dispose = await setup(context); mark("setup-end " + Date.now()); return dispose; } finally { beat(); clearInterval(heartbeat); mark("heartbeat-max " + maxGap); } } };
`,
	);
	const built = await Bun.build({
		// Bundle the worker alongside the probe just as the published plugin does.
		// A missing worker must fail closed, not migrate on the host's event loop.
		entrypoints: [
			entry,
			join(source, "features/magic-context/migration-worker.ts"),
		],
		outdir: plugin,
		naming: "[name].js",
		target: "bun",
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
		external: [
			"@opencode/plugin",
			"onnxruntime-node",
			"onnxruntime-web",
			"sharp",
		],
	});
	if (!built.success) throw new Error(built.logs.join("\n"));
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		includeMagicContext: false,
		probePlugin: plugin,
		prepareContextDatabase: false,
		magicContextConfig: {
			dreamer: { disable: true },
			historian: { disable: true },
			memory: { enabled: false },
		},
	});
	const headers = {
		authorization: `Basic ${btoa(`opencode:${host.password}`)}`,
	};
	const client = OpenCode.make({ baseUrl: host.url, headers });
	let releaseLock: ReturnType<typeof setTimeout> | undefined;
	try {
		// Activation is lazy on this host; drive it while sampling HTTP from outside
		// the host process, so a blocked host event loop cannot delay our timeout.
		const activationStarted = performance.now();
		let activationMs = 0;
		const activation = client.session
			.create({
				title: "blocked storage boot",
				location: { directory: host.cwd },
				model: { providerID: "openai", id: "mock-model" },
			})
			.then(async (session) => {
				await waitForPluginActive(client, host.cwd);
				return session;
			})
			.then((session) => {
				activationMs = performance.now() - activationStarted;
				return session;
			});
		const setupDeadline = Date.now() + 30_000;
		while (
			(!existsSync(trace) ||
				!readFileSync(trace, "utf8").includes("setup-start")) &&
			Date.now() < setupDeadline
		)
			await Bun.sleep(10);
		// The fixture's RPC discovery record still names a live older host, so the
		// migration guard must refuse even after the SQLite writer lock releases.
		if (blocked) releaseLock = setTimeout(() => db.exec("ROLLBACK"), 10_000);
		const secondStarted = performance.now();
		const secondSession = client.session
			.create(
				{
					title: "second session during setup",
					location: { directory: host.cwd },
					model: { providerID: "openai", id: "mock-model" },
				},
				{ signal: AbortSignal.timeout(2000) },
			)
			.then((session) => ({
				id: session.id,
				latencyMs: performance.now() - secondStarted,
				setupPending: !readFileSync(trace, "utf8").includes("setup-end"),
			}))
			.catch((error: unknown) => ({
				id: null,
				latencyMs: performance.now() - secondStarted,
				setupPending: false,
				error: String(error),
			}));
		const latencies: number[] = [];
		const failures: string[] = [];
		let healthWhilePending = 0;
		for (let index = 0; index < 30; index++) {
			const started = performance.now();
			try {
				const response = await fetch(`${host.url}/health`, {
					headers,
					signal: AbortSignal.timeout(2000),
				});
				if (!response.ok) failures.push(`HTTP ${response.status}`);
				else if (!readFileSync(trace, "utf8").includes("setup-end"))
					healthWhilePending++;
			} catch (error) {
				failures.push(String(error));
			}
			latencies.push(performance.now() - started);
			await Bun.sleep(200);
		}
		const session = await activation;
		const second = await secondSession;
		clearTimeout(releaseLock);
		if (db.inTransaction) db.exec("ROLLBACK");
		const openFiles = execFileSync("lsof", ["-p", String(host.pid), "-Fn"], {
			encoding: "utf8",
		});
		const databases = openFiles
			.split("\n")
			.filter(
				(line) => line.startsWith("n") && /\.db(?:-wal|-shm)?$/.test(line),
			);
		expect(databases.length).toBeGreaterThan(0);
		for (const path of databases)
			expect(path.slice(1).startsWith(fixture.root)).toBe(true);
		const probeLog = readFileSync(trace, "utf8");
		const evidence = {
			root: fixture.root,
			cliVersion,
			pid: host.pid,
			source,
			blocked,
			probeDelayMs,
			second,
			healthWhilePending,
			probeLog,
			activationMs,
			latencies,
			failures,
			databases,
		};
		writeFileSync(
			join(fixture.root, "readiness-evidence.json"),
			JSON.stringify(evidence, null, 2),
		);
		console.log(JSON.stringify(evidence));
		expect(probeLog).toContain("setup-end");
		if (!process.env.MC_BOOT_SOURCE_ROOT) {
			expect(probeLog).toContain("async-start");
			expect(probeLog.split("\n")).not.toContain("sync-start");
		}
		const setupMs =
			Number(/setup-end (\d+)/.exec(probeLog)?.[1]) -
			Number(/setup-start (\d+)/.exec(probeLog)?.[1]);
		console.log(`Setup duration: ${setupMs} ms`);
		expect(Number(/heartbeat-max (\d+)/.exec(probeLog)?.[1])).toBeLessThan(
			1000,
		);
		expect(failures).toEqual([]);
		if (blocked) {
			expect(healthWhilePending).toBeGreaterThan(0);
			expect(second.setupPending).toBe(true);
		}
		expect(Math.max(...latencies)).toBeLessThan(2000);
		const checked = new Database(dbPath, { readonly: true });
		expect(
			checked
				.query("SELECT MAX(version) AS version FROM schema_migrations")
				.get(),
		).toEqual({
			version: blocked
				? LATEST_SUPPORTED_VERSION - 1
				: LATEST_SUPPORTED_VERSION,
		});
		checked.close();
		if (!blocked) {
			expect(
				probeLog.split("\n").filter((line) => line === "async-start"),
			).toHaveLength(1);
			host.mock.setDefault({
				text: "healthy storage reply",
				usage: { input_tokens: 100, output_tokens: 10 },
			});
			await client.session.prompt({
				sessionID: session.id,
				text: "Check tools after slow healthy storage open",
			});
			await client.session.wait(
				{ sessionID: session.id },
				{ signal: AbortSignal.timeout(30_000) },
			);
			const requests = host.mock
				.requests()
				.filter((request) => request.body.model === "mock-model");
			expect(requests.length).toBeGreaterThan(0);
			const tools = (requests[0].body.tools as Array<{ name?: string }>).map(
				(tool) => tool.name,
			);
			console.log(
				JSON.stringify({
					registeredTools: tools.filter((name) => name?.startsWith("ctx_")),
				}),
			);
			for (const name of ["ctx_reduce", "ctx_expand", "ctx_note", "ctx_search"])
				expect(tools).toContain(name);
		}
	} catch (error) {
		writeFileSync(join(fixture.root, "host-stderr.log"), host.stderr());
		console.error(`Host diagnostics: ${fixture.root}`);
		throw error;
	} finally {
		clearTimeout(releaseLock);
		db.close();
		await host.stop();
	}
}

test(
	"OpenCode 2 serves HTTP and a second session while storage setup waits ten seconds",
	() => checkStorageBoot(true),
	120_000,
);
test(
	"OpenCode 2 registers context tools after a two-second healthy storage open",
	() => checkStorageBoot(false),
	120_000,
);

test.each([
	["published union", PLUGIN],
	["dist/v2", join(PLUGIN, "dist/v2/server.js")],
])(
	"OpenCode 2 %s bundle migrates pending storage off-thread before registering tools",
	async (_label, magicContextPlugin) => {
		const fixture = isolation();
		// The host resolves plugin package directories, not bare entry files. A
		// re-export-only package loads the real v2 dist without rebundling its chunks
		// or changing import.meta.url, which determines the worker's location.
		if (magicContextPlugin.endsWith(".js")) {
			const packageDir = join(fixture.root, "v2-dist-plugin");
			mkdirSync(packageDir);
			writeFileSync(
				join(packageDir, "package.json"),
				JSON.stringify({
					name: "v2-dist-probe",
					type: "module",
					main: "index.js",
				}),
			);
			writeFileSync(
				join(packageDir, "index.js"),
				`export { default } from ${JSON.stringify(magicContextPlugin)};\n`,
			);
			magicContextPlugin = packageDir;
		}
		const hostRunnerTables = [
			"host_runner_entries",
			"host_runner_ids",
			"host_runner_views",
			"host_runner_state",
		];
		// The newest migration adds these session_meta columns. Removing them and
		// the newest version row models a valid database one migration behind.
		const newestColumns = ["served_prefix", "held_release"];
		// Model a valid v99 database by removing only v100's version row and its
		// columns below. Keep git_commit_fts_rowid_map: an earlier migration already
		// committed it, so deleting that FTS identity map is corruption and startup
		// must refuse it instead of rebuilding it. When a newer migration lands,
		// update this pin and the objects it removes together.
		expect(LATEST_SUPPORTED_VERSION).toBe(100);
		const dbPath = join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db");
		if (!openDatabase(dbPath))
			throw new Error("could not seed isolated storage");
		closeDatabase();
		const seed = new Database(dbPath);
		try {
			seed
				.prepare("DELETE FROM schema_migrations WHERE version = ?")
				.run(LATEST_SUPPORTED_VERSION);
			// Remove new schema objects as well as the version marker: the packaged
			// worker must actually install them, not just report an already-current DB.
			for (const name of newestColumns)
				seed.run(`ALTER TABLE session_meta DROP COLUMN ${name}`);
		} finally {
			seed.close();
		}
		const host = await spawnOpencode2({
			existingIsolation: fixture,
			magicContextPlugin,
			prepareContextDatabase: false,
			magicContextConfig: {
				dreamer: { disable: true },
				historian: { disable: true },
				memory: { enabled: false },
			},
		});
		try {
			const client = OpenCode.make({
				baseUrl: host.url,
				headers: {
					authorization: `Basic ${btoa(`opencode:${host.password}`)}`,
				},
			});
			const session = await client.session.create({
				title: "packaged storage migration",
				location: { directory: host.cwd },
				model: { providerID: "openai", id: "mock-model" },
			});
			await waitForPluginActive(
				client,
				host.cwd,
				_label === "dist/v2"
					? "@cortexkit/opencode-magic-context"
					: "opencode-magic-context",
			);
			const log = await waitForPluginLog(
				fixture.env,
				"async open main-thread migration-body count: 0",
			);
			expect(log).toContain("migration worker ready");
			expect(log).toContain("[migrations] applied v100:");
			expect(log).not.toContain("storage fatal:");
			expect(log).toContain("async open main-thread migration-body count: 0");
			expect(log).not.toContain("migration worker could not start");
			const checked = new Database(dbPath, { readonly: true });
			try {
				expect(
					checked
						.query("SELECT MAX(version) AS version FROM schema_migrations")
						.get(),
				).toEqual({ version: LATEST_SUPPORTED_VERSION });
				for (const name of [
					...hostRunnerTables,
					"temporal_decisions",
					"git_commit_fts_rowid_map",
					"idx_transform_decisions_retention",
				])
					expect(
						checked
							.query("SELECT name FROM sqlite_master WHERE name = ?")
							.get(name),
					).toEqual({ name });
				const sessionMetaColumns = (
					checked.query("PRAGMA table_info(session_meta)").all() as {
						name: string;
					}[]
				).map((column) => column.name);
				for (const name of newestColumns)
					expect(sessionMetaColumns).toContain(name);
			} finally {
				checked.close();
			}
			const inventory = execFileSync("lsof", ["-p", String(host.pid), "-Fn"], {
				encoding: "utf8",
			});
			const databases = inventory
				.split("\n")
				.filter(
					(line) => line.startsWith("n") && /\.db(?:-wal|-shm)?$/.test(line),
				);
			expect(databases.length).toBeGreaterThan(0);
			for (const path of databases)
				expect(path.slice(1).startsWith(fixture.root + "/")).toBe(true);
			writeFileSync(join(fixture.root, "host-lsof.txt"), inventory);
			await client.session.prompt({
				sessionID: session.id,
				text: "Check tools after packaged migration",
			});
			await client.session.wait(
				{ sessionID: session.id },
				{ signal: AbortSignal.timeout(30_000) },
			);
			const requests = host.mock
				.requests()
				.filter((request) => request.body.model === "mock-model");
			expect(requests.length).toBeGreaterThan(0);
			const tools = (requests[0].body.tools as Array<{ name?: string }>).map(
				(tool) => tool.name,
			);
			for (const name of ["ctx_reduce", "ctx_expand", "ctx_note", "ctx_search"])
				expect(tools).toContain(name);
			console.log(
				JSON.stringify({
					root: fixture.root,
					pid: host.pid,
					cliVersion: execFileSync(CLI, ["--version"], {
						env: fixture.env,
						encoding: "utf8",
					}).trim(),
					schemaVersion: LATEST_SUPPORTED_VERSION,
					databases,
					registeredTools: tools.filter((name) => name?.startsWith("ctx_")),
					pluginLog: log,
				}),
			);
		} catch (error) {
			writeFileSync(join(fixture.root, "host-stderr.log"), host.stderr());
			console.error(`Host diagnostics: ${fixture.root}`);
			throw error;
		} finally {
			await host.stop();
		}
	},
	120_000,
);
