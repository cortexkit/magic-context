import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { readAssistantUsageRowsAfter } from "../features/magic-context/work-metrics";
import { Database } from "../shared/sqlite";
import { createTestTempDir } from "../shared/test-temp-dir";
import { V2MessageTimesCache } from "./message-times";
import { V2StoreReader } from "./store-reader";

function fixture() {
    const { dir: root, cleanup } = createTestTempDir("mc-v2-surface-", "times-independent-");
    const db = new Database(join(root, "store.db"));
    db.exec(`CREATE TABLE session_message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
        seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
        data TEXT NOT NULL);
        CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq);`);
    const reader = new V2StoreReader(join(root, "store.db"));
    const insert = (id: string, session: string, seq: number, completed = 2000) => {
        db.prepare("INSERT INTO session_message VALUES (?, ?, 'assistant', ?, 1000, 5000, ?)").run(
            id,
            session,
            seq,
            JSON.stringify({ time: { created: 1000, completed } }),
        );
    };
    return {
        db,
        reader,
        insert,
        close() {
            reader.close();
            db.close();
            cleanup();
        },
    };
}

for (const nextCompleted of [undefined, 3000]) {
    test(`review witness: completed assistant refreshes after same-millisecond ${nextCompleted === undefined ? "restart" : "terminal correction"}`, () => {
        const f = fixture();
        const cache = new V2MessageTimesCache();
        // A host write uses Date.now(). Read at that same clock value so this
        // models a recent write, not an ancient revision against today's clock.
        const clock = spyOn(Date, "now").mockReturnValue(5000);
        try {
            f.insert("a", "s", 1);
            expect(cache.pass("s")(f.reader, ["a"]).get("a")?.completed).toBe(2000);
            // OpenCode updates data and time_created; Drizzle supplies
            // time_updated from Date.now(), which can repeat across writes. The
            // fixture models an update with an unchanged started timestamp.
            f.db
                .prepare(
                    "UPDATE session_message SET type = 'assistant', time_created = 1000, data = ?, time_updated = ? WHERE id = 'a'",
                )
                .run(JSON.stringify({ time: { created: 1000, completed: nextCompleted } }), 5000);
            expect(f.reader.messageTimes("s", ["a"]).get("a")).toEqual({
                created: 1000,
                completed: nextCompleted,
            });
            expect(cache.pass("s")(f.reader, ["a"]).get("a")).toEqual({
                created: 1000,
                completed: nextCompleted,
            });
        } finally {
            clock.mockRestore();
            f.close();
        }
    });
}

test("review: dense versions recover out-of-span ids and reject missing and foreign ids", () => {
    const f = fixture();
    try {
        f.insert("left", "s", -5);
        f.insert("a", "s", 10);
        f.insert("b", "s", 12);
        f.insert("right", "s", 100);
        f.insert("foreign", "other", 11);
        const versions = f.reader.messageTimeVersions(
            "s",
            ["a", "b", "left", "right", "missing", "foreign", "a"],
            { first: 10, last: 12 },
        );
        expect([...versions.keys()].sort()).toEqual(["a", "b", "left", "right"]);
        expect(versions.get("left")?.seq).toBe(-5);
        expect(versions.get("right")?.seq).toBe(100);
        expect(f.reader.messageTimeVersions("s", [], { first: 0, last: 0 }).size).toBe(0);
    } finally {
        f.close();
    }
});

test("review: deletion and recreation with changed sequence refresh even outside the dense span", () => {
    const f = fixture();
    const cache = new V2MessageTimesCache();
    try {
        f.insert("a", "s", 1);
        cache.pass("s")(f.reader, ["a"]);
        f.db.exec("DELETE FROM session_message WHERE id = 'a'");
        expect(cache.pass("s")(f.reader, ["a"]).size).toBe(0);
        f.insert("a", "s", 1);
        cache.pass("s")(f.reader, ["a"]);
        f.db.exec("DELETE FROM session_message WHERE id = 'a'");
        f.insert("a", "s", 100, 4000);
        expect(cache.pass("s")(f.reader, ["a"]).get("a")).toEqual({
            created: 1000,
            completed: 4000,
        });
    } finally {
        f.close();
    }
});

test("review: capacity eviction and foreign ids cannot leak times across sessions", () => {
    const f = fixture();
    const cache = new V2MessageTimesCache(1);
    try {
        f.insert("a", "s", 1);
        f.insert("b", "fork", 1, 4000);
        expect([...cache.pass("s")(f.reader, ["a", "b"]).keys()]).toEqual(["a"]);
        expect([...cache.pass("fork")(f.reader, ["a", "b"]).keys()]).toEqual(["b"]);
        f.db.exec(
            "UPDATE session_message SET data = '{\"time\":{\"completed\":6000}}' WHERE id = 'a'",
        );
        expect(cache.pass("s")(f.reader, ["a"]).get("a")?.completed).toBe(6000);
    } finally {
        f.close();
    }
});

test("review: distinct host stores with identical ids and revisions do not reuse times", () => {
    const first = fixture();
    const second = fixture();
    const cache = new V2MessageTimesCache();
    try {
        first.insert("a", "s", 1, 2000);
        second.insert("a", "s", 1, 4000);
        expect(first.reader.hostIdentity()).not.toBe(second.reader.hostIdentity());
        expect(cache.pass("s")(first.reader, ["a"]).get("a")?.completed).toBe(2000);
        expect(cache.pass("s")(second.reader, ["a"]).get("a")?.completed).toBe(4000);
        expect(cache.pass("s")(first.reader, ["a"]).get("a")?.completed).toBe(2000);
    } finally {
        first.close();
        second.close();
    }
});

test("review: UNION ALL preserves tied-sequence order and the incremental watermark", () => {
    const f = fixture();
    try {
        // Real host sequences are unique. Dropping the constraint also exercises
        // the promised id tiebreaker independently of that schema guarantee.
        f.db.exec("DROP INDEX session_message_session_seq_idx");
        f.insert("z", "s", 2);
        f.insert("b", "s", 2);
        f.insert("a", "s", 2);
        f.insert("last", "s", 3);
        f.insert("foreign", "other", 2);
        const read = (seq: number, id: string) =>
            readAssistantUsageRowsAfter(f.db, "s", seq, id, "v2");
        expect(read(2, "").map((row) => row.id)).toEqual(["a", "b", "z", "last"]);
        expect(read(2, "b").map((row) => row.id)).toEqual(["z", "last"]);
        expect(read(2, "zz").map((row) => row.id)).toEqual(["last"]);
        const all = read(-1, "");
        const watermark = all[all.length - 1]!;
        expect(read(watermark.timeCreated, watermark.id)).toEqual([]);
        f.insert("new", "s", 4);
        expect(read(watermark.timeCreated, watermark.id).map((row) => row.id)).toEqual(["new"]);
    } finally {
        f.close();
    }
});
