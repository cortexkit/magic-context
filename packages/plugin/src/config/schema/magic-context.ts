import { z } from "zod";

import { DEFAULT_PROTECTED_TAGS } from "../../features/magic-context/defaults";
import { AgentOverrideConfigSchema } from "./agent-overrides";

export const DEFAULT_NUDGE_INTERVAL_TOKENS = 10_000;
export const DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE = 65;
export const DEFAULT_COMPARTMENT_TOKEN_BUDGET = 20_000;
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
    }),
);
export type DreamerConfig = z.infer<typeof DreamerConfigSchema>;

export const SidekickConfigSchema = AgentOverrideConfigSchema.extend({
    enabled: z.boolean().default(false),
    timeout_ms: z.number().default(30000),
    system_prompt: z.string().optional(),
}).optional();
export type SidekickConfig = NonNullable<z.infer<typeof SidekickConfigSchema>>;

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
    /** When false, ctx_reduce tool is not registered, all nudges are disabled,
     *  and prompt guidance about ctx_reduce is stripped. Heuristic cleanup,
     *  compartments, memory, and other features continue to work. Default: true. */
    ctx_reduce_enabled: boolean;
    historian?: z.infer<typeof AgentOverrideConfigSchema>;
    dreamer?: DreamerConfig;
    cache_ttl: string | { default: string; [modelKey: string]: string };
    nudge_interval_tokens: number;
    execute_threshold_percentage: number | { default: number; [modelKey: string]: number };
    protected_tags: number;
    auto_drop_tool_age: number;
    clear_reasoning_age: number;
    iteration_nudge_threshold: number;
    compartment_token_budget: number;
    history_budget_percentage: number;
    historian_timeout_ms: number;
    commit_cluster_trigger: {
        enabled: boolean;
        min_clusters: number;
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
        /** Enable magic context (default: false) */
        enabled: z.boolean().default(false),
        /** When false, ctx_reduce tool is hidden, all nudges disabled, and prompt
         *  guidance about ctx_reduce stripped. Heuristic cleanup, compartments,
         *  memory, and other features still work. (default: true) */
        ctx_reduce_enabled: z.boolean().default(true),
        /** Historian agent configuration (model, fallback_models, variant, temperature, maxTokens, permission, etc.) */
        historian: AgentOverrideConfigSchema.optional(),
        /** Dreamer agent + scheduling configuration (model, fallback_models, enabled, schedule, tasks, etc.) */
        dreamer: DreamerConfigSchema.optional(),
        /** Cache TTL: string (e.g. "5m") or per-model object ({ default: "5m", "model-id": "10m" }) */
        cache_ttl: z
            .union([z.string(), z.object({ default: z.string() }).catchall(z.string())])
            .default("5m"),
        /** Minimum token growth between low-priority rolling nudges (default: DEFAULT_NUDGE_INTERVAL_TOKENS) */
        nudge_interval_tokens: z.number().min(1000).default(DEFAULT_NUDGE_INTERVAL_TOKENS),
        /** Context percentage that forces queued operations to execute. Number or per-model object ({ default: 65, "provider/model": 45 }). Default: DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE */
        execute_threshold_percentage: z
            .union([
                z.number().min(35).max(95),
                z
                    .object({ default: z.number().min(35).max(95) })
                    .catchall(z.number().min(35).max(95)),
            ])
            .default(DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE),
        /** Number of recent tags to protect from dropping (min: 1, max: 100, default: 20) */
        protected_tags: z.number().min(1).max(100).optional(),
        /** Auto-drop tool outputs older than N tags during queue execution (default: 100) */
        auto_drop_tool_age: z.number().min(10).default(100),
        /** Clear reasoning/thinking blocks older than N tags (default: 50) */
        clear_reasoning_age: z.number().min(10).default(50),
        /** Number of consecutive assistant messages without user input to trigger iteration nudge (default: 15) */
        iteration_nudge_threshold: z.number().min(5).default(15),
        /** Token budget for compartment agent when summarizing history (default: 20000) */
        compartment_token_budget: z.number().min(10000).default(DEFAULT_COMPARTMENT_TOKEN_BUDGET),
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
        /** Embedding provider configuration */
        embedding: EmbeddingConfigSchema.default({
            provider: "local",
            model: DEFAULT_LOCAL_EMBEDDING_MODEL,
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
