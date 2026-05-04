import {
    DEFAULT_HISTORIAN_TIMEOUT_MS,
    DEFAULT_NUDGE_INTERVAL_TOKENS,
    type DreamerConfig,
    type HistorianConfig,
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
import { deriveHistorianChunkTokens, resolveHistorianContextLimit } from "./derive-budgets";
import { createEventHandler } from "./event-handler";
import { resolveContextLimit, resolveModelKey } from "./event-resolvers";
import { clearInjectionCache } from "./inject-compartments";
import { createNudger } from "./nudger";
import { findLastAssistantModelFromOpenCodeDb } from "./read-session-db";
import { createTextCompleteHandler } from "./text-complete";
import { createNudgePlacementStore, createTransform } from "./transform";

export type { CommandExecuteInput, CommandExecuteOutput } from "./command-handler";

import { checkCompactionMarkerConsistency } from "./compaction-marker-manager";
import { executeContextRecomp } from "./compartment-runner";
import {
    createChatMessageHook,
    createCommandExecuteBeforeHook,
    createEventHook,
    createToolExecuteAfterHook,
    getLiveNotificationParams,
} from "./hook-handlers";
import type { LiveSessionState } from "./live-session-state";
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
    liveSessionState?: LiveSessionState;
    config: {
        protected_tags: number;
        ctx_reduce_enabled?: boolean;
        nudge_interval_tokens?: number;
        auto_drop_tool_age?: number;
        drop_tool_structure?: boolean;
        clear_reasoning_age?: number;
        iteration_nudge_threshold?: number;
        execute_threshold_percentage?: number | { default: number; [modelKey: string]: number };
        execute_threshold_tokens?: { default?: number; [modelKey: string]: number | undefined };
        cache_ttl: string | Record<string, string>;

        historian?: HistorianConfig;
        history_budget_percentage?: number;
        historian_timeout_ms?: number;
        memory?: {
            enabled: boolean;
            injection_budget_tokens: number;
            /** When true, historian/recomp auto-promote eligible session facts
             *  to project memories. When false, promotion is skipped. Issue #44. */
            auto_promote?: boolean;
        };
        embedding?: {
            provider?: "local" | "openai-compatible" | "off";
        };
        sidekick?: SidekickConfig;
        dreamer?: DreamerConfig;
        commit_cluster_trigger?: { enabled: boolean; min_clusters: number };
        compaction_markers?: boolean;
        compressor?: {
            enabled: boolean;
            min_compartment_ratio: number;
            max_merge_depth: number;
            cooldown_ms: number;
        };
        experimental?: {
            temporal_awareness?: boolean;
            git_commit_indexing?: { enabled: boolean; since_days: number; max_commits: number };
            auto_search?: {
                enabled: boolean;
                score_threshold: number;
                min_prompt_chars: number;
            };
            caveman_text_compression?: {
                enabled: boolean;
                min_chars: number;
            };
        };
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

    // Startup consistency check: reconcile any compaction markers whose state
    // references rows that no longer exist in OpenCode's DB. This can happen
    // if the plugin crashed between DB writes (context.db + opencode.db are
    // separate stores with no cross-DB transaction) or if OpenCode's DB was
    // modified externally. Gated on the same flag as marker writes.
    if (deps.config.compaction_markers !== false) {
        try {
            checkCompactionMarkerConsistency(db);
        } catch (error) {
            log("[magic-context] startup compaction-marker consistency check failed:", error);
        }
    }

    let lastScheduleCheckMs = 0;

    // Derive historian chunk budget from the historian model's own context window.
    // Historian is a single-shot summarizer, so its input is bounded by its OWN
    // context, not the main session model's. Re-derived per historian invocation
    // (matching RPC/TUI paths) so config/model changes take effect without
    // restart, and so all trigger sources produce consistent chunk sizes.
    const getHistorianChunkTokens = (): number =>
        deriveHistorianChunkTokens(resolveHistorianContextLimit(deps.config.historian?.model));

    const nudgePlacements = createNudgePlacementStore(db);
    // Three independent cache-busting signal sets, sourced from the
    // process-scoped LiveSessionState so RPC handlers (TUI recomp) can
    // share the same instances as the hook (server /ctx-recomp). When
    // `liveSessionState` is omitted (test-only path), fall back to local
    // sets — the production index.ts always provides one. See
    // live-session-state.ts and hook-handlers.ts doc-comments for the
    // full split rationale.
    const historyRefreshSessions =
        deps.liveSessionState?.historyRefreshSessions ?? new Set<string>();
    const systemPromptRefreshSessions =
        deps.liveSessionState?.systemPromptRefreshSessions ?? new Set<string>();
    const pendingMaterializationSessions =
        deps.liveSessionState?.pendingMaterializationSessions ?? new Set<string>();
    const lastHeuristicsTurnId = new Map<string, string>();
    const commitSeenLastPass = new Map<string, boolean>();
    const variantBySession =
        deps.liveSessionState?.variantBySession ?? new Map<string, string | undefined>();
    const liveModelBySession =
        deps.liveSessionState?.liveModelBySession ??
        new Map<string, { providerID: string; modelID: string }>();
    const agentBySession = deps.liveSessionState?.agentBySession ?? new Map<string, string>();
    const recentReduceBySession = new Map<string, number>();
    const toolUsageSinceUserTurn = new Map<string, number>();

    /**
     * Return the live provider/model for a session.
     *
     * Prefers the in-memory `liveModelBySession` map populated by transform passes
     * and `chat.message` hooks. When the map is empty (for example `/ctx-status`
     * is invoked before any transform pass has run since restart), falls back to
     * reading the last assistant message from OpenCode's SQLite DB and caches the
     * result so subsequent calls in the same process don't hit the DB again.
     *
     * Returns undefined only for brand-new sessions with no assistant turn yet.
     */
    const resolveLiveModel = (
        sessionId: string,
    ): { providerID: string; modelID: string } | undefined => {
        const cached = liveModelBySession.get(sessionId);
        if (cached) return cached;
        const recovered = findLastAssistantModelFromOpenCodeDb(sessionId);
        if (recovered) {
            liveModelBySession.set(sessionId, recovered);
            return recovered;
        }
        return undefined;
    };
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
        ctxReduceEnabled,
        autoDropToolAge: deps.config.auto_drop_tool_age ?? 100,
        dropToolStructure: deps.config.drop_tool_structure ?? true,
        clearReasoningAge: deps.config.clear_reasoning_age ?? 50,
        historyRefreshSessions,
        pendingMaterializationSessions,
        lastHeuristicsTurnId,
        commitSeenLastPass,
        client: deps.client,
        directory: deps.directory,
        memoryConfig: deps.config.memory
            ? {
                  enabled: deps.config.memory.enabled,
                  injectionBudgetTokens: deps.config.memory.injection_budget_tokens,
                  // Issue #44: thread auto_promote through. Default true to
                  // preserve historical behavior when the field is missing.
                  autoPromote: deps.config.memory.auto_promote ?? true,
              }
            : undefined,
        getHistorianChunkTokens,
        historyBudgetPercentage: deps.config.history_budget_percentage,
        executeThresholdPercentage: deps.config.execute_threshold_percentage,
        executeThresholdTokens: deps.config.execute_threshold_tokens,
        historianTimeoutMs: deps.config.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
        getNotificationParams: (sessionId) =>
            getLiveNotificationParams(
                sessionId,
                liveModelBySession,
                variantBySession,
                agentBySession,
            ),
        getModelKey: (sessionId) => {
            const model = liveModelBySession.get(sessionId);
            return resolveModelKey(model?.providerID, model?.modelID);
        },
        getFallbackModelId: (sessionId) => {
            const model = liveModelBySession.get(sessionId);
            return model ? `${model.providerID}/${model.modelID}` : undefined;
        },
        projectPath,
        experimentalCompactionMarkers: deps.config.compaction_markers,
        experimentalUserMemories: deps.config.dreamer?.user_memories?.enabled,
        experimentalTemporalAwareness: deps.config.experimental?.temporal_awareness === true,
        historianTwoPass: deps.config.historian?.two_pass === true,
        compressorMinCompartmentRatio:
            deps.config.compressor?.enabled === false
                ? undefined
                : deps.config.compressor?.min_compartment_ratio,
        compressorMaxMergeDepth:
            deps.config.compressor?.enabled === false
                ? undefined
                : deps.config.compressor?.max_merge_depth,
        compressorCooldownMs:
            deps.config.compressor?.enabled === false
                ? undefined
                : deps.config.compressor?.cooldown_ms,
        liveModelBySession,
        autoSearch: deps.config.experimental?.auto_search?.enabled
            ? {
                  enabled: true,
                  scoreThreshold: deps.config.experimental.auto_search.score_threshold,
                  minPromptChars: deps.config.experimental.auto_search.min_prompt_chars,
                  memoryEnabled: deps.config.memory?.enabled !== false,
                  // Gate semantic search on the actual embedding provider, not
                  // on auto_search itself — the outer `if` already gates on
                  // auto_search.enabled. If the provider is "off" we still
                  // want FTS-backed message/memory hits to drive the hint.
                  embeddingEnabled: deps.config.embedding?.provider !== "off",
                  gitCommitsEnabled:
                      deps.config.experimental?.git_commit_indexing?.enabled === true,
              }
            : undefined,
        // Age-tier caveman text compression — only honored when
        // ctx_reduce_enabled: false. Transform gates this itself too, but we
        // avoid wiring the feature at all when ctx_reduce is on so the
        // transform deps stay clean.
        cavemanTextCompression:
            ctxReduceEnabled === false &&
            deps.config.experimental?.caveman_text_compression?.enabled === true
                ? {
                      enabled: true,
                      minChars: deps.config.experimental.caveman_text_compression.min_chars ?? 500,
                  }
                : undefined,
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
        // Clean up per-session state the system-prompt handler maintains so
        // these module/closure-scope maps don't accumulate entries over the
        // plugin's lifetime (Finding #3).
        onSessionDeleted: (sessionId: string) => {
            systemPromptHash.clearSession(sessionId);
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
            experimentalUserMemories: deps.config.dreamer?.user_memories?.enabled
                ? {
                      enabled: true,
                      promotionThreshold: deps.config.dreamer.user_memories.promotion_threshold,
                  }
                : undefined,
            experimentalPinKeyFiles: deps.config.dreamer?.pin_key_files?.enabled
                ? {
                      enabled: true,
                      token_budget: deps.config.dreamer.pin_key_files.token_budget,
                      min_reads: deps.config.dreamer.pin_key_files.min_reads,
                  }
                : undefined,
        }).catch((error: unknown) => {
            log("[dreamer] scheduled queue processing failed:", error);
        });
    };

    const commandHandler = createMagicContextCommandHandler({
        db,
        protectedTags: deps.config.protected_tags,
        nudgeIntervalTokens: deps.config.nudge_interval_tokens ?? DEFAULT_NUDGE_INTERVAL_TOKENS,
        executeThresholdPercentage: deps.config.execute_threshold_percentage ?? 65,
        executeThresholdTokens: deps.config.execute_threshold_tokens,
        historyBudgetPercentage: deps.config.history_budget_percentage,
        commitClusterTrigger: deps.config.commit_cluster_trigger,
        getLiveModelKey: (sessionId) => {
            // Use DB fallback so /ctx-status shows the correct model-specific
            // threshold even before the first transform pass has populated
            // liveModelBySession after restart. Without this, the resolver
            // falls back to the default threshold and displays a stale budget.
            const model = resolveLiveModel(sessionId);
            return model ? `${model.providerID}/${model.modelID}` : undefined;
        },
        getContextLimit: (sessionId) => {
            // Same DB fallback as getLiveModelKey — /ctx-status's "Resolved
            // context limit" and history-budget math depend on the live model.
            const model = resolveLiveModel(sessionId);
            if (!model) return undefined;
            return resolveContextLimit(model.providerID, model.modelID);
        },
        // /ctx-flush is a user-initiated full refresh: signal all three sets.
        // History rebuild + system-prompt adjuncts + force materialize.
        onFlush: (sessionId) => {
            historyRefreshSessions.add(sessionId);
            systemPromptRefreshSessions.add(sessionId);
            pendingMaterializationSessions.add(sessionId);
        },
        executeRecomp: async (sessionId, options) =>
            executeContextRecomp(
                {
                    client: deps.client,
                    db,
                    sessionId,
                    historianChunkTokens: getHistorianChunkTokens(),
                    historianTimeoutMs:
                        deps.config.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
                    directory: deps.directory,
                    fallbackModelId: (() => {
                        // DB fallback so /ctx-recomp's last-resort fallback model
                        // is known even when invoked before the first transform.
                        const model = resolveLiveModel(sessionId);
                        return model ? `${model.providerID}/${model.modelID}` : undefined;
                    })(),
                    getNotificationParams: () =>
                        getLiveNotificationParams(
                            sessionId,
                            liveModelBySession,
                            variantBySession,
                            agentBySession,
                        ),
                    historianTwoPass: deps.config.historian?.two_pass === true,
                    // Issue #44: respect memory feature gates from /ctx-recomp too.
                    memoryEnabled: deps.config.memory?.enabled,
                    autoPromote: deps.config.memory?.auto_promote ?? true,
                    // Recomp invalidates injection cache and queues drop ops
                    // via queueDropsForCompartmentalizedMessages. Signal both
                    // history-rebuild (one-shot for the next transform) and
                    // pending-materialization (persistent until heuristics
                    // succeed). NOT systemPromptRefresh — recomp doesn't
                    // touch disk-backed adjuncts. See council Finding #9.
                    onInjectionCacheCleared: (sid) => {
                        historyRefreshSessions.add(sid);
                        pendingMaterializationSessions.add(sid);
                    },
                },
                options,
            ),
        sendNotification: async (sessionId, text, params) => {
            await sendIgnoredMessage(deps.client, sessionId, text, {
                ...getLiveNotificationParams(
                    sessionId,
                    liveModelBySession,
                    variantBySession,
                    agentBySession,
                ),
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
                  experimentalUserMemories: deps.config.dreamer?.user_memories?.enabled
                      ? {
                            enabled: true,
                            promotionThreshold:
                                deps.config.dreamer.user_memories.promotion_threshold,
                        }
                      : undefined,
                  experimentalPinKeyFiles: deps.config.dreamer?.pin_key_files?.enabled
                      ? {
                            enabled: true,
                            token_budget: deps.config.dreamer.pin_key_files.token_budget,
                            min_reads: deps.config.dreamer.pin_key_files.min_reads,
                        }
                      : undefined,
              }
            : undefined,
    });

    const systemPromptHash = createSystemPromptHashHandler({
        db,
        protectedTags: deps.config.protected_tags,
        ctxReduceEnabled,
        dropToolStructure: deps.config.drop_tool_structure ?? true,
        dreamerEnabled: deps.config.dreamer?.enabled === true,
        injectDocs: deps.config.dreamer?.inject_docs !== false,
        directory: deps.directory,
        // System-prompt-hash handler reads systemPromptRefreshSessions to
        // decide whether to re-read disk-backed adjuncts (docs, profile,
        // key files, sticky date), and adds to all three sets when it
        // detects a real prompt-content change.
        historyRefreshSessions,
        systemPromptRefreshSessions,
        pendingMaterializationSessions,
        lastHeuristicsTurnId,
        experimentalUserMemories: deps.config.dreamer?.user_memories?.enabled,
        experimentalPinKeyFiles: deps.config.dreamer?.pin_key_files?.enabled ?? false,
        experimentalPinKeyFilesTokenBudget: deps.config.dreamer?.pin_key_files?.token_budget,
        experimentalTemporalAwareness: deps.config.experimental?.temporal_awareness === true,
        // Caveman text compression only runs when ctx_reduce_enabled === false
        // (gated in transform.ts and in hook.ts cavemanTextCompression wiring above).
        // Mirror that gate here so the prompt warning never appears in modes where
        // caveman won't actually compress anything.
        experimentalCavemanTextCompression:
            ctxReduceEnabled === false &&
            deps.config.experimental?.caveman_text_compression?.enabled === true,
    });
    const systemPromptHashHandler = systemPromptHash.handler;

    const eventHook = createEventHook({
        eventHandler,
        contextUsageMap,
        db,
        liveModelBySession,
        variantBySession,
        agentBySession,
        recentReduceBySession,
        toolUsageSinceUserTurn,
        historyRefreshSessions,
        systemPromptRefreshSessions,
        pendingMaterializationSessions,
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
            liveModelBySession,
            variantBySession,
            agentBySession,
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
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
