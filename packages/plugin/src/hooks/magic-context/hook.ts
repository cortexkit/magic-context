import {
    isCompactionEnabled,
    isDreamerRunnable,
    isHistorianRunnable,
} from "../../config/agent-disable";
import type { ProtectedTokensTierOverrides } from "../../config/project-security";
import {
    DEFAULT_HISTORIAN_TIMEOUT_MS,
    type DreamerConfig,
    type HistorianConfig,
    type MagicContextConfig,
} from "../../config/schema/magic-context";
import type { ResolvedTransformMode } from "../../config/transform-mode";
import type { createCompactionHandler } from "../../features/magic-context/compaction";
import { openOpenCodeDb } from "../../features/magic-context/dreamer/open-opencode-db";
import { OpenCodeRetrospectiveRawProvider } from "../../features/magic-context/dreamer/retrospective-raw-provider";
import {
    buildDreamTaskRuntimeConfigs,
    userMemoryCollectionEnabled,
} from "../../features/magic-context/dreamer/task-config";
import { createDreamTaskExecutor } from "../../features/magic-context/dreamer/task-executor";
import {
    runDueTasksForProject,
    runManualDream,
} from "../../features/magic-context/dreamer/task-scheduler";
import {
    clearHookInitFailure,
    recordHookInitFailure,
} from "../../features/magic-context/fail-closed-block";
import {
    resolveProjectIdentityForSession,
    takeDubiousOwnershipProjectIdentityWarning,
} from "../../features/magic-context/memory/project-identity";
import { getEmbeddingCoverageStatus } from "../../features/magic-context/project-embedding-registry";
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    getDatabasePersistenceError,
    getSessionsWithPendingMarker,
    isDatabasePersisted,
    openDatabase,
} from "../../features/magic-context/storage";
import {
    type DatabaseBootTimings,
    getMigrationOnOpenRefusal,
    getSchemaFenceRejection,
    openDatabaseAsync,
} from "../../features/magic-context/storage-db";
import type { Tagger } from "../../features/magic-context/tagger";
import { getCurrentToolSetHash } from "../../features/magic-context/tool-definition-tokens";
import type { ContextUsage } from "../../features/magic-context/types";
import { bootQuietRemainingMs, scheduleAfterBootQuiet } from "../../plugin/boot-quiet";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "../../plugin/embedding-bootstrap";
import { buildStatusDetail } from "../../plugin/rpc-handlers";
import type { RustToolBackends } from "../../plugin/rust-tool-backends";
import type { PluginContext } from "../../plugin/types";
import type { ConfigParseFailure } from "../../shared/config-diagnostics";
import { getErrorMessage } from "../../shared/error-message";
import { log } from "../../shared/logger";
import { resolveHistorianModel } from "../../shared/model-resolution";
import type { PromptSurfaceConfig } from "../../shared/prompt-surface";
import type { PromptSurfaceRuntime } from "../../shared/prompt-surface-runtime";
import type { Database } from "../../shared/sqlite";
import { createMagicContextCommandHandler } from "./command-handler";
import { clearToolPermissionDenied } from "./ctx-reduce-availability";
import {
    deriveHistorianChunkTokens,
    resolveHistorianContextLimit,
    resolveKnownHistorianContextLimit,
} from "./derive-budgets";
import { createDroppedInputToolExecuteBeforeHook } from "./dropped-input-guard";
import {
    type EmbedHistoryDeps,
    pauseEmbedHistoryDrain,
    runEmbedHistoryDrain,
} from "./embed-history-runner";
import {
    autoEmbedAttemptedBySession,
    clearEmbedSessionState,
    embedPauseBySession,
    getEmbedDrainUiStatus,
} from "./embed-session-state";
import { createEventHandler } from "./event-handler";
import {
    resolveContextLimit,
    resolveExecuteThresholdDetail,
    resolveModelKey,
} from "./event-resolvers";
import { formatEmbedStatusText } from "./format-embed-status";
import { clearInjectionCache } from "./inject-compartments";
import { createDbLkgPersistence } from "./lkg-persist";
import { dropSlot, registerLkgPersistence } from "./lkg-slot";
import { createSubcModuleClient } from "./module-client";
import { createModuleToolBackends } from "./module-tool-backends";
import { findLastAssistantModelFromOpenCodeDb } from "./read-session-db";
import type { ManagedRecompContext } from "./recomp-orchestrator";
import { runManagedRecomp } from "./recomp-orchestrator";
import type { RustModeModuleClient } from "./rust-mode-transform";
import { createRustRefusalRecovery } from "./rust-refusal-recovery";
import { createTextCompleteHandler } from "./text-complete";
import { createTransform } from "./transform";
import { type ManagedWrapupContext, runManagedWrapup } from "./wrapup-orchestrator";

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
import {
    type NotificationParams,
    sendCommandResult,
    sendStatusNotification,
} from "./send-session-notification";
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
    sampleHistorianConfig?: () => MagicContextDeps["config"];
    sampleDreamConfig?: () => MagicContextDeps["config"];
    config: {
        protected_tokens?: number;
        protectedTokenTierOverrides?: ProtectedTokensTierOverrides;
        /** User-level setting that lets a session started exactly in the canonical home directory use it as the project. */
        allow_home_project?: boolean;
        language?: string;
        smart_drops?: boolean;
        toast_duration_ms?: number;
        clear_reasoning_age?: number;
        execute_threshold_percentage?: number | { default: number; [modelKey: string]: number };
        execute_threshold_tokens?: { default?: number; [modelKey: string]: number | undefined };
        cache_ttl: MagicContextConfig["cache_ttl"];
        cacheTtlConfigured?: boolean;
        configParseFailures?: ConfigParseFailure[];
        prompt_surface?: PromptSurfaceConfig;

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
            provider?: "local" | "openai-compatible" | "off" | "synapse";
        };
        dreamer?: DreamerConfig;
        smart_notes?: { retina_handoff?: boolean };
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
        transform_mode?: ResolvedTransformMode;
        /** Path to the subc daemon's connection file. Threaded to the module
         *  transport so a host that publishes it outside the default data-dir
         *  location (e.g. a systemd RuntimeDirectory) is actually reachable. */
        subc?: { connection_file: string };
        /** Compaction-off mode gate (issue #266). Resolved ONCE here at the
         *  session-hook construction boundary via isCompactionEnabled; the
         *  resolved boolean is threaded to the transform phases. */
        compaction?: { enabled?: boolean };
        mural?: { enabled: boolean; model?: string };
    };
    /** Registration-owned prompt-surface loader shared with the tool registry. */
    promptSurfaceRuntime?: PromptSurfaceRuntime;
    /** Test seam for the Rust authority adapter; production creates the subc client. */
    rustModeModuleClient?: RustModeModuleClient;
    /** Test and async-boot seam for supplying a database already opened by the caller. */
    openDatabaseForHook?: () => Database | null;
    /** Plugin-factory diagnostics for the boot-time storage phases. */
    onStorageBootTimings?: (timings: DatabaseBootTimings) => void;
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
        // Clear any prior init-failure latch so a successful reopen (or a
        // non-storage null like home-directory) does not leave a stale arm.
        clearHookInitFailure();
        const opened = deps.openDatabaseForHook ? deps.openDatabaseForHook() : openDatabase();
        if (!opened || !isDatabasePersisted(opened)) {
            const reason =
                (opened ? getDatabasePersistenceError(opened) : null) ??
                "Failed to initialize the persistent SQLite database.";
            log(
                "[magic-context] disabling feature because persistent storage is unavailable:",
                reason,
            );
            notifyMagicContextDisabled(deps.client, reason);
            const migration = getMigrationOnOpenRefusal();
            const blockingProcesses =
                migration?.blockingProcesses ??
                migration?.serverPids.map((pid) => ({ kind: "process" as const, pid })) ??
                [];
            const fence = getSchemaFenceRejection();
            recordHookInitFailure({
                type: "storage",
                reason:
                    migration && (blockingProcesses.length > 0 || migration.unreadableFile)
                        ? {
                              kind: "migration_guard",
                              persistedVersion: migration.persistedVersion,
                              supportedVersion: migration.supportedVersion,
                              blockingProcesses,
                              ...(migration.unreadableFile
                                  ? { unreadableFile: migration.unreadableFile }
                                  : {}),
                              ...(migration.unreadableArm
                                  ? { unreadableArm: migration.unreadableArm }
                                  : {}),
                          }
                        : fence
                          ? {
                                kind: "schema_fence",
                                persistedVersion: fence.persistedVersion,
                                supportedVersion: fence.supportedVersion,
                            }
                          : {
                                kind: "storage_failure",
                                cause: migration?.unreadableFile
                                    ? `migration guard could not read RPC discovery file ${migration.unreadableFile}`
                                    : reason,
                            },
            });
            return null;
        }
        db = opened;
    } catch (error) {
        const reason = getErrorMessage(error);
        log("[magic-context] hook failed to open storage; disabling feature:", error);
        notifyMagicContextDisabled(deps.client, reason);
        clearHookInitFailure();
        recordHookInitFailure({
            type: "storage",
            reason: { kind: "storage_failure", cause: reason },
        });
        return null;
    }

    const projectPath = resolveProjectIdentityForSession(
        deps.directory,
        deps.config.allow_home_project,
    );
    if (!projectPath) {
        log("[magic-context] not binding a project identity for this directory");
        clearHookInitFailure();
        recordHookInitFailure({ type: "no_project" });
        return null;
    }

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
    let dreamQueueQuietScheduled = false;

    // Derive historian chunk budget from the historian model's own context window.
    // Historian is a single-shot summarizer, so its input is bounded by its OWN
    // context, not the main session model's. Re-derived per historian invocation
    // (matching RPC/TUI paths) so config/model changes take effect without
    // restart, and so all trigger sources produce consistent chunk sizes.
    const sampleHistorian = () => {
        const config = deps.sampleHistorianConfig?.() ?? deps.config;
        const attempts = resolveHistorianModel(config, "opencode");
        return {
            model: attempts.primary,
            fallbackModels: attempts.fallbacks,
            contextLimit: resolveKnownHistorianContextLimit(attempts.primary?.model),
            // Unset stays unset: the producer guard derives its reserve from the
            // model's declared output when no cap is configured.
            maxOutputTokens: config.historian?.maxTokens,
            timeoutMs: config.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
            toastDurationMs: config.toast_duration_ms,
            twoPass: config.historian?.two_pass === true,
            autoPromote: config.memory?.auto_promote ?? true,
            userMemoriesEnabled: userMemoryCollectionEnabled(config.dreamer),
            commitClusterTrigger: config.commit_cluster_trigger,
            chunkTokens: deriveHistorianChunkTokens(
                resolveHistorianContextLimit(attempts.primary?.model),
            ),
        };
    };
    const bootHistorian = sampleHistorian();
    const getHistorianChunkTokens = (): number => sampleHistorian().chunkTokens;

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
    const systemPromptRefreshSessions =
        deps.liveSessionState?.systemPromptRefreshSessions ?? new Set<string>();
    const pendingMaterializationSessions =
        deps.liveSessionState?.pendingMaterializationSessions ?? new Set<string>();
    const deferredMaterializationSessions =
        deps.liveSessionState?.deferredMaterializationSessions ?? new Set<string>();

    // If the process exits after saving pending_compaction_marker_state, reload
    // both deferred signal sets from that saved state. The next transform pass can
    // then apply the pending marker exactly like the live publish path would.
    try {
        const sessionsWithPending = getSessionsWithPendingMarker(db);
        if (sessionsWithPending.length > 0) {
            for (const sid of sessionsWithPending) {
                deferredHistoryRefreshSessions.add(sid);
                deferredMaterializationSessions.add(sid);
            }
            log(
                `[magic-context] rehydrated ${sessionsWithPending.length} session(s) with pending compaction-marker drain at hook init`,
            );
        }
    } catch (error) {
        log("[magic-context] hook init: pending-marker rehydration failed:", error);
    }
    const lastHeuristicsTurnId = new Map<string, string>();
    const commitSeenLastPass = new Map<string, boolean>();
    const variantBySession =
        deps.liveSessionState?.variantBySession ?? new Map<string, string | undefined>();
    const liveModelBySession =
        deps.liveSessionState?.liveModelBySession ??
        new Map<string, { providerID: string; modelID: string }>();
    const latestAssistantMessageIdBySession =
        deps.liveSessionState?.latestAssistantMessageIdBySession ?? new Map<string, string>();
    const agentBySession = deps.liveSessionState?.agentBySession ?? new Map<string, string>();
    const sessionDirectoryBySession =
        deps.liveSessionState?.sessionDirectoryBySession ?? new Map<string, string>();
    const internalChildSessions = deps.liveSessionState?.internalChildSessions ?? new Set<string>();
    // Recomp/upgrade progress map — shared with the RPC sidebar/status snapshot
    // when liveSessionState is provided (production), local fallback in tests.
    const recompProgressBySession =
        deps.liveSessionState?.recompProgressBySession ??
        new Map<string, import("./compartment-runner-types").RecompProgress>();
    const dreamerProgressByProject =
        deps.liveSessionState?.dreamerProgressByProject ??
        new Map<
            string,
            import("../../features/magic-context/dreamer/task-registry").DreamTaskProgress
        >();
    // Channel 1 (ctx_reduce tool-output nudge) per-session metric baseline.
    // Written at the end of each transform pass (post-drop), read in
    // tool.execute.after. Only populated for primary sessions.
    const channel1StateBySession =
        deps.liveSessionState?.channel1StateBySession ??
        new Map<string, import("./ctx-reduce-nudge").Channel1State>();
    const channel2DirectiveTextBySession = new Map<string, string>();

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

    const maybeSendProjectIdentitySessionWarning = (sessionId: string, directory: string): void => {
        const warning = takeDubiousOwnershipProjectIdentityWarning(directory);
        if (!warning) return;
        const notificationParams: NotificationParams = getLiveNotificationParams(
            sessionId,
            liveModelBySession,
            variantBySession,
            agentBySession,
            (deps.sampleDreamConfig?.() ?? deps.config).toast_duration_ms,
        );
        void sendStatusNotification(deps.client, sessionId, warning, notificationParams).catch(
            (error) => {
                log(
                    `[magic-context] failed to send project identity warning for ${directory}: ${getErrorMessage(error)}`,
                );
            },
        );
    };
    const dreamerRunnable = isDreamerRunnable(deps.config);
    const dreamerConfig = dreamerRunnable ? deps.config.dreamer : undefined;
    const historianRunnable = isHistorianRunnable(deps.config);
    // Compaction-off mode (issue #266), resolved once at this construction
    // boundary and threaded to every phase as a boolean — internal phases
    // never re-read the config path.
    const compactionOff = !isCompactionEnabled(deps.config);

    // Shared context for the recomp orchestrator. The `/ctx-recomp` command path
    // builds this so it runs through the exact same runner as the RPC dialog path
    // — identical fallback, progress, and terminal state. `fallbackModelId` is
    // resolved here with the OpenCode-DB recovery (resolveLiveModel) so the
    // last-resort fallback model is known even when a command is invoked before
    // the first transform pass populates the map.
    const buildManagedRecompCtx = (sessionId: string): ManagedRecompContext => {
        const historianRun = sampleHistorian();
        return {
            client: deps.client,
            db,
            // Pass the SAME map/set instances the hook uses so the orchestrator's
            // writes (progress, session-dir cache, refresh signals) propagate to the
            // shared live state — and the next transform pass + RPC sidebar see them.
            liveSessionState: {
                liveModelBySession,
                latestAssistantMessageIdBySession,
                channel1StateBySession,
                variantBySession,
                agentBySession,
                historyRefreshSessions,
                deferredHistoryRefreshSessions,
                systemPromptRefreshSessions,
                pendingMaterializationSessions,
                deferredMaterializationSessions,
                sessionDirectoryBySession,
                recompProgressBySession,
                dreamerProgressByProject,
                internalChildSessions,
            },
            directory: deps.directory,
            historianChunkTokens: historianRun.chunkTokens,
            historianTimeoutMs: historianRun.timeoutMs,
            memoryEnabled: deps.config.memory?.enabled ?? true,
            autoPromote: historianRun.autoPromote,
            historianModel: historianRun.model,
            historianContextLimit: historianRun.contextLimit,
            historianMaxOutputTokens: historianRun.maxOutputTokens,
            fallbackModels: historianRun.fallbackModels,
            language: deps.config.language,
            fallbackModelId: (() => {
                const model = resolveLiveModel(sessionId);
                return model ? `${model.providerID}/${model.modelID}` : undefined;
            })(),
            historianTwoPass: historianRun.twoPass,
            // Option C privacy gate: behavioral observation candidates are collected
            // during historian runs only when the user has SCHEDULED the
            // review-user-memories task (schedule != ""). Replaces the v1
            // user_memories.enabled flag that gated both collection and review.
            userMemoriesEnabled: historianRun.userMemoriesEnabled,
            ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
            getNotificationParams: (sid) =>
                getLiveNotificationParams(
                    sid,
                    liveModelBySession,
                    variantBySession,
                    agentBySession,
                    historianRun.toastDurationMs,
                ),
        };
    };
    const buildManagedWrapupCtx = (sessionId: string): ManagedWrapupContext => ({
        ...buildManagedRecompCtx(sessionId),
        contextLimit: (() => {
            const model = resolveLiveModel(sessionId);
            return model
                ? resolveContextLimit(model.providerID, model.modelID, { db, sessionID: sessionId })
                : 128_000;
        })(),
        executeThresholdPercentage: (() => {
            const model = resolveLiveModel(sessionId);
            const contextLimit = model
                ? resolveContextLimit(model.providerID, model.modelID, { db, sessionID: sessionId })
                : 128_000;
            return resolveExecuteThresholdDetail(
                deps.config.execute_threshold_percentage ?? 65,
                model ? `${model.providerID}/${model.modelID}` : undefined,
                65,
                {
                    tokensConfig: deps.config.execute_threshold_tokens,
                    contextLimit,
                    sessionId,
                },
            ).percentage;
        })(),
        hasPendingNaturalBust: (sid) =>
            historyRefreshSessions.has(sid) ||
            systemPromptRefreshSessions.has(sid) ||
            pendingMaterializationSessions.has(sid),
    });
    // /ctx-embed start/pause: backfill THIS session's compartment chunk
    // embeddings, reusing the recomp progress surface (sidebar + status bar)
    // with kind="embed". The drain itself lives in embed-history-runner so the
    // RPC surface runs the same one.
    const embedHistoryDeps: EmbedHistoryDeps = {
        db,
        resolveDirectory: (sessionId) => sessionDirectoryBySession.get(sessionId) ?? deps.directory,
        allowHomeProject: deps.config.allow_home_project,
        recompProgressBySession,
        onDirectoryResolved: maybeSendProjectIdentitySessionWarning,
    };
    const executeEmbedHistory = async (
        sessionId: string,
        options?: { signal?: AbortSignal; silent?: boolean },
    ): Promise<string> => runEmbedHistoryDrain(embedHistoryDeps, sessionId, options);

    const pauseEmbedDrain = (sessionId: string): string =>
        pauseEmbedHistoryDrain(embedHistoryDeps, sessionId);

    const getEmbedStatusText = (sessionId: string): string => {
        const directory = sessionDirectoryBySession.get(sessionId) ?? deps.directory;
        const sessionProjectIdentity = resolveProjectIdentityForSession(
            directory,
            deps.config.allow_home_project,
        );
        if (!sessionProjectIdentity) return "No project identity is bound for the home directory.";
        maybeSendProjectIdentitySessionWarning(sessionId, directory);
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
        // No `memory.enabled` gate: history embedding runs whenever an embedding
        // provider is configured and not `off` (checked via coverage below).
        autoEmbedAttemptedBySession.add(sessionId);
        const directory = sessionDirectoryBySession.get(sessionId) ?? deps.directory;
        void (async () => {
            // Latch discipline: early exits (no identity, provider off, nothing to
            // embed yet) release the latch so a young session gets its drain once
            // real work exists — those paths are silent and cost one coverage
            // query. Once a drain reaches ANY terminal outcome (busy, stalled,
            // success), the latch holds for the process lifetime: busy means the
            // project-level passive backfill owns the backlog, and re-attempting
            // per pass is the announce/busy livelock this shape replaced.
            let drainReachedTerminal = false;
            try {
                // Defer off the transform thread BEFORE any DB/config work.
                // ensureProjectRegisteredFromOpenCodeDirectory is `async` but does
                // its config load + stale-embedding wipe SYNCHRONOUSLY (no internal
                // await), so awaiting it as the first statement would run that work
                // on the transform's return path. A macrotask yield lets the
                // transform return first, keeping the hot path clean.
                await new Promise((resolve) => setTimeout(resolve, 0));
                await ensureProjectRegisteredFromOpenCodeDirectory(directory, db);
                const sessionProjectIdentity = resolveProjectIdentityForSession(
                    directory,
                    deps.config.allow_home_project,
                );
                if (!sessionProjectIdentity) return;
                maybeSendProjectIdentitySessionWarning(sessionId, directory);
                const coverage = getEmbeddingCoverageStatus(db, sessionProjectIdentity, sessionId);
                if (!coverage.enabled) return;
                const remaining = coverage.session.total - coverage.session.embedded;
                if (remaining <= 0) return;
                // The auto lane is a silent bootstrap trigger: no pre-announce, no
                // busy/zero-work chatter, and the once-per-process latch never
                // resets. Announce-then-drain looped every turn on large backlogs —
                // the project-level passive backfill holds the drain lock for the
                // whole (bounded, deferred-span) catch-up, so this drain returned
                // "busy"/zero-work each pass, reset its own latch, and re-announced
                // the same count forever. Retries belong to the passive backfill;
                // progress lives in /ctx-embed status and the sidebar.
                await executeEmbedHistory(sessionId, { silent: true });
                drainReachedTerminal = true;
            } catch (error) {
                log("[magic-context] auto-embed drain failed:", error);
            } finally {
                if (!drainReachedTerminal) autoEmbedAttemptedBySession.delete(sessionId);
            }
        })();
    };

    const rustMemorySyncRequestedSessions = new Set<string>();
    // Build the same subc-backed client for the TS recovery arm. Constructing the
    // transport is inert; it connects only if a marker actually needs draining.
    const authorityRecoveryModuleClient =
        deps.rustModeModuleClient ??
        createSubcModuleClient({
            ...(deps.config.subc?.connection_file !== undefined
                ? { connectionFile: deps.config.subc.connection_file }
                : {}),
            projectRoot: deps.directory,
        });
    const rustModeModuleClient =
        deps.config.transform_mode === "rust" ? authorityRecoveryModuleClient : undefined;
    const rustRefusalRecovery = rustModeModuleClient
        ? createRustRefusalRecovery({
              moduleClient: rustModeModuleClient,
              client: deps.client,
          })
        : undefined;
    // The facades that let the host's own tools write through the module are
    // built in one place both host lanes call, so a facade cannot be present on
    // one host and silently missing on the other.
    const moduleToolBackends = createModuleToolBackends({
        db,
        moduleClient: rustModeModuleClient,
        directory: deps.directory,
        memorySyncRequestedSessions: rustMemorySyncRequestedSessions,
    });
    const rustToolBackends: RustToolBackends | undefined = moduleToolBackends?.backends;
    const ensureModuleNoteEvaluationBridge = (bridgeProjectPath: string): void => {
        moduleToolBackends?.ensureNoteEvaluationBridge(bridgeProjectPath);
    };
    ensureModuleNoteEvaluationBridge(projectPath);
    const notifyRustModeParked = (sessionId: string, message: string): void => {
        const client = deps.client as {
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
        void client.tui
            ?.showToast?.({
                body: {
                    title: "Rust Magic Context paused",
                    message,
                    variant: "warning",
                    duration: 8000,
                },
            })
            .catch((error) =>
                log(`[magic-context] rust park toast failed for ${sessionId}:`, error),
            );
    };

    // Durable LKG replay: register the db-backed backend so slot drops clear the
    // persisted row and in-memory misses (notably the first pass after a
    // process restart) hydrate the snapshot captured by the last applied pass.
    // Re-registration on a healed storage reopen replaces the stale handle.
    registerLkgPersistence(createDbLkgPersistence(db));

    const transform = createTransform({
        tagger: deps.tagger,
        scheduler: deps.scheduler,
        contextUsageMap,
        db,
        // OpenCode 1 reads the `message`/`part` tables, so every ordinal this
        // host derives is a position in the v1 projection.
        storeGeneration: "v1",
        channel1StateBySession,
        channel2DirectiveTextBySession,
        protectedTokens: deps.config.protected_tokens,
        protectedTokenTierOverrides: deps.config.protectedTokenTierOverrides,
        smartDrops: deps.config.smart_drops === true,
        clearReasoningAge: deps.config.clear_reasoning_age ?? 50,
        commitClusterTrigger: bootHistorian.commitClusterTrigger,
        historyRefreshSessions,
        deferredHistoryRefreshSessions,
        pendingMaterializationSessions,
        deferredMaterializationSessions,
        variantBySession,
        lastHeuristicsTurnId,
        commitSeenLastPass,
        internalChildSessions,
        client: deps.client,
        directory: deps.directory,
        allowHomeProject: deps.config.allow_home_project,
        injectDocs: deps.config.dreamer?.inject_docs !== false,
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
        historianTimeoutMs: bootHistorian.timeoutMs,
        historianModel: bootHistorian.model,
        historianContextLimit: bootHistorian.contextLimit,
        historianMaxOutputTokens: bootHistorian.maxOutputTokens,
        fallbackModels: bootHistorian.fallbackModels,
        resolveHistorianRun: sampleHistorian,
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
        getToolSetHash: (sessionId) => {
            const model = liveModelBySession.get(sessionId);
            if (!model) return "";
            return getCurrentToolSetHash(
                model.providerID,
                model.modelID,
                agentBySession.get(sessionId),
            );
        },
        getFallbackModelId: (sessionId) => {
            const model = liveModelBySession.get(sessionId);
            return model ? `${model.providerID}/${model.modelID}` : undefined;
        },
        projectPath,
        historianRunnable,
        compactionOff,
        experimentalUserMemories: userMemoryCollectionEnabled(dreamerConfig),
        experimentalTemporalAwareness: deps.config.temporal_awareness === true,
        muralEnabled: deps.config.mural?.enabled === true,
        historianTwoPass: deps.config.historian?.two_pass === true,
        historianRunner: deps.config.historian?.runner,
        historianHostRunnerEnabled: deps.config.historian?.host_runner?.enabled,
        liveModelBySession,
        sessionDirectoryBySession,
        // Keep the resolved controls available to both renderers. Rust mode must receive
        // an explicit false here rather than falling back to the module default.
        autoSearch: {
            enabled: deps.config.memory?.auto_search?.enabled ?? true,
            scoreThreshold: deps.config.memory?.auto_search?.score_threshold ?? 0.6,
            minPromptChars: deps.config.memory?.auto_search?.min_prompt_chars ?? 20,
            directory: deps.directory,
            ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
        },
        // Age-tier caveman text compression is an opt-in primary-session pass.
        // Subagents are excluded in transform.ts because their context is curated
        // by the parent and they have no ctx_expand recovery path.
        // Compaction-off: caveman is compaction machinery — never forwarded.
        cavemanTextCompression: compactionOff
            ? undefined
            : deps.config.caveman_text_compression?.enabled === true
              ? {
                    enabled: true,
                    minChars: deps.config.caveman_text_compression.min_chars ?? 500,
                }
              : undefined,
        maybeAutoEmbedSession,
        transformMode: deps.config.transform_mode,
        promptSurface: deps.config.prompt_surface,
        promptSurfaceRuntime: deps.promptSurfaceRuntime,
        rustModeModuleClient,
        tsAuthorityRecoveryModuleClient: authorityRecoveryModuleClient,
        rustMemorySyncRequestedSessions,
        onRustModeParked: notifyRustModeParked,
        onRustModeProjectPrepared: ensureModuleNoteEvaluationBridge,
        onRustEngineReconnectRefusal: (args) => rustRefusalRecovery?.arm(args),
    });
    const eventHandler = createEventHandler({
        contextUsageMap,
        compactionHandler: deps.compactionHandler,
        config: deps.config,
        compactionOff,
        thinkingBindingRecoveryEnabled: deps.config.transform_mode !== "rust",
        tagger: deps.tagger,
        db,
        client: deps.client,
        channel1StateBySession,
        channel2DirectiveTextBySession,
        internalChildSessions,
        getNotificationParams: (sessionId) =>
            getLiveNotificationParams(
                sessionId,
                liveModelBySession,
                variantBySession,
                agentBySession,
                (deps.sampleDreamConfig?.() ?? deps.config).toast_duration_ms,
            ),
        onSessionCacheInvalidated: (sessionId: string) => {
            dropSlot(sessionId, "session-cache-invalidated");
            clearInjectionCache(sessionId);
            deps.onSessionCacheInvalidated?.(sessionId);
        },
        onRustWireInvalidated: (sessionId: string) => {
            transform.invalidateRustWireState(sessionId);
        },
        rustSessionCleanup: rustModeModuleClient !== undefined,
        // Remove module-owned state before the context database drops the durable
        // session→project binding needed to retry a failed module deletion.
        onSessionDeleted: async (sessionId: string) => {
            rustRefusalRecovery?.forget(sessionId);
            dropSlot(sessionId, "session-deleted");
            try {
                await transform.clearRustSession(sessionId);
            } finally {
                systemPromptHash.clearSession(sessionId);
                // Prune every per-session map this hook closure owns. These maps
                // otherwise accumulate for the lifetime of a long-running plugin process.
                lastHeuristicsTurnId.delete(sessionId);
                clearToolPermissionDenied(sessionId);
                commitSeenLastPass.delete(sessionId);
                variantBySession.delete(sessionId);
                liveModelBySession.delete(sessionId);
                agentBySession.delete(sessionId);
                sessionDirectoryBySession.delete(sessionId);
                recompProgressBySession.delete(sessionId);
                internalChildSessions.delete(sessionId);
                rustMemorySyncRequestedSessions.delete(sessionId);
                channel1StateBySession.delete(sessionId);
                channel2DirectiveTextBySession.delete(sessionId);
                clearEmbedSessionState(sessionId);
            }
        },
    });

    const runDreamQueueInBackground = (): void => {
        if (bootQuietRemainingMs() > 0) {
            if (!dreamQueueQuietScheduled) {
                dreamQueueQuietScheduled = true;
                scheduleAfterBootQuiet(() => {
                    dreamQueueQuietScheduled = false;
                    runDreamQueueInBackground();
                });
            }
            return;
        }
        const sampledDream = deps.sampleDreamConfig?.() ?? deps.config;
        const dreaming = sampledDream.dreamer;
        if (!dreaming || dreaming.disable === true) {
            return;
        }

        const now = Date.now();
        if (now - lastScheduleCheckMs < DREAM_SCHEDULE_CHECK_INTERVAL_MS) {
            return;
        }
        lastScheduleCheckMs = now;

        // Dreamer v2: the per-task scheduler owns due-evaluation + keyed leases.
        // This message-event-driven path is a secondary trigger to the process
        // timer; both call the same idempotent scheduler (leases prevent overlap).
        const runtimeConfigs = buildDreamTaskRuntimeConfigs(
            dreaming,
            "opencode",
            deps.config.language,
            sampledDream.mural?.model,
        );
        const executor = createDreamTaskExecutor({
            client: deps.client,
            // Run in the directory this hook instance owns, not a stale sibling
            // checkout resolved from the shared git:<sha> identity map.
            sessionDirectory: deps.directory,
            openOpenCodeDb,
            retrospectiveRawProvider: (providerDb) =>
                new OpenCodeRetrospectiveRawProvider({
                    contextDb: providerDb,
                    openOpenCodeDb,
                }),
            userMemoryCollectionEnabled: userMemoryCollectionEnabled(dreaming),
            language: deps.config.language,
            retinaHandoff: deps.config.smart_notes?.retina_handoff === true,
            transformMode: deps.config.transform_mode,
            // Scheduled/message-triggered runs must share the same direct
            // authority.status transport as the transform path. The
            // executor uses the live MODULE verdict, not transform state
            // cached in a session, so a cold process cannot fall back to
            // the guarded TypeScript child path.
            moduleClient: rustModeModuleClient,
            onProgress: (progress, completedTask) => {
                if (progress) {
                    dreamerProgressByProject.set(projectPath, progress);
                } else if (dreamerProgressByProject.get(projectPath)?.task === completedTask) {
                    dreamerProgressByProject.delete(projectPath);
                }
            },
        });
        void runDueTasksForProject({
            db,
            projectIdentity: projectPath,
            tasks: runtimeConfigs,
            executor,
        }).catch((error: unknown) => {
            log("[dreamer] scheduled task run failed:", error);
        });
    };

    const commandHandler = createMagicContextCommandHandler({
        db,
        compactionOff,
        toastDurationMs: deps.config.toast_duration_ms,
        sampleToastDurationMs: () => (deps.sampleDreamConfig?.() ?? deps.config).toast_duration_ms,
        executeThresholdPercentage: deps.config.execute_threshold_percentage ?? 65,
        executeThresholdTokens: deps.config.execute_threshold_tokens,
        historyBudgetPercentage: deps.config.history_budget_percentage,
        transformMode: deps.config.transform_mode,
        rustModeModuleClient,
        projectRoot: deps.directory,
        commitClusterTrigger: deps.config.commit_cluster_trigger,
        sampleCommitClusterTrigger: () =>
            (deps.sampleHistorianConfig?.() ?? deps.config).commit_cluster_trigger,
        cacheTtlConfig: deps.config.cache_ttl,
        cacheTtlConfigured: deps.config.cacheTtlConfigured === true,
        configParseFailures: deps.config.configParseFailures ?? [],
        getLiveModelKey: (sessionId) => {
            // Use DB fallback so /ctx-status shows the correct model-specific
            // threshold even before the first transform pass has populated
            // liveModelBySession after restart. Without this, the resolver
            // falls back to the default threshold and displays a stale budget.
            const model = resolveLiveModel(sessionId);
            return model ? `${model.providerID}/${model.modelID}` : undefined;
        },
        getStatusDetail: (sessionId, moduleStatus) => {
            const model = resolveLiveModel(sessionId);
            return buildStatusDetail(
                db,
                sessionId,
                sessionDirectoryBySession.get(sessionId) ?? deps.directory,
                model ? `${model.providerID}/${model.modelID}` : undefined,
                deps.config as unknown as Record<string, unknown>,
                deps.liveSessionState,
                deps.config.memory?.injection_budget_tokens,
                moduleStatus,
                !compactionOff,
            );
        },
        getDreamerProgress: () => dreamerProgressByProject.get(projectPath) ?? null,
        getTailHygiene: (sessionId) => channel1StateBySession.get(sessionId),
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
        // E3 (recomp) runs through the SHARED orchestrator (runManagedRecomp) so
        // the command path gets identical model fallback + live progress +
        // terminal state as the RPC dialog path. Dogfood 2026-05-30: previously
        // the command path had fallback but no progress (sidebar stuck on stale
        // "failed") while the RPC dialog had progress but no fallback (failed on
        // empty primary model). One runner closes both gaps.
        executeWrapup: historianRunnable
            ? async (sessionId, options) =>
                  runManagedWrapup(buildManagedWrapupCtx(sessionId), sessionId, options)
            : undefined,
        executeRecomp: historianRunnable
            ? async (sessionId, options) =>
                  runManagedRecomp(buildManagedRecompCtx(sessionId), sessionId, options)
            : undefined,
        executeEmbedHistory,
        pauseEmbedDrain,
        getEmbedStatusText,
        sendNotification: async (sessionId, text, params) => {
            await sendCommandResult(deps.client, sessionId, text, {
                ...getLiveNotificationParams(
                    sessionId,
                    liveModelBySession,
                    variantBySession,
                    agentBySession,
                    (deps.sampleDreamConfig?.() ?? deps.config).toast_duration_ms,
                ),
                ...params,
            });
        },
        dreamer: dreamerConfig
            ? {
                  config: dreamerConfig,
                  projectPath,
                  // Manual /ctx-dream → Dreamer v2 per-task scheduler. Runs in this
                  // hook's own checkout (not a stale sibling worktree from the
                  // shared git:<sha> identity map).
                  runManual: (task) => {
                      const sampledDream = deps.sampleDreamConfig?.() ?? deps.config;
                      const currentDreamer = sampledDream.dreamer ?? dreamerConfig;
                      return runManualDream({
                          db,
                          projectIdentity: projectPath,
                          tasks: buildDreamTaskRuntimeConfigs(
                              currentDreamer,
                              "opencode",
                              deps.config.language,
                              sampledDream.mural?.model,
                          ),
                          executor: createDreamTaskExecutor({
                              client: deps.client,
                              sessionDirectory: deps.directory,
                              openOpenCodeDb,
                              retrospectiveRawProvider: (providerDb) =>
                                  new OpenCodeRetrospectiveRawProvider({
                                      contextDb: providerDb,
                                      openOpenCodeDb,
                                  }),
                              userMemoryCollectionEnabled:
                                  userMemoryCollectionEnabled(currentDreamer),
                              language: deps.config.language,
                              mural: sampledDream.mural,
                              memoryInjectionBudgetTokens:
                                  deps.config.memory?.injection_budget_tokens,
                              retinaHandoff: deps.config.smart_notes?.retina_handoff === true,
                              transformMode: deps.config.transform_mode,
                              // Manual /ctx-dream uses the same live authority
                              // lookup and module transport as scheduled runs.
                              // Do not rely on a transform-populated cache.
                              moduleClient: rustModeModuleClient,
                              onProgress: (progress, completedTask) => {
                                  if (progress) {
                                      dreamerProgressByProject.set(projectPath, progress);
                                  } else if (
                                      dreamerProgressByProject.get(projectPath)?.task ===
                                      completedTask
                                  ) {
                                      dreamerProgressByProject.delete(projectPath);
                                  }
                              },
                          }),
                          task,
                      });
                  },
              }
            : undefined,
    });

    const systemPromptHash = createSystemPromptHashHandler({
        db,
        dreamerEnabled: dreamerRunnable,
        // Gates ctx_memory guidance out of the prompt when memory is off (the
        // ctx_memory TOOL is gated in tool-registry.ts on the same flag).
        memoryEnabled: deps.config.memory?.enabled !== false,
        language: deps.config.language,
        promptSurface: deps.config.prompt_surface,
        promptSurfaceRuntime: deps.promptSurfaceRuntime,
        resolveModel: resolveLiveModel,
        // System-prompt-hash handler reads systemPromptRefreshSessions to
        // decide whether to re-read disk-backed adjuncts (profile, key files,
        // sticky date), and adds to all three sets when it
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
        client: deps.client,
        experimentalUserMemories: userMemoryCollectionEnabled(deps.config.dreamer),
        experimentalTemporalAwareness: deps.config.temporal_awareness === true,
        // Mirror the primary-session caveman opt-in so the agent knows older
        // prose may be rewritten even when ctx_reduce is available.
        experimentalCavemanTextCompression: deps.config.caveman_text_compression?.enabled === true,
    });
    const systemPromptHashHandler = systemPromptHash.handler;

    const eventHook = createEventHook({
        eventHandler,
        contextUsageMap,
        db,
        liveModelBySession,
        latestAssistantMessageIdBySession,
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
    });

    const hooks = {
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
            commandHandler,
            cacheTtlConfig: deps.config.cache_ttl,
        }),
        event: async (input: { event: { type: string; properties?: unknown } }) => {
            await eventHook(input);
            if (input.event.type === "message.updated") {
                runDreamQueueInBackground();
            }
        },
        "command.execute.before": createCommandExecuteBeforeHook(commandHandler),
        "tool.execute.before": createDroppedInputToolExecuteBeforeHook(),
        "tool.execute.after": createToolExecuteAfterHook({
            db,
            channel1StateBySession,
            client: deps.client,
            transformMode: deps.config.transform_mode,
            todoStateSet:
                deps.config.transform_mode === "rust" && rustModeModuleClient
                    ? ({ sessionId, stateJson, ownerMessageId }) =>
                          rustModeModuleClient.call({
                              sessionId,
                              projectRoot: deps.directory,
                              method: "todo_state.set",
                              body: {
                                  method: "todo_state.set",
                                  v: 1,
                                  session_id: sessionId,
                                  state_json: stateJson,
                                  owner_message_id: ownerMessageId,
                              },
                          })
                    : undefined,
        }),
    };
    const hooksWithBackends = hooks as typeof hooks & {
        rustToolBackends?: RustToolBackends;
        getDebugMemoryHolders?: () => {
            taggerCache: ReturnType<NonNullable<Tagger["getHeapStats"]>>;
            wireCache: ReturnType<typeof transform.getRustWireCacheHeapStats>;
        };
    };
    Object.defineProperties(hooksWithBackends, {
        rustToolBackends: {
            value: rustToolBackends,
            enumerable: false,
        },
        getDebugMemoryHolders: {
            value: () => ({
                taggerCache: deps.tagger.getHeapStats?.() ?? {
                    sessionCount: 0,
                    assignmentEntries: 0,
                    toolAccountingEntries: 0,
                    loadSignatureEntries: 0,
                    sessions: [],
                },
                wireCache: transform.getRustWireCacheHeapStats(),
            }),
            enumerable: false,
        },
    });
    return hooksWithBackends;
}

/**
 * Async boot entry point. Migration lock retries must yield between attempts,
 * while the hook itself remains synchronous once a database is available.
 */
export async function createMagicContextHookAsync(
    deps: MagicContextDeps,
): Promise<ReturnType<typeof createMagicContextHook>> {
    let database: Database | null;
    try {
        clearHookInitFailure();
        database = await openDatabaseAsync({ onBootTimings: deps.onStorageBootTimings });
    } catch (error) {
        const reason = getErrorMessage(error);
        log("[magic-context] hook failed to open storage; disabling feature:", error);
        notifyMagicContextDisabled(deps.client, reason);
        clearHookInitFailure();
        recordHookInitFailure({
            type: "storage",
            reason: { kind: "storage_failure", cause: reason },
        });
        return null;
    }
    return createMagicContextHook({
        ...deps,
        openDatabaseForHook: () => database,
    });
}
