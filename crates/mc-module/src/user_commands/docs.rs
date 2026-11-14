//! The person's command on a project's docs-upkeep proposal: dismiss it, so
//! neither the app's dreamer view (the `dreamer.docs_proposal` read) nor a
//! flow that tells the project's head agent offers it again.
//! The documents are never changed by it; a proposal is applied by editing
//! them.

use cortexkit_role_user_commands::{Fact, Preview};
use rusqlite::TransactionBehavior;
use serde_json::{json, Map};

use super::owner::{count, id, not_here, plain, Plan, Refused};
use super::*;
use crate::context_db::ContextDb;
use crate::docs_proposals as proposals;

type Stamp<'s> = &'s dyn Fn(Value) -> String;

/// `docs_proposal_dismiss {proposal_id}` for `project`.
pub(super) fn dismiss<'a>(
    db: &'a ContextDb,
    project: String,
    args: &Map<String, Value>,
    stamp: Stamp<'_>,
) -> Result<Plan<'a>, ErrorBody> {
    let id = id(args, "proposal_id")?;
    // Reading a proposal checks it against the documents first, so one that
    // was applied or went stale meanwhile is not offered for dismissal.
    let proposal = proposals::refresh_id(db, id)
        .map_err(|error| {
            tracing::warn!("ck-mc: user command read failed: {error}");
            super::owner::unavailable_error()
        })?
        .filter(|proposal| proposal.project == project)
        .ok_or_else(|| {
            not_here(
                "proposal_id",
                format!("The project has no docs proposal {id}."),
                &[id],
            )
        })?;
    let version = stamp(json!([proposal.id, proposal.status, proposal.status_at]));
    if proposal.status != proposals::PENDING {
        return Ok(Plan::unavailable(version, "nothing_to_change"));
    }
    let files: Vec<&str> = proposals::DOCUMENTS
        .into_iter()
        .filter(|name| proposal.changes.iter().any(|change| change.file == *name))
        .collect();
    let mut preview = Preview::new(version, true);
    // The contract allows 120 characters, one line.
    preview.effect = Some(format!(
        "Sets docs proposal {id} aside ({} to {}); the documents stay as they are.",
        if proposal.changes.len() == 1 {
            "1 change".to_owned()
        } else {
            format!("{} changes", proposal.changes.len())
        },
        files.join(" and "),
    ));
    preview.facts = Some(vec![
        Fact::new("Proposal", plain(id)),
        count("Changes", proposal.changes.len(), Some("changes")),
    ]);
    let checkout = proposal.checkout.clone();
    Ok(Plan::available(
        preview,
        Box::new(move || {
            let dismissed = db
                .with_connection(|conn| {
                    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
                    let dismissed = proposals::dismiss(&tx, id, crate::memory_writes::now_ms())?;
                    tx.commit()?;
                    Ok::<_, rusqlite::Error>(dismissed)
                })
                .map_err(|error| {
                    super::owner::store_failed("docs_proposal_dismiss", &error.to_string())
                })?;
            if !dismissed {
                return Err(Refused::Reply(RunReply::new("preview_stale")));
            }
            proposals::ended(db, &project, &[(id, checkout)]);
            let mut reply = RunReply::new("applied");
            reply.facts = Some(vec![count("Proposals dismissed", 1, Some("proposals"))]);
            Ok(reply)
        }),
    ))
}
