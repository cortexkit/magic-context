//! The history head: two messages a view inserts at the start of the
//! request, in place of the messages the summaries cover.
//!
//! - `m[0]` holds every summary as of the last fold, each at the detail tier
//!   its age and importance earn under the history budget. It changes only
//!   on a fold, when the provider cache is lost anyway.
//! - `m[1]` holds the summaries written since, at full detail, or a short
//!   placeholder. Adding to it changes the request from `m[1]` on, not from
//!   the start.
//!
//! The wrappers and the placeholder are the TypeScript plugin's, so a head
//! reads the same in both.

use ck_contract_draft::read::Role;
use ck_contract_draft::view::{EditOp, InsertAt, InsertedMessage};

use super::render::{
    render_compartment_at_tier, render_stored_compartments, DecayRenderCompartment,
};
use crate::context_db::StoredCompartment;

const M0_ID: &str = "magic-context:m0";
const M1_ID: &str = "magic-context:m1";
const M0_EMPTY: &str = "<session-history></session-history>";
const M1_EMPTY: &str =
    "<session-history-since>(no new content since last materialization)</session-history-since>";

/// The summaries `m[0]` holds and the budget it was rendered with, so the
/// same head can be rendered again byte for byte.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Baseline {
    /// The highest summary sequence in `m[0]`.
    pub through_sequence: i64,
    pub budget_tokens: u64,
}

/// `m[0]` and `m[1]` as view edits, in that order.
pub fn head_ops(summaries: &[StoredCompartment], baseline: &Baseline) -> Vec<EditOp> {
    let (folded, since): (Vec<&StoredCompartment>, Vec<&StoredCompartment>) = summaries
        .iter()
        .partition(|summary| summary.sequence <= baseline.through_sequence);
    let folded: Vec<StoredCompartment> = folded.into_iter().cloned().collect();
    let history = render_stored_compartments(&folded, baseline.budget_tokens as f64, |text| {
        mc_tokenizer::estimate_tokens(text)
    });
    let m0 = if history.is_empty() {
        M0_EMPTY.to_owned()
    } else {
        format!("<session-history>\n{history}\n</session-history>")
    };
    let since: Vec<String> = since
        .into_iter()
        .map(DecayRenderCompartment::from)
        .filter(|summary| !summary.is_no_content())
        .map(|summary| render_compartment_at_tier(&summary, 1))
        .collect();
    let m1 = if since.is_empty() {
        M1_EMPTY.to_owned()
    } else {
        format!(
            "<session-history-since>\n<new-compartments>\n{}\n</new-compartments>\n</session-history-since>",
            since.join("\n\n")
        )
    };
    [(M0_ID, m0), (M1_ID, m1)]
        .into_iter()
        .map(|(id, text)| EditOp::Insert {
            at: InsertAt::Start,
            message: InsertedMessage {
                id: id.into(),
                role: Role::User,
                texts: vec![text],
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

    fn texts(ops: &[EditOp]) -> Vec<String> {
        ops.iter()
            .map(|op| match op {
                EditOp::Insert { message, .. } => message.texts.join(""),
                _ => unreachable!(),
            })
            .collect()
    }

    #[test]
    fn new_summaries_go_to_m1_until_a_fold() {
        let summaries = vec![summary(1, 1, 4), summary(2, 5, 9)];
        let before = head_ops(
            &summaries[..1],
            &Baseline {
                through_sequence: 1,
                budget_tokens: 60_000,
            },
        );
        let after = head_ops(
            &summaries,
            &Baseline {
                through_sequence: 1,
                budget_tokens: 60_000,
            },
        );
        let (before, after) = (texts(&before), texts(&after));
        assert_eq!(before[0], after[0], "m[0] does not change");
        assert_eq!(before[1], M1_EMPTY);
        assert!(after[1].starts_with("<session-history-since>\n<new-compartments>\n"));
        assert!(after[1].contains("Part 2"));
        let folded = texts(&head_ops(
            &summaries,
            &Baseline {
                through_sequence: 2,
                budget_tokens: 60_000,
            },
        ));
        assert!(folded[0].contains("Part 2"));
        assert_eq!(folded[1], M1_EMPTY);
    }
}
