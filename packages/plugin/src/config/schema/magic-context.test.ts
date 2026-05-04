import { describe, expect, it } from "bun:test";
import {
    DEFAULT_HISTORIAN_TIMEOUT_MS,
    DEFAULT_HISTORY_BUDGET_PERCENTAGE,
    DEFAULT_LOCAL_EMBEDDING_MODEL,
    DEFAULT_NUDGE_INTERVAL_TOKENS,
    type MagicContextConfig,
    MagicContextConfigSchema,
} from "./magic-context";

describe("MagicContextConfigSchema", () => {
    describe("defaults", () => {
        it("applies defaults for an empty config", () => {
            const result = MagicContextConfigSchema.parse({});

            expect(result).toMatchObject({
                enabled: true,
                cache_ttl: "5m",
                nudge_interval_tokens: DEFAULT_NUDGE_INTERVAL_TOKENS,
                execute_threshold_percentage: 65,
                protected_tags: 20,
                auto_drop_tool_age: 100,
                drop_tool_structure: true,
                clear_reasoning_age: 50,
                iteration_nudge_threshold: 15,
                history_budget_percentage: DEFAULT_HISTORY_BUDGET_PERCENTAGE,
                historian_timeout_ms: DEFAULT_HISTORIAN_TIMEOUT_MS,
                embedding: {
                    provider: "local",
                    model: DEFAULT_LOCAL_EMBEDDING_MODEL,
                },
                memory: {
                    enabled: true,
                    injection_budget_tokens: 4000,
                    auto_promote: true,
                    retrieval_count_promotion_threshold: 3,
                },
            });
            expect(result.historian).toBeUndefined();
            expect(result.dreamer).toBeUndefined();
            expect(result.sidekick).toBeUndefined();
        });
    });

    describe("valid config", () => {
        it("parses an enabled config without stale reduction-specific keys", () => {
            const input = {
                enabled: true,
                auto_update: false,
                ctx_reduce_enabled: true,
                cache_ttl: "10m",
                protected_tags: 3,
                nudge_interval_tokens: 15_000,
                execute_threshold_percentage: 75,
                auto_drop_tool_age: 150,
                drop_tool_structure: false,
                clear_reasoning_age: 60,
                iteration_nudge_threshold: 20,
                history_budget_percentage: 0.2,
                historian_timeout_ms: 360_000,
                commit_cluster_trigger: {
                    enabled: true,
                    min_clusters: 3,
                },
                compaction_markers: true,
                compressor: {
                    enabled: true,
                    min_compartment_ratio: 1000,
                    max_merge_depth: 5,
                    cooldown_ms: 600_000,
                    max_compartments_per_pass: 15,
                    grace_compartments: 10,
                },
                experimental: {
                    temporal_awareness: false,
                    git_commit_indexing: {
                        enabled: false,
                        since_days: 365,
                        max_commits: 2000,
                    },
                    auto_search: {
                        enabled: false,
                        score_threshold: 0.6,
                        min_prompt_chars: 20,
                    },
                    caveman_text_compression: {
                        enabled: false,
                        min_chars: 500,
                    },
                },
                embedding: {
                    provider: "openai-compatible",
                    endpoint: "http://localhost:1234/v1",
                    model: "text-embedding-3-small",
                    api_key: "secret-embedding",
                },
                memory: {
                    enabled: true,
                    injection_budget_tokens: 4000,
                    auto_promote: true,
                    retrieval_count_promotion_threshold: 3,
                },
                sidekick: {
                    enabled: true,
                    model: "qwen-test",
                    fallback_models: ["qwen-fallback"],
                    temperature: 0.1,
                    variant: "fast",
                    timeout_ms: 12_000,
                    system_prompt: "Custom prompt",
                },
            } satisfies MagicContextConfig;

            const result = MagicContextConfigSchema.parse(input);

            expect(result).toEqual(input);
        });

        it("applies sidekick defaults when the object is present", () => {
            const result = MagicContextConfigSchema.parse({
                sidekick: {
                    model: "github-copilot/gpt-5.4",
                },
            });

            expect(result.sidekick).toEqual({
                enabled: false,
                model: "github-copilot/gpt-5.4",
                timeout_ms: 30000,
            });
        });

        it("accepts optional auto_update user preference", () => {
            expect(MagicContextConfigSchema.parse({ auto_update: false }).auto_update).toBe(false);
            expect(MagicContextConfigSchema.parse({ auto_update: true }).auto_update).toBe(true);
        });

        it("parses per-model cache_ttl objects", () => {
            const input = {
                cache_ttl: {
                    default: "5m",
                    "claude-3-haiku": "10m",
                    "gpt-4": "2m",
                },
            };

            const result = MagicContextConfigSchema.parse(input);

            expect(result.cache_ttl).toEqual(input.cache_ttl);
        });
    });

    describe("validation", () => {
        it("rejects protected_tags greater than 100", () => {
            expect(() => MagicContextConfigSchema.parse({ protected_tags: 101 })).toThrow();
        });

        it("rejects protected_tags less than 1", () => {
            expect(() => MagicContextConfigSchema.parse({ protected_tags: 0 })).toThrow();
        });

        it("accepts protected_tags boundary values", () => {
            expect(MagicContextConfigSchema.parse({ protected_tags: 1 }).protected_tags).toBe(1);
            expect(MagicContextConfigSchema.parse({ protected_tags: 20 }).protected_tags).toBe(20);
        });

        it("rejects nudge_interval_tokens below minimum", () => {
            expect(() => MagicContextConfigSchema.parse({ nudge_interval_tokens: 999 })).toThrow();
        });

        it("accepts nudge_interval_tokens at minimum", () => {
            expect(
                MagicContextConfigSchema.parse({ nudge_interval_tokens: 1000 })
                    .nudge_interval_tokens,
            ).toBe(1000);
        });

        it("rejects auto_drop_tool_age below minimum", () => {
            expect(() => MagicContextConfigSchema.parse({ auto_drop_tool_age: 9 })).toThrow();
        });

        it("rejects clear_reasoning_age below minimum", () => {
            expect(() => MagicContextConfigSchema.parse({ clear_reasoning_age: 9 })).toThrow();
        });

        it("rejects iteration_nudge_threshold below minimum", () => {
            expect(() =>
                MagicContextConfigSchema.parse({ iteration_nudge_threshold: 4 }),
            ).toThrow();
        });

        it("rejects historian_timeout_ms below minimum", () => {
            expect(() =>
                MagicContextConfigSchema.parse({ historian_timeout_ms: 59_999 }),
            ).toThrow();
        });

        it("rejects openai-compatible embedding config without endpoint", () => {
            expect(() =>
                MagicContextConfigSchema.parse({
                    embedding: {
                        provider: "openai-compatible",
                        model: "text-embedding-3-small",
                    },
                }),
            ).toThrow();
        });

        it("rejects openai-compatible embedding config without model", () => {
            expect(() =>
                MagicContextConfigSchema.parse({
                    embedding: {
                        provider: "openai-compatible",
                        endpoint: "http://localhost:1234/v1",
                    },
                }),
            ).toThrow();
        });
    });
});
