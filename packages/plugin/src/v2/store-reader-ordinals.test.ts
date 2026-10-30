import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import type { Database } from "../shared/sqlite";
import { ordinalFixture } from "./ordinal-range.fixture";
import { RAW_MESSAGE_TYPES, V2StoreReader } from "./store-reader";

test("40,000 mixed v2 rows retain exact legacy ordinals across writes and revert", () => {
    const f = ordinalFixture();
    const reader = new V2StoreReader(f.path);
    const legacy = (from: number, to: number) =>
        new Map(
            (
                f.db
                    .prepare(
                        `SELECT id FROM session_message WHERE session_id = ? AND type IN (${RAW_MESSAGE_TYPES.map(() => "?").join(",")}) ORDER BY seq ASC LIMIT ? OFFSET ?`,
                    )
                    .all("s", ...RAW_MESSAGE_TYPES, to - from + 1, from - 1) as { id: string }[]
            ).map((row, i) => [row.id, from + i]),
        );
    const check = () => {
        for (const [from, to] of [
            [1, 23],
            [13_300, 13_322],
            [26_640, 26_680],
            [40_000, 40_022],
        ]) {
            const expected = legacy(from, to);
            expect(reader.messageIdOrdinals("s", from, to)).toEqual(expected);
            for (const [id, ordinal] of expected)
                expect(reader.messageOrdinalById("s", id)).toBe(ordinal);
        }
        expect(reader.messageOrdinalById("s", "private")).toBeNull();
        expect(reader.messageOrdinalById("s", "m-6")).toBeNull();
    };
    try {
        check();
        // A type edit leaves the tail and row count unchanged but shifts raw ordinals.
        f.db.exec("UPDATE session_message SET type='idle' WHERE id='m-0'");
        check();
        f.db.exec("UPDATE session_message SET type='user' WHERE id='m-0'");
        check();
        f.db.exec("DELETE FROM session_message WHERE session_id='s' AND seq >= 119_940");
        check();
        f.db.exec("DELETE FROM session_message WHERE id='m-3'");
        check();
    } finally {
        reader.close();
        f.cleanup();
    }
});

test("warm v2 ordinal range SQLite VM work is flat at the start and end", () => {
    const f = ordinalFixture();
    const reader = new V2StoreReader(f.path);
    const db = (reader as unknown as { db: Database }).db;
    const prepare = db.prepare.bind(db);
    const queries: Array<{ sql: string; args: unknown[] }> = [];
    db.prepare = ((sql: string) => {
        const statement = prepare(sql);
        return new Proxy(statement, {
            get(target, key) {
                const value = Reflect.get(target, key);
                if (typeof value !== "function") return value;
                return (...args: unknown[]) => {
                    if (key === "all" || key === "get") queries.push({ sql, args });
                    return Reflect.apply(value, target, args);
                };
            },
        });
    }) as typeof db.prepare;
    try {
        reader.messageIdOrdinals("s", 1, 23);
        const measure = (lookup: () => void) => {
            queries.length = 0;
            lookup();
            const measured = spawnSync(
                "python3",
                [
                    "-c",
                    `
import json, sqlite3, sys
db = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
steps = 0
def step():
    global steps
    steps += 1
    return 0
plans = []
for q in json.load(sys.stdin):
    plans.extend(row[3] for row in db.execute('EXPLAIN QUERY PLAN ' + q['sql'], q['args']))
    db.set_progress_handler(step, 1)
    db.execute(q['sql'], q['args']).fetchall()
    db.set_progress_handler(None, 0)
print(json.dumps({'steps': steps, 'plans': plans}))
`,
                    f.path,
                ],
                { input: JSON.stringify(queries), encoding: "utf8", windowsHide: true },
            );
            expect(measured.status, measured.stderr).toBe(0);
            return JSON.parse(measured.stdout) as { steps: number; plans: string[] };
        };
        const range = (from: number) => () => {
            expect(reader.messageIdOrdinals("s", from, from + 22).size).toBe(23);
        };
        const start = measure(range(1));
        const end = measure(range(26_640));
        const tagStart = measure(() => {
            expect(reader.messageOrdinalById("s", "m-0")).toBe(1);
        });
        const tagEnd = measure(() => {
            expect(reader.messageOrdinalById("s", "m-39996")).toBe(26_665);
        });
        console.log("v2 ordinal SQLite VM steps", { start, end, tagStart, tagEnd });
        expect(end.plans.some((plan) => /SEARCH.*session_message.*seq>/.test(plan))).toBe(true);
        expect(end.plans.some((plan) => /SCAN session_message/.test(plan))).toBe(false);
        expect(start.steps).toBeGreaterThan(100);
        expect(end.steps).toBeLessThan(start.steps * 1.2);
        expect(end.steps).toBeLessThan(2_000);
        expect(tagEnd.steps).toBeLessThan(tagStart.steps * 1.2);
        expect(tagEnd.steps).toBeLessThan(200);
    } finally {
        reader.close();
        f.cleanup();
    }
});
