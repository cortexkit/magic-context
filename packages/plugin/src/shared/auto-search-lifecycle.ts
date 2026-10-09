const pending = new Map<string, Set<AbortController>>();

/** Cleanup cancels optional searches and backfill, not durable served decisions. */
export function registerAutoSearchWork(sessionId: string): {
    signal: AbortSignal;
    done: () => void;
} {
    const controller = new AbortController();
    const work = pending.get(sessionId) ?? new Set<AbortController>();
    pending.set(sessionId, work);
    work.add(controller);
    return {
        signal: controller.signal,
        done: () => {
            work.delete(controller);
            if (pending.get(sessionId) === work && work.size === 0) pending.delete(sessionId);
        },
    };
}

export function cancelAutoSearchWork(sessionId?: string): void {
    for (const [id, work] of pending) {
        if (sessionId !== undefined && id !== sessionId) continue;
        pending.delete(id);
        for (const controller of work) controller.abort();
    }
}
