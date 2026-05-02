import { describe, expect, it } from "bun:test";
import { buildMagicContextSection } from "./magic-context-prompt";

const CAVEMAN_MARKER = "BEWARE";
const CAVEMAN_PHRASE_TAIL = "consciously revert to full sentences";

const KNOWN_AGENT_IDENTITIES = [
    "sisyphus",
    "atlas",
    "hephaestus",
    "sisyphus-junior",
    "oracle",
    "athena",
    "athena-junior",
] as const;

describe("buildMagicContextSection — generic guidance", () => {
    it("emits the same generic guidance for all known agent identities", () => {
        const generic = buildMagicContextSection(null, 20, true, false, true, false, false);

        for (const agent of KNOWN_AGENT_IDENTITIES) {
            expect(buildMagicContextSection(agent, 20, true, false, true, false, false)).toBe(
                generic,
            );
        }
    });

    it("does not emit legacy agent-tailored guidance", () => {
        const out = buildMagicContextSection("atlas", 20, true, false, true, false, false);

        expect(out).toContain("### Reduction Triggers");
        expect(out).toContain("Your current task requirements and constraints");
        expect(out).not.toContain("CRITICAL — you run long sessions");
        expect(out).not.toContain("delegation tool outputs from completed waves");
        expect(out).not.toContain("council member response outputs");
    });
});

describe("buildMagicContextSection — caveman compression warning", () => {
    it("emits the warning when caveman is enabled AND ctx_reduce is disabled", () => {
        const out = buildMagicContextSection(
            null, // agent
            20, // protectedTags (ignored in no-reduce path)
            false, // ctxReduceEnabled
            false, // dreamerEnabled
            true, // dropToolStructure
            false, // temporalAwarenessEnabled
            true, // cavemanTextCompressionEnabled
        );
        expect(out).toContain(CAVEMAN_MARKER);
        expect(out).toContain(CAVEMAN_PHRASE_TAIL);
        expect(out).toContain("DO NOT mimic this style");
    });

    it("omits the warning when caveman is disabled (ctx_reduce off)", () => {
        const out = buildMagicContextSection(
            null,
            20,
            false, // ctxReduceEnabled
            false,
            true,
            false,
            false, // cavemanTextCompressionEnabled = false
        );
        expect(out).not.toContain(CAVEMAN_MARKER);
        expect(out).not.toContain(CAVEMAN_PHRASE_TAIL);
    });

    it("omits the warning when ctx_reduce is enabled, even if caveman flag is true", () => {
        // Belt-and-braces: caveman never runs when ctx_reduce is enabled, so
        // the warning would be misleading. Verify the guard still holds even
        // if upstream wiring slips.
        const out = buildMagicContextSection(
            null,
            20,
            true, // ctxReduceEnabled
            false,
            true,
            false,
            true, // cavemanTextCompressionEnabled
        );
        expect(out).not.toContain(CAVEMAN_MARKER);
        expect(out).not.toContain(CAVEMAN_PHRASE_TAIL);
    });

    it("omits the warning by default (parameter optional)", () => {
        // Old callers that didn't pass the new parameter must continue to
        // produce identical output (no warning leaked into legacy paths).
        const out = buildMagicContextSection(null, 20, false, false, true, false);
        expect(out).not.toContain(CAVEMAN_MARKER);
    });
});
