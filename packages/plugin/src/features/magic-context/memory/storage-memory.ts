import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";
import { invalidateMemory, invalidateProject } from "./embedding-cache";
import { computeNormalizedHash } from "./normalize-hash";
import type {
    Memory,
    MemoryCategory,
    MemoryInput,
    MemorySourceType,
    MemoryStatus,
    VerificationStatus,
} from "./types";

export const COLUMN_MAP: Record<keyof Memory, string> = {
    id: "id",
    projectPath: "project_path",
    category: "category",
    content: "content",
    normalizedHash: "normalized_hash",
    sourceSessionId: "source_session_id",
    sourceType: "source_type",
    seenCount: "seen_count",
    retrievalCount: "retrieval_count",
    firstSeenAt: "first_seen_at",
    createdAt: "created_at",
    updatedAt: "updated_at",
    lastSeenAt: "last_seen_at",
    lastRetrievedAt: "last_retrieved_at",
    status: "status",
    expiresAt: "expires_at",
    verificationStatus: "verification_status",
    verifiedAt: "verified_at",
    supersededByMemoryId: "superseded_by_memory_id",
    mergedFrom: "merged_from",
    metadataJson: "metadata_json",
};

const MEMORY_CATEGORY_LOOKUP = {
    ARCHITECTURE_DECISIONS: true,
    CONSTRAINTS: true,
    CONFIG_DEFAULTS: true,
    NAMING: true,
    USER_PREFERENCES: true,
    USER_DIRECTIVES: true,
    ENVIRONMENT: true,
    WORKFLOW_RULES: true,
    KNOWN_ISSUES: true,
} satisfies Record<MemoryCategory, true>;

const MEMORY_STATUS_LOOKUP = {
    active: true,
    permanent: true,
    archived: true,
} satisfies Record<MemoryStatus, true>;

const MEMORY_SOURCE_TYPE_LOOKUP = {
    historian: true,
    agent: true,
    dreamer: true,
    user: true,
} satisfies Record<MemorySourceType, true>;

const VERIFICATION_STATUS_LOOKUP = {
    unverified: true,
    verified: true,
    stale: true,
    flagged: true,
} satisfies Record<VerificationStatus, true>;

const insertMemoryStatements = new WeakMap<Database, PreparedStatement>();
const getMemoryByHashStatements = new WeakMap<Database, PreparedStatement>();
const getMemoryByIdStatements = new WeakMap<Database, PreparedStatement>();
const updateMemorySeenCountStatements = new WeakMap<Database, PreparedStatement>();
const updateMemoryRetrievalCountStatements = new WeakMap<Database, PreparedStatement>();
const updateMemoryStatusStatements = new WeakMap<Database, PreparedStatement>();
const updateArchivedMemoryStatements = new WeakMap<Database, PreparedStatement>();
const updateMemoryVerificationStatements = new WeakMap<Database, PreparedStatement>();
const updateMemoryContentStatements = new WeakMap<Database, PreparedStatement>();
const supersededMemoryStatements = new WeakMap<Database, PreparedStatement>();
const mergeMemoryStatsStatements = new WeakMap<Database, PreparedStatement>();
const deleteMemoryStatements = new WeakMap<Database, PreparedStatement>();
const deleteMemoryEmbeddingStatements = new WeakMap<Database, PreparedStatement>();
const deleteEmbeddingOnContentUpdateStatements = new WeakMap<Database, PreparedStatement>();
const getMemoryCountStatements = new WeakMap<Database, PreparedStatement>();
const getMemoryCountByProjectStatements = new WeakMap<Database, PreparedStatement>();
const getMemoryCountsByStatusStatements = new WeakMap<Database, PreparedStatement>();
const memoriesByProjectStatements = new Map<string, WeakMap<Database, PreparedStatement>>();

export interface MemoryCountsByStatus {
    total: number;
    active: number;
    permanent: number;
    archived: number;
    merged: number;
    ids: number[];
    archivedIds: number[];
    mergedIds: number[];
}

interface MemoryCountByStatusRow {
    id: number;
    status: MemoryStatus;
    superseded_by_memory_id: number | null;
}

function getMemorySelectColumns(tableName = "memories"): string {
    return Object.entries(COLUMN_MAP)
        .map(([property, column]) => `${tableName}.${column} AS ${property}`)
        .join(", ");
}

function isMemoryCategory(value: unknown): value is MemoryCategory {
    return typeof value === "string" && value in MEMORY_CATEGORY_LOOKUP;
}

function isMemoryStatus(value: unknown): value is MemoryStatus {
    return typeof value === "string" && value in MEMORY_STATUS_LOOKUP;
}

function isMemorySourceType(value: unknown): value is MemorySourceType {
    return typeof value === "string" && value in MEMORY_SOURCE_TYPE_LOOKUP;
}

function isVerificationStatus(value: unknown): value is VerificationStatus {
    return typeof value === "string" && value in VERIFICATION_STATUS_LOOKUP;
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
    return value === null || typeof value === "number";
}

function isMemoryCountByStatusRow(row: unknown): row is MemoryCountByStatusRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.id === "number" &&
        isMemoryStatus(candidate.status) &&
        isNullableNumber(candidate.superseded_by_memory_id)
    );
}

export function isMemoryRow(row: unknown): row is Memory {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.id === "number" &&
        typeof candidate.projectPath === "string" &&
        isMemoryCategory(candidate.category) &&
        typeof candidate.content === "string" &&
        typeof candidate.normalizedHash === "string" &&
        isNullableString(candidate.sourceSessionId) &&
        isMemorySourceType(candidate.sourceType) &&
        typeof candidate.seenCount === "number" &&
        typeof candidate.retrievalCount === "number" &&
        typeof candidate.firstSeenAt === "number" &&
        typeof candidate.createdAt === "number" &&
        typeof candidate.updatedAt === "number" &&
        typeof candidate.lastSeenAt === "number" &&
        isNullableNumber(candidate.lastRetrievedAt) &&
        isMemoryStatus(candidate.status) &&
        isNullableNumber(candidate.expiresAt) &&
        isVerificationStatus(candidate.verificationStatus) &&
        isNullableNumber(candidate.verifiedAt) &&
        isNullableNumber(candidate.supersededByMemoryId) &&
        isNullableString(candidate.mergedFrom) &&
        isNullableString(candidate.metadataJson)
    );
}

export function toMemory(row: Memory): Memory {
    return {
        id: row.id,
        projectPath: row.projectPath,
        category: row.category,
        content: row.content,
        normalizedHash: row.normalizedHash,
        sourceSessionId: row.sourceSessionId,
        sourceType: row.sourceType,
        seenCount: row.seenCount,
        retrievalCount: row.retrievalCount,
        firstSeenAt: row.firstSeenAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lastSeenAt: row.lastSeenAt,
        lastRetrievedAt: row.lastRetrievedAt,
        status: row.status,
        expiresAt: row.expiresAt,
        verificationStatus: row.verificationStatus,
        verifiedAt: row.verifiedAt,
        supersededByMemoryId: row.supersededByMemoryId,
        mergedFrom: row.mergedFrom,
        metadataJson: row.metadataJson,
    };
}

function getInsertMemoryStatement(db: Database): PreparedStatement {
    let stmt = insertMemoryStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO memories (project_path, category, content, normalized_hash, source_session_id, source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at, last_seen_at, last_retrieved_at, status, expires_at, verification_status, verified_at, superseded_by_memory_id, merged_from, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        insertMemoryStatements.set(db, stmt);
    }
    return stmt;
}

function getMemoryByHashStatement(db: Database): PreparedStatement {
    let stmt = getMemoryByHashStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT ${getMemorySelectColumns()} FROM memories WHERE project_path = ? AND category = ? AND normalized_hash = ?`,
        );
        getMemoryByHashStatements.set(db, stmt);
    }
    return stmt;
}

function getMemoryByIdStatement(db: Database): PreparedStatement {
    let stmt = getMemoryByIdStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(`SELECT ${getMemorySelectColumns()} FROM memories WHERE id = ?`);
        getMemoryByIdStatements.set(db, stmt);
    }
    return stmt;
}

function getMemoriesByProjectStatement(db: Database, statuses: MemoryStatus[]): PreparedStatement {
    const key = statuses.join(",");
    let statements = memoriesByProjectStatements.get(key);
    if (!statements) {
        statements = new WeakMap<Database, PreparedStatement>();
        memoriesByProjectStatements.set(key, statements);
    }

    let stmt = statements.get(db);
    if (!stmt) {
        const placeholders = statuses.map(() => "?").join(", ");
        stmt = db.prepare(
            `SELECT ${getMemorySelectColumns()} FROM memories WHERE project_path = ? AND status IN (${placeholders}) AND (expires_at IS NULL OR expires_at > ?) ORDER BY category ASC, updated_at DESC, id ASC`,
        );
        statements.set(db, stmt);
    }

    return stmt;
}

function getUpdateMemorySeenCountStatement(db: Database): PreparedStatement {
    let stmt = updateMemorySeenCountStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "UPDATE memories SET seen_count = seen_count + 1, last_seen_at = ?, updated_at = ? WHERE id = ?",
        );
        updateMemorySeenCountStatements.set(db, stmt);
    }
    return stmt;
}

function getUpdateMemoryRetrievalCountStatement(db: Database): PreparedStatement {
    let stmt = updateMemoryRetrievalCountStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "UPDATE memories SET retrieval_count = retrieval_count + 1, last_retrieved_at = ?, updated_at = ? WHERE id = ?",
        );
        updateMemoryRetrievalCountStatements.set(db, stmt);
    }
    return stmt;
}

function getUpdateMemoryStatusStatement(db: Database): PreparedStatement {
    let stmt = updateMemoryStatusStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?");
        updateMemoryStatusStatements.set(db, stmt);
    }
    return stmt;
}

function getUpdateArchivedMemoryStatement(db: Database): PreparedStatement {
    let stmt = updateArchivedMemoryStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "UPDATE memories SET status = 'archived', metadata_json = ?, updated_at = ? WHERE id = ?",
        );
        updateArchivedMemoryStatements.set(db, stmt);
    }
    return stmt;
}

function getUpdateMemoryVerificationStatement(db: Database): PreparedStatement {
    let stmt = updateMemoryVerificationStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "UPDATE memories SET verification_status = ?, verified_at = CASE WHEN ? = 'verified' THEN ? ELSE verified_at END, updated_at = ? WHERE id = ?",
        );
        updateMemoryVerificationStatements.set(db, stmt);
    }
    return stmt;
}

function getUpdateMemoryContentStatement(db: Database): PreparedStatement {
    let stmt = updateMemoryContentStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ? WHERE id = ?",
        );
        updateMemoryContentStatements.set(db, stmt);
    }
    return stmt;
}

function getSupersededMemoryStatement(db: Database): PreparedStatement {
    let stmt = supersededMemoryStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "UPDATE memories SET superseded_by_memory_id = ?, status = 'archived', updated_at = ? WHERE id = ?",
        );
        supersededMemoryStatements.set(db, stmt);
    }
    return stmt;
}

function getMergeMemoryStatsStatement(db: Database): PreparedStatement {
    let stmt = mergeMemoryStatsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "UPDATE memories SET seen_count = ?, retrieval_count = ?, merged_from = ?, status = ?, updated_at = ? WHERE id = ?",
        );
        mergeMemoryStatsStatements.set(db, stmt);
    }
    return stmt;
}

function getDeleteMemoryStatement(db: Database): PreparedStatement {
    let stmt = deleteMemoryStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("DELETE FROM memories WHERE id = ?");
        deleteMemoryStatements.set(db, stmt);
    }
    return stmt;
}

function getDeleteMemoryEmbeddingStatement(db: Database): PreparedStatement {
    let stmt = deleteMemoryEmbeddingStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?");
        deleteMemoryEmbeddingStatements.set(db, stmt);
    }
    return stmt;
}

function getMemoryCountStatement(db: Database): PreparedStatement {
    let stmt = getMemoryCountStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("SELECT COUNT(*) AS count FROM memories");
        getMemoryCountStatements.set(db, stmt);
    }
    return stmt;
}

function getMemoryCountByProjectStatement(db: Database): PreparedStatement {
    let stmt = getMemoryCountByProjectStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("SELECT COUNT(*) AS count FROM memories WHERE project_path = ?");
        getMemoryCountByProjectStatements.set(db, stmt);
    }
    return stmt;
}

function getMemoryCountsByStatusStatement(db: Database): PreparedStatement {
    let stmt = getMemoryCountsByStatusStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT id, status, superseded_by_memory_id FROM memories WHERE project_path = ?",
        );
        getMemoryCountsByStatusStatements.set(db, stmt);
    }
    return stmt;
}

export function insertMemory(db: Database, input: MemoryInput): Memory {
    const now = Date.now();
    const normalizedHash = computeNormalizedHash(input.content);
    const result = getInsertMemoryStatement(db).run(
        input.projectPath,
        input.category,
        input.content,
        normalizedHash,
        input.sourceSessionId ?? null,
        input.sourceType ?? "historian",
        1,
        0,
        now,
        now,
        now,
        now,
        null,
        "active",
        input.expiresAt ?? null,
        "unverified",
        null,
        null,
        null,
        input.metadataJson ?? null,
    );

    const insertedResult = result as { lastInsertRowid?: number | bigint };
    const inserted = getMemoryById(db, Number(insertedResult.lastInsertRowid));
    if (!inserted) {
        throw new Error("Failed to load inserted memory row");
    }

    invalidateProject(input.projectPath);
    return inserted;
}

export function getMemoryByHash(
    db: Database,
    projectPath: string,
    category: MemoryCategory,
    normalizedHash: string,
): Memory | null {
    const result = getMemoryByHashStatement(db).get(projectPath, category, normalizedHash);
    if (!isMemoryRow(result)) {
        return null;
    }
    return toMemory(result);
}

export function getMemoriesByProject(
    db: Database,
    projectPath: string,
    statuses: MemoryStatus[] = ["active", "permanent"],
): Memory[] {
    if (statuses.length === 0) {
        return [];
    }

    const rows = getMemoriesByProjectStatement(db, statuses)
        .all(projectPath, ...statuses, Date.now())
        .filter(isMemoryRow);

    return rows.map(toMemory);
}

export function getMemoryById(db: Database, id: number): Memory | null {
    const result = getMemoryByIdStatement(db).get(id);
    if (!isMemoryRow(result)) {
        return null;
    }
    return toMemory(result);
}

export function updateMemorySeenCount(db: Database, id: number): void {
    const now = Date.now();
    getUpdateMemorySeenCountStatement(db).run(now, now, id);
}

export function updateMemoryRetrievalCount(db: Database, id: number): void {
    const now = Date.now();
    getUpdateMemoryRetrievalCountStatement(db).run(now, now, id);
}

export function updateMemoryStatus(db: Database, id: number, status: MemoryStatus): void {
    getUpdateMemoryStatusStatement(db).run(status, Date.now(), id);
}

function mergeMetadataJson(existing: string | null, patch: Record<string, string>): string | null {
    let base: Record<string, unknown> = {};

    if (existing) {
        try {
            const parsed = JSON.parse(existing);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                base = parsed as Record<string, unknown>;
            }
        } catch {
            // Intentional: corrupted metadata JSON defaults to empty — the merge will overwrite with fresh values.
            // Logging would require passing sessionId through a low-level utility used by multiple callers.
            base = {};
        }
    }

    return JSON.stringify({ ...base, ...patch });
}

export function updateMemoryVerification(
    db: Database,
    id: number,
    verificationStatus: VerificationStatus,
): void {
    const now = Date.now();
    getUpdateMemoryVerificationStatement(db).run(
        verificationStatus,
        verificationStatus,
        now,
        now,
        id,
    );
}

export function updateMemoryContent(
    db: Database,
    id: number,
    content: string,
    normalizedHash: string,
): void {
    // Intentional: read outside transaction — Bun is single-threaded so no concurrent
    // modification can happen. The projectPath is only used for cache invalidation after
    // the write, which self-heals on next search if stale.
    const memory = getMemoryById(db, id);

    db.transaction(() => {
        getUpdateMemoryContentStatement(db).run(content, normalizedHash, Date.now(), id);

        // Invalidate stale embedding — backfill will regenerate with new content.
        // Uses the same prepared statement pool as deleteEmbedding() in storage-memory-embeddings.ts,
        // but we inline the query here to avoid a circular import.
        let stmt = deleteEmbeddingOnContentUpdateStatements.get(db);
        if (!stmt) {
            stmt = db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?");
            deleteEmbeddingOnContentUpdateStatements.set(db, stmt);
        }
        stmt.run(id);
    })();

    if (memory) {
        invalidateMemory(memory.projectPath, id);
    }
}

export function supersededMemory(db: Database, id: number, supersededById: number): void {
    getSupersededMemoryStatement(db).run(supersededById, Date.now(), id);
}

export function mergeMemoryStats(
    db: Database,
    id: number,
    seenCount: number,
    retrievalCount: number,
    mergedFrom: string,
    status: MemoryStatus,
): void {
    getMergeMemoryStatsStatement(db).run(
        seenCount,
        retrievalCount,
        mergedFrom,
        status,
        Date.now(),
        id,
    );
}

export function archiveMemory(db: Database, id: number, reason?: string): void {
    const trimmedReason = reason?.trim();
    if (!trimmedReason) {
        updateMemoryStatus(db, id, "archived");
        return;
    }

    const memory = getMemoryById(db, id);
    if (!memory) {
        return;
    }

    getUpdateArchivedMemoryStatement(db).run(
        mergeMetadataJson(memory.metadataJson, { archive_reason: trimmedReason }),
        Date.now(),
        id,
    );
}

export function deleteMemory(db: Database, id: number): void {
    const memory = getMemoryById(db, id);

    db.transaction(() => {
        getDeleteMemoryEmbeddingStatement(db).run(id);
        getDeleteMemoryStatement(db).run(id);
    })();

    if (memory) {
        invalidateMemory(memory.projectPath, id);
    }
}

export function getMemoryCount(db: Database, projectPath?: string): number {
    const result = projectPath
        ? getMemoryCountByProjectStatement(db).get(projectPath)
        : getMemoryCountStatement(db).get();

    if (result === null || typeof result !== "object") {
        return 0;
    }

    const count = (result as Record<string, unknown>).count;
    return typeof count === "number" ? count : 0;
}

export function getMemoryCountsByStatus(db: Database, projectPath: string): MemoryCountsByStatus {
    const rows = getMemoryCountsByStatusStatement(db)
        .all(projectPath)
        .filter(isMemoryCountByStatusRow);

    const counts: MemoryCountsByStatus = {
        total: rows.length,
        active: 0,
        permanent: 0,
        archived: 0,
        merged: 0,
        ids: [],
        archivedIds: [],
        mergedIds: [],
    };

    for (const row of rows) {
        counts.ids.push(row.id);

        // Count merged memories separately — they should not also count as archived
        if (typeof row.superseded_by_memory_id === "number") {
            counts.merged += 1;
            counts.mergedIds.push(row.id);
        } else if (row.status === "active") {
            counts.active += 1;
        } else if (row.status === "permanent") {
            counts.permanent += 1;
        } else {
            counts.archived += 1;
            counts.archivedIds.push(row.id);
        }
    }

    counts.ids.sort((left, right) => left - right);
    counts.archivedIds.sort((left, right) => left - right);
    counts.mergedIds.sort((left, right) => left - right);

    return counts;
}
