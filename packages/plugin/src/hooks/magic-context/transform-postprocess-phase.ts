import {
    type ContextDatabase,
    clearPersistedStickyTurnReminder,
    getPendingOps,
    getPersistedStickyTurnReminder,
    getStrippedPlaceholderIds,
    getTopNBySize,
    setPersistedStickyTurnReminder,
    setStrippedPlaceholderIds,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import type { SessionMeta, TagEntry } from "../../features/magic-context/types";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import { applyContextNudge } from "./apply-context-nudge";
import { runAutoSearchHint } from "./auto-search-runner";
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
import {
    appendReminderToLatestUserMessage,
    appendReminderToUserMessageById,
    countMessagesSinceLastUser,
} from "./transform-message-helpers";
import {
    applyPendingOperations,
    type MessageLike,
    stripProcessedImages,
    type TagTarget,
    truncateErroredTools,
} from "./transform-operations";
import { logTransformTiming } from "./transform-stage-logger";

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
    compartmentInProgress: boolean;
    sessionMeta: SessionMeta;
    currentTurnId: string | null;
    flushedSessions: Set<string>;
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
    /**
     * Providers with `capabilities.interleaved.field` require typed reasoning
     * parts to survive until OpenCode lifts them into a top-level
     * `reasoning_content`/`reasoning_details` wire field. When true, skip the
     * rewrite-and-remove cleanup for typed reasoning parts only.
     *
     * Inline `<thinking>...</thinking>` text is intentionally NOT gated. It
     * lives inside ordinary text parts and does not participate in the typed
     * provider contract that triggered Moonshot/Kimi's rejection.
     */
    skipTypedReasoningCleanup: boolean;
    projectPath?: string;
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
}

export async function runPostTransformPhase(args: RunPostTransformPhaseArgs): Promise<void> {
    let didMutateFromPendingOperations = false;
    const isExplicitFlush = args.flushedSessions.has(args.sessionId);
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
    const shouldReadPendingOps =
        isExplicitFlush ||
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
        (args.schedulerDecision === "execute" || isExplicitFlush || forceMaterialization) &&
        (!compartmentRunning || emergencyBypassCompartmentGate);
    // Central cache-busting gate used by all mutation paths below.
    //
    // `isCacheBustingPass` here is FLUSH-OR-EXECUTE (via `shouldApplyPendingOps`
    // which includes `schedulerDecision === "execute"`), NOT flush-only. This
    // asymmetry versus `system-prompt-hash.ts` and `inject-compartments.ts`
    // (which use flush-only) is intentional — see council Finding #12.
    //
    // Why flush-OR-execute here: message-level mutations (pending ops, stripped
    // placeholder registration, tool-drop finalization) run on scheduler
    // "execute" passes because that's when queued user drops get materialized.
    // System-prompt adjuncts (docs, profile, sticky date) are unrelated to
    // queued ops, so they stay flush-only. Running execute passes through the
    // adjunct path would refresh disk-backed state for no reason and leak that
    // refresh into cached `message[0]` injection.
    //
    // Summary: mutation passes = flush-OR-execute. Adjunct/injection state =
    // flush-only. Historian publication bridges the two via
    // `flushedSessions.add` (see council Finding #9, fixed in v0.14.1).
    const isCacheBustingPass = isExplicitFlush || shouldApplyPendingOps;
    const shouldRunHeuristics =
        args.fullFeatureMode &&
        (!compartmentRunning || emergencyBypassCompartmentGate) &&
        (isExplicitFlush ||
            forceMaterialization ||
            (args.schedulerDecision === "execute" && !alreadyRanThisTurn));
    if (shouldRunHeuristics) {
        const reason = isExplicitFlush
            ? "explicit_flush"
            : forceMaterialization
              ? `force_materialization (${args.contextUsage.percentage.toFixed(1)}% >= ${args.forceMaterializationPercentage}%)`
              : `scheduler_execute (pendingOps=${pendingOps.length}, scheduler=${args.schedulerDecision})`;
        sessionLog(
            args.sessionId,
            `heuristics WILL RUN — reason=${reason}, context=${args.contextUsage.percentage.toFixed(1)}%, turn=${args.currentTurnId}`,
        );
    }
    if (alreadyRanThisTurn && args.schedulerDecision === "execute" && !isExplicitFlush) {
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
    try {
        if (shouldApplyPendingOps) {
            const applyReason = isExplicitFlush
                ? "explicit_flush"
                : `scheduler_execute (scheduler=${args.schedulerDecision})`;
            sessionLog(
                args.sessionId,
                `pending ops WILL APPLY — reason=${applyReason}, pendingOps=${pendingOps.length}, context=${args.contextUsage.percentage.toFixed(1)}%`,
            );
            const pendingCountBefore = pendingOps.length;
            const tApply = performance.now();
            didMutateFromPendingOperations = applyPendingOperations(
                args.sessionId,
                args.db,
                args.targets,
                args.protectedTags,
                args.tags,
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
                },
                args.tags,
            );
            if (
                cleanup.droppedTools > 0 ||
                cleanup.deduplicatedTools > 0 ||
                cleanup.droppedInjections > 0
            ) {
                didMutateFromPendingOperations = true;
            }
            logTransformTiming(
                args.sessionId,
                "applyHeuristicCleanup",
                t5,
                `droppedTools=${cleanup.droppedTools} deduplicatedTools=${cleanup.deduplicatedTools} droppedInjections=${cleanup.droppedInjections}`,
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
                args.skipTypedReasoningCleanup,
            );
            stripClearedReasoning(args.messages, args.skipTypedReasoningCleanup);
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
            args.flushedSessions.delete(args.sessionId);
            if (args.currentTurnId) {
                args.lastHeuristicsTurnId.set(args.sessionId, args.currentTurnId);
            }
        }
        // After a TTL-based scheduler execute, reset lastResponseTime so
        // subsequent transforms defer instead of re-executing every pass.
        if (args.schedulerDecision === "execute" && !isExplicitFlush) {
            updateSessionMeta(args.db, args.sessionId, { lastResponseTime: Date.now() });
        }
        args.batch?.finalize();
        logTransformTiming(args.sessionId, "batchFinalize:heuristics", performance.now());
        if (args.sessionMeta.lastTransformError !== null) {
            updateSessionMeta(args.db, args.sessionId, { lastTransformError: null });
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
            const droppedResult = stripDroppedPlaceholderMessages(args.messages);
            const protectedTailStart = Math.max(0, args.messages.length - args.protectedTags * 2);
            const systemInjectedResult = stripSystemInjectedMessages(
                args.messages,
                protectedTailStart,
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

    const pendingUserTurnReminder = getPersistedStickyTurnReminder(args.db, args.sessionId);
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

    // Note nudges run outside fullFeatureMode — they should work in all sessions
    // including subagent sessions where fullFeatureMode is false.
    const stickyNoteNudge = getStickyNoteNudge(args.db, args.sessionId);
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

    const deferredNoteText = peekNoteNudgeText(
        args.db,
        args.sessionId,
        args.currentTurnId,
        args.projectPath,
    );
    if (deferredNoteText) {
        const noteInstruction = `\n\n<instruction name="deferred_notes">${deferredNoteText}</instruction>`;
        const anchoredMessageId = appendReminderToLatestUserMessage(args.messages, noteInstruction);
        // Always mark delivered once text is generated — the trigger is consumed.
        // If no user message exists, the nudge is lost for this cycle, but
        // triggerPending must still clear to prevent firing on every subsequent pass.
        markNoteNudgeDelivered(args.db, args.sessionId, noteInstruction, anchoredMessageId);
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
}
