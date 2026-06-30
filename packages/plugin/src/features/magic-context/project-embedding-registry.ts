import { createHash, randomUUID } from "node:crypto";

import type { EmbeddingConfig } from "../../config/schema/magic-context";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../config/schema/magic-context";
import { log } from "../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import {
    buildCanonicalChunkTextFromFts,
    buildCompartmentSummaryFallbackText,
    type CompartmentChunkBackfillCandidate,
    chunkCanonicalText,
    chunkEmbeddingWindowsAreCurrent,
    clearChunkEmbeddingsForProject,
    countSessionCompartmentEmbedCoverage,
    countUnembeddedSessionCompartments,
    loadUnembeddedCompartmentChunkCandidates,
    loadUnembeddedSessionChunkCandidates,
    normalizeCompartmentChunkMaxInputTokens,
    replaceCompartmentChunkEmbeddings,
    type SaveCompartmentChunkEmbeddingInput,
} from "./compartment-chunk-embedding";
import {
    clearProjectCommitEmbeddings,
    countEmbeddedCommits,
    loadUnembeddedCommits,
    saveCommitEmbedding,
} from "./git-commits/storage-git-commit-embeddings";
import { getCommitCount } from "./git-commits/storage-git-commits";
import {
    acquireGitSweepLease,
    releaseGitSweepLease,
    renewGitSweepLease,
} from "./git-commits/sweep-coordinator";
import { invalidateProject } from "./memory/embedding-cache";
import { getEmbeddingProviderIdentity } from "./memory/embedding-identity";
import { LocalEmbeddingProvider } from "./memory/embedding-local";
import { OpenAICompatibleEmbeddingProvider } from "./memory/embedding-openai";
import type { EmbeddingProvider, EmbeddingPurpose } from "./memory/embedding-provider";
import {
    clearEmbeddingsForProject,
    getMemoryEmbedCoverage,
    saveEmbedding,
} from "./memory/storage-memory-embeddings";
import {
    recordSessionProjectIdentity,
    repairMisScopedCompartmentChunkEmbeddingsForProject,
} from "./session-project-storage";

const OFF_PROVIDER_IDENTITY = "embedding-provider:off";
const SWEEP_MAX_WALL_CLOCK_MS = 10 * 60 * 1000;
const SWEEP_MAX_CONSECUTIVE_EMPTY = 3;
// Backlog-drain caps for the commit-embedding path. The drain loops within one
// held coordinator lease so a large backlog (e.g. a 2000-commit repo that was
// indexed before embeddings were enabled) clears in a few ticks instead of
// crawling one batch per tick. Bounded per sweep so one project can't starve
// the others or pin the provider indefinitely.
const COMMIT_DRAIN_BATCH_SIZE = 16;
const COMMIT_DRAIN_MAX_PER_SWEEP = 500;
const CHUNK_DRAIN_BATCH_SIZE = 8;
const CHUNK_DRAIN_MAX_PER_SWEEP = 200;
const EMBEDDING_IDENTITY_GC_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
// Hard cap on embedding-window texts sent in ONE provider call. Deliberately
// SMALL: a local embedding endpoint (LMStudio/Ollama) runs one forward pass per
// input, so batching many max_input_tokens-sized windows into a single request
// makes that request too slow to finish inside the HTTP timeout (the dominant
// failure was 16 windows/call timing out at 30s on a local 4B model) — or large
// enough to 400. With each window already ≤ max_input_tokens, capping windows
// per call also caps tokens per call, so a small value keeps every request fast.
// More round-trips, but each completes; far better than oversized calls that
// time out and stall the drain. Compartments are never split across calls; a
// compartment with more windows than this still embeds as its own over-cap call.
const MAX_WINDOWS_PER_EMBED_CALL = 2;
// Session backfill (/ctx-embed) holds the coordinator lease for an unbounded
// run, so it must renew before the TTL lapses (mirrors the git sweep).
const SESSION_EMBED_LEASE_RENEWAL_MS = 60 * 1000;
// Resilience for the session drain. The provider NEVER throws (it returns null /
// all-null vectors and owns its own HTTP circuit breaker), so "retry" here is the
// drain's stop policy, not HTTP retry:
//   - EMBED_SLICE_RETRY_*: re-attempt a single provider call a few times with
//     backoff when it comes back with no usable vectors (a transient blip before
//     the provider's own breaker trips). Cheap insurance for same-run completion.
//   - MAX_CONSECUTIVE_FAILED_BATCHES: a compartment that still won't embed after
//     retries is recorded as failed, EXCLUDED so the oldest-first cursor advances
//     past it (retried on a future run, not persisted as permanent skip), and the
//     drain CONTINUES. Only after this many consecutive all-failed batches do we
//     stop — that's a provider that's actually down, and hammering 800
//     compartments against a dead endpoint helps no one.
const EMBED_SLICE_RETRY_ATTEMPTS = 3;
const EMBED_SLICE_RETRY_BASE_MS = 250;
// If a single failed provider call took at least this long, treat it as a
// timeout (not a transient blip) and do NOT retry it — re-sending the same
// payload would just burn another full timeout. A healthy small call (≤2
// windows) returns in a few seconds, well under this.
const EMBED_SLOW_FAILURE_NO_RETRY_MS = 10_000;
const MAX_CONSECUTIVE_FAILED_BATCHES = 3;

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
    chunkModelId: string;
    /** Friendly configured model name (e.g. "text-embedding-qwen3-embedding-4b"),
     *  for user-facing status. "off" when no provider / observation mode. */
    model: string;
    /** Configured provider kind (e.g. "openai-compatible", "local", "ollama"). */
    provider: string;
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
    chunkModelId: string;
    observationMode: boolean;
}

interface UnembeddedMemoryRow {
    id: number;
    content: string;
}

type EmbeddingIdentityScope = "memory" | "commit" | "chunk";

interface StaleIdentityRow {
    modelId: string;
}

const projectRegistrations = new Map<string, ProjectEmbeddingRegistration>();
const loadUnembeddedMemoriesStatements = new WeakMap<Database, PreparedStatement>();
const upsertActiveIdentityStatements = new WeakMap<Database, PreparedStatement>();
const backfillActiveIdentityStatements = new Map<
    EmbeddingIdentityScope,
    WeakMap<Database, PreparedStatement>
>();
const staleIdentityStatements = new Map<
    EmbeddingIdentityScope,
    WeakMap<Database, PreparedStatement>
>();
const deleteActiveIdentityStatements = new WeakMap<Database, PreparedStatement>();
let globalRegistrationGeneration = 0;

/**
 * Projects whose most-recent config load was untrusted (parse/IO error, legacy
 * config unmigrated, or an embedding-affecting substitution/recovery failure).
 * While a project is latched here we keep serving its last-known-good provider
 * for reads/writes but SUPPRESS the destructive stale-identity GC — a degraded
 * load must never delete embedding rows off a config we don't trust. The latch
 * clears the next time a trusted config successfully registers the project.
 */
const untrustedLoadProjects = new Set<string>();

/** Latch a project as currently loaded from an untrusted config (suppresses GC). */
export function markProjectLoadUntrusted(projectIdentity: string): void {
    untrustedLoadProjects.add(projectIdentity);
}
let projectSweepInProgress = false;
let testProviderFactory: ((config: EmbeddingConfig) => EmbeddingProvider | null) | null = null;

function resolveEmbeddingConfig(config?: EmbeddingConfig): EmbeddingConfig {
    if (!config || config.provider === "local") {
        return {
            provider: "local",
            model: config?.model?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL,
            ...(config?.max_input_tokens
                ? {
                      max_input_tokens: normalizeCompartmentChunkMaxInputTokens(
                          config.max_input_tokens,
                      ),
                  }
                : {}),
        };
    }

    if (config.provider === "openai-compatible") {
        const apiKey = config.api_key?.trim();
        const inputType = config.input_type?.trim();
        const queryInputType = config.query_input_type?.trim();
        const truncate = config.truncate?.trim();
        return {
            provider: "openai-compatible",
            model: config.model.trim(),
            endpoint: config.endpoint.trim(),
            ...(apiKey ? { api_key: apiKey } : {}),
            // Preserve provider-specific request fields (NVIDIA NIM input_type;
            // truncate). They must survive normalization so (a) they reach the
            // provider request body and (b) a change to either is part of the
            // config identity hash → a real config change correctly wipes stale
            // vectors. query_input_type shapes per-call requests only and is
            // intentionally omitted from identity (stored vectors use passage).
            ...(inputType ? { input_type: inputType } : {}),
            ...(queryInputType ? { query_input_type: queryInputType } : {}),
            ...(truncate ? { truncate } : {}),
            ...(config.max_input_tokens
                ? {
                      max_input_tokens: normalizeCompartmentChunkMaxInputTokens(
                          config.max_input_tokens,
                      ),
                  }
                : {}),
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
            inputType: config.input_type,
            queryInputType: config.query_input_type,
            truncate: config.truncate,
            maxInputTokens: config.max_input_tokens,
        });
    }

    return new LocalEmbeddingProvider(config.model, config.max_input_tokens);
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

function getChunkEmbeddingModelId(config: EmbeddingConfig, providerIdentity: string): string {
    if (config.provider === "off") {
        return OFF_PROVIDER_IDENTITY;
    }
    // Chunk vectors depend on the provider vector space AND the exact windowing
    // contract used to derive chunk text. Memory/commit vectors intentionally use
    // only providerIdentity so a chunk-window change does not wipe unrelated stores.
    const chunkIdentity = {
        providerIdentity,
        // v2: windowing targets CHUNK_WINDOW_SAFETY_RATIO * max_input_tokens
        // instead of the raw ceiling, so boundaries shifted — bump to re-embed.
        chunkerVersion: 2,
        maxInputTokens: normalizeCompartmentChunkMaxInputTokens(
            "max_input_tokens" in config ? config.max_input_tokens : undefined,
        ),
        truncate: config.provider === "openai-compatible" ? (config.truncate ?? "") : "",
    };
    return `${providerIdentity}:chunk:${sha256Prefix(stableStringify(chunkIdentity))}`;
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
        chunkModelId:
            registration.observationMode || !providerIsOn ? "off" : registration.chunkModelId,
        model:
            registration.observationMode || !providerIsOn
                ? "off"
                : "model" in registration.config && registration.config.model.trim()
                  ? registration.config.model.trim()
                  : registration.modelId,
        provider:
            registration.observationMode || !providerIsOn
                ? "off"
                : (registration.config.provider ?? "local"),
    };
}

function disposeProvider(provider: EmbeddingProvider | null): void {
    if (!provider) return;
    void provider.dispose().catch((error) => {
        log("[magic-context] embedding provider dispose failed:", error);
    });
}

function getUpsertActiveIdentityStatement(db: Database): PreparedStatement {
    let stmt = upsertActiveIdentityStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `INSERT INTO embedding_identity_active (project_path, scope, model_id, last_active_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(project_path, scope, model_id) DO UPDATE SET
                 last_active_at = excluded.last_active_at`,
        );
        upsertActiveIdentityStatements.set(db, stmt);
    }
    return stmt;
}

function statementMapFor<T extends string>(
    maps: Map<T, WeakMap<Database, PreparedStatement>>,
    key: T,
): WeakMap<Database, PreparedStatement> {
    let map = maps.get(key);
    if (!map) {
        map = new WeakMap<Database, PreparedStatement>();
        maps.set(key, map);
    }
    return map;
}

function getBackfillActiveIdentityStatement(
    db: Database,
    scope: EmbeddingIdentityScope,
): PreparedStatement {
    const map = statementMapFor(backfillActiveIdentityStatements, scope);
    let stmt = map.get(db);
    if (!stmt) {
        const selectByScope: Record<EmbeddingIdentityScope, string> = {
            memory: `SELECT DISTINCT e.model_id AS model_id
                     FROM memory_embeddings e
                     JOIN memories m ON m.id = e.memory_id
                     WHERE m.project_path = ?`,
            commit: `SELECT DISTINCT e.model_id AS model_id
                     FROM git_commit_embeddings e
                     JOIN git_commits c ON c.sha = e.sha
                     WHERE c.project_path = ?`,
            chunk: `SELECT DISTINCT e.model_id AS model_id
                    FROM compartment_chunk_embeddings e
                    WHERE e.project_path = ?`,
        };
        stmt = db.prepare(
            `INSERT OR IGNORE INTO embedding_identity_active (project_path, scope, model_id, last_active_at)
             SELECT ?, ?, model_id, ?
             FROM (${selectByScope[scope]})
             WHERE model_id IS NOT NULL`,
        );
        map.set(db, stmt);
    }
    return stmt;
}

function recordScopeActiveIdentity(
    db: Database,
    projectIdentity: string,
    scope: EmbeddingIdentityScope,
    modelId: string,
    now: number,
): void {
    getUpsertActiveIdentityStatement(db).run(projectIdentity, scope, modelId, now);
    getBackfillActiveIdentityStatement(db, scope).run(projectIdentity, scope, now, projectIdentity);
}

function recordActiveEmbeddingIdentity(
    db: Database,
    projectIdentity: string,
    currentProviderIdentity: string,
    currentChunkIdentity: string,
    features: EmbeddingFeatures,
): void {
    if (currentProviderIdentity === OFF_PROVIDER_IDENTITY) {
        return;
    }

    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
        if (features.memoryEnabled) {
            recordScopeActiveIdentity(db, projectIdentity, "memory", currentProviderIdentity, now);
        }

        if (features.gitCommitEnabled) {
            recordScopeActiveIdentity(db, projectIdentity, "commit", currentProviderIdentity, now);
        }

        if (features.memoryEnabled) {
            repairMisScopedCompartmentChunkEmbeddingsForProject(db, projectIdentity);
            recordScopeActiveIdentity(db, projectIdentity, "chunk", currentChunkIdentity, now);
        }
        db.exec("COMMIT");
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // The transaction may already be closed by SQLite after a fatal error.
        }
        throw error;
    }
}

function getStaleIdentityStatement(db: Database, scope: EmbeddingIdentityScope): PreparedStatement {
    const map = statementMapFor(staleIdentityStatements, scope);
    let stmt = map.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT model_id AS modelId
             FROM embedding_identity_active
             WHERE project_path = ?
               AND scope = ?
               AND model_id <> ?
               AND last_active_at < ?`,
        );
        map.set(db, stmt);
    }
    return stmt;
}

function getDeleteActiveIdentityStatement(db: Database): PreparedStatement {
    let stmt = deleteActiveIdentityStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `DELETE FROM embedding_identity_active
             WHERE project_path = ? AND scope = ? AND model_id = ?`,
        );
        deleteActiveIdentityStatements.set(db, stmt);
    }
    return stmt;
}

function staleModelsForScope(
    db: Database,
    projectIdentity: string,
    scope: EmbeddingIdentityScope,
    currentModelId: string,
    cutoff: number,
): string[] {
    const rows = getStaleIdentityStatement(db, scope).all(
        projectIdentity,
        scope,
        currentModelId,
        cutoff,
    ) as StaleIdentityRow[];
    return rows.map((row) => row.modelId).filter((modelId) => typeof modelId === "string");
}

export interface StaleEmbeddingSweepResult {
    memoryRowsDeleted: number;
    commitRowsDeleted: number;
    chunkRowsDeleted: number;
    trackingRowsDeleted: number;
}

export function sweepStaleEmbeddingIdentitiesForProject(
    db: Database,
    projectIdentity: string,
    now = Date.now(),
): StaleEmbeddingSweepResult {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    const result: StaleEmbeddingSweepResult = {
        memoryRowsDeleted: 0,
        commitRowsDeleted: 0,
        chunkRowsDeleted: 0,
        trackingRowsDeleted: 0,
    };
    if (!snapshot) return result;

    // A degraded/untrusted config load must never drive deletion: the snapshot
    // we'd GC against may be last-known-good while the on-disk config is broken
    // or mid-migration. Reads keep serving the cached vectors; GC waits until a
    // trusted register clears the latch.
    if (untrustedLoadProjects.has(projectIdentity)) return result;

    const cutoff = now - EMBEDDING_IDENTITY_GC_GRACE_MS;
    const deleteTracking = getDeleteActiveIdentityStatement(db);
    // Atomic select+delete under one write lock: registration commits the
    // current model's last_active_at inside BEGIN IMMEDIATE, so GC must hold the
    // same lock across its stale-select → delete window. A deferred transaction
    // could select a stale id, lose the lock to a concurrent re-registration of
    // that exact model (which refreshes last_active_at), then delete the
    // freshly-reactivated rows anyway.
    db.exec("BEGIN IMMEDIATE");
    try {
        if (snapshot.enabled && snapshot.modelId !== "off") {
            for (const modelId of staleModelsForScope(
                db,
                projectIdentity,
                "memory",
                snapshot.modelId,
                cutoff,
            )) {
                result.memoryRowsDeleted += clearEmbeddingsForProject(db, projectIdentity, modelId);
                result.trackingRowsDeleted += deleteTracking.run(
                    projectIdentity,
                    "memory",
                    modelId,
                ).changes;
            }
        }

        if (snapshot.gitCommitEnabled && snapshot.modelId !== "off") {
            for (const modelId of staleModelsForScope(
                db,
                projectIdentity,
                "commit",
                snapshot.modelId,
                cutoff,
            )) {
                result.commitRowsDeleted += clearProjectCommitEmbeddings(
                    db,
                    projectIdentity,
                    modelId,
                );
                result.trackingRowsDeleted += deleteTracking.run(
                    projectIdentity,
                    "commit",
                    modelId,
                ).changes;
            }
        }

        if (snapshot.enabled && snapshot.chunkModelId !== "off") {
            for (const modelId of staleModelsForScope(
                db,
                projectIdentity,
                "chunk",
                snapshot.chunkModelId,
                cutoff,
            )) {
                result.chunkRowsDeleted += clearChunkEmbeddingsForProject(
                    db,
                    projectIdentity,
                    modelId,
                );
                result.trackingRowsDeleted += deleteTracking.run(
                    projectIdentity,
                    "chunk",
                    modelId,
                ).changes;
            }
        }
        db.exec("COMMIT");
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // The transaction may already be closed by SQLite after a fatal error.
        }
        throw error;
    }

    if (result.memoryRowsDeleted > 0) {
        invalidateProject(projectIdentity);
    }
    return result;
}

export function registerProjectEmbedding(
    db: Database,
    projectIdentity: string,
    config: EmbeddingConfig,
    features: EmbeddingFeatures,
    sourceDirectory: string,
): ProjectEmbeddingRegistrationSnapshot {
    const resolvedConfig = resolveEmbeddingConfig(config);
    const providerIdentity = getEmbeddingProviderIdentity(resolvedConfig);
    const runtimeFingerprint = getRuntimeFingerprint(resolvedConfig);
    const chunkModelId = getChunkEmbeddingModelId(resolvedConfig, providerIdentity);
    const prior = projectRegistrations.get(projectIdentity);
    const canReuseProvider =
        prior !== undefined &&
        !prior.observationMode &&
        prior.runtimeFingerprint === runtimeFingerprint &&
        prior.providerIdentity === providerIdentity;
    recordActiveEmbeddingIdentity(db, projectIdentity, providerIdentity, chunkModelId, features);
    // A trusted registration just landed — clear any prior untrusted-load latch
    // so GC can resume for this project.
    untrustedLoadProjects.delete(projectIdentity);
    const generationChanged =
        prior === undefined ||
        prior.observationMode ||
        prior.runtimeFingerprint !== runtimeFingerprint ||
        prior.chunkModelId !== chunkModelId ||
        !sameFeatures(prior.features, features);
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
        chunkModelId: providerIdentity === OFF_PROVIDER_IDENTITY ? "off" : chunkModelId,
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
        chunkModelId: "off",
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

export function getProjectChunkEmbeddingModelId(projectIdentity: string): string {
    const registration = projectRegistrations.get(projectIdentity);
    return registration && !registration.observationMode ? registration.chunkModelId : "off";
}

export function getProjectEmbeddingMaxInputTokens(projectIdentity: string): number {
    const registration = projectRegistrations.get(projectIdentity);
    const configMax =
        registration?.config && "max_input_tokens" in registration.config
            ? registration.config.max_input_tokens
            : undefined;
    return normalizeCompartmentChunkMaxInputTokens(
        registration?.provider?.maxInputTokens ?? configMax,
    );
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
    purpose: EmbeddingPurpose = "passage",
): Promise<{ vector: Float32Array; modelId: string; generation: number } | null> {
    const registration = projectRegistrations.get(projectIdentity);
    if (!registration) return null;
    const generation = registration.generation;
    const modelId = registration.modelId;
    const provider = getOrCreateProjectProvider(registration);
    if (!provider) return null;

    const vector = await provider.embed(text, signal, purpose);
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
    purpose: EmbeddingPurpose = "passage",
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

    const vectors = await provider.embedBatch(texts, signal, purpose);
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

/**
 * Embed `texts` while keeping each provider HTTP call bounded to
 * `MAX_WINDOWS_PER_EMBED_CALL` inputs, concatenating the vectors back into one
 * array aligned 1:1 with `texts`. This holds the per-request payload bound even
 * when the caller's slice contains a single compartment whose window count
 * exceeds the cap (the candidate-batch slice builder always includes at least
 * one compartment whole). If any sub-batch fails (provider returns null), the
 * whole call returns null so the caller's existing all-or-nothing retry/failure
 * accounting is unchanged. modelId/generation come from the first sub-batch; a
 * mid-stream generation change surfaces as a null sub-batch result.
 */
async function embedTextsWindowBounded(
    projectIdentity: string,
    texts: string[],
    signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof embedBatchForProject>>> {
    if (texts.length <= MAX_WINDOWS_PER_EMBED_CALL) {
        return embedBatchForProject(projectIdentity, texts, signal);
    }
    const vectors: (Float32Array | null)[] = [];
    let modelId: string | null = null;
    let generation: number | null = null;
    for (let start = 0; start < texts.length; start += MAX_WINDOWS_PER_EMBED_CALL) {
        if (signal?.aborted) return null;
        const sub = texts.slice(start, start + MAX_WINDOWS_PER_EMBED_CALL);
        const result = await embedBatchForProject(projectIdentity, sub, signal);
        if (!result) return null;
        // Guard against a mid-stream identity change splitting vector spaces.
        if (modelId === null) {
            modelId = result.modelId;
            generation = result.generation;
        } else if (result.modelId !== modelId || result.generation !== generation) {
            return null;
        }
        vectors.push(...result.vectors);
    }
    if (modelId === null || generation === null) return null;
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
            "SELECT m.id AS id, m.content AS content FROM memories m LEFT JOIN memory_embeddings me ON m.id = me.memory_id AND me.model_id = ? WHERE m.project_path = ? AND m.status = 'active' AND me.memory_id IS NULL LIMIT ?",
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
        .all(snapshot.modelId, projectIdentity, normalizedBatchSize)
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

/** Drain a single batch of unembedded commits. Returns how many embedded. */
async function embedCommitBatch(
    db: Database,
    projectIdentity: string,
    batchSize: number,
): Promise<number> {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.gitCommitEnabled) return 0;
    const commits = loadUnembeddedCommits(
        db,
        projectIdentity,
        snapshot.modelId,
        Math.max(1, Math.floor(batchSize)),
    );
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

/**
 * Drain a project's unembedded-commit backlog, coordinated across processes.
 *
 * Drains pure backlogs (indexed commits with no embedding row). The dream-timer
 * git-sweep embeds new commits from `git log` but skips backlog drain when
 * `embedded=0`; this path runs after each sweep (ignoreCooldown lease) so
 * pre-existing backlogs clear. Every plugin process runs this
 * on its dream-timer tick, so without coordination N processes hammer the
 * embedding provider with the same commits. We take the shared git-sweep lease
 * (mutual exclusion) per identity — but with `ignoreCooldown`, because a
 * backlog must keep draining every tick until empty and must not be blocked by
 * the cooldown the dream-timer sweep advances. We release without marking
 * success so the two paths' cooldown tracking stays independent.
 */
export async function drainCommitBacklogForProject(
    db: Database,
    projectIdentity: string,
    deadline: number,
): Promise<number> {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.gitCommitEnabled) return 0;

    const holderId = `embed-sweep-${randomUUID()}`;
    const lease = acquireGitSweepLease(db, projectIdentity, holderId, { ignoreCooldown: true });
    if (!lease.acquired) {
        // Another process is sweeping/draining this identity — skip cleanly.
        return 0;
    }

    let total = 0;
    try {
        while (Date.now() < deadline && total < COMMIT_DRAIN_MAX_PER_SWEEP) {
            const embedded = await embedCommitBatch(db, projectIdentity, COMMIT_DRAIN_BATCH_SIZE);
            if (embedded === 0) break;
            total += embedded;
            if (embedded < COMMIT_DRAIN_BATCH_SIZE) break; // partial batch = drained
        }
    } finally {
        releaseGitSweepLease(db, projectIdentity, holderId);
    }
    return total;
}

async function embedCompartmentChunkBatch(
    db: Database,
    projectIdentity: string,
    batchSize: number,
): Promise<number> {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.enabled || snapshot.chunkModelId === "off") return 0;

    repairMisScopedCompartmentChunkEmbeddingsForProject(db, projectIdentity);
    const candidates = loadUnembeddedCompartmentChunkCandidates(
        db,
        projectIdentity,
        snapshot.chunkModelId,
        batchSize,
    );
    if (candidates.length === 0) return 0;
    // Passive sweep ignores `failed`/`noWork` — it's bounded per tick and re-runs
    // on the next sweep; the session drain is the path that tracks them.
    const { embedded } = await embedCandidateChunkBatch(
        db,
        projectIdentity,
        snapshot.chunkModelId,
        candidates,
    );
    return embedded;
}

interface CandidateChunkBatchResult {
    /** Compartments fully embedded + persisted this call. */
    embedded: number;
    /** Candidates that yielded NO embeddable work (empty canonical text or
     *  windows already current) — they are not failures and the session drain
     *  must skip past them rather than re-select them forever. */
    noWork: number[];
    /** Candidates the provider could not embed this call even after retries
     *  (returned no/partial vectors). NOT permanent: excluded for the rest of
     *  THIS run so the cursor advances, but re-attempted on a future run. */
    failed: number[];
}

/** Embed + persist chunk vectors for an already-selected candidate batch.
 *  Shared by the project-wide passive drain and the session-scoped on-demand
 *  backfill. Provider calls are sub-batched by window count
 *  (`MAX_WINDOWS_PER_EMBED_CALL`) so a single large compartment (or a big
 *  `batchSize`) can't build one enormous payload tensor. Each compartment is the
 *  atomic persist unit — its windows are never split across provider calls. */
async function embedCandidateChunkBatch(
    db: Database,
    projectIdentity: string,
    modelId: string,
    candidates: CompartmentChunkBackfillCandidate[],
    signal?: AbortSignal,
): Promise<CandidateChunkBatchResult> {
    const noWork: number[] = [];
    const failed: number[] = [];
    if (candidates.length === 0) return { embedded: 0, noWork, failed };
    const maxInputTokens = getProjectEmbeddingMaxInputTokens(projectIdentity);

    type Prepared = {
        candidate: CompartmentChunkBackfillCandidate;
        windows: ReturnType<typeof chunkCanonicalText>;
    };
    const prepared: Prepared[] = [];
    for (const candidate of candidates) {
        // Raw-span text first; fall back to the compartment's summary (title+p1)
        // when the span has no indexable content (notification/tool-only beat),
        // so such compartments still get a real embedding row instead of being
        // re-counted as "remaining" forever (the desktop auto-embed loop).
        const canonicalText =
            buildCanonicalChunkTextFromFts(
                db,
                candidate.sessionId,
                candidate.startMessage,
                candidate.endMessage,
            ) || buildCompartmentSummaryFallbackText(db, candidate.id);
        if (canonicalText.length === 0) {
            noWork.push(candidate.id);
            continue;
        }
        const windows = chunkCanonicalText(
            canonicalText,
            candidate.startMessage,
            candidate.endMessage,
            maxInputTokens,
        );
        if (
            windows.length === 0 ||
            chunkEmbeddingWindowsAreCurrent(db, candidate.id, modelId, windows, projectIdentity)
        ) {
            noWork.push(candidate.id);
            continue;
        }
        prepared.push({ candidate, windows });
    }

    if (prepared.length === 0) return { embedded: 0, noWork, failed };

    // Embed the prepared compartments in sub-batches bounded by window count so
    // the per-call payload (and the provider's padded tensor / JSON body) stays
    // bounded regardless of how many windows a single compartment produced.
    let embedded = 0;
    let i = 0;
    while (i < prepared.length) {
        if (signal?.aborted) break;
        const slice: Prepared[] = [];
        let windowCount = 0;
        // Always include at least one compartment, even if it alone exceeds the
        // cap (a single very large compartment must still be embeddable).
        do {
            const item = prepared[i];
            slice.push(item);
            windowCount += item.windows.length;
            i += 1;
        } while (
            i < prepared.length &&
            windowCount + prepared[i].windows.length <= MAX_WINDOWS_PER_EMBED_CALL
        );

        const texts: string[] = [];
        for (const item of slice) texts.push(...item.windows.map((w) => w.text));

        // Retry the provider call a few times with backoff. The provider returns
        // null / all-null on failure (never throws), so we can't read the failure
        // reason — but we CAN time it: a fast failure (refused connection, 400,
        // brief blip) is worth a quick retry; a SLOW failure means the request hit
        // the provider's HTTP timeout, and re-sending the identical (too-big/too-
        // slow) payload would just burn another full timeout. So retry only when
        // the prior attempt failed FAST. With MAX_WINDOWS_PER_EMBED_CALL=2 a
        // healthy call returns in ~seconds, so this threshold cleanly separates a
        // transient blip from a genuine timeout.
        // Track WHICH compartments of the slice actually persisted (not just a
        // count). A provider can return vectors for some inputs in a call but not
        // others; with a count-only check, a partial-success slice would break the
        // retry loop AND skip the failed-marking, leaving the non-persisted
        // compartment neither saved nor excluded — so it gets re-queried (and
        // re-sent) every iteration until it's the last candidate. Tracking ids
        // lets us mark every NON-persisted item as failed regardless of partial
        // success, so the cursor advances past it (retried next run).
        const persistedIds = new Set<number>();
        for (let attempt = 0; attempt < EMBED_SLICE_RETRY_ATTEMPTS; attempt++) {
            if (signal?.aborted) break;
            let result: Awaited<ReturnType<typeof embedBatchForProject>> = null;
            const attemptStart = Date.now();
            try {
                // Sub-batch the provider call by window count so the per-request
                // payload stays bounded even when a SINGLE compartment contributed
                // more than MAX_WINDOWS_PER_EMBED_CALL windows (e.g. a huge file
                // dump split into many sub-windows by chunkCanonicalText). Without
                // this, the slice builder's "always include at least one
                // compartment" rule could hand the provider one enormous text array
                // in a single HTTP call, defeating the payload bound and risking
                // provider timeouts/rejections (PR #207 review).
                result = await embedTextsWindowBounded(projectIdentity, texts, signal);
            } catch (error) {
                log("[magic-context] failed to proactively embed compartment chunks:", error);
            }
            if (signal?.aborted) break;
            if (result) {
                let offset = 0;
                for (const item of slice) {
                    const vectors = result.vectors.slice(offset, offset + item.windows.length);
                    offset += item.windows.length;
                    if (persistedIds.has(item.candidate.id)) continue; // done on a prior attempt
                    if (vectors.length !== item.windows.length || vectors.some((v) => !v)) {
                        continue;
                    }
                    const rows: SaveCompartmentChunkEmbeddingInput[] = item.windows.map(
                        (window, index) => ({
                            compartmentId: item.candidate.id,
                            sessionId: item.candidate.sessionId,
                            projectPath: projectIdentity,
                            window,
                            modelId,
                            vector: vectors[index] as Float32Array,
                        }),
                    );
                    replaceCompartmentChunkEmbeddings(db, rows);
                    persistedIds.add(item.candidate.id);
                }
            }
            if (persistedIds.size === slice.length) break; // whole slice done
            // Partial success: don't retry (would re-send the persisted items); the
            // non-persisted ones are marked failed below and retried next run.
            if (persistedIds.size > 0) break;
            // Don't retry a SLOW failure: it timed out, so the same payload will
            // just time out again. Mark failed and move on (retried next run).
            if (Date.now() - attemptStart >= EMBED_SLOW_FAILURE_NO_RETRY_MS) break;
            if (attempt < EMBED_SLICE_RETRY_ATTEMPTS - 1) {
                await new Promise((resolve) =>
                    setTimeout(resolve, EMBED_SLICE_RETRY_BASE_MS * 2 ** attempt),
                );
            }
        }

        embedded += persistedIds.size;
        // Every slice compartment that did NOT persist (full OR partial failure):
        // record as failed (not no-work) so the drain advances past it this run
        // and retries it next run, rather than re-selecting it every iteration.
        // Skip on abort — those simply didn't get their turn and re-queue naturally.
        if (!signal?.aborted) {
            for (const item of slice) {
                if (!persistedIds.has(item.candidate.id)) failed.push(item.candidate.id);
            }
        }
    }
    return { embedded, noWork, failed };
}

async function drainCompartmentChunkBacklogForProject(
    db: Database,
    projectIdentity: string,
    deadline: number,
): Promise<number> {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.enabled) return 0;

    const holderId = `chunk-embed-sweep-${randomUUID()}`;
    const lease = acquireGitSweepLease(db, projectIdentity, holderId, { ignoreCooldown: true });
    if (!lease.acquired) {
        return 0;
    }

    let total = 0;
    try {
        while (Date.now() < deadline && total < CHUNK_DRAIN_MAX_PER_SWEEP) {
            const embedded = await embedCompartmentChunkBatch(
                db,
                projectIdentity,
                CHUNK_DRAIN_BATCH_SIZE,
            );
            if (embedded === 0) break;
            total += embedded;
            if (embedded < CHUNK_DRAIN_BATCH_SIZE) break;
        }
    } finally {
        releaseGitSweepLease(db, projectIdentity, holderId);
    }
    return total;
}

export async function embedUnembeddedCompartmentChunksForProject(
    db: Database,
    projectIdentity: string,
): Promise<number> {
    return drainCompartmentChunkBacklogForProject(
        db,
        projectIdentity,
        Date.now() + SWEEP_MAX_WALL_CLOCK_MS,
    );
}

export interface SessionChunkBackfillProgress {
    /** Compartments fully embedded so far this run. */
    embedded: number;
    /** Total compartments that needed embedding when the run started. */
    total: number;
}

export type SessionChunkBackfillOutcome =
    | { status: "done"; embedded: number; total: number; failed: number }
    | { status: "nothing"; embedded: 0; total: 0 }
    | { status: "disabled"; embedded: 0; total: 0 }
    | { status: "busy"; embedded: 0; total: number }
    | { status: "aborted"; embedded: number; total: number; failed: number }
    // Some candidates could not be embedded this run (provider returned no
    // vectors for them after retries) and were not skippable no-work rows —
    // surfaced so the command can tell the user it stopped early (with how many
    // failed) instead of falsely "done". `remaining` is still-embeddable count.
    | { status: "stalled"; embedded: number; total: number; remaining: number; failed: number };

/**
 * Backfill ALL un-embedded compartment chunks for ONE session in a single run
 * (the `/ctx-embed-history` command path), oldest-first so progress fills
 * chronologically. Unlike the passive project drain this has no per-sweep cap —
 * the user asked for the whole session — but it still runs under the per-project
 * embedding coordinator lease (mutual exclusion with the passive sweep + sibling
 * processes) and yields between batches so an 8-core MiniLM burst stays
 * interruptible. Idempotent + resumable via chunk_hash; re-running embeds only
 * what's still missing.
 */
export async function embedSessionCompartmentChunks(
    db: Database,
    projectIdentity: string,
    sessionId: string,
    options?: {
        signal?: AbortSignal;
        onProgress?: (p: SessionChunkBackfillProgress) => void;
        batchSize?: number;
    },
): Promise<SessionChunkBackfillOutcome> {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.enabled || snapshot.chunkModelId === "off") {
        return { status: "disabled", embedded: 0, total: 0 };
    }
    // The session command path resolves this identity from the host session;
    // persist it before counting so stale rows under another project cannot make
    // this session look already embedded forever.
    recordSessionProjectIdentity(db, sessionId, projectIdentity);
    const total = countUnembeddedSessionCompartments(
        db,
        projectIdentity,
        sessionId,
        snapshot.chunkModelId,
    );
    if (total === 0) return { status: "nothing", embedded: 0, total: 0 };

    const holderId = `session-embed-${randomUUID()}`;
    const lease = acquireGitSweepLease(db, projectIdentity, holderId, { ignoreCooldown: true });
    if (!lease.acquired) return { status: "busy", embedded: 0, total };

    // Unbounded run → renew the lease before the TTL lapses so a sibling process
    // or the passive sweep can't acquire the "expired" lease mid-run (mirrors the
    // git sweep's renewal loop). Cleared in finally.
    const renewal = setInterval(() => {
        try {
            renewGitSweepLease(db, projectIdentity, holderId);
        } catch {
            /* best-effort; a failed renewal just risks the busy-window above */
        }
    }, SESSION_EMBED_LEASE_RENEWAL_MS);
    (renewal as { unref?: () => void }).unref?.();

    const batchSize = Math.max(1, options?.batchSize ?? CHUNK_DRAIN_BATCH_SIZE);
    // Compartments that produced no embeddable work (empty canonical text /
    // already-current windows) accumulate here and are excluded from subsequent
    // candidate queries, so one un-embeddable old compartment can't block the
    // oldest-first cursor from reaching newer ones (no infinite re-select).
    const skipIds: number[] = [];
    // Compartments the provider couldn't embed THIS run (after retries). Excluded
    // so the cursor advances past them and the drain finishes the rest, but NOT
    // persisted as skip — a future run re-attempts them.
    const failedIds: number[] = [];
    let embedded = 0;
    let aborted = false;
    let providerDown = false;
    let consecutiveFailedBatches = 0;
    try {
        options?.onProgress?.({ embedded, total });
        // Re-query each iteration (rather than pre-loading all candidates) so
        // newly-published compartments mid-run are picked up and chunk_hash dedup
        // is re-checked against fresh state. `total` is the start-of-run
        // denominator; `embedded` is clamped to it in the callback in case the
        // historian published mid-run.
        for (;;) {
            if (options?.signal?.aborted) {
                aborted = true;
                break;
            }
            const candidates = loadUnembeddedSessionChunkCandidates(
                db,
                projectIdentity,
                sessionId,
                snapshot.chunkModelId,
                batchSize,
                [...skipIds, ...failedIds],
            );
            if (candidates.length === 0) break;
            const {
                embedded: n,
                noWork,
                failed,
            } = await embedCandidateChunkBatch(
                db,
                projectIdentity,
                snapshot.chunkModelId,
                candidates,
                options?.signal,
            );
            // Record no-work candidates so the next query advances past them.
            for (const id of noWork) skipIds.push(id);
            // Record this-run failures so the cursor advances; retried next run.
            for (const id of failed) failedIds.push(id);

            // Circuit breaker: a batch that made zero forward progress and had no
            // skippable no-work rows is an all-failed batch. A few in a row means
            // the provider is down — stop instead of grinding every remaining
            // compartment through retries against a dead endpoint.
            if (n === 0 && noWork.length === 0) {
                consecutiveFailedBatches += 1;
                if (consecutiveFailedBatches >= MAX_CONSECUTIVE_FAILED_BATCHES) {
                    providerDown = true;
                    break;
                }
            } else {
                consecutiveFailedBatches = 0;
            }

            embedded += n;
            options?.onProgress?.({ embedded: Math.min(embedded, total), total });
            // Yield to the event loop so the burst stays interruptible and the
            // host process can serve other work between batches.
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    } finally {
        clearInterval(renewal);
        try {
            releaseGitSweepLease(db, projectIdentity, holderId);
        } catch (error) {
            // A release-time SQLite error (e.g. lock contention) must not mask the
            // drain's own result/throw. The lease TTL-expires on its own.
            log("[magic-context] embed drain: lease release failed (will TTL-expire):", error);
        }
    }
    if (aborted) return { status: "aborted", embedded, total, failed: failedIds.length };
    // Either the provider went down (circuit broke) or some compartments failed
    // their retries but the rest drained. Count what's genuinely still embeddable
    // (excludes already-embedded rows; no-work skips are permanently empty-text
    // compartments, not a stall).
    if (providerDown || failedIds.length > 0) {
        const remaining = Math.max(
            0,
            countUnembeddedSessionCompartments(
                db,
                projectIdentity,
                sessionId,
                snapshot.chunkModelId,
            ) - skipIds.length,
        );
        if (remaining > 0) {
            return { status: "stalled", embedded, total, remaining, failed: failedIds.length };
        }
    }
    return { status: "done", embedded, total, failed: failedIds.length };
}

export interface EmbeddingCoverageStatus {
    /** Whether embedding is active at all for this project. */
    enabled: boolean;
    /** Friendly configured model name, or "off"/"disabled". */
    model: string;
    /** Configured provider kind ("local" / "openai-compatible" / "ollama" / "off"). */
    provider: string;
    /** This session's compartment-chunk coverage. */
    session: { embedded: number; total: number };
    /** Project-wide active-memory coverage. */
    memories: { embedded: number; total: number };
    /** Project-wide git-commit coverage (only meaningful when gitEnabled). */
    commits: { embedded: number; total: number; gitEnabled: boolean };
}

/**
 * Gather the embedding-coverage status for `/ctx-embed` (no-arg): which model is
 * active, and how much of this session's history / the project's memories /
 * git commits are embedded under it. Pure reads — no provider calls.
 */
export function getEmbeddingCoverageStatus(
    db: Database,
    projectIdentity: string,
    sessionId: string,
): EmbeddingCoverageStatus {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.enabled || snapshot.chunkModelId === "off") {
        return {
            enabled: false,
            model: snapshot?.model ?? "off",
            provider: snapshot?.provider ?? "off",
            session: { embedded: 0, total: 0 },
            memories: { embedded: 0, total: 0 },
            commits: { embedded: 0, total: 0, gitEnabled: false },
        };
    }
    const session = countSessionCompartmentEmbedCoverage(
        db,
        projectIdentity,
        sessionId,
        snapshot.chunkModelId,
    );
    const memories = getMemoryEmbedCoverage(db, projectIdentity, snapshot.modelId);
    const gitEnabled = snapshot.gitCommitEnabled;
    const commits = gitEnabled
        ? {
              embedded: countEmbeddedCommits(db, projectIdentity, snapshot.modelId),
              total: getCommitCount(db, projectIdentity),
              gitEnabled: true,
          }
        : { embedded: 0, total: 0, gitEnabled: false };
    return {
        enabled: true,
        model: snapshot.model,
        provider: snapshot.provider,
        session,
        memories,
        commits,
    };
}

export async function sweepAllRegisteredProjects(
    db: Database,
    batchSize = 10,
): Promise<{
    memoriesEmbedded: number;
    commitsEmbedded: number;
    chunksEmbedded: number;
    perProject: Map<string, { memories: number; commits: number; chunks: number }>;
}> {
    if (projectSweepInProgress) {
        log("[magic-context] project embedding sweep already in progress, skipping this tick");
        return {
            memoriesEmbedded: 0,
            commitsEmbedded: 0,
            chunksEmbedded: 0,
            perProject: new Map(),
        };
    }

    projectSweepInProgress = true;
    const startedAt = Date.now();
    const deadline = startedAt + SWEEP_MAX_WALL_CLOCK_MS;
    const perProject = new Map<string, { memories: number; commits: number; chunks: number }>();
    let memoriesEmbedded = 0;
    let commitsEmbedded = 0;
    let chunksEmbedded = 0;

    try {
        for (const projectIdentity of projectRegistrations.keys()) {
            let memories = 0;
            let commits = 0;
            let chunks = 0;
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
                commits = await drainCommitBacklogForProject(db, projectIdentity, deadline);
                commitsEmbedded += commits;
            }

            if (Date.now() < deadline) {
                chunks = await drainCompartmentChunkBacklogForProject(
                    db,
                    projectIdentity,
                    deadline,
                );
                chunksEmbedded += chunks;
            }

            perProject.set(projectIdentity, { memories, commits, chunks });
            if (Date.now() >= deadline) break;
        }
    } finally {
        projectSweepInProgress = false;
    }

    return { memoriesEmbedded, commitsEmbedded, chunksEmbedded, perProject };
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
    untrustedLoadProjects.clear();
    globalRegistrationGeneration = 0;
    projectSweepInProgress = false;
    testProviderFactory = null;
}
