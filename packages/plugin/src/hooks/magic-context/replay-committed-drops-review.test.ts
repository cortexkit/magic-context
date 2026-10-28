import { afterEach, expect, test } from "bun:test";
import { getTagsBySession, insertTag } from "../../features/magic-context/storage";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { replayCommittedDrops } from "./replay-committed-drops";
import type { MessageLike } from "./tag-messages";

afterEach(() => closeDatabase());
const session = "independent-binder-review";
function dropped(
    mode = "full",
    owner: string | null = "owner",
    messageId = "call",
    type: "tool" | "message" = "tool",
) {
    const db = openDatabase()!;
    db.exec(`DELETE FROM tags WHERE session_id='${session}'`);
    insertTag(db, session, messageId, type, 100, 907, 0, type === "tool" ? "read" : null, 0, owner);
    db.prepare("UPDATE tags SET status='dropped',drop_mode=? WHERE session_id=?").run(
        mode,
        session,
    );
    return db;
}
function arc(owner = "owner", call = "call"): MessageLike[] {
    return [
        {
            info: { id: owner, role: "assistant" },
            parts: [{ type: "tool_use", id: call, name: "read", input: { filePath: "real.ts" } }],
        },
        {
            info: { id: `${owner}-result`, role: "tool" },
            parts: [{ type: "tool_result", tool_use_id: call, content: "payload" }],
        },
    ];
}
const tail = (): MessageLike => ({
    info: { id: "tail", role: "user" },
    parts: [{ type: "text", text: "next" }],
});
test("reapplying an already-rendered text drop without annotations is byte-identical", () => {
    const db = dropped("full", null, "old:p1", "message");
    const messages: MessageLike[] = [
        {
            info: { id: "old", role: "user" },
            parts: [
                { type: "text", text: "untouched first part" },
                { type: "text", text: "[dropped §907§]", synthetic: true },
            ],
        },
        tail(),
    ];
    const before = JSON.stringify(messages);
    expect(replayCommittedDrops(db, session, messages)).toBe(true);
    expect(JSON.stringify(messages)).toBe(before);
});

test("a new text drop keeps captured note and hint suffixes on their original part", () => {
    const db = dropped("full", null, "old:p1", "message");
    const note = '\n\n<instruction name="deferred_notes">captured note</instruction>';
    const hint = "\n\n<ctx-search-hint>captured recall</ctx-search-hint>";
    const messages: MessageLike[] = [
        {
            info: { id: "old", role: "user" },
            parts: [
                { type: "text", text: "untouched first part" },
                { type: "text", text: `§907§ reduced body${note}${hint}` },
                { type: "text", text: "untouched last part" },
            ],
        },
        tail(),
    ];
    expect(replayCommittedDrops(db, session, messages)).toBe(true);
    expect(messages[0]?.parts).toEqual([
        { type: "text", text: "untouched first part" },
        { type: "text", text: `[dropped §907§]${note}${hint}` },
        { type: "text", text: "untouched last part" },
    ]);
    const served = JSON.stringify(messages);
    expect(replayCommittedDrops(db, session, messages)).toBe(true);
    expect(JSON.stringify(messages)).toBe(served);
});

test("committed raw text drops cannot overwrite an injected synthetic history head", () => {
    const db = dropped("full", null, "old:p0", "message");
    const messages: MessageLike[] = [
        {
            info: { id: "old", role: "user", syntheticHead: true },
            parts: [{ type: "text", text: "injected history", synthetic: true }],
        },
        tail(),
    ];
    const before = JSON.stringify(messages);
    expect(replayCommittedDrops(db, session, messages)).toBe(true);
    expect(JSON.stringify(messages)).toBe(before);
});

for (const mode of ["full", "truncated", "skeleton_real"]) {
    test(`independent binder legacy ${mode}: split arc and exact idempotence without writes`, () => {
        const db = dropped(mode);
        const messages = [...arc(), tail()];
        const rows = JSON.stringify(getTagsBySession(db, session));
        db.exec(
            "CREATE TEMP TRIGGER no_recovery_write BEFORE UPDATE ON tags BEGIN SELECT RAISE(ABORT,'recovery wrote'); END",
        );
        replayCommittedDrops(db, session, messages);
        const wire = JSON.stringify(messages);
        expect(wire).not.toContain("payload");
        if (mode === "full") expect(messages).toEqual([tail()]);
        else {
            expect(wire).toContain("[dropped §907§]");
            expect(wire.includes("real.ts")).toBe(mode === "skeleton_real");
        }
        replayCommittedDrops(db, session, messages);
        expect(JSON.stringify(messages)).toBe(wire);
        expect(JSON.stringify(getTagsBySession(db, session))).toBe(rows);
    });
}
for (const id of ["synth-user-old:p0", "missing-stored-id"]) {
    test(`independent binder text identity ${id}: prefix fallback and skeleton left unchanged`, () => {
        const db = dropped("full", null, id, "message");
        const messages: MessageLike[] = [
            {
                info: { id: "synth-user-old", role: "user" },
                parts: [{ type: "text", text: "§907§ old text" }],
            },
            tail(),
        ];
        replayCommittedDrops(db, session, messages);
        expect(messages[0].parts).toEqual([{ type: "text", text: "[dropped §907§]" }]);
        const wire = JSON.stringify(messages);
        replayCommittedDrops(db, session, messages);
        expect(JSON.stringify(messages)).toBe(wire);
    });
}
test("independent binder owner collision: only the stored owner is dropped", () => {
    const db = dropped("full", "older");
    const messages = [...arc("older"), ...arc("newer"), tail()];
    replayCommittedDrops(db, session, messages);
    expect(messages).toEqual([...arc("newer"), tail()]);
});
for (const mode of ["full", "truncated", "skeleton_real"]) {
    test(`binder split result ${mode}: all segments share the invocation owner`, () => {
        const db = dropped(mode);
        const messages = [
            ...arc(),
            {
                info: { id: "second-result", role: "tool" },
                parts: [{ type: "tool_result", tool_use_id: "call", content: "later-segment" }],
            },
            tail(),
        ];
        expect(replayCommittedDrops(db, session, messages)).toBe(true);
        expect(JSON.stringify(messages)).not.toContain("later-segment");
        if (mode === "full") expect(messages).toEqual([tail()]);
        const wire = JSON.stringify(messages);
        replayCommittedDrops(db, session, messages);
        expect(JSON.stringify(messages)).toBe(wire);
    });
}
test("binder overlapping invocation owners: bind neither ambiguous arc", () => {
    const db = dropped("full", "older");
    const older = arc("older");
    const newer = arc("newer");
    const messages = [older[0]!, newer[0]!, older[1]!, newer[1]!, tail()];
    const before = structuredClone(messages);
    replayCommittedDrops(db, session, messages);
    expect(messages).toEqual(before);
});
test("binder unique ownerless legacy arc: retained compatibility", () => {
    const db = dropped("full", null);
    const messages = [...arc(), tail()];
    replayCommittedDrops(db, session, messages);
    expect(messages).toEqual([tail()]);
});
test("review P2 legacy ownerless collision: ambiguous arcs must be left untouched", () => {
    const db = dropped("full", null);
    const messages = [...arc("older"), ...arc("newer"), tail()];
    const before = structuredClone(messages);
    replayCommittedDrops(db, session, messages);
    expect(messages).toEqual(before);
});
test("review P2 split result: every segment of the committed tool must be dropped", () => {
    const db = dropped("skeleton_real");
    const messages = [
        ...arc(),
        {
            info: { id: "later-result", role: "tool" },
            parts: [{ type: "tool_result", tool_use_id: "call", content: "second-payload" }],
        },
        tail(),
    ];
    replayCommittedDrops(db, session, messages);
    expect(JSON.stringify(messages)).not.toContain("second-payload");
});
test("review P1 signed-prefix invariant: a committed text drop must not precede kept signed reasoning", () => {
    const db = dropped("full", null, "old:p0", "message");
    const messages: MessageLike[] = [
        {
            info: { id: "old", role: "user" },
            parts: [{ type: "text", text: "§907§ old text" }],
        },
        {
            info: { id: "signed", role: "assistant" },
            parts: [
                {
                    type: "reasoning",
                    text: "keep",
                    metadata: { anthropic: { signature: "signed-prefix" } },
                },
                { type: "text", text: "answer" },
            ],
        },
        tail(),
    ];
    const prefix = JSON.stringify(messages[0]);
    replayCommittedDrops(db, session, messages);
    const kept = JSON.stringify(messages).includes("signed-prefix");
    expect(kept && JSON.stringify(messages[0]) !== prefix).toBe(false);
});
