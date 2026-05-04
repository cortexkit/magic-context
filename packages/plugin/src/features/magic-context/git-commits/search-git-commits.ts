/**
 * Hybrid FTS + semantic search for indexed git commits.
 *
 * Returns raw scored matches; the caller (unifiedSearch) slots these into
 * the existing merged ranking with source boosts.
 */

import { log } from "../../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";
import { cosineSimilarity } from "../memory/cosine-similarity";
import { sanitizeFtsQuery } from "../memory/storage-memory-fts";
import { loadProjectCommitEmbeddings } from "./storage-git-commit-embeddings";
import type { StoredGitCommit } from "./storage-git-commits";

const ftsStatements = new WeakMap<Database, PreparedStatement>();
const ftsPlainStatements = new WeakMap<Database, PreparedStatement>();
const getBySHAStatements = new WeakMap<Database, PreparedStatement>();

interface CommitRow {
    sha: string;
    project_path: string;
    short_sha: string;
    message: string;
    author: string | null;
    committed_at: number;
    indexed_at: number;
}

function rowToCommit(row: CommitRow): StoredGitCommit {
    return {
        sha: row.sha,
        shortSha: row.short_sha,
        projectPath: row.project_path,
        message: row.message,
        author: row.author,
        committedAtMs: row.committed_at,
        indexedAtMs: row.indexed_at,
    };
}

function getFtsStatement(db: Database): PreparedStatement {
    let stmt = ftsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT c.sha AS sha, c.project_path AS project_path, c.short_sha AS short_sha,
                    c.message AS message, c.author AS author,
                    c.committed_at AS committed_at, c.indexed_at AS indexed_at
             FROM git_commits_fts
             INNER JOIN git_commits c ON c.sha = git_commits_fts.sha
             WHERE c.project_path = ? AND git_commits_fts MATCH ?
             ORDER BY bm25(git_commits_fts) LIMIT ?`,
        );
        ftsStatements.set(db, stmt);
    }
    return stmt;
}

function getLikeFallbackStatement(db: Database): PreparedStatement {
    let stmt = ftsPlainStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT sha, project_path, short_sha, message, author, committed_at, indexed_at
             FROM git_commits
             WHERE project_path = ? AND lower(message) LIKE '%' || lower(?) || '%'
             ORDER BY committed_at DESC LIMIT ?`,
        );
        ftsPlainStatements.set(db, stmt);
    }
    return stmt;
}

function getBySHAStatement(db: Database): PreparedStatement {
    let stmt = getBySHAStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT sha, project_path, short_sha, message, author, committed_at, indexed_at
             FROM git_commits WHERE sha = ?`,
        );
        getBySHAStatements.set(db, stmt);
    }
    return stmt;
}

export interface GitCommitSearchHit {
    commit: StoredGitCommit;
    /** 0..1 combined score. */
    score: number;
    matchType: "semantic" | "fts" | "hybrid";
}

export interface SearchGitCommitsOptions {
    limit: number;
    /** Raw semantic score weight. Default 0.7. */
    semanticWeight?: number;
    /** Raw FTS score weight. Default 0.3. */
    ftsWeight?: number;
    /** When semantic OR FTS has only one signal, scale the score by this
     *  penalty to favor hybrid matches. Default 0.8. */
    singleSourcePenalty?: number;
    /** Pre-computed query embedding. When omitted, we skip the semantic pass. */
    queryEmbedding?: Float32Array | null;
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
}

/**
 * Return top-K commits matching `query` for `projectPath`, combining FTS
 * and semantic ranks. Falls back to LIKE when FTS fails (e.g. short queries).
 */
export function searchGitCommitsSync(
    db: Database,
    projectPath: string,
    query: string,
    options: SearchGitCommitsOptions,
): GitCommitSearchHit[] {
    const trimmed = query.trim();
    if (trimmed.length === 0 || options.limit <= 0) return [];

    const semanticWeight = options.semanticWeight ?? 0.7;
    const ftsWeight = options.ftsWeight ?? 0.3;
    const singleSourcePenalty = options.singleSourcePenalty ?? 0.8;
    const fetchLimit = Math.max(options.limit * 3, 30);

    // ---- FTS pass -------------------------------------------------------
    const ftsCandidates: StoredGitCommit[] = [];
    const sanitized = sanitizeFtsQuery(trimmed);
    if (sanitized.length > 0) {
        try {
            for (const row of getFtsStatement(db).all(
                projectPath,
                sanitized,
                fetchLimit,
            ) as CommitRow[]) {
                ftsCandidates.push(rowToCommit(row));
            }
        } catch (error) {
            log(
                `[git-commits] FTS query failed for "${trimmed}": ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    // LIKE fallback when FTS returned nothing (short tokens, exact-substring queries)
    if (ftsCandidates.length === 0) {
        for (const row of getLikeFallbackStatement(db).all(
            projectPath,
            trimmed,
            fetchLimit,
        ) as CommitRow[]) {
            ftsCandidates.push(rowToCommit(row));
        }
    }

    const ftsScores = new Map<string, number>();
    ftsCandidates.forEach((commit, rank) => {
        ftsScores.set(commit.sha, 1 / (rank + 1));
    });

    // ---- Semantic pass --------------------------------------------------
    const semanticScores = new Map<string, number>();
    if (options.queryEmbedding) {
        const embeddings = loadProjectCommitEmbeddings(db, projectPath);
        for (const [sha, embedding] of embeddings.entries()) {
            const similarity = clamp01(cosineSimilarity(options.queryEmbedding, embedding));
            if (similarity > 0) {
                semanticScores.set(sha, similarity);
            }
        }
    }

    // ---- Merge + rank ---------------------------------------------------
    const bySha = new Map<string, StoredGitCommit>();
    for (const commit of ftsCandidates) bySha.set(commit.sha, commit);

    const getCommitStmt = getBySHAStatement(db);
    // Pull semantic-only commits (may or may not be in ftsCandidates).
    for (const sha of semanticScores.keys()) {
        if (bySha.has(sha)) continue;
        const row = getCommitStmt.get(sha) as CommitRow | undefined;
        if (row && row.project_path === projectPath) {
            bySha.set(sha, rowToCommit(row));
        }
    }

    const results: GitCommitSearchHit[] = [];
    for (const [sha, commit] of bySha.entries()) {
        const sem = semanticScores.get(sha);
        const fts = ftsScores.get(sha);
        let score = 0;
        let matchType: GitCommitSearchHit["matchType"] = "fts";

        if (sem !== undefined && fts !== undefined) {
            score = semanticWeight * sem + ftsWeight * fts;
            matchType = "hybrid";
        } else if (sem !== undefined) {
            score = sem * singleSourcePenalty;
            matchType = "semantic";
        } else if (fts !== undefined) {
            score = fts * singleSourcePenalty;
            matchType = "fts";
        }

        if (score <= 0) continue;
        results.push({ commit, score, matchType });
    }

    results.sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        // Newer commits win ties
        return right.commit.committedAtMs - left.commit.committedAtMs;
    });

    return results.slice(0, options.limit);
}
