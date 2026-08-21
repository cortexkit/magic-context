/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _resetHarnessForTesting } from "../../shared/harness";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    __resetProjectIdentityForTests,
    __setProjectIdentityTestHooks,
} from "./memory/project-identity";
import { runMigrations } from "./migrations";
import {
    _getSessionProjectBackfillState,
    runSessionProjectBackfill,
} from "./session-project-backfill";
import { initializeDatabase } from "./storage-db";

const tempDirs: string[] = [];
const openDatabases: Database[] = [];
const DEFAULT_RESOLVER_ROOT_COMMIT = "abcdef1234567890abcdef1234567890abcdef12";

afterEach(() => {
    _resetHarnessForTesting();
    __resetProjectIdentityForTests();
    for (const db of openDatabases) {
        closeQuietly(db);
    }
    openDatabases.length = 0;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function createDb(): Database {
    const dbPath = join(makeTempDir("session-project-backfill-db-"), "context.db");
    const db = new Database(dbPath);
    openDatabases.push(db);
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function getStoredProjectPath(db: Database, sessionId: string): string | null {
    const row = db
        .prepare(
            "SELECT project_path FROM session_projects WHERE session_id = ? AND harness = 'opencode'",
        )
        .get(sessionId) as { project_path: string } | null | undefined;
    return row?.project_path ?? null;
}

function makeGitMetadataDirectory(prefix: string): string {
    const dir = makeTempDir(prefix);
    mkdirSync(join(dir, ".git"));
    return dir;
}

function returningRootCommit(rootCommit: string): typeof execFileSync {
    // Keep the real `.git` walk on disk, but route git output through the test
    // seam. Under heavy machine load, launching git can stall while the
    // operating system assesses the binary, which makes direct calls flaky.
    return (() => `${rootCommit}\n`) as typeof execFileSync;
}

describe("runSessionProjectBackfill", () => {
    it("backfills unmapped sessions and leaves mapped ones untouched", async () => {
        const db = createDb();
        const directory = makeTempDir("session-project-backfill-live-");
        const resolverCalls: string[] = [];

        db.prepare(
            `INSERT INTO session_projects (session_id, harness, project_path, updated_at)
             VALUES (?, 'opencode', ?, ?)`,
        ).run("ses-mapped", "git:keep", 1);

        const result = await runSessionProjectBackfill(
            db,
            [
                { sessionId: "ses-mapped", directory },
                { sessionId: "ses-unmapped-1", directory },
                { sessionId: "ses-unmapped-2", directory },
            ],
            {
                resolveIdentity: (inputDirectory) => {
                    resolverCalls.push(inputDirectory);
                    return "git:shared";
                },
                now: () => 1000,
            },
        );

        expect(result.status).toBe("completed");
        expect(result.alreadyMappedSessions).toBe(1);
        expect(result.unmappedSessions).toBe(2);
        expect(result.backfilledSessions).toBe(2);
        expect(result.skippedDeadDirectories).toBe(0);
        expect(result.skippedEmptyDirectories).toBe(0);
        expect(resolverCalls).toEqual([directory]);
        expect(getStoredProjectPath(db, "ses-mapped")).toBe("git:keep");
        expect(getStoredProjectPath(db, "ses-unmapped-1")).toBe("git:shared");
        expect(getStoredProjectPath(db, "ses-unmapped-2")).toBe("git:shared");
    });

    it("skips dead-directory sessions and leaves them unmapped", async () => {
        const db = createDb();
        const liveDirectory = makeTempDir("session-project-backfill-live-");
        const deletedRoot = makeTempDir("session-project-backfill-dead-");
        rmSync(deletedRoot, { recursive: true, force: true });
        const deadDirectory = join(deletedRoot, "repo");
        let resolverCalls = 0;

        const result = await runSessionProjectBackfill(
            db,
            [
                { sessionId: "ses-dead", directory: deadDirectory },
                { sessionId: "ses-live", directory: liveDirectory },
            ],
            {
                resolveIdentity: () => {
                    resolverCalls += 1;
                    return "git:live";
                },
                now: () => 2000,
            },
        );

        expect(result.status).toBe("retry_pending");
        expect(result.unmappedSessions).toBe(2);
        expect(result.backfilledSessions).toBe(1);
        expect(result.skippedDeadDirectories).toBe(1);
        expect(result.skippedEmptyDirectories).toBe(0);
        expect(resolverCalls).toBe(1);
        expect(getStoredProjectPath(db, "ses-dead")).toBeNull();
        expect(getStoredProjectPath(db, "ses-live")).toBe("git:live");
    });

    it("is a no-op after the harness backfill is marked completed", async () => {
        const db = createDb();
        const directory = makeTempDir("session-project-backfill-live-");
        let resolverCalls = 0;
        let sourceCalls = 0;
        const first = await runSessionProjectBackfill(db, [{ sessionId: "ses-first", directory }], {
            resolveIdentity: () => {
                resolverCalls += 1;
                return "git:first";
            },
            now: () => 3000,
        });
        const second = await runSessionProjectBackfill(
            db,
            async () => {
                sourceCalls += 1;
                return [{ sessionId: "ses-second", directory }];
            },
            {
                resolveIdentity: () => {
                    resolverCalls += 1;
                    return "git:second";
                },
                now: () => 4000,
            },
        );

        expect(first.status).toBe("completed");
        expect(first.backfilledSessions).toBe(1);
        expect(second.status).toBe("already_completed");
        expect(second.backfilledSessions).toBe(0);
        expect(resolverCalls).toBe(1);
        expect(sourceCalls).toBe(0);
        expect(getStoredProjectPath(db, "ses-first")).toBe("git:first");
        expect(getStoredProjectPath(db, "ses-second")).toBeNull();
        expect(_getSessionProjectBackfillState(db)?.status).toBe("completed");
    });

    it("blocks on an active lease and reclaims an expired lease", async () => {
        const db = createDb();
        const directory = makeTempDir("session-project-backfill-live-");

        await runSessionProjectBackfill(db, [], { now: () => 5000 });
        db.exec("DELETE FROM session_project_backfill_state");
        db.prepare(
            `INSERT INTO session_project_backfill_state(
                harness,
                status,
                started_at,
                lease_expires_at,
                completed_at
            )
             VALUES ('opencode', 'running', ?, ?, NULL)`,
        ).run(5100, 5100 + 60_000);

        const blocked = await runSessionProjectBackfill(
            db,
            [{ sessionId: "ses-lease", directory }],
            {
                resolveIdentity: () => "git:lease",
                now: () => 5200,
            },
        );

        expect(blocked.status).toBe("blocked_by_lease");
        expect(blocked.backfilledSessions).toBe(0);
        expect(getStoredProjectPath(db, "ses-lease")).toBeNull();

        db.prepare(
            "UPDATE session_project_backfill_state SET lease_expires_at = ? WHERE harness = 'opencode'",
        ).run(5199);

        const reclaimed = await runSessionProjectBackfill(
            db,
            [{ sessionId: "ses-lease", directory }],
            {
                resolveIdentity: () => "git:lease",
                now: () => 5200,
            },
        );

        expect(reclaimed.status).toBe("completed");
        expect(reclaimed.backfilledSessions).toBe(1);
        expect(getStoredProjectPath(db, "ses-lease")).toBe("git:lease");
        expect(_getSessionProjectBackfillState(db)?.status).toBe("completed");
    });

    it("skips empty directories", async () => {
        const db = createDb();

        const result = await runSessionProjectBackfill(
            db,
            [{ sessionId: "ses-empty", directory: "" }],
            {
                resolveIdentity: () => {
                    throw new Error("resolveIdentity should not be called for empty directories");
                },
                now: () => 6000,
            },
        );

        expect(result.status).toBe("retry_pending");
        expect(result.unmappedSessions).toBe(1);
        expect(result.backfilledSessions).toBe(0);
        expect(result.skippedEmptyDirectories).toBe(1);
        expect(result.skippedDeadDirectories).toBe(0);
        expect(getStoredProjectPath(db, "ses-empty")).toBeNull();
    });

    it("yields and renews the lease during long runs", async () => {
        const db = createDb();
        let currentNow = 7000;
        const leaseExpirations: number[] = [];
        const sessions = Array.from({ length: 11 }, (_, index) => ({
            sessionId: `ses-yield-${index}`,
            directory: makeTempDir(`session-project-backfill-yield-${index}-`),
        }));

        const result = await runSessionProjectBackfill(db, sessions, {
            resolveIdentity: (directory) => `git:${directory.split("-").at(-2) ?? "x"}`,
            now: () => {
                const value = currentNow;
                currentNow += 1000;
                return value;
            },
            yieldFn: async () => {
                leaseExpirations.push(_getSessionProjectBackfillState(db)?.lease_expires_at ?? 0);
            },
        });

        expect(result.status).toBe("completed");
        expect(result.backfilledSessions).toBe(11);
        expect(leaseExpirations.length).toBeGreaterThan(1);
        expect(leaseExpirations.every((expiration) => expiration > 7000)).toBe(true);
        expect(_getSessionProjectBackfillState(db)?.status).toBe("completed");
    });

    it("pages discovery and yields while processing many sessions in one directory", async () => {
        const db = createDb();
        const directory = makeTempDir("session-project-backfill-shared-");
        const sessions = Array.from({ length: 205 }, (_, index) => ({
            sessionId: `ses-page-${String(index).padStart(3, "0")}`,
            directory,
        }));
        const pageCalls: Array<{ after: string | null; limit: number }> = [];
        let yields = 0;

        const result = await runSessionProjectBackfill(
            db,
            async (afterSessionId, limit) => {
                pageCalls.push({ after: afterSessionId, limit });
                const start =
                    afterSessionId === null
                        ? 0
                        : sessions.findIndex((session) => session.sessionId === afterSessionId) + 1;
                return sessions.slice(start, start + limit);
            },
            {
                resolveIdentity: () => "git:shared-page",
                yieldFn: () =>
                    new Promise((resolve) =>
                        setTimeout(() => {
                            yields += 1;
                            resolve();
                        }, 0),
                    ),
            },
        );

        expect(result.status).toBe("completed");
        expect(result.totalSessions).toBe(205);
        expect(result.backfilledSessions).toBe(205);
        expect(pageCalls.map((call) => call.limit)).toEqual([100, 100, 100]);
        expect(yields).toBeGreaterThanOrEqual(8);
    });

    it("cannot complete a lease after another holder takes ownership", async () => {
        const db = createDb();
        const directory = makeTempDir("session-project-backfill-fence-");
        const sessions = Array.from({ length: 30 }, (_, index) => ({
            sessionId: `ses-fence-${index}`,
            directory,
        }));
        let replacedHolder = false;

        const result = await runSessionProjectBackfill(db, sessions, {
            holderId: "holder-old",
            resolveIdentity: () => "git:fenced",
            yieldFn: async () => {
                if (replacedHolder) return;
                replacedHolder = true;
                db.prepare(
                    `UPDATE session_project_backfill_state
                     SET holder_id = 'holder-new', lease_expires_at = 999999999
                     WHERE harness = 'opencode'`,
                ).run();
            },
        });

        expect(result.status).toBe("lost_lease");
        expect(_getSessionProjectBackfillState(db)).toMatchObject({
            status: "running",
            holder_id: "holder-new",
        });
    });

    it("uses the default resolver seam for a git-shaped directory", async () => {
        const db = createDb();
        const directory = makeGitMetadataDirectory("session-project-backfill-git-");
        __setProjectIdentityTestHooks({
            execFileSync: returningRootCommit(DEFAULT_RESOLVER_ROOT_COMMIT),
        });

        const result = await runSessionProjectBackfill(db, [{ sessionId: "ses-git", directory }]);

        expect(result.status).toBe("completed");
        expect(result.backfilledSessions).toBe(1);
        expect(getStoredProjectPath(db, "ses-git")).toBe(`git:${DEFAULT_RESOLVER_ROOT_COMMIT}`);
    });
});
