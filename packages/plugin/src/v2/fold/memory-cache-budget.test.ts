import { expect, test } from "bun:test";
import { HEAD_IDS } from "../hooks/payload";
import type { SessionContext, V2Message } from "../hooks/types";
import type { StoreRow, V2StoreReader } from "../store-reader";
import { type NativeFoldBudget, type NativeRowRecord, nativeFoldCache } from "./memory-cache";
import { NativeFoldReplay } from "./native-replay";

function fixture(budget: NativeFoldBudget) {
    const cache = nativeFoldCache(() => {
        throw new Error("Unbounded replay must not open context.db");
    }, budget);
    const reads: Array<[string, number, number]> = [];
    const rows: StoreRow[] = [
        {
            id: "u",
            session_id: "s",
            seq: 1,
            type: "user",
            data: { text: "literal café <recent-context>" },
        },
    ];
    const reader = {
        close() {},
        hostIdentity: () => "private-store",
        latestSequence: () => 1,
        rowStampsThrough: () => rows.map((row) => ({ ...row, time_created: 0 })),
        range: (sessionID: string, after: number, through: number) => {
            reads.push([sessionID, after, through]);
            return rows.filter((row) => row.seq > after && row.seq <= through);
        },
    } as unknown as V2StoreReader;
    const replay = new NativeFoldReplay(cache, () => reader);
    const cut: StoreRow<"compaction"> = {
        id: "cut",
        session_id: "s",
        seq: 2,
        type: "compaction",
        data: { status: "completed", summary: "baseline" },
    };
    return { cache, replay, reader, reads, cut };
}
const row = (text: string): Omit<NativeRowRecord, "revision"> => ({
    id: "row",
    type: "user",
    seq: 1,
    data: text,
    digest: "digest",
});

test("session-count LRU eviction preserves bytes and adds exactly one cold restore", async () => {
    const f = fixture({ maxSessions: 2, maxSessionBytes: 100_000 });
    const expected = JSON.stringify([
        {
            id: "u",
            role: "user",
            content: [{ type: "text", text: "literal café <recent-context>" }],
            metadata: {},
        },
    ]);
    expect(JSON.stringify(await f.replay.restore("s", f.cut, "p/m"))).toBe(expected);
    await f.cache.saveTail("other", "{}", []);
    // A warm access makes s newer than other, so pressure must evict other first.
    expect(JSON.stringify(await f.replay.restore("s", f.cut, "p/m"))).toBe(expected);
    await f.cache.saveTail("newest", "{}", []);
    expect(f.cache.tail("other")).toBeUndefined();
    expect(f.cache.tail("s")).toBeDefined();
    expect(f.cache.tail("newest")).toBeDefined();
    await f.cache.saveTail("last", "{}", []);
    expect(f.cache.tail("s")).toBeUndefined();
    expect(f.cache.usage().sessions).toBe(2);
    expect(JSON.stringify(await f.replay.restore("s", f.cut, "p/m"))).toBe(expected);
    expect(JSON.stringify(await f.replay.restore("s", f.cut, "p/m"))).toBe(expected);
    expect(f.reads).toEqual([
        ["s", -1, 1],
        ["s", -1, 1],
    ]);
});

test("per-session byte budget releases oversized rows tails admissions and replay metadata", async () => {
    const f = fixture({ maxSessions: 16, maxSessionBytes: 4_000 });
    await f.replay.observeSource("s", f.reader);
    await f.replay.restore("s", f.cut, "p/m");
    f.replay.invalidate("s", true);
    await f.cache.supply("s", "cut", "payload");
    expect(f.replay.sourceChanged("s")).toBe(true);
    await f.cache.saveTail("s", "{}", [row("x".repeat(4_000))]);
    expect(f.cache.usage()).toEqual({ sessions: 0, bytes: 0 });
    expect(f.cache.rows("s", -1, 100)).toEqual([]);
    expect(f.cache.tail("s")).toBeUndefined();
    expect(f.cache.admission("s", "cut")).toBeUndefined();
    expect(f.replay.sourceChanged("s")).toBe(false);
    const expected = JSON.stringify(await f.replay.restore("s", f.cut, "p/m"));
    expect(await f.replay.canReplay("s", f.reader)).toBe(true);
    expect(JSON.stringify(await f.replay.restore("s", f.cut, "p/m"))).toBe(expected);
    expect(f.reads).toHaveLength(2);
    expect(f.cache.usage().bytes).toBeLessThanOrEqual(4_000);
});

test("active sessions finish before byte or LRU eviction", async () => {
    const f = fixture({ maxSessions: 1, maxSessionBytes: 1_000 });
    const release = f.cache.hold("s");
    await f.cache.saveTail("s", "{}", [row("x".repeat(1_000))]);
    await f.cache.saveTail("other", "{}", []);
    expect(f.cache.rows("s", -1, 1)).toHaveLength(1);
    expect(f.cache.tail("other")).toBeUndefined();
    release();
    expect(f.cache.usage()).toEqual({ sessions: 0, bytes: 0 });
});

test("oversized restores remain servable without retaining a partial range", async () => {
    const f = fixture({ maxSessions: 1, maxSessionBytes: 1 });
    const first = await f.replay.restore("s", f.cut, "p/m");
    expect(first?.[0]?.id).toBe("u");
    expect(f.cache.usage()).toEqual({ sessions: 0, bytes: 0 });
    expect(await f.replay.restore("s", f.cut, "p/m")).toEqual(first);
    expect(f.reads).toHaveLength(2);
});

test("replay bookkeeping alone respects the session limit", async () => {
    const f = fixture({ maxSessions: 2, maxSessionBytes: 100_000 });
    for (const id of ["a", "b", "c"]) {
        await f.replay.observeSource(id, f.reader);
        f.replay.invalidate(id, true);
    }
    expect(f.cache.usage().sessions).toBe(2);
    expect(f.replay.sourceChanged("a")).toBe(false);
    expect(f.replay.sourceChanged("b")).toBe(true);
    expect(f.replay.sourceChanged("c")).toBe(true);
});

test("an oversized optional capture cannot interrupt the incoming request", async () => {
    const f = fixture({ maxSessions: 1, maxSessionBytes: 1 });
    const native: V2Message[] = [
        { id: "u", role: "user", content: [{ type: "text", text: "unchanged" }] },
    ];
    const draft: SessionContext = {
        sessionID: "s",
        model: { providerID: "p", id: "m" },
        agent: "build",
        system: [],
        tools: {},
        options: {},
        messages: [
            { id: HEAD_IDS[0], role: "user", content: [{ type: "text", text: "baseline" }] },
            ...native,
        ],
    };
    const before = JSON.stringify(draft);
    await f.replay.capture(draft, native);
    expect(JSON.stringify(draft)).toBe(before);
    expect(f.cache.usage()).toEqual({ sessions: 0, bytes: 0 });
});
