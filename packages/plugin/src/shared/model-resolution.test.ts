import { describe, expect, test } from "bun:test";

import {
    normalizeModelEntry,
    resolveDreamerTaskModel,
    resolveFallbackEntries,
    resolveHistorianAgentOverrides,
    resolveHistorianModel,
} from "./model-resolution";

describe("model-resolution", () => {
    test("pins the historian calibration defaults while preserving explicit overrides", () => {
        expect(resolveHistorianAgentOverrides(undefined)).toEqual({
            temperature: 0.1,
            maxTokens: 32_000,
        });
        expect(
            resolveHistorianAgentOverrides({
                temperature: 0.2,
                maxTokens: 16_000,
                opencode: { model: "google/flash", variant: "low" },
            }),
        ).toEqual({
            temperature: 0.2,
            maxTokens: 16_000,
            model: "google/flash",
            variant: "low",
        });
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

    test("applies the flash-calibrated historian generation triple while preserving overrides", () => {
        expect(
            resolveHistorianAgentOverrides({
                opencode: { model: { model: "google/flash", variant: "fast" } },
                pi: { model: "pi/ignored" },
                two_pass: true,
            }),
        ).toEqual({
            temperature: 0.1,
            maxTokens: 32_000,
            two_pass: true,
            model: "google/flash",
            variant: "fast",
        });
        expect(
            resolveHistorianAgentOverrides({ temperature: 0.2, maxTokens: 12_000 }),
        ).toMatchObject({ temperature: 0.2, maxTokens: 12_000 });
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

    test("uses mural model between compress-cues task and harness default", () => {
        const config = {
            dreamer: {
                tasks: { "compress-cues": { schedule: "0 4 * * *" } },
                opencode: {
                    model: { model: "open/default", variant: "default-variant" },
                    tasks: { "compress-cues": { variant: "task-local-must-not-leak" } },
                },
                pi: {
                    model: { model: "pi/default", thinking_level: "high" },
                    tasks: { "compress-cues": {} },
                },
            },
        };

        expect(
            resolveDreamerTaskModel({
                config,
                harness: "opencode",
                task: "compress-cues",
                muralModel: "mural/model",
            }),
        ).toMatchObject({
            primary: { model: "mural/model", qualifier: "default-variant" },
            fallbacks: [],
        });
        expect(
            resolveDreamerTaskModel({
                config,
                harness: "pi",
                task: "compress-cues",
                muralModel: "mural/model",
            }),
        ).toMatchObject({
            primary: { model: "mural/model", qualifier: "high" },
            fallbacks: [],
        });
    });
});
