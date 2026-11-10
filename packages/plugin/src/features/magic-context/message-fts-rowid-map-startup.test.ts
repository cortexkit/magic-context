import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, isTransientSqliteError, withSqliteTransformPass } from "../../shared/sqlite";
import { openTestDatabase } from "../../shared/test-db";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { startMessageFtsRowidMapBackfill } from "./message-fts-rowid-map";
import { startMessageTimeBackfill } from "./message-time-backfill";
import { runMigrations } from "./migrations";
import { closeDatabase, initializeDatabase, openDatabase, resolveDatabasePath } from "./storage-db";

test("opted-in managed startup fills legacy FTS rowid mappings", async () => {
    const home = createTestTempDirFromPath(join(tmpdir(), "mc-fts-startup-open-"));
    const previousHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = home;
    try {
        const seed = openDatabase(resolveDatabasePath().dbPath)!;
        seed.prepare(
            "INSERT INTO message_history_fts(session_id,message_ordinal,message_id,role,content) VALUES('legacy',1,'m1','user','legacy text')",
        ).run();
        expect(seed.prepare("SELECT COUNT(*) AS n FROM message_fts_rowid_map").get()).toEqual({
            n: 0,
        });
        await closeDatabase();

        const db = await openTestDatabase();
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS n FROM message_fts_rowid_map WHERE session_id='legacy'",
                )
                .get(),
        ).toEqual({ n: 1 });
        expect(
            db.prepare("SELECT completed FROM message_fts_rowid_map_backfill_state").get(),
        ).toEqual({ completed: 1 });
    } finally {
        await closeDatabase();
        if (previousHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousHome;
        rmSync(home, { recursive: true, force: true });
    }
}, 15000);

test("startup FTS map backfill must not synchronously wait for the production five-second timeout", async () => {
    const root = join(tmpdir(), "magic-context", "issue-601-review-r2");
    mkdirSync(root, { recursive: true });
    const dir = createTestTempDirFromPath(join(root, "backfill-"));
    const path = join(dir, "context.db");
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
    const blocker = new Database(path);
    blocker.exec("BEGIN IMMEDIATE");
    try {
        const started = performance.now();
        await startMessageFtsRowidMapBackfill(db).then(
            () => {
                throw new Error("expected writer contention");
            },
            (error) => expect(isTransientSqliteError(error)).toBe(true),
        );
        expect(performance.now() - started).toBeLessThan(650);
    } finally {
        blocker.exec("ROLLBACK");
        blocker.close();
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
}, 15000);

test("startup map and time jobs defer busy setup and resume outside their caller's foreground lane", async () => {
    const root = join(tmpdir(), "magic-context", "issue-601-review-r2");
    mkdirSync(root, { recursive: true });
    const dir = createTestTempDirFromPath(join(root, "startup-chain-"));
    const path = join(dir, "context.db");
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
    db.prepare(
        "INSERT INTO message_history_fts(session_id,message_ordinal,message_id,role,content) VALUES('legacy',1,'m1','user','private text')",
    ).run();
    // Missing seed rows force each job to exercise setup writes, not just BEGIN.
    db.exec(
        "DELETE FROM message_fts_rowid_map_backfill_state; DELETE FROM message_time_backfill_state",
    );
    const blocker = new Database(path);
    const reader = () => [];
    try {
        for (const start of [
            () => startMessageFtsRowidMapBackfill(db),
            () => startMessageTimeBackfill(db, reader),
        ]) {
            blocker.exec("BEGIN IMMEDIATE");
            try {
                await withSqliteTransformPass(async () => {
                    const began = performance.now();
                    const job = start();
                    // Starting a job must return before its first synchronous setup.
                    expect(performance.now() - began).toBeLessThan(100);
                    await expect(job).rejects.toThrow();
                    expect(performance.now() - began).toBeLessThan(200);
                });
            } finally {
                blocker.exec("ROLLBACK");
            }
        }
        await startMessageFtsRowidMapBackfill(db);
        await startMessageTimeBackfill(db, reader);
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS n FROM message_fts_rowid_map WHERE session_id='legacy'",
                )
                .get(),
        ).toEqual({ n: 1 });
        expect(
            db.prepare("SELECT completed FROM message_fts_rowid_map_backfill_state").get(),
        ).toEqual({ completed: 1 });
        expect(db.prepare("SELECT completed FROM message_time_backfill_state").get()).toEqual({
            completed: 1,
        });
        expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally {
        blocker.close();
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
}, 15000);
