import { expect, test } from "bun:test";
import * as completion from "./provider-response-completion";

test("detects server-fallback usage only in the marked reasoning part", () => {
    const content = [
        { type: "reasoning", text: "thinking", native: { signature: "real-signature" } },
        {
            type: "reasoning",
            text: " ",
            native: {
                signature: "cortexkit-server-fallback-v1:claude-opus-5-5|claude-opus-4-8",
            },
        },
        { type: "text", text: "answer" },
        { type: "tool", name: "read" },
    ];
    expect(completion.hasServerFallbackUsage(content)).toBe(true);
    expect(completion.hasServerFallbackUsage([content[0], content[2]])).toBe(false);
    for (const invalid of [
        undefined,
        null,
        {},
        [null, {}, { type: "reasoning", native: { signature: 3 } }],
        [{ type: "text", native: content[1]!.native }],
        [{ type: "reasoning", native: { signature: "cortexkit-server-fallback-v10:models" } }],
        [{ type: "reasoning", native: { signature: "other-cortexkit-server-fallback-v1:models" } }],
    ]) {
        expect(completion.hasServerFallbackUsage(invalid)).toBe(false);
    }
});
