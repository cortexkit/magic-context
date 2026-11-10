/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { insertMemory } from "../memory/storage-memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { acquireLease, releaseLease } from "./lease";
import { setDreamState } from "./storage-dream-state";
import {
    deleteTaskScheduleRowsForProject,
    getTaskScheduleState,
    writeTaskScheduleState,
} from "./storage-task-schedule";
import { leaseKeyFor } from "./task-registry";
import {
    type DreamTaskRuntimeConfig,
    planDueTasks,
    runDueTasksForProject,
    runManualDream,
    type TaskExecOutcome,
} from "./task-scheduler";

let db: Database | null = null;
afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function freshDb(): Database {
    const d = new Database(":memory:");
    initializeDatabase(d);
    runMigrations(d);
    return d;
}

const PROJECT = "git:abc";

function cfg(
    task: DreamTaskRuntimeConfig["task"],
    schedule: string,
    extra: Partial<DreamTaskRuntimeConfig> = {},
): DreamTaskRuntimeConfig {
    return { task, schedule, timeoutMinutes: 20, ...extra };
}

/** Give a project active memories so memory-domain gates pass. */
let memorySeq = 0;
function seedActiveMemory(d: Database, project = PROJECT): void {
    memorySeq += 1;
    insertMemory(d, {
        projectPath: project,
        category: "PROJECT_RULES",
        content: `mem-${memorySeq}`,
    });
}

describe("task-scheduler — manual lease wait", () => {
    it("manual run waits for a briefly-held domain lease instead of reporting busy", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const leaseKey = leaseKeyFor("curate", PROJECT);
        const otherHolder = "other-process";
        expect(acquireLease(db, otherHolder, leaseKey)).toBe(true);
        // Free the lease shortly after the manual run starts waiting.
        setTimeout(() => releaseLease(db as Database, otherHolder, leaseKey), 150);

        let executed = 0;
        const executor = async (): Promise<TaskExecOutcome> => {
            executed += 1;
            return { status: "completed" };
        };
        const result = await runManualDream({
            db,
            projectIdentity: PROJECT,
            tasks: [cfg("curate", "0 4 * * 0")],
            executor,
            task: "curate",
        });
        expect(executed).toBe(1);
        expect(result.ran).toEqual(["curate"]);
        expect(result.deferredBusy).toEqual([]);
    });

    it("scheduled ticks do not wait on a busy lease", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const leaseKey = leaseKeyFor("curate", PROJECT);
        expect(acquireLease(db, "other-process", leaseKey)).toBe(true);

        const now = Date.now();
        writeTaskScheduleState(db, {
            projectPath: PROJECT,
            task: "curate",
            lastRunAt: null,
            nextDueAt: now - 1000,
            schedule: "0 4 * * 0",
            lastStatus: null,
            lastError: null,
            retryCount: 0,
        });
        let executed = 0;
        const executor = async (): Promise<TaskExecOutcome> => {
            executed += 1;
            return { status: "completed" };
        };
        const started = Date.now();
        await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks: [cfg("curate", "0 4 * * 0")],
            executor,
            now,
        });
        expect(executed).toBe(0);
        // No lease-wait loop on the scheduled path: returns immediately.
        expect(Date.now() - started).toBeLessThan(1500);
    });
});

describe("task-scheduler — a slot another dreamer already ran", () => {
    it("a scheduled pass skips a planned slot that was run before it took the lease", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const slot = now - 1000;
        const row = {
            projectPath: PROJECT,
            task: "curate" as const,
            lastRunAt: null,
            nextDueAt: slot,
            schedule: "0 4 * * 0",
            lastStatus: null,
            lastError: null,
            retryCount: 0,
        };
        writeTaskScheduleState(db, row);
        // Between planning and this pass's lease acquisition, another dreamer
        // sharing the store (ck-mc's Rust dreamer, which this host does not ask)
        // runs the slot and moves next_due_at on. The first BEGIN IMMEDIATE the
        // domain-group runner issues opens its lease acquisition.
        const shared = db;
        const exec = shared.exec.bind(shared);
        let ranElsewhere = false;
        shared.exec = ((sql: string) => {
            if (
                !ranElsewhere &&
                sql === "BEGIN IMMEDIATE" &&
                new Error().stack?.includes("runDomainGroup")
            ) {
                ranElsewhere = true;
                writeTaskScheduleState(shared, {
                    ...row,
                    lastRunAt: now,
                    nextDueAt: now + 3_600_000,
                    lastStatus: "completed",
                });
            }
            return exec(sql);
        }) as typeof shared.exec;
        let executed = 0;
        await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks: [cfg("curate", "0 4 * * 0")],
            executor: async () => {
                executed += 1;
                return { status: "completed" };
            },
            now,
        });
        expect(ranElsewhere).toBe(true);
        expect(executed).toBe(0);
        // The row is left exactly as the other dreamer wrote it.
        const state = getTaskScheduleState(db, PROJECT, "curate");
        expect(state?.nextDueAt).toBe(now + 3_600_000);
        expect(state?.lastRunAt).toBe(now);
        expect(state?.lastStatus).toBe("completed");
    });
});

describe("task-scheduler — planDueTasks", () => {
    it("first-seed does NOT fire immediately (next_due in the future)", () => {
        db = freshDb();
        // An active memory gives verify its input; without one it gets no row.
        seedActiveMemory(db);
        const now = Date.UTC(2026, 0, 1, 12, 0); // midday
        const due = planDueTasks(db, PROJECT, [cfg("verify", "0 3 * * *")], now);
        expect(due).toHaveLength(0);
        // A row was seeded with a future next_due.
        const state = getTaskScheduleState(db, PROJECT, "verify");
        expect(state?.nextDueAt).not.toBeNull();
        expect(state?.nextDueAt).toBeGreaterThan(now);
    });

    it("seeds last_run_at from legacy last_dream_at (no full historical pass)", () => {
        db = freshDb();
        seedActiveMemory(db);
        setDreamState(db, `last_dream_at:${PROJECT}`, "555000");
        planDueTasks(db, PROJECT, [cfg("verify", "0 3 * * *")], Date.now());
        expect(getTaskScheduleState(db, PROJECT, "verify")?.lastRunAt).toBe(555000);
    });

    it("prunes retired task rows not in the canonical config set", () => {
        db = freshDb();
        // An active memory gives verify and curate their input, and keeps the
        // project from being pruned as idle while retired rows are checked.
        seedActiveMemory(db);
        // Simulate stale rows from old scheduler configurations so pruning can
        // remove task names that are no longer canonical.
        for (const task of ["improve", "consolidate", "archive-stale", "render-mural"] as const) {
            writeTaskScheduleState(db, {
                projectPath: PROJECT,
                task,
                lastRunAt: null,
                nextDueAt: Date.now() - 1000,
                schedule: "0 3 * * *",
                lastStatus: "skipped",
                lastError: null,
                retryCount: 0,
                lastCheckedCommit: null,
                retrospectiveWatermarkMs: null,
            });
        }
        // A plan pass with the canonical config set must delete them.
        planDueTasks(
            db,
            PROJECT,
            [cfg("verify", "0 3 * * *"), cfg("curate", "0 4 * * 0")],
            Date.now(),
        );
        for (const task of ["improve", "consolidate", "archive-stale", "render-mural"] as const) {
            expect(getTaskScheduleState(db, PROJECT, task)).toBeNull();
        }
        // Canonical tasks survive.
        expect(getTaskScheduleState(db, PROJECT, "verify")).not.toBeNull();
        expect(getTaskScheduleState(db, PROJECT, "curate")).not.toBeNull();
    });

    it("prunes against the canonical set, not the caller's filtered list", () => {
        db = freshDb();
        seedActiveMemory(db);
        const nextDueAt = Date.now() + 60_000;
        // A canonical task omitted by a host capability filter must retain its
        // durable schedule coordinates and incremental watermarks.
        writeTaskScheduleState(db, {
            projectPath: PROJECT,
            task: "map-memories",
            lastRunAt: 1234,
            nextDueAt,
            schedule: "0 3 * * *",
            lastStatus: "completed",
            lastError: null,
            retryCount: 0,
            lastCheckedCommit: "abc",
            retrospectiveWatermarkMs: 99,
        });
        planDueTasks(
            db,
            PROJECT,
            [cfg("verify", "0 3 * * *"), cfg("curate", "0 4 * * 0")],
            Date.now(),
        );
        const preserved = getTaskScheduleState(db, PROJECT, "map-memories");
        expect(preserved?.lastRunAt).toBe(1234);
        expect(preserved?.nextDueAt).toBe(nextDueAt);
        expect(preserved?.retrospectiveWatermarkMs).toBe(99);
    });

    it("deleteTaskScheduleRowsForProject removes ALL rows for an orphaned project only", () => {
        db = freshDb();
        const orphan = "dir:deadworktree";
        seedActiveMemory(db, orphan);
        seedActiveMemory(db);
        planDueTasks(
            db,
            orphan,
            [cfg("verify", "0 3 * * *"), cfg("curate", "0 4 * * 0")],
            Date.now(),
        );
        planDueTasks(db, PROJECT, [cfg("verify", "0 3 * * *")], Date.now());
        expect(getTaskScheduleState(db, orphan, "verify")).not.toBeNull();

        const removed = deleteTaskScheduleRowsForProject(db, orphan);
        expect(removed).toBe(2);
        expect(getTaskScheduleState(db, orphan, "verify")).toBeNull();
        expect(getTaskScheduleState(db, orphan, "curate")).toBeNull();
        // The unrelated project is untouched.
        expect(getTaskScheduleState(db, PROJECT, "verify")).not.toBeNull();
    });

    it("disabled schedule does not register a shared row", () => {
        db = freshDb();
        const due = planDueTasks(db, PROJECT, [cfg("maintain-docs", "")], Date.now());
        expect(due).toHaveLength(0);
        expect(getTaskScheduleState(db, PROJECT, "maintain-docs")).toBeNull();
    });

    it("a past next_due_at is collected as due", () => {
        db = freshDb();
        // Seed then force the row's next_due into the past.
        const now = Date.now();
        planDueTasks(db, PROJECT, [cfg("verify", "0 3 * * *")], now);
        writeTaskScheduleState(db, {
            projectPath: PROJECT,
            task: "verify",
            lastRunAt: null,
            nextDueAt: now - 1000,
            schedule: "0 3 * * *",
            lastStatus: null,
            lastError: null,
            retryCount: 0,
        });
        const due = planDueTasks(db, PROJECT, [cfg("verify", "0 3 * * *")], now);
        expect(due.map((d) => d.config.task)).toEqual(["verify"]);
    });

    // ── Config-authoritative reconciliation (Oracle P0 #1) ──────────────
    it("disabling a task leaves its shared slot untouched and never runs it", () => {
        db = freshDb();
        const now = Date.now();
        // Seed enabled, force it due.
        planDueTasks(db, PROJECT, [cfg("verify", "0 3 * * *")], now);
        forceDue(db, "verify", now);
        // Now the config disables it. The stale past-due slot must NOT fire.
        const before = getTaskScheduleState(db, PROJECT, "verify");
        const due = planDueTasks(db, PROJECT, [cfg("verify", "")], now);
        expect(due).toHaveLength(0);
        expect(getTaskScheduleState(db, PROJECT, "verify")).toEqual(before);
        expect(planDueTasks(db, PROJECT, [cfg("verify", "0 3 * * *")], now)).toHaveLength(1);
    });

    it("enabling a previously disabled task seeds a future slot", () => {
        db = freshDb();
        // An active memory gives verify its input, so only the schedule decides
        // whether its row is seeded.
        seedActiveMemory(db);
        const now = Date.UTC(2026, 0, 1, 12, 0);
        // Disabled registration leaves no shared row.
        planDueTasks(db, PROJECT, [cfg("verify", "")], now);
        expect(getTaskScheduleState(db, PROJECT, "verify")).toBeNull();
        // Now enable it: a fresh next_due is computed (future, not immediate).
        planDueTasks(db, PROJECT, [cfg("verify", "0 3 * * *")], now);
        const state = getTaskScheduleState(db, PROJECT, "verify");
        expect(state?.nextDueAt).not.toBeNull();
        expect(state?.nextDueAt).toBeGreaterThan(now);
        expect(state?.schedule).toBe("0 3 * * *");
    });

    it("changing the cron recomputes next_due_at from the new schedule", () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.UTC(2026, 0, 1, 12, 0);
        planDueTasks(db, PROJECT, [cfg("verify", "0 3 * * *")], now);
        const before = getTaskScheduleState(db, PROJECT, "verify")?.nextDueAt;
        // Switch to hourly: next_due must move earlier (next top-of-hour).
        planDueTasks(db, PROJECT, [cfg("verify", "0 * * * *")], now);
        const after = getTaskScheduleState(db, PROJECT, "verify");
        expect(after?.schedule).toBe("0 * * * *");
        expect(after?.nextDueAt).not.toBe(before);
        expect(after?.nextDueAt).toBeLessThan(before ?? Number.POSITIVE_INFINITY);
    });

    it("schedule edits keep an armed earlier slot without replaying old successful runs", () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.UTC(2026, 0, 1, 12, 0);
        planDueTasks(db, PROJECT, [cfg("verify", "0 * * * *")], now);
        const before = getTaskScheduleState(db, PROJECT, "verify");
        if (!before) throw new Error("missing schedule row");
        writeTaskScheduleState(db, { ...before, lastRunAt: now - 24 * 60 * 60_000 });
        expect(planDueTasks(db, PROJECT, [cfg("verify", "0 3 * * *")], now)).toHaveLength(0);
        expect(getTaskScheduleState(db, PROJECT, "verify")?.nextDueAt).toBe(before.nextDueAt);
    });

    it("legacy row (schedule IS NULL) with a live next_due is backfilled, not recomputed", () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const due = now - 1000;
        // Simulate a pre-column row: live next_due in the past, schedule NULL.
        writeTaskScheduleState(db, {
            projectPath: PROJECT,
            task: "verify",
            lastRunAt: null,
            nextDueAt: due,
            schedule: null,
            lastStatus: null,
            lastError: null,
            retryCount: 0,
        });
        const collected = planDueTasks(db, PROJECT, [cfg("verify", "0 3 * * *")], now);
        // The past-due slot is preserved (NOT recomputed into the future) and fires.
        expect(collected.map((d) => d.config.task)).toEqual(["verify"]);
        const state = getTaskScheduleState(db, PROJECT, "verify");
        expect(state?.schedule).toBe("0 3 * * *");
        expect(state?.nextDueAt).toBe(due);
    });
});

/** Force a task due by overwriting its seeded next_due into the past. */
function forceDue(d: Database, task: DreamTaskRuntimeConfig["task"], now: number): void {
    const prior = getTaskScheduleState(d, PROJECT, task);
    writeTaskScheduleState(d, {
        projectPath: PROJECT,
        task,
        lastRunAt: null,
        nextDueAt: now - 1000,
        schedule: prior?.schedule ?? "0 3 * * *",
        lastStatus: null,
        lastError: null,
        retryCount: 0,
    });
}

describe("task-scheduler — runDueTasksForProject", () => {
    it("runs a due+gated task and advances next_due to the future", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [cfg("verify", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "verify", now);

        const ran: string[] = [];
        const executor = async (): Promise<TaskExecOutcome> => {
            ran.push("verify");
            return { status: "completed" };
        };
        await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            now,
        });
        expect(ran).toEqual(["verify"]);
        const state = getTaskScheduleState(db, PROJECT, "verify");
        expect(state?.lastStatus).toBe("completed");
        expect(state?.lastRunAt).toBeGreaterThanOrEqual(now);
        expect(state?.nextDueAt).toBeGreaterThan(now);
    });

    it("advances last_run_at from the run START on completion (not completion time)", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [cfg("verify", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "verify", now);

        // Slow executor: a long run makes the start↔finish gap visible, so the
        // assertion can discriminate run-start from run-completion advancement.
        const executor = async (): Promise<TaskExecOutcome> => {
            await new Promise((r) => setTimeout(r, 200));
            return { status: "completed" };
        };
        const before = Date.now();
        await runDueTasksForProject({ db, projectIdentity: PROJECT, tasks, executor, now });
        const after = Date.now();
        const state = getTaskScheduleState(db, PROJECT, "verify");
        expect(state?.lastStatus).toBe("completed");
        // last_run_at reflects the run START (~before), not the completion (~after):
        // a message landing mid-run is newer than the cutoff and re-triggers next slot.
        expect(state?.lastRunAt).toBeGreaterThanOrEqual(before);
        expect(state?.lastRunAt).toBeLessThan(after - 150);
    });

    it("skips a due task whose gate fails (no active memories) and advances it", async () => {
        db = freshDb();
        // No memories → verify gate fails.
        const now = Date.now();
        const tasks = [cfg("verify", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "verify", now);

        let ranExecutor = false;
        const executor = async (): Promise<TaskExecOutcome> => {
            ranExecutor = true;
            return { status: "completed" };
        };
        const count = await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            now,
        });
        expect(count).toBe(0);
        expect(ranExecutor).toBe(false);
        const state = getTaskScheduleState(db, PROJECT, "verify");
        expect(state?.lastStatus).toBe("skipped");
        expect(state?.nextDueAt).toBeGreaterThan(now);
    });

    it("failed runs persist retrospective recovery state without moving last_run_at", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [cfg("curate", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "curate", now);

        const executor = async (): Promise<TaskExecOutcome> => ({
            status: "failed",
            transient: true,
            error: "prompt is too long",
            schedulePatch: {
                retrospectiveWatermarkMs: 1700000000000,
                taskStateJson: JSON.stringify({ retrospectiveOverflow: { failures: 2 } }),
            },
        });
        await runDueTasksForProject({ db, projectIdentity: PROJECT, tasks, executor, now });

        const state = getTaskScheduleState(db, PROJECT, "curate");
        expect(state?.lastRunAt).toBeNull();
        expect(state?.retrospectiveWatermarkMs).toBe(1700000000000);
        expect(state?.taskStateJson).toContain("retrospectiveOverflow");
    });

    it("completed runs persist the retrospective content watermark patch", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        // curate is gateless, so the mocked executor (and its patch) always runs.
        const tasks = [cfg("curate", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "curate", now);

        const executor = async (): Promise<TaskExecOutcome> => ({
            status: "completed",
            schedulePatch: { retrospectiveWatermarkMs: 1700000000000 },
        });
        await runDueTasksForProject({ db, projectIdentity: PROJECT, tasks, executor, now });
        const state = getTaskScheduleState(db, PROJECT, "curate");
        expect(state?.retrospectiveWatermarkMs).toBe(1700000000000);
    });

    it("partial broad success advances the schedule while keeping its cycle open", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [cfg("verify-broad", "0 3 * * 0")];
        writeTaskScheduleState(db, {
            projectPath: PROJECT,
            task: "verify-broad",
            lastRunAt: null,
            nextDueAt: now - 1000,
            schedule: "0 3 * * 0",
            lastStatus: null,
            lastError: null,
            retryCount: 0,
            lastBroadRunAt: 123,
        });

        const executor = async (): Promise<TaskExecOutcome> => ({ status: "completed" });
        await runDueTasksForProject({ db, projectIdentity: PROJECT, tasks, executor, now });
        const state = getTaskScheduleState(db, PROJECT, "verify-broad");
        expect(state?.lastStatus).toBe("completed");
        expect(state?.lastRunAt).toBeGreaterThanOrEqual(now);
        expect(state?.nextDueAt).toBeGreaterThan(now);
        expect(state?.lastBroadRunAt).toBe(123);
    });

    it("a busy domain lease defers its tasks (next_due unchanged, no run)", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [cfg("verify", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "verify", now);
        // Hold the memory-domain lease from "another process".
        expect(acquireLease(db, "other-holder", leaseKeyFor("verify", PROJECT))).toBe(true);

        let ran = false;
        const executor = async (): Promise<TaskExecOutcome> => {
            ran = true;
            return { status: "completed" };
        };
        await runDueTasksForProject({ db, projectIdentity: PROJECT, tasks, executor, now });
        expect(ran).toBe(false);
        // next_due stayed in the past → still due next tick.
        const state = getTaskScheduleState(db, PROJECT, "verify");
        expect(state?.nextDueAt).toBeLessThan(now);
        expect(state?.lastStatus).toBeNull();
    });

    it("different domains run CONCURRENTLY (memory + smart-notes both execute)", async () => {
        db = freshDb();
        seedActiveMemory(db);
        // pending smart note for the evaluate-smart-notes gate
        db.prepare(
            `INSERT INTO notes (type, project_path, content, status, created_at, updated_at)
             VALUES ('smart', ?, 'n', 'pending', 1, 1)`,
        ).run(PROJECT);
        const now = Date.now();
        const tasks = [cfg("verify", "0 3 * * *"), cfg("evaluate-smart-notes", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "verify", now);
        forceDue(db, "evaluate-smart-notes", now);

        const ran = new Set<string>();
        const executor = async (c: DreamTaskRuntimeConfig): Promise<TaskExecOutcome> => {
            ran.add(c.task);
            return { status: "completed" };
        };
        const count = await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            now,
        });
        expect(count).toBe(2);
        expect(ran.has("verify")).toBe(true);
        expect(ran.has("evaluate-smart-notes")).toBe(true);
    });

    it("verify and curate share the memory domain and run in canonical order", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [cfg("curate", "0 4 * * 0"), cfg("verify", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "verify", now);
        forceDue(db, "curate", now);

        const ran: string[] = [];
        const leaseKeys = new Set<string>();
        const executor = async (
            c: DreamTaskRuntimeConfig,
            ctx: { leaseKey: string },
        ): Promise<TaskExecOutcome> => {
            ran.push(c.task);
            leaseKeys.add(ctx.leaseKey);
            return { status: "completed" };
        };

        const count = await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            now,
        });
        expect(count).toBe(2);
        expect(ran).toEqual(["verify", "curate"]);
        expect([...leaseKeys]).toEqual([leaseKeyFor("verify", PROJECT)]);
    });

    it("stops a domain group before the next task when the lease is no longer held", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [cfg("verify", "0 3 * * *"), cfg("curate", "0 4 * * 0")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "verify", now);
        forceDue(db, "curate", now);

        const ran: string[] = [];
        const executor = async (
            c: DreamTaskRuntimeConfig,
            ctx: { holderId: string; leaseKey: string },
        ): Promise<TaskExecOutcome> => {
            ran.push(c.task);
            releaseLease(db as Database, ctx.holderId, ctx.leaseKey);
            return { status: "completed" };
        };

        await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            now,
        });
        expect(ran).toEqual(["verify"]);
        expect(getTaskScheduleState(db, PROJECT, "curate")?.nextDueAt).toBeLessThan(now);
    });

    it("transient failure keeps next_due (hot-retry) until MAX_TASK_RETRIES, then advances", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [cfg("verify", "0 3 * * *")];

        const executor = async (): Promise<TaskExecOutcome> => ({
            status: "failed",
            transient: true,
            error: "rate limit",
        });

        // Force due ONCE; a transient failure leaves next_due in the past, so the
        // task stays due across ticks without re-forcing (re-forcing would reset
        // retry_count, which is the bug this exercises).
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "verify", now);
        // Attempts 1..3 keep next_due in the past (retry next tick).
        for (let attempt = 1; attempt <= 3; attempt++) {
            await runDueTasksForProject({ db, projectIdentity: PROJECT, tasks, executor, now });
            const s = getTaskScheduleState(db, PROJECT, "verify");
            expect(s?.retryCount).toBe(attempt);
            expect(s?.lastRunAt).toBeNull();
            expect(s?.nextDueAt).toBeLessThan(now); // still due
        }
        // Attempt 4 exceeds MAX_TASK_RETRIES=3 → advance + reset.
        await runDueTasksForProject({ db, projectIdentity: PROJECT, tasks, executor, now });
        const s = getTaskScheduleState(db, PROJECT, "verify");
        expect(s?.retryCount).toBe(0);
        expect(s?.nextDueAt).toBeGreaterThan(now);
        expect(s?.lastStatus).toBe("failed");
    });

    it("alternating schedules preserve the retry cap and cannot re-arm past slots", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.UTC(2026, 0, 1, 12, 0);
        const schedules = ["0 * * * *", "30 * * * *"];
        planDueTasks(db, PROJECT, [cfg("verify", schedules[0])], now);
        forceDue(db, "verify", now);
        const armed = getTaskScheduleState(db, PROJECT, "verify");
        if (!armed) throw new Error("missing armed row");
        writeTaskScheduleState(db, { ...armed, lastRunAt: now - 24 * 60 * 60_000 });
        const executor = async (): Promise<TaskExecOutcome> => ({
            status: "failed",
            transient: true,
            error: "rate limit",
        });
        for (let attempt = 1; attempt <= 4; attempt++) {
            const tasks = [cfg("verify", schedules[attempt % 2])];
            await runDueTasksForProject({ db, projectIdentity: PROJECT, tasks, executor, now });
            expect(getTaskScheduleState(db, PROJECT, "verify")?.retryCount).toBe(attempt % 4);
        }
        expect(getTaskScheduleState(db, PROJECT, "verify")?.nextDueAt).toBeGreaterThan(now);
        for (const schedule of [...schedules, ...schedules]) {
            expect(planDueTasks(db, PROJECT, [cfg("verify", schedule)], now)).toHaveLength(0);
        }
    });

    it("permanent failure advances to the next cron slot (no hot-retry)", async () => {
        db = freshDb();
        seedActiveMemory(db);
        const now = Date.now();
        const tasks = [cfg("verify", "0 3 * * *")];
        planDueTasks(db, PROJECT, tasks, now);
        forceDue(db, "verify", now);
        const executor = async (): Promise<TaskExecOutcome> => ({
            status: "failed",
            transient: false,
            error: "model not found",
        });
        await runDueTasksForProject({ db, projectIdentity: PROJECT, tasks, executor, now });
        const s = getTaskScheduleState(db, PROJECT, "verify");
        expect(s?.nextDueAt).toBeGreaterThan(now);
        expect(s?.retryCount).toBe(0);
        expect(s?.lastStatus).toBe("failed");
    });
});

describe("task-scheduler — runManualDream", () => {
    // Only project-memory tasks are refused with memory off; maintain-docs and the
    // other tasks that serve different settings stay runnable (task-settings-gate.test.ts).
    it("memory-off refuses even forced memory and classifier tasks before any store read", async () => {
        const unreadable = {
            prepare() {
                throw new Error("memory-off store read");
            },
        } as unknown as Database;
        let executed = 0;
        const executor = async (): Promise<TaskExecOutcome> => {
            executed += 1;
            return { status: "completed" };
        };
        for (const task of [
            "curate",
            "classify-memories",
            "map-memories",
            "refresh-primers",
        ] as const) {
            const tasks = [cfg(task, "0 3 * * *")];
            const deps = {
                db: unreadable,
                projectIdentity: PROJECT,
                tasks,
                executor,
                projectMemoryEnabled: false,
            };
            const result = await runManualDream({ ...deps, task });
            expect(result.ran).toEqual([]);
            expect(result.backlogBefore).toEqual({});
            expect((await runManualDream(deps)).ran).toEqual([]);
            expect(await runDueTasksForProject(deps)).toBe(0);
        }
        expect(executed).toBe(0);
    });

    it("no task arg runs ALL enabled tasks regardless of schedule (not due)", async () => {
        db = freshDb();
        seedActiveMemory(db);
        db.prepare(
            `INSERT INTO notes (type, project_path, content, status, created_at, updated_at)
             VALUES ('smart', ?, 'n', 'pending', 1, 1)`,
        ).run(PROJECT);
        const tasks = [
            cfg("verify", "0 3 * * *"),
            cfg("evaluate-smart-notes", "0 3 * * *"),
            cfg("maintain-docs", ""), // disabled → must NOT run even manually
        ];
        const ran: string[] = [];
        const executor = async (c: DreamTaskRuntimeConfig): Promise<TaskExecOutcome> => {
            ran.push(c.task);
            return { status: "completed" };
        };
        const result = await runManualDream({ db, projectIdentity: PROJECT, tasks, executor });
        expect(result.ran.sort()).toEqual(["evaluate-smart-notes", "verify"]);
        expect(ran).not.toContain("maintain-docs"); // disabled stays off
    });

    it("a single task arg FORCE-runs it ignoring the activity gate", async () => {
        db = freshDb();
        // No active memories → verify's gate would normally fail. Forced runs anyway.
        const tasks = [cfg("verify", "0 3 * * *")];
        let ran = false;
        const executor = async (): Promise<TaskExecOutcome> => {
            ran = true;
            return { status: "completed" };
        };
        const result = await runManualDream({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            task: "verify",
        });
        expect(ran).toBe(true);
        expect(result.ran).toEqual(["verify"]);
    });

    it("returns successful task detail for the manual command", async () => {
        db = freshDb();
        const tasks = [cfg("curate", "")];
        const executor = async (): Promise<TaskExecOutcome> => ({
            status: "completed",
            detail: "curate: 2 memory operations applied (merge, archive)",
        });
        const result = await runManualDream({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            task: "curate",
        });

        expect(result.details).toEqual(["curate: 2 memory operations applied (merge, archive)"]);
    });

    it("a single DISABLED task can still be force-run by name", async () => {
        db = freshDb();
        const tasks = [cfg("maintain-docs", "")]; // disabled
        let ran = false;
        const executor = async (): Promise<TaskExecOutcome> => {
            ran = true;
            return { status: "completed" };
        };
        const result = await runManualDream({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            task: "maintain-docs",
        });
        expect(ran).toBe(true);
        expect(result.ran).toEqual(["maintain-docs"]);
    });

    it("reports gate-skipped tasks in the all-enabled run", async () => {
        db = freshDb();
        // No active memories → verify gate fails; it is enabled but skipped.
        const tasks = [cfg("verify", "0 3 * * *")];
        const executor = async (): Promise<TaskExecOutcome> => ({ status: "completed" });
        const result = await runManualDream({ db, projectIdentity: PROJECT, tasks, executor });
        expect(result.ran).toEqual([]);
        expect(result.skippedNoWork).toEqual(["verify"]);
    });

    it("reports structured failure detail while preserving the legacy scheduler error", async () => {
        db = freshDb();
        const tasks = [cfg("verify", "0 3 * * *")];
        const executor = async (): Promise<TaskExecOutcome> => ({
            status: "failed",
            transient: true,
            error: "verify returned no output",
            failureDetail: "empty_completion · model: provider/model",
        });
        const result = await runManualDream({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            task: "verify",
        });
        expect(result.failureDetails).toEqual(["verify: empty_completion · model: provider/model"]);
        expect(getTaskScheduleState(db, PROJECT, "verify")?.lastError).toBe(
            "verify returned no output",
        );
    });

    it("an unknown forced task name is a no-op", async () => {
        db = freshDb();
        const tasks = [cfg("verify", "0 3 * * *")];
        const executor = async (): Promise<TaskExecOutcome> => ({ status: "completed" });
        const result = await runManualDream({
            db,
            projectIdentity: PROJECT,
            tasks,
            executor,
            task: "not-a-task" as never,
        });
        expect(result.ran).toEqual([]);
    });
});
