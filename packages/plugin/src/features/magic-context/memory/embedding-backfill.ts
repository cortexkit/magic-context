import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { embedBatch, getEmbeddingModelId, isEmbeddingEnabled } from "./embedding";
import { saveEmbedding } from "./storage-memory-embeddings";
import type { Memory } from "./types";

export async function ensureMemoryEmbeddings(args: {
    db: Database;
    memories: Memory[];
    existingEmbeddings: Map<number, Float32Array>;
}): Promise<Map<number, Float32Array>> {
    if (!isEmbeddingEnabled()) {
        return args.existingEmbeddings;
    }

    const missingMemories = args.memories.filter(
        (memory) => !args.existingEmbeddings.has(memory.id),
    );
    if (missingMemories.length === 0) {
        return args.existingEmbeddings;
    }

    try {
        const embeddings = await embedBatch(missingMemories.map((memory) => memory.content));
        const modelId = getEmbeddingModelId();

        // Stage results before committing — only merge into the in-memory cache after
        // the transaction succeeds, so a rollback doesn't leave stale Map entries.
        const staged = new Map<number, Float32Array>();
        args.db.transaction(() => {
            for (const [index, memory] of missingMemories.entries()) {
                const embedding = embeddings[index];
                if (!embedding) {
                    continue;
                }

                saveEmbedding(args.db, memory.id, embedding, modelId);
                staged.set(memory.id, embedding);
            }
        })();

        // Transaction committed — safe to merge into caller's cache
        for (const [id, embedding] of staged) {
            args.existingEmbeddings.set(id, embedding);
        }
    } catch (error) {
        log("[magic-context] failed to backfill memory embeddings:", error);
    }

    return args.existingEmbeddings;
}
