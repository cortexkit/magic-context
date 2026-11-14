//! `dreamer.docs_proposal {project}`: the project's pending docs-upkeep
//! proposal, for the dreamer page.
//!
//! Unlike the other owner reads it is answered from the module's writable
//! store rather than the read-only replica: reading a proposal checks it
//! against the documents and stores the status they show
//! ([`crate::docs_proposals::refresh`]), so one that was applied or went
//! stale is never shown again. The reply is `{"proposal": null}` when the
//! project has no pending proposal, and otherwise its id, time, status,
//! each changed document's diff and changes, and the changes the task
//! dropped.

use serde_json::{json, Value};

use super::{envelope, object, pages, string, Refusal};
use crate::context_db::ContextDb;

/// The read's method name.
pub(crate) const METHOD: &str = "dreamer.docs_proposal";

/// Answer `params` for a project the app reads know (`known`), with `db`
/// the module's `context.db` (`None` without one).
pub(crate) fn read(db: Option<&ContextDb>, known: bool, params: &Value) -> Result<Value, Refusal> {
    let p = object(params, &["project"])?;
    let project = string(p, "project")?;
    if !known {
        return Err(pages::project_unknown());
    }
    let db = db.ok_or_else(pages::store_unavailable)?;
    let proposal =
        crate::docs_proposals::refresh_pending(db, project).map_err(pages::store_error)?;
    let mut fields = json!({
        "proposal": proposal
            .filter(|proposal| proposal.status == crate::docs_proposals::PENDING)
            .map(|proposal| crate::docs_proposals::shown(&proposal)),
    });
    envelope(METHOD, &mut fields);
    Ok(fields)
}
