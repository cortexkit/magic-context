import { expect, test } from "bun:test";
import { on, once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { saveEmbedding } from "../../features/magic-context/memory/storage-memory-embeddings";
import { runMigrations } from "../../features/magic-context/migrations";
import type { UnifiedSearchResult } from "../../features/magic-context/search";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { WORKER_CLOSE_MESSAGE } from "../../shared/worker-shutdown";
import type { AutoSearchWorkerInput, AutoSearchWorkerReply } from "./auto-search-worker-client";

const projectPath = "/synthetic";
const model = "test-model";
const queryVector = new Float32Array([1, 0]);
const opposite = new Float32Array([-1, 0]);
const minute = 60_000;

type Result = Extract<UnifiedSearchResult, { source: "memory" }>;

function addMemory(db: Database, content: string): number {
    const now = Date.now();
    const inserted = db
        .prepare(`INSERT INTO memories
        (project_path,category,importance,content,normalized_hash,first_seen_at,created_at,updated_at,last_seen_at)
        VALUES (?,'ARCHITECTURE',3,?,?,?,?,?,?)`)
        .run(projectPath, content, content, now, now, now, now);
    const id = Number(inserted.lastInsertRowid);
    saveEmbedding(db, id, queryVector, model);
    return id;
}

async function withWorker(
    use: (context: {
        db: Database;
        first: number;
        archived: number;
        advance(ms: number, upkeep?: boolean): Promise<void>;
        search(): Promise<Result[]>;
        loads(): number;
    }) => Promise<void>,
) {
    const dir = createTestTempDirFromPath(join(tmpdir(), "auto-search-memory-"));
    const path = join(dir, "context.db");
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    const first = addMemory(db, "first semantic record");
    const archived = addMemory(db, "soon archived semantic record");
    const input: AutoSearchWorkerInput = {
        jobId: 1,
        job: "search",
        persistent: true,
        path,
        harness: "opencode",
        sessionId: "session",
        projectPath,
        query: "historian cache wiring",
        options: {
            sources: ["memory"],
            autoHint: true,
            memoryEnabled: true,
            embeddingEnabled: true,
            embeddingModelIdOverride: model,
        },
        embeddingRuntimeEnabled: true,
        embeddingHostBusy: false,
        snapshot: undefined,
    };
    const worker = new Worker(new URL("./auto-search-worker-probe.fixture.ts", import.meta.url), {
        workerData: { ...input, virtualUpkeep: true },
    });
    const exit = once(worker, "exit");
    const inbox = on(worker, "message");
    let jobId = 0;
    let loadCount = 0;
    async function waitFor(kind: "clock" | "result") {
        for (;;) {
            const { value, done } = await inbox.next();
            if (done) throw new Error(`worker exited without ${kind}`);
            const [message] = value as [AutoSearchWorkerReply | { kind: "clock" | "memory-load" }];
            if (message.kind === "query") {
                worker.postMessage({ jobId: message.jobId, id: message.id, result: queryVector });
            } else if (message.kind === "error") {
                throw new Error(message.error);
            } else if (message.kind === "memory-load") {
                loadCount++;
            } else if (message.kind === kind) {
                return message;
            }
        }
    }
    try {
        await use({
            db,
            first,
            archived,
            async advance(ms, upkeep = true) {
                worker.postMessage({ kind: "clock", advance: ms, upkeep });
                await waitFor("clock");
            },
            async search() {
                if (++jobId > 1) worker.postMessage({ kind: "run", input: { ...input, jobId } });
                const reply = await waitFor("result");
                if (reply.kind !== "result") throw new Error("expected search result");
                return reply.results.filter(
                    (result): result is Result => result.source === "memory",
                );
            },
            loads: () => loadCount,
        });
    } finally {
        await inbox.return?.();
        worker.postMessage(WORKER_CLOSE_MESSAGE);
        await exit;
        db.close();
        cleanupTestTempDir(dir);
    }
}

test("a kept worker does not reload unchanged memory vectors after two minutes", async () => {
    await withWorker(async ({ search, advance, loads }) => {
        const first = await search();
        expect(first).toHaveLength(2);
        expect(loads()).toBe(1);
        await advance(2 * minute);
        expect(await search()).toEqual(first);
        expect(loads()).toBe(1);
    });
});

test("the next upkeep after a minute reloads vectors for inserted, changed and archived memories", async () => {
    await withWorker(async ({ db, first, archived, search, advance, loads }) => {
        expect((await search()).map((r) => r.memoryId)).toEqual([first, archived]);
        const added = addMemory(db, "new semantic record");
        saveEmbedding(db, first, opposite, model);
        db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(archived);
        await advance(2 * minute);
        expect(loads()).toBe(2);
        expect((await search()).map((r) => r.memoryId)).toEqual([added]);
        expect(loads()).toBe(2);
        saveEmbedding(db, first, queryVector, model);
        await advance(minute - 1);
        expect(loads()).toBe(2);
        await advance(1);
        expect(loads()).toBe(3);
        expect((await search()).map((r) => r.memoryId)).toEqual([first, added]);
    });
});

test("a recent memory-vector load keeps the release's staleness allowance", async () => {
    await withWorker(async ({ db, first, archived, search, advance, loads }) => {
        const before = await search();
        expect(before.map((r) => r.memoryId)).toEqual([first, archived]);
        saveEmbedding(db, first, opposite, model);
        await advance(minute - 1);
        expect(await search()).toEqual(before);
        expect(loads()).toBe(1);
        await advance(2, false);
        expect((await search()).map((r) => r.memoryId)).toEqual([archived]);
        expect(loads()).toBe(2);
    });
});
