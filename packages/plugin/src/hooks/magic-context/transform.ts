import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import type { Scheduler } from "../../features/magic-context/scheduler";

import {
    type ContextDatabase,
    getHistorianFailureState,
    getOrCreateSessionMeta,
    getTagsBySession,
    type getTopNBySize,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import type { Tagger } from "../../features/magic-context/tagger";
import type { ContextUsage, TagEntry } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import { getActiveCompartmentRun, startCompartmentAgent } from "./compartment-runner";
import { FORCE_MATERIALIZE_PERCENTAGE } from "./compartment-trigger";
import { resolveExecuteThreshold } from "./event-resolvers";
import { estimateImageTokensFromDataUrl } from "./image-token-estimate";
import {
    type PreparedCompartmentInjection,
    prepareCompartmentInjection,
} from "./inject-compartments";
import { onNoteTrigger } from "./note-nudger";
import type { NudgePlacementStore } from "./nudge-placement-store";
import type { ContextNudge } from "./nudger";
import { getProtectedTailStartOrdinal, getRawSessionMessageCount } from "./read-session-chunk";
import { estimateTokens } from "./read-session-formatting";
import { sendIgnoredMessage } from "./send-session-notification";
import {
    replayClearedReasoning,
    replayStrippedInlineThinking,
    stripClearedReasoning,
    stripReasoningFromMergedAssistants,
} from "./strip-content";
import { runCompartmentPhase } from "./transform-compartment-phase";
import { loadContextUsage, resolveSchedulerDecision } from "./transform-context-state";
import { findLastUserMessageId, findSessionId } from "./transform-message-helpers";
import {
    applyFlushedStatuses,
    type MessageLike,
    stripStructuralNoise,
    type TagTarget,
    tagMessages,
} from "./transform-operations";
import { runPostTransformPhase } from "./transform-postprocess-phase";
import { logTransformTiming } from "./transform-stage-logger";

export { createNudgePlacementStore, type NudgePlacementStore } from "./nudge-placement-store";

import { clearHistorianFailureState } from "../../features/magic-context/storage-meta-persisted";
import type { LiveModelBySession } from "./hook-handlers";

/**
 * Extract the provider/model from the last assistant message in the array.
 * Used for early model-change detection before loadContextUsage.
 */
function findLastAssistantModel(
    messages: MessageLike[],
): { providerID: string; modelID: string } | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        // OpenCode message objects have providerID/modelID under info, though
        // our narrow MessageInfo type doesn't declare them.
        const info = messages[i].info as {
            role?: string;
            providerID?: string;
            modelID?: string;
        };
        if (info.role === "assistant" && info.providerID && info.modelID) {
            return { providerID: info.providerID, modelID: info.modelID };
        }
    }
    return null;
}

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
    dropToolStructure?: boolean;
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
    /**
     * Returns the historian chunk budget. Called at each historian spawn site
     * so the value is always derived from current config — keeping hook,
     * RPC, and TUI trigger paths consistent and honoring runtime config changes.
     * Optional for tests; production (hook.ts) always provides it.
     */
    getHistorianChunkTokens?: () => number;
    historyBudgetPercentage?: number;
    executeThresholdPercentage?: number | { default: number; [modelKey: string]: number };
    historianTimeoutMs?: number;
    getNotificationParams?: (
        sessionId: string,
    ) => import("./send-session-notification").NotificationParams;
    getModelKey?: (sessionId: string) => string | undefined;
    getFallbackModelId?: (sessionId: string) => string | undefined;
    projectPath?: string;
    experimentalCompactionMarkers?: boolean;
    experimentalUserMemories?: boolean;
    liveModelBySession?: LiveModelBySession;
}

export function createTransform(deps: TransformDeps) {
    const loadedSessions = new Set<string>();
    const lastEmergencyNotificationCount = new Map<string, number>();

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
        logTransformTiming(sessionId, "findSessionId", startTime, `messages=${messages.length}`);

        const db = deps.db;
        const tUserMsg = performance.now();
        const currentTurnId = findLastUserMessageId(messages);
        logTransformTiming(sessionId, "findLastUserMessageId", tUserMsg);

        const tMeta = performance.now();
        let sessionMeta: import("../../features/magic-context/types").SessionMeta | undefined;
        try {
            // Intentional fail-open: magic-context should not block live chat if session state read fails.
            sessionMeta = getOrCreateSessionMeta(db, sessionId);
        } catch (error) {
            sessionLog(sessionId, "transform failed reading session meta:", error);
            return;
        }
        logTransformTiming(sessionId, "getOrCreateSessionMeta", tMeta);

        // System prompt change detection is handled in experimental.chat.system.transform
        // (see system-prompt-hash.ts), not here. The messages transform only receives
        // user/assistant messages, not the system prompt.

        const reducedMode = sessionMeta.isSubagent;
        const fullFeatureMode = !reducedMode;
        const compartmentDirectory = deps.directory ?? "";
        const canRunCompartments =
            fullFeatureMode && deps.client !== undefined && compartmentDirectory.length > 0;
        const fallbackModelId = deps.getFallbackModelId?.(sessionId);

        const tModelDetect = performance.now();
        // Detect model changes early in the transform — BEFORE loading context usage.
        // When a user switches models (e.g., 128K→1M), the persisted lastContextPercentage
        // reflects the old model's context limit. If we don't clear it, the 95% blocking
        // threshold can deadlock the session: transform blocks awaiting historian,
        // but no message.updated event fires to clear the stale percentage because
        // the transform never completes.
        // NOTE: This detection only works AFTER the first assistant response on the new model,
        // because findLastAssistantModel reads the latest assistant message in history.
        // Before that first response, the last assistant message is still from the old model.
        // The first-pass reset (below) handles the restart case. Mid-session model switches
        // without restart rely on the first message.updated to trigger hook-handler clearing.
        // A brief stale-percentage window exists between the model switch and first response.
        if (deps.liveModelBySession) {
            const lastAssistantModel = findLastAssistantModel(messages);
            if (lastAssistantModel) {
                const knownModel = deps.liveModelBySession.get(sessionId);
                if (
                    knownModel &&
                    (knownModel.providerID !== lastAssistantModel.providerID ||
                        knownModel.modelID !== lastAssistantModel.modelID)
                ) {
                    sessionLog(
                        sessionId,
                        `transform: model change detected (${knownModel.providerID}/${knownModel.modelID} -> ${lastAssistantModel.providerID}/${lastAssistantModel.modelID}), clearing stale context state`,
                    );
                    deps.liveModelBySession.set(sessionId, lastAssistantModel);
                    updateSessionMeta(db, sessionId, {
                        lastContextPercentage: 0,
                        lastInputTokens: 0,
                    });
                    clearHistorianFailureState(db, sessionId);
                    // Also clear the in-memory usage map so loadContextUsage gets fresh values
                    deps.contextUsageMap.delete(sessionId);
                }
            }
        }

        logTransformTiming(sessionId, "modelChangeDetection", tModelDetect);
        logTransformTiming(sessionId, "schedulerAndUsage", tModelDetect);
        const tFirstPass = performance.now();
        const isFirstTransformPassForSession = !loadedSessions.has(sessionId);
        loadedSessions.add(sessionId);

        // First-pass reset MUST run BEFORE loadContextUsage so threshold checks
        // (95% blocking, 80% emergency nudge) don't fire on stale data from a
        // different model, reverted message, or previous session state.
        // Snapshot failure state BEFORE reset — restart recovery needs it.
        const historianFailureState = getHistorianFailureState(db, sessionId);

        if (isFirstTransformPassForSession && sessionMeta) {
            const persistedPct = sessionMeta.lastContextPercentage ?? 0;
            if (persistedPct > 0) {
                sessionLog(
                    sessionId,
                    `transform: first pass reset — percentage=${persistedPct.toFixed(1)}% — clearing stale usage state`,
                );
                updateSessionMeta(db, sessionId, {
                    lastContextPercentage: 0,
                    lastInputTokens: 0,
                    // Do NOT clear compartmentInProgress here — runCompartmentPhase needs it
                    // to resume a historian run that was in progress when the process restarted.
                    // The compartment phase checks hasEligibleHistoryForCompartment() and either
                    // starts a new run or clears the flag if there's no eligible history.
                });
                // Do NOT clear historian failure state here — restart recovery uses it
                deps.contextUsageMap.delete(sessionId);
                // Update local sessionMeta copy so downstream checks don't use stale values
                sessionMeta = { ...sessionMeta, lastContextPercentage: 0, lastInputTokens: 0 };
            }
        }

        // Compute context usage AFTER first-pass reset so threshold checks use
        // clean state (0%) instead of stale values from a previous model/session.
        const contextUsageEarly = loadContextUsage(deps.contextUsageMap, db, sessionId);
        const historyBudgetTokens = resolveHistoryBudgetTokens(
            deps.historyBudgetPercentage,
            contextUsageEarly,
            deps.executeThresholdPercentage,
            deps.getModelKey?.(sessionId),
        );
        const schedulerDecisionEarly = resolveSchedulerDecision(
            deps.scheduler,
            sessionMeta,
            contextUsageEarly,
            sessionId,
            deps.getModelKey?.(sessionId),
        );
        // isCacheBusting controls whether the injection cache is bypassed.
        // Only true on explicit flushes — NOT on scheduler "execute" passes.
        const isCacheBusting = deps.flushedSessions.has(sessionId);
        if (historianFailureState.failureCount === 0) {
            lastEmergencyNotificationCount.delete(sessionId);
        }

        const notificationParams = deps.getNotificationParams?.(sessionId) ?? {};
        // Lazy: only compute when emergency/recovery blocks need it (failureCount > 0)
        let _eligibleHistoryCache: boolean | undefined;
        const getEligibleHistoryForCompartment = (): boolean => {
            if (_eligibleHistoryCache === undefined) {
                _eligibleHistoryCache = canRunCompartments
                    ? hasEligibleCompartmentHistory(db, resolvedSessionId)
                    : false;
            }
            return _eligibleHistoryCache;
        };
        let skipCompartmentAwaitForThisPass = false;

        const startRecoveryRun = (): boolean => {
            if (!canRunCompartments || !deps.client || !getEligibleHistoryForCompartment()) {
                return false;
            }
            if (getActiveCompartmentRun(sessionId)) {
                return false;
            }

            updateSessionMeta(db, sessionId, { compartmentInProgress: true });
            startCompartmentAgent({
                client: deps.client,
                db,
                sessionId,
                historianChunkTokens: deps.getHistorianChunkTokens?.() ?? 20_000,
                historyBudgetTokens,
                historianTimeoutMs: deps.historianTimeoutMs,
                directory: compartmentDirectory,
                fallbackModelId,
                getNotificationParams: () => notificationParams,
                experimentalCompactionMarkers: deps.experimentalCompactionMarkers,
                experimentalUserMemories: deps.experimentalUserMemories,
            });
            skipCompartmentAwaitForThisPass = true;
            return true;
        };

        if (
            fullFeatureMode &&
            historianFailureState.failureCount > 0 &&
            contextUsageEarly.percentage >= 95
        ) {
            skipCompartmentAwaitForThisPass = true;
            const emergencyPercentage = contextUsageEarly.percentage.toFixed(1);
            const abortingClient = deps.client as
                | {
                      session?: { abort?: (input: { path: { id: string } }) => Promise<unknown> };
                  }
                | undefined;
            if (typeof abortingClient?.session?.abort === "function") {
                void abortingClient.session
                    .abort({ path: { id: sessionId } })
                    .catch((error: unknown) => {
                        sessionLog(
                            sessionId,
                            "transform: emergency abort failed:",
                            getErrorMessage(error),
                        );
                    });
            }

            const lastNotifiedCount = lastEmergencyNotificationCount.get(sessionId) ?? 0;
            if (deps.client && historianFailureState.failureCount > lastNotifiedCount) {
                lastEmergencyNotificationCount.set(sessionId, historianFailureState.failureCount);
                void sendIgnoredMessage(
                    deps.client,
                    sessionId,
                    `⚠️ Context Emergency — Context is at ${emergencyPercentage}% and historian has failed ${historianFailureState.failureCount} times (last error: ${truncateHistorianEmergencyError(historianFailureState.lastError)}). Aborting this message to prevent context overflow. Historian will retry automatically. If this persists, change your historian model in magic-context.jsonc and restart OpenCode.`,
                    notificationParams,
                );
            }

            startRecoveryRun();
            sessionLog(
                sessionId,
                `EMERGENCY: aborting session at ${emergencyPercentage}%, historian failures: ${historianFailureState.failureCount}`,
            );
        } else if (
            fullFeatureMode &&
            isFirstTransformPassForSession &&
            historianFailureState.failureCount > 0 &&
            getEligibleHistoryForCompartment() &&
            startRecoveryRun()
        ) {
            sessionLog(
                sessionId,
                `transform: historian recovery triggered on session load after ${historianFailureState.failureCount} failure(s)`,
            );
            if (deps.client) {
                void sendIgnoredMessage(
                    deps.client,
                    sessionId,
                    `## Historian recovery\n\nHistorian previously failed ${historianFailureState.failureCount} time(s), so magic-context is retrying compaction immediately after restart.`,
                    notificationParams,
                );
            }
        }

        logTransformTiming(sessionId, "emergencyRecoveryBlock", tFirstPass);

        let pendingCompartmentInjection: PreparedCompartmentInjection | null = null;
        if (fullFeatureMode) {
            const tInj = performance.now();
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
            logTransformTiming(sessionId, "prepareCompartmentInjection", tInj);
        }

        let targets = new Map<number, TagTarget>();
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

        // Strip reasoning from non-first assistants in consecutive runs to
        // avoid @ai-sdk/anthropic's groupIntoBlocks producing interleaved
        // thinking blocks that Opus 4.7 rejects. See strip-content.ts for
        // full explanation.
        const tMergeStrip = performance.now();
        const strippedMergedReasoning = stripReasoningFromMergedAssistants(messages);
        if (strippedMergedReasoning > 0) {
            sessionLog(
                sessionId,
                `stripped ${strippedMergedReasoning} reasoning parts from merged assistants (anthropic groupIntoBlocks workaround)`,
            );
        }
        logTransformTiming(
            sessionId,
            "stripReasoningFromMergedAssistants",
            tMergeStrip,
            `strippedParts=${strippedMergedReasoning}`,
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
        const tCompartmentPhase = performance.now();
        const compartmentPhase = await runCompartmentPhase({
            canRunCompartments,
            fullFeatureMode,
            sessionMeta,
            contextUsage,
            client: deps.client,
            db,
            sessionId,
            resolvedSessionId,
            historianChunkTokens: deps.getHistorianChunkTokens?.() ?? 20_000,
            historyBudgetTokens,
            historianTimeoutMs: deps.historianTimeoutMs,
            compartmentDirectory,
            messages,
            pendingCompartmentInjection,
            fallbackModelId,
            projectPath: deps.memoryConfig?.enabled
                ? resolveProjectIdentity(deps.directory ?? process.cwd())
                : undefined,
            injectionBudgetTokens: deps.memoryConfig?.injectionBudgetTokens,
            getNotificationParams: rawGetNotifParams
                ? () => rawGetNotifParams(sessionId)
                : undefined,
            // The compressor needs to know if this is a safe pass to run on.
            // Scheduler "execute" passes are safe for compressor (they already bust cache
            // via pending ops), but isCacheBusting is now narrower (flush-only) for injection cache.
            cacheAlreadyBusting: isCacheBusting || schedulerDecisionEarly === "execute",
            skipAwaitForThisPass: skipCompartmentAwaitForThisPass,
            experimentalCompactionMarkers: deps.experimentalCompactionMarkers,
            experimentalUserMemories: deps.experimentalUserMemories,
        });
        pendingCompartmentInjection = compartmentPhase.pendingCompartmentInjection;
        const awaitedCompartmentRun = compartmentPhase.awaitedCompartmentRun;
        const compartmentInProgress = compartmentPhase.compartmentInProgress;
        sessionMeta = { ...sessionMeta, compartmentInProgress };
        logTransformTiming(sessionId, "compartmentPhase", tCompartmentPhase);

        const tPostProcess = performance.now();
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
            dropToolStructure: deps.dropToolStructure ?? true,
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
        logTransformTiming(sessionId, "postTransformPhase", tPostProcess);

        // Estimate the total token size of the transformed messages array so
        // the sidebar / dashboard can attribute inputTokens between System
        // (from system.transform), Tool Definitions (inferred as the
        // remainder), and Conversation (actual messages minus injected
        // compartments/facts/memories).
        //
        // Counts every token-bearing field across all part types Anthropic
        // serializes: text, reasoning (signed thinking we still forward for
        // the latest assistant), tool inputs, tool outputs, tool_result
        // content. Previously only `text` parts were counted, which produced
        // ~10x underestimates on sessions with long tool traces and pushed
        // the delta into Tool Definitions. This value intentionally includes
        // the injected <session-history> block — the display layer subtracts
        // compartmentTokens/factTokens/memoryTokens to isolate real
        // user/assistant conversation.
        let conversationTokens = 0;
        for (const message of messages) {
            for (const part of message.parts) {
                if (!part || typeof part !== "object") continue;
                const p = part as {
                    type?: string
                    text?: string
                    ignored?: boolean
                    state?: { input?: unknown; output?: unknown }
                    args?: unknown
                    input?: unknown
                    content?: unknown
                    mime?: string
                    metadata?: { anthropic?: { signature?: string } }
                }
                if (p.ignored) continue;
                switch (p.type) {
                    case "text": {
                        if (typeof p.text === "string")
                            conversationTokens += estimateTokens(p.text);
                        break;
                    }
                    case "reasoning": {
                        if (typeof p.text === "string")
                            conversationTokens += estimateTokens(p.text);
                        // Signed reasoning carries an anthropic signature that
                        // is billed as input tokens on the wire. Typical size
                        // ~2,400 chars / ~600 tokens per block.
                        const sig = p.metadata?.anthropic?.signature;
                        if (typeof sig === "string")
                            conversationTokens += estimateTokens(sig);
                        break;
                    }
                    case "file": {
                        // Images: Anthropic bills by visual tokens using
                        // (width × height) / 750. Parse PNG/JPEG/WebP/GIF
                        // headers from the data URL to get real dimensions
                        // instead of over-estimating from base64 char length.
                        // https://docs.claude.com/en/build-with-claude/vision
                        if (typeof p.mime === "string" && p.mime.startsWith("image/")) {
                            const url =
                                typeof (p as { url?: unknown }).url === "string"
                                    ? (p as { url: string }).url
                                    : undefined;
                            if (url && url.startsWith("data:")) {
                                conversationTokens += estimateImageTokensFromDataUrl(url);
                            } else {
                                conversationTokens += 1200; // fallback for non-data-url refs
                            }
                        }
                        break;
                    }
                    case "tool": {
                        // OpenCode format: { state: { input, output } }
                        if (p.state && typeof p.state === "object") {
                            if (p.state.input !== undefined) {
                                const s =
                                    typeof p.state.input === "string"
                                        ? p.state.input
                                        : JSON.stringify(p.state.input)
                                if (s) conversationTokens += estimateTokens(s)
                            }
                            if (p.state.output !== undefined) {
                                const s =
                                    typeof p.state.output === "string"
                                        ? p.state.output
                                        : JSON.stringify(p.state.output)
                                if (s) conversationTokens += estimateTokens(s)
                            }
                        }
                        break
                    }
                    case "tool-invocation": {
                        if (p.args !== undefined) {
                            const s =
                                typeof p.args === "string" ? p.args : JSON.stringify(p.args)
                            if (s) conversationTokens += estimateTokens(s)
                        }
                        break
                    }
                    case "tool_use": {
                        if (p.input !== undefined) {
                            const s =
                                typeof p.input === "string" ? p.input : JSON.stringify(p.input)
                            if (s) conversationTokens += estimateTokens(s)
                        }
                        break
                    }
                    case "tool_result": {
                        if (p.content !== undefined) {
                            const s =
                                typeof p.content === "string"
                                    ? p.content
                                    : JSON.stringify(p.content)
                            if (s) conversationTokens += estimateTokens(s)
                        }
                        break
                    }
                }
            }
        }
        try {
            updateSessionMeta(db, sessionId, { conversationTokens });
        } catch (error) {
            // Pure display/telemetry optimization — never fail transform on a
            // BUSY/transient error here. Next pass will refresh the value.
            const code = (error as { code?: string } | null)?.code;
            if (code !== "SQLITE_BUSY") {
                sessionLog(sessionId, "conversation_tokens UPDATE failed:", error);
            }
        }

        const elapsed = (performance.now() - startTime).toFixed(1);
        sessionLog(
            sessionId,
            `transform completed in ${elapsed}ms (${messages.length} messages, ${targets.size} targets, watermark: ${watermark})`,
        );
    };
}

function hasEligibleCompartmentHistory(db: ContextDatabase, sessionId: string): boolean {
    try {
        const lastCompartmentEnd = getLastCompartmentEndMessage(db, sessionId);
        const nextStartOrdinal = Math.max(1, lastCompartmentEnd + 1);
        const rawMessageCount = getRawSessionMessageCount(sessionId);
        const protectedTailStart = getProtectedTailStartOrdinal(sessionId);

        return rawMessageCount >= nextStartOrdinal && nextStartOrdinal < protectedTailStart;
    } catch (error) {
        sessionLog(sessionId, "transform: failed checking eligible compartment history:", error);
        return false;
    }
}

function resolveHistoryBudgetTokens(
    historyBudgetPercentage: number | undefined,
    contextUsage: ContextUsage,
    executeThresholdPercentage:
        | number
        | { default: number; [modelKey: string]: number }
        | undefined,
    modelKey: string | undefined,
): number | undefined {
    if (!historyBudgetPercentage || contextUsage.percentage <= 0) {
        return undefined;
    }

    return Math.floor(
        (contextUsage.inputTokens / (contextUsage.percentage / 100)) *
            (resolveExecuteThreshold(executeThresholdPercentage ?? 65, modelKey, 65) / 100) *
            historyBudgetPercentage,
    );
}

function truncateHistorianEmergencyError(error: string | null): string {
    const normalized = (error ?? "unknown error").replace(/\s+/g, " ").trim();
    if (normalized.length <= 100) {
        return normalized;
    }

    return `${normalized.slice(0, 100)}…`;
}
