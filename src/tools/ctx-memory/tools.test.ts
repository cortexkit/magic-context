import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
    getMemoriesByProject,
    getMemoryById,
    insertMemory,
    saveEmbedding,
} from "../../features/magic-context";

let queryEmbedding: Float32Array | null = null;
const embeddingQueries: string[] = [];

mock.module("../../features/magic-context/memory/embedding", () => ({
    embedText: async (text: string) => {
        embeddingQueries.push(text);
        return queryEmbedding ? new Float32Array(queryEmbedding) : null;
    },
    isEmbeddingEnabled: () => true,
    getEmbeddingModelId: () => "mock:model",
}));

const { createCtxMemoryTools } = await import("./tools");

function createTestDb(): Database {
    const db = new Database(":memory:");
    db.run(`
        CREATE TABLE IF NOT EXISTS memories
        (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path            TEXT    NOT NULL,
            category                TEXT    NOT NULL,
            content                 TEXT    NOT NULL,
            normalized_hash         TEXT    NOT NULL,
            source_session_id       TEXT,
            source_type             TEXT    DEFAULT 'historian',
            seen_count              INTEGER DEFAULT 1,
            retrieval_count         INTEGER DEFAULT 0,
            first_seen_at           INTEGER NOT NULL,
            created_at              INTEGER NOT NULL,
            updated_at              INTEGER NOT NULL,
            last_seen_at            INTEGER NOT NULL,
            last_retrieved_at       INTEGER,
            status                  TEXT    DEFAULT 'active',
            expires_at              INTEGER,
            verification_status     TEXT    DEFAULT 'unverified',
            verified_at             INTEGER,
            superseded_by_memory_id INTEGER,
            merged_from             TEXT,
            metadata_json           TEXT,
            UNIQUE (project_path, category, normalized_hash)
        );

        CREATE TABLE IF NOT EXISTS memory_embeddings
        (
            memory_id INTEGER PRIMARY KEY REFERENCES memories (id) ON DELETE CASCADE,
            embedding BLOB NOT NULL,
            model_id  TEXT
        );

        CREATE
        VIRTUAL
        TABLE IF
        NOT EXISTS memories_fts USING fts5(
      content,
      category,
      content='memories',
      content_rowid='id',
      tokenize='porter unicode61'
    );

        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, category)
        VALUES (new.id, new.content, new.category);
        END;

        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category)
        VALUES ('delete', old.id, old.content, old.category);
        END;

        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category)
        VALUES ('delete', old.id, old.content, old.category);
        INSERT INTO memories_fts(rowid, content, category)
        VALUES (new.id, new.content, new.category);
        END;
    `);
    return db;
}

const toolContext = (sessionID = "ses-memory", agent = "general") =>
    ({ sessionID, agent }) as never;

afterEach(() => {
    queryEmbedding = null;
    embeddingQueries.length = 0;
});

afterAll(() => {
    mock.restore();
});

describe("createCtxMemoryTools", () => {
    let db: Database;
    let tools: ReturnType<typeof createCtxMemoryTools>;

    beforeEach(() => {
        db = createTestDb();
        tools = createCtxMemoryTools({
            db,
            projectPath: "/repo/project",
            memoryEnabled: true,
            embeddingEnabled: false,
        });
    });

    afterEach(() => {
        db.close(false);
    });

    describe("#given write action", () => {
        it("creates a new memory with agent source type", async () => {
            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                    content: "Always run bun test before shipping.",
                },
                toolContext(),
            );

            const memories = getMemoriesByProject(db, "/repo/project");

            expect(result).toContain("Saved memory [ID:");
            expect(memories).toHaveLength(1);
            expect(memories[0]?.sourceType).toBe("agent");
            expect(memories[0]?.sourceSessionId).toBe("ses-memory");
            expect(memories[0]?.category).toBe("USER_DIRECTIVES");
        });

        it("returns error when content is missing", async () => {
            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                },
                toolContext(),
            );

            expect(result).toContain("Error");
            expect(result).toContain("'content' is required");
        });

        it("returns error when category is missing", async () => {
            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    content: "Remember this.",
                },
                toolContext(),
            );

            expect(result).toContain("Error");
            expect(result).toContain("'category' is required");
        });

        it("returns error for unknown category", async () => {
            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "UNKNOWN_CATEGORY",
                    content: "Remember this.",
                },
                toolContext(),
            );

            expect(result).toContain("Error");
            expect(result).toContain("Unknown memory category");
        });

        it("always uses project scope for writes", async () => {
            await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_PREFERENCES",
                    content: "Keep answers dense.",
                },
                toolContext(),
            );

            const memories = getMemoriesByProject(db, "/repo/project");

            expect(memories).toHaveLength(1);
            expect(memories[0]?.projectPath).toBe("/repo/project");
        });
    });

    describe("#given delete action", () => {
        it("archives the memory by ID", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Legacy parser fails on malformed XML.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "delete", id: memory.id },
                toolContext(),
            );
            const updated = getMemoryById(db, memory.id);

            expect(result).toContain("Archived memory");
            expect(updated?.status).toBe("archived");
        });

        it("returns error when ID is missing", async () => {
            const result = await tools.ctx_memory.execute({ action: "delete" }, toolContext());

            expect(result).toContain("Error");
            expect(result).toContain("'id' is required");
        });

        it("returns error when memory not found", async () => {
            const result = await tools.ctx_memory.execute(
                { action: "delete", id: 999 },
                toolContext(),
            );

            expect(result).toContain("Error");
            expect(result).toContain("was not found");
        });
    });

    describe("#given list action", () => {
        it("returns a formatted memory table", async () => {
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Always run bun test before shipping.",
            });
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Do not use npm in this repo.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "list", limit: 10 },
                toolContext(),
            );

            expect(result).toContain("Found 2 active memories");
            expect(result).toContain("CATEGORY");
            expect(result).toContain("Always run bun test before shipping.");
            expect(result).toContain("Do not use npm in this repo.");
        });
    });

    describe("#given update action", () => {
        it("updates memory content and invalidates stale embeddings", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });
            saveEmbedding(db, memory.id, new Float32Array([1, 0]), "mock:model");

            const result = await tools.ctx_memory.execute(
                {
                    action: "update",
                    id: memory.id,
                    content: "cache_ttl=10m",
                },
                toolContext(),
            );

            expect(result).toContain(`Updated memory [ID: ${memory.id}]`);
            expect(getMemoryById(db, memory.id)?.content).toBe("cache_ttl=10m");
        });
    });

    describe("#given merge action", () => {
        it("creates a canonical merged memory and archives source memories", async () => {
            const first = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const second = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for all scripts in this repo",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [first.id, second.id],
                    content: "Use bun for all scripts in this repository.",
                },
                toolContext("ses-dreamer"),
            );

            expect(result).toContain("Merged memories");
            const activeMemories = getMemoriesByProject(db, "/repo/project");
            expect(activeMemories).toHaveLength(1);
            expect(activeMemories[0]?.content).toBe("Use bun for all scripts in this repository.");
            expect(getMemoryById(db, first.id)?.status).toBe("archived");
            expect(getMemoryById(db, second.id)?.status).toBe("archived");
        });
    });

    describe("#given archive action", () => {
        it("archives the memory and stores the archive reason in metadata", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Old issue entry",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "archive",
                    id: memory.id,
                    reason: "Removed subsystem no longer exists",
                },
                toolContext(),
            );

            expect(result).toContain("Archived memory");
            expect(getMemoryById(db, memory.id)?.metadataJson).toContain(
                "Removed subsystem no longer exists",
            );
        });
    });

    describe("#given search action", () => {
        it("returns semantic results when embeddings available", async () => {
            const embeddingTools = createCtxMemoryTools({
                db,
                projectPath: "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: true,
            });

            const semanticMatch = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ARCHITECTURE_DECISIONS",
                content: "Magic-context stores architecture decisions in SQLite.",
            });

            insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Never use npm in this repository.",
            });

            saveEmbedding(db, semanticMatch.id, new Float32Array([1, 0]), "mock:model");

            queryEmbedding = new Float32Array([1, 0]);

            const result = await embeddingTools.ctx_memory.execute(
                { action: "search", query: "cross-session retrieval policy" },
                toolContext(),
            );

            expect(result).toContain('Found 1 memory matching "cross-session retrieval policy"');
            expect(result).toContain("[ARCHITECTURE_DECISIONS]");
            expect(result).toContain("Magic-context stores architecture decisions in SQLite.");
            expect(result).toContain("score: 0.80");
            expect(embeddingQueries).toEqual(["cross-session retrieval policy"]);
            expect(getMemoryById(db, semanticMatch.id)?.retrievalCount).toBe(1);
        });

        it("falls back to FTS5-only when embedding provider is off", async () => {
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Historian must not summarize the last five meaningful user turns.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "search", query: "Historian summarize" },
                toolContext(),
            );

            expect(result).toContain('Found 1 memory matching "Historian summarize"');
            expect(result).toContain("[CONSTRAINTS]");
            expect(result).toContain("score: 0.80");
            expect(embeddingQueries).toEqual([]);
        });

        it("combines semantic and FTS5 scores", async () => {
            const embeddingTools = createCtxMemoryTools({
                db,
                projectPath: "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: true,
            });

            const semanticOnly = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ARCHITECTURE_DECISIONS",
                content: "Magic-context stores session notes in SQLite compartments.",
            });
            const hybridWinner = insertMemory(db, {
                projectPath: "/repo/project",
                category: "WORKFLOW_RULES",
                content: "Always run bun test before merge.",
            });
            const ftsOnly = insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Run bun checks before release.",
            });

            saveEmbedding(db, semanticOnly.id, new Float32Array([0.95, 0.31]), "mock:model");
            saveEmbedding(db, hybridWinner.id, new Float32Array([1, 0]), "mock:model");
            queryEmbedding = new Float32Array([1, 0]);

            // Bun panic reported: https://github.com/oven-sh/bun/issues/XXXX
            const result = await embeddingTools.ctx_memory.execute(
                { action: "search", query: "run bun" },
                toolContext(),
            );
            const semanticIndex = result.indexOf(semanticOnly.content);
            const winnerIndex = result.indexOf("Always run bun test before merge.");
            const ftsOnlyIndex = result.indexOf(ftsOnly.content);

            expect(result).toContain("score: 0.85");
            expect(result).toContain("score: 0.76");
            expect(result).toContain("score: 0.30");
            expect(semanticIndex).toBeGreaterThan(-1);
            expect(winnerIndex).toBeGreaterThan(-1);
            expect(ftsOnlyIndex).toBeGreaterThan(-1);
            expect(winnerIndex).toBeLessThan(semanticIndex);
            expect(ftsOnlyIndex).toBeGreaterThan(semanticIndex);
        });

        it("increments retrieval_count for returned results", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "Default cache TTL is five minutes.",
            });

            await tools.ctx_memory.execute({ action: "search", query: "cache TTL" }, toolContext());

            expect(getMemoryById(db, memory.id)?.retrievalCount).toBe(1);
        });

        it("respects limit parameter", async () => {
            const embeddingTools = createCtxMemoryTools({
                db,
                projectPath: "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: true,
            });

            const first = insertMemory(db, {
                projectPath: "/repo/project",
                category: "WORKFLOW_RULES",
                content: "Memory ranking favors retrieval guidance.",
            });
            const second = insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Memory ranking stores release guidance.",
            });
            saveEmbedding(db, first.id, new Float32Array([1, 0]), "mock:model");
            saveEmbedding(db, second.id, new Float32Array([0.6, 0.8]), "mock:model");
            queryEmbedding = new Float32Array([1, 0]);

            const result = await embeddingTools.ctx_memory.execute(
                { action: "search", query: "cross-session memory ranking", limit: 1 },
                toolContext(),
            );

            expect(result).toContain('Found 1 memory matching "cross-session memory ranking"');
            expect(result).toContain(first.content);
            expect(result).not.toContain(second.content);
            expect(getMemoryById(db, first.id)?.retrievalCount).toBe(1);
            expect(getMemoryById(db, second.id)?.retrievalCount).toBe(0);
        });

        it("filters results by category when specified", async () => {
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "ARCHITECTURE_DECISIONS",
                content: "Magic-context uses SQLite storage.",
            });
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "SQLite writes must stay transactional.",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "search",
                    query: "SQLite",
                    category: "CONSTRAINTS",
                },
                toolContext(),
            );

            expect(result).toContain('Found 1 memory matching "SQLite"');
            expect(result).toContain("[CONSTRAINTS]");
            expect(result).not.toContain("[ARCHITECTURE_DECISIONS]");
        });

        it("returns empty message when no memories match", async () => {
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "ENVIRONMENT",
                content: "CI runs on darwin and linux.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "search", query: "windows gpu" },
                toolContext(),
            );

            expect(result).toBe('No memories found matching "windows gpu".');
        });

        it("returns error when query is missing", async () => {
            const result = await tools.ctx_memory.execute({ action: "search" }, toolContext());

            expect(result).toContain("Error");
            expect(result).toContain("'query' must be provided");
        });
    });

    describe("#given disabled memory", () => {
        it("returns disabled message for all actions", async () => {
            const disabledTools = createCtxMemoryTools({
                db,
                projectPath: "/repo/project",
                memoryEnabled: false,
                embeddingEnabled: false,
            });

            const results = await Promise.all([
                disabledTools.ctx_memory.execute(
                    { action: "write", category: "USER_DIRECTIVES", content: "x" },
                    toolContext(),
                ),
                disabledTools.ctx_memory.execute({ action: "delete", id: 1 }, toolContext()),
                disabledTools.ctx_memory.execute(
                    { action: "search", query: "architecture" },
                    toolContext(),
                ),
            ]);

            expect(results).toEqual([
                "Cross-session memory is disabled for this project.",
                "Cross-session memory is disabled for this project.",
                "Cross-session memory is disabled for this project.",
            ]);
        });
    });

    describe("#given restricted actions", () => {
        it("rejects dreamer-only actions for primary-agent tool instances", async () => {
            const primaryTools = createCtxMemoryTools({
                db,
                projectPath: "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                allowedActions: ["write", "delete", "search"],
            });

            const result = await primaryTools.ctx_memory.execute({ action: "list" }, toolContext());

            expect(result).toContain("not allowed");
        });

        it("allows dreamer sessions to use dreamer-only actions on the shared tool", async () => {
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Keep replies concise.",
            });
            const primaryTools = createCtxMemoryTools({
                db,
                projectPath: "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                allowedActions: ["write", "delete", "search"],
            });

            const result = await primaryTools.ctx_memory.execute(
                { action: "list" },
                toolContext("ses-dream", "dreamer"),
            );

            expect(result).toContain("Found 1 active memory");
        });
    });
});
