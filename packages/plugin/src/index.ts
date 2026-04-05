import type { Plugin } from "@opencode-ai/plugin";
import { DREAMER_AGENT } from "./agents/dreamer";
import { HISTORIAN_AGENT } from "./agents/historian";
import { SIDEKICK_AGENT } from "./agents/sidekick";
import { loadPluginConfig } from "./config";
import { getMagicContextBuiltinCommands } from "./features/builtin-commands/commands";
import { DREAMER_SYSTEM_PROMPT } from "./features/magic-context/dreamer/task-prompts";
import { SIDEKICK_SYSTEM_PROMPT } from "./features/magic-context/sidekick/agent";
import {
    COMPARTMENT_AGENT_SYSTEM_PROMPT,
    USER_OBSERVATIONS_APPENDIX,
} from "./hooks/magic-context/compartment-prompt";
import { cleanupConflictWarnings, sendConflictWarning } from "./plugin/conflict-warning-hook";
import { startDreamScheduleTimer } from "./plugin/dream-timer";
import { createEventHandler } from "./plugin/event";
import { createSessionHooks } from "./plugin/hooks/create-session-hooks";
import { createMessagesTransformHandler } from "./plugin/messages-transform";
import { createToolRegistry } from "./plugin/tool-registry";
import { startTuiActionConsumer } from "./plugin/tui-action-consumer";
import { type ConflictResult, detectConflicts } from "./shared/conflict-detector";
import { log } from "./shared/logger";
import { getAgentFallbackModels } from "./shared/model-requirements";

const plugin: Plugin = async (ctx) => {
    const pluginConfig = loadPluginConfig(ctx.directory);

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

    const hooks = createSessionHooks({
        ctx,
        pluginConfig,
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
            experimentalUserMemories: pluginConfig.experimental?.user_memories?.enabled
                ? {
                      enabled: true,
                      promotionThreshold:
                          pluginConfig.experimental.user_memories?.promotion_threshold,
                  }
                : undefined,
            experimentalPinKeyFiles: pluginConfig.experimental?.pin_key_files?.enabled
                ? {
                      enabled: true,
                      token_budget: pluginConfig.experimental.pin_key_files?.token_budget,
                      min_reads: pluginConfig.experimental.pin_key_files?.min_reads,
                  }
                : undefined,
        });

        // Start TUI→server action message consumer (handles recomp confirmations etc.)
        startTuiActionConsumer({
            client: ctx.client,
            directory: ctx.directory,
            config: pluginConfig,
        });
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

    return {
        tool: tools,
        event: createEventHandler({ magicContext: hooks.magicContext }),
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
            await hooks.magicContext?.["chat.message"]?.(input);
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

            config.agent = {
                ...(config.agent ?? {}),
                [DREAMER_AGENT]: buildHiddenAgentConfig(
                    DREAMER_AGENT,
                    DREAMER_SYSTEM_PROMPT,
                    dreamerAgentOverrides,
                ),
                [HISTORIAN_AGENT]: buildHiddenAgentConfig(
                    HISTORIAN_AGENT,
                    pluginConfig.experimental?.user_memories?.enabled
                        ? COMPARTMENT_AGENT_SYSTEM_PROMPT + USER_OBSERVATIONS_APPENDIX
                        : COMPARTMENT_AGENT_SYSTEM_PROMPT,
                    pluginConfig.historian,
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
