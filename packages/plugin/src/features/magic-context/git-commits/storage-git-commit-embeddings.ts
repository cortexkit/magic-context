/**
 * Embedding storage for git commits.
 *
 * Mirrors the memory-embedding storage layout but keyed by commit SHA rather
 * than memory id. Embeddings are byte-equivalent to memory embeddings (Float32
 * serialized via Float32Array.buffer), so the same cosine-similarity helpers
 * apply without conversion.
 */

import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";

interface CommitEmbeddingRow {
    sha: string;
    embedding: Uint8Array;
    model_id: string;
}

interface UnembeddedRow {
    sha: string;
    message: string;
}

const saveStatements = new WeakMap<Database, PreparedStatement>();
const loadProjectStatements = new WeakMap<Database, PreparedStatement>();
const loadUnembeddedStatements = new WeakMap<Database, PreparedStatement>();
const countEmbeddedStatements = new WeakMap<Database, PreparedStatement>();
const clearProjectStatements = new WeakMap<Database, PreparedStatement>();

function getSaveStatement(db: Database): PreparedStatement {
    let stmt = saveStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `INSERT INTO git_commit_embeddings (sha, embedding, model_id, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(sha) DO UPDATE SET
                 embedding = excluded.embedding,
                 model_id = excluded.model_id,
                 created_at = excluded.created_at`,
        );
        saveStatements.set(db, stmt);
    }
    return stmt;
}

function getLoadProjectStatement(db: Database): PreparedStatement {
    let stmt = loadProjectStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT e.sha AS sha, e.embedding AS embedding, e.model_id AS model_id
             FROM git_commit_embeddings e
             JOIN git_commits c ON c.sha = e.sha
             WHERE c.project_path = ?`,
        );
        loadProjectStatements.set(db, stmt);
    }
    return stmt;
}

function getLoadUnembeddedStatement(db: Database): PreparedStatement {
    let stmt = loadUnembeddedStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT c.sha AS sha, c.message AS message
             FROM git_commits c
             LEFT JOIN git_commit_embeddings e ON c.sha = e.sha
             WHERE c.project_path = ? AND e.sha IS NULL
             ORDER BY c.committed_at DESC
             LIMIT ?`,
        );
        loadUnembeddedStatements.set(db, stmt);
    }
    return stmt;
}

function getCountEmbeddedStatement(db: Database): PreparedStatement {
    let stmt = countEmbeddedStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT COUNT(*) AS count FROM git_commit_embeddings e
             JOIN git_commits c ON c.sha = e.sha WHERE c.project_path = ?`,
        );
        countEmbeddedStatements.set(db, stmt);
    }
    return stmt;
}

function getClearProjectStatement(db: Database): PreparedStatement {
    let stmt = clearProjectStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `DELETE FROM git_commit_embeddings
             WHERE sha IN (SELECT sha FROM git_commits WHERE project_path = ?)`,
        );
        clearProjectStatements.set(db, stmt);
    }
    return stmt;
}

export function saveCommitEmbedding(
    db: Database,
    sha: string,
    embedding: Float32Array,
    modelId: string,
): void {
    const bytes = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    getSaveStatement(db).run(sha, bytes, modelId, Date.now());
}

export function loadProjectCommitEmbeddings(
    db: Database,
    projectPath: string,
): Map<string, Float32Array> {
    const rows = getLoadProjectStatement(db).all(projectPath) as CommitEmbeddingRow[];
    const map = new Map<string, Float32Array>();
    for (const row of rows) {
        const buffer = row.embedding.buffer.slice(
            row.embedding.byteOffset,
            row.embedding.byteOffset + row.embedding.byteLength,
        );
        map.set(row.sha, new Float32Array(buffer));
    }
    return map;
}

export function loadUnembeddedCommits(
    db: Database,
    projectPath: string,
    limit: number,
): Array<{ sha: string; message: string }> {
    return getLoadUnembeddedStatement(db).all(projectPath, limit) as UnembeddedRow[];
}

export function countEmbeddedCommits(db: Database, projectPath: string): number {
    const row = getCountEmbeddedStatement(db).get(projectPath) as { count: number } | undefined;
    return row?.count ?? 0;
}

export function clearProjectCommitEmbeddings(db: Database, projectPath: string): number {
    return getClearProjectStatement(db).run(projectPath).changes;
}
