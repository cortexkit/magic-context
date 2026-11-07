import { expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { HEAD_IDS } from "../hooks/payload";
import type { SessionContext, V2Message } from "../hooks/types";
import type { StoreRow, V2StoreReader } from "../store-reader";
import { nativeFoldCache } from "./memory-cache";
import { NativeFoldReplay } from "./native-replay";

test("review: another session evicting capture must not erase frozen effort controls", async () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const row: StoreRow = {
        id: "u",
        session_id: "s",
        type: "user",
        seq: 1,
        data: { text: "hello" },
    };
    let cut: StoreRow<"compaction"> | undefined;
    let running: StoreRow<"compaction"> | undefined;
    const reader = {
        close() {},
        hostIdentity: () => "review-private-store",
        latestSequence: () => running?.seq ?? cut?.seq ?? 1,
        latestCompaction: () => cut,
        latestRunningCompaction: () => running,
        sequenceForId: (_s: string, id: string) => (id === row.id ? 1 : undefined),
        rowStampsThrough: () => [{ ...row, time_created: 0 }],
        range: (_s: string, after: number, through: number) =>
            [row].filter((r) => r.seq > after && r.seq <= through),
        page: (_s: string, options: { after?: number; type?: string } = {}) => ({
            rows: options.type || (options.after ?? -1) >= 1 ? [] : [row],
        }),
    } as unknown as V2StoreReader;
    const kv = new Map<string, unknown>();
    const storage = {
        get: async (key: string) => kv.get(key),
        set: async (key: string, value: unknown) => {
            kv.set(key, structuredClone(value));
        },
    };
    const raw: V2Message[] = [
        { id: "u", role: "user", content: [{ type: "text", text: "hello" }], metadata: {} },
    ];
    const effort: V2Message = {
        role: "system",
        content: [{ type: "effort", effort: "low", previous: "high" }],
    };
    const draft: SessionContext = {
        sessionID: "s",
        model: { providerID: "p", id: "m" },
        agent: "build",
        system: [],
        tools: {},
        options: {},
        messages: [
            { id: HEAD_IDS[0], role: "user", content: [{ type: "text", text: "head" }] },
            ...raw,
            effort,
        ],
    };
    const cache = nativeFoldCache(db, { maxSessionBytes: 16 * 1024 * 1024, maxSessions: 1 });
    const replay = new NativeFoldReplay(cache, () => reader, storage, { protocol: 3 });
    try {
        await replay.capture(draft, [...raw, effort]);
        expect(JSON.parse(cache.tail("s")!.data).replay.controls).toHaveLength(1);
        await cache.saveTail("other-session", "{}", []);
        expect(cache.tail("s")).toBeUndefined();
        expect(await replay.canFold("s", reader)).toBe(true);
        running = {
            id: "cut",
            session_id: "s",
            seq: 2,
            type: "compaction",
            data: { status: "running" },
        };
        expect(await replay.supply({ draft, reader, summary: "head" })).toBe(true);
        cut = { ...running, data: { status: "completed", summary: "head" } };
        running = undefined;
        const cold = new NativeFoldReplay(nativeFoldCache(db), () => reader, storage, {
            protocol: 3,
        });
        expect(await cold.admits("s", cut, reader)).toBe(true);
        expect(await cold.restore("s", cut, "p/m")).toEqual([...raw, effort]);
    } finally {
        db.close();
    }
});
