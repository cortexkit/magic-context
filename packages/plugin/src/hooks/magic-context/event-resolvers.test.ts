import { describe, expect, it } from "bun:test";
import {
    resolveCacheTtl,
    resolveContextLimit,
    resolveExecuteThreshold,
    resolveExecuteThresholdDetail,
    resolveModelKey,
    resolveSessionId,
} from "./event-resolvers";

describe("event-resolvers", () => {
    describe("resolveContextLimit", () => {
        // resolveContextLimit reads from getModelsDevContextLimit (which overlays
        // opencode.json custom provider limits on top of the models.dev cache).
        // The tests below validate the fallback-to-default path. The models.dev
        // integration is covered by models-dev-cache tests.

        it("resolves anthropic context from models.dev when available", () => {
            //#when — models.dev may return 200K (real limit) or 128K (default if no models.json)
            const limit = resolveContextLimit("anthropic", "claude-opus-4-5");

            //#then — should NOT be 1M; uses models.dev real limit or conservative default
            expect(limit).toBeLessThanOrEqual(200_000);
            expect(limit).toBeGreaterThan(0);
        });

        it("returns default for missing provider", () => {
            //#when
            const limit = resolveContextLimit(undefined, "gpt-4o");

            //#then
            expect(limit).toBe(128_000);
        });

        it("returns default for unknown provider/model not in models.dev or opencode.json", () => {
            //#when
            const limit = resolveContextLimit("unknown-provider", "unknown-model-xyz");

            //#then
            expect(limit).toBe(128_000);
        });
    });

    describe("resolveCacheTtl", () => {
        it("returns direct string ttl for string config", () => {
            //#when
            const ttl = resolveCacheTtl("5m", "openai/gpt-4o");

            //#then
            expect(ttl).toBe("5m");
        });

        it("resolves provider/model and bare-model overrides", () => {
            //#given
            const cacheTtl = {
                default: "5m",
                "openai/gpt-4o": "1m",
                "gpt-4o-mini": "2m",
            };

            //#when
            const providerModel = resolveCacheTtl(cacheTtl, "openai/gpt-4o");
            const bareModel = resolveCacheTtl(cacheTtl, "openai/gpt-4o-mini");

            //#then
            expect(providerModel).toBe("1m");
            expect(bareModel).toBe("2m");
        });
    });

    describe("resolveExecuteThreshold", () => {
        it("returns direct number config unchanged (after max cap)", () => {
            expect(resolveExecuteThreshold(50, "openai/gpt-5.4-fast", 65)).toBe(50);
            expect(resolveExecuteThreshold(50, undefined, 65)).toBe(50);
        });

        it("caps any resolved value at 80%", () => {
            expect(resolveExecuteThreshold(95, "openai/gpt-4o", 65)).toBe(80);
            expect(
                resolveExecuteThreshold({ default: 95, "openai/gpt-4o": 90 }, "openai/gpt-4o", 65),
            ).toBe(80);
        });

        it("prefers exact provider/model key when present", () => {
            //#given — user wrote the derived key
            const config = { default: 65, "openai/gpt-5.4-fast": 25 };

            //#when
            const result = resolveExecuteThreshold(config, "openai/gpt-5.4-fast", 65);

            //#then
            expect(result).toBe(25);
        });

        it("falls back to base model key when user wrote base (no derived)", () => {
            //#given — user wrote base key, runtime is derived (e.g., -fast variant)
            const config = { default: 65, "openai/gpt-5.4": 25 };

            //#when — modelKey is the derived form
            const result = resolveExecuteThreshold(config, "openai/gpt-5.4-fast", 65);

            //#then — should match "openai/gpt-5.4" after suffix strip
            expect(result).toBe(25);
        });

        it("prefers most-specific match when both derived and base configured", () => {
            //#given — user wrote BOTH keys, want derived to win
            const config = {
                default: 65,
                "openai/gpt-5.4-fast": 20,
                "openai/gpt-5.4": 40,
            };

            //#when
            const derived = resolveExecuteThreshold(config, "openai/gpt-5.4-fast", 65);
            const base = resolveExecuteThreshold(config, "openai/gpt-5.4", 65);

            //#then
            expect(derived).toBe(20);
            expect(base).toBe(40);
        });

        it("matches bare model id (no provider prefix) in config", () => {
            //#given — user wrote just the model id without provider
            const config = { default: 65, "gpt-5.4-fast": 25 };

            //#when
            const result = resolveExecuteThreshold(config, "openai/gpt-5.4-fast", 65);

            //#then
            expect(result).toBe(25);
        });

        it("matches bare base model id for derived runtime model", () => {
            //#given
            const config = { default: 65, "gpt-5.4": 30 };

            //#when
            const result = resolveExecuteThreshold(config, "openai/gpt-5.4-fast", 65);

            //#then
            expect(result).toBe(30);
        });

        it("returns config.default when no keys match", () => {
            //#given
            const config = { default: 55, "anthropic/claude-opus-4-6": 40 };

            //#when
            const result = resolveExecuteThreshold(config, "openai/gpt-4o", 65);

            //#then
            expect(result).toBe(55);
        });

        it("returns fallback when config.default absent and no match", () => {
            //#given
            const config = { default: 0, "anthropic/claude-opus-4-6": 40 } as unknown as {
                default: number;
                [key: string]: number;
            };
            // Simulate missing default by deleting
            delete (config as Record<string, unknown>).default;

            //#when
            const result = resolveExecuteThreshold(
                config as { default: number; [key: string]: number },
                "openai/gpt-4o",
                65,
            );

            //#then
            expect(result).toBe(65);
        });

        it("returns config.default when modelKey is undefined", () => {
            //#given
            const config = { default: 42, "openai/gpt-5.4-fast": 25 };

            //#when
            const result = resolveExecuteThreshold(config, undefined, 65);

            //#then — undefined modelKey hits the no-model branch, not the per-model lookup
            expect(result).toBe(42);
        });
    });

    describe("resolveExecuteThreshold (tokens-based)", () => {
        it("uses execute_threshold_tokens when set for the model, overriding percentage", () => {
            //#when — 100K tokens / 200K context = 50%
            const result = resolveExecuteThreshold(65, "github-copilot/gpt-5.2-codex", 65, {
                tokensConfig: { "github-copilot/gpt-5.2-codex": 100_000 },
                contextLimit: 200_000,
            });

            //#then — overrides percentage (65) with derived (50)
            expect(result).toBe(50);
        });

        it("uses execute_threshold_tokens.default for models not explicitly listed", () => {
            //#when — default 150K / 400K = 37.5%
            const result = resolveExecuteThreshold(65, "openai/gpt-5.4", 65, {
                tokensConfig: { default: 150_000 },
                contextLimit: 400_000,
            });

            //#then
            expect(result).toBe(37.5);
        });

        it("clamps token value above 80% × contextLimit and still returns capped percentage", () => {
            //#when — 500K requested on 200K model: cap is 160K (80% of 200K) = 80%
            const result = resolveExecuteThreshold(65, "some/model", 65, {
                tokensConfig: { "some/model": 500_000 },
                contextLimit: 200_000,
            });

            //#then — clamped to 80% max
            expect(result).toBe(80);
        });

        it("falls through to percentage config when tokens config is missing", () => {
            //#when
            const result = resolveExecuteThreshold(
                { default: 60, "openai/gpt-5.4": 45 },
                "openai/gpt-5.4",
                65,
                { tokensConfig: undefined, contextLimit: 400_000 },
            );

            //#then — percentage-based match
            expect(result).toBe(45);
        });

        it("falls through to percentage when contextLimit is missing (tokens unusable)", () => {
            //#when — no contextLimit, tokens ignored
            const result = resolveExecuteThreshold(55, "x/y", 65, {
                tokensConfig: { "x/y": 100_000 },
            });

            //#then
            expect(result).toBe(55);
        });

        it("picks exact model key before default in tokens config", () => {
            //#when — exact key wins over default
            const result = resolveExecuteThreshold(65, "github-copilot/gpt-5.2-codex", 65, {
                tokensConfig: {
                    default: 200_000,
                    "github-copilot/gpt-5.2-codex": 40_000,
                },
                contextLimit: 400_000,
            });

            //#then — exact 40K / 400K = 10%
            expect(result).toBe(10);
        });

        it("supports progressive lookup (derived → base) for tokens config", () => {
            //#when — user set tokens for base model, session is on derived variant
            const result = resolveExecuteThreshold(65, "openai/gpt-5.4-fast", 65, {
                tokensConfig: { "openai/gpt-5.4": 100_000 },
                contextLimit: 400_000,
            });

            //#then — finds base model match (25%)
            expect(result).toBe(25);
        });
    });

    describe("resolveExecuteThresholdDetail (mode + hardening)", () => {
        it("reports mode='tokens' and absoluteTokens when tokens match (exact)", () => {
            //#when
            const detail = resolveExecuteThresholdDetail(65, "github-copilot/gpt-5.2-codex", 65, {
                tokensConfig: { "github-copilot/gpt-5.2-codex": 100_000 },
                contextLimit: 200_000,
            });

            //#then — 100K/200K = 50%, mode must be tokens, absolute preserved
            expect(detail.mode).toBe("tokens");
            expect(detail.percentage).toBe(50);
            expect(detail.absoluteTokens).toBe(100_000);
            expect(detail.matchedKey).toBe("github-copilot/gpt-5.2-codex");
        });

        it("reports mode='tokens' via progressive base-model match (display-drift fix)", () => {
            //#given — /ctx-status previously missed this path and mislabeled as percentage
            //#when — user wrote base key, runtime is derived
            const detail = resolveExecuteThresholdDetail(65, "openai/gpt-5.4-fast", 65, {
                tokensConfig: { "openai/gpt-5.4": 100_000 },
                contextLimit: 400_000,
            });

            //#then — mode is tokens because base key matched
            expect(detail.mode).toBe("tokens");
            expect(detail.percentage).toBe(25);
            expect(detail.absoluteTokens).toBe(100_000);
            expect(detail.matchedKey).toBe("openai/gpt-5.4");
        });

        it("reports mode='percentage' when no tokens key or default matches", () => {
            //#when — tokens config missing this model entirely, no default
            const detail = resolveExecuteThresholdDetail(
                { default: 55, "openai/gpt-5.4": 45 },
                "openai/gpt-5.4",
                65,
                {
                    tokensConfig: { "other/model": 100_000 },
                    contextLimit: 400_000,
                },
            );

            //#then
            expect(detail.mode).toBe("percentage");
            expect(detail.percentage).toBe(45);
            expect(detail.absoluteTokens).toBeUndefined();
            expect(detail.matchedKey).toBe("openai/gpt-5.4");
        });

        it("reports mode='percentage' when contextLimit is missing (tokens unusable)", () => {
            //#when — tokens config present but no contextLimit → cannot apply
            const detail = resolveExecuteThresholdDetail(55, "x/y", 65, {
                tokensConfig: { "x/y": 100_000 },
            });

            //#then
            expect(detail.mode).toBe("percentage");
            expect(detail.percentage).toBe(55);
        });

        it("reports mode='tokens' with absoluteTokens equal to clamp cap when over-cap", () => {
            //#when — 500K requested on 200K model → clamp to 160K (80%)
            const detail = resolveExecuteThresholdDetail(65, "some/model", 65, {
                tokensConfig: { "some/model": 500_000 },
                contextLimit: 200_000,
                sessionId: "ses-test-clamp-detail",
            });

            //#then — tokens won, clamped to cap, percentage = 80
            expect(detail.mode).toBe("tokens");
            expect(detail.percentage).toBe(80);
            expect(detail.absoluteTokens).toBe(160_000);
        });

        it("guards against NaN contextLimit (runtime division hazard) — falls through to percentage", () => {
            //#given — caller derives contextLimit from inputTokens/percentage and percentage is 0
            const nanLimit = 0 / 0;

            //#when
            const detail = resolveExecuteThresholdDetail(55, "x/y", 65, {
                tokensConfig: { "x/y": 100_000 },
                contextLimit: nanLimit,
            });

            //#then — NaN contextLimit cannot form a valid cap; safely use percentage config
            expect(detail.mode).toBe("percentage");
            expect(detail.percentage).toBe(55);
            expect(Number.isFinite(detail.percentage)).toBe(true);
        });

        it("guards against negative/zero contextLimit", () => {
            //#when
            const zero = resolveExecuteThresholdDetail(55, "x/y", 65, {
                tokensConfig: { "x/y": 100_000 },
                contextLimit: 0,
            });
            const neg = resolveExecuteThresholdDetail(55, "x/y", 65, {
                tokensConfig: { "x/y": 100_000 },
                contextLimit: -100_000,
            });

            //#then — both must fall through without throwing
            expect(zero.mode).toBe("percentage");
            expect(neg.mode).toBe("percentage");
        });

        it("guards against non-finite/non-positive token values (e.g., NaN injected at runtime)", () => {
            //#when — token value is NaN somehow (would poison percentage math)
            const detail = resolveExecuteThresholdDetail(55, "x/y", 65, {
                tokensConfig: { "x/y": Number.NaN },
                contextLimit: 200_000,
            });

            //#then — bad value ignored, fall through to percentage
            expect(detail.mode).toBe("percentage");
            expect(detail.percentage).toBe(55);
        });

        it("guards against negative percentage config by reverting to fallback", () => {
            //#given — schema normally blocks this but a runtime mutation could produce it
            //#when
            const detail = resolveExecuteThresholdDetail(-5 as unknown as number, "x/y", 42);

            //#then — fallback used, percentage non-negative
            expect(detail.mode).toBe("percentage");
            expect(detail.percentage).toBe(42);
        });

        it("dedupes clamp warn: repeated resolution of the same over-cap config only warns once", () => {
            // The dedupe key is (sessionId|modelKey|tokenVal|cap). Calling the resolver
            // many times with the same inputs must not log repeatedly. We can't assert
            // the log directly without a mock, but we CAN assert the function stays pure
            // on the return value (no crash, no behavior change across calls).
            const opts = {
                tokensConfig: { "some/model": 500_000 },
                contextLimit: 200_000,
                sessionId: "ses-dedupe",
            };
            const a = resolveExecuteThresholdDetail(65, "some/model", 65, opts);
            const b = resolveExecuteThresholdDetail(65, "some/model", 65, opts);
            const c = resolveExecuteThresholdDetail(65, "some/model", 65, opts);

            //#then — stable output across repeated calls
            expect(a).toEqual(b);
            expect(b).toEqual(c);
        });
    });

    describe("resolveModelKey", () => {
        it("returns provider/model when both parts exist", () => {
            expect(resolveModelKey("openai", "gpt-4o")).toBe("openai/gpt-4o");
        });

        it("returns undefined when either part is missing", () => {
            expect(resolveModelKey(undefined, "gpt-4o")).toBeUndefined();
            expect(resolveModelKey("openai", undefined)).toBeUndefined();
        });
    });

    describe("resolveSessionId", () => {
        it("prefers properties.sessionID when present", () => {
            const sessionId = resolveSessionId({
                sessionID: "ses-direct",
                info: { id: "ses-info" },
            });
            expect(sessionId).toBe("ses-direct");
        });

        it("falls back to info.sessionID and info.id", () => {
            expect(resolveSessionId({ info: { sessionID: "ses-info" } })).toBe("ses-info");
            expect(resolveSessionId({ info: { id: "ses-id" } })).toBe("ses-id");
        });
    });
});
