import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { embedBatchForProject, getProjectEmbeddingSnapshot } from "./embedding";
import { saveEmbedding } from "./storage-memory-embeddings";
import type { Memory } from "./types";

export async function ensureMemoryEmbeddings(args: {
    db: Database;
    projectIdentity: string;
    memories: Memory[];
    existingEmbeddings: Map<number, Float32Array>;
}): Promise<Map<number, Float32Array>> {
    const snapshot = getProjectEmbeddingSnapshot(args.projectIdentity);
    if (!snapshot?.enabled) {
        return args.existingEmbeddings;
    }

    const missingMemories = args.memories.filter(
        (memory) => !args.existingEmbeddings.has(memory.id),
    );
    if (missingMemories.length === 0) {
        return args.existingEmbeddings;
    }

    try {
        const result = await embedBatchForProject(
            args.projectIdentity,
            missingMemories.map((memory) => memory.content),
        );
        if (!result) {
            return args.existingEmbeddings;
        }

        // Stage results before committing — only merge into the in-memory cache after
        // the transaction succeeds, so a rollback doesn't leave stale Map entries.
        const staged = new Map<number, Float32Array>();
        args.db.transaction(() => {
            for (const [index, memory] of missingMemories.entries()) {
                const embedding = result.vectors[index];
                if (!embedding) {
                    continue;
                }

                saveEmbedding(args.db, memory.id, embedding, result.modelId);
                staged.set(memory.id, embedding);
            }
        })();

        const currentSnapshot = getProjectEmbeddingSnapshot(args.projectIdentity);
        if (!currentSnapshot || currentSnapshot.generation !== result.generation) {
            return args.existingEmbeddings;
        }

        // Transaction committed — safe to merge into caller's cache
        for (const [id, embedding] of staged) {
            args.existingEmbeddings.set(id, embedding);
        }
    } catch (error) {
        log("[magic-context] failed to backfill memory embeddings:", error);
    }

    return args.existingEmbeddings;
}
