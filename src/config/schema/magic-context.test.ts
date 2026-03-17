import { describe, expect, it } from "bun:test";
import {
    DEFAULT_COMPARTMENT_TOKEN_BUDGET,
    DEFAULT_HISTORIAN_TIMEOUT_MS,
    DEFAULT_NUDGE_INTERVAL_TOKENS,
    MagicContextConfigSchema,
} from "./magic-context";

describe("MagicContextConfigSchema", () => {
    describe("defaults", () => {
        it("applies defaults for an empty config", () => {
            const result = MagicContextConfigSchema.parse({});

            expect(result).toEqual({
                enabled: false,
                cache_ttl: "5m",
                nudge_interval_tokens: DEFAULT_NUDGE_INTERVAL_TOKENS,
                execute_threshold_percentage: 65,
                protected_tags: 5,
                auto_drop_tool_age: 100,
                clear_reasoning_age: 50,
                iteration_nudge_threshold: 15,
                compartment_token_budget: DEFAULT_COMPARTMENT_TOKEN_BUDGET,
                historian_timeout_ms: DEFAULT_HISTORIAN_TIMEOUT_MS,
                memory: {
                    enabled: true,
                    injection_budget_tokens: 4000,
                    embedding_provider: "transformers",
                    auto_promote: true,
                    retrieval_count_promotion_threshold: 3,
                },
            });
        });
    });

    describe("valid config", () => {
        it("parses an enabled config without stale reduction-specific keys", () => {
            const input = {
                enabled: true,
                cache_ttl: "10m",
                protected_tags: 3,
                nudge_interval_tokens: 15_000,
                execute_threshold_percentage: 75,
                auto_drop_tool_age: 150,
                clear_reasoning_age: 60,
                iteration_nudge_threshold: 20,
                compartment_token_budget: 25_000,
                historian_timeout_ms: 360_000,
                memory: {
                    enabled: true,
                    injection_budget_tokens: 4000,
                    embedding_provider: "transformers",
                    auto_promote: true,
                    retrieval_count_promotion_threshold: 3,
                },
            };

            const result = MagicContextConfigSchema.parse(input);

            expect(result).toEqual(input);
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
        it("rejects protected_tags greater than 20", () => {
            expect(() => MagicContextConfigSchema.parse({ protected_tags: 21 })).toThrow();
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
    });
});
