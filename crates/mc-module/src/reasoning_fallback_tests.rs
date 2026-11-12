//! A reply shape Anthropic's server-side fallback can produce: an
//! assistant entry whose first reasoning part is a signed marker, hidden
//! and possibly empty, followed by the fallback model's signed reasoning,
//! then text. Losing the marker is harmless only if the reasoning after it
//! goes too, so ck-mc must never remove or clear the first reasoning part
//! of such a reply while keeping a later one. Two lanes can remove signed
//! reasoning: reasoning clearing, and the companion drops a view adds for
//! signed parts an edit in front of them invalidates.

use super::*;
use crate::neutral::part;
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::view::Edit;

const MARKER: &str = "marker";
const FALLBACK: &str = "fallback";

fn reasoning(id: &str, text_bytes: u64) -> Part {
    part(
        id,
        None,
        Seal::Signed,
        PartBody::Reasoning {
            text: None,
            text_bytes: Some(text_bytes),
        },
    )
}

fn said(tag: u64) -> Part {
    part(
        format!("t{tag}"),
        Some(tag),
        Seal::None,
        PartBody::Text {
            text: format!("said {tag}").into(),
        },
    )
}

fn tool(tag: u64) -> Part {
    part(
        format!("p{tag}"),
        Some(tag),
        Seal::None,
        PartBody::Tool(
            ToolPart::new(
                format!("c{tag}"),
                "read",
                json!({"path": "a.rs"}),
                ToolStatus::Completed,
            )
            .with_output_bytes(40_000),
        ),
    )
}

/// A transcript with the fallback reply (`reply`) between older and newer
/// steps: a person's turn, a tool step, the reply, then two more turns.
fn transcript() -> Vec<Entry> {
    vec![
        Entry::new(1, "task", Role::User, 1, vec![said(1)]),
        Entry::new(2, "old", Role::Assistant, 2, vec![tool(2)]),
        Entry::new(
            3,
            "reply",
            Role::Assistant,
            3,
            vec![reasoning(MARKER, 0), reasoning(FALLBACK, 8_000), said(3)],
        ),
        Entry::new(4, "next", Role::User, 4, vec![said(4)]),
        Entry::new(
            5,
            "middle",
            Role::Assistant,
            5,
            vec![reasoning("r5", 8_000), said(5)],
        ),
        Entry::new(6, "go", Role::User, 6, vec![said(6)]),
        Entry::new(
            7,
            "newest",
            Role::Assistant,
            7,
            vec![reasoning("r7", 400), said(7)],
        ),
    ]
}

/// Which of the reply's two reasoning parts `removed` names.
fn reply_parts(removed: &BTreeSet<PartKey>) -> (bool, bool) {
    let has = |id: &str| removed.contains(&("reply".to_owned(), id.to_owned()));
    (has(MARKER), has(FALLBACK))
}

/// Reasoning clearing takes an entry's reasoning parts together or not at
/// all, at every budget, on Anthropic and elsewhere: never the marker
/// without the fallback model's reasoning after it.
#[test]
fn fallback_reasoning_clearing_takes_the_replys_reasoning_together() {
    let mut index = Index::default();
    index.extend(transcript());
    let edited = Edited::default();
    let protected = BTreeMap::new();
    let context = Context {
        index: &index,
        edited: &edited,
        protected_tools: &protected,
        keep_first_message: true,
        signed_floor: None,
    };
    let mut cleared_together = false;
    for anthropic in [false, true] {
        for budget in (0..=12_000).step_by(250) {
            let removed: BTreeSet<PartKey> = reasoning_over_budget(&context, budget, anthropic)
                .into_iter()
                .map(|(key, _)| key)
                .collect();
            let (marker, fallback) = reply_parts(&removed);
            assert_eq!(
                marker, fallback,
                "budget {budget}, anthropic {anthropic}: {removed:?}"
            );
            cleared_together |= marker && fallback;
        }
    }
    assert!(
        cleared_together,
        "no budget cleared the reply's reasoning, so the test checked nothing"
    );
}

/// The companion drops a view adds for signed parts an edit invalidates go
/// from the edit onward, so for any single edit ck-mc's lanes can make (a
/// dropped or placeholdered part, a dropped message) the view never drops
/// the marker while keeping the reasoning after it. An edit in front of the
/// reply drops both; an edit after its reasoning drops neither.
#[test]
fn fallback_companion_drops_never_leave_later_reasoning_without_the_marker() {
    let entries = transcript();
    let rules = ProviderRules::new(SignedParts::Bound, EditCost::Suffix);
    let mut ops: Vec<EditOp> = Vec::new();
    for entry in &entries {
        ops.push(EditOp::Drop {
            mid: entry.mid.clone(),
            part: None,
        });
        for part in entry.parts.iter().filter(|part| part.seal == Seal::None) {
            ops.push(EditOp::Drop {
                mid: entry.mid.clone(),
                part: Some(part.id.clone()),
            });
        }
    }
    let mut checked = 0;
    for op in ops {
        let Ok(Some(view)) =
            crate::view_builder::next_view(None, &entries, vec![op.clone()], &rules, 1, |_| false)
        else {
            continue;
        };
        checked += 1;
        let removed: BTreeSet<PartKey> = view
            .edits
            .iter()
            .filter_map(|edit: &Edit| match &edit.op {
                EditOp::Drop {
                    mid,
                    part: Some(part),
                } => Some((mid.clone(), part.clone())),
                _ => None,
            })
            .collect();
        let whole = view
            .edits
            .iter()
            .any(|edit| matches!(&edit.op, EditOp::Drop { mid, part: None } if mid == "reply"));
        let (marker, fallback) = reply_parts(&removed);
        assert!(
            whole || !marker || fallback,
            "{op:?}: the marker goes and the reasoning after it stays: {:?}",
            view.edits
        );
        let in_front = matches!(&op, EditOp::Drop { mid, .. } if mid == "old");
        if in_front {
            assert!(marker && fallback, "{op:?}: {:?}", view.edits);
        }
        if matches!(&op, EditOp::Drop { mid, part: Some(part) } if mid == "reply" && part == "t3") {
            assert!(!marker && !fallback, "{op:?}: {:?}", view.edits);
        }
    }
    assert!(checked > 0, "no edit produced a view");
}
