//! `busy`: whether a session's data can be cut now, and the per-session
//! count of summarizer work behind its `historian_running` answer.
//!
//! A cause is reported with a code, the first that holds, in this order:
//!
//! - `historian_running`: a summarizer run is in flight for the session, or
//!   a second summarizer turn one of its runs started. Either writes the
//!   session's summaries or facts while it runs.
//! - `unknown`: the session's worker did not answer within the op's
//!   budget, so whether it is in the middle of something cannot be told.
//! - `view_unconfirmed`: a view was offered to the runner and the runner has
//!   not confirmed it applies it yet.
//! - `facts_in_flight`: a fact of the session's committed publications is
//!   held by a second-turn send, of this or any session of the project.
//!   Only that send, or a later second turn's recovery, lets it go; a move
//!   never releases another send's facts, since that would change what the
//!   second turn decides.
//!
//! Whether a model turn is in flight is the runner's to report.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cortexkit_role_agent_data::busy::{reason_codes, BusyEntry, BusyReply, BusyState};
use cortexkit_role_agent_data::errors::ErrorBody;
use cortexkit_role_agent_data::refs::Refs;
use cortexkit_role_compaction::read::SessionRef;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};

use super::service::{canonical, Host, Probe};

/// How long `busy` waits for a session's worker to answer.
pub const BUDGET: Duration = Duration::from_secs(2);

/// The codes `busy` reports beside the contract's `historian_running`.
pub const VIEW_UNCONFIRMED: &str = "view_unconfirmed";
pub const FACTS_IN_FLIGHT: &str = "facts_in_flight";
pub const UNKNOWN: &str = "unknown";

/// The reservation key prefix a move puts on the facts it holds. A fact
/// reserved under it is the move's own, never a second-turn send's.
pub const MOVE_RESERVATION: &str = "agent-data:";

/// `busy {refs}`: one entry per ref, in request order. Every ref is
/// resolved first, so a ref this machine does not hold refuses the whole
/// request before anything is asked of a session.
pub(crate) async fn busy<H: Host>(host: &H, refs: &Refs) -> Result<Vec<u8>, ErrorBody> {
    let mut sessions = Vec::with_capacity(refs.len());
    for r in refs.iter() {
        sessions.push(super::resolve::session(host, r).await?);
    }
    let mut entries = Vec::with_capacity(sessions.len());
    for session in &sessions {
        entries.push(cause(host, session).await);
    }
    Ok(canonical(&BusyReply::new(entries)))
}

/// The first cause that keeps the session from being cut now, or `idle`.
pub(crate) async fn cause<H: Host>(host: &H, session: &SessionRef) -> BusyEntry {
    if host.historian_running(session) {
        return BusyEntry::new(BusyState::Busy)
            .with_reason_code(reason_codes::HISTORIAN_RUNNING)
            .with_reason("A summarizer run or its second turn is in flight for this session.");
    }
    match host.probe(session, BUDGET).await {
        Probe::NoAnswer => {
            return BusyEntry::new(BusyState::Unknown)
                .with_reason_code(UNKNOWN)
                .with_reason("The session's worker did not answer in time.")
        }
        Probe::Answered {
            view_unconfirmed: true,
        } => {
            return BusyEntry::new(BusyState::Busy)
                .with_reason_code(VIEW_UNCONFIRMED)
                .with_reason("A view was offered to the runner and is not confirmed yet.")
        }
        Probe::Answered { .. } | Probe::NoWorker => {}
    }
    match facts_in_flight(host.context_db(), session).await {
        Ok(None) => BusyEntry::new(BusyState::Idle),
        Ok(Some(held)) => {
            log_held_fact(session, &held);
            let stage = held.stage.as_deref().unwrap_or("(no stage key)");
            BusyEntry::new(BusyState::Busy)
                .with_reason_code(FACTS_IN_FLIGHT)
                .with_reason(format!(
                    "A second turn holds one of this session's facts (stage {stage})."
                ))
        }
        Err(error) => {
            tracing::warn!(
                "ck-mc: session {}/{}/{}: its waiting facts could not be read for a move ({error}); answering busy unknown",
                session.runner,
                session.harness,
                session.session
            );
            BusyEntry::new(BusyState::Unknown)
                .with_reason_code(UNKNOWN)
                .with_reason("The session's waiting facts could not be read.")
        }
    }
}

/// A fact a second-turn send holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HeldFact {
    pub publication: String,
    pub fact_index: i64,
    /// The send's stage key; `None` only for a fact marked in flight with
    /// no key, which no send releases either.
    pub stage: Option<String>,
    pub project: String,
}

/// Say which second-turn stage keeps the session from moving, and what lets
/// it go.
pub(crate) fn log_held_fact(session: &SessionRef, held: &HeldFact) {
    let stage = held.stage.as_deref().unwrap_or("(no stage key)");
    tracing::info!(
        session = %format!("{}/{}/{}", session.runner, session.harness, session.session),
        stage = %stage,
        "ck-mc: session {}/{}/{} cannot move yet: fact {} of publication {} is in flight under second-turn stage {stage}; a later second turn in a session of project {} resolves or gives it up, then prepare can run again",
        session.runner,
        session.harness,
        session.session,
        held.fact_index,
        held.publication,
        held.project
    );
}

/// The session's committed publications are those whose first turn was
/// published under the session's harness and that were given a place in
/// the project's backlog (`commit_order`), as the second turn's backlog
/// reads them. Of their facts, the first one held in flight by anything
/// but a move, in backlog order.
const HELD_FACT: &str =
    "SELECT f.publication_id, f.fact_index, f.reserved_stage_key, f.project_path
     FROM memory_pending_facts f
     JOIN memory_publications p ON p.publication_id = f.publication_id
     WHERE p.source_session_id = ?1
       AND p.commit_order IS NOT NULL
       AND EXISTS (SELECT 1 FROM memory_stage_attempts s
                   WHERE s.publication_id = p.publication_id AND s.stage = 'turn_one'
                     AND s.state = 'published' AND s.session_id = p.source_session_id
                     AND s.harness = ?2)
       AND f.state = 'in_flight'
       AND (f.reserved_stage_key IS NULL
            OR substr(f.reserved_stage_key, 1, ?3) <> ?4)
     ORDER BY p.commit_order, f.fact_index
     LIMIT 1";

/// Read on a blocking thread over a connection of its own: the module's
/// shared `context.db` connection serves every session, and no session
/// should wait for a move's read.
pub(crate) async fn facts_in_flight(
    db: Option<PathBuf>,
    session: &SessionRef,
) -> Result<Option<HeldFact>, String> {
    let Some(db) = db else {
        return Ok(None);
    };
    let harness = session.harness.clone();
    let id = session.session.clone();
    tokio::task::spawn_blocking(move || held_fact(&db, &harness, &id))
        .await
        .map_err(|error| error.to_string())?
}

fn held_fact(db: &Path, harness: &str, session: &str) -> Result<Option<HeldFact>, String> {
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())?;
    conn.busy_timeout(Duration::from_millis(500))
        .map_err(|error| error.to_string())?;
    held_fact_on(&conn, harness, session)
}

/// The first of the session's facts a second-turn send holds, read on
/// `conn`, inside whatever transaction it has open.
pub(crate) fn held_fact_on(
    conn: &Connection,
    harness: &str,
    session: &str,
) -> Result<Option<HeldFact>, String> {
    conn.query_row(
        HELD_FACT,
        params![
            session,
            harness,
            MOVE_RESERVATION.len() as i64,
            MOVE_RESERVATION
        ],
        |row| {
            Ok(HeldFact {
                publication: row.get(0)?,
                fact_index: row.get(1)?,
                stage: row.get(2)?,
                project: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

/// Summarizer work in flight per session: each run, and each second turn a
/// run started. `Module` keeps a count for the whole module beside it, for
/// its own waits; a move needs the session's own.
#[derive(Debug, Default)]
pub struct Runs(Mutex<HashMap<SessionRef, usize>>);

impl Runs {
    /// Count one piece of work for the session until the guard is dropped.
    pub fn start(self: &Arc<Self>, session: &SessionRef) -> RunGuard {
        *self
            .0
            .lock()
            .expect("summarizer runs")
            .entry(session.clone())
            .or_default() += 1;
        RunGuard {
            runs: Arc::clone(self),
            session: session.clone(),
        }
    }

    pub fn running(&self, session: &SessionRef) -> bool {
        self.0
            .lock()
            .expect("summarizer runs")
            .get(session)
            .is_some_and(|count| *count > 0)
    }
}

/// One piece of summarizer work, counted until dropped. A run's guard
/// travels with its result to the session's worker and is dropped once the
/// worker has handled the result, after any second turn it started holds
/// a guard of its own; a result that never reaches the worker drops it too.
#[derive(Debug)]
pub struct RunGuard {
    runs: Arc<Runs>,
    session: SessionRef,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        let mut runs = self.runs.0.lock().expect("summarizer runs");
        if let Some(count) = runs.get_mut(&self.session) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                runs.remove(&self.session);
            }
        }
    }
}
