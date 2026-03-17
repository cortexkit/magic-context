import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
    getMemoriesByProject,
    getMemoryById,
    insertMemory,
} from "../../features/magic-context/memory";

const embedTextMock = mock(async () => null as Float32Array | null);

mock.module("../../features/magic-context/memory/embedding", () => ({
    embedText: embedTextMock,
}));

const { createCtxMemoryTools } = await import("./tools");

function createTestDb(): Database {
    const db = new Database(":memory:");
    db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      normalized_hash TEXT NOT NULL,
      source_session_id TEXT,
      source_type TEXT DEFAULT 'historian',
      seen_count INTEGER DEFAULT 1,
      retrieval_count INTEGER DEFAULT 0,
      first_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_retrieved_at INTEGER,
      status TEXT DEFAULT 'active',
      expires_at INTEGER,
      verification_status TEXT DEFAULT 'unverified',
      verified_at INTEGER,
      superseded_by_memory_id INTEGER,
      merged_from TEXT,
      metadata_json TEXT,
      UNIQUE(project_path, category, normalized_hash)
    );

    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      category,
      content='memories',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
      INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
    END;
  `);
    return db;
}

const toolContext = (sessionID = "ses-memory") => ({ sessionID }) as never;

describe("createCtxMemoryTools", () => {
    let db: Database;
    let tools: ReturnType<typeof createCtxMemoryTools>;

    beforeEach(() => {
        db = createTestDb();
        embedTextMock.mockReset();
        embedTextMock.mockImplementation(async () => null);
        tools = createCtxMemoryTools({
            db,
            projectPath: "/repo/project",
            memoryEnabled: true,
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

        it("uses __global__ scope when scope is global", async () => {
            await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_PREFERENCES",
                    content: "Keep answers dense.",
                    scope: "global",
                },
                toolContext(),
            );

            const memories = getMemoriesByProject(db, "__global__");

            expect(memories).toHaveLength(1);
            expect(memories[0]?.projectPath).toBe("__global__");
        });

        it("uses project path when scope is project or default", async () => {
            await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "CONSTRAINTS",
                    content: "No as any.",
                },
                toolContext(),
            );

            await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "ENVIRONMENT",
                    content: "Runs on darwin.",
                    scope: "project",
                },
                toolContext(),
            );

            const memories = getMemoriesByProject(db, "/repo/project");

            expect(memories).toHaveLength(2);
            expect(memories.every((memory) => memory.projectPath === "/repo/project")).toBe(true);
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

    describe("#given promote action", () => {
        it("sets memory status to permanent", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ARCHITECTURE_DECISIONS",
                content: "Use SQLite for persistence.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "promote", id: memory.id },
                toolContext(),
            );
            const updated = getMemoryById(db, memory.id);

            expect(result).toContain("Promoted memory");
            expect(updated?.status).toBe("permanent");
        });

        it("returns error when ID is missing", async () => {
            const result = await tools.ctx_memory.execute({ action: "promote" }, toolContext());

            expect(result).toContain("Error");
            expect(result).toContain("'id' is required");
        });
    });

    describe("#given list action", () => {
        it("lists all project and global memories", async () => {
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Always run bun test before finishing.",
            });
            insertMemory(db, {
                projectPath: "__global__",
                category: "USER_PREFERENCES",
                content: "Keep answers terse.",
            });

            const result = await tools.ctx_memory.execute({ action: "list" }, toolContext());

            expect(result).toContain("## Project Memories (1 total)");
            expect(result).toContain("## Global Memories (1 total)");
            expect(result).toContain("### USER_DIRECTIVES (1)");
            expect(result).toContain("### USER_PREFERENCES (1)");
        });

        it("filters by category when specified", async () => {
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Always run bun test before finishing.",
            });
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "No as any.",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "list",
                    category: "USER_DIRECTIVES",
                },
                toolContext(),
            );

            expect(result).toContain("USER_DIRECTIVES");
            expect(result).not.toContain("CONSTRAINTS");
        });

        it("shows memory details: id, category, content, status, counts", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ARCHITECTURE_DECISIONS",
                content: "Magic-context stores compartments, categorized facts, and session notes.",
            });

            const result = await tools.ctx_memory.execute({ action: "list" }, toolContext());

            expect(result).toContain(`### ARCHITECTURE_DECISIONS (1)`);
            expect(result).toContain(`[ID: ${memory.id}]`);
            expect(result).toContain(
                "Magic-context stores compartments, categorized facts, and session notes.",
            );
            expect(result).toContain("active, seen: 1, retrieved: 0");
        });

        it("returns message when no memories exist", async () => {
            const result = await tools.ctx_memory.execute({ action: "list" }, toolContext());

            expect(result).toBe("No cross-session memories stored yet.");
        });
    });

    describe("#given disabled memory", () => {
        it("returns disabled message for all actions", async () => {
            const disabledTools = createCtxMemoryTools({
                db,
                projectPath: "/repo/project",
                memoryEnabled: false,
            });

            const results = await Promise.all([
                disabledTools.ctx_memory.execute(
                    { action: "write", category: "USER_DIRECTIVES", content: "x" },
                    toolContext(),
                ),
                disabledTools.ctx_memory.execute({ action: "delete", id: 1 }, toolContext()),
                disabledTools.ctx_memory.execute({ action: "promote", id: 1 }, toolContext()),
                disabledTools.ctx_memory.execute({ action: "list" }, toolContext()),
            ]);

            expect(results).toEqual([
                "Cross-session memory is disabled for this project.",
                "Cross-session memory is disabled for this project.",
                "Cross-session memory is disabled for this project.",
                "Cross-session memory is disabled for this project.",
            ]);
        });
    });
});
