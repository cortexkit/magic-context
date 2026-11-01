import { z } from "zod";
import type { Database } from "../../shared/sqlite";
import { setSessionWorkMetrics } from "./storage-meta-persisted";
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

function readState(db: Database, sessionId: string): Record<string, unknown> {
    const row = db
        .prepare("SELECT deferred_execute_state FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { deferred_execute_state: string | null } | undefined;
    try {
        const value: unknown = JSON.parse(row?.deferred_execute_state ?? "null");
        return value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

export function readSessionWorkMetricsCarry(
    db: Database,
    sessionId: string,
    source: string,
): WorkMetricsCarry | undefined {
    const parsed = storedCarry.safeParse(readState(db, sessionId)[STATE_KEY]);
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
    db.transaction(() => {
        setSessionWorkMetrics(db, sessionId, metrics.newWorkTokens, metrics.totalInputTokens);
        const root = readState(db, sessionId);
        root[STATE_KEY] = { ...carry, version: 1, source, perAgent: [...carry.perAgent] };
        db.prepare("UPDATE session_meta SET deferred_execute_state = ? WHERE session_id = ?").run(
            JSON.stringify(root),
            sessionId,
        );
    }).immediate();
}
