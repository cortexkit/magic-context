import type { Database } from "../../shared/sqlite";

const IDENTITY_COLUMNS = new Set(["project_path", "project_identity"]);
const DERIVED_TABLE_SUFFIXES = [
    "_fts",
    "_fts_data",
    "_fts_idx",
    "_fts_content",
    "_fts_docsize",
    "_fts_config",
];

type SqliteRow = Record<string, unknown>;
type TableInfo = { name: string; identityColumn: string; derived: boolean };

type MergeAction = "rekeyed" | "superseded" | "collision_deleted";

export interface IdentityMergeTableReport {
    tableName: string;
    identityColumn: string;
    derived: boolean;
    sourceRows: number;
    changedRows: number;
}

export interface IdentityMergeReport {
    fromIdentity: string;
    toIdentity: string;
    auditedTables: IdentityMergeTableReport[];
    changedRows: number;
    dryRun: boolean;
}

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replaceAll('"', '""')}"`;
}

function tableExists(db: Database, tableName: string): boolean {
    return Boolean(
        db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
            .get(tableName),
    );
}

function isDerivedTable(tableName: string, sql: string | null): boolean {
    return (
        sql?.toUpperCase().includes("VIRTUAL TABLE") === true ||
        DERIVED_TABLE_SUFFIXES.some((suffix) => tableName.endsWith(suffix))
    );
}

function discoverIdentityTables(db: Database): TableInfo[] {
    const rows = db
        .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name?: unknown; sql?: unknown }>;
    const tables: TableInfo[] = [];
    for (const row of rows) {
        if (typeof row.name !== "string") continue;
        const columns = db
            .prepare(`PRAGMA table_info(${quoteIdentifier(row.name)})`)
            .all() as Array<{
            name?: unknown;
        }>;
        const identityColumn = columns.find(
            (column) => typeof column.name === "string" && IDENTITY_COLUMNS.has(column.name),
        )?.name;
        if (typeof identityColumn !== "string") continue;
        tables.push({
            name: row.name,
            identityColumn,
            derived: isDerivedTable(row.name, typeof row.sql === "string" ? row.sql : null),
        });
    }
    return tables;
}

function primaryKeyColumns(db: Database, tableName: string): string[] {
    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{
        name?: unknown;
        pk?: unknown;
    }>;
    return columns
        .filter(
            (column) =>
                typeof column.name === "string" && typeof column.pk === "number" && column.pk > 0,
        )
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((column) => column.name as string);
}

function rowKey(db: Database, tableName: string, row: SqliteRow): string {
    const keys = primaryKeyColumns(db, tableName);
    if (keys.length === 1) return String(row[keys[0]]);
    if (keys.length > 1) return JSON.stringify(keys.map((key) => row[key]));
    return String(row.rowid ?? row.id ?? "");
}

function rowPredicate(
    db: Database,
    tableName: string,
    row: SqliteRow,
): { sql: string; values: unknown[] } {
    const keys = primaryKeyColumns(db, tableName);
    if (keys.length > 0) {
        return {
            sql: keys.map((key) => `${quoteIdentifier(key)} = ?`).join(" AND "),
            values: keys.map((key) => row[key]),
        };
    }
    return { sql: "rowid = ?", values: [row.rowid] };
}

function uniqueIndexes(db: Database, tableName: string): string[][] {
    const indexes = db.prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`).all() as Array<{
        name?: unknown;
        unique?: unknown;
    }>;
    const result: string[][] = [];
    for (const index of indexes) {
        if (index.unique !== 1 || typeof index.name !== "string") continue;
        const columns = db
            .prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`)
            .all() as Array<{
            name?: unknown;
            seqno?: unknown;
        }>;
        result.push(
            columns
                .sort((a, b) => Number(a.seqno) - Number(b.seqno))
                .map((column) => column.name)
                .filter((name): name is string => typeof name === "string"),
        );
    }
    return result;
}

function findUniqueCollision(
    db: Database,
    table: TableInfo,
    row: SqliteRow,
    fromIdentity: string,
    toIdentity: string,
): SqliteRow | null {
    const indexes = uniqueIndexes(db, table.name);
    for (const columns of indexes) {
        if (!columns.includes(table.identityColumn)) continue;
        const where = columns.map((column) => `${quoteIdentifier(column)} = ?`).join(" AND ");
        const values = columns.map((column) =>
            column === table.identityColumn ? toIdentity : row[column],
        );
        const candidate = db
            .prepare(`SELECT rowid, * FROM ${quoteIdentifier(table.name)} WHERE ${where} LIMIT 1`)
            .get(...values) as SqliteRow | undefined;
        if (candidate && rowKey(db, table.name, candidate) !== rowKey(db, table.name, row)) {
            return candidate;
        }
    }
    // A source row can be returned by a unique index lookup only when it is the
    // target identity itself. Treat that case as no collision so a repeated
    // operation remains an idempotent no-op.
    if (row[table.identityColumn] !== fromIdentity) return row;
    return null;
}

function logRow(
    db: Database,
    fromIdentity: string,
    toIdentity: string,
    tableName: string,
    rowId: string,
    action: MergeAction,
    targetRowId: string | null,
    mergedAt: number,
): void {
    db.prepare(
        `INSERT INTO identity_merge_log
            (from_identity, to_identity, table_name, row_id, action, target_row_id, merged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(fromIdentity, toIdentity, tableName, rowId, action, targetRowId, mergedAt);
}

function mergeMemoryRow(
    db: Database,
    row: SqliteRow,
    fromIdentity: string,
    toIdentity: string,
    mergedAt: number,
): boolean {
    const sourceId = row.id;
    if (typeof sourceId !== "number") return false;
    const collision = db
        .prepare(
            `SELECT *
               FROM memories
              WHERE project_path = ? AND category = ? AND normalized_hash = ? AND id <> ?
              LIMIT 1`,
        )
        .get(toIdentity, row.category, row.normalized_hash, sourceId) as SqliteRow | undefined;
    if (collision && typeof collision.id === "number") {
        const targetId = collision.id;
        const targetSeen = Number(collision.seen_count ?? 1);
        const mergedSeen = Math.max(targetSeen, Number(row.seen_count ?? 1));
        const sourceClassifiedAt = Number(row.classified_at ?? 0);
        const targetClassifiedAt = Number(collision.classified_at ?? 0);
        if (sourceClassifiedAt > targetClassifiedAt) {
            db.prepare(
                `UPDATE memories
                     SET importance = ?, scope = ?, shareable = ?, classified_at = ?, updated_at = ?
                   WHERE id = ?`,
            ).run(row.importance, row.scope, row.shareable, row.classified_at, mergedAt, targetId);
        }
        const sourceHasCue = typeof row.mural_cue === "string" && row.mural_cue.length > 0;
        const targetHasCue =
            typeof collision.mural_cue === "string" && collision.mural_cue.length > 0;
        const sourceCueAt = Number(row.mural_cue_at ?? 0);
        const targetCueAt = Number(collision.mural_cue_at ?? 0);
        if (sourceHasCue && (!targetHasCue || sourceCueAt > targetCueAt)) {
            db.prepare(
                `UPDATE memories
                     SET mural_cue = ?, mural_cue_hash = ?, mural_cue_at = ?,
                         mural_cue_rejection_count = ?, updated_at = ?
                   WHERE id = ?`,
            ).run(
                row.mural_cue,
                row.mural_cue_hash,
                row.mural_cue_at,
                row.mural_cue_rejection_count,
                mergedAt,
                targetId,
            );
        }
        db.prepare(
            `INSERT INTO memory_verifications
                 (memory_id, file_path, verified_at, mapped_at, mapping_origin)
              SELECT ?, file_path, verified_at, mapped_at, mapping_origin
                FROM memory_verifications
               WHERE memory_id = ?
              ON CONFLICT(memory_id, file_path) DO UPDATE SET
                 verified_at = MAX(memory_verifications.verified_at, excluded.verified_at),
                 mapped_at = MAX(memory_verifications.mapped_at, excluded.mapped_at),
                 mapping_origin = CASE
                     WHEN excluded.mapped_at >= memory_verifications.mapped_at
                         THEN excluded.mapping_origin
                     ELSE memory_verifications.mapping_origin
                 END`,
        ).run(targetId, sourceId);
        db.prepare("DELETE FROM memory_verifications WHERE memory_id = ?").run(sourceId);
        if (
            mergedSeen !== targetSeen ||
            collision.status === null ||
            collision.status === undefined
        ) {
            db.prepare(
                "UPDATE memories SET seen_count = ?, status = COALESCE(status, 'active'), updated_at = ? WHERE id = ?",
            ).run(mergedSeen, mergedAt, targetId);
        }
        db.prepare(
            `UPDATE memories
                SET status = 'archived',
                    superseded_by_memory_id = ?,
                    merged_from = CASE
                        WHEN merged_from IS NULL OR merged_from = '' THEN ?
                        ELSE merged_from || ',' || ?
                    END,
                    updated_at = ?
              WHERE id = ? AND project_path = ?`,
        ).run(targetId, String(sourceId), "identity-merge", mergedAt, sourceId, fromIdentity);
        db.prepare(
            `INSERT INTO memory_mutation_log
                (project_path, mutation_type, target_memory_id, superseded_by_id, category, queued_at)
             VALUES (?, 'superseded', ?, ?, ?, ?)`,
        ).run(fromIdentity, sourceId, targetId, row.category, mergedAt);
        logRow(
            db,
            fromIdentity,
            toIdentity,
            "memories",
            String(sourceId),
            "superseded",
            String(targetId),
            mergedAt,
        );
        return true;
    }

    const result = db
        .prepare(
            "UPDATE memories SET project_path = ?, updated_at = ? WHERE id = ? AND project_path = ?",
        )
        .run(toIdentity, mergedAt, sourceId, fromIdentity) as { changes?: number };
    if ((result.changes ?? 0) === 0) return false;
    logRow(db, fromIdentity, toIdentity, "memories", String(sourceId), "rekeyed", null, mergedAt);
    return true;
}

function nullableMaximum(left: unknown, right: unknown): number | null {
    const values = [left, right].filter((value): value is number => typeof value === "number");
    return values.length > 0 ? Math.max(...values) : null;
}

function oldestOpenCycleStart(left: unknown, right: unknown): number | null {
    const values = [left, right].filter(
        (value): value is number => typeof value === "number" && value > 0,
    );
    return values.length > 0 ? Math.min(...values) : null;
}

function reconcileTaskScheduleCollision(db: Database, source: SqliteRow, target: SqliteRow): void {
    const sourceIsNewer =
        typeof source.last_run_at === "number" &&
        (typeof target.last_run_at !== "number" || source.last_run_at > target.last_run_at);
    const latest = sourceIsNewer ? source : target;

    // Take schedule outcome fields from the newest completed run. Merge progress
    // independently: retrospective checks keep the furthest completed position, while
    // an active broad verification pass keeps its earliest start. This preserves
    // completed checks as newer than the pass watermark when identities are merged.
    db.prepare(
        `UPDATE task_schedule_state
            SET last_run_at = ?, next_due_at = ?, schedule = ?, last_status = ?,
                last_error = ?, retry_count = ?, last_checked_commit = ?,
                last_broad_run_at = ?, retrospective_watermark_ms = ?
          WHERE project_path = ? AND task = ?`,
    ).run(
        nullableMaximum(source.last_run_at, target.last_run_at),
        latest.next_due_at,
        latest.schedule,
        latest.last_status,
        latest.last_error,
        latest.retry_count,
        latest.last_checked_commit,
        oldestOpenCycleStart(source.last_broad_run_at, target.last_broad_run_at),
        nullableMaximum(source.retrospective_watermark_ms, target.retrospective_watermark_ms),
        target.project_path,
        target.task,
    );
}

function rekeyGenericRow(
    db: Database,
    table: TableInfo,
    row: SqliteRow,
    fromIdentity: string,
    toIdentity: string,
    mergedAt: number,
): boolean {
    const rowId = rowKey(db, table.name, row);
    const collision = findUniqueCollision(db, table, row, fromIdentity, toIdentity);
    if (collision) {
        if (table.name === "task_schedule_state") {
            reconcileTaskScheduleCollision(db, row, collision);
        }
        const sourcePredicate = rowPredicate(db, table.name, row);
        const result = db
            .prepare(`DELETE FROM ${quoteIdentifier(table.name)} WHERE ${sourcePredicate.sql}`)
            .run(...sourcePredicate.values) as { changes?: number };
        if ((result.changes ?? 0) === 0) return false;
        logRow(
            db,
            fromIdentity,
            toIdentity,
            table.name,
            rowId,
            "collision_deleted",
            rowKey(db, table.name, collision),
            mergedAt,
        );
        return true;
    }

    const predicate = rowPredicate(db, table.name, row);
    const result = db
        .prepare(
            `UPDATE ${quoteIdentifier(table.name)}
                SET ${quoteIdentifier(table.identityColumn)} = ?
              WHERE ${predicate.sql}
                AND ${quoteIdentifier(table.identityColumn)} = ?`,
        )
        .run(toIdentity, ...predicate.values, fromIdentity) as { changes?: number };
    if ((result.changes ?? 0) === 0) return false;
    logRow(db, fromIdentity, toIdentity, table.name, rowId, "rekeyed", null, mergedAt);
    return true;
}

function tableSourceRows(db: Database, table: TableInfo, fromIdentity: string): SqliteRow[] {
    return db
        .prepare(
            `SELECT rowid, * FROM ${quoteIdentifier(table.name)} WHERE ${quoteIdentifier(table.identityColumn)} = ?`,
        )
        .all(fromIdentity) as SqliteRow[];
}

function assertMergeAllowed(db: Database, fromIdentity: string, toIdentity: string): void {
    if (!tableExists(db, "authority_managed")) return;
    const source = db
        .prepare("SELECT 1 FROM authority_managed WHERE project_path = ? LIMIT 1")
        .get(fromIdentity);
    if (source) {
        throw new Error(
            `Refusing identity merge: ${fromIdentity} is managed by the Rust module. Drain module authority before re-keying; module-store re-keying is not in scope.`,
        );
    }
    const target = db
        .prepare("SELECT 1 FROM authority_managed WHERE project_path = ? LIMIT 1")
        .get(toIdentity);
    if (target) {
        throw new Error(
            `Refusing identity merge: ${toIdentity} is managed by the Rust module. Module-owned target pools cannot be re-keyed by this command.`,
        );
    }
}

export function auditIdentityMerge(
    db: Database,
    fromIdentity: string,
    toIdentity: string,
): IdentityMergeReport {
    const auditedTables = discoverIdentityTables(db).map((table) => ({
        tableName: table.name,
        identityColumn: table.identityColumn,
        derived: table.derived,
        sourceRows: table.derived ? 0 : tableSourceRows(db, table, fromIdentity).length,
        changedRows: 0,
    }));
    return {
        fromIdentity,
        toIdentity,
        auditedTables,
        changedRows: auditedTables.reduce((total, table) => total + table.sourceRows, 0),
        dryRun: true,
    };
}

export function mergeProjectIdentities(
    db: Database,
    fromIdentity: string,
    toIdentity: string,
    options: { dryRun?: boolean; now?: number } = {},
): IdentityMergeReport {
    if (!fromIdentity.trim() || !toIdentity.trim()) {
        throw new Error("Both source and target identities are required.");
    }
    if (fromIdentity === toIdentity) {
        throw new Error("Source and target identities must be different.");
    }
    assertMergeAllowed(db, fromIdentity, toIdentity);
    const tables = discoverIdentityTables(db);
    const report = auditIdentityMerge(db, fromIdentity, toIdentity);
    if (options.dryRun) return report;

    const mergedAt = options.now ?? Date.now();
    const run = db
        .transaction(() => {
            // v22's identity-level map remains useful for legacy consumers; the row-level
            // log below is the authoritative audit trail for this command.
            if (tableExists(db, "v22_identity_rekey_map")) {
                db.prepare(
                    `INSERT INTO v22_identity_rekey_map (old_project_path, new_project_path, rekeyed_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(old_project_path) DO UPDATE SET
                    new_project_path = excluded.new_project_path,
                    rekeyed_at = excluded.rekeyed_at`,
                ).run(fromIdentity, toIdentity, mergedAt);
            }

            for (const table of tables) {
                const tableReport = report.auditedTables.find(
                    (candidate) => candidate.tableName === table.name,
                );
                if (!tableReport || table.derived) continue;
                const rows = tableSourceRows(db, table, fromIdentity);
                tableReport.sourceRows = rows.length;
                for (const row of rows) {
                    const changed =
                        table.name === "memories"
                            ? mergeMemoryRow(db, row, fromIdentity, toIdentity, mergedAt)
                            : rekeyGenericRow(db, table, row, fromIdentity, toIdentity, mergedAt);
                    if (changed) tableReport.changedRows += 1;
                }
            }

            db.prepare(
                `INSERT INTO project_state
                (project_path, project_memory_epoch, project_user_profile_version, updated_at)
             VALUES (?, 1, 0, ?)
             ON CONFLICT(project_path) DO UPDATE SET
                project_memory_epoch = project_memory_epoch + 1,
                updated_at = excluded.updated_at`,
            ).run(toIdentity, mergedAt);
        })
        .immediate();
    void run;

    return {
        ...report,
        auditedTables: report.auditedTables,
        changedRows: report.auditedTables.reduce((total, table) => total + table.changedRows, 0),
        dryRun: false,
    };
}
