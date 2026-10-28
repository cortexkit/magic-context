import { clearLkgRecoveryFence } from "../../hooks/magic-context/lkg-recovery-fence";
import { getHarness } from "../../shared/harness";
import { type Database, prepareCachedStatement, type Statement } from "../../shared/sqlite";
import { deleteChunkEmbedBackoffForSession } from "./compartment-chunk-embedding";
import { releaseMemoryReservations } from "./memory/lifecycle-applier";
import { deleteUncommittedPublications } from "./memory/turn-one-publication";
import { closeTurnTwoChildrenOfSessions } from "./memory/turn-two-children";
import { deleteUnmappedMessageFtsRows } from "./message-fts-rowid-map";
import { deleteSessionActivity } from "./session-activity";
import {
    tagIdentityRevisionKey,
    tagRevisionKey,
    tagTombstoneOwnerKey,
    tagTombstoneOwnerRange,
} from "./storage-tag-identity-revision";

export interface SessionScopedTableDefinition {
    readonly table: string;
    readonly harnessScoped?: true;
    readonly extraPredicate?: string;
}

/**
 * Tables whose rows are owned by a session, in dependency-safe deletion order.
 * Every explicit session deletion must cover the complete list.
 */
export const SESSION_SCOPED_TABLES: readonly SessionScopedTableDefinition[] = [
    { table: "pending_ops", harnessScoped: true },
    { table: "source_contents", harnessScoped: true },
    { table: "tool_owner_backfill_state" },
    { table: "tags", harnessScoped: true },
    { table: "session_meta", harnessScoped: true },
    {
        table: "session_render_cache",
        extraPredicate:
            "NOT EXISTS (SELECT 1 FROM session_meta AS remaining WHERE remaining.session_id = session_render_cache.session_id)",
    },
    {
        table: "session_meta_chunks",
        extraPredicate:
            "NOT EXISTS (SELECT 1 FROM session_meta AS remaining WHERE remaining.session_id = session_meta_chunks.session_id)",
    },
    {
        table: "session_meta_collection_revisions",
        extraPredicate:
            "NOT EXISTS (SELECT 1 FROM session_meta AS remaining WHERE remaining.session_id = session_meta_collection_revisions.session_id)",
    },
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
    { table: "memory_agent_fragments", harnessScoped: true },
    { table: "memory_applied_rows", harnessScoped: true },
    { table: "memory_applied_snapshots", harnessScoped: true },
];

export interface DeleteSessionScopedRowsOptions {
    /** The caller clears durable recovery files after COMMIT, outside the SQLite writer lock. */
    readonly deferRecoveryFenceCleanup?: boolean;
    /** Set only after the Rust module has acknowledged its idempotent session deletion. */
    readonly rustModuleCleanupAcknowledged?: boolean;
    /** Keep tag-change counters when a session may resume; remove them only after host deletion is confirmed. */
    readonly preserveTagRevisionTombstones?: boolean;
}

const cleanupStatements = new WeakMap<Database, Map<string, Statement>>();
function cleanupStatement(db: Database, sql: string): Statement {
    let cache = cleanupStatements.get(db);
    if (!cache) {
        cache = new Map();
        cleanupStatements.set(db, cache);
    }
    let statement = cache.get(sql);
    if (!statement) {
        // Per-session orphan transactions repeat these queries thousands of times.
        // Reuse their statements instead of forcing native finalization/GC while
        // holding the writer. Cap the cache because batch sizes produce distinct SQL.
        if (cache.size >= 256) cache.clear();
        statement = prepareCachedStatement(db, sql);
        cache.set(sql, statement);
    }
    return statement;
}

/**
 * Delete one bounded session-id batch. A supplied harness scopes every table
 * that stores harness provenance; tables without that column are session-wide.
 *
 * A Rust cleanup marker protects the entire host-side session until module
 * acknowledgement. Deleting the session's project mapping in session_projects
 * sooner would make the durable retry unreachable.
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
        const protectedRows = cleanupStatement(
            db,
            `SELECT session_id
                 FROM pending_session_cleanup
                 WHERE session_id IN (${placeholders})
                   AND harness LIKE '%:rust'${harnessPredicate}`,
        ).all(...sessionIds, ...(harness === undefined ? [] : [`${harness}:rust`])) as Array<{
            session_id: string;
        }>;
        const protectedSessionIds = new Set(protectedRows.map((row) => row.session_id));
        deletableSessionIds = sessionIds.filter((sessionId) => !protectedSessionIds.has(sessionId));
    }
    if (deletableSessionIds.length === 0) return 0;
    const placeholders = deletableSessionIds.map(() => "?").join(", ");

    releaseMemoryReservations(db, deletableSessionIds, harness);
    // A hidden child kept open for turn two goes with its session: its reserved
    // facts were just released, so nothing remains to reattach to it.
    closeTurnTwoChildrenOfSessions(deletableSessionIds);
    deleteUncommittedPublications(db, deletableSessionIds, harness);
    const harnessTables = SESSION_SCOPED_TABLES.filter((definition) => definition.harnessScoped);
    if (options.preserveTagRevisionTombstones) {
        // Context resets retain the producing harness next to the tag-change
        // counters so a later explicit deletion can retire only its own markers.
        const owners = cleanupStatement(
            db,
            harnessTables
                .map(
                    (definition) =>
                        `SELECT session_id, harness FROM ${definition.table} WHERE session_id IN (${placeholders})${definition.extraPredicate ? ` AND ${definition.extraPredicate}` : ""}`,
                )
                .join(" UNION "),
        ).all(...harnessTables.flatMap(() => deletableSessionIds)) as {
            session_id: string;
            harness: string;
        }[];
        const record = cleanupStatement(
            db,
            "INSERT OR IGNORE INTO schema_migrations_meta (key, value) VALUES (?, ?)",
        );
        for (const owner of owners)
            record.run(tagTombstoneOwnerKey(owner.session_id, owner.harness), owner.harness);
        const fallback = cleanupStatement(
            db,
            `INSERT INTO schema_migrations_meta (key, value)
            SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM schema_migrations_meta WHERE key >= ? AND key < ?)`,
        );
        for (const id of deletableSessionIds)
            fallback.run(
                tagTombstoneOwnerKey(id, getHarness()),
                getHarness(),
                ...tagTombstoneOwnerRange(id),
            );
    }

    for (const sessionId of deletableSessionIds) deleteChunkEmbedBackoffForSession(db, sessionId);
    for (const definition of SESSION_SCOPED_TABLES) {
        if (definition.table === "message_history_fts") {
            cleanupStatement(
                db,
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
        const statement = cleanupStatement(
            db,
            `DELETE FROM ${definition.table} WHERE ${predicates.join(" AND ")}`,
        );
        if (bindHarness) statement.run(...deletableSessionIds, harness);
        else statement.run(...deletableSessionIds);
    }
    // Activity is session-owned but stored as keys in the existing KV table,
    // so it cannot appear in the schema-derived SESSION_SCOPED_TABLES list.
    deleteSessionActivity(db, deletableSessionIds);
    if (!options.preserveTagRevisionTombstones) {
        const retireOwner = cleanupStatement(
            db,
            harness === undefined
                ? "DELETE FROM schema_migrations_meta WHERE key >= ? AND key < ?"
                : "DELETE FROM schema_migrations_meta WHERE key = ?",
        );
        const survivingRows = harnessTables
            .map(
                (definition) =>
                    `EXISTS (SELECT 1 FROM ${definition.table} WHERE session_id = ?${definition.extraPredicate ? ` AND ${definition.extraPredicate}` : ""})`,
            )
            .join(" OR ");
        const retire = cleanupStatement(
            db,
            `DELETE FROM schema_migrations_meta WHERE key IN (?, ?)
            AND NOT (${survivingRows})
            AND NOT EXISTS (SELECT 1 FROM schema_migrations_meta AS owners WHERE owners.key >= ? AND owners.key < ?)`,
        );
        for (const id of deletableSessionIds) {
            if (harness === undefined) retireOwner.run(...tagTombstoneOwnerRange(id));
            else retireOwner.run(tagTombstoneOwnerKey(id, harness));
            retire.run(
                tagIdentityRevisionKey(id),
                tagRevisionKey(id),
                ...harnessTables.map(() => id),
                ...tagTombstoneOwnerRange(id),
            );
        }
    }
    if (!options.deferRecoveryFenceCleanup)
        for (const sessionId of deletableSessionIds) clearLkgRecoveryFence(sessionId);
    return deletableSessionIds.length;
}
