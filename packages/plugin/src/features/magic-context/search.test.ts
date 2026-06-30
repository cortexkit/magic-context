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
import {
    chunkCanonicalText,
    replaceCompartmentChunkEmbeddings,
} from "./compartment-chunk-embedding";
import { appendCompartments, getCompartments, replaceSessionFacts } from "./compartment-storage";
import { getMemoryById, insertMemory, resetEmbeddingCacheForTests, saveEmbedding } from "./memory";
import { ensureMessagesIndexed } from "./message-index";
import { runMigrations } from "./migrations";
import {
    _resetProjectEmbeddingRegistryForTests,
    registerProjectEmbedding,
} from "./project-embedding-registry";
import { unifiedSearch } from "./search";
import { initializeDatabase } from "./storage-db";
import { createPrimer } from "./storage-primers";

const readMessages = (sessionId: string) => rawMessagesBySession.get(sessionId) ?? [];
const embedQuery = async (text: string) => {
    embeddingQueries.push(text);
    return queryEmbedding ? new Float32Array(queryEmbedding) : null;
};
const isEmbeddingRuntimeEnabled = () => true;

function seedCompartmentChunkEmbedding(
    db: Database,
    sessionId: string,
    projectPath: string,
    vector: Float32Array,
    modelId = "mock:model",
): number {
    appendCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "u1",
            endMessageId: "a2",
            title: "Queue saturation design",
            content: "P1 content",
            p1: "P1 content",
        },
    ]);
    const compartment = getCompartments(db, sessionId)[0];
    const windows = chunkCanonicalText(
        "[1] U: queue saturation problem\n[2] A: bounded drains with backpressure",
        1,
        2,
        10_000,
    );
    replaceCompartmentChunkEmbeddings(
        db,
        windows.map((window) => ({
            compartmentId: compartment.id,
            sessionId,
            projectPath,
            window,
            modelId,
            vector,
        })),
    );
    return compartment.id;
}

function registerEmbeddingProject(db: Database, projectPath: string) {
    return registerProjectEmbedding(
        db,
        projectPath,
        { provider: "local", model: "mock-model" },
        { memoryEnabled: true, gitCommitEnabled: true },
        projectPath,
    );
}

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    // runMigrations adds the git_commits + git_commits_fts tables that the
    // dedup regression test exercises. Production code calls both functions
    // back-to-back inside openDatabase(); the test path historically only
    // called initializeDatabase() because no test needed the v4 schema.
    runMigrations(db);
    return db;
}

afterEach(() => {
    queryEmbedding = null;
    embeddingQueries.length = 0;
    rawMessagesBySession.clear();
    resetEmbeddingCacheForTests();
    _resetProjectEmbeddingRegistryForTests();
});

describe("unifiedSearch", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        closeQuietly(db);
    });

    it("returns promoted Primers through explicit recall search", async () => {
        createPrimer(db, {
            projectPath: "git:test",
            question: "How does the cache system work?",
            answer: "The prompt cache stays stable because Primers are recall-only.",
            totalSupport: 2,
            lastObservedAt: Date.UTC(2026, 0, 8),
            sourceCandidateIds: [1, 2],
        });

        const results = await unifiedSearch(db, "session-1", "git:test", "cache system primers", {
            sources: ["primer"],
            limit: 5,
            memoryEnabled: true,
            embeddingEnabled: false,
            gitCommitsEnabled: false,
        });

        expect(results).toHaveLength(1);
        expect(results[0].source).toBe("primer");
        if (results[0].source === "primer") {
            expect(results[0].question).toBe("How does the cache system work?");
            expect(results[0].support).toBe(2);
        }
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
        ensureMessagesIndexed(db, "ses-1", readMessages);

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

    it("filters ctx_search workspace memory candidates and FTS hits by shared categories", async () => {
        db.exec(`
            INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
            VALUES (1, 'ws', '["CONSTRAINTS"]', 1, 1);
            INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
            VALUES (1, 'git:own', 'Own', '/own', 1), (1, 'git:foreign', 'Foreign', '/foreign', 1);
        `);
        const own = insertMemory(db, {
            projectPath: "git:own",
            category: "NAMING",
            content: "own naming needle",
        });
        const foreignShared = insertMemory(db, {
            projectPath: "git:foreign",
            category: "CONSTRAINTS",
            content: "foreign constraint needle",
        });
        const foreignHidden = insertMemory(db, {
            projectPath: "git:foreign",
            category: "NAMING",
            content: "foreign naming needle",
        });

        const results = await unifiedSearch(db, "ses-1", "git:own", "needle", {
            limit: 10,
            memoryEnabled: true,
            embeddingEnabled: false,
            sources: ["memory"],
        });

        const memoryIds = results
            .filter((result) => result.source === "memory")
            .map((result) => result.memoryId)
            .sort((left, right) => left - right);
        expect(memoryIds).toEqual([own.id, foreignShared.id]);
        expect(memoryIds).not.toContain(foreignHidden.id);
    });

    it("ignores workspace memory vectors from inactive embedding models", async () => {
        const snapshot = registerEmbeddingProject(db, "git:own");
        db.exec(`
            INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
            VALUES (1, 'ws', NULL, 1, 1);
            INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
            VALUES (1, 'git:own', 'Own', '/own', 1), (1, 'git:foreign', 'Foreign', '/foreign', 1);
        `);
        const own = insertMemory(db, {
            projectPath: "git:own",
            category: "NAMING",
            content: "own semantic-only memory",
        });
        const foreign = insertMemory(db, {
            projectPath: "git:foreign",
            category: "NAMING",
            content: "foreign stale-model memory",
        });
        saveEmbedding(db, own.id, new Float32Array([1, 0]), snapshot.modelId);
        saveEmbedding(db, foreign.id, new Float32Array([1, 0]), "stale:model");
        queryEmbedding = new Float32Array([1, 0]);

        const results = await unifiedSearch(db, "ses-1", "git:own", "vector-only", {
            limit: 10,
            memoryEnabled: true,
            embeddingEnabled: true,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["memory"],
        });

        const memoryIds = results
            .filter((result) => result.source === "memory")
            .map((result) => result.memoryId);
        expect(memoryIds).toContain(own.id);
        expect(memoryIds).not.toContain(foreign.id);
    });

    it("maxMessageOrdinal=0 excludes every message (no compartment yet → whole tail is live)", async () => {
        // Issue #131: before the historian first runs there are no compartments,
        // so the ctx_search tool passes a cutoff of 0. Ordinals are 1-based, so a
        // 0 cutoff must exclude EVERY indexed message — none have scrolled out of
        // the live context the agent already sees (incl. the current prompt).
        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "Magic context stores ranked search data in SQLite.",
        });
        saveEmbedding(db, memory.id, new Float32Array([1, 0]), "mock:model");
        queryEmbedding = new Float32Array([1, 0]);

        rawMessagesBySession.set("ses-1", [
            {
                ordinal: 1,
                id: "m1",
                role: "user",
                parts: [{ type: "text", text: "delete all entries in the ranked_search table" }],
            },
            {
                ordinal: 2,
                id: "m2",
                role: "assistant",
                parts: [{ type: "text", text: "ranked_search table cleanup acknowledged." }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-1", readMessages);

        const results = await unifiedSearch(db, "ses-1", "/repo/project", "ranked_search", {
            limit: 5,
            memoryEnabled: true,
            embeddingEnabled: true,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            maxMessageOrdinal: 0,
        });

        // No message results — the current prompt must NOT come back.
        expect(results.filter((r) => r.source === "message")).toHaveLength(0);
        // Memory results are unaffected by the message-ordinal cutoff.
        expect(results.some((r) => r.source === "memory")).toBe(true);
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
        ensureMessagesIndexed(db, "ses-sources", readMessages);

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
        ensureMessagesIndexed(db, "ses-decay", readMessages);

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

    it("explicitSearch recalls a literal-symbol message the AND-joined NL query misses", async () => {
        // The target message contains the symbol `/ctx-status` but NOT the
        // other words of the natural-language query. With FTS implicit-AND,
        // the full query can't match it. The literal probe must recover it.
        rawMessagesBySession.set("ses-probe", [
            {
                ordinal: 1,
                id: "m1",
                role: "assistant",
                parts: [{ type: "text", text: "Fixed the /ctx-status tool count breakdown." }],
            },
            {
                ordinal: 2,
                id: "m2",
                role: "user",
                parts: [{ type: "text", text: "unrelated chatter about something else entirely" }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-probe", readMessages);

        const nlQuery = "why did the inflated tool calls breakdown happen in ctx-status";

        // Without explicitSearch: the AND-joined query fails to surface m1
        // (it lacks "why/did/inflated/happen"). Tokenization splits ctx-status
        // → ctx + status, so the literal still doesn't rescue it under AND.
        const baseline = await unifiedSearch(db, "ses-probe", "/repo/probe", nlQuery, {
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["message"],
        });
        expect(baseline.some((r) => r.source === "message" && r.messageId === "m1")).toBe(false);

        // With explicitSearch: the `ctx-status` probe runs as its own query and
        // recalls m1, and the verbatim boost ranks it first.
        const probed = await unifiedSearch(db, "ses-probe", "/repo/probe", nlQuery, {
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["message"],
            explicitSearch: true,
        });
        const probedMessages = probed.filter((r) => r.source === "message");
        expect(probedMessages.some((r) => r.messageId === "m1")).toBe(true);
        expect(probedMessages[0]?.messageId).toBe("m1");
    });

    it("multi-probe scores decay linearly instead of flattening into a ~1.0 band", async () => {
        // Regression: the flat +0.5 verbatim bonus sat 30× above the RRF scale,
        // so after divide-by-max normalization every probe-matching message
        // scored ~1.0 and (×MESSAGE_SOURCE_BOOST) crowded memories out of the
        // unified results. Scores must now follow the linear rank band.
        const msgs = Array.from({ length: 8 }, (_, i) => ({
            ordinal: i + 1,
            id: `mm${i}`,
            role: "assistant",
            parts: [
                {
                    type: "text",
                    text: `note ${i}: the /ctx-status dialog rendering pass number ${i}`,
                },
            ],
        }));
        rawMessagesBySession.set("ses-band", msgs);
        ensureMessagesIndexed(db, "ses-band", readMessages);

        const results = await unifiedSearch(db, "ses-band", "/repo/band", "ctx-status dialog", {
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["message"],
            explicitSearch: true,
        });
        const messages = results.filter((r) => r.source === "message");
        expect(messages.length).toBeGreaterThanOrEqual(4);
        // Top hit caps the band; the rest must spread DOWN the linear band, not
        // cluster at ~1.0. With the old flat bonus all of these were ≥0.95.
        expect(messages[0].score).toBeGreaterThan(0.9);
        const second = messages[1].score;
        const last = messages[messages.length - 1].score;
        expect(second).toBeLessThan(0.95);
        expect(last).toBeLessThan(0.5);
    });

    it("a discriminative probe outranks a corpus-flooding probe", async () => {
        // "AFT"-class regression: a probe matching a large share of the corpus
        // carries near-zero signal and must not drown the rare probe's hit.
        const flood = Array.from({ length: 30 }, (_, i) => ({
            ordinal: i + 1,
            id: `f${i}`,
            role: "assistant",
            parts: [{ type: "text", text: `CommonTerm appears here in filler message ${i}` }],
        }));
        const rare = {
            ordinal: 31,
            id: "rare-hit",
            role: "assistant",
            parts: [
                {
                    type: "text",
                    text: "RareSymbolXyz was fixed alongside CommonTerm in the resolver",
                },
            ],
        };
        rawMessagesBySession.set("ses-idf", [...flood, rare]);
        ensureMessagesIndexed(db, "ses-idf", readMessages);

        const results = await unifiedSearch(
            db,
            "ses-idf",
            "/repo/idf",
            "where did we fix RareSymbolXyz near CommonTerm",
            {
                memoryEnabled: false,
                embeddingEnabled: false,
                readMessages,
                embedQuery,
                isEmbeddingRuntimeEnabled,
                sources: ["message"],
                explicitSearch: true,
            },
        );
        const messages = results.filter((r) => r.source === "message");
        // The rare-probe message must win over the 30 flood messages that only
        // match the common probe.
        expect(messages[0]?.messageId).toBe("rare-hit");
    });

    it("returns empty message results until async indexing populates FTS", async () => {
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

        expect(results.filter((result) => result.source === "message")).toHaveLength(0);

        ensureMessagesIndexed(db, "ses-2", readMessages);

        results = await unifiedSearch(db, "ses-2", "/repo/project", "ticket", {
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
        ensureMessagesIndexed(db, "ses-2", readMessages);

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
        const snapshot = registerEmbeddingProject(db, "/repo/project");
        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "alpha beta gamma",
        });
        saveEmbedding(db, memory.id, new Float32Array([0, 1]), snapshot.modelId);
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

    /**
     * Regression for the duplicate-embed bug observed in production LMStudio
     * logs: when both memory and git-commit search ran in parallel, EACH
     * branch independently called `embedQuery(trimmedQuery)`, producing two
     * identical HTTP requests for the same input text. On a single-GPU
     * embedding endpoint these serialized at the model and doubled latency.
     *
     * unifiedSearch must embed the query exactly once at the top, then pass
     * the same vector to both consumers.
     */
    it("embeds the query exactly once even when memory + git_commit both need it", async () => {
        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "shared embed test.",
        });
        saveEmbedding(db, memory.id, new Float32Array([1, 0]), "mock:model");
        queryEmbedding = new Float32Array([1, 0]);

        await unifiedSearch(db, "ses-1", "/repo/project", "shared embed query", {
            limit: 5,
            memoryEnabled: true,
            embeddingEnabled: true,
            // Enable git-commits even though we have no commits indexed —
            // searchGitCommits used to call embedQuery anyway, which is the
            // exact behavior we're regressing against.
            gitCommitsEnabled: true,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
        });

        // Even with two embed-needing branches active, the query is embedded
        // exactly once. Pre-fix this would have been 2.
        expect(embeddingQueries).toEqual(["shared embed query"]);
    });

    it("returns a semantic compartment hit for message-only conceptual search", async () => {
        rawMessagesBySession.set("ses-chunk", [
            {
                ordinal: 1,
                id: "u1",
                role: "user",
                parts: [{ type: "text", text: "queue saturation problem" }],
            },
            {
                ordinal: 2,
                id: "a2",
                role: "assistant",
                parts: [{ type: "text", text: "bounded drains with backpressure" }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-chunk", readMessages);
        const snapshot = registerEmbeddingProject(db, "/repo/chunk");
        const compartmentId = seedCompartmentChunkEmbedding(
            db,
            "ses-chunk",
            "/repo/chunk",
            new Float32Array([0, 1]),
            snapshot.chunkModelId,
        );
        queryEmbedding = new Float32Array([0, 1]);

        const results = await unifiedSearch(db, "ses-chunk", "/repo/chunk", "hydraulic flow", {
            limit: 5,
            memoryEnabled: true,
            embeddingEnabled: true,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["message"],
            maxMessageOrdinal: 2,
        });

        expect(embeddingQueries).toEqual(["hydraulic flow"]);
        expect(results[0]).toMatchObject({
            source: "compartment",
            compartmentId,
            startOrdinal: 1,
            endOrdinal: 2,
            matchType: "semantic",
        });
    });

    it("deduplicates FTS hits inside semantic compartment ranges and keeps a snippet", async () => {
        rawMessagesBySession.set("ses-dedup", [
            {
                ordinal: 1,
                id: "u1",
                role: "user",
                parts: [{ type: "text", text: "queue saturation problem" }],
            },
            {
                ordinal: 2,
                id: "a2",
                role: "assistant",
                parts: [{ type: "text", text: "bounded drains with backpressure" }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-dedup", readMessages);
        const snapshot = registerEmbeddingProject(db, "/repo/chunk");
        seedCompartmentChunkEmbedding(
            db,
            "ses-dedup",
            "/repo/chunk",
            new Float32Array([0, 1]),
            snapshot.chunkModelId,
        );
        queryEmbedding = new Float32Array([0, 1]);

        const results = await unifiedSearch(db, "ses-dedup", "/repo/chunk", "bounded drains", {
            limit: 5,
            memoryEnabled: true,
            embeddingEnabled: true,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["message"],
            maxMessageOrdinal: 2,
        });

        expect(results.some((result) => result.source === "message")).toBe(false);
        const compartment = results.find((result) => result.source === "compartment");
        expect(compartment).toMatchObject({ source: "compartment", matchType: "hybrid" });
        expect(compartment && "snippet" in compartment ? compartment.snippet : "").toContain(
            "bounded drains",
        );
    });

    it("respects message watermark cutoff and memory.enabled for compartment chunks", async () => {
        rawMessagesBySession.set("ses-cutoff", [
            { ordinal: 1, id: "u1", role: "user", parts: [{ type: "text", text: "first" }] },
            { ordinal: 2, id: "a2", role: "assistant", parts: [{ type: "text", text: "second" }] },
        ]);
        ensureMessagesIndexed(db, "ses-cutoff", readMessages);
        seedCompartmentChunkEmbedding(db, "ses-cutoff", "/repo/cutoff", new Float32Array([0, 1]));
        queryEmbedding = new Float32Array([0, 1]);

        const cutoffResults = await unifiedSearch(db, "ses-cutoff", "/repo/cutoff", "concept", {
            limit: 5,
            memoryEnabled: true,
            embeddingEnabled: true,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["message"],
            maxMessageOrdinal: 1,
        });
        expect(cutoffResults.some((result) => result.source === "compartment")).toBe(false);

        embeddingQueries.length = 0;
        const memoryOffResults = await unifiedSearch(db, "ses-cutoff", "/repo/cutoff", "concept", {
            limit: 5,
            memoryEnabled: false,
            embeddingEnabled: true,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["message"],
            maxMessageOrdinal: 2,
        });
        expect(memoryOffResults.some((result) => result.source === "compartment")).toBe(false);
        expect(embeddingQueries).toEqual([]);
    });
});
