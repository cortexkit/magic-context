import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";

interface EmbeddingRow {
    memoryId: number;
    embedding: Uint8Array | ArrayBuffer;
}

interface StoredModelIdRow {
    modelId: string | null;
}

const saveEmbeddingStatements = new WeakMap<Database, PreparedStatement>();
const loadAllEmbeddingsStatements = new WeakMap<Database, PreparedStatement>();
const deleteEmbeddingStatements = new WeakMap<Database, PreparedStatement>();
const getStoredModelIdStatements = new WeakMap<Database, PreparedStatement>();
const clearAllEmbeddingsStatements = new WeakMap<Database, PreparedStatement>();

function isEmbeddingBlob(value: unknown): value is Uint8Array | ArrayBuffer {
    return value instanceof Uint8Array || value instanceof ArrayBuffer;
}

function isEmbeddingRow(row: unknown): row is EmbeddingRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return typeof candidate.memoryId === "number" && isEmbeddingBlob(candidate.embedding);
}

function toFloat32Array(blob: Uint8Array | ArrayBuffer): Float32Array {
    if (blob instanceof Uint8Array) {
        const buffer = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
        return new Float32Array(buffer);
    }

    return new Float32Array(blob.slice(0));
}

function getSaveEmbeddingStatement(db: Database): PreparedStatement {
    let stmt = saveEmbeddingStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET embedding = excluded.embedding, model_id = excluded.model_id",
        );
        saveEmbeddingStatements.set(db, stmt);
    }
    return stmt;
}

function getLoadAllEmbeddingsStatement(db: Database): PreparedStatement {
    let stmt = loadAllEmbeddingsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT memory_embeddings.memory_id AS memoryId, memory_embeddings.embedding AS embedding FROM memory_embeddings INNER JOIN memories ON memories.id = memory_embeddings.memory_id WHERE memories.project_path = ? ORDER BY memory_embeddings.memory_id ASC",
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

export function saveEmbedding(
    db: Database,
    memoryId: number,
    embedding: Float32Array,
    modelId: string,
): void {
    const blob = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    getSaveEmbeddingStatement(db).run(memoryId, blob, modelId);
}

export function loadAllEmbeddings(db: Database, projectPath: string): Map<number, Float32Array> {
    const rows = getLoadAllEmbeddingsStatement(db).all(projectPath).filter(isEmbeddingRow);
    const embeddings = new Map<number, Float32Array>();

    for (const row of rows) {
        embeddings.set(row.memoryId, toFloat32Array(row.embedding));
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

export function clearEmbeddingsForProject(db: Database, projectPath: string): void {
    getClearAllEmbeddingsStatement(db).run(projectPath);
}
