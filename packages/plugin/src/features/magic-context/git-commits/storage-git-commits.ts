/**
 * SQLite storage layer for indexed git commits.
 *
 * Separate from the memory embedding table because:
 *   - Identity is the SHA, not a memory row id
 *   - Lifecycle is managed by git, not by Dreamer review flow
 *   - FTS is also separate so commit queries never pollute memory BM25 ranks
 *
 * Eviction: when `max_commits` is exceeded for a project, we delete the oldest
 * commits by `committed_at ASC` (not by indexed_at — indexed_at can reorder
 * when we catch up after a long absence). ON DELETE CASCADE removes matching
 * embedding rows and FTS triggers remove matching FTS rows, so a single DELETE
 * cleans all three tables.
 */

import { log } from "../../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";
import type { GitCommit } from "./git-log-reader";

export interface StoredGitCommit extends GitCommit {
    projectPath: string;
    indexedAtMs: number;
}

interface GitCommitRow {
    sha: string;
    project_path: string;
    short_sha: string;
    message: string;
    author: string | null;
    committed_at: number;
    indexed_at: number;
}

const insertStatements = new WeakMap<Database, PreparedStatement>();
const existingShasStatements = new WeakMap<Database, PreparedStatement>();
const projectCountStatements = new WeakMap<Database, PreparedStatement>();
const evictStatements = new WeakMap<Database, PreparedStatement>();
const latestCommitTimeStatements = new WeakMap<Database, PreparedStatement>();

function getInsertStatement(db: Database): PreparedStatement {
    let stmt = insertStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `INSERT INTO git_commits (sha, project_path, short_sha, message, author, committed_at, indexed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(sha) DO UPDATE SET
                 project_path = excluded.project_path,
                 short_sha = excluded.short_sha,
                 message = excluded.message,
                 author = excluded.author,
                 committed_at = excluded.committed_at,
                 indexed_at = excluded.indexed_at
             WHERE git_commits.message != excluded.message`,
        );
        insertStatements.set(db, stmt);
    }
    return stmt;
}

function getExistingShasStatement(db: Database): PreparedStatement {
    let stmt = existingShasStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("SELECT sha FROM git_commits WHERE project_path = ?");
        existingShasStatements.set(db, stmt);
    }
    return stmt;
}

function getProjectCountStatement(db: Database): PreparedStatement {
    let stmt = projectCountStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("SELECT COUNT(*) AS count FROM git_commits WHERE project_path = ?");
        projectCountStatements.set(db, stmt);
    }
    return stmt;
}

function getLatestCommitTimeStatement(db: Database): PreparedStatement {
    let stmt = latestCommitTimeStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT MAX(committed_at) AS latest FROM git_commits WHERE project_path = ?",
        );
        latestCommitTimeStatements.set(db, stmt);
    }
    return stmt;
}

function getEvictStatement(db: Database): PreparedStatement {
    let stmt = evictStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `DELETE FROM git_commits
             WHERE sha IN (
                 SELECT sha FROM git_commits
                 WHERE project_path = ?
                 ORDER BY committed_at ASC
                 LIMIT ?
             )`,
        );
        evictStatements.set(db, stmt);
    }
    return stmt;
}

/** Insert or update a single commit. Use upsertCommits() for batch writes. */
export function upsertCommit(db: Database, projectPath: string, commit: GitCommit): void {
    getInsertStatement(db).run(
        commit.sha,
        projectPath,
        commit.shortSha,
        commit.message,
        commit.author,
        commit.committedAtMs,
        Date.now(),
    );
}

/** Batch upsert in a single transaction. Returns the count actually inserted
 *  or updated (skipped unchanged rows don't count). */
export function upsertCommits(
    db: Database,
    projectPath: string,
    commits: GitCommit[],
): { inserted: number; updated: number } {
    if (commits.length === 0) return { inserted: 0, updated: 0 };

    const existing = new Set<string>();
    for (const row of getExistingShasStatement(db).all(projectPath) as { sha: string }[]) {
        existing.add(row.sha);
    }

    let inserted = 0;
    let updated = 0;
    const now = Date.now();
    const insertStmt = getInsertStatement(db);

    db.transaction(() => {
        for (const commit of commits) {
            const result = insertStmt.run(
                commit.sha,
                projectPath,
                commit.shortSha,
                commit.message,
                commit.author,
                commit.committedAtMs,
                now,
            );
            // changes > 0 means row was inserted or updated (not skipped by WHERE clause)
            if (result.changes > 0) {
                if (existing.has(commit.sha)) {
                    updated++;
                } else {
                    inserted++;
                    existing.add(commit.sha);
                }
            }
        }
    })();

    return { inserted, updated };
}

/** Return the total count of indexed commits for a project. */
export function getCommitCount(db: Database, projectPath: string): number {
    const row = getProjectCountStatement(db).get(projectPath) as { count: number } | undefined;
    return row?.count ?? 0;
}

/** Return the most recent committed_at (ms) for this project, or null. */
export function getLatestIndexedCommitTimeMs(db: Database, projectPath: string): number | null {
    const row = getLatestCommitTimeStatement(db).get(projectPath) as
        | { latest: number | null }
        | undefined;
    return row?.latest ?? null;
}

/** Delete the oldest `excess` commits for a project. ON DELETE CASCADE cleans
 *  embedding rows; FTS triggers clean FTS rows. Returns rows deleted.
 *
 *  We compute the deletion count by diffing count-before and count-after because
 *  `stmt.run().changes` can be inflated by FTS5 trigger propagation (each
 *  `INSERT INTO ..._fts(_fts, ...) VALUES('delete', ...)` inside an AFTER DELETE
 *  trigger can add to the reported change count). */
export function evictOldestCommits(db: Database, projectPath: string, excess: number): number {
    if (excess <= 0) return 0;
    const before = getCommitCount(db, projectPath);
    getEvictStatement(db).run(projectPath, excess);
    const after = getCommitCount(db, projectPath);
    return Math.max(0, before - after);
}

/** Keep at most `maxCommits` rows for this project, evicting oldest overflow.
 *  Returns number of rows evicted. */
export function enforceProjectCap(db: Database, projectPath: string, maxCommits: number): number {
    if (maxCommits <= 0) return 0;
    const count = getCommitCount(db, projectPath);
    if (count <= maxCommits) return 0;

    const excess = count - maxCommits;
    const evicted = evictOldestCommits(db, projectPath, excess);
    if (evicted > 0) {
        log(
            `[git-commits] evicted ${evicted} oldest commits for project ${projectPath} (cap=${maxCommits}, was=${count})`,
        );
    }
    return evicted;
}

/** Return a commit by SHA (any project). For single-project reads, prefer the
 *  project-scoped variants. */
export function getCommitBySha(db: Database, sha: string): StoredGitCommit | null {
    const row = db.prepare("SELECT * FROM git_commits WHERE sha = ?").get(sha) as
        | GitCommitRow
        | undefined;
    return row ? rowToStoredCommit(row) : null;
}

function rowToStoredCommit(row: GitCommitRow): StoredGitCommit {
    return {
        sha: row.sha,
        projectPath: row.project_path,
        shortSha: row.short_sha,
        message: row.message,
        author: row.author,
        committedAtMs: row.committed_at,
        indexedAtMs: row.indexed_at,
    };
}
