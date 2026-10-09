import { expect, it } from "bun:test";
import {
    captureOpencodeReasoningBudgetStatus,
    formatReasoningBudgetStatus,
    reasoningBudgetStatusLine,
} from "./reasoning-budget-status";
import type { MessageLike } from "./tag-messages";

it("unsupported native status observations cannot refuse a validated module response", () => {
    expect(() =>
        captureOpencodeReasoningBudgetStatus(
            "unsupported-status",
            [{ role: "system", content: [] }] as unknown as MessageLike[],
            10000,
            false,
        ),
    ).not.toThrow();
    expect(reasoningBudgetStatusLine("unsupported-status")).toBeUndefined();
});

it("reasoning status renders reported, estimated, and both legitimate overrun labels", () => {
    expect(formatReasoningBudgetStatus({ kept: 8400, budget: 10000, estimated: false })).toBe(
        "Reasoning kept: 8.4k of 10k (reported)",
    );
    expect(formatReasoningBudgetStatus({ kept: 8400, budget: 10000, estimated: true })).toContain(
        "(estimated)",
    );
    expect(
        formatReasoningBudgetStatus({
            kept: 12000,
            budget: 10000,
            estimated: false,
            overrun: "newest step",
        }),
    ).toContain("over budget: newest step");
    expect(
        formatReasoningBudgetStatus({
            kept: 12000,
            budget: 10000,
            estimated: true,
            overrun: "signed prefix",
        }),
    ).toContain("over budget: signed prefix");
});
