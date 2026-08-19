import type { Database } from "../../../shared/sqlite";
import { mergeMemoryEpisodeEvidence } from "./storage-memory";
import type { MemoryStatus } from "./types";

/**
 * Memory relocation primitives shared by the v22 dir-identity backfill and the
 * `doctor migrate-session` command (re-homing a session to a different project).
 *
 * All operations are collision-aware against UNIQUE(project_path, category,
 * normalized_hash): the target identity may already hold an equivalent memory,
 * and a blind write there would abort the surrounding transaction. MUST run
 * inside a transaction.
 */

export interface RelocateMemorySelection {
    /** Status set to operate on. Archived memories are deliberately excluded by
     *  default — they are suppressed history, not injectable knowledge. */
    statuses?: MemoryStatus[];
    /** When set, restrict to memories whose `source_session_id` matches (the
     *  "only memories originated from this session" option). */
    sourceSessionId?: string;
}

const DEFAULT_STATUSES: MemoryStatus[] = ["active", "permanent"];

/**
 * Resolve the memory ids under `fromProjectPath` that a relocation should act
 * on, honoring the status filter and the optional originator-session filter.
 */
export function selectRelocatableMemoryIds(
    db: Database,
    fromProjectPath: string,
    selection: RelocateMemorySelection = {},
): number[] {
    const statuses = selection.statuses ?? DEFAULT_STATUSES;
    if (statuses.length === 0) return [];
    const statusPlaceholders = statuses.map(() => "?").join(", ");
    const params: Array<string> = [fromProjectPath, ...statuses];
    let sql = `SELECT id FROM memories WHERE project_path = ? AND status IN (${statusPlaceholders})`;
    if (selection.sourceSessionId !== undefined) {
        sql += " AND source_session_id = ?";
        params.push(selection.sourceSessionId);
    }
    sql += " ORDER BY id ASC";
    const rows = db.prepare(sql).all(...params) as Array<{ id: number }>;
    return rows.map((row) => row.id);
}

/**
 * Collision-aware single-row rekey. If the target identity already holds an
 * equivalent memory (same category + normalized_hash), merge into it (keep the
 * larger seen_count, delete the source — embedding FK-cascades) instead of
 * aborting the transaction on the UNIQUE violation; otherwise do the guarded
 * UPDATE. Returns true if the row was rekeyed or merged. MUST run inside a
 * transaction.
 */
export function rekeyMemoryRowWithCollisionMerge(
    db: Database,
    rowId: number,
    fromProjectPath: string,
    toIdentity: string,
): boolean {
    const row = db
        .prepare("SELECT category, normalized_hash, seen_count FROM memories WHERE id = ?")
        .get(rowId) as
        | { category: string; normalized_hash: string; seen_count: number }
        | undefined;
    if (!row) return false;

    const collision = db
        .prepare(
            `SELECT id, seen_count FROM memories
             WHERE project_path = ? AND category = ? AND normalized_hash = ?
             LIMIT 1`,
        )
        .get(toIdentity, row.category, row.normalized_hash) as
        | { id: number; seen_count: number }
        | undefined;

    if (collision && collision.id !== rowId) {
        const hasEvidence = db
            .prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_evidence'",
            )
            .get();
        if (hasEvidence) {
            const mergedSeenCount = mergeMemoryEpisodeEvidence(db, collision.id, [rowId]);
            db.prepare(
                "UPDATE memories SET seen_count = MAX(COALESCE(seen_count, 1), ?) WHERE id = ?",
            ).run(mergedSeenCount ?? row.seen_count ?? 1, collision.id);
        } else {
            db.prepare(
                "UPDATE memories SET seen_count = MAX(COALESCE(seen_count, 1), ?) WHERE id = ?",
            ).run(row.seen_count ?? 1, collision.id);
        }
        // Preserve an embedding on the surviving target BEFORE the source row's
        // embedding FK-cascades away on DELETE (memory_embeddings.memory_id
        // REFERENCES memories(id) ON DELETE CASCADE). INSERT OR IGNORE keeps the
        // target's existing embedding when it has one; otherwise it adopts the
        // source's — so a merged memory never ends up with NO vector (the two are
        // equivalent: same category + normalized_hash, so either vector is valid).
        db.prepare(
            `INSERT OR IGNORE INTO memory_embeddings (memory_id, embedding, model_id)
             SELECT ?, embedding, model_id FROM memory_embeddings WHERE memory_id = ?`,
        ).run(collision.id, rowId);
        db.prepare("DELETE FROM memories WHERE id = ?").run(rowId);
        return true;
    }

    const result = db
        .prepare("UPDATE memories SET project_path = ? WHERE id = ? AND project_path = ?")
        .run(toIdentity, rowId, fromProjectPath) as { changes?: number };
    return (result.changes ?? 0) > 0;
}

export interface RelocateResult {
    /** Rows rekeyed/inserted under the target identity. */
    relocated: number;
    /** Rows merged into a pre-existing equivalent at the target (move only). */
    merged: number;
    /** Rows skipped because an equivalent already existed at the target (copy only). */
    skipped: number;
}

/**
 * MOVE a set of memory ids from `fromProjectPath` to `toIdentity`. The source
 * project loses them. Collision-safe (merge into an existing equivalent at the
 * target). Embeddings follow automatically (memory_id is unchanged on a rekey,
 * FK-cascade on a merge-delete). MUST run inside a transaction.
 */
export function moveMemoriesToProject(
    db: Database,
    ids: number[],
    fromProjectPath: string,
    toIdentity: string,
): RelocateResult {
    let relocated = 0;
    let merged = 0;
    for (const id of ids) {
        // Detect the merge branch by checking for a pre-existing equivalent
        // before the rekey, so we can report move-vs-merge accurately.
        const row = db
            .prepare("SELECT category, normalized_hash FROM memories WHERE id = ?")
            .get(id) as { category: string; normalized_hash: string } | undefined;
        if (!row) continue;
        const collision = db
            .prepare(
                `SELECT id FROM memories WHERE project_path = ? AND category = ? AND normalized_hash = ? LIMIT 1`,
            )
            .get(toIdentity, row.category, row.normalized_hash) as { id: number } | undefined;
        const changed = rekeyMemoryRowWithCollisionMerge(db, id, fromProjectPath, toIdentity);
        if (!changed) continue;
        if (collision && collision.id !== id) merged += 1;
        else relocated += 1;
    }
    return { relocated, merged, skipped: 0 };
}

const memoryCopyColumnsCache = new WeakMap<Database, string[]>();
function getMemoryCopyColumns(db: Database): string[] {
    const cached = memoryCopyColumnsCache.get(db);
    if (cached) return cached;
    const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name?: string }>;
    // Every column EXCEPT the autoincrement id — the copy gets a fresh id.
    const names = columns
        .map((c) => c.name)
        .filter((n): n is string => typeof n === "string" && n !== "id");
    memoryCopyColumnsCache.set(db, names);
    return names;
}

/**
 * COPY a set of memory ids under `toIdentity`, leaving the source rows intact.
 * Each copy gets a fresh id; its embedding (if any) is duplicated. Collision-safe
 * via INSERT OR IGNORE against the UNIQUE constraint — a row already present at
 * the target is skipped (no duplicate). `project_path` is overridden to the
 * target; all other columns (including source_session_id and timestamps) are
 * preserved for provenance. MUST run inside a transaction.
 */
export function copyMemoriesToProject(
    db: Database,
    ids: number[],
    toIdentity: string,
): RelocateResult {
    const columns = getMemoryCopyColumns(db);
    const selectExprs = columns.map((c) => (c === "project_path" ? "? AS project_path" : c));
    const insertSql = `INSERT OR IGNORE INTO memories (${columns.join(", ")})
        SELECT ${selectExprs.join(", ")} FROM memories WHERE id = ?`;
    const insertStmt = db.prepare(insertSql);
    const copyEmbeddingStmt = db.prepare(
        `INSERT OR IGNORE INTO memory_embeddings (memory_id, embedding, model_id)
         SELECT ?, embedding, model_id FROM memory_embeddings WHERE memory_id = ?`,
    );
    const hasEvidence = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_evidence'")
        .get();
    const copyEvidenceStmt = hasEvidence
        ? db.prepare(
              `INSERT OR IGNORE INTO memory_evidence (
                  memory_id, content_hash, source_session_id, source_message_id, source_type, observed_at
              )
              SELECT ?, content_hash, source_session_id, source_message_id, source_type, observed_at
                FROM memory_evidence WHERE memory_id = ?`,
          )
        : null;
    let relocated = 0;
    let skipped = 0;
    for (const id of ids) {
        const source = db
            .prepare("SELECT category, normalized_hash, seen_count FROM memories WHERE id = ?")
            .get(id) as
            | { category?: string; normalized_hash?: string; seen_count?: number }
            | undefined;
        const collision =
            source?.category && source.normalized_hash
                ? (db
                      .prepare(
                          "SELECT id FROM memories WHERE project_path = ? AND category = ? AND normalized_hash = ? LIMIT 1",
                      )
                      .get(toIdentity, source.category, source.normalized_hash) as
                      | { id?: number }
                      | undefined)
                : undefined;
        if (collision?.id !== undefined) {
            copyEvidenceStmt?.run(collision.id, id);
            if (copyEvidenceStmt) {
                db.prepare(
                    `UPDATE memories SET seen_count = MAX(
                        COALESCE(seen_count, 1),
                        ?,
                        (SELECT COUNT(DISTINCT source_session_id) FROM memory_evidence WHERE memory_id = ?)
                    ) WHERE id = ?`,
                ).run(source?.seen_count ?? 1, collision.id, collision.id);
            }
            skipped += 1;
            continue;
        }
        const result = insertStmt.run(toIdentity, id) as {
            changes?: number;
            lastInsertRowid?: number | bigint;
        };
        if ((result.changes ?? 0) > 0) {
            relocated += 1;
            copyEmbeddingStmt.run(Number(result.lastInsertRowid), id);
            copyEvidenceStmt?.run(Number(result.lastInsertRowid), id);
        } else {
            skipped += 1;
        }
    }
    return { relocated, merged: 0, skipped };
}
