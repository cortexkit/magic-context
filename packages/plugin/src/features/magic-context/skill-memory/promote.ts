import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { computeNormalizedHash } from "../memory/normalize-hash";
import { bumpHitCount, findExistingNote, insertSkillMemoryNote, partitionKey } from "./storage";

const VALID_KINDS = new Set(["gotcha", "discovery", "fix", "workflow"]);

export interface SkillObservation {
    skillId: string;
    kind: "gotcha" | "discovery" | "fix" | "workflow";
    lesson: string;
}

/**
 * Direct-write historian-extracted skill observations as GLOBAL-tier notes under
 * the '*' partition (source_type='historian', resolved_path='' sentinel). Hash-dedup:
 * an exact-hash match bumps hit_count instead of inserting. Returns the number of
 * NEW notes written (dups excluded). Best-effort per item: never throws.
 */
export function promoteSkillObservations(
    db: Database,
    originProject: string,
    observations: SkillObservation[],
): number {
    let written = 0;
    const tier = "global" as const;
    const part = partitionKey(tier, originProject);

    for (const obs of observations) {
        if (!obs.skillId || !obs.lesson || !VALID_KINDS.has(obs.kind)) continue;

        try {
            const normalizedHash = computeNormalizedHash(obs.lesson);
            const existing = findExistingNote(db, obs.skillId, tier, part, normalizedHash);
            if (existing) {
                bumpHitCount(db, obs.skillId, tier, part, normalizedHash);
                continue;
            }

            const id = insertSkillMemoryNote(db, {
                skillId: obs.skillId,
                resolvedPath: "",
                tier,
                skillSource: null,
                projectIdentity: part,
                originProject,
                sourceType: "historian",
                intent: obs.lesson,
                kind: obs.kind,
                delta: obs.lesson,
                normalizedHash,
                createdAt: Date.now(),
            });
            if (id !== null) written++;
        } catch (err) {
            // Best-effort: one bad observation must not block the publish, but
            // log it so silent persistence failures (schema drift, DB lock,
            // constraint violation) remain observable.
            log(
                `[skill-memory] promoteSkillObservations: skipped observation for skill "${obs.skillId}" — ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    return written;
}
