import { describe, expect, it } from "bun:test";
import { buildMagicContextSection } from "./magic-context-prompt";

describe("magic-context-prompt skill-memory guidance", () => {
    it("prompt includes ctx_skill_note guidance", () => {
        // Real export is buildMagicContextSection (positional args: _agent, protectedTags, ctxReduceEnabled, ...)
        const prompt = buildMagicContextSection(null, 20, true, false, false, false, false);
        expect(prompt).toContain("ctx_skill_note");
    });

    it("ctx_skill_note guidance includes worked example", () => {
        const prompt = buildMagicContextSection(null, 20, true, false, false, false, false);
        expect(prompt).toContain("kind:");
        expect(prompt).toContain("gotcha");
    });
});
