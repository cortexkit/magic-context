import type { HostTokenBreakdown } from "../../hooks/magic-context/host-token-breakdown";
import type { Database } from "../../shared/sqlite";

export interface HostTokenBlockCounts {
    docs: number;
    profile: number;
    memory: number;
    history: number;
}

interface HostTokenBreakdownMemo {
    blocks?: HostTokenBlockCounts;
    previous?: HostTokenBreakdown;
    prefixDirty: boolean;
    pending?: ReturnType<typeof setTimeout>;
}

const memos = new WeakMap<Pick<Database, "prepare">, Map<string, HostTokenBreakdownMemo>>();

/** A prefix write can precede a failed pass; reload when the next successful pass accounts for it. */
export function markHostTokenPrefixChanged(db: Pick<Database, "prepare">, sessionId: string): void {
    const memo = memos.get(db)?.get(sessionId);
    if (memo) memo.prefixDirty = true;
}

export function getHostTokenBreakdownMemo(
    db: Pick<Database, "prepare">,
    sessionId: string,
): HostTokenBreakdownMemo {
    let sessions = memos.get(db);
    if (!sessions) {
        sessions = new Map();
        memos.set(db, sessions);
    }
    let memo = sessions.get(sessionId);
    if (!memo) {
        memo = { prefixDirty: false };
        sessions.set(sessionId, memo);
    }
    return memo;
}

/** Forget numeric attribution and cancel a pass deferred before the session was cleared. */
export function clearHostTokenBreakdownMemo(
    db: Pick<Database, "prepare">,
    sessionId: string,
): void {
    const sessions = memos.get(db);
    const pending = sessions?.get(sessionId)?.pending;
    if (pending) clearTimeout(pending);
    sessions?.delete(sessionId);
    if (sessions?.size === 0) memos.delete(db);
}
