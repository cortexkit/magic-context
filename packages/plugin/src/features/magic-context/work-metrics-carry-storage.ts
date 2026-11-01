import { z } from "zod";
import type { Database } from "../../shared/sqlite";
import { ensureSessionMetaRow } from "./storage-meta-shared";
import type { WorkMetrics, WorkMetricsCarry } from "./work-metrics";

const STATE_KEY = "magicContextWorkMetrics";
const storedCarry = z.object({
    version: z.literal(1),
    source: z.string(),
    newWorkSum: z.number(),
    lastTimeCreated: z.number(),
    lastId: z.string(),
    perAgent: z.array(
        z.tuple([
            z.string(),
            z.object({
                prevPrompt: z.number(),
                phaseId: z.number(),
                phasePeak: z.number(),
                phaseHasQualifying: z.boolean(),
                closedPhaseSum: z.number(),
                lastOutput: z.number(),
                seen: z.boolean(),
            }),
        ]),
    ),
});

interface StoredState {
    root: Record<string, unknown>;
    newWorkTokens: number | undefined;
    totalInputTokens: number | undefined;
}

function readState(db: Database, sessionId: string): StoredState {
    const row = db
        .prepare(
            "SELECT deferred_execute_state, new_work_tokens, total_input_tokens FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as
        | {
              deferred_execute_state: string | null;
              new_work_tokens: number;
              total_input_tokens: number;
          }
        | undefined;
    let root: Record<string, unknown> = {};
    try {
        const value: unknown = JSON.parse(row?.deferred_execute_state ?? "null");
        if (value !== null && typeof value === "object" && !Array.isArray(value))
            root = value as Record<string, unknown>;
    } catch {
        // Invalid legacy state is replaced only when a fresh carry is saved.
    }
    return { root, newWorkTokens: row?.new_work_tokens, totalInputTokens: row?.total_input_tokens };
}

function matchesStoredState(
    state: StoredState,
    source: string,
    carry: WorkMetricsCarry,
    metrics: WorkMetrics,
): boolean {
    const parsed = storedCarry.safeParse(state.root[STATE_KEY]);
    if (!parsed.success) return false;
    const previous = parsed.data;
    if (
        previous.source !== source ||
        previous.newWorkSum !== carry.newWorkSum ||
        previous.lastTimeCreated !== carry.lastTimeCreated ||
        previous.lastId !== carry.lastId ||
        previous.perAgent.length !== carry.perAgent.size ||
        state.newWorkTokens !== metrics.newWorkTokens ||
        state.totalInputTokens !== metrics.totalInputTokens
    )
        return false;
    return previous.perAgent.every(([key, agent]) => {
        const current = carry.perAgent.get(key);
        return (
            current !== undefined &&
            agent.prevPrompt === current.prevPrompt &&
            agent.phaseId === current.phaseId &&
            agent.phasePeak === current.phasePeak &&
            agent.phaseHasQualifying === current.phaseHasQualifying &&
            agent.closedPhaseSum === current.closedPhaseSum &&
            agent.lastOutput === current.lastOutput &&
            agent.seen === current.seen
        );
    });
}

export function readSessionWorkMetricsCarry(
    db: Database,
    sessionId: string,
    source: string,
): WorkMetricsCarry | undefined {
    const parsed = storedCarry.safeParse(readState(db, sessionId).root[STATE_KEY]);
    if (!parsed.success || parsed.data.source !== source) return undefined;
    return {
        perAgent: new Map(parsed.data.perAgent),
        newWorkSum: parsed.data.newWorkSum,
        lastTimeCreated: parsed.data.lastTimeCreated,
        lastId: parsed.data.lastId,
    };
}

/**
 * The existing deferred_execute_state column holds namespaced session state,
 * including tokenizer calibration. Keep it intact and save only the committed carry;
 * the latest assistant row must still be re-read while its usage is streaming.
 */
export function setSessionWorkMetricsCarry(
    db: Database,
    sessionId: string,
    source: string,
    carry: WorkMetricsCarry,
    metrics: WorkMetrics,
): void {
    const normalized = {
        newWorkTokens: Math.max(0, Math.floor(metrics.newWorkTokens)),
        totalInputTokens: Math.max(0, Math.floor(metrics.totalInputTokens)),
    };
    // An idle sidebar poll must not contend with host turns for the shared writer.
    if (matchesStoredState(readState(db, sessionId), source, carry, normalized)) return;
    db.transaction(() => {
        // Re-read under the lock so a calibration write cannot be overwritten.
        const state = readState(db, sessionId);
        if (matchesStoredState(state, source, carry, normalized)) return;
        ensureSessionMetaRow(db, sessionId);
        const { root } = state;
        root[STATE_KEY] = { ...carry, version: 1, source, perAgent: [...carry.perAgent] };
        db.prepare(
            "UPDATE session_meta SET deferred_execute_state = ?, new_work_tokens = ?, total_input_tokens = ? WHERE session_id = ?",
        ).run(
            JSON.stringify(root),
            normalized.newWorkTokens,
            normalized.totalInputTokens,
            sessionId,
        );
    }).immediate();
}
