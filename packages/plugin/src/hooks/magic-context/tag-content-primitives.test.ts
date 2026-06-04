import { describe, expect, it } from "bun:test";

import {
    byteSize,
    isThinkingPart,
    peelLeadingMcTagNotation,
    prependTag,
    stripPersistedAssistantText,
    stripTagPrefix,
    stripTagSectionCharacters,
    stripWellFormedLeadingTagPrefix,
} from "./tag-content-primitives";

const SECTION = "\u00a7";

const DEGREE = "\u00b0";

describe("stripTagPrefix (transform ? ? notation only)", () => {
    it("#given well-formed leading prefix #when stripTagPrefix runs #then removes it", () => {
        expect(stripTagPrefix(`${SECTION}42${SECTION} Hello`)).toBe("Hello");
    });

    it("#given malformed xml hybrid prefix #when stripTagPrefix runs #then removes it", () => {
        expect(stripTagPrefix(`${SECTION}15298">${SECTION}15298${SECTION} hello`)).toBe("hello");
    });

    it("#given accumulated bare digit residue #when stripTagPrefix runs #then preserves digits", () => {
        expect(stripTagPrefix(`2030  2030  2030${DEGREE} Run clippy`)).toBe(
            `2030  2030  2030${DEGREE} Run clippy`,
        );
    });

    it("#given legitimate leading numbers #when stripTagPrefix runs #then preserves them", () => {
        expect(stripTagPrefix("99 files are located in folder zzz")).toBe(
            "99 files are located in folder zzz",
        );

        expect(stripTagPrefix("6 8 9 tasks from todo list completed")).toBe(
            "6 8 9 tasks from todo list completed",
        );

        expect(stripTagPrefix("1. do this now, 2. do that next")).toBe(
            "1. do this now, 2. do that next",
        );

        expect(stripTagPrefix("2024 roadmap")).toBe("2024 roadmap");
    });

    it("#given mid-text tag after bare digits #when stripTagPrefix runs #then leaves mid-text tag", () => {
        expect(stripTagPrefix(`2030  ${SECTION}42${SECTION} Hello`)).toBe(
            `2030  ${SECTION}42${SECTION} Hello`,
        );
    });
});

describe("stripPersistedAssistantText (persistence boundary)", () => {
    it("#given leading well-formed prefixes #when strip runs #then removes pairs cleanly", () => {
        expect(
            stripPersistedAssistantText(`${SECTION}2030${SECTION} ${SECTION}2030${SECTION} Run`),
        ).toBe("Run");
    });

    it("#given mid-text cargo-cult pair #when strip runs #then removes whole pair", () => {
        expect(
            stripPersistedAssistantText(`Looking at ${SECTION}40827${SECTION} the result is X`),
        ).toBe("Looking at  the result is X");
    });

    it("#given tag after bare digits #when strip runs #then removes mid-text pair only", () => {
        expect(stripPersistedAssistantText(`2030  ${SECTION}42${SECTION} Hello`)).toBe(
            "2030   Hello",
        );
    });

    it("#given malformed hybrid mid-text #when strip runs #then removes hybrid", () => {
        expect(stripPersistedAssistantText(`Hello ${SECTION}40827">Oracle confirmed`)).toBe(
            "Hello Oracle confirmed",
        );
    });

    it("#given bare digit residue without ? #when strip runs #then leaves digits", () => {
        expect(stripPersistedAssistantText(`2030  2030  2030${DEGREE} Run clippy`)).toBe(
            `2030  2030  2030${DEGREE} Run clippy`,
        );

        expect(stripPersistedAssistantText("99  Actually executing now. Running fmt:")).toBe(
            "99  Actually executing now. Running fmt:",
        );
    });
});

describe("stripWellFormedLeadingTagPrefix", () => {
    it("#given leading ?N? prefix #when stripWellFormedLeadingTagPrefix runs #then removes it", () => {
        expect(stripWellFormedLeadingTagPrefix(`${SECTION}42${SECTION} Hello`)).toBe("Hello");
    });
});

describe("stripTagSectionCharacters", () => {
    it("#given ? characters #when stripTagSectionCharacters runs #then removes them", () => {
        expect(stripTagSectionCharacters(`${SECTION}42${SECTION}`)).toBe("42");
    });
});

describe("prependTag", () => {
    it("#given bare digit residue #when prependTag runs #then does not strip digits", () => {
        expect(prependTag(7, `2030  2030  2030${DEGREE} Run clippy`)).toBe(
            `${SECTION}7${SECTION} 2030  2030  2030${DEGREE} Run clippy`,
        );
    });

    it("#given existing well-formed prefix #when prependTag runs #then replaces with new tag", () => {
        expect(prependTag(9, `${SECTION}3${SECTION} Hello`)).toBe(`${SECTION}9${SECTION} Hello`);
    });

    it("#given malformed xml hybrid prefix #when prependTag runs #then strips before prepending", () => {
        expect(prependTag(11, `${SECTION}15298">${SECTION}15298${SECTION} hello`)).toBe(
            `${SECTION}11${SECTION} hello`,
        );
    });

    it("#given legitimate numbers #when prependTag runs #then preserves them", () => {
        expect(prependTag(5, "99 files are located")).toBe(
            `${SECTION}5${SECTION} 99 files are located`,
        );
    });
});

describe("peelLeadingMcTagNotation", () => {
    it("#given leading tag prefix #when peel runs #then splits prefix and body", () => {
        expect(peelLeadingMcTagNotation(`${SECTION}3${SECTION} hello`)).toEqual({
            tagPrefix: `${SECTION}3${SECTION} `,

            body: "hello",
        });
    });

    it("#given malformed leading prefix #when peel runs #then splits raw prefix before strip", () => {
        expect(peelLeadingMcTagNotation(`${SECTION}9">${SECTION}9${SECTION} body`)).toEqual({
            tagPrefix: `${SECTION}9">${SECTION}9${SECTION} `,

            body: "body",
        });
    });
});

describe("stripPersistedAssistantText edge cases", () => {
    it("#given malformed prefix with trailing space #when strip runs #then trims result", () => {
        expect(stripPersistedAssistantText(`${SECTION}15298">§15298§ `)).toBe("");
    });

    it("#given tag-only text with trailing space #when strip runs #then returns empty", () => {
        expect(stripPersistedAssistantText(`${SECTION}42${SECTION} `)).toBe("");
    });

    it("#given whitespace-only after strip #when strip runs #then trims to empty", () => {
        expect(stripPersistedAssistantText(`   `)).toBe("");
    });
});

describe("byteSize", () => {
    it("#given ascii string #when byteSize runs #then returns byte length", () => {
        expect(byteSize("hello")).toBe(5);
    });

    it("#given empty string #when byteSize runs #then returns 0", () => {
        expect(byteSize("")).toBe(0);
    });

    it("#given multibyte string #when byteSize runs #then returns encoded byte length", () => {
        expect(byteSize("§42§")).toBe(6);
    });
});

describe("isThinkingPart", () => {
    it("#given thinking part #when isThinkingPart runs #then returns true", () => {
        expect(isThinkingPart({ type: "thinking", thinking: "..." })).toBe(true);
    });

    it("#given reasoning part #when isThinkingPart runs #then returns true", () => {
        expect(isThinkingPart({ type: "reasoning", reasoning: "..." })).toBe(true);
    });

    it("#given text part #when isThinkingPart runs #then returns false", () => {
        expect(isThinkingPart({ type: "text", text: "hello" })).toBe(false);
    });

    it("#given null #when isThinkingPart runs #then returns false", () => {
        expect(isThinkingPart(null)).toBe(false);
    });

    it("#given primitive #when isThinkingPart runs #then returns false", () => {
        expect(isThinkingPart("string")).toBe(false);
    });
});
