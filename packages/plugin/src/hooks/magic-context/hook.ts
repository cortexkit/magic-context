import {
    isDreamerRunnable,
    isHistorianRunnable,
    isSidekickRunnable,
} from "../../config/agent-disable";
import {
    DEFAULT_HISTORIAN_TIMEOUT_MS,
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
import {
    embedSessionCompartmentChunks,
    getEmbeddingCoverageStatus,
} from "../../features/magic-context/project-embedding-registry";
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    getDatabasePersistenceError,
    getSessionsWithPendingMarker,
    isDatabasePersisted,
    openDatabase,
} from "../../features/magic-context/storage";
import type { Tagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "../../plugin/embedding-bootstrap";
import type { PluginContext } from "../../plugin/types";
import { getErrorMessage } from "../../shared/error-message";
import { log } from "../../shared/logger";
import { resolveFallbackChain } from "../../shared/resolve-fallbacks";
import { isTuiConnected, pushNotification } from "../../shared/rpc-notifications";
import type { Database } from "../../shared/sqlite";
import { createMagicContextCommandHandler } from "./command-handler";
import { deriveHistorianChunkTokens, resolveHistorianContextLimit } from "./derive-budgets";
import {
    autoEmbedAttemptedBySession,
    clearEmbedSessionState,
    embedPauseBySession,
    embedRunStateBySession,
    getEmbedDrainUiStatus,
} from "./embed-session-state";
import { createEventHandler } from "./event-handler";
import { resolveContextLimit, resolveModelKey } from "./event-resolvers";
import { formatEmbedStatusText } from "./format-embed-status";
import { clearInjectionCache } from "./inject-compartments";
import { findLastAssistantModelFromOpenCodeDb } from "./read-session-db";
import type { ManagedRecompContext } from "./recomp-orchestrator";
import {
    runManagedRecomp,
    runManagedUpgrade,
    setRecompStarting,
    setRecompTerminal,
} from "./recomp-orchestrator";
import { createTextCompleteHandler } from "./text-complete";
import { createTransform } from "./transform";

export type { CommandExecuteInput, CommandExecuteOutput } from "./command-handler";

import { checkCompactionMarkerConsistency } from "./compaction-marker-manager";
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
import { maybeSendUpgradeReminder } from "./upgrade-reminder";

const DREAM_SCHEDULE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
// NOTE: lastScheduleCheckMs is intentionally inside createMagicContextHook (not module scope)
// so each hook instance has independent dream-schedule tracking across projects.

export interface MagicContextDeps {
    client: PluginContext["client"];
    directory: string;
    /** Live HTTP listener URL for the Channel 2 ceiling nudge (#28202 workaround). */
    serverUrl?: string;
    tagger: Tagger;
    scheduler: Scheduler;
    onSessionCacheInvalidated?: (sessionId: string) => void;
    compactionHandler: ReturnType<typeof createCompactionHandler>;
    liveSessionState?: LiveSessionState;
    config: {
        protected_tags: number;
        ctx_reduce_enabled?: boolean;
        toast_duration_ms?: number;
        clear_reasoning_age?: number;
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
            /** Graduated from experimental.auto_search; now memory-scoped. */
            auto_search?: {
                enabled: boolean;
                score_threshold: number;
                min_prompt_chars: number;
            };
        };
        embedding?: {
            provider?: "local" | "openai-compatible" | "off";
        };
        sidekick?: SidekickConfig;
        dreamer?: DreamerConfig;
        commit_cluster_trigger?: { enabled: boolean; min_clusters: number };
        /** Issue #53: per-agent system-prompt injection opt-out. Optional in
         *  the inline type so legacy tests/callers don't have to construct it;
         *  Zod's .default() guarantees it's present in real loaded configs. */
        system_prompt_injection?: { enabled: boolean; skip_signatures: string[] };
        temporal_awareness?: boolean;
        caveman_text_compression?: {
            enabled: boolean;
            min_chars: number;
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
    let db: Database;
    try {
        const opened = openDatabase();
        if (!opened || !isDatabasePersisted(opened)) {
            const reason =
                (opened ? getDatabasePersistenceError(opened) : null) ??
                "Failed to initialize the persistent SQLite database.";
            log(
                "[magic-context] disabling feature because persistent storage is unavailable:",
                reason,
            );
            notifyMagicContextDisabled(deps.client, reason);
            return null;
        }
        db = opened;
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
    // modified externally.
    try {
        checkCompactionMarkerConsistency(db);
    } catch (error) {
        log("[magic-context] startup compaction-marker consistency check failed:", error);
    }

    let lastScheduleCheckMs = 0;

    // Derive historian chunk budget from the historian model's own context window.
    // Historian is a single-shot summarizer, so its input is bounded by its OWN
    // context, not the main session model's. Re-derived per historian invocation
    // (matching RPC/TUI paths) so config/model changes take effect without
    // restart, and so all trigger sources produce consistent chunk sizes.
    const getHistorianChunkTokens = (): number =>
        deriveHistorianChunkTokens(resolveHistorianContextLimit(deps.config.historian?.model));
    const historianFallbackModels = resolveFallbackChain(deps.config.historian?.fallback_models);

    // Three independent cache-busting signal sets, sourced from the
    // process-scoped LiveSessionState so RPC handlers (TUI recomp) can
    // share the same instances as the hook (server /ctx-recomp). When
    // `liveSessionState` is omitted (test-only path), fall back to local
    // sets — the production index.ts always provides one. See
    // live-session-state.ts and hook-handlers.ts doc-comments for the
    // full split rationale.
    const historyRefreshSessions =
        deps.liveSessionState?.historyRefreshSessions ?? new Set<string>();
    const deferredHistoryRefreshSessions =
        deps.liveSessionState?.deferredHistoryRefreshSessions ?? new Set<string>();

    // Plan v6 §7: hook-init rehydration of deferred-marker drain state. A
    // publish that wrote `pending_compaction_marker_state` before the plugin
    // process exited (crash, restart) must still get its drain pass; seed
    // `deferredHistoryRefreshSessions` from the persisted pending blobs so the
    // next consuming transform pass picks them up via
    // `applyDeferredCompactionMarker`. Idempotent — running twice just re-adds
    // the same session ids to the Set.
    try {
        const sessionsWithPending = getSessionsWithPendingMarker(db);
        if (sessionsWithPending.length > 0) {
            for (const sid of sessionsWithPending) {
                deferredHistoryRefreshSessions.add(sid);
            }
            log(
                `[magic-context] rehydrated ${sessionsWithPending.length} session(s) with pending compaction-marker drain at hook init`,
            );
        }
    } catch (error) {
        log("[magic-context] hook init: pending-marker rehydration failed:", error);
    }

    const systemPromptRefreshSessions =
        deps.liveSessionState?.systemPromptRefreshSessions ?? new Set<string>();
    const pendingMaterializationSessions =
        deps.liveSessionState?.pendingMaterializationSessions ?? new Set<string>();
    const deferredMaterializationSessions =
        deps.liveSessionState?.deferredMaterializationSessions ?? new Set<string>();
    const lastHeuristicsTurnId = new Map<string, string>();
    const commitSeenLastPass = new Map<string, boolean>();
    const variantBySession =
        deps.liveSessionState?.variantBySession ?? new Map<string, string | undefined>();
    const liveModelBySession =
        deps.liveSessionState?.liveModelBySession ??
        new Map<string, { providerID: string; modelID: string }>();
    const agentBySession = deps.liveSessionState?.agentBySession ?? new Map<string, string>();
    const sessionDirectoryBySession =
        deps.liveSessionState?.sessionDirectoryBySession ?? new Map<string, string>();
    const internalChildSessions = deps.liveSessionState?.internalChildSessions ?? new Set<string>();
    // Recomp/upgrade progress map — shared with the RPC sidebar/status snapshot
    // when liveSessionState is provided (production), local fallback in tests.
    const recompProgressBySession =
        deps.liveSessionState?.recompProgressBySession ??
        new Map<string, import("./compartment-runner-types").RecompProgress>();
    // Channel 1 (ctx_reduce tool-output nudge) per-session metric baseline.
    // Written at the end of each transform pass (post-drop), read in
    // tool.execute.after. Only populated for primary sessions.
    const channel1StateBySession = new Map<string, import("./ctx-reduce-nudge").Channel1State>();

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
    const dreamerRunnable = isDreamerRunnable(deps.config);
    const dreamerConfig = dreamerRunnable ? deps.config.dreamer : undefined;
    const historianRunnable = isHistorianRunnable(deps.config);

    // Shared context for the recomp/upgrade orchestrator. Both `/ctx-recomp` and
    // `/ctx-session-upgrade` (command paths) build this so they run through the
    // exact same runner as the RPC dialog paths — identical fallback, progress,
    // and terminal state. `fallbackModelId` is resolved here with the OpenCode-DB
    // recovery (resolveLiveModel) so the last-resort fallback model is known even
    // when a command is invoked before the first transform pass populates the map.
    const buildManagedRecompCtx = (sessionId: string): ManagedRecompContext => ({
        client: deps.client,
        db,
        // Pass the SAME map/set instances the hook uses so the orchestrator's
        // writes (progress, session-dir cache, refresh signals) propagate to the
        // shared live state — and the next transform pass + RPC sidebar see them.
        liveSessionState: {
            liveModelBySession,
            variantBySession,
            agentBySession,
            historyRefreshSessions,
            deferredHistoryRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
            deferredMaterializationSessions,
            sessionDirectoryBySession,
            recompProgressBySession,
            internalChildSessions,
        },
        directory: deps.directory,
        historianChunkTokens: getHistorianChunkTokens(),
        historianTimeoutMs: deps.config.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
        memoryEnabled: deps.config.memory?.enabled ?? true,
        autoPromote: deps.config.memory?.auto_promote ?? true,
        fallbackModels: historianFallbackModels,
        fallbackModelId: (() => {
            const model = resolveLiveModel(sessionId);
            return model ? `${model.providerID}/${model.modelID}` : undefined;
        })(),
        historianTwoPass: deps.config.historian?.two_pass === true,
        runMigration: deps.config.memory?.enabled !== false && !!deps.config.historian?.model,
        userMemoriesEnabled: dreamerConfig?.user_memories?.enabled === true,
        ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
        getNotificationParams: (sid) =>
            getLiveNotificationParams(
                sid,
                liveModelBySession,
                variantBySession,
                agentBySession,
                deps.config.toast_duration_ms,
            ),
    });
    // /ctx-embed start: backfill THIS session's compartment chunk embeddings,
    // reusing the recomp progress surface (sidebar + status bar) with kind="embed".
    const executeEmbedHistory = async (
        sessionId: string,
        options?: { signal?: AbortSignal; silent?: boolean },
    ): Promise<string> => {
        if (deps.config.memory?.enabled === false) {
            return "Memory is disabled for this project, so there is no semantic embedding to backfill.";
        }
        const directory = sessionDirectoryBySession.get(sessionId) ?? deps.directory;
        // Idempotent start: if a drain is already running for this session, don't
        // abort it and re-acquire — that races the just-released lease and returns
        // "busy", killing the active run for nothing. Just report it's running.
        const active = embedRunStateBySession.get(sessionId);
        if (active && !active.signal.aborted && !options?.signal) {
            return "Embedding is already running for this session.";
        }
        await ensureProjectRegisteredFromOpenCodeDirectory(directory, db);
        const sessionProjectIdentity = resolveProjectIdentity(directory);
        embedPauseBySession.delete(sessionId);
        const prior = embedRunStateBySession.get(sessionId);
        if (prior) prior.abort();
        const controller = new AbortController();
        embedRunStateBySession.set(sessionId, controller);
        const signal = options?.signal ?? controller.signal;
        if (!options?.silent) {
            setRecompStarting(
                { recompProgressBySession } as LiveSessionState,
                sessionId,
                "Embedding history…",
                "embed",
            );
        }
        let runFailed = 0;
        let outcome: Awaited<ReturnType<typeof embedSessionCompartmentChunks>>;
        try {
            outcome = await embedSessionCompartmentChunks(db, sessionProjectIdentity, sessionId, {
                signal,
                onProgress: ({ embedded, total }) => {
                    const cur = recompProgressBySession.get(sessionId);
                    if (!cur || cur.phase !== "recomp") return;
                    recompProgressBySession.set(sessionId, {
                        ...cur,
                        processedMessages: embedded,
                        totalMessages: total,
                        updatedAt: Date.now(),
                    });
                },
            });
        } finally {
            // Always release the per-session controller, even if the drain threw
            // (a release-time SQLite error, etc.) — otherwise a stale controller
            // would make every later start return "already running".
            if (embedRunStateBySession.get(sessionId) === controller) {
                embedRunStateBySession.delete(sessionId);
            }
        }
        if ("failed" in outcome) runFailed = outcome.failed;
        const terminal = (phase: "done" | "skipped", message: string): string => {
            if (!options?.silent) {
                setRecompTerminal(
                    { recompProgressBySession } as LiveSessionState,
                    sessionId,
                    phase,
                    message,
                );
            }
            return message;
        };
        switch (outcome.status) {
            case "nothing":
                return terminal("done", "All of this session's history is already embedded.");
            case "disabled":
                return terminal(
                    "skipped",
                    "No embedding provider is configured, so there is nothing to embed.",
                );
            case "busy":
                return terminal(
                    "skipped",
                    "Embedding is already running for this project. Try again shortly.",
                );
            case "aborted": {
                // A drain only aborts via user pause (or session teardown). Render
                // it as the neutral "skipped" terminal — NOT "done", which the
                // sidebar shows as a green "✓ Embed complete" that wrongly reads as
                // finished.
                const cov = getEmbeddingCoverageStatus(db, sessionProjectIdentity, sessionId);
                const msg = `Paused at ${cov.session.embedded}/${cov.session.total} compartments embedded.`;
                return terminal("skipped", msg);
            }
            case "stalled":
                return terminal(
                    "skipped",
                    `Embedded ${outcome.embedded} compartments; ${outcome.remaining} could not be embedded (the provider returned no result). Run /ctx-embed start again to retry them.`,
                );
            default:
                return terminal(
                    "done",
                    `Embedded ${outcome.embedded} compartment${outcome.embedded === 1 ? "" : "s"} of history for semantic search${runFailed > 0 ? ` (${runFailed} failed)` : ""}.`,
                );
        }
    };

    const pauseEmbedDrain = (sessionId: string): string => {
        embedPauseBySession.add(sessionId);
        const ctrl = embedRunStateBySession.get(sessionId);
        if (ctrl) ctrl.abort();
        const directory = sessionDirectoryBySession.get(sessionId) ?? deps.directory;
        const sessionProjectIdentity = resolveProjectIdentity(directory);
        const cov = getEmbeddingCoverageStatus(db, sessionProjectIdentity, sessionId);
        return `Paused at ${cov.session.embedded}/${cov.session.total} compartments embedded.`;
    };

    const getEmbedStatusText = (sessionId: string): string => {
        const directory = sessionDirectoryBySession.get(sessionId) ?? deps.directory;
        const sessionProjectIdentity = resolveProjectIdentity(directory);
        const coverage = getEmbeddingCoverageStatus(db, sessionProjectIdentity, sessionId);
        const progress = recompProgressBySession.get(sessionId);
        const drainUi = getEmbedDrainUiStatus(sessionId, progress);
        return formatEmbedStatusText(coverage, {
            status: drainUi.status,
            embedded: progress?.processedMessages,
            total: progress?.totalMessages,
        });
    };

    const maybeAutoEmbedSession = (sessionId: string): void => {
        if (autoEmbedAttemptedBySession.has(sessionId)) return;
        if (embedPauseBySession.has(sessionId)) return;
        if (deps.config.memory?.enabled === false) return;
        autoEmbedAttemptedBySession.add(sessionId);
        const directory = sessionDirectoryBySession.get(sessionId) ?? deps.directory;
        void (async () => {
            try {
                // Defer off the transform thread BEFORE any DB/config work.
                // ensureProjectRegisteredFromOpenCodeDirectory is `async` but does
                // its config load + stale-embedding wipe SYNCHRONOUSLY (no internal
                // await), so awaiting it as the first statement would run that work
                // on the transform's return path. A macrotask yield lets the
                // transform return first, keeping the hot path clean.
                await new Promise((resolve) => setTimeout(resolve, 0));
                await ensureProjectRegisteredFromOpenCodeDirectory(directory, db);
                const sessionProjectIdentity = resolveProjectIdentity(directory);
                const coverage = getEmbeddingCoverageStatus(db, sessionProjectIdentity, sessionId);
                if (!coverage.enabled) return;
                const remaining = coverage.session.total - coverage.session.embedded;
                if (remaining <= 0) return;
                const notifyParams = getLiveNotificationParams(
                    sessionId,
                    liveModelBySession,
                    variantBySession,
                    agentBySession,
                );
                if (!isTuiConnected(sessionId)) {
                    const startMsg = `Embedding ${remaining} compartment${remaining === 1 ? "" : "s"} of history in the background…`;
                    await sendIgnoredMessage(deps.client, sessionId, startMsg, {
                        ...notifyParams,
                    });
                }
                const summary = await executeEmbedHistory(sessionId);
                if (!isTuiConnected(sessionId)) {
                    await sendIgnoredMessage(deps.client, sessionId, summary, {
                        ...notifyParams,
                    });
                }
            } catch (error) {
                log("[magic-context] auto-embed drain failed:", error);
            }
        })();
    };

    const sidekickRunnable = isSidekickRunnable(deps.config);
    const sidekickConfig = sidekickRunnable ? deps.config.sidekick : undefined;

    const transform = createTransform({
        tagger: deps.tagger,
        scheduler: deps.scheduler,
        contextUsageMap,
        db,
        channel1StateBySession,
        protectedTags: deps.config.protected_tags,
        ctxReduceEnabled,
        clearReasoningAge: deps.config.clear_reasoning_age ?? 50,
        commitClusterTrigger: deps.config.commit_cluster_trigger,
        historyRefreshSessions,
        deferredHistoryRefreshSessions,
        pendingMaterializationSessions,
        deferredMaterializationSessions,
        lastHeuristicsTurnId,
        commitSeenLastPass,
        internalChildSessions,
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
        ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
        getHistorianChunkTokens,
        historyBudgetPercentage: deps.config.history_budget_percentage,
        executeThresholdPercentage: deps.config.execute_threshold_percentage,
        executeThresholdTokens: deps.config.execute_threshold_tokens,
        historianTimeoutMs: deps.config.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
        fallbackModels: historianFallbackModels,
        getNotificationParams: (sessionId) =>
            getLiveNotificationParams(
                sessionId,
                liveModelBySession,
                variantBySession,
                agentBySession,
                deps.config.toast_duration_ms,
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
        historianRunnable,
        experimentalUserMemories: dreamerConfig?.user_memories?.enabled,
        experimentalPinKeyFiles: dreamerConfig?.pin_key_files?.enabled ?? false,
        experimentalPinKeyFilesTokenBudget: dreamerConfig?.pin_key_files?.token_budget,
        experimentalTemporalAwareness: deps.config.temporal_awareness === true,
        historianTwoPass: deps.config.historian?.two_pass === true,
        liveModelBySession,
        sessionDirectoryBySession,
        autoSearch: deps.config.memory?.auto_search?.enabled
            ? {
                  enabled: true,
                  scoreThreshold: deps.config.memory?.auto_search.score_threshold,
                  minPromptChars: deps.config.memory?.auto_search.min_prompt_chars,
                  directory: deps.directory,
                  ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
              }
            : undefined,
        // Age-tier caveman text compression — only honored when
        // ctx_reduce_enabled: false. Transform gates this itself too, but we
        // avoid wiring the feature at all when ctx_reduce is on so the
        // transform deps stay clean.
        cavemanTextCompression:
            ctxReduceEnabled === false && deps.config.caveman_text_compression?.enabled === true
                ? {
                      enabled: true,
                      minChars: deps.config.caveman_text_compression.min_chars ?? 500,
                  }
                : undefined,
        maybeAutoEmbedSession,
    });
    const eventHandler = createEventHandler({
        contextUsageMap,
        compactionHandler: deps.compactionHandler,
        config: deps.config,
        tagger: deps.tagger,
        db,
        client: deps.client,
        serverUrl: deps.serverUrl,
        directory: deps.directory,
        channel1StateBySession,
        internalChildSessions,
        getNotificationParams: (sessionId) =>
            getLiveNotificationParams(
                sessionId,
                liveModelBySession,
                variantBySession,
                agentBySession,
                deps.config.toast_duration_ms,
            ),
        onSessionCacheInvalidated: (sessionId: string) => {
            clearInjectionCache(sessionId);
            deps.onSessionCacheInvalidated?.(sessionId);
        },
        // Clean up per-session state the system-prompt handler maintains so
        // these module/closure-scope maps don't accumulate entries over the
        // plugin's lifetime (Finding #3).
        onSessionDeleted: (sessionId: string) => {
            systemPromptHash.clearSession(sessionId);
            // Prune every per-session map this hook closure owns. These
            // accumulate one entry per session for the plugin process lifetime
            // (which can span days/weeks across many sessions and subagents);
            // without this, a long-lived process leaks memory steadily. Some
            // maps are shared via liveSessionState — clearing on the terminal
            // session.deleted event is correct since the session is gone.
            lastHeuristicsTurnId.delete(sessionId);
            commitSeenLastPass.delete(sessionId);
            variantBySession.delete(sessionId);
            liveModelBySession.delete(sessionId);
            agentBySession.delete(sessionId);
            sessionDirectoryBySession.delete(sessionId);
            recompProgressBySession.delete(sessionId);
            internalChildSessions.delete(sessionId);
            channel1StateBySession.delete(sessionId);
            clearEmbedSessionState(sessionId);
        },
    });

    const runDreamQueueInBackground = (): void => {
        const dreaming = deps.config.dreamer;
        if (!dreaming || dreaming.disable === true || !dreaming.schedule?.trim()) {
            return;
        }

        const now = Date.now();
        if (now - lastScheduleCheckMs < DREAM_SCHEDULE_CHECK_INTERVAL_MS) {
            return;
        }

        try {
            checkScheduleAndEnqueue(db, dreaming.schedule, projectPath);
            lastScheduleCheckMs = now;
        } catch (error) {
            log("[dreamer] scheduled enqueue check failed:", error);
            return;
        }

        void processDreamQueue({
            db,
            client: deps.client,
            // Run in the directory this hook instance owns, not a stale sibling
            // checkout resolved from the shared git:<sha> identity map.
            sessionDirectoryOverride: deps.directory,
            tasks: dreaming.tasks,
            taskTimeoutMinutes: dreaming.task_timeout_minutes,
            maxRuntimeMinutes: dreaming.max_runtime_minutes,
            experimentalUserMemories: dreaming.user_memories?.enabled
                ? {
                      enabled: true,
                      promotionThreshold: dreaming.user_memories.promotion_threshold,
                  }
                : undefined,
            experimentalPinKeyFiles: dreaming.pin_key_files?.enabled
                ? {
                      enabled: true,
                      token_budget: dreaming.pin_key_files.token_budget,
                      min_reads: dreaming.pin_key_files.min_reads,
                  }
                : undefined,
            fallbackModels: resolveFallbackChain(dreaming.fallback_models),
            projectIdentity: projectPath,
        }).catch((error: unknown) => {
            log("[dreamer] scheduled queue processing failed:", error);
        });
    };

    const commandHandler = createMagicContextCommandHandler({
        db,
        protectedTags: deps.config.protected_tags,
        toastDurationMs: deps.config.toast_duration_ms,
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
        // E3 (recomp) + /ctx-session-upgrade: both run through the SHARED
        // orchestrator (runManagedRecomp / runManagedUpgrade) so the command
        // paths get identical model fallback + live progress + terminal state as
        // the RPC dialog paths. Dogfood 2026-05-30: previously the command path
        // had fallback but no progress (sidebar stuck on stale "failed") while
        // the RPC dialog had progress but no fallback (failed on empty primary
        // model). One runner closes both gaps.
        executeRecomp: historianRunnable
            ? async (sessionId, options) =>
                  runManagedRecomp(buildManagedRecompCtx(sessionId), sessionId, options)
            : undefined,
        // E3.2 — /ctx-session-upgrade: full recomp + once-per-project memory
        // migration in one managed run. The command handler delivers the result.
        runUpgrade: historianRunnable
            ? async (sessionId: string) =>
                  runManagedUpgrade(buildManagedRecompCtx(sessionId), sessionId)
            : undefined,
        executeEmbedHistory,
        pauseEmbedDrain,
        getEmbedStatusText,
        sendNotification: async (sessionId, text, params) => {
            await sendIgnoredMessage(deps.client, sessionId, text, {
                ...getLiveNotificationParams(
                    sessionId,
                    liveModelBySession,
                    variantBySession,
                    agentBySession,
                    deps.config.toast_duration_ms,
                ),
                ...params,
            });
        },
        sidekick: sidekickConfig
            ? {
                  config: sidekickConfig,
                  projectPath,
                  sessionDirectory: deps.directory,
                  client: deps.client,
              }
            : undefined,
        dreamer: dreamerConfig
            ? {
                  config: dreamerConfig,
                  projectPath,
                  client: deps.client,
                  directory: deps.directory,
                  experimentalUserMemories: dreamerConfig.user_memories?.enabled
                      ? {
                            enabled: true,
                            promotionThreshold: dreamerConfig.user_memories.promotion_threshold,
                        }
                      : undefined,
                  experimentalPinKeyFiles: dreamerConfig.pin_key_files?.enabled
                      ? {
                            enabled: true,
                            token_budget: dreamerConfig.pin_key_files.token_budget,
                            min_reads: dreamerConfig.pin_key_files.min_reads,
                        }
                      : undefined,
                  fallbackModels: resolveFallbackChain(dreamerConfig.fallback_models),
              }
            : undefined,
    });

    const systemPromptHash = createSystemPromptHashHandler({
        db,
        protectedTags: deps.config.protected_tags,
        ctxReduceEnabled,
        dreamerEnabled: dreamerRunnable,
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
        // Issue #53: per-agent injection opt-out via config.
        // Defensive defaults for tests/legacy callers that pre-date the
        // schema field; Zod's .default() handles real loaded configs.
        injectionEnabled: deps.config.system_prompt_injection?.enabled ?? true,
        injectionSkipSignatures: deps.config.system_prompt_injection?.skip_signatures ?? [
            "<!-- magic-context: skip -->",
        ],
        internalChildSessions,
        experimentalUserMemories: deps.config.dreamer?.user_memories?.enabled,
        experimentalPinKeyFiles: deps.config.dreamer?.pin_key_files?.enabled ?? false,
        experimentalPinKeyFilesTokenBudget: deps.config.dreamer?.pin_key_files?.token_budget,
        experimentalTemporalAwareness: deps.config.temporal_awareness === true,
        // Caveman text compression only runs when ctx_reduce_enabled === false
        // (gated in transform.ts and in hook.ts cavemanTextCompression wiring above).
        // Mirror that gate here so the prompt warning never appears in modes where
        // caveman won't actually compress anything.
        experimentalCavemanTextCompression:
            ctxReduceEnabled === false && deps.config.caveman_text_compression?.enabled === true,
    });
    const systemPromptHashHandler = systemPromptHash.handler;

    const eventHook = createEventHook({
        eventHandler,
        contextUsageMap,
        db,
        liveModelBySession,
        variantBySession,
        agentBySession,
        sessionDirectoryBySession,
        historyRefreshSessions,
        deferredHistoryRefreshSessions,
        systemPromptRefreshSessions,
        pendingMaterializationSessions,
        deferredMaterializationSessions,
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
            liveModelBySession,
            variantBySession,
            agentBySession,
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId,
            ctxReduceEnabled,
            // E5 — only offer the upgrade reminder when historian can run (so
            // /ctx-session-upgrade is actually actionable). Self-gates per session.
            upgradeReminder: historianRunnable
                ? (sessionId: string) =>
                      maybeSendUpgradeReminder(
                          {
                              client: deps.client,
                              db,
                              sendIgnoredMessage,
                              getNotificationParams: (sid) =>
                                  getLiveNotificationParams(
                                      sid,
                                      liveModelBySession,
                                      variantBySession,
                                      agentBySession,
                                      deps.config.toast_duration_ms,
                                  ),
                              isTuiConnected,
                              pushTuiDialogAction: (sid, resume) =>
                                  pushNotification(
                                      "action",
                                      resume
                                          ? {
                                                action: "show-upgrade-dialog",
                                                resume: true,
                                                stagedCount: resume.stagedCount,
                                                stagedThrough: resume.stagedThrough,
                                            }
                                          : { action: "show-upgrade-dialog" },
                                      sid,
                                  ),
                          },
                          sessionId,
                      )
                : undefined,
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
            channel1StateBySession,
        }),
    };
}
