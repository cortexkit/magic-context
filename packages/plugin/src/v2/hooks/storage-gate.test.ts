/// <reference types="bun-types" />

import { afterEach, describe, expect, it, jest, test } from "bun:test";
import type { execFileSync } from "node:child_process";
import { mkdirSync, type readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    type FailClosedReason,
    isFailClosedBlockingError,
} from "../../features/magic-context/fail-closed-block";
import type { ContextDatabase } from "../../features/magic-context/storage";
import {
    __resetSchemaFenceStateForTests,
    closeDatabase,
    getPersistedSchemaVersion,
    LATEST_SUPPORTED_VERSION,
    openDatabase,
} from "../../features/magic-context/storage-db";
import {
    __resetOffThreadMigrationClockForTests,
    __setOffThreadMigrationClockForTests,
    beginOffThreadMigration,
} from "../../shared/off-thread-migration-clock";
import { __resetRpcIdentityTestHooks, __setRpcIdentityTestHooks } from "../../shared/rpc-utils";
import { scaleTest } from "../../shared/slow-test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    createV2StorageGate,
    probeV2StorageAtBoot,
    V2_STORAGE_REOPEN_INTERVAL_MS,
} from "./storage-gate";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;

afterEach(() => {
    closeDatabase();
    __resetSchemaFenceStateForTests();
    __resetRpcIdentityTestHooks();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalTestDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function manualClock(start = 1_000) {
    let now = start;
    return {
        now: () => now,
        advance: (ms: number) => {
            now += ms;
        },
    };
}

function thrownBy(run: () => unknown): unknown {
    try {
        run();
    } catch (error) {
        return error;
    }
    throw new Error("expected a throw");
}

describe("createV2StorageGate", () => {
    it("restores the steady-state busy timeout after the nonblocking default open", async () => {
        const dataHome = createTestTempDirFromPath(join(tmpdir(), "v2-storage-gate-timeout-"));
        tempDirs.push(dataHome);
        process.env.XDG_DATA_HOME = dataHome;
        process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dataHome;
        __setRpcIdentityTestHooks({ processListExecFileSync: (() => "") as typeof execFileSync });
        const database = await createV2StorageGate().probe();
        expect(database).toBeDefined();
        expect(database!.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    });

    it("re-attempts a failed open at most once per interval and names the failure", async () => {
        const clock = manualClock();
        let opens = 0;
        const reported: FailClosedReason[] = [];
        const gate = createV2StorageGate({
            now: clock.now,
            open: () => {
                opens += 1;
                throw new Error("disk I/O error");
            },
            onUnavailable: (reason) => reported.push(reason),
        });

        expect(await gate.probe()).toBeUndefined();
        expect(opens).toBe(1);

        const first = thrownBy(() => gate.require());
        expect(isFailClosedBlockingError(first)).toBe(true);
        expect((first as Error).message).toContain("persistent storage failed (disk I/O error)");
        expect(opens).toBe(1);

        clock.advance(V2_STORAGE_REOPEN_INTERVAL_MS - 1);
        thrownBy(() => gate.require());
        expect(opens).toBe(1);

        clock.advance(1);
        thrownBy(() => gate.require());
        await gate.probe();
        expect(opens).toBe(2);
        // The same reason twice is reported once, so the console is not flooded.
        expect(reported).toEqual([{ kind: "storage_failure", cause: "disk I/O error" }]);
    });

    it("returns the database and reports recovery once a later attempt opens it", async () => {
        const clock = manualClock();
        const database = openDatabase();
        let available = false;
        let recovered = 0;
        const gate = createV2StorageGate({
            now: clock.now,
            open: () => {
                if (!available) throw new Error("not yet");
                return database;
            },
            onRecovered: () => {
                recovered += 1;
            },
        });

        expect(await gate.probe()).toBeUndefined();
        available = true;
        clock.advance(V2_STORAGE_REOPEN_INTERVAL_MS);

        thrownBy(() => gate.require());
        await gate.probe();
        expect(gate.require()).toBe(database);
        expect(gate.current()).toBe(database);
        expect(gate.reason()).toBeNull();
        expect(recovered).toBe(1);
    });
});

describe("createV2StorageGate against a migration blocked by another live host", () => {
    function blockedStore(): { dbPath: string; blocker: string } {
        const dataHome = createTestTempDirFromPath(join(tmpdir(), "v2-storage-gate-"));
        tempDirs.push(dataHome);
        process.env.XDG_DATA_HOME = dataHome;
        process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dataHome;
        // A fixed Linux identity probe confirms this test process as the server the
        // discovery record names; the empty process list means no Pi harness is live.
        __setRpcIdentityTestHooks({
            platform: "linux",
            nowMs: () => 2_000_000,
            readFileSync: ((path: string | URL) => {
                if (String(path) === `/proc/${process.pid}/stat`) {
                    return `${process.pid} (opencode) S ${Array.from({ length: 18 }, () => "0").join(" ")} 10000`;
                }
                if (String(path) === "/proc/uptime") return "1000.0 0.0";
                throw new Error(`unexpected identity read: ${String(path)}`);
            }) as typeof readFileSync,
            processListExecFileSync: (() => "") as typeof execFileSync,
        });
        openDatabase();
        closeDatabase();
        const dbPath = join(dataHome, "cortexkit", "magic-context", "context.db");
        const seeded = new Database(dbPath);
        seeded
            .prepare("DELETE FROM schema_migrations WHERE version = ?")
            .run(LATEST_SUPPORTED_VERSION);
        seeded.exec("DROP TABLE single_store_state");
        closeQuietly(seeded);
        const dir = join(dirname(dbPath), "rpc", "older-host");
        mkdirSync(dir, { recursive: true });
        const blocker = join(dir, `port-${process.pid}-older.json`);
        writeFileSync(
            blocker,
            JSON.stringify({
                port: 43123,
                pid: process.pid,
                started_at: 1_200_000,
                kind: "OpenCode server",
                instance_id: "older",
            }),
        );
        return { dbPath, blocker };
    }

    function persistedVersion(dbPath: string): number {
        const db = new Database(dbPath);
        try {
            return getPersistedSchemaVersion(db);
        } finally {
            closeQuietly(db);
        }
    }

    it("refuses with the blocking PID, then migrates on the first attempt after the blocker is gone", async () => {
        const { dbPath, blocker } = blockedStore();
        const clock = manualClock();
        let opens = 0;
        const gate = createV2StorageGate({
            now: clock.now,
            open: () => {
                opens += 1;
                return openDatabase();
            },
        });

        expect(await gate.probe()).toBeUndefined();
        const refusal = thrownBy(() => gate.require()) as Error;
        expect(refusal.message).toContain(`OpenCode server (PID ${process.pid})`);
        expect(refusal.message).toContain(
            `The database is at upstream migration v${LATEST_SUPPORTED_VERSION - 1}; this build needs v${LATEST_SUPPORTED_VERSION}.`,
        );
        expect(gate.reason()).toMatchObject({ kind: "migration_guard" });

        rmSync(blocker);
        // Within the interval the recorded refusal stands without another open.
        thrownBy(() => gate.require());
        expect(opens).toBe(1);

        clock.advance(V2_STORAGE_REOPEN_INTERVAL_MS);
        thrownBy(() => gate.require());
        await gate.probe();
        const db: ContextDatabase = gate.require();

        expect(opens).toBe(2);
        expect(db).toBeDefined();
        expect(gate.reason()).toBeNull();
        expect(persistedVersion(dbPath)).toBe(LATEST_SUPPORTED_VERSION);
    });
});

test("storage gate defers its opener until the caller returns and never piles up retries", async () => {
    const clock = manualClock();
    let release!: () => void;
    let calls = 0;
    const gate = createV2StorageGate({
        now: clock.now,
        open: () => {
            calls++;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
            return new Promise<null>((resolve) => {
                release = () => resolve(null);
            });
        },
    });
    const first = gate.probe();
    thrownBy(() => gate.require());
    expect(calls).toBe(0);
    await Promise.resolve();
    clock.advance(60_000);
    for (let i = 0; i < 100; i++) {
        thrownBy(() => gate.require());
        expect(gate.probe()).toBe(first);
    }
    expect(calls).toBe(1);
    release();
    await first;
    clock.advance(V2_STORAGE_REOPEN_INTERVAL_MS - 1);
    expect(await gate.probe()).toBeUndefined();
    expect(calls).toBe(1);
    clock.advance(1);
    const next = gate.probe();
    await Promise.resolve();
    expect(calls).toBe(2);
    release();
    await next;
});

test("boot wait retains a healthy database when the pending open becomes ready", async () => {
    const database = openDatabase();
    const ready = Promise.withResolvers<typeof database>();
    const gate = createV2StorageGate({
        open: () => ready.promise,
    });
    const pending = probeV2StorageAtBoot(gate, 1000);
    expect(gate.current()).toBeUndefined();
    ready.resolve(database);
    expect(await pending).toBe(database);
    expect(gate.require()).toBe(database);
});

test("boot wait does not count time an off-thread schema migration spends", async () => {
    // Run the boot deadline on a clock the test moves, so the result does not
    // depend on how fast the machine is. setImmediate stays real: it lets the
    // deadline's pending callbacks run between steps.
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const started = Date.now();
    __setOffThreadMigrationClockForTests({
        now: () => Date.now() - started,
        setTimeout(callback, delayMs) {
            const timer = setTimeout(callback, delayMs);
            return () => clearTimeout(timer);
        },
    });
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
    const database = openDatabase();
    const endMigration = beginOffThreadMigration();
    const opened = Promise.withResolvers<typeof database>();
    const gate = createV2StorageGate({ open: () => opened.promise });
    try {
        const pending = probeV2StorageAtBoot(gate, 30);
        // Five times the boot wait passes, all of it while the migration runs.
        jest.advanceTimersByTime(150);
        await settle();
        endMigration();
        // The deadline is checked again here, before the open resolves. If
        // migration time counted, the wait would end now without a database.
        await settle();
        opened.resolve(database);
        expect(await pending).toBe(database);
    } finally {
        endMigration();
        opened.resolve(database);
        __resetOffThreadMigrationClockForTests();
        jest.useRealTimers();
    }
});

scaleTest(
    "boot wait gives up on an unresolved open after its deadline",
    async (slow) => {
        const gate = createV2StorageGate({ open: () => new Promise<null>(() => {}) });
        const started = performance.now();
        const timeout = slow ? 15_000 : 30;
        expect(await probeV2StorageAtBoot(gate, slow ? undefined : timeout)).toBeUndefined();
        expect(performance.now() - started).toBeGreaterThanOrEqual(timeout);
        expect(gate.current()).toBeUndefined();
    },
    30_000,
);
