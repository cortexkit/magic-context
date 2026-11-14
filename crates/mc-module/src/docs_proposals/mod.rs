//! The docs-upkeep task's proposals (`maintain-docs`): edits to a project's
//! `ARCHITECTURE.md` and `STRUCTURE.md`, kept in `context.db`'s
//! `docs_proposals` table until someone applies them, sets them aside, or
//! the documents move past them.
//!
//! The task never writes the documents. A proposal reaches the person through
//! an app read ([`app_read`]) and a command to dismiss it, and the project's
//! head agent through a bus event (`docs_proposal`, [`crate::bus`]) and a
//! markdown copy in the main checkout ([`file`]). A proposal's status is
//! checked against the files whenever it is read ([`refresh`]): it stays
//! `pending` while both documents keep the hashes it was based on, becomes
//! `applied` once both have the hashes it leads to, and `stale` when they
//! changed any other way. A newer proposal of the project makes the older one
//! `stale` in the same transaction, so a project has at most one pending.
//!
//! The event's body is the proposal as the app read shows it, with the
//! project and the markdown copy's path. It is serialized once, when the
//! proposal is made, and served as stored from then on, so the digest its
//! notice carries always matches what a reader fetches.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::context_db::ContextDb;

pub(crate) mod file;
pub(crate) mod flow;

/// The two documents the task keeps, at the top of the main checkout, in the
/// order every list of them uses.
pub(crate) const DOCUMENTS: [&str; 2] = ["ARCHITECTURE.md", "STRUCTURE.md"];
/// The event a new proposal is announced by, and its version.
pub(crate) const EVENT_NAME: &str = "docs_proposal";
pub(crate) const EVENT_VERSION: u32 = 1;
/// The headers its notice carries, as the module's manifest declares them.
pub(crate) const EVENT_HEADERS: [&str; 2] = ["event_key", "project_id"];

pub(crate) const PENDING: &str = "pending";
pub(crate) const APPLIED: &str = "applied";
pub(crate) const STALE: &str = "stale";

/// One section change the task kept: what the model answered, checked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SectionChange {
    pub file: String,
    pub action: String,
    pub heading: String,
    pub text: String,
    pub reason: String,
}

/// A change the task's checks dropped, with why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct DroppedChange {
    pub file: String,
    pub action: String,
    pub heading: String,
    pub reason: String,
}

/// One document as a proposal found it and as it would be once applied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DocumentResult {
    pub name: &'static str,
    /// Its text as read; `None` when it doesn't exist.
    pub base: Option<String>,
    /// Its text with the kept changes; `None` when it still doesn't exist.
    pub result: Option<String>,
    /// The unified diff from `base` to `result`, empty when they are equal.
    pub diff: String,
}

/// A proposal the task is about to store.
#[derive(Clone, Debug)]
pub(crate) struct NewProposal {
    pub project: String,
    pub run_id: Option<i64>,
    /// The main checkout the documents were read in.
    pub checkout: String,
    pub base_commit: String,
    pub created_at: i64,
    pub documents: Vec<DocumentResult>,
    pub changes: Vec<SectionChange>,
    pub dropped: Vec<DroppedChange>,
}

/// A stored proposal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Proposal {
    pub id: i64,
    pub project: String,
    pub run_id: Option<i64>,
    pub created_at: i64,
    pub checkout: String,
    pub base_commit: String,
    /// Each document's SHA-256 as the proposal read it, in [`DOCUMENTS`] order.
    pub base: [Option<String>; 2],
    /// Each document's SHA-256 once the proposal is applied.
    pub result: [Option<String>; 2],
    pub changes: Vec<SectionChange>,
    pub dropped: Vec<DroppedChange>,
    pub status: String,
    pub status_at: i64,
    /// The event body, exactly as stored when the proposal was made.
    pub body: String,
    pub published_at: Option<i64>,
}

impl Proposal {
    /// The key its event is fetched by: `<project>:<proposal id>`.
    pub(crate) fn event_key(&self) -> String {
        event_key(&self.project, self.id)
    }
}

/// The `docs_proposal` event as the module's manifest declares it: a notice
/// with no body when a proposal is made, which a flow filters by project.
pub(crate) fn event_declaration() -> subc_protocol::manifest::EventDeclaration {
    subc_protocol::manifest::EventDeclaration::new(EVENT_NAME, EVENT_VERSION)
        .with_headers(
            EVENT_HEADERS
                .iter()
                .map(|name| (*name).to_owned())
                .collect(),
        )
        .with_summary(Some(
            "Magic Context proposed edits to a project's ARCHITECTURE.md and STRUCTURE.md".into(),
        ))
}

/// The key of proposal `id` of `project`'s event.
pub(crate) fn event_key(project: &str, id: i64) -> String {
    format!("{project}:{id}")
}

/// The lowercase hex SHA-256 of `bytes`.
pub(crate) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

const COLUMNS: &str = "id, project, run_id, created_at, checkout, base_commit,
    architecture_base_sha256, structure_base_sha256,
    architecture_result_sha256, structure_result_sha256,
    changes_json, dropped_json, status, status_at, body, published_at";

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Proposal> {
    let changes: String = row.get(10)?;
    let dropped: String = row.get(11)?;
    Ok(Proposal {
        id: row.get(0)?,
        project: row.get(1)?,
        run_id: row.get(2)?,
        created_at: row.get(3)?,
        checkout: row.get(4)?,
        base_commit: row.get(5)?,
        base: [row.get(6)?, row.get(7)?],
        result: [row.get(8)?, row.get(9)?],
        changes: serde_json::from_str(&changes).unwrap_or_default(),
        dropped: serde_json::from_str(&dropped).unwrap_or_default(),
        status: row.get(12)?,
        status_at: row.get(13)?,
        body: row.get(14)?,
        published_at: row.get(15)?,
    })
}

/// The proposal with this id.
pub(crate) fn by_id(conn: &Connection, id: i64) -> rusqlite::Result<Option<Proposal>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM docs_proposals WHERE id = ?1"),
        params![id],
        row,
    )
    .optional()
}

/// The project's pending proposal, as stored.
pub(crate) fn pending_of(conn: &Connection, project: &str) -> rusqlite::Result<Option<Proposal>> {
    conn.query_row(
        &format!(
            "SELECT {COLUMNS} FROM docs_proposals
              WHERE project = ?1 AND status = 'pending' ORDER BY id DESC LIMIT 1"
        ),
        params![project],
        row,
    )
    .optional()
}

/// The pending proposals whose notice isn't on the bus yet, oldest first.
pub(crate) fn unpublished(conn: &Connection, limit: usize) -> rusqlite::Result<Vec<Proposal>> {
    conn.prepare(&format!(
        "SELECT {COLUMNS} FROM docs_proposals
          WHERE published_at IS NULL AND status = 'pending' ORDER BY id LIMIT ?1"
    ))?
    .query_map(params![limit as i64], row)?
    .collect()
}

/// Record that the notice of proposal `id` is on the bus, at `now`.
pub(crate) fn mark_published(conn: &Connection, id: i64, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE docs_proposals SET published_at = ?2 WHERE id = ?1 AND published_at IS NULL",
        params![id, now],
    )
    .map(drop)
}

/// The event body of a proposal: what the app read shows of it (its id,
/// time, status, each changed document's diff and changes, and the dropped
/// changes), with the project and the markdown copy's path in the checkout.
pub(crate) fn body(id: i64, proposal: &NewProposal) -> String {
    let documents: Vec<Value> = proposal
        .documents
        .iter()
        .filter(|document| proposal.changes.iter().any(|c| c.file == document.name))
        .map(|document| {
            json!({
                "name": document.name,
                "diff": document.diff,
                "changes": proposal
                    .changes
                    .iter()
                    .filter(|change| change.file == document.name)
                    .map(|change| json!({
                        "action": change.action,
                        "heading": change.heading,
                        "reason": change.reason,
                    }))
                    .collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({
        "id": id,
        "project_id": proposal.project,
        "created_at_ms": proposal.created_at,
        "status": PENDING,
        "file": file::relative(id),
        "documents": documents,
        "dropped": proposal.dropped,
    })
    .to_string()
}

/// What storing a proposal did.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Stored {
    pub id: i64,
    /// The pending proposals of the project it replaced, now stale: their
    /// markdown copies go once the transaction commits.
    pub replaced: Vec<(i64, String)>,
}

/// Store `proposal` in `tx` as the project's pending proposal, marking the
/// project's earlier pending one stale.
pub(crate) fn insert(tx: &Transaction<'_>, proposal: &NewProposal) -> rusqlite::Result<Stored> {
    let replaced: Vec<(i64, String)> = tx
        .prepare(
            "SELECT id, checkout FROM docs_proposals WHERE project = ?1 AND status = 'pending'",
        )?
        .query_map(params![proposal.project], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    tx.execute(
        "UPDATE docs_proposals SET status = 'stale', status_at = ?2
          WHERE project = ?1 AND status = 'pending'",
        params![proposal.project, proposal.created_at],
    )?;
    let hash = |name: &str, result: bool| {
        proposal
            .documents
            .iter()
            .find(|document| document.name == name)
            .and_then(|document| {
                if result {
                    document.result.as_deref()
                } else {
                    document.base.as_deref()
                }
            })
            .map(|text| sha256(text.as_bytes()))
    };
    tx.execute(
        "INSERT INTO docs_proposals(project, run_id, created_at, checkout, base_commit,
                                    architecture_base_sha256, architecture_result_sha256,
                                    structure_base_sha256, structure_result_sha256,
                                    changes_json, dropped_json, status, status_at, body)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', ?3, '')",
        params![
            proposal.project,
            proposal.run_id,
            proposal.created_at,
            proposal.checkout,
            proposal.base_commit,
            hash(DOCUMENTS[0], false),
            hash(DOCUMENTS[0], true),
            hash(DOCUMENTS[1], false),
            hash(DOCUMENTS[1], true),
            serde_json::to_string(&proposal.changes).expect("changes serialize"),
            serde_json::to_string(&proposal.dropped).expect("dropped changes serialize"),
        ],
    )?;
    let id = tx.last_insert_rowid();
    tx.execute(
        "UPDATE docs_proposals SET body = ?2 WHERE id = ?1",
        params![id, body(id, proposal)],
    )?;
    Ok(Stored { id, replaced })
}

/// Each document's SHA-256 in `checkout` now, in [`DOCUMENTS`] order, `None`
/// for one that doesn't exist. `None` as a whole when the checkout itself is
/// gone or a document can't be read: nothing then shows what became of it.
pub(crate) fn current_hashes(checkout: &Path) -> Option<[Option<String>; 2]> {
    if !checkout.is_dir() {
        return None;
    }
    let hash = |name: &str| -> Option<Option<String>> {
        match std::fs::read(checkout.join(name)) {
            Ok(bytes) => Some(Some(sha256(&bytes))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(None),
            Err(_) => None,
        }
    };
    Some([hash(DOCUMENTS[0])?, hash(DOCUMENTS[1])?])
}

/// The status a pending proposal has with documents hashed `now`: applied
/// once both have its result hashes, stale once they differ from its base
/// any other way, and pending while both keep their base hashes.
pub(crate) fn judged(proposal: &Proposal, now: &[Option<String>; 2]) -> &'static str {
    if now == &proposal.result {
        APPLIED
    } else if now != &proposal.base {
        STALE
    } else {
        PENDING
    }
}

/// Check the project's pending proposal against its documents, store the
/// status they show, and return the proposal as it is now (pending, or the
/// status it just took). `None` when the project has no pending proposal.
pub(crate) fn refresh_pending(db: &ContextDb, project: &str) -> rusqlite::Result<Option<Proposal>> {
    let Some(proposal) = db.with_connection(|conn| pending_of(conn, project))? else {
        return Ok(None);
    };
    refresh(db, proposal).map(Some)
}

/// [`refresh_pending`] for the proposal with this id.
pub(crate) fn refresh_id(db: &ContextDb, id: i64) -> rusqlite::Result<Option<Proposal>> {
    let Some(proposal) = db.with_connection(|conn| by_id(conn, id))? else {
        return Ok(None);
    };
    refresh(db, proposal).map(Some)
}

/// Check `proposal` against its documents when it is pending, and store the
/// status they show. A proposal that stops being pending loses its markdown
/// copy, and the project's dreamer page hears of it.
pub(crate) fn refresh(db: &ContextDb, mut proposal: Proposal) -> rusqlite::Result<Proposal> {
    if proposal.status != PENDING {
        return Ok(proposal);
    }
    let Some(now) = current_hashes(Path::new(&proposal.checkout)) else {
        return Ok(proposal);
    };
    let status = judged(&proposal, &now);
    if status == PENDING {
        return Ok(proposal);
    }
    let at = crate::memory_writes::now_ms();
    let changed = db.with_connection(|conn| {
        conn.execute(
            "UPDATE docs_proposals SET status = ?2, status_at = ?3
              WHERE id = ?1 AND status = 'pending'",
            params![proposal.id, status, at],
        )
    })?;
    if changed == 1 {
        proposal.status = status.to_owned();
        proposal.status_at = at;
        ended(
            db,
            &proposal.project,
            &[(proposal.id, proposal.checkout.clone())],
        );
    } else if let Some(stored) = db.with_connection(|conn| by_id(conn, proposal.id))? {
        // Another reader judged it first.
        proposal = stored;
    }
    Ok(proposal)
}

/// After proposals of `project` stopped being pending: remove their markdown
/// copies and tell the project's dreamer page.
pub(crate) fn ended(db: &ContextDb, project: &str, proposals: &[(i64, String)]) {
    for (id, checkout) in proposals {
        file::remove(Path::new(checkout), *id);
    }
    db.changed(crate::app_read::Change::Dreamer {
        project: project.to_owned(),
    });
}

/// Set pending proposal `id` aside at `now`, in `tx`. False when it is no
/// longer pending.
pub(crate) fn dismiss(tx: &Transaction<'_>, id: i64, now: i64) -> rusqlite::Result<bool> {
    tx.execute(
        "UPDATE docs_proposals SET status = 'dismissed', status_at = ?2
          WHERE id = ?1 AND status = 'pending'",
        params![id, now],
    )
    .map(|changed| changed == 1)
}

/// The proposal as the app read shows it: the stored body's id, time,
/// documents and dropped changes, with its status now.
pub(crate) fn shown(proposal: &Proposal) -> Value {
    let body: Value = serde_json::from_str(&proposal.body).unwrap_or(Value::Null);
    json!({
        "id": proposal.id,
        "created_at_ms": proposal.created_at,
        "status": proposal.status,
        "documents": body.get("documents").cloned().unwrap_or_else(|| json!([])),
        "dropped": body.get("dropped").cloned().unwrap_or_else(|| json!([])),
    })
}

#[cfg(test)]
#[path = "tests.rs"]
pub(crate) mod tests;

#[cfg(test)]
#[path = "samples_tests.rs"]
mod samples_tests;
