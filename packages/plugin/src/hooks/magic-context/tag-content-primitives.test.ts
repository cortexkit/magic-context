import { describe, expect, it } from "bun:test";
import { byteSize, isThinkingPart, prependTag, stripTagPrefix } from "./tag-content-primitives";

describe("stripTagPrefix", () => {
    describe("well-formed prefixes", () => {
        it("strips a single tag", () => {
            expect(stripTagPrefix("§42§ hello")).toBe("hello");
        });

        it("strips multiple adjacent tags", () => {
            expect(stripTagPrefix("§42§ §43§ hello")).toBe("hello");
        });

        it("leaves text without a leading tag untouched", () => {
            expect(stripTagPrefix("hello world")).toBe("hello world");
        });

        it("leaves mid-text tag tokens untouched", () => {
            expect(stripTagPrefix("see §100§ for context")).toBe("see §100§ for context");
        });

        it("returns empty string as-is", () => {
            expect(stripTagPrefix("")).toBe("");
        });
    });

    describe("malformed prefixes (repair)", () => {
        // Production-captured failure modes: some models occasionally emit
        // `§N">§N§` (same-number repeat with `">`) or `§N">§` (stub) at the
        // start of an assistant text part, created by token confusion between
        // our `§N§` tag syntax and the quoted `"N">` compartment attributes
        // the model sees in <session-history>.
        //
        // Without repair these prefixes persist through re-tagging: the next
        // pass's prependTag can't recognize them, leaves them in place, and
        // stacks a fresh `§newN§` in front — reinforcing the bad pattern in
        // context for every subsequent turn.

        it('strips the same-number-repeat variant (§N">§N§)', () => {
            expect(stripTagPrefix('§15298">§15298§ Confirmed — every OpenCode restart')).toBe(
                "Confirmed — every OpenCode restart",
            );
        });

        it('strips the partial stub variant (§N">§)', () => {
            expect(stripTagPrefix('§15298">§ Confirmed — every OpenCode restart')).toBe(
                "Confirmed — every OpenCode restart",
            );
        });

        it("strips the partial stub followed by a well-formed tag", () => {
            expect(stripTagPrefix('§15298">§ §15298§ hello')).toBe("hello");
        });

        it("strips a malformed prefix followed by a well-formed tag of different N", () => {
            expect(stripTagPrefix('§13336">§ §13337§ Now I have enough understanding')).toBe(
                "Now I have enough understanding",
            );
        });

        it("strips multiple consecutive malformed prefixes", () => {
            expect(stripTagPrefix('§100">§100§ §200">§200§ body')).toBe("body");
        });

        it("leaves mid-text malformed tokens untouched (only the anchor matters)", () => {
            // Only start-of-string malformed prefixes are stripped; a stray
            // mid-text `§N">§` is preserved because the agent likely meant
            // to quote or discuss it.
            expect(stripTagPrefix('hello §15298">§15298§ world')).toBe(
                'hello §15298">§15298§ world',
            );
        });

        it("handles malformed prefix with no body (empty after strip)", () => {
            expect(stripTagPrefix('§15298">§15298§')).toBe("");
            expect(stripTagPrefix('§15298">§')).toBe("");
        });

        it("handles malformed prefix with only trailing whitespace after", () => {
            expect(stripTagPrefix('§15298">§15298§ ')).toBe("");
        });
    });
});

describe("prependTag", () => {
    it("prepends a fresh tag to plain text", () => {
        expect(prependTag(1, "hello")).toBe("§1§ hello");
    });

    it("strips an existing well-formed tag before prepending", () => {
        expect(prependTag(2, "§1§ hello")).toBe("§2§ hello");
    });

    it("strips a malformed prefix before prepending (no double-tag accumulation)", () => {
        // This is the critical regression guard. Before the fix, a message
        // with a malformed prefix would get a new §N§ prepended without the
        // malformed part being stripped, producing "§2§ §1\">§1§ hello" —
        // the malformed shape would then persist and reinforce through every
        // future re-tagging pass.
        expect(prependTag(2, '§1">§1§ hello')).toBe("§2§ hello");
        expect(prependTag(2, '§1">§ hello')).toBe("§2§ hello");
    });

    it("strips both malformed and well-formed prefixes before prepending", () => {
        expect(prependTag(5, '§1">§ §2§ hello')).toBe("§5§ hello");
    });
});

describe("byteSize", () => {
    it("returns 0 for empty string", () => {
        expect(byteSize("")).toBe(0);
    });

    it("counts ASCII bytes", () => {
        expect(byteSize("hello")).toBe(5);
    });

    it("counts multi-byte UTF-8 characters correctly", () => {
        // § is 2 bytes in UTF-8 (U+00A7), — is 3 bytes (U+2014).
        expect(byteSize("§")).toBe(2);
        expect(byteSize("—")).toBe(3);
    });
});

describe("isThinkingPart", () => {
    it("identifies thinking parts", () => {
        expect(isThinkingPart({ type: "thinking", thinking: "..." })).toBe(true);
        expect(isThinkingPart({ type: "reasoning", text: "..." })).toBe(true);
    });

    it("rejects non-thinking parts", () => {
        expect(isThinkingPart({ type: "text", text: "hello" })).toBe(false);
        expect(isThinkingPart({ type: "tool" })).toBe(false);
    });

    it("rejects non-objects", () => {
        expect(isThinkingPart(null)).toBe(false);
        expect(isThinkingPart(undefined)).toBe(false);
        expect(isThinkingPart("string")).toBe(false);
        expect(isThinkingPart(42)).toBe(false);
    });
});
