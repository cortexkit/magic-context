import {
    DEFAULT_COMPARTMENT_TOKEN_BUDGET,
    DEFAULT_HISTORIAN_TIMEOUT_MS,
    DEFAULT_NUDGE_INTERVAL_TOKENS,
} from "../../config/schema/magic-context";
import type { createCompactionHandler } from "../../features/magic-context/compaction";
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    getDatabasePersistenceError,
    isDatabasePersisted,
    openDatabase,
} from "../../features/magic-context/storage";
import type { Tagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import { log } from "../../shared/logger";
import { createMagicContextCommandHandler } from "./command-handler";
import { createEventHandler } from "./event-handler";
import { createNudger } from "./nudger";
import { createTextCompleteHandler } from "./text-complete";
import { createNudgePlacementStore, createTransform } from "./transform";

export type { CommandExecuteInput, CommandExecuteOutput } from "./command-handler";

import { executeContextRecomp } from "./compartment-runner";
import {
    createChatMessageHook,
    createCommandExecuteBeforeHook,
    createEventHook,
    createToolExecuteAfterHook,
    getLiveNotificationParams,
} from "./hook-handlers";
import { sendIgnoredMessage } from "./send-session-notification";
import { createSystemPromptHashHandler } from "./system-prompt-hash";

export interface MagicContextDeps {
    client: PluginContext["client"];
    directory: string;
    tagger: Tagger;
    scheduler: Scheduler;
    onSessionCacheInvalidated?: (sessionId: string) => void;
    compactionHandler: ReturnType<typeof createCompactionHandler>;
    config: {
        protected_tags: number;
        nudge_interval_tokens?: number;
        auto_drop_tool_age?: number;
        clear_reasoning_age?: number;
        iteration_nudge_threshold?: number;
        execute_threshold_percentage?: number | { default: number; [modelKey: string]: number };
        cache_ttl: string | Record<string, string>;
        modelContextLimitsCache?: Map<string, number>;

        compartment_token_budget?: number;
        historian_timeout_ms?: number;
        memory?: {
            enabled: boolean;
            injection_budget_tokens: number;
        };
    };
}

function notifyMagicContextDisabled(client: PluginContext["client"], reason: string): void {
    const detail = reason.trim();
    const c = client as {
        tui?: {
            showToast?: (input: {
                body: {
                    title: string;
                    message: string;
                    variant?: "warning" | "error" | "info" | "success";
                    duration?: number;
                };
            }) => Promise<unknown>;
        };
    };

    const message =
        detail.length > 0
            ? `Persistent storage is unavailable, so magic-context is disabled for safety. ${detail}`
            : "Persistent storage is unavailable, so magic-context is disabled for safety.";

    void c.tui
        ?.showToast?.({
            body: {
                title: "Magic Context Disabled",
                message,
                variant: "warning",
                duration: 8000,
            },
        })
        .catch((error) => {
            log("[magic-context] failed to show disabled toast:", error);
        });
}

export function createMagicContextHook(deps: MagicContextDeps) {
    const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>();
    let db: ReturnType<typeof openDatabase>;
    try {
        db = openDatabase();
        if (!isDatabasePersisted(db)) {
            const reason =
                getDatabasePersistenceError(db) ??
                "Failed to initialize the persistent SQLite database.";
            log(
                "[magic-context] disabling feature because persistent storage is unavailable:",
                reason,
            );
            notifyMagicContextDisabled(deps.client, reason);
            return null;
        }
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log("[magic-context] hook failed to open storage; disabling feature:", error);
        notifyMagicContextDisabled(deps.client, reason);
        return null;
    }

    const nudgePlacements = createNudgePlacementStore(db);
    const flushedSessions = new Set<string>();
    const lastHeuristicsTurnId = new Map<string, string>();
    const variantBySession = new Map<string, string | undefined>();
    const liveModelBySession = new Map<string, { providerID: string; modelID: string }>();
    const recentReduceBySession = new Map<string, number>();
    const toolUsageSinceUserTurn = new Map<string, number>();

    const nudgerWithRecentReduce = createNudger({
        protected_tags: deps.config.protected_tags,
        nudge_interval_tokens: deps.config.nudge_interval_tokens ?? DEFAULT_NUDGE_INTERVAL_TOKENS,
        iteration_nudge_threshold: deps.config.iteration_nudge_threshold ?? 15,
        execute_threshold_percentage: deps.config.execute_threshold_percentage ?? 65,
        recentReduceBySession,
    });

    const transform = createTransform({
        tagger: deps.tagger,
        scheduler: deps.scheduler,
        contextUsageMap,
        nudger: nudgerWithRecentReduce,
        db,
        nudgePlacements,
        protectedTags: deps.config.protected_tags,
        autoDropToolAge: deps.config.auto_drop_tool_age ?? 100,
        clearReasoningAge: deps.config.clear_reasoning_age ?? 50,
        flushedSessions,
        lastHeuristicsTurnId,
        client: deps.client,
        directory: deps.directory,
        memoryConfig: deps.config.memory
            ? {
                  enabled: deps.config.memory.enabled,
                  injectionBudgetTokens: deps.config.memory.injection_budget_tokens,
              }
            : undefined,
        compartmentTokenBudget:
            deps.config.compartment_token_budget ?? DEFAULT_COMPARTMENT_TOKEN_BUDGET,
        historianTimeoutMs: deps.config.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
        getNotificationParams: (sessionId) =>
            getLiveNotificationParams(sessionId, liveModelBySession, variantBySession),
    });
    const eventHandler = createEventHandler({
        contextUsageMap,
        compactionHandler: deps.compactionHandler,
        config: deps.config,
        tagger: deps.tagger,
        db,
        nudgePlacements,
        onSessionCacheInvalidated: deps.onSessionCacheInvalidated,
        client: deps.client,
    });

    const commandHandler = createMagicContextCommandHandler({
        db,
        protectedTags: deps.config.protected_tags,
        nudgeIntervalTokens: deps.config.nudge_interval_tokens ?? DEFAULT_NUDGE_INTERVAL_TOKENS,
        executeThresholdPercentage: deps.config.execute_threshold_percentage ?? 65,
        getLiveModelKey: (sessionId) => {
            const model = liveModelBySession.get(sessionId);
            return model ? `${model.providerID}/${model.modelID}` : undefined;
        },
        onFlush: (sessionId) => flushedSessions.add(sessionId),
        executeRecomp: async (sessionId) =>
            executeContextRecomp({
                client: deps.client,
                db,
                sessionId,
                tokenBudget:
                    deps.config.compartment_token_budget ?? DEFAULT_COMPARTMENT_TOKEN_BUDGET,
                historianTimeoutMs:
                    deps.config.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
                directory: deps.directory,
                getNotificationParams: () =>
                    getLiveNotificationParams(sessionId, liveModelBySession, variantBySession),
            }),
        sendNotification: async (sessionId, text, params) => {
            await sendIgnoredMessage(deps.client, sessionId, text, {
                ...getLiveNotificationParams(sessionId, liveModelBySession, variantBySession),
                ...params,
            });
        },
    });

    const emergencyNudgeFired = new Set<string>();

    const systemPromptHashHandler = createSystemPromptHashHandler({
        db,
        flushedSessions,
        lastHeuristicsTurnId,
    });

    return {
        "experimental.chat.messages.transform": transform,
        "experimental.chat.system.transform": systemPromptHashHandler,
        "experimental.text.complete": createTextCompleteHandler(),
        "chat.message": createChatMessageHook({
            db,
            toolUsageSinceUserTurn,
            variantBySession,
            flushedSessions,
            lastHeuristicsTurnId,
        }),
        event: createEventHook({
            eventHandler,
            contextUsageMap,
            db,
            liveModelBySession,
            variantBySession,
            recentReduceBySession,
            toolUsageSinceUserTurn,
            emergencyNudgeFired,
            flushedSessions,
            lastHeuristicsTurnId,
            client: deps.client,
            protectedTags: deps.config.protected_tags,
        }),
        "command.execute.before": createCommandExecuteBeforeHook(commandHandler),
        "tool.execute.after": createToolExecuteAfterHook({
            recentReduceBySession,
            toolUsageSinceUserTurn,
        }),
    };
}
