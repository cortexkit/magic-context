import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { getMemoryById, insertMemory, saveEmbedding } from "../../features/magic-context/memory";

let queryEmbedding: Float32Array | null = null;
const embeddingQueries: string[] = [];

mock.module("../../features/magic-context/memory/embedding", () => ({
    embedText: async (text: string) => {
        embeddingQueries.push(text);
        return queryEmbedding ? new Float32Array(queryEmbedding) : null;
    },
    cosineSimilarity: (a: Float32Array, b: Float32Array) => {
        if (a.length !== b.length) {
            return 0;
        }

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let index = 0; index < a.length; index++) {
            dotProduct += a[index]! * b[index]!;
            normA += a[index]! * a[index]!;
            normB += b[index]! * b[index]!;
        }

        const denominator = Math.sqrt(normA) * Math.sqrt(normB);
        return denominator === 0 ? 0 : dotProduct / denominator;
    },
}));

const { createCtxRecallTools } = await import("./tools");

function createTestDb(): Database {
    const db = new Database(":memory:");
    db.run(`
    CREATE TABLE memories (
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

    CREATE TABLE memory_embeddings (
      memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL
    );

    CREATE VIRTUAL TABLE memories_fts USING fts5(
      content,
      category,
      content='memories',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
    END;

    CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
    END;

    CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
      INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
    END;
  `);
    return db;
}

function toolContext() {
    return { sessionID: "ses-recall" } as never;
}

afterEach(() => {
    queryEmbedding = null;
    embeddingQueries.length = 0;
});

afterAll(() => {
    mock.restore();
});

describe("createCtxRecallTools", () => {
    describe("#given hybrid retrieval", () => {
        it("returns semantic results when embeddings available", async () => {
            const db = createTestDb();
            try {
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
                saveEmbedding(db, semanticMatch.id, new Float32Array([1, 0]));

                queryEmbedding = new Float32Array([1, 0]);
                const tools = createCtxRecallTools({
                    db,
                    projectPath: "/repo/project",
                    memoryEnabled: true,
                    embeddingProvider: "mock",
                });

                const result = await tools.ctx_recall.execute(
                    { query: "cross-session retrieval policy" },
                    toolContext(),
                );

                expect(result).toContain(
                    'Found 1 memory matching "cross-session retrieval policy"',
                );
                expect(result).toContain("[ARCHITECTURE_DECISIONS]");
                expect(result).toContain("Magic-context stores architecture decisions in SQLite.");
                expect(result).toContain("score: 0.80");
                expect(embeddingQueries).toEqual(["cross-session retrieval policy"]);
                expect(getMemoryById(db, semanticMatch.id)?.retrievalCount).toBe(1);
            } finally {
                db.close(false);
            }
        });

        it("falls back to FTS5-only when embedding provider is off", async () => {
            const db = createTestDb();
            try {
                insertMemory(db, {
                    projectPath: "/repo/project",
                    category: "CONSTRAINTS",
                    content: "Historian must not summarize the last five meaningful user turns.",
                });

                const tools = createCtxRecallTools({
                    db,
                    projectPath: "/repo/project",
                    memoryEnabled: true,
                    embeddingProvider: "off",
                });

                const result = await tools.ctx_recall.execute(
                    { query: "Historian summarize" },
                    toolContext(),
                );

                expect(result).toContain('Found 1 memory matching "Historian summarize"');
                expect(result).toContain("[CONSTRAINTS]");
                expect(result).toContain("score: 0.80");
                expect(embeddingQueries).toEqual([]);
            } finally {
                db.close(false);
            }
        });

        it("combines semantic and FTS5 scores", async () => {
            const db = createTestDb();
            try {
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

                saveEmbedding(db, semanticOnly.id, new Float32Array([0.95, 0.31]));
                saveEmbedding(db, hybridWinner.id, new Float32Array([1, 0]));
                queryEmbedding = new Float32Array([1, 0]);

                const tools = createCtxRecallTools({
                    db,
                    projectPath: "/repo/project",
                    memoryEnabled: true,
                    embeddingProvider: "mock",
                });

                const result = await tools.ctx_recall.execute({ query: "run bun" }, toolContext());
                const semanticIndex = result.indexOf(semanticOnly.content);
                const winnerIndex = result.indexOf("Always run bun test before merge.");
                const ftsOnlyIndex = result.indexOf(ftsOnly.content);

                expect(result).toContain("score: 0.85");
                expect(result).toContain("score: 0.80");
                expect(result).toContain("score: 0.76");
                expect(semanticIndex).toBeGreaterThan(-1);
                expect(winnerIndex).toBeGreaterThan(-1);
                expect(ftsOnlyIndex).toBeGreaterThan(-1);
                expect(winnerIndex).toBeLessThan(semanticIndex);
                expect(ftsOnlyIndex).toBeLessThan(semanticIndex);
            } finally {
                db.close(false);
            }
        });

        it("increments retrieval_count for returned results", async () => {
            const db = createTestDb();
            try {
                const memory = insertMemory(db, {
                    projectPath: "/repo/project",
                    category: "CONFIG_DEFAULTS",
                    content: "Default cache TTL is five minutes.",
                });

                const tools = createCtxRecallTools({
                    db,
                    projectPath: "/repo/project",
                    memoryEnabled: true,
                    embeddingProvider: "off",
                });

                await tools.ctx_recall.execute({ query: "cache TTL" }, toolContext());

                expect(getMemoryById(db, memory.id)?.retrievalCount).toBe(1);
            } finally {
                db.close(false);
            }
        });

        it("respects limit parameter", async () => {
            const db = createTestDb();
            try {
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
                saveEmbedding(db, first.id, new Float32Array([1, 0]));
                saveEmbedding(db, second.id, new Float32Array([0.6, 0.8]));
                queryEmbedding = new Float32Array([1, 0]);

                const tools = createCtxRecallTools({
                    db,
                    projectPath: "/repo/project",
                    memoryEnabled: true,
                    embeddingProvider: "mock",
                });

                const result = await tools.ctx_recall.execute(
                    { query: "cross-session memory ranking", limit: 1 },
                    toolContext(),
                );

                expect(result).toContain('Found 1 memory matching "cross-session memory ranking"');
                expect(result).toContain(first.content);
                expect(result).not.toContain(second.content);
                expect(getMemoryById(db, first.id)?.retrievalCount).toBe(1);
                expect(getMemoryById(db, second.id)?.retrievalCount).toBe(0);
            } finally {
                db.close(false);
            }
        });
    });

    describe("#given category filter", () => {
        it("filters results by category when specified", async () => {
            const db = createTestDb();
            try {
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

                const tools = createCtxRecallTools({
                    db,
                    projectPath: "/repo/project",
                    memoryEnabled: true,
                    embeddingProvider: "off",
                });

                const result = await tools.ctx_recall.execute(
                    {
                        query: "SQLite",
                        category: "CONSTRAINTS",
                    },
                    toolContext(),
                );

                expect(result).toContain('Found 1 memory matching "SQLite"');
                expect(result).toContain("[CONSTRAINTS]");
                expect(result).not.toContain("[ARCHITECTURE_DECISIONS]");
            } finally {
                db.close(false);
            }
        });
    });

    describe("#given no results", () => {
        it("returns empty message when no memories match", async () => {
            const db = createTestDb();
            try {
                insertMemory(db, {
                    projectPath: "/repo/project",
                    category: "ENVIRONMENT",
                    content: "CI runs on darwin and linux.",
                });

                const tools = createCtxRecallTools({
                    db,
                    projectPath: "/repo/project",
                    memoryEnabled: true,
                    embeddingProvider: "off",
                });

                const result = await tools.ctx_recall.execute(
                    { query: "windows gpu" },
                    toolContext(),
                );

                expect(result).toBe('No memories found matching "windows gpu".');
            } finally {
                db.close(false);
            }
        });
    });

    describe("#given disabled memory", () => {
        it("returns disabled message when memory is not enabled", async () => {
            const db = createTestDb();
            try {
                const tools = createCtxRecallTools({
                    db,
                    projectPath: "/repo/project",
                    memoryEnabled: false,
                    embeddingProvider: "mock",
                });

                const result = await tools.ctx_recall.execute(
                    { query: "architecture" },
                    toolContext(),
                );

                expect(result).toBe("Project memory is disabled. Enable memory to use ctx_recall.");
            } finally {
                db.close(false);
            }
        });
    });
});
