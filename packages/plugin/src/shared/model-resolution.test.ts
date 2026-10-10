import { describe, expect, test } from "bun:test";

import {
    normalizeModelEntry,
    resolveDreamerTaskModel,
    resolveFallbackEntries,
    resolveHistorianAgentOverrides,
    resolveHistorianModel,
} from "./model-resolution";

describe("model-resolution", () => {
    test("keeps historian temperature opt-in while preserving explicit overrides", () => {
        const fixtures = [
            { temperature: undefined, expected: undefined },
            { temperature: 0.1, expected: 0.1 },
            { temperature: 0, expected: 0 },
        ] as const;
        for (const fixture of fixtures) {
            const resolved = resolveHistorianAgentOverrides({
                ...(fixture.temperature !== undefined ? { temperature: fixture.temperature } : {}),
                maxTokens: 16_000,
                opencode: { model: "google/flash", variant: "low" },
                pi: { model: "pi/must-not-leak", thinking_level: "high" },
            });
            expect(resolved).toEqual({
                maxTokens: 16_000,
                ...(fixture.expected !== undefined ? { temperature: fixture.expected } : {}),
                model: "google/flash",
                variant: "low",
            });
        }
    });

    test("normalizes string and object entries to the same model identity", () => {
        expect(normalizeModelEntry("anthropic/sonnet", "opencode")).toEqual({
            model: "anthropic/sonnet",
        });
        expect(
            normalizeModelEntry({ model: "anthropic/sonnet", variant: "high" }, "opencode"),
        ).toEqual({ model: "anthropic/sonnet", qualifier: "high" });
    });

    test("keeps ordered qualifier-distinct fallbacks and removes exact duplicates", () => {
        expect(
            resolveFallbackEntries(
                [
                    { model: "anthropic/sonnet", variant: "low" },
                    { model: "anthropic/sonnet", variant: "high" },
                    { model: "anthropic/sonnet", variant: "low" },
                    "google/flash",
                    "google/flash",
                ],
                "opencode",
            ),
        ).toEqual([
            { model: "anthropic/sonnet", qualifier: "low" },
            { model: "anthropic/sonnet", qualifier: "high" },
            { model: "google/flash" },
        ]);
    });

    test("keeps the flash calibration available only as an explicit override", () => {
        expect(
            resolveHistorianAgentOverrides({
                opencode: { model: { model: "google/flash", variant: "fast" } },
                pi: { model: "pi/ignored" },
                two_pass: true,
            }),
        ).toEqual({
            maxTokens: 32_000,
            two_pass: true,
            model: "google/flash",
            variant: "fast",
        });
        expect(
            resolveHistorianAgentOverrides({ temperature: 0.1, maxTokens: 12_000 }),
        ).toMatchObject({ temperature: 0.1, maxTokens: 12_000 });
    });

    test("does not inherit a block qualifier into unqualified fallbacks", () => {
        const config = {
            historian: {
                opencode: {
                    model: "open/primary",
                    fallback_models: ["open/fallback"],
                    variant: "primary-only",
                },
                pi: {
                    model: "pi/primary",
                    fallback_models: ["pi/fallback"],
                    thinking_level: "high",
                },
            },
        };

        // Inheritance is deliberately absent because a fallback model may not support the
        // qualifier selected for the primary model.
        expect(resolveHistorianModel(config, "opencode")).toEqual({
            primary: { model: "open/primary", qualifier: "primary-only" },
            fallbacks: [{ model: "open/fallback" }],
        });
        expect(resolveHistorianModel(config, "pi")).toEqual({
            primary: { model: "pi/primary", qualifier: "high" },
            fallbacks: [{ model: "pi/fallback" }],
        });
    });

    test("reads historian attempts only from the requested harness", () => {
        const config = {
            historian: {
                model: "flat/ignored",
                opencode: {
                    model: { model: "open/code", variant: "oc-primary" },
                    fallback_models: [{ model: "open/fallback", variant: "oc-fallback" }],
                },
                pi: {
                    model: { model: "pi/model", thinking_level: "high" },
                    fallback_models: [{ model: "pi/fallback", thinking_level: "max" }],
                },
            },
        };

        expect(resolveHistorianModel(config, "opencode")).toEqual({
            primary: { model: "open/code", qualifier: "oc-primary" },
            fallbacks: [{ model: "open/fallback", qualifier: "oc-fallback" }],
        });
        expect(resolveHistorianModel(config, "pi")).toEqual({
            primary: { model: "pi/model", qualifier: "high" },
            fallbacks: [{ model: "pi/fallback", qualifier: "max" }],
        });
    });

    test("uses OMP blocks first, falls back to Pi blocks, then preserves existing defaults", () => {
        const configured = {
            historian: {
                pi: {
                    model: { model: "pi/historian", thinking_level: "high" },
                    fallback_models: ["pi/historian-fallback"],
                },
                omp: {
                    model: { model: "omp/historian", thinking_level: "auto" },
                    fallback_models: [{ model: "omp/historian-fallback", thinking_level: "max" }],
                },
            },
            dreamer: {
                tasks: { verify: { schedule: "0 3 * * *" } },
                pi: {
                    model: "pi/dreamer",
                    tasks: { verify: { model: "pi/verify" } },
                },
                omp: {
                    model: "omp/dreamer",
                    tasks: {
                        verify: {
                            model: { model: "omp/verify", thinking_level: "inherit" },
                        },
                    },
                },
            },
        };

        expect(resolveHistorianModel(configured, "omp")).toEqual({
            primary: { model: "omp/historian", qualifier: "auto" },
            fallbacks: [{ model: "omp/historian-fallback", qualifier: "max" }],
        });
        expect(
            resolveDreamerTaskModel({ config: configured, harness: "omp", task: "verify" }),
        ).toMatchObject({ primary: { model: "omp/verify", qualifier: "inherit" } });

        const piFallback = {
            historian: configured.historian,
            dreamer: { ...configured.dreamer, omp: undefined },
        };
        delete (piFallback.historian as { omp?: unknown }).omp;
        expect(resolveHistorianModel(piFallback, "omp")?.primary).toEqual({
            model: "pi/historian",
            qualifier: "high",
        });
        expect(
            resolveDreamerTaskModel({ config: piFallback, harness: "omp", task: "verify" }),
        ).toMatchObject({ primary: { model: "pi/verify" } });

        expect(resolveHistorianModel({}, "omp")).toEqual({ fallbacks: [] });
        const existingDefaults = resolveDreamerTaskModel({
            config: { dreamer: { tasks: { verify: { schedule: "0 3 * * *" } } } },
            harness: "omp",
            task: "verify",
        });
        expect(existingDefaults.primary).toBeUndefined();
        expect(existingDefaults.fallbacks).toEqual([]);
        expect(existingDefaults.schedule).toBe("0 3 * * *");
    });

    test("resolves ordinary task model and scheduling without crossing harnesses", () => {
        const config = {
            dreamer: {
                tasks: {
                    curate: { schedule: "0 4 * * *", promotion_threshold: 3 },
                },
                opencode: {
                    model: { model: "open/default", variant: "default-variant" },
                    tasks: {
                        curate: {
                            model: { model: "open/task", variant: "task-variant" },
                            fallback_models: [
                                "open/bare",
                                { model: "open/qualified", variant: "fb" },
                            ],
                            timeout_minutes: 12,
                        },
                    },
                },
                pi: {
                    model: { model: "pi/default", thinking_level: "high" },
                    tasks: {
                        curate: {
                            model: { model: "pi/task", thinking_level: "max" },
                            fallback_models: [{ model: "pi/fallback", thinking_level: "minimal" }],
                        },
                    },
                },
            },
        };

        expect(resolveDreamerTaskModel({ config, harness: "opencode", task: "curate" })).toEqual({
            primary: { model: "open/task", qualifier: "task-variant" },
            fallbacks: [{ model: "open/bare" }, { model: "open/qualified", qualifier: "fb" }],
            schedule: "0 4 * * *",
            timeoutMinutes: 12,
            promotionThreshold: 3,
        });
    });

    test("resolves compress-cues to each harness's dreamer default and ignores mural.model", () => {
        // The retired shared mural.model sits in the same config to prove it
        // no longer feeds resolution on any harness.
        const config = {
            mural: { enabled: true, model: "google/antigravity-gemini-3.8-flash" },
            dreamer: {
                tasks: { "compress-cues": { schedule: "0 4 * * *" } },
                opencode: {
                    model: { model: "open/default", variant: "default-variant" },
                },
                pi: {
                    model: {
                        model: "google-antigravity/antigravity-gemini-3.8-flash",
                        thinking_level: "high",
                    },
                    tasks: { "compress-cues": {} },
                },
            },
        };

        expect(
            resolveDreamerTaskModel({ config, harness: "opencode", task: "compress-cues" }),
        ).toMatchObject({
            primary: { model: "open/default", qualifier: "default-variant" },
            fallbacks: [],
            schedule: "0 4 * * *",
        });
        expect(
            resolveDreamerTaskModel({ config, harness: "pi", task: "compress-cues" }),
        ).toMatchObject({
            primary: {
                model: "google-antigravity/antigravity-gemini-3.8-flash",
                qualifier: "high",
            },
            fallbacks: [],
            schedule: "0 4 * * *",
        });
    });

    test("a per-harness compress-cues task override wins over the harness default", () => {
        const config = {
            mural: { enabled: true, model: "shared/must-not-win" },
            dreamer: {
                opencode: {
                    model: "open/default",
                    fallback_models: ["open/default-fallback"],
                    tasks: {
                        "compress-cues": {
                            model: { model: "open/cues", variant: "low" },
                            fallback_models: ["open/cues-fallback"],
                        },
                    },
                },
                pi: {
                    model: "pi/default",
                    thinking_level: "high",
                    tasks: { "compress-cues": { model: "pi/cues" } },
                },
            },
        };

        expect(
            resolveDreamerTaskModel({ config, harness: "opencode", task: "compress-cues" }),
        ).toMatchObject({
            primary: { model: "open/cues", qualifier: "low" },
            fallbacks: [{ model: "open/cues-fallback" }],
        });
        // A task override without its own qualifier uses the harness default's qualifier.
        expect(
            resolveDreamerTaskModel({ config, harness: "pi", task: "compress-cues" }),
        ).toMatchObject({
            primary: { model: "pi/cues", qualifier: "high" },
            fallbacks: [],
        });
    });
});
