import { describe, expect, test } from "bun:test";
import { cavemanCompress } from "./caveman";

describe("cavemanCompress", () => {
    describe("empty and passthrough", () => {
        test("empty string returns empty", () => {
            expect(cavemanCompress("", "lite")).toBe("");
            expect(cavemanCompress("", "full")).toBe("");
            expect(cavemanCompress("", "ultra")).toBe("");
        });

        test("text with no filler survives lite", () => {
            const input = "Fixed bug in handler.";
            expect(cavemanCompress(input, "lite")).toBe("Fixed bug in handler.");
        });
    });

    describe("preservation", () => {
        test("code blocks preserved at all levels", () => {
            const input = "Look at `const x = 1` for reference.";
            expect(cavemanCompress(input, "lite")).toContain("`const x = 1`");
            expect(cavemanCompress(input, "full")).toContain("`const x = 1`");
            expect(cavemanCompress(input, "ultra")).toContain("`const x = 1`");
        });

        test("fenced code blocks preserved", () => {
            const input = "Try this:\n```ts\nconst x = 1;\n```\nIt works.";
            const out = cavemanCompress(input, "ultra");
            expect(out).toContain("```ts\nconst x = 1;\n```");
        });

        test("URLs preserved", () => {
            const input = "See https://github.com/cortexkit/magic-context for details.";
            expect(cavemanCompress(input, "ultra")).toContain(
                "https://github.com/cortexkit/magic-context",
            );
        });

        test("file paths preserved", () => {
            const input = "Fix the bug in src/hooks/magic-context/transform.ts.";
            expect(cavemanCompress(input, "ultra")).toContain(
                "src/hooks/magic-context/transform.ts",
            );
        });

        test("commit hashes preserved", () => {
            const input = "Committed as ffa0997b, replayed as bcd8816e.";
            const out = cavemanCompress(input, "ultra");
            expect(out).toContain("ffa0997b");
            expect(out).toContain("bcd8816e");
        });

        test("magic-context tags preserved", () => {
            const input = "See §1234§ for context.";
            expect(cavemanCompress(input, "ultra")).toContain("§1234§");
        });

        test("opencode IDs preserved", () => {
            const input = "In session ses_331acff95ff the issue was seen.";
            expect(cavemanCompress(input, "ultra")).toContain("ses_331acff95ff");
        });

        test("U: lines preserved verbatim at all levels", () => {
            const input =
                "Narrative text that was really quite verbose.\nU: We should not touch the protected area\nMore narrative.";
            const out = cavemanCompress(input, "ultra");
            expect(out).toContain("U: We should not touch the protected area");
        });

        test("U: lines preserved even when they contain filler words", () => {
            const input = "Some narrative.\nU: I just really think we should do this.\n";
            const out = cavemanCompress(input, "ultra");
            // The U: line content must stay verbatim, filler-words-and-all.
            expect(out).toContain("U: I just really think we should do this.");
        });
    });

    describe("lite level", () => {
        test("drops filler words", () => {
            const input = "The fix was really just a one-line change.";
            const out = cavemanCompress(input, "lite");
            expect(out).not.toContain("really");
            expect(out).not.toContain("just");
            // Articles kept at lite.
            expect(out.toLowerCase()).toContain("the");
        });

        test("drops hedging phrases", () => {
            const input = "I think probably the cache is stale.";
            const out = cavemanCompress(input, "lite");
            expect(out.toLowerCase()).not.toContain("i think");
            expect(out.toLowerCase()).not.toContain("probably");
        });

        test("drops pleasantries", () => {
            const input = "Please check the thanks of the log.";
            const out = cavemanCompress(input, "lite");
            expect(out.toLowerCase()).not.toMatch(/\bplease\b/);
            expect(out.toLowerCase()).not.toMatch(/\bthanks\b/);
        });

        test("applies phrase shortenings", () => {
            const input = "We did this in order to fix the bug.";
            const out = cavemanCompress(input, "lite");
            expect(out).toContain(" to ");
            expect(out).not.toContain("in order to");
        });

        test("keeps articles at lite level", () => {
            const input = "Fixed the auth middleware.";
            const out = cavemanCompress(input, "lite");
            expect(out.toLowerCase()).toContain("the");
        });
    });

    describe("full level", () => {
        test("drops filler (inherits lite)", () => {
            const input = "The fix was really a change.";
            const out = cavemanCompress(input, "full");
            expect(out).not.toContain("really");
        });

        test("drops articles", () => {
            const input = "Fixed the auth middleware in a session.";
            const out = cavemanCompress(input, "full");
            expect(out.toLowerCase()).not.toMatch(/\bthe\b/);
            expect(out.toLowerCase()).not.toMatch(/\ba\b/);
        });

        test("drops auxiliaries in subject-aux-verb patterns", () => {
            const input = "The historian was compressed successfully.";
            const out = cavemanCompress(input, "full");
            // "was" should be dropped since it's before a participle.
            expect(out.toLowerCase()).not.toMatch(/\bwas\b/);
            expect(out.toLowerCase()).toContain("compressed");
        });

        test("preserves code even when surrounding prose is heavily compressed", () => {
            const input = "The config key `execute_threshold_percentage` was added.";
            const out = cavemanCompress(input, "full");
            expect(out).toContain("`execute_threshold_percentage`");
        });
    });

    describe("ultra level", () => {
        test("replaces connectives with symbols", () => {
            const input = "Fixed bug and shipped release and updated docs.";
            const out = cavemanCompress(input, "ultra");
            expect(out).toContain(" + ");
        });

        test("replaces 'then' with arrow", () => {
            const input = "Committed and then pushed.";
            const out = cavemanCompress(input, "ultra");
            // "and then" → "→"
            expect(out).toContain("→");
        });

        test("abbreviates common repeat terms when >= 3 uses", () => {
            const input =
                "The historian ran. Then historian retried. Then historian succeeded. Historian finished.";
            const out = cavemanCompress(input, "ultra");
            // historian appears 4 times → should be abbreviated to "hist"
            expect(out.toLowerCase()).toMatch(/\bhist\b/);
            expect(out.toLowerCase()).not.toMatch(/\bhistorian\b/);
        });

        test("does NOT abbreviate if term appears fewer than 3 times", () => {
            const input = "The historian ran once.";
            const out = cavemanCompress(input, "ultra");
            // historian appears only once → keeps original
            expect(out.toLowerCase()).toContain("historian");
        });

        test("preserves capitalization when abbreviating", () => {
            const input = "Historian started. Historian ran. Historian finished successfully.";
            const out = cavemanCompress(input, "ultra");
            // All three are sentence-initial; abbreviation should be capitalized
            expect(out).toContain("Hist");
        });
    });

    describe("cumulative compression: full output smaller than lite, ultra smallest", () => {
        const sample =
            "The historian was really running in the background, and it was producing compartments for the session. Basically, the compressor was then merging them in order to fit the budget. Therefore, the output tokens were reduced significantly.";

        test("lite shorter than original", () => {
            const out = cavemanCompress(sample, "lite");
            expect(out.length).toBeLessThan(sample.length);
        });

        test("full shorter than lite", () => {
            const lite = cavemanCompress(sample, "lite");
            const full = cavemanCompress(sample, "full");
            expect(full.length).toBeLessThan(lite.length);
        });

        test("ultra shorter than full", () => {
            const full = cavemanCompress(sample, "full");
            const ultra = cavemanCompress(sample, "ultra");
            expect(ultra.length).toBeLessThan(full.length);
        });

        test("ultra achieves at least 30% reduction on verbose prose", () => {
            const out = cavemanCompress(sample, "ultra");
            const reduction = 1 - out.length / sample.length;
            expect(reduction).toBeGreaterThanOrEqual(0.3);
        });
    });

    describe("whitespace normalization", () => {
        test("collapses multiple spaces after removals", () => {
            const input = "Fixed  the   really   bad   bug.";
            const out = cavemanCompress(input, "lite");
            expect(out).not.toMatch(/ {2,}/);
        });

        test("trims trailing whitespace on lines", () => {
            const input = "Line one.   \nLine two.";
            const out = cavemanCompress(input, "lite");
            expect(out).not.toMatch(/ \n/);
        });

        test("caps consecutive blank lines to 1", () => {
            const input = "Para one.\n\n\n\nPara two.";
            const out = cavemanCompress(input, "lite");
            expect(out).not.toMatch(/\n\n\n/);
        });
    });

    describe("real-world compartment content", () => {
        test("V4-style compartment at ultra level", () => {
            const input =
                "Committed the live-notification-params fix on feat/context-management as ffa0997b, replayed it onto integrate/athena-context-management as bcd8816e, and rebuilt both branches successfully. The replay was clean; the only remaining integrate dirt was an unrelated pre-existing src/shared/context-limit-resolver.ts modification.";
            const out = cavemanCompress(input, "ultra");
            // Technical identifiers preserved.
            expect(out).toContain("ffa0997b");
            expect(out).toContain("bcd8816e");
            expect(out).toContain("src/shared/context-limit-resolver.ts");
            // Output shorter than input.
            expect(out.length).toBeLessThan(input.length);
        });

        test("mixed narrative + U: line preserves U: exactly", () => {
            const input =
                "Fixed the really annoying cache bug in the transform. The fix preserved message order.\nU: We need to make sure the protected tail is not touched.\nCommitted and pushed.";
            const out = cavemanCompress(input, "ultra");
            expect(out).toContain("U: We need to make sure the protected tail is not touched.");
        });
    });
});
