import { sessionLog } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { CATEGORY_DEFAULT_TTL, PROMOTABLE_CATEGORIES } from "./constants";
import { embedText, getEmbeddingModelId } from "./embedding";
import { computeNormalizedHash } from "./normalize-hash";
import { getMemoryByHash, insertMemory, updateMemorySeenCount } from "./storage-memory";
import { saveEmbedding } from "./storage-memory-embeddings";
import type { MemoryCategory, MemoryInput } from "./types";

interface SessionFact {
    category: string;
    content: string;
}

function isPromotableCategory(category: string): category is MemoryCategory {
    return PROMOTABLE_CATEGORIES.some((promotableCategory) => promotableCategory === category);
}

function resolveExpiresAt(category: MemoryCategory): number | null {
    const ttl = CATEGORY_DEFAULT_TTL[category];
    return ttl === undefined ? null : Date.now() + ttl;
}

/**
 * Promote eligible session facts to cross-session memories.
 * Called after replaceAllCompartmentState() commits.
 * Uses normalized_hash for fast dedup. Async embedding runs post-commit.
 */
export function promoteSessionFactsToMemory(
    db: Database,
    sessionId: string,
    projectPath: string,
    facts: SessionFact[],
): void {
    for (const fact of facts) {
        if (!isPromotableCategory(fact.category)) {
            continue;
        }

        try {
            const normalizedHash = computeNormalizedHash(fact.content);
            const existingMemory = getMemoryByHash(db, projectPath, fact.category, normalizedHash);

            if (existingMemory) {
                updateMemorySeenCount(db, existingMemory.id);
                continue;
            }

            const memoryInput: MemoryInput = {
                projectPath,
                category: fact.category,
                content: fact.content,
                sourceSessionId: sessionId,
                sourceType: "historian",
                expiresAt: resolveExpiresAt(fact.category),
            };

            const memory = insertMemory(db, memoryInput);
            // Intentional: fire-and-forget embedding — promotion runs infrequently (after historian passes)
            // and the number of new facts per pass is small. Batching adds complexity for negligible benefit.
            void embedAndStoreMemory(db, sessionId, memory.id, memory.content);
        } catch (error) {
            sessionLog(
                sessionId,
                `memory promotion failed for fact "${fact.content.slice(0, 60)}":`,
                error,
            );
        }
    }
}

async function embedAndStoreMemory(
    db: Database,
    sessionId: string,
    memoryId: number,
    content: string,
): Promise<void> {
    try {
        const embedding = await embedText(content);
        if (embedding) {
            saveEmbedding(db, memoryId, embedding, getEmbeddingModelId());
        }
    } catch (error) {
        sessionLog(sessionId, `memory embedding failed for memory ${memoryId}:`, error);
    }
}
