/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import {
    archiveMemory,
    clearEmbeddingsForProject,
    deleteEmbedding,
    deleteMemory,
    getMaxMemoryIdForProjects,
    getMemoriesByProject,
    getMemoriesByProjects,
    getMemoryByHash,
    getMemoryById,
    getMemoryCount,
    getProjectEmbeddings,
    getStoredModelId,
    insertMemory,
    loadAllEmbeddings,
    readNewMemoriesForM1Union,
    resetEmbeddingCacheForTests,
    saveEmbedding,
    searchMemoriesFTS,
    searchMemoriesFTSUnion,
    updateMemoryContent,
    updateMemoryRetrievalCount,
    updateMemorySeenCount,
    updateMemoryStatus,
    updateMemoryVerification,
} from "./index";
import { computeNormalizedHash } from "./normalize-hash";

let db: Database;

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
      safety_critical INTEGER,
      UNIQUE(project_path, category, normalized_hash)
    );

    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      model_id TEXT NOT NULL,
      PRIMARY KEY(memory_id, model_id)
    );

    CREATE TABLE IF NOT EXISTS project_state (
      project_path TEXT PRIMARY KEY,
      project_memory_epoch INTEGER NOT NULL DEFAULT 0,
      project_user_profile_version INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
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

afterEach(() => {
    resetEmbeddingCacheForTests();
    if (db) {
        closeQuietly(db);
    }
});

describe("storage-memory", () => {
    describe("#given insert and lookup operations", () => {
        it("#when inserting a memory #then it persists defaults and computed hash", () => {
            db = makeMemoryDatabase();

            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Always use Bun for builds",
                sourceSessionId: "ses-1",
            });

            expect(memory.id).toBe(1);
            expect(memory.normalizedHash).toBe(computeNormalizedHash("Always use Bun for builds"));
            expect(memory.sourceType).toBe("historian");
            expect(memory.status).toBe("active");
            expect(memory.verificationStatus).toBe("unverified");
            expect(memory.seenCount).toBe(1);
            expect(memory.retrievalCount).toBe(0);
            expect(memory.lastRetrievedAt).toBeNull();
        });

        it("#when inserting a memory with sourceType 'user' #then it rejects the write", () => {
            db = makeMemoryDatabase();

            expect(() =>
                insertMemory(db, {
                    projectPath: "/repo/project",
                    category: "USER_DIRECTIVES",
                    content: "Operator-stated rule",
                    sourceType: "user",
                }),
            ).toThrow(/reserved for future dashboard manual entry/);
        });

        it("#when looking up by hash and id #then it returns the matching memory", () => {
            db = makeMemoryDatabase();
            const inserted = insertMemory(db, {
                projectPath: "/repo/project",
                category: "NAMING",
                content: "Use createX factory names",
            });

            const byHash = getMemoryByHash(
                db,
                "/repo/project",
                "NAMING",
                computeNormalizedHash("use createx factory names"),
            );
            const byId = getMemoryById(db, inserted.id);

            expect(byHash?.id).toBe(inserted.id);
            expect(byId?.content).toBe("Use createX factory names");
        });

        it("#when listing by project without statuses #then only active and permanent memories are returned", () => {
            db = makeMemoryDatabase();
            const active = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Keep strict typing enabled",
            });
            const permanent = insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_PREFERENCES",
                content: "Keep answers terse",
            });
            const archived = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Legacy parser can fail on malformed XML",
            });

            updateMemoryStatus(db, permanent.id, "permanent");
            archiveMemory(db, archived.id);

            const memories = getMemoriesByProject(db, "/repo/project");

            expect(memories.map((memory) => memory.id)).toEqual([active.id, permanent.id]);
        });
    });

    describe("#given update operations", () => {
        it("#when incrementing seen and retrieval counters #then timestamps and counters update", () => {
            db = makeMemoryDatabase();
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ARCHITECTURE_DECISIONS",
                content: "Use SQLite for magic-context persistence",
            });

            updateMemorySeenCount(db, memory.id);
            updateMemoryRetrievalCount(db, memory.id);

            const updated = getMemoryById(db, memory.id);

            expect(updated?.seenCount).toBe(2);
            expect(updated?.retrievalCount).toBe(1);
            expect(updated?.lastRetrievedAt).not.toBeNull();
            expect(updated?.updatedAt).toBeGreaterThanOrEqual(memory.updatedAt);
        });

        it("#when updating verification and archive state #then fields persist", () => {
            db = makeMemoryDatabase();
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ENVIRONMENT",
                content: "CI runs on darwin and linux",
            });

            updateMemoryVerification(db, memory.id, "verified");
            archiveMemory(db, memory.id);

            const updated = getMemoryById(db, memory.id);

            expect(updated?.verificationStatus).toBe("verified");
            expect(updated?.verifiedAt).not.toBeNull();
            expect(updated?.status).toBe("archived");
        });

        it("#when archiving with a reason #then metadata stores the archive reason", () => {
            db = makeMemoryDatabase();
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Legacy issue",
            });

            archiveMemory(db, memory.id, "Superseded by new pipeline");

            const updated = getMemoryById(db, memory.id);
            expect(updated?.status).toBe("archived");
            expect(updated?.metadataJson).toContain("Superseded by new pipeline");
        });

        it("#when updating memory content #then normalized hash changes and embeddings are deleted", () => {
            db = makeMemoryDatabase();
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });
            saveEmbedding(db, memory.id, new Float32Array([0.1, 0.2]), "local:model-a");

            updateMemoryContent(
                db,
                memory.id,
                "cache_ttl=10m",
                computeNormalizedHash("cache_ttl=10m"),
            );

            const updated = getMemoryById(db, memory.id);
            expect(updated?.content).toBe("cache_ttl=10m");
            expect(updated?.normalizedHash).toBe(computeNormalizedHash("cache_ttl=10m"));
            expect(loadAllEmbeddings(db, "/repo/project", "local:model-a")).toEqual(new Map());
        });

        it("#when cache-sensitive writes occur #then embedding cache invalidates updated project entries", () => {
            db = makeMemoryDatabase();

            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });
            saveEmbedding(db, memory.id, new Float32Array([0.1, 0.2]), "local:model-a");

            const initialCache = getProjectEmbeddings(db, "/repo/project", "local:model-a");
            expect(Array.from(initialCache.get(memory.id)?.embedding ?? [])).toEqual(
                Array.from(new Float32Array([0.1, 0.2])),
            );

            updateMemoryContent(
                db,
                memory.id,
                "cache_ttl=10m",
                computeNormalizedHash("cache_ttl=10m"),
            );

            const cacheAfterUpdate = getProjectEmbeddings(db, "/repo/project", "local:model-a");
            expect(cacheAfterUpdate.has(memory.id)).toBeFalse();

            const secondMemory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=15m",
            });
            saveEmbedding(db, secondMemory.id, new Float32Array([0.3, 0.4]), "local:model-a");

            const cacheAfterInsert = getProjectEmbeddings(db, "/repo/project", "local:model-a");
            expect(Array.from(cacheAfterInsert.keys())).toEqual([secondMemory.id]);

            deleteMemory(db, secondMemory.id);

            expect(getProjectEmbeddings(db, "/repo/project", "local:model-a")).toEqual(new Map());
        });
    });

    describe("#given FTS search", () => {
        it("#when searching matching content #then it returns project-scoped active memories", () => {
            db = makeMemoryDatabase();
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Always run bun test before finishing",
            });
            const archived = insertMemory(db, {
                projectPath: "/repo/project",
                category: "WORKFLOW_RULES",
                content: "Always run bun test in old workflow",
            });
            insertMemory(db, {
                projectPath: "/repo/other",
                category: "USER_DIRECTIVES",
                content: "Always run bun test before release",
            });
            archiveMemory(db, archived.id);

            const matches = searchMemoriesFTS(db, "/repo/project", "bun");

            expect(matches).toHaveLength(1);
            expect(matches[0].projectPath).toBe("/repo/project");
            expect(matches[0].status).toBe("active");
        });

        it("#when memory content changes or is deleted #then FTS triggers stay in sync", () => {
            db = makeMemoryDatabase();
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "Default cache ttl is 5m",
            });

            db.prepare("UPDATE memories SET content = ?, updated_at = ? WHERE id = ?").run(
                "Default cache ttl is 10m",
                Date.now(),
                memory.id,
            );

            expect(searchMemoriesFTS(db, "/repo/project", "10m")).toHaveLength(1);

            deleteMemory(db, memory.id);

            expect(searchMemoriesFTS(db, "/repo/project", "10m")).toEqual([]);
        });
    });

    it("#when workspace sharing is narrowed #then baseline delta watermark and FTS agree", () => {
        db = makeMemoryDatabase();
        const ownRule = insertMemory(db, {
            projectPath: "/repo/own",
            category: "PROJECT_RULES",
            content: "own rule needle",
        });
        const ownAlias = insertMemory(db, {
            projectPath: "/repo/own-legacy",
            category: "NAMING",
            content: "own legacy alias needle",
        });
        const foreignShared = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "CONSTRAINTS",
            content: "foreign shared needle",
        });
        const foreignHidden = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "NAMING",
            content: "foreign hidden needle",
        });
        const identities = ["/repo/own", "/repo/own-legacy", "/repo/foreign"];
        const ownIdentities = ["/repo/own", "/repo/own-legacy"];

        const sharedArgs = [ownIdentities, ["CONSTRAINTS"]] as const;
        const visibleIds = getMemoriesByProjects(
            db,
            identities,
            ["active", "permanent"],
            Date.now(),
            ...sharedArgs,
        )
            .map((memory) => memory.id)
            .sort((left, right) => left - right);
        expect(visibleIds).toEqual([ownRule.id, ownAlias.id, foreignShared.id]);
        expect(
            readNewMemoriesForM1Union(db, identities, ownRule.id, Date.now(), ...sharedArgs)
                .map((memory) => memory.id)
                .sort((left, right) => left - right),
        ).toEqual([ownAlias.id, foreignShared.id]);
        expect(getMaxMemoryIdForProjects(db, identities, ...sharedArgs)).toBe(foreignShared.id);
        expect(
            searchMemoriesFTSUnion(db, identities, "needle", 10, ...sharedArgs)
                .map((memory) => memory.id)
                .sort((left, right) => left - right),
        ).toEqual([ownRule.id, ownAlias.id, foreignShared.id]);

        const ownOnlyArgs = [ownIdentities, []] as const;
        expect(
            getMemoriesByProjects(
                db,
                identities,
                ["active", "permanent"],
                Date.now(),
                ...ownOnlyArgs,
            )
                .map((memory) => memory.id)
                .sort((left, right) => left - right),
        ).toEqual([ownRule.id, ownAlias.id]);
        expect(getMaxMemoryIdForProjects(db, identities, ...ownOnlyArgs)).toBe(ownAlias.id);

        const allIds = getMemoriesByProjects(
            db,
            identities,
            ["active", "permanent"],
            Date.now(),
            ownIdentities,
            null,
        )
            .map((memory) => memory.id)
            .sort((left, right) => left - right);
        expect(allIds).toEqual([ownRule.id, ownAlias.id, foreignShared.id, foreignHidden.id]);
        expect(getMaxMemoryIdForProjects(db, identities, ownIdentities, null)).toBe(
            foreignHidden.id,
        );
    });

    describe("#given embedding storage", () => {
        it("#when saving, loading, and deleting embeddings #then blob values round-trip by project", () => {
            db = makeMemoryDatabase();
            const memoryA = insertMemory(db, {
                projectPath: "/repo/project",
                category: "NAMING",
                content: "Prefer createMemoryStore naming",
            });
            const memoryB = insertMemory(db, {
                projectPath: "/repo/other",
                category: "NAMING",
                content: "Prefer createOther naming",
            });

            saveEmbedding(db, memoryA.id, new Float32Array([0.25, 0.5, 0.75]), "local:model-a");
            saveEmbedding(db, memoryB.id, new Float32Array([1, 2, 3]), "local:model-a");

            const embeddings = loadAllEmbeddings(db, "/repo/project", "local:model-a");

            expect(Array.from(embeddings.keys())).toEqual([memoryA.id]);
            expect(Array.from(embeddings.get(memoryA.id)?.embedding ?? [])).toEqual([
                0.25, 0.5, 0.75,
            ]);
            expect(getStoredModelId(db, "/repo/project")).toBe("local:model-a");

            deleteEmbedding(db, memoryA.id);

            expect(loadAllEmbeddings(db, "/repo/project", "local:model-a")).toEqual(new Map());
        });

        it("#when clearing all embeddings #then stored vectors and model id are removed", () => {
            db = makeMemoryDatabase();
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "NAMING",
                content: "Prefer createMemoryStore naming",
            });

            saveEmbedding(db, memory.id, new Float32Array([0.25, 0.5, 0.75]), "local:model-b");

            clearEmbeddingsForProject(db, "/repo/project");

            expect(loadAllEmbeddings(db, "/repo/project", "local:model-b")).toEqual(new Map());
            expect(getStoredModelId(db, "/repo/project")).toBeNull();
        });

        it("#when clearing embeddings for one project #then other projects' embeddings are preserved", () => {
            db = makeMemoryDatabase();
            const memoryA = insertMemory(db, {
                projectPath: "/repo/project-a",
                category: "NAMING",
                content: "Project A naming",
            });
            const memoryB = insertMemory(db, {
                projectPath: "/repo/project-b",
                category: "NAMING",
                content: "Project B naming",
            });

            saveEmbedding(db, memoryA.id, new Float32Array([1, 2, 3]), "local:model-x");
            saveEmbedding(db, memoryB.id, new Float32Array([4, 5, 6]), "local:model-x");

            clearEmbeddingsForProject(db, "/repo/project-a");

            expect(loadAllEmbeddings(db, "/repo/project-a", "local:model-x")).toEqual(new Map());
            expect(getStoredModelId(db, "/repo/project-a")).toBeNull();
            expect(loadAllEmbeddings(db, "/repo/project-b", "local:model-x").size).toBe(1);
            expect(getStoredModelId(db, "/repo/project-b")).toBe("local:model-x");
        });
    });

    describe("#given count and delete operations", () => {
        it("#when counting and deleting memories #then counts reflect scope changes", () => {
            db = makeMemoryDatabase();
            const memoryA = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "No as any",
            });
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_PREFERENCES",
                content: "Answer densely",
            });
            insertMemory(db, {
                projectPath: "/repo/other",
                category: "ENVIRONMENT",
                content: "Uses Bun 1.3",
            });

            expect(getMemoryCount(db)).toBe(3);
            expect(getMemoryCount(db, "/repo/project")).toBe(2);

            deleteMemory(db, memoryA.id);

            expect(getMemoryCount(db)).toBe(2);
            expect(getMemoryById(db, memoryA.id)).toBeNull();
        });
    });
});
