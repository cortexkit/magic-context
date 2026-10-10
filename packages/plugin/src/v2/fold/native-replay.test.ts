import { afterEach, expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { nativeFoldCache } from "./memory-cache";
import { foldDigest } from "./owner";

const databases: Database[] = [];
afterEach(() => {
    for (const db of databases.splice(0)) db.close();
});

import { HEAD_IDS } from "../hooks/payload";
import type { SessionContext, V2Message } from "../hooks/types";
import type { StoreRow, V2StoreReader } from "../store-reader";
import { copyNativeInput, isLocalCheckpoint, NativeFoldReplay } from "./native-replay";

const user = (id: string, text: string): V2Message => ({
    id,
    role: "user",
    content: [{ type: "text", text }],
    metadata: {},
});
const context = (messages: V2Message[]): SessionContext => ({
    sessionID: "s",
    model: { providerID: "p", id: "m" },
    agent: "build",
    system: [],
    tools: {},
    options: {},
    messages,
});
function fixture() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    databases.push(db);
    const storage = nativeFoldCache(db);
    const rows: StoreRow[] = [
        { id: "u", seq: 1, session_id: "s", type: "user", data: { text: "served" } },
        {
            id: "a",
            seq: 2,
            session_id: "s",
            type: "assistant",
            data: {
                model: { providerID: "p", id: "m" },
                content: [{ type: "text", text: "unseen final answer" }],
            },
        },
    ];
    let misses = 0;
    const reader = {
        close() {},
        latestCompaction: () => undefined,
        rowStampsThrough: (_sid: string, through: number) =>
            rows.filter((row) => row.seq <= through).map((row) => ({ ...row, time_created: 0 })),
        replayRowStamps: (_sid: string, through: number) =>
            new Map(
                rows
                    .filter((row) => row.seq <= through)
                    .map((row) => [row.seq, foldDigest(JSON.stringify(row.data))]),
            ),
        sequenceForId: (_sid: string, id: string) => rows.find((row) => row.id === id)?.seq,
        latestSequence: () => Math.max(...rows.map((row) => row.seq)),
        latestSequenceForIds: () => Math.max(...rows.map((row) => row.seq)),
        latestRunningCompaction: () => ({ id: "cut" }),
        range: (_sid: string, after: number, through: number) => {
            misses++;
            return rows.filter((row) => row.seq > after && row.seq <= through);
        },
    } as unknown as V2StoreReader;
    const cut: StoreRow<"compaction"> = {
        id: "cut",
        session_id: "s",
        type: "compaction",
        seq: 10,
        data: { status: "completed", summary: "already served m0", recent: "host duplicate" },
    };
    return { storage, db, rows, reader, cut, misses: () => misses };
}

test("native checkpoint recognition is structural and leaves literal user delimiters alone", () => {
    const f = fixture();
    expect(isLocalCheckpoint(f.cut)).toBe(true);
    expect(isLocalCheckpoint({ ...f.cut, data: { ...f.cut.data, providerContext: {} } })).toBe(
        false,
    );
    expect(isLocalCheckpoint({ ...f.cut, data: { ...f.cut.data, status: "failed" } })).toBe(false);
    expect(
        isLocalCheckpoint({
            ...f.cut,
            type: "user",
            data: { text: "<conversation-checkpoint><recent-context>" },
        }),
    ).toBe(false);
});

test("cached native bytes and id-less carriers survive a cut with detached copies", async () => {
    const f = fixture();
    f.rows[1]!.seq = 3;
    f.rows.splice(1, 0, {
        id: "sys",
        seq: 2,
        session_id: "s",
        type: "system",
        data: { text: "instruction update" },
    });
    const replay = new NativeFoldReplay(f.storage, () => f.reader);
    const raw = [
        user("u", "literal <recent-context>café</recent-context>"),
        { role: "system", content: [{ type: "text", text: "instruction update" }] },
    ];
    await replay.capture(context(raw), raw);
    const draft = context([]); // The native compaction hook may omit all of its recent exchange.
    await replay.supply({ draft, reader: f.reader, summary: f.cut.data.summary! });
    expect(f.misses()).toBe(1);
    const expected = [
        ...raw,
        {
            id: "a",
            role: "assistant",
            content: [{ type: "text", text: "unseen final answer", providerMetadata: undefined }],
        },
    ];
    expect(await replay.restore("s", f.cut, "p/m")).toEqual(expected);
    const restart = replay;
    expect(await restart.restore("s", f.cut, "p/m")).toEqual(expected);
    expect(f.misses()).toBe(1);
    const restored = await restart.restore("s", f.cut, "p/m");
    restored![0]!.content[0]!.text = "mutated draft";
    expect(await restart.restore("s", f.cut, "p/m")).toEqual(expected);
});

test("native replay restores unowned local cuts from source and excludes provider cuts", async () => {
    const f = fixture();
    const replay = new NativeFoldReplay(f.storage, () => f.reader);
    await replay.capture(context([user("u", "kept")]), [user("u", "kept")]);
    await replay.supply({
        draft: context([]),
        reader: f.reader,
        summary: f.cut.data.summary!,
    });
    expect((await replay.restore("s", { ...f.cut, id: "foreign" }, "p/m"))?.[0]).toEqual(
        user("u", "served"),
    );
    expect(
        await replay.restore(
            "s",
            { ...f.cut, data: { ...f.cut.data, providerContext: {} } },
            "p/m",
        ),
    ).toBeUndefined();
    expect(await replay.restore("s", f.cut, "other/model")).toBeDefined();
    expect(
        await replay.restore("s", { ...f.cut, data: { ...f.cut.data, summary: "changed" } }, "p/m"),
    ).toBeDefined();
});

test("capturing retains trimmed raw rows and keeps a tool carrier with its source sequence", async () => {
    const f = fixture();
    f.rows.unshift({
        id: "drop",
        seq: 0,
        session_id: "s",
        type: "user",
        data: { text: "dropped" },
    });
    const replay = new NativeFoldReplay(f.storage, () => f.reader);
    const raw = [
        user("drop", "dropped"),
        {
            id: "u",
            role: "assistant",
            content: [{ type: "tool-call", id: "t", name: "read", input: {} }],
        },
        {
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    id: "t",
                    name: "read",
                    result: { type: "text", value: "kept result" },
                },
            ],
        },
    ];
    await replay.capture(context(raw.slice(1)), raw);
    await replay.supply({
        draft: context([]),
        reader: f.reader,
        summary: f.cut.data.summary!,
    });
    expect((await replay.restore("s", f.cut, "p/m"))!.slice(0, 3)).toEqual(raw);
});

test("a failed second host cut preserves the previous snapshot even before its first primary replay", async () => {
    const f = fixture();
    const replay = new NativeFoldReplay(f.storage, () => f.reader);
    await replay.capture(context([user("u", "original native bytes")]), [
        user("u", "original native bytes"),
    ]);
    await replay.supply({ draft: context([]), reader: f.reader, summary: f.cut.data.summary! });
    // The first checkpoint completed before any model-context callback restored its history.
    Object.assign(f.reader, { latestRunningCompaction: () => ({ id: "failed-cut" }) });
    await replay.supply({
        draft: context([]),
        reader: f.reader,
        previousCut: f.cut,
        summary: "new unused summary",
    });
    // The second compaction failed, so the first checkpoint still selects the history to restore.
    const restarted = replay;
    const restored = await restarted.restore("s", f.cut, "p/m");
    expect(restored?.[0]).toEqual(user("u", "original native bytes"));
    expect(restored).toHaveLength(2);
});

// Inapplicable: there is no disk copy of captured messages to corrupt with this SQL update. A new process reloads the original host rows.
test.skip("persisted native snapshot corruption is refused before replay", () => {});

test("restart restores byte-identical native history once and hot passes perform no restore reads", async () => {
    const f = fixture();
    const expected = [
        user("u", "served"),
        { id: "a", role: "assistant", content: [{ type: "text", text: "unseen final answer" }] },
    ];
    const first = new NativeFoldReplay(nativeFoldCache(f.db), () => f.reader);
    await first.capture(context(expected), expected);
    await first.supply({ draft: context([]), reader: f.reader, summary: f.cut.data.summary! });
    const before = JSON.stringify(await first.restore("s", f.cut, "p/m"));
    const restart = new NativeFoldReplay(nativeFoldCache(f.db), () => f.reader);
    expect(await restart.baseline("s")).toBeUndefined();
    const reads = f.misses();
    expect(JSON.stringify(await restart.restore("s", f.cut, "p/m"))).toBe(before);
    expect(f.misses() - reads).toBe(1);
    const delivered = await restart.restore("s", f.cut, "p/m");
    delivered![0]!.content[0]!.text = "host mutation";
    expect(JSON.stringify(await restart.restore("s", f.cut, "p/m"))).toBe(before);
    expect(f.misses() - reads).toBe(1);
});

test("an incoming newest assistant replaces the same row id without a restore read", async () => {
    const f = fixture();
    const replay = new NativeFoldReplay(f.storage, () => f.reader);
    const initial = [
        user("u", "served"),
        { id: "a", role: "assistant", content: [{ type: "text", text: "partial" }] },
    ];
    await replay.capture(context(initial), initial);
    const before = f.misses();
    const updated = [
        user("u", "served"),
        { id: "a", role: "assistant", content: [{ type: "text", text: "complete" }] },
    ];
    await replay.capture(context(updated), updated);
    await replay.supply({ draft: context([]), reader: f.reader, summary: f.cut.data.summary! });
    expect(JSON.stringify(await replay.restore("s", f.cut, "p/m"))).toBe(JSON.stringify(updated));
    expect(f.misses() - before).toBe(1); // Supplying the compaction hook reads newly stored rows after the last captured message.
});

test("a host revert truncates the memory tail and never revives it on later passes", async () => {
    const f = fixture();
    const replay = new NativeFoldReplay(f.storage, () => f.reader);
    await replay.capture(context([user("u", "served"), user("a", "removed tail")]), [
        user("u", "served"),
        user("a", "removed tail"),
    ]);
    await replay.supply({ draft: context([]), reader: f.reader, summary: f.cut.data.summary! });
    f.rows.pop();
    replay.onEvent({ type: "session.revert.committed", data: { sessionID: "s", to: "a" } });
    expect(await replay.restore("s", f.cut, "p/m")).toEqual([user("u", "served")]);
    const reads = f.misses();
    expect(await replay.restore("s", f.cut, "p/m")).toEqual([user("u", "served")]);
    expect(f.misses()).toBe(reads);
    expect(f.storage.rows("s", -1, 10).map((row) => row.id)).toEqual(["u"]);
});

test("native input copies detach nested tool arguments and message metadata before later passes", () => {
    const input: V2Message[] = [
        {
            id: "assistant",
            role: "assistant",
            metadata: { provider: { binding: "original" } },
            content: [{ type: "tool-call", input: { nested: { value: "original" } } }],
        },
    ];
    const copied = copyNativeInput(input);
    (copied[0]!.metadata as { provider: { binding: string } }).provider.binding = "changed";
    (copied[0]!.content[0]!.input as { nested: { value: string } }).nested.value = "changed";
    expect(input[0]!.metadata).toEqual({ provider: { binding: "original" } });
    expect(input[0]!.content[0]!.input).toEqual({ nested: { value: "original" } });
});

test("an unencodable native asset leaves a servable draft alone and inhibits automatic folding", async () => {
    const f = fixture();
    const replay = new NativeFoldReplay(f.storage, () => f.reader);
    const native = [user("u", "served")];
    await replay.capture(context([user(HEAD_IDS[0], "baseline"), ...native]), native);
    expect(await replay.canReplay("s", f.reader)).toBe(true);
    const delivered = context([user(HEAD_IDS[0], "baseline"), ...native]);
    native[0]!.content.push({
        type: "media",
        media: { headers: { authorization: "private fixture value" } },
    });
    const before = JSON.stringify(delivered);
    await expect(replay.capture(delivered, native)).resolves.toBeUndefined();
    expect(JSON.stringify(delivered)).toBe(before);
    expect(await replay.canReplay("s", f.reader)).toBe(false);
});
