/**
 * Canonical Dreamer v2 task registry (pure — no DB imports, so the config schema
 * can import the task names without pulling runtime code).
 *
 * v2 promotes the former post-phases (review-user-memories, key-files,
 * evaluate-smart-notes) to first-class scheduled tasks alongside the agentic
 * maintenance tasks, and assigns each a LEASE DOMAIN so disjoint-state tasks run
 * concurrently while memory-mutating tasks serialize. See lease.ts + the A+B spec.
 */

import type { CurateMemoryCategory } from "./curate-category-rotation";

export const CANONICAL_DREAM_TASKS = [
    // map-memories runs BEFORE verify (it records the file mappings verify gates
    // on) and shares the memory lease, so it leads the canonical order.
    "map-memories",
    "verify",
    "verify-broad",
    "curate",
    "compress-cues",
    "classify-memories",
    "retrospective",
    "maintain-docs",
    "evaluate-smart-notes",
    "review-user-memories",
    "promote-primers",
    "refresh-primers",
] as const;

export type DreamTaskName = (typeof CANONICAL_DREAM_TASKS)[number];

/** Classification needs a live pool large enough to score memories relative to one another. */
export const MIN_POOL_TO_CLASSIFY = 10;

export function availableDreamTasks(smartNotesEnabled = true): DreamTaskName[] {
    return CANONICAL_DREAM_TASKS.filter(
        (task) => smartNotesEnabled || task !== "evaluate-smart-notes",
    );
}

/** Prompt-token ceilings leave headroom for repeated tool-loop prompt sends.
 * Completed Gemini run usage predicts 20-memory mapping/verification batches
 * at about 70% of their ceiling; curate and other tasks retain
 * their separate allowances. */
export const DREAM_TOOL_LOOP_TOKEN_BUDGETS = {
    "map-memories": 2_500_000,
    verify: 2_500_000,
    "verify-broad": 3_000_000,
    curate: 1_500_000,
    retrospective: 300_000,
    "maintain-docs": 1_600_000,
    "refresh-primers": 350_000,
} as const;

/**
 * How a Dreamer task reaches its result, which is what decides whether a host
 * without a tool loop can run it:
 *  - "tool-loop": the task drives an agent that must call tools between model
 *    turns (reading files, searching, writing memories through `ctx_memory`).
 *  - "single-shot": one or more no-tool completions whose entire answer is the
 *    returned text. Any transport that can deliver a prompt and return text runs
 *    these, including a hidden completion carrier.
 *  - "host-only": no model call at all. The task is database work done in this
 *    process, so it needs no completion transport whatsoever.
 */
export type DreamTaskTransport = "tool-loop" | "single-shot" | "host-only";

export interface DreamTaskCapability {
    /** True only when the task cannot finish without a tool loop. */
    requiresTools: boolean;
    transport: DreamTaskTransport;
    /**
     * What the tool loop is needed FOR, as one clause a user can read. Present
     * only on tool-loop tasks, where it becomes the named per-task reason shown
     * when a host refuses the task instead of a single anonymous "filtered" list.
     */
    toolLoopPurpose?: string;
}

export const DREAM_TASK_CAPABILITIES: Record<DreamTaskName, DreamTaskCapability> = {
    // A single manifest is not a tool-free task: mapping and verification need
    // read-only tools to inspect backing code before they can change memory state.
    "map-memories": {
        requiresTools: true,
        transport: "tool-loop",
        toolLoopPurpose: "needs read-only file tools to locate the code each memory describes",
    },
    verify: {
        requiresTools: true,
        transport: "tool-loop",
        toolLoopPurpose: "needs read-only file tools to re-check each memory against the code",
    },
    "verify-broad": {
        requiresTools: true,
        transport: "tool-loop",
        toolLoopPurpose: "needs read-only file tools to re-check each memory against the code",
    },
    curate: {
        requiresTools: true,
        transport: "tool-loop",
        toolLoopPurpose: "needs the ctx_memory tool to apply its merge and archive decisions",
    },
    // mural/compress-cues.ts is a zero-tool transform; its child transport
    // still needs substitution before the generate executor can dispatch it.
    "compress-cues": { requiresTools: false, transport: "single-shot" },
    "classify-memories": { requiresTools: false, transport: "single-shot" },
    retrospective: {
        requiresTools: true,
        transport: "tool-loop",
        toolLoopPurpose: "needs search tools to investigate the friction it finds in past sessions",
    },
    "maintain-docs": {
        requiresTools: true,
        transport: "tool-loop",
        toolLoopPurpose: "needs read-only file tools to investigate documentation corrections",
    },
    // The evaluator is a no-tool compiler plus a no-tool confirmation prompt; the
    // generated check runs in the local capability sandbox, never as model tools.
    "evaluate-smart-notes": { requiresTools: false, transport: "single-shot" },
    // The reviewer reads candidate text and answers with JSON; the host applies it.
    "review-user-memories": { requiresTools: false, transport: "single-shot" },
    // Promotion clusters existing candidates and writes rows. It calls no model.
    "promote-primers": { requiresTools: false, transport: "host-only" },
    "refresh-primers": {
        requiresTools: true,
        transport: "tool-loop",
        toolLoopPurpose: "needs read-only investigation tools to answer each standing question",
    },
};

/** Tasks a host without a tool loop cannot run, in canonical order. */
export function toolLoopDreamTasks(): DreamTaskName[] {
    return CANONICAL_DREAM_TASKS.filter((task) => DREAM_TASK_CAPABILITIES[task].requiresTools);
}

/**
 * One line per refused task, naming the task, the stable code and what the tool
 * loop is needed for. A user reading /ctx-dream or /ctx-status output should be
 * able to tell which specific task is unavailable and why, rather than seeing a
 * single anonymous "unsupported" list.
 */
export function formatUnsupportedDreamTasks(tasks: readonly DreamTaskName[], code: string): string {
    return tasks
        .map((task) => {
            const purpose = DREAM_TASK_CAPABILITIES[task].toolLoopPurpose;
            return `- ${task}: unavailable on this host (${code})${purpose ? ` — ${purpose}` : ""}`;
        })
        .join("\n");
}

/** Cheap, read-only work counts for one Dreamer task. */
export interface DreamTaskBacklog {
    /** Items selected by the task's current backlog predicate. */
    pending: number;
    /** Total items in the task's candidate pool. */
    total: number;
    /** Curate's one-category scope for this run/window. */
    category?: CurateMemoryCategory;
}

/** Backlog counts keyed by canonical task name. */
export type DreamTaskBacklogMap = Partial<Record<DreamTaskName, DreamTaskBacklog>>;

/** Stable human-readable rendering shared by /ctx-dream and status surfaces. */
export function formatDreamTaskBacklogs(
    backlogs: DreamTaskBacklogMap,
    tasks: readonly DreamTaskName[] = CANONICAL_DREAM_TASKS,
): string {
    return tasks
        .filter((task) => backlogs[task] !== undefined)
        .map((task) => {
            const backlog = backlogs[task];
            if (task === "curate" && backlog?.category) {
                return `- curate: ${backlog.category} (${backlog.pending})`;
            }
            return `- ${task}: ${backlog?.pending ?? 0} pending / ${backlog?.total ?? 0} total`;
        })
        .join("\n");
}

/** One dreamer task whose last scheduled run failed. */
export interface DreamTaskFailureState {
    task: string;
    /** The scheduler's recorded failure text. */
    error: string;
    /** Epoch ms of the last run that SUCCEEDED, or null if none ever has. A failed run
     *  never advances `last_run_at`, so this says how long the task has been stuck, not
     *  when it last failed — the scheduler keeps no failure timestamp. */
    lastSucceededAt: number | null;
    /** Consecutive retries queued so far; reset once the retry cap pushes the task to
     *  its next cron slot, so a long-running failure oscillates rather than climbs. */
    retryCount: number;
}

/** How much of a scheduler failure message a status line carries before eliding. */
const FAILURE_TEXT_BUDGET = 180;

function sinceLabel(lastSucceededAt: number | null, now: number): string {
    if (lastSucceededAt === null || lastSucceededAt <= 0) return "never succeeded";
    const hours = Math.max(0, Math.floor((now - lastSucceededAt) / 3_600_000));
    if (hours < 1) return "last succeeded under an hour ago";
    if (hours < 48) return `last succeeded ${hours}h ago`;
    return `last succeeded ${Math.floor(hours / 24)}d ago`;
}

/**
 * One line per failing task, shared by the status surfaces.
 *
 * The elapsed time is measured from the last SUCCESS, not the last failure: a failed
 * run deliberately does not advance `last_run_at`, so that is the only timestamp the
 * scheduler keeps and "stuck since" is what a reader needs anyway.
 */
export function formatDreamTaskFailures(
    failures: readonly DreamTaskFailureState[],
    now: number = Date.now(),
): string {
    return failures
        .map((failure) => {
            const error =
                failure.error.length > FAILURE_TEXT_BUDGET
                    ? `${failure.error.slice(0, FAILURE_TEXT_BUDGET)}…`
                    : failure.error;
            return `- ${failure.task}: failing (${sinceLabel(failure.lastSucceededAt, now)}) — ${error}`;
        })
        .join("\n");
}

/** Process-local progress for the task currently applying a run chunk. */
export interface DreamTaskProgress {
    task: DreamTaskName;
    processed: number;
    total: number;
    startedAt: number;
    /** Curate's one-category scope. */
    category?: CurateMemoryCategory;
    /** Update/archive verdicts refused by host-side verification safety gates during the current run. */
    refused?: number;
}

/** Persisted per-task run counts used by dream-run history and summaries. */
export interface DreamTaskRunBacklog {
    pendingAtStart: number;
    totalAtStart: number;
    pendingAtEnd: number;
    totalAtEnd: number;
    processed: number;
    category?: CurateMemoryCategory;
}

/** Use the decrease in the persisted backlog between the start and end snapshots as the per-run progress count, clamped to zero when the backlog does not decrease. */
export function processedDreamTaskItems(startPending: number, endPending: number): number {
    return Math.max(0, startPending - endPending);
}

/**
 * The agentic tasks — those run as a generic dreamer agent session driven by
 * `buildDreamTaskPrompt`. The other canonical tasks (map-memories, verify,
 * verify-broad, classify-memories, review-user-memories, evaluate-smart-notes,
 * primers, retrospective) have their own specialized runners and do NOT go
 * through the prompt builder.
 */
export const AGENTIC_DREAM_TASKS = ["curate", "maintain-docs"] as const;

/**
 * Tasks that read-modify-write the project `memories` table (+ epoch +
 * supersede-delta rows). They SHARE one per-project "memory" lease so they
 * serialize with each other — concurrent runs race semantically (stale-view
 * merges/splits). Canonical run order when several are due in one drain.
 */
export const MEMORY_DOMAIN_TASKS: readonly DreamTaskName[] = [
    "map-memories",
    "verify",
    "verify-broad",
    "curate",
    "compress-cues",
    "classify-memories",
    "retrospective",
    "promote-primers",
    "refresh-primers",
];

const MEMORY_DOMAIN_SET = new Set<DreamTaskName>(MEMORY_DOMAIN_TASKS);

/**
 * The dreamer tasks that maintain project memory or knowledge derived from it
 * (primers grow out of the same sessions and live beside the memories). They
 * run only while `memory.enabled` is true. Every other task serves a different
 * setting and runs with memory off:
 *  - evaluate-smart-notes follows `smart_notes.enabled`;
 *  - review-user-memories follows user-observation collection, which is on
 *    exactly when the review is scheduled and the dreamer is runnable, so
 *    observations are collected exactly when they will be reviewed;
 *  - maintain-docs needs only a runnable dreamer.
 * A runnable dreamer is the precondition for any scheduler call at all.
 */
export const PROJECT_MEMORY_DREAM_TASKS: readonly DreamTaskName[] = [
    "map-memories",
    "verify",
    "verify-broad",
    "curate",
    "compress-cues",
    "classify-memories",
    "retrospective",
    "promote-primers",
    "refresh-primers",
];

const PROJECT_MEMORY_DREAM_TASK_SET = new Set<DreamTaskName>(PROJECT_MEMORY_DREAM_TASKS);

/**
 * Whether the per-project settings let this task run. `memory.enabled` gates
 * only the project-memory tasks and `smart_notes.enabled` only
 * evaluate-smart-notes; an omitted setting counts as on.
 */
export function dreamTaskAllowedBySettings(
    task: DreamTaskName,
    settings: { projectMemoryEnabled?: boolean; smartNotesEnabled?: boolean },
): boolean {
    if (PROJECT_MEMORY_DREAM_TASK_SET.has(task)) return settings.projectMemoryEnabled !== false;
    if (task === "evaluate-smart-notes") return settings.smartNotesEnabled !== false;
    return true;
}

/**
 * Lease KIND per task. `memory` + the three independent kinds are per-project;
 * `user-memories` is GLOBAL (mutates the cross-project user-profile pool, so two
 * different projects' dreamers must not review concurrently).
 */
export type LeaseKind = "memory" | "maintain-docs" | "evaluate-smart-notes" | "user-memories";

export function leaseKindFor(task: DreamTaskName): LeaseKind {
    if (MEMORY_DOMAIN_SET.has(task)) return "memory";
    switch (task) {
        case "review-user-memories":
            return "user-memories";
        case "promote-primers":
        case "refresh-primers":
            return "memory";
        case "maintain-docs":
            return "maintain-docs";
        case "evaluate-smart-notes":
            return "evaluate-smart-notes";
        default:
            // Memory-domain tasks already returned above; this is unreachable.
            return "memory";
    }
}

/**
 * Resolve the concrete lease key for a task in a project. The global
 * `user-memories` lease is NOT project-scoped (one reviewer across all projects);
 * every other domain is keyed by project so different projects never block.
 */
export function leaseKeyFor(task: DreamTaskName, projectIdentity: string): string {
    const kind = leaseKindFor(task);
    return kind === "user-memories" ? "user-memories" : `${kind}:${projectIdentity}`;
}

export function isCanonicalDreamTask(value: string): value is DreamTaskName {
    return (CANONICAL_DREAM_TASKS as readonly string[]).includes(value);
}

/**
 * Stable canonical ordering used when multiple due tasks share a lease domain
 * (preserves the suite order for the memory domain).
 */
export function compareTaskOrder(a: DreamTaskName, b: DreamTaskName): number {
    return CANONICAL_DREAM_TASKS.indexOf(a) - CANONICAL_DREAM_TASKS.indexOf(b);
}
