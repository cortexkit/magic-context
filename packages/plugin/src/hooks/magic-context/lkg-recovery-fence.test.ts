import { Database as BunDatabase } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
    LKG_SLOT_CHUNKS_DDL,
    LKG_SLOTS_DDL,
} from "../../features/magic-context/migration-v94-write-split";
import { clearSession, closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { deleteSessionScopedRows } from "../../features/magic-context/storage-session-tables";
import type { Database } from "../../shared/sqlite";
import { writeStorageFileSync } from "../../shared/storage-permissions";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import {
    clearPersistedLkgSlotStrict,
    loadPersistedLkgSlot,
    pruneStaleLkgSlots,
    saveLkgSlotToDb,
} from "./lkg-persist";
import {
    __test,
    clearLkgFenceProcessState,
    clearLkgRecoveryFence,
    hasCleanLkgRecoveryFence,
    lkgFenceRequiresRebuild,
    lkgRecoveryFencePath,
    lkgRecoverySlotKey,
    markLkgRecoveryDirty,
} from "./lkg-recovery-fence";
import type { LkgSlot } from "./lkg-slot";

const previousRoot = process.env.MAGIC_CONTEXT_STORAGE_DIR;
const previousTestRoot = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
const previousXdg = process.env.XDG_DATA_HOME;
const roots: string[] = [];
const restorers: (() => void)[] = [];
afterEach(() => {
    clearLkgFenceProcessState();
    for (const restore of restorers.splice(0).reverse()) restore();
    closeDatabase();
    if (previousRoot === undefined) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
    else process.env.MAGIC_CONTEXT_STORAGE_DIR = previousRoot;
    for (const [name, value] of [
        ["MAGIC_CONTEXT_TEST_DATA_DIR", previousTestRoot],
        ["XDG_DATA_HOME", previousXdg],
    ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    for (const root of roots.splice(0)) cleanupTestTempDir(root);
});
const slot: LkgSlot = {
    jsonPrefix: '[{"text":"old"}]',
    inputIdSeq: ["one"],
    inputContentDigests: ["digest"],
    lastInputMessageId: "one",
    modelKey: "provider/model",
    providerKey: "provider",
    capturedAt: 1,
};
function fixture(seed = true) {
    const { dir } = createTestTempDir("mc-fence-");
    roots.push(dir);
    process.env.MAGIC_CONTEXT_STORAGE_DIR = dir;
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dir;
    process.env.XDG_DATA_HOME = dir;
    const dbPath = join(dir, "context.db");
    const raw = new BunDatabase(dbPath);
    raw.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        ${LKG_SLOTS_DDL} ${LKG_SLOT_CHUNKS_DDL}
        CREATE TABLE session_meta (session_id TEXT PRIMARY KEY, trailing_blank_decisions TEXT DEFAULT '');
        CREATE TABLE session_projects (session_id TEXT, updated_at INTEGER);`);
    const db = raw as unknown as Database;
    if (seed) expect(saveLkgSlotToDb(db, "session", slot)).toBe(true);
    const load = () => loadPersistedLkgSlot(db, "session");
    const dirty = () =>
        markLkgRecoveryDirty({ sessionId: "session", slot: load()!, processLocalProof: false });
    const path = lkgRecoveryFencePath("session");
    const record = () =>
        JSON.parse(readFileSync(path, "utf8")) as { state: string; slotKey: string; host: string };
    // Seed a real dirty-to-clean transition for publication/crash witnesses.
    // Ordinary synchronous captures intentionally do not create a fence file.
    if (seed && hasCleanLkgRecoveryFence("session", load()!)) {
        dirty();
        expect(saveLkgSlotToDb(db, "session", slot, undefined, { rebuild: true })).toBe(true);
    }
    return { dir, dbPath, raw, db, load, dirty, path, record };
}
function child(f: ReturnType<typeof fixture>, code: string) {
    return spawnSync(
        process.execPath,
        [
            "--eval",
            `
import { Database } from 'bun:sqlite';
import { loadPersistedLkgSlot, saveLkgSlotToDb } from ${JSON.stringify(join(import.meta.dir, "lkg-persist.ts"))};
import { __test, markLkgRecoveryDirty } from ${JSON.stringify(join(import.meta.dir, "lkg-recovery-fence.ts"))};
const db = new Database(${JSON.stringify(f.dbPath)});
db.exec('PRAGMA busy_timeout=5000');
const load = () => loadPersistedLkgSlot(db, 'session');
const slot = load();
${code}`,
        ],
        {
            env: {
                ...process.env,
                MAGIC_CONTEXT_STORAGE_DIR: f.dir,
                MAGIC_CONTEXT_TEST_DATA_DIR: f.dir,
                XDG_DATA_HOME: f.dir,
            },
            encoding: "utf8",
            windowsHide: true,
            timeout: 20000,
        },
    );
}

describe.skipIf(process.platform === "win32")("durable recovery fence", () => {
    test("warm synchronous captures perform zero fence I/O", () => {
        const f = fixture();
        const operations: string[] = [];
        try {
            restorers.push(__test.setIoObserver((operation) => operations.push(operation)));
            for (let i = 0; i < 32; i++) {
                const next = {
                    ...slot,
                    jsonPrefix: JSON.stringify([{ text: `sync-${i}` }]),
                    capturedAt: i + 2,
                };
                expect(saveLkgSlotToDb(f.db, "session", next)).toBe(true);
                expect(hasCleanLkgRecoveryFence("session", next)).toBe(true);
            }
            expect(operations).toEqual([]);
            expect(f.record().state).toBe("clean");
            clearLkgFenceProcessState("session");
            expect(hasCleanLkgRecoveryFence("session", f.load()!)).toBe(true);
            expect(operations).toEqual(["read"]);
        } finally {
            f.raw.close();
        }
    });
    test("cold absence and clean marks allow replay, while corrupt and mismatched scope refuse", () => {
        const f = fixture();
        try {
            expect(hasCleanLkgRecoveryFence("session", f.load()!)).toBe(true);
            expect(hasCleanLkgRecoveryFence("other-session", f.load()!)).toBe(true);
            expect(hasCleanLkgRecoveryFence("session", { ...slot, capturedAt: 2 })).toBe(true);
            expect(hasCleanLkgRecoveryFence("session", { ...slot, modelKey: "other" })).toBe(true);
            const wrongHost = JSON.parse(readFileSync(f.path, "utf8"));
            wrongHost.host = "another-host";
            wrongHost.checksum = new Bun.CryptoHasher("sha256")
                .update(
                    JSON.stringify([
                        wrongHost.version,
                        wrongHost.sessionId,
                        wrongHost.host,
                        wrongHost.modelKey,
                        wrongHost.providerKey,
                        wrongHost.slotKey,
                        wrongHost.servedDigest,
                        wrongHost.revision,
                        wrongHost.state,
                    ]),
                )
                .digest("hex");
            writeStorageFileSync(f.path, JSON.stringify(wrongHost));
            clearLkgFenceProcessState("session");
            expect(hasCleanLkgRecoveryFence("session", f.load()!)).toBe(false);
            writeStorageFileSync(f.path, "corrupt");
            clearLkgFenceProcessState("session");
            expect(hasCleanLkgRecoveryFence("session", f.load()!)).toBe(false);
            expect(f.dirty).toThrow("No clean durable");
            rmSync(f.path);
            clearLkgFenceProcessState("session");
            expect(hasCleanLkgRecoveryFence("session", f.load()!)).toBe(true);
            expect(f.dirty()).toBeString();
        } finally {
            f.raw.close();
        }
    });
    test("a failed dirty publication never returns a recovery permission", () => {
        const f = fixture();
        try {
            restorers.push(
                __test.setObserver((phase) => {
                    if (phase === "temp-synced") throw new Error("dirty disk failure");
                }),
            );
            expect(f.dirty).toThrow("dirty disk failure");
            expect(f.record().state).toBe("clean");
            expect(readdirSync(f.dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
        } finally {
            f.raw.close();
        }
    });
    test("retained raw-tail captures stay dirty until an explicit healthy rebuild", () => {
        const f = fixture();
        try {
            const revision = f.dirty();
            expect(f.record().state).toBe("dirty");
            const held = {
                ...slot,
                jsonPrefix: '[{"text":"old"},{"text":"raw tail"}]',
                capturedAt: 2,
            };
            expect(
                saveLkgSlotToDb(f.db, "session", held, undefined, {
                    retainDirtyRevision: revision,
                }),
            ).toBe(true);
            expect(hasCleanLkgRecoveryFence("session", f.load()!)).toBe(false);
            expect(
                saveLkgSlotToDb(f.db, "session", { ...held, capturedAt: 3 }, undefined, {
                    rebuild: true,
                }),
            ).toBe(true);
            expect(hasCleanLkgRecoveryFence("session", f.load()!)).toBe(true);
        } finally {
            f.raw.close();
        }
    });
    test("ordinary publisher cannot clean a concurrent recovery", () => {
        const f = fixture();
        try {
            const result = child(
                f,
                "markLkgRecoveryDirty({sessionId:'session', slot, load, processLocalProof:false});",
            );
            expect(result.status, result.stderr).toBe(0);
            expect(
                saveLkgSlotToDb(f.db, "session", {
                    ...slot,
                    jsonPrefix: '[{"text":"late tags"}]',
                    capturedAt: 2,
                }),
            ).toBe(true);
            expect(f.load()?.jsonPrefix).toBe('[{"text":"late tags"}]');
            expect(f.record().state).toBe("dirty");
            clearLkgFenceProcessState("session");
            expect(hasCleanLkgRecoveryFence("session", f.load()!)).toBe(false);
            expect(saveLkgSlotToDb(f.db, "session", f.load()!, undefined, { rebuild: true })).toBe(
                true,
            );
            expect(f.record().state).toBe("clean");
        } finally {
            f.raw.close();
        }
    });
    test("a crash after dirty mark but before return leaves restart refused", () => {
        const f = fixture();
        try {
            const result = child(
                f,
                "__test.setObserver(phase => { if (phase === 'dirty') process.exit(77); }); markLkgRecoveryDirty({sessionId:'session', slot, load, processLocalProof:false});",
            );
            expect(result.status, result.stderr).toBe(77);
            expect(f.record().state).toBe("dirty");
            clearLkgFenceProcessState("session");
            expect(hasCleanLkgRecoveryFence("session", f.load()!)).toBe(false);
            expect(saveLkgSlotToDb(f.db, "session", slot, undefined, { rebuild: true })).toBe(true);
        } finally {
            f.raw.close();
        }
    });
    test("a crash between temp sync and rename never publishes the dirty permission", () => {
        const f = fixture();
        try {
            const result = child(
                f,
                "__test.setObserver(phase => { if (phase === 'temp-synced') process.exit(77); }); markLkgRecoveryDirty({sessionId:'session', slot, load, processLocalProof:false});",
            );
            expect(result.status, result.stderr).toBe(77);
            expect(f.record().state).toBe("clean");
            clearLkgFenceProcessState("session");
            expect(hasCleanLkgRecoveryFence("session", f.load()!)).toBe(true);
            f.dirty();
            expect(f.record().state).toBe("dirty");
        } finally {
            f.raw.close();
        }
    });
    test("a crash between LKG commit and clean publication stays dirty", () => {
        const f = fixture();
        try {
            const result = child(
                f,
                "markLkgRecoveryDirty({sessionId:'session', slot, processLocalProof:false}); __test.setObserver(phase => { if (phase === 'committed') process.exit(77); }); saveLkgSlotToDb(db, 'session', {...slot, jsonPrefix:'[{\"text\":\"replacement\"}]', capturedAt:2}, undefined, {rebuild:true});",
            );
            expect(result.status, result.stderr).toBe(77);
            expect(f.load()?.jsonPrefix).toContain("replacement");
            expect(f.record().state).toBe("dirty");
            clearLkgFenceProcessState("session");
            expect(hasCleanLkgRecoveryFence("session", f.load()!)).toBe(false);
        } finally {
            f.raw.close();
        }
    });
    test("a failed clean publish leaves dirty evidence after a committed replacement", () => {
        const f = fixture();
        f.dirty();
        let committed = false;
        try {
            restorers.push(
                __test.setObserver((phase) => {
                    if (phase === "committed") committed = true;
                    if (phase === "temp-synced" && committed)
                        throw new Error("clean publication interrupted");
                }),
            );
            expect(() =>
                saveLkgSlotToDb(
                    f.db,
                    "session",
                    { ...slot, jsonPrefix: '[{"text":"replacement"}]', capturedAt: 2 },
                    undefined,
                    { rebuild: true },
                ),
            ).toThrow("clean publication interrupted");
            expect(f.load()?.jsonPrefix).toContain("replacement");
            expect(f.record().state).toBe("dirty");
            expect(hasCleanLkgRecoveryFence("session", f.load()!)).toBe(false);
        } finally {
            f.raw.close();
        }
    });
    test("two processes racing to publish serialize commit through clean certification", async () => {
        const f = fixture();
        f.raw.exec("CREATE TABLE publication_log (ordinal INTEGER PRIMARY KEY, actor TEXT)");
        const run = async (actor: string) => {
            const script = `
import { Database } from 'bun:sqlite';
import { loadPersistedLkgSlot, saveLkgSlotToDb } from ${JSON.stringify(join(import.meta.dir, "lkg-persist.ts"))};
import { __test, prepareLkgCaptureFence, LkgRecoveryFenceError } from ${JSON.stringify(join(import.meta.dir, "lkg-recovery-fence.ts"))};
const db = new Database(${JSON.stringify(f.dbPath)});
db.exec('PRAGMA busy_timeout=5000');
const pause = new Int32Array(new SharedArrayBuffer(4));
__test.setObserver(phase => { if (phase === 'committed') Atomics.wait(pause, 0, 0, 15); });
for (let i=0, attempts=0; i<12;) {
 if (++attempts > 1000) throw new Error('publication never completed');
 const old = loadPersistedLkgSlot(db, 'session');
 const value = {...old, jsonPrefix:JSON.stringify([{text:${JSON.stringify(actor)} + i}]), capturedAt:Date.now()};
 const revision = prepareLkgCaptureFence({sessionId:'session', slot:value, previousSlot:old, rebuild:true});
 try {
  if (!saveLkgSlotToDb(db, 'session', value, () => db.query("INSERT INTO publication_log (ordinal,actor) SELECT COALESCE(MAX(ordinal),0)+1, ? FROM publication_log").run(${JSON.stringify(actor)}), {rebuild:true, ownDirtyRevision:revision, requiredRevision:revision})) throw new Error('publication failed');
  i++;
 } catch (error) { if (!(error instanceof LkgRecoveryFenceError)) throw error; }
}
`;
            const child = Bun.spawn([process.execPath, "--eval", script], {
                env: {
                    ...process.env,
                    MAGIC_CONTEXT_STORAGE_DIR: f.dir,
                    MAGIC_CONTEXT_TEST_DATA_DIR: f.dir,
                    XDG_DATA_HOME: f.dir,
                },
                stdout: "pipe",
                windowsHide: true,
                stderr: "pipe",
            });
            const [exit, error] = await Promise.all([
                child.exited,
                new Response(child.stderr).text(),
            ]);
            expect(exit, error).toBe(0);
        };
        try {
            await Promise.all([run("A"), run("B")]);
            expect(
                (f.raw.query("SELECT COUNT(*) AS n FROM publication_log").get() as { n: number }).n,
            ).toBe(24);
            expect(f.record().slotKey).toBe(lkgRecoverySlotKey(f.load()!));
            clearLkgFenceProcessState("session");
            expect(hasCleanLkgRecoveryFence("session", f.load()!)).toBe(true);
        } finally {
            f.raw.close();
        }
    });
    test("a failed final clean notification cannot leave a visible clean certificate", () => {
        const f = fixture();
        f.dirty();
        try {
            restorers.push(
                __test.setObserver((phase) => {
                    if (phase === "clean") throw new Error("clean finish failed");
                }),
            );
            expect(() =>
                saveLkgSlotToDb(
                    f.db,
                    "session",
                    { ...slot, jsonPrefix: '[{"text":"replacement"}]', capturedAt: 2 },
                    undefined,
                    { rebuild: true },
                ),
            ).toThrow("clean finish failed");
            expect(f.load()?.jsonPrefix).toContain("replacement");
            expect(hasCleanLkgRecoveryFence("session", f.load()!)).toBe(false);
        } finally {
            f.raw.close();
        }
    });
    test("session clear removes the certificate and orphan temporary records", () => {
        const f = fixture();
        try {
            writeStorageFileSync(`${f.path}.dead.tmp`, "orphan", { forcePrivate: true });
            clearPersistedLkgSlotStrict(f.db, "session");
            expect(f.load()).toBeUndefined();
            expect(existsSync(f.path)).toBe(false);
            expect(existsSync(`${f.path}.dead.tmp`)).toBe(false);
            clearLkgRecoveryFence("session");
        } finally {
            f.raw.close();
        }
    });
    test("deleting an unfenced session does not create a lock directory or enter the mutex", () => {
        const f = fixture(false);
        let mutexCalls = 0;
        restorers.push(
            __test.setIoObserver((phase) => {
                if (phase === "mutex") mutexCalls++;
            }),
        );
        try {
            clearLkgRecoveryFence("never-fenced");
            expect(mutexCalls).toBe(0);
            expect(existsSync(`${lkgRecoveryFencePath("never-fenced")}.locks`)).toBe(false);
        } finally {
            f.raw.close();
        }
    });
    test("session deletion clears the fence outside its SQLite transaction and removes the empty lock directory", () => {
        const f = fixture();
        try {
            const full = openDatabase();
            const transactionStates: boolean[] = [];
            restorers.push(
                __test.setIoObserver((phase) => {
                    if (phase === "mutex")
                        transactionStates.push(
                            (full as unknown as { inTransaction: boolean }).inTransaction,
                        );
                }),
            );
            clearSession(full, "session");
            expect(transactionStates).toEqual([false]);
            expect(existsSync(f.path)).toBe(false);
            expect(existsSync(`${f.path}.locks`)).toBe(false);
        } finally {
            f.raw.close();
        }
    });
    test("orphan session deletion and stale-slot sweeping remove their certificates", () => {
        const f = fixture();
        try {
            const full = openDatabase();
            if (!full) throw new Error("Expected disposable full-schema database");
            expect(saveLkgSlotToDb(full, "orphan", slot)).toBe(true);
            markLkgRecoveryDirty({ sessionId: "orphan", slot, processLocalProof: true });
            expect(existsSync(lkgRecoveryFencePath("orphan"))).toBe(true);
            full.transaction(() => deleteSessionScopedRows(full, ["orphan"])).immediate();
            expect(existsSync(lkgRecoveryFencePath("orphan"))).toBe(false);
            pruneStaleLkgSlots(f.db, Date.now());
            expect(existsSync(f.path)).toBe(false);
        } finally {
            f.raw.close();
        }
    });
    test("measures the durable dirty-mark cost on disposable storage", () => {
        const f = fixture();
        const times: number[] = [];
        try {
            for (let i = 0; i < 12; i++) {
                const start = performance.now();
                f.dirty();
                times.push(performance.now() - start);
                expect(
                    saveLkgSlotToDb(
                        f.db,
                        "session",
                        {
                            ...slot,
                            capturedAt: i + 2,
                            jsonPrefix: JSON.stringify([{ text: String(i) }]),
                        },
                        undefined,
                        { rebuild: true },
                    ),
                ).toBe(true);
            }
            times.sort((a, b) => a - b);
            console.info(
                `LKG_FENCE_COST samples=${times.length} dirty_median_ms=${times[6]} dirty_max_ms=${times.at(-1)}`,
            );
            expect(hasCleanLkgRecoveryFence("session", f.load()!)).toBe(true);
        } finally {
            f.raw.close();
        }
    });
    test("certificates and containing directories are owner-only", () => {
        const f = fixture();
        try {
            expect(statSync(f.path).mode & 0o777).toBe(0o600);
            expect(statSync(dirname(f.path)).mode & 0o777).toBe(0o700);
        } finally {
            f.raw.close();
        }
    });
});

test("Windows branch retains in-process recovery but refuses restart without publishing files", () => {
    restorers.push(__test.setPlatform("win32"));
    const f = fixture();
    try {
        expect(existsSync(f.path)).toBe(false);
        expect(hasCleanLkgRecoveryFence("session", f.load()!)).toBe(false);
        expect(lkgFenceRequiresRebuild("session", f.load()!, true)).toBe(false);
        expect(lkgFenceRequiresRebuild("session", f.load()!, false)).toBe(true);
        expect(
            markLkgRecoveryDirty({
                sessionId: "session",
                slot: f.load()!,
                processLocalProof: true,
            }),
        ).toBe("process-local");
        expect(() =>
            markLkgRecoveryDirty({
                sessionId: "session",
                slot: f.load()!,
                processLocalProof: false,
            }),
        ).toThrow("Restart replay");
        expect(existsSync(dirname(f.path))).toBe(false);
    } finally {
        f.raw.close();
    }
});
