import { expect, test } from "bun:test";
import { captureLkgSlot, projectLkgEntry, replayLkg } from "./lkg-replay";
import { getSlot, lkgContentDigest, resetLkgSlotsForTest } from "./lkg-slot";
import type { MessageLike } from "./transform-operations";

const user = (id: string, text = id): MessageLike => ({
    info: {
        id,
        role: "user",
        model: { providerID: "review", modelID: "model" },
    } as MessageLike["info"],
    parts: [{ type: "text", text }],
});
const instruction = (text: string): MessageLike => ({
    info: { role: "system" } as MessageLike["info"],
    parts: [{ type: "text", text }],
});
const sessionId = "independent-oc220-review";
const keys = { modelKey: "review/model", providerKey: "review" };

function capture(input: MessageLike[], output = structuredClone(input), completeOutput = false) {
    resetLkgSlotsForTest();
    expect(captureLkgSlot({ sessionId, input, output, completeOutput, ...keys })).toBe(true);
    return getSlot(sessionId)!;
}

test("cache review: unchanged duplicate instructions preserve served bytes and append a new announcement", () => {
    const input = [user("u0"), instruction("same"), user("u1"), instruction("same")];
    const output = structuredClone(input);
    output[0]!.parts = [{ type: "text", text: "served, not pristine" }];
    const slot = capture(input, output);
    expect(slot.inputIdSeq).toEqual(["u0", "\0mc-system:1", "u1"]);
    expect(slot.jsonPrefix).toBe(JSON.stringify(output.slice(0, 3)));

    const tail = [instruction("new announcement"), user("u2")];
    const current = [...structuredClone(input), ...tail];
    const before = JSON.stringify(current);
    const replay = replayLkg({ sessionId, messages: current, ...keys });
    expect(replay.ok).toBe(true);
    if (replay.ok)
        expect(JSON.stringify(replay.messages)).toBe(JSON.stringify([...output, ...tail]));
    expect(JSON.stringify(current)).toBe(before);
    expect(
        current
            .filter((row) => row.info.role === "system")
            .every((row) => row.info.id === undefined),
    ).toBe(true);
    expect(
        projectLkgEntry(current)
            .filter((row) => row.role === "system")
            .map((row) => row.id),
    ).toEqual([null, null, null]);
});

const changes: [string, (messages: MessageLike[]) => void][] = [
    [
        "edit",
        (messages) => {
            messages[1]!.parts = [{ type: "text", text: "changed" }];
        },
    ],
    [
        "insert identical duplicate",
        (messages) => {
            messages.splice(1, 0, instruction("A"));
        },
    ],
    [
        "remove",
        (messages) => {
            messages.splice(1, 1);
        },
    ],
    [
        "reorder distinct rows",
        (messages) => {
            [messages[1], messages[2]] = [messages[2]!, messages[1]!];
        },
    ],
    [
        "move duplicate from prefix to tail",
        (messages) => {
            messages.splice(1, 1);
            messages.push(instruction("A"));
        },
    ],
    [
        "change role with unchanged text",
        (messages) => {
            messages[1]!.info.role = "user";
        },
    ],
];

for (const [name, change] of changes) {
    test(`cache review refuses ${name} under the captured prefix without touching the draft`, () => {
        const input = [
            user("u0"),
            instruction("A"),
            instruction("B"),
            instruction("A"),
            user("u1"),
            instruction("A"),
        ];
        capture(input);
        const current = structuredClone(input);
        change(current);
        const before = JSON.stringify(current);
        const replay = replayLkg({ sessionId, messages: current, ...keys });
        expect(replay.ok).toBe(false);
        expect(JSON.stringify(current)).toBe(before);
    });
}

test("cache review: equal positional keys do not hide changed instruction content", () => {
    const input = [user("u0"), instruction("old instructions"), user("u1")];
    const slot = capture(input);
    const changed = structuredClone(input);
    changed[1]!.parts = [{ type: "text", text: "new instructions" }];
    expect(lkgContentDigest(changed[1]!)).not.toBe(slot.inputContentDigests[1]);
    const replay = replayLkg({ sessionId, messages: changed, ...keys });
    expect(replay).toEqual({ ok: false, reason: "lkg_content_mismatch" });
});

test("cache review: complete output binds an anonymous final anchor as well as earlier duplicates", () => {
    const input = [user("u0"), instruction("A"), instruction("A")];
    const output = structuredClone(input);
    output[0]!.parts = [{ type: "text", text: "frozen user output" }];
    const slot = capture(input, output, true);
    expect(slot.lastInputMessageId).toBe("\0mc-system:2");
    const replay = replayLkg({
        sessionId,
        messages: [...structuredClone(input), instruction("new")],
        ...keys,
    });
    expect(replay.ok).toBe(true);
    if (replay.ok)
        expect(JSON.stringify(replay.messages)).toBe(
            JSON.stringify([...output, instruction("new")]),
        );

    capture(input, output, true);
    const changed = structuredClone(input);
    changed[2] = instruction("B");
    expect(replayLkg({ sessionId, messages: changed, ...keys })).toEqual({
        ok: false,
        reason: "lkg_content_mismatch",
    });
});

test("cache review: swapping indistinguishable instructions cannot change the request bytes", () => {
    const input = [user("u0"), instruction("A"), instruction("A"), user("u1")];
    const slot = capture(input);
    const current = structuredClone(input);
    [current[1], current[2]] = [current[2]!, current[1]!];
    const replay = replayLkg({ sessionId, messages: current, ...keys });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(JSON.stringify(replay.messages)).toBe(slot.jsonPrefix);
});
