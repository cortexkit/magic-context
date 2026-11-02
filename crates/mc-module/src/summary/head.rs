//! The history head: two messages a view inserts at the start of the
//! request.
//!
//! - `m[0]`, the baseline: the project docs, the user profile, every summary
//!   as of the last fold (each at the detail tier its age and importance
//!   earn under the history budget), and the project memories that fit
//!   their budget. Its text is kept as rendered and changes only on a fold,
//!   when the provider cache is lost anyway.
//! - `m[1]`, what changed since: memory corrections, newer summaries at full
//!   detail, newer memories and profile lines, or a short placeholder.
//!   Changing it rewrites the request from `m[1]` on, not from the start.
//!
//! The blocks, wrappers and budgets are the TypeScript plugin's, so a head
//! reads the same in both.

use std::collections::{BTreeMap, HashSet};

use cortexkit_role_compaction::read::Role;
use cortexkit_role_compaction::view::{EditOp, InsertAt, InsertedMessage};
use serde::{Deserialize, Serialize};

use super::render::{
    render_compartment_at_tier, render_stored_compartments, DecayRenderCompartment,
};
use crate::context_db::{StoredCompartment, StoredMemory};
use crate::memory;

const M0_ID: &str = "magic-context:m0";
const M1_ID: &str = "magic-context:m1";
const HISTORY_EMPTY: &str = "<session-history></session-history>";
const M1_EMPTY: &str =
    "<session-history-since>(no new content since last materialization)</session-history-since>";
/// Newer memories and profile lines in `m[1]` get this share of their
/// budgets; the rest waits for the next fold.
const DELTA_SHARE: f64 = 0.25;

/// What the head shows, read fresh for each pass that builds a view.
pub struct Inputs<'a> {
    pub summaries: &'a [StoredCompartment],
    /// The rendered `<project-docs>` block, or empty.
    pub docs: &'a str,
    /// The active user profile, oldest first, and its highest id.
    pub profile: &'a [String],
    pub profile_max_id: i64,
    /// Every project memory that may be shown.
    pub memories: &'a [StoredMemory],
    /// The current rows of memories the head shows that are no longer in
    /// `memories` (archived, merged away or expired).
    pub gone: &'a [StoredMemory],
    /// The history budget in the model provider's tokens, which `m[1]`'s
    /// size limits are measured against.
    pub history_budget_tokens: u64,
    /// The same budget in the local estimator's tokens, which the summaries
    /// in `m[0]` are rendered against (`history_local_budget`): the plugin
    /// converts it, so a model whose tokens are larger gets less detail.
    pub history_local_budget_tokens: u64,
    pub memory_budget_tokens: u64,
    pub profile_budget_tokens: u64,
}

/// A checksum of the user profile's text, so any change to it, by any
/// writer, shows in `m[1]` (an id high-water mark misses edits and archives).
fn profile_digest(profile: &[String]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for line in profile {
        hasher.update(line.as_bytes());
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

/// What the head shows for one memory.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Shown {
    /// The text the head shows, or, for a change shown only as a marker or
    /// counted in the aggregate line, the text that change was about.
    Text { text: String },
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
    /// The highest summary sequence in `m[0]`.
    pub through_sequence: i64,
    /// The highest memory id that existed at the fold. A newer memory is
    /// one `m[0]` could not show; an older one left out of `m[0]` was left
    /// out by the memory budget and waits for the next fold.
    pub max_memory_id: i64,
    /// What the head shows of each memory: `m[0]`'s text, then each change
    /// `m[1]` showed since.
    pub shown: BTreeMap<i64, Shown>,
    pub profile_max_id: i64,
    /// [`profile_digest`] of the profile `m[0]` was rendered from. A baseline
    /// from before it was recorded compares `profile_max_id` instead.
    #[serde(default)]
    pub profile_digest: Option<String>,
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
}

impl Baseline {
    /// The memory ids the head says anything about.
    pub fn shown_ids(&self) -> Vec<i64> {
        self.shown.keys().copied().collect()
    }
}

/// Render a new baseline from everything current: a fold.
pub fn fold(inputs: &Inputs) -> Baseline {
    let history = render_stored_compartments(
        inputs.summaries,
        inputs.history_local_budget_tokens as f64,
        mc_tokenizer::estimate_tokens,
    );
    let memories = memory::trim_to_budget(inputs.memories.to_vec(), inputs.memory_budget_tokens);
    let profile = memory::trim_profile(inputs.profile.to_vec(), inputs.profile_budget_tokens);
    let mut sections = Vec::new();
    if !inputs.docs.is_empty() {
        sections.push(inputs.docs.to_owned());
    }
    let profile_block = memory::render_profile(&profile, "user-profile");
    if !profile_block.is_empty() {
        sections.push(profile_block);
    }
    sections.push(if history.is_empty() {
        HISTORY_EMPTY.to_owned()
    } else {
        format!("<session-history>\n{history}\n</session-history>")
    });
    let memory_block = memory::render_block(&memories, "project-memory");
    if !memory_block.is_empty() {
        sections.push(memory_block);
    }
    Baseline {
        through_sequence: inputs
            .summaries
            .last()
            .map_or(-1, |summary| summary.sequence),
        max_memory_id: inputs
            .memories
            .iter()
            .map(|memory| memory.id)
            .max()
            .unwrap_or(0),
        shown: memories
            .iter()
            .map(|memory| {
                (
                    memory.id,
                    Shown::Text {
                        text: memory.content.clone(),
                    },
                )
            })
            .collect(),
        profile_max_id: inputs.profile_max_id,
        profile_digest: Some(profile_digest(inputs.profile)),
        m0: sections.join("\n\n").trim().to_owned(),
        committed: Vec::new(),
        seen: memories
            .iter()
            .map(|memory| (memory.id, memory.content.clone()))
            .collect(),
        shape: None,
    }
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

fn tokens(text: &str) -> u64 {
    mc_tokenizer::estimate_tokens(text) as u64
}

fn line_tokens(lines: &[String]) -> u64 {
    lines.iter().map(|line| tokens(&format!("{line}\n"))).sum()
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
    let current: BTreeMap<i64, &StoredMemory> = inputs
        .memories
        .iter()
        .map(|memory| (memory.id, memory))
        .collect();
    let gone: BTreeMap<i64, &StoredMemory> = inputs
        .gone
        .iter()
        .map(|memory| (memory.id, memory))
        .collect();
    let mut out = Vec::new();
    for (id, shown) in &baseline.shown {
        match (current.get(id), shown) {
            (Some(memory), Shown::Text { text }) if memory.content == *text => {}
            (Some(memory), _) => out.push(Change {
                id: *id,
                line: memory::updated_line(*id, Some(&memory.category), &memory.content),
                after: Shown::Text {
                    text: memory.content.clone(),
                },
                current: Some(*id),
            }),
            (None, Shown::Removed) => {}
            (None, Shown::Text { .. }) => {
                let by = gone
                    .get(id)
                    .and_then(|memory| memory.superseded_by_memory_id);
                out.push(Change {
                    id: *id,
                    line: match by {
                        Some(by) => memory::superseded_line(*id, by),
                        None => memory::removed_line(*id),
                    },
                    after: Shown::Removed,
                    current: by,
                });
            }
        }
    }
    for memory in inputs.memories {
        if memory.id > baseline.max_memory_id && !baseline.shown.contains_key(&memory.id) {
            out.push(Change {
                id: memory.id,
                line: memory::added_line(memory.id, Some(&memory.category), &memory.content),
                after: Shown::Text {
                    text: memory.content.clone(),
                },
                current: Some(memory.id),
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

/// `m[1]`, and the baseline that records what it shows, for a pass that
/// builds a view.
///
/// Between folds `m[1]` shows newer summaries, a changed user profile, and
/// every memory change since the fold, whoever made it: an agent in this or
/// another session, the historian, the dreamer or the dashboard. `m[0]`
/// cannot change between folds, so a change to a memory it shows is stated
/// here. Each change shows in full while it fits a share of the memory
/// budget, then as a one-line marker, then in one aggregate line; what an
/// earlier `m[1]` showed stays byte for byte.
/// Also returns `m[1]`'s size without its memory changes, which is what the
/// refold backstop measures ([`needs_refold`]).
pub fn delta(baseline: &Baseline, inputs: &Inputs) -> (String, Baseline, u64) {
    let mut next = baseline.clone();
    let mut blocks = Vec::new();
    let newer_summaries: Vec<String> = inputs
        .summaries
        .iter()
        .filter(|summary| summary.sequence > baseline.through_sequence)
        .map(DecayRenderCompartment::from)
        .filter(|summary| !summary.is_no_content())
        .map(|summary| render_compartment_at_tier(&summary, 1))
        .collect();
    if !newer_summaries.is_empty() {
        blocks.push(format!(
            "<new-compartments>\n{}\n</new-compartments>",
            newer_summaries.join("\n\n")
        ));
    }
    let profile_changed = match &baseline.profile_digest {
        Some(digest) => *digest != profile_digest(inputs.profile),
        None => inputs.profile_max_id != baseline.profile_max_id,
    };
    if profile_changed {
        let profile = memory::trim_profile(
            inputs.profile.to_vec(),
            ((inputs.profile_budget_tokens as f64 * DELTA_SHARE) as u64).max(1),
        );
        let block = memory::render_profile(&profile, "new-user-profile");
        if !block.is_empty() {
            blocks.push(block);
        }
    }
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
        let allowance = (inputs.memory_budget_tokens as f64 * CORRECTION_ALLOWANCE_RATIO) as u64;
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
                    if let Shown::Text { text } = &change.after {
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
pub fn needs_refold(baseline: &Baseline, pressure_tokens: u64, history_budget_tokens: u64) -> bool {
    if pressure_tokens == 0 {
        return false;
    }
    let m1_tokens = pressure_tokens as f64;
    let m0_tokens = tokens(&baseline.m0);
    m1_tokens > history_budget_tokens as f64 * M1_ABSOLUTE_CAP_RATIO
        || (m0_tokens >= M0_DRIFT_RATIO_FLOOR_TOKENS
            && m1_tokens > m0_tokens as f64 * M1_DRIFT_RATIO)
}

/// `m[0]` and `m[1]` as view edits, in that order.
pub fn head_ops(m0: &str, m1: &str) -> Vec<EditOp> {
    [(M0_ID, m0), (M1_ID, m1)]
        .into_iter()
        .map(|(id, text)| EditOp::Insert {
            at: InsertAt::Start,
            message: InsertedMessage::new(id, Role::User, vec![text.to_owned()]),
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

    fn memory(id: i64, content: &str) -> StoredMemory {
        StoredMemory {
            id,
            project_path: "pj".into(),
            category: "PROJECT_RULES".into(),
            content: content.into(),
            importance: Some(70),
            status: "active".into(),
            ..StoredMemory::default()
        }
    }

    fn inputs<'a>(summaries: &'a [StoredCompartment], memories: &'a [StoredMemory]) -> Inputs<'a> {
        Inputs {
            summaries,
            docs: "",
            profile: &[],
            profile_max_id: 0,
            memories,
            gone: &[],
            history_budget_tokens: 60_000,
            history_local_budget_tokens: 60_000,
            memory_budget_tokens: 4_000,
            profile_budget_tokens: 4_000,
        }
    }

    #[test]
    fn m1_shows_every_change_since_the_fold_and_a_fold_takes_them_in() {
        let summaries = vec![summary(0, 1, 4), summary(1, 5, 9)];
        let at_fold = vec![memory(1, "ask first"), memory(2, "old naming rule")];
        let baseline = fold(&inputs(&summaries[..1], &at_fold));
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
        merged.superseded_by_memory_id = Some(3);
        let gone = [merged];
        let mut current = inputs(&summaries, &now);
        current.gone = &gone;
        let (m1, next, _) = delta(&baseline, &current);
        assert!(m1.contains("Part 1"), "{m1}");
        assert!(
            m1.contains(
                r#"<updated id="1" category="PROJECT_RULES">ask before every push</updated>"#
            ),
            "{m1}"
        );
        assert!(m1.contains(r#"<superseded id="2" by="3"/>"#), "{m1}");
        assert!(
            m1.contains(r#"<added id="3" category="PROJECT_RULES">new naming rule</added>"#),
            "{m1}"
        );

        // Nothing new: the same m[1], byte for byte.
        assert_eq!(delta(&next, &current).0, m1);

        let refolded = fold(&inputs(&summaries, &now));
        assert!(
            refolded.m0.contains("#1: ask before every push")
                && refolded.m0.contains("#3: new naming rule")
        );
        assert_eq!(delta(&refolded, &inputs(&summaries, &now)).0, M1_EMPTY);
    }

    #[test]
    fn changes_show_in_full_then_as_markers_then_in_one_line_and_never_move() {
        let baseline = fold(&inputs(&[], &[]));
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
        let (m1, next, _) = delta(&baseline, &small);
        assert!(m1.contains(&text(1)), "{m1}");
        let many: Vec<StoredMemory> = (1..40).map(|id| memory(id, &text(id))).collect();
        let mut later = inputs(&[], &many);
        later.memory_budget_tokens = 1_000;
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
        assert!(!needs_refold(&big_m0, 0, 10_000));
        // Over 15% of a large m[0].
        let big_m0_tokens = tokens(&big_m0.m0);
        assert!(needs_refold(&big_m0, big_m0_tokens / 5, 1_000_000));
        // A small m[0] does not count the share; a fifth of the history
        // budget does.
        assert!(!needs_refold(&small_m0, 300, 10_000));
        assert!(needs_refold(&small_m0, 3_000, 10_000));
    }

    /// Editing a profile line in place, with no new row, still shows the
    /// profile again in `m[1]`.
    #[test]
    fn an_edited_profile_line_shows_in_m1() {
        let mut at_fold = inputs(&[], &[]);
        let before = ["prefers tea".to_owned(), "works late".to_owned()];
        at_fold.profile = &before;
        at_fold.profile_max_id = 2;
        let baseline = fold(&at_fold);
        assert_eq!(delta(&baseline, &at_fold).0, M1_EMPTY);
        let after = ["prefers coffee".to_owned(), "works late".to_owned()];
        let mut now = at_fold;
        now.profile = &after;
        let (m1, _, _) = delta(&baseline, &now);
        assert!(m1.contains("prefers coffee"), "{m1}");
    }

    /// Memory changes alone never fold, however many there are: they have
    /// their own allowance, and `delta` leaves them out of the size it
    /// returns.
    #[test]
    fn memory_changes_alone_never_fold() {
        let baseline = fold(&inputs(&[], &[]));
        let edits: Vec<StoredMemory> = (1..=60)
            .map(|id| memory(id, &format!("fact number {id} with some detail")))
            .collect();
        let (m1, _, pressure) = delta(&baseline, &inputs(&[], &edits));
        assert!(m1.contains("<memory-updates>"));
        assert_eq!(pressure, 0);
        assert!(!needs_refold(&baseline, pressure, 1_000));
    }
}
