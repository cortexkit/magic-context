import {
    acquireCompartmentLease,
    COMPARTMENT_LEASE_RENEWAL_MS,
    releaseCompartmentLease,
    renewCompartmentLease,
} from "../../features/magic-context/compartment-lease";
import { updateSessionMeta } from "../../features/magic-context/storage-meta";
import { sessionLog } from "../../shared/logger";
import { runCompartmentAgent } from "./compartment-runner-incremental";
import {
    executePartialRecompInternal,
    type PartialRecompRange,
} from "./compartment-runner-partial-recomp";
import { executeContextRecompInternal } from "./compartment-runner-recomp";
import type { CompartmentRunnerDeps } from "./compartment-runner-types";

export interface ActiveCompartmentRun {
    promise: Promise<void>;
    published: boolean;
    /**
     * Set to true once the 95%-emergency user-facing notification has been
     * dispatched for this run. Prevents the notification from re-firing on
     * every subsequent transform pass while the same compartment run is
     * still active — which would otherwise persist a fresh ignored user
     * message every pass and drive OpenCode's runLoop break condition false.
     */
    notificationSent?: boolean;
}

const activeRuns = new Map<string, ActiveCompartmentRun>();

export function getActiveCompartmentRun(sessionId: string): ActiveCompartmentRun | undefined {
    return activeRuns.get(sessionId);
}

export function markActiveCompartmentRunPublished(sessionId: string): void {
    const activeRun = activeRuns.get(sessionId);
    if (activeRun) activeRun.published = true;
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
export function registerActiveCompartmentRun(
    sessionId: string,
    promise: Promise<void>,
): ActiveCompartmentRun {
    const activeRun: ActiveCompartmentRun = {
        promise: Promise.resolve(),
        published: false,
    };
    const wrapped = promise.finally(() => {
        // Only clear if this is still the current entry (another run may have
        // replaced us if the caller overwrote; don't stomp the replacement).
        if (activeRuns.get(sessionId)?.promise === wrapped) {
            activeRuns.delete(sessionId);
        }
    });
    activeRun.promise = wrapped;
    activeRuns.set(sessionId, activeRun);
    return activeRun;
}

function withPublishedCallback(deps: CompartmentRunnerDeps): CompartmentRunnerDeps {
    return {
        ...deps,
        onCompartmentStatePublished: (sid) => {
            markActiveCompartmentRunPublished(sid);
            deps.onCompartmentStatePublished?.(sid);
        },
    };
}

function startLeaseRenewal(
    deps: CompartmentRunnerDeps,
    holderId: string,
): ReturnType<typeof setInterval> {
    return setInterval(() => {
        if (!renewCompartmentLease(deps.db, deps.sessionId, holderId)) {
            sessionLog(
                deps.sessionId,
                "compartment lease renewal failed; publish will be skipped if holder is stale",
            );
        }
    }, COMPARTMENT_LEASE_RENEWAL_MS);
}

export function startCompartmentAgent(deps: CompartmentRunnerDeps): void {
    // Intentional: this check-then-set is safe in Bun's single-threaded event loop.
    // The synchronous code between activeRuns.get() and activeRuns.set() cannot interleave,
    // so another start for the same session cannot sneak in here.
    const existing = activeRuns.get(deps.sessionId);
    if (existing) {
        return;
    }

    const holderId = crypto.randomUUID();
    const lease = acquireCompartmentLease(deps.db, deps.sessionId, holderId);
    if (!lease) {
        sessionLog(
            deps.sessionId,
            "compartment agent skipped: compartment lease held by another process",
        );
        // The DB lease is the cross-process authority. If this process set the
        // start-intent flag but did not win the lease, no local run will clear it;
        // release the intent so later passes can retry instead of starving.
        updateSessionMeta(deps.db, deps.sessionId, { compartmentInProgress: false });
        return;
    }
    const renewal = startLeaseRenewal(deps, holderId);

    // Track the real underlying promise — NOT a raced wrapper.
    // This ensures activeRuns.has(sessionId) stays true until the historian run
    // actually completes, preventing duplicate runs even if an external await times out.
    let realRunStarted = false;
    const runnerDeps = withPublishedCallback({
        ...deps,
        compartmentLeaseHolderId: holderId,
        onHistorianRunStarted: () => {
            realRunStarted = true;
        },
    });
    const promise = runCompartmentAgent(runnerDeps)
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
            clearInterval(renewal);
            releaseCompartmentLease(deps.db, deps.sessionId, holderId);
            if (activeRuns.get(deps.sessionId)?.promise === promise) {
                activeRuns.delete(deps.sessionId);
            }
        });
    activeRuns.set(deps.sessionId, { promise, published: false });
    // If the runner no-op'd synchronously (stale/empty snapshot, nothing to
    // compact, drain-quota), it returned before signalling onHistorianRunStarted
    // and before any `await`, so `promise` is already settling. It cleared
    // compartmentInProgress in its own finally, but the activeRuns entry above
    // would otherwise survive (cleared only by the microtask-scheduled
    // promise.finally) and make the SAME transform pass treat a non-running
    // historian as in-progress — deferring queued drop ops and starving them
    // turn after turn (the production livelock). Drop the registration
    // synchronously so pending ops can materialize this pass. The promise.finally
    // below still runs for interval/lease cleanup; its `=== promise` guard makes
    // the (now redundant) delete a no-op.
    if (!realRunStarted && activeRuns.get(deps.sessionId)?.promise === promise) {
        activeRuns.delete(deps.sessionId);
    }
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

export interface ExecuteContextRecompResult {
    message: string;
    published: boolean;
}

export async function executeContextRecompWithResult(
    deps: CompartmentRunnerDeps,
    options: ExecuteContextRecompOptions = {},
): Promise<ExecuteContextRecompResult> {
    const { sessionId } = deps;
    if (activeRuns.has(sessionId)) {
        return {
            // "— Skipped" suffix so isRecompFailure() (string-based callers) treats
            // this as a non-success and never proceeds to migration / "complete"
            // on it (dogfood 2026-05-30). The `published:false` flag is the robust
            // primary signal; this heading is defense-in-depth.
            message:
                "## Magic Recomp — Skipped\n\nHistorian is already running for this session. Wait for it to finish, then try `/ctx-recomp` again.",
            published: false,
        };
    }

    const holderId = crypto.randomUUID();
    const lease = acquireCompartmentLease(deps.db, sessionId, holderId);
    if (!lease) {
        sessionLog(sessionId, "recomp skipped: compartment lease held by another process");
        return {
            message:
                "## Magic Recomp — Skipped\n\nAnother process is already mutating compartment state for this session. Wait for it to finish, then try `/ctx-recomp` again.",
            published: false,
        };
    }
    const renewal = startLeaseRenewal(deps, holderId);
    const runnerDeps = withPublishedCallback({ ...deps, compartmentLeaseHolderId: holderId });
    const promise = options.range
        ? executePartialRecompInternal(runnerDeps, options.range)
        : executeContextRecompInternal(runnerDeps);
    const wrappedPromise = promise
        .then(() => undefined)
        .catch((err) => {
            sessionLog(sessionId, "compartment agent: recomp unhandled rejection:", err);
        });
    activeRuns.set(sessionId, { promise: wrappedPromise, published: false });
    try {
        const message = await promise;
        // B1 (dogfood 2026-05-30): log EVERY recomp outcome here — this wraps all
        // ~12 return paths in the runner, so a silently-non-publishing recomp is
        // now always diagnosable from the log. The returned message carries the
        // reason inline (e.g. "## Magic Recomp — Failed\n\n<reason>").
        const published = activeRuns.get(sessionId)?.published === true;
        const outcomeSummary = message.replace(/\s+/g, " ").trim().slice(0, 240);
        sessionLog(sessionId, `recomp finished (published=${published}): ${outcomeSummary}`);
        return {
            message,
            published,
        };
    } finally {
        clearInterval(renewal);
        releaseCompartmentLease(deps.db, sessionId, holderId);
        if (activeRuns.get(sessionId)?.promise === wrappedPromise) {
            activeRuns.delete(sessionId);
        }
    }
}

export async function executeContextRecomp(
    deps: CompartmentRunnerDeps,
    options: ExecuteContextRecompOptions = {},
): Promise<string> {
    return (await executeContextRecompWithResult(deps, options)).message;
}

export { runCompartmentAgent } from "./compartment-runner-incremental";
export type { PartialRecompRange } from "./compartment-runner-partial-recomp";
