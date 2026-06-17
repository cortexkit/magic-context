import type { Database } from "../../../shared/sqlite";

export interface SkillMemoryNote {
    id: number;
    skill_id: string;
    resolved_path: string;
    tier: "project" | "global";
    skill_source: "opencode-project" | "opencode-global" | "claude-skills" | "agents-skills" | null;
    project_identity: string;
    intent: string;
    intent_embedding: Buffer | null;
    delta_embedding: Buffer | null;
    embedding_model_version: string | null;
    kind: "gotcha" | "discovery" | "fix" | "workflow";
    delta: string;
    tags: string | null;
    hit_count: number;
    recall_count: number;
    pinned: number;
    normalized_hash: string;
    created_at: number;
    last_used_at: number | null;
}

export interface InsertSkillMemoryNoteArgs {
    skillId: string;
    resolvedPath: string;
    tier: "project" | "global";
    skillSource: "opencode-project" | "opencode-global" | "claude-skills" | "agents-skills" | null;
    projectIdentity: string;
    intent: string;
    kind: "gotcha" | "discovery" | "fix" | "workflow";
    delta: string;
    tags?: string[];
    intentEmbedding?: Buffer | null;
    deltaEmbedding?: Buffer | null;
    embeddingModelVersion?: string | null;
    normalizedHash: string;
    createdAt: number;
}

/**
 * Insert a new skill_memory note. Returns the new row id, or null if a
 * duplicate normalized_hash already exists for this (skill_id, tier, project_identity).
 * On duplicate, callers should call bumpHitCount instead.
 */
export function insertSkillMemoryNote(
    db: Database,
    args: InsertSkillMemoryNoteArgs,
): number | null {
    try {
        const result = db
            .prepare(
                `INSERT INTO skill_memory
                   (skill_id, resolved_path, tier, skill_source, project_identity,
                    intent, kind, delta, tags, intent_embedding, delta_embedding, embedding_model_version,
                    hit_count, pinned, normalized_hash, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
            )
            .run(
                args.skillId,
                args.resolvedPath,
                args.tier,
                args.skillSource ?? null,
                args.projectIdentity,
                args.intent,
                args.kind,
                args.delta,
                args.tags ? JSON.stringify(args.tags) : null,
                args.intentEmbedding ?? null,
                args.deltaEmbedding ?? null,
                args.embeddingModelVersion ?? null,
                args.normalizedHash,
                args.createdAt,
            );
        return result.lastInsertRowid as number;
    } catch (err: unknown) {
        // UNIQUE constraint violation = duplicate
        if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
            return null;
        }
        throw err;
    }
}

/**
 * Retrieve notes for flat recall (rungs 2 + 4).
 * Ordered by normalized additive recency + hit_count score (pinned notes first).
 *
 * Scoring: recency_norm + hit_norm where:
 *   recency_norm = (ts - min_ts) / NULLIF(max_ts - min_ts, 0)  — 0..1 range (0 when all timestamps equal)
 *   hit_norm     = hit_count / NULLIF(MAX(hit_count) OVER (), 0) — 0..1 range (0 when all hit_counts 0)
 * Additive (not multiplicative) so hit_count is not swamped by timestamp scale.
 *
 * NOTE: The window-function form requires SQLite ≥ 3.25 (2018). Bun ships SQLite ≥ 3.39.
 * If the window form causes issues, fall back to the simpler:
 *   (COALESCE(last_used_at, created_at) / 1000000.0) + (hit_count * 0.1) DESC
 * which is less precise but avoids the window function.
 *
 * TODO: add an ordering test that inserts notes with known recency/hit_count values
 * and asserts the returned order matches the expected ranking.
 */
export function getSkillMemoryNotes(
    db: Database,
    skillId: string,
    tier: "project" | "global",
    projectIdentity: string,
    limit: number,
): SkillMemoryNote[] {
    return db
        .prepare(
            `SELECT *
             FROM skill_memory
             WHERE skill_id = ? AND tier = ? AND project_identity = ?
             ORDER BY
                pinned DESC,
               (
                 COALESCE(
                   (COALESCE(last_used_at, created_at) - MIN(COALESCE(last_used_at, created_at)) OVER ()) * 1.0
                   / NULLIF(MAX(COALESCE(last_used_at, created_at)) OVER () - MIN(COALESCE(last_used_at, created_at)) OVER (), 0),
                   0.0
                 )
                 +
                 COALESCE(
                   hit_count * 1.0 / NULLIF(MAX(hit_count) OVER (), 0),
                   0.0
                 )
               ) DESC,
               created_at DESC
             LIMIT ?`,
        )
        .all(skillId, tier, projectIdentity, limit) as SkillMemoryNote[];
}

/**
 * Bump hit_count and update last_used_at for a note identified by its
 * normalized_hash within a (skill_id, tier, project_identity) scope.
 */
export function bumpHitCount(
    db: Database,
    skillId: string,
    tier: "project" | "global",
    projectIdentity: string,
    normalizedHash: string,
): void {
    db.prepare(
        `UPDATE skill_memory
         SET hit_count = hit_count + 1, last_used_at = ?
         WHERE skill_id = ? AND tier = ? AND project_identity = ? AND normalized_hash = ?`,
    ).run(Date.now(), skillId, tier, projectIdentity, normalizedHash);
}

/**
 * Bump hit_count + last_used_at for a note identified by id (used by cosine dedup, which has no hash).
 */
export function bumpHitCountById(db: Database, id: number): void {
    db.prepare(
        `UPDATE skill_memory SET hit_count = hit_count + 1, last_used_at = ? WHERE id = ?`,
    ).run(Date.now(), id);
}

/**
 * Bump recall_count for notes actually surfaced in a recall block (read-side usage).
 * Distinct from hit_count (write-side re-record salience): recall_count answers
 * "which notes are recalled most". Deliberately does NOT touch last_used_at — the
 * ranking's recency term must reflect when a lesson was learned/re-recorded, not when
 * it was surfaced, else surfaced notes would always win recency and starve new notes.
 * Best-effort, no-throw: a counter write must never break recall.
 */
export function bumpRecallCountByIds(db: Database, ids: number[]): void {
    if (ids.length === 0) return;
    try {
        const placeholders = ids.map(() => "?").join(",");
        db.prepare(
            `UPDATE skill_memory SET recall_count = recall_count + 1 WHERE id IN (${placeholders})`,
        ).run(...ids);
    } catch {
        // never let usage-tracking break a recall
    }
}

/**
 * Check if a note with the given normalized_hash already exists.
 * Returns the existing note's id and hit_count, or null.
 */
export function findExistingNote(
    db: Database,
    skillId: string,
    tier: "project" | "global",
    projectIdentity: string,
    normalizedHash: string,
): { id: number; hit_count: number } | null {
    return (
        (db
            .prepare(
                `SELECT id, hit_count FROM skill_memory
                 WHERE skill_id = ? AND tier = ? AND project_identity = ? AND normalized_hash = ?`,
            )
            .get(skillId, tier, projectIdentity, normalizedHash) as {
            id: number;
            hit_count: number;
        } | null) ?? null
    );
}

/**
 * Aggregate stats for the skill_memory table scoped to a project identity.
 * Used by the ctx-status / TUI status dialog (mirrors the external-memory
 * status surface). Sync, single query; safe to call on every status poll.
 */
export function getDedupCandidates(
    db: Database,
    skillId: string,
    tier: "project" | "global",
    projectIdentity: string,
    limit: number,
): Array<Pick<SkillMemoryNote, "id" | "delta_embedding" | "embedding_model_version">> {
    return db
        .prepare(
            `SELECT id, delta_embedding, embedding_model_version FROM skill_memory
         WHERE skill_id=? AND tier=? AND project_identity=?
         ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT ?`,
        )
        .all(skillId, tier, projectIdentity, limit) as Array<
        Pick<SkillMemoryNote, "id" | "delta_embedding" | "embedding_model_version">
    >;
}

export function getRankingCandidates(
    db: Database,
    skillId: string,
    tier: "project" | "global",
    projectIdentity: string,
    limit: number,
): SkillMemoryNote[] {
    return db
        .prepare(
            `SELECT * FROM skill_memory
         WHERE skill_id=? AND tier=? AND project_identity=?
         ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT ?`,
        )
        .all(skillId, tier, projectIdentity, limit) as SkillMemoryNote[];
}

export function searchSkillMemoryFts(
    db: Database,
    skillId: string,
    tier: "project" | "global",
    projectIdentity: string,
    matchQuery: string,
    limit: number,
): SkillMemoryNote[] {
    return db
        .prepare(
            `SELECT m.* FROM skill_memory_fts f
         JOIN skill_memory m ON m.id = f.rowid
         WHERE skill_memory_fts MATCH ?
           AND m.skill_id=? AND m.tier=? AND m.project_identity=?
         ORDER BY bm25(skill_memory_fts) ASC, COALESCE(m.last_used_at, m.created_at) DESC
         LIMIT ?`,
        )
        .all(matchQuery, skillId, tier, projectIdentity, limit) as SkillMemoryNote[];
}

export function getPinnedNotes(
    db: Database,
    skillId: string,
    tier: "project" | "global",
    projectIdentity: string,
): SkillMemoryNote[] {
    return db
        .prepare(
            `SELECT * FROM skill_memory
         WHERE skill_id=? AND tier=? AND project_identity=? AND pinned=1
         ORDER BY COALESCE(last_used_at, created_at) DESC`,
        )
        .all(skillId, tier, projectIdentity) as SkillMemoryNote[];
}

export function getSkillMemoryStats(
    db: Database,
    projectIdentity: string,
): { totalNotes: number; skillsWithNotes: number; pinnedNotes: number } {
    const row = db
        .prepare(
            `SELECT
                COUNT(*) AS total,
                COUNT(DISTINCT skill_id) AS skills,
                COALESCE(SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END), 0) AS pinned
             FROM skill_memory
             WHERE project_identity = ?`,
        )
        .get(projectIdentity) as { total: number; skills: number; pinned: number } | undefined;
    return {
        totalNotes: Number(row?.total ?? 0),
        skillsWithNotes: Number(row?.skills ?? 0),
        pinnedNotes: Number(row?.pinned ?? 0),
    };
}
