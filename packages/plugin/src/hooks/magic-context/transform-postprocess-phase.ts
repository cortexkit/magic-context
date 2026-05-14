import {
    type ContextDatabase,
    clearDeferredExecutePendingIfMatches,
    clearPendingCompactionMarkerStateIf,
    clearPersistedStickyTurnReminder,
    clearPersistedTodoSyntheticAnchor,
    getPendingCompactionMarkerState,
    getPendingOps,
    getPersistedStickyTurnReminder,
    getPersistedTodoSyntheticAnchor,
    getStrippedPlaceholderIds,
    getTopNBySize,
    peekDeferredExecutePending,
    setPersistedStickyTurnReminder,
    setPersistedTodoSyntheticAnchor,
    setStrippedPlaceholderIds,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import type { SessionMeta, TagEntry } from "../../features/magic-context/types";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import { applyContextNudge } from "./apply-context-nudge";
import { runAutoSearchHint } from "./auto-search-runner";
import { applyDeferredCompactionMarker } from "./compaction-marker-manager";
import { getActiveCompartmentRun } from "./compartment-runner";
import { dropStaleReduceCalls } from "./drop-stale-reduce-calls";
import { applyHeuristicCleanup } from "./heuristic-cleanup";
import {
    getVisibleMemoryIds,
    type PreparedCompartmentInjection,
    renderCompartmentInjection,
} from "./inject-compartments";
import {
    clearNoteNudgeState,
    getStickyNoteNudge,
    markNoteNudgeDelivered,
    peekNoteNudgeText,
} from "./note-nudger";
import { hasVisibleNoteReadCall } from "./note-visibility";
import { reinjectNudgeAtAnchor } from "./nudge-injection";
import type { NudgePlacementStore } from "./nudge-placement-store";
import type { ContextNudge } from "./nudger";
import { replaySentinelByMessageIds } from "./sentinel";
import {
    clearOldReasoning,
    stripClearedReasoning,
    stripDroppedPlaceholderMessages,
    stripInlineThinking,
    stripSystemInjectedMessages,
} from "./strip-content";
import { buildSyntheticTodoPart } from "./todo-view";
import {
    appendReminderToLatestUserMessage,
    appendReminderToUserMessageById,
    countMessagesSinceLastUser,
    injectToolPartIntoAssistantById,
    injectToolPartIntoLatestAssistant,
} from "./transform-message-helpers";
import {
    applyPendingOperations,
    type MessageLike,
    stripProcessedImages,
    type TagTarget,
    truncateErroredTools,
} from "./transform-operations";
import { logTransformTiming } from "./transform-stage-logger";

const DEGRADE_CACHE_WARNING_THRESHOLD = 10;
const degradedCacheCountBySession = new Map<string, number>();

export function resetDegradedCacheCount(sessionId: string): void {
    degradedCacheCountBySession.delete(sessionId);
}

interface RunPostTransformPhaseArgs {
    sessionId: string;
    db: ContextDatabase;
    messages: MessageLike[];
    tags: TagEntry[];
    targets: Map<number, TagTarget>;
    reasoningByMessage: Map<MessageLike, { type: string; thinking?: string; text?: string }[]>;
    messageTagNumbers: Map<MessageLike, number>;
    batch: { finalize: () => void } | null;
    contextUsage: { percentage: number; inputTokens: number };
    schedulerDecision: "execute" | "defer";
    fullFeatureMode: boolean;
    canRunCompartments: boolean;
    awaitedCompartmentRun: boolean;
    phaseJustAwaitedPublication: boolean;
    compartmentInProgress: boolean;
    historyRefreshExplicitBeforePrepare: boolean;
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
    autoDropToolAge: number;
    dropToolStructure: boolean;
    clearReasoningAge: number;
    protectedTags: number;
    nudgePlacements: NudgePlacementStore;
    nudger: (
        sessionId: string,
        contextUsage: { percentage: number; inputTokens: number },
        db: ContextDatabase,
        topNFn: typeof getTopNBySize,
        preloadedTags?: TagEntry[],
        messagesSinceLastUser?: number,
        preloadedSessionMeta?: SessionMeta,
    ) => ContextNudge | null;
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
        memoryEnabled: boolean;
        embeddingEnabled: boolean;
        gitCommitsEnabled: boolean;
    };
    /**
     * Age-tier caveman compression (experimental). Only honored when
     * ctx_reduce_enabled is false. Caller is responsible for zeroing this
     * out when ctx_reduce is on. Passed through to `applyHeuristicCleanup`.
     */
    cavemanTextCompression?: {
        enabled: boolean;
        minChars: number;
    };
    /**
     * Live provider/model for this session. Used by the whole-message
     * sentinel path to pick `""` (Anthropic-only optimization) vs
     * `[dropped]` (everything else, ensures non-empty wire content for
     * providers that don't filter empties — Kimi/Moonshot, etc.).
     */
    liveProviderID?: string;
}

export interface PostTransformPhaseResult {
    explicitMaterializedSuccessfully: boolean;
    deferredMaterializedSuccessfully: boolean;
}

export async function runPostTransformPhase(
    args: RunPostTransformPhaseArgs,
): Promise<PostTransformPhaseResult> {
    let didMutateFromPendingOperations = false;
    // `isExplicitFlush` reads pendingMaterializationSessions — the persistent
    // "user wants pending ops + heuristics to run" signal. Survives across
    // blocked defer passes (compartmentRunning) so /ctx-flush intent is not
    // lost when historian races the user's command.
    const isExplicitFlush = args.pendingMaterializationSessions.has(args.sessionId);
    const deferredMaterializationWasPending = args.deferredMaterializationSessions.has(
        args.sessionId,
    );
    const alreadyRanThisTurn =
        args.currentTurnId !== null &&
        args.lastHeuristicsTurnId.get(args.sessionId) === args.currentTurnId;
    const forceMaterialization =
        args.fullFeatureMode && args.contextUsage.percentage >= args.forceMaterializationPercentage;
    const activeCompartmentRun = args.canRunCompartments
        ? getActiveCompartmentRun(args.sessionId)
        : undefined;
    const compartmentRunning =
        args.canRunCompartments &&
        !args.awaitedCompartmentRun &&
        activeCompartmentRun !== undefined;
    // Emergency bypass: at forceMaterialization threshold (>=85%), allow both
    // pending-op materialization and heuristic cleanup to run even while a
    // historian run is in progress. This is safe because:
    //   - Historian reads raw OpenCode messages from opencode.db (read-only).
    //     It does not touch the plugin's context.db where tags/pending_ops live.
    //     The two databases are fully disjoint on the read/write side.
    //   - Drops mutate tags + pending_ops in context.db only.
    //   - The only shared mutation point is historian's call to
    //     `queueDropsForCompartmentalizedMessages` after it publishes, which
    //     writes to context.db's tags/pending_ops in a separate transaction.
    //     That function is idempotent against already-dropped tags (filters by
    //     `tag.status !== "active"`), so any ordering with the emergency bypass
    //     is benign.
    // Without this bypass, fast autonomous loops with sustained pressure can
    // keep compartmentRunning=true across every turn, so drops queued for
    // already-published compartments accumulate forever and context overflows.
    // At emergency levels we prioritize overflow prevention over cache stability.
    const emergencyBypassCompartmentGate = forceMaterialization;
    const deferredMaterialize = args.canConsumeDeferredLate && deferredMaterializationWasPending;
    const materializationRequested = isExplicitFlush || deferredMaterialize;
    const shouldReadPendingOps =
        materializationRequested ||
        args.schedulerDecision === "execute" ||
        forceMaterialization ||
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
            forceMaterialization) &&
        (!compartmentRunning || emergencyBypassCompartmentGate);
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
        (!compartmentRunning || emergencyBypassCompartmentGate) &&
        (materializationRequested ||
            forceMaterialization ||
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
    // `(!compartmentRunning || emergencyBypassCompartmentGate)` so they're
    // genuine "will-actually-mutate" booleans. ORing them is the precise
    // "did we mutate this pass" signal.
    //
    // Symmetry note: `system-prompt-hash.ts` and `inject-compartments.ts`
    // remain narrow (each reads its own dedicated set) so adjunct refresh
    // and history rebuild are decoupled from materialization timing.
    const isCacheBustingPass = shouldApplyPendingOps || shouldRunHeuristics;
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
        if (emergencyBypassCompartmentGate) {
            sessionLog(
                args.sessionId,
                `transform: emergency bypass — applying ${pendingOps.length} pending ops while compartment agent runs (${args.contextUsage.percentage.toFixed(1)}%)`,
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
            const pendingCountBefore = pendingOps.length;
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
            didMutateFromPendingOperations = applyPendingOperations(
                args.sessionId,
                args.db,
                args.targets,
                args.protectedTags,
                undefined,
                pendingOps,
            );
            const pendingCountAfter = getPendingOps(args.db, args.sessionId).length;
            if (pendingCountBefore > 0 && pendingCountAfter === 0) {
                clearPersistedStickyTurnReminder(args.db, args.sessionId);
            }
            logTransformTiming(args.sessionId, "applyPendingOperations", tApply);
        }
        if (shouldRunHeuristics) {
            const t5 = performance.now();
            // Caveman config is only passed through when ctx_reduce_enabled is
            // false AND the experimental flag is true. Caller (transform) wires
            // both conditions so this postprocess path doesn't need to re-check
            // them. Kept undefined otherwise so the heuristic pass skips entirely.
            const cavemanConfig = args.cavemanTextCompression?.enabled
                ? {
                      enabled: true,
                      minChars: args.cavemanTextCompression.minChars,
                  }
                : undefined;
            const cleanup = applyHeuristicCleanup(
                args.sessionId,
                args.db,
                args.targets,
                args.messageTagNumbers,
                {
                    autoDropToolAge: args.autoDropToolAge,
                    dropToolStructure: args.dropToolStructure,
                    protectedTags: args.protectedTags,
                    dropAllTools: forceMaterialization,
                    caveman: cavemanConfig,
                },
                args.tags,
            );
            if (
                cleanup.droppedTools > 0 ||
                cleanup.deduplicatedTools > 0 ||
                cleanup.droppedInjections > 0 ||
                cleanup.compressedTextTags > 0
            ) {
                didMutateFromPendingOperations = true;
            }
            logTransformTiming(
                args.sessionId,
                "applyHeuristicCleanup",
                t5,
                `droppedTools=${cleanup.droppedTools} deduplicatedTools=${cleanup.deduplicatedTools} droppedInjections=${cleanup.droppedInjections} compressedTextTags=${cleanup.compressedTextTags}`,
            );
            if (args.watermark > 0) {
                const t6 = performance.now();
                truncateErroredTools(args.messages, args.watermark, args.messageTagNumbers);
                stripProcessedImages(args.messages, args.watermark, args.messageTagNumbers);
                logTransformTiming(args.sessionId, "watermarkCleanup", t6);
            }
            const t7 = performance.now();
            const clearedReasoning = clearOldReasoning(
                args.messages,
                args.reasoningByMessage,
                args.messageTagNumbers,
                args.clearReasoningAge,
            );
            stripClearedReasoning(args.messages);
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
            // ── Drain pendingMaterializationSessions ──
            // Heuristics + materialization successfully ran on this pass.
            // We've fulfilled every reason the set was added (user
            // /ctx-flush, variant change, system-prompt hash change,
            // historian publish), so clear the persistent signal. If
            // compartmentRunning had blocked us above, this drain is
            // intentionally NOT reached — the flag survives so the next
            // safe pass picks up the work.
            args.pendingMaterializationSessions.delete(args.sessionId);
            if (args.currentTurnId) {
                args.lastHeuristicsTurnId.set(args.sessionId, args.currentTurnId);
            }
        }
        // After a TTL-based scheduler execute, reset lastResponseTime so
        // subsequent transforms defer instead of re-executing every pass.
        if (args.schedulerDecision === "execute" && !materializationRequested) {
            updateSessionMeta(args.db, args.sessionId, { lastResponseTime: Date.now() });
        }
        args.batch?.finalize();
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
        sessionLog(args.sessionId, "transform failed applying pending operations:", error);
        updateSessionMeta(args.db, args.sessionId, { lastTransformError: getErrorMessage(error) });
        // Only clear on cache-busting passes to avoid re-anchor on next defer.
        if (isCacheBustingPass) args.nudgePlacements.clear(args.sessionId);
    }
    // Only clear nudge placements on cache-busting passes. Clearing on defer would
    // cause the next pass to re-anchor the nudge on a cached assistant message (Finding 2).
    if (didMutateFromPendingOperations && isCacheBustingPass) {
        args.nudgePlacements.clear(args.sessionId);
    }

    if (
        shouldRunHeuristics &&
        (args.didMutateFromFlushedStatuses || didMutateFromPendingOperations)
    ) {
        try {
            const t8 = performance.now();
            dropStaleReduceCalls(args.messages, args.protectedTags);
            logTransformTiming(args.sessionId, "dropStaleReduceCalls", t8);
        } catch (error) {
            sessionLog(args.sessionId, "transform failed dropping stale ctx_reduce calls:", error);
        }
    }

    if (args.fullFeatureMode && args.pendingCompartmentInjection) {
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
        const persistedIds = getStrippedPlaceholderIds(args.db, args.sessionId);

        // Step 1: Replay — re-apply sentinel to messages whose IDs were neutralized
        // on a prior bust pass. Preserves array length — no splice.
        if (persistedIds.size > 0) {
            const { replayed, missingIds } = replaySentinelByMessageIds(
                args.messages,
                persistedIds,
                args.liveProviderID,
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
                setStrippedPlaceholderIds(args.db, args.sessionId, persistedIds);
            }
        }

        // Step 2: Detect — only on cache-busting passes, find NEW eligible messages
        // and persist their IDs so future defer passes can replay.
        if (isCacheBustingPass) {
            const droppedResult = stripDroppedPlaceholderMessages(
                args.messages,
                args.liveProviderID,
            );
            const protectedTailStart = Math.max(0, args.messages.length - args.protectedTags * 2);
            const systemInjectedResult = stripSystemInjectedMessages(
                args.messages,
                protectedTailStart,
                args.liveProviderID,
            );

            const newlyNeutralized =
                droppedResult.sentineledIds.length + systemInjectedResult.sentineledIds.length;

            if (newlyNeutralized > 0) {
                for (const id of droppedResult.sentineledIds) persistedIds.add(id);
                for (const id of systemInjectedResult.sentineledIds) persistedIds.add(id);
                setStrippedPlaceholderIds(args.db, args.sessionId, persistedIds);
                sessionLog(
                    args.sessionId,
                    `neutralized ${droppedResult.stripped} dropped + ${systemInjectedResult.stripped} system-injected messages (${newlyNeutralized} new, ${persistedIds.size} total persisted)`,
                );
            }
        }
    }

    // Sticky turn reminder replay is primary-only: subagents never CREATE
    // this state (gated in hook-handlers.ts), but a session that was briefly
    // misclassified as primary (race before session.created processes) could
    // leave stale state behind. On a cache-busting pass for a subagent, clear
    // any leftover state so it doesn't replay forever.
    const pendingUserTurnReminder = args.fullFeatureMode
        ? getPersistedStickyTurnReminder(args.db, args.sessionId)
        : null;
    if (!args.fullFeatureMode && isCacheBustingPass) {
        const stale = getPersistedStickyTurnReminder(args.db, args.sessionId);
        if (stale) {
            clearPersistedStickyTurnReminder(args.db, args.sessionId);
            sessionLog(
                args.sessionId,
                "sticky turn reminder cleared — subagent should not have this state (cache-busting pass)",
            );
        }
    }
    if (pendingUserTurnReminder) {
        // Only clear the reminder when the pass is already cache-busting (execute/flush).
        // Clearing on a cache-safe pass would remove text from an anchored user message,
        // changing cached content and busting the Anthropic prompt-cache prefix.
        if (args.hasRecentReduceCall && isCacheBustingPass) {
            clearPersistedStickyTurnReminder(args.db, args.sessionId);
            sessionLog(
                args.sessionId,
                "sticky turn reminder cleared — ctx_reduce found in recent messages (cache-busting pass)",
            );
        } else {
            if (pendingUserTurnReminder.messageId) {
                const reinjected = appendReminderToUserMessageById(
                    args.messages,
                    pendingUserTurnReminder.messageId,
                    pendingUserTurnReminder.text,
                );
                if (!reinjected) {
                    if (isCacheBustingPass) {
                        // Anchor message gone (compacted/deleted) — clear stale reminder.
                        // A new reminder will only be created if a future tool-heavy turn
                        // triggers createChatMessageHook; it is NOT auto-recreated from
                        // pending drops alone.
                        clearPersistedStickyTurnReminder(args.db, args.sessionId);
                        sessionLog(
                            args.sessionId,
                            `sticky turn reminder cleared — anchor ${pendingUserTurnReminder.messageId} gone (compacted/deleted)`,
                        );
                    } else {
                        sessionLog(
                            args.sessionId,
                            `preserving sticky turn reminder anchor to avoid cache bust: messageId=${pendingUserTurnReminder.messageId}`,
                        );
                    }
                }
            } else {
                const anchoredMessageId = appendReminderToLatestUserMessage(
                    args.messages,
                    pendingUserTurnReminder.text,
                );
                if (anchoredMessageId) {
                    setPersistedStickyTurnReminder(
                        args.db,
                        args.sessionId,
                        pendingUserTurnReminder.text,
                        anchoredMessageId,
                    );
                }
            }
        }
    }

    const messagesSinceLastUser = countMessagesSinceLastUser(args.messages);

    if (args.fullFeatureMode) {
        let nudge: ContextNudge | null = null;
        try {
            nudge = args.nudger(
                args.sessionId,
                args.contextUsage,
                args.db,
                getTopNBySize,
                args.tags,
                messagesSinceLastUser,
                args.sessionMeta,
            );
        } catch (error) {
            sessionLog(args.sessionId, "transform nudge computation failed:", error);
        }

        if (nudge?.type === "assistant") {
            const t9 = performance.now();
            applyContextNudge(args.messages, nudge, args.nudgePlacements, args.sessionId);
            logTransformTiming(args.sessionId, "applyContextNudge", t9);
        } else if (isCacheBustingPass) {
            // Only retire the nudge anchor on cache-busting passes (Finding 4).
            // Clearing on defer would remove previously-injected nudge text from
            // the cached assistant message.
            args.nudgePlacements.clear(args.sessionId);
        } else {
            // Defer pass: replay existing anchor to keep cached content stable.
            const existing = args.nudgePlacements.get(args.sessionId);
            if (existing) {
                reinjectNudgeAtAnchor(
                    args.messages,
                    existing.nudgeText,
                    args.nudgePlacements,
                    args.sessionId,
                );
            }
        }
    } else {
        args.nudgePlacements.clear(args.sessionId);
    }

    // Note nudges only run in full-feature sessions. Subagents don't need
    // reminders — they're driven by the main agent's prompt, not the user.
    const stickyNoteNudge = args.fullFeatureMode
        ? getStickyNoteNudge(args.db, args.sessionId)
        : null;
    if (stickyNoteNudge) {
        const reinjected = appendReminderToUserMessageById(
            args.messages,
            stickyNoteNudge.messageId,
            stickyNoteNudge.text,
        );
        if (!reinjected) {
            if (isCacheBustingPass) {
                // Anchor message gone (compacted/deleted) — clear stale note nudge.
                // A new nudge will only appear if another work boundary trigger fires
                // (commit, historian, todo completion); it is NOT auto-recreated just
                // because notes still exist.
                clearNoteNudgeState(args.db, args.sessionId);
                sessionLog(
                    args.sessionId,
                    `sticky note nudge cleared — anchor ${stickyNoteNudge.messageId} gone (compacted/deleted)`,
                );
            } else {
                sessionLog(
                    args.sessionId,
                    `preserving sticky note nudge anchor to avoid cache bust: messageId=${stickyNoteNudge.messageId}`,
                );
            }
        }
    }

    // Visibility check: scan the post-drop messages array for a non-stripped
    // ctx_note(action="read") tool call. This decides whether the suppression
    // path inside `peekNoteNudgeText` should fire — see the comment block
    // there for the full rationale. Only computed when nudges can actually
    // fire (fullFeatureMode), so we skip the scan in subagent sessions.
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
        const anchoredMessageId = appendReminderToLatestUserMessage(args.messages, noteInstruction);
        // Always mark delivered once text is generated — the trigger is consumed.
        // If no user message exists, the nudge is lost for this cycle, but
        // triggerPending must still clear to prevent firing on every subsequent pass.
        markNoteNudgeDelivered(args.db, args.sessionId, noteInstruction, anchoredMessageId);
    }

    // Todo state synthesis — inject a synthetic `todowrite` tool part into
    // the latest assistant message so the agent reads current todos through
    // their native todowrite-tracking mental model. The wire shape is
    // identical to OpenCode's stored todowrite tool parts, so providers,
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
                injectToolPartIntoAssistantById(args.messages, persistedAnchor.messageId, part)
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
                const anchoredMessageId = injectToolPartIntoLatestAssistant(args.messages, part);
                if (anchoredMessageId) {
                    setPersistedTodoSyntheticAnchor(
                        args.db,
                        args.sessionId,
                        part.callID,
                        anchoredMessageId,
                        // Persist the SNAPSHOT we injected, not just the
                        // callID. Defer-pass replay rebuilds from THIS state
                        // so prefix bytes stay identical even if a real
                        // `todowrite` mutates `last_todo_state` before the
                        // next cache-busting pass.
                        args.sessionMeta.lastTodoState,
                    );
                } else if (persistedAnchor) {
                    // No assistant message in this pass — clear stale
                    // anchor so a later cache-busting pass re-anchors fresh.
                    clearPersistedTodoSyntheticAnchor(args.db, args.sessionId);
                }
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
                injectToolPartIntoAssistantById(args.messages, persistedAnchor.messageId, part);
            }
        }
    }

    // Auto-search hint — append a vague-recall fragment hint to the latest
    // user message when experimental.auto_search is enabled and search
    // returns a high-confidence match. Gated behind fullFeatureMode: subagent
    // sessions (historian, compressor, dreamer child tasks, council members,
    // etc.) are driven by the main agent via prompt injection, not by the
    // user. There is no user prompt to semantically ground against, and
    // running embedding on subagent input wastes cycles + saturates the
    // embedding endpoint when many subagents run in parallel (e.g. Athena
    // council).
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

    // Plan v6 §3 degraded-cache counter: track consecutive null-boundary
    // rebuilds. Independent of the drain logic below.
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

    // Plan v6 §3 deferred-marker drain. Runs when v12's
    // `historyWasConsumedThisPass` is true AND we hold the deferred-history
    // signal AND a pending marker blob exists. The blob is the in-tx record
    // written by the incremental runner at publication time (plan v6 §4); the
    // drain finally applies the marker movement to OpenCode's DB.
    //
    // The v12 drain of `deferredHistoryRefreshSessions` still fires below — we
    // only conditionally suppress it when the marker apply returned
    // `retryable-failure`, so the next consuming pass retries.
    let suppressV12HistoryDrain = false;
    if (historyWasConsumedThisPass && args.deferredHistoryRefreshSessions.has(args.sessionId)) {
        const pending = getPendingCompactionMarkerState(args.db, args.sessionId);
        if (pending) {
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
                    clearPendingCompactionMarkerStateIf(args.db, args.sessionId, pending);
                    // v12 drain proceeds normally below.
                    break;
                case "retryable-failure":
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

    const deferredHistoryDrainEligible = historyWasConsumedThisPass && !suppressV12HistoryDrain;
    if (deferredHistoryDrainEligible) {
        args.deferredHistoryRefreshSessions.delete(args.sessionId);
    }
    if (explicitMaterializedSuccessfully || deferredMaterializedSuccessfully) {
        args.deferredMaterializationSessions.delete(args.sessionId);
    }

    const workExecutedSuccessfully =
        explicitMaterializedSuccessfully ||
        deferredMaterializedSuccessfully ||
        heuristicsRanSuccessfully ||
        pendingOpsRanSuccessfully;

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
            sessionLog(args.sessionId, `[boundary-exec] drain failed (continuing): ${err}`);
        }
    }

    if (args.fullFeatureMode && args.autoSearch?.enabled && args.projectPath) {
        // Resolve memory ids currently rendered in the <session-history>
        // block. The auto-search runner drops hint fragments for memories the
        // agent already sees in message[0] so the hint stays "vague recall"
        // for content not already in context.
        const visibleMemoryIds = getVisibleMemoryIds(args.db, args.sessionId) ?? undefined;

        try {
            await runAutoSearchHint({
                sessionId: args.sessionId,
                db: args.db,
                messages: args.messages,
                options: {
                    enabled: true,
                    scoreThreshold: args.autoSearch.scoreThreshold,
                    minPromptChars: args.autoSearch.minPromptChars,
                    projectPath: args.projectPath,
                    memoryEnabled: args.autoSearch.memoryEnabled,
                    embeddingEnabled: args.autoSearch.embeddingEnabled,
                    gitCommitsEnabled: args.autoSearch.gitCommitsEnabled,
                    visibleMemoryIds,
                },
            });
        } catch (error) {
            sessionLog(args.sessionId, "auto-search runner failed:", error);
        }
    }

    return { explicitMaterializedSuccessfully, deferredMaterializedSuccessfully };
}
