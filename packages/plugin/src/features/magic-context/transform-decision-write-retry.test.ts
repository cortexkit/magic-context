import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { openDatabase } from "./storage-db";
import {
    __test as decisions,
    recordPendingTransformDecision,
    scheduleOpenCodeTransformDecisionWrite,
} from "./transform-decision-log";

// A decision row is written from a queued timer on its own connection with
// busy_timeout=0, so it never blocks the host's event loop. The host also
// writes context.db from worker threads on their own connections (message
// indexing after a completed reply, embeddings), so that write can meet a
// held write lock. Seen on a real OpenCode host: with a second connection
// holding the lock for 30 ms right after the `/ctx-flush` reply completed, the
// write failed with "database is locked" and the rebuild's row was never
// written.

const SESSION = "ses-decision-write-retry";

afterEach(() => decisions.reset());

function stageFlushDecision(): void {
    recordPendingTransformDecision(SESSION, {
        tsMs: 1,
        decision: "defer",
        materialized: true,
        materializeReason: "user_flush",
        systemHashPrev: null,
        systemHashNew: null,
        m0ModelKeyPrev: null,
        m0ModelKeyNew: null,
        emergency: false,
        droppedTokens: 0,
        droppedCount: 1,
        inputTokens: 10_000,
        bustedThisPass: true,
    });
}

async function withLockedStore(
    label: string,
    run: (db: Database, rows: () => string[], release: () => void) => Promise<void>,
): Promise<void> {
    const { dir, cleanup } = createTestTempDir(label);
    const path = join(dir, "context.db");
    const db = openDatabase(path);
    if (!db) throw new Error("throwaway database unavailable");
    // Another connection takes the write lock, as a host worker thread does.
    const blocker = new Database(path);
    blocker.exec("PRAGMA busy_timeout=0");
    blocker.exec("BEGIN IMMEDIATE");
    const release = () => {
        if (blocker.inTransaction) blocker.exec("COMMIT");
    };
    const rows = () =>
        (
            db
                .prepare(
                    "SELECT message_id, materialize_reason FROM transform_decisions WHERE session_id = ?",
                )
                .all(SESSION) as { message_id: string; materialize_reason: string }[]
        ).map((row) => `${row.message_id}:${row.materialize_reason}`);
    try {
        await run(db, rows, release);
    } finally {
        release();
        blocker.close();
        db.close();
        cleanup();
    }
}

test("a decision row that meets another connection's write lock is written once the lock is released", async () => {
    await withLockedStore("mc-decision-retry-", async (db, rows, release) => {
        stageFlushDecision();
        expect(
            scheduleOpenCodeTransformDecisionWrite({
                db,
                sessionId: SESSION,
                messageId: "msg_flush",
                inputTokens: 10_000,
            }),
        ).toBe(true);
        // The queued write and its first retries find the lock still held.
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(rows()).toEqual([]);

        release();
        await decisions.waitForWrites(SESSION);
        expect(rows()).toEqual(["msg_flush:user_flush"]);
    });
});

test("a decision row whose write lock is never released is dropped after the retries, without blocking", async () => {
    await withLockedStore("mc-decision-retry-exhausted-", async (db, rows) => {
        stageFlushDecision();
        scheduleOpenCodeTransformDecisionWrite({
            db,
            sessionId: SESSION,
            messageId: "msg_flush",
            inputTokens: 10_000,
        });
        const started = performance.now();
        const settled = await Promise.race([
            decisions.waitForWrites(SESSION).then(() => "settled"),
            new Promise((resolve) => setTimeout(() => resolve("still retrying"), 5_000)),
        ]);
        expect(settled).toBe("settled");
        // The retries stop after about two seconds rather than waiting on the lock.
        expect(performance.now() - started).toBeLessThan(4_000);
        expect(rows()).toEqual([]);
    });
}, 10_000);
