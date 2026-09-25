//! Single-store writer: the module writing the host's `context.db` domain tables.
//!
//! Today the module owns `store.db` and a changefeed mirror copies domain rows into
//! `context.db`, which every interactive seat reads. This module is the first half of
//! removing that seam: it writes the domain tables directly, under the same discipline
//! the TypeScript host writes them under.
//!
//! Three rules shape everything here.
//!
//! 1. **`context.db` is a versioned external schema.** The module opens it, never
//!    migrates it, and refuses to write when the schema it finds is not the schema it
//!    was built against. "Not the schema" means two separate checks: the persisted
//!    migration lane must not be ahead of this binary's fence, and each domain table's
//!    full `sqlite_master` surface — its columns, its CHECK/UNIQUE constraints, its
//!    indexes, and its triggers — must hash to the value baked in below. Both are
//!    rechecked inside every write transaction, because a migration can land between
//!    opening the file and writing to it.
//!
//! 2. **The authority guards stay armed.** `context.db` carries triggers that abort a
//!    memory or note write for a managed project unless `context_privilege_state.enabled`
//!    is 1. Those triggers are the fail-closed net against a confused writer, so the
//!    module does not remove them: it flips the row to 1 inside its own
//!    `BEGIN IMMEDIATE` transaction and back to 0 before committing, exactly as the host
//!    does. A second connection never observes the flip, because it never observes an
//!    uncommitted transaction.
//!
//! 3. **A fold publish is split into bounded chunks.** One fold is the largest write in
//!    the system, and it lands in the file every interactive seat depends on behind a
//!    five-second busy timeout. Each chunk is its own transaction with its own flip, and
//!    the chunks are ordered so that the rows a reader composes session history from —
//!    the compartments, their facts, their events — all land in the final chunk. A reader
//!    between chunks sees the session exactly as it was before the fold started.
//!
//! In this slice the writers are shadow/verify only. `single_store: "on"` is refused by
//! name; `"shadow"` writes to a scratch copy of the file and reports how the rows it
//! produced differ from the rows already in `context.db`.

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Instant;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Whether this binary can serve a store whose project rows live in the host's own
/// database ("single-store mode"), as `session.status` reports it.
///
/// This is the store's own constant, not a second copy: `mc_store` is what refuses to
/// open a store carrying the single-store marker, so the status surface has to report
/// the same answer that refusal acts on. The writers in this file run only against a
/// scratch copy (`shadow`) and `on` is refused, so this build cannot serve a moved
/// store yet and reports `false`; the slice that adds the readers flips the store's
/// constant and this follows.
pub const SINGLE_STORE_CAPABLE: bool = mc_store::SINGLE_STORE_CAPABLE;

/// The `context.db` upstream migration lane this binary was built against.
///
/// The rule is `persisted <= built`, the same one-directional check the host applies to
/// its own file: a database migrated past this number may be read but never written,
/// because a newer migration may have changed a domain table in a way these writers do
/// not know about.
pub const BUILT_CONTEXT_FENCE_VERSION: i64 = 92;

/// Versions at or above this number belong to downstream forks and are excluded when
/// reading the persisted lane, matching the host's own fence arithmetic.
pub const FORK_MIGRATION_VERSION_FLOOR: i64 = 10_000;

/// How long a write waits for another writer before giving up.
///
/// Five seconds is the host's own tolerance. This module does not raise it: when a chunk
/// cannot fit inside that budget the chunk shrinks, the timeout does not grow.
pub const CONTEXT_BUSY_TIMEOUT_MS: u32 = 5_000;

/// The domain tables the module writes, and the only tables whose schema it fingerprints.
///
/// `user_memory_candidates` is the observations table behind the privacy gate;
/// `user_memories` holds the promoted ones. Both are listed because the fingerprint is a
/// per-table fence and the module refuses per table, not per file.
pub const DOMAIN_TABLES: &[&str] = &[
    "compartment_events",
    "compartments",
    "memories",
    "memory_embedding_watermarks",
    "notes",
    "primer_candidates",
    "session_facts",
    "user_memories",
    "user_memory_candidates",
];

/// Maximum rows one non-final chunk may write.
///
/// Sized from the measured publish transaction duration on the committed schema
/// snapshot: see `measured_chunk_cost_report` and the slice report. The budget targets a
/// chunk well under a fifth of `CONTEXT_BUSY_TIMEOUT_MS`, so a seat that arrives mid-fold
/// waits a small fraction of its tolerance rather than racing it.
pub const DEFAULT_PUBLISH_CHUNK_ROWS: usize = 64;

/// Target wall-clock ceiling for one chunk's write transaction, in microseconds.
///
/// This is what the row budget is derived from; the row count is the knob, this is the
/// property it exists to hold.
pub const PUBLISH_CHUNK_BUDGET_US: i64 = 250_000;

// ── Mode ────────────────────────────────────────────────────────────────────

/// Module config `single_store`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SingleStoreMode {
    /// The module does not open `context.db` at all. The mirror remains the only path.
    #[default]
    Off,
    /// The module runs its writers against a scratch copy and reports how the rows it
    /// produced differ from the rows already in `context.db`. Nothing is written to the
    /// real file.
    Shadow,
    /// The module writes `context.db` for real. Refused in this slice.
    On,
}

impl SingleStoreMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SingleStoreMode::Off => "off",
            SingleStoreMode::Shadow => "shadow",
            SingleStoreMode::On => "on",
        }
    }

    /// Parse a config value. An unrecognized value is not silently treated as `off`:
    /// the caller is told, so a typo in a config file surfaces as a warning rather than
    /// as a feature that quietly never runs.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "off" => Some(SingleStoreMode::Off),
            "shadow" => Some(SingleStoreMode::Shadow),
            "on" => Some(SingleStoreMode::On),
            _ => None,
        }
    }

    fn code(self) -> u8 {
        match self {
            SingleStoreMode::Off => 0,
            SingleStoreMode::Shadow => 1,
            SingleStoreMode::On => 2,
        }
    }

    fn from_code(code: u8) -> Self {
        match code {
            1 => SingleStoreMode::Shadow,
            2 => SingleStoreMode::On,
            _ => SingleStoreMode::Off,
        }
    }
}

// ── Errors ──────────────────────────────────────────────────────────────────

/// Why the module will not write `context.db`.
///
/// Every variant carries a stable code so the status surface can report a refusal
/// without a human reading prose, and so a health probe can distinguish "the file moved
/// ahead of this binary" from "this binary cannot open the file at all".
#[derive(Debug)]
pub enum HostStoreError {
    /// The file could not be opened or its connection could not be configured.
    OpenFailed {
        path: String,
        reason: String,
    },
    /// The database has no `schema_migrations` table, so it is not a `context.db` this
    /// binary can reason about.
    FenceMissing {
        path: String,
    },
    /// The persisted upstream lane is newer than this binary's fence.
    FenceAhead {
        persisted: i64,
        built: i64,
    },
    /// A domain table this binary writes is absent.
    TableMissing {
        table: String,
    },
    /// A domain table's schema surface is not the one this binary was built against.
    /// A trigger-only migration produces exactly this, which is why the fingerprint
    /// covers triggers and not just columns.
    FingerprintMismatch {
        table: String,
        expected: String,
        found: String,
    },
    /// `single_store: "on"` was requested. The writers exist but are shadow/verify only
    /// in this slice.
    ModeRefused {
        mode: &'static str,
    },
    /// The privilege row could not be flipped, or did not read back as flipped inside
    /// the transaction. Writing on regardless would hit the authority guards mid-publish
    /// and leave a partially applied chunk.
    PrivilegeFlipFailed {
        reason: String,
    },
    /// A chunk was handed more rows than the write budget admits. The budget is the
    /// property; exceeding it is a programming error in the chunker, not a runtime
    /// condition to absorb.
    ChunkBudgetExceeded {
        rows: usize,
        budget: usize,
    },
    Sqlite(rusqlite::Error),
}

impl HostStoreError {
    /// Stable machine-readable name for the status surface.
    pub fn code(&self) -> &'static str {
        match self {
            HostStoreError::OpenFailed { .. } => "single_store_open_failed",
            HostStoreError::FenceMissing { .. } => "single_store_fence_missing",
            HostStoreError::FenceAhead { .. } => "single_store_fence_ahead",
            HostStoreError::TableMissing { .. } => "single_store_table_missing",
            HostStoreError::FingerprintMismatch { .. } => "single_store_fingerprint_mismatch",
            HostStoreError::ModeRefused { .. } => "single_store_mode_refused",
            HostStoreError::PrivilegeFlipFailed { .. } => "single_store_privilege_flip_failed",
            HostStoreError::ChunkBudgetExceeded { .. } => "single_store_chunk_budget_exceeded",
            HostStoreError::Sqlite(_) => "single_store_sqlite_error",
        }
    }

    /// True when the refusal is about the schema rather than about this process, so a
    /// status reader can tell "the host migrated past me, rebuild the module" from
    /// "something went wrong here".
    pub fn is_schema_refusal(&self) -> bool {
        matches!(
            self,
            HostStoreError::FenceMissing { .. }
                | HostStoreError::FenceAhead { .. }
                | HostStoreError::TableMissing { .. }
                | HostStoreError::FingerprintMismatch { .. }
        )
    }
}

impl fmt::Display for HostStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HostStoreError::OpenFailed { path, reason } => {
                write!(formatter, "could not open {path} for domain writes: {reason}")
            }
            HostStoreError::FenceMissing { path } => write!(
                formatter,
                "{path} has no schema_migrations table, so its migration lane cannot be read"
            ),
            HostStoreError::FenceAhead { persisted, built } => write!(
                formatter,
                "context.db is at upstream migration lane v{persisted}, newer than the v{built} this module was built against; domain writes are refused until the module is rebuilt"
            ),
            HostStoreError::TableMissing { table } => {
                write!(formatter, "context.db has no {table} table")
            }
            HostStoreError::FingerprintMismatch {
                table,
                expected,
                found,
            } => write!(
                formatter,
                "context.db table {table} has schema fingerprint {found}, not the {expected} this module was built against; domain writes to {table} are refused"
            ),
            HostStoreError::ModeRefused { mode } => write!(
                formatter,
                "single_store mode {mode} is not available in this build: the context.db writers are shadow/verify only"
            ),
            HostStoreError::PrivilegeFlipFailed { reason } => write!(
                formatter,
                "could not take the context.db privileged-writer bracket: {reason}"
            ),
            HostStoreError::ChunkBudgetExceeded { rows, budget } => write!(
                formatter,
                "a publish chunk carried {rows} rows, over the {budget}-row write budget"
            ),
            HostStoreError::Sqlite(error) => write!(formatter, "context.db write failed: {error}"),
        }
    }
}

impl std::error::Error for HostStoreError {}

impl From<rusqlite::Error> for HostStoreError {
    fn from(error: rusqlite::Error) -> Self {
        HostStoreError::Sqlite(error)
    }
}

// ── Schema fingerprints ─────────────────────────────────────────────────────

/// The `sqlite_master` fingerprint each domain table must carry.
///
/// Regenerate together with any migration that touches a domain table:
/// `bun scripts/dump-context-db-schema.ts > crates/mc-module/tests/fixtures/context-db-schema.sql`
/// then run `cargo test -p mc-module host_store::tests::domain_fingerprints` — the test
/// prints the value it found for any table that drifted.
pub const DOMAIN_TABLE_FINGERPRINTS: &[(&str, &str)] = &[
    (
        "compartment_events",
        "c25a1a9fbae82a47e449aa1de08a0f9741a9665ada17d83e52e584225087e843",
    ),
    (
        "compartments",
        "3ea325c5d2d51df824126f3abcdd9f01707a4b254762b5c613323ad18a4591c3",
    ),
    (
        "memories",
        "614cc40bba9242ecd79577df693df5f90b98b5f6cd436f978b1293eda1372a12",
    ),
    (
        "memory_embedding_watermarks",
        "35ee22cf02938870a25f214d3b0002fb434a7f005b086fd4642e96e816bf15ad",
    ),
    (
        "notes",
        "efe8efd4759a9a9cc768808b3c94c55bc2af93ecd66778f64853c2f13c585ad7",
    ),
    (
        "primer_candidates",
        "ddeae5e61b4b3df6025141621a080574f196e3d782a209c79b3a2b21be201141",
    ),
    (
        "session_facts",
        "1e619e665f653afa4ab62a45f37e0dedee798085f4081ece02f40f278a834f64",
    ),
    (
        "user_memories",
        "d1b14d392fe181fb9563068356ebec6519ff956f3fc27ffc7cdc4438a3cbcd98",
    ),
    (
        "user_memory_candidates",
        "8129e1b067e2f1f69d2ea36d44c42df0757bc0d86f7c32eab57fb11a5847305a",
    ),
];

fn expected_fingerprint(table: &str) -> Option<&'static str> {
    DOMAIN_TABLE_FINGERPRINTS
        .iter()
        .find(|(name, _)| *name == table)
        .map(|(_, fingerprint)| *fingerprint)
}

/// Collapse the whitespace SQLite preserves verbatim in `sqlite_master.sql`.
///
/// Reformatting a CREATE statement without changing what it declares must not read as a
/// schema change; changing a column, a constraint, an index or a trigger body must.
fn normalize_schema_sql(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Hash one table's full `sqlite_master` surface.
///
/// `tbl_name` gathers the table itself plus every index and every trigger declared on it,
/// which is the surface a migration can change under the module: a trigger-only migration
/// on a domain table is the demonstrated shape, and a columns-only fingerprint would miss
/// it entirely.
fn read_table_fingerprint(
    conn: &Connection,
    table: &str,
) -> Result<Option<String>, rusqlite::Error> {
    let mut statement = conn.prepare(
        "SELECT type, name, sql FROM sqlite_master
          WHERE tbl_name = ?1 AND sql IS NOT NULL
          ORDER BY type ASC, name ASC",
    )?;
    let rows = statement
        .query_map(params![table], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    if !rows
        .iter()
        .any(|(kind, name, _)| kind == "table" && name == table)
    {
        return Ok(None);
    }

    let mut hasher = Sha256::new();
    for (kind, name, sql) in &rows {
        hasher.update(kind.as_bytes());
        hasher.update([0x1f]);
        hasher.update(name.as_bytes());
        hasher.update([0x1f]);
        hasher.update(normalize_schema_sql(sql).as_bytes());
        hasher.update([0x1e]);
    }
    Ok(Some(format!("{:x}", hasher.finalize())))
}

/// Read the persisted upstream migration lane, ignoring downstream fork numbers.
fn read_persisted_fence(conn: &Connection) -> Result<Option<i64>, rusqlite::Error> {
    let has_table: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if has_table.is_none() {
        return Ok(None);
    }
    let version: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations WHERE version < ?1",
        params![FORK_MIGRATION_VERSION_FLOOR],
        |row| row.get(0),
    )?;
    Ok(Some(version))
}

/// What the fence and fingerprint checks found, kept so the status surface can report it
/// without re-reading the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FenceState {
    pub persisted_version: i64,
    pub built_version: i64,
    pub fingerprints: BTreeMap<String, String>,
}

impl FenceState {
    fn read(conn: &Connection, path: &Path, built_version: i64) -> Result<Self, HostStoreError> {
        let persisted_version =
            read_persisted_fence(conn)?.ok_or_else(|| HostStoreError::FenceMissing {
                path: path.display().to_string(),
            })?;
        let mut fingerprints = BTreeMap::new();
        for table in DOMAIN_TABLES {
            if let Some(fingerprint) = read_table_fingerprint(conn, table)? {
                fingerprints.insert((*table).to_string(), fingerprint);
            }
        }
        Ok(FenceState {
            persisted_version,
            built_version,
            fingerprints,
        })
    }

    /// The whole-file part of the fence: refuse every domain write when the host has
    /// migrated past this binary.
    fn check_lane(&self) -> Result<(), HostStoreError> {
        if self.persisted_version > self.built_version {
            return Err(HostStoreError::FenceAhead {
                persisted: self.persisted_version,
                built: self.built_version,
            });
        }
        Ok(())
    }

    /// The per-table part of the fence. Behind-lane with a matching fingerprint is
    /// writable: the table this binary knows is the table that is there.
    fn check_table(&self, table: &str) -> Result<(), HostStoreError> {
        self.check_lane()?;
        let Some(found) = self.fingerprints.get(table) else {
            return Err(HostStoreError::TableMissing {
                table: table.to_string(),
            });
        };
        let expected = expected_fingerprint(table).unwrap_or("");
        if found != expected {
            return Err(HostStoreError::FingerprintMismatch {
                table: table.to_string(),
                expected: expected.to_string(),
                found: found.clone(),
            });
        }
        Ok(())
    }
}

// ── Publish input ───────────────────────────────────────────────────────────

/// A compartment row as the host writes it.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct HostCompartment {
    pub sequence: i64,
    pub start_message: i64,
    pub end_message: i64,
    pub start_message_id: String,
    pub end_message_id: String,
    pub title: String,
    pub content: String,
    pub p1: Option<String>,
    pub p2: Option<String>,
    pub p3: Option<String>,
    pub p4: Option<String>,
    pub importance: Option<i64>,
    pub episode_type: Option<String>,
    pub created_at: i64,
}

impl HostCompartment {
    /// The host stores `legacy = 0` for a compartment that carries at least the P1 tier
    /// and `1` for a flat pre-tier body. A no-content compartment is tiered by
    /// definition on the host side, so an empty title and body also count as `0`.
    fn legacy_flag(&self) -> i64 {
        let has_tiers = self.p1.as_deref().is_some_and(|tier| !tier.is_empty());
        if has_tiers || self.is_no_content() {
            0
        } else {
            1
        }
    }

    fn is_no_content(&self) -> bool {
        self.title.trim().is_empty() && self.content.trim().is_empty()
    }
}

/// A session fact row.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct HostSessionFact {
    pub category: String,
    pub content: String,
}

/// A historian-extracted event. `at_compartment` is a one-based index into this
/// publish's emitted compartments, resolved to a durable id at write time.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct HostCompartmentEvent {
    pub kind: String,
    pub at_compartment: Option<i64>,
    pub fields_json: String,
}

/// A project memory as the host's memory writer produces it.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct HostMemory {
    pub category: String,
    pub content: String,
    pub importance: Option<i64>,
    pub source_session_id: Option<String>,
    pub expires_at: Option<i64>,
    pub metadata_json: Option<String>,
}

/// A primer candidate.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct HostPrimerCandidate {
    pub question: String,
    pub source_compartment_start: Option<i64>,
    pub source_compartment_end: Option<i64>,
    pub source_start_message_id: String,
    pub source_end_message_id: String,
    pub source_message_time: i64,
    pub created_at: i64,
}

/// A privacy-gated user observation. Not a project memory: the host's review task owns
/// promotion into `user_memories`.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct HostUserObservation {
    pub content: String,
    pub source_compartment_start: Option<i64>,
    pub source_compartment_end: Option<i64>,
    pub created_at: i64,
}

/// A promoted stable user memory.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct HostUserMemory {
    pub content: String,
    pub source_candidate_ids: Vec<i64>,
}

/// A session note.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct HostNote {
    pub content: String,
    pub anchor_ordinal: Option<i64>,
}

/// Everything one fold publish writes into `context.db`.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct FoldPublish {
    pub session_id: String,
    pub project_path: String,
    /// The harness label the host would stamp on these rows. Carried explicitly rather
    /// than derived, because a row written by the module and a row written by the host
    /// for the same session must be indistinguishable.
    pub harness: String,
    pub now_ms: i64,
    pub compartments: Vec<HostCompartment>,
    pub facts: Vec<HostSessionFact>,
    pub events: Vec<HostCompartmentEvent>,
    pub memories: Vec<HostMemory>,
    pub notes: Vec<HostNote>,
    pub primer_candidates: Vec<HostPrimerCandidate>,
    pub user_observations: Vec<HostUserObservation>,
    pub user_memories: Vec<HostUserMemory>,
    /// The privacy gate. With collection off, observations are dropped before the
    /// transaction rather than written and filtered later.
    pub user_memory_collection_enabled: bool,
}

impl FoldPublish {
    /// Rows that can become visible before the fold does.
    ///
    /// A memory, a note, a primer candidate and a user observation each stand on their
    /// own: none of them is read as part of a session's compartment history, so a reader
    /// that sees one mid-fold sees a complete row, not half a fold.
    pub fn staged_row_count(&self) -> usize {
        self.memories.len()
            + self.notes.len()
            + self.primer_candidates.len()
            + if self.user_memory_collection_enabled {
                self.user_observations.len()
            } else {
                0
            }
            + self.user_memories.len()
    }
}

/// What one publish did, per chunk.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PublishOutcome {
    /// Rows written per chunk, oldest first. The last entry is the visibility chunk.
    pub chunk_rows: Vec<usize>,
    /// Wall-clock microseconds each chunk's transaction held, in the same order.
    pub chunk_durations_us: Vec<i64>,
    /// Durable ids of the compartments this publish appended, in emission order.
    pub compartment_ids: Vec<i64>,
    /// Durable ids of the memories this publish appended.
    pub memory_ids: Vec<i64>,
    /// The project's embedding high-water mark after this publish.
    pub embedding_watermark: i64,
}

impl PublishOutcome {
    pub fn total_rows(&self) -> usize {
        self.chunk_rows.iter().sum()
    }

    pub fn max_chunk_duration_us(&self) -> i64 {
        self.chunk_durations_us.iter().copied().max().unwrap_or(0)
    }
}

// ── The store ───────────────────────────────────────────────────────────────

/// An open handle on the host's `context.db`.
pub struct HostStore {
    conn: Connection,
    path: PathBuf,
    fence: FenceState,
    chunk_budget: usize,
}

impl HostStore {
    /// Open `context.db` read/write against this binary's fence.
    pub fn open(path: &Path) -> Result<Self, HostStoreError> {
        Self::open_with_fence(path, BUILT_CONTEXT_FENCE_VERSION)
    }

    /// Open against an explicit built fence.
    ///
    /// Tests use this to stand a database one lane ahead of the binary without shipping
    /// a migration; production always goes through [`HostStore::open`].
    pub fn open_with_fence(path: &Path, built_version: i64) -> Result<Self, HostStoreError> {
        let conn = Connection::open(path).map_err(|error| HostStoreError::OpenFailed {
            path: path.display().to_string(),
            reason: error.to_string(),
        })?;
        // WAL because every other writer on this file uses it, and a journal-mode change
        // would be a file-level side effect on a database this module does not own.
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| HostStoreError::OpenFailed {
                path: path.display().to_string(),
                reason: format!("could not confirm WAL journaling: {error}"),
            })?;
        conn.busy_timeout(std::time::Duration::from_millis(u64::from(
            CONTEXT_BUSY_TIMEOUT_MS,
        )))
        .map_err(|error| HostStoreError::OpenFailed {
            path: path.display().to_string(),
            reason: format!("could not set busy_timeout: {error}"),
        })?;
        // The host declares ON DELETE CASCADE on several tables that reference domain
        // rows, and SQLite defaults this OFF per connection. A module connection with it
        // off would leave orphans the host's own writes never leave.
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|error| HostStoreError::OpenFailed {
                path: path.display().to_string(),
                reason: format!("could not enable foreign_keys: {error}"),
            })?;

        let fence = FenceState::read(&conn, path, built_version)?;
        Ok(HostStore {
            conn,
            path: path.to_path_buf(),
            fence,
            chunk_budget: DEFAULT_PUBLISH_CHUNK_ROWS,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn fence(&self) -> &FenceState {
        &self.fence
    }

    /// Override the per-chunk row budget. Tests drive the chunker with a small budget so
    /// a two-compartment fixture still produces several chunks.
    pub fn set_chunk_budget(&mut self, rows: usize) {
        self.chunk_budget = rows.max(1);
    }

    pub fn chunk_budget(&self) -> usize {
        self.chunk_budget
    }

    /// Refuse every write when the lane is ahead; otherwise report which domain tables
    /// this binary may write.
    pub fn writable_tables(&self) -> Result<Vec<&'static str>, HostStoreError> {
        self.fence.check_lane()?;
        Ok(DOMAIN_TABLES
            .iter()
            .copied()
            .filter(|table| self.fence.check_table(table).is_ok())
            .collect())
    }

    /// The health block the status surface reports.
    pub fn health_value(&self, mode: SingleStoreMode) -> Value {
        let mut tables = serde_json::Map::new();
        for table in DOMAIN_TABLES {
            let state = match self.fence.check_table(table) {
                Ok(()) => json!({ "writable": true }),
                Err(error) => json!({
                    "writable": false,
                    "error_code": error.code(),
                    "detail": error.to_string(),
                }),
            };
            tables.insert((*table).to_string(), state);
        }
        json!({
            "capable": SINGLE_STORE_CAPABLE,
            "mode": mode.as_str(),
            "path": self.path.display().to_string(),
            "fence": {
                "persisted_version": self.fence.persisted_version,
                "built_version": self.fence.built_version,
                "lane_ok": self.fence.check_lane().is_ok(),
            },
            "tables": Value::Object(tables),
        })
    }

    /// Health for a module that could not open the file, or was never asked to.
    pub fn unavailable_health_value(
        mode: SingleStoreMode,
        error: Option<&HostStoreError>,
    ) -> Value {
        json!({
            "capable": SINGLE_STORE_CAPABLE,
            "mode": mode.as_str(),
            "path": Value::Null,
            "fence": Value::Null,
            "tables": Value::Null,
            "error_code": error.map(HostStoreError::code),
            "detail": error.map(ToString::to_string),
        })
    }
}

// ── The privileged write bracket ────────────────────────────────────────────

/// Take the privileged-writer bracket, run `writes`, and drop it again, all inside one
/// `BEGIN IMMEDIATE` transaction.
///
/// The bracket is a durable row rather than a connection-local function on purpose:
/// triggers are stored in the file and re-evaluated on every connection that opens it, so
/// a guard that called a registered function would fail with "no such function" on any
/// connection that had not registered one. A row is ordinary schema every connection can
/// read.
///
/// Its safety rests entirely on transaction isolation: the row is set and cleared by one
/// writer inside one transaction, so no other connection ever reads it as 1. A panic or
/// an error rolls the transaction back, which also rolls back the flip — the row cannot
/// be left armed by a crash mid-write.
fn with_privileged_transaction<T>(
    conn: &mut Connection,
    fence: &FenceState,
    tables: &[&str],
    writes: impl FnOnce(&Transaction<'_>) -> Result<T, HostStoreError>,
) -> Result<(T, i64), HostStoreError> {
    let started_at = Instant::now();
    let transaction = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    // Recheck inside the transaction, not only at open. A host migration can land
    // between opening the file and writing to it, and a stale open-time answer would let
    // this write land on a schema nobody checked.
    let live_fence = FenceState::read(&transaction, Path::new("context.db"), fence.built_version)?;
    for table in tables {
        live_fence.check_table(table)?;
    }

    transaction.execute(
        "INSERT INTO context_privilege_state(id, enabled) VALUES (1, 1)
         ON CONFLICT(id) DO UPDATE SET enabled = 1",
        [],
    )?;
    let armed: i64 = transaction
        .query_row(
            "SELECT enabled FROM context_privilege_state WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|error| HostStoreError::PrivilegeFlipFailed {
            reason: error.to_string(),
        })?;
    if armed != 1 {
        return Err(HostStoreError::PrivilegeFlipFailed {
            reason: format!("privilege row read back as {armed} after being set to 1"),
        });
    }

    let result = writes(&transaction)?;

    transaction.execute(
        "UPDATE context_privilege_state SET enabled = 0 WHERE id = 1",
        [],
    )?;
    transaction.commit()?;
    let elapsed_us = i64::try_from(started_at.elapsed().as_micros()).unwrap_or(i64::MAX);
    Ok((result, elapsed_us))
}

// ── Domain writers ──────────────────────────────────────────────────────────

/// Normalize memory content and hash it the way the host does.
///
/// Dedup depends on `UNIQUE(project_path, category, normalized_hash)`, so a module row
/// whose hash was computed differently would sit beside the host's row instead of
/// colliding with it.
pub fn compute_normalized_hash(content: &str) -> String {
    mc_store::compute_normalized_memory_hash(content)
}

fn insert_compartments(
    tx: &Transaction<'_>,
    publish: &FoldPublish,
) -> Result<Vec<i64>, HostStoreError> {
    let mut ids = Vec::with_capacity(publish.compartments.len());
    let mut statement = tx.prepare(
        "INSERT INTO compartments
           (session_id, sequence, start_message, end_message, start_message_id, end_message_id,
            title, content, p1, p2, p3, p4, importance, episode_type, legacy, created_at, harness)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
    )?;
    for compartment in &publish.compartments {
        statement.execute(params![
            publish.session_id,
            compartment.sequence,
            compartment.start_message,
            compartment.end_message,
            compartment.start_message_id,
            compartment.end_message_id,
            compartment.title,
            compartment.content,
            compartment.p1,
            compartment.p2,
            compartment.p3,
            compartment.p4,
            compartment.importance.unwrap_or(50),
            compartment.episode_type,
            compartment.legacy_flag(),
            compartment.created_at,
            publish.harness,
        ])?;
        ids.push(tx.last_insert_rowid());
    }
    Ok(ids)
}

/// Replace the session's facts.
///
/// The historian rewrites the full fact list on every pass, so the host replaces rather
/// than appends; appending would accumulate every earlier pass's facts.
fn replace_session_facts(
    tx: &Transaction<'_>,
    publish: &FoldPublish,
) -> Result<(), HostStoreError> {
    tx.execute(
        "DELETE FROM session_facts WHERE session_id = ?1",
        params![publish.session_id],
    )?;
    let mut statement = tx.prepare(
        "INSERT INTO session_facts (session_id, category, content, created_at, updated_at, harness)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
    )?;
    for fact in &publish.facts {
        statement.execute(params![
            publish.session_id,
            fact.category,
            fact.content,
            publish.now_ms,
            publish.harness,
        ])?;
    }
    Ok(())
}

fn insert_compartment_events(
    tx: &Transaction<'_>,
    publish: &FoldPublish,
    compartment_ids: &[i64],
) -> Result<(), HostStoreError> {
    if publish.events.is_empty() {
        return Ok(());
    }
    let mut statement = tx.prepare(
        "INSERT INTO compartment_events
           (session_id, compartment_id, kind, at_compartment, fields_json, created_at, harness)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    for event in &publish.events {
        // at_compartment is one-based into this publish's emitted list. An index outside
        // it (an event anchored to a compartment the validator discarded) keeps the raw
        // anchor and stores no durable id, rather than pointing at the wrong row.
        let resolved = event
            .at_compartment
            .filter(|index| *index >= 1)
            .and_then(|index| usize::try_from(index - 1).ok())
            .and_then(|index| compartment_ids.get(index).copied());
        statement.execute(params![
            publish.session_id,
            resolved,
            event.kind,
            event.at_compartment,
            event.fields_json,
            publish.now_ms,
            publish.harness,
        ])?;
    }
    Ok(())
}

/// Append project memories.
///
/// The column list and every default here mirrors the host's memory writer exactly,
/// because a memory row is compared column-for-column between the two writers. The FTS
/// index is maintained by triggers on this table, so the insert keeps it correct without
/// this code knowing the index exists.
fn insert_memories(
    tx: &Transaction<'_>,
    publish: &FoldPublish,
) -> Result<Vec<i64>, HostStoreError> {
    let mut ids = Vec::with_capacity(publish.memories.len());
    let mut existing = tx.prepare(
        "SELECT id FROM memories
          WHERE project_path = ?1 AND status IN ('active', 'permanent') AND content = ?2",
    )?;
    let mut bump_seen = tx.prepare(
        "UPDATE memories SET seen_count = seen_count + 1, last_seen_at = ?1, updated_at = ?1
          WHERE id = ?2",
    )?;
    let mut statement = tx.prepare(
        "INSERT INTO memories
           (project_path, category, content, normalized_hash, importance, source_session_id,
            source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at,
            last_seen_at, last_retrieved_at, status, expires_at, verification_status,
            verified_at, superseded_by_memory_id, merged_from, metadata_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'historian', 1, 0, ?7, ?7, ?7, ?7, NULL, 'active',
                 ?8, 'unverified', NULL, NULL, NULL, ?9)",
    )?;
    for memory in &publish.memories {
        // A fact whose exact text is already a live memory for this project is seen again,
        // not learned again. This is the same durable de-duplication the module's own
        // publish performs, and it is what keeps a re-run of the same fold from either
        // duplicating a memory or aborting the whole chunk on the dedup constraint.
        if let Some(id) = existing
            .query_row(params![publish.project_path, memory.content], |row| {
                row.get::<_, i64>(0)
            })
            .optional()?
        {
            bump_seen.execute(params![publish.now_ms, id])?;
            continue;
        }
        statement.execute(params![
            publish.project_path,
            memory.category,
            memory.content,
            compute_normalized_hash(&memory.content),
            memory.importance.unwrap_or(50),
            memory.source_session_id,
            publish.now_ms,
            memory.expires_at,
            memory.metadata_json,
        ])?;
        ids.push(tx.last_insert_rowid());
    }
    Ok(ids)
}

fn insert_notes(tx: &Transaction<'_>, publish: &FoldPublish) -> Result<(), HostStoreError> {
    if publish.notes.is_empty() {
        return Ok(());
    }
    let mut statement = tx.prepare(
        "INSERT INTO notes (type, status, content, session_id, created_at, updated_at, harness, anchor_ordinal)
         VALUES ('session', 'active', ?1, ?2, ?3, ?3, ?4, ?5)",
    )?;
    for note in &publish.notes {
        statement.execute(params![
            note.content,
            publish.session_id,
            publish.now_ms,
            publish.harness,
            note.anchor_ordinal,
        ])?;
    }
    Ok(())
}

/// Collapse a primer question the way the host does before storing it.
///
/// The normalized form is what two askings of the same question are matched on, so it has
/// to be the host's exact form and not merely a reasonable one: curly quotes fold to
/// straight ones, whitespace collapses, and trailing question marks, periods and
/// exclamation marks come off, so "How does the fence work?" and "how does the fence
/// work" are one question rather than two.
///
/// The module's own store normalizes only case and whitespace. That difference is real
/// and predates this code; the writer here follows the host because these rows are the
/// host's table.
fn normalize_primer_question(question: &str) -> String {
    let folded = question
        .trim()
        .to_lowercase()
        .replace(['\u{201c}', '\u{201d}'], "\"")
        .replace('\u{2019}', "'");
    let collapsed = folded.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .trim_end_matches(['?', '.', '!'])
        .trim()
        .to_string()
}

fn insert_primer_candidates(
    tx: &Transaction<'_>,
    publish: &FoldPublish,
) -> Result<(), HostStoreError> {
    if publish.primer_candidates.is_empty() {
        return Ok(());
    }
    let mut statement = tx.prepare(
        "INSERT INTO primer_candidates
           (project_path, harness, session_id, question, normalized_question,
            source_compartment_start, source_compartment_end,
            source_start_message_id, source_end_message_id, source_message_time,
            question_embedding, question_embedding_model_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL, ?11)
         ON CONFLICT(project_path, harness, session_id,
                     source_start_message_id, source_end_message_id)
         DO UPDATE SET
             question = excluded.question,
             normalized_question = excluded.normalized_question,
             source_compartment_start = excluded.source_compartment_start,
             source_compartment_end = excluded.source_compartment_end,
             source_message_time = excluded.source_message_time,
             question_embedding = COALESCE(excluded.question_embedding, primer_candidates.question_embedding),
             question_embedding_model_id = COALESCE(excluded.question_embedding_model_id, primer_candidates.question_embedding_model_id),
             created_at = MIN(primer_candidates.created_at, excluded.created_at)",
    )?;
    for candidate in &publish.primer_candidates {
        let question = candidate.question.trim();
        if question.is_empty() {
            continue;
        }
        statement.execute(params![
            publish.project_path,
            publish.harness,
            publish.session_id,
            question,
            normalize_primer_question(question),
            candidate.source_compartment_start,
            candidate.source_compartment_end,
            candidate.source_start_message_id,
            candidate.source_end_message_id,
            candidate.source_message_time,
            candidate.created_at,
        ])?;
    }
    Ok(())
}

/// Append user observations, but only when the user has opted into collection.
///
/// The gate is applied before the statement rather than after the write, so a project
/// with collection off leaves no observation row behind to be filtered by a later reader.
fn insert_user_observations(
    tx: &Transaction<'_>,
    publish: &FoldPublish,
) -> Result<(), HostStoreError> {
    if !publish.user_memory_collection_enabled || publish.user_observations.is_empty() {
        return Ok(());
    }
    let mut statement = tx.prepare(
        "INSERT INTO user_memory_candidates
           (content, session_id, source_compartment_start, source_compartment_end, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for observation in &publish.user_observations {
        let content = observation.content.trim();
        if content.is_empty() {
            continue;
        }
        statement.execute(params![
            content,
            publish.session_id,
            observation.source_compartment_start,
            observation.source_compartment_end,
            observation.created_at,
        ])?;
    }
    Ok(())
}

/// Record the provenance of each promoted user memory from the candidates it came from,
/// the same join the host performs before it writes the row.
fn user_memory_provenance(
    tx: &Transaction<'_>,
    candidate_ids: &[i64],
) -> Result<Option<String>, HostStoreError> {
    let mut sorted = candidate_ids.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    if sorted.is_empty() {
        return Ok(None);
    }
    let mut rows = Vec::new();
    let mut statement = tx.prepare(
        "SELECT id, session_id, source_compartment_start, source_compartment_end
           FROM user_memory_candidates WHERE id = ?1",
    )?;
    for id in &sorted {
        let row = statement
            .query_row(params![id], |row| {
                Ok(json!({
                    "candidate_id": row.get::<_, i64>(0)?,
                    "session_id": row.get::<_, String>(1)?,
                    "source_compartment_start": row.get::<_, Option<i64>>(2)?,
                    "source_compartment_end": row.get::<_, Option<i64>>(3)?,
                }))
            })
            .optional()?;
        if let Some(row) = row {
            rows.push(row);
        }
    }
    // The host writes NULL rather than an empty array when it was given candidate ids but
    // found none of them, so "no provenance recorded" stays distinguishable from
    // "promoted with no candidates".
    if rows.is_empty() {
        return Ok(None);
    }
    Ok(Some(Value::Array(rows).to_string()))
}

fn insert_user_memories(tx: &Transaction<'_>, publish: &FoldPublish) -> Result<(), HostStoreError> {
    if publish.user_memories.is_empty() {
        return Ok(());
    }
    let mut statement = tx.prepare(
        "INSERT INTO user_memories
           (content, status, promoted_at, source_candidate_ids, source_candidate_provenance,
            created_at, updated_at)
         VALUES (?1, 'active', ?2, ?3, ?4, ?2, ?2)",
    )?;
    for memory in &publish.user_memories {
        let provenance = user_memory_provenance(tx, &memory.source_candidate_ids)?;
        let candidate_ids = Value::Array(
            memory
                .source_candidate_ids
                .iter()
                .map(|id| json!(id))
                .collect(),
        )
        .to_string();
        statement.execute(params![
            memory.content,
            publish.now_ms,
            candidate_ids,
            provenance,
        ])?;
    }
    Ok(())
}

// ── Embedding watermark ─────────────────────────────────────────────────────

/// Raise the project's written high-water mark to `memory_id`.
///
/// Vectors are computed by host code with a hash-guarded save, not by a database trigger,
/// so a memory row this module inserts arrives unembedded and nothing asks for one. The
/// mark is what asks: the host's backfill drains every memory above `embedded_memory_id`
/// up to `written_memory_id`. A per-project mark rather than a per-row column keeps the
/// memories table byte-identical between the two writers.
fn raise_embedding_watermark(
    tx: &Transaction<'_>,
    project_path: &str,
    memory_id: i64,
    now_ms: i64,
) -> Result<i64, HostStoreError> {
    tx.execute(
        "INSERT INTO memory_embedding_watermarks
           (project_path, written_memory_id, embedded_memory_id, updated_at)
         VALUES (?1, ?2, 0, ?3)
         ON CONFLICT(project_path) DO UPDATE SET
             written_memory_id = MAX(memory_embedding_watermarks.written_memory_id, excluded.written_memory_id),
             updated_at = excluded.updated_at",
        params![project_path, memory_id, now_ms],
    )?;
    let written: i64 = tx.query_row(
        "SELECT written_memory_id FROM memory_embedding_watermarks WHERE project_path = ?1",
        params![project_path],
        |row| row.get(0),
    )?;
    Ok(written)
}

/// Read a project's embedding watermark, if one has been recorded.
pub fn read_embedding_watermark(
    conn: &Connection,
    project_path: &str,
) -> Result<Option<(i64, i64)>, HostStoreError> {
    Ok(conn
        .query_row(
            "SELECT written_memory_id, embedded_memory_id
               FROM memory_embedding_watermarks WHERE project_path = ?1",
            params![project_path],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?)
}

// ── Chunked publish ─────────────────────────────────────────────────────────

/// One chunk's worth of work, as a slice of the publish.
enum Chunk<'a> {
    /// Rows that stand on their own and may become visible before the fold does.
    Staged {
        memories: &'a [HostMemory],
        notes: &'a [HostNote],
        primer_candidates: &'a [HostPrimerCandidate],
        user_observations: &'a [HostUserObservation],
        user_memories: &'a [HostUserMemory],
    },
    /// The compartments, their facts and their events. Committing this chunk is what
    /// makes the fold visible.
    Visibility,
}

impl Chunk<'_> {
    fn rows(&self, publish: &FoldPublish) -> usize {
        match self {
            Chunk::Staged {
                memories,
                notes,
                primer_candidates,
                user_observations,
                user_memories,
            } => {
                memories.len()
                    + notes.len()
                    + primer_candidates.len()
                    + user_observations.len()
                    + user_memories.len()
            }
            // The facts delete counts as one row of work whether or not any facts follow
            // it, so an all-facts-removed pass is not scored as free.
            Chunk::Visibility => {
                publish.compartments.len() + publish.facts.len() + publish.events.len() + 1
            }
        }
    }

    fn tables(&self) -> &'static [&'static str] {
        match self {
            Chunk::Staged { .. } => &[
                "memories",
                "memory_embedding_watermarks",
                "notes",
                "primer_candidates",
                "user_memories",
                "user_memory_candidates",
            ],
            Chunk::Visibility => &["compartments", "compartment_events", "session_facts"],
        }
    }
}

/// Split a publish into chunks under the row budget.
///
/// The ordering is the visibility invariant, not an optimization: everything that can be
/// read without a compartment goes first, in bounded pieces, and the compartments, facts
/// and events go last, together, in one transaction. A reader arriving between two chunks
/// sees the session's compartment history exactly as it was before the fold began.
fn plan_chunks(publish: &FoldPublish, budget: usize) -> Vec<Chunk<'_>> {
    let budget = budget.max(1);
    let mut chunks = Vec::new();
    let observations: &[HostUserObservation] = if publish.user_memory_collection_enabled {
        &publish.user_observations
    } else {
        &[]
    };

    let mut memories = publish.memories.as_slice();
    let mut notes = publish.notes.as_slice();
    let mut primers = publish.primer_candidates.as_slice();
    let mut observations = observations;
    let mut user_memories = publish.user_memories.as_slice();

    while !memories.is_empty()
        || !notes.is_empty()
        || !primers.is_empty()
        || !observations.is_empty()
        || !user_memories.is_empty()
    {
        let mut remaining = budget;
        let take_memories = remaining.min(memories.len());
        remaining -= take_memories;
        let take_notes = remaining.min(notes.len());
        remaining -= take_notes;
        let take_primers = remaining.min(primers.len());
        remaining -= take_primers;
        let take_observations = remaining.min(observations.len());
        remaining -= take_observations;
        let take_user_memories = remaining.min(user_memories.len());

        let (memory_chunk, memory_rest) = memories.split_at(take_memories);
        let (note_chunk, note_rest) = notes.split_at(take_notes);
        let (primer_chunk, primer_rest) = primers.split_at(take_primers);
        let (observation_chunk, observation_rest) = observations.split_at(take_observations);
        let (user_memory_chunk, user_memory_rest) = user_memories.split_at(take_user_memories);

        memories = memory_rest;
        notes = note_rest;
        primers = primer_rest;
        observations = observation_rest;
        user_memories = user_memory_rest;

        chunks.push(Chunk::Staged {
            memories: memory_chunk,
            notes: note_chunk,
            primer_candidates: primer_chunk,
            user_observations: observation_chunk,
            user_memories: user_memory_chunk,
        });
    }

    chunks.push(Chunk::Visibility);
    chunks
}

impl HostStore {
    /// Write one fold publish into `context.db` as a sequence of bounded transactions.
    ///
    /// Each chunk takes the privileged-writer bracket itself, because the bracket has to
    /// live inside the transaction it protects: a flip held across chunk boundaries would
    /// be a window in which the guards are disarmed for every writer on the file.
    pub fn publish_fold(
        &mut self,
        publish: &FoldPublish,
    ) -> Result<PublishOutcome, HostStoreError> {
        self.fence.check_lane()?;
        let budget = self.chunk_budget;
        let mut outcome = PublishOutcome::default();

        for chunk in plan_chunks(publish, budget) {
            let rows = chunk.rows(publish);
            if matches!(chunk, Chunk::Staged { .. }) && rows > budget {
                return Err(HostStoreError::ChunkBudgetExceeded { rows, budget });
            }
            let fence = self.fence.clone();
            let tables = chunk.tables();
            let (chunk_result, elapsed_us) =
                with_privileged_transaction(&mut self.conn, &fence, tables, |tx| {
                    apply_chunk(tx, publish, &chunk, &outcome)
                })?;
            outcome.chunk_rows.push(rows);
            outcome.chunk_durations_us.push(elapsed_us);
            outcome.memory_ids.extend(chunk_result.memory_ids);
            if let Some(watermark) = chunk_result.embedding_watermark {
                outcome.embedding_watermark = watermark;
            }
            outcome.compartment_ids.extend(chunk_result.compartment_ids);
        }
        Ok(outcome)
    }
}

#[derive(Default)]
struct ChunkResult {
    memory_ids: Vec<i64>,
    compartment_ids: Vec<i64>,
    embedding_watermark: Option<i64>,
}

fn apply_chunk(
    tx: &Transaction<'_>,
    publish: &FoldPublish,
    chunk: &Chunk<'_>,
    so_far: &PublishOutcome,
) -> Result<ChunkResult, HostStoreError> {
    let mut result = ChunkResult::default();
    match chunk {
        Chunk::Staged {
            memories,
            notes,
            primer_candidates,
            user_observations,
            user_memories,
        } => {
            let slice = FoldPublish {
                session_id: publish.session_id.clone(),
                project_path: publish.project_path.clone(),
                harness: publish.harness.clone(),
                now_ms: publish.now_ms,
                compartments: Vec::new(),
                facts: Vec::new(),
                events: Vec::new(),
                memories: memories.to_vec(),
                notes: notes.to_vec(),
                primer_candidates: primer_candidates.to_vec(),
                user_observations: user_observations.to_vec(),
                user_memories: user_memories.to_vec(),
                user_memory_collection_enabled: publish.user_memory_collection_enabled,
            };
            result.memory_ids = insert_memories(tx, &slice)?;
            insert_notes(tx, &slice)?;
            insert_primer_candidates(tx, &slice)?;
            insert_user_observations(tx, &slice)?;
            insert_user_memories(tx, &slice)?;
            // The mark moves in the same transaction as the rows it describes, so the
            // host's backfill can never see a mark pointing past a row that is not there.
            if let Some(highest) = result.memory_ids.iter().copied().max() {
                result.embedding_watermark = Some(raise_embedding_watermark(
                    tx,
                    &publish.project_path,
                    highest,
                    publish.now_ms,
                )?);
            }
        }
        Chunk::Visibility => {
            replace_session_facts(tx, publish)?;
            result.compartment_ids = insert_compartments(tx, publish)?;
            insert_compartment_events(tx, publish, &result.compartment_ids)?;
            let _ = so_far;
        }
    }
    Ok(result)
}

// ── Shadow verification ─────────────────────────────────────────────────────

/// One column that differs between the rows the module produced and the rows already in
/// `context.db` for the same publish.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShadowDivergence {
    pub table: String,
    /// The natural key of the row, so a report names which row diverged.
    pub key: String,
    pub column: String,
    /// What `context.db` holds. `None` means the mirror has no such row at all.
    pub mirror: Option<String>,
    /// What the module's writer produced.
    pub module: Option<String>,
}

/// The outcome of one shadow publish.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ShadowReport {
    pub scratch_path: String,
    pub divergences: Vec<ShadowDivergence>,
    pub chunk_rows: Vec<usize>,
    pub chunk_durations_us: Vec<i64>,
}

impl ShadowReport {
    /// A one-line summary for the log, naming the tables and columns that diverged rather
    /// than only counting them.
    pub fn summary(&self) -> String {
        if self.divergences.is_empty() {
            return format!(
                "single_store shadow: {} chunks, no divergence",
                self.chunk_rows.len()
            );
        }
        let mut by_table: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for divergence in &self.divergences {
            by_table
                .entry(divergence.table.as_str())
                .or_default()
                .push(divergence.column.as_str());
        }
        let detail = by_table
            .into_iter()
            .map(|(table, mut columns)| {
                columns.sort_unstable();
                columns.dedup();
                format!("{table}({})", columns.join(","))
            })
            .collect::<Vec<_>>()
            .join(" ");
        format!(
            "single_store shadow: {} chunks, {} diverging column(s): {detail}",
            self.chunk_rows.len(),
            self.divergences.len()
        )
    }
}

/// Columns compared per table. Autoincrement ids are excluded: two writers appending to
/// the same table pick different ids by construction, and comparing them would report a
/// divergence on every row while hiding the content ones.
fn shadow_compare_columns(table: &str) -> &'static [&'static str] {
    match table {
        "compartments" => &[
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
        ],
        "session_facts" => &["category", "content", "created_at", "updated_at", "harness"],
        "compartment_events" => &["kind", "at_compartment", "fields_json", "harness"],
        "memories" => &[
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
            "status",
            "expires_at",
            "verification_status",
            "metadata_json",
        ],
        "primer_candidates" => &[
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
        ],
        "user_memory_candidates" => &[
            "content",
            "session_id",
            "source_compartment_start",
            "source_compartment_end",
        ],
        "user_memories" => &["content", "status", "source_candidate_ids"],
        "notes" => &["type", "status", "content", "session_id", "harness"],
        _ => &[],
    }
}

/// The natural key a row is matched on across the two databases.
fn shadow_key_columns(table: &str) -> &'static [&'static str] {
    match table {
        "compartments" => &["session_id", "sequence"],
        "session_facts" => &["session_id", "category", "content"],
        "compartment_events" => &["session_id", "kind", "at_compartment"],
        "memories" => &["project_path", "category", "content"],
        "primer_candidates" => &["project_path", "session_id", "source_start_message_id"],
        "user_memory_candidates" => &["session_id", "content"],
        "user_memories" => &["content"],
        "notes" => &["session_id", "content"],
        _ => &[],
    }
}

fn read_rows(
    conn: &Connection,
    table: &str,
    scope_column: &str,
    scope_value: &str,
) -> Result<BTreeMap<String, BTreeMap<String, Option<String>>>, HostStoreError> {
    let keys = shadow_key_columns(table);
    let columns = shadow_compare_columns(table);
    if keys.is_empty() || columns.is_empty() {
        return Ok(BTreeMap::new());
    }
    let mut selected: Vec<&str> = keys.to_vec();
    for column in columns {
        if !selected.contains(column) {
            selected.push(column);
        }
    }
    let sql = format!(
        "SELECT {} FROM {table} WHERE {scope_column} = ?1",
        selected.join(", ")
    );
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query(params![scope_value])?;
    let mut out = BTreeMap::new();
    while let Some(row) = rows.next()? {
        let mut values = BTreeMap::new();
        for (index, column) in selected.iter().enumerate() {
            let value: Option<String> = row.get::<_, Option<String>>(index).or_else(|_| {
                row.get::<_, Option<i64>>(index)
                    .map(|value| value.map(|value| value.to_string()))
            })?;
            values.insert((*column).to_string(), value);
        }
        let key = keys
            .iter()
            .map(|column| {
                values
                    .get(*column)
                    .cloned()
                    .flatten()
                    .unwrap_or_else(|| "\u{0}".to_string())
            })
            .collect::<Vec<_>>()
            .join("\u{1f}");
        out.insert(key, values);
    }
    Ok(out)
}

/// The table's scope column and the publish value that scopes it.
fn shadow_scope<'a>(table: &str, publish: &'a FoldPublish) -> (&'static str, &'a str) {
    match table {
        "memories" | "primer_candidates" => ("project_path", publish.project_path.as_str()),
        "user_memories" => ("status", "active"),
        _ => ("session_id", publish.session_id.as_str()),
    }
}

impl HostStore {
    /// Remove the rows this publish would produce, so the writers run against the state
    /// that existed before the fold.
    ///
    /// Only ever called on a scratch copy. The point of shadow verification is to compare
    /// the module's rows against the mirror's rows for the same publish, and that needs
    /// both writers to start from the same place: without this, a fold the mirror had
    /// already drained would meet its own rows on the way in. The deletes are keyed the
    /// same way the comparison is, which is deliberately blunt — a scratch file is thrown
    /// away, so over-deleting there costs nothing and under-deleting would silently
    /// weaken the comparison.
    fn rewind_publish_scope(&mut self, publish: &FoldPublish) -> Result<(), HostStoreError> {
        let fence = self.fence.clone();
        let tables: Vec<&str> = DOMAIN_TABLES.to_vec();
        let (_, _) = with_privileged_transaction(&mut self.conn, &fence, &tables, |tx| {
            tx.execute(
                "DELETE FROM compartment_events WHERE session_id = ?1",
                params![publish.session_id],
            )?;
            tx.execute(
                "DELETE FROM session_facts WHERE session_id = ?1",
                params![publish.session_id],
            )?;
            for compartment in &publish.compartments {
                tx.execute(
                    "DELETE FROM compartments WHERE session_id = ?1 AND sequence = ?2",
                    params![publish.session_id, compartment.sequence],
                )?;
            }
            for memory in &publish.memories {
                tx.execute(
                    "DELETE FROM memories WHERE project_path = ?1 AND content = ?2",
                    params![publish.project_path, memory.content],
                )?;
            }
            for note in &publish.notes {
                tx.execute(
                    "DELETE FROM notes WHERE session_id = ?1 AND content = ?2",
                    params![publish.session_id, note.content],
                )?;
            }
            for candidate in &publish.primer_candidates {
                tx.execute(
                    "DELETE FROM primer_candidates
                      WHERE project_path = ?1 AND harness = ?2 AND session_id = ?3
                        AND source_start_message_id = ?4 AND source_end_message_id = ?5",
                    params![
                        publish.project_path,
                        publish.harness,
                        publish.session_id,
                        candidate.source_start_message_id,
                        candidate.source_end_message_id,
                    ],
                )?;
            }
            for observation in &publish.user_observations {
                tx.execute(
                    "DELETE FROM user_memory_candidates WHERE session_id = ?1 AND content = ?2",
                    params![publish.session_id, observation.content.trim()],
                )?;
            }
            for memory in &publish.user_memories {
                tx.execute(
                    "DELETE FROM user_memories WHERE content = ?1",
                    params![memory.content],
                )?;
            }
            Ok(())
        })?;
        Ok(())
    }

    /// Run the writers against a scratch copy of `context.db` and report how the rows
    /// they produce differ from the rows already there.
    ///
    /// `VACUUM INTO` rather than a file copy: it takes a consistent snapshot of a live
    /// WAL database from inside SQLite, so a seat writing concurrently cannot leave the
    /// scratch copy torn.
    pub fn shadow_publish(
        &mut self,
        publish: &FoldPublish,
        scratch_dir: &Path,
    ) -> Result<ShadowReport, HostStoreError> {
        self.fence.check_lane()?;
        std::fs::create_dir_all(scratch_dir).map_err(|error| HostStoreError::OpenFailed {
            path: scratch_dir.display().to_string(),
            reason: error.to_string(),
        })?;
        let scratch_path = scratch_dir.join(format!(
            "single-store-shadow-{}.db",
            publish
                .session_id
                .replace(|c: char| !c.is_alphanumeric(), "_")
        ));
        // VACUUM INTO refuses to overwrite, so a previous run's file is removed first.
        let _ = std::fs::remove_file(&scratch_path);
        let _ = std::fs::remove_file(scratch_path.with_extension("db-wal"));
        let _ = std::fs::remove_file(scratch_path.with_extension("db-shm"));
        self.conn
            .execute("VACUUM INTO ?1", params![scratch_path.to_string_lossy()])?;

        let mut scratch = HostStore::open_with_fence(&scratch_path, self.fence.built_version)?;
        scratch.set_chunk_budget(self.chunk_budget);
        scratch.rewind_publish_scope(publish)?;
        let outcome = scratch.publish_fold(publish)?;

        let mut divergences = Vec::new();
        for table in DOMAIN_TABLES {
            if shadow_key_columns(table).is_empty() {
                continue;
            }
            let (scope_column, scope_value) = shadow_scope(table, publish);
            let mirror = read_rows(&self.conn, table, scope_column, scope_value)?;
            let module = read_rows(&scratch.conn, table, scope_column, scope_value)?;
            for (key, module_row) in &module {
                let mirror_row = mirror.get(key);
                for column in shadow_compare_columns(table) {
                    let module_value = module_row.get(*column).cloned().flatten();
                    let mirror_value = mirror_row
                        .and_then(|row| row.get(*column).cloned())
                        .flatten();
                    let missing_row = mirror_row.is_none();
                    if missing_row || module_value != mirror_value {
                        divergences.push(ShadowDivergence {
                            table: (*table).to_string(),
                            key: key.clone(),
                            column: (*column).to_string(),
                            mirror: mirror_value,
                            module: module_value,
                        });
                    }
                }
            }
        }

        Ok(ShadowReport {
            scratch_path: scratch_path.display().to_string(),
            divergences,
            chunk_rows: outcome.chunk_rows,
            chunk_durations_us: outcome.chunk_durations_us,
        })
    }
}

// ── Mode gate ───────────────────────────────────────────────────────────────

/// The process-wide single-store mode.
///
/// A publish consults this on a path that runs for every fold, so the common answer —
/// `Off`, meaning "do nothing, the mirror still owns this" — has to cost one relaxed
/// atomic load and no allocation.
static SINGLE_STORE_MODE: AtomicU8 = AtomicU8::new(0);

/// Set the process-wide mode from resolved config.
pub fn set_mode(mode: SingleStoreMode) {
    SINGLE_STORE_MODE.store(mode.code(), Ordering::Relaxed);
}

pub fn mode() -> SingleStoreMode {
    SingleStoreMode::from_code(SINGLE_STORE_MODE.load(Ordering::Relaxed))
}

/// Check a requested mode before anything opens the file.
///
/// `on` is refused by name rather than silently downgraded to `shadow`: a project that
/// asked for real writes and got verification instead would look like it was working.
pub fn admit_mode(mode: SingleStoreMode) -> Result<SingleStoreMode, HostStoreError> {
    match mode {
        SingleStoreMode::On => Err(HostStoreError::ModeRefused { mode: "on" }),
        other => Ok(other),
    }
}

// ── Locating context.db ─────────────────────────────────────────────────

/// Where the host keeps `context.db`.
///
/// The resolution order is the host's own, in the host's own precedence, because the two
/// processes have to agree on one file: the test-isolation override first, so a test
/// process can never be pointed at a real database, then the explicit storage directory,
/// then `XDG_DATA_HOME`, then the platform default.
pub fn resolve_context_db_path() -> PathBuf {
    fn non_empty(name: &str) -> Option<String> {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    let storage_dir = if let Some(test_data_dir) = non_empty("MAGIC_CONTEXT_TEST_DATA_DIR") {
        // A per-test data home wins over the shared test root, matching the host, so two
        // isolated tests on one box do not converge on one file.
        match non_empty("XDG_DATA_HOME") {
            Some(data_home) if Path::new(&data_home) != Path::new(&test_data_dir) => {
                Path::new(&data_home)
                    .join("cortexkit")
                    .join("magic-context")
            }
            _ => Path::new(&test_data_dir)
                .join("cortexkit")
                .join("magic-context"),
        }
    } else if let Some(explicit) = non_empty("MAGIC_CONTEXT_STORAGE_DIR") {
        PathBuf::from(explicit)
    } else if let Some(data_home) = non_empty("XDG_DATA_HOME") {
        Path::new(&data_home)
            .join("cortexkit")
            .join("magic-context")
    } else {
        let home = non_empty("HOME").unwrap_or_else(|| ".".to_string());
        Path::new(&home)
            .join(".local")
            .join("share")
            .join("cortexkit")
            .join("magic-context")
    };
    storage_dir.join("context.db")
}

/// Where a shadow run puts its scratch copy: a temp directory, never beside the real
/// database, so a scratch file can never be mistaken for the host's own.
pub fn shadow_scratch_dir() -> PathBuf {
    std::env::temp_dir()
        .join("magic-context")
        .join("single-store-shadow")
}

// ── The shadow verification hook ───────────────────────────────────────

/// The last shadow outcome, for the status surface.
static LAST_SHADOW: std::sync::OnceLock<std::sync::Mutex<Option<String>>> =
    std::sync::OnceLock::new();

fn last_shadow_slot() -> &'static std::sync::Mutex<Option<String>> {
    LAST_SHADOW.get_or_init(|| std::sync::Mutex::new(None))
}

fn record_shadow_outcome(summary: String) {
    *last_shadow_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(summary);
}

/// What the last shadow publish reported, if one has run in this process.
pub fn last_shadow_summary() -> Option<String> {
    last_shadow_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// The refusal that made the resolved mode fall back to `off`, if any.
static MODE_REFUSAL: std::sync::OnceLock<std::sync::Mutex<Option<(String, &'static str)>>> =
    std::sync::OnceLock::new();

fn mode_refusal_slot() -> &'static std::sync::Mutex<Option<(String, &'static str)>> {
    MODE_REFUSAL.get_or_init(|| std::sync::Mutex::new(None))
}

/// Remember that a configured mode was refused, so the status surface can say why the
/// module is doing nothing instead of leaving the operator to guess.
pub fn record_mode_refusal(error: &HostStoreError) {
    *mode_refusal_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((error.to_string(), error.code()));
}

pub fn mode_refusal() -> Option<(String, &'static str)> {
    mode_refusal_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// The single-store block for `session.status`.
///
/// Reports capability, the resolved mode, and — when the mode asks the module to touch
/// `context.db` — what the fence and the per-table fingerprints found. In the default
/// `off` mode this opens nothing: the answer is that the module is not touching the file,
/// and opening it to say so would contradict the answer.
pub fn status_value() -> Value {
    let mode = mode();
    let refusal = mode_refusal();
    let mut block = match mode {
        SingleStoreMode::Off => json!({
            "capable": SINGLE_STORE_CAPABLE,
            "mode": mode.as_str(),
            "path": Value::Null,
            "fence": Value::Null,
            "tables": Value::Null,
        }),
        SingleStoreMode::Shadow | SingleStoreMode::On => {
            let path = resolve_context_db_path();
            match HostStore::open(&path) {
                Ok(store) => store.health_value(mode),
                Err(error) => HostStore::unavailable_health_value(mode, Some(&error)),
            }
        }
    };
    if let Some(object) = block.as_object_mut() {
        object.insert(
            "built_fence_version".to_string(),
            json!(BUILT_CONTEXT_FENCE_VERSION),
        );
        object.insert(
            "chunk_budget_rows".to_string(),
            json!(DEFAULT_PUBLISH_CHUNK_ROWS),
        );
        object.insert(
            "last_shadow".to_string(),
            match last_shadow_summary() {
                Some(summary) => json!(summary),
                None => Value::Null,
            },
        );
        if let Some((detail, code)) = refusal {
            object.insert("refused_mode_detail".to_string(), json!(detail));
            object.insert("refused_mode_code".to_string(), json!(code));
        }
    }
    block
}

/// Verify one fold publish against `context.db`, if the mode asks for it.
///
/// Returns `None` when single-store is off, which is the default and the only state this
/// slice ships enabled: the cost on that path is one relaxed atomic load. A failure here
/// is recorded and swallowed, never propagated — verification must not be able to fail a
/// publish that already succeeded in the module's own store.
pub fn verify_publish_in_shadow(publish: &FoldPublish) -> Option<ShadowReport> {
    if mode() != SingleStoreMode::Shadow {
        return None;
    }
    let path = resolve_context_db_path();
    if !path.exists() {
        record_shadow_outcome(format!(
            "single_store shadow: no context.db at {}",
            path.display()
        ));
        return None;
    }
    let report = HostStore::open(&path)
        .and_then(|mut store| store.shadow_publish(publish, &shadow_scratch_dir()));
    match report {
        Ok(report) => {
            record_shadow_outcome(report.summary());
            Some(report)
        }
        Err(error) => {
            record_shadow_outcome(format!(
                "single_store shadow refused ({}): {error}",
                error.code()
            ));
            None
        }
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// The committed `context.db` schema this binary is fingerprinted against.
    /// Regenerated by `bun scripts/dump-context-db-schema.ts`.
    const SCHEMA_SNAPSHOT: &str = include_str!("../tests/fixtures/context-db-schema.sql");

    fn fixture_db(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        let conn = Connection::open(&path).expect("open fixture");
        conn.execute_batch(SCHEMA_SNAPSHOT).expect("apply schema");
        conn.execute(
            "INSERT OR IGNORE INTO context_privilege_state(id, enabled) VALUES (1, 0)",
            [],
        )
        .expect("seed privilege row");
        path
    }

    /// Mark the project managed so the authority guards are live for these writes. A
    /// fixture without this marker would let every write through and prove nothing about
    /// the privilege bracket.
    fn mark_managed(path: &Path, project_path: &str) {
        let conn = Connection::open(path).expect("open fixture");
        conn.execute(
            "INSERT OR REPLACE INTO authority_managed(project_path, context_store_uuid, marked_at)
             VALUES (?1, 'fixture', 1)",
            params![project_path],
        )
        .expect("mark managed");
    }

    fn sample_publish() -> FoldPublish {
        FoldPublish {
            session_id: "ses_fixture".to_string(),
            project_path: "git:fixture".to_string(),
            harness: "opencode".to_string(),
            now_ms: 1_700_000_000_000,
            compartments: vec![
                HostCompartment {
                    sequence: 1,
                    start_message: 1,
                    end_message: 4,
                    start_message_id: "msg_a".to_string(),
                    end_message_id: "msg_d".to_string(),
                    title: "first".to_string(),
                    content: "first body".to_string(),
                    p1: Some("first body".to_string()),
                    p2: Some("shorter".to_string()),
                    p3: None,
                    p4: None,
                    importance: Some(70),
                    episode_type: Some("design".to_string()),
                    created_at: 1_700_000_000_000,
                },
                HostCompartment {
                    sequence: 2,
                    start_message: 5,
                    end_message: 9,
                    start_message_id: "msg_e".to_string(),
                    end_message_id: "msg_i".to_string(),
                    title: "second".to_string(),
                    content: "second body".to_string(),
                    p1: Some("second body".to_string()),
                    p2: None,
                    p3: None,
                    p4: None,
                    importance: None,
                    episode_type: None,
                    created_at: 1_700_000_000_000,
                },
            ],
            facts: vec![
                HostSessionFact {
                    category: "Decisions".to_string(),
                    content: "keep the guards armed".to_string(),
                },
                HostSessionFact {
                    category: "Open".to_string(),
                    content: "size the chunk budget".to_string(),
                },
            ],
            events: vec![
                HostCompartmentEvent {
                    kind: "causal_incident".to_string(),
                    at_compartment: Some(2),
                    fields_json: "{\"trigger\":\"x\"}".to_string(),
                },
                // Anchored past this publish's emitted list: the raw anchor survives and
                // no durable id is invented.
                HostCompartmentEvent {
                    kind: "trajectory_correction".to_string(),
                    at_compartment: Some(9),
                    fields_json: "{}".to_string(),
                },
            ],
            memories: vec![
                HostMemory {
                    category: "ARCHITECTURE".to_string(),
                    content: "The module writes context.db directly".to_string(),
                    importance: Some(80),
                    source_session_id: Some("ses_fixture".to_string()),
                    expires_at: None,
                    metadata_json: None,
                },
                HostMemory {
                    category: "KNOWN_ISSUES".to_string(),
                    content: "Embeddings arrive from the host backfill".to_string(),
                    importance: None,
                    source_session_id: Some("ses_fixture".to_string()),
                    expires_at: Some(1_800_000_000_000),
                    metadata_json: Some("{\"k\":1}".to_string()),
                },
            ],
            notes: vec![HostNote {
                content: "a session note".to_string(),
                anchor_ordinal: Some(4),
            }],
            primer_candidates: vec![HostPrimerCandidate {
                question: "  How   does the fence work? ".to_string(),
                source_compartment_start: Some(1),
                source_compartment_end: Some(4),
                source_start_message_id: "msg_a".to_string(),
                source_end_message_id: "msg_d".to_string(),
                source_message_time: 1_699_999_000_000,
                created_at: 1_700_000_000_000,
            }],
            user_observations: vec![HostUserObservation {
                content: "prefers terse answers".to_string(),
                source_compartment_start: Some(1),
                source_compartment_end: Some(4),
                created_at: 1_700_000_000_000,
            }],
            user_memories: Vec::new(),
            user_memory_collection_enabled: true,
        }
    }

    // ── Fingerprints and fence ──────────────────────────────────────────────

    #[test]
    fn domain_fingerprints_match_the_committed_schema_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        let conn = Connection::open(&path).unwrap();
        let mut drift = Vec::new();
        for table in DOMAIN_TABLES {
            let found = read_table_fingerprint(&conn, table)
                .unwrap()
                .unwrap_or_else(|| panic!("committed schema snapshot has no {table} table"));
            let expected = expected_fingerprint(table).unwrap_or("");
            if found != expected {
                drift.push(format!("    (\"{table}\", \"{found}\"),"));
            }
        }
        assert!(
            drift.is_empty(),
            "DOMAIN_TABLE_FINGERPRINTS is stale. Replace the drifted entries with:\n{}",
            drift.join("\n")
        );
    }

    #[test]
    fn a_database_one_lane_ahead_refuses_every_domain_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        let mut store = HostStore::open_with_fence(&path, BUILT_CONTEXT_FENCE_VERSION - 1).unwrap();

        let error = store.publish_fold(&sample_publish()).unwrap_err();
        assert_eq!(error.code(), "single_store_fence_ahead");
        assert!(error.is_schema_refusal());
        assert!(store.writable_tables().is_err());

        let conn = Connection::open(&path).unwrap();
        let compartments: i64 = conn
            .query_row("SELECT COUNT(*) FROM compartments", [], |row| row.get(0))
            .unwrap();
        assert_eq!(compartments, 0, "a refused publish must write nothing");
    }

    #[test]
    fn a_database_one_lane_behind_is_writable_when_the_fingerprints_still_match() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute(
                "DELETE FROM schema_migrations WHERE version = ?1",
                params![BUILT_CONTEXT_FENCE_VERSION],
            )
            .unwrap();
        }
        let store = HostStore::open(&path).unwrap();
        assert_eq!(
            store.fence().persisted_version,
            BUILT_CONTEXT_FENCE_VERSION - 1
        );
        assert!(store.writable_tables().unwrap().contains(&"memories"));
    }

    #[test]
    fn a_trigger_only_change_to_a_domain_table_is_caught_by_the_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        {
            let conn = Connection::open(&path).unwrap();
            // No column moves here. Only a trigger body changes — the exact shape a
            // columns-only fingerprint would sail straight past.
            conn.execute_batch(
                "DROP TRIGGER IF EXISTS memories_authority_guard_insert;
                 CREATE TRIGGER memories_authority_guard_insert
                 BEFORE INSERT ON memories
                 WHEN 0
                 BEGIN SELECT RAISE(ABORT, 'rewritten by a later migration'); END;",
            )
            .unwrap();
        }
        let store = HostStore::open(&path).unwrap();
        let error = store.fence().check_table("memories").unwrap_err();
        assert_eq!(error.code(), "single_store_fingerprint_mismatch");
        // Tables the migration did not touch stay writable: the fence is per table.
        assert!(store.fence().check_table("session_facts").is_ok());
    }

    #[test]
    fn a_column_added_to_a_domain_table_is_caught_by_the_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("ALTER TABLE session_facts ADD COLUMN speculative TEXT;")
                .unwrap();
        }
        let store = HostStore::open(&path).unwrap();
        assert_eq!(
            store
                .fence()
                .check_table("session_facts")
                .unwrap_err()
                .code(),
            "single_store_fingerprint_mismatch"
        );
    }

    #[test]
    fn a_database_without_a_migration_table_is_not_a_context_db() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.db");
        Connection::open(&path).unwrap();
        let error = match HostStore::open(&path) {
            Ok(_) => panic!("a database with no migration table must not open for writes"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "single_store_fence_missing");
    }

    #[test]
    fn a_missing_domain_table_refuses_only_that_table() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("DROP TABLE user_memories;").unwrap();
        }
        let store = HostStore::open(&path).unwrap();
        assert_eq!(
            store
                .fence()
                .check_table("user_memories")
                .unwrap_err()
                .code(),
            "single_store_table_missing"
        );
        assert!(store.fence().check_table("memories").is_ok());
    }

    // ── The privileged write bracket ────────────────────────────────────────

    #[test]
    fn the_authority_guard_rejects_an_unbracketed_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");
        let conn = Connection::open(&path).unwrap();
        let error = conn
            .execute(
                "INSERT INTO memories
                   (project_path, category, content, normalized_hash, first_seen_at,
                    created_at, updated_at, last_seen_at)
                 VALUES ('git:fixture', 'ARCHITECTURE', 'unbracketed', 'hash', 1, 1, 1, 1)",
                [],
            )
            .unwrap_err();
        assert!(
            error.to_string().contains("managed by the Rust module"),
            "expected the authority guard to abort, got {error}"
        );
    }

    #[test]
    fn a_publish_leaves_the_privilege_row_disarmed() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");
        let mut store = HostStore::open(&path).unwrap();
        store.publish_fold(&sample_publish()).unwrap();

        let conn = Connection::open(&path).unwrap();
        let enabled: i64 = conn
            .query_row(
                "SELECT enabled FROM context_privilege_state WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(enabled, 0, "the bracket must be dropped before commit");
    }

    #[test]
    fn a_second_connection_never_observes_the_privilege_flip() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");

        let (observed_tx, observed_rx) = mpsc::channel::<i64>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let reader_path = path.clone();
        let reader = std::thread::spawn(move || {
            let conn = Connection::open(&reader_path).unwrap();
            conn.busy_timeout(std::time::Duration::from_millis(5_000))
                .unwrap();
            let mut samples = 0_u64;
            while stop_rx.try_recv().is_err() {
                let enabled: i64 = conn
                    .query_row(
                        "SELECT COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0)",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                if enabled != 0 {
                    let _ = observed_tx.send(enabled);
                }
                samples += 1;
            }
            samples
        });

        let mut store = HostStore::open(&path).unwrap();
        // A small budget forces several bracketed transactions rather than one.
        store.set_chunk_budget(1);
        for round in 0..8 {
            let mut publish = sample_publish();
            publish.session_id = format!("ses_{round}");
            for (index, compartment) in publish.compartments.iter_mut().enumerate() {
                compartment.sequence = index as i64 + 1;
            }
            for (index, memory) in publish.memories.iter_mut().enumerate() {
                memory.content = format!("round {round} memory {index}");
            }
            store.publish_fold(&publish).unwrap();
        }
        let _ = stop_tx.send(());
        let samples = reader.join().unwrap();

        assert!(
            samples > 0,
            "the reader thread never sampled the privilege row"
        );
        assert!(
            observed_rx.try_recv().is_err(),
            "a second connection observed the privilege row armed"
        );
    }

    // ── Domain writers ──────────────────────────────────────────────────────

    #[test]
    fn compartment_rows_carry_the_tier_columns_and_the_legacy_flag() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");
        let mut store = HostStore::open(&path).unwrap();
        let mut publish = sample_publish();
        // A compartment with no tiers and real text is a flat legacy row.
        publish.compartments.push(HostCompartment {
            sequence: 3,
            start_message: 10,
            end_message: 12,
            start_message_id: "msg_j".to_string(),
            end_message_id: "msg_l".to_string(),
            title: "flat".to_string(),
            content: "flat body".to_string(),
            created_at: 1_700_000_000_000,
            ..HostCompartment::default()
        });
        store.publish_fold(&publish).unwrap();

        let conn = Connection::open(&path).unwrap();
        let mut statement = conn
            .prepare(
                "SELECT sequence, p1, p2, importance, episode_type, legacy, harness
                   FROM compartments WHERE session_id = 'ses_fixture' ORDER BY sequence",
            )
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(rows[0].1.as_deref(), Some("first body"));
        assert_eq!(rows[0].2.as_deref(), Some("shorter"));
        assert_eq!(rows[0].3, 70);
        assert_eq!(rows[0].4.as_deref(), Some("design"));
        assert_eq!(rows[0].5, 0);
        assert_eq!(rows[0].6, "opencode");
        // No importance supplied falls back to the host's 50, not to NULL.
        assert_eq!(rows[1].3, 50);
        assert_eq!(rows[2].5, 1, "an untiered compartment with text is legacy");
    }

    #[test]
    fn memory_rows_match_the_host_writers_defaults_and_hash() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");
        let mut store = HostStore::open(&path).unwrap();
        let publish = sample_publish();
        store.publish_fold(&publish).unwrap();

        let conn = Connection::open(&path).unwrap();
        let (hash, importance, source_type, seen, retrieval, status, verification, scope, expires) =
            conn.query_row(
                "SELECT normalized_hash, importance, source_type, seen_count, retrieval_count,
                        status, verification_status, scope, expires_at
                   FROM memories WHERE category = 'KNOWN_ISSUES'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, Option<i64>>(8)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            hash,
            compute_normalized_hash("Embeddings arrive from the host backfill")
        );
        assert_eq!(importance, 50);
        assert_eq!(source_type, "historian");
        assert_eq!(seen, 1);
        assert_eq!(retrieval, 0);
        assert_eq!(status, "active");
        assert_eq!(verification, "unverified");
        assert_eq!(scope, "project");
        assert_eq!(expires, Some(1_800_000_000_000));
    }

    #[test]
    fn a_memory_insert_keeps_the_full_text_index_current() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");
        let mut store = HostStore::open(&path).unwrap();
        store.publish_fold(&sample_publish()).unwrap();

        let conn = Connection::open(&path).unwrap();
        let hits: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memories_fts WHERE memories_fts MATCH 'backfill'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            hits, 1,
            "the table's own triggers must maintain the index for a module write too"
        );
    }

    #[test]
    fn an_event_anchored_past_the_publish_keeps_its_raw_anchor_and_no_durable_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");
        let mut store = HostStore::open(&path).unwrap();
        let outcome = store.publish_fold(&sample_publish()).unwrap();

        let conn = Connection::open(&path).unwrap();
        let mut statement = conn
            .prepare(
                "SELECT kind, compartment_id, at_compartment FROM compartment_events
                  WHERE session_id = 'ses_fixture' ORDER BY id",
            )
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(rows[0].1, Some(outcome.compartment_ids[1]));
        assert_eq!(rows[1].1, None);
        assert_eq!(rows[1].2, Some(9));
    }

    #[test]
    fn session_facts_are_replaced_not_appended() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");
        let mut store = HostStore::open(&path).unwrap();
        store.publish_fold(&sample_publish()).unwrap();

        let mut second = sample_publish();
        second.compartments.clear();
        second.memories.clear();
        second.primer_candidates.clear();
        second.user_observations.clear();
        second.notes.clear();
        second.facts = vec![HostSessionFact {
            category: "Decisions".to_string(),
            content: "only this one survives".to_string(),
        }];
        store.publish_fold(&second).unwrap();

        let conn = Connection::open(&path).unwrap();
        let contents: Vec<String> = conn
            .prepare("SELECT content FROM session_facts WHERE session_id = 'ses_fixture'")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(contents, vec!["only this one survives".to_string()]);
    }

    #[test]
    fn the_privacy_gate_writes_no_observation_row_when_collection_is_off() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");
        let mut store = HostStore::open(&path).unwrap();
        let mut publish = sample_publish();
        publish.user_memory_collection_enabled = false;
        store.publish_fold(&publish).unwrap();

        let conn = Connection::open(&path).unwrap();
        let observations: i64 = conn
            .query_row("SELECT COUNT(*) FROM user_memory_candidates", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(observations, 0);
    }

    #[test]
    fn a_primer_candidate_is_normalized_and_upserted_on_its_source_range() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");
        let mut store = HostStore::open(&path).unwrap();
        store.publish_fold(&sample_publish()).unwrap();

        let mut second = sample_publish();
        second.compartments.clear();
        second.memories.clear();
        second.primer_candidates[0].question = "How does the fence work now?".to_string();
        second.primer_candidates[0].created_at = 1_600_000_000_000;
        store.publish_fold(&second).unwrap();

        let conn = Connection::open(&path).unwrap();
        let (count, question, normalized, created_at): (i64, String, String, i64) = conn
            .query_row(
                "SELECT COUNT(*), MAX(question), MAX(normalized_question), MIN(created_at)
                   FROM primer_candidates",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(count, 1, "the same source range must upsert, not duplicate");
        assert_eq!(question, "How does the fence work now?");
        // The trailing question mark is off: the normalized form is what two askings of
        // the same question are matched on.
        assert_eq!(normalized, "how does the fence work now");
        assert_eq!(
            created_at, 1_600_000_000_000,
            "the earliest creation time is kept"
        );
    }

    #[test]
    fn a_promoted_user_memory_records_the_provenance_of_its_candidates() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");
        let mut store = HostStore::open(&path).unwrap();
        store.publish_fold(&sample_publish()).unwrap();

        let candidate_id: i64 = Connection::open(&path)
            .unwrap()
            .query_row("SELECT id FROM user_memory_candidates", [], |row| {
                row.get(0)
            })
            .unwrap();

        let mut promotion = sample_publish();
        promotion.compartments.clear();
        promotion.memories.clear();
        promotion.notes.clear();
        promotion.primer_candidates.clear();
        promotion.user_observations.clear();
        promotion.user_memories = vec![HostUserMemory {
            content: "prefers terse answers".to_string(),
            source_candidate_ids: vec![candidate_id],
        }];
        store.publish_fold(&promotion).unwrap();

        let conn = Connection::open(&path).unwrap();
        let (ids, provenance): (String, Option<String>) = conn
            .query_row(
                "SELECT source_candidate_ids, source_candidate_provenance FROM user_memories",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(ids, format!("[{candidate_id}]"));
        let provenance: Value = serde_json::from_str(&provenance.unwrap()).unwrap();
        assert_eq!(provenance[0]["candidate_id"], json!(candidate_id));
        assert_eq!(provenance[0]["session_id"], json!("ses_fixture"));
    }

    // ── Chunked publish and the visibility invariant ────────────────────────

    #[test]
    fn a_publish_is_split_into_chunks_under_the_row_budget() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");
        let mut store = HostStore::open(&path).unwrap();
        store.set_chunk_budget(2);

        let mut publish = sample_publish();
        publish.memories = (0..7)
            .map(|index| HostMemory {
                category: "ARCHITECTURE".to_string(),
                content: format!("memory {index}"),
                ..HostMemory::default()
            })
            .collect();
        let outcome = store.publish_fold(&publish).unwrap();

        assert!(
            outcome.chunk_rows.len() >= 2,
            "expected several chunks, got {:?}",
            outcome.chunk_rows
        );
        let staged: Vec<usize> = outcome.chunk_rows[..outcome.chunk_rows.len() - 1].to_vec();
        for rows in &staged {
            assert!(*rows <= 2, "a staged chunk exceeded the budget: {rows}");
        }
        assert_eq!(outcome.compartment_ids.len(), 2);
        assert_eq!(outcome.memory_ids.len(), 7);
    }

    #[test]
    fn a_reader_between_chunks_sees_the_session_exactly_as_it_was_before_the_fold() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");

        // Seed a prior fold so "before" is a real state, not an empty table.
        {
            let mut store = HostStore::open(&path).unwrap();
            let mut prior = sample_publish();
            prior.memories.clear();
            prior.primer_candidates.clear();
            prior.user_observations.clear();
            prior.notes.clear();
            prior.events.clear();
            prior.compartments.truncate(1);
            store.publish_fold(&prior).unwrap();
        }

        let before = read_session_history(&path, "ses_fixture");
        assert_eq!(before.compartments.len(), 1);

        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let reader_path = path.clone();
        let expected = before.clone();
        let reader = std::thread::spawn(move || {
            let mut samples = 0_u64;
            let mut torn = Vec::new();
            while stop_rx.try_recv().is_err() {
                let snapshot = read_session_history(&reader_path, "ses_fixture");
                samples += 1;
                // Either the fold is not there yet, or it is there whole. Anything else
                // is a reader composing history from a half-published fold.
                let complete = snapshot.compartments.len() == 3
                    && snapshot.facts.len() == 2
                    && snapshot.events == 2
                    && snapshot.project_memories == 12;
                // Anything that is neither the pre-fold state nor the whole fold is a
                // reader composing history from a publish that is still landing.
                let staged_only = snapshot.compartments == expected.compartments
                    && snapshot.facts == expected.facts
                    && snapshot.events == expected.events;
                if !staged_only && !complete {
                    torn.push(format!(
                        "compartments={} facts={} events={} memories={}",
                        snapshot.compartments.len(),
                        snapshot.facts.len(),
                        snapshot.events,
                        snapshot.project_memories
                    ));
                }
            }
            (samples, torn)
        });

        let mut store = HostStore::open(&path).unwrap();
        store.set_chunk_budget(1);
        let mut publish = sample_publish();
        publish.session_id = "ses_fixture".to_string();
        publish.compartments[0].sequence = 2;
        publish.compartments[1].sequence = 3;
        publish.memories = (0..12)
            .map(|index| HostMemory {
                category: "ARCHITECTURE".to_string(),
                content: format!("visibility memory {index}"),
                ..HostMemory::default()
            })
            .collect();
        let outcome = store.publish_fold(&publish).unwrap();
        assert!(outcome.chunk_rows.len() > 4, "expected a multi-chunk fold");
        let _ = stop_tx.send(());
        let (samples, torn) = reader.join().unwrap();

        assert!(samples > 0, "the reader thread never sampled");
        assert!(
            torn.is_empty(),
            "a reader saw a partially published fold: {torn:?}"
        );

        let after = read_session_history(&path, "ses_fixture");
        assert_eq!(after.compartments.len(), 3);
        assert_eq!(after.facts.len(), 2);
        assert_eq!(after.events, 2);
        assert_eq!(after.project_memories, 12);
    }

    /// Everything a concurrent reader can see of one publish: the compartment history a
    /// host renders a session's past from, plus the project rows the same publish made.
    ///
    /// The memory count belongs here even though no reader composes history from it. The
    /// ordering under test puts the standalone rows first and the compartments last, so a
    /// snapshot holding compartments but not the memories that came with them is proof
    /// that the ordering broke — and without the count, that break is invisible.
    #[derive(Debug, Clone, PartialEq, Eq)]
    struct SessionHistory {
        compartments: Vec<(i64, String)>,
        facts: Vec<(String, String)>,
        events: i64,
        project_memories: i64,
    }

    fn read_session_history(path: &Path, session_id: &str) -> SessionHistory {
        let conn = Connection::open(path).unwrap();
        conn.busy_timeout(std::time::Duration::from_millis(5_000))
            .unwrap();
        let compartments = conn
            .prepare(
                "SELECT sequence, title FROM compartments WHERE session_id = ?1 ORDER BY sequence",
            )
            .unwrap()
            .query_map(params![session_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let facts = conn
            .prepare(
                "SELECT category, content FROM session_facts WHERE session_id = ?1
                  ORDER BY category, id",
            )
            .unwrap()
            .query_map(params![session_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let events: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM compartment_events WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .unwrap();
        let project_memories: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memories WHERE project_path = 'git:fixture'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        SessionHistory {
            compartments,
            facts,
            events,
            project_memories,
        }
    }

    // ── Embedding watermark ─────────────────────────────────────────────────

    #[test]
    fn the_watermark_tracks_the_highest_memory_id_the_module_wrote() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");
        let mut store = HostStore::open(&path).unwrap();
        store.set_chunk_budget(1);
        let outcome = store.publish_fold(&sample_publish()).unwrap();

        let highest = *outcome.memory_ids.iter().max().unwrap();
        assert_eq!(outcome.embedding_watermark, highest);

        let conn = Connection::open(&path).unwrap();
        let (written, embedded) = read_embedding_watermark(&conn, "git:fixture")
            .unwrap()
            .unwrap();
        assert_eq!(written, highest);
        assert_eq!(embedded, 0, "nothing has been embedded yet");
    }

    #[test]
    fn the_watermark_never_moves_backwards() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");
        let mut store = HostStore::open(&path).unwrap();
        store.publish_fold(&sample_publish()).unwrap();
        let conn = Connection::open(&path).unwrap();
        let (high, _) = read_embedding_watermark(&conn, "git:fixture")
            .unwrap()
            .unwrap();

        // The host embeds everything and records how far it got.
        conn.execute(
            "UPDATE memory_embedding_watermarks SET embedded_memory_id = written_memory_id",
            [],
        )
        .unwrap();

        let mut empty = sample_publish();
        empty.memories.clear();
        empty.compartments.clear();
        empty.events.clear();
        empty.primer_candidates.clear();
        empty.user_observations.clear();
        empty.notes.clear();
        store.publish_fold(&empty).unwrap();
        let (written, embedded) = read_embedding_watermark(&conn, "git:fixture")
            .unwrap()
            .unwrap();
        assert_eq!(written, high);
        assert_eq!(embedded, high, "a fold with no memories leaves no backlog");
    }

    // ── Mode gate ───────────────────────────────────────────────────────────

    #[test]
    fn primer_normalization_matches_the_hosts_folding_rules() {
        assert_eq!(
            normalize_primer_question("  How   does the FENCE work?!  "),
            "how does the fence work"
        );
        assert_eq!(
            normalize_primer_question("What\u{2019}s the \u{201c}budget\u{201d}?"),
            "what's the \"budget\""
        );
        assert_eq!(
            normalize_primer_question("no punctuation"),
            "no punctuation"
        );
    }

    #[test]
    fn mode_on_is_refused_by_name() {
        let error = admit_mode(SingleStoreMode::On).unwrap_err();
        assert_eq!(error.code(), "single_store_mode_refused");
        assert!(error.to_string().contains("shadow/verify only"));
        assert_eq!(
            admit_mode(SingleStoreMode::Off).unwrap(),
            SingleStoreMode::Off
        );
        assert_eq!(
            admit_mode(SingleStoreMode::Shadow).unwrap(),
            SingleStoreMode::Shadow
        );
    }

    #[test]
    fn mode_parses_the_three_documented_values_and_nothing_else() {
        assert_eq!(SingleStoreMode::parse("off"), Some(SingleStoreMode::Off));
        assert_eq!(
            SingleStoreMode::parse(" Shadow "),
            Some(SingleStoreMode::Shadow)
        );
        assert_eq!(SingleStoreMode::parse("ON"), Some(SingleStoreMode::On));
        assert_eq!(SingleStoreMode::parse("enabled"), None);
        assert_eq!(SingleStoreMode::default(), SingleStoreMode::Off);
    }

    // ── Shadow verification ─────────────────────────────────────────────────

    #[test]
    fn shadow_mode_writes_nothing_to_the_real_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");
        let mut store = HostStore::open(&path).unwrap();
        let report = store
            .shadow_publish(&sample_publish(), &dir.path().join("scratch"))
            .unwrap();

        let conn = Connection::open(&path).unwrap();
        for table in ["compartments", "memories", "session_facts"] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "shadow mode wrote to {table} in the real file");
        }
        assert!(
            !report.divergences.is_empty(),
            "every row is new here, so every compared column must be reported"
        );
        assert!(report.summary().contains("diverging column"));
    }

    #[test]
    fn shadow_mode_reports_the_columns_that_differ_from_the_mirrors_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");

        // Stand in for the mirror: the same publish, already landed, except that one
        // column carries a different value.
        {
            let mut seeded = HostStore::open(&path).unwrap();
            let mut mirrored = sample_publish();
            mirrored.compartments[0].title = "a different title".to_string();
            seeded.publish_fold(&mirrored).unwrap();
        }

        let mut store = HostStore::open(&path).unwrap();
        let report = store
            .shadow_publish(&sample_publish(), &dir.path().join("scratch"))
            .unwrap();

        let compartment_titles: Vec<&ShadowDivergence> = report
            .divergences
            .iter()
            .filter(|divergence| divergence.table == "compartments" && divergence.column == "title")
            .collect();
        assert_eq!(compartment_titles.len(), 1, "{:?}", report.divergences);
        assert_eq!(
            compartment_titles[0].mirror.as_deref(),
            Some("a different title")
        );
        assert_eq!(compartment_titles[0].module.as_deref(), Some("first"));
        assert!(report.summary().contains("compartments(title)"));
    }

    #[test]
    fn shadow_mode_reports_no_divergence_when_the_rows_already_match() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");
        {
            let mut seeded = HostStore::open(&path).unwrap();
            seeded.publish_fold(&sample_publish()).unwrap();
        }
        let mut store = HostStore::open(&path).unwrap();
        let report = store
            .shadow_publish(&sample_publish(), &dir.path().join("scratch"))
            .unwrap();
        assert!(
            report.divergences.is_empty(),
            "identical rows must not be reported as divergence: {:?}",
            report.divergences
        );
        assert!(report.summary().contains("no divergence"));
    }

    // ── Health surface ──────────────────────────────────────────────────────

    #[test]
    fn health_names_the_refusal_per_table() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("ALTER TABLE notes ADD COLUMN speculative TEXT;")
                .unwrap();
        }
        let store = HostStore::open(&path).unwrap();
        let health = store.health_value(SingleStoreMode::Shadow);
        // Reports the store's answer: this build cannot serve a moved store.
        assert_eq!(health["capable"], json!(false));
        assert_eq!(health["mode"], json!("shadow"));
        assert_eq!(
            health["fence"]["persisted_version"],
            json!(BUILT_CONTEXT_FENCE_VERSION)
        );
        assert_eq!(health["fence"]["lane_ok"], json!(true));
        assert_eq!(health["tables"]["memories"]["writable"], json!(true));
        assert_eq!(health["tables"]["notes"]["writable"], json!(false));
        assert_eq!(
            health["tables"]["notes"]["error_code"],
            json!("single_store_fingerprint_mismatch")
        );
    }

    #[test]
    fn the_status_block_in_off_mode_opens_nothing() {
        set_mode(SingleStoreMode::Off);
        let block = status_value();
        // Reports the store's answer: this build cannot serve a moved store.
        assert_eq!(block["capable"], json!(false));
        assert_eq!(block["mode"], json!("off"));
        assert!(
            block["path"].is_null(),
            "off mode must not name a file it did not open"
        );
        assert!(block["fence"].is_null());
        assert_eq!(
            block["built_fence_version"],
            json!(BUILT_CONTEXT_FENCE_VERSION)
        );
        assert_eq!(
            block["chunk_budget_rows"],
            json!(DEFAULT_PUBLISH_CHUNK_ROWS)
        );
    }

    #[test]
    fn a_refused_mode_is_named_in_the_status_block() {
        record_mode_refusal(&HostStoreError::ModeRefused { mode: "on" });
        set_mode(SingleStoreMode::Off);
        let block = status_value();
        assert_eq!(
            block["refused_mode_code"],
            json!("single_store_mode_refused")
        );
        assert!(block["refused_mode_detail"]
            .as_str()
            .unwrap()
            .contains("shadow/verify only"));
    }

    #[test]
    fn the_context_db_path_follows_the_hosts_own_resolution_order() {
        // Resolution is read from the process environment, which several tests share, so
        // this asserts the shape of the answer rather than mutating that environment.
        let resolved = resolve_context_db_path();
        assert_eq!(resolved.file_name().unwrap(), "context.db");
        assert_eq!(
            resolved.parent().unwrap().file_name().unwrap(),
            "magic-context",
            "resolved {}",
            resolved.display()
        );
    }

    #[test]
    fn shadow_verification_is_inert_while_the_mode_is_off() {
        set_mode(SingleStoreMode::Off);
        assert!(verify_publish_in_shadow(&sample_publish()).is_none());
    }

    #[test]
    fn unavailable_health_carries_the_error_code() {
        let error = HostStoreError::FenceAhead {
            persisted: 120,
            built: BUILT_CONTEXT_FENCE_VERSION,
        };
        let health = HostStore::unavailable_health_value(SingleStoreMode::Shadow, Some(&error));
        assert_eq!(health["error_code"], json!("single_store_fence_ahead"));
        assert!(health["detail"].as_str().unwrap().contains("v120"));
    }

    // ── Chunk budget measurement ────────────────────────────────────────────

    /// Measure what a chunk actually costs on the committed schema, and hold the shipped
    /// budget to the wall-clock property it was derived from.
    ///
    /// The budget is a row count, but the thing that matters is how long a seat can be
    /// made to wait. This measures the shipped budget's worth of the most expensive row
    /// class — a memory, whose insert drives an external-content full-text delete and
    /// insert — and fails if that transaction runs past the budget's wall-clock ceiling.
    #[test]
    fn the_shipped_chunk_budget_holds_its_wall_clock_ceiling() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");
        let mut store = HostStore::open(&path).unwrap();

        let mut publish = sample_publish();
        publish.compartments.clear();
        publish.facts.clear();
        publish.events.clear();
        publish.notes.clear();
        publish.primer_candidates.clear();
        publish.user_observations.clear();
        publish.memories = (0..DEFAULT_PUBLISH_CHUNK_ROWS)
            .map(|index| HostMemory {
                category: "ARCHITECTURE".to_string(),
                content: format!(
                    "measured memory {index} with enough prose to give the full-text index real work to do"
                ),
                ..HostMemory::default()
            })
            .collect();

        let outcome = store.publish_fold(&publish).unwrap();
        let worst = outcome.max_chunk_duration_us();
        assert!(
            worst < PUBLISH_CHUNK_BUDGET_US,
            "a {DEFAULT_PUBLISH_CHUNK_ROWS}-row chunk held its transaction for {worst}us, over the {PUBLISH_CHUNK_BUDGET_US}us budget"
        );
        // Recorded so the slice report can quote a number rather than an impression.
        println!(
            "single_store chunk measurement: rows={DEFAULT_PUBLISH_CHUNK_ROWS} worst_chunk_us={worst} budget_us={PUBLISH_CHUNK_BUDGET_US}"
        );
    }

    /// Re-derive the row budget by sweeping chunk sizes on the committed schema.
    ///
    /// Not part of the ordinary suite: it is a measuring instrument, and its output is a
    /// table of numbers rather than a pass/fail claim. Run it when the budget needs
    /// revisiting:
    ///   cargo test -p mc-module --lib host_store::tests::measure -- --ignored --nocapture
    #[test]
    #[ignore = "measurement instrument, not an assertion"]
    fn measure_chunk_cost_across_sizes() {
        for rows in [16_usize, 32, 64, 128, 256, 512, 1024] {
            let dir = tempfile::tempdir().unwrap();
            let path = fixture_db(dir.path(), "context.db");
            mark_managed(&path, "git:fixture");
            let mut store = HostStore::open(&path).unwrap();
            store.set_chunk_budget(rows);

            let mut publish = sample_publish();
            publish.compartments.clear();
            publish.facts.clear();
            publish.events.clear();
            publish.notes.clear();
            publish.primer_candidates.clear();
            publish.user_observations.clear();
            publish.memories = (0..rows)
                .map(|index| HostMemory {
                    category: "ARCHITECTURE".to_string(),
                    content: format!(
                        "measured memory {index} with enough prose to give the full-text index real work to do"
                    ),
                    ..HostMemory::default()
                })
                .collect();

            let outcome = store.publish_fold(&publish).unwrap();
            println!(
                "rows={rows} worst_chunk_us={} chunks={}",
                outcome.max_chunk_duration_us(),
                outcome.chunk_rows.len()
            );
        }
    }
}
