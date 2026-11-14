//! The raw-message lane: ck-mc's share of the search index the standalone
//! plugin keeps in `context.db`, and the search over it.
//!
//! Rows are keyed by host session id and message number (the runner's
//! ordinal plus one), as the plugin keys them, so a moved session keeps
//! searching the rows the plugin wrote before the move. Only user and
//! assistant text is indexed; tool output, reasoning, notices and agent relays are not.

use std::collections::{BTreeSet, HashMap};

use cortexkit_role_compaction::part::PartBody;
use cortexkit_role_compaction::read::{Entry, Role};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

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

fn role_name(role: &Role) -> &str {
    role.as_str()
}

/// What `entry` adds to the index, or empty.
fn content_of(entry: &Entry) -> String {
    if entry.notice.is_some() || entry.speaks_for.is_some() {
        return String::new();
    }
    let texts: Vec<&str> = crate::neutral::authored_parts(entry)
        .filter_map(|part| match &part.body {
            PartBody::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    indexable_content(entry.role == Role::User, &texts)
}

#[cfg(test)]
#[path = "messages_tests.rs"]
mod reach_tests;

#[cfg(test)]
mod attribution_tests {
    #[test]
    fn host_parts_search_reconcile_refreshes_unchanged_digest() {
        use cortexkit_role_compaction::{
            part::{Part, PartBody},
            read::{Entry, HostPart, Role},
        };
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            &include_str!("../../testdata/context-schema.sql").replace(":applied_at", "0"),
        )
        .unwrap();
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
        super::reconcile(&mut conn, "mock", "s", std::slice::from_ref(&entry)).unwrap();
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

fn delete_from(conn: &Connection, session: &str, from_number: i64) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM message_history_fts
          WHERE session_id = ?1 AND CAST(message_ordinal AS INTEGER) >= ?2",
        params![session, from_number],
    )?;
    conn.execute(
        "DELETE FROM message_fts_rowid_map WHERE session_id = ?1 AND message_ordinal >= ?2",
        params![session, from_number],
    )?;
    conn.execute(
        "DELETE FROM message_history_source WHERE session_id = ?1 AND message_ordinal >= ?2",
        params![session, from_number],
    )?;
    Ok(())
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
pub(super) fn delete_fts_range(
    conn: &Connection,
    session: &str,
    from: i64,
    through: i64,
    limit: i64,
) -> rusqlite::Result<bool> {
    conn.execute("DELETE FROM message_history_fts WHERE rowid IN (SELECT fts_rowid FROM message_fts_rowid_map WHERE session_id=?1 AND message_ordinal BETWEEN ?2 AND ?3)",params![session,from,through])?;
    let (watermark, completed): (i64, bool) = conn
        .query_row(
            "SELECT watermark_rowid,completed FROM message_fts_rowid_map_backfill_state WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .unwrap_or((0, false));
    if completed {
        return Ok(false);
    }
    conn.execute("DELETE FROM message_history_fts WHERE rowid IN (SELECT rowid FROM message_history_fts WHERE rowid>?1 AND session_id=?2 AND CAST(message_ordinal AS INTEGER) BETWEEN ?3 AND ?4 LIMIT ?5)",params![watermark,session,from,through,limit])?;
    conn.query_row("SELECT EXISTS(SELECT 1 FROM message_history_fts WHERE rowid>?1 AND session_id=?2 AND CAST(message_ordinal AS INTEGER) BETWEEN ?3 AND ?4)",params![watermark,session,from,through],|r|r.get(0))
}

/// Setup checks the supplied entries after a restart without rebuilding unchanged
/// rows. Changes to an older tool's result still refresh its source digest.
pub(super) fn reconcile(
    conn: &mut Connection,
    harness: &str,
    session: &str,
    entries: &[Entry],
) -> rusqlite::Result<()> {
    let mark = watermark(conn, session)?.max(0) as u64;
    let mut changed = Vec::new();
    for entry in entries.iter().filter(|entry| entry.ordinal <= mark) {
        let stored:Option<(String,String,String)>=conn.query_row("SELECT message_id,source_version,normalized_content_hash FROM message_history_source WHERE session_id=?1 AND message_ordinal=?2",params![session,entry.ordinal as i64],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        if stored.as_ref().is_none_or(|(mid, digest, hash)| {
            mid != &entry.mid
                || digest != &entry.digest
                || hash != &content_hash(&content_of(entry))
        }) {
            changed.push(entry);
        }
    }
    if changed.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for entry in changed {
        let number = entry.ordinal as i64;
        delete_fts_range(&tx, session, number, number, -1)?;
        tx.execute(
            "DELETE FROM message_fts_rowid_map WHERE session_id=?1 AND message_ordinal=?2",
            params![session, number],
        )?;
        tx.execute(
            "DELETE FROM message_history_source WHERE session_id=?1 AND message_ordinal=?2",
            params![session, number],
        )?;
        insert(&tx, harness, session, entry, &content_of(entry))?;
    }
    tx.commit()
}

fn insert(
    conn: &Connection,
    harness: &str,
    session: &str,
    entry: &Entry,
    content: &str,
) -> rusqlite::Result<()> {
    let number = entry.ordinal as i64;
    let role = role_name(&entry.role);
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
        return Ok(());
    }
    let fts_timing = crate::notice_cost_timing::span("search.fts_insert");
    conn.execute(
        "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![session, number, entry.mid, role, content],
    )?;
    drop(fts_timing);
    let _timing = crate::notice_cost_timing::span("search.rowid_insert");
    conn.execute(
        "INSERT OR REPLACE INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid, message_time_ms)
         VALUES (?1, ?2, ?3, ?4)",
        params![session, number, conn.last_insert_rowid(), entry.written_at as i64],
    )?;
    Ok(())
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
    let _timing = crate::notice_cost_timing::span("search.index");
    let mark = watermark(conn, session)?;
    let start = entries.partition_point(|entry| (entry.ordinal as i64) < mark);
    let pending = &entries[start..];
    let mut stopped = false;
    for batch in pending.chunks(INDEX_BATCH) {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
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
                let stored: Option<(String, String)> = tx
                    .query_row(
                        "SELECT message_id, normalized_content_hash FROM message_history_source
                          WHERE session_id = ?1 AND message_ordinal = ?2",
                        params![session, number],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                drop(lookup_timing);
                if stored == Some((entry.mid.clone(), content_hash(&content))) {
                    continue;
                }
                delete_from(&tx, session, number)?;
            }
            insert(&tx, harness, session, entry, &content)?;
            mark = number;
        }
        set_watermark(&tx, harness, session, mark)?;
        let _timing = crate::notice_cost_timing::span("search.commit");
        tx.commit()?;
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
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reach {
    /// The session has nothing indexed: no row in `message_fts_rowid_map`
    /// and an index watermark of 0. Its reads would find nothing, so no
    /// full-text read runs.
    Nothing,
    /// Every full-text row of the session has its rowid in the rowid map,
    /// so matches are screened by the session's mapped rowids before any
    /// row's stored content is read.
    Mapped,
    /// Some full-text rows of the session may be missing from the map (rows
    /// written before the map existed): every match in the store is checked
    /// by its session id, which is read from the row's stored content.
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

/// Above this many unmapped full-text rows the coverage proof gives up and
/// every session keeps the unscreened query. Finding a row's session reads
/// its stored content, and a store whose rows the plugin has not yet mapped
/// can have millions of them.
const UNMAPPED_LIMIT: usize = 10_000;

/// Which sessions have full-text rows missing from `message_fts_rowid_map`,
/// as last proven on one connection. This is the TypeScript plugin's
/// coverage check (`message-fts-session-filter.ts`): a session is screened
/// by its mapped rowids only when no physical row of the store whose rowid
/// the map lacks belongs to it. The plugin finds those rows with SQL
/// `EXCEPT`, which takes about two seconds on a store of two million
/// messages; here the map's rowids are sorted and merged with the row-size
/// table's rowids, which are already in order.
///
/// A proof is reused until the connection sees another connection's commit
/// (`PRAGMA data_version`) or makes a change itself (`total_changes()`), and
/// only on a read-only connection: a connection that writes could hold a
/// change that a rollback undoes without moving either number. Ask it only
/// inside a read transaction that has already read the store, so the proof
/// and the reads it permits see the same snapshot.
#[derive(Default)]
pub struct Coverage {
    proof: Option<Proof>,
    scans: u64,
}

struct Proof {
    /// `total_changes()` and `data_version` when the proof was made.
    stamp: (i64, i64),
    incomplete: Incomplete,
}

enum Incomplete {
    Sessions(std::collections::HashSet<String>),
    /// No proof for any session: too many unmapped rows, or the store could
    /// not be read as expected (for example, without a row-size table).
    All,
}

impl Coverage {
    /// Whether every full-text row of `session` has its rowid in the map.
    pub fn complete(&mut self, conn: &Connection, session: &str) -> bool {
        let Ok(stamp) = conn.query_row(
            "SELECT total_changes(), data_version FROM pragma_data_version",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        ) else {
            return false;
        };
        let reusable = conn
            .is_readonly(rusqlite::DatabaseName::Main)
            .unwrap_or(false);
        if !reusable || self.proof.as_ref().is_none_or(|proof| proof.stamp != stamp) {
            self.scans += 1;
            self.proof = Some(Proof {
                stamp,
                incomplete: unmapped_sessions(conn),
            });
        }
        match self.proof.as_ref().map(|proof| &proof.incomplete) {
            Some(Incomplete::Sessions(sessions)) => !sessions.contains(session),
            _ => false,
        }
    }

    /// How many times the store has been scanned for unmapped rows.
    pub fn scans(&self) -> u64 {
        self.scans
    }
}

/// The sessions owning a full-text row whose rowid the map lacks.
fn unmapped_sessions(conn: &Connection) -> Incomplete {
    let scan = || -> rusqlite::Result<Incomplete> {
        let mut mapped: Vec<i64> = conn
            .prepare("SELECT fts_rowid FROM message_fts_rowid_map")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        mapped.sort_unstable();
        let mut mapped = mapped.into_iter().peekable();
        // FTS5 keeps one row-size entry per physical row, keyed by its rowid.
        let mut statement =
            conn.prepare("SELECT id FROM message_history_fts_docsize ORDER BY id")?;
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
        let mut owner =
            conn.prepare("SELECT session_id FROM message_history_fts WHERE rowid = ?1")?;
        let mut sessions = std::collections::HashSet::new();
        for id in missing {
            let session: Option<rusqlite::types::Value> =
                owner.query_row(params![id], |row| row.get(0)).optional()?;
            // Searches bind the session as text, which never equals a stored
            // value of another type.
            if let Some(rusqlite::types::Value::Text(session)) = session {
                sessions.insert(session);
            }
        }
        Ok(Incomplete::Sessions(sessions))
    };
    scan().unwrap_or(Incomplete::All)
}

/// How the message lane reaches `session`'s rows. A dated read joins the
/// rowid map anyway, so it only ever finds mapped rows and can always be
/// screened, as the plugin does.
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
    if dates.is_some() || coverage.complete(conn, session) {
        Reach::Mapped
    } else {
        Reach::Unmapped
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
    reach: Reach,
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
    if fts.is_empty() || within.reach == Reach::Nothing {
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
    let screen = if within.reach == Reach::Mapped {
        SESSION_SCREEN
    } else {
        ""
    };
    let sql = format!(
        "SELECT message_history_fts.message_ordinal, message_history_fts.message_id,
                message_history_fts.role, message_history_fts.content
           FROM message_history_fts {join}
          WHERE {screen} message_history_fts.session_id = ?1 AND message_history_fts MATCH ?2
            AND CAST(message_history_fts.message_ordinal AS INTEGER) <= ?3 {date_filter}
            AND CAST(message_history_fts.message_ordinal AS INTEGER) NOT IN (SELECT value FROM json_each(?7))
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
            })
        };
        let visible = serde_json::to_string(&within.visible.cloned().unwrap_or_default())
            .expect("ordinals serialize");
        let rows = statement
            .query_map(
                params![
                    within.session,
                    matching,
                    within.cutoff,
                    page.0 as i64,
                    within.dates.map(|dates| dates.from),
                    within.dates.map(|dates| dates.to),
                    visible,
                    page.1 as i64
                ],
                map,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    };
    // Malformed FTS syntax that survived quoting finds nothing.
    read(conn).unwrap_or_default()
}

fn query_rows_page(conn: &Connection, within: Within, fts: &str, page: (usize, usize)) -> Vec<Row> {
    query_raw(conn, within, fts, page)
        .into_iter()
        .filter(|row| within.admits(row))
        .collect()
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

/// App search includes visible messages as well as hidden history. Offset is
/// applied by SQLite, rather than fetching every preceding page into memory.
pub fn app_page(
    conn: &Connection,
    session: &str,
    text: &str,
    offset: usize,
    limit: usize,
) -> Vec<MessageHit> {
    let within = Within {
        session,
        cutoff: i64::MAX,
        dates: None,
        visible: None,
        reach: Reach::Unmapped,
    };
    let base = sanitize_fts_query(text.trim());
    let mut rows = query_rows_page(conn, within, &base, (limit, offset));
    let base_empty = if offset == 0 {
        rows.is_empty()
    } else {
        query_rows_page(conn, within, &base, (1, 0)).is_empty()
    };
    if base_empty {
        rows = query_rows_page(conn, within, &relaxed_fts_query(text), (limit, offset));
    }
    rows.iter()
        .enumerate()
        .map(|(index, row)| hit(row, text, 1.0 / (offset + index + 1) as f64))
        .collect()
}

/// How many messages up to the cutoff match `fts`, for one probe's weight.
fn count_matches(conn: &Connection, within: Within, fts: &str) -> u64 {
    if fts.is_empty() || within.reach == Reach::Nothing {
        return 0;
    }
    let matching = format!("content : ({fts})");
    let visible = serde_json::to_string(&within.visible.cloned().unwrap_or_default())
        .expect("ordinals serialize");
    let screen = if within.reach == Reach::Mapped {
        SESSION_SCREEN
    } else {
        ""
    };
    let result = match within.dates {
        Some(dates) => conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM message_history_fts
                   JOIN message_fts_rowid_map AS map ON map.session_id = message_history_fts.session_id
                    AND map.fts_rowid = message_history_fts.rowid
                  WHERE {screen} message_history_fts.session_id = ?1 AND message_history_fts MATCH ?2
                    AND map.message_time_ms BETWEEN ?3 AND ?4
                    AND CAST(message_history_fts.message_ordinal AS INTEGER) <= ?5
                    AND CAST(message_history_fts.message_ordinal AS INTEGER) NOT IN (SELECT value FROM json_each(?6))"
            ),
            params![within.session, matching, dates.from, dates.to, within.cutoff, visible],
            |row| row.get::<_, i64>(0),
        ),
        None => conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM message_history_fts
                  WHERE {screen} message_history_fts.session_id = ?1 AND message_history_fts MATCH ?2
                    AND CAST(message_history_fts.message_ordinal AS INTEGER) <= ?3
                    AND CAST(message_history_fts.message_ordinal AS INTEGER) NOT IN (SELECT value FROM json_each(?4))"
            ),
            params![within.session, matching, within.cutoff, visible],
            |row| row.get::<_, i64>(0),
        ),
    };
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
    reach: Reach,
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
    reach: Reach,
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
    reach: Reach,
) -> Vec<Vec<MessageHit>> {
    let Query {
        text: query,
        probes,
        dates,
        visible,
        ..
    } = *wanted;
    if reach == Reach::Nothing {
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
