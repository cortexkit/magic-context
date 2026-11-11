import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestTempDir, createTestTempDirFromPath } from "./test-temp-dir";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) cleanupTestTempDir(root);
});

function child(root: string, script: string) {
    return spawnSync(process.execPath, ["--eval", script], {
        cwd: import.meta.dir,
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
        env: {
            ...process.env,
            NODE_ENV: "test",
            XDG_DATA_HOME: root,
            XDG_CONFIG_HOME: root,
            MAGIC_CONTEXT_TEST_DATA_DIR: root,
            MAGIC_CONTEXT_STORAGE_DIR: root,
        },
    });
}

describe.skipIf(process.platform === "win32")("storage creation under umask 0", () => {
    beforeAll(() => mkdirSync("/tmp/opencode/mc-walk-pr", { recursive: true, mode: 0o700 }));
    it("creates helper outputs and public storage records privately before any startup walk", () => {
        const root = createTestTempDirFromPath("/tmp/opencode/mc-walk-pr/creators-");
        roots.push(root);
        const result = child(
            root,
            `
import { closeSync, lstatSync, readdirSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import * as p from './storage-permissions.ts';
import { withStorageFileMutex } from './storage-file-mutex.ts';
import { markAnnouncementSeen } from './announcement.ts';
import { rememberGitIdentity } from '../features/magic-context/memory/project-identity-cache.ts';
import { refreshModelLimitsFromApi } from './models-dev-cache.ts';
import { appendWindowReport } from '../features/magic-context/window-report-ledger.ts';
import { markLkgRecoveryDirty } from '../hooks/magic-context/lkg-recovery-fence.ts';
import { MagicContextRpcServer } from './rpc-server.ts';
import { rpcPortDir } from './rpc-utils.ts';
import { emitStallReport } from './host-stall-profiler-common.ts';
const root = process.env.MAGIC_CONTEXT_STORAGE_DIR;
const check = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    const expected = stat.isDirectory() ? 0o700 : 0o600;
    if ((stat.mode & 0o777) !== expected) throw new Error(path + ' mode=' + (stat.mode & 0o777).toString(8));
    if (stat.isDirectory()) for (const entry of readdirSync(path)) check(join(path, entry));
};
const previous = process.umask(0);
let rpc;
try {
    p.ensureStorageDirectorySync(join(root, 'helpers', 'nested'));
    p.ensurePrivateStorageDirectorySync(join(root, 'private'));
    p.writeStorageFileSync(join(root, 'sync'), 'x');
    p.writeStorageFileAtomicSync(join(root, 'atomic'), 'x');
    p.writeStorageFileDurableAtomicSync(join(root, 'durable', 'record'), 'x');
    p.copyStorageFileSync(join(root, 'sync'), join(root, 'copy'));
    p.copyStorageTreeSync(join(root, 'durable'), join(root, 'copy-tree'));
    closeSync(p.openStorageFileSync(join(root, 'open'), 'wx'));
    await p.writeStorageFileAsync(join(root, 'async', 'file'), 'x');
    const stream = p.createStorageWriteStream(join(root, 'stream'));
    const finished = once(stream, 'close');
    stream.end('x');
    await finished;
    const handle = await p.createStorageFileHandleAsync(join(root, 'handle'), 'wx');
    await p.writeStorageFileHandleAsync(handle, 'x');
    await handle.close();
    withStorageFileMutex(join(root, 'mutex'), () => check(root));
    markAnnouncementSeen('0.49.37');
    rememberGitIdentity(join(root, 'project'), 'git:0123456789abcdef');
    await refreshModelLimitsFromApi({ config: { providers: async () => ({ data: { providers: [
        { id: 'test', models: { model: { limit: { context: 100000, output: 10000 } } } }
    ] } }) } });
    appendWindowReport({ access_path: 'api', geometry: 'unknown', observed_at_ms: 123 });
    markLkgRecoveryDirty({ sessionId: 'private-creation', processLocalProof: false, slot: {
        jsonPrefix: '[{"text":"old"}]', inputIdSeq: ['one'], inputContentDigests: ['digest'],
        lastInputMessageId: 'one', modelKey: 'provider/model', providerKey: 'provider', capturedAt: 1,
    } });
    emitStallReport({ profilerDir: () => join(root, 'host-profiler'), wallNow: () => 1000,
        now: () => 1000, pid: process.pid, bunVersion: process.versions.bun, log: () => {},
    }, { startMs: 0, endMs: 1000, traces: [], windowed: [], windowFilter: 'all',
        options: { thresholdMs: 500, sampleIntervalMs: 10 }, before: null,
        after: { at: 'fixture', heap_size_bytes: null, jsc_memory: null, rss_bytes: null,
            percent_available_memory_in_use: null }, backend: 'jsc' });
    rpc = new MagicContextRpcServer(root, join(root, 'project'));
    if (await rpc.start() <= 0) throw new Error('RPC server did not start');
    if (!readdirSync(rpcPortDir(root, join(root, 'project'))).some(name => name.endsWith('.json')))
        throw new Error('RPC discovery record was not published');
    check(root);
    console.log('PRIVATE_CREATORS_OK');
} finally {
    rpc?.stop();
    process.umask(previous);
}
`,
        );
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain("PRIVATE_CREATORS_OK");
        console.log(result.stdout.trim());
        const storage = join(root, "cortexkit", "magic-context");
        for (const name of ["project-identities", "lkg-recovery-fences"])
            expect(lstatSync(join(storage, name)).mode & 0o777).toBe(0o700);
        expect(lstatSync(join(root, "host-profiler")).mode & 0o777).toBe(0o700);
        expect(readdirSync(storage)).toContain("window-reports.jsonl");
        expect(readdirSync(storage)).toContain("model-context-limits-opencode.json");
    });

    it("keeps SQLite DB, WAL and SHM private and bounded on a later real open", () => {
        const root = createTestTempDirFromPath("/tmp/opencode/mc-walk-pr/sqlite-");
        roots.push(root);
        const result = child(
            root,
            `
import { expect, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { openDatabase, closeDatabase } from '../features/magic-context/storage-db.ts';
const root = process.env.MAGIC_CONTEXT_STORAGE_DIR;
const path = join(root, 'custom.sqlite');
const previous = process.umask(0);
try {
    const db = openDatabase({ dbPath: path });
    db.exec('CREATE TABLE permission_probe (id INTEGER); INSERT INTO permission_probe VALUES (1)');
    for (const suffix of ['', '-wal', '-shm']) {
        expect(fs.lstatSync(path + suffix).mode & 0o777).toBe(0o600);
    }
    closeDatabase();
    fs.mkdirSync(join(root, 'lkg-recovery-fences'), { mode: 0o700 });
    for (let i = 0; i < 2000; i++) fs.writeFileSync(join(root, 'lkg-recovery-fences', i + '.json'), '{}', { mode: 0o600 });
    const lstat = spyOn(fs, 'lstatSync');
    try {
        expect(openDatabase({ dbPath: path })).not.toBeNull();
        expect(lstat.mock.calls.length).toBeLessThanOrEqual(16);
        console.log('SQLITE_PRIVATE_OK lstat=' + lstat.mock.calls.length);
    } finally { lstat.mockRestore(); }
} finally {
    closeDatabase();
    process.umask(previous);
}
`,
        );
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain("SQLITE_PRIVATE_OK");
        console.log(result.stdout.trim());
    });

    it("retains the full check for third-party model downloads under umask 0", () => {
        const root = createTestTempDirFromPath("/tmp/opencode/mc-walk-pr/models-");
        roots.push(root);
        const result = child(
            root,
            `
import { expect, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { FileCache } from '../../node_modules/@huggingface/transformers/src/utils/cache/FileCache.js';
import { tightenStorageTreeSync, writeStorageFileSync } from './storage-permissions.ts';
const root = process.env.MAGIC_CONTEXT_STORAGE_DIR;
const cache = join(root, 'models');
const file = join(cache, 'org/model/onnx/weights.bin');
const previous = process.umask(0);
try {
    await new FileCache(cache).put('org/model/onnx/weights.bin', new Response('fixture'));
    expect(fs.lstatSync(cache).mode & 0o777).toBe(0o777);
    expect(fs.lstatSync(file).mode & 0o777).toBe(0o666);
    writeStorageFileSync(join(root, '.storage-permissions-v1'), '1\\n');
    const lstat = spyOn(fs, 'lstatSync');
    try {
        expect(tightenStorageTreeSync(root)).toEqual({ tightened: 5, failures: 0 });
        expect(lstat.mock.calls.length).toBeLessThanOrEqual(11);
    } finally { lstat.mockRestore(); }
    expect(fs.lstatSync(cache).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(file).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(join(root, '.storage-permissions-v1'))).toBe(false);
    console.log('MODELS_CHECK_OK entries=5 before=0777/0666 after=0700/0600');
} finally { process.umask(previous); }
`,
        );
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain("MODELS_CHECK_OK entries=5");
        console.log(result.stdout.trim());
    });
});
