import {
    type AutoSearchDiagnostics,
    createAutoSearchDiagnostics,
} from "../../features/magic-context/auto-search-diagnostics";
import type { AutoSearchHintNoHintReason } from "../../features/magic-context/storage-meta-persisted";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";

export type AutoSearchDecisionOutcome =
    | "attached"
    | "below-threshold"
    | "timeout"
    | "no-candidates"
    | "disabled"
    | "error";

const disabledTurns = new WeakMap<Database, Map<string, string>>();
type DecisionReason =
    | AutoSearchHintNoHintReason
    | "unregistered"
    | "worker-busy"
    | "storage-busy"
    | "cas-exhausted";

/** Disabled turns have no persisted decision; deduplicate their diagnostics without writing one. */
export function logDisabledAutoSearch(
    db: Database,
    sessionId: string,
    messageId: string,
    threshold: number,
    startedAt: number,
): void {
    const sessions = disabledTurns.get(db) ?? new Map<string, string>();
    disabledTurns.set(db, sessions);
    if (sessions.get(sessionId) === messageId) return;
    sessions.set(sessionId, messageId);
    observeAutoSearch(sessionId, threshold, startedAt).finish("disabled");
}

export function observeAutoSearch(
    sessionId: string,
    threshold: number,
    startedAt: number,
): {
    diagnostics: AutoSearchDiagnostics;
    finish(outcome: AutoSearchDecisionOutcome, reason?: DecisionReason): void;
} {
    const diagnostics = createAutoSearchDiagnostics(threshold);
    let logged = false;
    return {
        diagnostics,
        finish(outcome, reason) {
            if (logged) return;
            logged = true;
            const lanes = Object.entries(diagnostics.lanes)
                .map(([lane, value]) => `${lane}:${value.top?.toFixed(3) ?? "none"}`)
                .join(",");
            const nearMisses = Object.values(diagnostics.lanes).reduce(
                (sum, lane) => sum + lane.nearMisses,
                0,
            );
            sessionLog(
                sessionId,
                `auto-search: decision outcome=${outcome}${reason ? ` reason=${reason}` : ""} lanes=${lanes || "none"} nearMisses=${nearMisses} threshold=${threshold} pool=${diagnostics.pool} rows=${diagnostics.poolRows ?? "unknown"} workerStarted=${diagnostics.workerStarted ?? "unknown"} peek=${diagnostics.peek} elapsedMs=${Math.round(performance.now() - startedAt)}`,
            );
        },
    };
}
