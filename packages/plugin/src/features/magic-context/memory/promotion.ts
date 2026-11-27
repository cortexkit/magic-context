import { sessionLog } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { CATEGORY_DEFAULT_TTL, PROMOTABLE_CATEGORIES } from "./constants";
import { embedTextForProject } from "./embedding";
import { computeNormalizedHash } from "./normalize-hash";
import {
    getMemoryByHash,
    getMemoryById,
    insertMemory,
    updateMemorySeenCount,
} from "./storage-memory";
import { saveEmbeddingIfHashMatches } from "./storage-memory-embeddings";
import type { MemoryCategory, MemoryInput } from "./types";

interface SessionFact {
    category: string;
    content: string;
}

export interface PromotedMemoryRef {
    memoryId: number;
    content: string;
}

export interface PromoteSessionFactsDurableResult {
    /** Newly inserted memories that still need embedding. */
    newMemoryRefs: PromotedMemoryRef[];
    /** Valid promotable facts that inserted a row or updated an existing row. */
    factsPromoted: number;
}

function isPromotableCategory(category: string): category is MemoryCategory {
    return PROMOTABLE_CATEGORIES.some((promotableCategory) => promotableCategory === category);
}

function resolveExpiresAt(category: MemoryCategory): number | null {
    const ttl = CATEGORY_DEFAULT_TTL[category];
    return ttl === undefined ? null : Date.now() + ttl;
}

/**
 * Synchronously promote eligible session facts to cross-session memories.
 *
 * Transaction contract: callers may run this inside their publish transaction.
 * Storage failures deliberately propagate so the enclosing publication rolls
 * back atomically with the boundary; malformed/unpromotable facts are validation
 * skips and do not abort the publish.
 */
export function promoteSessionFactsDurable(
    db: Database,
    sessionId: string,
    projectPath: string,
    facts: SessionFact[],
): PromoteSessionFactsDurableResult {
    const newMemoryRefs: PromotedMemoryRef[] = [];
    let factsPromoted = 0;
    for (const fact of facts) {
        if (
            !fact ||
            typeof fact.category !== "string" ||
            typeof fact.content !== "string" ||
            fact.content.trim().length === 0
        ) {
            continue;
        }
        if (!isPromotableCategory(fact.category)) {
            continue;
        }

        const normalizedHash = computeNormalizedHash(fact.content);
        const existingMemory = getMemoryByHash(db, projectPath, fact.category, normalizedHash);

        if (existingMemory) {
            updateMemorySeenCount(db, existingMemory.id);
            factsPromoted += 1;
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
        newMemoryRefs.push({ memoryId: memory.id, content: memory.content });
        factsPromoted += 1;
    }

    return { newMemoryRefs, factsPromoted };
}

/**
 * Best-effort asynchronous embedding for newly promoted facts. Must run after
 * the durable publish transaction commits.
 */
export async function embedPromotedFacts(
    db: Database,
    sessionId: string,
    projectPath: string,
    refs: PromotedMemoryRef[],
): Promise<void> {
    for (const ref of refs) {
        await embedAndStoreMemory(db, sessionId, projectPath, ref.memoryId);
    }
}

async function embedAndStoreMemory(
    db: Database,
    sessionId: string,
    projectPath: string,
    memoryId: number,
): Promise<void> {
    try {
        // A queued memory can change while an earlier fact is embedding. Read
        // its text and hash from the same row; the guarded save rejects any
        // later edit while this provider call is in flight.
        const memory = getMemoryById(db, memoryId);
        if (!memory?.normalizedHash) {
            return;
        }
        const result = await embedTextForProject(projectPath, memory.content);
        if (result) {
            db.transaction(() => {
                saveEmbeddingIfHashMatches(
                    db,
                    memoryId,
                    result.vector,
                    result.modelId,
                    memory.normalizedHash,
                );
            }).immediate();
        }
    } catch (error) {
        sessionLog(sessionId, `memory embedding failed for memory ${memoryId}:`, error);
    }
}
