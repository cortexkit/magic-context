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
//!   and the move refuses (`summary_covers_no_runner_entry` for summaries,
//!   `ordinal_unmapped` for other ranges) and changes nothing;
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
//! Endpoints on rows the runner left out move inward to the first and last
//! covered entries, including their ids, so a later transcript check can
//! still find the summary's boundaries.
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
//! On Pi the plugin numbers the journal entries of the session's active
//! branch by its own rule (see [`Numbering::pi`]): it folds tool results into
//! the user message after them and skips the entries the runner adds to its
//! count (custom messages, branch summaries, tool results without a call id).
//! The list then holds every journal entry of the branch with its kind, and
//! each skipped or folded entry belongs to the message the plugin put it in.
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
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// One message row of the session's active path, in host order, as the
/// runner's move tool sends it.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct HostMessage {
    pub mid: String,
    /// The runner's entry number for the row, or none for a marker row.
    pub entry: Option<u64>,
    /// The source runner's ordinal. An explicit null means that runner did
    /// not number the row; omission is only valid for standalone-plugin moves.
    #[serde(
        default,
        deserialize_with = "source_entry",
        skip_serializing_if = "Option::is_none"
    )]
    pub source_entry: Option<Option<u64>>,
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
    /// On Pi, what the journal entry is. The Pi plugin's numbering depends on
    /// it (see [`Numbering::pi`]); OpenCode rows leave it out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pi: Option<PiRow>,
}

fn source_entry<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<u64>>, D::Error> {
    <Option<u64> as serde::Deserialize>::deserialize(deserializer).map(Some)
}

/// One message row of an OpenCode 1 session in the standalone plugin's
/// order (`time_created`, then id), read from a copy of the OpenCode 1 store
/// when the session moves to OpenCode 2.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenCode1Row {
    pub mid: String,
    /// `summary: true` with `finish: "stop"`: see
    /// [`HostMessage::finished_summary`].
    pub finished_summary: bool,
}

/// One row of the same session after OpenCode 2 converted the store, in
/// OpenCode 2's order, as the runner lists it.
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
pub struct OpenCode2Row {
    pub id: String,
    /// The runner's entry number; absent for a row that isn't an entry.
    #[serde(default)]
    pub number: Option<u64>,
    /// A compaction marker row (a converted compaction pair).
    #[serde(default)]
    pub compaction: bool,
}

/// The message list for a session moved from OpenCode 1 to OpenCode 2: the
/// OpenCode 1 rows in their order, each with the entry of the converted row
/// of the same id (none when it has none or became a marker row), and every
/// row the conversion added (an id OpenCode 1 doesn't have) right after the
/// row it follows in OpenCode 2, marked `added`.
///
/// Refuses when the two orders disagree on the rows they share, or when the
/// first converted row is an added one (it would belong to no message).
pub fn opencode1_to_2(
    rows: &[OpenCode1Row],
    converted: &[OpenCode2Row],
) -> Result<Vec<HostMessage>, String> {
    let position: HashMap<&str, usize> = rows
        .iter()
        .enumerate()
        .map(|(at, row)| (row.mid.as_str(), at))
        .collect();
    let entry_of = |row: &OpenCode2Row| row.number.filter(|_| !row.compaction);
    let mut entries: HashMap<&str, Option<u64>> = HashMap::new();
    let mut added: Vec<Vec<HostMessage>> = vec![Vec::new(); rows.len()];
    let mut last: Option<usize> = None;
    for row in converted {
        match position.get(row.id.as_str()) {
            Some(&at) => {
                if last.is_some_and(|last| at <= last) {
                    return Err(format!(
                        "order_differs: OpenCode 2 has {} after a row OpenCode 1 has after it",
                        row.id
                    ));
                }
                last = Some(at);
                entries.insert(row.id.as_str(), entry_of(row));
            }
            None => {
                let Some(at) = last else {
                    return Err(format!(
                        "added_row_first: {} has no OpenCode 1 message before it",
                        row.id
                    ));
                };
                added[at].push(HostMessage {
                    mid: row.id.clone(),
                    entry: entry_of(row),
                    source_entry: None,
                    finished_summary: false,
                    added: true,
                    pi: None,
                });
            }
        }
    }
    Ok(rows
        .iter()
        .zip(added)
        .flat_map(|(row, extra)| {
            std::iter::once(HostMessage {
                mid: row.mid.clone(),
                entry: entries.get(row.mid.as_str()).copied().flatten(),
                source_entry: None,
                finished_summary: row.finished_summary,
                added: false,
                pi: None,
            })
            .chain(extra)
        })
        .collect())
}

/// A Pi journal entry's kind, as the runner's move tool reads it from the
/// session file.
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct PiRow {
    /// The entry's `type`: `message`, `custom_message`, `branch_summary`,
    /// `compaction`, `model_change` and so on.
    #[serde(rename = "type")]
    pub kind: String,
    /// A `message` entry's `message.role`: `user`, `assistant`, `toolResult`,
    /// or another role such as `bashExecution`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// Whether a `toolResult` carries a non-empty `toolCallId`.
    #[serde(default)]
    pub has_tool_call_id: bool,
}

/// The id the Pi plugin gives the user message it makes up for a run of tool
/// results with no user message after them: this prefix and the first
/// result's entry id (`SYNTH_USER_ID_PREFIX` in the Pi plugin).
const PI_SYNTHETIC_USER_PREFIX: &str = "synth-user-";

/// One message the plugin numbered, with the entries it has on the runner.
#[derive(Debug)]
struct Numbered {
    /// Empty for a number the plugin kept for a message its branch walk no
    /// longer reached (a Pi session whose file lost entries; see
    /// [`Numbering::align_pi`]).
    mid: String,
    /// The entry of the row with this message's id.
    entry: Option<u64>,
    /// The first and last entries of the rows that make up this message: its
    /// own row, the rows added after it, and on Pi the tool results folded
    /// into it.
    first: Option<u64>,
    through: Option<u64>,
}

impl Numbered {
    fn new(mid: impl Into<String>, entry: Option<u64>) -> Self {
        Self {
            mid: mid.into(),
            entry,
            first: entry,
            through: entry,
        }
    }

    fn covers(&mut self, entry: Option<u64>) {
        let Some(entry) = entry else { return };
        self.first = Some(self.first.map_or(entry, |first| first.min(entry)));
        self.through = Some(self.through.map_or(entry, |through| through.max(entry)));
    }
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
    /// Only actual runner rows, not the virtual ids made by the Pi plugin.
    runner_mids: HashMap<u64, String>,
    checksum: String,
    alignment_warnings: Vec<String>,
    /// Runner ordinals need not equal the row's position in the move list.
    source_ordinals: Option<HashMap<i64, usize>>,
}

impl Numbering {
    /// Map a runner's ordinals through stable message ids. Added rows belong
    /// to the source row immediately before them, including its summary cut.
    pub fn runner(messages: &[HostMessage], newest: &Cursor) -> Result<Self, String> {
        let mut by_plugin: Vec<Numbered> = Vec::new();
        let mut source_ordinals = HashMap::new();
        let mut by_mid = HashMap::new();
        let mut last_entry = 0;
        let mut last_source = 0;
        let mut owner: Option<usize> = None;
        for message in messages {
            let before = last_entry;
            check_row(&mut by_mid, &mut last_entry, message)?;
            if message.entry.is_some() && last_entry != before + 1 {
                return Err(format!(
                    "invalid_messages: missing target entry {}",
                    before + 1
                ));
            }
            let source = message.source_entry.ok_or_else(|| {
                format!("invalid_messages: {} is missing source_entry", message.mid)
            })?;
            if message.added {
                if source.is_some() || message.entry.is_none() || owner.is_none() {
                    return Err(format!("invalid_messages: added row {} must follow a source entry and have only a target entry", message.mid));
                }
                by_plugin[owner.unwrap()].covers(message.entry);
            } else if let Some(source) = source {
                if source <= last_source || source > i64::MAX as u64 {
                    return Err(
                        "invalid_messages: source entries must be positive and rise in host order"
                            .into(),
                    );
                }
                last_source = source;
                source_ordinals.insert(source as i64, by_plugin.len());
                owner = Some(by_plugin.len());
                by_plugin.push(Numbered::new(&message.mid, message.entry));
            } else {
                owner = None;
            }
        }
        match messages
            .iter()
            .rev()
            .find(|message| message.entry.is_some())
        {
            Some(last) if last.mid == newest.mid && last.entry == Some(newest.ordinal) => {}
            _ => return Err(not_at_newest(newest)),
        }
        Ok(Self {
            by_plugin,
            has_added: messages.iter().any(|message| message.added),
            by_mid,
            runner_mids: runner_mids(messages),
            checksum: format!(
                "runner:{:x}",
                Sha256::digest(serde_json::to_vec(messages).expect("message rows serialize"))
            ),
            alignment_warnings: Vec::new(),
            source_ordinals: Some(source_ordinals),
        })
    }

    /// The OpenCode 1 plugin's numbering of `messages`, which must end at the
    /// transcript's newest message `newest`.
    pub fn opencode(messages: &[HostMessage], newest: &Cursor) -> Result<Self, String> {
        let mut by_plugin: Vec<Numbered> = Vec::new();
        let mut by_mid = HashMap::new();
        let mut last_entry = 0;
        let mut has_added = false;
        for message in messages {
            check_row(&mut by_mid, &mut last_entry, message)?;
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
                if let Some(owner) = by_plugin.last_mut() {
                    owner.covers(message.entry);
                }
            } else if message.finished_summary {
                // The plugin gave this row no number. A runner that keeps it
                // as an entry (Broca's import does; OpenCode 2 makes it a
                // marker with no entry) still has it inside the summarized
                // history, so it belongs to the message before it, as an
                // added row does. Left unowned, it would sit between two
                // moved summaries with neither covering it.
                if let Some(owner) = by_plugin.last_mut() {
                    owner.covers(message.entry);
                }
            } else {
                by_plugin.push(Numbered::new(&message.mid, message.entry));
            }
        }
        // Rows after the newest entry are ones the runner left out: OpenCode 2's
        // conversion drops an assistant step that ended with no content, and a
        // session can end in such steps. The plugin numbered them, and its
        // summaries may end on one; `position` maps them to the last entry.
        let last_entry = messages
            .iter()
            .rev()
            .find(|message| message.entry.is_some());
        match last_entry {
            Some(last) if last.mid == newest.mid && last.entry == Some(newest.ordinal) => {}
            _ => return Err(not_at_newest(newest)),
        }
        Ok(Self {
            by_plugin,
            has_added,
            by_mid,
            runner_mids: runner_mids(messages),
            checksum: checksum(messages),
            alignment_warnings: Vec::new(),
            source_ordinals: None,
        })
    }

    /// The Pi plugin's numbering of `messages`: every journal entry on the
    /// session's active branch, root to leaf. The plugin numbers only
    /// `message` entries, from 1, as it walks the branch (`read-session-pi.ts`):
    /// - a `user` or `assistant` message takes the next number, and so does a
    ///   message of any other role (such as `bashExecution`);
    /// - a `toolResult` with a call id takes none of its own: it folds into the
    ///   next `user` message, or, when an `assistant` message or the branch's
    ///   end comes first, into a user message the plugin makes up for the run
    ///   (`synth-user-` and the run's first result id), numbered just before
    ///   that assistant;
    /// - a `toolResult` without a call id is skipped.
    ///
    /// The runner also counts `custom_message` and `branch_summary` entries
    /// and each tool result on its own. A row the plugin skipped belongs to
    /// the message before it, as an added row does on OpenCode, and a folded
    /// result belongs to the message it folds into, so a stored range still
    /// covers exactly what the plugin summarized.
    ///
    /// The list must end, ignoring rows without an entry, at the transcript's
    /// newest message `newest`.
    pub fn pi(messages: &[HostMessage], newest: &Cursor) -> Result<Self, String> {
        let mut by_plugin: Vec<Numbered> = Vec::new();
        let mut by_mid = HashMap::new();
        let mut last_entry = 0;
        // A run of tool results waiting for the message it folds into.
        let mut results: Option<Numbered> = None;
        for message in messages {
            check_row(&mut by_mid, &mut last_entry, message)?;
            let Some(row) = &message.pi else {
                return Err(format!(
                    "invalid_messages: Pi row {} doesn't say what journal entry it is",
                    message.mid
                ));
            };
            if message.added || message.finished_summary {
                return Err(format!(
                    "invalid_messages: Pi row {} can't be an added row or a finished summary",
                    message.mid
                ));
            }
            let skipped = |by_plugin: &mut Vec<Numbered>| {
                if let Some(owner) = by_plugin.last_mut() {
                    owner.covers(message.entry);
                }
            };
            if row.kind != "message" {
                skipped(&mut by_plugin);
                continue;
            }
            match row.role.as_deref() {
                Some("toolResult") if row.has_tool_call_id => results
                    .get_or_insert_with(|| {
                        Numbered::new(
                            format!("{PI_SYNTHETIC_USER_PREFIX}{}", message.mid),
                            message.entry,
                        )
                    })
                    .covers(message.entry),
                Some("toolResult") => skipped(&mut by_plugin),
                Some("user") => {
                    let mut user = Numbered::new(&message.mid, message.entry);
                    if let Some(run) = results.take() {
                        user.covers(run.first);
                        user.covers(run.through);
                    }
                    by_plugin.push(user);
                }
                Some("assistant") => {
                    by_plugin.extend(results.take());
                    by_plugin.push(Numbered::new(&message.mid, message.entry));
                }
                // Any other role keeps its number; a pending run of results
                // still folds into the next user or assistant turn.
                _ => by_plugin.push(Numbered::new(&message.mid, message.entry)),
            }
        }
        by_plugin.extend(results.take());
        for numbered in &by_plugin {
            if numbered.mid.starts_with(PI_SYNTHETIC_USER_PREFIX) {
                by_mid.insert(numbered.mid.clone(), numbered.entry);
            }
        }
        match messages
            .iter()
            .rev()
            .find(|message| message.entry.is_some())
        {
            Some(last) if last.mid == newest.mid && last.entry == Some(newest.ordinal) => {}
            _ => return Err(not_at_newest(newest)),
        }
        Ok(Self {
            by_plugin,
            has_added: false,
            by_mid,
            runner_mids: runner_mids(messages),
            checksum: checksum(messages),
            alignment_warnings: Vec::new(),
            source_ordinals: None,
        })
    }

    /// Line the Pi numbering up with the numbers stored for `session`. A Pi
    /// session file can lose entries at the front or in the middle. Summary
    /// ids anchor the surviving messages, and each increase in their stored
    /// number minus branch position reserves slots for unreachable messages.
    /// Only missing-message source rows inside a summary can locate an
    /// internal loss exactly; other source ordinals may be stale. Without
    /// that evidence, the slots go just before the summary's end, with a
    /// warning. Unplaceable or decreasing anchors refuse (`ordinal_unanchored`).
    pub fn align_pi(
        mut self,
        conn: &Connection,
        harness: &str,
        session: &str,
    ) -> Result<Self, String> {
        // A failed later move step may leave already-renumbered summaries.
        // They are runner coordinates, not anchors for the plugin numbering.
        let done: Option<String> = conn
            .query_row(
                "SELECT value FROM schema_migrations_meta WHERE key = ?1",
                params![record_key(harness, session)],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(done) = done.filter(|text| {
            serde_json::from_str::<Value>(text).is_ok_and(|record| record["state"] != "staging")
        }) {
            let record: Value = serde_json::from_str(&done).unwrap_or(Value::Null);
            if record["checksum"].as_str() != Some(self.checksum.as_str()) {
                return Err(format!(
                    "renumber_conflict: {session}'s numbers were already converted from a different transcript"
                ));
            }
            self.alignment_warnings =
                serde_json::from_value(record["alignment_warnings"].clone()).unwrap_or_default();
            return Ok(self);
        }
        let rows: Vec<(i64, i64, i64, String, String)> = conn
            .prepare(
                "SELECT sequence, start_message, end_message, start_message_id, end_message_id
                 FROM compartments WHERE session_id = ?1 AND harness = ?2
                 ORDER BY sequence",
            )
            .and_then(|mut statement| {
                statement
                    .query_map(params![session, harness], |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                            row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                        ))
                    })?
                    .collect()
            })
            .map_err(|error| format!("ordinal_unanchored: summaries of {session}: {error}"))?;
        let places: HashMap<&str, i64> = self
            .by_plugin
            .iter()
            .enumerate()
            .map(|(index, numbered)| (numbered.mid.as_str(), index as i64 + 1))
            .collect();
        let mut previous_end = 0;
        let mut anchors = Vec::new();
        let mut missing_endpoints = Vec::new();
        for (sequence, start, end, start_id, end_id) in &rows {
            if *start <= previous_end || end < start {
                return Err(format!(
                    "ordinal_unanchored: summary {sequence} of {session}: stored ranges must rise without overlap"
                ));
            }
            for (stored, mid) in [(*start, start_id), (*end, end_id)] {
                if let Some(&branch) = places.get(mid.as_str()) {
                    anchors.push((*sequence, stored, branch));
                } else {
                    missing_endpoints.push((*sequence, stored, mid));
                }
            }
            previous_end = *end;
        }
        if !rows.is_empty() && anchors.is_empty() {
            return Err(format!(
                "ordinal_unanchored: summaries of {session} have no message ids on the branch"
            ));
        }
        let mut slots = Vec::new();
        let mut previous: Option<(i64, i64, i64)> = None;
        let mut offset = 0;
        for (sequence, stored, branch) in anchors {
            let invalid = |reason: &str| {
                format!("ordinal_unanchored: summary {sequence} of {session}: {reason}")
            };
            let next_offset = stored
                .checked_sub(branch)
                .ok_or_else(|| invalid("offset is not a whole nonnegative number of slots"))?;
            if next_offset < offset {
                return Err(invalid(&format!(
                    "offset decreases from {offset} to {next_offset} at stored number {stored}"
                )));
            }
            let step = next_offset - offset;
            if let Some((_, last_stored, last_branch)) = previous {
                if (stored > last_stored && branch <= last_branch)
                    || (stored == last_stored && branch != last_branch)
                {
                    return Err(invalid("message ids do not rise in branch order"));
                }
            }
            if step > 0 {
                let Some((last_sequence, last_stored, _)) = previous else {
                    // Before any surviving anchor, preserve the plugin's
                    // unreachable prefix, including missing summary endpoints.
                    slots.extend(1..=step);
                    offset = next_offset;
                    previous = Some((sequence, stored, branch));
                    continue;
                };
                let has_missing_endpoint = missing_endpoints
                    .iter()
                    .any(|(_, ordinal, _)| *ordinal > last_stored && *ordinal < stored);
                if last_sequence != sequence && !has_missing_endpoint {
                    // No summary covers this step: reserve it in the gap,
                    // immediately before the next summary's first message.
                    slots.extend(stored - step..stored);
                    offset = next_offset;
                    previous = Some((sequence, stored, branch));
                    continue;
                }
                let mut missing: Vec<i64> = conn
                    .prepare(
                        "SELECT message_ordinal, message_id FROM message_history_source
                         WHERE session_id = ?1 AND harness = ?2
                           AND message_ordinal > ?3 AND message_ordinal < ?4
                         ORDER BY message_ordinal",
                    )
                    .and_then(|mut statement| {
                        statement
                            .query_map(params![session, harness, last_stored, stored], |row| {
                                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                            })?
                            .filter_map(|row| match row {
                                // A row with no message id (the plugin writes
                                // one for a system part) names no message, so
                                // it can't be the one the branch lost.
                                Ok((ordinal, mid))
                                    if !mid.is_empty()
                                        && !self.by_mid.contains_key(&mid)
                                        && rows.iter().any(|(_, start, end, _, _)| {
                                            *start <= ordinal && ordinal <= *end
                                        }) =>
                                {
                                    Some(Ok(ordinal))
                                }
                                Ok(_) => None,
                                Err(error) => Some(Err(error)),
                            })
                            .collect()
                    })
                    .map_err(|error| invalid(&error.to_string()))?;
                if missing.len() as i64 != step || missing.windows(2).any(|pair| pair[0] == pair[1])
                {
                    if has_missing_endpoint {
                        return Err(invalid(
                            "a missing summary endpoint has no exact unreachable slot",
                        ));
                    }
                    missing = (stored - step..stored).collect();
                    self.alignment_warnings.push(format!(
                        "pi_alignment_fallback: summary {sequence} of {session}: placed {step} unreachable slots just before its end at {stored}; missing-message ordinals could not be determined"
                    ));
                }
                slots.extend(missing);
            }
            offset = next_offset;
            previous = Some((sequence, stored, branch));
        }
        let mut aligned = Vec::new();
        aligned
            .try_reserve(self.by_plugin.len().saturating_add(slots.len()))
            .map_err(|error| format!("ordinal_unanchored: {session}: {error}"))?;
        let mut slots = slots.into_iter().peekable();
        for numbered in self.by_plugin {
            while slots.peek() == Some(&(aligned.len() as i64 + 1)) {
                aligned.push(Numbered::new("", None));
                slots.next();
            }
            aligned.push(numbered);
        }
        if slots.next().is_some() {
            return Err(format!(
                "ordinal_unanchored: {session}: unreachable slots fall outside the branch numbering"
            ));
        }
        self.by_plugin = aligned;
        for (sequence, stored, mid) in missing_endpoints {
            if !self.unreachable(stored) {
                return Err(format!(
                    "ordinal_unanchored: summary {sequence} of {session}: message {mid} is not on the branch and has no unreachable slot at {stored}"
                ));
            }
        }
        Ok(self)
    }

    /// Summaries whose internal missing-message positions had to be estimated.
    pub fn alignment_warnings(&self) -> &[String] {
        &self.alignment_warnings
    }

    pub(crate) fn checksum(&self) -> &str {
        &self.checksum
    }

    pub(crate) fn cut(&self, ordinal: i64) -> Option<(u64, &str)> {
        let entry = self.position(ordinal) as u64;
        self.by_mid
            .iter()
            .find_map(|(mid, &number)| (number == Some(entry)).then_some((entry, mid.as_str())))
    }

    /// Whether every plugin number already is the runner's.
    fn is_identity(&self) -> bool {
        self.source_ordinals.is_none()
            && !self.has_added
            && self.by_plugin.iter().enumerate().all(|(index, numbered)| {
                let own = Some(index as u64 + 1);
                numbered.entry == own && numbered.first == own && numbered.through == own
            })
    }

    fn at(&self, ordinal: i64) -> Option<&Numbered> {
        if let Some(ordinals) = &self.source_ordinals {
            return ordinals
                .get(&ordinal)
                .and_then(|&index| self.by_plugin.get(index));
        }
        usize::try_from(ordinal)
            .ok()
            .and_then(|ordinal| ordinal.checked_sub(1))
            .and_then(|index| self.by_plugin.get(index))
    }

    /// The message the plugin numbered `ordinal`; none past the transcript or
    /// for a number whose message the branch no longer reaches.
    fn mid(&self, ordinal: i64) -> Option<&str> {
        self.at(ordinal)
            .map(|numbered| numbered.mid.as_str())
            .filter(|mid| !mid.is_empty())
    }

    /// Whether the plugin kept `ordinal` for a message its branch walk no
    /// longer reaches.
    fn unreachable(&self, ordinal: i64) -> bool {
        self.at(ordinal)
            .is_some_and(|numbered| numbered.mid.is_empty())
    }

    /// The entries of the messages the plugin numbered `start..=end` and of
    /// the rows that belong to them, lowest to highest; none when the range
    /// is outside the transcript or covers no entry.
    fn range(&self, start: i64, end: i64) -> Option<(i64, i64)> {
        if start < 1 || end < start || self.at(end).is_none() {
            return None;
        }
        if self.source_ordinals.is_some() && end - start >= self.by_plugin.len() as i64 {
            return None;
        }
        let covered: Vec<&Numbered> = (start..=end).filter_map(|o| self.at(o)).collect();
        if self.source_ordinals.is_some() && covered.len() as i64 != end - start + 1 {
            return None;
        }
        let first = covered.iter().filter_map(|numbered| numbered.first).min()?;
        let last = covered
            .iter()
            .filter_map(|numbered| numbered.through)
            .max()?;
        Some((first as i64, last as i64))
    }

    /// The last entry at or before the plugin's position `ordinal`; 0 before
    /// the first entry. A position past the transcript's end maps to its last
    /// entry.
    fn position(&self, ordinal: i64) -> i64 {
        if let Some(ordinals) = &self.source_ordinals {
            return ordinals
                .iter()
                .filter(|(source, _)| **source <= ordinal)
                .filter_map(|(_, &index)| self.by_plugin[index].through)
                .max()
                .map_or(0, |entry| entry as i64);
        }
        let Ok(ordinal) = usize::try_from(ordinal) else {
            return 0;
        };
        self.by_plugin[..ordinal.min(self.by_plugin.len())]
            .iter()
            .filter_map(|numbered| numbered.through)
            .max()
            .map_or(0, |entry| entry as i64)
    }

    /// The entry of message `mid`: `Some(None)` for a marker row, none for a
    /// message not on the active path.
    fn entry_of(&self, mid: &str) -> Option<Option<u64>> {
        self.by_mid.get(mid).copied()
    }

    /// Keep host ids for represented messages (including Pi's virtual user
    /// messages), but replace an entry-less endpoint with a covered runner id.
    fn endpoint<'a>(&'a self, ordinal: i64, entry: i64, stored: &'a str) -> Option<&'a str> {
        if self.at(ordinal)?.entry.is_some() {
            return Some(stored);
        }
        self.runner_mids.get(&(entry as u64)).map(String::as_str)
    }
}

fn runner_mids(messages: &[HostMessage]) -> HashMap<u64, String> {
    messages
        .iter()
        .filter_map(|row| row.entry.map(|entry| (entry, row.mid.clone())))
        .collect()
}

/// Record `message` and check it is listed once, with an entry above every
/// entry before it.
fn check_row(
    by_mid: &mut HashMap<String, Option<u64>>,
    last_entry: &mut u64,
    message: &HostMessage,
) -> Result<(), String> {
    if by_mid.insert(message.mid.clone(), message.entry).is_some() {
        return Err(format!(
            "invalid_messages: message {} is listed twice",
            message.mid
        ));
    }
    if let Some(entry) = message.entry {
        if entry <= *last_entry {
            return Err(format!(
                "invalid_messages: entry numbers must rise in host order; {} has {entry} after {last_entry}",
                message.mid
            ));
        }
        *last_entry = entry;
    }
    Ok(())
}

fn not_at_newest(newest: &Cursor) -> String {
    format!(
        "invalid_messages: the list must end at the newest message {} (entry {})",
        newest.mid, newest.ordinal
    )
}

/// The list's checksum, kept in the rewrite's record so a retried move can
/// tell the same transcript from a different one. A Pi row adds its kind; an
/// OpenCode row hashes as it always has.
fn checksum(messages: &[HostMessage]) -> String {
    let mut hasher = Sha256::new();
    for message in messages {
        let row = (
            &message.mid,
            message.entry,
            message.finished_summary,
            message.added,
        );
        let bytes = match &message.pi {
            None => serde_json::to_vec(&row),
            Some(pi) => serde_json::to_vec(&(row, pi)),
        };
        hasher.update(bytes.expect("a message row serializes"));
        hasher.update(b"\n");
    }
    format!("{:x}", hasher.finalize())
}

/// The key of the record a finished rewrite leaves.
/// Above any ordinal a transcript reaches: where a row's range waits while
/// the rewrite moves the ranges of its table (see `Rewrite::ranges`).
const PARKED_ORDINAL: i64 = 1 << 40;

pub fn record_key(harness: &str, session: &str) -> String {
    format!("mode3_renumber:{harness}:{session}")
}

/// Check the endpoint ids a saved plan will leave behind without converting
/// already-converted ordinals again. Pending plans carry their target ids;
/// completed plans are checked against the rows now in the database.
pub(crate) fn check_plan_endpoints(
    conn: &Connection,
    record: &Value,
    numbering: &Numbering,
    harness: &str,
    session: &str,
    destination: Option<(&str, &str)>,
) -> Result<(), String> {
    let pending = matches!(record["state"].as_str(), Some("staging" | "applying"));
    let endpoints: Vec<(i64, String, String)> = if let Some(targets) =
        record.get("summary_endpoints").filter(|_| pending)
    {
        serde_json::from_value(targets.clone())
            .map_err(|e| format!("move_progress_invalid: summary endpoints: {e}"))?
    } else {
        let (target_harness, target_session) = destination.unwrap_or((harness, session));
        conn.prepare("SELECT sequence, COALESCE(start_message_id, ''), COALESCE(end_message_id, '') FROM compartments WHERE (session_id=?1 AND harness=?2) OR (session_id=?3 AND harness=?4)")
            .and_then(|mut stmt| stmt.query_map(params![session, harness, target_session, target_harness], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?.collect())
            .map_err(|e| e.to_string())?
    };
    for (sequence, start, end) in endpoints {
        for mid in [start, end] {
            if numbering.entry_of(&mid).flatten().is_none() {
                return Err(format!("renumber_plan_has_left_out_endpoint: summary {sequence} of {session} names {mid}, which has no runner entry; the saved plan cannot be resumed"));
            }
        }
    }
    Ok(())
}

/// Rewrite stored numbers using a durable plan of absolute targets. All
/// validation precedes staging; each small write batch commits with its cursor.
/// The checksum rejects a different transcript even during an interrupted move.
pub fn renumber(
    conn: &mut Connection,
    harness: &str,
    session: &str,
    numbering: &Numbering,
) -> Result<(), String> {
    renumber_for_move(conn, harness, session, numbering, None)
}

pub(crate) fn renumber_for_move(
    conn: &mut Connection,
    harness: &str,
    session: &str,
    numbering: &Numbering,
    destination: Option<(&str, &str)>,
) -> Result<(), String> {
    let key = record_key(harness, session);
    if let Some(done) = crate::move_batches::record(conn, &key)? {
        if done["checksum"].as_str() != Some(numbering.checksum.as_str()) {
            return Err(format!(
                "renumber_conflict: {session}'s numbers were already converted from a different transcript"
            ));
        }
        check_plan_endpoints(conn, &done, numbering, harness, session, destination)?;
        if crate::move_batches::resume(conn, &key)? {
            return Ok(());
        }
    }
    let plan = crate::move_batches::Plan::default();
    let record = plan_renumber(conn, harness, session, numbering, &plan, None)?;
    plan.stage(conn, &key, record)
}

pub(crate) fn plan_renumber(
    conn: &Connection,
    harness: &str,
    session: &str,
    numbering: &Numbering,
    plan: &crate::move_batches::Plan,
    destination: Option<(&str, &str)>,
) -> Result<Value, String> {
    let stats = std::cell::RefCell::new(serde_json::json!({"summary_endpoints": []}));
    if !numbering.is_identity() {
        Rewrite {
            conn,
            plan,
            stats: &stats,
            harness,
            session,
            numbering,
            destination,
        }
        .all()
        .map_err(|error| error.0)?;
    }
    let mut record = stats.into_inner();
    record["checksum"] = numbering.checksum.clone().into();
    record["alignment_warnings"] = serde_json::json!(numbering.alignment_warnings);
    Ok(record)
}

struct Failure(String);

impl From<rusqlite::Error> for Failure {
    fn from(error: rusqlite::Error) -> Self {
        Self(error.to_string())
    }
}

type Step = Result<(), Failure>;

struct Rewrite<'a> {
    conn: &'a Connection,
    plan: &'a crate::move_batches::Plan,
    stats: &'a std::cell::RefCell<Value>,
    harness: &'a str,
    session: &'a str,
    numbering: &'a Numbering,
    destination: Option<(&'a str, &'a str)>,
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
        self.plan.phase("renumber/compartments");
        let rows: Vec<(i64, i64, i64, i64, String, String)> = self
            .conn
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
            if self.numbering.source_ordinals.is_some()
                && (self.numbering.at(start).is_none() || self.numbering.at(end).is_none())
            {
                return Err(self.unmapped(&format!("summary {sequence}"), start, end));
            }
            for (ordinal, stored) in [(start, &start_id), (end, &end_id)] {
                let actual = self.numbering.mid(ordinal);
                // A number kept for a message the Pi branch no longer reaches
                // has nothing to compare; its message is gone from the file.
                if self.numbering.unreachable(ordinal) {
                    continue;
                }
                if !stored.is_empty() && actual != Some(stored.as_str()) {
                    return Err(Failure(format!(
                        "ordinal_mismatch: summary {sequence} of {} stores message {stored} at {ordinal}, but the transcript has {} there",
                        self.session,
                        actual.unwrap_or("no message")
                    )));
                }
            }
            let (first, last) = self.numbering.range(start, end).ok_or_else(|| {
                if start > 0
                    && end >= start
                    && end - start < self.numbering.by_plugin.len() as i64
                    && (start..=end).all(|o| self.numbering.at(o).is_some())
                {
                    Failure(format!(
                        "summary_covers_no_runner_entry: summary {sequence} of {} covers only rows the runner left out ({start}..{end})",
                        self.session
                    ))
                } else {
                    self.unmapped(&format!("summary {sequence}"), start, end)
                }
            })?;
            let first_id = self.numbering.endpoint(start, first, &start_id);
            let last_id = self.numbering.endpoint(end, last, &end_id);
            let (Some(first_id), Some(last_id)) = (first_id, last_id) else {
                return Err(self.unmapped(&format!("summary {sequence} endpoints"), start, end));
            };
            self.stats.borrow_mut()["summary_endpoints"]
                .as_array_mut()
                .expect("summary endpoints are an array")
                .push(serde_json::json!([sequence, first_id, last_id]));
            self.plan.execute(
                "UPDATE compartments SET start_message = ?1, end_message = ?2, start_message_id = ?3, end_message_id = ?4 WHERE id = ?5",
                params![first, last, first_id, last_id, id],
            )?;
        }
        Ok(())
    }

    /// The `start`..`end` range columns of `table`'s rows matching `filter`
    /// (whose `?1` is the session and `?2`, if used, the harness).
    fn ranges(&self, table: &str, start: &str, end: &str, filter: &str) -> Step {
        self.plan.phase(&format!("renumber/{table}"));
        let select = format!("SELECT id, {start}, {end} FROM {table} WHERE {filter}");
        let mut statement = self.conn.prepare(&select)?;
        let bound = if filter.contains("?2") {
            statement.query_map(params![self.session, self.harness], range_row)
        } else {
            statement.query_map(params![self.session], range_row)
        }?;
        let rows: Vec<(i64, i64, i64)> = bound.collect::<Result<_, _>>()?;
        let mut moves = Vec::new();
        for (id, from, to) in rows {
            let (first, last) = self
                .numbering
                .range(from, to)
                .ok_or_else(|| self.unmapped(&format!("{table} row {id}"), from, to))?;
            if (first, last) != (from, to) {
                moves.push((id, first, last));
            }
        }
        // A table can hold its ranges unique (fact blocks per publication).
        // The final ranges are unique, but writing them one row at a time can
        // land a row on a range another row hasn't left yet, so every moving
        // row first parks on a range no ordinal reaches.
        let update = format!("UPDATE {table} SET {start} = ?1, {end} = ?2 WHERE id = ?3");
        self.plan.phase(&format!("renumber/{table}/park"));
        for (id, _, _) in &moves {
            let parked = PARKED_ORDINAL + id;
            self.plan.execute(&update, params![parked, parked, id])?;
        }
        self.plan.phase(&format!("renumber/{table}/place"));
        for (id, first, last) in moves {
            self.plan.execute(&update, params![first, last, id])?;
        }
        Ok(())
    }

    /// The source ranges inside `table`'s `source_candidate_provenance`
    /// lists that belong to this session (and harness, where recorded).
    fn provenance(&self, table: &str, has_harness: bool) -> Step {
        self.plan.phase(&format!("renumber/{table}"));
        let rows: Vec<(i64, String)> = self
            .conn
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
                if !ours {
                    continue;
                }
                if let (Some(from), Some(to)) = (
                    source["source_compartment_start"].as_i64(),
                    source["source_compartment_end"].as_i64(),
                ) {
                    let (first, last) = self
                        .numbering
                        .range(from, to)
                        .ok_or_else(|| self.unmapped(&format!("{table} row {id}"), from, to))?;
                    source["source_compartment_start"] = first.into();
                    source["source_compartment_end"] = last.into();
                    changed = true;
                }
                if let Some((harness, session)) = self.destination {
                    source["session_id"] = session.into();
                    if has_harness || source.get("harness").is_some() {
                        source["harness"] = harness.into();
                    }
                    changed = true;
                }
            }
            if changed {
                self.plan.execute(
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
        self.plan.phase("renumber/compression_depth/delete");
        let rows: Vec<(i64, i64, i64)> = self
            .conn
            .prepare(
                "SELECT rowid, message_ordinal, depth FROM compression_depth
                 WHERE session_id = ?1 AND harness = ?2",
            )?
            .query_map(params![self.session, self.harness], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<Result<_, _>>()?;
        for (id, _, _) in &rows {
            self.plan.execute(
                "DELETE FROM compression_depth WHERE rowid = ?1",
                params![id],
            )?;
        }
        self.plan.phase("renumber/compression_depth/insert");
        for (_, ordinal, depth) in rows {
            let Some(numbered) = self.numbering.at(ordinal) else {
                return Err(self.unmapped("a compression depth", ordinal, ordinal));
            };
            if let Some(entry) = numbered.entry {
                let (harness, session) = self.destination.unwrap_or((self.harness, self.session));
                self.plan.execute(
                    "INSERT INTO compression_depth (session_id, message_ordinal, depth, harness)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![session, entry as i64, depth, harness],
                )?;
            }
        }
        Ok(())
    }

    /// Positions in the session: note anchors and the search indexer's
    /// progress.
    fn positions(&self) -> Step {
        self.plan.phase("renumber/notes");
        let notes: Vec<(i64, i64)> = self
            .conn
            .prepare(
                "SELECT id, anchor_ordinal FROM notes
                 WHERE session_id = ?1 AND harness = ?2 AND anchor_ordinal IS NOT NULL",
            )?
            .query_map(params![self.session, self.harness], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .collect::<Result<_, _>>()?;
        for (id, anchor) in notes {
            self.check_position("note anchor", anchor)?;
            self.plan.execute(
                "UPDATE notes SET anchor_ordinal = ?1 WHERE id = ?2",
                params![self.numbering.position(anchor), id],
            )?;
        }
        let progress: Option<(i64, i64)> = self
            .conn
            .query_row(
                "SELECT last_indexed_ordinal, dirty_floor_ordinal FROM message_history_index
                 WHERE session_id = ?1",
                params![self.session],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((last, dirty)) = progress {
            self.check_position("search progress", last)?;
            self.check_position("search dirty floor", dirty)?;
            self.plan.phase("renumber/message_history_index");
            self.plan.execute(
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

    fn check_position(&self, what: &str, ordinal: i64) -> Step {
        if self.numbering.source_ordinals.is_some()
            && ordinal != 0
            && self.numbering.at(ordinal).is_none()
        {
            return Err(self.unmapped(what, ordinal, ordinal));
        }
        Ok(())
    }

    /// The raw-message search index. Its rows name their message, so each
    /// moves by message id; rows for marker rows or for messages no longer on
    /// the active path go. Ids remain authoritative even when a source row's
    /// ordinal is stale or a missing Pi message's slot was only estimated.
    fn search_index(&self) -> Step {
        if self.numbering.source_ordinals.is_some() {
            // Runner coordinates are authoritative, unlike stale plugin index
            // positions. Refuse missing source ordinals before staging any writes.
            for table in [
                "message_history_source",
                "message_history_fts",
                "message_fts_rowid_map",
            ] {
                let mut statement = self.conn.prepare(&format!(
                    "SELECT message_ordinal FROM {table} WHERE session_id=?1"
                ))?;
                let ordinals =
                    statement.query_map(params![self.session], |row| row.get::<_, i64>(0))?;
                for ordinal in ordinals {
                    self.check_position(table, ordinal?)?;
                }
            }
        }
        self.plan.phase("renumber/message_history_source");
        let sources: Vec<String> = self
            .conn
            .prepare(
                "SELECT message_id FROM message_history_source WHERE session_id = ?1 AND harness = ?2",
            )?
            .query_map(params![self.session, self.harness], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        self.stats.borrow_mut()["source_rows"] = sources
            .iter()
            .filter(|mid| self.numbering.entry_of(mid).flatten().is_some())
            .count()
            .into();
        for mid in sources {
            match self.numbering.entry_of(&mid).flatten() {
                Some(entry) => self.plan.execute(
                    "UPDATE message_history_source SET message_ordinal = ?1
                     WHERE session_id = ?2 AND message_id = ?3",
                    params![entry as i64, self.session, mid],
                )?,
                None => self.plan.execute(
                    "DELETE FROM message_history_source WHERE session_id = ?1 AND message_id = ?2",
                    params![self.session, mid],
                )?,
            };
        }
        self.plan.phase("renumber/message_history_fts");
        let rows = crate::move_batches::message_rows(self.conn, self.session)?;
        let ordinal_update = crate::move_batches::ordinal_update(self.conn)?;
        self.stats.borrow_mut()["search_rows"] = rows
            .iter()
            .filter(|(_, mid)| self.numbering.entry_of(mid).flatten().is_some())
            .count()
            .into();
        for (rowid, mid) in rows {
            match self.numbering.entry_of(&mid).flatten() {
                Some(entry) => self.plan.execute(
                    // The validated UNINDEXED content-column path avoids
                    // reindexing unchanged tokens on every small commit.
                    // No token count or ranking depends on this metadata;
                    // a different FTS layout uses its public UPDATE instead.
                    ordinal_update,
                    params![entry as i64, rowid],
                )?,
                None => self.plan.execute(
                    "DELETE FROM message_history_fts WHERE rowid = ?1",
                    params![rowid],
                )?,
            };
        }
        // The rowid map points each message number at its search row; it
        // follows the rows it points at.
        self.plan.phase("renumber/message_fts_rowid_map/delete");
        let mapped: Vec<(i64, i64, Option<i64>, Option<String>)> = self
            .conn
            .prepare(
                "SELECT m.rowid, m.fts_rowid, m.message_time_ms, f.message_id
                 FROM message_fts_rowid_map m
                 LEFT JOIN message_history_fts f ON f.rowid = m.fts_rowid
                 WHERE m.session_id = ?1",
            )?
            .query_map(params![self.session], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<Result<_, _>>()?;
        for (id, _, _, _) in &mapped {
            self.plan.execute(
                "DELETE FROM message_fts_rowid_map WHERE rowid = ?1",
                params![id],
            )?;
        }
        self.plan.phase("renumber/message_fts_rowid_map/insert");
        let mut kept = HashSet::new();
        for (_, rowid, time, mid) in mapped {
            let ordinal = mid
                .as_deref()
                .and_then(|mid| self.numbering.entry_of(mid).flatten())
                .map(|n| n as i64);
            if let Some(ordinal) = ordinal.filter(|ordinal| kept.insert(*ordinal)) {
                self.plan.execute(
                    "INSERT INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid, message_time_ms)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![self.destination.map_or(self.session, |(_, session)| session), ordinal, rowid, time],
                )?;
            }
        }
        // Messages the indexer skipped as too large, recorded by message id.
        let skips: Vec<(String, String)> = self
            .conn
            .prepare(
                "SELECT key, value FROM schema_migrations_meta WHERE key LIKE 'message_index_skip:%'",
            )?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        self.plan.phase("renumber/message_index_skip");
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
            if let Ok(record) = serde_json::from_str::<Value>(&value) {
                if let Some(ordinal) = record["ordinal"].as_i64() {
                    self.check_position("search skip", ordinal)?;
                }
            }
            match (entry, serde_json::from_str::<Value>(&value)) {
                (Some(entry), Ok(mut record)) if record.get("ordinal").is_some() => {
                    record["ordinal"] = (entry as i64).into();
                    if let Some((_, session)) = self.destination {
                        let target_key =
                            format!("message_index_skip:{}", serde_json::json!([session, mid]));
                        self.plan.execute(
                            "DELETE FROM schema_migrations_meta WHERE key=?1",
                            params![key],
                        )?;
                        self.plan.execute(
                            "INSERT INTO schema_migrations_meta(key,value) VALUES (?1,?2)",
                            params![target_key, record.to_string()],
                        )?;
                    } else {
                        self.plan.execute(
                            "UPDATE schema_migrations_meta SET value = ?1 WHERE key = ?2",
                            params![record.to_string(), key],
                        )?;
                    }
                }
                (Some(_), _) => {}
                (None, _) => {
                    self.plan.execute(
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

#[cfg(test)]
mod runner_tests;
