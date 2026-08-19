import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    ProjectIdentityError,
    resolveProjectIdentity,
    resolveProjectIdentityStrict,
} from "./memory/project-identity";
import { rekeyMemoryRowWithCollisionMerge } from "./memory/relocate-memory";
import type { V22BackfillErrorClass } from "./storage-v22-backfill-failures";

export const BATCH_SIZE = 25;
export const YIELD_EVERY_N_ROWS = 5;

const BACKFILL_META_KEY = "v22_legacy_memory_backfill";
const BACKFILL_CURSOR_META_KEY = "v22_legacy_memory_backfill_cursor";
const MEMORIES_TABLE = "memories";

type V22BackfillStatus = "pending" | "completed" | "completed_with_failures" | "skipped";

interface LegacyMemoryRow {
    id: number;
    project_path: string;
    category: string;
    normalized_hash: string;
    seen_count: number;
}

interface ResolvedBackfillRow extends LegacyMemoryRow {
    identity: string;
}

interface FailedBackfillRow extends LegacyMemoryRow {
    errorClass: V22BackfillErrorClass;
    errorMessage: string;
}

export interface V22BackfillSummary {
    status: V22BackfillStatus;
    processedRows: number;
    changedRows: number;
    failedRows: number;
    failureCount: number;
    lastCursor: number;
}

export interface DeferredV22BackfillOptions {
    resolveIdentity?: (rawProjectPath: string) => string;
    yieldToEventLoop?: () => Promise<void>;
    onBatchResolved?: (batch: readonly LegacyMemoryRow[]) => void | Promise<void>;
}

function defaultYieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

function readMeta(db: Database, key: string): string | null {
    const row = db.prepare("SELECT value FROM schema_migrations_meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
    return row?.value ?? null;
}

function writeMeta(db: Database, key: string, value: string): void {
    db.prepare(
        `INSERT INTO schema_migrations_meta (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
}

function parseCursor(value: string | null): number {
    const parsed = Number.parseInt(value ?? "0", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function countFailures(db: Database): number {
    const row = db.prepare("SELECT COUNT(*) AS count FROM v22_backfill_failures").get() as {
        count: number;
    };
    return row.count;
}

function classifyBackfillError(error: unknown): {
    errorClass: V22BackfillErrorClass;
    errorMessage: string;
} {
    if (error instanceof ProjectIdentityError) {
        return {
            errorClass: error.errorClass === "dubious_ownership" ? "unknown" : error.errorClass,
            errorMessage: error.message,
        };
    }
    if (error instanceof Error) {
        return { errorClass: "unknown", errorMessage: error.message };
    }
    return { errorClass: "unknown", errorMessage: String(error) };
}

function resolveBackfillIdentity(rawProjectPath: string): string {
    try {
        return resolveProjectIdentityStrict(rawProjectPath);
    } catch (error) {
        if (error instanceof ProjectIdentityError && error.errorClass === "not_git_repo") {
            return resolveProjectIdentity(rawProjectPath);
        }
        throw error;
    }
}

export function computeLegacyRustDirIdentity(rawProjectPath: string): string {
    let canonical: string;
    try {
        canonical = realpathSync(rawProjectPath);
    } catch {
        canonical = path.isAbsolute(rawProjectPath)
            ? rawProjectPath
            : path.join(process.cwd(), rawProjectPath);
    }
    return `dir:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function upsertRekeyMap(
    db: Database,
    oldProjectPath: string,
    newProjectPath: string,
    rekeyedAt: number,
): void {
    db.prepare(
        `INSERT INTO v22_identity_rekey_map (old_project_path, new_project_path, rekeyed_at)
         VALUES (?, ?, ?)
         ON CONFLICT(old_project_path) DO UPDATE SET
            new_project_path = excluded.new_project_path,
            rekeyed_at = excluded.rekeyed_at`,
    ).run(oldProjectPath, newProjectPath, rekeyedAt);
}

function recordFailure(db: Database, failure: FailedBackfillRow, failedAt: number): void {
    db.prepare(
        `INSERT INTO v22_backfill_failures
            (table_name, row_id, raw_project_path, error_class, error_message, failed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(table_name, row_id) DO UPDATE SET
            raw_project_path = excluded.raw_project_path,
            error_class = excluded.error_class,
            error_message = excluded.error_message,
            failed_at = excluded.failed_at`,
    ).run(
        MEMORIES_TABLE,
        failure.id,
        failure.project_path,
        failure.errorClass,
        failure.errorMessage,
        failedAt,
    );
}

function deleteFailure(db: Database, rowId: number): void {
    db.prepare("DELETE FROM v22_backfill_failures WHERE table_name = ? AND row_id = ?").run(
        MEMORIES_TABLE,
        rowId,
    );
}

function bumpProjectMemoryEpochInTransaction(db: Database, identity: string, now: number): void {
    db.prepare(
        `INSERT INTO project_state
            (project_path, project_memory_epoch, project_user_profile_version, updated_at)
         VALUES (?, 1, 0, ?)
         ON CONFLICT(project_path) DO UPDATE SET
            project_memory_epoch = project_memory_epoch + 1,
            updated_at = excluded.updated_at`,
    ).run(identity, now);
}

function updateFinalBackfillStatus(db: Database): V22BackfillStatus {
    const failureCount = countFailures(db);
    const status: V22BackfillStatus = failureCount > 0 ? "completed_with_failures" : "completed";
    writeMeta(db, BACKFILL_META_KEY, status);
    return status;
}

export function getV22BackfillStatus(db: Database): {
    status: V22BackfillStatus | "missing";
    failureCount: number;
    cursor: number;
    maxLegacyMemoryId: number;
} {
    const status = readMeta(db, BACKFILL_META_KEY) as V22BackfillStatus | null;
    const maxLegacyRow = db
        .prepare(
            `SELECT COALESCE(MAX(id), 0) AS m
             FROM memories
             WHERE project_path NOT LIKE 'git:%'
               AND project_path NOT LIKE 'dir:%'`,
        )
        .get() as { m: number };
    return {
        status: status ?? "missing",
        failureCount: countFailures(db),
        cursor: parseCursor(readMeta(db, BACKFILL_CURSOR_META_KEY)),
        maxLegacyMemoryId: maxLegacyRow.m,
    };
}

export async function runDeferredV22Backfill(
    db: Database,
    options: DeferredV22BackfillOptions = {},
): Promise<V22BackfillSummary> {
    const initialStatus = readMeta(db, BACKFILL_META_KEY);
    if (initialStatus === "completed" || initialStatus === "skipped") {
        return {
            status: initialStatus,
            processedRows: 0,
            changedRows: 0,
            failedRows: 0,
            failureCount: countFailures(db),
            lastCursor: parseCursor(readMeta(db, BACKFILL_CURSOR_META_KEY)),
        };
    }

    if (initialStatus === null) {
        return {
            status: "skipped",
            processedRows: 0,
            changedRows: 0,
            failedRows: 0,
            failureCount: 0,
            lastCursor: 0,
        };
    }

    const resolveIdentity = options.resolveIdentity ?? resolveBackfillIdentity;
    const yieldToEventLoop = options.yieldToEventLoop ?? defaultYieldToEventLoop;
    let lastCursor = parseCursor(readMeta(db, BACKFILL_CURSOR_META_KEY));
    let processedRows = 0;
    let changedRows = 0;
    let failedRows = 0;

    await yieldToEventLoop();

    while (true) {
        const batch = db
            .prepare(
                `SELECT id, project_path, category, normalized_hash, seen_count
                 FROM memories
                 WHERE id > ?
                   AND project_path NOT LIKE 'git:%'
                   AND project_path NOT LIKE 'dir:%'
                 ORDER BY id ASC
                 LIMIT ?`,
            )
            .all(lastCursor, BATCH_SIZE) as LegacyMemoryRow[];

        if (batch.length === 0) break;

        const resolvedRows: ResolvedBackfillRow[] = [];
        const failedBatchRows: FailedBackfillRow[] = [];

        for (let index = 0; index < batch.length; index += 1) {
            const row = batch[index];
            try {
                resolvedRows.push({ ...row, identity: resolveIdentity(row.project_path) });
            } catch (error) {
                const classified = classifyBackfillError(error);
                failedBatchRows.push({ ...row, ...classified });
            }

            if ((index + 1) % YIELD_EVERY_N_ROWS === 0 && index + 1 < batch.length) {
                await yieldToEventLoop();
            }
        }

        await options.onBatchResolved?.(batch);

        const finalCursor = batch[batch.length - 1]?.id ?? lastCursor;
        const changedIdentities = new Set<string>();

        db.transaction(() => {
            const now = Date.now();
            const updateMemory = db.prepare(
                "UPDATE memories SET project_path = ? WHERE id = ? AND project_path = ?",
            );
            const verifyMemory = db.prepare(
                "SELECT project_path FROM memories WHERE id = ? AND project_path = ?",
            );
            // Detect a row that already lives under the target identity with the
            // same (category, normalized_hash). Rekeying onto it would violate
            // UNIQUE(project_path, category, normalized_hash) and abort the whole
            // batch transaction. This is reachable when one project's memories were
            // written under multiple raw legacy paths (e.g. symlinked / pre-identity
            // paths) that all resolve to the same git:/dir: identity.
            const findCollision = db.prepare(
                `SELECT id, seen_count FROM memories
                 WHERE project_path = ? AND category = ? AND normalized_hash = ?
                 LIMIT 1`,
            );
            const bumpSeenCount = db.prepare("UPDATE memories SET seen_count = ? WHERE id = ?");
            // Preserve an embedding on the surviving target BEFORE the source row's
            // embedding FK-cascades away on DELETE. Same fix as the live
            // collision-merge path (rekeyMemoryRowWithCollisionMerge): the two rows
            // are content-equivalent (same category + normalized_hash), so either
            // vector is valid; INSERT OR IGNORE keeps the target's if it has one,
            // adopts the source's otherwise — so a merged row never loses its vector.
            const preserveEmbedding = db.prepare(
                `INSERT OR IGNORE INTO memory_embeddings (memory_id, embedding, model_id)
                 SELECT ?, embedding, model_id FROM memory_embeddings WHERE memory_id = ?`,
            );
            const preserveEvidence = db.prepare(
                `INSERT OR IGNORE INTO memory_evidence (
                    memory_id, content_hash, source_session_id, source_message_id, source_type, observed_at
                 )
                 SELECT ?, content_hash, source_session_id, source_message_id, source_type, observed_at
                   FROM memory_evidence WHERE memory_id = ?`,
            );
            const evidenceCount = db.prepare(
                "SELECT COUNT(DISTINCT source_session_id) AS count FROM memory_evidence WHERE memory_id = ?",
            );
            const deleteMemoryRow = db.prepare("DELETE FROM memories WHERE id = ?");

            for (const row of resolvedRows) {
                const collision = findCollision.get(
                    row.identity,
                    row.category,
                    row.normalized_hash,
                ) as { id: number; seen_count: number } | undefined;
                if (collision && collision.id !== row.id) {
                    // Merge into the surviving target: keep the larger seen_count,
                    // delete the source legacy row. The embedding row FK-cascades on
                    // delete. The mutation log is unaffected (no render-visible
                    // change — both rows held identical content).
                    preserveEvidence.run(collision.id, row.id);
                    const count = evidenceCount.get(collision.id) as { count?: number } | undefined;
                    const mergedSeen = Math.max(
                        collision.seen_count ?? 1,
                        row.seen_count ?? 1,
                        count?.count ?? 0,
                    );
                    if (mergedSeen !== (collision.seen_count ?? 1)) {
                        bumpSeenCount.run(mergedSeen, collision.id);
                    }
                    preserveEmbedding.run(collision.id, row.id);
                    deleteMemoryRow.run(row.id);
                    changedRows += 1;
                    changedIdentities.add(row.identity);
                    upsertRekeyMap(db, row.project_path, row.identity, now);
                    const legacyRustIdentity = computeLegacyRustDirIdentity(row.project_path);
                    if (legacyRustIdentity !== row.identity) {
                        upsertRekeyMap(db, legacyRustIdentity, row.identity, now);
                    }
                    deleteFailure(db, row.id);
                    continue;
                }
                const result = updateMemory.run(row.identity, row.id, row.project_path) as {
                    changes?: number;
                };
                if ((result.changes ?? 0) > 0) {
                    changedRows += 1;
                    changedIdentities.add(row.identity);
                    upsertRekeyMap(db, row.project_path, row.identity, now);
                    const legacyRustIdentity = computeLegacyRustDirIdentity(row.project_path);
                    if (legacyRustIdentity !== row.identity) {
                        upsertRekeyMap(db, legacyRustIdentity, row.identity, now);
                    }
                    deleteFailure(db, row.id);
                }
            }

            for (const failure of failedBatchRows) {
                const stillSame = verifyMemory.get(failure.id, failure.project_path);
                if (stillSame) {
                    recordFailure(db, failure, now);
                    failedRows += 1;
                }
            }

            for (const identity of changedIdentities) {
                bumpProjectMemoryEpochInTransaction(db, identity, now);
            }

            writeMeta(db, BACKFILL_CURSOR_META_KEY, String(finalCursor));
        }).immediate();

        processedRows += batch.length;
        lastCursor = finalCursor;
        await yieldToEventLoop();
    }

    const status = updateFinalBackfillStatus(db);
    const failureCount = countFailures(db);
    if (failureCount > 0) {
        log(
            `[v22-backfill] completed with ${failureCount} unresolved failure(s); run doctor --retry-v22-backfill`,
        );
    } else {
        log(`[v22-backfill] completed; processed=${processedRows}, changed=${changedRows}`);
    }

    return {
        status,
        processedRows,
        changedRows,
        failedRows,
        failureCount,
        lastCursor,
    };
}

export async function doctorRetryV22Backfill(db: Database): Promise<{
    attempted: number;
    succeeded: number;
    failed: number;
    skipped: number;
    status: V22BackfillStatus;
}> {
    const failures = db
        .prepare(
            `SELECT row_id, raw_project_path
             FROM v22_backfill_failures
             WHERE table_name = ?
             ORDER BY row_id ASC`,
        )
        .all(MEMORIES_TABLE) as Array<{ row_id: number; raw_project_path: string }>;

    if (failures.length === 0) {
        return {
            attempted: 0,
            succeeded: 0,
            failed: 0,
            skipped: 0,
            status: updateFinalBackfillStatus(db),
        };
    }

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (const failure of failures) {
        try {
            const identity = resolveBackfillIdentity(failure.raw_project_path);
            db.transaction(() => {
                const now = Date.now();
                const current = db
                    .prepare("SELECT project_path FROM memories WHERE id = ?")
                    .get(failure.row_id) as { project_path: string } | undefined;

                if (!current || current.project_path !== failure.raw_project_path) {
                    deleteFailure(db, failure.row_id);
                    skipped += 1;
                    return;
                }

                // Collision-aware rekey: a blind UPDATE here aborts on
                // UNIQUE(project_path, category, normalized_hash) when the
                // target identity already holds an equivalent memory, leaving
                // the failure permanently unrepairable via doctor.
                const changed = rekeyMemoryRowWithCollisionMerge(
                    db,
                    failure.row_id,
                    failure.raw_project_path,
                    identity,
                );

                if (changed) {
                    upsertRekeyMap(db, failure.raw_project_path, identity, now);
                    const legacyRustIdentity = computeLegacyRustDirIdentity(
                        failure.raw_project_path,
                    );
                    if (legacyRustIdentity !== identity) {
                        upsertRekeyMap(db, legacyRustIdentity, identity, now);
                    }
                    deleteFailure(db, failure.row_id);
                    bumpProjectMemoryEpochInTransaction(db, identity, now);
                    succeeded += 1;
                }
            })();
        } catch (error) {
            const classified = classifyBackfillError(error);
            db.prepare(
                `UPDATE v22_backfill_failures
                 SET error_class = ?, error_message = ?, failed_at = ?
                 WHERE table_name = ? AND row_id = ?`,
            ).run(
                classified.errorClass,
                classified.errorMessage,
                Date.now(),
                MEMORIES_TABLE,
                failure.row_id,
            );
            failed += 1;
        }
    }

    return {
        attempted: failures.length,
        succeeded,
        failed,
        skipped,
        status: updateFinalBackfillStatus(db),
    };
}

export async function doctorRekeyV22DirIdentity(
    db: Database,
    rawProjectPath: string,
): Promise<{ oldIdentity: string; newIdentity: string; changedRows: number }> {
    const newIdentity = resolveBackfillIdentity(rawProjectPath);
    const oldIdentity = computeLegacyRustDirIdentity(rawProjectPath);
    let changedRows = 0;

    db.transaction(() => {
        const now = Date.now();
        // Per-row collision-aware rekey: a bulk
        // `UPDATE ... WHERE project_path = oldIdentity` aborts the whole
        // transaction on UNIQUE(project_path, category, normalized_hash) when
        // some rows collide with memories already under newIdentity. Iterate so
        // colliding rows merge instead of poisoning the batch.
        const rowIds = (
            db.prepare("SELECT id FROM memories WHERE project_path = ?").all(oldIdentity) as Array<{
                id: number;
            }>
        ).map((r) => r.id);
        upsertRekeyMap(db, oldIdentity, newIdentity, now);
        for (const rowId of rowIds) {
            if (rekeyMemoryRowWithCollisionMerge(db, rowId, oldIdentity, newIdentity)) {
                changedRows += 1;
            }
        }
        if (changedRows > 0) {
            bumpProjectMemoryEpochInTransaction(db, newIdentity, now);
        }
    })();

    return { oldIdentity, newIdentity, changedRows };
}
