import type { Database } from "../../../shared/sqlite";
import { loadAllEmbeddings } from "./storage-memory-embeddings";

interface ProjectEmbeddingCacheEntry {
    embeddings: Map<number, Float32Array>;
    expiresAt: number;
}

const DEFAULT_EMBEDDING_CACHE_TTL_MS = 60_000;

const projectEmbeddingCache = new Map<string, ProjectEmbeddingCacheEntry>();

let embeddingCacheTtlMs = DEFAULT_EMBEDDING_CACHE_TTL_MS;

function getValidCacheEntry(projectPath: string): ProjectEmbeddingCacheEntry | null {
    const entry = projectEmbeddingCache.get(projectPath);
    if (!entry) {
        return null;
    }

    if (entry.expiresAt <= Date.now()) {
        projectEmbeddingCache.delete(projectPath);
        return null;
    }

    return entry;
}

export function getProjectEmbeddings(db: Database, projectPath: string): Map<number, Float32Array> {
    const cached = getValidCacheEntry(projectPath);
    if (cached) {
        return cached.embeddings;
    }

    const embeddings = loadAllEmbeddings(db, projectPath);
    projectEmbeddingCache.set(projectPath, {
        embeddings,
        expiresAt: Date.now() + embeddingCacheTtlMs,
    });
    return embeddings;
}

export function peekProjectEmbeddings(projectPath: string): Map<number, Float32Array> | null {
    return getValidCacheEntry(projectPath)?.embeddings ?? null;
}

export function invalidateProject(projectPath: string): void {
    projectEmbeddingCache.delete(projectPath);
}

export function invalidateMemory(projectPath: string, memoryId: number): void {
    const cached = getValidCacheEntry(projectPath);
    cached?.embeddings.delete(memoryId);
}

export function resetEmbeddingCacheForTests(): void {
    projectEmbeddingCache.clear();
    embeddingCacheTtlMs = DEFAULT_EMBEDDING_CACHE_TTL_MS;
}

export function setEmbeddingCacheTtlForTests(ttlMs: number): void {
    embeddingCacheTtlMs = Math.max(0, Math.floor(ttlMs));
}
