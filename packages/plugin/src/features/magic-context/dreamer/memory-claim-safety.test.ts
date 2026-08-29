import { describe, expect, test } from "bun:test";

import { isDirectiveShapedProjectRule } from "./memory-claim-safety";

describe("isDirectiveShapedProjectRule", () => {
    test("recognizes explicit workflow shapes in PROJECT_RULES", () => {
        const directives = [
            "When told to check a cache bust, run scripts/analyze-cache-busts.ts first.",
            "Always inspect the generated manifest before reasoning by hand.",
            "Use the audit tool first, then brief workers with its output.",
            "We must ask the operator before changing the public contract.",
            "The user decides whether release evidence is sufficient.",
        ];

        for (const content of directives) {
            expect(isDirectiveShapedProjectRule("PROJECT_RULES", content)).toBe(true);
        }
    });

    test("leaves declarative code facts and other categories verifiable", () => {
        expect(
            isDirectiveShapedProjectRule(
                "PROJECT_RULES",
                "binds use spread args when invoking registered callbacks.",
            ),
        ).toBe(false);
        expect(
            isDirectiveShapedProjectRule(
                "CONSTRAINTS",
                "Always pass spread args when invoking registered callbacks.",
            ),
        ).toBe(false);
    });
});
