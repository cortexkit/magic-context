//! The one-time offline move of every project's domain rows from `store.db` into
//! `context.db` (`ck-mc single-store-migrate`).
//!
//! It runs while nothing else has either file open, so it needs none of the holds, chunked
//! transactions or drift checks an online move would. Everything happens in one
//! transaction that spans both files:
//!
//! 1. Both files are backed up, and the backup directory is printed before any write.
//! 2. Both files are switched to rollback-journal mode. SQLite commits a transaction over
//!    ATTACHed databases atomically across all of them only when none is in WAL mode, so
//!    this is what makes the copy, the flags and the cache reset land together or not at
//!    all. WAL mode is restored afterwards, on success and on failure.
//! 3. `store.db` is the main database and `context.db` is attached as `ctx`, so statements
//!    name `context.db` tables as `ctx.<table>` and `store.db` tables as `main.<table>`
//!    or by their `mc_` names.
//! 4. Inside one `BEGIN IMMEDIATE`: the cache tables of store migration 61 are created,
//!    projects are classified and copied, the module cache is reset, the `context.db`
//!    mirror and authority rows are cleared, everything is verified (including a render
//!    check that composes m0 from both sides), and only then are the old tables dropped
//!    and both flags written with one shared stamp.
//!
//! Any refusal or error rolls back both files. `--dry-run` runs everything through the
//! verification and then rolls back.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Instant;

use mc_store::private_permissions::{create_directory, ensure_directory, tighten_tree, write_file};
use mc_store::single_store_schema::{self as schema, DomainTables, CONTEXT_TABLES, LEGACY_TABLES};
use mc_store::{McStoreError, MemoryRenderSnapshot, StoredCompartment, WorkspaceMembership};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::host_store::{self, FenceState, BUILT_CONTEXT_FENCE_VERSION, CONTEXT_BUSY_TIMEOUT_MS};
use crate::m0_compose::{compose_m0_from_store, M0ComposeInputs, M0Source};

// ── Refusal codes ───────────────────────────────────────────────────────────

pub const VERSION_MISMATCH: &str = "single_store_version_mismatch";
pub const PATH_MISMATCH: &str = "single_store_path_mismatch";
pub const STATE_SPLIT: &str = schema::SINGLE_STORE_STATE_SPLIT_REASON;
pub const AUTHORITY_IN_TRANSITION: &str = "single_store_authority_in_transition";
pub const FOREIGN_CONTEXT: &str = "single_store_foreign_context";
pub const UNCLASSIFIED_ROWS: &str = "single_store_unclassified_rows";
pub const DANGLING_REFERENCE: &str = "single_store_dangling_reference";
pub const CLAUDE_CODE_IDS: &str = "single_store_claude_code_ids";
pub const VERIFY_MISMATCH: &str = "single_store_verify_mismatch";
pub const RENDER_MISMATCH: &str = "single_store_render_mismatch";
pub const FINGERPRINT_MISMATCH: &str = "single_store_fingerprint_mismatch";
pub const BACKUP_DIR_EXISTS: &str = "single_store_backup_dir_exists";
pub const HISTORY_DIVERGED: &str = "single_store_history_diverged";

/// The lowest `context.db` version that carries `single_store_state`.
pub const MIN_CONTEXT_VERSION: i64 = 92;

/// The serializer profile whose sessions rendered store ids instead of `context.db` ids.
const CLAUDE_CODE_PROFILE: &str = "claude-code-anthropic";

/// How far back a session counts as recently active for the render check.
const RECENT_ACTIVITY_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// The `context.db` rows the migration clears: the mirror and authority machinery that
/// only existed to keep two copies in step.
const CONTEXT_CLEARED_TABLES: &[&str] = &[
    "authority_managed",
    "authority_repair_pending",
    "authority_capture_bounds",
    "mirror_identity",
    "mirror_cursors",
    "mirror_pending_references",
    "mirror_note_revisions",
    "mirror_live_memory_rows",
    "mirror_live_staging",
    "mirror_resnapshot_state",
    "domain_mutation_epoch",
];

/// The `context.db` tables the engine writes. Each must still be the schema this build
/// was compiled against.
const WRITTEN_CONTEXT_TABLES: &[&str] = &[
    // Host triggers maintain compartment_history_versions during copies/replacements.
    // These revisions belong to canonical context.db rows, not store.db cache mirrors.
    "compartment_history_versions",
    "memories",
    "notes",
    "compartments",
    "compartment_events",
    "primer_candidates",
    "user_memory_candidates",
    "memory_embedding_watermarks",
];

// ── Options, refusal, report ────────────────────────────────────────────────

/// Which file's copy wins for a project whose memories and notes both exist in both files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Winner {
    Store,
    Context,
}

impl Winner {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "store" => Some(Winner::Store),
            "context" => Some(Winner::Context),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct EngineOptions {
    pub context_db: PathBuf,
    pub store_db: PathBuf,
    /// The exact directory this run's backup is written to. The caller chooses it so it
    /// can print it before anything is written; it must not exist yet.
    pub backup_dir: PathBuf,
    pub dry_run: bool,
    pub skip_foreign: bool,
    pub prefer: BTreeMap<String, Winner>,
    /// Which copy of a session's history to keep when the evidence cannot decide it.
    pub prefer_history: BTreeMap<String, Winner>,
    pub accept_id_change: bool,
    pub build: String,
    pub now_ms: i64,
    /// Seed for picking the render check's sample beyond the recently active sessions.
    pub render_seed: u64,
    /// How many sessions beyond the recently active ones the render check samples.
    pub render_extra: usize,
    /// Refuse when `context_db` is not the file the module itself resolves. The command
    /// line sets it; tests that place files in a temporary directory turn it off.
    pub check_context_path: bool,
}

impl EngineOptions {
    pub fn new(context_db: PathBuf, store_db: PathBuf, backup_dir: PathBuf) -> Self {
        let now_ms = now_ms();
        EngineOptions {
            context_db,
            store_db,
            backup_dir,
            dry_run: false,
            skip_foreign: false,
            prefer: BTreeMap::new(),
            prefer_history: BTreeMap::new(),
            accept_id_change: false,
            build: schema::build_identity(),
            now_ms,
            render_seed: now_ms as u64,
            render_extra: 100,
            check_context_path: true,
        }
    }
}

/// Why the run stopped without migrating. Nothing was written to either file.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub code: String,
    pub message: String,
    pub detail: Value,
}

impl Refusal {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Refusal {
            code: code.to_string(),
            message: message.into(),
            detail: Value::Null,
        }
    }

    pub(crate) fn with_detail(mut self, detail: Value) -> Self {
        self.detail = detail;
        self
    }

    pub fn to_value(&self) -> Value {
        let mut value = json!({"code": self.code, "message": self.message});
        if let Value::Object(extra) = &self.detail {
            for (key, entry) in extra {
                value[key] = entry.clone();
            }
        }
        value
    }
}

#[derive(Debug)]
pub enum EngineError {
    Refused(Refusal),
    Internal(String),
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::Refused(refusal) => {
                write!(formatter, "{}: {}", refusal.code, refusal.message)
            }
            EngineError::Internal(message) => write!(formatter, "internal error: {message}"),
        }
    }
}

impl From<Refusal> for EngineError {
    fn from(refusal: Refusal) -> Self {
        EngineError::Refused(refusal)
    }
}

impl From<rusqlite::Error> for EngineError {
    fn from(error: rusqlite::Error) -> Self {
        EngineError::Internal(error.to_string())
    }
}

impl From<std::io::Error> for EngineError {
    fn from(error: std::io::Error) -> Self {
        EngineError::Internal(error.to_string())
    }
}

impl From<McStoreError> for EngineError {
    fn from(error: McStoreError) -> Self {
        EngineError::Internal(error.to_string())
    }
}

fn refuse<T>(code: &str, message: impl Into<String>) -> Result<T, EngineError> {
    Err(EngineError::Refused(Refusal::new(code, message)))
}

/// Per-table counts for one project.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct TableCounts {
    /// Rows `store.db` held.
    pub source: usize,
    /// Rows inserted into `context.db`.
    pub copied: usize,
    /// `context.db` rows changed to the store's values.
    pub updated: usize,
    /// `context.db` rows left as they were: equal twins, twins where `context.db` wins,
    /// and history rows the store proves are still current.
    pub kept: usize,
    /// `context.db` rows removed: compartments above the store's last sequence, history
    /// rows the store proves superseded, and rows the module had deleted.
    pub deleted: usize,
    /// `context.db` events pointing at a compartment that no longer exists anywhere, left
    /// in place.
    pub orphans_kept: usize,
    /// Store rows not copied because the session's `context.db` history was newer and
    /// replaced the compartments they describe. They stay in the backup.
    pub superseded: usize,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct ProjectReport {
    pub project: String,
    pub winner: Option<Winner>,
    pub skipped: bool,
    pub tables: BTreeMap<String, TableCounts>,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct RenderCheck {
    pub sampled: usize,
    pub passed: usize,
    pub seed: u64,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct StoreBytes {
    pub before: u64,
    pub after: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct Report {
    pub status: String,
    pub backup_dir: Option<String>,
    pub migrated_at: Option<i64>,
    pub migrated_by: Option<String>,
    pub projects: Vec<ProjectReport>,
    pub render_check: RenderCheck,
    /// Every session whose two copies of history differed, with the copy kept and why.
    pub history: Vec<HistoryDecision>,
    pub sessions_reset: usize,
    pub normalized_context_compartments: usize,
    pub store_db_bytes: StoreBytes,
    /// Wall time of the one transaction and of the `VACUUM` after it.
    pub transaction_ms: Option<u64>,
    pub vacuum_ms: Option<u64>,
}

impl Report {
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// Test seam: runs inside the transaction after every row was copied and before
/// verification. Production passes [`NoHooks`].
pub trait EngineHooks {
    fn after_copy(&mut self, _conn: &Connection) -> Result<(), EngineError> {
        Ok(())
    }
}

pub struct NoHooks;
impl EngineHooks for NoHooks {}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

// ── Columns compared and copied ────────────────────────────────────────────

/// Every `memories` column except the id. The two reference columns come last and are
/// written in a second pass, once every copied memory has its `context.db` id.
const MEMORY_COLUMNS: &[&str] = &[
    "project_path",
    "category",
    "content",
    "normalized_hash",
    "importance",
    "scope",
    "shareable",
    "source_session_id",
    "source_type",
    "seen_count",
    "retrieval_count",
    "first_seen_at",
    "created_at",
    "updated_at",
    "last_seen_at",
    "last_retrieved_at",
    "status",
    "expires_at",
    "verification_status",
    "verified_at",
    "classified_at",
    "metadata_json",
    "mural_cue",
    "mural_cue_hash",
    "mural_cue_at",
    "mural_cue_rejection_count",
];
const MEMORY_CONTENT: usize = 2;

/// Every `notes` column except the id.
const NOTE_COLUMNS: &[&str] = &[
    "type",
    "status",
    "content",
    "session_id",
    "project_path",
    "surface_condition",
    "created_at",
    "updated_at",
    "last_checked_at",
    "ready_at",
    "ready_reason",
    "compiled_provider",
    "compiled_config",
    "compiled_at",
    "compile_status",
    "harness",
    "anchor_ordinal",
    "anchor_block_id",
    "compiled_check",
    "manifest_json",
    "check_hash",
    "check_cron",
    "check_version",
    "check_status",
    "check_failure_count",
    "check_network_failure_count",
    "check_quarantined_until",
    "check_next_due_at",
    "check_compiled_at",
    "check_false_since_at",
    "check_last_liveness_at",
    "policy_version",
];

/// Every `compartments` column except the id and the embedding columns.
const COMPARTMENT_COLUMNS: &[&str] = &[
    "session_id",
    "sequence",
    "start_message",
    "end_message",
    "start_message_id",
    "end_message_id",
    "title",
    "content",
    "p1",
    "p2",
    "p3",
    "p4",
    "importance",
    "episode_type",
    "legacy",
    "created_at",
    "harness",
    "rebase_status",
    "start_block_index",
    "end_block_index",
];
/// The fields that say what a compartment is about (title through legacy flag). The
/// message coordinates are left out: the host and the module record the same boundary in
/// different spellings, and that is one compartment written two ways, not a rewrite.
const COMPARTMENT_CONTENT_FIELDS: std::ops::RangeInclusive<usize> = 6..=14;
const COMPARTMENT_P1: usize = 8;
const COMPARTMENT_END_MESSAGE: usize = 3;
const COMPARTMENT_CREATED_AT: usize = 15;

const EVENT_COLUMNS: &[&str] = &[
    "session_id",
    "compartment_id",
    "kind",
    "at_compartment",
    "fields_json",
    "created_at",
    "harness",
];
const EVENT_COMPARTMENT_ID: usize = 1;

const PRIMER_COLUMNS: &[&str] = &[
    "project_path",
    "harness",
    "session_id",
    "question",
    "normalized_question",
    "source_compartment_start",
    "source_compartment_end",
    "source_start_message_id",
    "source_end_message_id",
    "source_message_time",
    "created_at",
];

const CANDIDATE_COLUMNS: &[&str] = &[
    "content",
    "session_id",
    "source_compartment_start",
    "source_compartment_end",
    "created_at",
];

const REPORT_TABLES: &[&str] = &[
    "memories",
    "notes",
    "memory_verifications",
    "primer_candidates",
    "compartments",
    "compartment_events",
    "user_memory_candidates",
];

pub(crate) type Row = BTreeMap<String, SqlValue>;

pub(crate) fn get(row: &Row, name: &str) -> SqlValue {
    row.get(name).cloned().unwrap_or(SqlValue::Null)
}

pub(crate) fn as_i64(value: &SqlValue) -> Option<i64> {
    match value {
        SqlValue::Integer(value) => Some(*value),
        _ => None,
    }
}

pub(crate) fn as_text(value: &SqlValue) -> Option<&str> {
    match value {
        SqlValue::Text(value) => Some(value.as_str()),
        _ => None,
    }
}

fn text(value: &str) -> SqlValue {
    SqlValue::Text(value.to_string())
}

fn row_key(values: &[SqlValue]) -> String {
    format!("{values:?}")
}

fn column_list(columns: &[&str]) -> String {
    columns.join(", ")
}

fn placeholders(count: usize) -> String {
    (1..=count)
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ")
}

pub(crate) fn read_named_rows(
    conn: &Connection,
    sql: &str,
    args: &[SqlValue],
) -> rusqlite::Result<Vec<Row>> {
    let mut statement = conn.prepare(sql)?;
    let names: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_string)
        .collect();
    let rows = statement
        .query_map(params_from_iter(args.iter()), |row| {
            let mut out = Row::new();
            for (index, name) in names.iter().enumerate() {
                out.insert(name.clone(), row.get::<_, SqlValue>(index)?);
            }
            Ok(out)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// `(id, columns)` of every row `sql` selects; `sql` selects `id` followed by them.
fn read_rows(
    conn: &Connection,
    sql: &str,
    args: &[SqlValue],
    width: usize,
) -> rusqlite::Result<Vec<(i64, Vec<SqlValue>)>> {
    let mut statement = conn.prepare(sql)?;
    let rows = statement
        .query_map(params_from_iter(args.iter()), |row| {
            let id: i64 = row.get(0)?;
            let mut values = Vec::with_capacity(width);
            for index in 0..width {
                values.push(row.get::<_, SqlValue>(index + 1)?);
            }
            Ok((id, values))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn read_by_id(
    conn: &Connection,
    table: &str,
    columns: &[&str],
    id: i64,
) -> rusqlite::Result<Option<Vec<SqlValue>>> {
    Ok(read_rows(
        conn,
        &format!(
            "SELECT id, {} FROM {table} WHERE id = ?1",
            column_list(columns)
        ),
        &[SqlValue::Integer(id)],
        columns.len(),
    )?
    .into_iter()
    .next()
    .map(|(_, values)| values))
}

fn insert_row(
    conn: &Connection,
    table: &str,
    columns: &[&str],
    values: &[SqlValue],
) -> rusqlite::Result<i64> {
    conn.execute(
        &format!(
            "INSERT INTO {table} ({}) VALUES ({})",
            column_list(columns),
            placeholders(columns.len())
        ),
        params_from_iter(values.iter()),
    )?;
    Ok(conn.last_insert_rowid())
}

fn update_row(
    conn: &Connection,
    table: &str,
    columns: &[&str],
    values: &[SqlValue],
    id: i64,
) -> rusqlite::Result<()> {
    let assignments = columns
        .iter()
        .enumerate()
        .map(|(index, column)| format!("{column} = ?{}", index + 1))
        .collect::<Vec<_>>()
        .join(", ");
    let mut args = values.to_vec();
    args.push(SqlValue::Integer(id));
    conn.execute(
        &format!(
            "UPDATE {table} SET {assignments} WHERE id = ?{}",
            columns.len() + 1
        ),
        params_from_iter(args.iter()),
    )?;
    Ok(())
}

pub(crate) fn table_exists(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)
             OR EXISTS(SELECT 1 FROM ctx.sqlite_master WHERE type = 'table' AND name = ?1)",
        params![table],
        |row| row.get(0),
    )
}

// ── The source: everything store.db holds ─────────────────────────────────

#[derive(Debug, Default)]
struct Source {
    memories: Vec<Row>,
    notes: Vec<Row>,
    primers: Vec<Row>,
    mappings: Vec<Row>,
    /// Session-keyed rows, by session.
    compartments: BTreeMap<String, Vec<Row>>,
    events: BTreeMap<String, Vec<Row>>,
    candidates: BTreeMap<String, Vec<Row>>,
}

fn group_by_session(rows: Vec<Row>) -> BTreeMap<String, Vec<Row>> {
    let mut grouped: BTreeMap<String, Vec<Row>> = BTreeMap::new();
    for row in rows {
        let session = as_text(&get(&row, "session_id"))
            .unwrap_or_default()
            .to_string();
        grouped.entry(session).or_default().push(row);
    }
    grouped
}

fn read_source(conn: &Connection) -> rusqlite::Result<Source> {
    let optional = |table: &str, order: &str| -> rusqlite::Result<Vec<Row>> {
        if schema::table_exists(conn, "main", table)? {
            read_named_rows(
                conn,
                &format!("SELECT * FROM main.{table} ORDER BY {order}"),
                &[],
            )
        } else {
            Ok(Vec::new())
        }
    };
    Ok(Source {
        memories: optional("mc_memories", "id")?,
        notes: optional("mc_notes", "id")?,
        primers: optional("mc_primer_candidates", "id")?,
        mappings: optional("mc_memory_mappings", "memory_id")?,
        compartments: group_by_session(optional("mc_compartments", "session_id, sequence")?),
        events: group_by_session(optional("mc_compartment_events", "id")?),
        candidates: group_by_session(optional("mc_user_memory_candidates", "id")?),
    })
}

// ── Projects, sessions and who wins ─────────────────────────────────────────

/// What each session is known by: its project and the harness its host runs.
#[derive(Debug, Default)]
struct Sessions {
    project: BTreeMap<String, String>,
    harness: BTreeMap<String, String>,
}

impl Sessions {
    fn read(conn: &Connection) -> rusqlite::Result<Self> {
        let mut sessions = Sessions::default();
        if table_exists(conn, "session_projects")? {
            let mut statement = conn.prepare(
                "SELECT session_id, harness, project_path FROM ctx.session_projects
                  ORDER BY session_id, harness",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            for row in rows {
                let (session, harness, project) = row?;
                sessions.harness.entry(session.clone()).or_insert(harness);
                sessions.project.entry(session).or_insert(project);
            }
        }
        // The store's own record of which project root each session transformed under.
        if schema::table_exists(conn, "main", "mc_transform_session_roots")?
            && schema::table_exists(conn, "main", "mc_authority_route_bindings")?
        {
            let mut statement = conn.prepare(
                "SELECT DISTINCT roots.session_id, binding.project
                   FROM main.mc_transform_session_roots AS roots
                   JOIN main.mc_authority_route_bindings AS binding
                     ON binding.route_project_root = roots.project_root
                  ORDER BY roots.session_id, binding.project",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (session, project) = row?;
                sessions.project.entry(session).or_insert(project);
            }
        }
        // A session's cache state names the serializer it rendered for. Claude Code
        // sessions have no host row, so this is the only place their harness is known.
        let mut statement =
            conn.prepare("SELECT session_id, meta FROM main.mc_cache_state ORDER BY session_id")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (session, meta) = row?;
            let profile = serde_json::from_str::<Value>(&meta).ok().and_then(|meta| {
                meta.get("last_serializer_profile")?
                    .as_str()
                    .map(str::to_string)
            });
            if profile.as_deref() == Some(CLAUDE_CODE_PROFILE) {
                sessions
                    .harness
                    .entry(session)
                    .or_insert_with(|| "claude-code".to_string());
            }
        }
        Ok(sessions)
    }

    /// The harness label `context.db` rows of this session carry. A session no host has
    /// recorded is labelled `opencode`, the `context.db` column default.
    fn harness_of(&self, session: &str) -> String {
        self.harness
            .get(session)
            .cloned()
            .unwrap_or_else(|| "opencode".to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Classification {
    Wins(Winner),
    Skipped,
}

#[derive(Debug, Default)]
struct AuthorityRow {
    uuid: String,
    domain: String,
    state: String,
}

/// Who each project's authority rows say owns its memories and notes.
#[derive(Debug, Default)]
struct Authority {
    rows: BTreeMap<String, Vec<AuthorityRow>>,
    /// Projects `context.db` records as handed over to the module.
    managed: BTreeSet<String>,
}

/// What the authority rows say about one project.
enum Ownership {
    /// Rows exist, but none for this `context.db`.
    Foreign(BTreeSet<String>),
    /// This file's rows name one side for both domains.
    Owned(Winner),
    /// The rows disagree with each other or with `authority_managed`: the project was
    /// being handed over when the migration ran.
    InTransition {
        memories: String,
        notes: String,
        managed: bool,
    },
}

impl Authority {
    fn read(conn: &Connection) -> rusqlite::Result<Self> {
        let mut authority = Authority::default();
        if schema::table_exists(conn, "main", "mc_authority")? {
            let mut statement = conn.prepare(
                "SELECT project, context_store_uuid, domain, state FROM main.mc_authority
                  WHERE domain IN ('memories', 'notes')",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    AuthorityRow {
                        uuid: row.get(1)?,
                        domain: row.get(2)?,
                        state: row.get(3)?,
                    },
                ))
            })?;
            for row in rows {
                let (project, row) = row?;
                authority.rows.entry(project).or_default().push(row);
            }
        }
        if table_exists(conn, "authority_managed")? {
            authority.managed = conn
                .prepare("SELECT project_path FROM ctx.authority_managed")?
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<_, _>>()?;
        }
        Ok(authority)
    }

    /// A project with no authority rows at all was never handed over: TypeScript owns it.
    fn ownership(&self, project: &str, file_uuid: &str) -> Ownership {
        let rows = self
            .rows
            .get(project)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let own: Vec<&AuthorityRow> = rows.iter().filter(|row| row.uuid == file_uuid).collect();
        if own.is_empty() && !rows.is_empty() {
            return Ownership::Foreign(rows.iter().map(|row| row.uuid.clone()).collect());
        }
        let state = |domain: &str| {
            own.iter()
                .find(|row| row.domain == domain)
                .map(|row| row.state.as_str())
                .unwrap_or("TS")
        };
        let (memories, notes) = (state("memories"), state("notes"));
        let managed = self.managed.contains(project);
        match (memories, notes, managed) {
            ("MODULE", "MODULE", true) => Ownership::Owned(Winner::Store),
            ("TS", "TS", false) => Ownership::Owned(Winner::Context),
            _ => Ownership::InTransition {
                memories: memories.to_string(),
                notes: notes.to_string(),
                managed,
            },
        }
    }
}

/// Decide, for every project with store rows, which side's memories and notes win.
/// Returns the decision per project, or the refusal naming every project that could not
/// be decided.
fn classify_projects(
    authority: &Authority,
    projects: &BTreeSet<String>,
    file_uuid: &str,
    options: &EngineOptions,
) -> Result<BTreeMap<String, Classification>, EngineError> {
    let mut decided = BTreeMap::new();
    let mut transition = Vec::new();
    let mut foreign = Vec::new();
    for project in projects {
        if let Some(winner) = options.prefer.get(project) {
            decided.insert(project.clone(), Classification::Wins(*winner));
            continue;
        }
        match authority.ownership(project, file_uuid) {
            Ownership::Foreign(uuids) => {
                if options.skip_foreign {
                    decided.insert(project.clone(), Classification::Skipped);
                } else {
                    foreign.push(json!({"project": project, "context_store_uuids": uuids}));
                }
            }
            Ownership::Owned(winner) => {
                decided.insert(project.clone(), Classification::Wins(winner));
            }
            Ownership::InTransition {
                memories,
                notes,
                managed,
            } => transition.push(json!({
                "project": project,
                "memories": memories,
                "notes": notes,
                "authority_managed": managed,
                "flags": [format!("--prefer {project}=store"), format!("--prefer {project}=context")],
            })),
        }
    }
    if !foreign.is_empty() {
        return Err(Refusal::new(
            FOREIGN_CONTEXT,
            format!(
                "{} project(s) are owned under another context.db ({}); their store rows can only stay in the backup. Re-run with --skip-foreign to leave them behind",
                foreign.len(),
                foreign
                    .iter()
                    .filter_map(|entry| entry["project"].as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )
        .with_detail(json!({"projects": foreign, "flag": "--skip-foreign"}))
        .into());
    }
    if !transition.is_empty() {
        return Err(Refusal::new(
            AUTHORITY_IN_TRANSITION,
            format!(
                "the owner of {} cannot be decided from its authority rows; choose with --prefer <project>=store or --prefer <project>=context",
                transition
                    .iter()
                    .filter_map(|entry| entry["project"].as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )
        .with_detail(json!({"projects": transition}))
        .into());
    }
    Ok(decided)
}

// ── Copying ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Twin {
    /// `mirror_identity` names the context row.
    Identity(i64),
    /// Found through the seeded context id or the natural key.
    Found(i64),
    Missing,
}

impl Twin {
    fn id(self) -> Option<i64> {
        match self {
            Twin::Identity(id) | Twin::Found(id) => Some(id),
            Twin::Missing => None,
        }
    }
}

/// A memory whose reference columns the second pass writes.
struct PendingReferences {
    project: String,
    context_id: i64,
    superseded_store: SqlValue,
    merged_from_store: SqlValue,
    /// The store row was seeded from a `context.db` row and paired with a twin. Seeding
    /// copied `merged_from` verbatim, so such a row's list already holds `context.db` ids
    /// when it still equals its twin's.
    seeded_twin: bool,
}

struct Copier<'a> {
    conn: &'a Connection,
    file_uuid: String,
    sessions: &'a Sessions,
    has_identity: bool,
    /// Store memory id → `context.db` memory id, for every memory this run placed.
    memory_ids: HashMap<i64, i64>,
    /// Context rows already paired with a store row in this run, per domain.
    claimed: HashSet<(&'static str, i64)>,
    pending_references: Vec<PendingReferences>,
    /// Memories whose rows this run wrote, by context id: the reference checks cover them.
    written_memories: BTreeSet<i64>,
    /// Projects whose `context.db` rows this run changed; their memory epoch is bumped.
    changed_projects: BTreeSet<String>,
    highest_inserted: BTreeMap<String, i64>,
    reports: BTreeMap<String, ProjectReport>,
    dangling: Vec<String>,
    /// Every memory id `store.db` holds, in any project.
    store_memory_ids: HashSet<i64>,
    /// Mappings whose memory no longer exists in `store.db`; not copied.
    orphan_mappings: usize,
    authority: &'a Authority,
    prefer: &'a BTreeMap<String, Winner>,
    prefer_history: &'a BTreeMap<String, Winner>,
    /// Sessions whose two copies of history differed, and which copy was kept.
    history: Vec<HistoryDecision>,
    /// The compartments of each session whose `context.db` history was kept, as they
    /// were before the copy; verification checks they are still exactly that.
    context_kept: BTreeMap<String, Vec<Vec<SqlValue>>>,
}

impl<'a> Copier<'a> {
    fn counts(&mut self, project: &str, table: &str) -> &mut TableCounts {
        self.reports
            .entry(project.to_string())
            .or_insert_with(|| ProjectReport {
                project: project.to_string(),
                tables: REPORT_TABLES
                    .iter()
                    .map(|table| (table.to_string(), TableCounts::default()))
                    .collect(),
                ..ProjectReport::default()
            })
            .tables
            .entry(table.to_string())
            .or_default()
    }

    fn identity_row(
        &self,
        domain: &str,
        project: &str,
        store_id: i64,
    ) -> rusqlite::Result<Option<i64>> {
        if !self.has_identity {
            return Ok(None);
        }
        self.conn
            .query_row(
                "SELECT context_row_id FROM ctx.mirror_identity
                  WHERE domain = ?1 AND module_project = ?2 AND module_row_id = ?3",
                params![domain, project, store_id],
                |row| row.get(0),
            )
            .optional()
    }

    /// Whether context row `id` is still free to pair with a store row: no identity row
    /// claims it and no earlier row of this run took it. The store can hold two rows that
    /// read the same, and each needs its own twin.
    fn unclaimed(&self, domain: &'static str, id: i64) -> rusqlite::Result<bool> {
        if self.claimed.contains(&(domain, id)) {
            return Ok(false);
        }
        if !self.has_identity {
            return Ok(true);
        }
        self.conn.query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM ctx.mirror_identity WHERE domain = ?1 AND context_row_id = ?2)",
            params![domain, id],
            |row| row.get(0),
        )
    }

    /// Find a store memory's `context.db` twin the way the mirror paired them: identity
    /// row, then the context id it was seeded from (same file only), then a unique match
    /// on the natural key.
    fn resolve_memory(&self, project: &str, row: &Row) -> Result<Twin, EngineError> {
        let store_id = as_i64(&get(row, "id")).unwrap_or_default();
        if let Some(context_id) = self.identity_row("memories", project, store_id)? {
            let owner: Option<String> = self
                .conn
                .query_row(
                    "SELECT project_path FROM ctx.memories WHERE id = ?1",
                    params![context_id],
                    |row| row.get(0),
                )
                .optional()?;
            match owner {
                Some(owner) if owner == project => return Ok(Twin::Identity(context_id)),
                Some(owner) => {
                    return refuse(
                        VERIFY_MISMATCH,
                        format!("store memory {store_id} of {project} is mapped to context memory {context_id}, which belongs to {owner}"),
                    )
                }
                None => {}
            }
        }
        if as_text(&get(row, "context_store_uuid")) == Some(self.file_uuid.as_str()) {
            if let Some(seeded) = as_i64(&get(row, "context_row_id")).filter(|id| *id > 0) {
                let found: Option<i64> = self
                    .conn
                    .query_row(
                        "SELECT id FROM ctx.memories WHERE id = ?1 AND project_path = ?2",
                        params![seeded, project],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(id) = found {
                    if self.unclaimed("memories", id)? {
                        return Ok(Twin::Found(id));
                    }
                }
            }
        }
        let hash = get(row, "normalized_hash");
        if as_text(&hash).is_some_and(|hash| !hash.is_empty()) {
            let candidates: Vec<i64> = self
                .conn
                .prepare(
                    "SELECT id FROM ctx.memories
                      WHERE project_path = ?1 AND category = ?2 AND normalized_hash = ?3 ORDER BY id",
                )?
                .query_map(params![project, get(row, "category"), hash], |row| row.get(0))?
                .collect::<Result<_, _>>()?;
            if let [only] = candidates.as_slice() {
                if self.unclaimed("memories", *only)? {
                    return Ok(Twin::Found(*only));
                }
            }
        }
        Ok(Twin::Missing)
    }

    fn copy_memories(
        &mut self,
        project: &str,
        winner: Winner,
        rows: &[&Row],
    ) -> Result<(), EngineError> {
        let mut twins = BTreeSet::new();
        for row in rows {
            let store_id = as_i64(&get(row, "id")).unwrap_or_default();
            let desired: Vec<SqlValue> = MEMORY_COLUMNS
                .iter()
                .map(|column| get(row, column))
                .collect();
            self.counts(project, "memories").source += 1;
            let twin = self.resolve_memory(project, row)?;
            let context_id = match twin.id() {
                Some(id) => {
                    twins.insert(id);
                    let current = read_by_id(self.conn, "ctx.memories", MEMORY_COLUMNS, id)?;
                    if winner == Winner::Store && current.as_ref() != Some(&desired) {
                        update_row(self.conn, "ctx.memories", MEMORY_COLUMNS, &desired, id)?;
                        if current.as_ref().map(|values| &values[MEMORY_CONTENT])
                            != Some(&desired[MEMORY_CONTENT])
                        {
                            // The vector describes the old text; the host re-embeds a
                            // memory that has none.
                            self.conn.execute(
                                "DELETE FROM ctx.memory_embeddings WHERE memory_id = ?1",
                                params![id],
                            )?;
                        }
                        self.counts(project, "memories").updated += 1;
                        self.changed_projects.insert(project.to_string());
                    } else {
                        self.counts(project, "memories").kept += 1;
                    }
                    id
                }
                None => {
                    let id = insert_row(self.conn, "ctx.memories", MEMORY_COLUMNS, &desired)?;
                    self.counts(project, "memories").copied += 1;
                    self.changed_projects.insert(project.to_string());
                    let highest = self
                        .highest_inserted
                        .entry(project.to_string())
                        .or_default();
                    *highest = (*highest).max(id);
                    id
                }
            };
            twins.insert(context_id);
            self.claimed.insert(("memories", context_id));
            self.memory_ids.insert(store_id, context_id);
            if winner == Winner::Store || twin == Twin::Missing {
                self.written_memories.insert(context_id);
                self.pending_references.push(PendingReferences {
                    project: project.to_string(),
                    context_id,
                    superseded_store: get(row, "superseded_by_memory_id"),
                    merged_from_store: get(row, "merged_from"),
                    seeded_twin: twin != Twin::Missing
                        && as_i64(&get(row, "context_row_id")).is_some(),
                });
            }
        }
        if winner == Winner::Store {
            self.remove_context_only(project, "memories", &twins, &rows_ids(rows))?;
        }
        Ok(())
    }

    /// In a project the store wins, a `context.db` row with no store twin is either a row
    /// the module deleted before the mirror applied the deletion (its identity row names a
    /// store row that no longer exists), which is deleted here, or something nobody can
    /// account for, which refuses the run.
    fn remove_context_only(
        &mut self,
        project: &str,
        domain: &'static str,
        twins: &BTreeSet<i64>,
        store_ids: &BTreeSet<i64>,
    ) -> Result<(), EngineError> {
        let scoped = self.scoped_ids(project, domain)?;
        for id in scoped.into_iter().filter(|id| !twins.contains(id)) {
            let identity: Option<i64> = if self.has_identity {
                self.conn
                    .query_row(
                        "SELECT module_row_id FROM ctx.mirror_identity WHERE domain = ?1 AND context_row_id = ?2",
                        params![domain, id],
                        |row| row.get(0),
                    )
                    .optional()?
            } else {
                None
            };
            match identity {
                Some(module_id) if !store_ids.contains(&module_id) => {
                    self.conn
                        .execute(&format!("DELETE FROM ctx.{domain} WHERE id = ?1"), params![id])?;
                    self.counts(project, domain).deleted += 1;
                    self.changed_projects.insert(project.to_string());
                }
                _ => {
                    return refuse(
                        VERIFY_MISMATCH,
                        format!("context.db {domain} row {id} of {project} has no store.db source, and store.db owns the project"),
                    )
                }
            }
        }
        Ok(())
    }

    /// The context rows of a domain that belong to `project`: its own rows, and for notes
    /// also the project-less notes of its sessions.
    fn scoped_ids(&self, project: &str, domain: &str) -> rusqlite::Result<Vec<i64>> {
        let mut ids: Vec<i64> = self
            .conn
            .prepare(&format!(
                "SELECT id FROM ctx.{domain} WHERE project_path = ?1 ORDER BY id"
            ))?
            .query_map(params![project], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        if domain == "notes" {
            let mut statement = self.conn.prepare(
                "SELECT id FROM ctx.notes WHERE project_path IS NULL AND session_id = ?1",
            )?;
            for session in self.project_sessions(project) {
                for id in statement.query_map(params![session], |row| row.get::<_, i64>(0))? {
                    ids.push(id?);
                }
            }
        }
        Ok(ids)
    }

    fn project_sessions(&self, project: &str) -> Vec<String> {
        self.sessions
            .project
            .iter()
            .filter(|(_, owner)| owner.as_str() == project)
            .map(|(session, _)| session.clone())
            .collect()
    }

    /// The `context.db` memory id a store memory id refers to, for a reference column.
    fn remap(&mut self, project: &str, store_id: i64, what: &str) -> rusqlite::Result<Option<i64>> {
        if let Some(id) = self.memory_ids.get(&store_id) {
            return Ok(Some(*id));
        }
        if let Some(id) = self.identity_row("memories", project, store_id)? {
            let exists: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM ctx.memories WHERE id = ?1)",
                params![id],
                |row| row.get(0),
            )?;
            if exists {
                return Ok(Some(id));
            }
        }
        self.dangling.push(format!(
            "{what} of {project} names store memory {store_id}, which exists in neither file"
        ));
        Ok(None)
    }

    /// Second pass: write `superseded_by_memory_id` and `merged_from` in `context.db` ids,
    /// now that every copied memory has one.
    fn write_references(&mut self) -> Result<(), EngineError> {
        for pending in std::mem::take(&mut self.pending_references) {
            let superseded = match as_i64(&pending.superseded_store) {
                Some(store_id) => self
                    .remap(&pending.project, store_id, "superseded_by_memory_id")?
                    .map_or(SqlValue::Null, SqlValue::Integer),
                None => SqlValue::Null,
            };
            let current: (SqlValue, SqlValue) = self.conn.query_row(
                "SELECT superseded_by_memory_id, merged_from FROM ctx.memories WHERE id = ?1",
                params![pending.context_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let merged_from = if pending.seeded_twin && current.1 == pending.merged_from_store {
                pending.merged_from_store.clone()
            } else {
                match as_text(&pending.merged_from_store) {
                    Some(raw) => SqlValue::Text(self.remap_merged_from(&pending.project, raw)?),
                    None => pending.merged_from_store.clone(),
                }
            };
            if current != (superseded.clone(), merged_from.clone()) {
                self.conn.execute(
                    "UPDATE ctx.memories SET superseded_by_memory_id = ?1, merged_from = ?2 WHERE id = ?3",
                    params![superseded, merged_from, pending.context_id],
                )?;
            }
        }
        if !self.dangling.is_empty() {
            return Err(Refusal::new(
                DANGLING_REFERENCE,
                format!(
                    "{} reference(s) cannot be resolved; first: {}",
                    self.dangling.len(),
                    self.dangling[0]
                ),
            )
            .with_detail(json!({"references": self.dangling.iter().take(20).collect::<Vec<_>>()}))
            .into());
        }
        Ok(())
    }

    /// `merged_from` holds a JSON array of the memory ids merged into this one.
    fn remap_merged_from(&mut self, project: &str, raw: &str) -> rusqlite::Result<String> {
        let Ok(Value::Array(ids)) = serde_json::from_str::<Value>(raw) else {
            // Not an id list, so there is nothing to translate; it is copied as written.
            return Ok(raw.to_string());
        };
        let mut out = Vec::with_capacity(ids.len());
        for entry in ids {
            let store_id = entry
                .as_i64()
                .or_else(|| entry.as_str().and_then(|value| value.parse().ok()));
            match store_id {
                Some(store_id) => match self.remap(project, store_id, "merged_from")? {
                    Some(id) => out.push(Value::from(id)),
                    None => out.push(entry),
                },
                None => out.push(entry),
            }
        }
        Ok(Value::Array(out).to_string())
    }
}

fn by_project<'r>(rows: &'r [Row], project: &str) -> Vec<&'r Row> {
    rows.iter()
        .filter(|row| as_text(&get(row, "project_path")) == Some(project))
        .collect()
}

fn rows_ids(rows: &[&Row]) -> BTreeSet<i64> {
    rows.iter()
        .filter_map(|row| as_i64(&get(row, "id")))
        .collect()
}

impl<'a> Copier<'a> {
    /// A store note in `context.db`'s column shape. The module-only delivery states
    /// `surfacing` and `surfaced` read as `ready`: the note was due and had not been
    /// dismissed, which is what `ready` means to every other writer.
    fn desired_note(&self, row: &Row) -> Vec<SqlValue> {
        let session = as_text(&get(row, "session_id")).map(str::to_string);
        let harness = session
            .as_deref()
            .and_then(|session| self.sessions.harness.get(session).cloned())
            .unwrap_or_else(|| "opencode".to_string());
        NOTE_COLUMNS
            .iter()
            .map(|column| match *column {
                "status" => match as_text(&get(row, "status")) {
                    Some("surfacing") | Some("surfaced") => text("ready"),
                    _ => get(row, "status"),
                },
                "created_at" => get(row, "created_at_ms"),
                "updated_at" => get(row, "updated_at_ms"),
                "harness" => text(&harness),
                other => get(row, other),
            })
            .collect()
    }

    fn note_in_scope(&self, project: &str, id: i64) -> rusqlite::Result<Option<bool>> {
        let row: Option<(Option<String>, Option<String>)> = self
            .conn
            .query_row(
                "SELECT project_path, session_id FROM ctx.notes WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        Ok(row.map(|(owner, session)| match owner {
            Some(owner) => owner == project,
            None => session.is_some_and(|session| {
                self.sessions.project.get(&session).map(String::as_str) == Some(project)
            }),
        }))
    }

    /// Find a store note's twin: identity row, then the seeded context id (same file,
    /// same type, inside the project), then for a session note a unique match on session,
    /// creation time and content.
    fn resolve_note(
        &self,
        project: &str,
        row: &Row,
        desired: &[SqlValue],
    ) -> Result<Twin, EngineError> {
        let store_id = as_i64(&get(row, "id")).unwrap_or_default();
        if let Some(context_id) = self.identity_row("notes", project, store_id)? {
            match self.note_in_scope(project, context_id)? {
                Some(true) => return Ok(Twin::Identity(context_id)),
                Some(false) => {
                    return refuse(
                        VERIFY_MISMATCH,
                        format!("store note {store_id} of {project} is mapped to context note {context_id}, which is outside the project"),
                    )
                }
                None => {}
            }
        }
        if as_text(&get(row, "context_store_uuid")) == Some(self.file_uuid.as_str()) {
            if let Some(seeded) = as_i64(&get(row, "context_row_id")).filter(|id| *id > 0) {
                let same_type: bool = self.conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM ctx.notes WHERE id = ?1 AND type IS ?2)",
                    params![seeded, desired[0]],
                    |row| row.get(0),
                )?;
                if same_type
                    && self.note_in_scope(project, seeded)? == Some(true)
                    && self.unclaimed("notes", seeded)?
                {
                    return Ok(Twin::Found(seeded));
                }
            }
        }
        if as_text(&desired[3]).is_some() {
            let candidates: Vec<i64> = self
                .conn
                .prepare(
                    "SELECT id FROM ctx.notes
                      WHERE session_id = ?1 AND created_at = ?2 AND content = ?3 AND type IS ?4
                      ORDER BY id",
                )?
                .query_map(
                    params![desired[3], desired[6], desired[2], desired[0]],
                    |row| row.get(0),
                )?
                .collect::<Result<_, _>>()?;
            let mut free = Vec::new();
            for id in candidates {
                if self.note_in_scope(project, id)? == Some(true) && self.unclaimed("notes", id)? {
                    free.push(id);
                }
            }
            if let [only] = free.as_slice() {
                return Ok(Twin::Found(*only));
            }
        }
        Ok(Twin::Missing)
    }

    fn copy_notes(
        &mut self,
        project: &str,
        winner: Winner,
        rows: &[&Row],
    ) -> Result<(), EngineError> {
        let mut twins = BTreeSet::new();
        for row in rows {
            let desired = self.desired_note(row);
            self.counts(project, "notes").source += 1;
            let context_id = match self.resolve_note(project, row, &desired)?.id() {
                Some(id) => {
                    twins.insert(id);
                    let current = read_by_id(self.conn, "ctx.notes", NOTE_COLUMNS, id)?;
                    if winner == Winner::Store && current.as_ref() != Some(&desired) {
                        update_row(self.conn, "ctx.notes", NOTE_COLUMNS, &desired, id)?;
                        self.counts(project, "notes").updated += 1;
                    } else {
                        self.counts(project, "notes").kept += 1;
                    }
                    id
                }
                None => {
                    self.counts(project, "notes").copied += 1;
                    insert_row(self.conn, "ctx.notes", NOTE_COLUMNS, &desired)?
                }
            };
            twins.insert(context_id);
            self.claimed.insert(("notes", context_id));
        }
        if winner == Winner::Store {
            self.remove_context_only(project, "notes", &twins, &rows_ids(rows))?;
        }
        Ok(())
    }

    /// `mc_memory_mappings` keeps one JSON list of files per memory; `context.db` keeps
    /// one `memory_verifications` row per file. A mapped but unverified file carries
    /// `verified_at = 0`. A `null` list marks the memory independent and writes no row.
    fn copy_mappings(
        &mut self,
        project: &str,
        winner: Winner,
        rows: &[&Row],
    ) -> Result<(), EngineError> {
        for row in rows {
            self.counts(project, "memory_verifications").source += 1;
            let Some(store_id) = as_i64(&get(row, "memory_id")) else {
                continue;
            };
            // mc_memory_mappings has no foreign key, so a mapping can outlive its memory.
            // Such a row maps nothing; it stays only in the backup.
            if !self.store_memory_ids.contains(&store_id) {
                self.orphan_mappings += 1;
                continue;
            }
            let Some(context_id) = self.remap(project, store_id, "memory mapping")? else {
                continue;
            };
            // A twin kept from context.db keeps its own mapping when context.db wins.
            if winner == Winner::Context && !self.written_memories.contains(&context_id) {
                self.counts(project, "memory_verifications").kept += 1;
                continue;
            }
            let files: Option<Vec<String>> = as_text(&get(row, "mapped_files_json"))
                .and_then(|raw| serde_json::from_str::<Option<Vec<String>>>(raw).ok())
                .flatten();
            let Some(files) = files else {
                self.counts(project, "memory_verifications").kept += 1;
                continue;
            };
            let origin = as_text(&get(row, "mapping_origin"))
                .unwrap_or("mapper")
                .to_string();
            let mapped_at = get(row, "updated_at");
            let mut changed = false;
            let existing: BTreeSet<String> = self
                .conn
                .prepare("SELECT file_path FROM ctx.memory_verifications WHERE memory_id = ?1")?
                .query_map(params![context_id], |row| row.get(0))?
                .collect::<Result<_, _>>()?;
            for stale in existing.iter().filter(|file| !files.contains(file)) {
                self.conn.execute(
                    "DELETE FROM ctx.memory_verifications WHERE memory_id = ?1 AND file_path = ?2",
                    params![context_id, stale],
                )?;
                changed = true;
            }
            for file in &files {
                let written = self.conn.execute(
                    "INSERT INTO ctx.memory_verifications(memory_id, file_path, verified_at, mapped_at, mapping_origin)
                     VALUES (?1, ?2, 0, ?3, ?4)
                     ON CONFLICT(memory_id, file_path) DO UPDATE SET
                         mapped_at = excluded.mapped_at, mapping_origin = excluded.mapping_origin
                      WHERE memory_verifications.mapped_at IS NOT excluded.mapped_at
                         OR memory_verifications.mapping_origin IS NOT excluded.mapping_origin",
                    params![context_id, file, mapped_at, origin],
                )?;
                changed |= written > 0;
            }
            let counts = self.counts(project, "memory_verifications");
            if !changed {
                counts.kept += 1;
            } else if existing.is_empty() {
                counts.copied += 1;
            } else {
                counts.updated += 1;
            }
        }
        Ok(())
    }

    fn copy_primers(
        &mut self,
        project: &str,
        winner: Winner,
        rows: &[&Row],
    ) -> Result<(), EngineError> {
        for row in rows {
            let session = as_text(&get(row, "session_id"))
                .unwrap_or_default()
                .to_string();
            let harness = self.sessions.harness_of(&session);
            let desired: Vec<SqlValue> = PRIMER_COLUMNS
                .iter()
                .map(|column| match *column {
                    "harness" => text(&harness),
                    other => get(row, other),
                })
                .collect();
            self.counts(project, "primer_candidates").source += 1;
            let existing = read_rows(
                self.conn,
                &format!(
                    "SELECT id, {} FROM ctx.primer_candidates
                      WHERE project_path = ?1 AND harness = ?2 AND session_id = ?3
                        AND source_start_message_id = ?4 AND source_end_message_id = ?5",
                    column_list(PRIMER_COLUMNS)
                ),
                &[
                    desired[0].clone(),
                    desired[1].clone(),
                    desired[2].clone(),
                    desired[7].clone(),
                    desired[8].clone(),
                ],
                PRIMER_COLUMNS.len(),
            )?
            .into_iter()
            .next();
            match existing {
                Some((id, values)) if values != desired && winner == Winner::Store => {
                    update_row(
                        self.conn,
                        "ctx.primer_candidates",
                        PRIMER_COLUMNS,
                        &desired,
                        id,
                    )?;
                    self.counts(project, "primer_candidates").updated += 1;
                }
                Some(_) => self.counts(project, "primer_candidates").kept += 1,
                None => {
                    insert_row(self.conn, "ctx.primer_candidates", PRIMER_COLUMNS, &desired)?;
                    self.counts(project, "primer_candidates").copied += 1;
                }
            }
        }
        Ok(())
    }
}

// ── Session history ─────────────────────────────────────────────────────────

/// The report bucket for sessions no host or route binding attributes to a project.
const UNATTRIBUTED: &str = "(unattributed sessions)";

struct SessionSrc {
    /// Compartments in `context.db` column order, by sequence.
    compartments: Vec<Vec<SqlValue>>,
    events: Vec<(Vec<SqlValue>, Option<i64>)>,
    candidates: Vec<Vec<SqlValue>>,
}

impl SessionSrc {
    fn compartment(&self, sequence: i64) -> Option<&Vec<SqlValue>> {
        self.compartments
            .iter()
            .find(|row| as_i64(&row[1]) == Some(sequence))
    }

    fn max_sequence(&self) -> Option<i64> {
        self.compartments
            .iter()
            .filter_map(|row| as_i64(&row[1]))
            .max()
    }
}

/// What `store.db` says about the context compartment a history row points at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CompartmentFate {
    /// The store still has it, saying the same thing.
    Unchanged,
    /// The store rewrote it, or truncated the session below it.
    Superseded,
    /// Neither can be shown.
    Unknown,
    /// The row points at a compartment id that exists nowhere. Compartment ids are never
    /// reused and the store keys compartments by sequence, so no compartment in either
    /// file is the one it meant: history left behind by an earlier rewrite.
    Orphan,
}

fn compartment_fate(
    session: &SessionSrc,
    context: Option<&Vec<SqlValue>>,
    sequence: i64,
) -> CompartmentFate {
    let Some(max) = session.max_sequence() else {
        return CompartmentFate::Unknown;
    };
    match (session.compartment(sequence), context) {
        (Some(store), Some(context)) => {
            if store[COMPARTMENT_CONTENT_FIELDS] == context[COMPARTMENT_CONTENT_FIELDS] {
                CompartmentFate::Unchanged
            } else {
                CompartmentFate::Superseded
            }
        }
        (None, _) if sequence > max => CompartmentFate::Superseded,
        _ => CompartmentFate::Unknown,
    }
}

fn context_compartment(
    conn: &Connection,
    session: &str,
    sequence: i64,
) -> rusqlite::Result<Option<(i64, Vec<SqlValue>)>> {
    Ok(read_rows(
        conn,
        &format!(
            "SELECT id, {} FROM ctx.compartments WHERE session_id = ?1 AND sequence = ?2",
            column_list(COMPARTMENT_COLUMNS)
        ),
        &[text(session), SqlValue::Integer(sequence)],
        COMPARTMENT_COLUMNS.len(),
    )?
    .into_iter()
    .next())
}

fn session_rows(
    conn: &Connection,
    table: &str,
    columns: &[&str],
    session: &str,
) -> rusqlite::Result<Vec<(i64, Vec<SqlValue>)>> {
    read_rows(
        conn,
        &format!(
            "SELECT id, {} FROM ctx.{table} WHERE session_id = ?1 ORDER BY id",
            column_list(columns)
        ),
        &[text(session)],
        columns.len(),
    )
}

/// Classify a context event with no store twin by the compartment it points at.
fn event_fate(
    conn: &Connection,
    session_id: &str,
    session: &SessionSrc,
    values: &[SqlValue],
) -> rusqlite::Result<CompartmentFate> {
    let Some(compartment_id) = as_i64(&values[EVENT_COMPARTMENT_ID]) else {
        return Ok(CompartmentFate::Unknown);
    };
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT session_id, sequence FROM ctx.compartments WHERE id = ?1",
            params![compartment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((owner, sequence)) = row else {
        return Ok(CompartmentFate::Orphan);
    };
    if owner != session_id {
        return Ok(CompartmentFate::Unknown);
    }
    let context = context_compartment(conn, session_id, sequence)?.map(|(_, values)| values);
    Ok(compartment_fate(session, context.as_ref(), sequence))
}

/// Classify a context user-memory candidate with no store twin by the compartment range
/// it was drawn from: superseded if any was rewritten or truncated away, unchanged only if
/// every one is still the same.
fn candidate_fate(
    conn: &Connection,
    session_id: &str,
    session: &SessionSrc,
    values: &[SqlValue],
) -> rusqlite::Result<CompartmentFate> {
    let (Some(start), Some(end)) = (as_i64(&values[2]), as_i64(&values[3])) else {
        return Ok(CompartmentFate::Unknown);
    };
    if end < start || end - start > 10_000 {
        return Ok(CompartmentFate::Unknown);
    }
    let mut fate = CompartmentFate::Unchanged;
    for sequence in start..=end {
        let context = context_compartment(conn, session_id, sequence)?.map(|(_, values)| values);
        match compartment_fate(session, context.as_ref(), sequence) {
            CompartmentFate::Superseded => return Ok(CompartmentFate::Superseded),
            CompartmentFate::Unknown | CompartmentFate::Orphan => fate = CompartmentFate::Unknown,
            CompartmentFate::Unchanged => {}
        }
    }
    Ok(fate)
}

/// Match desired rows against context rows as multisets. Returns the indexes of desired
/// rows with no context twin and the context rows with no desired twin.
fn match_multiset(
    desired: &[Vec<SqlValue>],
    context: &[(i64, Vec<SqlValue>)],
) -> (Vec<usize>, Vec<(i64, Vec<SqlValue>)>) {
    let mut available: HashMap<String, Vec<usize>> = HashMap::new();
    for (position, (_, values)) in context.iter().enumerate() {
        available.entry(row_key(values)).or_default().push(position);
    }
    let mut used = vec![false; context.len()];
    let mut missing = Vec::new();
    for (index, values) in desired.iter().enumerate() {
        match available.get_mut(&row_key(values)).and_then(Vec::pop) {
            Some(position) => used[position] = true,
            None => missing.push(index),
        }
    }
    let unmatched = context
        .iter()
        .zip(used)
        .filter(|(_, used)| !used)
        .map(|(row, _)| row.clone())
        .collect();
    (missing, unmatched)
}

/// Why the migration kept one copy of a session's history over the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryReason {
    /// Every compartment of the other copy is in this one, unchanged; this one has more.
    Superset,
    /// Both copies changed compartments the other lacks. This copy's changes are the
    /// newer ones and its project was owned by the side that wrote it.
    WroteLast,
    /// Both copies changed compartments at the same time (the store rewrote rows the
    /// mirror had copied with the same timestamps), and the project's owner decides.
    ProjectOwner,
    /// `--prefer-history` named this copy.
    Preferred,
}

/// The report line for one session whose two copies of history differed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct HistoryDecision {
    pub session: String,
    pub project: String,
    pub kept: Winner,
    pub reason: HistoryReason,
    pub store_compartments: usize,
    pub context_compartments: usize,
    pub store_end_message: Option<i64>,
    pub context_end_message: Option<i64>,
}

/// One side's view of a session's history, for deciding which copy was being written.
struct HistorySide {
    rows: usize,
    /// Rows the other copy lacks at the same sequence or holds with different content.
    changed: usize,
    /// The newest `created_at` among those rows.
    newest_change: Option<i64>,
    end_message: Option<i64>,
}

fn history_side(mine: &[Vec<SqlValue>], theirs: &[Vec<SqlValue>]) -> HistorySide {
    let by_sequence: HashMap<Option<i64>, &Vec<SqlValue>> =
        theirs.iter().map(|row| (as_i64(&row[1]), row)).collect();
    let same = |row: &Vec<SqlValue>| {
        by_sequence.get(&as_i64(&row[1])).is_some_and(|other| {
            other[COMPARTMENT_CONTENT_FIELDS] == row[COMPARTMENT_CONTENT_FIELDS]
        })
    };
    let changed: Vec<&Vec<SqlValue>> = mine.iter().filter(|row| !same(row)).collect();
    HistorySide {
        rows: mine.len(),
        changed: changed.len(),
        newest_change: changed
            .iter()
            .filter_map(|row| as_i64(&row[COMPARTMENT_CREATED_AT]))
            .max(),
        end_message: mine
            .iter()
            .filter_map(|row| as_i64(&row[COMPARTMENT_END_MESSAGE]))
            .max(),
    }
}

/// Decide which copy of one session's history the migration keeps: the copy that was
/// being written. A copy that holds every compartment of the other, unchanged, is kept
/// whatever mode its project was in, because keeping it loses nothing; this is what
/// covers both a stalled mirror (the store ahead) and a project that went back to
/// TypeScript (`context.db` ahead). When both copies changed compartments the other
/// lacks, the newer changes win, but only when the project's owner agrees or is
/// unknown; equal timestamps fall back to the owner. Anything else is refused rather
/// than guessed, since the losing copy's history would be gone.
fn decide_history(
    session_id: &str,
    project: &str,
    store: &[Vec<SqlValue>],
    context: &[Vec<SqlValue>],
    owner: Option<Winner>,
    preferred: Option<Winner>,
) -> Result<Option<HistoryDecision>, EngineError> {
    let store_side = history_side(store, context);
    let context_side = history_side(context, store);
    let decision = |kept: Winner, reason: HistoryReason| HistoryDecision {
        session: session_id.to_string(),
        project: project.to_string(),
        kept,
        reason,
        store_compartments: store_side.rows,
        context_compartments: context_side.rows,
        store_end_message: store_side.end_message,
        context_end_message: context_side.end_message,
    };
    if context_side.changed == 0 && store_side.changed == 0 {
        return Ok(None);
    }
    if let Some(kept) = preferred {
        return Ok(Some(decision(kept, HistoryReason::Preferred)));
    }
    if context_side.changed == 0 {
        return Ok(Some(decision(Winner::Store, HistoryReason::Superset)));
    }
    if store_side.changed == 0 {
        return Ok(Some(decision(Winner::Context, HistoryReason::Superset)));
    }
    let wrote_last = match store_side.newest_change.cmp(&context_side.newest_change) {
        std::cmp::Ordering::Greater => Some(Winner::Store),
        std::cmp::Ordering::Less => Some(Winner::Context),
        std::cmp::Ordering::Equal => None,
    };
    let ends_at_least_as_late = |side: Winner| match side {
        Winner::Store => store_side.end_message >= context_side.end_message,
        Winner::Context => context_side.end_message >= store_side.end_message,
    };
    let kept = match (wrote_last, owner) {
        (Some(last), Some(owner)) if last == owner => Some((last, HistoryReason::WroteLast)),
        (Some(last), None) if ends_at_least_as_late(last) => Some((last, HistoryReason::WroteLast)),
        (None, Some(owner)) => Some((owner, HistoryReason::ProjectOwner)),
        _ => None,
    };
    if let Some((kept, reason)) = kept {
        return Ok(Some(decision(kept, reason)));
    }
    let side = |side: &HistorySide| {
        json!({
            "compartments": side.rows,
            "changed": side.changed,
            "newest_change_at": side.newest_change,
            "end_message": side.end_message,
        })
    };
    Err(Refusal::new(
        HISTORY_DIVERGED,
        format!(
            "session {session_id} ({project}) has history in both files that the other lacks, and neither copy is clearly the one being written; keeping either would drop the other's compartments. Choose with --prefer-history {session_id}=store or --prefer-history {session_id}=context"
        ),
    )
    .with_detail(json!({
        "session": session_id,
        "project": project,
        "project_owner": owner,
        "store": side(&store_side),
        "context": side(&context_side),
        "flags": [
            format!("--prefer-history {session_id}=store"),
            format!("--prefer-history {session_id}=context"),
        ],
    }))
    .into())
}

fn unclassified(session: &str, table: &str, id: i64) -> EngineError {
    Refusal::new(
        UNCLASSIFIED_ROWS,
        format!("context.db {table} row {id} of session {session} has no store.db counterpart and cannot be shown to be either current or superseded"),
    )
    .with_detail(json!({"session": session, "table": table, "id": id}))
    .into()
}

impl<'a> Copier<'a> {
    fn session_src(&self, session: &str, source: &Source) -> Result<SessionSrc, EngineError> {
        let harness = self.sessions.harness_of(session);
        let empty = Vec::new();
        Ok(SessionSrc {
            compartments: source
                .compartments
                .get(session)
                .unwrap_or(&empty)
                .iter()
                .map(|row| {
                    let start = get(row, "start_message_id");
                    let end = get(row, "end_message_id");
                    let (start_id, start_block) =
                        mc_store::context_boundaries::canonical_boundary_parts(
                            as_text(&start).unwrap_or(""),
                        )?;
                    let (end_id, end_block) =
                        mc_store::context_boundaries::canonical_boundary_parts(
                            as_text(&end).unwrap_or(""),
                        )?;
                    Ok(COMPARTMENT_COLUMNS
                        .iter()
                        .map(|column| match *column {
                            "harness" => text(&harness),
                            "rebase_status" => text("ok"),
                            "start_message_id" => text(start_id),
                            "end_message_id" => text(end_id),
                            "start_block_index" => {
                                start_block.map(SqlValue::Integer).unwrap_or(SqlValue::Null)
                            }
                            "end_block_index" => {
                                end_block.map(SqlValue::Integer).unwrap_or(SqlValue::Null)
                            }
                            other => get(row, other),
                        })
                        .collect())
                })
                .collect::<Result<Vec<_>, EngineError>>()?,
            events: source
                .events
                .get(session)
                .unwrap_or(&empty)
                .iter()
                .map(|row| {
                    let values = EVENT_COLUMNS
                        .iter()
                        .map(|column| match *column {
                            "harness" => text(&harness),
                            "compartment_id" => SqlValue::Null,
                            other => get(row, other),
                        })
                        .collect();
                    // The store keeps the compartment's sequence here: its compartments
                    // have no row id of their own.
                    (values, as_i64(&get(row, "compartment_id")))
                })
                .collect(),
            candidates: source
                .candidates
                .get(session)
                .unwrap_or(&empty)
                .iter()
                .map(|row| {
                    CANDIDATE_COLUMNS
                        .iter()
                        .map(|column| get(row, column))
                        .collect()
                })
                .collect(),
        })
    }

    fn desired_events(
        &self,
        session_id: &str,
        session: &SessionSrc,
    ) -> rusqlite::Result<Vec<Vec<SqlValue>>> {
        session
            .events
            .iter()
            .map(|(values, sequence)| {
                let mut values = values.clone();
                values[EVENT_COMPARTMENT_ID] = match sequence {
                    Some(sequence) => self
                        .conn
                        .query_row(
                            "SELECT id FROM ctx.compartments WHERE session_id = ?1 AND sequence = ?2",
                            params![session_id, sequence],
                            |row| row.get::<_, i64>(0),
                        )
                        .optional()?
                        .map_or(SqlValue::Null, SqlValue::Integer),
                    None => SqlValue::Null,
                };
                Ok(values)
            })
            .collect()
    }

    /// Copy one session's history. The store wins: its compartments replace the
    /// context's, updated in place so each keeps its id (and its chunk embeddings), and
    /// context rows above the store's last sequence go. Events and candidates are matched
    /// by value; a context row with no store twin is kept or deleted by what the store
    /// says about the compartment it points at, and refuses the run when that is unknown.
    fn copy_session(&mut self, session_id: &str, source: &Source) -> Result<(), EngineError> {
        let project = self
            .sessions
            .project
            .get(session_id)
            .cloned()
            .unwrap_or_else(|| UNATTRIBUTED.to_string());
        let session = self.session_src(session_id, source)?;
        let context_history = self.context_compartments(session_id)?;
        let owner = self.prefer.get(&project).copied().or_else(|| {
            match self.authority.ownership(&project, &self.file_uuid) {
                Ownership::Owned(winner) if project != UNATTRIBUTED => Some(winner),
                _ => None,
            }
        });
        let decision = decide_history(
            session_id,
            &project,
            &session.compartments,
            &context_history,
            owner,
            self.prefer_history.get(session_id).copied(),
        )?;
        let kept = decision.as_ref().map(|decision| decision.kept);
        self.history.extend(decision);
        if kept == Some(Winner::Context) {
            return self.keep_context_history(
                session_id,
                &project,
                source,
                &session,
                context_history,
            );
        }

        // Everything is classified against the compartments as they were before this run.
        let context_candidates = session_rows(
            self.conn,
            "user_memory_candidates",
            CANDIDATE_COLUMNS,
            session_id,
        )?;
        let (missing_candidates, unmatched) =
            match_multiset(&session.candidates, &context_candidates);
        let mut candidate_deletes = Vec::new();
        for (id, values) in &unmatched {
            match candidate_fate(self.conn, session_id, &session, values)? {
                CompartmentFate::Unchanged => {
                    self.counts(&project, "user_memory_candidates").kept += 1
                }
                CompartmentFate::Superseded => candidate_deletes.push(*id),
                CompartmentFate::Unknown | CompartmentFate::Orphan => {
                    return Err(unclassified(session_id, "user_memory_candidates", *id))
                }
            }
        }
        let desired = self.desired_events(session_id, &session)?;
        let context_events =
            session_rows(self.conn, "compartment_events", EVENT_COLUMNS, session_id)?;
        let (_, unmatched) = match_multiset(&desired, &context_events);
        let mut event_deletes = Vec::new();
        for (id, values) in &unmatched {
            match event_fate(self.conn, session_id, &session, values)? {
                CompartmentFate::Unchanged => self.counts(&project, "compartment_events").kept += 1,
                CompartmentFate::Superseded => event_deletes.push(*id),
                // Left in place, neither copied nor deleted, and counted.
                CompartmentFate::Orphan => {
                    self.counts(&project, "compartment_events").orphans_kept += 1
                }
                CompartmentFate::Unknown => {
                    return Err(unclassified(session_id, "compartment_events", *id))
                }
            }
        }

        let counts = self.counts(&project, "user_memory_candidates");
        counts.source += session.candidates.len();
        counts.kept += session.candidates.len() - missing_candidates.len();
        for id in candidate_deletes {
            self.conn.execute(
                "DELETE FROM ctx.user_memory_candidates WHERE id = ?1 AND session_id = ?2",
                params![id, session_id],
            )?;
            self.counts(&project, "user_memory_candidates").deleted += 1;
        }
        for index in missing_candidates {
            insert_row(
                self.conn,
                "ctx.user_memory_candidates",
                CANDIDATE_COLUMNS,
                &session.candidates[index],
            )?;
            self.counts(&project, "user_memory_candidates").copied += 1;
        }
        for id in event_deletes {
            self.conn.execute(
                "DELETE FROM ctx.compartment_events WHERE id = ?1 AND session_id = ?2",
                params![id, session_id],
            )?;
            self.counts(&project, "compartment_events").deleted += 1;
        }

        if let Some(max) = session.max_sequence() {
            let trimmed = self.conn.execute(
                "DELETE FROM ctx.compartments WHERE session_id = ?1 AND sequence > ?2",
                params![session_id, max],
            )?;
            self.counts(&project, "compartments").deleted += trimmed;
        }
        for desired in &session.compartments {
            let sequence = as_i64(&desired[1]).unwrap_or_default();
            self.counts(&project, "compartments").source += 1;
            match context_compartment(self.conn, session_id, sequence)? {
                Some((_, values)) if &values == desired => {
                    self.counts(&project, "compartments").kept += 1;
                }
                Some((id, values)) => {
                    self.update_compartment(id, &values, desired)?;
                    self.counts(&project, "compartments").updated += 1;
                }
                None => {
                    insert_row(self.conn, "ctx.compartments", COMPARTMENT_COLUMNS, desired)?;
                    self.counts(&project, "compartments").copied += 1;
                }
            }
        }

        // Events are compared again now that every compartment has its context id.
        let desired = self.desired_events(session_id, &session)?;
        let context: Vec<Vec<SqlValue>> =
            session_rows(self.conn, "compartment_events", EVENT_COLUMNS, session_id)?
                .into_iter()
                .map(|(_, values)| values)
                .collect();
        let (missing, _) = match_multiset(
            &desired,
            &context
                .into_iter()
                .map(|values| (0, values))
                .collect::<Vec<_>>(),
        );
        let counts = self.counts(&project, "compartment_events");
        counts.source += desired.len();
        counts.kept += desired.len() - missing.len();
        for index in missing {
            insert_row(
                self.conn,
                "ctx.compartment_events",
                EVENT_COLUMNS,
                &desired[index],
            )?;
            self.counts(&project, "compartment_events").copied += 1;
        }

        // The heading dates have no context column; they go to store.db's date cache.
        for row in source.compartments.get(session_id).into_iter().flatten() {
            self.conn.execute(
                "INSERT OR REPLACE INTO main.mc_compartment_dates(
                     session_id, sequence, start_message_id, end_message_id, start_date, end_date
                 ) VALUES (?1, ?2, COALESCE(?3, ''), COALESCE(?4, ''), ?5, ?6)",
                params![
                    session_id,
                    get(row, "sequence"),
                    get(row, "start_message_id"),
                    get(row, "end_message_id"),
                    get(row, "start_date"),
                    get(row, "end_date"),
                ],
            )?;
        }
        Ok(())
    }

    /// Every compartment of a session in `context.db`, in column order, by sequence.
    fn context_compartments(&self, session_id: &str) -> rusqlite::Result<Vec<Vec<SqlValue>>> {
        Ok(read_rows(
            self.conn,
            &format!(
                "SELECT id, {} FROM ctx.compartments WHERE session_id = ?1 ORDER BY sequence",
                column_list(COMPARTMENT_COLUMNS)
            ),
            &[text(session_id)],
            COMPARTMENT_COLUMNS.len(),
        )?
        .into_iter()
        .map(|(_, values)| values)
        .collect())
    }

    /// Keep a session's `context.db` history because it was the copy being written. No
    /// context row is changed or deleted. A store event or candidate is added only where it
    /// describes compartments both copies hold unchanged and the context lacks it; the rest
    /// describe compartments the context rewrote and are left in the backup.
    fn keep_context_history(
        &mut self,
        session_id: &str,
        project: &str,
        source: &Source,
        session: &SessionSrc,
        context_history: Vec<Vec<SqlValue>>,
    ) -> Result<(), EngineError> {
        let unchanged: BTreeSet<i64> = context_history
            .iter()
            .filter(|row| {
                as_i64(&row[1])
                    .and_then(|sequence| session.compartment(sequence))
                    .is_some_and(|store| {
                        store[COMPARTMENT_CONTENT_FIELDS] == row[COMPARTMENT_CONTENT_FIELDS]
                    })
            })
            .filter_map(|row| as_i64(&row[1]))
            .collect();
        let counts = self.counts(project, "compartments");
        counts.source += session.compartments.len();
        counts.kept += unchanged.len();
        counts.superseded += session.compartments.len() - unchanged.len();

        let context_events: Vec<(i64, Vec<SqlValue>)> =
            session_rows(self.conn, "compartment_events", EVENT_COLUMNS, session_id)?;
        let desired = self.desired_events(session_id, session)?;
        let (eligible, superseded): (Vec<usize>, Vec<usize>) =
            (0..desired.len()).partition(|index| match session.events[*index].1 {
                Some(sequence) => unchanged.contains(&sequence),
                None => true,
            });
        let wanted: Vec<Vec<SqlValue>> = eligible
            .iter()
            .map(|index| desired[*index].clone())
            .collect();
        let (missing, _) = match_multiset(&wanted, &context_events);
        let counts = self.counts(project, "compartment_events");
        counts.source += desired.len();
        counts.kept += wanted.len() - missing.len();
        counts.superseded += superseded.len();
        for index in missing {
            insert_row(
                self.conn,
                "ctx.compartment_events",
                EVENT_COLUMNS,
                &wanted[index],
            )?;
            self.counts(project, "compartment_events").copied += 1;
        }

        let context_candidates = session_rows(
            self.conn,
            "user_memory_candidates",
            CANDIDATE_COLUMNS,
            session_id,
        )?;
        let (eligible, superseded): (Vec<&Vec<SqlValue>>, Vec<&Vec<SqlValue>>) = session
            .candidates
            .iter()
            .partition(|values| match (as_i64(&values[2]), as_i64(&values[3])) {
                (Some(start), Some(end)) if start <= end && end - start <= 10_000 => {
                    (start..=end).all(|sequence| unchanged.contains(&sequence))
                }
                _ => false,
            });
        let wanted: Vec<Vec<SqlValue>> = eligible.into_iter().cloned().collect();
        let (missing, _) = match_multiset(&wanted, &context_candidates);
        let counts = self.counts(project, "user_memory_candidates");
        counts.source += session.candidates.len();
        counts.kept += wanted.len() - missing.len();
        counts.superseded += superseded.len();
        for index in missing {
            insert_row(
                self.conn,
                "ctx.user_memory_candidates",
                CANDIDATE_COLUMNS,
                &wanted[index],
            )?;
            self.counts(project, "user_memory_candidates").copied += 1;
        }

        // Only the heading dates of compartments both copies agree on are known to fit.
        for row in source.compartments.get(session_id).into_iter().flatten() {
            if !as_i64(&get(row, "sequence")).is_some_and(|sequence| unchanged.contains(&sequence))
            {
                continue;
            }
            self.conn.execute(
                "INSERT OR REPLACE INTO main.mc_compartment_dates(
                     session_id, sequence, start_message_id, end_message_id, start_date, end_date
                 ) VALUES (?1, ?2, COALESCE(?3, ''), COALESCE(?4, ''), ?5, ?6)",
                params![
                    session_id,
                    get(row, "sequence"),
                    get(row, "start_message_id"),
                    get(row, "end_message_id"),
                    get(row, "start_date"),
                    get(row, "end_date"),
                ],
            )?;
        }
        self.context_kept
            .insert(session_id.to_string(), context_history);
        Ok(())
    }

    /// Rewrite a compartment in place. Its id stays, so chunk embeddings that point at it
    /// survive; only the P1 embedding, which describes the old text, is cleared when P1
    /// changed so the host re-embeds it.
    fn update_compartment(
        &self,
        id: i64,
        current: &[SqlValue],
        desired: &[SqlValue],
    ) -> rusqlite::Result<()> {
        update_row(
            self.conn,
            "ctx.compartments",
            COMPARTMENT_COLUMNS,
            desired,
            id,
        )?;
        if current[COMPARTMENT_P1] != desired[COMPARTMENT_P1] {
            self.conn.execute(
                "UPDATE ctx.compartments SET p1_embedding = NULL, p1_embedding_model_id = NULL WHERE id = ?1",
                params![id],
            )?;
        }
        Ok(())
    }
}

// ── Render check ────────────────────────────────────────────────────────────

/// m0's inputs read from the old `store.db` tables of the engine's connection.
struct LegacySource<'a>(&'a Connection);

/// m0's inputs read from `context.db` and the compartment-date cache, exactly as the
/// module reads them after the migration.
struct ContextSource<'a>(&'a Connection);

fn store_error(error: rusqlite::Error) -> McStoreError {
    McStoreError::Store(cortexkit_store::StoreError::Backend(error.to_string()))
}

fn source_reads(
    conn: &Connection,
    tables: &DomainTables,
    project_path: &str,
    membership: Option<&WorkspaceMembership>,
    now_ms: i64,
) -> Result<MemoryRenderSnapshot, McStoreError> {
    schema::read_memory_render_snapshot(conn, tables, project_path, membership, now_ms)
        .map_err(store_error)
}

impl M0Source for LegacySource<'_> {
    fn load_compartments(&self, session_id: &str) -> Result<Vec<StoredCompartment>, McStoreError> {
        schema::read_legacy_compartments(self.0, session_id).map_err(store_error)
    }
    fn resolve_workspace_membership(
        &self,
        project: &str,
    ) -> Result<Option<WorkspaceMembership>, McStoreError> {
        schema::read_workspace_membership(self.0, &LEGACY_TABLES, project).map_err(store_error)
    }
    fn load_memory_render_snapshot(
        &self,
        project: &str,
        membership: Option<&WorkspaceMembership>,
        now_ms: i64,
    ) -> Result<MemoryRenderSnapshot, McStoreError> {
        source_reads(self.0, &LEGACY_TABLES, project, membership, now_ms)
    }
    fn load_active_user_memories(&self) -> Result<Vec<String>, McStoreError> {
        schema::read_active_user_memories(self.0, &LEGACY_TABLES).map_err(store_error)
    }
}

impl M0Source for ContextSource<'_> {
    fn load_compartments(&self, session_id: &str) -> Result<Vec<StoredCompartment>, McStoreError> {
        let mut compartments =
            schema::read_context_compartments(self.0, session_id).map_err(store_error)?;
        schema::apply_compartment_dates(self.0, session_id, &mut compartments)
            .map_err(store_error)?;
        Ok(compartments)
    }
    fn resolve_workspace_membership(
        &self,
        project: &str,
    ) -> Result<Option<WorkspaceMembership>, McStoreError> {
        schema::read_workspace_membership(self.0, &CONTEXT_TABLES, project).map_err(store_error)
    }
    fn load_memory_render_snapshot(
        &self,
        project: &str,
        membership: Option<&WorkspaceMembership>,
        now_ms: i64,
    ) -> Result<MemoryRenderSnapshot, McStoreError> {
        source_reads(self.0, &CONTEXT_TABLES, project, membership, now_ms)
    }
    fn load_active_user_memories(&self) -> Result<Vec<String>, McStoreError> {
        schema::read_active_user_memories(self.0, &CONTEXT_TABLES).map_err(store_error)
    }
}

/// Split an m0 render into its session-history block and the rest.
fn split_history(m0: &str) -> (String, String) {
    const OPEN: &str = "<session-history>";
    const CLOSE: &str = "</session-history>";
    match (m0.find(OPEN), m0.find(CLOSE)) {
        (Some(start), Some(end)) if end >= start => (
            m0[start..end + CLOSE.len()].to_string(),
            format!("{}{}", &m0[..start], &m0[end + CLOSE.len()..]),
        ),
        _ => (String::new(), m0.to_string()),
    }
}

/// The memory lines of a render as a multiset of `(enclosing tags, line with its id token
/// masked)`. A memory line starts with `#<id>` or `-` (id 0); continuation lines of a
/// multi-line memory are folded into it.
fn memory_multiset(rest: &str) -> BTreeMap<String, usize> {
    fn id_token_len(line: &str) -> Option<usize> {
        let digits = line.strip_prefix('#')?;
        let count = digits.bytes().take_while(u8::is_ascii_digit).count();
        (count > 0).then_some(count + 1)
    }
    let mut stack: Vec<String> = Vec::new();
    let mut entries: Vec<String> = Vec::new();
    for line in rest.lines() {
        if let Some(name) = line
            .strip_prefix("</")
            .and_then(|rest| rest.strip_suffix('>'))
        {
            if stack.last().map(String::as_str) == Some(name) {
                stack.pop();
            }
            continue;
        }
        if line.starts_with('<') && line.ends_with('>') && !line.contains(' ') {
            stack.push(line[1..line.len() - 1].to_string());
            continue;
        }
        if line.starts_with("  ") {
            if let Some(last) = entries.last_mut() {
                last.push('\n');
                last.push_str(line);
                continue;
            }
        }
        let masked = match id_token_len(line) {
            Some(len) => format!("#{}", &line[len..]),
            None if line.starts_with("- ") || line.starts_with("-:") => format!("#{}", &line[1..]),
            None => line.to_string(),
        };
        entries.push(format!("{}|{masked}", stack.join("/")));
    }
    let mut multiset = BTreeMap::new();
    for entry in entries {
        *multiset.entry(entry).or_insert(0) += 1;
    }
    multiset
}

/// Compare an m0 composed from the old rows with one composed from `context.db`.
///
/// The session history must be byte for byte the same, date segments included. The
/// memory lines must be the same multiset per category once their id tokens are masked:
/// ids changed (store ids, or 0 for unacknowledged rows, before; `context.db` ids after),
/// and the renderer orders lines inside a category by id, so their order may change too.
/// Returns the first differing line when they disagree.
pub fn compare_renders(before: &str, after: &str) -> Result<(), String> {
    let (before_history, before_rest) = split_history(before);
    let (after_history, after_rest) = split_history(after);
    if before_history != after_history {
        let mut before_lines = before_history.lines();
        let mut after_lines = after_history.lines();
        loop {
            match (before_lines.next(), after_lines.next()) {
                (Some(left), Some(right)) if left == right => continue,
                (left, right) => {
                    return Err(format!(
                        "session history differs: before {:?}, after {:?}",
                        left.unwrap_or("<end>"),
                        right.unwrap_or("<end>")
                    ))
                }
            }
        }
    }
    let before_memories = memory_multiset(&before_rest);
    let after_memories = memory_multiset(&after_rest);
    if before_memories != after_memories {
        let missing = before_memories
            .iter()
            .find(|(line, count)| after_memories.get(*line) != Some(count))
            .map(|(line, _)| format!("before has {line:?}"));
        let extra = after_memories
            .iter()
            .find(|(line, count)| before_memories.get(*line) != Some(count))
            .map(|(line, _)| format!("after has {line:?}"));
        return Err(format!(
            "memory block differs: {}",
            missing.or(extra).unwrap_or_default()
        ));
    }
    Ok(())
}

/// A small deterministic generator for the render-check sample, so the report's seed
/// reproduces the same sample.
fn next_random(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}

struct SampleSession {
    session_id: String,
    expiry_cutoff_ms: i64,
    memory_disabled: bool,
}

fn render_check(
    conn: &Connection,
    sessions: &Sessions,
    skipped_sessions: &BTreeSet<String>,
    store_wins: &BTreeSet<String>,
    options: &EngineOptions,
) -> Result<RenderCheck, EngineError> {
    let mut recent = Vec::new();
    let mut others = Vec::new();
    {
        let mut statement = conn.prepare(
            "SELECT session_id, meta, last_activity_at FROM main.mc_cache_state ORDER BY session_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        for row in rows {
            let (session_id, meta, last_activity_at) = row?;
            // The history of a session left behind with a skipped project was not moved,
            // so there is nothing to compare.
            let skipped = skipped_sessions.contains(&session_id);
            if skipped {
                continue;
            }
            let meta: Value = serde_json::from_str(&meta).unwrap_or(Value::Null);
            let sample = SampleSession {
                session_id,
                expiry_cutoff_ms: meta["expiry_cutoff_ms"]
                    .as_i64()
                    .filter(|value| *value > 0)
                    .unwrap_or(options.now_ms),
                memory_disabled: meta["memory_disabled"].as_bool().unwrap_or(false),
            };
            if last_activity_at >= options.now_ms - RECENT_ACTIVITY_MS {
                recent.push(sample);
            } else {
                others.push(sample);
            }
        }
    }
    let mut state = options.render_seed.max(1);
    let mut picked = Vec::new();
    while picked.len() < options.render_extra && !others.is_empty() {
        let index = (next_random(&mut state) % others.len() as u64) as usize;
        picked.push(others.swap_remove(index));
    }
    let legacy = LegacySource(conn);
    let context = ContextSource(conn);
    let mut check = RenderCheck {
        seed: options.render_seed,
        ..RenderCheck::default()
    };
    for sample in recent.iter().chain(picked.iter()) {
        let project = sessions
            .project
            .get(&sample.session_id)
            .cloned()
            .unwrap_or_default();
        let inputs = M0ComposeInputs {
            score_selector: mc_store::ScoreSelector::Base,
            session_id: &sample.session_id,
            project_path: &project,
            project_directory: "",
            now_ms: sample.expiry_cutoff_ms,
            // Large enough that no compartment is decayed and no memory is cut, so the
            // selection cannot depend on how ties inside a budget cut are ordered.
            history_budget_tokens: 1e12,
            covered_system_messages: &[],
            // Only where the store's memories won can the two memory blocks be expected to
            // agree: where context.db wins, its differing twins are kept on purpose.
            memory_enabled: store_wins.contains(&project) && !sample.memory_disabled,
            memory_budget_tokens: 1e15,
            user_profile_budget_tokens: 0.0,
            inject_docs: false,
            temporal_awareness: true,
            mural: None,
        };
        let estimate = |text: &str| text.len() / 4;
        let before = compose_m0_from_store(&legacy, &inputs, estimate).map(|m0| m0.m0_bytes);
        let after = compose_m0_from_store(&context, &inputs, estimate).map(|m0| m0.m0_bytes);
        check.sampled += 1;
        let outcome = match (&before, &after) {
            (Ok(before), Ok(after)) => compare_renders(before, after),
            (Err(before), Err(after)) if before.to_string() == after.to_string() => Ok(()),
            (before, after) => Err(format!(
                "composition differs: before {:?}, after {:?}",
                before.as_ref().err().map(ToString::to_string),
                after.as_ref().err().map(ToString::to_string)
            )),
        };
        if let Err(difference) = outcome {
            return Err(Refusal::new(
                RENDER_MISMATCH,
                format!(
                    "session {} renders differently after the copy: {difference}",
                    sample.session_id
                ),
            )
            .with_detail(json!({"session": sample.session_id, "difference": difference}))
            .into());
        }
        eprintln!("render check: session {} ok", sample.session_id);
        check.passed += 1;
    }
    Ok(check)
}

// ── Verification ────────────────────────────────────────────────────────────

fn mismatch(detail: impl Into<String>) -> EngineError {
    Refusal::new(VERIFY_MISMATCH, detail).into()
}

/// Re-read what the run wrote. Any failure rolls both files back.
fn verify(
    conn: &Connection,
    copier: &Copier<'_>,
    source: &Source,
    decided: &BTreeMap<String, Classification>,
    copied_sessions: &BTreeSet<String>,
) -> Result<(), EngineError> {
    // Every store memory has its twin, and where the store won, the twin holds its values.
    for row in &source.memories {
        let project_value = get(row, "project_path");
        let project = as_text(&project_value).unwrap_or_default();
        let Some(Classification::Wins(winner)) = decided.get(project) else {
            continue;
        };
        let store_id = as_i64(&get(row, "id")).unwrap_or_default();
        let Some(context_id) = copier.memory_ids.get(&store_id) else {
            return Err(mismatch(format!(
                "store memory {store_id} of {project} was not copied"
            )));
        };
        let current = read_by_id(conn, "ctx.memories", MEMORY_COLUMNS, *context_id)?;
        let desired: Vec<SqlValue> = MEMORY_COLUMNS
            .iter()
            .map(|column| get(row, column))
            .collect();
        if *winner == Winner::Store && current.as_ref() != Some(&desired) {
            return Err(mismatch(format!(
                "context memory {context_id} does not hold store memory {store_id}'s values"
            )));
        }
        if current.is_none() {
            return Err(mismatch(format!("context memory {context_id} is missing")));
        }
    }
    // Every copied session's compartments equal the store's, sequence for sequence.
    for session in copied_sessions {
        let src = copier.session_src(session, source)?;
        let context: Vec<Vec<SqlValue>> = read_rows(
            conn,
            &format!(
                "SELECT id, {} FROM ctx.compartments WHERE session_id = ?1 ORDER BY sequence",
                column_list(COMPARTMENT_COLUMNS)
            ),
            &[text(session)],
            COMPARTMENT_COLUMNS.len(),
        )?
        .into_iter()
        .map(|(_, values)| values)
        .collect();
        if let Some(before) = copier.context_kept.get(session) {
            if &context != before {
                return Err(mismatch(format!(
                    "session {session}'s context history was to be kept but changed during the copy"
                )));
            }
        } else if !src.compartments.is_empty() && context != src.compartments {
            return Err(mismatch(format!(
                "session {session}'s context compartments differ from the store's after the copy"
            )));
        }
        let foreign: Option<i64> = conn
            .query_row(
                "SELECT e.id FROM ctx.compartment_events e
                   JOIN ctx.compartments c ON c.id = e.compartment_id
                  WHERE e.session_id = ?1 AND c.session_id != e.session_id LIMIT 1",
                params![session],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = foreign {
            return Err(mismatch(format!(
                "event {id} of session {session} points at another session's compartment"
            )));
        }
    }
    // References of every memory the run wrote name existing memories.
    for id in &copier.written_memories {
        let (superseded, merged_from): (Option<i64>, Option<String>) = conn.query_row(
            "SELECT superseded_by_memory_id, merged_from FROM ctx.memories WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let mut targets: Vec<i64> = superseded.into_iter().collect();
        if let Some(Value::Array(ids)) = merged_from.and_then(|raw| serde_json::from_str(&raw).ok())
        {
            targets.extend(ids.iter().filter_map(Value::as_i64));
        }
        for target in targets {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM ctx.memories WHERE id = ?1)",
                params![target],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(mismatch(format!(
                    "memory {id} references missing memory {target}"
                )));
            }
        }
    }
    let broken_keys: Option<i64> = conn
        .query_row(
            "PRAGMA ctx.foreign_key_check(memory_verifications)",
            [],
            |row| row.get(1),
        )
        .optional()?;
    if let Some(rowid) = broken_keys {
        return Err(mismatch(format!(
            "memory_verifications row {rowid} names a memory that does not exist"
        )));
    }
    for table in [
        "mirror_identity",
        "authority_managed",
        "authority_repair_pending",
    ] {
        if table_exists(conn, table)? {
            let left: i64 =
                conn.query_row(&format!("SELECT COUNT(*) FROM ctx.{table}"), [], |row| {
                    row.get(0)
                })?;
            if left > 0 {
                return Err(mismatch(format!("{left} {table} row(s) were left behind")));
            }
        }
    }
    Ok(())
}

// ── Backup ──────────────────────────────────────────────────────────────────

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn context_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )
}

/// Print how long one step of the migration took, on stderr beside the other progress
/// lines. A run on a large pair takes minutes, and the operator should see it moving.
fn log_step(step: &str, started: Instant) {
    eprintln!("{step}: {:.1}s", started.elapsed().as_secs_f64());
}

/// Copy both files into `backup_dir` with a consistent snapshot of each, check each copy,
/// and write `MANIFEST.tsv` (name, source path, schema version, sha256).
///
/// Checking a copy means reading it in full twice: once for `PRAGMA quick_check` and once
/// for its sha256. On a multi-gigabyte `context.db` those two reads, not the copy, are
/// most of the migration's wall time, so they run side by side rather than one after the
/// other.
fn backup(options: &EngineOptions) -> Result<(), EngineError> {
    backup_files(options)?;
    let data = options
        .context_db
        .parent()
        .map(|dir| dir.display().to_string())
        .unwrap_or_default();
    eprintln!(
        "Backup written to {backup}.\nTo undo: quit every host, then\n  rm -f {data}/context.db-wal {data}/context.db-shm {data}/store.db-wal {data}/store.db-shm\n  cp {backup}/context.db {backup}/store.db {data}/\nKeep the current plugin and ck-mc: TypeScript mode works as before; Rust mode refuses with MC-C14 until re-migrated.",
        backup = options.backup_dir.display()
    );
    Ok(())
}

/// The copy-and-check half of [`backup`], without the migration's undo instructions.
pub(crate) fn backup_files(options: &EngineOptions) -> Result<(), EngineError> {
    let private = crate::config::private_storage_permissions_enabled();
    ensure_directory(&options.backup_dir, private)?;
    let mut manifest = String::from("name\tsource\tschema_version\tsha256\n");
    for (name, source) in [
        ("context.db", &options.context_db),
        ("store.db", &options.store_db),
    ] {
        let target = options.backup_dir.join(name);
        eprintln!(
            "backing up {name} ({:.1} GB)...",
            file_len(source) as f64 / 1e9
        );
        let conn = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        mc_store::single_store_domain::set_synchronous_normal_if_wal(&conn)?;
        conn.busy_timeout(std::time::Duration::from_millis(u64::from(
            CONTEXT_BUSY_TIMEOUT_MS,
        )))?;
        let step = Instant::now();
        conn.execute("VACUUM INTO ?1", params![target.to_string_lossy()])?;
        drop(conn);
        log_step(&format!("backup {name}: copy"), step);
        let step = Instant::now();
        let (check, digest) = std::thread::scope(|scope| {
            let digest = scope.spawn(|| sha256_file(&target));
            let check = (|| -> rusqlite::Result<(String, i64)> {
                let copy = Connection::open_with_flags(&target, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
                mc_store::single_store_domain::set_synchronous_normal_if_wal(&copy)?;
                let check: String = copy.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
                let version = if name == "context.db" {
                    context_version(&copy)?
                } else {
                    i64::from(schema::recorded_store_version(&copy)?)
                };
                Ok((check, version))
            })();
            let digest = digest
                .join()
                .unwrap_or_else(|_| Err(std::io::Error::other("the sha256 thread panicked")));
            (check, digest)
        });
        let (check, version) = check?;
        let digest = digest?;
        log_step(&format!("backup {name}: quick_check and sha256"), step);
        if check != "ok" {
            return Err(EngineError::Internal(format!(
                "backup {} failed quick_check: {check}",
                target.display()
            )));
        }
        manifest.push_str(&format!(
            "{name}\t{}\t{version}\t{digest}\n",
            source.display(),
        ));
    }
    write_file(
        &options.backup_dir.join("MANIFEST.tsv"),
        manifest.as_bytes(),
        private,
    )?;
    let report = tighten_tree(&options.backup_dir, private);
    tracing::info!(
        tightened = report.tightened,
        failures = report.failures,
        "mc-module: migration backup permission tightening"
    );
    Ok(())
}

// ── The run ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
struct ContextState {
    state: String,
    migrated_at: Option<i64>,
    migrated_by: Option<String>,
    backup_dir: Option<String>,
}

fn read_context_state(conn: &Connection) -> rusqlite::Result<Option<ContextState>> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'single_store_state')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(None);
    }
    conn.query_row(
        "SELECT state, migrated_at, migrated_by, backup_dir FROM single_store_state WHERE id = 1",
        [],
        |row| {
            Ok(ContextState {
                state: row.get(0)?,
                migrated_at: row.get(1)?,
                migrated_by: row.get(2)?,
                backup_dir: row.get(3)?,
            })
        },
    )
    .optional()
}

/// The store's single-store marker: `(set, stamp, build)`.
fn read_store_marker(conn: &Connection) -> rusqlite::Result<(bool, Option<i64>, String)> {
    conn.query_row(
        "SELECT single_store, single_store_set_at_ms, single_store_set_by FROM mc_privilege_state WHERE id = 1",
        [],
        |row| Ok((row.get::<_, i64>(0)? != 0, row.get(1)?, row.get(2)?)),
    )
    .optional()
    .map(|row| row.unwrap_or((false, None, String::new())))
}

fn split_refusal(
    detail: String,
    context: &Option<ContextState>,
    marker: &(bool, Option<i64>, String),
) -> EngineError {
    Refusal::new(
        STATE_SPLIT,
        format!("{detail}; restore both files from the backup in {} and run again", context
            .as_ref()
            .and_then(|state| state.backup_dir.clone())
            .unwrap_or_else(|| "the last single-store backup".to_string())),
    )
    .with_detail(json!({
        "context_state": context.as_ref().map(|state| json!({
            "state": state.state, "migrated_at": state.migrated_at, "migrated_by": state.migrated_by,
        })),
        "store_marker": {"set": marker.0, "set_at_ms": marker.1, "set_by": marker.2},
    }))
    .into()
}

fn file_len(path: &Path) -> u64 {
    std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

pub(crate) fn open_existing(path: &Path) -> Result<Connection, EngineError> {
    if !path.exists() {
        return Err(EngineError::Internal(format!(
            "{} does not exist",
            path.display()
        )));
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    mc_store::single_store_domain::set_synchronous_normal_if_wal(&conn)?;
    conn.busy_timeout(std::time::Duration::from_millis(u64::from(
        CONTEXT_BUSY_TIMEOUT_MS,
    )))?;
    Ok(conn)
}

fn restore_wal(conn: &Connection) {
    for schema in ["main", "ctx"] {
        let restore = (|| -> rusqlite::Result<()> {
            let journal =
                conn.query_row(&format!("PRAGMA {schema}.journal_mode = WAL"), [], |row| {
                    row.get::<_, String>(0)
                })?;
            if journal != "wal" {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let database = if schema == "main" {
                rusqlite::DatabaseName::Main
            } else {
                rusqlite::DatabaseName::Attached("ctx")
            };
            conn.pragma_update(Some(database), "synchronous", "NORMAL")
        })();
        if let Err(error) = restore {
            eprintln!("could not restore WAL mode on {schema}: {error}");
        }
    }
}

/// Run the migration. See the module documentation for the order of work.
pub fn run(options: &EngineOptions, hooks: &mut dyn EngineHooks) -> Result<Report, EngineError> {
    if options.check_context_path {
        let resolved = host_store::resolve_context_db_path();
        let canonical =
            |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if canonical(&resolved) != canonical(&options.context_db) {
            return Err(Refusal::new(
                PATH_MISMATCH,
                format!(
                    "the module resolves context.db to {}, but the migration was asked to use {}",
                    resolved.display(),
                    options.context_db.display()
                ),
            )
            .into());
        }
    }
    let context_conn = open_existing(&options.context_db)?;
    let version = context_version(&context_conn)?;
    // Only the lower bound is enforced. A later context.db migration that leaves the
    // tables this engine writes unchanged is fine, the same rule the module's own fence
    // follows; a change to one of those tables is caught by the fingerprints below.
    if version < MIN_CONTEXT_VERSION {
        return refuse(
            VERSION_MISMATCH,
            format!("context.db is v{version}; the migration needs v{MIN_CONTEXT_VERSION} or later (start the updated plugin once, then run it again)"),
        );
    }
    let fence = FenceState::read(
        &context_conn,
        &options.context_db,
        BUILT_CONTEXT_FENCE_VERSION,
    )
    .map_err(|error| EngineError::Internal(error.to_string()))?;
    for table in WRITTEN_CONTEXT_TABLES {
        fence.check_table(table).map_err(|error| {
            let message = match column_drift(&context_conn, table) {
                Some(drift) => format!("{error}. {drift}"),
                None => error.to_string(),
            };
            Refusal::new(FINGERPRINT_MISMATCH, message)
        })?;
    }
    let context_state = read_context_state(&context_conn)?;

    let store_conn = open_existing(&options.store_db)?;
    let store_version = schema::recorded_store_version(&store_conn)?;
    if store_version > mc_store::LATEST_MIGRATION_VERSION {
        return refuse(
            VERSION_MISMATCH,
            format!("store.db is v{store_version}, newer than this ck-mc knows (v{}); context.db is v{version}", mc_store::LATEST_MIGRATION_VERSION),
        );
    }
    let marker = if schema::table_exists(&store_conn, "main", "mc_privilege_state")? {
        read_store_marker(&store_conn)?
    } else {
        (false, None, String::new())
    };
    let context_migrated = context_state
        .as_ref()
        .is_some_and(|state| state.state == "migrated");
    if store_version >= schema::SINGLE_STORE_MIGRATION_VERSION {
        if !marker.0 {
            return Err(split_refusal(
                format!("store.db is at migration {store_version} without its marker"),
                &context_state,
                &marker,
            ));
        }
        if context_migrated
            && context_state.as_ref().and_then(|state| state.migrated_at) == marker.1
        {
            let state = context_state.clone().unwrap_or_default();
            restore_both_wal(options);
            eprintln!(
                "already migrated at {} by {}; backup {}",
                state.migrated_at.unwrap_or_default(),
                state.migrated_by.clone().unwrap_or_default(),
                state.backup_dir.clone().unwrap_or_default()
            );
            return Ok(Report {
                status: "already_migrated".into(),
                backup_dir: state.backup_dir,
                migrated_at: state.migrated_at,
                migrated_by: state.migrated_by,
                store_db_bytes: StoreBytes {
                    before: file_len(&options.store_db),
                    after: None,
                },
                ..Report::default()
            });
        }
        if !context_migrated && marker.2.ends_with(schema::FRESH_INSTALL_MARKER_SUFFIX) {
            // A fresh store that McStore::open migrated, whose context.db flag the module
            // had not written yet. There is nothing to move; write the flag.
            if !options.dry_run {
                write_fresh_context_flag(
                    &context_conn,
                    marker.1.unwrap_or(options.now_ms),
                    &marker.2,
                )?;
            }
            return Ok(Report {
                status: "already_migrated".into(),
                migrated_at: marker.1,
                migrated_by: Some(marker.2.clone()),
                store_db_bytes: StoreBytes {
                    before: file_len(&options.store_db),
                    after: None,
                },
                ..Report::default()
            });
        }
        return Err(split_refusal(
            "store.db carries the single-store marker but context.db does not record the same migration".into(),
            &context_state,
            &marker,
        ));
    }
    if context_migrated {
        return Err(split_refusal(
            format!("context.db records the migration but store.db is still v{store_version}"),
            &context_state,
            &marker,
        ));
    }
    if options.backup_dir.exists() {
        return refuse(
            BACKUP_DIR_EXISTS,
            format!(
                "the backup directory {} already exists; choose a new one",
                options.backup_dir.display()
            ),
        );
    }
    drop(context_conn);
    drop(store_conn);

    if options.dry_run {
        return dry_run_on_copies(options, hooks, store_version);
    }
    backup(options)?;
    migrate_files(options, hooks, store_version)
}

/// Run the whole migration against copies of both files and report what it would do.
///
/// The migration cannot run read-only: it upgrades an older `store.db` to the version it
/// starts from, switches both files out of WAL mode, and runs its work in a write
/// transaction it then rolls back. Done on the live files, a dry run would change
/// `store.db` and create the backup directory, after which the real run with the same
/// `--backup-dir` refuses with `BACKUP_DIR_EXISTS`. The copies are taken the same way the
/// backup is (a checked `VACUUM INTO`), into a scratch directory beside the requested
/// backup directory so they land on the same volume the real backup would use, and the
/// directory is removed afterwards whatever the outcome.
fn dry_run_on_copies(
    options: &EngineOptions,
    hooks: &mut dyn EngineHooks,
    store_version: u32,
) -> Result<Report, EngineError> {
    let scratch = DryRunScratch::new(&options.backup_dir)?;
    let mut copy = options.clone();
    copy.backup_dir = scratch.path.clone();
    backup_files(&copy)?;
    copy.context_db = scratch.path.join("context.db");
    copy.store_db = scratch.path.join("store.db");
    let mut report = migrate_files(&copy, hooks, store_version)?;
    // Nothing was backed up for the caller, and the sizes are those of the live file.
    report.backup_dir = None;
    report.store_db_bytes.before = file_len(&options.store_db);
    Ok(report)
}

/// The scratch directory a dry run copies both files into, removed when dropped.
struct DryRunScratch {
    path: PathBuf,
}

impl DryRunScratch {
    fn new(backup_dir: &Path) -> Result<Self, EngineError> {
        let name = backup_dir
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "single-store-backup".to_string());
        let path = backup_dir.with_file_name(format!(
            "{name}.dry-run-{}-{}",
            std::process::id(),
            now_ms()
        ));
        // `create_dir` (not `create_dir_all`) so an existing directory is never adopted
        // and then deleted by the drop below.
        create_directory(&path, crate::config::private_storage_permissions_enabled())?;
        Ok(DryRunScratch { path })
    }
}

impl Drop for DryRunScratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Everything after the backup: bring an older `store.db` up to the starting version,
/// switch both files to rollback-journal mode, run the transaction, restore WAL, and on a
/// real run compact `store.db`.
fn migrate_files(
    options: &EngineOptions,
    hooks: &mut dyn EngineHooks,
    store_version: u32,
) -> Result<Report, EngineError> {
    if store_version < schema::PRE_SINGLE_STORE_VERSION {
        mc_store::migrate_store_to_pre_single_store(&options.store_db)?;
    }
    let store_bytes_before = file_len(&options.store_db);

    let conn = open_existing(&options.store_db)?;
    // The attached two-file migration intentionally uses rollback journals so SQLite's
    // super-journal can commit both files atomically. It must not inherit WAL's NORMAL.
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.query_row("PRAGMA main.journal_mode = DELETE", [], |row| {
        row.get::<_, String>(0)
    })?;
    conn.execute(
        "ATTACH DATABASE ?1 AS ctx",
        params![options.context_db.to_string_lossy()],
    )?;
    conn.query_row("PRAGMA ctx.journal_mode = DELETE", [], |row| {
        row.get::<_, String>(0)
    })?;
    conn.pragma_update(
        Some(rusqlite::DatabaseName::Attached("ctx")),
        "synchronous",
        "FULL",
    )?;
    let started = Instant::now();
    let outcome = migrate_in_transaction(&conn, options, hooks);
    let transaction_ms = started.elapsed().as_millis() as u64;
    if outcome.is_err() || options.dry_run {
        let _ = conn.execute_batch("ROLLBACK");
    }
    restore_wal(&conn);
    drop(conn);
    let mut report = outcome?;
    report.transaction_ms = Some(transaction_ms);
    report.backup_dir = Some(options.backup_dir.display().to_string());
    report.store_db_bytes.before = store_bytes_before;
    if options.dry_run {
        report.status = "dry_run".into();
        return Ok(report);
    }
    let vacuum_started = Instant::now();
    let store = open_existing(&options.store_db)?;
    store.execute_batch("VACUUM")?;
    drop(store);
    report.vacuum_ms = Some(vacuum_started.elapsed().as_millis() as u64);
    report.store_db_bytes.after = Some(file_len(&options.store_db));
    Ok(report)
}

fn restore_both_wal(options: &EngineOptions) {
    for path in [&options.store_db, &options.context_db] {
        if let Ok(conn) = open_existing(path) {
            let _ = conn.query_row("PRAGMA journal_mode = WAL", [], |row| {
                row.get::<_, String>(0)
            });
            let _ = mc_store::single_store_domain::set_wal_synchronous_normal(&conn);
        }
    }
}

/// Write `single_store_state = migrated` for an empty store that `McStore::open` took
/// straight to migration 61 (a fresh install), clearing the mirror rows in the same
/// transaction. Nothing needs moving, so no backup is recorded.
pub fn write_fresh_context_flag(
    conn: &Connection,
    stamp: i64,
    build: &str,
) -> rusqlite::Result<()> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| {
        conn.execute(
            "INSERT OR IGNORE INTO single_store_state(id, state) VALUES (1, 'required')",
            [],
        )?;
        conn.execute(
            "UPDATE single_store_state SET state = 'migrated', migrated_at = ?1, migrated_by = ?2,
                    backup_dir = NULL, report_json = '{}' WHERE id = 1",
            params![stamp, build],
        )?;
        for table in CONTEXT_CLEARED_TABLES {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                params![table],
                |row| row.get(0),
            )?;
            if exists {
                conn.execute(&format!("DELETE FROM {table}"), [])?;
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT"),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn normalize_context_compartment_boundaries(
    conn: &Connection,
    now: i64,
) -> Result<usize, EngineError> {
    let mut stmt = conn.prepare("SELECT id, session_id, COALESCE(start_message_id, ''), COALESCE(end_message_id, ''), start_block_index, end_block_index FROM ctx.compartments")?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    let mut count = 0;
    let mut sessions = BTreeSet::new();
    for (id, session, start, end, old_start_block, old_end_block) in rows {
        let (start_id, start_block) =
            mc_store::context_boundaries::canonical_boundary_parts(&start)?;
        let (end_id, end_block) = mc_store::context_boundaries::canonical_boundary_parts(&end)?;
        if start_id == start && end_id == end {
            continue;
        }
        if start_block
            .zip(old_start_block)
            .is_some_and(|(a, b)| a != b)
            || end_block.zip(old_end_block).is_some_and(|(a, b)| a != b)
        {
            return refuse(
                VERIFY_MISMATCH,
                format!("compartment {id} has conflicting flat and indexed boundaries"),
            );
        }
        conn.execute("UPDATE ctx.compartments SET start_message_id=?1, end_message_id=?2, start_block_index=?3, end_block_index=?4 WHERE id=?5", params![start_id, end_id, start_block.or(old_start_block), end_block.or(old_end_block), id])?;
        sessions.insert(session);
        count += 1;
    }
    // Rebuild frozen TypeScript prefixes whose boundary representation changed.
    for session in sessions {
        conn.execute("INSERT INTO ctx.m0_mutation_log(session_id, mutation_type, target_id, queued_at) VALUES (?1, 'compartment_upgrade', NULL, ?2)", params![session, now])?;
    }
    Ok(count)
}

fn migrate_in_transaction(
    conn: &Connection,
    options: &EngineOptions,
    hooks: &mut dyn EngineHooks,
) -> Result<Report, EngineError> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let step = Instant::now();
    conn.execute_batch(schema::MIGRATION_61_CREATE_SQL)?;
    let file_uuid: String = conn
        .query_row(
            "SELECT value FROM ctx.context_store_meta WHERE key = 'store_uuid'",
            [],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or_default();
    let source = read_source(conn)?;
    let sessions = Sessions::read(conn)?;

    let mut projects = BTreeSet::new();
    for row in source
        .memories
        .iter()
        .chain(&source.notes)
        .chain(&source.primers)
        .chain(&source.mappings)
    {
        if let Some(project) = as_text(&get(row, "project_path")) {
            projects.insert(project.to_string());
        }
    }
    let authority = Authority::read(conn)?;
    let decided = classify_projects(&authority, &projects, &file_uuid, options)?;
    log_step("read and classify", step);
    let step = Instant::now();
    let skipped_projects: BTreeSet<&String> = decided
        .iter()
        .filter(|(_, decision)| **decision == Classification::Skipped)
        .map(|(project, _)| project)
        .collect();
    let store_wins: BTreeSet<String> = decided
        .iter()
        .filter(|(_, decision)| **decision == Classification::Wins(Winner::Store))
        .map(|(project, _)| project.clone())
        .collect();

    let has_privilege = table_exists(conn, "context_privilege_state")?;
    if has_privilege {
        conn.execute(
            "INSERT OR IGNORE INTO ctx.context_privilege_state(id, enabled) VALUES (1, 0)",
            [],
        )?;
        conn.execute(
            "UPDATE ctx.context_privilege_state SET enabled = 1 WHERE id = 1",
            [],
        )?;
    }
    let normalized_context_compartments =
        normalize_context_compartment_boundaries(conn, options.now_ms)?;
    let mut copier = Copier {
        conn,
        file_uuid,
        sessions: &sessions,
        has_identity: table_exists(conn, "mirror_identity")?,
        memory_ids: HashMap::new(),
        claimed: HashSet::new(),
        pending_references: Vec::new(),
        written_memories: BTreeSet::new(),
        changed_projects: BTreeSet::new(),
        highest_inserted: BTreeMap::new(),
        reports: BTreeMap::new(),
        dangling: Vec::new(),
        store_memory_ids: source
            .memories
            .iter()
            .filter_map(|row| as_i64(&get(row, "id")))
            .collect(),
        orphan_mappings: 0,
        authority: &authority,
        prefer: &options.prefer,
        prefer_history: &options.prefer_history,
        history: Vec::new(),
        context_kept: BTreeMap::new(),
    };
    for (project, decision) in &decided {
        let Classification::Wins(winner) = *decision else {
            continue;
        };
        copier.copy_memories(project, winner, &by_project(&source.memories, project))?;
    }
    copier.write_references()?;
    for (project, decision) in &decided {
        let Classification::Wins(winner) = *decision else {
            continue;
        };
        copier.copy_notes(project, winner, &by_project(&source.notes, project))?;
        copier.copy_mappings(project, winner, &by_project(&source.mappings, project))?;
        copier.copy_primers(project, winner, &by_project(&source.primers, project))?;
    }
    if !copier.dangling.is_empty() {
        copier.write_references()?;
    }
    if copier.orphan_mappings > 0 {
        eprintln!(
            "{} memory mapping(s) name a memory store.db no longer has; they stay only in the backup",
            copier.orphan_mappings
        );
    }
    let mut skipped_sessions = BTreeSet::new();
    let mut copied_sessions = BTreeSet::new();
    let session_ids: BTreeSet<&String> = source
        .compartments
        .keys()
        .chain(source.events.keys())
        .chain(source.candidates.keys())
        .collect();
    for session in session_ids {
        if sessions
            .project
            .get(session)
            .is_some_and(|project| skipped_projects.contains(project))
        {
            skipped_sessions.insert(session.clone());
            continue;
        }
        copier.copy_session(session, &source)?;
        copied_sessions.insert(session.clone());
    }
    for (project, highest) in copier.highest_inserted.clone() {
        host_store::raise_embedding_watermark(conn, &project, highest, options.now_ms)
            .map_err(|error| EngineError::Internal(error.to_string()))?;
    }

    log_step("copy", step);
    let step = Instant::now();
    check_claude_code_ids(conn, &copier, &sessions, options)?;
    log_step("claude code id check", step);
    let step = Instant::now();

    let sessions_reset = schema::reset_cache_state_for_single_store(conn)?;
    for project in &copier.changed_projects {
        conn.execute(
            "INSERT INTO ctx.project_state(project_path, project_memory_epoch, updated_at)
             VALUES (?1, 1, ?2)
             ON CONFLICT(project_path) DO UPDATE SET
                 project_memory_epoch = project_memory_epoch + 1, updated_at = excluded.updated_at",
            params![project, options.now_ms],
        )?;
    }
    for table in CONTEXT_CLEARED_TABLES {
        if table_exists(conn, table)? {
            conn.execute(&format!("DELETE FROM ctx.{table}"), [])?;
        }
    }
    if has_privilege {
        conn.execute(
            "UPDATE ctx.context_privilege_state SET enabled = 0 WHERE id = 1",
            [],
        )?;
    }

    log_step("cache reset and flags", step);
    hooks.after_copy(conn)?;
    let step = Instant::now();
    verify(conn, &copier, &source, &decided, &copied_sessions)?;
    log_step("verify", step);
    let step = Instant::now();
    // A session whose context history was kept has nothing to compare: the store copy it
    // would be checked against is the one the migration left behind.
    let unmoved_sessions: BTreeSet<String> = skipped_sessions
        .iter()
        .cloned()
        .chain(copier.context_kept.keys().cloned())
        .collect();
    let render_check = render_check(conn, &sessions, &unmoved_sessions, &store_wins, options)?;
    log_step("render check", step);

    let mut projects_report: Vec<ProjectReport> = Vec::new();
    for (project, decision) in &decided {
        let mut entry = copier
            .reports
            .remove(project)
            .unwrap_or_else(|| ProjectReport {
                project: project.clone(),
                ..ProjectReport::default()
            });
        match decision {
            Classification::Wins(winner) => entry.winner = Some(*winner),
            Classification::Skipped => entry.skipped = true,
        }
        projects_report.push(entry);
    }
    let history = std::mem::take(&mut copier.history);
    projects_report.extend(copier.reports.into_values());
    let mut report = Report {
        status: "migrated".into(),
        backup_dir: Some(options.backup_dir.display().to_string()),
        migrated_at: Some(options.now_ms),
        migrated_by: Some(options.build.clone()),
        projects: projects_report,
        render_check,
        history,
        sessions_reset,
        normalized_context_compartments,
        ..Report::default()
    };
    report.store_db_bytes.before = file_len(&options.store_db);

    conn.execute_batch(schema::MIGRATION_61_DROP_SQL)?;
    conn.execute(
        schema::SINGLE_STORE_MARKER_SQL,
        params![options.now_ms, options.build],
    )?;
    conn.execute(
        "INSERT INTO main.cortexkit_schema_version(namespace, version, applied_at_unix) VALUES (?1, ?2, ?3)",
        params![schema::STORE_NAMESPACE, schema::SINGLE_STORE_MIGRATION_VERSION, options.now_ms / 1000],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO ctx.single_store_state(id, state) VALUES (1, 'required')",
        [],
    )?;
    conn.execute(
        "UPDATE ctx.single_store_state SET state = 'migrated', migrated_at = ?1, migrated_by = ?2,
                backup_dir = ?3, report_json = ?4 WHERE id = 1",
        params![
            options.now_ms,
            options.build,
            options.backup_dir.display().to_string(),
            report.to_value().to_string()
        ],
    )?;
    if !options.dry_run {
        conn.execute_batch("COMMIT")?;
    }
    Ok(report)
}

/// A Claude Code session rendered store memory ids. Where one of those ids now names a
/// different `context.db` memory, an agent acting on it would touch the wrong memory.
/// The `context.db` schema this build was made against, as the host creates it.
const BUILT_CONTEXT_SCHEMA: &str = include_str!("../tests/fixtures/context-db-schema.sql");

/// Name the columns of `table` that `context.db` has and this build does not know, and
/// say how to drop them. A column an old development build added (and no release ever
/// shipped) is the usual cause, and the operator can see and fix it straight away.
/// `None` when the columns match, so the refusal is about something else (an index, a
/// trigger, a constraint).
fn column_drift(conn: &Connection, table: &str) -> Option<String> {
    let columns = |conn: &Connection, schema: &str| -> Option<Vec<String>> {
        let mut statement = conn
            .prepare(&format!("PRAGMA {schema}.table_info(\"{table}\")"))
            .ok()?;
        let names = statement
            .query_map([], |row| row.get::<_, String>(1))
            .ok()?
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        Some(names)
    };
    let built = Connection::open_in_memory().ok()?;
    built.execute_batch(BUILT_CONTEXT_SCHEMA).ok()?;
    let known = columns(&built, "main")?;
    let live = columns(conn, "main")?;
    let unknown: Vec<&String> = live.iter().filter(|name| !known.contains(name)).collect();
    let missing: Vec<&String> = known.iter().filter(|name| !live.contains(name)).collect();
    if unknown.is_empty() && missing.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    if !unknown.is_empty() {
        let names = unknown
            .iter()
            .map(|name| name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let drops = unknown
            .iter()
            .map(|name| format!("ALTER TABLE {table} DROP COLUMN {name};"))
            .collect::<Vec<_>>()
            .join(" ");
        parts.push(format!(
            "{table} has column(s) this build does not know: {names}. If no release of Magic Context created them (a development build did), stop every Magic Context process and drop them with sqlite3 on context.db: {drops} Then run the migration again"
        ));
    }
    if !missing.is_empty() {
        let names = missing
            .iter()
            .map(|name| name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        parts.push(format!(
            "{table} lacks column(s) this build expects: {names}; start the matching Magic Context plugin once so it migrates context.db"
        ));
    }
    Some(parts.join(". "))
}

fn check_claude_code_ids(
    conn: &Connection,
    copier: &Copier<'_>,
    sessions: &Sessions,
    options: &EngineOptions,
) -> Result<(), EngineError> {
    if options.accept_id_change {
        return Ok(());
    }
    let mut affected = Vec::new();
    let mut statement =
        conn.prepare("SELECT session_id, meta FROM main.mc_cache_state ORDER BY session_id")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (session, meta) = row?;
        let Ok(meta) = serde_json::from_str::<Value>(&meta) else {
            continue;
        };
        if meta["last_serializer_profile"].as_str() != Some(CLAUDE_CODE_PROFILE) {
            continue;
        }
        for id in meta["rendered_memory_ids"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_i64)
        {
            if copier.memory_ids.get(&id) == Some(&id) {
                continue;
            }
            // After the move the session's lookups carry its own project
            // (`WHERE id = ? AND project_path = ?`), so an old id that now names a memory of
            // another project reads as "not found", which the agent already handles. Only a
            // memory of the session's own project would be read as the wrong memory. The
            // session's project is the one its host recorded, or else the project of the
            // memory it rendered under that id, which is the project it was reading.
            let project = match sessions.project.get(&session) {
                Some(project) => Some(project.clone()),
                None => conn
                    .query_row(
                        "SELECT project_path FROM main.mc_memories WHERE id = ?1",
                        params![id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?,
            };
            let Some(project) = project else {
                continue;
            };
            let taken: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM ctx.memories WHERE id = ?1 AND project_path = ?2)",
                params![id, project],
                |row| row.get(0),
            )?;
            if taken {
                affected.push(json!({"session": session, "project": project, "rendered_id": id}));
                break;
            }
        }
    }
    if affected.is_empty() {
        return Ok(());
    }
    Err(Refusal::new(
        CLAUDE_CODE_IDS,
        format!(
            "{} Claude Code session(s) rendered memory ids that name a different memory of the same project after the move; re-run with --accept-id-change to accept that",
            affected.len()
        ),
    )
    .with_detail(json!({"sessions": affected, "flag": "--accept-id-change"}))
    .into())
}

// ── Command line ────────────────────────────────────────────────────────────

const USAGE: &str = "usage: ck-mc single-store-migrate --context-db <path> --store-db <path> --backup-dir <dir> [--dry-run] [--skip-foreign] [--prefer <project>=store|context]... [--prefer-history <session>=store|context]... [--accept-id-change]";

/// Parse the command line into options. `Err` carries the usage error.
pub fn parse_args(args: &[String]) -> Result<EngineOptions, String> {
    let mut context_db = None;
    let mut store_db = None;
    let mut backup_dir = None;
    let mut dry_run = false;
    let mut skip_foreign = false;
    let mut accept_id_change = false;
    let mut prefer = BTreeMap::new();
    let mut prefer_history = BTreeMap::new();
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
            "--backup-dir" => backup_dir = Some(PathBuf::from(value("--backup-dir")?)),
            "--prefer" => {
                let raw = value("--prefer")?;
                let (project, side) = raw
                    .rsplit_once('=')
                    .ok_or_else(|| format!("--prefer takes <project>=store|context, got {raw}"))?;
                let winner = Winner::parse(side)
                    .ok_or_else(|| format!("--prefer takes <project>=store|context, got {raw}"))?;
                prefer.insert(project.to_string(), winner);
            }
            "--prefer-history" => {
                let raw = value("--prefer-history")?;
                let parsed = raw
                    .rsplit_once('=')
                    .and_then(|(session, side)| Some((session, Winner::parse(side)?)));
                let (session, winner) = parsed.ok_or_else(|| {
                    format!("--prefer-history takes <session>=store|context, got {raw}")
                })?;
                prefer_history.insert(session.to_string(), winner);
            }
            "--dry-run" => dry_run = true,
            "--skip-foreign" => skip_foreign = true,
            "--accept-id-change" => accept_id_change = true,
            other => return Err(format!("unknown argument {other}; {USAGE}")),
        }
    }
    let (Some(context_db), Some(store_db), Some(backup_dir)) = (context_db, store_db, backup_dir)
    else {
        return Err(USAGE.to_string());
    };
    let mut options = EngineOptions::new(context_db, store_db, backup_dir);
    options.dry_run = dry_run;
    options.skip_foreign = skip_foreign;
    options.accept_id_change = accept_id_change;
    options.prefer = prefer;
    options.prefer_history = prefer_history;
    Ok(options)
}

/// Run the command: the report is one JSON object on stdout. Exit 0 when migrated,
/// already migrated or a dry run; 2 when refused; 1 on an internal error.
pub fn cli_main(args: &[String]) -> i32 {
    let options = match parse_args(args) {
        Ok(options) => options,
        Err(usage) => {
            println!(
                "{}",
                json!({"status": "refused", "refusal": {"code": "single_store_usage", "message": usage}})
            );
            return 2;
        }
    };
    match run(&options, &mut NoHooks) {
        Ok(report) => {
            println!("{}", report.to_value());
            0
        }
        Err(EngineError::Refused(refusal)) => {
            println!(
                "{}",
                json!({
                    "status": "refused",
                    "backup_dir": (refusal.code != BACKUP_DIR_EXISTS && options.backup_dir.exists())
                        .then(|| options.backup_dir.display().to_string()),
                    "refusal": refusal.to_value(),
                })
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
#[path = "single_store_migrate_tests.rs"]
mod tests;
