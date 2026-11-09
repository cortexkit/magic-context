import { expect, test } from "bun:test";
import vectors from "../../../../../crates/mc-module/testdata/relayed-wakes.json";
import { readSessionChunk, withRawMessageProvider } from "./read-session-chunk";
import { hasMeaningfulUserText } from "./read-session-formatting";
import type { RawMessage } from "./read-session-raw";
import { relayedWakeLines } from "./relayed-wake";

test("relayed wake vectors retain attribution without creating user evidence", () => {
    const expand = (value: string) => {
        for (const [key, replacement] of Object.entries(vectors.replacements))
            value = value.replaceAll(`{{${key}}}`, replacement.text.repeat(replacement.count));
        return value;
    };
    for (const vector of vectors.cases) {
        const text = expand(vector.text);
        const expected = vector.lines.map(expand);
        expect(relayedWakeLines(text)).toEqual(expected);
        const parts = [{ type: "text", text }];
        const message: RawMessage = {
            id: "wake",
            role: "user",
            ordinal: 1,
            parts,
        };
        for (const singleMessageLines of [false, true]) {
            const chunk = withRawMessageProvider(
                "relayed-vectors",
                {
                    readMessages: () => [message],
                    getMessageCount: () => 1,
                },
                () =>
                    readSessionChunk("relayed-vectors", 100_000, 1, undefined, {
                        singleMessageLines,
                    }),
            );
            if ("userText" in vector) {
                expect(chunk.text).toBe(`[1] U: ${vector.userText}`);
            } else {
                expect(hasMeaningfulUserText(parts)).toBe(false);
                expect(chunk.text).toBe(expected.map((line) => `[1] ${line}`).join("\n"));
                expect(chunk.printedBlocks?.every((block) => block.role === "R")).toBe(true);
                expect(chunk.toolOnlyRanges).toEqual([]);
            }
            if (!expected.length) continue;
            const following: RawMessage = {
                id: "user",
                role: "user",
                ordinal: 2,
                parts: [{ type: "text", text: "The real user's decision." }],
            };
            const followed = withRawMessageProvider(
                "relayed-vectors",
                {
                    readMessages: () => [message, following],
                    getMessageCount: () => 2,
                },
                () =>
                    readSessionChunk("relayed-vectors", 100_000, 1, undefined, {
                        singleMessageLines,
                    }),
            );
            expect(followed.text).toBe(
                `${expected.map((line) => `[1] ${line}`).join("\n")}\n[2] U: The real user's decision.`,
            );
            expect(
                followed.printedBlocks
                    ?.filter((block) => block.role === "U")
                    .flatMap((block) => block.parts),
            ).toEqual(["The real user's decision."]);
            const surrounded = withRawMessageProvider(
                "relayed-vectors",
                {
                    readMessages: () => [
                        { id: "before", role: "system", ordinal: 1, parts: [] },
                        { ...message, ordinal: 2 },
                        { id: "after", role: "system", ordinal: 3, parts: [] },
                    ],
                    getMessageCount: () => 3,
                },
                () =>
                    readSessionChunk("relayed-vectors", 100_000, 1, undefined, {
                        singleMessageLines,
                    }),
            );
            expect(surrounded.text).toBe(expected.map((line) => `[2] ${line}`).join("\n"));
            expect(
                surrounded.printedBlocks?.map((block) => [block.startOrdinal, block.endOrdinal]),
            ).toEqual([[2, 2]]);
            expect(surrounded.messageCount).toBe(3);
        }
    }
});
