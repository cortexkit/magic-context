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
        it("#given well-formed §N§ pair in middle of text #when handler runs #then strips § chars but leaves digits", async () => {
            const handler = createTextCompleteHandler();
            const output = { text: `Looking at ${SECTION}40827${SECTION} the result is X` };
            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);
            // Mid-text cargo-cult: only § is removed; digits stay as plain text.
            // The hostile MC-notation signal (the § character) is gone.
            expect(output.text).toBe("Looking at 40827 the result is X");
        });

        it('#given malformed §N"> hybrid in middle of text #when handler runs #then removes the § character', async () => {
            const handler = createTextCompleteHandler();
            const output = { text: `Hello ${SECTION}40827">Oracle confirmed` };
            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);
            // The "> survives — only § is stripped from the hybrid pattern.
            expect(output.text).toBe(`Hello 40827">Oracle confirmed`);
        });

        it("#given stray § character anywhere #when handler runs #then removes it", async () => {
            const handler = createTextCompleteHandler();
            const output = { text: `See ${SECTION} marker for details` };
            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);
            expect(output.text).toBe("See  marker for details");
        });

        it("#given leading prefix + mid-text cargo-cult #when handler runs #then strips leading prefix and § from cargo-cult", async () => {
            const handler = createTextCompleteHandler();
            const output = {
                text: `${SECTION}42${SECTION} The pattern ${SECTION}40827${SECTION} appeared.`,
            };
            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);
            // Leading "§42§ " removed cleanly; mid-text "§40827§" loses its § only.
            expect(output.text).toBe("The pattern 40827 appeared.");
        });

        it("#given multiple mid-text cargo-cult occurrences #when handler runs #then removes all § chars", async () => {
            const handler = createTextCompleteHandler();
            const output = {
                text: `First ${SECTION}100${SECTION}, then ${SECTION}200${SECTION}, finally ${SECTION}300${SECTION}.`,
            };
            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);
            expect(output.text).toBe("First 100, then 200, finally 300.");
        });
    });

    describe("legitimate § usage", () => {
        it("#given §-prefixed section reference (§5.1) #when handler runs #then strips § (cosmetic loss, by design)", async () => {
            const handler = createTextCompleteHandler();
            const output = { text: `As described in ${SECTION}5.1 of the plan` };
            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);
            // V7 plan section refs become "5.1" without §; still readable in context.
            // Models will adopt alternatives like "Section 5.1" or "[5.1]" naturally.
            expect(output.text).toBe("As described in 5.1 of the plan");
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
