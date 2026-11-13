//! The `classify-memories` task: score each live project memory's
//! importance and mark the operating rules that are safety-critical, so the
//! memory block keeps what matters when it is over budget.
//!
//! Ported from the 0.49.x Rust module kept for reference in `crates_old/`
//! (`mc-module/src/dream_tasks/classify.rs`, and the commit in
//! `mc-store/src/dream_memory.rs`). A project with fewer than ten live
//! memories is not classified: there is too little to rank. Up to a hundred
//! live memories, a batch holds only the memories to classify. Above that,
//! every batch also carries up to thirty memories classified earlier, picked
//! across the range of their importance, so a model that sees one slice of a
//! large pool scores on the same scale as the slices before it. A memory is
//! sent until it has been classified once; a text change clears that and
//! sends it again.
//!
//! The model proposes and the batch decides. A memory that changed after the
//! batch read it, or stopped being live, keeps what it has.
//!
//! The task never writes a memory's scope or shareability. Shareability
//! decides what leaves the machine under team sync, and ck-mc has no check
//! for sensitive memory text, so both keep what the memory's writer gave it.
//! A reply's `scope` and `shareable` attributes are ignored.

use std::collections::{HashMap, HashSet};

use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::json;

use crate::dreamer::run::{TaskInput, TaskReply};
use crate::dreamer::task::{task_prompts, Applied, Batch, Owner, Task, TaskContext};
use crate::memory_writes::{
    history_json, history_snapshot, now_ms, record_history, History, SAFETY_CRITICAL_MIN_IMPORTANCE,
};
use crate::summary::fit::Window;
use crate::summary::two_pass::constants::MAX_STAGE2_ATTEMPTS;

/// The kind memory profiles name.
pub(crate) const KIND: &str = "classify-memories";
/// Magic Context's frame that the task's message fills with the memories.
const INPUT_FRAME: &str = "dreamer/classify-memories.input";
/// Who the undo history names as the decider.
const WRITER: &str = "dreamer:classify-memories";
/// The operation the undo history and the journal record.
const OPERATION: &str = "classify";
/// Below this many live memories there is too little to rank.
const MIN_POOL: usize = 10;
/// Up to this many live memories, a batch carries no reference memories.
const SMALL_POOL: usize = 100;
/// At most this many classified memories go with each batch as references.
const MAX_ANCHORS: usize = 30;
/// At most this many memories are classified by one message.
pub(crate) const BATCH_SIZE: usize = 100;
/// The importance a memory without one is shown and ranked at.
const DEFAULT_IMPORTANCE: i64 = 50;

/// One live project memory as the task reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Memory {
    pub id: i64,
    /// The tag it was written under (`origin_category`): the category the
    /// classifier's instructions name.
    pub category: String,
    pub content: String,
    pub importance: Option<i64>,
    pub scope: String,
    pub shareable: bool,
    pub revision: i64,
    pub classified: bool,
    /// The summarizer's second turn still owes this memory a score (an open
    /// classification item). That turn scores it from the conversation it
    /// was saved in, so this task leaves it alone until then.
    pub open_item: bool,
}

/// How many second-turn sends carried a classification item, counted as the
/// summarizer's second turn counts them (`ITEM_SENDS` in
/// `summary/two_pass/turn_two.rs`). An item sent its limit of times is given
/// up, and no longer holds its memory back.
const ITEM_SENDS: &str = "(SELECT COUNT(*) FROM memory_stage_attempts s, json_each(s.request_json, '$.items') j
    WHERE s.project_path = i.project_path AND s.stage = 'turn_two' AND j.value = i.enqueue_sequence)";

/// `project`'s live memories, by id.
pub(crate) fn live_memories(conn: &Connection, project: &str) -> rusqlite::Result<Vec<Memory>> {
    conn.prepare(&format!(
        "SELECT m.id, m.origin_category, m.content, m.importance, m.scope, m.shareable, m.revision,
                m.classified_at IS NOT NULL,
                EXISTS(SELECT 1 FROM memory_classification_items i
                        WHERE i.project_path = m.owner_id AND i.memory_id = m.id
                          AND i.state = 'pending' AND {ITEM_SENDS} < ?2)
           FROM memories m
          WHERE m.level = 'project' AND m.owner_id = ?1 AND m.status IN ('active', 'permanent')
          ORDER BY m.id"
    ))?
    .query_map(params![project, MAX_STAGE2_ATTEMPTS], |row| {
        Ok(Memory {
            id: row.get(0)?,
            category: row.get(1)?,
            content: row.get(2)?,
            importance: row.get(3)?,
            scope: row.get(4)?,
            shareable: row.get::<_, i64>(5)? != 0,
            revision: row.get(6)?,
            classified: row.get(7)?,
            open_item: row.get(8)?,
        })
    })?
    .collect()
}

/// What one run classifies, and against which references.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Plan {
    /// 1: too few live memories to classify; 2: classified without
    /// references; 3: classified next to references.
    pub stage: u8,
    /// The memories to classify, by id.
    pub targets: Vec<i64>,
    /// The classified memories every batch shows as references.
    pub anchors: Vec<i64>,
}

/// Plan a run over `live`, a project's live memories in id order.
pub(crate) fn plan(live: &[Memory]) -> Plan {
    if live.len() < MIN_POOL {
        return Plan {
            stage: 1,
            targets: Vec::new(),
            anchors: Vec::new(),
        };
    }
    let stage = if live.len() <= SMALL_POOL { 2 } else { 3 };
    let targets = live
        .iter()
        .filter(|memory| !memory.classified && !memory.open_item)
        .map(|memory| memory.id)
        .collect();
    let mut classified: Vec<&Memory> = if stage == 3 {
        live.iter().filter(|memory| memory.classified).collect()
    } else {
        Vec::new()
    };
    if classified.len() > MAX_ANCHORS {
        // Evenly spaced picks from a stable sort by importance: references
        // from the whole range of scores the pool already holds.
        classified.sort_by_key(|memory| memory.importance.unwrap_or(DEFAULT_IMPORTANCE));
        let count = classified.len();
        classified = (0..MAX_ANCHORS)
            .map(|pick| classified[pick * count / MAX_ANCHORS])
            .collect();
    }
    Plan {
        stage,
        targets,
        anchors: classified.iter().map(|memory| memory.id).collect(),
    }
}

/// The text that fills the task's input frame: the references, when there
/// are any, then the memories to classify, each in the frame's own shape.
///
/// A pool memory shows only its id, category and text. Every memory in the
/// pool is one no classifier has scored yet, so its importance, scope and
/// shareability are the writer's defaults (importance 50), not a judgment.
/// The 0.49 dreamer showed them as "current" values. In a replay of 100 real
/// memories on DeepSeek Flash, two runs with those values put 78 and 81 of
/// 100 between 40 and 60 and marked 2 and 3 rules safety-critical; two runs
/// without them put 69 and 72 there and marked 5 and 3. The model started
/// from the 50 instead of judging each memory.
pub(crate) fn input(pool: &[Memory], anchors: &[Memory]) -> String {
    let mut text = String::new();
    if !anchors.is_empty() {
        text.push_str("### Already-classified reference memories (calibrate against these — do NOT re-score them, they are NOT in your output)\n");
        let entries: Vec<String> = anchors
            .iter()
            .map(|memory| {
                format!(
                    "[{}] {} importance={}\n{}",
                    memory.id,
                    memory.category,
                    memory.importance.unwrap_or(DEFAULT_IMPORTANCE),
                    memory.content
                )
            })
            .collect();
        text.push_str(&entries.join("\n\n"));
        text.push_str("\n\n");
    }
    text.push_str("### Memory pool to classify\n");
    let entries: Vec<String> = pool
        .iter()
        .map(|memory| format!("[{}] {}\n{}", memory.id, memory.category, memory.content))
        .collect();
    text.push_str(&entries.join("\n\n"));
    text
}

/// One memory's classification as a reply proposes it. A field the reply
/// leaves out keeps the memory's current value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Classification {
    pub id: i64,
    /// Clamped to 1-100.
    pub importance: Option<i64>,
    pub safety_critical: Option<bool>,
}

pub(super) fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a fixed manifest pattern")
}

/// Why a reply holds no entries, in words a model's failure can be
/// recognised by. The map task's `<mappings>` manifest shares the reading.
pub(super) fn describe_shape(text: &str, root: &str) -> String {
    let expected = format!("expected <{root}> with <memory> entries");
    let json = |text: &str| {
        if text.starts_with('[') {
            Some("array")
        } else if text.starts_with('{') {
            Some("object")
        } else {
            None
        }
    };
    let text = text.trim();
    if let Some(kind) = json(text) {
        return format!("JSON {kind} unrecognized; {expected}");
    }
    let tag = re(r"<([A-Za-z][A-Za-z0-9_:-]*)\b");
    if let Some(found) = tag.captures(text) {
        if !found[1].eq_ignore_ascii_case(root) {
            return format!("root <{}> unrecognized; {expected}", &found[1]);
        }
    }
    let body = re(&format!(r"(?is)<{root}\b[^>]*>(.*?)</{root}>"))
        .captures(text)
        .map(|found| found[1].trim().to_owned())
        .unwrap_or_default();
    if let Some(kind) = json(&body) {
        return format!("JSON {kind} unrecognized; {expected}");
    }
    if let Some(found) = tag.captures(&body) {
        if !found[1].eq_ignore_ascii_case("memory") {
            return format!("root <{}> unrecognized; {expected}", &found[1]);
        }
    }
    format!("parsed zero entries; {expected}")
}

/// The text inside a reply's root element.
pub(super) fn body(text: &str, root: &str) -> Result<String, String> {
    if let Some(found) = re(&format!(r"(?is)<{root}\b[^>]*>(.*?)</{root}>")).captures(text) {
        return Ok(found[1].to_owned());
    }
    let described = describe_shape(text, root);
    if !described.starts_with("parsed zero entries") {
        return Err(described);
    }
    if re(&format!(r"(?i)<{root}\b")).is_match(text)
        && !re(&format!(r"(?i)</{root}>")).is_match(text)
    {
        Err(format!("{root} manifest missing closing root tag"))
    } else {
        Err(format!("{root} manifest missing complete root element"))
    }
}

/// An attribute's value when it matches `value`. Any other value reads as
/// absent, so the memory keeps its current value.
pub(super) fn attribute(
    attributes: &str,
    name: &str,
    value: &str,
    any_case: bool,
) -> Option<String> {
    re(&format!(
        r#"{}\b{name}\s*=\s*"({value})""#,
        if any_case { "(?i)" } else { "" }
    ))
    .captures(attributes)
    .map(|found| found[1].to_owned())
}

fn boolean(attributes: &str, name: &str) -> Option<bool> {
    attribute(attributes, name, "true|false|1|0", true)
        .map(|value| value.eq_ignore_ascii_case("true") || value == "1")
}

/// Read a reply's `<classify>` manifest. Only `id`, `importance` and
/// `safety_critical` are read; any other attribute, `scope` and `shareable`
/// included, is ignored.
pub(crate) fn parse_manifest(text: &str) -> Result<Vec<Classification>, String> {
    let body = body(text, "classify")?;
    let mut found = Vec::new();
    for entry in re(r"<memory\b([^>]*)/?>").captures_iter(&body) {
        let attributes = &entry[1];
        let id = attribute(attributes, "id", "[0-9]+", false)
            .and_then(|value| value.parse().ok())
            .ok_or("classify manifest entry missing numeric id")?;
        let importance = attribute(attributes, "importance", "[0-9]+", false).map(|value| {
            value
                .parse::<f64>()
                .unwrap_or(f64::INFINITY)
                .clamp(1.0, 100.0) as i64
        });
        let safety_critical = boolean(attributes, "safety_critical");
        if importance.is_none() && safety_critical.is_none() {
            return Err(format!(
                "classify manifest entry {id} missing classification fields"
            ));
        }
        found.push(Classification {
            id,
            importance,
            safety_critical,
        });
    }
    if found.is_empty() && !body.trim().is_empty() {
        return Err(describe_shape(text, "classify"));
    }
    let mut seen = HashSet::new();
    for entry in &found {
        if !seen.insert(entry.id) {
            return Err(format!(
                "classify manifest contains duplicate id {}",
                entry.id
            ));
        }
    }
    Ok(found)
}

/// A reply's manifest when it classifies exactly the memories in `expected`,
/// each once.
pub(crate) fn validate_manifest(
    text: &str,
    expected: &[i64],
) -> Result<Vec<Classification>, String> {
    let found = parse_manifest(text)?;
    if found.is_empty() && !expected.is_empty() {
        return Err(describe_shape(text, "classify"));
    }
    for entry in &found {
        if !expected.contains(&entry.id) {
            return Err(format!(
                "classify manifest contains unknown id {}",
                entry.id
            ));
        }
    }
    for id in expected {
        if !found.iter().any(|entry| entry.id == *id) {
            return Err(format!("classify manifest missing id {id}"));
        }
    }
    Ok(found)
}

/// The task kind.
pub(crate) struct Classify;

impl Classify {
    /// The run's batches for the context's owner, in order.
    pub(crate) fn plan_batches(
        &self,
        context: &TaskContext<'_>,
    ) -> Result<Vec<ClassifyBatch>, String> {
        let Owner::Project { id: project, .. } = context.owner;
        let live = context
            .db
            .with_connection(|conn| live_memories(conn, project))
            .map_err(|error| format!("reading the memories of {project}: {error}"))?;
        let plan = plan(&live);
        let by_id: HashMap<i64, &Memory> = live.iter().map(|memory| (memory.id, memory)).collect();
        let pick = |ids: &[i64]| -> Vec<Memory> {
            ids.iter()
                .filter_map(|id| by_id.get(id).map(|memory| (*memory).clone()))
                .collect()
        };
        let anchors = pick(&plan.anchors);
        pick(&plan.targets)
            .chunks(BATCH_SIZE)
            .enumerate()
            .map(|(index, pool)| {
                let text = input(pool, &anchors);
                let (system, message) = task_prompts(
                    context.profile,
                    context.task_id(),
                    "user",
                    &[(INPUT_FRAME, text.as_str())],
                    &[("projectIdentity", project.as_str())],
                )?;
                Ok(ClassifyBatch {
                    index,
                    project: project.clone(),
                    system,
                    message,
                    read: pool
                        .iter()
                        .map(|memory| (memory.id, memory.revision))
                        .collect(),
                })
            })
            .collect()
    }
}

impl Task for Classify {
    fn kind(&self) -> &'static str {
        KIND
    }

    fn batches(&self, context: &TaskContext<'_>) -> Result<Vec<Box<dyn Batch>>, String> {
        Ok(self
            .plan_batches(context)?
            .into_iter()
            .map(|batch| Box::new(batch) as Box<dyn Batch>)
            .collect())
    }
}

/// One message of a classify run.
pub(crate) struct ClassifyBatch {
    /// Its place in the run, which names its decision in the undo history.
    index: usize,
    project: String,
    system: String,
    message: String,
    /// Each memory the batch classifies, with the revision it was read at.
    read: Vec<(i64, i64)>,
}

impl ClassifyBatch {
    fn ids(&self) -> Vec<i64> {
        self.read.iter().map(|(id, _)| *id).collect()
    }

    /// The decision this batch's writes are recorded under.
    fn decision_key(&self, run: i64) -> String {
        format!("dream-run:{run}:{KIND}:{}", self.index)
    }
}

impl TaskInput for ClassifyBatch {
    fn system(&self) -> &str {
        &self.system
    }

    fn prompt(&self, window: Window, output_tokens: u64) -> Option<String> {
        window
            .admits(output_tokens, &self.system, &self.message)
            .then(|| self.message.clone())
    }

    fn accepts(&self, reply: &str) -> Result<(), String> {
        validate_manifest(reply, &self.ids()).map(|_| ())
    }
}

impl Batch for ClassifyBatch {
    fn apply(&self, tx: &Transaction<'_>, reply: &TaskReply, run: i64) -> Result<Applied, String> {
        let proposals = validate_manifest(&reply.text, &self.ids())?;
        self.write(tx, &proposals, run)
            .map_err(|error| format!("writing classifications: {error}"))
    }
}

/// The classification fields of a memory row: the ones this task writes.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Values {
    importance: Option<i64>,
    safety_critical: Option<bool>,
}

/// A memory row as a batch finds it when it writes.
struct Current {
    live: bool,
    revision: i64,
    classified: bool,
    values: Values,
}

fn current(tx: &Transaction<'_>, id: i64, project: &str) -> rusqlite::Result<Option<Current>> {
    tx.query_row(
        "SELECT level = 'project' AND owner_id = ?2 AND status IN ('active', 'permanent'),
                revision, classified_at IS NOT NULL, importance, safety_critical
           FROM memories WHERE id = ?1",
        params![id, project],
        |row| {
            Ok(Current {
                live: row.get::<_, Option<bool>>(0)?.unwrap_or(false),
                revision: row.get(1)?,
                classified: row.get(2)?,
                values: Values {
                    importance: row.get(3)?,
                    safety_critical: row.get::<_, Option<i64>>(4)?.map(|flag| flag != 0),
                },
            })
        },
    )
    .optional()
}

impl ClassifyBatch {
    /// Write what `proposals` change, in `tx`. A memory counts as applied
    /// when its row was written; one that already holds what its proposal
    /// says is left alone, and counts as neither applied nor dropped.
    fn write(
        &self,
        tx: &Transaction<'_>,
        proposals: &[Classification],
        run: i64,
    ) -> rusqlite::Result<Applied> {
        let now = now_ms();
        let mut applied = Applied {
            proposed: proposals.len(),
            ..Applied::default()
        };
        let mut before = Vec::new();
        let mut after = Vec::new();
        let mut changed_ids = Vec::new();
        for proposal in proposals {
            let id = proposal.id;
            let Some(&(_, read_revision)) = self.read.iter().find(|(read, _)| *read == id) else {
                continue;
            };
            let Some(current) = current(tx, id, &self.project)?.filter(|current| current.live)
            else {
                applied.dropped.push(format!(
                    "memory {id} is no longer a live memory of the project"
                ));
                continue;
            };
            let was = &current.values;
            let safety_critical = proposal.safety_critical.or(was.safety_critical);
            let mut importance = proposal.importance.or(was.importance);
            if safety_critical == Some(true) {
                importance = Some(importance.map_or(SAFETY_CRITICAL_MIN_IMPORTANCE, |score| {
                    score.max(SAFETY_CRITICAL_MIN_IMPORTANCE)
                }));
            }
            let next = Values {
                importance,
                safety_critical,
            };
            let changed = next != *was;
            if current.classified && !changed {
                continue;
            }
            if current.revision != read_revision {
                applied.dropped.push(format!(
                    "memory {id} changed after the batch read it (revision {read_revision}, now {})",
                    current.revision
                ));
                continue;
            }
            if changed {
                let Some(snapshot) = history_snapshot(tx, id)? else {
                    applied.dropped.push(format!(
                        "memory {id} holds a row the undo history can't record"
                    ));
                    continue;
                };
                // Clause evidence is kept per revision. The text stays the
                // same, so the evidence moves to the new revision with it.
                tx.execute(
                    "INSERT INTO memory_clause_evidence(memory_id, revision, clause_ordinal, text_hash, evidence_json)
                     SELECT memory_id, revision + 1, clause_ordinal, text_hash, evidence_json
                       FROM memory_clause_evidence WHERE memory_id = ?1 AND revision = ?2",
                    params![id, current.revision],
                )?;
                // Every change the undo history records advances the
                // revision, as the agent's own edits do: history keeps one
                // row per memory and revision, and a writer holding the old
                // revision must see that its read is stale.
                tx.execute(
                    "UPDATE memories SET importance = ?2, safety_critical = ?3,
                            classified_at = ?4, updated_at = ?4, revision = revision + 1
                      WHERE id = ?1",
                    params![id, next.importance, next.safety_critical, now],
                )?;
                let written = history_snapshot(tx, id)?.ok_or_else(|| {
                    rusqlite::Error::InvalidParameterName(format!(
                        "memory {id} has no history snapshot after its classification"
                    ))
                })?;
                before.push(Some(snapshot));
                after.push(Some(written));
                changed_ids.push(id);
            } else {
                // A first classification that confirms what the row holds
                // changes nothing an undo would restore, so it records no
                // history and keeps the revision.
                tx.execute(
                    "UPDATE memories SET classified_at = ?2, updated_at = ?2 WHERE id = ?1",
                    params![id, now],
                )?;
            }
            applied.applied += 1;
        }
        if !after.is_empty() {
            let key = self.decision_key(run);
            let decision = record_history(
                tx,
                &History {
                    key: &key,
                    project: &self.project,
                    writer: WRITER,
                    operation: OPERATION,
                    reason: KIND,
                    now,
                    before: &before,
                    after: &after,
                    source_ids: &changed_ids,
                    survivor_id: None,
                    evidence: json!([]),
                },
            )?;
            // The journal row is written the way the other history writers
            // write theirs: the receipt first, then the whole decision,
            // writer included, in both snapshot columns, where the undo view
            // reads it.
            tx.execute(
                "INSERT INTO memory_journal(project_path, decision_key, operation, receipt_json, applied_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    self.project,
                    key,
                    OPERATION,
                    json!({"state": "applied", "reason": OPERATION, "memoryIds": changed_ids})
                        .to_string(),
                    now
                ],
            )?;
            tx.execute(
                "UPDATE memory_journal SET before_json = ?2, after_json = ?2 WHERE decision_key = ?1",
                params![key, history_json(&decision)],
            )?;
        }
        Ok(applied)
    }
}

#[cfg(test)]
#[path = "classify_tests.rs"]
mod tests;
