import { escalationBands } from "../../shared/escalation-bands";

export interface DeferredConsumptionArgs {
    schedulerDecision: "execute" | "defer";
    contextPercentage: number;
    /** True when this pass awaited a run that actually published new compartment state. */
    justAwaitedPublication: boolean;
    /** Legacy caller observation; published-work consumption does not depend on it. */
    activeRunBlocksMaterialization: boolean;
    forceMaterializationPercentage?: number;
}

export function canConsumeDeferredOnThisPass(args: DeferredConsumptionArgs): boolean {
    if (args.justAwaitedPublication) return true;
    // Published rows are immutable input to rendering. The historian reads raw
    // harness history, so an in-flight run cannot veto draining published work.

    return (
        args.schedulerDecision === "execute" ||
        args.contextPercentage >=
            (args.forceMaterializationPercentage ??
                escalationBands(65).forceMaterializationPercentage)
    );
}

export interface MaterializationPassSignals {
    /** True when this transform pass successfully wrote fresh cached m[0] bytes. */
    m0RematerializedThisPass: boolean;
    /** True when retry exhaustion forced fallback to a previous cached m[0]. */
    materializationContentionRetryExhausted: boolean;
    /** True when postprocess observed newer m0_mutation_log ids than cached m[0]. */
    m0MutationDriftDetected: boolean;
}

/**
 * The signals that can independently authorize an automatic reduction to
 * run: a hard fold, a forced reduction, an explicit flush, and freshly published
 * history. Each is a cache bust the session is already paying for, so a
 * reduction riding one adds no further prefix rewrite of its own. Subagents
 * have no historian or history fold, so their execute pass is the shared ride
 * for all eligible cleanup. Primary execute can originate the separately
 * admitted, worthwhile executeReclaim ride when no summary is expected.
 * Permission alone must not rewrite any bytes.
 */
export interface ReclaimRideSignals {
    hardFold: boolean;
    force: boolean;
    explicitFlush: boolean;
    publishedHistory: boolean;
    subagentExecute?: boolean;
    executeReclaim?: boolean;
    servedShapeRepair?: boolean;
}

/** Primary execute reclaim must first satisfy the bounded queue/historian admission policy. */
export function hasReclaimRide(signals: ReclaimRideSignals): boolean {
    return (
        signals.hardFold ||
        signals.force ||
        signals.explicitFlush ||
        signals.publishedHistory ||
        signals.subagentExecute === true ||
        signals.executeReclaim === true ||
        signals.servedShapeRepair === true
    );
}

/**
 * What decides whether a pass held for recent signed thinking may still take a
 * ride. Such a pass keeps its prefix unchanged, so only a first render (which
 * rebuilds the prefix anyway) and emergency pressure admit work on it. An
 * expired provider cache does not: resending the same bytes keeps the signed
 * thinking valid, so the hold stands.
 */
export interface ReclaimRidePermissionGate {
    signedThinkingHold: boolean;
    firstRender: boolean;
    emergency: boolean;
}

/** Whether the pass may change its prefix at all, before any ride is considered. */
export function prefixMutationPermitted(gate: ReclaimRidePermissionGate): boolean {
    return !gate.signedThinkingHold || gate.firstRender || gate.emergency;
}

/**
 * The one permission every automatic reduction lane uses. The historian's
 * redundancy skip must use it too: crediting a ride the pass cannot take skips
 * the summarizer while the queued drops it counted on stay queued.
 */
export function reclaimRidePermitted(
    signals: ReclaimRideSignals,
    gate: ReclaimRidePermissionGate,
): boolean {
    return prefixMutationPermitted(gate) && hasReclaimRide(signals);
}

const RECLAIM_RIDE_NAMES = [
    "hardFold",
    "force",
    "explicitFlush",
    "publishedHistory",
    "subagentExecute",
    "executeReclaim",
    "servedShapeRepair",
] as const;

/**
 * Names the ride signals that actually granted permission to mutate, for the
 * logs that announce that permission. The permission is `reclaimRidePermitted`
 * (a ride from `hasReclaimRide` that the pass may take), so a
 * log naming anything else sends whoever reads it to the wrong cause: a drain
 * granted by freshly published history used to be reported as
 * "reason=scheduler_execute", which is a different signal entirely and was not
 * even true on the passes that printed it.
 */
export function reclaimRideLabel(signals: ReclaimRideSignals): string {
    const active = RECLAIM_RIDE_NAMES.filter((name) => signals[name]);
    return `ride=${active.length > 0 ? active.join("+") : "none"}`;
}
