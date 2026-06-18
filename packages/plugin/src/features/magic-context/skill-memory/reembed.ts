import type { Database } from "../../../shared/sqlite";
import { embedTextForProject } from "../memory/embedding";
import { float32ArrayToBlob } from "../memory/storage-memory-embeddings";

const REEMBED_CAP = 200;

/** Programmatic (no-LLM) backfill: re-embed notes with NULL/stale vectors. Idempotent; skips when provider off. */
export async function reembedStaleSkillNotes(
    db: Database,
    projectIdentity: string,
): Promise<{ reembedded: number }> {
    // Probe the current model version once (also tells us if the provider is up).
    const probe = await embedTextForProject(projectIdentity, "probe");
    if (!probe) return { reembedded: 0 }; // provider off — nothing to do
    const currentModel = probe.modelId;

    // Stale = NULL embeddings OR embedded under a DIFFERENT model version.
    // `embedding_model_version IS NOT ?` is NULL-safe SQL; the prior IS NULL OR-clauses already catch NULL-embedding
    // rows; INSERT always sets all three embedding columns together, so non-NULL model_version + NULL embeddings can't occur.
    const stale = db
        .prepare(
            `SELECT id, intent, delta FROM skill_memory
         WHERE (project_identity = ? OR project_identity = '*')
            AND (intent_embedding IS NULL OR delta_embedding IS NULL OR embedding_model_version IS NOT ?)
         LIMIT ?`,
        )
        .all(projectIdentity, currentModel, REEMBED_CAP) as Array<{
        id: number;
        intent: string;
        delta: string;
    }>;
    let n = 0;
    for (const row of stale) {
        const iv = await embedTextForProject(projectIdentity, row.intent);
        const dv = await embedTextForProject(projectIdentity, row.delta);
        if (!iv || !dv) break; // provider went down mid-batch — stop
        db.prepare(
            `UPDATE skill_memory SET intent_embedding=?, delta_embedding=?, embedding_model_version=? WHERE id=?`,
        ).run(float32ArrayToBlob(iv.vector), float32ArrayToBlob(dv.vector), dv.modelId, row.id);
        n++;
    }
    return { reembedded: n };
}
