import {
    DREAM_TASK_PROMOTION_DEFAULTS,
    type PiThinkingLevel,
} from "../../../config/schema/magic-context";
import { log } from "../../../shared/logger";
import type { ModelInput } from "../../../shared/model-resolution";
import type { Database } from "../../../shared/sqlite";
import { isUsableProjectIdentity } from "../memory/project-identity";
import { nextDueAtMs } from "./cron";
import { pruneIdleScheduleIdentities } from "./idle-schedule-prune";
import {
    acquireLeaseWithAcquisition,
    type LeaseAcquisition,
    reacquireOwnedLease,
    releaseLease,
} from "./lease";
import { withDreamerModelCooldown } from "./provider-output-failure";
import { getDreamState } from "./storage-dream-state";
import {
    getTaskScheduleState,
    pruneNonCanonicalTaskRows,
    seedTaskScheduleState,
    writeTaskScheduleState,
} from "./storage-task-schedule";
import { evaluateTaskGate, getDreamTaskBacklogs, taskHasSchedulableInput } from "./task-gates";
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
    /** Configured Pi chain contained no models in Pi's registry. */
    modelChainUnavailable?: boolean;
    thinkingLevel?: PiThinkingLevel;
    language?: string;
    timeoutMinutes: number;
    /** Cumulative prompt-token ceiling for one tool-loop child. */
    tokenBudget?: number;
    /** review-user-memories */
    promotionThreshold?: number;
    /** retrospective source lookback; old rows are skipped by advancing its content watermark. */
    retrospectiveRecencyDays?: number;
    docsMaxTokens?: number;
}

export interface TaskExecOutcome {
    status: "completed" | "failed" | "skipped";
    /** A transient failure (provider/network/rate-limit/timeout) hot-retries up to
     *  MAX_TASK_RETRIES; a permanent failure advances to the next cron slot. */
    transient?: boolean;
    error?: string;
    /** Structured user-facing diagnostic while `error` remains the legacy value
     *  persisted in task schedule state. */
    failureDetail?: string;
    /** Completed task detail or explicit skip reason surfaced by `/ctx-dream`. */
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
    /**
     * The host's `memory.enabled` for this project. `false` means this caller
     * schedules nothing (existing rows are kept); omitted means on.
     */
    projectMemoryEnabled?: boolean;
}

/** First-seed a task's schedule row if absent. next_due_at from cron(after now);
 *  last_run_at seeded from the legacy per-project `last_dream_at` so a freshly
 *  upgraded project doesn't treat every task as never-run (full historical pass).
 *  Idempotent — ON CONFLICT DO NOTHING (see storage).
 *
 *  A task is seeded only once the identity has the input it works on (see
 *  taskHasSchedulableInput); until then it gets no row, so a directory that
 *  never produces a memory never carries memory-maintenance schedules. */
function ensureSeeded(
    db: Database,
    projectIdentity: string,
    config: DreamTaskRuntimeConfig,
    now: number,
): void {
    if (getTaskScheduleState(db, projectIdentity, config.task)) return;
    if (!taskHasSchedulableInput(config.task, db, projectIdentity, now)) return;
    const legacy = getDreamState(db, `last_dream_at:${projectIdentity}`);
    const legacyLastRun = legacy ? Number(legacy) : null;
    const lastRunAt = legacyLastRun && Number.isFinite(legacyLastRun) ? legacyLastRun : null;
    const nextDueAt = nextDueAtMs(config.schedule, now);
    seedTaskScheduleState(db, projectIdentity, config.task, nextDueAt, lastRunAt, config.schedule);
}

function firstRepeatedCivilMinute(candidateMs: number): number | null {
    const date = new Date(candidateMs);
    const first = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        date.getHours(),
        date.getMinutes(),
    ).getTime();
    return first < candidateMs ? first : null;
}

/**
 * Reconcile enabled worktrees without postponing an already-armed shared slot.
 * Disabled worktrees are filtered by the caller and never mutate shared state.
 *
 * Cases (config.schedule vs persisted `schedule`):
 *  - equal → in sync, no write.
 *  - persisted `schedule IS NULL` with a live `next_due_at` → legacy row written
 *    before the column existed; it was seeded from THIS config, so just backfill
 *    the string and keep its already-correct `next_due_at`.
 *  - otherwise (genuine change, or enabling) → compute the new slot from the
 *    current time and keep the earlier of it and the slot already held. Preserve
 *    retries when retaining that slot; a schedule edit must not restart retries
 *    or use an old successful run to re-arm an already-consumed occurrence.
 */
function reconcileSchedule(
    db: Database,
    projectIdentity: string,
    config: DreamTaskRuntimeConfig,
    now: number,
): void {
    ensureSeeded(db, projectIdentity, config, now);
    const current = getTaskScheduleState(db, projectIdentity, config.task);
    // No row means the task has no input yet: nothing to reconcile, and
    // reconciling must not create the row seeding just declined to create.
    if (!current || current.schedule === config.schedule) return;

    // Cron search can scan years for an impossible expression. Do it before
    // taking the write lock; only the row-dependent decision belongs inside.
    const candidate = nextDueAtMs(config.schedule, now);
    const repeatedFirst = candidate === null ? null : firstRepeatedCivilMinute(candidate);
    const afterRepeatedFirst =
        repeatedFirst === null ? candidate : nextDueAtMs(config.schedule, now, repeatedFirst);
    db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
        const stored = getTaskScheduleState(db, projectIdentity, config.task);
        if (stored && stored.schedule !== config.schedule) {
            if (stored.schedule === null && stored.nextDueAt !== null) {
                // The legacy slot was seeded from this config before schedule was stored;
                // only the missing schedule string needs backfilling.
                writeTaskScheduleState(db, { ...stored, schedule: config.schedule });
            } else {
                // An advanced shared slot has already consumed the first copy of
                // a repeated civil minute. Do not re-arm its second copy.
                const nextDueAt =
                    repeatedFirst !== null &&
                    candidate !== null &&
                    stored.nextDueAt !== null &&
                    stored.nextDueAt > candidate &&
                    stored.lastStatus !== null
                        ? afterRepeatedFirst
                        : candidate;
                const reconciledNextDueAt =
                    stored.nextDueAt === null
                        ? nextDueAt
                        : nextDueAt === null
                          ? stored.nextDueAt
                          : Math.min(stored.nextDueAt, nextDueAt);
                writeTaskScheduleState(db, {
                    ...stored,
                    schedule: config.schedule,
                    nextDueAt: reconciledNextDueAt,
                    retryCount: reconciledNextDueAt === stored.nextDueAt ? stored.retryCount : 0,
                });
            }
        }
        db.exec("COMMIT");
        committed = true;
    } finally {
        if (!committed) {
            try {
                db.exec("ROLLBACK");
            } catch {
                /* transaction already closed */
            }
        }
    }
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
    // GC retired task rows against the canonical registry, never the caller's
    // execution list. Capability-filtered callers must not delete durable
    // schedules and watermarks for canonical tasks they cannot run.
    const pruned = pruneNonCanonicalTaskRows(db, projectIdentity, CANONICAL_DREAM_TASKS);
    if (pruned > 0) {
        log(`[dreamer] pruned ${pruned} retired task row(s) for ${projectIdentity}`);
    }
    // Identities that can do nothing (no memories, no recent sessions, no task
    // input) are removed across the whole store, at most once a day. A failure
    // here must not stop this identity's own tasks.
    try {
        pruneIdleScheduleIdentities(db, now);
    } catch (error) {
        log("[dreamer] idle schedule pruning failed:", error);
    }

    const due: DueTask[] = [];
    for (const config of tasks) {
        // Disabling is local to this worktree, not a cancellation of shared work.
        if (config.schedule.trim() === "") continue;
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
    schedulePatch?: TaskExecOutcome["schedulePatch"],
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
            taskStateJson: schedulePatch?.taskStateJson,
            retrospectiveWatermarkMs: schedulePatch?.retrospectiveWatermarkMs,
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
            taskStateJson: schedulePatch?.taskStateJson,
            retrospectiveWatermarkMs: schedulePatch?.retrospectiveWatermarkMs,
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
    onSkipped?: (task: DreamTaskName, reason?: string) => void;
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
    return withDreamerModelCooldown(() => runDomainGroupWithCooldown(deps, group, cb));
}

async function runDomainGroupWithCooldown(
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
            // Refresh at each task boundary so setup and gated siblings cannot
            // consume the next task's entire lease before its heartbeat starts.
            if (!reacquireOwnedLease(db, holderId, leaseKey, acquisition.generation)) {
                log(`[dreamer] domain lease lost (${leaseKey}) — stopping remaining task(s)`);
                break;
            }

            acquisition = { acquiredAt: Date.now(), generation: acquisition.generation };

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
                    promotionThreshold:
                        due.config.promotionThreshold ??
                        (due.config.task === "promote-primers"
                            ? DREAM_TASK_PROMOTION_DEFAULTS["promote-primers"]
                            : DREAM_TASK_PROMOTION_DEFAULTS["review-user-memories"]),
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
            if (outcome.status === "skipped") {
                advanceAfterRun(
                    db,
                    projectIdentity,
                    due,
                    finishedAt,
                    "skipped",
                    outcome.detail ?? null,
                );
                cb?.onSkipped?.(due.config.task, outcome.detail);
            } else if (outcome.status === "completed") {
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
                recordTransientFailure(
                    db,
                    projectIdentity,
                    due,
                    finishedAt,
                    outcome.error ?? null,
                    outcome.schedulePatch,
                );
                cb?.onFailed?.(due.config.task, outcome.failureDetail ?? outcome.error);
            } else {
                advanceAfterRun(
                    db,
                    projectIdentity,
                    due,
                    finishedAt,
                    "failed",
                    outcome.error ?? null,
                    outcome.schedulePatch,
                );
                cb?.onFailed?.(due.config.task, outcome.failureDetail ?? outcome.error);
            }
        }
    } finally {
        releaseLease(db, holderId, leaseKey);
    }
}

export interface ManualRunResult {
    /** Tasks that completed work (gate passed, lease acquired), excluding unavailable runs. */
    ran: string[];
    /** Tasks that were skipped because their activity gate failed. */
    skippedNoWork: string[];
    /** Tasks unavailable or disabled, with their explicit skip reasons. */
    skipped?: string[];
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

    if (!isUsableProjectIdentity(deps.projectIdentity)) return result;
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

    // Seed rows for tasks that have input. A forced run of a task without a row
    // still records its outcome: the completion and failure writes create the
    // row when it is missing.
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
            promotionThreshold:
                d.config.promotionThreshold ??
                (d.config.task === "promote-primers"
                    ? DREAM_TASK_PROMOTION_DEFAULTS["promote-primers"]
                    : DREAM_TASK_PROMOTION_DEFAULTS["review-user-memories"]),
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
                onSkipped: (task, reason) =>
                    (result.skipped ??= []).push(`${task}: ${reason ?? "unavailable"}`),
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
    // A blank identity is an unresolved directory, not a project; running tasks
    // for it would read and write project-scoped rows under the key "".
    if (!isUsableProjectIdentity(deps.projectIdentity)) return 0;
    // Project memory is off for this caller: schedule nothing and leave the
    // rows alone. A `git:` identity is shared by every worktree and host of the
    // repository, and one with memory on keeps using those rows and the progress
    // they record (retrospective watermark, open verify-broad cycle, curate
    // rotation). An identity with no memories and nothing else to do loses its
    // rows to the daily idle prune instead.
    if (deps.projectMemoryEnabled === false) return 0;
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
            promotionThreshold:
                d.config.promotionThreshold ??
                (d.config.task === "promote-primers"
                    ? DREAM_TASK_PROMOTION_DEFAULTS["promote-primers"]
                    : DREAM_TASK_PROMOTION_DEFAULTS["review-user-memories"]),
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
