//! The `compress-cues` task: write each live project memory its mural cue, a
//! few characters of mnemonic shorthand that the memory mural shows for a
//! memory the memory block had no room for ([`crate::mural`]).
//!
//! Ported from the 0.49 plugin (`features/magic-context/mural/`:
//! `compress-cues.ts`, `compress-cues-prompt.ts`, `cue-validation.ts` and
//! `storage-mural-cues.ts`). A memory needs a cue when it has none, or when
//! its cue was written from other text: a cue carries the SHA-256 of the text
//! it was made from, the hash the mural checks before it shows the cue. The
//! memories go to the model forty at a time.
//!
//! A reply must hold a complete `<cues>` manifest with one cue for each memory
//! the batch sent. Each cue is then checked on its own: a cue that breaks the
//! cue grammar is dropped and the rest of the batch is still written. The row
//! counts how often a cue for its current text was refused. At the third
//! refusal the task writes a cue cut from the model's last try or from the
//! memory's own text instead, so a memory the model keeps failing on is not
//! sent again on every run.
//!
//! A cue is display data derived from the memory, not part of what the
//! memory says. Writing one records no undo history and no journal row, and
//! leaves the memory's revision and `updated_at` alone: a summarizer edit
//! that read the memory before the cue was written must still apply.

use std::collections::HashSet;

use regex::Regex;
use rusqlite::{named_params, params, Connection, OptionalExtension, Transaction};
use serde_json::Value;

use crate::dreamer::run::{TaskInput, TaskReply};
use crate::dreamer::task::{task_prompts, Applied, Batch, Owner, Task, TaskContext};
use crate::memory_writes::now_ms;
use crate::mural::content_hash;
use crate::summary::fit::Window;

/// The kind memory profiles name.
pub(crate) const KIND: &str = "compress-cues";
/// Magic Context's frame that the task's message fills with the memories.
const INPUT_FRAME: &str = "dreamer/compress-cues.input";
/// At most this many memories go in one message: few enough that a model's
/// context stays small and a failed batch leaves little to redo.
pub(crate) const BATCH_SIZE: usize = 40;
/// At this many refused cues for the same text, a fallback cue is written.
pub(crate) const REJECTION_LATCH: i64 = 3;
/// The importance a memory without one is shown and budgeted at.
const DEFAULT_IMPORTANCE: i64 = 50;
/// What a fallback cue is when nothing else passes the cue checks.
const LAST_RESORT_CUE: &str = "memory";

/// The whitespace of a JavaScript regular expression's `\s` and of
/// `String.prototype.trim`, which the 0.49 checks used. It differs from
/// Rust's: it includes U+FEFF and leaves out U+0085.
const JS_SPACE: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";

fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{B}' | '\u{C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `text` without leading and trailing whitespace, as JavaScript trims it.
fn js_trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a fixed compress-cues pattern")
}

/// The words that make a cue read as a prohibition. Word boundaries and case
/// folding are ASCII-only (`-u`), as in the JavaScript pattern without the
/// `u` flag that 0.49 used: `éwithout` holds the word, `withouté` too.
fn prohibition() -> Regex {
    re(r"(?i-u)\b(?:must not|never|without|instead of|exclude|excludes)\b")
}

/// The memory's own id as a cue would leak it: `#12`, but not `#123`.
fn own_id(id: i64) -> Regex {
    re(&format!(r"#{id}(?-u:\b)"))
}

/// The per-cue character budgets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Budget {
    /// The budget of a memory at `high_from` importance or above.
    pub high: usize,
    pub low: usize,
    pub high_from: i64,
}

impl Default for Budget {
    /// The budgets 0.49 used.
    fn default() -> Self {
        Self {
            high: 90,
            low: 50,
            high_from: 70,
        }
    }
}

impl Budget {
    /// The budgets in a task declaration's `settings`. The profile's system
    /// prompt states these same settings to the model, so the checks hold a
    /// cue to the budget the model was given. A setting the declaration
    /// leaves out keeps 0.49's value.
    pub(crate) fn of(declaration: &Value) -> Result<Self, String> {
        let settings = &declaration["settings"];
        let read = |key: &str, default: u64, least: u64| -> Result<u64, String> {
            match &settings[key] {
                Value::Null => Ok(default),
                value => value.as_u64().filter(|number| *number >= least).ok_or_else(|| {
                    format!("the {KIND} setting {key} must be a whole number of at least {least}, not {value}")
                }),
            }
        };
        let defaults = Self::default();
        Ok(Self {
            high: read("cue_chars_high", defaults.high as u64, 1)? as usize,
            low: read("cue_chars_low", defaults.low as u64, 1)? as usize,
            high_from: read("cue_high_from", defaults.high_from as u64, 0)? as i64,
        })
    }

    /// The most characters a cue for a memory of `importance` may hold.
    pub(crate) fn chars(self, importance: i64) -> usize {
        if importance >= self.high_from {
            self.high
        } else {
            self.low
        }
    }
}

/// Why `cue` can't be a cue for memory `id` of `importance`, in 0.49's words,
/// or `Ok` when it can. Each rule reads the cue alone.
pub(crate) fn validate_cue(
    cue: &str,
    importance: i64,
    id: i64,
    budget: Budget,
) -> Result<(), String> {
    let cue = js_trim(cue);
    if cue.is_empty() {
        return Err("empty".into());
    }
    let chars = budget.chars(importance);
    let length = cue.chars().count();
    if length > chars {
        return Err(format!("over-budget {length}>{chars}"));
    }
    // Other numbers are real content (pull requests, issues); only the id
    // the prompt showed next to this memory is a leak.
    if own_id(id).is_match(cue) {
        return Err("leaked-id".into());
    }
    let mut depth = 0_i64;
    for character in cue.chars() {
        match character {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ => {}
        }
        if depth < 0 {
            return Err("unbalanced-parens".into());
        }
    }
    if depth != 0 {
        return Err("unbalanced-parens".into());
    }
    // The mural draws a prohibition in red from its `⊘` marker, and the
    // parenthesized mechanism after the marker says why.
    let markers = cue.matches('⊘').count();
    let mechanisms = re(r"\([^()]+\)").find_iter(cue).count();
    if markers == 0 && prohibition().is_match(cue) {
        return Err("prohibition-missing-marker".into());
    }
    if markers > mechanisms {
        return Err("polarity-missing-mechanism".into());
    }
    Ok(())
}

/// `value` trimmed and cut to `chars` characters, ending on a whole word
/// when the cut leaves one.
fn truncate(value: &str, chars: usize) -> String {
    let trimmed = js_trim(value);
    let Some((end, _)) = trimmed.char_indices().nth(chars) else {
        return trimmed.to_owned();
    };
    let prefix = &trimmed[..end];
    // Cut at the start of the whitespace before the prefix's last word, which
    // the cut may have split.
    let without_last_word = prefix.trim_end_matches(|c: char| !js_space(c));
    let boundary = without_last_word.trim_end_matches(js_space).len();
    let kept = if without_last_word.is_empty() || boundary == 0 {
        prefix
    } else {
        &prefix[..boundary]
    };
    js_trim(kept).to_owned()
}

/// The cue written in place of one refused for the third time: the model's
/// last try made to fit, else the start of the memory's text, else that text
/// without the marks the cue checks look for. Each is used only if it passes
/// the checks.
pub(crate) fn fallback_cue(memory: &Sent, last_try: &str, budget: Budget) -> String {
    let importance = memory.importance.unwrap_or(DEFAULT_IMPORTANCE);
    let chars = budget.chars(importance);
    let passes = |cue: &str| validate_cue(cue, importance, memory.id, budget).is_ok();
    let fit = |text: &str| truncate(&own_id(memory.id).replace_all(text, ""), chars);
    let model = fit(last_try);
    if passes(&model) {
        return model;
    }
    let slice = fit(&memory.content);
    if passes(&slice) {
        return slice;
    }
    let unmarked = slice.replace('⊘', "").replace(['(', ')'], "");
    let unmarked = prohibition().replace_all(&unmarked, "");
    let unmarked = re(&format!("{JS_SPACE}+")).replace_all(&unmarked, " ");
    let unmarked = truncate(&unmarked, chars);
    if passes(&unmarked) {
        return unmarked;
    }
    LAST_RESORT_CUE.into()
}

/// One live project memory as the task reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Memory {
    pub id: i64,
    /// The tag it was written under (`origin_category`).
    pub category: String,
    pub content: String,
    pub importance: Option<i64>,
    pub cue: Option<String>,
    /// The hash of the text the stored cue was written from.
    pub cue_hash: Option<String>,
}

impl Memory {
    /// Whether the memory has no cue written from its current text.
    pub(crate) fn needs_cue(&self) -> bool {
        match (&self.cue, &self.cue_hash) {
            (Some(_), Some(hash)) => *hash != content_hash(&self.content),
            _ => true,
        }
    }
}

/// The condition that makes a memory row a live memory of `:project` at
/// `:now`: active or permanent, and not expired.
const LIVE: &str = "level = 'project' AND owner_id = :project AND status IN ('active', 'permanent')
                    AND (expires_at IS NULL OR expires_at > :now)";

/// `project`'s live memories at `now`, in the order 0.49 sent them: by tag,
/// then most recently updated first, then by id.
pub(crate) fn live_memories(
    conn: &Connection,
    project: &str,
    now: i64,
) -> rusqlite::Result<Vec<Memory>> {
    conn.prepare(&format!(
        "SELECT id, origin_category, content, importance, mural_cue, mural_cue_hash
           FROM memories
          WHERE {LIVE}
          ORDER BY origin_category ASC, updated_at DESC, id ASC"
    ))?
    .query_map(named_params! {":project": project, ":now": now}, |row| {
        Ok(Memory {
            id: row.get(0)?,
            category: row.get(1)?,
            content: row.get(2)?,
            importance: row.get(3)?,
            cue: row.get(4)?,
            cue_hash: row.get(5)?,
        })
    })?
    .collect()
}

/// The text that fills the task's input frame, in the frame's own shape: each
/// memory with its importance and the budget its cue must keep to.
pub(crate) fn input(pool: &[Memory], budget: Budget) -> String {
    let entries: Vec<String> = pool
        .iter()
        .map(|memory| {
            let importance = memory.importance.unwrap_or(DEFAULT_IMPORTANCE);
            format!(
                "[{}] {} importance={importance} (budget {})\n{}",
                memory.id,
                memory.category,
                budget.chars(importance),
                memory.content
            )
        })
        .collect();
    format!("### Memory pool to compress\n{}", entries.join("\n\n"))
}

/// One cue as a reply proposes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProposedCue {
    pub id: i64,
    /// Unescaped and trimmed.
    pub cue: String,
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
}

/// Read a reply's `<cues>` manifest. A reply without a complete root element
/// is refused whole, so a reply cut off by its output limit writes nothing.
/// The cues themselves are not checked here.
pub(crate) fn parse_manifest(text: &str) -> Result<Vec<ProposedCue>, String> {
    let Some(root) = re(r"(?s)(?i-u:<cues\b)[^>]*>(.*?)(?i-u:</cues>)").captures(text) else {
        let open = re(r"(?i-u)<cues\b").is_match(text);
        let closed = re(r"(?i-u)</cues>").is_match(text);
        return Err(if open && !closed {
            "cues manifest missing closing root tag"
        } else {
            "cues manifest missing complete root element"
        }
        .into());
    };
    let body = root.get(1).map_or("", |found| found.as_str());
    re(&format!(
        r#"<cue{JS_SPACE}+id="([0-9]+)"{JS_SPACE}*>((?s:.)*?)</cue>"#
    ))
    .captures_iter(body)
    .map(|entry| {
        let digits = &entry[1];
        let id = digits
            .parse()
            .map_err(|_| format!("cues manifest contains unknown id {digits}"))?;
        Ok(ProposedCue {
            id,
            cue: js_trim(&unescape(&entry[2])).to_owned(),
        })
    })
    .collect()
}

/// A reply's manifest when it holds exactly one cue for each memory in
/// `expected`, and no other.
pub(crate) fn validate_manifest(text: &str, expected: &[i64]) -> Result<Vec<ProposedCue>, String> {
    let found = parse_manifest(text)?;
    let mut seen = HashSet::new();
    for entry in &found {
        if !seen.insert(entry.id) {
            return Err(format!("cues manifest contains duplicate id {}", entry.id));
        }
    }
    for entry in &found {
        if !expected.contains(&entry.id) {
            return Err(format!("cues manifest contains unknown id {}", entry.id));
        }
    }
    for id in expected {
        if !seen.contains(id) {
            return Err(format!("cues manifest missing id {id}"));
        }
    }
    Ok(found)
}

/// The task kind.
pub(crate) struct CompressCues;

impl CompressCues {
    /// The run's batches for the context's owner, in order.
    pub(crate) fn plan_batches(
        &self,
        context: &TaskContext<'_>,
    ) -> Result<Vec<CompressCuesBatch>, String> {
        let Owner::Project { id: project, .. } = context.owner;
        let budget = Budget::of(context.declaration)?;
        let needing: Vec<Memory> = context
            .db
            .with_connection(|conn| live_memories(conn, project, now_ms()))
            .map_err(|error| format!("reading the memories of {project}: {error}"))?
            .into_iter()
            .filter(Memory::needs_cue)
            .collect();
        needing
            .chunks(BATCH_SIZE)
            .map(|pool| {
                let text = input(pool, budget);
                let (system, message) = task_prompts(
                    context.profile,
                    context.task_id(),
                    "user",
                    &[(INPUT_FRAME, text.as_str())],
                    &[("projectIdentity", project.as_str())],
                )?;
                Ok(CompressCuesBatch {
                    project: project.clone(),
                    system,
                    message,
                    budget,
                    sent: pool
                        .iter()
                        .map(|memory| Sent {
                            id: memory.id,
                            importance: memory.importance,
                            hash: content_hash(&memory.content),
                            content: memory.content.clone(),
                        })
                        .collect(),
                })
            })
            .collect()
    }
}

impl Task for CompressCues {
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

/// A memory as a batch sent it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Sent {
    pub id: i64,
    /// The importance the model was shown, which sets the cue's budget.
    pub importance: Option<i64>,
    pub content: String,
    /// The hash of `content`: the text a cue from this batch is made from.
    pub hash: String,
}

/// One message of a compress-cues run.
pub(crate) struct CompressCuesBatch {
    project: String,
    system: String,
    message: String,
    budget: Budget,
    sent: Vec<Sent>,
}

impl CompressCuesBatch {
    fn ids(&self) -> Vec<i64> {
        self.sent.iter().map(|memory| memory.id).collect()
    }
}

impl TaskInput for CompressCuesBatch {
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

impl Batch for CompressCuesBatch {
    fn apply(&self, tx: &Transaction<'_>, reply: &TaskReply, _run: i64) -> Result<Applied, String> {
        let proposals = validate_manifest(&reply.text, &self.ids())?;
        self.write(tx, &proposals)
            .map_err(|error| format!("writing mural cues: {error}"))
    }
}

/// A memory row as a batch finds it when it writes.
struct Current {
    live: bool,
    content: String,
    cue: Option<String>,
    cue_hash: Option<String>,
    rejections: i64,
}

fn current(
    tx: &Transaction<'_>,
    id: i64,
    project: &str,
    now: i64,
) -> rusqlite::Result<Option<Current>> {
    tx.query_row(
        &format!(
            "SELECT {LIVE}, content, mural_cue, mural_cue_hash, mural_cue_rejection_count
               FROM memories WHERE id = :id"
        ),
        named_params! {":id": id, ":project": project, ":now": now},
        |row| {
            Ok(Current {
                live: row.get::<_, Option<bool>>(0)?.unwrap_or(false),
                content: row.get(1)?,
                cue: row.get(2)?,
                cue_hash: row.get(3)?,
                rejections: row.get(4)?,
            })
        },
    )
    .optional()
}

/// Store `cue` (none for a refused one) for memory `id`, made from the text
/// whose hash is `hash`, with `rejections` refusals counted for that text.
fn store_cue(
    tx: &Transaction<'_>,
    id: i64,
    cue: Option<&str>,
    hash: &str,
    rejections: i64,
    now: i64,
) -> rusqlite::Result<()> {
    tx.execute(
        "UPDATE memories
            SET mural_cue = ?2, mural_cue_hash = ?3, mural_cue_at = ?4, mural_cue_rejection_count = ?5
          WHERE id = ?1",
        params![id, cue, hash, now, rejections],
    )?;
    Ok(())
}

impl CompressCuesBatch {
    /// Write what `proposals` hold, in `tx`. A memory that already has a cue
    /// for its current text is left alone; when that cue is the proposal's,
    /// it counts as neither applied nor dropped.
    fn write(&self, tx: &Transaction<'_>, proposals: &[ProposedCue]) -> rusqlite::Result<Applied> {
        let now = now_ms();
        let mut applied = Applied {
            proposed: proposals.len(),
            ..Applied::default()
        };
        for proposal in proposals {
            let id = proposal.id;
            let Some(sent) = self.sent.iter().find(|memory| memory.id == id) else {
                continue;
            };
            let Some(current) = current(tx, id, &self.project, now)?.filter(|current| current.live)
            else {
                applied.dropped.push(format!(
                    "memory {id} is no longer a live memory of the project"
                ));
                continue;
            };
            // A cue made from older text would describe a memory that no
            // longer says it.
            if content_hash(&current.content) != sent.hash {
                applied
                    .dropped
                    .push(format!("memory {id} changed after the batch read it"));
                continue;
            }
            if current.cue.is_some() && current.cue_hash.as_deref() == Some(sent.hash.as_str()) {
                if current.cue.as_deref() != Some(proposal.cue.as_str()) {
                    applied.dropped.push(format!(
                        "memory {id} already has a cue for its current text"
                    ));
                }
                continue;
            }
            let importance = sent.importance.unwrap_or(DEFAULT_IMPORTANCE);
            let Err(reason) = validate_cue(&proposal.cue, importance, id, self.budget) else {
                store_cue(tx, id, Some(&proposal.cue), &sent.hash, 0, now)?;
                applied.applied += 1;
                continue;
            };
            // The count belongs to the text it was made for: refusals for an
            // older text don't count toward this one.
            let rejections = if current.cue_hash.as_deref() == Some(sent.hash.as_str()) {
                current.rejections + 1
            } else {
                1
            };
            if rejections >= REJECTION_LATCH {
                let fallback = fallback_cue(sent, &proposal.cue, self.budget);
                store_cue(tx, id, Some(&fallback), &sent.hash, 0, now)?;
                applied.applied += 1;
                applied.dropped.push(format!(
                    "memory {id}: cue refused ({reason}), rejection {rejections} of {REJECTION_LATCH}; wrote the fallback cue {fallback:?}"
                ));
            } else {
                store_cue(tx, id, None, &sent.hash, rejections, now)?;
                applied.dropped.push(format!(
                    "memory {id}: cue refused ({reason}), rejection {rejections} of {REJECTION_LATCH}"
                ));
            }
        }
        Ok(applied)
    }
}

#[cfg(test)]
#[path = "compress_cues_tests.rs"]
mod tests;
