import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { DREAMER_AGENT } from "../../agents/dreamer";
import {
    computeNormalizedHash,
    getMemoriesByProject,
    getMemoryById,
    getMemoryMutationsForRender,
    getMemoryVerifications,
    getProjectState,
    getUnclassifiedMemoryIds,
    insertMemory,
    insertMemoryIdempotent,
    normalizeStoredProjectPath,
    recordMemoryMapping,
    setMemoryClassification,
} from "../../features/magic-context";
import { takeCurateSafetyRefusalCount } from "../../features/magic-context/dreamer/curate-memory-safety";
import { writeTaskStateJson } from "../../features/magic-context/dreamer/storage-task-schedule";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    type ProjectEmbeddingRegistrationSnapshot,
    registerProjectEmbedding,
} from "../../features/magic-context/memory/embedding";
import type {
    EmbeddingProvider,
    EmbeddingPurpose,
} from "../../features/magic-context/memory/embedding-provider";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import { getMemoriesForList } from "../../features/magic-context/memory/storage-memory";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";

const { createCtxMemoryListTools, createCtxMemoryTools } = await import("./tools");

import { installMemoryLifecycleSchema } from "../../features/magic-context/migration-v99-memory-lifecycle";

function createTestDb(dbPath = ":memory:"): Database {
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE IF NOT EXISTS authority_managed (
            project_path TEXT PRIMARY KEY,
            context_store_uuid TEXT NOT NULL,
            marked_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memories
        (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path            TEXT    NOT NULL,
            category                TEXT    NOT NULL,
            content                 TEXT    NOT NULL,
            normalized_hash         TEXT    NOT NULL,
            importance              INTEGER NOT NULL DEFAULT 50,
            scope                   TEXT    NOT NULL DEFAULT 'project',
            shareable               INTEGER NOT NULL DEFAULT 0,
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
            classified_at           INTEGER,
            superseded_by_memory_id INTEGER,
            merged_from             TEXT,
            metadata_json           TEXT,
            UNIQUE (project_path, category, normalized_hash)
        );

        CREATE TABLE IF NOT EXISTS memory_embeddings
        (
            memory_id INTEGER NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
            embedding BLOB NOT NULL,
            model_id  TEXT NOT NULL,
            PRIMARY KEY (memory_id, model_id)
        );

        CREATE TABLE IF NOT EXISTS embedding_identity_active (
            project_path   TEXT NOT NULL,
            scope          TEXT NOT NULL,
            model_id       TEXT NOT NULL,
            last_active_at INTEGER NOT NULL,
            PRIMARY KEY (project_path, scope, model_id)
        );

        CREATE TABLE IF NOT EXISTS session_projects (
            session_id   TEXT NOT NULL,
            harness      TEXT NOT NULL DEFAULT 'opencode',
            project_path TEXT NOT NULL,
            updated_at   INTEGER NOT NULL,
            PRIMARY KEY (session_id, harness)
        );

        CREATE TABLE IF NOT EXISTS compartment_chunk_embeddings (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            compartment_id INTEGER NOT NULL,
            session_id     TEXT NOT NULL,
            project_path   TEXT NOT NULL,
            harness        TEXT NOT NULL DEFAULT 'opencode',
            window_index   INTEGER NOT NULL DEFAULT 0,
            start_ordinal  INTEGER NOT NULL DEFAULT 0,
            end_ordinal    INTEGER NOT NULL DEFAULT 0,
            chunk_hash     TEXT NOT NULL DEFAULT '',
            model_id       TEXT NOT NULL DEFAULT '',
            dims           INTEGER NOT NULL DEFAULT 0,
            vector         BLOB NOT NULL DEFAULT X'',
            created_at     INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS memory_verifications (
            memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            file_path TEXT NOT NULL,
            verified_at INTEGER NOT NULL,
            mapped_at INTEGER NOT NULL DEFAULT 0,
            mapping_origin TEXT NOT NULL DEFAULT 'mapper',
            PRIMARY KEY (memory_id, file_path)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_verifications_memory ON memory_verifications(memory_id);

        CREATE TABLE IF NOT EXISTS task_schedule_state (
            project_path TEXT NOT NULL,
            task TEXT NOT NULL,
            last_run_at INTEGER,
            next_due_at INTEGER,
            schedule TEXT,
            last_status TEXT,
            last_error TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0,
            last_checked_commit TEXT,
            last_broad_run_at INTEGER,
            retrospective_watermark_ms INTEGER,
            PRIMARY KEY(project_path, task)
        );

        CREATE TABLE IF NOT EXISTS project_state
        (
            project_path                 TEXT PRIMARY KEY,
            project_memory_epoch         INTEGER NOT NULL DEFAULT 0,
            project_user_profile_version INTEGER NOT NULL DEFAULT 0,
            updated_at                   INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memory_mutation_log
        (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path     TEXT NOT NULL,
            mutation_type    TEXT NOT NULL,
            target_memory_id INTEGER NOT NULL,
            superseded_by_id INTEGER,
            category         TEXT,
            new_content      TEXT,
            queued_at        INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_project
            ON memory_mutation_log(project_path, id);

        CREATE TABLE IF NOT EXISTS workspaces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            share_categories TEXT
        );

        CREATE TABLE IF NOT EXISTS workspace_members (
            workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            project_path TEXT NOT NULL,
            display_name TEXT NOT NULL,
            display_path TEXT NOT NULL,
            added_at INTEGER NOT NULL,
            PRIMARY KEY (workspace_id, project_path)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_unique ON workspace_members(project_path);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_name ON workspace_members(workspace_id, display_name);

        CREATE TABLE IF NOT EXISTS v22_identity_rekey_map (
            old_project_path TEXT PRIMARY KEY,
            new_project_path TEXT NOT NULL,
            rekeyed_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS mirror_identity (
            domain TEXT NOT NULL,
            module_project TEXT NOT NULL,
            module_row_id INTEGER NOT NULL,
            context_row_id INTEGER NOT NULL,
            PRIMARY KEY (domain, module_project, module_row_id)
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
    db.exec("CREATE TABLE IF NOT EXISTS authority_repair_pending(project_path TEXT PRIMARY KEY)");
    installMemoryLifecycleSchema(db);
    return db;
}

function expectPendingProposal(
    db: Database,
    result: unknown,
    memories: Array<NonNullable<ReturnType<typeof getMemoryById>>>,
): void {
    expect(String(result)).toContain("MEMORY_PENDING_PROPOSAL");
    for (const memory of memories) expect(getMemoryById(db, memory.id)).toEqual(memory);
    expect(
        (db.prepare("SELECT COUNT(*) AS n FROM memory_tool_proposals").get() as { n: number }).n,
    ).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_mutation_log").get()).toEqual({ n: 0 });
}

it("bounded memory lists preserve full-reader ordering, legacy categories and invalid-row filtering", () => {
    const db = createTestDb();
    try {
        for (let i = 0; i < 30; i++)
            insertMemory(db, {
                projectPath: "list-project",
                category: i % 2 ? "ARCHITECTURE_DECISIONS" : "ARCHITECTURE",
                content: `claim ${i}`,
            });
        const bad = insertMemory(db, {
            projectPath: "list-project",
            category: "ARCHITECTURE",
            content: "invalid first row",
        });
        db.prepare("UPDATE memories SET source_type = 'unknown', updated_at = ? WHERE id = ?").run(
            Date.now() + 10000,
            bad.id,
        );
        for (const categories of [
            null,
            ["ARCHITECTURE"],
            ["ARCHITECTURE", "ARCHITECTURE_DECISIONS"],
            ["missing"],
        ]) {
            const expected = getMemoriesByProject(db, "list-project")
                .filter((m) => categories === null || categories.includes(m.category))
                .slice(0, 10);
            expect(getMemoriesForList(db, "list-project", categories, 10)).toEqual(expected);
        }
    } finally {
        db.close();
    }
});

const toolContext = (sessionID = "ses-memory", agent = "general") =>
    ({ sessionID, agent, directory: "/repo/project" }) as never;

const dreamerToolContext = (directory: string, sessionID = "ses-dream") =>
    ({ sessionID, agent: DREAMER_AGENT, directory }) as never;

function wait(ms = 0): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getProjectMemoryEpoch(db: Database, projectPath: string): number {
    return getProjectState(db, normalizeStoredProjectPath(projectPath))?.projectMemoryEpoch ?? 0;
}

function getMutationRows(db: Database, projectPath: string, renderedMemoryIds: number[]) {
    return getMemoryMutationsForRender(
        db,
        normalizeStoredProjectPath(projectPath),
        0,
        renderedMemoryIds,
    );
}

function installTestEmbeddingProvider(
    embedImpl: (text: string) => Promise<Float32Array | null>,
): void {
    _setTestProviderFactoryForProject(
        () =>
            ({
                modelId: "test-provider-model",
                initialize: async () => true,
                embed: async (text: string, _signal?: AbortSignal, _purpose?: EmbeddingPurpose) => {
                    const vector = await embedImpl(text);
                    return vector ?? new Float32Array();
                },
                embedBatch: async (
                    texts: string[],
                    _signal?: AbortSignal,
                    _purpose?: EmbeddingPurpose,
                ) => {
                    const vectors: Float32Array[] = [];
                    for (const text of texts) {
                        vectors.push((await embedImpl(text)) ?? new Float32Array());
                    }
                    return vectors;
                },
                dispose: async () => {},
                isLoaded: () => true,
            }) satisfies EmbeddingProvider,
    );
}

/**
 * Record the host<->module row mapping the Rust mirror would have written.
 *
 * Under module authority the facade only forwards ids it can address, so a
 * fixture that wants a module round trip has to look mirrored.
 */
function _mirrorMemoryId(
    db: Database,
    hostId: number,
    moduleRowId: number,
    projectPath = "/repo/project",
): number {
    db.prepare(
        "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', ?, ?, ?)",
    ).run(projectPath, moduleRowId, hostId);
    return hostId;
}

function registerMemoryEmbeddingsForProject(
    db: Database,
    projectPath = "/repo/project",
): ProjectEmbeddingRegistrationSnapshot {
    const snapshot = registerProjectEmbedding(
        db,
        projectPath,
        { provider: "local", model: "mock-model" },
        { memoryEnabled: true, gitCommitEnabled: false },
        projectPath,
    );
    const normalizedProjectPath = normalizeStoredProjectPath(projectPath);
    if (normalizedProjectPath !== projectPath) {
        registerProjectEmbedding(
            db,
            normalizedProjectPath,
            { provider: "local", model: "mock-model" },
            { memoryEnabled: true, gitCommitEnabled: false },
            projectPath,
        );
    }
    return snapshot;
}

describe("createCtxMemoryTools", () => {
    let db: Database;
    let tools: ReturnType<typeof createCtxMemoryTools>;
    let listTools: ReturnType<typeof createCtxMemoryListTools>;

    beforeEach(() => {
        _resetProjectEmbeddingRegistryForTests();
        _setTestProviderFactoryForProject(null);
        db = createTestDb();
        const deps = {
            db,
            resolveProjectPath: () => "/repo/project",
            memoryEnabled: true,
            embeddingEnabled: false,
        };
        tools = createCtxMemoryTools(deps);
        listTools = createCtxMemoryListTools(deps);
    });

    afterEach(() => {
        closeQuietly(db);
        _setTestProviderFactoryForProject(null);
        _resetProjectEmbeddingRegistryForTests();
    });

    it("writes and reads a memory through an opted-in home session identity", async () => {
        const homeIdentity = resolveProjectIdentityForSession(homedir(), true);
        expect(homeIdentity).toBeDefined();
        const homeTools = createCtxMemoryTools({
            db,
            resolveProjectPath: (directory) => resolveProjectIdentityForSession(directory, true),
            memoryEnabled: true,
            embeddingEnabled: false,
        });
        const homeContext = { ...toolContext(), directory: homedir() } as never;

        const write = await homeTools.ctx_memory.execute(
            {
                action: "write",
                category: "USER_DIRECTIVES",
                content: "Retain global troubleshooting context.",
            },
            homeContext,
        );
        expect(write).toContain("Saved memory [ID:");

        const [memory] = getMemoriesByProject(db, homeIdentity as string);
        if (!memory) throw new Error("expected home-session memory");
        expect(memory.content).toBe("Retain global troubleshooting context.");
        const read = await homeTools.ctx_memory.execute(
            { action: "get", ids: [memory.id] },
            homeContext,
        );
        expect(read).toContain("Retain global troubleshooting context.");
    });

    it("refuses unmigrated memory writes with MC-C14 and otherwise writes the shared store", async () => {
        let moduleCalls = 0;
        const localTools = createCtxMemoryTools({
            db,
            resolveProjectPath: () => "/repo/project",
            memoryEnabled: true,
            embeddingEnabled: false,
            rustToolBackends: {
                memory: async () => {
                    moduleCalls++;
                    throw new Error("module memory route must not be called");
                },
            },
        });
        db.prepare("INSERT INTO authority_managed VALUES (?, 'old-store', 1)").run("/repo/project");
        const reply = await localTools.ctx_memory.execute(
            { action: "write", category: "CONSTRAINTS", content: "blocked" },
            toolContext(),
        );
        expect(reply).toBe(
            "Magic Context's Rust mode needs a one-time migration of its store. Quit OpenCode and every ck-mc process, then run `magic-context doctor single-store migrate`. (MC-C14)",
        );
        expect(getMemoriesByProject(db, "/repo/project")).toHaveLength(0);
        db.exec("DELETE FROM authority_managed");
        expect(
            await localTools.ctx_memory.execute(
                { action: "write", category: "CONSTRAINTS", content: "shared" },
                toolContext(),
            ),
        ).toContain("Saved memory");
        expect(getMemoriesByProject(db, "/repo/project").map((row) => row.content)).toEqual([
            "shared",
        ]);
        expect(moduleCalls).toBe(0);
    });

    describe("#given write action", () => {
        it("triggers one rust memory sync after a write while keeping the TS write authority", async () => {
            const syncSessions: string[] = [];
            const rustTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                rustToolBackends: {
                    memorySync: (sessionId) => syncSessions.push(sessionId),
                },
            });

            const result = await rustTools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                    content: "Keep the context database authoritative.",
                },
                toolContext(),
            );

            expect(result).toContain("Saved memory [ID:");
            expect(getMemoriesByProject(db, "/repo/project")).toHaveLength(1);
            expect(syncSessions).toEqual(["ses-memory"]);

            const tsTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
            });
            await tsTools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                    content: "TS mode has no module sync trigger.",
                },
                toolContext(),
            );
            expect(syncSessions).toEqual(["ses-memory"]);
        });

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

        it("does not bump project memory epoch for additive writes", async () => {
            const identity = normalizeStoredProjectPath("/repo/project");

            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                    content: "Prefer compact diffs.",
                },
                toolContext(),
            );

            expect(result).toContain("Saved memory");
            expect(getProjectState(db, identity)).toBeNull();
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

        it("stores a fresh embedding when the memory content stays unchanged", async () => {
            const snapshot = registerMemoryEmbeddingsForProject(db);
            let release: (() => void) | undefined;
            const started = new Promise<void>((resolve) => {
                installTestEmbeddingProvider(async () => {
                    resolve();
                    await new Promise<void>((resume) => {
                        release = resume;
                    });
                    return new Float32Array([1, 2]);
                });
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                    content: "Keep the fresh embedding.",
                },
                toolContext(),
            );
            const memory = getMemoriesByProject(db, "/repo/project")[0];

            expect(result).toContain("Saved memory [ID:");
            expect(memory).toBeDefined();
            await started;
            release?.();
            await wait();

            const row = db
                .prepare(
                    "SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = ? AND model_id = ?",
                )
                .get(memory?.id, snapshot.modelId) as { count?: number } | null;
            expect(row?.count).toBe(1);
        });

        it("serializes admission against other writers and deduplicates the next save", async () => {
            const tempDir = createTestTempDirFromPath(join(tmpdir(), "ctx-memory-race-"));
            const dbPath = join(tempDir, "context.db");
            const db1 = createTestDb(dbPath);
            const db2 = createTestDb(dbPath);
            const tools1 = createCtxMemoryTools({
                db: db1,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
            });
            const originalPrepare = db1.prepare.bind(db1);
            let injected = false;
            (db1 as unknown as { prepare: typeof db1.prepare }).prepare = ((sql: string) => {
                const stmt = originalPrepare(sql);
                if (sql.startsWith("INSERT INTO memories")) {
                    const run = stmt.run.bind(stmt);
                    (stmt as unknown as { run: typeof stmt.run }).run = ((...args: unknown[]) => {
                        if (!injected) {
                            injected = true;
                            expect(() =>
                                insertMemoryIdempotent(db2, {
                                    projectPath: "/repo/project",
                                    category: "USER_DIRECTIVES",
                                    content: "Race-safe exact dedup",
                                    sourceSessionId: "ses-memory-2",
                                    sourceType: "agent",
                                }),
                            ).toThrow("locked");
                        }
                        return run(...(args as Parameters<typeof stmt.run>));
                    }) as typeof stmt.run;
                }
                return stmt;
            }) as typeof db1.prepare;

            try {
                const loserResult = await tools1.ctx_memory.execute(
                    {
                        action: "write",
                        category: "USER_DIRECTIVES",
                        content: "Race-safe exact dedup",
                    },
                    toolContext("ses-memory-1"),
                );
                expect(injected).toBe(true);
                expect(loserResult).toContain("Saved memory");
                const tools2 = createCtxMemoryTools({
                    db: db2,
                    resolveProjectPath: () => "/repo/project",
                    memoryEnabled: true,
                    embeddingEnabled: false,
                });
                const nextResult = await tools2.ctx_memory.execute(
                    {
                        action: "write",
                        category: "USER_DIRECTIVES",
                        content: "Race-safe exact dedup",
                    },
                    toolContext("ses-memory-2"),
                );
                expect(nextResult).toContain("Memory already exists");
                const memories = getMemoriesByProject(db1, "/repo/project");
                expect(memories).toHaveLength(1);
                expect(memories[0]?.seenCount).toBe(2);
            } finally {
                closeQuietly(db1);
                closeQuietly(db2);
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe("#given archive action by a PRIMARY agent", () => {
        // A primary agent may request a proposal for a visible memory; approval is not implicit.
        it("retains an archive proposal by ID without changing the row", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Legacy parser fails on malformed XML.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "archive", ids: [memory.id] },
                toolContext(),
            );
            const updated = getMemoryById(db, memory.id);

            expectPendingProposal(db, result, [memory]);
            const fetched = await tools.ctx_memory.execute(
                { action: "get", ids: [memory.id] },
                toolContext(),
            );
            expect(fetched).toContain("Found 1 active memory:");
            expect(fetched).toContain("active");
        });

        it("retains one batch archive proposal all-or-nothing", async () => {
            const first = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Stale issue one.",
            });
            const second = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Stale issue two.",
            });

            const batch = await tools.ctx_memory.execute(
                { action: "archive", ids: [first.id, second.id], reason: "obsolete" },
                toolContext(),
            );
            expectPendingProposal(db, batch, [first, second]);

            // A bad id anywhere in the batch must archive NOTHING.
            const third = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Still active.",
            });
            const failed = await tools.ctx_memory.execute(
                { action: "archive", ids: [third.id, 99_999] },
                toolContext(),
            );
            expect(failed).toContain("Error");
            expect(getMemoryById(db, third.id)?.status).toBe("active");
        });

        it("rejects archived memories with the same inactive-memory error used by update and merge", async () => {
            const archived = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Already curated away.",
            });
            db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(archived.id);

            const result = await tools.ctx_memory.execute(
                { action: "archive", ids: [archived.id] },
                toolContext(),
            );

            expect(result).toContain("restore it before archiving");
            expect(getMemoryById(db, archived.id)?.status).toBe("archived");
            expect(getMutationRows(db, "/repo/project", [archived.id])).toHaveLength(0);
        });

        it("rejects a non-integer archive id without mutating", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Still active.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "archive", ids: [memory.id, memory.id + 0.5] },
                toolContext(),
            );

            expect(result).toContain("integer memory ID");
            expect(getMemoryById(db, memory.id)?.status).toBe("active");
        });

        it("rejects malformed archive ids without mutating", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Malformed id should not archive this.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "archive", ids: [memory.id, memory.id + 0.5] },
                toolContext(),
            );

            expect(result).toContain("integer memory ID");
            expect(getMemoryById(db, memory.id)?.status).toBe("active");
        });

        it("returns error when ID is missing", async () => {
            const result = await tools.ctx_memory.execute({ action: "archive" }, toolContext());

            expect(result).toContain("Error");
            expect(result).toContain("'ids' must contain at least one integer memory ID");
        });

        it("returns error when memory not found", async () => {
            const result = await tools.ctx_memory.execute(
                { action: "archive", ids: [999] },
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
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain("Found 2 active memories");
            expect(result).toContain("CATEGORY");
            expect(result).toContain("Always run bun test before shipping.");
            expect(result).toContain("Do not use npm in this repo.");
        });
    });

    it("rejects archiving a foreign workspace memory even when the category is shared", async () => {
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (1, 'ws', 1, 1);
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const memory = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "CONSTRAINTS",
            content: "Foreign shared constraint is readable but not mutable.",
        });

        const result = await tools.ctx_memory.execute(
            { action: "archive", ids: [memory.id] },
            toolContext(),
        );

        expect(result).toBe(`Error: Memory with ID ${memory.id} was not found.`);
        expect(getMemoryById(db, memory.id)?.status).toBe("active");
        expect(getMemoryMutationsForRender(db, "/repo/foreign", 0, [memory.id])).toHaveLength(0);
    });

    it("REFUSES to archive a foreign memory in a NON-shared category", async () => {
        // Workspace shares only CONSTRAINTS. A foreign member's ARCHITECTURE
        // memory is invisible in the render — the tool must not mutate it either.
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const foreignHidden = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "ARCHITECTURE",
            content: "Foreign architecture detail not shared with this project.",
        });

        const result = await tools.ctx_memory.execute(
            { action: "archive", ids: [foreignHidden.id] },
            toolContext(),
        );

        expect(result).not.toContain("Archived memory");
        expect(getMemoryById(db, foreignHidden.id)?.status).toBe("active");
    });

    it("rejects archiving a foreign memory in a SHARED category", async () => {
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const foreignShared = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "CONSTRAINTS",
            content: "Foreign constraint shared with this project.",
        });

        const result = await tools.ctx_memory.execute(
            { action: "archive", ids: [foreignShared.id] },
            toolContext(),
        );

        expect(result).toBe(`Error: Memory with ID ${foreignShared.id} was not found.`);
        expect(getMemoryById(db, foreignShared.id)?.status).toBe("active");
    });

    it("always allows mutating OWN-project memory regardless of share categories", async () => {
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const own = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE", // own project, non-shared category — still mutable
            content: "Own architecture detail.",
        });

        const result = await tools.ctx_memory.execute(
            { action: "archive", ids: [own.id] },
            toolContext(),
        );

        expectPendingProposal(db, result, [own]);
    });

    it("REFUSES a PRIMARY merge that pulls in a foreign memory in a NON-shared category", async () => {
        // Primary mutations require ownership, not workspace visibility. A shared
        // workspace may make foreign memories readable, but the caller may only
        // update, archive, or merge memories from its own project identity set.
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const own = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE",
            content: "Own architecture detail A.",
        });
        const foreignHidden = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "ARCHITECTURE",
            content: "Foreign architecture detail not shared with this project.",
        });

        const result = await tools.ctx_memory.execute(
            {
                action: "merge",
                ids: [own.id, foreignHidden.id],
                content: "Merged architecture detail.",
                category: "ARCHITECTURE",
            },
            toolContext(),
        );

        expect(result).toContain(`Memory with ID ${foreignHidden.id} was not found`);
        expect(getMemoryById(db, own.id)?.status).toBe("active");
        expect(getMemoryById(db, foreignHidden.id)?.status).toBe("active");
    });

    it("rejects a PRIMARY merge of a foreign memory in a SHARED category", async () => {
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const own = insertMemory(db, {
            projectPath: "/repo/project",
            category: "CONSTRAINTS",
            content: "Own constraint A.",
        });
        const foreignShared = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "CONSTRAINTS",
            content: "Foreign constraint shared with this project.",
        });

        const result = await tools.ctx_memory.execute(
            {
                action: "merge",
                ids: [own.id, foreignShared.id],
                content: "Merged shared constraint.",
                category: "CONSTRAINTS",
            },
            toolContext(),
        );

        expect(result).toBe(`Error: Memory with ID ${foreignShared.id} was not found.`);
        expect(getMemoryById(db, own.id)?.status).toBe("active");
        expect(getMemoryById(db, foreignShared.id)?.status).toBe("active");
    });

    it("refuses a dreamer mutation outside the persisted curate category scope", async () => {
        const projectRule = insertMemory(db, {
            projectPath: "/repo/project",
            category: "PROJECT_RULES",
            content: "Keep category-scoped curation deterministic.",
        });
        const architecture = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE",
            content: "The scheduler owns the dreamer task registry.",
        });
        writeTaskStateJson(
            db,
            "/repo/project",
            "curate",
            JSON.stringify({ curate: { cursor: 0, activeCategory: "PROJECT_RULES" } }),
        );

        const result = await tools.ctx_memory.execute(
            {
                action: "update",
                ids: [architecture.id],
                content: "The shared scheduler owns the dreamer task registry.",
            },
            dreamerToolContext("/repo/project"),
        );

        expect(result).toContain("memory ID");
        expect(result).toContain("outside the scoped category");
        expect(getMemoryById(db, architecture.id)?.content).toBe(
            "The scheduler owns the dreamer task registry.",
        );
        expect(getMemoryById(db, projectRule.id)?.status).toBe("active");
    });

    it("REJECTS merging memories from DIFFERENT categories (structural guard)", async () => {
        const arch = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE",
            content: "Execute threshold is capped at 80% for safety headroom.",
        });
        const cfg = insertMemory(db, {
            projectPath: "/repo/project",
            category: "CONFIG_VALUES",
            content: "execute_threshold_percentage accepts 20-80 as scalar or map.",
        });

        const result = await tools.ctx_memory.execute(
            {
                action: "merge",
                ids: [arch.id, cfg.id],
                content: "Execute threshold stuff.",
                category: "CONFIG_VALUES",
            },
            dreamerToolContext("/repo/project"),
        );

        expect(result).toContain("different categories");
        // both sources remain untouched — no destructive collapse
        expect(getMemoryById(db, arch.id)?.status).toBe("active");
        expect(getMemoryById(db, cfg.id)?.status).toBe("active");
    });

    it("REFUSES a DREAMER merge of a foreign NON-shared-category memory INSIDE a workspace (D1)", async () => {
        // The dreamer keeps cross-project merge OUTSIDE a workspace (#5971), but
        // INSIDE a workspace the per-category sharing policy is the user's explicit
        // privacy boundary the dreamer must honor too.
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const own = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE",
            content: "Own architecture detail D1.",
        });
        const foreignHidden = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "ARCHITECTURE", // foreign, NON-shared category
            content: "Foreign architecture not shared with this workspace member.",
        });

        const result = await tools.ctx_memory.execute(
            {
                action: "merge",
                ids: [own.id, foreignHidden.id],
                content: "Merged architecture detail D1.",
                category: "ARCHITECTURE",
            },
            toolContext("ses-dreamer", DREAMER_AGENT),
        );

        expect(result).toContain("not shared with this workspace member");
        expect(getMemoryById(db, own.id)?.status).toBe("active");
        expect(getMemoryById(db, foreignHidden.id)?.status).toBe("active");
    });

    it("REFUSES a DREAMER merge when workspace share_categories is malformed", async () => {
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, 'not-json');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const own = insertMemory(db, {
            projectPath: "/repo/project",
            category: "CONSTRAINTS",
            content: "Own constraint malformed policy.",
        });
        const foreign = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "CONSTRAINTS",
            content: "Foreign constraint hidden by malformed policy.",
        });

        const result = await tools.ctx_memory.execute(
            {
                action: "merge",
                ids: [own.id, foreign.id],
                content: "Merged constraint under malformed policy.",
                category: "CONSTRAINTS",
            },
            toolContext("ses-dreamer", DREAMER_AGENT),
        );

        expect(result).toContain("not shared with this workspace member");
        expect(getMemoryById(db, own.id)?.status).toBe("active");
        expect(getMemoryById(db, foreign.id)?.status).toBe("active");
    });

    it("ALLOWS a DREAMER merge of a foreign SHARED-category memory INSIDE a workspace (D1)", async () => {
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const own = insertMemory(db, {
            projectPath: "/repo/project",
            category: "CONSTRAINTS",
            content: "Own constraint D1.",
        });
        const foreignShared = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "CONSTRAINTS", // shared
            content: "Foreign constraint shared with the workspace.",
        });
        db.prepare("UPDATE memories SET shareable = 1, scope = 'project' WHERE id = ?").run(
            foreignShared.id,
        );

        const result = await tools.ctx_memory.execute(
            {
                action: "merge",
                ids: [own.id, foreignShared.id],
                content: "Merged shared constraint D1.",
                category: "CONSTRAINTS",
            },
            toolContext("ses-dreamer", DREAMER_AGENT),
        );

        expectPendingProposal(db, result, [own, { ...foreignShared, shareable: 1 }]);
    });

    describe("#given curate safety gates", () => {
        it("REFUSES the #14125 user-profile redundancy archive specimen", async () => {
            const content =
                "CACHE-BUST TRIAGE FLOW (Ufuk directive, 2026-08-15 — use the tool FIRST, never reason from screenshots/log vibes): when told to check a cache bust: (1) resolve the session id (session_projects for a project name, peer roster for peer sessions); (2) run `bun packages/plugin/scripts/analyze-cache-busts.ts <sessionIdPrefix> --show-diff` (supports --since/--until/--limit/--all-busts) — it identifies the bust passes and the causing region; (3) read the req-vs-req diff it produces to name the exact diverging bytes. This is the purpose-built instrument; hand-theorizing mechanisms before running it wastes the primary's turns and was called out explicitly. Investigation masons for busts must be briefed to run this script as step 1.";
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "PROJECT_RULES",
                content,
                importance: 75,
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "archive",
                    ids: [memory.id],
                    reason: "Redundant with global user profile directives (U2, U3, U4, U11, U23, U24, U26) or superseded by canonical memory entries.",
                },
                dreamerToolContext("/repo/project", "ses-curate-14125"),
            );

            expect(result).toContain("Skipped archive");
            expect(result).toContain("refused=1");
            expect(result).not.toContain("Error:");
            expect(takeCurateSafetyRefusalCount("ses-curate-14125")).toBe(1);
            expect(getMemoryById(db, memory.id)?.status).toBe("active");
            expect(getMutationRows(db, "/repo/project", [memory.id])).toHaveLength(0);
        });

        it("allows an archive consolidation only with a named active same-category successor", async () => {
            const source = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ARCHITECTURE",
                content: "The legacy loader initializes the project registry.",
            });
            const successor = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ARCHITECTURE",
                content: "The project loader initializes and validates the project registry.",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "archive",
                    ids: [source.id],
                    superseded_by: successor.id,
                    reason: `Consolidated into memory ${successor.id}.`,
                },
                dreamerToolContext("/repo/project"),
            );

            expectPendingProposal(db, result, [source, successor]);
        });

        it("allows a user-profile reason for a legacy user category when consolidation is valid", async () => {
            const source = insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_PREFERENCES",
                content: "The user prefers concise summaries.",
            });
            const successor = insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_PREFERENCES",
                content: "The user prefers concise summaries with exact verification commands.",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "archive",
                    ids: [source.id],
                    superseded_by: successor.id,
                    reason: "Redundant with the global user profile preference U2.",
                },
                dreamerToolContext("/repo/project"),
            );

            expectPendingProposal(db, result, [source, successor]);
        });

        it("REFUSES a user-profile archive reason for a project-scoped category", async () => {
            const source = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ARCHITECTURE",
                content: "The project uses a generated registry for deterministic startup.",
            });
            const successor = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ARCHITECTURE",
                content: "The project registry is generated to make startup deterministic.",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "archive",
                    ids: [source.id],
                    superseded_by: successor.id,
                    reason: "Redundant with user preferences in directive U7.",
                },
                dreamerToolContext("/repo/project"),
            );

            expect(result).toContain("Skipped archive");
            expect(getMemoryById(db, source.id)?.status).toBe("active");
        });

        it("REFUSES directive-shaped PROJECT_RULES archives despite a valid successor", async () => {
            const source = insertMemory(db, {
                projectPath: "/repo/project",
                category: "PROJECT_RULES",
                content: "Always run the release checklist before publishing.",
            });
            const successor = insertMemory(db, {
                projectPath: "/repo/project",
                category: "PROJECT_RULES",
                content: "The release checklist lives at docs/release.md.",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "archive",
                    ids: [source.id],
                    superseded_by: successor.id,
                    reason: "Consolidated into the release checklist location memory.",
                },
                dreamerToolContext("/repo/project"),
            );

            expect(result).toContain("Skipped archive");
            expect(getMemoryById(db, source.id)?.status).toBe("active");
        });

        it("REFUSES rewrites that lose more than half the content without a consolidation target", async () => {
            const source = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ARCHITECTURE",
                content:
                    "The project registry loader validates every generated entry before startup so malformed configuration cannot enter the runtime.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "update", ids: [source.id], content: "The registry loads." },
                dreamerToolContext("/repo/project"),
            );

            expect(result).toContain("Skipped update");
            expect(getMemoryById(db, source.id)?.content).toBe(source.content);
        });

        it("allows a content-loss rewrite when it names a valid consolidation target", async () => {
            const source = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ARCHITECTURE",
                content:
                    "The project registry loader validates every generated entry before startup so malformed configuration cannot enter the runtime.",
            });
            const successor = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ARCHITECTURE",
                content: "The validator details live in the canonical registry memory.",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [source.id],
                    content: "The registry loads.",
                    superseded_by: successor.id,
                },
                dreamerToolContext("/repo/project"),
            );

            expectPendingProposal(db, result, [source, successor]);
        });
    });

    describe("#given update action", () => {
        it("rejects updating a foreign workspace memory even when the category is shared", async () => {
            db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (1, 'ws', 1, 1);
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
            const foreign = insertMemory(db, {
                projectPath: "/repo/foreign",
                category: "CONSTRAINTS",
                content: "Old foreign shared constraint.",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [foreign.id],
                    content: "Updated foreign shared constraint.",
                },
                toolContext(),
            );

            expect(result).toBe(`Error: Memory with ID ${foreign.id} was not found.`);
            expect(getMemoryById(db, foreign.id)?.content).toBe("Old foreign shared constraint.");
            expect(getMemoryMutationsForRender(db, "/repo/foreign", 0, [foreign.id])).toHaveLength(
                0,
            );
        });

        it("pending update preserves content verification and derived data", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });
            recordMemoryMapping(db, memory.id, [], 1_000, "host_rejected_fallback");

            const result = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id],
                    content: "cache_ttl=10m",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expectPendingProposal(db, result, [memory]);
            expect(getMemoryVerifications(db, [memory.id]).has(memory.id)).toBe(true);
        });

        it("pending update never starts an embedding request", async () => {
            registerMemoryEmbeddingsForProject(db);
            let calls = 0;
            installTestEmbeddingProvider(async () => {
                calls++;
                return new Float32Array([3, 4]);
            });
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });
            const result = await tools.ctx_memory.execute(
                { action: "update", ids: [memory.id], content: "cache_ttl=10m" },
                toolContext(),
            );
            expectPendingProposal(db, result, [memory]);
            await wait();
            expect(calls).toBe(0);
        });

        it("normalizes legacy raw project paths before recording a proposal", async () => {
            const rawProjectPath = "/legacy/raw-project";
            const projectIdentity = normalizeStoredProjectPath(rawProjectPath);
            const legacyTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => projectIdentity,
                memoryEnabled: true,
                embeddingEnabled: false,
            });
            const memory = insertMemory(db, {
                projectPath: rawProjectPath,
                category: "CONFIG_DEFAULTS",
                content: "timeout=5s",
            });

            const result = await legacyTools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id],
                    content: "timeout=10s",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expectPendingProposal(db, result, [memory]);
            expect(db.prepare("SELECT project_path FROM memory_tool_proposals").get()).toEqual({
                project_path: projectIdentity,
            });
        });

        it("rejects malformed update ids without mutating", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id + 0.5],
                    content: "cache_ttl=10m",
                },
                toolContext("ses-primary", "general"),
            );

            expect(result).toContain("integer memory ID");
            expect(getMemoryById(db, memory.id)?.content).toBe("cache_ttl=5m");
        });

        it("rejects archived or superseded memories for primary-agent update", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });
            db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(memory.id);

            const result = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id],
                    content: "cache_ttl=10m",
                },
                toolContext("ses-primary", "general"),
            );

            expect(result).toBe(
                `Error: Memory with ID ${memory.id} is archived or superseded; restore it before updating.`,
            );
            expect(getMemoryById(db, memory.id)?.content).toBe("cache_ttl=5m");
            expect(getMemoryById(db, memory.id)?.status).toBe("archived");
        });

        it("retains a recategorization proposal even if the proposed text duplicates another row", async () => {
            const rawProjectPath = "/legacy/raw-project";
            const projectIdentity = normalizeStoredProjectPath(rawProjectPath);
            const legacyTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => projectIdentity,
                memoryEnabled: true,
                embeddingEnabled: false,
            });
            const existing = insertMemory(db, {
                projectPath: rawProjectPath,
                category: "CONSTRAINTS",
                content: "timeout=5s",
            });
            const memory = insertMemory(db, {
                projectPath: rawProjectPath,
                category: "CONFIG_DEFAULTS",
                content: "timeout=5s",
            });

            const result = await legacyTools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id],
                    category: "CONSTRAINTS",
                    content: "timeout=5s",
                },
                toolContext("ses-primary", "general"),
            );

            expectPendingProposal(db, result, [memory, existing]);
        });

        it("retains a recategorization proposal for a legacy raw-path row", async () => {
            const rawProjectPath = "/legacy/raw-project";
            const projectIdentity = normalizeStoredProjectPath(rawProjectPath);
            const legacyTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => projectIdentity,
                memoryEnabled: true,
                embeddingEnabled: false,
            });
            const memory = insertMemory(db, {
                projectPath: rawProjectPath,
                category: "CONFIG_DEFAULTS",
                content: "timeout=5s",
            });

            const result = await legacyTools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id],
                    category: "CONSTRAINTS",
                    content: "timeout=5s",
                },
                toolContext("ses-primary", "general"),
            );

            expectPendingProposal(db, result, [memory]);
        });

        it("retains a valid category-change proposal without changing the row", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_VALUES",
                content: "cache_ttl=5m",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id],
                    category: "CONSTRAINTS",
                    content: "cache_ttl=10m",
                },
                toolContext("ses-primary", "general"),
            );

            expectPendingProposal(db, result, [memory]);
        });

        it("keeps the current category when update omits category", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_VALUES",
                content: "cache_ttl=5m",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id],
                    content: "cache_ttl=10m",
                },
                toolContext("ses-primary", "general"),
            );

            expectPendingProposal(db, result, [memory]);
        });

        it("keeps the current category when update receives an invalid category", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_VALUES",
                content: "cache_ttl=5m",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id],
                    category: "NOT_A_CATEGORY",
                    content: "cache_ttl=10m",
                },
                toolContext("ses-primary", "general"),
            );

            expectPendingProposal(db, result, [memory]);
        });

        it("retains both content and category change proposals", async () => {
            const recategorized = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_VALUES",
                content: "old recategorize content",
            });
            const omitted = insertMemory(db, {
                projectPath: "/repo/project",
                category: "NAMING",
                content: "old omitted-category content",
            });

            const recategorizeResult = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [recategorized.id],
                    category: "PROJECT_RULES",
                    content: "new recategorize content",
                },
                toolContext("ses-primary", "general"),
            );
            const omitResult = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [omitted.id],
                    content: "new omitted-category content",
                },
                toolContext("ses-primary", "general"),
            );

            expectPendingProposal(db, recategorizeResult, [recategorized]);
            expectPendingProposal(db, omitResult, [omitted]);
        });

        it("retains duplicate proposals without exercising canonical uniqueness constraints", async () => {
            const existing = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "timeout=5s",
            });
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_VALUES",
                content: "timeout=5s",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id],
                    category: "CONSTRAINTS",
                    content: "timeout=5s",
                },
                toolContext("ses-primary", "general"),
            );

            expectPendingProposal(db, result, [memory, existing]);
        });

        it("proposal does not execute a canonical write even when duplicate lookup is stale", async () => {
            const originalPrepare = db.prepare.bind(db);
            const originalExec = db.exec.bind(db);
            let inTx = false;
            (db as { exec: (sql: string) => unknown }).exec = (sql: string) => {
                const text = String(sql);
                if (/\bBEGIN\b/i.test(text)) inTx = true;
                try {
                    return originalExec(sql);
                } catch (error) {
                    inTx = false;
                    throw error;
                } finally {
                    if (/\bCOMMIT\b/i.test(text) || /\bROLLBACK\b/i.test(text)) inTx = false;
                }
            };
            (db as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
                const stmt = originalPrepare(sql);
                if (
                    sql.includes(
                        "FROM memories WHERE project_path = ? AND category = ? AND normalized_hash = ?",
                    )
                ) {
                    const originalGet = stmt.get.bind(stmt);
                    stmt.get = (...args: unknown[]) => (inTx ? undefined : originalGet(...args));
                }
                return stmt;
            };

            try {
                const existing = insertMemory(db, {
                    projectPath: "/repo/project",
                    category: "CONSTRAINTS",
                    content: "timeout=5s",
                });
                const memory = insertMemory(db, {
                    projectPath: "/repo/project",
                    category: "CONFIG_VALUES",
                    content: "cache_ttl=5m",
                });
                const result = await tools.ctx_memory.execute(
                    {
                        action: "update",
                        ids: [memory.id],
                        category: "CONSTRAINTS",
                        content: "timeout=5s",
                    },
                    toolContext("ses-primary", "general"),
                );

                expectPendingProposal(db, result, [memory, existing]);
            } finally {
                (db as { prepare: typeof originalPrepare }).prepare = originalPrepare;
                (db as { exec: typeof originalExec }).exec = originalExec;
            }
        });

        it("proposal does not execute a canonical write with remapped constraint errors", async () => {
            const originalPrepare = db.prepare.bind(db);
            const originalExec = db.exec.bind(db);
            let inTx = false;
            (db as { exec: (sql: string) => unknown }).exec = (sql: string) => {
                const text = String(sql);
                if (/\bBEGIN\b/i.test(text)) inTx = true;
                try {
                    return originalExec(sql);
                } catch (error) {
                    inTx = false;
                    throw error;
                } finally {
                    if (/\bCOMMIT\b/i.test(text) || /\bROLLBACK\b/i.test(text)) inTx = false;
                }
            };
            (db as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
                const stmt = originalPrepare(sql);
                if (
                    sql.includes(
                        "FROM memories WHERE project_path = ? AND category = ? AND normalized_hash = ?",
                    )
                ) {
                    const originalGet = stmt.get.bind(stmt);
                    stmt.get = (...args: unknown[]) => (inTx ? undefined : originalGet(...args));
                }
                if (sql.includes("UPDATE memories SET content = ?")) {
                    return {
                        run: () => {
                            const error = new Error(
                                "UNIQUE constraint failed: memories.project_path, memories.category, memories.normalized_hash",
                            ) as Error & { code?: string };
                            error.code = "SQLITE_ERROR";
                            throw error;
                        },
                    };
                }
                return stmt;
            };

            try {
                const existing = insertMemory(db, {
                    projectPath: "/repo/project",
                    category: "CONSTRAINTS",
                    content: "timeout=5s",
                });
                const memory = insertMemory(db, {
                    projectPath: "/repo/project",
                    category: "CONFIG_VALUES",
                    content: "cache_ttl=5m",
                });
                const result = await tools.ctx_memory.execute(
                    {
                        action: "update",
                        ids: [memory.id],
                        category: "CONSTRAINTS",
                        content: "timeout=5s",
                    },
                    toolContext("ses-primary", "general"),
                );

                expectPendingProposal(db, result, [memory, existing]);
            } finally {
                (db as { prepare: typeof originalPrepare }).prepare = originalPrepare;
                (db as { exec: typeof originalExec }).exec = originalExec;
            }
        });

        it("proposal does not execute canonical writes while authority is draining", async () => {
            const originalPrepare = db.prepare.bind(db);
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_VALUES",
                content: "cache_ttl=5m",
            });
            (db as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
                const stmt = originalPrepare(sql);
                if (sql.includes("UPDATE memories SET content = ?")) {
                    return {
                        run: () => {
                            const error = new Error("authority is draining") as Error & {
                                code: string;
                            };
                            error.code = "authority_draining";
                            throw error;
                        },
                    };
                }
                return stmt;
            };

            let thrown: unknown;
            try {
                await tools.ctx_memory.execute(
                    {
                        action: "update",
                        ids: [memory.id],
                        content: "cache_ttl=10m",
                    },
                    toolContext("ses-primary", "general"),
                );
            } catch (error) {
                thrown = error;
            } finally {
                (db as { prepare: typeof originalPrepare }).prepare = originalPrepare;
            }

            expect(thrown).toBeUndefined();
            expect(getMemoryById(db, memory.id)).toMatchObject({
                category: "CONFIG_VALUES",
                content: "cache_ttl=5m",
            });
        });

        it("proposal persistence failure leaves canonical content unchanged", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });
            db.exec("DROP TABLE memory_tool_proposals");

            let thrown: unknown;
            try {
                await tools.ctx_memory.execute(
                    {
                        action: "update",
                        ids: [memory.id],
                        content: "cache_ttl=10m",
                    },
                    toolContext("ses-dreamer", DREAMER_AGENT),
                );
            } catch (error) {
                thrown = error;
            }

            expect(String(thrown)).toContain("memory_tool_proposals");
            expect(getMemoryById(db, memory.id)?.content).toBe("cache_ttl=5m");
        });
    });

    describe("#given merge action", () => {
        it("retains a merge proposal without creating a canonical row or archiving sources", async () => {
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
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expectPendingProposal(db, result, [first, second]);
            expect(getMemoriesByProject(db, "/repo/project")).toHaveLength(2);
        });

        it("retains a merge proposal matching a canonical hash without changing its bytes", async () => {
            const canonical = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const duplicate = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for all scripts",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [canonical.id, duplicate.id],
                    content: "USE BUN FOR SCRIPTS",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expectPendingProposal(db, result, [canonical, duplicate]);
        });

        it("rejects a PRIMARY-agent merge that includes another project's memory", async () => {
            const own = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const foreign = insertMemory(db, {
                projectPath: "/repo/other-project",
                category: "CONSTRAINTS",
                content: "Use bun for build scripts",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [own.id, foreign.id],
                    content: "Use bun for all scripts in this repository.",
                },
                toolContext("ses-primary", "general"),
            );

            // Cross-identity merge is dreamer-only; a primary agent must not
            // be able to mutate another project's memories. Same opaque
            // "not found" reply as update/archive (no existence oracle).
            expect(result).toBe(`Error: Memory with ID ${foreign.id} was not found.`);
            expect(getMemoryById(db, own.id)?.status).toBe("active");
            expect(getMemoryById(db, foreign.id)?.status).toBe("active");
            expect(getMutationRows(db, "/repo/other-project", [foreign.id])).toHaveLength(0);
        });

        it("rejects archived or superseded memories for primary-agent merge", async () => {
            const archived = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const active = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for test scripts",
            });
            db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(archived.id);

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [archived.id, active.id],
                    content: "Use bun for scripts",
                },
                toolContext("ses-primary", "general"),
            );

            expect(result).toBe(
                `Error: Memory with ID ${archived.id} is archived or superseded; restore it before merging.`,
            );
            expect(getMemoryById(db, archived.id)?.status).toBe("archived");
            expect(getMemoryById(db, active.id)?.status).toBe("active");
        });

        it("retains a dreamer merge proposal for archived memories without restoring them", async () => {
            const archived = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const active = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for test scripts",
            });
            db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(archived.id);

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [archived.id, active.id],
                    content: "Use bun for scripts",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expectPendingProposal(db, result, [getMemoryById(db, archived.id)!, active]);
            expect(getMemoryById(db, archived.id)?.status).toBe("archived");
        });

        it("rejects malformed or duplicate merge ids", async () => {
            const first = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const second = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for tests",
            });

            const malformed = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [first.id, second.id + 0.5],
                    content: "Use bun for all scripts.",
                },
                toolContext("ses-primary", "general"),
            );
            const duplicate = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [first.id, first.id],
                    content: "Use bun for scripts.",
                },
                toolContext("ses-primary", "general"),
            );

            expect(malformed).toContain("integer memory IDs");
            expect(duplicate).toContain("distinct memory IDs");
            expect(getMemoryById(db, first.id)?.status).toBe("active");
            expect(getMemoryById(db, second.id)?.status).toBe("active");
        });

        it("retains a cross-project dreamer merge proposal without touching either identity", async () => {
            const first = insertMemory(db, {
                projectPath: "/repo/project-a",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const second = insertMemory(db, {
                projectPath: "/repo/project-a",
                category: "CONSTRAINTS",
                content: "Use bun for test scripts",
            });
            const third = insertMemory(db, {
                projectPath: "/repo/project-b",
                category: "CONSTRAINTS",
                content: "Use bun for build scripts",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [first.id, second.id, third.id],
                    content: "Use bun for all scripts in this repository.",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expectPendingProposal(db, result, [first, second, third]);
            expect(getProjectMemoryEpoch(db, "/repo/project-a")).toBe(0);
            expect(getProjectMemoryEpoch(db, "/repo/project-b")).toBe(0);
        });
    });

    describe("#given archive action", () => {
        it("retains the primary archive reason on a proposal not memory metadata", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Old issue entry",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "archive",
                    ids: [memory.id],
                    reason: "Removed subsystem no longer exists",
                },
                toolContext("ses-primary", "general"),
            );

            expectPendingProposal(db, result, [memory]);
            const proposal = db
                .prepare("SELECT proposal_json FROM memory_tool_proposals")
                .get() as { proposal_json: string };
            expect(proposal.proposal_json).toContain("Removed subsystem no longer exists");
        });
    });

    describe("#given disabled memory", () => {
        it("returns disabled message for all actions", async () => {
            const disabledTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: false,
                embeddingEnabled: false,
            });

            const results = await Promise.all([
                disabledTools.ctx_memory.execute(
                    { action: "write", category: "USER_DIRECTIVES", content: "x" },
                    toolContext(),
                ),
                disabledTools.ctx_memory.execute({ action: "archive", ids: [1] }, toolContext()),
            ]);

            expect(results).toEqual([
                "Cross-session memory is disabled for this project.",
                "Cross-session memory is disabled for this project.",
            ]);
        });
    });

    describe("#given restricted actions", () => {
        // Primary set = write/archive/update/merge. list/verified/classify are dreamer-only.
        const PRIMARY_ACTIONS = ["write", "archive", "update", "merge"] as const;

        it("keeps the dreamer-only `list` action in the schema so OpenCode can deliver it to execute", () => {
            const primaryTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                allowedActions: [...PRIMARY_ACTIONS],
            });

            const actionSchema = primaryTools.ctx_memory.args.action as unknown as {
                safeParse: (value: unknown) => { success: boolean };
            };

            expect(actionSchema.safeParse("list").success).toBe(false);
            expect(actionSchema.safeParse("merge").success).toBe(true);
            // verified/classify are no longer tool actions (host-applied tasks).
            expect(actionSchema.safeParse("classify").success).toBe(false);
            expect(actionSchema.safeParse("verified").success).toBe(false);
        });

        it("rejects the dreamer-only `list` action for primary-agent tool instances", async () => {
            const primaryTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                allowedActions: [...PRIMARY_ACTIONS],
            });

            const result = await primaryTools.ctx_memory.execute({ action: "list" }, toolContext());

            expect(result).toContain("not allowed");
        });

        it("allows primary agents to use archive/update/merge (no longer dreamer-only)", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Stale fact the agent spotted mid-session.",
            });
            const primaryTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                allowedActions: [...PRIMARY_ACTIONS],
            });

            // A primary agent may propose an archive, but cannot apply it.
            const result = await primaryTools.ctx_memory.execute(
                { action: "archive", ids: [memory.id] },
                toolContext(),
            );

            expectPendingProposal(db, result, [memory]);
        });

        it("allows dreamer sessions to use the dreamer-only `list` action on the shared tool", async () => {
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Keep replies concise.",
            });
            const primaryTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                allowedActions: [...PRIMARY_ACTIONS],
            });

            const result = await primaryTools.ctx_memory.execute(
                { action: "list" },
                toolContext("ses-dream", "dreamer"),
            );

            expect(result).toContain("Found 1 active memory");
        });
    });

    describe("#given limit is advertised only on the dreamer list tool (issue 575)", () => {
        it("omits limit from the primary ctx_memory schema and keeps it on ctx_memory_list", () => {
            expect(Object.keys(tools.ctx_memory.args)).not.toContain("limit");
            expect(Object.keys(listTools.ctx_memory_list.args)).toContain("limit");
        });

        it("still validates and runs an older primary call that carries limit, and the list tool still applies it", async () => {
            const first = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "First durable constraint.",
            });
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Second durable constraint.",
            });

            // OpenCode wraps plugin args in a non-strict object schema, so an
            // unknown `limit` from a replayed call must not fail validation.
            const hostSchema = tool.schema.object(tools.ctx_memory.args);
            expect(hostSchema.safeParse({ action: "get", ids: [first.id], limit: 5 }).success).toBe(
                true,
            );
            const replayed = await tools.ctx_memory.execute(
                { action: "get", ids: [first.id], limit: 5 },
                toolContext(),
            );
            expect(replayed).toContain("First durable constraint.");

            const listed = await listTools.ctx_memory_list.execute(
                { limit: 1 },
                dreamerToolContext("/repo/project"),
            );
            expect(listed).toContain("Found 1 active memory");
        });
    });

    describe("#given content update invalidates classification", () => {
        it("a pending update preserves classification until content is actually changed", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "PROJECT_RULES",
                content: "Historian runs as a hidden subagent.",
            });
            // The classify task (host-side) had marked it shareable + classified.
            setMemoryClassification(db, memory.id, { shareable: true, importance: 70 });
            expect(getMemoryById(db, memory.id)).toMatchObject({ shareable: 1 });
            expect(getUnclassifiedMemoryIds(db, [memory.id])).toEqual([]); // classified

            // A proposed edit does not change the fact, so its existing classification stays valid.
            const res = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id],
                    content: "Historian runs as a hidden subagent at endpoint 192.168.1.9.",
                },
                toolContext("ses-primary"),
            );
            expect(res).toContain("MEMORY_PENDING_PROPOSAL");
            expect(getMemoryById(db, memory.id)).toMatchObject({
                shareable: 1,
                content: memory.content,
            });
            expect(getUnclassifiedMemoryIds(db, [memory.id])).toEqual([]);
        });
    });

    describe("#given get action", () => {
        it("returns an own-project memory by id", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Always run bun before shipping.",
            });
            const result = await tools.ctx_memory.execute(
                { action: "get", ids: [memory.id] },
                toolContext(),
            );
            expect(result).toContain(`Found 1 active memory`);
            expect(result).toContain(String(memory.id));
            expect(result).toContain("Always run bun before shipping.");
        });

        it("unwraps imitated reduced get calls without overriding real arguments", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Run the focused test suite.",
            });
            const plain = await tools.ctx_memory.execute(
                { action: "get", ids: [memory.id] },
                toolContext(),
            );
            const imitated = await tools.ctx_memory.execute(
                {
                    reduced: true,
                    summary: JSON.stringify({ action: "get", ids: [memory.id] }),
                },
                toolContext(),
            );
            const malformed = await tools.ctx_memory.execute(
                { reduced: true, summary: "not JSON" },
                toolContext(),
            );
            const realArguments = await tools.ctx_memory.execute(
                {
                    action: "get",
                    ids: [memory.id],
                    reduced: true,
                    summary: JSON.stringify({ action: "archive", ids: [memory.id] }),
                },
                toolContext(),
            );

            expect(imitated).toBe(plain);
            expect(malformed).toBe("Error: Action 'undefined' is not allowed in this context.");
            expect(realArguments).toBe(plain);
            expect(getMemoryById(db, memory.id)?.status).toBe("active");
        });

        it("labels archived rows with their status instead of hiding them", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Retired issue entry the user just referenced.",
            });
            db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(memory.id);

            const result = await tools.ctx_memory.execute(
                { action: "get", ids: [memory.id] },
                toolContext(),
            );
            expect(result).toContain(String(memory.id));
            expect(result).toContain("archived");
            expect(result).toContain("Retired issue entry the user just referenced.");
        });

        it("surfaces a foreign shared-category memory (workspace visibility)", async () => {
            db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
            const foreign = insertMemory(db, {
                projectPath: "/repo/foreign",
                category: "CONSTRAINTS",
                content: "Foreign shared constraint.",
            });

            db.prepare("UPDATE memories SET shareable = 1, scope = 'project' WHERE id = ?").run(
                foreign.id,
            );
            const result = await tools.ctx_memory.execute(
                { action: "get", ids: [foreign.id] },
                toolContext(),
            );
            expect(result).toContain(String(foreign.id));
            expect(result).toContain("Foreign shared constraint.");
        });

        it("hides foreign private, archived, and expired rows in a shared category", async () => {
            db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
            const privateMemory = insertMemory(db, {
                projectPath: "/repo/foreign",
                category: "CONSTRAINTS",
                content: "private foreign memory",
            });
            const archived = insertMemory(db, {
                projectPath: "/repo/foreign",
                category: "CONSTRAINTS",
                content: "archived foreign memory",
            });
            const expired = insertMemory(db, {
                projectPath: "/repo/foreign",
                category: "CONSTRAINTS",
                content: "expired foreign memory",
            });
            db.prepare(
                "UPDATE memories SET shareable = 1, scope = 'project', status = 'archived' WHERE id = ?",
            ).run(archived.id);
            db.prepare(
                "UPDATE memories SET shareable = 1, scope = 'project', expires_at = 0 WHERE id = ?",
            ).run(expired.id);
            const result = await tools.ctx_memory.execute(
                { action: "get", ids: [privateMemory.id, archived.id, expired.id] },
                toolContext(),
            );
            for (const memory of [privateMemory, archived, expired]) {
                expect(result).toContain(
                    `id ${memory.id}: not found or not visible from this project`,
                );
                expect(result).not.toContain(memory.content);
            }
        });

        it("reports a foreign non-shared-category memory as not visible (no existence oracle)", async () => {
            db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
            const foreign = insertMemory(db, {
                projectPath: "/repo/foreign",
                category: "ARCHITECTURE",
                content: "Foreign architecture hidden by the share policy.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "get", ids: [foreign.id] },
                toolContext(),
            );
            // The id must be reported as not visible, NOT as a normal hit.
            expect(result).toContain(
                `id ${foreign.id}: not found or not visible from this project`,
            );
            expect(result).not.toContain("Foreign architecture hidden by the share policy.");
        });

        it("rejects >20 ids with a clear error and emits nothing", async () => {
            const ids = Array.from({ length: 21 }, (_, i) => i + 1);
            const result = await tools.ctx_memory.execute({ action: "get", ids }, toolContext());
            expect(result).toContain("at most 20");
        });

        it("returns a per-id report mixing hits and misses in call order", async () => {
            const own = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Own constraint present.",
            });
            const missing = 999_999;

            const result = await tools.ctx_memory.execute(
                { action: "get", ids: [own.id, missing] },
                toolContext(),
            );
            expect(result).toContain(String(own.id));
            expect(result).toContain("Own constraint present.");
            expect(result).toContain(`id ${missing}: not found or not visible from this project`);
        });
    });

    describe("required-all filler", () => {
        const isolatedWrite = async (args: Record<string, unknown>) => {
            const isolated = createTestDb();
            try {
                const isolatedTools = createCtxMemoryTools({
                    db: isolated,
                    resolveProjectPath: () => "/repo/project",
                    memoryEnabled: true,
                    embeddingEnabled: false,
                });
                return await isolatedTools.ctx_memory.execute(args, toolContext());
            } finally {
                closeQuietly(isolated);
            }
        };

        it("write ignores ids/limit/reason filler, including ids:[0]", async () => {
            const clean = await isolatedWrite({
                action: "write",
                category: "PROJECT_RULES",
                content: "Same standalone fact.",
            });
            const filler = await isolatedWrite({
                action: "write",
                category: "PROJECT_RULES",
                content: "Same standalone fact.",
                ids: [1],
                limit: 0,
                reason: "",
            });
            const zeroIds = await isolatedWrite({
                action: "write",
                category: "PROJECT_RULES",
                content: "Same standalone fact.",
                ids: [0],
                limit: 0,
                reason: "",
            });
            expect(filler).toBe(clean);
            expect(zeroIds).toBe(clean);
            expect(clean).toContain("Saved memory [ID: 1] in PROJECT_RULES.");
        });

        it("archive with empty reason and unused-field filler matches a clean archive", async () => {
            const run = async (archiveArgs: Record<string, unknown>) => {
                const isolated = createTestDb();
                try {
                    const isolatedTools = createCtxMemoryTools({
                        db: isolated,
                        resolveProjectPath: () => "/repo/project",
                        memoryEnabled: true,
                        embeddingEnabled: false,
                    });
                    const created = await isolatedTools.ctx_memory.execute(
                        {
                            action: "write",
                            category: "PROJECT_RULES",
                            content: "Archive this fact.",
                        },
                        toolContext(),
                    );
                    expect(created).toContain("Saved memory [ID: 1]");
                    return await isolatedTools.ctx_memory.execute(archiveArgs, toolContext());
                } finally {
                    closeQuietly(isolated);
                }
            };
            const clean = await run({ action: "archive", ids: [1] });
            const filler = await run({
                action: "archive",
                ids: [1],
                content: "",
                category: "PROJECT_RULES",
                limit: 0,
                reason: "",
            });
            expect(filler).toBe(clean);
            expect(clean).toContain("MEMORY_PENDING_PROPOSAL");
        });

        it("update/get/merge ignore unused-field filler and match the clean call", async () => {
            const seed = async () => {
                const isolated = createTestDb();
                const isolatedTools = createCtxMemoryTools({
                    db: isolated,
                    resolveProjectPath: () => "/repo/project",
                    memoryEnabled: true,
                    embeddingEnabled: false,
                });
                await isolatedTools.ctx_memory.execute(
                    {
                        action: "write",
                        category: "PROJECT_RULES",
                        content: "Original fact.",
                    },
                    toolContext(),
                );
                await isolatedTools.ctx_memory.execute(
                    {
                        action: "write",
                        category: "PROJECT_RULES",
                        content: "Duplicate fact to merge.",
                    },
                    toolContext(),
                );
                return { isolated, isolatedTools };
            };

            const updateCleanDb = await seed();
            const updateFillerDb = await seed();
            const getCleanDb = await seed();
            const getFillerDb = await seed();
            const mergeCleanDb = await seed();
            const mergeFillerDb = await seed();
            try {
                const updateClean = await updateCleanDb.isolatedTools.ctx_memory.execute(
                    { action: "update", ids: [1], content: "Updated fact." },
                    toolContext(),
                );
                const updateFiller = await updateFillerDb.isolatedTools.ctx_memory.execute(
                    {
                        action: "update",
                        ids: [1],
                        content: "Updated fact.",
                        category: "PROJECT_RULES",
                        limit: 0,
                        reason: "",
                    },
                    toolContext(),
                );
                const getClean = await getCleanDb.isolatedTools.ctx_memory.execute(
                    { action: "get", ids: [1] },
                    toolContext(),
                );
                const getFiller = await getFillerDb.isolatedTools.ctx_memory.execute(
                    {
                        action: "get",
                        ids: [1],
                        content: "",
                        category: "PROJECT_RULES",
                        limit: 0,
                        reason: "",
                    },
                    toolContext(),
                );
                const mergeClean = await mergeCleanDb.isolatedTools.ctx_memory.execute(
                    {
                        action: "merge",
                        ids: [1, 2],
                        content: "Merged standalone fact.",
                    },
                    toolContext(),
                );
                const mergeFiller = await mergeFillerDb.isolatedTools.ctx_memory.execute(
                    {
                        action: "merge",
                        ids: [1, 2],
                        content: "Merged standalone fact.",
                        category: "PROJECT_RULES",
                        limit: 0,
                        reason: "",
                    },
                    toolContext(),
                );
                const stamp = /\d{4}-\d{2}-\d{2}T[\d:.]+Z/g;
                expect(updateFiller).toBe(updateClean);
                expect(getFiller.replace(stamp, "<ts>")).toBe(getClean.replace(stamp, "<ts>"));
                expect(mergeFiller).toBe(mergeClean);
            } finally {
                closeQuietly(updateCleanDb.isolated);
                closeQuietly(updateFillerDb.isolated);
                closeQuietly(getCleanDb.isolated);
                closeQuietly(getFillerDb.isolated);
                closeQuietly(mergeCleanDb.isolated);
                closeQuietly(mergeFillerDb.isolated);
            }
        });

        it("keeps unused ids and category filler inert under an active dreamer category scope", async () => {
            const run = async (action: "write" | "get" | "list", filler: boolean) => {
                const isolated = createTestDb();
                try {
                    const projectRule = insertMemory(isolated, {
                        projectPath: "/repo/project",
                        category: "PROJECT_RULES",
                        content: "Different scoped fact.",
                    });
                    const architecture = insertMemory(isolated, {
                        projectPath: "/repo/project",
                        category: "ARCHITECTURE",
                        content: "Scoped architecture fact.",
                    });
                    writeTaskStateJson(
                        isolated,
                        "/repo/project",
                        "curate",
                        JSON.stringify({ curate: { cursor: 0, activeCategory: "ARCHITECTURE" } }),
                    );
                    const isolatedDeps = {
                        db: isolated,
                        resolveProjectPath: () => "/repo/project",
                        memoryEnabled: true,
                        embeddingEnabled: false,
                    };
                    const isolatedTools = createCtxMemoryTools(isolatedDeps);
                    const isolatedListTools = createCtxMemoryListTools(isolatedDeps);
                    const args =
                        action === "write"
                            ? {
                                  action,
                                  category: "ARCHITECTURE",
                                  content: "New scoped architecture fact.",
                                  ...(filler
                                      ? { ids: [projectRule.id], limit: 0, reason: "" }
                                      : {}),
                              }
                            : action === "get"
                              ? {
                                    action,
                                    ids: [architecture.id],
                                    ...(filler
                                        ? {
                                              content: "",
                                              category: "PROJECT_RULES",
                                              limit: 0,
                                              reason: "",
                                          }
                                        : {}),
                                }
                              : {
                                    action,
                                    category: "ARCHITECTURE",
                                    ...(filler
                                        ? {
                                              ids: [projectRule.id],
                                              content: "",
                                              limit: 0,
                                              reason: "",
                                          }
                                        : {}),
                                };
                    const context = toolContext("ses-dreamer", DREAMER_AGENT);
                    return action === "list"
                        ? await isolatedListTools.ctx_memory_list.execute(args as never, context)
                        : await isolatedTools.ctx_memory.execute(args, context);
                } finally {
                    closeQuietly(isolated);
                }
            };
            const stamp = /\d{4}-\d{2}-\d{2}T[\d:.]+Z/g;
            const clean = {
                write: await run("write", false),
                get: (await run("get", false)).replace(stamp, "<ts>"),
                list: (await run("list", false)).replace(stamp, "<ts>"),
            };
            const filler = {
                write: await run("write", true),
                get: (await run("get", true)).replace(stamp, "<ts>"),
                list: (await run("list", true)).replace(stamp, "<ts>"),
            };

            expect(filler).toEqual(clean);
            expect(clean.write).toContain("Saved memory");
            expect(clean.get).toContain("Scoped architecture fact");
            expect(clean.list).toContain("Scoped architecture fact");
        });

        it("list treats limit 0 as the default and filler ids do not bypass the dreamer-only gate", async () => {
            for (const label of ["one", "two", "three"]) {
                insertMemory(db, {
                    projectPath: "/repo/project",
                    category: "PROJECT_RULES",
                    content: `List filler ${label}.`,
                });
            }
            const dreamer = toolContext("ses-dreamer", DREAMER_AGENT);
            const clean = await listTools.ctx_memory_list.execute({}, dreamer);
            const filler = await listTools.ctx_memory_list.execute(
                {
                    ids: [1],
                    content: "",
                    category: "PROJECT_RULES",
                    limit: 0,
                    reason: "",
                } as never,
                dreamer,
            );
            const primaryFiller = await listTools.ctx_memory_list.execute(
                {
                    ids: [1],
                    content: "",
                    category: "PROJECT_RULES",
                    limit: 0,
                    reason: "",
                } as never,
                toolContext(),
            );
            expect(filler).toBe(clean);
            expect(clean).toContain("Found 3 active memories");
            expect(primaryFiller).toBe(
                "Error: ctx_memory_list is only available to the dreamer agent.",
            );
        });
    });
});
