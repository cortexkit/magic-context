import { expect, test } from "bun:test";
import { join } from "node:path";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { resetReusableWorkersForTests } from "../../shared/reusable-worker";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { resetRawSessionOrdinalWarmupsForTest, runSessionWarmupWorker } from "./raw-ordinal-warmup";

test("queued indexing does not spend its startup deadline before dispatch", async () => {
    const { dir, cleanup } = createTestTempDir("raw-index-pool-");
    const path = join(dir, "fixture.db");
    const db = new Database(path);
    const coordination = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
    Atomics.store(coordination, 0, 1);
    let release: ReturnType<typeof setTimeout> | undefined;
    try {
        initializeDatabase(db);
        const first = runSessionWarmupWorker(
            {
                path,
                sessionId: "index-pool",
                harness: "opencode",
                indexMessage: {
                    id: "first",
                    ordinal: 1,
                    role: "user",
                    parts: [{ type: "text", text: "first source" }],
                },
                indexCoordination: coordination.buffer,
                indexOwner: 1,
            },
            { acceptMs: 5_000, resultMs: 5_000 },
        );
        const queued = runSessionWarmupWorker(
            {
                path,
                sessionId: "index-pool",
                harness: "opencode",
                indexMessage: {
                    id: "queued",
                    ordinal: 2,
                    role: "user",
                    parts: [{ type: "text", text: "queued source" }],
                },
                indexCoordination: coordination.buffer,
                indexOwner: 2,
            },
            { acceptMs: 200, resultMs: 5_000 },
        );
        release = setTimeout(() => {
            Atomics.store(coordination, 0, 0);
            Atomics.notify(coordination, 0);
        }, 500);
        const [firstResult, queuedResult] = await Promise.all([first, queued]);
        expect(firstResult).toMatchObject({ inserted: true });
        expect(queuedResult).toMatchObject({ inserted: true });
        expect(
            db.prepare("SELECT message_id FROM message_history_fts ORDER BY message_id").all(),
        ).toEqual([{ message_id: "first" }, { message_id: "queued" }]);
    } finally {
        clearTimeout(release);
        Atomics.store(coordination, 0, 0);
        resetRawSessionOrdinalWarmupsForTest();
        await resetReusableWorkersForTests();
        db.close();
        cleanup();
    }
});

test("different raw job kinds cannot queue behind an index writer", async () => {
    const { dir, cleanup } = createTestTempDir("raw-index-kinds-");
    const path = join(dir, "fixture.db");
    const db = new Database(path);
    const coordination = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
    Atomics.store(coordination, 0, 1);
    try {
        initializeDatabase(db);
        let writerSettled = false;
        const writer = runSessionWarmupWorker(
            {
                path,
                sessionId: "index-kinds",
                harness: "opencode",
                indexMessage: {
                    id: "writer",
                    ordinal: 1,
                    role: "user",
                    parts: [{ type: "text", text: "writer source" }],
                },
                indexCoordination: coordination.buffer,
                indexOwner: 1,
            },
            { acceptMs: 5_000, resultMs: 1_000 },
        ).then((result) => {
            writerSettled = true;
            return result;
        });
        const backfill = await runSessionWarmupWorker(
            { path, sessionId: "", harness: "opencode", ftsRowidBackfill: true },
            { acceptMs: 5_000, resultMs: 5_000 },
        );
        expect(backfill).toMatchObject({ ftsRowidBackfill: true });
        expect(writerSettled).toBe(false);
        Atomics.store(coordination, 0, 0);
        Atomics.notify(coordination, 0);
        expect(await writer).toMatchObject({ inserted: true });
    } finally {
        Atomics.store(coordination, 0, 0);
        resetRawSessionOrdinalWarmupsForTest();
        await resetReusableWorkersForTests();
        db.close();
        cleanup();
    }
});
