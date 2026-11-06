import { BoundedSessionMap } from "../../shared/bounded-session-map";
import type { SidebarHistorianRun } from "../../shared/rpc-types";

const historianRuns = new BoundedSessionMap<SidebarHistorianRun>(256);
const waitingMessages = new BoundedSessionMap<number>(256);
const generations = new BoundedSessionMap<object>(256);

export function sidebarObservations(sessionId: string) {
    return {
        historianRun: historianRuns.peek(sessionId),
        waitingMessages: waitingMessages.peek(sessionId),
    };
}

export function rememberWaitingMessages(sessionId: string, count: number): void {
    waitingMessages.set(sessionId, Math.max(0, count));
}

export function beginSidebarHistorianRun(sessionId: string) {
    const generation = generations.get(sessionId) ?? {};
    generations.set(sessionId, generation);
    return (run: Omit<SidebarHistorianRun, "finishedAt" | "sinceLastClean">) => {
        // Session deletion or eviction must also invalidate unfinished runs.
        if (generations.peek(sessionId) !== generation) return;
        finishSidebarHistorianRun(sessionId, run);
    };
}

function finishSidebarHistorianRun(
    sessionId: string,
    run: Omit<SidebarHistorianRun, "finishedAt" | "sinceLastClean">,
): void {
    const previous = historianRuns.peek(sessionId)?.sinceLastClean;
    const clean = run.outcome === "ok" && !run.fallback && run.primaryRejections === 0;
    historianRuns.set(sessionId, {
        ...run,
        finishedAt: Date.now(),
        sinceLastClean: clean
            ? { primaryRejections: 0, primaryAttempts: 0, fallbackRuns: 0 }
            : {
                  primaryRejections: (previous?.primaryRejections ?? 0) + run.primaryRejections,
                  primaryAttempts: (previous?.primaryAttempts ?? 0) + run.primaryAttempts,
                  fallbackRuns:
                      (previous?.fallbackRuns ?? 0) + (run.outcome === "fallback" ? 1 : 0),
              },
    });
}

export function clearSidebarObservations(sessionId: string): void {
    historianRuns.delete(sessionId);
    waitingMessages.delete(sessionId);
    generations.delete(sessionId);
}
