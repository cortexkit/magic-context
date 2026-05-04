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
import type { LiveSessionState } from "../../hooks/magic-context/live-session-state";
import type { PluginContext } from "../types";

export function createSessionHooks(args: {
    ctx: PluginContext;
    pluginConfig: MagicContextPluginConfig;
    liveSessionState: LiveSessionState;
}) {
    const { ctx, pluginConfig, liveSessionState } = args;

    if (pluginConfig.enabled !== true) {
        return { magicContext: null };
    }

    const tagger = createTagger();
    const scheduler = createScheduler({
        executeThresholdPercentage:
            pluginConfig.execute_threshold_percentage ?? DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
        executeThresholdTokens: pluginConfig.execute_threshold_tokens,
    });
    const compactionHandler = createCompactionHandler();

    return {
        magicContext: createMagicContextHook({
            client: ctx.client,
            directory: ctx.directory,
            tagger,
            scheduler,
            compactionHandler,
            liveSessionState,
            config: {
                protected_tags: pluginConfig.protected_tags ?? DEFAULT_PROTECTED_TAGS,
                ctx_reduce_enabled: pluginConfig.ctx_reduce_enabled,
                nudge_interval_tokens:
                    pluginConfig.nudge_interval_tokens ?? DEFAULT_NUDGE_INTERVAL_TOKENS,
                cache_ttl: pluginConfig.cache_ttl,
                auto_drop_tool_age: pluginConfig.auto_drop_tool_age,
                drop_tool_structure: pluginConfig.drop_tool_structure,
                clear_reasoning_age: pluginConfig.clear_reasoning_age,
                iteration_nudge_threshold: pluginConfig.iteration_nudge_threshold,
                execute_threshold_percentage:
                    pluginConfig.execute_threshold_percentage ??
                    DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
                execute_threshold_tokens: pluginConfig.execute_threshold_tokens,
                historian: pluginConfig.historian,
                history_budget_percentage: pluginConfig.history_budget_percentage,
                historian_timeout_ms: pluginConfig.historian_timeout_ms,
                memory: pluginConfig.memory,
                sidekick: pluginConfig.sidekick,
                dreamer: pluginConfig.dreamer,
                commit_cluster_trigger: pluginConfig.commit_cluster_trigger,
                compaction_markers: pluginConfig.compaction_markers,
                compressor: pluginConfig.compressor,
                experimental: pluginConfig.experimental,
            },
        }),
    };
}
