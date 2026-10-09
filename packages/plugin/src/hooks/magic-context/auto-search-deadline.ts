import {
    type AutoSearchHintNoHintReason,
    appendAutoSearchHintDecision,
} from "../../features/magic-context/storage-meta-persisted";
import { cancelAutoSearchWork } from "../../shared/auto-search-lifecycle";
import type { Database } from "../../shared/sqlite";

export const AUTO_SEARCH_TIMEOUT_MS = 3_000;
const operationDeadlines = new WeakMap<AbortSignal, number>();

export function autoSearchDeadlineUnixMs(signal?: AbortSignal): number {
    const deadline = signal && operationDeadlines.get(signal);
    return (
        Date.now() +
        (deadline === undefined
            ? AUTO_SEARCH_TIMEOUT_MS
            : Math.max(0, deadline - performance.now()))
    );
}

const skippedTurns = new Map<string, WeakMap<Database, Map<string, Promise<boolean>>>>();

export function wasAutoSearchSkipped(db: Database, sessionId: string, messageId: string): boolean {
    return skippedTurns.get(sessionId)?.get(db)?.has(messageId) ?? false;
}

export function clearAutoSearchTimeoutForSession(sessionId?: string): void {
    cancelAutoSearchWork(sessionId);
    if (sessionId === undefined) skippedTurns.clear();
    else skippedTurns.delete(sessionId);
}

/** Freeze the skip even if another writer owns SQLite at the deadline. */
export function persistAutoSearchSkip(
    db: Database,
    sessionId: string,
    messageId: string,
    reason: AutoSearchHintNoHintReason = "timeout",
): Promise<boolean> {
    let turns = skippedTurns.get(sessionId);
    if (!turns) {
        turns = new WeakMap();
        skippedTurns.set(sessionId, turns);
    }
    let messages = turns.get(db);
    if (!messages) {
        messages = new Map();
        turns.set(db, messages);
    }
    const prior = messages.get(messageId);
    if (prior) return prior;
    // Persist on the owner, exactly like ordinary hint decisions. There is no
    // queued writer that can recreate a deleted/replaced session later. A failed
    // durable write must still leave this message frozen in the owner's cache.
    let ok = false;
    try {
        const outcome = appendAutoSearchHintDecision(db, sessionId, {
            messageId,
            decision: "no-hint",
            reason,
        });
        ok = outcome.ok && outcome.decision.decision === "no-hint";
    } catch {
        // A contended store must not erase the already-served no-hint decision.
    }
    const persistence = Promise.resolve(ok);
    messages.set(messageId, persistence);
    return persistence;
}

/**
 * Preparation and search share one deadline. Check elapsed time as well as
 * the timer: a synchronous SQLite call can prevent an overdue timer from
 * firing before the search promise resolves. Checkpoints after preparation or
 * embedding abort expired work before its next synchronous database scan;
 * overdue search results are discarded before hint persistence.
 */
export async function withAutoSearchDeadline<T>(
    operation: (signal: AbortSignal, checkDeadline: () => boolean) => Promise<T>,
    startedAt = performance.now(),
): Promise<T | null> {
    const deadline = startedAt + AUTO_SEARCH_TIMEOUT_MS;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return null;
    const controller = new AbortController();
    operationDeadlines.set(controller.signal, deadline);
    const checkDeadline = (): boolean => {
        if (!controller.signal.aborted && performance.now() >= deadline) controller.abort();
        return controller.signal.aborted;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
            resolve(null);
            controller.abort();
        }, remaining);
    });
    try {
        return await Promise.race([
            Promise.resolve()
                .then(() => operation(controller.signal, checkDeadline))
                .then((result) => {
                    if (checkDeadline()) {
                        return null;
                    }
                    return result;
                }),
            timeout,
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
