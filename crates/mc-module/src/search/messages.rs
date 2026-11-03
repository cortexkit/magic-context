//! The raw-message lane: ck-mc's share of the search index the standalone
//! plugin keeps in `context.db`, and the search over it.
//!
//! Rows are keyed by host session id and message number (the runner's
//! ordinal plus one), as the plugin keys them, so a moved session keeps
//! searching the rows the plugin wrote before the move. Only user and
//! assistant text is indexed; tool output, reasoning and notices are not.

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
    if entry.notice.is_some() {
        return String::new();
    }
    let texts: Vec<&str> = entry
        .parts
        .iter()
        .filter_map(|part| match &part.body {
            PartBody::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    indexable_content(entry.role == Role::User, &texts)
}

fn content_hash(content: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

/// The session's index watermark: every message up to it is indexed.
fn watermark(conn: &Connection, session: &str) -> rusqlite::Result<i64> {
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

fn insert(
    conn: &Connection,
    harness: &str,
    session: &str,
    entry: &Entry,
    content: &str,
) -> rusqlite::Result<()> {
    let number = entry.ordinal as i64;
    let role = role_name(&entry.role);
    conn.execute(
        "INSERT INTO message_history_source
            (session_id, message_id, message_ordinal, source_version, normalized_content_hash, role, harness, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(session_id, message_id) DO UPDATE SET
            message_ordinal = excluded.message_ordinal, source_version = excluded.source_version,
            normalized_content_hash = excluded.normalized_content_hash, role = excluded.role,
            updated_at = excluded.updated_at",
        params![session, entry.mid, number, entry.digest, content_hash(content), role, harness, now_ms()],
    )?;
    if content.is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![session, number, entry.mid, role, content],
    )?;
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
                eprintln!("ck-mc: session {session}: search index stops at message {mark}; message {number} follows a gap");
                stopped = true;
                break;
            }
            let content = content_of(entry);
            if number == mark {
                let stored: Option<(String, String)> = tx
                    .query_row(
                        "SELECT message_id, normalized_content_hash FROM message_history_source
                          WHERE session_id = ?1 AND message_ordinal = ?2",
                        params![session, number],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                if stored == Some((entry.mid.clone(), content_hash(&content))) {
                    continue;
                }
                delete_from(&tx, session, number)?;
            }
            insert(&tx, harness, session, entry, &content)?;
            mark = number;
        }
        set_watermark(&tx, harness, session, mark)?;
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

/// Run one sanitized FTS query over the session's indexed messages up to
/// `cutoff`, best first. The cutoff applies before the limit, so newer
/// matches never crowd out older ones.
fn query_rows(
    conn: &Connection,
    session: &str,
    fts: &str,
    limit: usize,
    cutoff: i64,
    dates: Option<DateRange>,
    visible: Option<&BTreeSet<i64>>,
) -> Vec<Row> {
    query_rows_page(conn, session, fts, (limit, 0), cutoff, dates, visible)
}

fn query_rows_page(
    conn: &Connection,
    session: &str,
    fts: &str,
    page: (usize, usize),
    cutoff: i64,
    dates: Option<DateRange>,
    visible: Option<&BTreeSet<i64>>,
) -> Vec<Row> {
    if fts.is_empty() {
        return Vec::new();
    }
    // The table also indexes `role`, so restrict matching to the content.
    let matching = format!("content : ({fts})");
    let (join, date_filter) = match dates {
        Some(_) => (
            "JOIN message_fts_rowid_map AS map ON map.session_id = message_history_fts.session_id
                AND map.fts_rowid = message_history_fts.rowid",
            "AND map.message_time_ms BETWEEN ?5 AND ?6",
        ),
        None => ("", ""),
    };
    let sql = format!(
        "SELECT message_history_fts.message_ordinal, message_history_fts.message_id,
                message_history_fts.role, message_history_fts.content
           FROM message_history_fts {join}
          WHERE message_history_fts.session_id = ?1 AND message_history_fts MATCH ?2
            AND CAST(message_history_fts.message_ordinal AS INTEGER) <= ?3 {date_filter}
            AND CAST(message_history_fts.message_ordinal AS INTEGER) NOT IN (SELECT value FROM json_each(?7))
          ORDER BY bm25(message_history_fts), CAST(message_history_fts.message_ordinal AS INTEGER) ASC
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
        let visible = serde_json::to_string(&visible.cloned().unwrap_or_default())
            .expect("ordinals serialize");
        let rows = statement
            .query_map(
                params![
                    session,
                    matching,
                    cutoff,
                    page.0 as i64,
                    dates.map(|dates| dates.from),
                    dates.map(|dates| dates.to),
                    visible,
                    page.1 as i64
                ],
                map,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .filter(|row| row.number >= 0 && row.number <= cutoff)
            .collect())
    };
    // Malformed FTS syntax that survived quoting finds nothing.
    read(conn).unwrap_or_default()
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
    let base = sanitize_fts_query(text.trim());
    let mut rows = query_rows_page(conn, session, &base, (limit, offset), i64::MAX, None, None);
    let base_empty = if offset == 0 {
        rows.is_empty()
    } else {
        query_rows_page(conn, session, &base, (1, 0), i64::MAX, None, None).is_empty()
    };
    if base_empty {
        rows = query_rows_page(
            conn,
            session,
            &relaxed_fts_query(text),
            (limit, offset),
            i64::MAX,
            None,
            None,
        );
    }
    rows.iter()
        .enumerate()
        .map(|(index, row)| hit(row, text, 1.0 / (offset + index + 1) as f64))
        .collect()
}

/// How many messages up to `cutoff` match `fts`, for one probe's weight.
fn count_matches(
    conn: &Connection,
    session: &str,
    fts: &str,
    cutoff: i64,
    dates: Option<DateRange>,
    visible: Option<&BTreeSet<i64>>,
) -> u64 {
    if fts.is_empty() {
        return 0;
    }
    let matching = format!("content : ({fts})");
    let visible =
        serde_json::to_string(&visible.cloned().unwrap_or_default()).expect("ordinals serialize");
    let result = match dates {
        Some(dates) => conn.query_row(
            "SELECT COUNT(*) FROM message_history_fts
               JOIN message_fts_rowid_map AS map ON map.session_id = message_history_fts.session_id
                AND map.fts_rowid = message_history_fts.rowid
              WHERE message_history_fts.session_id = ?1 AND message_history_fts MATCH ?2
                AND map.message_time_ms BETWEEN ?3 AND ?4
                AND CAST(message_history_fts.message_ordinal AS INTEGER) <= ?5
                AND CAST(message_history_fts.message_ordinal AS INTEGER) NOT IN (SELECT value FROM json_each(?6))",
            params![session, matching, dates.from, dates.to, cutoff, visible],
            |row| row.get::<_, i64>(0),
        ),
        None => conn.query_row(
            "SELECT COUNT(*) FROM message_history_fts
              WHERE session_id = ?1 AND message_history_fts MATCH ?2
                AND CAST(message_ordinal AS INTEGER) <= ?3
                AND CAST(message_ordinal AS INTEGER) NOT IN (SELECT value FROM json_each(?4))",
            params![session, matching, cutoff, visible],
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
) -> u64 {
    let fts = sanitize_fts_query(query.trim());
    let total = count_matches(conn, session, &fts, i64::MAX, dates, None);
    total.saturating_sub(count_matches(conn, session, &fts, cutoff, dates, visible))
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
) -> Vec<MessageHit> {
    let Query {
        text: query,
        limit,
        probes,
        dates,
        visible,
    } = *wanted;
    let fetch = limit * 3;
    let base = sanitize_fts_query(query.trim());
    if probes.is_empty() {
        let mut rows = query_rows(conn, session, &base, fetch, cutoff, dates, visible);
        if rows.is_empty() && relaxed {
            rows = query_rows(
                conn,
                session,
                &relaxed_fts_query(query),
                fetch,
                cutoff,
                dates,
                visible,
            );
        }
        rows.truncate(limit);
        let total = rows.len();
        return rows
            .iter()
            .enumerate()
            .map(|(rank, row)| hit(row, query, linear_decay(rank, total)))
            .collect();
    }
    let corpus = watermark(conn, session).unwrap_or(0).min(cutoff.max(0)) as f64;
    let mut lists: Vec<(Vec<Row>, f64)> = Vec::new();
    if !base.is_empty() {
        lists.push((
            query_rows(conn, session, &base, fetch, cutoff, dates, visible),
            1.0,
        ));
    }
    let mut weights: HashMap<&str, f64> = HashMap::new();
    for probe in probes {
        let fts = sanitize_fts_query(probe);
        if fts.is_empty() {
            continue;
        }
        let df = count_matches(conn, session, &fts, cutoff, dates, visible) as f64;
        let weight = if corpus <= 0.0 || df <= 0.0 {
            1.0
        } else {
            1.0 / (1.0 + IDF_FALLOFF * df / corpus)
        };
        weights.insert(probe.as_str(), weight);
        lists.push((
            query_rows(conn, session, &fts, fetch, cutoff, dates, visible),
            weight,
        ));
    }
    let mut fused: Vec<(Row, f64)> = Vec::new();
    for (rows, weight) in &lists {
        for (rank, row) in rows.iter().take(fetch).enumerate() {
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
            .filter(|probe| contains_probe_verbatim(&row.content, std::slice::from_ref(probe)))
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
}
