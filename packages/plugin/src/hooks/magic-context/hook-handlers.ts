import {
    clearSessionTracking,
    scheduleIncrementalIndex,
    scheduleReconciliation,
} from "../../features/magic-context/message-index-async";
import {
    clearPersistedReasoningWatermark,
    getPersistedStickyTurnReminder,
    setPersistedStickyTurnReminder,
} from "../../features/magic-context/storage";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import { clearHistorianFailureState } from "../../features/magic-context/storage-meta-persisted";
import { clearSidebarSnapshotCache } from "../../plugin/sidebar-snapshot-cache";
import type { PluginContext } from "../../plugin/types";
import { sessionLog } from "../../shared/logger";
import { clearAutoSearchForSession } from "./auto-search-runner";
import {
    getMessageUpdatedAssistantInfo,
    getMessageUpdatedInfo,
    getSessionProperties,
} from "./event-payloads";
import { resolveSessionId as resolveEventSessionId } from "./event-resolvers";
import { clearNoteNudgeState, onNoteTrigger } from "./note-nudger";
import { readRawSessionMessageById, readRawSessionMessages } from "./read-session-chunk";
import { normalizeTodoStateJson } from "./todo-view";

const TOOL_HEAVY_TURN_REMINDER_THRESHOLD = 5;
const TOOL_HEAVY_TURN_REMINDER_TEXT =
    '\n\n<instruction name="ctx_reduce_turn_cleanup">Also drop via `ctx_reduce` things you don\'t need anymore from the last turn before continuing.</instruction>';

export type LiveModelBySession = Map<string, { providerID: string; modelID: string }>;
export type VariantBySession = Map<string, string | undefined>;
export type AgentBySession = Map<string, string>;
export type RecentReduceBySession = Map<string, number>;
export type ToolUsageSinceUserTurn = Map<string, number>;

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

export function getLiveNotificationParams(
    sessionId: string,
    liveModelBySession: LiveModelBySession,
    variantBySession: VariantBySession,
    agentBySession?: AgentBySession,
): {
    agent?: string;
    variant?: string;
    providerId?: string;
    modelId?: string;
} {
    const model = liveModelBySession.get(sessionId);
    const variant = variantBySession.get(sessionId);
    const agent = agentBySession?.get(sessionId);
    return {
        ...(agent ? { agent } : {}),
        ...(variant ? { variant } : {}),
        ...(model ? { providerId: model.providerID, modelId: model.modelID } : {}),
    };
}

export function createChatMessageHook(args: {
    db: Parameters<typeof getOrCreateSessionMeta>[0];
    toolUsageSinceUserTurn: ToolUsageSinceUserTurn;
    recentReduceBySession: RecentReduceBySession;
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
    ctxReduceEnabled?: boolean;
}) {
    return async (input: {
        sessionID?: string;
        variant?: string;
        agent?: string;
        model?: { providerID?: string; modelID?: string };
    }) => {
        const sessionId = input.sessionID;
        if (!sessionId) return;

        if (input.model?.providerID && input.model.modelID) {
            args.liveModelBySession.set(sessionId, {
                providerID: input.model.providerID,
                modelID: input.model.modelID,
            });
        }

        // Only set sticky turn reminders when ctx_reduce is enabled — the reminder
        // tells the agent to use ctx_reduce, which doesn't exist when disabled.
        if (args.ctxReduceEnabled !== false) {
            const sessionMeta = getOrCreateSessionMeta(args.db, sessionId);
            const turnUsage = args.toolUsageSinceUserTurn.get(sessionId);
            const agentAlreadyReduced = args.recentReduceBySession.has(sessionId);
            if (
                !sessionMeta.isSubagent &&
                !agentAlreadyReduced &&
                getPersistedStickyTurnReminder(args.db, sessionId) === null &&
                turnUsage !== undefined &&
                turnUsage >= TOOL_HEAVY_TURN_REMINDER_THRESHOLD
            ) {
                setPersistedStickyTurnReminder(args.db, sessionId, TOOL_HEAVY_TURN_REMINDER_TEXT);
            }
        }
        args.toolUsageSinceUserTurn.set(sessionId, 0);

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
            sessionLog(
                sessionId,
                `variant changed (${previousVariant} -> ${input.variant}), triggering flush`,
            );
            args.historyRefreshSessions.add(sessionId);
            args.systemPromptRefreshSessions.add(sessionId);
            args.pendingMaterializationSessions.add(sessionId);
            args.lastHeuristicsTurnId.delete(sessionId);
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
    variantBySession: VariantBySession;
    agentBySession: AgentBySession;
    /**
     * Cache of resolved session.directory values from `client.session.get(...)`.
     * Cleaned on `session.deleted` to prevent leaks. See live-session-state.ts
     * for the full doc-comment.
     */
    sessionDirectoryBySession: Map<string, string>;
    recentReduceBySession: RecentReduceBySession;
    toolUsageSinceUserTurn: ToolUsageSinceUserTurn;
    /** All signal sets are cleaned on `session.deleted` to prevent leaks. */
    historyRefreshSessions: HistoryRefreshSessions;
    deferredHistoryRefreshSessions: DeferredHistoryRefreshSessions;
    systemPromptRefreshSessions: SystemPromptRefreshSessions;
    pendingMaterializationSessions: PendingMaterializationSessions;
    deferredMaterializationSessions: DeferredMaterializationSessions;
    lastHeuristicsTurnId: LastHeuristicsTurnId;
    commitSeenLastPass?: Map<string, boolean>;
    client: PluginContext["client"];
    protectedTags: number;
    ctxReduceEnabled?: boolean;
}) {
    return async (input: { event: { type: string; properties?: unknown } }) => {
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
                        readRawSessionMessageById,
                    );
                }
            }

            const assistantInfo = getMessageUpdatedAssistantInfo(input.event.properties);
            if (assistantInfo?.providerID && assistantInfo?.modelID) {
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
                    updateSessionMeta(args.db, assistantInfo.sessionID, {
                        clearedReasoningThroughTag: 0,
                    });
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
            args.liveModelBySession.delete(sessionId);
            args.variantBySession.delete(sessionId);
            args.agentBySession.delete(sessionId);
            args.sessionDirectoryBySession.delete(sessionId);
            args.recentReduceBySession.delete(sessionId);
            args.toolUsageSinceUserTurn.delete(sessionId);
            args.historyRefreshSessions.delete(sessionId);
            args.deferredHistoryRefreshSessions.delete(sessionId);
            args.systemPromptRefreshSessions.delete(sessionId);
            args.pendingMaterializationSessions.delete(sessionId);
            args.deferredMaterializationSessions.delete(sessionId);
            args.lastHeuristicsTurnId.delete(sessionId);
            args.commitSeenLastPass?.delete(sessionId);
            clearNoteNudgeState(args.db, sessionId);
            clearAutoSearchForSession(sessionId);
            clearSidebarSnapshotCache(sessionId);
            clearSessionTracking(sessionId);
        }

        // Historical note: v0.14.1 removed the 80% "context emergency" nudge
        // that fired from message.updated. By the time usage reached 80% the
        // agent had already received 4-8 earlier reduction nudges from the
        // rolling band system and ignored all of them — the emergency nudge
        // was louder but mechanistically identical. Automatic safety valves
        // (85% force-drop-tools in transform-postprocess-phase.ts, 95%
        // block-and-wait-for-historian in transform.ts) keep context from
        // overflowing without depending on agent cooperation, so the nudge
        // was doing more harm than good: firing repeatedly during slow-
        // historian runs (common with Copilot Claude) and mutating the
        // active user message via promptAsync every time.
    };
}

export function createCommandExecuteBeforeHook(commandHandler: {
    "command.execute.before": (
        input: import("./command-handler").CommandExecuteInput,
        output: import("./command-handler").CommandExecuteOutput,
        params: { agent?: string; variant?: string; providerId?: string; modelId?: string },
    ) => Promise<unknown>;
}) {
    return async (input: unknown, output: unknown) => {
        const typedInput = input as import("./command-handler").CommandExecuteInput & {
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
            typedInput as import("./command-handler").CommandExecuteInput,
            output as import("./command-handler").CommandExecuteOutput,
            params,
        );
    };
}

export function createToolExecuteAfterHook(args: {
    db: Parameters<typeof getOrCreateSessionMeta>[0];
    recentReduceBySession: RecentReduceBySession;
    toolUsageSinceUserTurn: ToolUsageSinceUserTurn;
}) {
    return async (input: unknown) => {
        const typedInput = input as { tool?: string; sessionID?: string; args?: unknown };
        if (!typedInput.sessionID || !typedInput.tool) {
            return;
        }

        const turnUsage = args.toolUsageSinceUserTurn.get(typedInput.sessionID) ?? 0;
        if (typedInput.tool === "ctx_reduce") {
            args.recentReduceBySession.set(typedInput.sessionID, Date.now());
        }
        if (typedInput.tool === "todowrite") {
            // Only trigger note nudge when ALL todo items are terminal (completed/cancelled).
            // Firing on every todowrite is too eager — agents call it repeatedly while working.
            const todoArgs = typedInput.args as { todos?: unknown } | undefined;
            const todos = todoArgs?.todos;
            const sessionMeta = Array.isArray(todos)
                ? getOrCreateSessionMeta(args.db, typedInput.sessionID)
                : null;
            if (sessionMeta && !sessionMeta.isSubagent) {
                const normalizedTodos = normalizeTodoStateJson(todos);
                if (normalizedTodos !== null) {
                    updateSessionMeta(args.db, typedInput.sessionID, {
                        lastTodoState: normalizedTodos,
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
                if (sessionMeta && !sessionMeta.isSubagent) {
                    onNoteTrigger(args.db, typedInput.sessionID, "todos_complete");
                }
            }
        }
        if (typedInput.tool === "ctx_note") {
            clearNoteNudgeState(args.db, typedInput.sessionID);
        }
        args.toolUsageSinceUserTurn.set(typedInput.sessionID, turnUsage + 1);
    };
}
