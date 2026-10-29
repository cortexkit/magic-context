import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import {
    computeOpenCodeWorkMetrics,
    computeOpenCodeWorkMetricsIncremental,
    computePiWorkMetrics,
    emptyWorkMetricsCarry,
} from "./work-metrics";

function createOpenCodeFixture(): Database {
    const db = new Database(":memory:");
    // id auto-fills in insertion order; the oracle SQL orders by (time_created, id),
    // so unique timestamps keep insertion order here.
    db.exec(
        "CREATE TABLE message (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, time_created INTEGER, data TEXT)",
    );
    return db;
}

function insertAssistant(
    db: Database,
    sessionId: string,
    time: number,
    agent: string,
    input: number,
    output: number,
    cacheRead = 0,
    cacheWrite = 0,
): void {
    db.prepare("INSERT INTO message (session_id, time_created, data) VALUES (?, ?, ?)").run(
        sessionId,
        time,
        JSON.stringify({
            role: "assistant",
            agent,
            tokens: { input, output, cache: { read: cacheRead, write: cacheWrite } },
        }),
    );
}

describe("work metrics", () => {
    test("computes linear growth", () => {
        const db = createOpenCodeFixture();
        insertAssistant(db, "ses", 1, "build", 100, 10);
        insertAssistant(db, "ses", 2, "build", 150, 20);
        expect(computeOpenCodeWorkMetrics(db, "ses")).toEqual({
            newWorkTokens: 170,
            totalInputTokens: 150,
        });
    });

    test("clamps execute drops and sums phase peaks", () => {
        const db = createOpenCodeFixture();
        insertAssistant(db, "ses", 1, "build", 100, 1);
        insertAssistant(db, "ses", 2, "build", 200, 2);
        insertAssistant(db, "ses", 3, "build", 80, 3);
        insertAssistant(db, "ses", 4, "build", 120, 4);
        expect(computeOpenCodeWorkMetrics(db, "ses")).toEqual({
            newWorkTokens: 244,
            totalInputTokens: 320,
        });
    });

    test("partitions by agent", () => {
        const db = createOpenCodeFixture();
        insertAssistant(db, "ses", 1, "a", 100, 10);
        insertAssistant(db, "ses", 2, "b", 500, 20);
        insertAssistant(db, "ses", 3, "a", 150, 30);
        expect(computeOpenCodeWorkMetrics(db, "ses")).toEqual({
            newWorkTokens: 700,
            totalInputTokens: 650,
        });
    });

    test("empty sessions are zero", () => {
        const db = createOpenCodeFixture();
        expect(computeOpenCodeWorkMetrics(db, "missing")).toEqual({
            newWorkTokens: 0,
            totalInputTokens: 0,
        });
    });

    test("Pi metrics mirror the delta and phase-peak logic", () => {
        expect(
            computePiWorkMetrics([
                {
                    role: "assistant",
                    usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0 },
                },
                {
                    role: "assistant",
                    usage: { input: 200, output: 2, cacheRead: 0, cacheWrite: 0 },
                },
                { role: "assistant", usage: { input: 80, output: 3, cacheRead: 0, cacheWrite: 0 } },
                {
                    role: "assistant",
                    usage: { input: 120, output: 4, cacheRead: 0, cacheWrite: 0 },
                },
            ]),
        ).toEqual({ newWorkTokens: 244, totalInputTokens: 320 });
    });

    test("OpenCode 2 folds assistant usage in seq order and refreshes the streaming tail", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`CREATE TABLE session_message (
                id TEXT PRIMARY KEY, session_id TEXT, type TEXT,
                seq INTEGER, time_created INTEGER, data TEXT
            )`);
            const insert = db.prepare(
                "INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)",
            );
            const usage = (input: number, output: number) =>
                JSON.stringify({
                    agent: "build",
                    tokens: { input, output, cache: { read: 20, write: 10 } },
                });
            insert.run("m1", "ses", "assistant", 1, 300, usage(70, 1));
            insert.run("m2", "ses", "assistant", 2, 200, usage(170, 2));
            insert.run("m3", "ses", "assistant", 3, null, usage(50, 3));
            insert.run("m4", "ses", "assistant", 4, 100, usage(90, 4));
            insert.run("user", "ses", "user", 5, 500, usage(10_000, 100));
            insert.run("other", "other-session", "assistant", 6, 600, usage(10_000, 100));

            const first = computeOpenCodeWorkMetricsIncremental(
                db,
                "ses",
                emptyWorkMetricsCarry(),
                "v2",
            );
            // Prompt phases are [100, 200] and [80, 120]: peaks 200 + 120,
            // positive deltas 100 + 100 + 40, plus the last output 4.
            expect(first.metrics).toEqual({ newWorkTokens: 244, totalInputTokens: 320 });
            expect(first.carry.lastTimeCreated).toBe(3);

            db.prepare("UPDATE session_message SET data = ? WHERE id = 'm4'").run(usage(100, 5));
            const second = computeOpenCodeWorkMetricsIncremental(db, "ses", first.carry, "v2");
            expect(second.metrics).toEqual({ newWorkTokens: 255, totalInputTokens: 330 });

            insert.run("m5", "ses", "assistant", 7, null, usage(130, 6));
            const third = computeOpenCodeWorkMetricsIncremental(db, "ses", second.carry, "v2");
            expect(third.metrics).toEqual({ newWorkTokens: 286, totalInputTokens: 360 });
            expect(third.carry.lastTimeCreated).toBe(4);
            expect(
                computeOpenCodeWorkMetricsIncremental(db, "ses", third.carry, "v2").metrics,
            ).toEqual(third.metrics);
        } finally {
            db.close();
        }
    });

    // ── Incremental (watermark) fold ──────────────────────────────────────
    // The incremental driver must produce byte-identical results to the
    // window-function oracle, while only ever folding rows past its watermark.

    function createIncrementalFixture(): Database {
        const db = new Database(":memory:");
        db.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
        return db;
    }

    function insertWithId(
        db: Database,
        id: string,
        sessionId: string,
        time: number,
        agent: string,
        input: number,
        output: number,
    ): void {
        db.prepare(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
        ).run(
            id,
            sessionId,
            time,
            JSON.stringify({ role: "assistant", agent, tokens: { input, output } }),
        );
    }

    test("incremental cold start equals the window-function oracle", () => {
        const db = createIncrementalFixture();
        insertWithId(db, "m1", "ses", 1, "build", 100, 1);
        insertWithId(db, "m2", "ses", 2, "build", 200, 2);
        insertWithId(db, "m3", "ses", 3, "build", 80, 3);
        insertWithId(db, "m4", "ses", 4, "build", 120, 4);
        insertWithId(db, "m5", "ses", 5, "a", 500, 9);

        const oracle = computeOpenCodeWorkMetrics(db, "ses");
        const { metrics } = computeOpenCodeWorkMetricsIncremental(
            db,
            "ses",
            emptyWorkMetricsCarry(),
        );
        expect(metrics).toEqual(oracle);
    });

    test("incremental resume across polls equals a single full scan", () => {
        const db = createIncrementalFixture();
        insertWithId(db, "m1", "ses", 1, "build", 100, 1);
        insertWithId(db, "m2", "ses", 2, "build", 200, 2);

        const carry = emptyWorkMetricsCarry();
        const first = computeOpenCodeWorkMetricsIncremental(db, "ses", carry);
        expect(first.metrics).toEqual(computeOpenCodeWorkMetrics(db, "ses"));

        // New turns arrive; a second poll must fold only the new rows.
        insertWithId(db, "m3", "ses", 3, "build", 80, 3);
        insertWithId(db, "m4", "ses", 4, "build", 120, 4);
        const second = computeOpenCodeWorkMetricsIncremental(db, "ses", first.carry);
        expect(second.metrics).toEqual(computeOpenCodeWorkMetrics(db, "ses"));
    });

    test("most-recent row stays volatile until a newer row supersedes it", () => {
        // Mirrors OpenCode writing a row at stream start then finalizing tokens:
        // a poll mid-stream then a poll after finalize must both equal the oracle.
        const db = createIncrementalFixture();
        insertWithId(db, "m1", "ses", 1, "build", 100, 5);
        insertWithId(db, "m2", "ses", 2, "build", 0, 0); // freshly-created, not yet finalized

        const carry = emptyWorkMetricsCarry();
        const midStream = computeOpenCodeWorkMetricsIncremental(db, "ses", carry);
        expect(midStream.metrics).toEqual(computeOpenCodeWorkMetrics(db, "ses"));

        // Finalize the last row's tokens; the held-back row must re-fold fresh.
        db.prepare("UPDATE message SET data = ? WHERE id = ?").run(
            JSON.stringify({
                role: "assistant",
                agent: "build",
                tokens: { input: 250, output: 7 },
            }),
            "m2",
        );
        const finalized = computeOpenCodeWorkMetricsIncremental(db, "ses", midStream.carry);
        expect(finalized.metrics).toEqual(computeOpenCodeWorkMetrics(db, "ses"));
    });

    test("idle re-poll with no new rows is stable", () => {
        const db = createIncrementalFixture();
        insertWithId(db, "m1", "ses", 1, "build", 100, 1);
        insertWithId(db, "m2", "ses", 2, "build", 150, 2);
        const carry = emptyWorkMetricsCarry();
        const a = computeOpenCodeWorkMetricsIncremental(db, "ses", carry);
        const b = computeOpenCodeWorkMetricsIncremental(db, "ses", a.carry);
        expect(b.metrics).toEqual(a.metrics);
        expect(b.metrics).toEqual(computeOpenCodeWorkMetrics(db, "ses"));
    });

    test("same-timestamp rows: oracle SQL and incremental fold agree on (time_created, id) order", () => {
        // Rows sharing a time_created must be ordered deterministically by id in
        // BOTH paths, or the LAG/phase windows diverge from the fold. Insert out
        // of id order at a single timestamp to exercise the tiebreaker.
        const db = createIncrementalFixture();
        insertWithId(db, "m3", "ses", 5, "build", 80, 3);
        insertWithId(db, "m1", "ses", 5, "build", 100, 1);
        insertWithId(db, "m4", "ses", 5, "build", 120, 4);
        insertWithId(db, "m2", "ses", 5, "build", 200, 2);

        const oracle = computeOpenCodeWorkMetrics(db, "ses");
        const { metrics } = computeOpenCodeWorkMetricsIncremental(
            db,
            "ses",
            emptyWorkMetricsCarry(),
        );
        // The fold reads rows ORDER BY time_created, id → m1(100) m2(200) m3(80) m4(120).
        // deltas: 100 + 100 + 0 + 40 = 240; +lastOutput 4 = 244. peaks: 200 + 120 = 320.
        expect(oracle).toEqual({ newWorkTokens: 244, totalInputTokens: 320 });
        expect(metrics).toEqual(oracle);
    });

    test("same-timestamp resume across polls equals a full scan", () => {
        // A watermark landing mid-tie must resume correctly: split a tied-ts
        // group across two polls and confirm the second poll matches the oracle.
        const db = createIncrementalFixture();
        insertWithId(db, "m1", "ses", 5, "build", 100, 1);
        insertWithId(db, "m2", "ses", 5, "build", 200, 2);
        const carry = emptyWorkMetricsCarry();
        const first = computeOpenCodeWorkMetricsIncremental(db, "ses", carry);
        expect(first.metrics).toEqual(computeOpenCodeWorkMetrics(db, "ses"));

        insertWithId(db, "m3", "ses", 5, "build", 80, 3);
        insertWithId(db, "m4", "ses", 5, "build", 120, 4);
        const second = computeOpenCodeWorkMetricsIncremental(db, "ses", first.carry);
        expect(second.metrics).toEqual(computeOpenCodeWorkMetrics(db, "ses"));
    });
});
