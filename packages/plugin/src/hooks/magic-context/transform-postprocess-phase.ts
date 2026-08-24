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
    getPersistedTodoPermissionDenied,
    getPersistedTodoSyntheticAnchor,
    getProcessedImageStrippedIds,
    getStaleReduceStrippedIds,
    getStrippedPlaceholderIds,
    type PendingCompactionMarker,
    peekDeferredExecutePending,
    pruneAutoSearchHintDecisions,
    pruneNoteNudgeAnchors,
    setPersistedTodoPermissionDenied,
    setPersistedTodoSyntheticAnchor,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    addMergedReasoningStrippedIds,
    addTrailingBlankDecisions,
    getMergedReasoningStrippedIds,
    getPersistedCompactionMarkerState,
    getTrailingBlankDecisions,
    type PersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import {
    getOldestActiveUnprotectedToolTags,
    getTagNumberByMessageId,
    getTailHygieneTags,
    updateTagStatus,
} from "../../features/magic-context/storage-tags";
import type { Tagger } from "../../features/magic-context/tagger";
import type { SessionMeta, TagEntry } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import { isRecord } from "../../shared/record-type-guard";
import { runAutoSearchHint } from "./auto-search-runner";
import {
    rearmChannel2AfterCoverageAdvancingHardFold,
    rearmChannel2AfterMeasuredCollapse,
} from "./channel2-cycle";
import { applyDeferredCompactionMarker, MARKER_SUMMARY_TEXT } from "./compaction-marker-manager";
import { getActiveCompartmentRun } from "./compartment-runner";
import type {
    CtxReduceAvailabilityVerdict,
    ToolAvailabilityVerdict,
} from "./ctx-reduce-availability";
import {
    cachedToolPermissionDenied,
    hasLoggedCtxReducePermissionDeny,
    markCtxReducePermissionDenyLogged,
    resolveToolPermissionDenied,
    todowritePermissionDenied,
} from "./ctx-reduce-availability";
import type { Channel1State } from "./ctx-reduce-nudge";
import { dropStaleReduceCalls } from "./drop-stale-reduce-calls";
import { foldExecutesThisPass } from "./fold-execution-gate";
import { applyHeuristicCleanup } from "./heuristic-cleanup";
import {
    clearInjectionCache,
    getVisibleMemoryIds,
    injectM0M1,
    type M0HardSignals,
    type M0M1State,
    type MaterializeDecision,
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
    applyFrozenTrailingBlankDecisions,
    clearOldReasoning,
    findLatestAssistantReasoningMutationExemptMessage,
    findMergedReasoningStripCandidateIds,
    findTrailingBlankDecisionCandidates,
    stripClearedReasoning,
    stripDroppedPlaceholderMessages,
    stripInlineThinking,
    stripReasoningFromMergedAssistants,
    stripSystemInjectedMessages,
    type TrailingBlankDecision,
} from "./strip-content";
import { buildEditSupersessionReclaim, buildSupersessionReclaimOps } from "./supersession-reclaim";
import { byteSize, prependTag } from "./tag-content-primitives";
import {
    assertTailHygieneContentUnchanged,
    countRealUserMessages,
    refreshTailHygieneBaseline,
    sameTailHygieneStructuralSignature,
    type TailHygieneStructuralSignature,
    tailHygieneStructuralSignature,
} from "./tail-hygiene-walk";
import { buildSyntheticTodoPart, isSyntheticTodoPart, type SyntheticTodoPart } from "./todo-view";
import {
    advanceToolReclaimWatermarkToCurrentMax,
    buildSyntheticToolReclaimOps,
} from "./tool-reclaim";
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
    // Structural shape only — an ID-less user message whose every part is
    // marked synthetic. Persisted OpenCode rows always carry an id, so no
    // persisted or foreign row can satisfy this regardless of its metadata;
    // the shape is exactly what the TS lane's prependM0M1Messages and the
    // Rust module's m0/m1 encode both produce. The TS lane additionally sets
    // info.syntheticHead, but the Rust encode does not — requiring the flag
    // here made the head walk stop at index 0 on rust-mode output and splice
    // the compaction summary AHEAD of m0, failing the m0 wire invariant on
    // every pass for sessions with persisted marker state.
    if (message.info.id !== undefined) return false;
    if (message.info.role !== "user") return false;
    const parts = message.parts;
    if (parts.length === 0) return false;
    return parts.every((part) => (part as { synthetic?: boolean }).synthetic === true);
}

const TODO_HEAD_ANCHOR_ID = "__magic_context_todo_head__";

interface SyntheticTodoInjectionResult {
    injected: boolean;
    messageId: string;
    prependedMessageCount: number;
}

function injectSyntheticTodoAtHead(
    messages: MessageLike[],
    sessionId: string,
    part: SyntheticTodoPart,
): SyntheticTodoInjectionResult {
    let headEnd = 0;
    while (headEnd < messages.length && isSyntheticHeadMessage(messages[headEnd])) {
        headEnd += 1;
    }
    const existing = messages[headEnd];
    if (existing?.info.id === TODO_HEAD_ANCHOR_ID) {
        injectToolPartIntoAssistantById(messages, TODO_HEAD_ANCHOR_ID, part);
        return {
            injected: true,
            messageId: TODO_HEAD_ANCHOR_ID,
            prependedMessageCount: 0,
        };
    }
    messages.splice(headEnd, 0, {
        info: {
            id: TODO_HEAD_ANCHOR_ID,
            role: "assistant",
            sessionID: sessionId,
        },
        parts: [part],
    });
    return {
        injected: true,
        messageId: TODO_HEAD_ANCHOR_ID,
        prependedMessageCount: 1,
    };
}

function injectPersistedTodoAnchor(
    messages: MessageLike[],
    sessionId: string,
    messageId: string,
    part: SyntheticTodoPart,
): SyntheticTodoInjectionResult {
    if (injectToolPartIntoAssistantById(messages, messageId, part)) {
        return { injected: true, messageId, prependedMessageCount: 0 };
    }
    if (messageId !== TODO_HEAD_ANCHOR_ID) {
        return { injected: false, messageId, prependedMessageCount: 0 };
    }
    return injectSyntheticTodoAtHead(messages, sessionId, part);
}

function removeSyntheticTodoParts(messages: MessageLike[]): void {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message) continue;
        const retainedParts = message.parts.filter((part) => !isSyntheticTodoPart(part));
        if (retainedParts.length === message.parts.length) continue;
        message.parts = retainedParts;
        if (message.info.id === TODO_HEAD_ANCHOR_ID && retainedParts.length === 0) {
            messages.splice(index, 1);
        }
    }
}

/**
 * Apply the synthetic todowrite pair with cache-safe live permission checks.
 * Permission is refreshed only on a cache-busting pass; defer passes replay
 * the cached verdict and frozen bytes without consulting the SDK.
 */
export async function applyTodoSynthesis(args: {
    db: ContextDatabase;
    sessionId: string;
    messages: MessageLike[];
    fullFeatureMode: boolean;
    compactionOff?: boolean;
    isCacheBustingPass: boolean;
    sessionMeta: SessionMeta;
    todowriteAvailability: ToolAvailabilityVerdict;
    client?: PluginContext["client"];
    activeAgent?: string;
}): Promise<number> {
    if (!args.fullFeatureMode || args.compactionOff) return 0;

    const persistedAnchor = getPersistedTodoSyntheticAnchor(args.db, args.sessionId);
    let permissionDenied =
        cachedToolPermissionDenied(args.sessionId, "todowrite") ??
        getPersistedTodoPermissionDenied(args.db, args.sessionId) ??
        false;
    const toolsMapUnavailable =
        args.todowriteAvailability.frozen && !args.todowriteAvailability.callable;

    if (args.isCacheBustingPass && args.client && !toolsMapUnavailable) {
        try {
            permissionDenied = await todowritePermissionDenied(
                args.client,
                args.sessionId,
                args.activeAgent,
            );
            setPersistedTodoPermissionDenied(args.db, args.sessionId, permissionDenied);
        } catch (error) {
            // A transient SDK read must not turn a previously denied tool back on.
            // Keep the last in-memory or durable verdict until a later permission
            // refresh successfully reads the live state.
            sessionLog(
                args.sessionId,
                "todowrite permission read failed; retaining the last successful verdict:",
                error,
            );
        }
    }

    const todowriteUnavailable = toolsMapUnavailable || permissionDenied;
    if (args.isCacheBustingPass && todowriteUnavailable) {
        removeSyntheticTodoParts(args.messages);
        // Clear the persisted synthetic anchor even if an older row contains only
        // one synthetic field; otherwise stale partial data could keep part of the
        // pair after the tool becomes unavailable.
        clearPersistedTodoSyntheticAnchor(args.db, args.sessionId);
        if (persistedAnchor) {
            sessionLog(
                args.sessionId,
                "todowrite synthetic pair cleared on a cache-busting pass because the tool is denied",
            );
        }
        return 0;
    }

    if (args.isCacheBustingPass) {
        const part = buildSyntheticTodoPart(args.sessionMeta.lastTodoState);
        const persistedInjection =
            part !== null && persistedAnchor && persistedAnchor.callId === part.callID
                ? injectPersistedTodoAnchor(
                      args.messages,
                      args.sessionId,
                      persistedAnchor.messageId,
                      part,
                  )
                : null;
        if (part === null) {
            if (persistedAnchor) clearPersistedTodoSyntheticAnchor(args.db, args.sessionId);
            return 0;
        }
        if (persistedAnchor && persistedInjection?.injected) {
            if (persistedAnchor.stateJson.length === 0) {
                setPersistedTodoSyntheticAnchor(
                    args.db,
                    args.sessionId,
                    persistedAnchor.callId,
                    persistedAnchor.messageId,
                    args.sessionMeta.lastTodoState,
                );
            }
            return persistedInjection.prependedMessageCount;
        }

        const existingAssistantId = injectToolPartIntoLatestAssistant(args.messages, part);
        const injection =
            existingAssistantId === null
                ? injectSyntheticTodoAtHead(args.messages, args.sessionId, part)
                : {
                      injected: true,
                      messageId: existingAssistantId,
                      prependedMessageCount: 0,
                  };
        setPersistedTodoSyntheticAnchor(
            args.db,
            args.sessionId,
            part.callID,
            injection.messageId,
            args.sessionMeta.lastTodoState,
        );
        return injection.prependedMessageCount;
    }

    // Defer pass: rebuild from the persisted snapshot, never from live
    // last_todo_state, so a real todowrite between passes cannot change bytes.
    if (persistedAnchor && persistedAnchor.stateJson.length > 0) {
        const part = buildSyntheticTodoPart(persistedAnchor.stateJson);
        if (part !== null && part.callID === persistedAnchor.callId) {
            return injectPersistedTodoAnchor(
                args.messages,
                args.sessionId,
                persistedAnchor.messageId,
                part,
            ).prependedMessageCount;
        }
    }
    return 0;
}

/**
 * Rebuild host-owned canonical representation after native Rust serving.
 * The persisted compaction summary is restored with the same canonicalizer as the
 * TypeScript lane, then note and recall anchors are replayed onto the native result.
 */
export function runRustModePostprocess(args: {
    db: ContextDatabase;
    sessionId: string;
    messages: MessageLike[];
    projectPath?: string;
    fullFeatureMode: boolean;
    compactionOff?: boolean;
    tagger: Tagger;
    ctxReduceAvailability: CtxReduceAvailabilityVerdict;
}): void {
    if (!args.fullFeatureMode || args.compactionOff) return;
    // Test doubles and older integrations may return the legacy bare message shape.
    // The host-side sticky phase only applies to OpenCode MessageLike objects, so leave
    // those responses untouched instead of treating a missing `info` object as a failure.
    if (
        args.messages.some(
            (message) =>
                !message ||
                typeof message !== "object" ||
                !isRecord((message as { info?: unknown }).info),
        )
    ) {
        return;
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
    for (const anchor of getNoteNudgeAnchors(args.db, args.sessionId)) {
        appendReminderToUserMessageById(args.messages, anchor.messageId, anchor.text);
    }
    for (const decision of getAutoSearchHintDecisions(args.db, args.sessionId)) {
        if (decision.decision === "hint") {
            appendReminderToUserMessageById(args.messages, decision.messageId, decision.text);
        }
    }

    const currentUserMessageId = findLastUserMessageId(args.messages);
    const noteReadStillVisible = hasVisibleNoteReadCall(args.messages);
    const deferredNoteText = peekNoteNudgeText(
        args.db,
        args.sessionId,
        currentUserMessageId,
        args.projectPath,
        noteReadStillVisible,
    );
    if (!deferredNoteText) return;
    const instruction = `\n\n<instruction name="deferred_notes">${deferredNoteText}</instruction>`;
    const anchoredMessageId = findLastUserMessageId(args.messages);
    const outcome = markNoteNudgeDelivered(args.db, args.sessionId, instruction, anchoredMessageId);
    if (anchoredMessageId && outcome.ok) {
        appendReminderToUserMessageById(args.messages, anchoredMessageId, instruction);
    } else if (anchoredMessageId && !outcome.ok) {
        sessionLog(args.sessionId, `rust note-nudge delivery skipped wire append: ${outcome.kind}`);
    }
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
    /** Final-array counts of reclaimable tagged mass (U) and total eligible mass (T). */
    channel1StateBySession?: Map<string, Channel1State>;
    /** Frozen-per-session verdict for the native `todowrite` tool. Gates the
     *  synthetic todo-pair injection below: a session whose tools map filters
     *  todowrite out must not get a synthetic pair for a tool it cannot call. */
    todowriteAvailability: ToolAvailabilityVerdict;
    /** OpenCode SDK for live permission checks on cache-busting passes. */
    client?: PluginContext["client"];
    /** Active agent selected by the latest user message or hook input. */
    activeAgent?: string;
    batch: { finalize: () => void } | null;
    contextUsage: { percentage: number; inputTokens: number };
    /** Usable tokens available for soft scheduling thresholds and usage-ratio calculation. */
    usableWindow: number;
    schedulerDecision: "execute" | "defer";
    fullFeatureMode: boolean;
    /**
     * Compaction-off mode (issue #266), boot-resolved. Every mutating gate in
     * this phase becomes `existingGate && !compactionOff`; the m[0]/m[1]
     * injection gate is re-expressed as identity-present AND (fullFeatureMode
     * || compactionOff) so the mode keeps additive memory/docs delivery (and
     * extends it to subagent sessions, which gain the knowledge surface).
     */
    compactionOff?: boolean;
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
        /** mural.enabled — drives the on-demand deterministic mural
         *  render inside the HARD fold. */
        muralEnabled?: boolean;
    };
}

export interface PostTransformPhaseResult {
    explicitMaterializedSuccessfully: boolean;
    deferredMaterializedSuccessfully: boolean;
    materialized: boolean;
    /** True only when this pass consumed newly folded historian history. */
    historianFoldMaterializedThisPass: boolean;
    materializeReason: string | null;
    systemHashPrev: string | null;
    systemHashNew: string | null;
    m0ModelKeyPrev: string | null;
    m0ModelKeyNew: string | null;
    m0ToolSetHashPrev: string | null;
    m0ToolSetHashNew: string | null;
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
    reason:
        | "below-emergency-band"
        | "provider-overflow-abort"
        | "proceed"
        | "trusted-final-wire-disarm";
    /** Trusted current-pass wire evidence that lets the caller clear its durable latch. */
    disarm?: { finalWireTokens: number; provenLimitTokens: number };
}

export function evaluateEmergencyFailClosed(input: {
    usagePercentage: number;
    emergencyRecoveryArmed: boolean;
    emergencyRecoveryOrigin: "provider_overflow" | "proactive_model_shrink" | null;
    foldMaterializedThisPass: boolean;
    finalWireEstimate?: { tokens: number; trusted: boolean };
    /** A current-model limit parsed from a provider overflow response, never a catalog fallback. */
    providerProvenLimitTokens?: number;
}): EmergencyFailClosedDecision {
    const estimate = input.finalWireEstimate;
    const limit = input.providerProvenLimitTokens;
    if (
        input.emergencyRecoveryArmed &&
        estimate?.trusted === true &&
        typeof limit === "number" &&
        Number.isFinite(limit) &&
        limit > 0 &&
        estimate.tokens < limit * 0.8
    ) {
        return {
            shouldAbort: false,
            reason: "trusted-final-wire-disarm",
            disarm: { finalWireTokens: estimate.tokens, provenLimitTokens: limit },
        };
    }
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
    options?: {
        prependedMessageCount?: number;
        reasoningMutatedMessages?: Iterable<MessageLike>;
        reasoningMutationExemptMessage?: MessageLike;
        trailingBlankNewestAssistant?: MessageLike;
        mergedReasoningStrippedIds?: ReadonlySet<string>;
        trailingBlankDecisions?: ReadonlyMap<string, TrailingBlankDecision>;
        skipMergedReasoningStrip?: boolean;
        skipTrailingWhitespaceStrip?: boolean;
    },
): { clearedParts: number; mergedReasoningParts: number } {
    let clearedParts = 0;
    if (modelAcceptsEmptyContent(resolvedProviderID)) {
        const prependedMessageCount = Math.min(
            messages.length,
            Math.max(0, options?.prependedMessageCount ?? 0),
        );
        const targetedMessages = options ? messages.slice(0, prependedMessageCount) : messages;
        if (options?.reasoningMutatedMessages) {
            const seen = new Set(targetedMessages);
            for (const message of options.reasoningMutatedMessages) {
                if (!seen.has(message)) {
                    seen.add(message);
                    targetedMessages.push(message);
                }
            }
        }
        if (targetedMessages.length > 0) {
            clearedParts = stripClearedReasoning(targetedMessages);
        }
    }
    let newestAssistant = options?.trailingBlankNewestAssistant;
    if (!newestAssistant) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index];
            if (message.info.role !== "assistant") continue;
            newestAssistant = message;
            break;
        }
    }
    const mergedReasoningParts = options?.skipMergedReasoningStrip
        ? 0
        : stripReasoningFromMergedAssistants(messages, resolvedProviderID, {
              mutationExemptMessage: options?.reasoningMutationExemptMessage,
              frozenMessageIds: options?.mergedReasoningStrippedIds,
          });
    if (!options?.skipTrailingWhitespaceStrip && modelAcceptsEmptyContent(resolvedProviderID)) {
        applyFrozenTrailingBlankDecisions(
            messages,
            typeof newestAssistant?.info.id === "string" ? newestAssistant.info.id : undefined,
            options?.trailingBlankDecisions ?? new Map(),
        );
    }
    return { clearedParts, mergedReasoningParts };
}

export async function runPostTransformPhase(
    args: RunPostTransformPhaseArgs,
): Promise<PostTransformPhaseResult> {
    const compactionOff = args.compactionOff === true;
    // Capture before todo/history synthesis can add assistant messages. Reasoning replay skips a
    // metadata-only OpenCode request shell, while trailing-blank freezing still tracks that newest
    // host message because its shape can change before the next pass.
    let trailingBlankNewestAssistant: MessageLike | undefined;
    for (let index = args.messages.length - 1; index >= 0; index -= 1) {
        const message = args.messages[index];
        if (message.info.role !== "assistant") continue;
        trailingBlankNewestAssistant = message;
        break;
    }
    const reasoningMutationExemptMessage = findLatestAssistantReasoningMutationExemptMessage(
        args.messages,
    );
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
        args.fullFeatureMode &&
        !compactionOff &&
        args.contextUsage.percentage >= args.forceMaterializationPercentage;
    // Tiered emergency drop eligibility (Phase 2). Unlike `forceMaterialization`
    // (primary-only — it also forces m[0] materialization), the emergency tool
    // floor fires at the derived force band for BOTH primary AND subagent: it's the only tool
    // floor subagents have now that routine age-drops are gone. It's still a
    // cache-busting-pass operation (selection persisted, defer passes replay),
    // so it only runs when heuristics run (see shouldRunHeuristics) AND usage is
    // ≥ the force-materialize threshold.
    const emergencyDropEligible =
        !compactionOff && args.contextUsage.percentage >= args.forceMaterializationPercentage;
    const activeCompartmentRun = args.canRunCompartments
        ? getActiveCompartmentRun(args.sessionId)
        : undefined;
    const compartmentRunning =
        args.canRunCompartments &&
        !args.awaitedCompartmentRun &&
        activeCompartmentRun !== undefined;
    const deferredMaterialize = args.canConsumeDeferredLate && deferredMaterializationWasPending;
    const materializationRequested = isExplicitFlush || deferredMaterialize;
    // A HARD decision alone is not a cache bust. Execute it off-wire first, then
    // let pending drops and heuristics ride the bust only when persistence reports
    // that m[0] actually materialized. A contention fallback or failed attempt
    // leaves the mutation gates closed, preserving byte-identical defer replay.
    // injectM0M1 still rechecks later, so a cross-process marker bump after this
    // pre-execution can fold safely without retroactively authorizing mutations.
    // Re-gated for compaction-off mode (issue #266): injection runs when the
    // memory/docs identity is present AND (fullFeatureMode || compactionOff),
    // so the mode cannot swallow m[0]/m[1] delivery — and a compaction-off
    // SUBAGENT session receives the additive blocks too (injectM0M1's
    // isSubagent skip is lifted by the same flag).
    const m0M1EnabledForFold =
        args.m0M1 !== undefined &&
        (!!args.m0M1.projectPath || !!args.m0M1.projectDirectory) &&
        (args.fullFeatureMode || compactionOff);
    const foldDueDecision =
        m0M1EnabledForFold && args.m0M1
            ? mustMaterialize({
                  db: args.db,
                  sessionId: args.sessionId,
                  state: args.sessionMeta as M0M1State,
                  projectPath: args.m0M1.projectPath,
                  projectDirectory: args.m0M1.projectDirectory,
                  injectDocs: args.m0M1.injectDocs,
                  muralEnabled: args.m0M1.muralEnabled,
                  memoryInjectionBudgetTokens: args.m0M1.memoryInjectionBudgetTokens,
                  historyBudgetTokens: args.m0M1.historyBudgetTokens,
                  hardSignals: args.m0M1.hardSignals,
              })
            : { value: false, reason: null };
    let foldExecutedThisPass = false;
    let m0RematerializedThisPass = false;
    const m0CoverageBeforeFold =
        args.sessionMeta.cachedM0Bytes === null ? -1 : args.sessionMeta.cachedM0MaxCompartmentSeq;
    let m0MaterializeReason: string | null = null;
    // The preflight is the decision site that decides whether m[0] must fold.
    // Keep its observational tool-set operands even when it correctly declines
    // to materialize, so a separate cache-busting pass can be attributed later.
    let m0ComparisonDecision: MaterializeDecision | null = foldDueDecision;
    if (foldDueDecision.value && args.m0M1) {
        try {
            // Persist the fold before opening mutation gates. Omitting messages
            // keeps this pre-execution off the outgoing wire; the injection phase
            // below replays the persisted pair into the real message array.
            const foldResult = injectM0M1({
                db: args.db,
                sessionId: args.sessionId,
                state: args.sessionMeta as M0M1State,
                projectPath: args.m0M1.projectPath,
                projectDirectory: args.m0M1.projectDirectory,
                injectDocs: args.m0M1.injectDocs,
                memoryInjectionBudgetTokens: args.m0M1.memoryInjectionBudgetTokens,
                historyBudgetTokens: args.m0M1.historyBudgetTokens,
                temporalAwareness: args.m0M1.temporalAwareness,
                isCacheBustingPass: true,
                hardSignals: args.m0M1.hardSignals,
                muralEnabled: args.m0M1.muralEnabled,
                compactionOff,
            });
            foldExecutedThisPass = foldExecutesThisPass(
                foldDueDecision.value,
                foldResult.m0RematerializedThisPass,
            );
            m0RematerializedThisPass = foldResult.m0RematerializedThisPass;
            m0MaterializeReason = foldResult.decision.reason;
            if (foldResult.m0RematerializedThisPass) {
                m0ComparisonDecision = foldResult.decision;
            }
            try {
                rearmChannel2AfterCoverageAdvancingHardFold({
                    db: args.db,
                    sessionId: args.sessionId,
                    foldExecuted: foldExecutedThisPass,
                    compactionOff,
                    previousCoverage: m0CoverageBeforeFold,
                    currentCoverage: args.sessionMeta.cachedM0MaxCompartmentSeq,
                });
            } catch (error) {
                sessionLog(args.sessionId, "channel2 fold-cycle reset failed (ignored):", error);
            }
        } catch (error) {
            args.passOutcome?.record("m0-m1-fold-preexecution-degradation");
            sessionLog(
                args.sessionId,
                "transform: m[0] HARD fold pre-execution failed:",
                getErrorMessage(error),
            );
        }
        sessionLog(
            args.sessionId,
            `m[0] HARD fold decision: reason=${foldDueDecision.reason ?? "unknown"} executed=${foldExecutedThisPass}`,
        );
    }
    // Bypass the compartment-running veto when this pass is busting the Anthropic
    // prefix REGARDLESS — so the pending-op drain + heuristics ride that one bust
    // instead of being deferred into a SECOND bust ~a turn later. Two cases:
    //   - forceMaterialization (the derived force band): overflow prevention trumps cache stability.
    //   - foldExecutedThisPass: a HARD m[0] fold (model/system-hash/epoch/etc.) is
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
    const bypassCompartmentGate = forceMaterialization || foldExecutedThisPass;
    const shouldReadPendingOps =
        !compactionOff &&
        (materializationRequested ||
            args.schedulerDecision === "execute" ||
            forceMaterialization ||
            foldExecutedThisPass ||
            compartmentRunning);
    const pendingOps = shouldReadPendingOps ? getPendingOps(args.db, args.sessionId) : [];
    const hasPendingUserOps = pendingOps.length > 0;
    // Keep pending-op materialization coupled to the force signal itself. This
    // prevents an escalation-band change from letting emergency cleanup mutate
    // the wire while queued operations remain deferred.
    const shouldApplyPendingOps =
        !compactionOff &&
        (args.schedulerDecision === "execute" ||
            materializationRequested ||
            forceMaterialization ||
            foldExecutedThisPass) &&
        (!compartmentRunning || bypassCompartmentGate);
    // Heuristic cleanup runs for ALL sessions — primary and subagent. Subagents
    // previously skipped heuristics entirely (via fullFeatureMode gate), which
    // meant their context grew unchecked until overflow. With this change,
    // subagents run tool drops and reasoning clearing at execute threshold just
    // like primary sessions, giving them a cache-safe reduction path without
    // needing historian/compartments.
    //
    // `forceMaterialization` remains gated by `fullFeatureMode` above (line ~125)
    // so subagents do NOT get force-band drop-all-tools or the 95% block. Subagents
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
        !compactionOff &&
        (!compartmentRunning || bypassCompartmentGate) &&
        (materializationRequested ||
            forceMaterialization ||
            // The off-wire fold landed, so the prefix already busted. Heuristics
            // may ride it and bypass the once-per-turn guard without creating an
            // independent mid-turn rewrite.
            foldExecutedThisPass ||
            // the derived force band emergency floor for BOTH primary and subagent. For a primary
            // this coincides with forceMaterialization (fullFeatureMode && the derived force band);
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
    // ctx_reduce stays frozen for prompt-hash stability, but observe the live
    // permission signal on the same busts so an operator knows guidance may be
    // stale until the session restarts. This log never changes the wire.
    if (
        isCacheBustingPass &&
        args.client &&
        args.ctxReduceAvailability.callable &&
        !hasLoggedCtxReducePermissionDeny(args.sessionId)
    ) {
        try {
            const denied = await resolveToolPermissionDenied(
                args.client,
                args.sessionId,
                "ctx_reduce",
                args.activeAgent,
            );
            if (denied) {
                markCtxReducePermissionDenyLogged(args.sessionId);
                sessionLog(
                    args.sessionId,
                    "ctx_reduce permission is denied by OpenCode; frozen guidance remains until session restart",
                );
            }
        } catch (error) {
            sessionLog(args.sessionId, "ctx_reduce permission read failed (ignored):", error);
        }
    }
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
                : foldExecutedThisPass && args.schedulerDecision !== "execute"
                  ? `m0_hard_fold (drain folded into executed m[0] bust, scheduler=${args.schedulerDecision})`
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
            const bypassReason = forceMaterialization
                ? `emergency >=${args.forceMaterializationPercentage}%`
                : "m0 hard fold";
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
    let m0M1InjectedThisPass = false;
    let prependedMessageCount = 0;
    const reasoningMutatedMessages = new Set<MessageLike>();
    let reasoningMutationTargetUnknown = false;
    if (args.didMutateFromFlushedStatuses) {
        for (const target of args.targets.values()) {
            if (target.message) reasoningMutatedMessages.add(target.message);
            else reasoningMutationTargetUnknown = true;
        }
    }
    let autoReclaimDidMutateThisPass = false;
    try {
        if (shouldApplyPendingOps) {
            const applyReason = isExplicitFlush
                ? "explicit_flush"
                : deferredMaterialize
                  ? "deferred_materialization"
                  : foldExecutedThisPass && args.schedulerDecision !== "execute"
                    ? `m0_hard_fold (drain folded into executed m[0] bust, scheduler=${args.schedulerDecision})`
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
                for (const pendingOp of pendingOps) {
                    const message = args.targets.get(pendingOp.tagId)?.message;
                    if (message) reasoningMutatedMessages.add(message);
                    else reasoningMutationTargetUnknown = true;
                }
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
                    // Tiered emergency drop fires only at the derived force band (both primary and
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

        const toolReclaimExecutePass = !compactionOff && args.schedulerDecision === "execute";
        const alreadyMutatingThisPass = pendingOpsDidMutate || heuristicOrReasoningDidMutate;
        let autoReclaimTargetCount = 0;
        let autoReclaimDidMutate = false;
        if (toolReclaimExecutePass && alreadyMutatingThisPass && !emergencyDropEligible) {
            const syntheticPendingOps = buildSyntheticToolReclaimOps({
                db: args.db,
                sessionId: args.sessionId,
                targets: args.targets,
                watermark: args.sessionMeta.toolReclaimWatermark ?? 0,
                pendingOps,
            });
            // Smart-drops: reclaim spent control-plane outputs that a later
            // call supersedes (older todowrite/ctx_reduce/meta), and compress
            // superseded edits to an edit_marker (keep filePath + region hint).
            // Merged into the same gated apply as the age-based sweep. Dedupe
            // against those ops (a tag can qualify under more than one rule).
            const editMarkerTagIds = new Set<number>();
            if (args.smartDrops) {
                const selectedIds = new Set(syntheticPendingOps.map((op) => op.tagId));
                const supersessionOps = buildSupersessionReclaimOps({
                    db: args.db,
                    sessionId: args.sessionId,
                    targets: args.targets,
                    pendingOps,
                });
                for (const op of supersessionOps) {
                    if (!selectedIds.has(op.tagId)) {
                        syntheticPendingOps.push(op);
                        selectedIds.add(op.tagId);
                    }
                }
                const editReclaim = buildEditSupersessionReclaim({
                    db: args.db,
                    sessionId: args.sessionId,
                    targets: args.targets,
                    pendingOps,
                });
                for (const op of editReclaim.ops) {
                    // A superseded edit only compresses if no earlier rule already
                    // selected it for a full/skeleton drop (drop wins; it reclaims
                    // strictly more).
                    if (!selectedIds.has(op.tagId)) {
                        syntheticPendingOps.push(op);
                        selectedIds.add(op.tagId);
                        editMarkerTagIds.add(op.tagId);
                    }
                }
            }
            autoReclaimTargetCount = syntheticPendingOps.length;
            if (syntheticPendingOps.length > 0) {
                autoReclaimDidMutate = applyPendingOperations(
                    args.sessionId,
                    args.db,
                    args.targets,
                    args.protectedTags,
                    undefined,
                    [],
                    syntheticPendingOps,
                    editMarkerTagIds,
                );
                if (autoReclaimDidMutate) {
                    droppedCount += syntheticPendingOps.length;
                    autoReclaimDidMutateThisPass = true;
                    for (const pendingOp of syntheticPendingOps) {
                        const message = args.targets.get(pendingOp.tagId)?.message;
                        if (message) reasoningMutatedMessages.add(message);
                        else reasoningMutationTargetUnknown = true;
                    }
                }
            }
        }
        args.batch?.finalize();
        if (toolReclaimExecutePass) {
            const maxTagNumber = advanceToolReclaimWatermarkToCurrentMax(args.db, args.sessionId);
            args.sessionMeta.toolReclaimWatermark = Math.max(
                args.sessionMeta.toolReclaimWatermark ?? 0,
                maxTagNumber,
            );
        }
        if (autoReclaimTargetCount > 0) {
            sessionLog(
                args.sessionId,
                `tool reclaim auto-drop: targets=${autoReclaimTargetCount} mutated=${autoReclaimDidMutate}`,
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
    if (canUseEmptySentinels && !compactionOff) {
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
    if (canUseEmptySentinels && !compactionOff) {
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
                muralEnabled: args.m0M1.muralEnabled,
                // Compaction-off materializes through the zero-compartment
                // path: memory/docs/user-profile render, but historical
                // compartment rows never reach <session-history>.
                compactionOff,
            });
            if (result.injected) {
                m0M1InjectedThisPass = true;
                prependedMessageCount += result.prependedMessageCount;
                m0RematerializedThisPass ||= result.m0RematerializedThisPass;
                m0MaterializeReason = result.decision.reason ?? m0MaterializeReason;
                if (result.m0RematerializedThisPass) {
                    m0ComparisonDecision = result.decision;
                }
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
                    const fallbackResult = renderCompartmentInjection(
                        args.sessionId,
                        args.messages,
                        args.pendingCompartmentInjection,
                    );
                    prependedMessageCount += fallbackResult.prependedMessageCount;
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
    } else if (args.fullFeatureMode && !compactionOff && args.pendingCompartmentInjection) {
        const compartmentResult = renderCompartmentInjection(
            args.sessionId,
            args.messages,
            args.pendingCompartmentInjection,
        );
        if (compartmentResult.injected) {
            prependedMessageCount += compartmentResult.prependedMessageCount;
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
    //
    // Compaction-off: placeholder/system-injected neutralization is strip
    // machinery — gated off; the wire keeps its original shape.
    if (!compactionOff) {
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
    if (args.fullFeatureMode && !compactionOff) {
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

    // Compaction-off: the marker reconciler and the deferred marker drain are
    // compaction machinery — gated off. The off-transition deletes the MC
    // marker rows and clears the persisted/pending marker state, so nothing
    // here has state to replay; leaving it live would re-insert a synthetic
    // summary into the wire of a mode that must stay additive-only.
    if (!compactionOff) {
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
    }

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

    // Todo state synthesis is deliberately isolated so its live permission
    // refresh and cache-boundary behavior can be tested independently.
    if (args.fullFeatureMode && !compactionOff) {
        prependedMessageCount += await applyTodoSynthesis({
            db: args.db,
            sessionId: args.sessionId,
            messages: args.messages,
            fullFeatureMode: args.fullFeatureMode,
            compactionOff,
            isCacheBustingPass,
            sessionMeta: args.sessionMeta,
            todowriteAvailability: args.todowriteAvailability,
            client: args.client,
            activeAgent: args.activeAgent,
        });
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
    let bustedThisPass =
        args.didMutateFromFlushedStatuses ||
        pendingOpsDidMutate ||
        heuristicOrReasoningDidMutate ||
        autoReclaimDidMutateThisPass ||
        m0RematerializedThisPass ||
        (m0M1InjectedThisPass && historyWasConsumedThisPass) ||
        historyWasConsumedThisPass;

    // Final representation strips run once, after all topology mutations; execute
    // and defer must serialize identical prefixes. Do not add message, tool-target,
    // or role-topology mutations below this phase.
    //
    if (reasoningMutationTargetUnknown) {
        const reasoningCandidates =
            args.reasoningByMessage.size > 0 ? args.reasoningByMessage.keys() : args.messages;
        for (const message of reasoningCandidates) {
            const hasClearedReasoning = message.parts.some((part) => {
                if (part === null || typeof part !== "object") return false;
                const candidate = part as { type?: unknown; thinking?: unknown; text?: unknown };
                if (candidate.type !== "reasoning" && candidate.type !== "thinking") return false;
                return candidate.thinking === "[cleared]" || candidate.text === "[cleared]";
            });
            if (hasClearedReasoning) reasoningMutatedMessages.add(message);
        }
    }

    // The original corpus was already cleared in transform.ts. After that point,
    // only explicit injection results add messages, while flushed/pending tool or
    // text drops can rewrite an owning assistant's reasoning to `[cleared]`. Todo synthesis,
    // notes, marker reconciliation, and auto-search add only tool/text parts, so
    // they cannot create a cleared reasoning shell. Keeping the exact injected
    // head count plus owning mutation targets preserves the old full-array result
    // without repeating its O(session) walk. A legacy/custom target that omits its
    // owner pays one mutation-pass discovery scan above; steady defer never does.
    // Merged-assistant reasoning follows the same frozen WRITE/REPLAY split as
    // stale ctx_reduce and processed images. Detection opens only on the shared
    // cache-busting gate; replay applies the persisted id set on every pass.
    // Persist before first mutation so a fresh defer rebuild can always reproduce
    // any stripped bytes. The newest assistant is excluded from both detection
    // and replay because Anthropic requires its signed blocks byte-identically.
    const mergedReasoningStrippedIds = new Set<string>();
    if (canUseEmptySentinels && !compactionOff) {
        try {
            for (const id of getMergedReasoningStrippedIds(args.db, args.sessionId)) {
                mergedReasoningStrippedIds.add(id);
            }
            if (isCacheBustingPass) {
                const candidates = findMergedReasoningStripCandidateIds(
                    args.messages,
                    args.resolvedProviderID,
                    { mutationExemptMessage: reasoningMutationExemptMessage },
                );
                const newlyDetectedIds = candidates.filter(
                    (id) => !mergedReasoningStrippedIds.has(id),
                );
                if (newlyDetectedIds.length > 0) {
                    const persisted = addMergedReasoningStrippedIds(
                        args.db,
                        args.sessionId,
                        newlyDetectedIds,
                    );
                    if (persisted) {
                        for (const id of newlyDetectedIds) mergedReasoningStrippedIds.add(id);
                        bustedThisPass = true;
                    } else {
                        args.passOutcome?.record("merged-reasoning-strip-persistence-failure");
                        sessionLog(
                            args.sessionId,
                            "merged reasoning strip: persistence failed; leaving newly detected assistants intact",
                        );
                    }
                }
            }
        } catch (error) {
            args.passOutcome?.record("merged-reasoning-strip-exception");
            sessionLog(args.sessionId, "transform failed freezing merged reasoning strip:", error);
        }
    }

    const trailingBlankDecisions = new Map<string, TrailingBlankDecision>();
    if (canUseEmptySentinels && !compactionOff) {
        try {
            for (const [id, decision] of getTrailingBlankDecisions(args.db, args.sessionId)) {
                trailingBlankDecisions.set(id, decision);
            }
        } catch (error) {
            args.passOutcome?.record("trailing-blank-decision-load-exception");
            sessionLog(args.sessionId, "transform failed loading trailing blank decisions:", error);
        }
    }

    const newestAssistantId =
        typeof trailingBlankNewestAssistant?.info.id === "string"
            ? trailingBlankNewestAssistant.info.id
            : undefined;
    const tFinalRepresentation = performance.now();
    const finalRepresentation = finalizeMessageRepresentation(
        args.messages,
        args.resolvedProviderID,
        {
            prependedMessageCount,
            reasoningMutatedMessages,
            reasoningMutationExemptMessage,
            trailingBlankNewestAssistant,
            mergedReasoningStrippedIds,
            trailingBlankDecisions,
            skipMergedReasoningStrip: compactionOff,
            skipTrailingWhitespaceStrip: compactionOff,
        },
    );

    if (canUseEmptySentinels && !compactionOff) {
        // Observe every served pass, including defers. A newly completed assistant is
        // recorded while it is newest, before a provider can append a blank to the
        // rebuilt historical message. If a late blank arrives while it is still newest,
        // refresh its choice; the newest exemption leaves those live bytes untouched.
        const detectedCandidates = findTrailingBlankDecisionCandidates(
            args.messages,
            trailingBlankDecisions,
            { refreshMessageId: newestAssistantId },
        );
        // A defer pass can safely establish only the newest assistant's shape: it
        // has no cached continuation after it. Historical messages without a prior
        // decision wait for an independent cache-busting pass rather than guessing
        // from bytes that the provider may already have changed.
        const candidates = isCacheBustingPass
            ? detectedCandidates
            : detectedCandidates.filter(([id]) => id === newestAssistantId);
        if (candidates.length > 0) {
            try {
                const persisted = addTrailingBlankDecisions(args.db, args.sessionId, candidates, {
                    overwriteMessageId: newestAssistantId,
                });
                if (persisted) {
                    const committed = getTrailingBlankDecisions(args.db, args.sessionId);
                    const newlyFrozen = new Map<string, TrailingBlankDecision>();
                    for (const [id] of candidates) {
                        const decision = committed.get(id);
                        if (!decision) continue;
                        trailingBlankDecisions.set(id, decision);
                        newlyFrozen.set(id, decision);
                    }
                    // Apply a new keep decision while the assistant is still newest
                    // so whitespace becomes canonical without changing the recorded
                    // suffix length. A strip decision remains exempt while it is live.
                    applyFrozenTrailingBlankDecisions(
                        args.messages,
                        newestAssistantId,
                        newlyFrozen,
                    );
                    if (isCacheBustingPass) bustedThisPass = true;
                } else {
                    args.passOutcome?.record("trailing-blank-decision-persistence-failure");
                    sessionLog(
                        args.sessionId,
                        "trailing blank decision: persistence failed; leaving newly observed assistants intact",
                    );
                }
            } catch (error) {
                args.passOutcome?.record("trailing-blank-decision-exception");
                sessionLog(
                    args.sessionId,
                    "transform failed freezing trailing blank decision:",
                    error,
                );
            }
        }
    }

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

    let assertedBaseline:
        | {
              tags: TagEntry[];
              protectedTags: number;
              contentSignature: string;
              structuralSignature: TailHygieneStructuralSignature;
          }
        | undefined;
    if (args.channel1StateBySession) {
        if (args.ctxReduceAvailability.callable && !compactionOff) {
            try {
                const tags = getTailHygieneTags(args.db, args.sessionId);
                // A queued ctx_reduce drop is already actioned by the agent. Keep its
                // still-rendered bytes in T, but exclude it from the actionable U backlog.
                const pendingDropTagNumbers = new Set(
                    getPendingOps(args.db, args.sessionId)
                        .filter((operation) => operation.operation === "drop")
                        .map((operation) => operation.tagId),
                );
                const previous = args.channel1StateBySession.get(args.sessionId);
                const baseline = refreshTailHygieneBaseline({
                    messages: args.messages,
                    tags,
                    protectedTags: args.protectedTags,
                    pendingDropTagNumbers,
                    cacheBusting: bustedThisPass,
                    previous,
                });
                const structuralSignature = tailHygieneStructuralSignature(args.messages);
                args.channel1StateBySession.set(args.sessionId, {
                    ...baseline,
                    usableWindow: args.usableWindow,
                    realUserTurnCount: countRealUserMessages(args.messages),
                    reducedSinceRefresh:
                        baseline.baselineGeneration !== previous?.baselineGeneration
                            ? false
                            : (previous?.reducedSinceRefresh ?? false),
                    agentDropsAppliedThisPass: pendingOpsDidMutate,
                    oldestReclaimableToolTags: getOldestActiveUnprotectedToolTags(
                        args.db,
                        args.sessionId,
                        args.protectedTags,
                    ),
                });
                try {
                    rearmChannel2AfterMeasuredCollapse({
                        db: args.db,
                        sessionId: args.sessionId,
                        baseline,
                    });
                } catch (error) {
                    sessionLog(
                        args.sessionId,
                        "channel2 U-collapse reset failed (ignored):",
                        error,
                    );
                }
                assertedBaseline = {
                    tags,
                    protectedTags: args.protectedTags,
                    contentSignature: baseline.contentSignature,
                    structuralSignature,
                };
            } catch (error) {
                const stale = args.channel1StateBySession.get(args.sessionId);
                if (stale) {
                    stale.evaluable = false;
                    stale.generationInvalidated = true;
                }
                sessionLog(args.sessionId, "tail hygiene baseline refresh failed (held):", error);
            }
        } else {
            args.channel1StateBySession.delete(args.sessionId);
        }
    }
    if (assertedBaseline) {
        try {
            const servedSignature = tailHygieneStructuralSignature(args.messages);
            if (
                !sameTailHygieneStructuralSignature(
                    assertedBaseline.structuralSignature,
                    servedSignature,
                )
            ) {
                sessionLog(
                    args.sessionId,
                    `ERROR [tail-hygiene-last-writer-mismatch]: served messages changed after tail-hygiene baseline refresh (expected messages=${assertedBaseline.structuralSignature.messageCount}, parts=[${assertedBaseline.structuralSignature.partCounts.join(",")}], bytes=${assertedBaseline.structuralSignature.totalBytes}; actual messages=${servedSignature.messageCount}, parts=[${servedSignature.partCounts.join(",")}], bytes=${servedSignature.totalBytes})`,
                );
            }
        } catch (error) {
            // This diagnostic must never interrupt a turn. The tail baseline still
            // guides the nudge, and the next served pass can refresh it.
            sessionLog(
                args.sessionId,
                "ERROR [tail-hygiene-last-writer-check-failed]: structural production guard failed open:",
                error,
            );
        }
        if (process.env.NODE_ENV !== "production") {
            assertTailHygieneContentUnchanged({
                messages: args.messages,
                tags: assertedBaseline.tags,
                protectedTags: assertedBaseline.protectedTags,
                expectedSignature: assertedBaseline.contentSignature,
            });
        }
    }

    return {
        explicitMaterializedSuccessfully,
        deferredMaterializedSuccessfully,
        materialized,
        historianFoldMaterializedThisPass: historyWasConsumedThisPass,
        materializeReason,
        systemHashPrev: m0RematerializedThisPass
            ? (m0ComparisonDecision?.systemHashPrev ?? null)
            : null,
        systemHashNew: m0RematerializedThisPass
            ? (m0ComparisonDecision?.systemHashNew ?? null)
            : null,
        m0ModelKeyPrev: m0RematerializedThisPass
            ? (m0ComparisonDecision?.m0ModelKeyPrev ?? null)
            : null,
        m0ModelKeyNew: m0RematerializedThisPass
            ? (m0ComparisonDecision?.m0ModelKeyNew ?? null)
            : null,
        m0ToolSetHashPrev: m0ComparisonDecision?.m0ToolSetHashPrev ?? null,
        m0ToolSetHashNew: m0ComparisonDecision?.m0ToolSetHashNew ?? null,
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
