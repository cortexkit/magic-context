import type { HarnessId } from "../../shared/harness";
import type { Database } from "../../shared/sqlite";

export type SubagentKind =
    | "historian"
    | "historian_editor"
    | "rescore"
    | "compressor"
    | "dreamer"
    | "user_memory_review"
    | "recomp";

export type SubagentInvocationStatus = "completed" | "failed" | "aborted" | "timed_out" | "empty";

export interface SubagentInvocationInput {
    sessionId: string;
    harness: HarnessId;
    subagent: SubagentKind;
    task?: string | null;
    providerId?: string | null;
    modelId?: string | null;
    startedAt: number;
    endedAt: number;
    status: SubagentInvocationStatus;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    error?: string | null;
    parentInvocationId?: number | null;
}

export interface SubagentInvocationRow {
    id: number;
    sessionId: string;
    harness: HarnessId;
    subagent: SubagentKind;
    task: string | null;
    providerId: string | null;
    modelId: string | null;
    startedAt: number;
    endedAt: number | null;
    status: SubagentInvocationStatus;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    error: string | null;
    parentInvocationId: number | null;
}

export interface SubagentTotals {
    invocations: number;
    totalInput: number;
    totalOutput: number;
    totalCacheRead: number;
    totalCacheWrite: number;
}

interface SubagentInvocationDbRow {
    id: number;
    session_id: string;
    harness: HarnessId;
    subagent: SubagentKind;
    task: string | null;
    provider_id: string | null;
    model_id: string | null;
    started_at: number;
    ended_at: number | null;
    status: SubagentInvocationStatus;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    error: string | null;
    parent_invocation_id: number | null;
}

function clampToken(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function toRow(row: SubagentInvocationDbRow): SubagentInvocationRow {
    return {
        id: row.id,
        sessionId: row.session_id,
        harness: row.harness,
        subagent: row.subagent,
        task: row.task,
        providerId: row.provider_id,
        modelId: row.model_id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        status: row.status,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        error: row.error,
        parentInvocationId: row.parent_invocation_id,
    };
}

export function recordSubagentInvocation(db: Database, input: SubagentInvocationInput): number {
    const result = db
        .prepare(
            `INSERT INTO subagent_invocations (
                session_id, harness, subagent, task, provider_id, model_id,
                started_at, ended_at, status,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                error, parent_invocation_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            input.sessionId,
            input.harness,
            input.subagent,
            input.task ?? null,
            input.providerId ?? null,
            input.modelId ?? null,
            input.startedAt,
            input.endedAt,
            input.status,
            clampToken(input.inputTokens),
            clampToken(input.outputTokens),
            clampToken(input.cacheReadTokens),
            clampToken(input.cacheWriteTokens),
            input.error ?? null,
            input.parentInvocationId ?? null,
        );
    return Number(result.lastInsertRowid);
}

/**
 * Newest `historian` invocation id for a session (or null if none yet).
 *
 * Used to FK-link a `historian_runs` row to the invocation that produced it:
 * historian runs are serialized per session (compartmentInProgress lock), so the
 * latest historian invocation recorded between a pre-run baseline and the run's
 * end is the one for this run.
 */
export function getLatestHistorianInvocationId(db: Database, sessionId: string): number | null {
    try {
        const row = db
            .prepare(
                `SELECT id FROM subagent_invocations
                 WHERE session_id = ? AND subagent = 'historian'
                 ORDER BY id DESC LIMIT 1`,
            )
            .get(sessionId) as { id?: number } | undefined;
        return typeof row?.id === "number" ? row.id : null;
    } catch {
        return null;
    }
}

export function getSubagentInvocations(
    db: Database,
    sessionId: string,
    opts: { subagent?: SubagentKind; limit?: number } = {},
): SubagentInvocationRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
    const rows = opts.subagent
        ? (db
              .prepare(
                  `SELECT * FROM subagent_invocations
                   WHERE session_id = ? AND subagent = ?
                   ORDER BY started_at DESC
                   LIMIT ?`,
              )
              .all(sessionId, opts.subagent, limit) as SubagentInvocationDbRow[])
        : (db
              .prepare(
                  `SELECT * FROM subagent_invocations
                   WHERE session_id = ?
                   ORDER BY started_at DESC
                   LIMIT ?`,
              )
              .all(sessionId, limit) as SubagentInvocationDbRow[]);
    return rows.map(toRow);
}

export function getSubagentTotalsBySubagent(
    db: Database,
    sessionId: string,
): Partial<Record<SubagentKind, SubagentTotals>> {
    const rows = db
        .prepare(
            `SELECT subagent,
                    COUNT(*) AS invocations,
                    COALESCE(SUM(input_tokens), 0) AS totalInput,
                    COALESCE(SUM(output_tokens), 0) AS totalOutput,
                    COALESCE(SUM(cache_read_tokens), 0) AS totalCacheRead,
                    COALESCE(SUM(cache_write_tokens), 0) AS totalCacheWrite
             FROM subagent_invocations
             WHERE session_id = ?
             GROUP BY subagent`,
        )
        .all(sessionId) as Array<SubagentTotals & { subagent: SubagentKind }>;
    const result: Partial<Record<SubagentKind, SubagentTotals>> = {};
    for (const row of rows) {
        result[row.subagent] = {
            invocations: row.invocations,
            totalInput: row.totalInput,
            totalOutput: row.totalOutput,
            totalCacheRead: row.totalCacheRead,
            totalCacheWrite: row.totalCacheWrite,
        };
    }
    return result;
}
