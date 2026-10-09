//! Single-store writer: the module writing the host's `context.db` domain tables.
//!
//! `context.db` is the only copy of the module's memories, notes and session history. The
//! module writes those tables directly, under the same discipline the TypeScript host
//! writes them under; `store.db` keeps only the module's cache.
//!
//! Three rules shape everything here.
//!
//! 1. **`context.db` is a versioned external schema.** The module opens it, never
//!    migrates it, and refuses to write when the schema it finds is not the schema it
//!    was built against. "Not the schema" is decided per table: each table the module
//!    writes has its full `sqlite_master` surface — its columns, its CHECK/UNIQUE
//!    constraints, its indexes, and its triggers — hashed and compared with the value
//!    baked in below. A host migration that leaves a table's surface alone leaves that
//!    table writable, whatever the migration lane now says; one that changes it fails
//!    that table closed with a typed refusal. The check is repeated inside every write
//!    transaction, because a migration can land between opening the file and writing
//!    to it.
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
//! Everyday writes go through [`HostStore::with_domain_transaction`], one transaction per
//! write; the chunked [`HostStore::publish_fold`] writer is kept for bulk publishes.

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use mc_store::private_permissions::{
    create_file, ensure_directory, tighten_directory, tighten_tree,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Whether this binary can serve a store whose project rows live in the host's own
/// database ("single-store mode"), as `session.status` reports it.
///
/// This is the store's own constant, not a second copy, so the status surface reports the
/// same answer the store acts on.
pub const SINGLE_STORE_CAPABLE: bool = mc_store::SINGLE_STORE_CAPABLE;

/// The `context.db` upstream migration lane this binary was built against.
///
/// Reported, not enforced. A lane ahead of this number says the host has migrated since
/// this binary was built; whether that migration changed anything these writers depend
/// on is answered per table by the fingerprints, so a migration that touched only tables
/// the module never writes does not stop the module writing.
pub const BUILT_CONTEXT_FENCE_VERSION: i64 = 99;

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
///
/// The module also writes one non-domain table, [`BRACKET_TABLE`], in every transaction,
/// so that table is fingerprinted too.
pub const DOMAIN_TABLES: &[&str] = &[
    "compartment_history_versions",
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

/// The table the privileged-writer bracket flips inside every write transaction.
///
/// It is fingerprinted like a domain table because every chunk sets and clears its row
/// `id = 1`, and the authority guards on `memories` and `notes` read that row. A migration
/// that changed the table's key (for example, one privilege row per project instead of
/// one per file) would leave the module setting a row the guards no longer read, so any
/// change to this table refuses every write.
pub const BRACKET_TABLE: &str = "context_privilege_state";

/// Maximum rows one non-final chunk may write.
///
/// Sized from `host_store::tests::measure_chunk_cost_on_a_realistic_store`, which seeds a
/// `context.db` to production-like row counts (2,000 memories, 11,000 compartments,
/// 1,000 notes, with and without 1,000,000 tags) and times memory-only chunks, the most
/// expensive row class. Measured on a debug build (unoptimized bundled SQLite) on a
/// machine at load average ~70, so these are upper bounds; the million tags did not move
/// the cost. Worst of five chunks, against the 250 ms ceiling below:
///
/// | rows | median   | worst    |
/// | ---- | -------- | -------- |
/// | 16   | 18-33 ms | 30-63 ms |
/// | 32   | 35-37 ms | 47-182 ms |
/// | 64   | 63-80 ms | 118-139 ms |
/// | 128  | 138-206 ms | 268-270 ms |
///
/// 16 rows keeps the worst observed chunk at a quarter of the ceiling (4x margin) and
/// the median at under a seventh of it. 64, the previous value, was sized on an empty
/// store and left under 2x margin at the worst observation here.
pub const DEFAULT_PUBLISH_CHUNK_ROWS: usize = 16;

/// Target wall-clock ceiling for one chunk's write transaction, in microseconds.
///
/// This is what the row budget is derived from; the row count is the knob, this is the
/// property it exists to hold.
pub const PUBLISH_CHUNK_BUDGET_US: i64 = 250_000;

/// Maximum rows the final, visibility chunk may write: compartments, facts and events
/// together, plus one each for the facts delete and the compartment replace.
///
/// That chunk cannot be split, because committing it is what makes the fold visible, so
/// a fold too large for it is refused before any of its chunks is written. Measured by
/// the same instrument as [`DEFAULT_PUBLISH_CHUNK_ROWS`]: a 256-row visibility chunk
/// (84 compartments, each with a fact and an event) took 11-16 ms at the median and
/// 81 ms at the worst observation, a 3x margin under the ceiling. These rows drive no
/// full-text index, which is why the chunk is far cheaper per row than a memory chunk.
/// A historian fold is a handful of compartments, far below this ceiling.
pub const MAX_VISIBILITY_CHUNK_ROWS: usize = 256;

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
    /// Another writer held `context.db`'s write lock for longer than the busy timeout.
    /// This is the refusal an interactive seat's own writes are protected by, so it is
    /// named and counted rather than reported as a generic SQLite failure.
    Busy {
        reason: String,
    },
    Sqlite(rusqlite::Error),
}

impl HostStoreError {
    /// Stable machine-readable name for the status surface.
    pub fn code(&self) -> &'static str {
        match self {
            HostStoreError::OpenFailed { .. } => "single_store_open_failed",
            HostStoreError::FenceMissing { .. } => "single_store_fence_missing",
            HostStoreError::TableMissing { .. } => "single_store_table_missing",
            HostStoreError::FingerprintMismatch { .. } => "single_store_fingerprint_mismatch",
            HostStoreError::PrivilegeFlipFailed { .. } => "single_store_privilege_flip_failed",
            HostStoreError::ChunkBudgetExceeded { .. } => "single_store_chunk_budget_exceeded",
            HostStoreError::Busy { .. } => "single_store_busy",
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
            HostStoreError::PrivilegeFlipFailed { reason } => write!(
                formatter,
                "could not take the context.db privileged-writer bracket: {reason}"
            ),
            HostStoreError::ChunkBudgetExceeded { rows, budget } => write!(
                formatter,
                "a publish chunk carried {rows} rows, over the {budget}-row write budget"
            ),
            HostStoreError::Busy { reason } => write!(
                formatter,
                "context.db stayed locked by another writer past the {CONTEXT_BUSY_TIMEOUT_MS} ms busy timeout: {reason}"
            ),
            HostStoreError::Sqlite(error) => write!(formatter, "context.db write failed: {error}"),
        }
    }
}

impl std::error::Error for HostStoreError {}

impl From<rusqlite::Error> for HostStoreError {
    fn from(error: rusqlite::Error) -> Self {
        // SQLITE_BUSY only reaches this code after the connection's busy handler has
        // already waited out CONTEXT_BUSY_TIMEOUT_MS, so it always means the timeout was
        // lost, never a momentary collision.
        if error.sqlite_error_code() == Some(rusqlite::ErrorCode::DatabaseBusy) {
            return HostStoreError::Busy {
                reason: error.to_string(),
            };
        }
        HostStoreError::Sqlite(error)
    }
}

/// How many writes this process lost to the busy timeout since it started.
///
/// Each one is a publish that could not get `context.db`'s write lock because another
/// writer, usually an interactive seat, held it past the timeout.
static BUSY_REFUSALS: AtomicU64 = AtomicU64::new(0);

pub fn busy_refusal_count() -> u64 {
    BUSY_REFUSALS.load(Ordering::Relaxed)
}

/// Count a lost busy timeout on its way out of a public entry point.
fn counted<T>(result: Result<T, HostStoreError>) -> Result<T, HostStoreError> {
    if let Err(HostStoreError::Busy { .. }) = &result {
        BUSY_REFUSALS.fetch_add(1, Ordering::Relaxed);
    }
    result
}

// ── Schema fingerprints ─────────────────────────────────────────────────────

/// The expected schema fingerprint of each domain table and of [`BRACKET_TABLE`], as
/// computed by [`read_table_fingerprint`].
///
/// Regenerate together with any migration that touches a domain table:
/// `bun scripts/dump-context-db-schema.ts > crates/mc-module/tests/fixtures/context-db-schema.sql`
/// then run `cargo test -p mc-module host_store::tests::domain_fingerprints` — the test
/// prints the value it found for any table that drifted.
pub const DOMAIN_TABLE_FINGERPRINTS: &[(&str, &str)] = &[
    (
        "compartment_history_versions",
        "23795e6c060f4dac4cbf8036abb4cba1db284c063f10aeb7eb23ee576a0b24e5",
    ),
    (
        "compartment_events",
        "79cb5301803217125d3831923e70a5d913754d6d733a96727f8cb86f2f5e138d",
    ),
    (
        "compartments",
        "849679458a3d6f4a495e336221c770066806aba16794f36ee79fbdcd3e32e89c",
    ),
    (
        "context_privilege_state",
        "ffe1e5a4d218c3a16cacc0a4c716eb227fa1bba59f203f035226d73ee0f88751",
    ),
    (
        "memories",
        "a5b13611e93768e4f53e78e4831a58d74d6c79e078a1a85c5cfbf269a0eb417c",
    ),
    (
        "memory_embedding_watermarks",
        "b3012ecd26bbc261bbd51ce0e7cdfaa9068864b0d32701c23d7b4704cf9560cc",
    ),
    (
        "notes",
        "31bf819717d1a09f3762fb1f56848fc19612f110fae8cc894bad5dc00f4ae2db",
    ),
    (
        "primer_candidates",
        "9992d881ec72626d4656a7c73c8779e33f1762cf106ea9ffff72e3b08dd3ec27",
    ),
    (
        "session_facts",
        "4a51eda591fa24f51a6b500a0773a9a648f1e53a1ada9352b195039230e11ec5",
    ),
    (
        "user_memories",
        "db3e60857602228326096491485382054f65432421e673b669b5a91f7dc8c865",
    ),
    (
        "user_memory_candidates",
        "1d918414e8a99614d6fb0b72a55ae40b2006c46dbf7303d4fe5546feff2e182e",
    ),
];

pub(crate) fn expected_fingerprint(table: &str) -> Option<&'static str> {
    DOMAIN_TABLE_FINGERPRINTS
        .iter()
        .find(|(name, _)| *name == table)
        .map(|(_, fingerprint)| *fingerprint)
}

/// Normalise schema SQL so that spelling alone never reads as a schema change.
///
/// Whitespace runs collapse to one space. Spaces next to parentheses and commas go, and
/// so do identifier quotes (`"`, `` ` ``, `[`, `]`); string literals are left as written.
/// Changing a column, a constraint, an index or a trigger body still changes the result.
fn normalize_schema_sql(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut in_string = false;
    let mut pending_space = false;
    for ch in sql.chars() {
        if in_string {
            out.push(ch);
            if ch == '\'' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '\'' => {
                if pending_space && !out.is_empty() && !out.ends_with(['(', ',']) {
                    out.push(' ');
                }
                pending_space = false;
                in_string = true;
                out.push(ch);
            }
            '"' | '`' | '[' | ']' => {}
            c if c.is_whitespace() => pending_space = true,
            '(' | ')' | ',' => {
                pending_space = false;
                out.push(ch);
            }
            _ => {
                if pending_space && !out.is_empty() && !out.ends_with(['(', ',']) {
                    out.push(' ');
                }
                pending_space = false;
                out.push(ch);
            }
        }
    }
    out
}

/// The CHECK constraints a CREATE TABLE statement declares, normalised and sorted, so
/// their place in the statement (inline, or appended by `ALTER TABLE ADD COLUMN`) does
/// not matter.
fn check_constraints(create_sql: &str) -> Vec<String> {
    let normalized = normalize_schema_sql(create_sql);
    let upper = normalized.to_ascii_uppercase();
    let bytes = normalized.as_bytes();
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(offset) = upper[from..].find("CHECK(") {
        let start = from + offset;
        let mut depth = 0usize;
        let mut in_string = false;
        let mut end = normalized.len();
        for (index, byte) in bytes.iter().enumerate().skip(start + "CHECK".len()) {
            match byte {
                b'\'' => in_string = !in_string,
                b'(' if !in_string => depth += 1,
                b')' if !in_string => {
                    depth -= 1;
                    if depth == 0 {
                        end = index + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        found.push(normalized[start..end].to_string());
        from = end;
    }
    found.sort();
    found
}

/// Hash one table's full `sqlite_master` surface.
///
/// `tbl_name` gathers the table itself plus every index and every trigger declared on it,
/// which is the surface a migration can change under the module: a trigger-only migration
/// on a domain table is the demonstrated shape, and a columns-only fingerprint would miss
/// it entirely.
pub(crate) fn read_table_fingerprint(
    conn: &Connection,
    table: &str,
) -> Result<Option<String>, rusqlite::Error> {
    Ok(table_schema_description(conn, table)?.map(|description| {
        let mut hasher = Sha256::new();
        hasher.update(description.as_bytes());
        format!("{:x}", hasher.finalize())
    }))
}

/// The text [`read_table_fingerprint`] hashes: what the table declares, independent of
/// how its CREATE statement happens to be spelled.
///
/// A file that gained columns through `ALTER TABLE ADD COLUMN` over many releases stores a
/// different CREATE text from a file created at the latest lane in one go, with the same
/// columns in another order. Hashing the text would read that as a schema change, and
/// on a long-lived host file every write would be refused. So the description is built
/// from what SQLite reports instead:
/// - every column's name, declared type, NOT NULL flag, default and primary-key position,
///   sorted by name;
/// - the table's CHECK constraints, normalised and sorted;
/// - every index (including the ones UNIQUE and PRIMARY KEY constraints create), with its
///   uniqueness, origin, partial flag and key columns, plus the normalised SQL of an
///   explicitly created one;
/// - every trigger by name with its normalised SQL.
///
/// Returns `None` when the table does not exist.
pub(crate) fn table_schema_description(
    conn: &Connection,
    table: &str,
) -> Result<Option<String>, rusqlite::Error> {
    let create_sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![table],
            |row| row.get(0),
        )
        .optional()?;
    let Some(create_sql) = create_sql else {
        return Ok(None);
    };
    let mut lines = Vec::new();

    let mut columns = conn
        .prepare("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?1)")?
        .query_map(params![table], |row| {
            Ok(format!(
                "column\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
                row.get::<_, String>(0)?,
                normalize_schema_sql(&row.get::<_, String>(1)?).to_ascii_uppercase(),
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?
                    .map(|value| normalize_schema_sql(&value))
                    .unwrap_or_else(|| "NULL".to_string()),
                row.get::<_, i64>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    columns.sort();
    lines.extend(columns);

    lines.extend(
        check_constraints(&create_sql)
            .into_iter()
            .map(|check| format!("check\u{1f}{check}")),
    );

    let index_list = conn
        .prepare("SELECT name, \"unique\", origin, partial FROM pragma_index_list(?1)")?
        .query_map(params![table], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut indexes = Vec::new();
    for (name, unique, origin, partial) in index_list {
        let key_columns = conn
            .prepare("SELECT COALESCE(name, '<expr>') FROM pragma_index_info(?1) ORDER BY seqno")?
            .query_map(params![name], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
            .join(",");
        let sql: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1",
                params![name],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        // An index SQLite made for a UNIQUE or PRIMARY KEY constraint is named by its
        // position in the CREATE statement, which differs between an evolved file and a
        // fresh one, so it is identified by what it covers instead.
        let identity = if origin == "c" {
            name.clone()
        } else {
            format!("{origin}:{key_columns}")
        };
        indexes.push(format!(
            "index\u{1f}{identity}\u{1f}{unique}\u{1f}{origin}\u{1f}{partial}\u{1f}{key_columns}\u{1f}{}",
            sql.map(|sql| normalize_schema_sql(&sql)).unwrap_or_default()
        ));
    }
    indexes.sort();
    lines.extend(indexes);

    let mut triggers = conn
        .prepare(
            "SELECT name, sql FROM sqlite_master
              WHERE type = 'trigger' AND tbl_name = ?1 AND sql IS NOT NULL",
        )?
        .query_map(params![table], |row| {
            Ok(format!(
                "trigger\u{1f}{}\u{1f}{}",
                row.get::<_, String>(0)?,
                normalize_schema_sql(&row.get::<_, String>(1)?)
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    triggers.sort();
    lines.extend(triggers);

    Ok(Some(lines.join("\u{1e}")))
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
    pub(crate) fn read(
        conn: &Connection,
        path: &Path,
        built_version: i64,
    ) -> Result<Self, HostStoreError> {
        let persisted_version =
            read_persisted_fence(conn)?.ok_or_else(|| HostStoreError::FenceMissing {
                path: path.display().to_string(),
            })?;
        let mut fingerprints = BTreeMap::new();
        for table in DOMAIN_TABLES.iter().chain(std::iter::once(&BRACKET_TABLE)) {
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

    /// True when the host has migrated past the lane this binary was built against.
    /// Informational: the fingerprints decide what is writable.
    pub fn lane_ahead(&self) -> bool {
        self.persisted_version > self.built_version
    }

    /// Allow writes only when the privilege-state table, target table and tables
    /// written by its triggers match this binary's expected schema fingerprints.
    fn check_write(&self, table: &str) -> Result<(), HostStoreError> {
        self.check_table(BRACKET_TABLE)?;
        if table == "compartments" {
            self.check_table("compartment_history_versions")?;
        }
        self.check_table(table)
    }

    /// The fence for one table. A table whose surface still hashes to the value this
    /// binary was built against is the table these writers know, at any migration lane.
    pub(crate) fn check_table(&self, table: &str) -> Result<(), HostStoreError> {
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
    visibility_budget: usize,
}

impl HostStore {
    /// Open `context.db` read/write against this binary's fence.
    pub fn open(path: &Path) -> Result<Self, HostStoreError> {
        Self::open_with_private_permissions(
            path,
            crate::config::private_storage_permissions_enabled(),
        )
    }

    /// Open against the user-tier privacy policy; tests use `open_with_fence` below.
    pub fn open_with_private_permissions(
        path: &Path,
        enforce_private_permissions: bool,
    ) -> Result<Self, HostStoreError> {
        Self::open_with_fence_and_private_permissions(
            path,
            BUILT_CONTEXT_FENCE_VERSION,
            enforce_private_permissions,
        )
    }

    /// Open against an explicit built fence.
    ///
    /// Tests use this to stand a database one lane ahead of the binary without shipping
    /// a migration; production always goes through [`HostStore::open`].
    pub fn open_with_fence(path: &Path, built_version: i64) -> Result<Self, HostStoreError> {
        Self::open_with_fence_and_private_permissions(path, built_version, true)
    }

    fn open_with_fence_and_private_permissions(
        path: &Path,
        built_version: i64,
        enforce_private_permissions: bool,
    ) -> Result<Self, HostStoreError> {
        let storage_dir = path.parent().unwrap_or_else(|| Path::new("."));
        ensure_directory(storage_dir, true).map_err(|error| HostStoreError::OpenFailed {
            path: path.display().to_string(),
            reason: error.to_string(),
        })?;
        let root_before = tighten_directory(storage_dir, true);
        let tree_before = tighten_tree(storage_dir, enforce_private_permissions);
        let before = mc_store::private_permissions::TightenReport {
            tightened: root_before.tightened + tree_before.tightened,
            failures: root_before.failures + tree_before.failures,
        };
        if !path.exists() {
            match create_file(path, true) {
                Ok(file) => drop(file),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(HostStoreError::OpenFailed {
                        path: path.display().to_string(),
                        reason: error.to_string(),
                    });
                }
            }
        }
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
        mc_store::single_store_domain::set_wal_synchronous_normal(&conn).map_err(|error| {
            HostStoreError::OpenFailed {
                path: path.display().to_string(),
                reason: format!("could not configure WAL durability: {error}"),
            }
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
        let root_after = tighten_directory(storage_dir, true);
        let tree_after = tighten_tree(storage_dir, enforce_private_permissions);
        tracing::info!(
            tightened = before.tightened + root_after.tightened + tree_after.tightened,
            failures = before.failures + root_after.failures + tree_after.failures,
            "mc-module: storage permission tightening"
        );
        Ok(HostStore {
            conn,
            path: path.to_path_buf(),
            fence,
            chunk_budget: DEFAULT_PUBLISH_CHUNK_ROWS,
            visibility_budget: MAX_VISIBILITY_CHUNK_ROWS,
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

    /// Override the visibility chunk's row ceiling. Tests use it to measure the chunk at
    /// sizes above the shipped ceiling.
    pub fn set_visibility_budget(&mut self, rows: usize) {
        self.visibility_budget = rows.max(1);
    }

    /// The domain tables this binary may write. Empty when the bracket table itself has
    /// changed, because no write can be made without it.
    pub fn writable_tables(&self) -> Vec<&'static str> {
        DOMAIN_TABLES
            .iter()
            .copied()
            .filter(|table| self.fence.check_write(table).is_ok())
            .collect()
    }

    /// Run `writes` in one `BEGIN IMMEDIATE` transaction under the privileged-writer bracket,
    /// after re-checking the schema of the fingerprinted tables among `tables`. A table the
    /// module writes but does not fingerprint (the mutation logs, `memory_verifications`)
    /// is not a fence input and is skipped here.
    pub fn with_domain_transaction(
        &mut self,
        tables: &[&str],
        writes: &mut dyn FnMut(&Transaction<'_>) -> rusqlite::Result<()>,
    ) -> Result<(), HostStoreError> {
        let fenced: Vec<&str> = tables
            .iter()
            .copied()
            .filter(|table| DOMAIN_TABLES.contains(table))
            .collect();
        let fence = self.fence.clone();
        with_privileged_transaction(&mut self.conn, &fence, &fenced, |tx| {
            writes(tx).map_err(HostStoreError::from)
        })
        .map(|_| ())
    }

    /// The health block the status surface reports.
    pub fn health_value(&self) -> Value {
        let mut tables = serde_json::Map::new();
        for table in DOMAIN_TABLES.iter().chain(std::iter::once(&BRACKET_TABLE)) {
            let state = match self.fence.check_write(table) {
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
            "path": self.path.display().to_string(),
            "fence": {
                "persisted_version": self.fence.persisted_version,
                "built_version": self.fence.built_version,
                "lane_ahead": self.fence.lane_ahead(),
            },
            "tables": Value::Object(tables),
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
    live_fence.check_table(BRACKET_TABLE)?;
    for table in tables {
        live_fence.check_table(table)?;
    }
    // Compartment triggers write the revision table even when the callback does not.
    if tables.contains(&"compartments") {
        live_fence.check_table("compartment_history_versions")?;
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

/// Replace the session's compartments from the publish's first sequence upward.
///
/// A fold is an append, so on a first attempt nothing sits at or above that sequence and
/// this is a plain insert. Anything that does sit there is a row this publish supersedes:
/// most often the same fold's own rows from an attempt whose visibility chunk committed
/// before the retry, otherwise a stale tail. Replacing it gives the session the row set
/// the host's `replaceAllCompartmentState` leaves when handed the rows below the fold
/// plus the fold itself, and it is what makes a retried visibility chunk idempotent
/// rather than an abort on `UNIQUE(session_id, sequence)`.
///
/// Events that pointed at a replaced compartment go with it. The host leaves such events
/// pointing at a deleted id; here they would be re-inserted by the retry beside the
/// originals, so they are removed with the rows they describe.
///
/// `session_meta` is deliberately left alone. It holds the cached rendering of the
/// session's history prefix (the m0/m1 messages), and clearing it would force that prefix
/// to be re-rendered, changing bytes the provider has cached, on a pass that was otherwise
/// replaying them. A historian publish must never cause that by itself. The host's own
/// fold path (`appendCompartments`) clears nothing either: the reader notices the new
/// rows through the highest compartment sequence it recorded with the cache, and picks
/// them up on the next pass that re-renders for another reason.
fn replace_compartments_from_first_sequence(
    tx: &Transaction<'_>,
    publish: &FoldPublish,
) -> Result<Vec<i64>, HostStoreError> {
    if let Some(first_sequence) = publish.compartments.iter().map(|c| c.sequence).min() {
        tx.execute(
            "DELETE FROM compartment_events
              WHERE session_id = ?1
                AND compartment_id IN (
                    SELECT id FROM compartments WHERE session_id = ?1 AND sequence >= ?2
                )",
            params![publish.session_id, first_sequence],
        )?;
        tx.execute(
            "DELETE FROM compartments WHERE session_id = ?1 AND sequence >= ?2",
            params![publish.session_id, first_sequence],
        )?;
    }
    // An event whose anchor resolved to no compartment carries no id to match on. One
    // stamped with this publish's instant was written by an earlier attempt of this same
    // publish, and would otherwise be written a second time.
    tx.execute(
        "DELETE FROM compartment_events
          WHERE session_id = ?1 AND compartment_id IS NULL AND created_at = ?2",
        params![publish.session_id, publish.now_ms],
    )?;
    insert_compartments(tx, publish)
}

fn insert_compartments(
    tx: &Transaction<'_>,
    publish: &FoldPublish,
) -> Result<Vec<i64>, HostStoreError> {
    let mut ids = Vec::with_capacity(publish.compartments.len());
    let mut statement = tx.prepare(
        "INSERT INTO compartments
           (session_id, sequence, start_message, end_message, start_message_id, end_message_id,
            title, content, p1, p2, p3, p4, importance, episode_type, legacy, created_at, harness, start_block_index, end_block_index)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
    )?;
    for compartment in &publish.compartments {
        let (start_id, start_block) =
            mc_store::context_boundaries::canonical_boundary_parts(&compartment.start_message_id)?;
        let (end_id, end_block) =
            mc_store::context_boundaries::canonical_boundary_parts(&compartment.end_message_id)?;
        statement.execute(params![
            publish.session_id,
            compartment.sequence,
            compartment.start_message,
            compartment.end_message,
            start_id,
            end_id,
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
            start_block,
            end_block,
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
///
/// A retried publish finds the rows an interrupted attempt already wrote: a live memory
/// last seen at this publish's own instant was recorded by this publish, so it is neither
/// inserted again nor counted as seen a second time. Its id is still reported when this
/// publish created it, so the embedding watermark covers it.
fn insert_memories(
    tx: &Transaction<'_>,
    publish: &FoldPublish,
) -> Result<Vec<i64>, HostStoreError> {
    let mut ids = Vec::with_capacity(publish.memories.len());
    let mut existing = tx.prepare(
        "SELECT id, last_seen_at, created_at FROM memories
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
        if let Some((id, last_seen_at, created_at)) = existing
            .query_row(params![publish.project_path, memory.content], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .optional()?
        {
            if last_seen_at == publish.now_ms {
                if created_at == publish.now_ms {
                    ids.push(id);
                }
                continue;
            }
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
    // The same note, for the same session, stamped with this publish's instant, is this
    // publish's own row from an interrupted attempt.
    let mut already_written = tx.prepare(
        "SELECT 1 FROM notes
          WHERE type = 'session' AND session_id = ?1 AND content = ?2
            AND created_at = ?3 AND harness = ?4
          LIMIT 1",
    )?;
    for note in &publish.notes {
        if already_written.exists(params![
            publish.session_id,
            note.content,
            publish.now_ms,
            publish.harness,
        ])? {
            continue;
        }
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
    // Every column of an observation is matched: an identical row already present is this
    // publish's own from an interrupted attempt.
    let mut already_written = tx.prepare(
        "SELECT 1 FROM user_memory_candidates
          WHERE content = ?1 AND session_id = ?2
            AND source_compartment_start IS ?3 AND source_compartment_end IS ?4
            AND created_at = ?5
          LIMIT 1",
    )?;
    for observation in &publish.user_observations {
        let content = observation.content.trim();
        if content.is_empty() {
            continue;
        }
        if already_written.exists(params![
            content,
            publish.session_id,
            observation.source_compartment_start,
            observation.source_compartment_end,
            observation.created_at,
        ])? {
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
    // Promoted at this publish's instant from the same candidates: this publish's own row.
    let mut already_written = tx.prepare(
        "SELECT 1 FROM user_memories
          WHERE content = ?1 AND promoted_at = ?2 AND source_candidate_ids = ?3
          LIMIT 1",
    )?;
    for memory in &publish.user_memories {
        let candidate_ids = Value::Array(
            memory
                .source_candidate_ids
                .iter()
                .map(|id| json!(id))
                .collect(),
        )
        .to_string();
        if already_written.exists(params![memory.content, publish.now_ms, candidate_ids])? {
            continue;
        }
        let provenance = user_memory_provenance(tx, &memory.source_candidate_ids)?;
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
pub(crate) fn raise_embedding_watermark(
    tx: &Connection,
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
            // The facts delete and the compartment replace each count as one row of work
            // whether or not any rows follow them, so a pass that only removes rows is not
            // scored as free.
            Chunk::Visibility => {
                publish.compartments.len() + publish.facts.len() + publish.events.len() + 2
            }
        }
    }

    /// The tables this chunk writes, and so the only ones whose fingerprint it depends on.
    /// A publish that writes no note is not refused because `notes` changed.
    fn tables(&self) -> Vec<&'static str> {
        match self {
            Chunk::Staged {
                memories,
                notes,
                primer_candidates,
                user_observations,
                user_memories,
            } => {
                let mut tables = Vec::new();
                if !memories.is_empty() {
                    tables.extend(["memories", "memory_embedding_watermarks"]);
                }
                if !notes.is_empty() {
                    tables.push("notes");
                }
                if !primer_candidates.is_empty() {
                    tables.push("primer_candidates");
                }
                // Promoting a user memory reads its candidates for provenance.
                if !user_observations.is_empty() || !user_memories.is_empty() {
                    tables.push("user_memory_candidates");
                }
                if !user_memories.is_empty() {
                    tables.push("user_memories");
                }
                tables
            }
            Chunk::Visibility => vec!["compartments", "compartment_events", "session_facts"],
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
        self.publish_fold_observed(publish, &mut |_| {})
    }

    /// [`HostStore::publish_fold`], calling `observer` after each chunk commits.
    ///
    /// The observer runs between two transactions, so it is the one place a test can stand
    /// in for everything that happens there in production: a crash, a host migration, a
    /// second writer.
    pub fn publish_fold_observed(
        &mut self,
        publish: &FoldPublish,
        observer: &mut dyn FnMut(ChunkCommitted),
    ) -> Result<PublishOutcome, HostStoreError> {
        counted(self.publish_chunks(publish, observer))
    }

    /// The chunk loop behind [`HostStore::publish_fold_observed`].
    ///
    /// Retry is resume: every staged writer recognises the rows an interrupted attempt of
    /// the same publish already committed (they carry the publish's own instant) and does
    /// not write them again, and the visibility chunk replaces rather than appends. So a
    /// publish that died between chunks, or was refused between chunks by a migration, is
    /// completed by running the same publish again, and running a completed one again
    /// changes nothing.
    fn publish_chunks(
        &mut self,
        publish: &FoldPublish,
        observer: &mut dyn FnMut(ChunkCommitted),
    ) -> Result<PublishOutcome, HostStoreError> {
        let budget = self.chunk_budget;
        let chunks = plan_chunks(publish, budget);
        // Every chunk is sized before the first one is written, so a publish that cannot
        // fit is refused whole instead of leaving its staged rows behind.
        for chunk in &chunks {
            let rows = chunk.rows(publish);
            let limit = match chunk {
                Chunk::Staged { .. } => budget,
                Chunk::Visibility => self.visibility_budget,
            };
            if rows > limit {
                return Err(HostStoreError::ChunkBudgetExceeded {
                    rows,
                    budget: limit,
                });
            }
        }
        let mut outcome = PublishOutcome::default();

        for chunk in chunks {
            let rows = chunk.rows(publish);
            let fence = self.fence.clone();
            let tables = chunk.tables();
            let (chunk_result, elapsed_us) =
                with_privileged_transaction(&mut self.conn, &fence, &tables, |tx| {
                    apply_chunk(tx, publish, &chunk, &outcome)
                })?;
            outcome.chunk_rows.push(rows);
            outcome.chunk_durations_us.push(elapsed_us);
            outcome.memory_ids.extend(chunk_result.memory_ids);
            if let Some(watermark) = chunk_result.embedding_watermark {
                outcome.embedding_watermark = watermark;
            }
            outcome.compartment_ids.extend(chunk_result.compartment_ids);
            observer(ChunkCommitted {
                index: outcome.chunk_rows.len() - 1,
                rows,
                visibility: matches!(chunk, Chunk::Visibility),
            });
        }
        Ok(outcome)
    }
}

/// One chunk that has just committed, as reported to a publish observer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkCommitted {
    /// Zero-based position of the chunk in the publish.
    pub index: usize,
    pub rows: usize,
    /// True for the final chunk, the one that makes the fold visible.
    pub visibility: bool,
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
            result.compartment_ids = replace_compartments_from_first_sequence(tx, publish)?;
            insert_compartment_events(tx, publish, &result.compartment_ids)?;
            let _ = so_far;
        }
    }
    Ok(result)
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
        // The host takes Node's `os.homedir()` here, which also answers on Windows (where
        // `HOME` is usually unset) and when `HOME` is empty. The current directory is the
        // last resort only when no home can be found at all.
        crate::config::user_home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".local")
            .join("share")
            .join("cortexkit")
            .join("magic-context")
    };
    storage_dir.join("context.db")
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
        for table in DOMAIN_TABLES.iter().chain(std::iter::once(&BRACKET_TABLE)) {
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
    fn freshly_opened_host_store_uses_wal_normal() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        let store = HostStore::open(&path).unwrap();
        let journal: String = store
            .conn
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        let synchronous: i64 = store
            .conn
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .unwrap();
        assert_eq!(journal, "wal");
        assert_eq!(synchronous, 1);
    }

    /// The lane alone refuses nothing: a database migrated past this binary whose domain
    /// tables still carry the fingerprints it was built against is written normally, and
    /// the status block says the lane is ahead.
    #[test]
    fn a_database_one_lane_ahead_with_unchanged_tables_stays_writable() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");
        let mut store = HostStore::open_with_fence(&path, BUILT_CONTEXT_FENCE_VERSION - 1).unwrap();

        assert!(store.fence().lane_ahead());
        assert_eq!(store.writable_tables(), DOMAIN_TABLES.to_vec());
        assert_eq!(store.health_value()["fence"]["lane_ahead"], json!(true));
        store.publish_fold(&sample_publish()).unwrap();
    }

    /// Every chunk flips the privilege row, so a change to its table refuses every write,
    /// not only writes to one domain table.
    #[test]
    fn a_change_to_the_privilege_table_refuses_every_domain_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("ALTER TABLE context_privilege_state ADD COLUMN project_path TEXT;")
                .unwrap();
        }
        let mut store = HostStore::open(&path).unwrap();
        assert!(store.writable_tables().is_empty());
        let error = store.publish_fold(&sample_publish()).unwrap_err();
        assert_eq!(error.code(), "single_store_fingerprint_mismatch");
        assert!(error.to_string().contains(BRACKET_TABLE), "{error}");
        let conn = Connection::open(&path).unwrap();
        let memories: i64 = conn
            .query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))
            .unwrap();
        assert_eq!(memories, 0, "a refused publish must write nothing");
    }

    #[test]
    fn v92_opens_but_compartment_writes_require_the_v93_revision_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("DROP TRIGGER compartment_history_ai; DROP TRIGGER compartment_history_au; DROP TRIGGER compartment_history_ad; DROP TABLE compartment_history_versions; DELETE FROM schema_migrations WHERE version>=93").unwrap();
        let mut store = HostStore::open(&path).unwrap();
        assert_eq!(store.fence().persisted_version, 92);
        assert!(store.writable_tables().contains(&"memories"));
        assert!(!store.writable_tables().contains(&"compartments"));
        let error = store.publish_fold(&sample_publish()).unwrap_err();
        assert_eq!(error.code(), "single_store_fingerprint_mismatch");
        assert_eq!(
            conn.query_row("SELECT count(*) FROM compartments", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn revision_table_drift_refuses_compartment_writes_including_trigger_side_effects() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        let mut store = HostStore::open(&path).unwrap();
        Connection::open(&path)
            .unwrap()
            .execute_batch("ALTER TABLE compartment_history_versions ADD COLUMN extra TEXT")
            .unwrap();
        let error = store.publish_fold(&sample_publish()).unwrap_err();
        assert_eq!(error.code(), "single_store_fingerprint_mismatch");
        assert!(
            error.to_string().contains("compartment_history_versions"),
            "{error}"
        );
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
        assert!(store.writable_tables().contains(&"memories"));
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
        let mut conn = Connection::open(path).unwrap();
        conn.busy_timeout(std::time::Duration::from_millis(5_000))
            .unwrap();
        // All four reads share one read transaction, so they see one snapshot of the
        // file. Run as separate autocommit statements, each read would take its own
        // snapshot, and a fold committing between two of them would be reported as a
        // torn publish even though it landed in a single transaction.
        let conn = conn.transaction().unwrap();
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
        let health = store.health_value();
        assert_eq!(health["capable"], json!(true));
        assert_eq!(
            health["fence"]["persisted_version"],
            json!(BUILT_CONTEXT_FENCE_VERSION)
        );
        assert_eq!(health["fence"]["lane_ahead"], json!(false));
        assert_eq!(health["tables"]["memories"]["writable"], json!(true));
        assert_eq!(health["tables"]["notes"]["writable"], json!(false));
        assert_eq!(
            health["tables"]["notes"]["error_code"],
            json!("single_store_fingerprint_mismatch")
        );
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

    // ── Chunk budget measurement ────────────────────────────────────────────

    /// Row counts of a `context.db` that has been in daily use for a while. The chunk
    /// budget is measured and held on a store this size, not on an empty one: full-text
    /// segment merges, index depth and the memory de-duplication lookup all grow with
    /// what is already there. A 64-row memory chunk took about 5 ms on the empty schema
    /// and 60-140 ms on this seed.
    const REALISTIC_MEMORIES: usize = 2_000;
    const REALISTIC_COMPARTMENTS: usize = 11_000;
    const REALISTIC_NOTES: usize = 1_000;
    const REALISTIC_TAGS: usize = 1_000_000;
    /// Sessions the seeded rows are spread over.
    const SEEDED_SESSIONS: usize = 200;

    /// Seed a fixture to production-like row counts. `tags` is separate because it is by
    /// far the largest table and no module write touches it or its indexes; the
    /// instrument below measures with and without it.
    fn seed_realistic_store(path: &Path, tags: usize) {
        let mut conn = Connection::open(path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        let tx = conn.transaction().unwrap();
        // The authority guards abort writes to a managed project unless the bracket row
        // is set; the seed is not what is being measured, so it simply holds the bracket.
        tx.execute(
            "UPDATE context_privilege_state SET enabled = 1 WHERE id = 1",
            [],
        )
        .unwrap();
        {
            let mut memory = tx
                .prepare(
                    "INSERT INTO memories
                       (project_path, category, content, normalized_hash, importance,
                        source_session_id, first_seen_at, created_at, updated_at, last_seen_at)
                     VALUES (?1, 'ARCHITECTURE', ?2, ?3, 50, ?4, 1, 1, 1, 1)",
                )
                .unwrap();
            for index in 0..REALISTIC_MEMORIES {
                let project = if index % 2 == 0 {
                    "git:fixture"
                } else {
                    "git:other"
                };
                let content = format!(
                    "seeded memory {index} about module {} and the {} path, noting that \
                     subsystem {} depends on {} when the {} flag is set",
                    index % 97,
                    index % 13,
                    index % 31,
                    index % 17,
                    index % 7
                );
                memory
                    .execute(params![
                        project,
                        content,
                        compute_normalized_hash(&content),
                        format!("ses_seed_{}", index % SEEDED_SESSIONS),
                    ])
                    .unwrap();
            }
            let mut compartment = tx
                .prepare(
                    "INSERT INTO compartments
                       (session_id, sequence, start_message, end_message, start_message_id,
                        end_message_id, title, content, p1, p2, importance, legacy, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?7, 50, 0, 1)",
                )
                .unwrap();
            for index in 0..REALISTIC_COMPARTMENTS {
                let session = index % SEEDED_SESSIONS;
                let sequence = (index / SEEDED_SESSIONS) as i64 + 1;
                compartment
                    .execute(params![
                        format!("ses_seed_{session}"),
                        sequence,
                        sequence * 10,
                        sequence * 10 + 9,
                        format!("msg_{session}_{sequence}_a"),
                        format!("msg_{session}_{sequence}_z"),
                        format!("compartment {sequence} of session {session}"),
                        format!(
                            "The session worked through step {sequence}: it read the code, \
                             changed the module, ran the suite and recorded what it found. {}",
                            "Detail. ".repeat(40)
                        ),
                    ])
                    .unwrap();
            }
            let mut note = tx
                .prepare(
                    "INSERT INTO notes (type, status, content, session_id, created_at, updated_at)
                     VALUES ('session', 'active', ?1, ?2, 1, 1)",
                )
                .unwrap();
            for index in 0..REALISTIC_NOTES {
                note.execute(params![
                    format!("seeded note {index}: remember to revisit the fence"),
                    format!("ses_seed_{}", index % SEEDED_SESSIONS),
                ])
                .unwrap();
            }
        }
        tx.execute(
            "UPDATE context_privilege_state SET enabled = 0 WHERE id = 1",
            [],
        )
        .unwrap();
        tx.commit().unwrap();

        if tags > 0 {
            // The tags triggers bump a per-session counter on every insert; they are
            // taken off for the bulk load and put back verbatim, so the schema the module
            // then meets is the committed one.
            let triggers: Vec<(String, String)> = conn
                .prepare(
                    "SELECT name, sql FROM sqlite_master
                      WHERE type = 'trigger' AND tbl_name = 'tags'",
                )
                .unwrap()
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            let tx = conn.transaction().unwrap();
            for (name, _) in &triggers {
                tx.execute_batch(&format!("DROP TRIGGER {name}")).unwrap();
            }
            {
                let mut tag = tx
                    .prepare(
                        "INSERT INTO tags
                           (session_id, message_id, type, byte_size, tag_number, tool_name,
                            token_count, entry_fingerprint)
                         VALUES (?1, ?2, 'tool', 512, ?3, 'read', 128, ?4)",
                    )
                    .unwrap();
                for index in 0..tags {
                    let session = index % SEEDED_SESSIONS;
                    let number = (index / SEEDED_SESSIONS) as i64 + 1;
                    tag.execute(params![
                        format!("ses_seed_{session}"),
                        format!("msg_{session}_{}", number / 4),
                        number,
                        format!("fp_{index:x}"),
                    ])
                    .unwrap();
                }
            }
            for (_, sql) in &triggers {
                tx.execute_batch(sql).unwrap();
            }
            tx.commit().unwrap();
        }
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
            .unwrap();
    }

    fn memories_only_publish(count: usize, salt: &str) -> FoldPublish {
        let mut publish = sample_publish();
        publish.compartments.clear();
        publish.facts.clear();
        publish.events.clear();
        publish.notes.clear();
        publish.primer_candidates.clear();
        publish.user_observations.clear();
        publish.memories = (0..count)
            .map(|index| HostMemory {
                category: "ARCHITECTURE".to_string(),
                content: format!(
                    "measured memory {salt} {index} with enough prose to give the full-text index real work to do"
                ),
                ..HostMemory::default()
            })
            .collect();
        publish
    }

    /// A fold whose visibility chunk carries `compartments` compartments with one fact and
    /// one event per compartment, appended after a seeded session's existing history.
    fn visibility_publish(compartments: usize, session: &str, first_sequence: i64) -> FoldPublish {
        let mut publish = sample_publish();
        publish.session_id = session.to_string();
        publish.memories.clear();
        publish.notes.clear();
        publish.primer_candidates.clear();
        publish.user_observations.clear();
        publish.compartments = (0..compartments)
            .map(|index| HostCompartment {
                sequence: first_sequence + index as i64,
                start_message: 10_000 + index as i64 * 4,
                end_message: 10_003 + index as i64 * 4,
                start_message_id: format!("msg_new_{index}_a"),
                end_message_id: format!("msg_new_{index}_d"),
                title: format!("measured compartment {index}"),
                content: format!("measured body {index} {}", "Detail. ".repeat(40)),
                p1: Some(format!("measured body {index}")),
                importance: Some(60),
                created_at: 1_700_000_000_000,
                ..HostCompartment::default()
            })
            .collect();
        publish.facts = (0..compartments)
            .map(|index| HostSessionFact {
                category: "Decisions".to_string(),
                content: format!("measured fact {index}"),
            })
            .collect();
        publish.events = (0..compartments)
            .map(|index| HostCompartmentEvent {
                kind: "causal_incident".to_string(),
                at_compartment: Some(index as i64 + 1),
                fields_json: "{}".to_string(),
            })
            .collect();
        publish
    }

    /// Hold the shipped budgets to the wall-clock ceiling they were derived from, on a
    /// store seeded to production-like row counts.
    ///
    /// The budgets are row counts, but the thing that matters is how long a seat can be
    /// made to wait. This publishes the shipped staged budget's worth of the most
    /// expensive row class — a memory, whose insert drives an external-content full-text
    /// delete and insert — and a visibility chunk at its shipped ceiling, and fails if
    /// either transaction runs past `PUBLISH_CHUNK_BUDGET_US`. The seed leaves out the
    /// million tag rows: no module write touches that table, and the instrument below
    /// shows chunk cost does not move with it.
    ///
    /// It measures wall-clock time, so it is only meaningful on an unloaded machine: under
    /// heavy parallel load (other test binaries, builds) the same chunks take several times
    /// longer and the test fails for reasons unrelated to the budgets. It therefore does not
    /// run in the default suite; run it with `--ignored` when changing a budget.
    #[test]
    #[ignore = "wall-clock measurement; run with --ignored on an unloaded machine"]
    fn the_shipped_chunk_budgets_hold_their_wall_clock_ceiling_on_a_realistic_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        mark_managed(&path, "git:fixture");
        seed_realistic_store(&path, 0);
        let mut store = HostStore::open(&path).unwrap();

        let mut worst_staged = 0;
        for round in 0..3 {
            let outcome = store
                .publish_fold(&memories_only_publish(
                    DEFAULT_PUBLISH_CHUNK_ROWS,
                    &format!("round{round}"),
                ))
                .unwrap();
            worst_staged = worst_staged.max(outcome.max_chunk_duration_us());
        }
        // Rows per compartment in the visibility chunk: the compartment, its fact and its
        // event. Two more are the facts delete and the compartment replace.
        let compartments = (MAX_VISIBILITY_CHUNK_ROWS - 2) / 3;
        let visibility = store
            .publish_fold(&visibility_publish(compartments, "ses_seed_7", 1_000))
            .unwrap();
        let worst_visibility = *visibility.chunk_durations_us.last().unwrap();

        assert!(
            worst_staged < PUBLISH_CHUNK_BUDGET_US,
            "a {DEFAULT_PUBLISH_CHUNK_ROWS}-row staged chunk held its transaction for {worst_staged}us, over the {PUBLISH_CHUNK_BUDGET_US}us ceiling"
        );
        assert!(
            worst_visibility < PUBLISH_CHUNK_BUDGET_US,
            "a {MAX_VISIBILITY_CHUNK_ROWS}-row visibility chunk held its transaction for {worst_visibility}us, over the {PUBLISH_CHUNK_BUDGET_US}us ceiling"
        );
        println!(
            "single_store chunk measurement (seeded): staged_rows={DEFAULT_PUBLISH_CHUNK_ROWS} worst_staged_us={worst_staged} visibility_rows={MAX_VISIBILITY_CHUNK_ROWS} visibility_us={worst_visibility} ceiling_us={PUBLISH_CHUNK_BUDGET_US}"
        );
    }

    /// Re-derive the budgets by sweeping chunk sizes on a store seeded to production-like
    /// row counts, with and without the million tag rows.
    ///
    /// Not part of the ordinary suite: it is a measuring instrument, and its output is a
    /// table of numbers rather than a pass/fail claim. Run it when a budget needs
    /// revisiting:
    ///   cargo test -p mc-module --lib host_store::tests::measure -- --ignored --nocapture
    #[test]
    #[ignore = "measurement instrument, not an assertion"]
    fn measure_chunk_cost_on_a_realistic_store() {
        for tags in [0, REALISTIC_TAGS] {
            let template_dir = tempfile::tempdir().unwrap();
            let template = fixture_db(template_dir.path(), "template.db");
            mark_managed(&template, "git:fixture");
            let seed_started = Instant::now();
            seed_realistic_store(&template, tags);
            println!(
                "seeded tags={tags} in {:?}, file {} bytes",
                seed_started.elapsed(),
                std::fs::metadata(&template).unwrap().len()
            );
            for rows in [16_usize, 32, 64, 128, 256, 512] {
                let dir = tempfile::tempdir().unwrap();
                let path = dir.path().join("context.db");
                std::fs::copy(&template, &path).unwrap();
                let mut store = HostStore::open(&path).unwrap();
                store.set_chunk_budget(rows);
                store.set_visibility_budget(usize::MAX);
                let mut staged = Vec::new();
                for round in 0..5 {
                    let outcome = store
                        .publish_fold(&memories_only_publish(rows, &format!("r{round}")))
                        .unwrap();
                    staged.push(outcome.max_chunk_duration_us());
                }
                let mut visibility = Vec::new();
                for round in 0..5 {
                    let compartments = rows.saturating_sub(2) / 3;
                    let outcome = store
                        .publish_fold(&visibility_publish(
                            compartments.max(1),
                            &format!("ses_seed_{round}"),
                            1_000,
                        ))
                        .unwrap();
                    visibility.push(*outcome.chunk_durations_us.last().unwrap());
                }
                staged.sort_unstable();
                visibility.sort_unstable();
                println!(
                    "tags={tags} rows={rows} staged_us(min/median/max)={}/{}/{} visibility_us(min/median/max)={}/{}/{}",
                    staged[0],
                    staged[2],
                    staged[4],
                    visibility[0],
                    visibility[2],
                    visibility[4]
                );
            }
        }
    }
}
