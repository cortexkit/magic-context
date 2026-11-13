import {
    hostInstructionRetentionEnabled,
    isHostInstructionRetentionOn,
} from "../../features/magic-context/storage-host-instruction-retention";
import {
    getEmergencyInputSample,
    getMergedReasoningStrippedIds,
    THINKING_BINDING_RECOVERY_FROZEN_PREFIX,
} from "../../features/magic-context/storage-meta-persisted";
import { getReasoningRemovalState } from "../../features/magic-context/storage-reasoning-removal";
import { TagOwnerSummaryNotReady } from "../../features/magic-context/storage-tags";
import { isRecord } from "../../shared/record-type-guard";
import type { Database } from "../../shared/sqlite";
import { type ReclaimRideSignals, reclaimRidePermitted } from "./cache-busting-signals";
import { headMessagesForSizing, type M0M1RenderOptions } from "./inject-compartments";
import { retainedActiveThinkingParts } from "./latest-assistant-turn";
import {
    opencodeReasoningBudgetCutoff,
    projectOpencodeReasoningBudgetCutoff,
} from "./reasoning-budget";
import { removeReasoningParts } from "./reasoning-removal";
import {
    forceRide,
    heuristicsRunOnPass,
    pressureBands,
    routineCleanupRunsOnPass,
    routinePressureAlreadyApplied,
    safeReasoningCutoff,
} from "./routine-cleanup-decision";
import { readingEndsHold } from "./signed-thinking-hold";
import { stripReasoningFromAssistantIds } from "./strip-content";
import type { MessageLike } from "./tag-messages";

const REASONING_PART_TYPES = new Set(["reasoning", "thinking", "redacted_thinking"]);

export interface PricedPassSizingInput {
    db: Database;
    sessionId: string;
    /** The pass's message array as it stands before the postprocess phase. */
    messages: readonly MessageLike[];
    messageTagNumbers: ReadonlyMap<MessageLike, number>;
    /** How the pass renders its history head, or undefined when it serves none. */
    head?: M0M1RenderOptions;
    /** The pass folds m[0], so it serves a head rendered now rather than the persisted one. */
    headFolds: boolean;
    /**
     * OpenCode 2 instruction rows the history summary covers, which the pass
     * took out of the array when it started. Empty on every other host.
     */
    coveredInstructions: readonly MessageLike[];
    /**
     * Reasoning that earlier passes removed by message id and every pass removes
     * again at the end of its postprocess phase: the stored whole-part removals
     * (when `wholePartRemoval` is on) and the signed-thinking binding strips
     * (when `bindingStrips` is on; compaction-off mode never applies them).
     */
    replayedRemovals: {
        providerID: string | undefined;
        wholePartRemoval: boolean;
        bindingStrips: boolean;
    };
    /**
     * The reasoning keep budget, or undefined when the pass never clears
     * reasoning by age (compaction off, a signed-thinking hold, an unresolved
     * provider or a prefix-bound model).
     */
    reasoning?: {
        keepTokens: number;
        clearedThroughTag: number;
        proseRatio: number;
        /** Messages whose active signed thinking the pass keeps; their reasoning and everything newer stays. */
        protectedThinkingMessages: ReadonlySet<MessageLike>;
    };
}

/** What the pass will do to its request, as far as its size is concerned. */
export interface PricedPassPlan {
    /** The pass may rewrite its whole prefix, so it starts serving covered instruction rows. */
    editsWholePrefix: boolean;
    /** The pass clears reasoning beyond the keep budget. */
    clearsReasoning: boolean;
}

/** The plan with the most content: nothing of the pass's own clearing, every row it may add. */
export const WIDEST_PRICED_PASS_PLAN: PricedPassPlan = {
    editsWholePrefix: true,
    clearsReasoning: false,
};

/**
 * What the postprocess phase will know about its rebuild rides before it runs,
 * for `planPricedPass`.
 */
export interface PricedPassPlanInput {
    db: Database;
    sessionId: string;
    compactionOff: boolean;
    fullFeatureMode: boolean;
    schedulerDecision: "execute" | "defer";
    forceMaterializationPercentage: number;
    /** The pass's signed-thinking hold as decided before the pass was sized. */
    signedThinkingHold: boolean;
    /** An explicit strict hold keeps the signed prefix even under pressure. */
    signedThinkingHoldStrict?: boolean;
    /**
     * The bounded hold's cap (execute threshold plus ten points), when the
     * hold above is that bounded hold; absent for compaction off's blanket
     * hold, which no reading ends.
     */
    signedThinkingHoldCapPercentage?: number;
    /** The pass renders the session's first history head. */
    firstRender: boolean;
    /** The pass folds m[0]. */
    folds: boolean;
    /** A `/ctx-flush` asked for this pass. */
    explicitFlush: boolean;
    /** A flush, or published history the pass consumes. */
    materializationRequested: boolean;
    /** The history injection was rebuilt on this pass before the postprocess phase. */
    historyRebuilt: boolean;
    alreadyRanThisTurn: boolean;
    /**
     * Whether this pass may rebuild the prompt because usage is in the force
     * band (about 85% or more). It is false while a force-band rebuild that an
     * earlier frozen pass had to postpone is still parked
     * (`ParkedBustTriggers.permissions`), and the postprocess phase passes the
     * same permission to `decidePassMutation`. Omitted means permitted.
     */
    forceTriggerPermitted?: boolean;
    /**
     * Whether trigger parking still allows this pass's `/ctx-flush` and
     * materialization request. It is false while a materialization trigger
     * parked on an earlier frozen pass is still parked: the postprocess phase
     * then clears both before it asks `decidePassMutation`
     * (`ParkedBustTriggers.permissions`). Omitted means permitted.
     */
    materializationTriggerPermitted?: boolean;
}

/**
 * Predict, before the pass is sized, whether it will rewrite its whole prefix
 * and whether it will clear reasoning. The postprocess phase makes both
 * decisions later; this asks the same functions it asks, with the rides that
 * are known before it runs.
 *
 * Three rides are known only once the postprocess phase runs: a history refresh
 * that changes m[1] bytes, the execute pass's own bounded rebuild (it counts
 * the queued drops) and a repair of the served shape. They count as absent here,
 * so a pass that takes only one of them is sized with the reasoning it then
 * clears, as a provider reading of the previous request would be.
 *
 * The force ride depends on the reading the sizing produces, so the caller plans
 * from the reading it has before sizing, counts the request that plan serves,
 * and keeps that count only when the plan holds at the reading it gives (see
 * `WIDEST_PRICED_PASS_PLAN` for when no plan holds).
 */
export function planPricedPass(
    input: PricedPassPlanInput,
    usage: { percentage: number; fromEstimate: boolean },
): PricedPassPlan {
    const bands = pressureBands({
        percentage: usage.percentage,
        fromEstimate: usage.fromEstimate,
        forceMaterializationPercentage: input.forceMaterializationPercentage,
        compactionOff: input.compactionOff,
        fullFeatureMode: input.fullFeatureMode,
        schedulerDecision: input.schedulerDecision,
    });
    const emergencySample = () => getEmergencyInputSample(input.db, input.sessionId);
    const materializationPermitted = input.materializationTriggerPermitted !== false;
    // The caller ends a bounded hold after sizing when the sized reading is at
    // or above the hold's cap or in force-band pressure (readingEndsHold), so
    // the plan counts the request that pass then serves.
    const signedThinkingHold =
        input.signedThinkingHold &&
        (input.compactionOff ||
            input.signedThinkingHoldStrict ||
            (input.signedThinkingHoldCapPercentage === undefined
                ? !bands.forceBandConfirmed
                : readingEndsHold({
                      usagePercentage: usage.percentage,
                      capPercentage: input.signedThinkingHoldCapPercentage,
                      forceBandPressure: bands.forceBandConfirmed,
                  }) === null));
    const rides: ReclaimRideSignals = {
        hardFold: input.folds || input.firstRender,
        force: forceRide({
            bands,
            percentage: usage.percentage,
            fromEstimate: usage.fromEstimate,
            emergencySample,
            triggerPermitted: input.forceTriggerPermitted,
        }),
        explicitFlush: input.explicitFlush && materializationPermitted,
        publishedHistory: false,
        subagentExecute: !input.fullFeatureMode && input.schedulerDecision === "execute",
        executeReclaim: false,
        servedShapeRepair: false,
    };
    const drainAllowed =
        !input.compactionOff &&
        reclaimRidePermitted(rides, {
            signedThinkingHold,
            firstRender: input.firstRender,
            emergency: bands.forceBandConfirmed,
        });
    // A held pass drops its flush and published-history requests, and so does a
    // pass whose materialization trigger stays parked.
    const materializationRequested =
        !signedThinkingHold && materializationPermitted && input.materializationRequested;
    const heuristics = heuristicsRunOnPass({
        compactionOff: input.compactionOff,
        drainAllowed,
        rides,
        materializationRequested,
        bands,
        foldBustsServedPrefix: input.folds,
        firstRender: input.firstRender,
        schedulerDecision: input.schedulerDecision,
        alreadyRanThisTurn: input.alreadyRanThisTurn,
        fullFeatureMode: input.fullFeatureMode,
    });
    const routine =
        heuristics &&
        routineCleanupRunsOnPass({
            bands,
            percentage: usage.percentage,
            emergencySample,
            fullFeatureMode: input.fullFeatureMode,
            routinePressureAlreadyApplied: routinePressureAlreadyApplied(input.sessionId, {
                fullFeatureMode: input.fullFeatureMode,
                executePressureEligible: bands.executePressureEligible,
                alreadyRanThisTurn: input.alreadyRanThisTurn,
            }),
            materializationRequested,
            rewriteAlreadyPriced: input.folds || input.firstRender || input.historyRebuilt,
        });
    return {
        editsWholePrefix: drainAllowed && !signedThinkingHold,
        clearsReasoning: routine && !signedThinkingHold,
    };
}

/**
 * Whether two plans serve the same request for this input: a plan field that
 * changes nothing here (no covered rows to add, no reasoning to clear) does not
 * count.
 */
export function sameSizingPlan(
    input: PricedPassSizingInput,
    a: PricedPassPlan,
    b: PricedPassPlan,
): boolean {
    const rowsDiffer =
        a.editsWholePrefix !== b.editsWholePrefix &&
        input.coveredInstructions.length > 0 &&
        hostInstructionRetentionEnabled() &&
        !isHostInstructionRetentionOn(input.db, input.sessionId);
    const reasoningDiffers =
        a.clearsReasoning !== b.clearsReasoning && input.reasoning !== undefined;
    return !rowsDiffer && !reasoningDiffers;
}

/**
 * The messages whose active signed thinking the postprocess phase keeps, found
 * the way it finds them: the thinking of the active turn that no earlier
 * decision already took off the request.
 */
export function protectedThinkingMessagesForSizing(args: {
    db: Database;
    sessionId: string;
    messages: readonly MessageLike[];
    activeThinkingTurn: boolean;
    providerID: string | undefined;
    modelID: string | undefined;
}): Set<MessageLike> {
    if (!args.activeThinkingTurn) return new Set();
    const mergedIds = getMergedReasoningStrippedIds(args.db, args.sessionId);
    const bindingIds = new Set(
        [...mergedIds]
            .filter((id) => id.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX))
            .map((id) => id.slice(THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length)),
    );
    const retained = retainedActiveThinkingParts({
        messages: [...args.messages],
        providerID: args.providerID,
        modelID: args.modelID,
        mergedIds,
        bindingIds,
        removedIds: getReasoningRemovalState(args.db, args.sessionId).messageIds,
    });
    return new Set(
        args.messages.filter((message) => message.parts.some((part) => retained.has(part))),
    );
}

/**
 * The request a priced pass sizes itself from when the provider has reported
 * no usage for it, under the given plan.
 *
 * The pass is sized before its postprocess phase, which changes the request:
 * it puts the history head (m[0]/m[1]) in front, serves the covered OpenCode 2
 * instruction rows again once it may rewrite its whole prefix, removes the
 * reasoning earlier passes removed by message id, and may clear reasoning
 * beyond the keep budget. A count of the array as it stands misses the head
 * and those rows and still holds that reasoning, so it can read a fraction of
 * the request the pass then sends. This returns the array to count instead.
 *
 * The result is for counting only. A message whose reasoning leaves the
 * request appears as a copy without it; no message the pass serves is changed.
 */
export function servedRequestForSizing(
    input: PricedPassSizingInput,
    plan: PricedPassPlan,
): MessageLike[] {
    const head = input.head ? headMessagesForSizing(input.head, input.headFolds) : [];
    // The postprocess phase serves covered rows once the session's retention
    // switch is on, and turns it on itself on a pass that may rewrite the
    // whole prefix.
    const instructions =
        input.coveredInstructions.length > 0 &&
        hostInstructionRetentionEnabled() &&
        (plan.editsWholePrefix || isHostInstructionRetentionOn(input.db, input.sessionId))
            ? input.coveredInstructions
            : [];
    const removals = replayedReasoningRemovals(input);
    // The same projection of the keep budget the summary trigger reads, capped
    // below any active signed thinking the pass keeps: the reasoning of every
    // message tagged at or below the cutoff leaves the request.
    const cutoff =
        plan.clearsReasoning && input.reasoning
            ? Math.min(
                  safeReasoningCutoff(
                      input.messageTagNumbers,
                      input.reasoning.protectedThinkingMessages,
                  ),
                  clearedReasoningCutoff(input, input.reasoning, removals.messageIds),
              )
            : 0;
    let conversation = withoutReplayedRemovals(input.messages, removals, input);
    if (cutoff > 0)
        conversation = conversation.map((message, index) =>
            withoutClearedReasoning(message, input.messages[index] ?? message, input, cutoff),
        );
    return [...head, ...instructions, ...conversation];
}

interface ReplayedRemovals {
    /** Whole-part removals, applied with `removeReasoningParts`. */
    messageIds: ReadonlySet<string>;
    /** Signed-thinking binding strips, applied with `stripReasoningFromAssistantIds`. */
    bindingIds: ReadonlySet<string>;
}

function replayedReasoningRemovals(input: PricedPassSizingInput): ReplayedRemovals {
    const bindingIds = new Set<string>();
    if (input.replayedRemovals.bindingStrips)
        for (const id of getMergedReasoningStrippedIds(input.db, input.sessionId)) {
            if (!id.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX)) continue;
            const messageId = id.slice(THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length);
            if (messageId.length > 0) bindingIds.add(messageId);
        }
    return {
        messageIds: input.replayedRemovals.wholePartRemoval
            ? getReasoningRemovalState(input.db, input.sessionId).messageIds
            : new Set<string>(),
        bindingIds,
    };
}

/**
 * The messages with the reasoning earlier passes removed taken out, by the same
 * functions the postprocess phase replays them with. Those functions edit the
 * messages they are given, so they get copies, including the provider metadata
 * a removal edits; every message without a removal is the original object.
 */
function withoutReplayedRemovals(
    messages: readonly MessageLike[],
    removals: ReplayedRemovals,
    input: PricedPassSizingInput,
): MessageLike[] {
    if (removals.messageIds.size === 0 && removals.bindingIds.size === 0) return [...messages];
    const copies = messages.map((message) => {
        const id = message.info.id;
        return typeof id === "string" &&
            (removals.messageIds.has(id) || removals.bindingIds.has(id))
            ? countingCopy(message)
            : message;
    });
    const providerID = input.replayedRemovals.providerID;
    stripReasoningFromAssistantIds(copies, providerID, removals.bindingIds);
    removeReasoningParts(copies, removals.messageIds, providerID);
    return copies;
}

function countingCopy(message: MessageLike): MessageLike {
    return {
        ...message,
        parts: message.parts.map((part) => {
            if (!isRecord(part) || !isRecord(part.metadata)) return part;
            return {
                ...part,
                metadata: {
                    ...part.metadata,
                    ...(isRecord(part.metadata.openrouter)
                        ? { openrouter: { ...part.metadata.openrouter } }
                        : {}),
                },
            };
        }),
    };
}

function clearedReasoningCutoff(
    input: PricedPassSizingInput,
    reasoning: NonNullable<PricedPassSizingInput["reasoning"]>,
    removedIds: ReadonlySet<string>,
): number {
    try {
        return projectOpencodeReasoningBudgetCutoff(
            input.db,
            input.sessionId,
            [...input.messages],
            reasoning.keepTokens,
            reasoning.clearedThroughTag,
            reasoning.proseRatio,
        );
    } catch (error) {
        if (!(error instanceof TagOwnerSummaryNotReady)) throw error;
    }
    // The session's tag ownership summary is still being prepared off-thread.
    // It is usually ready by the time the postprocess phase clears reasoning,
    // so project the same cutoff from this pass's own tag numbers, pricing each
    // step from its reasoning text. If the summary is still not ready then,
    // that pass clears nothing and this count reads low until the next pass.
    const gone = new Set(removedIds);
    for (const [message, tag] of input.messageTagNumbers) {
        if (tag > 0 && tag <= reasoning.clearedThroughTag && typeof message.info.id === "string")
            gone.add(message.info.id);
    }
    const frozenMergedIds = getMergedReasoningStrippedIds(input.db, input.sessionId);
    return opencodeReasoningBudgetCutoff({
        messages: [...input.messages],
        messageTagNumbers: input.messageTagNumbers,
        budget: reasoning.keepTokens,
        alreadyRemoved: gone,
        proseRatio: reasoning.proseRatio,
        frozenMergedIds,
        alsoGone: new Set(
            [...frozenMergedIds]
                .filter((id) => id.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX))
                .map((id) => id.slice(THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length)),
        ),
    });
}

/** `message` is the counted form of `original`, the message tag numbers are keyed by. */
function withoutClearedReasoning(
    message: MessageLike,
    original: MessageLike,
    input: PricedPassSizingInput,
    cutoff: number,
): MessageLike {
    const tag = input.messageTagNumbers.get(original) ?? 0;
    if (tag === 0 || tag > cutoff) return message;
    const parts = message.parts.filter((part) => !isReasoningPart(part));
    return parts.length === message.parts.length ? message : { ...message, parts };
}

function isReasoningPart(part: unknown): boolean {
    return (
        typeof part === "object" &&
        part !== null &&
        REASONING_PART_TYPES.has(String((part as { type?: unknown }).type))
    );
}
