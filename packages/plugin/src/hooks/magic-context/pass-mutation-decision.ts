import { type ReclaimRideSignals, reclaimRidePermitted } from "./cache-busting-signals";

/**
 * The pressure bands a pass sits in. `forceMaterialization` is primary-only (it
 * also forces m[0] materialization); the emergency tool floor applies to primary
 * and subagent sessions alike. Compaction-off sessions are in neither band.
 */
export function pressureBands(args: {
    fullFeatureMode: boolean;
    compactionOff: boolean;
    contextPercentage: number;
    forceMaterializationPercentage: number;
}): { forceMaterialization: boolean; emergencyDropEligible: boolean } {
    const emergencyDropEligible =
        !args.compactionOff && args.contextPercentage >= args.forceMaterializationPercentage;
    return {
        forceMaterialization: args.fullFeatureMode && emergencyDropEligible,
        emergencyDropEligible,
    };
}

/** Everything the OpenCode postprocess phase knows when it decides whether a pass may mutate. */
export interface PassMutationInput {
    /** Primary session (true) or subagent (false). */
    fullFeatureMode: boolean;
    compactionOff: boolean;
    schedulerDecision: "execute" | "defer";
    contextPercentage: number;
    forceMaterializationPercentage: number;
    /** The usage reading came from a local count, not from the provider. */
    contextUsageFromEstimate: boolean;
    /**
     * The persisted force-episode sample; above zero once an emergency batch acted in
     * the current force-band stay. Read lazily, only when the force band needs it.
     */
    emergencyInputSample: () => number;
    /** Trigger parking still allows the force band to take its ride. */
    forceTriggerPermitted: boolean;
    servedShapeRepair: boolean;
    rewritingSignedPrefix: boolean;
    /** An executed fold changed the served prefix. */
    foldBustsServedPrefix: boolean;
    /** No complete cached m[0]/m[1] pair exists, so this pass renders the head for the first time. */
    firstRenderBust: boolean;
    /** The provider cache expired and the pass may rebuild for it. */
    idleExpiryRebuild: boolean;
    /** The same expiry on a pass held for recent signed thinking. */
    heldIdleExpiryRebuild: boolean;
    /** A user `/ctx-flush` is pending. */
    explicitFlush: boolean;
    /** Freshly published history changed the served m[1] bytes. */
    publishedHistory: boolean;
    historyRebuiltThisPass: boolean;
    materializationRequested: boolean;
    alreadyRanThisTurn: boolean;
    /** The pass is held for recent signed thinking. */
    signedThinkingHold: boolean;
}

export interface PassMutationDecision {
    forceMaterialization: boolean;
    emergencyDropEligible: boolean;
    rideSignals: Required<ReclaimRideSignals>;
    /** The one permission every first-application lane and the m[1] refresh consult. */
    publishedWorkDrainAllowed: boolean;
    shouldApplyPendingOps: boolean;
    shouldRunHeuristics: boolean;
    isCacheBustingPass: boolean;
    /** Age sweep, spent-output supersession and superseded-edit compression may first-apply. */
    toolReclaimAdmitted: boolean;
}

/**
 * Decide whether this pass may change the provider-visible prefix and which lane
 * families may first-apply on it. `executeReclaim` is asked last, with every other
 * ride already known, because a primary execute pass only rebuilds for queued work
 * when nothing else is rebuilding and no summary can come; it owns the persisted
 * held-pass counter, so it is called at most once per pass and never in
 * compaction-off mode.
 */
export function decidePassMutation(
    input: PassMutationInput,
    executeReclaim: (args: { primaryExecute: boolean; alreadyBusting: boolean }) => boolean,
): PassMutationDecision {
    const { forceMaterialization, emergencyDropEligible } = pressureBands(input);
    const rideSignals: Required<ReclaimRideSignals> = {
        servedShapeRepair: input.servedShapeRepair,
        executeReclaim: false,
        subagentExecute: !input.fullFeatureMode && input.schedulerDecision === "execute",
        hardFold:
            input.rewritingSignedPrefix ||
            input.foldBustsServedPrefix ||
            input.firstRenderBust ||
            input.idleExpiryRebuild,
        // A reading that only a local count put in the force band is not
        // evidence the session is there: the count can overstate the provider.
        // Below 95% it waits for the provider's next measurement instead of
        // rewriting the cache on its own. At 95% or more it still rides, since
        // waiting there risks the next request not fitting.
        force:
            emergencyDropEligible &&
            (input.contextPercentage >= 95 ||
                (input.forceTriggerPermitted &&
                    !input.contextUsageFromEstimate &&
                    input.emergencyInputSample() === 0)),
        explicitFlush: input.explicitFlush,
        publishedHistory: input.publishedHistory,
    };
    rideSignals.executeReclaim =
        !input.compactionOff &&
        executeReclaim({
            primaryExecute:
                input.fullFeatureMode &&
                input.schedulerDecision === "execute" &&
                input.contextPercentage < input.forceMaterializationPercentage,
            alreadyBusting:
                Object.values(rideSignals).some(Boolean) || input.historyRebuiltThisPass,
        });
    // Warm-cache thinking holds defer every new prefix edit. First render, idle
    // expiry and pressure relief can admit work, but the target guards still
    // forbid changes before any retained signature.
    const publishedWorkDrainAllowed =
        (!input.compactionOff || input.servedShapeRepair) &&
        reclaimRidePermitted(rideSignals, {
            signedThinkingHold: input.signedThinkingHold,
            firstRender: input.firstRenderBust,
            idleExpiry: input.idleExpiryRebuild,
            emergency: emergencyDropEligible,
        });
    const shouldApplyPendingOps = !input.compactionOff && publishedWorkDrainAllowed;
    const shouldRunHeuristics =
        !input.compactionOff &&
        publishedWorkDrainAllowed &&
        (rideSignals.publishedHistory ||
            rideSignals.executeReclaim ||
            rideSignals.servedShapeRepair ||
            input.materializationRequested ||
            forceMaterialization ||
            // The off-wire fold changed the served prefix, so the prefix already
            // busted. Heuristics may ride it and bypass the once-per-turn guard
            // without creating an independent prefix rewrite.
            input.foldBustsServedPrefix ||
            input.firstRenderBust ||
            input.heldIdleExpiryRebuild ||
            // The force band's emergency floor, for primary and subagent alike. For a
            // primary it coincides with forceMaterialization; for a subagent it is the
            // only path that fires the tiered drop even when the scheduler defers.
            emergencyDropEligible ||
            (input.schedulerDecision === "execute" &&
                (!input.alreadyRanThisTurn || !input.fullFeatureMode)));
    return {
        forceMaterialization,
        emergencyDropEligible,
        rideSignals,
        publishedWorkDrainAllowed,
        shouldApplyPendingOps,
        shouldRunHeuristics,
        // Every first-application lane and the m[1] refresh use this same permission.
        // It authorizes mutation; individual lanes may still find no eligible work.
        isCacheBustingPass: publishedWorkDrainAllowed,
        // The force band's emergency selector owns tool reclaim there.
        toolReclaimAdmitted: publishedWorkDrainAllowed && !emergencyDropEligible,
    };
}

/**
 * This pass already pays for a rewrite other than the emergency itself: queued drops
 * landed on it (so it is already rebuilding), a fold busts the served prefix, or the
 * history injection was rebuilt. Replaying persisted drop statuses restores bytes
 * already served on every pass, so it never counts.
 */
export function emergencyRewriteAlreadyPriced(args: {
    pendingOpsDidMutate: boolean;
    foldBustsServedPrefix: boolean;
    firstRenderBust: boolean;
    heldIdleExpiryRebuild: boolean;
    historyRebuiltThisPass: boolean;
    compartmentInjectionRebuiltFromDb: boolean;
    rebuiltHistoryFromInitialPrepare: boolean;
}): boolean {
    return (
        args.pendingOpsDidMutate ||
        args.foldBustsServedPrefix ||
        args.firstRenderBust ||
        args.heldIdleExpiryRebuild ||
        args.historyRebuiltThisPass ||
        args.compartmentInjectionRebuiltFromDb ||
        args.rebuiltHistoryFromInitialPrepare
    );
}

/**
 * An independent mutation already prices this pass, so a spent force episode
 * re-arms and every candidate accumulated during sustained pressure rides it.
 */
export function emergencyEpisodeRearms(args: {
    emergencyDropEligible: boolean;
    rewriteAlreadyPriced: boolean;
    emergencyInputSample: () => number;
}): boolean {
    return (
        args.emergencyDropEligible && args.rewriteAlreadyPriced && args.emergencyInputSample() > 0
    );
}

/**
 * Whether ordinary dedup, injection stripping, caveman and reasoning cleanup may
 * first-apply when heuristics run. Force-originated rewrites share one durable
 * episode; a primary runs routine cleanup once per execute-pressure stretch; a
 * requested materialization or an already priced rewrite admits it outright.
 */
export function routineCleanupAdmitted(args: {
    emergencyDropEligible: boolean;
    contextPercentage: number;
    emergencyInputSample: () => number;
    fullFeatureMode: boolean;
    routinePressureAlreadyApplied: boolean;
    materializationRequested: boolean;
    rewriteAlreadyPriced: boolean;
}): boolean {
    return (
        (args.emergencyDropEligible
            ? args.contextPercentage >= 95 || args.emergencyInputSample() === 0
            : !args.fullFeatureMode || !args.routinePressureAlreadyApplied) ||
        args.materializationRequested ||
        args.rewriteAlreadyPriced
    );
}
