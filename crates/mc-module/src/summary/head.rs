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

use std::collections::HashSet;

use ck_contract_draft::read::Role;
use ck_contract_draft::view::{EditOp, InsertAt, InsertedMessage};
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
    /// The newest memory-mutation-log entry, which a fold covers.
    pub mutation_cursor: i64,
    /// The session's newest memory fragment, which a fold covers.
    pub fragment_cursor: i64,
    pub history_budget_tokens: u64,
    pub memory_budget_tokens: u64,
    pub profile_budget_tokens: u64,
}

/// How a memory change is shown in `m[1]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Form {
    /// Its lines in full.
    Full,
    /// One line saying the shown text is out of date.
    Marker,
    /// Counted in the one aggregate line at the end.
    Overflow,
}

/// A memory change an earlier `m[1]` already shows. Shown changes never move
/// or shrink; only the aggregate line grows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Committed {
    /// The fragment id; for a dashboard change, 0.
    pub id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dashboard_log_id: Option<i64>,
    pub form: Form,
    pub lines: Vec<String>,
    /// Memory text this session now sees in full, by memory id.
    #[serde(default)]
    pub visible: Vec<(i64, String)>,
    #[serde(default)]
    pub overflow_ids: Vec<i64>,
    #[serde(default)]
    pub overflow_count: u64,
}

/// `m[0]` as rendered at the last fold, what it covered, and the memory
/// changes shown in `m[1]` since.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Baseline {
    /// The highest summary sequence in `m[0]`.
    pub through_sequence: i64,
    /// The highest memory id that existed at the fold.
    pub max_memory_id: i64,
    /// The memories `m[0]` shows, with the text it shows.
    pub shown_memories: Vec<(i64, String)>,
    /// The memory-mutation-log entry `m[0]` already reflects. Only dashboard
    /// edits after it are shown in `m[1]`.
    pub mutation_cursor: i64,
    /// The session's memory fragment `m[0]` already reflects.
    pub fragment_cursor: i64,
    pub profile_max_id: i64,
    pub m0: String,
    #[serde(default)]
    pub committed: Vec<Committed>,
}

impl Baseline {
    /// Whether the head shows memory `id` with exactly `text`.
    pub fn shows(&self, id: i64, text: &str) -> bool {
        let mut shown = self
            .shown_memories
            .iter()
            .find(|(shown, _)| *shown == id)
            .map(|(_, text)| text.as_str());
        for committed in &self.committed {
            if let Some((_, newer)) = committed.visible.iter().find(|(shown, _)| *shown == id) {
                shown = Some(newer);
            }
        }
        shown == Some(text)
    }
}

/// A memory change made by this session's agent, or on the dashboard, that
/// `m[1]` may show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fragment {
    pub id: i64,
    pub dashboard_log_id: Option<i64>,
    /// Dashboard rows of one operation share it, so they show together.
    pub operation_key: String,
    pub memory_ids: Vec<i64>,
    /// The memory that now holds the current text, when there is one.
    pub current_id: Option<i64>,
    pub lines: Vec<String>,
    pub visible: Vec<(i64, String)>,
}

/// Render a new baseline from everything current: a fold.
pub fn fold(inputs: &Inputs) -> Baseline {
    let history = render_stored_compartments(
        inputs.summaries,
        inputs.history_budget_tokens as f64,
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
        shown_memories: memories
            .iter()
            .map(|memory| (memory.id, memory.content.clone()))
            .collect(),
        mutation_cursor: inputs.mutation_cursor,
        fragment_cursor: inputs.fragment_cursor,
        profile_max_id: inputs.profile_max_id,
        m0: sections.join("\n\n").trim().to_owned(),
        committed: Vec::new(),
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

/// One short line for a change whose full lines do not fit: the shown text
/// of these memories is out of date, and `ctx_search` has the current text.
fn stale_marker(fragment: &Fragment) -> String {
    let ids: Vec<String> = fragment.memory_ids.iter().map(i64::to_string).collect();
    let current = fragment
        .current_id
        .map(|id| format!(" current=\"{id}\""))
        .unwrap_or_default();
    format!(
        "  <stale-memory ids=\"{}\"{current} read-with=\"ctx_search\"/>",
        ids.join(",")
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

/// `m[1]`, and the memory changes it shows, for a pass that builds a view.
///
/// Between folds `m[1]` shows newer summaries, a changed user profile, and
/// memory changes that come from this session's own agent or the dashboard
/// (`pending`, oldest first). Memories other writers add or change wait for
/// the next fold. Each change shows in full while it fits a share of the
/// memory budget, then as a one-line marker, then in one aggregate line; what
/// an earlier `m[1]` showed stays byte for byte.
pub fn delta(
    baseline: &Baseline,
    inputs: &Inputs,
    pending: &[Fragment],
) -> (String, Vec<Committed>) {
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
    if inputs.profile_max_id != baseline.profile_max_id {
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

    let mut committed: Vec<Committed> = baseline
        .committed
        .iter()
        .filter(|entry| entry.form != Form::Overflow)
        .cloned()
        .collect();
    let mut overflow = baseline
        .committed
        .iter()
        .find(|entry| entry.form == Form::Overflow)
        .cloned();
    if !pending.is_empty() {
        let full_lines_of = |form: Form, entries: &[Committed]| -> Vec<String> {
            entries
                .iter()
                .filter(|entry| entry.form == form)
                .flat_map(|entry| entry.lines.clone())
                .collect()
        };
        let mut used_full = tokens(&format!(
            "<memory-updates>\n{MEMORY_UPDATES_HEADER}\n</memory-updates>\n"
        )) + line_tokens(&full_lines_of(Form::Full, &committed));
        let mut used_markers = line_tokens(&full_lines_of(Form::Marker, &committed));
        let mut full_count = full_lines_of(Form::Full, &committed).len();
        let allowance = (inputs.memory_budget_tokens as f64 * CORRECTION_ALLOWANCE_RATIO) as u64;
        let marker_reserve = MARKER_RESERVE_TOKENS.min(allowance / 2);
        let mut cap = inputs.history_budget_tokens as f64 * M1_ABSOLUTE_CAP_RATIO;
        let m0_tokens = tokens(&baseline.m0);
        if m0_tokens >= M0_DRIFT_RATIO_FLOOR_TOKENS {
            cap = cap.min(m0_tokens as f64 * M1_DRIFT_RATIO);
        }
        let headroom = (cap - independent as f64).max(0.0) as u64;
        let full_budget = (allowance - marker_reserve).min(headroom);
        for fragment in pending {
            if overflow.is_none() {
                let cost = line_tokens(&fragment.lines);
                if used_full + cost <= full_budget
                    && full_count + fragment.lines.len() <= CORRECTION_RECORD_CAP
                {
                    committed.push(Committed {
                        id: fragment.id,
                        dashboard_log_id: fragment.dashboard_log_id,
                        form: Form::Full,
                        lines: fragment.lines.clone(),
                        visible: fragment.visible.clone(),
                        overflow_ids: Vec::new(),
                        overflow_count: 0,
                    });
                    used_full += cost;
                    full_count += fragment.lines.len();
                    continue;
                }
                let marker = stale_marker(fragment);
                let marker_cost = line_tokens(std::slice::from_ref(&marker));
                if used_markers + marker_cost <= marker_reserve {
                    committed.push(Committed {
                        id: fragment.id,
                        dashboard_log_id: fragment.dashboard_log_id,
                        form: Form::Marker,
                        lines: vec![marker],
                        visible: Vec::new(),
                        overflow_ids: Vec::new(),
                        overflow_count: 0,
                    });
                    used_markers += marker_cost;
                    continue;
                }
            }
            let entry = overflow.get_or_insert_with(|| Committed {
                id: fragment.id,
                dashboard_log_id: None,
                form: Form::Overflow,
                lines: Vec::new(),
                visible: Vec::new(),
                overflow_ids: Vec::new(),
                overflow_count: 0,
            });
            entry.id = entry.id.max(fragment.id);
            if fragment.dashboard_log_id.is_some() {
                entry.dashboard_log_id = fragment.dashboard_log_id;
            }
            entry.overflow_ids.extend(&fragment.memory_ids);
            entry.overflow_count += 1;
        }
    }
    if let Some(mut entry) = overflow {
        entry.lines = vec![overflow_line(&entry.overflow_ids, entry.overflow_count)];
        committed.push(entry);
    }
    let lines: Vec<String> = committed
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
    (text, committed)
}

/// Where a pass's pending changes start: after the fold's cursors and every
/// change an earlier `m[1]` showed.
pub fn processed_through(baseline: &Baseline) -> (i64, i64) {
    let fragments = baseline
        .committed
        .iter()
        .map(|entry| entry.id)
        .fold(baseline.fragment_cursor, i64::max);
    let dashboard = baseline
        .committed
        .iter()
        .filter_map(|entry| entry.dashboard_log_id)
        .fold(baseline.mutation_cursor, i64::max);
    (fragments, dashboard)
}

/// `m[0]` and `m[1]` as view edits, in that order.
pub fn head_ops(m0: &str, m1: &str) -> Vec<EditOp> {
    [(M0_ID, m0), (M1_ID, m1)]
        .into_iter()
        .map(|(id, text)| EditOp::Insert {
            at: InsertAt::Start,
            message: InsertedMessage {
                id: id.into(),
                role: Role::User,
                texts: vec![text.to_owned()],
            },
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
            mutation_cursor: 0,
            fragment_cursor: 0,
            history_budget_tokens: 60_000,
            memory_budget_tokens: 4_000,
            profile_budget_tokens: 4_000,
        }
    }

    fn fragment(id: i64, line: &str) -> Fragment {
        Fragment {
            id,
            dashboard_log_id: None,
            operation_key: format!("op-{id}"),
            memory_ids: vec![id],
            current_id: Some(id),
            lines: vec![line.to_owned()],
            visible: vec![(id, line.to_owned())],
        }
    }

    #[test]
    fn newer_summaries_go_to_m1_and_other_writers_memories_wait_for_a_fold() {
        let summaries = vec![summary(0, 1, 4), summary(1, 5, 9)];
        let memories = vec![memory(1, "ask first"), memory(2, "never push")];
        let baseline = fold(&inputs(&summaries[..1], &memories[..1]));
        assert!(baseline.m0.contains("Part 0") && baseline.m0.contains("#1: ask first"));
        let (m1, _) = delta(&baseline, &inputs(&summaries, &memories), &[]);
        assert!(
            m1.contains("<new-compartments>") && m1.contains("Part 1"),
            "{m1}"
        );
        assert!(!m1.contains("never push"), "{m1}");
        let refolded = fold(&inputs(&summaries, &memories));
        assert!(refolded.m0.contains("Part 1") && refolded.m0.contains("#2: never push"));
        assert_eq!(
            delta(&refolded, &inputs(&summaries, &memories), &[]).0,
            M1_EMPTY
        );
    }

    #[test]
    fn changes_show_in_full_then_as_markers_then_in_one_line_and_never_move() {
        let baseline = fold(&inputs(&[], &[]));
        let mut small = inputs(&[], &[]);
        small.memory_budget_tokens = 1_000;
        // Varied words, so the line costs real tokens: one fits the full budget, two do not.
        let line = |id: i64| {
            let words: Vec<String> = (0..15).map(|word| format!("fact{id}w{word}")).collect();
            format!("  <added id=\"{id}\">{}</added>", words.join(" "))
        };
        let (m1, committed) = delta(&baseline, &small, &[fragment(1, &line(1))]);
        assert!(m1.contains(&line(1)), "{m1}");
        let next = Baseline {
            committed: committed.clone(),
            ..baseline.clone()
        };
        let pending: Vec<Fragment> = (2..40).map(|id| fragment(id, &line(id))).collect();
        let (m1_later, committed_later) = delta(&next, &small, &pending);
        let shown_before = &m1[..m1.find("\n</memory-updates>").unwrap()];
        assert!(m1_later.starts_with(shown_before), "{m1_later}");
        assert!(!m1_later.contains(&line(2)), "{m1_later}");
        assert!(m1_later.contains("<stale-memory ids=\"2\""), "{m1_later}");
        assert!(
            m1_later.contains("<more-memory-edits count=\""),
            "{m1_later}"
        );
        assert_eq!(committed_later.last().unwrap().form, Form::Overflow);
        assert!(Baseline {
            committed: committed_later,
            ..baseline
        }
        .shows(1, &line(1)));
    }
}
