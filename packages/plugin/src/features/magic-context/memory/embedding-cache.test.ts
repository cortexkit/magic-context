/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { initializeDatabase } from "../storage-db";
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
    it("reloads pj- project embeddings when that project's epoch changes", () => {
        db = createTestDb();
        const projectPath = "pj-embedding-cache";
        const memory = insertMemory(db, {
            projectPath,
            category: "ARCHITECTURE_DECISIONS",
            content: "Reload vectors after a dashboard edit.",
        });
        saveEmbedding(db, memory.id, new Float32Array([1, 0]), "mock:model");
        const initial = getProjectEmbeddings(db, projectPath, "mock:model");
        expect(toNumbers(initial.get(memory.id))).toEqual([1, 0]);

        saveEmbedding(db, memory.id, new Float32Array([0, 1]), "mock:model");
        expect(getProjectEmbeddings(db, projectPath, "mock:model")).toBe(initial);
        db.prepare(
            "INSERT INTO project_state (project_path, project_memory_epoch) VALUES (?, 1)",
        ).run(projectPath);

        const reloaded = getProjectEmbeddings(db, projectPath, "mock:model");
        expect(reloaded).not.toBe(initial);
        expect(toNumbers(reloaded.get(memory.id))).toEqual([0, 1]);
    });

    it("reloads project embeddings after TTL expiry", async () => {
        db = createTestDb();
        setEmbeddingCacheTtlForTests(10);

        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "Cache embeddings for memory search.",
        });

        saveEmbedding(db, memory.id, new Float32Array([1, 0]), "mock:model");

        const initial = getProjectEmbeddings(db, "/repo/project", "mock:model");
        expect(toNumbers(initial.get(memory.id))).toEqual([1, 0]);

        saveEmbedding(db, memory.id, new Float32Array([0, 1]), "mock:model");

        const beforeExpiry = getProjectEmbeddings(db, "/repo/project", "mock:model");
        expect(toNumbers(beforeExpiry.get(memory.id))).toEqual([1, 0]);

        await Bun.sleep(20);

        const afterExpiry = getProjectEmbeddings(db, "/repo/project", "mock:model");
        expect(toNumbers(afterExpiry.get(memory.id))).toEqual([0, 1]);
    });
});
