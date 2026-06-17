import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";

interface EmbeddingRow {
    memoryId: number;
    embedding: Uint8Array | ArrayBuffer;
    modelId: string | null;
}

export interface StoredMemoryEmbedding {
    embedding: Float32Array;
    modelId: string | null;
}

interface StoredModelIdRow {
    modelId: string | null;
}

const saveEmbeddingStatements = new WeakMap<Database, PreparedStatement>();
const saveEmbeddingIfHashMatchesStatements = new WeakMap<Database, PreparedStatement>();
const loadAllEmbeddingsStatements = new WeakMap<Database, PreparedStatement>();
const deleteEmbeddingStatements = new WeakMap<Database, PreparedStatement>();
const getStoredModelIdStatements = new WeakMap<Database, PreparedStatement>();
const clearAllEmbeddingsStatements = new WeakMap<Database, PreparedStatement>();
const clearModelEmbeddingsStatements = new WeakMap<Database, PreparedStatement>();

function isEmbeddingBlob(value: unknown): value is Uint8Array | ArrayBuffer {
    return value instanceof Uint8Array || value instanceof ArrayBuffer;
}

function isEmbeddingRow(row: unknown): row is EmbeddingRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.memoryId === "number" &&
        isEmbeddingBlob(candidate.embedding) &&
        (candidate.modelId === null || typeof candidate.modelId === "string")
    );
}

export function toFloat32Array(blob: Uint8Array | ArrayBuffer): Float32Array {
    if (blob instanceof Uint8Array) {
        const buffer = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
        return new Float32Array(buffer);
    }

    return new Float32Array(blob.slice(0));
}

/** Serialize a Float32Array to a SQLite BLOB (Buffer). Canonical — reuse, do not duplicate. */
export function float32ArrayToBlob(vector: Float32Array): Buffer {
    return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function getSaveEmbeddingStatement(db: Database): PreparedStatement {
    let stmt = saveEmbeddingStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?, ?, ?) ON CONFLICT(memory_id, model_id) DO UPDATE SET embedding = excluded.embedding",
        );
        saveEmbeddingStatements.set(db, stmt);
    }
    return stmt;
}

function getSaveEmbeddingIfHashMatchesStatement(db: Database): PreparedStatement {
    let stmt = saveEmbeddingIfHashMatchesStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO memory_embeddings (memory_id, embedding, model_id) SELECT ?, ?, ? FROM memories WHERE id = ? AND normalized_hash = ? ON CONFLICT(memory_id, model_id) DO UPDATE SET embedding = excluded.embedding",
        );
        saveEmbeddingIfHashMatchesStatements.set(db, stmt);
    }
    return stmt;
}

function getLoadAllEmbeddingsStatement(db: Database): PreparedStatement {
    let stmt = loadAllEmbeddingsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT memory_embeddings.memory_id AS memoryId, memory_embeddings.embedding AS embedding, memory_embeddings.model_id AS modelId FROM memory_embeddings INNER JOIN memories ON memories.id = memory_embeddings.memory_id WHERE memories.project_path = ? AND memory_embeddings.model_id = ? ORDER BY memory_embeddings.memory_id ASC",
        );
        loadAllEmbeddingsStatements.set(db, stmt);
    }
    return stmt;
}

function getDeleteEmbeddingStatement(db: Database): PreparedStatement {
    let stmt = deleteEmbeddingStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?");
        deleteEmbeddingStatements.set(db, stmt);
    }
    return stmt;
}

function getStoredModelIdStatement(db: Database): PreparedStatement {
    let stmt = getStoredModelIdStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT memory_embeddings.model_id AS modelId FROM memory_embeddings INNER JOIN memories ON memories.id = memory_embeddings.memory_id WHERE memories.project_path = ? AND memory_embeddings.model_id IS NOT NULL LIMIT 1",
        );
        getStoredModelIdStatements.set(db, stmt);
    }
    return stmt;
}

function getClearAllEmbeddingsStatement(db: Database): PreparedStatement {
    let stmt = clearAllEmbeddingsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "DELETE FROM memory_embeddings WHERE memory_id IN (SELECT id FROM memories WHERE project_path = ?)",
        );
        clearAllEmbeddingsStatements.set(db, stmt);
    }
    return stmt;
}

function getClearModelEmbeddingsStatement(db: Database): PreparedStatement {
    let stmt = clearModelEmbeddingsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "DELETE FROM memory_embeddings WHERE model_id = ? AND memory_id IN (SELECT id FROM memories WHERE project_path = ?)",
        );
        clearModelEmbeddingsStatements.set(db, stmt);
    }
    return stmt;
}

export function saveEmbedding(
    db: Database,
    memoryId: number,
    embedding: Float32Array,
    modelId: string,
): void {
    const blob = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    getSaveEmbeddingStatement(db).run(memoryId, blob, modelId);
}

/** Save an embedding only if the memory row still has the same normalized hash
 *  we embedded. If the content changed while the provider call was in flight,
 *  the stale vector is discarded instead of resurrecting an out-of-date row. */
export function saveEmbeddingIfHashMatches(
    db: Database,
    memoryId: number,
    embedding: Float32Array,
    modelId: string,
    normalizedHash: string,
): boolean {
    const blob = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    return (
        getSaveEmbeddingIfHashMatchesStatement(db).run(
            memoryId,
            blob,
            modelId,
            memoryId,
            normalizedHash,
        ).changes > 0
    );
}

export function loadAllEmbeddings(
    db: Database,
    projectPath: string,
    modelId: string,
): Map<number, StoredMemoryEmbedding> {
    const rows = getLoadAllEmbeddingsStatement(db).all(projectPath, modelId).filter(isEmbeddingRow);
    const embeddings = new Map<number, StoredMemoryEmbedding>();

    for (const row of rows) {
        embeddings.set(row.memoryId, {
            embedding: toFloat32Array(row.embedding),
            modelId: row.modelId,
        });
    }

    return embeddings;
}

export function deleteEmbedding(db: Database, memoryId: number): void {
    getDeleteEmbeddingStatement(db).run(memoryId);
}

export function getStoredModelId(db: Database, projectPath: string): string | null {
    const row = getStoredModelIdStatement(db).get(projectPath) as StoredModelIdRow | undefined;
    return typeof row?.modelId === "string" ? row.modelId : null;
}

export function clearEmbeddingsForProject(
    db: Database,
    projectPath: string,
    modelId?: string,
): number {
    if (modelId) {
        return getClearModelEmbeddingsStatement(db).run(modelId, projectPath).changes;
    }
    return getClearAllEmbeddingsStatement(db).run(projectPath).changes;
}

/** Active memories for a project, and how many are embedded under `modelId`.
 *  Drives the `/ctx-embed` status `embedded / total` memory line. */
export function getMemoryEmbedCoverage(
    db: Database,
    projectPath: string,
    modelId: string,
): { embedded: number; total: number } {
    const row = db
        .prepare(
            `SELECT
               COUNT(*) AS total,
               SUM(CASE WHEN EXISTS (
                   SELECT 1 FROM memory_embeddings e
                   WHERE e.memory_id = m.id AND e.model_id = ?
               ) THEN 1 ELSE 0 END) AS embedded
             FROM memories m
             WHERE m.project_path = ? AND m.status = 'active'`,
        )
        .get(modelId, projectPath) as { total?: number; embedded?: number } | undefined;
    return {
        total: typeof row?.total === "number" ? row.total : 0,
        embedded: typeof row?.embedded === "number" ? row.embedded : 0,
    };
}
