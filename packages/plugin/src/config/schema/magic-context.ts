import { z } from "zod";

import { DEFAULT_PROTECTED_TAGS } from "../../features/magic-context/defaults";
import { AgentOverrideConfigSchema } from "./agent-overrides";

export const DEFAULT_NUDGE_INTERVAL_TOKENS = 10_000;
export const DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE = 65;
export const DEFAULT_HISTORIAN_TIMEOUT_MS = 300_000;
export const DEFAULT_HISTORY_BUDGET_PERCENTAGE = 0.15;
export const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
/** Compressor defaults — see CompressorConfigSchema below for details. */
export const DEFAULT_COMPRESSOR_MIN_COMPARTMENT_RATIO = 1000;
export const DEFAULT_COMPRESSOR_MAX_MERGE_DEPTH = 5;
export const DEFAULT_COMPRESSOR_COOLDOWN_MS = 600_000;
/** Max compartments merged in one LLM pass. LLM quality degrades with larger inputs,
 *  and smaller batches reduce ordinal-drift risk when the model outputs merged boundaries. */
export const DEFAULT_COMPRESSOR_MAX_COMPARTMENTS_PER_PASS = 15;
/** Number of newest compartments always excluded from compression.
 *  Protects freshly-published historian compartments from immediate re-compression,
 *  which would lose narrative quality before the agent has even used the compartment. */
export const DEFAULT_COMPRESSOR_GRACE_COMPARTMENTS = 10;
/** Output count at each depth = ceil(input / ratio).
 *  Lower ratios = gentler compression. Depth 5 is title-only (no LLM call). */
export const COMPRESSOR_MERGE_RATIO_BY_DEPTH: Record<number, number> = {
    1: 1.33, // 4:3 — merge only, preserve narrative + U: lines
    2: 1.5, // 3:2 — lite caveman
    3: 2.0, // 2:1 — full caveman
    4: 2.0, // 2:1 — ultra caveman (caveman post-process does heavy lifting)
    5: 0, // title-only collapse (no merge, no LLM)
};

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
        /** Enable scheduled dreaming (default: false) */
        enabled: z.boolean().default(false),
        /** Scheduled window for overnight dreaming (e.g. "02:00-06:00") */
        schedule: z.string().default("02:00-06:00"),
        /** Maximum runtime per dream session in minutes (default: 120) */
        max_runtime_minutes: z.number().min(10).default(120),
        /** Tasks to run during dreaming, in order */
        tasks: z.array(DreamingTaskSchema).default(DEFAULT_DREAMER_TASKS),
        /** Minutes allocated per task before moving to next (default: 20) */
        task_timeout_minutes: z.number().min(5).default(20),
        /** Inject ARCHITECTURE.md and STRUCTURE.md into system prompt (default: true) */
        inject_docs: z.boolean().default(true),
        /** User memory pipeline: historian extracts behavior observations from each
         *  compartment run; dreamer reviews recurring patterns and promotes them to
         *  stable user memories injected into all sessions as `<user-profile>`.
         *  Requires dreamer to be enabled for promotion to actually happen.
         *  Graduated from experimental in v0.14. Default: enabled. */
        user_memories: z
            .object({
                /** Enable user memory extraction and promotion (default: true) */
                enabled: z.boolean().default(true),
                /** Minimum candidate observations before dreamer considers promotion (default: 3) */
                promotion_threshold: z.number().min(2).max(20).default(3),
            })
            .default({ enabled: true, promotion_threshold: 3 }),
        /** Pin frequently-read key files into the system prompt so the agent
         *  doesn't need to re-read them after context drops. Dreamer identifies
         *  key files per session based on read patterns. Requires dreamer to be
         *  enabled for selection to happen. Graduated from experimental in v0.14.
         *  Default: disabled. */
        pin_key_files: z
            .object({
                /** Enable key file pinning (default: false) */
                enabled: z.boolean().default(false),
                /** Total token budget for all pinned key files (min: 2000, max: 30000, default: 10000) */
                token_budget: z.number().min(2000).max(30000).default(10000),
                /** Minimum full-read count before a file is considered for pinning (min: 2, default: 4) */
                min_reads: z.number().min(2).max(20).default(4),
            })
            .default({ enabled: false, token_budget: 10000, min_reads: 4 }),
        /** Pi only: explicit thinking level for dreamer subagent tasks. See HistorianConfigSchema. */
        thinking_level: PiThinkingLevelSchema,
    }),
);
export type DreamerConfig = z.infer<typeof DreamerConfigSchema>;

export const SidekickConfigSchema = AgentOverrideConfigSchema.extend({
    enabled: z.boolean().default(false),
    timeout_ms: z.number().default(30000),
    system_prompt: z.string().optional(),
    /** Pi only: explicit thinking level for sidekick subagent. See HistorianConfigSchema. */
    thinking_level: PiThinkingLevelSchema,
}).optional();
export type SidekickConfig = NonNullable<z.infer<typeof SidekickConfigSchema>>;

/** Historian agent configuration — includes all agent overrides plus two_pass mode.
 *  Two-pass mode runs a second editor pass after the initial historian pass to clean
 *  up low-signal U: lines and cross-compartment duplicates. Recommended for models
 *  without extended thinking; not needed for Claude Sonnet/Opus when reasoning is
 *  enabled via OpenCode variant config. */
export const HistorianConfigSchema = AgentOverrideConfigSchema.extend({
    /** Run a second editor pass over historian output to clean low-signal U: lines
     *  and cross-compartment duplicates. Adds ~1 extra API call and ~1.3x cost per
     *  historian run. Useful for models without extended thinking support. (default: false) */
    two_pass: z.boolean().default(false),
    /** Pi only: explicit thinking level passed as --thinking <level> to Pi subagent
     *  invocations. Required when using reasoning models (e.g. github-copilot/gpt-5.4)
     *  because Pi's default thinking-level resolution can pick a value the provider
     *  rejects. OpenCode users set `variant` instead.
     *  Valid: off | minimal | low | medium | high | xhigh */
    thinking_level: PiThinkingLevelSchema,
}).optional();
export type HistorianConfig = NonNullable<z.infer<typeof HistorianConfigSchema>>;

const BaseEmbeddingConfigSchema = z
    .object({
        provider: z.enum(["local", "openai-compatible", "off"]).default("local"),
        model: z.string().optional(),
        endpoint: z.string().optional(),
        api_key: z.string().optional(),
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
        };
    }

    if (data.provider === "openai-compatible") {
        const apiKey = data.api_key?.trim();
        return {
            provider: "openai-compatible" as const,
            model: data.model?.trim() ?? "",
            endpoint: data.endpoint?.trim() ?? "",
            ...(apiKey ? { api_key: apiKey } : {}),
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
    nudge_interval_tokens: number;
    execute_threshold_percentage: number | { default: number; [modelKey: string]: number };
    /** Absolute token thresholds per model. When set for a given model (or via `default`),
     *  this overrides `execute_threshold_percentage` for that model. Useful for hard caps
     *  matching provider input limits. Values above 80% × context_limit are clamped with a warning. */
    execute_threshold_tokens?: { default?: number; [modelKey: string]: number | undefined };
    protected_tags: number;
    auto_drop_tool_age: number;
    drop_tool_structure: boolean;
    clear_reasoning_age: number;
    iteration_nudge_threshold: number;
    history_budget_percentage: number;
    historian_timeout_ms: number;
    commit_cluster_trigger: {
        enabled: boolean;
        min_clusters: number;
    };
    compaction_markers: boolean;
    compressor: {
        enabled: boolean;
        min_compartment_ratio: number;
        max_merge_depth: number;
        cooldown_ms: number;
        max_compartments_per_pass: number;
        grace_compartments: number;
    };
    experimental: {
        /** Inject elapsed-time markers between user messages and date ranges on
         *  compartments so the agent has a wall-clock sense of the session. */
        temporal_awareness: boolean;
        /** Index git commit messages from HEAD into a new ctx_search source so
         *  agents can recall recent regressions, fixes, and decisions from
         *  commit history without running git log manually. */
        git_commit_indexing: {
            enabled: boolean;
            /** Days of history to index (default: 365) */
            since_days: number;
            /** Max commits kept per project; oldest evicted (default: 2000) */
            max_commits: number;
        };
        /** Appends a compact hint to new user messages when ctx_search finds
         *  highly-related memories, facts, or git commits. Does NOT inject
         *  full content — just vague fragments that nudge the agent to run
         *  ctx_search for full context if relevant. */
        auto_search: {
            enabled: boolean;
            /** Top hit score must exceed this threshold for the hint to fire. */
            score_threshold: number;
            /** Minimum user message length in characters (skip short prompts). */
            min_prompt_chars: number;
        };
        /**
         * Age-tier caveman compression for long user/assistant text parts.
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
    };
    embedding: EmbeddingConfig;
    memory: {
        enabled: boolean;
        injection_budget_tokens: number;
        auto_promote: boolean;
        retrieval_count_promotion_threshold: number;
    };
    sidekick?: SidekickConfig;
}

export const MagicContextConfigSchema = z
    .object({
        /** Enable magic context (default: true) */
        enabled: z.boolean().default(true),
        /** Enable automatic npm self-update checks for the OpenCode plugin.
         *  Security: USER-only in config loader, so hostile project configs cannot suppress updates. */
        auto_update: z.boolean().optional(),
        /** When false, ctx_reduce tool is hidden, all nudges disabled, and prompt
         *  guidance about ctx_reduce stripped. Heuristic cleanup, compartments,
         *  memory, and other features still work. (default: true) */
        ctx_reduce_enabled: z.boolean().default(true),
        /** Historian agent configuration (model, fallback_models, variant, temperature, maxTokens, permission, two_pass, etc.) */
        historian: HistorianConfigSchema,
        /** Dreamer agent + scheduling configuration (model, fallback_models, enabled, schedule, tasks, etc.) */
        dreamer: DreamerConfigSchema.optional(),
        /** Cache TTL: string (e.g. "5m") or per-model object ({ default: "5m", "model-id": "10m" }) */
        cache_ttl: z
            .union([z.string(), z.object({ default: z.string() }).catchall(z.string())])
            .default("5m"),
        /** Minimum token growth between low-priority rolling nudges (default: DEFAULT_NUDGE_INTERVAL_TOKENS) */
        nudge_interval_tokens: z.number().min(1000).default(DEFAULT_NUDGE_INTERVAL_TOKENS),
        /** Context percentage that forces queued operations to execute. Number or per-model object ({ default: 65, "provider/model": 45 }). Values above 80 are rejected because the runtime caps at 80% for cache safety (MAX_EXECUTE_THRESHOLD). Default: DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE */
        execute_threshold_percentage: z
            .union([
                z.number().min(20).max(80),
                z
                    .object({ default: z.number().min(20).max(80) })
                    .catchall(z.number().min(20).max(80)),
            ])
            .default(DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE),
        /** Absolute token thresholds per model. When matched, overrides execute_threshold_percentage
         *  for that model. Accepts `default` for all models or per-model keys. Values above
         *  80% × context_limit are clamped with a warning log. Min 5_000, max 2_000_000. */
        execute_threshold_tokens: z
            .object({
                default: z.number().min(5_000).max(2_000_000).optional(),
            })
            .catchall(z.number().min(5_000).max(2_000_000))
            .optional(),
        /** Number of recent tags to protect from dropping (min: 1, max: 100, default: 20) */
        protected_tags: z.number().min(1).max(100).optional(),
        /** Auto-drop tool outputs older than N tags during queue execution (default: 100) */
        auto_drop_tool_age: z.number().min(10).default(100),
        /** When true, dropped tool parts are fully removed instead of truncated in place (default: true) */
        drop_tool_structure: z.boolean().default(true),
        /** Clear reasoning/thinking blocks older than N tags (default: 50) */
        clear_reasoning_age: z.number().min(10).default(50),
        /** Number of consecutive assistant messages without user input to trigger iteration nudge (default: 15) */
        iteration_nudge_threshold: z.number().min(5).default(15),
        /** Fraction of usable context (context_limit × execute_threshold) reserved for the session history block (default: 0.15) */
        history_budget_percentage: z
            .number()
            .min(0.05)
            .max(0.5)
            .default(DEFAULT_HISTORY_BUDGET_PERCENTAGE),
        /** Timeout for each historian prompt call in milliseconds (default: 300000) */
        historian_timeout_ms: z.number().min(60_000).default(DEFAULT_HISTORIAN_TIMEOUT_MS),
        /** Commit-cluster trigger: fire historian when enough commit clusters accumulate in the unsummarized tail */
        commit_cluster_trigger: z
            .object({
                /** Enable commit-cluster based historian triggering (default: true) */
                enabled: z.boolean().default(true),
                /** Minimum commit clusters required to trigger historian (min: 1, default: 3) */
                min_clusters: z.number().min(1).default(3),
            })
            .default({ enabled: true, min_clusters: 3 }),
        /** Inject compaction markers into OpenCode's DB so transform receives only the live tail.
         *  After historian publishes compartments, a compaction boundary is written into
         *  OpenCode's message/part tables so older messages are skipped at load time. Default: true. */
        compaction_markers: z.boolean().default(true),
        /** Compressor configuration — controls second-pass compression of older
         *  compartments when the rendered history block exceeds its budget.
         *  The compressor merges adjacent compartments and applies progressively
         *  aggressive caveman-style compression at deeper depths. */
        compressor: z
            .object({
                /** Enable background compressor. When false, history block compression
                 *  never runs, so very old sessions may carry a larger history footprint.
                 *  (default: true) */
                enabled: z.boolean().default(true),
                /** Floor = ceil(total_raw_messages / min_compartment_ratio).
                 *  Compressor will never reduce session compartment count below this
                 *  floor. Lower ratio = more compartments preserved. Prevents runaway
                 *  merging into a single mega-compartment. (min: 100, max: 10000, default: 1000) */
                min_compartment_ratio: z
                    .number()
                    .min(100)
                    .max(10000)
                    .default(DEFAULT_COMPRESSOR_MIN_COMPARTMENT_RATIO),
                /** Maximum compression depth for any compartment range. At depth 5,
                 *  compartments are collapsed to title-only (content recoverable via
                 *  ctx_expand). Depths 1-4 apply caveman-lite/full/ultra compression.
                 *  (min: 1, max: 5, default: 5) */
                max_merge_depth: z
                    .number()
                    .min(1)
                    .max(5)
                    .default(DEFAULT_COMPRESSOR_MAX_MERGE_DEPTH),
                /** Minimum milliseconds between background compressor runs for a session.
                 *  (min: 60000, default: 600000 = 10 min) */
                cooldown_ms: z.number().min(60_000).default(DEFAULT_COMPRESSOR_COOLDOWN_MS),
                /** Max compartments the compressor will send to one LLM call in a single pass.
                 *  Keeping this low avoids LLM ordinal drift and dedup mistakes on large inputs.
                 *  (min: 3, max: 50, default: 15) */
                max_compartments_per_pass: z
                    .number()
                    .min(3)
                    .max(50)
                    .default(DEFAULT_COMPRESSOR_MAX_COMPARTMENTS_PER_PASS),
                /** Number of newest compartments always excluded from compression.
                 *  Protects freshly published historian output from being re-compressed before it
                 *  has been used. (min: 0, max: 100, default: 10) */
                grace_compartments: z
                    .number()
                    .min(0)
                    .max(100)
                    .default(DEFAULT_COMPRESSOR_GRACE_COMPARTMENTS),
            })
            .default({
                enabled: true,
                min_compartment_ratio: DEFAULT_COMPRESSOR_MIN_COMPARTMENT_RATIO,
                max_merge_depth: DEFAULT_COMPRESSOR_MAX_MERGE_DEPTH,
                cooldown_ms: DEFAULT_COMPRESSOR_COOLDOWN_MS,
                max_compartments_per_pass: DEFAULT_COMPRESSOR_MAX_COMPARTMENTS_PER_PASS,
                grace_compartments: DEFAULT_COMPRESSOR_GRACE_COMPARTMENTS,
            }),
        /** Embedding provider configuration */
        embedding: EmbeddingConfigSchema.default({
            provider: "local",
            model: DEFAULT_LOCAL_EMBEDDING_MODEL,
        }),
        /** Experimental features — gated behind flags, may change between releases.
         *  Note: user_memories and pin_key_files graduated to top-level `dreamer.*` in v0.14. */
        experimental: z
            .object({
                /** Inject wall-clock gap markers (<!-- +Xm -->) between user messages
                 *  where > 5 min elapsed since the previous message, and add start/end
                 *  date attributes on compartments. Gives the agent a sense of session
                 *  pacing and "how long ago" across multi-day sessions. Default: false. */
                temporal_awareness: z.boolean().default(false),
                /** Index git commit messages from HEAD into ctx_search. Commits
                 *  become a 4th searchable source alongside memories, facts, and
                 *  session history. Default: false. */
                git_commit_indexing: z
                    .object({
                        enabled: z.boolean().default(false),
                        /** Days of HEAD history to index (min: 7, max: 3650, default: 365) */
                        since_days: z.number().min(7).max(3650).default(365),
                        /** Max commits kept per project; oldest evicted (min: 100, max: 20000, default: 2000) */
                        max_commits: z.number().min(100).max(20000).default(2000),
                    })
                    .default({ enabled: false, since_days: 365, max_commits: 2000 }),
                /** Auto-search hint: transform-time ctx_search on each new user
                 *  message; when top hit clears the threshold, append a compact
                 *  <ctx-search-hint> block of vague fragments to that user message.
                 *  Does NOT inject full content. Default: false. */
                auto_search: z
                    .object({
                        enabled: z.boolean().default(false),
                        /** Top hit score must exceed this threshold for the hint to fire (min: 0.3, max: 0.95, default: 0.60) */
                        score_threshold: z.number().min(0.3).max(0.95).default(0.6),
                        /** Skip hint when user message is shorter than this (min: 5, max: 500, default: 20) */
                        min_prompt_chars: z.number().min(5).max(500).default(20),
                    })
                    .default({ enabled: false, score_threshold: 0.6, min_prompt_chars: 20 }),
                /** Age-tier caveman compression for long user/assistant text
                 *  parts. Only active when ctx_reduce_enabled is false.
                 *  Oldest 20% of eligible tags (outside protected tail) go to
                 *  ultra, next 20% to full, next 20% to lite, newest 40%
                 *  untouched. Default: disabled. */
                caveman_text_compression: z
                    .object({
                        enabled: z.boolean().default(false),
                        /** Text parts shorter than this (characters) stay untouched.
                         *  Min 100, max 10000. Default: 500. */
                        min_chars: z.number().min(100).max(10000).default(500),
                    })
                    .default({ enabled: false, min_chars: 500 }),
            })
            .default({
                temporal_awareness: false,
                git_commit_indexing: { enabled: false, since_days: 365, max_commits: 2000 },
                auto_search: { enabled: false, score_threshold: 0.6, min_prompt_chars: 20 },
                caveman_text_compression: { enabled: false, min_chars: 500 },
            }),
        /** Cross-session memory configuration */
        memory: z
            .object({
                /** Enable cross-session memory (default: true) */
                enabled: z.boolean().default(true),
                /** Token budget for memory injection on session start (min: 500, max: 20000, default: 4000) */
                injection_budget_tokens: z.number().min(500).max(20000).default(4000),
                /** Automatically promote eligible session facts into memory (default: true) */
                auto_promote: z.boolean().default(true),
                /** retrieval_count threshold for promoting memory to permanent status (min: 1, default: 3) */
                retrieval_count_promotion_threshold: z.number().min(1).default(3),
            })
            .default({
                enabled: true,
                injection_budget_tokens: 4000,
                auto_promote: true,
                retrieval_count_promotion_threshold: 3,
            }),
        /** Optional sidekick agent configuration for session-start memory retrieval */
        sidekick: SidekickConfigSchema,
    })
    .transform((data): MagicContextConfig => {
        return {
            ...data,
            protected_tags: data.protected_tags ?? DEFAULT_PROTECTED_TAGS,
        };
    });
