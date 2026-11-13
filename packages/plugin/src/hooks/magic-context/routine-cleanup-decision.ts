import { BoundedSessionMap } from "../../shared/bounded-session-map";
import type { ReclaimRideSignals } from "./cache-busting-signals";
import type { MessageLike } from "./tag-messages";

/**
 * Whether a pass runs its heuristics and routine cleanup lanes (dedup,
 * supersession, injection strip and reasoning clearing beyond the keep budget).
 *
 * The postprocess phase decides this. A priced pass that the provider has not
 * measured predicts the same decision before it is sized (priced-pass-sizing.ts),
 * so the reasoning it counts is the reasoning it then serves. Both read these
 * functions, so the prediction cannot drift from the decision.
 */

export interface PressureBands {
    /** Primary sessions only: the force band also forces an m[0] materialization. */
    forceMaterialization: boolean;
    /** Usage in the force band, for primary sessions and subagents alike. */
    emergencyDropEligible: boolean;
    /**
     * A reading that only a local count put in the force band can overstate the
     * provider, and a provider that reports no usage never sends the measurement
     * that would confirm it. Below 95% such a reading is therefore not
     * force-band pressure: it takes no force ride, lifts no signed-thinking hold
     * and runs no tiered emergency tool drop. A rebuild the pass makes for
     * another reason (such as the execute pass's own bounded rebuild) carries
     * only queued drops and routine cleanup.
     */
    forceRideWaitsOnLocalCount: boolean;
    forceBandConfirmed: boolean;
    /** Usage at or above the execute threshold or in the force band: a pressure episode. */
    executePressureEligible: boolean;
}

/** The inputs that place a pass's usage reading in the force band. */
export interface ForceBandReading {
    percentage: number;
    /** The reading was raised only by a local count. */
    fromEstimate: boolean;
    forceMaterializationPercentage: number;
    compactionOff: boolean;
}

function forceBandOf(args: ForceBandReading) {
    const emergencyDropEligible =
        !args.compactionOff && args.percentage >= args.forceMaterializationPercentage;
    const forceRideWaitsOnLocalCount = args.fromEstimate && args.percentage < 95;
    return {
        emergencyDropEligible,
        forceRideWaitsOnLocalCount,
        forceBandConfirmed: emergencyDropEligible && !forceRideWaitsOnLocalCount,
    };
}

/**
 * Whether the reading is force-band pressure: the predicate that lets a pass
 * held for signed thinking rewrite its prefix (`PressureBands.forceBandConfirmed`).
 * The signed-thinking hold reads the same predicate and ends where it holds, so
 * the hold and the rewrite permission cannot disagree about a pass.
 */
export function forceBandConfirmed(args: ForceBandReading): boolean {
    return forceBandOf(args).forceBandConfirmed;
}

export function pressureBands(
    args: ForceBandReading & {
        fullFeatureMode: boolean;
        schedulerDecision: "execute" | "defer";
    },
): PressureBands {
    const band = forceBandOf(args);
    return {
        forceMaterialization: args.fullFeatureMode && band.emergencyDropEligible,
        emergencyDropEligible: band.emergencyDropEligible,
        forceRideWaitsOnLocalCount: band.forceRideWaitsOnLocalCount,
        forceBandConfirmed: band.forceBandConfirmed,
        executePressureEligible: args.schedulerDecision === "execute" || band.emergencyDropEligible,
    };
}

/**
 * The force ride. A reading that only a local count put in the force band is
 * not evidence the session is there: the count can overstate the provider.
 * Below 95% it waits for the provider's next measurement instead of rewriting
 * the cache on its own. At 95% or more it still rides, since waiting there
 * risks the next request not fitting.
 */
export function forceRide(args: {
    bands: PressureBands;
    percentage: number;
    fromEstimate: boolean;
    /** The input tokens recorded when the episode's emergency batch ran; 0 when none ran. */
    emergencySample: () => number;
    /**
     * False while a force trigger is parked behind kept signed thinking
     * (trigger-parking.ts); below 95% the ride then waits as well. Omitted
     * where no trigger can be parked.
     */
    triggerPermitted?: boolean;
}): boolean {
    return (
        args.bands.emergencyDropEligible &&
        (args.percentage >= 95 ||
            (args.triggerPermitted !== false && !args.fromEstimate && args.emergencySample() === 0))
    );
}

/** Whether the pass runs heuristics at all, given its rebuild permission. */
export function heuristicsRunOnPass(args: {
    compactionOff: boolean;
    /** The pass's rebuild permission (`reclaimRidePermitted`). */
    drainAllowed: boolean;
    rides: ReclaimRideSignals;
    materializationRequested: boolean;
    bands: PressureBands;
    foldBustsServedPrefix: boolean;
    firstRender: boolean;
    schedulerDecision: "execute" | "defer";
    alreadyRanThisTurn: boolean;
    fullFeatureMode: boolean;
}): boolean {
    return (
        !args.compactionOff &&
        args.drainAllowed &&
        (args.rides.publishedHistory ||
            args.rides.executeReclaim === true ||
            args.rides.servedShapeRepair === true ||
            args.materializationRequested ||
            args.bands.forceMaterialization ||
            // The off-wire fold changed the served prefix, so the prefix already
            // busted. Heuristics may ride it and bypass the once-per-turn guard
            // without creating an independent prefix rewrite.
            args.foldBustsServedPrefix ||
            args.firstRender ||
            // The force band's emergency floor, for primary sessions and
            // subagents. For a primary session it coincides with
            // forceMaterialization; for a subagent it is the only path that fires
            // the tiered drop even when the ordinary scheduler defers.
            args.bands.emergencyDropEligible ||
            (args.schedulerDecision === "execute" &&
                (!args.alreadyRanThisTurn || !args.fullFeatureMode)))
    );
}

/**
 * Whether a pass whose heuristics run also runs the routine lanes. A primary
 * session runs them once per pressure episode, unless another rewrite already
 * pays for the pass. Force-originated tool and text rewrites share the durable
 * episode, so a small pressure dip or a process restart cannot rearm just the
 * text lane; independent work and the absolute emergency still admit all lanes.
 */
export function routineCleanupRunsOnPass(args: {
    bands: Pick<PressureBands, "forceBandConfirmed">;
    percentage: number;
    emergencySample: () => number;
    fullFeatureMode: boolean;
    routinePressureAlreadyApplied: boolean;
    materializationRequested: boolean;
    /** Newly applied drops, a fold that busts the served prefix, a first render or a rebuilt history injection. */
    rewriteAlreadyPriced: boolean;
}): boolean {
    return (
        (args.bands.forceBandConfirmed
            ? args.percentage >= 95 || args.emergencySample() === 0
            : !args.fullFeatureMode || !args.routinePressureAlreadyApplied) ||
        args.materializationRequested ||
        args.rewriteAlreadyPriced
    );
}

// Bounded (LRU, max 100) so a crashed or never-reset session can't leak an
// entry forever in a long-running process, like the other per-session caches.
const routinePressureAppliedBySession = new BoundedSessionMap<boolean>(100);

export function heuristicsAlreadyRanThisTurn(
    lastHeuristicsTurnId: ReadonlyMap<string, string>,
    sessionId: string,
    currentTurnId: string | null,
): boolean {
    return currentTurnId !== null && lastHeuristicsTurnId.get(sessionId) === currentTurnId;
}

/**
 * Whether a primary session already ran its routine lanes in this pressure
 * episode. The shared once-per-turn map proves an earlier pass in the episode
 * ran even when this process-local episode map is cold.
 */
export function routinePressureAlreadyApplied(
    sessionId: string,
    args: {
        fullFeatureMode: boolean;
        executePressureEligible: boolean;
        alreadyRanThisTurn: boolean;
    },
): boolean {
    return (
        args.fullFeatureMode &&
        args.executePressureEligible &&
        (args.alreadyRanThisTurn || routinePressureAppliedBySession.get(sessionId) === true)
    );
}

/** Ends the episode when usage leaves it, and records an earlier pass of this turn. */
export function updateRoutinePressureEpisode(
    sessionId: string,
    args: {
        fullFeatureMode: boolean;
        executePressureEligible: boolean;
        alreadyRanThisTurn: boolean;
    },
): void {
    if (!args.executePressureEligible) routinePressureAppliedBySession.delete(sessionId);
    else if (args.fullFeatureMode && args.alreadyRanThisTurn)
        routinePressureAppliedBySession.set(sessionId, true);
}

export function markRoutinePressureApplied(sessionId: string): void {
    routinePressureAppliedBySession.set(sessionId, true);
}

export function forgetRoutinePressureEpisode(sessionId: string): void {
    routinePressureAppliedBySession.delete(sessionId);
}

/**
 * Save this session's episode flag; the returned function puts it back. A pass
 * whose edit transaction rolls back restores it, so the rolled-back cleanup does
 * not count as the episode's one routine run.
 */
export function snapshotRoutinePressureEpisode(sessionId: string): () => void {
    const before = routinePressureAppliedBySession.get(sessionId);
    return () => {
        if (before === undefined) routinePressureAppliedBySession.delete(sessionId);
        else routinePressureAppliedBySession.set(sessionId, before);
    };
}

/**
 * The highest tag whose reasoning a pass may clear: below every message whose
 * active signed thinking the pass keeps.
 */
export function safeReasoningCutoff(
    messageTagNumbers: ReadonlyMap<MessageLike, number>,
    protectedThinkingMessages: Iterable<MessageLike>,
): number {
    let cutoff = 0;
    for (const tag of messageTagNumbers.values()) cutoff = Math.max(cutoff, tag);
    for (const message of protectedThinkingMessages) {
        const tag = messageTagNumbers.get(message);
        if (tag && tag > 0) cutoff = Math.min(cutoff, tag - 1);
    }
    return cutoff;
}
