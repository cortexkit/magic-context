/**
 * Generate the differential scheduler golden for the Rust mc-module port.
 *
 * Run: bun crates/mc-module/gen/gen-scheduler-golden.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const pluginDir = join(import.meta.dir, "..", "..", "..", "packages", "plugin");
const resolve = (m: string) => Bun.resolveSync(m, pluginDir);

const schedulerMod = await import(resolve("./src/features/magic-context/scheduler"));
const eventResolvers = await import(resolve("./src/hooks/magic-context/event-resolvers"));
const overflowMod = await import(resolve("./src/features/magic-context/overflow-detection"));
const escalation = await import(resolve("./src/shared/escalation-bands"));
const compartmentTrigger = await import(resolve("./src/hooks/magic-context/compartment-trigger"));
const storageMeta = await import(resolve("./src/features/magic-context/storage-meta-persisted"));
const schema = await import(resolve("./src/config/schema/magic-context"));

const { createScheduler, parseCacheTtl } = schedulerMod as {
    createScheduler: (config: SchedulerConfig) => Scheduler;
    parseCacheTtl: (ttl: string) => number;
};
const { resolveExecuteThreshold } = eventResolvers as {
    resolveExecuteThreshold: (
        config: ExecuteThresholdConfig,
        modelKey: string | undefined,
        fallback: number,
        options?: { tokensConfig?: ExecuteThresholdTokensConfig; contextLimit?: number },
    ) => number;
};
const { detectOverflow, extractErrorMessage, parseReportedLimit, OVERFLOW_PATTERNS } =
    overflowMod as typeof import("../../../packages/plugin/src/features/magic-context/overflow-detection");

interface Scheduler {
    shouldExecute(
        sessionMeta: SessionMeta,
        contextUsage: ContextUsage,
        currentTime?: number,
        sessionId?: string,
        modelKey?: string,
        contextLimit?: number,
    ): "execute" | "defer";
}
interface SessionMeta {
    lastResponseTime: number;
    cacheTtl: string;
}
interface ContextUsage {
    percentage: number;
    inputTokens: number;
}
type ExecuteThresholdConfig = number | { default?: number; [modelKey: string]: number | undefined };
type ExecuteThresholdTokensConfig = { default?: number; [modelKey: string]: number | undefined };
interface SchedulerConfig {
    executeThresholdPercentage: ExecuteThresholdConfig;
    executeThresholdTokens?: ExecuteThresholdTokensConfig;
}

const schedulerConfig = (
    executeThresholdPercentage: ExecuteThresholdConfig,
    executeThresholdTokens?: ExecuteThresholdTokensConfig,
) => ({
    execute_threshold_percentage: executeThresholdPercentage,
    execute_threshold_tokens: executeThresholdTokens,
});
const session = (lastResponseTime: number, cacheTtl: string) => ({
    last_response_time_ms: lastResponseTime,
    cache_ttl: cacheTtl,
});
const usage = (percentage: number, inputTokens: number) => ({
    percentage,
    input_tokens: inputTokens,
});

function effectiveContextLimit(
    contextUsage: ContextUsage,
    contextLimit: number | undefined,
): number | undefined {
    return (
        contextLimit ??
        (contextUsage.percentage > 0 && contextUsage.inputTokens > 0
            ? contextUsage.inputTokens / (contextUsage.percentage / 100)
            : undefined)
    );
}

const thresholdCases = [
    { label: "percentage numeric below cap", percentage_config: 65, fallback: 65 },
    { label: "percentage cap at 90", percentage_config: 95, fallback: 65 },
    {
        label: "per-model exact match",
        percentage_config: { default: 65, "anthropic/claude-sonnet-4-20250514": 72 },
        model_key: "anthropic/claude-sonnet-4-20250514",
        fallback: 65,
    },
    {
        label: "per-model derived bare model fallback",
        percentage_config: { default: 65, "gpt-5.4": 58 },
        model_key: "openai/gpt-5.4-fast",
        fallback: 65,
    },
    {
        label: "provider wildcard keys are not threshold candidates",
        percentage_config: { default: 75, "openai/*": 30 },
        model_key: "openai/gpt-6-astra",
        fallback: 65,
    },
    {
        label: "OMP provider spelling resolves from canonical threshold identity",
        percentage_config: { default: 75, "opencode-zen/test-model": 70 },
        model_key: "opencode/test-model",
        fallback: 65,
    },
    {
        label: "tokens config with explicit context limit",
        percentage_config: 65,
        tokens_config: { default: 32_000 },
        fallback: 65,
        context_limit: 50_000,
    },
    {
        label: "tokens config cap at 80 percent",
        percentage_config: 65,
        tokens_config: { default: 90_000 },
        fallback: 65,
        context_limit: 100_000,
    },
    {
        label: "tokens model key wins over default",
        percentage_config: { default: 60 },
        tokens_config: { default: 30_000, "openai/gpt-5.4-fast": 20_000 },
        model_key: "openai/gpt-5.4-fast",
        fallback: 65,
        context_limit: 100_000,
    },
    {
        label: "tokens config without context limit falls back to percentage",
        percentage_config: { default: 62 },
        tokens_config: { default: 30_000 },
        fallback: 65,
    },
].map((c) => ({
    tokens_config: undefined,
    model_key: undefined,
    context_limit: undefined,
    ...c,
    expected: resolveExecuteThreshold(c.percentage_config, c.model_key, c.fallback, {
        tokensConfig: c.tokens_config,
        contextLimit: c.context_limit,
    }),
}));

const shouldExecuteSpecs: Array<{
    label: string;
    config: SchedulerConfig;
    sessionMeta: SessionMeta;
    contextUsage: ContextUsage;
    now: number;
    modelKey?: string;
    contextLimit?: number;
}> = [
    {
        label: "fresh session guard defers",
        config: { executeThresholdPercentage: 65 },
        sessionMeta: { lastResponseTime: 0, cacheTtl: "5m" },
        contextUsage: { percentage: 0, inputTokens: 0 },
        now: parseCacheTtl("5m") + 1,
    },
    {
        label: "percentage below threshold defers",
        config: { executeThresholdPercentage: 65 },
        sessionMeta: { lastResponseTime: 1_000, cacheTtl: "5m" },
        contextUsage: { percentage: 64.9, inputTokens: 64_900 },
        now: 2_000,
    },
    {
        label: "percentage exactly threshold executes",
        config: { executeThresholdPercentage: 65 },
        sessionMeta: { lastResponseTime: 1_000, cacheTtl: "5m" },
        contextUsage: { percentage: 65, inputTokens: 65_000 },
        now: 2_000,
    },
    {
        label: "percentage above threshold executes",
        config: { executeThresholdPercentage: 65 },
        sessionMeta: { lastResponseTime: 1_000, cacheTtl: "5m" },
        contextUsage: { percentage: 65.1, inputTokens: 65_100 },
        now: 2_000,
    },
    {
        label: "tokens threshold explicit context limit defers below tokens",
        config: { executeThresholdPercentage: 65, executeThresholdTokens: { default: 32_000 } },
        sessionMeta: { lastResponseTime: 1_000, cacheTtl: "5m" },
        contextUsage: { percentage: 31.9, inputTokens: 31_900 },
        contextLimit: 100_000,
        now: 2_000,
    },
    {
        label: "tokens threshold explicit context limit executes at tokens",
        config: { executeThresholdPercentage: 65, executeThresholdTokens: { default: 32_000 } },
        sessionMeta: { lastResponseTime: 1_000, cacheTtl: "5m" },
        contextUsage: { percentage: 32, inputTokens: 32_000 },
        contextLimit: 100_000,
        now: 2_000,
    },
    {
        label: "tokens threshold derived context limit executes",
        config: { executeThresholdPercentage: 65, executeThresholdTokens: { default: 50_000 } },
        sessionMeta: { lastResponseTime: 1_000, cacheTtl: "5m" },
        contextUsage: { percentage: 50, inputTokens: 50_000 },
        now: 2_000,
    },
    {
        label: "per-model percentage map executes",
        config: { executeThresholdPercentage: { default: 65, "openai/gpt-5.4": 58 } },
        sessionMeta: { lastResponseTime: 1_000, cacheTtl: "5m" },
        contextUsage: { percentage: 58, inputTokens: 58_000 },
        modelKey: "openai/gpt-5.4-fast",
        now: 2_000,
    },
    {
        label: "80 percent cap executes at cap",
        config: { executeThresholdPercentage: 95 },
        sessionMeta: { lastResponseTime: 1_000, cacheTtl: "5m" },
        contextUsage: { percentage: 80, inputTokens: 80_000 },
        now: 2_000,
    },
    {
        label: "scheduler ttl boundary defers on equality",
        config: { executeThresholdPercentage: 65 },
        sessionMeta: { lastResponseTime: 10_000, cacheTtl: "5m" },
        contextUsage: { percentage: 10, inputTokens: 10_000 },
        now: 10_000 + parseCacheTtl("5m"),
    },
    {
        label: "scheduler ttl fires after equality",
        config: { executeThresholdPercentage: 65 },
        sessionMeta: { lastResponseTime: 10_000, cacheTtl: "5m" },
        contextUsage: { percentage: 10, inputTokens: 10_000 },
        now: 10_000 + parseCacheTtl("5m") + 1,
    },
    {
        label: "invalid ttl falls back to default 5m",
        config: { executeThresholdPercentage: 65 },
        sessionMeta: { lastResponseTime: 10_000, cacheTtl: "nonsense" },
        contextUsage: { percentage: 10, inputTokens: 10_000 },
        now: 10_000 + parseCacheTtl("5m") + 1,
    },
    {
        label: "bare numeric ttl is milliseconds",
        config: { executeThresholdPercentage: 65 },
        sessionMeta: { lastResponseTime: 10_000, cacheTtl: "1000" },
        contextUsage: { percentage: 10, inputTokens: 10_000 },
        now: 11_001,
    },
];

const should_execute_cases = shouldExecuteSpecs.map((c) => ({
    label: c.label,
    config: schedulerConfig(c.config.executeThresholdPercentage, c.config.executeThresholdTokens),
    session: session(c.sessionMeta.lastResponseTime, c.sessionMeta.cacheTtl),
    usage: usage(c.contextUsage.percentage, c.contextUsage.inputTokens),
    now_ms: c.now,
    model_key: c.modelKey,
    context_limit: c.contextLimit,
    expected: createScheduler(c.config).shouldExecute(
        c.sessionMeta,
        c.contextUsage,
        c.now,
        "scheduler-golden",
        c.modelKey,
        c.contextLimit,
    ),
    expected_threshold: resolveExecuteThreshold(c.config.executeThresholdPercentage, c.modelKey, 65, {
        tokensConfig: c.config.executeThresholdTokens,
        contextLimit: effectiveContextLimit(c.contextUsage, c.contextLimit),
    }),
}));

const ttl = parseCacheTtl("5m");
const ttl_predicate_cases = [
    { label: "elapsed equals ttl", now_ms: 10_000 + ttl, last_response_time_ms: 10_000, ttl_ms: ttl },
    { label: "elapsed ttl plus one", now_ms: 10_000 + ttl + 1, last_response_time_ms: 10_000, ttl_ms: ttl },
    { label: "last response zero never hard expires", now_ms: ttl + 1, last_response_time_ms: 0, ttl_ms: ttl },
].map((c) => ({
    ...c,
    expected_execute_fired: c.now_ms - c.last_response_time_ms > c.ttl_ms,
    expected_hard_expired:
        c.last_response_time_ms > 0 && c.now_ms - c.last_response_time_ms > c.ttl_ms,
}));

const overflowInputs: Array<[string, unknown]> = [
    ["anthropic", "prompt is too long: 210000 tokens > 200000 maximum"],
    ["bedrock", "Input is too long for requested model."],
    ["openai", "This model's maximum context length is 128000 tokens"],
    ["gemini", "Input token count 1234567 exceeds the maximum number of tokens allowed"],
    ["xai", "the maximum prompt length is 256000 tokens but the prompt was 300000"],
    ["groq", "Please reduce the length of the messages or completion"],
    ["openrouter", "the maximum context length is 32768 tokens"],
    ["vllm-model", "maximum model length is 8192 tokens"],
    ["copilot", "Prompt exceeds the limit of 64000 tokens"],
    ["llamacpp", "Prompt exceeds the available context size"],
    ["lmstudio", "Prompt greater than the context length of the model"],
    ["minimax", "context window exceeds limit"],
    ["moonshot", "exceeded model token limit of 131072"],
    ["generic", "context_length_exceeded"],
    ["http413", "413 request entity too large"],
    ["vllm", "context length is only 4096 tokens, prompt was 5000"],
    ["vllm2", "input length 10000 exceeds the context length of 8000"],
    ["ollama", "prompt too long; exceeded max context length"],
    ["mistral", "Prompt too large for model with 32768 maximum context length"],
    ["zai", "model_context_window_exceeded"],
    ["lemonade", "Context size has been exceeded"],
    ["nested-provider-error", { error: { message: "Input token count 200000 exceeds the maximum of 128000" } }],
    ["top-level-message", { message: "prompt is too long" }],
    ["response-body", { responseBody: "413 payload too large" }],
    ["non-overflow", "Network error"],
    ["null", null],
];
const overflow_cases = overflowInputs.map(([label, input]) => {
    const detection = detectOverflow(input);
    return {
        label,
        input,
        expected_message: extractErrorMessage(input),
        expected: {
            is_overflow: detection.isOverflow,
            reported_limit: detection.reportedLimit,
            reported_limit_provenance: detection.reportedLimitProvenance,
            matched_pattern: detection.matchedPattern,
        },
    };
});

const limitMessages = [
    ["maximum prompt length", "the maximum prompt length is 256000 tokens"],
    ["maximum context length", "maximum context length is 32768 tokens"],
    ["maximum model length", "maximum model length is 8192 tokens"],
    ["context length is only", "context length is only 4096 tokens"],
    ["exceeds limit", "Prompt exceeds the limit of 64000 tokens"],
    ["anthropic maximum", "prompt is too long: 210000 tokens > 200000 maximum"],
    ["anthropic max", "prompt is too long: 210000 tokens > 200000 max"],
    ["anthropic limit", "prompt is too long: 210000 tokens > 200000 limit"],
    ["mistral", "Too large for model with 32768 maximum context length"],
    ["plausible floor accepted", "maximum context length is 1024 tokens"],
    ["below plausible floor rejected", "maximum context length is 1023 tokens"],
    ["plausible ceiling accepted", "maximum context length is 10000000 tokens"],
    ["above plausible ceiling rejected", "maximum context length is 10000001 tokens"],
    ["no match", "Random error message"],
    ["empty", ""],
] as const;
const limit_cases = limitMessages.map(([label, message]) => ({
    label,
    message,
    expected: parseReportedLimit(message),
}));

const parse_ttl_cases = ["5m", "30s", "2h", "1500", " 5m ", "garbage"].map((ttl) => {
    let expected_ms: number | undefined;
    try {
        expected_ms = parseCacheTtl(ttl);
    } catch {
        expected_ms = undefined;
    }
    return { label: ttl, ttl, expected_ms };
});

const constants = {
    default_execute_threshold_percentage: schema.DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
    max_execute_threshold_percentage: resolveExecuteThreshold(999, undefined, 65),
    force_materialize_percentage:
        escalation.escalationBands(65).forceMaterializationPercentage,
    emergency_percentage: compartmentTrigger.BLOCK_UNTIL_DONE_PERCENTAGE,
    default_cache_ttl_ms: parseCacheTtl("5m"),
    one_second_ms: parseCacheTtl("1s"),
    one_minute_ms: parseCacheTtl("1m"),
    one_hour_ms: parseCacheTtl("1h"),
    bare_numeric_ms: parseCacheTtl("1234"),
    emergency_drain_enter_percentage:
        escalation.escalationBands(65).forceMaterializationPercentage,
    emergency_drain_exit_margin: storageMeta.EMERGENCY_DRAIN_EXIT_MARGIN,
    emergency_drain_fallback_exit_percentage: storageMeta.EMERGENCY_DRAIN_FALLBACK_EXIT_PERCENTAGE,
    emergency_drain_failure_backoff_ms: storageMeta.EMERGENCY_DRAIN_FAILURE_BACKOFF_MS,
    emergency_drain_max_latch_ms: storageMeta.EMERGENCY_DRAIN_MAX_LATCH_MS,
    min_plausible_context_limit: parseReportedLimit("maximum context length is 1024 tokens")?.value,
    max_plausible_context_limit: parseReportedLimit("maximum context length is 10000000 tokens")?.value,
    overflow_pattern_sources: OVERFLOW_PATTERNS.map((p) => p.source),
};

const golden = {
    constants,
    parse_ttl_cases,
    threshold_cases: thresholdCases,
    should_execute_cases,
    ttl_predicate_cases,
    overflow_cases,
    limit_cases,
};

const outPath = join(import.meta.dir, "..", "testdata", "scheduler-golden.json");
writeFileSync(outPath, `${JSON.stringify(golden, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote scheduler golden (${should_execute_cases.length} shouldExecute, ${overflow_cases.length} overflow) → ${outPath}`);
