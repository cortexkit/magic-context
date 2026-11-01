import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../shared/test-temp-dir";
import { V2MessageTimesCache } from "./message-times";
import { V2StoreReader } from "./store-reader";

function fixture(count = 1000) {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-times-cache-"));
    const path = join(root, "store.db");
    const db = new Database(path);
    db.exec(`CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, type TEXT,
        seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
        CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id,seq);`);
    const insert = db.prepare("INSERT INTO session_message VALUES (?, 's', ?, ?, ?, 1, ?)");
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
        const id = `m${i}`;
        ids.push(id);
        insert.run(
            id,
            i % 2 ? "assistant" : "user",
            i,
            i * 600000,
            JSON.stringify({
                time: { created: -1, ...(i % 2 ? { completed: i * 600000 + 1000 } : {}) },
            }),
        );
    }
    const reader = new V2StoreReader(path);
    const cache = new V2MessageTimesCache();
    return {
        db,
        reader,
        cache,
        ids,
        cleanup() {
            reader.close();
            db.close();
            rmSync(root, { recursive: true, force: true });
        },
    };
}

test("OC2 times cache reads only new or incomplete times on later passes", () => {
    const f = fixture();
    const real = f.reader.messageTimes.bind(f.reader);
    const reads: string[][] = [];
    const spy = spyOn(f.reader, "messageTimes").mockImplementation((session, ids, versions) => {
        reads.push([...ids]);
        return real(session, ids, versions);
    });
    const metadata = spyOn(f.reader, "messageTimeVersions");
    try {
        expect(f.cache.pass("s")(f.reader, f.ids).size).toBe(1000);
        expect(reads.flat()).toHaveLength(1000);
        expect(metadata.mock.calls.flatMap((args) => args[1])).toHaveLength(0);
        reads.length = 0;
        expect(f.cache.pass("s")(f.reader, f.ids).size).toBe(1000);
        expect(reads.flat()).toHaveLength(0);
        f.db.exec(
            `INSERT INTO session_message VALUES ('running', 's', 'assistant', 1000, 900000000, NULL, '{"time":{"created":900000000}}')`,
        );
        const ids = [...f.ids, "running"];
        f.cache.pass("s")(f.reader, ids);
        f.cache.pass("s")(f.reader, ids);
        expect(reads.flat()).toEqual(["running", "running"]);
        f.db.exec(
            `UPDATE session_message SET data = '{"time":{"completed":900000099}}', time_updated = 1 WHERE id = 'running'`,
        );
        expect(f.cache.pass("s")(f.reader, ids).get("running")?.completed).toBe(900000099);
        reads.length = 0;
        f.cache.pass("s")(f.reader, ids);
        expect(reads.flat()).toHaveLength(0);
    } finally {
        metadata.mockRestore();
        spy.mockRestore();
        f.cleanup();
    }
});

test("OC2 times written less than one second before the read are never cached", () => {
    const f = fixture(2);
    const clock = spyOn(Date, "now").mockReturnValue(5999);
    const reads = spyOn(f.reader, "messageTimes");
    try {
        f.db.exec(`UPDATE session_message SET time_created = 1000, time_updated = 5000,
            data = '{"time":{"created":1000,"completed":4000}}' WHERE id = 'm1'`);
        for (let pass = 0; pass < 3; pass++)
            expect(f.cache.pass("s")(f.reader, ["m1"]).get("m1")?.completed).toBe(4000);
        expect(reads.mock.calls.flatMap((args) => args[1])).toEqual(["m1", "m1", "m1"]);
        clock.mockReturnValue(6000);
        f.cache.pass("s")(f.reader, ["m1"]);
        reads.mockClear();
        f.cache.pass("s")(f.reader, ["m1"]);
        expect(reads.mock.calls.flatMap((args) => args[1])).toEqual([]);
    } finally {
        reads.mockRestore();
        clock.mockRestore();
        f.cleanup();
    }
});

test("OC2 later writes get a newer stamp and refresh a previously settled completion", () => {
    const f = fixture(2);
    const clock = spyOn(Date, "now").mockReturnValue(6000);
    const reads = spyOn(f.reader, "messageTimes");
    try {
        f.db.exec(`UPDATE session_message SET time_created = 1000, time_updated = 5000,
            data = '{"time":{"created":1000,"completed":4500}}' WHERE id = 'm1'`);
        expect(f.cache.pass("s")(f.reader, ["m1"]).get("m1")?.completed).toBe(4500);
        reads.mockClear();
        f.cache.pass("s")(f.reader, ["m1"]);
        expect(reads.mock.calls.flatMap((args) => args[1])).toEqual([]);
        clock.mockReturnValue(7000);
        f.db.exec(`UPDATE session_message SET time_updated = 7000,
            data = '{"time":{"created":1000,"completed":7000}}' WHERE id = 'm1'`);
        expect(f.cache.pass("s")(f.reader, ["m1"]).get("m1")).toEqual({
            created: 1000,
            completed: 7000,
        });
        expect(reads.mock.calls.flatMap((args) => args[1])).toEqual(["m1"]);
    } finally {
        reads.mockRestore();
        clock.mockRestore();
        f.cleanup();
    }
});

test("OC2 message invalidation removes only that cached message", () => {
    const f = fixture(4);
    const reads = spyOn(f.reader, "messageTimes");
    try {
        f.cache.pass("s")(f.reader, ["m1", "m3"]);
        f.db.exec(
            `UPDATE session_message SET data = '{"time":{"completed":900000}}' WHERE id = 'm1'`,
        );
        f.cache.deleteMessage("s", "m1");
        f.cache.deleteMessage("absent", "m3");
        reads.mockClear();
        const times = f.cache.pass("s")(f.reader, ["m1", "m3"]);
        expect(times.get("m1")?.completed).toBe(900000);
        expect(times.get("m3")?.completed).toBe(1801000);
        expect(reads.mock.calls.flatMap((args) => args[1])).toEqual(["m1"]);
    } finally {
        reads.mockRestore();
        f.cleanup();
    }
});

test("OC2 cached times equal fresh reads across removal, revision, completion and session changes", () => {
    const f = fixture(10);
    try {
        const check = (session = "s", ids = f.ids) => {
            expect(f.cache.pass(session)(f.reader, ids)).toEqual(
                f.reader.messageTimes(session, ids),
            );
        };
        check();
        f.db.exec("DELETE FROM session_message WHERE id IN ('m0','m1')");
        // Keep stale draft ids: membership, not just the draft, must reject them.
        check();
        expect(f.cache.pass("s")(f.reader, f.ids).has("m1")).toBe(false);
        f.db.exec(`UPDATE session_message SET time_created = 987654, time_updated = 1,
            data = '{"time":{"completed":987999}}' WHERE id = 'm3'`);
        check();
        f.db.exec(
            `UPDATE session_message SET time_updated = 2, data = '{"time":{}}' WHERE id = 'm3'`,
        );
        check();
        f.db.exec(
            `UPDATE session_message SET time_updated = 3, data = '{"time":{"completed":988000}}' WHERE id = 'm3'`,
        );
        check();
        check("other");
        check();
        f.db.exec("UPDATE session_message SET seq = 1000 WHERE id = 'm3'");
        check();
        const times = f.cache.pass("s")(f.reader, f.ids);
        times.get("m3")!.completed = -1;
        check();
        check("s", ["m3"]);
        check();
        f.cache.delete("s");
        check();
        f.cache.clear();
        check();
    } finally {
        f.cleanup();
    }
});
