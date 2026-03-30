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
import { getActiveCompartmentRun } from "./compartment-runner";
import { dropStaleReduceCalls } from "./drop-stale-reduce-calls";
import { applyHeuristicCleanup } from "./heuristic-cleanup";
import {
    type PreparedCompartmentInjection,
    renderCompartmentInjection,
} from "./inject-compartments";
import { getStickyNoteNudge, markNoteNudgeDelivered, peekNoteNudgeText } from "./note-nudger";
import { reinjectNudgeAtAnchor } from "./nudge-injection";
import type { NudgePlacementStore } from "./nudge-placement-store";
import type { ContextNudge } from "./nudger";
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
    truncateErroredTools,
} from "./transform-operations";
import { logTransformTiming } from "./transform-stage-logger";

interface RunPostTransformPhaseArgs {
    sessionId: string;
    db: ContextDatabase;
    messages: MessageLike[];
    tags: TagEntry[];
    targets: Map<number, { setContent: (content: string) => boolean }>;
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
}

export function runPostTransformPhase(args: RunPostTransformPhaseArgs): void {
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
    const shouldReadPendingOps =
        isExplicitFlush || args.schedulerDecision === "execute" || compartmentRunning;
    const pendingOps = shouldReadPendingOps ? getPendingOps(args.db, args.sessionId) : [];
    const hasPendingUserOps = pendingOps.length > 0;
    const shouldApplyPendingOps =
        (args.schedulerDecision === "execute" || isExplicitFlush) && !compartmentRunning;
    // Central cache-busting gate used by all mutation paths below.
    const isCacheBustingPass = isExplicitFlush || shouldApplyPendingOps;
    const shouldRunHeuristics =
        args.fullFeatureMode &&
        !compartmentRunning &&
        (isExplicitFlush ||
            forceMaterialization ||
            (hasPendingUserOps && args.schedulerDecision === "execute" && !alreadyRanThisTurn));
    if (shouldRunHeuristics) {
        const reason = isExplicitFlush
            ? "explicit_flush"
            : forceMaterialization
              ? `force_materialization (${args.contextUsage.percentage.toFixed(1)}% >= ${args.forceMaterializationPercentage}%)`
              : `pending_ops_execute (pendingOps=${pendingOps.length}, scheduler=${args.schedulerDecision})`;
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
        sessionLog(
            args.sessionId,
            "transform: deferring pending ops — compartment agent in progress",
        );
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
            sessionLog(
                args.sessionId,
                `transform: injected ${compartmentResult.compartmentCount} compartments ` +
                    `(covering raw messages 1-${compartmentResult.compartmentEndMessage}, ` +
                    `skipped ${compartmentResult.skippedVisibleMessages} visible messages)`,
            );
        }
    }

    // Remove messages that are nothing but [dropped §N§] placeholders.
    // These shells waste tokens — there is no recall mechanism to use them.
    // MUST run AFTER compartment injection: renderCompartmentInjection checks whether
    // messages[0] is a dropped placeholder to decide if it needs a synthetic carrier message.
    //
    // Cache-safe: replay previously-stripped IDs on every pass, only detect new
    // empty shells on cache-busting passes. Persist the set so defer passes
    // produce the same message array as the bust pass that discovered them.
    {
        const persistedIds = getStrippedPlaceholderIds(args.db, args.sessionId);

        // Step 1: Replay — remove messages whose IDs were stripped on a prior bust pass.
        if (persistedIds.size > 0) {
            let replayed = 0;
            for (let i = args.messages.length - 1; i >= 0; i--) {
                const msgId = args.messages[i].info.id;
                if (msgId && persistedIds.has(msgId)) {
                    args.messages.splice(i, 1);
                    replayed++;
                }
            }
            if (replayed > 0) {
                sessionLog(
                    args.sessionId,
                    `placeholder replay: removed ${replayed} previously-stripped messages`,
                );
            }
        }

        // Step 2: Detect — only on cache-busting passes, find NEW empty shells.
        if (isCacheBustingPass) {
            // Snapshot IDs before stripping so we can diff after.
            const preStripIds = new Set<string>();
            for (const msg of args.messages) {
                if (msg.info.id) preStripIds.add(msg.info.id);
            }

            const strippedDropped = stripDroppedPlaceholderMessages(args.messages);
            if (strippedDropped > 0) {
                // Find IDs that disappeared — those are the newly stripped messages.
                const postStripIds = new Set<string>();
                for (const msg of args.messages) {
                    if (msg.info.id) postStripIds.add(msg.info.id);
                }
                let newlyStrippedCount = 0;
                for (const id of preStripIds) {
                    if (!postStripIds.has(id)) {
                        persistedIds.add(id);
                        newlyStrippedCount++;
                    }
                }
                // Prune persisted IDs that no longer appear in the live message set
                // (e.g., after compaction or history trimming removes old messages).
                for (const id of persistedIds) {
                    if (!preStripIds.has(id) && !postStripIds.has(id)) {
                        persistedIds.delete(id);
                    }
                }
                setStrippedPlaceholderIds(args.db, args.sessionId, persistedIds);
                sessionLog(
                    args.sessionId,
                    `stripped ${strippedDropped} placeholder messages (${newlyStrippedCount} new, ${persistedIds.size} total persisted)`,
                );
            }
        }
    }

    // Remove system-injected messages (notifications, reminders, internal markers)
    // that are OUTSIDE the protected tail. Only strip on cache-busting passes because
    // the dynamic protected tail boundary can shift as conversation grows, which would
    // remove previously-cached messages on defer passes (Finding 5).
    if (isCacheBustingPass) {
        const protectedTailStart = Math.max(0, args.messages.length - args.protectedTags * 2);
        const strippedSystemInjected = stripSystemInjectedMessages(
            args.messages,
            protectedTailStart,
        );
        if (strippedSystemInjected > 0) {
            sessionLog(
                args.sessionId,
                `stripped ${strippedSystemInjected} system-injected messages (notifications/reminders)`,
            );
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
                    sessionLog(
                        args.sessionId,
                        `preserving sticky turn reminder anchor to avoid cache bust: messageId=${pendingUserTurnReminder.messageId}`,
                    );
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
            sessionLog(
                args.sessionId,
                `preserving sticky note nudge anchor to avoid cache bust: messageId=${stickyNoteNudge.messageId}`,
            );
        }
    }

    const deferredNoteText = peekNoteNudgeText(args.db, args.sessionId, args.currentTurnId);
    if (deferredNoteText) {
        const noteInstruction = `\n\n<instruction name="deferred_notes">${deferredNoteText}</instruction>`;
        const anchoredMessageId = appendReminderToLatestUserMessage(args.messages, noteInstruction);
        // Always mark delivered once text is generated — the trigger is consumed.
        // If no user message exists, the nudge is lost for this cycle, but
        // triggerPending must still clear to prevent firing on every subsequent pass.
        markNoteNudgeDelivered(args.db, args.sessionId, noteInstruction, anchoredMessageId);
    }
}
