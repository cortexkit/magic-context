import type { Database, Statement } from "../../../shared/sqlite";
import { loadAllEmbeddings, type StoredMemoryEmbedding } from "./storage-memory-embeddings";

interface ProjectEmbeddingCacheEntry {
    embeddings: Map<number, StoredMemoryEmbedding>;
    expiresAt: number;
}

const DEFAULT_EMBEDDING_CACHE_TTL_MS = 60_000;

const projectEmbeddingCache = new Map<string, ProjectEmbeddingCacheEntry>();

let embeddingCacheTtlMs = DEFAULT_EMBEDDING_CACHE_TTL_MS;

interface KeptWorkerEmbeddingEntry {
    projectPath: string;
    modelId: string;
    version: number;
    loadedAt: number;
    embeddings: Map<number, StoredMemoryEmbedding>;
}
interface KeptWorkerEmbeddingCache {
    entries: Map<string, KeptWorkerEmbeddingEntry>;
    version?: Statement;
    lastBackgroundReloadAt: number;
}
const keptWorkerCaches = new WeakMap<Database, KeptWorkerEmbeddingCache>();

/**
 * Keep this connection's memory vectors loaded between searches and refresh
 * them when the store changes. Only the search worker that stays alive between
 * turns calls this: it has a private, read-only connection of its own.
 */
export function keepWorkerMemoryEmbeddings(db: Database): void {
    keptWorkerCaches.set(db, {
        entries: new Map(),
        lastBackgroundReloadAt: -Infinity,
    });
}

function readDataVersion(db: Database, cache: KeptWorkerEmbeddingCache): number {
    cache.version ??= db.prepare("PRAGMA data_version");
    return Number((cache.version.get() as { data_version: number }).data_version);
}

function loadKeptWorkerEntry(
    db: Database,
    cache: KeptWorkerEmbeddingCache,
    projectPath: string,
    modelId: string,
    version: number,
    loadedAt: number,
): Map<number, StoredMemoryEmbedding> {
    const embeddings = loadAllEmbeddings(db, projectPath, modelId);
    // Callers pass the version they read before loading these vectors. A later
    // commit must not be mistaken for part of the loaded snapshot.
    cache.entries.set(projectPath, {
        projectPath,
        modelId,
        version,
        loadedAt,
        embeddings,
    });
    return embeddings;
}

export function maintainKeptWorkerMemoryEmbeddings(db: Database): void {
    const cache = keptWorkerCaches.get(db);
    const now = Date.now();
    if (!cache?.entries.size || now - cache.lastBackgroundReloadAt < DEFAULT_EMBEDDING_CACHE_TTL_MS)
        return;
    const version = readDataVersion(db, cache);
    for (const entry of cache.entries.values()) {
        if (entry.version === version || now - entry.loadedAt < DEFAULT_EMBEDDING_CACHE_TTL_MS)
            continue;
        // A commit to any table moves data_version. Bound background reloads
        // even when unrelated sessions keep writing to the same database.
        cache.lastBackgroundReloadAt = now;
        loadKeptWorkerEntry(db, cache, entry.projectPath, entry.modelId, version, now);
    }
}

function cacheKey(projectPath: string, modelId: string): string {
    return `${projectPath}\0${modelId}`;
}

function getValidCacheEntry(
    projectPath: string,
    modelId: string,
): ProjectEmbeddingCacheEntry | null {
    const entry = projectEmbeddingCache.get(cacheKey(projectPath, modelId));
    if (!entry) {
        return null;
    }

    if (entry.expiresAt <= Date.now()) {
        projectEmbeddingCache.delete(cacheKey(projectPath, modelId));
        return null;
    }

    return entry;
}

export function getProjectEmbeddings(
    db: Database,
    projectPath: string,
    modelId: string,
): Map<number, StoredMemoryEmbedding> {
    const kept = keptWorkerCaches.get(db);
    if (kept) {
        const now = Date.now();
        const cached = kept.entries.get(projectPath);
        const entry = cached?.modelId === modelId ? cached : undefined;
        if (entry && now - entry.loadedAt < DEFAULT_EMBEDDING_CACHE_TTL_MS) return entry.embeddings;
        const version = readDataVersion(db, kept);
        if (entry?.version === version) return entry.embeddings;
        return loadKeptWorkerEntry(db, kept, projectPath, modelId, version, now);
    }
    const cached = getValidCacheEntry(projectPath, modelId);
    if (cached) {
        return cached.embeddings;
    }

    const embeddings = loadAllEmbeddings(db, projectPath, modelId);
    projectEmbeddingCache.set(cacheKey(projectPath, modelId), {
        embeddings,
        expiresAt: Date.now() + embeddingCacheTtlMs,
    });
    return embeddings;
}

export function peekProjectEmbeddings(
    projectPath: string,
    modelId: string,
): Map<number, StoredMemoryEmbedding> | null {
    return getValidCacheEntry(projectPath, modelId)?.embeddings ?? null;
}

export function invalidateProject(projectPath: string): void {
    for (const key of projectEmbeddingCache.keys()) {
        if (key.startsWith(`${projectPath}\0`)) {
            projectEmbeddingCache.delete(key);
        }
    }
}

export function invalidateMemory(projectPath: string, memoryId: number): void {
    for (const key of projectEmbeddingCache.keys()) {
        if (!key.startsWith(`${projectPath}\0`)) continue;
        const entry = projectEmbeddingCache.get(key);
        if (!entry || entry.expiresAt <= Date.now()) {
            projectEmbeddingCache.delete(key);
            continue;
        }
        entry.embeddings.delete(memoryId);
    }
}

export function resetEmbeddingCacheForTests(): void {
    projectEmbeddingCache.clear();
    embeddingCacheTtlMs = DEFAULT_EMBEDDING_CACHE_TTL_MS;
}

export function setEmbeddingCacheTtlForTests(ttlMs: number): void {
    embeddingCacheTtlMs = Math.max(0, Math.floor(ttlMs));
}
