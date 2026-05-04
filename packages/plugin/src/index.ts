import type { Plugin } from "@opencode-ai/plugin";
import { DREAMER_AGENT } from "./agents/dreamer";
import { HISTORIAN_AGENT, HISTORIAN_EDITOR_AGENT } from "./agents/historian";
import { SIDEKICK_AGENT } from "./agents/sidekick";
import { loadPluginConfig } from "./config";
import { getMagicContextBuiltinCommands } from "./features/builtin-commands/commands";
import { DREAMER_SYSTEM_PROMPT } from "./features/magic-context/dreamer/task-prompts";
import { SIDEKICK_SYSTEM_PROMPT } from "./features/magic-context/sidekick/agent";
import { recordToolDefinition } from "./features/magic-context/tool-definition-tokens";
import { createAutoUpdateCheckerHook } from "./hooks/auto-update-checker";
import {
    COMPARTMENT_AGENT_SYSTEM_PROMPT,
    HISTORIAN_EDITOR_SYSTEM_PROMPT,
    USER_OBSERVATIONS_APPENDIX,
} from "./hooks/magic-context/compartment-prompt";
import { createLiveSessionState } from "./hooks/magic-context/live-session-state";
import { cleanupConflictWarnings, sendConflictWarning } from "./plugin/conflict-warning-hook";
import { startDreamScheduleTimer } from "./plugin/dream-timer";
import { createEventHandler } from "./plugin/event";
import { createSessionHooks } from "./plugin/hooks/create-session-hooks";
import { createMessagesTransformHandler } from "./plugin/messages-transform";
import { registerRpcHandlers } from "./plugin/rpc-handlers";
import { createToolRegistry } from "./plugin/tool-registry";
import { type ConflictResult, detectConflicts } from "./shared/conflict-detector";
import { getMagicContextStorageDir } from "./shared/data-path";
import { log } from "./shared/logger";
import { getAgentFallbackModels } from "./shared/model-requirements";
import { refreshModelLimitsFromApi } from "./shared/models-dev-cache";
import { MagicContextRpcServer } from "./shared/rpc-server";

const plugin: Plugin = async (ctx) => {
    const pluginConfig = loadPluginConfig(ctx.directory);
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

    // Start independent dream schedule timer at plugin level (not inside hooks)
    // so overnight dreaming works even when the user isn't chatting.
    if (pluginConfig.enabled) {
        startDreamScheduleTimer({
            directory: ctx.directory,
            client: ctx.client,
            dreamerConfig: pluginConfig.dreamer,
            embeddingConfig: pluginConfig.embedding,
            memoryEnabled: pluginConfig.memory?.enabled === true,
            experimentalUserMemories: pluginConfig.dreamer?.user_memories?.enabled
                ? {
                      enabled: true,
                      promotionThreshold: pluginConfig.dreamer.user_memories.promotion_threshold,
                  }
                : undefined,
            experimentalPinKeyFiles: pluginConfig.dreamer?.pin_key_files?.enabled
                ? {
                      enabled: true,
                      token_budget: pluginConfig.dreamer.pin_key_files.token_budget,
                      min_reads: pluginConfig.dreamer.pin_key_files.min_reads,
                  }
                : undefined,
            gitCommitIndexing: pluginConfig.experimental?.git_commit_indexing?.enabled
                ? {
                      enabled: true,
                      since_days: pluginConfig.experimental.git_commit_indexing.since_days,
                      max_commits: pluginConfig.experimental.git_commit_indexing.max_commits,
                  }
                : undefined,
        });

        // Start RPC server for TUI↔server communication (replaces SQLite plugin_messages bus)
        const storageDir = getMagicContextStorageDir();
        const rpcServer = new MagicContextRpcServer(storageDir, ctx.directory);
        registerRpcHandlers(rpcServer, {
            directory: ctx.directory,
            config: pluginConfig,
            client: ctx.client,
            liveSessionState,
        });
        rpcServer.start().catch((err) => {
            log(`[magic-context] RPC server failed to start: ${err}`);
        });

        // Warm the model-context-limit cache from OpenCode's SDK and refresh
        // periodically. The API response matches OpenCode's internal resolution
        // (live models.dev cache + compiled-in snapshot + custom provider overrides
        // + derived experimental modes), so any model OpenCode knows the limit
        // for, we know too. Fire-and-forget: if it fails we fall through to the
        // disk-based loader in models-dev-cache.
        void refreshModelLimitsFromApi(ctx.client);
        setInterval(
            () => {
                void refreshModelLimitsFromApi(ctx.client);
            },
            5 * 60 * 1000,
        );
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

    // Latch: remembers the {providerID, modelID, agentName} from the most
    // recent `chat.message` so we can attribute `tool.definition` hook fires
    // to a key. The hook input only carries `toolID`, and `registry.tools()`
    // runs right after `chat.message` in OpenCode's prompt flow, so this
    // captures the correct owner for each flight.
    let lastChatContext: { providerID: string; modelID: string; agentName: string } | null = null;

    return {
        tool: tools,
        event: createEventHandler({
            magicContext: hooks.magicContext,
            autoUpdateChecker: createAutoUpdateCheckerHook(ctx, {
                autoUpdate: pluginConfig.auto_update !== false,
                signal: autoUpdateAbort.signal,
            }),
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
            void output;
            await hooks.magicContext?.["tool.execute.after"]?.(input);
        },
        "experimental.text.complete": async (input, output) => {
            await hooks.magicContext?.["experimental.text.complete"]?.(input, output);
        },
        config: async (config) => {
            const buildHiddenAgentConfig = (
                agentId: string,
                prompt: string,
                overrides?: Record<string, unknown>,
            ) => ({
                prompt,
                ...(getAgentFallbackModels(agentId)
                    ? { fallback_models: getAgentFallbackModels(agentId) }
                    : {}),
                ...(overrides ?? {}),
                mode: "subagent" as const,
                hidden: true,
            });

            const commandConfig = {
                ...(config.command ?? {}),
                ...getMagicContextBuiltinCommands(),
                ...(pluginConfig.command ?? {}),
            };

            config.command = commandConfig;
            // Extract only agent-override fields (not scheduling fields) for agent registration
            const dreamerAgentOverrides = pluginConfig.dreamer
                ? (() => {
                      const {
                          enabled: _enabled,
                          schedule: _schedule,
                          max_runtime_minutes: _max,
                          tasks: _tasks,
                          task_timeout_minutes: _tto,
                          ...agentOverrides
                      } = pluginConfig.dreamer;
                      return agentOverrides;
                  })()
                : undefined;
            const sidekickAgentOverrides = pluginConfig.sidekick
                ? (() => {
                      const {
                          enabled: _enabled,
                          timeout_ms: _timeoutMs,
                          system_prompt: _systemPrompt,
                          ...agentOverrides
                      } = pluginConfig.sidekick;
                      return agentOverrides;
                  })()
                : undefined;
            // Strip two_pass from historian overrides — it's consumed by the runner,
            // not a valid OpenCode agent config field. Both historian and historian-editor
            // agents use the remaining overrides (same model, fallbacks, etc.).
            const historianAgentOverrides = pluginConfig.historian
                ? (() => {
                      const { two_pass: _twoPass, ...agentOverrides } = pluginConfig.historian;
                      return agentOverrides;
                  })()
                : undefined;

            config.agent = {
                ...(config.agent ?? {}),
                [DREAMER_AGENT]: buildHiddenAgentConfig(
                    DREAMER_AGENT,
                    DREAMER_SYSTEM_PROMPT,
                    dreamerAgentOverrides,
                ),
                [HISTORIAN_AGENT]: buildHiddenAgentConfig(
                    HISTORIAN_AGENT,
                    pluginConfig.dreamer?.user_memories?.enabled
                        ? COMPARTMENT_AGENT_SYSTEM_PROMPT + USER_OBSERVATIONS_APPENDIX
                        : COMPARTMENT_AGENT_SYSTEM_PROMPT,
                    historianAgentOverrides,
                ),
                [HISTORIAN_EDITOR_AGENT]: buildHiddenAgentConfig(
                    HISTORIAN_EDITOR_AGENT,
                    HISTORIAN_EDITOR_SYSTEM_PROMPT,
                    historianAgentOverrides,
                ),
                [SIDEKICK_AGENT]: buildHiddenAgentConfig(
                    SIDEKICK_AGENT,
                    SIDEKICK_SYSTEM_PROMPT,
                    sidekickAgentOverrides,
                ),
            };
        },
    };
};

export default plugin;
