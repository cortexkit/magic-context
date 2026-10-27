import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_HISTORIAN_TIMEOUT_MS } from "../config/schema/magic-context";
import {
    resolveHistorianProducerLimits,
    resolveKnownHistorianContextLimit,
} from "../hooks/magic-context/derive-budgets";
import type { TransformDeps } from "../hooks/magic-context/transform";
import { type ModelHarness, resolveHistorianModel } from "./model-resolution";
import { clearModelsDevCache, getSdkOutputLimit, getSdkWindowGeometry } from "./models-dev-cache";

/**
 * Drift check for the historian settings ck-mc resolves from its own config.
 *
 * When a harness runs Magic Context through ck-mc without this plugin's bridge,
 * nothing sends ck-mc the historian model chain, so ck-mc reads the user's config
 * and resolves the chain, variants, per-model limits, timeout and output cap
 * itself (crates/mc-module/src/providers/historian_config.rs). The
 * committed fixture records what this plugin resolves for the same config matrix,
 * and the Rust test compares against it. This test fails whenever the TypeScript
 * resolution changes without the fixture being regenerated:
 *
 *   MC_REGENERATE_HISTORIAN_CONFIG_FIXTURE=1 bun test src/shared/historian-config-resolution.test.ts
 *
 * The resolution is the one the plugin uses everywhere it hands the module a
 * chain: `resolveHistorianModel` (model-resolution.ts), the timeout default from
 * `sampleHistorian` (hooks/magic-context/hook.ts), `historian.maxTokens` as the
 * output cap and `historianFieldsFromConfig` below for the chain, variants and
 * limits. ck-mc has no model catalog, so the matrix is resolved with an empty
 * catalog: every per-model limit entry is then empty, as it is in ck-mc.
 */
const FIXTURE_PATH = resolve(
    import.meta.dir,
    "../../../../crates/mc-module/testdata/historian-config-resolution.json",
);

interface MatrixCase {
    name: string;
    harness: string;
    config: Record<string, unknown>;
}

const MATRIX: MatrixCase[] = [
    { name: "empty config", harness: "opencode", config: {} },
    { name: "empty historian block", harness: "opencode", config: { historian: {} } },
    { name: "historian is not an object", harness: "opencode", config: { historian: "x" } },
    {
        name: "harness block is an array",
        harness: "opencode",
        config: { historian: { opencode: [] } },
    },
    {
        name: "primary only",
        harness: "opencode",
        config: { historian: { opencode: { model: "fixture-a/main" } } },
    },
    {
        name: "primary object with its own variant",
        harness: "opencode",
        config: {
            historian: { opencode: { model: { model: "fixture-a/main", variant: "high" } } },
        },
    },
    {
        name: "primary takes the block variant",
        harness: "opencode",
        config: { historian: { opencode: { model: "fixture-a/main", variant: "medium" } } },
    },
    {
        name: "fallbacks with variants, duplicates and invalid entries",
        harness: "opencode",
        config: {
            historian: {
                opencode: {
                    model: { model: "fixture-a/main", variant: "high" },
                    variant: "low",
                    fallback_models: [
                        "fixture-a/main",
                        { model: "fixture-a/main", variant: "high" },
                        { model: "fixture-a/main", variant: "low" },
                        "fixture-b/fallback",
                        "fixture-b/fallback",
                        "invalid",
                        " ",
                        "/no-provider",
                        "no-model/",
                        { model: "fixture-c/second", variant: "max" },
                        { model: "fixture-c/third", thinking_level: "ignored-on-opencode" },
                    ],
                },
            },
        },
    },
    {
        name: "single fallback string",
        harness: "opencode",
        config: {
            historian: {
                opencode: { model: "fixture-a/main", fallback_models: "fixture-b/backup" },
            },
        },
    },
    {
        name: "fallbacks without a primary",
        harness: "opencode",
        config: {
            historian: { opencode: { fallback_models: ["fixture-a/one", "fixture-b/two"] } },
        },
    },
    {
        name: "fallback repeats the primary",
        harness: "opencode",
        config: {
            historian: {
                opencode: {
                    model: "fixture-a/main",
                    fallback_models: ["fixture-a/main", "fixture-b/two"],
                },
            },
        },
    },
    {
        name: "variant only on a later attempt of the same model",
        harness: "opencode",
        config: {
            historian: {
                opencode: {
                    model: "fixture-a/main",
                    fallback_models: [{ model: "fixture-a/main", variant: "x" }],
                },
            },
        },
    },
    {
        name: "blank primary keeps the fallbacks",
        harness: "opencode",
        config: {
            historian: {
                opencode: {
                    model: { model: " " },
                    variant: "high",
                    fallback_models: ["fixture-b/two"],
                },
            },
        },
    },
    {
        name: "non-string models are skipped",
        harness: "opencode",
        config: {
            historian: {
                opencode: {
                    model: 42,
                    fallback_models: [7, { model: "" }, null, "fixture-b/ok"],
                },
            },
        },
    },
    {
        name: "unknown models keep their place",
        harness: "opencode",
        config: {
            historian: {
                opencode: {
                    model: "unknown-model-without-provider",
                    fallback_models: ["fixture-unknown/model:tag", "fixture-unknown/other"],
                },
            },
        },
    },
    {
        name: "pi thinking levels",
        harness: "pi",
        config: {
            historian: {
                pi: {
                    model: "fixture-a/pi",
                    thinking_level: "high",
                    fallback_models: [
                        { model: "fixture-b/backup", thinking_level: "low", variant: "ignored" },
                        "fixture-a/pi",
                    ],
                },
            },
        },
    },
    {
        name: "omp falls back to the pi block",
        harness: "omp",
        config: {
            historian: {
                pi: {
                    model: "fixture-a/pi",
                    thinking_level: "medium",
                    fallback_models: ["fixture-b/f"],
                },
            },
        },
    },
    {
        name: "omp uses its own block",
        harness: "omp",
        config: {
            historian: {
                omp: { model: "fixture-a/omp", thinking_level: "low" },
                pi: { model: "fixture-a/pi" },
            },
        },
    },
    {
        name: "another harness's block is ignored",
        harness: "opencode",
        config: { historian: { pi: { model: "fixture-a/pi" } } },
    },
    {
        name: "harness with no historian block",
        harness: "claude-code",
        config: { historian: { opencode: { model: "fixture-a/main" } } },
    },
    {
        name: "per-model limits, timeout and output cap",
        harness: "opencode",
        config: {
            historian_timeout_ms: 90_000,
            output_reserve: { "fixture-a/main": 4_000, default: 1_000 },
            historian: {
                maxTokens: 12_000,
                opencode: {
                    model: { model: "fixture-a/main", variant: "high" },
                    fallback_models: ["fixture-b/fallback"],
                },
            },
        },
    },
    {
        name: "timeout without a chain",
        harness: "pi",
        config: { historian_timeout_ms: 120_000, historian: { maxTokens: 8_000 } },
    },
];

/** The settings the plugin hands the module for one harness and config. */
function resolveHistorianSettings(entry: MatrixCase): Record<string, unknown> {
    const config = entry.config as {
        historian_timeout_ms?: number;
        historian?: { maxTokens?: number };
    };
    const attempts = resolveHistorianModel(config, entry.harness as ModelHarness);
    return historianFieldsFromConfig({
        historianModel: attempts.primary,
        fallbackModels: attempts.fallbacks,
        timeoutMs: config.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
        maxOutputTokens:
            typeof config.historian === "object" ? config.historian?.maxTokens : undefined,
    });
}

/** The chain straight from `resolveHistorianModel`: primary first, then fallbacks, deduplicated. */
function bridgeChain(entry: MatrixCase): string[] {
    const attempts = resolveHistorianModel(entry.config, entry.harness as ModelHarness);
    const models = [attempts.primary, ...attempts.fallbacks]
        .map((m) => (typeof m === "string" ? m : m?.model))
        .filter((m): m is string => !!m);
    return [...new Set(models)];
}

describe("historian config resolution fixture", () => {
    it("matches the committed fixture ck-mc is tested against", () => {
        // An empty model catalog: ck-mc has none, so neither side may use one.
        clearModelsDevCache();
        const fixture = {
            generator:
                "packages/plugin/src/shared/historian-config-resolution.test.ts (set MC_REGENERATE_HISTORIAN_CONFIG_FIXTURE=1 to rewrite)",
            cases: MATRIX.map((entry) => ({ ...entry, expected: resolveHistorianSettings(entry) })),
        };
        if (process.env.MC_REGENERATE_HISTORIAN_CONFIG_FIXTURE === "1") {
            writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
        }
        const committed = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
        expect(committed).toEqual(fixture);
    });

    it("keeps the chain order resolveHistorianModel gives", () => {
        clearModelsDevCache();
        for (const entry of MATRIX) {
            expect(resolveHistorianSettings(entry).historian_model_chain, entry.name).toEqual(
                bridgeChain(entry),
            );
        }
    });
});

/** The historian fields resolved from the current config, as ck-mc resolves them. */
function historianFieldsFromConfig(
    historian: Pick<TransformDeps, "historianModel" | "fallbackModels"> & {
        timeoutMs: number;
        maxOutputTokens?: number;
    },
): Record<string, unknown> {
    const models = [historian.historianModel, ...(historian.fallbackModels ?? [])];
    const chain = [
        ...new Set(
            models
                .map((entry) => (typeof entry === "string" ? entry : entry?.model))
                .filter((model): model is string => typeof model === "string" && model.length > 0),
        ),
    ];
    const variants: Record<string, string> = {};
    const seen = new Set<string>();
    for (const entry of models) {
        const model = typeof entry === "string" ? entry : entry?.model;
        if (typeof model !== "string" || model.length === 0 || seen.has(model)) continue;
        seen.add(model);
        const variant = typeof entry === "string" ? undefined : entry?.qualifier;
        if (variant) variants[model] = variant;
    }
    const limits = Object.fromEntries(
        chain.map((key) => {
            const [provider, ...parts] = key.split("/");
            const output =
                provider && parts.length ? getSdkOutputLimit(provider, parts.join("/")) : undefined;
            const producer = resolveHistorianProducerLimits(key);
            const known =
                producer.input === undefined ? resolveKnownHistorianContextLimit(key) : undefined;
            const learned =
                provider && parts.length
                    ? getSdkWindowGeometry(provider, parts.join("/"))?.derivation.window
                    : undefined;
            const context =
                producer.context ??
                (known === undefined
                    ? learned
                    : learned === undefined
                      ? known
                      : Math.min(known, learned));
            return [
                key,
                {
                    ...(context !== undefined ? { context } : {}),
                    ...(producer.input !== undefined ? { input: producer.input } : {}),
                    ...(output !== undefined ? { output } : {}),
                },
            ];
        }),
    );
    return {
        historian_model_chain: chain,
        historian_model_limits: limits,
        historian_model_variants: variants,
        historian_timeout_ms: historian.timeoutMs,
        ...(historian.maxOutputTokens !== undefined
            ? { historian_max_output_tokens: historian.maxOutputTokens }
            : {}),
    };
}
