import type { MagicContextPluginConfig } from "../../config";
import { DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE } from "../../config/schema/magic-context";
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
            serverUrl:
                (ctx as { serverUrl?: URL }).serverUrl instanceof URL
                    ? (ctx as { serverUrl: URL }).serverUrl.toString().replace(/\/$/, "")
                    : undefined,
            tagger,
            scheduler,
            compactionHandler,
            liveSessionState,
            config: {
                protected_tags: pluginConfig.protected_tags ?? DEFAULT_PROTECTED_TAGS,
                ctx_reduce_enabled: pluginConfig.ctx_reduce_enabled,
                cache_ttl: pluginConfig.cache_ttl,
                clear_reasoning_age: pluginConfig.clear_reasoning_age,
                toast_duration_ms: pluginConfig.toast_duration_ms,
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
                // Issue #53: per-agent system-prompt injection opt-out.
                system_prompt_injection: pluginConfig.system_prompt_injection,
                // Graduated from experimental.* — temporal_awareness and caveman
                // are top-level; auto_search now rides inside `memory` (passed
                // above), and git_commit_indexing is consumed at the dream-timer
                // level in index.ts, not per-session.
                temporal_awareness: pluginConfig.temporal_awareness,
                caveman_text_compression: pluginConfig.caveman_text_compression,
            },
        }),
    };
}
