import { z } from "zod";

import { DEFAULT_PROTECTED_TAGS } from "../../features/magic-context/defaults";
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

export const DREAMER_TASKS = [
    "consolidate",
    "verify",
    "archive-stale",
    "improve",
    "maintain-docs",
] as const;

export const DreamingTaskSchema = z.enum(DREAMER_TASKS);
export type DreamingTask = z.infer<typeof DreamingTaskSchema>;

export const DEFAULT_DREAMER_TASKS: DreamingTask[] = [
    "consolidate",
    "verify",
    "archive-stale",
    "improve",
];

/** Valid thinking levels for Pi subagents. Maps to Pi's --thinking CLI flag.
 *  Off: disable reasoning. Minimal/low/medium/high/xhigh: increasing reasoning depth.
 *  Pi-only — OpenCode uses `variant` in agent config instead. */
export const PiThinkingLevelSchema = z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh"])
    .optional();
export type PiThinkingLevel = z.infer<typeof PiThinkingLevelSchema>;

/** Combined dreamer agent + scheduling configuration */
export const DreamerConfigSchema = AgentOverrideConfigSchema.merge(
    z.object({
        schedule: z
            .string()
            .default("02:00-06:00")
            .describe("Scheduled window for overnight dreaming (e.g. '02:00-06:00')"),
        max_runtime_minutes: z
            .number()
            .min(10)
            .default(120)
            .describe("Maximum runtime per dream session in minutes"),
        tasks: z
            .array(DreamingTaskSchema)
            .default(DEFAULT_DREAMER_TASKS)
            .describe("Tasks to run during dreaming, in order"),
        task_timeout_minutes: z
            .number()
            .min(5)
            .default(20)
            .describe("Minutes allocated per task before moving to next"),
        inject_docs: z
            .boolean()
            .default(true)
            .describe("Inject ARCHITECTURE.md and STRUCTURE.md into system prompt"),
        user_memories: z
            .object({
                enabled: z
                    .boolean()
                    .default(true)
                    .describe("Enable user memory extraction and promotion (default: true)"),
                promotion_threshold: z
                    .number()
                    .min(2)
                    .max(20)
                    .default(3)
                    .describe(
                        "Minimum candidate observations before dreamer considers promotion (default: 3)",
                    ),
            })
            .default({ enabled: true, promotion_threshold: 3 })
            .describe(
                "User memory pipeline: historian extracts behavior observations from each compartment run; dreamer reviews recurring patterns and promotes them to stable user memories injected into all sessions as <user-profile>. Requires dreamer to not be disabled for promotion to actually happen. Graduated from experimental in v0.14. Default: enabled.",
            ),
        pin_key_files: z
            .object({
                enabled: z
                    .boolean()
                    .default(false)
                    .describe("Enable key file pinning (default: false)"),
                token_budget: z
                    .number()
                    .min(2000)
                    .max(30000)
                    .default(10000)
                    .describe(
                        "Total token budget for all pinned key files (min: 2000, max: 30000, default: 10000)",
                    ),
                min_reads: z
                    .number()
                    .min(2)
                    .max(20)
                    .default(4)
                    .describe(
                        "Minimum full-read count before a file is considered for pinning (min: 2, default: 4)",
                    ),
            })
            .default({ enabled: false, token_budget: 10000, min_reads: 4 })
            .describe(
                "Pin frequently-read key files into the system prompt so the agent doesn't need to re-read them after context drops. Dreamer identifies key files per session based on read patterns. Requires dreamer to not be disabled for selection to happen. Graduated from experimental in v0.14. Default: disabled.",
            ),
        thinking_level: PiThinkingLevelSchema.describe(
            "Pi only: explicit thinking level for dreamer subagent invocations. See historian.thinking_level.",
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

const BaseEmbeddingConfigSchema = z
    .object({
        provider: z
            .enum(["local", "openai-compatible", "off"])
            .default("local")
            .describe(
                "Embedding provider. 'local' uses Xenova/all-MiniLM-L6-v2, 'openai-compatible' requires endpoint and model, 'off' disables embeddings.",
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
        if (data.provider === "openai-compatible" && !data.endpoint?.trim()) {
            ctx.addIssue({
                code: "custom",
                path: ["endpoint"],
                message: "endpoint is required when embedding.provider is openai-compatible",
            });
        }

        if (data.provider === "openai-compatible" && !data.model?.trim()) {
            ctx.addIssue({
                code: "custom",
                path: ["model"],
                message: "model is required when embedding.provider is openai-compatible",
            });
        }
    });

export const EmbeddingConfigSchema = BaseEmbeddingConfigSchema.transform((data) => {
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

export interface MagicContextConfig {
    enabled: boolean;
    /** Auto-update the cached OpenCode plugin wrapper when a newer npm version is available.
     *  USER config only; project configs cannot disable it. Default: true. */
    auto_update?: boolean;
    /** When false, ctx_reduce tool is not registered, all nudges are disabled,
     *  and prompt guidance about ctx_reduce is stripped. Heuristic cleanup,
     *  compartments, memory, and other features continue to work. Default: true. */
    ctx_reduce_enabled: boolean;
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
     * `<key-files>`, sticky date) inside `experimental.chat.system.transform`.
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
    /**
     * Age-tier caveman compression for long user/assistant text parts.
     * Graduated from `experimental.caveman_text_compression`; opt-in, default off.
     *
     * Only active when `ctx_reduce_enabled: false`. Buckets eligible
     * (outside-protected-tail) messages into four age tiers by tag
     * position — oldest 20% → ultra, next 20% → full, next 20% → lite,
     * newest 40% → untouched — and rewrites the text part in place.
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
    sidekick?: SidekickConfig;
}

export const MagicContextConfigSchema = z
    .object({
        enabled: z.boolean().default(true).describe("Enable magic context (default: true)"),
        auto_update: z
            .boolean()
            .optional()
            .describe(
                "Enable automatic npm self-update checks for the OpenCode plugin. Security: USER-only in config loader, so hostile project configs cannot suppress updates.",
            ),
        ctx_reduce_enabled: z
            .boolean()
            .default(true)
            .describe(
                "When false, ctx_reduce tool is hidden, all nudges disabled, and prompt guidance about ctx_reduce stripped. Heuristic cleanup, compartments, memory, and other features still work. (default: true)",
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
            .min(1_000)
            .max(60_000)
            .default(5_000)
            .describe(
                "TUI toast lifetime in milliseconds for Magic Context notifications (min: 1000, max: 60000, default: 5000)",
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
                "Controls whether and where Magic Context augments the system prompt. Lets users opt specific agents out of the Magic Context guidance and the surrounding project-docs / user-profile / key-files blocks. OpenCode's internal hidden agents — title, summary, and compaction — are always skipped automatically.",
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
        temporal_awareness: z
            .boolean()
            .default(true)
            .describe(
                'Inject wall-clock gap markers (<!-- +Xm -->) between user messages where > 5 min elapsed since the previous message, and add start/end date attributes on compartments. Gives the agent a sense of session pacing and "how long ago" across multi-day sessions. Graduated from experimental.temporal_awareness; default: true (set false to opt out).',
            ),
        keep_subagents: z
            .boolean()
            .default(false)
            .describe(
                "Debug: keep the child sessions Magic Context spawns for its own subagents (historian, dreamer, sidekick, memory-migration) instead of deleting them on success. Useful for short-term inspection/data collection — their full transcript (prompt, tool calls, token usage, output) stays in the host session store. Kept sessions accumulate until manually cleared; leave false for normal use. Requires a restart to take effect.",
            ),
        caveman_text_compression: z
            .object({
                enabled: z
                    .boolean()
                    .default(false)
                    .describe(
                        "Apply deterministic caveman-style text compression to old conversation text. Only active when ctx_reduce_enabled=false. Compresses user/assistant text in oldest-first tiers: ultra (oldest 20%), full, lite, untouched (newest 40%).",
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
                "Age-tier caveman compression for long user/assistant text parts. Only active when ctx_reduce_enabled is false. Oldest 20% of eligible tags (outside protected tail) go to ultra, next 20% to full, next 20% to lite, newest 40% untouched. Graduated from experimental.caveman_text_compression; opt-in, default off (lossy).",
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
