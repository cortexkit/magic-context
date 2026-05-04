import { describe, expect, it } from "bun:test";
import { createTextCompleteHandler } from "./text-complete";

describe("text-complete handler", () => {
    it("#given text with §N§ prefix #when handler runs #then strips the tag", async () => {
        //#given
        const handler = createTextCompleteHandler();
        const output = { text: "§42§ Hello world" };
        //#when
        await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);
        //#then
        expect(output.text).toBe("Hello world");
    });

    it("#given text without §N§ prefix #when handler runs #then text unchanged", async () => {
        //#given
        const handler = createTextCompleteHandler();
        const output = { text: "No tag here" };
        //#when
        await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);
        //#then
        expect(output.text).toBe("No tag here");
    });

    it("#given text with §N§ in middle #when handler runs #then only strips start", async () => {
        //#given
        const handler = createTextCompleteHandler();
        const output = { text: "See §5§ for details" };
        //#when
        await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);
        //#then
        expect(output.text).toBe("See §5§ for details");
    });

    it("#given text with large tag number #when handler runs #then strips correctly", async () => {
        //#given
        const handler = createTextCompleteHandler();
        const output = { text: "§999§ Large tag content" };
        //#when
        await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);
        //#then
        expect(output.text).toBe("Large tag content");
    });

    it("#given text with double §N§ prefix #when handler runs #then strips both tags", async () => {
        //#given
        const handler = createTextCompleteHandler();
        const output = { text: "§56§ §56§ Bailan Kimi 2.5 done" };
        //#when
        await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);
        //#then
        expect(output.text).toBe("Bailan Kimi 2.5 done");
    });

    it("#given text with consecutive different tags #when handler runs #then strips all leading tags", async () => {
        //#given
        const handler = createTextCompleteHandler();
        const output = { text: "§55§ §56§ Response text" };
        //#when
        await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);
        //#then
        expect(output.text).toBe("Response text");
    });

    it("#given text with tag without trailing space #when handler runs #then still strips", async () => {
        //#given
        const handler = createTextCompleteHandler();
        const output = { text: "§42§Response without space" };
        //#when
        await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);
        //#then
        expect(output.text).toBe("Response without space");
    });
});
