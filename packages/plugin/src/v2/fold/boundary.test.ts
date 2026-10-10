/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type ContextDatabase,
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
} from "../../features/magic-context/storage";
import {
    getPersistedCompactionMarkerState,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { setRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { HEAD_IDS } from "../hooks/payload";
import type { SessionContext, V2Message } from "../hooks/types";
import type { V2StoreReader } from "../store-reader";
import {
    createV2RustCompactionMarkerStrategy,
    resolveBoundaryUserMessage,
    trimToRecordedBoundary,
} from "./boundary";
import { nativeFoldCache } from "./memory-cache";
import { NativeFoldReplay } from "./native-replay";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const openDatabases: ContextDatabase[] = [];

function useTempDataHome(): ContextDatabase {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-v2-boundary-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    mkdirSync(join(dir, "cortexkit", "magic-context"), { recursive: true });
    const db = openDatabase();
    if (!db) throw new Error("test database unavailable");
    openDatabases.push(db);
    return db;
}

afterEach(() => {
    while (openDatabases.length > 0) closeDatabase(openDatabases.pop());
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
});

function raw(id: string, ordinal: number, role: "user" | "assistant"): RawMessage {
    return { id, ordinal, role, parts: [{ type: "text", text: id }] } as RawMessage;
}

/** u1 a1 u2 a2 a3 u3 a4 — ordinals 1..7. */
const history: RawMessage[] = [
    raw("u1", 1, "user"),
    raw("a1", 2, "assistant"),
    raw("u2", 3, "user"),
    raw("a2", 4, "assistant"),
    raw("a3", 5, "assistant"),
    raw("u3", 6, "user"),
    raw("a4", 7, "assistant"),
];

describe("resolveBoundaryUserMessage", () => {
    it("picks the nearest user message at or before the baseline end", () => {
        expect(resolveBoundaryUserMessage(history, "a3")?.id).toBe("u2");
        expect(resolveBoundaryUserMessage(history, "a4")?.id).toBe("u3");
    });

    it("returns the baseline end itself when it is already a user message", () => {
        expect(resolveBoundaryUserMessage(history, "u2")?.id).toBe("u2");
    });

    it("refuses a baseline end that is not in the history", () => {
        expect(resolveBoundaryUserMessage(history, "gone")).toBeNull();
    });

    it("refuses a baseline end with no user message before it", () => {
        expect(resolveBoundaryUserMessage([raw("a0", 1, "assistant")], "a0")).toBeNull();
    });
});

describe("createV2RustCompactionMarkerStrategy", () => {
    const strategy = createV2RustCompactionMarkerStrategy((_sessionId, endMessageId) =>
        resolveBoundaryUserMessage(history, endMessageId),
    );

    it("records the boundary in the marker columns without writing a host row", () => {
        const db = useTempDataHome();
        getOrCreateSessionMeta(db, "ses-1");
        const outcome = strategy.applyDeferred(db, "ses-1", {
            ordinal: 5,
            endMessageId: "a3",
            publishedAt: Date.now(),
        });
        expect(outcome).toEqual({ kind: "applied", markerOrdinal: 5 });
        const state = getPersistedCompactionMarkerState(db, "ses-1");
        expect(state?.boundaryMessageId).toBe("u2");
        expect(state?.boundaryOrdinal).toBe(5);
        expect(state?.targetEndMessageId).toBe("a3");
        // No marker message or parts exist on this host, and the record says so
        // rather than inventing ids that point at nothing.
        expect(state?.summaryMessageId).toBe("");
        expect(state?.compactionPartId).toBe("");
        expect(state?.summaryPartId).toBe("");
    });

    it("advances only forward", () => {
        const db = useTempDataHome();
        getOrCreateSessionMeta(db, "ses-2");
        strategy.applyDeferred(db, "ses-2", {
            ordinal: 5,
            endMessageId: "a3",
            publishedAt: Date.now(),
        });
        const backwards = strategy.applyDeferred(db, "ses-2", {
            ordinal: 3,
            endMessageId: "u2",
            publishedAt: Date.now(),
        });
        expect(backwards).toEqual({ kind: "already-current" });
        expect(getPersistedCompactionMarkerState(db, "ses-2")?.boundaryOrdinal).toBe(5);

        const forwards = strategy.applyDeferred(db, "ses-2", {
            ordinal: 7,
            endMessageId: "a4",
            publishedAt: Date.now(),
        });
        expect(forwards).toEqual({ kind: "applied", markerOrdinal: 7 });
        expect(getPersistedCompactionMarkerState(db, "ses-2")?.boundaryMessageId).toBe("u3");
    });

    it("keeps the previous boundary when the target no longer resolves", () => {
        const db = useTempDataHome();
        getOrCreateSessionMeta(db, "ses-3");
        strategy.applyDeferred(db, "ses-3", {
            ordinal: 5,
            endMessageId: "a3",
            publishedAt: Date.now(),
        });
        const outcome = strategy.applyDeferred(db, "ses-3", {
            ordinal: 9,
            endMessageId: "reverted-away",
            publishedAt: Date.now(),
        });
        expect(outcome.kind).toBe("retryable-failure");
        expect(getPersistedCompactionMarkerState(db, "ses-3")?.boundaryMessageId).toBe("u2");
    });

    it("records the message an OpenCode 1 compaction row would have cut at", () => {
        const db = useTempDataHome();
        getOrCreateSessionMeta(db, "ses-parity");
        // OpenCode 1: the host writes a compaction row at the boundary user message
        // and serves the conversation from there. OpenCode 2 has no such row, so the
        // same rule has to name the same message for the two hosts to agree on where
        // a folded session starts.
        const hostBoundary = resolveBoundaryUserMessage(history, "a3");
        expect(hostBoundary?.id).toBe("u2");
        strategy.applyDeferred(db, "ses-parity", {
            ordinal: 5,
            endMessageId: "a3",
            publishedAt: Date.now(),
        });
        expect(getPersistedCompactionMarkerState(db, "ses-parity")?.boundaryMessageId).toBe(
            hostBoundary!.id,
        );
    });
});

describe("createV2RustCompactionMarkerStrategy with a partial published end", () => {
    it("records the boundary before the partial message and the trim keeps that message", () => {
        const db = useTempDataHome();
        getOrCreateSessionMeta(db, "ses-partial-end");
        // The fold ends partway through a2 (ordinal 4): block 0 is summarized, the
        // file block after it is not.
        db.prepare(
            "INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id, end_block_index, title, content, created_at) VALUES ('ses-partial-end', 0, 1, 4, 'u1', 'a2', 0, 'partial', 'covered', 1)",
        ).run();
        const strategy = createV2RustCompactionMarkerStrategy((_sessionId, endMessageId) =>
            resolveBoundaryUserMessage(history, endMessageId),
        );
        const outcome = strategy.applyDeferred(db, "ses-partial-end", {
            ordinal: 4,
            endMessageId: "a2",
            publishedAt: Date.now(),
        });
        expect(outcome).toEqual({ kind: "applied", markerOrdinal: 4 });
        const state = getPersistedCompactionMarkerState(db, "ses-partial-end");
        // u2 is the nearest user turn before the partial a2: everything before it is
        // whole and covered, and a2 stays after the cut.
        expect(state?.boundaryMessageId).toBe("u2");
        expect(state?.boundaryOrdinal).toBe(4);

        const messages = [
            { id: "u1", ordinal: 1, parts: [{ type: "text", text: "u1" }] },
            { id: "a1", ordinal: 2, parts: [{ type: "text", text: "a1" }] },
            { id: "u2", ordinal: 3, parts: [{ type: "text", text: "u2" }] },
            {
                id: "a2",
                parts: [
                    { type: "text", text: "covered" },
                    { type: "file", url: "UNCOVERED_FILE" },
                ],
            },
            { id: "a3", parts: [{ type: "text", text: "a3" }] },
        ];
        expect(trimToRecordedBoundary(db, "ses-partial-end", messages)).toBe(2);
        expect(messages.map((message) => message.id)).toEqual(["u2", "a2", "a3"]);
        expect(JSON.stringify(messages)).toContain("UNCOVERED_FILE");
    });
});

describe("trimToRecordedBoundary with indexed ends and their successors", () => {
    it("id-only native drafts prove visible gap coverage through bounded metadata, never full body reads", () => {
        const db = useTempDataHome();
        const sid = "ses-native-id-gap";
        getOrCreateSessionMeta(db, sid);
        db.prepare(
            "INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,created_at) VALUES (?,0,4,9,'next-start','tail','t','c',1)",
        ).run(sid);
        setPersistedCompactionMarkerState(db, sid, {
            boundaryOrdinal: 9,
            boundaryMessageId: "boundary-user",
            targetEndMessageId: "tail",
            summaryMessageId: "",
            summaryPartId: "",
            compactionPartId: "",
        });
        const ranges: number[][] = [];
        const release = setRawMessageProvider(sid, {
            readMessages: () => {
                throw new Error("unexpected full body read");
            },
            readMessageOrdinalById: (id) => (id === "boundary-user" ? 8 : null),
            readMessageIdOrdinalsForRange: (from, to) => {
                ranges.push([from, to]);
                return new Map([["real-gap", 3]]);
            },
        });
        try {
            const messages = [
                { id: "real-gap", role: "user" },
                { id: "boundary-user", role: "user" },
                { id: "tail", role: "assistant" },
            ];
            expect(trimToRecordedBoundary(db, sid, messages)).toBe(0);
            expect(messages[0]?.id).toBe("real-gap");
            expect(ranges).toEqual([[1, 7]]);
        } finally {
            release();
        }
    });

    it("unknown visible coordinates and a marker with no covering summaries do not authorize a cut", () => {
        const db = useTempDataHome();
        const sid = "ses-unknown-visible";
        getOrCreateSessionMeta(db, sid);
        setPersistedCompactionMarkerState(db, sid, {
            boundaryOrdinal: 9,
            boundaryMessageId: "boundary-user",
            targetEndMessageId: "tail",
            summaryMessageId: "",
            summaryPartId: "",
            compactionPartId: "",
        });
        for (const knownOrdinal of [undefined, 3]) {
            const messages = [
                { id: "real-gap", role: "user", ordinal: knownOrdinal },
                { id: "boundary-user", role: "user" },
            ];
            expect(trimToRecordedBoundary(db, sid, messages)).toBe(0);
        }
    });
    it("r2 proof: an absent partial endpoint cannot hide visible real content in its successor gap", () => {
        const db = useTempDataHome();
        const sid = "ses-r2-visible-gap";
        getOrCreateSessionMeta(db, sid);
        db.exec(`INSERT INTO compartments(session_id,sequence,start_message,end_message,
        start_message_id,end_message_id,end_block_index,title,content,created_at) VALUES
        ('${sid}',0,1,2,'old-user','absent-partial',0,'t','c',1),
        ('${sid}',1,4,9,'next-start','tail',0,'t','c',1)`);
        setPersistedCompactionMarkerState(db, sid, {
            boundaryOrdinal: 9,
            boundaryMessageId: "boundary-user",
            targetEndMessageId: "tail",
            summaryMessageId: "",
            summaryPartId: "",
            compactionPartId: "",
        });
        const messages = [
            {
                id: "real-gap",
                role: "user",
                ordinal: 3,
                parts: [{ type: "text", text: "UNSUMMARIZED_REAL_GAP" }],
            },
            { id: "boundary-user", role: "user", ordinal: 8, parts: [] },
            { id: "tail", role: "assistant", ordinal: 9, parts: [] },
        ];
        expect(trimToRecordedBoundary(db, sid, messages)).toBe(0);
        expect(JSON.stringify(messages)).toContain("UNSUMMARIZED_REAL_GAP");
    });
    it("an absent earliest partial cannot mask a visible uncovered tool turn before the recorded cut", () => {
        const db = useTempDataHome();
        const sessionId = "ses-absent-partial";
        getOrCreateSessionMeta(db, sessionId);
        db.exec(`INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,end_block_index,title,content,created_at) VALUES
            ('${sessionId}',0,1,2,'absent-user','absent-old-partial',0,'t','c',1),
            ('${sessionId}',1,4,5,'visible-user','visible-partial',0,'t','c',1),
            ('${sessionId}',2,8,9,'boundary-user','tail',0,'t','c',1)`);
        setPersistedCompactionMarkerState(db, sessionId, {
            boundaryOrdinal: 8,
            boundaryMessageId: "boundary-user",
            targetEndMessageId: "tail",
            summaryMessageId: "",
            summaryPartId: "",
            compactionPartId: "",
        });
        const messages = [
            { id: "older", role: "user", ordinal: 1, parts: [] },
            { id: "visible-user", role: "user", ordinal: 4, parts: [] },
            {
                id: "visible-partial",
                ordinal: 5,
                role: "assistant",
                parts: [
                    { type: "tool_use", id: "call" },
                    { type: "text", text: "UNCOVERED_SUFFIX" },
                ],
            },
            {
                id: "other-unsummarized",
                ordinal: 6,
                role: "tool",
                parts: [{ type: "tool_result", tool_use_id: "call" }],
            },
            { id: "boundary-user", role: "user", parts: [] },
            { id: "tail", role: "assistant", parts: [] },
        ];
        expect(trimToRecordedBoundary(db, sessionId, messages)).toBe(1);
        expect(messages[0]?.id).toBe("visible-user");
        expect(JSON.stringify(messages)).toContain("UNCOVERED_SUFFIX");
        expect(messages.some((message) => message.id === "other-unsummarized")).toBe(true);
    });
    type Row = [
        sequence: number,
        startMessage: number,
        endMessage: number,
        startId: string,
        endId: string,
        startBlock: number | null,
        endBlock: number | null,
    ];

    /** Seed compartments, record the boundary for a fold through a4, and trim. */
    function trimWith(rows: Row[]): { dropped: number; ids: string[]; text: string } {
        const db = useTempDataHome();
        const sessionId = "ses-coverage";
        getOrCreateSessionMeta(db, sessionId);
        const insert = db.prepare(
            "INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id, start_block_index, end_block_index, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 't', 'c', 1)",
        );
        for (const row of rows) insert.run(sessionId, ...row);
        createV2RustCompactionMarkerStrategy((_sessionId, endMessageId) =>
            resolveBoundaryUserMessage(history, endMessageId),
        ).applyDeferred(db, sessionId, { ordinal: 7, endMessageId: "a4", publishedAt: 1 });
        const messages = history.map((message) => ({
            id: message.id,
            role: message.role,
            ordinal: message.ordinal,
            parts:
                message.id === "a2"
                    ? [
                          { type: "text", text: "covered" },
                          { type: "file", url: "UNCOVERED_FILE" },
                      ]
                    : [{ type: "text", text: message.id }],
        }));
        const dropped = trimToRecordedBoundary(db, sessionId, messages);
        return {
            dropped,
            ids: messages.map((message) => message.id),
            text: JSON.stringify(messages),
        };
    }

    it("trims past an indexed end whose successor continues on the same message", () => {
        const result = trimWith([
            [0, 1, 4, "u1", "a2", 0, 0],
            [1, 4, 7, "a2", "a4", 1, 0],
        ]);
        // The boundary for a fold through a4 is u3; a2's remainder is in the next row.
        expect(result.dropped).toBe(5);
        expect(result.ids).toEqual(["u3", "a4"]);
    });

    it("trims past a last-block end whose successor starts on the next message", () => {
        const result = trimWith([
            [0, 1, 4, "u1", "a2", 0, 1],
            [1, 5, 7, "a3", "a4", 0, 0],
        ]);
        expect(result.dropped).toBe(5);
        expect(result.ids).toEqual(["u3", "a4"]);
    });

    it("keeps an indexed end whose successor skips a message, with its uncovered blocks", () => {
        const result = trimWith([
            [0, 1, 4, "u1", "a2", 0, 0],
            [1, 6, 7, "u3", "a4", 0, 0],
        ]);
        // a3 (ordinal 5) is in neither row, so a2's remainder may be uncovered: the
        // cut rolls back to a2's user turn instead of the recorded u3.
        expect(result.dropped).toBe(2);
        expect(result.ids).toEqual(["u2", "a2", "a3", "u3", "a4"]);
        expect(result.text).toContain("UNCOVERED_FILE");
    });
});

describe("trimToRecordedBoundary", () => {
    it("a V2 recorded boundary after an indexed end retains its uncovered blocks", () => {
        const db = useTempDataHome();
        getOrCreateSessionMeta(db, "ses-indexed-v2");
        db.prepare(
            "INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id, end_block_index, title, content, created_at) VALUES ('ses-indexed-v2', 0, 1, 4, 'u1', 'a2', 0, 'partial', 'covered', 1)",
        ).run();
        const strategy = createV2RustCompactionMarkerStrategy((_sessionId, endMessageId) =>
            resolveBoundaryUserMessage(history, endMessageId),
        );
        strategy.applyDeferred(db, "ses-indexed-v2", {
            ordinal: 7,
            endMessageId: "a4",
            publishedAt: Date.now(),
        });
        const messages = [
            { id: "u1", parts: [{ type: "text", text: "before" }] },
            {
                id: "a2",
                parts: [
                    { type: "text", text: "covered" },
                    { type: "file", url: "UNCOVERED_FILE" },
                ],
            },
            { id: "a3", parts: [{ type: "text", text: "after" }] },
            { id: "u3", parts: [{ type: "text", text: "tail" }] },
        ];
        trimToRecordedBoundary(db, "ses-indexed-v2", messages);
        expect(JSON.stringify(messages)).toContain("UNCOVERED_FILE");
        const prefix = JSON.stringify(messages);
        const defer = [
            { id: "u1", parts: [{ type: "text", text: "before" }] },
            {
                id: "a2",
                parts: [
                    { type: "text", text: "covered" },
                    { type: "file", url: "UNCOVERED_FILE" },
                ],
            },
            { id: "a3", parts: [{ type: "text", text: "after" }] },
            { id: "u3", parts: [{ type: "text", text: "tail" }] },
            { id: "a4", parts: [{ type: "text", text: "append" }] },
        ];
        trimToRecordedBoundary(db, "ses-indexed-v2", defer);
        expect(JSON.stringify(defer.slice(0, messages.length))).toBe(prefix);
    });
    const strategy = createV2RustCompactionMarkerStrategy((_sessionId, endMessageId) =>
        resolveBoundaryUserMessage(history, endMessageId),
    );

    function record(db: ContextDatabase, sessionId: string, endMessageId: string): void {
        getOrCreateSessionMeta(db, sessionId);
        // A recorded boundary alone is not evidence that a summary covers raw
        // content. These positive trim fixtures have a real covered prefix.
        db.prepare(
            "INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,created_at) VALUES (?,0,1,5,'u1','a3','covered','covered',1)",
        ).run(sessionId);
        strategy.applyDeferred(db, sessionId, {
            ordinal: 5,
            endMessageId,
            publishedAt: Date.now(),
        });
    }

    it("drops exactly the messages before the recorded boundary", () => {
        const db = useTempDataHome();
        record(db, "ses-trim", "a3");
        const messages = history.map((message) => ({ id: message.id, ordinal: message.ordinal }));
        expect(trimToRecordedBoundary(db, "ses-trim", messages)).toBe(2);
        expect(messages.map((message) => message.id)).toEqual(["u2", "a2", "a3", "u3", "a4"]);
    });

    it("does nothing when no boundary has been recorded", () => {
        const db = useTempDataHome();
        getOrCreateSessionMeta(db, "ses-none");
        const messages = history.map((message) => ({ id: message.id }));
        expect(trimToRecordedBoundary(db, "ses-none", messages)).toBe(0);
        expect(messages).toHaveLength(history.length);
    });

    it("does nothing when the boundary is already the first message", () => {
        const db = useTempDataHome();
        record(db, "ses-head", "u1");
        const messages = history.map((message) => ({ id: message.id }));
        expect(trimToRecordedBoundary(db, "ses-head", messages)).toBe(0);
        expect(messages).toHaveLength(history.length);
    });

    it("leaves an array the host has already cut untouched", () => {
        // The host's own compaction row removes the boundary message from the array
        // before the adapter sees it. There is nothing left to drop, and guessing
        // would change what the model sees.
        const db = useTempDataHome();
        record(db, "ses-absent", "a3");
        const messages = [{ id: "u3" }, { id: "a4" }];
        expect(trimToRecordedBoundary(db, "ses-absent", messages)).toBe(0);
        expect(messages.map((message) => message.id)).toEqual(["u3", "a4"]);
    });

    it("produces the same array an OpenCode 1 compaction row would have produced", () => {
        const db = useTempDataHome();
        // OpenCode 1: the host writes a compaction row at the boundary user message
        // and serves from there, and the wire encoder then drops its injected summary
        // row. The array that reaches the module is the boundary message onward.
        const boundary = resolveBoundaryUserMessage(history, "a3");
        expect(boundary).not.toBeNull();
        const hostTrimmed = history
            .slice(history.findIndex((message) => message.id === boundary!.id))
            .map((message) => ({ id: message.id, ordinal: message.ordinal }));

        // OpenCode 2: no row exists, so the same boundary is recorded and applied here.
        record(db, "ses-parity-trim", "a3");
        const adapterTrimmed = history.map((message) => ({
            id: message.id,
            ordinal: message.ordinal,
        }));
        trimToRecordedBoundary(db, "ses-parity-trim", adapterTrimmed);

        expect(adapterTrimmed).toEqual(hostTrimmed);
    });
});

// The ck-mc Rust module composes its own history summary. A host checkpoint must
// preserve the retained messages after its recorded boundary, rather than replace
// that input with a TypeScript-rendered summary.
it("native fold replay preserves the module boundary and baseline on repeated passes", async () => {
    const db = useTempDataHome();
    getOrCreateSessionMeta(db, "s");
    db.prepare(
        "INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,created_at) VALUES ('s',0,1,2,'covered','covered',1)",
    ).run();
    setPersistedCompactionMarkerState(db, "s", {
        boundaryMessageId: "b",
        summaryMessageId: "",
        compactionPartId: "",
        summaryPartId: "",
        boundaryOrdinal: 2,
        targetEndMessageId: "a",
    });
    const native: V2Message[] = [
        { id: "u", ordinal: 1, role: "user", content: [{ type: "text", text: "covered user" }] },
        {
            id: "a",
            ordinal: 2,
            role: "assistant",
            content: [{ type: "text", text: "covered answer" }],
        },
        { id: "b", ordinal: 3, role: "user", content: [{ type: "text", text: "module boundary" }] },
        {
            id: "c",
            ordinal: 4,
            role: "assistant",
            content: [{ type: "text", text: "retained answer" }],
        },
    ];
    expect(trimToRecordedBoundary(db, "s", native)).toBe(2);
    const expected = structuredClone(native);
    const storage = nativeFoldCache(db);
    const reader = {
        close() {},
        latestCompaction: () => undefined,
        rowStampsThrough: () =>
            native.map((message) => ({
                id: message.id,
                type: message.role,
                seq: message.ordinal,
                time_created: 0,
            })),
        replayRowStamps: () =>
            new Map(native.map((message) => [message.ordinal, JSON.stringify(message)])),
        sequenceForId: (_sid: string, id: string) =>
            native.find((message) => message.id === id)?.ordinal,
        latestSequence: () => 4,
        range: () => [],
        latestRunningCompaction: () => ({ id: "cut" }),
    } as unknown as V2StoreReader;
    const replay = new NativeFoldReplay(storage, () => reader);
    const draft: SessionContext = {
        sessionID: "s",
        model: { providerID: "p", id: "m" },
        agent: "build",
        options: {},
        system: [],
        tools: {},
        messages: [
            {
                id: HEAD_IDS[0],
                role: "user",
                content: [{ type: "text", text: "module-owned baseline" }],
            },
            ...native,
        ],
    };
    await replay.capture(draft, native);
    await replay.supply({ draft, reader, summary: "module-owned baseline" });
    const restarted = replay;
    expect(await restarted.baseline("s")).toBe("module-owned baseline");
    const restored = await restarted.restore(
        "s",
        {
            id: "cut",
            session_id: "s",
            type: "compaction",
            seq: 5,
            data: { status: "completed", summary: "module-owned baseline" },
        },
        "p/m",
    );
    expect(restored).toEqual(expected);
    expect(trimToRecordedBoundary(db, "s", restored!)).toBe(0);
    expect(restored).toEqual(expected);
});
