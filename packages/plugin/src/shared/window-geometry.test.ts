import { describe, expect, test } from "bun:test";
import { resolveLimit, resolveOutputReserve } from "./models-dev-cache";
import {
    applyProvenInputFloor,
    deriveWindowGeometry,
    formatCompactTokens,
    formatWindowDerivationLine,
    placeholderFilteredOutput,
} from "./window-geometry";

describe("window geometry", () => {
    test("filters placeholders independently in both directions", () => {
        expect(placeholderFilteredOutput(0, 1_000_000)).toBeUndefined();
        expect(placeholderFilteredOutput(1_000_000, 1_000_000)).toBeUndefined();
        expect(placeholderFilteredOutput(1_000_001, 1_000_000)).toBeUndefined();
        expect(placeholderFilteredOutput(65_536, 1_000_000)).toBe(65_536);
        expect(
            deriveWindowGeometry("xai", "mixed", {
                context: 500_000,
                input: 300_000,
                output: 500_000,
            })?.usableSoft,
        ).toBe(300_000);
    });

    test("preserves catalog geometry for representative models", () => {
        const cases = [
            {
                provider: "openai",
                model: "gpt-4o",
                limit: { context: 128_000, output: 16_384 },
                expected: {
                    usableSoft: 111_616,
                    usableHard: 111_616,
                    geometry: "shared_upfront",
                    derivation: {
                        window: 128_000,
                        reserve: 16_384,
                        reserveSource: "output_catalog",
                        geometry: "shared_upfront",
                        windowSource: "catalog",
                        absoluteWall: 128_000,
                    },
                },
            },
            {
                provider: "anthropic",
                model: "claude-3-7-sonnet",
                limit: { context: 200_000, output: 64_000 },
                expected: {
                    usableSoft: 150_000,
                    usableHard: 195_904,
                    geometry: "shared_truncating",
                    derivation: {
                        window: 200_000,
                        reserve: 50_000,
                        reserveSource: "output_catalog",
                        geometry: "shared_truncating",
                        windowSource: "catalog",
                        absoluteWall: 200_000,
                    },
                },
            },
            {
                provider: "google",
                model: "gemini-2.5-pro",
                limit: { context: 1_000_000, output: 65_536 },
                expected: {
                    usableSoft: 1_000_000,
                    usableHard: 1_000_000,
                    geometry: "separate",
                    derivation: {
                        window: 1_000_000,
                        reserve: 0,
                        reserveSource: "none",
                        geometry: "separate",
                        windowSource: "catalog",
                        absoluteWall: 1_000_000,
                    },
                },
            },
            {
                provider: "xai",
                model: "grok-3",
                limit: { context: 131_072, output: 32_768 },
                expected: {
                    usableSoft: 98_304,
                    usableHard: 126_976,
                    geometry: "shared_truncating",
                    derivation: {
                        window: 131_072,
                        reserve: 32_768,
                        reserveSource: "output_catalog",
                        geometry: "shared_truncating",
                        windowSource: "catalog",
                        absoluteWall: 131_072,
                    },
                },
            },
            {
                provider: "openai-codex",
                model: "gpt-5.6-sol",
                limit: { context: 272_000, output: 128_000 },
                expected: {
                    usableSoft: 204_000,
                    usableHard: 240_000,
                    geometry: "shared_upfront",
                    derivation: {
                        window: 272_000,
                        reserve: 68_000,
                        reserveSource: "output_catalog",
                        geometry: "shared_upfront",
                        windowSource: "catalog",
                        absoluteWall: 272_000,
                    },
                },
            },
        ] as const;

        for (const { provider, model, limit, expected } of cases) {
            expect(deriveWindowGeometry(provider, model, limit)).toEqual(expected);
        }
    });

    test("output_reserve forms override a pre-carved input and catalog output", () => {
        const cases = [
            16_384,
            { default: 16_384 },
            { default: 32_000, "openai-codex/gpt-5.6-sol": 16_384 },
        ] as const;

        for (const reserveConfig of cases) {
            const result = deriveWindowGeometry(
                "openai-codex",
                "gpt-5.6-sol",
                { context: 400_000, input: 272_000, output: 128_000 },
                {
                    outputReserveOverride: resolveOutputReserve(
                        "openai-codex",
                        "gpt-5.6-sol",
                        reserveConfig,
                    ),
                },
            );
            expect(result?.usableSoft).toBe(272_000 - 16_384);
            expect(result?.derivation).toMatchObject({
                window: 272_000,
                reserve: 16_384,
                reserveSource: "output_config",
            });
        }
    });

    test("provider hook overrides catalog limits field by field", () => {
        const catalog = deriveWindowGeometry("provider", "model", {
            context: 200_000,
            output: 10_000,
        });
        const hooked = deriveWindowGeometry(
            "provider",
            "model",
            { context: 200_000, output: 10_000 },
            { providerLimit: { context: 400_000, output: 30_000 } },
        );
        expect(catalog?.derivation.window).toBe(200_000);
        expect(hooked?.derivation.window).toBe(400_000);
        expect(hooked?.derivation.reserve).toBe(30_000);
    });

    test("keeps shared-upfront emergency headroom below the separate absolute wall", () => {
        const result = deriveWindowGeometry(
            "openai-codex",
            "gpt-5.6-sol",
            { context: 272_000, output: 128_000 },
            { providerLimit: { context: 272_000 }, harness: "pi" },
        );

        expect(result?.usableSoft).toBe(204_000);
        expect(result?.usableHard).toBe(204_000);
        expect(result?.usableHard).toBeLessThan(result?.derivation.absoluteWall ?? 0);
        expect(result?.derivation.absoluteWall).toBe(272_000);
        expect((result?.derivation.absoluteWall ?? 0) - (result?.usableHard ?? 0)).toBe(
            result?.derivation.reserve,
        );
        expect(result?.derivation.windowSource).toBe("provider");
    });

    test("bounds proof at trusted absolute walls but retains the static-catalog escape hatch", () => {
        const trusted = deriveWindowGeometry(
            "openai-codex",
            "gpt-5.6-sol",
            { context: 272_000, output: 128_000 },
            { providerLimit: { context: 272_000 }, harness: "pi" },
        );
        expect(trusted).toBeDefined();
        const raisedWithinWall = applyProvenInputFloor(trusted!, 255_834);
        expect(raisedWithinWall.geometry.usableSoft).toBe(255_834);
        expect(raisedWithinWall.geometry.usableHard).toBe(204_000);
        const refused = applyProvenInputFloor(trusted!, 593_717);
        expect(refused.refused).toEqual({ reading: 593_717, absoluteWall: 272_000 });
        expect(refused.geometry.usableSoft).toBe(204_000);
        expect(refused.geometry.usableHard).toBe(204_000);

        const staticFallback = deriveWindowGeometry("custom", "model", { context: 30_000 });
        expect(staticFallback).toBeDefined();
        const escaped = applyProvenInputFloor(staticFallback!, 90_000);
        expect(escaped.refused).toBeUndefined();
        expect(escaped.geometry.usableSoft).toBe(90_000);
        expect(escaped.geometry.usableHard).toBe(90_000);
        expect(escaped.geometry.derivation.absoluteWall).toBe(90_000);
    });

    test("caps the hard wall at a declared input limit", () => {
        // A provider rejects a prompt over its declared input limit however much
        // room the context window leaves after output, so that limit is the wall
        // the 95% emergency lines read, for every geometry.
        const cases = [
            {
                provider: "opencode-go",
                limit: { context: 1_000_000, input: 302_222, output: 65_536 },
                usableHard: 302_222,
            },
            {
                provider: "anthropic",
                limit: { context: 1_000_000, input: 900_000, output: 128_000 },
                usableHard: 900_000,
            },
            {
                provider: "google",
                limit: { context: 1_048_576, input: 1_000_000, output: 65_536 },
                usableHard: 1_000_000,
            },
        ] as const;
        for (const { provider, limit, usableHard } of cases) {
            const result = deriveWindowGeometry(provider, "model", limit);
            expect({ usableSoft: result?.usableSoft, usableHard: result?.usableHard }).toEqual({
                usableSoft: limit.input,
                usableHard,
            });
        }
        // Without a declared input limit the wall stays the context less the
        // output the request asks for.
        expect(
            deriveWindowGeometry("opencode-go", "model", { context: 1_000_000, output: 65_536 })
                ?.usableHard,
        ).toBe(968_000);
        // A configured output reserve narrows the usable window, not the wall.
        const reserved = deriveWindowGeometry(
            "openai-codex",
            "gpt-5.6-sol",
            { context: 400_000, input: 272_000, output: 128_000 },
            { outputReserveOverride: 16_384 },
        );
        expect({ usableSoft: reserved?.usableSoft, usableHard: reserved?.usableHard }).toEqual({
            usableSoft: 272_000 - 16_384,
            usableHard: 272_000,
        });
    });

    test("clamps an inversion and logs it", () => {
        const logs: string[] = [];
        const result = deriveWindowGeometry(
            "provider",
            "model",
            { context: 200_000, input: 190_000, output: 10_000 },
            {
                providerLimit: { context: 192_000, input: 190_000, output: 10_000 },
                log: (message) => logs.push(message),
            },
        );
        expect(result?.usableHard).toBe(result?.usableSoft);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain("clamped");
    });

    test("catalog usableSoft matches the legacy resolver", () => {
        const corpus = [
            ["openai", "real", { context: 200_000, output: 32_000 }],
            ["openai", "zero", { context: 200_000, output: 0 }],
            ["xai", "placeholder", { context: 500_000, output: 500_000 }],
            ["google", "separate", { context: 1_000_000, output: 65_536 }],
            ["anthropic", "input", { context: 1_000_000, input: 900_000, output: 128_000 }],
        ] as const;
        for (const [provider, model, limit] of corpus) {
            const result = deriveWindowGeometry(provider, model, limit);
            expect(result?.usableSoft).toBe(resolveLimit(limit, provider, model));
        }
    });

    test("prints one line without the internal geometry tag or a second percentage", () => {
        const result = deriveWindowGeometry("openai", "model", {
            context: 204_000,
            output: 30_600,
        }) as NonNullable<ReturnType<typeof deriveWindowGeometry>>;
        const line = formatWindowDerivationLine(105_900, result);
        // The headline row above this line already carries the percentage, and
        // the bracketed geometry mode is window-geometry's own vocabulary.
        expect(line).not.toContain("%");
        expect(line).not.toContain("[");
        expect(line).not.toContain("—");
        expect(line).toBe(
            `105.9k / ${formatCompactTokens(result.usableSoft)} usable · window ${formatCompactTokens(result.derivation.window)} · ${formatCompactTokens(result.derivation.reserve)} output reserve`,
        );
    });

    test("fits one line at the dialog's narrowest content width", () => {
        // The narrowest dialog content width is 56 columns (an 88-column dialog
        // less its padding); a longer line wraps onto a second row. The 1m
        // window with a 128k output reserve is the shape the dialog shows.
        const result = deriveWindowGeometry("openai", "model", {
            context: 1_000_000,
            output: 128_000,
        }) as NonNullable<ReturnType<typeof deriveWindowGeometry>>;
        const line = formatWindowDerivationLine(533_700, result);
        expect(line).toBe("533.7k / 872k usable · window 1m · 128k output reserve");
        expect(line.length).toBeLessThanOrEqual(56);
    });
});
