import { homedir } from "node:os";
import { z } from "zod";
import { isValidLanguageCode } from "../../agents/language-directive";
import { DEFAULT_PROTECTED_TAGS } from "../../features/magic-context/defaults";
import { isValidCron } from "../../features/magic-context/dreamer/cron";
import {
    AGENTIC_DREAM_TASKS,
    type DreamTaskName,
} from "../../features/magic-context/dreamer/task-registry";
import { AgentOverrideConfigSchema } from "./agent-overrides";

export const DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE = 65;
// Explains WHY execute_threshold is hard-capped at 80% (not just "too big").
// A single agent step can be large enough to overflow the context window before
// Magic Context can compact between turns; staying at/below 80% leaves headroom
// to absorb that and compact safely instead of falling back to OpenCode's native
// compaction (far harder to recover from). 80% also sits below the 85% emergency
// and 95% block-and-recover bands, which are tuned around it.
export const EXECUTE_THRESHOLD_CAP_MESSAGE =
    "execute_threshold is capped at 80% for cache safety: a single large agent step can overflow the context window before Magic Context can compact between turns, forcing OpenCode's native compaction (hard to recover from). 80% also leaves headroom below the 85%/95% emergency bands. Use a value between 20 and 80.";
export const DEFAULT_HISTORIAN_TIMEOUT_MS = 300_000;
export const DEFAULT_HISTORY_BUDGET_PERCENTAGE = 0.15;

export const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

// Re-exported from the (DB-free) task registry so the schema and the runtime
// scheduler share ONE source of truth for task names. DreamingTask remains the
// agentic tasks (those driven by buildDreamTaskPrompt); CANONICAL_DREAM_TASKS
// is the full task set used for per-task scheduling config.
export const DREAMER_TASKS = AGENTIC_DREAM_TASKS;
export const DreamingTaskSchema = z.enum(AGENTIC_DREAM_TASKS);
export type DreamingTask = (typeof AGENTIC_DREAM_TASKS)[number];

/** Valid thinking levels for Pi subagents. Maps to Pi's --thinking CLI flag.
 *  Off: disable reasoning. Minimal/low/medium/high/xhigh: increasing reasoning depth.
 *  Pi-only — OpenCode uses `variant` in agent config instead. */
export const PiThinkingLevelSchema = z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh"])
    .optional();
export type PiThinkingLevel = z.infer<typeof PiThinkingLevelSchema>;

/** A 5-field cron expression, or "" to disable the task. */
const CronScheduleSchema = z
    .string()
    .refine((s) => s.trim() === "" || isValidCron(s), {
        message:
            'Invalid schedule: use a 5-field cron expression (e.g. "0 3 * * *" for 3am daily, "0 3 * * 0" for Sunday 3am, "0 */6 * * *" every 6h) or "" to disable.',
    })
    .describe('5-field cron schedule (e.g. "0 3 * * *"), or "" to disable this task.');

/** Per-task scheduling + model config. Model/fallback/thinking inherit the
 *  dreamer-level defaults when omitted. Task-specific params (promotion_threshold)
 *  are optional and only meaningful for their owning task. */
const DreamTaskBaseConfigSchema = z.object({
    schedule: CronScheduleSchema.default(""),
    model: z.string().optional().describe("Per-task model override (inherits dreamer.model)"),
    fallback_models: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Per-task fallback chain (inherits dreamer.fallback_models)"),
    thinking_level: PiThinkingLevelSchema.describe("Pi only: per-task thinking level"),
    timeout_minutes: z
        .number()
        .min(5)
        .default(20)
        .describe("Minutes allowed for this task before it is aborted"),
});

const PromotionThresholdSchema = z
    .number()
    .min(2)
    .max(20)
    .optional()
    .describe(
        "review-user-memories: min candidate observations before promotion is considered (default: 3)",
    );
const PrimerPromotionThresholdSchema = z
    .number()
    .min(2)
    .max(20)
    .optional()
    .describe(
        "promote-primers: min recurring source days before promotion is considered (default: 2)",
    );
export const DreamTaskConfigSchema = DreamTaskBaseConfigSchema.extend({
    promotion_threshold: PromotionThresholdSchema,
});
const ReviewUserMemoriesTaskConfigSchema = DreamTaskBaseConfigSchema.extend({
    promotion_threshold: PromotionThresholdSchema,
});
const PromotePrimersTaskConfigSchema = DreamTaskBaseConfigSchema.extend({
    promotion_threshold: PrimerPromotionThresholdSchema,
});
export type DreamTaskConfig = z.infer<typeof DreamTaskConfigSchema>;

/** Default schedule per task. Preserves v1 behavior: verify runs nightly;
 *  curate runs weekly; classify runs daily after curation; maintain-docs
 *  defaults OFF (it was not in the v1 default list); the two promoted
 *  post-phases run nightly and are gated. */
const DEFAULT_TASK_SCHEDULES: Record<DreamTaskName, string> = {
    // map-memories is a one-time-style backfill (gate: unmapped memories exist).
    // Default nightly so it drains the pool then no-ops once everything is mapped.
    "map-memories": "0 2 * * *",
    verify: "0 3 * * *",
    "verify-broad": "0 4 * * 0",
    curate: "0 4 * * 0",
    "classify-memories": "0 6 * * *",
    retrospective: "0 5 * * *",
    "maintain-docs": "",
    "evaluate-smart-notes": "0 3 * * *",
    "review-user-memories": "0 3 * * *",
    "promote-primers": "0 3 * * *",
    "refresh-primers": "0 3 * * *",
};

function defaultTaskConfig(task: DreamTaskName): z.input<typeof DreamTaskConfigSchema> {
    const base: z.input<typeof DreamTaskConfigSchema> = { schedule: DEFAULT_TASK_SCHEDULES[task] };
    if (task === "review-user-memories") base.promotion_threshold = 3;
    if (task === "promote-primers") base.promotion_threshold = 2;
    return base;
}

// `.default()` in Zod 4 wants the OUTPUT shape; the function form lets us derive
// it by parsing the (partial) input default so timeout_minutes etc. fill in.
/** The `tasks` record: one entry per canonical task, each defaulting to its
 *  v1-behavior-preserving schedule. Written explicitly (not via fromEntries) so
 *  the inferred type stays a precise per-key object. */
export const DreamTasksSchema = z
    .object({
        "map-memories": DreamTaskBaseConfigSchema.default(() =>
            DreamTaskBaseConfigSchema.parse(defaultTaskConfig("map-memories")),
        ),
        verify: DreamTaskBaseConfigSchema.default(() =>
            DreamTaskBaseConfigSchema.parse(defaultTaskConfig("verify")),
        ),
        "verify-broad": DreamTaskBaseConfigSchema.default(() =>
            DreamTaskBaseConfigSchema.parse(defaultTaskConfig("verify-broad")),
        ),
        curate: DreamTaskBaseConfigSchema.default(() =>
            DreamTaskBaseConfigSchema.parse(defaultTaskConfig("curate")),
        ),
        "classify-memories": DreamTaskBaseConfigSchema.default(() =>
            DreamTaskBaseConfigSchema.parse(defaultTaskConfig("classify-memories")),
        ),
        retrospective: DreamTaskBaseConfigSchema.default(() =>
            DreamTaskBaseConfigSchema.parse(defaultTaskConfig("retrospective")),
        ),
        "maintain-docs": DreamTaskBaseConfigSchema.default(() =>
            DreamTaskBaseConfigSchema.parse(defaultTaskConfig("maintain-docs")),
        ),
        "evaluate-smart-notes": DreamTaskBaseConfigSchema.default(() =>
            DreamTaskBaseConfigSchema.parse(defaultTaskConfig("evaluate-smart-notes")),
        ),
        "review-user-memories": ReviewUserMemoriesTaskConfigSchema.default(() =>
            ReviewUserMemoriesTaskConfigSchema.parse(defaultTaskConfig("review-user-memories")),
        ),
        "promote-primers": PromotePrimersTaskConfigSchema.default(() =>
            PromotePrimersTaskConfigSchema.parse(defaultTaskConfig("promote-primers")),
        ),
        "refresh-primers": DreamTaskBaseConfigSchema.default(() =>
            DreamTaskBaseConfigSchema.parse(defaultTaskConfig("refresh-primers")),
        ),
    })
    .describe(
        "Per-task scheduling + model config. Each task has its own cron schedule and may override the dreamer-level model.",
    );

/** Combined dreamer agent + per-task scheduling configuration (Dreamer v2). */
export const DreamerConfigSchema = AgentOverrideConfigSchema.merge(
    z.object({
        tasks: DreamTasksSchema.default(() => DreamTasksSchema.parse({})),
        inject_docs: z
            .boolean()
            .default(true)
            .describe(
                "Inject ARCHITECTURE.md and STRUCTURE.md into the m[0] `<project-docs>` block (default true)",
            ),
        thinking_level: PiThinkingLevelSchema.describe(
            "Pi only: default thinking level for dreamer subagent invocations. See historian.thinking_level.",
        ),
    }),
);
export type DreamerConfig = z.infer<typeof DreamerConfigSchema>;

export const SidekickConfigSchema = AgentOverrideConfigSchema.extend({
    timeout_ms: z.number().default(30000).describe("Timeout for sidekick calls in milliseconds"),
    system_prompt: z.string().optional().describe("Custom system prompt for sidekick"),
    thinking_level: PiThinkingLevelSchema.describe(
        "Pi only: explicit thinking level for sidekick subagent invocations. See historian.thinking_level.",
    ),
}).optional();
export type SidekickConfig = NonNullable<z.infer<typeof SidekickConfigSchema>>;

/** Historian agent configuration — includes all agent overrides plus two_pass mode.
 *  Two-pass mode runs a second editor pass after the initial historian pass to clean
 *  up low-signal U: lines and cross-compartment duplicates. Recommended for models
 *  without extended thinking; not needed for Claude Sonnet/Opus when reasoning is
 *  enabled via OpenCode variant config. */
export const HistorianConfigSchema = AgentOverrideConfigSchema.extend({
    two_pass: z
        .boolean()
        .default(false)
        .describe(
            "Run a second editor pass over historian output to clean low-signal U: lines and cross-compartment duplicates. Adds ~1 extra API call and ~1.3x cost per historian run. Useful for models without extended thinking support. (default: false)",
        ),
    thinking_level: PiThinkingLevelSchema.describe(
        "Pi only: explicit thinking level passed as --thinking <level> to Pi historian subagent invocations. Required when using reasoning models (e.g. github-copilot/gpt-5.4) because Pi's default thinking-level resolution can pick a value the provider rejects. OpenCode users set variant instead. Valid: off | minimal | low | medium | high | xhigh",
    ),
    disallowed_tools: z
        .array(z.enum(["*", "read", "aft_outline", "aft_zoom", "aft_search"]))
        .default([])
        .describe(
            'OpenCode only. Tools to REMOVE from the historian\'s default allow-list [read, aft_outline, aft_zoom, aft_search]. Applies to both historian and historian-editor agents. Use ["*"] to strip all tool definitions from the model request — this prevents weak instruction-following models (e.g. mistral-small-latest) from entering tool-calling loops. Individual tool names remove just that tool. Note: a user-supplied historian.permission override can re-allow a tool that disallowed_tools removed — disallowed_tools sets the baseline, permission overrides take precedence. (default: [])',
        ),
}).optional();
export type HistorianConfig = NonNullable<z.infer<typeof HistorianConfigSchema>>;

const EmbeddingFallbackProviderSchema = z.enum(["local", "openai-compatible", "off"]);

function expandConfigPath(value: string): string {
    const trimmed = value.trim();
    if (trimmed === "~") return homedir();
    if (trimmed.startsWith("~/")) return `${homedir()}/${trimmed.slice(2)}`;
    return trimmed;
}

const BaseEmbeddingConfigSchema = z
    .object({
        provider: z
            .enum(["local", "openai-compatible", "off", "synapse"])
            .default("local")
            .describe(
                "Embedding provider. 'local' uses Xenova/all-MiniLM-L6-v2, 'openai-compatible' requires endpoint and model, 'synapse' uses the certified local Synapse lane with an explicit fallback provider, and 'off' disables embeddings.",
            ),
        fallback_provider: EmbeddingFallbackProviderSchema.optional().describe(
            "Fallback provider for the Synapse lane. Required when provider is 'synapse'; local, openai-compatible, and off are valid.",
        ),
        model: z
            .string()
            .optional()
            .describe("Embedding model name. Required for openai-compatible, ignored for local."),
        endpoint: z
            .string()
            .optional()
            .describe("API endpoint URL. Required when provider is openai-compatible."),
        api_key: z.string().optional().describe("API key for remote embedding provider (optional)"),
        input_type: z
            .string()
            .optional()
            .describe(
                "Default input_type for stored/indexed (passage) embeddings in the request body. Required by some openai-compatible providers (e.g. NVIDIA NIM). Omitted from the request when unset.",
            ),
        query_input_type: z
            .string()
            .optional()
            .describe(
                "Optional input_type for query (search) embeddings on asymmetric models (e.g. NVIDIA NIM 'query'). When unset, query embeddings use embedding.input_type. Passage/stored content always uses embedding.input_type.",
            ),
        truncate: z
            .string()
            .optional()
            .describe(
                "Optional truncate mode sent in the embedding request body (e.g. NVIDIA NIM accepts 'NONE' | 'START' | 'END'). Omitted from the request when unset.",
            ),
        max_input_tokens: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
                "Optional maximum input tokens for chunk embeddings. Defaults conservatively to 512 when omitted.",
            ),
    })
    .superRefine((data, ctx) => {
        const validationProvider =
            data.provider === "synapse" ? data.fallback_provider : data.provider;
        if (validationProvider === "openai-compatible" && !data.endpoint?.trim()) {
            ctx.addIssue({
                code: "custom",
                path: ["endpoint"],
                message: "endpoint is required when embedding.provider is openai-compatible",
            });
        }

        if (validationProvider === "openai-compatible" && !data.model?.trim()) {
            ctx.addIssue({
                code: "custom",
                path: ["model"],
                message: "model is required when embedding.provider is openai-compatible",
            });
        }
    });

export const EmbeddingConfigSchema = BaseEmbeddingConfigSchema.transform((data) => {
    if (data.provider === "synapse") {
        const model = data.model?.trim();
        const endpoint = data.endpoint?.trim();
        const apiKey = data.api_key?.trim();
        const inputType = data.input_type?.trim();
        const queryInputType = data.query_input_type?.trim();
        const truncate = data.truncate?.trim();
        return {
            provider: "synapse" as const,
            ...(data.fallback_provider ? { fallback_provider: data.fallback_provider } : {}),
            ...(model ? { model } : {}),
            ...(endpoint ? { endpoint } : {}),
            ...(apiKey ? { api_key: apiKey } : {}),
            ...(inputType ? { input_type: inputType } : {}),
            ...(queryInputType ? { query_input_type: queryInputType } : {}),
            ...(truncate ? { truncate } : {}),
            ...(data.max_input_tokens ? { max_input_tokens: data.max_input_tokens } : {}),
        };
    }

    if (data.provider === "local") {
        return {
            provider: "local" as const,
            model: data.model?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL,
            ...(data.max_input_tokens ? { max_input_tokens: data.max_input_tokens } : {}),
        };
    }

    if (data.provider === "openai-compatible") {
        const apiKey = data.api_key?.trim();
        const inputType = data.input_type?.trim();
        const queryInputType = data.query_input_type?.trim();
        const truncate = data.truncate?.trim();
        return {
            provider: "openai-compatible" as const,
            model: data.model?.trim() ?? "",
            endpoint: data.endpoint?.trim() ?? "",
            ...(apiKey ? { api_key: apiKey } : {}),
            ...(inputType ? { input_type: inputType } : {}),
            ...(queryInputType ? { query_input_type: queryInputType } : {}),
            ...(truncate ? { truncate } : {}),
            ...(data.max_input_tokens ? { max_input_tokens: data.max_input_tokens } : {}),
        };
    }

    return { provider: "off" as const };
});

export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
export type EmbeddingFallbackProvider = z.infer<typeof EmbeddingFallbackProviderSchema>;

export interface SubcConfig {
    connection_file: string;
}

export interface ShadowEmbeddingConfig {
    enabled: boolean;
}

export interface MagicContextConfig {
    enabled: boolean;
    /** Selects the runtime implementation for this project. Rust mode is experimental and requires user-level subc configuration. */
    transform_mode: "ts" | "rust";
    /** Auto-update the cached OpenCode plugin wrapper when a newer npm version is available.
     *  USER config only; project configs cannot disable it. Default: true. */
    auto_update?: boolean;
    /** Output language for generated Magic Context prose. USER config only. */
    language?: string;
    historian?: HistorianConfig;
    dreamer?: DreamerConfig;
    cache_ttl: string | { default: string; [modelKey: string]: string };
    /** TUI toast lifetime in milliseconds for Magic Context notifications. Default: 5000. */
    toast_duration_ms?: number;
    execute_threshold_percentage: number | { default: number; [modelKey: string]: number };
    /** Absolute token thresholds per model. When set for a given model (or via `default`),
     *  this overrides `execute_threshold_percentage` for that model. Useful for hard caps
     *  matching provider input limits. Values above 80% × context_limit are clamped with a warning. */
    execute_threshold_tokens?: { default?: number; [modelKey: string]: number | undefined };
    protected_tags: number;
    clear_reasoning_age: number;
    history_budget_percentage: number;
    historian_timeout_ms: number;
    commit_cluster_trigger: {
        enabled: boolean;
        min_clusters: number;
    };
    /** Per-connection SQLite tuning for Magic Context's own context.db. */
    sqlite: {
        cache_size_mb: number;
        mmap_size_mb: number;
    };
    /**
     * Controls whether and where Magic Context augments the system prompt
     * (`## Magic Context` guidance, `<project-docs>`, `<user-profile>`,
     * sticky date) inside `experimental.chat.system.transform`.
     *
     * Internal OpenCode hidden agents (title, summary, compaction) are
     * always skipped automatically — that's a separate code path.
     */
    system_prompt_injection: {
        /** When false, NO injection happens for ANY agent — global escape hatch. */
        enabled: boolean;
        /**
         * If the agent's system prompt contains any of these substrings,
         * skip ALL Magic Context injection for that call. Lets users opt
         * specific agents out (e.g. read-only QA agents that deny our
         * `ctx_*` tools and don't need the guidance). The default marker
         * `<!-- magic-context: skip -->` is meant to be added inside the
         * user's custom agent prompt.
         */
        skip_signatures: string[];
    };
    /** Inject elapsed-time markers between user messages and date ranges on
     *  compartments so the agent has a wall-clock sense of the session.
     *  Graduated from `experimental.temporal_awareness`; default: true. */
    temporal_awareness: boolean;
    /** Debug: when true, keep the child sessions Magic Context spawns for its
     *  own subagents (historian, dreamer, sidekick, memory-migration) instead
     *  of deleting them on success. For short-term inspection/data collection;
     *  kept sessions accumulate until manually cleared. Default false. */
    keep_subagents: boolean;
    /** Pi-only controls for Magic Context's OpenCode-parity todowrite surface. */
    todowrite: {
        enabled: boolean;
        overlay: boolean;
    };
    /** Content-aware reclaim of tool output that a later call supersedes, added
     *  to the normal age-based auto-drop: superseded todowrite/ctx_reduce/meta
     *  outputs are dropped, and older edits to a file are compressed to a marker
     *  that keeps only the filePath. Only runs on a transform pass that is
     *  already rewriting the messages, so it never triggers a prompt-cache miss
     *  on its own; when off, the messages sent to the model are byte-identical to
     *  the age-based-only behavior. Experimental, opt-in, default off until cache
     *  stability is proven. */
    smart_drops: boolean;
    /**
     * Age-tier caveman compression for long user/assistant text parts.
     * Graduated from `experimental.caveman_text_compression`; opt-in, default off.
     *
     * Active only for primary sessions when enabled; never for subagents.
     * Buckets eligible (outside-protected-tail) messages into four age
     * tiers by tag position — oldest 20% → ultra, next 20% → full,
     * next 20% → lite, newest 40% → untouched — and rewrites the text
     * part in place.
     * Always compresses from the original source (source_contents), so
     * tier shifts produce the same result as if the target depth were
     * applied directly to the original text.
     *
     * Disabled by default because it rewrites agent-visible history.
     */
    caveman_text_compression: {
        enabled: boolean;
        /** Text parts shorter than this (characters) are left untouched. */
        min_chars: number;
    };
    embedding: EmbeddingConfig;
    /** User-only connection settings for the Synapse daemon. */
    subc?: SubcConfig;
    /** Developer-only Synapse shadow lane switch. */
    shadow_embedding?: ShadowEmbeddingConfig;
    memory: {
        enabled: boolean;
        injection_budget_tokens: number;
        auto_promote: boolean;
        retrieval_count_promotion_threshold: number;
        /** Appends a compact hint to new user messages when ctx_search finds
         *  highly-related memories, conversation, or git commits. Does NOT
         *  inject full content — just vague fragments that nudge the agent to
         *  run ctx_search for full context if relevant. Graduated from
         *  `experimental.auto_search`; enabled by default. Independent of
         *  `memory.enabled` — it can still surface conversation/git hints when
         *  the memory store is off. */
        auto_search: {
            enabled: boolean;
            /** Top hit score must exceed this threshold for the hint to fire. */
            score_threshold: number;
            /** Minimum user message length in characters (skip short prompts). */
            min_prompt_chars: number;
        };
        /** Index git commit messages from HEAD into a new ctx_search source so
         *  agents can recall recent regressions, fixes, and decisions from
         *  commit history without running git log manually. Graduated from
         *  `experimental.git_commit_indexing`; opt-in, default off. Independent
         *  of `memory.enabled`. */
        git_commit_indexing: {
            enabled: boolean;
            /** Days of history to index (default: 365) */
            since_days: number;
            /** Max commits kept per project; oldest evicted (default: 2000) */
            max_commits: number;
        };
    };
    shadow_transform: {
        enabled: boolean;
    };
    sidekick?: SidekickConfig;
}

export const MagicContextConfigSchema = z
    .object({
        enabled: z.boolean().default(true).describe("Enable magic context (default: true)"),
        transform_mode: z
            .enum(["ts", "rust"])
            .default("ts")
            .describe(
                'Experimental: routes the entire Magic Context runtime for the project through the ck-mc Rust module over subc (requires user-level `subc` config); "ts" is the current TypeScript pipeline.',
            ),
        auto_update: z
            .boolean()
            .optional()
            .describe(
                "Enable automatic npm self-update checks for the OpenCode plugin. Security: USER-only in config loader, so hostile project configs cannot suppress updates.",
            ),
        language: z
            .string()
            .trim()
            .toLowerCase()
            .refine(
                (s) => isValidLanguageCode(s),
                'language must be a 2-letter ISO 639-1 code (e.g. "tr", "es", "de")',
            )
            .optional()
            .describe(
                "Output language for Magic Context's generated content and guidance, as a " +
                    '2-letter ISO 639-1 code (e.g. "tr", "es", "de", "ja", "pt"). When set, the ' +
                    "historian, dreamer, sidekick, and the agent-guidance block instruct the model to " +
                    "write its PROSE in this language while keeping all structural tokens (XML tags, " +
                    "the five memory category names, code identifiers, file paths) in English. " +
                    "USER-LEVEL ONLY (ignored in project config for security). Unset = today's " +
                    "behavior (model mirrors the conversation; English scaffolding). Changing it " +
                    "triggers one cache re-materialization; existing compartments/memories keep their " +
                    "original language until naturally rewritten.",
            ),
        historian: HistorianConfigSchema.describe(
            "Historian agent configuration (model, fallback_models, variant, temperature, maxTokens, permission, two_pass, etc.)",
        ),
        dreamer: DreamerConfigSchema.optional().describe(
            "Dreamer agent + scheduling configuration (model, fallback_models, disable, schedule, tasks, etc.)",
        ),
        cache_ttl: z
            .union([z.string(), z.object({ default: z.string() }).catchall(z.string())])
            .default("5m")
            .describe(
                'Cache TTL: string (e.g. "5m") or per-model object ({ default: "5m", "model-id": "10m" })',
            ),
        toast_duration_ms: z
            .number()
            .min(0)
            .max(60_000)
            .default(5_000)
            .describe(
                "TUI toast lifetime in milliseconds for Magic Context notifications. Set to 0 to disable Magic Context toasts entirely (min: 0, max: 60000, default: 5000)",
            ),
        execute_threshold_percentage: z
            .union([
                z.number().min(20).max(80, EXECUTE_THRESHOLD_CAP_MESSAGE),
                z
                    .object({ default: z.number().min(20).max(80, EXECUTE_THRESHOLD_CAP_MESSAGE) })
                    .catchall(z.number().min(20).max(80, EXECUTE_THRESHOLD_CAP_MESSAGE)),
            ])
            .default(DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE)
            .describe(
                'Context percentage that forces queued operations to execute. Number or per-model object ({ default: 65, "provider/model": 45 }). Values above 80 are rejected because the runtime caps at 80% for cache safety (MAX_EXECUTE_THRESHOLD). Default: DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE',
            ),
        execute_threshold_tokens: z
            .object({
                default: z.number().min(5_000).max(2_000_000).optional(),
            })
            .catchall(z.number().min(5_000).max(2_000_000))
            .optional()
            .describe(
                "Absolute token thresholds per model. When matched, overrides execute_threshold_percentage for that model. Accepts `default` for all models or per-model keys. Values above 80% × context_limit are clamped with a warning log. Min 5_000, max 2_000_000.",
            ),
        protected_tags: z
            .number()
            .min(1)
            .max(100)
            .optional()
            .describe(
                "Number of recent tags to protect from dropping (min: 1, max: 100, default: 20)",
            ),
        clear_reasoning_age: z
            .number()
            .min(10)
            .default(50)
            .describe("Clear reasoning/thinking blocks older than N tags (default: 50)"),
        history_budget_percentage: z
            .number()
            .min(0.05)
            .max(0.5)
            .default(DEFAULT_HISTORY_BUDGET_PERCENTAGE)
            .describe(
                "Fraction of usable context (context_limit × execute_threshold) reserved for the session history block (default: 0.15)",
            ),
        historian_timeout_ms: z
            .number()
            .min(60_000)
            .default(DEFAULT_HISTORIAN_TIMEOUT_MS)
            .describe("Timeout for each historian prompt call in milliseconds (default: 300000)"),
        commit_cluster_trigger: z
            .object({
                enabled: z
                    .boolean()
                    .default(true)
                    .describe("Enable commit-cluster based historian triggering (default: true)"),
                min_clusters: z
                    .number()
                    .min(1)
                    .default(3)
                    .describe(
                        "Minimum commit clusters required to trigger historian (min: 1, default: 3)",
                    ),
            })
            .default({ enabled: true, min_clusters: 3 })
            .describe(
                "Commit-cluster trigger: fire historian when enough commit clusters accumulate in the unsummarized tail",
            ),
        system_prompt_injection: z
            .object({
                enabled: z
                    .boolean()
                    .default(true)
                    .describe(
                        "When false, NO injection happens for ANY agent — global escape hatch. (default: true)",
                    ),
                skip_signatures: z
                    .array(z.string())
                    .default(["<!-- magic-context: skip -->"])
                    .describe(
                        "Substring opt-out list. If the agent's system prompt contains any of these strings, skip ALL Magic Context injection for that call. Default \"<!-- magic-context: skip -->\" is meant to be added inside a user's custom agent prompt to opt that agent out.",
                    ),
            })
            .default({
                enabled: true,
                skip_signatures: ["<!-- magic-context: skip -->"],
            })
            .describe(
                "Controls whether and where Magic Context augments the system prompt. Lets users opt specific agents out of the Magic Context guidance and the surrounding project-docs / user-profile blocks. OpenCode's internal hidden agents — title, summary, and compaction — are always skipped automatically.",
            ),
        // v2: the LLM compressor was removed — deterministic decay-tier rendering
        // (decay-render.ts) replaces it, so there are no compressor knobs. A
        // leftover `compressor` block in an existing config is silently ignored
        // (the schema strips unknown keys).
        sqlite: z
            .object({
                cache_size_mb: z
                    .number()
                    .min(2)
                    .max(2048)
                    .default(64)
                    .describe(
                        "Page-cache size in MiB per connection (PRAGMA cache_size). Larger keeps more hot pages resident, cutting re-reads on repeated full-table scans. (min 2, max 2048, default 64)",
                    ),
                mmap_size_mb: z
                    .number()
                    .min(0)
                    .max(8192)
                    .default(0)
                    .describe(
                        "Memory-mapped I/O size in MiB (PRAGMA mmap_size). 0 disables mmap (SQLite default). Raising it can cut read overhead on large DBs at the cost of address space. (min 0, max 8192, default 0)",
                    ),
            })
            .default({ cache_size_mb: 64, mmap_size_mb: 0 })
            .describe(
                "SQLite connection tuning for Magic Context's own context.db. These are per-connection PRAGMAs applied at open; they do not change the schema or what is stored.",
            ),
        embedding: EmbeddingConfigSchema.default({
            provider: "local",
            model: DEFAULT_LOCAL_EMBEDDING_MODEL,
        }).describe("Embedding provider configuration"),
        subc: z
            .object({
                connection_file: z
                    .string()
                    .trim()
                    .min(1)
                    .transform(expandConfigPath)
                    .describe("Path to the owner-only subc connection file."),
            })
            .optional()
            .describe("User-only Synapse daemon connection settings."),
        shadow_embedding: z
            .object({
                enabled: z
                    .boolean()
                    .default(false)
                    .describe("Developer-only Synapse shadow embedding lane switch."),
            })
            .default({ enabled: false })
            .describe("Developer-only Synapse shadow embedding lane."),
        temporal_awareness: z
            .boolean()
            .default(true)
            .describe(
                'Inject wall-clock gap markers (<!-- +Xm -->) between user messages where > 5 min elapsed since the previous message, and add compact date ranges to compartment headings. Gives the agent a sense of session pacing and "how long ago" across multi-day sessions. Graduated from experimental.temporal_awareness; default: true (set false to opt out).',
            ),
        keep_subagents: z
            .boolean()
            .default(false)
            .describe(
                "Debug: keep the child sessions Magic Context spawns for its own subagents (historian, dreamer, sidekick, memory-migration) instead of deleting them on success. Useful for short-term inspection/data collection — their full transcript (prompt, tool calls, token usage, output) stays in the host session store. Kept sessions accumulate until manually cleared; leave false for normal use. Requires a restart to take effect.",
            ),
        shadow_transform: z
            .object({
                enabled: z
                    .boolean()
                    .default(false)
                    .describe(
                        "Dev flag: mirror every transform pass to the Magic Context Rust module over subc and byte-compare outputs. No behavior impact; default off.",
                    ),
            })
            .default({ enabled: false })
            .describe(
                "Developer-only shadow transform lane. When enabled, the plugin fire-and-forgets a copy of each finalized transform to the Rust module for comparison; the live output is unchanged.",
            ),
        todowrite: z
            .object({
                enabled: z
                    .boolean()
                    .default(true)
                    .describe(
                        "Pi only: register Magic Context's todowrite task-list tool. Disable if you use your own todo extension. OpenCode ships its own built-in todowrite; this setting has no effect there.",
                    ),
                overlay: z
                    .boolean()
                    .default(true)
                    .describe(
                        "Pi only: show the persistent todo overlay above the editor while tasks are active.",
                    ),
            })
            .default({ enabled: true, overlay: true })
            .describe(
                "Pi-only todowrite tool and overlay controls. Pi registers tools and widgets at extension boot, so changing this after /cd requires /reload or restart.",
            ),
        smart_drops: z
            .boolean()
            .default(false)
            .describe(
                "Content-aware reclaim of provably-superseded tool output. When on: superseded todowrite (keep newest 1), spent ctx_reduce (keep newest 5), and zero-value meta (bash_status, bash_kill, ctx_note read/dismiss) outputs are dropped; older edits to a file are compressed to a filePath-preserving marker while the newest edit per file stays full. Age alone never selects a tool. Only acts on passes already busting the cache, so it never originates a cache bust. Honors the protected-tag reserve. Experimental: opt-in, default off; when off the entire supersession feature is inert and routine tool output requires explicit ctx_reduce or the emergency safety valve. Requires a restart.",
            ),
        caveman_text_compression: z
            .object({
                enabled: z
                    .boolean()
                    .default(false)
                    .describe(
                        "Apply deterministic caveman-style text compression to old conversation text. Active for primary sessions when enabled; never for subagents. Compresses user/assistant text in oldest-first tiers: ultra (oldest 20%), full, lite, untouched (newest 40%).",
                    ),
                min_chars: z
                    .number()
                    .min(100)
                    .max(10000)
                    .default(500)
                    .describe(
                        "Text parts shorter than this (characters) stay untouched. Min 100, max 10000. Default: 500.",
                    ),
            })
            .default({ enabled: false, min_chars: 500 })
            .describe(
                "Age-tier caveman compression for long user/assistant text parts. Active for primary sessions when enabled; never for subagents. Oldest 20% of eligible tags (outside protected tail) go to ultra, next 20% to full, next 20% to lite, newest 40% untouched. Graduated from experimental.caveman_text_compression; opt-in, default off (lossy).",
            ),
        memory: z
            .object({
                enabled: z
                    .boolean()
                    .default(true)
                    .describe("Enable cross-session memory (default: true)"),
                injection_budget_tokens: z
                    .number()
                    .min(500)
                    .max(20000)
                    .default(4000)
                    .describe(
                        "Token budget for memory injection on session start (min: 500, max: 20000, default: 4000)",
                    ),
                auto_promote: z
                    .boolean()
                    .default(true)
                    .describe(
                        "Automatically promote eligible session facts into memory (default: true)",
                    ),
                retrieval_count_promotion_threshold: z
                    .number()
                    .min(1)
                    .default(3)
                    .describe(
                        "retrieval_count threshold for promoting memory to permanent status (min: 1, default: 3)",
                    ),
                auto_search: z
                    .object({
                        enabled: z
                            .boolean()
                            .default(true)
                            .describe(
                                "Automatically append a compact <ctx-search-hint> to eligible user messages when relevant memories, conversation, or commits are found. Graduated from experimental.auto_search; on by default (set false to opt out). Independent of memory.enabled.",
                            ),
                        score_threshold: z
                            .number()
                            .min(0.3)
                            .max(0.95)
                            .default(0.6)
                            .describe(
                                "Top hit score must exceed this threshold for the hint to fire (min: 0.3, max: 0.95, default: 0.60)",
                            ),
                        min_prompt_chars: z
                            .number()
                            .min(5)
                            .max(500)
                            .default(20)
                            .describe(
                                "Skip hint when user message is shorter than this (min: 5, max: 500, default: 20)",
                            ),
                    })
                    .default({ enabled: true, score_threshold: 0.6, min_prompt_chars: 20 })
                    .describe(
                        "Auto-search hint: transform-time ctx_search on each new user message; when the top hit clears the threshold, append a compact <ctx-search-hint> block of vague fragments to that user message. Does NOT inject full content. Graduated from experimental.auto_search; enabled by default (set enabled: false to opt out). Independent of memory.enabled.",
                    ),
                git_commit_indexing: z
                    .object({
                        enabled: z
                            .boolean()
                            .default(false)
                            .describe(
                                "Index HEAD git commits for ctx_search (git_commit source). Graduated from experimental.git_commit_indexing; opt-in, default off. Independent of memory.enabled.",
                            ),
                        since_days: z
                            .number()
                            .min(7)
                            .max(3650)
                            .default(365)
                            .describe(
                                "Days of HEAD history to index (min: 7, max: 3650, default: 365)",
                            ),
                        max_commits: z
                            .number()
                            .min(100)
                            .max(20000)
                            .default(2000)
                            .describe(
                                "Max commits kept per project; oldest evicted (min: 100, max: 20000, default: 2000)",
                            ),
                    })
                    .default({ enabled: false, since_days: 365, max_commits: 2000 })
                    .describe(
                        "Index git commit messages from HEAD into ctx_search. Commits become a 4th searchable source alongside memories and session history. Graduated from experimental.git_commit_indexing; opt-in, default off (per-project embedding cost). Independent of memory.enabled.",
                    ),
            })
            .default({
                enabled: true,
                injection_budget_tokens: 4000,
                auto_promote: true,
                retrieval_count_promotion_threshold: 3,
                auto_search: { enabled: true, score_threshold: 0.6, min_prompt_chars: 20 },
                git_commit_indexing: { enabled: false, since_days: 365, max_commits: 2000 },
            })
            .describe("Cross-session memory configuration"),
        sidekick: SidekickConfigSchema.describe(
            "Optional sidekick agent configuration for session-start memory retrieval",
        ),
    })
    .transform((data): MagicContextConfig => {
        return {
            ...data,
            protected_tags: data.protected_tags ?? DEFAULT_PROTECTED_TAGS,
        };
    });
