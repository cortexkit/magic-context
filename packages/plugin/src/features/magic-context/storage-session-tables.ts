import type { Database } from "../../shared/sqlite";

export interface SessionScopedTableDefinition {
    readonly table: string;
    readonly harnessScoped?: true;
    readonly extraPredicate?: string;
}

/**
 * Tables whose rows are owned by a session. Keep this list in dependency-safe
 * deletion order so event cleanup and orphan cleanup cannot drift apart.
 */
export const SESSION_SCOPED_TABLES: readonly SessionScopedTableDefinition[] = [
    { table: "pending_ops", harnessScoped: true },
    { table: "source_contents", harnessScoped: true },
    { table: "tool_owner_backfill_state" },
    { table: "tags", harnessScoped: true },
    { table: "session_meta", harnessScoped: true },
    { table: "session_projects", harnessScoped: true },
    { table: "compartment_chunk_embeddings", harnessScoped: true },
    { table: "compartments", harnessScoped: true },
    { table: "compression_depth", harnessScoped: true },
    { table: "session_facts", harnessScoped: true },
    { table: "compartment_state_lease" },
    // Smart notes are project-owned even when they record an originating session.
    { table: "notes", harnessScoped: true, extraPredicate: "type = 'session'" },
    { table: "recomp_compartments", harnessScoped: true },
    { table: "recomp_facts", harnessScoped: true },
    { table: "user_memory_candidates" },
    { table: "primer_candidates", harnessScoped: true },
    { table: "m0_mutation_log" },
    { table: "compartment_events", harnessScoped: true },
    { table: "subagent_invocations", harnessScoped: true },
    { table: "historian_runs", harnessScoped: true },
    { table: "plugin_messages" },
    { table: "transform_decisions", harnessScoped: true },
    { table: "synapse_batch_ledger" },
    { table: "embedding_measurement_corpus" },
    { table: "pending_session_cleanup", harnessScoped: true },
    { table: "message_history_fts" },
    { table: "message_fts_rowid_map" },
    { table: "message_history_source", harnessScoped: true },
    { table: "message_history_index", harnessScoped: true },
    { table: "lkg_slots" },
    { table: "rust_ordinal_checkpoints" },
];

export interface DeleteSessionScopedRowsOptions {
    /** Set only after the Rust module has acknowledged its idempotent session deletion. */
    readonly rustModuleCleanupAcknowledged?: boolean;
}

/**
 * Delete one bounded session-id batch. A supplied harness scopes every table
 * that stores harness provenance; tables without that column rely on the
 * caller's harness-scoped candidate source.
 *
 * A Rust cleanup marker protects the entire host-side session until module
 * acknowledgement. Otherwise an orphan sweep could retain the marker while
 * deleting its session→project coordinate, making the durable retry unreachable.
 */
export function deleteSessionScopedRows(
    db: Database,
    sessionIds: readonly string[],
    harness?: string,
    options: DeleteSessionScopedRowsOptions = {},
): number {
    if (sessionIds.length === 0) return 0;
    let deletableSessionIds = [...sessionIds];
    if (options.rustModuleCleanupAcknowledged !== true) {
        const placeholders = sessionIds.map(() => "?").join(", ");
        const harnessPredicate = harness === undefined ? "" : " AND harness = ?";
        const protectedRows = db
            .prepare(
                `SELECT session_id
                 FROM pending_session_cleanup
                 WHERE session_id IN (${placeholders})
                   AND harness LIKE '%:rust'${harnessPredicate}`,
            )
            .all(...sessionIds, ...(harness === undefined ? [] : [`${harness}:rust`])) as Array<{
            session_id: string;
        }>;
        const protectedSessionIds = new Set(protectedRows.map((row) => row.session_id));
        deletableSessionIds = sessionIds.filter((sessionId) => !protectedSessionIds.has(sessionId));
    }
    if (deletableSessionIds.length === 0) return 0;
    const placeholders = deletableSessionIds.map(() => "?").join(", ");

    for (const definition of SESSION_SCOPED_TABLES) {
        if (definition.table === "message_history_fts") {
            db.prepare(
                `DELETE FROM message_history_fts
                 WHERE rowid IN (
                     SELECT fts_rowid
                     FROM message_fts_rowid_map
                     WHERE session_id IN (${placeholders})
                 )`,
            ).run(...deletableSessionIds);
            continue;
        }

        const predicates = [`session_id IN (${placeholders})`];
        if (definition.extraPredicate) predicates.push(definition.extraPredicate);
        const bindHarness = harness !== undefined && definition.harnessScoped === true;
        if (bindHarness) predicates.push("harness = ?");
        const statement = db.prepare(
            `DELETE FROM ${definition.table} WHERE ${predicates.join(" AND ")}`,
        );
        if (bindHarness) statement.run(...deletableSessionIds, harness);
        else statement.run(...deletableSessionIds);
    }
    return deletableSessionIds.length;
}
