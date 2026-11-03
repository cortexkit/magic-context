import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import expansions from "../../../test-fixtures/runtime/historian-tool-expansions.json";
import { readSessionChunk, withRawMessageProvider } from "./read-session-chunk";
import type { RawMessage } from "./read-session-raw";

// Captured by running the corpus below against the unmodified reader at master
// d376a848a5de45f51fe1efdf9df4a77e8355a9fd. The seed reproduces the same inputs;
// each digest covers complete serialized chunks, not just their rendered text.
const reference = {
    visibleEnded: "a5c23476c9f336e415fd5c9d03d24f145440de3f8d5fe380a2861a07243d2ead",
    budgeted: "7fc52610561735f7c7b6d766f36147302871898ec03e44f98075a3d68ad0e268",
    fixture: "db81787ce0674b0f1177ab0609d96fc26036a4a87e101878aacf13ae24b927ef",
};

test("chunks without trailing filtered rows are byte-identical to master", () => {
    let seed = 690;
    const random = (max: number) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % max;
    };
    const digests = Object.fromEntries(
        Object.keys(reference).map((key) => [key, createHash("sha256")]),
    );
    let checked = 0;
    function compare(
        group: keyof typeof reference,
        messages: RawMessage[],
        budget: number,
        offset: number,
        end: number,
        expand: boolean,
    ) {
        const chunk = withRawMessageProvider(
            "differential",
            { readMessages: () => messages, getMessageCount: () => messages.length },
            () => readSessionChunk("differential", budget, offset, end, { expand }),
        );
        digests[group]?.update(`${JSON.stringify(chunk)}\n`);
        checked++;
    }
    for (let corpus = 0; corpus < 100; corpus++) {
        const messages: RawMessage[] = [];
        const add = (role: string, parts: unknown[]) => {
            const ordinal = messages.length + 1;
            messages.push({ ordinal, id: `c${corpus}-m${ordinal}`, role, parts });
        };
        for (let row = 0, count = 5 + random(30); row < count; row++) {
            switch (random(5)) {
                case 0:
                    add("user", [
                        { type: "text", text: "<system-reminder>internal</system-reminder>" },
                    ]);
                    break;
                case 1:
                    add("assistant", []);
                    break;
                case 2: {
                    const callID = `call-${row}`;
                    add("assistant", [
                        {
                            type: "tool",
                            tool: "ask",
                            callID,
                            state: { input: { question: "Which mode?" } },
                        },
                    ]);
                    add("user", [
                        { type: "tool", tool: "ask", callID, state: { output: "Strict" } },
                    ]);
                    break;
                }
                default:
                    add(random(2) ? "user" : "assistant", [
                        { type: "text", text: `Text ${random(500)}. Committed abc1234.` },
                    ]);
            }
        }
        // An ample budget and a visible eligible endpoint exclude terminal pending noise.
        add("user", [{ type: "text", text: "Visible eligible endpoint." }]);
        const eligible = messages.length + 1;
        add("assistant", []);
        for (const expand of [false, true]) {
            for (const offset of [1, 2, Math.floor(eligible / 2)]) {
                compare("visibleEnded", messages, 100_000, offset, eligible, expand);
            }
        }
        // Exercise early budget stops separately with no filterable rows anywhere.
        const visible = Array.from({ length: 12 }, (_, index) => ({
            ordinal: index + 1,
            id: `b${corpus}-${index}`,
            role: index % 3 ? "assistant" : "user",
            parts: [
                { type: "text", text: `Body ${random(1000)} ${"word ".repeat(random(30) + 1)}` },
            ],
        }));
        for (const budget of [1, 20, 80, 100_000]) {
            compare("budgeted", visible, budget, 1, 13, true);
        }
    }
    for (const expand of [false, true]) {
        compare("fixture", expansions.messages, 100_000, 1, expansions.messages.length + 1, expand);
    }
    const actual = Object.fromEntries(
        Object.entries(digests).map(([key, hash]) => [key, hash.digest("hex")]),
    );
    console.log(`reader differential: ${checked} complete chunk outputs`, actual);
    expect(checked).toBe(1002);
    expect(actual).toEqual(reference);
});
