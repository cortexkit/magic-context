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
import { parseIdShapedQuery, type UnifiedSearchOptions, unifiedSearch } from "./search";
import { initializeDatabase } from "./storage-db";
import { addNote, dismissNote, updateNote } from "./storage-notes";
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
        db.prepare("UPDATE memories SET shareable = 1 WHERE id = ?").run(foreignShared.id);
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

    it("fails closed for malformed workspace share categories during memory search", async () => {
        db.exec(`
            INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
            VALUES (1, 'ws', 'not-json', 1, 1);
            INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
            VALUES (1, 'git:own', 'Own', '/own', 1), (1, 'git:foreign', 'Foreign', '/foreign', 1);
        `);
        const own = insertMemory(db, {
            projectPath: "git:own",
            category: "CONSTRAINTS",
            content: "own malformed-policy needle",
        });
        const foreign = insertMemory(db, {
            projectPath: "git:foreign",
            category: "CONSTRAINTS",
            content: "foreign malformed-policy needle",
        });

        const results = await unifiedSearch(db, "ses-1", "git:own", "malformed-policy", {
            limit: 10,
            memoryEnabled: true,
            embeddingEnabled: false,
            sources: ["memory"],
        });

        const memoryIds = results
            .filter((result) => result.source === "memory")
            .map((result) => result.memoryId);
        expect(memoryIds).toContain(own.id);
        expect(memoryIds).not.toContain(foreign.id);
    });

    it("uses the designed CONSTRAINTS default for legacy NULL workspace share categories", async () => {
        db.exec(`
            DROP TABLE workspace_members;
            DROP TABLE workspaces;
            CREATE TABLE workspaces (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                share_categories TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE workspace_members (
                workspace_id INTEGER NOT NULL,
                project_path TEXT NOT NULL,
                display_name TEXT NOT NULL,
                display_path TEXT NOT NULL,
                added_at INTEGER NOT NULL,
                PRIMARY KEY (workspace_id, project_path)
            );
            INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
            VALUES (1, 'ws', NULL, 1, 1);
            INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
            VALUES (1, 'git:own', 'Own', '/own', 1), (1, 'git:foreign', 'Foreign', '/foreign', 1);
        `);
        const foreignConstraint = insertMemory(db, {
            projectPath: "git:foreign",
            category: "CONSTRAINTS",
            content: "foreign legacy-null constraint needle",
        });
        db.prepare("UPDATE memories SET shareable = 1 WHERE id = ?").run(foreignConstraint.id);
        const foreignNaming = insertMemory(db, {
            projectPath: "git:foreign",
            category: "NAMING",
            content: "foreign legacy-null naming needle",
        });

        const results = await unifiedSearch(db, "ses-1", "git:own", "legacy-null", {
            limit: 10,
            memoryEnabled: true,
            embeddingEnabled: false,
            sources: ["memory"],
        });

        const memoryIds = results
            .filter((result) => result.source === "memory")
            .map((result) => result.memoryId);
        expect(memoryIds).toContain(foreignConstraint.id);
        expect(memoryIds).not.toContain(foreignNaming.id);
    });

    it("ignores workspace memory vectors from inactive embedding models", async () => {
        const snapshot = registerEmbeddingProject(db, "git:own");
        db.exec(`
            INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
            VALUES (1, 'ws', '["NAMING"]', 1, 1);
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

    it("filters indexed messages by inclusive time before LIMIT and excludes NULL times", async () => {
        rawMessagesBySession.set("ses-dated", [
            {
                ordinal: 1,
                id: "outside-before",
                role: "user",
                parts: [{ type: "text", text: "temporal needle" }],
                createdAt: 1_000,
            },
            {
                ordinal: 2,
                id: "inside-start",
                role: "assistant",
                parts: [{ type: "text", text: "temporal needle" }],
                createdAt: 2_000,
            },
            {
                ordinal: 3,
                id: "legacy-null",
                role: "user",
                parts: [{ type: "text", text: "temporal needle" }],
                createdAt: null,
            },
            {
                ordinal: 4,
                id: "inside-end",
                role: "assistant",
                parts: [{ type: "text", text: "temporal needle" }],
                createdAt: 3_000,
            },
        ]);
        ensureMessagesIndexed(db, "ses-dated", readMessages);

        const results = await unifiedSearch(db, "ses-dated", "git:test", "temporal needle", {
            sources: ["message"],
            embeddingEnabled: false,
            from: 2_000,
            to: 3_000,
            limit: 10,
        });

        expect(
            results
                .filter((result) => result.source === "message")
                .map((result) => result.messageId),
        ).toEqual(["inside-start", "inside-end"]);
        expect(
            db
                .prepare(
                    "SELECT message_time_ms FROM message_fts_rowid_map WHERE session_id = ? AND message_ordinal = 3",
                )
                .get("ses-dated"),
        ).toEqual({ message_time_ms: null });
    });

    it("keeps undated search output byte-identical when both bounds are absent", async () => {
        rawMessagesBySession.set("ses-undated", [
            {
                ordinal: 1,
                id: "undated-1",
                role: "user",
                parts: [{ type: "text", text: "stable output needle" }],
                createdAt: 1_000,
            },
        ]);
        ensureMessagesIndexed(db, "ses-undated", readMessages);
        const baseOptions: UnifiedSearchOptions = {
            sources: ["message"],
            embeddingEnabled: false,
            limit: 10,
        };

        const current = await unifiedSearch(
            db,
            "ses-undated",
            "git:test",
            "stable output needle",
            baseOptions,
        );
        const absent = await unifiedSearch(db, "ses-undated", "git:test", "stable output needle", {
            ...baseOptions,
            from: undefined,
            to: undefined,
        });

        expect(JSON.stringify(absent)).toBe(JSON.stringify(current));
    });

    it("filters memories, notes, primers, and git commits by their stored times", async () => {
        const outsideMemory = insertMemory(db, {
            projectPath: "git:dated-sources",
            category: "CONSTRAINTS",
            content: "range corpus needle outside memory",
        });
        const insideMemory = insertMemory(db, {
            projectPath: "git:dated-sources",
            category: "CONSTRAINTS",
            content: "range corpus needle inside memory",
        });
        db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(1_000, outsideMemory.id);
        db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(3_000, insideMemory.id);

        const outsideNote = addNote(db, "session", {
            content: "range corpus needle outside note",
            projectPath: "git:dated-sources",
            sessionId: "ses-dated-sources",
        });
        const insideNote = addNote(db, "session", {
            content: "range corpus needle inside note",
            projectPath: "git:dated-sources",
            sessionId: "ses-dated-sources",
        });
        db.prepare("UPDATE notes SET created_at = ? WHERE id = ?").run(1_000, outsideNote.id);
        db.prepare("UPDATE notes SET created_at = ? WHERE id = ?").run(3_000, insideNote.id);

        const outsidePrimer = createPrimer(db, {
            projectPath: "git:dated-sources",
            question: "range corpus needle outside primer",
            answer: "outside",
            totalSupport: 2,
            lastObservedAt: 1_000,
            sourceCandidateIds: [],
        });
        const insidePrimer = createPrimer(db, {
            projectPath: "git:dated-sources",
            question: "range corpus needle inside primer",
            answer: "inside",
            totalSupport: 2,
            lastObservedAt: 3_000,
            sourceCandidateIds: [],
        });
        db.prepare("UPDATE primers SET created_at = ? WHERE id = ?").run(1_000, outsidePrimer);
        db.prepare("UPDATE primers SET created_at = ? WHERE id = ?").run(3_000, insidePrimer);

        db.prepare(
            `INSERT INTO git_commits
                (sha, project_path, short_sha, message, author, committed_at, indexed_at)
             VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        ).run(
            "outside-sha",
            "git:dated-sources",
            "outside",
            "range corpus needle outside commit",
            1_000,
            1_000,
        );
        db.prepare(
            `INSERT INTO git_commits
                (sha, project_path, short_sha, message, author, committed_at, indexed_at)
             VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        ).run(
            "inside-sha",
            "git:dated-sources",
            "inside",
            "range corpus needle inside commit",
            3_000,
            3_000,
        );

        const searchSource = (source: "memory" | "note" | "primer" | "git_commit") =>
            unifiedSearch(db, "ses-dated-sources", "git:dated-sources", "range corpus needle", {
                sources: [source],
                limit: 20,
                memoryEnabled: true,
                embeddingEnabled: false,
                gitCommitsEnabled: true,
                from: 2_000,
                to: 4_000,
            });
        const [memoryResults, noteResults, primerResults, commitResults] = await Promise.all([
            searchSource("memory"),
            searchSource("note"),
            searchSource("primer"),
            searchSource("git_commit"),
        ]);

        expect(
            memoryResults.some(
                (result) => result.source === "memory" && result.memoryId === insideMemory.id,
            ),
        ).toBe(true);
        expect(
            memoryResults.some(
                (result) => result.source === "memory" && result.memoryId === outsideMemory.id,
            ),
        ).toBe(false);
        expect(
            noteResults.some(
                (result) => result.source === "note" && result.noteId === insideNote.id,
            ),
        ).toBe(true);
        expect(
            noteResults.some(
                (result) => result.source === "note" && result.noteId === outsideNote.id,
            ),
        ).toBe(false);
        expect(
            primerResults.some(
                (result) => result.source === "primer" && result.primerId === insidePrimer,
            ),
        ).toBe(true);
        expect(
            primerResults.some(
                (result) => result.source === "primer" && result.primerId === outsidePrimer,
            ),
        ).toBe(false);
        expect(
            commitResults.some(
                (result) => result.source === "git_commit" && result.sha === "inside-sha",
            ),
        ).toBe(true);
        expect(
            commitResults.some(
                (result) => result.source === "git_commit" && result.sha === "outside-sha",
            ),
        ).toBe(false);
    });

    it("filters compartment chunks by indexed boundary-time overlap", async () => {
        rawMessagesBySession.set("ses-dated-compartment", [
            {
                ordinal: 1,
                id: "u1",
                role: "user",
                parts: [{ type: "text", text: "boundary alpha" }],
                createdAt: 2_000,
            },
            {
                ordinal: 2,
                id: "a2",
                role: "assistant",
                parts: [{ type: "text", text: "boundary omega" }],
                createdAt: 4_000,
            },
        ]);
        ensureMessagesIndexed(db, "ses-dated-compartment", readMessages);
        seedCompartmentChunkEmbedding(
            db,
            "ses-dated-compartment",
            "git:dated-compartment",
            new Float32Array([1, 0]),
        );
        queryEmbedding = new Float32Array([1, 0]);

        const overlapping = await unifiedSearch(
            db,
            "ses-dated-compartment",
            "git:dated-compartment",
            "semantic only title",
            {
                sources: ["message"],
                limit: 10,
                memoryEnabled: true,
                embeddingEnabled: true,
                embedQuery,
                isEmbeddingRuntimeEnabled,
                chunkModelIdOverride: "mock:model",
                from: 3_000,
                to: 3_000,
            },
        );
        const outside = await unifiedSearch(
            db,
            "ses-dated-compartment",
            "git:dated-compartment",
            "semantic only title",
            {
                sources: ["message"],
                limit: 10,
                memoryEnabled: true,
                embeddingEnabled: true,
                embedQuery,
                isEmbeddingRuntimeEnabled,
                chunkModelIdOverride: "mock:model",
                from: 5_000,
            },
        );

        expect(overlapping.some((result) => result.source === "compartment")).toBe(true);
        expect(outside.some((result) => result.source === "compartment")).toBe(false);
    });

    it("returns note hits with id, status, anchor, and ready_reason text", async () => {
        const readyNote = addNote(db, "smart", {
            content: "Retry the queue benchmark after the release.",
            projectPath: "git:test",
            sessionId: "ses-note",
            surfaceCondition: "When the release ships",
            anchorOrdinal: 41,
        });
        updateNote(
            db,
            readyNote.id,
            {
                status: "ready",
                readyReason: "Release shipped with the new queue drain.",
            },
            {
                sessionId: "ses-note",
                projectPath: "git:test",
            },
        );

        const results = await unifiedSearch(db, "ses-note", "git:test", "queue drain shipped", {
            limit: 5,
            memoryEnabled: false,
            embeddingEnabled: false,
            sources: ["note"],
        });

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            source: "note",
            noteId: readyNote.id,
            status: "ready",
            anchorOrdinal: 41,
            sourceSessionId: "ses-note",
        });
        if (results[0]?.source === "note") {
            expect(results[0].content).toContain("Reason: Release shipped");
        }
    });

    it("excludes dismissed notes while keeping pending notes searchable", async () => {
        const dismissed = addNote(db, "session", {
            sessionId: "ses-note-status",
            content: "Decided to keep the fallback cache disabled because telemetry was noisy.",
            anchorOrdinal: 12,
        });
        expect(
            dismissNote(db, dismissed.id, {
                sessionId: "ses-note-status",
                projectPath: "git:test",
            }),
        ).toBe(true);

        const pending = addNote(db, "smart", {
            content: "Revisit telemetry after the deploy window closes.",
            projectPath: "git:test",
            sessionId: "ses-note-status",
            surfaceCondition: "When the deploy window closes",
            anchorOrdinal: 13,
        });

        const dismissedResults = await unifiedSearch(
            db,
            "ses-note-status",
            "git:test",
            "fallback cache disabled noisy",
            {
                limit: 5,
                memoryEnabled: false,
                embeddingEnabled: false,
                sources: ["note"],
            },
        );
        const pendingResults = await unifiedSearch(
            db,
            "ses-note-status",
            "git:test",
            "deploy window closes",
            {
                limit: 5,
                memoryEnabled: false,
                embeddingEnabled: false,
                sources: ["note"],
            },
        );

        expect(dismissedResults).toEqual([]);
        expect(pendingResults[0]).toMatchObject({
            source: "note",
            noteId: pending.id,
            status: "pending",
        });
    });

    it("does not let a one-token dismissed note outrank a semantic memory", async () => {
        const snapshot = registerEmbeddingProject(db, "git:test");
        const memory = insertMemory(db, {
            projectPath: "git:test",
            category: "ARCHITECTURE_DECISIONS",
            content: "The semantic memory contains the durable calibration decision.",
        });
        saveEmbedding(db, memory.id, new Float32Array([0.5, Math.sqrt(0.75)]), snapshot.modelId);
        queryEmbedding = new Float32Array([1, 0]);

        const dismissed = addNote(db, "session", {
            sessionId: "ses-dismissed-rank",
            content: "needle",
        });
        expect(
            dismissNote(db, dismissed.id, {
                sessionId: "ses-dismissed-rank",
                projectPath: "git:test",
            }),
        ).toBe(true);

        const results = await unifiedSearch(
            db,
            "ses-dismissed-rank",
            "git:test",
            "needle semantic calibration decision",
            {
                limit: 5,
                memoryEnabled: true,
                embeddingEnabled: true,
                embedQuery,
                isEmbeddingRuntimeEnabled,
            },
        );

        expect(results[0]).toMatchObject({ source: "memory", memoryId: memory.id });
        expect(
            results.some((result) => result.source === "note" && result.noteId === dismissed.id),
        ).toBe(false);
    });

    it("scores notes by normalized keyword relevance instead of result position", async () => {
        const dense = addNote(db, "session", {
            sessionId: "ses-note-relevance",
            content: "needle semantic calibration decision",
        });
        const weak = addNote(db, "session", {
            sessionId: "ses-note-relevance",
            content:
                "A long unrelated reminder with background, historical context, filler, and one needle token.",
        });

        const results = await unifiedSearch(
            db,
            "ses-note-relevance",
            "git:test",
            "needle semantic calibration decision",
            {
                limit: 5,
                memoryEnabled: false,
                embeddingEnabled: false,
                sources: ["note"],
            },
        );
        const notes = results.filter(
            (result): result is Extract<(typeof results)[number], { source: "note" }> =>
                result.source === "note",
        );

        expect(notes.map((note) => note.noteId)).toEqual([dense.id, weak.id]);
        expect(notes[0].score).toBeCloseTo(0.8, 6);
        expect(notes[1].score).toBeCloseTo(1 / 210, 6);

        const singleTokenResults = await unifiedSearch(
            db,
            "ses-note-relevance",
            "git:test",
            "needle",
            {
                limit: 5,
                memoryEnabled: false,
                embeddingEnabled: false,
                sources: ["note"],
            },
        );
        const weakSingleTokenHit = singleTokenResults.find(
            (result) => result.source === "note" && result.noteId === weak.id,
        );
        expect(weakSingleTokenHit?.score).toBeLessThan(0.02);
    });

    it("scopes note search to the current session and project notes", async () => {
        const ownSession = addNote(db, "session", {
            sessionId: "ses-scope",
            content: "scope marker own session",
        });
        addNote(db, "session", {
            sessionId: "ses-other",
            content: "scope marker other session",
        });
        const sameProjectSmart = addNote(db, "smart", {
            content: "scope marker same project smart",
            projectPath: "git:own",
            sessionId: "ses-foreign",
            surfaceCondition: "When project scope matters",
        });
        addNote(db, "smart", {
            content: "scope marker foreign project smart",
            projectPath: "git:other",
            sessionId: "ses-scope",
            surfaceCondition: "When project scope matters",
        });

        const results = await unifiedSearch(db, "ses-scope", "git:own", "scope marker", {
            limit: 10,
            memoryEnabled: false,
            embeddingEnabled: false,
            sources: ["note"],
        });

        const noteResults = results.filter(
            (result): result is Extract<(typeof results)[number], { source: "note" }> =>
                result.source === "note",
        );
        const noteIds = noteResults
            .map((result) => result.noteId)
            .sort((left, right) => left - right);
        expect(noteIds).toEqual([ownSession.id, sameProjectSmart.id].sort((a, b) => a - b));
        expect(noteResults.find((result) => result.noteId === ownSession.id)?.sourceSessionId).toBe(
            "ses-scope",
        );
        expect(
            noteResults.find((result) => result.noteId === sameProjectSmart.id)?.sourceSessionId,
        ).toBe("ses-foreign");
    });

    it("restricts note results to the note source and includes them in broad searches", async () => {
        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "broad recall marker from memory",
        });
        const note = addNote(db, "session", {
            sessionId: "ses-broad-note",
            content: "broad recall marker from note",
        });

        const noteOnly = await unifiedSearch(
            db,
            "ses-broad-note",
            "/repo/project",
            "broad recall marker",
            {
                limit: 10,
                memoryEnabled: true,
                embeddingEnabled: false,
                sources: ["note"],
            },
        );
        expect(noteOnly.every((result) => result.source === "note")).toBe(true);
        expect(noteOnly[0]).toMatchObject({ source: "note", noteId: note.id });

        const broad = await unifiedSearch(
            db,
            "ses-broad-note",
            "/repo/project",
            "broad recall marker",
            {
                limit: 10,
                memoryEnabled: true,
                embeddingEnabled: false,
            },
        );
        const broadSources = broad.map((result) => result.source);
        expect(broadSources).toContain("memory");
        expect(broadSources).toContain("note");
        expect(
            broad.some((result) => result.source === "memory" && result.memoryId === memory.id),
        ).toBe(true);
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

    it("counts probe corpus statistics only inside the message cutoff", async () => {
        rawMessagesBySession.set("ses-cutoff-probes", [
            {
                ordinal: 1,
                id: "common-1",
                role: "assistant",
                parts: [{ type: "text", text: "CommonTerm is the eligible early hit." }],
            },
            {
                ordinal: 2,
                id: "rare-2",
                role: "assistant",
                parts: [{ type: "text", text: "RareSymbolXyz is the eligible late hit." }],
            },
            ...Array.from({ length: 12 }, (_, i) => ({
                ordinal: i + 3,
                id: `tail-${i}`,
                role: "assistant" as const,
                parts: [
                    {
                        type: "text" as const,
                        text: `CommonTerm appears again in excluded live-tail row ${i}.`,
                    },
                ],
            })),
        ]);
        ensureMessagesIndexed(db, "ses-cutoff-probes", readMessages);

        const results = await unifiedSearch(
            db,
            "ses-cutoff-probes",
            "/repo/probe-cutoff",
            "RareSymbolXyz CommonTerm",
            {
                memoryEnabled: false,
                embeddingEnabled: false,
                readMessages,
                embedQuery,
                isEmbeddingRuntimeEnabled,
                sources: ["message"],
                explicitSearch: true,
                maxMessageOrdinal: 2,
            },
        );

        const messages = results.filter((r) => r.source === "message");
        expect(messages.map((r) => r.messageId)).toEqual(["common-1", "rare-2"]);
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

    // Issue 543: semantic history search is not a memory feature, so memory off
    // keeps the compartment lane; only turning embedding off removes it.
    it("respects message watermark cutoff for compartment chunks and ignores memory.enabled", async () => {
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
            chunkModelIdOverride: "mock:model",
            sources: ["message"],
            maxMessageOrdinal: 2,
        });
        expect(memoryOffResults.some((result) => result.source === "compartment")).toBe(true);
        expect(embeddingQueries).toHaveLength(1);

        embeddingQueries.length = 0;
        const embeddingOffResults = await unifiedSearch(
            db,
            "ses-cutoff",
            "/repo/cutoff",
            "concept",
            {
                limit: 5,
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages,
                embedQuery,
                isEmbeddingRuntimeEnabled,
                chunkModelIdOverride: "mock:model",
                sources: ["message"],
                maxMessageOrdinal: 2,
            },
        );
        expect(embeddingOffResults.some((result) => result.source === "compartment")).toBe(false);
        expect(embeddingQueries).toEqual([]);
    });
});

describe("parseIdShapedQuery", () => {
    it("recognizes a bare numeric id", () => {
        expect(parseIdShapedQuery("7234")).toEqual([7234]);
    });
    it("recognizes a `#id` token", () => {
        expect(parseIdShapedQuery("#7234")).toEqual([7234]);
    });
    it("recognizes a comma-separated id list (≤5 tokens)", () => {
        expect(parseIdShapedQuery("12, 34, 56")).toEqual([12, 34, 56]);
    });
    it("recognizes a space-separated id list (≤5 tokens)", () => {
        expect(parseIdShapedQuery("#12 34 56")).toEqual([12, 34, 56]);
    });
    it("rejects phrases that contain a number but are not id-shaped", () => {
        expect(parseIdShapedQuery("fix bug 1234")).toBeNull();
        expect(parseIdShapedQuery("error at line 42 in foo.ts")).toBeNull();
    });
    it("rejects id lists over the 5-token cap", () => {
        expect(parseIdShapedQuery("1 2 3 4 5 6")).toBeNull();
    });
    it("rejects empty / whitespace-only queries", () => {
        expect(parseIdShapedQuery("")).toBeNull();
        expect(parseIdShapedQuery("   ")).toBeNull();
    });
    it("rejects tokens that are not pure digits (e.g. negative or hex)", () => {
        expect(parseIdShapedQuery("-1")).toBeNull();
        expect(parseIdShapedQuery("0x10")).toBeNull();
        expect(parseIdShapedQuery("id 7234")).toBeNull();
    });
});
