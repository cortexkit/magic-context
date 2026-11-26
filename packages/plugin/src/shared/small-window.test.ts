import { describe, expect, test } from "bun:test";
import {
    formatSmallWindowCondition,
    reductionPointTokens,
    smallWindowCondition,
} from "./small-window";

describe("small-window condition", () => {
    test("the reporter's numbers warn: 72% of the reduction point", () => {
        // Issue 860: usable 45,000 at the default 65% threshold.
        const reductionPoint = reductionPointTokens(45_000, 65);
        expect(reductionPoint).toBe(29_250);
        const condition = smallWindowCondition({
            systemPromptTokens: 6_062,
            toolDefinitionTokens: 15_134,
            reductionPointTokens: reductionPoint,
        });
        expect(condition).toEqual({
            systemPromptTokens: 6_062,
            toolDefinitionTokens: 15_134,
            reductionPointTokens: 29_250,
        });
        expect(formatSmallWindowCondition(condition!, "litellm/proxy-model")).toBe(
            "Context window too small for litellm/proxy-model: the system prompt (6,062 tokens) and tool definitions (15,134 tokens) take 72% of the 29,250 tokens at which reduction starts, leaving about 8,054 tokens for the conversation. Raise the model's context setting or remove tools.",
        );
    });

    test("49% of the reduction point does not warn", () => {
        expect(
            smallWindowCondition({
                systemPromptTokens: 4_000,
                toolDefinitionTokens: 10_332,
                reductionPointTokens: 29_250,
            }),
        ).toBeNull();
    });

    test("any unknown number says nothing", () => {
        for (const unknown of [0, undefined, Number.NaN]) {
            expect(
                smallWindowCondition({
                    systemPromptTokens: unknown,
                    toolDefinitionTokens: 15_134,
                    reductionPointTokens: 1_000,
                }),
            ).toBeNull();
            expect(
                smallWindowCondition({
                    systemPromptTokens: 6_062,
                    toolDefinitionTokens: 15_134,
                    reductionPointTokens: unknown,
                }),
            ).toBeNull();
            expect(reductionPointTokens(unknown, 65)).toBeUndefined();
            expect(reductionPointTokens(45_000, unknown)).toBeUndefined();
        }
        for (const unknown of [undefined, Number.NaN, -1]) {
            expect(
                smallWindowCondition({
                    systemPromptTokens: 6_062,
                    toolDefinitionTokens: unknown,
                    reductionPointTokens: 1_000,
                }),
            ).toBeNull();
        }
    });

    test("a measured tool count of zero is known: a large system prompt alone warns", () => {
        expect(
            smallWindowCondition({
                systemPromptTokens: 20_000,
                toolDefinitionTokens: 0,
                reductionPointTokens: 30_000,
            }),
        ).toEqual({
            systemPromptTokens: 20_000,
            toolDefinitionTokens: 0,
            reductionPointTokens: 30_000,
        });
    });
});
