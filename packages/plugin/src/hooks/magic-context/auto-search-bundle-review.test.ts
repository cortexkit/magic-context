import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";

const repo = fileURLToPath(new URL("../../../../../", import.meta.url));
const root = join(tmpdir(), "magic-context", "bg_a8d894f629e2c52f");
mkdirSync(root, { recursive: true });

// No source loader or replacement worker: these children import the real build
// entry and its split chunks with the native worker_threads implementation.
const driver = `
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
const [entry, path, harness, root] = process.argv.slice(2);
const base = { path, harness, sessionId: 'bundle-' + harness };
let checked = 0;
let observed = [];
async function run(extra, expectError = false) {
  const worker = new Worker(pathToFileURL(entry), { workerData: { ...base, ...extra } });
  let reply;
  let error;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker did not exit')); }, 5000);
    worker.on('message', (message) => {
      if (message.kind === 'query') {
        const open = execFileSync('lsof', ['-nP', '-p', String(process.pid), '-Fn'], { encoding: 'utf8' });
        observed = open.split('\\n').filter(line => line.startsWith('n') && /\\.db(?:-wal|-shm)?$/.test(line));
        assert(observed.some(line => line.slice(1) === path), 'lsof must observe the worker-owned database');
        assert(observed.every(line => line.slice(1).startsWith(root + '/')), 'database escaped throwaway root');
        assert(!open.includes('/.config/opencode/') && !open.includes('/.config/cortexkit/'), 'live config opened');
        worker.postMessage({ id: message.id, result: null });
      } else reply = message;
    });
    worker.on('error', (value) => { error = value; });
    worker.on('exit', (code) => { clearTimeout(timer); if (!expectError && (error || code)) reject(error ?? new Error('exit ' + code)); else resolve(); });
  });
  checked++;
  if (expectError) assert(error || reply?.kind === 'error', 'the crash control must execute');
  else assert(reply && reply.kind !== 'error', JSON.stringify(reply));
  return reply;
}
const search = { projectPath: 'git:bundle-review', query: 'historian cache wiring', options: { sources: ['memory'], countRetrievals: false, measurementDisabled: true, embeddingEnabled: true }, embeddingRuntimeEnabled: true, embeddingHostBusy: false, snapshot: null };
const result = await run(search);
assert.equal(result.kind, 'result');
assert.equal(result.results[0].content, 'historian cache wiring details');
assert.equal(result.results[0].source, 'memory');
await run({ path: root + '/missing-parent/no.db', ...search }, true);
const restarted = await run(search);
assert.deepEqual(restarted.results, result.results);
const sqlite = await import(process.versions.bun ? 'bun:sqlite' : 'node:sqlite');
const owner = new (sqlite.Database ?? sqlite.DatabaseSync)(path);
owner.exec('BEGIN IMMEDIATE');
try {
  const read = await run(search);
  assert.deepEqual(read.results, result.results);
} finally { owner.exec('ROLLBACK'); }
await run({ ...search, decision: { messageId: 'fresh', decision: 'hint', text: 'unserved' } });
assert.equal(owner.prepare('SELECT count(*) AS n FROM session_meta').get().n, 0, 'reader cannot create decision/session rows');
await run(search);
owner.close();
// Each worker exits by closing its connection and port; repeated sessions must
// not leave SQLite handles behind. This also tests shutdown without terminate().
for (let i = 0; i < 12; i++) await run({ ...search, sessionId: 'many-' + i });
const evidence = JSON.stringify({ version: process.version, bun: process.versions.bun ?? null, harness, checked, observed });
writeFileSync(root + '/evidence.json', evidence);
console.log(evidence);
`;

for (const [runtime, directory, harness, packed] of [
    ["bun", "packages/plugin/dist", "opencode", false],
    ["node", "packages/plugin/dist", "opencode", false],
    ["node", "packages/plugin/dist/v2", "opencode2", false],
    ["node", "packages/pi-plugin/dist", "pi", false],
    ["node", "packages/pi-plugin/dist", "omp", false],
    ["bun", "packages/plugin/dist", "opencode", true],
    ["node", "packages/plugin/dist/v2", "opencode2", true],
    ["node", "packages/pi-plugin/dist", "pi", true],
    ["node", "packages/pi-plugin/dist", "omp", true],
    ["pi", "packages/pi-plugin/dist", "pi", false],
    ["omp", "packages/pi-plugin/dist", "omp", false],
] as const) {
    test.skipIf(!Bun.which(runtime))(
        `review bundle: ${packed ? "packed " : ""}${harness} worker under ${runtime} loads, restarts, reads only and shuts down`,
        async () => {
            const fixtureRoot = realpathSync(createTestTempDirFromPath(join(root, "bundle-")));
            let workerEntry = join(repo, directory, "auto-search-worker.js");
            if (packed) {
                const packageDirectory = directory.startsWith("packages/pi-plugin")
                    ? "packages/pi-plugin"
                    : "packages/plugin";
                const pack = Bun.spawn(
                    [
                        "npm",
                        "pack",
                        "--ignore-scripts",
                        "--json",
                        "--pack-destination",
                        fixtureRoot,
                    ],
                    {
                        windowsHide: true,
                        cwd: join(repo, packageDirectory),
                        stdout: "pipe",
                        stderr: "pipe",
                    },
                );
                const [json, error, code] = await Promise.all([
                    new Response(pack.stdout).text(),
                    new Response(pack.stderr).text(),
                    pack.exited,
                ]);
                expect({ code, error: code === 0 ? "" : error }).toEqual({ code: 0, error: "" });
                const metadata = JSON.parse(json)[0] as {
                    filename: string;
                    files: { path: string }[];
                };
                const relative = directory.endsWith("/v2")
                    ? "dist/v2/auto-search-worker.js"
                    : "dist/auto-search-worker.js";
                expect(metadata.files.some((file) => file.path === relative)).toBe(true);
                const unpack = Bun.spawn(
                    ["tar", "-xzf", join(fixtureRoot, metadata.filename), "-C", fixtureRoot],
                    { windowsHide: true, stdout: "pipe", stderr: "pipe" },
                );
                expect(await unpack.exited).toBe(0);
                workerEntry = join(fixtureRoot, "package", relative);
            }
            const path = join(fixtureRoot, "context.db");
            const db = new Database(path);
            initializeDatabase(db);
            runMigrations(db);
            insertMemory(db, {
                projectPath: "git:bundle-review",
                category: "ARCHITECTURE_DECISIONS",
                content: "historian cache wiring details",
            });
            db.close();
            const driverPath = join(fixtureRoot, "driver.mjs");
            writeFileSync(driverPath, driver);
            const host = runtime === "pi" || runtime === "omp";
            const argumentsForDriver = [workerEntry, path, harness, fixtureRoot];
            const command =
                runtime === "omp"
                    ? [
                          runtime,
                          "--mode",
                          "rpc",
                          "--no-session",
                          "--no-skills",
                          "--no-tools",
                          "--no-lsp",
                          "--no-pty",
                          "--no-rules",
                          "--no-title",
                          "--provider",
                          "openai",
                          "--model",
                          "gpt-4o",
                          "--api-key",
                          "review-fixture-not-a-secret",
                          "--extension",
                          fileURLToPath(
                              new URL("./auto-search-omp-host-review.fixture.ts", import.meta.url),
                          ),
                      ]
                    : host
                      ? [
                            runtime,
                            "--mode",
                            "rpc",
                            "--no-session",
                            "--no-extensions",
                            "--no-skills",
                            "--no-tools",
                            "--provider",
                            "openai",
                            "--model",
                            "gpt-4o",
                            "--api-key",
                            "review-fixture-not-a-secret",
                            "--extension",
                            fileURLToPath(
                                new URL("./auto-search-host-review.fixture.ts", import.meta.url),
                            ),
                        ]
                      : [runtime, driverPath, ...argumentsForDriver];
            const child = Bun.spawn(command, {
                windowsHide: true,
                cwd: host ? fixtureRoot : repo,
                stdin: "pipe",
                env: {
                    PATH: process.env.PATH,
                    TMPDIR: process.env.TMPDIR,
                    PI_CODING_AGENT_DIR: join(fixtureRoot, "pi-agent"),
                    PI_CODING_AGENT_SESSION_DIR: join(fixtureRoot, "sessions"),
                    OMP_CONFIG_DIR: join(fixtureRoot, "omp-config"),
                    PI_OFFLINE: "1",
                    PI_TELEMETRY: "0",
                    MC_REVIEW_DRIVER: driverPath,
                    MC_REVIEW_ARGUMENTS: JSON.stringify(argumentsForDriver),
                    HOME: join(fixtureRoot, "home"),
                    XDG_CONFIG_HOME: join(fixtureRoot, "config"),
                    XDG_DATA_HOME: join(fixtureRoot, "data"),
                    XDG_CACHE_HOME: join(fixtureRoot, "cache"),
                    XDG_STATE_HOME: join(fixtureRoot, "state"),
                    XDG_RUNTIME_DIR: join(fixtureRoot, "runtime"),
                    OPENCODE_DB: join(fixtureRoot, "opencode.db"),
                    MAGIC_CONTEXT_STORAGE_DIR: fixtureRoot,
                    MAGIC_CONTEXT_LOG_PATH: join(fixtureRoot, "worker.log"),
                },
                stdout: "pipe",
                stderr: "pipe",
            });
            const [output, errors, code] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
            ]);
            expect({ code, errors: code === 0 ? "" : errors + output }).toEqual({
                code: 0,
                errors: "",
            });
            const report = JSON.parse(readFileSync(join(fixtureRoot, "evidence.json"), "utf8"));
            expect(report.checked).toBe(18);
            expect(report.observed.some((line: string) => line.includes(path))).toBe(true);
            const reader = new Database(path);
            try {
                const row = reader
                    .prepare("SELECT 1 FROM session_meta WHERE session_id = ?")
                    .get(`bundle-${harness}`);
                expect(row).toBeFalsy();
            } finally {
                reader.close();
            }
            console.log(`bundled worker evidence: ${JSON.stringify(report)}`);
        },
        60000,
    );
}
