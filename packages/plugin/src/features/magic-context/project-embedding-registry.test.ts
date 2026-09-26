import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmbeddingConfig } from "../../config/schema/magic-context";
import { formatEmbedStatusText } from "../../hooks/magic-context/format-embed-status";
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
import {
    getSynapseLaneIdentity,
    SynapseEmbeddingProvider,
    type SynapseLaneMetadata,
} from "./memory/embedding-synapse";
import { insertMemory } from "./memory/storage-memory";
import {
    getStoredModelId,
    loadAllEmbeddings,
    saveEmbedding,
} from "./memory/storage-memory-embeddings";
import { recordMessageFtsRowid } from "./message-fts-rowid-map";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setShadowBackfillNowForTests,
    _setTestProviderFactoryForProject,
    drainCommitBacklogForProject,
    embedSessionCompartmentChunks,
    embedTextForProject,
    embedUnembeddedCompartmentChunksForProject,
    embedUnembeddedMemoriesForProject,
    flushShadowEmbeddingBacklog,
    getEmbeddingCoverageStatus,
    getProjectEmbeddingSnapshot,
    getShadowBackfillRemaining,
    getShadowBackfillStopReason,
    getShadowEmbeddingMeasurementCohort,
    markProjectLoadUntrusted,
    registerProjectEmbedding,
    registerProjectInObservationMode,
    registerProjectShadowEmbedding,
    sweepAllRegisteredProjects,
    sweepStaleEmbeddingIdentitiesForProject,
    TestProviderFactoryRequiredError,
    unregisterProjectShadowEmbedding,
} from "./project-embedding-registry";
import { recordSessionProjectIdentity } from "./session-project-storage";
import { closeDatabase, openDatabase } from "./storage";
import { beginSynapseBatchLedger } from "./storage-embedding-measurements";

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

function insertMappedFtsRow(
    db: NonNullable<ReturnType<typeof openDatabase>>,
    sessionId: string,
    ordinal: number,
    messageId: string,
    role: "user" | "assistant",
    content: string,
): void {
    const result = db
        .prepare(
            "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
        )
        .run(sessionId, ordinal, messageId, role, content) as {
        lastInsertRowid: number | bigint;
    };
    recordMessageFtsRowid(db, sessionId, ordinal, result.lastInsertRowid);
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
    insertMappedFtsRow(
        db,
        sessionId,
        1,
        `${sessionId}-u1`,
        "user",
        "How do we avoid saturating the queue?",
    );
    insertMappedFtsRow(
        db,
        sessionId,
        2,
        `${sessionId}-a2`,
        "assistant",
        "Use backpressure and bounded drains.",
    );
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
        insertMappedFtsRow(
            db,
            sessionId,
            start,
            `${sessionId}-u${start}`,
            "user",
            `Question ${i}?`,
        );
        insertMappedFtsRow(db, sessionId, end, `${sessionId}-a${end}`, "assistant", `Answer ${i}.`);
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
    insertMappedFtsRow(db, sessionId, 1, `${sessionId}-a1`, "assistant", huge);
    return getCompartments(db, sessionId)[0].id;
}

describe("project embedding registry", () => {
    const tempDirs: string[] = [];
    const originalXdgDataHome = process.env.XDG_DATA_HOME;
    const originalHfEndpoint = process.env.HF_ENDPOINT;

    function useTempDb() {
        const dir = mkdtempSync(join(tmpdir(), "project-embedding-registry-"));
        tempDirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        return openDatabase();
    }

    afterEach(() => {
        _resetProjectEmbeddingRegistryForTests();
        closeDatabase();
        if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = originalXdgDataHome;
        if (originalHfEndpoint === undefined) delete process.env.HF_ENDPOINT;
        else process.env.HF_ENDPOINT = originalHfEndpoint;
        for (const dir of tempDirs) {
            try {
                rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            } catch {
                /* Ignore EBUSY on Windows */
            }
        }
        tempDirs.length = 0;
    });

    it("keeps a disclosed truncated chunk incomplete while persisting sibling rows", async () => {
        const db = useTempDb();
        const projectIdentity = "git:synapse-truncated-row";
        const sessionId = "session-synapse-truncated-row";
        const fingerprint = "fp-synapse-wire";
        const metadata: SynapseLaneMetadata = {
            model: "gte-modernbert-base-f16",
            fingerprint,
            table_epoch: 4,
            max_tokens: 512,
            max_tokens_source: "worker_bucket",
            bucket_ladder: [128, 256, 512],
            dims: 2,
            dtype: "f16",
            device_class: "ane",
            certified: true,
            warm_load_cost_hint_ms: 9,
            laneIdentity: getSynapseLaneIdentity("gte-modernbert-base-f16", fingerprint),
        };
        _setTestProviderFactoryForProject(
            () =>
                new SynapseEmbeddingProvider({
                    connectionFile: "fixture",
                    projectRoot: "/repo",
                    session: "test:truncated-row",
                    metadata,
                    clientFactory: async () => ({
                        async call(_module: string, method: string, params?: unknown) {
                            if (method !== "embed.batch") {
                                throw new Error(`unexpected method ${method}`);
                            }
                            const items = (params as { items: Array<{ id: string; text: string }> })
                                .items;
                            return {
                                result: {
                                    fingerprint,
                                    table_epoch: 4,
                                    dims: 2,
                                    payload: {
                                        vectors: items.map((item, index) => ({
                                            id: item.id,
                                            vector: [item.text.length, 1],
                                            submitted_sha256: createHash("sha256")
                                                .update(item.text)
                                                .digest("hex"),
                                            content_sha256: createHash("sha256")
                                                .update(
                                                    index === 0 ? item.text.slice(0, 8) : item.text,
                                                )
                                                .digest("hex"),
                                        })),
                                        truncation_disclosures: items.map((_item, index) => ({
                                            submitted_tokens: 16,
                                            effective_tokens: index === 0 ? 8 : 16,
                                            truncated: index === 0,
                                        })),
                                    },
                                },
                            };
                        },
                        close() {},
                    }),
                }),
        );
        const descriptor = {
            lane: metadata.model,
            device_class: "ane",
            max_tokens: 512,
            max_tokens_source: "worker_bucket" as const,
            bucket_ladder: [128, 256, 512],
            dims: 2,
            dtype: "f16",
            certified: true,
            warm_load_cost_hint_ms: 9,
            warm: true,
        };
        registerProjectEmbedding(
            db,
            projectIdentity,
            {
                provider: "synapse",
                model: metadata.model,
                max_input_tokens: 512,
                synapse_connection_file: "fixture",
                synapse_fingerprint: fingerprint,
                synapse_table_epoch: 4,
                synapse_dims: 2,
                synapse_descriptor: descriptor,
            } as unknown as EmbeddingConfig,
            { memoryEnabled: true, gitCommitEnabled: false },
            "/repo",
        );
        seedManyCompartmentsWithFts(db, sessionId, 2);
        const compartments = getCompartments(db, sessionId);

        const outcome = await embedSessionCompartmentChunks(db, projectIdentity, sessionId, {
            batchSize: 2,
        });

        expect(outcome).toMatchObject({ status: "stalled", embedded: 1, failed: 1 });
        const rows = loadCompartmentChunkEmbeddingsForSearch(
            db,
            sessionId,
            projectIdentity,
            currentChunkModelId(projectIdentity),
        );
        expect(rows.map((row) => row.compartmentId)).toEqual([compartments[1].id]);
        const coverage = getEmbeddingCoverageStatus(db, projectIdentity, sessionId);
        expect(coverage).toMatchObject({
            session: { embedded: 1, total: 2 },
            synapseDescriptor: descriptor,
        });
        expect(formatEmbedStatusText(coverage, { status: "idle" })).toContain(
            "Synapse — lane=gte-modernbert-base-f16; device_class=ane; max_tokens=512 (worker_bucket); certified=true; warm=yes; warm_load_cost_hint_ms=9",
        );
        const persisted = db
            .prepare(
                "SELECT provenance_json AS provenanceJson FROM embedding_registrations WHERE project_path = ?",
            )
            .get(projectIdentity) as { provenanceJson: string };
        expect(JSON.parse(persisted.provenanceJson)).toMatchObject({
            capability_descriptor: descriptor,
        });
    });

    it("keeps query instructions out of stored-vector identities and folds document prefixes in", () => {
        const db = useTempDb();
        const projectIdentity = "git:prefix-identity";
        const features = { memoryEnabled: true, gitCommitEnabled: true };
        const baseConfig: EmbeddingConfig = {
            provider: "openai-compatible",
            model: "qwen/qwen3-embedding-8b:free",
            endpoint: "https://openrouter.ai/api/v1",
        };

        const withFamilyDefault = registerProjectEmbedding(
            db,
            projectIdentity,
            baseConfig,
            features,
            "/repo",
        );
        const withQueryDisabled = registerProjectEmbedding(
            db,
            projectIdentity,
            { ...baseConfig, query_instruction: false },
            features,
            "/repo",
        );
        const withCustomQuery = registerProjectEmbedding(
            db,
            projectIdentity,
            { ...baseConfig, query_instruction: "Instruct: custom\nQuery: " },
            features,
            "/repo",
        );
        const withDocumentPrefix = registerProjectEmbedding(
            db,
            projectIdentity,
            { ...baseConfig, document_prefix: "search_document: " },
            features,
            "/repo",
        );

        expect(withQueryDisabled.modelId).toBe(withFamilyDefault.modelId);
        expect(withQueryDisabled.chunkModelId).toBe(withFamilyDefault.chunkModelId);
        expect(withCustomQuery.modelId).toBe(withFamilyDefault.modelId);
        expect(withCustomQuery.chunkModelId).toBe(withFamilyDefault.chunkModelId);
        expect(withDocumentPrefix.modelId).not.toBe(withFamilyDefault.modelId);
        expect(withDocumentPrefix.chunkModelId).not.toBe(withFamilyDefault.chunkModelId);
    });

    it("keeps memory and chunk identities byte-identical across HF_ENDPOINT mirrors", () => {
        const db = useTempDb();
        const config = localConfig("Xenova/all-MiniLM-L6-v2");
        const features = { memoryEnabled: true, gitCommitEnabled: true };

        delete process.env.HF_ENDPOINT;
        const defaultEndpoint = registerProjectEmbedding(
            db,
            "identity-default-endpoint",
            config,
            features,
            "/repo",
        );
        process.env.HF_ENDPOINT = "https://mirror.example/";
        const mirrorEndpoint = registerProjectEmbedding(
            db,
            "identity-mirror-endpoint",
            config,
            features,
            "/repo",
        );

        expect({
            memory: mirrorEndpoint.modelId,
            chunk: mirrorEndpoint.chunkModelId,
        }).toEqual({
            memory: defaultEndpoint.modelId,
            chunk: defaultEndpoint.chunkModelId,
        });
    });

    it("pins provider and runtime identity goldens", () => {
        const db = useTempDb();
        const features = { memoryEnabled: true, gitCommitEnabled: true };
        const local = registerProjectEmbedding(
            db,
            "golden-local",
            { provider: "local", model: "Xenova/all-MiniLM-L6-v2" },
            features,
            "/repo",
        );
        const openai = registerProjectEmbedding(
            db,
            "golden-openai",
            {
                provider: "openai-compatible",
                model: "text-embedding-3-small",
                endpoint: "https://example.test/v1",
                api_key: "secret",
                input_type: "passage",
                truncate: "END",
            },
            features,
            "/repo",
        );
        const off = registerProjectEmbedding(
            db,
            "golden-off",
            { provider: "off" },
            features,
            "/repo",
        );
        expect({
            providerIdentity: local.providerIdentity,
            runtimeFingerprint: local.runtimeFingerprint,
        }).toEqual({
            providerIdentity: "embedding-provider:ac1a4f8f0674f430a6c85a0e1a43a86a",
            runtimeFingerprint:
                "embedding-provider:ac1a4f8f0674f430a6c85a0e1a43a86a:4bc2bab437bc88bc",
        });
        expect({
            providerIdentity: openai.providerIdentity,
            runtimeFingerprint: openai.runtimeFingerprint,
        }).toEqual({
            providerIdentity: "embedding-provider:efd9edf1dbe1d83cef0860fb93475cb4",
            runtimeFingerprint:
                "embedding-provider:efd9edf1dbe1d83cef0860fb93475cb4:9b840cd5c05319d9",
        });
        expect({
            providerIdentity: off.providerIdentity,
            runtimeFingerprint: off.runtimeFingerprint,
        }).toEqual({
            providerIdentity: "embedding-provider:off",
            runtimeFingerprint: "embedding-provider:off",
        });
    });

    it("fails closed before a test constructs a provider without a factory (#388)", () => {
        expect(process.env.MAGIC_CONTEXT_TEST_DATA_DIR).toBeTruthy();

        let thrown: unknown;
        try {
            registerProjectShadowEmbedding(
                useTempDb(),
                "git:no-test-provider-factory",
                {
                    provider: "synapse",
                    model: "test-synapse-model",
                    synapse_fingerprint: "test-fingerprint",
                    synapse_table_epoch: 1,
                    synapse_dims: 8,
                } as unknown as EmbeddingConfig,
                "/tmp/no-test-provider-factory",
            );
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(TestProviderFactoryRequiredError);
        expect(thrown).toMatchObject({
            name: "TestProviderFactoryRequiredError",
            message:
                "test constructed a network-capable embedding provider without a test factory — install _setTestProviderFactoryForProject or set embedding.provider off in the fixture",
        });
    });

    it("keeps provider off as a clean null without a test factory", async () => {
        const db = useTempDb();
        registerProjectEmbedding(
            db,
            "git:test-provider-off",
            { provider: "off" },
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/test-provider-off",
        );

        await expect(
            embedTextForProject("git:test-provider-off", "not embedded"),
        ).resolves.toBeNull();
    });

    it("default local config keeps the current runtime golden without a dtype-only re-embed (#259)", () => {
        const db = useTempDb();
        const features = { memoryEnabled: true, gitCommitEnabled: true };
        const noDtype = registerProjectEmbedding(
            db,
            "golden-local-nodtype",
            { provider: "local", model: "Xenova/all-MiniLM-L6-v2" },
            features,
            "/repo",
        );
        // Must match the runtime-versioned golden above. Omitting local_dtype
        // does not add another identity term because fp32 remains the default.
        expect(noDtype.providerIdentity).toBe(
            "embedding-provider:ac1a4f8f0674f430a6c85a0e1a43a86a",
        );
    });

    it("a non-default local_dtype folds into the identity and differs from the default (#259)", () => {
        const db = useTempDb();
        const features = { memoryEnabled: true, gitCommitEnabled: true };
        const withDtype = registerProjectEmbedding(
            db,
            "golden-local-q8",
            {
                provider: "local",
                model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
                local_dtype: "q8",
            },
            features,
            "/repo",
        );
        const sameModelNoDtype = registerProjectEmbedding(
            db,
            "golden-local-multilingual-nodtype",
            {
                provider: "local",
                model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
            },
            features,
            "/repo",
        );
        // A non-default dtype must produce a DIFFERENT identity than the same
        // model without a dtype — otherwise switching dtype would mix vector
        // spaces instead of re-embedding.
        expect(withDtype.providerIdentity).not.toBe(sameModelNoDtype.providerIdentity);
        // And the dtype must actually participate (identity changes with dtype).
        const withFp32 = registerProjectEmbedding(
            db,
            "golden-local-multilingual-fp32",
            {
                provider: "local",
                model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
                local_dtype: "fp32",
            },
            features,
            "/repo",
        );
        // fp32 is the default, so an explicit fp32 must match the no-dtype
        // identity (default behavior preserved exactly).
        expect(withFp32.providerIdentity).toBe(sameModelNoDtype.providerIdentity);
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

    it("stores unembedded memory vectors when the memory content stays unchanged", async () => {
        _setTestProviderFactoryForProject(
            (config) =>
                new FakeEmbeddingProvider(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        const projectIdentity = "git:memory-backfill";
        const memory = insertMemory(db, {
            projectPath: projectIdentity,
            category: "CONSTRAINTS",
            content: "Backfill this exact memory.",
        });
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/memory-backfill",
        );

        const embedded = await embedUnembeddedMemoriesForProject(db, projectIdentity, 10);

        expect(embedded).toBe(1);
        expect(
            loadAllEmbeddings(db, projectIdentity, currentModelId(projectIdentity)).has(memory.id),
        ).toBe(true);
    });

    it("skips stale sweep results when a memory changes before the batch save", async () => {
        let release: (() => void) | undefined;
        let batchStarted: (() => void) | undefined;
        _setTestProviderFactoryForProject(
            (config) =>
                new (class extends FakeEmbeddingProvider {
                    override async embedBatch(texts: string[]): Promise<Float32Array[]> {
                        batchStarted?.();
                        await new Promise<void>((resolve) => {
                            release = resolve;
                        });
                        return super.embedBatch(texts);
                    }
                })(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        const projectIdentity = "git:memory-stale";
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
            "/tmp/memory-stale",
        );

        const started = new Promise<void>((resolve) => {
            batchStarted = resolve;
        });
        const inFlight = embedUnembeddedMemoriesForProject(db, projectIdentity, 10);
        await started;
        db.prepare(
            "UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ? WHERE id = ?",
        ).run("New memory body", "new-memory-hash", Date.now(), memory.id);
        release?.();

        expect(await inFlight).toBe(0);
        expect(loadAllEmbeddings(db, projectIdentity, currentModelId(projectIdentity)).size).toBe(
            0,
        );
    });

    it("prunes expired synthetic-session ledger rows on project registration", () => {
        const db = useTempDb();
        const projectIdentity = "git:ledger-prune";
        const fifteenDaysMs = 15 * 24 * 60 * 60 * 1000;
        const thirteenDaysMs = 13 * 24 * 60 * 60 * 1000;
        // Both synthetic session keys the embedding lanes use: the primary lane
        // keys its ledger by the project identity, the shadow lane by
        // `shadow:<projectIdentity>`. Neither is ever session-deleted.
        for (const sessionId of [projectIdentity, `shadow:${projectIdentity}`]) {
            beginSynapseBatchLedger(db, {
                sessionId,
                projectPath: projectIdentity,
                scope: "memory",
                manifest: [],
                requestKey: `${sessionId}:old`,
            });
            beginSynapseBatchLedger(db, {
                sessionId,
                projectPath: projectIdentity,
                scope: "memory",
                manifest: [],
                requestKey: `${sessionId}:fresh`,
            });
            db.prepare(
                "UPDATE synapse_batch_ledger SET updated_at = ? WHERE session_id = ? AND request_key = ?",
            ).run(Date.now() - fifteenDaysMs, sessionId, `${sessionId}:old`);
            db.prepare(
                "UPDATE synapse_batch_ledger SET updated_at = ? WHERE session_id = ? AND request_key = ?",
            ).run(Date.now() - thirteenDaysMs, sessionId, `${sessionId}:fresh`);
        }

        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/ledger-prune",
        );

        // Rows older than the 14-day TTL are gone from both synthetic sessions;
        // rows inside the TTL are kept.
        expect(
            countRows(
                db,
                "SELECT COUNT(*) AS count FROM synapse_batch_ledger WHERE request_key LIKE '%:old'",
            ),
        ).toBe(0);
        expect(
            countRows(
                db,
                "SELECT COUNT(*) AS count FROM synapse_batch_ledger WHERE request_key LIKE '%:fresh'",
            ),
        ).toBe(2);
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

    it("deletes stale embedding rows in bounded batches and resumes on the next sweep", () => {
        const db = useTempDb();
        const projectIdentity = "git:gc-batched";
        const compartmentId = seedCompartmentWithFts(db, "ses-gc-batched");
        const windows = chunkCanonicalText("[1] U: hello", 1, 1, 10_000);
        const now = Date.now();
        const first = registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/gc-batched",
        );
        replaceCompartmentChunkEmbeddings(
            db,
            windows.map((window) => ({
                compartmentId,
                sessionId: "ses-gc-batched",
                projectPath: projectIdentity,
                window,
                modelId: first.chunkModelId,
                vector: new Float32Array([1, 0]),
            })),
        );
        db.prepare(
            `WITH RECURSIVE seq(n) AS (
                 SELECT 1
                 UNION ALL
                 SELECT n + 1 FROM seq WHERE n < 299
             )
             INSERT INTO compartment_chunk_embeddings(
                 compartment_id, session_id, project_path, harness, window_index,
                 start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at
             )
             SELECT base.compartment_id, base.session_id, base.project_path, base.harness, seq.n,
                    base.start_ordinal, base.end_ordinal, base.chunk_hash || '-' || seq.n,
                    base.model_id, base.dims, base.vector, base.created_at
             FROM compartment_chunk_embeddings base
             CROSS JOIN seq
             WHERE base.compartment_id = ? AND base.model_id = ? AND base.window_index = 0`,
        ).run(compartmentId, first.chunkModelId);

        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-b"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/gc-batched",
        );
        db.prepare(
            `UPDATE embedding_identity_active
             SET last_active_at = ?
             WHERE project_path = ? AND scope = 'chunk' AND model_id = ?`,
        ).run(now - 15 * 24 * 60 * 60 * 1000, projectIdentity, first.chunkModelId);

        const firstSweep = sweepStaleEmbeddingIdentitiesForProject(db, projectIdentity, now);
        expect(firstSweep.chunkRowsDeleted).toBe(250);
        expect(firstSweep.trackingRowsDeleted).toBe(0);
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM compartment_chunk_embeddings WHERE project_path = ? AND model_id = ?",
                )
                .get(projectIdentity, first.chunkModelId),
        ).toEqual({ count: 50 });

        const secondSweep = sweepStaleEmbeddingIdentitiesForProject(db, projectIdentity, now);
        expect(secondSweep.chunkRowsDeleted).toBe(50);
        expect(secondSweep.trackingRowsDeleted).toBe(1);
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

    it("caps each automatic chunk-drain tick and yields before provider work", async () => {
        let timerRan = false;
        let providerCalls = 0;
        _setTestProviderFactoryForProject(
            (config) =>
                new (class extends FakeEmbeddingProvider {
                    override async embedBatch(texts: string[]): Promise<Float32Array[]> {
                        providerCalls += 1;
                        expect(timerRan).toBe(true);
                        return super.embedBatch(texts);
                    }
                })(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        seedManyCompartmentsWithFts(db, "ses-tick-cap", 9);
        recordSessionProjectIdentity(db, "ses-tick-cap", "git:tick-cap");
        registerProjectEmbedding(
            db,
            "git:tick-cap",
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/tick-cap",
        );
        setTimeout(() => {
            timerRan = true;
        }, 0);

        expect(await embedUnembeddedCompartmentChunksForProject(db, "git:tick-cap")).toBe(8);
        expect(await embedUnembeddedCompartmentChunksForProject(db, "git:tick-cap")).toBe(1);
        expect(providerCalls).toBeGreaterThan(1);
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

    it("caps session-scoped chunk repair work per observation", () => {
        const db = useTempDb();
        const compartmentId = seedCompartmentWithFts(db, "ses-repair-batched");
        const windows = chunkCanonicalText("[1] U: hello", 1, 1, 10_000);
        replaceCompartmentChunkEmbeddings(
            db,
            windows.map((window) => ({
                compartmentId,
                sessionId: "ses-repair-batched",
                projectPath: "git:wrong",
                window,
                modelId: "chunk:model",
                vector: new Float32Array([1, 0]),
            })),
        );
        db.prepare(
            `WITH RECURSIVE seq(n) AS (
                 SELECT 1
                 UNION ALL
                 SELECT n + 1 FROM seq WHERE n < 149
             )
             INSERT INTO compartment_chunk_embeddings(
                 compartment_id, session_id, project_path, harness, window_index,
                 start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at
             )
             SELECT base.compartment_id, base.session_id, base.project_path, base.harness, seq.n,
                    base.start_ordinal, base.end_ordinal, base.chunk_hash || '-' || seq.n,
                    base.model_id, base.dims, base.vector, base.created_at
             FROM compartment_chunk_embeddings base
             CROSS JOIN seq
             WHERE base.compartment_id = ? AND base.model_id = ? AND base.window_index = 0`,
        ).run(compartmentId, "chunk:model");

        recordSessionProjectIdentity(db, "ses-repair-batched", "git:right");
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM compartment_chunk_embeddings WHERE session_id = ? AND project_path = ?",
                )
                .get("ses-repair-batched", "git:right"),
        ).toEqual({ count: 100 });

        recordSessionProjectIdentity(db, "ses-repair-batched", "git:right");
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM compartment_chunk_embeddings WHERE session_id = ? AND project_path = ?",
                )
                .get("ses-repair-batched", "git:right"),
        ).toEqual({ count: 150 });
    });

    // Issue 543: history embedding is not a memory feature. With memory off and
    // a provider configured, the passive backfill still embeds compartments,
    // but memory rows are never embedded.
    it("backfills compartment chunks when memory is disabled but embeds no memories", async () => {
        _setTestProviderFactoryForProject(
            (config) =>
                new FakeEmbeddingProvider(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        seedCompartmentWithFts(db, "ses-memory-off");
        recordSessionProjectIdentity(db, "ses-memory-off", "git:off");
        const snapshot = registerProjectEmbedding(
            db,
            "git:off",
            localConfig("model-a"),
            { memoryEnabled: false, gitCommitEnabled: false },
            "/tmp/off",
        );
        insertMemory(db, {
            projectPath: "git:off",
            category: "CONSTRAINTS",
            content: "A memory left over from before memory was turned off.",
        });
        expect(snapshot.enabled).toBe(false);
        expect(snapshot.historyEnabled).toBe(true);

        const result = await sweepAllRegisteredProjects(db, 5);
        expect(result.chunksEmbedded).toBe(1);
        expect(result.memoriesEmbedded).toBe(0);
        expect(
            loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-memory-off",
                "git:off",
                currentChunkModelId("git:off"),
            ),
        ).toHaveLength(1);
        expect(db.prepare("SELECT COUNT(*) AS count FROM memory_embeddings").get()).toEqual({
            count: 0,
        });
        const coverage = getEmbeddingCoverageStatus(db, "git:off", "ses-memory-off");
        expect(coverage.enabled).toBe(true);
        expect(coverage.session).toEqual({ embedded: 1, total: 1 });
        expect(coverage.memories).toEqual({ embedded: 0, total: 0, memoryEnabled: false });
    });

    it("embeds nothing when the embedding provider is off", async () => {
        let providerCalls = 0;
        _setTestProviderFactoryForProject((config) => {
            providerCalls += 1;
            return new FakeEmbeddingProvider(config.provider === "local" ? config.model : "off");
        });
        const db = useTempDb();
        seedCompartmentWithFts(db, "ses-provider-off");
        recordSessionProjectIdentity(db, "ses-provider-off", "git:provider-off");
        const snapshot = registerProjectEmbedding(
            db,
            "git:provider-off",
            { provider: "off" },
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/provider-off",
        );
        insertMemory(db, {
            projectPath: "git:provider-off",
            category: "CONSTRAINTS",
            content: "A memory that must stay unembedded while the provider is off.",
        });
        expect(snapshot.enabled).toBe(false);
        expect(snapshot.historyEnabled).toBe(false);

        const result = await sweepAllRegisteredProjects(db, 5);
        expect(result).toMatchObject({ chunksEmbedded: 0, memoriesEmbedded: 0 });
        const outcome = await embedSessionCompartmentChunks(
            db,
            "git:provider-off",
            "ses-provider-off",
        );
        expect(outcome.status).toBe("disabled");
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM compartment_chunk_embeddings").get(),
        ).toEqual({ count: 0 });
        expect(db.prepare("SELECT COUNT(*) AS count FROM memory_embeddings").get()).toEqual({
            count: 0,
        });
        expect(providerCalls).toBe(0);
        expect(getEmbeddingCoverageStatus(db, "git:provider-off", "ses-provider-off").enabled).toBe(
            false,
        );
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

    it("auto chunk drain defers compartments whose legacy FTS span is not mapped", async () => {
        let providerCalls = 0;
        _setTestProviderFactoryForProject(
            (config) =>
                new (class extends FakeEmbeddingProvider {
                    override async embedBatch(texts: string[]): Promise<Float32Array[]> {
                        providerCalls += 1;
                        return super.embedBatch(texts);
                    }
                })(config.provider === "local" ? config.model : "off"),
        );
        const db = useTempDb();
        db.prepare(
            "UPDATE message_fts_rowid_map_backfill_state SET completed = 0, watermark_rowid = 0 WHERE id = 1",
        ).run();
        appendCompartments(db, "ses-unmapped", [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 1,
                startMessageId: "u1",
                endMessageId: "u1",
                title: "Deferred legacy span",
                content: "summary must not hide an unmapped transcript",
                p1: "summary must not hide an unmapped transcript",
            },
        ]);
        db.prepare(
            "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES ('ses-unmapped', 1, 'u1', 'user', 'legacy transcript')",
        ).run();
        registerProjectEmbedding(
            db,
            "git:unmapped",
            localConfig("model-a"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/unmapped",
        );
        recordSessionProjectIdentity(db, "ses-unmapped", "git:unmapped");

        expect(await embedUnembeddedCompartmentChunksForProject(db, "git:unmapped")).toBe(0);
        expect(providerCalls).toBe(0);
        expect(
            loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-unmapped",
                "git:unmapped",
                currentChunkModelId("git:unmapped"),
            ),
        ).toHaveLength(0);
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

    // Issue 543: the session drain (manual /ctx-embed and the automatic
    // per-session trigger) embeds history with memory off.
    it("embedSessionCompartmentChunks embeds history when memory is off", async () => {
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
        expect(outcome.status).toBe("done");
        expect(outcome.embedded).toBe(1);
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

    it("getShadowBackfillStopReason returns drained after a successful shadow backfill", async () => {
        _setTestProviderFactoryForProject(
            (config) =>
                new FakeEmbeddingProvider(config.provider === "local" ? config.model : "shadow"),
        );
        const db = useTempDb();
        const projectIdentity = "git:stop-drained";
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/stop-drained",
        );
        // Seed a few primary memories so the shadow backfill has work to do.
        for (let i = 0; i < 3; i++) {
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "CONSTRAINTS",
                content: `drained memory ${i}`,
            });
            saveEmbedding(db, memory.id, new Float32Array([i, 1]), currentModelId(projectIdentity));
        }

        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            {
                provider: "synapse",
                model: "synapse-model",
                synapse_fingerprint: "fp-drained",
            } as unknown as EmbeddingConfig,
            "/tmp/stop-drained",
        );
        await flushShadowEmbeddingBacklog(projectIdentity);

        expect(getShadowBackfillStopReason(projectIdentity, "memory")).toBe("drained");
    });

    it("getShadowBackfillStopReason returns stalled_no_progress when the provider cannot embed", async () => {
        // Provider that yields null for every text → nothing persists → the
        // pump sees the same missing ids twice and retires the scope as stalled.
        _setTestProviderFactoryForProject(
            (config) =>
                new (class extends FakeEmbeddingProvider {
                    override async embedBatch(texts: string[]): Promise<Float32Array[]> {
                        return texts.map(() => null as unknown as Float32Array);
                    }
                })(config.provider === "local" ? config.model : "shadow"),
        );
        const db = useTempDb();
        const projectIdentity = "git:stop-stalled";
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/stop-stalled",
        );
        for (let i = 0; i < 3; i++) {
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "CONSTRAINTS",
                content: `stalled memory ${i}`,
            });
            saveEmbedding(db, memory.id, new Float32Array([i, 1]), currentModelId(projectIdentity));
        }

        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            {
                provider: "synapse",
                model: "synapse-model",
                synapse_fingerprint: "fp-stalled",
            } as unknown as EmbeddingConfig,
            "/tmp/stop-stalled",
        );
        await flushShadowEmbeddingBacklog(projectIdentity);

        expect(getShadowBackfillStopReason(projectIdentity, "memory")).toBe("stalled_no_progress");
    });

    it("re-arms a stalled shadow backfill only for an explicit manual run after recovery", async () => {
        let now = Date.now();
        _setShadowBackfillNowForTests(() => now);
        let providerRecovered = false;
        _setTestProviderFactoryForProject((config) => {
            if (config.provider === "local") return new FakeEmbeddingProvider(config.model);
            return new (class extends FakeEmbeddingProvider {
                override async embedBatch(texts: string[]): Promise<Float32Array[]> {
                    return providerRecovered
                        ? super.embedBatch(texts)
                        : texts.map(() => null as unknown as Float32Array);
                }
            })("shadow");
        });
        const db = useTempDb();
        const projectIdentity = "git:shadow-rearm";
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/shadow-rearm",
        );
        for (let i = 0; i < 3; i++) {
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "CONSTRAINTS",
                content: `recoverable shadow memory ${i}`,
            });
            saveEmbedding(db, memory.id, new Float32Array([i, 1]), currentModelId(projectIdentity));
        }
        const shadowConfig = {
            provider: "synapse",
            model: "synapse-model",
            synapse_fingerprint: "fp-rearm",
        } as unknown as EmbeddingConfig;
        const first = registerProjectShadowEmbedding(
            db,
            projectIdentity,
            shadowConfig,
            "/tmp/shadow-rearm",
        );
        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(getShadowBackfillStopReason(projectIdentity, "memory")).toBe("stalled_no_progress");

        providerRecovered = true;
        const repeated = registerProjectShadowEmbedding(
            db,
            projectIdentity,
            shadowConfig,
            "/tmp/shadow-rearm",
        );
        expect(repeated?.generation).toBe(first?.generation);
        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(getShadowBackfillStopReason(projectIdentity, "memory")).toBe("stalled_no_progress");
        expect(loadAllEmbeddings(db, projectIdentity, repeated!.modelId).size).toBe(0);

        now += 60 * 60 * 1000 + 1;
        registerProjectShadowEmbedding(db, projectIdentity, shadowConfig, "/tmp/shadow-rearm", {
            manualBackfill: true,
        });
        await flushShadowEmbeddingBacklog(projectIdentity);
        expect(getShadowBackfillStopReason(projectIdentity, "memory")).toBe("drained");
        expect(loadAllEmbeddings(db, projectIdentity, repeated!.modelId).size).toBe(3);
    });

    it("discards shadow vectors when the registration is retired while the provider call is in flight", async () => {
        const db = useTempDb();
        const projectIdentity = "git:shadow-retired-in-flight";
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/shadow-retired-in-flight",
        );
        for (let i = 0; i < 3; i++) {
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "CONSTRAINTS",
                content: `retired shadow memory ${i}`,
            });
            saveEmbedding(db, memory.id, new Float32Array([i, 1]), currentModelId(projectIdentity));
        }
        const shadowConfig = {
            provider: "synapse",
            model: "synapse-model",
            synapse_fingerprint: "fp-retired-in-flight",
        } as unknown as EmbeddingConfig;
        let returnedShadowVectors = 0;
        // Retire the shadow from inside the provider call. processShadowQueueItem
        // captures the registration before awaiting, so this reproduces the
        // unregister-during-embed window: without a post-await re-check the
        // returned vectors are written under a registration that no longer exists.
        _setTestProviderFactoryForProject(
            () =>
                new (class extends FakeEmbeddingProvider {
                    override async embedBatch(texts: string[]): Promise<Float32Array[]> {
                        unregisterProjectShadowEmbedding(projectIdentity);
                        const vectors = texts.map(
                            (text) => new Float32Array([text.length, this.modelId.length]),
                        );
                        returnedShadowVectors += vectors.length;
                        return vectors;
                    }
                })("shadow"),
        );
        const registration = registerProjectShadowEmbedding(
            db,
            projectIdentity,
            shadowConfig,
            "/tmp/shadow-retired-in-flight",
        );
        await flushShadowEmbeddingBacklog(projectIdentity);

        expect(returnedShadowVectors).toBeGreaterThan(0);
        expect(loadAllEmbeddings(db, projectIdentity, registration!.modelId).size).toBe(0);
    });

    it("discards commit shadow vectors when the registration is retired during the embed call", async () => {
        const db = useTempDb();
        const projectIdentity = "git:shadow-retired-commit-in-flight";
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: false, gitCommitEnabled: true },
            "/tmp/shadow-retired-commit-in-flight",
        );
        const commits = ["c-a", "c-b", "c-c"].map((seed) => makeGitCommit(seed, 1000));
        upsertCommits(db, projectIdentity, commits);
        const primaryModelId = currentModelId(projectIdentity);
        for (const commit of commits) {
            saveCommitEmbedding(db, commit.sha, new Float32Array([1, 1]), primaryModelId);
        }
        let returnedShadowVectors = 0;
        _setTestProviderFactoryForProject(
            () =>
                new (class extends FakeEmbeddingProvider {
                    override async embedBatch(texts: string[]): Promise<Float32Array[]> {
                        unregisterProjectShadowEmbedding(projectIdentity);
                        const vectors = texts.map(
                            (text) => new Float32Array([text.length, this.modelId.length]),
                        );
                        returnedShadowVectors += vectors.length;
                        return vectors;
                    }
                })("shadow"),
        );
        const registration = registerProjectShadowEmbedding(
            db,
            projectIdentity,
            {
                provider: "synapse",
                model: "synapse-model",
                synapse_fingerprint: "fp-retired-commit",
            } as unknown as EmbeddingConfig,
            "/tmp/shadow-retired-commit-in-flight",
        );
        await flushShadowEmbeddingBacklog(projectIdentity);

        expect(returnedShadowVectors).toBeGreaterThan(0);
        expect(countEmbeddedCommits(db, projectIdentity, registration!.modelId)).toBe(0);
    });

    it("discards chunk shadow vectors when the registration is retired during the embed call", async () => {
        const db = useTempDb();
        const projectIdentity = "git:shadow-retired-chunk-in-flight";
        const sessionId = "ses-shadow-retired-chunk-in-flight";
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary", 512),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/shadow-retired-chunk-in-flight",
        );
        recordSessionProjectIdentity(db, sessionId, projectIdentity);
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 1,
                startMessageId: "a1",
                endMessageId: "a1",
                title: "Retired chunk",
                content: "large transcript",
                p1: "large transcript",
            },
        ]);
        const content = Array.from({ length: 2_000 }, (_, index) => `token-${index}`).join(" ");
        const ftsRow = db
            .prepare(
                "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, 1, 'a1', 'assistant', ?)",
            )
            .run(sessionId, content) as { lastInsertRowid: number | bigint };
        recordMessageFtsRowid(db, sessionId, 1, ftsRow.lastInsertRowid);
        let returnedShadowVectors = 0;
        _setTestProviderFactoryForProject((config) =>
            config.provider === "synapse"
                ? // Only the shadow lane retires itself mid-embed; the primary lane
                  // must embed normally so the shadow has a row to mirror.
                  new (class extends FakeEmbeddingProvider {
                      override async embedBatch(texts: string[]): Promise<Float32Array[]> {
                          unregisterProjectShadowEmbedding(projectIdentity);
                          const vectors = texts.map(
                              (text) => new Float32Array([text.length, this.modelId.length]),
                          );
                          returnedShadowVectors += vectors.length;
                          return vectors;
                      }
                  })(config.model)
                : new FakeEmbeddingProvider(config.model),
        );
        // Seed the primary chunk lane so the shadow lane has a row to mirror.
        expect(await embedUnembeddedCompartmentChunksForProject(db, projectIdentity, 8)).toBe(1);

        const registration = registerProjectShadowEmbedding(
            db,
            projectIdentity,
            {
                provider: "synapse",
                model: "synapse-model",
                synapse_fingerprint: "fp-retired-chunk",
            } as unknown as EmbeddingConfig,
            "/tmp/shadow-retired-chunk-in-flight",
        );
        // Positive control: the fixture must produce a chunk candidate, otherwise
        // "no rows written" would hold for the wrong reason.
        expect(getShadowBackfillRemaining(db, projectIdentity).chunk).toBe(1);

        await flushShadowEmbeddingBacklog(projectIdentity);

        expect(returnedShadowVectors).toBeGreaterThan(0);
        expect(
            countRows(
                db,
                "SELECT COUNT(*) AS count FROM compartment_chunk_embeddings WHERE model_id = ?",
                registration!.chunkModelId,
            ),
        ).toBe(0);
    });

    it("assigns a fresh generation when the same shadow identity is retired and re-armed", () => {
        const db = useTempDb();
        const projectIdentity = "git:shadow-same-identity-rearm";
        _setTestProviderFactoryForProject(() => new FakeEmbeddingProvider("test"));
        registerProjectEmbedding(
            db,
            projectIdentity,
            localConfig("model-primary"),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/shadow-same-identity-rearm",
        );
        const shadowConfig = {
            provider: "synapse",
            model: "synapse-model",
            synapse_fingerprint: "fp-same-identity-rearm",
        } as unknown as EmbeddingConfig;
        const first = registerProjectShadowEmbedding(
            db,
            projectIdentity,
            shadowConfig,
            "/tmp/shadow-same-identity-rearm",
        );

        unregisterProjectShadowEmbedding(projectIdentity);
        const rearmed = registerProjectShadowEmbedding(
            db,
            projectIdentity,
            shadowConfig,
            "/tmp/shadow-same-identity-rearm",
        );

        expect(first).not.toBeNull();
        expect(rearmed).not.toBeNull();
        expect(rearmed!.generation).toBeGreaterThan(first!.generation);
    });

    it("does not dispose a shadow provider that is the same instance as the primary", async () => {
        const shared = new FakeEmbeddingProvider("shared");
        _setTestProviderFactoryForProject(() => shared);
        const db = useTempDb();
        const projectIdentity = "git:shared-shadow-provider";
        const shadowConfig = {
            provider: "synapse",
            model: "synapse-model",
            synapse_fingerprint: "fp-shared",
        } as unknown as EmbeddingConfig;
        registerProjectEmbedding(
            db,
            projectIdentity,
            shadowConfig,
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/shared-shadow-provider",
        );
        // Primary constructs lazily; embed once so both lanes hold `shared`.
        await embedTextForProject(projectIdentity, "prime the shared instance");
        registerProjectShadowEmbedding(
            db,
            projectIdentity,
            shadowConfig,
            "/tmp/shared-shadow-provider",
        );
        expect(getShadowEmbeddingMeasurementCohort(projectIdentity)?.fingerprint).toBe("fp-shared");

        unregisterProjectShadowEmbedding(projectIdentity);

        expect(shared.disposed).toBe(false);
        expect(getShadowEmbeddingMeasurementCohort(projectIdentity)).toBeNull();
        expect(getProjectEmbeddingSnapshot(projectIdentity)?.provider).toBe("synapse");
    });
});
