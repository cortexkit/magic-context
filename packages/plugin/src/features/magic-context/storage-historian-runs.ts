import type { Database } from "../../shared/sqlite";

/**
 * Per historian-invocation telemetry.
 *
 * One row per attempted historian run (incremental publish or recomp pass),
 * recording the INPUT (chunk range) and OUTPUT shape
 * (compartments / facts / events / importance) plus success/failure. Tokens and
 * the model used live on the FK-linked `subagent_invocations` row
 * (`subagentInvocationId`) — join to get cost/model.
 *
 * Purpose: debugging (which range produced what), quality analysis (facts per
 * output token, importance distribution by model), and the productization /
 * training-data roadmap.
 */

export type HistorianRunStatus =
    /** Compartments were validated + published. */
    | "success"
    /** A real failure (validation / coverage / no-progress / exception). */
    | "failed"
    /** A successful no-op (nothing eligible to compact, empty chunk). */
    | "noop";

/** "upgrade" is only read, never written: rows from the removed session-upgrade
 *  command are still in existing databases. */
export type HistorianRunKind = "incremental" | "recomp" | "partial-recomp" | "upgrade";

export interface HistorianRunInput {
    sessionId: string;
    harness: string;
    /** FK to subagent_invocations.id (tokens/model/timing). NULL if no invocation. */
    subagentInvocationId?: number | null;
    runKind: HistorianRunKind;
    status: HistorianRunStatus;
    /** Failure reason for `failed` (and optionally a no-op explanation). */
    failureReason?: string | null;
    /** Raw-ordinal range of the input chunk. */
    chunkStartOrdinal?: number | null;
    chunkEndOrdinal?: number | null;
    /** Historian's reported next-start (its `<unprocessed_from>`). */
    unprocessedFrom?: number | null;
    /** Compartments actually persisted (post discard-last). */
    compartmentsProduced?: number;
    /** Durable id range of the persisted compartments. */
    compartmentIdMin?: number | null;
    compartmentIdMax?: number | null;
    /** Facts emitted in the `<facts>` block. */
    factsEmitted?: number;
    /** `{ [category]: count }` of emitted facts. */
    factsByCategory?: Record<string, number> | null;
    /** Valid emitted facts persisted as new memories or re-observations. */
    factsPromoted?: number;
    /** Events emitted (causal_incident / trajectory_correction). */
    eventsEmitted?: number;
    /** Events successfully inserted into compartment_events. */
    eventsPublished?: number;
    /** Importance distribution across persisted compartments. */
    importanceMin?: number | null;
    importanceMax?: number | null;
    importanceAvg?: number | null;
    /** Whether the lookahead-free last compartment was discarded (boundary healing). */
    discardedLast?: boolean;
    /** Whether the run produced/processed legacy (pre-v2) compartments. */
    legacy?: boolean;
}

/** Count recorded attempts for one session, regardless of their outcome. */
export function countHistorianRuns(db: Database, sessionId: string): number {
    try {
        const row = db
            .prepare<[string], { count: number }>(
                "SELECT COUNT(*) AS count FROM historian_runs WHERE session_id = ?",
            )
            .get(sessionId);
        return row?.count ?? 0;
    } catch {
        // Older stores may not have the telemetry table yet; status stays usable.
        return 0;
    }
}

export function recordHistorianRun(db: Database, input: HistorianRunInput): number | null {
    try {
        const result = db
            .prepare(
                `INSERT INTO historian_runs (
                    session_id, harness, subagent_invocation_id, run_kind, status,
                    failure_reason, chunk_start_ordinal, chunk_end_ordinal, unprocessed_from,
                    compartments_produced, compartment_id_min, compartment_id_max,
                    facts_emitted, facts_by_category_json, events_emitted,
                    importance_min, importance_max, importance_avg,
                    discarded_last, legacy, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                input.sessionId,
                input.harness,
                input.subagentInvocationId ?? null,
                input.runKind,
                input.status,
                input.failureReason ?? null,
                input.chunkStartOrdinal ?? null,
                input.chunkEndOrdinal ?? null,
                input.unprocessedFrom ?? null,
                input.compartmentsProduced ?? 0,
                input.compartmentIdMin ?? null,
                input.compartmentIdMax ?? null,
                input.factsEmitted ?? 0,
                JSON.stringify({
                    ...(input.factsByCategory ?? {}),
                    facts_promoted: input.factsPromoted ?? 0,
                    events_published: input.eventsPublished ?? 0,
                }),
                input.eventsEmitted ?? 0,
                input.importanceMin ?? null,
                input.importanceMax ?? null,
                input.importanceAvg ?? null,
                input.discardedLast ? 1 : 0,
                input.legacy ? 1 : 0,
                Date.now(),
            );
        return Number(result.lastInsertRowid);
    } catch {
        return null;
    }
}

/** Summarize a list of importance values into min/max/avg (null on empty). */
export function summarizeImportance(values: readonly number[]): {
    min: number | null;
    max: number | null;
    avg: number | null;
} {
    const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
    if (nums.length === 0) return { min: null, max: null, avg: null };
    let min = nums[0];
    let max = nums[0];
    let sum = 0;
    for (const v of nums) {
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
    }
    return { min, max, avg: sum / nums.length };
}

/** Tally facts by their category for `factsByCategory`. */
export function tallyFactsByCategory(
    facts: ReadonlyArray<{ category?: string | null }>,
): Record<string, number> {
    const out: Record<string, number> = {};
    for (const f of facts) {
        const cat = (f.category ?? "UNKNOWN").trim() || "UNKNOWN";
        out[cat] = (out[cat] ?? 0) + 1;
    }
    return out;
}
