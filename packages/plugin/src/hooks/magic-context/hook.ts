import {
    isCompactionEnabled,
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
import type { ResolvedTransformMode } from "../../config/transform-mode";
import type { createCompactionHandler } from "../../features/magic-context/compaction";
import {
    applyMirroredNoteCompileFields,
    applyMirrorPage,
    ensureContextStoreUuid,
    getMirrorCursor,
    getModuleNoteEvaluationBridge,
    registerModuleNoteEvaluationBridge,
} from "../../features/magic-context/context-authority";
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
import {
    embedSessionCompartmentChunks,
    embedUnembeddedMemoriesForProject,
    getEmbeddingCoverageStatus,
} from "../../features/magic-context/project-embedding-registry";
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    getDatabasePersistenceError,
    getSessionsWithPendingMarker,
    isDatabasePersisted,
    openDatabase,
} from "../../features/magic-context/storage";
import {
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
import { getErrorMessage } from "../../shared/error-message";
import { log } from "../../shared/logger";
import { resolveHistorianModel } from "../../shared/model-resolution";
import type { PromptSurfaceConfig } from "../../shared/prompt-surface";
import type { PromptSurfaceRuntime } from "../../shared/prompt-surface-runtime";
import { isTuiConnected, pushNotification } from "../../shared/rpc-notifications";
import type { Database } from "../../shared/sqlite";
import { createMagicContextCommandHandler } from "./command-handler";
import { clearToolPermissionDenied } from "./ctx-reduce-availability";
import { deriveHistorianChunkTokens, resolveHistorianContextLimit } from "./derive-budgets";
import {
    autoEmbedAttemptedBySession,
    clearEmbedSessionState,
    embedPauseBySession,
    embedRunStateBySession,
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
import { SubcModuleTransport } from "./module-transport";
import { findLastAssistantModelFromOpenCodeDb } from "./read-session-db";
import type { ManagedRecompContext } from "./recomp-orchestrator";
import {
    runManagedRecomp,
    runManagedUpgrade,
    setRecompStarting,
    setRecompTerminal,
} from "./recomp-orchestrator";
import type { RustModeModuleClient } from "./rust-mode-transform";
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
import { type NotificationParams, sendIgnoredMessage } from "./send-session-notification";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import { maybeSendUpgradeReminder } from "./upgrade-reminder";

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
        /** User-level setting that lets a session started exactly in the canonical home directory use it as the project. */
        allow_home_project?: boolean;
        language?: string;
        smart_drops?: boolean;
        toast_duration_ms?: number;
        clear_reasoning_age?: number;
        execute_threshold_percentage?: number | { default: number; [modelKey: string]: number };
        execute_threshold_tokens?: { default?: number; [modelKey: string]: number | undefined };
        cache_ttl: string | Record<string, string>;
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
        sidekick?: SidekickConfig;
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

function moduleNoteRowId(response: unknown, depth = 0): number | null {
    if (depth > 4 || response === null || response === undefined) return null;
    if (typeof response === "string") {
        const match = response.match(/\b(?:smart\s+)?note\s+#(\d+)/i);
        return match ? Number(match[1]) : null;
    }
    if (Array.isArray(response)) {
        for (const item of response) {
            const id = moduleNoteRowId(item, depth + 1);
            if (id !== null) return id;
        }
        return null;
    }
    if (typeof response !== "object") return null;
    const record = response as Record<string, unknown>;
    return (
        moduleNoteRowId(record.result, depth + 1) ??
        moduleNoteRowId(record.content, depth + 1) ??
        moduleNoteRowId(record.text, depth + 1)
    );
}

function moduleNoteResponseIsError(response: unknown, depth = 0): boolean {
    if (depth > 4 || response === null || typeof response !== "object") return false;
    if (Array.isArray(response)) {
        return response.some((item) => moduleNoteResponseIsError(item, depth + 1));
    }
    const record = response as Record<string, unknown>;
    if (record.isError === true || record.ok === false || record.error !== undefined) return true;
    return moduleNoteResponseIsError(record.result, depth + 1);
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
    const resolveHistorianAttempts = () => resolveHistorianModel(deps.config, "opencode");
    const getHistorianChunkTokens = (): number =>
        deriveHistorianChunkTokens(
            resolveHistorianContextLimit(resolveHistorianAttempts().primary?.model),
        );
    const historianModel = resolveHistorianAttempts().primary;
    const historianFallbackModels = resolveHistorianAttempts().fallbacks;

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
            deps.config.toast_duration_ms,
        );
        void sendIgnoredMessage(deps.client, sessionId, warning, notificationParams).catch(
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
        historianChunkTokens: getHistorianChunkTokens(),
        historianTimeoutMs: deps.config.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
        memoryEnabled: deps.config.memory?.enabled ?? true,
        autoPromote: deps.config.memory?.auto_promote ?? true,
        historianModel,
        fallbackModels: historianFallbackModels,
        language: deps.config.language,
        fallbackModelId: (() => {
            const model = resolveLiveModel(sessionId);
            return model ? `${model.providerID}/${model.modelID}` : undefined;
        })(),
        historianTwoPass: deps.config.historian?.two_pass === true,
        runMigration: deps.config.memory?.enabled !== false && !!historianModel?.model,
        // Option C privacy gate: behavioral observation candidates are collected
        // during historian runs only when the user has SCHEDULED the
        // review-user-memories task (schedule != ""). Replaces the v1
        // user_memories.enabled flag that gated both collection and review.
        userMemoriesEnabled: userMemoryCollectionEnabled(dreamerConfig),
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
        const sessionProjectIdentity = resolveProjectIdentityForSession(
            directory,
            deps.config.allow_home_project,
        );
        if (!sessionProjectIdentity) return "No project identity is bound for the home directory.";
        maybeSendProjectIdentitySessionWarning(sessionId, directory);
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
                    if (cur?.phase !== "recomp") return;
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
        const sessionProjectIdentity = resolveProjectIdentityForSession(
            directory,
            deps.config.allow_home_project,
        );
        if (!sessionProjectIdentity) return "No project identity is bound for the home directory.";
        maybeSendProjectIdentitySessionWarning(sessionId, directory);
        const cov = getEmbeddingCoverageStatus(db, sessionProjectIdentity, sessionId);
        return `Paused at ${cov.session.embedded}/${cov.session.total} compartments embedded.`;
    };

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
        if (deps.config.memory?.enabled === false) return;
        autoEmbedAttemptedBySession.add(sessionId);
        const directory = sessionDirectoryBySession.get(sessionId) ?? deps.directory;
        void (async () => {
            let completedDrainWithWork = false;
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
                const completedCoverage = getEmbeddingCoverageStatus(
                    db,
                    sessionProjectIdentity,
                    sessionId,
                );
                completedDrainWithWork =
                    completedCoverage.session.total - completedCoverage.session.embedded <= 0;
                if (!isTuiConnected(sessionId)) {
                    await sendIgnoredMessage(deps.client, sessionId, summary, {
                        ...notifyParams,
                    });
                }
            } catch (error) {
                log("[magic-context] auto-embed drain failed:", error);
            } finally {
                if (!completedDrainWithWork) autoEmbedAttemptedBySession.delete(sessionId);
            }
        })();
    };

    const sidekickRunnable = isSidekickRunnable(deps.config);
    const sidekickConfig = sidekickRunnable ? deps.config.sidekick : undefined;
    const rustMemorySyncRequestedSessions = new Set<string>();
    // Build the same subc-backed client for the TS recovery arm. Constructing the
    // transport is inert; it connects only if a marker actually needs draining.
    const authorityRecoveryModuleClient =
        deps.rustModeModuleClient ??
        (() => {
            const transport = new SubcModuleTransport(deps.config.subc?.connection_file);
            const client: RustModeModuleClient = {
                call: (args) => transport.call(args),
                stateSyncCapabilities: (args) => transport.stateSyncCapabilities(args),
                deleteSession: (sessionId, projectRoot) =>
                    transport.deleteSession(sessionId, projectRoot),
                closeSession: (sessionId) => transport.closeSession(sessionId),
                authorityStatus: (args) => transport.authorityStatus(args),
                authorityPrepare: (args) => transport.authorityPrepare(args),
                authoritySeed: (args) => transport.authoritySeed(args),
                authorityDrain: (args) => transport.authorityDrain(args),
                mirrorPull: (args) => transport.mirrorPull(args),
                getCompartmentsAfter: async (sessionId, afterSequence) => {
                    const response = await transport.call({
                        sessionId,
                        projectRoot: deps.directory,
                        method: "session.status",
                        body: {
                            method: "session.status",
                            v: 1,
                            session_id: sessionId,
                            include_compartments_after_seq: afterSequence,
                        },
                    });
                    const value =
                        response && typeof response === "object" && "result" in response
                            ? (response as { result?: unknown }).result
                            : response;
                    const record = value && typeof value === "object" ? value : {};
                    const compartments =
                        "compartments" in record && Array.isArray(record.compartments)
                            ? record.compartments
                            : [];
                    const maxSequence =
                        "max_sequence" in record && typeof record.max_sequence === "number"
                            ? record.max_sequence
                            : afterSequence;
                    const compartmentCount =
                        "compartment_count" in record &&
                        typeof record.compartment_count === "number"
                            ? record.compartment_count
                            : undefined;
                    const revertEpoch =
                        "revert_epoch" in record && typeof record.revert_epoch === "number"
                            ? record.revert_epoch
                            : undefined;
                    return {
                        max_sequence: maxSequence,
                        compartments,
                        ...(compartmentCount !== undefined
                            ? { compartment_count: compartmentCount }
                            : {}),
                        ...(revertEpoch !== undefined ? { revert_epoch: revertEpoch } : {}),
                        ...("set_changed" in record && record.set_changed === true
                            ? { set_changed: true }
                            : {}),
                    };
                },
            };
            return client;
        })();
    const rustModeModuleClient =
        deps.config.transform_mode === "rust" ? authorityRecoveryModuleClient : undefined;
    const syncModuleDomain = async (domain: "memories" | "notes"): Promise<void> => {
        if (!rustModeModuleClient?.mirrorPull) return;
        for (;;) {
            const cursor = getMirrorCursor(db, domain);
            const response = await rustModeModuleClient.mirrorPull({
                domain,
                cursor,
                limit: 1000,
            });
            const next = applyMirrorPage({ db, page: response.page });
            if (!response.page.has_more || next === cursor) break;
        }
    };
    const syncModuleNotes = (): Promise<void> => syncModuleDomain("notes");
    const syncModuleMemories = (): Promise<void> => syncModuleDomain("memories");
    const rustToolBackends: RustToolBackends | undefined =
        deps.config.transform_mode === "rust" && rustModeModuleClient
            ? {
                  authorityState: async ({ projectPath, projectRoot, domain }) => {
                      if (!rustModeModuleClient.authorityStatus) return null;
                      const result = await rustModeModuleClient.authorityStatus({
                          context_store_uuid: ensureContextStoreUuid(db),
                          project: projectPath,
                          projectRoot,
                          domain,
                      });
                      return result.authority?.state ?? null;
                  },
                  reduce: ({ sessionId, projectRoot, drop, commandId }) =>
                      rustModeModuleClient.call({
                          sessionId,
                          projectRoot,
                          method: "agent_drops.append",
                          body: {
                              method: "agent_drops.append",
                              v: 1,
                              session_id: sessionId,
                              drop,
                              command_id: commandId,
                          },
                      }),
                  note: async ({
                      commandId,
                      sessionId,
                      projectRoot,
                      memoryProject,
                      action,
                      content,
                      surfaceCondition,
                      compiledProvider,
                      compiledConfig,
                      compiledAt,
                      compileStatus,
                      filter,
                      limit,
                      offset,
                      noteId,
                  }) => {
                      const response = await rustModeModuleClient.call({
                          sessionId,
                          projectRoot,
                          method: "ctx_note",
                          body: {
                              name: "ctx_note",
                              arguments: {
                                  ...(commandId ? { command_id: commandId } : {}),
                                  action,
                                  content,
                                  memory_project: memoryProject,
                                   surface_condition: surfaceCondition,
                                   compiled_provider: compiledProvider,
                                   compiled_config: compiledConfig,
                                   compiled_at: compiledAt,
                                   compile_status: compileStatus,
                                   filter,
                                  limit,
                                  offset,
                                  note_id: noteId,
                              },
                          },
                      });
                      // The module is authoritative, but context.db remains the local
                      // read model for note nudges and dashboard/RPC consumers.
                      await syncModuleNotes();
                      if (compileStatus && !moduleNoteResponseIsError(response)) {
                          const moduleRowId =
                              action === "write" ? moduleNoteRowId(response) : (noteId ?? null);
                          if (
                              moduleRowId === null ||
                              !applyMirroredNoteCompileFields({
                                  db,
                                  moduleProject: memoryProject,
                                  moduleRowId,
                                  fields: {
                                      compiledProvider: compiledProvider ?? null,
                                      compiledConfig: compiledConfig ?? null,
                                      compiledAt: compiledAt ?? null,
                                      compileStatus,
                                  },
                              })
                          ) {
                              throw new Error(
                                  "Rust note was written but its host compilation metadata could not be mirrored",
                              );
                          }
                      }
                      return response;
                  },
                  memory: async ({
                      commandId,
                      sessionId,
                      projectRoot,
                      memoryProject,
                      action,
                      content,
                      category,
                      ids,
                      reason,
                  }) => {
                      const response = await rustModeModuleClient.call({
                          sessionId,
                          projectRoot,
                          method: "ctx_memory",
                          body: {
                              name: "ctx_memory",
                              arguments: {
                                  ...(commandId ? { command_id: commandId } : {}),
                                  action,
                                  content,
                                  category,
                                  ids,
                                  reason,
                                  memory_project: memoryProject,
                              },
                          },
                      });
                      // Auto-search and local RPC/dashboard reads consume the mirror,
                      // so publish the module mutation to that read model before return.
                      await syncModuleMemories();
                      if (
                          !moduleNoteResponseIsError(response) &&
                          (action === "write" || action === "update" || action === "merge")
                      ) {
                          // TypeScript memory writes queue embedding work immediately.
                          // The Rust path must do the same after publishing its memory.
                          void (async () => {
                              await ensureProjectRegisteredFromOpenCodeDirectory(projectRoot, db);
                              const embedded = await embedUnembeddedMemoriesForProject(
                                  db,
                                  memoryProject,
                              );
                              if (embedded > 0) {
                                  log(
                                      `[magic-context] proactively embedded ${embedded} mirrored ${embedded === 1 ? "memory" : "memories"} for project ${memoryProject}`,
                                  );
                              }
                          })().catch((error) => {
                              log("[magic-context] mirrored memory embedding failed:", error);
                          });
                      }
                      return response;
                  },
                  noteEvaluationAvailable: (evaluationProjectPath: string) =>
                      getModuleNoteEvaluationBridge(evaluationProjectPath) !== undefined,
                  memorySync: (sessionId: string) => {
                      rustMemorySyncRequestedSessions.add(sessionId);
                  },
              }
            : undefined;
    // Bridges are per resolved project, and sessions can resolve projects other
    // than the plugin's launch directory (a /cd switch, multi-project hosts).
    // Registration is therefore an idempotent ensure invoked for every project
    // that reaches rust-mode preparation, not a one-shot at construction.
    const ensureModuleNoteEvaluationBridge = (bridgeProjectPath: string): void => {
        if (!rustModeModuleClient?.mirrorPull) return;
        if (getModuleNoteEvaluationBridge(bridgeProjectPath)) return;
        registerModuleNoteEvaluationBridge(bridgeProjectPath, {
            sync: syncModuleNotes,
            async evaluate({ contextNoteId, sessionId, verdict }): Promise<void> {
                const identity = db
                    .prepare(
                        `SELECT identity.module_row_id, revision.status_version
                           FROM mirror_identity identity
                           JOIN mirror_note_revisions revision
                             ON revision.module_project = identity.module_project
                            AND revision.module_row_id = identity.module_row_id
                          WHERE identity.domain = 'notes' AND identity.module_project = ?
                            AND identity.context_row_id = ?`,
                    )
                    .get(bridgeProjectPath, contextNoteId) as
                    | { module_row_id: number; status_version: number }
                    | undefined;
                if (!identity) {
                    throw new Error(`module identity is missing for smart note ${contextNoteId}`);
                }
                await rustModeModuleClient.call({
                    sessionId,
                    projectRoot: deps.directory,
                    method: "note.evaluate",
                    body: {
                        method: "note.evaluate",
                        v: 1,
                        session_id: sessionId,
                        note_id: identity.module_row_id,
                        source_revision: identity.status_version,
                        verdict,
                    },
                });
                await syncModuleNotes();
            },
        });
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
        channel1StateBySession,
        channel2DirectiveTextBySession,
        protectedTags: deps.config.protected_tags,
        smartDrops: deps.config.smart_drops === true,
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
        historianTimeoutMs: deps.config.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
        historianModel,
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
    });
    const eventHandler = createEventHandler({
        contextUsageMap,
        compactionHandler: deps.compactionHandler,
        config: deps.config,
        compactionOff,
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
                deps.config.toast_duration_ms,
            ),
        onSessionCacheInvalidated: (sessionId: string) => {
            dropSlot(sessionId, "session-cache-invalidated");
            clearInjectionCache(sessionId);
            deps.onSessionCacheInvalidated?.(sessionId);
        },
        onRustWireInvalidated: (sessionId: string) => {
            transform.invalidateRustWireState(sessionId);
        },
        // Clean up per-session state the system-prompt handler maintains so
        // these module/closure-scope maps don't accumulate entries over the
        // plugin's lifetime (Finding #3).
        onSessionDeleted: (sessionId: string) => {
            dropSlot(sessionId, "session-deleted");
            transform.clearRustSession(sessionId);
            systemPromptHash.clearSession(sessionId);
            // Prune every per-session map this hook closure owns. These
            // accumulate one entry per session for the plugin process lifetime
            // (which can span days/weeks across many sessions and subagents);
            // without this, a long-lived process leaks memory steadily. Some
            // maps are shared via liveSessionState — clearing on the terminal
            // session.deleted event is correct since the session is gone.
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
        const dreaming = deps.config.dreamer;
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
            deps.config.mural?.model,
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
        protectedTags: deps.config.protected_tags,
        compactionOff,
        toastDurationMs: deps.config.toast_duration_ms,
        executeThresholdPercentage: deps.config.execute_threshold_percentage ?? 65,
        executeThresholdTokens: deps.config.execute_threshold_tokens,
        historyBudgetPercentage: deps.config.history_budget_percentage,
        transformMode: deps.config.transform_mode,
        rustModeModuleClient,
        projectRoot: deps.directory,
        commitClusterTrigger: deps.config.commit_cluster_trigger,
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
        // E3 (recomp) + /ctx-session-upgrade: both run through the SHARED
        // orchestrator (runManagedRecomp / runManagedUpgrade) so the command
        // paths get identical model fallback + live progress + terminal state as
        // the RPC dialog paths. Dogfood 2026-05-30: previously the command path
        // had fallback but no progress (sidebar stuck on stale "failed") while
        // the RPC dialog had progress but no fallback (failed on empty primary
        // model). One runner closes both gaps.
        executeWrapup: historianRunnable
            ? async (sessionId, options) =>
                  runManagedWrapup(buildManagedWrapupCtx(sessionId), sessionId, options)
            : undefined,
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
                  language: deps.config.language,
              }
            : undefined,
        dreamer: dreamerConfig
            ? {
                  config: dreamerConfig,
                  projectPath,
                  // Manual /ctx-dream → Dreamer v2 per-task scheduler. Runs in this
                  // hook's own checkout (not a stale sibling worktree from the
                  // shared git:<sha> identity map).
                  runManual: (task) =>
                      runManualDream({
                          db,
                          projectIdentity: projectPath,
                          tasks: buildDreamTaskRuntimeConfigs(
                              dreamerConfig,
                              "opencode",
                              deps.config.language,
                              deps.config.mural?.model,
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
                                  userMemoryCollectionEnabled(dreamerConfig),
                              language: deps.config.language,
                              mural: deps.config.mural,
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
                      }),
              }
            : undefined,
    });

    const systemPromptHash = createSystemPromptHashHandler({
        db,
        protectedTags: deps.config.protected_tags,
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
    };
    Object.defineProperty(hooksWithBackends, "rustToolBackends", {
        value: rustToolBackends,
        enumerable: false,
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
        database = await openDatabaseAsync();
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
