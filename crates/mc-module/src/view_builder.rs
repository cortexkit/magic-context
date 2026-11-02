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

use ck_contract_draft::read::Entry;
use ck_contract_draft::rules::{self, ProviderRules};
use std::collections::HashSet;

use ck_contract_draft::view::{self, edits_for_transcript, Edit, EditOp, View, ViewRefusal};

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
    let replaced = |edit: &Edit| match &edit.op {
        EditOp::Insert { message, .. } => {
            new_inserts.contains(message.id.as_str()) && !new_ops.contains(&edit.op)
        }
        EditOp::Cut { .. } => new_cut.is_some() && !new_ops.contains(&edit.op),
        EditOp::Drop { mid, .. } | EditOp::Replace { mid, .. } => {
            new_cut.is_some_and(|cut| ordinal_of(mid).is_some_and(|ordinal| ordinal <= cut))
        }
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
    if !added && !dropped_some {
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
