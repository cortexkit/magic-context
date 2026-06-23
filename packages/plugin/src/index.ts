import type { Plugin } from "@opencode-ai/plugin";
import { DREAMER_AGENT } from "./agents/dreamer";
import { HISTORIAN_AGENT, HISTORIAN_EDITOR_AGENT } from "./agents/historian";
import {
    applyDisallowedTools,
    DREAMER_ALLOWED_TOOLS,
    HISTORIAN_ALLOWED_TOOLS,
    SIDEKICK_ALLOWED_TOOLS,
} from "./agents/permissions";
import { SIDEKICK_AGENT } from "./agents/sidekick";
import { loadPluginConfig } from "./config";
import { isDreamerRunnable } from "./config/agent-disable";
import { getMagicContextBuiltinCommands } from "./features/builtin-commands/commands";
import { DREAMER_SYSTEM_PROMPT } from "./features/magic-context/dreamer/task-prompts";
import { resolveProjectIdentity } from "./features/magic-context/memory/project-identity";
import { SIDEKICK_SYSTEM_PROMPT } from "./features/magic-context/sidekick/agent";
import {
    getSchemaFenceRejection,
    isDatabasePersisted,
    openDatabase,
    setSqlitePragmaConfig,
} from "./features/magic-context/storage-db";
import { recordToolDefinition } from "./features/magic-context/tool-definition-tokens";
import { runDeferredV22Backfill } from "./features/magic-context/v22-deferred-backfill";
import { buildHiddenAgentConfig } from "./hidden-agent-config";
import { createAutoUpdateCheckerHook } from "./hooks/auto-update-checker";
import {
    COMPARTMENT_AGENT_SYSTEM_PROMPT,
    HISTORIAN_EDITOR_SYSTEM_PROMPT,
} from "./hooks/magic-context/compartment-prompt";
import { createLiveSessionState } from "./hooks/magic-context/live-session-state";
import { cleanupConflictWarnings, sendConflictWarning } from "./plugin/conflict-warning-hook";
import { startDreamScheduleTimer } from "./plugin/dream-timer";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "./plugin/embedding-bootstrap";
import { createEventHandler } from "./plugin/event";
import { createSessionHooks } from "./plugin/hooks/create-session-hooks";
import { createMessagesTransformHandler } from "./plugin/messages-transform";
import { registerRpcHandlers } from "./plugin/rpc-handlers";
import { createToolRegistry } from "./plugin/tool-registry";
import { type ConflictResult, detectConflicts } from "./shared/conflict-detector";
import { getMagicContextStorageDir } from "./shared/data-path";
import { setKeepSubagents } from "./shared/keep-subagents";
import { log } from "./shared/logger";
import { refreshModelLimitsFromApi } from "./shared/models-dev-cache";
import { MagicContextRpcServer } from "./shared/rpc-server";

// Hard tool-iteration caps for the hidden agents (loop insurance — see
// buildHiddenAgentConfig). Sized to bound a runaway weak-model tool loop
// without truncating legitimate work: the historian/sidekick do a handful of
// tool calls at most; the dreamer is a real multi-step maintenance loop.
const HISTORIAN_MAX_STEPS = 40;
const SIDEKICK_MAX_STEPS = 40;
const DREAMER_MAX_STEPS = 150;

const plugin: Plugin = async (ctx) => {
    const pluginConfig = loadPluginConfig(ctx.directory);
    // Apply SQLite connection tuning before the first openDatabase() below.
    setSqlitePragmaConfig({
        cacheSizeMb: pluginConfig.sqlite.cache_size_mb,
        mmapSizeMb: pluginConfig.sqlite.mmap_size_mb,
    });
    // Debug data-collection toggle: when on, keep subagent child sessions
    // (historian/dreamer/sidekick/migration) instead of deleting on success.
    setKeepSubagents(pluginConfig.keep_subagents === true);
    const autoUpdateAbort = new AbortController();
    process.once("exit", () => {
        autoUpdateAbort.abort();
    });

    // Surface config validation warnings to user and log
    if (pluginConfig.configWarnings?.length) {
        for (const w of pluginConfig.configWarnings) {
            log(`[magic-context] config warning: ${w}`);
        }
        // Send warning to user via startup notification (after a short delay so session is ready)
        const warningText = [
            "## ⚠️ Magic Context Config Warning",
            "",
            "Some configuration values are invalid and were replaced with defaults:",
            "",
            ...pluginConfig.configWarnings.map((w) => `- ${w}`),
            "",
            "Check your `magic-context.jsonc` to fix these values.",
        ].join("\n");

        setTimeout(async () => {
            try {
                const { sendIgnoredMessage } = await import(
                    "./hooks/magic-context/send-session-notification"
                );
                // sendIgnoredMessage already handles TUI (toast) vs Desktop (ignored message)
                // via isTuiConnected(). We need a session ID — use the first active session.
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
                const sessions = await Promise.resolve(clientWithSessions.session?.list?.()).catch(
                    () => null,
                );
                const sessionList = Array.isArray(sessions) ? sessions : sessions?.data;
                const sessionId = sessionList?.[0]?.id;
                if (sessionId) {
                    // This runs before any active session necessarily reports its live agent,
                    // so keep the startup warning unbound to a specific agent on purpose.
                    await sendIgnoredMessage(ctx.client, sessionId, warningText, {});
                }
            } catch {
                // Intentional: config warning delivery must not crash startup
            }
        }, 3000);
    }

    // Detect conflicts that prevent magic-context from operating correctly
    let conflictResult: ConflictResult | null = null;
    if (pluginConfig.enabled) {
        conflictResult = detectConflicts(ctx.directory);
        if (conflictResult.hasConflict) {
            pluginConfig.enabled = false;
            log(`[magic-context] disabled due to conflicts: ${conflictResult.reasons.join("; ")}`);
        } else {
            log("[magic-context] no conflicts detected, plugin enabled");
        }
    }

    const liveSessionState = createLiveSessionState();

    const hooks = createSessionHooks({
        ctx,
        pluginConfig,
        liveSessionState,
    });

    const tools = createToolRegistry({
        ctx,
        pluginConfig,
    });

    // v22 deferred legacy-memory identity backfill. createSessionHooks() opens
    // the shared DB and runs migrations before returning a non-null hook, so
    // this fire-and-forget runner starts only after the schema is ready. Its
    // batch transactions serialize naturally with concurrent ctx_memory writes.
    if (pluginConfig.enabled && hooks.magicContext) {
        try {
            const db = openDatabase();
            if (db && isDatabasePersisted(db)) {
                runDeferredV22Backfill(db).catch((err) => {
                    log(`[v22-backfill] background runner failed: ${err}`);
                });
            }
        } catch (err) {
            log(`[v22-backfill] failed to start background runner: ${err}`);
        }
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
        const timerRegistration = {
            directory: ctx.directory,
            projectIdentity: resolveProjectIdentity(ctx.directory),
            client: ctx.client,
            dreamerConfig: dreamerRunnable ? pluginConfig.dreamer : undefined,
            embeddingConfig: pluginConfig.embedding,
            memoryEnabled: pluginConfig.memory?.enabled === true,
            experimentalUserMemories:
                dreamerRunnable && pluginConfig.dreamer?.user_memories?.enabled
                    ? {
                          enabled: true,
                          promotionThreshold:
                              pluginConfig.dreamer.user_memories.promotion_threshold,
                      }
                    : undefined,
            experimentalPinKeyFiles:
                dreamerRunnable && pluginConfig.dreamer?.pin_key_files?.enabled
                    ? {
                          enabled: true,
                          token_budget: pluginConfig.dreamer.pin_key_files.token_budget,
                          min_reads: pluginConfig.dreamer.pin_key_files.min_reads,
                      }
                    : undefined,
            gitCommitIndexing: pluginConfig.memory.git_commit_indexing?.enabled
                ? {
                      enabled: true,
                      since_days: pluginConfig.memory.git_commit_indexing.since_days,
                      max_commits: pluginConfig.memory.git_commit_indexing.max_commits,
                  }
                : undefined,
            ensureRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
        };
        stopDreamTimerRegistration = await startDreamScheduleTimer(timerRegistration);

        // Start RPC server for TUI↔server communication (replaces SQLite plugin_messages bus).
        // `storageDir` is hoisted above so the auto-update checker can also use it.
        rpcServer = new MagicContextRpcServer(storageDir, ctx.directory);
        registerRpcHandlers(rpcServer, {
            directory: ctx.directory,
            config: pluginConfig,
            client: ctx.client,
            liveSessionState,
        });
        rpcServer.start().catch((err) => {
            log(`[magic-context] RPC server failed to start: ${err}`);
        });

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
        void refreshModelLimitsFromApi(ctx.client, { retries: 3, retryDelayMs: 1000 });
    }

    // Schema-fence warning for Desktop mode. If openDatabase() fail-closed
    // because the shared DB is newer than this build supports (cross-harness
    // partial upgrade), the user otherwise sees Magic Context silently stop
    // working. Surface a clear, actionable message. (TUI/Pi see the log line;
    // Desktop has no dialog surface, so this ignored-message path covers it.)
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

    // Conflict warning / cleanup for Desktop mode.
    // TUI handles this via a startup dialog; this covers Desktop where we can't show dialogs.
    if (conflictResult?.hasConflict) {
        // Fire-and-forget: send warning to the last active session for this project
        void sendConflictWarning(
            ctx.client as unknown as Record<string, unknown>,
            ctx.directory,
            conflictResult,
        );
    } else if (pluginConfig.enabled) {
        // No conflicts — clean up any leftover warning messages from previous disabled runs
        const serverUrl = (ctx as Record<string, unknown>).serverUrl;
        const serverUrlStr =
            serverUrl instanceof URL ? serverUrl.toString().replace(/\/$/, "") : undefined;
        void cleanupConflictWarnings(
            ctx.client as unknown as Record<string, unknown>,
            ctx.directory,
            serverUrlStr,
        );
        // Probe the live HTTP listener once at startup so the first Channel 2
        // ceiling-nudge delivery doesn't pay the probe cost. Plain TUI 404s here,
        // which disables Channel 2 (Channel 1 + 85% force-materialization remain).
        // Fire-and-forget; the delivery path re-probes if this is stale/missing.
        if (serverUrlStr) {
            void import("./shared/live-server-client")
                .then(({ probeServerReachable }) => probeServerReachable(serverUrlStr))
                .catch(() => {});
        }
    }

    // Auto-add TUI plugin entry to tui.json if missing.
    // This runs from the server plugin because the TUI plugin can't load without it.
    if (pluginConfig.enabled) {
        try {
            const { ensureTuiPluginEntry } = await import("./shared/tui-config");
            const tuiAdded = ensureTuiPluginEntry();
            if (tuiAdded) {
                // Notify user via ignored message (same pattern as conflict warnings)
                const { sendTuiSetupNotification } = await import("./plugin/conflict-warning-hook");
                const serverUrl = (ctx as Record<string, unknown>).serverUrl;
                const serverUrlStr =
                    serverUrl instanceof URL ? serverUrl.toString().replace(/\/$/, "") : undefined;
                void sendTuiSetupNotification(
                    ctx.client as unknown as Record<string, unknown>,
                    ctx.directory,
                    serverUrlStr,
                );
            }
        } catch {
            // Best-effort — don't block startup
        }
    }

    // Desktop-only startup announcement: post a one-shot ignored message
    // describing what's new in this release.
    //
    // TUI delivery is handled by the TUI plugin via the `get-announcement` /
    // `mark-announced` RPC handlers (registered above). Both surfaces share
    // the same `last_announced_version` persistence file so dismissal in
    // either harness suppresses the dialog/message in the other.
    //
    // Deferred 8s so the active session has stabilized; runs fire-and-forget
    // so a failure here can never block plugin startup.
    if (pluginConfig.enabled && !conflictResult?.hasConflict) {
        try {
            const {
                shouldShowAnnouncement,
                ANNOUNCEMENT_VERSION,
                ANNOUNCEMENT_FEATURES,
                ANNOUNCEMENT_FOOTER,
                markAnnouncementSeen,
            } = await import("./shared/announcement");
            if (shouldShowAnnouncement()) {
                setTimeout(() => {
                    void import("./plugin/conflict-warning-hook")
                        .then(({ sendStartupAnnouncement }) =>
                            sendStartupAnnouncement(
                                ctx.client as unknown as Record<string, unknown>,
                                ctx.directory,
                                ANNOUNCEMENT_VERSION,
                                ANNOUNCEMENT_FEATURES,
                                ANNOUNCEMENT_FOOTER,
                                markAnnouncementSeen,
                            ),
                        )
                        .catch(() => {
                            // Best-effort — don't block startup
                        });
                }, 8000);
            }
        } catch {
            // Best-effort — never block startup on announcement delivery
        }
    }

    // Latch: remembers the {providerID, modelID, agentName} from the most
    // recent `chat.message` so we can attribute `tool.definition` hook fires
    // to a key. The hook input only carries `toolID`, and `registry.tools()`
    // runs right after `chat.message` in OpenCode's prompt flow, so this
    // captures the correct owner for each flight.
    let lastChatContext: { providerID: string; modelID: string; agentName: string } | null = null;

    // Identity of the project THIS plugin instance serves. Used to match
    // server.instance.disposed events to our own instance (Desktop runs many
    // instances per process; each is disposed independently).
    const ownProjectIdentity = resolveProjectIdentity(ctx.directory);

    return {
        tool: tools,
        event: createEventHandler({
            magicContext: hooks.magicContext,
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
            // act when the disposed directory resolves to OUR project identity —
            // tearing down a sibling instance's RPC server / dream timer would
            // break still-live sessions. We deliberately do NOT dispose the
            // native ONNX embedding session here: forcing onnxruntime-node's
            // destructor on teardown makes the Bun N-API exit crash worse, not
            // better (tracked upstream at oven-sh/bun#30291). The OS reclaims
            // that memory on exit anyway.
            onInstanceDisposed: (disposedDirectory: string) => {
                if (resolveProjectIdentity(disposedDirectory) !== ownProjectIdentity) return;
                try {
                    autoUpdateAbort.abort();
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
            magicContext: hooks.magicContext,
        }),
        "experimental.chat.system.transform": async (input, output) => {
            await hooks.magicContext?.["experimental.chat.system.transform"]?.(input, output);
        },
        "command.execute.before": async (input, output) => {
            await hooks.magicContext?.["command.execute.before"]?.(input, output);
        },
        "chat.message": async (input, _output) => {
            // Update tool-def measurement latch before delegating to magic-context
            // hooks. `registry.tools()` is invoked right after chat.message inside
            // OpenCode's prompt flow (see session/prompt.ts), so by the time
            // `tool.definition` fires we'll have the correct {provider, model, agent}.
            const typed = input as {
                model?: { providerID?: string; modelID?: string };
                agent?: string;
            };
            const provId = typed.model?.providerID;
            const modId = typed.model?.modelID;
            const agent = typed.agent;
            if (provId && modId && agent) {
                lastChatContext = { providerID: provId, modelID: modId, agentName: agent };
            }
            await hooks.magicContext?.["chat.message"]?.(input);
        },
        "tool.definition": async (input, output) => {
            // Attribute tool schema tokens to the most recent chat-message context.
            // If no chat.message has fired yet in this process (e.g. a subagent
            // flight that reuses a historian/dreamer/sidekick agent whose
            // chat.message preceded plugin init), skip — the measurement will
            // land correctly on the next flight.
            if (!lastChatContext) return;
            const typedInput = input as { toolID?: string };
            const typedOutput = output as { description?: unknown; parameters?: unknown };
            if (!typedInput.toolID) return;
            recordToolDefinition(
                lastChatContext.providerID,
                lastChatContext.modelID,
                lastChatContext.agentName,
                typedInput.toolID,
                typeof typedOutput.description === "string" ? typedOutput.description : "",
                typedOutput.parameters,
            );
        },
        "tool.execute.after": async (input, output) => {
            await hooks.magicContext?.["tool.execute.after"]?.(input, output);
        },
        "experimental.text.complete": async (input, output) => {
            await hooks.magicContext?.["experimental.text.complete"]?.(input, output);
        },
        config: async (config) => {
            // If the runtime is disabled (a conflicting plugin — DCP / OMO /
            // OpenCode auto-compaction — was detected and we fail-safed at boot),
            // do NOT register the /ctx-* commands or hidden agents. The transform/
            // tools/RPC are already no-op'd, so surfacing command entries + hidden
            // agents the runtime won't service is pure UX confusion.
            if (pluginConfig.enabled !== true) {
                return;
            }
            // See top-level buildHiddenAgentConfig for permission precedence and
            // hard `steps`/`maxSteps` cap semantics.
            const commandConfig = {
                ...(config.command ?? {}),
                ...getMagicContextBuiltinCommands(),
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
                          schedule: _schedule,
                          max_runtime_minutes: _max,
                          tasks: _tasks,
                          task_timeout_minutes: _tto,
                          thinking_level: _thinkingLevel,
                          ...agentOverrides
                      } = pluginConfig.dreamer;
                      return agentOverrides;
                  })()
                : undefined;
            const sidekickAgentOverrides = pluginConfig.sidekick
                ? (() => {
                      const {
                          timeout_ms: _timeoutMs,
                          system_prompt: _systemPrompt,
                          thinking_level: _thinkingLevel,
                          ...agentOverrides
                      } = pluginConfig.sidekick;
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
            const historianAgentOverrides = pluginConfig.historian
                ? (() => {
                      const {
                          two_pass: _twoPass,
                          disallowed_tools: _disallowedTools,
                          thinking_level: _thinkingLevel,
                          ...agentOverrides
                      } = pluginConfig.historian;
                      return agentOverrides;
                  })()
                : undefined;
            // Apply disallowed_tools to the default allow-list. "*" removes all.
            const historianDisallowed = pluginConfig.historian?.disallowed_tools ?? [];
            const historianAllowedTools = applyDisallowedTools(
                HISTORIAN_ALLOWED_TOOLS,
                historianDisallowed,
            );

            config.agent = {
                ...(config.agent ?? {}),
                [DREAMER_AGENT]: buildHiddenAgentConfig(
                    DREAMER_SYSTEM_PROMPT,
                    DREAMER_ALLOWED_TOOLS,
                    // The dreamer is a genuine multi-step maintenance loop
                    // (consolidate / verify / archive-stale / improve /
                    // maintain-docs, ~60-72 model turns observed), so it needs a
                    // high cap — just high enough to bound a runaway, not low
                    // enough to truncate legitimate work.
                    DREAMER_MAX_STEPS,
                    dreamerAgentOverrides,
                ),
                [HISTORIAN_AGENT]: buildHiddenAgentConfig(
                    // v2: the v8.7.3 historian prompt always describes the
                    // <user_observations> output; observations are simply not
                    // promoted to user-profile when user_memories is disabled
                    // (gated in the runner). Keeping the system prompt constant
                    // preserves prompt-cache byte stability.
                    COMPARTMENT_AGENT_SYSTEM_PROMPT,
                    historianAllowedTools,
                    HISTORIAN_MAX_STEPS,
                    historianAgentOverrides,
                ),
                [HISTORIAN_EDITOR_AGENT]: buildHiddenAgentConfig(
                    HISTORIAN_EDITOR_SYSTEM_PROMPT,
                    historianAllowedTools,
                    HISTORIAN_MAX_STEPS,
                    historianAgentOverrides,
                ),
                [SIDEKICK_AGENT]: buildHiddenAgentConfig(
                    SIDEKICK_SYSTEM_PROMPT,
                    SIDEKICK_ALLOWED_TOOLS,
                    SIDEKICK_MAX_STEPS,
                    sidekickAgentOverrides,
                ),
            };
        },
    };
};

export default plugin;
