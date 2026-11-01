//! Store migration 61: the schema half of moving the module's domain rows into `context.db`.
//!
//! Migration 61 is meant to be applied in two places, and both must run exactly the same
//! statements:
//!
//! - `McStore::open`, through the ordinary migration chain, but only to a store that holds
//!   no domain rows (a fresh install), refusing a populated one so its rows are never
//!   dropped before they were copied. This is not wired yet: 61 joins `MIGRATIONS` together
//!   with the runtime that reads the moved rows from `context.db`, because until then
//!   every store the module opens still needs those tables.
//! - The offline migration engine (`ck-mc single-store-migrate`) applies it inside its one
//!   transaction, after the rows were copied into `context.db` and verified, and records the
//!   version row itself.
//!
//! That is why the statements are named constants here rather than an inline string in the
//! migration list.
//!
//! This file also carries the read-only reader of the old domain tables. The engine uses it
//! for its render check: the session history and memory block are composed once from the
//! old rows and once from `context.db`, and the two renders must agree before the engine
//! commits. Nothing else reads the old tables; once the migration has run they are gone.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};

use crate::{
    MemoryRenderSnapshot, MemoryRevision, StoredCompartment, StoredMemory, WorkspaceMembership,
};

/// The store migration that moves the domain tables out of `store.db`.
pub const SINGLE_STORE_MIGRATION_VERSION: u32 = 61;

/// The last store version that still holds domain rows.
pub const PRE_SINGLE_STORE_VERSION: u32 = 60;

/// The migration namespace `store.db` records its versions under.
pub const STORE_NAMESPACE: &str = "mc_cache";

/// The stable token of the refusal an unmigrated populated store gets. The module answers
/// every lane except `echo` with it, and the plugin maps it to MC-C14.
pub const SINGLE_STORE_MIGRATION_REQUIRED_REASON: &str = "single_store_migration_required";

/// The stable token of the refusal given when `store.db` and `context.db` disagree about
/// whether the migration ran, or carry different stamps.
pub const SINGLE_STORE_STATE_SPLIT_REASON: &str = "single_store_state_split";

/// The user-facing sentence for [`SINGLE_STORE_MIGRATION_REQUIRED_REASON`].
pub const SINGLE_STORE_MIGRATION_REQUIRED_SENTENCE: &str = "Magic Context needs a one-time migration of its store. Quit OpenCode and every ck-mc process, then run `magic-context doctor single-store migrate`. (MC-C14)";

/// The tables whose rows now live in `context.db`. A store at version 60 or lower with a
/// row in any of these has not been migrated and must not be opened.
pub const SINGLE_STORE_MOVED_TABLES: &[&str] = &[
    "mc_memories",
    "mc_memory_mutation_log",
    "mc_notes",
    "mc_note_deliveries",
    "mc_compartments",
    "mc_compartment_events",
    "mc_primer_candidates",
    "mc_user_memory_candidates",
    "mc_memory_mappings",
    "mc_user_memories",
    "mc_workspaces",
    "mc_workspace_members",
];

/// Every table migration 61 drops: the moved tables, the mirror and authority machinery,
/// and the shadow tables nothing reads any more. Dropping a table drops its indexes and
/// the triggers defined on it.
pub const SINGLE_STORE_DROPPED_TABLES: &[&str] = &[
    "mc_memories",
    "mc_memory_mutation_log",
    "mc_notes",
    "mc_note_deliveries",
    "mc_compartments",
    "mc_compartment_events",
    "mc_primer_candidates",
    "mc_user_memory_candidates",
    "mc_memory_mappings",
    "mc_user_memories",
    "mc_workspaces",
    "mc_workspace_members",
    "mc_changefeed",
    "mc_authority",
    "mc_authority_seed_rows",
    "mc_authority_pending_memory_references",
    "mc_authority_route_bindings",
    "mc_memory_visibility_epoch",
    "shadow_memories",
    "shadow_memory_mutation_log",
    "shadow_user_profile",
];

/// The tables migration 61 creates. Both are caches or intents, never a source of truth.
///
/// - `mc_compartment_dates` keeps the date segment of each compartment heading. `context.db`
///   compartments have no date columns; the row is keyed by the compartment's position and
///   carries its message ids, so a row left over from a compartment that was later rewritten
///   is recognised as stale and ignored.
/// - `mc_single_store_pending_publish` records a fold or compartment rewrite before it is
///   written to `context.db`. The `context.db` write is a separate transaction on another
///   file; if it fails or the process dies first, the next pass for the session re-issues
///   it from this row, and no new fold starts while the row exists.
macro_rules! migration_61_create {
    () => {
        "
        CREATE TABLE IF NOT EXISTS mc_compartment_dates (
            session_id        TEXT NOT NULL,
            sequence          INTEGER NOT NULL,
            start_message_id  TEXT NOT NULL DEFAULT '',
            end_message_id    TEXT NOT NULL DEFAULT '',
            start_date        TEXT,
            end_date          TEXT,
            PRIMARY KEY (session_id, sequence)
        );
        CREATE TABLE IF NOT EXISTS mc_single_store_pending_publish (
            session_id    TEXT PRIMARY KEY,
            publish_json  TEXT NOT NULL,
            created_at    INTEGER NOT NULL
        );
        "
    };
}

macro_rules! migration_61_drop {
    () => {
        "
        DROP TABLE IF EXISTS mc_memories;
        DROP TABLE IF EXISTS mc_memory_mutation_log;
        DROP TABLE IF EXISTS mc_notes;
        DROP TABLE IF EXISTS mc_note_deliveries;
        DROP TABLE IF EXISTS mc_compartments;
        DROP TABLE IF EXISTS mc_compartment_events;
        DROP TABLE IF EXISTS mc_primer_candidates;
        DROP TABLE IF EXISTS mc_user_memory_candidates;
        DROP TABLE IF EXISTS mc_memory_mappings;
        DROP TABLE IF EXISTS mc_user_memories;
        DROP TABLE IF EXISTS mc_workspace_members;
        DROP TABLE IF EXISTS mc_workspaces;
        DROP TABLE IF EXISTS mc_changefeed;
        DROP TABLE IF EXISTS mc_authority_seed_rows;
        DROP TABLE IF EXISTS mc_authority_pending_memory_references;
        DROP TABLE IF EXISTS mc_authority_route_bindings;
        DROP TABLE IF EXISTS mc_authority;
        DROP TABLE IF EXISTS mc_memory_visibility_epoch;
        DROP TABLE IF EXISTS shadow_memories;
        DROP TABLE IF EXISTS shadow_memory_mutation_log;
        DROP TABLE IF EXISTS shadow_user_profile;
        "
    };
}

/// The create half of migration 61. The engine runs it first in its transaction, so the
/// compartment-date cache exists before rows are copied into it.
pub const MIGRATION_61_CREATE_SQL: &str = migration_61_create!();

/// The drop half of migration 61. The engine runs it last, after verification.
pub const MIGRATION_61_DROP_SQL: &str = migration_61_drop!();

/// Migration 61 as the ordinary chain applies it to an empty store.
pub const MIGRATION_61_SQL: &str = concat!(migration_61_create!(), migration_61_drop!());

/// Sets the store's single-store marker. `?1` is the stamp (milliseconds), `?2` the build
/// identity. `context.db`'s `single_store_state.migrated_at` carries the same stamp.
pub const SINGLE_STORE_MARKER_SQL: &str = "UPDATE mc_privilege_state
    SET single_store = 1, single_store_set_at_ms = ?1, single_store_set_by = ?2
  WHERE id = 1";

/// Suffix of the build identity to record when `McStore::open` applies migration 61 to an
/// empty store (once 61 is in `MIGRATIONS`). The module and the engine read it to know the
/// `context.db` flag still has to be written for a fresh install, rather than treating the
/// pair as split.
pub const FRESH_INSTALL_MARKER_SUFFIX: &str = "+fresh";

/// The build identity recorded in the markers: the release SHA, or the crate version for
/// an unstamped build.
pub fn build_identity() -> String {
    match option_env!("MC_BUILD_SHA")
        .map(str::trim)
        .filter(|sha| !sha.is_empty())
    {
        Some(sha) => sha.to_string(),
        None => format!("unstamped-{}", env!("CARGO_PKG_VERSION")),
    }
}

/// The recorded `store.db` schema version, or 0 for a file no migration has touched.
pub fn recorded_store_version(conn: &Connection) -> rusqlite::Result<u32> {
    if !table_exists(conn, "main", "cortexkit_schema_version")? {
        return Ok(0);
    }
    conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM main.cortexkit_schema_version WHERE namespace = ?1",
        params![STORE_NAMESPACE],
        |row| row.get(0),
    )
}

/// Whether `schema.table` exists.
pub fn table_exists(conn: &Connection, schema: &str, table: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {schema}.sqlite_master WHERE type = 'table' AND name = ?1)"),
        params![table],
        |row| row.get(0),
    )
}

/// The first moved table in `schema` that still holds a row, if any.
pub fn first_populated_moved_table(
    conn: &Connection,
    schema: &str,
) -> rusqlite::Result<Option<&'static str>> {
    for table in SINGLE_STORE_MOVED_TABLES {
        if !table_exists(conn, schema, table)? {
            continue;
        }
        let populated: bool = conn.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {schema}.{table})"),
            [],
            |row| row.get(0),
        )?;
        if populated {
            return Ok(Some(table));
        }
    }
    Ok(None)
}

/// Mark every session's cache state for one HARD after the migration.
///
/// `bootstrap_seed_fold_pending` requests the existing cold-baseline rebuild lane.
/// The four id-bearing fields are store-space numbers (store memory ids and
/// store mutation-log ids); zeroing them prevents a store id from being compared
/// with a `context.db` id before that rebuild. The dashboard epoch flag cannot
/// authorize this repair: ordinary external memory edits must remain held.
/// Every other field is kept, and JSON editing preserves fields unknown to this
/// build. Returns the number of rows changed.
pub fn reset_cache_state_for_single_store(conn: &Connection) -> rusqlite::Result<usize> {
    let rows: Vec<(String, String)> = {
        let mut statement = conn.prepare("SELECT session_id, meta FROM mc_cache_state")?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let mut changed = 0;
    for (session_id, meta) in rows {
        let mut value: serde_json::Value = match serde_json::from_str(&meta) {
            Ok(value @ serde_json::Value::Object(_)) => value,
            // A meta that is not an object cannot be edited in place; start from empty so
            // the session bootstraps with one HARD, which is what the reset asks for.
            _ => serde_json::json!({}),
        };
        let object = value.as_object_mut().expect("checked above");
        object.insert("bootstrap_seed_fold_pending".into(), true.into());
        object.insert("max_memory_id".into(), 0.into());
        object.insert("memory_mutation_cursor".into(), 0.into());
        object.insert("m1_revision".into(), 0.into());
        object.insert("rendered_memory_ids".into(), serde_json::json!([]));
        conn.execute(
            "UPDATE mc_cache_state SET meta = ?2, row_version = row_version + 1
              WHERE session_id = ?1",
            params![session_id, value.to_string()],
        )?;
        changed += 1;
    }
    Ok(changed)
}

// ── Domain reads shared by the old and the new tables ──────────────────────

/// The table names one set of domain reads runs against: the old `store.db` tables, or
/// their `context.db` counterparts. The columns these reads use are the same in both.
#[derive(Debug, Clone, Copy)]
pub struct DomainTables {
    pub memories: &'static str,
    pub memory_mutation_log: &'static str,
    pub workspaces: &'static str,
    pub workspace_members: &'static str,
    pub user_memories: &'static str,
}

/// The pre-migration `store.db` tables, read only by the engine's render check.
pub const LEGACY_TABLES: DomainTables = DomainTables {
    memories: "mc_memories",
    memory_mutation_log: "mc_memory_mutation_log",
    workspaces: "mc_workspaces",
    workspace_members: "mc_workspace_members",
    user_memories: "mc_user_memories",
};

/// The `context.db` tables the module reads after the migration.
pub const CONTEXT_TABLES: DomainTables = DomainTables {
    memories: "memories",
    memory_mutation_log: "memory_mutation_log",
    workspaces: "workspaces",
    workspace_members: "workspace_members",
    user_memories: "user_memories",
};

/// A project's workspace membership, or `None` when it is in no workspace.
pub fn read_workspace_membership(
    conn: &Connection,
    tables: &DomainTables,
    project_path: &str,
) -> rusqlite::Result<Option<WorkspaceMembership>> {
    let workspace: Option<(i64, String)> = conn
        .query_row(
            &format!(
                "SELECT w.id, w.share_categories
                   FROM {members} m
                   JOIN {workspaces} w ON w.id = m.workspace_id
                  WHERE m.project_path = ?1",
                members = tables.workspace_members,
                workspaces = tables.workspaces
            ),
            params![project_path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((workspace_id, share_categories_json)) = workspace else {
        return Ok(None);
    };
    let mut statement = conn.prepare(&format!(
        "SELECT project_path, display_name FROM {} WHERE workspace_id = ?1 ORDER BY project_path ASC",
        tables.workspace_members
    ))?;
    let members: Vec<(String, String)> = statement
        .query_map(params![workspace_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    let union_identities = members.iter().map(|(path, _)| path.clone()).collect();
    let display_name_by_path: HashMap<String, String> = members.into_iter().collect();
    let share_categories = serde_json::from_str(&share_categories_json).unwrap_or_default();
    Ok(Some(WorkspaceMembership {
        union_identities,
        own_identity: project_path.to_string(),
        share_categories,
        display_name_by_path,
    }))
}

/// The render-eligible memories and both revision heads, from one read snapshot.
pub fn read_memory_render_snapshot(
    conn: &Connection,
    tables: &DomainTables,
    project_path: &str,
    membership: Option<&WorkspaceMembership>,
    now_ms: i64,
) -> rusqlite::Result<MemoryRenderSnapshot> {
    let project_paths = membership
        .map(|value| value.union_identities.clone())
        .unwrap_or_else(|| vec![project_path.to_string()]);
    let (pool_filter, binds) = crate::memory_render_pool_filter_for_column(
        membership,
        project_path,
        "project_path",
        now_ms,
    );
    let memories = {
        let mut statement = conn.prepare(&format!(
            "SELECT id, project_path, category, content, importance, status, expires_at,
                    superseded_by_memory_id, updated_at, last_seen_at, verified_at
               FROM {}
              WHERE {pool_filter}
              ORDER BY COALESCE(importance, 50) DESC, id ASC",
            tables.memories
        ))?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(binds.iter()), |row| {
                Ok(StoredMemory {
                    id: row.get(0)?,
                    project_path: row.get(1)?,
                    category: row.get(2)?,
                    content: row.get(3)?,
                    importance: row.get(4)?,
                    status: row.get(5)?,
                    expires_at: row.get(6)?,
                    superseded_by_memory_id: row.get(7)?,
                    updated_at: row.get(8)?,
                    last_seen_at: row.get(9)?,
                    verified_at: row.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let max_memory_id = conn.query_row(
        &format!(
            "SELECT COALESCE(MAX(id), 0) FROM {} WHERE {pool_filter}",
            tables.memories
        ),
        rusqlite::params_from_iter(binds.iter()),
        |row| row.get(0),
    )?;
    let placeholders = std::iter::repeat_n("?", project_paths.len())
        .collect::<Vec<_>>()
        .join(", ");
    let mutation_cursor = if project_paths.is_empty() {
        0
    } else {
        conn.query_row(
            &format!(
                "SELECT COALESCE(MAX(id), 0) FROM {} WHERE project_path IN ({placeholders})",
                tables.memory_mutation_log
            ),
            rusqlite::params_from_iter(project_paths.iter()),
            |row| row.get(0),
        )?
    };
    Ok(MemoryRenderSnapshot {
        revisions: if tables.memories == "memories" {
            let has_revision = conn
                .prepare("PRAGMA table_info(memories)")?
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .iter()
                .any(|name| name == "revision");
            let sql = format!(
                "SELECT id, {} FROM memories WHERE project_path IN ({placeholders})",
                if has_revision { "revision" } else { "1" }
            );
            let revisions = conn
                .prepare(&sql)?
                .query_map(rusqlite::params_from_iter(project_paths.iter()), |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
                })?
                .collect::<rusqlite::Result<_>>()?;
            revisions
        } else {
            Default::default()
        },
        fragment_watermark: if table_exists(conn, "main", "memory_agent_fragments")? {
            conn.query_row(
                "SELECT COALESCE(MAX(id),0) FROM memory_agent_fragments",
                [],
                |row| row.get(0),
            )?
        } else {
            0
        },
        memories,
        revision: MemoryRevision {
            project_memory_epoch: if table_exists(conn, "main", "project_state")? {
                conn.query_row("SELECT COALESCE((SELECT project_memory_epoch FROM project_state WHERE project_path=?1),0)", [project_path], |row|row.get(0))?
            } else {
                0
            },
            project_paths,
            reader_project_path: project_path.to_string(),
            expiry_cutoff_ms: now_ms,
            max_memory_id,
            mutation_cursor,
        },
    })
}

/// Active user-memory contents, in render order.
pub fn read_active_user_memories(
    conn: &Connection,
    tables: &DomainTables,
) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare(&format!(
        "SELECT content FROM {} WHERE status = 'active' ORDER BY promoted_at ASC, id ASC",
        tables.user_memories
    ))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn compartment_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredCompartment> {
    Ok(StoredCompartment {
        sequence: row.get(0)?,
        start_message: row.get(1)?,
        end_message: row.get(2)?,
        start_message_id: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        end_message_id: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        start_date: row.get(5)?,
        end_date: row.get(6)?,
        title: row.get(7)?,
        content: row.get(8)?,
        p1: row.get(9)?,
        p2: row.get(10)?,
        p3: row.get(11)?,
        p4: row.get(12)?,
        importance: row.get(13)?,
        episode_type: row.get(14)?,
        legacy: row.get::<_, Option<i64>>(15)?.unwrap_or(0) as i32,
        created_at: row.get(16)?,
    })
}

/// A session's compartments from the old `store.db` table, dates included, oldest first.
pub fn read_legacy_compartments(
    conn: &Connection,
    session_id: &str,
) -> rusqlite::Result<Vec<StoredCompartment>> {
    let mut statement = conn.prepare(
        "SELECT sequence, start_message, end_message, start_message_id, end_message_id,
                start_date, end_date, title, content, p1, p2, p3, p4, importance,
                episode_type, legacy, created_at
           FROM mc_compartments WHERE session_id = ?1 ORDER BY sequence ASC",
    )?;
    let rows = statement
        .query_map(params![session_id], compartment_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// A session's compartments from `context.db`, oldest first, without dates. Dates live in
/// `store.db`'s `mc_compartment_dates`; see [`apply_compartment_dates`].
pub fn read_context_compartments(
    conn: &Connection,
    session_id: &str,
) -> rusqlite::Result<Vec<StoredCompartment>> {
    let mut statement = conn.prepare_cached(
        "SELECT sequence, start_message, end_message, CASE WHEN start_block_index IS NULL THEN start_message_id ELSE start_message_id || '#' || start_block_index END, CASE WHEN end_block_index IS NULL THEN end_message_id ELSE end_message_id || '#' || end_block_index END,
                NULL, NULL, title, content, p1, p2, p3, p4, importance,
                episode_type, legacy, created_at
           FROM compartments WHERE session_id = ?1 ORDER BY sequence ASC",
    )?;
    let rows = statement
        .query_map(params![session_id], compartment_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Fill each compartment's dates from `store.db`'s date cache. A cached row whose message
/// ids differ from the compartment's belongs to an earlier compartment at the same position
/// and is ignored, so a rewrite never shows the dates of what it replaced.
pub fn apply_compartment_dates(
    store_conn: &Connection,
    session_id: &str,
    compartments: &mut [StoredCompartment],
) -> rusqlite::Result<()> {
    if compartments.is_empty() {
        return Ok(());
    }
    let mut statement = store_conn.prepare_cached(
        "SELECT sequence, start_message_id, end_message_id, start_date, end_date
           FROM mc_compartment_dates WHERE session_id = ?1",
    )?;
    let cached: HashMap<i64, (String, String, Option<String>, Option<String>)> = statement
        .query_map(params![session_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                (row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?),
            ))
        })?
        .collect::<Result<_, _>>()?;
    for compartment in compartments {
        if let Some((start_id, end_id, start_date, end_date)) = cached.get(&compartment.sequence) {
            if *start_id == compartment.start_message_id && *end_id == compartment.end_message_id {
                compartment.start_date = start_date.clone();
                compartment.end_date = end_date.clone();
            }
        }
    }
    Ok(())
}

/// Record the date segment of each compartment in the date cache, replacing whatever the
/// cache held at those positions. Called in the same `store.db` transaction that records
/// the fold, before the `context.db` write.
pub fn write_compartment_dates(
    store_conn: &Connection,
    session_id: &str,
    compartments: &[StoredCompartment],
) -> rusqlite::Result<()> {
    let mut statement = store_conn.prepare_cached(
        "INSERT INTO mc_compartment_dates(
             session_id, sequence, start_message_id, end_message_id, start_date, end_date
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(session_id, sequence) DO UPDATE SET
             start_message_id = excluded.start_message_id,
             end_message_id = excluded.end_message_id,
             start_date = excluded.start_date,
             end_date = excluded.end_date",
    )?;
    for compartment in compartments {
        statement.execute(params![
            session_id,
            compartment.sequence,
            compartment.start_message_id,
            compartment.end_message_id,
            compartment.start_date,
            compartment.end_date,
        ])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor(dir: &std::path::Path) -> cortexkit_store_types::StorageDescriptor {
        cortexkit_store_types::StorageDescriptor {
            module_id: "magic-context-test".to_string(),
            storage_namespace: STORE_NAMESPACE.to_string(),
            isolation: cortexkit_store_types::Isolation::Module,
            backend: cortexkit_store_types::StorageBackend::Sqlite {
                path: dir.join("store.db").to_string_lossy().into_owned(),
            },
        }
    }

    #[test]
    fn migration_61_leaves_no_schema_object_that_names_a_dropped_table() {
        let dir = tempfile::tempdir().unwrap();
        drop(crate::McStore::open(&descriptor(dir.path())).unwrap());
        let conn = Connection::open(dir.path().join("store.db")).unwrap();
        conn.execute_batch(MIGRATION_61_SQL).unwrap();
        let objects: Vec<(String, String, String)> = conn
            .prepare("SELECT type, name, COALESCE(sql, '') FROM sqlite_master")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for table in SINGLE_STORE_DROPPED_TABLES {
            for (kind, name, sql) in &objects {
                let named = sql
                    .split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_'))
                    .any(|word| word == *table);
                assert!(
                    !named,
                    "{kind} {name} still names dropped table {table}: {sql}"
                );
            }
        }
        assert!(table_exists(&conn, "main", "mc_compartment_dates").unwrap());
        assert!(table_exists(&conn, "main", "mc_single_store_pending_publish").unwrap());
    }

    /// What stops a ck-mc built before this migration: its store chain ends at 60, so a
    /// migrated store reads as ahead of it, and the marker it also checks is set. The old
    /// chain here is the real migration list cut at 60, not a hand-set version number.
    #[test]
    fn a_binary_whose_chain_ends_at_60_is_refused_by_a_migrated_store() {
        let dir = tempfile::tempdir().unwrap();
        drop(crate::McStore::open(&descriptor(dir.path())).unwrap());
        let old_chain: Vec<cortexkit_store::Migration> = crate::MIGRATIONS
            .iter()
            .filter(|migration| migration.version <= PRE_SINGLE_STORE_VERSION)
            .map(|migration| cortexkit_store::Migration {
                version: migration.version,
                statements: migration.statements,
            })
            .collect();
        assert_eq!(old_chain.last().unwrap().version, PRE_SINGLE_STORE_VERSION);
        let old = cortexkit_store::open_sqlite(&descriptor(dir.path())).unwrap();
        let outcome = old.migrate(STORE_NAMESPACE, &old_chain).unwrap();
        assert!(outcome.store_ahead());
        assert_eq!(outcome.recorded, crate::LATEST_MIGRATION_VERSION);
        let marker = old.with_conn(crate::read_single_store_marker).unwrap();
        assert!(marker.is_some(), "the marker is set as well");
    }

    /// An empty store takes the bundled chain on open and stamps the marker as a fresh install;
    /// a store holding a domain row is refused and keeps its rows and its version.
    #[test]
    fn open_migrates_an_empty_store_and_refuses_a_populated_one() {
        let dir = tempfile::tempdir().unwrap();
        drop(crate::McStore::open(&descriptor(dir.path())).unwrap());
        let conn = Connection::open(dir.path().join("store.db")).unwrap();
        assert_eq!(
            recorded_store_version(&conn).unwrap(),
            crate::LATEST_MIGRATION_VERSION
        );
        let (set, stamp, by): (i64, Option<i64>, String) = conn
            .query_row(
                "SELECT single_store, single_store_set_at_ms, single_store_set_by FROM mc_privilege_state",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(set, 1);
        assert!(stamp.is_some());
        assert!(by.ends_with(FRESH_INSTALL_MARKER_SUFFIX), "{by}");

        let populated = tempfile::tempdir().unwrap();
        let path = populated.path().join("store.db");
        crate::migrate_store_to_pre_single_store(&path).unwrap();
        Connection::open(&path)
            .unwrap()
            .execute(
                "INSERT INTO mc_compartments(session_id, sequence, start_message, end_message, title, content)
                 VALUES ('s', 1, 1, 2, 't', 'c')",
                [],
            )
            .unwrap();
        let error = crate::McStore::open(&descriptor(populated.path()))
            .err()
            .expect("a populated unmigrated store must be refused");
        assert!(matches!(
            error,
            crate::McStoreError::SingleStoreMigrationRequired { db_version: 60, .. }
        ));
        let conn = Connection::open(&path).unwrap();
        assert_eq!(recorded_store_version(&conn).unwrap(), 60);
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM mc_compartments", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1, "the refusal must leave the rows in place");
    }
}
