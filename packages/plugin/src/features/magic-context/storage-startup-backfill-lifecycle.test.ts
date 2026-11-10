import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as warmup from "../../hooks/magic-context/raw-ordinal-warmup";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import * as messageTime from "./message-time-backfill";
import {
    __getDatabaseStartupStateForTests,
    __setScheduleStartupMaintenanceOnOpenForTests,
    closeDatabase,
    openDatabase,
    openDatabaseAsync,
} from "./storage-db";

const originalDataHome = process.env.XDG_DATA_HOME;
const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
let dir: string | undefined;
let restoreWorker: (() => void) | undefined;
let restoreTime: (() => void) | undefined;
let previousStartupPolicy: boolean;

beforeEach(() => {
    previousStartupPolicy = __setScheduleStartupMaintenanceOnOpenForTests(true);
});

function useStore(): void {
    dir = createTestTempDirFromPath(join(tmpdir(), "storage-startup-lifecycle-"));
    process.env.XDG_DATA_HOME = dir;
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dir;
}

afterEach(async () => {
    await closeDatabase();
    __setScheduleStartupMaintenanceOnOpenForTests(previousStartupPolicy);
    restoreWorker?.();
    restoreTime?.();
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    if (originalTestDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;
    if (dir) rmSync(dir, { recursive: true, force: true });
});

test("closing before the startup turn cancels the queued FTS writer", async () => {
    useStore();
    const worker = spyOn(warmup, "runSessionWarmupWorker").mockResolvedValue({
        ftsRowidBackfill: true,
    });
    restoreWorker = () => worker.mockRestore();
    const db = openDatabase();
    expect(db).not.toBeNull();
    expect(__getDatabaseStartupStateForTests(db!).timerScheduled).toBe(true);
    await closeDatabase();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(worker).not.toHaveBeenCalled();
});

test.each([
    "sync",
    "async",
] as const)("%s reopen does not wait for a closed generation's startup worker", async (mode) => {
    useStore();
    let started!: () => void;
    const workerStarted = new Promise<void>((resolve) => {
        started = resolve;
    });
    let release!: () => void;
    let aborted = false;
    const worker = spyOn(warmup, "runSessionWarmupWorker").mockImplementation(
        (_input, { signal }) =>
            new Promise((resolve) => {
                // Model a native connection that outlives the abort request.
                release = () => resolve({ failure: "stopped", detail: "stopped" });
                signal?.addEventListener("abort", () => {
                    aborted = true;
                });
                started();
            }),
    );
    const time = spyOn(messageTime, "startMessageTimeBackfill").mockResolvedValue();
    restoreWorker = () => worker.mockRestore();
    restoreTime = () => time.mockRestore();
    const original = openDatabase();
    expect(original).not.toBeNull();
    await workerStarted;
    let closed = false;
    const closing = closeDatabase().then(() => {
        closed = true;
    });
    try {
        expect(aborted).toBe(true);
        expect(closed).toBe(false);
        const reopened =
            mode === "sync"
                ? openDatabase()
                : await Promise.race([
                      openDatabaseAsync(),
                      new Promise<null>((resolve) => setTimeout(() => resolve(null), 0)),
                  ]);
        expect(reopened).not.toBeNull();
        expect(reopened).not.toBe(original);
        expect(reopened?.query("SELECT 1 AS ready").get()).toEqual({ ready: 1 });
        expect(closed).toBe(false);
    } finally {
        release();
    }
    await closing;
    expect(closed).toBe(true);
    expect(time).not.toHaveBeenCalled();
});
