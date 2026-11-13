//! The `curate` task: keep each category of a project's memories small and
//! free of repeats. A model reads one part of a category at a time and
//! answers with one `<curate>` list of changes: merge memories that state
//! the same fact, shorten a long memory to the fact it states, split one
//! that states several, and archive what adds nothing (a duplicate of
//! another memory or of the project documents, a one-off detail, or a story
//! that states no rule).
//!
//! One run covers every category the task declares, in the profile's
//! category order. Each category is split into parts of at most
//! [`PART_MEMORIES`] memories or about [`PART_TOKENS`] tokens of memory text,
//! and each part is one message. A part also shows the project documents
//! every session gets, the project memories the head shows every session,
//! and the memories of the same category outside the part whose text is
//! close to one inside it, so the model can find duplicates of all three.
//!
//! The model proposes and the batch decides. Each change is checked on its
//! own and dropped with its reason when a check fails; the others still
//! apply. A protected memory (safety-critical, permanent, a policy, or one
//! the person wrote or edited) is never changed. A change must keep every
//! path, code name and number its memories state, which the summarizer's
//! own deterministic gate checks ([`dropped_token`]). Every write records
//! an undo-history decision named after the run, one per change, so the
//! person can undo one change or the whole run.
//!
//! A run that stops early (its token budget, a failed model) keeps what it
//! applied: each applied part moves the schedule's `watermark_json` to the
//! part after it, and the next run resumes there.
//!
//! Ported from the 0.49.x Rust module kept for reference in `crates_old/`
//! (`mc-module/src/dream_tasks/curate.rs` and the merge in
//! `mc-module/src/memory_actions.rs`), where curate changed memories through
//! the memory tool instead of one checked list.

use std::collections::{BTreeSet, HashMap, HashSet};

use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};

use crate::count::Counter;
use crate::dreamer::run::{TaskInput, TaskReply};
use crate::dreamer::task::{task_prompts, Applied, Batch, Owner, Task, TaskContext};
use crate::memory_levels::{created, CreateKind, NewRow, Placer};
use crate::memory_profile::{Profile, FRAMES};
use crate::memory_writes::{
    archive, clear_derived, get_memory, history_json, history_snapshot, insert_memory,
    normalized_hash, now_ms, record_history, update_content, History, MemoryRow,
};
use crate::summary::fit::Window;
use crate::summary::two_pass::gates::dropped_token;

/// The kind memory profiles name.
pub(crate) const KIND: &str = "curate";
/// Magic Context's frame that the task's message fills.
pub(crate) const INPUT_FRAME: &str = "dreamer/curate.input";
/// Who the undo history names as the decider.
const WRITER: &str = "dreamer:curate";
/// At most this many memories go in one part.
pub(crate) const PART_MEMORIES: usize = 60;
/// A part holds about this many tokens of memory text at most. A memory
/// longer than this on its own is a part by itself.
pub(crate) const PART_TOKENS: u64 = 12_000;
/// Each memory of a part brings at most this many similar memories along.
const SIMILAR_EACH: usize = 3;
/// A part shows at most this many similar memories.
const SIMILAR_MAX: usize = 20;
/// Two memories' word sets this alike, or more, count as close text.
const SIMILAR_JACCARD: f64 = 0.6;
/// A quote from the project documents shorter than this can't show that a
/// memory repeats them.
const MIN_QUOTE_CHARS: usize = 20;
/// The reasons an archive may give.
const ARCHIVE_REASONS: [&str; 3] = ["duplicate", "one-off", "lesson"];

/// One category the task curates: its profile id and the tag its
/// definition names it by in the prompts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Category {
    pub id: String,
    pub tag: String,
}

/// The fact categories of `profile` that `declaration` lets the task curate,
/// in the profile's order.
pub(crate) fn categories(profile: &Profile, declaration: &Value) -> Vec<Category> {
    let declared = strings(&declaration["categories"]);
    let mut found: Vec<(i64, Category)> = profile.body["categories"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|category| category["stream"] == "fact")
        .filter_map(|category| {
            let id = category["id"].as_str()?;
            declared.iter().any(|name| name == id).then(|| {
                (
                    category["render_order"].as_i64().unwrap_or(i64::MAX),
                    Category {
                        id: id.to_owned(),
                        tag: category["tag"].as_str().unwrap_or(id).to_owned(),
                    },
                )
            })
        })
        .collect();
    found.sort_by_key(|(order, _)| *order);
    found.into_iter().map(|(_, category)| category).collect()
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

/// One live memory of a category as the task reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Memory {
    pub id: i64,
    pub content: String,
    pub revision: i64,
    /// Safety-critical, permanent, a policy, or written or edited by the
    /// person: no change of any kind may touch it.
    pub protected: bool,
}

/// Whether a memory row is protected, as SQL over `memories m`. The
/// person's own writes record their journal operation as `person_<what>`,
/// and a memory the person created from the apps names `person` as its
/// source.
const PROTECTED: &str = "(COALESCE(m.safety_critical, 0) = 1 OR m.status = 'permanent'
    OR m.authority = 'policy' OR m.source_type = 'person'
    OR EXISTS(SELECT 1 FROM memory_history h JOIN memory_journal j ON j.decision_key = h.decision_key
               WHERE h.memory_id = m.id AND j.operation LIKE 'person\\_%' ESCAPE '\\'))";

/// The live memories `project` keeps in `category` at `now`, by id.
pub(crate) fn live_memories(
    conn: &Connection,
    project: &str,
    category: &str,
    now: i64,
) -> rusqlite::Result<Vec<Memory>> {
    conn.prepare(&format!(
        "SELECT m.id, m.content, m.revision, {PROTECTED}
           FROM memories m
          WHERE m.level = 'project' AND m.owner_id = ?1 AND m.category = ?2
            AND COALESCE(m.status, 'active') IN ('active', 'permanent')
            AND m.superseded_by_memory_id IS NULL
            AND (m.expires_at IS NULL OR m.expires_at > ?3)
          ORDER BY m.id"
    ))?
    .query_map(params![project, category, now], |row| {
        Ok(Memory {
            id: row.get(0)?,
            content: row.get(1)?,
            revision: row.get(2)?,
            protected: row.get(3)?,
        })
    })?
    .collect()
}

/// A memory every session of the project already sees.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Shown {
    pub id: i64,
    /// The tag of its category, as the prompts name categories.
    pub tag: String,
    pub content: String,
}

/// The project memories the history head shows every session of `project`
/// at `now`: the head's own choice ([`crate::head_memories::choose`]) among
/// the project's and the person's live memories, at the default memory and
/// profile budgets (a run has no session whose settings it could read), and
/// of that choice, the project's rows. Listed in the profile's category
/// order, then by id.
pub(crate) fn shown_memories(
    conn: &Connection,
    project: &str,
    profile: &Profile,
    now: i64,
) -> rusqlite::Result<Vec<Shown>> {
    let settings = crate::pass::Settings::default();
    let rows = crate::head_memories::read_rows(conn, Some(project), None, now)?;
    let chosen: HashSet<i64> = crate::head_memories::choose(
        &rows,
        None,
        &crate::head_memories::decay_classes(profile),
        Counter::for_model(None),
        &crate::head_memories::budget(
            settings.memory_budget_tokens,
            settings.profile_budget_tokens,
        ),
        now,
    )
    .ids
    .into_iter()
    .collect();
    let order: HashMap<String, (i64, String)> = profile.body["categories"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|category| {
            Some((
                category["id"].as_str()?.to_owned(),
                (
                    category["render_order"].as_i64().unwrap_or(i64::MAX),
                    category["tag"].as_str()?.to_owned(),
                ),
            ))
        })
        .collect();
    let mut shown: Vec<(i64, Shown)> = rows
        .into_iter()
        .filter(|row| row.level == "project" && chosen.contains(&row.id))
        .map(|row| {
            let (rank, tag) = order
                .get(&row.category)
                .cloned()
                .unwrap_or((i64::MAX, row.tag.clone()));
            (
                rank,
                Shown {
                    id: row.id,
                    tag,
                    content: row.content,
                },
            )
        })
        .collect();
    shown.sort_by_key(|(rank, memory)| (*rank, memory.id));
    Ok(shown.into_iter().map(|(_, memory)| memory).collect())
}

/// The project documents block the head shows every session of the
/// project in `root`, without its `<project-docs>` wrapper: the input frame
/// wraps it in its own. Empty when the project has none.
pub(crate) fn project_documents(root: &str) -> String {
    let block = crate::project_docs::read_project_docs_canonical(root).rendered_block;
    block
        .strip_prefix("<project-docs>\n")
        .and_then(|inner| inner.strip_suffix("\n</project-docs>"))
        .unwrap_or(&block)
        .to_owned()
}

/// `pool` in parts: each at most [`PART_MEMORIES`] memories and, unless one
/// memory alone is longer, at most [`PART_TOKENS`] tokens of memory text.
pub(crate) fn parts(pool: &[Memory], counter: Counter) -> Vec<Vec<Memory>> {
    let mut parts: Vec<Vec<Memory>> = Vec::new();
    let mut tokens = 0;
    for memory in pool {
        let cost = counter.count(&memory.content);
        let full = parts.last().is_none_or(|part| {
            part.len() >= PART_MEMORIES || (!part.is_empty() && tokens + cost > PART_TOKENS)
        });
        if full {
            parts.push(Vec::new());
            tokens = 0;
        }
        tokens += cost;
        parts.last_mut().expect("a part was just made").push(memory.clone());
    }
    parts
}

/// A memory's words for comparing texts: lowercased, without backticks or
/// punctuation.
fn words(text: &str) -> BTreeSet<String> {
    text.to_lowercase()
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

/// How alike two word sets are: shared words over all words.
fn jaccard(left: &BTreeSet<String>, right: &BTreeSet<String>) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let shared = left.intersection(right).count();
    shared as f64 / (left.len() + right.len() - shared) as f64
}

/// The memories of `pool` outside `part` whose text is close to one inside
/// it: for each memory of the part in order, up to [`SIMILAR_EACH`] of the
/// closest, the same text first, at most [`SIMILAR_MAX`] in all.
pub(crate) fn similar<'a>(part: &[Memory], pool: &'a [Memory]) -> Vec<&'a Memory> {
    let inside: HashSet<i64> = part.iter().map(|memory| memory.id).collect();
    let outside: Vec<(&Memory, BTreeSet<String>)> = pool
        .iter()
        .filter(|memory| !inside.contains(&memory.id))
        .map(|memory| (memory, words(&memory.content)))
        .collect();
    let mut found: Vec<&Memory> = Vec::new();
    for memory in part {
        let own = words(&memory.content);
        let hash = normalized_hash(&memory.content);
        let mut close: Vec<(f64, &Memory)> = outside
            .iter()
            .filter_map(|(other, other_words)| {
                let score = if normalized_hash(&other.content) == hash {
                    f64::INFINITY
                } else {
                    jaccard(&own, other_words)
                };
                (score >= SIMILAR_JACCARD).then_some((score, *other))
            })
            .collect();
        close.sort_by(|(left, left_memory), (right, right_memory)| {
            right
                .total_cmp(left)
                .then(left_memory.id.cmp(&right_memory.id))
        });
        for (_, other) in close.into_iter().take(SIMILAR_EACH) {
            if found.len() == SIMILAR_MAX {
                return found;
            }
            if !found.iter().any(|seen| seen.id == other.id) {
                found.push(other);
            }
        }
    }
    found
}

/// The line of the input frame right after the line `open`: a block's
/// standing instruction.
fn frame_line_after(open: &str) -> &'static str {
    let (_, frame) = FRAMES
        .iter()
        .find(|(name, _)| *name == INPUT_FRAME)
        .expect("the curate input frame is bundled");
    frame
        .lines()
        .skip_while(|line| *line != open)
        .nth(1)
        .unwrap_or_default()
}

/// The text that fills the task's input frame, in the frame's own layout: the
/// project documents, the memories every session sees, the similar
/// memories, then the part's memories. A block with no lines is left out.
pub(crate) fn input(
    docs: &str,
    shown: &[Shown],
    similar: &[&Memory],
    part: (usize, usize),
    memories: &[Memory],
) -> String {
    let mut blocks = Vec::new();
    if !docs.is_empty() {
        blocks.push(format!(
            "<project-documents>\n{docs}\n</project-documents>"
        ));
    }
    if !shown.is_empty() {
        let lines: Vec<String> = shown
            .iter()
            .map(|memory| format!("[{}] {}: {}", memory.id, memory.tag, memory.content))
            .collect();
        blocks.push(format!(
            "<always-shown>\n{}\n{}\n</always-shown>",
            frame_line_after("<always-shown>"),
            lines.join("\n")
        ));
    }
    if !similar.is_empty() {
        let lines: Vec<String> = similar
            .iter()
            .map(|memory| format!("[{}] {}", memory.id, memory.content))
            .collect();
        blocks.push(format!(
            "<similar>\n{}\n{}\n</similar>",
            frame_line_after("<similar>"),
            lines.join("\n")
        ));
    }
    let entries: Vec<String> = memories
        .iter()
        .map(|memory| {
            format!(
                "[{}]{}\n{}",
                memory.id,
                if memory.protected { " protected" } else { "" },
                memory.content
            )
        })
        .collect();
    blocks.push(format!(
        "<memories part=\"{} of {}\">\n{}\n</memories>",
        part.0,
        part.1,
        entries.join("\n\n")
    ));
    blocks.join("\n\n")
}

/// One change a reply's `<curate>` list proposes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Change {
    /// Replace memories that state the same fact with one memory.
    Merge { ids: Vec<i64>, text: String },
    /// Replace a memory's text with a shorter one.
    Shorten { id: i64, text: String },
    /// Replace a memory with one memory per fact it states.
    Split { id: i64, parts: Vec<String> },
    /// Archive a memory that adds nothing, for `reason`: `duplicate` (of a
    /// memory, `of`, or of a line of the project documents, `quote`),
    /// `one-off` or `lesson`, each with `why`.
    Archive {
        id: i64,
        reason: String,
        of: Option<i64>,
        quote: Option<String>,
        why: Option<String>,
    },
}

impl Change {
    /// The action a task declaration names it by.
    pub(crate) fn action(&self) -> &'static str {
        match self {
            Change::Merge { .. } => "merge",
            Change::Shorten { .. } => "shorten",
            Change::Split { .. } => "split",
            Change::Archive { .. } => "archive",
        }
    }

    /// The memories it changes (an archive's `of` is not changed).
    pub(crate) fn ids(&self) -> Vec<i64> {
        match self {
            Change::Merge { ids, .. } => ids.clone(),
            Change::Shorten { id, .. } | Change::Split { id, .. } | Change::Archive { id, .. } => {
                vec![*id]
            }
        }
    }

    /// How a dropped change is named in the run's record: `merge 12,15`.
    fn label(&self) -> String {
        let ids: Vec<String> = self.ids().iter().map(i64::to_string).collect();
        format!("{} {}", self.action(), ids.join(","))
    }
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a fixed curate-list pattern")
}

/// The text of an XML value: the five predefined entities written out.
fn unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// An element's attributes, by name, unescaped.
fn attributes(text: &str) -> HashMap<String, String> {
    re(r#"([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')"#)
        .captures_iter(text)
        .map(|found| {
            let value = found.get(2).or(found.get(3)).map_or("", |value| value.as_str());
            (found[1].to_ascii_lowercase(), unescape(value))
        })
        .collect()
}

/// The text inside a reply's last complete `<curate>` list. A model that
/// shows an example list before its answer is read by its answer.
fn list_body(text: &str) -> Result<&str, String> {
    let lower = text.to_ascii_lowercase();
    let open = re(r#"(?i)<curate\b((?:[^>"']|"[^"]*"|'[^']*')*)>"#);
    let Some(close) = re(r"(?i)</curate\s*>").find_iter(text).last() else {
        if open
            .captures_iter(text)
            .any(|found| found[1].trim_end().ends_with('/'))
        {
            return Ok("");
        }
        return Err(if lower.contains("<curate") {
            "curate list missing closing root tag".into()
        } else {
            "curate list missing complete root element".into()
        });
    };
    let before = &text[..close.start()];
    let Some(start) = open
        .find_iter(before)
        .filter(|found| !found.as_str().trim_end_matches('>').trim_end().ends_with('/'))
        .last()
    else {
        return Err("curate list missing its opening root tag".into());
    };
    Ok(&before[start.end()..])
}

/// The tag starting at the beginning of `text`: its name in lowercase, its
/// attribute text, whether it closes itself, and its length.
fn open_tag(text: &str) -> Option<(String, &str, bool, usize)> {
    let found = re(r#"^<([A-Za-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>"#).captures(text)?;
    let attributes = found.get(2).map_or("", |value| value.as_str());
    let closes = attributes.trim_end().ends_with('/');
    Some((
        found[1].to_ascii_lowercase(),
        attributes.trim_end().trim_end_matches('/'),
        closes,
        found[0].len(),
    ))
}

/// Where the element `name`'s closing tag starts and ends in `text`.
fn closing(text: &str, name: &str) -> Option<(usize, usize)> {
    re(&format!(r"(?i)</{name}\s*>"))
        .find(text)
        .map(|found| (found.start(), found.end()))
}

fn id(attributes: &HashMap<String, String>, name: &str, element: &str) -> Result<i64, String> {
    let value = attributes
        .get(name)
        .ok_or_else(|| format!("<{element}> names no {name}"))?;
    value
        .trim()
        .parse()
        .map_err(|_| format!("<{element}> {name}=\"{value}\" is not a memory id"))
}

fn text_of(inner: &str, element: &str) -> Result<String, String> {
    let text = unescape(inner.trim());
    if text.is_empty() {
        return Err(format!("<{element}> has no text"));
    }
    Ok(text)
}

/// One element of the list: the change, or why it can't be read.
fn entry(name: &str, attributes: &HashMap<String, String>, inner: &str) -> Result<Change, String> {
    match name {
        "merge" => {
            let listed = attributes
                .get("ids")
                .ok_or("<merge> names no ids")?;
            let ids = listed
                .split(|c: char| c == ',' || c.is_whitespace())
                .filter(|id| !id.is_empty())
                .map(|id| {
                    id.parse()
                        .map_err(|_| format!("<merge> ids=\"{listed}\" are not memory ids"))
                })
                .collect::<Result<Vec<i64>, String>>()?;
            Ok(Change::Merge {
                ids,
                text: text_of(inner, name)?,
            })
        }
        "shorten" => Ok(Change::Shorten {
            id: id(attributes, "id", name)?,
            text: text_of(inner, name)?,
        }),
        "split" => {
            let id = id(attributes, "id", name)?;
            let parts = re(r"(?is)<part\b[^>]*>(.*?)</part\s*>")
                .captures_iter(inner)
                .map(|found| text_of(&found[1], "part"))
                .collect::<Result<Vec<String>, String>>()?;
            Ok(Change::Split { id, parts })
        }
        "archive" => {
            let of = match attributes.get("of") {
                Some(_) => Some(id(attributes, "of", name)?),
                None => None,
            };
            let why = attributes
                .get("why")
                .map(|why| why.trim().to_owned())
                .or_else(|| Some(unescape(inner.trim())))
                .filter(|why| !why.is_empty());
            Ok(Change::Archive {
                id: id(attributes, "id", name)?,
                reason: attributes
                    .get("reason")
                    .map(|reason| reason.trim().to_ascii_lowercase())
                    .unwrap_or_default(),
                of,
                quote: attributes.get("quote").cloned(),
                why,
            })
        }
        other => Err(format!("<{other}> is not a change a curate list takes")),
    }
}

/// Read a reply's `<curate>` list: each element in order, as the change it
/// proposes or why it can't be read. A reply without a complete list is
/// refused as a whole; one unreadable element only drops that element.
pub(crate) fn parse_list(text: &str) -> Result<Vec<Result<Change, String>>, String> {
    let body = list_body(text)?;
    let mut found = Vec::new();
    let mut rest = body;
    while let Some(at) = rest.find('<') {
        rest = &rest[at..];
        if let Some(end) = rest.strip_prefix("<!--").and_then(|after| after.find("-->")) {
            rest = &rest[4 + end + 3..];
            continue;
        }
        if rest.starts_with("</") {
            // A stray closing tag closes nothing a change needs.
            rest = rest.find('>').map_or("", |end| &rest[end + 1..]);
            continue;
        }
        let Some((name, attribute_text, closes, length)) = open_tag(rest) else {
            rest = &rest[1..];
            continue;
        };
        let attributes = attributes(attribute_text);
        let after = &rest[length..];
        if closes {
            found.push(entry(&name, &attributes, ""));
            rest = after;
            continue;
        }
        match closing(after, &name) {
            Some((start, end)) => {
                found.push(entry(&name, &attributes, &after[..start]));
                rest = &after[end..];
            }
            // An archive needs no closing tag; any other element left open
            // runs to the end of the list.
            None if name == "archive" => {
                found.push(entry(&name, &attributes, ""));
                rest = after;
            }
            None => {
                found.push(Err(format!("<{name}> is not closed")));
                break;
            }
        }
    }
    Ok(found)
}

/// Where a run starts: a category, the number of its next part, and the
/// last memory id the parts before it covered. The schedule's
/// `watermark_json` keeps it between runs; a run that finishes every part
/// clears it, so the next one starts over at the first category.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Resume {
    pub category: String,
    pub part: usize,
    pub after: i64,
}

impl Resume {
    pub(crate) fn of(value: &Value) -> Option<Self> {
        Some(Self {
            category: value["category"].as_str()?.to_owned(),
            part: usize::try_from(value["part"].as_u64()?).ok()?,
            after: value["after"].as_i64()?,
        })
    }

    pub(crate) fn to_json(&self) -> Value {
        json!({"category": self.category, "part": self.part, "after": self.after})
    }
}

/// The resume point the schedule of `task` for `project` keeps.
fn stored_resume(conn: &Connection, project: &str, task: &str) -> rusqlite::Result<Option<Resume>> {
    Ok(crate::dreamer::store::schedule_of(
        conn,
        &crate::dreamer::store::OwnerKey::project(project),
        task,
    )?
    .and_then(|schedule| schedule.watermark)
    .and_then(|watermark| Resume::of(&watermark)))
}

/// The task kind.
pub(crate) struct Curate;

/// One part of a run before its message is built: the category's position
/// among the run's, the part's number and the category's count of parts,
/// and its memories.
struct Planned {
    category: usize,
    number: usize,
    count: usize,
    memories: Vec<Memory>,
}

impl Curate {
    /// The run's batches for the context's owner, in order: every part of
    /// every category the task curates, from `resume` on. `only` keeps one
    /// category, by id or tag.
    pub(crate) fn plan_batches(
        &self,
        context: &TaskContext<'_>,
        resume: Option<&Resume>,
        only: Option<&str>,
    ) -> Result<Vec<CurateBatch>, String> {
        let Owner::Project { id: project, root } = context.owner;
        let mut categories = categories(context.profile, context.declaration);
        if let Some(only) = only {
            categories.retain(|category| category.id == only || category.tag == only);
        }
        // A resume point in a category the task no longer curates starts the
        // run over.
        let resume = resume.filter(|resume| {
            categories
                .iter()
                .any(|category| category.id == resume.category)
        });
        let start = resume.map_or(0, |resume| {
            categories
                .iter()
                .position(|category| category.id == resume.category)
                .unwrap_or(0)
        });
        let categories = &categories[start..];
        let now = now_ms();
        let (shown, pools) = context
            .db
            .with_connection(|conn| {
                let shown = shown_memories(conn, project, context.profile, now)?;
                let pools = categories
                    .iter()
                    .map(|category| live_memories(conn, project, &category.id, now))
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok::<_, rusqlite::Error>((shown, pools))
            })
            .map_err(|error| format!("reading the memories of {project}: {error}"))?;
        let docs = project_documents(root);
        let counter = Counter::for_model(None);
        let mut planned: Vec<Planned> = Vec::new();
        for (category, pool) in pools.iter().enumerate() {
            let (first, remaining): (usize, Vec<Memory>) = match resume.filter(|_| category == 0) {
                Some(resume) => (
                    resume.part.max(1),
                    pool.iter()
                        .filter(|memory| memory.id > resume.after)
                        .cloned()
                        .collect(),
                ),
                None => (1, pool.clone()),
            };
            let split = parts(&remaining, counter);
            let count = first - 1 + split.len();
            planned.extend(
                split
                    .into_iter()
                    .enumerate()
                    .map(|(index, memories)| Planned {
                        category,
                        number: first + index,
                        count,
                        memories,
                    }),
            );
        }
        let task = context.declaration["id"].as_str().unwrap_or(KIND);
        let actions = strings(&context.declaration["actions"]);
        planned
            .iter()
            .enumerate()
            .map(|(index, part)| {
                let category = &categories[part.category];
                let inside: HashSet<i64> = part.memories.iter().map(|memory| memory.id).collect();
                // A memory of the part is shown once, in the part: the block
                // of memories every session sees tells the model not to
                // change them.
                let shown: Vec<Shown> = shown
                    .iter()
                    .filter(|memory| !inside.contains(&memory.id))
                    .cloned()
                    .collect();
                let close = similar(&part.memories, &pools[part.category]);
                let text = input(
                    &docs,
                    &shown,
                    &close,
                    (part.number, part.count),
                    &part.memories,
                );
                let (system, message) = task_prompts(
                    context.profile,
                    context.task_id(),
                    "user",
                    &[(INPUT_FRAME, text.as_str())],
                    &[
                        ("projectIdentity", project.as_str()),
                        ("curate.category", category.tag.as_str()),
                    ],
                )?;
                let next = planned.get(index + 1).map(|next| Resume {
                    category: categories[next.category].id.clone(),
                    part: next.number,
                    after: if next.category == part.category {
                        part.memories.last().map_or(0, |memory| memory.id)
                    } else {
                        0
                    },
                });
                let mut seen = inside.clone();
                seen.extend(shown.iter().map(|memory| memory.id));
                seen.extend(close.iter().map(|memory| memory.id));
                Ok(CurateBatch {
                    index,
                    project: project.clone(),
                    task: task.to_owned(),
                    category: category.clone(),
                    part: (part.number, part.count),
                    system,
                    message,
                    actions: actions.clone(),
                    read: part
                        .memories
                        .iter()
                        .map(|memory| (memory.id, memory.revision))
                        .collect(),
                    protected: part
                        .memories
                        .iter()
                        .filter(|memory| memory.protected)
                        .map(|memory| memory.id)
                        .collect(),
                    seen,
                    docs: docs.clone(),
                    next,
                })
            })
            .collect()
    }
}

impl Task for Curate {
    fn kind(&self) -> &'static str {
        KIND
    }

    fn batches(&self, context: &TaskContext<'_>) -> Result<Vec<Box<dyn Batch>>, String> {
        let Owner::Project { id: project, .. } = context.owner;
        let task = context.declaration["id"].as_str().unwrap_or(KIND);
        let resume = context
            .db
            .with_connection(|conn| stored_resume(conn, project, task))
            .map_err(|error| format!("reading where curate stopped for {project}: {error}"))?;
        Ok(self
            .plan_batches(context, resume.as_ref(), None)?
            .into_iter()
            .map(|batch| Box::new(batch) as Box<dyn Batch>)
            .collect())
    }
}

/// One message of a curate run: one part of one category.
pub(crate) struct CurateBatch {
    /// Its place in the run, which names its decisions in the undo history.
    index: usize,
    project: String,
    /// The profile's id for the task, which keys its schedule.
    task: String,
    pub(crate) category: Category,
    /// The part's number and the category's count of parts.
    pub(crate) part: (usize, usize),
    system: String,
    message: String,
    /// The actions the task's declaration allows.
    actions: Vec<String>,
    /// Each memory of the part, with the revision it was read at.
    pub(crate) read: Vec<(i64, i64)>,
    /// The part's protected memories.
    protected: HashSet<i64>,
    /// Every memory the message shows: the part's, the ones every session
    /// sees and the similar ones. A duplicate may only name one of them.
    seen: HashSet<i64>,
    /// The project documents the message shows, as it shows them.
    docs: String,
    /// Where the next run starts once this part is applied; `None` after
    /// the run's last part.
    pub(crate) next: Option<Resume>,
}

impl TaskInput for CurateBatch {
    fn system(&self) -> &str {
        &self.system
    }

    fn prompt(&self, window: Window, output_tokens: u64) -> Option<String> {
        window
            .admits(output_tokens, &self.system, &self.message)
            .then(|| self.message.clone())
    }

    fn accepts(&self, reply: &str) -> Result<(), String> {
        parse_list(reply).map(drop)
    }
}

impl Batch for CurateBatch {
    fn apply(&self, tx: &Transaction<'_>, reply: &TaskReply, run: i64) -> Result<Applied, String> {
        let entries = parse_list(&reply.text)?;
        self.write(tx, &entries, &reply.child, run)
            .map_err(|error| format!("writing curate changes: {error}"))
    }
}

/// A change that passed its checks, with the rows it changes as the batch
/// found them.
enum Checked<'a> {
    Merge {
        sources: Vec<MemoryRow>,
        text: &'a str,
        hash: String,
        /// A source that already holds the merged text, which survives.
        survivor: Option<i64>,
    },
    Shorten {
        memory: MemoryRow,
        text: &'a str,
        hash: String,
    },
    Split {
        memory: MemoryRow,
        parts: &'a [String],
    },
    Archive {
        memory: MemoryRow,
        /// Why, as the undo history and the memory's metadata record it.
        reason: String,
        of: Option<i64>,
        evidence: Value,
    },
}

/// A text without what a formatting-only edit changes: backticks, case,
/// whitespace and punctuation.
fn formatting_key(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// A live memory of `project`, in any category, other than `except`, whose
/// text has `hash`.
fn live_with_hash(
    tx: &Transaction<'_>,
    project: &str,
    hash: &str,
    except: &[i64],
) -> rusqlite::Result<Option<i64>> {
    tx.query_row(
        "SELECT id FROM memories
          WHERE level = 'project' AND owner_id = ?1 AND normalized_hash = ?2
            AND COALESCE(status, 'active') IN ('active', 'permanent')
            AND id NOT IN (SELECT value FROM json_each(?3))
          ORDER BY id LIMIT 1",
        params![
            project,
            hash,
            serde_json::to_string(except).expect("ids serialize")
        ],
        |row| row.get(0),
    )
    .optional()
}

/// Advance `memory`'s revision, as every change the undo history records
/// does, from the revision the batch checked.
fn bump(tx: &Transaction<'_>, memory: &MemoryRow) -> rusqlite::Result<()> {
    let changed = tx.execute(
        "UPDATE memories SET revision = revision + 1 WHERE id = ?1 AND revision = ?2",
        params![memory.id, memory.revision],
    )?;
    if changed == 1 {
        Ok(())
    } else {
        Err(rusqlite::Error::StatementChangedRows(changed))
    }
}

/// The level, owner and category of a new memory written in place of
/// `memory`.
fn beside(memory: &MemoryRow) -> NewRow {
    NewRow {
        level: memory.level.clone(),
        owner_id: memory.owner_id.clone(),
        category_id: memory.category_id.clone(),
        origin_profile: None,
        source_ordinals_json: None,
    }
}

fn snapshot(tx: &Transaction<'_>, id: i64) -> rusqlite::Result<Option<Value>> {
    history_snapshot(tx, id)
}

/// One decision for the undo history and the journal.
struct Decision<'a> {
    key: &'a str,
    operation: &'a str,
    reason: &'a str,
    before: &'a [Option<Value>],
    after: &'a [Option<Value>],
    sources: &'a [i64],
    survivor: Option<i64>,
    evidence: Value,
}

impl CurateBatch {
    fn read_revision(&self, id: i64) -> Option<i64> {
        self.read
            .iter()
            .find(|(read, _)| *read == id)
            .map(|(_, revision)| *revision)
    }

    /// The decision key of the list's change `number`: the run, this
    /// batch and the change, so each change can be undone alone and the
    /// run as one.
    fn decision_key(&self, run: i64, number: usize) -> String {
        format!("dream-run:{run}:{KIND}:{}:{number}", self.index)
    }

    /// Check each change of `entries` and write the ones that pass, in
    /// list order, then move the task's resume point past this part.
    fn write(
        &self,
        tx: &Transaction<'_>,
        entries: &[Result<Change, String>],
        child: &str,
        run: i64,
    ) -> rusqlite::Result<Applied> {
        let mut applied = Applied {
            proposed: entries.len(),
            ..Applied::default()
        };
        let mut named: HashMap<i64, usize> = HashMap::new();
        for change in entries.iter().flatten() {
            // A change that names a memory twice is refused on its own.
            let ids: HashSet<i64> = change.ids().into_iter().collect();
            for id in ids {
                *named.entry(id).or_default() += 1;
            }
        }
        for (number, entry) in entries.iter().enumerate() {
            // The run's record lists every dropped change by its part.
            let at = format!("{} part {}", self.category.tag, self.part.0);
            let change = match entry {
                Ok(change) => change,
                Err(reason) => {
                    applied
                        .dropped
                        .push(format!("{at}, change {}: {reason}", number + 1));
                    continue;
                }
            };
            match self.check(tx, change, &named)? {
                Ok(checked) => {
                    self.commit(tx, checked, child, &self.decision_key(run, number))?;
                    applied.applied += 1;
                }
                Err(reason) => applied
                    .dropped
                    .push(format!("{at}, {}: {reason}", change.label())),
            }
        }
        tx.execute(
            "UPDATE dream_schedules SET watermark_json = ?3
              WHERE level = 'project' AND owner_id = ?1 AND task = ?2",
            params![
                self.project,
                self.task,
                self.next.as_ref().map(|next| next.to_json().to_string())
            ],
        )?;
        Ok(applied)
    }

    /// `change` with its rows when every check passes, or why it doesn't.
    fn check<'c>(
        &self,
        tx: &Transaction<'_>,
        change: &'c Change,
        named: &HashMap<i64, usize>,
    ) -> rusqlite::Result<Result<Checked<'c>, String>> {
        if !self.actions.iter().any(|action| action == change.action()) {
            return Ok(Err(format!(
                "the task's declaration does not allow {}",
                change.action()
            )));
        }
        let ids = change.ids();
        let mut distinct = HashSet::new();
        if let Some(twice) = ids.iter().find(|id| !distinct.insert(**id)) {
            return Ok(Err(format!("memory {twice} is named twice")));
        }
        for id in &ids {
            if self.read_revision(*id).is_none() {
                return Ok(Err(format!("memory {id} is not in this part")));
            }
            if named.get(id).copied().unwrap_or(0) > 1 {
                return Ok(Err(format!(
                    "memory {id} is named by more than one change"
                )));
            }
            if self.protected.contains(id) {
                return Ok(Err(format!("memory {id} is protected")));
            }
        }
        let mut rows = Vec::new();
        for id in &ids {
            match self.current(tx, *id)? {
                Ok(row) => rows.push(row),
                Err(reason) => return Ok(Err(reason)),
            }
        }
        match change {
            Change::Merge { text, .. } => self.check_merge(tx, rows, text),
            Change::Shorten { text, .. } => {
                self.check_shorten(tx, rows.remove(0), text)
            }
            Change::Split { parts, .. } => self.check_split(tx, rows.remove(0), parts),
            Change::Archive {
                reason,
                of,
                quote,
                why,
                ..
            } => self.check_archive(
                tx,
                rows.remove(0),
                reason,
                (*of, quote.as_deref(), why.as_deref()),
                named,
            ),
        }
    }

    /// Memory `id` as it is now, when it is still the live memory of this
    /// part the batch read, at the revision it read, and the undo history
    /// can record it.
    fn current(&self, tx: &Transaction<'_>, id: i64) -> rusqlite::Result<Result<MemoryRow, String>> {
        let read = self.read_revision(id).unwrap_or_default();
        let Some(row) = get_memory(tx, id)? else {
            return Ok(Err(format!("memory {id} no longer exists")));
        };
        if !row.is_project_owned_by(&self.project)
            || !row.is_mutable()
            || row.category_id != self.category.id
        {
            return Ok(Err(format!(
                "memory {id} is no longer a live {} memory of the project",
                self.category.tag
            )));
        }
        if row.revision != read {
            return Ok(Err(format!(
                "memory {id} changed after the run read it (revision {read}, now {})",
                row.revision
            )));
        }
        if history_snapshot(tx, id)?.is_none() {
            return Ok(Err(format!(
                "memory {id} holds a row the undo history can't record"
            )));
        }
        Ok(Ok(row))
    }

    fn check_merge<'c>(
        &self,
        tx: &Transaction<'_>,
        sources: Vec<MemoryRow>,
        text: &'c str,
    ) -> rusqlite::Result<Result<Checked<'c>, String>> {
        if sources.len() < 2 {
            return Ok(Err("a merge names two or more memories".into()));
        }
        if let Some(token) = dropped_token(sources.iter().map(|row| row.content.as_str()), text) {
            return Ok(Err(format!("the merged text drops {token}")));
        }
        let hash = normalized_hash(text);
        let ids: Vec<i64> = sources.iter().map(|row| row.id).collect();
        if let Some(other) = live_with_hash(tx, &self.project, &hash, &ids)? {
            return Ok(Err(format!(
                "the merged text repeats live memory {other}"
            )));
        }
        let survivor = sources
            .iter()
            .find(|row| row.normalized_hash == hash)
            .map(|row| row.id);
        Ok(Ok(Checked::Merge {
            sources,
            text,
            hash,
            survivor,
        }))
    }

    fn check_shorten<'c>(
        &self,
        tx: &Transaction<'_>,
        memory: MemoryRow,
        text: &'c str,
    ) -> rusqlite::Result<Result<Checked<'c>, String>> {
        if formatting_key(text) == formatting_key(&memory.content) {
            return Ok(Err(
                "the new text differs only in formatting (backticks, case, spaces or punctuation)"
                    .into(),
            ));
        }
        if text.chars().count() >= memory.content.trim().chars().count() {
            return Ok(Err("the new text is not shorter".into()));
        }
        if let Some(token) = dropped_token([memory.content.as_str()], text) {
            return Ok(Err(format!("the new text drops {token}")));
        }
        let hash = normalized_hash(text);
        if let Some(other) = live_with_hash(tx, &self.project, &hash, &[memory.id])? {
            return Ok(Err(format!("the new text repeats live memory {other}")));
        }
        Ok(Ok(Checked::Shorten { memory, text, hash }))
    }

    fn check_split<'c>(
        &self,
        tx: &Transaction<'_>,
        memory: MemoryRow,
        parts: &'c [String],
    ) -> rusqlite::Result<Result<Checked<'c>, String>> {
        if parts.len() < 2 {
            return Ok(Err("a split has two or more parts".into()));
        }
        if let Some(token) = dropped_token([memory.content.as_str()], &parts.join("\n")) {
            return Ok(Err(format!("the parts drop {token}")));
        }
        let mut hashes = HashSet::new();
        for part in parts {
            let hash = normalized_hash(part);
            if let Some(other) = live_with_hash(tx, &self.project, &hash, &[memory.id])? {
                return Ok(Err(format!("a part repeats live memory {other}")));
            }
            if !hashes.insert(hash) {
                return Ok(Err("two parts have the same text".into()));
            }
        }
        Ok(Ok(Checked::Split { memory, parts }))
    }

    /// Whether `quote` is in the project documents the message showed, as
    /// shown or with its XML escapes written out.
    fn quotes(&self, quote: &str) -> bool {
        self.docs.contains(quote) || unescape(&self.docs).contains(quote)
    }

    fn check_archive<'c>(
        &self,
        tx: &Transaction<'_>,
        memory: MemoryRow,
        reason: &str,
        (of, quote, why): (Option<i64>, Option<&str>, Option<&str>),
        named: &HashMap<i64, usize>,
    ) -> rusqlite::Result<Result<Checked<'c>, String>> {
        let archived = |reason: String,
                        of: Option<i64>,
                        evidence: Value|
         -> rusqlite::Result<Result<Checked<'c>, String>> {
            Ok(Ok(Checked::Archive {
                memory: memory.clone(),
                reason,
                of,
                evidence,
            }))
        };
        match reason {
            "duplicate" => {
                if let Some(of) = of {
                    if of == memory.id {
                        return Ok(Err("a memory can't be a duplicate of itself".into()));
                    }
                    if !self.seen.contains(&of) {
                        return Ok(Err(format!("memory {of} was not shown with this part")));
                    }
                    if named.contains_key(&of) {
                        return Ok(Err(format!("memory {of} is changed by this list too")));
                    }
                    let live = get_memory(tx, of)?.is_some_and(|survivor| {
                        survivor.is_project_owned_by(&self.project) && survivor.is_mutable()
                    });
                    if !live {
                        return Ok(Err(format!(
                            "memory {of} is not a live memory of the project"
                        )));
                    }
                    return archived(
                        format!("duplicate of memory {of}"),
                        Some(of),
                        json!({"reason": "duplicate", "of": of}),
                    );
                }
                let Some(quote) = quote.map(str::trim).filter(|quote| !quote.is_empty()) else {
                    return Ok(Err(
                        "a duplicate names no memory (of) and no documents line (quote)".into(),
                    ));
                };
                if quote.chars().count() < MIN_QUOTE_CHARS {
                    return Ok(Err(format!(
                        "the quote is shorter than {MIN_QUOTE_CHARS} characters"
                    )));
                }
                if !self.quotes(quote) {
                    return Ok(Err("the quote is not in the project documents".into()));
                }
                archived(
                    format!("duplicate of the project documents: \"{quote}\""),
                    None,
                    json!({"reason": "duplicate", "quote": quote}),
                )
            }
            "one-off" | "lesson" => match why.map(str::trim).filter(|why| !why.is_empty()) {
                Some(why) => archived(
                    format!("{reason}: {why}"),
                    None,
                    json!({"reason": reason, "why": why}),
                ),
                None => Ok(Err(format!("a {reason} archive says no why"))),
            },
            "" => Ok(Err("the archive gives no reason".into())),
            other => Ok(Err(format!(
                "{other} is not an archive reason ({})",
                ARCHIVE_REASONS.join(", ")
            ))),
        }
    }

    /// Write a change that passed its checks, with one undo-history
    /// decision under `key`. New memories name `child`, the session that
    /// proposed them, as their source.
    fn commit(
        &self,
        tx: &Transaction<'_>,
        checked: Checked<'_>,
        child: &str,
        key: &str,
    ) -> rusqlite::Result<()> {
        let now = now_ms();
        let placer = Placer::unplaced();
        match checked {
            Checked::Shorten { memory, text, hash } => {
                let before = [snapshot(tx, memory.id)?];
                bump(tx, &memory)?;
                update_content(tx, memory.id, text, &hash)?;
                let after = [snapshot(tx, memory.id)?];
                self.record(
                    tx,
                    &Decision {
                        key,
                        operation: "shorten",
                        reason: "shorten",
                        before: &before,
                        after: &after,
                        sources: &[memory.id],
                        survivor: None,
                        evidence: json!([]),
                    },
                    now,
                )
            }
            Checked::Split { memory, parts } => {
                let mut before = vec![snapshot(tx, memory.id)?];
                let importance: Option<i64> = tx.query_row(
                    "SELECT importance FROM memories WHERE id = ?1",
                    [memory.id],
                    |row| row.get(0),
                )?;
                bump(tx, &memory)?;
                update_content(tx, memory.id, &parts[0], &normalized_hash(&parts[0]))?;
                let mut ids = vec![memory.id];
                for part in &parts[1..] {
                    let written = insert_memory(
                        tx,
                        &beside(&memory),
                        &self.project,
                        &memory.category,
                        part,
                        child,
                        "dreamer",
                        importance,
                    )?;
                    created(tx, &placer, written.id, CreateKind::Create, now)?;
                    before.push(None);
                    ids.push(written.id);
                }
                let after = ids
                    .iter()
                    .map(|id| snapshot(tx, *id))
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                self.record(
                    tx,
                    &Decision {
                        key,
                        operation: "split",
                        reason: "split",
                        before: &before,
                        after: &after,
                        sources: &[memory.id],
                        survivor: None,
                        evidence: json!([]),
                    },
                    now,
                )
            }
            Checked::Archive {
                memory,
                reason,
                of,
                evidence,
            } => {
                let before = [snapshot(tx, memory.id)?];
                bump(tx, &memory)?;
                archive(tx, &memory, Some(&reason))?;
                if let Some(of) = of {
                    tx.execute(
                        "UPDATE memories SET superseded_by_memory_id = ?2 WHERE id = ?1",
                        params![memory.id, of],
                    )?;
                    tx.execute(
                        "INSERT OR IGNORE INTO memory_successor_links(source_id, successor_id, decision_key)
                         VALUES (?1, ?2, ?3)",
                        params![memory.id, of, key],
                    )?;
                }
                clear_derived(tx, memory.id)?;
                let after = [snapshot(tx, memory.id)?];
                self.record(
                    tx,
                    &Decision {
                        key,
                        operation: "archive",
                        reason: &reason,
                        before: &before,
                        after: &after,
                        sources: &[memory.id],
                        survivor: None,
                        evidence,
                    },
                    now,
                )
            }
            Checked::Merge {
                sources,
                text,
                hash,
                survivor,
            } => self.commit_merge(tx, &sources, text, &hash, survivor, child, key),
        }
    }

    /// Write a merge the way the agent's merge writes one
    /// ([`crate::memory_writes::mutate`]): a source that already holds the
    /// merged text survives with it, otherwise a new memory does; every
    /// other source is archived as superseded by the survivor, which keeps
    /// their counts and ancestry.
    #[allow(clippy::too_many_arguments)]
    fn commit_merge(
        &self,
        tx: &Transaction<'_>,
        sources: &[MemoryRow],
        text: &str,
        hash: &str,
        survivor: Option<i64>,
        child: &str,
        key: &str,
    ) -> rusqlite::Result<()> {
        let now = now_ms();
        let ids: Vec<i64> = sources.iter().map(|row| row.id).collect();
        let mut before = ids
            .iter()
            .map(|id| snapshot(tx, *id))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // The survivor keeps the highest importance among what it replaces
        // until classify scores its new text.
        let importance: Option<i64> = tx.query_row(
            "SELECT MAX(importance) FROM memories WHERE id IN (SELECT value FROM json_each(?1))",
            [serde_json::to_string(&ids).expect("ids serialize")],
            |row| row.get(0),
        )?;
        for source in sources {
            bump(tx, source)?;
        }
        let survivor = match survivor {
            Some(id) => {
                if sources.iter().any(|row| row.id == id && row.content != text) {
                    update_content(tx, id, text, hash)?;
                }
                id
            }
            None => {
                before.push(None);
                let first = &sources[0];
                let written = insert_memory(
                    tx,
                    &beside(first),
                    &self.project,
                    &first.category,
                    text,
                    child,
                    "dreamer",
                    importance,
                )?;
                created(
                    tx,
                    &Placer::unplaced(),
                    written.id,
                    CreateKind::MergeSurvivor,
                    now,
                )?;
                written.id
            }
        };
        let mut merged_from: BTreeSet<i64> = ids.iter().copied().collect();
        for source in sources {
            if let Some(prior) = source
                .merged_from
                .as_deref()
                .and_then(|json| serde_json::from_str::<Vec<Value>>(json).ok())
            {
                merged_from.extend(prior.iter().filter_map(Value::as_i64));
            }
            if source.id == survivor {
                continue;
            }
            tx.execute(
                "UPDATE memories SET superseded_by_memory_id = ?2, status = 'archived', updated_at = ?3
                  WHERE id = ?1",
                params![source.id, survivor, now],
            )?;
            clear_derived(tx, source.id)?;
            tx.execute(
                "INSERT OR IGNORE INTO memory_successor_links(source_id, successor_id, decision_key)
                 VALUES (?1, ?2, ?3)",
                params![source.id, survivor, key],
            )?;
        }
        tx.execute(
            "UPDATE memories SET seen_count = ?2, retrieval_count = ?3, merged_from = ?4,
                    status = 'active', updated_at = ?5
              WHERE id = ?1",
            params![
                survivor,
                sources.iter().map(|row| row.seen_count).sum::<i64>(),
                sources.iter().map(|row| row.retrieval_count).sum::<i64>(),
                serde_json::to_string(&merged_from).expect("ids serialize"),
                now
            ],
        )?;
        clear_derived(tx, survivor)?;
        let mut after = ids
            .iter()
            .map(|id| snapshot(tx, *id))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if !ids.contains(&survivor) {
            after.push(snapshot(tx, survivor)?);
        }
        self.record(
            tx,
            &Decision {
                key,
                operation: "merge",
                reason: "merge",
                before: &before,
                after: &after,
                sources: &ids,
                survivor: Some(survivor),
                evidence: json!([]),
            },
            now,
        )
    }

    /// Record `decision` in the undo history and the journal, the way the
    /// other dreamer tasks record theirs: the history rows, then the
    /// journal's receipt with the whole decision, where the undo view and
    /// a run's undo read it.
    fn record(&self, tx: &Transaction<'_>, decision: &Decision<'_>, now: i64) -> rusqlite::Result<()> {
        let recorded = record_history(
            tx,
            &History {
                key: decision.key,
                project: &self.project,
                writer: WRITER,
                operation: decision.operation,
                reason: decision.reason,
                now,
                before: decision.before,
                after: decision.after,
                source_ids: decision.sources,
                survivor_id: decision.survivor,
                evidence: decision.evidence.clone(),
            },
        )?;
        let ids: Vec<i64> = decision
            .after
            .iter()
            .filter_map(|row| row.as_ref()?["id"].as_i64())
            .collect();
        tx.execute(
            "INSERT INTO memory_journal(project_path, decision_key, operation, receipt_json, applied_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                self.project,
                decision.key,
                format!("{KIND}_{}", decision.operation),
                json!({"state": "applied", "reason": decision.operation, "memoryIds": ids})
                    .to_string(),
                now
            ],
        )?;
        tx.execute(
            "UPDATE memory_journal SET before_json = ?2, after_json = ?2 WHERE decision_key = ?1",
            params![decision.key, history_json(&recorded)],
        )?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "curate_tests.rs"]
mod tests;
