import { expect, test } from "bun:test";
import {
    parseEnabledTurnOne,
    resolveTurnOneFactAnchor,
} from "../../features/magic-context/memory/turn-one-publication";
import { validateHistorianOutput } from "./compartment-runner-validation";
import { readSessionChunk, withRawMessageProvider } from "./read-session-chunk";
import type { RawMessage } from "./read-session-raw";

const wake =
    "<system-reminder>\nInbox: peer\n## Peer messages\nBROCA (pm_one): Check the parser.\n</system-reminder>";
const hidden = (ordinal: number): RawMessage => ({
    id: `m${ordinal}`,
    role: "system",
    ordinal,
    parts: [],
});
const relay = (ordinal: number): RawMessage => ({
    id: `m${ordinal}`,
    role: "user",
    ordinal,
    parts: [{ type: "text", text: wake }],
});

function build(messages: RawMessage[], singleMessageLines = false) {
    return withRawMessageProvider(
        "relay-gap",
        {
            readMessages: () => messages,
            getMessageCount: () => messages.length,
        },
        () => readSessionChunk("relay-gap", 100_000, 1, undefined, { singleMessageLines }),
    );
}

function reply(ranges: number[][], unprocessed: number) {
    const compartments = ranges
        .map(
            ([start, end]) =>
                `<compartment start="${start}" end="${end}" title="Parser"><p1>Checked the parser.</p1><p2>Parser</p2><p3>Parser</p3><p4 /></compartment>`,
        )
        .join("");
    return `<output><compartments>${compartments}</compartments><unprocessed_from>${unprocessed}</unprocessed_from></output>`;
}

function validate(chunk: ReturnType<typeof build>, ranges: number[][], unprocessed: number) {
    return validateHistorianOutput(reply(ranges, unprocessed), "relay-gap", chunk, [], 0);
}

test("relay after hidden prefix extends the stored start", () => {
    for (const single of [false, true]) {
        const chunk = build([hidden(1), relay(2)], single);
        expect(chunk.text).toBe("[2] PM from BROCA: Check the parser.");
        expect(chunk.lines.map((line) => line.ordinal)).toEqual([1, 2]);
        for (const start of [2, 1]) {
            const result = validate(chunk, [[start, 2]], 3);
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error(result.error);
            expect(result.compartments[0].startMessage).toBe(1);
            expect(result.compartments[0].startMessageId).toBe("m1");
            expect(result.compartments[0].endMessage).toBe(2);
        }
    }
});

test("relay after mid-chunk hidden entry extends only the next start", () => {
    for (const single of [false, true]) {
        const chunk = build([relay(1), hidden(2), relay(3)], single);
        expect(chunk.text).not.toContain("[2]");
        for (const start of [3, 2]) {
            const result = validate(
                chunk,
                [
                    [1, 1],
                    [start, 3],
                ],
                4,
            );
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error(result.error);
            expect(result.compartments[0].endMessage).toBe(1);
            expect(result.compartments[1].startMessage).toBe(2);
            expect(result.compartments[1].startMessageId).toBe("m2");
        }
    }
});

test("hidden prefix does not allow skipping a printed relay", () => {
    const result = validate(build([hidden(1), relay(2), relay(3)]), [[3, 3]], 4);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("accepted a printed gap");
    expect(result.error).toContain("gap before message 3 (expected 1)");
});

test("unprocessed boundary may skip hidden but not printed ordinals", () => {
    const chunk = build([relay(1), hidden(2), relay(3), relay(4)]);
    for (const unprocessed of [2, 3]) expect(validate(chunk, [[1, 1]], unprocessed).ok).toBe(true);
    for (const unprocessed of [4, 5, 100]) {
        const result = validate(chunk, [[1, 1]], unprocessed);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("accepted a printed gap");
        expect(result.error).toContain("does not match next uncovered message 2");
    }
});

test("ordinary printed range still demands its hidden-text ordinal", () => {
    const chunk = build([
        hidden(1),
        { ...relay(2), parts: [{ type: "text", text: "Check the parser." }] },
    ]);
    expect(chunk.text).toContain("[1-2] U:");
    const result = validate(chunk, [[2, 2]], 3);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("accepted a printed gap");
    expect(result.error).toContain("gap before message 2 (expected 1)");
});

test("hidden compartment end remains a present raw boundary", () => {
    const result = validate(build([hidden(1), relay(2), hidden(3)]), [[2, 3]], 4);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.compartments[0].startMessageId).toBe("m1");
    expect(result.compartments[0].endMessageId).toBe("m3");
});

test("saved turn-one chunks recover hidden coverage from their printed labels", () => {
    const chunk = JSON.parse(JSON.stringify(build([hidden(1), relay(2), hidden(3), relay(4)])));
    expect(chunk.printedBlocks).toBeUndefined();
    const result = validate(
        chunk,
        [
            [2, 2],
            [4, 4],
        ],
        5,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(
        result.compartments.map((compartment) => [
            compartment.startMessage,
            compartment.startMessageId,
        ]),
    ).toEqual([
        [1, "m1"],
        [3, "m3"],
    ]);
    expect(validate(chunk, [[2, 2]], 4).ok).toBe(true);
    expect(validate(chunk, [[4, 4]], 5).ok).toBe(false);

    const ordinary = JSON.parse(
        JSON.stringify(
            build([
                hidden(1),
                { ...relay(2), parts: [{ type: "text", text: "Check the parser." }] },
            ]),
        ),
    );
    expect(validate(ordinary, [[2, 2]], 3).ok).toBe(false);
    const { text: _text, ...withoutLabels } = chunk;
    expect(
        validate(
            withoutLabels,
            [
                [2, 2],
                [4, 4],
            ],
            5,
        ).ok,
    ).toBe(false);
});

test("turn one uses extended ranges without turning hidden lines into evidence", () => {
    const chunk = build([hidden(1), relay(2), relay(3)]);
    const xml = reply([[2, 3]], 4).replace(
        "</output>",
        "<facts><PROJECT_RULES>\n* [at_compartment=1 messages=2-2] Check the parser.\n</PROJECT_RULES></facts></output>",
    );
    const parsed = parseEnabledTurnOne(JSON.stringify({ result: { step: "turn_one", xml } }));
    expect(parsed).not.toBeNull();
    const result = validateHistorianOutput(parsed!, "relay-gap", chunk, [], 0);
    if (!result.ok) throw new Error(result.error);
    expect(result.compartments[0].startMessage).toBe(1);
    const fact = result.facts[0];
    expect(
        resolveTurnOneFactAnchor(fact.anchor, result.compartments, chunk.printedBlocks!, {
            startOrdinal: 1,
            endOrdinal: 3,
        }),
    ).toEqual({ compartmentIndex: 1, blockIndexes: [0] });
    expect(
        resolveTurnOneFactAnchor(
            { compartmentIndex: 1, startOrdinal: 1, endOrdinal: 1 },
            result.compartments,
            chunk.printedBlocks!,
        ),
    ).toBeNull();
});
