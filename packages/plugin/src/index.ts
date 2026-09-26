import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin";

import {
    buildHiddenAgentConfig,
    buildHiddenAgentRegistrations,
} from "./agents/hidden-agent-registrations";
import { withContentLanguageDirective } from "./agents/language-directive";
import { denyTaskRoutingToCallerAgents } from "./agents/permissions";
import { loadPluginConfigDetailed } from "./config";
import { isCompactionEnabled, isDreamerRunnable } from "./config/agent-disable";
import { dreamerRunConfig, historianRunConfig, pluginConfigReader } from "./config/live-run-config";
import { migrateMagicContextConfigLocations } from "./config/migrate-config-location";
import { getMagicContextBuiltinCommands } from "./features/builtin-commands/commands";
import { openOpenCodeDb } from "./features/magic-context/dreamer/open-opencode-db";
import { DREAMER_SYSTEM_PROMPT } from "./features/magic-context/dreamer/task-prompts";
import type {
    DreamTaskName,
    DreamTaskProgress,
} from "./features/magic-context/dreamer/task-registry";
import {
    createFailClosedController,
    getLastHookInitFailure,
} from "./features/magic-context/fail-closed-block";
import { resolveProjectIdentityForSession } from "./features/magic-context/memory/project-identity";
import { runSessionProjectBackfill } from "./features/magic-context/session-project-backfill";
import { SMART_NOTE_COMPILER_SYSTEM_PROMPT } from "./features/magic-context/smart-notes/compiler-prompt";
import {
    getSchemaFenceRejection,
    isDatabasePersisted,
    openDatabase,
    setSqlitePragmaConfig,
} from "./features/magic-context/storage-db";
import { recordToolDefinition } from "./features/magic-context/tool-definition-tokens";
import { runDeferredV22Backfill } from "./features/magic-context/v22-deferred-backfill";
import { createAutoUpdateCheckerHook } from "./hooks/auto-update-checker";
import {
    COMPARTMENT_AGENT_SYSTEM_PROMPT,
    COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT,
    HISTORIAN_EDITOR_SYSTEM_PROMPT,
} from "./hooks/magic-context/compartment-prompt";
import { recordToolParameters } from "./hooks/magic-context/dropped-input-guard";
import { createLiveSessionState } from "./hooks/magic-context/live-session-state";
import {
    getDefaultSubcConnectionFile,
    SubcModuleTransport,
} from "./hooks/magic-context/module-transport";
import { preloadTokenizer } from "./hooks/magic-context/read-session-formatting";
import type { RustModeModuleClient } from "./hooks/magic-context/rust-mode-transform";
import {
    createBootBudget,
    emitBootEnteringBreadcrumb,
    formatBootPhaseDiagnostics,
    remainingBootBudgetMs,
    runBootPhaseWithinBudget,
} from "./plugin/boot-deadline";
import { beginBootQuietPeriod, scheduleAfterBootQuiet } from "./plugin/boot-quiet";
import { cleanupConflictWarnings, sendConflictWarning } from "./plugin/conflict-warning-hook";
import { startDreamScheduleTimer } from "./plugin/dream-timer";
import { createDreamTimerModuleClient } from "./plugin/dream-timer-module-client";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "./plugin/embedding-bootstrap";
import { createEventHandler } from "./plugin/event";
import { createSessionHooksAsync } from "./plugin/hooks/create-session-hooks";
import { isDisposedInstanceDirectory } from "./plugin/instance-disposal";
import { createMessagesTransformHandler } from "./plugin/messages-transform";
import { disableNativeAutoCompaction } from "./plugin/native-compaction-guard";
import { isDebugRpcEnabled, registerRpcHandlers } from "./plugin/rpc-handlers";
import { createToolRegistry } from "./plugin/tool-registry";
import { claimConfigParseFailuresOnce } from "./shared/config-diagnostics";
import { buildOpenCodeConfigWarningBanner } from "./shared/config-warning-surface";
import {
    type ConflictResult,
    detectConflicts,
    resolveCompactionForBoot,
} from "./shared/conflict-detector";
import { getMagicContextStorageDir } from "./shared/data-path";
import { registerExitAbort, unregisterExitAbort } from "./shared/exit-abort-registry";
import { setHarness } from "./shared/harness";
import { setKeepSubagents } from "./shared/keep-subagents";
import { flushLogger, log } from "./shared/logger";
import {
    resolveHistorianAgentOverrides,
    resolveHistorianModel,
    resolveOpenCodeAgentOverrides,
} from "./shared/model-resolution";
import { refreshModelLimitsFromApi } from "./shared/models-dev-cache";
import {
    claimOpenCodeDbDiagnosticOnce,
    formatOpenCodeDbMissingBanner,
    openCodeDbPathExists,
    resolveOpenCodeDbPath,
} from "./shared/opencode-db-path";
import { createPromptSurfaceRuntime } from "./shared/prompt-surface-runtime";
import { MagicContextRpcServer } from "./shared/rpc-server";
import { closeQuietly } from "./shared/sqlite-helpers";
import { setStoragePrivatePermissionEnforcement } from "./shared/storage-permissions";
import { reloadWindowOverlay } from "./shared/window-geometry";
import { CTX_MEMORY_LIST_TOOL_NAME } from "./tools/ctx-memory";
import { setup } from "./v2/server";

const BOOT_SERVER_DEADLINE_MS = 15_000;
const RESOLVED_CONFIG_TIMEOUT_MS = 2_000;

const server: Plugin = async (ctx) => {
    const bootStartedAt = performance.now();
    const bootBudget = createBootBudget(BOOT_SERVER_DEADLINE_MS, bootStartedAt);
    const storageBootTimings = { openMs: 0, guardMs: 0, migrateMs: 0 };
    let configMs = 0;
    let conflictMs = 0;
    let rpcMs = 0;
    let hooksDeadlineReason: string | null = null;
    let deadlinePhase: string | null = null;

    // Flush the first breadcrumb synchronously. The regular logger batches for
    // 500ms; a synchronous filesystem or SQLite stall before that timer fires
    // otherwise recreates the reporter's "no Magic Context lines" symptom.
    emitBootEnteringBreadcrumb(process.pid, ctx.directory, log, flushLogger);

    // Lock the harness before the first database write. "opencode" is already
    // the default, so this is a fence, not a change: if anything in this process
    // has locked a different value first (the v2 setup lane running on a v1
    // host), this throws at boot instead of letting the seat tag every
    // session-scoped row under the wrong harness.
    setHarness("opencode");

    const configStartedAt = performance.now();
    beginBootQuietPeriod();
    // Move config from the legacy per-harness locations to the shared CortexKit
    // location BEFORE loading (hard cutover: the loader reads only CortexKit).
    // Idempotent + lock-guarded for Desktop multi-instance; fails open. Warnings
    // (conflicts / partial failures) are surfaced via the config-warning path.
    const configMigrationWarnings = migrateMagicContextConfigLocations(ctx.directory, {
        warn: (m) => log(`[magic-context] ${m}`),
        info: (m) => log(`[magic-context] ${m}`),
    });
    const loadedPluginConfig = loadPluginConfigDetailed(ctx.directory);
    const pluginConfig = loadedPluginConfig.config;
    const liveConfigReader = pluginConfigReader(ctx.directory, pluginConfig);
    reloadWindowOverlay(pluginConfig.models?.window_overlay_path);
    const promptSurfaceRuntime = createPromptSurfaceRuntime({
        harness: "opencode",
        directory: ctx.directory,
        warn: (message) => log(`[magic-context] config warning: ${message}`),
    });
    if (configMigrationWarnings.length > 0) {
        pluginConfig.configWarnings = [
            ...configMigrationWarnings,
            ...(pluginConfig.configWarnings ?? []),
        ];
    }
    // Apply process-wide storage policy and SQLite tuning before the first
    // openDatabase() below. Storage is user-tier only, so it is shared safely by
    // every project handled by this plugin process.
    setStoragePrivatePermissionEnforcement(pluginConfig.storage.enforce_private_permissions);
    setSqlitePragmaConfig({
        cacheSizeMb: pluginConfig.sqlite.cache_size_mb,
        mmapSizeMb: pluginConfig.sqlite.mmap_size_mb,
    });
    // Debug data-collection toggle: when on, keep subagent child sessions
    // (historian/dreamer/migration) instead of deleting on success.
    setKeepSubagents(pluginConfig.keep_subagents === true);
    const autoUpdateAbort = new AbortController();
    // Abort on process exit via the shared single-listener registry. Registering
    // a process.once("exit") here directly would add one listener PER plugin
    // instance, and OpenCode Desktop runs many in one process (Node warns past 10).
    registerExitAbort(autoUpdateAbort);

    // Surface config validation warnings to user and log. Parse failures are
    // claimed process-wide because OpenCode may initialize one server per project.
    if (pluginConfig.configWarnings?.length) {
        for (const w of pluginConfig.configWarnings) {
            log(`[magic-context] config warning: ${w}`);
        }
        const allParseFailures = loadedPluginConfig.configParseFailures;
        const parseFailuresToShow = claimConfigParseFailuresOnce("opencode", allParseFailures);
        const warningText = buildOpenCodeConfigWarningBanner(
            pluginConfig.configWarnings,
            parseFailuresToShow,
            allParseFailures,
        );
        const hasBannerEntries =
            parseFailuresToShow.length > 0 ||
            pluginConfig.configWarnings.some(
                (warning) => !allParseFailures.some((failure) => warning.includes(failure.warning)),
            );

        if (hasBannerEntries)
            setTimeout(async () => {
                try {
                    const { sendStatusNotification } = await import(
                        "./hooks/magic-context/send-session-notification"
                    );
                    // Route the RPC warning to the first active session; never append a chat row.
                    // SDK types don't expose `session.list()`'s actual response shape (the
                    // client surface has been through multiple revisions; some versions
                    // return `{ data: [...] }`, others return the array directly), so we
                    // probe both shapes defensively at runtime.
                    type SessionListFn = () => Promise<
                        { data?: Array<{ id?: string }> } | Array<{ id?: string }>
                    >;
                    const clientWithSessions = ctx.client as unknown as {
                        session?: { list?: SessionListFn };
                    };
                    const sessions = await Promise.resolve(
                        clientWithSessions.session?.list?.(),
                    ).catch(() => null);
                    const sessionList = Array.isArray(sessions) ? sessions : sessions?.data;
                    const sessionId = sessionList?.[0]?.id;
                    if (sessionId) {
                        await sendStatusNotification(ctx.client, sessionId, warningText, {});
                    }
                } catch {
                    // Intentional: config warning delivery must not crash startup
                }
            }, 3000);
    }

    const openCodeDbResolution = resolveOpenCodeDbPath();
    if (
        !openCodeDbPathExists(openCodeDbResolution) &&
        claimOpenCodeDbDiagnosticOnce("boot-banner", openCodeDbResolution)
    ) {
        const missingDbBanner = formatOpenCodeDbMissingBanner(openCodeDbResolution);
        log(
            `[magic-context] opencode_db_missing path=${openCodeDbResolution.path} source=${openCodeDbResolution.source}`,
        );
        setTimeout(async () => {
            try {
                const { sendStatusNotification } = await import(
                    "./hooks/magic-context/send-session-notification"
                );
                type SessionListFn = () => Promise<
                    { data?: Array<{ id?: string }> } | Array<{ id?: string }>
                >;
                const clientWithSessions = ctx.client as unknown as {
                    session?: { list?: SessionListFn };
                };
                const sessions = await Promise.resolve(clientWithSessions.session?.list?.()).catch(
                    () => null,
                );
                const sessionList = Array.isArray(sessions) ? sessions : sessions?.data;
                const sessionId = sessionList?.[0]?.id;
                if (sessionId)
                    await sendStatusNotification(ctx.client, sessionId, missingDbBanner, {});
            } catch {
                // A diagnostic banner must never make plugin startup fail.
            }
        }, 3000);
    }

    configMs = performance.now() - configStartedAt;

    // Detect conflicts that prevent magic-context from operating correctly.
    // The resolved MC compaction mode is threaded in explicitly — the detector
    // never re-derives it from the config path. In compaction-off mode,
    // native compaction.auto=true is NOT a conflict (native compaction is the
    // user's chosen window manager), so the plugin stays enabled.
    //
    // The native compaction state comes from the host's RESOLVED config
    // (ctx.client.config.get() — the same object `opencode debug config`
    // prints), NOT from re-reading config files ourselves (issue #309: the
    // file-based re-derivation defaults to auto=true when no file resolves,
    // wrongly disabling the plugin for users whose auto=false lives in a layer
    // we cannot see). If the resolved fetch fails or times out, we fall back to
    // the file-based check unchanged and log one line naming the fallback.
    let conflictResult: ConflictResult | null = null;
    const conflictStartedAt = performance.now();
    if (pluginConfig.enabled) {
        const resolvedConfigTimeoutMs = Math.min(
            RESOLVED_CONFIG_TIMEOUT_MS,
            remainingBootBudgetMs(bootBudget),
        );
        const resolvedCompaction =
            resolvedConfigTimeoutMs > 0
                ? await resolveCompactionForBoot(ctx.client, resolvedConfigTimeoutMs)
                : null;
        if (resolvedCompaction === null) {
            log(
                "[magic-context] resolved-config fetch failed; using file-based compaction detection (the running server's resolved config may differ — `opencode debug config` is authoritative)",
            );
        }
        conflictResult = detectConflicts(ctx.directory, {
            compactionEnabled: isCompactionEnabled(pluginConfig),
            resolvedCompaction: resolvedCompaction ?? undefined,
        });
        if (conflictResult.hasConflict) {
            pluginConfig.enabled = false;
            log(`[magic-context] disabled due to conflicts: ${conflictResult.reasons.join("; ")}`);
        } else {
            log("[magic-context] no conflicts detected, plugin enabled");
        }
    }
    conflictMs = performance.now() - conflictStartedAt;

    const liveSessionState = createLiveSessionState();
    const rustModeModuleTransport =
        pluginConfig.transform_mode === "rust"
            ? new SubcModuleTransport(
                  pluginConfig.subc?.connection_file ?? getDefaultSubcConnectionFile(),
              )
            : undefined;
    const rustModeModuleClient: RustModeModuleClient | undefined = rustModeModuleTransport;
    // A durable Rust-deletion retry can outlive a config flip back to TypeScript,
    // so cleanup keeps a lazy transport even when new transforms no longer use Rust.
    const sessionCleanupModuleClient = pluginConfig.enabled
        ? (rustModeModuleTransport ??
          new SubcModuleTransport(
              pluginConfig.subc?.connection_file ?? getDefaultSubcConnectionFile(),
          ))
        : undefined;

    const hooksPhase = await runBootPhaseWithinBudget(
        bootBudget,
        "hooks",
        () =>
            createSessionHooksAsync({
                ctx,
                pluginConfig,
                liveConfigReader,
                liveSessionState,
                rustModeModuleClient,
                promptSurfaceRuntime,
                onStorageBootTimings: (timings) => Object.assign(storageBootTimings, timings),
            }),
        log,
    );
    const hooks =
        hooksPhase.status === "completed"
            ? hooksPhase.value
            : { magicContext: null, rustToolBackends: undefined };
    if (hooksPhase.status === "timed_out") {
        deadlinePhase = "hooks";
        hooksDeadlineReason = `boot hooks phase exhausted the whole-server ${BOOT_SERVER_DEADLINE_MS}ms budget`;
    }
    const postStartedAt = performance.now();

    // Mutable holder so a healed storage reopen can install real hooks without
    // rebuilding the outer messages-transform wrapper.
    const magicContextRuntime: {
        magicContext: typeof hooks.magicContext;
        rustToolBackends: typeof hooks.rustToolBackends;
    } = {
        magicContext: hooks.magicContext,
        rustToolBackends: hooks.rustToolBackends,
    };

    // Loud fail-closed gate: when the user enabled MC but storage cannot open
    // (schema fence / migration hard failure), block primary transforms instead
    // of silently unregistering hooks and falling through to native compaction.
    const failClosed = createFailClosedController();
    const failClosedBlockingEnabled =
        pluginConfig.enabled === true && pluginConfig.fail_closed_blocking !== false;
    if (pluginConfig.enabled === true && !magicContextRuntime.magicContext) {
        const initFailure = getLastHookInitFailure();
        const storageFailureReason = hooksDeadlineReason
            ? ({ kind: "storage_failure", cause: hooksDeadlineReason } as const)
            : initFailure?.type === "storage"
              ? initFailure.reason
              : null;
        if (storageFailureReason) {
            failClosed.arm(storageFailureReason);
            log(
                `[magic-context] fail-closed blocking armed (${storageFailureReason.kind}); primary sessions will error until storage recovers or the build is upgraded`,
            );
        }
    }

    // A hooks phase that merely ran long (a contended migration lock can take
    // ~60s on a loaded box) still finishes with real hooks; adopt them the moment
    // they settle instead of leaving every primary session fail-closed until a
    // re-probe happens to run — and never open storage a second time while the
    // first open is still in flight.
    if (hooksPhase.status === "timed_out") {
        void hooksPhase.pending.then((late) => {
            if (magicContextRuntime.magicContext || !late.magicContext) return;
            magicContextRuntime.magicContext = late.magicContext;
            magicContextRuntime.rustToolBackends = late.rustToolBackends;
            failClosed.clear();
            log(
                "[magic-context] boot hooks phase settled after its deadline; Magic Context runtime installed and fail-closed cleared",
            );
        });
    }

    const tryReopenStorage = async (): Promise<boolean> => {
        if (magicContextRuntime.magicContext) {
            failClosed.clear();
            return true;
        }
        try {
            const reopened = await createSessionHooksAsync({
                ctx,
                pluginConfig,
                liveConfigReader,
                liveSessionState,
                rustModeModuleClient,
                promptSurfaceRuntime,
            });
            if (!reopened.magicContext) return false;
            magicContextRuntime.magicContext = reopened.magicContext;
            magicContextRuntime.rustToolBackends = reopened.rustToolBackends;
            failClosed.clear();
            log("[magic-context] storage re-probe succeeded; Magic Context runtime restored");
            return true;
        } catch (error) {
            log(`[magic-context] storage re-probe failed: ${error}`);
            return false;
        }
    };

    const tools = createToolRegistry({
        ctx,
        pluginConfig,
        rustToolBackends: magicContextRuntime.rustToolBackends,
        promptSurfaceRuntime,
        registrationPromptSurface: loadedPluginConfig.registrationPromptSurface,
        includeDreamerOnlyTools: true,
    });

    // v22 deferred legacy-memory identity backfill. createSessionHooks() opens
    // the shared DB and runs migrations before returning a non-null hook, so
    // this fire-and-forget runner starts only after the schema is ready. Its
    // batch transactions serialize naturally with concurrent ctx_memory writes.
    if (pluginConfig.enabled && magicContextRuntime.magicContext) {
        try {
            const db = openDatabase();
            if (db && isDatabasePersisted(db)) {
                scheduleAfterBootQuiet(() => {
                    runDeferredV22Backfill(db).catch((err) => {
                        log(`[v22-backfill] background runner failed: ${err}`);
                    });
                });
            }
        } catch (err) {
            log(`[v22-backfill] failed to start background runner: ${err}`);
        }
    }

    // Gated like the v22 backfill above: a conflict-disabled plugin must not
    // touch storage at all (openDatabase() would CREATE context.db, breaking
    // the disabled-path invariant that no state is written).
    if (pluginConfig.enabled && magicContextRuntime.magicContext) {
        scheduleAfterBootQuiet(() => {
            void (async () => {
                const db = openDatabase();
                if (!db || !isDatabasePersisted(db)) return;
                const ocDb = openOpenCodeDb();
                if (!ocDb) return;
                try {
                    await runSessionProjectBackfill(db, (afterSessionId, limit) => {
                        const rows = (
                            afterSessionId === null
                                ? ocDb
                                      .prepare(
                                          `SELECT id, COALESCE(directory, '') AS directory
                                       FROM session
                                       ORDER BY id ASC
                                       LIMIT ?`,
                                      )
                                      .all(limit)
                                : ocDb
                                      .prepare(
                                          `SELECT id, COALESCE(directory, '') AS directory
                                       FROM session
                                       WHERE id > ?
                                       ORDER BY id ASC
                                       LIMIT ?`,
                                      )
                                      .all(afterSessionId, limit)
                        ) as Array<{
                            id: string;
                            directory: string;
                        }>;
                        return rows.map((session) => ({
                            sessionId: session.id,
                            directory: session.directory,
                        }));
                    });
                } finally {
                    closeQuietly(ocDb);
                }
            })().catch((err) => {
                log(`[session-projects] background runner failed: ${err}`);
            });
        }, 0);
    }

    // Resolve storage dir up front. Used by the RPC server below AND by
    // the auto-update checker (for cross-process dedup of npm hits when
    // multiple plugin instances boot concurrently). Resolving outside the
    // `enabled` block lets the auto-update checker still coordinate even
    // when the rest of the runtime is disabled by config or conflicts.
    const storageDir = getMagicContextStorageDir();

    // Per-instance process-resident handles, hoisted to function scope so the
    // server.instance.disposed cleanup (wired into the event handler below, which
    // is returned outside this block) can stop them.
    let rpcServer: MagicContextRpcServer | null = null;
    let stopDreamTimerRegistration: (() => void) | undefined;

    // Start independent dream schedule timer at plugin level (not inside hooks)
    // so overnight dreaming works even when the user isn't chatting.
    if (pluginConfig.enabled) {
        const dreamerRunnable = isDreamerRunnable(pluginConfig);
        const classifyModuleClient = createDreamTimerModuleClient(rustModeModuleClient);
        const timerProjectIdentity = resolveProjectIdentityForSession(
            ctx.directory,
            pluginConfig.allow_home_project,
        );
        if (!timerProjectIdentity) {
            log(
                "[magic-context] dream timer skipped: no project identity is bound for this directory",
            );
        } else {
            const timerRegistration = {
                directory: ctx.directory,
                projectIdentity: timerProjectIdentity,
                harness: "opencode" as const,
                client: ctx.client,
                dreamerConfig: dreamerRunnable ? pluginConfig.dreamer : undefined,
                sampleDreamRun: () => {
                    const fresh = liveConfigReader.poll().effective;
                    const dreaming = dreamerRunConfig(pluginConfig, fresh);
                    const historian = historianRunConfig(pluginConfig, fresh);
                    return {
                        dreamerConfig: dreamerRunnable ? dreaming.dreamer : undefined,
                        mural: dreaming.mural,
                        historianChildSweep: {
                            timeoutMs: historian.historian_timeout_ms,
                            fallbackModelCount: resolveHistorianModel(historian, "opencode")
                                .fallbacks.length,
                            keepSubagents: pluginConfig.keep_subagents === true,
                        },
                        gitCommitIndexing: dreaming.memory.git_commit_indexing,
                    };
                },
                language: pluginConfig.language,
                transformMode: pluginConfig.transform_mode,
                embeddingConfig: pluginConfig.embedding,
                memoryEnabled: pluginConfig.memory?.enabled === true,
                memoryInjectionBudgetTokens: pluginConfig.memory?.injection_budget_tokens,
                get historianChildSweep() {
                    const historian = historianRunConfig(
                        pluginConfig,
                        liveConfigReader.poll().effective,
                    );
                    return {
                        timeoutMs: historian.historian_timeout_ms,
                        fallbackModelCount: resolveHistorianModel(historian, "opencode").fallbacks
                            .length,
                        keepSubagents: pluginConfig.keep_subagents === true,
                    };
                },
                mural: pluginConfig.mural,
                retinaHandoff: pluginConfig.smart_notes.retina_handoff,
                gitCommitIndexing: pluginConfig.memory.git_commit_indexing?.enabled
                    ? {
                          enabled: true,
                          since_days: pluginConfig.memory.git_commit_indexing.since_days,
                          max_commits: pluginConfig.memory.git_commit_indexing.max_commits,
                      }
                    : undefined,
                ensureRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
                onDreamerProgress: (
                    progress: DreamTaskProgress | null,
                    completedTask: DreamTaskName | undefined,
                ) => {
                    if (progress) {
                        liveSessionState.dreamerProgressByProject.set(
                            timerProjectIdentity,
                            progress,
                        );
                    } else if (
                        liveSessionState.dreamerProgressByProject.get(timerProjectIdentity)
                            ?.task === completedTask
                    ) {
                        liveSessionState.dreamerProgressByProject.delete(timerProjectIdentity);
                    }
                },
                moduleClient: classifyModuleClient,
                sessionCleanupModuleClient,
            };
            // Best-effort background maintenance must not hold plugin startup. The
            // registration is observed so a late failure is visible, while the host
            // receives the core transform hooks without waiting for it.
            setTimeout(() => {
                void startDreamScheduleTimer(timerRegistration)
                    .then((stop) => {
                        stopDreamTimerRegistration = stop;
                    })
                    .catch((err) => {
                        log(
                            `[magic-context] dream timer registration failed (continuing without it): ${err}`,
                        );
                    });
            }, 0);
        }

        // Start RPC server for TUI↔server communication (replaces SQLite plugin_messages bus).
        // `storageDir` is hoisted above so the auto-update checker can also use it.
        rpcServer = new MagicContextRpcServer(storageDir, ctx.directory);
        registerRpcHandlers(rpcServer, {
            directory: ctx.directory,
            config: pluginConfig,
            client: ctx.client,
            liveSessionState,
            rustModeModuleClient,
            storageDir,
            getDebugMemoryHolders: () =>
                magicContextRuntime.magicContext?.getDebugMemoryHolders?.(),
        });
        const rpcScheduledAt = performance.now();
        // MagicContextRpcServer.start() is async but its Bun.serve + discovery-file
        // prefix is synchronous. Invoke it in the next task so those filesystem
        // calls are not part of the host's deadline-bound plugin construction.
        setTimeout(() => {
            const rpcStartedAt = performance.now();
            rpcServer
                ?.start()
                .then(() => {
                    log(
                        `[magic-context] boot deferred phase: rpc=${Math.round(performance.now() - rpcStartedAt)}ms`,
                    );
                })
                .catch((err) => {
                    log(`[magic-context] RPC server failed to start: ${err}`);
                });
        }, 0);
        rpcMs = performance.now() - rpcScheduledAt;

        // Warm the model-context-limit cache from OpenCode's SDK once at startup.
        // The API response matches OpenCode's internal resolution (live models.dev
        // cache + compiled-in snapshot + custom provider overrides + derived
        // experimental modes + auth-plugin caps), so any model OpenCode knows the
        // limit for, we know too — and it is the SOLE source (we no longer read
        // models.json ourselves). Until it warms, resolution falls back to the
        // persisted last-known-good cache (instant on restart) then the 128k
        // default for a brand-new install's first few passes.
        //
        // Retry a couple times if OpenCode's provider service isn't ready yet at
        // our startup (the only "cold" case — OpenCode itself always has the data).
        // Fire-and-forget so it never blocks plugin init.
        //
        // Do NOT refresh periodically. Limits are stable in practice, and newly
        // added models require an OpenCode restart anyway because provider
        // plugins, snapshots, and opencode.jsonc are loaded at process boot. More
        // importantly, issue #77 showed that a later refresh can regress to a
        // smaller/wrong limit and silently break an in-progress session. The
        // event handler may still retry this refresh once when it detects an
        // obviously bad cache value, but normal operation is one-shot.
        setTimeout(() => {
            void refreshModelLimitsFromApi(ctx.client, { retries: 3, retryDelayMs: 1000 });
        }, 0);
    }

    // An explicitly enabled debug RPC remains available when the MC hooks are
    // disabled, allowing the hermetic A/B harness to sample the same host process.
    if (!pluginConfig.enabled && isDebugRpcEnabled(pluginConfig)) {
        rpcServer = new MagicContextRpcServer(storageDir, ctx.directory);
        registerRpcHandlers(rpcServer, {
            directory: ctx.directory,
            config: pluginConfig,
            client: ctx.client,
            liveSessionState,
            rustModeModuleClient,
            storageDir,
        });
        setTimeout(() => {
            rpcServer?.start().catch((err) => {
                log(`[magic-context] debug-only RPC server failed to start: ${err}`);
            });
        }, 0);
    }

    // Schema-fence warning for Desktop mode. If openDatabase() fail-closed
    // because the shared DB is newer than this build supports (cross-harness
    // partial upgrade), the user otherwise sees Magic Context silently stop
    // working. Enqueue actionable RPC status without creating a user turn.
    {
        const fence = getSchemaFenceRejection();
        if (fence) {
            void import("./plugin/conflict-warning-hook").then(({ sendSchemaFenceWarning }) =>
                sendSchemaFenceWarning(
                    ctx.client as unknown as Record<string, unknown>,
                    ctx.directory,
                    fence,
                ),
            );
        }
    }

    const serverUrl = (ctx as Record<string, unknown>).serverUrl;
    const serverUrlStr =
        serverUrl instanceof URL
            ? serverUrl.toString().replace(/\/$/, "")
            : typeof serverUrl === "string"
              ? serverUrl.replace(/\/$/, "")
              : undefined;
    void import("./hooks/magic-context/send-session-notification").then(
        ({ setNotificationServerUrl }) => {
            setNotificationServerUrl(serverUrlStr);
        },
    );

    // Conflict warning / cleanup for Desktop mode.
    // TUI handles this via a startup dialog; this covers Desktop where we can't show dialogs.
    if (conflictResult?.hasConflict) {
        // Defer host-client work until plugin construction has returned. Calling
        // an async SDK helper here would still execute its synchronous prefix now.
        setTimeout(() => {
            void sendConflictWarning(
                ctx.client as unknown as Record<string, unknown>,
                ctx.directory,
                conflictResult,
            );
        }, 0);
    } else if (pluginConfig.enabled) {
        // No conflicts — clean up any leftover warning messages from previous disabled runs
        setTimeout(() => {
            void cleanupConflictWarnings(
                ctx.client as unknown as Record<string, unknown>,
                ctx.directory,
                serverUrlStr,
            );
        }, 0);
    }

    // The TUI sidebar entry in tui.json(c) is added ONLY by the setup wizard and
    // `doctor` — never at plugin startup. Startup injection would re-add the entry
    // every launch, so a user who deliberately removed the sidebar could never
    // keep it removed.

    // Desktop-only startup announcement: enqueue a one-shot RPC notification
    // describing what's new in this release.
    //
    // TUI delivery is handled by the TUI plugin via the `get-announcement` /
    // `mark-announced` RPC handlers (registered above). Both surfaces share
    // the same `last_announced_version` persistence file so dismissal in
    // either harness suppresses the announcement in the other.
    //
    // Deferred 8s so the active session has stabilized; runs fire-and-forget
    // so a failure here can never block plugin startup.
    if (pluginConfig.enabled && !conflictResult?.hasConflict) {
        setTimeout(() => {
            void import("./shared/announcement")
                .then(
                    ({
                        shouldShowAnnouncement,
                        ANNOUNCEMENT_VERSION,
                        ANNOUNCEMENT_FEATURES,
                        ANNOUNCEMENT_FOOTER,
                        markAnnouncementSeen,
                    }) => {
                        if (!shouldShowAnnouncement()) return;
                        return import("./plugin/conflict-warning-hook").then(
                            ({ sendStartupAnnouncement }) =>
                                sendStartupAnnouncement(
                                    ctx.client as unknown as Record<string, unknown>,
                                    ctx.directory,
                                    ANNOUNCEMENT_VERSION,
                                    ANNOUNCEMENT_FEATURES,
                                    ANNOUNCEMENT_FOOTER,
                                    markAnnouncementSeen,
                                ),
                        );
                    },
                )
                .catch(() => {
                    // Best-effort announcement delivery never affects startup.
                });
        }, 8000);
    }

    // Latch: remembers the {providerID, modelID, agentName} from the most
    // recent `chat.message` so we can attribute `tool.definition` hook fires
    // to a key. The hook input only carries `toolID`, and `registry.tools()`
    // runs right after `chat.message` in OpenCode's prompt flow, so this
    // captures the correct owner for each flight.
    let lastChatContext: { providerID: string; modelID: string; agentName: string } | null = null;

    // Directory of the project THIS plugin instance serves. Desktop can run two
    // instances whose directories resolve to the same project identity (for
    // example through symlinks or alternate checkout paths), so disposal must
    // match this concrete instance directory rather than the shared identity.
    const ownInstanceDirectory = ctx.directory;

    const totalBootMs = performance.now() - bootStartedAt;
    const measuredStorageMs =
        storageBootTimings.openMs + storageBootTimings.guardMs + storageBootTimings.migrateMs;
    const hooksMs = Math.max(0, hooksPhase.elapsedMs - measuredStorageMs);
    const postMs = Math.max(0, performance.now() - postStartedAt - rpcMs);
    log(
        formatBootPhaseDiagnostics({
            configMs,
            conflictMs,
            guardMs: storageBootTimings.guardMs,
            openMs: storageBootTimings.openMs,
            migrateMs: storageBootTimings.migrateMs,
            hooksMs,
            rpcMs,
            postMs,
            totalMs: totalBootMs,
            budgetMs: BOOT_SERVER_DEADLINE_MS,
            deadlinePhase,
        }),
    );

    return {
        tool: tools,
        event: createEventHandler({
            magicContext: {
                event: async (input) => {
                    await magicContextRuntime.magicContext?.event?.(input);
                },
            },
            autoUpdateChecker: createAutoUpdateCheckerHook(ctx, {
                autoUpdate: pluginConfig.auto_update !== false,
                signal: autoUpdateAbort.signal,
                // Multi-project plugin reloads coordinate via this on-disk
                // timestamp so npm gets hit at most once per check window
                // across every concurrent plugin instance on the machine.
                storageDir,
            }),
            // Orderly cleanup of THIS instance's process-resident resources when
            // OpenCode disposes it (server.instance.disposed). Desktop runs many
            // instances in one process, each disposed independently, so we only
            // act when the disposed directory matches OUR concrete instance
            // directory — tearing down a sibling instance's RPC server / dream timer would
            // break still-live sessions. We deliberately do NOT dispose the
            // native ONNX embedding session here: forcing onnxruntime-node's
            // destructor on teardown makes the Bun N-API exit crash worse, not
            // better (tracked upstream at oven-sh/bun#30291). The OS reclaims
            // that memory on exit anyway.
            onInstanceDisposed: (disposedDirectory: string) => {
                if (!isDisposedInstanceDirectory(ownInstanceDirectory, disposedDirectory)) return;
                try {
                    autoUpdateAbort.abort();
                    // Drop it from the exit-abort registry so disposed instances'
                    // controllers aren't retained there for the process lifetime.
                    unregisterExitAbort(autoUpdateAbort);
                } catch {
                    // best-effort
                }
                try {
                    stopDreamTimerRegistration?.();
                } catch {
                    // best-effort
                }
                try {
                    rpcServer?.stop();
                } catch {
                    // best-effort
                }
                log(
                    "[magic-context] instance disposed — stopped RPC server, dream timer, auto-update",
                );
            },
        }),
        "experimental.chat.messages.transform": createMessagesTransformHandler({
            magicContext: magicContextRuntime.magicContext,
            getMagicContext: () => magicContextRuntime.magicContext,
            failClosed,
            failClosedBlockingEnabled,
            // Compaction-off mode (issue #266): fail_closed_blocking is inert
            // BY DESIGN in this mode — a failed transform degrades to
            // passthrough of the input messages instead of blocking the turn.
            compactionOff: !isCompactionEnabled(pluginConfig),
            internalChildSessions: liveSessionState.internalChildSessions,
            tryReopenStorage,
        }) as unknown as NonNullable<Hooks["experimental.chat.messages.transform"]>,
        "experimental.chat.system.transform": async (input, output) => {
            await magicContextRuntime.magicContext?.["experimental.chat.system.transform"]?.(
                input,
                output,
            );
        },
        "command.execute.before": async (input, output) => {
            await magicContextRuntime.magicContext?.["command.execute.before"]?.(input, output);
        },
        "chat.message": async (input, output) => {
            // The first real prompt is the lazy-load boundary. Awaiting here keeps
            // the tokenizer out of cold start while ensuring synchronous token
            // estimates later in this prompt use the installed package.
            await preloadTokenizer();
            // Update tool-def measurement latch before delegating to magic-context
            // hooks. `registry.tools()` is invoked right after chat.message inside
            // OpenCode's prompt flow (see session/prompt.ts), so by the time
            // `tool.definition` fires we'll have the correct provider and model.
            // The host can omit `agent` for its default route; still measure the
            // observed tools under the default key rather than losing the envelope.
            const typed = input as {
                model?: { providerID?: string; modelID?: string };
                agent?: string;
            };
            const provId = typed.model?.providerID;
            const modId = typed.model?.modelID;
            const agent = typed.agent;
            lastChatContext =
                provId && modId
                    ? { providerID: provId, modelID: modId, agentName: agent || "default" }
                    : null;
            await magicContextRuntime.magicContext?.["chat.message"]?.(input, output);
        },
        "tool.definition": async (input, output) => {
            // Attribute tool schema tokens to the most recent chat-message context.
            // If no chat.message has fired yet in this process (e.g. a subagent
            // flight that reuses a historian/dreamer agent whose
            // chat.message preceded plugin init), skip — the measurement will
            // land correctly on the next flight.
            const typedInput = input as { toolID?: string };
            const typedOutput = output as { description?: unknown; parameters?: unknown };
            if (!typedInput.toolID) return;
            // The execute hook sees only the tool name, so keep the parameter
            // names for the dropped-input refusal to list. This needs no chat
            // context, so it runs before the measurement's early return.
            recordToolParameters(typedInput.toolID, typedOutput.parameters);
            if (!lastChatContext) return;
            recordToolDefinition(
                lastChatContext.providerID,
                lastChatContext.modelID,
                lastChatContext.agentName,
                typedInput.toolID,
                typeof typedOutput.description === "string" ? typedOutput.description : "",
                typedOutput.parameters,
            );
        },
        "tool.execute.before": async (input, output) => {
            await magicContextRuntime.magicContext?.["tool.execute.before"]?.(input, output);
        },
        "tool.execute.after": async (input, output) => {
            await magicContextRuntime.magicContext?.["tool.execute.after"]?.(input, output);
        },
        "experimental.text.complete": async (input, output) => {
            await magicContextRuntime.magicContext?.["experimental.text.complete"]?.(input, output);
        },
        config: async (config) => {
            try {
                // If the runtime is disabled (a conflicting plugin — DCP / OMO /
                // OpenCode auto-compaction — was detected and we fail-safed at boot),
                // do NOT register the /ctx-* commands or hidden agents. The transform/
                // tools/RPC are already no-op'd, so surfacing command entries + hidden
                // agents the runtime won't service is pure UX confusion.
                if (pluginConfig.enabled !== true) {
                    return;
                }
                // In compaction-off mode native compaction is the user's chosen
                // window manager, so it is left alone.
                if (isCompactionEnabled(pluginConfig)) {
                    disableNativeAutoCompaction(config);
                }
                config.permission = {
                    ...(config.permission ?? {}),
                    [CTX_MEMORY_LIST_TOOL_NAME]: "deny",
                } as typeof config.permission;
                // See buildHiddenAgentConfig (agents/hidden-agent-registrations.ts)
                // for permission precedence and hard `steps`/`maxSteps` cap semantics.
                const commandConfig = {
                    ...(config.command ?? {}),
                    ...getMagicContextBuiltinCommands(isCompactionEnabled(pluginConfig)),
                    ...(pluginConfig.command ?? {}),
                };

                config.command = commandConfig;
                // Extract only agent-override fields (not scheduling fields) for agent registration
                // thinking_level is stripped from every hidden agent's overrides: it
                // is Pi-only (passed as --thinking to the Pi subprocess) and is not a
                // valid OpenCode agent config field, so leaking it puts an unknown key
                // on the OpenCode agent config.
                const dreamerAgentOverrides = pluginConfig.dreamer
                    ? (() => {
                          const {
                              tasks: _tasks,
                              inject_docs: _injectDocs,
                              ...agentOverrides
                          } = resolveOpenCodeAgentOverrides(pluginConfig.dreamer);
                          return agentOverrides;
                      })()
                    : undefined;
                // Strip two_pass + disallowed_tools + thinking_level from historian
                // overrides — two_pass is consumed by the runner, disallowed_tools is
                // consumed below to build the permission map, thinking_level is Pi-only
                // (passed as --thinking to the Pi subprocess). None is a valid OpenCode
                // agent config field, so leaking them in would put unknown keys on the
                // OpenCode agent config. Both historian and historian-editor agents use
                // the remaining overrides (same model, fallbacks, etc.).
                const historianAgentOverrides = (() => {
                    const {
                        two_pass: _twoPass,
                        disallowed_tools: _disallowedTools,
                        ...agentOverrides
                    } = resolveHistorianAgentOverrides(pluginConfig.historian);
                    return agentOverrides;
                })();
                // Build hidden-agent registrations from a helper in a NON-entry
                // module (see hidden-agent-registrations.ts: exporting it from the
                // entry would make OpenCode's legacy loader invoke it as a plugin
                // factory). Each agent is guarded on its prompt: if a prompt is
                // somehow undefined at this instant, SKIP that agent and log,
                // rather than register a broken agent.
                const registrations = buildHiddenAgentRegistrations({
                    dreamerPrompt: DREAMER_SYSTEM_PROMPT,
                    smartNoteCompilerPrompt: SMART_NOTE_COMPILER_SYSTEM_PROMPT,
                    // The historian prompt always describes <user_observations>, even when
                    // user memories are disabled. The runner only prevents those observations
                    // from reaching the user profile. Keeping one system prompt preserves
                    // prompt-cache byte stability.
                    historianPrompt: withContentLanguageDirective(
                        COMPARTMENT_AGENT_SYSTEM_PROMPT,
                        pluginConfig.language,
                        { preserveUserQuotes: true },
                    ),
                    historianRecompPrompt: withContentLanguageDirective(
                        COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT,
                        pluginConfig.language,
                        { preserveUserQuotes: true },
                    ),
                    historianEditorPrompt: withContentLanguageDirective(
                        HISTORIAN_EDITOR_SYSTEM_PROMPT,
                        pluginConfig.language,
                        { preserveUserQuotes: true },
                    ),
                    dreamerOverrides: dreamerAgentOverrides,
                    historianOverrides: historianAgentOverrides,
                    historianDisallowed: pluginConfig.historian?.disallowed_tools ?? [],
                });

                const agentConfig = { ...(config.agent ?? {}) } as NonNullable<typeof config.agent>;
                const agentConfigRecord = agentConfig as Record<string, Record<string, unknown>>;
                const internalAgentIds = registrations.map((registration) => registration.id);
                for (const reg of registrations) {
                    if (typeof reg.prompt !== "string" || reg.prompt.length === 0) {
                        log(
                            `[magic-context] skipping hidden agent '${reg.id}' — prompt unavailable at config time (dir=${ctx.directory}); will re-register on a later complete pass`,
                        );
                        continue;
                    }
                    agentConfigRecord[reg.id] = buildHiddenAgentConfig(
                        reg.prompt,
                        reg.allowedTools,
                        reg.maxSteps,
                        reg.overrides,
                        reg.id,
                        reg.lockPermissions === true,
                        reg.description,
                    );
                }
                const callerAgentConfig = denyTaskRoutingToCallerAgents(
                    agentConfigRecord,
                    internalAgentIds,
                );
                config.agent = callerAgentConfig as NonNullable<typeof config.agent>;
            } catch (error) {
                // A failure registering commands/agents must NEVER fail the whole
                // plugin load — that would also disable the transform/compaction
                // (the core context-management path), letting every session's
                // context grow unbounded. Log with the stack so the real cause is
                // visible, and let Magic Context keep running with whatever it had.
                const e = error as { message?: string; stack?: string };
                log(
                    `[magic-context] config hook failed (commands/agents NOT registered; transform still active): ${e?.message ?? error}`,
                    e?.stack
                        ? { stackHead: e.stack.split("\n").slice(0, 6).join("\n") }
                        : undefined,
                );
            }
        },
    };
};

// V1 plugin-object shape (`{ id, server }`), NOT a bare function. This is
// load-bearing, not cosmetic: OpenCode's loader (opencode plugin/index.ts →
// readV1Plugin / shared.ts:278-283) detects a default export that is an OBJECT
// carrying `id`/`server`/`tui` as a V1 plugin and uses ONLY its `server`
// function. A default export that is a FUNCTION instead falls through to the
// legacy `getLegacyPlugins` path, which invokes EVERY exported function in this
// module as a plugin factory `fn(input, options)` — so any stray helper export
// would be called with the plugin input and could throw, failing the whole
// plugin load (this caused the 2026-06 hidden-agent load incident). The object
// shape bypasses that scan entirely, eliminating the footgun class. The `./tui`
// entry already uses this same `{ id, tui }` shape.
const plugin: PluginModule & { setup: typeof setup } = {
    id: "opencode-magic-context",
    server,
    setup,
};

export default plugin;
