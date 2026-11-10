import { afterEach, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as messageTime from "../features/magic-context/message-time-backfill";
import { closeDatabase, getDatabasePath } from "../features/magic-context/storage-db";
import * as warmup from "../hooks/magic-context/raw-ordinal-warmup";
import { setHarness } from "./harness";
import { openTestDatabase, openTestDb } from "./test-db";
import { createTestTempDirFromPath } from "./test-temp-dir";

const originalHome = process.env.XDG_DATA_HOME;
afterEach(async () => {
    await closeDatabase();
    if (originalHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalHome;
    setHarness("opencode");
});

test("transform fixture opener joins both startup writers before returning the serving handle", async () => {
    process.env.XDG_DATA_HOME = createTestTempDirFromPath(join(tmpdir(), "mc-startup-barrier-"));
    setHarness("opencode");
    const ftsStarted = Promise.withResolvers<void>();
    const releaseFts = Promise.withResolvers<void>();
    const timeStarted = Promise.withResolvers<void>();
    const releaseTime = Promise.withResolvers<void>();
    let blocker: ReturnType<typeof openTestDb> | undefined;
    const fts = spyOn(warmup, "runSessionWarmupWorker").mockImplementation(async (input) => {
        if (!input.ftsRowidBackfill) throw new Error("Unexpected startup job");
        blocker = openTestDb(input.path);
        blocker.exec("BEGIN IMMEDIATE");
        ftsStarted.resolve();
        await releaseFts.promise;
        blocker.exec("ROLLBACK");
        blocker.close();
        blocker = undefined;
        return { ftsRowidBackfill: true };
    });
    const time = spyOn(messageTime, "startMessageTimeBackfill").mockImplementation(async () => {
        timeStarted.resolve();
        await releaseTime.promise;
    });
    let returned = false;
    const opening = openTestDatabase().then((db) => {
        returned = true;
        return db;
    });
    try {
        await ftsStarted.promise;
        expect(returned).toBe(false);
        const dbPath = blocker!.prepare("PRAGMA database_list").all() as Array<{ file: string }>;
        const serving = openTestDb(dbPath[0]!.file);
        try {
            serving.exec("PRAGMA busy_timeout=0");
            expect(() => serving.exec("BEGIN IMMEDIATE")).toThrow("database is locked");
        } finally {
            serving.close();
        }
        releaseFts.resolve();
        await timeStarted.promise;
        expect(returned).toBe(false);
        releaseTime.resolve();
        const db = await opening;
        expect(getDatabasePath(db)).toBe(dbPath[0]!.file);
        db.exec("BEGIN IMMEDIATE; ROLLBACK");
    } finally {
        releaseFts.resolve();
        releaseTime.resolve();
        await opening;
        fts.mockRestore();
        time.mockRestore();
    }
});
