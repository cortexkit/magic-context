//! Attribution facts: what each child session ck-mc starts on a runner is
//! for, so Astrocyte (the usage and analytics module) can charge that
//! child's model spend to the agent, task and project behind it.
//!
//! A summary's first turn, each memory fact check of its second turn, and
//! each dreamer task run make their model calls in child sessions of ck-mc's
//! own ([`crate::summary::run`], [`crate::dreamer::run`]). Right before the
//! send that creates such a child, [`Attribution::record`] stores one fact
//! about it in `context.db`'s `attribution_facts` table (migration 111): the
//! child as ck-mc bound it, the workload and task it serves, the head session
//! a summary serves with that session's agent, and the project. A later send
//! to the same child (the second turn continues the first turn's child) adds
//! nothing, because a fact's id is derived from the child alone
//! ([`fact_id`]).
//!
//! Facts are append-only and kept forever: they belong to no session, so no
//! session cleanup touches them. A correction would be a new fact whose
//! `supersedes` names the old one's id; nothing writes one yet.
//!
//! Astrocyte reads the facts two ways: the `attribution.read` page on ck-mc's
//! management surface ([`read`]), and the `attribution_fact` v1 bus event,
//! whose payload is the fact's stored body. The table is the event's outbox:
//! `published_at_ms` stays null until the bus acknowledged the event
//! ([`crate::bus::AttributionEvents`]).
//!
//! Recording never stops a run: a fact that can't be stored is logged as a
//! warning, and the child is sent its prompt anyway.

pub(crate) mod read;

use cortexkit_role_compaction::read::SessionRef;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::context_db::ContextDb;

/// The event, and its version.
pub(crate) const EVENT_NAME: &str = "attribution_fact";
pub(crate) const EVENT_VERSION: u32 = 1;
/// A fact's body must stay below this many bytes: the event carries the body
/// as its payload, and Astrocyte's contract keeps that payload under 4 KiB.
pub(crate) const MAX_BODY_BYTES: usize = 4096;
/// What every fact id's hash input starts with.
const FACT_ID_DOMAIN: &str = "magic-context.attribution.v1";
/// The revision of the fact that records a child's creation, the last part
/// of its id's hash input. Only this revision is written today.
const CREATION_REVISION: &str = "1";
/// The longest task name a fact may carry.
const MAX_TASK_BYTES: usize = 128;
/// The longest workload name a fact may carry.
const MAX_WORKLOAD_BYTES: usize = 64;

/// The `attribution_fact` event as the module's manifest declares it. Its
/// notice carries no filter headers: the bus's own message id and content
/// digest headers, and the fact as its payload.
pub(crate) fn event_declaration() -> subc_protocol::manifest::EventDeclaration {
    subc_protocol::manifest::EventDeclaration::new(EVENT_NAME, EVENT_VERSION).with_summary(Some(
        "Magic Context recorded the agent, task and project a child session it started works for"
            .into(),
    ))
}

/// The kind of work a child session does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Workload {
    /// A summary of a head session's history, or a fact check of its second
    /// turn.
    Summary,
    /// A dreamer task run.
    Dreamer,
}

impl Workload {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Summary => "summary",
            Self::Dreamer => "dreamer",
        }
    }
}

/// What a child session is for: everything its fact says except the child
/// itself and the times.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Purpose {
    pub workload: Workload,
    /// `magic-context.summary`, or `magic-context.dream.<task kind>`: the
    /// routing consumer the child's model was selected under.
    pub task: String,
    /// The agent the head session works for, as its route's scope named it;
    /// none for a dreamer run or a head whose scope named no agent.
    pub alfonso: Option<String>,
    /// The head session a summary serves; none for a dreamer run.
    pub parent: Option<SessionRef>,
    /// The project id the run serves, when it serves one.
    pub project_id: Option<String>,
}

impl Purpose {
    /// A summary child, or a fact-check child of its second turn, serving
    /// the head session `head`, which works for `agent` in `project`.
    pub(crate) fn summary(head: &SessionRef, agent: Option<&str>, project: Option<&str>) -> Self {
        Self {
            workload: Workload::Summary,
            task: crate::routing::SUMMARY_CONSUMER.to_owned(),
            alfonso: agent.map(str::to_owned),
            parent: Some(head.clone()),
            project_id: project.map(str::to_owned),
        }
    }

    /// A child of a dreamer task of kind `kind`, run for `project` when the
    /// task's owner is a project.
    pub(crate) fn dream(kind: &str, project: Option<&str>) -> Self {
        Self {
            workload: Workload::Dreamer,
            task: crate::routing::dream_consumer(kind),
            alfonso: None,
            parent: None,
            project_id: project.map(str::to_owned),
        }
    }
}

/// A [`Purpose`] and the store its facts go to. A send that creates a child
/// records the child's fact through it, right before the send goes out
/// ([`crate::summary::run::Model::attribution`]).
#[derive(Clone, Copy)]
pub(crate) struct Attribution<'a> {
    pub db: &'a ContextDb,
    pub purpose: &'a Purpose,
}

impl Attribution<'_> {
    /// Record that `child` is being created for this purpose, unless its
    /// fact is already stored, and wake the event publisher after the commit
    /// that stored a new one. A fact that can't be stored is logged as a
    /// warning and the run goes on without it.
    pub(crate) fn record(&self, child: &SessionRef) {
        let stored = fact(child, self.purpose, crate::memory_writes::now_ms()).and_then(|fact| {
            self.db
                .with_connection(|conn| insert(conn, &fact))
                .map_err(|error| error.to_string())
        });
        match stored {
            Ok(true) => self.db.attribution_recorded(),
            Ok(false) => {}
            Err(error) => tracing::warn!(
                session = %child.session,
                %error,
                "ck-mc: attribution: a child runs without an attribution fact"
            ),
        }
    }
}

/// A fact ready to store: its id, the body the read and the event serve,
/// and when it was recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Fact {
    pub fact_id: String,
    pub body: String,
    pub recorded_at_ms: i64,
}

/// The id of the fact that records `child`'s creation: the lowercase hex
/// SHA-256 of `magic-context.attribution.v1` 0x00 runner 0x00 harness 0x00
/// session 0x00 `1`. The trailing `1` is the creation fact's revision; a
/// fact that later corrects it would hash revision `2`, `3` and so on, so a
/// correction's id can never collide with the first fact's. The id is keyed
/// by what set the fact's values (the creation of that child), never by the
/// values themselves, so recording the same child again, on a retried send
/// or by a backfill, finds the fact already stored.
pub(crate) fn fact_id(child: &SessionRef) -> String {
    let mut hash = Sha256::new();
    for (index, part) in [
        FACT_ID_DOMAIN,
        child.runner.as_str(),
        child.harness.as_str(),
        child.session.as_str(),
        CREATION_REVISION,
    ]
    .into_iter()
    .enumerate()
    {
        if index > 0 {
            hash.update([0u8]);
        }
        hash.update(part.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

/// A session as a fact names it: the runner module, the harness, and the
/// session id as ck-mc bound them.
fn session_json(session: &SessionRef) -> Value {
    json!({
        "kind": "session",
        "runner": session.runner,
        "harness": session.harness,
        "session": session.session,
    })
}

/// Whether `name` uses only lowercase letters, digits, `_`, `-` and, when
/// `dots` allows them, `.`, and is at most `max` bytes long.
fn valid_name(name: &str, max: usize, dots: bool) -> bool {
    !name.is_empty()
        && name.len() <= max
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || byte == b'_'
                || byte == b'-'
                || (dots && byte == b'.')
        })
}

/// The fact recording `child`'s creation for `purpose` at `now_ms`. Its body
/// is the RFC 8785 (JCS) form of the fact: sorted keys and no whitespace, so
/// reading it back and writing it again never changes the bytes its digest
/// covers. Refused when the task or workload name breaks the contract's
/// charset, or when the body would reach [`MAX_BODY_BYTES`].
pub(crate) fn fact(child: &SessionRef, purpose: &Purpose, now_ms: i64) -> Result<Fact, String> {
    let workload = purpose.workload.name();
    if !valid_name(workload, MAX_WORKLOAD_BYTES, false) {
        return Err(format!("workload {workload:?} is not a valid name"));
    }
    if !valid_name(&purpose.task, MAX_TASK_BYTES, true) {
        return Err(format!("task {:?} is not a valid name", purpose.task));
    }
    let fact_id = fact_id(child);
    let value = json!({
        "fact_id": fact_id,
        "supersedes": null,
        "subject": session_json(child),
        "alfonso": purpose.alfonso,
        "parent": purpose.parent.as_ref().map(session_json),
        "workload": workload,
        "task": purpose.task,
        "project_id": purpose.project_id,
        "effective_from_ms": now_ms,
        "recorded_at_ms": now_ms,
    });
    let body = serde_jcs::to_string(&value).map_err(|error| error.to_string())?;
    if body.len() >= MAX_BODY_BYTES {
        return Err(format!(
            "the fact is {} bytes; a fact must stay under {MAX_BODY_BYTES}",
            body.len()
        ));
    }
    Ok(Fact {
        fact_id,
        body,
        recorded_at_ms: now_ms,
    })
}

/// Store `fact` unless a fact with its id is already stored. Whether it was
/// stored now. The insert is its own commit.
pub(crate) fn insert(conn: &Connection, fact: &Fact) -> rusqlite::Result<bool> {
    conn.execute(
        "INSERT OR IGNORE INTO attribution_facts(fact_id, body, recorded_at_ms)
         VALUES (?1, ?2, ?3)",
        params![fact.fact_id, fact.body, fact.recorded_at_ms],
    )
    .map(|inserted| inserted == 1)
}

/// A stored fact: its place in the order the read serves, its id and body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Stored {
    pub seq: i64,
    pub fact_id: String,
    pub body: String,
}

/// The oldest `limit` facts whose event the bus hasn't acknowledged yet.
pub(crate) fn unpublished(conn: &Connection, limit: usize) -> rusqlite::Result<Vec<Stored>> {
    conn.prepare_cached(
        "SELECT seq, fact_id, body FROM attribution_facts
          WHERE published_at_ms IS NULL ORDER BY seq LIMIT ?1",
    )?
    .query_map(params![i64::try_from(limit).unwrap_or(i64::MAX)], |row| {
        Ok(Stored {
            seq: row.get(0)?,
            fact_id: row.get(1)?,
            body: row.get(2)?,
        })
    })?
    .collect()
}

/// Record that the bus acknowledged the event of the fact at `seq`.
pub(crate) fn mark_published(conn: &Connection, seq: i64, at_ms: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE attribution_facts SET published_at_ms = ?2
          WHERE seq = ?1 AND published_at_ms IS NULL",
        params![seq, at_ms],
    )
    .map(|_| ())
}

#[cfg(test)]
pub(crate) mod tests;

#[cfg(test)]
mod samples_tests;
