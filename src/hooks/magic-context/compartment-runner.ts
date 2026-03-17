import { runCompartmentAgent } from "./compartment-runner-incremental";
import { executeContextRecompInternal } from "./compartment-runner-recomp";
import type { CompartmentRunnerDeps } from "./compartment-runner-types";

const activeRuns = new Map<string, Promise<void>>();

export function getActiveCompartmentRun(sessionId: string): Promise<void> | undefined {
    return activeRuns.get(sessionId);
}

export function startCompartmentAgent(deps: CompartmentRunnerDeps): void {
    const existing = activeRuns.get(deps.sessionId);
    if (existing) {
        return;
    }

    const promise = runCompartmentAgent(deps).finally(() => {
        activeRuns.delete(deps.sessionId);
    });
    activeRuns.set(deps.sessionId, promise);
}

export async function executeContextRecomp(deps: CompartmentRunnerDeps): Promise<string> {
    const { sessionId } = deps;
    if (activeRuns.has(sessionId)) {
        return "## Magic Recomp\n\nHistorian is already running for this session. Wait for it to finish, then try `/ctx-recomp` again.";
    }

    const promise = executeContextRecompInternal(deps);
    activeRuns.set(
        sessionId,
        promise.then(() => undefined),
    );
    try {
        return await promise;
    } finally {
        activeRuns.delete(sessionId);
    }
}

export { runCompartmentAgent } from "./compartment-runner-incremental";
