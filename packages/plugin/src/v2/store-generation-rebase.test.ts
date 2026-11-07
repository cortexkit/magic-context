import { beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { patchSessionMeta } from "../features/magic-context/__tests__/session-meta-fixture";

import {
    getCompartments,
    getLastCompartmentEndMessage,
} from "../features/magic-context/compartment-storage";
import {
    ensureMessagesIndexed,
    getLastIndexedOrdinal,
} from "../features/magic-context/message-index";
import { runMigrations } from "../features/magic-context/migrations";
import { getOrCreateSessionMeta } from "../features/magic-context/storage";
import { initializeDatabase } from "../features/magic-context/storage-db";
import {
    type CoordinateGeneration,
    formatCoordinateRebaseNotice,
    formatRebaseLogLine,
    readCoordinateGeneration,
    readCoordinateRebaseNotice,
    rebaseSessionCoordinates,
} from "../features/magic-context/store-generation-rebase";
import { nonNarrativeStoredGapRanges } from "../hooks/magic-context/compartment-runner-incremental";
import { validateStoredCompartments } from "../hooks/magic-context/compartment-runner-validation";
import {
    clearCtxReduceAvailability,
    resolveCtxReduceAvailabilityFromMessages,
} from "../hooks/magic-context/ctx-reduce-availability";
import { clearInjectionCache, injectM0M1 } from "../hooks/magic-context/inject-compartments";
import { saveLkgSlotToDb } from "../hooks/magic-context/lkg-persist";
import { withRawMessageProvider } from "../hooks/magic-context/read-session-chunk";
import type { RawMessage } from "../hooks/magic-context/read-session-raw";
import { createSystemPromptHashHandler } from "../hooks/magic-context/system-prompt-hash";
import { Database } from "../shared/sqlite";
import { rawMessages } from "./hooks/store";
import type { StoreRow } from "./store-reader";

/**
 * When an OpenCode 2 host imports a 1.x store it re-projects the conversation:
 * a user turn carrying both ordinary and synthetic text becomes two rows, and a
 * completed compaction pair becomes one row that the raw projection does not
 * count at all. Message ids survive, but the positional ordinals Magic Context
 * saved against the 1.x projection do not, so a compartment's saved end ordinal
 * stops pointing at its saved endpoint message.
 *
 * The rows below are exactly what `@opencode/cli@2.0.5` wrote into
 * `session_message` when it converted a synthetic 1.x store in a throwaway root;
 * the "before" ordinals are what MC's 1.x reader produced from the same store
 * before conversion. Rebase must recover endpoints by message identity rather
 * than reusing ordinals from the old projection.
 *
 * Every case below drives the real rebase against a real Magic Context database:
 * the saved state is written the way the product writes it, the projection is
 * read through the same `rawMessages` the v2 host uses, and the assertions read
 * the rows back out.
 */

/** Post-conversion rows for a session whose third turn carried a synthetic part. */
const syntheticSplit: StoreRow[] = [
    { id: "msg_a_001_u1", session_id: "ses_a", seq: 0, type: "user", data: { text: "u1" } },
    {
        id: "msg_a_002_a1",
        session_id: "ses_a",
        seq: 1,
        type: "assistant",
        data: { content: [{ type: "text", text: "a1" }] },
    },
    { id: "msg_a_003_u2", session_id: "ses_a", seq: 2, type: "user", data: { text: "u2" } },
    {
        // Host-derived id: first 16 characters of the source id plus a base62
        // digest of "v1-synthetic:<source id>".
        id: "msg_a_003_u2yFU0Vz0z1d7sEV",
        session_id: "ses_a",
        seq: 3,
        type: "synthetic",
        data: { text: "<system-reminder>synthetic environment note</system-reminder>" },
    },
    {
        id: "msg_a_004_a2",
        session_id: "ses_a",
        seq: 4,
        type: "assistant",
        data: { content: [{ type: "text", text: "a2" }] },
    },
    { id: "msg_a_005_u3", session_id: "ses_a", seq: 5, type: "user", data: { text: "u3" } },
    {
        id: "msg_a_006_a3",
        session_id: "ses_a",
        seq: 6,
        type: "assistant",
        data: { content: [{ type: "text", text: "a3" }] },
    },
];

/** Post-conversion rows for a session whose compaction pair became one record. */
const compactionPair: StoreRow[] = [
    { id: "msg_b_001_u1", session_id: "ses_b", seq: 0, type: "user", data: { text: "u1" } },
    {
        id: "msg_b_002_a1",
        session_id: "ses_b",
        seq: 1,
        type: "assistant",
        data: { content: [{ type: "text", text: "a1" }] },
    },
    {
        id: "msg_b_003_cu",
        session_id: "ses_b",
        seq: 2,
        type: "compaction",
        data: { status: "completed", summary: "earlier turns condensed" },
    },
    { id: "msg_b_005_u2", session_id: "ses_b", seq: 3, type: "user", data: { text: "u2" } },
    {
        id: "msg_b_006_a2",
        session_id: "ses_b",
        seq: 4,
        type: "assistant",
        data: { content: [{ type: "text", text: "a2" }] },
    },
    { id: "msg_b_007_u3", session_id: "ses_b", seq: 5, type: "user", data: { text: "u3" } },
];

/** Post-conversion rows for the session whose two user text parts were joined. */
const multipartUser: StoreRow[] = [
    {
        id: "msg_c_001_u1",
        session_id: "ses_c",
        seq: 0,
        type: "user",
        data: { text: "fragment one: alpha\n\nfragment two: beta" },
    },
    {
        id: "msg_c_002_a1",
        session_id: "ses_c",
        seq: 1,
        type: "assistant",
        data: { content: [{ type: "text", text: "a1" }] },
    },
];

/**
 * What MC's 1.x reader produced for the same three sessions before the host
 * converted them — the ordinals every saved coordinate below was derived from.
 */
function v1Projection(sessionId: string): RawMessage[] {
    const text = (id: string, role: string, parts: number): RawMessage => ({
        id,
        role,
        ordinal: 0,
        parts: Array.from({ length: parts }, (_, index) => ({
            type: "text",
            text: `${id}#${index}`,
        })),
    });
    const rows: Record<string, RawMessage[]> = {
        ses_a: [
            text("msg_a_001_u1", "user", 1),
            text("msg_a_002_a1", "assistant", 1),
            // The 1.x turn carried ordinary text AND a synthetic part; the host
            // later split the synthetic one into its own row.
            text("msg_a_003_u2", "user", 2),
            text("msg_a_004_a2", "assistant", 1),
            text("msg_a_005_u3", "user", 1),
            text("msg_a_006_a3", "assistant", 1),
        ],
        ses_b: [
            text("msg_b_001_u1", "user", 1),
            text("msg_b_002_a1", "assistant", 1),
            text("msg_b_003_cu", "user", 1),
            text("msg_b_005_u2", "user", 1),
            text("msg_b_006_a2", "assistant", 1),
            text("msg_b_007_u3", "user", 1),
        ],
        ses_c: [text("msg_c_001_u1", "user", 2), text("msg_c_002_a1", "assistant", 1)],
    };
    return (rows[sessionId] ?? []).map((message, index) => ({ ...message, ordinal: index + 1 }));
}

function v2Projection(rows: StoreRow[]): RawMessage[] {
    return rawMessages(rows);
}

let db: Database;

beforeEach(() => {
    clearCtxReduceAvailability("ses_a");
    clearInjectionCache("ses_a");
    db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
});

function insertCompartment(
    sessionId: string,
    args: {
        sequence: number;
        start: number;
        end: number;
        startMessageId: string;
        endMessageId: string;
        harness?: string;
    },
): void {
    db.prepare(
        `INSERT INTO compartments
            (session_id, sequence, start_message, end_message, start_message_id, end_message_id,
             title, content, importance, legacy, created_at, harness)
         VALUES (?, ?, ?, ?, ?, ?, 'compartment', 'summary text', 50, 0, 1000, ?)`,
    ).run(
        sessionId,
        args.sequence,
        args.start,
        args.end,
        args.startMessageId,
        args.endMessageId,
        args.harness ?? "opencode",
    );
}

function ensureSession(sessionId: string, harness = "opencode"): void {
    db.prepare("INSERT OR IGNORE INTO session_meta (session_id, harness) VALUES (?, ?)").run(
        sessionId,
        harness,
    );
}

test("issue 774: a delta-four rebase shifts summary labels with the coordinates", () => {
    ensureSession("ses_labels");
    insertCompartment("ses_labels", {
        sequence: 1,
        start: 1,
        end: 3,
        startMessageId: id(5),
        endMessageId: id(7),
    });
    const text =
        "[1] U: review; [2-3] A: done. Keep 128.68 s, [01], [0], [-1], [1.2], [1 - 2], [3-2], [[1]], item[1], [1](url), [1][ref], [1-1].";
    db.prepare(
        "UPDATE compartments SET title = ?, content = ?, p1 = ?, p2 = ?, p3 = ?, p4 = ? WHERE session_id = ?",
    ).run("Work [1-3]", text, text, "[2]", "[3]", null, "ses_labels");
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_labels",
    );
    db.exec(`INSERT INTO recomp_compartments
        (session_id, sequence, start_message, end_message, start_message_id, end_message_id,
         title, content, p1, p2, p3, p4, pass_number, created_at)
        SELECT session_id, sequence, start_message, end_message, start_message_id, end_message_id,
               title, content, p1, p2, p3, p4, 1, 1000 FROM compartments WHERE session_id = 'ses_labels'`);
    const outcome = runRebase("ses_labels", "v2", numberedProjection(10));
    expect(outcome.status).toBe("rebased");
    const moved = compartmentOf("ses_labels", 1);
    expect([moved.startMessage, moved.endMessage]).toEqual([5, 7]);
    const expected =
        "[5] U: review; [6-7] A: done. Keep 128.68 s, [01], [0], [-1], [1.2], [1 - 2], [3-2], [[1]], item[1], [1](url), [1][ref], [1-1].";
    expect(moved).toMatchObject({
        title: "Work [5-7]",
        content: expected,
        p1: expected,
        p2: "[6]",
        p3: "[7]",
        p4: null,
    });
    expect(
        db
            .prepare(
                "SELECT start_message, end_message, content, p1, p2, p3, p4 FROM recomp_compartments WHERE session_id = ?",
            )
            .get("ses_labels"),
    ).toEqual({
        start_message: 5,
        end_message: 7,
        content: expected,
        p1: expected,
        p2: "[6]",
        p3: "[7]",
        p4: null,
    });
    runRebase("ses_labels", "v2", numberedProjection(10));
    expect(compartmentOf("ses_labels", 1).content).toBe(expected);
    runRebase(
        "ses_labels",
        "v1",
        numberedProjection(10)
            .map((message) => ({ ...message, ordinal: message.ordinal - 4 }))
            .filter((message) => message.ordinal > 0),
    );
    expect(compartmentOf("ses_labels", 1)).toMatchObject({
        startMessage: 1,
        endMessage: 3,
        content: text,
    });
});

test("issue 774: non-uniform rebases map endpoint labels by identity without guessing interior labels", () => {
    ensureSession("ses_nonuniform");
    insertCompartment("ses_nonuniform", {
        sequence: 1,
        start: 1,
        end: 4,
        startMessageId: id(1),
        endMessageId: id(5),
    });
    db.prepare("UPDATE compartments SET content = '[1] [2] [4] [1-4]' WHERE session_id = ?").run(
        "ses_nonuniform",
    );
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_nonuniform",
    );
    runRebase("ses_nonuniform", "v2", numberedProjection(10));
    expect(compartmentOf("ses_nonuniform", 1).content).toBe("[1] [2] [5] [1-5]");
});

test("issue 774: rebasing leaves summary text without labels or hashes unchanged", () => {
    ensureSession("ses_plain");
    insertCompartment("ses_plain", {
        sequence: 1,
        start: 1,
        end: 3,
        startMessageId: id(5),
        endMessageId: id(7),
    });
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_plain",
    );
    runRebase("ses_plain", "v2", numberedProjection(10));
    expect(compartmentOf("ses_plain", 1).content).toBe("summary text");
});

/** A persisted replay slot whose prefix embeds the session's current ranges. */
function seedLkgSlot(sessionId: string): void {
    expect(
        saveLkgSlotToDb(db, sessionId, {
            jsonPrefix: "[]",
            inputIdSeq: [],
            inputContentDigests: [],
            lastInputMessageId: "msg_a_006_a3",
            modelKey: null,
            providerKey: null,
            capturedAt: 1,
        }),
    ).toBe(true);
}

function runRebase(sessionId: string, generation: CoordinateGeneration, messages: RawMessage[]) {
    return rebaseSessionCoordinates({
        db,
        sessionId,
        generation,
        readMessages: () => messages,
    });
}

/** Ordinals a saved `[start..end]` range selects in the given projection. */
function selectRange(messages: RawMessage[], start: number, end: number): string[] {
    return messages
        .filter((message) => message.ordinal >= start && message.ordinal <= end)
        .map((message) => message.id);
}

function compartmentOf(sessionId: string, sequence: number) {
    const compartment = getCompartments(db, sessionId).find((row) => row.sequence === sequence);
    if (!compartment) throw new Error(`no compartment ${sequence} for ${sessionId}`);
    return compartment;
}

/** Content hash of every session-scoped row this rebase could touch. */
function sessionDigest(sessionId: string): string {
    const tables = [
        "compartments",
        "recomp_compartments",
        "tags",
        "pending_ops",
        "notes",
        "compression_depth",
        "compartment_chunk_embeddings",
        "message_history_source",
        "message_history_index",
        "message_fts_rowid_map",
        "lkg_slots",
        "session_meta",
    ];
    const snapshot = tables.map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} WHERE session_id = ?`).all(sessionId),
    ]);
    return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

test("a synthetic split between adjacent compartments is absorbed into the earlier range", () => {
    ensureSession("ses_a");
    insertCompartment("ses_a", {
        sequence: 1,
        start: 1,
        end: 3,
        startMessageId: "msg_a_001_u1",
        endMessageId: "msg_a_003_u2",
    });
    insertCompartment("ses_a", {
        sequence: 2,
        start: 4,
        end: 6,
        startMessageId: "msg_a_004_a2",
        endMessageId: "msg_a_006_a3",
    });
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_a",
    );

    const outcome = runRebase("ses_a", "v2", v2Projection(syntheticSplit));
    const compartments = getCompartments(db, "ses_a");

    expect(outcome.healedGaps).toBe(1);
    expect(outcome.narrativeGaps).toBe(0);
    expect(compartments.map((row) => [row.startMessage, row.endMessage])).toEqual([
        [1, 4],
        [5, 7],
    ]);
    expect(validateStoredCompartments(compartments)).toBeNull();
    expect(readCoordinateRebaseNotice(db, "ses_a")).toMatchObject({
        generation: "v2",
        healedGaps: 1,
        narrativeGaps: 0,
    });
});

test("v2 notice compatibility tolerates an older synthetic-only stored gap", () => {
    ensureSession("ses_a");
    insertCompartment("ses_a", {
        sequence: 1,
        start: 1,
        end: 3,
        startMessageId: "msg_a_001_u1",
        endMessageId: "msg_a_003_u2",
    });
    insertCompartment("ses_a", {
        sequence: 2,
        start: 5,
        end: 7,
        startMessageId: "msg_a_004_a2",
        endMessageId: "msg_a_006_a3",
    });
    db.prepare("UPDATE session_meta SET coordinate_rebase_notice = ? WHERE session_id = ?").run(
        JSON.stringify({ generation: "v2", previousGeneration: "v1", at: 1 }),
        "ses_a",
    );
    const messages = v2Projection(syntheticSplit);

    const error = withRawMessageProvider(
        "ses_a",
        { readMessages: () => messages, getMessageCount: () => messages.length },
        () => {
            const compartments = getCompartments(db, "ses_a");
            const safeRanges = nonNarrativeStoredGapRanges(db, "ses_a", compartments);
            expect(safeRanges).toEqual([{ start: 4, end: 4 }]);
            return validateStoredCompartments(compartments, safeRanges);
        },
    );

    expect(error).toBeNull();
});

test("a narrative row between rebased compartments remains a reported gap", () => {
    ensureSession("ses_a");
    insertCompartment("ses_a", {
        sequence: 1,
        start: 1,
        end: 3,
        startMessageId: "msg_a_001_u1",
        endMessageId: "msg_a_003_u2",
    });
    insertCompartment("ses_a", {
        sequence: 2,
        start: 4,
        end: 6,
        startMessageId: "msg_a_004_a2",
        endMessageId: "msg_a_006_a3",
    });
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_a",
    );
    const narrativeSplit = syntheticSplit.map((row) =>
        row.type === "synthetic"
            ? ({ ...row, type: "user", data: { text: "narrative bridge" } } as StoreRow)
            : row,
    );

    const outcome = runRebase("ses_a", "v2", v2Projection(narrativeSplit));
    const compartments = getCompartments(db, "ses_a");

    expect(outcome.healedGaps).toBe(0);
    expect(outcome.narrativeGaps).toBe(1);
    expect(compartments.map((row) => [row.startMessage, row.endMessage])).toEqual([
        [1, 3],
        [5, 7],
    ]);
    expect(validateStoredCompartments(compartments)).toBe("gap before message 5 (expected 4)");
    expect(readCoordinateRebaseNotice(db, "ses_a")).toMatchObject({
        generation: "v2",
        healedGaps: 0,
        narrativeGaps: 1,
    });
});

test("a saved compartment end still selects its endpoint after a synthetic split", () => {
    // Saved against the 1.x projection: end=4, endpoint msg_a_004_a2 at ordinal 4.
    ensureSession("ses_a");
    insertCompartment("ses_a", {
        sequence: 1,
        start: 1,
        end: 4,
        startMessageId: "msg_a_001_u1",
        endMessageId: "msg_a_004_a2",
    });
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_a",
    );

    const projection = v2Projection(syntheticSplit);
    const outcome = runRebase("ses_a", "v2", projection);

    expect(outcome.status).toBe("rebased");
    expect(outcome.compartmentsRebased).toBe(1);
    expect(outcome.compartmentsUnresolved).toBe(0);
    const compartment = compartmentOf("ses_a", 1);
    expect(compartment.endMessage).toBe(5);
    expect(compartment.rebaseStatus).toBe("ok");
    expect(selectRange(projection, compartment.startMessage, compartment.endMessage)).toContain(
        "msg_a_004_a2",
    );
    expect(readCoordinateGeneration(db, "ses_a")).toBe("v2");
});

test("a saved compartment end excludes messages that were outside it before conversion", () => {
    // Saved against the 1.x projection: end=5, endpoint msg_b_006_a2 at ordinal 5.
    // msg_b_007_u3 was ordinal 6 there, i.e. outside the compartment.
    ensureSession("ses_b");
    insertCompartment("ses_b", {
        sequence: 1,
        start: 1,
        end: 5,
        startMessageId: "msg_b_001_u1",
        endMessageId: "msg_b_006_a2",
    });
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_b",
    );

    const projection = v2Projection(compactionPair);
    const outcome = runRebase("ses_b", "v2", projection);

    expect(outcome.status).toBe("rebased");
    const compartment = compartmentOf("ses_b", 1);
    expect(compartment.endMessage).toBe(4);
    expect(selectRange(projection, compartment.startMessage, compartment.endMessage)).not.toContain(
        "msg_b_007_u3",
    );
    // The boundary every range-recovery clamp reads follows the rebased row.
    expect(getLastCompartmentEndMessage(db, "ses_b")).toBe(4);
});

test("a queued reduction whose target merged is discarded and reported, never widened", () => {
    ensureSession("ses_c");
    // The 1.x tagger gave each authored fragment its own tag; the user queued a
    // drop for the first fragment only.
    db.prepare(
        "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, harness) VALUES (?, ?, 'message', 'active', 43, 1, 'opencode')",
    ).run("ses_c", "msg_c_001_u1:p0");
    db.prepare(
        "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, harness) VALUES (?, ?, 'message', 'active', 49, 2, 'opencode')",
    ).run("ses_c", "msg_c_001_u1:p1");
    db.prepare(
        "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, harness) VALUES (?, ?, 'message', 'active', 12, 3, 'opencode')",
    ).run("ses_c", "msg_c_002_a1:p0");
    db.prepare(
        "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, 1, 'drop', 5, 'opencode')",
    ).run("ses_c");
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_c",
    );

    const outcome = runRebase("ses_c", "v2", v2Projection(multipartUser));

    expect(outcome.partTagsFolded).toBe(1);
    expect(outcome.queuedReductionsDiscarded).toBe(1);
    // The operation the user authorised covered one fragment. After the host
    // joined both fragments into one text part it would have removed both, so it
    // is removed rather than applied.
    expect(db.prepare("SELECT * FROM pending_ops WHERE session_id = ?").all("ses_c")).toEqual([]);
    expect(
        db
            .prepare("SELECT message_id FROM tags WHERE session_id = ? ORDER BY tag_number ASC")
            .all("ses_c"),
    ).toEqual([{ message_id: "msg_c_001_u1:p0" }, { message_id: "msg_c_002_a1:p0" }]);

    const notice = readCoordinateRebaseNotice(db, "ses_c");
    expect(notice?.discardedReductions).toBe(1);
    expect(formatCoordinateRebaseNotice(notice as NonNullable<typeof notice>)).toContain(
        "1 queued reduction was discarded because their targets merged in the host's store conversion",
    );
});

test("the search index is rebuilt, curing the duplicate the moved ordinal produced", () => {
    ensureSession("ses_a");
    insertCompartment("ses_a", {
        sequence: 1,
        start: 1,
        end: 4,
        startMessageId: "msg_a_001_u1",
        endMessageId: "msg_a_004_a2",
    });
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_a",
    );
    // Index seeded against the 1.x projection: six messages, watermark 6.
    const beforeMessages = v1Projection("ses_a");
    ensureMessagesIndexed(db, "ses_a", () => beforeMessages);
    expect(getLastIndexedOrdinal(db, "ses_a")).toBe(6);

    const projection = v2Projection(syntheticSplit);
    const outcome = runRebase("ses_a", "v2", projection);

    expect(outcome.indexRebuilt).toBe(true);
    const indexed = db
        .prepare(
            "SELECT message_id, message_ordinal FROM message_history_source WHERE session_id = ? ORDER BY message_ordinal ASC",
        )
        .all("ses_a") as Array<{ message_id: string; message_ordinal: number }>;
    expect(indexed.map((row) => row.message_id)).toEqual(projection.map((row) => row.id));
    expect(indexed.map((row) => row.message_ordinal)).toEqual(projection.map((row) => row.ordinal));
    // One document per ordinal: the pre-fix defect filed the last message at both
    // its old and its new ordinal because the duplicate check joined on the
    // ordinal the source row had already moved away from.
    expect(new Set(indexed.map((row) => row.message_ordinal)).size).toBe(indexed.length);
    expect(getLastIndexedOrdinal(db, "ses_a")).toBe(projection.length);
});

test("chunk windows, depth records and the replay slot are rebuilt rather than re-pointed", () => {
    ensureSession("ses_a");
    insertCompartment("ses_a", {
        sequence: 1,
        start: 1,
        end: 4,
        startMessageId: "msg_a_001_u1",
        endMessageId: "msg_a_004_a2",
    });
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_a",
    );
    const compartmentId = (
        db.prepare("SELECT id FROM compartments WHERE session_id = ?").get("ses_a") as {
            id: number;
        }
    ).id;
    db.prepare(
        `INSERT INTO compartment_chunk_embeddings
            (compartment_id, session_id, project_path, harness, window_index, start_ordinal,
             end_ordinal, chunk_hash, model_id, dims, vector, created_at)
         VALUES (?, ?, '/p', 'opencode', 0, 1, 4, 'hash', 'model', 2, X'0000', 1)`,
    ).run(compartmentId, "ses_a");
    db.prepare(
        "INSERT INTO compression_depth (session_id, message_ordinal, depth, harness) VALUES (?, 4, 2, 'opencode')",
    ).run("ses_a");
    seedLkgSlot("ses_a");
    ensureMessagesIndexed(db, "ses_a", () => v1Projection("ses_a"));

    const outcome = runRebase("ses_a", "v2", v2Projection(syntheticSplit));

    expect(outcome.chunkEmbeddingsDeleted).toBe(1);
    expect(outcome.compressionDepthRowsDropped).toBe(1);
    expect(outcome.lkgSlotsDropped).toBe(1);
    expect(
        db
            .prepare(
                "SELECT COUNT(*) AS count FROM compartment_chunk_embeddings WHERE session_id = ?",
            )
            .get("ses_a"),
    ).toEqual({ count: 0 });
    expect(
        db
            .prepare("SELECT COUNT(*) AS count FROM compression_depth WHERE session_id = ?")
            .get("ses_a"),
    ).toEqual({ count: 0 });
    expect(
        db.prepare("SELECT COUNT(*) AS count FROM lkg_slots WHERE session_id = ?").get("ses_a"),
    ).toEqual({ count: 0 });
    expect(
        db
            .prepare("SELECT COUNT(*) AS count FROM lkg_slot_chunks WHERE session_id = ?")
            .get("ses_a"),
    ).toEqual({ count: 0 });
    // The next pass must rebuild the prefix from the corrected rows rather than
    // replay bytes that embed the old ranges.
    expect(
        db
            .prepare(
                "SELECT (SELECT value FROM session_render_cache WHERE session_id = session_meta.session_id AND cache_key = 'cached_m0_bytes') AS m0, (SELECT value FROM session_render_cache WHERE session_id = session_meta.session_id AND cache_key = 'cached_m1_bytes') AS m1 FROM session_meta WHERE session_id = ?",
            )
            .get("ses_a"),
    ).toEqual({ m0: null, m1: null });
});

test("an endpoint the projection dropped is taken from the next compartment's start", () => {
    ensureSession("ses_b");
    // The compaction pair's user row is gone from the v2 projection entirely: the
    // host folded it into a `compaction` record that MC does not count. The next
    // compartment's start anchor still resolves, and compartments tile the
    // history, so the dropped end is the message before it.
    insertCompartment("ses_b", {
        sequence: 1,
        start: 1,
        end: 3,
        startMessageId: "msg_b_001_u1",
        endMessageId: "msg_b_003_cu",
    });
    insertCompartment("ses_b", {
        sequence: 2,
        start: 4,
        end: 5,
        startMessageId: "msg_b_005_u2",
        endMessageId: "msg_b_006_a2",
    });
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_b",
    );

    const outcome = runRebase("ses_b", "v2", v2Projection(compactionPair));

    expect(outcome.compartmentsUnresolved).toBe(0);
    expect(outcome.compartmentsRebased).toBe(2);
    expect(outcome.compartmentsDerived).toBe(1);
    const derived = compartmentOf("ses_b", 1);
    expect(derived.rebaseStatus).toBe("ok");
    expect([derived.startMessage, derived.endMessage]).toEqual([1, 2]);
    expect(derived.content).toBe("summary text");
    const live = compartmentOf("ses_b", 2);
    expect(live.rebaseStatus).toBe("ok");
    expect([live.startMessage, live.endMessage]).toEqual([3, 4]);
    expect(validateStoredCompartments(getCompartments(db, "ses_b"))).toBeNull();
    expect(getLastCompartmentEndMessage(db, "ses_b")).toBe(4);
});

test("an endpoint no neighbour determines is marked unresolved, never guessed", () => {
    ensureSession("ses_b");
    // The only compartment lost its end, and nothing follows it to say where
    // that end is now.
    insertCompartment("ses_b", {
        sequence: 1,
        start: 1,
        end: 3,
        startMessageId: "msg_b_001_u1",
        endMessageId: "msg_b_003_cu",
    });
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_b",
    );

    const outcome = runRebase("ses_b", "v2", v2Projection(compactionPair));

    expect(outcome.compartmentsUnresolved).toBe(1);
    const dead = compartmentOf("ses_b", 1);
    expect(dead.rebaseStatus).toBe("unresolved");
    // Its stored end is kept rather than snapped to whichever message sits
    // nearby, and its summary text is still readable.
    expect(dead.endMessage).toBe(3);
    expect(dead.content).toBe("summary text");
    expect(getLastCompartmentEndMessage(db, "ses_b")).toBe(-1);
});

test("an endpoint that comes back on the way home returns its compartment to ok", () => {
    ensureSession("ses_b");
    insertCompartment("ses_b", {
        sequence: 1,
        start: 1,
        end: 3,
        startMessageId: "msg_b_001_u1",
        endMessageId: "msg_b_003_cu",
    });
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_b",
    );
    runRebase("ses_b", "v2", v2Projection(compactionPair));
    expect(compartmentOf("ses_b", 1).rebaseStatus).toBe("unresolved");

    // Back on the 1.x host: the v1 tables were never dropped, so the compaction
    // user row is visible again.
    const outcome = runRebase("ses_b", "v1", v1Projection("ses_b"));

    expect(outcome.compartmentsResolvedAgain).toBe(1);
    const revived = compartmentOf("ses_b", 1);
    expect(revived.rebaseStatus).toBe("ok");
    expect(revived.endMessage).toBe(3);
    expect(readCoordinateGeneration(db, "ses_b")).toBe("v1");
});

test("the way back: a 2.x-written tail is invisible to 1.x and no ordinal is guessed", () => {
    ensureSession("ses_a");
    insertCompartment("ses_a", {
        sequence: 1,
        start: 1,
        end: 4,
        startMessageId: "msg_a_001_u1",
        endMessageId: "msg_a_004_a2",
    });
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_a",
    );
    runRebase("ses_a", "v2", v2Projection(syntheticSplit));

    // Two more turns happen on the 2.x host, and a compartment is written over
    // them. The 1.x tables never received those rows.
    const extendedRows: StoreRow[] = [
        ...syntheticSplit,
        { id: "msg_a_007_u4", session_id: "ses_a", seq: 7, type: "user", data: { text: "u4" } },
        {
            id: "msg_a_008_a4",
            session_id: "ses_a",
            seq: 8,
            type: "assistant",
            data: { content: [{ type: "text", text: "a4" }] },
        },
    ];
    const extended = v2Projection(extendedRows);
    insertCompartment("ses_a", {
        sequence: 2,
        start: 6,
        end: 9,
        startMessageId: "msg_a_005_u3",
        endMessageId: "msg_a_008_a4",
        harness: "opencode2",
    });

    const outcome = runRebase("ses_a", "v1", v1Projection("ses_a"));

    expect(outcome.compartmentsUnresolved).toBe(1);
    expect(outcome.compartmentsRebased).toBe(1);
    expect(compartmentOf("ses_a", 1).rebaseStatus).toBe("ok");
    expect(compartmentOf("ses_a", 1).endMessage).toBe(4);
    expect(compartmentOf("ses_a", 2).rebaseStatus).toBe("unresolved");
    expect(readCoordinateGeneration(db, "ses_a")).toBe("v1");

    // No compartment's saved end ordinal may point at a message other than the
    // one its saved endpoint id names.
    const ordinals = new Map(v1Projection("ses_a").map((row) => [row.ordinal, row.id]));
    for (const compartment of getCompartments(db, "ses_a")) {
        if (compartment.rebaseStatus === "unresolved") continue;
        expect(ordinals.get(compartment.endMessage)).toBe(compartment.endMessageId);
        expect(ordinals.get(compartment.startMessage)).toBe(compartment.startMessageId);
    }
    // The tail compartment was written against a projection this host cannot
    // serve, so it is inert rather than pointing at whichever message is there now.
    expect(extended.length).toBeGreaterThan(v1Projection("ses_a").length);
});

test("a rebase interrupted before its commit leaves nothing behind and converges on retry", () => {
    ensureSession("ses_a");
    insertCompartment("ses_a", {
        sequence: 1,
        start: 1,
        end: 4,
        startMessageId: "msg_a_001_u1",
        endMessageId: "msg_a_004_a2",
    });
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_a",
    );
    ensureMessagesIndexed(db, "ses_a", () => v1Projection("ses_a"));
    const before = sessionDigest("ses_a");

    const projection = v2Projection(syntheticSplit);
    // Fail the last write of the transaction — the generation stamp — after the
    // compartment rewrite and the index clear have already run inside it.
    db.exec(`
        CREATE TRIGGER rebase_crash BEFORE UPDATE OF coordinate_generation ON session_meta
        BEGIN SELECT RAISE(ABORT, 'host went away mid-rebase'); END;
    `);
    expect(() => runRebase("ses_a", "v2", projection)).toThrow();
    db.exec("DROP TRIGGER rebase_crash");

    // Nothing committed, so the session still describes itself as v1 and every
    // saved coordinate, index row and cached byte is exactly what it was.
    expect(readCoordinateGeneration(db, "ses_a")).toBe("v1");
    expect(sessionDigest("ses_a")).toBe(before);

    const retry = runRebase("ses_a", "v2", projection);
    expect(retry.status).toBe("rebased");
    expect(compartmentOf("ses_a", 1).endMessage).toBe(5);
    expect(readCoordinateGeneration(db, "ses_a")).toBe("v2");

    // And a third pass is a no-op: the recorded projection now matches.
    const settled = sessionDigest("ses_a");
    expect(runRebase("ses_a", "v2", projection).status).toBe("unchanged");
    expect(sessionDigest("ses_a")).toBe(settled);
});

test("a crash after the commit but before the reindex leaves an index later passes rebuild", () => {
    ensureSession("ses_a");
    insertCompartment("ses_a", {
        sequence: 1,
        start: 1,
        end: 4,
        startMessageId: "msg_a_001_u1",
        endMessageId: "msg_a_004_a2",
    });
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_a",
    );
    ensureMessagesIndexed(db, "ses_a", () => v1Projection("ses_a"));

    const projection = v2Projection(syntheticSplit);
    // Repopulating the index happens after the commit on purpose: it is catch-up
    // from the authoritative source, not part of the atomic state change. The
    // rebase reads the history once and writes the index from that read, so the
    // process dying right after committing is stood in for by the first index
    // write failing.
    db.exec(`CREATE TEMP TRIGGER fail_reindex BEFORE INSERT ON message_history_source
             BEGIN SELECT RAISE(ABORT, 'host store went away after the commit'); END`);
    let reads = 0;
    expect(() =>
        rebaseSessionCoordinates({
            db,
            sessionId: "ses_a",
            generation: "v2",
            readMessages: () => {
                reads += 1;
                return projection;
            },
        }),
    ).toThrow("host store went away after the commit");
    db.exec("DROP TRIGGER fail_reindex");
    expect(reads).toBe(1);

    // The rebase itself is durable, and the index is empty with a zero watermark
    // rather than holding documents filed under the old projection.
    expect(readCoordinateGeneration(db, "ses_a")).toBe("v2");
    expect(compartmentOf("ses_a", 1).endMessage).toBe(5);
    expect(getLastIndexedOrdinal(db, "ses_a")).toBe(0);
    expect(
        db
            .prepare("SELECT COUNT(*) AS count FROM message_history_source WHERE session_id = ?")
            .get("ses_a"),
    ).toEqual({ count: 0 });

    // Ordinary incremental maintenance rebuilds it against the new projection.
    ensureMessagesIndexed(db, "ses_a", () => projection);
    expect(
        db
            .prepare(
                "SELECT message_id, message_ordinal FROM message_history_source WHERE session_id = ? ORDER BY message_ordinal ASC",
            )
            .all("ses_a"),
    ).toEqual(
        projection.map((message) => ({
            message_id: message.id,
            message_ordinal: message.ordinal,
        })),
    );
});

test("a session first seen on the running projection is stamped and nothing else is written", () => {
    ensureSession("ses_fresh", "opencode2");
    const before = sessionDigest("ses_fresh");

    let reads = 0;
    const outcome = rebaseSessionCoordinates({
        db,
        sessionId: "ses_fresh",
        generation: "v2",
        readMessages: () => {
            reads += 1;
            return v2Projection(syntheticSplit);
        },
    });

    expect(outcome.status).toBe("stamped");
    // A session with no saved coordinate has nothing to compare, so the host
    // store is never read at all.
    expect(reads).toBe(0);
    expect(outcome.indexRebuilt).toBe(false);
    expect(outcome.compartmentsRebased).toBe(0);
    expect(readCoordinateGeneration(db, "ses_fresh")).toBe("v2");
    expect(
        db
            .prepare("SELECT COUNT(*) AS count FROM message_history_source WHERE session_id = ?")
            .get("ses_fresh"),
    ).toEqual({ count: 0 });
    expect(sessionDigest("ses_fresh")).not.toBe(before);
    // The stamp is the only difference.
    db.prepare("UPDATE session_meta SET coordinate_generation = NULL WHERE session_id = ?").run(
        "ses_fresh",
    );
    expect(sessionDigest("ses_fresh")).toBe(before);
});

test("a session first seen with compartments whose raw rows the host has pruned is stamped, not rebased", () => {
    // The ordinary upgrade shape: a long-lived 1.x session whose oldest raw rows
    // are gone (the host prunes them; the compartments outlive them by design)
    // meets the first generation-aware build. There is no previous projection to
    // rebase from, so nothing has moved; treating the pruned anchors as
    // unresolvable here marked most of a real store's history unresolved on a
    // plain restart, with no store conversion anywhere.
    ensureSession("ses_pruned");
    insertCompartment("ses_pruned", {
        sequence: 1,
        start: 1,
        end: 3,
        startMessageId: "msg_gone_1",
        endMessageId: "msg_gone_3",
    });
    insertCompartment("ses_pruned", {
        sequence: 2,
        start: 4,
        end: 5,
        startMessageId: "msg_b_005_u2",
        endMessageId: "msg_b_006_a2",
    });
    const before = sessionDigest("ses_pruned");

    let reads = 0;
    const outcome = rebaseSessionCoordinates({
        db,
        sessionId: "ses_pruned",
        generation: "v1",
        readMessages: () => {
            reads += 1;
            // Only the newer messages survive on the host; the compartment-1
            // anchors resolve nowhere.
            return v1Projection("ses_pruned").filter((message) => message.ordinal >= 4);
        },
    });

    expect(outcome.status).toBe("stamped");
    expect(reads).toBe(0);
    expect(outcome.compartmentsUnresolved).toBe(0);
    expect(outcome.compartmentsRebased).toBe(0);
    expect(compartmentOf("ses_pruned", 1).rebaseStatus).toBe("ok");
    expect(compartmentOf("ses_pruned", 2).rebaseStatus).toBe("ok");
    expect(readCoordinateGeneration(db, "ses_pruned")).toBe("v1");
    // The stamp is the only difference.
    db.prepare("UPDATE session_meta SET coordinate_generation = NULL WHERE session_id = ?").run(
        "ses_pruned",
    );
    expect(sessionDigest("ses_pruned")).toBe(before);
});

test("an unstamped session whose harness wrote the other projection is rebased from it", () => {
    // The upgrade shape the drill found: a 1.x store converted by OpenCode 2
    // BEFORE the first generation-aware plugin build looked at it. No stamp
    // exists, but the session's harness label says its coordinates were read
    // through the 1.x tables, and the host now serves the 2.x projection. The
    // rebase runs from the implied v1, and the endpoint the conversion moved
    // is re-derived rather than stamped in place (which is what a plain
    // first-sight stamp did on the real store: coordinate 686 served at 684).
    ensureSession("ses_converted_first", "opencode");
    insertCompartment("ses_converted_first", {
        sequence: 1,
        start: 1,
        end: 4,
        startMessageId: "msg_a_001_u1",
        endMessageId: "msg_a_004_a2",
    });

    const outcome = runRebase("ses_converted_first", "v2", v2Projection(syntheticSplit));

    expect(outcome.status).toBe("rebased");
    expect(outcome.previousGeneration).toBe("v1");
    expect(outcome.compartmentsRebased).toBe(1);
    const moved = compartmentOf("ses_converted_first", 1);
    expect(moved.rebaseStatus).toBe("ok");
    expect(moved.endMessage).toBe(5);
    expect(readCoordinateGeneration(db, "ses_converted_first")).toBe("v2");
    expect(formatRebaseLogLine(outcome, 1)).toContain("store-generation-rebase v1->v2");
});

for (const lane of [
    { generation: "v2" as const, source: "v1" as const, systemPromptRunsFirst: true },
    { generation: "v1" as const, source: "v2" as const, systemPromptRunsFirst: false },
]) {
    test(`${lane.source}->${lane.generation} rebase records the new host system hash without a second HARD`, async () => {
        const sessionId = "ses_a";
        ensureSession(sessionId);
        insertCompartment(sessionId, {
            sequence: 1,
            start: 1,
            end: lane.source === "v1" ? 4 : 5,
            startMessageId: "msg_a_001_u1",
            endMessageId: "msg_a_004_a2",
        });
        resolveCtxReduceAvailabilityFromMessages(sessionId, [
            { info: { role: "user", tools: { "*": true } } },
        ]);
        const historyRefreshSessions = new Set<string>();
        const systemPromptRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const promptHash = createSystemPromptHashHandler({
            db,
            dreamerEnabled: false,
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map(),
        });
        const model = { providerID: "provider", modelID: "model" };
        const previousSystem = ["Host one prompt. Today's date: 2026-09-21"];
        await promptHash.handler({ sessionID: sessionId, model }, { system: previousSystem });
        const h1 = getOrCreateSessionMeta(db, sessionId).systemPromptHash;
        expect(h1).not.toBe("");

        patchSessionMeta(db, sessionId, {
            coordinate_generation: lane.source,
            coordinate_rebase_notice: JSON.stringify({
                generation: lane.source,
                previousGeneration: lane.generation,
                at: 1,
            }),
            cached_m0_bytes: Buffer.from("6d30", "hex"),
            cached_m1_bytes: Buffer.from("6d31", "hex"),
            cached_m0_system_hash: h1,
        });

        const projection =
            lane.generation === "v2" ? v2Projection(syntheticSplit) : v1Projection(sessionId);
        expect(runRebase(sessionId, lane.generation, projection).status).toBe("rebased");

        const hardReasons: string[] = [];
        const foldPass = () => {
            const state = getOrCreateSessionMeta(db, sessionId);
            const result = injectM0M1({
                db,
                sessionId,
                state,
                historyBudgetTokens: 98_000,
                isCacheBustingPass: pendingMaterializationSessions.has(sessionId),
                hardSignals: {
                    systemHash: state.systemPromptHash,
                    modelKey: `${model.providerID}/${model.modelID}`,
                    cacheExpired: false,
                    lastResponseTime: 0,
                },
            });
            if (result.m0RematerializedThisPass && result.decision.reason) {
                hardReasons.push(result.decision.reason);
            }
            return result.decision.reason ?? "cache_hit";
        };
        const runNewHostSystemPrompt = async () => {
            const system = ["Host two prompt. Today's date: 2026-09-22"];
            await promptHash.handler({ sessionID: sessionId, model }, { system });
            expect(system.join("\n")).toContain("Today's date: 2026-09-22");
            expect(system.join("\n")).not.toContain("Today's date: 2026-09-21");
        };

        if (lane.systemPromptRunsFirst) await runNewHostSystemPrompt();
        expect(foldPass()).toBe("first_render");
        if (!lane.systemPromptRunsFirst) await runNewHostSystemPrompt();
        if (lane.systemPromptRunsFirst) await runNewHostSystemPrompt();
        expect(foldPass()).toBe("cache_hit");
        if (!lane.systemPromptRunsFirst) await runNewHostSystemPrompt();

        const h2 = getOrCreateSessionMeta(db, sessionId).systemPromptHash;
        expect(h2).not.toBe("");
        expect(h2).not.toBe(h1);
        expect(historyRefreshSessions.has(sessionId)).toBe(false);
        expect(systemPromptRefreshSessions.has(sessionId)).toBe(false);
        expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
        expect(hardReasons).toEqual(["first_render"]);
    });
}

test("a session whose coordinates already match the projection pays only the stamp", () => {
    ensureSession("ses_a");
    insertCompartment("ses_a", {
        sequence: 1,
        start: 1,
        end: 4,
        startMessageId: "msg_a_001_u1",
        endMessageId: "msg_a_004_a2",
    });
    ensureMessagesIndexed(db, "ses_a", () => v1Projection("ses_a"));
    // The state a spurious rebase would destroy has to be PRESENT for this to
    // mean anything: a materialized prefix, a memory block, a chunk window, a
    // replay slot and a depth record. Without them the digest would match no
    // matter what the rebase cleared.
    const compartmentId = (
        db.prepare("SELECT id FROM compartments WHERE session_id = ?").get("ses_a") as {
            id: number;
        }
    ).id;
    patchSessionMeta(db, "ses_a", {
        cached_m0_bytes: Buffer.from("6d30", "hex"),
        cached_m1_bytes: Buffer.from("6d31", "hex"),
        cached_m0_system_hash: "sys",
        cached_m0_max_compartment_seq: 1,
        memory_block_cache: "<project-memory/>",
        memory_block_count: 1,
        prior_boundary_ordinal: 4,
    });
    db.prepare(
        `INSERT INTO compartment_chunk_embeddings
            (compartment_id, session_id, project_path, harness, window_index, start_ordinal,
             end_ordinal, chunk_hash, model_id, dims, vector, created_at)
         VALUES (?, ?, '/p', 'opencode', 0, 1, 4, 'hash', 'model', 2, X'0000', 1)`,
    ).run(compartmentId, "ses_a");
    db.prepare(
        "INSERT INTO compression_depth (session_id, message_ordinal, depth, harness) VALUES (?, 4, 2, 'opencode')",
    ).run("ses_a");
    seedLkgSlot("ses_a");
    // coordinate_generation stays NULL: this is an existing session meeting the
    // rebase for the first time after the upgrade, on the same host it has
    // always run on.
    const before = sessionDigest("ses_a");

    const outcome = runRebase("ses_a", "v1", v1Projection("ses_a"));

    expect(outcome.status).toBe("stamped");
    expect(outcome.indexRebuilt).toBe(false);
    expect(readCoordinateGeneration(db, "ses_a")).toBe("v1");
    db.prepare("UPDATE session_meta SET coordinate_generation = NULL WHERE session_id = ?").run(
        "ses_a",
    );
    // Byte-for-byte the state it started in: a session that did not move must not
    // lose its index, its chunk windows, its replay slot or its cached prefix.
    expect(sessionDigest("ses_a")).toBe(before);
});

test("a Pi session is never rebased, whatever generation the caller passes", () => {
    ensureSession("ses_pi", "pi");
    db.prepare(
        `INSERT INTO compartments
            (session_id, sequence, start_message, end_message, start_message_id, end_message_id,
             title, content, importance, legacy, created_at, harness)
         VALUES (?, 1, 1, 4, 'pi-msg-1', 'pi-msg-4', 'c', 'summary', 50, 0, 1000, 'pi')`,
    ).run("ses_pi");
    const before = sessionDigest("ses_pi");

    let reads = 0;
    const outcome = rebaseSessionCoordinates({
        db,
        sessionId: "ses_pi",
        generation: "v2",
        readMessages: () => {
            reads += 1;
            return v2Projection(syntheticSplit);
        },
    });

    expect(outcome.status).toBe("unchanged");
    expect(reads).toBe(0);
    expect(readCoordinateGeneration(db, "ses_pi")).toBeNull();
    expect(sessionDigest("ses_pi")).toBe(before);
});

test("a note anchor follows its block id, and one without a block id is cleared", () => {
    ensureSession("ses_a");
    insertCompartment("ses_a", {
        sequence: 1,
        start: 1,
        end: 4,
        startMessageId: "msg_a_001_u1",
        endMessageId: "msg_a_004_a2",
    });
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_a",
    );
    db.prepare(
        `INSERT INTO notes (type, status, content, session_id, created_at, updated_at, anchor_ordinal, anchor_block_id, harness)
         VALUES ('session', 'active', 'anchored', ?, 1, 1, 4, 'msg_a_004_a2#0', 'opencode')`,
    ).run("ses_a");
    db.prepare(
        `INSERT INTO notes (type, status, content, session_id, created_at, updated_at, anchor_ordinal, anchor_block_id, harness)
         VALUES ('session', 'active', 'unanchored', ?, 1, 1, 6, NULL, 'opencode')`,
    ).run("ses_a");

    const outcome = runRebase("ses_a", "v2", v2Projection(syntheticSplit));

    expect(outcome.notesRebased).toBe(1);
    expect(outcome.notesCleared).toBe(1);
    expect(
        db
            .prepare(
                "SELECT content, anchor_ordinal FROM notes WHERE session_id = ? ORDER BY id ASC",
            )
            .all("ses_a"),
    ).toEqual([
        { content: "anchored", anchor_ordinal: 5 },
        { content: "unanchored", anchor_ordinal: null },
    ]);
});

test("each rebased session produces one operator-readable log line with its counts", () => {
    ensureSession("ses_a");
    insertCompartment("ses_a", {
        sequence: 1,
        start: 1,
        end: 4,
        startMessageId: "msg_a_001_u1",
        endMessageId: "msg_a_004_a2",
    });
    insertCompartment("ses_a", {
        sequence: 2,
        start: 5,
        end: 6,
        startMessageId: "msg_a_005_u3",
        endMessageId: "msg_a_gone",
    });
    db.prepare(
        "UPDATE session_meta SET coordinate_generation = 'v1', prior_boundary_ordinal = 4 WHERE session_id = ?",
    ).run("ses_a");
    ensureMessagesIndexed(db, "ses_a", () => v1Projection("ses_a"));

    const outcome = runRebase("ses_a", "v2", v2Projection(syntheticSplit));

    expect(outcome.indexRowsRebuilt).toBe(7);
    // rows_rewritten counts the coordinates that were re-derived: one compartment
    // plus the protected-tail floor it carried. The compartment whose endpoint is
    // gone is reported separately as unresolved, never as a rewrite.
    expect(formatRebaseLogLine(outcome, 12.4)).toBe(
        "INFO store-generation-rebase v1->v2 rows_rewritten=2 unresolved=1 derived=0 " +
            "index_rows_rebuilt=7 drops_discarded=0 healed_gaps=0 narrative_gaps=0 ms=12 " +
            "(chunk_windows_deleted=0 depth_rows_dropped=0 part_tags_folded=0 " +
            "lkg_slots_dropped=0 frozen_part_entries_dropped=0)",
    );
});

test("the protected-tail floor follows the compartment boundary it was taken from", () => {
    ensureSession("ses_a");
    insertCompartment("ses_a", {
        sequence: 1,
        start: 1,
        end: 4,
        startMessageId: "msg_a_001_u1",
        endMessageId: "msg_a_004_a2",
    });
    db.prepare(
        "UPDATE session_meta SET coordinate_generation = 'v1', prior_boundary_ordinal = 4 WHERE session_id = ?",
    ).run("ses_a");

    const outcome = runRebase("ses_a", "v2", v2Projection(syntheticSplit));

    expect(outcome.priorBoundaryRebased).toBe(true);
    expect(
        db
            .prepare(
                "SELECT prior_boundary_ordinal AS floor FROM session_meta WHERE session_id = ?",
            )
            .get("ses_a"),
    ).toEqual({ floor: 5 });
});

/**
 * A 70-message session as the running host serves it: ids `m_001`..`m_070` at
 * ordinals 1..70. Ids that are not in this list stand for messages the host's
 * store conversion removed, such as the boundary row of a completed native
 * compaction.
 */
function numberedProjection(count = 70): RawMessage[] {
    return Array.from({ length: count }, (_, index) => ({
        id: `m_${String(index + 1).padStart(3, "0")}`,
        role: index % 2 === 0 ? "user" : "assistant",
        ordinal: index + 1,
        parts: [{ type: "text", text: `message ${index + 1}` }],
    }));
}

function id(ordinal: number): string {
    return `m_${String(ordinal).padStart(3, "0")}`;
}

function ranges(sessionId: string): Array<[number, number, string]> {
    return getCompartments(db, sessionId).map((row) => [
        row.startMessage,
        row.endMessage,
        row.rebaseStatus,
    ]);
}

/**
 * The stored shape from issue 531 before the fix ran: compartment 2's start
 * anchor was a native-compaction boundary the conversion removed, its end
 * anchor resolves to 53, and compartment 3 starts at 54. The v1 ordinals are
 * one higher after message 25 because the v1 projection still counted the
 * boundary row.
 */
function insertIssue531Compartments(sessionId: string): void {
    insertCompartment(sessionId, {
        sequence: 1,
        start: 1,
        end: 25,
        startMessageId: id(1),
        endMessageId: id(25),
    });
    insertCompartment(sessionId, {
        sequence: 2,
        start: 26,
        end: 54,
        startMessageId: "m_native_compaction_boundary",
        endMessageId: id(53),
    });
    insertCompartment(sessionId, {
        sequence: 3,
        start: 55,
        end: 66,
        startMessageId: id(54),
        endMessageId: id(65),
    });
}

test("issue 531: a start anchor the conversion removed is taken from the previous compartment", () => {
    ensureSession("ses_531");
    insertIssue531Compartments("ses_531");
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_531",
    );

    const outcome = runRebase("ses_531", "v2", numberedProjection());

    expect(ranges("ses_531")).toEqual([
        [1, 25, "ok"],
        [26, 53, "ok"],
        [54, 65, "ok"],
    ]);
    expect(outcome.compartmentsUnresolved).toBe(0);
    expect(outcome.compartmentsDerived).toBe(1);
    expect(validateStoredCompartments(getCompartments(db, "ses_531"))).toBeNull();
    const notice = readCoordinateRebaseNotice(db, "ses_531");
    expect(notice).toMatchObject({
        unresolvedCompartments: 0,
        derivedCompartments: [{ sequence: 2, start: 26, end: 53 }],
        unresolvedCompartmentRanges: [],
    });
    expect(notice?.neighbourRecoveryAt).toBeGreaterThan(0);
    expect(formatCoordinateRebaseNotice(notice as NonNullable<typeof notice>)).toContain(
        "1 compartment was re-anchored from the compartments around it (messages 26-53)",
    );
});

test("a compartment that lost both anchors is placed between its resolved neighbours", () => {
    ensureSession("ses_both");
    insertCompartment("ses_both", {
        sequence: 1,
        start: 1,
        end: 25,
        startMessageId: id(1),
        endMessageId: id(25),
    });
    insertCompartment("ses_both", {
        sequence: 2,
        start: 26,
        end: 55,
        startMessageId: "m_gone_start",
        endMessageId: "m_gone_end",
    });
    insertCompartment("ses_both", {
        sequence: 3,
        start: 56,
        end: 67,
        startMessageId: id(54),
        endMessageId: id(65),
    });
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_both",
    );

    runRebase("ses_both", "v2", numberedProjection());

    expect(ranges("ses_both")).toEqual([
        [1, 25, "ok"],
        [26, 53, "ok"],
        [54, 65, "ok"],
    ]);
    expect(validateStoredCompartments(getCompartments(db, "ses_both"))).toBeNull();
});

test("two adjacent unresolved compartments stay unresolved and are clamped off their resolved neighbours", () => {
    ensureSession("ses_adjacent");
    insertCompartment("ses_adjacent", {
        sequence: 1,
        start: 1,
        end: 25,
        startMessageId: id(1),
        endMessageId: id(25),
    });
    // The boundary between these two has no anchor on either side: the first
    // lost its end and the second lost both ends.
    insertCompartment("ses_adjacent", {
        sequence: 2,
        start: 26,
        end: 40,
        startMessageId: id(26),
        endMessageId: "m_gone_a",
    });
    insertCompartment("ses_adjacent", {
        sequence: 3,
        start: 41,
        end: 58,
        startMessageId: "m_gone_b",
        endMessageId: "m_gone_c",
    });
    insertCompartment("ses_adjacent", {
        sequence: 4,
        start: 55,
        end: 66,
        startMessageId: id(54),
        endMessageId: id(65),
    });
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_adjacent",
    );

    const outcome = runRebase("ses_adjacent", "v2", numberedProjection());

    // Sequence 3's stale end (58) would overlap sequence 4, so it is clamped to
    // 53. Where the boundary between 2 and 3 lies is still unknown, so neither
    // row is marked ok.
    expect(ranges("ses_adjacent")).toEqual([
        [1, 25, "ok"],
        [26, 40, "unresolved"],
        [41, 53, "unresolved"],
        [54, 65, "ok"],
    ]);
    expect(outcome.compartmentsUnresolved).toBe(2);
    const notice = readCoordinateRebaseNotice(db, "ses_adjacent");
    expect(notice?.unresolvedCompartmentRanges).toEqual([
        { sequence: 2, start: 26, end: 40 },
        { sequence: 3, start: 41, end: 53 },
    ]);
    expect(formatCoordinateRebaseNotice(notice as NonNullable<typeof notice>)).toContain(
        "could not be re-anchored and are excluded from range recovery (messages 26-40, messages 41-53)",
    );
});

test("a trailing compartment with no end anchor keeps the stored end and stays unresolved", () => {
    ensureSession("ses_trailing");
    // Saved against v1, where the removed boundary row sat inside the first
    // compartment, so every later ordinal was one higher.
    insertCompartment("ses_trailing", {
        sequence: 1,
        start: 1,
        end: 26,
        startMessageId: id(1),
        endMessageId: id(25),
    });
    insertCompartment("ses_trailing", {
        sequence: 2,
        start: 27,
        end: 54,
        startMessageId: "m_gone_start",
        endMessageId: "m_gone_end",
    });
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        "ses_trailing",
    );

    runRebase("ses_trailing", "v2", numberedProjection());

    // The start is determined by the previous compartment, but nothing follows
    // to determine the end, so it is the end the store recorded and the row is
    // not trusted for range recovery.
    expect(ranges("ses_trailing")).toEqual([
        [1, 25, "ok"],
        [26, 54, "unresolved"],
    ]);
    expect(validateStoredCompartments(getCompartments(db, "ses_trailing"))).toBeNull();
    expect(getLastCompartmentEndMessage(db, "ses_trailing")).toBe(25);
});

/** A session stamped v2 by a build without neighbour recovery, in the issue 531 shape. */
function insertStuckStampedSession(sessionId: string): void {
    ensureSession(sessionId, "opencode2");
    insertCompartment(sessionId, {
        sequence: 1,
        start: 1,
        end: 25,
        startMessageId: id(1),
        endMessageId: id(25),
    });
    insertCompartment(sessionId, {
        sequence: 2,
        start: 26,
        end: 54,
        startMessageId: "m_native_compaction_boundary",
        endMessageId: id(53),
    });
    insertCompartment(sessionId, {
        sequence: 3,
        start: 54,
        end: 65,
        startMessageId: id(54),
        endMessageId: id(65),
    });
    db.prepare(
        "UPDATE compartments SET rebase_status = 'unresolved' WHERE session_id = ? AND sequence = 2",
    ).run(sessionId);
    db.prepare(
        `UPDATE session_meta
            SET coordinate_generation = 'v2', coordinate_rebase_notice = ?
          WHERE session_id = ?`,
    ).run(
        JSON.stringify({
            generation: "v2",
            previousGeneration: "v1",
            at: 1790317845430,
            unresolvedCompartments: 1,
            discardedReductions: 0,
            droppedDepthRows: 0,
            healedGaps: 0,
            narrativeGaps: 0,
        }),
        sessionId,
    );
}

test("a session already stamped with an overlapping unresolved row is repaired on the next pass, with no flip", () => {
    insertStuckStampedSession("ses_stuck");
    patchSessionMeta(db, "ses_stuck", {
        cached_m0_bytes: Buffer.from("6d30", "hex"),
        cached_m1_bytes: Buffer.from("6d31", "hex"),
    });
    expect(validateStoredCompartments(getCompartments(db, "ses_stuck"))).toBe(
        "overlap before message 55 (saw 54-65)",
    );

    let reads = 0;
    const outcome = rebaseSessionCoordinates({
        db,
        sessionId: "ses_stuck",
        generation: "v2",
        readMessages: () => {
            reads += 1;
            return numberedProjection();
        },
    });

    expect(outcome.status).toBe("repaired");
    expect(outcome.compartmentsDerived).toBe(1);
    expect(reads).toBe(1);
    expect(ranges("ses_stuck")).toEqual([
        [1, 25, "ok"],
        [26, 53, "ok"],
        [54, 65, "ok"],
    ]);
    expect(validateStoredCompartments(getCompartments(db, "ses_stuck"))).toBeNull();
    // The stamp is untouched and the earlier rebase's report is kept; only the
    // recovery is added to it.
    expect(readCoordinateGeneration(db, "ses_stuck")).toBe("v2");
    const notice = readCoordinateRebaseNotice(db, "ses_stuck");
    expect(notice).toMatchObject({
        generation: "v2",
        previousGeneration: "v1",
        at: 1790317845430,
        unresolvedCompartments: 0,
        derivedCompartments: [{ sequence: 2, start: 26, end: 53 }],
    });
    expect(notice?.neighbourRecoveryAt).toBeGreaterThan(0);
    // The cached render is left for a pass that is already rebuilding the prefix.
    expect(
        db
            .prepare(
                "SELECT hex((SELECT value FROM session_render_cache WHERE session_id = session_meta.session_id AND cache_key = 'cached_m0_bytes')) AS m0, hex((SELECT value FROM session_render_cache WHERE session_id = session_meta.session_id AND cache_key = 'cached_m1_bytes')) AS m1 FROM session_meta WHERE session_id = ?",
            )
            .get("ses_stuck"),
    ).toEqual({ m0: "6D30", m1: "6D31" });

    // Later passes find nothing to do and never read the host store again.
    const settled = sessionDigest("ses_stuck");
    expect(runRebase("ses_stuck", "v2", numberedProjection()).status).toBe("unchanged");
    expect(reads).toBe(1);
    expect(sessionDigest("ses_stuck")).toBe(settled);
});

test("the one-time repair is skipped once the notice records that recovery ran", () => {
    insertStuckStampedSession("ses_recorded");
    const notice = readCoordinateRebaseNotice(db, "ses_recorded");
    db.prepare("UPDATE session_meta SET coordinate_rebase_notice = ? WHERE session_id = ?").run(
        JSON.stringify({ ...notice, neighbourRecoveryAt: 5 }),
        "ses_recorded",
    );
    const before = sessionDigest("ses_recorded");

    let reads = 0;
    const outcome = rebaseSessionCoordinates({
        db,
        sessionId: "ses_recorded",
        generation: "v2",
        readMessages: () => {
            reads += 1;
            return numberedProjection();
        },
    });

    expect(outcome.status).toBe("unchanged");
    expect(reads).toBe(0);
    expect(sessionDigest("ses_recorded")).toBe(before);
});

test("a defer pass after the repair replays the cached render byte-identical", () => {
    insertStuckStampedSession("ses_531_defer");
    // A realistic render: the earlier pass materialized m0/m1 from the stuck rows.
    const renderPass = (busting: boolean) => {
        const state = getOrCreateSessionMeta(db, "ses_531_defer");
        return injectM0M1({
            db,
            sessionId: "ses_531_defer",
            state,
            historyBudgetTokens: 98_000,
            isCacheBustingPass: busting,
            hardSignals: {
                systemHash: state.systemPromptHash,
                modelKey: "provider/model",
                cacheExpired: false,
                lastResponseTime: 0,
            },
        });
    };
    const first = renderPass(true);
    expect(first.m0Bytes).not.toBeNull();
    const before = { m0: first.m0Bytes?.toString("hex"), m1: first.m1Text };

    expect(runRebase("ses_531_defer", "v2", numberedProjection()).status).toBe("repaired");

    const deferred = renderPass(false);
    expect(deferred.m0RematerializedThisPass).toBe(false);
    expect({ m0: deferred.m0Bytes?.toString("hex"), m1: deferred.m1Text }).toEqual(before);

    // The repaired rows do change the render, so the replay above is the cache
    // holding rather than two renders that happen to agree.
    clearInjectionCache("ses_531_defer");
    db.prepare(
        "DELETE FROM session_render_cache WHERE cache_key IN ('cached_m0_bytes', 'cached_m1_bytes') AND session_id = ?",
    ).run("ses_531_defer");
    const rebuilt = renderPass(true);
    expect({ m0: rebuilt.m0Bytes?.toString("hex"), m1: rebuilt.m1Text }).not.toEqual(before);
});
