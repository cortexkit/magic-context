import { Buffer } from "node:buffer";
import { cancelAutoSearchWork } from "../../shared/auto-search-lifecycle";
import { getHarness } from "../../shared/harness";
import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import {
    type Database,
    withoutSqliteTransformPass,
    withSqliteBackgroundWriter,
} from "../../shared/sqlite";
import { logSlowWriteTransaction } from "../../shared/write-transaction-timing";
import {
    resolveIsSubagentFromOpenCode2Db,
    resolveIsSubagentFromOpenCodeDb,
} from "./resolve-subagent-fallback";
import {
    BOOLEAN_META_KEYS,
    ensureSessionMetaRow,
    getDefaultSessionMeta,
    isSessionMetaRow,
    META_COLUMNS,
    NULL_BIND_META_KEYS,
    SESSION_META_SELECT_COLUMNS,
    toSessionMeta,
} from "./storage-meta-shared";
import { deleteSessionScopedRows } from "./storage-session-tables";
import type { SessionMeta } from "./types";

const SESSION_META_FALLBACK_SELECTS: Partial<
    Record<(typeof SESSION_META_SELECT_COLUMNS)[number], string>
> = {
    cache_ttl: "'5m' AS cache_ttl",
    last_nudge_band: "'' AS last_nudge_band",
    last_transform_error: "'' AS last_transform_error",
    system_prompt_hash: "'' AS system_prompt_hash",
    last_todo_state: "'' AS last_todo_state",
    tool_reclaim_watermark: "0 AS tool_reclaim_watermark",
    cached_m0_bytes: "NULL AS cached_m0_bytes",
    cached_m0_mural_data_url: "NULL AS cached_m0_mural_data_url",
    cached_m0_mural_hash: "NULL AS cached_m0_mural_hash",
    cached_m1_bytes: "NULL AS cached_m1_bytes",
    cached_m0_project_memory_epoch: "NULL AS cached_m0_project_memory_epoch",
    cached_m0_project_user_profile_version: "NULL AS cached_m0_project_user_profile_version",
    cached_m0_max_compartment_seq: "NULL AS cached_m0_max_compartment_seq",
    cached_m0_max_memory_id: "NULL AS cached_m0_max_memory_id",
    cached_m0_max_mutation_id: "NULL AS cached_m0_max_mutation_id",
    cached_m0_max_memory_mutation_id: "NULL AS cached_m0_max_memory_mutation_id",
    cached_m0_project_docs_hash: "NULL AS cached_m0_project_docs_hash",
    cached_m0_materialized_at: "NULL AS cached_m0_materialized_at",
    cached_m0_session_facts_version: "NULL AS cached_m0_session_facts_version",
    cached_m0_upgrade_state: "NULL AS cached_m0_upgrade_state",
    cached_m0_system_hash: "NULL AS cached_m0_system_hash",
    cached_m0_tool_set_hash: "NULL AS cached_m0_tool_set_hash",
    cached_m0_model_key: "NULL AS cached_m0_model_key",
    cached_m0_project_identity: "NULL AS cached_m0_project_identity",
    last_observed_model_key: "NULL AS last_observed_model_key",
    upgrade_reminded_at: "NULL AS upgrade_reminded_at",
    upgrade_reminder_last_sent_at: "NULL AS upgrade_reminder_last_sent_at",
    upgrade_reminder_count: "0 AS upgrade_reminder_count",
};

// Per-connection memo of the resolved projection SQL. getOrCreateSessionMeta is
// on the hot transform path (many calls per pass), and the old code ran
// `PRAGMA table_info(session_meta)` + rebuilt the ~50-column list on EVERY
// call. The schema shape is fixed for a connection's lifetime — ensureColumn
// and migrations run only inside initializeDatabase/runMigrations at startup,
// before any getOrCreateSessionMeta call — so the projection never changes
// after init and is safe to cache per Database (same pattern as the prepared-
// statement WeakMaps in compartment-storage.ts).
const sessionMetaSelectColumnsCache = new WeakMap<Database, string>();

function getSessionMetaSelectColumns(db: Database): string {
    const cached = sessionMetaSelectColumnsCache.get(db);
    if (cached !== undefined) return cached;
    const existingColumns = new Set(
        (db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name?: string }>).map(
            (column) => column.name,
        ),
    );
    const projection = SESSION_META_SELECT_COLUMNS.map((column) => {
        if (existingColumns.has(column)) return column;
        return SESSION_META_FALLBACK_SELECTS[column] ?? `0 AS ${column}`;
    }).join(", ");
    sessionMetaSelectColumnsCache.set(db, projection);
    return projection;
}

function findSessionMeta(db: Database, sessionId: string): SessionMeta | undefined {
    const result = db
        .prepare(`SELECT ${getSessionMetaSelectColumns(db)} FROM session_meta WHERE session_id = ?`)
        .get(sessionId);

    return isSessionMetaRow(result) ? toSessionMeta(result) : undefined;
}

/**
 * Read session metadata, returning defaults instead of inserting a row. The
 * history-head fallback that runs when another process holds the database write
 * lock uses this: inserting would need that same lock, fail, and refuse the turn.
 */
export function readSessionMeta(db: Database, sessionId: string): SessionMeta {
    return findSessionMeta(db, sessionId) ?? getDefaultSessionMeta(sessionId);
}

export function getOrCreateSessionMeta(db: Database, sessionId: string): SessionMeta {
    const existing = findSessionMeta(db, sessionId);
    if (existing) return existing;

    // Fresh row creation: bridge the race between OpenCode creating the
    // session (which writes `parent_id` synchronously) and the async
    // `session.created` event reaching our handler. Without this, child
    // sessions default to `isSubagent: false` on their first transform pass,
    // triggering primary guidance, system adjuncts and historian eligibility
    // that then has to be corrected on the next pass — busting prompt-cache.
    //
    // Read the host's own parent link only at row creation. OC2 has no v1
    // session.created handler and stores this link in session_v2 instead.
    // Existing rows (including OC2 children seen by an older plugin) retain
    // their served mode above: correcting them now would flip prompt bytes
    // mid-session. Pi-compatible hosts must never open an OpenCode store.
    const defaults = getDefaultSessionMeta(sessionId);
    const harness = getHarness();
    const fallbackSubagent =
        harness === "opencode"
            ? resolveIsSubagentFromOpenCodeDb(sessionId)
            : harness === "opencode2"
              ? resolveIsSubagentFromOpenCode2Db(sessionId)
              : null;
    if (fallbackSubagent === true) {
        defaults.isSubagent = true;
    }
    // OC2's flag is part of the INSERT, so even a concurrent reader cannot
    // observe a provisional primary row. Leave the v1 event/fallback path alone.
    ensureSessionMetaRow(db, sessionId, harness === "opencode2" && fallbackSubagent === true);
    if (harness === "opencode" && fallbackSubagent === true) {
        db.prepare("UPDATE session_meta SET is_subagent = 1 WHERE session_id = ?").run(sessionId);
    }
    return defaults;
}

export function updateSessionMeta(
    db: Database,
    sessionId: string,
    updates: Partial<SessionMeta>,
): void {
    const setClauses: string[] = [];
    const values: Array<string | number | Buffer | null> = [];

    for (const [key, column] of Object.entries(META_COLUMNS)) {
        const value = updates[key as keyof SessionMeta];
        if (value === undefined) continue;

        if (value === null) {
            setClauses.push(`${column} = ?`);
            values.push(NULL_BIND_META_KEYS.has(key) ? null : "");
        } else if (
            (key === "cachedM0Bytes" || key === "cachedM1Bytes") &&
            value instanceof Uint8Array
        ) {
            setClauses.push(`${column} = ?`);
            values.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        } else if (BOOLEAN_META_KEYS.has(key)) {
            setClauses.push(`${column} = ?`);
            values.push(value ? 1 : 0);
        } else if (typeof value === "string" || typeof value === "number") {
            setClauses.push(`${column} = ?`);
            values.push(
                key === "lastObservedModelKey" && typeof value === "string"
                    ? piModelRefToCanonical(value)
                    : value,
            );
        }
    }

    if (setClauses.length === 0) {
        return;
    }

    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(`UPDATE session_meta SET ${setClauses.join(", ")} WHERE session_id = ?`).run(
            ...values,
            sessionId,
        );
    }).immediate();
}

export function advanceToolReclaimWatermark(
    db: Database,
    sessionId: string,
    maxTagNumber: number,
): void {
    if (maxTagNumber <= 0) return;
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET tool_reclaim_watermark = MAX(COALESCE(tool_reclaim_watermark, 0), ?) WHERE session_id = ?",
        ).run(maxTagNumber, sessionId);
    }).immediate();
}

export interface PendingSessionCleanupRetryResult {
    attempted: number;
    cleared: number;
    failedSessionIds: string[];
}

function rustCleanupHarness(): string {
    return `${getHarness()}:rust`;
}

export function markSessionCleanupPending(
    db: Database,
    sessionId: string,
    rustModuleCleanupRequired = false,
): boolean {
    const row = db
        .prepare(
            `INSERT INTO pending_session_cleanup (session_id, harness, requested_at, last_attempt_at)
             VALUES (?, ?, ?, NULL)
             ON CONFLICT(session_id) DO UPDATE SET
                 harness = CASE
                     WHEN pending_session_cleanup.harness LIKE '%:rust'
                         THEN pending_session_cleanup.harness
                     ELSE excluded.harness
                 END,
                 requested_at = MIN(pending_session_cleanup.requested_at, excluded.requested_at)
             RETURNING harness`,
        )
        .get(
            sessionId,
            rustModuleCleanupRequired ? rustCleanupHarness() : getHarness(),
            Date.now(),
        ) as { harness: string };

    // The Rust suffix means module-owned state must be deleted before host rows.
    // Replaying the event in TypeScript mode cannot make host-only cleanup safe.
    return row.harness.endsWith(":rust");
}

export function retryPendingSessionCleanups(
    db: Database,
    limit = 200,
): PendingSessionCleanupRetryResult {
    const rows = db
        .prepare(
            `SELECT session_id
             FROM pending_session_cleanup
             WHERE harness NOT LIKE '%:rust'
             ORDER BY requested_at ASC, session_id ASC
             LIMIT ?`,
        )
        .all(Math.max(1, Math.floor(limit))) as Array<{ session_id: string }>;
    const failedSessionIds: string[] = [];
    let cleared = 0;
    for (const row of rows) {
        try {
            withoutSqliteTransformPass(() =>
                withSqliteBackgroundWriter(() => {
                    db.prepare(
                        "UPDATE pending_session_cleanup SET last_attempt_at = ? WHERE session_id = ?",
                    ).run(Date.now(), row.session_id);
                    clearSession(db, row.session_id);
                }),
            );
            cleared += 1;
        } catch {
            failedSessionIds.push(row.session_id);
        }
    }
    return { attempted: rows.length, cleared, failedSessionIds };
}

export async function retryPendingRustSessionCleanupsForProject(
    db: Database,
    projectPath: string,
    deleteSession: (sessionId: string) => Promise<void>,
    limit = 200,
): Promise<PendingSessionCleanupRetryResult> {
    const harness = getHarness();
    const rows = db
        .prepare(
            `SELECT pending.session_id
             FROM pending_session_cleanup pending
             JOIN session_projects projects
               ON projects.session_id = pending.session_id
              AND projects.harness = ?
             WHERE pending.harness = ?
               AND projects.project_path = ?
             ORDER BY pending.requested_at ASC, pending.session_id ASC
             LIMIT ?`,
        )
        .all(harness, rustCleanupHarness(), projectPath, Math.max(1, Math.floor(limit))) as Array<{
        session_id: string;
    }>;
    const failedSessionIds: string[] = [];
    let cleared = 0;
    for (const row of rows) {
        try {
            withoutSqliteTransformPass(() =>
                withSqliteBackgroundWriter(() =>
                    db
                        .prepare(
                            "UPDATE pending_session_cleanup SET last_attempt_at = ? WHERE session_id = ?",
                        )
                        .run(Date.now(), row.session_id),
                ),
            );
            await deleteSession(row.session_id);
            clearSession(db, row.session_id, true);
            cleared += 1;
        } catch {
            failedSessionIds.push(row.session_id);
        }
    }
    return { attempted: rows.length, cleared, failedSessionIds };
}

export function clearSession(
    db: Database,
    sessionId: string,
    rustModuleCleanupAcknowledged = false,
): void {
    cancelAutoSearchWork(sessionId);
    let transactionStartedAt = 0;
    withoutSqliteTransformPass(() =>
        withSqliteBackgroundWriter(() =>
            db
                .transaction(() => {
                    transactionStartedAt = performance.now();
                    deleteSessionScopedRows(db, [sessionId], undefined, {
                        rustModuleCleanupAcknowledged,
                    });
                })
                .immediate(),
        ),
    );
    logSlowWriteTransaction("clear-session", transactionStartedAt);
}
