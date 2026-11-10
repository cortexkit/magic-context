import type { MagicContextConfig } from "../../config/schema/magic-context";
import { capDreamerReadOutput } from "../../features/magic-context/dreamer/verify-read-cap";
import {
    clearSessionTracking,
    scheduleIncrementalIndex,
    scheduleReconciliation,
} from "../../features/magic-context/message-index-async";
import { clearPersistedReasoningWatermark } from "../../features/magic-context/storage";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import {
    clearDetectedContextLimit,
    clearEmergencyDropSample,
    clearEmergencyRecovery,
    clearHistorianFailureState,
    getChannel1NudgeState,
    getLastNudgeUndropped,
    markChannel1PostReduceGracePending,
    setChannel1NudgeState,
    setLastNudgeUndropped,
} from "../../features/magic-context/storage-meta-persisted";
import { clearSidebarSnapshotCache } from "../../plugin/sidebar-snapshot-cache";
import type { PluginContext } from "../../plugin/types";
import { seedSessionCacheTtlIfUnsynced } from "../../shared/cache-ttl-seed";
import { sessionLog } from "../../shared/logger";
import { clearAutoSearchForSession } from "./auto-search-runner";
import type { CommandExecuteInput, CommandExecuteOutput } from "./command-handler";
import {
    cachedToolPermissionDenied,
    resolveTodowriteAvailability,
    todowritePermissionDenied,
} from "./ctx-reduce-availability";
import {
    buildChannel1Reminder,
    CHANNEL1_SENTINEL,
    type Channel1State,
    currentReclaimableToolOutputCount,
    decideChannel1,
    formatChannel1Evaluation,
    toolOutputTokens,
} from "./ctx-reduce-nudge";
import { annotateEmptyTaskOutput } from "./empty-task-output";
import {
    getMessageUpdatedAssistantInfo,
    getMessageUpdatedInfo,
    getSessionProperties,
} from "./event-payloads";
import { resolveSessionId as resolveEventSessionId } from "./event-resolvers";
import { dropSlot } from "./lkg-slot";
import {
    clearNoteNudgeTriggerAndCooldown,
    onNoteTrigger,
    resetNoteNudgeCooldownOnly,
} from "./note-nudger";
import { logNudgeEvaluation } from "./nudge-evaluation-log";
import { readRawSessionMessageById, readRawSessionMessages } from "./read-session-chunk";
import {
    clearIgnoredMessages,
    flushIgnoredMessages,
    observeIgnoredNotificationEvent,
} from "./send-session-notification";
import { variantChangeBustsProviderCache } from "./sentinel";
import { matchStrippedMagicContextCommand } from "./stripped-command";
import { CLEARED_TODO_STATE_JSON, normalizeTodoStateJson } from "./todo-view";

export type LiveModelBySession = Map<string, { providerID: string; modelID: string }>;
export type LatestAssistantMessageIdBySession = Map<string, string>;
export type VariantBySession = Map<string, string | undefined>;
export type AgentBySession = Map<string, string>;

/**
 * Cache-busting signal sets — replaces the old monolithic `flushedSessions`.
 *
 * The old `Set<string>` conflated three independent lifetimes into one flag,
 * which caused defer passes blocked by an in-progress historian to keep
 * re-firing the same flush signal across multiple turns (Oracle review,
 * 2026-04-26). Each set now has exactly one consumer and one lifetime.
 *
 * Design rule: every producer that wants to refresh state should `add` to
 * EVERY set whose consumer needs to react. Consumers are responsible for
 * draining their own set after they consume the signal.
 */

/**
 * One-shot: signals that `<session-history>` (compartments + facts +
 * memories block in `message[0]`) needs to be rebuilt on the very next
 * pass. Consumed by `prepareCompartmentInjection()` in `transform.ts`,
 * which drains the entry after invocation regardless of whether a rebuild
 * actually occurred — the next defer pass MUST hit the cache.
 *
 * Producers: `/ctx-flush`, real variant change, system-prompt hash change,
 * explicit user refresh paths (flush/recomp/variant/system-prompt hash).
 * Background historian/compressor publications use DeferredHistoryRefreshSessions.
 *
 * NOT a producer: the background compressor — its output deliberately
 * lands on the next natural cache-bust pass instead of forcing one.
 */
export type HistoryRefreshSessions = Set<string>;

/** Persistent deferred history refresh from background historian/compressor publication. */
export type DeferredHistoryRefreshSessions = Set<string>;

/**
 * One-shot: signals that the system-prompt adjuncts (project docs, user
 * profile, key files, sticky date) should be re-read from disk on the
 * very next system-transform call. Consumed by `system-prompt-hash.ts`,
 * which drains the entry after refreshing.
 *
 * Producers: `/ctx-flush`, real variant change, system-prompt hash change.
 *
 * NOT a producer: historian/compressor/recomp — those don't change disk
 * adjuncts, so refreshing them would burn IO for no reason.
 */
export type SystemPromptRefreshSessions = Set<string>;

/**
 * Persistent: signals that there are queued user `ctx_reduce` ops or
 * pending heuristic-cleanup work that MUST run, even if the current pass
 * can't safely run heuristics yet (e.g. a compartment run is active).
 * Consumed and drained by `transform-postprocess-phase.ts` only after
 * `shouldRunHeuristics` actually executes — survives any number of
 * blocked passes until the materialization succeeds.
 *
 * Producers: `/ctx-flush`, real variant change, system-prompt hash change,
 * explicit user refresh paths (flush/recomp/variant/system-prompt hash).
 * Background historian publications use DeferredMaterializationSessions.
 *
 * Why historian/recomp produce here too: those publish paths queue drop
 * ops via `queueDropsForCompartmentalizedMessages`. The next safe pass
 * needs to materialize those queued drops or context will accumulate.
 */
export type PendingMaterializationSessions = Set<string>;

/** Persistent deferred drop-materialization signal from background historian publication. */
export type DeferredMaterializationSessions = Set<string>;

/**
 * @deprecated Use `HistoryRefreshSessions`, `SystemPromptRefreshSessions`,
 * or `PendingMaterializationSessions` directly. Kept as a type alias only
 * for any external consumers that may still import it. Will be removed in
 * a future major.
 */
export type FlushedSessions = Set<string>;

export type LastHeuristicsTurnId = Map<string, string>;

type CommandNotificationParams = {
    agent?: string;
    variant?: string;
    providerId?: string;
    modelId?: string;
};

export interface MagicContextCommandHandler {
    "command.execute.before": (
        input: CommandExecuteInput,
        output: CommandExecuteOutput,
        params: CommandNotificationParams,
    ) => Promise<unknown>;
}

export function getLiveNotificationParams(
    sessionId: string,
    liveModelBySession: LiveModelBySession,
    variantBySession: VariantBySession,
    agentBySession?: AgentBySession,
    toastDurationMs?: number,
): {
    agent?: string;
    variant?: string;
    providerId?: string;
    modelId?: string;
    toastDurationMs?: number;
} {
    const model = liveModelBySession.get(sessionId);
    const variant = variantBySession.get(sessionId);
    const agent = agentBySession?.get(sessionId);
    return {
        ...(agent ? { agent } : {}),
        ...(variant ? { variant } : {}),
        ...(model ? { providerId: model.providerID, modelId: model.modelID } : {}),
        ...(typeof toastDurationMs === "number" ? { toastDurationMs } : {}),
    };
}

export function createChatMessageHook(args: {
    db: Parameters<typeof getOrCreateSessionMeta>[0];
    liveModelBySession: LiveModelBySession;
    variantBySession: VariantBySession;
    agentBySession: AgentBySession;
    /** Variant changes invalidate `<session-history>` injection cache and
     *  may pair with a different model whose pending drops still need to
     *  materialize — so a real variant flip signals all three sets. */
    historyRefreshSessions: HistoryRefreshSessions;
    systemPromptRefreshSessions: SystemPromptRefreshSessions;
    pendingMaterializationSessions: PendingMaterializationSessions;
    lastHeuristicsTurnId: LastHeuristicsTurnId;
    /** The native slash-command handler, reused when Desktop removes the slash. */
    commandHandler?: MagicContextCommandHandler;
    cacheTtlConfig?: MagicContextConfig["cache_ttl"];
}) {
    return async (
        input: {
            sessionID?: string;
            variant?: string;
            agent?: string;
            model?: { providerID?: string; modelID?: string };
        },
        output?: {
            parts?: Array<{
                type: string;
                text?: string;
                ignored?: boolean;
                synthetic?: boolean;
            }>;
        },
    ) => {
        const sessionId = input.sessionID;
        if (!sessionId) return;

        const strippedCommand =
            args.commandHandler && output?.parts
                ? matchStrippedMagicContextCommand(output.parts)
                : null;
        if (strippedCommand && args.commandHandler && output?.parts) {
            await args.commandHandler["command.execute.before"](
                {
                    command: strippedCommand.command,
                    sessionID: sessionId,
                    arguments: strippedCommand.arguments,
                },
                { parts: output.parts },
                {
                    agent: input.agent,
                    variant: input.variant,
                    providerId: input.model?.providerID,
                    modelId: input.model?.modelID,
                },
            );
        }

        if (input.model?.providerID && input.model.modelID) {
            args.liveModelBySession.set(sessionId, {
                providerID: input.model.providerID,
                modelID: input.model.modelID,
            });
            if (args.cacheTtlConfig) {
                seedSessionCacheTtlIfUnsynced({
                    db: args.db,
                    sessionId,
                    configured: args.cacheTtlConfig,
                    modelKey: `${input.model.providerID}/${input.model.modelID}`,
                });
            }
        }

        // The tool-heavy "sticky turn reminder" was replaced by the in-turn
        // Channel 1 ctx_reduce nudge (injected into tool outputs). No per-user-turn
        // reminder state to track here anymore.

        const previousVariant = args.variantBySession.get(sessionId);
        args.variantBySession.set(sessionId, input.variant);
        if (input.agent) {
            args.agentBySession.set(sessionId, input.agent);
        }
        if (
            previousVariant !== undefined &&
            input.variant !== undefined &&
            previousVariant !== input.variant
        ) {
            // Variant changes alter cached thinking blocks on some models. Fable
            // 5.1, GPT-6 Astra and Opus 5.5 carry effort outside the cached prefix, leaving
            // existing prompt bytes unchanged. Use both live IDs to decide; if either
            // is unknown, leave the cache unchanged rather than flushing speculatively.
            const liveModel = args.liveModelBySession.get(sessionId);
            const providerID = input.model?.providerID ?? liveModel?.providerID;
            const modelID = input.model?.modelID ?? liveModel?.modelID;
            if (variantChangeBustsProviderCache(providerID, modelID)) {
                sessionLog(
                    sessionId,
                    `variant changed (${previousVariant} -> ${input.variant}), triggering flush`,
                );
                args.historyRefreshSessions.add(sessionId);
                args.systemPromptRefreshSessions.add(sessionId);
                requestPendingMaterialization(
                    args.pendingMaterializationSessions,
                    sessionId,
                    "variant_change",
                );
                args.lastHeuristicsTurnId.delete(sessionId);
            } else {
                // The provider's cache ignores request params, so a variant
                // flip is a cache HIT. Defer the queued ops to the next
                // natural bust (fold / threshold / TTL / flush) exactly as
                // historian publications do — do NOT manufacture a bust here.
                // This log line also answers the dashboard-mislabeling
                // complaint at the log level: the variant change was observed
                // but the flush was deferred, not triggered.
                sessionLog(
                    sessionId,
                    `variant changed (${previousVariant} -> ${input.variant}) on ${providerID ?? "unknown"}/${modelID ?? "unknown"} without a proven natural cache bust; deferring flush to next natural bust`,
                );
            }
        }
    };
}

export function createEventHook(args: {
    eventHandler: (input: { event: { type: string; properties?: unknown } }) => Promise<void>;
    contextUsageMap: Map<
        string,
        { usage: { percentage: number; inputTokens: number }; updatedAt: number }
    >;
    db: Parameters<typeof getOrCreateSessionMeta>[0];
    liveModelBySession: LiveModelBySession;
    /** The lexicographically newest assistant row observed for each session. */
    latestAssistantMessageIdBySession?: LatestAssistantMessageIdBySession;
    variantBySession: VariantBySession;
    agentBySession: AgentBySession;
    /**
     * Cache of resolved session.directory values from `client.session.get(...)`.
     * Cleaned on `session.deleted` to prevent leaks. See live-session-state.ts
     * for the full doc-comment.
     */
    sessionDirectoryBySession: Map<string, string>;
    /** All signal sets are cleaned on `session.deleted` to prevent leaks. */
    historyRefreshSessions: HistoryRefreshSessions;
    deferredHistoryRefreshSessions: DeferredHistoryRefreshSessions;
    systemPromptRefreshSessions: SystemPromptRefreshSessions;
    pendingMaterializationSessions: PendingMaterializationSessions;
    deferredMaterializationSessions: DeferredMaterializationSessions;
    lastHeuristicsTurnId: LastHeuristicsTurnId;
    commitSeenLastPass?: Map<string, boolean>;
    /** Optional source override for the settled raw-message read. */
    readIncrementalMessage?: typeof readRawSessionMessageById;
    client: PluginContext["client"];
}) {
    const latestAssistantMessageIdBySession =
        args.latestAssistantMessageIdBySession ?? new Map<string, string>();

    return async (input: { event: { type: string; properties?: unknown } }) => {
        observeIgnoredNotificationEvent(input.event);
        await args.eventHandler(input);

        if (input.event.type === "message.updated") {
            const messageInfo = getMessageUpdatedInfo(input.event.properties);
            if (messageInfo?.messageID) {
                const isTerminalUser = messageInfo.role === "user";
                const isTerminalAssistant =
                    messageInfo.role === "assistant" &&
                    (typeof messageInfo.completedAt === "number" ||
                        typeof messageInfo.finish === "string");
                if (isTerminalUser || isTerminalAssistant) {
                    scheduleIncrementalIndex(
                        args.db,
                        messageInfo.sessionID,
                        messageInfo.messageID,
                        args.readIncrementalMessage ?? readRawSessionMessageById,
                    );
                }
            }

            const assistantInfo = getMessageUpdatedAssistantInfo(input.event.properties);
            if (assistantInfo?.providerID && assistantInfo?.modelID) {
                const latestMessageID = latestAssistantMessageIdBySession.get(
                    assistantInfo.sessionID,
                );
                // OpenCode MessageID.ascending orders assistant ids lexicographically.
                // Once an ordered event has been observed, an id-less event cannot
                // prove it belongs to the newest assistant and must not overwrite
                // the model used to pin synthetic user messages.
                const acceptsModelUpdate =
                    latestMessageID === undefined ||
                    (assistantInfo.messageID !== undefined &&
                        assistantInfo.messageID >= latestMessageID);
                if (acceptsModelUpdate) {
                    if (assistantInfo.messageID !== undefined) {
                        latestAssistantMessageIdBySession.set(
                            assistantInfo.sessionID,
                            assistantInfo.messageID,
                        );
                    }
                    const previous = args.liveModelBySession.get(assistantInfo.sessionID);
                    args.liveModelBySession.set(assistantInfo.sessionID, {
                        providerID: assistantInfo.providerID,
                        modelID: assistantInfo.modelID,
                    });
                    // When the model changes (e.g., switching from 128k to 1M context model),
                    // clear stale context percentage and historian failure state so the transform
                    // doesn't keep using the old model's usage metrics or emergency state.
                    if (
                        previous &&
                        (previous.providerID !== assistantInfo.providerID ||
                            previous.modelID !== assistantInfo.modelID)
                    ) {
                        // The reasoning watermark is only valid for the model that
                        // produced it. On a switch TO an interleaved-reasoning
                        // provider (e.g. Moonshot/Kimi), replaying the old
                        // watermark would re-clear typed reasoning that OpenCode
                        // must preserve so it can emit `reasoning_content` on the
                        // wire. On a switch BACK to a normal model, keeping the old
                        // watermark would make reasoning cleanup resume from the
                        // previous model's cutoff instead of starting fresh. Clear
                        // it for both forward and backward transitions.
                        dropSlot(assistantInfo.sessionID, "model-change");
                        sessionLog(
                            assistantInfo.sessionID,
                            `model changed (${previous.providerID}/${previous.modelID} -> ${assistantInfo.providerID}/${assistantInfo.modelID}), clearing historian failure state and reasoning watermark`,
                        );
                        // Don't clear lastContextPercentage/lastInputTokens here — the event handler
                        // already computed the correct percentage using the NEW model's context limit
                        // (via resolveContextLimit with the new providerID/modelID). Clearing would
                        // erase the first valid usage sample from the new model.
                        clearHistorianFailureState(args.db, assistantInfo.sessionID);
                        clearPersistedReasoningWatermark(args.db, assistantInfo.sessionID);
                        // Clear the prior model's detected-overflow limit and the
                        // emergency-recovery flag. The transform has its OWN model-change
                        // branch that clears these, but it never fires on a mid-session
                        // switch: this handler updates liveModelBySession first, so by the
                        // time the transform runs, its knownModel already equals the new
                        // model. transform.ts explicitly delegates mid-session switches to
                        // "the first message.updated to trigger hook-handler clearing" —
                        // so the detected-limit + recovery clears must live HERE too, else
                        // the old model's limit leaks into the new model's pressure math
                        // (e.g. a 120K detected limit kept after switching to a 1M model).
                        clearDetectedContextLimit(args.db, assistantInfo.sessionID);
                        clearEmergencyRecovery(args.db, assistantInfo.sessionID);
                        // The emergency idempotence latch is keyed to the prior model's
                        // ceiling (contextLimit × executeThreshold). A switch to a
                        // smaller model lowers the ceiling, so the latch must reset to
                        // re-evaluate the full tail. For the same delegation reason as
                        // above, the transform-side reset is dead on a live switch —
                        // clear it HERE.
                        clearEmergencyDropSample(args.db, assistantInfo.sessionID);
                        updateSessionMeta(args.db, assistantInfo.sessionID, {
                            clearedReasoningThroughTag: 0,
                            observedSafeInputTokens: 0,
                            cacheAlertSent: false,
                        });
                    }
                }
            }
        }

        const properties = getSessionProperties(input.event.properties);
        const sessionId = resolveEventSessionId(properties);
        if (!sessionId) return;

        if (input.event.type !== "session.deleted") {
            scheduleReconciliation(args.db, sessionId, readRawSessionMessages);
        }

        if (input.event.type === "session.deleted") {
            // createEventHandler has already persisted pending_session_cleanup before
            // this process-local indexing latch is discarded.
            args.liveModelBySession.delete(sessionId);
            latestAssistantMessageIdBySession.delete(sessionId);
            args.variantBySession.delete(sessionId);
            args.agentBySession.delete(sessionId);
            args.sessionDirectoryBySession.delete(sessionId);
            args.historyRefreshSessions.delete(sessionId);
            args.deferredHistoryRefreshSessions.delete(sessionId);
            args.systemPromptRefreshSessions.delete(sessionId);
            clearPendingMaterialization(args.pendingMaterializationSessions, sessionId);
            args.deferredMaterializationSessions.delete(sessionId);
            args.lastHeuristicsTurnId.delete(sessionId);
            args.commitSeenLastPass?.delete(sessionId);
            clearIgnoredMessages(sessionId);
            resetNoteNudgeCooldownOnly(sessionId);
            clearAutoSearchForSession(sessionId);
            clearSidebarSnapshotCache(sessionId);
            clearSessionTracking(sessionId);
        }

        // The harness idle signal, not finish=stop, authorizes notice delivery.
        // Other events may safely attempt a flush but cannot release the queue.
        if (input.event.type !== "session.deleted") {
            await flushIgnoredMessages(sessionId);
        }

        // Historical note: v0.14.1 removed the 80% "context emergency" nudge
        // that fired from message.updated. By the time usage reached 80% the
        // agent had already received 4-8 earlier reduction nudges from the
        // rolling band system and ignored all of them — the emergency nudge
        // was louder but mechanistically identical. Automatic safety valves
        // (derived force-band drop-tools in transform-postprocess-phase.ts, 95%
        // block-and-wait-for-historian in transform.ts) keep context from
        // overflowing without depending on agent cooperation, so the nudge
        // was doing more harm than good: firing repeatedly during slow-
        // historian runs (common with Copilot Claude) and mutating the
        // active user message via promptAsync every time.
    };
}

export function createCommandExecuteBeforeHook(commandHandler: MagicContextCommandHandler) {
    return async (input: unknown, output: unknown) => {
        const typedInput = input as CommandExecuteInput & {
            agent?: string;
            variant?: string;
            providerID?: string;
            modelID?: string;
        };
        const params = {
            agent: typedInput.agent,
            variant: typedInput.variant,
            providerId: typedInput.providerID,
            modelId: typedInput.modelID,
        };
        return commandHandler["command.execute.before"](
            typedInput as CommandExecuteInput,
            output as CommandExecuteOutput,
            params,
        );
    };
}

/**
 * Channel 1: append a ctx_reduce `<system-reminder>` to a native/plugin tool's
 * string `output.output` when the metric warrants it. Mutating `output.output`
 * here is persisted by OpenCode and replayed verbatim, so this is "free sticky"
 * — no anchor store / CAS / replay machinery. Native + plugin tools deliver a
 * string `output.output`; true MCP-server tools (`result.content[]`) are skipped.
 */
function maybeInjectChannel1Nudge(
    args: {
        db: Parameters<typeof getOrCreateSessionMeta>[0];
        channel1StateBySession: Map<string, Channel1State>;
    },
    sessionId: string,
    tool: string,
    output: unknown,
): void {
    const state = args.channel1StateBySession.get(sessionId);
    // No baseline → ctx_reduce is disabled for this session (primary with
    // ctx_reduce off). Both primaries and subagents with ctx_reduce enabled get
    // a baseline (set in transform.ts), so both can receive Channel 1 nudges.
    if (!state) return;

    // Output shape guard: only native/plugin tools with a non-empty string output.
    if (output === null || typeof output !== "object") return;
    const out = output as { output?: unknown };
    if (typeof out.output !== "string" || out.output.length === 0) return;

    // Content-based idempotency (robust to callID reuse on retries).
    if (out.output.includes(CHANNEL1_SENTINEL)) return;

    // The just-completed output is prospective input for the next pass and is
    // inside the recency reserve, so it grows T but not U.
    state.turnDeltaT += toolOutputTokens(out.output) * (state.toolsRatio ?? 1);

    const nudgeState = getChannel1NudgeState(args.db, sessionId);
    const decision = decideChannel1({
        baselineU: state.baselineU,
        baselineT: state.baselineT,
        turnDeltaU: state.turnDeltaU,
        turnDeltaT: state.turnDeltaT,
        lastNudgeUndropped: getLastNudgeUndropped(args.db, sessionId),
        lastNudgeLevel: nudgeState.level,
        lastFireOrdinal: nudgeState.ordinal,
        currentRealUserTurnCount: state.realUserTurnCount,
        hasRecentReduce: state.reducedSinceRefresh,
        agentDropsAppliedThisPass: state.agentDropsAppliedThisPass,
        postReduceGracePending: nudgeState.postReduceGracePending,
        postReduceGraceBaselineU: nudgeState.postReduceGraceBaselineU,
        postReduceGracePreLevel: nudgeState.postReduceGracePreLevel,
        evaluable: state.evaluable,
        generationInvalidated: state.generationInvalidated,
    });
    logNudgeEvaluation(sessionId, "tool-completion", formatChannel1Evaluation(decision));

    // Store the cadence level and dampening ordinal together so one persisted state stays in sync.
    setLastNudgeUndropped(args.db, sessionId, decision.nextLastNudge);
    const nextNudgeState = {
        ...nudgeState,
        level: decision.nextLastNudgeLevel,
        postReduceGracePending: decision.clearPostReduceGrace
            ? undefined
            : nudgeState.postReduceGracePending,
        postReduceGraceBaselineU: decision.clearPostReduceGrace
            ? undefined
            : nudgeState.postReduceGraceBaselineU,
        postReduceGracePreLevel: decision.clearPostReduceGrace
            ? undefined
            : nudgeState.postReduceGracePreLevel,
    };
    if (!decision.fire) {
        setChannel1NudgeState(args.db, sessionId, nextNudgeState);
        return;
    }

    out.output += buildChannel1Reminder(
        decision.level,
        decision.undroppedTokens,
        currentReclaimableToolOutputCount(state),
        state.oldestReclaimableToolTags,
        decision.sticky,
    );
    setChannel1NudgeState(args.db, sessionId, {
        ...nextNudgeState,
        ordinal: state.realUserTurnCount,
    });
    sessionLog(
        sessionId,
        `channel1 nudge fired: level=${decision.level} undropped~${Math.round(decision.undroppedTokens / 1000)}k tool=${tool}`,
    );
}

export function createToolExecuteAfterHook(args: {
    db: Parameters<typeof getOrCreateSessionMeta>[0];
    channel1StateBySession: Map<string, Channel1State>;
    client?: PluginContext["client"];
    transformMode?: "ts" | "rust";
    todoStateSet?: (input: {
        sessionId: string;
        stateJson: string;
        ownerMessageId: string;
    }) => Promise<unknown>;
}) {
    return async (input: unknown, output?: unknown) => {
        const typedInput = input as {
            tool?: string;
            sessionID?: string;
            args?: unknown;
            agent?: string;
        };
        if (!typedInput.sessionID || !typedInput.tool) {
            return;
        }

        capDreamerReadOutput(typedInput, output);

        // `tool.execute.after` is the next existing host event after a tool
        // boundary. The queue helper re-checks the read-only mid-turn signal,
        // so this is a no-op until the assistant is actually idle.
        await flushIgnoredMessages(typedInput.sessionID);

        // Surface a completed native task that returned no final text so the
        // caller can distinguish an empty result from a genuinely-empty tool.
        annotateEmptyTaskOutput(typedInput.tool, output);

        if (typedInput.tool === "ctx_reduce") {
            // Mark the Channel 1 baseline dirty so the next nudge re-measures the
            // (now smaller) reclaimable tail instead of replaying a stale band.
            const state = args.channel1StateBySession.get(typedInput.sessionID);
            if (state) {
                state.reducedSinceRefresh = true;
                state.evaluable = false;
                state.generationInvalidated = true;
            }
            try {
                const grace = markChannel1PostReduceGracePending(args.db, typedInput.sessionID);
                if (state) {
                    state.channel1PostReduceGrace = {
                        pending: true,
                        preReduceLevel: grace.postReduceGracePreLevel ?? grace.level,
                    };
                }
            } catch (error) {
                sessionLog(
                    typedInput.sessionID,
                    "channel1 reduce grace arm failed (ignored):",
                    error,
                );
            }
        } else {
            // Channel 1: append an in-turn ctx_reduce nudge when the rendered-tail
            // hygiene ratio and minimum-mass guards warrant it. Auto-sticky via
            // OpenCode's DB (the mutated output.output persists + replays). Fully
            // guarded so an injection failure can never block the tool result.
            try {
                maybeInjectChannel1Nudge(args, typedInput.sessionID, typedInput.tool, output);
            } catch (error) {
                sessionLog(
                    typedInput.sessionID,
                    "channel1 nudge injection failed (ignored):",
                    error,
                );
            }
        }
        if (typedInput.tool === "todowrite") {
            // Persist todo state only for the exact native `todowrite` tool
            // after checking its availability and live permission. MCP-shaped
            // lookalikes such as `mcp_Todowrite` do not enter this branch and
            // remain refused.
            const todowriteVerdict = resolveTodowriteAvailability(typedInput.sessionID);
            if (todowriteVerdict.frozen && !todowriteVerdict.callable) return;
            const activeAgent = typedInput.agent;
            if (args.client) {
                try {
                    if (
                        await todowritePermissionDenied(
                            args.client,
                            typedInput.sessionID,
                            activeAgent,
                        )
                    ) {
                        return;
                    }
                } catch (error) {
                    // Preserve a prior live deny across a transient SDK read;
                    // otherwise a failed read could resume stale capture.
                    if (cachedToolPermissionDenied(typedInput.sessionID, "todowrite")) {
                        return;
                    }
                    sessionLog(
                        typedInput.sessionID,
                        "todowrite permission read failed during capture (ignored):",
                        error,
                    );
                }
            }
            // Only trigger note nudge when ALL todo items are terminal (completed/cancelled).
            // Firing on every todowrite is too eager — agents call it repeatedly while working.
            const todoArgs = typedInput.args as { todos?: unknown } | undefined;
            const todos = todoArgs?.todos;
            const sessionMeta = getOrCreateSessionMeta(args.db, typedInput.sessionID);
            if (!sessionMeta.isSubagent) {
                // OpenCode accepts any status and priority string, so every list
                // its todowrite stores replaces the snapshot. A list this capture
                // can't read clears it instead: keeping the previous snapshot would
                // replay an outdated plan as the newest todowrite on the next
                // prompt rebuild.
                const readableTodos = normalizeTodoStateJson(todos);
                if (readableTodos === null) {
                    sessionLog(
                        typedInput.sessionID,
                        "todowrite todos could not be read; cleared the todo snapshot",
                    );
                }
                const normalizedTodos = readableTodos ?? CLEARED_TODO_STATE_JSON;
                updateSessionMeta(args.db, typedInput.sessionID, {
                    lastTodoState: normalizedTodos,
                });
                if (args.transformMode === "rust" && args.todoStateSet) {
                    const todoSessionId = typedInput.sessionID;
                    const rawArgs =
                        typedInput.args && typeof typedInput.args === "object"
                            ? (typedInput.args as Record<string, unknown>)
                            : {};
                    const ownerMessageId =
                        (typeof rawArgs.owner_message_id === "string" &&
                            rawArgs.owner_message_id) ||
                        (typeof rawArgs.message_id === "string" && rawArgs.message_id) ||
                        (typeof (typedInput as { messageID?: unknown }).messageID === "string" &&
                            (typedInput as { messageID: string }).messageID) ||
                        (typeof (typedInput as { callID?: unknown }).callID === "string" &&
                            (typedInput as { callID: string }).callID) ||
                        typedInput.sessionID;
                    void args
                        .todoStateSet({
                            sessionId: todoSessionId,
                            stateJson: normalizedTodos,
                            ownerMessageId,
                        })
                        .catch((error) => {
                            sessionLog(
                                todoSessionId,
                                "rust todo_state.set failed (ignored):",
                                error,
                            );
                        });
                }
            }
            if (
                Array.isArray(todos) &&
                todos.length > 0 &&
                todos.every(
                    (t) =>
                        typeof t === "object" &&
                        t !== null &&
                        ((t as { status?: unknown }).status === "completed" ||
                            (t as { status?: unknown }).status === "cancelled"),
                )
            ) {
                // Subagents never deliver note nudges (gated in postprocess), so don't
                // accumulate orphan trigger state for them.
                if (!sessionMeta.isSubagent) {
                    onNoteTrigger(args.db, typedInput.sessionID, "todos_complete");
                }
            }
        }
        if (typedInput.tool === "ctx_note") {
            clearNoteNudgeTriggerAndCooldown(args.db, typedInput.sessionID);
        }
    };
}

import {
    clearPendingMaterialization,
    requestPendingMaterialization,
} from "./pending-materialization";
