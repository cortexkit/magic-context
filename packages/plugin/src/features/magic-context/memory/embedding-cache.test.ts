/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
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

function toNumbers(embedding: Float32Array | undefined): number[] {
    return embedding ? Array.from(embedding) : [];
}

afterEach(() => {
    resetEmbeddingCacheForTests();
    db?.close(false);
    db = null;
});

describe("embedding-cache", () => {
    it("reloads project embeddings after TTL expiry", async () => {
        db = createTestDb();
        setEmbeddingCacheTtlForTests(10);

        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "Cache embeddings for memory search.",
        });

        saveEmbedding(db, memory.id, new Float32Array([1, 0]), "mock:model");

        const initial = getProjectEmbeddings(db, "/repo/project");
        expect(toNumbers(initial.get(memory.id))).toEqual([1, 0]);

        saveEmbedding(db, memory.id, new Float32Array([0, 1]), "mock:model");

        const beforeExpiry = getProjectEmbeddings(db, "/repo/project");
        expect(toNumbers(beforeExpiry.get(memory.id))).toEqual([1, 0]);

        await Bun.sleep(20);

        const afterExpiry = getProjectEmbeddings(db, "/repo/project");
        expect(toNumbers(afterExpiry.get(memory.id))).toEqual([0, 1]);
    });
});
