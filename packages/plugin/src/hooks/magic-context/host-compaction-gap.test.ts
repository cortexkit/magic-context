/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    clearHostCompactionGapState,
    type HostCompactionGapOutcome,
    holdHostCompactionGapRow,
    hostCompactionGapBudgetTokens,
    markHostCompactionTagsKept,
    resolveHostCompactionGapLowerBound,
    restoreHostCompactionGap,
    settleHostCompactionTags,
} from "./host-compaction-gap";
import { findHostCompactionWindow } from "./inject-compartments";
import { readHostMessageRangeFromDb, readHostMessagesByIdFromDb } from "./read-session-raw";
import type { MessageLike } from "./tag-messages";

const SESSION = "ses-gap";

/**
 * A session after a native `/compact` with `tail_turns: 1`, in OpenCode 1's store:
 *   u1 a1 | u2 a2 u3 a3 | u4 a4 | req sum | u5
 * a1 is the last row Magic Context's compartments cover, u4 is the retained tail's
 * first row, so u2..a3 are the rows the compaction hid.
 */
function createStore(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE TABLE part (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
        CREATE INDEX part_session_idx ON part(session_id);
        CREATE INDEX part_message_id_id_idx ON part(message_id, id);

        -- The Magic Context tables the restore reads and writes, in the same database
        -- for brevity.
        CREATE TABLE session_meta (
            session_id TEXT PRIMARY KEY,
            deferred_execute_state TEXT,
            cached_m0_bytes BLOB,
            cached_m0_last_baseline_end_message_id TEXT
        );
        CREATE TABLE compartments (
            session_id TEXT,
            sequence INTEGER,
            end_message_id TEXT,
            rebase_status TEXT NOT NULL DEFAULT 'resolved'
        );
        CREATE TABLE tags (session_id TEXT, message_id TEXT, status TEXT, tag_number INTEGER);
        CREATE TABLE pending_ops (session_id TEXT, tag_id INTEGER);
    `);
    db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run(SESSION);
    let clock = 0;
    const add = (id: string, info: Record<string, unknown>, parts: Record<string, unknown>[]) => {
        clock += 10;
        db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        ).run(id, SESSION, clock, clock, JSON.stringify(info));
        parts.forEach((part, index) => {
            db.prepare(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
            ).run(`p-${id}-${index}`, id, SESSION, clock, clock, JSON.stringify(part));
        });
    };
    const user = (id: string, text: string) =>
        add(id, { role: "user", agent: "build", time: { created: clock } }, [
            { type: "text", text },
        ]);
    const assistant = (id: string, parentID: string, text: string) =>
        add(
            id,
            {
                role: "assistant",
                parentID,
                finish: "stop",
                time: { created: clock, completed: clock + 1 },
            },
            [
                { type: "step-start" },
                { type: "text", text },
                {
                    type: "tool",
                    callID: `call-${id}`,
                    tool: "bash",
                    state: {
                        status: "completed",
                        input: { command: `echo ${id}` },
                        output: `${id}\n`,
                        title: "echo",
                        metadata: { exit: 0 },
                        time: { start: 1, end: 2 },
                    },
                },
                { type: "step-finish", reason: "stop" },
            ],
        );
    user("u1", "turn 1");
    assistant("a1", "u1", "reply 1");
    user("u2", "turn 2");
    assistant("a2", "u2", "reply 2");
    user("u3", "turn 3");
    assistant("a3", "u3", "reply 3");
    user("u4", "turn 4");
    assistant("a4", "u4", "reply 4");
    add("req", { role: "user", agent: "build", time: { created: clock } }, [
        { type: "compaction", auto: false, tail_start_id: "u4" },
    ]);
    add(
        "sum",
        {
            role: "assistant",
            parentID: "req",
            summary: true,
            mode: "compaction",
            finish: "stop",
            time: { created: clock, completed: clock + 5 },
        },
        [{ type: "text", text: "host summary" }],
    );
    user("u5", "turn 5");
    return db;
}

/** What OpenCode 1 loads after the compaction: [req, sum, retained tail, newer rows]. */
function hostWindow(db: Database): MessageLike[] {
    const read = (id: string): MessageLike => {
        const before = db
            .prepare(
                "SELECT id FROM message WHERE session_id = ? AND (time_created, id) < (SELECT time_created, id FROM message WHERE id = ?) ORDER BY time_created DESC, id DESC LIMIT 1",
            )
            .get(SESSION, id) as { id: string };
        const range = readHostMessageRangeFromDb(db, SESSION, before.id, nextId(db, id), 10);
        if (range.status !== "ok" || range.messages.length !== 1) throw new Error(`no row ${id}`);
        return range.messages[0] as unknown as MessageLike;
    };
    return ["req", "sum", "u4", "a4", "u5"].map(read);
}

function nextId(db: Database, id: string): string {
    const row = db
        .prepare(
            "SELECT id FROM message WHERE session_id = ? AND (time_created, id) > (SELECT time_created, id FROM message WHERE id = ?) ORDER BY time_created ASC, id ASC LIMIT 1",
        )
        .get(SESSION, id) as { id: string } | null;
    if (row) return row.id;
    // The newest row has no successor; add a sentinel row past it for the read.
    db.prepare(
        "INSERT OR IGNORE INTO message (id, session_id, time_created, time_updated, data) VALUES ('zz-end', ?, 1000000, 1000000, '{\"role\":\"user\"}')",
    ).run(SESSION);
    return "zz-end";
}

function compareOrder(db: Database, left: string, right: string): number | null {
    const lookup = db.prepare("SELECT time_created AS t, id FROM message WHERE id = ?");
    const l = lookup.get(left) as { t: number; id: string } | null;
    const r = lookup.get(right) as { t: number; id: string } | null;
    if (!l || !r) return null;
    return l.t !== r.t ? l.t - r.t : l.id < r.id ? -1 : l.id > r.id ? 1 : 0;
}

interface PassOptions {
    /** The boundary row; null means no boundary can be resolved. Defaults to a1. */
    boundaryId?: string | null;
    /** Start the range at the session's first row. */
    fromSessionStart?: boolean;
    refreshAllowed?: boolean;
    budgetTokens?: number;
    messages?: MessageLike[];
}

function pass(
    db: Database,
    options: PassOptions = {},
): { outcome: HostCompactionGapOutcome; messages: MessageLike[] } {
    const messages = options.messages ?? hostWindow(db);
    const window = findHostCompactionWindow(messages, () => null);
    if (!window) throw new Error("the host window does not start with a compaction pair");
    const boundaryId = options.boundaryId === undefined ? "a1" : options.boundaryId;
    const outcome = restoreHostCompactionGap({
        db,
        sessionId: SESSION,
        messages,
        window,
        lower: options.fromSessionStart
            ? { afterId: null }
            : boundaryId === null
              ? null
              : { afterId: boundaryId },
        refreshAllowed: options.refreshAllowed ?? false,
        budgetTokens: options.budgetTokens ?? 1_000_000,
        readRange: (afterId, beforeId, maxRows) =>
            readHostMessageRangeFromDb(db, SESSION, afterId, beforeId, maxRows),
        readById: (rowIds) => readHostMessagesByIdFromDb(db, SESSION, rowIds),
        compareOrder: (left, right) => compareOrder(db, left, right),
    });
    return { outcome, messages };
}

const ids = (messages: MessageLike[]) => messages.map((message) => message.info.id);

let db: Database;

beforeEach(() => {
    clearHostCompactionGapState();
    db = createStore();
});

afterEach(() => {
    clearHostCompactionGapState();
    closeQuietly(db);
});

describe("reading the rows a native compaction hid", () => {
    it("reads the rows strictly between the boundary and the retained tail, in the host's shape", () => {
        const read = readHostMessageRangeFromDb(db, SESSION, "a1", "u4", 100);
        expect(read.status).toBe("ok");
        if (read.status !== "ok") return;
        expect(read.messages.map((message) => message.info.id)).toEqual(["u2", "a2", "u3", "a3"]);
        const assistant = read.messages[1];
        expect(assistant?.info).toEqual({
            role: "assistant",
            parentID: "u2",
            finish: "stop",
            time: { created: 30, completed: 31 },
            id: "a2",
            sessionID: SESSION,
        });
        expect(assistant?.parts.map((part) => part.type)).toEqual([
            "step-start",
            "text",
            "tool",
            "step-finish",
        ]);
        expect(assistant?.parts[2]).toEqual({
            type: "tool",
            callID: "call-a2",
            tool: "bash",
            state: {
                status: "completed",
                input: { command: "echo a2" },
                output: "a2\n",
                title: "echo",
                metadata: { exit: 0 },
                time: { start: 1, end: 2 },
            },
            id: "p-a2-2",
            sessionID: SESSION,
            messageID: "a2",
        });
    });

    it("reads an empty range when the boundary sorts at or after the retained tail", () => {
        expect(readHostMessageRangeFromDb(db, SESSION, "u4", "u4", 100)).toEqual({
            status: "ok",
            messages: [],
        });
        expect(readHostMessageRangeFromDb(db, SESSION, "a4", "u4", 100)).toEqual({
            status: "ok",
            messages: [],
        });
    });

    it("reports a bound that is not stored and refuses a range longer than the cap", () => {
        expect(readHostMessageRangeFromDb(db, SESSION, "gone", "u4", 100)).toEqual({
            status: "missing-bound",
            missing: "after",
        });
        expect(readHostMessageRangeFromDb(db, SESSION, "a1", "gone", 100)).toEqual({
            status: "missing-bound",
            missing: "before",
        });
        expect(readHostMessageRangeFromDb(db, SESSION, "a1", "u4", 3)).toEqual({
            status: "too-many-rows",
            rows: 4,
        });
    });

    it("reads the range through the session/time index", () => {
        const plan = (
            db
                .prepare(
                    `EXPLAIN QUERY PLAN SELECT id, session_id, data FROM message
                     WHERE session_id = ? AND (time_created, id) > (?, ?) AND (time_created, id) < (?, ?)
                     ORDER BY time_created ASC, id ASC LIMIT ?`,
                )
                .all(SESSION, 20, "a1", 70, "u4", 10) as Array<{ detail: string }>
        ).map((row) => row.detail);
        expect(plan.join("\n")).toContain("message_session_time_created_id_idx");
        expect(plan.join("\n")).not.toContain("TEMP B-TREE");
    });
});

describe("restoring the rows a native compaction hid", () => {
    it("serves the hidden rows in place of the compaction request, before the retained tail", () => {
        const { outcome, messages } = pass(db);
        expect(outcome.status).toBe("restored");
        expect(ids(messages)).toEqual(["sum", "u2", "a2", "u3", "a3", "u4", "a4", "u5"]);
    });

    it("drops the compaction request row", () => {
        const { messages } = pass(db);
        expect(ids(messages)).not.toContain("req");
        expect(
            messages.some((message) =>
                message.parts.some((part) => (part as { type?: string }).type === "compaction"),
            ),
        ).toBe(false);
    });

    it("leaves an older compaction pair inside the range off the wire, but serves a turn that carries a compaction part", () => {
        const insert = db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        const insertPart = db.prepare(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
        );
        insert.run("old-req", SESSION, 32, 32, JSON.stringify({ role: "user" }));
        insertPart.run(
            "p-old-req",
            "old-req",
            SESSION,
            32,
            32,
            '{"type":"compaction","auto":false}',
        );
        insert.run(
            "old-sum",
            SESSION,
            34,
            34,
            JSON.stringify({
                role: "assistant",
                parentID: "old-req",
                summary: true,
                finish: "stop",
            }),
        );
        insertPart.run("p-old-sum", "old-sum", SESSION, 34, 34, '{"type":"text","text":"old"}');
        insertPart.run("p-u3-9", "u3", SESSION, 50, 50, '{"type":"compaction","auto":true}');

        const { messages } = pass(db);
        expect(ids(messages)).toEqual(["sum", "u2", "a2", "u3", "a3", "u4", "a4", "u5"]);
        expect((messages[3] as MessageLike).parts).toHaveLength(2);
    });

    it("falls back to the host's messages when the request names no retained tail", () => {
        const messages = hostWindow(db);
        const request = messages[0] as MessageLike;
        request.parts = [{ type: "compaction", auto: false }];
        const before = structuredClone(messages);
        const { outcome } = pass(db, { messages });
        expect(outcome).toMatchObject({ status: "fallback", reason: "no-tail-start" });
        expect(messages).toEqual(before);
    });

    it("falls back to the host's messages when there is no compartment boundary", () => {
        const messages = hostWindow(db);
        const before = structuredClone(messages);
        const { outcome } = pass(db, { messages, boundaryId: null });
        expect(outcome).toMatchObject({ status: "fallback", reason: "no-boundary" });
        expect(messages).toEqual(before);
    });

    it("restores nothing when the boundary is inside the retained tail, and still drops the request", () => {
        const { outcome, messages } = pass(db, { boundaryId: "u4" });
        expect(outcome.status).toBe("restored");
        if (outcome.status === "restored") expect(outcome.restored).toEqual([]);
        expect(ids(messages)).toEqual(["sum", "u4", "a4", "u5"]);
    });

    it("falls back when the hidden rows exceed the budget, and keeps that verdict until a busting pass", () => {
        const messages = hostWindow(db);
        const before = structuredClone(messages);
        const first = pass(db, { messages, budgetTokens: 1 });
        expect(first.outcome).toMatchObject({ status: "fallback", reason: "too-large" });
        expect(first.messages).toEqual(before);

        // A defer pass may not start serving the range: that would change its bytes.
        const deferPass = pass(db, { budgetTokens: 1_000_000 });
        expect(deferPass.outcome).toMatchObject({ status: "fallback", reason: "too-large" });
        expect(ids(deferPass.messages)).toContain("req");

        const bustingPass = pass(db, { budgetTokens: 1_000_000, refreshAllowed: true });
        expect(bustingPass.outcome.status).toBe("restored");
    });

    it("budgets the hidden rows against what the usable window leaves after the protected tail", () => {
        expect(hostCompactionGapBudgetTokens(200_000, 65)).toBe(130_000 - 52_000);
        expect(hostCompactionGapBudgetTokens(undefined, 65)).toBe(
            hostCompactionGapBudgetTokens(128_000, 65),
        );
    });

    it("gives every pass its own copy of the restored rows", () => {
        const first = pass(db);
        (first.messages[1] as MessageLike).parts.length = 0;
        const second = pass(db);
        expect(JSON.stringify(second.messages)).toBe(JSON.stringify(pass(db).messages));
        expect((second.messages[1] as MessageLike).parts).toHaveLength(1);
    });
});

describe("the restored range across passes", () => {
    it("replays the same bytes on a defer pass after a revert removed hidden rows", () => {
        const served = JSON.stringify(pass(db).messages);
        db.prepare("DELETE FROM part WHERE message_id IN ('u3', 'a3')").run();
        db.prepare("DELETE FROM message WHERE id IN ('u3', 'a3')").run();

        expect(JSON.stringify(pass(db).messages)).toBe(served);

        // The removed rows drop out of the served range only on a pass that already
        // rebuilds the cached prefix, and stay out on the passes after it.
        const busting = pass(db, { refreshAllowed: true });
        expect(ids(busting.messages)).toEqual(["sum", "u2", "a2", "u4", "a4", "u5"]);
        expect(JSON.stringify(pass(db).messages)).toBe(JSON.stringify(busting.messages));
    });

    it("answers a moved boundary on a defer pass from the rows it served, without reading the store", () => {
        const first = pass(db).messages;
        // A stored row changes after it was served; a defer pass must not pick it up.
        db.prepare("UPDATE part SET data = ? WHERE id = 'p-u3-0'").run(
            JSON.stringify({ type: "text", text: "rewritten" }),
        );

        const moved = pass(db, { boundaryId: "a2" }).messages;
        expect(ids(moved)).toEqual(["sum", "u3", "a3", "u4", "a4", "u5"]);
        expect(JSON.stringify(moved.slice(1, 3))).toBe(JSON.stringify(first.slice(3, 5)));

        const pastTail = pass(db, { boundaryId: "a4" }).messages;
        expect(ids(pastTail)).toEqual(["sum", "u4", "a4", "u5"]);
    });

    it("keeps serving the rows it served when a defer pass's boundary is not among them", () => {
        const first = JSON.stringify(pass(db, { boundaryId: "a2" }).messages);
        // The stored boundary moved back to a1, before every served row (as after a
        // history rebuild). A defer pass keeps serving the rows it served; only a
        // cache-busting pass reads the store again.
        expect(JSON.stringify(pass(db, { boundaryId: "a1" }).messages)).toBe(first);
        expect(ids(pass(db, { boundaryId: "a1", refreshAllowed: true }).messages)).toEqual([
            "sum",
            "u2",
            "a2",
            "u3",
            "a3",
            "u4",
            "a4",
            "u5",
        ]);
    });

    it("rebuilds after a restart exactly the range the last pass served", () => {
        // A busting pass restores from the boundary it started with; its prefix trim
        // then cuts through the boundary it records, here a2.
        const served = pass(db, { refreshAllowed: true }).messages;
        const afterTrim = [served[0], ...served.slice(3)];
        const deferPass = pass(db, { boundaryId: "a2" }).messages;
        expect(JSON.stringify(deferPass)).toBe(JSON.stringify(afterTrim));

        clearHostCompactionGapState();
        const restarted = pass(db, { boundaryId: "a2" });
        expect(restarted.outcome.status).toBe("restored");
        if (restarted.outcome.status === "restored")
            expect(restarted.outcome.source).toBe("record");
        expect(JSON.stringify(restarted.messages)).toBe(JSON.stringify(deferPass));
    });
});

describe("where the restored range starts", () => {
    const setBaseline = (m0: string | null, boundary: string | null) =>
        db
            .prepare(
                "UPDATE session_meta SET cached_m0_bytes = ?, cached_m0_last_baseline_end_message_id = ? WHERE session_id = ?",
            )
            .run(m0, boundary, SESSION);
    const addCompartment = (end: string) =>
        db
            .prepare(
                "INSERT INTO compartments (session_id, sequence, end_message_id) VALUES (?, 1, ?)",
            )
            .run(SESSION, end);

    it("starts after the boundary a cached m[0] records", () => {
        setBaseline("m0", "a1");
        addCompartment("a2");
        expect(resolveHostCompactionGapLowerBound(db, SESSION)).toEqual({ afterId: "a1" });
    });

    it("starts at the session's first row when the cached m[0] covers no compartment, even after one is published", () => {
        setBaseline("m0", null);
        addCompartment("a2");
        expect(resolveHostCompactionGapLowerBound(db, SESSION)).toEqual({ afterId: null });
    });

    it("uses the latest compartment end only when no m[0] is cached", () => {
        addCompartment("a2");
        expect(resolveHostCompactionGapLowerBound(db, SESSION)).toEqual({ afterId: "a2" });
    });

    it("resolves nothing without a cached m[0] or a compartment", () => {
        expect(resolveHostCompactionGapLowerBound(db, SESSION)).toBeNull();
    });

    it("restores from the session's first row", () => {
        const { messages } = pass(db, { fromSessionStart: true });
        expect(ids(messages)).toEqual([
            "sum",
            "u1",
            "a1",
            "u2",
            "a2",
            "u3",
            "a3",
            "u4",
            "a4",
            "u5",
        ]);
    });

    it("keeps rows a new compartment covers on the wire until a busting pass moves the boundary", () => {
        const served = JSON.stringify(pass(db, { fromSessionStart: true }).messages);
        // A compartment over u1..a1 is published but m[0] is not re-rendered: the
        // lower bound is still the session start, so the served rows do not move.
        expect(JSON.stringify(pass(db, { fromSessionStart: true }).messages)).toBe(served);
        // The busting pass records a1 as the boundary; the passes after it serve
        // the rows after a1, as that pass's prefix trim did.
        expect(ids(pass(db, { boundaryId: "a1" }).messages)).toEqual([
            "sum",
            "u2",
            "a2",
            "u3",
            "a3",
            "u4",
            "a4",
            "u5",
        ]);
    });
});

describe("the served range across a restart", () => {
    const removeRow = (id: string) => {
        db.prepare("DELETE FROM part WHERE message_id = ?").run(id);
        db.prepare("DELETE FROM message WHERE id = ?").run(id);
    };

    it("replays a served row the host removed, on the first pass after a restart", () => {
        const served = JSON.stringify(pass(db).messages);
        expect(holdHostCompactionGapRow(db, SESSION, "a2", "removed")).toBe(true);
        removeRow("a2");
        expect(JSON.stringify(pass(db).messages)).toBe(served);

        clearHostCompactionGapState();
        const restarted = pass(db);
        expect(restarted.outcome).toMatchObject({ status: "restored", source: "record" });
        expect(JSON.stringify(restarted.messages)).toBe(served);

        // A pass already known to bust reads the store again: the row leaves the
        // range, and its state may be cleaned now.
        const busting = pass(db, { refreshAllowed: true });
        expect(ids(busting.messages)).toEqual(["sum", "u2", "u3", "a3", "u4", "a4", "u5"]);
        expect(busting.outcome.rowsLeftRange).toEqual(["a2"]);
        expect(pass(db).outcome.rowsLeftRange).toEqual([]);
    });

    it("replays a served row the host edited, on the first pass after a restart", () => {
        const served = JSON.stringify(pass(db).messages);
        expect(holdHostCompactionGapRow(db, SESSION, "u3", "changed")).toBe(true);
        db.prepare("UPDATE part SET data = ? WHERE id = 'p-u3-0'").run(
            JSON.stringify({ type: "text", text: "edited" }),
        );
        clearHostCompactionGapState();
        expect(JSON.stringify(pass(db).messages)).toBe(served);
        expect(JSON.stringify(pass(db, { refreshAllowed: true }).messages)).toContain("edited");
    });

    it("does not hold a row it does not serve", () => {
        pass(db);
        expect(holdHostCompactionGapRow(db, SESSION, "u4", "removed")).toBe(false);
        expect(holdHostCompactionGapRow(db, SESSION, "u1", "removed")).toBe(false);
    });

    it("reads the store again when the store changed while no process recorded the served rows", () => {
        pass(db);
        removeRow("a2");
        clearHostCompactionGapState();
        const restarted = pass(db);
        expect(restarted.outcome).toMatchObject({ status: "restored", source: "store" });
        expect(ids(restarted.messages)).not.toContain("a2");
    });

    it("keeps a too-large verdict across a restart until a busting pass", () => {
        pass(db, { budgetTokens: 1 });
        clearHostCompactionGapState();
        expect(pass(db).outcome).toMatchObject({ status: "fallback", reason: "too-large" });
        expect(pass(db, { refreshAllowed: true }).outcome.status).toBe("restored");
    });

    it("keeps a read failure's verdict on the passes after it, until a busting pass", () => {
        pass(db);
        removeRow("a1");
        const busting = pass(db, { refreshAllowed: true });
        expect(busting.outcome).toMatchObject({ status: "fallback", reason: "missing-bound" });
        expect(pass(db).outcome).toMatchObject({ status: "fallback", reason: "missing-bound" });
        clearHostCompactionGapState();
        expect(pass(db).outcome).toMatchObject({ status: "fallback", reason: "missing-bound" });
    });

    it("leaves the rest of the shared session state column alone", () => {
        db.prepare("UPDATE session_meta SET deferred_execute_state = ? WHERE session_id = ?").run(
            JSON.stringify({ other: { kept: true } }),
            SESSION,
        );
        pass(db);
        const root = JSON.parse(
            (
                db
                    .prepare(
                        "SELECT deferred_execute_state AS s FROM session_meta WHERE session_id = ?",
                    )
                    .get(SESSION) as { s: string }
            ).s,
        ) as Record<string, unknown>;
        expect(root.other).toEqual({ kept: true });
        expect(Object.keys(root).sort()).toEqual(["magicContextHostCompactionGap", "other"]);
    });
});

describe("tag statuses a native compaction kept", () => {
    const seedTags = () => {
        db.prepare("INSERT INTO tags VALUES (?, 'u2', 'dropped', 1), (?, 'u4', 'active', 2)").run(
            SESSION,
            SESSION,
        );
        db.prepare("INSERT INTO pending_ops VALUES (?, 2)").run(SESSION);
    };
    const statuses = () =>
        (
            db
                .prepare("SELECT status FROM tags WHERE session_id = ? ORDER BY tag_number")
                .all(SESSION) as Array<{ status: string }>
        ).map((row) => row.status);
    const pendingOps = () =>
        (db.prepare("SELECT COUNT(*) AS c FROM pending_ops").get() as { c: number }).c;

    it("stay when the first pass after the compaction restores the rows", () => {
        seedTags();
        markHostCompactionTagsKept(db, SESSION);
        const { outcome } = pass(db);
        expect(settleHostCompactionTags(db, SESSION, outcome)).toBe("kept");
        expect(statuses()).toEqual(["dropped", "active"]);
        expect(pendingOps()).toBe(1);
        // Settled once: a later pass changes nothing.
        expect(settleHostCompactionTags(db, SESSION, pass(db, { budgetTokens: 1 }).outcome)).toBe(
            "none",
        );
    });

    it("are retired as a native compaction always retired them when that pass cannot restore", () => {
        seedTags();
        markHostCompactionTagsKept(db, SESSION);
        const { outcome } = pass(db, { budgetTokens: 1 });
        expect(settleHostCompactionTags(db, SESSION, outcome)).toBe("retired");
        expect(statuses()).toEqual(["compacted", "compacted"]);
        expect(pendingOps()).toBe(0);
    });
});
