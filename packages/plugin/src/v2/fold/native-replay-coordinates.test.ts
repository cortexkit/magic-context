import { expect, test } from "bun:test";
import { HEAD_IDS } from "../hooks/payload";
import type { SessionContext, V2Message } from "../hooks/types";
import type { StoreRow, V2StoreReader } from "../store-reader";
import { nativeFoldCache } from "./memory-cache";
import { copyNativeInput, NativeFoldReplay, nativeRowID } from "./native-replay";

const user = (id: string, text: string): V2Message => ({
    id,
    role: "user",
    content: [{ type: "text", text }],
    metadata: {},
});
const system = (text: string): V2Message => ({
    role: "system",
    content: [{ type: "text", text }],
});
const draft = (messages: V2Message[]): SessionContext => ({
    sessionID: "s",
    model: { providerID: "p", id: "m" },
    agent: "build",
    system: [],
    tools: {},
    options: {},
    messages: [user(HEAD_IDS[0], "baseline"), ...messages],
});
const cut = (seq: number): StoreRow<"compaction"> => ({
    id: `cut-${seq}`,
    session_id: "s",
    seq,
    type: "compaction",
    data: { status: "completed", summary: "baseline" },
});

function fixture(rows: StoreRow[]) {
    const cache = nativeFoldCache(() => {
        throw new Error("Unbounded replay must not open context.db");
    });
    const reads: Array<[number, number]> = [];
    let running = cut(5);
    const reader = {
        close() {},
        latestSequence: () => Math.max(-1, ...rows.map((row) => row.seq)),
        latestRunningCompaction: () => running,
        rowStampsThrough: (_sessionID: string, through: number) =>
            rows.filter((row) => row.seq <= through).map((row) => ({ ...row, time_created: 0 })),
        range: (_sessionID: string, after: number, through: number) => {
            reads.push([after, through]);
            return rows.filter((row) => row.seq > after && row.seq <= through);
        },
    } as unknown as V2StoreReader;
    const replay = new NativeFoldReplay(cache, () => reader);
    return {
        cache,
        replay,
        reader,
        reads,
        setRunning: (row: StoreRow<"compaction">) => {
            running = row;
        },
    };
}

test("leading systems anchor to the current window without overwriting older native bytes", async () => {
    const rows: StoreRow[] = [
        { id: "sys-old", seq: 1, session_id: "s", type: "system", data: { text: "old" } },
        { id: "u-old", seq: 4, session_id: "s", type: "user", data: { text: "old user" } },
    ];
    const f = fixture(rows);
    const old = [system("old"), user("u-old", "old user")];
    await f.replay.capture(draft(old), copyNativeInput(old));
    await f.replay.supply({ draft: draft([]), reader: f.reader, summary: "baseline" });
    rows.push(
        { id: "sys-new", seq: 6, session_id: "s", type: "system", data: { text: "new" } },
        { id: "u-new", seq: 7, session_id: "s", type: "user", data: { text: "new user" } },
    );
    const visible = [system("new"), user("u-new", "new user")];
    await f.replay.capture(draft(visible), copyNativeInput(visible));
    // Inspect capture before replay can repair missing rows from the host and hide a bad coordinate.
    expect(f.cache.rows("s", -1, 7).map((row) => row.id)).toEqual([
        "sys-old",
        "u-old",
        "sys-new",
        "u-new",
    ]);
    f.setRunning(cut(8));
    await f.replay.supply({ draft: draft([]), reader: f.reader, summary: "baseline" });
    const reads = f.reads.length;
    const restored = await f.replay.restore("s", cut(8), "p/m");
    expect(restored?.map(nativeRowID)).toEqual(["sys-old", "u-old", "sys-new", "u-new"]);
    expect(JSON.stringify(restored)).toBe(JSON.stringify([...old, ...visible]));
    expect(f.reads.length).toBe(reads);
});

test("unanchored systems do not claim older row identities", async () => {
    const rows: StoreRow[] = [
        { id: "sys", seq: 1, session_id: "s", type: "system", data: { text: "source" } },
    ];
    const f = fixture(rows);
    const incoming = [system("visible bytes")];
    await f.replay.capture(draft(incoming), copyNativeInput(incoming));
    expect(f.cache.rows("s", -1, 1)).toEqual([]);
    expect(incoming).toEqual([system("visible bytes")]);
    const restored = await f.replay.restore("s", cut(2), "p/m");
    expect(restored?.map(nativeRowID)).toEqual(["sys"]);
    expect(restored).toEqual([system("source")]);
    expect(f.reads).toEqual([[-1, 1]]);
});
