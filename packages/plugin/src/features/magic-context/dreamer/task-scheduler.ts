import type { PiThinkingLevel } from "../../../config/schema/magic-context";
import { log } from "../../../shared/logger";
import type { ModelInput } from "../../../shared/model-resolution";
import type { Database } from "../../../shared/sqlite";
import { nextDueAtMs } from "./cron";
import {
    acquireLeaseWithAcquisition,
    type LeaseAcquisition,
    leaseOwnershipMatches,
    releaseLease,
} from "./lease";
import { getDreamState } from "./storage-dream-state";
import {
    getTaskScheduleState,
    pruneNonCanonicalTaskRows,
    seedTaskScheduleState,
    writeTaskScheduleState,
} from "./storage-task-schedule";
import { evaluateTaskGate, getDreamTaskBacklogs } from "./task-gates";
import {
    CANONICAL_DREAM_TASKS,
    compareTaskOrder,
    type DreamTaskBacklog,
    type DreamTaskBacklogMap,
    type DreamTaskName,
    leaseKeyFor,
    leaseKindFor,
} from "./task-registry";

/** Bounded retry before a transient failure stops hot-retrying and waits for the
 *  next cron occurrence. */
export const MAX_TASK_RETRIES = 3;

/** Resolved per-task config the scheduler operates on (decoupled from the Zod
 *  schema — step 5 produces this from config; the scheduler just consumes it). */
export interface DreamTaskRuntimeConfig {
    task: DreamTaskName;
    /** Cron string; `""` = disabled (never due). */
    schedule: string;
    model?: ModelInput;
    fallbackModels?: readonly ModelInput[];
    thinkingLevel?: PiThinkingLevel;
    language?: string;
    timeoutMinutes: number;
    /** review-user-memories */
    promotionThreshold?: number;
}

export interface TaskExecOutcome {
    status: "completed" | "failed";
    /** A transient failure (provider/network/rate-limit/timeout) hot-retries up to
     *  MAX_TASK_RETRIES; a permanent failure advances to the next cron slot. */
    transient?: boolean;
    error?: string;
    /** Structured user-facing diagnostic while `error` remains the legacy value
     *  persisted in task schedule state. */
    failureDetail?: string;
    /** Successful task detail surfaced by a manual `/ctx-dream` run. */
    detail?: string;
    /** Run-local backlog when a task's scope differs from its next scheduled scope. */
    backlog?: DreamTaskBacklog;
    schedulePatch?: {
        /** retrospective content watermark (max message ts scanned this run). */
        retrospectiveWatermarkMs?: number | null;
        /** Task-local JSON state committed only after successful execution. */
        taskStateJson?: string;
    };
}

/** Runs ONE task's actual work (LLM loop). Supplied by the runner (step 4). The
 *  scheduler holds the domain lease + `holderId`; the executor must verify the
 *  lease holder under BEGIN IMMEDIATE immediately before any durable write. */
export interface TaskExecutorContext {
    db: Database;
    projectIdentity: string;
    holderId: string;
    leaseKey: string;
    leaseAcquisition?: LeaseAcquisition;
}

export type TaskExecutor = (
    task: DreamTaskRuntimeConfig,
    ctx: TaskExecutorContext,
) => Promise<TaskExecOutcome>;

export interface RunDueTasksDeps {
    db: Database;
    projectIdentity: string;
    tasks: readonly DreamTaskRuntimeConfig[];
    executor: TaskExecutor;
    now?: number;
}

/** First-seed a task's schedule row if absent. next_due_at from cron(after now);
 *  last_run_at seeded from the legacy per-project `last_dream_at` so a freshly
 *  upgraded project doesn't treat every task as never-run (full historical pass).
 *  Idempotent — ON CONFLICT DO NOTHING (see storage). */
function ensureSeeded(
    db: Database,
    projectIdentity: string,
    config: DreamTaskRuntimeConfig,
    now: number,
): void {
    if (getTaskScheduleState(db, projectIdentity, config.task)) return;
    const legacy = getDreamState(db, `last_dream_at:${projectIdentity}`);
    const legacyLastRun = legacy ? Number(legacy) : null;
    const lastRunAt = legacyLastRun && Number.isFinite(legacyLastRun) ? legacyLastRun : null;
    const nextDueAt = nextDueAtMs(config.schedule, now);
    seedTaskScheduleState(db, projectIdentity, config.task, nextDueAt, lastRunAt, config.schedule);
}

/**
 * Make the CONFIG schedule authoritative every pass: seed the row if missing,
 * then — if the persisted `schedule` no longer matches the config — recompute
 * `next_due_at` so a disable / enable / cron change takes effect IMMEDIATELY
 * (not only after the stale slot fires once). Without this the stored
 * `next_due_at` is trusted forever: a task disabled after seeding would still
 * fire once at its old slot, and a task seeded `next_due_at = NULL` (e.g. it was
 * disabled when first seen) and later enabled would never become due.
 *
 * Cases (config.schedule vs persisted `schedule`):
 *  - equal → in sync, no write.
 *  - config `""` (disabled) → force `next_due_at = NULL`.
 *  - persisted `schedule IS NULL` with a live `next_due_at` → legacy row written
 *    before the column existed; it was seeded from THIS config, so just backfill
 *    the string and keep its already-correct `next_due_at`.
 *  - otherwise (genuine change, or enabling) → recompute `next_due_at` from now,
 *    reset retry_count.
 */
function reconcileSchedule(
    db: Database,
    projectIdentity: string,
    config: DreamTaskRuntimeConfig,
    now: number,
): void {
    ensureSeeded(db, projectIdentity, config, now);
    const stored = getTaskScheduleState(db, projectIdentity, config.task);
    if (!stored || stored.schedule === config.schedule) return;

    if (config.schedule.trim() === "") {
        writeTaskScheduleState(db, { ...stored, schedule: config.schedule, nextDueAt: null });
        return;
    }
    if (stored.schedule === null && stored.nextDueAt !== null) {
        // Legacy row seeded from this same config before the schedule column
        // existed: backfill the string, keep the already-correct next_due_at.
        writeTaskScheduleState(db, { ...stored, schedule: config.schedule });
        return;
    }
    writeTaskScheduleState(db, {
        ...stored,
        schedule: config.schedule,
        nextDueAt: nextDueAtMs(config.schedule, now),
        retryCount: 0,
    });
}

interface DueTask {
    config: DreamTaskRuntimeConfig;
    /** The next_due_at slot being satisfied — excluded from the next computation
     *  to prevent a DST repeated-minute double-fire. */
    scheduledAt: number;
}

/** Pure-ish decision: seed missing rows, then collect tasks whose next_due_at has
 *  arrived. Gate evaluation happens in the drain (pre- AND post-lease). Exported
 *  for testing. */
export function planDueTasks(
    db: Database,
    projectIdentity: string,
    tasks: readonly DreamTaskRuntimeConfig[],
    now: number,
): DueTask[] {
    // GC retired task rows: improve, consolidate, and archive-stale were replaced
    // by verify/curate, while render-mural was removed when the scheduler switched
    // to its deterministic task set. Prune against the canonical set — NOT the
    // passed task list: callers may filter that list for execution (e.g. a host
    // without a tool loop), and a capability filter must never delete canonical
    // schedule rows (last_run_at / next_due_at / watermarks) for the whole project.
    // Cheap and idempotent.
    const pruned = pruneNonCanonicalTaskRows(db, projectIdentity, CANONICAL_DREAM_TASKS);
    if (pruned > 0) {
        log(`[dreamer] pruned ${pruned} retired task row(s) for ${projectIdentity}`);
    }

    const due: DueTask[] = [];
    for (const config of tasks) {
        // Reconcile (not just seed) so the live config schedule is authoritative:
        // a disabled task's next_due_at is forced NULL, an enabled/changed task's
        // is recomputed — before we read it below.
        reconcileSchedule(db, projectIdentity, config, now);
        const state = getTaskScheduleState(db, projectIdentity, config.task);
        if (!state || state.nextDueAt === null) continue; // disabled / impossible cron
        if (now >= state.nextDueAt) {
            due.push({ config, scheduledAt: state.nextDueAt });
        }
    }
    return due;
}

function advanceAfterRun(
    db: Database,
    projectIdentity: string,
    due: DueTask,
    finishedAt: number,
    status: "completed" | "failed" | "skipped",
    error: string | null,
    schedulePatch?: TaskExecOutcome["schedulePatch"],
    startedAt?: number,
): void {
    writeTaskScheduleState(db, {
        projectPath: projectIdentity,
        task: due.config.task,
        // last_run_at = the start of the last SUCCESSFUL run — the cutoff for
        // "changed since" gates. A message/compartment that landed DURING the run
        // (after the start) is newer than the cutoff, so it re-triggers the gate next
        // slot instead of being silently skipped. Failed/skipped runs never advance it.
        lastRunAt:
            status === "completed"
                ? (startedAt ?? finishedAt)
                : readLastRunAt(db, projectIdentity, due.config.task),
        nextDueAt: nextDueAtMs(due.config.schedule, finishedAt, due.scheduledAt),
        schedule: due.config.schedule,
        lastStatus: status,
        lastError: error,
        retryCount: 0,
        taskStateJson: schedulePatch?.taskStateJson,
        retrospectiveWatermarkMs: schedulePatch?.retrospectiveWatermarkMs,
    });
}

function readLastRunAt(db: Database, projectIdentity: string, task: DreamTaskName): number | null {
    return getTaskScheduleState(db, projectIdentity, task)?.lastRunAt ?? null;
}

function readRetrospectiveWatermark(
    db: Database,
    projectIdentity: string,
    task: DreamTaskName,
): number | null {
    return getTaskScheduleState(db, projectIdentity, task)?.retrospectiveWatermarkMs ?? null;
}

/** Record a transient failure: keep next_due_at so it hot-retries next tick,
 *  until MAX_TASK_RETRIES is exceeded, then advance to the next cron slot.
 *  Incomplete manifest drains use this path too: the retry cap prevents one
 *  permanently failing unit from starving the slot forever, at the cost of
 *  leaving its residue for the next scheduled slot after the cap is reached. */
function recordTransientFailure(
    db: Database,
    projectIdentity: string,
    due: DueTask,
    finishedAt: number,
    error: string | null,
): void {
    const prior = getTaskScheduleState(db, projectIdentity, due.config.task);
    const retryCount = (prior?.retryCount ?? 0) + 1;
    // A failed run did not process the work → preserve the prior success cutoff
    // (do NOT advance last_run_at; see advanceAfterRun).
    const priorLastRun = prior?.lastRunAt ?? null;
    if (retryCount > MAX_TASK_RETRIES) {
        writeTaskScheduleState(db, {
            projectPath: projectIdentity,
            task: due.config.task,
            lastRunAt: priorLastRun,
            nextDueAt: nextDueAtMs(due.config.schedule, finishedAt, due.scheduledAt),
            schedule: due.config.schedule,
            lastStatus: "failed",
            lastError: error,
            retryCount: 0,
        });
    } else {
        // Hot-retry: keep next_due_at so the timer re-attempts next tick — but a
        // DISABLED task (schedule "") must never become due. This matters for a
        // manual force-run of a disabled task (`/ctx-dream <task>`), where
        // due.scheduledAt = now; without this guard a transient failure would
        // write next_due_at = now and the timer would then run a disabled task.
        const disabled = due.config.schedule.trim() === "";
        writeTaskScheduleState(db, {
            projectPath: projectIdentity,
            task: due.config.task,
            lastRunAt: priorLastRun,
            nextDueAt: disabled ? null : (prior?.nextDueAt ?? due.scheduledAt),
            schedule: due.config.schedule,
            lastStatus: "failed",
            lastError: error,
            retryCount,
        });
    }
}

interface DomainGroupCallbacks {
    /** Manual single-task run ignores the post-lease activity gate re-check. */
    forceGate?: boolean;
    /**
     * How long a manual run may wait for a busy domain lease before giving
     * up. Scheduled ticks leave this unset (the next tick retries anyway).
     */
    leaseWaitMs?: number;
    onRan?: (task: DreamTaskName, detail?: string, backlog?: DreamTaskBacklog) => void;
    onFailed?: (task: DreamTaskName, error?: string) => void;
    onBusy?: (task: DreamTaskName) => void;
}

/** Poll cadence while a manual run waits for a busy domain lease. */
const LEASE_WAIT_POLL_MS = 2_000;
/** Lease wait budget for manual /ctx-dream runs. */
export const MANUAL_RUN_LEASE_WAIT_MS = 60_000;

async function runDomainGroup(
    deps: RunDueTasksDeps,
    group: DueTask[],
    cb?: DomainGroupCallbacks,
): Promise<void> {
    const { db, projectIdentity, executor } = deps;
    // All tasks in a group share a lease domain → one key for the group.
    const leaseKey = leaseKeyFor(group[0].config.task, projectIdentity);
    const holderId = crypto.randomUUID();

    let acquisition = acquireLeaseWithAcquisition(db, holderId, leaseKey);
    if (!acquisition && cb?.leaseWaitMs) {
        // Explicit manual run: the lease holder is usually a scheduled
        // catch-up task on the same domain finishing within seconds. Waiting
        // briefly turns a confusing "busy, try again" into the run the user
        // asked for. Scheduled ticks never wait (leaseWaitMs unset) — the next
        // tick retries anyway.
        const deadline = Date.now() + cb.leaseWaitMs;
        while (!acquisition && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, LEASE_WAIT_POLL_MS));
            acquisition = acquireLeaseWithAcquisition(db, holderId, leaseKey);
        }
    }
    if (!acquisition) {
        // Busy (a long sibling run or another process holds it). Leave next_due_at
        // unchanged so these tasks re-attempt next tick — they run the instant the
        // lease frees. No state write.
        log(`[dreamer] domain lease busy (${leaseKey}) — deferring ${group.length} task(s)`);
        for (const due of group) cb?.onBusy?.(due.config.task);
        return;
    }

    try {
        for (const due of [...group].sort((a, b) =>
            compareTaskOrder(a.config.task, b.config.task),
        )) {
            if (!leaseOwnershipMatches(db, holderId, acquisition.generation, leaseKey)) {
                log(`[dreamer] domain lease lost (${leaseKey}) — stopping remaining task(s)`);
                break;
            }

            // Re-evaluate the gate now that we hold the lease: a sibling/other
            // process may have just consumed the work (critical for the global
            // user-memories domain). A forced manual single-task run skips this.
            if (!cb?.forceGate) {
                const gatePass = evaluateTaskGate(due.config.task, {
                    db,
                    projectIdentity,
                    lastRunAt: readLastRunAt(db, projectIdentity, due.config.task),
                    retrospectiveWatermarkMs: readRetrospectiveWatermark(
                        db,
                        projectIdentity,
                        due.config.task,
                    ),
                    promotionThreshold: due.config.promotionThreshold ?? 3,
                });
                if (!gatePass) {
                    advanceAfterRun(db, projectIdentity, due, Date.now(), "skipped", null);
                    continue;
                }
            }

            let outcome: TaskExecOutcome;
            const startedAt = Date.now();
            try {
                outcome = await executor(due.config, {
                    db,
                    projectIdentity,
                    holderId,
                    leaseKey,
                    leaseAcquisition: acquisition,
                });
            } catch (error) {
                outcome = { status: "failed", transient: true, error: String(error) };
            }

            const finishedAt = Date.now();
            if (outcome.status === "completed") {
                advanceAfterRun(
                    db,
                    projectIdentity,
                    due,
                    finishedAt,
                    "completed",
                    null,
                    outcome.schedulePatch,
                    startedAt,
                );
                cb?.onRan?.(due.config.task, outcome.detail, outcome.backlog);
            } else if (outcome.transient) {
                recordTransientFailure(db, projectIdentity, due, finishedAt, outcome.error ?? null);
                cb?.onFailed?.(due.config.task, outcome.failureDetail ?? outcome.error);
            } else {
                advanceAfterRun(
                    db,
                    projectIdentity,
                    due,
                    finishedAt,
                    "failed",
                    outcome.error ?? null,
                );
                cb?.onFailed?.(due.config.task, outcome.failureDetail ?? outcome.error);
            }
        }
    } finally {
        releaseLease(db, holderId, leaseKey);
    }
}

export interface ManualRunResult {
    /** Tasks that actually executed (gate passed, lease acquired). */
    ran: string[];
    /** Tasks that were skipped because their activity gate failed. */
    skippedNoWork: string[];
    /** Tasks whose domain lease was busy (another run in progress). */
    deferredBusy: string[];
    /** Tasks that ran but failed. */
    failed: string[];
    /** User-visible error details for failed tasks, including incomplete backlogs. */
    failureDetails?: string[];
    /** User-visible detail from successful tasks. */
    details?: string[];
    /** Read-only backlog snapshot before the selected tasks started. */
    backlogBefore: DreamTaskBacklogMap;
    /** Read-only backlog snapshot after the selected tasks finished or were skipped. */
    backlogAfter: DreamTaskBacklogMap;
}

/**
 * Manual `/ctx-dream` run: run dream tasks NOW, IGNORING their schedule.
 *
 * - No `task` arg → run every ENABLED task (schedule != "") whose activity gate
 *   passes, grouped by domain under leases (same concurrency rules as the timer).
 * - `task` arg → force-run that ONE task NOW, IGNORING its gate (explicit user
 *   intent), honoring its lease. Works even if the task's schedule is "".
 *
 * Still advances next_due_at on completion so the manual run resets the cadence.
 */
export async function runManualDream(
    deps: Omit<RunDueTasksDeps, "now"> & { task?: DreamTaskName },
): Promise<ManualRunResult> {
    const now = Date.now();
    const result: ManualRunResult = {
        ran: [],
        skippedNoWork: [],
        deferredBusy: [],
        failed: [],
        failureDetails: [],
        details: [],
        backlogBefore: {},
        backlogAfter: {},
    };

    let selected: readonly DreamTaskRuntimeConfig[];
    let forceGate = false;
    if (deps.task) {
        const cfg = deps.tasks.find((t) => t.task === deps.task);
        if (!cfg) return result;
        selected = [cfg];
        forceGate = true; // explicit single-task run ignores the activity gate
    } else {
        // All enabled tasks (schedule != ""); disabled tasks stay off even manually.
        selected = deps.tasks.filter((t) => t.schedule.trim() !== "");
    }
    if (selected.length === 0) return result;

    const selectedTaskNames = selected.map((config) => config.task);
    result.backlogBefore = getDreamTaskBacklogs(deps.db, deps.projectIdentity, selectedTaskNames);
    result.backlogAfter = { ...result.backlogBefore };

    // Seed rows so completion advancement has a row to update.
    for (const cfg of selected) ensureSeeded(deps.db, deps.projectIdentity, cfg, now);

    // Build synthetic DueTasks (scheduledAt = now, since manual ignores schedule).
    const dueAll: DueTask[] = selected.map((config) => ({ config, scheduledAt: now }));

    // Pre-gate (unless forced).
    const gated: DueTask[] = [];
    for (const d of dueAll) {
        if (forceGate) {
            gated.push(d);
            continue;
        }
        const pass = evaluateTaskGate(d.config.task, {
            db: deps.db,
            projectIdentity: deps.projectIdentity,
            lastRunAt: readLastRunAt(deps.db, deps.projectIdentity, d.config.task),
            retrospectiveWatermarkMs: readRetrospectiveWatermark(
                deps.db,
                deps.projectIdentity,
                d.config.task,
            ),
            promotionThreshold: d.config.promotionThreshold ?? 3,
        });
        if (pass) gated.push(d);
        else result.skippedNoWork.push(d.config.task);
    }
    if (gated.length === 0) {
        result.backlogAfter = getDreamTaskBacklogs(
            deps.db,
            deps.projectIdentity,
            selectedTaskNames,
        );
        return result;
    }

    const groups = new Map<string, DueTask[]>();
    const runLocalBacklogs: DreamTaskBacklogMap = {};
    for (const d of gated) {
        const kind = leaseKindFor(d.config.task);
        const arr = groups.get(kind) ?? [];
        arr.push(d);
        groups.set(kind, arr);
    }

    await Promise.all(
        [...groups.values()].map((group) =>
            runDomainGroup({ ...deps, executor: deps.executor }, group, {
                forceGate,
                leaseWaitMs: MANUAL_RUN_LEASE_WAIT_MS,
                onRan: (t, detail, backlog) => {
                    result.ran.push(t);
                    if (detail) result.details?.push(detail);
                    if (backlog) runLocalBacklogs[t] = backlog;
                },
                onFailed: (task, error) => {
                    result.failed.push(task);
                    if (error) result.failureDetails?.push(`${task}: ${error}`);
                },
                onBusy: (t) => result.deferredBusy.push(t),
            }),
        ),
    );
    result.backlogAfter = {
        ...getDreamTaskBacklogs(deps.db, deps.projectIdentity, selectedTaskNames),
        ...runLocalBacklogs,
    };
    return result;
}

/**
 * One scheduler pass for a project: seed missing rows, collect due tasks,
 * pre-gate them, group by conflict-domain, and run domains CONCURRENTLY (tasks
 * within a domain sequentially in canonical order under one lease). Returns the
 * number of tasks actually executed (for logging/tests).
 */
export async function runDueTasksForProject(deps: RunDueTasksDeps): Promise<number> {
    const now = deps.now ?? Date.now();
    const due = planDueTasks(deps.db, deps.projectIdentity, deps.tasks, now);
    if (due.length === 0) return 0;

    // Pre-lease gate: cheap filter so we don't even acquire a lease for a task
    // with no work. Gate-fail → advance to next cron, mark skipped.
    const gated: DueTask[] = [];
    for (const d of due) {
        const pass = evaluateTaskGate(d.config.task, {
            db: deps.db,
            projectIdentity: deps.projectIdentity,
            lastRunAt: readLastRunAt(deps.db, deps.projectIdentity, d.config.task),
            retrospectiveWatermarkMs: readRetrospectiveWatermark(
                deps.db,
                deps.projectIdentity,
                d.config.task,
            ),
            promotionThreshold: d.config.promotionThreshold ?? 3,
        });
        if (pass) {
            gated.push(d);
        } else {
            advanceAfterRun(deps.db, deps.projectIdentity, d, now, "skipped", null);
        }
    }
    if (gated.length === 0) return 0;

    // Group by lease domain.
    const groups = new Map<string, DueTask[]>();
    for (const d of gated) {
        const kind = leaseKindFor(d.config.task);
        const arr = groups.get(kind) ?? [];
        arr.push(d);
        groups.set(kind, arr);
    }

    await Promise.all([...groups.values()].map((group) => runDomainGroup(deps, group)));
    return gated.length;
}
