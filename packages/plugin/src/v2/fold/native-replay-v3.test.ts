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
import { foldDigest } from "./owner";

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
        latestSequence: () => Math.max(...rows.map((row) => row.seq), running?.seq ?? 0),
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
        scan: async ({
            prefix,
            after,
            limit,
        }: {
            prefix: string;
            after?: string;
            limit: number;
        }) => {
            const keys = [...kv.keys()]
                .sort()
                .filter((key) => key.startsWith(prefix) && (!after || key > after));
            const entries = keys.slice(0, limit).map((key) => ({ key, value: kv.get(key) }));
            return { entries, ...(keys.length > limit ? { next: entries.at(-1)!.key } : {}) };
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
    let cuts = 0;
    const begin = () => {
        running = {
            id: ++cuts === 1 ? "native-cut" : `native-cut-${cuts}`,
            session_id: "s",
            type: "compaction",
            seq: Math.max(...rows.map((row) => row.seq)) + 1,
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

async function oldReceipt(f: ReturnType<typeof fixture>, summary = "head") {
    const old = f.make(2);
    const raw = f.rows
        .filter((row) => row.type === "user")
        .map((row) => message(row.id, row.data.text as string));
    await old.capture(context([message(HEAD_IDS[0], summary), ...raw]), raw);
    f.begin();
    expect(await old.supply({ draft: context([]), reader: f.reader, summary })).toBe(true);
    const cut = f.finish(summary);
    const bytes = JSON.stringify(f.kv.get("native-fold/v2/s"));
    return { raw, cut, bytes };
}

test("a V2 receipt upgrades once from the host's proven kept range without changing V2 bytes", async () => {
    const f = fixture(3);
    const { cut, bytes } = await oldReceipt(f, "summary covering message 1");
    cut.data.metadata = { keepID: "u2" };
    let hard = 0;
    const draft = context([
        message(cut.id, "host checkpoint"),
        message("u2", "message 2"),
        message("u3", "message 3"),
    ]);
    f.loads.length = 0;
    expect(
        await f.replay.prepareLegacyUpgrade({
            draft,
            cut,
            reader: f.reader,
            onHard: () => {
                hard++;
            },
        }),
    ).toBe(true);
    expect(hard).toBe(1);
    expect(JSON.stringify(f.kv.get("native-fold/v2/s"))).toBe(bytes);
    const cold = f.make();
    expect(
        await cold.prepareLegacyUpgrade({
            draft,
            cut,
            reader: f.reader,
            onHard: () => {
                hard++;
            },
        }),
    ).toBe(false);
    expect(await cold.admits("s", cut, f.reader)).toBe(true);
    expect((await cold.restore("s", cut, "p/m", { bounded: true }))?.map((row) => row.id)).toEqual([
        "u2",
        "u3",
    ]);
    expect(f.loads.every((load) => load.after >= 1)).toBe(true);
    expect(hard).toBe(1);
    expect(f.logs.filter((line) => line.includes("upgrade-state HARD"))).toHaveLength(1);
    expect(f.logs.join("\n")).toContain("mode=bounded");
});

test("a V2 receipt without a proven floor keeps the host checkpoint across restart and the next fold", async () => {
    const f = fixture(3);
    const { raw, cut, bytes } = await oldReceipt(f);
    cut.data.recent = raw.map((row) => row.content[0]!.text).join("\n");
    let hard = 0;
    const draft = context([message(cut.id, "host checkpoint")]);
    f.loads.length = 0;
    expect(
        await f.replay.prepareLegacyUpgrade({
            draft,
            cut,
            reader: f.reader,
            onHard: () => {
                hard++;
            },
        }),
    ).toBe(true);
    expect(hard).toBe(1);
    const carrier = await f.replay.checkpointForReplay("s", f.reader);
    expect(carrier?.rendered.id).toBe(cut.id);
    for (const row of raw)
        expect(JSON.stringify(carrier?.rendered)).toContain(row.content[0]!.text as string);
    expect(await f.replay.admits("s", cut, f.reader)).toBe(true);
    expect(await f.replay.restore("s", cut, "p/m", { bounded: true })).toEqual([]);
    const cold = f.make();
    expect(
        await cold.prepareLegacyUpgrade({
            draft,
            cut,
            reader: f.reader,
            onHard: () => {
                hard++;
            },
        }),
    ).toBe(false);
    expect(await cold.checkpointForReplay("s", f.reader)).toEqual(carrier);
    expect(await cold.admits("s", cut, f.reader)).toBe(true);
    expect(await cold.restore("s", cut, "p/m", { bounded: true })).toEqual([]);
    f.rows.push({
        id: "next",
        session_id: "s",
        type: "user",
        seq: 5,
        data: { text: "new turn after fallback" },
    });
    const next = message("next", "new turn after fallback");
    await cold.capture(context([message(HEAD_IDS[0], "head"), next]), [next]);
    expect(await cold.canFold("s", f.reader)).toBe(true);
    f.begin();
    expect(await cold.supply({ draft: context([]), reader: f.reader, summary: "head" })).toBe(true);
    const nextCut = f.finish();
    const restarted = f.make();
    expect(await restarted.admits("s", nextCut, f.reader)).toBe(true);
    const restored = await restarted.restore("s", nextCut, "p/m", { bounded: true });
    expect(restored?.map((row) => row.id)).toEqual(["next"]);
    expect(await restarted.checkpointForReplay("s", f.reader)).toEqual(carrier);
    expect(f.loads.every((load) => load.after >= cut.seq - 1)).toBe(true);
    expect(JSON.stringify(f.kv.get("native-fold/v2/s"))).toBe(bytes);
    expect(hard).toBe(1);
    expect(f.logs.filter((line) => line.includes("upgrade-state HARD"))).toHaveLength(1);
    expect(f.logs.join("\n")).toContain("mode=host-checkpoint");
});

test("a session without a V2 receipt never takes the upgrade fallback", async () => {
    const f = fixture();
    f.begin();
    const cut = f.finish("ordinary host checkpoint");
    let hard = 0;
    expect(
        await f.replay.prepareLegacyUpgrade({
            draft: context([]),
            cut,
            reader: f.reader,
            onHard: () => {
                hard++;
            },
        }),
    ).toBe(false);
    expect(hard).toBe(0);
    expect(f.logs.filter((line) => line.includes("upgrade-state HARD"))).toEqual([]);
    expect(f.kv.size).toBe(0);
});

test("a revoked V1 receipt stays untouched and unadmitted until cleanup", async () => {
    const f = fixture();
    f.begin();
    const cut = f.finish();
    const key = `native-fold/v1/${foldDigest(f.reader.hostIdentity())}/s`;
    const payload = JSON.stringify({
        source: f.reader.hostIdentity(),
        sessionID: "s",
        admissionID: cut.id,
        summary: "head",
    });
    const receipt = { payload, digest: foldDigest(payload) };
    f.kv.set(key, receipt);
    expect(await f.make(2).admits("s", cut, f.reader)).toBe(false);
    expect(await f.replay.admits("s", cut, f.reader)).toBe(false);
    expect(
        await f.replay.prepareLegacyUpgrade({
            draft: context([]),
            cut,
            reader: f.reader,
            onHard: () => {
                throw new Error("V1 must not upgrade");
            },
        }),
    ).toBe(false);
    expect(f.kv.get(key)).toEqual(receipt);
    await f.replay.forget("s");
    expect(f.kv.has(key)).toBe(false);
});

test("an unsupported effort control blocks a new fold but not a V2 upgrade turn", async () => {
    const f = fixture();
    const { cut } = await oldReceipt(f);
    const draft = context([
        { role: "system", content: [{ type: "effort", effort: "future-private-effort" }] },
        message(cut.id, "host checkpoint"),
    ]);
    const before = JSON.stringify(draft);
    expect(await f.replay.prepareLegacyUpgrade({ draft, cut, reader: f.reader, onHard() {} })).toBe(
        true,
    );
    expect(JSON.stringify(draft)).toBe(before);
    expect(await f.replay.checkpointForReplay("s", f.reader)).toBeDefined();
    expect(await f.replay.canFold("s", f.reader)).toBe(false);
    expect(f.logs.filter((line) => line.includes("upgrade-state HARD"))).toHaveLength(1);
});
