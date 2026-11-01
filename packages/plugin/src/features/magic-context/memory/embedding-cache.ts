import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { isResolvedProjectId } from "../../../shared/resolved-project-id";
import type { Database } from "../../../shared/sqlite";
import { loadAllEmbeddings, type StoredMemoryEmbedding } from "./storage-memory-embeddings";

interface ProjectEmbeddingCacheEntry {
    db: Database;
    projectMemoryEpoch: number;
    embeddings: Map<number, StoredMemoryEmbedding>;
    expiresAt: number;
}

const DEFAULT_EMBEDDING_CACHE_TTL_MS = 60_000;
export const PROJECT_EMBEDDING_CACHE_EPOCH_SQL =
    "SELECT COALESCE((SELECT project_memory_epoch FROM project_state WHERE project_path=?),0) AS projectMemoryEpoch";

const projectEmbeddingCache = new Map<string, ProjectEmbeddingCacheEntry>();

let embeddingCacheTtlMs = DEFAULT_EMBEDDING_CACHE_TTL_MS;

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
    // The dashboard increments this project's epoch whenever it edits or restores memory.
    // Checking it reloads vectors changed by another process without treating unrelated
    // database writes as a reason to reload. Other processes' automated edits and
    // re-embedding expire via the 60-second TTL; local writes evict affected vectors directly.
    const epochProject = isResolvedProjectId(projectPath)
        ? projectPath
        : `dir:${createHash("md5").update(resolve(projectPath)).digest("hex").slice(0, 12)}`;
    const { projectMemoryEpoch } = db
        .prepare(PROJECT_EMBEDDING_CACHE_EPOCH_SQL)
        .get(epochProject) as { projectMemoryEpoch: number };
    const cached = getValidCacheEntry(projectPath, modelId);
    if (cached?.db === db && cached.projectMemoryEpoch === projectMemoryEpoch)
        return cached.embeddings;
    if (cached) {
        cached.embeddings.clear();
        projectEmbeddingCache.delete(cacheKey(projectPath, modelId));
    }

    const embeddings = loadAllEmbeddings(db, projectPath, modelId);
    projectEmbeddingCache.set(cacheKey(projectPath, modelId), {
        db,
        projectMemoryEpoch,
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
