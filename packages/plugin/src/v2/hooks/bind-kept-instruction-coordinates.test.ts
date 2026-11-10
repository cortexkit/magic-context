import { expect, test } from "bun:test";
import { nativeRowID } from "../fold/native-replay";
import { bindKeptInstructionCoordinates } from "./context";
import type { V2Message } from "./types";

// The host sends instruction rows without ids; this binding gives each the
// store row it renders, so supersession can retire it by identity.

type Row = { id: string; seq: number; text?: string };

const store = (rows: Row[]) => ({
    instructionRowsThrough: () =>
        rows
            .filter((row) => row.text !== undefined)
            .map((row) => ({ id: row.id, seq: row.seq, type: "system", data: { text: row.text } })),
    latestSequence: () => Math.max(...rows.map((row) => row.seq)),
    sequenceForId: (_session: string, id: string) => rows.find((row) => row.id === id)?.seq,
});
const user = (id: string): V2Message =>
    ({ id, role: "user", content: [{ type: "text", text: id }] }) as unknown as V2Message;
const system = (text: string): V2Message =>
    ({ role: "system", content: [{ type: "text", text }] }) as unknown as V2Message;

function bound(rows: Row[], messages: V2Message[]) {
    bindKeptInstructionCoordinates(
        messages,
        undefined,
        store(rows) as unknown as Parameters<typeof bindKeptInstructionCoordinates>[2],
        "session",
    );
    return messages.filter((message) => message.role === "system").map(nativeRowID);
}

const visible = [
    { id: "u1", seq: 5 },
    { id: "u2", seq: 30 },
];

test("a contiguous run between two visible rows binds as before", () => {
    const rows = [...visible, { id: "a", seq: 10, text: "A" }, { id: "b", seq: 20, text: "B" }];
    expect(bound(rows, [user("u1"), system("A"), system("B"), user("u2")])).toEqual(["a", "b"]);
});

test("a hole the host no longer sends no longer stops the rest from binding", () => {
    const rows = [
        ...visible,
        { id: "a", seq: 10, text: "A" },
        { id: "hole", seq: 15, text: "RETIRED BY THE FOLD" },
        { id: "b", seq: 20, text: "B" },
    ];
    expect(bound(rows, [user("u1"), system("A"), system("B"), user("u2")])).toEqual(["a", "b"]);
});

test("text that more than one candidate could carry stays unbound", () => {
    const rows = [
        ...visible,
        { id: "first", seq: 10, text: "SAME" },
        { id: "hole", seq: 15, text: "RETIRED BY THE FOLD" },
        { id: "second", seq: 20, text: "SAME" },
    ];
    expect(bound(rows, [user("u1"), system("SAME"), user("u2")])).toEqual([undefined]);
    // Only the row whose placement is forced binds.
    const mixed = [
        ...visible,
        { id: "x1", seq: 10, text: "X" },
        { id: "y", seq: 12, text: "Y" },
        { id: "x2", seq: 14, text: "X" },
        { id: "hole", seq: 16, text: "RETIRED BY THE FOLD" },
    ];
    expect(bound(mixed, [user("u1"), system("Y"), system("X"), user("u2")])).toEqual(["y", "x2"]);
    expect(bound(mixed, [user("u1"), system("X"), user("u2")])).toEqual([undefined]);
});

test("a row with no matching candidate leaves the whole run unbound", () => {
    const rows = [
        ...visible,
        { id: "a", seq: 10, text: "A" },
        { id: "hole", seq: 15, text: "RETIRED BY THE FOLD" },
    ];
    expect(bound(rows, [user("u1"), system("A"), system("UNKNOWN"), user("u2")])).toEqual([
        undefined,
        undefined,
    ]);
});
