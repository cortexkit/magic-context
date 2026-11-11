//! The Cache tab's OpenCode session list, kept current across live polls
//! without rescanning `opencode.db` each time.
//!
//! The list needs every unarchived session's `time_updated`, and OpenCode's
//! `session` table has no index on it. Its rows also carry large
//! `summary_diffs` text before `time_updated`, so reading that one column
//! walks each row's overflow pages: on a 40 GB store one scan read 8,000+
//! pages (33 MB), and a poll used to do that up to three times (two candidate
//! pages plus the subagent-parent scan), once a second.
//!
//! This cache holds one read-only connection open between polls and asks
//! SQLite whether anything was committed since the last poll
//! (`PRAGMA data_version`). When nothing was, the previous list is returned
//! as is. When something was, only what changed is read:
//!
//! - new `session`, `message` and `part` rows, found by rowid ranges above the
//!   highest rowid already seen (a primary-key seek, never a scan); their
//!   sessions become "hot";
//! - each hot session's own row, by primary key, for as long as it stays hot,
//!   which catches in-place updates (streamed tokens, a retitle) while the
//!   session is busy.
//!
//! A full scan still runs at most once a minute while the store is changing,
//! so an in-place change to a session with no new rows (archiving one, say)
//! shows up within that minute. OpenCode 2's `session_v2` list is already
//! one seek per session, so it is simply re-run when the store changed.

use super::opencode_stores::{open_store, StoreConnection, StoreOpenError};
use super::{
    filter_opencode_cache_candidates, load_recent_opencode_cache_sessions_with_cache,
    opencode_cache_activity_note, opencode_generation_harness, opencode_store_generations,
    table_exists, CacheSessionListEntry, OpenCodeCachePresenceCache, OpenCodeSessions,
    OpenCodeStoreGeneration,
};
use crate::broca_wal::file_identity;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How often a changing store is still scanned in full.
const FULL_RESCAN_INTERVAL: Duration = Duration::from_secs(60);
/// How long a session stays hot after its last new row.
const HOT_WINDOW: Duration = Duration::from_secs(120);

#[derive(Debug, Clone)]
struct V1Row {
    time_updated: i64,
    archived: bool,
    title: Option<String>,
    child: bool,
}

/// What the list needs from OpenCode 1's `session` table.
#[derive(Debug)]
struct V1Index {
    rows: HashMap<String, V1Row>,
    session_rowid: i64,
    message_rowid: Option<i64>,
    part_rowid: Option<i64>,
    hot: HashMap<String, Instant>,
    scanned_at: Instant,
    /// True once a delta has been applied since the last full scan, so an
    /// in-place change no delta can see is still picked up by the next
    /// scheduled full scan even if the store then goes quiet.
    deltas_since_scan: bool,
}

/// The session columns the list reads. A store without `parent_id` (only test
/// fixtures and very old builds) reads every session as a primary one.
fn v1_row_columns(conn: &Connection) -> &'static str {
    let has_parent = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('session') WHERE name = 'parent_id')",
            [],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false);
    if has_parent {
        "parent_id, time_updated, time_archived IS NOT NULL, NULLIF(title, '')"
    } else {
        "NULL, time_updated, time_archived IS NOT NULL, NULLIF(title, '')"
    }
}

fn v1_row(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<V1Row> {
    let parent: Option<String> = row.get(offset)?;
    Ok(V1Row {
        child: parent.is_some_and(|parent| !parent.trim().is_empty()),
        time_updated: row.get(offset + 1)?,
        archived: row.get(offset + 2)?,
        title: row.get(offset + 3)?,
    })
}

fn max_rowid(conn: &Connection, table: &str) -> rusqlite::Result<Option<i64>> {
    if !table_exists(conn, table) {
        return Ok(None);
    }
    conn.query_row(
        &format!("SELECT COALESCE(MAX(rowid), 0) FROM {table}"),
        [],
        |row| row.get(0),
    )
    .map(Some)
}

impl V1Index {
    fn scan(conn: &Connection, now: Instant) -> rusqlite::Result<Self> {
        // High-water marks first: a row committed during the scan is then
        // read again by the next delta rather than missed.
        let message_rowid = max_rowid(conn, "message")?;
        let part_rowid = max_rowid(conn, "part")?;
        let mut rows = HashMap::new();
        let mut session_rowid = 0;
        let columns = v1_row_columns(conn);
        let mut stmt = conn.prepare(&format!("SELECT rowid, id, {columns} FROM session"))?;
        let mut cursor = stmt.query([])?;
        while let Some(row) = cursor.next()? {
            session_rowid = session_rowid.max(row.get::<_, i64>(0)?);
            rows.insert(row.get::<_, String>(1)?, v1_row(row, 2)?);
        }
        Ok(Self {
            rows,
            session_rowid,
            message_rowid,
            part_rowid,
            hot: HashMap::new(),
            scanned_at: now,
            deltas_since_scan: false,
        })
    }

    /// Reads what changed since the last scan or delta. Returns false when a
    /// table's rowids went backwards (rows deleted at the end, or the store
    /// was vacuumed), which only a full scan can reconcile.
    fn apply_delta(&mut self, conn: &Connection, now: Instant) -> rusqlite::Result<bool> {
        self.deltas_since_scan = true;
        if max_rowid(conn, "session")?.unwrap_or(0) < self.session_rowid {
            return Ok(false);
        }
        let columns = v1_row_columns(conn);
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT rowid, id, {columns} FROM session WHERE rowid > ?1 ORDER BY rowid"
        ))?;
        let mut cursor = stmt.query(params![self.session_rowid])?;
        while let Some(row) = cursor.next()? {
            self.session_rowid = self.session_rowid.max(row.get::<_, i64>(0)?);
            let id: String = row.get(1)?;
            self.rows.insert(id.clone(), v1_row(row, 2)?);
            self.hot.insert(id, now);
        }
        drop(cursor);
        for (table, high_water) in [
            ("message", &mut self.message_rowid),
            ("part", &mut self.part_rowid),
        ] {
            let Some(seen) = high_water.as_mut() else {
                continue;
            };
            if max_rowid(conn, table)?.unwrap_or(0) < *seen {
                return Ok(false);
            }
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT rowid, session_id FROM {table} WHERE rowid > ?1 ORDER BY rowid"
            ))?;
            let mut cursor = stmt.query(params![*seen])?;
            while let Some(row) = cursor.next()? {
                *seen = (*seen).max(row.get::<_, i64>(0)?);
                self.hot.insert(row.get(1)?, now);
            }
        }
        self.hot
            .retain(|_, touched| now.duration_since(*touched) <= HOT_WINDOW);
        let mut stmt =
            conn.prepare_cached(&format!("SELECT {columns} FROM session WHERE id = ?1"))?;
        for id in self.hot.keys() {
            match stmt
                .query_row(params![id], |row| v1_row(row, 0))
                .optional()?
            {
                Some(row) => {
                    self.rows.insert(id.clone(), row);
                }
                None => {
                    self.rows.remove(id);
                }
            }
        }
        Ok(true)
    }

    fn full_scan_due(&self, now: Instant) -> bool {
        self.deltas_since_scan && now.duration_since(self.scanned_at) >= FULL_RESCAN_INTERVAL
    }

    fn refresh(index: &mut Option<Self>, conn: &Connection, now: Instant) -> rusqlite::Result<()> {
        if let Some(current) = index.as_mut() {
            if now.duration_since(current.scanned_at) < FULL_RESCAN_INTERVAL
                && current.apply_delta(conn, now)?
            {
                return Ok(());
            }
        }
        *index = Some(Self::scan(conn, now)?);
        Ok(())
    }

    /// Unarchived sessions not owned by a later generation, newest first,
    /// in the order the candidate SQL returns them.
    fn candidates(&self, owners: &OpenCodeSessions) -> Vec<CacheSessionListEntry> {
        let mut out: Vec<CacheSessionListEntry> = self
            .rows
            .iter()
            .filter(|(id, row)| {
                !row.archived && owners.owner(id) == Some(OpenCodeStoreGeneration::V1)
            })
            .map(|(id, row)| CacheSessionListEntry {
                harness: opencode_generation_harness(OpenCodeStoreGeneration::V1),
                session_id: id.clone(),
                last_activity_ms: row.time_updated,
                title: row.title.clone(),
            })
            .collect();
        out.sort_by(|a, b| {
            b.last_activity_ms
                .cmp(&a.last_activity_ms)
                .then_with(|| b.session_id.cmp(&a.session_id))
        });
        out
    }
}

/// Everything derived from one committed state of the store.
struct Snapshot {
    owners: OpenCodeSessions,
    children: HashSet<String>,
    note: Option<&'static str>,
    /// The last list built from this state and what it was asked for.
    list: Option<(ListKey, Vec<CacheSessionListEntry>)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ListKey {
    limit: usize,
    hidden: u64,
}

/// An order-independent fingerprint of the hidden-subagent set, so a list is
/// rebuilt when that set changes without cloning it every poll.
fn hidden_fingerprint(hidden: &HashSet<String>) -> u64 {
    hidden.iter().fold(hidden.len() as u64, |acc, id| {
        let mut hasher = DefaultHasher::new();
        id.hash(&mut hasher);
        acc.wrapping_add(hasher.finish())
    })
}

/// The list for one store. It keeps its connection between polls, but never
/// a read snapshot: every statement is finished or reset before a poll
/// returns (see `release_open_reads`), so the store's owner can always
/// checkpoint.
pub(super) struct OpenCodeListCache {
    path: PathBuf,
    file_key: Option<(u64, u64)>,
    store: StoreConnection,
    data_version: Option<i64>,
    v1: Option<V1Index>,
    snapshot: Option<Snapshot>,
    presence: OpenCodeCachePresenceCache,
}

impl OpenCodeListCache {
    pub(super) fn open(path: &Path) -> Result<Self, StoreOpenError> {
        let store = open_store(path)?;
        // A sort that remains (OpenCode 2's ordering) stays in memory rather
        // than spilling to a temporary file.
        store.conn.pragma_update(None, "temp_store", "MEMORY")?;
        Ok(Self {
            path: path.to_path_buf(),
            file_key: std::fs::metadata(path)
                .ok()
                .as_ref()
                .and_then(file_identity),
            store,
            data_version: None,
            v1: None,
            snapshot: None,
            presence: HashMap::new(),
        })
    }

    /// True when this cache still reads the file now at `path`, opened the
    /// way a fresh open would open it. An immutable connection never sees a
    /// change through `PRAGMA data_version`, so a changed file, or WAL files
    /// appearing because the owner started, means opening it again.
    pub(super) fn serves(&self, path: &Path) -> bool {
        self.path == path
            && std::fs::metadata(path)
                .ok()
                .as_ref()
                .and_then(file_identity)
                == self.file_key
            && self.store.mode_current()
    }

    /// Ends any statement or transaction left open by the poll that just ran,
    /// and reports whether that poll's reads can be trusted (an immutable
    /// store that changed meanwhile cannot).
    pub(super) fn finish_poll(&self) -> bool {
        self.store.release_open_reads();
        self.store.unchanged()
    }

    /// Whether the store holds a session with this id, as of the last poll.
    pub(super) fn owns(&self, session_id: &str) -> bool {
        self.snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.owners.owner(session_id).is_some())
    }

    /// Brings the snapshot up to the store's current committed state.
    fn refresh(&mut self, now: Instant) -> rusqlite::Result<&mut Snapshot> {
        let version: i64 = self
            .store
            .conn
            .query_row("PRAGMA data_version", [], |row| row.get(0))?;
        let full_scan_due = self
            .v1
            .as_ref()
            .is_some_and(|index| index.full_scan_due(now));
        if self.data_version != Some(version) || self.snapshot.is_none() || full_scan_due {
            self.snapshot = None;
            let generations = opencode_store_generations(&self.store.conn)?;
            let mut owners = HashMap::new();
            let mut children = HashSet::new();
            if generations.contains(&OpenCodeStoreGeneration::V1)
                && table_exists(&self.store.conn, "session")
            {
                V1Index::refresh(&mut self.v1, &self.store.conn, now)?;
                if let Some(index) = &self.v1 {
                    for (id, row) in &index.rows {
                        owners.insert(id.clone(), OpenCodeStoreGeneration::V1);
                        if row.child {
                            children.insert(id.clone());
                        }
                    }
                }
            } else {
                self.v1 = None;
            }
            if generations.contains(&OpenCodeStoreGeneration::V2)
                && table_exists(&self.store.conn, "session_v2")
            {
                let mut stmt = self
                    .store
                    .conn
                    .prepare_cached("SELECT id, parent_id FROM session_v2")?;
                let mut cursor = stmt.query([])?;
                while let Some(row) = cursor.next()? {
                    let id: String = row.get(0)?;
                    let parent: Option<String> = row.get(1)?;
                    // A later generation owns an id both tables hold.
                    children.remove(&id);
                    if parent.is_some_and(|parent| !parent.trim().is_empty()) {
                        children.insert(id.clone());
                    }
                    owners.insert(id, OpenCodeStoreGeneration::V2);
                }
            }
            let note = generations
                .iter()
                .find_map(|&generation| opencode_cache_activity_note(&self.store.conn, generation));
            self.snapshot = Some(Snapshot {
                owners: OpenCodeSessions {
                    generations,
                    owners,
                },
                children,
                note,
                list: None,
            });
            self.data_version = Some(version);
        }
        Ok(self.snapshot.as_mut().expect("snapshot was just built"))
    }

    /// Sessions whose store row names a parent: OpenCode's own subagent flag.
    pub(super) fn child_session_ids(&mut self, now: Instant) -> HashSet<String> {
        self.refresh(now)
            .map(|snapshot| snapshot.children.clone())
            .unwrap_or_default()
    }

    /// The Cache tab's recent OpenCode sessions, same result as listing each
    /// generation with `load_recent_opencode_cache_sessions_with_cache`.
    pub(super) fn recent_sessions(
        &mut self,
        limit: usize,
        hidden_subagent_ids: &HashSet<String>,
        now: Instant,
    ) -> (Vec<CacheSessionListEntry>, Option<&'static str>) {
        let key = ListKey {
            limit,
            hidden: hidden_fingerprint(hidden_subagent_ids),
        };
        if self.refresh(now).is_err() {
            return (Vec::new(), None);
        }
        let snapshot = self.snapshot.as_mut().expect("refreshed");
        if let Some((cached_key, list)) = &snapshot.list {
            if *cached_key == key {
                return (list.clone(), snapshot.note);
            }
        }
        let mut sessions = Vec::new();
        for &generation in &snapshot.owners.generations {
            let rows = match (generation, &self.v1) {
                (OpenCodeStoreGeneration::V1, Some(index)) => {
                    let candidates = index.candidates(&snapshot.owners);
                    filter_opencode_cache_candidates(
                        &self.store.conn,
                        generation,
                        limit,
                        hidden_subagent_ids,
                        &mut self.presence,
                        |page_limit, offset| {
                            let start = usize::try_from(offset).ok()?.min(candidates.len());
                            let end = start
                                .saturating_add(usize::try_from(page_limit).ok()?)
                                .min(candidates.len());
                            Some(candidates[start..end].to_vec())
                        },
                    )
                }
                _ => load_recent_opencode_cache_sessions_with_cache(
                    &self.store.conn,
                    generation,
                    limit,
                    hidden_subagent_ids,
                    &mut self.presence,
                ),
            };
            sessions.extend(
                rows.into_iter()
                    .filter(|row| snapshot.owners.owns(&row.session_id, generation)),
            );
        }
        sessions.sort_by_key(|session| std::cmp::Reverse(session.last_activity_ms));
        sessions.truncate(limit);
        snapshot.list = Some((key, sessions.clone()));
        (sessions, snapshot.note)
    }
}

#[cfg(test)]
mod tests {
    use super::super::load_recent_opencode_cache_sessions_uncached;
    use super::*;

    /// An OpenCode 1 store on disk: a writer connection plus the file path the
    /// cache opens read-only. Session rows carry a large `summary_diffs`
    /// before `time_updated`, as real ones do, so a full scan is expensive.
    struct Store {
        _dir: tempfile::TempDir,
        path: PathBuf,
        writer: Connection,
    }

    impl Store {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("opencode.db");
            let writer = Connection::open(&path).unwrap();
            writer
                .execute_batch(
                    "PRAGMA journal_mode = WAL;
                     CREATE TABLE session (
                         id TEXT PRIMARY KEY, parent_id TEXT, title TEXT NOT NULL,
                         summary_diffs TEXT, time_updated INTEGER NOT NULL, time_archived INTEGER);
                     CREATE TABLE message (
                         id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                         time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
                     CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
                     CREATE TABLE part (
                         id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
                         data TEXT NOT NULL);",
                )
                .unwrap();
            Self {
                _dir: dir,
                path,
                writer,
            }
        }

        fn session(&self, id: &str, parent: Option<&str>, updated: i64) {
            self.writer
                .execute(
                    "INSERT INTO session (id, parent_id, title, summary_diffs, time_updated)
                     VALUES (?1, ?2, ?1, ?3, ?4)",
                    params![id, parent, "d".repeat(20_000), updated],
                )
                .unwrap();
        }

        /// One assistant message with tokens (a cache event) and one part,
        /// bumping the session's time as OpenCode does.
        fn turn(&self, session: &str, id: &str, at: i64) {
            let data =
                serde_json::json!({"role": "assistant", "tokens": {"total": 10}}).to_string();
            self.writer
                .execute(
                    "INSERT INTO message (id, session_id, time_created, time_updated, data)
                     VALUES (?1, ?2, ?3, ?3, ?4)",
                    params![id, session, at, data],
                )
                .unwrap();
            self.writer
                .execute(
                    "INSERT INTO part (id, message_id, session_id, data) VALUES (?1, ?1, ?2, '{}')",
                    params![format!("{id}-part"), session],
                )
                .unwrap();
            self.writer
                .execute(
                    "UPDATE session SET time_updated = ?2 WHERE id = ?1",
                    params![session, at],
                )
                .unwrap();
        }

        fn uncached(&self, limit: usize, hidden: &HashSet<String>) -> Vec<(String, i64)> {
            let conn = super::super::open_readonly(&self.path).unwrap();
            ids(load_recent_opencode_cache_sessions_uncached(&conn, limit, hidden).0)
        }
    }

    fn ids(rows: Vec<CacheSessionListEntry>) -> Vec<(String, i64)> {
        rows.into_iter()
            .map(|row| (row.session_id, row.last_activity_ms))
            .collect()
    }

    fn pages_read(cache: &OpenCodeListCache) -> i64 {
        let (mut current, mut high) = (0, 0);
        unsafe {
            rusqlite::ffi::sqlite3_db_status(
                cache.store.conn.handle(),
                rusqlite::ffi::SQLITE_DBSTATUS_CACHE_MISS,
                &mut current,
                &mut high,
                1, // reset, so each call reports the pages read since the last
            );
        }
        i64::from(current)
    }

    fn listed(cache: &mut OpenCodeListCache, now: Instant) -> Vec<(String, i64)> {
        ids(cache.recent_sessions(50, &HashSet::new(), now).0)
    }

    #[test]
    fn the_cached_list_follows_new_sessions_turns_and_children_like_a_fresh_read() {
        let store = Store::new();
        for index in 0..20 {
            let id = format!("s{index:02}");
            store.session(&id, None, 1_000 + index);
            store.turn(&id, &format!("m{index:02}"), 1_000 + index);
        }
        let mut cache = OpenCodeListCache::open(&store.path).unwrap();
        let start = Instant::now();
        assert_eq!(
            listed(&mut cache, start),
            store.uncached(50, &HashSet::new())
        );

        // A new primary session, a new child, and a turn on an old session.
        store.session("new", None, 5_000);
        store.turn("new", "m-new", 5_000);
        store.session("child", Some("new"), 5_001);
        store.turn("child", "m-child", 5_001);
        store.turn("s03", "m-s03-2", 6_000);
        let now = start + Duration::from_secs(1);
        assert_eq!(listed(&mut cache, now), store.uncached(50, &HashSet::new()));
        assert_eq!(listed(&mut cache, now)[0], ("s03".to_owned(), 6_000));
        assert_eq!(
            cache.child_session_ids(now),
            HashSet::from(["child".to_owned()])
        );

        // An in-place update to a hot session (its streamed message landing)
        // is read without a full scan.
        store
            .writer
            .execute(
                "UPDATE session SET time_updated = 7000 WHERE id = 'new'",
                [],
            )
            .unwrap();
        let now = start + Duration::from_secs(2);
        assert_eq!(listed(&mut cache, now), store.uncached(50, &HashSet::new()));

        // Hidden ids change the list without a store change.
        let hidden = HashSet::from(["s03".to_owned()]);
        assert_eq!(
            ids(cache.recent_sessions(50, &hidden, now).0),
            store.uncached(50, &hidden)
        );
    }

    #[test]
    fn an_in_place_change_to_a_quiet_session_shows_by_the_next_full_scan() {
        let store = Store::new();
        for index in 0..5 {
            let id = format!("s{index}");
            store.session(&id, None, 1_000 + index);
            store.turn(&id, &format!("m{index}"), 1_000 + index);
        }
        let mut cache = OpenCodeListCache::open(&store.path).unwrap();
        let start = Instant::now();
        listed(&mut cache, start);
        store
            .writer
            .execute("UPDATE session SET time_archived = 1 WHERE id = 's2'", [])
            .unwrap();
        // Within the rescan interval the archived session is still listed:
        // nothing new was appended for the delta to see.
        let soon = start + Duration::from_secs(5);
        assert!(listed(&mut cache, soon).iter().any(|(id, _)| id == "s2"));
        // Once the interval passes it is gone, even though the store has not
        // changed again since.
        let later = start + FULL_RESCAN_INTERVAL + Duration::from_secs(1);
        assert_eq!(
            listed(&mut cache, later),
            store.uncached(50, &HashSet::new())
        );
        assert!(!listed(&mut cache, later).iter().any(|(id, _)| id == "s2"));
    }

    #[test]
    fn a_poll_reads_in_proportion_to_what_changed() {
        let store = Store::new();
        for index in 0..400 {
            let id = format!("s{index:03}");
            store.session(&id, None, 1_000 + index);
            store.turn(&id, &format!("m{index:03}"), 1_000 + index);
        }
        let mut cache = OpenCodeListCache::open(&store.path).unwrap();
        let start = Instant::now();
        listed(&mut cache, start);
        let full = pages_read(&cache);
        assert!(full > 2_000, "a full scan reads every session row: {full}");

        // Nothing committed: the previous list is returned without reading.
        listed(&mut cache, start + Duration::from_secs(1));
        assert_eq!(pages_read(&cache), 0);

        // One new turn: rowid seeks plus that session's own row.
        store.turn("s005", "m-new", 9_000);
        let now = start + Duration::from_secs(2);
        assert_eq!(listed(&mut cache, now)[0], ("s005".to_owned(), 9_000));
        let delta = pages_read(&cache);
        assert!(
            delta * 20 < full,
            "a one-turn poll read {delta} pages, a full scan {full}"
        );
    }
}
