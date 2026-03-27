import type { Plugin } from "@opencode-ai/plugin";
import { DREAMER_AGENT } from "./agents/dreamer";
import { HISTORIAN_AGENT } from "./agents/historian";
import { SIDEKICK_AGENT } from "./agents/sidekick";
import { loadPluginConfig } from "./config";
import { getMagicContextBuiltinCommands } from "./features/builtin-commands/commands";
import { DREAMER_SYSTEM_PROMPT } from "./features/magic-context/dreamer/task-prompts";
import { SIDEKICK_SYSTEM_PROMPT } from "./features/magic-context/sidekick/agent";
import { COMPARTMENT_AGENT_SYSTEM_PROMPT } from "./hooks/magic-context/compartment-prompt";
import { startDreamScheduleTimer } from "./plugin/dream-timer";
import { createEventHandler } from "./plugin/event";
import { createSessionHooks } from "./plugin/hooks/create-session-hooks";
import { createMessagesTransformHandler } from "./plugin/messages-transform";
import { createToolRegistry } from "./plugin/tool-registry";
import { getAgentFallbackModels } from "./shared/model-requirements";
import { isOpenCodeAutoCompactionEnabled } from "./shared/opencode-compaction-detector";

const plugin: Plugin = async (ctx) => {
    const pluginConfig = loadPluginConfig(ctx.directory);

    if (pluginConfig.enabled && isOpenCodeAutoCompactionEnabled(ctx.directory)) {
        pluginConfig.enabled = false;
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
    if (pluginConfig.dreamer) {
        startDreamScheduleTimer({
            client: ctx.client,
            dreamerConfig: pluginConfig.dreamer,
        });
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
                    COMPARTMENT_AGENT_SYSTEM_PROMPT,
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
