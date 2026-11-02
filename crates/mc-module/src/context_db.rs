//! `context.db`, the store ck-mc shares with every standalone Magic Context
//! plugin: summaries, memories, notes and the search index live there.
//!
//! ck-mc never migrates it. The TypeScript plugin owns the schema, and ck-mc
//! opens a store only at exactly the version this build was compiled against,
//! read from the plugin's own source. A store at any other version is refused
//! by name, so a newer or older plugin can never be misread.
//!
//! A mode-3 session's rows are keyed by its host (`harness`) and the host's own
//! session id, the same key a standalone plugin uses for that session. Writes
//! are short `BEGIN IMMEDIATE` transactions, since standalone hosts write the
//! same file.

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};

use crate::summary::validate::ValidatedCompartment;

const STORAGE_SOURCE: &str =
    include_str!("../../../packages/plugin/src/features/magic-context/storage-db.ts");
const MIGRATION_SOURCE: &str =
    include_str!("../../../packages/plugin/src/features/magic-context/migrations.ts");

/// The schema version this build reads: the plugin's `LATEST_SUPPORTED_VERSION`.
pub const SCHEMA_VERSION: u32 =
    declared_number(STORAGE_SOURCE, "export const LATEST_SUPPORTED_VERSION = ");

/// Migration versions at or above this belong to forks of the plugin and do
/// not count toward the schema version.
const FORK_VERSION_FLOOR: u32 = declared_number(
    MIGRATION_SOURCE,
    "export const FORK_MIGRATION_VERSION_FLOOR = ",
);

/// The fresh schema at [`SCHEMA_VERSION`], generated from the plugin's
/// migration chain. Only stores ck-mc creates for tests use it.
const FRESH_SCHEMA: &str = include_str!("../testdata/context-schema.sql");

/// A numeric literal declared in TypeScript source, read at compile time so
/// an installed binary needs no TypeScript files.
const fn declared_number(source: &str, declaration: &str) -> u32 {
    let source = source.as_bytes();
    let declaration = declaration.as_bytes();
    let mut offset = 0;
    while offset + declaration.len() < source.len() {
        let mut matched = 0;
        while matched < declaration.len() && source[offset + matched] == declaration[matched] {
            matched += 1;
        }
        if matched == declaration.len() {
            let mut position = offset + matched;
            let mut value = 0;
            let mut digits = 0;
            while position < source.len() {
                let byte = source[position];
                if byte.is_ascii_digit() {
                    value = value * 10 + (byte - b'0') as u32;
                    digits += 1;
                } else if byte != b'_' {
                    break;
                }
                position += 1;
            }
            assert!(digits > 0, "the declaration must be a numeric literal");
            return value;
        }
        offset += 1;
    }
    panic!("declaration not found");
}

/// One summary of a stretch of messages, as stored.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoredCompartment {
    pub sequence: i64,
    /// The first and last message the summary covers, as message numbers
    /// (the runner's ordinal plus one).
    pub start_message: i64,
    pub end_message: i64,
    pub start_message_id: String,
    pub end_message_id: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub title: String,
    /// The most detailed tier, or the whole body of a summary from before
    /// tiers existed.
    pub content: String,
    /// The four detail tiers, most detailed first; absent for old rows.
    pub p1: Option<String>,
    pub p2: Option<String>,
    pub p3: Option<String>,
    pub p4: Option<String>,
    /// How long the summary stays detailed as it ages (1 to 100).
    pub importance: i32,
    pub episode_type: Option<String>,
    /// 1 for a summary from before tiers existed.
    pub legacy: i32,
    pub created_at: i64,
}

/// A project memory, as the summarizer prompt and the history head read it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoredMemory {
    pub id: i64,
    pub project_path: String,
    pub category: String,
    pub content: String,
    pub importance: Option<i32>,
    pub status: String,
    pub expires_at: Option<i64>,
    pub superseded_by_memory_id: Option<i64>,
    pub updated_at: i64,
    pub last_seen_at: Option<i64>,
    pub verified_at: Option<i64>,
}

impl From<&ValidatedCompartment> for StoredCompartment {
    fn from(compartment: &ValidatedCompartment) -> Self {
        Self {
            sequence: compartment.sequence as i64,
            start_message: compartment.start_message as i64,
            end_message: compartment.end_message as i64,
            start_message_id: compartment.start_message_id.clone(),
            end_message_id: compartment.end_message_id.clone(),
            start_date: None,
            end_date: None,
            title: compartment.title.clone(),
            content: compartment.content.clone(),
            p1: compartment.p1.clone(),
            p2: compartment.p2.clone(),
            p3: compartment.p3.clone(),
            p4: compartment.p4.clone(),
            importance: compartment.importance.unwrap_or(50) as i32,
            episode_type: compartment.episode_type.clone(),
            legacy: i32::from(compartment.p1.as_deref().is_none_or(str::is_empty)),
            created_at: 0,
        }
    }
}

pub struct ContextDb {
    connection: Mutex<Connection>,
}

impl ContextDb {
    /// Open an existing store. Refuses a missing file (standalone plugins
    /// create it) and any schema version but [`SCHEMA_VERSION`].
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|error| format!("context.db {}: {error}", path.display()))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| error.to_string())?;
        let found: i64 = connection
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations WHERE version < ?1",
                params![FORK_VERSION_FLOOR],
                |row| row.get(0),
            )
            .map_err(|error| format!("context.db {}: {error}", path.display()))?;
        if found != i64::from(SCHEMA_VERSION) {
            return Err(format!(
                "context.db {} is at schema version {found}; this ck-mc reads version {SCHEMA_VERSION}",
                path.display()
            ));
        }
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// Create a store with the fresh schema, for tests and throwaway runs.
    /// Refuses a path that already exists.
    pub fn create_for_tests(path: &Path) -> Result<Self, String> {
        if path.exists() {
            return Err(format!("{} already exists", path.display()));
        }
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        // The snapshot binds the migration time as a named parameter.
        let schema = FRESH_SCHEMA.replace(":applied_at", "0");
        connection
            .execute_batch(&schema)
            .map_err(|error| format!("fresh schema: {error}"))?;
        drop(connection);
        Self::open(path)
    }

    /// A session's summaries, oldest first.
    pub fn compartments(
        &self,
        harness: &str,
        session: &str,
    ) -> Result<Vec<StoredCompartment>, String> {
        let connection = self.lock();
        let mut statement = connection
            .prepare_cached(
                "SELECT sequence, start_message, end_message, COALESCE(start_message_id, ''),
                        COALESCE(end_message_id, ''), title, content, p1, p2, p3, p4,
                        importance, episode_type, legacy, created_at
                   FROM compartments
                  WHERE session_id = ?1 AND harness = ?2
                  ORDER BY sequence",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![session, harness], |row| {
                Ok(StoredCompartment {
                    sequence: row.get(0)?,
                    start_message: row.get(1)?,
                    end_message: row.get(2)?,
                    start_message_id: row.get(3)?,
                    end_message_id: row.get(4)?,
                    start_date: None,
                    end_date: None,
                    title: row.get(5)?,
                    content: row.get(6)?,
                    p1: row.get(7)?,
                    p2: row.get(8)?,
                    p3: row.get(9)?,
                    p4: row.get(10)?,
                    importance: row.get(11)?,
                    episode_type: row.get(12)?,
                    legacy: row.get(13)?,
                    created_at: row.get(14)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>()
            .map_err(|error| error.to_string())
    }

    /// Store validated summaries. Each carries its own sequence number; a
    /// sequence already stored for the session fails the whole append.
    pub fn append_compartments(
        &self,
        harness: &str,
        session: &str,
        compartments: &[ValidatedCompartment],
        now_ms: i64,
    ) -> Result<(), String> {
        let mut connection = self.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        {
            let mut insert = transaction
                .prepare_cached(
                    "INSERT INTO compartments
                        (session_id, sequence, start_message, end_message, start_message_id,
                         end_message_id, title, content, p1, p2, p3, p4, importance,
                         episode_type, legacy, created_at, harness)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                )
                .map_err(|error| error.to_string())?;
            for compartment in compartments {
                // A summary with tiers is current; one without is the old flat form.
                let legacy = i32::from(compartment.p1.as_deref().is_none_or(str::is_empty));
                insert
                    .execute(params![
                        session,
                        compartment.sequence as i64,
                        compartment.start_message as i64,
                        compartment.end_message as i64,
                        compartment.start_message_id,
                        compartment.end_message_id,
                        compartment.title,
                        compartment.content,
                        compartment.p1,
                        compartment.p2,
                        compartment.p3,
                        compartment.p4,
                        compartment.importance.unwrap_or(50) as i64,
                        compartment.episode_type,
                        legacy,
                        now_ms,
                        harness,
                    ])
                    .map_err(|error| error.to_string())?;
            }
        }
        transaction.commit().map_err(|error| error.to_string())
    }

    /// Delete a session's summaries from `sequence` on, after a revert removed
    /// messages they cover.
    pub fn delete_compartments_from(
        &self,
        harness: &str,
        session: &str,
        sequence: i64,
    ) -> Result<(), String> {
        self.lock()
            .execute(
                "DELETE FROM compartments WHERE session_id = ?1 AND harness = ?2 AND sequence >= ?3",
                params![session, harness, sequence],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_store_opens_and_round_trips_summaries() {
        let dir = std::env::temp_dir().join(format!("ck-mc-context-db-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
        let compartment = ValidatedCompartment {
            sequence: 1,
            start_message: 1,
            end_message: 4,
            start_message_id: "m0".into(),
            end_message_id: "m3".into(),
            title: "Setup".into(),
            content: "Set things up.".into(),
            p1: Some("Set things up.".into()),
            p2: Some("Setup.".into()),
            p3: Some("Setup.".into()),
            p4: Some("Setup".into()),
            importance: Some(70),
            episode_type: Some("build".into()),
        };
        db.append_compartments("opencode", "s1", std::slice::from_ref(&compartment), 7)
            .unwrap();
        let stored = db.compartments("opencode", "s1").unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].title, "Setup");
        assert_eq!(stored[0].importance, 70);
        assert_eq!(stored[0].legacy, 0);
        assert!(db.compartments("pi", "s1").unwrap().is_empty());
        assert!(db
            .append_compartments("opencode", "s1", &[compartment], 8)
            .is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
