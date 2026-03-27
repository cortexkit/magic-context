import {
    getPersistedStickyTurnReminder,
    setPersistedStickyTurnReminder,
} from "../../features/magic-context/storage";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import type { PluginContext } from "../../plugin/types";
import { sessionLog } from "../../shared/logger";
import { FORCE_COMPARTMENT_PERCENTAGE } from "./compartment-trigger";
import { getMessageUpdatedAssistantInfo, getSessionProperties } from "./event-payloads";
import { resolveSessionId as resolveEventSessionId } from "./event-resolvers";
import { clearNoteNudgeState, onNoteTrigger } from "./note-nudger";
import { generateEmergencyNudgeText } from "./nudger";

const TOOL_HEAVY_TURN_REMINDER_THRESHOLD = 5;
const TOOL_HEAVY_TURN_REMINDER_TEXT =
    '\n\n<instruction name="ctx_reduce_turn_cleanup">Also drop via `ctx_reduce` things you don\'t need anymore from the last turn before continuing.</instruction>';

export type LiveModelBySession = Map<string, { providerID: string; modelID: string }>;
export type VariantBySession = Map<string, string | undefined>;
export type RecentReduceBySession = Map<string, number>;
export type ToolUsageSinceUserTurn = Map<string, number>;
export type FlushedSessions = Set<string>;
export type LastHeuristicsTurnId = Map<string, string>;
export type EmergencyNudgeFired = Set<string>;

export function getLiveNotificationParams(
    sessionId: string,
    liveModelBySession: LiveModelBySession,
    variantBySession: VariantBySession,
): {
    variant?: string;
    providerId?: string;
    modelId?: string;
} {
    const model = liveModelBySession.get(sessionId);
    const variant = variantBySession.get(sessionId);
    return {
        ...(variant ? { variant } : {}),
        ...(model ? { providerId: model.providerID, modelId: model.modelID } : {}),
    };
}

export function createChatMessageHook(args: {
    db: Parameters<typeof getOrCreateSessionMeta>[0];
    toolUsageSinceUserTurn: ToolUsageSinceUserTurn;
    recentReduceBySession: RecentReduceBySession;
    variantBySession: VariantBySession;
    flushedSessions: FlushedSessions;
    lastHeuristicsTurnId: LastHeuristicsTurnId;
    ctxReduceEnabled?: boolean;
}) {
    return async (input: { sessionID?: string; variant?: string }) => {
        const sessionId = input.sessionID;
        if (!sessionId) return;

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
    recentReduceBySession: RecentReduceBySession;
    toolUsageSinceUserTurn: ToolUsageSinceUserTurn;
    emergencyNudgeFired: EmergencyNudgeFired;
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
                args.liveModelBySession.set(assistantInfo.sessionID, {
                    providerID: assistantInfo.providerID,
                    modelID: assistantInfo.modelID,
                });
            }
        }

        const properties = getSessionProperties(input.event.properties);
        const sessionId = resolveEventSessionId(properties);
        if (!sessionId) return;

        if (input.event.type === "session.deleted") {
            args.liveModelBySession.delete(sessionId);
            args.variantBySession.delete(sessionId);
            args.recentReduceBySession.delete(sessionId);
            args.toolUsageSinceUserTurn.delete(sessionId);
            args.emergencyNudgeFired.delete(sessionId);
            args.flushedSessions.delete(sessionId);
            args.lastHeuristicsTurnId.delete(sessionId);
            args.commitSeenLastPass?.delete(sessionId);
            clearNoteNudgeState(sessionId);
        }

        const entry = args.contextUsageMap.get(sessionId);
        if (!entry) return;

        if (entry.usage.percentage < FORCE_COMPARTMENT_PERCENTAGE) {
            args.emergencyNudgeFired.delete(sessionId);
            return;
        }

        // Skip 80% emergency nudge when ctx_reduce is disabled — it tells the
        // agent to "STOP AND COMPRESS" which requires ctx_reduce.
        if (args.ctxReduceEnabled === false) return;

        if (args.emergencyNudgeFired.has(sessionId)) return;

        const meta = getOrCreateSessionMeta(args.db, sessionId);
        if (meta.isSubagent) return;

        args.emergencyNudgeFired.add(sessionId);
        updateSessionMeta(args.db, sessionId, { lastNudgeTokens: entry.usage.inputTokens });

        const nudgeText = generateEmergencyNudgeText(args.db, sessionId, entry.usage, {
            protected_tags: args.protectedTags,
        });
        sessionLog(sessionId, "firing 80% emergency nudge as ignored notification");

        try {
            const model = args.liveModelBySession.get(sessionId);
            const variant = args.variantBySession.get(sessionId);
            // Intentional: feature-detection cast for optional/experimental OpenCode promptAsync API
            const c = args.client as {
                session: { promptAsync?: (opts: unknown) => Promise<unknown> };
            };
            if (typeof c.session?.promptAsync !== "function") {
                sessionLog(sessionId, "emergency nudge: promptAsync unavailable");
                args.emergencyNudgeFired.delete(sessionId);
                return;
            }
            await c.session.promptAsync({
                path: { id: sessionId },
                body: {
                    ...(model ? { model } : {}),
                    ...(variant ? { variant } : {}),
                    parts: [{ type: "text", text: nudgeText }],
                },
            });
        } catch (error) {
            sessionLog(sessionId, "emergency nudge promptAsync failed:", error);
            args.emergencyNudgeFired.delete(sessionId);
        }
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
    recentReduceBySession: RecentReduceBySession;
    toolUsageSinceUserTurn: ToolUsageSinceUserTurn;
}) {
    return async (input: unknown) => {
        const typedInput = input as { tool?: string; sessionID?: string };
        if (!typedInput.sessionID || !typedInput.tool) {
            return;
        }

        const turnUsage = args.toolUsageSinceUserTurn.get(typedInput.sessionID) ?? 0;
        if (typedInput.tool === "ctx_reduce") {
            args.recentReduceBySession.set(typedInput.sessionID, Date.now());
        }
        if (typedInput.tool === "todowrite") {
            onNoteTrigger(typedInput.sessionID, "todos_complete");
        }
        if (typedInput.tool === "ctx_note") {
            clearNoteNudgeState(typedInput.sessionID);
        }
        args.toolUsageSinceUserTurn.set(typedInput.sessionID, turnUsage + 1);
    };
}
