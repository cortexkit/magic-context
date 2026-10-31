/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getPendingOps,
    getTagById,
    insertTag,
    openDatabase,
    queuePendingOp,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { getSqliteDatabasePath, withSqliteTransformPass } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { applyPendingOperations } from "./apply-operations";
import { type MessageLike, type TagTarget, tagMessages } from "./tag-messages";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* ignore */
        }
    }
    tempDirs.length = 0;
});

function useTempDataHome(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

const SES = "session-apply-test";

describe("applyPendingOperations with protection window set form", () => {
    it("consumes protectedTagIds in tag-number coordinate space and protects member tags", () => {
        useTempDataHome("apply-set-");
        const db = openDatabase();
        expect(db).toBeTruthy();

        const messages: MessageLike[] = [
            {
                info: { id: "m-assistant", role: "assistant", sessionID: SES },
                parts: [
                    { type: "tool-invocation", callID: "call-1" },
                    { type: "tool-invocation", callID: "call-2" },
                ],
            },
            {
                info: { id: "m-tool", role: "tool", sessionID: SES },
                parts: [
                    { type: "tool", callID: "call-1", state: { output: "result 1" } },
                    { type: "tool", callID: "call-2", state: { output: "result 2" } },
                ],
            },
        ];

        const tagger = createTagger(db!, SES);
        const { targets, batch } = tagMessages(SES, messages, tagger, db!);
        const tag1 = tagger.getToolTag(SES, "call-1", "m-assistant")!;
        const tag2 = tagger.getToolTag(SES, "call-2", "m-assistant")!;
        expect(tag1).toBeDefined();
        expect(tag2).toBeDefined();

        // Queue drops for both tag 1 and tag 2
        queuePendingOp(db!, SES, tag1, "drop");
        queuePendingOp(db!, SES, tag2, "drop");

        // Union projection form: protectedTagIds (set form) in tag-number coordinate space
        // Tag 2 is protected in the window; tag 1 is outside
        const protectedTagIds: ReadonlySet<number> = new Set([tag2]);

        const mutated = applyPendingOperations(SES, db!, targets, protectedTagIds);
        batch.finalize();

        expect(mutated).toBe(true);
        // Tag 1 was dropped
        expect(getTagById(db!, SES, tag1)?.status).toBe("dropped");
        // Tag 2 was protected by the window (skipped)
        expect(getTagById(db!, SES, tag2)?.status).toBe("active");
    });

    it("reports why a selected synthetic batch cannot mutate the visible payload", () => {
        useTempDataHome("apply-noop-reason-");
        const db = openDatabase();
        expect(db).toBeTruthy();
        insertTag(db!, SES, "call-protected", "tool", 4_000, 1);

        let diagnostics:
            | { total: number; mutated: number; reasons: Record<string, number> }
            | undefined;
        const mutated = applyPendingOperations(
            SES,
            db!,
            new Map([
                [
                    1,
                    {
                        canDrop: () => true,
                        truncate: () => "truncated" as const,
                        drop: () => "removed" as const,
                        setContent: () => true,
                    },
                ],
            ]),
            new Set([1]),
            undefined,
            undefined,
            [{ id: 0, sessionId: SES, tagId: 1, operation: "drop", queuedAt: 0 }],
            new Set(),
            undefined,
            (batch) => {
                diagnostics = batch;
            },
        );

        expect(mutated).toBe(false);
        expect(diagnostics).toEqual({
            source: "synthetic",
            total: 1,
            mutated: 0,
            persistedWithoutMutation: 0,
            reasons: { protected: 1 },
        });
    });

    it("declares and enforces empty-window behavior: empty set protects zero tool tags, but non-tool tags are never automatic reclaim targets", () => {
        useTempDataHome("apply-empty-");
        const db = openDatabase();
        expect(db).toBeTruthy();

        // 1 tool tag and 1 message tag
        insertTag(db!, SES, "msg-1", "tool", 100, 1);
        insertTag(db!, SES, "msg-2", "message", 100, 2);

        // Empty window: protectedTagIds is empty set
        const protectedTagIds: ReadonlySet<number> = new Set();

        // Synthetic automatic reclaim ops: only tool tags can be targeted
        const syntheticOps = [
            { id: 0, sessionId: SES, tagId: 1, operation: "drop" as const, queuedAt: 0 },
            { id: 0, sessionId: SES, tagId: 2, operation: "drop" as const, queuedAt: 0 },
        ];

        const targets = new Map();
        targets.set(1, {
            canDrop: () => true,
            truncate: () => "truncated",
            drop: () => "removed",
            setContent: () => true,
        });
        targets.set(2, {
            canDrop: () => true,
            truncate: () => "truncated",
            drop: () => "removed",
            setContent: () => true,
        });

        applyPendingOperations(
            SES,
            db!,
            targets,
            protectedTagIds,
            undefined,
            undefined,
            syntheticOps,
        );

        // Tool tag 1 dropped under empty window
        expect(getTagById(db!, SES, 1)?.status).toBe("dropped");
        // Non-tool (message) tag 2 never targeted by synthetic automatic reclaim
        expect(getTagById(db!, SES, 2)?.status).toBe("active");
    });
});

describe("pending tool drop persistence", () => {
    it("rolls back the whole drop batch before any wire mutation on a write failure", () => {
        useTempDataHome("apply-write-failure-");
        const db = openDatabase()!;
        const applied: number[] = [];
        const targets = new Map();
        for (let n = 1; n <= 3; n++) {
            insertTag(db, SES, `call-${n}`, "tool", 4000, n);
            queuePendingOp(db, SES, n, "drop");
            targets.set(n, {
                canDrop: () => true,
                cannotRemove: () => true,
                skeletonReal: () => {
                    expect(getTagById(db, SES, n)?.status).toBe("dropped");
                    applied.push(n);
                    return "truncated" as const;
                },
                setContent: () => false,
            });
        }
        db.exec(`CREATE TEMP TRIGGER abort_second_drop BEFORE UPDATE OF status ON tags
            WHEN NEW.tag_number = 2 AND NEW.status = 'dropped'
            BEGIN SELECT RAISE(ABORT, 'abort second drop'); END`);
        expect(() => applyPendingOperations(SES, db, targets, new Set())).toThrow(
            "abort second drop",
        );
        expect(applied).toEqual([]);
        expect([1, 2, 3].map((n) => getTagById(db, SES, n)?.status)).toEqual([
            "active",
            "active",
            "active",
        ]);
        expect([1, 2, 3].map((n) => getTagById(db, SES, n)?.dropMode)).toEqual([
            "full",
            "full",
            "full",
        ]);
        expect(db.prepare("SELECT tag_id FROM pending_ops ORDER BY tag_id").all()).toEqual([
            { tag_id: 1 },
            { tag_id: 2 },
            { tag_id: 3 },
        ]);
    });
});

describe("pending drop writer admission", () => {
    it("waits for a short writer held during a flush pass before draining queued drops", async () => {
        useTempDataHome("apply-writer-lock-");
        const db = openDatabase()!;
        for (let tag = 1; tag <= 2; tag++) {
            insertTag(db, SES, `call-${tag}`, "tool", 4_000, tag);
            queuePendingOp(db, SES, tag, "drop");
        }
        const applied: number[] = [];
        const targets = new Map<number, TagTarget>([
            [
                1,
                {
                    canDrop: () => true,
                    inputStringBytes: () => 10_000,
                    drop: () => {
                        applied.push(1);
                        return "removed";
                    },
                },
            ],
            [
                2,
                {
                    canDrop: () => true,
                    inputStringBytes: () => 10_000,
                    drop: () => {
                        applied.push(2);
                        return "removed";
                    },
                },
            ],
        ]);
        const databasePath = getSqliteDatabasePath(db);
        expect(databasePath).toBeTruthy();
        let commits = 0;
        const exec = db.exec.bind(db);
        db.exec = ((sql: string) => {
            const result = exec(sql);
            if (sql === "COMMIT") commits++;
            return result;
        }) as typeof db.exec;

        // A child holds the independent SQLite writer lock because the main test
        // thread blocks synchronously while the flush pass waits to acquire it.
        // The busy timeout lets the child wait out any other brief writer on the
        // test database instead of failing before the code under test runs.
        const script = `
            import { Database } from "bun:sqlite";
            const db = new Database(process.env.FLUSH_LOCK_DB);
            db.exec("PRAGMA busy_timeout = 5000");
            db.exec("BEGIN IMMEDIATE");
            console.log("LOCKED");
            setTimeout(() => {
                const releasedAt = Date.now();
                try { db.exec("ROLLBACK"); }
                finally { db.close(); console.log("RELEASED " + releasedAt); }
            }, 400);
        `;
        const locker = Bun.spawn([process.execPath, "-e", script], {
            env: { FLUSH_LOCK_DB: databasePath!, PATH: process.env.PATH ?? "" },
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
        });
        const stdout = locker.stdout;
        if (!stdout) throw new Error("writer lock helper did not expose stdout");
        const reader = stdout.getReader();
        let output = "";
        try {
            while (!output.includes("LOCKED")) {
                const next = await reader.read();
                if (next.done) {
                    const [exitCode, stderr] = await Promise.all([
                        locker.exited,
                        new Response(locker.stderr).text(),
                    ]);
                    throw new Error(
                        `writer lock helper exited before locking (exit ${exitCode}): ${stderr.trim() || "<no stderr>"}`,
                    );
                }
                output += new TextDecoder().decode(next.value);
            }
            const started = performance.now();
            const startedAt = Date.now();
            const mutated = withSqliteTransformPass(() =>
                applyPendingOperations(SES, db, targets, new Set()),
            );
            const endedAt = Date.now();
            const waitMs = performance.now() - started;
            const exitCode = await locker.exited;
            expect(exitCode).toBe(0);
            while (!/RELEASED \d+/.test(output)) {
                const next = await reader.read();
                if (next.done) break;
                output += new TextDecoder().decode(next.value);
            }
            const releasedAt = Number(output.match(/RELEASED (\d+)/)?.[1]);
            // Compare against the helper's own release time, on the shared wall
            // clock, not a fixed duration: the moment this process reads LOCKED
            // lags the real lock by however long the pipe takes on a loaded
            // runner. The drain started while the writer held the lock, and it
            // could only finish after the writer let go, so it waited.
            expect(startedAt).toBeLessThan(releasedAt);
            expect(endedAt).toBeGreaterThanOrEqual(releasedAt);
            expect(mutated).toBe(true);
            expect(applied).toEqual([1, 2]);
            expect([1, 2].map((tag) => getTagById(db, SES, tag)?.status)).toEqual([
                "dropped",
                "dropped",
            ]);
            expect(getPendingOps(db, SES)).toHaveLength(0);
            console.log(
                `flush writer-lock evidence waitMs=${Math.round(waitMs)} heldAfterStartMs=${releasedAt - startedAt} applied=${applied.length} commits=${commits}`,
            );
        } finally {
            reader.releaseLock();
            if (locker.exitCode === null) await locker.exited;
        }
    });
});
