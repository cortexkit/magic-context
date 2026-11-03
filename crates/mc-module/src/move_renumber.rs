//! Converting the message numbers the standalone plugin stored for a session
//! to the runner's numbering, as part of moving the session in.
//!
//! The standalone plugin and the runner number a transcript's messages
//! differently. On OpenCode 1 the plugin counts every message row except a
//! finished compaction summary (`summary: true` with `finish: "stop"`), so it
//! counts the message that opens a compaction. The runner counts the
//! compaction contract's entries, which leave out both rows of a completed
//! compaction pair. After a session's first compaction every number the
//! plugin stored is therefore off by one or more from the runner's. A moved
//! session keeps one numbering for its whole life, so the move rewrites every
//! number Magic Context stored for it, message by message, before anything
//! reads them.
//!
//! The runner's move tool sends every message row of the session's active
//! path in host order, each with the runner's entry number (none for a marker
//! row) and whether it is a finished summary. From that list this module
//! rebuilds the plugin's numbering and maps each stored number through the
//! message it named:
//! - a range (a summary, a search chunk, a cited fact block, a user-memory or
//!   primer source) maps to the entries of the messages it covers, from the
//!   first to the last; a range that covers only marker rows can't be mapped,
//!   and the move refuses (`ordinal_unmapped`) and changes nothing;
//! - a position in the session (a note's anchor, the search indexer's
//!   progress) maps to the last entry at or before it;
//! - a search-index row names its message id, and moves to that message's
//!   entry; a row for a marker row, or for a message no longer on the active
//!   path, is removed, since there is nothing there to expand.
//!
//! A summary also stores the ids of its first and last messages. If they
//! don't name the messages the transcript has at those numbers, the stored
//! numbering doesn't belong to this transcript, and the move refuses
//! (`ordinal_mismatch`).
//!
//! A session can also move across hosts: its OpenCode 1 store is converted to
//! OpenCode 2, and the runner numbers the converted rows. The conversion keeps
//! each message's id and order, drops some rows (a compaction pair becomes one
//! marker row; an unfinished opener and a delegated-task prompt with its answer
//! vanish), and adds a few with new ids (a `synthetic` row right after a user
//! message that also carried system-added text, a trailing `system` notice).
//! The list then holds the OpenCode 1 rows in their order, each with the entry
//! of the converted row of the same id (none when it has none), and the added
//! rows in place, marked `added`. The plugin never numbered an added row, so it
//! counts as part of the message before it: a range or position that reaches
//! that message reaches its added rows too, and a summary ending there doesn't
//! leave the added text raw after the cut.
//!
//! The rewrite and a record of it (`mode3_renumber:<harness>:<session>`,
//! carrying the numbering's checksum) commit in one transaction. A move
//! retried after a later step failed finds the record and doesn't shift the
//! numbers twice; a retry with a different transcript refuses
//! (`renumber_conflict`).
//!
//! Left as they are: records that are history rather than live coordinates
//! (memory change history and journal, device-sync operations already
//! queued, summarizer run logs and attempts), and the standalone plugin's own
//! runtime state (session metadata, replay and render caches, its runner
//! admission log). The move's fence retires the plugin on the session, and
//! nothing in mode 3 reads them.

use std::collections::{HashMap, HashSet};

use cortexkit_role_compaction::read::Cursor;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// One message row of the session's active path, in host order, as the
/// runner's move tool sends it.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct HostMessage {
    pub mid: String,
    /// The runner's entry number for the row, or none for a marker row.
    pub entry: Option<u64>,
    /// Whether the standalone plugin leaves the row out of its numbering:
    /// exactly `summary: true` with `finish: "stop"`, error or not. This is
    /// the plugin's rule, not the runner's marker rule (that one is `entry`
    /// being none): a summary that stopped for another reason counts for the
    /// plugin, and marking it here would shift every later number.
    #[serde(default)]
    pub finished_summary: bool,
    /// A row the host added when converting the store, which the standalone
    /// plugin never saw or numbered (see the module comment). It belongs to
    /// the message before it.
    #[serde(default)]
    pub added: bool,
}

/// One message the plugin numbered, with the entries it has on the runner.
#[derive(Debug)]
struct Numbered {
    mid: String,
    /// The entry of the row with this message's id.
    entry: Option<u64>,
    /// The first and last entries of the message and the added rows after it.
    first: Option<u64>,
    through: Option<u64>,
}

/// The plugin's numbering of a transcript next to the runner's.
#[derive(Debug)]
pub struct Numbering {
    /// For each plugin number (index + 1): the message and its entries.
    by_plugin: Vec<Numbered>,
    /// Whether any row was added by a store conversion.
    has_added: bool,
    /// Every message row on the active path: its entry, or none for a marker.
    by_mid: HashMap<String, Option<u64>>,
    checksum: String,
}

impl Numbering {
    /// The OpenCode 1 plugin's numbering of `messages`, which must end at the
    /// transcript's newest message `newest`.
    pub fn opencode(messages: &[HostMessage], newest: &Cursor) -> Result<Self, String> {
        let mut by_plugin: Vec<Numbered> = Vec::new();
        let mut by_mid = HashMap::new();
        let mut last_entry = 0;
        let mut has_added = false;
        for message in messages {
            if by_mid.insert(message.mid.clone(), message.entry).is_some() {
                return Err(format!(
                    "invalid_messages: message {} is listed twice",
                    message.mid
                ));
            }
            if let Some(entry) = message.entry {
                if entry <= last_entry {
                    return Err(format!(
                        "invalid_messages: entry numbers must rise in host order; {} has {entry} after {last_entry}",
                        message.mid
                    ));
                }
                last_entry = entry;
            }
            if message.added {
                if message.finished_summary {
                    return Err(format!(
                        "invalid_messages: added row {} can't be a finished summary",
                        message.mid
                    ));
                }
                has_added = true;
                // An added row before the first numbered message belongs to
                // nothing the plugin stored.
                if let (Some(owner), Some(entry)) = (by_plugin.last_mut(), message.entry) {
                    owner.first = owner.first.or(Some(entry));
                    owner.through = Some(entry);
                }
            } else if !message.finished_summary {
                by_plugin.push(Numbered {
                    mid: message.mid.clone(),
                    entry: message.entry,
                    first: message.entry,
                    through: message.entry,
                });
            }
        }
        match messages.last() {
            Some(last) if last.mid == newest.mid && last.entry == Some(newest.ordinal) => {}
            _ => {
                return Err(format!(
                    "invalid_messages: the list must end at the newest message {} (entry {})",
                    newest.mid, newest.ordinal
                ))
            }
        }
        let mut hasher = Sha256::new();
        for message in messages {
            hasher.update(
                serde_json::to_vec(&(
                    &message.mid,
                    message.entry,
                    message.finished_summary,
                    message.added,
                ))
                .expect("a message row serializes"),
            );
            hasher.update(b"\n");
        }
        Ok(Self {
            by_plugin,
            has_added,
            by_mid,
            checksum: format!("{:x}", hasher.finalize()),
        })
    }

    /// Whether every plugin number already is the runner's.
    fn is_identity(&self) -> bool {
        !self.has_added
            && self
                .by_plugin
                .iter()
                .enumerate()
                .all(|(index, numbered)| numbered.entry == Some(index as u64 + 1))
    }

    fn at(&self, ordinal: i64) -> Option<&Numbered> {
        usize::try_from(ordinal)
            .ok()
            .and_then(|ordinal| ordinal.checked_sub(1))
            .and_then(|index| self.by_plugin.get(index))
    }

    /// The message the plugin numbered `ordinal`.
    fn mid(&self, ordinal: i64) -> Option<&str> {
        self.at(ordinal).map(|numbered| numbered.mid.as_str())
    }

    /// The entries of the messages the plugin numbered `start..=end` and of
    /// the rows added after them, first to last; none when the range is
    /// outside the transcript or covers no entry.
    fn range(&self, start: i64, end: i64) -> Option<(i64, i64)> {
        if start < 1 || end < start || self.at(end).is_none() {
            return None;
        }
        let covered: Vec<&Numbered> = (start..=end).filter_map(|o| self.at(o)).collect();
        let first = covered.iter().find_map(|numbered| numbered.first)?;
        let last = covered.iter().rev().find_map(|numbered| numbered.through)?;
        Some((first as i64, last as i64))
    }

    /// The last entry at or before the plugin's position `ordinal`; 0 before
    /// the first entry. A position past the transcript's end maps to its last
    /// entry.
    fn position(&self, ordinal: i64) -> i64 {
        let Ok(ordinal) = usize::try_from(ordinal) else {
            return 0;
        };
        self.by_plugin[..ordinal.min(self.by_plugin.len())]
            .iter()
            .rev()
            .find_map(|numbered| numbered.through)
            .map_or(0, |entry| entry as i64)
    }

    /// The entry of message `mid`: `Some(None)` for a marker row, none for a
    /// message not on the active path.
    fn entry_of(&self, mid: &str) -> Option<Option<u64>> {
        self.by_mid.get(mid).copied()
    }
}

/// The key of the record a finished rewrite leaves.
pub fn record_key(harness: &str, session: &str) -> String {
    format!("mode3_renumber:{harness}:{session}")
}

/// Rewrite every number Magic Context stored for `session` to the runner's
/// numbering, in one transaction with its record. Does nothing when the
/// record of this same numbering is already there.
pub fn renumber(
    conn: &mut Connection,
    harness: &str,
    session: &str,
    numbering: &Numbering,
) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let key = record_key(harness, session);
    let done: Option<String> = tx
        .query_row(
            "SELECT value FROM schema_migrations_meta WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(done) = done {
        let same = serde_json::from_str::<Value>(&done)
            .ok()
            .and_then(|record| record["checksum"].as_str().map(str::to_owned))
            .is_some_and(|checksum| checksum == numbering.checksum);
        return if same {
            Ok(())
        } else {
            Err(format!(
                "renumber_conflict: {session}'s numbers were already converted from a different transcript"
            ))
        };
    }
    if !numbering.is_identity() {
        Rewrite {
            tx: &tx,
            harness,
            session,
            numbering,
        }
        .all()
        .map_err(|error| error.0)?;
    }
    tx.execute(
        "INSERT INTO schema_migrations_meta (key, value) VALUES (?1, ?2)",
        params![
            key,
            serde_json::json!({ "checksum": numbering.checksum }).to_string()
        ],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())
}

struct Failure(String);

impl From<rusqlite::Error> for Failure {
    fn from(error: rusqlite::Error) -> Self {
        Self(error.to_string())
    }
}

type Step = Result<(), Failure>;

struct Rewrite<'a> {
    tx: &'a rusqlite::Transaction<'a>,
    harness: &'a str,
    session: &'a str,
    numbering: &'a Numbering,
}

impl Rewrite<'_> {
    fn all(&self) -> Step {
        self.summaries()?;
        self.ranges(
            "compartment_chunk_embeddings",
            "start_ordinal",
            "end_ordinal",
            "session_id = ?1 AND harness = ?2",
        )?;
        self.ranges(
            "memory_fact_blocks",
            "start_ordinal",
            "end_ordinal",
            "source_session_id = ?1",
        )?;
        self.ranges(
            "user_memory_candidates",
            "source_compartment_start",
            "source_compartment_end",
            "session_id = ?1 AND source_compartment_start IS NOT NULL AND source_compartment_end IS NOT NULL",
        )?;
        self.ranges(
            "primer_candidates",
            "source_compartment_start",
            "source_compartment_end",
            "session_id = ?1 AND harness = ?2 AND source_compartment_start IS NOT NULL AND source_compartment_end IS NOT NULL",
        )?;
        self.provenance("user_memories", false)?;
        self.provenance("primers", true)?;
        self.compression_depth()?;
        self.positions()?;
        self.search_index()
    }

    fn unmapped(&self, what: &str, start: i64, end: i64) -> Failure {
        Failure(format!(
            "ordinal_unmapped: {what} of {} covers messages {start}..{end}, which have no entry in the runner's numbering",
            self.session
        ))
    }

    /// Summary ranges, after checking that each summary's stored message ids
    /// name the messages the transcript has at its numbers.
    fn summaries(&self) -> Step {
        let rows: Vec<(i64, i64, i64, i64, String, String)> = self
            .tx
            .prepare(
                "SELECT id, sequence, start_message, end_message, start_message_id, end_message_id
                 FROM compartments WHERE session_id = ?1 AND harness = ?2",
            )?
            .query_map(params![self.session, self.harness], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                ))
            })?
            .collect::<Result<_, _>>()?;
        for (id, sequence, start, end, start_id, end_id) in rows {
            for (ordinal, stored) in [(start, &start_id), (end, &end_id)] {
                let actual = self.numbering.mid(ordinal);
                if !stored.is_empty() && actual != Some(stored.as_str()) {
                    return Err(Failure(format!(
                        "ordinal_mismatch: summary {sequence} of {} stores message {stored} at {ordinal}, but the transcript has {} there",
                        self.session,
                        actual.unwrap_or("no message")
                    )));
                }
            }
            let (first, last) = self
                .numbering
                .range(start, end)
                .ok_or_else(|| self.unmapped(&format!("summary {sequence}"), start, end))?;
            self.tx.execute(
                "UPDATE compartments SET start_message = ?1, end_message = ?2 WHERE id = ?3",
                params![first, last, id],
            )?;
        }
        Ok(())
    }

    /// The `start`..`end` range columns of `table`'s rows matching `filter`
    /// (whose `?1` is the session and `?2`, if used, the harness).
    fn ranges(&self, table: &str, start: &str, end: &str, filter: &str) -> Step {
        let select = format!("SELECT id, {start}, {end} FROM {table} WHERE {filter}");
        let mut statement = self.tx.prepare(&select)?;
        let bound = if filter.contains("?2") {
            statement.query_map(params![self.session, self.harness], range_row)
        } else {
            statement.query_map(params![self.session], range_row)
        }?;
        let rows: Vec<(i64, i64, i64)> = bound.collect::<Result<_, _>>()?;
        let update = format!("UPDATE {table} SET {start} = ?1, {end} = ?2 WHERE id = ?3");
        for (id, from, to) in rows {
            let (first, last) = self
                .numbering
                .range(from, to)
                .ok_or_else(|| self.unmapped(&format!("{table} row {id}"), from, to))?;
            self.tx.execute(&update, params![first, last, id])?;
        }
        Ok(())
    }

    /// The source ranges inside `table`'s `source_candidate_provenance`
    /// lists that belong to this session (and harness, where recorded).
    fn provenance(&self, table: &str, has_harness: bool) -> Step {
        let rows: Vec<(i64, String)> = self
            .tx
            .prepare(&format!(
                "SELECT id, source_candidate_provenance FROM {table}
                 WHERE source_candidate_provenance LIKE '%' || ?1 || '%'"
            ))?
            .query_map(params![self.session], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        for (id, text) in rows {
            let Ok(mut list) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            let mut changed = false;
            for source in list.as_array_mut().into_iter().flatten() {
                let ours = source["session_id"].as_str() == Some(self.session)
                    && (!has_harness
                        || source
                            .get("harness")
                            .and_then(Value::as_str)
                            .is_none_or(|harness| harness == self.harness));
                let (Some(from), Some(to)) = (
                    source["source_compartment_start"].as_i64(),
                    source["source_compartment_end"].as_i64(),
                ) else {
                    continue;
                };
                if !ours {
                    continue;
                }
                let (first, last) = self
                    .numbering
                    .range(from, to)
                    .ok_or_else(|| self.unmapped(&format!("{table} row {id}"), from, to))?;
                source["source_compartment_start"] = first.into();
                source["source_compartment_end"] = last.into();
                changed = true;
            }
            if changed {
                self.tx.execute(
                    &format!("UPDATE {table} SET source_candidate_provenance = ?1 WHERE id = ?2"),
                    params![list.to_string(), id],
                )?;
            }
        }
        Ok(())
    }

    /// Per-message depth rows, keyed by number: each moves to its message's
    /// entry; a marker row's has nothing to describe and goes.
    fn compression_depth(&self) -> Step {
        let rows: Vec<(i64, i64)> = self
            .tx
            .prepare(
                "SELECT message_ordinal, depth FROM compression_depth
                 WHERE session_id = ?1 AND harness = ?2",
            )?
            .query_map(params![self.session, self.harness], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .collect::<Result<_, _>>()?;
        self.tx.execute(
            "DELETE FROM compression_depth WHERE session_id = ?1 AND harness = ?2",
            params![self.session, self.harness],
        )?;
        for (ordinal, depth) in rows {
            let Some(numbered) = self.numbering.at(ordinal) else {
                return Err(self.unmapped("a compression depth", ordinal, ordinal));
            };
            if let Some(entry) = numbered.entry {
                self.tx.execute(
                    "INSERT INTO compression_depth (session_id, message_ordinal, depth, harness)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![self.session, entry as i64, depth, self.harness],
                )?;
            }
        }
        Ok(())
    }

    /// Positions in the session: note anchors and the search indexer's
    /// progress.
    fn positions(&self) -> Step {
        let notes: Vec<(i64, i64)> = self
            .tx
            .prepare(
                "SELECT id, anchor_ordinal FROM notes
                 WHERE session_id = ?1 AND harness = ?2 AND anchor_ordinal IS NOT NULL",
            )?
            .query_map(params![self.session, self.harness], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .collect::<Result<_, _>>()?;
        for (id, anchor) in notes {
            self.tx.execute(
                "UPDATE notes SET anchor_ordinal = ?1 WHERE id = ?2",
                params![self.numbering.position(anchor), id],
            )?;
        }
        let progress: Option<(i64, i64)> = self
            .tx
            .query_row(
                "SELECT last_indexed_ordinal, dirty_floor_ordinal FROM message_history_index
                 WHERE session_id = ?1",
                params![self.session],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((last, dirty)) = progress {
            self.tx.execute(
                "UPDATE message_history_index SET last_indexed_ordinal = ?1, dirty_floor_ordinal = ?2
                 WHERE session_id = ?3",
                params![
                    self.numbering.position(last),
                    self.numbering.position(dirty),
                    self.session
                ],
            )?;
        }
        Ok(())
    }

    /// The raw-message search index. Its rows name their message, so each
    /// moves by message id; rows for marker rows or for messages no longer on
    /// the active path go.
    fn search_index(&self) -> Step {
        let sources: Vec<String> = self
            .tx
            .prepare(
                "SELECT message_id FROM message_history_source WHERE session_id = ?1 AND harness = ?2",
            )?
            .query_map(params![self.session, self.harness], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        for mid in sources {
            match self.numbering.entry_of(&mid).flatten() {
                Some(entry) => self.tx.execute(
                    "UPDATE message_history_source SET message_ordinal = ?1
                     WHERE session_id = ?2 AND message_id = ?3",
                    params![entry as i64, self.session, mid],
                )?,
                None => self.tx.execute(
                    "DELETE FROM message_history_source WHERE session_id = ?1 AND message_id = ?2",
                    params![self.session, mid],
                )?,
            };
        }
        let rows: Vec<(i64, String)> = self
            .tx
            .prepare("SELECT rowid, message_id FROM message_history_fts WHERE session_id = ?1")?
            .query_map(params![self.session], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        for (rowid, mid) in rows {
            match self.numbering.entry_of(&mid).flatten() {
                Some(entry) => self.tx.execute(
                    "UPDATE message_history_fts SET message_ordinal = ?1 WHERE rowid = ?2",
                    params![entry as i64, rowid],
                )?,
                None => self.tx.execute(
                    "DELETE FROM message_history_fts WHERE rowid = ?1",
                    params![rowid],
                )?,
            };
        }
        // The rowid map points each message number at its search row; it
        // follows the rows it points at.
        let mapped: Vec<(i64, Option<i64>, Option<i64>)> = self
            .tx
            .prepare(
                "SELECT m.fts_rowid, m.message_time_ms, f.message_ordinal
                 FROM message_fts_rowid_map m
                 LEFT JOIN message_history_fts f ON f.rowid = m.fts_rowid
                 WHERE m.session_id = ?1",
            )?
            .query_map(params![self.session], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<Result<_, _>>()?;
        self.tx.execute(
            "DELETE FROM message_fts_rowid_map WHERE session_id = ?1",
            params![self.session],
        )?;
        let mut kept = HashSet::new();
        for (rowid, time, ordinal) in mapped {
            if let Some(ordinal) = ordinal.filter(|ordinal| kept.insert(*ordinal)) {
                self.tx.execute(
                    "INSERT INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid, message_time_ms)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![self.session, ordinal, rowid, time],
                )?;
            }
        }
        // Messages the indexer skipped as too large, recorded by message id.
        let skips: Vec<(String, String)> = self
            .tx
            .prepare(
                "SELECT key, value FROM schema_migrations_meta WHERE key LIKE 'message_index_skip:%'",
            )?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        for (key, value) in skips {
            let Some(Ok(Value::Array(names))) = key
                .strip_prefix("message_index_skip:")
                .map(serde_json::from_str::<Value>)
            else {
                continue;
            };
            let (Some(owner), Some(mid)) = (
                names.first().and_then(Value::as_str),
                names.get(1).and_then(Value::as_str),
            ) else {
                continue;
            };
            if owner != self.session {
                continue;
            }
            let entry = self.numbering.entry_of(mid).flatten();
            match (entry, serde_json::from_str::<Value>(&value)) {
                (Some(entry), Ok(mut record)) if record.get("ordinal").is_some() => {
                    record["ordinal"] = (entry as i64).into();
                    self.tx.execute(
                        "UPDATE schema_migrations_meta SET value = ?1 WHERE key = ?2",
                        params![record.to_string(), key],
                    )?;
                }
                (Some(_), _) => {}
                (None, _) => {
                    self.tx.execute(
                        "DELETE FROM schema_migrations_meta WHERE key = ?1",
                        params![key],
                    )?;
                }
            }
        }
        Ok(())
    }
}

fn range_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(i64, i64, i64)> {
    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
}

#[cfg(test)]
mod tests;
