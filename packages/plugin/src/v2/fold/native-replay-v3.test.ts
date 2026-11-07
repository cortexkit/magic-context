import { afterEach, expect, spyOn, test } from "bun:test";
import { patchSessionMeta } from "../../features/magic-context/__tests__/session-meta-fixture";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { runMigrations } from "../../features/magic-context/migrations";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { HEAD_IDS } from "../hooks/payload";
import type { SessionContext, V2Message } from "../hooks/types";
import type { StoreRow, V2StoreReader } from "../store-reader";
import { type NativeFoldBudget, nativeFoldCache } from "./memory-cache";
import { NativeFoldReplay } from "./native-replay";
import { encodeAdmissionV3, IMPORTED_MC_SUMMARY, validAdmissionV3 } from "./native-replay-v3";
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
const assistantWithTool = (id: string): V2Message => ({
    id,
    role: "assistant",
    content: [{ type: "tool-call", id: `call-${id}`, name: "read", input: {} }],
    metadata: {},
});
const toolResult = (id: string): V2Message => ({
    role: "tool",
    content: [
        {
            type: "tool-result",
            id: `call-${id}`,
            name: "read",
            result: { type: "text", value: "ok" },
        },
    ],
});
function fixture(count = 2, imported = 0, budget?: NativeFoldBudget) {
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
    const cache = nativeFoldCache(db, budget);
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

async function captureAfterSummary(native: "full" | "tail", toolBeforeFloor: boolean) {
    const f = fixture(6);
    f.rows[1] = { ...f.rows[1]!, type: "assistant" };
    f.rows[4] = { ...f.rows[4]!, type: "assistant" };
    const summary = "summary covering messages 1 through 4";
    f.db
        .prepare(
            "UPDATE session_meta SET cached_m0_bytes=?,cached_m0_last_baseline_end_message_id='u4' WHERE session_id='s'",
        )
        .run(Buffer.from(summary));
    const before = [
        message("u1"),
        assistantWithTool("u2"),
        ...(toolBeforeFloor ? [toolResult("u2")] : []),
        message("u3"),
        message("u4"),
    ];
    const tail = [assistantWithTool("u5"), toolResult("u5"), message("u6")];
    const input = native === "full" ? [...before, ...tail] : tail;
    await f.replay.capture(context([message(HEAD_IDS[0], summary), ...input]), input, {
        id: "u4",
        summary,
    });
    return f.logs.filter((line) => line.includes("capture unavailable"));
}
test("v3 capture keeps working when a tool result precedes the summary floor", async () => {
    expect(await captureAfterSummary("full", true)).toEqual([]);
    expect(await captureAfterSummary("full", false)).toEqual([]);
    expect(await captureAfterSummary("tail", true)).toEqual([]);
});

test("v3 capture drops a covered tool group across an id-less system below the floor", async () => {
    const f = fixture(3);
    f.rows[0] = { ...f.rows[0]!, type: "assistant" };
    f.rows[1] = { ...f.rows[1]!, type: "system", data: { text: "stored instructions" } };
    const summary = "summary through the stored instructions";
    const native: V2Message[] = [
        assistantWithTool("u1"),
        { role: "system", content: [{ type: "text", text: "stored instructions" }] },
        toolResult("u1"),
        message("u3"),
    ];

    await f.replay.capture(context([message(HEAD_IDS[0], summary), ...native]), native, {
        id: "u2",
        summary,
    });

    expect(f.logs.filter((line) => line.includes("capture unavailable"))).toEqual([]);
    expect(f.cache.rows("s", -1, Infinity).map((row) => row.id)).toEqual(["u3"]);
});

test("v3 capture keeps a retained tool result across an id-less baseline user message", async () => {
    const f = fixture(2);
    f.rows[0] = { ...f.rows[0]!, type: "assistant" };
    const summary = "served baseline";
    const assistant = assistantWithTool("u1");
    const result = toolResult("u1");
    const native: V2Message[] = [
        assistant,
        { role: "user", content: [{ type: "text", text: summary }] },
        result,
        message("u2"),
    ];

    await f.replay.capture(context([message(HEAD_IDS[0], summary), ...native]), native);

    expect(f.logs).toEqual([]);
    const rows = f.cache.rows("s", -1, Infinity);
    expect(rows.map((row) => row.id)).toEqual(["u1", "u2"]);
    expect(rows.flatMap((row) => JSON.parse(row.data) as V2Message[])).toEqual([
        assistant,
        result,
        message("u2"),
    ]);
});

for (const floor of ["summary", "start"] as const) {
    for (const missingSequence of [false, true]) {
        test(`v3 ${floor} capture keeps tool groups intact with missing sequence=${missingSequence}`, async () => {
            const f = fixture(3);
            f.rows[0] = { ...f.rows[0]!, type: "assistant" };
            f.rows[1] = { ...f.rows[1]!, type: "assistant" };
            const summary = "served baseline";
            const group = (id: string): V2Message[] => {
                const assistant = assistantWithTool(id);
                assistant.content.push(...assistantWithTool(`${id}-second`).content);
                return [assistant, toolResult(id), toolResult(`${id}-second`)];
            };
            const first = group("u1");
            const second = group("u2");
            const effort: V2Message = {
                role: "system",
                content: [{ type: "effort", effort: "low", previous: "high" }],
            };
            const skipped = [effort, ...HEAD_IDS.map((id) => message(id, summary))];
            const native = [
                toolResult("orphan"),
                ...skipped,
                toolResult("after-controls"),
                { role: "user", content: [{ type: "text", text: summary }] } as V2Message,
                toolResult("after-baseline"),
                first[0]!,
                ...skipped,
                ...first.slice(1),
                second[0]!,
                ...skipped,
                ...second.slice(1),
                message("u3"),
            ];
            const served = context([message(HEAD_IDS[0], summary), ...native]);
            const before = JSON.stringify(served);
            const sequenceForId = f.reader.sequenceForId.bind(f.reader);
            const sequence = spyOn(f.reader, "sequenceForId").mockImplementation((sid, id) =>
                missingSequence && id === "u2" ? undefined : sequenceForId(sid, id),
            );
            try {
                await f.replay.capture(
                    served,
                    native,
                    floor === "summary" ? { id: "u1", summary } : undefined,
                );
                expect(f.logs).toEqual([]);
                expect(JSON.stringify(served)).toBe(before);
                const rows = f.cache.rows("s", -1, Infinity);
                expect(rows.map((row) => row.id)).toEqual(
                    floor === "summary" ? ["u2", "u3"] : ["u1", "u2", "u3"],
                );
                expect(rows.flatMap((row) => JSON.parse(row.data) as V2Message[])).toEqual([
                    ...(floor === "summary" ? [] : first),
                    ...second,
                    message("u3"),
                ]);
            } finally {
                sequence.mockRestore();
            }
        });
    }
}

test("v3 capture reads the served baseline a constant number of times and preserves replay bytes", async () => {
    const f = fixture(50);
    const raw = f.rows.map((row) => message(row.id, row.data.text as string));
    const head: V2Message = { role: "user", content: [{ type: "text", text: "head" }] };
    const native = [head, ...raw];
    const draft = context([message(HEAD_IDS[0], "head"), ...raw]);
    const before = JSON.stringify(draft);
    const baseline = spyOn(
        f.replay as unknown as { servedBaseline: (draft: SessionContext) => string | undefined },
        "servedBaseline",
    );
    try {
        // Initialize the replay floor, then count a capture independently of setup.
        await f.replay.capture(draft, native);
        baseline.mockClear();
        await f.replay.capture(draft, native);
        expect(baseline).toHaveBeenCalledTimes(3);
        expect(JSON.stringify(draft)).toBe(before);
        f.begin();
        expect(
            await f.replay.supply({ draft: context([]), reader: f.reader, summary: "head" }),
        ).toBe(true);
        const cut = f.finish();
        const cold = f.make();
        expect(await cold.admits("s", cut, f.reader)).toBe(true);
        expect(JSON.stringify(await cold.restore("s", cut, "p/m", { bounded: true }))).toBe(
            JSON.stringify(raw),
        );
    } finally {
        baseline.mockRestore();
    }
});

test("v3 warm capture reuses evicted identity stamps but reloads changed source coordinates", async () => {
    const f = fixture(3, 0, { maxSessions: 1, maxSessionBytes: 1 });
    const stamps = spyOn(f.reader, "rowStampsThrough");
    const sequences = spyOn(f.reader, "sequenceForId");
    const capture = () => {
        const raw = f.rows.map((row) => message(row.id, row.data.text as string));
        return f.replay.capture(context([message(HEAD_IDS[0], "head"), ...raw]), raw);
    };
    try {
        await capture();
        expect(stamps).toHaveBeenCalledTimes(1);
        expect(f.cache.usage()).toEqual({ sessions: 0, bytes: 0 });
        stamps.mockClear();
        sequences.mockClear();
        for (let pass = 0; pass < 3; pass++) await capture();
        expect(stamps).not.toHaveBeenCalled();
        expect(sequences).not.toHaveBeenCalled();
        expect(f.cache.tail("s")).toBeUndefined();

        f.rows.push({ id: "new", seq: 4, session_id: "s", type: "user", data: { text: "new" } });
        await capture();
        expect(stamps).toHaveBeenCalledTimes(1);
        stamps.mockClear();
        f.replay.invalidate("s");
        await capture();
        expect(stamps).toHaveBeenCalledTimes(1);
        stamps.mockClear();

        const identity = spyOn(f.reader, "hostIdentity").mockReturnValue("replacement-host");
        try {
            await capture();
            expect(stamps).toHaveBeenCalledTimes(1);
        } finally {
            identity.mockRestore();
        }
        stamps.mockClear();
        await f.replay.forget("s");
        await capture();
        expect(stamps).toHaveBeenCalledTimes(1);
    } finally {
        stamps.mockRestore();
        sequences.mockRestore();
    }
});

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
        patchSessionMeta(f.db, "s", {
            cached_m0_bytes: Buffer.from(summary),
            cached_m0_last_baseline_end_message_id: "u6180",
        });
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

test("a V2 receipt upgrades once from exact summary coverage, not keepID alone", async () => {
    const f = fixture(8);
    const summary = "summary covering messages 1 through 6";
    const { cut, bytes } = await oldReceipt(f, summary);
    cut.data.metadata = { keepID: "u8" };
    patchSessionMeta(f.db, "s", {
        cached_m0_bytes: Buffer.from(summary),
        cached_m0_last_baseline_end_message_id: "u6",
    });
    let hard = 0;
    const draft = context([message(cut.id, "host checkpoint"), message("u8", "message 8")]);
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
    expect(hard).toBe(0);
    expect(f.kv.has("native-fold/v3/s")).toBe(false);
    expect(f.loads.filter((load) => load.after === -1)).toHaveLength(1);
    expect(await f.replay.commitLegacyUpgrade("s", true)).toBe(true);
    f.loads.length = 0;
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
        "u7",
        "u8",
    ]);
    expect(f.loads.every((load) => load.after >= 5)).toBe(true);
    expect(hard).toBe(0);
    expect(f.logs.filter((line) => line.includes("upgrade-state HARD"))).toHaveLength(1);
    expect(f.logs.join("\n")).toContain("mode=bounded");
});

test("validated legacy source survives restart and the next fold without trusting recent text", async () => {
    const f = fixture(3);
    const { raw, cut, bytes } = await oldReceipt(f);
    cut.data.recent = raw.map((row) => row.content[0]!.text).join("\n");
    let hard = 0;
    const draft = context([message(cut.id, "host checkpoint")]);
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
    expect(f.replay.legacyUpgradeInput("s", draft.model)).toEqual(raw);
    expect(await f.replay.checkpointForReplay("s", f.reader)).toBeUndefined();
    expect(await f.replay.commitLegacyUpgrade("s", false)).toBe(false);
    expect(f.kv.has("native-fold/v3/s")).toBe(false);
    expect(hard).toBe(0);
    expect(await f.replay.commitLegacyUpgrade("s", true)).toBe(true);
    f.loads.length = 0;
    const cold = f.make();
    expect(await cold.prepareLegacyUpgrade({ draft, cut, reader: f.reader })).toBe(false);
    expect(await cold.admits("s", cut, f.reader)).toBe(true);
    expect(await cold.restore("s", cut, "p/m", { bounded: true })).toEqual(raw);
    f.rows.push({
        id: "next",
        session_id: "s",
        type: "user",
        seq: 5,
        data: { text: "new turn after fallback" },
    });
    const next = message("next", "new turn after fallback");
    await cold.capture(context([message(HEAD_IDS[0], "head"), ...raw, next]), [...raw, next]);
    expect(await cold.canFold("s", f.reader)).toBe(true);
    f.begin();
    expect(await cold.supply({ draft: context([]), reader: f.reader, summary: "head" })).toBe(true);
    const nextCut = f.finish();
    const restarted = f.make();
    expect(await restarted.admits("s", nextCut, f.reader)).toBe(true);
    expect(
        (await restarted.restore("s", nextCut, "p/m", { bounded: true }))?.map((row) => row.id),
    ).toEqual(["u1", "u2", "u3", "next"]);
    expect(f.loads.every((load) => load.after >= 0)).toBe(true);
    expect(JSON.stringify(f.kv.get("native-fold/v2/s"))).toBe(bytes);
    expect(hard).toBe(0);
    expect(f.logs.filter((line) => line.includes("upgrade-state HARD"))).toHaveLength(1);
    expect(f.logs.join("\n")).toContain("mode=source-repair");
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
    cut.data.recent = "message 1\nmessage 2";
    const draft = context([
        { role: "system", content: [{ type: "effort", effort: "future-private-effort" }] },
        message(cut.id, "host checkpoint"),
    ]);
    const before = JSON.stringify(draft);
    expect(await f.replay.prepareLegacyUpgrade({ draft, cut, reader: f.reader, onHard() {} })).toBe(
        true,
    );
    expect(JSON.stringify(draft)).toBe(before);
    expect(await f.replay.checkpointForReplay("s", f.reader)).toBeUndefined();
    expect(f.replay.legacyUpgradeInput("s", draft.model)?.map((row) => row.id)).toEqual([
        "u1",
        "u2",
    ]);
    expect(await f.replay.commitLegacyUpgrade("s", true)).toBe(false);
    expect(await f.replay.canFold("s", f.reader)).toBe(false);
    expect(f.logs.filter((line) => line.includes("upgrade-state HARD"))).toHaveLength(0);
});

test("a legacy-only full repair retries after interruption and persists only its successful source floor", async () => {
    const f = fixture(8);
    const { cut } = await oldReceipt(f);
    cut.data.metadata = { keepID: "u8" };
    f.loads.length = 0;
    const draft = context([message(cut.id, "host checkpoint"), message("u8", "message 8")]);
    let hard = 0;
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
    expect(f.kv.has("native-fold/v3/s")).toBe(false);
    const projection = f.replay as unknown as {
        rendered(row: StoreRow, model: SessionContext["model"]): V2Message[];
    };
    const interrupted = spyOn(projection, "rendered").mockImplementationOnce(() => {
        throw new Error("repair interrupted");
    });
    try {
        expect(() => f.replay.legacyUpgradeInput("s", draft.model)).toThrow("repair interrupted");
    } finally {
        interrupted.mockRestore();
        f.replay.cancelLegacyUpgrade("s");
    }
    expect(f.kv.has("native-fold/v3/s")).toBe(false);
    expect(f.logs.filter((line) => line.includes("upgrade-state HARD"))).toEqual([]);
    const retry = f.make();
    expect(
        await retry.prepareLegacyUpgrade({
            draft,
            cut,
            reader: f.reader,
            onHard: () => {
                hard++;
            },
        }),
    ).toBe(true);
    expect(retry.legacyUpgradeInput("s", draft.model)?.map((row) => row.id)).toEqual(
        f.rows.filter((row) => row.type === "user").map((row) => row.id),
    );
    expect(f.loads.filter((load) => load.after === -1)).toHaveLength(2);
    const summary = "summary covering messages 1 through 6";
    patchSessionMeta(f.db, "s", {
        cached_m0_bytes: Buffer.from(summary),
        cached_m0_last_baseline_end_message_id: "u6",
    });
    const tail = [message("u7", "message 7"), message("u8", "message 8")];
    await retry.capture(context([message(HEAD_IDS[0], summary), ...tail]), tail, {
        id: "u6",
        summary,
    });
    expect(await retry.commitLegacyUpgrade("s", true)).toBe(true);
    expect(f.logs.filter((line) => line.includes("upgrade-state HARD"))).toHaveLength(1);
    expect(f.logs.join("\n")).toMatch(/mode=source-repair rows_read=8 duration_ms=\d+ floor=u6:6/);
    f.loads.length = 0;
    const restarted = f.make();
    expect(
        await restarted.prepareLegacyUpgrade({
            draft,
            cut,
            reader: f.reader,
            onHard: () => {
                hard++;
            },
        }),
    ).toBe(false);
    expect(await restarted.admits("s", cut, f.reader)).toBe(true);
    expect(
        (await restarted.restore("s", cut, "p/m", { bounded: true }))?.map((row) => row.id),
    ).toEqual(["u7", "u8"]);
    expect(f.loads.every((load) => load.after >= 5)).toBe(true);
    expect(hard).toBe(0);
});

test("an edited start row retains its proven coordinate and refreshes provenance only after the shared rebuild", async () => {
    const f = fixture(3);
    const raw = f.rows.map((row) => message(row.id, row.data.text as string));
    await f.replay.capture(context([message(HEAD_IDS[0], "head"), ...raw]), raw);
    f.begin();
    expect(await f.replay.supply({ draft: context([]), reader: f.reader, summary: "head" })).toBe(
        true,
    );
    const cut = f.finish();
    const before = JSON.stringify(f.kv.get("native-fold/v3/s"));
    f.rows[0]!.data.text = "edited first source row";
    const cold = f.make();
    expect(await cold.admits("s", cut, f.reader)).toBe(false);
    expect(cold.sourceChanged("s")).toBe(true);
    expect(cold.needsHeadRebuild("s")).toBe(true);
    expect(await cold.restorationFloor("s", cut, f.reader)).toBe(0);
    expect(JSON.stringify(f.kv.get("native-fold/v3/s"))).toBe(before);
    const current = await cold.restoreRead("s", cut, context([]).model);
    expect(current[0]!.content[0]!.text).toBe("edited first source row");
    await cold.capture(context([message(HEAD_IDS[0], "head"), ...current]), current);
    expect(JSON.stringify(f.kv.get("native-fold/v3/s"))).toBe(before);
    expect(await cold.commitEditedAdmission("s")).toBe(true);
    expect(cold.sourceChanged("s")).toBe(false);
    const restarted = f.make();
    expect(await restarted.admits("s", cut, f.reader)).toBe(true);
    expect(
        (await restarted.restore("s", cut, "p/m", { bounded: true }))?.[0]?.content[0]?.text,
    ).toBe("edited first source row");
});

test("a missing or replaced start coordinate cannot be healed as a content edit", async () => {
    const f = fixture();
    const raw = f.rows.map((row) => message(row.id, row.data.text as string));
    await f.replay.capture(context([message(HEAD_IDS[0], "head"), ...raw]), raw);
    f.begin();
    expect(await f.replay.supply({ draft: context([]), reader: f.reader, summary: "head" })).toBe(
        true,
    );
    const cut = f.finish();
    const before = JSON.stringify(f.kv.get("native-fold/v3/s"));
    f.rows[0] = { ...f.rows[0]!, id: "replacement-at-the-same-sequence" };
    const cold = f.make();
    expect(await cold.admits("s", cut, f.reader)).toBe(false);
    expect(cold.sourceChanged("s")).toBe(false);
    expect(await cold.commitEditedAdmission("s")).toBe(false);
    expect(await cold.canFold("s", f.reader)).toBe(false);
    expect(JSON.stringify(f.kv.get("native-fold/v3/s"))).toBe(before);
});

test("V3 readers and writers reject conversation fields at every metadata level", async () => {
    const f = fixture();
    const raw = f.rows.map((row) => message(row.id, row.data.text as string));
    await f.replay.capture(context([message(HEAD_IDS[0], "head"), ...raw]), raw);
    f.begin();
    expect(await f.replay.supply({ draft: context([]), reader: f.reader, summary: "head" })).toBe(
        true,
    );
    const cut = f.finish();
    const saved = f.kv.get("native-fold/v3/s") as { payload: string };
    const original = JSON.parse(saved.payload);
    const mutations = [
        (value: typeof original) => {
            value.conversation = "PRIVATE_CONVERSATION";
        },
        (value: typeof original) => {
            value.proof.conversation = "PRIVATE_CONVERSATION";
        },
        (value: typeof original) => {
            value.replay.conversation = "PRIVATE_CONVERSATION";
        },
        (value: typeof original) => {
            value.replay.floor.conversation = "PRIVATE_CONVERSATION";
        },
        (value: typeof original) => {
            value.replay.controls = [[]];
        },
        (value: typeof original) => {
            value.replay.controls = [{ effort: "high", conversation: "PRIVATE_CONVERSATION" }];
        },
        (value: typeof original) => {
            value.replay.upgrade = {
                admissionID: cut.id,
                mode: "bounded",
                conversation: "PRIVATE_CONVERSATION",
            };
        },
        (value: typeof original) => {
            value.replay.blocked = { conversation: "PRIVATE_CONVERSATION" };
        },
    ];
    for (const mutate of mutations) {
        const value = structuredClone(original);
        mutate(value);
        expect(validAdmissionV3(value)).toBe(false);
        expect(() => encodeAdmissionV3(value)).toThrow(
            "Unsupported native fold admission metadata",
        );
        const payload = JSON.stringify(value);
        f.kv.set("native-fold/v3/s", { payload, digest: foldDigest(payload) });
        expect(await f.make().admits("s", cut, f.reader)).toBe(false);
    }
});
