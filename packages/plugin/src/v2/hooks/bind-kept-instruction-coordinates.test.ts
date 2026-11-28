import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { bindNativeRowID, nativeRowID, nativeRowSequence } from "../fold/native-replay";
import { effortPart } from "../fold/native-replay-v3";
import { V2StoreReader } from "../store-reader";
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
    sequencesForIds: (_session: string, ids: readonly string[]) => {
        const wanted = new Set(ids);
        return new Map(rows.filter((row) => wanted.has(row.id)).map((row) => [row.id, row.seq]));
    },
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

test("kept-instruction coordinate reads use one query per 500 ids", () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "v2-bind-coordinates-"));
    const path = join(dir, "opencode.db");
    const db = new Database(path);
    try {
        db.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
            CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq);`);
        const put = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, 1, ?)");
        const kept = system("kept instruction");
        const turns = Array.from({ length: 1001 }, (_, i) => user(`u${i}`));
        db.transaction(() => {
            put.run("kept", "s", "system", 0, JSON.stringify({ text: "kept instruction" }));
            put.run("other", "other", "user", 1, "{}");
            for (const [i, turn] of turns.entries()) put.run(turn.id!, "s", "user", i + 1, "{}");
        })();
        const reader = new V2StoreReader(path);
        try {
            const prepare = spyOn(
                reader as unknown as { prepare(sql: string): unknown },
                "prepare",
            );
            bindKeptInstructionCoordinates([kept, ...turns], undefined, reader, "s");
            expect(nativeRowID(kept)).toBe("kept");
            const queries = prepare.mock.calls.filter(([sql]) =>
                /^SELECT (id, )?seq FROM session_message/.test(sql),
            );
            expect(queries).toHaveLength(3);
            expect(reader.sequencesForIds("s", [])).toEqual(new Map());
            expect(
                reader.sequencesForIds("s", ["missing", "other", "kept", "kept", "u1000"]),
            ).toEqual(
                new Map([
                    ["kept", 0],
                    ["u1000", 1001],
                ]),
            );
        } finally {
            reader.close();
        }
    } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

// Keep the old per-id walk as a reference, including id lookup after a message is bound.
function bindPerId(
    messages: V2Message[],
    incoming: V2Message | undefined,
    reader: ReturnType<typeof store>,
) {
    const rows = reader.instructionRowsThrough();
    let previous: number | undefined;
    let pending: V2Message[] = [];
    const matches = (message: V2Message | undefined, row: (typeof rows)[number] | undefined) =>
        message?.role === "system" &&
        message.content.length === 1 &&
        message.content[0]?.type === "text" &&
        message.content[0].text === row?.data.text;
    const bind = (next?: number) => {
        if (!pending.length) return;
        const candidates = rows.filter(
            (row) =>
                (previous === undefined || row.seq > previous) &&
                (next === undefined || row.seq < next),
        );
        const selected =
            previous === undefined
                ? candidates.slice(-pending.length)
                : next === undefined
                  ? candidates.slice(0, pending.length)
                  : candidates;
        if (
            selected.length === pending.length &&
            selected.every((row, index) => matches(pending[index], row))
        ) {
            selected.forEach((row, index) => {
                const message = pending[index];
                if (message) bindNativeRowID(message, row.id, row.seq);
            });
        } else {
            const earliest: number[] = [];
            let at = 0;
            for (const message of pending) {
                while (at < candidates.length && !matches(message, candidates[at])) at++;
                earliest.push(at++);
            }
            const latest: number[] = [];
            at = candidates.length - 1;
            for (let index = pending.length - 1; index >= 0; index--) {
                while (at >= 0 && !matches(pending[index], candidates[at])) at--;
                latest[index] = at--;
            }
            if (earliest.every((position) => position < candidates.length)) {
                pending.forEach((message, index) => {
                    const row = candidates[earliest[index]];
                    if (row && earliest[index] === latest[index])
                        bindNativeRowID(message, row.id, row.seq);
                });
            }
        }
        pending = [];
    };
    for (const message of messages) {
        if (message === incoming || effortPart(message)) continue;
        const id = nativeRowID(message);
        const seq = id ? reader.sequenceForId("session", id) : undefined;
        if (seq !== undefined) {
            bind(seq);
            previous = seq;
        } else if (!id && message.role === "system") pending.push(message);
    }
    bind();
    return rows;
}

test("batched binding matches the per-id walk across generated requests", () => {
    let state = 731;
    const pick = (n: number) => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) % n;
    const coordinates = (messages: V2Message[]) =>
        messages.map((message) => [nativeRowID(message), nativeRowSequence(message)]);
    for (let iteration = 0; iteration < 500; iteration++) {
        const rows: Row[] = [];
        const wire: V2Message[] = [];
        for (let i = 0, n = pick(30); i < n; i++) {
            const id = `row-${i}`;
            const text = pick(3) === 0 ? undefined : `instruction-${pick(4)}`;
            rows.push({ id, seq: 3 * i, text });
            if (pick(5) !== 0) wire.push(text === undefined ? user(id) : system(text));
            if (pick(7) === 0) wire.push(user(`absent-${i}`));
            if (pick(7) === 0) wire.push(system("unmatched"));
        }
        if (wire.length > 0) {
            // Reuse an object, rather than a copy, so a binding can affect a later lookup.
            wire.push(wire[pick(wire.length)]!);
            wire.push({
                ...system("ignored effort"),
                id: rows[pick(rows.length)]?.id,
                content: [{ type: "effort" }],
            } as V2Message);
        }
        const incoming = pick(wire.length + 1);
        const expected = structuredClone(wire);
        const reader = store(rows);
        const expectedRows = bindPerId(expected, expected[incoming], reader);
        const actualRows = bindKeptInstructionCoordinates(
            wire,
            wire[incoming],
            reader as unknown as Parameters<typeof bindKeptInstructionCoordinates>[2],
            "session",
        );
        expect(actualRows).toEqual(expectedRows);
        expect(coordinates(wire)).toEqual(coordinates(expected));
    }
});

test("an id gained during binding anchors a later occurrence of the same object", () => {
    const rows = [...visible, { id: "a", seq: 10, text: "A" }, { id: "b", seq: 20, text: "B" }];
    const first = system("A");
    const trailing = system("B");
    expect(bound(rows, [user("u1"), first, user("u2"), first, trailing])).toEqual(["a", "a", "b"]);
    expect(nativeRowSequence(trailing)).toBe(20);
});
