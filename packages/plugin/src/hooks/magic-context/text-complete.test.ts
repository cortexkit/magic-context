import { describe, expect, it } from "bun:test";

import { createTextCompleteHandler } from "./text-complete";

const SECTION = "\u00a7"; // U+00A7, the section sign character used in MC tag prefixes.

describe("text-complete handler", () => {
    describe("leading tag prefix (canonical MC tagger output)", () => {
        it("#given text with leading §N§ prefix #when handler runs #then strips the full tag pair", async () => {
            const handler = createTextCompleteHandler();

            const output = { text: `${SECTION}42${SECTION} Hello world` };

            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

            expect(output.text).toBe("Hello world");
        });

        it("#given text with consecutive different leading tags #when handler runs #then strips all of them", async () => {
            const handler = createTextCompleteHandler();

            const output = { text: `${SECTION}55${SECTION} ${SECTION}56${SECTION} Response text` };

            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

            expect(output.text).toBe("Response text");
        });

        it("#given text with double identical leading tags #when handler runs #then strips both", async () => {
            const handler = createTextCompleteHandler();

            const output = {
                text: `${SECTION}56${SECTION} ${SECTION}56${SECTION} Bailan Kimi 2.5 done`,
            };

            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

            expect(output.text).toBe("Bailan Kimi 2.5 done");
        });

        it("#given large tag number #when handler runs #then strips correctly", async () => {
            const handler = createTextCompleteHandler();

            const output = { text: `${SECTION}999${SECTION} Large tag content` };

            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

            expect(output.text).toBe("Large tag content");
        });

        it("#given tag prefix without trailing space #when handler runs #then strips it", async () => {
            const handler = createTextCompleteHandler();

            const output = { text: `${SECTION}42${SECTION}Response without space` };

            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

            expect(output.text).toBe("Response without space");
        });
    });

    describe("cargo-culted tag emission (models mimicking MC tag notation mid-text)", () => {
        it("#given well-formed §N§ pair in middle of text #when handler runs #then removes whole pair", async () => {
            const handler = createTextCompleteHandler();

            const output = { text: `Looking at ${SECTION}40827${SECTION} the result is X` };

            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

            expect(output.text).toBe("Looking at  the result is X");
        });

        it('#given malformed §N"> hybrid in middle of text #when handler runs #then removes hybrid', async () => {
            const handler = createTextCompleteHandler();

            const output = { text: `Hello ${SECTION}40827">Oracle confirmed` };

            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

            expect(output.text).toBe("Hello Oracle confirmed");
        });

        it("#given stray § character anywhere #when handler runs #then removes it", async () => {
            const handler = createTextCompleteHandler();

            const output = { text: `See ${SECTION} marker for details` };

            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

            expect(output.text).toBe("See  marker for details");
        });

        it("#given leading prefix + mid-text cargo-cult #when handler runs #then cleans both", async () => {
            const handler = createTextCompleteHandler();

            const output = {
                text: `${SECTION}42${SECTION} The pattern ${SECTION}40827${SECTION} appeared.`,
            };

            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

            expect(output.text).toBe("The pattern  appeared.");
        });

        it("#given multiple mid-text cargo-cult occurrences #when handler runs #then removes all pairs", async () => {
            const handler = createTextCompleteHandler();

            const output = {
                text: `First ${SECTION}100${SECTION}, then ${SECTION}200${SECTION}, finally ${SECTION}300${SECTION}.`,
            };

            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

            expect(output.text).toBe("First , then , finally .");
        });
    });

    describe("legitimate § usage", () => {
        it("#given §-prefixed section reference (§5.1) #when handler runs #then strips § (cosmetic loss, by design)", async () => {
            const handler = createTextCompleteHandler();

            const output = { text: `As described in ${SECTION}5.1 of the plan` };

            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

            expect(output.text).toBe("As described in 5.1 of the plan");
        });
    });

    describe("bare digit residue (no § — not stripped at persistence)", () => {
        it("#given accumulated digit residue without § #when handler runs #then preserves digits", async () => {
            const handler = createTextCompleteHandler();

            const output = { text: `2030  2030  2030\u00b0 Run clippy` };

            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

            expect(output.text).toBe(`2030  2030  2030\u00b0 Run clippy`);
        });

        it("#given short leading tag-like numbers #when handler runs #then preserves them", async () => {
            const handler = createTextCompleteHandler();

            const output = { text: "99  Actually executing now. Running fmt:" };

            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

            expect(output.text).toBe("99  Actually executing now. Running fmt:");
        });

        it("#given repeated well-formed prefixes #when handler runs #then fully cleans text", async () => {
            const handler = createTextCompleteHandler();

            const output = { text: `${SECTION}2030${SECTION} ${SECTION}2030${SECTION} Run` };

            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

            expect(output.text).toBe("Run");
        });
    });

    describe("no-op cases", () => {
        it("#given plain text without any § #when handler runs #then text is unchanged", async () => {
            const handler = createTextCompleteHandler();

            const output = { text: "No tag here, just normal text" };

            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

            expect(output.text).toBe("No tag here, just normal text");
        });

        it("#given empty text #when handler runs #then stays empty", async () => {
            const handler = createTextCompleteHandler();

            const output = { text: "" };

            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

            expect(output.text).toBe("");
        });
    });
});
