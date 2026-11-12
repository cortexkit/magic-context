import { compareOpenCodeMessagesByCanonicalOrder } from "../../features/magic-context/compaction-marker";
import {
    mergeProtectedTools,
    normalizeProtectedToolName,
    protectedToolTagNumbers,
} from "../../features/magic-context/reclaim-protection";
import type { RequestToolsChange } from "../../features/magic-context/request-tool-definitions";
import {
    HYGIENE_PROVIDER_UNITS_VERSION,
    sessionDecisionCalibration,
    transitionSessionHygieneUnits,
} from "../../features/magic-context/session-decision-calibration";
import {
    addProcessedImageStrippedIds,
    addStaleReduceStrippedIds,
    applyStrippedPlaceholderDelta,
    type ContextDatabase,
    captureChannel1PostReduceGraceBaseline,
    clearPendingCompactionMarkerStateIf,
    clearPersistedTodoSyntheticAnchor,
    flushAutoSearchHintDecisionRetirement,
    getActiveTagsBySession,
    getAutoSearchHintDecisions,
    getChannel1NudgeState,
    getMaxDroppedTagNumber,
    getMaxM0MutationId,
    getNoteNudgeAnchors,
    getOrCreateSessionMeta,
    getPendingCompactionMarkerState,
    getPendingOps,
    getPendingOpsCount,
    getPersistedTodoPermissionDenied,
    getPersistedTodoSyntheticAnchor,
    getTagsBySession,
    type PendingCompactionMarker,
    pruneNoteNudgeAnchors,
    replacePendingCompactionMarkerStateIf,
    setPendingCompactionMarkerState,
    setPersistedTodoPermissionDenied,
    setPersistedTodoSyntheticAnchor,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    hostInstructionRetentionEnabled,
    isHostInstructionRetentionOn,
} from "../../features/magic-context/storage-host-instruction-retention";
import {
    addMergedReasoningStrippedIds,
    addTrailingBlankDecisions,
    clearEmergencyDropSample,
    compactionOffFrozenThinkingIds,
    compactionOffThinkingFrozenId,
    demoteTrailingBlankKeepDecisions,
    getDeferredClearedCompactionMarkerState,
    getEmergencyInputSample,
    getMergedReasoningStrippedIds,
    getPersistedCompactionMarkerState,
    getProcessedImageMarkers,
    getThinkingBindingRecoveryTarget,
    getTrailingBlankDecisions,
    type PersistedCompactionMarkerState,
    type PostprocessReplaySnapshot,
    retireDeferredClearedCompactionMarkerState,
    setEmergencyDropSample,
    setPersistedCompactionMarkerState,
    THINKING_BINDING_RECOVERY_FROZEN_PREFIX,
    thinkingBindingRecoveryFrozenId,
} from "../../features/magic-context/storage-meta-persisted";
import {
    addRemovedReasoningIds,
    getReasoningRemovalState,
    markDropLeavesReasoning,
} from "../../features/magic-context/storage-reasoning-removal";
import {
    getTagNumberByMessageId,
    markTagsCompactedByMessageIds,
    tryGetReasoningTokenEstimatesByMessage,
    updateTagStatus,
} from "../../features/magic-context/storage-tags";
import type { Tagger } from "../../features/magic-context/tagger";
import {
    freezeTemporalDecisions,
    getTemporalDecisions,
} from "../../features/magic-context/temporal-decisions";
import type { SessionMeta, TagEntry } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import { getUnpublishedAutoSearchNoHint } from "../../shared/auto-search-lifecycle";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import { isRecord } from "../../shared/record-type-guard";
import { stableStringify } from "../../shared/stable-json";
import { hasAnthropicReasoning } from "./active-anthropic-turn";
import {
    applyFlushedStatuses,
    type ConvertedToolDropMode,
    foldBustsServedPrefix,
    foldChangesServedPrefix,
    foldInvalidatesThinking,
    prepareAgedToolSkeletonConversions,
    prepareLegacyToolSkeletonConversions,
    renderConvertedToolSkeletons,
} from "./apply-operations";
import { runAutoSearchHint } from "./auto-search-runner";
import { reclaimRideLabel } from "./cache-busting-signals";
import type { CavemanWordRules } from "./caveman";
import {
    rearmChannel2AfterCoverageAdvancingHardFold,
    rearmChannel2AfterMeasuredCollapse,
} from "./channel2-cycle";
import {
    applyDeferredCompactionMarker,
    MARKER_SUMMARY_TEXT,
    type MarkerUpdateOutcome,
} from "./compaction-marker-manager";
import { getActiveCompartmentRun } from "./compartment-runner";
import type {
    CtxReduceAvailabilityVerdict,
    ToolAvailabilityVerdict,
} from "./ctx-reduce-availability";
import {
    cachedToolPermissionDenied,
    hasLoggedCtxReducePermissionDeny,
    observeCtxReducePermissionDeny,
    todowritePermissionDenied,
} from "./ctx-reduce-availability";
import type { Channel1State } from "./ctx-reduce-nudge";
import { degradedPassError } from "./degraded-pass-refusal";
import { diagnosticStateChanged } from "./diagnostic-log-state";
import { dropStaleReduceCalls, gateStaleReduceAdmission } from "./drop-stale-reduce-calls";
import {
    type DroppedTokenReduction,
    estimateDroppedTokensFromTagReductions,
} from "./dropped-token-estimate";
import {
    createEditAdmission,
    type EditAdmission,
    type EditCoord,
    isAdmissionUser,
    thinkingAnchor,
} from "./edit-admission";
import { EmergencyFailClosedError, outgoingContextRefusal } from "./emergency-fail-closed";
import {
    clearExecuteReclaimState,
    estimateExecuteReclaimTokens,
    originateExecuteReclaim,
    readExecuteReclaimState,
} from "./execute-reclaim";
import { foldExecutesThisPass } from "./fold-execution-gate";
import { applyHeuristicCleanup } from "./heuristic-cleanup";
import {
    beginHostCheckpointPass,
    completeHostCheckpointPass,
    hostCheckpointHeadChange,
    stageServedHead,
} from "./host-checkpoint-ride";
import type { HostRowReclaim } from "./host-served-rows";
import {
    clearInjectionCache,
    getVisibleMemoryIds,
    hasCompleteCachedM0M1,
    hydrateCachedM0Mural,
    type InjectM0M1Result,
    injectM0M1,
    type M0HardSignals,
    type M0M1RenderOptions,
    type M0M1State,
    MaterializeContentionError,
    type MaterializeDecision,
    mustMaterialize,
    type PrefixTrimRefusal,
    type PrefixTrimSourceOrder,
    type PrefixTrimStatus,
    type PreparedCompartmentInjection,
    prepareCachedM0M1Replay,
    renderCompartmentInjection,
    servedHeadTexts,
} from "./inject-compartments";
import {
    isAnthropicThinkingPart,
    protectNewTagMutations,
    retainedActiveThinkingParts,
} from "./latest-assistant-turn";
import { isLatestThinkingRecoveryTarget } from "./latest-thinking-recovery";
import { markNoteNudgeDelivered, observeNoteNudgeServe, peekNoteNudgeText } from "./note-nudger";
import { hasVisibleNoteReadCall } from "./note-visibility";
import {
    editOutsideCompanionTransaction,
    pairedThinkingEdit,
    snapshotSessionFlag,
    snapshotSessionValue,
    todoCompanionRequired,
} from "./paired-thinking-edit";
import {
    decidePassMutation,
    emergencyEpisodeRearms,
    emergencyRewriteAlreadyPriced,
    routineCleanupAdmitted,
} from "./pass-mutation-decision";
import type { PassDegradationKind, PassDegradationSite, PassOutcome } from "./pass-outcome";
import {
    postprocessOldestTags,
    postprocessReplaySnapshot,
    postprocessTailTags,
} from "./postprocess-read-cache";
import {
    prepareStructuralSentinelChoices,
    projectStructuralSentinels,
} from "./project-structural-sentinels";
import { providerVisiblePart } from "./provider-visible-parts";
import { estimateTokens } from "./read-session-formatting";
import { DEFAULT_KEEP_REASONING_TOKENS, opencodeReasoningBudgetCutoff } from "./reasoning-budget";
import { captureOpencodeReasoningBudgetStatus } from "./reasoning-budget-status";
import {
    type DroppedReasoningMode,
    removeReasoningParts,
    selectReasoningRemovals,
    settleDroppedReasoningParts,
} from "./reasoning-removal";
import {
    forgetRoutinePressureEpisode,
    heuristicsAlreadyRanThisTurn,
    markRoutinePressureApplied,
    pressureBands,
    routinePressureAlreadyApplied,
    safeReasoningCutoff as sharedSafeReasoningCutoff,
    snapshotRoutinePressureEpisode,
    updateRoutinePressureEpisode,
} from "./routine-cleanup-decision";
import {
    isAnthropicFamilyRoute,
    isNeutralizedReasoningPart,
    modelAcceptsEmptyContent,
    replaySentinelByMessageIds,
} from "./sentinel";
import {
    type PrefixProvenance,
    prefixRecordProblem,
    prefixTurn,
    readServedPrefix,
    refuseServedPrefix,
    type ServedPrefix,
    validateServedPrefix,
    writeServedPrefix,
} from "./served-prefix";
import { prepareServedShapeRepair } from "./served-shape-repair";
import { resolveSignedThinkingHoldPolicy } from "./signed-thinking-hold";
import { servedPrefixMatches } from "./strict-thinking-prefix";
import {
    applyFrozenTrailingBlankDecisions,
    captureInlineThinkingRepairs,
    clearOldReasoning,
    findLatestAssistantReasoningMutationExemptMessage,
    findMergedReasoningStripDecisions,
    findReasoningBearingAssistantIds,
    findTrailingBlankDecisionCandidates,
    replayClearedReasoning,
    replayStrippedInlineThinking,
    snapshotTrailingBlankSourceDecisions,
    stripClearedReasoning,
    stripDroppedPlaceholderMessages,
    stripInlineThinking,
    stripReasoningFromAssistantIds,
    stripReasoningFromMergedAssistants,
    stripSystemInjectedMessages,
    type TrailingBlankDecision,
    type TrailingBlankSourceDecisions,
} from "./strip-content";
import {
    buildEditSupersessionReclaim,
    buildSupersessionReclaimOps,
    recentSupersessionOwnerMessageIds,
} from "./supersession-reclaim";
import { byteSize, prependTag } from "./tag-content-primitives";
import { waitForTagOwners } from "./tag-owner-warmup";
import {
    assertTailHygieneContentUnchangedIfEnabled,
    countRealUserMessages,
    effectiveTailHygiene,
    formatTailHygienePrefixMismatch,
    refreshTailHygieneBaseline,
    sameTailHygieneStructuralSignature,
    type TailHygieneStructuralSignature,
    tailHygieneStructuralSignature,
} from "./tail-hygiene-walk";
import { admitTemporalCandidates } from "./temporal-admission";
import { injectTemporalMarkers } from "./temporal-awareness";
import { buildSyntheticTodoPart, isSyntheticTodoPart, type SyntheticTodoPart } from "./todo-view";
import { openCodeToolBatchCoordinates, protectToolBatchMutations } from "./tool-arc-admission";
import {
    advanceToolReclaimWatermarkByDistance,
    buildSyntheticToolReclaimOps,
    toolReclaimDistanceEntries,
} from "./tool-reclaim";
import {
    appendReminderToUserMessageById,
    findNoteNudgeUserMessageId,
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
import { ParkedBustTriggers } from "./trigger-parking";

const DEGRADE_CACHE_WARNING_THRESHOLD = 10;
/**
 * Keep the newest host-message tail intact when retiring system-only notifications.
 * This is an actionable-message heuristic, not the persisted tag protection window.
 */
const SYSTEM_INJECTION_ACTIONABLE_TAIL_MESSAGES = 40;
// Bounded (LRU, max 100) so a crashed/never-reset session can't leak an entry
// forever in a long-running process — matches the other per-session caches.
const degradedCacheCountBySession = new BoundedSessionMap<number>(100);
const parkedBustTriggersBySession = new Map<string, ParkedBustTriggers>();

export function hasParkedBustTrigger(sessionId: string): boolean {
    return parkedBustTriggersBySession.get(sessionId)?.pending === true;
}

export function resetDegradedCacheCount(sessionId: string): void {
    degradedCacheCountBySession.delete(sessionId);
    forgetRoutinePressureEpisode(sessionId);
    parkedBustTriggersBySession.delete(sessionId);
}

export type DeferredCompactionMarkerClearOutcome =
    | "cleared"
    | "cas-lost-newer-pending"
    | "cas-lost-already-cleared";

export function isSyntheticHeadMessage(message: MessageLike): boolean {
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
    editAdmission?: EditAdmission;
    sessionMeta: SessionMeta;
    todowriteAvailability: ToolAvailabilityVerdict;
    client?: PluginContext["client"];
    activeAgent?: string;
    persistCompanion?: () => void;
    replaySnapshot?: Pick<
        PostprocessReplaySnapshot,
        "todoPermissionDenied" | "todoSyntheticAnchor"
    >;
}): Promise<number> {
    if (!args.fullFeatureMode || args.compactionOff) return 0;

    const persistedAnchor = args.replaySnapshot
        ? args.replaySnapshot.todoSyntheticAnchor
        : getPersistedTodoSyntheticAnchor(args.db, args.sessionId);
    const persistedPermissionDenied = args.replaySnapshot
        ? args.replaySnapshot.todoPermissionDenied
        : getPersistedTodoPermissionDenied(args.db, args.sessionId);
    let permissionDenied =
        cachedToolPermissionDenied(args.sessionId, "todowrite") ??
        persistedPermissionDenied ??
        false;
    const toolsMapUnavailable =
        args.todowriteAvailability.frozen && !args.todowriteAvailability.callable;

    if (args.isCacheBustingPass && args.client && !toolsMapUnavailable) {
        const tTodoPermission = performance.now();
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
        // The only OpenCode API round trip left inline on a busting pass: the
        // todowrite verdict decides whether the synthetic todo pair is served.
        logTransformTiming(args.sessionId, "pp.todoPermissionRead", tTodoPermission);
    }

    const source = args.messages.map((message) => ({
        id: message.info.id,
        thinking: message.parts.some(
            (part) =>
                isRecord(part) &&
                ["reasoning", "thinking", "redacted_thinking"].includes(String(part.type)),
        ),
    }));
    const apply = (requirePairing?: () => never): number => {
        const replay = (): number => {
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
        };
        const admit = (newAnchor?: string): boolean => {
            const coords: EditCoord[] = [];
            if (persistedAnchor) {
                coords.push({ kind: "message", id: persistedAnchor.messageId, block: "whole" });
            }
            for (const message of args.messages) {
                if (message.parts.some(isSyntheticTodoPart)) {
                    coords.push({ kind: "message", id: message.info.id, block: "whole" });
                }
            }
            if (newAnchor) {
                coords.push(
                    newAnchor === TODO_HEAD_ANCHOR_ID
                        ? { kind: "prefix" }
                        : { kind: "append", afterId: newAnchor },
                );
            }
            if (coords.every((coord) => !args.editAdmission || args.editAdmission.admit(coord))) {
                // Every admitted todo change is followed by a write.
                requirePairing?.();
                return true;
            }
            if (args.editAdmission?.frame.kind === "boundary") {
                sessionLog(
                    args.sessionId,
                    `edit admission: held lane=synthetic todo coords=${JSON.stringify(coords)} boundary=${args.editAdmission.frame.messageId ?? "<unresolved>"} held_edits=1`,
                );
            }
            return false;
        };
        const todowriteUnavailable = toolsMapUnavailable || permissionDenied;
        if (args.isCacheBustingPass && todowriteUnavailable) {
            if (!admit()) return replay();
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
            // Preview placement on copies before changing messages or the persisted todo anchor:
            // a rejected move must replay the previously served todo pair byte-for-byte.
            const preview = args.messages.map((message) => ({
                ...message,
                parts: [...message.parts],
            }));
            const persistedInjection =
                part !== null && persistedAnchor && persistedAnchor.callId === part.callID
                    ? injectPersistedTodoAnchor(
                          preview,
                          args.sessionId,
                          persistedAnchor.messageId,
                          part,
                      )
                    : null;
            if (part === null) {
                if (!admit()) return replay();
                removeSyntheticTodoParts(args.messages);
                if (persistedAnchor) clearPersistedTodoSyntheticAnchor(args.db, args.sessionId);
                return 0;
            }
            if (persistedAnchor && persistedInjection?.injected) {
                if (persistedAnchor.stateJson.length === 0) {
                    if (!admit(persistedAnchor.messageId)) return replay();
                    setPersistedTodoSyntheticAnchor(
                        args.db,
                        args.sessionId,
                        persistedAnchor.callId,
                        persistedAnchor.messageId,
                        args.sessionMeta.lastTodoState,
                    );
                }
                return injectPersistedTodoAnchor(
                    args.messages,
                    args.sessionId,
                    persistedAnchor.messageId,
                    part,
                ).prependedMessageCount;
            }

            const candidateId =
                injectToolPartIntoLatestAssistant(preview, part) ?? TODO_HEAD_ANCHOR_ID;
            if (!admit(candidateId)) return replay();
            removeSyntheticTodoParts(args.messages);
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
        return replay();
    };
    // Only a busting pass can change the pair; any other pass replays it and
    // writes nothing, so it needs neither a transaction nor a rerun snapshot.
    if (!args.persistCompanion || !args.isCacheBustingPass) return apply();
    // A busting pass that only replays writes nothing either; one that changes
    // the pair reruns paired with its strip.
    const replayed = editOutsideCompanionTransaction({ messages: args.messages, edit: apply });
    if (replayed) return replayed.result;
    return pairedThinkingEdit({
        db: args.db,
        messages: args.messages,
        edit: () => apply(),
        needsCompanion: () =>
            todoCompanionRequired(
                persistedAnchor,
                getPersistedTodoSyntheticAnchor(args.db, args.sessionId),
                source,
                TODO_HEAD_ANCHOR_ID,
            ),
        persistCompanion: args.persistCompanion,
    });
}

/** An armed binding-recovery flag consumed by one live pass. */
export interface ThinkingBindingRecoveryApplication {
    /** The flag value read, so the caller clears only that value. */
    flagTarget: string;
    /** Every assistant whose reasoning this pass removes from the provider wire. */
    messageIds: string[];
}

/**
 * Consume an armed binding-recovery flag by freezing every reasoning-bearing
 * assistant on the wire into the binding-mismatch strip set.
 *
 * Anthropic rejects signed thinking after a changed prefix. Completed turns
 * can be repaired together, but thinking in the current tool loop is immutable.
 * Callers supply every protected message of that turn, not just its last step,
 * and must defer the prefix edit when repairing it would require those blocks.
 *
 * The ids are persisted before any bytes change, so every later pass (defer
 * included) replays the same strips and a removed block never reappears.
 * Blocks produced after recovery are not in the set and are kept.
 *
 * Returns null only when persistence fails; the caller then serves the blocks
 * unchanged and leaves the flag armed.
 */
function freezeAllReasoningForBindingRecovery(args: {
    db: ContextDatabase;
    sessionId: string;
    messages: MessageLike[];
    flagTarget: string;
    protectedMessages?: ReadonlySet<MessageLike>;
    recoveredMessageIds: Set<string>;
}): ThinkingBindingRecoveryApplication | null {
    const protectedMessages = args.protectedMessages ?? new Set<MessageLike>();
    const messageIds = findReasoningBearingAssistantIds(
        args.messages.filter((message) => !protectedMessages.has(message)),
    );
    const newIds = messageIds.filter((id) => !args.recoveredMessageIds.has(id));
    if (
        newIds.length > 0 &&
        !addMergedReasoningStrippedIds(
            args.db,
            args.sessionId,
            newIds.map(thinkingBindingRecoveryFrozenId),
        )
    ) {
        return null;
    }
    for (const id of newIds) args.recoveredMessageIds.add(id);
    return { flagTarget: args.flagTarget, messageIds };
}

/** Thinking a busting pass removed on a prefix-bound model (Fable 5.1, Opus 5.5, Sonnet 5.5). */
export interface ProactiveThinkingStrip {
    /** Assistants whose reasoning this pass froze into the binding-mismatch strip set. */
    messageIds: string[];
}

/**
 * Freeze the reasoning of every assistant still sending it, on a busting pass
 * of a prefix-bound model (Fable 5.1, Opus 5.5, Sonnet 5.5).
 *
 * On those models a signed thinking block is valid only while every byte
 * before it is unchanged, and a busting pass is the pass that changes those
 * bytes: older accounts then drop the blocks silently, `drop_block` drops
 * them, and newer accounts reject the request with a 400. The pass therefore
 * removes unprotected blocks itself. The caller protects the entire current
 * assistant turn across tool-result exchanges and defers edits that would
 * invalidate its thinking. Limited OAuth probes accepting removal in an open
 * round do not establish permission for other Anthropic-family routes.
 *
 * The ids are persisted into the binding-mismatch set before the pass serves
 * any stripped byte, the same contract as the reactive recovery, so every
 * later pass (defer passes and last-known-good replays included) removes the
 * same blocks and a removed block never comes back. If an id is missing or the
 * write fails, callers must withhold the accompanying edit rather than serve
 * changed bytes with the old signatures.
 *
 * Callers must invoke this only on a pass that already busts the cache: it
 * never originates a byte change on a defer pass.
 */
export function freezeReasoningOnBustingPass(args: {
    db: ContextDatabase;
    sessionId: string;
    messages: MessageLike[];
    protectedMessages?: ReadonlySet<MessageLike>;
    alreadyFrozen: ReadonlySet<string>;
    /** Also record the strip for compaction-off, which replays only its own strips. */
    compactionOff?: boolean;
}): { strip: ProactiveThinkingStrip | null; persistenceFailed: boolean } {
    const protectedMessages = args.protectedMessages ?? new Set<MessageLike>();
    if (
        args.messages.some(
            (message) =>
                !protectedMessages.has(message) &&
                message.info.role === "assistant" &&
                !message.info.id &&
                message.parts.some(
                    (part) =>
                        isRecord(part) &&
                        (part.type === "reasoning" ||
                            part.type === "thinking" ||
                            part.type === "redacted_thinking"),
                ),
        )
    )
        return { strip: null, persistenceFailed: true };
    const messageIds = findReasoningBearingAssistantIds(
        args.messages.filter((message) => !protectedMessages.has(message)),
    ).filter((id) => !args.alreadyFrozen.has(id));
    if (messageIds.length === 0) return { strip: null, persistenceFailed: false };
    let persisted = false;
    try {
        persisted = addMergedReasoningStrippedIds(args.db, args.sessionId, [
            ...messageIds.map(thinkingBindingRecoveryFrozenId),
            ...(args.compactionOff ? messageIds.map(compactionOffThinkingFrozenId) : []),
        ]);
    } catch (error) {
        sessionLog(args.sessionId, "proactive thinking strip: persistence threw:", error);
    }
    if (!persisted) {
        sessionLog(
            args.sessionId,
            "proactive thinking strip: persistence failed; serving the thinking unchanged",
        );
        return { strip: null, persistenceFailed: true };
    }
    sessionLog(
        args.sessionId,
        `proactive thinking strip: busting pass froze reasoning of ${messageIds.length} assistant(s) [${messageIds.join(",")}]`,
    );
    return { strip: { messageIds }, persistenceFailed: false };
}

/**
 * What a frozen-replay release knows about the array the session last served:
 * the last-known-good snapshot's array (null when there is none), and whether
 * the previous pass captured exactly the array it served into that snapshot.
 */
export interface FrozenReleaseLastServed {
    messages: readonly unknown[] | null;
    proven: boolean;
}

/**
 * Where the proactive thinking strip may start on this pass, or null when it
 * may not run.
 *
 * A module bust permits the whole array. A pass that only releases a frozen
 * replay permits the array from its first changed message. When the snapshot is
 * provably what the previous pass served, no change means nothing is stripped.
 *
 * When it is not (the previous pass served a last-known-good replay after a
 * module error or park, which appends a raw tail the snapshot does not hold,
 * or the capture was lost), the snapshot vouches only for its own length: the
 * strip starts at the first change inside it or at its end, and with no
 * snapshot at all it starts at 0. Over-stripping costs a bust, while keeping a
 * thinking block behind changed bytes costs a 400 on newer accounts and a
 * silently dropped block on older ones, so the unknown side strips.
 */
function proactiveStripStartIndex(args: {
    messages: MessageLike[];
    resolvedProviderID?: string;
    cacheBustingPass?: boolean;
    frozenReleaseLastServed?: FrozenReleaseLastServed;
}): number | null {
    if (args.cacheBustingPass === true) return 0;
    const lastServed = args.frozenReleaseLastServed;
    if (!lastServed) return null;
    if (!lastServed.messages) return 0;
    const divergence = firstServedDivergenceIndex(args.messages, lastServed.messages, {
        providerID: args.resolvedProviderID,
    });
    if (lastServed.proven) return divergence;
    return divergence ?? lastServed.messages.length;
}

/**
 * True when the array about to be served still carries a thinking part that
 * may be signed (its signature is not inspected). A part counts by the same route rule that finds an open signed turn
 * (`isAnthropicThinkingPart`): on an Anthropic-family route (Anthropic,
 * Bedrock, Vertex, Copilot) every thinking part counts, whichever metadata key
 * holds its signature. Parts that never reach the provider do not count: an
 * ignored part, or an empty one that carries no redacted payload. On a
 * prefix-bound model such a block is bound to every byte in front of it, the
 * system prompt included, so this is the fact that decides whether the system
 * date may move. It reads the outcome of every strip the pass made instead of
 * predicting it, so it also covers blocks of a turn whose opening user message
 * was trimmed away.
 */
export function servesThinkingBlock(
    messages: readonly MessageLike[],
    providerID: string | undefined,
    modelID: string | undefined,
): boolean {
    const familyRoute = isAnthropicFamilyRoute(providerID, modelID);
    for (const message of messages) {
        if (message.info.role !== "assistant") continue;
        for (const part of message.parts) {
            if (!isAnthropicThinkingPart(part, familyRoute) || part.ignored === true) continue;
            if (part.type === "redacted_thinking") return true;
            if (typeof part.text === "string" && part.text !== "") return true;
            const records = isRecord(part.metadata) ? Object.values(part.metadata) : [];
            if (records.some((record) => isRecord(record) && record.redactedData !== undefined))
                return true;
        }
    }
    return false;
}

/**
 * True for a part OpenCode's Anthropic adapter removes before the request is
 * sent: an empty text or reasoning part (see `modelAcceptsEmptyContent`). The
 * host's own empty sentinels rely on the same filter.
 */
function isPartDroppedBeforeWire(part: unknown, providerID: string | undefined): boolean {
    if (!modelAcceptsEmptyContent(providerID) || !isRecord(part)) return false;
    return (part.type === "text" || part.type === "reasoning") && part.text === "";
}

/**
 * The fields of a message that decide its provider bytes, in a form that
 * ignores object key order.
 *
 * Besides the parts, this keeps the id and role, and the assistant fields
 * OpenCode reads when it builds the request: `error` (it skips an assistant
 * that errored for any reason other than an abort) and `providerID`/`modelID`
 * (it drops the reasoning metadata of an assistant produced by another model).
 * Parts the adapter drops before the wire are left out, so adding or removing
 * one is not a change.
 */
function servedMessageKey(message: unknown, providerID: string | undefined): string {
    const record = isRecord(message) ? message : {};
    const info = isRecord(record.info) ? record.info : {};
    // Fields of a part the provider never receives (tool metadata such as LSP
    // diagnostics) are left out as well; see provider-visible-parts.ts.
    const parts = Array.isArray(record.parts)
        ? record.parts
              .filter((part) => !isPartDroppedBeforeWire(part, providerID))
              .map(providerVisiblePart)
        : (record.parts ?? null);
    // The JSON round trip drops undefined fields and shared references, so a live
    // object and its JSON snapshot compare equal when they would serialize equal.
    const plain: unknown = JSON.parse(
        JSON.stringify({
            id: info.id ?? null,
            role: info.role ?? null,
            error: info.error ?? null,
            providerID: info.providerID ?? null,
            modelID: info.modelID ?? null,
            parts,
        }),
    );
    return stableStringify(plain);
}

/**
 * Index of the first message whose provider-visible fields differ from the
 * array the session last served, or null when every message both arrays hold is
 * equal. Messages past the end of the served array are not compared; the caller
 * decides what they mean. `providerID` selects the parts that never reach the
 * wire.
 */
export function firstServedDivergenceIndex(
    messages: readonly unknown[],
    lastServed: readonly unknown[],
    options: { providerID?: string } = {},
): number | null {
    const shared = Math.min(messages.length, lastServed.length);
    for (let index = 0; index < shared; index += 1) {
        if (
            servedMessageKey(messages[index], options.providerID) !==
            servedMessageKey(lastServed[index], options.providerID)
        ) {
            return index;
        }
    }
    return null;
}

/**
 * A provider-visible key for one message as a replay would serve it: the
 * session's persisted binding-mismatch strips are applied to a copy first, so a
 * message whose stored thinking was stripped compares equal to its unstripped
 * live form. The input is never mutated. Equal keys mean equal served bytes
 * (see `servedMessageKey`).
 */
export function rustModeServedKeyAfterPersistedStrips(args: {
    db: ContextDatabase;
    sessionId: string;
    resolvedProviderID?: string;
}): (message: unknown) => string {
    const recoveryMessageIds = new Set<string>();
    for (const id of getMergedReasoningStrippedIds(args.db, args.sessionId)) {
        if (!id.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX)) continue;
        const messageId = id.slice(THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length);
        if (messageId.length > 0) recoveryMessageIds.add(messageId);
    }
    return (message) => {
        const id = isRecord(message) && isRecord(message.info) ? message.info.id : undefined;
        if (typeof id !== "string" || !recoveryMessageIds.has(id)) {
            return servedMessageKey(message, args.resolvedProviderID);
        }
        const copy = [structuredClone(message) as MessageLike];
        stripReasoningFromAssistantIds(copy, args.resolvedProviderID, recoveryMessageIds);
        return servedMessageKey(copy[0], args.resolvedProviderID);
    };
}

/** Reapply durable binding-mismatch strips when a Rust LKG snapshot is replayed. */
export function replayRustModeBindingMismatchStrips(args: {
    protectedThinkingMessages?: ReadonlySet<MessageLike>;
    db: ContextDatabase;
    sessionId: string;
    messages: MessageLike[];
    resolvedProviderID?: string;
}): void {
    const recoveryMessageIds = new Set<string>();
    for (const id of getMergedReasoningStrippedIds(args.db, args.sessionId)) {
        if (!id.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX)) continue;
        const messageId = id.slice(THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length);
        if (messageId.length > 0) recoveryMessageIds.add(messageId);
    }
    stripReasoningFromAssistantIds(
        args.messages,
        args.resolvedProviderID,
        recoveryMessageIds,
        args.protectedThinkingMessages,
    );
}

/**
 * Rebuild host-owned canonical representation after native Rust serving.
 * The persisted compaction summary is restored with the same canonicalizer as the
 * TypeScript lane, then note and recall anchors are replayed onto the native result.
 */
export interface RustMaterializedCompactionBoundary {
    /** Durable module row returned by the same transform response as this boundary. */
    rowVersion: number;
    /** Last raw block ordinal included in the module's materialized baseline. */
    ordinal: number;
    /** OpenCode message id owning the last covered flat block. */
    endMessageId: string;
}

/** Logged when another process holds the write lock past busy_timeout. */
export const RUST_MARKER_LOCK_SKIP_LOG =
    "rust compaction-marker: pending target write skipped on lock contention; next cache-busting pass retries";

/**
 * SQLITE_BUSY, SQLITE_LOCKED and their extended codes such as SQLITE_BUSY_SNAPSHOT.
 * bun:sqlite reports the name in `code`; node:sqlite reports `code:
 * "ERR_SQLITE_ERROR"` with the numeric result in `errcode`, whose low byte is the
 * primary code (5 busy, 6 locked).
 */
function isSqliteLockContentionError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const { code, errcode } = error as { code?: unknown; errcode?: unknown };
    if (typeof code === "string" && /^SQLITE_(BUSY|LOCKED)(_[A-Z_]+)?$/.test(code)) return true;
    if (typeof errcode === "number") {
        const primary = errcode & 0xff;
        return primary === 5 || primary === 6;
    }
    return false;
}

/**
 * Use the compaction target from this Rust response, not a later status read
 * that may describe different history. Save the target in session metadata and
 * clear it only if no newer request replaced it. Targets move only forward.
 * SOFT+ leaves the target and retry counters unchanged, including when the
 * module commits metadata without rebuilding messages. Retry on a HARD/SOFT
 * cache bust, never a timer or frozen last-known-good request (LKG) replay.
 */
export function applyRustModeDeferredCompactionMarker(args: {
    /**
     * True for a Rust HARD/SOFT message rebuild; scheduler execute or a metadata
     * write alone does not permit changing the compaction marker.
     */
    cacheBustingPass: boolean;
    /** False keeps the pending target without attempting an unadmitted host cut. */
    admissionProven?: boolean;
    /** Block replay of the previous request before the host may omit earlier history. */
    beforeApply?: () => void;
    /** Report whether the marker moved, or may have moved, before later state writes can fail. */
    afterApply?: (outcome: MarkerUpdateOutcome) => void;
    db: ContextDatabase;
    sessionId: string;
    boundary?: RustMaterializedCompactionBoundary;
    /** Coverage rendered by this response, even when it did not commit a fresh target. */
    consumedBoundary?: RustMaterializedCompactionBoundary;
    sessionDirectory?: string;
    /**
     * How this host applies the boundary. The default writes a compaction row into
     * OpenCode 1's own store; a host with no such row supplies a function that records
     * the boundary instead.
     */
    applyDeferred?: CompactionMarkerStrategy["applyDeferred"];
}): void {
    if (!args.cacheBustingPass) return;
    const { boundary } = args;
    if (boundary) {
        if (
            !Number.isSafeInteger(boundary.rowVersion) ||
            boundary.rowVersion <= 0 ||
            !Number.isSafeInteger(boundary.ordinal) ||
            boundary.ordinal < 0 ||
            boundary.endMessageId.length === 0
        ) {
            sessionLog(
                args.sessionId,
                "rust compaction-marker: invalid materialized boundary ignored",
            );
            return;
        }

        let target: PendingCompactionMarker = {
            ordinal: boundary.ordinal,
            endMessageId: boundary.endMessageId,
            publishedAt: Date.now(),
        };
        // IMMEDIATE takes the write lock before the first read, so busy_timeout covers
        // contention with other processes. A deferred transaction that reads first and
        // then writes fails at once with SQLITE_BUSY (or SQLITE_BUSY_SNAPSHOT) because
        // SQLite never runs the busy handler for a read-to-write upgrade.
        try {
            args.db
                .transaction(() => {
                    const persisted = getPersistedCompactionMarkerState(args.db, args.sessionId);
                    const pending = getPendingCompactionMarkerState(args.db, args.sessionId);
                    if (pending && pending.ordinal > target.ordinal) {
                        target = pending;
                        return;
                    }
                    if (
                        pending &&
                        pending.ordinal === target.ordinal &&
                        pending.endMessageId === target.endMessageId
                    ) {
                        target = pending;
                        return;
                    }
                    if (
                        persisted &&
                        persisted.boundaryOrdinal >= target.ordinal &&
                        pending === null
                    )
                        return;
                    setPendingCompactionMarkerState(args.db, args.sessionId, target);
                })
                .immediate();
        } catch (error) {
            // This marker bookkeeping runs after the module already produced a valid
            // transform, and the next cache-busting pass records the boundary again. A lock
            // held past busy_timeout therefore skips this pass's recording and drain
            // instead of failing the pass into LKG or raw fallback.
            if (!isSqliteLockContentionError(error)) throw error;
            sessionLog(
                args.sessionId,
                `${RUST_MARKER_LOCK_SKIP_LOG}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return;
        }
    }

    const pending = getPendingCompactionMarkerState(args.db, args.sessionId);
    if (!pending) return;
    // A later publisher may have won while this response was rendering. Keep its
    // complete retry state untouched until a response actually consumes that work.
    // Skip the cut entirely rather than replacing the newer pending blob with an
    // older response target. Equal ordinals also require the exact end anchor.
    const consumed = args.consumedBoundary ?? boundary;
    if (
        !consumed ||
        pending.ordinal > consumed.ordinal ||
        (pending.ordinal === consumed.ordinal && pending.endMessageId !== consumed.endMessageId)
    ) {
        sessionLog(
            args.sessionId,
            "rust compaction-marker drain: pending target not covered by served response; retaining retry state",
        );
        return;
    }
    // Record the latest target above even when this pass cannot prove the cut safe.
    // Deferral does not spend retry attempts or arm the post-cut replay fence.
    if (args.admissionProven === false) return;
    const trustedBoundary =
        boundary &&
        pending.ordinal === boundary.ordinal &&
        pending.endMessageId === boundary.endMessageId
            ? {
                  rowVersion: boundary.rowVersion,
                  ordinal: boundary.ordinal,
                  endMessageId: boundary.endMessageId,
              }
            : undefined;
    // Summary discovery runs on a worker and the pass never waits for it. While it
    // runs, the checks that need no discovery still retire a stale or already-
    // covered target; the cut itself waits, with no fence armed and no retry
    // spent. A host store that cannot be opened starts no discovery; the drain
    // below reports that as a retryable failure, as before.
    if (
        (args.applyDeferred ?? applyDeferredCompactionMarker) === applyDeferredCompactionMarker &&
        startCompactionMarkerCandidatePreparation(args.sessionId) === "preparing"
    ) {
        const settled = applyDeferredCompactionMarker(
            args.db,
            args.sessionId,
            pending,
            args.sessionDirectory,
            trustedBoundary,
            { validateOnly: true },
        );
        if (settled.kind === "stale-skip" || settled.kind === "already-current") {
            if (!clearPendingCompactionMarkerStateIf(args.db, args.sessionId, pending))
                sessionLog(
                    args.sessionId,
                    `rust compaction-marker drain: CAS lost${boundary ? ` after module row ${boundary.rowVersion}` : ""}; newer pending target retained`,
                );
            return;
        }
        sessionLog(
            args.sessionId,
            "rust compaction-marker drain: candidate preparation deferred; pending target retained",
        );
        return;
    }
    args.beforeApply?.();
    const outcome = (args.applyDeferred ?? applyDeferredCompactionMarker)(
        args.db,
        args.sessionId,
        pending,
        args.sessionDirectory,
        trustedBoundary,
    );
    args.afterApply?.(outcome);
    switch (outcome.kind) {
        case "deferred":
            sessionLog(
                args.sessionId,
                "rust compaction-marker drain: candidate preparation deferred; pending target retained",
            );
            break;
        case "applied":
        case "already-current":
        case "stale-skip":
            if (!clearPendingCompactionMarkerStateIf(args.db, args.sessionId, pending)) {
                sessionLog(
                    args.sessionId,
                    `rust compaction-marker drain: CAS lost${boundary ? ` after module row ${boundary.rowVersion}` : ""}; newer pending target retained`,
                );
            }
            break;
        case "retryable-failure": {
            const now = Date.now();
            const failedPending: PendingCompactionMarker = {
                ...pending,
                injectAttempts: (pending.injectAttempts ?? 0) + 1,
                lastInjectError: outcome.error.message,
                firstInjectFailedAt: pending.firstInjectFailedAt ?? now,
            };
            replacePendingCompactionMarkerStateIf(args.db, args.sessionId, pending, failedPending);
            sessionLog(
                args.sessionId,
                `rust compaction-marker drain: retryable failure${boundary ? ` after module row ${boundary.rowVersion}` : ""}; pending target retained`,
                outcome.error,
            );
            break;
        }
    }
}

/**
 * Forget a recorded module boundary whose coordinates no longer describe the host.
 *
 * A host that renumbers the conversation invalidates the boundary's ordinal along
 * with every other saved position, and the module is about to be deleted and
 * re-seeded, so the record has nothing left to point at. Clearing it lets the
 * next serve send the full history and accept whatever boundary the re-seeded
 * module publishes.
 *
 * Only a recorded boundary is cleared. A boundary backed by a real OpenCode 1
 * compaction row is left alone: that row still exists in the host's own store,
 * and dropping the local state would orphan it. Recorded boundaries are
 * recognisable by their empty summary message id, which is what a host that
 * writes no marker rows stores.
 *
 * Returns true when a record was cleared.
 */
export function clearRustModeBoundaryRecord(db: ContextDatabase, sessionId: string): boolean {
    setPendingCompactionMarkerState(db, sessionId, null);
    const state = getPersistedCompactionMarkerState(db, sessionId);
    if (!state || state.summaryMessageId.length > 0) return false;
    setPersistedCompactionMarkerState(db, sessionId, null);
    return true;
}

/**
 * Rust-mode host thinking strips for prefix-bound models: replay the persisted
 * binding-mismatch set, apply an armed reactive recovery, and on a busting pass
 * freeze and remove every remaining signed block past the pass's first change.
 * A module signed-thinking reset (bytes before the active turn's kept thinking
 * changed) removes every signed block, the active turn's included, and skips the
 * reactive restore of the turn's originals, which are bound to the old bytes.
 */
function applyRustModeThinkingStrips(
    args: Parameters<typeof runRustModePostprocess>[0],
    hostEditBeforeNewestThinking: boolean,
): {
    thinkingBindingRecovery: ThinkingBindingRecoveryApplication | null;
    proactiveThinkingStrip: ProactiveThinkingStrip | null;
} {
    const recoveryMessageIds = new Set<string>();
    let thinkingBindingRecovery: ThinkingBindingRecoveryApplication | null = null;
    let proactiveThinkingStrip: ProactiveThinkingStrip | null = null;
    // A module signed-thinking reset invalidates every signed block served before this
    // pass, the active turn's included, so no thinking is protected from it.
    const signedThinkingReset =
        args.cacheBustingPass === true && args.moduleSignedThinkingReset === true;
    const stripProtection = signedThinkingReset ? undefined : args.protectedThinkingMessages;
    {
        try {
            for (const id of getMergedReasoningStrippedIds(args.db, args.sessionId)) {
                if (!id.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX)) continue;
                const messageId = id.slice(THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length);
                if (messageId.length > 0) recoveryMessageIds.add(messageId);
            }

            const flagTarget =
                !args.activeThinkingTurn && args.thinkingBindingRecoveryEnabledForModel
                    ? getThinkingBindingRecoveryTarget(args.db, args.sessionId)
                    : null;
            if (flagTarget && !isLatestThinkingRecoveryTarget(flagTarget)) {
                thinkingBindingRecovery = freezeAllReasoningForBindingRecovery({
                    db: args.db,
                    sessionId: args.sessionId,
                    messages: args.messages,
                    flagTarget,
                    protectedMessages: args.protectedThinkingMessages,
                    recoveredMessageIds: recoveryMessageIds,
                });
                if (!thinkingBindingRecovery) {
                    sessionLog(
                        args.sessionId,
                        "rust thinking binding recovery: persistence failed; leaving the bound blocks intact",
                    );
                }
            }
        } catch (error) {
            sessionLog(args.sessionId, "rust thinking binding recovery failed:", error);
        }
        // Replay the persisted strips first, so the comparison below sees the
        // blocks earlier passes already removed exactly as those passes served them.
        stripReasoningFromAssistantIds(
            args.messages,
            args.resolvedProviderID,
            recoveryMessageIds,
            stripProtection,
        );
        // On a busting pass of a prefix-bound model, every remaining assistant
        // with reasoning past the pass's first changed byte is persisted into the
        // binding-mismatch set before any of it is removed; later passes replay
        // the same set to produce the same output.
        // A module bust whose only edit is the oldest-prefix reasoning removal
        // leaves every newer block valid ("Remove `thinking` blocks from the
        // start of the history" is a valid change in Anthropic's table), so it
        // is no permission to strip them, unless this host edited earlier
        // bytes itself on the same pass.
        const moduleBustStrips =
            signedThinkingReset ||
            (!args.activeThinkingTurn &&
                args.cacheBustingPass === true &&
                (args.moduleReasoningTrimOnly !== true || hostEditBeforeNewestThinking));
        const stripFrom =
            args.thinkingBindingRecoveryEnabledForModel === true || signedThinkingReset
                ? proactiveStripStartIndex({ ...args, cacheBustingPass: moduleBustStrips })
                : null;
        if (stripFrom !== null) {
            const stripped = args.messages.slice(stripFrom);
            const outcome = freezeReasoningOnBustingPass({
                db: args.db,
                sessionId: args.sessionId,
                messages: stripped,
                protectedMessages: stripProtection,
                alreadyFrozen: recoveryMessageIds,
            });
            if (outcome.strip) {
                proactiveThinkingStrip = outcome.strip;
                for (const id of outcome.strip.messageIds) recoveryMessageIds.add(id);
            }
            // The module already persisted the reset, so its removal is served even when
            // this host's own record of it could not be written.
            const removed = signedThinkingReset
                ? new Set(findReasoningBearingAssistantIds(stripped))
                : new Set(outcome.strip?.messageIds ?? []);
            if (removed.size > 0) {
                stripReasoningFromAssistantIds(
                    args.messages,
                    args.resolvedProviderID,
                    removed,
                    stripProtection,
                );
            }
        }
    }
    // The turn's originals are bound to the bytes the reset changed: restoring them would
    // put back exactly the thinking the reset removed.
    if (!signedThinkingReset) args.restoreLatestTurnOriginals?.();
    return { thinkingBindingRecovery, proactiveThinkingStrip };
}

export function runRustModePostprocess(args: {
    db: ContextDatabase;
    sessionId: string;
    messages: MessageLike[];
    projectPath?: string;
    sessionDirectory?: string;
    materializedBoundary?: RustMaterializedCompactionBoundary;
    consumedBoundary?: RustMaterializedCompactionBoundary;
    markerAdmissionProven?: boolean;
    beforeMarkerApply?: () => void;
    afterMarkerApply?: (outcome: MarkerUpdateOutcome) => void;
    compactionMarkerStrategy?: CompactionMarkerStrategy;
    fullFeatureMode: boolean;
    compactionOff?: boolean;
    resolvedProviderID?: string;
    thinkingBindingRecoveryEnabledForModel?: boolean;
    restoreLatestTurnOriginals?: () => void;
    activeThinkingTurn?: boolean;
    protectedThinkingMessages?: ReadonlySet<MessageLike>;
    /**
     * The module's response-local prefix_bust_permitted is exactly true.
     * Neither the decision label nor local frozen-release pricing grants this
     * authority. A permitted pass may freeze thinking invalidated by its edit.
     */
    cacheBustingPass?: boolean;
    /** Whether the response carried an actual boolean prefix-bust capability. */
    prefixPermissionSupported?: boolean;
    /**
     * The module reports that this busting pass edited nothing before newer
     * signed thinking except removing reasoning from a contiguous oldest prefix
     * (`reasoning_trim_only` in its response). Such a pass keeps the newer
     * blocks on a prefix-bound model.
     */
    moduleReasoningTrimOnly?: boolean;
    /**
     * The module removed every signed thinking block it serves on this busting pass
     * (`signed_thinking_reset` in its response): bytes before the active turn's kept
     * thinking changed, so no signed block from before this pass is valid any more.
     * The host strips and freezes all of them, the active turn's included, and skips
     * the reactive restore of the turn's originals.
     */
    moduleSignedThinkingReset?: boolean;
    /**
     * Set when the module deferred but this pass stops serving a frozen
     * last-known-good replay. The frozen replay served the messages that arrived
     * during the freeze as raw input, so the module's output changes bytes only
     * from the first of those messages onward, not from the start. Only thinking
     * at or after the first message that differs from the last-served array may
     * be frozen: a block before that point sits behind unchanged bytes, so it
     * stays valid and stripping it would rewrite cached content no other change
     * touched. See `proactiveStripStartIndex` for a snapshot that is not provably
     * the last-served array.
     */
    frozenReleaseLastServed?: FrozenReleaseLastServed;
    trailingBlankSourceDecisions?: TrailingBlankSourceDecisions;
    trailingBlankNewestAssistantId?: string;
    tagger: Tagger;
    ctxReduceAvailability: CtxReduceAvailabilityVerdict;
}): {
    thinkingBindingRecovery: ThinkingBindingRecoveryApplication | null;
    proactiveThinkingStrip: ProactiveThinkingStrip | null;
    markerAt: string | null;
} {
    if (args.compactionOff) {
        return { thinkingBindingRecovery: null, proactiveThinkingStrip: null, markerAt: null };
    }
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
        return { thinkingBindingRecovery: null, proactiveThinkingStrip: null, markerAt: null };
    }
    // Subagents get only the thinking strips. On prefix-bound models no age lane
    // removes their reasoning, so the busting-pass strip is their only reclaim,
    // as in TS mode and Pi; the rest of this host phase is primary-only.
    if (!args.fullFeatureMode) {
        return { ...applyRustModeThinkingStrips(args, false), markerAt: null };
    }
    // The served marker is a summary in the history: a change to it on this
    // pass edits bytes before newer thinking.
    const servedMarkerRecord = (): string =>
        JSON.stringify([
            getPersistedCompactionMarkerState(args.db, args.sessionId),
            getDeferredClearedCompactionMarkerState(args.db, args.sessionId),
        ]);
    const servedMarkerBefore = servedMarkerRecord();
    // Retry marker updates left by an upgrade or locked store only on a HARD/SOFT
    // cache bust. Moving one on SOFT+ would make the next host input omit earlier
    // messages while m[0]/m[1] still replay unchanged.
    if (args.cacheBustingPass) {
        applyRustModeDeferredCompactionMarker({
            cacheBustingPass: true,
            admissionProven: args.markerAdmissionProven,
            beforeApply: args.beforeMarkerApply,
            afterApply: args.afterMarkerApply,
            ...(args.compactionMarkerStrategy
                ? { applyDeferred: args.compactionMarkerStrategy.applyDeferred }
                : {}),
            db: args.db,
            sessionId: args.sessionId,
            boundary: args.materializedBoundary,
            consumedBoundary: args.consumedBoundary,
            sessionDirectory: args.sessionDirectory,
        });
    }
    (args.compactionMarkerStrategy?.reconcile ?? reconcileMarkerRepresentation)(
        args.messages,
        getPersistedCompactionMarkerState(args.db, args.sessionId),
        {
            db: args.db,
            sessionId: args.sessionId,
            tagger: args.tagger,
            ctxReduceAvailability: args.ctxReduceAvailability,
            isCacheBustingPass: args.cacheBustingPass === true,
        },
    );
    for (const anchor of getNoteNudgeAnchors(args.db, args.sessionId)) {
        appendReminderToUserMessageById(args.messages, anchor.messageId, anchor.text);
    }
    const trailingBlankDecisions = new Map<string, TrailingBlankDecision>();
    // Only visible assistants can be stripped or become candidates. The persisted
    // replay document also contains archived turns, often far larger than this tail.
    const visibleAssistantIds = args.messages
        .filter((message) => message.info.role === "assistant")
        .map((message) => message.info.id)
        .filter((id): id is string => typeof id === "string");
    if (modelAcceptsEmptyContent(args.resolvedProviderID)) {
        try {
            for (const [id, decision] of getTrailingBlankDecisions(
                args.db,
                args.sessionId,
                visibleAssistantIds,
            )) {
                trailingBlankDecisions.set(id, decision);
            }
            const candidates = findTrailingBlankDecisionCandidates(
                args.messages,
                trailingBlankDecisions,
                { sourceDecisions: args.trailingBlankSourceDecisions },
            ).filter(([id]) => id === args.trailingBlankNewestAssistantId);
            // Deciding about the newest assistant on its first serve is a
            // first-serve decision, not a prefix first-mutation. Absorbing strip
            // never rewrites already-served bytes; postponing this capture until
            // a prefix bust lets late provider blanks change historical replay.
            // Unsupported producers still hold all new host decisions.
            if (
                (args.prefixPermissionSupported ?? args.cacheBustingPass === true) &&
                candidates.length > 0
            ) {
                const persisted = addTrailingBlankDecisions(args.db, args.sessionId, candidates, {
                    overwriteMessageId: args.trailingBlankNewestAssistantId,
                });
                if (persisted) {
                    const committed = getTrailingBlankDecisions(
                        args.db,
                        args.sessionId,
                        visibleAssistantIds,
                    );
                    for (const [id] of candidates) {
                        const decision = committed.get(id);
                        if (decision) trailingBlankDecisions.set(id, decision);
                    }
                } else {
                    sessionLog(
                        args.sessionId,
                        "rust trailing blank decision: persistence failed; serving only frozen decisions",
                    );
                }
            }
        } catch (error) {
            sessionLog(args.sessionId, "rust trailing blank decision failed:", error);
        }
    }
    // The Rust module's core.frozen_units store owns keep shape and canonical blank counts.
    // The host may only enforce the absorbing strip direction: replaying keep here could
    // manufacture a suffix the module intentionally omitted or normalize bytes it already chose.
    const absorbingStripDecisions = new Map(
        [...trailingBlankDecisions].filter(([, decision]) => decision === "strip"),
    );
    applyFrozenTrailingBlankDecisions(args.messages, absorbingStripDecisions);

    let noteNudgeAppended = false;
    const currentUserMessageId = findNoteNudgeUserMessageId(args.messages);
    const eligibility = observeNoteNudgeServe({
        db: args.db,
        sessionId: args.sessionId,
        userMessageIds: args.messages
            .filter((m) => m.info.role === "user" && typeof m.info.id === "string")
            .map((m) => m.info.id as string),
        anchorMessageId: currentUserMessageId,
        isLiveTail: args.messages.at(-1)?.info.id === currentUserMessageId,
        // Rust's prefix_bust_permitted flag authorizes edits but does not prove
        // any bytes before this user message actually changed. Wait for an
        // unserved user message at the tail rather than originate a rewrite.
        prefixRewriteCoversAnchor: false,
    });
    const noteReadStillVisible = hasVisibleNoteReadCall(args.messages);
    const deferredNoteText = peekNoteNudgeText(
        args.db,
        args.sessionId,
        currentUserMessageId,
        args.projectPath,
        noteReadStillVisible,
        eligibility,
    );
    if (deferredNoteText) {
        const instruction = `\n\n<instruction name="deferred_notes">${deferredNoteText}</instruction>`;
        const anchoredMessageId = currentUserMessageId;
        const outcome = markNoteNudgeDelivered(
            args.db,
            args.sessionId,
            instruction,
            anchoredMessageId,
        );
        if (anchoredMessageId && outcome.ok) {
            appendReminderToUserMessageById(args.messages, anchoredMessageId, instruction);
            noteNudgeAppended = true;
        } else if (anchoredMessageId && !outcome.ok) {
            sessionLog(
                args.sessionId,
                `rust note-nudge delivery skipped wire append: ${outcome.kind}`,
            );
        }
    }

    // Render a newly delivered note before the saved auto-search hint so the
    // next request's note-then-hint replay preserves these exact message bytes.
    for (const decision of getAutoSearchHintDecisions(args.db, args.sessionId)) {
        if (
            decision.decision === "hint" &&
            getUnpublishedAutoSearchNoHint(args.sessionId, decision.messageId) === undefined
        ) {
            appendReminderToUserMessageById(args.messages, decision.messageId, decision.text);
        }
    }

    // A changed compaction marker or a freshly appended note nudge edits bytes
    // before newer thinking on this pass, whatever the module reported.
    const { thinkingBindingRecovery, proactiveThinkingStrip } = applyRustModeThinkingStrips(
        args,
        noteNudgeAppended || servedMarkerRecord() !== servedMarkerBefore,
    );
    const marker = getPersistedCompactionMarkerState(args.db, args.sessionId);
    return {
        thinkingBindingRecovery,
        proactiveThinkingStrip,
        markerAt: marker?.targetEndMessageId ?? marker?.boundaryMessageId ?? null,
    };
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
        isCacheBustingPass?: boolean;
    },
): boolean {
    if (persistedMarkerState === null) {
        if (options.isCacheBustingPass === true) {
            retireDeferredClearedCompactionMarkerState(options.db, options.sessionId);
        } else {
            persistedMarkerState = getDeferredClearedCompactionMarkerState(
                options.db,
                options.sessionId,
            );
        }
    }
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
        options.db
            .transaction(() => {
                for (const messageId of staleSummaryIds) {
                    dropMarkerSummaryTag(options.db, options.sessionId, messageId);
                }
            })
            .immediate();
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

function deliveredPrefixWasTrimmedThroughPendingBoundary(
    deliveredPrefix: InjectM0M1Result | undefined,
    sourceOrder: PrefixTrimSourceOrder | undefined,
    pending: PendingCompactionMarker,
): boolean {
    if (
        deliveredPrefix?.prefixTrimStatus !== "applied" ||
        typeof deliveredPrefix.preparedTrimBoundaryId !== "string" ||
        deliveredPrefix.preparedTrimBoundaryId.length === 0
    ) {
        return false;
    }
    if (deliveredPrefix.preparedTrimBoundaryId === pending.endMessageId) return true;
    if (!sourceOrder || sourceOrder.invalidReason) return false;
    const deliveredPosition = sourceOrder.messageIds.indexOf(
        deliveredPrefix.preparedTrimBoundaryId,
    );
    const pendingPosition = sourceOrder.messageIds.indexOf(pending.endMessageId);
    return deliveredPosition >= 0 && pendingPosition >= 0 && deliveredPosition >= pendingPosition;
}

function sourceAlreadyReflectsCoveringMarker(
    sessionId: string,
    sourceOrder: PrefixTrimSourceOrder | undefined,
    marker: PersistedCompactionMarkerState | null,
    pending: PendingCompactionMarker,
): boolean {
    if (!sourceOrder || sourceOrder.invalidReason || !marker) return false;
    const higherMarkerTarget =
        marker.boundaryOrdinal > pending.ordinal && marker.targetEndMessageId
            ? compareOpenCodeMessagesByCanonicalOrder(
                  sessionId,
                  marker.targetEndMessageId,
                  pending.endMessageId,
              )
            : null;
    const markerCoversPending =
        higherMarkerTarget !== null && higherMarkerTarget > 0
            ? true
            : marker.boundaryOrdinal === pending.ordinal &&
              marker.targetEndMessageId === pending.endMessageId;
    if (!markerCoversPending) return false;
    return (
        sourceOrder.messageIds.includes(marker.summaryMessageId) &&
        !sourceOrder.messageIds.includes(pending.endMessageId)
    );
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

export interface CompactionMarkerStrategy {
    applyDeferred: typeof applyDeferredCompactionMarker;
    reconcile: typeof reconcileMarkerRepresentation;
}

export const defaultCompactionMarkerStrategy: CompactionMarkerStrategy = {
    applyDeferred: applyDeferredCompactionMarker,
    reconcile: reconcileMarkerRepresentation,
};

interface RunPostTransformPhaseArgs {
    opencode1?: boolean;
    opencode2?: boolean;
    releaseRecoveryPrefix?: () => void;
    /**
     * The request a frozen last-good replay serves, present only while this
     * pass starts from one. Read only on a pass that releases it, to tell
     * whether the history head this pass renders differs from the replay's.
     */
    frozenRecoveryRequest?: () => readonly unknown[] | null;
    /**
     * The saved last-good request, present only on this process's first pass
     * of the session when no frozen replay is in memory: after a restart it is
     * the only record of the request served before this pass.
     */
    restartedLastServedRequest?: () => readonly unknown[] | null;
    /** Add §N§ reduction handles to messages sent untagged during recovery, once a fold replaces the provider's cached prefix. */
    normalizeRecoveryTail?: () => void;
    compactionMarkerStrategy?: CompactionMarkerStrategy;
    sessionId: string;
    db: ContextDatabase;
    messages: MessageLike[];
    reclaimHostRows?: (
        sessionId: string,
        messages: MessageLike[],
        permitted: boolean,
        /** Covered host instruction rows this pass serves ahead of `messages`. */
        covered: MessageLike[],
    ) => HostRowReclaim;
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
    /**
     * True when `contextUsage` was raised by a local count of the request, not
     * by a provider measurement or an overflow latch (the first pass after a
     * restart or a model switch, or any priced pass of a session whose provider
     * reports no usage). Such a reading below 95% may not by itself grant the
     * force ride, lift the signed-thinking hold or run the tiered emergency
     * tool drop, and it leaves the execute pass's own bounded rebuild
     * available.
     */
    contextUsageFromEstimate?: boolean;
    /** Usable tokens available for soft scheduling thresholds and usage-ratio calculation. */
    usableWindow: number;
    schedulerDecision: "execute" | "defer";
    /** Use the defer reason resolved with the scheduler decision at the boundary; do not recompute it from this phase's inputs, which may no longer reflect that decision. */
    schedulerDeferReason?: "scheduler_defer" | null;
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
    /**
     * Replay the persisted m[0]/m[1] pair byte-identically instead of folding
     * or refreshing it, and leave every materialization request pending. Set
     * when the session's directory could not be resolved, so the pass only
     * knows a fallback directory that may belong to another project.
     */
    freezeM0M1?: boolean;
    activeThinkingPrefixHold?: boolean;
    directoryPrefixHold?: boolean;
    forceSignedRebuildForFit?: boolean;
    /**
     * The session's compaction mode changed (managed <-> compaction-off) and no
     * pass has completed in the new mode yet. The new mode serves the message
     * bytes differently (compaction-off writes no tags), so every signed
     * thinking block on the wire sits behind changed bytes.
     */
    compactionModeTransition?: boolean;
    /**
     * What changed in the request's tools since the session's last pass on this
     * prefix-bound model, or null. Signed thinking is bound to the tools, so
     * every block on the wire is invalid on this pass.
     */
    requestToolsChange?: RequestToolsChange | null;
    readLastServedMessages?: () => readonly unknown[] | null;
    structuralSentinelUpgradeFailed?: boolean;
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
    keepReasoningTokens?: number;
    /** Deprecated caller input, ignored. */
    clearReasoningAge?: number;
    /** Canonical token-window membership consumed by pending-operation application. */
    protectedTagIds: ReadonlySet<number>;
    onPendingDropEligibility?: (eligible: ReadonlySet<number>) => void;
    /** Canonical token-window membership in tag-number space. */
    protectedTagNumbers: ReadonlySet<number>;
    /** Canonical token-window cutoff in tag-number space. */
    protectedCutoff: number | null;
    /** Number of persisted tool rows in the canonical token window. */
    protectedCount: number;
    /**
     * Ceiling for the tiered emergency drop = contextLimit × executeThreshold%.
     * Undefined when the context limit isn't resolved (cold start) — the
     * emergency drop then skips (the 95% block stays the backstop).
     */
    emergencyCeilingTokens?: number;
    pendingCompartmentInjection: PreparedCompartmentInjection | null;
    /** Save host-order IDs before tag replay or tool pruning can remove the message that marks the prefix-trimming boundary. */
    prefixTrimSourceOrder?: PrefixTrimSourceOrder;
    /**
     * OpenCode 2 id-less instruction rows the history boundary covers, set aside
     * by the history trim (and by the OpenCode 2 restore after a host checkpoint)
     * until this phase decides whether the session serves them.
     */
    coveredHostInstructions?: MessageLike[];
    /**
     * Messages trimmed while this transform rebuilds history. OpenCode rebuilds
     * the next request from the boundary written later in this pass, so some rows
     * can be absent now and return next time. Keep their objects long enough to
     * persist empty sentinels for placeholder-only assistant messages before then.
     */
    hiddenMessagesAtCompactionSeam?: MessageLike[];
    /** All source rows removed by the in-memory trim; their fresh tags are never served. */
    trimmedMessagesAtCompactionBoundary?: MessageLike[];
    didMutateFromFlushedStatuses: boolean;
    watermark: number;
    forceMaterializationPercentage: number;
    hasRecentReduceCall: boolean;
    projectPath?: string;
    /** Read-only scope sampled after mutation checks; it cannot authorize rebuilding the cached leading context messages. */
    readProjectScope?: () => { projectIdentity: string | undefined; memoryUnavailable: boolean };
    sessionDirectory?: string;
    /** Experimental auto-search: when enabled, runs ctx_search on the latest
     *  user prompt and appends a compact fragment hint. */
    autoSearch?: {
        enabled: boolean;
        scoreThreshold: number;
        minPromptChars: number;
        directory?: string;
        ensureProjectRegistered?: (directory: string, db: ContextDatabase) => Promise<void>;
        /** Caveman word rules for hint fragments, from the user-level `language` setting. */
        wordRules?: CavemanWordRules;
    };
    /**
     * Age-tier caveman compression (experimental). Caller forwards this only
     * for primary sessions because subagent context is curated by the parent.
     * Passed through to `applyHeuristicCleanup`.
     */
    cavemanTextCompression?: {
        enabled: boolean;
        minChars: number;
        /** From the user-level `language` setting; English word rules when absent. */
        wordRules?: CavemanWordRules;
    };
    /** Deprecated input retained for older callers; supersession runs only on cache-rebuilding passes. */
    smartDrops?: boolean;
    protectedTools?: Readonly<Record<string, number>>;
    /**
     * Provider resolved once by the main transform for this pass. Used for every
     * empty-sentinel gate and whole-message placeholder choice so postprocess
     * cannot diverge from the main transform on cold DB-recovered passes.
     */
    resolvedProviderID?: string;
    protectedThinkingMessages?: ReadonlySet<MessageLike>;
    restoreThinkingMessageIds?: ReadonlySet<string>;
    restoreLatestTurnOriginals?: () => void;
    activeThinkingTurn?: boolean;
    resolvedModelID?: string;
    signedThinkingHold?: "off" | "on";
    /**
     * True only when the live request uses a model whose signed thinking is
     * bound to its prefix (isPrefixBoundThinkingModel: Anthropic Fable 5.1 or
     * Opus 5.5). Gates both the reactive binding recovery and the proactive
     * strip of thinking that a busting pass invalidates.
     */
    thinkingBindingRecoveryEnabledForModel?: boolean;
    /**
     * An armed binding-recovery target this process already applied on an
     * earlier pass and could not clear. The pass does not apply it again: its
     * strips are saved, and applying it again would strip thinking produced
     * after it.
     */
    appliedBindingRecoveryTarget?: string;
    /** Raw harness observations captured before any Magic Context insertion or sentinelization. */
    trailingBlankSourceDecisions?: TrailingBlankSourceDecisions;
    temporalCandidates?: ReadonlyMap<string, string>;
    temporalReplayIds?: readonly string[];
    temporalObservedDecisions?: ReadonlyMap<string, string>;
    passOutcome?: PassOutcome;
    historyRefreshSessions?: Set<string>;
    m0M1?: {
        projectPath?: string;
        projectDirectory?: string;
        injectDocs?: boolean;
        /** False suppresses every memory-derived m[0]/m[1] surface. */
        memoryEnabled?: boolean;
        memoryInjectionBudgetTokens?: number;
        historyBudgetTokens?: number;
        historyBudgetPolicyIdentity?: string;
        temporalAwareness?: boolean;
        hardSignals?: M0HardSignals;
        /** mural.enabled — drives the on-demand deterministic mural
         *  render inside the HARD fold. */
        muralEnabled?: boolean;
    };
}

export interface PostTransformPhaseResult {
    /** A completed fold or delta refresh can change the cached attribution blocks. */
    prefixChanged: boolean;
    finalizeServedPrefix?: (publish?: boolean) => boolean;
    prefixRecordWritable?: boolean;
    /**
     * This process's first pass serves a history head that differs from the
     * saved last-good request's, and stripped the signed thinking bound to it.
     */
    restartHeadChanged?: boolean;
    /**
     * Instruction-row decisions transform.ts saves in one update right before
     * it captures the request: the rows this pass retires, and whether it turns
     * on the switch that serves covered rows.
     */
    pendingHostInstructionDecisions?: { reclaim?: HostRowReclaim; retention: boolean };
    thinkingReleasedForFit?: boolean;
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
    /** Estimated nonnegative tokens removed by tag reductions first applied this pass. */
    droppedTokens: number;
    emergencyReclaimedTokens: number;
    droppedCount: number;
    emergency: boolean;
    /** Permission to rebuild the prefix, distinct from whether any bytes changed. */
    prefixMutationPermitted: boolean;
    bustedThisPass: boolean;
    /** How the delivered prefix cut the raw conversation; null when no m[0]/m[1] prefix was delivered. */
    prefixTrimStatus: PrefixTrimStatus | null;
    /** Why a `refused` trim made no cut; null otherwise. */
    prefixTrimRefusal: PrefixTrimRefusal | null;
    /** Pending flag applied to the live output; the caller clears it only after the live lane succeeds. */
    thinkingBindingRecovery: ThinkingBindingRecoveryApplication | null;
    /** Thinking this busting pass removed because its own edit invalidated it. */
    proactiveThinkingStrip: ProactiveThinkingStrip | null;
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
    client: ConfirmedAbortClient | undefined,
    sessionId: string,
): Promise<void> {
    if (typeof client?.session?.abort !== "function") {
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
        | "recovery-request-over-limit"
        | "refusal-grade-final-wire-over-limit"
        | "trusted-final-wire-disarm";
    /** Trusted current-pass wire evidence that lets the caller clear its durable latch. */
    disarm?: { finalWireTokens: number; provenLimitTokens: number };
    refusalMessage?: string;
}

export function evaluateEmergencyFailClosed(input: {
    usagePercentage: number;
    emergencyRecoveryArmed: boolean;
    emergencyRecoveryOrigin:
        | "provider_overflow"
        | "proactive_model_shrink"
        | "history_boundary_over_window"
        | null;
    foldMaterializedThisPass: boolean;
    finalWireEstimate?: {
        tokens: number;
        trusted: boolean;
        refusalGrade?: boolean;
        refusalTokens?: number;
    };
    /** A current-model limit parsed from a provider overflow response, never a catalog fallback. */
    providerProvenLimitTokens?: number;
    contextLimitTokens?: number;
    protectedToolTokens?: number;
    /**
     * The request this pass will send, counted the way the served-request
     * sizing counts it, and the most it may be: the 95% line of the current
     * model's usable window while older history remains to summarize, else the
     * whole usable window (see recoveryAdmissionLimitTokens). Only a pass in
     * overflow or model-shrink recovery supplies it.
     */
    recoveryServedRequest?: { tokens: number; lineTokens: number };
}): EmergencyFailClosedDecision {
    const estimate = input.finalWireEstimate;
    const limit = input.providerProvenLimitTokens;
    const refusalMessage = outgoingContextRefusal(
        estimate,
        input.contextLimitTokens ?? limit,
        input.protectedToolTokens,
    );
    if (refusalMessage) {
        return { shouldAbort: true, reason: "refusal-grade-final-wire-over-limit", refusalMessage };
    }
    if (
        input.emergencyRecoveryArmed &&
        estimate?.trusted === true &&
        Number.isFinite(estimate.tokens) &&
        estimate.tokens > 0 &&
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
    // Without route-specific proof that the final request does not fit, retain
    // the existing rule based on a provider-reported overflow. A conservative
    // estimate used to decide whether to send is not enough to refuse.
    const recoveryOrigin = input.emergencyRecoveryArmed ? input.emergencyRecoveryOrigin : null;
    if (recoveryOrigin === "provider_overflow" && !input.foldMaterializedThisPass) {
        return { shouldAbort: true, reason: "provider-overflow-abort" };
    }
    // Recovery that summarized or folded part of the history is progress, not
    // proof that the request now fits: after a switch to a much smaller model a
    // single historian run can leave the request several times over the new
    // window. Whatever this pass reclaimed, a recovery request over its limit
    // is not sent, so the provider never rejects it.
    const served = input.recoveryServedRequest;
    if (
        recoveryOrigin !== null &&
        served !== undefined &&
        served.lineTokens > 0 &&
        (!Number.isFinite(served.tokens) || served.tokens > served.lineTokens)
    ) {
        return { shouldAbort: true, reason: "recovery-request-over-limit" };
    }
    return { shouldAbort: false, reason: "proceed" };
}

export interface FinalizeMessageRepresentationOptions {
    protectedThinkingMessages?: ReadonlySet<MessageLike>;
    modelID?: string;
    prependedMessageCount?: number;
    reasoningMutatedMessages?: Iterable<MessageLike>;
    reasoningMutationExemptMessage?: MessageLike;
    mergedReasoningStrippedIds?: ReadonlySet<string>;
    /** Persisted omissions replay on every pass, including active turns. */
    frozenThinkingBindingMessageIds?: ReadonlySet<string>;
    /** Only an anchored provider rejection may authorize active-turn originals. */
    restoreThinkingMessageIds?: ReadonlySet<string>;
    trailingBlankDecisions?: ReadonlyMap<string, TrailingBlankDecision>;
    skipMergedReasoningStrip?: boolean;
    skipTrailingWhitespaceStrip?: boolean;
}

/**
 * Protection prevents first selection; it never cancels a persisted omission.
 * Only explicitly authorized, anchored recovery may keep the active turn's raw
 * originals instead of replaying those omissions. Completed history always replays.
 */
export function finalizeMessageRepresentation(
    messages: MessageLike[],
    resolvedProviderID?: string,
    options?: FinalizeMessageRepresentationOptions,
): { clearedParts: number; mergedReasoningParts: number } {
    const protectedMessages = options?.protectedThinkingMessages ?? new Set<MessageLike>();
    const restoredMessages = new Set(
        messages.filter(
            (message) =>
                protectedMessages.has(message) &&
                typeof message.info.id === "string" &&
                options?.restoreThinkingMessageIds?.has(message.info.id),
        ),
    );
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
            clearedParts = stripClearedReasoning(
                targetedMessages.filter((message) => !restoredMessages.has(message)),
            );
        }
    }
    // Compaction-off skips the merged-reasoning strip but still replays the
    // binding strips it is given (its own, see COMPACTION_OFF_THINKING_FROZEN_PREFIX).
    const bindingRecoveryParts = stripReasoningFromAssistantIds(
        messages,
        resolvedProviderID,
        options?.frozenThinkingBindingMessageIds ?? new Set(),
        restoredMessages,
    );
    const mergedReasoningParts =
        bindingRecoveryParts +
        (options?.skipMergedReasoningStrip
            ? 0
            : stripReasoningFromMergedAssistants(messages, resolvedProviderID, {
                  mutationExemptMessage: options?.reasoningMutationExemptMessage,
                  frozenMessageIds: options?.mergedReasoningStrippedIds,
                  protectedMessages,
                  restoreMessages: restoredMessages,
              }));
    if (!options?.skipTrailingWhitespaceStrip && modelAcceptsEmptyContent(resolvedProviderID)) {
        applyFrozenTrailingBlankDecisions(messages, options?.trailingBlankDecisions ?? new Map());
    }
    return { clearedParts, mergedReasoningParts };
}

// The legacy renderer embeds history in the first user message rather than a separate synthetic history message.
// Rebuilding its cache is not evidence that the provider will see different text.
function legacyPublishedHeadChanged(args: RunPostTransformPhaseArgs): boolean {
    if (!args.pendingCompartmentInjection || !args.readLastServedMessages) return false;
    const served = args.readLastServedMessages();
    // null explicitly means no earlier request was sent. A missing reader
    // function or an empty array does not establish that first-request state.
    if (served === null) return true;
    return legacyHeadDiffersFrom(args, served);
}

/** Whether the legacy history block this pass renders differs from the one `served` begins with. */
function legacyHeadDiffersFrom(
    args: RunPostTransformPhaseArgs,
    served: readonly unknown[],
): boolean {
    const previous = served[0] as MessageLike | undefined;
    if (!Array.isArray(previous?.parts) || !args.pendingCompartmentInjection) return false;
    const text = previous.parts.find(
        (part): part is { type: "text"; text: unknown } =>
            typeof part === "object" &&
            part !== null &&
            "type" in part &&
            part.type === "text" &&
            "text" in part,
    )?.text;
    if (typeof text !== "string") return false;
    const block = `<session-history>\n${args.pendingCompartmentInjection.block}\n</session-history>`;
    return text !== block && !text.startsWith(`${block}\n\n`);
}

/**
 * Whether the history head this pass renders differs from the head of `frozen`,
 * the request a frozen last-good replay served. The m[0]/m[1] pair is read from
 * the session's cached bytes as the final injection serves them: prefix
 * preparation has already brought them up to date. Both sides are compared as
 * they go out on the wire. A missing or unreadable frozen request counts as
 * different, so the caller strips rather than keeps.
 */
function frozenRecoveryHeadDiffers(
    args: RunPostTransformPhaseArgs,
    m0M1Enabled: boolean,
    frozen: readonly unknown[] | null,
): boolean {
    if (m0M1Enabled)
        return !servedPrefixMatches({
            messages: frozen,
            ...servedHeadTexts(args.sessionMeta as M0M1State),
            muralDataUrl: (args.sessionMeta as M0M1State).cachedM0MuralDataUrl ?? null,
        });
    if ((args.pendingCompartmentInjection?.compartmentCount ?? 0) > 0)
        return frozen === null || legacyHeadDiffersFrom(args, frozen);
    return false;
}

export async function runPostTransformPhase(
    args: RunPostTransformPhaseArgs,
): Promise<PostTransformPhaseResult> {
    const tPostprocessSetup = performance.now();
    const compactionOff = args.compactionOff === true;
    const signedThinkingPolicy = resolveSignedThinkingHoldPolicy(args.signedThinkingHold);
    const holdEnabled = signedThinkingPolicy.strict;
    const coldParkedTriggers = !parkedBustTriggersBySession.has(args.sessionId);
    const parkedTriggers =
        holdEnabled && !compactionOff
            ? ParkedBustTriggers.load(args.db, args.sessionId)
            : undefined;
    const parkedReleaseReasons = parkedTriggers?.reasons ?? [];
    if (parkedTriggers) {
        parkedBustTriggersBySession.set(args.sessionId, parkedTriggers);
        if (coldParkedTriggers && parkedTriggers.reason("materialization"))
            args.pendingMaterializationSessions.add(args.sessionId);
    } else parkedBustTriggersBySession.delete(args.sessionId);
    // Wait before this phase reads any decision/protection snapshot. The tagged
    // message graph and prepared history are one coherent caller-owned input;
    // do not replace only pieces of that render with a peer's newer epoch.
    if (
        !compactionOff &&
        !tryGetReasoningTokenEstimatesByMessage(
            args.db,
            args.sessionId,
            sessionDecisionCalibration(args.db, args.sessionId).proseRatio,
        )
    ) {
        await waitForTagOwners(
            args.db,
            args.sessionId,
            sessionDecisionCalibration(args.db, args.sessionId).proseRatio,
        );
    }
    // A caught error or failed persistence can leave an already-mutated array
    // only partly replayed. Never publish it, even if it fits the window. The
    // wrapper owns last-good replay or refusal; native compaction owns off mode.
    const failPass = (
        site: PassDegradationSite,
        error: unknown = new Error(`Could not complete ${site}`),
        kind?: PassDegradationKind,
    ): void => {
        args.passOutcome?.record(site, kind);
        if (!compactionOff) {
            sessionLog(args.sessionId, `transform refused degraded pass site=${site}:`, error);
            throw degradedPassError(site, error);
        }
    };
    const trailingBlankSourceDecisions =
        args.trailingBlankSourceDecisions ?? snapshotTrailingBlankSourceDecisions(args.messages);
    let structuralSentinelUpgradeFailed = args.structuralSentinelUpgradeFailed ?? false;
    if (
        !structuralSentinelUpgradeFailed &&
        args.opencode1 &&
        !compactionOff &&
        modelAcceptsEmptyContent(args.resolvedProviderID)
    )
        structuralSentinelUpgradeFailed =
            prepareStructuralSentinelChoices(args).structuralSentinelUpgrade === undefined;
    if (!modelAcceptsEmptyContent(args.resolvedProviderID) && !compactionOff)
        captureInlineThinkingRepairs(
            args.messages,
            args.messageTagNumbers,
            args.sessionMeta?.clearedReasoningThroughTag ?? 0,
        );
    const servedShapeRepair = prepareServedShapeRepair(
        args.db,
        args.sessionId,
        args.messages,
        args.readLastServedMessages,
        compactionOff ? undefined : postprocessReplaySnapshot(args.db, args.sessionId),
    );
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
    // Keep queued drops and cleanup work after a pass that cannot apply them.
    // A user command, fit retry or system change may have requested that work;
    // the request is not necessarily an explicit user flush.
    const pendingMaterializationAtPassStart = args.pendingMaterializationSessions.has(
        args.sessionId,
    );
    beginHostCheckpointPass(args.sessionId, args.pendingMaterializationSessions);
    const pendingOrigin =
        parkedTriggers?.reason("materialization") ??
        pendingMaterializationOrigin(args.pendingMaterializationSessions, args.sessionId);
    const deferredMaterializationAtPassStart = args.deferredMaterializationSessions.has(
        args.sessionId,
    );
    let isExplicitFlush = pendingMaterializationAtPassStart;
    const deferredMaterializationWasPending = deferredMaterializationAtPassStart;
    const alreadyRanThisTurn = heuristicsAlreadyRanThisTurn(
        args.lastHeuristicsTurnId,
        args.sessionId,
        args.currentTurnId,
    );
    // Tiered emergency drop eligibility (Phase 2). Unlike `forceMaterialization`
    // (primary-only — it also forces m[0] materialization), the emergency tool
    // floor fires at the derived force band for BOTH primary AND subagent: it's the only tool
    // floor subagents have now that routine age-drops are gone. It's still a
    // cache-busting-pass operation (selection persisted, defer passes replay),
    // so it only runs when heuristics run (see shouldRunHeuristics) AND usage is
    // ≥ the force-materialize threshold.
    // A reading that only a local count put in the force band below 95% is not
    // force-band pressure (`forceBandConfirmed`; see `pressureBands`).
    const bands = pressureBands({
        percentage: args.contextUsage.percentage,
        fromEstimate: args.contextUsageFromEstimate === true,
        forceMaterializationPercentage: args.forceMaterializationPercentage,
        compactionOff,
        fullFeatureMode: args.fullFeatureMode,
        schedulerDecision: args.schedulerDecision,
    });
    const {
        forceMaterialization,
        emergencyDropEligible,
        forceBandConfirmed,
        executePressureEligible,
    } = bands;
    const episode = {
        fullFeatureMode: args.fullFeatureMode,
        executePressureEligible,
        alreadyRanThisTurn,
    };
    updateRoutinePressureEpisode(args.sessionId, episode);
    const routinePressureApplied = routinePressureAlreadyApplied(args.sessionId, episode);
    // Require five points below the force band so a batch-induced dip cannot
    // immediately rearm another cache rewrite as the tail regrows. Only a
    // provider-measured reading may end the episode: a local count can read
    // low (a provider tokenizer denser than the local one), and clearing on it
    // would let the next real reading rearm a second rewrite.
    if (
        args.contextUsageFromEstimate !== true &&
        args.contextUsage.percentage > 0 &&
        args.contextUsage.percentage < args.forceMaterializationPercentage - 5 &&
        getEmergencyInputSample(args.db, args.sessionId) > 0
    ) {
        clearEmergencyDropSample(args.db, args.sessionId);
    }
    const activeCompartmentRun = args.canRunCompartments
        ? getActiveCompartmentRun(args.sessionId)
        : undefined;
    const compartmentRunning =
        args.canRunCompartments &&
        !args.awaitedCompartmentRun &&
        activeCompartmentRun !== undefined;
    let deferredMaterialize =
        (args.canConsumeDeferredLate || servedShapeRepair.needsRebuild) &&
        deferredMaterializationWasPending;
    let materializationRequested =
        isExplicitFlush || deferredMaterialize || servedShapeRepair.needsRebuild;
    // Persist eligible prefix work off-wire before authorizing automatic cleanup.
    // Execute may refresh m[1] without changing it: only changed bytes supply a ride.
    // A failed or contended advisory alone must never open the reduction lanes.
    // Re-gated for compaction-off mode (issue #266): injection runs when the
    // memory/docs identity is present AND (fullFeatureMode || compactionOff),
    // so the mode cannot swallow m[0]/m[1] delivery — and a compaction-off
    // SUBAGENT session receives the additive blocks too (injectM0M1's
    // isSubagent skip is lifted by the same flag).
    const m0M1EnabledForFold =
        args.m0M1 !== undefined &&
        (!!args.m0M1.projectPath || !!args.m0M1.projectDirectory) &&
        (args.fullFeatureMode || compactionOff);
    const frozenThinking = new Set(
        args.activeThinkingTurn || compactionOff
            ? getMergedReasoningStrippedIds(args.db, args.sessionId)
            : [],
    );
    // Compaction-off replays only the thinking strips it chose itself (see
    // COMPACTION_OFF_THINKING_FROZEN_PREFIX): it never applied the managed
    // mode's binding-mismatch entries, so the blocks they name stay on its wire.
    const compactionOffFrozenThinking = compactionOff
        ? compactionOffFrozenThinkingIds(frozenThinking)
        : new Set<string>();
    const bindingThinking = compactionOff
        ? new Set(compactionOffFrozenThinking)
        : new Set(
              [...frozenThinking]
                  .filter((id) => id.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX))
                  .map((id) => id.slice(THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length)),
          );
    const retainedThinking = args.activeThinkingTurn
        ? retainedActiveThinkingParts({
              messages: args.messages,
              providerID: args.resolvedProviderID,
              modelID: args.resolvedModelID,
              mergedIds: frozenThinking,
              bindingIds: bindingThinking,
              removedIds: getReasoningRemovalState(args.db, args.sessionId).messageIds,
          })
        : new Set<unknown>();
    let activeThinkingTurn = retainedThinking.size > 0;
    const protectedThinkingMessages = new Set(
        args.messages.filter((message) => message.parts.some((part) => retainedThinking.has(part))),
    );
    const companionEnabled = args.thinkingBindingRecoveryEnabledForModel === true && !compactionOff;
    const companionIds = new Set<string>();
    const savedOmissions = companionEnabled
        ? getMergedReasoningStrippedIds(args.db, args.sessionId)
        : new Set<string>();
    const savedBindings = new Set(
        [...savedOmissions]
            .filter((id) => id.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX))
            .map((id) => id.slice(THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length)),
    );
    // Existing binding omissions never need another companion decision. Keep
    // their session-wide scan outside every lane's write transaction.
    const companionCandidates = args.messages.filter(
        (message) =>
            message.info.role === "assistant" &&
            (!message.info.id || !savedBindings.has(message.info.id)),
    );
    const companionPreview = companionEnabled
        ? args.messages.map((message) => ({ ...message, parts: [...message.parts] }))
        : [];
    finalizeMessageRepresentation(companionPreview, args.resolvedProviderID, {
        frozenThinkingBindingMessageIds: savedBindings,
        mergedReasoningStrippedIds: savedOmissions,
        skipTrailingWhitespaceStrip: true,
    });
    if (companionEnabled)
        removeReasoningParts(
            companionPreview,
            getReasoningRemovalState(args.db, args.sessionId).messageIds,
            args.resolvedProviderID,
        );
    const companionKept = new Set(companionPreview.flatMap((message) => message.parts));
    const companionOrder = new Map(
        (companionEnabled ? args.messages : []).map((message, index) => [message, index]),
    );
    let companionBoundary: { message: number; part: number } | undefined;
    const companionTargets = new Set<string | undefined>();
    for (const [index, message] of (companionEnabled ? args.messages : []).entries()) {
        if (protectedThinkingMessages.has(message) || message.info.role !== "assistant") continue;
        for (const [partIndex, part] of message.parts.entries())
            if (
                companionKept.has(part) &&
                isRecord(part) &&
                part.ignored !== true &&
                ["reasoning", "thinking", "redacted_thinking"].includes(String(part.type))
            ) {
                companionBoundary = { message: index, part: partIndex };
                companionTargets.add(message.info.id);
            }
    }
    const precedesCompanionThinking = (message: MessageLike, part: number): boolean => {
        const index = companionOrder.get(message);
        return (
            !!companionBoundary &&
            (index === undefined ||
                index < companionBoundary.message ||
                (index === companionBoundary.message && part <= companionBoundary.part))
        );
    };
    const persistCompanion = (): void => {
        if (args.thinkingBindingRecoveryEnabledForModel !== true || compactionOff) return;
        const alreadyFrozen = new Set(
            [...getMergedReasoningStrippedIds(args.db, args.sessionId)]
                .filter((id) => id.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX))
                .map((id) => id.slice(THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length)),
        );
        const outcome = freezeReasoningOnBustingPass({
            db: args.db,
            sessionId: args.sessionId,
            messages: companionCandidates,
            protectedMessages: protectedThinkingMessages,
            alreadyFrozen,
        });
        if (outcome.persistenceFailed)
            failPass(
                "proactive-thinking-strip-persistence-failure",
                new Error("The edit's companion omissions could not be persisted"),
            );
        for (const id of outcome.strip?.messageIds ?? []) companionIds.add(id);
    };
    // Edit admission. On prefix-bound models a signed thinking block is valid only while
    // every byte before it is unchanged, so an edit before the last current-turn thinking
    // block still sent is held: not applied and not persisted. The frame uses the same
    // messages and `info.id` values as the strips; it is rebuilt only after all signatures
    // have been omitted for a prefix rewrite, when no signed boundary remains to protect.
    const makeEditAdmission = () =>
        createEditAdmission({
            messages: holdEnabled ? args.messages : [],
            stableId: (message) => message.info.id,
            partsOf: (message) => message.parts,
            isRealUser: isAdmissionUser,
            prefixBound: holdEnabled && args.thinkingBindingRecoveryEnabledForModel === true,
            isRetainedThinking: (_message, part) => retainedThinking.has(part),
            anchorOf: thinkingAnchor,
            onUnresolved: (reason) =>
                sessionLog(
                    args.sessionId,
                    `edit admission: unresolved thinking boundary (${reason}); holding every edit not provably after it`,
                ),
        });
    let editAdmission = makeEditAdmission();
    const prefixProvenance: PrefixProvenance = {
        host: args.opencode2 ? "opencode-v2" : "opencode-v1",
        id_space: args.opencode2 ? "opencode-v2-message" : "opencode-v1-message",
        generation: args.opencode2 ? "v2" : "v1",
        projection: "messages",
        model: { provider: args.resolvedProviderID, id: args.resolvedModelID },
    };
    const prefixSourceIds = new Set(
        (
            args.prefixTrimSourceOrder?.messageIds ??
            args.messages.map((message) => message.info.id)
        ).filter((id): id is string => !!id),
    );
    const recordTurn = prefixTurn(args.messages, (message) => message.info.id);
    const prefixRecordEnabled =
        signedThinkingPolicy.strict &&
        m0M1EnabledForFold &&
        args.thinkingBindingRecoveryEnabledForModel === true;
    let prefixRecord: ServedPrefix<MessageLike> | null = null;
    if (prefixRecordEnabled) {
        try {
            prefixRecord = readServedPrefix(args.db, args.sessionId);
        } catch (error) {
            if (!compactionOff) throw degradedPassError("served-prefix-read", error);
        }
    }
    let replayedPrefixRecord = false;
    let offPrefixFallback: (() => MessageLike[] | undefined) | undefined;
    const prefixUnverified = (reason: string): void => {
        sessionLog(
            args.sessionId,
            `edit admission: served_prefix_unverified reason=${reason} held_edits=1`,
        );
    };
    const heldWholeMessages = new Map<string, string[]>();
    const admitWholeMessage =
        (lane: string) =>
        (message: MessageLike): boolean => {
            if (
                !editAdmission ||
                editAdmission.admit({ kind: "message", id: message.info.id, block: "whole" })
            )
                return true;
            const held = heldWholeMessages.get(lane) ?? [];
            held.push(message.info.id ?? "<no id>");
            heldWholeMessages.set(lane, held);
            return false;
        };
    const logHeldWholeMessages = (): void => {
        if (editAdmission?.frame.kind !== "boundary") return;
        for (const [lane, ids] of heldWholeMessages) {
            sessionLog(
                args.sessionId,
                `edit admission: held lane=${lane} coords=${ids.map((id) => `${id}:whole`).join(",")} boundary=${editAdmission.frame.messageId ?? "<unresolved>"} held_edits=${ids.length}`,
            );
        }
        heldWholeMessages.clear();
    };
    const protectTargets = () =>
        protectToolBatchMutations(
            protectNewTagMutations(
                args.messages,
                args.targets,
                retainedThinking,
                args.thinkingBindingRecoveryEnabledForModel === true,
            ),
            editAdmission,
            () => openCodeToolBatchCoordinates(args.messages),
        );
    let newTargets = protectTargets();
    const safeReasoningCutoff = sharedSafeReasoningCutoff(
        args.messageTagNumbers,
        protectedThinkingMessages,
    );
    // The caller decides the hold (decideSignedThinkingHold): on a prefix-bound
    // model it holds only right after heavy reasoning and below the cap. Any
    // other pass of a signed turn busts like a pass of any other model, and
    // strips the turn's signed thinking when it does (see below).
    let activeThinkingPrefixHold = args.activeThinkingPrefixHold === true;
    let freezeM0M1 = args.freezeM0M1 === true || activeThinkingPrefixHold;
    // Cached-head and tag-target protection is always enabled. Only the experimental
    // trigger parking changes which independent bust permissions remain available.
    const triggerPermissions = parkedTriggers?.permissions(
        freezeM0M1,
        pendingMaterializationAtPassStart || deferredMaterializationAtPassStart,
        emergencyDropEligible,
    ) ?? { materialization: true, force: true };
    isExplicitFlush &&= triggerPermissions.materialization;
    materializationRequested =
        isExplicitFlush || (deferredMaterialize && triggerPermissions.materialization);
    let rewritingSignedPrefix = false;
    let thinkingReleasedForFit = false;
    // `stripInCompactionOff` makes a compaction-off pass remove the frozen
    // blocks from its own wire too (it otherwise only records them), for a
    // release whose head change compaction-off cannot avoid. `saved` is a strip
    // the caller already persisted (a compaction-off fold saves its strip in the
    // fold's transaction); the release then only applies it.
    const releaseThinkingForRewrite = (
        forFit = false,
        stripInCompactionOff = false,
        saved?: ReturnType<typeof freezeReasoningOnBustingPass>,
    ) => {
        const stripOffWire = compactionOff && stripInCompactionOff;
        const stripped =
            saved ??
            freezeReasoningOnBustingPass({
                db: args.db,
                sessionId: args.sessionId,
                messages: args.messages,
                alreadyFrozen: bindingThinking,
                compactionOff: stripOffWire,
            });
        if (stripped.persistenceFailed)
            throw new Error("Cannot persist signed thinking omission before prefix rewrite");
        if (stripOffWire)
            for (const id of stripped.strip?.messageIds ?? []) compactionOffFrozenThinking.add(id);
        // A later release on the same pass then has nothing left to record.
        for (const id of stripped.strip?.messageIds ?? []) bindingThinking.add(id);
        retainedThinking.clear();
        protectedThinkingMessages.clear();
        activeThinkingTurn = false;
        activeThinkingPrefixHold = false;
        freezeM0M1 = args.directoryPrefixHold === true;
        newTargets = args.targets;
        rewritingSignedPrefix = true;
        thinkingReleasedForFit ||= forFit;
        // The rewrite omitted every signed block, so no retained boundary can veto its work.
        editAdmission = makeEditAdmission();
    };
    // Replacing a previously served empty text slot cannot wait for the signed-prefix hold. Reuse
    // the normal rewrite release so no signature remains bound to old bytes.
    if (servedShapeRepair.needsRebuild && activeThinkingTurn)
        releaseThinkingForRewrite(false, true);
    // Fit proof authorizes rebuilding the signed prefix, independently of
    // pressure. Release before prefix preparation so it can refresh history
    // without pretending the protected tool window has reached 95% usage.
    if (
        args.forceSignedRebuildForFit &&
        signedThinkingPolicy.mayRebuildForFit &&
        (activeThinkingPrefixHold ||
            (activeThinkingTurn && args.thinkingBindingRecoveryEnabledForModel === true))
    ) {
        releaseThinkingForRewrite(true);
    }
    // A compaction mode switch adds or removes the tags in front of every
    // signed block, whatever the head does, and the switch pass rebuilds the
    // head anyway (the switch clears the cached m[0]/m[1]). Strip every signed
    // block on that pass, before the head is prepared, so the rebuild carries
    // no thinking bound to the other mode's bytes.
    if (
        args.compactionModeTransition === true &&
        args.thinkingBindingRecoveryEnabledForModel === true
    ) {
        sessionLog(args.sessionId, "compaction mode switch: stripping signed thinking");
        releaseThinkingForRewrite(false, true);
    }
    // OpenCode 2 can replace the history head outside any pass: its compaction
    // hook commits a new m[0]/m[1] for a manual /compact and asks for a
    // `host_compaction` materialization. When that proves the head this request
    // serves differs from the one the provider cached, the cache is already
    // lost, so this pass is the hardFold ride every queued lane lands on. The
    // request stays pending until a pass settles it (see the end of this phase).
    const hostCheckpointRequested = hasPendingMaterializationOrigin(
        args.pendingMaterializationSessions,
        args.sessionId,
        "host_compaction",
    );
    const hostCheckpointProof =
        hostCheckpointRequested && m0M1EnabledForFold
            ? hostCheckpointHeadChange(args.sessionId, () => {
                  hydrateCachedM0Mural(args.db, args.sessionId, args.sessionMeta as M0M1State);
                  return {
                      m0Text: args.sessionMeta.cachedM0Bytes?.toString("utf8"),
                      m1Text: args.sessionMeta.cachedM1Bytes?.toString("utf8"),
                      muralDataUrl: (args.sessionMeta as M0M1State).cachedM0MuralDataUrl ?? null,
                  };
              })
            : undefined;
    const hostCheckpointRide = hostCheckpointProof?.changed === true;
    if (hostCheckpointRequested) {
        sessionLog(
            args.sessionId,
            `host checkpoint head: changed=${hostCheckpointRide} proof=${hostCheckpointProof?.source ?? "none"}`,
        );
    }
    // A held pass replays the persisted head, and the hook already replaced
    // it: the hold keeps nothing unchanged. As on a first render, the new head
    // goes out, so the open turn's signed thinking leaves the wire with it.
    if (hostCheckpointRide && activeThinkingPrefixHold) {
        sessionLog(
            args.sessionId,
            "host checkpoint head changed under a signed-thinking hold: stripping signed thinking",
        );
        releaseThinkingForRewrite(false, true);
    }
    // The request's tools changed (the caller logged what changed and lifted any
    // hold). Tools come first in the request, so this pass already loses the
    // whole provider cache: strip every signed block, compaction-off included,
    // and let the queued work ride the rewrite. Only the m[0] fold decision
    // below is unaffected: a name or description change still folds through
    // its own trigger, and a schema-only change never does.
    if (args.requestToolsChange && args.thinkingBindingRecoveryEnabledForModel === true) {
        releaseThinkingForRewrite(false, true);
    }
    const foldDueDecision =
        m0M1EnabledForFold && args.m0M1 && !freezeM0M1
            ? mustMaterialize({
                  db: args.db,
                  sessionId: args.sessionId,
                  state: args.sessionMeta as M0M1State,
                  projectPath: args.m0M1.projectPath,
                  projectDirectory: args.m0M1.projectDirectory,
                  injectDocs: args.m0M1.injectDocs,
                  memoryEnabled: args.m0M1.memoryEnabled,
                  muralEnabled: args.m0M1.muralEnabled,
                  memoryInjectionBudgetTokens: args.m0M1.memoryInjectionBudgetTokens,
                  historyBudgetTokens: args.m0M1.historyBudgetTokens,
                  historyBudgetPolicyIdentity: args.m0M1.historyBudgetPolicyIdentity,
                  hardSignals: args.m0M1.hardSignals,
              })
            : { value: false, reason: null };
    let preparedPrefix: InjectM0M1Result | undefined;
    const shouldCaptureCachedPrefix =
        (foldDueDecision.value || args.schedulerDecision === "execute") &&
        m0M1EnabledForFold &&
        !emergencyDropEligible &&
        !freezeM0M1;
    const cachedPrefixBeforePreflight = shouldCaptureCachedPrefix
        ? prepareCachedM0M1Replay(args.db, args.sessionId)
        : undefined;
    const completeCachedPrefixAvailable =
        (args.sessionMeta.cachedM0Bytes != null && args.sessionMeta.cachedM1Bytes != null) ||
        cachedPrefixBeforePreflight !== undefined ||
        (m0M1EnabledForFold &&
            !shouldCaptureCachedPrefix &&
            hasCompleteCachedM0M1(args.db, args.sessionId));
    const firstRenderBust =
        !(holdEnabled && freezeM0M1) && m0M1EnabledForFold && !completeCachedPrefixAvailable;
    const servedBeforeFirstRender = firstRenderBust ? args.readLastServedMessages?.() : null;
    if (holdEnabled && freezeM0M1 && m0M1EnabledForFold && !completeCachedPrefixAvailable) {
        args.pendingMaterializationSessions.add(args.sessionId);
        parkedTriggers?.holdMaterialization(pendingOrigin);
    }
    let foldExecutedThisPass = false;
    // The one bust permission an executed fold grants: true only when the fold
    // also loses the provider's cached prefix (see foldBustsServedPrefix). Every
    // lane that rides a fold consults it: legacy skeleton conversion, pending-op
    // drains, heuristics, synthetic todo and sentinel first-application.
    let foldBustsServedPrefixThisPass = false;
    let foldChangesHeadThisPass = false;
    let recoveryExternalFoldCause: string | null = null;
    let publishedM1RefreshedThisPass = false;
    let prefixPreflightFailed = false;
    const softRefreshOpportunity =
        !freezeM0M1 &&
        (args.schedulerDecision === "execute" ||
            deferredMaterialize ||
            servedShapeRepair.needsRebuild);
    let m0RematerializedThisPass = false;
    const m0CoverageBeforeFold =
        args.sessionMeta.cachedM0Bytes === null ? -1 : args.sessionMeta.cachedM0MaxCompartmentSeq;
    let m0MaterializeReason: string | null = null;
    // The preflight is the decision site that decides whether m[0] must fold.
    // Keep its observational tool-set operands even when it correctly declines
    // to materialize, so a separate cache-busting pass can be attributed later.
    let m0ComparisonDecision: MaterializeDecision | null = foldDueDecision;
    // Legacy dropped-tool skeletons (argument marker) are converted to the
    // real-or-absent rule only inside an executed HARD fold's transaction, and
    // only when that fold busts the served prefix (foldBustsServedPrefix). The
    // decision made there is the same one that later opens the other lanes.
    // Retries recompute the same decisions from the same wire, so collecting
    // across attempts is safe; the last attempt is the one that committed.
    const convertedToolSkeletons = new Map<number, ConvertedToolDropMode>();
    let convertedToolSkeletonsDidMutate = false;
    // An unhydrated mural would read as "no image served" and make a fold that
    // re-renders the same image look like a change, opening the lanes on a pass
    // that keeps the provider cache.
    hydrateCachedM0Mural(args.db, args.sessionId, args.sessionMeta as M0M1State);
    const servedPrefixBeforeFold = {
        m0Bytes: args.sessionMeta.cachedM0Bytes ?? null,
        m1Bytes: args.sessionMeta.cachedM1Bytes ?? null,
        muralDataUrl: (args.sessionMeta as M0M1State).cachedM0MuralDataUrl ?? null,
    };
    // How a head rendered on this pass compares with the head the session last
    // served: whether it loses the provider's cached prefix (`bustsPrefix`), and
    // whether it changes the served bytes signed thinking is bound to
    // (`changesHead`).
    const compareRenderedHead = (rendered: {
        m0Bytes: Buffer;
        m1Bytes: Buffer;
        muralDataUrl: string | null;
    }) => {
        const servedMatches = () =>
            servedPrefixMatches({
                messages: servedBeforeFirstRender,
                m0Text: rendered.m0Bytes.toString(),
                m1Text: rendered.m1Bytes.toString(),
                muralDataUrl: rendered.muralDataUrl,
            });
        return {
            bustsPrefix: activeThinkingPrefixHold
                ? !servedMatches()
                : foldBustsServedPrefix(foldDueDecision.reason, servedPrefixBeforeFold, rendered),
            changesHead: firstRenderBust
                ? !servedMatches()
                : foldChangesServedPrefix(servedPrefixBeforeFold, rendered),
        };
    };
    // Compaction-off never refuses a pass, so a head it renders in front of
    // kept signed thinking saves the strip of that thinking inside the render's
    // own transaction: a failed strip write then rolls the head back with it,
    // and a later pass renders and strips together. Saved after the commit, a
    // failed write would leave the new head saved and nothing would strip again,
    // since compaction-off strips only on the pass whose render changed the head.
    // A first render under a hold strips the held turn's thinking; any other
    // render strips when it changes the head.
    const compactionOffRenderStrip = (
        db: ContextDatabase,
        head: { bustsPrefix: boolean; changesHead: boolean },
    ): ReturnType<typeof freezeReasoningOnBustingPass> | undefined => {
        const due =
            compactionOff &&
            (activeThinkingPrefixHold
                ? firstRenderBust && head.bustsPrefix
                : args.thinkingBindingRecoveryEnabledForModel === true && head.changesHead);
        if (!due) return undefined;
        const strip = freezeReasoningOnBustingPass({
            db,
            sessionId: args.sessionId,
            messages: args.messages,
            alreadyFrozen: bindingThinking,
            compactionOff: true,
        });
        if (strip.persistenceFailed)
            throw new Error("Cannot persist signed thinking omission with the compaction-off fold");
        return strip;
    };
    if (
        (foldDueDecision.value ||
            softRefreshOpportunity ||
            (firstRenderBust && activeThinkingPrefixHold)) &&
        m0M1EnabledForFold &&
        args.m0M1
    ) {
        let committedFoldBustsServedPrefix: boolean | undefined;
        // Whether the committed fold serves m[0]/m[1]/mural bytes that differ
        // from the head the session last served. Unlike the bust permission it
        // ignores reasons that only lose the provider cache: signed thinking is
        // bound to bytes, so only a byte change invalidates it.
        let committedFoldChangesHead: boolean | undefined;
        // The thinking strip a compaction-off fold saved in its own transaction.
        let compactionOffFoldStrip: ReturnType<typeof freezeReasoningOnBustingPass> | undefined;
        try {
            const previousM1 = args.sessionMeta.cachedM1Bytes?.toString("utf8");
            // Omitting messages keeps prefix preparation off-wire. The final
            // injection replays the persisted pair after reductions finish.
            const foldResult = injectM0M1({
                db: args.db,
                sessionId: args.sessionId,
                state: args.sessionMeta as M0M1State,
                projectPath: args.m0M1.projectPath,
                projectDirectory: args.m0M1.projectDirectory,
                injectDocs: args.m0M1.injectDocs,
                memoryEnabled: args.m0M1.memoryEnabled,
                memoryInjectionBudgetTokens: args.m0M1.memoryInjectionBudgetTokens,
                historyBudgetTokens: args.m0M1.historyBudgetTokens,
                historyBudgetPolicyIdentity: args.m0M1.historyBudgetPolicyIdentity,
                temporalAwareness: args.m0M1.temporalAwareness,
                isCacheBustingPass: true,
                contentionFallbackPrefix: cachedPrefixBeforePreflight,
                allowFreshContentionFallback: forceMaterialization || emergencyDropEligible,
                hardSignals: args.m0M1.hardSignals,
                muralEnabled: args.m0M1.muralEnabled,
                compactionOff,
                onM1Commit: !activeThinkingPrefixHold ? persistCompanion : undefined,
                onFoldPrepare: () => {
                    const conversions = prepareLegacyToolSkeletonConversions(
                        args.db,
                        args.sessionId,
                        args.targets,
                    );
                    return (db, rendered) => {
                        const head = compareRenderedHead(rendered);
                        const bustsPrefix = head.bustsPrefix;
                        committedFoldChangesHead = head.changesHead;
                        if (bustsPrefix) {
                            if (!conversions.isCurrent(db)) {
                                throw new MaterializeContentionError({
                                    reason: "fold conversion snapshot changed",
                                });
                            }
                            const conversionBeforeThinking = [...conversions.converted.keys()].some(
                                (tag) => {
                                    const target = args.targets.get(tag);
                                    return (
                                        target?.mutationParts?.some(({ message, part }) =>
                                            precedesCompanionThinking(
                                                message,
                                                message.parts.indexOf(part),
                                            ),
                                        ) ??
                                        (target?.message
                                            ? precedesCompanionThinking(target.message, 0)
                                            : false)
                                    );
                                },
                            );
                            if (
                                !activeThinkingPrefixHold &&
                                (conversionBeforeThinking ||
                                    foldInvalidatesThinking(
                                        foldDueDecision.reason,
                                        servedPrefixBeforeFold,
                                        rendered,
                                    ))
                            )
                                persistCompanion();
                            conversions.persist(db);
                            for (const [tagNumber, mode] of conversions.converted) {
                                convertedToolSkeletons.set(tagNumber, mode);
                            }
                        }
                        committedFoldBustsServedPrefix = bustsPrefix;
                        compactionOffFoldStrip = compactionOffRenderStrip(db, head);
                    };
                },
            });
            preparedPrefix = foldResult;
            if (activeThinkingPrefixHold && firstRenderBust && committedFoldBustsServedPrefix) {
                // Compaction-off holds every open signed turn, but a first render
                // has no cached head to replay: the new head goes out, so the
                // turn's thinking must leave the wire with it.
                releaseThinkingForRewrite(false, true, compactionOffFoldStrip);
            } else if (
                compactionOff &&
                !activeThinkingPrefixHold &&
                args.thinkingBindingRecoveryEnabledForModel === true &&
                committedFoldChangesHead
            ) {
                // Compaction-off holds the head only while the open turn has
                // signed thinking. A fold on any other pass (the first request of
                // a new turn after a memory edit, for example) re-renders the
                // head in front of the earlier turns' signed thinking, which a
                // prefix-bound model invalidates as well. That fold is the
                // rewrite, so the blocks leave the wire on the same pass and
                // stay stripped on every later one.
                sessionLog(
                    args.sessionId,
                    "compaction-off fold changed the head: stripping signed thinking",
                );
                releaseThinkingForRewrite(false, true, compactionOffFoldStrip);
            }
            prefixPreflightFailed = foldResult.materializationContentionRetryExhausted === true;
            foldExecutedThisPass = foldExecutesThisPass(
                foldDueDecision.value || softRefreshOpportunity,
                foldResult.m0RematerializedThisPass,
            );
            // Every executed fold commits through the hook above. Should one ever
            // execute without it, keep the permission executed folds always had.
            foldBustsServedPrefixThisPass =
                foldExecutedThisPass && (committedFoldBustsServedPrefix ?? true);
            foldChangesHeadThisPass = foldExecutedThisPass && committedFoldChangesHead === true;
            publishedM1RefreshedThisPass =
                !foldResult.materializationContentionRetryExhausted &&
                previousM1 !== args.sessionMeta.cachedM1Bytes?.toString("utf8");
            m0RematerializedThisPass = foldResult.m0RematerializedThisPass;
            m0MaterializeReason = foldResult.decision.reason;
            // An unknown previous identity is not proof that this request
            // changed before the conversation. Tool-definition adoption is
            // already excluded by the materialization decision itself.
            if (!prefixPreflightFailed && foldExecutedThisPass) {
                const decision = foldResult.decision;
                if (
                    (decision.reason === "system_hash" &&
                        decision.systemHashPrev &&
                        decision.systemHashPrev !== "0") ||
                    (decision.reason === "model_change" && decision.m0ModelKeyPrev) ||
                    decision.reason === "tool_definitions"
                ) {
                    recoveryExternalFoldCause = decision.reason;
                }
            }
            // Only a committed fold persisted the conversions; render them now,
            // before the batch finalizes, so this pass serves what later passes
            // replay from the new drop modes.
            if (foldResult.m0RematerializedThisPass && convertedToolSkeletons.size > 0) {
                convertedToolSkeletonsDidMutate = renderConvertedToolSkeletons(
                    args.targets,
                    convertedToolSkeletons,
                );
                sessionLog(
                    args.sessionId,
                    `HARD fold converted ${convertedToolSkeletons.size} legacy dropped-tool skeleton(s) to real-or-absent`,
                );
            }
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
            preparedPrefix = cachedPrefixBeforePreflight;
            prefixPreflightFailed = true;
            failPass("m0-m1-fold-preexecution-degradation", error);
            sessionLog(
                args.sessionId,
                "transform: m[0] HARD fold pre-execution failed:",
                getErrorMessage(error),
            );
        }
        // A pressure-backstop refold can execute after a SOFT preflight whose
        // reason is null. That is the drift path, not an unknown HARD trigger.
        sessionLog(
            args.sessionId,
            `m[0] HARD fold decision: reason=${m0MaterializeReason ?? foldDueDecision.reason ?? (foldExecutedThisPass ? "drift" : "soft_refresh")} executed=${foldExecutedThisPass} bustsServedPrefix=${foldBustsServedPrefixThisPass}`,
        );
        const toolChange = m0ComparisonDecision?.toolDefinitionsChange;
        if (foldExecutedThisPass && toolChange) {
            sessionLog(
                args.sessionId,
                "m[0] request tool definitions changed:",
                JSON.stringify(toolChange),
            );
        }
    }
    if (args.normalizeRecoveryTail && (foldBustsServedPrefixThisPass || firstRenderBust)) {
        args.normalizeRecoveryTail();
        args.tags = getTagsBySession(args.db, args.sessionId);
        newTargets = protectTargets();
    }
    // Fold decision, cached-prefix capture and the m[1] soft refresh run above;
    // time precomputation and commit together so setup has no untimed stretch.
    logTransformTiming(
        args.sessionId,
        "pp.prefixPreflight",
        tPostprocessSetup,
        `foldExecuted=${foldExecutedThisPass} m1Refreshed=${publishedM1RefreshedThisPass}`,
    );
    const tPassDecisions = performance.now();
    const frontToolCandidates = args.tags.filter(
        (tag) =>
            tag.type === "tool" &&
            tag.status === "active" &&
            args.targets.get(tag.tagNumber)?.canDrop?.(),
    );
    if (
        !holdEnabled &&
        activeThinkingPrefixHold &&
        (args.forceSignedRebuildForFit ||
            (args.contextUsage.percentage >= 95 &&
                frontToolCandidates.length > 0 &&
                frontToolCandidates.every(
                    (tag) => newTargets.get(tag.tagNumber)?.thinkingRewriteProtected === true,
                )))
    ) {
        releaseThinkingForRewrite(true);
    }
    if (activeThinkingPrefixHold) {
        if (materializationRequested && m0M1EnabledForFold) {
            parkedTriggers?.holdMaterialization(pendingOrigin);
            if (holdEnabled)
                sessionLog(
                    args.sessionId,
                    `edit admission: held lane=materialization coords=prefix boundary=${editAdmission?.frame.kind === "boundary" ? editAdmission.frame.messageId : "<unresolved>"} held_edits=1`,
                );
        }
        isExplicitFlush = false;
        deferredMaterialize = false;
        materializationRequested = false;
    }

    const shouldReadPendingOps =
        !compactionOff &&
        (materializationRequested ||
            publishedM1RefreshedThisPass ||
            args.schedulerDecision === "execute" ||
            forceMaterialization ||
            foldExecutedThisPass ||
            firstRenderBust ||
            compartmentRunning);
    const pendingOps = shouldReadPendingOps ? getPendingOps(args.db, args.sessionId) : [];
    const hasPendingUserOps = pendingOps.length > 0;
    // Preserve the requested application opportunity when thinking safety, not
    // cache policy, prevents this batch. The next real user releases the veto.
    // The bounded policy's queued drops ride its next unheld bust, which strips
    // the turn's thinking. Strict admission instead parks the held execute
    // opportunity so it survives until that turn ends.
    if (
        args.schedulerDecision === "execute" &&
        (holdEnabled
            ? !emergencyDropEligible
            : args.thinkingBindingRecoveryEnabledForModel !== true) &&
        pendingOps.some((op) => newTargets.get(op.tagId)?.thinkingDropProtected)
    ) {
        requestPendingMaterialization(
            args.pendingMaterializationSessions,
            args.sessionId,
            "thinking_hold",
        );
        // Retaining a scheduler-requested drop must not let the materialization
        // signal authorize unrelated cleanup on the next pass of this signed turn.
        parkedTriggers?.holdMaterialization(pendingOrigin);
    }
    const formatPendingOpsDepth = (): string => {
        const depth = getPendingOpsCount(args.db, args.sessionId);
        return depth === null ? "not loaded (deferred pass)" : String(depth);
    };
    // All first applications share an independently priced cache-bust permission.
    // An expired provider cache is not one of them: when only the provider forgot
    // the cache, the pass replays byte-identically like a warm one, so queued
    // drops, cleanup and signed thinking all wait for a real ride.
    const protectedToolTags = protectedToolTagNumbers(args.tags, args.protectedTools);
    // The ride signals, the per-pass mutation permission and the lane gates come
    // from `decidePassMutation`; the shared decision vectors
    // (`pass-decision-vectors.json`) exercise that same function.
    const passDecision = decidePassMutation(
        {
            fullFeatureMode: args.fullFeatureMode,
            compactionOff,
            schedulerDecision: args.schedulerDecision,
            contextPercentage: args.contextUsage.percentage,
            forceMaterializationPercentage: args.forceMaterializationPercentage,
            contextUsageFromEstimate: args.contextUsageFromEstimate === true,
            emergencyInputSample: () => getEmergencyInputSample(args.db, args.sessionId),
            forceTriggerPermitted: triggerPermissions.force,
            servedShapeRepair: servedShapeRepair.needsRebuild,
            rewritingSignedPrefix,
            foldBustsServedPrefix: foldBustsServedPrefixThisPass,
            firstRenderBust,
            hostCheckpointHead: hostCheckpointRide,
            explicitFlush:
                isExplicitFlush &&
                hasPendingMaterializationOrigin(
                    args.pendingMaterializationSessions,
                    args.sessionId,
                    "user_flush",
                ),
            publishedHistory:
                !prefixPreflightFailed &&
                (publishedM1RefreshedThisPass ||
                    (!m0M1EnabledForFold &&
                        (args.pendingCompartmentInjection?.compartmentCount ?? 0) > 0 &&
                        legacyPublishedHeadChanged(args))),
            historyRebuiltThisPass: args.historyRebuiltThisPass === true,
            materializationRequested,
            alreadyRanThisTurn,
            signedThinkingHold: activeThinkingPrefixHold,
        },
        ({ primaryExecute, alreadyBusting }) =>
            originateExecuteReclaim({
                db: args.db,
                sessionId: args.sessionId,
                primaryExecute,
                alreadyBusting,
                summaryCanCome:
                    compartmentRunning ||
                    args.sessionMeta.compartmentInProgress ||
                    ((prefixPreflightFailed || freezeM0M1 || activeThinkingPrefixHold) &&
                        (args.deferredHistoryRefreshSessions.has(args.sessionId) ||
                            args.deferredMaterializationSessions.has(args.sessionId) ||
                            args.historyRefreshSessions?.has(args.sessionId) === true)) ||
                    readExecuteReclaimState(args.db, args.sessionId).floorOrdinal !== null,
                reclaimableTokens: estimateExecuteReclaimTokens({
                    db: args.db,
                    sessionId: args.sessionId,
                    pendingOps,
                    tags: args.tags,
                    targets: newTargets,
                    protectedTagIds: new Set([...args.protectedTagIds, ...protectedToolTags]),
                }),
                usableWindow: args.usableWindow,
            }),
    );
    const { rideSignals, publishedWorkDrainAllowed, shouldApplyPendingOps, shouldRunHeuristics } =
        passDecision;
    // Every first-application lane and m[1] refresh uses this same permission.
    // It authorizes mutation; individual lanes may still find no eligible work.
    const isCacheBustingPass = passDecision.isCacheBustingPass;
    if (servedShapeRepair.needsRebuild && !isCacheBustingPass)
        throw new Error("Served-shape repair requires a rebuilding pass");
    servedShapeRepair.apply(isCacheBustingPass);
    // A frozen last-good replay keeps the history head it went out with until a
    // pass that may rewrite the whole prefix releases it (see the end of this
    // phase), and that pass serves the head saved now. A pass refused after it
    // saved a new head leaves exactly that difference behind, unserved, so this
    // pass has changed nothing in the head itself. Every signed block served
    // since the replay is still bound to the replay's head, so a release that
    // changes the head is a head change like a fold, and both strips below
    // count it.
    const releasedFrozenHeadChanged =
        isCacheBustingPass &&
        !activeThinkingPrefixHold &&
        args.frozenRecoveryRequest !== undefined &&
        frozenRecoveryHeadDiffers(args, m0M1EnabledForFold, args.frozenRecoveryRequest());
    if (releasedFrozenHeadChanged)
        sessionLog(
            args.sessionId,
            "frozen replay release: the history head differs from the replay's; counting it as a head change",
        );
    // A frozen replay lives only in memory, so after a restart the first pass
    // can serve a head that a refused pass saved but never served, on a pass
    // without rewrite permission. Every signed block served since was produced
    // behind the head of the saved last-good request. When the head this pass
    // serves differs from that one, the change is already on this request, so
    // the pass strips every kept signed block, as any head change does, and
    // transform.ts records the rewrite with its reason.
    const restartHeadChanged =
        !compactionOff &&
        args.thinkingBindingRecoveryEnabledForModel === true &&
        args.restartedLastServedRequest !== undefined &&
        frozenRecoveryHeadDiffers(args, m0M1EnabledForFold, args.restartedLastServedRequest());
    if (restartHeadChanged) {
        sessionLog(
            args.sessionId,
            "restart: the history head differs from the saved last-good request's; stripping signed thinking",
        );
        releaseThinkingForRewrite();
    }
    // An unheld bust of a prefix-bound model whose turn still keeps signed
    // thinking lands like a bust on any other model: latest-turn protection is
    // lifted so queued drops and cleanup in the turn apply on it. A bust that
    // changes anything before the kept thinking must then strip every signed
    // block, because those blocks no longer match their prefix:
    // - a pass whose head changed (fold, first render, m[1] refresh, a frozen
    //   replay released with a different head) strips now, before any lane
    //   edits, through the same persisted freeze a held pass's release uses;
    // - any other bust (flush, pressure, subagent execute) strips
    //   at the end of the pass through the proactive strip, only if one of its
    //   edits lies before newer thinking, so a bust with nothing to apply keeps
    //   the turn's thinking.
    let unheldSignedTurnBust = false;
    if (
        isCacheBustingPass &&
        !activeThinkingPrefixHold &&
        activeThinkingTurn &&
        args.thinkingBindingRecoveryEnabledForModel === true
    ) {
        if (
            foldBustsServedPrefixThisPass ||
            firstRenderBust ||
            publishedM1RefreshedThisPass ||
            hostCheckpointRide ||
            releasedFrozenHeadChanged
        )
            releaseThinkingForRewrite();
        else {
            unheldSignedTurnBust = true;
            retainedThinking.clear();
            protectedThinkingMessages.clear();
            newTargets = args.targets;
        }
    }
    // Recovery tags and first-time sentinel omissions in served history may
    // ride only a proven earlier request change: changed memory/docs (m[0]) or
    // history (m[1]) bytes, or an executed system-prompt, model/provider or tool-
    // definition fold. A later conversation repair cannot move its first edit
    // backwards. Sessions rendering no history head instead normalize on
    // scheduler execution, a pressure-driven rebuild or explicit flush; an
    // otherwise deferred repair does not qualify. Their rewrite may then start
    // at the oldest recovered reply.
    const recoveryHasHistoryHead =
        m0M1EnabledForFold || (args.pendingCompartmentInjection?.compartmentCount ?? 0) > 0;
    const recoveryHeadChangedThisPass =
        !prefixPreflightFailed &&
        (foldChangesHeadThisPass ||
            hostCheckpointRide ||
            (!firstRenderBust && publishedM1RefreshedThisPass) ||
            (!m0M1EnabledForFold && legacyPublishedHeadChanged(args)));
    const recoveryHeadlessRebuild =
        !recoveryHasHistoryHead &&
        (args.schedulerDecision === "execute" ||
            isExplicitFlush ||
            forceMaterialization ||
            emergencyDropEligible);
    const recoveredShapeRewriteProof = recoveryHeadChangedThisPass
        ? "head_bytes"
        : (recoveryExternalFoldCause ?? (recoveryHeadlessRebuild ? "headless_rebuild" : null));
    const canNormalizeRecoveredShape =
        isCacheBustingPass && !activeThinkingPrefixHold && recoveredShapeRewriteProof !== null;
    sessionLog(
        args.sessionId,
        `rewrite permission: allowed=${isCacheBustingPass} ${reclaimRideLabel(rideSignals)} served_shape_repair=${servedShapeRepair.needsRebuild} signed_prefix_release=${rewritingSignedPrefix} fold_prefix_loss=${foldBustsServedPrefixThisPass} first_render=${firstRenderBust} cache_expired=${args.m0M1?.hardSignals?.cacheExpired === true} thinking_hold=${activeThinkingPrefixHold} recovery_has_head=${recoveryHasHistoryHead} recovery_head_changed=${recoveryHeadChangedThisPass} recovery_headless_rebuild=${recoveryHeadlessRebuild} proven_external_fold=${recoveryExternalFoldCause ?? "none"} recovered_shape_proof=${recoveredShapeRewriteProof ?? "none"}`,
    );
    let recoveryTailNormalizedThisPass = false;
    if (args.normalizeRecoveryTail && canNormalizeRecoveredShape) {
        args.normalizeRecoveryTail();
        recoveryTailNormalizedThisPass = true;
        args.tags = getTagsBySession(args.db, args.sessionId);
        newTargets = protectTargets();
    }
    if (
        freezeM0M1 &&
        materializationRequested &&
        (m0M1EnabledForFold ||
            pendingOps.some((op) => newTargets.get(op.tagId)?.thinkingDropProtected))
    )
        parkedTriggers?.holdMaterialization(pendingOrigin);
    if (freezeM0M1 && rideSignals.force && shouldRunHeuristics) parkedTriggers?.holdForce();
    const reclaimDistance = isCacheBustingPass
        ? toolReclaimDistanceEntries(args.messages, args.targets)
        : [];
    const canEditWholePrefix = isCacheBustingPass && !activeThinkingPrefixHold;
    const previousTemporalDecisions =
        args.temporalCandidates && !compactionOff
            ? new Map([
                  ...(args.temporalObservedDecisions ?? []),
                  ...getTemporalDecisions(
                      args.db,
                      args.sessionId,
                      args.temporalReplayIds ?? args.temporalCandidates.keys(),
                  ),
              ])
            : undefined;
    const admittedTemporalCandidates =
        args.temporalCandidates && isCacheBustingPass && !compactionOff
            ? admitTemporalCandidates({
                  candidates: args.temporalCandidates,
                  frozen: previousTemporalDecisions ?? new Map(),
                  admission: editAdmission,
                  locations: args.messages.map((message) => ({
                      id: message.info.id,
                      block: message.parts.findIndex((part) => {
                          if (!part || typeof part !== "object") return false;
                          const text = part as { type?: string; ignored?: boolean; text?: unknown };
                          return (
                              text.type === "text" &&
                              text.ignored !== true &&
                              typeof text.text === "string"
                          );
                      }),
                  })),
                  onHeld: (ids) => {
                      if (editAdmission.frame.kind === "boundary")
                          sessionLog(
                              args.sessionId,
                              `edit admission: held lane=temporal marker first application coords=${ids.join(",")} boundary=${editAdmission.frame.messageId ?? "<unresolved>"} held_edits=${ids.length}`,
                          );
                  },
              })
            : new Map<string, string>();
    const temporalFirstApplications: { message: MessageLike; block: number }[] = [];
    const temporalDecisions = (() => {
        const edit = () => {
            const decisions =
                args.temporalCandidates && !compactionOff
                    ? isCacheBustingPass
                        ? new Map([
                              ...(previousTemporalDecisions ?? []),
                              ...freezeTemporalDecisions(
                                  args.db,
                                  args.sessionId,
                                  admittedTemporalCandidates,
                              ),
                          ])
                        : previousTemporalDecisions
                    : undefined;
            if (decisions)
                injectTemporalMarkers(args.messages, decisions, (raw, block) => {
                    const message = raw as MessageLike;
                    if (message.info.id && admittedTemporalCandidates.get(message.info.id))
                        temporalFirstApplications.push({ message, block });
                });
            return decisions;
        };
        return args.thinkingBindingRecoveryEnabledForModel && !activeThinkingPrefixHold
            ? pairedThinkingEdit({
                  db: args.db,
                  messages: args.messages,
                  edit,
                  needsCompanion: () =>
                      temporalFirstApplications.some(({ message, block }) =>
                          precedesCompanionThinking(message, block),
                      ),
                  persistCompanion,
              })
            : edit();
    })();
    // A permission deny known before the first freeze already made the verdict
    // "unavailable" (see primeCtxReduceSpawnPermission). A deny added after the
    // freeze cannot flip it without rewriting the cached prefix, so observe the
    // live permission signal on the same busts and only log that guidance may be
    // stale until the session restarts. This log never changes the wire, so the
    // read runs in the background: awaiting its two OpenCode API round trips
    // inline once held a busting pass for 14 seconds on a loaded host.
    if (
        isCacheBustingPass &&
        args.client &&
        args.ctxReduceAvailability.callable &&
        !hasLoggedCtxReducePermissionDeny(args.sessionId)
    ) {
        void observeCtxReducePermissionDeny(args.client, args.sessionId, args.activeAgent);
    }
    const canUseEmptySentinels = modelAcceptsEmptyContent(args.resolvedProviderID);
    // Whole-part reasoning removal serves every provider except canonical
    // Anthropic, which keeps its "[cleared]" + empty-sentinel lane unchanged.
    // The persisted set is read on every pass so defer passes replay it.
    // An unresolved provider never selects: the session may be canonical
    // Anthropic, whose later passes would not replay the ids. It still replays
    // ids an earlier, resolved pass froze.
    // Prefix-bound models (Fable 5.1, Opus 5.5, Sonnet 5.5) use this lane on
    // canonical Anthropic too: it removes only a contiguous oldest prefix, which
    // leaves every newer signed block valid, while the "[cleared]" watermark
    // lane below skips ineligible messages and could leave a gap.
    const prefixBoundModel = args.thinkingBindingRecoveryEnabledForModel === true;
    const reasoningRemovalEnabled = (!canUseEmptySentinels || prefixBoundModel) && !compactionOff;
    const reasoningRemovalSelectable =
        reasoningRemovalEnabled && typeof args.resolvedProviderID === "string";
    const removedReasoningIds = new Set<string>();
    let dropLeavesReasoning = false;
    let reasoningRemovalReadable = false;
    const refreshReasoningRemovalUnion = (): void => {
        if (compactionOff) return;
        try {
            if (reasoningRemovalEnabled) {
                const committed = getReasoningRemovalState(args.db, args.sessionId);
                for (const id of committed.messageIds) removedReasoningIds.add(id);
                dropLeavesReasoning = committed.dropLeavesReasoning;
            }
            const committedWatermark = args.db
                .prepare(
                    "SELECT cleared_reasoning_through_tag AS watermark, last_observed_model_key AS modelKey FROM session_meta WHERE session_id=?",
                )
                .get(args.sessionId) as { watermark: number; modelKey: string | null } | null;
            // A model transition intentionally resets the watermark. Never mix
            // its older epoch into this pass's tagged/prepared input.
            if (
                committedWatermark &&
                committedWatermark.modelKey === args.sessionMeta.lastObservedModelKey
            ) {
                args.sessionMeta.clearedReasoningThroughTag = Math.max(
                    args.sessionMeta.clearedReasoningThroughTag,
                    committedWatermark.watermark,
                );
                if (!prefixBoundModel) {
                    if (canUseEmptySentinels)
                        replayClearedReasoning(
                            args.messages,
                            args.reasoningByMessage,
                            args.messageTagNumbers,
                            args.sessionMeta.clearedReasoningThroughTag,
                        );
                    replayStrippedInlineThinking(
                        args.messages,
                        args.messageTagNumbers,
                        args.sessionMeta.clearedReasoningThroughTag,
                    );
                }
            }
        } catch (error) {
            failPass("reasoning-removal-read-failure", error);
            throw new EmergencyFailClosedError("Saved reasoning removals could not be refreshed", {
                cause: error,
            });
        }
    };
    const replayCommittedVisibleDrops = (): boolean => {
        if (compactionOff) return false;
        const visible = new Set(args.messages);
        const targets = new Map(
            [...args.targets].filter(([, target]) => {
                if (target.mutationParts)
                    return target.mutationParts.some(
                        ({ message, part }) =>
                            visible.has(message) &&
                            message.info.syntheticHead !== true &&
                            message.parts.includes(part) &&
                            (!isRecord(part) || part.synthetic !== true),
                    );
                return (
                    target.message !== undefined &&
                    visible.has(target.message) &&
                    target.message.info.syntheticHead !== true
                );
            }),
        );
        // History preparation may reuse a host text object for a synthetic
        // prefix. A persisted drop of the former raw part must not erase it.
        return applyFlushedStatuses(args.sessionId, args.db, targets);
    };
    if (reasoningRemovalEnabled) {
        try {
            const state = getReasoningRemovalState(args.db, args.sessionId);
            for (const id of state.messageIds) removedReasoningIds.add(id);
            dropLeavesReasoning = state.dropLeavesReasoning;
            reasoningRemovalReadable = true;
        } catch (error) {
            // Neither the persisted set nor its backup copy can be read. Serving
            // no removals would bring removed reasoning back on what may be a
            // defer pass, so the pass fails closed instead.
            args.passOutcome?.record("reasoning-removal-read-failure");
            sessionLog(
                args.sessionId,
                "reasoning removal: persisted state and backup unreadable; failing the pass closed:",
                error,
            );
            throw new EmergencyFailClosedError(
                "Magic Context could not read its saved reasoning-removal state for this session",
                { cause: error },
            );
        }
    }
    const heuristicsLogChanged = diagnosticStateChanged(
        args.sessionId,
        "heuristics",
        JSON.stringify([
            args.currentTurnId,
            shouldRunHeuristics,
            shouldRunHeuristics ? null : args.schedulerDeferReason,
        ]),
    );
    const pendingLogChanged = diagnosticStateChanged(
        args.sessionId,
        "pending-ops",
        JSON.stringify([
            args.currentTurnId,
            shouldApplyPendingOps,
            shouldApplyPendingOps ? null : args.schedulerDeferReason,
            shouldApplyPendingOps ? null : (getPendingOpsCount(args.db, args.sessionId) ?? 0) > 0,
        ]),
    );
    if (shouldRunHeuristics) {
        const subagentRerun =
            !args.fullFeatureMode &&
            alreadyRanThisTurn &&
            args.schedulerDecision === "execute" &&
            !isExplicitFlush &&
            !forceMaterialization;
        const reason = isExplicitFlush
            ? `pending_materialization origin=${pendingOrigin}`
            : deferredMaterialize
              ? "deferred_materialization"
              : forceMaterialization
                ? `force_materialization (${args.contextUsage.percentage.toFixed(1)}% >= ${args.forceMaterializationPercentage}%)`
                : foldBustsServedPrefixThisPass && args.schedulerDecision !== "execute"
                  ? `m0_hard_fold (drain folded into executed m[0] bust, scheduler=${args.schedulerDecision})`
                  : subagentRerun
                    ? `${reclaimRideLabel(rideSignals)} subagent_rerun (pendingOps=${pendingOps.length}, scheduler=${args.schedulerDecision})`
                    : `${reclaimRideLabel(rideSignals)} (pendingOps=${pendingOps.length}, scheduler=${args.schedulerDecision})`;
        sessionLog(
            args.sessionId,
            `heuristics WILL RUN — reason=${reason}, context=${args.contextUsage.percentage.toFixed(1)}%, turn=${args.currentTurnId}`,
        );
    } else if (
        heuristicsLogChanged &&
        args.schedulerDeferReason !== undefined &&
        args.schedulerDeferReason !== null
    ) {
        sessionLog(args.sessionId, `heuristics WILL NOT RUN — reason=${args.schedulerDeferReason}`);
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
    if (
        !shouldApplyPendingOps &&
        pendingLogChanged &&
        args.schedulerDeferReason !== undefined &&
        args.schedulerDeferReason !== null
    ) {
        sessionLog(
            args.sessionId,
            `pending ops WILL NOT APPLY — reason=${args.schedulerDeferReason} pendingOps=${formatPendingOpsDepth()} context=${args.contextUsage.percentage.toFixed(1)}%`,
        );
    }
    if (hasPendingUserOps && !shouldApplyPendingOps) {
        sessionLog(
            args.sessionId,
            `pending ops held — reason=no originating cache-bust opportunity; scheduler=${args.schedulerDecision}, historianRunning=${compartmentRunning}`,
        );
    }
    let explicitMaterializedSuccessfully = false;
    let deferredMaterializedSuccessfully = false;
    let pendingOpsDidMutate = false;
    // First application is an edit; restoring the same frozen choice from raw
    // history is replay. Telemetry and signed-thinking invalidation consume the
    // same edit record so a strip cannot silently escape either accounting lane.
    const firstApplicationEdits = { any: false, beforeNewerThinking: false };
    const recordFirstApplicationWireEdit = (beforeNewerThinking: boolean): void => {
        firstApplicationEdits.any = true;
        firstApplicationEdits.beforeNewerThinking ||= beforeNewerThinking;
    };
    if (servedShapeRepair.needsRebuild) recordFirstApplicationWireEdit(true);
    const firstApplicationLocations = new Map<MessageLike, number>();
    const recordFirstApplicationAt = (message: MessageLike, partIndex: number): void => {
        recordFirstApplicationWireEdit(false);
        firstApplicationLocations.set(
            message,
            Math.min(firstApplicationLocations.get(message) ?? Infinity, partIndex),
        );
    };
    // Capture coordinates before reductions can splice their owning messages.
    // A tail-only drop must not pay for stripping older, still-valid thinking.
    const sourceOrder = new Map(
        (prefixBoundModel ? args.messages : []).map((message, index) => [message, index]),
    );
    let lastThinking: { message: number; part: number } | undefined;
    for (const [messageIndex, message] of (prefixBoundModel ? args.messages : []).entries()) {
        if (message.info.role !== "assistant") continue;
        for (const [partIndex, part] of message.parts.entries()) {
            if (
                isRecord(part) &&
                companionKept.has(part) &&
                part.ignored !== true &&
                (part.type === "reasoning" ||
                    part.type === "thinking" ||
                    part.type === "redacted_thinking")
            )
                lastThinking = { message: messageIndex, part: partIndex };
        }
    }
    const tagEditBeforeThinking = new Map<number, boolean>();
    for (const [tag, target] of args.targets) {
        const locations =
            target.mutationParts ??
            (target.message ? [{ message: target.message, part: target.message.parts[0] }] : []);
        tagEditBeforeThinking.set(
            tag,
            locations.length === 0 ||
                locations.some(({ message, part }) => {
                    const index = sourceOrder.get(message);
                    const partIndex = message.parts.indexOf(part);
                    return (
                        index === undefined ||
                        partIndex < 0 ||
                        (!!lastThinking &&
                            (index < lastThinking.message ||
                                (index === lastThinking.message && partIndex <= lastThinking.part)))
                    );
                }),
        );
    }
    const firstEditPrecedesThinking = (): boolean =>
        firstApplicationEdits.beforeNewerThinking ||
        [...firstApplicationLocations].some(([message, part]) => {
            const index = sourceOrder.get(message);
            return (
                index !== undefined &&
                !!lastThinking &&
                (index < lastThinking.message ||
                    (index === lastThinking.message && part <= lastThinking.part))
            );
        }) ||
        droppedTokenReductions.some(
            (reduction) => tagEditBeforeThinking.get(reduction.tagNumber) ?? true,
        );
    const pair = <T>(
        edit: () => T,
        needs: (result: T) => boolean = firstEditPrecedesThinking,
    ): T => {
        if (!prefixBoundModel || activeThinkingPrefixHold) return edit();
        // Earlier lanes may already have committed every required omission.
        // Their edit remains durable if a later lane fails, so replay and final
        // representation need no companion writer of their own in that case.
        const committed = getMergedReasoningStrippedIds(args.db, args.sessionId);
        if (
            [...companionTargets].every(
                (id) => id && committed.has(thinkingBindingRecoveryFrozenId(id)),
            )
        )
            return edit();
        const restore = [
            snapshotPendingMaterialization(args.pendingMaterializationSessions, args.sessionId),
            snapshotPendingMaterialization(args.deferredMaterializationSessions, args.sessionId),
            snapshotSessionFlag(args.deferredHistoryRefreshSessions, args.sessionId),
            snapshotSessionValue(args.lastHeuristicsTurnId, args.sessionId),
            snapshotRoutinePressureEpisode(args.sessionId),
        ];
        return pairedThinkingEdit({
            db: args.db,
            messages: args.messages,
            state: args.sessionMeta,
            edit,
            needsCompanion: needs,
            persistCompanion,
            onRollback: () => {
                for (const reset of restore) reset();
                parkedBustTriggersBySession.delete(args.sessionId);
                clearInjectionCache(args.sessionId);
            },
        });
    };
    for (const { message, block } of temporalFirstApplications)
        recordFirstApplicationAt(message, block);
    // OpenCode 2 instruction rows are served even once the history summary
    // covers them; the delivery trim below already keeps every one still in
    // the array. The switch that extends this to the earlier trims is turned
    // on by the first pass that may rewrite the whole prefix
    // (canEditWholePrefix), so a session served before it never changes bytes
    // on any other pass. Every pass after that serves the same rows, whichever
    // pass moved the history boundary. Decided before the host-row reclaim,
    // which applies instruction supersession to the covered rows this pass
    // serves as well; the switch itself is persisted once the pass's
    // signed-thinking omissions are durable (next to the reclaim's commit).
    const coveredHostInstructions = args.coveredHostInstructions ?? [];
    let coveredRetentionOn = false;
    let retainCoveredInstructions = false;
    if (
        m0M1EnabledForFold &&
        args.m0M1 &&
        !compactionOff &&
        args.opencode2 &&
        (coveredHostInstructions.length > 0 || canEditWholePrefix) &&
        hostInstructionRetentionEnabled()
    ) {
        try {
            coveredRetentionOn = isHostInstructionRetentionOn(args.db, args.sessionId);
        } catch (error) {
            failPass("host-instruction-retention-read-failure", error);
        }
        retainCoveredInstructions = coveredRetentionOn || canEditWholePrefix;
    }
    // Instruction rows retire only where the whole prefix may be rewritten. A
    // pass held for recent signed thinking may still rebuild once context
    // usage reaches the force band (the forced-rebuild range just below the
    // hold cap), but every byte in front of the held block must stay as it
    // was, so such a pass only replays decisions already persisted.
    const hostRowReclaim = args.reclaimHostRows?.(
        args.sessionId,
        args.messages,
        !compactionOff && canEditWholePrefix,
        retainCoveredInstructions ? coveredHostInstructions : [],
    );
    for (const message of hostRowReclaim?.edits ?? []) {
        const index = args.messages.indexOf(message);
        recordFirstApplicationWireEdit(
            index < 0 ||
                servesThinkingBlock(
                    args.messages.slice(index + 1),
                    args.resolvedProviderID,
                    args.resolvedModelID,
                ),
        );
    }
    let heuristicOrReasoningDidMutate = false;
    let droppedCount = 0;
    let droppedTokens = 0;
    const droppedTokenReductions: DroppedTokenReduction[] = [];
    let emergencyReclaimedTokens = 0;
    let emergency = false;
    let m0M1InjectedThisPass = false;
    let deliveredPrefix: InjectM0M1Result | undefined;
    let prependedMessageCount = 0;
    const reasoningMutatedMessages = new Set<MessageLike>();
    let reasoningMutationTargetUnknown = false;
    if (convertedToolSkeletonsDidMutate) {
        for (const tagNumber of convertedToolSkeletons.keys()) {
            const message = args.targets.get(tagNumber)?.message;
            if (message) reasoningMutatedMessages.add(message);
            else reasoningMutationTargetUnknown = true;
        }
    }
    if (args.didMutateFromFlushedStatuses) {
        for (const target of args.targets.values()) {
            if (target.message) reasoningMutatedMessages.add(target.message);
            else reasoningMutationTargetUnknown = true;
        }
    }
    let autoReclaimDidMutateThisPass = false;
    // Pending-op read, temporal decisions, the background permission observer
    // start and the reasoning-removal read.
    logTransformTiming(
        args.sessionId,
        "pp.passDecisions",
        tPassDecisions,
        `pendingOps=${pendingOps.length}`,
    );
    // A host system-prompt change already rewrote the bytes before every kept
    // thinking block. Outside a current-turn boundary on a model whose thinking
    // is prefix-bound, strip older thinking with it; a failed strip refuses the
    // pass and keeps the record. Other passes leave the record for a later one,
    // since thinking signed before the change may be served again after a
    // switch back to a prefix-bound model.
    if (
        hasSystemPromptEdit(args.pendingMaterializationSessions, args.sessionId) &&
        !activeThinkingPrefixHold &&
        companionEnabled
    ) {
        pair(
            () => true,
            (edited) => edited,
        );
        clearSystemPromptEdit(args.pendingMaterializationSessions, args.sessionId);
    }
    try {
        const applyPending = () =>
            applyPendingOperations(
                args.sessionId,
                args.db,
                newTargets,
                new Set([
                    ...(args.contextUsage.percentage >= 95 ? [] : args.protectedTagIds),
                    ...protectedToolTags,
                ]),
                undefined,
                pendingOps,
                [],
                new Set(),
                (reduction) => droppedTokenReductions.push(reduction),
                undefined,
                args.onPendingDropEligibility,
            );
        // Read the queue depth before the early commit below empties it, so the
        // decision log reports how many queued operations this pass applies.
        const pendingOpsDepthAtDecision = shouldApplyPendingOps
            ? formatPendingOpsDepth()
            : undefined;
        // Commit queued edits with their omissions before session-wide heuristic
        // discovery; the latter must not extend the queued edit's write hold.
        const preparedPending =
            shouldApplyPendingOps && pendingOps.length > 0 ? pair(applyPending) : undefined;
        pair(() => {
            if (shouldApplyPendingOps) {
                const applyReason = isExplicitFlush
                    ? `pending_materialization origin=${pendingOrigin}`
                    : deferredMaterialize
                      ? "deferred_materialization"
                      : foldBustsServedPrefixThisPass && args.schedulerDecision !== "execute"
                        ? `m0_hard_fold (drain folded into executed m[0] bust, scheduler=${args.schedulerDecision})`
                        : `${reclaimRideLabel(rideSignals)} (scheduler=${args.schedulerDecision})`;
                sessionLog(
                    args.sessionId,
                    `pending ops WILL APPLY — reason=${applyReason}, pendingOps=${pendingOpsDepthAtDecision}, context=${args.contextUsage.percentage.toFixed(1)}%`,
                );
                const tApply = performance.now();
                // P0 perf: don't pass `args.tags` here. applyPendingOperations
                // needs every status of the operations' own tags (dropped and
                // compacted rows mark ops that are already processed), but the
                // upstream `args.tags` is active-only. It loads just those rows
                // and the newest-tool skeleton window inside its own write
                // transaction, so the reads and the mutations see one snapshot.
                pendingOpsDidMutate = preparedPending ?? applyPending();
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
                          wordRules: args.cavemanTextCompression.wordRules,
                      }
                    : undefined;
                const heuristicTags = shouldApplyPendingOps
                    ? getActiveTagsBySession(args.db, args.sessionId)
                    : args.tags;
                // A rewrite this pass already pays for, as in Pi: newly applied drops,
                // a fold that busts the served prefix, or a rebuilt history
                // injection. It rearms the emergency episode, admits the routine
                // lanes, and waives the emergency minimum. Replaying persisted drop
                // statuses restores bytes already served on every pass, so it never
                // counts (otherwise any session holding a drop would rearm the
                // episode and lift the minimum on every pass).
                const rewriteAlreadyPriced = emergencyRewriteAlreadyPriced({
                    pendingOpsDidMutate,
                    foldBustsServedPrefix: foldBustsServedPrefixThisPass,
                    firstRenderBust,
                    hostCheckpointHead: hostCheckpointRide,
                    historyRebuiltThisPass: args.historyRebuiltThisPass === true,
                    compartmentInjectionRebuiltFromDb:
                        args.compartmentInjectionRebuiltFromDb === true,
                    rebuiltHistoryFromInitialPrepare:
                        args.rebuiltHistoryFromInitialPrepare === true,
                });
                // An independent mutation is already pricing this pass. Rearm the
                // emergency batch so all candidates accumulated during sustained
                // force pressure can ride it instead of waiting for another episode.
                if (
                    emergencyEpisodeRearms({
                        forceBandConfirmed,
                        rewriteAlreadyPriced,
                        emergencyInputSample: () =>
                            getEmergencyInputSample(args.db, args.sessionId),
                    })
                ) {
                    clearEmergencyDropSample(args.db, args.sessionId);
                }
                // Force-originated tool and text rewrites share the durable episode.
                // A small pressure dip or a process restart cannot rearm just the text lane.
                // Independent work and the absolute emergency arm still admit all lanes.
                let routineCleanupApplied = routineCleanupAdmitted({
                    forceBandConfirmed,
                    contextPercentage: args.contextUsage.percentage,
                    emergencyInputSample: () => getEmergencyInputSample(args.db, args.sessionId),
                    fullFeatureMode: args.fullFeatureMode,
                    routinePressureAlreadyApplied: routinePressureApplied,
                    materializationRequested,
                    rewriteAlreadyPriced,
                });
                // Pending ops run just before heuristics and can drop active tags.
                // Emergency floor math must see that post-op active set; otherwise
                // already-reclaimed tags stay in floorTags and the planner over-evicts.
                let cleanup = applyHeuristicCleanup(
                    args.sessionId,
                    args.db,
                    newTargets,
                    args.messageTagNumbers,
                    {
                        protectedTagNumbers: args.protectedTagNumbers,
                        protectedCutoff: args.protectedCutoff,
                        protectedToolTags,
                        // Tiered emergency drop fires only at the derived force band (both primary and
                        // subagent) AND only when the ceiling is known. Undefined
                        // ceiling (cold start) or below-threshold usage → no
                        // emergency arg → routine pass does dedup/injection-strip
                        // only (Phase 2 removed need-blind routine tool drops).
                        // A reading that only a local count put in the band runs
                        // it only at 95% or more (see `forceBandConfirmed`).
                        emergency:
                            forceBandConfirmed &&
                            args.emergencyCeilingTokens !== undefined &&
                            args.emergencyCeilingTokens > 0
                                ? {
                                      currentTotalInputTokens: args.contextUsage.inputTokens,
                                      ceilingTokens: args.emergencyCeilingTokens,
                                      usagePercentage: args.contextUsage.percentage,
                                      passAlreadyPriced: rewriteAlreadyPriced,
                                  }
                                : undefined,
                        routine: routineCleanupApplied,
                        caveman: cavemanConfig,
                    },
                    heuristicTags,
                );
                if (!routineCleanupApplied && cleanup.emergencyDroppedTools > 0) {
                    // The emergency selector just created the episode's one pressure
                    // bust. Drain the routine lanes into that same pass, then keep them
                    // frozen on later force-band passes.
                    const ridingCleanup = applyHeuristicCleanup(
                        args.sessionId,
                        args.db,
                        newTargets,
                        args.messageTagNumbers,
                        {
                            protectedTagNumbers: args.protectedTagNumbers,
                            protectedCutoff: args.protectedCutoff,
                            protectedToolTags,
                            routine: true,
                            caveman: cavemanConfig,
                        },
                        getActiveTagsBySession(args.db, args.sessionId),
                    );
                    cleanup = {
                        droppedTools: cleanup.droppedTools + ridingCleanup.droppedTools,
                        deduplicatedTools:
                            cleanup.deduplicatedTools + ridingCleanup.deduplicatedTools,
                        droppedInjections:
                            cleanup.droppedInjections + ridingCleanup.droppedInjections,
                        emergencyDroppedTools: cleanup.emergencyDroppedTools,
                        emergencyReclaimedTokens: cleanup.emergencyReclaimedTokens,
                        compressedTextTags:
                            cleanup.compressedTextTags + ridingCleanup.compressedTextTags,
                        mutatedTextTags: cleanup.mutatedTextTags + ridingCleanup.mutatedTextTags,
                        droppedTokenReductions: [
                            ...cleanup.droppedTokenReductions,
                            ...ridingCleanup.droppedTokenReductions,
                        ],
                    };
                    routineCleanupApplied = true;
                }
                if (routineCleanupApplied && args.fullFeatureMode && executePressureEligible) {
                    markRoutinePressureApplied(args.sessionId);
                }
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
                droppedTokenReductions.push(...cleanup.droppedTokenReductions);
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
                // Prefix-bound models never partially remove reasoning: removing
                // an older block invalidates kept newer signatures. A true prefix
                // rewrite takes the all-thinking binding strip instead.
                const ageLaneAllowed = !prefixBoundModel;
                const bindingStrippedIds = new Set<string>();
                if (routineCleanupApplied && prefixBoundModel) {
                    for (const id of getMergedReasoningStrippedIds(args.db, args.sessionId)) {
                        if (id.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX)) {
                            bindingStrippedIds.add(
                                id.slice(THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length),
                            );
                        }
                    }
                }
                const reasoningEstimates = tryGetReasoningTokenEstimatesByMessage(
                    args.db,
                    args.sessionId,
                    sessionDecisionCalibration(args.db, args.sessionId).proseRatio,
                );
                const budgetCutoff =
                    routineCleanupApplied && !activeThinkingPrefixHold && reasoningEstimates
                        ? Math.min(
                              safeReasoningCutoff,
                              opencodeReasoningBudgetCutoff({
                                  messages: args.messages,
                                  messageTagNumbers: args.messageTagNumbers,
                                  budget: args.keepReasoningTokens ?? DEFAULT_KEEP_REASONING_TOKENS,
                                  alreadyRemoved: removedReasoningIds,
                                  alsoGone: bindingStrippedIds,
                                  countNeutralized: reasoningRemovalSelectable,
                                  proseRatio: sessionDecisionCalibration(args.db, args.sessionId)
                                      .proseRatio,
                                  frozenMergedIds: getMergedReasoningStrippedIds(
                                      args.db,
                                      args.sessionId,
                                  ),
                                  anthropic:
                                      canUseEmptySentinels ||
                                      prefixBoundModel ||
                                      hasAnthropicReasoning(args.messages),
                                  textEstimateByMessageId: reasoningEstimates,
                              }),
                          )
                        : 0;
                const clearedReasoning =
                    routineCleanupApplied && canUseEmptySentinels && ageLaneAllowed
                        ? clearOldReasoning(
                              args.messages,
                              args.reasoningByMessage,
                              args.messageTagNumbers,
                              budgetCutoff,
                          )
                        : 0;
                if (routineCleanupApplied && canUseEmptySentinels) {
                    stripClearedReasoning(args.messages);
                }
                // The inline strip advances the same watermark that replayClearedReasoning
                // replays into typed reasoning on every later pass, so on prefix-bound
                // models it stays off too (Pi caps both lanes with one cutoff).
                const strippedInline =
                    routineCleanupApplied && ageLaneAllowed
                        ? stripInlineThinking(
                              args.messages,
                              args.messageTagNumbers,
                              budgetCutoff,
                              !canUseEmptySentinels,
                          )
                        : 0;
                // Fresh caveman compression above rebuilds text from its original source,
                // which brings back inline thinking that the replay at the start of this
                // pass removed. The fresh strip only reaches this pass's age cutoff (and
                // is off on prefix-bound models), while every later pass replays up to
                // the persisted watermark. Strip up to that watermark again so this pass
                // serves the bytes the next deferred pass will replay. Not counted as a
                // new edit: it only restores what replay already removed.
                const persistedInlineWatermark = args.sessionMeta?.clearedReasoningThroughTag ?? 0;
                if (routineCleanupApplied && persistedInlineWatermark > 0 && !compactionOff) {
                    replayStrippedInlineThinking(
                        args.messages,
                        args.messageTagNumbers,
                        persistedInlineWatermark,
                        !canUseEmptySentinels,
                    );
                }
                servedShapeRepair.apply(isCacheBustingPass);
                // Every other provider removes whole reasoning parts instead. New ids
                // are chosen only here, on the same rebuilding pass as the lane above,
                // and persisted before final representation applies them; a failed
                // write applies nothing new and replays only the earlier set.
                let removedReasoningMessages = 0;
                if (
                    routineCleanupApplied &&
                    !prefixBoundModel &&
                    reasoningRemovalSelectable &&
                    reasoningRemovalReadable
                ) {
                    // The binding-mismatch set holds assistants whose reasoning an
                    // earlier strip already took off the wire; the prefix walk
                    // passes over them instead of stopping there.
                    const newIds = selectReasoningRemovals({
                        messages: args.messages,
                        messageTagNumbers: args.messageTagNumbers,
                        cutoff: budgetCutoff,
                        alreadyRemoved: removedReasoningIds,
                        prefixBound: prefixBoundModel,
                        alsoGone: bindingStrippedIds,
                        protectedMessages: protectedThinkingMessages,
                    });
                    if (newIds.length > 0) {
                        let persisted = false;
                        try {
                            persisted = addRemovedReasoningIds(args.db, args.sessionId, newIds);
                        } catch (error) {
                            sessionLog(
                                args.sessionId,
                                "reasoning removal: persistence threw:",
                                error,
                            );
                            failPass("reasoning-removal-persistence-failure", error);
                        }
                        if (persisted) {
                            for (const id of newIds) removedReasoningIds.add(id);
                            // Serve the committed union: another process may have added
                            // ids between this pass's read and its compare-and-swap.
                            try {
                                const committed = getReasoningRemovalState(args.db, args.sessionId);
                                for (const id of committed.messageIds) removedReasoningIds.add(id);
                            } catch (error) {
                                sessionLog(
                                    args.sessionId,
                                    "reasoning removal: committed set re-read failed:",
                                    error,
                                );
                                failPass("reasoning-removal-read-failure", error);
                            }
                            removedReasoningMessages = newIds.length;
                            sessionLog(
                                args.sessionId,
                                `reasoning removal: froze ${newIds.length} assistant(s), total=${removedReasoningIds.size}`,
                            );
                        } else {
                            failPass("reasoning-removal-persistence-failure");
                            sessionLog(
                                args.sessionId,
                                "reasoning removal: persistence failed; serving the earlier set only",
                            );
                        }
                    }
                }
                if (clearedReasoning > 0 || strippedInline > 0) {
                    // Compute and persist the reasoning watermark so future defer passes
                    // can replay the same clearing without re-computing the cutoff.
                    const newWatermark = budgetCutoff;
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
                    heuristicMutationCount +
                        clearedReasoning +
                        strippedInline +
                        removedReasoningMessages >
                    0;
                droppedCount += clearedReasoning + strippedInline + removedReasoningMessages;
                // ── Drain pendingMaterializationSessions ──
                // Heuristics + materialization successfully ran on this pass.
                // We've fulfilled every reason the set was added (user
                // /ctx-flush, variant change, system-prompt hash change,
                // historian publish), so clear the persistent signal. If
                // compartmentRunning had blocked us above, this drain is
                // intentionally NOT reached — the flag survives so the next
                // safe pass picks up the work.
                // Keep the request when kept signed thinking prevents rebuilding the synthetic
                // history head or applying a queued message drop. Subagents have no history
                // head, so an empty request has no remaining work and must be consumed.
                if (
                    pendingMaterializationAtPassStart &&
                    !(freezeM0M1 && (!holdEnabled || m0M1EnabledForFold)) &&
                    !pendingOps.some((op) => newTargets.get(op.tagId)?.thinkingDropProtected)
                ) {
                    clearPendingMaterialization(
                        args.pendingMaterializationSessions,
                        args.sessionId,
                    );
                }
                if (args.currentTurnId) {
                    args.lastHeuristicsTurnId.set(args.sessionId, args.currentTurnId);
                }
            }
            // A prepared request has not refreshed the provider cache. In particular,
            // an aborted request may never report usage. Keep the response clock until
            // the provider answers. An expired retry then replays the same bytes: an
            // expired provider cache grants no fold of its own.

            // Consume only after the shared tool/text batch actually changed bytes.
            // A local count below 95% ran no emergency batch (see
            // `forceBandConfirmed`), so it leaves the episode unconsumed.
            if (forceBandConfirmed && (pendingOpsDidMutate || heuristicOrReasoningDidMutate)) {
                setEmergencyDropSample(args.db, args.sessionId, args.contextUsage.inputTokens);
            }
            const toolReclaimApplicationOpportunity = isCacheBustingPass;
            let autoReclaimTargetCount = 0;
            let autoReclaimDidMutate = false;
            if (passDecision.toolReclaimAdmitted) {
                const tReclaimSelect = performance.now();
                const syntheticPendingOps = buildSyntheticToolReclaimOps({
                    db: args.db,
                    sessionId: args.sessionId,
                    targets: newTargets,
                    watermark: args.sessionMeta.toolReclaimWatermark ?? 0,
                    protectedToolTags,
                    pendingOps,
                });
                // Smart-drops: reclaim spent control-plane outputs that a later
                // call supersedes (older todowrite/ctx_reduce/meta), and compress
                // superseded edits to an edit_marker (keep filePath + region hint).
                // Merged into the same gated apply as the age-based sweep. Dedupe
                // against those ops (a tag can qualify under more than one rule).
                // The newest 20 owner messages remain untouched, matching the module
                // lane's continuation floor independently of the token-mass protection window.
                const editMarkerTagIds = new Set<number>();
                {
                    const recentMessageIds = recentSupersessionOwnerMessageIds(
                        args.db,
                        args.sessionId,
                    );
                    const selectedIds = new Set(syntheticPendingOps.map((op) => op.tagId));
                    const supersessionOps = buildSupersessionReclaimOps({
                        db: args.db,
                        sessionId: args.sessionId,
                        targets: newTargets,
                        pendingOps,
                        recentMessageIds,
                        protectedTagNumbers: args.protectedTagNumbers,
                        protectedToolTags,
                    });
                    for (const op of supersessionOps) {
                        if (!selectedIds.has(op.tagId)) {
                            syntheticPendingOps.push(op);
                            selectedIds.add(op.tagId);
                        }
                    }
                    const editReclaim = buildEditSupersessionReclaim({
                        watermark: args.sessionMeta.toolReclaimWatermark ?? 0,
                        db: args.db,
                        sessionId: args.sessionId,
                        targets: newTargets,
                        pendingOps,
                        recentMessageIds,
                        protectedTagNumbers: args.protectedTagNumbers,
                        protectedToolTags,
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
                logTransformTiming(
                    args.sessionId,
                    "toolReclaim.select",
                    tReclaimSelect,
                    `targets=${autoReclaimTargetCount}`,
                );
                if (syntheticPendingOps.length > 0) {
                    const tReclaimApply = performance.now();
                    autoReclaimDidMutate = applyPendingOperations(
                        args.sessionId,
                        args.db,
                        newTargets,
                        args.protectedTagIds,
                        undefined,
                        [],
                        syntheticPendingOps,
                        editMarkerTagIds,
                        (reduction) => droppedTokenReductions.push(reduction),
                    );
                    logTransformTiming(args.sessionId, "toolReclaim.apply", tReclaimApply);
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
            if (!args.fullFeatureMode && canEditWholePrefix && !compactionOff) {
                const thinkingStrippedIds = new Set([...bindingThinking, ...removedReasoningIds]);
                for (const id of getMergedReasoningStrippedIds(args.db, args.sessionId)) {
                    if (id.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX))
                        thinkingStrippedIds.add(
                            id.slice(THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length),
                        );
                }
                const conversions = prepareAgedToolSkeletonConversions(
                    args.db,
                    args.sessionId,
                    newTargets,
                    { thinkingStrippedIds },
                );
                args.db
                    .transaction(() => {
                        if (!conversions.isCurrent(args.db))
                            throw new Error("Subagent skeleton candidates changed before commit");
                        conversions.persist(args.db);
                    })
                    .immediate();
                convertedToolSkeletonsDidMutate =
                    renderConvertedToolSkeletons(newTargets, conversions.converted) ||
                    convertedToolSkeletonsDidMutate;
            }
            const tBatchFinalize = performance.now();
            args.batch?.finalize();
            // Only outputs with three newer user turns or a quarter-window of newer
            // content move the bookmark. Drops and edit compression above used the
            // previous bookmark, so newly distant outputs survive this rebuild.
            if (toolReclaimApplicationOpportunity) {
                const maxTagNumber = advanceToolReclaimWatermarkByDistance(
                    args.db,
                    args.sessionId,
                    reclaimDistance,
                    args.usableWindow,
                );
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
            // Covers the batch finalize and the reclaim watermark write above. It
            // used to start its timer at the log call itself and always read 0 ms.
            logTransformTiming(args.sessionId, "batchFinalize:heuristics", tBatchFinalize);
            if (args.sessionMeta.lastTransformError !== null) {
                updateSessionMeta(args.db, args.sessionId, { lastTransformError: null });
            }
            if (shouldRunHeuristics && !freezeM0M1) {
                if (isExplicitFlush) explicitMaterializedSuccessfully = true;
                if (deferredMaterialize) deferredMaterializedSuccessfully = true;
            }
        });
    } catch (error) {
        sessionLog(args.sessionId, "transform failed applying pending operations:", error);
        failPass("pending-operation-failure", error);
        updateSessionMeta(args.db, args.sessionId, { lastTransformError: getErrorMessage(error) });
    }

    if (isCacheBustingPass) {
        const tDroppedEstimate = performance.now();
        droppedTokens = estimateDroppedTokensFromTagReductions(
            args.db,
            args.sessionId,
            droppedTokenReductions,
        );
        logTransformTiming(args.sessionId, "pp.droppedTokenEstimate", tDroppedEstimate);
    }

    // All replay-only fields below come from one coherent session_meta row.
    // Writes that use compare-and-swap still perform their own winner re-read;
    // this snapshot only coalesces independent reads between those mutations.
    logTransformTiming(args.sessionId, "pp.setupAndOperations", tPostprocessSetup);
    const tReplaySnapshot = performance.now();
    const replaySnapshot = !compactionOff
        ? postprocessReplaySnapshot(args.db, args.sessionId)
        : undefined;
    logTransformTiming(args.sessionId, "pp.replaySnapshot", tReplaySnapshot);

    // Stale ctx_reduce strip is a REPLAY-class transform driven by a FROZEN,
    // id-keyed watermark (`stale_reduce_stripped_ids`), mirroring reasoning /
    // placeholder replay:
    //   • REPLAY (every pass, incl. defer): sentinel-strip ctx_reduce parts in
    //     messages whose id is already frozen — byte-identical regardless of how
    //     the live array grew.
    //   • DETECT (cache-busting passes only): additionally find aged ctx_reduce
    //     calls past the protected window, strip them, and CAS-persist their ids
    //     so future passes replay them.
    // The earlier version recomputed a live message-count boundary on every
    // pass and busted the Anthropic cache: tail growth moved the
    // boundary, so a DEFER pass newly stripped an older ctx_reduce call
    // mid-prefix (empty sentinel filtered for Anthropic + dropped tool_result →
    // adjacent assistants merge → the message vanishes and the array shifts).
    // Freezing the id set on bust passes and replaying it everywhere removes the
    // moving boundary entirely. Empty reduce sentinels are Anthropic-only: on
    // other providers even a previously frozen id must stay native so no empty
    // text block can reach the wire.
    if (canUseEmptySentinels && !compactionOff && replaySnapshot) {
        try {
            pair(() => {
                const t8 = performance.now();
                const frozenStaleReduceIds = replaySnapshot.staleReduceStrippedIds;
                const heldReduceCoords: string[] = [];
                const staleReduceResult = dropStaleReduceCalls(
                    args.messages,
                    frozenStaleReduceIds,
                    {
                        detect: canEditWholePrefix,
                        protectedCount: args.protectedCount,
                        protectedCallIds: new Set(
                            args.tags
                                .filter((tag) => protectedToolTags.has(tag.tagNumber))
                                .map((tag) => tag.messageId),
                        ),
                        admitFirstApplication: gateStaleReduceAdmission(
                            holdEnabled,
                            (message, block) => {
                                if (
                                    editAdmission.admit({
                                        kind: "message",
                                        id: message.info.id,
                                        block,
                                    })
                                )
                                    return true;
                                heldReduceCoords.push(`${message.info.id ?? "<no id>"}:${block}`);
                                return false;
                            },
                        ),
                        onFirstApplication: recordFirstApplicationAt,
                    },
                );
                if (heldReduceCoords.length > 0 && editAdmission.frame.kind === "boundary") {
                    sessionLog(
                        args.sessionId,
                        `edit admission: held lane=stale_reduce coords=${heldReduceCoords.join(",")} boundary=${editAdmission.frame.messageId ?? "<unresolved>"} held_edits=${heldReduceCoords.length}`,
                    );
                }
                if (isCacheBustingPass && staleReduceResult.newlyStrippedIds.length > 0) {
                    addStaleReduceStrippedIds(
                        args.db,
                        args.sessionId,
                        staleReduceResult.newlyStrippedIds,
                    );
                }
                logTransformTiming(args.sessionId, "dropStaleReduceCalls", t8);
            });
        } catch (error) {
            failPass("stale-reduce-strip-exception", error);
            sessionLog(args.sessionId, "transform failed dropping stale ctx_reduce calls:", error);
        }
    }

    // Persist image ids and replacement text only when the cached prefix may
    // change. Later cache-preserving passes restore only those saved decisions,
    // including after a provider switch, instead of discovering new strips.
    if (!compactionOff && replaySnapshot) {
        try {
            pair(() => {
                const tImg = performance.now();
                // Applying queued reductions and emergency cleanup above can mark
                // additional tags dropped after the input watermark was sampled.
                // Refresh the maximum dropped tag only when the prefix may change;
                // cache-preserving passes restore saved decisions without discovery.
                const imageWatermark = canEditWholePrefix
                    ? Math.max(args.watermark, getMaxDroppedTagNumber(args.db, args.sessionId))
                    : args.watermark;
                const frozenImageIds = replaySnapshot.processedImageStrippedIds;
                const heldImageCoords: string[] = [];
                const frozenMarkers = replaySnapshot.processedImageMarkers;
                const replacementText = canUseEmptySentinels ? "" : "[image stripped]";
                stripProcessedImages(args.messages, frozenImageIds, {
                    detect:
                        (holdEnabled ? isCacheBustingPass : canEditWholePrefix) &&
                        imageWatermark > 0,
                    watermark: imageWatermark,
                    messageTagNumbers: args.messageTagNumbers,
                    protectedCutoff: args.protectedCutoff,
                    contextPercentage: args.contextUsage.percentage,
                    replacementText,
                    frozenMarkers,
                    protectedMessageIds: new Set([
                        ...args.tags
                            .filter((tag) => protectedToolTags.has(tag.tagNumber))
                            .map((tag) => tag.toolOwnerMessageId ?? tag.messageId),
                    ]),
                    persistNewIds: (ids, markers) => {
                        if (!addProcessedImageStrippedIds(args.db, args.sessionId, ids, markers))
                            return false;
                        // Another plugin process sharing this session may have saved
                        // a different marker before our compare-and-swap completed.
                        const committed = getProcessedImageMarkers(args.db, args.sessionId);
                        for (const id of ids)
                            frozenMarkers.set(id, committed.get(id) ?? replacementText);
                        return true;
                    },
                    admitFirstApplication: holdEnabled
                        ? (message, block) => {
                              if (
                                  editAdmission.admit({
                                      kind: "message",
                                      id: message.info.id,
                                      block,
                                  })
                              )
                                  return true;
                              heldImageCoords.push(`${message.info.id ?? "<no id>"}:${block}`);
                              return false;
                          }
                        : undefined,
                    onFirstApplication: recordFirstApplicationAt,
                });
                if (heldImageCoords.length > 0 && editAdmission.frame.kind === "boundary") {
                    sessionLog(
                        args.sessionId,
                        `edit admission: held lane=processed_image coords=${heldImageCoords.join(",")} boundary=${editAdmission.frame.messageId ?? "<unresolved>"} held_edits=${heldImageCoords.length}`,
                    );
                }
                logTransformTiming(args.sessionId, "stripProcessedImages", tImg);
            });
        } catch (error) {
            failPass("image-strip-exception", error);
            sessionLog(args.sessionId, "transform failed stripping processed images:", error);
        }
    }

    // Same gate computed once at the top for the known-bust fold decision.
    const m0M1Enabled = m0M1EnabledForFold;
    // The covered rows are older than everything left in the array. The pass
    // that turns retention on puts them back in front of every signed block,
    // which is a first application like any other edit there.
    if (retainCoveredInstructions && coveredHostInstructions.length > 0) {
        if (!coveredRetentionOn && coveredHostInstructions.some((m) => m.parts.length > 0))
            recordFirstApplicationWireEdit(true);
        args.messages.unshift(...coveredHostInstructions);
    }
    if (m0M1Enabled && args.m0M1) {
        // Replay saved history/knowledge messages and resume raw host history
        // at its saved first-kept message. Reusing the saved head summarizes no
        // new history: leave the host's compaction-marker update and the pending
        // history/knowledge refresh queued until signed thinking no longer
        // binds the current turn's prefix.
        if (prefixRecordEnabled) {
            let recordProblem = prefixRecordProblem(
                prefixRecord,
                prefixProvenance,
                recordTurn,
                activeThinkingPrefixHold,
            );
            if (compactionOff && prefixRecord) {
                const firstRawId = args.messages.find((message) => !!message.info.id)?.info.id;
                recordProblem ??=
                    prefixRecord.summary !== null || prefixRecord.first_kept?.id !== firstRawId
                        ? "off-mode record does not describe the full raw window"
                        : validateServedPrefix(
                              prefixRecord,
                              args.messages,
                              (message) => message.info.id,
                              prefixProvenance,
                          );
            }
            const candidateHead = !activeThinkingPrefixHold
                ? prepareCachedM0M1Replay(args.db, args.sessionId)?.preparedMessages
                : undefined;
            const unchangedHead =
                !!candidateHead &&
                JSON.stringify(candidateHead) === JSON.stringify(prefixRecord?.head);
            const wantsRecord =
                activeThinkingPrefixHold ||
                (unchangedHead &&
                    // An admitted explicit refresh also releases the frozen system date.
                    // Replaying the old record would incorrectly report unconsumed history.
                    !explicitMaterializedSuccessfully &&
                    !deferredMaterializedSuccessfully &&
                    !foldBustsServedPrefixThisPass &&
                    !thinkingReleasedForFit &&
                    !firstRenderBust);
            const firstKeptPresent = prefixRecord?.first_kept
                ? args.messages.some((message) => message.info.id === prefixRecord?.first_kept?.id)
                : !args.messages.some(
                      (message) => !!message.info.id && message.info.summary !== true,
                  );
            if (!activeThinkingPrefixHold && !compactionOff && (recordProblem || !firstKeptPresent))
                persistCompanion();
            if (wantsRecord && !recordProblem && firstKeptPresent && prefixRecord) {
                preparedPrefix = {
                    injected: true,
                    prependedMessageCount: 0,
                    m0RematerializedThisPass: false,
                    materializationContentionRetryExhausted: true,
                    decision: { value: false, reason: "cache_hit" },
                    servedPrefixRecord: prefixRecord,
                    preparedTrimBoundaryId: prefixRecord.cut_mode.id,
                    m0Bytes: Buffer.from(
                        prefixRecord.head[0]?.parts
                            .map((part) =>
                                isRecord(part) && typeof part.text === "string" ? part.text : "",
                            )
                            .join("") ?? "",
                    ),
                    m1Text:
                        prefixRecord.head[1]?.parts
                            .map((part) =>
                                isRecord(part) && typeof part.text === "string" ? part.text : "",
                            )
                            .join("") ?? "",
                };
                replayedPrefixRecord = true;
            } else if (activeThinkingPrefixHold) {
                const reason = recordProblem ?? "first kept id missing";
                if (!compactionOff) refuseServedPrefix(reason, args.sessionId);
                prefixUnverified(reason);
            } else if (wantsRecord && !compactionOff) persistCompanion();
        }
        if (freezeM0M1 && !preparedPrefix) {
            preparedPrefix = prepareCachedM0M1Replay(args.db, args.sessionId);
        }
        const tInjectM0M1 = performance.now();
        // The thinking strip a compaction-off render in this call saved in its
        // own transaction.
        let finalRenderStrip: ReturnType<typeof freezeReasoningOnBustingPass> | undefined;
        try {
            const messagesBeforeInjection = args.messages.slice();
            const injectionOptions: M0M1RenderOptions = {
                db: args.db,
                sessionId: args.sessionId,
                messages: args.messages,
                state: args.sessionMeta as M0M1State,
                projectPath: args.m0M1.projectPath,
                projectDirectory: args.m0M1.projectDirectory,
                injectDocs: args.m0M1.injectDocs,
                memoryEnabled: args.m0M1.memoryEnabled,
                memoryInjectionBudgetTokens: args.m0M1.memoryInjectionBudgetTokens,
                historyBudgetTokens: args.m0M1.historyBudgetTokens,
                historyBudgetPolicyIdentity: args.m0M1.historyBudgetPolicyIdentity,
                temporalAwareness: args.m0M1.temporalAwareness,
                isCacheBustingPass: isCacheBustingPass && !freezeM0M1,
                preparedPrefix,
                prefixTrimSourceOrder: args.prefixTrimSourceOrder,
                allowFreshContentionFallback: forceMaterialization || emergencyDropEligible,
                hardSignals: args.m0M1.hardSignals,
                muralEnabled: args.m0M1.muralEnabled,
                // Compaction-off materializes through the zero-compartment
                // path: memory/docs/user-profile render, but historical
                // compartment rows never reach <session-history>.
                compactionOff,
                onM1Commit: !activeThinkingPrefixHold ? persistCompanion : undefined,
                onFoldPrepare: () => {
                    const before = {
                        m0Bytes: args.sessionMeta.cachedM0Bytes ?? null,
                        m1Bytes: args.sessionMeta.cachedM1Bytes ?? null,
                        muralDataUrl: args.sessionMeta.cachedM0MuralDataUrl ?? null,
                    };
                    return (db, rendered) => {
                        if (
                            !activeThinkingPrefixHold &&
                            foldInvalidatesThinking(foldDueDecision.reason, before, rendered)
                        )
                            persistCompanion();
                        // This call replays the saved pair when there is one. When it
                        // renders instead (no head is saved, for example after the
                        // preparation's render rolled back), compaction-off saves the
                        // thinking strip in the render's transaction, as the
                        // preparation does. The hook runs only when the call renders.
                        if (compactionOff)
                            finalRenderStrip = compactionOffRenderStrip(
                                db,
                                compareRenderedHead(rendered),
                            );
                    };
                },
            };
            const result = injectM0M1(injectionOptions);
            if (finalRenderStrip?.strip) {
                sessionLog(
                    args.sessionId,
                    "compaction-off render changed the head: stripping signed thinking",
                );
                releaseThinkingForRewrite(false, true, finalRenderStrip);
            }
            if (compactionOff)
                offPrefixFallback = () =>
                    prepareCachedM0M1Replay(args.db, args.sessionId)?.preparedMessages ??
                    injectM0M1({
                        ...injectionOptions,
                        messages: undefined,
                        preparedPrefix: undefined,
                        state: getOrCreateSessionMeta(args.db, args.sessionId) as M0M1State,
                    }).preparedMessages;
            deliveredPrefix = result;
            if (result.prefixTrimStatus === "applied") {
                // Preparation can summarize history without removing messages from
                // the request. Retire only source rows omitted from the delivered
                // prefix, including rows held until this later trim.
                const retainedMessages = new Set(args.messages);
                const trimmedMessageIds = messagesBeforeInjection
                    .filter((message) => !retainedMessages.has(message))
                    .map((message) => message.info.id)
                    .filter((id): id is string => typeof id === "string");
                // This additional delivery-time retirement exists for result
                // protection. Ordinary message/tool metadata keeps its existing
                // lifecycle, including agent drops of summarized message tags.
                // Retire every folded result of an adopted protected tool, not
                // just its newest N, so older folded results cannot re-enter N
                // when newer results or keep counts rotate. Include the previous
                // policy when a rebuilding pass disables a tool's protection.
                const currentPolicy = mergeProtectedTools(args.protectedTools);
                const previousPolicy = args.channel1StateBySession?.get(
                    args.sessionId,
                )?.protectedToolsPolicy;
                const eligibleTagNumbers = new Set(
                    args.tags
                        .filter(
                            (tag) =>
                                tag.type === "tool" &&
                                ((currentPolicy[normalizeProtectedToolName(tag.toolName)] ?? 0) >
                                    0 ||
                                    (previousPolicy?.[normalizeProtectedToolName(tag.toolName)] ??
                                        0) > 0),
                        )
                        .map((tag) => tag.tagNumber),
                );
                markTagsCompactedByMessageIds(
                    args.db,
                    args.sessionId,
                    trimmedMessageIds,
                    eligibleTagNumbers,
                );
            }
            if (result.injected) {
                m0M1InjectedThisPass = true;
                prependedMessageCount += result.prependedMessageCount;
                m0RematerializedThisPass ||= result.m0RematerializedThisPass;
                m0MaterializeReason = result.decision.reason ?? m0MaterializeReason;
                if (result.m0RematerializedThisPass) {
                    m0ComparisonDecision = result.decision;
                }
                stageServedHead(
                    args.sessionId,
                    {
                        m0Text: args.sessionMeta.cachedM0Bytes?.toString("utf8"),
                        m1Text: args.sessionMeta.cachedM1Bytes?.toString("utf8"),
                        muralDataUrl: (args.sessionMeta as M0M1State).cachedM0MuralDataUrl ?? null,
                    },
                    args.sessionMeta.cachedM0Bytes == null
                        ? -1
                        : args.sessionMeta.cachedM0MaxCompartmentSeq,
                );
                sessionLog(
                    args.sessionId,
                    `transform: injected m[0]/m[1] (rematerialized=${result.m0RematerializedThisPass}, reason=${result.decision.reason ?? "cache_hit"})`,
                );
            }
        } catch (error) {
            // A failed injection may have committed a newer trim boundary. Drop
            // its in-memory cache before refusing so a retry rebuilds from the
            // persisted prefix rather than cutting against an unserved one.
            clearInjectionCache(args.sessionId);
            failPass("m0-m1-injection-degradation", error);
            sessionLog(
                args.sessionId,
                "transform: m[0]/m[1] injection failed:",
                getErrorMessage(error),
            );
            // Only compaction-off reaches this fallback: managed passes already
            // threw above. Keep the off mode's existing additive fallback rather
            // than substituting a legacy history block for a managed prefix.
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
    // Canonical Anthropic uses empty sentinels that its adapter filters. A seam
    // row hidden on the fold pass must instead be removed when replayed through a
    // provider that rejects empty content; rendering `[dropped]` would introduce
    // bytes that the fold never served.
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
    if (!compactionOff && replaySnapshot) {
        const tPlaceholder = performance.now();
        const persistedIds = replaySnapshot.strippedPlaceholderIds;
        const hiddenSeamIds = replaySnapshot.hiddenSeamPlaceholderIds;

        // Step 1: Replay prior decisions. Ordinary rows keep provider-safe
        // sentinels; non-Anthropic hidden-seam rows are removed to match the fold.
        if (persistedIds.size > 0) {
            const { replayed } = replaySentinelByMessageIds(
                args.messages,
                persistedIds,
                args.resolvedProviderID,
                hiddenSeamIds,
            );
            if (replayed > 0) {
                sessionLog(
                    args.sessionId,
                    `sentinel replay: neutralized ${replayed} previously-stripped messages`,
                );
            }
            // Absence from one transform array is not deletion. Advancing the
            // compaction marker can temporarily hide source rows on the fold pass
            // and project them again on the next pass. Their frozen sentinel IDs
            // must survive that gap so the reappearing rows keep the bytes already
            // served at the seam. The message.deleted handler removes IDs only
            // after OpenCode confirms that the durable source row was deleted.
        }

        // Step 2: Detect — only on cache-busting passes, find NEW eligible messages
        // and persist their IDs so future defer passes can replay.
        if (isCacheBustingPass) {
            pair(() => {
                const admitDroppedPlaceholder = admitWholeMessage("placeholder");
                const droppedResult = stripDroppedPlaceholderMessages(
                    args.messages,
                    args.resolvedProviderID,
                    recordFirstApplicationAt,
                    (message) =>
                        !servedShapeRepair.messageIDs.has(message.info.id ?? "") &&
                        admitDroppedPlaceholder(message),
                );
                const protectedTailStart = Math.max(
                    0,
                    args.messages.length - SYSTEM_INJECTION_ACTIONABLE_TAIL_MESSAGES,
                );
                const systemInjectedResult = stripSystemInjectedMessages(
                    args.messages,
                    protectedTailStart,
                    args.resolvedProviderID,
                    recordFirstApplicationAt,
                    admitWholeMessage("system-injected"),
                );
                logHeldWholeMessages();
                // Persist strip results for messages already hidden by the compaction marker.
                // These messages are not sent, so the record changes no current request bytes.
                const hiddenMessages = args.hiddenMessagesAtCompactionSeam ?? [];
                const hiddenDroppedResult = stripDroppedPlaceholderMessages(
                    hiddenMessages,
                    args.resolvedProviderID,
                );
                const hiddenSystemInjectedResult = stripSystemInjectedMessages(
                    hiddenMessages,
                    hiddenMessages.length,
                    args.resolvedProviderID,
                );

                const newlyNeutralized =
                    droppedResult.sentineledIds.length +
                    systemInjectedResult.sentineledIds.length +
                    hiddenDroppedResult.sentineledIds.length +
                    hiddenSystemInjectedResult.sentineledIds.length;

                if (newlyNeutralized > 0) {
                    const addedIds = [
                        ...droppedResult.sentineledIds,
                        ...systemInjectedResult.sentineledIds,
                        ...hiddenDroppedResult.sentineledIds,
                        ...hiddenSystemInjectedResult.sentineledIds,
                    ];
                    for (const id of addedIds) persistedIds.add(id);
                    // CAS delta (add) so a concurrent prune in a sibling process
                    // doesn't clobber these newly-discovered IDs.
                    applyStrippedPlaceholderDelta(args.db, args.sessionId, {
                        add: addedIds,
                        hiddenSeamAdd: [
                            ...hiddenDroppedResult.sentineledIds,
                            ...hiddenSystemInjectedResult.sentineledIds,
                        ],
                    });
                    sessionLog(
                        args.sessionId,
                        `neutralized ${droppedResult.stripped} dropped + ${systemInjectedResult.stripped} system-injected messages + ${hiddenDroppedResult.stripped + hiddenSystemInjectedResult.stripped} hidden-at-marker-seam (${newlyNeutralized} new, ${persistedIds.size} total persisted)`,
                    );
                }
            });
        }

        const trimmedMessageIds = (args.trimmedMessagesAtCompactionBoundary ?? [])
            .map((message) => message.info.id)
            .filter((id): id is string => typeof id === "string");
        if (trimmedMessageIds.length > 0) {
            markTagsCompactedByMessageIds(args.db, args.sessionId, trimmedMessageIds);
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

    // Visibility check: scan the post-drop messages array for a non-stripped
    // ctx_note(action="read") tool call. This decides whether the suppression
    // path inside `peekNoteNudgeText` should fire — see the comment block
    // there for the full rationale. Only computed when nudges can actually
    // fire (fullFeatureMode), so we skip the scan in subagent sessions.
    logTransformTiming(args.sessionId, "pp.nudgeAndSticky", tNudgeBlock);

    const tMarker = performance.now();
    const explicitRebuildHappened =
        args.historyRefreshExplicitBeforePrepare && args.rebuiltHistoryFromInitialPrepare;
    const materializationSatisfied =
        !deferredMaterializationWasPending ||
        explicitMaterializedSuccessfully ||
        deferredMaterializedSuccessfully;
    const historyWasConsumedThisPass =
        !replayedPrefixRecord &&
        (!m0M1Enabled ||
            (deliveredPrefix?.injected === true &&
                !deliveredPrefix.materializationContentionRetryExhausted)) &&
        args.historyRebuiltThisPass &&
        (args.canConsumeDeferredLate ||
            args.phaseJustAwaitedPublication ||
            explicitRebuildHappened) &&
        materializationSatisfied;

    // Drain the persisted marker before todo synthesis so the todo anchor sees
    // the same summary representation that this pass will emit.
    let suppressV12HistoryDrain = false;
    let persistedCompactionMarkerState = replaySnapshot?.compactionMarker ?? null;
    // Whether the marker drain changed which summary row this pass serves right
    // after the history head. reconcileMarkerRepresentation builds that row from
    // the persisted marker, so a move replaces it with a row under a new id: a
    // prefix edit in its own right. A move can land on a pass that rebuilds
    // nothing else (a pass forced by high context usage that finds nothing else
    // to change, for one), so the edit is counted on its own rather than through
    // the history refresh.
    let markerDrainChangedServedRow = false;
    // The drain never waits for summary discovery. Start it, without waiting, on
    // every pass while a target is pending, so it has usually finished by the
    // next pass with rewrite permission; Rust mode does the same.
    if (
        replaySnapshot?.pendingCompactionMarker &&
        (args.compactionMarkerStrategy ?? defaultCompactionMarkerStrategy).applyDeferred ===
            applyDeferredCompactionMarker
    )
        startCompactionMarkerCandidatePreparation(args.sessionId);
    // A pending marker moves on the first pass that has rewrite permission for
    // any reason and proves, from what it serves, that the history head covers
    // the pending boundary and that its prefix trim went through it. Both proofs
    // read persisted state (the injection boundary, and the trim boundary saved
    // with the served m[0]/m[1] pair), so the pass need not rebuild history
    // itself. A postponed move therefore waits for the next pass that rewrites
    // anyway and never keeps the history refresh signal alive for its own sake:
    // that signal makes every later execute pass count as a history rebuild.
    // A pass that consumed history without permission still logs why the move
    // waits. A head served from a contention fallback proves nothing.
    const servedHeadIsCurrent =
        !m0M1Enabled ||
        (deliveredPrefix?.injected === true &&
            !deliveredPrefix.materializationContentionRetryExhausted);
    if (isCacheBustingPass || historyWasConsumedThisPass) {
        const pending = servedHeadIsCurrent
            ? (replaySnapshot?.pendingCompactionMarker ?? null)
            : null;
        if (pending) {
            const pendingCovered = pendingMarkerCoveredByConsumedBoundary(
                pending,
                args.pendingCompartmentInjection,
            );
            const trimWasProven =
                !m0M1Enabled ||
                deliveredPrefixWasTrimmedThroughPendingBoundary(
                    deliveredPrefix,
                    args.prefixTrimSourceOrder,
                    pending,
                ) ||
                sourceAlreadyReflectsCoveringMarker(
                    args.sessionId,
                    args.prefixTrimSourceOrder,
                    persistedCompactionMarkerState,
                    pending,
                );
            if (!pendingCovered) {
                suppressV12HistoryDrain = true;
                sessionLog(
                    args.sessionId,
                    `compaction-marker drain: pending ordinal ${pending.ordinal} is newer than consumed boundary ${args.pendingCompartmentInjection?.compartmentEndMessage ?? "<none>"}; preserving deferred history refresh signal`,
                );
            } else if (!trimWasProven) {
                // Refusing here keeps the marker and the served prefix one
                // decision: the boundary only advances on a pass that actually
                // trimmed through it.
                //
                // A session that was mid-drain when it upgraded from a build
                // without this rule pays for that build's last drain exactly
                // once. That build committed the boundary while still serving
                // the rows below it; afterwards the host builds the request
                // from the committed boundary, so those rows never reach this
                // transform again. The first pass after the upgrade therefore
                // serves a shorter prefix than the last pass before it. We do
                // not re-add them: re-serving history the host no longer hands
                // us is the failure mode this whole path exists to prevent.
                // The loss is bounded — only rows below the committed boundary
                // disappear, everything above it survives (shifted), and the
                // next pass is byte-identical to that one.
                suppressV12HistoryDrain = true;
                sessionLog(
                    args.sessionId,
                    `compaction-marker drain: refusing ordinal ${pending.ordinal} because prefix trim through ${args.pendingCompartmentInjection?.compartmentEndMessageId ?? "<none>"} was not proven; preserving deferred history refresh signal`,
                );
            } else if (!canEditWholePrefix) {
                // Moving the marker changes the summary row served right after
                // the history head (reconcileMarkerRepresentation rebuilds it from
                // the persisted marker), which is a change to the cached prefix
                // like any other. This pass has no permission to rewrite the whole
                // prefix: either it may not rewrite at all, or the signed-thinking
                // hold keeps the bytes in front of the turn's kept thinking. It
                // keeps its prefix and the move waits for the next pass that may
                // rewrite it. Waiting is always safe; the move is retried later.
                // When this pass consumed history, the history itself was served,
                // so its refresh signal is released as on any consuming pass.
                sessionLog(
                    args.sessionId,
                    `compaction-marker drain: pass has no rewrite permission${isCacheBustingPass ? " (signed-thinking hold)" : ""}; ordinal ${pending.ordinal} waits for a pass with rewrite permission`,
                );
            } else {
                const tMarkerDrain = performance.now();
                const strategy = args.compactionMarkerStrategy ?? defaultCompactionMarkerStrategy;
                // Discovery reads the whole session on a worker and can take tens of
                // seconds on a large one. The pass never waits for it: without a
                // prepared basis this starts discovery in the background and defers.
                const candidatesReady =
                    strategy.applyDeferred !== applyDeferredCompactionMarker ||
                    startCompactionMarkerCandidatePreparation(args.sessionId) === "ready";
                const outcome: MarkerUpdateOutcome = candidatesReady
                    ? pair(
                          () =>
                              strategy.applyDeferred(
                                  args.db,
                                  args.sessionId,
                                  pending,
                                  args.sessionDirectory,
                              ),
                          (result) => result.kind === "applied",
                      )
                    : { kind: "deferred", reason: "candidate-preparation" };
                logTransformTiming(
                    args.sessionId,
                    "pp.markerDrain",
                    tMarkerDrain,
                    `outcome=${outcome.kind}`,
                );
                switch (outcome.kind) {
                    case "deferred":
                        // Summary discovery may still be running, observe a new summary
                        // or fail to load its worker. Only marker replacement waits: serve
                        // the rebuilt request now; the next pass with rewrite permission
                        // finds the pending marker and retries.
                        sessionLog(
                            args.sessionId,
                            "compaction-marker drain: candidate preparation deferred; pending marker kept for the next pass with rewrite permission",
                        );
                        break;
                    case "applied":
                    case "already-current":
                    case "stale-skip":
                        // Marker application performs compare-and-swap/write work.
                        // Re-read its committed winner before reconciling the wire.
                        persistedCompactionMarkerState = getPersistedCompactionMarkerState(
                            args.db,
                            args.sessionId,
                        );
                        // An already-current or stale-skip outcome writes nothing,
                        // but a concurrent writer may have moved the marker since
                        // this pass read it; either way only a different summary
                        // id changes the served row.
                        markerDrainChangedServedRow =
                            (persistedCompactionMarkerState?.summaryMessageId ?? null) !==
                            (replaySnapshot?.compactionMarker?.summaryMessageId ?? null);
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
                        if (outcome.cut === "definitely-no-cut") {
                            // The host store's marker rows are exactly as before, so the
                            // host keeps loading the same messages and this pass's own
                            // trim removes them again on every later pass. Serve the
                            // rebuilt request and retry the move on the next pass with
                            // rewrite permission, as for a deferral. Refusing would replay
                            // an older request while this pass's m[1] refresh, drops and
                            // trim are already saved, and the next pass serves those: two
                            // rewrites of the cached prefix instead of one.
                            sessionLog(
                                args.sessionId,
                                `compaction-marker drain: marker unchanged (reason=${isSqliteLockContentionError(outcome.error) ? "busy-writer" : "left-unchanged"}); serving rebuilt history and keeping the pending marker for the next pass with rewrite permission:`,
                                outcome.error,
                            );
                            break;
                        }
                        failPass("compaction-marker-drain-failure", outcome.error);
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
    if (
        !compactionOff &&
        !(replayedPrefixRecord && (activeThinkingPrefixHold || !isCacheBustingPass))
    ) {
        const tMarkerWire = performance.now();
        const markerWire = (
            summary: MessageLike | null | undefined = args.messages.find(
                (message) => message.info.summary === true,
            ),
        ): string | null => {
            return summary
                ? stableStringify([
                      summary.info.role,
                      summary.parts
                          .filter((part) => !isPartDroppedBeforeWire(part, args.resolvedProviderID))
                          .map(providerVisiblePart),
                  ])
                : null;
        };
        const hasPreviousPrefix =
            prefixRecordEnabled &&
            prefixRecord !== null &&
            prefixRecordProblem(prefixRecord, prefixProvenance, recordTurn, false) === null;
        // Raw host history need not contain the synthetic summary served last time.
        // Prefer that authoritative record over the current rebuilt array.
        const markerBefore = prefixRecordEnabled
            ? markerWire(hasPreviousPrefix ? prefixRecord?.summary : undefined)
            : null;
        const legacyMarkerRetires =
            !hasPreviousPrefix &&
            isCacheBustingPass &&
            persistedCompactionMarkerState === null &&
            getDeferredClearedCompactionMarkerState(args.db, args.sessionId) !== null;
        pair(
            () =>
                (args.compactionMarkerStrategy ?? defaultCompactionMarkerStrategy).reconcile(
                    args.messages,
                    persistedCompactionMarkerState,
                    {
                        db: args.db,
                        sessionId: args.sessionId,
                        tagger: args.tagger,
                        ctxReduceAvailability: args.ctxReduceAvailability,
                        isCacheBustingPass,
                    },
                ),
            () => (hasPreviousPrefix ? markerWire() !== markerBefore : legacyMarkerRetires),
        );
        // Applying, replacing or retiring a visible summary changes the prefix.
        // Retiring bookkeeping for a summary never served changes no bytes.
        if (prefixRecordEnabled && markerWire() !== markerBefore)
            recordFirstApplicationWireEdit(true);
        logTransformTiming(args.sessionId, "pp.markerWireReconcile", tMarkerWire);
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

    logTransformTiming(args.sessionId, "pp.markerReconcile", tMarker);
    const tNoteAndTodo = performance.now();
    const noteReadStillVisible = args.fullFeatureMode
        ? hasVisibleNoteReadCall(args.messages)
        : false;
    const noteNudgeUserMessageId = findNoteNudgeUserMessageId(args.messages);
    // A changed m[0]/m[1] history message proves the request is already rewriting
    // bytes before the target user message. Reductions after that user message,
    // or cleanup that was permitted but changed nothing, cannot pay for a nudge.
    const lastServedForNote =
        canEditWholePrefix && (m0RematerializedThisPass || historyWasConsumedThisPass)
            ? args.readLastServedMessages?.()
            : null;
    const rewrittenHeadCoversNote =
        !!lastServedForNote &&
        args.messages
            .slice(0, prependedMessageCount)
            .some(
                (message, index) =>
                    isSyntheticHeadMessage(message) &&
                    index < lastServedForNote.length &&
                    servedMessageKey(message, args.resolvedProviderID) !==
                        servedMessageKey(lastServedForNote[index], args.resolvedProviderID),
            );
    const noteNudgeEligibility = args.fullFeatureMode
        ? observeNoteNudgeServe({
              db: args.db,
              sessionId: args.sessionId,
              userMessageIds: args.messages
                  .filter((m) => m.info.role === "user" && typeof m.info.id === "string")
                  .map((m) => m.info.id as string),
              anchorMessageId: noteNudgeUserMessageId,
              isLiveTail: args.messages.at(-1)?.info.id === noteNudgeUserMessageId,
              prefixRewriteCoversAnchor: canEditWholePrefix && rewrittenHeadCoversNote,
          })
        : undefined;
    const projectReadScope = args.readProjectScope
        ? args.readProjectScope()
        : { projectIdentity: args.projectPath, memoryUnavailable: false };
    const deferredNoteText = args.fullFeatureMode
        ? peekNoteNudgeText(
              args.db,
              args.sessionId,
              noteNudgeUserMessageId,
              projectReadScope.memoryUnavailable ? undefined : projectReadScope.projectIdentity,
              noteReadStillVisible,
              noteNudgeEligibility,
              projectReadScope.memoryUnavailable,
          )
        : null;
    if (deferredNoteText) {
        const noteInstruction = `\n\n<instruction name="deferred_notes">${deferredNoteText}</instruction>`;
        const anchoredMessageId = noteNudgeUserMessageId;
        const outcome = markNoteNudgeDelivered(
            args.db,
            args.sessionId,
            noteInstruction,
            anchoredMessageId,
        );
        if (anchoredMessageId && outcome.ok) {
            appendReminderToUserMessageById(args.messages, anchoredMessageId, noteInstruction);
        } else if (anchoredMessageId && !outcome.ok) {
            // No reminder was appended to the fresh user turn; the managed
            // history is intact, so an optional delivery failure must not block.
            args.passOutcome?.record("note-nudge-cas-failure");
            sessionLog(args.sessionId, `note-nudge delivery skipped wire append: ${outcome.kind}`);
        }
    }

    // Render notes before hints on first delivery AND replay. Replaying hints
    // before a newly delivered note would reverse their order on the next pass.
    if (args.fullFeatureMode && !compactionOff && replaySnapshot) {
        for (const anchor of replaySnapshot.noteNudgeAnchors) {
            appendReminderToUserMessageById(args.messages, anchor.messageId, anchor.text);
        }
        for (const decision of replaySnapshot.autoSearchHintDecisions) {
            if (decision.decision === "hint") {
                appendReminderToUserMessageById(args.messages, decision.messageId, decision.text);
            }
        }
    }

    // Todo state synthesis is deliberately isolated so its live permission
    // refresh and cache-boundary behavior can be tested independently.
    // A busting pass that moves or clears the synthetic todo pair removes it
    // from the assistant it was anchored to, an edit before newer thinking.
    if (args.fullFeatureMode && !compactionOff) {
        prependedMessageCount += await applyTodoSynthesis({
            db: args.db,
            sessionId: args.sessionId,
            messages: args.messages,
            fullFeatureMode: args.fullFeatureMode,
            compactionOff,
            isCacheBustingPass,
            editAdmission,
            sessionMeta: args.sessionMeta,
            todowriteAvailability: args.todowriteAvailability,
            client: args.client,
            activeAgent: args.activeAgent,
            replaySnapshot,
            persistCompanion,
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
        !(holdEnabled && freezeM0M1) &&
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

    // Work-metrics (TUI sidebar Stats) are NOT computed here. They are a
    // display-only value read solely by the RPC sidebar handler, and the
    // computation is O(session age) — it was the dominant transform cost on
    // long sessions when run every pass. It now runs lazily and incrementally
    // in buildSidebarSnapshot (rpc-handlers.ts) when the TUI actually polls,
    // keeping the prompt path free of it.

    if (args.fullFeatureMode && args.autoSearch?.enabled) {
        // The runner drops hint fragments for memories whose current text the agent
        // already sees in the memory pair, so the hint stays "vague recall". That
        // visibility check reads current memory, so it is resolved only when a new hint
        // is computed for a new user message, never on a replaying pass.
        const tAutoSearch = performance.now();

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
                    projectPath: projectReadScope.projectIdentity,
                    memoryOwnerUnavailable: projectReadScope.memoryUnavailable,
                    ensureProjectRegistered: args.autoSearch.ensureProjectRegistered,
                    resolveVisibleMemoryIds: () =>
                        getVisibleMemoryIds(args.db, args.sessionId) ?? undefined,
                    wordRules: args.autoSearch.wordRules,
                },
            });
            if (!autoSearchOutcome.ok) {
                args.passOutcome?.record(`auto-search-${autoSearchOutcome.kind}`);
            }
        } catch (error) {
            // Missing optional text on the fresh tail is safe to serve. Keep
            // replaying the remaining persisted request decisions below.
            args.passOutcome?.record("auto-search-internal-failure");
            sessionLog(args.sessionId, "auto-search runner failed:", error);
        }
        logTransformTiming(args.sessionId, "pp.autoSearchHint", tAutoSearch);
    } else if (
        args.fullFeatureMode &&
        args.autoSearch &&
        !args.autoSearch.enabled &&
        args.projectPath
    ) {
        await runAutoSearchHint({
            sessionId: args.sessionId,
            db: args.db,
            messages: args.messages,
            options: {
                enabled: false,
                scoreThreshold: args.autoSearch.scoreThreshold,
                minPromptChars: args.autoSearch.minPromptChars,
                projectPath: args.projectPath,
            },
        });
    }

    if (args.fullFeatureMode && canEditWholePrefix) {
        const visibleIds = new Set<string>();
        for (const message of args.messages) {
            if (typeof message.info?.id === "string") {
                visibleIds.add(message.info.id);
            }
        }
        const prunedAnchors = pruneNoteNudgeAnchors(args.db, args.sessionId, visibleIds);
        flushAutoSearchHintDecisionRetirement(args.db, args.sessionId, visibleIds);
        // A branch switch can hide user messages that will later be served again.
        // Keep their saved search hints, including no-hint omissions. Only the actual
        // prefix trim records IDs covered by a summary; this prefix-rebuild opportunity
        // may flush them to storage, while cached-prefix replay must not write them.
        // Today's visible IDs are not proof of deletion.
        if (prunedAnchors > 0) {
            sessionLog(
                args.sessionId,
                `sticky-injection GC: pruned ${prunedAnchors} note-nudge anchor(s)`,
            );
        }
    }

    const materializeReason =
        m0MaterializeReason ?? (explicitMaterializedSuccessfully ? pendingOrigin : null);
    const materialized =
        m0RematerializedThisPass ||
        explicitMaterializedSuccessfully ||
        deferredMaterializedSuccessfully;
    let bustedThisPass =
        firstApplicationEdits.any ||
        firstRenderBust ||
        hostCheckpointRide ||
        pendingOpsDidMutate ||
        heuristicOrReasoningDidMutate ||
        autoReclaimDidMutateThisPass ||
        convertedToolSkeletonsDidMutate ||
        m0RematerializedThisPass ||
        (m0M1InjectedThisPass && historyWasConsumedThisPass) ||
        historyWasConsumedThisPass ||
        markerDrainChangedServedRow;
    // Permission is not evidence that bytes changed. While current-turn signed
    // thinking is kept on a prefix-bound model, removing completed-turn thinking
    // changes bytes that signature covers too.
    const signedBoundaryKept = !editAdmission.admit({ kind: "prefix" });
    const proactiveThinkingStripPermitted =
        isCacheBustingPass && !activeThinkingPrefixHold && !signedBoundaryKept;

    // Final representation strips run once, after all topology mutations; execute
    // and defer must serialize identical prefixes. Do not add message, tool-target,
    // or role-topology mutations below this phase.
    //
    return pair(() => {
        const tFrozenDecisions = performance.now();
        if (reasoningMutationTargetUnknown) {
            const reasoningCandidates =
                args.reasoningByMessage.size > 0 ? args.reasoningByMessage.keys() : args.messages;
            for (const message of reasoningCandidates) {
                const hasClearedReasoning = message.parts.some((part) => {
                    if (part === null || typeof part !== "object") return false;
                    const candidate = part as {
                        type?: unknown;
                        thinking?: unknown;
                        text?: unknown;
                    };
                    if (candidate.type !== "reasoning" && candidate.type !== "thinking")
                        return false;
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
        // any stripped bytes. First selection excludes the newest assistant and
        // active Anthropic thinking.
        // Persisted omissions replay even if a host subset makes those messages active;
        // only anchored recovery may authorize their originals after a rejection.
        const mergedReasoningStrippedIds = new Set(
            replaySnapshot?.mergedReasoningStrippedIds ?? [],
        );
        // Persisted binding strips are replay evidence, not restore authorization.
        // Keep them separate from merged-part choices and anchored recovery ids.
        const frozenThinkingBindingMessageIds = new Set<string>();
        let thinkingBindingRecovery: ThinkingBindingRecoveryApplication | null = null;
        if (compactionOff) {
            for (const id of compactionOffFrozenThinking) frozenThinkingBindingMessageIds.add(id);
        } else {
            try {
                for (const id of mergedReasoningStrippedIds) {
                    if (id.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX)) {
                        const messageId = id.slice(THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length);
                        if (messageId.length > 0) frozenThinkingBindingMessageIds.add(messageId);
                    }
                }

                const flagTarget =
                    !activeThinkingTurn && args.thinkingBindingRecoveryEnabledForModel
                        ? (replaySnapshot?.thinkingBindingRecoveryTarget ?? null)
                        : null;
                // The latest-turn thinking recovery shares the column; its state
                // is not an armed binding flag and must not strip every block.
                if (
                    flagTarget &&
                    !isLatestThinkingRecoveryTarget(flagTarget) &&
                    flagTarget !== args.appliedBindingRecoveryTarget
                ) {
                    thinkingBindingRecovery = freezeAllReasoningForBindingRecovery({
                        db: args.db,
                        sessionId: args.sessionId,
                        messages: args.messages,
                        flagTarget,
                        protectedMessages: args.protectedThinkingMessages,
                        recoveredMessageIds: frozenThinkingBindingMessageIds,
                    });
                    if (thinkingBindingRecovery) {
                        for (const messageId of thinkingBindingRecovery.messageIds) {
                            mergedReasoningStrippedIds.add(
                                thinkingBindingRecoveryFrozenId(messageId),
                            );
                        }
                        if (thinkingBindingRecovery.messageIds.length > 0) {
                            recordFirstApplicationWireEdit(true);
                        }
                    } else {
                        failPass("thinking-binding-recovery-persistence-failure");
                        sessionLog(
                            args.sessionId,
                            "thinking binding recovery: persistence failed; leaving the bound blocks intact",
                        );
                    }
                }

                if (canUseEmptySentinels && canEditWholePrefix && !signedBoundaryKept) {
                    pair(() => {
                        const candidates = findMergedReasoningStripDecisions(
                            args.messages,
                            args.resolvedProviderID,
                            mergedReasoningStrippedIds,
                            {
                                mutationExemptMessage: reasoningMutationExemptMessage,
                                protectedMessages: protectedThinkingMessages,
                            },
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
                                // A concurrent writer may have frozen a different part selection.
                                // Serve only the committed winner, never our speculative plan.
                                mergedReasoningStrippedIds.clear();
                                for (const id of getMergedReasoningStrippedIds(
                                    args.db,
                                    args.sessionId,
                                )) {
                                    mergedReasoningStrippedIds.add(id);
                                }
                                // The merged-reasoning strip keeps the first block of a run of
                                // consecutive assistants and strips the later ones: a removal
                                // from the middle of the history.
                                recordFirstApplicationWireEdit(true);
                            } else {
                                failPass("merged-reasoning-strip-persistence-failure");
                                sessionLog(
                                    args.sessionId,
                                    "merged reasoning strip: persistence failed; leaving newly detected assistants intact",
                                );
                            }
                        }
                    });
                }
            } catch (error) {
                failPass("merged-reasoning-strip-exception", error);
                sessionLog(
                    args.sessionId,
                    "transform failed freezing merged reasoning strip:",
                    error,
                );
            }
        }

        const trailingBlankDecisions = new Map<string, TrailingBlankDecision>(
            replaySnapshot?.trailingBlankDecisions ?? [],
        );

        const newestAssistantId =
            typeof trailingBlankNewestAssistant?.info.id === "string"
                ? trailingBlankNewestAssistant.info.id
                : undefined;

        let trailingDecisionMessages: Map<string, MessageLike> | undefined;
        const recordTrailingBlankWireEdit = (id: string, next: TrailingBlankDecision): void => {
            // Persisting a choice is not an edit when it renders the same shape.
            // Compare against the previous frozen projection, not pristine ingress:
            // applying an old strip to raw history is replay, not a new cache bust.
            trailingDecisionMessages ??= new Map(
                args.messages.flatMap((message) =>
                    typeof message.info.id === "string"
                        ? [[message.info.id, message] as const]
                        : [],
                ),
            );
            const message = trailingDecisionMessages.get(id);
            if (!message) return;
            const before = [{ ...message, parts: [...message.parts] }];
            const after = [{ ...message, parts: [...message.parts] }];
            const previous = trailingBlankDecisions.get(id);
            if (previous) applyFrozenTrailingBlankDecisions(before, new Map([[id, previous]]));
            applyFrozenTrailingBlankDecisions(after, new Map([[id, next]]));
            if (JSON.stringify(before[0].parts) !== JSON.stringify(after[0].parts)) {
                let partIndex = 0;
                while (
                    partIndex < before[0].parts.length &&
                    JSON.stringify(before[0].parts[partIndex]) ===
                        JSON.stringify(after[0].parts[partIndex])
                )
                    partIndex++;
                recordFirstApplicationAt(message, partIndex);
            }
        };

        if (canEditWholePrefix && trailingBlankDecisions.size > 0) {
            // A source snapshot can outlive the message's projection when a marker trims history.
            // Heal only IDs still present now so the first strip cannot land later on a defer serve.
            const visibleMessageIds = new Set(
                args.messages.flatMap((message) =>
                    typeof message.info.id === "string" ? [message.info.id] : [],
                ),
            );
            const poisonedKeepIds: string[] = [];
            for (const [id, decision] of trailingBlankDecisions) {
                if (
                    id === newestAssistantId ||
                    !visibleMessageIds.has(id) ||
                    trailingBlankSourceDecisions.get(id) !== "strip"
                ) {
                    continue;
                }
                if (decision === "keep" || decision.startsWith("keep:")) {
                    poisonedKeepIds.push(id);
                }
            }
            if (poisonedKeepIds.length > 0) {
                try {
                    const demotedIds = demoteTrailingBlankKeepDecisions(
                        args.db,
                        args.sessionId,
                        poisonedKeepIds,
                    );
                    if (demotedIds === null) {
                        failPass("trailing-blank-heal-persistence-failure");
                        sessionLog(
                            args.sessionId,
                            "trailing blank heal: persistence failed; retaining frozen keep decisions",
                        );
                    } else {
                        for (const id of demotedIds) {
                            recordTrailingBlankWireEdit(id, "strip");
                            trailingBlankDecisions.set(id, "strip");
                            sessionLog(
                                args.sessionId,
                                `trailing blank heal: demoted message ${id} from keep to strip because its source has no trailing blank`,
                            );
                        }
                    }
                } catch (error) {
                    failPass("trailing-blank-heal-exception", error);
                    sessionLog(
                        args.sessionId,
                        "transform failed healing trailing blank decisions:",
                        error,
                    );
                }
            }
        }

        if (canUseEmptySentinels && !compactionOff) {
            // Observe every pass, including defers. A new decision or an allowed newest keep
            // refresh is persisted before finalization, so a served demotion cannot outlive a
            // failed compare-and-swap. An established strip never refreshes to keep: a harness
            // blank arriving after the first serve stays stripped, and streaming, completion,
            // and historical projections can only lose suffix bytes, never reintroduce them.
            const detectedCandidates = findTrailingBlankDecisionCandidates(
                args.messages,
                trailingBlankDecisions,
                {
                    refreshMessageId: newestAssistantId,
                    sourceDecisions: trailingBlankSourceDecisions,
                },
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
                    const persisted = addTrailingBlankDecisions(
                        args.db,
                        args.sessionId,
                        candidates,
                        {
                            overwriteMessageId: newestAssistantId,
                        },
                    );
                    if (persisted) {
                        const committed = getTrailingBlankDecisions(
                            args.db,
                            args.sessionId,
                            candidates.map(([id]) => id),
                        );
                        for (const [id] of candidates) {
                            const decision = committed.get(id);
                            if (decision) {
                                if (isCacheBustingPass) recordTrailingBlankWireEdit(id, decision);
                                trailingBlankDecisions.set(id, decision);
                            }
                        }
                    } else {
                        failPass("trailing-blank-decision-persistence-failure");
                        sessionLog(
                            args.sessionId,
                            "trailing blank decision: persistence failed; serving the frozen decisions",
                        );
                    }
                } catch (error) {
                    failPass("trailing-blank-decision-exception", error);
                    sessionLog(
                        args.sessionId,
                        "transform failed freezing trailing blank decision:",
                        error,
                    );
                }
            }
        }

        logTransformTiming(args.sessionId, "pp.frozenDecisions", tFrozenDecisions);
        bustedThisPass ||= firstApplicationEdits.any;
        const finalizeOptions: FinalizeMessageRepresentationOptions = {
            modelID: args.resolvedModelID,
            protectedThinkingMessages: args.protectedThinkingMessages,
            prependedMessageCount,
            reasoningMutatedMessages,
            reasoningMutationExemptMessage,
            mergedReasoningStrippedIds,
            frozenThinkingBindingMessageIds,
            restoreThinkingMessageIds: args.restoreThinkingMessageIds,
            trailingBlankDecisions,
            skipMergedReasoningStrip: compactionOff,
            skipTrailingWhitespaceStrip: compactionOff,
        };

        // On a prefix-bound model, a busting pass that edits bytes before newer
        // signed thinking removes every signed block still on the wire, because
        // those edits invalidate them. The ids are persisted into the
        // binding-mismatch set before finalization (the final representation step
        // below), which strips that set first; later passes replay the same set
        // through the same step and serve identical bytes.
        //
        // Oldest-prefix reasoning removal alone does not invalidate newer blocks.
        // A permission or a request to rebuild is not evidence that bytes changed;
        // only an admitted first application can require a companion strip.
        //
        // Subagents are included: a subagent's busting pass invalidates its signed
        // blocks exactly as a primary's does.
        // The first rebuilding pass after upgrade switches how reasoning a drop
        // touched is served; that changes bytes only where such a part is present.
        // Todo and search work also suspend the pass. Read the committed union
        // after the last suspension, even when this pass selected no new IDs.
        refreshReasoningRemovalUnion();
        replayCommittedVisibleDrops();
        const dropModeSwitchesThisPass =
            !canUseEmptySentinels &&
            !dropLeavesReasoning &&
            typeof args.resolvedProviderID === "string" &&
            isCacheBustingPass &&
            reasoningRemovalReadable &&
            args.messages.some(
                (message) =>
                    message.info.role === "assistant" &&
                    message.parts.some((part) => isNeutralizedReasoningPart(part)),
            );
        if (
            prefixBoundModel &&
            firstApplicationLocations.size > 0 &&
            !firstApplicationEdits.beforeNewerThinking
        ) {
            // Check the remaining representation, not reasoning already frozen for
            // removal. Only real first edits pay for this positional replay preview.
            const remaining = args.messages.map((message) => ({
                ...message,
                parts: [...message.parts],
            }));
            stripClearedReasoning(remaining);
            stripReasoningFromAssistantIds(
                remaining,
                args.resolvedProviderID,
                frozenThinkingBindingMessageIds,
            );
            stripReasoningFromMergedAssistants(remaining, args.resolvedProviderID, {
                frozenMessageIds: mergedReasoningStrippedIds,
                mutationExemptMessage:
                    remaining[args.messages.indexOf(reasoningMutationExemptMessage as MessageLike)],
            });
            let newerThinking = false;
            for (let index = remaining.length - 1; index >= 0; index--) {
                const message = remaining[index];
                const editIndex = firstApplicationLocations.get(args.messages[index]);
                // A removed suffix follows every part still in its own message.
                if (editIndex !== undefined && editIndex >= message.parts.length && newerThinking)
                    firstApplicationEdits.beforeNewerThinking = true;
                for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex--) {
                    const part = message.parts[partIndex];
                    if (
                        message.info.role === "assistant" &&
                        isRecord(part) &&
                        part.ignored !== true &&
                        (part.type === "reasoning" ||
                            part.type === "thinking" ||
                            part.type === "redacted_thinking")
                    )
                        newerThinking = true;
                    if (editIndex !== undefined && partIndex === editIndex && newerThinking)
                        firstApplicationEdits.beforeNewerThinking = true;
                }
            }
        }
        for (const reduction of droppedTokenReductions)
            recordFirstApplicationWireEdit(tagEditBeforeThinking.get(reduction.tagNumber) ?? true);
        // Replay the recorded drop representation. A new representation may be
        // selected only outside a held signed prefix, in the transaction that
        // also records any required thinking removals.
        let settledDroppedReasoning = 0;
        if (!canUseEmptySentinels) {
            let mode: DroppedReasoningMode = "legacy";
            if (dropLeavesReasoning) mode = "restore";
            else if (
                typeof args.resolvedProviderID === "string" &&
                !activeThinkingPrefixHold &&
                isCacheBustingPass &&
                reasoningRemovalReadable
            ) {
                try {
                    if (markDropLeavesReasoning(args.db, args.sessionId)) {
                        dropLeavesReasoning = true;
                        mode = "restore";
                    }
                } catch (error) {
                    if (companionEnabled && dropModeSwitchesThisPass)
                        failPass("reasoning-removal-persistence-failure", error);
                    sessionLog(args.sessionId, "reasoning removal: drop mode write failed:", error);
                }
            }
            settledDroppedReasoning = settleDroppedReasoningParts(args.messages, mode);
        }
        const prefixEditBesidesReasoningTrim =
            recoveryTailNormalizedThisPass ||
            // A moved marker replaces the summary row right after the history
            // head, in front of every kept thinking block.
            markerDrainChangedServedRow ||
            firstEditPrecedesThinking() ||
            (dropModeSwitchesThisPass && dropLeavesReasoning && settledDroppedReasoning > 0) ||
            // A frozen replay released with a different history head changed
            // the bytes in front of every signed block served since the replay.
            releasedFrozenHeadChanged;
        let proactiveThinkingStrip: ProactiveThinkingStrip | null = null;
        if (
            !compactionOff &&
            args.thinkingBindingRecoveryEnabledForModel === true &&
            proactiveThinkingStripPermitted &&
            prefixEditBesidesReasoningTrim
        ) {
            persistCompanion();
        }
        const committedCompanions = companionEnabled
            ? getMergedReasoningStrippedIds(args.db, args.sessionId)
            : new Set<string>();
        // The pass's instruction-row decisions (the rows it retires and the switch
        // that serves covered rows) are saved by transform.ts in its publication
        // at the end of the pass, in one update with the untagged-message record,
        // so a pass refused anywhere before that leaves neither behind for a later
        // pass to replay unserved. That is after the thinking-strip writes above,
        // which must be durable before any row edit they protect is saved.
        const pendingHostInstructionDecisions =
            hostRowReclaim || (retainCoveredInstructions && !coveredRetentionOn)
                ? {
                      reclaim: hostRowReclaim,
                      retention: retainCoveredInstructions && !coveredRetentionOn,
                  }
                : undefined;
        for (const id of committedCompanions) {
            if (!id.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX)) continue;
            frozenThinkingBindingMessageIds.add(
                id.slice(THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length),
            );
            mergedReasoningStrippedIds.add(id);
        }
        const newCompanionIds = [...companionIds].filter((id) =>
            committedCompanions.has(thinkingBindingRecoveryFrozenId(id)),
        );
        if (newCompanionIds.length) {
            proactiveThinkingStrip = { messageIds: newCompanionIds };
            bustedThisPass = true;
            if (unheldSignedTurnBust) rewritingSignedPrefix = true;
        }

        const tFinalRepresentation = performance.now();
        // Drops and compression may restore a raw body. Restore the same frozen
        // prefix after those edits, without consulting the new seam neighbours.
        if (temporalDecisions) injectTemporalMarkers(args.messages, temporalDecisions);
        const finalRepresentation = finalizeMessageRepresentation(
            args.messages,
            args.resolvedProviderID,
            finalizeOptions,
        );

        // Remove reasoning last. Every lane above addresses parts by index on the
        // array as OpenCode built it, and the next pass rebuilds that array. The
        // tail-hygiene walk below does read `:p<index>` positions on the spliced
        // array; its attribution is the same on every pass, so it never flips bytes.
        const removedReasoningParts = reasoningRemovalEnabled
            ? removeReasoningParts(args.messages, removedReasoningIds, args.resolvedProviderID)
            : 0;
        const reasoningStatusRatio = sessionDecisionCalibration(args.db, args.sessionId).proseRatio;
        captureOpencodeReasoningBudgetStatus(
            args.sessionId,
            args.messages,
            args.keepReasoningTokens ?? DEFAULT_KEEP_REASONING_TOKENS,
            prefixBoundModel,
            reasoningStatusRatio,
        );

        if (!rewritingSignedPrefix) args.restoreLatestTurnOriginals?.();
        // Authorized restoration must not undo a peer's durable omissions.
        if (!rewritingSignedPrefix && args.restoreLatestTurnOriginals) {
            refreshReasoningRemovalUnion();
            if (replayCommittedVisibleDrops()) {
                finalizeMessageRepresentation(
                    args.messages,
                    args.resolvedProviderID,
                    finalizeOptions,
                );
            }
            if (reasoningRemovalEnabled)
                removeReasoningParts(args.messages, removedReasoningIds, args.resolvedProviderID);
        }
        // Releasing frozen recovery and tagging its untagged tail are separate
        // decisions. A conversation-only rebuild cannot spend its permission
        // on tags before its first edit.
        const releaseRecoveryThisPass = canEditWholePrefix;
        if (releaseRecoveryThisPass) args.releaseRecoveryPrefix?.();
        sessionLog(
            args.sessionId,
            `recovery projection: case=${canNormalizeRecoveredShape ? recoveredShapeRewriteProof : releaseRecoveryThisPass ? "conversation_only" : "defer"} released=${releaseRecoveryThisPass} normalized=${recoveryTailNormalizedThisPass}`,
        );
        if (canUseEmptySentinels && args.opencode1) {
            projectStructuralSentinels({
                db: args.db,
                sessionId: args.sessionId,
                messages: args.messages,
                rebuilding: canNormalizeRecoveredShape && bustedThisPass,
                deferUpgrade: structuralSentinelUpgradeFailed,
            });
        }
        sessionLog(
            args.sessionId,
            `final representation: clearedParts=${finalRepresentation.clearedParts} mergedReasoningParts=${finalRepresentation.mergedReasoningParts} removedReasoningParts=${removedReasoningParts} settledDroppedReasoning=${settledDroppedReasoning}`,
        );
        logTransformTiming(
            args.sessionId,
            "finalizeMessageRepresentation",
            tFinalRepresentation,
            `clearedParts=${finalRepresentation.clearedParts} mergedReasoningParts=${finalRepresentation.mergedReasoningParts}`,
        );

        const tTailBaseline = performance.now();
        let assertedBaseline:
            | {
                  tags: TagEntry[];
                  protectedTagNumbers: ReadonlySet<number>;
                  contentSignature: string;
                  structuralSignature: TailHygieneStructuralSignature;
              }
            | undefined;
        if (args.channel1StateBySession) {
            if (args.ctxReduceAvailability.callable && !compactionOff) {
                try {
                    const tTailReads = performance.now();
                    const tags = postprocessTailTags(args.db, args.sessionId);
                    // A queued ctx_reduce drop is already actioned by the agent. Keep its
                    // still-rendered bytes in T, but exclude it from the actionable U backlog.
                    const pendingDropTagNumbers = new Set(
                        getPendingOps(args.db, args.sessionId)
                            .filter((operation) => operation.operation === "drop")
                            .map((operation) => operation.tagId),
                    );
                    const previous = args.channel1StateBySession.get(args.sessionId);
                    logTransformTiming(args.sessionId, "pp.tailReads", tTailReads);
                    const tTailMeasure = performance.now();
                    const hygieneCalibration = sessionDecisionCalibration(args.db, args.sessionId);
                    const hygieneUnitsVersion = transitionSessionHygieneUnits(
                        args.db,
                        args.sessionId,
                        bustedThisPass,
                        hygieneCalibration,
                    );
                    const baseline = refreshTailHygieneBaseline({
                        opencode2: args.opencode2,
                        messages: args.messages,
                        tags,
                        protectedTagNumbers: args.protectedTagNumbers,
                        protectedToolTags,
                        protectedTools: args.protectedTools,
                        pendingDropTagNumbers,
                        cacheBusting: bustedThisPass,
                        previous,
                        calibration:
                            hygieneUnitsVersion >= HYGIENE_PROVIDER_UNITS_VERSION
                                ? hygieneCalibration
                                : undefined,
                        hygieneUnitsVersion,
                    });
                    logTransformTiming(args.sessionId, "pp.tailMeasure", tTailMeasure);
                    // One line per invalidation event, not one per pass: the baseline
                    // only carries a mismatch on the pass that re-measured because of it.
                    if (baseline.lastPrefixMismatch) {
                        sessionLog(
                            args.sessionId,
                            formatTailHygienePrefixMismatch(
                                baseline.lastPrefixMismatch,
                                baseline.baselineGeneration,
                            ),
                        );
                    }
                    const tTailState = performance.now();
                    const structuralSignature = tailHygieneStructuralSignature(
                        args.messages,
                        args.opencode2,
                    );
                    const effective = effectiveTailHygiene(baseline);
                    const durableGrace =
                        baseline.evaluable && !baseline.generationInvalidated
                            ? captureChannel1PostReduceGraceBaseline(
                                  args.db,
                                  args.sessionId,
                                  effective.u,
                              )
                            : getChannel1NudgeState(args.db, args.sessionId);
                    baseline.channel1PostReduceGrace =
                        durableGrace.postReduceGracePending ||
                        durableGrace.postReduceGraceBaselineU !== undefined
                            ? {
                                  pending: durableGrace.postReduceGracePending === true,
                                  baselineU: durableGrace.postReduceGraceBaselineU,
                                  preReduceLevel:
                                      durableGrace.postReduceGracePreLevel ?? durableGrace.level,
                              }
                            : undefined;
                    args.channel1StateBySession.set(args.sessionId, {
                        ...baseline,
                        usableWindow: args.usableWindow,
                        realUserTurnCount: countRealUserMessages(args.messages),
                        // A successful refresh replaces the stale counts invalidated by ctx_reduce.
                        // Release that temporary hold even without a generation change; persisted
                        // post-reduce grace still waits for sufficient regrowth before reminding.
                        reducedSinceRefresh:
                            baseline.baselineGeneration !== previous?.baselineGeneration ||
                            ((previous?.generationInvalidated === true ||
                                previous?.evaluable === false) &&
                                baseline.evaluable &&
                                !baseline.generationInvalidated)
                                ? false
                                : (previous?.reducedSinceRefresh ?? false),
                        agentDropsAppliedThisPass: pendingOpsDidMutate,
                        oldestReclaimableToolTags: postprocessOldestTags(
                            args.db,
                            args.sessionId,
                            args.protectedTagNumbers,
                        ),
                    });
                    try {
                        rearmChannel2AfterMeasuredCollapse({
                            db: args.db,
                            sessionId: args.sessionId,
                            baseline,
                            rebuilding: bustedThisPass,
                            previous,
                        });
                    } catch (error) {
                        sessionLog(
                            args.sessionId,
                            "channel2 U-collapse reset failed (ignored):",
                            error,
                        );
                    }
                    logTransformTiming(args.sessionId, "pp.tailState", tTailState);
                    assertedBaseline = {
                        tags,
                        protectedTagNumbers: args.protectedTagNumbers,
                        contentSignature: baseline.contentSignature,
                        structuralSignature,
                    };
                } catch (error) {
                    const stale = args.channel1StateBySession.get(args.sessionId);
                    if (stale) {
                        stale.evaluable = false;
                        stale.generationInvalidated = true;
                    }
                    sessionLog(
                        args.sessionId,
                        "tail hygiene baseline refresh failed (held):",
                        error,
                    );
                }
            } else {
                args.channel1StateBySession.delete(args.sessionId);
            }
        }
        logTransformTiming(args.sessionId, "pp.tailBaseline", tTailBaseline);
        const tTailGuard = performance.now();
        if (assertedBaseline) {
            try {
                const servedSignature = tailHygieneStructuralSignature(
                    args.messages,
                    args.opencode2,
                );
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
            assertTailHygieneContentUnchangedIfEnabled({
                opencode2: args.opencode2,
                messages: args.messages,
                tags: assertedBaseline.tags,
                protectedTagNumbers: assertedBaseline.protectedTagNumbers,
                expectedSignature: assertedBaseline.contentSignature,
            });
        }

        logTransformTiming(args.sessionId, "pp.tailGuard", tTailGuard);
        // A subagent has no leading history-summary messages; an empty flush has nothing to defer.
        if (
            holdEnabled &&
            !m0M1EnabledForFold &&
            getPendingOps(args.db, args.sessionId).length === 0
        )
            args.pendingMaterializationSessions.delete(args.sessionId);
        parkedTriggers?.settle(
            args.pendingMaterializationSessions.has(args.sessionId) ||
                args.deferredMaterializationSessions.has(args.sessionId),
            emergencyDropEligible && getEmergencyInputSample(args.db, args.sessionId) === 0,
        );
        if (
            !freezeM0M1 &&
            bustedThisPass &&
            !parkedTriggers?.pending &&
            parkedReleaseReasons.length
        ) {
            sessionLog(
                args.sessionId,
                `edit admission: release reason=${parkedReleaseReasons.join(",")}`,
            );
        }
        const finalizeServedPrefix = (publish = true): boolean => {
            let lateStrip = false;
            if (prefixRecordEnabled && m0M1InjectedThisPass) {
                const problem =
                    replayedPrefixRecord && prefixRecord
                        ? validateServedPrefix(
                              prefixRecord,
                              args.messages,
                              (message) => message.info.id,
                              prefixProvenance,
                          )
                        : null;
                if (activeThinkingPrefixHold) {
                    if (problem && !compactionOff) refuseServedPrefix(problem, args.sessionId);
                    if (problem) {
                        prefixUnverified(problem);
                        try {
                            const head = offPrefixFallback?.();
                            if (head) {
                                let end = 0;
                                while (
                                    end < args.messages.length &&
                                    isSyntheticHeadMessage(args.messages[end])
                                )
                                    end++;
                                args.messages.splice(0, end, ...structuredClone(head));
                            }
                        } catch (error) {
                            prefixUnverified(`fallback failed: ${getErrorMessage(error)}`);
                        }
                    }
                } else {
                    if (problem && !compactionOff) {
                        const priorCompanionCount = companionIds.size;
                        persistCompanion();
                        lateStrip = companionIds.size > priorCompanionCount;
                        // Thinking removed after tail accounting changes part positions.
                        // Discard that advisory baseline rather than reuse stale coordinates.
                        if (lateStrip) args.channel1StateBySession?.delete(args.sessionId);
                        finalizeMessageRepresentation(args.messages, args.resolvedProviderID, {
                            frozenThinkingBindingMessageIds: new Set([
                                ...savedBindings,
                                ...companionIds,
                            ]),
                            skipTrailingWhitespaceStrip: true,
                        });
                    }
                    if (!publish) return lateStrip;
                    let headEnd = 0;
                    while (
                        headEnd < args.messages.length &&
                        isSyntheticHeadMessage(args.messages[headEnd])
                    )
                        headEnd++;
                    const head = args.messages.slice(0, headEnd);
                    const summary = compactionOff
                        ? null
                        : (args.messages.find((message) => message.info.summary === true) ?? null);
                    const firstKept = args.messages.find(
                        (message) =>
                            message.info.summary !== true &&
                            !!message.info.id &&
                            prefixSourceIds.has(message.info.id),
                    );
                    try {
                        writeServedPrefix({
                            db: args.db,
                            sessionId: args.sessionId,
                            head,
                            summary,
                            firstKept,
                            firstKeptId: firstKept?.info.id,
                            turn: recordTurn,
                            provenance: prefixProvenance,
                            cut: replayedPrefixRecord
                                ? prefixRecord?.cut_mode
                                : deliveredPrefix?.preparedTrimBoundaryId &&
                                    deliveredPrefix.prefixTrimStatus === "applied"
                                  ? {
                                        mode:
                                            firstKept?.info.id ===
                                            deliveredPrefix.preparedTrimBoundaryId
                                                ? "partial"
                                                : "inclusive",
                                        id: deliveredPrefix.preparedTrimBoundaryId,
                                    }
                                  : {
                                        mode: "none",
                                        id: deliveredPrefix?.preparedTrimBoundaryId ?? null,
                                    },
                        });
                    } catch (error) {
                        if (!compactionOff) throw degradedPassError("served-prefix-write", error);
                        prefixUnverified(`write failed: ${getErrorMessage(error)}`);
                    }
                }
            }
            return lateStrip;
        };
        if (bustedThisPass) clearExecuteReclaimState(args.db, args.sessionId);
        if (hostCheckpointRide && isCacheBustingPass) {
            // The hook's head can cover newer compartments than the head the
            // provider saw, exactly as an executed fold that advances coverage.
            try {
                rearmChannel2AfterCoverageAdvancingHardFold({
                    db: args.db,
                    sessionId: args.sessionId,
                    foldExecuted: true,
                    compactionOff,
                    previousCoverage: hostCheckpointProof?.previousCoverage ?? null,
                    currentCoverage:
                        args.sessionMeta.cachedM0Bytes == null
                            ? null
                            : args.sessionMeta.cachedM0MaxCompartmentSeq,
                });
            } catch (error) {
                sessionLog(
                    args.sessionId,
                    "channel2 host-checkpoint reset failed (ignored):",
                    error,
                );
            }
        }
        parkedTriggers?.persist(args.db, args.sessionId);
        if (!parkedTriggers?.pending) parkedBustTriggersBySession.delete(args.sessionId);
        // The pass completed. A `host_compaction` request is settled when its proof
        // showed no change or an allowed pass rode it; a pass that could not take
        // the ride keeps it for the next one. Compaction-off never takes it, so a
        // pass there settles it rather than keep it pending for good.
        completeHostCheckpointPass(
            args.sessionId,
            args.pendingMaterializationSessions,
            hostCheckpointRequested && (!hostCheckpointRide || isCacheBustingPass || compactionOff),
        );
        return {
            finalizeServedPrefix: prefixRecordEnabled ? finalizeServedPrefix : undefined,
            prefixChanged:
                foldExecutedThisPass ||
                publishedM1RefreshedThisPass ||
                m0RematerializedThisPass ||
                deliveredPrefix?.m1Refreshed === true,
            prefixRecordWritable: prefixRecordEnabled && !activeThinkingPrefixHold,
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
            prefixMutationPermitted: canEditWholePrefix,
            bustedThisPass,
            prefixTrimStatus: deliveredPrefix?.prefixTrimStatus ?? null,
            prefixTrimRefusal: deliveredPrefix?.prefixTrimRefusal ?? null,
            thinkingBindingRecovery,
            proactiveThinkingStrip,
            thinkingReleasedForFit,
            pendingHostInstructionDecisions,
            restartHeadChanged,
        };
    });
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
        requestPendingMaterialization(
            args.pendingMaterializationSessions,
            args.sessionId,
            "mutation_drift",
        );
        args.historyRefreshSessions?.add(args.sessionId);
        sessionLog(
            args.sessionId,
            `m[0] drift watcher: mutation id changed ${cachedMaxMutationId} → ${currentMaxMutationId}; scheduling next-pass materialization`,
        );
        return true;
    }
    return false;
}

import { startCompactionMarkerCandidatePreparation } from "../../features/magic-context/compaction-marker";
import {
    clearPendingMaterialization,
    clearSystemPromptEdit,
    hasPendingMaterializationOrigin,
    hasSystemPromptEdit,
    pendingMaterializationOrigin,
    requestPendingMaterialization,
    snapshotPendingMaterialization,
} from "./pending-materialization";
