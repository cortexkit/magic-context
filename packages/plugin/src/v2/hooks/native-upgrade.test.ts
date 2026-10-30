import { expect, test } from "bun:test";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

const text = (messages: Array<{ content: Array<Record<string, unknown>> }>) =>
    messages
        .flatMap((message) => message.content)
        .map((part) => part.text ?? "")
        .join("\n");

test("a V2 missing-floor upgrade serves the turn once and keeps every row through restart and the next native fold", async () => {
    const f = await oc2ContextFixture(8631, {
        area: "native-v2-upgrade",
        instructions: false,
        temporal: false,
    });
    try {
        const before = await f.pass();
        const oldTexts = f.rows.map((row) => row.text);
        for (const value of oldTexts) expect(text(before.draft.messages)).toContain(value);
        await f.nativeFold(2);
        await f.restart();
        const upgraded = await f.pass();
        expect(
            upgraded.logs.filter((line) =>
                line.includes("upgrade-state HARD mode=host-checkpoint"),
            ),
        ).toHaveLength(1);
        for (const value of oldTexts) expect(text(upgraded.draft.messages)).toContain(value);
        expect(text(upgraded.draft.messages)).toContain("<recent-context>");
        expect((await f.pass()).bytes).toBe(upgraded.bytes);
        await f.restart();
        expect((await f.pass()).bytes).toBe(upgraded.bytes);
        f.respond();
        f.user("new user turn after the upgrade", 1000);
        const growing = await f.pass();
        for (const value of oldTexts) expect(text(growing.draft.messages)).toContain(value);
        await f.nativeFold();
        const folded = await f.pass();
        expect(folded.bytes).toBe(growing.bytes);
        await f.restart();
        const restarted = await f.pass();
        expect(restarted.bytes).toBe(folded.bytes);
        for (const value of oldTexts) expect(text(restarted.draft.messages)).toContain(value);
        expect(f.sessionLogs().filter((line) => line.includes("upgrade-state HARD"))).toHaveLength(
            1,
        );
    } finally {
        await f.cleanup();
    }
}, 60000);

test("a V2 upgrade retires an oversized host transcript only after a permitted summary rebuild", async () => {
    const f = await oc2ContextFixture(8632, {
        area: "native-v2-upgrade",
        instructions: false,
        temporal: false,
    });
    try {
        await f.pass();
        await f.nativeFold(2, 0, "duplicated host transcript ".repeat(360000));
        expect(text([f.checkpoint!])).toContain("<recent-context>");
        f.compartment(f.rows.length - 1);
        f.user("continue after the completed host checkpoint", 1000);
        await f.restart();
        const repaired = await f.pass();
        const sent = text(repaired.draft.messages);
        expect(sent).toContain("<session-history>");
        expect(sent).not.toContain("<recent-context>");
        expect(sent).not.toContain("duplicated host transcript");
        expect(Buffer.byteLength(repaired.bytes)).toBeLessThan(50000);
        expect(repaired.logs.filter((line) => line.includes("upgrade-state HARD"))).toHaveLength(1);
        expect((await f.pass()).bytes).toBe(repaired.bytes);
        await f.restart();
        expect((await f.pass()).bytes).toBe(repaired.bytes);
        const nextCut = await f.nativeFold();
        const data = f.raw.prepare("SELECT data FROM session_message WHERE id=?").get(nextCut) as {
            data: string;
        };
        const summary = JSON.parse(data.data).summary as string;
        expect(summary).toContain("<session-history>");
        expect(sent).toContain(`<summary>\n${summary}\n</summary>`);
        expect((await f.pass()).bytes).toBe(repaired.bytes);
    } finally {
        await f.cleanup();
    }
}, 60000);
