import type { Plugin } from "@opencode-ai/plugin";
import { loadPluginConfig } from "./config";
import { createEventHandler } from "./plugin/event";
import { createSessionHooks } from "./plugin/hooks/create-session-hooks";
import { createMessagesTransformHandler } from "./plugin/messages-transform";
import { createToolRegistry } from "./plugin/tool-registry";
import { isOpenCodeAutoCompactionEnabled } from "./shared/opencode-compaction-detector";

const plugin: Plugin = async (ctx) => {
    const pluginConfig = loadPluginConfig(ctx.directory);

    if (pluginConfig.magic_context?.enabled && isOpenCodeAutoCompactionEnabled(ctx.directory)) {
        pluginConfig.magic_context.enabled = false;
    }

    const hooks = createSessionHooks({
        ctx,
        pluginConfig,
    });

    const tools = createToolRegistry({
        ctx,
        pluginConfig,
    });

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
            const commandConfig = {
                ...(config.command ?? {}),
                ...(pluginConfig.command ?? {}),
                "ctx-status": {
                    template: "ctx-status",
                    description:
                        "Show magic context status, pending queue, cache TTL, and debug info",
                },
                "ctx-recomp": {
                    template: "ctx-recomp",
                    description:
                        "Rebuild compartments and facts from raw history without publishing partial results",
                },
                "ctx-flush": {
                    template: "ctx-flush",
                    description: "Force-process all pending magic context operations immediately",
                },
            };

            config.command = commandConfig;
            config.agent = {
                ...(config.agent ?? {}),
                ...(pluginConfig.agents?.historian
                    ? { historian: pluginConfig.agents.historian }
                    : {}),
            };
        },
    };
};

export default plugin;
