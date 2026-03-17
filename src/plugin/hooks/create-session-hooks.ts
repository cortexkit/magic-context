import type { MagicContextPluginConfig } from "../../config";
import {
    DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
    DEFAULT_NUDGE_INTERVAL_TOKENS,
} from "../../config/schema/magic-context";
import { createCompactionHandler } from "../../features/magic-context/compaction";
import { DEFAULT_PROTECTED_TAGS } from "../../features/magic-context/defaults";
import { createScheduler } from "../../features/magic-context/scheduler";
import { createTagger } from "../../features/magic-context/tagger";
import { createMagicContextHook } from "../../hooks/magic-context";
import type { PluginContext } from "../types";

export function createSessionHooks(args: {
    ctx: PluginContext;
    pluginConfig: MagicContextPluginConfig;
}) {
    const { ctx, pluginConfig } = args;

    if (pluginConfig.magic_context?.enabled !== true) {
        return { magicContext: null };
    }

    const tagger = createTagger();
    const scheduler = createScheduler({
        executeThresholdPercentage:
            pluginConfig.magic_context.execute_threshold_percentage ??
            DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
    });
    const compactionHandler = createCompactionHandler();

    return {
        magicContext: createMagicContextHook({
            client: ctx.client,
            directory: ctx.directory,
            tagger,
            scheduler,
            compactionHandler,
            config: {
                protected_tags: pluginConfig.magic_context.protected_tags ?? DEFAULT_PROTECTED_TAGS,
                nudge_interval_tokens:
                    pluginConfig.magic_context.nudge_interval_tokens ??
                    DEFAULT_NUDGE_INTERVAL_TOKENS,
                cache_ttl: pluginConfig.magic_context.cache_ttl,
                auto_drop_tool_age: pluginConfig.magic_context.auto_drop_tool_age,
                clear_reasoning_age: pluginConfig.magic_context.clear_reasoning_age,
                iteration_nudge_threshold: pluginConfig.magic_context.iteration_nudge_threshold,
                execute_threshold_percentage:
                    pluginConfig.magic_context.execute_threshold_percentage ??
                    DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
                compartment_token_budget: pluginConfig.magic_context.compartment_token_budget,
                historian_timeout_ms: pluginConfig.magic_context.historian_timeout_ms,
                memory: pluginConfig.magic_context.memory,
            },
        }),
    };
}
