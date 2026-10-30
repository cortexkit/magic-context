import { afterEach, expect, test } from "bun:test";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { runMigrations } from "../../features/magic-context/migrations";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { HEAD_IDS } from "../hooks/payload";
import type { SessionContext, V2Message } from "../hooks/types";
import type { StoreRow, V2StoreReader } from "../store-reader";
import { nativeFoldCache } from "./memory-cache";
import { NativeFoldReplay } from "./native-replay";
import { IMPORTED_MC_SUMMARY } from "./native-replay-v3";

const databases: Database[] = [];
afterEach(() => {
    for (const db of databases.splice(0)) db.close();
});
const message = (id: string, text = id): V2Message => ({
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
function fixture(count = 2, imported = 0) {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    databases.push(db);
    getOrCreateSessionMeta(db, "s");
    const rows: StoreRow[] = Array.from({ length: count }, (_, i) => ({
        id: `u${i + 1}`,
        seq: i + 1,
        session_id: "s",
        type: "user",
        data: { text: `message ${i + 1}` },
    }));
    if (imported)
        rows[imported - 1] = {
            id: "imported",
            seq: imported,
            session_id: "s",
            type: "compaction",
            data: { status: "completed", summary: IMPORTED_MC_SUMMARY },
        };
    let running: StoreRow<"compaction"> | undefined;
    let completed: StoreRow<"compaction"> | undefined = imported
        ? (rows[imported - 1] as StoreRow<"compaction">)
        : undefined;
    const loads: Array<{ after: number; through: number; n: number }> = [];
    const reader = {
        close() {},
        hostIdentity: () => "private-host",
        latestSequence: () => Math.max(count, running?.seq ?? 0, completed?.seq ?? 0),
        latestCompaction: () => completed,
        latestRunningCompaction: () => running,
        sequenceForId: (_s: string, id: string) => rows.find((row) => row.id === id)?.seq,
        rowStampsThrough: (_s: string, through: number, after = -1) =>
            rows
                .filter((row) => row.seq > after && row.seq <= through)
                .map((row) => ({ ...row, time_created: 0 })),
        range: (_s: string, after: number, through: number) => {
            const selected = rows.filter((row) => row.seq > after && row.seq <= through);
            loads.push({ after, through, n: selected.length });
            return selected;
        },
        page: (
            _s: string,
            o: { after?: number; through?: number; type?: string; limit?: number } = {},
        ) => {
            const selected = rows
                .filter(
                    (row) =>
                        row.seq > (o.after ?? -1) &&
                        row.seq <= (o.through ?? Infinity) &&
                        (!o.type || row.type === o.type),
                )
                .slice(0, o.limit ?? 100);
            return { rows: selected, cursor: selected.at(-1)?.seq };
        },
    } as unknown as V2StoreReader;
    const kv = new Map<string, unknown>();
    const storage = {
        get: async (key: string) => kv.get(key),
        set: async (key: string, value: unknown) => {
            kv.set(key, value);
        },
        remove: async (key: string) => {
            kv.delete(key);
        },
    };
    const logs: string[] = [];
    const cache = nativeFoldCache(db);
    const make = (version: 2 | 3 = 3) =>
        new NativeFoldReplay(nativeFoldCache(db), () => reader, storage, {
            protocol: version,
            log: (_sid, line) => logs.push(line),
        });
    const replay = new NativeFoldReplay(cache, () => reader, storage, {
        protocol: 3,
        log: (_sid, line) => logs.push(line),
    });
    const begin = () => {
        running = {
            id: "native-cut",
            session_id: "s",
            type: "compaction",
            seq: count + 1,
            data: { status: "running" },
        };
    };
    const finish = (summary = "head") => {
        completed = { ...running!, data: { status: "completed", summary } };
        running = undefined;
        rows.push(completed);
        return completed;
    };
    return { db, rows, reader, loads, kv, storage, logs, cache, replay, make, begin, finish };
}

test("v3 cold migrated replay never reads below the imported host checkpoint", async () => {
    const f = fixture(32000, 31738);
    const raw = f.rows
        .filter((row) => row.seq > 31738)
        .map((row) => message(row.id, row.data.text as string));
    await f.replay.capture(context([message(HEAD_IDS[0], "head"), ...raw]), raw);
    expect(await f.replay.canFold("s", f.reader)).toBe(true);
    f.begin();
    expect(await f.replay.supply({ draft: context([]), reader: f.reader, summary: "head" })).toBe(
        true,
    );
    const cut = f.finish();
    for (let restart = 0; restart < 2; restart++) {
        const cold = f.make();
        f.loads.length = 0;
        expect(await cold.admits("s", cut, f.reader)).toBe(true);
        const restored = await cold.restore("s", cut, "p/m", { bounded: true });
        expect(restored?.length).toBe(262);
        expect(JSON.stringify(restored)).toBe(JSON.stringify(raw));
        expect(f.loads.every((load) => load.after >= 31737)).toBe(true);
        expect(Math.max(...f.loads.map((load) => load.n))).toBeLessThan(300);
    }
});

test("v3 id-less effort and authored instruction carriers preserve bytes through a restart", async () => {
    const f = fixture(3);
    f.rows[1] = {
        id: "rules",
        seq: 2,
        session_id: "s",
        type: "system",
        data: { text: "authored rules" },
    };
    const effort: V2Message = {
        role: "system",
        content: [{ type: "effort", effort: "low", previous: "high" }],
    };
    const rules: V2Message = {
        role: "system",
        content: [{ type: "text", text: "authored rules" }],
    };
    const raw = [message("u1", "message 1"), rules, effort, message("u3", "message 3")];
    const served = context([message(HEAD_IDS[0], "head"), ...raw]);
    const before = JSON.stringify(served);
    await f.replay.capture(served, raw);
    expect(JSON.stringify(served)).toBe(before);
    expect(await f.replay.baseline("s")).toBe("head");
    expect(f.logs).toEqual([]);
    f.begin();
    expect(await f.replay.supply({ draft: context([]), reader: f.reader, summary: "head" })).toBe(
        true,
    );
    const cut = f.finish();
    const cold = f.make();
    expect(await cold.admits("s", cut, f.reader)).toBe(true);
    const restored = await cold.restore("s", cut, "p/m", { bounded: true });
    expect(JSON.stringify(restored)).toBe(JSON.stringify(raw));
    const saved = JSON.stringify([...f.kv.values()]);
    expect(saved).not.toContain("authored rules");
    expect(saved).not.toContain("message 1");
});

test("v3 capture failures report one reason without interrupting the served draft", async () => {
    const f = fixture();
    const raw = [message("missing", "not a source row")];
    const served = context([message(HEAD_IDS[0], "head"), ...raw]);
    const before = JSON.stringify(served);
    await f.replay.capture(served, raw);
    expect(JSON.stringify(served)).toBe(before);
    expect(f.logs.filter((line) => line.includes("capture unavailable"))).toHaveLength(1);
    expect(f.logs.join("\n")).toContain("Native carrier has no source row coordinate");
});

test("v3 refuses a fold with no reconstructible host floor rather than rewinding", async () => {
    const f = fixture();
    f.rows.push({
        id: "unknown",
        seq: 3,
        session_id: "s",
        type: "compaction",
        data: { status: "completed", summary: "unknown" },
    });
    // Make this opaque current checkpoint the host's selected window.
    const reader = { ...f.reader, latestCompaction: () => f.rows.at(-1) } as V2StoreReader;
    expect(await f.replay.canFold("s", reader)).toBe(false);
    expect(f.loads.every((load) => load.after >= 0)).toBe(true);
    expect(f.logs.join("\n")).toContain("no usable host replay boundary");
});

for (const shape of ["large-tail", "opaque-control", "missing-head"] as const) {
    test(`v3 no-checkpoint 6199-row 206-summary candidate: ${shape}`, async () => {
        const f = fixture(6199);
        appendCompartments(
            f.db,
            "s",
            Array.from({ length: 206 }, (_, i) => ({
                sequence: i,
                startMessage: i * 30 + 1,
                endMessage: Math.min(6180, (i + 1) * 30),
                startMessageId: `u${i * 30 + 1}`,
                endMessageId: `u${Math.min(6180, (i + 1) * 30)}`,
                startBlockIndex: null,
                endBlockIndex: null,
                title: `summary ${i}`,
                content: `history ${i}`,
                p1: `history ${i}`,
                importance: 50,
                episodeType: null,
            })),
        );
        const summary = "served summarized history";
        f.db
            .prepare(
                "UPDATE session_meta SET cached_m0_bytes=?,cached_m0_last_baseline_end_message_id='u6180' WHERE session_id='s'",
            )
            .run(Buffer.from(summary));
        if (shape === "large-tail") f.rows[6198]!.data.text = "x".repeat(9 * 1024 * 1024);
        const tail = f.rows.slice(6180).map((row) => message(row.id, row.data.text as string));
        const control: V2Message = {
            role: "system",
            content: [{ type: "effort", previous: "high", effort: "low" }],
        };
        const served = context([
            message(shape === "missing-head" ? "different-head-id" : HEAD_IDS[0], summary),
            ...tail,
        ]);
        if (shape === "opaque-control") served.messages.splice(2, 0, control);
        await f.replay.capture(
            served,
            [...tail, ...(shape === "opaque-control" ? [control] : [])],
            { id: "u6180", summary },
        );
        expect(await f.replay.canFold("s", f.reader)).toBe(true);
        f.begin();
        expect(await f.replay.supply({ draft: context([]), reader: f.reader, summary })).toBe(true);
        const cut = f.finish(summary);
        const cold = f.make();
        expect(await cold.admits("s", cut, f.reader)).toBe(true);
        f.loads.length = 0;
        const restored = await cold.restore("s", cut, "p/m", { bounded: true });
        expect(restored?.filter((row) => row.role !== "system").map((row) => row.id)).toEqual(
            tail.map((row) => row.id),
        );
        expect(f.loads.every((load) => load.after >= 6179)).toBe(true);
    });
}

test("the v2 admission reader never accepts a v3 record or nominates from it", async () => {
    const f = fixture();
    const raw = [message("u1", "message 1"), message("u2", "message 2")];
    await f.replay.capture(context([message(HEAD_IDS[0], "head"), ...raw]), raw);
    f.begin();
    expect(await f.replay.supply({ draft: context([]), reader: f.reader, summary: "head" })).toBe(
        true,
    );
    const cut = f.finish();
    const future = f.kv.get("native-fold/v3/s");
    f.kv.set("native-fold/v2/s", future);
    const old = f.make(2);
    expect(await old.admits("s", cut, f.reader)).toBe(false);
    expect(await old.canReplay("s", f.reader)).toBe(false);
    expect(await old.canFold("s", f.reader)).toBe(false);
});
