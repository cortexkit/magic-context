import {
    addProcessedImageStrippedIds,
    addStaleReduceStrippedIds,
    applyStrippedPlaceholderDelta,
    type ContextDatabase,
    clearDeferredExecutePendingIfMatches,
    clearPendingCompactionMarkerStateIf,
    clearPersistedTodoSyntheticAnchor,
    getActiveTagsBySession,
    getAutoSearchHintDecisions,
    getMaxM0MutationId,
    getNoteNudgeAnchors,
    getPendingCompactionMarkerState,
    getPendingOps,
    getPersistedTodoSyntheticAnchor,
    getProcessedImageStrippedIds,
    getStaleReduceStrippedIds,
    getStrippedPlaceholderIds,
    type PendingCompactionMarker,
    peekDeferredExecutePending,
    pruneAutoSearchHintDecisions,
    pruneNoteNudgeAnchors,
    setPersistedTodoSyntheticAnchor,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    getPersistedCompactionMarkerState,
    type PersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import {
    getTagNumberByMessageId,
    updateTagStatus,
} from "../../features/magic-context/storage-tags";
import type { Tagger } from "../../features/magic-context/tagger";
import type { SessionMeta, TagEntry } from "../../features/magic-context/types";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import { runAutoSearchHint } from "./auto-search-runner";
import { applyDeferredCompactionMarker, MARKER_SUMMARY_TEXT } from "./compaction-marker-manager";
import { getActiveCompartmentRun } from "./compartment-runner";
import type { CtxReduceAvailabilityVerdict } from "./ctx-reduce-availability";
import { dropStaleReduceCalls } from "./drop-stale-reduce-calls";
import { applyHeuristicCleanup } from "./heuristic-cleanup";
import {
    clearInjectionCache,
    getVisibleMemoryIds,
    injectM0M1,
    type M0HardSignals,
    type M0M1State,
    mustMaterialize,
    type PreparedCompartmentInjection,
    renderCompartmentInjection,
} from "./inject-compartments";
import { markNoteNudgeDelivered, peekNoteNudgeText } from "./note-nudger";
import { hasVisibleNoteReadCall } from "./note-visibility";
import type { PassOutcome } from "./pass-outcome";
import { estimateTokens } from "./read-session-formatting";
import { modelAcceptsEmptyContent, replaySentinelByMessageIds } from "./sentinel";
import {
    clearOldReasoning,
    stripClearedReasoning,
    stripDroppedPlaceholderMessages,
    stripInlineThinking,
    stripReasoningFromMergedAssistants,
    stripSystemInjectedMessages,
} from "./strip-content";
import { buildEditSupersessionReclaim, buildSupersessionReclaimOps } from "./supersession-reclaim";
import { byteSize, prependTag } from "./tag-content-primitives";
import { buildSyntheticTodoPart, type SyntheticTodoPart } from "./todo-view";
import {
    appendReminderToUserMessageById,
    findLastUserMessageId,
    injectToolPartIntoAssistantById,
    injectToolPartIntoLatestAssistant,
} from "./transform-message-helpers";
import {
    applyPendingOperations,
    type MessageLike,
    stripProcessedImages,
    type TagTarget,
} from "./transform-operations";
import { logTransformTiming } from "./transform-stage-logger";

const DEGRADE_CACHE_WARNING_THRESHOLD = 10;
// Bounded (LRU, max 100) so a crashed/never-reset session can't leak an entry
// forever in a long-running process — matches the other per-session caches.
const degradedCacheCountBySession = new BoundedSessionMap<number>(100);

export function resetDegradedCacheCount(sessionId: string): void {
    degradedCacheCountBySession.delete(sessionId);
}

export type DeferredCompactionMarkerClearOutcome =
    | "cleared"
    | "cas-lost-newer-pending"
    | "cas-lost-already-cleared";

function isSyntheticHeadMessage(message: MessageLike): boolean {
    // The flag alone is input-controlled metadata: a persisted or foreign row
    // could carry it and absorb a real message into the injected head, shifting
    // the summary's canonical position. Require the exact shape only
    // prependM0M1Messages produces: an ID-less user message whose every part is
    // marked synthetic. Persisted OpenCode rows always carry an id, so they can
    // never satisfy this regardless of their metadata.
    if (message.info.syntheticHead !== true) return false;
    if (message.info.id !== undefined) return false;
    if (message.info.role !== "user") return false;
    const parts = message.parts;
    if (parts.length === 0) return false;
    return parts.every((part) => (part as { synthetic?: boolean }).synthetic === true);
}

const TODO_HEAD_ANCHOR_ID = "__magic_context_todo_head__";

function injectSyntheticTodoAtHead(
    messages: MessageLike[],
    sessionId: string,
    part: SyntheticTodoPart,
): string {
    let headEnd = 0;
    while (headEnd < messages.length && isSyntheticHeadMessage(messages[headEnd])) {
        headEnd += 1;
    }
    const existing = messages[headEnd];
    if (existing?.info.id === TODO_HEAD_ANCHOR_ID) {
        injectToolPartIntoAssistantById(messages, TODO_HEAD_ANCHOR_ID, part);
        return TODO_HEAD_ANCHOR_ID;
    }
    messages.splice(headEnd, 0, {
        info: {
            id: TODO_HEAD_ANCHOR_ID,
            role: "assistant",
            sessionID: sessionId,
        },
        parts: [part],
    });
    return TODO_HEAD_ANCHOR_ID;
}

function injectPersistedTodoAnchor(
    messages: MessageLike[],
    sessionId: string,
    messageId: string,
    part: SyntheticTodoPart,
): boolean {
    if (injectToolPartIntoAssistantById(messages, messageId, part)) return true;
    if (messageId !== TODO_HEAD_ANCHOR_ID) return false;
    injectSyntheticTodoAtHead(messages, sessionId, part);
    return true;
}

function dropMarkerSummaryTag(
    db: ContextDatabase,
    sessionId: string,
    summaryMessageId: string,
): void {
    const tagNumber = getTagNumberByMessageId(db, sessionId, `${summaryMessageId}:p0`);
    if (tagNumber !== null) updateTagStatus(db, sessionId, tagNumber, "dropped");
}

/**
 * Replay the persisted marker representation on every pass.
 *
 * OpenCode projects a completed summary immediately before the retained tail.
 * The transform prepends synthetic history slots later, so the canonical array
 * position is after the contiguous synthetic head and before every real tail
 * message, regardless of role. Rebuilding from persisted state also removes
 * stale loser-process arrays and duplicate summaries deterministically.
 */
export function reconcileMarkerRepresentation(
    messages: MessageLike[],
    persistedMarkerState: PersistedCompactionMarkerState | null,
    options: {
        db: ContextDatabase;
        sessionId: string;
        tagger: Tagger;
        ctxReduceAvailability: CtxReduceAvailabilityVerdict;
    },
): boolean {
    const retainedMessages: MessageLike[] = [];
    const staleSummaryIds = new Set<string>();
    for (const message of messages) {
        if (message.info.summary !== true) {
            retainedMessages.push(message);
            continue;
        }
        const messageId = message.info.id;
        if (typeof messageId === "string" && messageId !== persistedMarkerState?.summaryMessageId) {
            staleSummaryIds.add(messageId);
        }
    }
    if (staleSummaryIds.size > 0) {
        options.db.transaction(() => {
            for (const messageId of staleSummaryIds) {
                dropMarkerSummaryTag(options.db, options.sessionId, messageId);
            }
        })();
    }

    const removedSummary = retainedMessages.length !== messages.length;
    if (removedSummary) messages.splice(0, messages.length, ...retainedMessages);
    if (persistedMarkerState === null) return removedSummary;

    const summaryTagNumber = options.tagger.assignTag(
        options.sessionId,
        `${persistedMarkerState.summaryMessageId}:p0`,
        "message",
        byteSize(MARKER_SUMMARY_TEXT),
        options.db,
        0,
        null,
        0,
        null,
        () => ({
            tokenCount: estimateTokens(MARKER_SUMMARY_TEXT),
            inputTokenCount: null,
            reasoningTokenCount: null,
        }),
    );
    const summaryText =
        options.ctxReduceAvailability.frozen && options.ctxReduceAvailability.callable
            ? prependTag(summaryTagNumber, MARKER_SUMMARY_TEXT)
            : MARKER_SUMMARY_TEXT;
    const summaryMessage: MessageLike = {
        info: {
            id: persistedMarkerState.summaryMessageId,
            role: "assistant",
            sessionID: options.sessionId,
            summary: true,
            finish: "stop",
        },
        parts: [{ type: "text", text: summaryText }],
    };

    let retainedTailStart = 0;
    while (
        retainedTailStart < messages.length &&
        isSyntheticHeadMessage(messages[retainedTailStart])
    ) {
        retainedTailStart += 1;
    }
    messages.splice(retainedTailStart, 0, summaryMessage);
    return true;
}

function pendingMarkerCoveredByConsumedBoundary(
    pending: PendingCompactionMarker,
    injection: PreparedCompartmentInjection | null,
): boolean {
    if (!injection) return false;
    if (pending.endMessageId === injection.compartmentEndMessageId) return true;
    return pending.ordinal <= injection.compartmentEndMessage;
}

export function clearPendingCompactionMarkerAfterSuccessfulDrain(args: {
    db: ContextDatabase;
    sessionId: string;
    pending: PendingCompactionMarker;
    deferredHistoryRefreshSessions: Set<string>;
}): DeferredCompactionMarkerClearOutcome {
    if (clearPendingCompactionMarkerStateIf(args.db, args.sessionId, args.pending)) {
        return "cleared";
    }

    const latestPending = getPendingCompactionMarkerState(args.db, args.sessionId);
    if (latestPending) {
        args.deferredHistoryRefreshSessions.add(args.sessionId);
        sessionLog(
            args.sessionId,
            "compaction-marker drain: CAS-clear failed because a newer pending blob exists; preserving deferred history refresh signal",
        );
        return "cas-lost-newer-pending";
    }

    sessionLog(
        args.sessionId,
        "compaction-marker drain: CAS-clear failed but no pending blob remains; another drain already cleared it",
    );
    return "cas-lost-already-cleared";
}

interface RunPostTransformPhaseArgs {
    sessionId: string;
    db: ContextDatabase;
    messages: MessageLike[];
    tags: TagEntry[];
    targets: Map<number, TagTarget>;
    reasoningByMessage: Map<MessageLike, { type: string; thinking?: string; text?: string }[]>;
    messageTagNumbers: Map<MessageLike, number>;
    tagger: Tagger;
    ctxReduceAvailability: CtxReduceAvailabilityVerdict;
    batch: { finalize: () => void } | null;
    contextUsage: { percentage: number; inputTokens: number };
    schedulerDecision: "execute" | "defer";
    fullFeatureMode: boolean;
    canRunCompartments: boolean;
    awaitedCompartmentRun: boolean;
    phaseJustAwaitedPublication: boolean;
    compartmentInProgress: boolean;
    historyRefreshExplicitBeforePrepare: boolean;
    deferredHistoryWasPendingAtPassStart: boolean;
    compartmentInjectionRebuiltFromDb: boolean;
    rebuiltHistoryFromInitialPrepare: boolean;
    historyRebuiltThisPass: boolean;
    canConsumeDeferredLate: boolean;
    sessionMeta: SessionMeta;
    currentTurnId: string | null;
    /**
     * Persistent signal that pending ops + heuristics need to materialize.
     * Survives across defer passes when `compartmentRunning` blocks the
     * heuristic pass. Drained ONLY after `shouldRunHeuristics` succeeds —
     * preserving `/ctx-flush` intent across blocked passes is the entire
     * reason for the three-set split (see Oracle review 2026-04-26).
     */
    pendingMaterializationSessions: Set<string>;
    deferredHistoryRefreshSessions: Set<string>;
    deferredMaterializationSessions: Set<string>;
    lastHeuristicsTurnId: Map<string, string>;
    clearReasoningAge: number;
    protectedTags: number;
    /**
     * Ceiling for the tiered emergency drop = contextLimit × executeThreshold%.
     * Undefined when the context limit isn't resolved (cold start) — the
     * emergency drop then skips (the 95% block stays the backstop).
     */
    emergencyCeilingTokens?: number;
    pendingCompartmentInjection: PreparedCompartmentInjection | null;
    didMutateFromFlushedStatuses: boolean;
    watermark: number;
    forceMaterializationPercentage: number;
    hasRecentReduceCall: boolean;
    projectPath?: string;
    sessionDirectory?: string;
    /** Experimental auto-search: when enabled, runs ctx_search on the latest
     *  user prompt and appends a compact fragment hint. */
    autoSearch?: {
        enabled: boolean;
        scoreThreshold: number;
        minPromptChars: number;
        directory?: string;
        ensureProjectRegistered?: (directory: string, db: ContextDatabase) => Promise<void>;
    };
    /**
     * Age-tier caveman compression (experimental). Caller forwards this only
     * for primary sessions because subagent context is curated by the parent.
     * Passed through to `applyHeuristicCleanup`.
     */
    cavemanTextCompression?: {
        enabled: boolean;
        minChars: number;
    };
    /**
     * Smart-drops (experimental, default off): content-aware reclaim of tool
     * output that a later call supersedes. Runs alongside the age-based
     * auto-drop, only inside an execute pass that is already mutating, so it
     * never causes a cache bust on its own. Off → the messages sent to the model
     * are byte-identical to the age-based-only behavior.
     */
    smartDrops?: boolean;
    /**
     * Provider resolved once by the main transform for this pass. Used for every
     * empty-sentinel gate and whole-message placeholder choice so postprocess
     * cannot diverge from the main transform on cold DB-recovered passes.
     */
    resolvedProviderID?: string;
    passOutcome?: PassOutcome;
    historyRefreshSessions?: Set<string>;
    m0M1?: {
        projectPath?: string;
        projectDirectory?: string;
        injectDocs?: boolean;
        memoryInjectionBudgetTokens?: number;
        historyBudgetTokens?: number;
        temporalAwareness?: boolean;
        hardSignals?: M0HardSignals;
    };
}

export interface PostTransformPhaseResult {
    explicitMaterializedSuccessfully: boolean;
    deferredMaterializedSuccessfully: boolean;
    materialized: boolean;
    /** True only when this pass consumed newly folded historian history. */
    historianFoldMaterializedThisPass: boolean;
    materializeReason: string | null;
    droppedTokens: number;
    emergencyReclaimedTokens: number;
    droppedCount: number;
    emergency: boolean;
    bustedThisPass: boolean;
}

export interface ConfirmedAbortClient {
    session?: {
        abort?: (input: {
            path: { id: string };
            throwOnError: true;
        }) => Promise<{ data?: boolean; error?: unknown }>;
    };
}

export async function abortSessionFailClosed(
    client: ConfirmedAbortClient,
    sessionId: string,
): Promise<void> {
    if (typeof client.session?.abort !== "function") {
        throw new Error("OpenCode session.abort is unavailable");
    }
    const result = await client.session.abort({
        path: { id: sessionId },
        throwOnError: true,
    });
    if (result.data !== true) {
        throw new Error(
            `OpenCode session.abort was not confirmed: ${JSON.stringify(result.error ?? result.data)}`,
        );
    }
}

export interface EmergencyFailClosedDecision {
    shouldAbort: boolean;
    reason: "below-emergency-band" | "provider-overflow-abort" | "proceed";
}

export function evaluateEmergencyFailClosed(input: {
    usagePercentage: number;
    emergencyRecoveryArmed: boolean;
    emergencyRecoveryOrigin: "provider_overflow" | "proactive_model_shrink" | null;
    foldMaterializedThisPass: boolean;
}): EmergencyFailClosedDecision {
    if (input.usagePercentage < 95) {
        return { shouldAbort: false, reason: "below-emergency-band" };
    }
    // Inside messages.transform, only the provider's own rejection proves that
    // this turn shape overflows. Local numeric estimates remain telemetry until
    // module-side accounting can reproduce provider-accurate framing.
    const shouldAbort =
        input.emergencyRecoveryArmed &&
        input.emergencyRecoveryOrigin === "provider_overflow" &&
        !input.foldMaterializedThisPass;
    return {
        shouldAbort,
        reason: shouldAbort ? "provider-overflow-abort" : "proceed",
    };
}

export function finalizeMessageRepresentation(
    messages: MessageLike[],
    resolvedProviderID?: string,
): { clearedParts: number; mergedReasoningParts: number } {
    const clearedParts = modelAcceptsEmptyContent(resolvedProviderID)
        ? stripClearedReasoning(messages)
        : 0;
    const mergedReasoningParts = stripReasoningFromMergedAssistants(messages, resolvedProviderID);
    return { clearedParts, mergedReasoningParts };
}

export async function runPostTransformPhase(
    args: RunPostTransformPhaseArgs,
): Promise<PostTransformPhaseResult> {
    // `isExplicitFlush` reads pendingMaterializationSessions — the persistent
    // "user wants pending ops + heuristics to run" signal. Survives across
    // blocked defer passes (compartmentRunning) so /ctx-flush intent is not
    // lost when historian races the user's command.
    const pendingMaterializationAtPassStart = args.pendingMaterializationSessions.has(
        args.sessionId,
    );
    const deferredMaterializationAtPassStart = args.deferredMaterializationSessions.has(
        args.sessionId,
    );
    const isExplicitFlush = pendingMaterializationAtPassStart;
    const deferredMaterializationWasPending = deferredMaterializationAtPassStart;
    const alreadyRanThisTurn =
        args.currentTurnId !== null &&
        args.lastHeuristicsTurnId.get(args.sessionId) === args.currentTurnId;
    const forceMaterialization =
        args.fullFeatureMode && args.contextUsage.percentage >= args.forceMaterializationPercentage;
    // Tiered emergency drop eligibility (Phase 2). Unlike `forceMaterialization`
    // (primary-only — it also forces m[0] materialization), the emergency tool
    // floor fires at ≥85% for BOTH primary AND subagent: it's the only tool
    // floor subagents have now that routine age-drops are gone. It's still a
    // cache-busting-pass operation (selection persisted, defer passes replay),
    // so it only runs when heuristics run (see shouldRunHeuristics) AND usage is
    // ≥ the force-materialize threshold.
    const emergencyDropEligible =
        args.contextUsage.percentage >= args.forceMaterializationPercentage;
    const activeCompartmentRun = args.canRunCompartments
        ? getActiveCompartmentRun(args.sessionId)
        : undefined;
    const compartmentRunning =
        args.canRunCompartments &&
        !args.awaitedCompartmentRun &&
        activeCompartmentRun !== undefined;
    const deferredMaterialize = args.canConsumeDeferredLate && deferredMaterializationWasPending;
    const materializationRequested = isExplicitFlush || deferredMaterialize;
    // Known-bust fold: if m[0] is going to HARD-fold this pass (epoch / model /
    // system-hash / ttl-idle / mutation-id / upgrade — whatever mustMaterialize
    // decides), the Anthropic prefix is being re-cached regardless. Drain the
    // queued tool-drops + run heuristics into THAT bust instead of busting a
    // second time on a later execute pass. ADVISORY-ONLY: early-true widens the
    // gates below; early-false changes nothing — injectM0M1 keeps its own
    // independent late mustMaterialize recheck, so a cross-process epoch/mutation
    // bump arriving after this point still folds (and its drops drain on a later
    // pass, exactly as today). Correctness is never worse than today; the cost is
    // one extra mustMaterialize (indexed DB reads + a cached docs stat).
    // Kept a SEPARATE boolean — NEVER folded into materializationRequested, which
    // drives the lastResponseTime TTL reset and pendingMaterialization cleanup;
    // folding in would suppress those and oscillate.
    const m0M1EnabledForFold =
        args.fullFeatureMode &&
        args.m0M1 !== undefined &&
        (!!args.m0M1.projectPath || !!args.m0M1.projectDirectory);
    const m0HardFoldThisPass =
        m0M1EnabledForFold && args.m0M1
            ? mustMaterialize({
                  db: args.db,
                  sessionId: args.sessionId,
                  state: args.sessionMeta as M0M1State,
                  projectPath: args.m0M1.projectPath,
                  projectDirectory: args.m0M1.projectDirectory,
                  hardSignals: args.m0M1.hardSignals,
              }).value
            : false;
    // Bypass the compartment-running veto when this pass is busting the Anthropic
    // prefix REGARDLESS — so the pending-op drain + heuristics ride that one bust
    // instead of being deferred into a SECOND bust ~a turn later. Two cases:
    //   - forceMaterialization (>=85%): overflow prevention trumps cache stability.
    //   - m0HardFoldThisPass: a HARD m[0] fold (model/system-hash/epoch/etc.) is
    //     re-caching m[0] this pass; the prefix is already gone, so draining into
    //     it is free. Without this, a hard fold landing while the historian runs
    //     leaves the drop vetoed -> it spills to a later soft bust (observed: a
    //     system-prompt change folded m[0], then the 1807-op backlog drained ~30s
    //     later as a second bust). Pi already gates this way (context-handler.ts).
    // Safe in both cases because the historian and the drain touch DISJOINT DBs:
    //   - Historian reads RAW OpenCode messages from opencode.db (read-only); its
    //     in-flight snapshot is validated by computeRawRangeFingerprint, which
    //     hashes raw content only (ids/part-types/lengths), NOT tag/drop state.
    //   - Drops mutate context.db (tags + pending_ops) + the in-memory wire only.
    //   - The historian's post-publish queueDropsForCompartmentalizedMessages is
    //     idempotent against already-dropped tags (status !== "active"), so any
    //     drain/publish ordering is benign.
    const bypassCompartmentGate = forceMaterialization || m0HardFoldThisPass;
    const shouldReadPendingOps =
        materializationRequested ||
        args.schedulerDecision === "execute" ||
        forceMaterialization ||
        m0HardFoldThisPass ||
        compartmentRunning;
    const pendingOps = shouldReadPendingOps ? getPendingOps(args.db, args.sessionId) : [];
    const hasPendingUserOps = pendingOps.length > 0;
    // Finding #3: include `forceMaterialization` so the emergency bypass is
    // self-sufficient. Without it, if `MAX_EXECUTE_THRESHOLD` is ever raised
    // above 85%, scheduler would return "defer" at 85% usage, but heuristic
    // cleanup would still fire (it gates on forceMaterialization directly),
    // causing unguarded cache busts while pending ops stop materializing.
    const shouldApplyPendingOps =
        (args.schedulerDecision === "execute" ||
            materializationRequested ||
            forceMaterialization ||
            m0HardFoldThisPass) &&
        (!compartmentRunning || bypassCompartmentGate);
    // Heuristic cleanup runs for ALL sessions — primary and subagent. Subagents
    // previously skipped heuristics entirely (via fullFeatureMode gate), which
    // meant their context grew unchecked until overflow. With this change,
    // subagents run tool drops and reasoning clearing at execute threshold just
    // like primary sessions, giving them a cache-safe reduction path without
    // needing historian/compartments.
    //
    // `forceMaterialization` remains gated by `fullFeatureMode` above (line ~125)
    // so subagents do NOT get 85% force-drop-all-tools or 95% block. Subagents
    // rely on normal overflow detection + clean failure if they exhaust context.
    //
    // Subagent once-per-turn bypass: a subagent's entire lifecycle is one user
    // turn from the parent's POV. Heavy subagents (Oracle, Athena council, etc.)
    // perform 100s of tool calls within that single turn. With the once-per-turn
    // guard enforced, only ONE cleanup pass fires (typically when context first
    // crosses the execute threshold ~50%), and subsequent tool calls accumulate
    // unchecked until overflow. The guard exists for primary-session cache
    // stability (mid-turn rewrites would bust Anthropic prompt cache across the
    // user's tool-call sequence). Subagents have no provider-cache reuse to
    // protect — they're short-lived, one-shot, and their tool-call bursts
    // already invalidate cache constantly. So we let subagents re-run heuristics
    // on every execute pass. The `schedulerDecision === "execute"` gate still
    // prevents per-defer-pass thrash; only passes the scheduler explicitly
    // approves for execution can fire heuristics.
    const shouldRunHeuristics =
        (!compartmentRunning || bypassCompartmentGate) &&
        (materializationRequested ||
            forceMaterialization ||
            // Known m[0] hard-fold this pass: the prefix busts regardless, so
            // running heuristics here folds the drops into the one bust. Bypasses
            // the once-per-turn guard deliberately (the guard exists to avoid
            // mid-turn cache busts; this pass busts anyway), so a hard fold that
            // lands mid-turn still drains.
            m0HardFoldThisPass ||
            // ≥85% emergency floor for BOTH primary and subagent. For a primary
            // this coincides with forceMaterialization (fullFeatureMode && ≥85%);
            // for a subagent (no forceMaterialization) it's the only path that
            // fires the tiered drop, even if the scheduler deferred mid-turn.
            emergencyDropEligible ||
            (args.schedulerDecision === "execute" &&
                (!alreadyRanThisTurn || !args.fullFeatureMode)));
    // Central cache-busting gate used by all mutation paths below.
    //
    // Definition: TRUE only when this pass actually mutates message state —
    // either by applying pending ops or by running heuristic cleanup. This
    // is the Oracle 2026-04-26 fix: the previous `isExplicitFlush ||
    // shouldApplyPendingOps` definition was unsafe because `isExplicitFlush`
    // could be true even on a defer pass where compartmentRunning blocked
    // both materialization and heuristics, causing cache-busting-only
    // cleanup (placeholder detection, sticky reminder retirement, nudge
    // anchor retirement) to fire on a pass that produced no real mutations.
    //
    // Both `shouldApplyPendingOps` and `shouldRunHeuristics` already gate on
    // `(!compartmentRunning || bypassCompartmentGate)` so they're
    // genuine "will-actually-mutate" booleans. ORing them is the precise
    // "did we mutate this pass" signal.
    //
    // Symmetry note: `system-prompt-hash.ts` and `inject-compartments.ts`
    // remain narrow (each reads its own dedicated set) so adjunct refresh
    // and history rebuild are decoupled from materialization timing.
    const isCacheBustingPass = shouldApplyPendingOps || shouldRunHeuristics;
    const canUseEmptySentinels = modelAcceptsEmptyContent(args.resolvedProviderID);
    if (shouldRunHeuristics) {
        const subagentRerun =
            !args.fullFeatureMode &&
            alreadyRanThisTurn &&
            args.schedulerDecision === "execute" &&
            !isExplicitFlush &&
            !forceMaterialization;
        const reason = isExplicitFlush
            ? "explicit_flush"
            : deferredMaterialize
              ? "deferred_materialization"
              : forceMaterialization
                ? `force_materialization (${args.contextUsage.percentage.toFixed(1)}% >= ${args.forceMaterializationPercentage}%)`
                : m0HardFoldThisPass && args.schedulerDecision !== "execute"
                  ? `m0_hard_fold (drain folded into known m[0] bust, scheduler=${args.schedulerDecision})`
                  : subagentRerun
                    ? `scheduler_execute_subagent_rerun (pendingOps=${pendingOps.length}, scheduler=${args.schedulerDecision})`
                    : `scheduler_execute (pendingOps=${pendingOps.length}, scheduler=${args.schedulerDecision})`;
        sessionLog(
            args.sessionId,
            `heuristics WILL RUN — reason=${reason}, context=${args.contextUsage.percentage.toFixed(1)}%, turn=${args.currentTurnId}`,
        );
    }
    // Only show "skipping" log for primary sessions — subagents bypass the
    // once-per-turn guard and DO re-run, so logging "skipping" would be wrong.
    if (
        alreadyRanThisTurn &&
        args.schedulerDecision === "execute" &&
        !materializationRequested &&
        args.fullFeatureMode
    ) {
        sessionLog(
            args.sessionId,
            `transform: skipping heuristics (already ran for turn ${args.currentTurnId})`,
        );
    }
    if (compartmentRunning && hasPendingUserOps) {
        if (bypassCompartmentGate) {
            const bypassReason = forceMaterialization ? "emergency >=85%" : "m0 hard fold";
            sessionLog(
                args.sessionId,
                `transform: compartment-gate bypass (${bypassReason}) — applying ${pendingOps.length} pending ops while compartment agent runs (${args.contextUsage.percentage.toFixed(1)}%)`,
            );
        } else {
            sessionLog(
                args.sessionId,
                "transform: deferring pending ops — compartment agent in progress",
            );
        }
    }
    let explicitMaterializedSuccessfully = false;
    let deferredMaterializedSuccessfully = false;
    let heuristicsRanSuccessfully = false;
    let pendingOpsRanSuccessfully = false;
    let pendingOpsDidMutate = false;
    let heuristicOrReasoningDidMutate = false;
    let droppedCount = 0;
    const droppedTokens = 0;
    let emergencyReclaimedTokens = 0;
    let emergency = false;
    let m0RematerializedThisPass = false;
    let m0MaterializeReason: string | null = null;
    let m0M1InjectedThisPass = false;
    let smartDropsDidMutateThisPass = false;
    try {
        if (shouldApplyPendingOps) {
            const applyReason = isExplicitFlush
                ? "explicit_flush"
                : deferredMaterialize
                  ? "deferred_materialization"
                  : `scheduler_execute (scheduler=${args.schedulerDecision})`;
            sessionLog(
                args.sessionId,
                `pending ops WILL APPLY — reason=${applyReason}, pendingOps=${pendingOps.length}, context=${args.contextUsage.percentage.toFixed(1)}%`,
            );
            const tApply = performance.now();
            // P0 perf: don't pass `args.tags` here. applyPendingOperations
            // genuinely needs the full tag set (including dropped/compacted
            // rows it uses to skip already-processed pending ops), but the
            // upstream `args.tags` is now active-only. Letting the function
            // lazy-load via its own getTagsBySession() call inside the
            // pending-ops transaction is the right behavior:
            //   - Most passes have 0 pending ops and never reach this
            //     branch, so the full-tags load is avoided entirely.
            //   - When pending ops do exist (rare execute/flush passes),
            //     the load runs once inside the same transaction the
            //     mutations need, which is unavoidable.
            pendingOpsDidMutate = applyPendingOperations(
                args.sessionId,
                args.db,
                args.targets,
                args.protectedTags,
                undefined,
                pendingOps,
            );
            if (pendingOpsDidMutate) {
                droppedCount += pendingOps.length;
            }
            logTransformTiming(args.sessionId, "applyPendingOperations", tApply);
        }
        if (shouldRunHeuristics) {
            const t5 = performance.now();
            // Caveman config is only passed through for primary sessions when
            // the experimental flag is true. Caller (transform) wires both
            // conditions so this postprocess path doesn't need to re-check them.
            // Kept undefined otherwise so the heuristic pass skips entirely.
            const cavemanConfig = args.cavemanTextCompression?.enabled
                ? {
                      enabled: true,
                      minChars: args.cavemanTextCompression.minChars,
                  }
                : undefined;
            const heuristicTags = shouldApplyPendingOps
                ? getActiveTagsBySession(args.db, args.sessionId)
                : args.tags;
            // Pending ops run just before heuristics and can drop active tags.
            // Emergency floor math must see that post-op active set; otherwise
            // already-reclaimed tags stay in floorTags and the planner over-evicts.
            const cleanup = applyHeuristicCleanup(
                args.sessionId,
                args.db,
                args.targets,
                args.messageTagNumbers,
                {
                    protectedTags: args.protectedTags,
                    // Tiered emergency drop fires only at ≥85% (both primary and
                    // subagent) AND only when the ceiling is known. Undefined
                    // ceiling (cold start) or below-threshold usage → no
                    // emergency arg → routine pass does dedup/injection-strip
                    // only (Phase 2 removed need-blind routine tool drops).
                    emergency:
                        emergencyDropEligible &&
                        args.emergencyCeilingTokens !== undefined &&
                        args.emergencyCeilingTokens > 0
                            ? {
                                  currentTotalInputTokens: args.contextUsage.inputTokens,
                                  ceilingTokens: args.emergencyCeilingTokens,
                              }
                            : undefined,
                    caveman: cavemanConfig,
                },
                heuristicTags,
            );
            logTransformTiming(
                args.sessionId,
                "applyHeuristicCleanup",
                t5,
                `droppedTools=${cleanup.droppedTools} deduplicatedTools=${cleanup.deduplicatedTools} droppedInjections=${cleanup.droppedInjections} compressedTextTags=${cleanup.compressedTextTags} mutatedTextTags=${cleanup.mutatedTextTags}`,
            );
            const heuristicMutationCount =
                cleanup.droppedTools +
                cleanup.deduplicatedTools +
                cleanup.droppedInjections +
                cleanup.mutatedTextTags;
            droppedCount +=
                cleanup.droppedTools +
                cleanup.deduplicatedTools +
                cleanup.droppedInjections +
                cleanup.mutatedTextTags;
            emergency ||= cleanup.emergencyDroppedTools > 0;
            emergencyReclaimedTokens += cleanup.emergencyReclaimedTokens;
            const t7 = performance.now();
            // Typed reasoning clearing is canonical-Anthropic-only. clearOldReasoning
            // rewrites a reasoning part's `thinking`/`text` to "[cleared]"; only
            // stripClearedReasoning (gated on canUseEmptySentinels) then converts
            // those shells to empty sentinels that OpenCode drops before the
            // Anthropic wire. For any provider that is NOT canonical Anthropic the
            // "[cleared]" string would remain inside the reasoning block on the
            // wire — wrong, and a real hazard for non-canonical Claude proxies
            // (github-copilot/bedrock-claude under a non-"anthropic" providerID),
            // which validate thinking blocks. So gate the WRITE on the same
            // canonical-Anthropic predicate as the converter; non-Anthropic
            // providers keep their reasoning intact. Inline-thinking stripping
            // below stays provider-independent (it removes literal <thinking> tags
            // from text, never touches typed reasoning parts).
            const clearedReasoning = canUseEmptySentinels
                ? clearOldReasoning(
                      args.messages,
                      args.reasoningByMessage,
                      args.messageTagNumbers,
                      args.clearReasoningAge,
                  )
                : 0;
            if (canUseEmptySentinels) {
                stripClearedReasoning(args.messages);
            }
            const strippedInline = stripInlineThinking(
                args.messages,
                args.messageTagNumbers,
                args.clearReasoningAge,
            );
            if (clearedReasoning > 0 || strippedInline > 0) {
                // Compute and persist the reasoning watermark so future defer passes
                // can replay the same clearing without re-computing the cutoff.
                let maxTag = 0;
                for (const tag of args.messageTagNumbers.values()) {
                    if (tag > maxTag) maxTag = tag;
                }
                const newWatermark = maxTag - args.clearReasoningAge;
                const currentWatermark = args.sessionMeta?.clearedReasoningThroughTag ?? 0;
                if (newWatermark > currentWatermark) {
                    updateSessionMeta(args.db, args.sessionId, {
                        clearedReasoningThroughTag: newWatermark,
                    });
                    args.sessionMeta.clearedReasoningThroughTag = newWatermark;
                    sessionLog(
                        args.sessionId,
                        `reasoning cleanup: cleared=${clearedReasoning} inlineStripped=${strippedInline} watermark=${currentWatermark}→${newWatermark}`,
                    );
                } else {
                    sessionLog(
                        args.sessionId,
                        `reasoning cleanup: cleared=${clearedReasoning} inlineStripped=${strippedInline} watermark=${currentWatermark} (unchanged)`,
                    );
                }
            }
            logTransformTiming(args.sessionId, "clearOldReasoning", t7);
            heuristicOrReasoningDidMutate =
                heuristicMutationCount + clearedReasoning + strippedInline > 0;
            droppedCount += clearedReasoning + strippedInline;
            // ── Drain pendingMaterializationSessions ──
            // Heuristics + materialization successfully ran on this pass.
            // We've fulfilled every reason the set was added (user
            // /ctx-flush, variant change, system-prompt hash change,
            // historian publish), so clear the persistent signal. If
            // compartmentRunning had blocked us above, this drain is
            // intentionally NOT reached — the flag survives so the next
            // safe pass picks up the work.
            if (pendingMaterializationAtPassStart) {
                args.pendingMaterializationSessions.delete(args.sessionId);
            }
            if (args.currentTurnId) {
                args.lastHeuristicsTurnId.set(args.sessionId, args.currentTurnId);
            }
        }
        // After a TTL-based scheduler execute, reset lastResponseTime so
        // subsequent transforms defer instead of re-executing every pass.
        if (args.schedulerDecision === "execute" && !materializationRequested) {
            updateSessionMeta(args.db, args.sessionId, { lastResponseTime: Date.now() });
        }

        const smartDropsExecutePass = args.schedulerDecision === "execute" || m0HardFoldThisPass;
        const alreadyMutatingThisPass = pendingOpsDidMutate || heuristicOrReasoningDidMutate;
        let smartDropTargetCount = 0;
        let smartDropsDidMutate = false;
        if (
            args.smartDrops &&
            smartDropsExecutePass &&
            alreadyMutatingThisPass &&
            !emergencyDropEligible
        ) {
            // Smart-drops are an independently configured feature. They select
            // outputs that a later call superseded; unlike the removed positional
            // reclaim, age or a prior execute watermark cannot select a tool.
            const smartDropOps = buildSupersessionReclaimOps({
                db: args.db,
                sessionId: args.sessionId,
                targets: args.targets,
                pendingOps,
            });
            const editMarkerTagIds = new Set<number>();
            const selectedIds = new Set(smartDropOps.map((op) => op.tagId));
            const editReclaim = buildEditSupersessionReclaim({
                db: args.db,
                sessionId: args.sessionId,
                targets: args.targets,
                pendingOps,
            });
            for (const op of editReclaim.ops) {
                // A superseded edit only compresses if the control-plane rule did
                // not already select it for a full drop.
                if (!selectedIds.has(op.tagId)) {
                    smartDropOps.push(op);
                    selectedIds.add(op.tagId);
                    editMarkerTagIds.add(op.tagId);
                }
            }
            smartDropTargetCount = smartDropOps.length;
            if (smartDropOps.length > 0) {
                smartDropsDidMutate = applyPendingOperations(
                    args.sessionId,
                    args.db,
                    args.targets,
                    args.protectedTags,
                    undefined,
                    [],
                    smartDropOps,
                    editMarkerTagIds,
                );
                if (smartDropsDidMutate) {
                    droppedCount += smartDropOps.length;
                    smartDropsDidMutateThisPass = true;
                }
            }
        }
        args.batch?.finalize();
        if (smartDropTargetCount > 0) {
            sessionLog(
                args.sessionId,
                `smart-drops reclaim: targets=${smartDropTargetCount} mutated=${smartDropsDidMutate}`,
            );
        }
        logTransformTiming(args.sessionId, "batchFinalize:heuristics", performance.now());
        if (args.sessionMeta.lastTransformError !== null) {
            updateSessionMeta(args.db, args.sessionId, { lastTransformError: null });
        }
        if (shouldRunHeuristics) {
            if (isExplicitFlush) explicitMaterializedSuccessfully = true;
            if (deferredMaterialize) deferredMaterializedSuccessfully = true;
            heuristicsRanSuccessfully = true;
        }
        if (shouldApplyPendingOps) {
            pendingOpsRanSuccessfully = true;
        }
    } catch (error) {
        args.passOutcome?.record("pending-operation-failure");
        sessionLog(args.sessionId, "transform failed applying pending operations:", error);
        updateSessionMeta(args.db, args.sessionId, { lastTransformError: getErrorMessage(error) });
    }

    // Stale ctx_reduce strip is a REPLAY-class transform driven by a FROZEN,
    // id-keyed watermark (`stale_reduce_stripped_ids`), mirroring reasoning /
    // placeholder replay:
    //   • REPLAY (every pass, incl. defer): sentinel-strip ctx_reduce parts in
    //     messages whose id is already frozen — byte-identical regardless of how
    //     the live array grew.
    //   • DETECT (cache-busting passes only): additionally find aged ctx_reduce
    //     calls past the protected window, strip them, and CAS-persist their ids
    //     so future passes replay them.
    // The earlier "run every pass with a live messages.length-protectedTags
    // boundary" version busted the Anthropic cache: tail growth moved the
    // boundary, so a DEFER pass newly stripped an older ctx_reduce call
    // mid-prefix (empty sentinel filtered for Anthropic + dropped tool_result →
    // adjacent assistants merge → the message vanishes and the array shifts).
    // Freezing the id set on bust passes and replaying it everywhere removes the
    // moving boundary entirely. Empty reduce sentinels are Anthropic-only: on
    // other providers even a previously frozen id must stay native so no empty
    // text block can reach the wire.
    if (canUseEmptySentinels) {
        try {
            const t8 = performance.now();
            const frozenStaleReduceIds = getStaleReduceStrippedIds(args.db, args.sessionId);
            const staleReduceResult = dropStaleReduceCalls(args.messages, frozenStaleReduceIds, {
                detect: isCacheBustingPass,
                protectedCount: args.protectedTags,
            });
            if (isCacheBustingPass && staleReduceResult.newlyStrippedIds.length > 0) {
                addStaleReduceStrippedIds(
                    args.db,
                    args.sessionId,
                    staleReduceResult.newlyStrippedIds,
                );
            }
            logTransformTiming(args.sessionId, "dropStaleReduceCalls", t8);
        } catch (error) {
            args.passOutcome?.record("stale-reduce-strip-exception");
            sessionLog(args.sessionId, "transform failed dropping stale ctx_reduce calls:", error);
        }
    }

    // Processed-image strip — same REPLAY/DETECT freeze as stale ctx_reduce.
    // The empty image sentinel is filtered off the Anthropic wire, so the first
    // strip of a message removes its image blocks (a real byte change). Keying
    // that first strip on the live watermark let a DEFER pass cross an older
    // image message and remove its images mid-prefix, busting the cache.
    // Freeze the id set on cache-busting passes; replay it every pass.
    if (canUseEmptySentinels) {
        try {
            const tImg = performance.now();
            const frozenImageIds = getProcessedImageStrippedIds(args.db, args.sessionId);
            const imageResult = stripProcessedImages(args.messages, frozenImageIds, {
                detect: isCacheBustingPass && args.watermark > 0,
                watermark: args.watermark,
                messageTagNumbers: args.messageTagNumbers,
            });
            if (isCacheBustingPass && imageResult.newlyStrippedIds.length > 0) {
                addProcessedImageStrippedIds(args.db, args.sessionId, imageResult.newlyStrippedIds);
            }
            logTransformTiming(args.sessionId, "stripProcessedImages", tImg);
        } catch (error) {
            args.passOutcome?.record("image-strip-exception");
            sessionLog(args.sessionId, "transform failed stripping processed images:", error);
        }
    }

    // Same gate computed once at the top for the known-bust fold decision.
    const m0M1Enabled = m0M1EnabledForFold;
    if (m0M1Enabled && args.m0M1) {
        const tInjectM0M1 = performance.now();
        try {
            const result = injectM0M1({
                db: args.db,
                sessionId: args.sessionId,
                messages: args.messages,
                state: args.sessionMeta as M0M1State,
                projectPath: args.m0M1.projectPath,
                projectDirectory: args.m0M1.projectDirectory,
                injectDocs: args.m0M1.injectDocs,
                memoryInjectionBudgetTokens: args.m0M1.memoryInjectionBudgetTokens,
                historyBudgetTokens: args.m0M1.historyBudgetTokens,
                temporalAwareness: args.m0M1.temporalAwareness,
                isCacheBustingPass,
                hardSignals: args.m0M1.hardSignals,
            });
            if (result.injected) {
                m0M1InjectedThisPass = true;
                m0RematerializedThisPass ||= result.m0RematerializedThisPass;
                m0MaterializeReason = result.decision.reason ?? m0MaterializeReason;
                sessionLog(
                    args.sessionId,
                    `transform: injected m[0]/m[1] (rematerialized=${result.m0RematerializedThisPass}, reason=${result.decision.reason ?? "cache_hit"})`,
                );
            }
        } catch (error) {
            args.passOutcome?.record("m0-m1-injection-degradation");
            sessionLog(
                args.sessionId,
                "transform: m[0]/m[1] injection failed:",
                getErrorMessage(error),
            );
            // Fail-closed: prepareCompartmentInjection already spliced the
            // summarized raw history out of `messages` (transform.ts), so if
            // m[0]/m[1] injection throws, the model would otherwise receive
            // NEITHER the raw history NOR <session-history> — silent context
            // loss. Re-inject the prepared legacy block as a degraded fallback
            // so the compacted history is still present this pass. This pass
            // already busted (it threw), so the non-m0/m1 shape costs nothing;
            // the next pass re-materializes the proper m[0]/m[1] layout.
            if (args.pendingCompartmentInjection) {
                try {
                    renderCompartmentInjection(
                        args.sessionId,
                        args.messages,
                        args.pendingCompartmentInjection,
                    );
                    sessionLog(
                        args.sessionId,
                        "transform: rendered legacy <session-history> fallback after m[0]/m[1] failure",
                    );
                } catch (fallbackError) {
                    args.passOutcome?.record("m0-m1-fallback-failure", "fatal");
                    sessionLog(
                        args.sessionId,
                        "transform: legacy fallback injection also failed:",
                        getErrorMessage(fallbackError),
                    );
                }
            }
            // History-loss guard: on a cache-busting pass,
            // prepareCompartmentInjection (transform.ts) already trimmed the raw
            // tail to the LATEST compartment AND cached that new boundary, and the
            // explicit history-refresh signal was already drained. Since m[0]/m[1]
            // injection just threw, the cached m[1] still reflects the PRE-failure
            // compartment set. If we left the in-memory injection cache holding the
            // new boundary, a later same-process DEFER pass would reuse it
            // (isCacheBusting=false hits the cached path), trim the raw tail to the
            // new boundary, and replay the stale m[1] — so a compartment published
            // this turn would be summarized in NEITHER m[1] NOR the raw tail =
            // silent history loss persisting past this pass. Clearing the cache
            // forces the next defer pass through the cold-rebuild path, which trims
            // only to the persisted baseline boundary the cached m[1] actually
            // covers (keeping the new compartment's raw messages visible until a
            // later exec pass folds them). We intentionally do NOT re-arm the
            // refresh signal: a persistent injection failure would then bust the
            // cache every pass; the scheduler's next natural execute pass retries
            // materialization on its own.
            clearInjectionCache(args.sessionId);
        }
        logTransformTiming(args.sessionId, "pp.injectM0M1", tInjectM0M1);
    } else if (args.fullFeatureMode && args.pendingCompartmentInjection) {
        const compartmentResult = renderCompartmentInjection(
            args.sessionId,
            args.messages,
            args.pendingCompartmentInjection,
        );
        if (compartmentResult.injected) {
            if (compartmentResult.compartmentCount > 0) {
                sessionLog(
                    args.sessionId,
                    `transform: injected ${compartmentResult.compartmentCount} compartments ` +
                        `(covering raw messages 1-${compartmentResult.compartmentEndMessage}, ` +
                        `skipped ${compartmentResult.skippedVisibleMessages} visible messages)`,
                );
            } else {
                sessionLog(
                    args.sessionId,
                    "transform: injected memories/facts block (no compartments yet)",
                );
            }
        }
    }

    // Neutralize messages that are nothing but [dropped §N§] placeholders,
    // plus system-injected messages (notifications, reminders, internal markers).
    // Both produce IDENTICAL empty-text-sentinel replacements that preserve array
    // length between passes — cache-stable for both Anthropic-native (where
    // OpenCode's upstream filter drops the empty parts at the wire) and proxy
    // providers that hash the serialized message array.
    //
    // MUST run AFTER compartment injection: renderCompartmentInjection checks whether
    // messages[0] is a dropped placeholder to decide if it needs a synthetic carrier message.
    //
    // Cache-safe: replay previously-neutralized IDs on every pass, only detect new
    // matches on cache-busting passes. Persist the merged set (placeholder + system-
    // injected) so defer passes produce the same message shape as the bust pass.
    {
        const tPlaceholder = performance.now();
        const persistedIds = getStrippedPlaceholderIds(args.db, args.sessionId);

        // Step 1: Replay — re-apply sentinel to messages whose IDs were neutralized
        // on a prior bust pass. Preserves array length — no splice.
        if (persistedIds.size > 0) {
            const { replayed, missingIds } = replaySentinelByMessageIds(
                args.messages,
                persistedIds,
                args.resolvedProviderID,
            );
            if (replayed > 0) {
                sessionLog(
                    args.sessionId,
                    `sentinel replay: neutralized ${replayed} previously-stripped messages`,
                );
            }
            // Prune IDs that no longer appear in the live message set (e.g., after
            // compaction trimmed them out entirely). Don't prune if they're present
            // but already sentinel — those are working as intended.
            if (missingIds.length > 0) {
                for (const id of missingIds) persistedIds.delete(id);
                // CAS delta (remove) so a sibling process discovering new IDs in
                // parallel isn't clobbered by this prune's whole-set overwrite.
                applyStrippedPlaceholderDelta(args.db, args.sessionId, { remove: missingIds });
            }
        }

        // Step 2: Detect — only on cache-busting passes, find NEW eligible messages
        // and persist their IDs so future defer passes can replay.
        if (isCacheBustingPass) {
            const droppedResult = stripDroppedPlaceholderMessages(
                args.messages,
                args.resolvedProviderID,
            );
            const protectedTailStart = Math.max(0, args.messages.length - args.protectedTags * 2);
            const systemInjectedResult = stripSystemInjectedMessages(
                args.messages,
                protectedTailStart,
                args.resolvedProviderID,
            );

            const newlyNeutralized =
                droppedResult.sentineledIds.length + systemInjectedResult.sentineledIds.length;

            if (newlyNeutralized > 0) {
                const addedIds = [
                    ...droppedResult.sentineledIds,
                    ...systemInjectedResult.sentineledIds,
                ];
                for (const id of addedIds) persistedIds.add(id);
                // CAS delta (add) so a concurrent prune in a sibling process
                // doesn't clobber these newly-discovered IDs.
                applyStrippedPlaceholderDelta(args.db, args.sessionId, { add: addedIds });
                sessionLog(
                    args.sessionId,
                    `neutralized ${droppedResult.stripped} dropped + ${systemInjectedResult.stripped} system-injected messages (${newlyNeutralized} new, ${persistedIds.size} total persisted)`,
                );
            }
        }
        logTransformTiming(args.sessionId, "pp.placeholderNeutralize", tPlaceholder);
    }

    // The in-turn ctx_reduce nudge (Channel 1) is injected into tool outputs in
    // tool.execute.after and persisted by OpenCode, so it needs no transform-side
    // replay. The old rolling/iteration assistant-anchored nudges and the
    // tool-heavy sticky user-message reminder were removed (their buried-anchor
    // first-append busted the Anthropic prompt-cache prefix). Their persisted
    // state is zeroed by migration v31; no code reads it anymore.

    const tNudgeBlock = performance.now();

    // Sticky-injection replay (§2.4): every pass replays every persisted anchor
    // so cached user-message bytes remain identical until that message leaves
    // the visible window. Prune happens later, only on cache-busting passes.
    if (args.fullFeatureMode) {
        for (const anchor of getNoteNudgeAnchors(args.db, args.sessionId)) {
            appendReminderToUserMessageById(args.messages, anchor.messageId, anchor.text);
        }
        for (const decision of getAutoSearchHintDecisions(args.db, args.sessionId)) {
            if (decision.decision === "hint") {
                appendReminderToUserMessageById(args.messages, decision.messageId, decision.text);
            }
        }
    }

    // Visibility check: scan the post-drop messages array for a non-stripped
    // ctx_note(action="read") tool call. This decides whether the suppression
    // path inside `peekNoteNudgeText` should fire — see the comment block
    // there for the full rationale. Only computed when nudges can actually
    // fire (fullFeatureMode), so we skip the scan in subagent sessions.
    logTransformTiming(args.sessionId, "pp.nudgeAndSticky", tNudgeBlock);

    const explicitRebuildHappened =
        args.historyRefreshExplicitBeforePrepare && args.rebuiltHistoryFromInitialPrepare;
    const materializationSatisfied =
        !deferredMaterializationWasPending ||
        explicitMaterializedSuccessfully ||
        deferredMaterializedSuccessfully;
    const historyWasConsumedThisPass =
        args.historyRebuiltThisPass &&
        (args.canConsumeDeferredLate ||
            args.phaseJustAwaitedPublication ||
            explicitRebuildHappened) &&
        materializationSatisfied;

    // Drain the persisted marker before todo synthesis so the todo anchor sees
    // the same summary representation that this pass will emit.
    let suppressV12HistoryDrain = false;
    if (historyWasConsumedThisPass && args.deferredHistoryWasPendingAtPassStart) {
        const pending = getPendingCompactionMarkerState(args.db, args.sessionId);
        if (pending) {
            if (
                !pendingMarkerCoveredByConsumedBoundary(pending, args.pendingCompartmentInjection)
            ) {
                suppressV12HistoryDrain = true;
                sessionLog(
                    args.sessionId,
                    `compaction-marker drain: pending ordinal ${pending.ordinal} is newer than consumed boundary ${args.pendingCompartmentInjection?.compartmentEndMessage ?? "<none>"}; preserving deferred history refresh signal`,
                );
            } else {
                const outcome = applyDeferredCompactionMarker(
                    args.db,
                    args.sessionId,
                    pending,
                    args.sessionDirectory,
                );
                switch (outcome.kind) {
                    case "applied":
                    case "already-current":
                    case "stale-skip":
                        if (
                            clearPendingCompactionMarkerAfterSuccessfulDrain({
                                db: args.db,
                                sessionId: args.sessionId,
                                pending,
                                deferredHistoryRefreshSessions: args.deferredHistoryRefreshSessions,
                            }) === "cas-lost-newer-pending"
                        ) {
                            suppressV12HistoryDrain = true;
                        }
                        break;
                    case "retryable-failure":
                        args.passOutcome?.record("compaction-marker-drain-failure");
                        sessionLog(
                            args.sessionId,
                            "compaction-marker drain: retryable failure; preserving deferred history refresh signal",
                            outcome.error,
                        );
                        suppressV12HistoryDrain = true;
                        break;
                }
            }
        }
    }

    reconcileMarkerRepresentation(
        args.messages,
        getPersistedCompactionMarkerState(args.db, args.sessionId),
        {
            db: args.db,
            sessionId: args.sessionId,
            tagger: args.tagger,
            ctxReduceAvailability: args.ctxReduceAvailability,
        },
    );

    const deferredHistoryDrainEligible =
        historyWasConsumedThisPass &&
        args.deferredHistoryWasPendingAtPassStart &&
        !suppressV12HistoryDrain;
    if (deferredHistoryDrainEligible) {
        args.deferredHistoryRefreshSessions.delete(args.sessionId);
    }
    if (
        (explicitMaterializedSuccessfully || deferredMaterializedSuccessfully) &&
        deferredMaterializationAtPassStart
    ) {
        args.deferredMaterializationSessions.delete(args.sessionId);
    }

    const tNoteAndTodo = performance.now();
    const noteReadStillVisible = args.fullFeatureMode
        ? hasVisibleNoteReadCall(args.messages)
        : false;
    const deferredNoteText = args.fullFeatureMode
        ? peekNoteNudgeText(
              args.db,
              args.sessionId,
              args.currentTurnId,
              args.projectPath,
              noteReadStillVisible,
          )
        : null;
    if (deferredNoteText) {
        const noteInstruction = `\n\n<instruction name="deferred_notes">${deferredNoteText}</instruction>`;
        const anchoredMessageId = findLastUserMessageId(args.messages);
        const outcome = markNoteNudgeDelivered(
            args.db,
            args.sessionId,
            noteInstruction,
            anchoredMessageId,
        );
        if (anchoredMessageId && outcome.ok) {
            appendReminderToUserMessageById(args.messages, anchoredMessageId, noteInstruction);
        } else if (anchoredMessageId && !outcome.ok) {
            args.passOutcome?.record("note-nudge-cas-failure");
            sessionLog(args.sessionId, `note-nudge delivery skipped wire append: ${outcome.kind}`);
        }
    }

    // Todo state synthesis: inject a synthetic `todowrite` tool part into the
    // latest eligible assistant so the agent reads current todos through its
    // native todowrite-tracking mental model. Summary assistants are excluded
    // because marker reconciliation rebuilds them. When no eligible assistant
    // exists, the pair uses a deterministic head anchor before the retained tail.
    // The wire shape is identical to OpenCode's stored todowrite tool parts, so providers,
    // serializers, and downstream code see something indistinguishable from
    // a real call.
    //
    // Cache safety:
    //   - Snapshot capture (in hook-handlers.ts on tool.execute.after) writes
    //     DB only — no message mutation.
    //   - Synthetic callID is deterministic from the snapshot JSON, so a
    //     stable snapshot produces a stable wire shape across both cache-
    //     busting and defer passes.
    //   - This block runs AFTER tagging and applyPendingOperations, so the
    //     synthetic part is never tagged and never targeted by ctx_reduce or
    //     heuristic cleanup.
    //   - Defer passes only replay an already-persisted (callID, anchor) pair
    //     via `injectToolPartIntoAssistantById`, which is idempotent on
    //     callID — repeated defer-pass calls produce byte-identical output.
    if (args.fullFeatureMode) {
        const persistedAnchor = getPersistedTodoSyntheticAnchor(args.db, args.sessionId);
        if (isCacheBustingPass) {
            const part = buildSyntheticTodoPart(args.sessionMeta.lastTodoState);
            if (part === null) {
                if (persistedAnchor) {
                    clearPersistedTodoSyntheticAnchor(args.db, args.sessionId);
                }
            } else if (
                persistedAnchor &&
                persistedAnchor.callId === part.callID &&
                injectPersistedTodoAnchor(
                    args.messages,
                    args.sessionId,
                    persistedAnchor.messageId,
                    part,
                )
            ) {
                // Snapshot unchanged AND persisted anchor message still
                // present — idempotent re-inject leaves DB and messages
                // byte-identical.
                //
                // Council Finding #1 v2 (Oracle final audit): if a legacy
                // row was upgraded with `stateJson=""` (default after v11
                // migration ran on a session that already had `callId` and
                // `messageId` from the pre-stateJson build), backfill the
                // snapshot now so subsequent defer passes have something
                // to replay. Without this, defer at line 770 skips on
                // `stateJson.length === 0` and the synthetic vanishes
                // from T1 — exactly the regression Finding #1 was meant
                // to prevent. callId equality (line 743) under sha256
                // truncated to 64 bits gives negligible collision risk
                // for non-adversarial inputs (~2^32 distinct stateJsons
                // expected before one collision), so the current snapshot
                // is overwhelmingly likely to equal what the old build
                // hashed; backfill is safe in practice.
                if (persistedAnchor.stateJson.length === 0) {
                    setPersistedTodoSyntheticAnchor(
                        args.db,
                        args.sessionId,
                        persistedAnchor.callId,
                        persistedAnchor.messageId,
                        args.sessionMeta.lastTodoState,
                    );
                }
            } else {
                const anchoredMessageId =
                    injectToolPartIntoLatestAssistant(args.messages, part) ??
                    injectSyntheticTodoAtHead(args.messages, args.sessionId, part);
                setPersistedTodoSyntheticAnchor(
                    args.db,
                    args.sessionId,
                    part.callID,
                    anchoredMessageId,
                    // Persist the SNAPSHOT we injected, not just the callID.
                    // Defer-pass replay rebuilds from THIS state so prefix bytes
                    // stay identical even if a real todowrite mutates
                    // last_todo_state before the next cache-busting pass.
                    args.sessionMeta.lastTodoState,
                );
            }
        } else if (persistedAnchor && persistedAnchor.stateJson.length > 0) {
            // Defer pass — byte-identical replay. Rebuild the part from the
            // PERSISTED snapshot, NOT from `args.sessionMeta.lastTodoState`.
            //
            // Why: between the last cache-busting pass T0 and this defer
            // pass T1, the agent may have called `todowrite` which updated
            // `last_todo_state`. T0 injected the OLD state at the anchor;
            // for T1 to keep prefix bytes identical to T0 (so Anthropic
            // prompt cache stays warm), T1 must inject the SAME old state
            // at the SAME anchor. The next cache-busting pass will adopt
            // the new state and re-anchor.
            //
            // Empty `stateJson` means the row was persisted by an older
            // build that didn't store the snapshot — fall through to skip,
            // matching legacy behavior.
            const part = buildSyntheticTodoPart(persistedAnchor.stateJson);
            if (part !== null && part.callID === persistedAnchor.callId) {
                injectPersistedTodoAnchor(
                    args.messages,
                    args.sessionId,
                    persistedAnchor.messageId,
                    part,
                );
            }
        }
    }

    logTransformTiming(args.sessionId, "pp.noteAndTodoSynthesis", tNoteAndTodo);

    // Auto-search hint — append a vague-recall fragment hint to the latest
    // user message when experimental.auto_search is enabled and search
    // returns a high-confidence match. Gated behind fullFeatureMode: subagent
    // sessions (historian, compressor, dreamer child tasks, council members,
    // etc.) are driven by the main agent via prompt injection, not by the
    // user. There is no user prompt to semantically ground against, and
    // running embedding on subagent input wastes cycles + saturates the
    // embedding endpoint when many subagents run in parallel (e.g. Athena
    // council).
    // Degraded-cache counter: track consecutive null-boundary rebuilds.
    // This bookkeeping is independent of marker reconciliation.
    if (args.compartmentInjectionRebuiltFromDb && args.pendingCompartmentInjection) {
        if (args.pendingCompartmentInjection.compartmentEndMessageId === null) {
            const nextCount = (degradedCacheCountBySession.get(args.sessionId) ?? 0) + 1;
            degradedCacheCountBySession.set(args.sessionId, nextCount);
            if (nextCount === DEGRADE_CACHE_WARNING_THRESHOLD) {
                sessionLog(
                    args.sessionId,
                    `WARNING: compartment injection cache has rebuilt with a degraded null boundary ${nextCount} consecutive times; investigate missing boundary messages`,
                );
            }
        } else {
            degradedCacheCountBySession.delete(args.sessionId);
        }
    }

    if (
        args.fullFeatureMode &&
        isCacheBustingPass &&
        args.m0M1 &&
        (!!args.m0M1.projectPath || !!args.m0M1.projectDirectory)
    ) {
        checkM0MutationDriftAndSignal({
            db: args.db,
            sessionId: args.sessionId,
            cachedM0MaxMutationId: args.sessionMeta.cachedM0MaxMutationId,
            pendingMaterializationSessions: args.pendingMaterializationSessions,
            historyRefreshSessions: args.historyRefreshSessions,
        });
    }

    const workExecutedSuccessfully =
        explicitMaterializedSuccessfully ||
        deferredMaterializedSuccessfully ||
        heuristicsRanSuccessfully ||
        pendingOpsRanSuccessfully;

    // Work-metrics (TUI sidebar Stats) are NOT computed here. They are a
    // display-only value read solely by the RPC sidebar handler, and the
    // computation is O(session age) — it was the dominant transform cost on
    // long sessions when run every pass. It now runs lazily and incrementally
    // in buildSidebarSnapshot (rpc-handlers.ts) when the TUI actually polls,
    // keeping the prompt path free of it.

    if (workExecutedSuccessfully) {
        try {
            const currentFlag = peekDeferredExecutePending(args.db, args.sessionId);
            if (currentFlag !== null) {
                const cleared = clearDeferredExecutePendingIfMatches(
                    args.db,
                    args.sessionId,
                    currentFlag,
                );
                sessionLog(
                    args.sessionId,
                    `[boundary-exec] deferred-execute drain: ${cleared ? "cleared" : "stale-noop"} reason=${currentFlag.reason}`,
                );
            }
        } catch (err) {
            args.passOutcome?.record("deferred-execute-drain-failure");
            sessionLog(args.sessionId, `[boundary-exec] drain failed (continuing): ${err}`);
        }
    }

    if (args.fullFeatureMode && args.autoSearch?.enabled && args.projectPath) {
        // Resolve memory ids currently rendered in the <session-history>
        // block. The auto-search runner drops hint fragments for memories the
        // agent already sees in message[0] so the hint stays "vague recall"
        // for content not already in context.
        const tAutoSearch = performance.now();
        const visibleMemoryIds = getVisibleMemoryIds(args.db, args.sessionId) ?? undefined;

        try {
            const autoSearchOutcome = await runAutoSearchHint({
                sessionId: args.sessionId,
                db: args.db,
                messages: args.messages,
                options: {
                    enabled: true,
                    scoreThreshold: args.autoSearch.scoreThreshold,
                    minPromptChars: args.autoSearch.minPromptChars,
                    directory: args.autoSearch.directory ?? args.sessionDirectory,
                    projectPath: args.projectPath,
                    ensureProjectRegistered: args.autoSearch.ensureProjectRegistered,
                    visibleMemoryIds,
                },
            });
            if (!autoSearchOutcome.ok) {
                args.passOutcome?.record(`auto-search-${autoSearchOutcome.kind}`);
            }
        } catch (error) {
            args.passOutcome?.record("auto-search-internal-failure");
            sessionLog(args.sessionId, "auto-search runner failed:", error);
        }
        logTransformTiming(args.sessionId, "pp.autoSearchHint", tAutoSearch);
    }

    if (args.fullFeatureMode && isCacheBustingPass) {
        const visibleIds = new Set<string>();
        for (const message of args.messages) {
            if (typeof message.info?.id === "string") {
                visibleIds.add(message.info.id);
            }
        }
        const prunedAnchors = pruneNoteNudgeAnchors(args.db, args.sessionId, visibleIds);
        const prunedDecisions = pruneAutoSearchHintDecisions(args.db, args.sessionId, visibleIds);
        if (prunedAnchors > 0 || prunedDecisions > 0) {
            sessionLog(
                args.sessionId,
                `sticky-injection GC: pruned ${prunedAnchors} note-nudge anchor(s), ${prunedDecisions} auto-search decision(s)`,
            );
        }
    }

    const materializeReason =
        m0MaterializeReason ?? (explicitMaterializedSuccessfully ? "explicit_flush" : null);
    const materialized =
        m0RematerializedThisPass ||
        explicitMaterializedSuccessfully ||
        deferredMaterializedSuccessfully;
    const bustedThisPass =
        args.didMutateFromFlushedStatuses ||
        pendingOpsDidMutate ||
        heuristicOrReasoningDidMutate ||
        smartDropsDidMutateThisPass ||
        m0RematerializedThisPass ||
        (m0M1InjectedThisPass && historyWasConsumedThisPass) ||
        historyWasConsumedThisPass;

    // Final representation strips run once, after all topology mutations; execute
    // and defer must serialize identical prefixes. Do not add message, tool-target,
    // or role-topology mutations below this phase.
    const tFinalRepresentation = performance.now();
    const finalRepresentation = finalizeMessageRepresentation(
        args.messages,
        args.resolvedProviderID,
    );
    sessionLog(
        args.sessionId,
        `final representation: clearedParts=${finalRepresentation.clearedParts} mergedReasoningParts=${finalRepresentation.mergedReasoningParts}`,
    );
    logTransformTiming(
        args.sessionId,
        "finalizeMessageRepresentation",
        tFinalRepresentation,
        `clearedParts=${finalRepresentation.clearedParts} mergedReasoningParts=${finalRepresentation.mergedReasoningParts}`,
    );

    return {
        explicitMaterializedSuccessfully,
        deferredMaterializedSuccessfully,
        materialized,
        historianFoldMaterializedThisPass: historyWasConsumedThisPass,
        materializeReason,
        droppedTokens,
        emergencyReclaimedTokens,
        droppedCount,
        emergency,
        bustedThisPass,
    };
}

export function checkM0MutationDriftAndSignal(args: {
    db: ContextDatabase;
    sessionId: string;
    cachedM0MaxMutationId: number | null;
    pendingMaterializationSessions: Set<string>;
    historyRefreshSessions?: Set<string>;
}): boolean {
    const currentMaxMutationId = getMaxM0MutationId(args.db, args.sessionId) ?? 0;
    const cachedMaxMutationId = args.cachedM0MaxMutationId ?? 0;
    if (currentMaxMutationId !== cachedMaxMutationId) {
        args.pendingMaterializationSessions.add(args.sessionId);
        args.historyRefreshSessions?.add(args.sessionId);
        sessionLog(
            args.sessionId,
            `m[0] drift watcher: mutation id changed ${cachedMaxMutationId} → ${currentMaxMutationId}; scheduling next-pass materialization`,
        );
        return true;
    }
    return false;
}
