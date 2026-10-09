import { sessionLog } from "../../../shared/logger";
import { randomUUID } from "node:crypto";
import type { Database } from "../../../shared/sqlite";
import { PROMOTABLE_CATEGORIES } from "./constants";
import { embedTextForProject } from "./embedding";
import { computeNormalizedHash } from "./normalize-hash";
import { getMemoryById } from "./storage-memory";
import { applyMemoryAdmission, type ApplierReceipt } from "./lifecycle-applier";
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
    receipts: ApplierReceipt[];
}

function isPromotableCategory(category: string): category is MemoryCategory {
    return PROMOTABLE_CATEGORIES.some((promotableCategory) => promotableCategory === category);
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
    const receipts: ApplierReceipt[] = [];
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

        const memoryInput: MemoryInput = {
            projectPath,
            category: fact.category,
            content: fact.content,
            sourceSessionId: sessionId,
            sourceType: "historian",
        };
        const receipt = applyMemoryAdmission(db, { key: randomUUID(), operation: "new", input: memoryInput });
        receipts.push(receipt);
        if (receipt.state === "applied") {
            if (receipt.inserted) newMemoryRefs.push({ memoryId: receipt.memoryId!, content: fact.content });
            factsPromoted += 1;
        }
    }

    return { newMemoryRefs, factsPromoted, receipts };
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
        await embedAndStoreMemory(db, sessionId, projectPath, ref.memoryId, ref.content);
    }
}

async function embedAndStoreMemory(
    db: Database,
    sessionId: string,
    projectPath: string,
    memoryId: number,
    content: string,
): Promise<void> {
    try {
        // Capture the row's content hash BEFORE the async provider call: the
        // vector it returns is only valid for the content stored right now. If
        // the memory is edited while the call is in flight, the row's
        // normalized_hash changes and the guarded save below discards the stale
        // vector instead of resurrecting an out-of-date row — the memory then
        // stays unembedded until the proactive drain re-embeds current content.
        const hashBeforeEmbed = getMemoryById(db, memoryId)?.normalizedHash;
        if (!hashBeforeEmbed) {
            return;
        }
        const result = await embedTextForProject(projectPath, content);
        if (result) {
            db.transaction(() => {
                saveEmbeddingIfHashMatches(
                    db,
                    memoryId,
                    result.vector,
                    result.modelId,
                    hashBeforeEmbed,
                );
            }).immediate();
        }
    } catch (error) {
        sessionLog(sessionId, `memory embedding failed for memory ${memoryId}:`, error);
    }
}
