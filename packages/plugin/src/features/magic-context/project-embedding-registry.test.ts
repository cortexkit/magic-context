import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmbeddingConfig } from "../../config/schema/magic-context";
import {
    chunkCanonicalText,
    loadCompartmentChunkEmbeddingsForSearch,
    replaceCompartmentChunkEmbeddings,
} from "./compartment-chunk-embedding";
import { appendCompartments, getCompartments } from "./compartment-storage";
import type { GitCommit } from "./git-commits/git-log-reader";
import {
    countEmbeddedCommits,
    saveCommitEmbedding,
} from "./git-commits/storage-git-commit-embeddings";
import { upsertCommits } from "./git-commits/storage-git-commits";
import { acquireGitSweepLease, releaseGitSweepLease } from "./git-commits/sweep-coordinator";
import type { EmbeddingProvider, EmbeddingPurpose } from "./memory/embedding-provider";
import { insertMemory } from "./memory/storage-memory";
import {
    getStoredModelId,
    loadAllEmbeddings,
    saveEmbedding,
} from "./memory/storage-memory-embeddings";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    drainCommitBacklogForProject,
    embedSessionCompartmentChunks,
    embedTextForProject,
    embedUnembeddedCompartmentChunksForProject,
    getProjectEmbeddingSnapshot,
    markProjectLoadUntrusted,
    registerProjectEmbedding,
    registerProjectInObservationMode,
    sweepAllRegisteredProjects,
    sweepStaleEmbeddingIdentitiesForProject,
} from "./project-embedding-registry";
import { recordSessionProjectIdentity } from "./session-project-storage";
import { closeDatabase, openDatabase } from "./storage";

class FakeEmbeddingProvider implements EmbeddingProvider {
    readonly modelId: string;
    disposed = false;

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
    ): Promise<Float32Array[]> {
        return texts.map((text) => new Float32Array([text.length, this.modelId.length]));
    }

    async dispose(): Promise<void> {
        this.disposed = true;
    }

    isLoaded(): boolean {
        return true;
    }
}

function localConfig(model: string, maxInputTokens?: number): EmbeddingConfig {
    return {
        provider: "local",
        model,
        ...(maxInputTokens !== undefined ? { max_input_tokens: maxInputTokens } : {}),
    };
}

function makeGitCommit(shaSeed: string, committedAtMs: number): GitCommit {
    const sha = shaSeed.padEnd(40, shaSeed);
    return {
        sha,
        shortSha: sha.slice(0, 7),
        message: `commit ${shaSeed}`,
        author: "dev@example.com",
        committedAtMs,
    };
}

function currentModelId(projectIdentity: string): string {
    return getProjectEmbeddingSnapshot(projectIdentity)?.modelId ?? "off";
}

function currentChunkModelId(projectIdentity: string): string {
    return getProjectEmbeddingSnapshot(projectIdentity)?.chunkModelId ?? "off";
}

function countRows(
    db: NonNullable<ReturnType<typeof openDatabase>>,
    sql: string,
    ...params: unknown[]
): number {
    return (db.prepare(sql).get(...params) as { count: number }).count;
}

function seedCompartmentWithFts(
    db: NonNullable<ReturnType<typeof openDatabase>>,
    sessionId: string,
): number {
    appendCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "u1",
            endMessageId: "a2",
            title: "Hydraulic backpressure",
            content: "P1 content",
            p1: "P1 content",
        },
    ]);
    db.prepare(
        "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
    ).run(sessionId, 1, `${sessionId}-u1`, "user", "How do we avoid saturating the queue?");
    db.prepare(
        "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
    ).run(sessionId, 2, `${sessionId}-a2`, "assistant", "Use backpressure and bounded drains.");
    return getCompartments(db, sessionId)[0].id;
}

function seedManyCompartmentsWithFts(
    db: NonNullable<ReturnType<typeof openDatabase>>,
    sessionId: string,
    count: number,
): void {
    for (let i = 0; i < count; i++) {
        const start = i * 2 + 1;
        const end = start + 1;
        appendCompartments(db, sessionId, [
            {
                sequence: i,
                startMessage: start,
                endMessage: end,
                startMessageId: `u${start}`,
                endMessageId: `a${end}`,
                title: `Compartment ${i}`,
                content: `P1 content ${i}`,
                p1: `P1 content ${i}`,
            },
        ]);
        db.prepare(
            "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
        ).run(sessionId, start, `${sessionId}-u${start}`, "user", `Question ${i}?`);
        db.prepare(
            "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
        ).run(sessionId, end, `${sessionId}-a${end}`, "assistant", `Answer ${i}.`);
    }
}

/**
 * Seed one compartment whose single assistant message is huge, so its canonical
 * chunk text is one oversized line that chunkCanonicalText splits into many
 * windows — the #207 batching case.
 */
function seedOversizedCompartmentWithFts(
    db: NonNullable<ReturnType<typeof openDatabase>>,
    sessionId: string,
): number {
    appendCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 1,
            startMessageId: "a1",
            endMessageId: "a1",
            title: "Giant dump",
            content: "P1 content",
            p1: "P1 content",
        },
    ]);
    // ~6000 words ≈ thousands of tokens » the default chunk budget, all in one
    // assistant message → one oversized canonical line.
    const huge = Array.from({ length: 6000 }, (_, i) => `word${i}`).join(" ");
    db.prepare(
        "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
    ).run(sessionId, 1, `${sessionId}-a1`, "assistant", huge);
    return getCompartments(db, sessionId)[0].id;
}

describe("project embedding registry", () => {
    const tempDirs: string[] = [];
    const originalXdgDataHome = process.env.XDG_DATA_HOME;

    function useTempDb() {
        const dir = mkdtempSync(join(tmpdir(), "project-embedding-registry-"));
        tempDirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        return openDatabase();
    }

    afterEach(() => {
        _resetProjectEmbeddingRegistryForTests();
        closeDatabase();
        process.env.XDG_DATA_HOME = originalXdgDataHome;
        for (const dir of tempDirs) {
            try {
                rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            } catch {
                /* Ignore EBUSY on Windows */
            }
        }
        tempDirs.length = 0;
    });

    it("takes a BEGIN IMMEDIATE write lock while registering a project", () => {
        const db = useTempDb();
        const calls: string[] = [];
        const originalExec = db.exec.bind(db);
        (db as unknown as { exec: (sql: string) => unknown }).exec = (sql: string) => {
            calls.push(sql);
            return originalExec(sql);
        };

        registerProjectEmbedding(
            db,
            "git:test",
            localConfig("model-a"),
            { memoryEnabled: false, gitCommitEnabled: false },
            "/repo/project",
        );

        expect(calls).toContain("BEGIN IMMEDIATE");
        expect(calls).toContain("COMMIT");
    });

    it("drainCommitBacklogForProject embeds pre-indexed commits with no new git log work", async () => {
        _setTestProviderFactoryForProject(
            (config) =>
                new FakeEmbeddingProvider(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        const projectIdentity = "git:commit-backlog";
        upsertCommits(db, projectIdentity, [
            makeGitCommit("backlog-a", 1000),
            makeGitCommit("backlog-b", 2000),
        ]);
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-commits"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/commits",
        );

        expect(countEmbeddedCommits(db, projectIdentity, currentModelId(projectIdentity))).toBe(0);
        const drained = await drainCommitBacklogForProject(
            db,
            projectIdentity,
            Date.now() + 60_000,
        );
        expect(drained).toBe(2);
        expect(countEmbeddedCommits(db, projectIdentity, currentModelId(projectIdentity))).toBe(2);
    });

    it("drainCommitBacklogForProject skips when git commit indexing is disabled", async () => {
        _setTestProviderFactoryForProject(
            (config) =>
                new FakeEmbeddingProvider(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        const projectIdentity = "git:commits-off";
        upsertCommits(db, projectIdentity, [makeGitCommit("off-a", 1000)]);
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-commits"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/commits-off",
        );

        const drained = await drainCommitBacklogForProject(
            db,
            projectIdentity,
            Date.now() + 60_000,
        );
        expect(drained).toBe(0);
        expect(countEmbeddedCommits(db, projectIdentity, currentModelId(projectIdentity))).toBe(0);
    });

    it("drainCommitBacklogForProject short-circuits when the git sweep lease is held", async () => {
        _setTestProviderFactoryForProject(
            (config) =>
                new FakeEmbeddingProvider(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        const projectIdentity = "git:lease-block";
        upsertCommits(db, projectIdentity, [makeGitCommit("lease-a", 1000)]);
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-commits"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/lease",
        );

        const holder = acquireGitSweepLease(db, projectIdentity, "other-holder");
        expect(holder.acquired).toBe(true);

        const drained = await drainCommitBacklogForProject(
            db,
            projectIdentity,
            Date.now() + 60_000,
        );
        expect(drained).toBe(0);
        expect(countEmbeddedCommits(db, projectIdentity, currentModelId(projectIdentity))).toBe(0);

        if (holder.acquired) {
            releaseGitSweepLease(db, projectIdentity, holder.holderId);
        }
    });

    it("keeps independent snapshots and providers for two projects in one process", async () => {
        _setTestProviderFactoryForProject(
            (config) =>
                new FakeEmbeddingProvider(config.provider === "local" ? config.model : "off"),
        );

        registerProjectEmbedding(
            useTempDb(),
            "git:project-a",
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/a",
        );
        registerProjectEmbedding(
            openDatabase(),
            "git:project-b",
            localConfig("model-b-long"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/b",
        );

        const first = getProjectEmbeddingSnapshot("git:project-a");
        const second = getProjectEmbeddingSnapshot("git:project-b");
        const firstVector = await embedTextForProject("git:project-a", "hello");
        const secondVector = await embedTextForProject("git:project-b", "hello");

        expect(first?.projectIdentity).toBe("git:project-a");
        expect(first?.sourceDirectory).toBe("/tmp/a");
        expect(first?.enabled).toBe(true);
        expect(first?.gitCommitEnabled).toBe(false);
        expect(second?.projectIdentity).toBe("git:project-b");
        expect(second?.sourceDirectory).toBe("/tmp/b");
        expect(second?.enabled).toBe(true);
        expect(second?.gitCommitEnabled).toBe(true);
        expect(firstVector?.modelId).not.toBe(secondVector?.modelId);
        expect(firstVector?.vector[1]).not.toBe(secondVector?.vector[1]);
    });

    it("uses observation:<sha> fingerprints and disables runtime reads for corrupt first-time config", () => {
        const snapshot = registerProjectInObservationMode(
            useTempDb(),
            "git:corrupt",
            "/tmp/corrupt",
            { provider: "off" },
            "embedding config parse failed",
        );

        expect(snapshot.runtimeFingerprint).toMatch(/^observation:[0-9a-f]+$/);
        expect(snapshot.enabled).toBe(false);
        expect(snapshot.gitCommitEnabled).toBe(false);
        expect(snapshot.modelId).toBe("off");
        expect(getProjectEmbeddingSnapshot("git:corrupt")?.runtimeFingerprint).toBe(
            snapshot.runtimeFingerprint,
        );
    });

    it("invalidates stale embedding results when registration changes during an in-flight call", async () => {
        let release: (() => void) | undefined;
        _setTestProviderFactoryForProject(
            (config) =>
                new (class extends FakeEmbeddingProvider {
                    async embed(): Promise<Float32Array> {
                        await new Promise<void>((resolve) => {
                            release = resolve;
                        });
                        return new Float32Array([1, 2]);
                    }
                })(config.provider === "local" ? config.model : "off"),
        );

        registerProjectEmbedding(
            useTempDb(),
            "git:project",
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/project",
        );
        const inFlight = embedTextForProject("git:project", "hello");
        registerProjectEmbedding(
            openDatabase(),
            "git:project",
            localConfig("model-b"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/project",
        );

        release?.();

        expect(await inFlight).toBeNull();
    });

    it("keeps memory, commit, and chunk embeddings coexisting per model", () => {
        const db = useTempDb();
        const projectIdentity = "git:coexist";
        const memory = insertMemory(db, {
            projectPath: projectIdentity,
            category: "CONSTRAINTS",
            content: "Keep per-model vectors independent.",
        });
        upsertCommits(db, projectIdentity, [makeGitCommit("coexist-a", 1000)]);
        const commitSha = makeGitCommit("coexist-a", 1000).sha;
        const compartmentId = seedCompartmentWithFts(db, "ses-coexist");
        const windows = chunkCanonicalText("[1] U: hello", 1, 1, 10_000);

        const first = registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/coexist",
        );
        saveEmbedding(db, memory.id, new Float32Array([1, 0]), first.modelId);
        saveCommitEmbedding(db, commitSha, new Float32Array([1, 0]), first.modelId);
        replaceCompartmentChunkEmbeddings(
            db,
            windows.map((window) => ({
                compartmentId,
                sessionId: "ses-coexist",
                projectPath: projectIdentity,
                window,
                modelId: first.chunkModelId,
                vector: new Float32Array([1, 0]),
            })),
        );

        const second = registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-b"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/coexist",
        );
        saveEmbedding(db, memory.id, new Float32Array([0, 1]), second.modelId);
        saveCommitEmbedding(db, commitSha, new Float32Array([0, 1]), second.modelId);
        replaceCompartmentChunkEmbeddings(
            db,
            windows.map((window) => ({
                compartmentId,
                sessionId: "ses-coexist",
                projectPath: projectIdentity,
                window,
                modelId: second.chunkModelId,
                vector: new Float32Array([0, 1]),
            })),
        );

        saveEmbedding(db, memory.id, new Float32Array([0, 2]), second.modelId);

        expect(
            Array.from(
                loadAllEmbeddings(db, projectIdentity, first.modelId).get(memory.id)!.embedding,
            ),
        ).toEqual([1, 0]);
        expect(
            Array.from(
                loadAllEmbeddings(db, projectIdentity, second.modelId).get(memory.id)!.embedding,
            ),
        ).toEqual([0, 2]);
        expect(
            countRows(
                db,
                `SELECT COUNT(*) AS count FROM git_commit_embeddings e
                 JOIN git_commits c ON c.sha = e.sha WHERE c.project_path = ?`,
                projectIdentity,
            ),
        ).toBe(2);
        expect(
            loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-coexist",
                projectIdentity,
                first.chunkModelId,
            ),
        ).toHaveLength(1);
        expect(
            loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-coexist",
                projectIdentity,
                second.chunkModelId,
            ),
        ).toHaveLength(1);

        const restored = registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/coexist",
        );
        expect(restored.modelId).toBe(first.modelId);
        expect(loadAllEmbeddings(db, projectIdentity, restored.modelId).has(memory.id)).toBe(true);
    });

    it("garbage-collects only stale inactive embedding identities after the grace window", () => {
        const db = useTempDb();
        const projectIdentity = "git:gc";
        const memory = insertMemory(db, {
            projectPath: projectIdentity,
            category: "CONSTRAINTS",
            content: "Delete only stale inactive embedding vectors.",
        });
        upsertCommits(db, projectIdentity, [makeGitCommit("gc-a", 1000)]);
        const commitSha = makeGitCommit("gc-a", 1000).sha;
        const compartmentId = seedCompartmentWithFts(db, "ses-gc");
        const windows = chunkCanonicalText("[1] U: hello", 1, 1, 10_000);
        const now = Date.now();

        const first = registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/gc",
        );
        saveEmbedding(db, memory.id, new Float32Array([1, 0]), first.modelId);
        saveCommitEmbedding(db, commitSha, new Float32Array([1, 0]), first.modelId);
        replaceCompartmentChunkEmbeddings(
            db,
            windows.map((window) => ({
                compartmentId,
                sessionId: "ses-gc",
                projectPath: projectIdentity,
                window,
                modelId: first.chunkModelId,
                vector: new Float32Array([1, 0]),
            })),
        );

        const second = registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-b"),
            { memoryEnabled: true, gitCommitEnabled: true },
            "/tmp/gc",
        );
        saveEmbedding(db, memory.id, new Float32Array([0, 1]), second.modelId);
        saveCommitEmbedding(db, commitSha, new Float32Array([0, 1]), second.modelId);
        replaceCompartmentChunkEmbeddings(
            db,
            windows.map((window) => ({
                compartmentId,
                sessionId: "ses-gc",
                projectPath: projectIdentity,
                window,
                modelId: second.chunkModelId,
                vector: new Float32Array([0, 1]),
            })),
        );

        db.prepare(
            "UPDATE embedding_identity_active SET last_active_at = ? WHERE project_path = ? AND model_id IN (?, ?)",
        ).run(now - 15 * 24 * 60 * 60 * 1000, projectIdentity, first.modelId, first.chunkModelId);
        db.prepare(
            "UPDATE embedding_identity_active SET last_active_at = ? WHERE project_path = ? AND model_id IN (?, ?)",
        ).run(now - 15 * 24 * 60 * 60 * 1000, projectIdentity, second.modelId, second.chunkModelId);

        const swept = sweepStaleEmbeddingIdentitiesForProject(db, projectIdentity, now);

        expect(swept.memoryRowsDeleted).toBe(1);
        expect(swept.commitRowsDeleted).toBe(1);
        expect(swept.chunkRowsDeleted).toBe(1);
        expect(loadAllEmbeddings(db, projectIdentity, first.modelId).size).toBe(0);
        expect(loadAllEmbeddings(db, projectIdentity, second.modelId).size).toBe(1);
        expect(countEmbeddedCommits(db, projectIdentity, second.modelId)).toBe(1);
        expect(
            loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-gc",
                projectIdentity,
                second.chunkModelId,
            ),
        ).toHaveLength(1);

        saveEmbedding(db, memory.id, new Float32Array([1, 0]), first.modelId);
        db.prepare(
            `INSERT INTO embedding_identity_active (project_path, scope, model_id, last_active_at)
             VALUES (?, 'memory', ?, ?)`,
        ).run(projectIdentity, first.modelId, now - 13 * 24 * 60 * 60 * 1000);
        const withinGrace = sweepStaleEmbeddingIdentitiesForProject(db, projectIdentity, now);
        expect(withinGrace.memoryRowsDeleted).toBe(0);
        expect(loadAllEmbeddings(db, projectIdentity, first.modelId).size).toBe(1);
    });

    it("suppresses GC while a project's last config load was untrusted", () => {
        const db = useTempDb();
        const projectIdentity = "git:untrusted-gc";
        const memory = insertMemory(db, {
            projectPath: projectIdentity,
            category: "CONSTRAINTS",
            content: "Do not GC off a degraded config load.",
        });
        const now = Date.now();

        const first = registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/untrusted-gc",
        );
        saveEmbedding(db, memory.id, new Float32Array([1, 0]), first.modelId);

        const second = registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-b"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/untrusted-gc",
        );
        saveEmbedding(db, memory.id, new Float32Array([0, 1]), second.modelId);
        // Age model-a past the grace window so it is a genuine GC candidate.
        db.prepare(
            "UPDATE embedding_identity_active SET last_active_at = ? WHERE project_path = ? AND model_id = ?",
        ).run(now - 15 * 24 * 60 * 60 * 1000, projectIdentity, first.modelId);

        // A subsequent untrusted config load latches the project: GC must no-op
        // even though model-a is a valid stale candidate, because the snapshot it
        // would delete against is last-known-good rather than a trusted config.
        markProjectLoadUntrusted(projectIdentity);
        const suppressed = sweepStaleEmbeddingIdentitiesForProject(db, projectIdentity, now);
        expect(suppressed.memoryRowsDeleted).toBe(0);
        expect(loadAllEmbeddings(db, projectIdentity, first.modelId).size).toBe(1);

        // A trusted re-register clears the latch; GC resumes and reaps model-a.
        const third = registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-b"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/untrusted-gc",
        );
        expect(third.modelId).toBe(second.modelId);
        db.prepare(
            "UPDATE embedding_identity_active SET last_active_at = ? WHERE project_path = ? AND model_id = ?",
        ).run(now - 15 * 24 * 60 * 60 * 1000, projectIdentity, first.modelId);
        const resumed = sweepStaleEmbeddingIdentitiesForProject(db, projectIdentity, now);
        expect(resumed.memoryRowsDeleted).toBe(1);
        expect(loadAllEmbeddings(db, projectIdentity, first.modelId).size).toBe(0);
        expect(loadAllEmbeddings(db, projectIdentity, second.modelId).size).toBe(1);
    });

    it("keeps old-model compartment chunk embeddings inert on provider change", async () => {
        const db = useTempDb();
        const compartmentId = seedCompartmentWithFts(db, "ses-wipe");
        const windows = chunkCanonicalText("[1] U: hello", 1, 1, 10_000);
        replaceCompartmentChunkEmbeddings(
            db,
            windows.map((window) => ({
                compartmentId,
                sessionId: "ses-wipe",
                projectPath: "git:wipe",
                window,
                modelId: "stale:model",
                vector: new Float32Array([1, 0]),
            })),
        );

        registerProjectEmbedding(
            db,
            "git:wipe",
            localConfig("model-b"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/wipe",
        );

        expect(
            loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-wipe",
                "git:wipe",
                currentChunkModelId("git:wipe"),
            ),
        ).toHaveLength(0);
        expect(
            loadCompartmentChunkEmbeddingsForSearch(db, "ses-wipe", "git:wipe", "stale:model"),
        ).toHaveLength(1);
    });

    it("backfill drains missing compartment chunks and is idempotent", async () => {
        let batchCalls = 0;
        _setTestProviderFactoryForProject(
            (config) =>
                new (class extends FakeEmbeddingProvider {
                    override async embedBatch(texts: string[]): Promise<Float32Array[]> {
                        batchCalls += 1;
                        return super.embedBatch(texts);
                    }
                })(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        seedCompartmentWithFts(db, "ses-backfill");
        recordSessionProjectIdentity(db, "ses-backfill", "git:backfill");
        registerProjectEmbedding(
            db,
            "git:backfill",
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/backfill",
        );

        const first = await sweepAllRegisteredProjects(db, 5);
        expect(first.chunksEmbedded).toBe(1);
        expect(
            loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-backfill",
                "git:backfill",
                currentChunkModelId("git:backfill"),
            ),
        ).toHaveLength(1);

        const second = await sweepAllRegisteredProjects(db, 5);
        expect(second.chunksEmbedded).toBe(0);
        expect(batchCalls).toBe(1);
    });

    it("bounds provider call size even when one compartment has many windows (#207)", async () => {
        const callSizes: number[] = [];
        _setTestProviderFactoryForProject(
            (config) =>
                new (class extends FakeEmbeddingProvider {
                    override async embedBatch(texts: string[]): Promise<Float32Array[]> {
                        callSizes.push(texts.length);
                        return super.embedBatch(texts);
                    }
                })(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        const compartmentId = seedOversizedCompartmentWithFts(db, "ses-huge");
        recordSessionProjectIdentity(db, "ses-huge", "git:huge");
        registerProjectEmbedding(
            db,
            "git:huge",
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/huge",
        );

        const embedded = await embedUnembeddedCompartmentChunksForProject(db, "git:huge");
        expect(embedded).toBe(1);

        // The single compartment produced many windows; assert NO provider call
        // exceeded the per-call window cap (MAX_WINDOWS_PER_EMBED_CALL = 2), i.e.
        // the windows were sub-batched across calls rather than sent as one
        // enormous payload.
        expect(callSizes.length).toBeGreaterThan(1);
        for (const size of callSizes) {
            expect(size).toBeLessThanOrEqual(2);
        }

        // And the compartment is fully embedded (one row per window, all persisted).
        const rows = loadCompartmentChunkEmbeddingsForSearch(
            db,
            "ses-huge",
            "git:huge",
            currentChunkModelId("git:huge"),
        );
        expect(rows.length).toBeGreaterThan(1);
        expect(new Set(rows.map((r) => r.compartmentId))).toEqual(new Set([compartmentId]));
    });

    it("keeps passive chunk backfill scoped to the caller project", async () => {
        _setTestProviderFactoryForProject(
            (config) =>
                new FakeEmbeddingProvider(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        seedCompartmentWithFts(db, "ses-project-a");
        seedCompartmentWithFts(db, "ses-project-b");
        recordSessionProjectIdentity(db, "ses-project-a", "git:project-a");
        recordSessionProjectIdentity(db, "ses-project-b", "git:project-b");
        registerProjectEmbedding(
            db,
            "git:project-a",
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/project-a",
        );

        const embedded = await embedUnembeddedCompartmentChunksForProject(db, "git:project-a");

        expect(embedded).toBe(1);
        expect(
            loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-project-a",
                "git:project-a",
                currentChunkModelId("git:project-a"),
            ),
        ).toHaveLength(1);
        expect(
            loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-project-b",
                "git:project-a",
                currentChunkModelId("git:project-a"),
            ),
        ).toHaveLength(0);
        expect(
            loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-project-b",
                "git:project-b",
                currentChunkModelId("git:project-a"),
            ),
        ).toHaveLength(0);
    });

    it("repairs chunk rows stamped with a different project than their session owner", async () => {
        const db = useTempDb();
        const compartmentId = seedCompartmentWithFts(db, "ses-repair");
        const windows = chunkCanonicalText("[1] U: hello", 1, 1, 10_000);
        replaceCompartmentChunkEmbeddings(
            db,
            windows.map((window) => ({
                compartmentId,
                sessionId: "ses-repair",
                projectPath: "git:wrong",
                window,
                modelId: "chunk:model",
                vector: new Float32Array([1, 0]),
            })),
        );

        recordSessionProjectIdentity(db, "ses-repair", "git:right");

        expect(
            loadCompartmentChunkEmbeddingsForSearch(db, "ses-repair", "git:wrong", "chunk:model"),
        ).toHaveLength(0);
        expect(
            loadCompartmentChunkEmbeddingsForSearch(db, "ses-repair", "git:right", "chunk:model"),
        ).toHaveLength(1);
    });

    it("does not backfill compartment chunks when memory is disabled", async () => {
        _setTestProviderFactoryForProject(
            (config) =>
                new FakeEmbeddingProvider(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        seedCompartmentWithFts(db, "ses-memory-off");
        recordSessionProjectIdentity(db, "ses-memory-off", "git:off");
        registerProjectEmbedding(
            db,
            "git:off",
            localConfig("model-a"),
            { memoryEnabled: false, gitCommitEnabled: false },
            "/tmp/off",
        );

        const result = await sweepAllRegisteredProjects(db, 5);
        expect(result.chunksEmbedded).toBe(0);
        expect(
            loadCompartmentChunkEmbeddingsForSearch(db, "ses-memory-off", "git:off", "chunk:model"),
        ).toHaveLength(0);
    });

    it("re-embeds chunks but preserves memory vectors when max_input_tokens changes", async () => {
        _setTestProviderFactoryForProject(
            (config) =>
                new FakeEmbeddingProvider(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        seedCompartmentWithFts(db, "ses-window");
        const firstSnapshot = registerProjectEmbedding(
            db,
            "git:window",
            localConfig("model-a", 1),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/window",
        );
        const memory = insertMemory(db, {
            projectPath: "git:window",
            category: "CONSTRAINTS",
            content: "Preserve provider-scoped memory vectors across chunk window changes.",
        });
        saveEmbedding(db, memory.id, new Float32Array([1, 2]), firstSnapshot.modelId);

        const first = await embedSessionCompartmentChunks(db, "git:window", "ses-window");
        expect(first.status).toBe("done");
        expect(
            loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-window",
                "git:window",
                firstSnapshot.chunkModelId,
            ),
        ).not.toHaveLength(0);

        registerProjectEmbedding(
            db,
            "git:window",
            localConfig("model-a", 10_000),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/window",
        );

        expect(getStoredModelId(db, "git:window")).toBe(firstSnapshot.modelId);
        expect(
            loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-window",
                "git:window",
                currentChunkModelId("git:window"),
            ),
        ).toHaveLength(0);
        expect(
            loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-window",
                "git:window",
                firstSnapshot.chunkModelId,
            ),
        ).not.toHaveLength(0);

        const second = await embedSessionCompartmentChunks(db, "git:window", "ses-window");
        expect(second.status).toBe("done");
        expect(second.embedded).toBe(1);
        expect(
            loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-window",
                "git:window",
                currentChunkModelId("git:window"),
            ),
        ).toHaveLength(1);
    });

    it("embedSessionCompartmentChunks drains a whole session and reports progress", async () => {
        _setTestProviderFactoryForProject(
            (config) =>
                new FakeEmbeddingProvider(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        // Three compartments in the session, plus one in a DIFFERENT session
        // that must NOT be touched (session-scoped, not project-scoped).
        seedManyCompartmentsWithFts(db, "ses-embed", 3);
        seedCompartmentWithFts(db, "ses-other");
        registerProjectEmbedding(
            db,
            "git:embed",
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/embed",
        );

        const progress: Array<{ embedded: number; total: number }> = [];
        const outcome = await embedSessionCompartmentChunks(db, "git:embed", "ses-embed", {
            batchSize: 1,
            onProgress: (p) => progress.push({ ...p }),
        });

        expect(outcome.status).toBe("done");
        expect(outcome.embedded).toBe(3);
        expect(outcome.total).toBe(3);
        // Progress is monotonic and ends at total; the only session embedded is ses-embed.
        expect(progress.at(-1)).toEqual({ embedded: 3, total: 3 });
        expect(
            loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-embed",
                "git:embed",
                currentChunkModelId("git:embed"),
            ).length,
        ).toBeGreaterThanOrEqual(3);
        expect(
            loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-other",
                "git:embed",
                currentChunkModelId("git:embed"),
            ),
        ).toHaveLength(0);

        // Idempotent: a second run finds nothing.
        const again = await embedSessionCompartmentChunks(db, "git:embed", "ses-embed");
        expect(again.status).toBe("nothing");
        expect(again.total).toBe(0);
    });

    it("embedSessionCompartmentChunks reports stalled when the provider returns null vectors", async () => {
        // Provider that yields null for every text → no compartment can persist.
        _setTestProviderFactoryForProject(
            (config) =>
                new (class extends FakeEmbeddingProvider {
                    override async embedBatch(texts: string[]): Promise<Float32Array[]> {
                        return texts.map(() => null as unknown as Float32Array);
                    }
                })(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        seedManyCompartmentsWithFts(db, "ses-stall", 2);
        registerProjectEmbedding(
            db,
            "git:stall",
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/stall",
        );

        const outcome = await embedSessionCompartmentChunks(db, "git:stall", "ses-stall", {
            batchSize: 1,
        });
        expect(outcome.status).toBe("stalled");
        expect(outcome.embedded).toBe(0);
        if (outcome.status === "stalled") {
            expect(outcome.remaining).toBe(2);
        }
    });

    it("embedSessionCompartmentChunks caps windows per provider call across compartments", async () => {
        const callWindowCounts: number[] = [];
        _setTestProviderFactoryForProject(
            (config) =>
                new (class extends FakeEmbeddingProvider {
                    override async embedBatch(texts: string[]): Promise<Float32Array[]> {
                        callWindowCounts.push(texts.length);
                        return super.embedBatch(texts);
                    }
                })(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        // 20 single-window compartments + a large batchSize so the drain selects
        // many at once — the per-call WINDOW cap (16) must split them across
        // multiple provider calls even though they fit in one candidate query.
        const sessionId = "ses-manycomp";
        seedManyCompartmentsWithFts(db, sessionId, 20);
        registerProjectEmbedding(
            db,
            "git:manycomp",
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/manycomp",
        );

        const outcome = await embedSessionCompartmentChunks(db, "git:manycomp", sessionId, {
            batchSize: 20,
        });
        expect(outcome.status).toBe("done");
        expect(outcome.embedded).toBe(20);
        // No single provider call exceeded the window cap, and 20 one-window
        // compartments required more than one call (20 > 16).
        expect(callWindowCounts.length).toBeGreaterThan(1);
        expect(Math.max(...callWindowCounts)).toBeLessThanOrEqual(16);
    });

    it("embedSessionCompartmentChunks returns disabled when memory is off", async () => {
        _setTestProviderFactoryForProject(
            (config) =>
                new FakeEmbeddingProvider(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        seedCompartmentWithFts(db, "ses-off");
        registerProjectEmbedding(
            db,
            "git:embed-off",
            localConfig("model-a"),
            { memoryEnabled: false, gitCommitEnabled: false },
            "/tmp/embed-off",
        );

        const outcome = await embedSessionCompartmentChunks(db, "git:embed-off", "ses-off");
        expect(outcome.status).toBe("disabled");
        expect(outcome.embedded).toBe(0);
    });

    it("embedSessionCompartmentChunks aborts cleanly on signal", async () => {
        _setTestProviderFactoryForProject(
            (config) =>
                new FakeEmbeddingProvider(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        seedManyCompartmentsWithFts(db, "ses-abort", 4);
        registerProjectEmbedding(
            db,
            "git:abort",
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/abort",
        );

        const controller = new AbortController();
        const outcome = await embedSessionCompartmentChunks(db, "git:abort", "ses-abort", {
            batchSize: 1,
            signal: controller.signal,
            onProgress: ({ embedded }) => {
                if (embedded >= 2) controller.abort();
            },
        });

        expect(outcome.status).toBe("aborted");
        expect(outcome.embedded).toBeGreaterThanOrEqual(2);
        expect(outcome.embedded).toBeLessThan(4);
    });
});
