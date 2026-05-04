import { updateSessionMeta } from "../../features/magic-context/storage-meta";
import { sessionLog } from "../../shared/logger";
import { runCompartmentAgent } from "./compartment-runner-incremental";
import {
    executePartialRecompInternal,
    type PartialRecompRange,
} from "./compartment-runner-partial-recomp";
import { executeContextRecompInternal } from "./compartment-runner-recomp";
import type { CompartmentRunnerDeps } from "./compartment-runner-types";

const activeRuns = new Map<string, Promise<void>>();

export function getActiveCompartmentRun(sessionId: string): Promise<void> | undefined {
    return activeRuns.get(sessionId);
}

/**
 * Register a compartment-state-mutating promise with the active-runs map.
 *
 * Use this to serialize background compressor runs against historian/recomp
 * runs: both read-modify-write compartment rows, and while SQLite serializes
 * individual statements it does NOT serialize multi-step update cycles. If a
 * historian starts while a background compressor is still running, either
 * side's final write can overwrite the other's work.
 *
 * The registered promise is cleared from activeRuns on settle so later passes
 * can start a new run. If a run is already registered for the session, the
 * caller is expected to have checked getActiveCompartmentRun() first and
 * bailed — this function will overwrite silently if called anyway, which is
 * the desired behavior for the retry path.
 */
export function registerActiveCompartmentRun(sessionId: string, promise: Promise<void>): void {
    const wrapped = promise.finally(() => {
        // Only clear if this is still the current entry (another run may have
        // replaced us if the caller overwrote; don't stomp the replacement).
        if (activeRuns.get(sessionId) === wrapped) {
            activeRuns.delete(sessionId);
        }
    });
    activeRuns.set(sessionId, wrapped);
}

export function startCompartmentAgent(deps: CompartmentRunnerDeps): void {
    // Intentional: this check-then-set is safe in Bun's single-threaded event loop.
    // The synchronous code between activeRuns.get() and activeRuns.set() cannot interleave,
    // so another start for the same session cannot sneak in here.
    const existing = activeRuns.get(deps.sessionId);
    if (existing) {
        return;
    }

    // Track the real underlying promise — NOT a raced wrapper.
    // This ensures activeRuns.has(sessionId) stays true until the historian run
    // actually completes, preventing duplicate runs even if an external await times out.
    const promise = runCompartmentAgent(deps)
        .catch((err) => {
            sessionLog(deps.sessionId, "compartment agent: unhandled rejection:", err);
            // Ensure compartmentInProgress is cleared on any failure
            try {
                updateSessionMeta(deps.db, deps.sessionId, { compartmentInProgress: false });
            } catch {
                // best effort
            }
        })
        .finally(() => {
            activeRuns.delete(deps.sessionId);
        });
    activeRuns.set(deps.sessionId, promise);
}

export interface ExecuteContextRecompOptions {
    /**
     * Optional partial range (inclusive raw message ordinals). When provided,
     * runs partial recomp — snaps to enclosing compartment boundaries and
     * rebuilds only the matching compartments, preserving prior/tail
     * compartments and all session facts.
     *
     * When omitted, runs full recomp from message 1 to the protected tail,
     * replacing all compartments and facts.
     */
    range?: PartialRecompRange;
}

export async function executeContextRecomp(
    deps: CompartmentRunnerDeps,
    options: ExecuteContextRecompOptions = {},
): Promise<string> {
    const { sessionId } = deps;
    if (activeRuns.has(sessionId)) {
        return "## Magic Recomp\n\nHistorian is already running for this session. Wait for it to finish, then try `/ctx-recomp` again.";
    }

    const promise = options.range
        ? executePartialRecompInternal(deps, options.range)
        : executeContextRecompInternal(deps);
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
export type { PartialRecompRange } from "./compartment-runner-partial-recomp";
