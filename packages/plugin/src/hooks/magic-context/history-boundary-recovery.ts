import { BoundedSessionMap } from "../../shared/bounded-session-map";
import type { Database } from "../../shared/sqlite";
import type { MessageLike } from "./tag-messages";

// ── Bounding the recovery a refused history cut arms ────────────────────
//
// When the transform cannot cut the summarized history out of a request and
// the request is over the model's window, it arms the same overflow recovery a
// provider rejection arms: the next pass summarizes older history and drops old
// tool output before it sizes the request again. That recovery can fail to make
// room (nothing left to summarize, every droppable output already dropped). A
// pass that then meets the very same state must not run it again: it would
// spend another summarizer call for the same result on every send. So the
// state a fruitless recovery pass ended on is remembered, and recovery stays
// idle while the session is still in it. Anything that changes the state ends
// that: a new message, a /ctx-flush (drops), a published summary, a moved
// history boundary, or a host compaction (a different first message).
//
// The record is process-local. A restart forgets it, which costs at most one
// more recovery attempt on the same state.

const exhaustedStateBySession = new BoundedSessionMap<string>(512);

/** The host's input as far as identity goes: how many stored messages, and the first and last. */
export function inputMessagesKey(messages: readonly MessageLike[]): string {
    let count = 0;
    let first = "";
    let last = "";
    for (const message of messages) {
        const id = message.info.id;
        if (typeof id !== "string" || id.length === 0) continue;
        if (count === 0) first = id;
        last = id;
        count += 1;
    }
    return `${count}:${first}:${last}`;
}

/**
 * Everything a recovery pass could change that decides whether the next pass
 * might fit: the summaries, the dropped tool output, the history boundary,
 * plus the host's input. Null when the store cannot be read.
 */
export function historyBoundaryRecoveryStateKey(
    db: Database,
    sessionId: string,
    inputKey: string,
): string | null {
    try {
        const row = db
            .prepare(
                `SELECT
                    (SELECT COUNT(*) FROM compartments WHERE session_id = ?) AS compartments,
                    (SELECT COALESCE(MAX(sequence), -1) FROM compartments WHERE session_id = ?) AS newest,
                    (SELECT COUNT(*) FROM tags WHERE session_id = ? AND status = 'dropped') AS dropped,
                    (SELECT COALESCE(cached_m0_last_baseline_end_message_id, '') FROM session_meta WHERE session_id = ?) AS boundary`,
            )
            .get(sessionId, sessionId, sessionId, sessionId) as
            | { compartments: number; newest: number; dropped: number; boundary: string | null }
            | undefined;
        if (!row) return null;
        return `${inputKey}|${row.compartments}:${row.newest}|${row.dropped}|${row.boundary ?? ""}`;
    } catch {
        return null;
    }
}

export function markHistoryBoundaryRecoveryExhausted(sessionId: string, stateKey: string): void {
    exhaustedStateBySession.set(sessionId, stateKey);
}

/** Whether recovery already ran on exactly this state and could not make room. */
export function isHistoryBoundaryRecoveryExhausted(
    sessionId: string,
    stateKey: string | null,
): boolean {
    return stateKey !== null && exhaustedStateBySession.get(sessionId) === stateKey;
}

export function forgetHistoryBoundaryRecovery(sessionId: string): void {
    exhaustedStateBySession.delete(sessionId);
}
