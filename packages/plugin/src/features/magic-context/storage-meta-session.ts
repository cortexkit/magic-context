import { Buffer } from "node:buffer";
import { getHarness } from "../../shared/harness";
import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import type { Database } from "../../shared/sqlite";
import { logSlowWriteTransaction } from "../../shared/write-transaction-timing";
import { resolveIsSubagentFromOpenCodeDb } from "./resolve-subagent-fallback";
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

export function getOrCreateSessionMeta(db: Database, sessionId: string): SessionMeta {
    const result = db
        .prepare(`SELECT ${getSessionMetaSelectColumns(db)} FROM session_meta WHERE session_id = ?`)
        .get(sessionId);

    if (isSessionMetaRow(result)) {
        return toSessionMeta(result);
    }

    // Fresh row creation: bridge the race between OpenCode creating the
    // session (which writes `parent_id` synchronously) and the async
    // `session.created` event reaching our handler. Without this, child
    // sessions default to `isSubagent: false` on their first transform pass,
    // triggering primary-mode behavior (§N§ prefixes, system adjuncts, etc.)
    // that then has to be corrected on the next pass — busting prompt-cache.
    //
    // Harness gate: this fallback opens OpenCode's opencode.db read-only to
    // probe `session.parent_id`. Pi has no opencode.db and no concept of
    // OpenCode-style subagents — calling the fallback there throws "unable
    // to open database file" and floods the shared log. Skip on non-opencode
    // harnesses; Pi sessions always default to isSubagent=false.
    const defaults = getDefaultSessionMeta(sessionId);
    const fallbackSubagent =
        getHarness() === "opencode" ? resolveIsSubagentFromOpenCodeDb(sessionId) : null;
    if (fallbackSubagent === true) {
        defaults.isSubagent = true;
    }
    ensureSessionMetaRow(db, sessionId);
    if (fallbackSubagent === true) {
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
    })();
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
    })();
}

export interface PendingSessionCleanupRetryResult {
    attempted: number;
    cleared: number;
    failedSessionIds: string[];
}

export function markSessionCleanupPending(db: Database, sessionId: string): void {
    db.prepare(
        `INSERT INTO pending_session_cleanup (session_id, harness, requested_at, last_attempt_at)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT(session_id) DO UPDATE SET
             harness = excluded.harness,
             requested_at = MIN(pending_session_cleanup.requested_at, excluded.requested_at)`,
    ).run(sessionId, getHarness(), Date.now());
}

export function retryPendingSessionCleanups(
    db: Database,
    limit = 200,
): PendingSessionCleanupRetryResult {
    const rows = db
        .prepare(
            "SELECT session_id FROM pending_session_cleanup ORDER BY requested_at ASC, session_id ASC LIMIT ?",
        )
        .all(Math.max(1, Math.floor(limit))) as Array<{ session_id: string }>;
    const failedSessionIds: string[] = [];
    let cleared = 0;
    for (const row of rows) {
        try {
            db.prepare(
                "UPDATE pending_session_cleanup SET last_attempt_at = ? WHERE session_id = ?",
            ).run(Date.now(), row.session_id);
            clearSession(db, row.session_id);
            cleared += 1;
        } catch {
            failedSessionIds.push(row.session_id);
        }
    }
    return { attempted: rows.length, cleared, failedSessionIds };
}

export function clearSession(db: Database, sessionId: string): void {
    const transactionStartedAt = performance.now();
    db.transaction(() => {
        deleteSessionScopedRows(db, [sessionId]);
    })();
    logSlowWriteTransaction("clear-session", transactionStartedAt);
}
