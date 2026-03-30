import { sessionLog } from "../../shared/logger";
import { runCompartmentAgent } from "./compartment-runner-incremental";
import { executeContextRecompInternal } from "./compartment-runner-recomp";
import type { CompartmentRunnerDeps } from "./compartment-runner-types";

const activeRuns = new Map<string, Promise<void>>();

export function getActiveCompartmentRun(sessionId: string): Promise<void> | undefined {
    return activeRuns.get(sessionId);
}

export function startCompartmentAgent(deps: CompartmentRunnerDeps): void {
    // Intentional: this check-then-set is safe in Bun's single-threaded event loop.
    // The synchronous code between activeRuns.get() and activeRuns.set() cannot interleave,
    // so another start for the same session cannot sneak in here.
    const existing = activeRuns.get(deps.sessionId);
    if (existing) {
        return;
    }

    const promise = runCompartmentAgent(deps)
        .catch((err) => {
            sessionLog(deps.sessionId, "compartment agent: unhandled rejection:", err);
        })
        .finally(() => {
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
        promise
            .then(() => undefined)
            .catch((err) => {
                sessionLog(sessionId, "compartment agent: recomp unhandled rejection:", err);
            }),
    );
    try {
        return await promise;
    } finally {
        activeRuns.delete(sessionId);
    }
}

export { runCompartmentAgent } from "./compartment-runner-incremental";
