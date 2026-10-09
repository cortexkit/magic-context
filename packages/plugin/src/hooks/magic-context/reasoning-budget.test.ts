import { describe, expect, it } from "bun:test";
import golden from "../../../../../crates/mc-module/testdata/reasoning-budget-trim.json";
import { parsePluginConfig } from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import {
    reasoningBudgetCutoff,
    reasoningStepCost,
    resolveKeepReasoningTokens,
} from "./reasoning-budget";

describe("reasoning token budget", () => {
    it("OpenCode warns that deprecated age is ignored rather than converting it", () => {
        const config = parsePluginConfig({ clear_reasoning_age: 1 });
        expect(config.keep_reasoning_tokens).toBeUndefined();
        expect(config.configWarnings?.join("\n")).toContain(
            "clear_reasoning_age is deprecated and ignored",
        );
    });
    it("matches the shared whole-step budget golden", () => {
        for (const scenario of golden.cases) {
            const steps = scenario.steps.map((step) => ({
                tag: step.tag,
                cost: reasoningStepCost(
                    step.reported,
                    step.text_estimate ?? 0,
                    step.opaque === true,
                ),
                exempt: step.exempt,
                alreadyRemoved: step.already_removed,
            }));
            expect({
                name: scenario.name,
                cutoff: reasoningBudgetCutoff(steps, scenario.budget),
            }).toEqual({ name: scenario.name, cutoff: scenario.cutoff });
        }
    });
    it("keeps whole steps newest first and stops at the first non-fitting step", () => {
        expect(
            reasoningBudgetCutoff(
                [
                    { tag: 1, cost: 1 },
                    { tag: 2, cost: 8 },
                    { tag: 3, cost: 4 },
                    { tag: 4, cost: 2, exempt: true },
                ],
                7,
            ),
        ).toBe(2);
    });
    it("counts exempt steps but never removes them even above budget", () => {
        expect(
            reasoningBudgetCutoff(
                [
                    { tag: 1, cost: 1 },
                    { tag: 2, cost: 20, exempt: true },
                    { tag: 3, cost: 10, exempt: true },
                ],
                0,
            ),
        ).toBe(1);
    });
    it("skips reasoning already off wire and never restores it", () => {
        expect(
            reasoningBudgetCutoff(
                [
                    { tag: 1, cost: 100, alreadyRemoved: true },
                    { tag: 2, cost: 4, exempt: true },
                ],
                4,
            ),
        ).toBe(0);
    });
    it("uses the nearest older tag for an untagged non-fitting step", () => {
        expect(
            reasoningBudgetCutoff(
                [
                    { tag: 1, cost: 1 },
                    { tag: 0, cost: 50 },
                    { tag: 3, cost: 4, exempt: true },
                ],
                4,
            ),
        ).toBe(1);
    });
    it("prefers reported counts and charges opaque steps a fixed 1000, never payload bytes", () => {
        expect(reasoningStepCost(7, 99, true)).toBe(7);
        expect(reasoningStepCost(0, 99, true)).toBe(99);
        expect(reasoningStepCost(undefined, 0, true)).toBe(1000);
        expect(reasoningStepCost(0, 0, false)).toBe(0);
    });
    it("resolves exact, shorter, wildcard, default, then fixed 10000", () => {
        const config = { "openai/gpt-5-mini": 1, "openai/gpt-5": 2, "openai/*": 3, default: 4 };
        expect(resolveKeepReasoningTokens(config, "openai/gpt-5-mini")).toBe(1);
        expect(resolveKeepReasoningTokens(config, "openai/gpt-5-pro")).toBe(2);
        expect(resolveKeepReasoningTokens(config, "openai/o3")).toBe(3);
        expect(resolveKeepReasoningTokens(config, "other/model")).toBe(4);
        expect(resolveKeepReasoningTokens(undefined, "other/model")).toBe(10000);
        expect(resolveKeepReasoningTokens(0, "other/model")).toBe(0);
        expect(resolveKeepReasoningTokens({ "openai/*": 123 }, "openai/constructor")).toBe(123);
    });
    it("accepts number or model object, rejects negatives, and accepts the ignored deprecated age", () => {
        expect(
            MagicContextConfigSchema.parse({ keep_reasoning_tokens: 0 }).keep_reasoning_tokens,
        ).toBe(0);
        expect(
            MagicContextConfigSchema.parse({
                keep_reasoning_tokens: { default: 4000, "p/*": 8000 },
            }).keep_reasoning_tokens,
        ).toEqual({ default: 4000, "p/*": 8000 });
        expect(() => MagicContextConfigSchema.parse({ keep_reasoning_tokens: -1 })).toThrow();
        expect(
            MagicContextConfigSchema.parse({ clear_reasoning_age: "ignored" })
                .keep_reasoning_tokens,
        ).toBeUndefined();
    });
});
