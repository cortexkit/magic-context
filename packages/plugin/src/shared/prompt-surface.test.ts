import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolveCacheTtl } from "../hooks/magic-context/event-resolvers";
import {
    modelKeyLookupOrder,
    promptSurfaceConfigIdentity,
    resolvePromptSurface,
} from "./prompt-surface";

describe("prompt-surface resolution", () => {
    it("keeps cache_ttl and prompt-surface routing on the same lookup walk", () => {
        const routes = {
            "anthropic/claude/sonnet": "light" as const,
            "openai/gpt-4o": "light" as const,
            "google/*": "light" as const,
            "CaseSensitive/model": "light" as const,
            "progressive/base": "light" as const,
            "bare-model": "light" as const,
        };
        const cacheTtl = {
            default: "full",
            ...Object.fromEntries(Object.entries(routes).map(([key, preset]) => [key, preset])),
        };

        const cases = [
            ["anthropic/claude/sonnet", "light"],
            ["anthropic/claude/other", "full"],
            ["openai/gpt-4o", "light"],
            ["openai/gpt-4o-mini", "light"],
            ["google/gemini-pro", "light"],
            ["casesensitive/model", "full"],
            ["CaseSensitive/model", "light"],
            ["progressive/base-extra", "light"],
            ["provider/bare-model", "light"],
            ["unknown/model", "full"],
            [undefined, "full"],
        ] as const;

        for (const [modelKey, expected] of cases) {
            const ttl = resolveCacheTtl(cacheTtl, modelKey);
            const prompt = resolvePromptSurface({ default: "full", models: routes }, modelKey);

            expect(ttl).toBe(expected);
            expect(prompt.preset).toBe(expected);
        }
    });

    it("resolves Pi-native and canonical model keys with canonical precedence", () => {
        const nativeKey = "openai-codex/gpt-5.6-sol";
        const canonicalKey = "openai/gpt-5.6-sol";

        expect(resolveCacheTtl({ default: "5m", [nativeKey]: "60m" }, canonicalKey)).toBe("60m");
        expect(
            resolvePromptSurface(
                { default: "full", models: { [nativeKey]: "light" } },
                canonicalKey,
            ),
        ).toEqual({ preset: "light", source: "exact" });
        expect(
            resolveCacheTtl(
                { default: "5m", [nativeKey]: "60m", [canonicalKey]: "30m" },
                nativeKey,
            ),
        ).toBe("30m");
        expect(
            resolvePromptSurface(
                { default: "full", models: { [nativeKey]: "light", [canonicalKey]: "full" } },
                nativeKey,
            ),
        ).toEqual({ preset: "full", source: "exact" });
    });

    it("leaves unknown provider keys unchanged", () => {
        expect(
            resolveCacheTtl(
                { default: "5m", "custom-provider/model": "1m" },
                "custom-provider/model",
            ),
        ).toBe("1m");
        expect(modelKeyLookupOrder("custom-provider/model")[0]).toEqual({
            key: "custom-provider/model",
            source: "exact",
        });
    });

    it("derives a stable config identity independent of object key order", () => {
        const left = promptSurfaceConfigIdentity({
            default: "full",
            models: { "provider/b": "light", "provider/a": "full" },
            tool_descriptions: { ctx_search: "Search", ctx_note: "Note" },
        });
        const right = promptSurfaceConfigIdentity({
            tool_descriptions: { ctx_note: "Note", ctx_search: "Search" },
            models: { "provider/a": "full", "provider/b": "light" },
            default: "full",
        });
        expect(left).toBe(right);
        expect(
            promptSurfaceConfigIdentity({ default: "light", models: { "provider/a": "full" } }),
        ).not.toBe(right);
    });

    it("resolves cache_ttl routing against the committed standalone vectors", () => {
        const vectors = JSON.parse(
            readFileSync(
                resolve(
                    import.meta.dir,
                    "../../test-fixtures/runtime/cache-ttl-routing-vectors.json",
                ),
                "utf8",
            ),
        ) as {
            default: string;
            models: Record<string, string>;
            cases: Array<{ name: string; modelKey: string; expected: string }>;
        };
        const config = { default: vectors.default, ...vectors.models };

        for (const vector of vectors.cases) {
            expect(resolveCacheTtl(config, vector.modelKey), vector.name).toBe(vector.expected);
        }
    });

    it("applies exact, bare, wildcard, then default precedence", () => {
        const config = {
            default: "full" as const,
            models: {
                "provider/model": "light" as const,
                bare: "light" as const,
                "provider/*": "full" as const,
            },
        };

        expect(resolvePromptSurface(config, "provider/model")).toEqual({
            preset: "light",
            source: "exact",
        });
        expect(resolvePromptSurface(config, "provider/bare")).toEqual({
            preset: "light",
            source: "bare",
        });
        expect(resolvePromptSurface(config, "provider/other")).toEqual({
            preset: "full",
            source: "wildcard",
        });
        expect(resolvePromptSurface(config, "other/model")).toEqual({
            preset: "full",
            source: "default",
        });
    });

    it("preserves multi-slash model IDs and treats case differences literally", () => {
        expect(modelKeyLookupOrder("provider/model/with/slashes")[0]).toEqual({
            key: "provider/model/with/slashes",
            source: "exact",
        });
        expect(
            resolvePromptSurface(
                {
                    default: "full",
                    models: { "provider/model/with/slashes": "light" },
                },
                "provider/model/with/slashes",
            ),
        ).toEqual({ preset: "light", source: "exact" });
        expect(
            resolvePromptSurface(
                {
                    default: "full",
                    models: { "Provider/*": "light" },
                },
                "provider/model/with/slashes",
            ),
        ).toEqual({ preset: "full", source: "default" });
    });

    it("falls back when provider or model components are absent", () => {
        const config = {
            default: "light" as const,
            models: { "provider/*": "full" as const },
        };

        expect(resolvePromptSurface(config, "provider")).toEqual({
            preset: "light",
            source: "default",
        });
        expect(resolvePromptSurface(config, "/model")).toEqual({
            preset: "light",
            source: "default",
        });
        expect(resolvePromptSurface(config, "provider/")).toEqual({
            preset: "light",
            source: "default",
        });
    });
});
