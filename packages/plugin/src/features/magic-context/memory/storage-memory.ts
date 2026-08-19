import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";
import { hasMuralCueColumns, hasMuralCueRejectionCountColumn } from "../mural/storage-mural-cues";
import { MEMORY_CATEGORY_ORDER_SQL } from "./constants";
import { invalidateMemory, invalidateProject } from "./embedding-cache";
import { computeNormalizedHash } from "./normalize-hash";
import type {
    Memory,
    MemoryCategory,
    MemoryInput,
    MemoryScope,
    MemorySourceType,
    MemoryStatus,
    VerificationStatus,
} from "./types";
import { FOREIGN_VISIBLE_SQL } from "./visibility";

export const COLUMN_MAP: Record<keyof Memory, string> = {
    id: "id",
    projectPath: "project_path",
    category: "category",
    content: "content",
    normalizedHash: "normalized_hash",
    importance: "importance",
    scope: "scope",
    shareable: "shareable",
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
    // v2 world taxonomy
    PROJECT_RULES: true,
    ARCHITECTURE: true,
    CONFIG_VALUES: true,
    // legacy 9-cat (accept-both bridge until E3 recategorization)
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

const MEMORY_SCOPE_LOOKUP = {
    project: true,
    ecosystem: true,
    universe: true,
} satisfies Record<MemoryScope, true>;

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
const getMemoriesByIdsStatements = new Map<string, WeakMap<Database, PreparedStatement>>();
const activeMemoriesNoExpiryStatements = new WeakMap<Database, PreparedStatement>();
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
const memoryImportanceColumnCache = new WeakMap<Database, boolean>();
const memoryScopeColumnCache = new WeakMap<Database, boolean>();
const memoryShareableColumnCache = new WeakMap<Database, boolean>();
const memoryClassifiedAtColumnCache = new WeakMap<Database, boolean>();
const memoryEvidenceTableCache = new WeakMap<Database, boolean>();

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

export interface InsertMemoryResult {
    memory: Memory;
    inserted: boolean;
}

interface MemoryCountByStatusRow {
    id: number;
    status: MemoryStatus;
    superseded_by_memory_id: number | null;
}

function hasMemoryImportanceColumn(db: Database): boolean {
    const cached = memoryImportanceColumnCache.get(db);
    if (cached !== undefined) return cached;
    const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name?: string }>;
    const hasColumn = columns.some((column) => column.name === "importance");
    memoryImportanceColumnCache.set(db, hasColumn);
    return hasColumn;
}

function hasMemoryScopeColumn(db: Database): boolean {
    const cached = memoryScopeColumnCache.get(db);
    if (cached !== undefined) return cached;
    const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name?: string }>;
    const hasColumn = columns.some((column) => column.name === "scope");
    memoryScopeColumnCache.set(db, hasColumn);
    return hasColumn;
}

export function hasMemoryShareableColumn(db: Database): boolean {
    const cached = memoryShareableColumnCache.get(db);
    if (cached !== undefined) return cached;
    const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name?: string }>;
    const hasColumn = columns.some((column) => column.name === "shareable");
    memoryShareableColumnCache.set(db, hasColumn);
    return hasColumn;
}

export function hasMemoryClassifiedAtColumn(db: Database): boolean {
    const cached = memoryClassifiedAtColumnCache.get(db);
    if (cached !== undefined) return cached;
    const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name?: string }>;
    const hasColumn = columns.some((column) => column.name === "classified_at");
    memoryClassifiedAtColumnCache.set(db, hasColumn);
    return hasColumn;
}

/** Memory ids (from the given set) that have never been classified — the
 *  classify-memories run-gate + Stage-3 "to-classify" partition. */
export function getUnclassifiedMemoryIds(db: Database, memoryIds: readonly number[]): number[] {
    if (!hasMemoryClassifiedAtColumn(db)) return [...memoryIds];
    const ids = Array.from(new Set(memoryIds.filter(Number.isInteger)));
    if (ids.length === 0) return [];
    const ph = ids.map(() => "?").join(", ");
    const rows = db
        .prepare<unknown[], { id: number }>(
            `SELECT id FROM memories WHERE id IN (${ph}) AND classified_at IS NOT NULL`,
        )
        .all(...ids);
    const classified = new Set(rows.map((r) => r.id));
    return ids.filter((id) => !classified.has(id));
}

export function getMemorySelectColumns(db: Database, tableName = "memories"): string {
    return Object.entries(COLUMN_MAP)
        .map(([property, column]) => {
            if (property === "importance" && !hasMemoryImportanceColumn(db)) {
                return "50 AS importance";
            }
            if (property === "importance") {
                return `COALESCE(${tableName}.${column}, 50) AS ${property}`;
            }
            if (property === "scope" && !hasMemoryScopeColumn(db)) {
                return "'project' AS scope";
            }
            if (property === "scope") {
                return `COALESCE(${tableName}.${column}, 'project') AS ${property}`;
            }
            if (property === "shareable" && !hasMemoryShareableColumn(db)) {
                return "0 AS shareable";
            }
            if (property === "shareable") {
                return `COALESCE(${tableName}.${column}, 0) AS ${property}`;
            }
            return `${tableName}.${column} AS ${property}`;
        })
        .join(", ");
}

function isMemoryCategory(value: unknown): value is MemoryCategory {
    return typeof value === "string" && value in MEMORY_CATEGORY_LOOKUP;
}

function isMemoryStatus(value: unknown): value is MemoryStatus {
    return typeof value === "string" && value in MEMORY_STATUS_LOOKUP;
}

function isMemoryScope(value: unknown): value is MemoryScope {
    return typeof value === "string" && value in MEMORY_SCOPE_LOOKUP;
}

function isMemorySourceType(value: unknown): value is MemorySourceType {
    return typeof value === "string" && value in MEMORY_SOURCE_TYPE_LOOKUP;
}

function isVerificationStatus(value: unknown): value is VerificationStatus {
    return typeof value === "string" && value in VERIFICATION_STATUS_LOOKUP;
}

function isUniqueConstraintError(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
    );
}

function hasMemoryEvidenceTable(db: Database): boolean {
    const cached = memoryEvidenceTableCache.get(db);
    if (cached !== undefined) return cached;
    const present = Boolean(
        db
            .prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_evidence'",
            )
            .get(),
    );
    memoryEvidenceTableCache.set(db, present);
    return present;
}

export interface MemoryEvidence {
    readonly content_hash: string;
    readonly source_session_id: string;
    readonly source_message_id: string | null;
    readonly source_type: MemorySourceType;
    readonly observed_at: number;
}

export function getMemoryEvidence(db: Database, memoryId: number): MemoryEvidence[] {
    if (!hasMemoryEvidenceTable(db)) return [];
    return db
        .prepare(
            `SELECT content_hash, source_session_id, source_message_id, source_type, observed_at
               FROM memory_evidence WHERE memory_id = ?
               ORDER BY content_hash, source_session_id`,
        )
        .all(memoryId) as MemoryEvidence[];
}

function recordMemoryEvidenceInCurrentTransaction(
    db: Database,
    memoryId: number,
    input: MemoryInput,
): void {
    if (!input.sourceSessionId || !hasMemoryEvidenceTable(db)) return;
    const memory = db
        .prepare(
            `SELECT normalized_hash, source_session_id,
                    (SELECT COUNT(DISTINCT source_session_id)
                       FROM memory_evidence WHERE memory_id = ?) AS evidence_count
               FROM memories WHERE id = ?`,
        )
        .get(memoryId, memoryId) as
        | { normalized_hash?: string; source_session_id?: string | null; evidence_count?: number }
        | undefined;
    if (!memory?.normalized_hash) return;
    const now = Date.now();
    const result = db
        .prepare(
            `INSERT OR IGNORE INTO memory_evidence (
                memory_id, content_hash, source_session_id, source_message_id, source_type, observed_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
            memoryId,
            memory.normalized_hash,
            input.sourceSessionId,
            input.sourceMessageId ?? null,
            input.sourceType ?? "historian",
            now,
        ) as { changes?: number };
    if ((result.changes ?? 0) === 0) return;
    db.prepare(
        `UPDATE memories
            SET seen_count = MAX(COALESCE(seen_count, 1) - ?, 0)
                    + (SELECT COUNT(DISTINCT source_session_id) FROM memory_evidence WHERE memory_id = ?),
                last_seen_at = ?,
                updated_at = ?
          WHERE id = ?`,
    ).run(
        (memory.evidence_count ?? 0) > 0
            ? memory.evidence_count
            : memory.source_session_id === input.sourceSessionId
              ? 1
              : 0,
        memoryId,
        now,
        now,
        memoryId,
    );
}

export function recordMemoryEvidence(db: Database, memoryId: number, input: MemoryInput): void {
    db.transaction(() => recordMemoryEvidenceInCurrentTransaction(db, memoryId, input))();
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
        typeof candidate.importance === "number" &&
        isMemoryScope(candidate.scope) &&
        typeof candidate.shareable === "number" &&
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
        importance: row.importance,
        scope: row.scope,
        shareable: row.shareable,
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
        stmt = hasMemoryImportanceColumn(db)
            ? db.prepare(
                  "INSERT INTO memories (project_path, category, content, normalized_hash, importance, source_session_id, source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at, last_seen_at, last_retrieved_at, status, expires_at, verification_status, verified_at, superseded_by_memory_id, merged_from, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              )
            : db.prepare(
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
            `SELECT ${getMemorySelectColumns(db)} FROM memories WHERE project_path = ? AND category = ? AND normalized_hash = ?`,
        );
        getMemoryByHashStatements.set(db, stmt);
    }
    return stmt;
}

function getMemoryByIdStatement(db: Database): PreparedStatement {
    let stmt = getMemoryByIdStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(`SELECT ${getMemorySelectColumns(db)} FROM memories WHERE id = ?`);
        getMemoryByIdStatements.set(db, stmt);
    }
    return stmt;
}

function getMemoriesByIdsStatement(db: Database, idCount: number): PreparedStatement {
    const key = `n${idCount}`;
    let map = getMemoriesByIdsStatements.get(key);
    if (!map) {
        map = new WeakMap<Database, PreparedStatement>();
        getMemoriesByIdsStatements.set(key, map);
    }
    let stmt = map.get(db);
    if (!stmt) {
        const placeholders = new Array(idCount).fill("?").join(", ");
        stmt = db.prepare(
            `SELECT ${getMemorySelectColumns(db)} FROM memories WHERE id IN (${placeholders})`,
        );
        map.set(db, stmt);
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
            `SELECT ${getMemorySelectColumns(db)} FROM memories WHERE project_path = ? AND status IN (${placeholders}) AND (expires_at IS NULL OR expires_at > ?) ORDER BY category ASC, updated_at DESC, id ASC`,
        );
        statements.set(db, stmt);
    }

    return stmt;
}

/** All `active` rows for a project with NO expiry filter — for the destructive
 *  migration path only (see getAllActiveMemoriesForMigration). */
function getActiveMemoriesNoExpiryStatement(db: Database): PreparedStatement {
    let stmt = activeMemoriesNoExpiryStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT ${getMemorySelectColumns(db)} FROM memories WHERE project_path = ? AND status = 'active' ORDER BY category ASC, updated_at DESC, id ASC`,
        );
        activeMemoriesNoExpiryStatements.set(db, stmt);
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
            "UPDATE memories SET seen_count = MAX(COALESCE(seen_count, 1), ?), retrieval_count = ?, merged_from = ?, status = ?, updated_at = ? WHERE id = ?",
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

function buildInsertMemoryValues(
    input: MemoryInput,
    normalizedHash: string,
    now: number,
    includeImportance: boolean,
): Array<string | number | null> {
    const insertValues: Array<string | number | null> = [
        input.projectPath,
        input.category,
        input.content,
        normalizedHash,
    ];
    if (includeImportance) {
        insertValues.push(input.importance ?? 50);
    }
    insertValues.push(
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
    return insertValues;
}

function loadInsertedMemory(db: Database, rowid: number | bigint | undefined): Memory {
    const inserted = getMemoryById(db, Number(rowid));
    if (!inserted) {
        throw new Error("Failed to load inserted memory row");
    }
    return inserted;
}

export class ModuleMemoryAuthorityError extends Error {
    readonly code = "MEMORY_MODULE_AUTHORITY";

    constructor(readonly projectPath: string) {
        super(
            `memory writes for module-managed project ${projectPath} must use the Rust ctx_memory module facade`,
        );
        this.name = "ModuleMemoryAuthorityError";
    }
}

function assertTsMemoryWriteAllowed(db: Database, projectPath: string): void {
    try {
        const managed = db
            .prepare(
                "SELECT 1 FROM authority_managed WHERE project_path = ? UNION SELECT 1 FROM authority_repair_pending WHERE project_path = ? LIMIT 1",
            )
            .get(projectPath, projectPath);
        if (managed) throw new ModuleMemoryAuthorityError(projectPath);
    } catch (error) {
        // Older isolated test/legacy databases have no authority tables; their
        // absent marker means ordinary TypeScript ownership by definition.
        if (!(error instanceof Error) || !error.message.includes("no such table")) throw error;
    }
}

function assertTsMemoryIdWriteAllowed(db: Database, id: number): Memory | null {
    const memory = getMemoryById(db, id);
    if (memory) assertTsMemoryWriteAllowed(db, memory.projectPath);
    return memory;
}

export function insertMemory(db: Database, input: MemoryInput): Memory {
    const inserted = db.transaction(() => {
        assertTsMemoryWriteAllowed(db, input.projectPath);
        const now = Date.now();
        const normalizedHash = computeNormalizedHash(input.content);
        const insertValues = buildInsertMemoryValues(
            input,
            normalizedHash,
            now,
            hasMemoryImportanceColumn(db),
        );
        const result = getInsertMemoryStatement(db).run(...insertValues) as {
            lastInsertRowid?: number | bigint;
        };
        const memory = loadInsertedMemory(db, result.lastInsertRowid);
        recordMemoryEvidence(db, memory.id, input);
        return getMemoryById(db, memory.id) ?? memory;
    })();

    invalidateProject(input.projectPath);
    return inserted;
}

/**
 * Shared-DB callers can race between their exact-hash pre-check and INSERT. When
 * the unique constraint wins, treat it as the same exact-dedup path the tool uses:
 * bump seen_count/last_seen_at on the existing row and return it instead of
 * surfacing a transient write failure.
 */
export function insertMemoryIdempotent(db: Database, input: MemoryInput): InsertMemoryResult {
    assertTsMemoryWriteAllowed(db, input.projectPath);
    const existing = getMemoryByHash(
        db,
        input.projectPath,
        input.category,
        computeNormalizedHash(input.content),
    );
    if (existing) {
        if (input.sourceSessionId && hasMemoryEvidenceTable(db)) {
            recordMemoryEvidence(db, existing.id, input);
        } else {
            updateMemorySeenCount(db, existing.id);
        }
        return { memory: getMemoryById(db, existing.id) ?? existing, inserted: false };
    }
    try {
        const memory = insertMemory(db, input);
        return { memory: getMemoryById(db, memory.id) ?? memory, inserted: true };
    } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const normalizedHash = computeNormalizedHash(input.content);
        const raced = getMemoryByHash(db, input.projectPath, input.category, normalizedHash);
        if (!raced) throw error;
        if (input.sourceSessionId && hasMemoryEvidenceTable(db)) {
            recordMemoryEvidence(db, raced.id, input);
        } else {
            updateMemorySeenCount(db, raced.id);
        }
        return { memory: getMemoryById(db, raced.id) ?? raced, inserted: false };
    }
}

export function mergeMemoryEpisodeEvidence(
    db: Database,
    targetId: number,
    sourceIds: readonly number[],
): number | null {
    if (!hasMemoryEvidenceTable(db)) return null;
    const ids = [targetId, ...sourceIds];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = db
        .prepare(
            `SELECT memories.id, memories.seen_count,
                    COUNT(DISTINCT memory_evidence.source_session_id) AS evidence_count
               FROM memories
               LEFT JOIN memory_evidence ON memory_evidence.memory_id = memories.id
              WHERE memories.id IN (${placeholders})
              GROUP BY memories.id, memories.seen_count`,
        )
        .all(...ids) as Array<{ seen_count?: number; evidence_count?: number }>;
    const legacyBaseline = rows.reduce(
        (sum, row) => sum + Math.max((row.seen_count ?? 1) - (row.evidence_count ?? 0), 0),
        0,
    );
    for (const sourceId of sourceIds) {
        db.prepare(
            `INSERT OR IGNORE INTO memory_evidence (
                memory_id, content_hash, source_session_id, source_message_id, source_type, observed_at
            )
            SELECT ?, content_hash, source_session_id, source_message_id, source_type, observed_at
              FROM memory_evidence WHERE memory_id = ?`,
        ).run(targetId, sourceId);
    }
    const union = db
        .prepare(
            "SELECT COUNT(DISTINCT source_session_id) AS count FROM memory_evidence WHERE memory_id = ?",
        )
        .get(targetId) as { count?: number } | undefined;
    return legacyBaseline + (union?.count ?? 0);
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
    // Expiry cutoff. Defaults to live Date.now() for normal callers. The m[1]
    // render path passes a FROZEN cutoff (the m[0] materialization timestamp) so
    // defer passes render a byte-stable memory set — a memory crossing expires_at
    // between two defer passes must not silently change the wire (cache bust).
    expiryCutoff: number = Date.now(),
): Memory[] {
    if (statuses.length === 0) {
        return [];
    }

    const rows = getMemoriesByProjectStatement(db, statuses)
        .all(projectPath, ...statuses, expiryCutoff)
        .filter(isMemoryRow);

    return rows.map(toMemory);
}

/**
 * Load ALL `active` memories for a project, INCLUDING expired ones.
 *
 * `getMemoriesByProject` filters out rows whose `expires_at` has passed (correct
 * for the RENDER path — expired memories shouldn't be injected). But the memory
 * MIGRATION (`/ctx-session-upgrade`) does a destructive delete+reinsert of the
 * `active` pool, and it MUST operate on the full active set: if it only saw
 * unexpired rows, it would delete those and leave expired `active` rows orphaned
 * — a partial, inconsistent wipe (root cause, dogfood 2026-05-31: 831 unexpired
 * deleted, 27 expired KNOWN_ISSUES stranded). Migration is a re-categorization,
 * so it re-evaluates every active row regardless of TTL.
 */

function sqlPlaceholders(values: readonly unknown[]): string {
    return values.map(() => "?").join(", ");
}

function uniqueValues(values: readonly string[]): string[] {
    return [...new Set(values.filter((value) => value.length > 0))];
}

export interface WorkspaceMemorySqlFilter {
    clause: string;
    params: string[];
    active: boolean;
    /** Canonical policy text retained for parity/golden checks across render paths. */
    predicate: string;
}

// The same own-vs-foreign predicate is appended to baseline, delta, watermark,
// and FTS union reads. Keeping the SQL builder shared prevents a hidden foreign
// category from rendering in one path while advancing another path's cursor.
export function buildWorkspaceMemorySqlFilter(args: {
    identities: readonly string[];
    ownIdentities?: readonly string[];
    shareCategories?: readonly string[] | null;
    tableName?: string;
    includeClassificationFields?: boolean;
}): WorkspaceMemorySqlFilter {
    if (args.shareCategories === null || args.shareCategories === undefined) {
        return { clause: "", params: [], active: false, predicate: FOREIGN_VISIBLE_SQL };
    }

    const identities = uniqueValues(args.identities);
    const identitySet = new Set(identities);
    const ownSet = new Set(
        uniqueValues(args.ownIdentities ?? []).filter((identity) => identitySet.has(identity)),
    );
    const foreignIdentities = identities.filter((identity) => !ownSet.has(identity));
    if (foreignIdentities.length === 0) {
        return { clause: "", params: [], active: false, predicate: FOREIGN_VISIBLE_SQL };
    }

    const ownIdentities = identities.filter((identity) => ownSet.has(identity));
    const shareCategories = uniqueValues([...args.shareCategories]);
    const qualifier = args.tableName ? `${args.tableName}.` : "";
    const classification =
        args.includeClassificationFields === false
            ? ""
            : ` AND ${qualifier}shareable = 1 AND ${qualifier}scope IN ('project','ecosystem','universe')`;
    const predicates: string[] = [];
    const params: string[] = [];

    if (ownIdentities.length > 0) {
        predicates.push(`${qualifier}project_path IN (${sqlPlaceholders(ownIdentities)})`);
        params.push(...ownIdentities);
    }
    if (foreignIdentities.length > 0 && shareCategories.length > 0) {
        predicates.push(
            `(${qualifier}project_path IN (${sqlPlaceholders(foreignIdentities)}) AND ${qualifier}category IN (${sqlPlaceholders(shareCategories)})${classification})`,
        );
        params.push(...foreignIdentities, ...shareCategories);
    }

    if (predicates.length === 0) {
        return { clause: " AND 0 = 1", params: [], active: true, predicate: FOREIGN_VISIBLE_SQL };
    }
    return {
        clause: ` AND (${predicates.join(" OR ")})`,
        params,
        active: true,
        predicate: FOREIGN_VISIBLE_SQL,
    };
}

export function getMemoriesByProjects(
    db: Database,
    projectPaths: readonly string[],
    statuses: MemoryStatus[] = ["active", "permanent"],
    expiryCutoff: number = Date.now(),
    ownIdentities?: readonly string[],
    shareCategories?: readonly string[] | null,
): Memory[] {
    const identities = uniqueValues(projectPaths);
    if (identities.length === 0 || statuses.length === 0) return [];
    const identitySet = new Set(identities);
    const ownSet = new Set(
        uniqueValues(ownIdentities ?? []).filter((identity) => identitySet.has(identity)),
    );
    const foreignIdentities = identities.filter((identity) => !ownSet.has(identity));
    const ownIdentitiesResolved = identities.filter((identity) => ownSet.has(identity));
    // Single-project own-only path keeps the caller's status set (including archived).
    if (
        foreignIdentities.length === 0 ||
        shareCategories === null ||
        shareCategories === undefined
    ) {
        if (identities.length === 1) {
            return getMemoriesByProject(db, identities[0], statuses, expiryCutoff);
        }
        const rows = db
            .prepare(
                `SELECT ${getMemorySelectColumns(db)}
                   FROM memories
                  WHERE project_path IN (${sqlPlaceholders(identities)})
                    AND status IN (${sqlPlaceholders(statuses)})
                    AND (expires_at IS NULL OR expires_at > ?)
                  ORDER BY category ASC, updated_at DESC, id ASC`,
            )
            .all(...identities, ...statuses, expiryCutoff)
            .filter(isMemoryRow);
        return rows.map(toMemory);
    }

    // Foreign rows always use the complete canonical visibility predicate, independent
    // of the caller's own-row status set (which may include archived for local reads).
    const shareCats = uniqueValues([...shareCategories]);
    const hasClassification = hasMemoryShareableColumn(db) && hasMemoryScopeColumn(db);
    const predicates: string[] = [];
    const params: Array<string | number> = [];
    if (ownIdentitiesResolved.length > 0) {
        predicates.push(
            `(project_path IN (${sqlPlaceholders(ownIdentitiesResolved)})
              AND status IN (${sqlPlaceholders(statuses)})
              AND (expires_at IS NULL OR expires_at > ?))`,
        );
        params.push(...ownIdentitiesResolved, ...statuses, expiryCutoff);
    }
    if (foreignIdentities.length > 0 && shareCats.length > 0) {
        const classification = hasClassification
            ? " AND shareable = 1 AND scope IN ('project','ecosystem','universe')"
            : "";
        predicates.push(
            `(project_path IN (${sqlPlaceholders(foreignIdentities)})
              AND status IN ('active','permanent')
              AND (expires_at IS NULL OR expires_at > ?)
              AND category IN (${sqlPlaceholders(shareCats)})${classification})`,
        );
        params.push(...foreignIdentities, expiryCutoff, ...shareCats);
    }
    if (predicates.length === 0) return [];
    // Retain the canonical foreign-visibility SQL constant so this path stays aligned
    // with mc-store's FOREIGN_VISIBLE_SQL (status/expiry/shareable/scope/category).
    void FOREIGN_VISIBLE_SQL;
    const rows = db
        .prepare(
            `SELECT ${getMemorySelectColumns(db)}
               FROM memories
              WHERE (${predicates.join(" OR ")})
              ORDER BY category ASC, updated_at DESC, id ASC`,
        )
        .all(...params)
        .filter(isMemoryRow);
    return rows.map(toMemory);
}

export function getMaxMemoryIdForProjects(
    db: Database,
    projectPaths: readonly string[],
    ownIdentities?: readonly string[],
    shareCategories?: readonly string[] | null,
    expiryCutoff: number = Date.now(),
): number {
    const identities = uniqueValues(projectPaths);
    if (identities.length === 0) return 0;
    const sharingFilter = buildWorkspaceMemorySqlFilter({
        identities,
        ownIdentities,
        shareCategories,
        includeClassificationFields: hasMemoryShareableColumn(db) && hasMemoryScopeColumn(db),
    });
    const row = db
        .prepare(
            `SELECT COALESCE(MAX(id), 0) AS max_id
               FROM memories
              WHERE project_path IN (${sqlPlaceholders(identities)})
                AND status IN ('active', 'permanent')
                AND (expires_at IS NULL OR expires_at > ?)${sharingFilter.clause}`,
        )
        .get(...identities, expiryCutoff, ...sharingFilter.params) as
        | { max_id?: number }
        | undefined;
    return typeof row?.max_id === "number" ? row.max_id : 0;
}

export function readNewMemoriesForM1Union(
    db: Database,
    projectPaths: readonly string[],
    afterId: number,
    expiryCutoff: number,
    ownIdentities?: readonly string[],
    shareCategories?: readonly string[] | null,
): Memory[] {
    const identities = uniqueValues(projectPaths);
    if (identities.length === 0) return [];
    const sharingFilter = buildWorkspaceMemorySqlFilter({
        identities,
        ownIdentities,
        shareCategories,
        includeClassificationFields: hasMemoryShareableColumn(db) && hasMemoryScopeColumn(db),
    });
    const rows = db
        .prepare(
            `SELECT ${getMemorySelectColumns(db)}
               FROM memories
              WHERE project_path IN (${sqlPlaceholders(identities)})
                AND id > ?
                AND status IN ('active', 'permanent')
                AND (expires_at IS NULL OR expires_at > ?)${sharingFilter.clause}
              ORDER BY ${MEMORY_CATEGORY_ORDER_SQL}, id ASC`,
        )
        .all(...identities, afterId, expiryCutoff, ...sharingFilter.params)
        .filter(isMemoryRow);
    return rows.map(toMemory);
}

export function getAllActiveMemoriesForMigration(db: Database, projectPath: string): Memory[] {
    const rows = getActiveMemoriesNoExpiryStatement(db).all(projectPath).filter(isMemoryRow);
    return rows.map(toMemory);
}

export function getMemoryById(db: Database, id: number): Memory | null {
    const result = getMemoryByIdStatement(db).get(id);
    if (!isMemoryRow(result)) {
        return null;
    }
    return toMemory(result);
}

/** Load multiple memories by id in one positional-bind statement.
 *
 *  Returns whatever rows exist; missing ids are simply absent from the result.
 *  Visibility (own project vs foreign workspace + share category) is the
 *  caller's job — this helper does not enforce it. The tool layer applies the
 *  same union-read predicate used by every other read path (`memoryVisibleToTool`)
 *  and reports not-found / not-visible ids with one opaque per-id message, so
 *  foreign memory existence is never leaked. */
export function getMemoriesByIds(db: Database, ids: readonly number[]): Memory[] {
    const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isInteger(id))));
    if (uniqueIds.length === 0) {
        return [];
    }
    const rows = getMemoriesByIdsStatement(db, uniqueIds.length)
        .all(...uniqueIds)
        .filter(isMemoryRow);
    return rows.map(toMemory);
}

export function updateMemorySeenCount(db: Database, id: number): void {
    assertTsMemoryIdWriteAllowed(db, id);
    const now = Date.now();
    getUpdateMemorySeenCountStatement(db).run(now, now, id);
}

export function updateMemoryRetrievalCount(db: Database, id: number): void {
    assertTsMemoryIdWriteAllowed(db, id);
    const now = Date.now();
    getUpdateMemoryRetrievalCountStatement(db).run(now, now, id);
}

export function updateMemoryStatus(db: Database, id: number, status: MemoryStatus): void {
    assertTsMemoryIdWriteAllowed(db, id);
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
    assertTsMemoryIdWriteAllowed(db, id);
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
    const memory = assertTsMemoryIdWriteAllowed(db, id);

    db.transaction(() => {
        getUpdateMemoryContentStatement(db).run(content, normalizedHash, Date.now(), id);

        // The `shareable` flag was scored against the OLD content by classify; new
        // content invalidates that judgement. Fail closed: reset to private so a
        // now-sensitive edit can't inherit a stale shareable=1. The dreamer's
        // classify task re-scores it later. Column-guarded for pre-v44 DBs.
        if (hasMemoryShareableColumn(db)) {
            db.prepare("UPDATE memories SET shareable = 0 WHERE id = ?").run(id);
        }

        // Clear the classify marker so the changed fact is re-scored next classify
        // run (importance/scope were judged against the old content).
        if (hasMemoryClassifiedAtColumn(db)) {
            db.prepare("UPDATE memories SET classified_at = NULL WHERE id = ?").run(id);
        }

        // Drop the stale mural cue: it was compressed from the OLD content, so its
        // hash no longer matches. Clearing it here means resolveMural won't render
        // the stale cue even for the brief window before compress-cues recomputes
        // it, and the compress-cues gate re-selects this memory (NULL cue).
        // Column-guarded for pre-v65 DBs.
        if (hasMuralCueColumns(db)) {
            const rejectionReset = hasMuralCueRejectionCountColumn(db)
                ? ", mural_cue_rejection_count = 0"
                : "";
            db.prepare(
                `UPDATE memories SET mural_cue = NULL, mural_cue_hash = NULL, mural_cue_at = NULL${rejectionReset} WHERE id = ?`,
            ).run(id);
        }

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

export interface MemoryClassificationUpdate {
    importance?: number;
    scope?: MemoryScope;
    shareable?: boolean;
}

function normalizeImportance(value: number): number {
    if (!Number.isFinite(value)) return 50;
    return Math.max(1, Math.min(100, Math.round(value)));
}

export function setMemoryClassification(
    db: Database,
    id: number,
    classification: MemoryClassificationUpdate,
): boolean {
    const hasImportance = classification.importance !== undefined;
    const hasScope = classification.scope !== undefined;
    const hasShareable = classification.shareable !== undefined;
    if (!hasImportance && !hasScope && !hasShareable) {
        throw new Error("setMemoryClassification requires at least one supplied field");
    }

    const memory = assertTsMemoryIdWriteAllowed(db, id);
    if (!memory) return false;

    const assignments: string[] = [];
    const values: Array<number | string> = [];
    if (hasImportance) {
        const next = normalizeImportance(classification.importance as number);
        if (memory.importance !== next) {
            assignments.push("importance = ?");
            values.push(next);
        }
    }
    if (hasScope) {
        const next = classification.scope as MemoryScope;
        if (!isMemoryScope(next)) {
            throw new Error(`invalid memory scope: ${String(next)}`);
        }
        if (memory.scope !== next) {
            assignments.push("scope = ?");
            values.push(next);
        }
    }
    if (hasShareable) {
        const next = classification.shareable ? 1 : 0;
        if ((memory.shareable ? 1 : 0) !== next) {
            assignments.push("shareable = ?");
            values.push(next);
        }
    }

    // A classification field actually changed iff there were assignments BEFORE
    // we add the marker (the return value reports real change, for telemetry).
    const fieldChanged = assignments.length > 0;

    // Always stamp classified_at (even when no column value changed) so the
    // run-gate / Stage-3 partition treats this memory as classified and won't
    // re-score it next run. Stamping a timestamp does not affect the rendered
    // m[0] bytes, so this stays cache-neutral.
    if (hasMemoryClassifiedAtColumn(db)) {
        assignments.push("classified_at = ?");
        values.push(Date.now());
    }

    if (assignments.length === 0) return false;
    db.prepare(`UPDATE memories SET ${assignments.join(", ")} WHERE id = ?`).run(...values, id);
    return fieldChanged;
}

export function supersededMemory(db: Database, id: number, supersededById: number): void {
    assertTsMemoryIdWriteAllowed(db, id);
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
    assertTsMemoryIdWriteAllowed(db, id);
    const mergedIds = db
        .prepare("SELECT value AS id FROM json_each(?) WHERE type = 'integer' AND value <> ?")
        .all(mergedFrom, id) as Array<{ id: number }>;
    const mergedEpisodeCount = mergeMemoryEpisodeEvidence(
        db,
        id,
        mergedIds.map((row) => row.id),
    );
    getMergeMemoryStatsStatement(db).run(
        mergedEpisodeCount ?? seenCount,
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

    const memory = assertTsMemoryIdWriteAllowed(db, id);
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
    const memory = assertTsMemoryIdWriteAllowed(db, id);

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
