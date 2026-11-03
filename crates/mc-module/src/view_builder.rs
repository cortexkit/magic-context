//! Building the next view. A view is cumulative: it repeats every edit of the
//! previous one that still names a message in the transcript, with that
//! edit's original `since`, and adds the new edits with its own version. A
//! new edit replaces a carried one it supersedes: an inserted message with
//! the same id, and the cut, along with every edit on a message the new cut
//! removes. Then
//! it adds whatever the provider rules require because of the new edits (a
//! signed reasoning part whose history changed must go too), and checks the
//! result with the same functions the runner will use, so ck-mc never
//! publishes a view the runner would refuse.

use cortexkit_role_compaction::read::Entry;
use cortexkit_role_compaction::rules::ProviderRules;
use std::collections::HashSet;

use cortexkit_compaction_view::render::{self as view, edits_for_transcript};
use cortexkit_compaction_view::rules;
use cortexkit_role_compaction::view::{Edit, EditOp, View, ViewRefusal};

/// The next view, or `None` when it would change nothing: no new edit, and
/// nothing of the previous view left out. Carried edits for which `retire`
/// holds are left out, such as a history head with no summaries left to show.
pub fn next_view(
    previous: Option<&View>,
    entries: &[Entry],
    new_ops: Vec<EditOp>,
    rules: &ProviderRules,
    version: u64,
    retire: impl Fn(&EditOp) -> bool,
) -> Result<Option<View>, ViewRefusal> {
    let previous_edits = previous
        .map(|view| view.edits.as_slice())
        .unwrap_or_default();
    let mut edits = edits_for_transcript(entries, previous_edits);
    let ordinal_of = |mid: &str| {
        entries
            .iter()
            .find(|entry| entry.mid == mid)
            .map(|entry| entry.ordinal)
    };
    let new_cut = new_ops.iter().find_map(|op| match op {
        EditOp::Cut { through } => ordinal_of(through),
        _ => None,
    });
    let new_inserts: HashSet<&str> = new_ops
        .iter()
        .filter_map(|op| match op {
            EditOp::Insert { message, .. } => Some(message.id.as_str()),
            _ => None,
        })
        .collect();
    // A changed inserted message keeps its place among the inserts, so the
    // history head's two messages stay in order (`m[0]` before `m[1]`) when
    // only one of them changes. Appending it instead would move it behind
    // the other and rewrite the whole request.
    let mut replaced_in_place = false;
    for op in &new_ops {
        let EditOp::Insert { message, .. } = op else {
            continue;
        };
        let carried = edits.iter_mut().find(
            |edit| matches!(&edit.op, EditOp::Insert { message: old, .. } if old.id == message.id),
        );
        if let Some(edit) = carried {
            if edit.op != *op {
                *edit = Edit::new(version, op.clone());
                replaced_in_place = true;
            }
        }
    }
    // A part that new edits change loses its earlier edits: a drop of a
    // part an earlier view only trimmed replaces the trimming.
    let newly_edited: HashSet<(&str, &str)> = new_ops
        .iter()
        .filter_map(|op| match op {
            EditOp::Drop {
                mid,
                part: Some(part),
            }
            | EditOp::Replace { mid, part, .. } => Some((mid.as_str(), part.as_str())),
            _ => None,
        })
        .collect();
    let replaced = |edit: &Edit| match &edit.op {
        EditOp::Insert { message, .. } => {
            new_inserts.contains(message.id.as_str()) && !new_ops.contains(&edit.op)
        }
        EditOp::Cut { .. } => new_cut.is_some() && !new_ops.contains(&edit.op),
        EditOp::Drop { mid, part } => {
            new_cut.is_some_and(|cut| ordinal_of(mid).is_some_and(|ordinal| ordinal <= cut))
                || part.as_deref().is_some_and(|part| {
                    newly_edited.contains(&(mid.as_str(), part)) && !new_ops.contains(&edit.op)
                })
        }
        EditOp::Replace { mid, part, .. } => {
            new_cut.is_some_and(|cut| ordinal_of(mid).is_some_and(|ordinal| ordinal <= cut))
                || (newly_edited.contains(&(mid.as_str(), part.as_str()))
                    && !new_ops.contains(&edit.op))
        }
        // ck-mc never builds an op the contract doesn't define.
        _ => false,
    };
    edits.retain(|edit| !replaced(edit) && !retire(&edit.op));
    let new_ops: Vec<EditOp> = new_ops
        .into_iter()
        .filter(|op| match op {
            EditOp::Drop { mid, .. } | EditOp::Replace { mid, .. } => {
                !new_cut.is_some_and(|cut| ordinal_of(mid).is_some_and(|ordinal| ordinal <= cut))
            }
            _ => true,
        })
        .collect();
    let dropped_some = edits.len() != previous_edits.len();
    let mut added = false;
    for op in new_ops {
        if edits.iter().any(|edit| edit.op == op) {
            continue;
        }
        edits.push(Edit::new(version, op));
        added = true;
    }
    if !added && !dropped_some && !replaced_in_place {
        return Ok(None);
    }
    loop {
        let invalid = rules::invalid_signed_parts(entries, &edits, rules);
        if invalid.is_empty() {
            break;
        }
        edits.extend(invalid.into_iter().map(|(mid, part)| {
            Edit::new(
                version,
                EditOp::Drop {
                    mid,
                    part: Some(part),
                },
            )
        }));
    }
    let view = View::seal(version, edits);
    view::check_carried(previous, &view)?;
    view::apply(entries, &view)?;
    rules::check(entries, &view.edits, rules).map_err(ViewRefusal::Rule)?;
    Ok(Some(view))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cortexkit_role_compaction::part::{Part, PartBody, Seal};
    use cortexkit_role_compaction::read::Role;
    use cortexkit_role_compaction::rules::{EditCost, SignedParts};
    use serde_json::json;

    fn insert(id: &str, text: &str) -> EditOp {
        EditOp::Insert {
            at: cortexkit_role_compaction::view::InsertAt::Start,
            message: cortexkit_role_compaction::view::InsertedMessage::new(
                id,
                Role::User,
                vec![text.into()],
            ),
        }
    }

    fn insert_ids(view: &View) -> Vec<String> {
        view.edits
            .iter()
            .filter_map(|edit| match &edit.op {
                EditOp::Insert { message, .. } => Some(message.id.clone()),
                _ => None,
            })
            .collect()
    }

    /// When only the first of two inserted messages changes, it keeps its
    /// place: the history head stays `m[0]` then `m[1]`.
    #[test]
    fn a_changed_insert_keeps_its_place_among_the_inserts() {
        let rules = ProviderRules::new(SignedParts::None, EditCost::Suffix);
        let first = next_view(
            None,
            &[],
            vec![insert("m0", "baseline"), insert("m1", "nothing new")],
            &rules,
            1,
            |_| false,
        )
        .unwrap()
        .unwrap();
        let second = next_view(
            Some(&first),
            &[],
            vec![
                insert("m0", "baseline, folded"),
                insert("m1", "nothing new"),
            ],
            &rules,
            2,
            |_| false,
        )
        .unwrap()
        .expect("a changed m[0] is a new view");
        assert_eq!(insert_ids(&second), ["m0", "m1"]);
        assert_eq!(second.edits[0].since, 2);
        assert_eq!(second.edits[1].since, 1);
    }

    /// ck-mc checks a view with the runner's own functions before it
    /// publishes, so a lane that asks for an edit the contract forbids gets a
    /// refusal here, not a view the runner would refuse.
    #[test]
    fn a_view_the_runner_would_refuse_is_never_built() {
        let reasoning = Part::new(
            "r1",
            PartBody::Reasoning {
                text: None,
                text_bytes: Some(40),
            },
        )
        .with_seal(Seal::Encrypted);
        let entry = Entry::new(1, "m1", Role::Assistant, 0, vec![reasoning.clone()]);
        let rules = ProviderRules::new(SignedParts::None, EditCost::Suffix);
        // A sealed part can be dropped but never replaced.
        let replace = EditOp::Replace {
            mid: "m1".into(),
            part: "r1".into(),
            field: "text".into(),
            value: json!("shorter"),
            expect: reasoning.digest.clone(),
        };
        assert!(next_view(
            None,
            std::slice::from_ref(&entry),
            vec![replace],
            &rules,
            1,
            |_| false
        )
        .is_err());
        let drop = EditOp::Drop {
            mid: "m1".into(),
            part: Some("r1".into()),
        };
        assert!(matches!(
            next_view(None, &[entry], vec![drop], &rules, 1, |_| false),
            Ok(Some(_))
        ));
    }
}
