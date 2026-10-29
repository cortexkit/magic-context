import { DREAM_TASK_PROMOTION_DEFAULTS } from "../../../config/schema/magic-context";
import type { Database, Statement } from "../../../shared/sqlite";
import { isKnownAutocommit } from "../../../shared/sqlite-helpers";
import { hasMemoryClassifiedAtColumn } from "../memory/storage-memory";
import { hasMuralCueColumns } from "../mural/storage-mural-cues";
import {
    getSmartNotesNeedingCompilation,
    getStaleCompiledSmartNotes,
} from "../smart-notes/storage";
import { getPendingSmartNotes } from "../storage-notes";
import { countPrimerCandidatesForProject, getActivePrimers } from "../storage-primers";
import { getUserMemoryCandidates } from "../user-memory/storage-user-memory";
import { peekCurateCategoryScope } from "./curate-category-rotation";
import { getTaskScheduleState } from "./storage-task-schedule";
import {
    CANONICAL_DREAM_TASKS,
    type DreamTaskBacklog,
    type DreamTaskBacklogMap,
    type DreamTaskName,
} from "./task-registry";

/**
 * Per-task activity gates (Dreamer v2 A+B). A due task runs ONLY if its gate
 * passes, so cron cadence never burns a 60-turn agentic loop on an unchanged
 * pool. Gates are conservative — allow when uncertain — and cheap (count
 * queries, no full-row loads, no LLM).
 *
 * `lastRunAt` is the task's own `task_schedule_state.last_run_at` (null = never
 * run → treat "changed since" gates as "is there anything at all").
 */

export interface TaskGateContext {
    db: Database;
    projectIdentity: string;
    lastRunAt: number | null;
    /** retrospective content watermark (max message ts scanned). Distinct from
     *  lastRunAt: a session updated mid-run is newer than its scanned content but
     *  older than the run-completion time, so gating on lastRunAt would skip it. */
    retrospectiveWatermarkMs?: number | null;
    /** review-user-memories: min candidate observations before a review is worthwhile. */
    promotionThreshold: number;
}

/** Raw status count used only to let curate transition expired active rows. */
export function countActiveMemories(db: Database, projectPath: string): number {
    const row = db
        .prepare<[string], { cnt: number }>(
            "SELECT COUNT(*) AS cnt FROM memories WHERE project_path = ? AND status IN ('active','permanent')",
        )
        .get(projectPath);
    return row?.cnt ?? 0;
}

/** Count the same live active/permanent pool loaded by getMemoriesByProject. */
export function countLiveMemories(
    db: Database,
    projectPath: string,
    options: { unclassifiedOnly?: boolean; category?: string } = {},
): number {
    const unclassified = options.unclassifiedOnly && hasMemoryClassifiedAtColumn(db);
    const sql = `SELECT COUNT(*) AS cnt
                   FROM memories
                  WHERE project_path = ?
                    AND status IN ('active','permanent')
                    AND (expires_at IS NULL OR expires_at > ?)
                    ${unclassified ? "AND classified_at IS NULL" : ""}`;
    const row = options.category
        ? db
              .prepare<[string, number, string], { cnt: number }>(`${sql} AND category = ?`)
              .get(projectPath, Date.now(), options.category)
        : db.prepare<[string, number], { cnt: number }>(sql).get(projectPath, Date.now());
    return row?.cnt ?? 0;
}

/** Live active/permanent memories with NO mapping row yet — the map-memories scope. */
export function countUnmappedActiveMemories(db: Database, projectPath: string): number {
    const row = db
        .prepare<[string, number], { cnt: number }>(
            `SELECT COUNT(*) AS cnt
               FROM memories m
              WHERE m.project_path = ?
                AND m.status IN ('active','permanent')
                AND (m.expires_at IS NULL OR m.expires_at > ?)
                AND NOT EXISTS (
                    SELECT 1 FROM memory_verifications v WHERE v.memory_id = m.id
                )`,
        )
        .get(projectPath, Date.now());
    return row?.cnt ?? 0;
}

export function countCompartmentsSince(db: Database, projectPath: string, since: number): number {
    // Compartments are keyed by session_id; map to project via session_projects.
    const row = db
        .prepare<[string, number], { cnt: number }>(
            `SELECT COUNT(*) AS cnt
               FROM compartments c
               JOIN session_projects sp ON sp.session_id = c.session_id
              WHERE sp.project_path = ? AND c.created_at > ?`,
        )
        .get(projectPath, since);
    return row?.cnt ?? 0;
}

export function countProjectSessionsSince(
    db: Database,
    projectPath: string,
    since: number | null,
): number {
    // Host events provide precise message timestamps, but SDK bridges may only
    // maintain the message index. Fall back per session to its indexing time,
    // not the project binding time (which changes without new messages). Keep
    // the ledger authoritative so reindexing old Pi history does not reopen work.
    const row =
        since === null
            ? db
                  .prepare<[string], { cnt: number }>(
                      "SELECT COUNT(*) AS cnt FROM session_projects WHERE project_path = ?",
                  )
                  .get(projectPath)
            : db
                  .prepare<[string, number], { cnt: number }>(
                      `SELECT COUNT(*) AS cnt FROM session_projects sp
                        LEFT JOIN schema_migrations_meta activity
                          ON activity.key = 'retrospective_activity:' || sp.session_id
                        LEFT JOIN message_history_index history ON history.session_id = sp.session_id
                       WHERE sp.project_path = ?
                         AND COALESCE(CAST(activity.value AS INTEGER), history.updated_at) > ?`,
                  )
                  .get(projectPath, since);
    return row?.cnt ?? 0;
}

function countMappedMemories(db: Database, projectPath: string): number {
    const row = db
        .prepare<[string, number], { cnt: number }>(
            `SELECT COUNT(DISTINCT m.id) AS cnt
               FROM memories m
               JOIN memory_verifications v ON v.memory_id = m.id
              WHERE m.project_path = ?
                AND m.status IN ('active','permanent')
                AND (m.expires_at IS NULL OR m.expires_at > ?)
                AND v.file_path <> ''`,
        )
        .get(projectPath, Date.now());
    return row?.cnt ?? 0;
}

function countUnverifiedMappedMemories(db: Database, projectPath: string): number {
    const row = db
        .prepare<[string, number], { cnt: number }>(
            `SELECT COUNT(DISTINCT m.id) AS cnt
               FROM memories m
               JOIN memory_verifications v ON v.memory_id = m.id
              WHERE m.project_path = ?
                AND m.status IN ('active','permanent')
                AND (m.expires_at IS NULL OR m.expires_at > ?)
                AND v.file_path <> ''
                AND v.verified_at = 0`,
        )
        .get(projectPath, Date.now());
    return row?.cnt ?? 0;
}

function countBroadCycleCandidates(
    db: Database,
    projectPath: string,
    cycleStartAt: number,
): number {
    const row = db
        .prepare<[string, number, number], { cnt: number }>(
            `SELECT COUNT(*) AS cnt
               FROM memories m
              WHERE m.project_path = ?
                AND m.status IN ('active','permanent')
                AND (m.expires_at IS NULL OR m.expires_at > ?)
                AND (
                    SELECT MAX(v.verified_at)
                      FROM memory_verifications v
                     WHERE v.memory_id = m.id
                       AND v.file_path <> ''
                ) < ?`,
        )
        .get(projectPath, Date.now(), cycleStartAt);
    return row?.cnt ?? 0;
}

function countCueCandidates(db: Database, projectPath: string): number {
    if (!hasMuralCueColumns(db)) return countLiveMemories(db, projectPath);
    const row = db
        .prepare<[string, number], { cnt: number }>(
            `SELECT COUNT(*) AS cnt
               FROM memories
              WHERE project_path = ?
                AND status IN ('active','permanent')
                AND (expires_at IS NULL OR expires_at > ?)
                AND (mural_cue IS NULL OR mural_cue_hash IS NULL OR updated_at > mural_cue_at)`,
        )
        .get(projectPath, Date.now());
    return row?.cnt ?? 0;
}

function countStalePrimers(db: Database, projectPath: string): number {
    const row = db
        .prepare<[string], { cnt: number }>(
            `SELECT COUNT(*) AS cnt
               FROM primers
              WHERE project_path = ?
                AND status = 'active'
                AND (answer IS NULL OR TRIM(answer) = '' OR answer_refreshed_at IS NULL
                     OR last_observed_at > answer_refreshed_at)`,
        )
        .get(projectPath);
    return row?.cnt ?? 0;
}

function countPendingSmartNotes(db: Database, projectPath: string): number {
    const row = db
        .prepare<[string], { cnt: number }>(
            "SELECT COUNT(*) AS cnt FROM notes WHERE project_path = ? AND type = 'smart' AND status = 'pending'",
        )
        .get(projectPath);
    return row?.cnt ?? 0;
}

function countUserMemoryCandidates(db: Database): number {
    const row = db
        .prepare<[], { cnt: number }>("SELECT COUNT(*) AS cnt FROM user_memory_candidates")
        .get();
    return row?.cnt ?? 0;
}

function countActivePrimers(db: Database, projectPath: string): number {
    const row = db
        .prepare<[string], { cnt: number }>(
            "SELECT COUNT(*) AS cnt FROM primers WHERE project_path = ? AND status = 'active'",
        )
        .get(projectPath);
    return row?.cnt ?? 0;
}

/**
 * How far back session activity and new compartments count as "recent" when
 * deciding whether an identity has anything for the dreamer to do. Older work
 * no longer seeds schedule rows, and an identity whose only inputs are older
 * than this (and that has no memories) is pruned from the schedule.
 */
export const SCHEDULE_ACTIVITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Any active or permanent memory, expired or not (the curate gate's pool). */
export function hasActiveMemories(db: Database, projectPath: string): boolean {
    return (
        db
            .prepare<[string], { one: number }>(
                "SELECT 1 AS one FROM memories WHERE project_path = ? AND status IN ('active','permanent') LIMIT 1",
            )
            .get(projectPath) != null
    );
}

/**
 * Sessions count as recent when they were bound or were active after `since`.
 * A new binding qualifies before its first message is indexed. Older bindings
 * need message activity: prefer the host's precise ledger, falling back to the
 * message index for SDK bridges without host events. This also prevents idle
 * pruning from removing an actively indexed bridge session's schedule.
 */
const RECENT_PROJECT_SESSIONS_SQL = `SELECT sp.session_id FROM session_projects sp
        LEFT JOIN schema_migrations_meta activity
          ON activity.key = 'retrospective_activity:' || sp.session_id
        LEFT JOIN message_history_index history ON history.session_id = sp.session_id
      WHERE sp.project_path = ?
        AND (sp.updated_at > ? OR COALESCE(CAST(activity.value AS INTEGER), history.updated_at) > ?)`;

/** Whether a session of this project was bound or was active after `since`. */
export function hasRecentProjectSession(db: Database, projectPath: string, since: number): boolean {
    return (
        db
            .prepare<[string, number, number], { session_id: string }>(
                `${RECENT_PROJECT_SESSIONS_SQL} LIMIT 1`,
            )
            .get(projectPath, since, since) != null
    );
}

/**
 * Whether a recent session of this project produced a compartment after
 * `since`. Starting from the few recent sessions keeps this cheap: counting a
 * large project's compartments by creation time reads every compartment row.
 */
function hasRecentProjectCompartment(db: Database, projectPath: string, since: number): boolean {
    return (
        db
            .prepare<[string, number, number, number], { session_id: string }>(
                `${RECENT_PROJECT_SESSIONS_SQL}
                    AND EXISTS (SELECT 1 FROM compartments c
                                 WHERE c.session_id = sp.session_id AND c.created_at > ?)
                  LIMIT 1`,
            )
            .get(projectPath, since, since, since) != null
    );
}

/**
 * The input a task needs before it is worth giving a schedule row at all.
 *
 * This is deliberately broader than the per-run activity gate in
 * `evaluateTaskGate`: the gate asks "is there new work since the last run?",
 * while this asks "does this identity have the kind of data this task works on?".
 * A directory that only ever hosted a chat has no memories, so the memory
 * maintenance tasks get no rows for it; they are seeded later, on the first
 * scheduler pass after its first memory appears.
 *
 * Session-derived inputs only count inside SCHEDULE_ACTIVITY_WINDOW_MS, which
 * keeps this consistent with the idle-identity pruning: an identity that pruning
 * removed is never seeded straight back by the next reconcile.
 */
export function taskHasSchedulableInput(
    task: DreamTaskName,
    db: Database,
    projectPath: string,
    now: number,
): boolean {
    switch (task) {
        case "map-memories":
        case "verify":
        case "verify-broad":
        case "curate":
        case "compress-cues":
        case "classify-memories":
            // Raw status, not expiry: curate must still see an expired-only pool
            // once to transition it.
            return hasActiveMemories(db, projectPath);
        case "retrospective":
            return hasRecentProjectSession(db, projectPath, now - SCHEDULE_ACTIVITY_WINDOW_MS);
        case "maintain-docs":
            return hasRecentProjectCompartment(db, projectPath, now - SCHEDULE_ACTIVITY_WINDOW_MS);
        case "evaluate-smart-notes":
            return countPendingSmartNotes(db, projectPath) > 0;
        case "review-user-memories":
            // Candidates are global (one cross-project user profile) and any
            // scheduled identity may review them, so they alone are no reason to
            // schedule an identity that otherwise has nothing to do.
            return (
                countUserMemoryCandidates(db) > 0 && identityHasProjectInput(db, projectPath, now)
            );
        case "promote-primers":
            return countPrimerCandidatesForProject(db, projectPath) > 0;
        case "refresh-primers":
            return countActivePrimers(db, projectPath) > 0;
        default: {
            const _exhaustive: never = task;
            return Boolean(_exhaustive);
        }
    }
}

/**
 * Whether an identity has anything of its own for the dreamer to work on:
 * active memories, a session in the activity window, or input for any
 * project-scoped task. The global user-memory review is left out (see
 * taskHasSchedulableInput). An identity for which this is false is idle and
 * its schedule rows are pruned.
 */
export function identityHasProjectInput(db: Database, projectPath: string, now: number): boolean {
    // Memories and recent sessions are checked first and by name: they are the
    // cheapest signals, and "never prune an identity with memories" must hold
    // even if a memory task's own input rule changes.
    if (hasActiveMemories(db, projectPath)) return true;
    if (hasRecentProjectSession(db, projectPath, now - SCHEDULE_ACTIVITY_WINDOW_MS)) return true;
    return CANONICAL_DREAM_TASKS.some(
        (task) =>
            task !== "review-user-memories" && taskHasSchedulableInput(task, db, projectPath, now),
    );
}

/**
 * Read-only backlog probe for one task. These probes reuse the task selection
 * predicates and never acquire a lease, materialize a prompt cache, or invoke a model.
 */
export function getDreamTaskBacklog(
    db: Database,
    projectPath: string,
    task: DreamTaskName,
    options: { lastRunAt?: number | null; retrospectiveWatermarkMs?: number | null } = {},
): DreamTaskBacklog {
    switch (task) {
        case "map-memories": {
            const total = countLiveMemories(db, projectPath);
            return { pending: countUnmappedActiveMemories(db, projectPath), total };
        }
        case "verify": {
            return {
                pending: countUnverifiedMappedMemories(db, projectPath),
                total: countMappedMemories(db, projectPath),
            };
        }
        case "verify-broad": {
            const total = countMappedMemories(db, projectPath);
            const cycleStartAt = getTaskScheduleState(
                db,
                projectPath,
                "verify-broad",
            )?.lastBroadRunAt;
            // With no open cycle, the next broad run will open one over the whole
            // mapped pool. Once open, report only the memories not yet verified for
            // that cycle so run telemetry reflects the resumable backlog.
            const pending =
                cycleStartAt == null
                    ? total
                    : countBroadCycleCandidates(db, projectPath, cycleStartAt);
            return { pending, total };
        }
        case "curate": {
            const categories = db
                .prepare<[string, number], { category: string }>(
                    `SELECT category FROM memories
                      WHERE project_path = ?
                        AND status IN ('active','permanent')
                        AND (expires_at IS NULL OR expires_at > ?)`,
                )
                .all(projectPath, Date.now());
            const scope = peekCurateCategoryScope(db, projectPath, categories);
            const total = scope?.memories.length ?? 0;
            return scope
                ? { pending: total, total, category: scope.category }
                : { pending: 0, total: 0 };
        }
        case "compress-cues": {
            const total = countLiveMemories(db, projectPath);
            return { pending: countCueCandidates(db, projectPath), total };
        }
        case "classify-memories": {
            const total = countLiveMemories(db, projectPath);
            return {
                pending: countLiveMemories(db, projectPath, { unclassifiedOnly: true }),
                total,
            };
        }
        case "retrospective": {
            const watermark =
                options.retrospectiveWatermarkMs !== undefined
                    ? options.retrospectiveWatermarkMs
                    : getTaskScheduleState(db, projectPath, task)?.retrospectiveWatermarkMs;
            const pending = countProjectSessionsSince(db, projectPath, watermark ?? null);
            return { pending, total: pending };
        }
        case "maintain-docs": {
            const total = countCompartmentsSince(db, projectPath, 0);
            const lastRunAt =
                options.lastRunAt !== undefined
                    ? options.lastRunAt
                    : getTaskScheduleState(db, projectPath, task)?.lastRunAt;
            const pending = countCompartmentsSince(db, projectPath, lastRunAt ?? 0);
            return { pending, total };
        }
        case "evaluate-smart-notes": {
            const pending = countPendingSmartNotes(db, projectPath);
            return { pending, total: pending };
        }
        case "review-user-memories": {
            const pending = countUserMemoryCandidates(db);
            return { pending, total: pending };
        }
        case "promote-primers": {
            const pending = countPrimerCandidatesForProject(db, projectPath);
            return { pending, total: pending };
        }
        case "refresh-primers": {
            const total = countActivePrimers(db, projectPath);
            return { pending: countStalePrimers(db, projectPath), total };
        }
        default: {
            const _exhaustive: never = task;
            return _exhaustive;
        }
    }
}

const backlogCaches = new WeakMap<
    Database,
    {
        revisionStatement: Statement;
        expiryStatement: Statement;
        revision: string;
        entries: Map<string, DreamTaskBacklogMap>;
        eligibleProjects: Map<string, boolean>;
    }
>();

/** Read the complete backlog breakdown in the caller's requested registry order. */
export function getDreamTaskBacklogs(
    db: Database,
    projectPath: string,
    tasks: readonly DreamTaskName[] = CANONICAL_DREAM_TASKS,
    options: { lastRunAt?: number | null; retrospectiveWatermarkMs?: number | null } = {},
): DreamTaskBacklogMap {
    if (tasks.length === 0) return {};
    if (!isKnownAutocommit(db)) {
        // A rollback leaves every revision counter unchanged, so a backlog read
        // inside a transaction must never be cached or served from the cache.
        backlogCaches.delete(db);
        const result: DreamTaskBacklogMap = {};
        for (const task of tasks)
            result[task] = getDreamTaskBacklog(db, projectPath, task, options);
        return result;
    }
    let cache = backlogCaches.get(db);
    if (!cache) {
        cache = {
            revisionStatement: db.prepare(`SELECT total_changes() AS writes,
                (SELECT data_version FROM pragma_data_version) AS dataVersion,
                (SELECT schema_version FROM pragma_schema_version) AS schemaVersion`),
            expiryStatement: db.prepare(`SELECT 1 FROM memories WHERE project_path = ?
                AND status IN ('active','permanent') AND expires_at IS NOT NULL LIMIT 1`),
            revision: "",
            entries: new Map(),
            eligibleProjects: new Map(),
        };
        backlogCaches.set(db, cache);
    }
    const revision = JSON.stringify(cache.revisionStatement.get());
    if (revision !== cache.revision) {
        cache.entries.clear();
        cache.eligibleProjects.clear();
        cache.revision = revision;
    }
    let eligible = cache.eligibleProjects.get(projectPath);
    if (eligible === undefined) {
        // An expiring pool can change without a write. Never memoize its counts;
        // all other backlog predicates depend only on rows and caller options.
        eligible = !cache.expiryStatement.get(projectPath);
        if (cache.eligibleProjects.size >= 16) cache.eligibleProjects.clear();
        cache.eligibleProjects.set(projectPath, eligible);
    }
    // JSON numbers collapse NaN/Infinity to null; null and omitted watermarks
    // also have different meanings. Preserve those distinctions in the key.
    const optionKey = (value: number | null | undefined) =>
        value === undefined ? "omitted" : value === null ? "null" : `number:${value}`;
    const key = JSON.stringify([
        projectPath,
        tasks,
        optionKey(options.lastRunAt),
        optionKey(options.retrospectiveWatermarkMs),
    ]);
    const cached = eligible ? cache.entries.get(key) : undefined;
    if (cached) return structuredClone(cached);
    const result: DreamTaskBacklogMap = {};
    for (const task of tasks) result[task] = getDreamTaskBacklog(db, projectPath, task, options);
    if (eligible) {
        if (cache.entries.size >= 16)
            cache.entries.delete(cache.entries.keys().next().value as string);
        cache.entries.set(key, structuredClone(result));
    }
    return result;
}

/**
 * Evaluate a task's activity gate. Returns true if the task has work to do.
 * Throwing DB errors propagate to the caller (a gate that can't read is a real
 * problem, not silently "no work").
 */
export function evaluateTaskGate(task: DreamTaskName, ctx: TaskGateContext): boolean {
    const { db, projectIdentity: project, lastRunAt } = ctx;
    switch (task) {
        case "map-memories":
            // Runs only while UNMAPPED active memories exist — the one-time-style
            // backfill that drains the pool then no-ops. Cheap: a single NOT-IN
            // count against the verification side-table.
            return countUnmappedActiveMemories(db, project) > 0;

        case "verify":
            // The executor's file gate does the precise incremental partition; the
            // scheduler only avoids taking the memory lease when there is no live pool.
            return countLiveMemories(db, project) > 0;

        case "verify-broad":
            // Keep an open cycle runnable even when another task removed the last
            // active memory; the executor then closes the now-empty cycle. A closed
            // cycle still needs an active pool before taking the memory lease.
            return (
                getTaskScheduleState(db, project, "verify-broad")?.lastBroadRunAt != null ||
                countLiveMemories(db, project) > 0
            );

        case "curate":
            // Curate owns expiry hygiene, so its gate intentionally uses the raw
            // status pool: an expired-only project still needs one transition run.
            return countActiveMemories(db, project) > 0;

        case "compress-cues":
            // Cheap pre-gate: only take the memory lease when a live pool exists. The
            // executor's selectCandidates does the precise NULL/stale-hash cue
            // partition and no-ops when everything is already compressed.
            return countLiveMemories(db, project) > 0;

        case "classify-memories":
            // Classification scores the live project memory pool directly. It has
            // no file gate, watermark, or completeness prerequisites.
            return countLiveMemories(db, project) > 0;

        case "retrospective":
            // Cheap pre-gate: any project session updated since the CONTENT
            // watermark (max message ts actually scanned), not lastRunAt — a
            // session updated mid-run would otherwise be skipped. The executor's
            // raw provider does the precise typed-user-message scan and bails
            // before any child session if empty. Never-run → "sessions exist".
            return countProjectSessionsSince(db, project, ctx.retrospectiveWatermarkMs ?? null) > 0;

        case "maintain-docs":
            // New compartments since the last maintain-docs run. Never-run → any exist.
            return countCompartmentsSince(db, project, lastRunAt ?? 0) > 0;

        case "evaluate-smart-notes":
            return (
                getSmartNotesNeedingCompilation(db, project, Date.now(), 1).length > 0 ||
                getStaleCompiledSmartNotes(db, project, Date.now(), 1).length > 0 ||
                getPendingSmartNotes(db, project).some((note) => note.checkStatus === "fallback")
            );

        case "review-user-memories":
            // Candidate observations are GLOBAL (cross-project user profile).
            return getUserMemoryCandidates(db).length >= ctx.promotionThreshold;

        case "promote-primers":
            return (
                countPrimerCandidatesForProject(db, project) >=
                (ctx.promotionThreshold ?? DREAM_TASK_PROMOTION_DEFAULTS["promote-primers"])
            );

        case "refresh-primers":
            return getActivePrimers(db, project).some(
                (primer) =>
                    !primer.answer.trim() ||
                    primer.answerRefreshedAt == null ||
                    (primer.lastObservedAt ?? 0) > primer.answerRefreshedAt,
            );

        default: {
            const _exhaustive: never = task;
            return Boolean(_exhaustive);
        }
    }
}
