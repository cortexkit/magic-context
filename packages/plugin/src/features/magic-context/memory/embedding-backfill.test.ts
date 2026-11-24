import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingConfig } from "../../../config/schema/magic-context";
import type { Database } from "../../../shared/sqlite";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    embedTextForProject,
    embedUnembeddedMemoriesForProject,
    getProjectEmbeddingSnapshot,
    registerProjectEmbedding,
} from "../project-embedding-registry";
import { unifiedSearch } from "../search";
import { closeDatabase, openDatabase } from "../storage";
import { ensureMemoryEmbeddings } from "./embedding-backfill";
import type { EmbeddingProvider, EmbeddingPurpose } from "./embedding-provider";
import { insertMemory } from "./storage-memory";
import { loadAllEmbeddings } from "./storage-memory-embeddings";

class FakeEmbeddingProvider implements EmbeddingProvider {
    readonly modelId: string;

    constructor(modelId: string) {
        this.modelId = modelId;
    }

    async initialize(): Promise<boolean> {
        return true;
    }

    async embed(
        text: string,
        _signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<Float32Array> {
        return new Float32Array([text.length, this.modelId.length]);
    }

    async embedBatch(
        texts: string[],
        _signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<(Float32Array | null)[]> {
        return texts.map((text) => new Float32Array([text.length, this.modelId.length]));
    }

    async dispose(): Promise<void> {}

    isLoaded(): boolean {
        return true;
    }
}

function localConfig(model: string): EmbeddingConfig {
    return { provider: "local", model };
}

function currentModelId(projectIdentity: string): string {
    return getProjectEmbeddingSnapshot(projectIdentity)?.modelId ?? "off";
}

function recordSearchBackfillRequests(missingContent?: string): string[][] {
    const requests: string[][] = [];
    _setTestProviderFactoryForProject(
        (config) =>
            new (class extends FakeEmbeddingProvider {
                override async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
                    requests.push(texts);
                    return texts.map((text) =>
                        text === missingContent ? null : new Float32Array([1, 0]),
                    );
                }
            })(config.provider === "local" ? config.model : "off"),
    );
    return requests;
}

function seedVectorlessMemories(db: Database, projectPath: string, count: number) {
    return Array.from({ length: count }, (_, index) =>
        insertMemory(db, {
            projectPath,
            // Interleave categories so the storage query's category order differs from ID order.
            category: index % 2 === 0 ? "CONSTRAINTS" : "ARCHITECTURE_DECISIONS",
            content: `Calibration entry ${index}`,
        }),
    );
}

function searchMemory(db: Database, projectIdentity: string, query: string) {
    return unifiedSearch(db, "ses-backfill", projectIdentity, query, {
        sources: ["memory"],
        countRetrievals: false,
        measurementDisabled: true,
        embedQuery: (text, signal) => embedTextForProject(projectIdentity, text, signal, "query"),
        isEmbeddingRuntimeEnabled: () => true,
    });
}

describe("ensureMemoryEmbeddings (read-path backfill)", () => {
    const tempDirs: string[] = [];
    const originalXdgDataHome = process.env.XDG_DATA_HOME;

    function useTempDb() {
        const dir = createTestTempDirFromPath(join(tmpdir(), "embedding-backfill-"));
        tempDirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        return openDatabase();
    }

    afterEach(() => {
        _resetProjectEmbeddingRegistryForTests();
        closeDatabase();
        if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = originalXdgDataHome;
        for (const dir of tempDirs) {
            try {
                rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            } catch {
                /* Ignore EBUSY on Windows */
            }
        }
        tempDirs.length = 0;
    });

    it("saves and caches the vector when the memory content stays unchanged", async () => {
        _setTestProviderFactoryForProject(
            (config) =>
                new FakeEmbeddingProvider(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        const projectIdentity = "git:backfill-happy";
        const memory = insertMemory(db, {
            projectPath: projectIdentity,
            category: "CONSTRAINTS",
            content: "Backfill me on the read path.",
        });
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/backfill-happy",
        );

        const cache = await ensureMemoryEmbeddings({
            db,
            projectIdentity,
            memories: [memory],
            existingEmbeddings: new Map(),
        });

        expect(cache.has(memory.id)).toBe(true);
        expect(
            loadAllEmbeddings(db, projectIdentity, currentModelId(projectIdentity)).has(memory.id),
        ).toBe(true);
    });

    it.each([
        "project",
        "workspace",
    ])("bounds %s search backfill when no memory matches by keyword", async (scope) => {
        const db = useTempDb();
        const projectIdentity = "git:backfill-own";
        const requests = recordSearchBackfillRequests();
        const memories = seedVectorlessMemories(db, projectIdentity, 1_000);
        if (scope === "workspace") {
            db.exec(`
                    INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
                    VALUES (1, 'ws', '["CONSTRAINTS"]', 1, 1);
                    INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                    VALUES (1, 'git:backfill-own', 'Own', '/own', 1), (1, 'git:backfill-peer', 'Peer', '/peer', 1);
                `);
            const peer = insertMemory(db, {
                projectPath: "git:backfill-peer",
                category: "CONSTRAINTS",
                content: "Shared calibration entry",
            });
            db.prepare("UPDATE memories SET shareable = 1 WHERE id = ?").run(peer.id);
        }
        const { modelId } = registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/own",
        );

        const results = await searchMemory(db, projectIdentity, "quasizymology");

        expect(Math.max(...requests.map((batch) => batch.length))).toBeLessThanOrEqual(10);
        expect(requests.flat()).toHaveLength(50);
        expect(requests.flat()).toEqual(memories.slice(0, 50).map((memory) => memory.content));
        expect(loadAllEmbeddings(db, projectIdentity, modelId).size).toBe(50);
        expect(results[0]).toMatchObject({ source: "memory", matchType: "semantic" });
    });

    it("finds a memory left vectorless by the backfill cap on a follow-up keyword search", async () => {
        const db = useTempDb();
        const projectIdentity = "git:backfill-keyword";
        seedVectorlessMemories(db, projectIdentity, 50);
        const target = insertMemory(db, {
            projectPath: projectIdentity,
            category: "CONSTRAINTS",
            content: "Zirconium export policy",
        });
        const requests = recordSearchBackfillRequests(target.content);
        const { modelId } = registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/own",
        );

        await searchMemory(db, projectIdentity, "quasizymology");
        expect(requests.flat()).not.toContain(target.content);

        requests.length = 0;
        const results = await searchMemory(db, projectIdentity, "zirconium");

        expect(requests).toEqual([[target.content]]);
        expect(loadAllEmbeddings(db, projectIdentity, modelId).has(target.id)).toBe(false);
        expect(results[0]).toMatchObject({
            source: "memory",
            memoryId: target.id,
            matchType: "fts",
        });
    });

    it("semantic search reaches newer memories after a full batch of missing vectors", async () => {
        const db = useTempDb();
        const projectIdentity = "git:backfill-progress";
        const older = seedVectorlessMemories(db, projectIdentity, 50);
        const target = insertMemory(db, {
            projectPath: projectIdentity,
            category: "CONSTRAINTS",
            content: "Packaging requires an explicit runtime version",
        });
        const requests: string[][] = [];
        _setTestProviderFactoryForProject(
            () =>
                new (class extends FakeEmbeddingProvider {
                    override async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
                        requests.push(texts);
                        return texts.map((text) =>
                            text === target.content ? new Float32Array([1, 0]) : null,
                        );
                    }
                })("model-a"),
        );
        const { modelId } = registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/own",
        );

        await searchMemory(db, projectIdentity, "quasizymology");
        expect(requests.flat()).toEqual(older.map((memory) => memory.content));
        requests.length = 0;

        const results = await searchMemory(db, projectIdentity, "quasizymology");
        expect(requests.flat()).toContain(target.content);
        expect(requests.flat().length).toBeLessThanOrEqual(50);
        expect(requests.every((batch) => batch.length <= 10)).toBe(true);
        expect(loadAllEmbeddings(db, projectIdentity, modelId).has(target.id)).toBe(true);
        expect(results[0]).toMatchObject({
            source: "memory",
            memoryId: target.id,
            matchType: "semantic",
        });

        requests.length = 0;
        await searchMemory(db, projectIdentity, "quasizymology");
        expect(requests.flat()).toEqual(older.map((memory) => memory.content));
    });

    it("discards the stale vector, skips the cache, and leaves the row for the guarded drain when the memory is edited mid-flight", async () => {
        let release: (() => void) | undefined;
        let batchStarted: (() => void) | undefined;
        _setTestProviderFactoryForProject(
            (config) =>
                new (class extends FakeEmbeddingProvider {
                    firstBatch = true;
                    override async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
                        // Gate only the first batch so the follow-up guarded drain
                        // (which embeds again) runs without blocking.
                        if (this.firstBatch) {
                            this.firstBatch = false;
                            batchStarted?.();
                            await new Promise<void>((resolve) => {
                                release = resolve;
                            });
                        }
                        return super.embedBatch(texts);
                    }
                })(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        const projectIdentity = "git:backfill-stale";
        const memory = insertMemory(db, {
            projectPath: projectIdentity,
            category: "CONSTRAINTS",
            content: "Old memory body",
        });
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/backfill-stale",
        );

        const started = new Promise<void>((resolve) => {
            batchStarted = resolve;
        });
        const inFlight = ensureMemoryEmbeddings({
            db,
            projectIdentity,
            memories: [memory],
            existingEmbeddings: new Map(),
        });
        await started;
        // Edit the memory while the provider call is in flight: the vector the
        // backfill receives was computed from the OLD content.
        db.prepare(
            "UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ? WHERE id = ?",
        ).run("New memory body (edited)", "new-memory-hash", Date.now(), memory.id);
        release?.();

        const cache = await inFlight;

        // The stale vector is neither persisted nor cached.
        expect(cache.has(memory.id)).toBe(false);
        expect(loadAllEmbeddings(db, projectIdentity, currentModelId(projectIdentity)).size).toBe(
            0,
        );

        // Because no embedding row was written, the row still looks unembedded and
        // the guarded proactive drain re-embeds the CURRENT content next round.
        const embedded = await embedUnembeddedMemoriesForProject(db, projectIdentity, 10);
        expect(embedded).toBe(1);
        const stored = loadAllEmbeddings(db, projectIdentity, currentModelId(projectIdentity));
        expect(stored.size).toBe(1);
        // The fake provider encodes text length into the vector's first element:
        // the stored vector must be the NEW content's (24 chars), not the stale
        // old one (15 chars).
        expect(stored.get(memory.id)?.embedding[0]).toBe("New memory body (edited)".length);
    });
});
