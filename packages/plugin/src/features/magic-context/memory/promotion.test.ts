/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { CATEGORY_DEFAULT_TTL } from "./constants";
import type { EmbeddingProvider } from "./embedding-provider";
import { computeNormalizedHash } from "./normalize-hash";

const mockLog = mock(() => {});

mock.module("../../../shared/logger", () => ({
    log: mockLog,
    sessionLog: mockLog,
    getLogFilePath: () => "/tmp/test.log",
}));

const {
    archiveMemory,
    getMemoryByHash,
    getMemoryById,
    getMemoryCount,
    getMemoriesByProject,
    insertMemory,
} = await import("./storage-memory");
const { embedPromotedFacts, promoteSessionFactsDurable } = await import("./promotion");
const {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    registerProjectEmbedding,
} = await import("./embedding");
const { runMigrations } = await import("../migrations");
const { initializeDatabase } = await import("../storage-db");

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
      memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      model_id TEXT NOT NULL,
      PRIMARY KEY(memory_id, model_id)
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
    _resetProjectEmbeddingRegistryForTests();
    _setTestProviderFactoryForProject(null);
});

describe("promotion", () => {
    describe("#given promotable facts", () => {
        it("promotes a new ARCHITECTURE_DECISIONS fact", () => {
            db = makeMemoryDatabase();

            promoteSessionFactsDurable(db, "ses-1", "/repo/project", [
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

            promoteSessionFactsDurable(db, "ses-1", "/repo/project", [
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

            promoteSessionFactsDurable(db, "ses-1", "/repo/project", [
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

            promoteSessionFactsDurable(db, "ses-1", "/repo/project", [
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

            promoteSessionFactsDurable(db, "ses-1", "/repo/project", [
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

            promoteSessionFactsDurable(db, "ses-1", "/repo/project", [
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

            promoteSessionFactsDurable(db, "ses-1", "/repo/project", [
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

            promoteSessionFactsDurable(db, "ses-2", "/repo/project", [
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

            promoteSessionFactsDurable(db, "ses-2", "/repo/project", [
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

            promoteSessionFactsDurable(db, "ses-2", "/repo/project", [
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

            promoteSessionFactsDurable(db, "ses-1", "/repo/project", [
                { category: "SESSION_NOTES", content: "This should remain session-local" },
            ]);

            expect(getMemoryCount(db)).toBe(0);
        });

        it("skips facts with unknown categories", () => {
            db = makeMemoryDatabase();

            promoteSessionFactsDurable(db, "ses-1", "/repo/project", [
                { category: "UNKNOWN_CATEGORY", content: "Ignore me" },
            ]);

            expect(getMemoryCount(db)).toBe(0);
        });
    });

    describe("#given error handling", () => {
        it("propagates when a durable DB write fails", () => {
            const closedDb = makeMemoryDatabase();
            db = closedDb;
            closeQuietly(closedDb);

            expect(() =>
                promoteSessionFactsDurable(closedDb, "ses-1", "/repo/project", [
                    { category: "ARCHITECTURE_DECISIONS", content: "This write will fail" },
                ]),
            ).toThrow();
        });

        it("does not swallow or log durable storage failures", () => {
            const closedDb = makeMemoryDatabase();
            db = closedDb;
            closeQuietly(closedDb);
            db = null;

            expect(() =>
                promoteSessionFactsDurable(closedDb, "ses-1", "/repo/project", [
                    { category: "ARCHITECTURE_DECISIONS", content: "This write will fail" },
                ]),
            ).toThrow();
            expect(mockLog).not.toHaveBeenCalled();
        });
    });

    // ACCEPTED BEHAVIOR (audit decision): archiving a memory is a deliberate
    // dreamer/user suppression, so re-observing the same fact must NOT silently
    // revive it. getMemoryByHash matches the archived row by (project,category,
    // hash), bumps its seen_count (recurrence is still recorded), and does not
    // re-insert or un-archive. Revival happens only through an explicit restore
    // (which bumps the project epoch). This test locks that contract.
    describe("#given a previously-archived fact is re-observed", () => {
        it("dedupe matches the archived row and does NOT revive it (archive is deliberate)", () => {
            db = makeMemoryDatabase();
            const content = "Use SQLite for cross-session memory";
            const hash = computeNormalizedHash(content);

            // 1) Promote, then archive (e.g. dreamer archived it as stale).
            promoteSessionFactsDurable(db, "ses-1", "/repo/project", [
                { category: "ARCHITECTURE_DECISIONS", content },
            ]);
            const original = getMemoryByHash(db, "/repo/project", "ARCHITECTURE_DECISIONS", hash);
            expect(original).not.toBeNull();
            archiveMemory(db, original!.id);
            expect(getMemoryById(db, original!.id)?.status).toBe("archived");

            // 2) Historian re-observes the same fact in a later session.
            promoteSessionFactsDurable(db, "ses-2", "/repo/project", [
                { category: "ARCHITECTURE_DECISIONS", content },
            ]);

            // The archived row's seen_count is bumped; no new active row inserted.
            const same = getMemoryById(db, original!.id);
            expect(same?.status).toBe("archived"); // NOT revived
            expect(same?.seenCount).toBe(2); // re-observation counted
            expect(getMemoryCount(db, "/repo/project")).toBe(1); // no duplicate insert
            // → the re-observed fact is invisible to active rendering despite recurrence.
            expect(getMemoriesByProject(db, "/repo/project")).toHaveLength(0);
        });
    });

    describe("#given best-effort embedding of promoted facts", () => {
        it("stores the vector under the registered model when the memory is unchanged", async () => {
            _resetProjectEmbeddingRegistryForTests();

            db = new Database(":memory:");
            initializeDatabase(db);
            runMigrations(db);
            const snapshot = registerProjectEmbedding(
                db,
                "/repo/project",
                { provider: "local", model: "mock-model" },
                { memoryEnabled: true, gitCommitEnabled: false },
                "/repo/project",
            );
            _setTestProviderFactoryForProject(
                (): EmbeddingProvider => ({
                    modelId: "mock:model",
                    initialize: async () => true,
                    embed: async (_text: string) => new Float32Array([1, 2]),
                    embedBatch: async (texts: string[]) =>
                        texts.map(() => new Float32Array([1, 2])),
                    dispose: async () => {},
                    isLoaded: () => true,
                }),
            );

            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ARCHITECTURE_DECISIONS",
                content: "Embed promoted facts eagerly",
            });

            await embedPromotedFacts(db, "ses-1", "/repo/project", [
                { memoryId: memory.id, content: memory.content },
            ]);

            const rows = db.prepare("SELECT model_id FROM memory_embeddings").all() as Array<{
                model_id: string;
            }>;
            expect(rows).toHaveLength(1);
            expect(rows[0].model_id).toBe(snapshot.modelId);
        });

        it("discards the stale vector when the memory is edited while embedding is in flight", async () => {
            _resetProjectEmbeddingRegistryForTests();

            db = new Database(":memory:");
            initializeDatabase(db);
            runMigrations(db);
            registerProjectEmbedding(
                db,
                "/repo/project",
                { provider: "local", model: "mock-model" },
                { memoryEnabled: true, gitCommitEnabled: false },
                "/repo/project",
            );

            let resolveStarted: (() => void) | undefined;
            const started = new Promise<void>((resolve) => {
                resolveStarted = resolve;
            });
            let releaseBlocker: (() => void) | undefined;
            const blocker = new Promise<void>((resolve) => {
                releaseBlocker = resolve;
            });
            _setTestProviderFactoryForProject(
                (): EmbeddingProvider => ({
                    modelId: "mock:model",
                    initialize: async () => true,
                    embed: async (_text: string): Promise<Float32Array> => {
                        resolveStarted?.();
                        await blocker;
                        return new Float32Array([1, 2]);
                    },
                    embedBatch: async (texts: string[]) =>
                        texts.map(() => new Float32Array([1, 2])),
                    dispose: async () => {},
                    isLoaded: () => true,
                }),
            );

            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ARCHITECTURE_DECISIONS",
                content: "Original promoted content",
            });

            const inFlight = embedPromotedFacts(db, "ses-1", "/repo/project", [
                { memoryId: memory.id, content: memory.content },
            ]);
            await started;
            // Edit the memory while the provider call is in flight: the vector
            // about to arrive was computed from the ORIGINAL content.
            db.prepare(
                "UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ? WHERE id = ?",
            ).run("Edited promoted content", "edited-hash", Date.now(), memory.id);
            releaseBlocker?.();
            await inFlight;

            const count = (
                db.prepare("SELECT COUNT(*) AS count FROM memory_embeddings").get() as {
                    count: number;
                }
            ).count;
            expect(count).toBe(0);
        });
    });
});
