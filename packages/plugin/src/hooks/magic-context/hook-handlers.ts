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
import type { PluginContext } from "../../plugin/types";
import { sessionLog } from "../../shared/logger";
import { clearAutoSearchForSession } from "./auto-search-runner";
import { getMessageUpdatedAssistantInfo, getSessionProperties } from "./event-payloads";
import { resolveSessionId as resolveEventSessionId } from "./event-resolvers";
import { clearNoteNudgeState, onNoteTrigger } from "./note-nudger";

const TOOL_HEAVY_TURN_REMINDER_THRESHOLD = 5;
const TOOL_HEAVY_TURN_REMINDER_TEXT =
    '\n\n<instruction name="ctx_reduce_turn_cleanup">Also drop via `ctx_reduce` things you don\'t need anymore from the last turn before continuing.</instruction>';

export type LiveModelBySession = Map<string, { providerID: string; modelID: string }>;
export type VariantBySession = Map<string, string | undefined>;
export type AgentBySession = Map<string, string>;
export type RecentReduceBySession = Map<string, number>;
export type ToolUsageSinceUserTurn = Map<string, number>;
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
    flushedSessions: FlushedSessions;
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
            args.flushedSessions.add(sessionId);
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
    recentReduceBySession: RecentReduceBySession;
    toolUsageSinceUserTurn: ToolUsageSinceUserTurn;
    flushedSessions: FlushedSessions;
    lastHeuristicsTurnId: LastHeuristicsTurnId;
    commitSeenLastPass?: Map<string, boolean>;
    client: PluginContext["client"];
    protectedTags: number;
    ctxReduceEnabled?: boolean;
}) {
    return async (input: { event: { type: string; properties?: unknown } }) => {
        await args.eventHandler(input);

        if (input.event.type === "message.updated") {
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

        if (input.event.type === "session.deleted") {
            args.liveModelBySession.delete(sessionId);
            args.variantBySession.delete(sessionId);
            args.agentBySession.delete(sessionId);
            args.recentReduceBySession.delete(sessionId);
            args.toolUsageSinceUserTurn.delete(sessionId);
            args.flushedSessions.delete(sessionId);
            args.lastHeuristicsTurnId.delete(sessionId);
            args.commitSeenLastPass?.delete(sessionId);
            clearNoteNudgeState(args.db, sessionId);
            clearAutoSearchForSession(sessionId);
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
            const todoArgs = typedInput.args as { todos?: Array<{ status?: string }> } | undefined;
            const todos = todoArgs?.todos;
            if (
                Array.isArray(todos) &&
                todos.length > 0 &&
                todos.every((t) => t.status === "completed" || t.status === "cancelled")
            ) {
                // Subagents never deliver note nudges (gated in postprocess), so don't
                // accumulate orphan trigger state for them.
                const sessionMeta = getOrCreateSessionMeta(args.db, typedInput.sessionID);
                if (!sessionMeta.isSubagent) {
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
