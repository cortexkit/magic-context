//! The raw-message lane: ck-mc's share of the search index the standalone
//! plugin keeps in `context.db`, and the search over it.
//!
//! Rows are keyed by host session id and message number (the runner's
//! one-based ordinal), as the plugin keys them, so a moved session keeps
//! searching the rows the plugin wrote before the move. Only user and
//! assistant text (including words sent through a tool) is indexed; tool
//! output, reasoning, notices and agent relays are not.

use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use cortexkit_role_compaction::part::PartBody;
use cortexkit_role_compaction::read::{Entry, Role};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::spoken::{self, Format};

use super::text::{
    contains_probe_verbatim, indexable_content, matched_snippet, preview, relaxed_fts_query,
    sanitize_fts_query,
};

/// Messages indexed in one transaction, so a long first catch-up never holds
/// the write lock long.
const INDEX_BATCH: usize = 200;
/// Reciprocal-rank-fusion constant for the query and its probes.
const RRF_K: f64 = 60.0;
/// A probe whose literal a message holds verbatim earns one extra first-place
/// list appearance.
const VERBATIM_RANK_BONUS: f64 = 1.0 / RRF_K;
/// A probe matching a large share of the session counts for less:
/// `1 / (1 + 100 · df/N)`.
const IDF_FALLOFF: f64 = 100.0;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

fn role_name(entry: &Entry) -> &str {
    if crate::neutral::has_verified_host_frames(entry) {
        "user"
    } else {
        entry.role.as_str()
    }
}

/// What `entry` adds to the index, or empty.
fn content_of(entry: &Entry) -> String {
    let mut frames = crate::neutral::verified_host_frames(entry).peekable();
    if frames.peek().is_some() {
        let ordinary_user =
            entry.role == Role::User && entry.notice.is_none() && entry.speaks_for.is_none();
        // The search index holds one row per stored message, not per part, so
        // every frame's words go into that one row.
        return entry
            .parts
            .iter()
            .filter_map(|part| {
                if frames.peek().is_some_and(|(id, _)| *id == part.id) {
                    let (_, words) = frames.next().expect("peeked frame");
                    Some(super::text::collapse_whitespace(words))
                } else if ordinary_user && crate::neutral::host_part(entry, part).is_none() {
                    let PartBody::Text { text } = &part.body else {
                        return None;
                    };
                    Some(indexable_content(true, &[text.as_str()]))
                } else {
                    None
                }
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
    }
    if entry.notice.is_some() || entry.speaks_for.is_some() {
        return String::new();
    }
    let texts: Vec<_> = crate::neutral::authored_parts(entry)
        .filter_map(|part| match &part.body {
            PartBody::Text { text } => Some(Cow::Borrowed(text.as_str())),
            PartBody::Tool(tool) if entry.role == Role::Assistant => {
                spoken::spoken_text(tool, Format::Words).map(Cow::Owned)
            }
            _ => None,
        })
        .collect();
    let borrowed: Vec<_> = texts.iter().map(|text| text.as_ref()).collect();
    indexable_content(entry.role == Role::User, &borrowed)
}

#[cfg(test)]
#[path = "messages_tests.rs"]
mod reach_tests;

#[cfg(test)]
mod attribution_tests {
    #[test]
    fn host_frame_search_reprojects_the_held_system_row_as_user_words() {
        use cortexkit_role_compaction::{
            part::{Part, PartBody},
            read::{Entry, HostFrame, Role},
        };
        use cortexkit_role_llm_runner::attribution::host_frames::{
            CLAUDE_CODE_MID_TURN, CLAUDE_CODE_MID_TURN_HEAD as HEAD,
            CLAUDE_CODE_MID_TURN_TAIL as TAIL,
        };
        let mut conn = crate::context_db::ContextDb::fresh_in_memory();
        let words = "Please keep the sapphire branch";
        let entry = Entry::new(
            1,
            "steer",
            Role::System,
            1,
            vec![Part::new(
                "p",
                PartBody::Text {
                    text: format!("{HEAD}{words}{TAIL}").into(),
                },
            )],
        );
        super::index(&mut conn, "mock", "s", std::slice::from_ref(&entry)).unwrap();
        let digest = entry.digest.clone();
        let marked = entry
            .with_host_frame(
                HostFrame::new(
                    "p",
                    CLAUDE_CODE_MID_TURN,
                    HEAD.len() as u32,
                    TAIL.len() as u32,
                ),
                true,
            )
            .unwrap();
        assert_eq!(marked.digest, digest);
        super::reconcile(&mut conn, &Default::default(), "mock", "s", &[marked]).unwrap();
        let hits = super::app_page(&conn, "s", "sapphire", 0, 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].role, "user");
        assert_eq!(hits[0].content, words);
        assert!(super::app_page(&conn, "s", "alongside", 0, 10).is_empty());
        assert!(super::app_page(&conn, "s", "working", 0, 10).is_empty());
    }

    #[test]
    fn host_parts_search_reconcile_refreshes_unchanged_digest() {
        use cortexkit_role_compaction::{
            part::{Part, PartBody},
            read::{Entry, HostPart, Role},
        };
        let mut conn = crate::context_db::ContextDb::fresh_in_memory();
        let mut entry = Entry::new(
            1,
            "mixed",
            Role::User,
            0,
            vec![
                Part::new(
                    "p",
                    PartBody::Text {
                        text: "actual instruction".into(),
                    },
                ),
                Part::new(
                    "host",
                    PartBody::Text {
                        text: "hostmarker".into(),
                    },
                ),
            ],
        );
        // The index has already seen the bytes before the runner serves host facts.
        super::index(&mut conn, "mock", "s", std::slice::from_ref(&entry)).unwrap();
        entry.host_parts = vec![HostPart::new("host")];
        super::reconcile(
            &mut conn,
            &Default::default(),
            "mock",
            "s",
            std::slice::from_ref(&entry),
        )
        .unwrap();
        assert_eq!(super::content_of(&entry), "actual instruction");
        assert!(super::app_page(&conn, "s", "hostmarker", 0, 10).is_empty());
        assert_eq!(super::app_page(&conn, "s", "instruction", 0, 10).len(), 1);
    }

    #[test]
    fn speaks_for_words_are_not_indexed_as_a_persons_message() {
        use cortexkit_role_compaction::part::{Part, PartBody};
        use cortexkit_role_compaction::read::{Entry, Role};
        let mut entry = Entry::new(
            1,
            "brief",
            Role::User,
            0,
            vec![Part::new(
                "p",
                PartBody::Text {
                    text: "Find the retry implementation".into(),
                },
            )],
        );
        assert!(!super::content_of(&entry).is_empty());
        entry.speaks_for =
            Some(serde_json::from_value(serde_json::json!({"agent_id":"lead-agent"})).unwrap());
        assert!(super::content_of(&entry).is_empty());
    }
}

fn content_hash(content: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

/// The session's index watermark: every message up to it is indexed.
pub(crate) fn watermark(conn: &Connection, session: &str) -> rusqlite::Result<i64> {
    Ok(conn
        .query_row(
            "SELECT last_indexed_ordinal FROM message_history_index WHERE session_id = ?1",
            params![session],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0))
}

fn delete_from(conn: &Connection, session: &str, from_number: i64) -> rusqlite::Result<bool> {
    let fts = conn.execute(
        "DELETE FROM message_history_fts
          WHERE session_id = ?1 AND CAST(message_ordinal AS INTEGER) >= ?2",
        params![session, from_number],
    )?;
    let map = conn.execute(
        "DELETE FROM message_fts_rowid_map WHERE session_id = ?1 AND message_ordinal >= ?2",
        params![session, from_number],
    )?;
    conn.execute(
        "DELETE FROM message_history_source WHERE session_id = ?1 AND message_ordinal >= ?2",
        params![session, from_number],
    )?;
    Ok(fts + map > 0)
}

fn set_watermark(
    conn: &Connection,
    harness: &str,
    session: &str,
    number: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO message_history_index (session_id, last_indexed_ordinal, dirty_floor_ordinal, updated_at, harness)
         VALUES (?1, ?2, 0, ?3, ?4)
         ON CONFLICT(session_id) DO UPDATE SET last_indexed_ordinal = excluded.last_indexed_ordinal,
                                               updated_at = excluded.updated_at",
        params![session, number, now_ms(), harness],
    )?;
    Ok(())
}

/// A partially backfilled map cannot reach every legacy FTS row. Match the
/// plugin's rowid-watermark sweep as well as deleting the mapped rows.
/// Return whether legacy rows remain and whether any FTS row was deleted.
pub(super) fn delete_fts_range(
    conn: &Connection,
    session: &str,
    from: i64,
    through: i64,
    limit: i64,
) -> rusqlite::Result<(bool, bool)> {
    let mapped = conn.execute("DELETE FROM message_history_fts WHERE rowid IN (SELECT fts_rowid FROM message_fts_rowid_map WHERE session_id=?1 AND message_ordinal BETWEEN ?2 AND ?3)",params![session,from,through])?;
    let (watermark, completed): (i64, bool) = conn
        .query_row(
            "SELECT watermark_rowid,completed FROM message_fts_rowid_map_backfill_state WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .unwrap_or((0, false));
    if completed {
        return Ok((false, mapped > 0));
    }
    let legacy = conn.execute("DELETE FROM message_history_fts WHERE rowid IN (SELECT rowid FROM message_history_fts WHERE rowid>?1 AND session_id=?2 AND CAST(message_ordinal AS INTEGER) BETWEEN ?3 AND ?4 LIMIT ?5)",params![watermark,session,from,through,limit])?;
    let remains = conn.query_row("SELECT EXISTS(SELECT 1 FROM message_history_fts WHERE rowid>?1 AND session_id=?2 AND CAST(message_ordinal AS INTEGER) BETWEEN ?3 AND ?4)",params![watermark,session,from,through],|r|r.get(0))?;
    Ok((remains, mapped + legacy > 0))
}

/// Setup checks the supplied entries after a restart without rebuilding unchanged
/// rows. Changes to an older tool's result still refresh its source digest.
pub(super) fn reconcile(
    conn: &mut Connection,
    generation: &IndexGeneration,
    harness: &str,
    session: &str,
    entries: &[Entry],
) -> rusqlite::Result<()> {
    let mark = watermark(conn, session)?.max(0) as u64;
    let mut changed = Vec::new();
    for entry in entries.iter().filter(|entry| entry.ordinal <= mark) {
        let stored: Option<(String, String, String, String)> = conn.query_row(
            "SELECT message_id,source_version,normalized_content_hash,role FROM message_history_source WHERE session_id=?1 AND message_ordinal=?2",
            params![session, entry.ordinal as i64],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        ).optional()?;
        if stored.as_ref().is_none_or(|(mid, digest, hash, role)| {
            mid != &entry.mid
                || digest != &entry.digest
                || role != role_name(entry)
                || hash != &content_hash(&content_of(entry))
        }) {
            changed.push(entry);
        }
    }
    if changed.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut index_changed = false;
    for entry in changed {
        let number = entry.ordinal as i64;
        index_changed |= delete_fts_range(&tx, session, number, number, -1)?.1;
        index_changed |= tx.execute(
            "DELETE FROM message_fts_rowid_map WHERE session_id=?1 AND message_ordinal=?2",
            params![session, number],
        )? > 0;
        tx.execute(
            "DELETE FROM message_history_source WHERE session_id=?1 AND message_ordinal=?2",
            params![session, number],
        )?;
        index_changed |= insert(&tx, harness, session, entry, &content_of(entry))?;
    }
    generation.commit(tx, index_changed)
}

fn insert(
    conn: &Connection,
    harness: &str,
    session: &str,
    entry: &Entry,
    content: &str,
) -> rusqlite::Result<bool> {
    let number = entry.ordinal as i64;
    let role = role_name(entry);
    let source_timing = crate::notice_cost_timing::span("search.source_insert");
    conn.execute(
        "INSERT INTO message_history_source
            (session_id, message_id, message_ordinal, source_version, normalized_content_hash, role, harness, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(session_id, message_id) DO UPDATE SET
            message_ordinal = excluded.message_ordinal, source_version = excluded.source_version,
            normalized_content_hash = excluded.normalized_content_hash, role = excluded.role,
            updated_at = excluded.updated_at",
        params![session, entry.mid, number, entry.digest.to_string(), content_hash(content), role, harness, now_ms()],
    )?;
    drop(source_timing);
    if content.is_empty() {
        return Ok(false);
    }
    let fts_timing = crate::notice_cost_timing::span("search.fts_insert");
    conn.execute(
        "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![session, number, entry.mid, role, content],
    )?;
    drop(fts_timing);
    let _timing = crate::notice_cost_timing::span("search.rowid_insert");
    let rowid = conn.last_insert_rowid();
    let mapped = conn.execute(
        "INSERT INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid, message_time_ms)
         VALUES (?1, ?2, ?3, ?4) ON CONFLICT(session_id, message_ordinal) DO NOTHING",
        params![session, number, rowid, entry.written_at as i64],
    )?;
    if mapped == 0 {
        // Unlike a paired append, replacing a map entry can leave its old
        // FTS row without a map entry.
        conn.execute(
            "UPDATE message_fts_rowid_map SET fts_rowid = ?3, message_time_ms = ?4
             WHERE session_id = ?1 AND message_ordinal = ?2",
            params![session, number, rowid, entry.written_at as i64],
        )?;
    }
    Ok(mapped == 0)
}

/// Bring the session's index level with `entries` (the session's messages
/// in order). Messages past the watermark are added, and the newest indexed
/// one is replaced when its text changed, since a reply grows while its turn
/// runs. Work is split into short transactions.
pub fn index(
    conn: &mut Connection,
    harness: &str,
    session: &str,
    entries: &[Entry],
) -> rusqlite::Result<()> {
    index_with_generation(conn, &IndexGeneration::default(), harness, session, entries)
}

pub(super) fn index_with_generation(
    conn: &mut Connection,
    generation: &IndexGeneration,
    harness: &str,
    session: &str,
    entries: &[Entry],
) -> rusqlite::Result<()> {
    let _timing = crate::notice_cost_timing::span("search.index");
    let mark = watermark(conn, session)?;
    let start = entries.partition_point(|entry| (entry.ordinal as i64) < mark);
    let pending = &entries[start..];
    let mut stopped = false;
    for batch in pending.chunks(INDEX_BATCH) {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut index_changed = false;
        let mut mark = watermark(&tx, session)?;
        for entry in batch {
            let number = entry.ordinal as i64;
            if number < mark {
                continue;
            }
            if number > mark + 1 {
                // The watermark only moves over contiguous messages; ck-mc's
                // view does not hold the missing ones, so stop here.
                tracing::debug!("ck-mc: session {session}: search index stops at message {mark}; message {number} follows a gap");
                stopped = true;
                break;
            }
            let content = content_of(entry);
            if number == mark {
                let lookup_timing = crate::notice_cost_timing::span("search.boundary_lookup");
                let stored: Option<(String, String, String)> = tx
                    .query_row(
                        "SELECT message_id, normalized_content_hash, role FROM message_history_source
                          WHERE session_id = ?1 AND message_ordinal = ?2",
                        params![session, number],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()?;
                drop(lookup_timing);
                if stored.is_some_and(|(mid, hash, role)| {
                    mid == entry.mid && role == role_name(entry) && hash == content_hash(&content)
                }) {
                    continue;
                }
                index_changed |= delete_from(&tx, session, number)?;
            }
            index_changed |= insert(&tx, harness, session, entry, &content)?;
            mark = number;
        }
        set_watermark(&tx, harness, session, mark)?;
        let _timing = crate::notice_cost_timing::span("search.commit");
        generation.commit(tx, index_changed)?;
        if stopped {
            break;
        }
    }
    Ok(())
}

/// The transcript changed from `from_ordinal` on (a revert or a branch
/// switch): forget the index rows from there.
pub fn forget_from(
    conn: &mut Connection,
    harness: &str,
    session: &str,
    from_ordinal: u64,
) -> rusqlite::Result<()> {
    let from_number = from_ordinal as i64;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if watermark(&tx, session)? >= from_number {
        delete_from(&tx, session, from_number)?;
        set_watermark(&tx, harness, session, from_number - 1)?;
    }
    tx.commit()
}

/// One generation for a single ck-mc process's index writers and readers.
/// The schema fence keeps older plugin hosts from writing the store. Live
/// session moves leave the index alone; the separate offline session mover
/// can rewrite it and must not run while the module is serving the store.
/// A paired FTS/map append cannot change which FTS rows lack a mapping.
/// Pair commits that can change that set with the reader's first SQLite
/// read, so a WAL snapshot cannot cache coverage for a different generation.
#[derive(Default)]
pub(crate) struct IndexGeneration(std::sync::Mutex<u64>);

impl IndexGeneration {
    pub(crate) fn snapshot<T>(&self, read_first: impl FnOnce() -> T) -> (u64, T) {
        let generation = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (*generation, read_first())
    }

    pub(super) fn commit(
        &self,
        tx: rusqlite::Transaction<'_>,
        coverage_changed: bool,
    ) -> rusqlite::Result<()> {
        if !coverage_changed {
            return tx.commit();
        }
        let mut generation = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        tx.commit()?;
        *generation += 1;
        Ok(())
    }
}

/// One message hit.
#[derive(Clone, Debug, PartialEq)]
pub struct MessageHit {
    pub number: i64,
    pub message_id: String,
    pub role: String,
    pub content: String,
    pub score: f64,
}

#[derive(Clone, Debug)]
struct Row {
    bm25: f64,
    rowid: i64,
    number: i64,
    message_id: String,
    role: String,
    content: String,
}

/// What a lane searches for.
pub struct Query<'a> {
    pub text: &'a str,
    /// Results to return.
    pub limit: usize,
    /// Literal probes from the query (see [`super::text::literal_probes`]).
    pub probes: &'a [String],
    pub dates: Option<DateRange>,
    /// Message ordinals with at least one original part still in view.
    pub visible: Option<&'a BTreeSet<i64>>,
}

/// An inclusive millisecond range.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DateRange {
    pub from: i64,
    pub to: i64,
}

impl DateRange {
    pub fn contains(&self, at: i64) -> bool {
        at >= self.from && at <= self.to
    }
}

/// How the message lane reaches one session's rows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reach {
    /// The session has nothing indexed: no row in `message_fts_rowid_map`
    /// and an index watermark of 0. Its reads would find nothing, so no
    /// full-text read runs.
    Nothing,
    /// Every full-text row of the session has its rowid in the rowid map,
    /// so matches are screened by the session's mapped rowids before any
    /// row's stored content is read.
    Mapped,
    /// Some full-text rows of the session are missing from the map (rows
    /// written before the map existed), and the coverage proof found every
    /// one of them: these are their rowids, in ascending order. Matches are
    /// screened by the session's mapped rowids and these rowids, the same
    /// way as for [`Reach::Mapped`].
    Partly(Arc<[i64]>),
    /// No proof says which of the session's full-text rows the map lacks:
    /// every match in the store is checked by its session id, which is read
    /// from the row's stored content.
    Unmapped,
}

/// Keeps a match only when the session's rowid map holds its rowid, before
/// the `session_id` column is read: that column is `UNINDEXED`, so reading
/// it loads the whole stored row, and an ORed query matches about half the
/// store. The unary `+` keeps SQLite from running the full-text query again
/// for each mapped rowid. The session-id test after it stays, so a map row
/// naming the wrong session can never let another session's message
/// through. `?1` is the session in every statement that uses it.
const SESSION_SCREEN: &str = "+message_history_fts.rowid IN (
    SELECT fts_rowid FROM message_fts_rowid_map WHERE session_id = ?1) AND";

/// The screen a read of `reach` starts its conditions with: for
/// [`Reach::Partly`], [`SESSION_SCREEN`] widened by the session's rowids
/// the map lacks, bound as a JSON array at `?{slot}` (see
/// [`unmapped_rowids`]). Without the screen, an unscreened read loads the
/// stored row of every match in the store to test its session.
fn screen(reach: &Reach, slot: usize) -> String {
    match reach {
        Reach::Mapped => SESSION_SCREEN.to_owned(),
        Reach::Partly(_) => format!(
            "+message_history_fts.rowid IN (
                SELECT fts_rowid FROM message_fts_rowid_map WHERE session_id = ?1
                UNION ALL SELECT value FROM json_each(?{slot})) AND"
        ),
        Reach::Nothing | Reach::Unmapped => String::new(),
    }
}

/// The parameter [`screen`] binds at its slot, when it binds one.
fn unmapped_rowids(reach: &Reach) -> Option<rusqlite::types::Value> {
    match reach {
        Reach::Partly(rowids) => Some(rusqlite::types::Value::Text(
            serde_json::to_string(&rowids[..]).expect("rowids serialize"),
        )),
        _ => None,
    }
}

/// Above this many unmapped full-text rows the coverage proof gives up and
/// every session keeps the unscreened query. Finding a row's session reads
/// its stored content, and a store whose rows the plugin has not yet mapped
/// can have millions of them.
const UNMAPPED_LIMIT: usize = 10_000;

/// Which full-text rows of the store are missing from
/// `message_fts_rowid_map`, and whose they are, as last proven on one
/// connection. This is the TypeScript plugin's coverage check
/// (`message-fts-session-filter.ts`), which screens a session by its mapped
/// rowids only when no physical row of the store whose rowid the map lacks
/// belongs to it. Here a session that owns such rows is screened too, by
/// its mapped rowids and those rows' rowids ([`Reach::Partly`]). The plugin
/// finds those rows with SQL `EXCEPT`, which takes about two seconds on a
/// store of two million messages; here the map's rowids are sorted and
/// merged with the row-size table's rowids, which are already in order.
///
/// A proof is reused only for snapshots from the same index generation.
/// Compute a new proof if the reader did not capture an index generation
/// when it acquired its SQLite snapshot.
#[derive(Default)]
pub struct Coverage {
    generation: Option<u64>,
    proof: Option<Proof>,
    scans: u64,
}

struct Proof {
    generation: Option<u64>,
    incomplete: Incomplete,
}

enum Incomplete {
    /// The rowids the map lacks, in ascending order, by the session whose
    /// row each is.
    Sessions(HashMap<String, Arc<[i64]>>),
    /// Too many unmapped rows to prove coverage for any session.
    All,
}

impl Coverage {
    pub(crate) fn for_snapshot(&mut self, generation: u64) {
        self.generation = Some(generation);
    }

    /// Whether every full-text row of `session` has its rowid in the map.
    pub fn complete(&mut self, conn: &Connection, session: &str) -> bool {
        self.unmapped(conn, session)
            .is_some_and(|rowids| rowids.is_empty())
    }

    /// The rowids of `session`'s full-text rows that the map lacks, in
    /// ascending order (empty when the map has them all), or `None` when no
    /// proof could be made.
    pub fn unmapped(&mut self, conn: &Connection, session: &str) -> Option<Arc<[i64]>> {
        if self.generation.is_none()
            || self
                .proof
                .as_ref()
                .is_none_or(|proof| proof.generation != self.generation)
        {
            self.scans += 1;
            self.proof = unmapped_sessions(conn).ok().map(|incomplete| Proof {
                generation: self.generation,
                incomplete,
            });
        }
        match self.proof.as_ref().map(|proof| &proof.incomplete) {
            Some(Incomplete::Sessions(sessions)) => Some(
                sessions
                    .get(session)
                    .cloned()
                    .unwrap_or_else(|| Arc::from([])),
            ),
            _ => None,
        }
    }

    /// How many times the store has been scanned for unmapped rows.
    pub fn scans(&self) -> u64 {
        self.scans
    }
}

/// The full-text rows whose rowid the map lacks, by the session owning each.
fn unmapped_sessions(conn: &Connection) -> rusqlite::Result<Incomplete> {
    let mut mapped: Vec<i64> = conn
        .prepare("SELECT fts_rowid FROM message_fts_rowid_map")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    mapped.sort_unstable();
    let mut mapped = mapped.into_iter().peekable();
    // FTS5 keeps one row-size entry per physical row, keyed by its rowid.
    let mut statement = conn.prepare("SELECT id FROM message_history_fts_docsize ORDER BY id")?;
    let mut rows = statement.query([])?;
    let mut missing = Vec::new();
    while let Some(row) = rows.next()? {
        let id: i64 = row.get(0)?;
        while mapped.next_if(|rowid| *rowid < id).is_some() {}
        if mapped.peek() != Some(&id) {
            if missing.len() == UNMAPPED_LIMIT {
                return Ok(Incomplete::All);
            }
            missing.push(id);
        }
    }
    drop(rows);
    let mut owner = conn.prepare("SELECT session_id FROM message_history_fts WHERE rowid = ?1")?;
    let mut sessions: HashMap<String, Vec<i64>> = HashMap::new();
    // `missing` is in ascending order, so each session's list is too.
    for id in missing {
        let session: Option<rusqlite::types::Value> =
            owner.query_row(params![id], |row| row.get(0)).optional()?;
        // Searches bind the session as text, which never equals a stored
        // value of another type.
        if let Some(rusqlite::types::Value::Text(session)) = session {
            sessions.entry(session).or_default().push(id);
        }
    }
    Ok(Incomplete::Sessions(
        sessions
            .into_iter()
            .map(|(session, rowids)| (session, Arc::from(rowids)))
            .collect(),
    ))
}

/// How the message lane reaches `session`'s rows. A dated read joins the
/// rowid map anyway, so it only ever finds mapped rows and can always be
/// screened by them alone, as the plugin does.
pub fn reach(
    conn: &Connection,
    coverage: &mut Coverage,
    session: &str,
    dates: Option<DateRange>,
) -> Reach {
    let mapped = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM message_fts_rowid_map WHERE session_id = ?1)",
        params![session],
        |row| row.get::<_, bool>(0),
    );
    match mapped {
        // Every writer of the index maps each row it adds and raises the
        // session's watermark in the same transaction.
        Ok(false) if watermark(conn, session).is_ok_and(|mark| mark <= 0) => return Reach::Nothing,
        Ok(_) => {}
        Err(_) => return Reach::Unmapped,
    }
    if dates.is_some() {
        return Reach::Mapped;
    }
    screened_reach(conn, coverage, session)
}

pub(crate) fn screened_reach(conn: &Connection, coverage: &mut Coverage, session: &str) -> Reach {
    match coverage.unmapped(conn, session) {
        Some(rowids) if rowids.is_empty() => Reach::Mapped,
        Some(rowids) => Reach::Partly(rowids),
        None => Reach::Unmapped,
    }
}

/// The session and filters every full-text read of one search shares.
#[derive(Clone, Copy)]
struct Within<'a> {
    session: &'a str,
    /// The newest message number a read may return.
    cutoff: i64,
    dates: Option<DateRange>,
    visible: Option<&'a BTreeSet<i64>>,
    reach: &'a Reach,
}

impl Within<'_> {
    /// Whether a row a read returned may be shown: its number parsed and is
    /// not past the cutoff.
    fn admits(&self, row: &Row) -> bool {
        row.number >= 0 && row.number <= self.cutoff
    }
}

/// Run one sanitized FTS query over the session's indexed messages up to
/// the cutoff, best first, and return the rows of `page` (a limit and an
/// offset) before [`Within::admits`] drops any. The cutoff applies before
/// the limit, so newer matches never crowd out older ones. Ties in rank
/// and message number fall to the rowid, so a shorter page is always the
/// start of a longer one.
fn query_raw(conn: &Connection, within: Within, fts: &str, page: (usize, usize)) -> Vec<Row> {
    query_raw_after(conn, within, fts, page, None)
}

fn query_raw_after(
    conn: &Connection,
    within: Within,
    fts: &str,
    page: (usize, usize),
    after: Option<AppPosition>,
) -> Vec<Row> {
    if fts.is_empty() || *within.reach == Reach::Nothing {
        return Vec::new();
    }
    // The table also indexes `role`, so restrict matching to the content.
    let matching = format!("content : ({fts})");
    let (join, date_filter) = match within.dates {
        Some(_) => (
            "JOIN message_fts_rowid_map AS map ON map.session_id = message_history_fts.session_id
                AND map.fts_rowid = message_history_fts.rowid",
            "AND map.message_time_ms BETWEEN ?5 AND ?6",
        ),
        None => ("", ""),
    };
    let (after_filter, screen_start) = if after.is_some() {
        ("AND (bm25(message_history_fts), CAST(message_history_fts.message_ordinal AS INTEGER), \
          message_history_fts.rowid) > (?9, ?10, ?11)", 12)
    } else {
        ("", 9)
    };
    let screen = screen(within.reach, screen_start);
    let sql = format!(
        "SELECT message_history_fts.message_ordinal, message_history_fts.message_id,
                message_history_fts.role, message_history_fts.content,
                bm25(message_history_fts), message_history_fts.rowid
           FROM message_history_fts {join}
          WHERE {screen} message_history_fts.session_id = ?1 AND message_history_fts MATCH ?2
            AND CAST(message_history_fts.message_ordinal AS INTEGER) <= ?3 {date_filter}
            AND CAST(message_history_fts.message_ordinal AS INTEGER) NOT IN (SELECT value FROM json_each(?7))
            {after_filter}
          ORDER BY bm25(message_history_fts), CAST(message_history_fts.message_ordinal AS INTEGER) ASC,
                   message_history_fts.rowid ASC
           LIMIT ?4 OFFSET ?8"
    );
    let read = |conn: &Connection| -> rusqlite::Result<Vec<Row>> {
        let mut statement = conn.prepare_cached(&sql)?;
        let map = |row: &rusqlite::Row| -> rusqlite::Result<Row> {
            let number: rusqlite::types::Value = row.get(0)?;
            let number = match number {
                rusqlite::types::Value::Integer(number) => number,
                rusqlite::types::Value::Text(text) => text.trim().parse().unwrap_or(-1),
                _ => -1,
            };
            Ok(Row {
                number,
                message_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                bm25: row.get(4)?,
                rowid: row.get(5)?,
            })
        };
        let visible = serde_json::to_string(&within.visible.cloned().unwrap_or_default())
            .expect("ordinals serialize");
        let mut values: Vec<rusqlite::types::Value> = vec![
            within.session.to_owned().into(),
            matching.clone().into(),
            within.cutoff.into(),
            (page.0 as i64).into(),
            within.dates.map(|dates| dates.from).into(),
            within.dates.map(|dates| dates.to).into(),
            visible.into(),
            (page.1 as i64).into(),
        ];
        if let Some(after) = after {
            values.extend([after.bm25.into(), after.ordinal.into(), after.rowid.into()]);
        }
        values.extend(unmapped_rowids(within.reach));
        let rows = statement
            .query_map(rusqlite::params_from_iter(values), map)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    };
    // Malformed FTS syntax that survived quoting finds nothing.
    read(conn).unwrap_or_default()
}

/// The rows a read of at most `fetch` rows keeps, taken from the start of a
/// longer read of the same query.
fn window(raw: &[Row], fetch: usize, within: Within) -> Vec<Row> {
    raw.iter()
        .take(fetch)
        .filter(|row| within.admits(row))
        .cloned()
        .collect()
}

/// Read a window of visible messages and hidden history by offset. The app
/// read uses [`app_page_with_reach`] to continue from a ranked position.
pub fn app_page(
    conn: &Connection,
    session: &str,
    text: &str,
    offset: usize,
    limit: usize,
) -> Vec<MessageHit> {
    app_rows(conn, session, text, offset, None, limit, &Reach::Unmapped)
        .iter()
        .enumerate()
        .map(|(index, row)| hit(row, text, 1.0 / (offset + index + 1) as f64))
        .collect()
}

/// The app's internal sort key; the public hit score is still reciprocal rank.
#[derive(Clone, Copy)]
pub(crate) struct AppPosition {
    pub bm25: f64,
    pub ordinal: i64,
    pub rowid: i64,
}

pub(crate) fn app_page_with_reach(
    conn: &Connection,
    session: &str,
    text: &str,
    after: Option<AppPosition>,
    seen: usize,
    limit: usize,
    reach: &Reach,
) -> Vec<(MessageHit, AppPosition)> {
    app_rows(conn, session, text, 0, after, limit, reach)
        .into_iter()
        .enumerate()
        .map(|(index, row)| {
            let position = AppPosition {
                bm25: row.bm25,
                ordinal: row.number,
                rowid: row.rowid,
            };
            (hit(&row, text, 1.0 / (seen + index + 1) as f64), position)
        })
        .collect()
}

fn app_rows(
    conn: &Connection,
    session: &str,
    text: &str,
    offset: usize,
    after: Option<AppPosition>,
    limit: usize,
    reach: &Reach,
) -> Vec<Row> {
    let within = Within {
        session,
        cutoff: i64::MAX,
        dates: None,
        visible: None,
        reach,
    };
    let base = sanitize_fts_query(text.trim());
    let read = |fts: &str| {
        query_raw_after(conn, within, fts, (limit, offset), after)
            .into_iter()
            .filter(|row| within.admits(row))
            .collect::<Vec<_>>()
    };
    let rows = read(&base);
    if rows.is_empty()
        && (offset == 0 && after.is_none()
            || query_raw(conn, within, &base, (1, 0))
                .iter()
                .all(|row| !within.admits(row)))
    {
        read(&relaxed_fts_query(text))
    } else {
        rows
    }
}

/// How many messages up to the cutoff match `fts`, for one probe's weight.
fn count_matches(conn: &Connection, within: Within, fts: &str) -> u64 {
    if fts.is_empty() || *within.reach == Reach::Nothing {
        return 0;
    }
    let matching = format!("content : ({fts})");
    let visible = serde_json::to_string(&within.visible.cloned().unwrap_or_default())
        .expect("ordinals serialize");
    let (sql, mut values): (String, Vec<rusqlite::types::Value>) = match within.dates {
        Some(dates) => (
            format!(
                "SELECT COUNT(*) FROM message_history_fts
                   JOIN message_fts_rowid_map AS map ON map.session_id = message_history_fts.session_id
                    AND map.fts_rowid = message_history_fts.rowid
                  WHERE {} message_history_fts.session_id = ?1 AND message_history_fts MATCH ?2
                    AND map.message_time_ms BETWEEN ?3 AND ?4
                    AND CAST(message_history_fts.message_ordinal AS INTEGER) <= ?5
                    AND CAST(message_history_fts.message_ordinal AS INTEGER) NOT IN (SELECT value FROM json_each(?6))",
                screen(within.reach, 7)
            ),
            vec![
                within.session.to_owned().into(),
                matching.into(),
                dates.from.into(),
                dates.to.into(),
                within.cutoff.into(),
                visible.into(),
            ],
        ),
        None => (
            format!(
                "SELECT COUNT(*) FROM message_history_fts
                  WHERE {} message_history_fts.session_id = ?1 AND message_history_fts MATCH ?2
                    AND CAST(message_history_fts.message_ordinal AS INTEGER) <= ?3
                    AND CAST(message_history_fts.message_ordinal AS INTEGER) NOT IN (SELECT value FROM json_each(?4))",
                screen(within.reach, 5)
            ),
            vec![
                within.session.to_owned().into(),
                matching.into(),
                within.cutoff.into(),
                visible.into(),
            ],
        ),
    };
    values.extend(unmapped_rowids(within.reach));
    let result = conn.query_row(&sql, rusqlite::params_from_iter(values), |row| {
        row.get::<_, i64>(0)
    });
    result.map_or(0, |count| count.max(0) as u64)
}

/// How many indexed matches are newer than the cutoff, so a result can say
/// they were left out because the model already sees them.
pub fn count_live_matches(
    conn: &Connection,
    session: &str,
    query: &str,
    cutoff: i64,
    dates: Option<DateRange>,
    visible: Option<&BTreeSet<i64>>,
    reach: &Reach,
) -> u64 {
    let fts = sanitize_fts_query(query.trim());
    let eligible = Within {
        session,
        cutoff,
        dates,
        visible,
        reach,
    };
    let everything = Within {
        cutoff: i64::MAX,
        visible: None,
        ..eligible
    };
    let total = count_matches(conn, everything, &fts);
    total.saturating_sub(count_matches(conn, eligible, &fts))
}

fn linear_decay(rank: usize, total: usize) -> f64 {
    if total == 0 {
        return 0.0;
    }
    (1.0 - rank as f64 / total as f64).max(0.0)
}

fn hit(row: &Row, query: &str, score: f64) -> MessageHit {
    let snippet = matched_snippet(&row.content, query, super::text::PREVIEW_LIMIT);
    MessageHit {
        number: row.number,
        message_id: row.message_id.clone(),
        role: row.role.clone(),
        content: if snippet.is_empty() {
            preview(&row.content)
        } else {
            snippet
        },
        score,
    }
}

/// Search the session's messages up to message `cutoff`. With no probes,
/// the ANDed query ranks alone (falling back to its ORed form when
/// `relaxed` and it found nothing); with probes, the query and each probe
/// rank separately and fuse, each probe weighted by how rare it is.
pub fn search(
    conn: &Connection,
    session: &str,
    wanted: &Query,
    cutoff: i64,
    relaxed: bool,
    reach: &Reach,
) -> Vec<MessageHit> {
    search_at(
        conn,
        session,
        wanted,
        &[wanted.limit],
        cutoff,
        relaxed,
        reach,
    )
    .pop()
    .unwrap_or_default()
}

/// [`search`] at several depths from one set of reads: for each of
/// `limits`, in order, the hits [`search`] returns with `wanted.limit` set
/// to it. Each query is read once, deep enough for the largest limit, and
/// each depth uses only the rows a read of its own size returns, so every
/// list equals a separate search at that limit.
pub fn search_at(
    conn: &Connection,
    session: &str,
    wanted: &Query,
    limits: &[usize],
    cutoff: i64,
    relaxed: bool,
    reach: &Reach,
) -> Vec<Vec<MessageHit>> {
    let Query {
        text: query,
        probes,
        dates,
        visible,
        ..
    } = *wanted;
    if *reach == Reach::Nothing {
        return limits.iter().map(|_| Vec::new()).collect();
    }
    let within = Within {
        session,
        cutoff,
        dates,
        visible,
        reach,
    };
    // A search at `limit` reads up to three times that many rows per query.
    let fetch = |limit: usize| limit * 3;
    let deepest = limits.iter().copied().map(fetch).max().unwrap_or(0);
    let read = |fts: &str| query_raw(conn, within, fts, (deepest, 0));
    let base = sanitize_fts_query(query.trim());
    if probes.is_empty() {
        let strict = read(&base);
        let mut loose: Option<Vec<Row>> = None;
        return limits
            .iter()
            .map(|&limit| {
                let mut rows = window(&strict, fetch(limit), within);
                if rows.is_empty() && relaxed {
                    let loose = loose.get_or_insert_with(|| read(&relaxed_fts_query(query)));
                    rows = window(loose, fetch(limit), within);
                }
                rows.truncate(limit);
                let total = rows.len();
                rows.iter()
                    .enumerate()
                    .map(|(rank, row)| hit(row, query, linear_decay(rank, total)))
                    .collect()
            })
            .collect();
    }
    let corpus = watermark(conn, session).unwrap_or(0).min(cutoff.max(0)) as f64;
    let mut lists: Vec<(Vec<Row>, f64)> = Vec::new();
    if !base.is_empty() {
        lists.push((read(&base), 1.0));
    }
    let mut weights: HashMap<&str, f64> = HashMap::new();
    for probe in probes {
        let fts = sanitize_fts_query(probe);
        if fts.is_empty() {
            continue;
        }
        let df = count_matches(conn, within, &fts) as f64;
        let weight = if corpus <= 0.0 || df <= 0.0 {
            1.0
        } else {
            1.0 / (1.0 + IDF_FALLOFF * df / corpus)
        };
        weights.insert(probe.as_str(), weight);
        lists.push((read(&fts), weight));
    }
    limits
        .iter()
        .map(|&limit| {
            let mut fused: Vec<(Row, f64)> = Vec::new();
            for (raw, weight) in &lists {
                for (rank, row) in window(raw, fetch(limit), within).iter().enumerate() {
                    let contribution = weight / (RRF_K + rank as f64);
                    match fused
                        .iter_mut()
                        .find(|(existing, _)| existing.message_id == row.message_id)
                    {
                        Some((_, score)) => *score += contribution,
                        None => fused.push((row.clone(), contribution)),
                    }
                }
            }
            for (row, score) in &mut fused {
                let best = probes
                    .iter()
                    .filter(|probe| {
                        contains_probe_verbatim(&row.content, std::slice::from_ref(probe))
                    })
                    .map(|probe| weights.get(probe.as_str()).copied().unwrap_or(0.0))
                    .fold(0.0, f64::max);
                if best > 0.0 {
                    *score += best * VERBATIM_RANK_BONUS;
                }
            }
            fused.sort_by(|(left, left_score), (right, right_score)| {
                right_score
                    .partial_cmp(left_score)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(left.number.cmp(&right.number))
            });
            fused.truncate(limit);
            let total = fused.len();
            fused
                .iter()
                .enumerate()
                .map(|(rank, (row, _))| hit(row, query, linear_decay(rank, total)))
                .collect()
        })
        .collect()
}
