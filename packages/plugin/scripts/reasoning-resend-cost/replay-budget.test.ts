import { expect, it } from "bun:test";
import fixture from "./budget-synthetic.json";
import { replayReasoningBudget } from "./replay-budget";

it("numeric snapshot replay compares newest-first 10k whole-step fit against age 50", () => {
    const result = replayReasoningBudget(fixture);
    expect(result[0].checkpoints.at(-1)).toEqual({ order: 2, budget_kept_tokens: 5000, budget_kept_steps: 2, age50_kept_tokens: 13000, age50_kept_steps: 3 });
    expect(result[1].checkpoints.at(-1)).toEqual({ order: 1, budget_kept_tokens: 1000, budget_kept_steps: 1, age50_kept_tokens: 10500, age50_kept_steps: 2 });
});
it("snapshot replay rejects transport payloads and duplicate step orders", () => {
    expect(() => replayReasoningBudget([{ ...fixture[0], text: "private" }])).toThrow();
    expect(() => replayReasoningBudget([fixture[0], fixture[0]])).toThrow();
});
