import { afterEach, expect, test } from "bun:test";
import { patchSessionMeta } from "../../features/magic-context/__tests__/session-meta-fixture";
import { runMigrations } from "../../features/magic-context/migrations";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { nativeFoldCache } from "./memory-cache";
import { foldDigest } from "./owner";

const databases: Database[] = [];
afterEach(() => {
    for (const db of databases.splice(0)) db.close();
});

import { HEAD_IDS } from "../hooks/payload";
import type { SessionContext, V2Context, V2Message } from "../hooks/types";
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

test("an unencodable native asset leaves a servable draft alone and marks its capture unavailable", async () => {
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

for (const count of [3, 25_000]) {
    test(`bounded native capture serves the same post-fold bytes as full capture for ${count} rows`, async () => {
        const f = fixture();
        f.rows.splice(
            0,
            f.rows.length,
            ...Array.from({ length: count }, (_, i) => ({
                id: `u${i}`,
                seq: i + 1,
                session_id: "s",
                type: "user" as const,
                data: { text: `source message ${i}` },
            })),
        );
        f.cut.seq = count + 1;
        const summary = "already served summary";
        const native = f.rows.map((row) => user(row.id, row.data.text as string));
        // The reference retains the complete capture to compare bytes, not to
        // change the production retention budget of the bounded cache.
        const fullStorage = nativeFoldCache(f.db, {
            maxSessionBytes: 256 * 1024 * 1024,
            maxSessions: 1,
        });
        const full = new NativeFoldReplay(fullStorage, () => f.reader);
        await full.capture(context([user(HEAD_IDS[0], summary), ...native]), native);
        getOrCreateSessionMeta(f.db, "s");
        const boundary = count - 2;
        patchSessionMeta(f.db, "s", {
            cached_m0_bytes: Buffer.from(summary),
            cached_m0_last_baseline_end_message_id: `u${boundary}`,
        });
        const bounded = new NativeFoldReplay(f.storage, () => f.reader);
        await bounded.capture(context([user(HEAD_IDS[0], summary), ...native]), native, {
            id: `u${boundary}`,
            summary,
        });
        expect(await bounded.baseline("s")).toBe(summary);
        expect(await bounded.canReplay("s", f.reader)).toBe(true);
        expect(f.storage.rows("s", -1, count).map((row) => row.id)).toEqual([`u${count - 1}`]);
        expect(f.storage.usage().bytes).toBeLessThan(16 * 1024 * 1024);
        for (const replay of [full, bounded]) {
            await replay.supply({ draft: context([]), reader: f.reader, summary });
        }
        const fullRequest = await full.restore("s", f.cut, "p/m", { bounded: true });
        const boundedRequest = await bounded.restore("s", f.cut, "p/m", { bounded: true });
        expect(JSON.stringify(boundedRequest)).toBe(JSON.stringify(fullRequest));
        expect(boundedRequest).toEqual([user(`u${count - 1}`, `source message ${count - 1}`)]);
        // Rows replaced by the head are still recoverable after an edit or revert.
        expect((await bounded.restore("s", f.cut, "p/m"))?.map((row) => row.id)).toEqual(
            native.map((row) => row.id),
        );
    });
}

test("a checkpoint without a native capture restores every source message without loss", async () => {
    const f = fixture();
    const replay = new NativeFoldReplay(f.storage, () => f.reader);
    expect(await replay.baseline("s")).toBeUndefined();
    const original = JSON.stringify(f.rows);
    expect(
        await replay.supply({ draft: context([]), reader: f.reader, summary: "folded source" }),
    ).toBe(true);
    const restored = await replay.restore("s", f.cut, "p/m", { bounded: true });
    expect(restored).toEqual([
        { id: "u", role: "user", content: [{ type: "text", text: "served" }], metadata: {} },
        {
            id: "a",
            role: "assistant",
            content: [{ type: "text", text: "unseen final answer" }],
        },
    ]);
    expect(JSON.stringify(f.rows)).toBe(original);
});

test("an unsummarized tail exceeding the native budget folds and restores without retaining partial history", async () => {
    const f = fixture();
    const replay = new NativeFoldReplay(f.storage, () => f.reader);
    const text = "x".repeat(9 * 1024 * 1024);
    f.rows[0]!.data.text = text;
    const native = [user("u", text)];
    await replay.capture(context([user(HEAD_IDS[0], "head"), ...native]), native);
    expect(await replay.baseline("s")).toBeUndefined();
    expect(f.storage.usage().bytes).toBe(0);
    expect(await replay.supply({ draft: context([]), reader: f.reader, summary: "head" })).toBe(
        true,
    );
    const restored = await replay.restore("s", f.cut, "p/m", { bounded: true });
    expect(restored?.map((row) => row.id)).toEqual(["u", "a"]);
    expect(restored?.[0]?.content[0]?.text).toBe(text);
    expect(restored?.[1]?.content[0]?.text).toBe("unseen final answer");
    expect(f.storage.usage().bytes).toBe(0);
});

test("bounded replay closes its source reader when resolving an uncached boundary fails", async () => {
    const f = fixture();
    getOrCreateSessionMeta(f.db, "s");
    f.db
        .prepare(
            "UPDATE session_meta SET cached_m0_last_baseline_end_message_id='u' WHERE session_id='s'",
        )
        .run();
    let closed = 0;
    const reader = {
        ...f.reader,
        sequenceForId: () => {
            throw new Error("source unavailable");
        },
        close: () => {
            closed++;
        },
    } as V2StoreReader;
    const replay = new NativeFoldReplay(f.storage, () => reader);
    await expect(replay.restore("s", f.cut, "p/m", { bounded: true })).rejects.toThrow(
        "source unavailable",
    );
    expect(closed).toBe(1);
});

test("busy replay admission reads durable native provenance without updating or deleting it", async () => {
    const f = fixture();
    f.cut.seq = 3;
    f.reader.hostIdentity = () => "fixture-host";
    f.reader.latestRunningCompaction = () => ({ ...f.cut, data: { status: "running" } });
    const saved = new Map<string, unknown>();
    let writes = 0;
    const provenance = {
        get: async (key: string) => saved.get(key),
        set: async (key: string, value: unknown) => {
            writes++;
            saved.set(key, value);
        },
    } as V2Context["storage"];
    const first = new NativeFoldReplay(f.storage, () => f.reader, provenance);
    await first.observeSource("s", f.reader);
    await first.capture(context([user(HEAD_IDS[0], f.cut.data.summary!)]), [user("u", "served")]);
    expect(
        await first.supply({ draft: context([]), reader: f.reader, summary: f.cut.data.summary! }),
    ).toBe(true);
    const before = JSON.stringify([...saved]);
    const writeCount = writes;
    const changes = f.db.prepare("SELECT total_changes() AS n").get();
    const coldStorage = nativeFoldCache(f.db);
    const cold = new NativeFoldReplay(coldStorage, () => f.reader, provenance);
    expect(await cold.replayAdmission("s", f.cut, f.reader)).toBe("native");
    expect(
        cold
            .replayInput({
                sessionID: "s",
                cut: f.cut,
                model: { providerID: "p", id: "m" },
                reader: f.reader,
                bounded: false,
            })
            ?.map((message) => message.id),
    ).toEqual(["u", "a"]);
    expect(coldStorage.usage()).toEqual({ sessions: 0, bytes: 0 });
    expect(
        cold.replayInput({
            sessionID: "s",
            cut: { ...f.cut, session_id: "other" },
            model: { providerID: "p", id: "m" },
            reader: f.reader,
            bounded: false,
        }),
    ).toBeUndefined();
    const tail = f.storage.tail("s");
    const nativeRows = JSON.stringify(f.storage.rows("s", -1, 10));
    expect(
        first.replayInput({
            sessionID: "s",
            cut: f.cut,
            model: { providerID: "p", id: "different" },
            reader: f.reader,
            bounded: false,
        }),
    ).toBeDefined();
    expect(first.sourceChanged("s")).toBe(false);
    expect(f.storage.tail("s")).toEqual(tail);
    expect(JSON.stringify(f.storage.rows("s", -1, 10))).toBe(nativeRows);
    f.rows[0]!.data.text = "edited source";
    expect(await cold.replayAdmission("s", f.cut, f.reader)).toBeUndefined();
    f.reader.hostIdentity = () => "other-host";
    expect(await cold.replayAdmission("s", f.cut, f.reader)).toBeUndefined();
    f.reader.hostIdentity = () => "fixture-host";
    expect(await cold.replayAdmission("s", { ...f.cut, id: "legacy-cut" }, f.reader)).toBe(
        "legacy",
    );
    expect(writes).toBe(writeCount);
    expect(JSON.stringify([...saved])).toBe(before);
    expect(f.db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
});
