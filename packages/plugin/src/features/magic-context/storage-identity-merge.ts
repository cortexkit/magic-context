import type { Database } from "../../shared/sqlite";
import { nextDueAtMs } from "./dreamer/cron";

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
    duplicateMemoryIds: number[];
    reviewMemoryIds: number[];
    changes: string[];
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

function normalizedContent(value: unknown): string {
    return String(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function mergeMemoryRow(
    db: Database,
    row: SqliteRow,
    fromIdentity: string,
    toIdentity: string,
    mergedAt: number,
    review: boolean,
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
    if (collision && normalizedContent(collision.content) !== normalizedContent(row.content)) {
        // A stale or colliding hash is not permission to discard different content.
        db.prepare(
            "UPDATE memories SET normalized_hash = ?, metadata_json = json_set(CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END, '$.identity_merge_original_hash', ?, '$.identity_merge_review', ?) WHERE id = ?",
        ).run(
            `${row.normalized_hash}:identity-conflict:${sourceId}`,
            row.normalized_hash,
            fromIdentity,
            sourceId,
        );
        review = true;
    } else if (collision && typeof collision.id === "number") {
        const targetId = collision.id;
        const targetSeen = Number(collision.seen_count ?? 1);
        const mergedSeen = targetSeen + Number(row.seen_count ?? 1);
        const sourceClassifiedAt = Number(row.classified_at ?? 0);
        const targetClassifiedAt = Number(collision.classified_at ?? 0);
        if (sourceClassifiedAt > targetClassifiedAt) {
            // Importance, scope, and shareable are the memory's scored meaning.
            // Copying a newer classification is an edit of that meaning, so the
            // survivor's updated_at moves. A newer stamp with the same scores is
            // bookkeeping and must not look like the text was edited.
            const meaningChanged =
                collision.importance !== row.importance ||
                collision.scope !== row.scope ||
                Number(collision.shareable ?? 0) !== Number(row.shareable ?? 0);
            db.prepare(
                meaningChanged
                    ? `UPDATE memories
                         SET importance = ?, scope = ?, shareable = ?, classified_at = ?,
                             updated_at = ?
                       WHERE id = ?`
                    : `UPDATE memories
                         SET importance = ?, scope = ?, shareable = ?, classified_at = ?
                       WHERE id = ?`,
            ).run(
                row.importance,
                row.scope,
                row.shareable,
                row.classified_at,
                ...(meaningChanged ? [mergedAt] : []),
                targetId,
            );
        }
        const sourceHasCue = typeof row.mural_cue === "string" && row.mural_cue.length > 0;
        const targetHasCue =
            typeof collision.mural_cue === "string" && collision.mural_cue.length > 0;
        const sourceCueAt = Number(row.mural_cue_at ?? 0);
        const targetCueAt = Number(collision.mural_cue_at ?? 0);
        if (sourceHasCue && (!targetHasCue || sourceCueAt > targetCueAt)) {
            // A mural cue is a derived render cache of the memory text, not the
            // text or its scored meaning. Copying it must not look like an edit.
            db.prepare(
                `UPDATE memories
                     SET mural_cue = ?, mural_cue_hash = ?, mural_cue_at = ?,
                         mural_cue_rejection_count = ?
                   WHERE id = ?`,
            ).run(
                row.mural_cue,
                row.mural_cue_hash,
                row.mural_cue_at,
                row.mural_cue_rejection_count,
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
            // seen_count is usage bookkeeping. updated_at moves only when the
            // survivor's status itself changes (for example a null status becoming
            // active), because that changes what the memory means in the live pool.
            db.prepare(
                `UPDATE memories
                    SET seen_count = ?,
                        status = CASE
                            WHEN ? = 'active' THEN 'active'
                            ELSE COALESCE(status, 'active')
                        END,
                        updated_at = CASE
                            WHEN status IS NOT (
                                CASE
                                    WHEN ? = 'active' THEN 'active'
                                    ELSE COALESCE(status, 'active')
                                END
                            ) THEN ?
                            ELSE updated_at
                        END
                  WHERE id = ?`,
            ).run(mergedSeen, row.status, row.status, mergedAt, targetId);
        }
        db.prepare(
            `UPDATE memories SET first_seen_at = MIN(first_seen_at, ?), last_seen_at = MAX(last_seen_at, ?), retrieval_count = COALESCE(retrieval_count, 0) + ?, merged_from = CASE WHEN merged_from IS NULL OR merged_from = '' THEN ? ELSE merged_from || ',' || ? END WHERE id = ?`,
        ).run(
            row.first_seen_at,
            row.last_seen_at,
            Number(row.retrieval_count ?? 0),
            String(sourceId),
            String(sourceId),
            targetId,
        );
        // Archiving the duplicate and pointing it at the survivor changes its
        // lifecycle meaning: it is no longer the live claim. That is an edit.
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

    if (review) {
        db.prepare(
            "UPDATE memories SET metadata_json = json_set(CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END, '$.identity_merge_review', ?) WHERE id = ?",
        ).run(fromIdentity, sourceId);
    }
    // Moving a memory onto its project's new id does not change the memory.
    // Leaving updated_at alone keeps a re-key from looking like an edit.
    const result = db
        .prepare("UPDATE memories SET project_path = ? WHERE id = ? AND project_path = ?")
        .run(toIdentity, sourceId, fromIdentity) as { changes?: number };
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

function reconcileTaskScheduleCollision(
    db: Database,
    source: SqliteRow,
    target: SqliteRow,
    mergedAt: number,
): void {
    const sourceIsNewer =
        source.last_status === "completed" &&
        (target.last_status !== "completed" ||
            (typeof source.last_run_at === "number" &&
                (typeof target.last_run_at !== "number" ||
                    source.last_run_at > target.last_run_at)));
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
        latest.last_run_at,
        nextDueAtMs(
            String(target.schedule ?? ""),
            Math.max(mergedAt, Number(source.last_run_at ?? 0), Number(target.last_run_at ?? 0)),
        ),
        target.schedule,
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
            reconcileTaskScheduleCollision(db, row, collision, mergedAt);
        }
        const maximumColumns: Record<string, string[]> = {
            retrospective_processed_windows: ["processed_at"],
            embedding_identity_active: ["last_active_at"],
            memory_embedding_watermarks: ["written_memory_id", "embedded_memory_id", "updated_at"],
            project_state: ["project_memory_epoch", "project_user_profile_version", "updated_at"],
            project_key_files_version: ["version"],
        };
        const columns = maximumColumns[table.name];
        if (columns) {
            const targetPredicate = rowPredicate(db, table.name, collision);
            db.prepare(
                `UPDATE ${quoteIdentifier(table.name)} SET ${columns.map((column) => `${quoteIdentifier(column)} = ?`).join(", ")} WHERE ${targetPredicate.sql}`,
            ).run(
                ...columns.map((column) => nullableMaximum(row[column], collision[column])),
                ...targetPredicate.values,
            );
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

    if (table.name === "task_schedule_state") {
        db.prepare(
            "UPDATE task_schedule_state SET next_due_at = ? WHERE project_path = ? AND task = ?",
        ).run(
            nextDueAtMs(
                String(row.schedule ?? ""),
                Math.max(mergedAt, Number(row.last_run_at ?? 0)),
            ),
            fromIdentity,
            row.task,
        );
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

function sourceRowsWhere(table: TableInfo): string {
    return `WHERE ${quoteIdentifier(table.identityColumn)} = ?${table.name === "memories" ? " AND NOT (status = 'archived' AND superseded_by_memory_id IS NOT NULL AND EXISTS (SELECT 1 FROM identity_merge_log l WHERE l.table_name = 'memories' AND l.row_id = CAST(memories.id AS TEXT) AND l.from_identity = memories.project_path AND l.action = 'superseded'))" : ""}`;
}

function tableSourceRows(db: Database, table: TableInfo, fromIdentity: string): SqliteRow[] {
    return db
        .prepare(`SELECT rowid, * FROM ${quoteIdentifier(table.name)} ${sourceRowsWhere(table)}`)
        .all(fromIdentity) as SqliteRow[];
}

/**
 * Rows an identity owns in every non-derived table keyed by project identity: the rows a
 * merge from this identity would move. Memories already merged away (archived and
 * superseded under the merge log) are not counted.
 */
export function countIdentityRows(db: Database, identity: string): number {
    let total = 0;
    for (const table of discoverIdentityTables(db)) {
        if (table.derived) continue;
        const row = db
            .prepare(
                `SELECT COUNT(*) AS n FROM ${quoteIdentifier(table.name)} ${sourceRowsWhere(table)}`,
            )
            .get(identity) as { n: number };
        total += Number(row.n);
    }
    return total;
}

function assertMergeAllowed(db: Database, fromIdentity: string, toIdentity: string): void {
    const memberships = db
        .prepare(
            `SELECT m.project_path, w.id, w.name FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.project_path IN (?, ?)`,
        )
        .all(fromIdentity, toIdentity) as Array<{ project_path: string; id: number; name: string }>;
    if (memberships.length === 2 && memberships[0].id !== memberships[1].id) {
        throw new Error(
            `Refusing identity merge: different workspaces ${memberships[0].name} and ${memberships[1].name}. Choose membership before merging.`,
        );
    }
    if (!tableExists(db, "authority_managed")) return;
    const source = db
        .prepare("SELECT 1 FROM authority_managed WHERE project_path = ? LIMIT 1")
        .get(fromIdentity);
    if (source) {
        throw new Error(
            `Refusing identity merge: ${fromIdentity} is managed by the Rust module: this project runs in Rust mode and its data lives in the module store. Merging will be possible once the single-store migration lands.`,
        );
    }
    const target = db
        .prepare("SELECT 1 FROM authority_managed WHERE project_path = ? LIMIT 1")
        .get(toIdentity);
    if (target) {
        throw new Error(
            `Refusing identity merge: ${toIdentity} is managed by the Rust module: this project runs in Rust mode and its data lives in the module store. Merging will be possible once the single-store migration lands.`,
        );
    }
}

function memoryDisposition(
    db: Database,
    from: string,
    to: string,
): { duplicateMemoryIds: number[]; reviewMemoryIds: number[] } {
    const duplicateMemoryIds: number[] = [];
    const reviewMemoryIds: number[] = [];
    for (const row of tableSourceRows(
        db,
        { name: "memories", identityColumn: "project_path", derived: false },
        from,
    )) {
        const collision = db
            .prepare(
                "SELECT content FROM memories WHERE project_path = ? AND category = ? AND normalized_hash = ?",
            )
            .get(to, row.category, row.normalized_hash) as { content: string } | undefined;
        if (collision && normalizedContent(collision.content) === normalizedContent(row.content))
            duplicateMemoryIds.push(Number(row.id));
        else if (
            db
                .prepare("SELECT 1 FROM memories WHERE project_path = ? AND category = ? LIMIT 1")
                .get(to, row.category)
        )
            reviewMemoryIds.push(Number(row.id));
    }
    return { duplicateMemoryIds, reviewMemoryIds };
}

export function auditIdentityMerge(
    db: Database,
    fromIdentity: string,
    toIdentity: string,
    now = Date.now(),
): IdentityMergeReport {
    const auditedTables = discoverIdentityTables(db).map((table) => ({
        tableName: table.name,
        identityColumn: table.identityColumn,
        derived: table.derived,
        sourceRows: table.derived ? 0 : tableSourceRows(db, table, fromIdentity).length,
        changedRows: 0,
    }));
    const changes: string[] = [];
    for (const table of discoverIdentityTables(db).filter(
        (table) => !table.derived && table.name !== "memories",
    )) {
        for (const row of tableSourceRows(db, table, fromIdentity)) {
            const collision = findUniqueCollision(db, table, row, fromIdentity, toIdentity);
            if (collision)
                changes.push(
                    `${table.name} ${rowKey(db, table.name, row)}: collapse into ${rowKey(db, table.name, collision)} (target content/configuration retained; progress counters reconciled)`,
                );
            if (table.name === "workspace_members")
                changes.push(
                    `workspace ${row.workspace_id}: ${collision ? "collapse aliases" : "transfer source membership"}`,
                );
            if (table.name === "task_schedule_state") {
                const schedule = String((collision ?? row).schedule ?? "");
                changes.push(
                    `task ${row.task}: schedule ${JSON.stringify(row.schedule)} → ${JSON.stringify(schedule)}; next_due_at → ${nextDueAtMs(schedule, Math.max(now, Number(row.last_run_at ?? 0), Number(collision?.last_run_at ?? 0)))}`,
                );
            }
        }
    }
    const queues = db
        .prepare(
            "SELECT reason, COUNT(*) AS n FROM dream_queue WHERE project_path IN (?, ?) GROUP BY reason HAVING COUNT(*) > 1",
        )
        .all(fromIdentity, toIdentity) as Array<{ reason: string; n: number }>;
    for (const queue of queues)
        changes.push(`dream_queue ${JSON.stringify(queue.reason)}: ${queue.n} → 1 queued row`);
    return {
        fromIdentity,
        toIdentity,
        changes,
        auditedTables,
        changedRows: auditedTables.reduce((total, table) => total + table.sourceRows, 0),
        dryRun: true,
        ...memoryDisposition(db, fromIdentity, toIdentity),
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
    const report = auditIdentityMerge(db, fromIdentity, toIdentity, options.now);
    if (options.dryRun) return report;
    if (report.changedRows === 0) return { ...report, dryRun: false };

    const mergedAt = options.now ?? Date.now();
    const run = db
        .transaction(() => {
            assertMergeAllowed(db, fromIdentity, toIdentity);
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
                            ? mergeMemoryRow(
                                  db,
                                  row,
                                  fromIdentity,
                                  toIdentity,
                                  mergedAt,
                                  report.reviewMemoryIds.includes(Number(row.id)),
                              )
                            : rekeyGenericRow(db, table, row, fromIdentity, toIdentity, mergedAt);
                    if (changed) tableReport.changedRows += 1;
                }
            }

            db.prepare(
                `DELETE FROM dream_queue WHERE project_path = ? AND id NOT IN (SELECT MIN(id) FROM dream_queue WHERE project_path = ? GROUP BY reason)`,
            ).run(toIdentity, toIdentity);
            db.prepare(`UPDATE dream_queue SET started_at = NULL WHERE project_path = ?`).run(
                toIdentity,
            );
            db.prepare(
                `UPDATE git_sweep_coordinator SET lease_holder = NULL, lease_expires_at = NULL, last_swept_at = NULL WHERE project_path = ?`,
            ).run(toIdentity);
            db.prepare(
                `DELETE FROM session_render_cache WHERE cache_key = 'cached_m0_bytes'
                 AND session_id IN (SELECT session_id FROM session_meta WHERE cached_m0_project_identity IN (?, ?))`,
            ).run(fromIdentity, toIdentity);
            db.prepare(
                `UPDATE session_meta SET cached_m0_project_identity = NULL WHERE cached_m0_project_identity IN (?, ?)`,
            ).run(fromIdentity, toIdentity);
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
