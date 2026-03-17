import { z } from "zod";

export const DEFAULT_NUDGE_INTERVAL_TOKENS = 10_000;
export const DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE = 65;
export const DEFAULT_COMPARTMENT_TOKEN_BUDGET = 20_000;
export const DEFAULT_HISTORIAN_TIMEOUT_MS = 300_000;

export const MagicContextConfigSchema = z
    .object({
        /** Enable magic context (default: false) */
        enabled: z.boolean().default(false),
        /** Configure historian via agents.historian.* (model, fallback_models, variant, temperature, maxTokens, permission, etc.) */
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
        /** Number of recent tags to protect from dropping (min: 1, max: 20, default: 5) */
        protected_tags: z.number().min(1).max(20).optional(),
        /** Auto-drop tool outputs older than N tags during queue execution (default: 100) */
        auto_drop_tool_age: z.number().min(10).default(100),
        /** Clear reasoning/thinking blocks older than N tags (default: 50) */
        clear_reasoning_age: z.number().min(10).default(50),
        /** Number of consecutive assistant messages without user input to trigger iteration nudge (default: 15) */
        iteration_nudge_threshold: z.number().min(5).default(15),
        /** Token budget for compartment agent when summarizing history (default: 20000) */
        compartment_token_budget: z.number().min(10000).default(DEFAULT_COMPARTMENT_TOKEN_BUDGET),
        /** Timeout for each historian prompt call in milliseconds (default: 300000) */
        historian_timeout_ms: z.number().min(60_000).default(DEFAULT_HISTORIAN_TIMEOUT_MS),
        /** Cross-session memory configuration */
        memory: z
            .object({
                /** Enable cross-session memory (default: true) */
                enabled: z.boolean().default(true),
                /** Token budget for memory injection on session start (min: 500, max: 20000, default: 4000) */
                injection_budget_tokens: z.number().min(500).max(20000).default(4000),
                /** Embedding provider for memory retrieval (default: transformers) */
                embedding_provider: z.enum(["transformers", "off"]).default("transformers"),
                /** Automatically promote eligible session facts into memory (default: true) */
                auto_promote: z.boolean().default(true),
                /** retrieval_count threshold for promoting memory to permanent status (min: 1, default: 3) */
                retrieval_count_promotion_threshold: z.number().min(1).default(3),
            })
            .default({
                enabled: true,
                injection_budget_tokens: 4000,
                embedding_provider: "transformers",
                auto_promote: true,
                retrieval_count_promotion_threshold: 3,
            }),
    })
    .transform((data) => ({
        ...data,
        protected_tags: data.protected_tags ?? 5,
    }));

export type MagicContextConfig = z.infer<typeof MagicContextConfigSchema>;
