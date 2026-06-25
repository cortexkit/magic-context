import { describe, expect, test } from "bun:test";

import { extractToolCallSummaries } from "./read-session-formatting";

describe("extractToolCallSummaries — skill tool", () => {
    test("surfaces the skill name as TC: skill(<name>)", () => {
        const parts = [
            {
                type: "tool",
                tool: "skill",
                state: { input: { name: "test-driven-development" }, metadata: {} },
            },
        ];

        expect(extractToolCallSummaries(parts)).toEqual(["TC: skill(test-driven-development)"]);
    });

    test("skill branch wins even if metadata.description is present (regression-proof)", () => {
        const parts = [
            {
                type: "tool",
                tool: "skill",
                state: { input: { name: "council" }, metadata: { description: "Load skill" } },
            },
        ];

        expect(extractToolCallSummaries(parts)).toEqual(["TC: skill(council)"]);
    });

    test("skill with no name falls through to bare TC: skill", () => {
        const parts = [{ type: "tool", tool: "skill", state: { input: {}, metadata: {} } }];

        expect(extractToolCallSummaries(parts)).toEqual(["TC: skill"]);
    });

    test("preserves a skill name containing ')' verbatim (does not drop the marker)", () => {
        // A ")" doesn't break the single-line marker and the historian reads it as
        // natural language — preserve the name (identity key) rather than drop it.
        const parts = [
            {
                type: "tool",
                tool: "skill",
                state: { input: { name: "weird(name)" }, metadata: {} },
            },
        ];
        expect(extractToolCallSummaries(parts)).toEqual(["TC: skill(weird(name))"]);
    });

    test("drops the name only when it contains a real line-breaker (CR/LF/tab)", () => {
        const parts = [
            { type: "tool", tool: "skill", state: { input: { name: "bad\nname" }, metadata: {} } },
        ];
        expect(extractToolCallSummaries(parts)).toEqual(["TC: skill"]);
    });
});
