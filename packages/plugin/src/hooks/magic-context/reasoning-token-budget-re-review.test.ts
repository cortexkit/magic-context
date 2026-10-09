import { expect, it } from "bun:test";
import { estimateTokens } from "./read-session-formatting";
import { opencodeReasoningBudgetCutoff } from "./reasoning-budget";
import {
    findMergedReasoningStripDecisions,
    stripReasoningFromMergedAssistants,
} from "./strip-content";
import type { MessageLike } from "./tag-messages";

function assistant(id: string, parts: unknown[]): MessageLike {
    return { info: { id, role: "assistant", tokens: { reasoning: 0 } }, parts } as MessageLike;
}

it("re-review: a legacy partial merged strip preserves its already-served first block on upgrade", () => {
    const history = [
        assistant("legacy", [
            {
                type: "reasoning",
                text: "kept first",
                metadata: { anthropic: { signature: "sig-first" } },
            },
            { type: "text", text: "between" },
            {
                type: "reasoning",
                text: "removed second",
                metadata: { anthropic: { signature: "sig-second" } },
            },
        ]),
    ];
    // This is the pre-upgrade representation for an unchanged layout and bare
    // frozen id. Only the second block was removed; the first never left the wire.
    // No budget key or fresh-selection permission is involved in replay.
    stripReasoningFromMergedAssistants(history, "anthropic", {
        frozenMessageIds: new Set(["legacy"]),
    });
    expect(history[0].parts).toEqual([
        {
            type: "reasoning",
            text: "kept first",
            metadata: { anthropic: { signature: "sig-first" } },
        },
        { type: "text", text: "between" },
        { type: "text", text: "" },
    ]);
});

it("re-review control: exact merged parts charge the retained sibling with calibration exactly once", () => {
    const retained = "kept first thought ".repeat(40);
    const history = [
        assistant("partial", [
            { id: "kept", type: "reasoning", text: retained },
            { type: "text", text: "between" },
            { id: "gone", type: "reasoning", text: "removed large thought ".repeat(1000) },
        ]),
        {
            info: { id: "u", role: "user" },
            parts: [{ type: "text", text: "follow-up" }],
        } as MessageLike,
        assistant("newest", [
            { type: "reasoning", text: "new thought" },
            { type: "text", text: "answer" },
        ]),
    ];
    const frozen = new Set(
        findMergedReasoningStripDecisions(history, "anthropic", new Set(), {
            mutationExemptMessage: history[2],
        }),
    );
    expect(frozen.has("partial")).toBe(true);
    const ratio = 2;
    const budget = (estimateTokens(retained) + estimateTokens("new thought")) * ratio;
    const args = {
        messages: history,
        messageTagNumbers: new Map(history.map((message, i) => [message, i + 1])),
        proseRatio: ratio,
        frozenMergedIds: frozen,
        // A pre-calibrated legacy DB projection must not be added to live text,
        // applied twice, or used in place of the exact kept-part estimate.
        textEstimateByMessageId: new Map([["partial", budget * 100]]),
    };
    const before = JSON.stringify(history);
    expect(opencodeReasoningBudgetCutoff({ ...args, budget })).toBe(0);
    expect(opencodeReasoningBudgetCutoff({ ...args, budget: budget - 1 })).toBe(1);
    expect(JSON.stringify(history)).toBe(before);
});
