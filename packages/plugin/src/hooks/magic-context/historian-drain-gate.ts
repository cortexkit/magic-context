import { getProtectedTailDrainBudgetSkip } from "../../features/magic-context/storage-meta-persisted";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { deriveProtectedTailTokenTarget, selectPerRunCap } from "./protected-tail-boundary";

const loggedWindows = new WeakMap<Database, Map<string, number>>();

/** Avoid raw-history reads and prompt fitting when the persisted limiter cannot admit a run. */
export function isHistorianDrainBudgetSpent(args: {
    db: Database;
    sessionId: string;
    contextLimit: number;
    executeThresholdPercentage: number;
    usagePercentage: number;
    now?: number;
}): boolean {
    const target = deriveProtectedTailTokenTarget(args);
    const state = getProtectedTailDrainBudgetSkip({
        ...args,
        usable: target.usable,
        perRunCap: selectPerRunCap({ ...args, N: target.N }),
    });
    if (!state) return false;
    let windows = loggedWindows.get(args.db);
    if (!windows) {
        windows = new Map();
        loggedWindows.set(args.db, windows);
    }
    if (windows.get(args.sessionId) !== state.resetsAt) {
        windows.set(args.sessionId, state.resetsAt);
        sessionLog(
            args.sessionId,
            `historian skip: internal drain budget spent (${state.spentTokens}/${state.limitTokens} tokens); next eligible at ${new Date(state.nextEligibleAt).toISOString()}`,
        );
    }
    return true;
}
