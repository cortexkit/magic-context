import type { Database } from "../../../shared/sqlite";
import { hasMemoryClassifiedAtColumn } from "../memory/storage-memory";
import { hasMuralCueColumns } from "../mural/storage-mural-cues";
import {
    getSmartNotesNeedingCompilation,
    getStaleCompiledSmartNotes,
} from "../smart-notes/storage";
import { getPendingSmartNotes } from "../storage-notes";
import { countPrimerCandidatesForProject, getActivePrimers } from "../storage-primers";
import { getUserMemoryCandidates } from "../user-memory/storage-user-memory";
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

export function countActiveMemories(db: Database, projectPath: string): number {
    const row = db
        .prepare<[string], { cnt: number }>(
            "SELECT COUNT(*) AS cnt FROM memories WHERE project_path = ? AND status IN ('active','permanent')",
        )
        .get(projectPath);
    return row?.cnt ?? 0;
}

/** Active/permanent memories with NO mapping row yet — the map-memories scope. */
export function countUnmappedActiveMemories(db: Database, projectPath: string): number {
    const row = db
        .prepare<[string], { cnt: number }>(
            `SELECT COUNT(*) AS cnt
               FROM memories m
              WHERE m.project_path = ?
                AND m.status IN ('active','permanent')
                AND NOT EXISTS (
                    SELECT 1 FROM memory_verifications v WHERE v.memory_id = m.id
                )`,
        )
        .get(projectPath);
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
    const row =
        since === null
            ? db
                  .prepare<[string], { cnt: number }>(
                      "SELECT COUNT(*) AS cnt FROM session_projects WHERE project_path = ?",
                  )
                  .get(projectPath)
            : db
                  .prepare<[string, number], { cnt: number }>(
                      "SELECT COUNT(*) AS cnt FROM session_projects WHERE project_path = ? AND updated_at > ?",
                  )
                  .get(projectPath, since);
    return row?.cnt ?? 0;
}

function countMappedMemories(db: Database, projectPath: string): number {
    const row = db
        .prepare<[string], { cnt: number }>(
            `SELECT COUNT(DISTINCT m.id) AS cnt
               FROM memories m
               JOIN memory_verifications v ON v.memory_id = m.id
              WHERE m.project_path = ?
                AND m.status IN ('active','permanent')
                AND v.file_path <> ''`,
        )
        .get(projectPath);
    return row?.cnt ?? 0;
}

function countUnverifiedMappedMemories(db: Database, projectPath: string): number {
    const row = db
        .prepare<[string], { cnt: number }>(
            `SELECT COUNT(DISTINCT m.id) AS cnt
               FROM memories m
               JOIN memory_verifications v ON v.memory_id = m.id
              WHERE m.project_path = ?
                AND m.status IN ('active','permanent')
                AND v.file_path <> ''
                AND v.verified_at = 0`,
        )
        .get(projectPath);
    return row?.cnt ?? 0;
}

function countBroadCycleCandidates(
    db: Database,
    projectPath: string,
    cycleStartAt: number,
): number {
    const row = db
        .prepare<[string, number], { cnt: number }>(
            `SELECT COUNT(*) AS cnt
               FROM memories m
              WHERE m.project_path = ?
                AND m.status IN ('active','permanent')
                AND (
                    SELECT MAX(v.verified_at)
                      FROM memory_verifications v
                     WHERE v.memory_id = m.id
                       AND v.file_path <> ''
                ) < ?`,
        )
        .get(projectPath, cycleStartAt);
    return row?.cnt ?? 0;
}

function countCueCandidates(db: Database, projectPath: string): number {
    if (!hasMuralCueColumns(db)) return countActiveMemories(db, projectPath);
    const row = db
        .prepare<[string], { cnt: number }>(
            `SELECT COUNT(*) AS cnt
               FROM memories
              WHERE project_path = ?
                AND status IN ('active','permanent')
                AND (mural_cue IS NULL OR mural_cue_hash IS NULL OR updated_at > mural_cue_at)`,
        )
        .get(projectPath);
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

function countUnclassifiedActiveMemories(db: Database, projectPath: string): number {
    if (!hasMemoryClassifiedAtColumn(db)) return countActiveMemories(db, projectPath);
    const row = db
        .prepare<[string], { cnt: number }>(
            `SELECT COUNT(*) AS cnt
               FROM memories
              WHERE project_path = ?
                AND status IN ('active','permanent')
                AND classified_at IS NULL`,
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
            const total = countActiveMemories(db, projectPath);
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
            const total = countActiveMemories(db, projectPath);
            return { pending: total, total };
        }
        case "compress-cues": {
            const total = countActiveMemories(db, projectPath);
            return { pending: countCueCandidates(db, projectPath), total };
        }
        case "classify-memories": {
            const total = countActiveMemories(db, projectPath);
            return { pending: countUnclassifiedActiveMemories(db, projectPath), total };
        }
        case "retrospective": {
            const pending = countProjectSessionsSince(
                db,
                projectPath,
                options.retrospectiveWatermarkMs ?? null,
            );
            return { pending, total: pending };
        }
        case "maintain-docs": {
            const total = countCompartmentsSince(db, projectPath, 0);
            const pending = countCompartmentsSince(db, projectPath, options.lastRunAt ?? 0);
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

/** Read the complete backlog breakdown in the caller's requested registry order. */
export function getDreamTaskBacklogs(
    db: Database,
    projectPath: string,
    tasks: readonly DreamTaskName[] = CANONICAL_DREAM_TASKS,
    options: { lastRunAt?: number | null; retrospectiveWatermarkMs?: number | null } = {},
): DreamTaskBacklogMap {
    const result: DreamTaskBacklogMap = {};
    for (const task of tasks) result[task] = getDreamTaskBacklog(db, projectPath, task, options);
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
            // scheduler only avoids taking the memory lease when there is no pool.
            return countActiveMemories(db, project) > 0;

        case "verify-broad":
            // Keep an open cycle runnable even when another task removed the last
            // active memory; the executor then closes the now-empty cycle. A closed
            // cycle still needs an active pool before taking the memory lease.
            return (
                getTaskScheduleState(db, project, "verify-broad")?.lastBroadRunAt != null ||
                countActiveMemories(db, project) > 0
            );

        case "curate":
            // Curate is whole-pool hygiene, but still needs an active pool before
            // taking the shared memory lease.
            return countActiveMemories(db, project) > 0;

        case "compress-cues":
            // Cheap pre-gate: only take the memory lease when a pool exists. The
            // executor's selectCandidates does the precise NULL/stale-hash cue
            // partition and no-ops when everything is already compressed.
            return countActiveMemories(db, project) > 0;

        case "classify-memories":
            // Classification scores the active project memory pool directly. It has
            // no file gate, watermark, or completeness prerequisites.
            return countActiveMemories(db, project) > 0;

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
            return countPrimerCandidatesForProject(db, project) >= (ctx.promotionThreshold ?? 2);

        case "refresh-primers":
            return getActivePrimers(db, project).some(
                (primer) =>
                    !primer.answer.trim() ||
                    primer.answerRefreshedAt == null ||
                    (primer.lastObservedAt ?? 0) > primer.answerRefreshedAt,
            );

        case "distill-skill-memory":
            // Agentic opt-in task: when scheduled, always eligible. The reembed
            // pre-step + distill prompt no-op gracefully on an empty corpus, so a
            // cheap always-true gate avoids coupling the scheduler to skill_memory
            // table internals.
            return true;

        default: {
            const _exhaustive: never = task;
            return Boolean(_exhaustive);
        }
    }
}
