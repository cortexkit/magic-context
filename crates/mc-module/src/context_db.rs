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

/// A change to a memory the head may already show, from the mutation log.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoredMutation {
    pub id: i64,
    pub mutation_type: String,
    pub target_memory_id: i64,
    pub superseded_by_id: Option<i64>,
    pub category: Option<String>,
    pub new_content: Option<String>,
}

/// Whose notes a call may see and change: the session's own, by harness
/// and host session id, plus its project's smart notes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NoteScope {
    pub harness: String,
    pub session: String,
    pub project: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoredNote {
    pub id: i64,
    /// `session` or `smart`.
    pub kind: String,
    pub status: String,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub anchor_ordinal: Option<i64>,
    pub surface_condition: Option<String>,
    pub ready_reason: Option<String>,
    pub check_status: Option<String>,
}

const NOTE_COLUMNS: &str =
    "id, type, CASE WHEN status IN ('surfacing', 'surfaced') THEN 'ready' ELSE status END,
    content, created_at, updated_at, anchor_ordinal, surface_condition, ready_reason, check_status";

fn note_row(row: &rusqlite::Row) -> rusqlite::Result<StoredNote> {
    Ok(StoredNote {
        id: row.get(0)?,
        kind: row.get(1)?,
        status: row.get(2)?,
        content: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        anchor_ordinal: row.get(6)?,
        surface_condition: row.get(7)?,
        ready_reason: row.get(8)?,
        check_status: row.get(9)?,
    })
}

/// `?, ?, …` for `count` binds.
fn placeholders(count: usize) -> String {
    vec!["?"; count].join(", ")
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

    /// Store a session note and return its id.
    pub fn add_session_note(
        &self,
        scope: &NoteScope,
        content: &str,
        anchor: Option<u64>,
        now_ms: i64,
    ) -> Result<i64, String> {
        let connection = self.lock();
        connection
            .execute(
                "INSERT INTO notes (type, status, content, session_id, harness, project_path,
                                    created_at, updated_at, anchor_ordinal)
                 VALUES ('session', 'active', ?1, ?2, ?3, ?4, ?5, ?5, ?6)",
                params![
                    content,
                    scope.session,
                    scope.harness,
                    scope.project,
                    now_ms,
                    anchor.map(|ordinal| ordinal as i64)
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(connection.last_insert_rowid())
    }

    /// The session's own notes with one of `statuses`.
    pub fn session_notes(
        &self,
        scope: &NoteScope,
        statuses: &[&str],
    ) -> Result<Vec<StoredNote>, String> {
        let sql = format!(
            "SELECT {NOTE_COLUMNS} FROM notes
              WHERE type = 'session' AND session_id = ? AND harness = ? AND status IN ({})",
            placeholders(statuses.len())
        );
        let mut binds: Vec<&dyn rusqlite::ToSql> = vec![&scope.session, &scope.harness];
        binds.extend(statuses.iter().map(|status| status as &dyn rusqlite::ToSql));
        self.notes_where(&sql, &binds)
    }

    /// The project's smart notes with one of `statuses` (standalone sessions
    /// create them; ck-mc only shows and closes them).
    pub fn project_smart_notes(
        &self,
        scope: &NoteScope,
        statuses: &[&str],
    ) -> Result<Vec<StoredNote>, String> {
        let Some(project) = &scope.project else {
            return Ok(Vec::new());
        };
        let wanted: Vec<&str> = statuses
            .iter()
            .flat_map(|status| match *status {
                "ready" => vec!["ready", "surfacing", "surfaced"],
                other => vec![other],
            })
            .collect();
        let sql = format!(
            "SELECT {NOTE_COLUMNS} FROM notes WHERE type = 'smart' AND project_path = ? AND status IN ({})",
            placeholders(wanted.len())
        );
        let mut binds: Vec<&dyn rusqlite::ToSql> = vec![project];
        binds.extend(wanted.iter().map(|status| status as &dyn rusqlite::ToSql));
        self.notes_where(&sql, &binds)
    }

    /// One note, when the scope may see it.
    pub fn note_in_scope(&self, id: i64, scope: &NoteScope) -> Result<Option<StoredNote>, String> {
        let sql = format!(
            "SELECT {NOTE_COLUMNS} FROM notes
              WHERE id = ? AND ((type = 'session' AND session_id = ? AND harness = ?)
                                OR (type = 'smart' AND project_path IS ? AND ? IS NOT NULL))"
        );
        let binds: Vec<&dyn rusqlite::ToSql> = vec![
            &id,
            &scope.session,
            &scope.harness,
            &scope.project,
            &scope.project,
        ];
        Ok(self.notes_where(&sql, &binds)?.into_iter().next())
    }

    /// Dismiss a note the scope may change. False when it is not there or
    /// already dismissed.
    pub fn dismiss_note(&self, id: i64, scope: &NoteScope, now_ms: i64) -> Result<bool, String> {
        if self
            .note_in_scope(id, scope)?
            .is_none_or(|note| note.status == "dismissed")
        {
            return Ok(false);
        }
        self.lock()
            .execute(
                "UPDATE notes SET status = 'dismissed', updated_at = ?2 WHERE id = ?1",
                params![id, now_ms],
            )
            .map(|changed| changed == 1)
            .map_err(|error| error.to_string())
    }

    /// Replace a note's text. False when the scope may not change it.
    pub fn update_note_content(
        &self,
        id: i64,
        scope: &NoteScope,
        content: &str,
        now_ms: i64,
    ) -> Result<bool, String> {
        if self.note_in_scope(id, scope)?.is_none() {
            return Ok(false);
        }
        self.lock()
            .execute(
                "UPDATE notes SET content = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, content, now_ms],
            )
            .map(|changed| changed == 1)
            .map_err(|error| error.to_string())
    }

    fn notes_where(
        &self,
        sql: &str,
        binds: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<StoredNote>, String> {
        let connection = self.lock();
        let mut statement = connection
            .prepare_cached(sql)
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(binds, note_row)
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>()
            .map_err(|error| error.to_string())
    }

    /// A project's memories that may be shown: active or permanent, and not
    /// expired at `now_ms`.
    pub fn project_memories(
        &self,
        project: &str,
        now_ms: i64,
    ) -> Result<Vec<StoredMemory>, String> {
        let connection = self.lock();
        let mut statement = connection
            .prepare_cached(
                "SELECT id, project_path, category, content, importance, status, expires_at,
                        superseded_by_memory_id, updated_at, last_seen_at, verified_at
                   FROM memories
                  WHERE project_path = ?1 AND status IN ('active', 'permanent')
                    AND (expires_at IS NULL OR expires_at > ?2)
                  ORDER BY COALESCE(importance, 50) DESC, id ASC",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![project, now_ms], |row| {
                Ok(StoredMemory {
                    id: row.get(0)?,
                    project_path: row.get(1)?,
                    category: row.get(2)?,
                    content: row.get(3)?,
                    importance: row.get(4)?,
                    status: row
                        .get::<_, Option<String>>(5)?
                        .unwrap_or_else(|| "active".into()),
                    expires_at: row.get(6)?,
                    superseded_by_memory_id: row.get(7)?,
                    updated_at: row.get(8)?,
                    last_seen_at: row.get(9)?,
                    verified_at: row.get(10)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>()
            .map_err(|error| error.to_string())
    }

    /// The active user profile, oldest first, and its highest id.
    pub fn user_profile(&self) -> Result<(Vec<String>, i64), String> {
        let connection = self.lock();
        let mut statement = connection
            .prepare_cached(
                "SELECT id, content FROM user_memories WHERE status = 'active' ORDER BY promoted_at ASC, id ASC",
            )
            .map_err(|error| error.to_string())?;
        let rows: Vec<(i64, String)> = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|error| error.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|error| error.to_string())?;
        let max_id = rows.iter().map(|(id, _)| *id).max().unwrap_or(0);
        Ok((
            rows.into_iter().map(|(_, content)| content).collect(),
            max_id,
        ))
    }

    /// A project's memory changes after the log entry `after`, oldest first.
    pub fn memory_mutations_after(
        &self,
        project: &str,
        after: i64,
    ) -> Result<Vec<StoredMutation>, String> {
        let connection = self.lock();
        let mut statement = connection
            .prepare_cached(
                "SELECT id, mutation_type, target_memory_id, superseded_by_id, category, new_content
                   FROM memory_mutation_log
                  WHERE project_path = ?1 AND id > ?2
                  ORDER BY id ASC",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![project, after], |row| {
                Ok(StoredMutation {
                    id: row.get(0)?,
                    mutation_type: row.get(1)?,
                    target_memory_id: row.get(2)?,
                    superseded_by_id: row.get(3)?,
                    category: row.get(4)?,
                    new_content: row.get(5)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>()
            .map_err(|error| error.to_string())
    }

    /// The newest memory change logged for a project, or 0.
    pub fn last_memory_mutation(&self, project: &str) -> Result<i64, String> {
        self.lock()
            .query_row(
                "SELECT COALESCE(MAX(id), 0) FROM memory_mutation_log WHERE project_path = ?1",
                params![project],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
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
