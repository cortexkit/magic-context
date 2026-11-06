import { expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { stageManualBaseline } from "./manual-baseline";

test("manual baseline staging restores every cache field until admission commits", () => {
    const db = new Database(":memory:");
    try {
        db.exec(`CREATE TABLE session_meta (
            session_id TEXT PRIMARY KEY, cached_m0_bytes TEXT, cached_m1_bytes TEXT,
            cached_m0_last_baseline_end_message_id TEXT, memory_block_ids TEXT,
            memory_block_count INTEGER, last_response_time INTEGER
        ); INSERT INTO session_meta VALUES ('s', 'old head', 'old delta', 'row4', '[]', 0, 1)`);
        const read = () => db.prepare("SELECT * FROM session_meta").get();
        const before = read();
        const staged = stageManualBaseline(db, "s", () => {
            db.exec(
                "UPDATE session_meta SET cached_m0_bytes = 'new head', cached_m1_bytes = 'new delta', cached_m0_last_baseline_end_message_id = 'row12', memory_block_ids = '[42]', memory_block_count = 1",
            );
            return "new head";
        });
        expect(staged.summary).toBe("new head");
        expect(staged.boundaryID).toBe("row12");
        expect(read()).toEqual(before);
        db.exec("UPDATE session_meta SET last_response_time = 2");
        staged.commit();
        expect(read()).toEqual({
            ...(before as object),
            cached_m0_bytes: "new head",
            cached_m1_bytes: "new delta",
            cached_m0_last_baseline_end_message_id: "row12",
            memory_block_ids: "[42]",
            memory_block_count: 1,
            last_response_time: 2,
        });
        const stale = stageManualBaseline(db, "s", () => {
            db.exec("UPDATE session_meta SET cached_m0_bytes = 'stale'");
            return "stale";
        });
        db.exec("UPDATE session_meta SET cached_m0_bytes = 'concurrent request'");
        expect(() => stale.commit()).toThrow("baseline changed during admission");
        expect((read() as { cached_m0_bytes: string }).cached_m0_bytes).toBe("concurrent request");
        const stable = read();
        expect(() =>
            stageManualBaseline(db, "s", () => {
                db.exec("UPDATE session_meta SET cached_m0_bytes = 'partial'");
                throw new Error("render refused");
            }),
        ).toThrow("render refused");
        expect(read()).toEqual(stable);
    } finally {
        db.close();
    }
});
