import { afterEach, expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { HEAD_IDS } from "../hooks/payload";
import type { SessionContext, V2Message } from "../hooks/types";
import type { StoreRow, V2StoreReader } from "../store-reader";
import { nativeFoldCache } from "./memory-cache";
import { copyNativeInput, NativeFoldReplay, nativeRowID } from "./native-replay";

const databases: Database[] = [];
afterEach(() => {
    for (const db of databases.splice(0)) db.close();
});

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
    messages: [user(HEAD_IDS[0], "unchanged baseline"), ...messages],
});
const cut = (seq: number): StoreRow<"compaction"> => ({
    id: `cut-${seq}`,
    session_id: "s",
    seq,
    type: "compaction",
    data: { status: "completed", summary: "unchanged baseline" },
});

function fixture(rows: StoreRow[]) {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    databases.push(db);
    const cache = nativeFoldCache(db);
    const reads: Array<[number, number]> = [];
    let running = cut(5);
    const reader = {
        close() {},
        latestSequence: () => Math.max(...rows.map((row) => row.seq)),
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

// A system row has no message id in the host draft. After a checkpoint, the
// first visible system belongs to the new window, not the oldest system in storage.
test("review632: post-checkpoint id-less system stays at its current source row", async () => {
    const rows: StoreRow[] = [
        {
            id: "sys-old",
            seq: 1,
            session_id: "s",
            type: "system",
            data: { text: "old instruction" },
        },
        { id: "u-old", seq: 4, session_id: "s", type: "user", data: { text: "old user" } },
    ];
    const f = fixture(rows);
    const first = [system("old instruction"), user("u-old", "old user")];
    await f.replay.capture(draft(first), copyNativeInput(first));
    await f.replay.supply({ draft: draft([]), reader: f.reader, summary: "unchanged baseline" });
    rows.push(
        {
            id: "sys-new",
            seq: 6,
            session_id: "s",
            type: "system",
            data: { text: "new instruction" },
        },
        { id: "u-new", seq: 7, session_id: "s", type: "user", data: { text: "new user" } },
    );
    const visible = [system("new instruction"), user("u-new", "new user")];
    await f.replay.capture(draft(visible), copyNativeInput(visible));
    f.setRunning(cut(8));
    await f.replay.supply({ draft: draft([]), reader: f.reader, summary: "unchanged baseline" });
    const restored = await f.replay.restore("s", cut(8), "p/m", { after: 4 });
    expect(restored?.map(nativeRowID)).toEqual(["sys-new", "u-new"]);
    expect(restored).toEqual(visible);
});

// In Rust mode the context hook first trims the draft to the history boundary
// recorded by the Rust module (trimToRecordedBoundary), then captures it, so the
// cache can start at a later row than the conversation does. The cache's
// "loaded through seq N" mark only records the highest row it holds, not that
// every row below N was captured; restore must read the missing earlier rows
// from the host store.
test("review632: widening a partially captured range restores missing raw rows", async () => {
    const rows: StoreRow[] = [
        {
            id: "u-covered",
            seq: 1,
            session_id: "s",
            type: "user",
            data: { text: "covered raw history" },
        },
        { id: "u-tail", seq: 4, session_id: "s", type: "user", data: { text: "retained tail" } },
    ];
    const f = fixture(rows);
    const native = [user("u-tail", "retained tail")];
    await f.replay.capture(draft(native), copyNativeInput(native));
    await f.replay.supply({ draft: draft([]), reader: f.reader, summary: "unchanged baseline" });
    const restored = await f.replay.restore("s", cut(5), "p/m", { after: -1 });
    expect(restored?.map(nativeRowID)).toEqual(["u-covered", "u-tail"]);
    expect(f.reads).toContainEqual([-1, 4]);
});

test("review632 control: an empty cache follows a later host cut exactly once", async () => {
    const rows: StoreRow[] = [
        { id: "u-first", seq: 1, session_id: "s", type: "user", data: { text: "first" } },
        { id: "u-later", seq: 6, session_id: "s", type: "user", data: { text: "later" } },
    ];
    const f = fixture(rows);
    expect((await f.replay.restore("s", cut(8), "p/m"))?.map(nativeRowID)).toEqual([
        "u-first",
        "u-later",
    ]);
    expect(f.reads).toEqual([[-1, 7]]);
    expect((await f.replay.restore("s", cut(8), "p/m"))?.map(nativeRowID)).toEqual([
        "u-first",
        "u-later",
    ]);
    expect(f.reads).toEqual([[-1, 7]]);
});
