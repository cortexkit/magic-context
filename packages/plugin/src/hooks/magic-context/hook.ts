import {
    DEFAULT_COMPARTMENT_TOKEN_BUDGET,
    DEFAULT_HISTORIAN_TIMEOUT_MS,
    DEFAULT_NUDGE_INTERVAL_TOKENS,
    type DreamerConfig,
    type SidekickConfig,
} from "../../config/schema/magic-context";
import type { createCompactionHandler } from "../../features/magic-context/compaction";
import {
    checkScheduleAndEnqueue,
    processDreamQueue,
    registerDreamProjectDirectory,
} from "../../features/magic-context/dreamer";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    getDatabasePersistenceError,
    isDatabasePersisted,
    openDatabase,
} from "../../features/magic-context/storage";
import type { Tagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import { getErrorMessage } from "../../shared/error-message";
import { log } from "../../shared/logger";
import { createMagicContextCommandHandler } from "./command-handler";
import { createEventHandler } from "./event-handler";
import { resolveModelKey } from "./event-resolvers";
import { clearInjectionCache } from "./inject-compartments";
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

const DREAM_SCHEDULE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
// NOTE: lastScheduleCheckMs is intentionally inside createMagicContextHook (not module scope)
// so each hook instance has independent dream-schedule tracking across projects.

export interface MagicContextDeps {
    client: PluginContext["client"];
    directory: string;
    tagger: Tagger;
    scheduler: Scheduler;
    onSessionCacheInvalidated?: (sessionId: string) => void;
    compactionHandler: ReturnType<typeof createCompactionHandler>;
    config: {
        protected_tags: number;
        ctx_reduce_enabled?: boolean;
        nudge_interval_tokens?: number;
        auto_drop_tool_age?: number;
        clear_reasoning_age?: number;
        iteration_nudge_threshold?: number;
        execute_threshold_percentage?: number | { default: number; [modelKey: string]: number };
        cache_ttl: string | Record<string, string>;
        modelContextLimitsCache?: Map<string, number>;

        compartment_token_budget?: number;
        history_budget_percentage?: number;
        historian_timeout_ms?: number;
        memory?: {
            enabled: boolean;
            injection_budget_tokens: number;
        };
        sidekick?: SidekickConfig;
        dreamer?: DreamerConfig;
        commit_cluster_trigger?: { enabled: boolean; min_clusters: number };
    };
}

function notifyMagicContextDisabled(client: PluginContext["client"], reason: string): void {
    const detail = reason.trim();
    // Intentional: feature-detection cast for optional/experimental OpenCode tui.showToast API
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
        const reason = getErrorMessage(error);
        log("[magic-context] hook failed to open storage; disabling feature:", error);
        notifyMagicContextDisabled(deps.client, reason);
        return null;
    }

    const projectPath = resolveProjectIdentity(deps.directory);
    registerDreamProjectDirectory(projectPath, deps.directory);

    let lastScheduleCheckMs = 0;
    const nudgePlacements = createNudgePlacementStore(db);
    const flushedSessions = new Set<string>();
    const lastHeuristicsTurnId = new Map<string, string>();
    const commitSeenLastPass = new Map<string, boolean>();
    const variantBySession = new Map<string, string | undefined>();
    const liveModelBySession = new Map<string, { providerID: string; modelID: string }>();
    const recentReduceBySession = new Map<string, number>();
    const toolUsageSinceUserTurn = new Map<string, number>();
    const ctxReduceEnabled = deps.config.ctx_reduce_enabled !== false;
    const nudgerWithRecentReduce = ctxReduceEnabled
        ? createNudger({
              protected_tags: deps.config.protected_tags,
              nudge_interval_tokens:
                  deps.config.nudge_interval_tokens ?? DEFAULT_NUDGE_INTERVAL_TOKENS,
              iteration_nudge_threshold: deps.config.iteration_nudge_threshold ?? 15,
              execute_threshold_percentage: deps.config.execute_threshold_percentage ?? 65,
              recentReduceBySession,
          })
        : () => null;

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
        commitSeenLastPass,
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
        historyBudgetPercentage: deps.config.history_budget_percentage,
        executeThresholdPercentage: deps.config.execute_threshold_percentage,
        historianTimeoutMs: deps.config.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
        getNotificationParams: (sessionId) =>
            getLiveNotificationParams(sessionId, liveModelBySession, variantBySession),
        getModelKey: (sessionId) => {
            const model = liveModelBySession.get(sessionId);
            return resolveModelKey(model?.providerID, model?.modelID);
        },
        projectPath,
    });
    const eventHandler = createEventHandler({
        contextUsageMap,
        compactionHandler: deps.compactionHandler,
        config: deps.config,
        tagger: deps.tagger,
        db,
        nudgePlacements,
        onSessionCacheInvalidated: (sessionId: string) => {
            clearInjectionCache(sessionId);
            deps.onSessionCacheInvalidated?.(sessionId);
        },
    });

    const runDreamQueueInBackground = (): void => {
        const dreaming = deps.config.dreamer;
        if (!dreaming?.enabled || !dreaming.schedule?.trim()) {
            return;
        }

        const now = Date.now();
        if (now - lastScheduleCheckMs < DREAM_SCHEDULE_CHECK_INTERVAL_MS) {
            return;
        }

        try {
            checkScheduleAndEnqueue(db, dreaming.schedule);
            lastScheduleCheckMs = now;
        } catch (error) {
            log("[dreamer] scheduled enqueue check failed:", error);
            return;
        }

        void processDreamQueue({
            db,
            client: deps.client,
            tasks: dreaming.tasks,
            taskTimeoutMinutes: dreaming.task_timeout_minutes,
            maxRuntimeMinutes: dreaming.max_runtime_minutes,
        }).catch((error: unknown) => {
            log("[dreamer] scheduled queue processing failed:", error);
        });
    };

    const commandHandler = createMagicContextCommandHandler({
        db,
        protectedTags: deps.config.protected_tags,
        nudgeIntervalTokens: deps.config.nudge_interval_tokens ?? DEFAULT_NUDGE_INTERVAL_TOKENS,
        executeThresholdPercentage: deps.config.execute_threshold_percentage ?? 65,
        historyBudgetPercentage: deps.config.history_budget_percentage,
        commitClusterTrigger: deps.config.commit_cluster_trigger,
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
        sidekick: deps.config.sidekick?.enabled
            ? {
                  config: deps.config.sidekick,
                  projectPath,
                  sessionDirectory: deps.directory,
                  client: deps.client,
              }
            : undefined,
        dreamer: deps.config.dreamer
            ? {
                  config: deps.config.dreamer,
                  projectPath,
                  client: deps.client,
                  directory: deps.directory,
              }
            : undefined,
    });

    const emergencyNudgeFired = new Set<string>();

    const systemPromptHashHandler = createSystemPromptHashHandler({
        db,
        protectedTags: deps.config.protected_tags,
        ctxReduceEnabled,
        dreamerEnabled: deps.config.dreamer?.enabled === true,
        injectDocs: deps.config.dreamer?.inject_docs !== false,
        directory: deps.directory,
        flushedSessions,
        lastHeuristicsTurnId,
    });

    const eventHook = createEventHook({
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
        commitSeenLastPass,
        client: deps.client,
        protectedTags: deps.config.protected_tags,
        ctxReduceEnabled,
    });

    return {
        "experimental.chat.messages.transform": transform,
        "experimental.chat.system.transform": systemPromptHashHandler,
        "experimental.text.complete": createTextCompleteHandler(),
        "chat.message": createChatMessageHook({
            db,
            toolUsageSinceUserTurn,
            recentReduceBySession,
            variantBySession,
            flushedSessions,
            lastHeuristicsTurnId,
            ctxReduceEnabled,
        }),
        event: async (input: { event: { type: string; properties?: unknown } }) => {
            await eventHook(input);
            if (input.event.type === "message.updated") {
                runDreamQueueInBackground();
            }
        },
        "command.execute.before": createCommandExecuteBeforeHook(commandHandler),
        "tool.execute.after": createToolExecuteAfterHook({
            db,
            recentReduceBySession,
            toolUsageSinceUserTurn,
        }),
    };
}
