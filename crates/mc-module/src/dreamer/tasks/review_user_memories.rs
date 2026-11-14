//! The `review-user-memories` task, the global review: read the summarizer's
//! pending observations about the person next to the person's live global
//! memories, and let a model decide which recurring traits become global
//! memories, which existing ones to rewrite, archive or file under a
//! category, and which observations it has reviewed. It is the only writer
//! of global memories besides the person, and its run calls no tools.
//!
//! Ported from the 0.49 plugin's review
//! (`packages/plugin/src/features/magic-context/user-memory/`), which wrote
//! whatever its model answered. Here every change passes its own checks
//! first:
//! - a promotion names at least `promotion_threshold` (default 3)
//!   observations this review was shown and that are still pending, and a
//!   user category the review declares that global memories may use; its
//!   text must not repeat a live global memory;
//! - an update, archive or refile names a live global memory this review was
//!   shown, unchanged since it was read, and no other entry of the reply
//!   names it. An update keeps the memory's category, except that a line the
//!   0.50 migration moved without one (`mc:user-unsorted`, shown as
//!   `UNSORTED`) is filed under the category the update names; a refile files
//!   such a line and leaves its text as it is;
//! - a memory the person wrote or edited is shown as `protected`, and is
//!   never updated or archived;
//! - only observations this review was shown are taken out of review.
//!
//! A run is due when enough observations for one promotion wait, or while
//! any global memory is still unsorted. Before it reads, observations that
//! have waited longer than 30 days leave review, as the 0.49 review's
//! candidates decayed. One message carries every filed global memory and,
//! within about 12,000 tokens of text, the unsorted lines and then the
//! oldest observations; the rest waits for the next run.
//!
//! A promoted memory gets no importance: the classifier scores it later.
//! Every write keeps the memory's revision and undo history, under a
//! decision key that names the run.

use std::collections::{HashMap, HashSet};

use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};

use crate::context_migrations::{LIVE, USER_UNSORTED_CATEGORY};
use crate::count::Counter;
use crate::dreamer::run::{TaskInput, TaskReply};
use crate::dreamer::task::{task_prompts, Applied, Batch, Owner, Task, TaskContext};
use crate::memory_levels::{NewRow, OriginProfile};
use crate::memory_profile::Profile;
use crate::memory_writes::{
    archive, clear_derived, get_memory, history_json, history_snapshot, insert_memory,
    normalized_hash, now_ms, record_history, update_content, History, MemoryRow,
};
use crate::summary::fit::Window;

/// The kind memory profiles name.
pub(crate) const KIND: &str = "review-user-memories";
/// Magic Context's frame that the task's message fills with the memories
/// and observations.
const INPUT_FRAME: &str = "dreamer/review-user-memories.input";
/// Who the undo history names as the decider.
const WRITER: &str = "dreamer:review-user-memories";
/// Where the person's own memories are kept.
const LEVEL: &str = "global";
const OWNER: &str = "self";
/// How many observations a promotion needs when the task's settings name no
/// `promotion_threshold`. The review rules Magic Context gives the model ask
/// for the same number.
pub(crate) const PROMOTION_THRESHOLD: usize = 3;
/// How a memory filed under [`USER_UNSORTED_CATEGORY`] is shown to the model.
pub(crate) const UNSORTED: &str = "UNSORTED";
/// How much of a session id an observation shows, as the 0.49 review did.
const SESSION_CHARS: usize = 12;
/// What a promoted memory records as its source: the same value the
/// user-profile lines moved from the 0.49 plugin carry, since this task is
/// the 0.49 review's successor.
const SOURCE_TYPE: &str = "user-review";
/// How long an observation may wait for review before it leaves the queue
/// unreviewed: the 0.49 review's candidate decay. A real trait recurs well
/// within it; a one-off never gathers the observations a promotion needs.
pub(crate) const OBSERVATION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// About how many tokens of memory and observation text one message holds,
/// counted with the module's own counter, as curate counts its parts.
pub(crate) const MESSAGE_TOKENS: u64 = 12_000;
/// Whether a memory row was written or edited by the person, as SQL over
/// `memories m`: the rule curate protects such memories by. The person's own
/// writes record their journal operation as `person_<what>`, and a memory
/// the person created from the apps names `person` as its source.
const PERSON_WRITTEN: &str = "(m.source_type = 'person'
    OR EXISTS(SELECT 1 FROM memory_history h JOIN memory_journal j ON j.decision_key = h.decision_key
               WHERE h.memory_id = m.id AND j.operation LIKE 'person\\_%' ESCAPE '\\'))";

/// A user category the review may file a global memory under.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Category {
    pub id: String,
    pub tag: String,
}

/// The categories `declaration` names that `profile` defines and lets global
/// memories use, in the declaration's order.
pub(crate) fn categories(profile: &Profile, declaration: &Value) -> Vec<Category> {
    let defined = profile.body["categories"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    declaration["categories"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|id| {
            let category = defined.iter().find(|category| category["id"] == id)?;
            let global = category["allowed_levels"]
                .as_array()
                .is_some_and(|levels| levels.iter().any(|level| level == LEVEL));
            if !global {
                return None;
            }
            Some(Category {
                id: id.to_owned(),
                tag: category["tag"].as_str()?.to_owned(),
            })
        })
        .collect()
}

/// The category a reply names by its tag (any case) or its id.
fn resolve<'c>(categories: &'c [Category], named: &str) -> Option<&'c Category> {
    let named = named.trim();
    categories
        .iter()
        .find(|category| category.tag.eq_ignore_ascii_case(named) || category.id == named)
}

/// A live global memory as the review reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Memory {
    pub id: i64,
    /// The profile category id it is filed under.
    pub category_id: String,
    /// The tag it was written under.
    pub tag: String,
    pub content: String,
    pub revision: i64,
    /// Written or edited by the person: the review may not update or archive
    /// it.
    pub protected: bool,
}

impl Memory {
    /// Moved by the 0.50 migration without a category, and not filed since.
    pub(crate) fn unsorted(&self) -> bool {
        self.category_id == USER_UNSORTED_CATEGORY
    }
}

/// The person's live global memories, by id.
pub(crate) fn live_memories(conn: &Connection) -> rusqlite::Result<Vec<Memory>> {
    conn.prepare(&format!(
        "SELECT m.id, m.category, m.origin_category, m.content, m.revision, {PERSON_WRITTEN}
           FROM memories m
          WHERE m.level = ?1 AND m.owner_id = ?2 AND (m.status IS NULL OR m.status IN ('active', 'permanent'))
            AND m.superseded_by_memory_id IS NULL
          ORDER BY m.id"
    ))?
    .query_map(params![LEVEL, OWNER], |row| {
        Ok(Memory {
            id: row.get(0)?,
            category_id: row.get(1)?,
            tag: row.get(2)?,
            content: row.get(3)?,
            revision: row.get(4)?,
            protected: row.get(5)?,
        })
    })?
    .collect()
}

/// A pending observation about the person: a candidate for promotion.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub id: i64,
    pub content: String,
    /// The user category tag the summarizer filed it under. Observations
    /// moved from the 0.49 plugin have none.
    pub proposed: Option<String>,
    pub session: String,
}

/// Every observation no review or person has taken out of review yet,
/// oldest first.
pub(crate) fn pending_candidates(conn: &Connection) -> rusqlite::Result<Vec<Candidate>> {
    conn.prepare(
        "SELECT id, content, proposed_category, session_id FROM memory_observations
          WHERE consumed_at IS NULL ORDER BY created_at, id",
    )?
    .query_map([], |row| {
        Ok(Candidate {
            id: row.get(0)?,
            content: row.get(1)?,
            proposed: row.get(2)?,
            session: row.get(3)?,
        })
    })?
    .collect()
}

/// The tag a memory is shown under: its category's tag in the profile,
/// [`UNSORTED`] for a line the 0.50 migration moved without a category, and
/// otherwise the tag it was written under.
fn shown_tag(memory: &Memory, tags: &HashMap<String, String>) -> String {
    if memory.unsorted() {
        return UNSORTED.to_owned();
    }
    tags.get(&memory.category_id)
        .cloned()
        .unwrap_or_else(|| memory.tag.clone())
}

/// The text that fills the task's input frame: the live memories, each with
/// the tag it is shown under and `protected` after it when the person wrote
/// or edited it, then the pending observations, each in the frame's own
/// shape. The lists keep the 0.49 review's order and its `(none)` for an
/// empty memory list.
pub(crate) fn input(memories: &[(Memory, String)], candidates: &[Candidate]) -> String {
    let memories = if memories.is_empty() {
        "(none)".to_owned()
    } else {
        memories
            .iter()
            .map(|(memory, tag)| {
                let mark = if memory.protected { ", protected" } else { "" };
                format!(
                    "- Memory #{} [{tag}{mark}]: \"{}\"",
                    memory.id, memory.content
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let candidates = candidates
        .iter()
        .map(|candidate| {
            let session: String = candidate.session.chars().take(SESSION_CHARS).collect();
            let proposed = candidate
                .proposed
                .as_deref()
                .map(str::trim)
                .filter(|tag| !tag.is_empty())
                .unwrap_or("none");
            format!(
                "- Candidate #{} [session {session}, proposed {proposed}]: \"{}\"",
                candidate.id, candidate.content
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "### Current Stable User Memories\n{memories}\n\n### Candidate Observations (from recent historian runs)\n{candidates}"
    )
}

/// A new global memory as a reply proposes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Promotion {
    pub content: String,
    /// The category the reply names, as written; empty when it names none.
    pub category: String,
    pub candidate_ids: Vec<i64>,
}

/// A rewrite of a live global memory as a reply proposes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Update {
    pub memory_id: i64,
    pub content: String,
    /// The category the reply names, as written. `None` keeps the memory's.
    pub category: Option<String>,
    pub candidate_ids: Vec<i64>,
}

/// An archive of a live global memory as a reply proposes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Dismissal {
    pub memory_id: i64,
    pub reason: Option<String>,
}

/// A category for an unsorted memory, its text kept, as a reply proposes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Refile {
    pub memory_id: i64,
    /// The category the reply names, as written; empty when it names none.
    pub category: String,
}

/// What a reply proposes. An entry the reply wrote in a shape no change can
/// be read from is kept as why it is dropped, so the rest still apply.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Verdict {
    pub promote: Vec<Result<Promotion, String>>,
    pub update: Vec<Result<Update, String>>,
    pub dismiss: Vec<Result<Dismissal, String>>,
    pub refile: Vec<Result<Refile, String>>,
    /// The observations the reply lists as reviewed, each once.
    pub consume: Vec<Result<i64, String>>,
}

impl Verdict {
    /// How many changes the reply proposes: each entry of the four lists of
    /// memory changes, and each observation it lists as reviewed.
    fn proposals(&self) -> usize {
        self.promote.len()
            + self.update.len()
            + self.dismiss.len()
            + self.refile.len()
            + self.consume.len()
    }

    /// How many entries of the update, dismissal and refile lists name each
    /// memory.
    fn named(&self) -> HashMap<i64, usize> {
        let mut named = HashMap::new();
        let ids = (self.update.iter().flatten().map(|entry| entry.memory_id))
            .chain(self.dismiss.iter().flatten().map(|entry| entry.memory_id))
            .chain(self.refile.iter().flatten().map(|entry| entry.memory_id));
        for id in ids {
            *named.entry(id).or_default() += 1;
        }
        named
    }
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a fixed review-verdict pattern")
}

/// The reply's JSON object: inside a fenced block when the reply has one,
/// otherwise from its first `{` to its last `}`, as the 0.49 review read it.
/// A reply cut short has no closing brace to end on, so it never parses.
fn verdict_object(text: &str) -> Result<Map<String, Value>, String> {
    let found = re(r"(?s)```(?:json)?\s*(.*?)```")
        .captures(text)
        .or_else(|| re(r"(?s)(\{.*\})").captures(text))
        .map(|found| found[1].to_owned())
        .ok_or("the review returned no JSON")?;
    match serde_json::from_str::<Value>(&found) {
        Ok(Value::Object(object)) => Ok(object),
        Ok(_) => Err("the review's JSON is not an object".into()),
        Err(error) => Err(format!("the review returned invalid JSON: {error}")),
    }
}

/// The entries of list `name`; none when the reply leaves it out.
fn list<'v>(object: &'v Map<String, Value>, name: &str) -> Result<&'v [Value], String> {
    match object.get(name) {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(entries)) => Ok(entries),
        Some(_) => Err(format!("the review's {name} is not a list")),
    }
}

/// An entry's text field, trimmed; `None` when it is missing or empty.
fn text(entry: &Value, name: &str) -> Option<String> {
    entry[name]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// An entry's `candidate_ids`, each once, in the reply's order.
fn candidate_ids(entry: &Value) -> Result<Vec<i64>, String> {
    let mut ids = Vec::new();
    for id in entry["candidate_ids"].as_array().into_iter().flatten() {
        let id = id
            .as_i64()
            .ok_or_else(|| format!("candidate id {id} is not a number"))?;
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    Ok(ids)
}

/// A short form of a text for the reasons a run records.
fn excerpt(text: &str) -> String {
    const CHARS: usize = 60;
    let mut short: String = text.chars().take(CHARS).collect();
    if text.chars().count() > CHARS {
        short.push('…');
    }
    short
}

/// Read a reply's verdict. Refused when the reply holds no JSON object, or
/// one of its lists isn't a list: no change can be read from it, and the
/// next model is tried.
pub(crate) fn parse_verdict(reply: &str) -> Result<Verdict, String> {
    let object = verdict_object(reply)?;
    let promote = list(&object, "promote")?
        .iter()
        .enumerate()
        .map(|(index, entry)| -> Result<Promotion, String> {
            let content = text(entry, "content")
                .ok_or_else(|| format!("promotion {} has no text", index + 1))?;
            let candidate_ids = candidate_ids(entry)
                .map_err(|error| format!("promotion \"{}\": {error}", excerpt(&content)))?;
            Ok(Promotion {
                category: text(entry, "category").unwrap_or_default(),
                content,
                candidate_ids,
            })
        })
        .collect();
    let update = list(&object, "update_existing")?
        .iter()
        .enumerate()
        .map(|(index, entry)| -> Result<Update, String> {
            let memory_id = entry["memory_id"]
                .as_i64()
                .ok_or_else(|| format!("update {} names no memory id", index + 1))?;
            let content = text(entry, "content")
                .ok_or_else(|| format!("update of #{memory_id} has no text"))?;
            let candidate_ids =
                candidate_ids(entry).map_err(|error| format!("update of #{memory_id}: {error}"))?;
            Ok(Update {
                memory_id,
                content,
                category: text(entry, "category"),
                candidate_ids,
            })
        })
        .collect();
    let dismiss = list(&object, "dismiss_existing")?
        .iter()
        .enumerate()
        .map(|(index, entry)| -> Result<Dismissal, String> {
            let memory_id = entry["memory_id"]
                .as_i64()
                .ok_or_else(|| format!("dismissal {} names no memory id", index + 1))?;
            Ok(Dismissal {
                memory_id,
                reason: text(entry, "reason"),
            })
        })
        .collect();
    let refile = list(&object, "refile")?
        .iter()
        .enumerate()
        .map(|(index, entry)| -> Result<Refile, String> {
            let memory_id = entry["memory_id"]
                .as_i64()
                .ok_or_else(|| format!("refile {} names no memory id", index + 1))?;
            Ok(Refile {
                memory_id,
                category: text(entry, "category").unwrap_or_default(),
            })
        })
        .collect();
    let mut listed = HashSet::new();
    let consume = list(&object, "consume_candidate_ids")?
        .iter()
        .filter_map(|id| match id.as_i64() {
            Some(id) => listed.insert(id).then_some(Ok(id)),
            None => Some(Err(format!("consumed candidate id {id} is not a number"))),
        })
        .collect();
    Ok(Verdict {
        promote,
        update,
        dismiss,
        refile,
        consume,
    })
}

/// Take every observation that has waited longer than
/// [`OBSERVATION_TTL_MS`] at `now` out of review, unreviewed: it is marked,
/// not deleted. Returns how many left.
pub(crate) fn decay(conn: &Connection, now: i64) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE memory_observations SET consumed_at = ?1
          WHERE consumed_at IS NULL AND created_at < ?2",
        params![now, now - OBSERVATION_TTL_MS],
    )
}

/// What one message shows: every filed memory, then, while the text of all
/// it shows stays within `budget` tokens, the unsorted lines in id order and
/// then the observations oldest first. The first of those that doesn't fit
/// ends the message, so nothing older is passed over; the first one always
/// goes in, however long, so every run moves the queue on.
pub(crate) fn fit(
    memories: &[Memory],
    candidates: &[Candidate],
    counter: Counter,
    budget: u64,
) -> (Vec<Memory>, Vec<Candidate>) {
    let mut used: u64 = memories
        .iter()
        .filter(|memory| !memory.unsorted())
        .map(|memory| counter.count(&memory.content))
        .sum();
    let mut added = false;
    let mut room = |text: &str| {
        let cost = counter.count(text);
        if added && used + cost > budget {
            return false;
        }
        used += cost;
        added = true;
        true
    };
    let mut unsorted = HashSet::new();
    let mut full = false;
    for memory in memories.iter().filter(|memory| memory.unsorted()) {
        if !room(&memory.content) {
            full = true;
            break;
        }
        unsorted.insert(memory.id);
    }
    let mut shown_candidates = Vec::new();
    if !full {
        for candidate in candidates {
            if !room(&candidate.content) {
                break;
            }
            shown_candidates.push(candidate.clone());
        }
    }
    let shown_memories = memories
        .iter()
        .filter(|memory| !memory.unsorted() || unsorted.contains(&memory.id))
        .cloned()
        .collect();
    (shown_memories, shown_candidates)
}

/// The task kind.
pub(crate) struct ReviewUserMemories;

impl ReviewUserMemories {
    /// The run's batch: one message with the person's global memories and
    /// the oldest observations waiting, when enough observations for one
    /// promotion wait or a global memory is still unsorted. Observations that
    /// waited too long leave review first.
    pub(crate) fn plan_batches(
        &self,
        context: &TaskContext<'_>,
    ) -> Result<Vec<ReviewBatch>, String> {
        if *context.owner != Owner::Global {
            return Err(format!("{KIND} works on the person's own memories only"));
        }
        let threshold = context.declaration["settings"]["promotion_threshold"]
            .as_u64()
            .filter(|threshold| *threshold > 0)
            .map_or(PROMOTION_THRESHOLD, |threshold| threshold as usize);
        let (decayed, memories, candidates) = context
            .db
            .with_connection(|conn| {
                Ok::<_, rusqlite::Error>((
                    decay(conn, now_ms())?,
                    live_memories(conn)?,
                    pending_candidates(conn)?,
                ))
            })
            .map_err(|error| format!("reading the person's memories and observations: {error}"))?;
        if decayed > 0 {
            tracing::info!(
                "ck-mc: dreamer: {decayed} observation(s) about the person waited over 30 days and left review"
            );
        }
        if candidates.len() < threshold && !memories.iter().any(Memory::unsorted) {
            return Ok(Vec::new());
        }
        let (memories, candidates) = fit(
            &memories,
            &candidates,
            Counter::for_model(None),
            MESSAGE_TOKENS,
        );
        let profile = context.profile;
        let tags: HashMap<String, String> = profile.body["categories"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|category| {
                Some((
                    category["id"].as_str()?.to_owned(),
                    category["tag"].as_str()?.to_owned(),
                ))
            })
            .collect();
        let shown: Vec<(Memory, String)> = memories
            .iter()
            .map(|memory| (memory.clone(), shown_tag(memory, &tags)))
            .collect();
        let text = input(&shown, &candidates);
        let (system, message) = task_prompts(
            profile,
            context.task_id(),
            "user",
            &[(INPUT_FRAME, text.as_str())],
            &[],
        )?;
        Ok(vec![ReviewBatch {
            system,
            message,
            memories: memories
                .iter()
                .map(|memory| (memory.id, memory.revision))
                .collect(),
            protected: memories
                .iter()
                .filter(|memory| memory.protected)
                .map(|memory| memory.id)
                .collect(),
            unsorted: memories
                .iter()
                .filter(|memory| memory.unsorted())
                .map(|memory| memory.id)
                .collect(),
            candidates: candidates.iter().map(|candidate| candidate.id).collect(),
            categories: categories(profile, context.declaration),
            threshold,
            origin: Some(OriginProfile {
                name: profile.name.clone(),
                version: profile.version.clone(),
                digest: profile.digest.clone(),
            }),
        }])
    }
}

impl Task for ReviewUserMemories {
    fn kind(&self) -> &'static str {
        KIND
    }

    fn global(&self) -> bool {
        true
    }

    fn batches(&self, context: &TaskContext<'_>) -> Result<Vec<Box<dyn Batch>>, String> {
        Ok(self
            .plan_batches(context)?
            .into_iter()
            .map(|batch| Box::new(batch) as Box<dyn Batch>)
            .collect())
    }
}

/// The one message of a review run.
pub(crate) struct ReviewBatch {
    system: String,
    message: String,
    /// Each live global memory the message shows, with the revision read.
    memories: Vec<(i64, i64)>,
    /// The memories shown that the person wrote or edited.
    protected: HashSet<i64>,
    /// The memories shown as unsorted, in id order.
    unsorted: Vec<i64>,
    /// Each observation the message shows.
    candidates: Vec<i64>,
    /// The categories a change may file a memory under.
    categories: Vec<Category>,
    /// How many observations a promotion needs.
    threshold: usize,
    /// The profile the prompts came from, recorded on each new memory.
    origin: Option<OriginProfile>,
}

impl TaskInput for ReviewBatch {
    fn system(&self) -> &str {
        &self.system
    }

    fn prompt(&self, window: Window, output_tokens: u64) -> Option<String> {
        window
            .admits(output_tokens, &self.system, &self.message)
            .then(|| self.message.clone())
    }

    fn accepts(&self, reply: &str) -> Result<(), String> {
        parse_verdict(reply).map(|_| ())
    }
}

impl Batch for ReviewBatch {
    fn apply(&self, tx: &Transaction<'_>, reply: &TaskReply, run: i64) -> Result<Applied, String> {
        let verdict = parse_verdict(&reply.text)?;
        self.write(tx, &verdict, run)
            .map_err(|error| format!("writing the review: {error}"))
    }
}

/// An observation as a batch finds it when it writes.
struct Observed {
    pending: bool,
    session: String,
    project: Option<String>,
}

fn observed(tx: &Transaction<'_>, id: i64) -> rusqlite::Result<Option<Observed>> {
    tx.query_row(
        "SELECT consumed_at IS NULL, session_id, project_id FROM memory_observations WHERE id = ?1",
        params![id],
        |row| {
            Ok(Observed {
                pending: row.get(0)?,
                session: row.get(1)?,
                project: row.get(2)?,
            })
        },
    )
    .optional()
}

/// Another live global memory with this text, in any category.
fn live_duplicate(tx: &Transaction<'_>, hash: &str, except: i64) -> rusqlite::Result<Option<i64>> {
    tx.query_row(
        &format!(
            "SELECT id FROM memories
              WHERE level = ?1 AND owner_id = ?2 AND normalized_hash = ?3 AND id != ?4 AND {LIVE}
              ORDER BY id LIMIT 1"
        ),
        params![LEVEL, OWNER, hash, except],
        |row| row.get(0),
    )
    .optional()
}

/// What a batch has written so far, and the decisions it recorded.
struct Writes<'a> {
    tx: &'a Transaction<'a>,
    run: i64,
    now: i64,
    applied: Applied,
    /// Decisions recorded, which number the next one's key.
    decisions: usize,
    /// How many update, dismissal and refile entries name each memory.
    named: HashMap<i64, usize>,
    /// Observations to take out of review, each with whether the reply
    /// listed it itself.
    consumed: Vec<(i64, bool)>,
}

impl Writes<'_> {
    fn drop(&mut self, reason: String) {
        self.applied.dropped.push(reason);
    }

    /// Record one written change in the undo history and the journal, under
    /// a decision key naming the run.
    fn record(
        &mut self,
        operation: &str,
        before: Option<Value>,
        after: Value,
        id: i64,
        evidence: Value,
    ) -> rusqlite::Result<()> {
        let key = format!("dream-run:{}:{KIND}:{}", self.run, self.decisions);
        self.decisions += 1;
        let decision = record_history(
            self.tx,
            &History {
                key: &key,
                project: OWNER,
                writer: WRITER,
                operation,
                reason: KIND,
                now: self.now,
                before: &[before],
                after: &[Some(after)],
                source_ids: &[id],
                survivor_id: None,
                evidence,
            },
        )?;
        // The journal row is written the way the other history writers
        // write theirs: the receipt first, then the whole decision, writer
        // included, in both snapshot columns, where the undo view reads it.
        self.tx.execute(
            "INSERT INTO memory_journal(project_path, decision_key, operation, receipt_json, applied_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                OWNER,
                key,
                operation,
                json!({"state": "applied", "reason": operation, "memoryIds": [id]}).to_string(),
                self.now
            ],
        )?;
        self.tx.execute(
            "UPDATE memory_journal SET before_json = ?2, after_json = ?2 WHERE decision_key = ?1",
            params![key, history_json(&decision)],
        )?;
        self.applied.applied += 1;
        Ok(())
    }

    /// Take `id` out of review once the batch is written.
    fn consume(&mut self, id: i64, listed: bool) {
        match self.consumed.iter_mut().find(|(known, _)| *known == id) {
            Some((_, was_listed)) => *was_listed |= listed,
            None => self.consumed.push((id, listed)),
        }
    }
}

impl ReviewBatch {
    /// Write what `verdict` proposes and passes its checks, in `tx`: the
    /// promotions, then the updates, the archives and the refiles, then the
    /// observations taken out of review. An observation behind a written
    /// promotion or update leaves review even when the reply forgot to list
    /// it, as in the 0.49 review, so the next review doesn't promote the same
    /// trait again. An unsorted memory the message showed that is still
    /// unsorted afterwards is listed as left unsorted; it stays as it is.
    fn write(
        &self,
        tx: &Transaction<'_>,
        verdict: &Verdict,
        run: i64,
    ) -> rusqlite::Result<Applied> {
        let mut writes = Writes {
            tx,
            run,
            now: now_ms(),
            applied: Applied {
                proposed: verdict.proposals(),
                ..Applied::default()
            },
            decisions: 0,
            named: verdict.named(),
            consumed: Vec::new(),
        };
        // Every observation the batch showed, as it is before this reply
        // takes any out of review: one observation may back two promotions,
        // one per category.
        let mut observations = HashMap::new();
        for id in &self.candidates {
            if let Some(found) = observed(tx, *id)? {
                observations.insert(*id, found);
            }
        }
        for promotion in &verdict.promote {
            match promotion {
                Ok(promotion) => self.promote(&mut writes, &observations, promotion)?,
                Err(reason) => writes.drop(reason.clone()),
            }
        }
        for update in &verdict.update {
            match update {
                Ok(update) => self.update(&mut writes, &observations, update)?,
                Err(reason) => writes.drop(reason.clone()),
            }
        }
        for dismissal in &verdict.dismiss {
            match dismissal {
                Ok(dismissal) => self.dismiss(&mut writes, dismissal)?,
                Err(reason) => writes.drop(reason.clone()),
            }
        }
        for refile in &verdict.refile {
            match refile {
                Ok(refile) => self.refile(&mut writes, refile)?,
                Err(reason) => writes.drop(reason.clone()),
            }
        }
        for id in &verdict.consume {
            match id {
                Ok(id) if !self.candidates.contains(id) => writes.drop(format!(
                    "candidate #{id} can't be consumed: this review was not shown it"
                )),
                Ok(id) if !observations.get(id).is_some_and(|found| found.pending) => {
                    writes.drop(format!(
                        "candidate #{id} can't be consumed: it was already taken out of review"
                    ))
                }
                Ok(id) => writes.consume(*id, true),
                Err(reason) => writes.drop(reason.clone()),
            }
        }
        for (id, listed) in std::mem::take(&mut writes.consumed) {
            let taken = tx.execute(
                "UPDATE memory_observations SET consumed_at = ?2 WHERE id = ?1 AND consumed_at IS NULL",
                params![id, writes.now],
            )?;
            if listed && taken == 1 {
                writes.applied.applied += 1;
            }
        }
        for id in &self.unsorted {
            let still: bool = tx
                .query_row(
                    &format!(
                        "SELECT category = ?2 AND {LIVE} AND superseded_by_memory_id IS NULL
                           FROM memories WHERE id = ?1"
                    ),
                    params![id, USER_UNSORTED_CATEGORY],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or(false);
            if still {
                writes.drop(format!("memory #{id} left unsorted"));
            }
        }
        Ok(writes.applied)
    }

    /// The memory `id` names, when it is a live global memory this batch
    /// showed and nothing changed it since. Otherwise the entry is dropped
    /// with why.
    fn fresh(
        &self,
        writes: &mut Writes<'_>,
        id: i64,
        about: &str,
    ) -> rusqlite::Result<Option<MemoryRow>> {
        let Some(&(_, read)) = self.memories.iter().find(|(shown, _)| *shown == id) else {
            writes.drop(format!(
                "{about}: #{id} is not a live global memory this review was shown"
            ));
            return Ok(None);
        };
        if writes.named.get(&id).copied().unwrap_or(0) > 1 {
            writes.drop(format!(
                "{about}: #{id} is named by more than one entry of the reply"
            ));
            return Ok(None);
        }
        let memory = get_memory(writes.tx, id)?.filter(|memory| {
            memory.level == LEVEL && memory.owner_id == OWNER && memory.is_mutable()
        });
        let Some(memory) = memory else {
            writes.drop(format!("{about}: it is no longer a live global memory"));
            return Ok(None);
        };
        if memory.revision != read {
            writes.drop(format!(
                "{about}: it changed after the review read it (revision {read}, now {})",
                memory.revision
            ));
            return Ok(None);
        }
        Ok(Some(memory))
    }

    fn promote(
        &self,
        writes: &mut Writes<'_>,
        observations: &HashMap<i64, Observed>,
        promotion: &Promotion,
    ) -> rusqlite::Result<()> {
        let tx = writes.tx;
        let about = format!("promotion \"{}\"", excerpt(&promotion.content));
        let Some(category) = resolve(&self.categories, &promotion.category) else {
            writes.drop(if promotion.category.is_empty() {
                format!("{about} names no category")
            } else {
                format!(
                    "{about}: {} is not a user category this review may file a global memory under",
                    promotion.category
                )
            });
            return Ok(());
        };
        for id in &promotion.candidate_ids {
            if !self.candidates.contains(id) {
                writes.drop(format!(
                    "{about} names candidate #{id}, which this review was not shown"
                ));
                return Ok(());
            }
            if !observations.get(id).is_some_and(|found| found.pending) {
                writes.drop(format!(
                    "{about} names candidate #{id}, which was already taken out of review"
                ));
                return Ok(());
            }
        }
        if promotion.candidate_ids.len() < self.threshold {
            writes.drop(format!(
                "{about} names {} observation(s); a promotion needs {}",
                promotion.candidate_ids.len(),
                self.threshold
            ));
            return Ok(());
        }
        let hash = normalized_hash(&promotion.content);
        if let Some(existing) = live_duplicate(tx, &hash, 0)? {
            writes.drop(format!("{about} repeats live global memory #{existing}"));
            return Ok(());
        }
        let first = &observations[&promotion.candidate_ids[0]];
        let row = NewRow {
            level: LEVEL.into(),
            owner_id: OWNER.into(),
            category_id: category.id.clone(),
            origin_profile: self.origin.clone(),
            source_ordinals_json: None,
        };
        let memory = insert_memory(
            tx,
            &row,
            first.project.as_deref().unwrap_or(""),
            &category.tag,
            &promotion.content,
            &first.session,
            SOURCE_TYPE,
            None,
        )?;
        // The writer's default importance is no judgment of the memory: it
        // stays unscored until the classifier scores it. The ids of the
        // observations behind it go in its metadata under the key the
        // user-profile lines moved from 0.49 use for theirs.
        tx.execute(
            "UPDATE memories SET importance = NULL, metadata_json = ?2 WHERE id = ?1",
            params![
                memory.id,
                json!({"source_candidate_ids": promotion.candidate_ids}).to_string()
            ],
        )?;
        let after = written(tx, memory.id)?;
        writes.record(
            "promote",
            None,
            after,
            memory.id,
            json!({"candidateIds": promotion.candidate_ids}),
        )?;
        for id in &promotion.candidate_ids {
            writes.consume(*id, false);
        }
        Ok(())
    }

    fn update(
        &self,
        writes: &mut Writes<'_>,
        observations: &HashMap<i64, Observed>,
        update: &Update,
    ) -> rusqlite::Result<()> {
        let tx = writes.tx;
        let id = update.memory_id;
        let about = format!("update of memory #{id}");
        let Some(memory) = self.fresh(writes, id, &about)? else {
            return Ok(());
        };
        if self.protected.contains(&id) {
            writes.drop(format!(
                "{about}: the person wrote or edited it, so the review may not change it"
            ));
            return Ok(());
        }
        // A filed memory keeps its category; a line moved without one is
        // filed where the update says.
        let refile = match &update.category {
            None => None,
            Some(named) => match resolve(&self.categories, named) {
                None => {
                    writes.drop(format!(
                        "{about}: {named} is not a user category this review may file a global memory under"
                    ));
                    return Ok(());
                }
                Some(category) if memory.category_id == USER_UNSORTED_CATEGORY => Some(category),
                Some(category) if category.id == memory.category_id => None,
                Some(category) => {
                    writes.drop(format!(
                        "{about} files it under {}, but an update keeps the category a memory is filed under ({})",
                        category.tag, memory.category
                    ));
                    return Ok(());
                }
            },
        };
        let rewritten = update.content != memory.content;
        if !rewritten && refile.is_none() {
            writes.drop(format!("{about} changes nothing"));
            return Ok(());
        }
        let hash = normalized_hash(&update.content);
        if let Some(existing) = live_duplicate(tx, &hash, id)? {
            writes.drop(format!("{about} repeats live global memory #{existing}"));
            return Ok(());
        }
        let Some(before) = history_snapshot(tx, id)? else {
            writes.drop(format!(
                "{about}: the memory holds a row the undo history can't record"
            ));
            return Ok(());
        };
        // Every change the undo history records advances the revision.
        tx.execute(
            "UPDATE memories SET revision = revision + 1 WHERE id = ?1",
            params![id],
        )?;
        if rewritten {
            update_content(tx, id, &update.content, &hash)?;
        } else {
            carry_evidence(tx, id, memory.revision)?;
        }
        if let Some(category) = refile {
            tx.execute(
                "UPDATE memories SET category = ?2, origin_category = ?3, updated_at = ?4 WHERE id = ?1",
                params![id, category.id, category.tag, writes.now],
            )?;
        }
        let after = written(tx, id)?;
        writes.record(
            "update",
            Some(before),
            after,
            id,
            json!({"candidateIds": update.candidate_ids}),
        )?;
        for candidate in &update.candidate_ids {
            if !self.candidates.contains(candidate) {
                writes.drop(format!(
                    "{about} names candidate #{candidate}, which this review was not shown; it is not taken out of review"
                ));
            } else if observations
                .get(candidate)
                .is_some_and(|found| found.pending)
            {
                writes.consume(*candidate, false);
            }
        }
        Ok(())
    }

    fn dismiss(&self, writes: &mut Writes<'_>, dismissal: &Dismissal) -> rusqlite::Result<()> {
        let tx = writes.tx;
        let id = dismissal.memory_id;
        let about = format!("dismissal of memory #{id}");
        let Some(memory) = self.fresh(writes, id, &about)? else {
            return Ok(());
        };
        if self.protected.contains(&id) {
            writes.drop(format!(
                "{about}: the person wrote or edited it, so the review may not archive it"
            ));
            return Ok(());
        }
        let Some(before) = history_snapshot(tx, id)? else {
            writes.drop(format!(
                "{about}: the memory holds a row the undo history can't record"
            ));
            return Ok(());
        };
        tx.execute(
            "UPDATE memories SET revision = revision + 1 WHERE id = ?1",
            params![id],
        )?;
        archive(tx, &memory, dismissal.reason.as_deref())?;
        clear_derived(tx, id)?;
        let after = written(tx, id)?;
        writes.record(
            "archive",
            Some(before),
            after,
            id,
            json!({"reason": dismissal.reason}),
        )?;
        Ok(())
    }

    /// File an unsorted memory under the category the reply names, its text
    /// as it is. The person's own lines may be filed too: filing changes
    /// nothing they wrote.
    fn refile(&self, writes: &mut Writes<'_>, refile: &Refile) -> rusqlite::Result<()> {
        let tx = writes.tx;
        let id = refile.memory_id;
        let about = format!("refile of memory #{id}");
        let Some(memory) = self.fresh(writes, id, &about)? else {
            return Ok(());
        };
        if memory.category_id != USER_UNSORTED_CATEGORY {
            writes.drop(format!(
                "{about}: it is not {UNSORTED}, so it keeps its category ({})",
                memory.category
            ));
            return Ok(());
        }
        let Some(category) = resolve(&self.categories, &refile.category) else {
            writes.drop(if refile.category.is_empty() {
                format!("{about} names no category")
            } else {
                format!(
                    "{about}: {} is not a user category this review may file a global memory under",
                    refile.category
                )
            });
            return Ok(());
        };
        let Some(before) = history_snapshot(tx, id)? else {
            writes.drop(format!(
                "{about}: the memory holds a row the undo history can't record"
            ));
            return Ok(());
        };
        tx.execute(
            "UPDATE memories SET revision = revision + 1, category = ?2, origin_category = ?3, updated_at = ?4
              WHERE id = ?1",
            params![id, category.id, category.tag, writes.now],
        )?;
        carry_evidence(tx, id, memory.revision)?;
        let after = written(tx, id)?;
        writes.record("refile", Some(before), after, id, json!([]))?;
        Ok(())
    }
}

/// Clause evidence is kept per revision. When a write keeps a memory's text
/// and advances its revision past `revision`, the evidence for the text moves
/// to the new revision with it.
fn carry_evidence(tx: &Transaction<'_>, id: i64, revision: i64) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT OR IGNORE INTO memory_clause_evidence(memory_id, revision, clause_ordinal, text_hash, evidence_json)
         SELECT memory_id, revision + 1, clause_ordinal, text_hash, evidence_json
           FROM memory_clause_evidence WHERE memory_id = ?1 AND revision = ?2",
        params![id, revision],
    )
    .map(drop)
}

/// The history snapshot of a row this batch just wrote. Its values are ones
/// history records, so a missing snapshot is a fault that fails the batch.
fn written(tx: &Transaction<'_>, id: i64) -> rusqlite::Result<Value> {
    history_snapshot(tx, id)?.ok_or_else(|| {
        rusqlite::Error::InvalidParameterName(format!(
            "memory {id} has no history snapshot after the review wrote it"
        ))
    })
}

#[cfg(test)]
#[path = "review_user_memories_tests.rs"]
mod tests;
