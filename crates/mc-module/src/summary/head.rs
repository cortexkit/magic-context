//! The history head: two messages a view inserts at the start of the
//! request.
//!
//! - `m[0]`, the baseline: the project docs, the user profile, every summary
//!   as of the last fold (each at the detail tier its age and importance
//!   earn under the history budget), and the workspace's and project's
//!   memories. Which memories of every level it shows is chosen once, at the
//!   fold, by [`crate::head_memories`]. Its text is kept as rendered and
//!   changes only on a fold, when the request's prefix is written again
//!   anyway.
//! - `m[1]`, what changed since: newer summaries at full detail, and every
//!   memory change at any level (corrections, new memories, new profile
//!   lines), or a short placeholder. Changing it rewrites the request from
//!   `m[1]` on, not from the start.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::Arc;

use cortexkit_role_compaction::read::Role;
use cortexkit_role_compaction::view::{EditOp, InsertAt, InsertedImage, InsertedMessage};
use serde::{Deserialize, Serialize};

use super::render::{
    render_compartment_at_tier, render_decayed_with_items, DecayRenderCompartment,
};
use crate::context_db::StoredCompartment;
use crate::head_memories::{self, Row};
use crate::memory;

pub(crate) const M0_ID: &str = "magic-context:m0";
pub(crate) const M1_ID: &str = "magic-context:m1";
/// The renderer's empty history block. Readers of stored baselines also use
/// these exact bytes to recognise history with no rendered summaries.
pub(crate) const HISTORY_EMPTY: &str = "<session-history></session-history>";
pub(crate) const M1_EMPTY: &str =
    "<session-history-since>(no new content since last materialization)</session-history-since>";
/// What the head shows, read fresh for each pass that builds a view.
pub struct Inputs<'a> {
    pub counter: crate::count::Counter,
    pub summaries: &'a [StoredCompartment],
    /// The rendered `<project-docs>` block, or empty.
    pub docs: &'a str,
    /// Every memory the head may show, at every level
    /// ([`head_memories::read_rows`]).
    pub rows: &'a [Row],
    /// Each category id's decay class in the session's memory profile.
    pub classes: &'a std::collections::HashMap<String, String>,
    /// When `m[0]` is rendered: drifting memories lose weight with the time
    /// since they were last met again.
    pub now_ms: i64,
    /// The current rows of memories the head shows that are no longer in
    /// `rows` (archived, merged away or expired).
    pub gone: &'a [Row],
    /// The history budget in the model provider's tokens, which `m[1]`'s
    /// size limits are measured against.
    pub history_budget_tokens: u64,
    /// The same budget in the counter's units; exact vocabularies need no conversion.
    pub history_local_budget_tokens: u64,
    /// The two budgets a person sets, joined into the one every level fills
    /// ([`head_memories::budget`]).
    pub memory_budget_tokens: u64,
    pub profile_budget_tokens: u64,
}

/// What the head shows for one memory.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Shown {
    /// The text the head shows, or, for a change shown only as a marker or
    /// counted in the aggregate line, the text that change was about.
    /// `level` is the memory's level when it isn't `project`, so a removal
    /// line can still name it after the row is deleted for good.
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        level: Option<String>,
    },
    /// The head says the memory was removed or merged away.
    Removed,
}

/// How a memory change is shown in `m[1]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Form {
    /// Its line in full.
    Full,
    /// One line saying the shown text is out of date.
    Marker,
    /// Counted in the one aggregate line at the end.
    Overflow,
}

/// Memory changes an earlier `m[1]` already shows. Shown changes never move
/// or shrink; only the aggregate line grows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Committed {
    pub form: Form,
    pub lines: Vec<String>,
    #[serde(default)]
    pub overflow_ids: Vec<i64>,
    #[serde(default)]
    pub overflow_count: u64,
}

/// `m[0]` as rendered at the last fold, what the head shows of each memory,
/// and the memory changes shown in `m[1]` since.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Baseline {
    /// Per-summary attribution for the frozen baseline and its current delta.
    /// Older baselines have no attribution until the next head rebuild.
    #[serde(default)]
    pub summary_items: SummaryItems,
    /// The highest summary sequence in `m[0]`.
    pub through_sequence: i64,
    /// The highest memory id that existed at the fold. Only read for a
    /// baseline without `withheld`.
    pub max_memory_id: i64,
    /// The memories that could be shown at the fold but that `m[0]` left out
    /// for the memory budget; they wait for the next fold. Any other memory
    /// the head does not show, newer or older (restored, newly shared), is
    /// new to the head and goes to `m[1]`. `None` in a baseline from before
    /// this was recorded: every memory up to `max_memory_id` counts as
    /// withheld then.
    #[serde(default)]
    pub withheld: Option<BTreeSet<i64>>,
    /// What the head shows of each memory: `m[0]`'s text, then each change
    /// `m[1]` showed since.
    pub shown: BTreeMap<i64, Shown>,
    #[serde(serialize_with = "crate::store_text::text")]
    pub m0: String,
    #[serde(default)]
    pub committed: Vec<Committed>,
    /// The memory text the model reads in full: `m[0]`'s, then each change
    /// `m[1]` shows in full. A change shown only as a marker or counted in
    /// the aggregate line leaves the model without that memory's text.
    #[serde(default)]
    pub seen: BTreeMap<i64, String>,
    /// The settings `m[0]` was rendered under. When they change, `m[0]` is
    /// rendered again at once ([`Shape`]).
    #[serde(default)]
    pub shape: Option<Shape>,
    /// The checksum of the memory mural `m[0]` carries as an image, if any.
    /// It changes only when `m[0]` is rendered again; the image itself is
    /// kept apart from this record, which is saved often.
    #[serde(default)]
    pub mural: Option<String>,
    /// The format its memory blocks and records were written in
    /// ([`MEMORY_FORMAT`]). Absent, so 0, on baselines from before memory
    /// levels.
    #[serde(default)]
    pub memory_format: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SummaryItem {
    pub compartment_id: String,
    pub tier: u8,
    pub tokens: u64,
}

/// A baseline's per-summary attribution, one item per summary the head
/// renders. A session copies, compares and saves its baseline on every step,
/// while these items change only when the head is rendered again with other
/// summaries; holding them behind one shared pointer keeps those steps from
/// costing more as summaries accumulate. Their JSON is made once, when the
/// list is made, and a store save writes that copy.
#[derive(Clone)]
pub struct SummaryItems(Arc<SummaryItemList>);

struct SummaryItemList {
    items: Vec<SummaryItem>,
    /// `items` as serde_json writes them.
    json: Box<serde_json::value::RawValue>,
}

impl SummaryItems {
    pub fn new(items: Vec<SummaryItem>) -> Self {
        let json = serde_json::value::to_raw_value(&items).expect("summary items serialize");
        Self(Arc::new(SummaryItemList { items, json }))
    }

    /// Whether both are the one list a single [`SummaryItems::new`] made,
    /// which needs no look at the items.
    pub fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    /// A list whose saved JSON is `json` whatever the items say, to show
    /// that a store save writes the JSON made with the list.
    #[cfg(test)]
    pub(crate) fn with_json(items: Vec<SummaryItem>, json: &str) -> Self {
        let json = serde_json::value::RawValue::from_string(json.to_owned()).expect("JSON");
        Self(Arc::new(SummaryItemList { items, json }))
    }
}

impl Default for SummaryItems {
    fn default() -> Self {
        Self::new(Vec::new())
    }
}

impl std::ops::Deref for SummaryItems {
    type Target = [SummaryItem];
    fn deref(&self) -> &[SummaryItem] {
        &self.0.items
    }
}

impl std::fmt::Debug for SummaryItems {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.items.fmt(f)
    }
}

impl PartialEq for SummaryItems {
    fn eq(&self, other: &Self) -> bool {
        self.same(other) || self.0.items == other.0.items
    }
}

impl Eq for SummaryItems {}

impl Serialize for SummaryItems {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // A store save copies the JSON made with the list. Any other
        // serializer may not be serde_json's, which alone copies it verbatim.
        if crate::store_text::encoding() {
            self.0.json.serialize(serializer)
        } else {
            self.0.items.serialize(serializer)
        }
    }
}

impl<'de> Deserialize<'de> for SummaryItems {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Vec::<SummaryItem>::deserialize(deserializer).map(Self::new)
    }
}

/// The settings that decide what `m[0]` may hold. The plugin folds `m[0]` on
/// its own when one changes (`mustMaterialize`, `inject-compartments.ts`):
/// memory switched off (`render_config:memory_disabled`), or a different
/// memory or history budget (`render_config:budget`). Waiting for a natural
/// fold would keep showing memories the user just switched off.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Shape {
    pub memory_enabled: bool,
    pub memory_budget_tokens: u64,
    pub history_budget_tokens: u64,
    /// The configured `history_budget_percentage`, in basis points. Absent
    /// on baselines saved before it was recorded.
    #[serde(default)]
    pub history_budget_percentage_bp: Option<u64>,
    /// The user profile's budget, which joins the memory budget in the one
    /// selection every level fills. Absent on older baselines.
    #[serde(default)]
    pub profile_budget_tokens: Option<u64>,
}

/// The format of `m[0]`'s memory blocks and of a baseline's records of
/// what they show: 1 since every level is chosen together
/// ([`crate::head_memories`]) and the user profile's lines are global
/// memories with ids. A baseline in another format folds at once, because
/// its records can't be compared with today's rows; the change rewrites each
/// session's cached prefix once.
pub const MEMORY_FORMAT: u32 = 1;

impl Shape {
    /// Whether a baseline rendered under `self` must fold for `now`, as the
    /// plugin's budget identity decides. A change the user makes (memory
    /// on or off, the memory budget, the history percentage) folds. The
    /// history budget in tokens also moves with the window the runner
    /// reports, which a catalog refresh can change without any edit: that
    /// folds only when it shrinks by more than 64 tokens or 1%, whichever is
    /// larger (`renderedBudgetShrinkReason`), and growth never folds.
    pub fn requires_fold(&self, now: &Shape) -> bool {
        let shrank = self
            .history_budget_tokens
            .saturating_sub(now.history_budget_tokens)
            > 64.max(self.history_budget_tokens / 100);
        // With memory off, m[0] has no memory blocks, so the profile's budget
        // changes none of its bytes.
        let memory_blocks_changed = now.memory_enabled
            && matches!(
                (self.profile_budget_tokens, now.profile_budget_tokens),
                (Some(old), Some(new)) if old != new
            );
        self.memory_enabled != now.memory_enabled
            || self.memory_budget_tokens != now.memory_budget_tokens
            || memory_blocks_changed
            || matches!(
                (self.history_budget_percentage_bp, now.history_budget_percentage_bp),
                (Some(old), Some(new)) if old != new
            )
            || shrank
    }
}

impl Baseline {
    /// Whether the baseline must fold because its memory blocks and records
    /// are in an older format. With memory off its m[0] has no memory
    /// blocks, so the format changes none of its bytes.
    pub fn format_fold_due(&self, memory_enabled: bool) -> bool {
        memory_enabled && self.memory_format != MEMORY_FORMAT
    }

    /// The memory ids the head says anything about.
    pub fn shown_ids(&self) -> Vec<i64> {
        self.shown.keys().copied().collect()
    }
}

/// The `<session-history>` block within `budget` local tokens. The decay
/// render already fits the summaries' bodies to the budget, but its
/// estimate drifts and the wrapper adds a little, so a block more than 5%
/// over is rendered again against a budget 15% tighter, at most three times
/// (the plugin's `decayPressureMultiplier` loop in `materializeM0`).
fn fit_history(
    budget: f64,
    render: impl Fn(f64) -> String,
    estimate: impl Fn(&str) -> usize,
) -> String {
    let wrap = |history: String| {
        if history.is_empty() {
            HISTORY_EMPTY.to_owned()
        } else {
            format!("<session-history>\n{history}\n</session-history>")
        }
    };
    let mut multiplier = 1.0;
    let mut block = wrap(render(budget));
    let mut attempts = 0;
    while budget > 0.0 && estimate(&block) as f64 > budget * 1.05 && attempts < 3 {
        multiplier *= 1.15;
        block = wrap(render(budget / multiplier));
        attempts += 1;
    }
    block
}

/// Render a new baseline from everything current: a fold. `mural` is the
/// checksum of the mural image `m[0]` will carry, if any: the text then ends
/// with the block that introduces it, as the plugin's `renderM0` does.
pub fn fold(inputs: &Inputs, mural: Option<&str>) -> Baseline {
    fold_with(inputs, &shown_at_fold(inputs), mural)
}

/// [`fold`], given the memories it shows ([`shown_at_fold`] of the same
/// inputs), which the session also needs to draw the mural.
pub fn fold_with(inputs: &Inputs, shown: &HashSet<i64>, mural: Option<&str>) -> Baseline {
    let _timing = crate::notice_cost_timing::span("head.fold");
    let estimate = |text: &str| inputs.counter.count(text) as usize;
    let summaries: Vec<_> = inputs
        .summaries
        .iter()
        .map(DecayRenderCompartment::from)
        .collect();
    let rendered_items = std::cell::RefCell::new(Vec::new());
    let history = fit_history(
        inputs.history_local_budget_tokens as f64,
        |budget| {
            let (text, items) = render_decayed_with_items(&summaries, budget, estimate);
            *rendered_items.borrow_mut() = items;
            text
        },
        estimate,
    );
    let blocks = head_memories::render(inputs.rows, shown);
    let mut sections = Vec::new();
    if !inputs.docs.is_empty() {
        sections.push(inputs.docs.to_owned());
    }
    if !blocks.user_profile.is_empty() {
        sections.push(blocks.user_profile);
    }
    sections.push(history);
    for block in [blocks.workspace, blocks.project] {
        if !block.is_empty() {
            sections.push(block);
        }
    }
    if mural.is_some() {
        sections.push(crate::mural::BLOCK.to_owned());
    }
    let shown_rows = || inputs.rows.iter().filter(|row| shown.contains(&row.id));
    Baseline {
        summary_items: SummaryItems::new(
            rendered_items
                .into_inner()
                .into_iter()
                .map(|(i, tier, text)| SummaryItem {
                    compartment_id: inputs.summaries[i].sequence.to_string(),
                    tier,
                    tokens: inputs.counter.count(&text),
                })
                .collect(),
        ),
        through_sequence: inputs
            .summaries
            .last()
            .map_or(-1, |summary| summary.sequence),
        max_memory_id: inputs.rows.iter().map(|row| row.id).max().unwrap_or(0),
        withheld: Some(
            inputs
                .rows
                .iter()
                .map(|row| row.id)
                .filter(|id| !shown.contains(id))
                .collect(),
        ),
        shown: shown_rows()
            .map(|row| {
                (
                    row.id,
                    Shown::Text {
                        text: row.content.clone(),
                        level: shown_level(row),
                    },
                )
            })
            .collect(),
        m0: sections.join("\n\n").trim().to_owned(),
        committed: Vec::new(),
        seen: shown_rows()
            .map(|row| (row.id, row.content.clone()))
            .collect(),
        shape: None,
        mural: mural.map(str::to_owned),
        memory_format: MEMORY_FORMAT,
    }
}

/// A fold's choice among `inputs`' rows: the ones it shows, and the ones it
/// hides because they are past their time, resolved or overridden (not left
/// out for room).
pub struct Chosen {
    pub shown: HashSet<i64>,
    pub hidden: HashSet<i64>,
}

impl Chosen {
    /// The project memories the fold's text left out for room, which the
    /// mural draws instead. Every project row the head reads is the
    /// session's own project's.
    pub fn left_out(&self, rows: &[Row]) -> HashSet<i64> {
        rows.iter()
            .filter(|row| row.level == "project")
            .map(|row| row.id)
            .filter(|id| !self.shown.contains(id) && !self.hidden.contains(id))
            .collect()
    }
}

/// The rendering function's choice for a fold of `inputs`, among every row,
/// at the time the fold renders.
pub fn chosen_at_fold(inputs: &Inputs) -> Chosen {
    let selection = head_memories::choose(
        inputs.rows,
        inputs.classes,
        inputs.counter,
        &head_memories::budget(inputs.memory_budget_tokens, inputs.profile_budget_tokens),
        inputs.now_ms,
    );
    Chosen {
        shown: selection.ids.into_iter().collect(),
        hidden: selection.hidden.into_iter().collect(),
    }
}

/// The memories a fold of `inputs` shows.
pub fn shown_at_fold(inputs: &Inputs) -> HashSet<i64> {
    chosen_at_fold(inputs).shown
}

/// The level a baseline records for a memory it shows: none for a project
/// memory, the common case.
fn shown_level(row: &Row) -> Option<String> {
    (row.level != "project").then(|| row.level.clone())
}

const MEMORY_UPDATES_HEADER: &str =
    "These memories changed since the snapshot below — trust these:";
/// At most this many full change lines render in one `m[1]`.
const CORRECTION_RECORD_CAP: usize = 40;
/// Memory changes may use this share of the memory budget.
const CORRECTION_ALLOWANCE_RATIO: f64 = 0.25;
/// Below this many `m[0]` tokens the `m[1]`/`m[0]` ratio is not a useful bound.
const M0_DRIFT_RATIO_FLOOR_TOKENS: u64 = 500;
const M1_DRIFT_RATIO: f64 = 0.15;
/// `m[1]` may not exceed this share of the history budget.
const M1_ABSOLUTE_CAP_RATIO: f64 = 0.2;
/// Tokens kept for out-of-date markers, which full changes never use.
const MARKER_RESERVE_TOKENS: u64 = 200;
const OVERFLOW_ID_LIST_CHARS: usize = 120;

fn line_tokens(lines: &[String], counter: crate::count::Counter) -> u64 {
    lines
        .iter()
        .map(|line| counter.count(&format!("{line}\n")))
        .sum()
}

fn updates_block(lines: &[String]) -> String {
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "<memory-updates>\n{MEMORY_UPDATES_HEADER}\n{}\n</memory-updates>",
        lines.join("\n")
    )
}

/// One change to what the head shows of a memory.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Change {
    id: i64,
    line: String,
    /// What the head shows of the memory once this change is shown.
    after: Shown,
    /// The memory that now holds the current text, when there is one.
    current: Option<i64>,
}

/// Every difference between what the head shows and the current rows:
/// shown memories whose text changed, that were archived or merged away,
/// then memories newer than the fold that the head does not show yet. In
/// memory-id order, so the same rows always give the same changes.
fn changes(baseline: &Baseline, inputs: &Inputs) -> Vec<Change> {
    // A baseline in an older memory format doesn't record every level its
    // m[0] shows, so it can't say what changed; its fold comes first.
    if baseline.memory_format != MEMORY_FORMAT {
        return Vec::new();
    }
    let current: BTreeMap<i64, &Row> = inputs.rows.iter().map(|row| (row.id, row)).collect();
    let gone: BTreeMap<i64, &Row> = inputs.gone.iter().map(|row| (row.id, row)).collect();
    let mut out = Vec::new();
    for (id, shown) in &baseline.shown {
        match (current.get(id), shown) {
            (Some(row), Shown::Text { text, .. }) if row.content == *text => {}
            (Some(row), _) => out.push(Change {
                id: *id,
                line: memory::updated_line(*id, &row.level, Some(&row.tag), &row.content),
                after: Shown::Text {
                    text: row.content.clone(),
                    level: shown_level(row),
                },
                current: Some(*id),
            }),
            (None, Shown::Removed) => {}
            (None, Shown::Text { level: shown, .. }) => {
                let row = gone.get(id);
                // A row deleted for good is gone from the store too; the level
                // the head showed it at still names its block.
                let level = row.map_or_else(
                    || shown.as_deref().unwrap_or("project"),
                    |row| row.level.as_str(),
                );
                let by = row.and_then(|row| row.superseded_by);
                out.push(Change {
                    id: *id,
                    line: match by {
                        Some(by) => memory::superseded_line(*id, level, by),
                        None => memory::removed_line(*id, level),
                    },
                    after: Shown::Removed,
                    current: by,
                });
            }
        }
    }
    for row in inputs.rows {
        let withheld = match &baseline.withheld {
            Some(withheld) => withheld.contains(&row.id),
            None => row.id <= baseline.max_memory_id,
        };
        if !withheld && !baseline.shown.contains_key(&row.id) {
            out.push(Change {
                id: row.id,
                line: memory::added_line(row.id, &row.level, Some(&row.tag), &row.content),
                after: Shown::Text {
                    text: row.content.clone(),
                    level: shown_level(row),
                },
                current: Some(row.id),
            });
        }
    }
    out
}

/// One short line for a change whose full line does not fit: the shown
/// text of this memory is out of date, and `ctx_search` has the current
/// text.
fn stale_marker(change: &Change) -> String {
    let current = change
        .current
        .map(|id| format!(" current=\"{id}\""))
        .unwrap_or_default();
    format!(
        "  <stale-memory ids=\"{}\"{current} read-with=\"ctx_search\"/>",
        change.id
    )
}

/// The one line that stands for every change that did not fit even as a
/// marker.
fn overflow_line(ids: &[i64], count: u64) -> String {
    let mut seen = HashSet::new();
    let mut listed = String::new();
    for id in ids.iter().filter(|id| seen.insert(**id)) {
        let next = if listed.is_empty() {
            id.to_string()
        } else {
            format!("{listed},{id}")
        };
        if next.len() > OVERFLOW_ID_LIST_CHARS {
            listed.push_str(",…");
            break;
        }
        listed = next;
    }
    format!(
        "  <more-memory-edits count=\"{count}\" ids=\"{listed}\" note=\"{count} more memory edits apply at the next rebuild; read them with ctx_search\"/>"
    )
}

/// What newer summaries add to `m[1]`, and the baseline's summary
/// attribution with them: the items `m[0]` renders, then one per newer
/// summary at full detail. It depends only on the baseline's items and
/// `through_sequence`, the summaries and the counter, so a session keeps it
/// between view builds instead of rendering and counting newer summaries on
/// every build ([`newer_summaries`]).
#[derive(Clone, Debug)]
pub struct NewerSummaries {
    /// The `<new-compartments>` block, when a newer summary has content.
    block: Option<String>,
    items: SummaryItems,
}

impl NewerSummaries {
    /// The attribution a baseline carries once `m[1]` shows these summaries.
    pub fn items(&self) -> &SummaryItems {
        &self.items
    }
}

/// The summaries newer than `baseline`'s `m[0]`, rendered for `m[1]`, and
/// the attribution that goes with them. A baseline that already carries the
/// returned items gives the same result again.
pub fn newer_summaries(
    baseline: &Baseline,
    summaries: &[StoredCompartment],
    counter: crate::count::Counter,
) -> NewerSummaries {
    // Summaries are kept in sequence order, so the newer ones are found by a
    // binary search rather than a look at every summary.
    debug_assert!(summaries
        .windows(2)
        .all(|pair| pair[0].sequence <= pair[1].sequence));
    let first = summaries.partition_point(|summary| summary.sequence <= baseline.through_sequence);
    let mut texts = Vec::new();
    let mut newer = Vec::new();
    for summary in &summaries[first..] {
        let rendered = DecayRenderCompartment::from(summary);
        if rendered.is_no_content() {
            continue;
        }
        let text = render_compartment_at_tier(&rendered, 1);
        newer.push(SummaryItem {
            compartment_id: summary.sequence.to_string(),
            tier: 1,
            tokens: counter.count(&text),
        });
        texts.push(text);
    }
    // The items `m[0]` renders; an earlier `m[1]`'s items are replaced.
    let in_m0 = |item: &&SummaryItem| {
        item.compartment_id
            .parse::<i64>()
            .is_ok_and(|id| id <= baseline.through_sequence)
    };
    let items = if newer.is_empty()
        && baseline.summary_items.iter().filter(in_m0).count() == baseline.summary_items.len()
    {
        baseline.summary_items.clone()
    } else {
        SummaryItems::new(
            baseline
                .summary_items
                .iter()
                .filter(in_m0)
                .cloned()
                .chain(newer)
                .collect(),
        )
    };
    NewerSummaries {
        block: (!texts.is_empty()).then(|| {
            format!(
                "<new-compartments>\n{}\n</new-compartments>",
                texts.join("\n\n")
            )
        }),
        items,
    }
}

/// `m[1]`, and the baseline that records what it shows, for a pass that
/// builds a view.
///
/// Between folds `m[1]` shows newer summaries and every memory change since
/// the fold, at any level (the user profile's lines are global memories),
/// whoever made it: an agent in this or another session, the historian,
/// the dreamer or the person in the apps. `m[0]`
/// cannot change between folds, so a change to a memory it shows is stated
/// here. Each change shows in full while it fits a share of the memory
/// budget, then as a one-line marker, then in one aggregate line; what an
/// earlier `m[1]` showed stays byte for byte.
/// Also returns `m[1]`'s size without its memory changes, which is what the
/// refold backstop measures ([`needs_refold`]).
pub fn delta(baseline: &Baseline, inputs: &Inputs) -> (String, Baseline, u64) {
    delta_with(
        baseline,
        inputs,
        &newer_summaries(baseline, inputs.summaries, inputs.counter),
    )
}

/// [`delta`], given what [`newer_summaries`] returns for the same baseline,
/// summaries and counter.
pub fn delta_with(
    baseline: &Baseline,
    inputs: &Inputs,
    newer: &NewerSummaries,
) -> (String, Baseline, u64) {
    let _timing = crate::notice_cost_timing::span("head.delta");
    let tokens = |text: &str| inputs.counter.count(text);
    let line_tokens = |lines: &[String]| line_tokens(lines, inputs.counter);
    let mut next = baseline.clone();
    next.summary_items = newer.items.clone();
    let mut blocks: Vec<String> = newer.block.iter().cloned().collect();
    let independent = if blocks.is_empty() {
        0
    } else {
        tokens(&format!(
            "<session-history-since>\n{}\n</session-history-since>",
            blocks.join("\n")
        ))
    };

    next.committed.retain(|entry| entry.form != Form::Overflow);
    let mut overflow = baseline
        .committed
        .iter()
        .find(|entry| entry.form == Form::Overflow)
        .cloned();
    let pending = changes(baseline, inputs);
    if !pending.is_empty() {
        let lines_of = |form: Form, entries: &[Committed]| -> Vec<String> {
            entries
                .iter()
                .filter(|entry| entry.form == form)
                .flat_map(|entry| entry.lines.clone())
                .collect()
        };
        let mut used_full = tokens(&format!(
            "<memory-updates>\n{MEMORY_UPDATES_HEADER}\n</memory-updates>\n"
        )) + line_tokens(&lines_of(Form::Full, &next.committed));
        let mut used_markers = line_tokens(&lines_of(Form::Marker, &next.committed));
        let mut full_count = lines_of(Form::Full, &next.committed).len();
        // Changes at every level share one allowance, from the one budget
        // every level fills.
        let allowance = ((inputs.memory_budget_tokens + inputs.profile_budget_tokens) as f64
            * CORRECTION_ALLOWANCE_RATIO) as u64;
        let marker_reserve = MARKER_RESERVE_TOKENS.min(allowance / 2);
        let mut cap = inputs.history_budget_tokens as f64 * M1_ABSOLUTE_CAP_RATIO;
        let m0_tokens = tokens(&baseline.m0);
        if m0_tokens >= M0_DRIFT_RATIO_FLOOR_TOKENS {
            cap = cap.min(m0_tokens as f64 * M1_DRIFT_RATIO);
        }
        let headroom = (cap - independent as f64).max(0.0) as u64;
        let full_budget = (allowance - marker_reserve).min(headroom);
        for change in pending {
            next.shown.insert(change.id, change.after.clone());
            next.seen.remove(&change.id);
            if overflow.is_none() {
                let line = vec![change.line.clone()];
                let cost = line_tokens(&line);
                if used_full + cost <= full_budget && full_count < CORRECTION_RECORD_CAP {
                    if let Shown::Text { text, .. } = &change.after {
                        next.seen.insert(change.id, text.clone());
                    }
                    next.committed.push(Committed {
                        form: Form::Full,
                        lines: line,
                        overflow_ids: Vec::new(),
                        overflow_count: 0,
                    });
                    used_full += cost;
                    full_count += 1;
                    continue;
                }
                let marker = vec![stale_marker(&change)];
                let marker_cost = line_tokens(&marker);
                if used_markers + marker_cost <= marker_reserve {
                    next.committed.push(Committed {
                        form: Form::Marker,
                        lines: marker,
                        overflow_ids: Vec::new(),
                        overflow_count: 0,
                    });
                    used_markers += marker_cost;
                    continue;
                }
            }
            let entry = overflow.get_or_insert_with(|| Committed {
                form: Form::Overflow,
                lines: Vec::new(),
                overflow_ids: Vec::new(),
                overflow_count: 0,
            });
            entry.overflow_ids.push(change.id);
            entry.overflow_count += 1;
        }
    }
    if let Some(mut entry) = overflow {
        entry.lines = vec![overflow_line(&entry.overflow_ids, entry.overflow_count)];
        next.committed.push(entry);
    }
    let lines: Vec<String> = next
        .committed
        .iter()
        .flat_map(|entry| entry.lines.clone())
        .collect();
    let updates = updates_block(&lines);
    if !updates.is_empty() {
        blocks.insert(0, updates);
    }
    let text = if blocks.is_empty() {
        M1_EMPTY.to_owned()
    } else {
        format!(
            "<session-history-since>\n{}\n</session-history-since>",
            blocks.join("\n")
        )
    };
    (text, next, independent)
}

/// Whether a rebuild that would keep `m[0]` should fold instead, because
/// `m[1]` grew too large (the plugin's pressure backstop,
/// `inject-compartments.ts`). A session whose cache never expires would
/// otherwise never fold, and newer summaries would pile up in `m[1]` at full
/// detail. Either folds:
/// - `m[1]` over a fifth of the history budget;
/// - `m[1]` over 15% of `m[0]`, once `m[0]` holds at least 500 tokens (a
///   smaller `m[0]` would make that share trivially exceeded).
///
/// `pressure_tokens` is `m[1]`'s size without its memory changes, as
/// [`delta`] returns it. Memory changes have their own allowance and are
/// never a reason to fold, as in the plugin.
pub fn needs_refold(
    baseline: &Baseline,
    pressure_tokens: u64,
    history_budget_tokens: u64,
    counter: crate::count::Counter,
) -> bool {
    if pressure_tokens == 0 {
        return false;
    }
    let m1_tokens = pressure_tokens as f64;
    let m0_tokens = counter.count(&baseline.m0);
    m1_tokens > history_budget_tokens as f64 * M1_ABSOLUTE_CAP_RATIO
        || (m0_tokens >= M0_DRIFT_RATIO_FLOOR_TOKENS
            && m1_tokens > m0_tokens as f64 * M1_DRIFT_RATIO)
}

/// `m[0]` and `m[1]` as view edits, in that order. `m[0]` carries the mural
/// image, if any, after its text.
///
/// Summaries, memories, the profile and project docs can quote a tag (a
/// person typing "expand §1234§", a memory about placeholders). An
/// inserted message may hold no tag notation (compaction contract W6.4,
/// `tagged_insert`): a quoted number would mislead the model's own count.
/// So the head shows each quoted tag as its bare number.
pub fn head_ops(m0: &str, m1: &str, mural: Option<InsertedImage>) -> Vec<EditOp> {
    let m0 = InsertedMessage::new(
        M0_ID,
        Role::User,
        vec![crate::neutral::without_tag_notation(m0)],
    )
    .with_images(mural.into_iter().collect());
    let m1 = InsertedMessage::new(
        M1_ID,
        Role::User,
        vec![crate::neutral::without_tag_notation(m1)],
    );
    [m0, m1]
        .into_iter()
        .map(|message| EditOp::Insert {
            at: InsertAt::Start,
            message,
        })
        .collect()
}

/// Whether an edit is part of the history head.
pub fn is_head(op: &EditOp) -> bool {
    matches!(op, EditOp::Insert { message, .. } if message.id == M0_ID || message.id == M1_ID)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_head_shows_quoted_tags_as_bare_numbers() {
        let text = "read [dropped §7§] and §§12§ but keep §x§, § and §§";
        assert_eq!(
            crate::neutral::without_tag_notation(text),
            "read [dropped 7] and §12 but keep §x§, § and §§"
        );
        for op in head_ops(text, text, None) {
            let EditOp::Insert { message, .. } = op else {
                panic!("head ops are inserts");
            };
            assert!(message
                .texts
                .iter()
                .all(|text| cortexkit_compaction_view::tags::tag_notation_in(text).is_empty()));
        }
    }

    #[test]
    fn an_overshooting_history_block_is_rendered_again_under_more_pressure() {
        // A stand-in render that fills its budget exactly, at four characters
        // a token: only the wrapper takes the block over.
        let estimate = |text: &str| text.len() / 4;
        let budgets = std::cell::RefCell::new(Vec::new());
        let render = |budget: f64| {
            budgets.borrow_mut().push(budget);
            "x".repeat(budget as usize * 4)
        };
        // 100 tokens of body plus the wrapper is about 9% over: once more,
        // 15% tighter, and it fits.
        let block = fit_history(100.0, render, estimate);
        assert_eq!(budgets.borrow().len(), 2, "{:?}", budgets.borrow());
        assert!((budgets.borrow()[1] - 100.0 / 1.15).abs() < 1e-9);
        assert!(estimate(&block) as f64 <= 105.0);
        // A large budget absorbs the wrapper: one render.
        budgets.borrow_mut().clear();
        fit_history(1000.0, render, estimate);
        assert_eq!(budgets.borrow().len(), 1);
        // It stops after three tries even when nothing fits.
        budgets.borrow_mut().clear();
        fit_history(
            10.0,
            |budget| {
                budgets.borrow_mut().push(budget);
                "x".repeat(400)
            },
            estimate,
        );
        assert_eq!(budgets.borrow().len(), 4);
    }
    fn summary(sequence: i64, start: i64, end: i64) -> StoredCompartment {
        StoredCompartment {
            sequence,
            start_message: start,
            end_message: end,
            title: format!("Part {sequence}"),
            content: format!("Body {sequence}"),
            p1: Some(format!("Body {sequence}")),
            p2: Some(format!("Short {sequence}")),
            p3: Some(format!("Shorter {sequence}")),
            p4: Some(String::new()),
            importance: 50,
            ..StoredCompartment::default()
        }
    }

    fn memory(id: i64, content: &str) -> Row {
        Row::from_stored(
            "project",
            &crate::context_db::StoredMemory {
                id,
                project_path: "pj".into(),
                category: "PROJECT_RULES".into(),
                content: content.into(),
                importance: Some(70),
                status: "active".into(),
                ..crate::context_db::StoredMemory::default()
            },
        )
    }

    fn profile_line(id: i64, content: &str) -> Row {
        Row {
            level: "global".into(),
            owner: "self".into(),
            tag: "USER".into(),
            ..memory(id, content)
        }
    }

    static NO_CLASSES: std::sync::LazyLock<std::collections::HashMap<String, String>> =
        std::sync::LazyLock::new(Default::default);

    fn inputs<'a>(summaries: &'a [StoredCompartment], rows: &'a [Row]) -> Inputs<'a> {
        Inputs {
            counter: crate::count::Counter::for_model(None),
            summaries,
            docs: "",
            rows,
            classes: &NO_CLASSES,
            now_ms: 0,
            gone: &[],
            history_budget_tokens: 60_000,
            history_local_budget_tokens: 60_000,
            memory_budget_tokens: 4_000,
            profile_budget_tokens: 4_000,
        }
    }

    /// Building `m[1]` again with no newer summary copies no summary
    /// attribution: the next baseline shares the list `m[0]`'s fold made.
    /// A newer summary makes one new list, which `m[1]`'s next build with
    /// the same summaries makes again item for item.
    #[test]
    fn m1_with_no_newer_summary_shares_the_baselines_summary_items() {
        let summaries = [summary(1, 1, 4), summary(2, 5, 8), summary(3, 9, 12)];
        let base = fold(&inputs(&summaries[..2], &[]), None);
        assert_eq!(base.summary_items.len(), 2);
        let (_, next, _) = delta(&base, &inputs(&summaries[..2], &[]));
        assert!(next.summary_items.same(&base.summary_items));

        let (m1, shown, _) = delta(&base, &inputs(&summaries, &[]));
        assert!(m1.contains("Body 3"), "{m1}");
        assert!(!shown.summary_items.same(&base.summary_items));
        let ids: Vec<_> = shown
            .summary_items
            .iter()
            .map(|item| item.compartment_id.as_str())
            .collect();
        assert_eq!(ids, ["1", "2", "3"]);
        let again = newer_summaries(&shown, &summaries, inputs(&[], &[]).counter);
        assert_eq!(again.items(), &shown.summary_items);
    }

    #[test]
    fn m1_shows_every_change_since_the_fold_and_a_fold_takes_them_in() {
        let summaries = vec![summary(0, 1, 4), summary(1, 5, 9)];
        let at_fold = vec![memory(1, "ask first"), memory(2, "old naming rule")];
        let baseline = fold(&inputs(&summaries[..1], &at_fold), None);
        assert!(baseline.m0.contains("Part 0") && baseline.m0.contains("#1: ask first"));
        assert_eq!(
            delta(&baseline, &inputs(&summaries[..1], &at_fold)).0,
            M1_EMPTY
        );

        // Another writer adds memory 3, changes 1 and merges 2 into 3.
        let now = vec![
            memory(1, "ask before every push"),
            memory(3, "new naming rule"),
        ];
        let mut merged = memory(2, "old naming rule");
        merged.status = "archived".into();
        merged.superseded_by = Some(3);
        let gone = [merged];
        let mut current = inputs(&summaries, &now);
        current.gone = &gone;
        let (m1, next, _) = delta(&baseline, &current);
        assert!(m1.contains("Part 1"), "{m1}");
        assert!(
            m1.contains(
                r#"<updated id="1" level="project" category="PROJECT_RULES">ask before every push</updated>"#
            ),
            "{m1}"
        );
        assert!(
            m1.contains(r#"<superseded id="2" level="project" by="3"/>"#),
            "{m1}"
        );
        assert!(
            m1.contains(
                r#"<added id="3" level="project" category="PROJECT_RULES">new naming rule</added>"#
            ),
            "{m1}"
        );

        // Nothing new: the same m[1], byte for byte.
        assert_eq!(delta(&next, &current).0, m1);

        let refolded = fold(&inputs(&summaries, &now), None);
        assert!(
            refolded.m0.contains("#1: ask before every push")
                && refolded.m0.contains("#3: new naming rule")
        );
        assert_eq!(delta(&refolded, &inputs(&summaries, &now)).0, M1_EMPTY);
    }

    #[test]
    fn changes_show_in_full_then_as_markers_then_in_one_line_and_never_move() {
        let baseline = fold(&inputs(&[], &[]), None);
        // Varied words, so a line costs real tokens: one fits the full budget, two do not.
        let text = |id: i64| {
            (0..15)
                .map(|word| format!("fact{id}w{word}"))
                .collect::<Vec<_>>()
                .join(" ")
        };
        let first = vec![memory(1, &text(1))];
        let mut small = inputs(&[], &first);
        small.memory_budget_tokens = 1_000;
        small.profile_budget_tokens = 0;
        let (m1, next, _) = delta(&baseline, &small);
        assert!(m1.contains(&text(1)), "{m1}");
        let many: Vec<Row> = (1..40).map(|id| memory(id, &text(id))).collect();
        let mut later = inputs(&[], &many);
        later.memory_budget_tokens = 1_000;
        later.profile_budget_tokens = 0;
        let (m1_later, after, _) = delta(&next, &later);
        let shown_before = &m1[..m1.find("\n</memory-updates>").unwrap()];
        assert!(m1_later.starts_with(shown_before), "{m1_later}");
        assert!(!m1_later.contains(&text(2)), "{m1_later}");
        assert!(m1_later.contains(r#"<stale-memory ids="2""#), "{m1_later}");
        assert!(
            m1_later.contains(r#"<more-memory-edits count=""#),
            "{m1_later}"
        );
        assert_eq!(after.committed.last().unwrap().form, Form::Overflow);
        // A change shown as a marker or counted is not shown again.
        assert_eq!(delta(&after, &later).0, m1_later);
    }

    #[test]
    fn a_large_m1_folds_instead_of_refreshing_m1() {
        let words = |n: usize| "word ".repeat(n);
        let small_m0 = Baseline {
            m0: words(10),
            ..Baseline::default()
        };
        let big_m0 = Baseline {
            m0: words(4_000),
            ..Baseline::default()
        };
        // Nothing new: never.
        assert!(!needs_refold(
            &big_m0,
            0,
            10_000,
            crate::count::Counter::for_model(None)
        ));
        // Over 15% of a large m[0].
        let big_m0_tokens = crate::count::Counter::for_model(None).count(&big_m0.m0);
        assert!(needs_refold(
            &big_m0,
            big_m0_tokens / 5,
            1_000_000,
            crate::count::Counter::for_model(None)
        ));
        // A small m[0] does not count the share; a fifth of the history
        // budget does.
        assert!(!needs_refold(
            &small_m0,
            300,
            10_000,
            crate::count::Counter::for_model(None)
        ));
        assert!(needs_refold(
            &small_m0,
            3_000,
            10_000,
            crate::count::Counter::for_model(None)
        ));
    }

    /// A user profile line is a global memory: `m[0]` shows it in the
    /// profile block, and editing it in place shows in `m[1]` as one
    /// `updated` line at the global level, like any memory's edit.
    #[test]
    fn an_edited_profile_line_shows_in_m1_as_a_global_memory() {
        let before = [
            profile_line(1, "prefers tea"),
            profile_line(2, "works late"),
        ];
        let at_fold = inputs(&[], &before);
        let baseline = fold(&at_fold, None);
        assert!(
            baseline
                .m0
                .contains("<user-profile>\n#1: prefers tea\n#2: works late\n</user-profile>"),
            "{}",
            baseline.m0
        );
        assert_eq!(delta(&baseline, &at_fold).0, M1_EMPTY);
        let after = [
            profile_line(1, "prefers coffee"),
            profile_line(2, "works late"),
        ];
        let (m1, _, _) = delta(&baseline, &inputs(&[], &after));
        assert!(
            m1.contains(
                r#"<updated id="1" level="global" category="USER">prefers coffee</updated>"#
            ),
            "{m1}"
        );
        assert!(!m1.contains("works late"), "{m1}");
    }

    /// Memory changes alone never fold, however many there are: they have
    /// their own allowance, and `delta` leaves them out of the size it
    /// returns.
    #[test]
    fn memory_changes_alone_never_fold() {
        let baseline = fold(&inputs(&[], &[]), None);
        let edits: Vec<Row> = (1..=60)
            .map(|id| memory(id, &format!("fact number {id} with some detail")))
            .collect();
        let (m1, _, pressure) = delta(&baseline, &inputs(&[], &edits));
        assert!(m1.contains("<memory-updates>"));
        assert_eq!(pressure, 0);
        assert!(!needs_refold(
            &baseline,
            pressure,
            1_000,
            crate::count::Counter::for_model(None)
        ));
    }
    #[test]
    fn exact_opus_head_fits_memories_in_real_tokens() {
        let model = "anthropic/claude-opus-5-5";
        let detail = "Read crates/mc-module/src/session.rs and traced the notice through summary_due. The cached prefix must replay byte-identically; pending reductions ride the next authorized rebuild. Added a regression test around the tool result and ran cargo test --locked. ";
        let summaries: Vec<_> = (0..12)
            .map(|sequence| {
                let mut row = summary(sequence, sequence * 20 + 1, sequence * 20 + 20);
                row.content = detail.repeat(8);
                row.p1 = Some(detail.repeat(8));
                row.p2 = Some(detail.repeat(4));
                row.p3 = Some(detail.repeat(2));
                row.p4 = Some(detail.to_owned());
                row
            })
            .collect();
        let memories: Vec<_> = (1..=30).map(|id| memory(id, "Keep session-history stable on deferred notices. Run filtered Rust tests on Linux and never rewrite a signed thinking prefix.")).collect();
        let mut exact_inputs = inputs(&summaries, &memories);
        exact_inputs.counter = crate::count::Counter::for_model(Some(model));
        exact_inputs.history_budget_tokens = 2000;
        exact_inputs.history_local_budget_tokens =
            crate::summary::render::history_local_budget(2000.0, Some(model)) as u64;
        exact_inputs.memory_budget_tokens = 500;
        exact_inputs.profile_budget_tokens = 0;
        let mut old_inputs = Inputs {
            counter: crate::count::Counter::estimated_for_model(Some(model)),
            ..exact_inputs
        };
        old_inputs.history_local_budget_tokens = crate::calibration::local_budget(
            2000.0,
            crate::calibration::DecisionCalibration::for_model(Some(model)).prose_ratio,
        ) as u64;
        let exact = fold(&exact_inputs, None);
        let old = fold(&old_inputs, None);
        let block = |text: &str, name: &str| {
            let start = text.find(&format!("<{name}>")).unwrap();
            let end = text.find(&format!("</{name}>")).unwrap() + name.len() + 3;
            text[start..end].to_owned()
        };
        let exact_memory = block(&exact.m0, "project-memory");
        let old_memory = block(&old.m0, "project-memory");
        let exact_history = block(&exact.m0, "session-history");
        let old_history = block(&old.m0, "session-history");
        println!("OPUS_HEAD old_memories={} exact_memories={} old_memory_bytes={} exact_memory_bytes={} old_history_bytes={} exact_history_bytes={}", old.shown.len(), exact.shown.len(), old_memory.len(), exact_memory.len(), old_history.len(), exact_history.len());
        assert_eq!(
            (old.shown.len(), exact.shown.len()),
            (16, 9),
            "the old estimator admits seven memories that do not fit in real tokens"
        );
        assert_eq!(exact_history.len(), 5243);
        assert_eq!(exact_inputs.history_local_budget_tokens, 2000);
    }
}
