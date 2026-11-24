import { isEmbeddingHostBusy } from "../../../shared/embedding-activity";
import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import {
    contentSha256,
    embedItemsWindowBounded,
    getProjectEmbeddingSnapshot,
    readSearchBackfillCursor,
    writeSearchBackfillCursor,
} from "../project-embedding-registry";
import {
    type StoredMemoryEmbedding,
    saveEmbeddingIfHashMatches,
} from "./storage-memory-embeddings";
import type { Memory } from "./types";

const SEARCH_BACKFILL_LIMIT = 50;
const SEARCH_BACKFILL_REQUEST_SIZE = 10;

export async function ensureMemoryEmbeddings(args: {
    db: Database;
    projectIdentity: string;
    memories: Memory[];
    existingEmbeddings: Map<number, StoredMemoryEmbedding>;
}): Promise<Map<number, StoredMemoryEmbedding>> {
    if (isEmbeddingHostBusy()) return args.existingEmbeddings;
    const snapshot = getProjectEmbeddingSnapshot(args.projectIdentity);
    if (!snapshot?.enabled) {
        return args.existingEmbeddings;
    }

    const missing = args.memories
        .filter((memory) => !args.existingEmbeddings.has(memory.id))
        .sort((a, b) => a.id - b.id);
    // Start in ID order. After a capped batch with missing vectors, give the
    // untried rows a turn before retrying the older misses.
    const capped = missing.length > SEARCH_BACKFILL_LIMIT;
    const cursor = capped
        ? readSearchBackfillCursor(args.projectIdentity, snapshot.generation)
        : undefined;
    const next = cursor === undefined ? 0 : missing.findIndex((memory) => memory.id > cursor);
    const start = Math.max(0, next);
    const missingMemories = missing.slice(start, start + SEARCH_BACKFILL_LIMIT);
    if (missingMemories.length === 0) {
        return args.existingEmbeddings;
    }

    try {
        const result = await embedItemsWindowBounded(
            args.projectIdentity,
            missingMemories.map((memory) => ({
                id: `memory:${memory.id}`,
                text: memory.content,
                contentSha256: contentSha256(memory.content),
            })),
            undefined,
            args.db,
            args.projectIdentity,
            { maxItemsPerCall: SEARCH_BACKFILL_REQUEST_SIZE },
        );
        if (!result) {
            return args.existingEmbeddings;
        }

        // Stage results before committing — only merge into the in-memory cache after
        // the transaction succeeds, so a rollback doesn't leave stale Map entries.
        const staged = new Map<number, StoredMemoryEmbedding>();
        args.db
            .transaction(() => {
                for (const memory of missingMemories) {
                    const embedding = result.vectors.get(`memory:${memory.id}`);
                    if (!embedding) {
                        continue;
                    }

                    // The vector was computed from the content this memory had when the
                    // batch was assembled. If the memory was edited while the provider
                    // call was in flight, its normalized_hash no longer matches and the
                    // guarded save discards the stale vector — leaving the row unembedded
                    // so the proactive drain re-embeds the current content next round.
                    // A skipped memory must not enter the cache either: a stale cached
                    // vector would score searches until the cache is rebuilt.
                    const saved = saveEmbeddingIfHashMatches(
                        args.db,
                        memory.id,
                        embedding,
                        result.modelId,
                        memory.normalizedHash,
                    );
                    if (saved) {
                        staged.set(memory.id, { embedding, modelId: result.modelId });
                    }
                }
            })
            .immediate();

        const currentSnapshot = getProjectEmbeddingSnapshot(args.projectIdentity);
        if (!currentSnapshot || currentSnapshot.generation !== result.generation) {
            return args.existingEmbeddings;
        }

        if (capped && (cursor !== undefined || result.vectors.size < missingMemories.length)) {
            const nextCursor =
                start + missingMemories.length < missing.length
                    ? missingMemories.at(-1)?.id
                    : undefined;
            writeSearchBackfillCursor(
                args.projectIdentity,
                snapshot.generation,
                cursor,
                nextCursor,
            );
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
