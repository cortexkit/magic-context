import { expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { readAssistantUsageRowsAfter } from "./work-metrics";

const oldQuery = `SELECT
  json_extract(data, '$.agent') AS agent, seq AS time_created, id,
  COALESCE(json_extract(data, '$.tokens.input'), 0)
    + COALESCE(json_extract(data, '$.tokens.cache.read'), 0)
    + COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS prompt,
  COALESCE(json_extract(data, '$.tokens.output'), 0) AS output
FROM session_message WHERE session_id = ? AND type = 'assistant' AND data IS NOT NULL
  AND (seq > ? OR (seq = ? AND id > ?)) ORDER BY seq, id`;

function fixture() {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE session_message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
        seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER, data TEXT);
        CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq);
        CREATE INDEX session_message_session_type_seq_idx ON session_message(session_id, type, seq);
        CREATE INDEX session_message_session_time_created_id_idx ON session_message(session_id, time_created, id);`);
    const insert = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, NULL, ?)");
    for (const [id, session, type, seq, data] of [
        ["before", "s", "assistant", 1, { tokens: { input: 100, output: 3 } }],
        ["equal", "s", "assistant", 2, { agent: "build", tokens: { cache: { read: 10 } } }],
        ["after", "s", "assistant", 3, { tokens: { input: 7, cache: { write: 2 } } }],
        ["user", "s", "user", 4, {}],
        ["null", "s", "assistant", 5, null],
        ["other", "other", "assistant", 6, {}],
    ] as const)
        insert.run(id, session, type, seq, 100 - seq, data === null ? null : JSON.stringify(data));
    return db;
}

test("OC2 usage seeks preserve both watermark branches and ordering", () => {
    const db = fixture();
    try {
        // The equal-sequence arm matters for arbitrary caller watermarks even
        // though the incremental carry normally names the unique stored row.
        for (const [seq, id] of [
            [0, ""],
            [2, "a"],
            [2, "equal"],
            [2, "z"],
            [9, ""],
        ] as const) {
            const expected = db
                .prepare(oldQuery)
                .all("s", seq, seq, id)
                .map((row) => {
                    const r = row as {
                        agent: string | null;
                        time_created: number;
                        id: string;
                        prompt: number;
                        output: number;
                    };
                    return {
                        agent: r.agent,
                        timeCreated: r.time_created,
                        id: r.id,
                        prompt: r.prompt,
                        output: r.output,
                    };
                });
            expect(readAssistantUsageRowsAfter(db, "s", seq, id, "v2")).toEqual(expected);
        }
        expect(readAssistantUsageRowsAfter(db, "s", 2, "a", "v2").map((r) => r.id)).toEqual([
            "equal",
            "after",
        ]);
    } finally {
        db.close();
    }
});

test("OC2 usage watermark uses sequence range seeks instead of walking the session", async () => {
    const db = fixture();
    const { spyOn } = await import("bun:test");
    const prepare = db.prepare.bind(db);
    const plans: string[] = [];
    const spy = spyOn(db, "prepare").mockImplementation((sql: string) => {
        const statement = prepare(sql);
        return {
            all: (...params: unknown[]) => {
                plans.push(
                    ...(
                        prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
                            detail: string;
                        }>
                    ).map((r) => r.detail),
                );
                return statement.all(...params);
            },
        } as typeof statement;
    });
    try {
        const before = (
            prepare(`EXPLAIN QUERY PLAN ${oldQuery}`).all("s", 2, 2, "equal") as Array<{
                detail: string;
            }>
        ).map((r) => r.detail);
        readAssistantUsageRowsAfter(db, "s", 2, "equal", "v2");
        console.log("OC2_USAGE_PLAN before:", before.join(" | "));
        console.log("OC2_USAGE_PLAN after:", plans.join(" | "));
        expect(plans.filter((p) => /SEARCH session_message.*seq>\?/.test(p))).toHaveLength(1);
        expect(plans.filter((p) => /SEARCH session_message.*seq=\?/.test(p))).toHaveLength(1);
        expect(plans.some((p) => /SEARCH session_message.*\(session_id=\?\)$/.test(p))).toBe(false);
        expect(plans.some((p) => /SCAN session_message/.test(p))).toBe(false);
    } finally {
        spy.mockRestore();
        db.close();
    }
});
