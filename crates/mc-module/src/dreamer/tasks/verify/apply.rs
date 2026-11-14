//! How a verify batch writes what its reply decides. Each verdict is checked
//! on its own; one that fails a check is dropped with its reason and the
//! rest still apply.
//!
//! Every verdict must name a memory the batch sent, still a live memory of
//! the project at the revision the batch read, in a category the task
//! covers, and a decision the task declares. Then:
//! - `verified` records the time and the commit checked, and the files the
//!   reply names become the memory's mapping when they are tracked files
//!   inside the checkout, so a memory verified by searching becomes mapped;
//! - `skip` records only that the memory was checked;
//! - `update` keeps 0.49's rules: a project rule that reads as a behavioural
//!   directive is never rewritten, the text must be non-empty and at most
//!   20,000 characters, it may not drop more than half the old text unless
//!   the reply marks it a consolidation, and it may not repeat another
//!   memory of the category;
//! - `archive` never touches a protected memory (safety-critical, permanent,
//!   a policy, or written or edited by the person, as curate protects them);
//!   with `missing` it needs that path or name to be one of the memory's
//!   citations as [`super::cites`] reads them, and the checkout not to hold
//!   it; without it, it needs evidence in `reason`, and
//!   is refused for a directive-shaped rule.
//!
//! A verification or check changes no text, so it advances neither the
//! revision nor `updated_at` and leaves no history row, as a classification
//! that confirms a row leaves none. An update or archive advances the
//! revision and records the row before and after in the undo history, under
//! a decision that names the run.
//!
//! Undoing the run puts back what it can: each updated or archived row, an
//! archived memory's mapping (recorded with its decision), and each mapping a
//! verification replaced (recorded once per batch, as map records its own).
//! An update's mapping is not recorded: undoing it restores the older text,
//! and restoring a text clears the mapping, as every text change does, so a
//! recorded mapping would no longer match and would stop the whole undo.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use regex::Regex;
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};

use super::cites::cites;
use super::manifest::{js_trim, Decision, Verdict};
use super::{Absence, VerifyBatch};
use crate::dreamer::task::Applied;
use crate::dreamer::tasks::map_memories::{
    mapping_json, mapping_rows, put_mapping, MappingRow, MAPPER,
};
use crate::memory_writes::{
    archive, clear_derived, get_memory, history_json, history_snapshot, normalized_hash, now_ms,
    record_history, update_content, History, MemoryRow, PROTECTED,
};

/// A memory's mapping before and after a write, as the journal records it.
type MappingChange = (i64, Vec<MappingRow>, Vec<MappingRow>);

/// The category of project rules, whose directive-shaped memories 0.49 kept
/// from being rewritten or archived on the code's evidence.
const RULES_CATEGORY: &str = "swe:project-rules";
/// The longest text an update may write, in UTF-16 units as the plugin
/// counted.
const MAX_CONTENT: usize = 20_000;
/// The memory's metadata as a JSON object, whatever the column holds.
const METADATA: &str = "CASE WHEN json_valid(metadata_json)
        THEN CASE WHEN json_type(metadata_json) = 'object' THEN metadata_json ELSE '{}' END
        ELSE '{}' END";

/// Whether a project rule reads as a behavioural directive (when to act, how
/// to work, who decides): 0.49's patterns, compiled with the JavaScript
/// semantics the plugin's verifier had (ASCII word boundaries and digits,
/// JavaScript's whitespace).
fn directive(memory: &MemoryRow) -> bool {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    if memory.category_id != RULES_CATEGORY {
        return false;
    }
    let patterns = PATTERNS.get_or_init(|| {
        [
            r"(?:^|[.!?]\s+|\n\s*)(?:[-*]\s+|\d+[.)]\s+)?(?:you\s+|we\s+)?(?:must(?:\s+not)?|never|always|do\s+not|don't|shall\s+not)\b",
            r"\b(?:you|we|agents?|masons?|workers?|operators?|users?|maintainers?)\s+(?:must(?:\s+not)?|should(?:\s+not)?|need\s+to|shall(?:\s+not)?|cannot|can't|may\s+not)\b",
            r"\bwhen\s+(?:you(?:'re|\s+are)?|we(?:'re|\s+are)?|told|asked|requested|working|debugging|reviewing|checking|verifying|investigating|using|running|editing|changing)\b",
            r"(?:^|[.!?]\s+|\n\s*)(?:[-*]\s+|\d+[.)]\s+)?(?:please\s+)?(?:run|use|check|ask|avoid|prefer|ensure|keep|follow|brief|report|inspect|search|open|read|review|validate|confirm|delegate|stop|start|remember)\b",
            r"\b(?:the\s+)?(?:user|operator|maintainer|owner)\s+(?:decides|chooses|approves|has\s+(?:the\s+)?final\s+say)\b",
        ]
        .iter()
        .map(|pattern| {
            Regex::new(
                &format!("(?i){pattern}")
                    .replace("\\b", r"(?-u:\b)")
                    .replace("\\d", "[0-9]")
                    .replace(
                        "\\s",
                        r"[\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]",
                    ),
            )
            .expect("a fixed directive pattern")
        })
        .collect()
    });
    let text = js_trim(&memory.content);
    patterns.iter().any(|pattern| pattern.is_match(text))
}

impl VerifyBatch {
    /// Check and write each of `verdicts`, inside `tx`.
    pub(super) fn write(
        &self,
        tx: &Transaction<'_>,
        verdicts: &[Verdict],
        run: i64,
    ) -> rusqlite::Result<Applied> {
        let now = now_ms();
        let mut applied = Applied {
            proposed: verdicts.len(),
            ..Applied::default()
        };
        let mut remapped = Vec::new();
        for verdict in verdicts {
            let dropped = match self.check(tx, verdict)? {
                Err(reason) => Some(reason),
                Ok(current) => self.write_one(tx, verdict, &current, run, now, &mut remapped)?,
            };
            match dropped {
                Some(reason) => applied.dropped.push(reason),
                None => applied.applied += 1,
            }
        }
        if !remapped.is_empty() {
            self.record_mappings(tx, run, &remapped, now)?;
        }
        Ok(applied)
    }

    /// The memory as it is now when `verdict` may be written; why not
    /// otherwise.
    fn check(
        &self,
        tx: &Transaction<'_>,
        verdict: &Verdict,
    ) -> rusqlite::Result<Result<MemoryRow, String>> {
        let id = verdict.id;
        let task = &self.declared.task;
        let Some(read) = self.read.iter().find(|read| read.id == id) else {
            return Ok(Err(format!("memory {id} is not in this batch")));
        };
        let action = verdict.decision.action();
        if !self
            .declared
            .actions
            .iter()
            .any(|declared| declared == action)
        {
            return Ok(Err(format!(
                "memory {id}: {task} does not declare {action}"
            )));
        }
        let Some(current) = get_memory(tx, id)?
            .filter(|memory| memory.is_project_owned_by(&self.project) && memory.is_mutable())
        else {
            return Ok(Err(format!(
                "memory {id} is no longer a live memory of the project"
            )));
        };
        if !self.declared.categories.contains(&current.category_id) {
            return Ok(Err(format!(
                "memory {id} is filed under {}, which {task} does not cover",
                current.category_id
            )));
        }
        if current.revision != read.revision {
            return Ok(Err(format!(
                "memory {id} changed after the batch read it (revision {}, now {})",
                read.revision, current.revision
            )));
        }
        if verdict.decision == Decision::Archive && protected(tx, id)? {
            return Ok(Err(format!(
                "memory {id} is protected (safety-critical, permanent, a policy, or the person's own) and is never archived"
            )));
        }
        let refusal = match verdict.decision {
            Decision::Update => self.check_update(tx, verdict, &current)?,
            Decision::Archive => self.check_archive(verdict, &current),
            Decision::Verified | Decision::Skip => None,
        };
        Ok(match refusal {
            Some(reason) => Err(format!("memory {id}: {reason}")),
            None => Ok(current),
        })
    }

    fn check_update(
        &self,
        tx: &Transaction<'_>,
        verdict: &Verdict,
        current: &MemoryRow,
    ) -> rusqlite::Result<Option<String>> {
        let content = js_trim(&verdict.content);
        let length = content.encode_utf16().count();
        if directive(current) {
            return Ok(Some(
                "a project rule that reads as a behavioural directive is only verified or skipped"
                    .into(),
            ));
        }
        if content.is_empty() || length > MAX_CONTENT {
            return Ok(Some(format!(
                "the update's text is empty or longer than {MAX_CONTENT} characters"
            )));
        }
        if !verdict.consolidation && length * 2 < js_trim(&current.content).encode_utf16().count() {
            return Ok(Some(
                "the update drops more than half the text without consolidation=\"true\"".into(),
            ));
        }
        let duplicate: Option<i64> = tx
            .query_row(
                "SELECT id FROM memories
                  WHERE level = 'project' AND owner_id = ?1 AND category = ?2 AND normalized_hash = ?3
                    AND id != ?4
                  ORDER BY id LIMIT 1",
                params![
                    self.project,
                    current.category_id,
                    normalized_hash(content),
                    current.id
                ],
                |row| row.get(0),
            )
            .optional()?;
        Ok(duplicate.map(|other| format!("the update's text is already memory {other}")))
    }

    fn check_archive(&self, verdict: &Verdict, current: &MemoryRow) -> Option<String> {
        let Some(missing) = &verdict.missing else {
            if directive(current) {
                return Some(
                    "a project rule that reads as a behavioural directive is archived only with missing=, once everything it cites is gone"
                        .into(),
                );
            }
            return js_trim(&verdict.reason)
                .is_empty()
                .then(|| "an archive without missing= needs the code's evidence in reason".into());
        };
        // Only something the module itself reads as a citation of this
        // memory can be gone: text that merely occurs in it may be English.
        let Some(cite) = cites(&current.content)
            .into_iter()
            .find(|cite| cite.text() == missing)
        else {
            return Some(format!(
                "missing={missing:?} is not a path or name the memory cites"
            ));
        };
        match self.absence(&cite) {
            Absence::Absent => None,
            Absence::Present => Some(format!("{missing} is still in the checkout")),
            Absence::Undecided(why) => {
                Some(format!("whether {missing} is gone is undecided: {why}"))
            }
        }
    }

    /// The tracked files among `named`, in order and once each.
    fn tracked(&self, named: &[String]) -> Vec<String> {
        let mut files: Vec<String> = named
            .iter()
            .filter_map(|file| self.checkout.tracked_file(file))
            .collect();
        files.sort();
        files.dedup();
        files
    }

    /// Write `verdict`, which passed its checks. `Some` when it is dropped
    /// after all, with why. A mapping a verification replaces is added to
    /// `remapped`.
    fn write_one(
        &self,
        tx: &Transaction<'_>,
        verdict: &Verdict,
        current: &MemoryRow,
        run: i64,
        now: i64,
        remapped: &mut Vec<MappingChange>,
    ) -> rusqlite::Result<Option<String>> {
        let id = verdict.id;
        let commit = self.commit();
        let read_files = self
            .read
            .iter()
            .find(|read| read.id == id)
            .map(|read| read.files.clone())
            .unwrap_or_default();
        match verdict.decision {
            Decision::Skip => {
                tx.execute(
                    &format!(
                        "UPDATE memories SET verify_result = 'skipped', verify_commit = ?2,
                                metadata_json = json_set({METADATA}, '$.dreamerCheckedAt', ?3)
                          WHERE id = ?1"
                    ),
                    params![id, commit, now],
                )?;
                Ok(None)
            }
            Decision::Verified => {
                let named = self.tracked(&verdict.files);
                // Without a tracked file named, the mapping stays as it was.
                let files = if named.is_empty() {
                    self.tracked(&read_files)
                } else {
                    let before = mapping_rows(tx, id)?;
                    let mapped: BTreeSet<&str> =
                        before.iter().map(|row| row.file_path.as_str()).collect();
                    if mapped == named.iter().map(String::as_str).collect::<BTreeSet<_>>() {
                        // The same files, checked again: not a new mapping.
                        tx.execute(
                            "UPDATE memory_verifications SET verified_at = ?2 WHERE memory_id = ?1",
                            params![id, now],
                        )?;
                    } else {
                        let after = mapping_of(&named, now);
                        put_mapping(tx, id, &after)?;
                        remapped.push((id, before, after));
                    }
                    named
                };
                stamp_verified(tx, id, "confirmed", &files, commit, now)?;
                Ok(None)
            }
            Decision::Update => {
                let Some(before) = history_snapshot(tx, id)? else {
                    return Ok(Some(unrecordable(id)));
                };
                let content = js_trim(&verdict.content);
                tx.execute(
                    "UPDATE memories SET revision = revision + 1 WHERE id = ?1",
                    params![id],
                )?;
                // The new text loses what was derived from the old one:
                // its file mapping, embedding, classification and mural cue.
                update_content(tx, id, content, &normalized_hash(content))?;
                let named = self.tracked(&verdict.files);
                let files = if named.is_empty() {
                    self.tracked(&read_files)
                } else {
                    named
                };
                put_mapping(tx, id, &mapping_of(&files, now))?;
                stamp_verified(tx, id, "updated", &files, commit, now)?;
                let after = after_snapshot(tx, id)?;
                self.record(
                    tx,
                    run,
                    id,
                    "update",
                    "verify_update",
                    (before, after),
                    json!([]),
                    None,
                    now,
                )?;
                Ok(None)
            }
            Decision::Archive => {
                let Some(before) = history_snapshot(tx, id)? else {
                    return Ok(Some(unrecordable(id)));
                };
                let reason = match (js_trim(&verdict.reason), &verdict.missing) {
                    ("", Some(missing)) => format!("{missing} is gone from the checkout"),
                    (reason, _) => reason.to_owned(),
                };
                let mapping = mapping_rows(tx, id)?;
                tx.execute(
                    "UPDATE memories SET revision = revision + 1 WHERE id = ?1",
                    params![id],
                )?;
                archive(tx, current, Some(&reason))?;
                // An archived memory keeps no derived state, as an archive
                // by the agent's memory tool keeps none.
                clear_derived(tx, id)?;
                tx.execute(
                    "UPDATE memories SET verify_result = 'archived', verify_commit = ?2 WHERE id = ?1",
                    params![id, commit],
                )?;
                let after = after_snapshot(tx, id)?;
                let evidence = match &verdict.missing {
                    Some(missing) => json!([{"missing": missing}]),
                    None => json!([]),
                };
                self.record(
                    tx,
                    run,
                    id,
                    "archive",
                    &reason,
                    (before, after),
                    evidence,
                    (!mapping.is_empty()).then_some(mapping),
                    now,
                )?;
                Ok(None)
            }
        }
    }

    /// Record one memory's change in the undo history and the journal, as
    /// one decision named after the run. `cleared` is the mapping the change
    /// removed, which undoing the run puts back.
    #[allow(clippy::too_many_arguments)]
    fn record(
        &self,
        tx: &Transaction<'_>,
        run: i64,
        id: i64,
        operation: &str,
        reason: &str,
        (before, after): (Value, Value),
        evidence: Value,
        cleared: Option<Vec<MappingRow>>,
        now: i64,
    ) -> rusqlite::Result<()> {
        let key = format!("dream-run:{run}:{}:{}:{id}", self.declared.kind, self.index);
        let writer = format!("dreamer:{}", self.declared.kind);
        let mut decision = record_history(
            tx,
            &History {
                key: &key,
                project: &self.project,
                writer: &writer,
                operation,
                reason,
                now,
                before: &[Some(before)],
                after: &[Some(after)],
                source_ids: &[id],
                survivor_id: None,
                evidence,
            },
        )?;
        if let Some(cleared) = cleared {
            decision["mappings"] = json!([{
                "memoryId": id,
                "before": mapping_json(&cleared),
                "after": mapping_json(&[]),
            }]);
        }
        // The journal row is written the way the other history writers
        // write theirs: the receipt first, then the whole decision in both
        // snapshot columns, where the undo view reads it.
        tx.execute(
            "INSERT INTO memory_journal(project_path, decision_key, operation, receipt_json, applied_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                self.project,
                key,
                operation,
                json!({"state": "applied", "reason": operation, "memoryIds": [id]}).to_string(),
                now
            ],
        )?;
        tx.execute(
            "UPDATE memory_journal SET before_json = ?2, after_json = ?2 WHERE decision_key = ?1",
            params![key, history_json(&decision)],
        )?;
        Ok(())
    }

    /// Record the mappings this batch's verifications replaced as one
    /// journal entry, each before and after, where undoing the run reads
    /// them. The entry holds no memory rows.
    fn record_mappings(
        &self,
        tx: &Transaction<'_>,
        run: i64,
        changes: &[MappingChange],
        now: i64,
    ) -> rusqlite::Result<()> {
        let key = format!(
            "dream-run:{run}:{}:{}:mappings",
            self.declared.kind, self.index
        );
        let ids: Vec<i64> = changes.iter().map(|(id, _, _)| *id).collect();
        let decision = json!({
            "version": 1,
            "decisionKey": key,
            "projectPath": self.project,
            "writer": format!("dreamer:{}", self.declared.kind),
            "operation": MAPPING_OPERATION,
            "reason": self.declared.kind,
            "appliedAt": now,
            "mappings": changes
                .iter()
                .map(|(id, before, after)| json!({
                    "memoryId": id,
                    "before": mapping_json(before),
                    "after": mapping_json(after),
                }))
                .collect::<Vec<_>>(),
        });
        tx.execute(
            "INSERT INTO memory_journal(project_path, decision_key, operation, receipt_json, applied_at,
                                        before_json, after_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                self.project,
                key,
                MAPPING_OPERATION,
                json!({"state": "applied", "reason": MAPPING_OPERATION, "memoryIds": ids}).to_string(),
                now,
                history_json(&decision)
            ],
        )?;
        Ok(())
    }
}

/// The journal operation of the mappings a batch's verifications replaced.
const MAPPING_OPERATION: &str = "verify_mapping";

/// Whether memory `id` is protected from archives (see [`PROTECTED`]).
fn protected(tx: &Transaction<'_>, id: i64) -> rusqlite::Result<bool> {
    tx.query_row(
        &format!("SELECT {PROTECTED} FROM memories m WHERE m.id = ?1"),
        params![id],
        |row| row.get(0),
    )
}

/// `files` as mapping rows a verification wrote at `now`.
fn mapping_of(files: &[String], now: i64) -> Vec<MappingRow> {
    files
        .iter()
        .map(|file| MappingRow {
            file_path: file.clone(),
            mapping_origin: MAPPER.to_owned(),
            verified_at: now,
            mapped_at: now,
        })
        .collect()
}

fn unrecordable(id: i64) -> String {
    format!("memory {id} holds a row the undo history can't record")
}

fn after_snapshot(tx: &Transaction<'_>, id: i64) -> rusqlite::Result<Value> {
    history_snapshot(tx, id)?.ok_or_else(|| {
        rusqlite::Error::InvalidParameterName(format!(
            "memory {id} has no history snapshot after its verification"
        ))
    })
}

/// Record that the memory was verified now, at `commit`, against `files`,
/// with the metadata stamps the plugin's verifier wrote, so the next
/// `verify` run diffs from this commit.
fn stamp_verified(
    tx: &Transaction<'_>,
    id: i64,
    result: &str,
    files: &[String],
    commit: Option<&str>,
    now: i64,
) -> rusqlite::Result<()> {
    tx.execute(
        &format!(
            "UPDATE memories SET verification_status = 'verified', verified_at = ?3,
                    verify_result = ?2, verify_files_json = ?4, verify_commit = ?5,
                    metadata_json = json_set({METADATA}, '$.dreamerVerifiedAt', ?3,
                                             '$.dreamerVerifiedCommit', ?5, '$.dreamerCheckedAt', ?3)
              WHERE id = ?1"
        ),
        params![id, result, now, json!(files).to_string(), commit],
    )?;
    Ok(())
}

#[cfg(test)]
#[path = "apply_tests.rs"]
mod tests;
