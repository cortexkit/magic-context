/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { CATEGORY_DEFAULT_TTL } from "./constants";
import { computeNormalizedHash } from "./normalize-hash";

const mockEmbedText = mock(async () => null);
const mockLog = mock(() => {});

mock.module("./embedding", () => ({
    embedText: mockEmbedText,
    getEmbeddingModelId: () => "mock:model",
}));

mock.module("../../../shared/logger", () => ({
    log: mockLog,
    sessionLog: mockLog,
    getLogFilePath: () => "/tmp/test.log",
}));

const { getMemoryByHash, getMemoryById, getMemoryCount, insertMemory } = await import(
    "./storage-memory"
);
const { promoteSessionFactsToMemory } = await import("./promotion");

let db: Database | null = null;

function makeMemoryDatabase(): Database {
    const database = new Database(":memory:");
    database.exec(`
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
      embedding BLOB NOT NULL,
      model_id TEXT
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
    return database;
}

beforeEach(() => {
    mockEmbedText.mockReset();
    mockEmbedText.mockImplementation(async () => null);
    mockLog.mockReset();
    mockLog.mockImplementation(() => {});
});

afterEach(() => {
    if (db) {
        try {
            closeQuietly(db);
        } catch {
        } finally {
            db = null;
        }
    }
});

describe("promotion", () => {
    describe("#given promotable facts", () => {
        it("promotes a new ARCHITECTURE_DECISIONS fact", () => {
            db = makeMemoryDatabase();

            promoteSessionFactsToMemory(db, "ses-1", "/repo/project", [
                {
                    category: "ARCHITECTURE_DECISIONS",
                    content: "Use SQLite for cross-session memory",
                },
            ]);

            const memory = getMemoryByHash(
                db,
                "/repo/project",
                "ARCHITECTURE_DECISIONS",
                computeNormalizedHash("Use SQLite for cross-session memory"),
            );

            expect(memory).not.toBeNull();
            expect(memory?.sourceSessionId).toBe("ses-1");
            expect(memory?.sourceType).toBe("historian");
            expect(memory?.seenCount).toBe(1);
        });

        it("sets correct project path for project-scoped categories", () => {
            db = makeMemoryDatabase();

            promoteSessionFactsToMemory(db, "ses-1", "/repo/project", [
                { category: "CONSTRAINTS", content: "Never use npm in this repo" },
            ]);

            const memory = getMemoryByHash(
                db,
                "/repo/project",
                "CONSTRAINTS",
                computeNormalizedHash("Never use npm in this repo"),
            );

            expect(memory?.projectPath).toBe("/repo/project");
        });

        it("stores USER_PREFERENCES under project path", () => {
            db = makeMemoryDatabase();

            promoteSessionFactsToMemory(db, "ses-1", "/repo/project", [
                { category: "USER_PREFERENCES", content: "Prefer concise answers" },
            ]);

            const memory = getMemoryByHash(
                db,
                "/repo/project",
                "USER_PREFERENCES",
                computeNormalizedHash("Prefer concise answers"),
            );

            expect(memory?.projectPath).toBe("/repo/project");
        });

        it("stores USER_DIRECTIVES under project path", () => {
            db = makeMemoryDatabase();

            promoteSessionFactsToMemory(db, "ses-1", "/repo/project", [
                { category: "USER_DIRECTIVES", content: "Run tests before finishing" },
            ]);

            const memory = getMemoryByHash(
                db,
                "/repo/project",
                "USER_DIRECTIVES",
                computeNormalizedHash("Run tests before finishing"),
            );

            expect(memory?.projectPath).toBe("/repo/project");
        });

        it("sets expires_at for WORKFLOW_RULES based on TTL", () => {
            db = makeMemoryDatabase();
            const nowSpy = spyOn(Date, "now").mockReturnValue(10_000);

            promoteSessionFactsToMemory(db, "ses-1", "/repo/project", [
                { category: "WORKFLOW_RULES", content: "Run bun test before release" },
            ]);

            const memory = getMemoryByHash(
                db,
                "/repo/project",
                "WORKFLOW_RULES",
                computeNormalizedHash("Run bun test before release"),
            );

            expect(memory?.expiresAt).toBe(10_000 + CATEGORY_DEFAULT_TTL.WORKFLOW_RULES!);
            nowSpy.mockRestore();
        });

        it("sets expires_at for KNOWN_ISSUES based on TTL", () => {
            db = makeMemoryDatabase();
            const nowSpy = spyOn(Date, "now").mockReturnValue(20_000);

            promoteSessionFactsToMemory(db, "ses-1", "/repo/project", [
                { category: "KNOWN_ISSUES", content: "Historian can retry on malformed XML" },
            ]);

            const memory = getMemoryByHash(
                db,
                "/repo/project",
                "KNOWN_ISSUES",
                computeNormalizedHash("Historian can retry on malformed XML"),
            );

            expect(memory?.expiresAt).toBe(20_000 + CATEGORY_DEFAULT_TTL.KNOWN_ISSUES!);
            nowSpy.mockRestore();
        });

        it("does not set expires_at for permanent categories", () => {
            db = makeMemoryDatabase();

            promoteSessionFactsToMemory(db, "ses-1", "/repo/project", [
                {
                    category: "ARCHITECTURE_DECISIONS",
                    content: "Keep modules under 200 LOC when possible",
                },
            ]);

            const memory = getMemoryByHash(
                db,
                "/repo/project",
                "ARCHITECTURE_DECISIONS",
                computeNormalizedHash("Keep modules under 200 LOC when possible"),
            );

            expect(memory?.expiresAt).toBeNull();
        });
    });

    describe("#given duplicate detection", () => {
        it("increments seen_count for existing memory with same hash", () => {
            db = makeMemoryDatabase();
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "NAMING",
                content: "Use createX naming for factories",
            });

            promoteSessionFactsToMemory(db, "ses-2", "/repo/project", [
                { category: "NAMING", content: "use createx naming for factories" },
            ]);

            const memory = getMemoryByHash(
                db,
                "/repo/project",
                "NAMING",
                computeNormalizedHash("Use createX naming for factories"),
            );

            expect(memory?.seenCount).toBe(2);
        });

        it("does not create duplicate when hash matches", () => {
            db = makeMemoryDatabase();
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "ENVIRONMENT",
                content: "CI runs with Bun",
            });

            promoteSessionFactsToMemory(db, "ses-2", "/repo/project", [
                { category: "ENVIRONMENT", content: " ci   runs with bun " },
            ]);

            expect(getMemoryCount(db)).toBe(1);
        });

        it("updates last_seen_at when seen again", () => {
            db = makeMemoryDatabase();
            const nowSpy = spyOn(Date, "now");
            nowSpy.mockReturnValueOnce(1_000);
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "Default timeout is 5s",
            });
            nowSpy.mockReturnValueOnce(2_000);

            promoteSessionFactsToMemory(db, "ses-2", "/repo/project", [
                { category: "CONFIG_DEFAULTS", content: "default timeout is 5s" },
            ]);

            const updated = getMemoryById(db, memory.id);

            expect(updated?.lastSeenAt).toBe(2_000);
            expect(updated?.updatedAt).toBe(2_000);
            nowSpy.mockRestore();
        });
    });

    describe("#given non-promotable facts", () => {
        it("skips SESSION_NOTES category", () => {
            db = makeMemoryDatabase();

            promoteSessionFactsToMemory(db, "ses-1", "/repo/project", [
                { category: "SESSION_NOTES", content: "This should remain session-local" },
            ]);

            expect(getMemoryCount(db)).toBe(0);
        });

        it("skips facts with unknown categories", () => {
            db = makeMemoryDatabase();

            promoteSessionFactsToMemory(db, "ses-1", "/repo/project", [
                { category: "UNKNOWN_CATEGORY", content: "Ignore me" },
            ]);

            expect(getMemoryCount(db)).toBe(0);
        });
    });

    describe("#given error handling", () => {
        it("does not throw when DB write fails", () => {
            const closedDb = makeMemoryDatabase();
            db = closedDb;
            closeQuietly(closedDb);

            expect(() =>
                promoteSessionFactsToMemory(closedDb, "ses-1", "/repo/project", [
                    { category: "ARCHITECTURE_DECISIONS", content: "This write will fail" },
                ]),
            ).not.toThrow();
        });

        it("logs error when promotion fails", () => {
            const closedDb = makeMemoryDatabase();
            db = closedDb;
            closeQuietly(closedDb);
            db = null;

            promoteSessionFactsToMemory(closedDb, "ses-1", "/repo/project", [
                { category: "ARCHITECTURE_DECISIONS", content: "This write will fail" },
            ]);

            expect(mockLog).toHaveBeenCalledTimes(1);
            const loggedMessages = mockLog.mock.calls.map((call) => call.join(" "));
            // Note: mock receives raw sessionLog args (sessionId + message + error), without
            // the "[magic-context][sessionId]" prefix that the real sessionLog would prepend.
            // This test verifies the promotion code passes the right session id and message.
            expect(
                loggedMessages.some(
                    (message) =>
                        message.startsWith("ses-1 memory promotion failed for fact") &&
                        message.includes("This write will fail"),
                ),
            ).toBe(true);
        });
    });
});
