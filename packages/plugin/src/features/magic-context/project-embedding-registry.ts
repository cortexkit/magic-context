import { createHash } from "node:crypto";

import type { EmbeddingConfig } from "../../config/schema/magic-context";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../config/schema/magic-context";
import { log } from "../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import {
    clearProjectCommitEmbeddings,
    getDistinctCommitEmbeddingModelIds,
    loadUnembeddedCommits,
    saveCommitEmbedding,
} from "./git-commits/storage-git-commit-embeddings";
import { invalidateProject } from "./memory/embedding-cache";
import { getEmbeddingProviderIdentity } from "./memory/embedding-identity";
import { LocalEmbeddingProvider } from "./memory/embedding-local";
import { OpenAICompatibleEmbeddingProvider } from "./memory/embedding-openai";
import type { EmbeddingProvider } from "./memory/embedding-provider";
import {
    clearEmbeddingsForProject,
    getDistinctStoredModelIds,
    saveEmbedding,
} from "./memory/storage-memory-embeddings";

const OFF_PROVIDER_IDENTITY = "embedding-provider:off";
const SWEEP_MAX_WALL_CLOCK_MS = 10 * 60 * 1000;
const SWEEP_MAX_CONSECUTIVE_EMPTY = 3;

export interface EmbeddingFeatures {
    memoryEnabled: boolean;
    gitCommitEnabled: boolean;
}

export interface ProjectEmbeddingRegistrationSnapshot {
    projectIdentity: string;
    sourceDirectory: string;
    providerIdentity: string;
    runtimeFingerprint: string;
    generation: number;
    features: EmbeddingFeatures;
    enabled: boolean;
    gitCommitEnabled: boolean;
    modelId: string;
}

interface ProjectEmbeddingRegistration {
    projectIdentity: string;
    sourceDirectory: string;
    config: EmbeddingConfig;
    providerIdentity: string;
    runtimeFingerprint: string;
    provider: EmbeddingProvider | null;
    generation: number;
    features: EmbeddingFeatures;
    modelId: string;
    observationMode: boolean;
}

interface UnembeddedMemoryRow {
    id: number;
    content: string;
}

const projectRegistrations = new Map<string, ProjectEmbeddingRegistration>();
const loadUnembeddedMemoriesStatements = new WeakMap<Database, PreparedStatement>();
let globalRegistrationGeneration = 0;
let projectSweepInProgress = false;
let testProviderFactory: ((config: EmbeddingConfig) => EmbeddingProvider | null) | null = null;

function resolveEmbeddingConfig(config?: EmbeddingConfig): EmbeddingConfig {
    if (!config || config.provider === "local") {
        return {
            provider: "local",
            model: config?.model?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL,
        };
    }

    if (config.provider === "openai-compatible") {
        const apiKey = config.api_key?.trim();
        return {
            provider: "openai-compatible",
            model: config.model.trim(),
            endpoint: config.endpoint.trim(),
            ...(apiKey ? { api_key: apiKey } : {}),
        };
    }

    return { provider: "off" };
}

function createProvider(config: EmbeddingConfig): EmbeddingProvider | null {
    if (testProviderFactory) {
        return testProviderFactory(config);
    }

    if (config.provider === "off") {
        return null;
    }

    if (config.provider === "openai-compatible") {
        return new OpenAICompatibleEmbeddingProvider({
            endpoint: config.endpoint,
            model: config.model,
            apiKey: config.api_key,
        });
    }

    return new LocalEmbeddingProvider(config.model);
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
    }
    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
        );
        return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function sha256Prefix(value: string, length = 16): string {
    return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function getRuntimeFingerprint(config: EmbeddingConfig): string {
    if (config.provider === "off") {
        return OFF_PROVIDER_IDENTITY;
    }
    return `${getEmbeddingProviderIdentity(config)}:${sha256Prefix(stableStringify(config))}`;
}

function sameFeatures(a: EmbeddingFeatures, b: EmbeddingFeatures): boolean {
    return a.memoryEnabled === b.memoryEnabled && a.gitCommitEnabled === b.gitCommitEnabled;
}

function snapshotFor(
    registration: ProjectEmbeddingRegistration,
): ProjectEmbeddingRegistrationSnapshot {
    const providerIsOn = registration.providerIdentity !== OFF_PROVIDER_IDENTITY;
    const enabled =
        !registration.observationMode && providerIsOn && registration.features.memoryEnabled;
    const gitCommitEnabled =
        !registration.observationMode && providerIsOn && registration.features.gitCommitEnabled;
    return {
        projectIdentity: registration.projectIdentity,
        sourceDirectory: registration.sourceDirectory,
        providerIdentity: registration.providerIdentity,
        runtimeFingerprint: registration.runtimeFingerprint,
        generation: registration.generation,
        features: { ...registration.features },
        enabled,
        gitCommitEnabled,
        modelId: registration.observationMode || !providerIsOn ? "off" : registration.modelId,
    };
}

function disposeProvider(provider: EmbeddingProvider | null): void {
    if (!provider) return;
    void provider.dispose().catch((error) => {
        log("[magic-context] embedding provider dispose failed:", error);
    });
}

function anyStoredModelIdIsStale(storedIds: Set<string | null>, currentId: string): boolean {
    if (storedIds.size === 0) return false;
    for (const id of storedIds) {
        if (id === null || id !== currentId) {
            return true;
        }
    }
    return false;
}

function maybeWipeStaleEmbeddings(
    db: Database,
    projectIdentity: string,
    currentProviderIdentity: string,
    features: EmbeddingFeatures,
): boolean {
    if (currentProviderIdentity === OFF_PROVIDER_IDENTITY) {
        return false;
    }

    let wiped = false;
    db.transaction(() => {
        if (features.memoryEnabled) {
            const memoryIds = getDistinctStoredModelIds(db, projectIdentity);
            if (anyStoredModelIdIsStale(memoryIds, currentProviderIdentity)) {
                clearEmbeddingsForProject(db, projectIdentity);
                invalidateProject(projectIdentity);
                wiped = true;
            }
        }

        if (features.gitCommitEnabled) {
            const commitIds = getDistinctCommitEmbeddingModelIds(db, projectIdentity);
            if (anyStoredModelIdIsStale(commitIds, currentProviderIdentity)) {
                clearProjectCommitEmbeddings(db, projectIdentity);
                wiped = true;
            }
        }
    })();

    return wiped;
}

export function registerProjectEmbeddingAndMaybeWipe(
    db: Database,
    projectIdentity: string,
    config: EmbeddingConfig,
    features: EmbeddingFeatures,
    sourceDirectory: string,
): ProjectEmbeddingRegistrationSnapshot {
    const resolvedConfig = resolveEmbeddingConfig(config);
    const providerIdentity = getEmbeddingProviderIdentity(resolvedConfig);
    const runtimeFingerprint = getRuntimeFingerprint(resolvedConfig);
    const prior = projectRegistrations.get(projectIdentity);
    const canReuseProvider =
        prior !== undefined &&
        !prior.observationMode &&
        prior.runtimeFingerprint === runtimeFingerprint &&
        prior.providerIdentity === providerIdentity;
    const wiped = maybeWipeStaleEmbeddings(db, projectIdentity, providerIdentity, features);
    const generationChanged =
        prior === undefined ||
        prior.observationMode ||
        prior.runtimeFingerprint !== runtimeFingerprint ||
        !sameFeatures(prior.features, features) ||
        wiped;
    const generation = generationChanged ? ++globalRegistrationGeneration : prior.generation;
    const registration: ProjectEmbeddingRegistration = {
        projectIdentity,
        sourceDirectory,
        config: resolvedConfig,
        providerIdentity,
        runtimeFingerprint,
        provider: canReuseProvider ? prior.provider : null,
        generation,
        features: { ...features },
        modelId: providerIdentity === OFF_PROVIDER_IDENTITY ? "off" : providerIdentity,
        observationMode: false,
    };

    projectRegistrations.set(projectIdentity, registration);

    if (!canReuseProvider) {
        disposeProvider(prior?.provider ?? null);
    }

    return snapshotFor(registration);
}

export function registerProjectInObservationMode(
    db: Database,
    projectIdentity: string,
    sourceDirectory: string,
    failedConfig: EmbeddingConfig,
    failureSummary: string,
): ProjectEmbeddingRegistrationSnapshot {
    void db;
    const prior = projectRegistrations.get(projectIdentity);
    const runtimeFingerprint = `observation:${sha256Prefix(failureSummary)}`;
    const generation =
        prior?.runtimeFingerprint === runtimeFingerprint && prior.observationMode
            ? prior.generation
            : ++globalRegistrationGeneration;
    const registration: ProjectEmbeddingRegistration = {
        projectIdentity,
        sourceDirectory,
        config: resolveEmbeddingConfig(failedConfig),
        providerIdentity: OFF_PROVIDER_IDENTITY,
        runtimeFingerprint,
        provider: null,
        generation,
        features: { memoryEnabled: false, gitCommitEnabled: false },
        modelId: "off",
        observationMode: true,
    };

    projectRegistrations.set(projectIdentity, registration);
    disposeProvider(prior?.provider ?? null);

    return snapshotFor(registration);
}

export function unregisterProjectEmbedding(projectIdentity: string): void {
    const prior = projectRegistrations.get(projectIdentity);
    if (!prior) return;
    projectRegistrations.delete(projectIdentity);
    globalRegistrationGeneration += 1;
    disposeProvider(prior.provider);
}

export function getProjectEmbeddingSnapshot(
    projectIdentity: string,
): ProjectEmbeddingRegistrationSnapshot | null {
    const registration = projectRegistrations.get(projectIdentity);
    return registration ? snapshotFor(registration) : null;
}

function getOrCreateProjectProvider(
    registration: ProjectEmbeddingRegistration,
): EmbeddingProvider | null {
    if (registration.providerIdentity === OFF_PROVIDER_IDENTITY || registration.observationMode) {
        return null;
    }
    if (registration.provider) {
        return registration.provider;
    }
    const provider = createProvider(registration.config);
    registration.provider = provider;
    return provider;
}

export async function embedTextForProject(
    projectIdentity: string,
    text: string,
    signal?: AbortSignal,
): Promise<{ vector: Float32Array; modelId: string; generation: number } | null> {
    const registration = projectRegistrations.get(projectIdentity);
    if (!registration) return null;
    const generation = registration.generation;
    const modelId = registration.modelId;
    const provider = getOrCreateProjectProvider(registration);
    if (!provider) return null;

    const vector = await provider.embed(text, signal);
    if (!vector) return null;

    const current = projectRegistrations.get(projectIdentity);
    if (
        !current ||
        current.generation !== generation ||
        current.runtimeFingerprint !== registration.runtimeFingerprint
    ) {
        return null;
    }

    return { vector, modelId, generation };
}

export async function embedBatchForProject(
    projectIdentity: string,
    texts: string[],
    signal?: AbortSignal,
): Promise<{ vectors: (Float32Array | null)[]; modelId: string; generation: number } | null> {
    if (texts.length === 0) {
        const registration = projectRegistrations.get(projectIdentity);
        if (!registration || registration.observationMode) return null;
        return { vectors: [], modelId: registration.modelId, generation: registration.generation };
    }

    const registration = projectRegistrations.get(projectIdentity);
    if (!registration) return null;
    const generation = registration.generation;
    const modelId = registration.modelId;
    const runtimeFingerprint = registration.runtimeFingerprint;
    const provider = getOrCreateProjectProvider(registration);
    if (!provider) return null;

    const vectors = await provider.embedBatch(texts, signal);
    const current = projectRegistrations.get(projectIdentity);
    if (
        !current ||
        current.generation !== generation ||
        current.runtimeFingerprint !== runtimeFingerprint
    ) {
        return null;
    }

    return { vectors, modelId, generation };
}

function isUnembeddedMemoryRow(row: unknown): row is UnembeddedMemoryRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return typeof candidate.id === "number" && typeof candidate.content === "string";
}

function getLoadUnembeddedMemoriesStatement(db: Database): PreparedStatement {
    let stmt = loadUnembeddedMemoriesStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT m.id AS id, m.content AS content FROM memories m LEFT JOIN memory_embeddings me ON m.id = me.memory_id WHERE m.project_path = ? AND m.status = 'active' AND me.memory_id IS NULL LIMIT ?",
        );
        loadUnembeddedMemoriesStatements.set(db, stmt);
    }
    return stmt;
}

export async function embedUnembeddedMemoriesForProject(
    db: Database,
    projectIdentity: string,
    batchSize = 10,
): Promise<number> {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.enabled) return 0;

    const normalizedBatchSize = Math.max(1, Math.floor(batchSize));
    const memories = getLoadUnembeddedMemoriesStatement(db)
        .all(projectIdentity, normalizedBatchSize)
        .filter(isUnembeddedMemoryRow);
    if (memories.length === 0) return 0;

    try {
        const result = await embedBatchForProject(
            projectIdentity,
            memories.map((memory) => memory.content),
        );
        if (!result) return 0;

        let embeddedCount = 0;
        db.transaction(() => {
            for (const [index, memory] of memories.entries()) {
                const embedding = result.vectors[index];
                if (!embedding) continue;
                saveEmbedding(db, memory.id, embedding, result.modelId);
                embeddedCount += 1;
            }
        })();
        return embeddedCount;
    } catch (error) {
        log("[magic-context] failed to proactively embed missing memories:", error);
        return 0;
    }
}

async function embedUnembeddedCommitsForProject(
    db: Database,
    projectIdentity: string,
    batchSize: number,
): Promise<number> {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.gitCommitEnabled) return 0;

    const commits = loadUnembeddedCommits(db, projectIdentity, Math.max(1, Math.floor(batchSize)));
    if (commits.length === 0) return 0;

    const result = await embedBatchForProject(
        projectIdentity,
        commits.map((commit) => commit.message),
    );
    if (!result) return 0;

    let embeddedCount = 0;
    db.transaction(() => {
        for (const [index, commit] of commits.entries()) {
            const embedding = result.vectors[index];
            if (!embedding) continue;
            saveCommitEmbedding(db, commit.sha, embedding, result.modelId);
            embeddedCount += 1;
        }
    })();
    return embeddedCount;
}

export async function sweepAllRegisteredProjects(
    db: Database,
    batchSize = 10,
): Promise<{
    memoriesEmbedded: number;
    commitsEmbedded: number;
    perProject: Map<string, { memories: number; commits: number }>;
}> {
    if (projectSweepInProgress) {
        log("[magic-context] project embedding sweep already in progress, skipping this tick");
        return { memoriesEmbedded: 0, commitsEmbedded: 0, perProject: new Map() };
    }

    projectSweepInProgress = true;
    const startedAt = Date.now();
    const deadline = startedAt + SWEEP_MAX_WALL_CLOCK_MS;
    const perProject = new Map<string, { memories: number; commits: number }>();
    let memoriesEmbedded = 0;
    let commitsEmbedded = 0;

    try {
        for (const projectIdentity of projectRegistrations.keys()) {
            let memories = 0;
            let commits = 0;
            let consecutiveEmpty = 0;

            while (Date.now() < deadline) {
                const count = await embedUnembeddedMemoriesForProject(
                    db,
                    projectIdentity,
                    batchSize,
                );
                if (count === 0) {
                    consecutiveEmpty += 1;
                    if (consecutiveEmpty >= SWEEP_MAX_CONSECUTIVE_EMPTY) break;
                    break;
                }
                consecutiveEmpty = 0;
                memories += count;
                memoriesEmbedded += count;
                if (count < batchSize) break;
            }

            if (Date.now() < deadline) {
                commits = await embedUnembeddedCommitsForProject(db, projectIdentity, batchSize);
                commitsEmbedded += commits;
            }

            perProject.set(projectIdentity, { memories, commits });
            if (Date.now() >= deadline) break;
        }
    } finally {
        projectSweepInProgress = false;
    }

    return { memoriesEmbedded, commitsEmbedded, perProject };
}

export function _setTestProviderFactoryForProject(
    factory: ((config: EmbeddingConfig) => EmbeddingProvider | null) | null,
): void {
    testProviderFactory = factory;
}

export function _resetProjectEmbeddingRegistryForTests(): void {
    for (const registration of projectRegistrations.values()) {
        disposeProvider(registration.provider);
    }
    projectRegistrations.clear();
    globalRegistrationGeneration = 0;
    projectSweepInProgress = false;
    testProviderFactory = null;
}
