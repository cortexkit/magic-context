import { Buffer } from "node:buffer";
import { getHarness } from "../../shared/harness";
import type { Database } from "../../shared/sqlite";
import { clearCompressionDepth } from "./compression-depth-storage";
import { clearIndexedMessages } from "./message-index";
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
            values.push(value);
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

export function clearSession(db: Database, sessionId: string): void {
    // Every session-scoped table must be cleared here; the structural storage-db
    // test discovers tables with session_id and seeds each one to enforce this list.
    db.transaction(() => {
        db.prepare("DELETE FROM pending_ops WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM source_contents WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM tool_owner_backfill_state WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM tags WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM session_meta WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM session_projects WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM compartment_chunk_embeddings WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
        clearCompressionDepth(db, sessionId);
        db.prepare("DELETE FROM session_facts WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM compartment_state_lease WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM notes WHERE session_id = ? AND type = 'session'").run(sessionId);
        db.prepare("DELETE FROM recomp_compartments WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM recomp_facts WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM user_memory_candidates WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM primer_candidates WHERE session_id = ?").run(sessionId);
        // v2: m[0]/m[1] delta log + historian-extracted events are session-scoped
        // and must be cleared on session deletion (both have session_id). Without
        // this they leak orphaned rows when a session is deleted.
        db.prepare("DELETE FROM m0_mutation_log WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM compartment_events WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM subagent_invocations WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM historian_runs WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM plugin_messages WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM transform_decisions WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM synapse_batch_ledger WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM embedding_measurement_corpus WHERE session_id = ?").run(sessionId);
        clearIndexedMessages(db, sessionId);
    })();
}
