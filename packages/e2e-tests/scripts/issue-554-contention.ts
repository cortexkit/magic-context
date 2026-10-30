// Point MC_E2E_OPENCODE2_CLI at an OpenCode 2 binary. To test an older plugin,
// point MC_554_SOURCE_ROOT at its extracted packages/plugin/src directory.
// Host stores, logs, and the shared context.db stay beneath this run's temporary root.
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { classifyContentionTurn } from "../src/contention-turn-outcome";
import { isolation, spawnOpencode2 } from "../src/opencode2-runner/spawn";

const count = Number(process.env.MC_554_HOSTS ?? 11);
const root = resolve(
	join(tmpdir(), "magic-context", "issue-554", `${Date.now()}-${process.pid}`),
);
mkdirSync(root, { recursive: true });
const canonicalRoot = realpathSync(root);
const storage = join(canonicalRoot, "shared");
mkdirSync(storage);
const source = resolve(
	process.env.MC_554_SOURCE_ROOT ?? join(import.meta.dir, "../../plugin/src"),
);
const plugin = join(root, "probe-plugin");
mkdirSync(plugin);
symlinkSync(
	resolve(import.meta.dir, "../../plugin/node_modules"),
	join(plugin, "node_modules"),
);
writeFileSync(
	join(plugin, "package.json"),
	JSON.stringify({
		name: "issue-554-probe",
		type: "module",
		main: "server.js",
	}),
);
writeFileSync(
	join(plugin, "entry.ts"),
	`
import { appendFileSync } from "node:fs";
import { Database } from "bun:sqlite";
const sample = new Database(":memory:");
const statementPrototype = Object.getPrototypeOf(sample.prepare("SELECT 1"));
for (const method of ["run", "get", "all"]) {
  const original = statementPrototype[method];
  statementPrototype[method] = function (...args) {
    const start = Date.now();
    try { return original.apply(this, args); }
    finally { const ms = Date.now()-start;
      if (ms > 20) appendFileSync(${JSON.stringify(join(root, "sqlite-waits.log"))}, JSON.stringify({ pid:process.pid, at:Date.now(), ms, method, sql:String(this).slice(0,180), stack:new Error().stack })+'\\n');
    }
  };
}
const originalTransaction = Database.prototype.transaction;
Database.prototype.transaction = function (callback) {
  const transaction = originalTransaction.call(this, callback);
  for (const method of ["immediate", "exclusive", "deferred"]) {
    const original = transaction[method];
    transaction[method] = function (...args) {
      const start = Date.now();
      try { return original.apply(this, args); }
      finally { const ms = Date.now()-start;
        if (ms > 20) appendFileSync(${JSON.stringify(join(root, "sqlite-waits.log"))}, JSON.stringify({ pid:process.pid, at:Date.now(), ms, method:"transaction:"+method, stack:new Error().stack })+'\\n');
      }
    };
  }
  return transaction;
};
const originalExec = Database.prototype.exec;
Database.prototype.exec = function (...args) {
  const start = Date.now();
  try { return originalExec.apply(this, args); }
  finally {
    const ms = Date.now() - start;
    if (ms > 20) appendFileSync(${JSON.stringify(join(root, "sqlite-waits.log"))}, JSON.stringify({ pid: process.pid, at:Date.now(), ms, method: "exec", sql: args[0], stack: new Error().stack }) + '\\n');
  }
};
sample.close();
const { setup } = await import(${JSON.stringify(join(source, "v2/server.ts"))});
const trace = ${JSON.stringify(join(root, "heartbeat.log"))};
export default { id: "opencode-magic-context", async setup(context) {
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - last > 150) appendFileSync(trace, JSON.stringify({ pid: process.pid, at: now, gapMs: now - last }) + '\\n');
    last = now;
  }, 20);
  timer.unref();
  return setup(context);
} };
`,
);
const built = await Bun.build({
	entrypoints: [join(plugin, "entry.ts")],
	outdir: plugin,
	naming: "server.js",
	target: "bun",
	sourcemap: "external",
	tsconfig: resolve(import.meta.dir, "../../plugin/tsconfig.json"),
	define: { "process.env.NODE_ENV": JSON.stringify("production") },
	external: [
		"@opencode/plugin",
		"onnxruntime-node",
		"onnxruntime-web",
		"sharp",
	],
});
if (!built.success) throw new Error(built.logs.join("\n"));
const hosts: Awaited<ReturnType<typeof spawnOpencode2>>[] = [];
const samples: {
	phase: string;
	index: number;
	ms: number;
	status: number | string;
	at: number;
}[] = [];
const turns: {
	index: number;
	phase: string;
	ms: number;
	result: string;
	providerRequests?: number;
	refused?: boolean;
	replay?: boolean;
}[] = [];
const dbPath = join(storage, "context.db");
// A fresh store has every migration pending; host startup creates it without prewarming.
const toolCalls: { index: number; issued: boolean; outcome: string }[] = [];
let lock: Database | undefined;
let paused = false;
let stoppedAt = 0;
let resumedAt = 0;
const warmProof: { index: number; saved: boolean }[] = [];
const version = execFileSync(process.env.MC_E2E_OPENCODE2_CLI!, ["--version"], {
	encoding: "utf8",
}).trim();
try {
	for (let index = 0; index < count; index++) {
		const prior = process.env.TMPDIR;
		process.env.TMPDIR = root;
		const fixture = isolation();
		if (prior === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = prior;
		fixture.root = canonicalRoot;
		fixture.env.MAGIC_CONTEXT_STORAGE_DIR = storage;
		fixture.env.TMPDIR = join(canonicalRoot, `host-tmp-${index}`);
		mkdirSync(fixture.env.TMPDIR);
		// In the runner each host has its own OpenCode DB and private XDG roots.
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
		if (index < 7) {
			const call = { index, issued: false, outcome: "not started" };
			toolCalls.push(call);
			host.mock.addMatcher((body) => {
				const wire = JSON.stringify(body);
				if (
					call.issued ||
					!wire.includes("write a note for issue 554 locked") ||
					!wire.includes('"name":"ctx_note"')
				)
					return null;
				call.issued = true;
				return {
					openaiOutput: [
						{
							type: "function_call",
							id: `fc_554_${index}`,
							call_id: `call_554_${index}`,
							name: "ctx_note",
							arguments: JSON.stringify({
								action: "write",
								content: `Issue 554 note ${index}`,
								note_ids: [],
							}),
						},
					],
					usage: { input_tokens: 100, output_tokens: 10 },
				};
			});
		}
		hosts.push(host);
	}
	const auth = (host: (typeof hosts)[number]) => ({
		authorization: `Basic ${btoa(`opencode:${host.password}`)}`,
	});
	const clients = hosts.map((host) =>
		OpenCode.make({ baseUrl: host.url, headers: auth(host) }),
	);
	const sessions = await Promise.all(
		clients.map(async (client, i) => {
			const session = await client.session.create({
				title: `issue 554 ${i}`,
				location: { directory: hosts[i].cwd },
				model: { providerID: "openai", id: "mock-model" },
			});
			return session.id;
		}),
	);
	const drive = async (phase: string) =>
		Promise.allSettled(
			clients.map(async (client, i) => {
				if (i >= 7) return;
				const start = performance.now();
				const beforeRequests = hosts[i].mock.requests().length;
				const beforeLog = hosts[i].pluginLog().length;
				const text =
					phase === "locked"
						? `write a note for issue 554 locked ${Date.now()}`
						: `issue 554 ${phase} ${Date.now()}`;
				const previousIdleIds = new Set<string>();
				try {
					const previous = await client.message.list({
						sessionID: sessions[i],
					});
					for (const row of (
						previous as unknown as { data: Array<{ id: string; type: string }> }
					).data)
						if (row.type === "idle") previousIdleIds.add(row.id);
					await client.session.prompt({
						sessionID: sessions[i],
						text,
					});
					await client.session.wait(
						{ sessionID: sessions[i] },
						{ signal: AbortSignal.timeout(30000) },
					);
					const listed = await client.message.list({ sessionID: sessions[i] });
					const idle = (
						listed as unknown as {
							data: Array<{ id: string; type: string; outcome?: string }>;
						}
					).data.find(
						(row) => row.type === "idle" && !previousIdleIds.has(row.id),
					);
					const requests = hosts[i].mock
						.requests()
						.slice(beforeRequests)
						.filter((request) => JSON.stringify(request.body).includes(text));
					const log = hosts[i].pluginLog().slice(beforeLog);
					turns.push({
						providerRequests: requests.length,
						...classifyContentionTurn(log, requests.length, idle?.outcome),
						index: i,
						phase,
						ms: performance.now() - start,
					});
				} catch (error) {
					const log = hosts[i].pluginLog().slice(beforeLog);
					turns.push({
						providerRequests: hosts[i].mock
							.requests()
							.slice(beforeRequests)
							.filter((request) => JSON.stringify(request.body).includes(text))
							.length,
						refused:
							/refusing this turn before the model call|v2 refusal: interrupting the turn before the provider request|storage-busy refusal/.test(
								log,
							),
						replay: log.includes("lkg_replay_served"),
						index: i,
						phase,
						ms: performance.now() - start,
						result: String(error),
					});
				}
			}),
		);
	const poll = async (phase: string, seconds: number) => {
		const end = performance.now() + seconds * 1000;
		while (performance.now() < end) {
			const start = performance.now();
			await Promise.all(
				hosts.map(async (host, index) => {
					const began = performance.now();
					try {
						const response = await fetch(`${host.url}/health`, {
							headers: auth(host),
							signal: AbortSignal.timeout(900),
						});
						samples.push({
							phase,
							index,
							ms: performance.now() - began,
							status: response.status,
							at: Date.now(),
						});
					} catch (error) {
						samples.push({
							phase,
							index,
							ms: performance.now() - began,
							status: String(error),
							at: Date.now(),
						});
					}
				}),
			);
			await Bun.sleep(Math.max(0, 1000 - (performance.now() - start)));
		}
	};
	// Keep prompts in flight as the external probe observes the active host event loops.
	const steadyTurn = drive("steady");
	await poll("steady", 10);
	await steadyTurn;
	stoppedAt = Date.now();
	hosts.forEach((host) => {
		process.kill(host.pid!, "SIGSTOP");
	});
	paused = true;
	await poll("stopped", 30);
	hosts.forEach((host) => {
		process.kill(host.pid!, "SIGCONT");
	});
	paused = false;
	resumedAt = Date.now();
	const wakeTurn = drive("wake");
	await poll("wake", 10);
	await wakeTurn;
	if (process.env.MC_554_WARM_LKG === "1") {
		await drive("warm");
		await Bun.sleep(100);
		const reader = new Database(dbPath, { readonly: true });
		for (let i = 0; i < 7; i++)
			warmProof.push({
				index: i,
				saved: !!reader
					.prepare("SELECT 1 FROM lkg_slots WHERE session_id=?")
					.get(sessions[i]),
			});
		reader.close();
	}
	lock = new Database(dbPath);
	lock.exec("BEGIN IMMEDIATE");
	const lockTurn = drive("locked");
	await poll("locked", Number(process.env.MC_554_LOCK_SECONDS ?? 10));
	lock.exec("ROLLBACK");
	lock.close();
	lock = undefined;
	await poll("released", 7);
	await Promise.race([lockTurn, Bun.sleep(12000)]);
	await Promise.all(
		toolCalls.map(async (call) => {
			try {
				await clients[call.index].session.wait(
					{ sessionID: sessions[call.index] },
					{ signal: AbortSignal.timeout(30000) },
				);
				call.outcome = call.issued ? "completed" : "not issued";
			} catch (error) {
				call.outcome = String(error);
			}
		}),
	);
	const openPaths = hosts.map((host) => ({
		pid: host.pid,
		dbs: execFileSync("lsof", ["-p", String(host.pid), "-Fn"], {
			encoding: "utf8",
		})
			.split("\n")
			.filter((line) => /^n.*\.db(?:-wal|-shm)?$/.test(line))
			.map((line) => line.slice(1)),
	}));
	if (
		openPaths.some(
			({ dbs }) =>
				dbs.length === 0 ||
				dbs.some((path) => !path.startsWith(canonicalRoot + "/")),
		)
	)
		throw new Error("host database path escaped throwaway root");
	const phases = Object.fromEntries(
		["steady", "stopped", "wake", "locked", "released"].map((phase) => {
			const group = samples.filter((sample) => sample.phase === phase);
			return [
				phase,
				{
					count: group.length,
					failures: group.filter((item) => item.status !== 200).length,
					maxMs: Math.round(Math.max(...group.map((item) => item.ms))),
					p95Ms: Math.round(
						group.map((item) => item.ms).sort((a, b) => a - b)[
							Math.floor(group.length * 0.95)
						] ?? 0,
					),
				},
			];
		}),
	);
	const hostLogs = hosts.map((host) => ({
		pid: host.pid,
		stdout: host.stdout(),
		stderr: host.stderr(),
		pluginLog: host.pluginLog(),
	}));
	const sqliteWaits = existsSync(join(root, "sqlite-waits.log"))
		? readFileSync(join(root, "sqlite-waits.log"), "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
	const migrationReader = new Database(dbPath, { readonly: true });
	const startupMigration = migrationReader
		.prepare("SELECT MAX(version) AS version FROM schema_migrations")
		.get();
	for (const call of toolCalls) {
		if (call.outcome === "completed") {
			const row = migrationReader
				.prepare("SELECT COUNT(*) AS count FROM notes WHERE content = ?")
				.get(`Issue 554 note ${call.index}`) as { count: number };
			call.outcome = row.count === 1 ? "persisted" : "missing write";
		}
	}
	migrationReader.close();
	const lockedTurnOutcomes = turns
		.filter((turn) => turn.phase === "locked")
		.map((turn) => ({
			index: turn.index,
			outcome: turn.replay ? "LKG" : turn.refused ? "refused" : turn.result,
			providerRequests: turn.providerRequests ?? 0,
		}));
	const evidence = {
		root,
		version,
		source,
		stoppedAt,
		resumedAt,
		warmProof,
		sqliteWaits,
		hostPids: hosts.map((host) => host.pid),
		phases,
		turns,
		toolCalls,
		lockedTurnOutcomes,
		startupMigration,
		openPaths,
		samples,
		hostLogs,
		heartbeat: readFileSync(join(root, "heartbeat.log"), "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line)),
	};
	writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
	console.log(
		JSON.stringify({
			root,
			version,
			phases,
			turns,
			toolCalls,
			lockedTurnOutcomes,
			startupMigration: evidence.startupMigration,
			heartbeat: evidence.heartbeat.length,
			openPaths,
		}),
	);
} finally {
	if (paused)
		hosts.forEach((host) => {
			try {
				process.kill(host.pid!, "SIGCONT");
			} catch {}
		});
	if (lock) {
		lock.exec("ROLLBACK");
		lock.close();
	}
	await Promise.allSettled(hosts.map((host) => host.stop()));
}
