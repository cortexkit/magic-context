/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

let queryEmbedding: Float32Array | null = null;
const embeddingQueries: string[] = [];
const rawMessagesBySession = new Map<
    string,
    Array<{ ordinal: number; id: string; role: string; parts: unknown[] }>
>();

import { replaceSessionFacts } from "./compartment-storage";
import { getMemoryById, insertMemory, resetEmbeddingCacheForTests, saveEmbedding } from "./memory";
import { unifiedSearch } from "./search";
import { initializeDatabase } from "./storage-db";

const readMessages = (sessionId: string) => rawMessagesBySession.get(sessionId) ?? [];
const embedQuery = async (text: string) => {
    embeddingQueries.push(text);
    return queryEmbedding ? new Float32Array(queryEmbedding) : null;
};
const isEmbeddingRuntimeEnabled = () => true;

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    return db;
}

afterEach(() => {
    queryEmbedding = null;
    embeddingQueries.length = 0;
    rawMessagesBySession.clear();
    resetEmbeddingCacheForTests();
});

describe("unifiedSearch", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        db.close(false);
    });

    it("returns ranked results across memories, facts, and messages", async () => {
        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "Magic context stores ranked search data in SQLite.",
        });
        saveEmbedding(db, memory.id, new Float32Array([1, 0]), "mock:model");
        queryEmbedding = new Float32Array([1, 0]);

        replaceSessionFacts(db, "ses-1", [
            {
                category: "WORKFLOW_RULES",
                content: "ctx_search should prefer memory results first.",
            },
        ]);

        rawMessagesBySession.set("ses-1", [
            {
                ordinal: 1,
                id: "m1",
                role: "user",
                parts: [{ type: "text", text: "Can you add ranked search across the history?" }],
            },
            {
                ordinal: 2,
                id: "m2",
                role: "assistant",
                parts: [
                    {
                        type: "text",
                        text: "I will implement message history indexing for ranked search.",
                    },
                ],
            },
        ]);

        const results = await unifiedSearch(db, "ses-1", "/repo/project", "ranked search", {
            limit: 5,
            memoryEnabled: true,
            embeddingEnabled: true,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
        });

        expect(results).toHaveLength(4);
        const sources = results.map((r) => r.source);
        expect(sources).toContain("memory");
        expect(sources).toContain("fact");
        expect(sources).toContain("message");
        // With boost-based ranking, sources interleave by effective score (score * boost)
        // rather than strict priority ordering
        const messageResults = results.filter((r) => r.source === "message");
        expect(messageResults).toHaveLength(2);
        expect(embeddingQueries).toEqual(["ranked search"]);
        expect(getMemoryById(db, memory.id)?.retrievalCount).toBe(1);
    });

    it("indexes only meaningful text messages and updates incrementally", async () => {
        rawMessagesBySession.set("ses-2", [
            {
                ordinal: 1,
                id: "u1",
                role: "user",
                parts: [
                    {
                        type: "text",
                        text: "<system-reminder>ignore</system-reminder> Search this ticket",
                    },
                ],
            },
            {
                ordinal: 2,
                id: "tool-1",
                role: "assistant",
                parts: [{ type: "tool-call", name: "ctx_note" }],
            },
            {
                ordinal: 3,
                id: "a1",
                role: "assistant",
                parts: [{ type: "text", text: "Ticket search is now indexed." }],
            },
        ]);

        let results = await unifiedSearch(db, "ses-2", "/repo/project", "ticket", {
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
        });

        expect(results.filter((result) => result.source === "message")).toHaveLength(2);

        rawMessagesBySession.set("ses-2", [
            ...(rawMessagesBySession.get("ses-2") ?? []),
            {
                ordinal: 4,
                id: "a2",
                role: "assistant",
                parts: [{ type: "text", text: "The indexed ticket search now supports history." }],
            },
        ]);

        results = await unifiedSearch(db, "ses-2", "/repo/project", "supports history", {
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
        });

        const messageResults = results.filter(
            (result): result is Extract<(typeof results)[number], { source: "message" }> =>
                result.source === "message",
        );
        expect(messageResults).toHaveLength(1);
        expect(messageResults[0]?.messageOrdinal).toBe(4);
    });

    it("returns empty results for blank queries or missing sessions", async () => {
        expect(
            await unifiedSearch(db, "ses-empty", "/repo/project", "   ", {
                memoryEnabled: true,
                embeddingEnabled: true,
                readMessages,
                embedQuery,
                isEmbeddingRuntimeEnabled,
            }),
        ).toEqual([]);

        expect(
            await unifiedSearch(db, "ses-empty", "/repo/project", "nothing", {
                memoryEnabled: false,
                embeddingEnabled: false,
                readMessages,
                embedQuery,
                isEmbeddingRuntimeEnabled,
            }),
        ).toEqual([]);
    });

    it("falls back to full semantic search when FTS finds no matches", async () => {
        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "alpha beta gamma",
        });
        saveEmbedding(db, memory.id, new Float32Array([0, 1]), "mock:model");
        queryEmbedding = new Float32Array([0, 1]);

        const results = await unifiedSearch(
            db,
            "ses-semantic",
            "/repo/project",
            "vector-only query",
            {
                limit: 5,
                memoryEnabled: true,
                embeddingEnabled: true,
                readMessages,
                embedQuery,
                isEmbeddingRuntimeEnabled,
            },
        );

        const memoryResults = results.filter(
            (result): result is Extract<(typeof results)[number], { source: "memory" }> =>
                result.source === "memory",
        );

        expect(memoryResults).toHaveLength(1);
        expect(memoryResults[0]?.memoryId).toBe(memory.id);
        expect(memoryResults[0]?.matchType).toBe("semantic");
    });
});
