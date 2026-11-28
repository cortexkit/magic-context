/**
 * In-memory migration of the legacy v1 dreamer config shape to the Dreamer v2
 * per-task shape (shared OpenCode + Pi; runs on every config load, like
 * migrate-experimental). Doctor performs the on-disk equivalent.
 *
 * v1 shape (any subset):
 *   dreamer: {
 *     schedule: "02:00-06:00",            // a TIME WINDOW
 *     tasks: ["consolidate","verify"],    // an ARRAY of agentic task names
 *     task_timeout_minutes: 20,
 *     max_runtime_minutes: 120,
 *     user_memories: { enabled, promotion_threshold },
 *     pin_key_files: { enabled, token_budget, min_reads },
 *   }
 *
 * v2 shape:
 *   dreamer: {
 *     tasks: { <task>: { schedule: "<cron>"|"", model?, timeout_minutes?, ... } }
 *   }
 *
 * Rules (see dreamer-v2-AB-spec.md):
 *  - Base cron derived from the WINDOW START: "02:00-06:00" → "0 2 * * *".
 *  - Legacy `tasks` array PRESENT → it is the user's deliberate selection: each
 *    LISTED agentic task gets the base cron; each OMITTED canonical task gets ""
 *    (disabled). Built-in defaults are used ONLY when `tasks` is absent.
 *  - user_memories.enabled false → review-user-memories "" ; true → base cron
 *    (promotion_threshold carried). A legacy pin_key_files block is dropped
 *    (key-files pinning moved out of Magic Context).
 *  - classify-memories is NEW in v2 and defaults ON daily at 06:00, unless the
 *    whole dreamer block is disabled.
 *  - evaluate-smart-notes → base cron (it always ran on pending notes).
 *  - task_timeout_minutes → each task's timeout_minutes default; max_runtime_minutes dropped.
 *  - Object-shaped A+B configs carrying retired memory task keys are folded into
 *    verify + curate before schema parsing strips unknown keys.
 */

import {
    CANONICAL_DREAM_TASKS,
    isCanonicalDreamTask,
} from "../features/magic-context/dreamer/task-registry";
import { parseJsoncRecovering } from "../shared/jsonc-parser";

const OLD_VERIFY_TASK = "verify";
const OLD_CURATE_TASKS = ["consolidate", "archive-stale", "improve"] as const;
const RETIRED_OBJECT_MEMORY_TASKS = ["maintain-memory", ...OLD_CURATE_TASKS] as const;
const CANONICAL = [
    "map-memories",
    "verify",
    "verify-broad",
    "curate",
    "classify-memories",
    "retrospective",
    "maintain-docs",
    "evaluate-smart-notes",
    "review-user-memories",
    "promote-primers",
    "refresh-primers",
] as const;
const DEFAULT_BASE_CRON = "0 2 * * *"; // matches the historical "02:00-06:00" default window start
const DEFAULT_CLASSIFY_CRON = "0 6 * * *";
const DEFAULT_RETROSPECTIVE_CRON = "0 5 * * *";
const DEFAULT_VERIFY_BROAD_CRON = "0 4 * * 0"; // weekly — replaces the old broad_interval_days cadence

/** "02:00-06:00" → "0 2 * * *". Falls back to the default base cron on any
 *  unparseable window (never throws — config migration is fail-open). */
function windowToCron(schedule: unknown): string {
    if (typeof schedule !== "string") return DEFAULT_BASE_CRON;
    const m = /^(\d{1,2}):(\d{2})\s*-/.exec(schedule.trim());
    if (!m) return DEFAULT_BASE_CRON;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour >= 24 || minute >= 60) return DEFAULT_BASE_CRON;
    return `${minute} ${hour} * * *`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

export function unknownDreamTaskWarnings(
    config: Record<string, unknown>,
    authoredText: string,
): string[] {
    const tasks = asObject(asObject(config.dreamer)?.tasks);
    if (!tasks) return [];
    const unknown = Object.keys(tasks).filter(
        (key) =>
            !isCanonicalDreamTask(key) &&
            key !== "key-files" &&
            !(RETIRED_OBJECT_MEMORY_TASKS as readonly string[]).includes(key),
    );
    if (unknown.length === 0) return [];

    // Name only keys that appear in the file before substitution. Expanded keys
    // can contain secrets, and multiple authored keys can expand to the same key.
    const authored = asObject(parseJsoncRecovering(authoredText).value);
    const authoredTasks = asObject(asObject(authored?.dreamer)?.tasks);
    const valid = `Valid task names: ${CANONICAL_DREAM_TASKS.join(", ")}.`;
    const warnings: string[] = [];
    let expandedUnknown = false;
    for (const name of unknown) {
        if (authoredTasks && Object.hasOwn(authoredTasks, name)) {
            warnings.push(
                `${JSON.stringify(`dreamer.tasks.${name}`)}: unknown task name, ignoring. ${valid}`,
            );
        } else {
            expandedUnknown = true;
        }
    }
    if (expandedUnknown) {
        warnings.push(`a nightly task name from variable expansion is unknown, ignoring. ${valid}`);
    }
    return warnings;
}

function cronIntervalScore(schedule: string): number {
    const parts = schedule.trim().split(/\s+/);
    if (parts.length !== 5) return Number.POSITIVE_INFINITY;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    if (month !== "*") return 366 * 24 * 60;
    if (dayOfMonth !== "*") return 31 * 24 * 60;
    if (dayOfWeek !== "*") return 7 * 24 * 60;
    const everyHour = /^\*\/(\d+)$/.exec(hour ?? "");
    if (everyHour) return Math.max(1, Number(everyHour[1])) * 60;
    if (hour === "*") {
        const everyMinute = /^\*\/(\d+)$/.exec(minute ?? "");
        return everyMinute ? Math.max(1, Number(everyMinute[1])) : 60;
    }
    return 24 * 60;
}

function mostFrequentSchedule(schedules: string[]): string {
    const enabled = schedules.map((s) => s.trim()).filter(Boolean);
    if (enabled.length === 0) return "";
    return enabled.sort((a, b) => cronIntervalScore(a) - cronIntervalScore(b))[0] ?? "";
}

function withoutBroadInterval(entry: Record<string, unknown>): Record<string, unknown> {
    const { broad_interval_days: _broad, ...rest } = entry;
    return rest;
}

/** Surgical reconcile for an already-v2 tasks-object config (no legacy keys):
 *  backfill `verify-broad` (coupled to verify's enabled state) and strip the
 *  dead `broad_interval_days` from every task. Returns rawConfig UNCHANGED when
 *  nothing needs touching (so an already-reconciled config is a stable no-op /
 *  idempotent). */
function reconcileV2TasksObject(
    rawConfig: Record<string, unknown>,
    dreamer: Record<string, unknown>,
    tasksObject: Record<string, unknown>,
): Record<string, unknown> {
    const hasVerifyBroad = "verify-broad" in tasksObject;
    const hasBroadIntervalAnywhere = Object.values(tasksObject).some(
        (v) => asObject(v) && "broad_interval_days" in (v as Record<string, unknown>),
    );
    // key-files was removed (feature moved to AFT); strip any stale task entry.
    const hasStaleKeyFiles = "key-files" in tasksObject;
    if (hasVerifyBroad && !hasBroadIntervalAnywhere && !hasStaleKeyFiles) return rawConfig;

    const nextTasks: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(tasksObject)) {
        if (key === "key-files") continue;
        const obj = asObject(value);
        nextTasks[key] = obj ? withoutBroadInterval(obj) : value;
    }
    if (!hasVerifyBroad) {
        const verify = asObject(tasksObject.verify);
        const verifyEnabled = typeof verify?.schedule === "string" && verify.schedule.trim() !== "";
        nextTasks["verify-broad"] = {
            schedule: verifyEnabled ? DEFAULT_VERIFY_BROAD_CRON : "",
        };
    }
    return { ...rawConfig, dreamer: { ...dreamer, tasks: nextTasks } };
}

export function migrateDreamerV2(
    rawConfig: Record<string, unknown>,
    warnings: string[],
): Record<string, unknown> {
    const dreamer = asObject(rawConfig.dreamer);
    if (!dreamer) return rawConfig;

    const tasksObject = asObject(dreamer.tasks);
    const hasRetiredObjectTasks = tasksObject
        ? RETIRED_OBJECT_MEMORY_TASKS.some((task) => task in tasksObject)
        : false;

    if (tasksObject && !hasRetiredObjectTasks) {
        const hasLegacyOutsideTasks =
            "schedule" in dreamer ||
            "user_memories" in dreamer ||
            "pin_key_files" in dreamer ||
            "task_timeout_minutes" in dreamer ||
            "max_runtime_minutes" in dreamer;
        if (!hasLegacyOutsideTasks) {
            // Already a v2 tasks-object, no legacy keys → only a SURGICAL touch-up
            // is needed (don't reshape an otherwise-valid config): add a
            // `verify-broad` task coupled to verify's enabled state, and strip the
            // dead `broad_interval_days` knob. Without this, a user who DISABLED
            // verify but never wrote verify-broad gets Zod's default `0 4 * * 0`
            // and unintended weekly full-pool LLM verification.
            return reconcileV2TasksObject(rawConfig, dreamer, tasksObject);
        }
    }

    // Nothing legacy to migrate (no window/array/blocks) → leave as-is; the
    // schema default fills `tasks`.
    const hasLegacy =
        "schedule" in dreamer ||
        Array.isArray(dreamer.tasks) ||
        hasRetiredObjectTasks ||
        "user_memories" in dreamer ||
        "pin_key_files" in dreamer ||
        "task_timeout_minutes" in dreamer ||
        "max_runtime_minutes" in dreamer;
    if (!hasLegacy) return rawConfig;

    const baseCron = windowToCron(dreamer.schedule);
    const timeout =
        typeof dreamer.task_timeout_minutes === "number" ? dreamer.task_timeout_minutes : undefined;
    const withTimeout = <T extends Record<string, unknown>>(entry: T): T =>
        timeout !== undefined ? { ...entry, timeout_minutes: timeout } : entry;
    const classifySchedule = dreamer.disable === true ? "" : DEFAULT_CLASSIFY_CRON;
    const retrospectiveSchedule = dreamer.disable === true ? "" : DEFAULT_RETROSPECTIVE_CRON;

    const tasks: Record<string, Record<string, unknown>> = {};

    if (tasksObject) {
        for (const [key, value] of Object.entries(tasksObject)) {
            if ((RETIRED_OBJECT_MEMORY_TASKS as readonly string[]).includes(key)) continue;
            if (asObject(value)) tasks[key] = { ...(value as Record<string, unknown>) };
        }
        const maintainMemoryEntry = asObject(tasksObject["maintain-memory"]);
        if (maintainMemoryEntry) {
            const schedule =
                typeof maintainMemoryEntry.schedule === "string"
                    ? maintainMemoryEntry.schedule
                    : baseCron;
            tasks.verify = withTimeout({
                ...withoutBroadInterval(maintainMemoryEntry),
                ...(tasks.verify ?? {}),
                schedule: tasks.verify?.schedule ?? schedule,
            });
            tasks.curate = withTimeout({
                ...withoutBroadInterval(maintainMemoryEntry),
                ...(tasks.curate ?? {}),
                schedule: tasks.curate?.schedule ?? schedule,
            });
        }

        const oldVerifyEntry = asObject(tasksObject[OLD_VERIFY_TASK]);
        if (oldVerifyEntry) {
            tasks.verify = withTimeout({
                ...withoutBroadInterval(oldVerifyEntry),
                ...(tasks.verify ?? {}),
                schedule:
                    tasks.verify?.schedule ??
                    (typeof oldVerifyEntry.schedule === "string"
                        ? oldVerifyEntry.schedule
                        : baseCron),
            });
        }

        // The old internal broad cadence becomes its own task. If verify is
        // enabled (broad used to run inside it), default verify-broad ON weekly;
        // if verify is disabled, leave verify-broad disabled.
        if (!tasks["verify-broad"]) {
            const verifyEnabled =
                typeof tasks.verify?.schedule === "string" && tasks.verify.schedule.trim() !== "";
            tasks["verify-broad"] = withTimeout({
                schedule: verifyEnabled ? DEFAULT_VERIFY_BROAD_CRON : "",
            });
        }

        const oldCurateEntries = OLD_CURATE_TASKS.map((task) => asObject(tasksObject[task])).filter(
            (entry): entry is Record<string, unknown> => Boolean(entry),
        );
        if (oldCurateEntries.length > 0) {
            const oldSchedules = oldCurateEntries.map((entry) =>
                typeof entry.schedule === "string" ? entry.schedule : baseCron,
            );
            tasks.curate = withTimeout({
                ...(tasks.curate ?? {}),
                schedule: mostFrequentSchedule(oldSchedules),
            });
        }

        for (const task of CANONICAL) {
            if (!tasks[task]) {
                const schedule =
                    task === "verify" || task === "curate" || task === "verify-broad"
                        ? ""
                        : task === "classify-memories"
                          ? classifySchedule
                          : task === "retrospective"
                            ? retrospectiveSchedule
                            : task === "maintain-docs"
                              ? ""
                              : baseCron;
                tasks[task] = withTimeout({ schedule });
            }
        }
    } else {
        // Agentic memory maintenance: array present → old verify enables verify,
        // old consolidate/improve/archive-stale enable curate; array absent →
        // historical default suite on.
        const legacyArray = Array.isArray(dreamer.tasks)
            ? (dreamer.tasks as unknown[]).filter((t): t is string => typeof t === "string")
            : null;
        const verifySelected = legacyArray ? legacyArray.includes(OLD_VERIFY_TASK) : true;
        const curateSelected = legacyArray
            ? legacyArray.some((task) => (OLD_CURATE_TASKS as readonly string[]).includes(task))
            : true;
        tasks.verify = withTimeout({
            schedule: verifySelected ? baseCron : "",
        });
        tasks["verify-broad"] = withTimeout({
            schedule: verifySelected ? DEFAULT_VERIFY_BROAD_CRON : "",
        });
        tasks.curate = withTimeout({
            schedule: curateSelected ? baseCron : "",
        });
        tasks["classify-memories"] = withTimeout({
            schedule: classifySchedule,
        });
        tasks.retrospective = withTimeout({
            schedule: retrospectiveSchedule,
        });
        tasks["maintain-docs"] = withTimeout({
            schedule: legacyArray?.includes("maintain-docs") ? baseCron : "",
        });
    }

    // map-memories (one-time backfill) defaults on so it prepares verify; gated
    // by "unmapped memories exist", so it drains then no-ops.
    tasks["map-memories"] ??= withTimeout({ schedule: baseCron });

    // evaluate-smart-notes always ran post-suite on pending notes.
    tasks["evaluate-smart-notes"] ??= withTimeout({ schedule: baseCron });

    // review-user-memories ← user_memories block (default enabled in v1).
    const um = asObject(dreamer.user_memories);
    const umEnabled = um ? um.enabled !== false : true;
    if (um || !tasks["review-user-memories"]) {
        tasks["review-user-memories"] = withTimeout({
            ...(tasks["review-user-memories"] ?? {}),
            schedule: umEnabled ? baseCron : "",
            ...(um && typeof um.promotion_threshold === "number"
                ? { promotion_threshold: um.promotion_threshold }
                : {}),
        });
    }

    // key-files was removed (the feature moved to AFT's dreamer): any legacy
    // pin_key_files block is simply dropped below with the other retired keys —
    // no key-files task is emitted.

    // Build the new dreamer block: keep agent-config keys (model, disable, etc.),
    // drop the retired scheduling keys, add the tasks record.
    const {
        schedule: _schedule,
        tasks: _tasks,
        task_timeout_minutes: _tto,
        max_runtime_minutes: _max,
        user_memories: _um,
        pin_key_files: _pkf,
        ...rest
    } = dreamer;

    warnings.push(
        'Migrated legacy dreamer scheduling (schedule window / tasks array / user_memories / pin_key_files) → per-task "dreamer.tasks" in-memory (run `doctor` to persist).',
    );

    return { ...rawConfig, dreamer: { ...rest, tasks } };
}
