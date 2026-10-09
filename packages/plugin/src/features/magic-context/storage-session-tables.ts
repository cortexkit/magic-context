import type { Database } from "../../shared/sqlite";
import { deleteChunkEmbedBackoffForSession } from "./compartment-chunk-embedding";
import { releaseMemoryReservations } from "./memory/lifecycle-applier";
import { deleteUnmappedMessageFtsRows } from "./message-fts-rowid-map";
import { deleteSessionActivity } from "./session-activity";

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
    {
        table: "temporal_decisions",
        extraPredicate:
            "NOT EXISTS (SELECT 1 FROM session_meta AS remaining WHERE remaining.session_id = temporal_decisions.session_id)",
    },
    // Replay decisions belong to the session's metadata row; a harness sweep that
    // keeps another harness's row keeps them too.
    {
        table: "session_replay_decisions",
        extraPredicate:
            "NOT EXISTS (SELECT 1 FROM session_meta AS remaining WHERE remaining.session_id = session_replay_decisions.session_id)",
    },
    { table: "session_projects", harnessScoped: true },
    { table: "compartment_chunk_embeddings", harnessScoped: true },
    { table: "compartments", harnessScoped: true },
    // A harness sweep can leave another harness's compartments for the same session.
    {
        table: "compartment_history_versions",
        extraPredicate:
            "NOT EXISTS (SELECT 1 FROM compartments AS remaining WHERE remaining.session_id = compartment_history_versions.session_id)",
    },
    // Selections precede revisions so their revision foreign keys remain valid.
    // Compartments retained for another host (OpenCode or Pi) keep score history too.
    {
        table: "compartment_score_selections",
        extraPredicate:
            "NOT EXISTS (SELECT 1 FROM compartments AS remaining WHERE remaining.session_id = compartment_score_selections.session_id)",
    },
    {
        table: "compartment_score_revisions",
        extraPredicate:
            "NOT EXISTS (SELECT 1 FROM compartments AS remaining WHERE remaining.session_id = compartment_score_revisions.session_id)",
    },
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
    { table: "lkg_slot_chunks" },
    { table: "lkg_served_markers" },
    { table: "host_runner_entries", harnessScoped: true },
    { table: "host_runner_ids", harnessScoped: true },
    { table: "host_runner_views", harnessScoped: true },
    { table: "host_runner_state", harnessScoped: true },
    { table: "memory_check_attempts", harnessScoped: true },
    { table: "memory_stage_attempts", harnessScoped: true },
    { table: "memory_applied_rows", harnessScoped: true },
    { table: "memory_applied_snapshots", harnessScoped: true },
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

    releaseMemoryReservations(db, deletableSessionIds, harness);

    for (const sessionId of deletableSessionIds) deleteChunkEmbedBackoffForSession(db, sessionId);
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
            deleteUnmappedMessageFtsRows(db, deletableSessionIds);
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
    // Activity is session-owned but stored as keys in the existing KV table,
    // so it cannot appear in the schema-derived SESSION_SCOPED_TABLES list.
    deleteSessionActivity(db, deletableSessionIds);
    return deletableSessionIds.length;
}
