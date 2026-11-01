//! Put back session history that the single-store migration dropped
//! (`ck-mc single-store-repair-history`).
//!
//! Until the migration learned to keep whichever copy of a session's history was being
//! written, it always took `store.db`'s compartments and deleted every `context.db`
//! compartment above the store's last sequence. A session whose project had gone back to
//! TypeScript mode, so that only `context.db` kept growing, lost everything written after
//! the switch. The migration's own backup still holds it.
//!
//! Without `--apply` the command only reports: each session whose backup `context.db`
//! reached further than its backup `store.db` and whose live copy still lacks some of
//! the backup's compartments, and what restoring it would change. With `--apply` it first backs up both live files, then repairs each session in
//! its own transaction on `context.db`:
//!
//! - live compartments still exactly as the backup holds them are left alone;
//! - every other live compartment that starts inside the backup's range (rows the
//!   migration rewrote and rows the historian has re-summarised since) is removed, with
//!   its chunk embeddings and events, and the user-memory candidates drawn from that range;
//! - the backup's compartments are written back with their original ids, together with
//!   their chunk embeddings, events and user-memory candidates;
//! - live compartments that start after the backup's last message are kept and
//!   renumbered to follow it;
//! - the session's cached m[0]/m[1] and any pending compaction-marker move are cleared,
//!   and an m[0] mutation is logged, so the next pass rebuilds m[0] once from the
//!   restored rows.
//!
//! The `store.db` caches keyed by the session (compartment heading dates and the
//! module's cache state) are reset after that transaction commits. Both are derived and
//! are rebuilt on the next pass.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};

use crate::host_store::CONTEXT_BUSY_TIMEOUT_MS;
use crate::single_store_migrate::{
    as_i64, as_text, backup_files, get, now_ms, read_named_rows, EngineError, EngineOptions,
    Refusal, Row,
};

pub const NOT_MIGRATED: &str = "repair_not_migrated";
pub const BACKUP_MISMATCH: &str = "repair_backup_mismatch";
pub const SCHEMA_MISMATCH: &str = "repair_schema_mismatch";
pub const SESSION_BUSY: &str = "repair_session_busy";
pub const BACKUP_DIR_EXISTS: &str = "repair_backup_dir_exists";
pub const VERIFY_MISMATCH: &str = "repair_verify_mismatch";

/// Compartment columns left out when deciding whether a live compartment still is the
/// backup's. The id is matched on its own, and the P1 embedding is derived from the text
/// and may have been recomputed since.
const DERIVED_COLUMNS: &[&str] = &["id", "p1_embedding", "p1_embedding_model_id"];

const BLOCK_INDEX_COLUMNS: &[&str] = &["start_block_index", "end_block_index"];

/// The `session_meta` columns the host's `clearCachedM0M1` resets, with the value it
/// writes, plus the pending compaction-marker move. That move was queued for a
/// compartment the repair removes, so replaying it would pull the host's marker back.
const SESSION_META_RESETS: &[(&str, ResetValue)] = &[
    ("cached_m0_bytes", ResetValue::Null),
    ("cached_m0_mural_data_url", ResetValue::Null),
    ("cached_m0_mural_hash", ResetValue::Null),
    ("cached_m1_bytes", ResetValue::Null),
    ("cached_m0_project_memory_epoch", ResetValue::Null),
    ("cached_m0_workspace_fingerprint", ResetValue::Null),
    ("cached_m0_project_user_profile_version", ResetValue::Null),
    ("cached_m0_max_compartment_seq", ResetValue::Null),
    ("cached_m0_max_memory_id", ResetValue::Null),
    ("cached_m0_max_mutation_id", ResetValue::Null),
    ("cached_m0_max_memory_mutation_id", ResetValue::Null),
    ("cached_m0_project_docs_hash", ResetValue::Null),
    ("cached_m0_materialized_at", ResetValue::Null),
    ("cached_m0_session_facts_version", ResetValue::Null),
    ("cached_m0_upgrade_state", ResetValue::Null),
    ("cached_m0_system_hash", ResetValue::Null),
    ("cached_m0_tool_set_hash", ResetValue::Null),
    ("cached_m0_model_key", ResetValue::Null),
    ("cached_m0_project_identity", ResetValue::Null),
    ("cached_m0_last_baseline_end_message_id", ResetValue::Null),
    ("memory_block_cache", ResetValue::Empty),
    ("memory_block_count", ResetValue::Zero),
    ("memory_block_ids", ResetValue::Empty),
    ("pending_compaction_marker_state", ResetValue::Null),
];

#[derive(Debug, Clone, Copy)]
enum ResetValue {
    Null,
    Empty,
    Zero,
}

impl ResetValue {
    fn value(self) -> SqlValue {
        match self {
            ResetValue::Null => SqlValue::Null,
            ResetValue::Empty => SqlValue::Text(String::new()),
            ResetValue::Zero => SqlValue::Integer(0),
        }
    }
}

// ── Options and report ──────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RepairOptions {
    pub context_db: PathBuf,
    pub store_db: PathBuf,
    /// The migration's backup directory, holding the pre-migration `context.db` and
    /// `store.db`.
    pub from_backup: PathBuf,
    /// Limit the repair to these sessions. Empty means every session that needs it.
    pub sessions: Vec<String>,
    pub apply: bool,
    /// Where `--apply` backs up the live files first. It must not exist yet.
    pub backup_dir: Option<PathBuf>,
    pub now_ms: i64,
}

impl RepairOptions {
    pub fn new(context_db: PathBuf, store_db: PathBuf, from_backup: PathBuf) -> Self {
        RepairOptions {
            context_db,
            store_db,
            from_backup,
            sessions: Vec::new(),
            apply: false,
            backup_dir: None,
            now_ms: now_ms(),
        }
    }
}

/// How far one copy of a session's history reaches.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct Extent {
    pub compartments: usize,
    pub max_sequence: Option<i64>,
    pub end_message: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct RowChange {
    pub restored: usize,
    pub removed: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct SessionPlan {
    pub session: String,
    pub project: Option<String>,
    pub backup: Extent,
    pub live: Extent,
    /// What the live copy holds once the repair is applied.
    pub after: Extent,
    /// Live compartments identical to the backup's, left in place.
    pub kept: usize,
    /// Backup compartments written back.
    pub restored: usize,
    /// Live compartments removed because they start inside the backup's range.
    pub removed: usize,
    pub removed_sequences: Option<(i64, i64)>,
    pub removed_created_at: Option<(i64, i64)>,
    /// Removed compartments that also reach past the backup's last message. The
    /// historian summarises that stretch again on its next run.
    pub straddling: usize,
    /// Live compartments that start after the backup's last message, kept and
    /// renumbered to follow the restored ones.
    pub tail: usize,
    pub compartment_events: RowChange,
    pub chunk_embeddings: RowChange,
    pub user_memory_candidates: RowChange,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct RepairReport {
    /// `preview` or `repaired`.
    pub status: String,
    pub backup_dir: Option<String>,
    pub sessions: Vec<SessionPlan>,
    /// Sessions named with `--session` that did not lose history to the migration, or
    /// were repaired already.
    pub not_needed: Vec<String>,
}

impl RepairReport {
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

fn refused(code: &str, message: impl Into<String>) -> EngineError {
    Refusal::new(code, message).into()
}

fn mismatch(message: impl Into<String>) -> EngineError {
    refused(VERIFY_MISMATCH, message)
}

// ── Opening both copies ─────────────────────────────────────────────────────

/// A read-only `file:` URI for `path`, so the backup can be attached without any chance
/// of writing to it.
fn read_only_uri(path: &Path) -> String {
    let mut uri = String::from("file:");
    for character in path.to_string_lossy().chars() {
        match character {
            '%' => uri.push_str("%25"),
            '?' => uri.push_str("%3f"),
            '#' => uri.push_str("%23"),
            other => uri.push(other),
        }
    }
    uri.push_str("?mode=ro");
    uri
}

fn open(options: &RepairOptions, writable: bool) -> Result<Connection, EngineError> {
    for path in [
        &options.context_db,
        &options.from_backup.join("context.db"),
        &options.from_backup.join("store.db"),
    ] {
        if !path.exists() {
            return Err(EngineError::Internal(format!(
                "{} does not exist",
                path.display()
            )));
        }
    }
    let access = if writable {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let conn =
        Connection::open_with_flags(&options.context_db, access | OpenFlags::SQLITE_OPEN_URI)?;
    mc_store::single_store_domain::set_synchronous_normal_if_wal(&conn)?;
    conn.busy_timeout(std::time::Duration::from_millis(u64::from(
        CONTEXT_BUSY_TIMEOUT_MS,
    )))?;
    conn.execute(
        "ATTACH DATABASE ?1 AS bak",
        params![read_only_uri(&options.from_backup.join("context.db"))],
    )?;
    conn.execute(
        "ATTACH DATABASE ?1 AS bakstore",
        params![read_only_uri(&options.from_backup.join("store.db"))],
    )?;
    Ok(conn)
}

fn has_table(conn: &Connection, schema: &str, table: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {schema}.sqlite_master WHERE type = 'table' AND name = ?1)"),
        params![table],
        |row| row.get(0),
    )
}

fn columns(conn: &Connection, schema: &str, table: &str) -> rusqlite::Result<Vec<String>> {
    conn.prepare(&format!("PRAGMA {schema}.table_info(\"{table}\")"))?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect()
}

/// The columns of `table` both copies have, in the live file's order. A backup column the
/// live file lacks would be lost on restore, so it refuses.
fn shared_columns(conn: &Connection, table: &str) -> Result<Vec<String>, EngineError> {
    let live = columns(conn, "main", table)?;
    let backup = columns(conn, "bak", table)?;
    if let Some(missing) = backup.iter().find(|column| !live.contains(column)) {
        return Err(refused(
            SCHEMA_MISMATCH,
            format!("the backup's {table} has column {missing}, which the live context.db lacks"),
        ));
    }
    Ok(live
        .into_iter()
        .filter(|column| backup.contains(column))
        .collect())
}

fn store_uuid(conn: &Connection, schema: &str) -> rusqlite::Result<Option<String>> {
    if !has_table(conn, schema, "context_store_meta")? {
        return Ok(None);
    }
    conn.query_row(
        &format!("SELECT value FROM {schema}.context_store_meta WHERE key = 'store_uuid'"),
        [],
        |row| row.get(0),
    )
    .optional()
}

fn migration_state(conn: &Connection, schema: &str) -> rusqlite::Result<Option<String>> {
    if !has_table(conn, schema, "single_store_state")? {
        return Ok(None);
    }
    conn.query_row(
        &format!("SELECT state FROM {schema}.single_store_state WHERE id = 1"),
        [],
        |row| row.get(0),
    )
    .optional()
}

/// The live file must be migrated, and the backup must be this file's own copy from
/// before the migration.
fn check_pair(conn: &Connection) -> Result<(), EngineError> {
    if migration_state(conn, "main")?.as_deref() != Some("migrated") {
        return Err(refused(
            NOT_MIGRATED,
            "the live context.db is not single-store migrated; there is nothing to repair",
        ));
    }
    if migration_state(conn, "bak")?.as_deref() == Some("migrated") {
        return Err(refused(
            BACKUP_MISMATCH,
            "the backup's context.db is already migrated; pass the backup the migration wrote before it ran",
        ));
    }
    let (live, backup) = (store_uuid(conn, "main")?, store_uuid(conn, "bak")?);
    if live.is_some() && backup.is_some() && live != backup {
        return Err(refused(
            BACKUP_MISMATCH,
            format!(
                "the backup's context.db is another file (store_uuid {} vs {})",
                backup.unwrap_or_default(),
                live.unwrap_or_default()
            ),
        ));
    }
    if !has_table(conn, "bakstore", "mc_compartments")? {
        return Err(refused(
            BACKUP_MISMATCH,
            "the backup's store.db has no mc_compartments table; pass the backup the migration wrote before it ran",
        ));
    }
    Ok(())
}

/// Sessions that lost history to the old rule: the migration moved them (the backup
/// `store.db` has compartments for them), their backup `context.db` reached further than
/// the backup `store.db` (so the rule deleted the difference), and the live file still
/// lacks at least one of the backup's compartments. A session no longer in the live file
/// at all was deleted since and is left alone; a repaired session holds every backup
/// compartment again and is not offered twice.
fn sessions_needing_repair(conn: &Connection) -> rusqlite::Result<BTreeSet<String>> {
    conn.prepare(
        "WITH context_reach AS (
              SELECT session_id, MAX(end_message) AS reach FROM bak.compartments GROUP BY session_id),
              store_reach AS (
              SELECT session_id, MAX(end_message) AS reach FROM bakstore.mc_compartments GROUP BY session_id)
         SELECT c.session_id
           FROM context_reach AS c JOIN store_reach AS s ON s.session_id = c.session_id
          WHERE c.reach > s.reach
            AND EXISTS (SELECT 1 FROM main.compartments AS l WHERE l.session_id = c.session_id)
            AND EXISTS (
                SELECT 1 FROM bak.compartments AS b
                 WHERE b.session_id = c.session_id
                   AND NOT EXISTS (SELECT 1 FROM main.compartments AS l WHERE l.id = b.id))",
    )?
    .query_map([], |row| row.get(0))?
    .collect()
}

// ── Planning one session ────────────────────────────────────────────────────

/// Everything the apply step needs for one session, worked out without writing.
struct Work {
    plan: SessionPlan,
    /// The backup compartments to write back, in `columns` order, boundaries normalized.
    restore: Vec<Vec<SqlValue>>,
    restore_ids: Vec<i64>,
    removed_ids: Vec<i64>,
    /// Live compartments past the backup's end, by their current sequence.
    tail_ids: Vec<i64>,
    backup_max_sequence: i64,
    /// The lowest sequence written back. Candidates drawn from this sequence onwards
    /// belong to the restored range.
    first_restored_sequence: Option<i64>,
}

fn text(value: &str) -> SqlValue {
    SqlValue::Text(value.to_string())
}

/// Write a backup compartment's boundaries the way the live file now spells them: the
/// migration split flat `message#block` ids into an id and a block index.
fn normalize_boundaries(row: &mut Row) -> Result<(), EngineError> {
    for (id_column, block_column) in [
        ("start_message_id", "start_block_index"),
        ("end_message_id", "end_block_index"),
    ] {
        let Some(raw) = as_text(&get(row, id_column)).map(str::to_string) else {
            continue;
        };
        let (id, block) = mc_store::context_boundaries::canonical_boundary_parts(&raw)?;
        if id == raw {
            continue;
        }
        let old = as_i64(&get(row, block_column));
        if block.zip(old).is_some_and(|(new, old)| new != old) {
            return Err(mismatch(format!(
                "backup compartment {:?} has conflicting flat and indexed boundaries",
                get(row, "id")
            )));
        }
        let id = id.to_string();
        row.insert(id_column.to_string(), text(&id));
        row.insert(
            block_column.to_string(),
            block.or(old).map_or(SqlValue::Null, SqlValue::Integer),
        );
    }
    Ok(())
}

fn id_list(ids: &[i64]) -> String {
    if ids.is_empty() {
        return "NULL".to_string();
    }
    ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
}

fn count(conn: &Connection, sql: &str, args: &[SqlValue]) -> rusqlite::Result<usize> {
    conn.query_row(sql, params_from_iter(args.iter()), |row| {
        row.get::<_, i64>(0)
    })
    .map(|value| value as usize)
}

fn extent(rows: &[Row]) -> Extent {
    Extent {
        compartments: rows.len(),
        max_sequence: rows
            .iter()
            .filter_map(|row| as_i64(&get(row, "sequence")))
            .max(),
        end_message: rows
            .iter()
            .filter_map(|row| as_i64(&get(row, "end_message")))
            .max(),
    }
}

fn span(values: impl Iterator<Item = i64>) -> Option<(i64, i64)> {
    values.fold(None, |span, value| match span {
        None => Some((value, value)),
        Some((low, high)) => Some((low.min(value), high.max(value))),
    })
}

fn plan_session(conn: &Connection, session: &str, columns: &[String]) -> Result<Work, EngineError> {
    let session_arg = [text(session)];
    let mut backup = read_named_rows(
        conn,
        "SELECT * FROM bak.compartments WHERE session_id = ?1 ORDER BY sequence",
        &session_arg,
    )?;
    let live = read_named_rows(
        conn,
        "SELECT * FROM main.compartments WHERE session_id = ?1 ORDER BY sequence",
        &session_arg,
    )?;
    let backup_extent = extent(&backup);
    let live_extent = extent(&live);
    for row in &mut backup {
        normalize_boundaries(row)?;
    }
    let compared: Vec<&String> = columns
        .iter()
        .filter(|column| !DERIVED_COLUMNS.contains(&column.as_str()))
        .collect();
    let live_by_id: HashMap<i64, &Row> = live
        .iter()
        .filter_map(|row| as_i64(&get(row, "id")).map(|id| (id, row)))
        .collect();
    let mut kept = BTreeSet::new();
    let mut restore = Vec::new();
    let mut restore_ids = Vec::new();
    for row in &backup {
        let id = as_i64(&get(row, "id")).unwrap_or_default();
        let unchanged = live_by_id.get(&id).is_some_and(|current| {
            compared.iter().all(|column| {
                let (live, backup) = (get(current, column), get(row, column));
                live == backup
                    // TypeScript left block indexes unset; the migration filled them
                    // in from the store's spelling of the same boundary.
                    || (BLOCK_INDEX_COLUMNS.contains(&column.as_str()) && backup == SqlValue::Null)
            })
        });
        if unchanged {
            kept.insert(id);
        } else {
            restore_ids.push(id);
            restore.push(columns.iter().map(|column| get(row, column)).collect());
        }
    }
    let reach = backup_extent.end_message.unwrap_or(i64::MIN);
    let mut removed = Vec::new();
    let mut tail = Vec::new();
    for row in &live {
        let id = as_i64(&get(row, "id")).unwrap_or_default();
        if kept.contains(&id) {
            continue;
        }
        if as_i64(&get(row, "start_message")).unwrap_or_default() <= reach {
            removed.push(row);
        } else {
            tail.push(row);
        }
    }
    let removed_ids: Vec<i64> = removed
        .iter()
        .filter_map(|row| as_i64(&get(row, "id")))
        .collect();
    // A backup id still used by a live row that is not being removed would make the
    // restore collide with an unrelated compartment.
    for id in &restore_ids {
        if removed_ids.contains(id) {
            continue;
        }
        let owner: Option<String> = conn
            .query_row(
                "SELECT session_id FROM main.compartments WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(owner) = owner {
            return Err(refused(
                BACKUP_MISMATCH,
                format!("backup compartment {id} of {session} has the id of live compartment {id} of {owner}"),
            ));
        }
    }
    let backup_max_sequence = backup_extent.max_sequence.unwrap_or(-1);
    let first_restored_sequence = backup
        .iter()
        .filter(|row| as_i64(&get(row, "id")).is_some_and(|id| !kept.contains(&id)))
        .filter_map(|row| as_i64(&get(row, "sequence")))
        .min();
    let tail_ids: Vec<i64> = tail
        .iter()
        .filter_map(|row| as_i64(&get(row, "id")))
        .collect();
    let tail_reach = tail
        .iter()
        .filter_map(|row| as_i64(&get(row, "end_message")))
        .max();

    let removed_list = id_list(&removed_ids);
    let restore_list = id_list(&restore_ids);
    let first = SqlValue::Integer(first_restored_sequence.unwrap_or(i64::MAX));
    let session_first = [text(session), first.clone()];
    let project = conn
        .query_row(
            "SELECT project_path FROM main.session_projects WHERE session_id = ?1 ORDER BY harness LIMIT 1",
            params![session],
            |row| row.get(0),
        )
        .optional()?;
    let plan = SessionPlan {
        session: session.to_string(),
        project,
        after: Extent {
            compartments: kept.len() + restore_ids.len() + tail_ids.len(),
            max_sequence: Some(backup_max_sequence + tail_ids.len() as i64)
                .filter(|sequence| *sequence >= 0),
            end_message: backup_extent.end_message.max(tail_reach),
        },
        backup: backup_extent,
        live: live_extent,
        kept: kept.len(),
        restored: restore_ids.len(),
        removed: removed.len(),
        removed_sequences: span(removed.iter().filter_map(|row| as_i64(&get(row, "sequence")))),
        removed_created_at: span(
            removed
                .iter()
                .filter_map(|row| as_i64(&get(row, "created_at"))),
        ),
        straddling: removed
            .iter()
            .filter(|row| as_i64(&get(row, "end_message")).unwrap_or_default() > reach)
            .count(),
        tail: tail_ids.len(),
        compartment_events: RowChange {
            restored: count(
                conn,
                &format!("SELECT COUNT(*) FROM bak.compartment_events AS b WHERE b.session_id = ?1
                   AND NOT EXISTS (SELECT 1 FROM main.compartment_events AS l WHERE l.id = b.id
                                     AND (l.compartment_id IS NULL OR l.compartment_id NOT IN ({removed_list})))"),
                &session_arg,
            )?,
            removed: count(
                conn,
                &format!("SELECT COUNT(*) FROM main.compartment_events WHERE session_id = ?1 AND compartment_id IN ({removed_list})"),
                &session_arg,
            )?,
        },
        chunk_embeddings: RowChange {
            restored: count(
                conn,
                &format!("SELECT COUNT(*) FROM bak.compartment_chunk_embeddings WHERE compartment_id IN ({restore_list})"),
                &[],
            )?,
            removed: count(
                conn,
                &format!("SELECT COUNT(*) FROM main.compartment_chunk_embeddings WHERE compartment_id IN ({removed_list})"),
                &[],
            )?,
        },
        user_memory_candidates: RowChange {
            restored: count(
                conn,
                "SELECT COUNT(*) FROM bak.user_memory_candidates AS b
                  WHERE b.session_id = ?1 AND b.source_compartment_start >= ?2
                    AND NOT EXISTS (SELECT 1 FROM main.user_memory_candidates AS l WHERE l.id = b.id)",
                &session_first,
            )?,
            removed: count(
                conn,
                "SELECT COUNT(*) FROM main.user_memory_candidates AS l
                  WHERE l.session_id = ?1 AND l.source_compartment_end >= ?2
                    AND NOT EXISTS (SELECT 1 FROM bak.user_memory_candidates AS b WHERE b.id = l.id)",
                &session_first,
            )?,
        },
    };
    Ok(Work {
        plan,
        restore,
        restore_ids,
        removed_ids,
        tail_ids,
        backup_max_sequence,
        first_restored_sequence,
    })
}

// ── Applying one session ────────────────────────────────────────────────────

/// Refuse while a historian or recomp could be writing this session's history.
fn check_idle(conn: &Connection, session: &str, now: i64) -> Result<(), EngineError> {
    let mut reasons = Vec::new();
    if has_table(conn, "main", "compartment_state_lease")? {
        let holder: Option<String> = conn
            .query_row(
                "SELECT holder_id FROM main.compartment_state_lease WHERE session_id = ?1 AND expires_at > ?2",
                params![session, now],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(holder) = holder {
            reasons.push(format!("a compartment lease is held by {holder}"));
        }
    }
    let in_progress: Option<i64> = conn
        .query_row(
            "SELECT compartment_in_progress FROM main.session_meta WHERE session_id = ?1",
            params![session],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    if in_progress.unwrap_or(0) != 0 {
        reasons.push("a historian run is in progress".to_string());
    }
    if has_table(conn, "main", "recomp_compartments")?
        && count(
            conn,
            "SELECT COUNT(*) FROM main.recomp_compartments WHERE session_id = ?1",
            &[text(session)],
        )? > 0
    {
        reasons.push("a recomp is staged".to_string());
    }
    if reasons.is_empty() {
        return Ok(());
    }
    Err(Refusal::new(
        SESSION_BUSY,
        format!(
            "session {session} is being written ({}); wait for it to finish and run again",
            reasons.join("; ")
        ),
    )
    .with_detail(json!({"session": session, "reasons": reasons}))
    .into())
}

fn dangling_events(conn: &Connection, session: &str) -> rusqlite::Result<usize> {
    count(
        conn,
        "SELECT COUNT(*) FROM main.compartment_events AS e
          WHERE e.session_id = ?1 AND e.compartment_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM main.compartments AS c WHERE c.id = e.compartment_id)",
        &[text(session)],
    )
}

fn apply_session(
    conn: &Connection,
    work: &Work,
    columns: &[String],
    now: i64,
) -> Result<(), EngineError> {
    let step = std::time::Instant::now();
    let session = work.plan.session.as_str();
    let dangling_before = dangling_events(conn, session)?;
    let removed = id_list(&work.removed_ids);
    let restored = id_list(&work.restore_ids);
    let first = work.first_restored_sequence.unwrap_or(i64::MAX);

    // Park the tail out of the way: its sequences may be the ones the backup reuses.
    for (index, id) in work.tail_ids.iter().enumerate() {
        conn.execute(
            "UPDATE main.compartments SET sequence = ?1 WHERE id = ?2",
            params![-1_000_000_000 - index as i64, id],
        )?;
    }
    conn.execute(
        &format!(
            "DELETE FROM main.compartment_chunk_embeddings WHERE compartment_id IN ({removed})"
        ),
        [],
    )?;
    conn.execute(
        &format!("DELETE FROM main.compartment_events WHERE session_id = ?1 AND compartment_id IN ({removed})"),
        params![session],
    )?;
    conn.execute(
        "DELETE FROM main.user_memory_candidates
          WHERE session_id = ?1 AND source_compartment_end >= ?2
            AND id NOT IN (SELECT id FROM bak.user_memory_candidates WHERE session_id = ?1)",
        params![session, first],
    )?;
    conn.execute(
        &format!("DELETE FROM main.compartments WHERE id IN ({removed})"),
        [],
    )?;

    let column_names = columns
        .iter()
        .map(|column| format!("\"{column}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let slots = (1..=columns.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    {
        let mut insert = conn.prepare(&format!(
            "INSERT INTO main.compartments({column_names}) VALUES ({slots})"
        ))?;
        for row in &work.restore {
            insert.execute(params_from_iter(row.iter()))?;
        }
    }

    // Vector/dims payloads are immutable at a rowid: refreshes delete/insert rows,
    // while in-place repairs change window_index/project_path/harness. Restore the
    // backup payload with INSERT rather than updating an existing vector in place.
    let embedding_columns = shared_columns(conn, "compartment_chunk_embeddings")?;
    let embedding_values = embedding_columns
        .iter()
        .filter(|column| column.as_str() != "id")
        .map(|column| format!("\"{column}\""))
        .collect::<Vec<_>>()
        .join(", ");
    // A backup embedding whose id a live row now uses gets a fresh id; the rest keep
    // theirs. The fresh ids are assigned first so they cannot land on a kept one.
    conn.execute(
        &format!(
            "INSERT INTO main.compartment_chunk_embeddings({embedding_values})
             SELECT {embedding_values} FROM bak.compartment_chunk_embeddings AS b
              WHERE b.compartment_id IN ({restored})
                AND EXISTS (SELECT 1 FROM main.compartment_chunk_embeddings AS l WHERE l.id = b.id)"
        ),
        [],
    )?;
    conn.execute(
        &format!(
            "INSERT INTO main.compartment_chunk_embeddings(id, {embedding_values})
             SELECT id, {embedding_values} FROM bak.compartment_chunk_embeddings AS b
              WHERE b.compartment_id IN ({restored})
                AND NOT EXISTS (SELECT 1 FROM main.compartment_chunk_embeddings AS l WHERE l.id = b.id)"
        ),
        [],
    )?;
    let event_columns = shared_columns(conn, "compartment_events")?
        .iter()
        .map(|column| format!("\"{column}\""))
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute(
        &format!(
            "INSERT INTO main.compartment_events({event_columns})
             SELECT {event_columns} FROM bak.compartment_events AS b
              WHERE b.session_id = ?1
                AND NOT EXISTS (SELECT 1 FROM main.compartment_events AS l WHERE l.id = b.id)"
        ),
        params![session],
    )?;
    let candidate_columns = shared_columns(conn, "user_memory_candidates")?
        .iter()
        .map(|column| format!("\"{column}\""))
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute(
        &format!(
            "INSERT INTO main.user_memory_candidates({candidate_columns})
             SELECT {candidate_columns} FROM bak.user_memory_candidates AS b
              WHERE b.session_id = ?1 AND b.source_compartment_start >= ?2
                AND NOT EXISTS (SELECT 1 FROM main.user_memory_candidates AS l WHERE l.id = b.id)"
        ),
        params![session, first],
    )?;
    for (index, id) in work.tail_ids.iter().enumerate() {
        conn.execute(
            "UPDATE main.compartments SET sequence = ?1 WHERE id = ?2",
            params![work.backup_max_sequence + 1 + index as i64, id],
        )?;
    }

    // One structural mutation makes the host fold m[0] from the restored rows on its
    // next pass; the cleared cache makes that fold unconditional.
    conn.execute(
        "INSERT INTO main.m0_mutation_log(session_id, mutation_type, target_id, queued_at)
         VALUES (?1, 'compartment_delete', NULL, ?2)",
        params![session, now],
    )?;
    let meta_columns = columns_of(conn, "main", "session_meta")?;
    let resets: Vec<&(&str, ResetValue)> = SESSION_META_RESETS
        .iter()
        .filter(|(column, _)| meta_columns.contains(*column))
        .collect();
    if !resets.is_empty() {
        let assignments = resets
            .iter()
            .enumerate()
            .map(|(index, (column, _))| format!("{column} = ?{}", index + 2))
            .collect::<Vec<_>>()
            .join(", ");
        let mut values = vec![text(session)];
        values.extend(resets.iter().map(|(_, reset)| reset.value()));
        conn.execute(
            &format!("UPDATE main.session_meta SET {assignments} WHERE session_id = ?1"),
            params_from_iter(values.iter()),
        )?;
    }

    if conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM main.sqlite_master WHERE name='session_render_cache')",
        [],
        |row| row.get::<_, bool>(0),
    )? {
        conn.execute(
            "DELETE FROM main.session_render_cache WHERE session_id=?1",
            [session],
        )?;
    }
    if conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM main.sqlite_master WHERE name='session_meta_chunks')",
        [],
        |row| row.get::<_, bool>(0),
    )? {
        conn.execute("DELETE FROM main.session_meta_chunks WHERE session_id=?1 AND column_name='memory_block_ids'", [session])?;
    }

    eprintln!("written in {:.2}s", step.elapsed().as_secs_f64());
    let step = std::time::Instant::now();
    let verified = verify_session(conn, work, columns, dangling_before);
    eprintln!("verified in {:.2}s", step.elapsed().as_secs_f64());
    verified
}

fn columns_of(conn: &Connection, schema: &str, table: &str) -> rusqlite::Result<BTreeSet<String>> {
    Ok(columns(conn, schema, table)?.into_iter().collect())
}

/// Re-read what the repair wrote before it commits.
fn verify_session(
    conn: &Connection,
    work: &Work,
    columns: &[String],
    dangling_before: usize,
) -> Result<(), EngineError> {
    let session = work.plan.session.as_str();
    let column_names = columns
        .iter()
        .map(|column| format!("\"{column}\""))
        .collect::<Vec<_>>()
        .join(", ");
    for (id, desired) in work.restore_ids.iter().zip(&work.restore) {
        let current: Option<Vec<SqlValue>> = conn
            .query_row(
                &format!("SELECT {column_names} FROM main.compartments WHERE id = ?1"),
                params![id],
                |row| (0..columns.len()).map(|index| row.get(index)).collect(),
            )
            .optional()?;
        if current.as_ref() != Some(desired) {
            return Err(mismatch(format!(
                "compartment {id} of {session} does not hold the backup's values after the restore"
            )));
        }
    }
    let (rows, max_sequence, distinct): (usize, Option<i64>, usize) = conn.query_row(
        "SELECT COUNT(*), MAX(sequence), COUNT(DISTINCT sequence) FROM main.compartments WHERE session_id = ?1",
        params![session],
        |row| Ok((row.get::<_, i64>(0)? as usize, row.get(1)?, row.get::<_, i64>(2)? as usize)),
    )?;
    if rows != work.plan.after.compartments
        || distinct != rows
        || max_sequence != work.plan.after.max_sequence
    {
        return Err(mismatch(format!(
            "session {session} has {rows} compartments up to sequence {max_sequence:?} after the restore; expected {} up to {:?}",
            work.plan.after.compartments, work.plan.after.max_sequence
        )));
    }
    let negative = count(
        conn,
        "SELECT COUNT(*) FROM main.compartments WHERE session_id = ?1 AND sequence < 0",
        &[text(session)],
    )?;
    if negative > 0 {
        return Err(mismatch(format!(
            "session {session} has parked sequences left"
        )));
    }
    let orphaned = count(
        conn,
        "SELECT COUNT(*) FROM main.compartment_chunk_embeddings AS e
          WHERE e.session_id = ?1
            AND NOT EXISTS (SELECT 1 FROM main.compartments AS c WHERE c.id = e.compartment_id)",
        &[text(session)],
    )?;
    if orphaned > 0 {
        return Err(mismatch(format!(
            "{orphaned} chunk embedding(s) of {session} name a missing compartment"
        )));
    }
    let dangling_after = dangling_events(conn, session)?;
    if dangling_after > dangling_before {
        return Err(mismatch(format!(
            "session {session} has {dangling_after} event(s) naming a missing compartment after the restore, {dangling_before} before"
        )));
    }
    Ok(())
}

/// Reset the session's derived `store.db` rows: the heading-date cache for the restored
/// range, and the module's cache state, marked for one hard rebuild the same way the
/// migration marks every session.
fn reset_store_caches(options: &RepairOptions, work: &Work) -> Result<(), EngineError> {
    let conn = Connection::open_with_flags(&options.store_db, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    mc_store::single_store_domain::set_synchronous_normal_if_wal(&conn)?;
    conn.busy_timeout(std::time::Duration::from_millis(u64::from(
        CONTEXT_BUSY_TIMEOUT_MS,
    )))?;
    let session = work.plan.session.as_str();
    if has_table(&conn, "main", "mc_compartment_dates")? {
        conn.execute(
            "DELETE FROM mc_compartment_dates WHERE session_id = ?1 AND sequence >= ?2",
            params![
                session,
                work.first_restored_sequence
                    .unwrap_or(work.backup_max_sequence + 1)
            ],
        )?;
    }
    if has_table(&conn, "main", "mc_cache_state")? {
        let meta: Option<String> = conn
            .query_row(
                "SELECT meta FROM mc_cache_state WHERE session_id = ?1",
                params![session],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(meta) = meta {
            let mut value = match serde_json::from_str::<Value>(&meta) {
                Ok(value @ Value::Object(_)) => value,
                _ => json!({}),
            };
            let object = value.as_object_mut().expect("checked above");
            // Restored history invalidates the frozen baseline independently of
            // any dashboard memory change counter.
            object.insert("bootstrap_seed_fold_pending".into(), true.into());
            conn.execute(
                "UPDATE mc_cache_state SET meta = ?2, row_version = row_version + 1 WHERE session_id = ?1",
                params![session, value.to_string()],
            )?;
        }
    }
    Ok(())
}

// ── The run ─────────────────────────────────────────────────────────────────

pub fn run(options: &RepairOptions) -> Result<RepairReport, EngineError> {
    let (plans, not_needed) = {
        let conn = open(options, false)?;
        check_pair(&conn)?;
        let columns = shared_columns(&conn, "compartments")?;
        let needing = sessions_needing_repair(&conn)?;
        let (wanted, not_needed): (Vec<String>, Vec<String>) = if options.sessions.is_empty() {
            (needing.into_iter().collect(), Vec::new())
        } else {
            options
                .sessions
                .iter()
                .cloned()
                .partition(|session| needing.contains(session))
        };
        let mut plans = Vec::new();
        for session in &wanted {
            plans.push(plan_session(&conn, session, &columns)?.plan);
        }
        (plans, not_needed)
    };
    if !options.apply {
        return Ok(RepairReport {
            status: "preview".into(),
            backup_dir: None,
            sessions: plans,
            not_needed,
        });
    }
    let Some(backup_dir) = options.backup_dir.clone() else {
        return Err(EngineError::Internal(
            "--apply needs --backup-dir for the backup it takes first".into(),
        ));
    };
    if backup_dir.exists() {
        return Err(refused(
            BACKUP_DIR_EXISTS,
            format!(
                "the backup directory {} already exists; choose a new one",
                backup_dir.display()
            ),
        ));
    }
    backup_files(&EngineOptions::new(
        options.context_db.clone(),
        options.store_db.clone(),
        backup_dir.clone(),
    ))?;
    eprintln!(
        "Backup of the live files written to {}. To undo the repair: quit every host, then copy context.db and store.db from it back over the live files and remove their -wal and -shm files.",
        backup_dir.display()
    );

    let conn = open(options, true)?;
    // Leave checkpointing to the hosts. A checkpoint run by this connection's COMMIT
    // copies the whole write-ahead log into a multi-gigabyte file, and a running host
    // waiting on context.db would wait for it.
    conn.query_row("PRAGMA main.wal_autocheckpoint = 0", [], |row| {
        row.get::<_, i64>(0)
    })?;
    let columns = shared_columns(&conn, "compartments")?;
    let mut repaired = Vec::new();
    for plan in &plans {
        let started = std::time::Instant::now();
        conn.execute_batch("BEGIN IMMEDIATE")?;
        // Planned again inside the transaction: the historian may have published since
        // the preview.
        let outcome = check_idle(&conn, &plan.session, options.now_ms)
            .and_then(|()| plan_session(&conn, &plan.session, &columns))
            .and_then(|work| {
                eprintln!("planned in {:.2}s", started.elapsed().as_secs_f64());
                apply_session(&conn, &work, &columns, options.now_ms)?;
                Ok(work)
            });
        match outcome {
            Ok(work) => {
                conn.execute_batch("COMMIT")?;
                // How long context.db's write lock was held, which a running host waits on.
                let held = started.elapsed();
                reset_store_caches(options, &work)?;
                eprintln!(
                    "repaired {}: {} compartments restored, {} removed; write transaction {:.2}s",
                    work.plan.session,
                    work.plan.restored,
                    work.plan.removed,
                    held.as_secs_f64()
                );
                repaired.push(work.plan);
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                if !repaired.is_empty() {
                    eprintln!(
                        "stopped after repairing {}",
                        repaired
                            .iter()
                            .map(|plan: &SessionPlan| plan.session.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    );
                }
                return Err(error);
            }
        }
    }
    Ok(RepairReport {
        status: "repaired".into(),
        backup_dir: Some(backup_dir.display().to_string()),
        sessions: repaired,
        not_needed,
    })
}

// ── Command line ────────────────────────────────────────────────────────────

const USAGE: &str = "usage: ck-mc single-store-repair-history --context-db <path> --store-db <path> --from-backup <dir> [--session <id>]... [--apply --backup-dir <dir>]";

pub fn parse_args(args: &[String]) -> Result<RepairOptions, String> {
    let mut context_db = None;
    let mut store_db = None;
    let mut from_backup = None;
    let mut backup_dir = None;
    let mut sessions = Vec::new();
    let mut apply = false;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let mut value = |name: &str| {
            iter.next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value; {USAGE}"))
        };
        match arg.as_str() {
            "--context-db" => context_db = Some(PathBuf::from(value("--context-db")?)),
            "--store-db" => store_db = Some(PathBuf::from(value("--store-db")?)),
            "--from-backup" => from_backup = Some(PathBuf::from(value("--from-backup")?)),
            "--backup-dir" => backup_dir = Some(PathBuf::from(value("--backup-dir")?)),
            "--session" => sessions.push(value("--session")?),
            "--apply" => apply = true,
            other => return Err(format!("unknown argument {other}; {USAGE}")),
        }
    }
    let (Some(context_db), Some(store_db), Some(from_backup)) = (context_db, store_db, from_backup)
    else {
        return Err(USAGE.to_string());
    };
    if apply && backup_dir.is_none() {
        return Err(format!("--apply needs --backup-dir; {USAGE}"));
    }
    let mut options = RepairOptions::new(context_db, store_db, from_backup);
    options.sessions = sessions;
    options.apply = apply;
    options.backup_dir = backup_dir;
    Ok(options)
}

/// Run the command: the report is one JSON object on stdout. Exit 0 on a preview or a
/// repair, 2 when refused, 1 on an internal error.
pub fn cli_main(args: &[String]) -> i32 {
    let options = match parse_args(args) {
        Ok(options) => options,
        Err(usage) => {
            println!(
                "{}",
                json!({"status": "refused", "refusal": {"code": "repair_usage", "message": usage}})
            );
            return 2;
        }
    };
    match run(&options) {
        Ok(report) => {
            println!("{}", report.to_value());
            0
        }
        Err(EngineError::Refused(refusal)) => {
            println!(
                "{}",
                json!({"status": "refused", "refusal": refusal.to_value()})
            );
            2
        }
        Err(EngineError::Internal(message)) => {
            println!("{}", json!({"status": "error", "error": message}));
            1
        }
    }
}

#[cfg(test)]
#[path = "single_store_repair_tests.rs"]
mod tests;
