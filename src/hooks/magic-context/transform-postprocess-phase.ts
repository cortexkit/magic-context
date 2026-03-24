import {
    type ContextDatabase,
    clearPersistedStickyTurnReminder,
    getPendingOps,
    getPersistedStickyTurnReminder,
    getTopNBySize,
    setPersistedStickyTurnReminder,
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
import { getNotNudgeText } from "./note-nudger";
import {
    appendSupplementalNudgeToAssistant,
    canAppendSupplementalNudgeToAssistant,
} from "./nudge-injection";
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
            logTransformTiming(args.sessionId, "applyPendingOperations", performance.now());
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
                sessionLog(
                    args.sessionId,
                    `reasoning cleanup: cleared=${clearedReasoning} inlineStripped=${strippedInline}`,
                );
            }
            logTransformTiming(args.sessionId, "clearOldReasoning", t7);
            args.flushedSessions.delete(args.sessionId);
            if (args.currentTurnId) {
                args.lastHeuristicsTurnId.set(args.sessionId, args.currentTurnId);
            }
        }
        args.batch?.finalize();
        logTransformTiming(args.sessionId, "batchFinalize:heuristics", performance.now());
        if (args.sessionMeta.lastTransformError !== null) {
            updateSessionMeta(args.db, args.sessionId, { lastTransformError: null });
        }
    } catch (error) {
        sessionLog(args.sessionId, "transform failed applying pending operations:", error);
        updateSessionMeta(args.db, args.sessionId, { lastTransformError: getErrorMessage(error) });
        args.nudgePlacements.clear(args.sessionId);
    }
    if (didMutateFromPendingOperations) {
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
    const strippedDropped = stripDroppedPlaceholderMessages(args.messages);
    if (strippedDropped > 0) {
        sessionLog(
            args.sessionId,
            `stripped ${strippedDropped} empty dropped-placeholder messages`,
        );
    }

    // Remove system-injected messages (notifications, reminders, internal markers)
    // that are OUTSIDE the protected tail. Recent ones in the tail may contain
    // actionable info (e.g., background task IDs the agent needs for background_output).
    // Use the configured protected_tags count to find the boundary — messages in the
    // last N tags are kept.
    const protectedTailStart = Math.max(0, args.messages.length - args.protectedTags * 2);
    const strippedSystemInjected = stripSystemInjectedMessages(args.messages, protectedTailStart);
    if (strippedSystemInjected > 0) {
        sessionLog(
            args.sessionId,
            `stripped ${strippedSystemInjected} system-injected messages (notifications/reminders)`,
        );
    }

    const pendingUserTurnReminder = getPersistedStickyTurnReminder(args.db, args.sessionId);
    if (pendingUserTurnReminder) {
        if (args.hasRecentReduceCall) {
            clearPersistedStickyTurnReminder(args.db, args.sessionId);
            sessionLog(
                args.sessionId,
                "sticky turn reminder cleared — ctx_reduce found in recent messages",
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
        } else {
            args.nudgePlacements.clear(args.sessionId);
        }

        const canInjectDeferredNoteNudge = canAppendSupplementalNudgeToAssistant(
            args.messages,
            args.nudgePlacements,
            args.sessionId,
        );
        const deferredNoteText = getNotNudgeText(args.db, args.sessionId);
        if (deferredNoteText && canInjectDeferredNoteNudge) {
            appendSupplementalNudgeToAssistant(
                args.messages,
                `\n\n<instruction name="deferred_notes">${deferredNoteText}</instruction>`,
                args.nudgePlacements,
                args.sessionId,
            );
        }
    } else {
        args.nudgePlacements.clear(args.sessionId);
    }
}
