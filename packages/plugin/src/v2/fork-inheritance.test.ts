/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../features/magic-context/migrations";
import { copySessionStateForClone } from "../features/magic-context/storage-clone";
import { initializeDatabase } from "../features/magic-context/storage-db";
import {
    readCoordinateRebaseNotice,
    rebaseSessionCoordinates,
} from "../features/magic-context/store-generation-rebase";
import {
    freezeTemporalDecisions,
    getTemporalDecisions,
} from "../features/magic-context/temporal-decisions";
import { validateStoredCompartments } from "../hooks/magic-context/compartment-runner-validation";
import { executeStatus } from "../hooks/magic-context/execute-status";
import { nonNarrativeStoredGapRanges } from "../hooks/magic-context/stored-compartment-gaps";
import { _resetHarnessForTesting, setHarness } from "../shared/harness";
import { Database } from "../shared/sqlite";
import { closeQuietly } from "../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../shared/test-temp-dir";
import {
    buildForkIdMap,
    forkBoundarySeq,
    seedV2ForkFromParent as seed,
    sessionHasMagicContextState,
} from "./fork-inheritance";
import { readForkHistoryGap } from "./hooks/fork-history-status";
import { readV2MessageRange } from "./hooks/store";
import { type V2RowStamp, V2StoreReader } from "./store-reader";

// Issue 608: an OpenCode 2 fork copies its parent's rows into a new session
// and re-mints every copied id as `<id from the fork event>_<seq>`. These
// tests build that store shape the way OpenCode's `projectFork` writes it and
// check what the fork inherits.

const PARENT = "ses_parent";
const FORK = "ses_fork";
const DESCENDANT = "ses_descendant";
/** OpenCode derives the copied ids from the fork event's id. */
const FORK_PREFIX = "msg_0ffb3ee0f002forkEvent00";

const cleanups: Array<() => void> = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface ParentRow {
    seq: number;
    type: string;
    /** False for a row the host does not copy (an assistant reply still streaming). */
    copied?: boolean;
}

// seq: 1 user, 2 assistant, 3 idle, 4 user, 5 assistant (still streaming at
// fork time, not copied), 6 user, 7 assistant, 8 user (the boundary,
// `through`), 9 assistant, 10 user (after the boundary).
const PARENT_ROWS: ParentRow[] = [
    { seq: 1, type: "user" },
    { seq: 2, type: "assistant" },
    { seq: 3, type: "idle" },
    { seq: 4, type: "user" },
    { seq: 5, type: "assistant", copied: false },
    { seq: 6, type: "user" },
    { seq: 7, type: "assistant" },
    { seq: 8, type: "user" },
    { seq: 9, type: "assistant" },
    { seq: 10, type: "user" },
];
const BOUNDARY_SEQ = 8;

const parentId = (seq: number) => `msg_parent_${String(seq).padStart(2, "0")}`;
const forkId = (seq: number) => `${FORK_PREFIX}_${seq}`;

function createStore(
    options: {
        boundary?: string | null;
        withParentRow?: boolean;
        copyAll?: boolean;
        changedBodyAt?: number;
        replacedCopyAt?: number;
        omitIdle?: boolean;
        partBody?: "same" | "changed";
        copyThrough?: number;
        syntheticAt?: number | number[];
        descendant?: boolean;
    } = {},
) {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-fork-inheritance-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "opencode.db");
    const db = new Database(path);
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, fork_session_id TEXT, fork_boundary TEXT, directory TEXT NOT NULL DEFAULT '');
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq);`);
    if (options.withParentRow !== false)
        db.prepare("INSERT INTO session_v2 (id) VALUES (?)").run(PARENT);
    const boundary =
        options.boundary === undefined
            ? JSON.stringify({ type: "through", messageID: parentId(BOUNDARY_SEQ) })
            : options.boundary;
    db.prepare("INSERT INTO session_v2 (id, fork_session_id, fork_boundary) VALUES (?, ?, ?)").run(
        FORK,
        PARENT,
        boundary,
    );
    db.prepare("INSERT INTO session_v2 (id) VALUES ('ses_plain')").run();
    if (options.descendant)
        db.prepare(
            "INSERT INTO session_v2 (id, fork_session_id, fork_boundary) VALUES (?,?,?)",
        ).run(
            DESCENDANT,
            FORK,
            JSON.stringify({
                type: "through",
                messageID: forkId(options.copyThrough ?? BOUNDARY_SEQ),
            }),
        );
    const insert = db.prepare(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, '{}')",
    );
    for (const row of PARENT_ROWS) {
        const type = [options.syntheticAt ?? []].flat().includes(row.seq) ? "synthetic" : row.type;
        insert.run(parentId(row.seq), PARENT, type, row.seq, row.seq * 100, row.seq * 100);
        // The host copies settled rows through the boundary with the same seq,
        // type and timestamps.
        if (
            row.seq <= (options.copyThrough ?? BOUNDARY_SEQ) &&
            (options.copyAll || row.copied !== false) &&
            !(options.omitIdle && row.type === "idle")
        ) {
            insert.run(
                options.replacedCopyAt === row.seq
                    ? "msg_fork_native_replacement"
                    : forkId(row.seq),
                FORK,
                type,
                row.seq,
                row.seq * 100,
                row.seq * 100,
            );
            if (options.descendant)
                insert.run(
                    `msg_descendant_${row.seq}`,
                    DESCENDANT,
                    type,
                    row.seq,
                    row.seq * 100,
                    row.seq * 100,
                );
        }
    }
    if (options.changedBodyAt !== undefined)
        db.prepare("UPDATE session_message SET data = ? WHERE id = ?").run(
            '{"text":"different content under the same copy stamps"}',
            forkId(options.changedBodyAt),
        );
    if (options.partBody) {
        db.exec(`CREATE TABLE session_part (message_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
            type TEXT NOT NULL, call_id TEXT, data TEXT NOT NULL, PRIMARY KEY (message_id, ordinal))`);
        const part = db.prepare("INSERT INTO session_part VALUES (?, 0, 'text', NULL, ?)");
        part.run(parentId(5), '{"type":"text","text":"parent part"}');
        part.run(
            forkId(5),
            options.partBody === "same"
                ? '{"type":"text","text":"parent part"}'
                : '{"type":"text","text":"changed part"}',
        );
    }
    // The fork's own first turn, after the boundary.
    insert.run("msg_fork_native_user", FORK, "user", 11, 5_000, 5_000);
    db.close();
    const reader = new V2StoreReader(path);
    cleanups.push(() => reader.close());
    return { path, reader };
}

function createContextDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    cleanups.push(() => closeQuietly(db));
    return db;
}

function insertCompartment(
    db: Database,
    sessionId: string,
    sequence: number,
    start: [ordinal: number, id: string],
    end: [ordinal: number, id: string],
): void {
    db.prepare(
        `INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at, harness)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'opencode2')`,
    ).run(
        sessionId,
        sequence,
        start[0],
        end[0],
        start[1],
        end[1],
        `block ${sequence}`,
        `content ${sequence}`,
    );
}

function insertTag(
    db: Database,
    sessionId: string,
    messageId: string,
    tagNumber: number,
    status: string,
    type: "message" | "tool" = "message",
    owner: string | null = null,
): void {
    db.prepare(
        "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, harness, tool_owner_message_id) VALUES (?, ?, ?, ?, 10, ?, 'opencode2', ?)",
    ).run(sessionId, messageId, type, status, tagNumber, owner);
}

/**
 * The parent's state: three history blocks (the third reaches past the
 * boundary), compacted and dropped tags, a dropped tool output, queued drops
 * on both sides of the boundary, a fact, and replay decisions.
 */
function seedParentState(db: Database): void {
    // Parent ordinals count user/assistant rows: seq1=1, 2=2, 4=3, 5=4, 6=5, 7=6, 8=7, 9=8, 10=9.
    insertCompartment(db, PARENT, 1, [1, parentId(1)], [2, parentId(2)]);
    insertCompartment(db, PARENT, 2, [3, parentId(4)], [6, parentId(7)]);
    insertCompartment(db, PARENT, 3, [7, parentId(8)], [9, parentId(10)]);
    insertTag(db, PARENT, `${parentId(1)}:p0`, 1, "compacted");
    insertTag(db, PARENT, `${parentId(2)}:p0`, 2, "compacted");
    insertTag(db, PARENT, `${parentId(4)}:p0`, 3, "dropped");
    insertTag(db, PARENT, "call_read_1", 4, "dropped", "tool", parentId(7));
    insertTag(db, PARENT, `${parentId(5)}:p0`, 5, "active");
    insertTag(db, PARENT, `${parentId(8)}:p0`, 6, "active");
    insertTag(db, PARENT, `${parentId(10)}:p0`, 7, "active");
    insertTag(db, PARENT, "call_read_2", 8, "active", "tool", parentId(9));
    const queue = db.prepare(
        "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'drop', 10, 'opencode2')",
    );
    queue.run(PARENT, 6);
    queue.run(PARENT, 8);
    db.prepare(
        "INSERT INTO session_facts (session_id, category, content, created_at, updated_at) VALUES (?, 'decision', 'keep the module boundary', 1, 1)",
    ).run(PARENT);
    db.prepare(
        `INSERT INTO session_meta (session_id, harness, counter, last_input_tokens, last_context_percentage, stripped_placeholder_ids)
         VALUES (?, 'opencode2', 8, 143180, 63.6, ?)
         ON CONFLICT(session_id) DO UPDATE SET counter = excluded.counter,
            last_input_tokens = excluded.last_input_tokens,
            last_context_percentage = excluded.last_context_percentage,
            stripped_placeholder_ids = excluded.stripped_placeholder_ids`,
    ).run(PARENT, JSON.stringify([parentId(4), parentId(10)]));
}

function forkRows<T>(db: Database, sql: string): T[] {
    return db.prepare(sql).all(FORK) as T[];
}

function seedV2ForkFromParent(args: Parameters<typeof seed>[0]): ReturnType<typeof seed> {
    const result = seed(args);
    if (result.kind === "seeded") {
        const { db, store, sessionId } = args;
        const rows = db
            .prepare(`SELECT start_message AS startMessage, end_message AS endMessage
            FROM compartments WHERE session_id = ? ORDER BY sequence`)
            .all(sessionId) as { startMessage: number; endMessage: number }[];
        expect(
            validateStoredCompartments(
                rows,
                nonNarrativeStoredGapRanges(db, sessionId, rows, (from, to) =>
                    readV2MessageRange(store, sessionId, from, to),
                ),
            ),
        ).toBeNull();
    }
    return result;
}

function convertedFork(edited = false, descendant = false) {
    const { reader } = createStore({
        copyAll: true,
        copyThrough: 9,
        syntheticAt: 4,
        descendant,
        changedBodyAt: edited ? 4 : undefined,
        boundary: JSON.stringify({ type: "through", messageID: parentId(9) }),
    });
    const db = createContextDb();
    insertCompartment(db, PARENT, 0, [1, parentId(1)], [2, parentId(2)]);
    insertCompartment(db, PARENT, 1, [4, parentId(5)], [6, parentId(7)]);
    insertCompartment(db, PARENT, 2, [7, parentId(8)], [8, parentId(9)]);
    db.prepare(
        "INSERT INTO session_meta (session_id, harness, coordinate_rebase_notice) VALUES (?, 'opencode2', ?)",
    ).run(PARENT, JSON.stringify({ generation: "v2", healedGaps: 12, neighbourRecoveryAt: 100 }));
    return { db, reader };
}

function inheritedMark(db: Database, sessionID = FORK): unknown {
    const row = db
        .prepare("SELECT coordinate_rebase_notice AS mark FROM session_meta WHERE session_id = ?")
        .get(sessionID) as { mark: string | null } | undefined;
    return row?.mark ? JSON.parse(row.mark) : null;
}

describe("buildForkIdMap", () => {
    const stamps = (session: "parent" | "fork"): V2RowStamp[] =>
        PARENT_ROWS.filter(
            (row) => session === "parent" || (row.seq <= BOUNDARY_SEQ && row.copied !== false),
        ).map((row) => ({
            id: session === "parent" ? parentId(row.seq) : forkId(row.seq),
            type: row.type as V2RowStamp["type"],
            seq: row.seq,
            time_created: row.seq * 100,
        }));

    it("pairs each copied row with the parent row of the same seq, type and creation time", () => {
        const map = buildForkIdMap(stamps("parent"), stamps("fork"), BOUNDARY_SEQ);
        expect([...map.parentToFork]).toEqual(
            [1, 2, 3, 4, 6, 7, 8].map((seq) => [parentId(seq), forkId(seq)]),
        );
    });

    it("leaves rows the host did not copy, and rows past the boundary, unpaired", () => {
        const map = buildForkIdMap(stamps("parent"), stamps("fork"), BOUNDARY_SEQ);
        expect(map.parentToFork.has(parentId(5))).toBe(false);
        expect(map.parentToFork.has(parentId(9))).toBe(false);
        expect(map.parentToFork.has(parentId(10))).toBe(false);
    });

    it("refuses a pair whose id, type or creation time does not match the copy", () => {
        const fork = stamps("fork").map((row) => {
            if (row.seq === 1) return { ...row, id: "msg_native_not_a_copy" };
            if (row.seq === 2) return { ...row, type: "user" as const };
            if (row.seq === 4) return { ...row, time_created: 1 };
            return row;
        });
        const map = buildForkIdMap(stamps("parent"), fork, BOUNDARY_SEQ);
        expect(map.parentToFork.has(parentId(1))).toBe(false);
        expect(map.parentToFork.has(parentId(2))).toBe(false);
        expect(map.parentToFork.has(parentId(4))).toBe(false);
        expect(map.parentToFork.get(parentId(6))).toBe(forkId(6));
    });

    it("numbers the fork's messages in the fork, where an uncopied row shifts later positions", () => {
        const map = buildForkIdMap(stamps("parent"), stamps("fork"), BOUNDARY_SEQ);
        // Fork user/assistant rows: seq 1, 2, 4, 6, 7, 8 (idle does not count, 5 was not copied).
        expect(map.forkOrdinals.get(forkId(1))).toBe(1);
        expect(map.forkOrdinals.get(forkId(4))).toBe(3);
        expect(map.forkOrdinals.get(forkId(6))).toBe(4);
        expect(map.forkOrdinals.get(forkId(8))).toBe(6);
        expect(map.forkOrdinals.has(forkId(3))).toBe(false);
    });
});

describe("forkBoundarySeq", () => {
    const lookup = (_session: string, id: string) => (id === parentId(8) ? 8 : undefined);

    it("includes the boundary row for a `through` fork and stops before it for a `before` fork", () => {
        const through = {
            parentSessionID: PARENT,
            boundary: { type: "through" as const, messageID: parentId(8) },
        };
        const before = {
            parentSessionID: PARENT,
            boundary: { type: "before" as const, messageID: parentId(8) },
        };
        expect(forkBoundarySeq(through, lookup)).toBe(8);
        expect(forkBoundarySeq(before, lookup)).toBe(7);
        expect(
            forkBoundarySeq(
                { ...through, boundary: { ...through.boundary, messageID: "gone" } },
                lookup,
            ),
        ).toBeUndefined();
    });
});

describe("seedV2ForkFromParent", () => {
    it.each([
        false,
        true,
    ])("crosses a parent-accepted gap only if the gap bytes match (edited=%s)", (edited) => {
        const { reader, db } = convertedFork(edited, !edited);
        expect(seedV2ForkFromParent({ db, store: reader, sessionId: FORK }).kind).toBe("seeded");
        expect(
            forkRows(
                db,
                "SELECT sequence FROM compartments WHERE session_id = ? ORDER BY sequence",
            ),
        ).toEqual((edited ? [0] : [0, 1, 2]).map((sequence) => ({ sequence })));
        const marker = { generation: "v2", inheritedGaps: [{ start: 3, end: 3 }] };
        expect(inheritedMark(db)).toEqual(edited ? null : marker);
        if (!edited) {
            expect(seedV2ForkFromParent({ db, store: reader, sessionId: DESCENDANT }).kind).toBe(
                "seeded",
            );
            expect(inheritedMark(db, DESCENDANT)).toEqual(marker);
        }
    });

    it("lets a conversion heal both gaps but limits a fork to its inherited interval", () => {
        const { reader } = createStore({ copyAll: true, syntheticAt: [4, 6] });
        const db = createContextDb();
        const rows = [
            { startMessage: 1, endMessage: 2 },
            { startMessage: 4, endMessage: 4 },
            { startMessage: 6, endMessage: 7 },
        ];
        const mark = db.prepare(
            "INSERT INTO session_meta (session_id, coordinate_rebase_notice) VALUES (?, ?)",
        );
        mark.run(PARENT, JSON.stringify({ generation: "v2" }));
        mark.run(FORK, JSON.stringify({ generation: "v2", inheritedGaps: [{ start: 3, end: 3 }] }));
        const check = (id: string) =>
            validateStoredCompartments(
                rows,
                nonNarrativeStoredGapRanges(db, id, rows, (from, to) =>
                    readV2MessageRange(reader, id, from, to),
                ),
            );
        expect(check(PARENT)).toBeNull();
        expect(check(FORK)).toBe("gap before message 6 (expected 5)");
    });

    it.each([
        false,
        true,
    ])("the inherited mark neither converts the fork nor interferes with neighbour recovery (repair=%s)", (repair) => {
        const { reader, db } = convertedFork();
        setHarness("opencode2");
        try {
            expect(seedV2ForkFromParent({ db, store: reader, sessionId: FORK }).kind).toBe(
                "seeded",
            );
        } finally {
            _resetHarnessForTesting();
        }
        const before = executeStatus(db, FORK);
        expect(before).not.toContain("Store Conversion");
        expect(before).not.toContain("Saved History Recovery");
        let projectionReads = 0;
        const rebase = () =>
            rebaseSessionCoordinates({
                db,
                sessionId: FORK,
                generation: "v2",
                readMessages: () => {
                    projectionReads++;
                    return [...readV2MessageRange(reader, FORK, 1, 8)];
                },
            });
        expect(rebase().status).toBe("stamped");
        expect(projectionReads).toBe(0);
        if (repair)
            db.prepare(`UPDATE compartments SET end_message = 7, end_message_id = 'missing-end',
                rebase_status = 'unresolved' WHERE session_id = ? AND sequence = 1`).run(FORK);
        expect(rebase().status).toBe(repair ? "repaired" : "unchanged");
        expect(projectionReads).toBe(repair ? 1 : 0);
        const mark = readCoordinateRebaseNotice(db, FORK);
        expect(mark?.inheritedGaps).toEqual([{ start: 3, end: 3 }]);
        expect(mark?.healedGaps).toBe(0);
        expect(mark?.neighbourRecoveryAt === null).toBe(!repair);
        const after = executeStatus(db, FORK);
        expect(after).not.toContain("Store Conversion");
        expect(after.includes("Saved History Recovery")).toBe(repair);
    });

    it("keeps one-sided live coverage and uses a live neighbour when available", () => {
        for (const neighbour of [false, true]) {
            const { reader } = createStore({ copyAll: true });
            const db = createContextDb();
            insertCompartment(
                db,
                PARENT,
                0,
                [1, parentId(1)],
                [2, neighbour ? parentId(2) : "gone-end"],
            );
            insertCompartment(db, PARENT, 1, [neighbour ? 4 : 3, "gone-start"], [4, parentId(7)]);
            for (const [i, seq] of [4, 6, 7, 8].entries())
                insertTag(db, PARENT, `${parentId(seq)}:p0`, i + 1, "dropped");
            expect(seedV2ForkFromParent({ db, store: reader, sessionId: FORK }).kind).toBe(
                "seeded",
            );
            expect(
                forkRows(
                    db,
                    "SELECT message_id FROM tags WHERE session_id = ? AND status = 'dropped'",
                ),
            ).toEqual([{ message_id: `${forkId(8)}:p0` }]);
        }
    });

    it("stops the diagnosis at the first narrative row and caches until the summaries change", () => {
        const { path } = createStore({ copyAll: true });
        const db = createContextDb();
        insertCompartment(db, FORK, 0, [1, forkId(1)], [2, forkId(2)]);
        insertCompartment(db, FORK, 1, [7, forkId(8)], [7, forkId(8)]);
        let opens = 0;
        let rows = 0;
        const opened = () => {
            opens++;
            const reader = new V2StoreReader(path);
            const iterate = reader.iterateRawMessageRange.bind(reader);
            reader.iterateRawMessageRange = function* (...args) {
                for (const row of iterate(...args)) {
                    rows++;
                    yield row;
                }
            };
            return reader;
        };
        expect(readForkHistoryGap(db, opened, FORK)).toBe(true);
        expect(rows).toBe(1);
        expect(readForkHistoryGap(db, opened, FORK)).toBe(true);
        expect(opens).toBe(1);
        db.prepare("DELETE FROM compartments WHERE session_id = ?").run(FORK);
        insertCompartment(db, FORK, 0, [1, forkId(1)], [7, forkId(8)]);
        expect(readForkHistoryGap(db, opened, FORK)).toBe(false);
        expect(opens).toBe(1);
    });

    it("restores removals covered by live IDs beyond a rejected stored range", () => {
        const { reader } = createStore({ copyAll: true });
        const db = createContextDb();
        insertCompartment(db, PARENT, 0, [1, parentId(1)], [2, parentId(2)]);
        insertCompartment(db, PARENT, 1, [3, parentId(4)], [4, parentId(6)]);
        insertTag(db, PARENT, `${parentId(6)}:p0`, 1, "dropped");
        insertTag(db, PARENT, `${parentId(7)}:p0`, 2, "dropped");
        expect(seedV2ForkFromParent({ db, store: reader, sessionId: FORK }).kind).toBe("seeded");
        expect(
            forkRows(db, "SELECT message_id FROM tags WHERE session_id = ? AND status = 'dropped'"),
        ).toEqual([{ message_id: `${forkId(7)}:p0` }]);
    });

    it("does not restart inheritance after an inverted range even if the next range fits", () => {
        const { reader } = createStore({ copyAll: true });
        const db = createContextDb();
        insertCompartment(db, PARENT, 0, [1, parentId(1)], [2, parentId(2)]);
        insertCompartment(db, PARENT, 1, [3, parentId(4)], [2, parentId(2)]);
        insertCompartment(db, PARENT, 2, [3, parentId(4)], [5, parentId(6)]);
        expect(seedV2ForkFromParent({ db, store: reader, sessionId: FORK }).kind).toBe("seeded");
        expect(
            forkRows(
                db,
                "SELECT sequence FROM compartments WHERE session_id = ? ORDER BY sequence",
            ),
        ).toEqual([{ sequence: 0 }]);
    });

    it("excludes call-keyed replay when its owner was covered by a rejected summary", () => {
        const { reader } = createStore({ copyAll: true });
        const db = createContextDb();
        insertCompartment(db, PARENT, 0, [1, parentId(1)], [2, parentId(2)]);
        insertCompartment(db, PARENT, 1, [3, parentId(4)], [8, parentId(9)]);
        insertTag(db, PARENT, "call_covered", 1, "active", "tool", parentId(5));
        insertTag(db, PARENT, "call_safe", 2, "active", "tool", parentId(2));
        db.prepare(
            "UPDATE session_meta SET processed_image_stripped_ids = ? WHERE session_id = ?",
        ).run(JSON.stringify(["call_covered", "call_safe"]), PARENT);
        expect(seedV2ForkFromParent({ db, store: reader, sessionId: FORK }).kind).toBe("seeded");
        expect(
            forkRows(
                db,
                "SELECT processed_image_stripped_ids FROM session_meta WHERE session_id = ?",
            ),
        ).toEqual([{ processed_image_stripped_ids: JSON.stringify(["call_safe"]) }]);
    });

    it.each([
        ["missing next anchor", {}, "old-next-start"],
        ["next anchor body differs", { changedBodyAt: 7 }, parentId(7)],
    ] as const)("does not prove a stale end when the %s", (_name, options, nextStart) => {
        const { reader } = createStore({ copyAll: true, ...options });
        const db = createContextDb();
        insertCompartment(db, PARENT, 0, [1, parentId(1)], [2, parentId(2)]);
        insertCompartment(db, PARENT, 1, [3, parentId(4)], [5, "old-end"]);
        insertCompartment(db, PARENT, 2, [6, nextStart], [7, parentId(8)]);
        expect(seedV2ForkFromParent({ db, store: reader, sessionId: FORK }).kind).toBe("seeded");
        expect(
            forkRows(
                db,
                "SELECT sequence FROM compartments WHERE session_id = ? ORDER BY sequence",
            ),
        ).toEqual([{ sequence: 0 }]);
    });

    it("rejects an unresolved rebase even though its current rows and anchors match", () => {
        const { reader } = createStore({ copyAll: true });
        const db = createContextDb();
        insertCompartment(db, PARENT, 0, [1, parentId(1)], [2, parentId(2)]);
        insertCompartment(db, PARENT, 1, [3, parentId(4)], [5, parentId(6)]);
        db.prepare(
            "UPDATE compartments SET rebase_status = 'unresolved' WHERE session_id = ? AND sequence = 1",
        ).run(PARENT);
        expect(seedV2ForkFromParent({ db, store: reader, sessionId: FORK }).kind).toBe("seeded");
        expect(
            forkRows(
                db,
                "SELECT sequence FROM compartments WHERE session_id = ? ORDER BY sequence",
            ),
        ).toEqual([{ sequence: 0 }]);
    });

    const inherited = (db: Database) =>
        forkRows(
            db,
            "SELECT sequence, start_message_id AS start, end_message_id AS end FROM compartments WHERE session_id = ? ORDER BY sequence",
        );

    it("inherits a stale start and a stale end when the raw order and the live neighbors prove both ranges", () => {
        const { reader } = createStore({ copyAll: true });
        const db = createContextDb();
        insertCompartment(db, PARENT, 0, [1, parentId(1)], [2, parentId(2)]);
        insertCompartment(db, PARENT, 1, [3, "old-start"], [4, parentId(5)]);
        insertCompartment(db, PARENT, 2, [5, parentId(6)], [5, "old-end"]);
        insertCompartment(db, PARENT, 3, [6, parentId(7)], [7, parentId(8)]);
        expect(seedV2ForkFromParent({ db, store: reader, sessionId: FORK }).kind).toBe("seeded");
        expect(inherited(db)).toEqual([
            { sequence: 0, start: forkId(1), end: forkId(2) },
            { sequence: 1, start: forkId(4), end: forkId(5) },
            { sequence: 2, start: forkId(6), end: forkId(6) },
            { sequence: 3, start: forkId(7), end: forkId(8) },
        ]);
    });

    it.each([
        ["a changed interior body", { copyAll: true, changedBodyAt: 5 }],
        [
            "an uncopied interior row with unchanged endpoint ordinals",
            { copyAll: true, replacedCopyAt: 5 },
        ],
    ] as const)("rejects a range with two live endpoints and %s", (_name, options) => {
        const { reader } = createStore(options);
        const db = createContextDb();
        insertCompartment(db, PARENT, 0, [1, parentId(1)], [2, parentId(2)]);
        insertCompartment(db, PARENT, 1, [3, parentId(4)], [5, parentId(6)]);
        insertCompartment(db, PARENT, 2, [6, parentId(7)], [7, parentId(8)]);
        expect(seedV2ForkFromParent({ db, store: reader, sessionId: FORK }).kind).toBe("seeded");
        expect(inherited(db)).toEqual([{ sequence: 0, start: forkId(1), end: forkId(2) }]);
    });

    it.each([
        "same",
        "changed",
    ] as const)("copies a block boundary only when its stored part body is %s", (partBody) => {
        const { reader } = createStore({ copyAll: true, partBody });
        const db = createContextDb();
        insertCompartment(db, PARENT, 0, [1, parentId(1)], [2, parentId(2)]);
        insertCompartment(db, PARENT, 1, [3, parentId(4)], [4, parentId(5)]);
        db.prepare(
            "UPDATE compartments SET end_block_index = 0 WHERE session_id = ? AND sequence = 1",
        ).run(PARENT);
        insertTag(db, PARENT, `${parentId(5)}:p0`, 1, "dropped");
        expect(seedV2ForkFromParent({ db, store: reader, sessionId: FORK }).kind).toBe("seeded");
        expect(
            forkRows(
                db,
                "SELECT sequence, end_block_index FROM compartments WHERE session_id = ? ORDER BY sequence",
            ),
        ).toEqual([
            { sequence: 0, end_block_index: null },
            ...(partBody === "same" ? [{ sequence: 1, end_block_index: 0 }] : []),
        ]);
        const dropped = forkRows(
            db,
            "SELECT message_id FROM tags WHERE session_id = ? AND status = 'dropped'",
        );
        expect(dropped).toEqual(partBody === "same" ? [{ message_id: `${forkId(5)}:p0` }] : []);
    });

    it.each([
        ["gap", [4, parentId(5)], [5, parentId(6)]],
        ["overlap", [2, parentId(2)], [5, parentId(6)]],
    ] as const)("stops at a %s even though every summary anchor maps", (_name, start, end) => {
        const { reader } = createStore({ copyAll: true });
        const db = createContextDb();
        insertCompartment(db, PARENT, 0, [1, parentId(1)], [2, parentId(2)]);
        insertCompartment(db, PARENT, 2, [...start], [...end]);
        insertCompartment(db, PARENT, 4, [6, parentId(7)], [7, parentId(8)]);
        expect(seedV2ForkFromParent({ db, store: reader, sessionId: FORK }).kind).toBe("seeded");
        expect(inherited(db)).toEqual([{ sequence: 0, start: forkId(1), end: forkId(2) }]);
    });

    it("does not carry committed, pending, or placeholder removals inside a straddling range", () => {
        const { reader } = createStore({ copyAll: true });
        const db = createContextDb();
        insertCompartment(db, PARENT, 0, [1, parentId(1)], [2, parentId(2)]);
        insertCompartment(db, PARENT, 1, [3, parentId(4)], [8, parentId(9)]);
        insertTag(db, PARENT, `${parentId(1)}:p0`, 1, "dropped");
        insertTag(db, PARENT, `${parentId(5)}:p0`, 2, "dropped");
        insertTag(db, PARENT, `${parentId(6)}:p0`, 3, "active");
        db.prepare(
            "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, 3, 'drop', 1, 'opencode2')",
        ).run(PARENT);
        db.prepare("UPDATE session_meta SET stripped_placeholder_ids = ? WHERE session_id = ?").run(
            JSON.stringify([parentId(1), parentId(6)]),
            PARENT,
        );

        expect(seedV2ForkFromParent({ db, store: reader, sessionId: FORK }).kind).toBe("seeded");
        expect(inherited(db)).toEqual([{ sequence: 0, start: forkId(1), end: forkId(2) }]);
        expect(
            forkRows(
                db,
                "SELECT message_id, status FROM tags WHERE session_id = ? AND status = 'dropped'",
            ),
        ).toEqual([{ message_id: `${forkId(1)}:p0`, status: "dropped" }]);
        expect(forkRows(db, "SELECT tag_id FROM pending_ops WHERE session_id = ?")).toEqual([]);
        const [meta] = forkRows<{ stripped_placeholder_ids: string }>(
            db,
            "SELECT stripped_placeholder_ids FROM session_meta WHERE session_id = ?",
        );
        expect(JSON.parse(meta?.stripped_placeholder_ids ?? "[]")).toEqual([forkId(1)]);
    });

    it.each([
        [
            "a counted row was replaced",
            { copyAll: true, replacedCopyAt: 5 },
            "old-start",
            parentId(6),
        ],
        ["a copied body differs", { copyAll: true, changedBodyAt: 5 }, "old-start", parentId(6)],
        ["a live endpoint conflicts", { copyAll: true }, "old-start", parentId(5)],
        [
            "a live non-counted endpoint was not copied",
            { copyAll: true, omitIdle: true },
            parentId(3),
            parentId(6),
        ],
    ] as const)("keeps the raw tail when %s", (_case, options, start, end) => {
        const { reader } = createStore(options);
        const db = createContextDb();
        insertCompartment(db, PARENT, 0, [1, parentId(1)], [2, parentId(2)]);
        insertCompartment(db, PARENT, 1, [3, start], [5, end]);
        insertCompartment(db, PARENT, 2, [6, parentId(7)], [7, parentId(8)]);
        insertTag(db, PARENT, `${parentId(4)}:p0`, 1, "dropped");
        insertTag(db, PARENT, `${parentId(7)}:p0`, 2, "active");
        db.prepare(
            "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, 2, 'drop', 1, 'opencode2')",
        ).run(PARENT);
        expect(seedV2ForkFromParent({ db, store: reader, sessionId: FORK }).kind).toBe("seeded");
        expect(inherited(db)).toEqual([{ sequence: 0, start: forkId(1), end: forkId(2) }]);
        expect(forkRows(db, "SELECT message_id FROM tags WHERE session_id = ?")).toEqual([]);
        expect(forkRows(db, "SELECT tag_id FROM pending_ops WHERE session_id = ?")).toEqual([]);
    });

    it("proves a stale start through the named boundary, not before that same row", () => {
        const byBoundary = (type: "before" | "through") => {
            // The same row really exists in both stores; only the fork's boundary changes.
            const { reader } = createStore({
                copyAll: true,
                boundary: JSON.stringify({ type, messageID: parentId(8) }),
            });
            const db = createContextDb();
            insertCompartment(db, PARENT, 0, [1, parentId(1)], [5, parentId(6)]);
            insertCompartment(db, PARENT, 1, [6, "old-start"], [7, parentId(8)]);
            expect(seedV2ForkFromParent({ db, store: reader, sessionId: FORK }).kind).toBe(
                "seeded",
            );
            return inherited(db);
        };
        const first = { sequence: 0, start: forkId(1), end: forkId(6) };
        expect(byBoundary("through")).toEqual([
            first,
            { sequence: 1, start: forkId(7), end: forkId(8) },
        ]);
        expect(byBoundary("before")).toEqual([first]);
    });

    it("forks indexed temporal choices by mapped identity, retaining pending and empty rows", () => {
        const { reader } = createStore();
        const db = createContextDb();
        seedParentState(db);
        freezeTemporalDecisions(
            db,
            PARENT,
            new Map([
                [parentId(6), "<!-- +5m -->\n"],
                [parentId(8), ""],
                [parentId(10), "<!-- +1h -->\n"],
            ]),
        );
        db.prepare(
            "INSERT INTO temporal_decisions(session_id,message_id,marker) VALUES (?,?,NULL)",
        ).run(PARENT, parentId(4));
        expect(seedV2ForkFromParent({ db, store: reader, sessionId: FORK }).kind).toBe("seeded");
        expect(getTemporalDecisions(db, FORK)).toEqual(
            new Map([
                [forkId(6), "<!-- +5m -->\n"],
                [forkId(8), ""],
            ]),
        );
        expect(
            db
                .prepare(
                    "SELECT marker FROM temporal_decisions WHERE session_id=? AND message_id=?",
                )
                .get(FORK, forkId(4)),
        ).toEqual({ marker: null });
        expect(getTemporalDecisions(db, PARENT).has(parentId(10))).toBe(true);
    });
    it("copies a complete history prefix and only the safe replay at the fork boundary", () => {
        const { reader } = createStore({ copyAll: true });
        const db = createContextDb();
        seedParentState(db);

        const outcome = seedV2ForkFromParent({ db, store: reader, sessionId: FORK });

        expect(outcome.kind).toBe("seeded");
        // Blocks 1 and 2 lie wholly within the boundary; block 3 ends past it.
        expect(
            forkRows(
                db,
                "SELECT sequence, start_message, end_message, start_message_id, end_message_id FROM compartments WHERE session_id = ? ORDER BY sequence",
            ),
        ).toEqual([
            {
                sequence: 1,
                start_message: 1,
                end_message: 2,
                start_message_id: forkId(1),
                end_message_id: forkId(2),
            },
            {
                sequence: 2,
                start_message: 3,
                end_message: 6,
                start_message_id: forkId(4),
                end_message_id: forkId(7),
            },
        ]);
        // Tags of copied messages keep their tag numbers and statuses; the
        // tool tag keeps its call id and its owner maps to the fork's copy.
        expect(
            forkRows(
                db,
                "SELECT tag_number, message_id, status, tool_owner_message_id FROM tags WHERE session_id = ? ORDER BY tag_number",
            ),
        ).toEqual([
            {
                tag_number: 1,
                message_id: `${forkId(1)}:p0`,
                status: "compacted",
                tool_owner_message_id: null,
            },
            {
                tag_number: 2,
                message_id: `${forkId(2)}:p0`,
                status: "compacted",
                tool_owner_message_id: null,
            },
            {
                tag_number: 3,
                message_id: `${forkId(4)}:p0`,
                status: "dropped",
                tool_owner_message_id: null,
            },
            {
                tag_number: 4,
                message_id: "call_read_1",
                status: "dropped",
                tool_owner_message_id: forkId(7),
            },
            {
                tag_number: 5,
                message_id: `${forkId(5)}:p0`,
                status: "active",
                tool_owner_message_id: null,
            },
        ]);
        // The copied half of the rejected block stays raw, including its pending drop.
        expect(forkRows(db, "SELECT tag_id FROM pending_ops WHERE session_id = ?")).toEqual([]);
        expect(forkRows(db, "SELECT content FROM session_facts WHERE session_id = ?")).toEqual([
            { content: "keep the module boundary" },
        ]);
        // Replay decisions follow the copy; usage counters start fresh.
        const meta = forkRows<{
            counter: number;
            last_input_tokens: number;
            last_context_percentage: number;
            stripped_placeholder_ids: string;
        }>(
            db,
            "SELECT counter, last_input_tokens, last_context_percentage, stripped_placeholder_ids FROM session_meta WHERE session_id = ?",
        )[0];
        expect(meta?.counter).toBe(5);
        expect(meta?.last_input_tokens).toBe(0);
        expect(meta?.last_context_percentage).toBe(0);
        expect(JSON.parse(meta?.stripped_placeholder_ids ?? "[]")).toEqual([forkId(4)]);
        // The parent is untouched.
        expect(
            (
                db
                    .prepare("SELECT COUNT(*) AS count FROM tags WHERE session_id = ?")
                    .get(PARENT) as { count: number }
            ).count,
        ).toBe(8);
    });

    it("stops before the boundary row for a fork cut before a message", () => {
        const { reader } = createStore({
            boundary: JSON.stringify({ type: "before", messageID: parentId(8) }),
        });
        const db = createContextDb();
        seedParentState(db);
        expect(seedV2ForkFromParent({ db, store: reader, sessionId: FORK }).kind).toBe("seeded");
        const numbers = forkRows<{ tag_number: number }>(
            db,
            "SELECT tag_number FROM tags WHERE session_id = ? ORDER BY tag_number",
        ).map((row) => row.tag_number);
        expect(numbers).toEqual([1, 2]);
        expect(forkRows(db, "SELECT tag_id FROM pending_ops WHERE session_id = ?")).toEqual([]);
    });

    it("copies once: a second pass, or a second host on the same store, does not copy again", () => {
        const { reader, path } = createStore();
        const dir = createTestTempDirFromPath(join(tmpdir(), "mc-fork-inheritance-context-"));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const contextPath = join(dir, "context.db");
        const first = new Database(contextPath);
        initializeDatabase(first);
        runMigrations(first);
        cleanups.push(() => closeQuietly(first));
        seedParentState(first);
        const second = new Database(contextPath);
        cleanups.push(() => closeQuietly(second));
        const secondReader = new V2StoreReader(path);
        cleanups.push(() => secondReader.close());

        expect(seedV2ForkFromParent({ db: first, store: reader, sessionId: FORK }).kind).toBe(
            "seeded",
        );
        const counts = () =>
            ["compartments", "tags", "pending_ops", "session_facts"].map(
                (table) =>
                    (
                        first
                            .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
                            .get(FORK) as { count: number }
                    ).count,
            );
        const afterFirst = counts();
        expect(seedV2ForkFromParent({ db: first, store: reader, sessionId: FORK }).kind).toBe(
            "has-state",
        );
        expect(
            seedV2ForkFromParent({ db: second, store: secondReader, sessionId: FORK }).kind,
        ).toBe("has-state");
        expect(counts()).toEqual(afterFirst);
    });

    it("declines inside the write lock when another host seeded between the check and the copy", () => {
        const { reader } = createStore();
        const db = createContextDb();
        seedParentState(db);
        // The other host's copy lands after this host's state check but before
        // its copy takes the write lock: the copier's own check under the lock
        // sees it and declines.
        const store = {
            ...reader,
            forkOrigin: (id: string) => reader.forkOrigin(id),
            sessionExists: (id: string) => reader.sessionExists(id),
            sequenceForId: (session: string, id: string) => reader.sequenceForId(session, id),
            matchingForkBodies: (parent: string, fork: string, through: number) =>
                reader.matchingForkBodies(parent, fork, through),
            iterateRawMessageRange: reader.iterateRawMessageRange.bind(reader),
            rowStampsThrough: (session: string, through: number) => {
                const rows = reader.rowStampsThrough(session, through);
                if (session === FORK && !sessionHasMagicContextState(db, FORK)) {
                    insertTag(db, FORK, `${forkId(1)}:p0`, 1, "active");
                }
                return rows;
            },
        };
        const outcome = seedV2ForkFromParent({ db, store, sessionId: FORK });
        expect(outcome.kind).toBe("destination-not-empty");
        expect(
            forkRows(db, "SELECT COUNT(*) AS count FROM compartments WHERE session_id = ?"),
        ).toEqual([{ count: 0 }]);
        expect(
            copySessionStateForClone(db, PARENT, FORK, {
                resolveBoundaryOrdinal: () => 1,
                includeTag: () => true,
                includeMessageId: () => true,
                selectPendingPiMarker: () => null,
            }).kind,
        ).toBe("destination-not-empty");
    });

    it("leaves a fork whose parent has no state, or whose parent the store lost, without inherited state", () => {
        const db = createContextDb();
        // No parent state at all.
        const { reader } = createStore();
        expect(seedV2ForkFromParent({ db, store: reader, sessionId: FORK })).toEqual({
            kind: "parent-missing",
            parentSessionID: PARENT,
            reason: "no Magic Context state",
        });
        expect(sessionHasMagicContextState(db, FORK)).toBe(false);

        // Parent state here, but the host deleted the parent session.
        seedParentState(db);
        const orphan = createStore({ withParentRow: false });
        expect(seedV2ForkFromParent({ db, store: orphan.reader, sessionId: FORK })).toMatchObject({
            kind: "parent-missing",
            reason: "no host session row",
        });
        expect(sessionHasMagicContextState(db, FORK)).toBe(false);

        // The boundary row is gone from the parent.
        const lost = createStore({
            boundary: JSON.stringify({ type: "through", messageID: "msg_deleted" }),
        });
        expect(seedV2ForkFromParent({ db, store: lost.reader, sessionId: FORK })).toMatchObject({
            kind: "parent-missing",
            reason: "boundary row not in the store",
        });
        expect(sessionHasMagicContextState(db, FORK)).toBe(false);
    });

    it("does nothing for a session that is not a fork, or whose boundary does not parse", () => {
        const db = createContextDb();
        seedParentState(db);
        const { reader } = createStore();
        expect(seedV2ForkFromParent({ db, store: reader, sessionId: "ses_plain" }).kind).toBe(
            "not-a-fork",
        );
        const broken = createStore({ boundary: "{not json" });
        expect(seedV2ForkFromParent({ db, store: broken.reader, sessionId: FORK }).kind).toBe(
            "not-a-fork",
        );
        expect(sessionHasMagicContextState(db, FORK)).toBe(false);
    });
});
