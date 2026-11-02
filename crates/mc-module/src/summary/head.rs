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
use crate::context_db::{StoredCompartment, StoredMemory, StoredMutation};
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
    /// The newest memory change logged for the project.
    pub mutation_cursor: i64,
    pub history_budget_tokens: u64,
    pub memory_budget_tokens: u64,
    pub profile_budget_tokens: u64,
}

/// `m[0]` as rendered at the last fold, and what it covered.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Baseline {
    /// The highest summary sequence in `m[0]`.
    pub through_sequence: i64,
    /// The highest memory id that existed at the fold: newer ones go to `m[1]`.
    pub max_memory_id: i64,
    /// The memories `m[0]` shows.
    pub shown_memories: Vec<i64>,
    /// The mutation log entry `m[0]` already reflects.
    pub mutation_cursor: i64,
    pub profile_max_id: i64,
    pub m0: String,
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
        shown_memories: memories.iter().map(|memory| memory.id).collect(),
        mutation_cursor: inputs.mutation_cursor,
        profile_max_id: inputs.profile_max_id,
        m0: sections.join("\n\n").trim().to_owned(),
    }
}

/// What changed since `baseline`, as `m[1]`.
pub fn delta(baseline: &Baseline, inputs: &Inputs, mutations: &[StoredMutation]) -> String {
    let shown: HashSet<i64> = baseline.shown_memories.iter().copied().collect();
    let eligible: HashSet<i64> = inputs.memories.iter().map(|memory| memory.id).collect();
    // A replacement the head does not show yet is shown with the correction.
    let forced: HashSet<i64> = mutations
        .iter()
        .filter(|mutation| mutation.mutation_type == "superseded")
        .filter_map(|mutation| mutation.superseded_by_id)
        .filter(|id| eligible.contains(id) && !shown.contains(id))
        .collect();
    let newer: Vec<StoredMemory> = inputs
        .memories
        .iter()
        .filter(|memory| memory.id > baseline.max_memory_id && !forced.contains(&memory.id))
        .cloned()
        .collect();
    let mut delta_memories = memory::trim_to_budget(
        newer,
        ((inputs.memory_budget_tokens as f64 * DELTA_SHARE) as u64).max(1),
    );
    delta_memories.extend(
        inputs
            .memories
            .iter()
            .filter(|memory| forced.contains(&memory.id))
            .cloned(),
    );
    let resolvable: HashSet<i64> = shown
        .iter()
        .copied()
        .chain(delta_memories.iter().map(|memory| memory.id))
        .collect();

    let mut blocks = Vec::new();
    let updates = memory::render_updates(mutations, &resolvable);
    if !updates.is_empty() {
        blocks.push(updates);
    }
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
    let memory_block = memory::render_block(&delta_memories, "new-memories");
    if !memory_block.is_empty() {
        blocks.push(memory_block);
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
    if blocks.is_empty() {
        M1_EMPTY.to_owned()
    } else {
        format!(
            "<session-history-since>\n{}\n</session-history-since>",
            blocks.join("\n")
        )
    }
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
            history_budget_tokens: 60_000,
            memory_budget_tokens: 4_000,
            profile_budget_tokens: 4_000,
        }
    }

    #[test]
    fn newer_summaries_and_memories_go_to_m1_until_a_fold() {
        let summaries = vec![summary(0, 1, 4), summary(1, 5, 9)];
        let memories = vec![memory(1, "ask first"), memory(2, "never push")];
        let baseline = fold(&inputs(&summaries[..1], &memories[..1]));
        assert!(baseline.m0.contains("Part 0"));
        assert!(baseline.m0.contains("#1: ask first"));
        assert_eq!(
            delta(&baseline, &inputs(&summaries[..1], &memories[..1]), &[]),
            M1_EMPTY
        );

        let m1 = delta(&baseline, &inputs(&summaries, &memories), &[]);
        assert!(
            m1.contains("<new-compartments>") && m1.contains("Part 1"),
            "{m1}"
        );
        assert!(
            m1.contains("<new-memories>") && m1.contains("#2: never push"),
            "{m1}"
        );

        let refolded = fold(&inputs(&summaries, &memories));
        assert!(refolded.m0.contains("Part 1") && refolded.m0.contains("#2: never push"));
        assert_eq!(
            delta(&refolded, &inputs(&summaries, &memories), &[]),
            M1_EMPTY
        );
    }

    #[test]
    fn a_correction_names_a_replacement_and_shows_it() {
        let memories = vec![memory(1, "old rule"), memory(5, "new rule")];
        let baseline = fold(&inputs(&[], &memories[..1]));
        let mutations = [StoredMutation {
            id: 1,
            mutation_type: "superseded".into(),
            target_memory_id: 1,
            superseded_by_id: Some(5),
            ..StoredMutation::default()
        }];
        let m1 = delta(&baseline, &inputs(&[], &memories), &mutations);
        assert!(m1.contains("<superseded id=\"1\" by=\"5\"/>"), "{m1}");
        assert!(m1.contains("#5: new rule"), "{m1}");
    }
}
