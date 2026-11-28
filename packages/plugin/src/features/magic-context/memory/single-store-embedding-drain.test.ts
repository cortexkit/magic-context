/// <reference types="bun-types" />

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    embedUnembeddedMemoriesForProject,
    getProjectEmbeddingSnapshot,
    registerProjectEmbedding,
} from "../project-embedding-registry";
import { initializeDatabase } from "../storage-db";
import type { EmbeddingProvider, EmbeddingPurpose } from "./embedding-provider";
import {
    drainSingleStoreEmbeddingWatermarks,
    getPendingEmbeddingWatermarks,
} from "./single-store-embedding-drain";
import { insertMemory, updateMemoryStatus } from "./storage-memory";
import { loadAllEmbeddings, saveEmbedding } from "./storage-memory-embeddings";

function openDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function seedWatermark(db: Database, projectPath: string, written: number, embedded: number): void {
    db.prepare(
        `INSERT INTO memory_embedding_watermarks
            (project_path, written_memory_id, embedded_memory_id, updated_at)
         VALUES (?, ?, ?, 0)`,
    ).run(projectPath, written, embedded);
}

describe("single-store embedding drain", () => {
    test("a project with nothing written past the embedded mark is not pending", () => {
        const db = openDb();
        try {
            seedWatermark(db, "git:caught-up", 40, 40);
            seedWatermark(db, "git:behind", 40, 12);

            expect(getPendingEmbeddingWatermarks(db).map((row) => row.project_path)).toEqual([
                "git:behind",
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("a database without the watermark table has nothing to drain", async () => {
        const db = openDb();
        try {
            db.exec("DROP TABLE memory_embedding_watermarks");
            // An older database predates the module writer too, so an absent table means
            // "no module-written rows", not a failure to report.
            expect(getPendingEmbeddingWatermarks(db)).toEqual([]);
            expect(await drainSingleStoreEmbeddingWatermarks(db)).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("a project with embedding disabled keeps its mark, so enabling it later still finds the rows", async () => {
        const db = openDb();
        try {
            // No embedding provider is registered for this project, so nothing can be
            // embedded yet. That is not the same as nothing being left to embed: the mark
            // stays, and costs one in-memory lookup per drain until a provider appears.
            seedWatermark(db, "git:no-provider", 7, 0);

            expect(await drainSingleStoreEmbeddingWatermarks(db)).toBe(0);

            expect(getPendingEmbeddingWatermarks(db).map((row) => row.project_path)).toEqual([
                "git:no-provider",
            ]);
            expect(
                db
                    .prepare(
                        "SELECT embedded_memory_id FROM memory_embedding_watermarks WHERE project_path = 'git:no-provider'",
                    )
                    .get(),
            ).toEqual({ embedded_memory_id: 0 });
        } finally {
            closeQuietly(db);
        }
    });

    test("draining an empty watermark table does no work", async () => {
        const db = openDb();
        try {
            expect(await drainSingleStoreEmbeddingWatermarks(db)).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });
});

/** A provider that is configured and loaded, and fails while `failing` is set: an outage. */
class OutageProvider implements EmbeddingProvider {
    readonly modelId = "drain-model";
    static failing = true;

    async initialize(): Promise<boolean> {
        return true;
    }

    async embed(text: string, _signal?: AbortSignal, _purpose?: EmbeddingPurpose) {
        if (OutageProvider.failing) throw new Error("embedding provider is down");
        return new Float32Array([text.length, 1]);
    }

    async embedBatch(texts: string[], _signal?: AbortSignal, _purpose?: EmbeddingPurpose) {
        if (OutageProvider.failing) throw new Error("embedding provider is down");
        return texts.map((text) => new Float32Array([text.length, 1]));
    }

    async dispose(): Promise<void> {}

    isLoaded(): boolean {
        return true;
    }
}

describe("single-store embedding drain under a provider outage", () => {
    const PROJECT = "git:single-store-outage";

    afterEach(() => {
        OutageProvider.failing = true;
        _resetProjectEmbeddingRegistryForTests();
    });

    function seedModuleWrittenMemories(db: Database, count: number): number[] {
        const ids = Array.from(
            { length: count },
            (_, index) =>
                insertMemory(db, {
                    projectPath: PROJECT,
                    category: "ARCHITECTURE",
                    content: `a module-written memory number ${index}`,
                }).id,
        );
        _setTestProviderFactoryForProject(() => new OutageProvider());
        registerProjectEmbedding(
            db,
            PROJECT,
            { provider: "local", model: "drain-model" },
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/single-store-drain-outage",
        );
        seedWatermark(db, PROJECT, Math.max(...ids), 0);
        return ids;
    }

    function unembedded(db: Database): number {
        return (
            db
                .prepare(
                    `SELECT COUNT(*) AS count FROM memories
                      WHERE project_path = ?
                        AND NOT EXISTS (SELECT 1 FROM memory_embeddings WHERE memory_id = memories.id)`,
                )
                .get(PROJECT) as { count: number }
        ).count;
    }

    test("the drain embeds permanent memories with only an old model before advancing the mark", async () => {
        const db = openDb();
        const embedBatch = spyOn(OutageProvider.prototype, "embedBatch");
        try {
            const id = seedModuleWrittenMemories(db, 1)[0]!;
            updateMemoryStatus(db, id, "permanent");
            saveEmbedding(db, id, new Float32Array([1, 1]), "old-model");
            const modelId = getProjectEmbeddingSnapshot(PROJECT)!.modelId;
            OutageProvider.failing = false;

            expect(getPendingEmbeddingWatermarks(db)).toHaveLength(1);
            expect(loadAllEmbeddings(db, PROJECT, modelId).has(id)).toBe(false);

            const embedded = await drainSingleStoreEmbeddingWatermarks(db);
            expect({
                embedded,
                hasCurrentVector: loadAllEmbeddings(db, PROJECT, modelId).has(id),
                pending: getPendingEmbeddingWatermarks(db).length,
            }).toEqual({ embedded: 1, hasCurrentVector: true, pending: 0 });
            expect(embedBatch).toHaveBeenCalledTimes(1);
        } finally {
            embedBatch.mockRestore();
            closeQuietly(db);
        }
    });

    test("batch selection, remaining work and completion agree on which memories need a vector", async () => {
        const db = openDb();
        const embedBatch = spyOn(OutageProvider.prototype, "embedBatch");
        try {
            const ids = seedModuleWrittenMemories(db, 13);
            const missingIds = ids.slice(0, 11);
            const archivedId = ids[11]!;
            const currentId = ids[12]!;
            const modelId = getProjectEmbeddingSnapshot(PROJECT)!.modelId;
            const currentVector = new Float32Array([2, 2]);
            for (const [index, id] of missingIds.entries()) {
                if (index % 2 === 0) updateMemoryStatus(db, id, "permanent");
                saveEmbedding(db, id, new Float32Array([1, 1]), "old-model");
            }
            updateMemoryStatus(db, archivedId, "archived");
            saveEmbedding(db, currentId, currentVector, modelId);
            OutageProvider.failing = false;

            expect(await drainSingleStoreEmbeddingWatermarks(db)).toBe(10);
            expect(embedBatch).toHaveBeenCalledTimes(1);
            expect(getPendingEmbeddingWatermarks(db)).toHaveLength(1);

            expect(await drainSingleStoreEmbeddingWatermarks(db)).toBe(1);
            expect(getPendingEmbeddingWatermarks(db)).toEqual([]);

            const current = loadAllEmbeddings(db, PROJECT, modelId);
            expect([...current.keys()]).toEqual([...missingIds, currentId]);
            expect(current.has(archivedId)).toBe(false);
            expect(current.get(currentId)?.embedding).toEqual(currentVector);
            expect(await drainSingleStoreEmbeddingWatermarks(db)).toBe(0);
            expect(embedBatch).toHaveBeenCalledTimes(2);
            expect(embedBatch.mock.calls.map(([texts]) => texts.length)).toEqual([10, 1]);
        } finally {
            embedBatch.mockRestore();
            closeQuietly(db);
        }
    });

    test("project maintenance can backfill a permanent memory after the watermark has advanced", async () => {
        const db = openDb();
        const embedBatch = spyOn(OutageProvider.prototype, "embedBatch");
        try {
            const id = seedModuleWrittenMemories(db, 1)[0]!;
            updateMemoryStatus(db, id, "permanent");
            saveEmbedding(db, id, new Float32Array([1, 1]), "old-model");
            db.prepare(
                "UPDATE memory_embedding_watermarks SET embedded_memory_id = written_memory_id WHERE project_path = ?",
            ).run(PROJECT);
            const modelId = getProjectEmbeddingSnapshot(PROJECT)!.modelId;
            OutageProvider.failing = false;

            expect(await drainSingleStoreEmbeddingWatermarks(db)).toBe(0);
            expect(embedBatch).toHaveBeenCalledTimes(0);
            expect(loadAllEmbeddings(db, PROJECT, modelId).has(id)).toBe(false);

            expect(await embedUnembeddedMemoriesForProject(db, PROJECT)).toBe(1);
            expect(loadAllEmbeddings(db, PROJECT, modelId).has(id)).toBe(true);
            expect(await embedUnembeddedMemoriesForProject(db, PROJECT)).toBe(0);
            expect(embedBatch).toHaveBeenCalledTimes(1);
        } finally {
            embedBatch.mockRestore();
            closeQuietly(db);
        }
    });

    test("an outage leaves the mark pending, and the drain embeds the rows once the provider is back", async () => {
        const db = openDb();
        try {
            seedModuleWrittenMemories(db, 3);

            OutageProvider.failing = true;
            expect(await drainSingleStoreEmbeddingWatermarks(db)).toBe(0);
            expect(unembedded(db)).toBe(3);
            expect(getPendingEmbeddingWatermarks(db).map((row) => row.project_path)).toEqual([
                PROJECT,
            ]);

            OutageProvider.failing = false;
            expect(await drainSingleStoreEmbeddingWatermarks(db)).toBe(3);
            expect(unembedded(db)).toBe(0);
            expect(getPendingEmbeddingWatermarks(db)).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    test("a range larger than one batch keeps its mark until the last batch lands", async () => {
        const db = openDb();
        try {
            seedModuleWrittenMemories(db, 14);
            OutageProvider.failing = false;

            // The embedder's default batch is ten rows.
            expect(await drainSingleStoreEmbeddingWatermarks(db)).toBe(10);
            expect(getPendingEmbeddingWatermarks(db).map((row) => row.project_path)).toEqual([
                PROJECT,
            ]);

            expect(await drainSingleStoreEmbeddingWatermarks(db)).toBe(4);
            expect(getPendingEmbeddingWatermarks(db)).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });
});
