import { describe, expect, it } from "bun:test";
import {
    DEFAULT_HISTORIAN_TIMEOUT_MS,
    DEFAULT_HISTORY_BUDGET_PERCENTAGE,
    DEFAULT_LOCAL_EMBEDDING_MODEL,
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
                execute_threshold_percentage: 65,
                protected_tags: 20,
                clear_reasoning_age: 50,
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
                toast_duration_ms: 5000,
                cache_ttl: "10m",
                protected_tags: 3,
                execute_threshold_percentage: 75,
                clear_reasoning_age: 60,
                history_budget_percentage: 0.2,
                historian_timeout_ms: 360_000,
                commit_cluster_trigger: {
                    enabled: true,
                    min_clusters: 3,
                },
                sqlite: {
                    cache_size_mb: 64,
                    mmap_size_mb: 0,
                },
                system_prompt_injection: {
                    enabled: true,
                    skip_signatures: ["<!-- magic-context: skip -->"],
                },
                temporal_awareness: false,
                keep_subagents: false,
                caveman_text_compression: {
                    enabled: false,
                    min_chars: 500,
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
                    auto_search: {
                        enabled: false,
                        score_threshold: 0.6,
                        min_prompt_chars: 20,
                    },
                    git_commit_indexing: {
                        enabled: false,
                        since_days: 365,
                        max_commits: 2000,
                    },
                },
                sidekick: {
                    disable: false,
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
                model: "github-copilot/gpt-5.4",
                timeout_ms: 30000,
            });
        });

        it("accepts disable on hidden agents and strips deprecated top-level enabled", () => {
            const result = MagicContextConfigSchema.parse({
                historian: { disable: true },
                dreamer: {
                    disable: true,
                    enabled: true,
                    user_memories: { enabled: false },
                    pin_key_files: { enabled: true },
                },
                sidekick: { disable: true, enabled: true },
            });

            expect(result.historian?.disable).toBe(true);
            expect(result.dreamer?.disable).toBe(true);
            expect(result.sidekick?.disable).toBe(true);
            expect("enabled" in (result.dreamer as Record<string, unknown>)).toBe(false);
            expect("enabled" in (result.sidekick as Record<string, unknown>)).toBe(false);
            expect(result.dreamer?.user_memories.enabled).toBe(false);
            expect(result.dreamer?.pin_key_files.enabled).toBe(true);
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

        it("rejects clear_reasoning_age below minimum", () => {
            expect(() => MagicContextConfigSchema.parse({ clear_reasoning_age: 9 })).toThrow();
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
