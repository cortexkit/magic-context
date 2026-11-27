/// <reference types="bun-types" />

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, type Statement } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { initializeDatabase } from "../storage-db";
import { keepWorkerMemoryEmbeddings, maintainKeptWorkerMemoryEmbeddings } from "./embedding-cache";
import {
    getProjectEmbeddings,
    resetEmbeddingCacheForTests,
    saveEmbedding,
    setEmbeddingCacheTtlForTests,
} from "./index";
import { insertMemory } from "./storage-memory";

let db: Database | null = null;

function createTestDb(): Database {
    const database = new Database(":memory:");
    initializeDatabase(database);
    return database;
}

function toNumbers(embedding: { embedding: Float32Array } | undefined): number[] {
    return embedding ? Array.from(embedding.embedding) : [];
}

afterEach(() => {
    resetEmbeddingCacheForTests();
    closeQuietly(db);
    db = null;
});

describe("embedding-cache", () => {
    it("reloads project embeddings after TTL expiry", () => {
        db = createTestDb();
        setEmbeddingCacheTtlForTests(10);

        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "Cache embeddings for memory search.",
        });

        saveEmbedding(db, memory.id, new Float32Array([1, 0]), "mock:model");

        let now = Date.now();
        const clock = spyOn(Date, "now").mockImplementation(() => now);
        try {
            const initial = getProjectEmbeddings(db, "/repo/project", "mock:model");
            expect(toNumbers(initial.get(memory.id))).toEqual([1, 0]);

            saveEmbedding(db, memory.id, new Float32Array([0, 1]), "mock:model");

            const beforeExpiry = getProjectEmbeddings(db, "/repo/project", "mock:model");
            expect(toNumbers(beforeExpiry.get(memory.id))).toEqual([1, 0]);

            now += 10;
            const afterExpiry = getProjectEmbeddings(db, "/repo/project", "mock:model");
            expect(toNumbers(afterExpiry.get(memory.id))).toEqual([0, 1]);
        } finally {
            clock.mockRestore();
        }
    });

    it("sees a second connection's commit immediately after a vector read at the next check", () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "embedding-cache-version-"));
        const path = join(dir, "context.db");
        const writer = new Database(path);
        initializeDatabase(writer);
        const project = "/repo/project";
        const model = "mock:model";
        const memory = insertMemory(writer, {
            projectPath: project,
            category: "ARCHITECTURE_DECISIONS",
            content: "Commit immediately after the vector SELECT.",
        });
        saveEmbedding(writer, memory.id, new Float32Array([1, 0]), model);
        const reader = new Database(path, { readonly: true });
        const originalPrepare = reader.prepare.bind(reader);
        let followingVector: Float32Array | undefined = new Float32Array([0, 1]);
        const prepare = spyOn(reader, "prepare").mockImplementation(((sql: string) => {
            const statement = originalPrepare(sql) as Statement;
            if (sql.includes("SELECT memory_embeddings.memory_id AS memoryId")) {
                const all = statement.all.bind(statement);
                statement.all = (...args: unknown[]) => {
                    const rows = all(...args);
                    if (followingVector) {
                        saveEmbedding(writer, memory.id, followingVector, model);
                        followingVector = undefined;
                    }
                    return rows;
                };
            }
            return statement;
        }) as typeof reader.prepare);
        let now = Date.now();
        const clock = spyOn(Date, "now").mockImplementation(() => now);
        try {
            keepWorkerMemoryEmbeddings(reader);
            const vector = () =>
                toNumbers(getProjectEmbeddings(reader, project, model).get(memory.id));
            expect(vector()).toEqual([1, 0]);
            followingVector = new Float32Array([-1, 0]);
            now += 60_000;
            maintainKeptWorkerMemoryEmbeddings(reader);
            expect(vector()).toEqual([0, 1]);
            now += 60_000;
            maintainKeptWorkerMemoryEmbeddings(reader);
            expect(vector()).toEqual([-1, 0]);
        } finally {
            clock.mockRestore();
            prepare.mockRestore();
            reader.close();
            writer.close();
            cleanupTestTempDir(dir);
        }
    });
});
