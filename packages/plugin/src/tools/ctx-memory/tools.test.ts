import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getMemoriesByProject, getMemoryById, insertMemory } from "../../features/magic-context";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";

mock.module("../../features/magic-context/memory/embedding", () => ({
    embedText: async (_text: string) => null,
    isEmbeddingEnabled: () => true,
    getEmbeddingModelId: () => "mock:model",
}));

const { createCtxMemoryTools } = await import("./tools");

function createTestDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
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
        closeQuietly(db);
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
            ]);

            expect(results).toEqual([
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
                allowedActions: ["write", "delete"],
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
                allowedActions: ["write", "delete"],
            });

            const result = await primaryTools.ctx_memory.execute(
                { action: "list" },
                toolContext("ses-dream", "dreamer"),
            );

            expect(result).toContain("Found 1 active memory");
        });
    });
});
