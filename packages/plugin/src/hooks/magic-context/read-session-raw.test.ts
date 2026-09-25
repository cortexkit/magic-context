/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    countRawSessionMessageOrdinalsFromDb,
    RAW_MESSAGE_PARTS_BY_ID_SQL,
    readRawSessionMessageByIdFromDb,
    readRawSessionMessageIdOrdinalsFromDb,
    readRawSessionMessageOrdinalAnchorRankFromDb,
    readRawSessionMessageOrdinalByIdFromDb,
    readRawSessionMessageOrdinalPageFromDb,
    readRawSessionMessagePageFromDb,
    readRawSessionMessagesFromDb,
} from "./read-session-raw";

describe("raw session point lookup", () => {
    it("uses the message-id part index with adversarial 100k-part session statistics", () => {
        const db = new Database(":memory:");
        try {
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
                    data TEXT NOT NULL,
                    FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
                );
                CREATE INDEX message_session_time_created_id_idx
                    ON message(session_id, time_created, id);
                CREATE INDEX part_session_idx ON part(session_id);
                CREATE INDEX part_message_id_id_idx ON part(message_id, id);

                INSERT INTO message VALUES
                    ('m-filler', 'session', 1, 1, '{"role":"user"}'),
                    ('m-target', 'session', 2, 2, '{"role":"assistant","finish":"stop"}');
                WITH RECURSIVE seq(i) AS (
                    SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 100000
                )
                INSERT INTO part
                    (id, message_id, session_id, time_created, time_updated, data)
                SELECT printf('p-%06d', i), 'm-filler', 'session', 1, 1,
                       '{"type":"text","text":"filler"}'
                FROM seq;
                INSERT INTO part VALUES
                    ('target-1', 'm-target', 'session', 2, 2, '{"type":"text","text":"first"}'),
                    ('target-2', 'm-target', 'session', 3, 3, '{"type":"text","text":"second"}');

                ANALYZE;
                UPDATE sqlite_stat1 SET stat = '100002 1' WHERE idx = 'part_session_idx';
                UPDATE sqlite_stat1 SET stat = '100002 100002 1'
                    WHERE idx = 'part_message_id_id_idx';
                ANALYZE sqlite_schema;
            `);

            const legacySql =
                "SELECT message_id, data, time_updated FROM part WHERE session_id = ? AND message_id = ? ORDER BY time_created ASC, id ASC";
            const legacyPlan = (
                db.prepare(`EXPLAIN QUERY PLAN ${legacySql}`).all("session", "m-target") as Array<{
                    detail: string;
                }>
            ).map((row) => row.detail);
            expect(legacyPlan.join(" | ")).toContain("part_session_idx");

            const pointPlan = (
                db
                    .prepare(`EXPLAIN QUERY PLAN ${RAW_MESSAGE_PARTS_BY_ID_SQL}`)
                    .all("session", "m-target") as Array<{
                    detail: string;
                }>
            ).map((row) => row.detail);
            expect(pointPlan.some((detail) => /\bSCAN part\b/i.test(detail))).toBe(false);
            expect(pointPlan.join(" | ")).toContain("part_message_id_id_idx");

            const scanStartedAt = performance.now();
            db.prepare(legacySql).all("session", "m-target");
            const scanMs = performance.now() - scanStartedAt;
            const pointStartedAt = performance.now();
            const target = readRawSessionMessageByIdFromDb(db, "session", "m-target");
            const pointMs = performance.now() - pointStartedAt;

            expect(target?.parts).toHaveLength(2);
            // The query plans above are the proof that the point lookup never scans.
            // The wall-clock comparison is only meaningful on a quiet machine: under
            // load a single 100k-part scan can finish in a few milliseconds while an
            // unrelated scheduler stall lands on the point lookup, so it is opt-in.
            if (process.env.MC_PERF_GATE) expect(pointMs).toBeLessThan(scanMs);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("raw session message id ordinals", () => {
    it("matches the full raw reader across ordering, summaries, roles, and tool arcs", () => {
        const db = new Database(":memory:");
        try {
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
            `);
            const insertMessage = db.prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 'session', ?, ?, ?)",
            );
            const rows: Array<[string, number, string]> = [
                ["m-tool-result", 30, JSON.stringify({ role: "tool", finish: "stop" })],
                [
                    "m-summary",
                    20,
                    JSON.stringify({ role: "assistant", summary: true, finish: "stop" }),
                ],
                ["m-weird", 20, JSON.stringify({ role: { unexpected: true }, summary: "true" })],
                ["m-user", 10, JSON.stringify({ role: "user" })],
                ["m-malformed", 25, "{"],
                [
                    "m-assistant",
                    20,
                    JSON.stringify({ role: "assistant", summary: true, finish: "tool-calls" }),
                ],
            ];
            for (const [id, createdAt, data] of rows) {
                insertMessage.run(id, createdAt, createdAt, data);
            }
            const insertPart = db.prepare(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, 'session', ?, ?, ?)",
            );
            insertPart.run(
                "p-call",
                "m-assistant",
                21,
                21,
                JSON.stringify({ type: "tool", callID: "call-1", state: { status: "completed" } }),
            );
            insertPart.run(
                "p-result",
                "m-tool-result",
                31,
                31,
                JSON.stringify({ type: "tool_result", callID: "call-1", output: "done" }),
            );

            const fullReaderMap = new Map(
                readRawSessionMessagesFromDb(db, "session").map((message) => [
                    message.id,
                    message.ordinal,
                ]),
            );

            expect(readRawSessionMessageIdOrdinalsFromDb(db, "session")).toEqual(fullReaderMap);
            expect(readRawSessionMessageOrdinalByIdFromDb(db, "session", "m-user")).toBe(1);
            expect(readRawSessionMessageOrdinalByIdFromDb(db, "session", "m-assistant")).toBe(2);
            expect(readRawSessionMessageOrdinalByIdFromDb(db, "session", "m-summary")).toBeNull();
            expect(readRawSessionMessageOrdinalByIdFromDb(db, "session", "missing")).toBeNull();
            expect([...fullReaderMap]).toEqual([
                ["m-user", 1],
                ["m-assistant", 2],
                ["m-weird", 3],
                ["m-tool-result", 5],
            ]);

            const firstPage = readRawSessionMessagePageFromDb(db, "session", 0, 2, 5);
            const secondPage = readRawSessionMessagePageFromDb(db, "session", 2, 3, 5);
            expect([...firstPage, ...secondPage].map(({ id, ordinal }) => [id, ordinal])).toEqual([
                ["m-user", 1],
                ["m-assistant", 2],
                ["m-weird", 3],
                ["m-malformed", 4],
                ["m-tool-result", 5],
            ]);
            expect(countRawSessionMessageOrdinalsFromDb(db, "session")).toBe(5);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("raw session ordinal anchor rank", () => {
    it("counts stored rows through an anchor in walk order and reports a missing anchor", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE message (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE INDEX message_session_time_created_id_idx
                    ON message(session_id, time_created, id);
            `);
            const insert = db.prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            );
            // Two rows share a creation time, so the id breaks the tie as the page walk does.
            insert.run("m-a", "ses", 10, 10, "{}");
            insert.run("m-c", "ses", 20, 20, "{}");
            insert.run("m-b", "ses", 20, 20, JSON.stringify({ summary: true, finish: "stop" }));
            insert.run("m-d", "ses", 30, 30, "{}");
            insert.run("other", "ses-other", 5, 5, "{}");

            const walk = readRawSessionMessageOrdinalPageFromDb(db, "ses", null, 10);
            walk.forEach((entry, index) => {
                expect(
                    readRawSessionMessageOrdinalAnchorRankFromDb(db, "ses", {
                        timeCreated: entry.timeCreated,
                        id: entry.id,
                    }),
                ).toBe(index + 1);
            });
            expect(walk.map((entry) => entry.id)).toEqual(["m-a", "m-b", "m-c", "m-d"]);
            // A removed row, a row of another session, and a row whose creation time no
            // longer matches are all missing anchors.
            expect(
                readRawSessionMessageOrdinalAnchorRankFromDb(db, "ses", {
                    timeCreated: 25,
                    id: "m-x",
                }),
            ).toBeNull();
            expect(
                readRawSessionMessageOrdinalAnchorRankFromDb(db, "ses", {
                    timeCreated: 5,
                    id: "other",
                }),
            ).toBeNull();
            expect(
                readRawSessionMessageOrdinalAnchorRankFromDb(db, "ses", {
                    timeCreated: 21,
                    id: "m-c",
                }),
            ).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});
