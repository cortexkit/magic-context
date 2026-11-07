import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    builtInLightSurface,
    measureAgentSurface,
    measureLightSurface,
    measurePromptSurfaceText,
    readLightSurface,
    PRIMARY_VARIANT_ID,
    TOKENIZER_ENCODING,
    TOKENIZER_PACKAGE,
    TOKENIZER_VERSION,
} from "./prompt-surface-measurement";
import { ACTIVE_TOOL_IDS } from "../src/shared/prompt-surface-runtime";
import { enabledCatalogGuidance } from "./catalog-guidance.fixture";

export const RATIFIED_FULL_MUTABLE_PROSE_CEILING = 3750;
// The light ceiling started as half the full baseline (1917). Ufuk raised it to
// 2100 on 2026-11-07, when the rule for `<system-reminder>` text took the light
// guidance to 1952 tokens; he accepts a light surface of 2000-2100 tokens.
export const RATIFIED_LIGHT_MUTABLE_PROSE_CEILING = 2100;

interface BudgetFixture {
    status?: string;
    policy?: { fraction?: number; expression?: string };
    tokenizer?: { package?: string; encoding?: string; version?: string; method?: string };
    primaryVariant?: { id?: string };
    activeTools?: string[];
    fullMeasurements?: {
        guidance?: Record<string, { chars: number; tokens: number }>;
        toolDescriptions?: Record<string, { chars: number; tokens: number }>;
        serializedParameterSchemas?: {
            [id: string]: { chars: number; tokens: number } | number | undefined;
            totalTokens?: number;
        };
        builtInProviderVisibleTotal?: number;
    };
    mutableProseBaseline?: number;
    integerLightCeiling?: number;
    lightMeasurement?: { status?: string };
}

export interface BudgetValidationResult {
    errors: string[];
    messages: string[];
}

function readFixture(path: string): BudgetFixture {
    return JSON.parse(readFileSync(resolve(path), "utf8")) as BudgetFixture;
}

function compareCount(
    errors: string[],
    label: string,
    expected: { chars: number; tokens: number } | undefined,
    actual: { chars: number; tokens: number } | undefined,
) {
    if (!expected || !actual || expected.chars !== actual.chars || expected.tokens !== actual.tokens) {
        errors.push(
            `${label} drifted: fixture=${expected ? `${expected.chars} chars/${expected.tokens} tokens` : "missing"}, source=${actual ? `${actual.chars} chars/${actual.tokens} tokens` : "missing"}`,
        );
    }
}

export function validateBudgetFixture(options: {
    fixturePath: string;
    lightSurfacePath?: string;
    ccLightAssetPaths?: string[];
}): BudgetValidationResult {
    const fixture = readFixture(options.fixturePath);
    const surface = measureAgentSurface();
    const errors: string[] = [];
    const messages: string[] = [];

    if (fixture.tokenizer?.package !== TOKENIZER_PACKAGE) {
        errors.push(`tokenizer package must be ${TOKENIZER_PACKAGE}`);
    }
    if (fixture.tokenizer?.encoding !== TOKENIZER_ENCODING) {
        errors.push(`tokenizer encoding must be ${TOKENIZER_ENCODING}`);
    }
    if (fixture.tokenizer?.version !== TOKENIZER_VERSION) {
        errors.push(`tokenizer version must be ${TOKENIZER_VERSION}`);
    }
    if (fixture.tokenizer?.method !== surface.tokenizer.method) {
        errors.push(`tokenizer method drifted: expected ${surface.tokenizer.method}`);
    }
    if (fixture.primaryVariant?.id !== PRIMARY_VARIANT_ID) {
        errors.push(`primary variant must be ${PRIMARY_VARIANT_ID}`);
    }

    const fixtureTools = fixture.activeTools ?? [];
    if (JSON.stringify(fixtureTools) !== JSON.stringify([...ACTIVE_TOOL_IDS])) {
        errors.push(`active tool set drifted: fixture=${fixtureTools.join(",")}, source=${ACTIVE_TOOL_IDS.join(",")}`);
    }

    const guidanceMeasurements = fixture.fullMeasurements?.guidance ?? {};
    for (const row of surface.guidance) {
        compareCount(errors, `guidance ${row.id}`, guidanceMeasurements[row.id], row.full);
    }
    for (const id of Object.keys(guidanceMeasurements)) {
        if (!surface.guidance.some((row) => row.id === id)) {
            errors.push(`fixture contains unknown guidance variant ${id}`);
        }
    }

    const descriptionMeasurements = fixture.fullMeasurements?.toolDescriptions ?? {};
    for (const id of ACTIVE_TOOL_IDS) {
        compareCount(errors, `tool description ${id}`, descriptionMeasurements[id], surface.tools[id].description);
    }
    for (const id of Object.keys(descriptionMeasurements)) {
        if (!ACTIVE_TOOL_IDS.includes(id as (typeof ACTIVE_TOOL_IDS)[number])) {
            errors.push(`fixture contains unknown active tool ${id}`);
        }
    }

    const schemaMeasurements = fixture.fullMeasurements?.serializedParameterSchemas ?? {};
    let schemaTotal = 0;
    for (const id of ACTIVE_TOOL_IDS) {
        const expected = schemaMeasurements[id];
        const actual = surface.tools[id].serializedParameterSchema;
        if (typeof expected === "number") {
            errors.push(`serialized parameter schema ${id} must record chars and tokens, not only a number`);
        } else {
            compareCount(errors, `serialized parameter schema ${id}`, expected, actual);
        }
        schemaTotal += actual.tokens;
    }
    if (schemaMeasurements.totalTokens !== schemaTotal) {
        errors.push(`serialized parameter schema total drifted: fixture=${schemaMeasurements.totalTokens}, source=${schemaTotal}`);
    }

    const baseline = surface.primary.mutableProseBaseline;
    if (fixture.mutableProseBaseline !== baseline) {
        errors.push(`mutable-prose baseline drifted: fixture=${fixture.mutableProseBaseline}, source=${baseline}`);
    }
    if (baseline > RATIFIED_FULL_MUTABLE_PROSE_CEILING) {
        errors.push(
            `primary full mutable-prose total ${baseline} exceeds ratified ceiling ${RATIFIED_FULL_MUTABLE_PROSE_CEILING}`,
        );
    }
    if (fixture.integerLightCeiling !== RATIFIED_LIGHT_MUTABLE_PROSE_CEILING) {
        errors.push(
            `integer light ceiling must remain the ratified literal ${RATIFIED_LIGHT_MUTABLE_PROSE_CEILING}; fixture=${fixture.integerLightCeiling}`,
        );
    }
    const expectedProviderTotal = baseline + schemaTotal;
    if (fixture.fullMeasurements?.builtInProviderVisibleTotal !== expectedProviderTotal) {
        errors.push(
            `built-in provider-visible total drifted: fixture=${fixture.fullMeasurements?.builtInProviderVisibleTotal}, expected=${expectedProviderTotal}`,
        );
    }

    const lightInput = options.lightSurfacePath
        ? readLightSurface(options.lightSurfacePath)
        : builtInLightSurface();
    const light = measureLightSurface(lightInput, surface);
    if (light.variant !== PRIMARY_VARIANT_ID) {
        errors.push(`light surface variant must be ${PRIMARY_VARIANT_ID}, got ${light.variant}`);
    }
    messages.push(`measured primary light mutable-prose total: ${light.mutableProseTotal} tokens`);
    messages.push(
        `ratified ceilings: full=${RATIFIED_FULL_MUTABLE_PROSE_CEILING}, light=${RATIFIED_LIGHT_MUTABLE_PROSE_CEILING} tokens`,
    );

    const fullGuidanceTokens = surface.primary.guidance.full.tokens;
    const fullDescriptionTokens = baseline - fullGuidanceTokens;
    const lightDescriptionTokens = light.mutableProseTotal - light.guidance.tokens;
    const servingMatrix = [
        {
            label: "full guidance + full descriptions",
            tokens: fullGuidanceTokens + fullDescriptionTokens,
            ceiling: RATIFIED_FULL_MUTABLE_PROSE_CEILING,
        },
        {
            label: "full guidance + light descriptions",
            tokens: fullGuidanceTokens + lightDescriptionTokens,
            ceiling: RATIFIED_FULL_MUTABLE_PROSE_CEILING,
        },
        {
            label: "light guidance + full descriptions",
            tokens: light.guidance.tokens + fullDescriptionTokens,
            ceiling: RATIFIED_FULL_MUTABLE_PROSE_CEILING,
        },
        {
            label: "light guidance + light descriptions",
            tokens: light.mutableProseTotal,
            ceiling: RATIFIED_LIGHT_MUTABLE_PROSE_CEILING,
        },
    ];
    for (const state of servingMatrix) {
        messages.push(`serving matrix ${state.label}: ${state.tokens}/${state.ceiling} tokens`);
        if (state.tokens > state.ceiling) {
            errors.push(`${state.label} total ${state.tokens} exceeds ceiling ${state.ceiling}`);
        }
    }

    const ccLight = options.ccLightAssetPaths
        ? options.ccLightAssetPaths.map((path) => ({ path, text: readFileSync(resolve(path), "utf8") }))
        : [true, false].map((reduce) => ({
              path: `catalog:head/${reduce ? "reduce" : "no_reduce"}/light`,
              text: enabledCatalogGuidance(reduce, "light"),
          }));
    for (const { path, text } of ccLight) {
        const measurement = measurePromptSurfaceText(text);
        messages.push(`Claude Code light guidance ${path}: ${measurement.tokens} tokens`);
        if (measurement.tokens > RATIFIED_LIGHT_MUTABLE_PROSE_CEILING) {
            errors.push(
                `Claude Code light guidance ${path} total ${measurement.tokens} exceeds ceiling ${RATIFIED_LIGHT_MUTABLE_PROSE_CEILING}`,
            );
        }
    }

    if (errors.length === 0) {
        messages.unshift(
            `budget fixture matches source: baseline ${baseline}, ratified light ceiling ${RATIFIED_LIGHT_MUTABLE_PROSE_CEILING}`,
        );
    }
    return { errors, messages };
}
