import { expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { HEAD_IDS } from "../hooks/payload";
import type { SessionContext, V2Message } from "../hooks/types";
import type { StoreRow, V2StoreReader } from "../store-reader";
import { nativeFoldCache } from "./memory-cache";
import { captureInputsKey, NativeFoldReplay } from "./native-replay";

// One captured session whose host compaction can be started on demand.
function capturedSession() {
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
    let running: StoreRow<"compaction"> | undefined;
    const reader = {
        close() {},
        hostIdentity: () => "capture-skip-store",
        latestSequence: () => running?.seq ?? 1,
        latestCompaction: () => undefined,
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
    const effort = (level: string): V2Message => ({
        role: "system",
        content: [{ type: "effort", effort: level, previous: "high" }],
    });
    const draft = (head: string, native: V2Message[]): SessionContext => ({
        sessionID: "s",
        model: { providerID: "p", id: "m" },
        agent: "build",
        system: [],
        tools: {},
        options: {},
        messages: [
            { id: HEAD_IDS[0], role: "user", content: [{ type: "text", text: head }] },
            ...native,
        ],
    });
    const cache = nativeFoldCache(db, { maxSessionBytes: 16 * 1024 * 1024, maxSessions: 4 });
    const replay = new NativeFoldReplay(cache, () => reader, storage, { protocol: 3 });
    return {
        db,
        reader,
        raw,
        effort,
        draft,
        replay,
        startCompaction() {
            running = {
                id: "cut",
                session_id: "s",
                seq: 2,
                type: "compaction",
                data: { status: "running" },
            };
        },
    };
}

test("a capture holds only while the model and effort controls are unchanged", async () => {
    const s = capturedSession();
    try {
        const native = [...s.raw, s.effort("low")];
        expect(s.replay.captureCurrent("s", "p/m", native)).toBe(false);
        await s.replay.capture(s.draft("head", native), native);
        expect(s.replay.captureCurrent("s", "p/m", native)).toBe(true);
        expect(s.replay.captureCurrent("s", "p/m", [...native, s.effort("max")])).toBe(false);
        expect(s.replay.captureCurrent("s", "p/m", [...s.raw, s.effort("max")])).toBe(false);
        expect(s.replay.captureCurrent("s", "p/other", native)).toBe(false);
        s.replay.invalidate("s");
        expect(s.replay.captureCurrent("s", "p/m", native)).toBe(false);
    } finally {
        s.db.close();
    }
});

test("a skipped pass whose served head changed refuses the host fold until the next capture", async () => {
    const s = capturedSession();
    try {
        const native = [...s.raw, s.effort("low")];
        await s.replay.capture(s.draft("head", native), native);
        s.replay.noteSkippedCapture(s.draft("head 2", native), undefined);
        expect(s.replay.captureCurrent("s", "p/m", native)).toBe(false);
        s.startCompaction();
        expect(
            await s.replay.supply({
                draft: s.draft("head 2", native),
                reader: s.reader,
                summary: "head 2",
            }),
        ).toBe(false);
        // The next pass copies and captures again, which proves the controls.
        await s.replay.capture(s.draft("head 2", native), native);
        expect(s.replay.captureCurrent("s", "p/m", native)).toBe(true);
        expect(
            await s.replay.supply({
                draft: s.draft("head 2", native),
                reader: s.reader,
                summary: "head 2",
            }),
        ).toBe(true);
    } finally {
        s.db.close();
    }
});

test("a skipped pass with the same served head and boundary keeps the capture", async () => {
    const s = capturedSession();
    try {
        const native = [...s.raw, s.effort("low")];
        await s.replay.capture(s.draft("head", native), native);
        s.replay.noteSkippedCapture(s.draft("head", native), undefined);
        expect(s.replay.captureCurrent("s", "p/m", native)).toBe(true);
        s.replay.noteSkippedCapture(s.draft("head", native), "boundary-moved");
        expect(s.replay.captureCurrent("s", "p/m", native)).toBe(false);
    } finally {
        s.db.close();
    }
});

test("a skipped pass whose capture was not current refuses the host fold even with the same head", async () => {
    const s = capturedSession();
    try {
        const native = [...s.raw, s.effort("low")];
        await s.replay.capture(s.draft("head", native), native);
        s.replay.noteSkippedCapture(s.draft("head", native), undefined, false);
        expect(s.replay.captureCurrent("s", "p/m", native)).toBe(false);
        s.startCompaction();
        expect(
            await s.replay.supply({
                draft: s.draft("head", native),
                reader: s.reader,
                summary: "head",
            }),
        ).toBe(false);
    } finally {
        s.db.close();
    }
});

test("a copy that gave no current capture is not repeated for the same inputs and served head", async () => {
    const s = capturedSession();
    try {
        const native = [...s.raw, s.effort("low")];
        const key = captureInputsKey("p/m", native);
        expect(s.replay.copyWanted("s", key)).toBe(true);
        // The capture did not run: the copy is settled as failed.
        s.replay.settleCopy(s.draft("head", native), key);
        expect(s.replay.copyWanted("s", key)).toBe(false);
        // Other effort controls or another model may copy again.
        const otherEffort = captureInputsKey("p/m", [...s.raw, s.effort("max")]);
        expect(s.replay.copyWanted("s", otherEffort)).toBe(true);
        expect(s.replay.copyWanted("s", captureInputsKey("p/other", native))).toBe(true);
        // A skipped pass with the same served head keeps the failure.
        s.replay.noteSkippedCapture(s.draft("head", native), undefined, false);
        expect(s.replay.copyWanted("s", key)).toBe(false);
        // A changed served head lets the next pass try once more.
        s.replay.noteSkippedCapture(s.draft("head 2", native), undefined, false);
        expect(s.replay.copyWanted("s", key)).toBe(true);
        // A capture that runs makes the inputs current and clears the failure.
        await s.replay.capture(s.draft("head 2", native), native);
        s.replay.settleCopy(s.draft("head 2", native), key);
        expect(s.replay.captureCurrentFor("s", key)).toBe(true);
        expect(s.replay.copyWanted("s", key)).toBe(false);
        s.replay.invalidate("s");
        expect(s.replay.copyWanted("s", key)).toBe(true);
    } finally {
        s.db.close();
    }
});

test("a skipped pass whose served head disappeared marks the capture unproven", async () => {
    const s = capturedSession();
    try {
        const native = [...s.raw, s.effort("low")];
        await s.replay.capture(s.draft("head", native), native);
        const headless = { ...s.draft("head", native), messages: native };
        s.replay.noteSkippedCapture(headless, undefined);
        expect(s.replay.captureCurrent("s", "p/m", native)).toBe(false);
    } finally {
        s.db.close();
    }
});
