import { DEFAULT_COMPARTMENT_TOKEN_BUDGET } from "../../config/schema/magic-context";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import type { Scheduler } from "../../features/magic-context/scheduler";

import {
    type ContextDatabase,
    getOrCreateSessionMeta,
    getTagsBySession,
    type getTopNBySize,
} from "../../features/magic-context/storage";
import type { Tagger } from "../../features/magic-context/tagger";
import type { ContextUsage, TagEntry } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import { sessionLog } from "../../shared/logger";
import { FORCE_MATERIALIZE_PERCENTAGE } from "./compartment-trigger";
import {
    type PreparedCompartmentInjection,
    prepareCompartmentInjection,
} from "./inject-compartments";
import { onNoteTrigger } from "./note-nudger";
import type { NudgePlacementStore } from "./nudge-placement-store";
import type { ContextNudge } from "./nudger";
import {
    replayClearedReasoning,
    replayStrippedInlineThinking,
    stripClearedReasoning,
} from "./strip-content";
import { runCompartmentPhase } from "./transform-compartment-phase";
import { loadContextUsage, resolveSchedulerDecision } from "./transform-context-state";
import { findLastUserMessageId, findSessionId } from "./transform-message-helpers";
import {
    applyFlushedStatuses,
    type MessageLike,
    stripStructuralNoise,
    tagMessages,
} from "./transform-operations";
import { runPostTransformPhase } from "./transform-postprocess-phase";
import { logTransformTiming } from "./transform-stage-logger";

export { createNudgePlacementStore, type NudgePlacementStore } from "./nudge-placement-store";

export interface TransformDeps {
    tagger: Tagger;
    scheduler: Scheduler;
    contextUsageMap: Map<string, { usage: ContextUsage; updatedAt: number }>;
    nudger: (
        sessionId: string,
        contextUsage: ContextUsage,
        db: ContextDatabase,
        topNFn: typeof getTopNBySize,
        preloadedTags?: TagEntry[],
        messagesSinceLastUser?: number,
        preloadedSessionMeta?: import("../../features/magic-context/types").SessionMeta,
    ) => ContextNudge | null;
    db: ContextDatabase;
    nudgePlacements: NudgePlacementStore;
    protectedTags: number;
    autoDropToolAge: number;
    clearReasoningAge: number;
    flushedSessions: Set<string>;
    lastHeuristicsTurnId: Map<string, string>;
    commitSeenLastPass?: Map<string, boolean>;
    client?: PluginContext["client"];
    directory?: string;
    memoryConfig?: {
        enabled: boolean;
        injectionBudgetTokens: number;
    };
    compartmentTokenBudget?: number;
    historyBudgetPercentage?: number;
    executeThresholdPercentage?: number | { default: number; [modelKey: string]: number };
    historianTimeoutMs?: number;
    getNotificationParams?: (
        sessionId: string,
    ) => import("./send-session-notification").NotificationParams;
    getModelKey?: (sessionId: string) => string | undefined;
    projectPath?: string;
}

export function createTransform(deps: TransformDeps) {
    return async (
        _input: Record<string, never>,
        output: { messages: unknown[] },
    ): Promise<void> => {
        const startTime = performance.now();
        const messages = output.messages as MessageLike[];
        const sessionId = findSessionId(messages);
        if (!sessionId) {
            return;
        }
        const resolvedSessionId = sessionId;

        const db = deps.db;
        const currentTurnId = findLastUserMessageId(messages);

        let sessionMeta: import("../../features/magic-context/types").SessionMeta | undefined;
        try {
            // Intentional fail-open: magic-context should not block live chat if session state read fails.
            sessionMeta = getOrCreateSessionMeta(db, sessionId);
        } catch (error) {
            sessionLog(sessionId, "transform failed reading session meta:", error);
            return;
        }

        // System prompt change detection is handled in experimental.chat.system.transform
        // (see system-prompt-hash.ts), not here. The messages transform only receives
        // user/assistant messages, not the system prompt.

        const reducedMode = sessionMeta.isSubagent;
        const fullFeatureMode = !reducedMode;
        const compartmentDirectory = deps.directory ?? "";
        const canRunCompartments =
            fullFeatureMode && deps.client !== undefined && compartmentDirectory.length > 0;

        // Compute cache-busting status early so compartment injection can use it.
        // The scheduler and flush state are available before tagging.
        const contextUsageEarly = loadContextUsage(deps.contextUsageMap, db, sessionId);
        const schedulerDecisionEarly = resolveSchedulerDecision(
            deps.scheduler,
            sessionMeta,
            contextUsageEarly,
            sessionId,
            deps.getModelKey?.(sessionId),
        );
        const isCacheBusting =
            deps.flushedSessions.has(sessionId) || schedulerDecisionEarly === "execute";

        let pendingCompartmentInjection: PreparedCompartmentInjection | null = null;
        if (fullFeatureMode) {
            const projectPath = deps.memoryConfig?.enabled
                ? resolveProjectIdentity(deps.directory ?? process.cwd())
                : undefined;
            pendingCompartmentInjection = prepareCompartmentInjection(
                db,
                sessionId,
                messages,
                isCacheBusting,
                projectPath,
                deps.memoryConfig?.injectionBudgetTokens,
            );
        }

        let targets = new Map<number, { setContent: (content: string) => boolean }>();
        // ──────────────────────────────────────────────────────────────────────

        let reasoningByMessage = new Map<
            MessageLike,
            { type: string; thinking?: string; text?: string }[]
        >();
        let messageTagNumbers = new Map<MessageLike, number>();
        let batch: { finalize: () => void } | null = null;
        let hasRecentReduceCall = false;
        try {
            const t0 = performance.now();
            deps.tagger.initFromDb(sessionId, db);
            const result = tagMessages(sessionId, messages, deps.tagger, db);
            targets = result.targets;
            reasoningByMessage = result.reasoningByMessage;
            messageTagNumbers = result.messageTagNumbers;
            batch = result.batch;
            hasRecentReduceCall = result.hasRecentReduceCall;
            const hadPriorCommitState = deps.commitSeenLastPass?.has(sessionId) ?? false;
            const sawCommitLastPass = deps.commitSeenLastPass?.get(sessionId) ?? false;
            // Only trigger on NEW commits — not on first pass after restart where
            // we have no baseline. First pass establishes the baseline silently.
            if (hadPriorCommitState && result.hasRecentCommit && !sawCommitLastPass) {
                onNoteTrigger(db, sessionId, "commit_detected");
            }
            deps.commitSeenLastPass?.set(sessionId, result.hasRecentCommit);
            logTransformTiming(sessionId, "tagMessages", t0);
        } catch (error) {
            sessionLog(
                sessionId,
                "transform tag persistence failed; continuing without tagging:",
                error,
            );
        }

        const t1 = performance.now();
        const tags = getTagsBySession(db, sessionId);
        logTransformTiming(sessionId, "getTagsBySession", t1, `count=${tags.length}`);

        let didMutateFromFlushedStatuses = false;
        try {
            const t2 = performance.now();
            didMutateFromFlushedStatuses = applyFlushedStatuses(sessionId, db, targets, tags);
            logTransformTiming(sessionId, "applyFlushedStatuses", t2);
            batch?.finalize();
            logTransformTiming(sessionId, "batchFinalize:flushed", t2);
        } catch (error) {
            sessionLog(sessionId, "transform failed applying flushed statuses:", error);
            // Only clear on cache-busting passes to avoid re-anchor on next defer (Finding 2).
            if (isCacheBusting) deps.nudgePlacements.clear(sessionId);
        }
        if (didMutateFromFlushedStatuses && isCacheBusting) {
            deps.nudgePlacements.clear(sessionId);
        }

        const t3 = performance.now();
        const strippedStructuralNoise = stripStructuralNoise(messages);
        logTransformTiming(
            sessionId,
            "stripStructuralNoise",
            t3,
            `strippedParts=${strippedStructuralNoise}`,
        );

        // Replay persisted reasoning clearing on EVERY pass (including defer).
        // This ensures reasoning cleared on a previous cache-busting pass stays cleared
        // even when OpenCode rebuilds messages fresh from its own DB.
        const persistedReasoningWatermark = sessionMeta?.clearedReasoningThroughTag ?? 0;
        if (persistedReasoningWatermark > 0) {
            const tReplay = performance.now();
            const replayed = replayClearedReasoning(
                messages,
                reasoningByMessage,
                messageTagNumbers,
                persistedReasoningWatermark,
            );
            const replayedInline = replayStrippedInlineThinking(
                messages,
                messageTagNumbers,
                persistedReasoningWatermark,
            );
            if (replayed > 0 || replayedInline > 0) {
                sessionLog(
                    sessionId,
                    `reasoning replay: cleared=${replayed} inlineStripped=${replayedInline} (watermark=${persistedReasoningWatermark})`,
                );
            }
            logTransformTiming(sessionId, "replayReasoningClearing", tReplay);
        }

        const t4 = performance.now();
        const strippedClearedReasoning = stripClearedReasoning(messages);
        logTransformTiming(
            sessionId,
            "stripClearedReasoning",
            t4,
            `strippedParts=${strippedClearedReasoning}`,
        );

        let watermark = 0;
        for (const tag of tags) {
            if (tag.status === "dropped" && tag.tagNumber > watermark) {
                watermark = tag.tagNumber;
            }
        }

        // Reuse the early scheduler result — inputs haven't changed.
        const contextUsage = contextUsageEarly;
        const schedulerDecision = schedulerDecisionEarly;
        const rawGetNotifParams = deps.getNotificationParams;
        const compartmentPhase = await runCompartmentPhase({
            canRunCompartments,
            fullFeatureMode,
            sessionMeta,
            contextUsage,
            client: deps.client,
            db,
            sessionId,
            resolvedSessionId,
            compartmentTokenBudget: deps.compartmentTokenBudget ?? DEFAULT_COMPARTMENT_TOKEN_BUDGET,
            historyBudgetTokens:
                deps.historyBudgetPercentage && contextUsage.percentage > 0
                    ? Math.floor(
                          (contextUsage.inputTokens / (contextUsage.percentage / 100)) *
                              (Math.min(
                                  typeof deps.executeThresholdPercentage === "number"
                                      ? deps.executeThresholdPercentage
                                      : (deps.executeThresholdPercentage?.default ?? 80),
                                  80,
                              ) /
                                  100) *
                              deps.historyBudgetPercentage,
                      )
                    : undefined,
            historianTimeoutMs: deps.historianTimeoutMs,
            compartmentDirectory,
            messages,
            pendingCompartmentInjection,
            projectPath: deps.memoryConfig?.enabled
                ? resolveProjectIdentity(deps.directory ?? process.cwd())
                : undefined,
            injectionBudgetTokens: deps.memoryConfig?.injectionBudgetTokens,
            getNotificationParams: rawGetNotifParams
                ? () => rawGetNotifParams(sessionId)
                : undefined,
            cacheAlreadyBusting: isCacheBusting,
        });
        pendingCompartmentInjection = compartmentPhase.pendingCompartmentInjection;
        const awaitedCompartmentRun = compartmentPhase.awaitedCompartmentRun;
        const compartmentInProgress = compartmentPhase.compartmentInProgress;
        sessionMeta = { ...sessionMeta, compartmentInProgress };

        runPostTransformPhase({
            sessionId,
            db,
            messages,
            tags,
            targets,
            reasoningByMessage,
            messageTagNumbers,
            batch,
            contextUsage,
            schedulerDecision,
            fullFeatureMode,
            canRunCompartments,
            awaitedCompartmentRun,
            compartmentInProgress,
            sessionMeta,
            currentTurnId,
            flushedSessions: deps.flushedSessions,
            lastHeuristicsTurnId: deps.lastHeuristicsTurnId,
            autoDropToolAge: deps.autoDropToolAge,
            clearReasoningAge: deps.clearReasoningAge,
            protectedTags: deps.protectedTags,
            nudgePlacements: deps.nudgePlacements,
            nudger: deps.nudger,
            pendingCompartmentInjection,
            didMutateFromFlushedStatuses,
            watermark,
            forceMaterializationPercentage: FORCE_MATERIALIZE_PERCENTAGE,
            hasRecentReduceCall,
            projectPath: deps.projectPath,
        });

        const elapsed = (performance.now() - startTime).toFixed(1);
        sessionLog(
            sessionId,
            `transform completed in ${elapsed}ms (${messages.length} messages, ${targets.size} targets, watermark: ${watermark})`,
        );
    };
}
