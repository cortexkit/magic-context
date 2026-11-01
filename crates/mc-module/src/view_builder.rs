//! Building the next view. A view is cumulative: it repeats every edit of the
//! previous one that still names a message in the transcript, with that
//! edit's original `since`, and adds the new edits with its own version. Then
//! it adds whatever the provider rules require because of the new edits (a
//! signed reasoning part whose history changed must go too), and checks the
//! result with the same functions the runner will use, so ck-mc never
//! publishes a view the runner would refuse.

use ck_contract_draft::read::Entry;
use ck_contract_draft::rules::{self, ProviderRules};
use ck_contract_draft::view::{self, edits_for_transcript, Edit, EditOp, View, ViewRefusal};

/// The next view, or `None` when it would change nothing: no new edit, and
/// nothing of the previous view left out.
pub fn next_view(
    previous: Option<&View>,
    entries: &[Entry],
    new_ops: Vec<EditOp>,
    rules: &ProviderRules,
    version: u64,
) -> Result<Option<View>, ViewRefusal> {
    let previous_edits = previous
        .map(|view| view.edits.as_slice())
        .unwrap_or_default();
    let mut edits = edits_for_transcript(entries, previous_edits);
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
