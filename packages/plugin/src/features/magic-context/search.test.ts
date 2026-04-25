/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";

let queryEmbedding: Float32Array | null = null;
const embeddingQueries: string[] = [];
const rawMessagesBySession = new Map<
    string,
    Array<{ ordinal: number; id: string; role: string; parts: unknown[] }>
>();

import { closeQuietly } from "../../shared/sqlite-helpers";
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
        closeQuietly(db);
    });

    it("returns ranked results across memories and messages (no facts)", async () => {
        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "Magic context stores ranked search data in SQLite.",
        });
        saveEmbedding(db, memory.id, new Float32Array([1, 0]), "mock:model");
        queryEmbedding = new Float32Array([1, 0]);

        // Facts are inserted but should NEVER appear in ctx_search results —
        // they're always rendered in <session-history> so returning them from
        // search is redundant.
        replaceSessionFacts(db, "ses-1", [
            {
                category: "WORKFLOW_RULES",
                content: "ranked search flow.",
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

        expect(results.length).toBeGreaterThan(0);
        const sources = results.map((r) => r.source);
        expect(sources).toContain("memory");
        expect(sources).toContain("message");
        // Facts are NOT a ctx_search source — they're always visible in message[0].
        expect(sources).not.toContain("fact");
        const messageResults = results.filter((r) => r.source === "message");
        expect(messageResults.length).toBeGreaterThan(0);
        expect(embeddingQueries).toEqual(["ranked search"]);
        expect(getMemoryById(db, memory.id)?.retrievalCount).toBe(1);
    });

    it("restricts results to the sources filter", async () => {
        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "Historian uses a compact static system prompt.",
        });
        saveEmbedding(db, memory.id, new Float32Array([1, 0]), "mock:model");
        queryEmbedding = new Float32Array([1, 0]);

        rawMessagesBySession.set("ses-sources", [
            {
                ordinal: 1,
                id: "u1",
                role: "user",
                parts: [{ type: "text", text: "What prompt does the historian agent use?" }],
            },
        ]);

        // Memory-only filter — message hit must be excluded.
        const memoryOnly = await unifiedSearch(
            db,
            "ses-sources",
            "/repo/project",
            "historian prompt",
            {
                memoryEnabled: true,
                embeddingEnabled: true,
                readMessages,
                embedQuery,
                isEmbeddingRuntimeEnabled,
                sources: ["memory"],
            },
        );
        expect(memoryOnly.every((r) => r.source === "memory")).toBe(true);
        expect(memoryOnly.length).toBeGreaterThan(0);

        // Message-only filter — memory hit must be excluded.
        const messageOnly = await unifiedSearch(
            db,
            "ses-sources",
            "/repo/project",
            "historian prompt",
            {
                memoryEnabled: true,
                embeddingEnabled: true,
                readMessages,
                embedQuery,
                isEmbeddingRuntimeEnabled,
                sources: ["message"],
            },
        );
        expect(messageOnly.every((r) => r.source === "message")).toBe(true);
        expect(messageOnly.length).toBeGreaterThan(0);
    });

    it("hard-filters memories listed in visibleMemoryIds", async () => {
        const visible = insertMemory(db, {
            projectPath: "/repo/visible",
            category: "ARCHITECTURE_DECISIONS",
            content: "Keep historian subagent hidden via mode=subagent plus hidden=true.",
        });
        const hidden = insertMemory(db, {
            projectPath: "/repo/visible",
            category: "ARCHITECTURE_DECISIONS",
            content: "Historian child sessions inherit parent variant for cache stability.",
        });
        saveEmbedding(db, visible.id, new Float32Array([1, 0]), "mock:model");
        saveEmbedding(db, hidden.id, new Float32Array([1, 0]), "mock:model");
        queryEmbedding = new Float32Array([1, 0]);

        const results = await unifiedSearch(db, "ses-vis", "/repo/visible", "historian", {
            memoryEnabled: true,
            embeddingEnabled: true,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            visibleMemoryIds: new Set([visible.id]),
            sources: ["memory"],
        });

        // The already-visible memory must not be returned even though it
        // would otherwise rank identically with the other candidate.
        const ids = results
            .filter((r) => r.source === "memory")
            .map((r) => (r as { memoryId: number }).memoryId);
        expect(ids).not.toContain(visible.id);
        expect(ids).toContain(hidden.id);
    });

    it("uses linear decay for message scoring so secondary hits keep signal", async () => {
        rawMessagesBySession.set("ses-decay", [
            {
                ordinal: 1,
                id: "u1",
                role: "user",
                parts: [{ type: "text", text: "regression regression regression one" }],
            },
            {
                ordinal: 2,
                id: "u2",
                role: "user",
                parts: [{ type: "text", text: "regression regression two" }],
            },
            {
                ordinal: 3,
                id: "u3",
                role: "user",
                parts: [{ type: "text", text: "regression three" }],
            },
        ]);

        const results = await unifiedSearch(db, "ses-decay", "/repo/decay", "regression", {
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["message"],
        });

        const messages = results.filter(
            (r): r is Extract<(typeof results)[number], { source: "message" }> =>
                r.source === "message",
        );
        expect(messages.length).toBeGreaterThanOrEqual(3);
        // With 1/(rank+1), rank-2 would be 0.33. Linear decay over a
        // filtered length of 3 produces 1.0, 0.667, 0.333. Either way rank-1
        // (index 1) should still be comfortably above the old rank-2 value.
        expect(messages[0].score).toBeGreaterThan(0.9);
        expect(messages[1].score).toBeGreaterThan(0.5);
        // Rank-2 of 3 is the last hit — linear decay gives 1/3 ≈ 0.333 and
        // we don't want it to collapse to near-zero like the old formula's
        // rank-5 did.
        expect(messages[2].score).toBeGreaterThan(0.2);
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
