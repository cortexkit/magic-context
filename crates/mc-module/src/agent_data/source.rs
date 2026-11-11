//! The source side of a move: `prepare`, `export`, `release`, and `abort`
//! before `release`.
//!
//! `prepare` cuts each session where it stands. It runs on the session's
//! worker, parked between two jobs, so no Setup, notice or summary result
//! of the session runs while it checks, freezes and reads. Per ref:
//!
//! 1. Check `busy` again, and refuse if the session is busy.
//! 2. Freeze the session in the journal, durably, which also sets the gate:
//!    from here on every surface refuses it `session_moving`, and its worker
//!    holds what it is sent.
//! 3. In one short write transaction, reserve the session's waiting facts
//!    under `agent-data:<cutId>`, or refuse `busy` with `facts_in_flight`
//!    when a second-turn send holds one of them. A second turn of any
//!    session of the project takes `retryable` facts of every committed
//!    publication, and the gate cannot stop a turn of another session, so
//!    the move takes the facts out of reach instead. Nothing but this file
//!    lets that reservation go. When the summarizer's second turn takes
//!    facts to send, in ck-mc or in a plugin host, it first writes a stage
//!    row in `memory_stage_attempts` (stage `turn_two`) under a stage key
//!    built from the project, the publication and the attempt number, then
//!    marks each fact it takes `in_flight` with that key in
//!    `reserved_stage_key`. Every path that later lets such a fact go or
//!    decides it (revoking the send, releasing facts it did not use, giving
//!    up an unfinished stage, applying the answer) finds the facts by a key
//!    read from its own stage row or by joining that table on the key. The
//!    move's key, `agent-data:<cutId>`, has no stage row, so none of those
//!    paths ever selects a fact the move reserved.
//! 4. Read the session's rows and the schema version in one read
//!    transaction, and write the snapshot to a private file beside the
//!    journal.
//! 5. Check with Engram's session door that what earlier moves admitted to
//!    the session's stream is covered, and compute the cut's digest over the
//!    stream with this snapshot appended.
//!
//! When any ref is refused, or a later step fails, every session the cut's
//! `prepare` froze, in this attempt or in one a crash cut short, is
//! unfrozen before the reply: its reservation is released first, then
//! the journal stops naming it frozen, then its held jobs run. That order
//! holds everywhere a reservation is let go, so a fact is reserved under a
//! cut only while the journal records a session of that cut frozen or
//! released; a crash between the two writes leaves the session frozen, and
//! the repeated op or an `abort` finishes the work.
//!
//! The ops read and write `context.db` on a blocking thread over a
//! connection of their own: the module's own connection serves every
//! session, and none of them should wait for a move.

use std::path::{Path, PathBuf};
use std::time::Duration;

use cortexkit_role_agent_data::busy::reason_codes;
use cortexkit_role_agent_data::errors::{
    BusyDetail, BusyRef, Detail, ErrorBody, InvalidStateDetail, ParticipantFailedDetail,
    RefusalCode,
};
use cortexkit_role_agent_data::export::{ExportReply, ExportedItem};
use cortexkit_role_agent_data::prepare::{PrepareReply, PreparedItem};
use cortexkit_role_agent_data::refs::{Ref, Refs};
use cortexkit_role_agent_data::release::ReleaseReply;
use cortexkit_role_agent_data::step::Step;
use cortexkit_role_agent_data::{EmptyReply, Op};
use cortexkit_role_compaction::read::SessionRef;
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};

use super::busy::{self, HeldFact};
use super::journal::{self, Contents, Cut, Journal, Moving, MovingState, Prepared, Released};
use super::service::{
    canonical, journal_unreadable, not_served_yet, After, Done, Host, Park, Parked,
};
use super::{door, moved, resolve, snapshot};
use crate::context_db::SCHEMA_VERSION;

/// How long a move waits for a `context.db` lock another host holds. The
/// move runs on a thread of its own, so the wait holds up no session.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// The folder of a cut's files, beside the journal.
pub fn cut_folder(context_db: &Path, cut: &str) -> PathBuf {
    journal::folder(context_db).join("cuts").join(cut)
}

/// The snapshot `prepare` wrote for one session of a cut.
pub fn snapshot_file(context_db: &Path, cut: &str, session_ref: &str) -> PathBuf {
    cut_folder(context_db, cut).join(format!("{session_ref}.snapshot"))
}

/// The session's handle on the door: the llm-runner `sessionRef` of the
/// runner, harness and session Entorhinal's binding names.
pub fn session_ref(session: &SessionRef) -> String {
    cortexkit_role_llm_runner::session_ref(&cortexkit_role_llm_runner::SessionIdentity {
        runner: &session.runner,
        harness: &session.harness,
        session: &session.session,
    })
}

/// `prepare {refs, cutId}`.
pub(crate) async fn prepare<H: Host>(host: &H, cut: &str, refs: &Refs) -> Result<Done, ErrorBody> {
    let db = host.context_db().ok_or_else(no_store)?;
    let prepared = match cut_each(host, &db, cut, refs).await {
        Ok(prepared) => prepared,
        Err(refusal) => return Err(unfreeze(host, &db, cut, refusal).await),
    };
    let stream = host.stream();
    let items = refs
        .iter()
        .zip(&prepared)
        .map(|(r, (one, format))| {
            PreparedItem::new(
                &r.ref_kind,
                &r.r#ref,
                &one.session_ref,
                &stream,
                one.end,
                &one.digest,
                format,
                true,
            )
        })
        .collect();
    let reply = canonical(&PrepareReply::new(items, Vec::new()));
    let cut = cut.to_owned();
    let prepared: Vec<Prepared> = prepared.into_iter().map(|(one, _)| one).collect();
    Ok(Done {
        reply,
        edit: Box::new(move |contents| {
            if let Some(record) = contents.cuts.get_mut(&cut) {
                record.prepared = prepared;
            }
        }),
        after: Vec::new(),
    })
}

/// Resolve every ref and refuse the ones that cannot be cut before
/// anything is frozen, then take steps 1 to 5 for each ref in turn.
async fn cut_each<H: Host>(
    host: &H,
    db: &Path,
    cut: &str,
    refs: &Refs,
) -> Result<Vec<(Prepared, String)>, ErrorBody> {
    let mut sessions = Vec::with_capacity(refs.len());
    for r in refs.iter() {
        sessions.push(resolve::session(host, r).await?);
    }
    // context.db keys a session's rows by harness and session id alone, so
    // two refs naming the same rows would cut them twice.
    for (index, session) in sessions.iter().enumerate() {
        if let Some(earlier) = sessions[..index]
            .iter()
            .position(|earlier| same_rows(earlier, session))
        {
            let (first, second) = (&refs.as_slice()[earlier], &refs.as_slice()[index]);
            return Err(ErrorBody::new(
                RefusalCode::NotExportable,
                format!(
                    "{}/{} and {}/{} name the same session ({}/{}); a cut carries each session once.",
                    first.ref_kind,
                    first.r#ref,
                    second.ref_kind,
                    second.r#ref,
                    session.harness,
                    session.session
                ),
            ));
        }
    }
    {
        let contents = host.journal().contents().ok_or_else(journal_unreadable)?;
        for (r, session) in refs.iter().zip(&sessions) {
            if let Some(refusal) = held_elsewhere(&contents, cut, r, session) {
                return Err(refusal);
            }
        }
    }
    let mut prepared = Vec::with_capacity(refs.len());
    for (r, session) in refs.iter().zip(&sessions) {
        prepared.push(prepare_one(host, db, cut, r, session).await?);
    }
    Ok(prepared)
}

/// Steps 1 to 5 for one ref. Returns where the cut ends for it, and the
/// format its `prepare` item names.
async fn prepare_one<H: Host>(
    host: &H,
    db: &Path,
    cut: &str,
    r: &Ref,
    session: &SessionRef,
) -> Result<(Prepared, String), ErrorBody> {
    // 1. Stop the session's worker between two jobs, and check busy there.
    let mut parked = park(host, r, session).await?;
    check_running(host, r, session, parked.as_ref())?;
    check_facts(db, r, session).await?;
    // 2. The freeze, durable before anything is reserved or read.
    freeze(host.journal(), cut, r, session)?;
    // A session with no worker at the check may have got one since, from a
    // Setup admitted just before the freeze. Its worker holds every job it
    // takes from now on; parking it waits for one it already started.
    if parked.is_none() {
        parked = park(host, r, session).await?;
        check_running(host, r, session, parked.as_ref())?;
    }
    // 3. Reserve the waiting facts, or refuse when a send holds one.
    let key = moved::reservation(cut);
    let owner = session.clone();
    if let Err(held) = blocking(db, move |conn| reserve(conn, &owner, &key)).await? {
        busy::log_held_fact(session, &held);
        return Err(held_refusal(r, &held));
    }
    // 4. The rows and the schema version, read in one transaction.
    let owner = session.clone();
    let encoded = blocking(db, move |conn| snapshot::read(conn, &owner)).await?;
    let version = encoded.header.schema_version;
    if version != i64::from(SCHEMA_VERSION) {
        // `prepare` may not answer incompatible_version; the move can go on
        // once this machine runs a ck-mc built for its context.db.
        return Err(unavailable(format!(
            "incompatible_version: context.db is at schema version {version} and this ck-mc reads version {SCHEMA_VERSION}; run the ck-mc built for this context.db, then prepare again"
        )));
    }
    let session_ref = session_ref(session);
    let file = snapshot_file(db, cut, &session_ref);
    crate::private_permissions::write_file_atomic(&file, &encoded.bytes).map_err(|error| {
        unavailable(format!(
            "the snapshot of {} could not be written to {} ({error})",
            label(session),
            file.display()
        ))
    })?;
    // 5. What earlier moves admitted must be in the cloud before this cut
    // builds on it. The door's offsets answer at once; only when the cloud
    // is behind does prepare wait, once, for the door to upload the rest.
    let refused = |error| door_refusal(Op::Prepare, r, Step::None, error);
    let mut position = door::offsets(host, &session_ref).await.map_err(refused)?;
    if position.cloud_offset < position.durable_offset {
        position = door::cover(host, &session_ref).await.map_err(refused)?;
    }
    if position.cloud_offset < position.durable_offset {
        return Err(unavailable(format!(
            "Engram's session door has copied session {session_ref}'s stream to byte {} of {}; prepare again once it has all of it",
            position.cloud_offset, position.durable_offset
        )));
    }
    let start = position.durable_offset;
    let digest = door::digest(host, &session_ref, start, &encoded.bytes)
        .await
        .map_err(refused)?;
    drop(parked);
    let format = format!("{}+context.db/{version}", snapshot::FORMAT);
    Ok((
        Prepared {
            ref_kind: r.ref_kind.clone(),
            reference: r.r#ref.clone(),
            runner: session.runner.clone(),
            harness: session.harness.clone(),
            session: session.session.clone(),
            session_ref,
            start,
            end: start + encoded.bytes.len() as u64,
            digest,
            body: encoded.header.body_sha256,
        },
        format,
    ))
}

/// `export {refs, cutId}`: admit each prepared snapshot to the door, from
/// wherever the door's stream already ends, and record each session's
/// baseline: its snapshot body's digest, which a later move back compares
/// this machine's rows with.
pub(crate) async fn export<H: Host>(
    host: &H,
    cut: &str,
    record: &Cut,
    refs: &Refs,
) -> Result<Done, ErrorBody> {
    let db = host.context_db().ok_or_else(no_store)?;
    let mut items = Vec::with_capacity(refs.len());
    for r in refs.iter() {
        let one = record
            .prepared
            .iter()
            .find(|one| one.ref_kind == r.ref_kind && one.reference == r.r#ref)
            .ok_or_else(|| {
                unavailable(format!(
                    "cut {cut} recorded no snapshot for {}/{}; abort the move",
                    r.ref_kind, r.r#ref
                ))
            })?;
        let file = snapshot_file(&db, cut, &one.session_ref);
        let bytes = std::fs::read(&file).map_err(|error| {
            unavailable(format!(
                "the snapshot prepare wrote to {} cannot be read ({error}); abort the move and prepare it again",
                file.display()
            ))
        })?;
        if bytes.len() as u64 != one.end - one.start
            || body_digest(&bytes).as_deref() != Some(one.body.as_str())
        {
            return Err(unavailable(format!(
                "the snapshot at {} is not the one prepare wrote; abort the move and prepare it again",
                file.display()
            )));
        }
        door::admit(host, &one.session_ref, one.start, &bytes)
            .await
            .map_err(|error| door_refusal(Op::Export, r, record.step, error))?;
        items.push(ExportedItem::new(&one.session_ref, one.end));
    }
    let prepared = record.prepared.clone();
    Ok(Done {
        reply: canonical(&ExportReply::new(items)),
        edit: Box::new(move |contents| {
            for one in prepared {
                contents
                    .session_mut(&one.runner, &one.harness, &one.session)
                    .baseline = Some(one.body);
            }
        }),
        after: Vec::new(),
    })
}

/// `release {refs, cutId, holder}`: the freeze becomes a tombstone naming
/// the new holder, so every surface refuses the session `session_moved`,
/// reads included, and nothing this process keeps for it outlives the
/// move. Its facts stay reserved, so this machine never decides them again;
/// a move back replaces them.
pub(crate) async fn release<H: Host>(
    host: &H,
    cut: &str,
    record: &Cut,
    holder: &str,
) -> Result<Done, ErrorBody> {
    let contents = host.journal().contents().ok_or_else(journal_unreadable)?;
    let sessions: Vec<SessionRef> = record
        .prepared
        .iter()
        .map(|one| SessionRef::new(&one.runner, &one.harness, &one.session))
        .collect();
    for session in &sessions {
        let frozen = contents
            .session(&session.runner, &session.harness, &session.session)
            .and_then(|entry| entry.moving.as_ref())
            .is_some_and(|moving| moving.cut == cut && moving.state == MovingState::Frozen);
        if !frozen {
            return Err(unavailable(format!(
                "session {} is not frozen by cut {cut} as its export left it; the journal was changed by hand",
                label(session)
            )));
        }
    }
    let mut after: Vec<After> = sessions
        .iter()
        .map(|session| After::Forget(session.clone(), cut.to_owned()))
        .collect();
    if let Some(db) = host.context_db() {
        after.push(After::Remove(cut_folder(&db, cut)));
    }
    let (cut, holder) = (cut.to_owned(), holder.to_owned());
    Ok(Done {
        reply: canonical(&ReleaseReply::new(true)),
        edit: Box::new(move |contents| {
            for session in &sessions {
                let entry =
                    contents.session_mut(&session.runner, &session.harness, &session.session);
                entry.moving = None;
                entry.released = Some(Released {
                    cut: cut.clone(),
                    holder: holder.clone(),
                });
            }
        }),
        after,
    })
}

/// `abort {refs, cutId}` on the source, or for a cut this machine never
/// saw. The cut's reservation is released before the journal write that
/// unfreezes its sessions and records the cut aborted; the snapshot files
/// are deleted and the held jobs run once that write is durable. A cut
/// never seen here froze nothing, so its abort touches no data.
pub(crate) async fn abort<H: Host>(
    host: &H,
    cut: &str,
    record: Option<&Cut>,
) -> Result<Done, ErrorBody> {
    let contents = host.journal().contents().ok_or_else(journal_unreadable)?;
    let step = record.map_or(Step::None, |record| record.step);
    let mut frozen = Vec::new();
    for entry in &contents.sessions {
        match &entry.moving {
            Some(moving) if moving.cut == cut && moving.state == MovingState::Frozen => frozen
                .push(SessionRef::new(
                    &entry.runner,
                    &entry.harness,
                    &entry.session,
                )),
            // The receiver's abort is not served by this build yet.
            Some(moving) if moving.cut == cut => return Err(not_served_yet(Op::Abort)),
            _ => {}
        }
    }
    if step == Step::Imported {
        return Err(not_served_yet(Op::Abort));
    }
    let db = host.context_db();
    if let (Some(db), false) = (&db, frozen.is_empty()) {
        let key = moved::reservation(cut);
        let released = blocking(db, move |conn| release_reservation(conn, &key)).await?;
        tracing::info!(
            cut = %cut,
            "ck-mc: agent-data cut {cut} is aborted: {released} reserved facts are retryable again"
        );
    }
    let mut after = Vec::new();
    if let Some(db) = &db {
        after.push(After::Remove(cut_folder(db, cut)));
    }
    for session in &frozen {
        tracing::info!(
            cut = %cut,
            "ck-mc: session {} is served again: agent-data cut {cut} was aborted, and the jobs it held run now",
            label(session)
        );
        after.push(After::Resume(session.clone()));
    }
    let cut = cut.to_owned();
    Ok(Done {
        edit: Box::new(move |contents| {
            for session in &frozen {
                lift(contents, session, &cut);
            }
        }),
        after,
        ..Done::reply(&EmptyReply::new())
    })
}

/// Unfreeze every session a refused `prepare` of `cut` left frozen, this
/// attempt's and any earlier attempt's a crash cut short, and pass its
/// refusal on. `prepare` is a cut's first op on the source, so only it
/// freezes sessions under the cut before a reply is recorded. The
/// reservation is released first, then the journal stops naming the
/// sessions frozen, then their held jobs run. When either write fails the
/// sessions stay frozen, which is safe: a repeat of the same `prepare` or an
/// `abort` lets them go.
async fn unfreeze<H: Host>(host: &H, db: &Path, cut: &str, refusal: ErrorBody) -> ErrorBody {
    let Some(contents) = host.journal().contents() else {
        return refusal;
    };
    let froze = frozen_by(&contents, cut);
    if froze.is_empty() {
        return refusal;
    }
    let names = froze.iter().map(label).collect::<Vec<_>>().join(", ");
    let key = moved::reservation(cut);
    if let Err(error) = blocking(db, move |conn| release_reservation(conn, &key)).await {
        tracing::error!(
            cut = %cut,
            "ck-mc: prepare for agent-data cut {cut} was refused ({}), and its reserved facts could not be released ({}); sessions {names} stay frozen until prepare is sent again or the move is aborted",
            refusal.message,
            error.message
        );
        return unavailable(format!(
            "{} The sessions this prepare froze could not be unfrozen ({}); send the same prepare again or abort the move.",
            refusal.message, error.message
        ));
    }
    let lifted = host.journal().change(|contents| {
        for session in &froze {
            lift(contents, session, cut);
        }
    });
    if let Err(error) = lifted {
        tracing::error!(
            cut = %cut,
            "ck-mc: prepare for agent-data cut {cut} was refused ({}), and the journal could not unfreeze sessions {names} ({error}); they stay frozen until prepare is sent again or the move is aborted",
            refusal.message
        );
        return unavailable(format!(
            "{} The sessions this prepare froze could not be unfrozen ({error}); send the same prepare again or abort the move.",
            refusal.message
        ));
    }
    let _ = std::fs::remove_dir_all(cut_folder(db, cut));
    tracing::info!(
        cut = %cut,
        "ck-mc: prepare for agent-data cut {cut} was refused ({}); sessions {names} are unfrozen and the jobs held for them run now",
        refusal.message
    );
    for session in &froze {
        host.resume(session);
    }
    refusal
}

/// The sessions frozen at the source under `cut`.
fn frozen_by(contents: &Contents, cut: &str) -> Vec<SessionRef> {
    contents
        .sessions
        .iter()
        .filter(|entry| {
            entry
                .moving
                .as_ref()
                .is_some_and(|moving| moving.cut == cut && moving.state == MovingState::Frozen)
        })
        .map(|entry| SessionRef::new(&entry.runner, &entry.harness, &entry.session))
        .collect()
}

/// Delete the files of cuts that ended, left behind by a crash between the
/// journal write that ended the cut and their deletion. A cut a session is
/// still frozen, staged or installed under keeps its files.
pub fn sweep(context_db: &Path, journal: &Journal) {
    let Some(contents) = journal.contents() else {
        return;
    };
    let Ok(folders) = std::fs::read_dir(journal::folder(context_db).join("cuts")) else {
        return;
    };
    for folder in folders.flatten() {
        let cut = folder.file_name().to_string_lossy().into_owned();
        let held = contents.sessions.iter().any(|entry| {
            entry
                .moving
                .as_ref()
                .is_some_and(|moving| moving.cut == cut)
        });
        let ended = contents.cuts.get(&cut).is_none_or(|record| {
            matches!(
                record.step,
                Step::Aborted | Step::Released | Step::Activated | Step::None
            )
        });
        if !held && ended {
            match std::fs::remove_dir_all(folder.path()) {
                Ok(()) => tracing::info!(
                    cut = %cut,
                    "ck-mc: deleted the files of agent-data cut {cut}, which has ended"
                ),
                Err(error) => tracing::warn!(
                    cut = %cut,
                    "ck-mc: the files of ended agent-data cut {cut} could not be deleted ({error}); they can be deleted by hand"
                ),
            }
        }
    }
}

/// Stop the session's worker between two jobs, or learn it has none.
async fn park<H: Host>(
    host: &H,
    r: &Ref,
    session: &SessionRef,
) -> Result<Option<Parked>, ErrorBody> {
    match host.park(session, busy::BUDGET).await {
        Park::NoWorker => Ok(None),
        Park::Parked(parked) => Ok(Some(parked)),
        Park::NoAnswer => Err(busy_refusal(
            r,
            busy::UNKNOWN,
            "The session's worker did not answer in time.",
        )),
    }
}

/// `busy`'s causes that only this process knows: a summarizer run, and a
/// view the parked worker offered and the runner has not confirmed.
fn check_running<H: Host>(
    host: &H,
    r: &Ref,
    session: &SessionRef,
    parked: Option<&Parked>,
) -> Result<(), ErrorBody> {
    if host.historian_running(session) {
        return Err(busy_refusal(
            r,
            reason_codes::HISTORIAN_RUNNING,
            "A summarizer run or its second turn is in flight for this session.",
        ));
    }
    if parked.is_some_and(|parked| parked.view_unconfirmed) {
        return Err(busy_refusal(
            r,
            busy::VIEW_UNCONFIRMED,
            "A view was offered to the runner and is not confirmed yet.",
        ));
    }
    Ok(())
}

async fn check_facts(db: &Path, r: &Ref, session: &SessionRef) -> Result<(), ErrorBody> {
    match busy::facts_in_flight(Some(db.to_owned()), session).await {
        Ok(None) => Ok(()),
        Ok(Some(held)) => {
            busy::log_held_fact(session, &held);
            Err(held_refusal(r, &held))
        }
        Err(error) => Err(busy_refusal(
            r,
            busy::UNKNOWN,
            format!("The session's waiting facts could not be read ({error})."),
        )),
    }
}

fn held_refusal(r: &Ref, held: &HeldFact) -> ErrorBody {
    busy_refusal(
        r,
        busy::FACTS_IN_FLIGHT,
        format!(
            "A second turn holds one of this session's facts (stage {}).",
            held.stage.as_deref().unwrap_or("(no stage key)")
        ),
    )
}

/// What `op` answers for a failed door step, by [`door::answer`]'s table.
/// `step` is the cut's step when the op started, named in `invalid_state`
/// detail or in a permanent fault's diagnostic reason.
fn door_refusal(op: Op, r: &Ref, step: Step, error: door::DoorError) -> ErrorBody {
    let invalid_state = |message: String| {
        ErrorBody::with_typed_detail(Detail::InvalidState(InvalidStateDetail::new(step)), message)
    };
    let said = error.message.trim_end_matches('.');
    match door::answer(op, &error.code) {
        door::Answer::Unavailable => unavailable(error.message),
        door::Answer::UnknownRef => resolve::unknown_ref(
            r,
            &format!("{said}; this machine no longer writes the session's stream on Engram's door"),
        ),
        door::Answer::Handoff => invalid_state(format!(
            "{said}. Another cut of the session's stream waits for its handoff; finish or abort that move first."
        )),
        door::Answer::Fault(fix) => {
            let message = format!(
                "{said}. Fix this on this machine before the session can move: {fix}. The order of the cut's ops is not the cause."
            );
            if op == Op::Activate {
                // An older driver decodes participant_failed as unknown on
                // activate and aborts instead of holding the cut as a fork
                // for the operator to resolve. Keep the old refusal until
                // those drivers support the new code.
                return invalid_state(message);
            }
            ErrorBody::with_participant_failed_detail(
                ParticipantFailedDetail::new(format!(
                    "session_door:{} at {}",
                    error.code,
                    step.as_str()
                )),
                message,
            )
        }
    }
}

#[cfg(test)]
#[path = "door_tests.rs"]
mod door_tests;

fn busy_refusal(r: &Ref, code: &str, reason: impl Into<String>) -> ErrorBody {
    let reason = reason.into();
    ErrorBody::with_typed_detail(
        Detail::Busy(BusyDetail::new(vec![BusyRef::new(
            &r.ref_kind,
            &r.r#ref,
            &reason,
        )
        .with_reason_code(code)])),
        format!("{}/{} cannot be cut now: {reason}", r.ref_kind, r.r#ref),
    )
}

/// Freeze the session under `cut` in the journal, unless another move
/// holds it. Freezing a session this cut already froze, as a repeat after a
/// crash does, changes nothing.
fn freeze(journal: &Journal, cut: &str, r: &Ref, session: &SessionRef) -> Result<(), ErrorBody> {
    journal
        .change(|contents| {
            if let Some(refusal) = held_elsewhere(contents, cut, r, session) {
                return Err(refusal);
            }
            contents
                .session_mut(&session.runner, &session.harness, &session.session)
                .moving = Some(Moving {
                cut: cut.to_owned(),
                state: MovingState::Frozen,
            });
            Ok(())
        })
        .map_err(|error| {
            unavailable(format!(
                "the freeze of {} could not be recorded ({error})",
                label(session)
            ))
        })?
}

/// Why `cut` may not freeze the session: another move holds its rows (any
/// runner's, since they share them), or it was moved away from here.
fn held_elsewhere(
    contents: &Contents,
    cut: &str,
    r: &Ref,
    session: &SessionRef,
) -> Option<ErrorBody> {
    let step = contents
        .cuts
        .get(cut)
        .map_or(Step::None, |record| record.step);
    for entry in contents
        .sessions
        .iter()
        .filter(|entry| entry.harness == session.harness && entry.session == session.session)
    {
        match (&entry.moving, &entry.released) {
            (Some(moving), _) if moving.cut == cut && moving.state == MovingState::Frozen => {}
            (Some(moving), _) => {
                return Some(ErrorBody::with_typed_detail(
                    Detail::InvalidState(InvalidStateDetail::new(step)),
                    format!(
                        "{}/{} names session {}/{}, which agent-data cut {} holds {}; a session is in one move at a time.",
                        r.ref_kind,
                        r.r#ref,
                        session.harness,
                        session.session,
                        moving.cut,
                        moving.state.describe()
                    ),
                ))
            }
            (None, Some(released)) => {
                return Some(resolve::unknown_ref(
                    r,
                    &format!(
                        "session_moved: cut {} moved the session to {}",
                        released.cut, released.holder
                    ),
                ))
            }
            (None, None) => {}
        }
    }
    None
}

/// Stop naming the session frozen by `cut`, and drop its entry when no
/// move names it any more.
fn lift(contents: &mut Contents, session: &SessionRef, cut: &str) {
    contents.sessions.retain_mut(|entry| {
        if entry.runner == session.runner
            && entry.harness == session.harness
            && entry.session == session.session
            && entry
                .moving
                .as_ref()
                .is_some_and(|moving| moving.cut == cut && moving.state == MovingState::Frozen)
        {
            entry.moving = None;
            return entry.released.is_some() || entry.baseline.is_some();
        }
        true
    });
}

/// In one write transaction: refuse when a second-turn send holds one of
/// the session's facts, or else reserve its `retryable` facts under `key`.
/// Facts the key already holds stay as they are, so a repeat after a crash
/// reserves only what the first pass did not.
pub(crate) fn reserve(
    conn: &mut Connection,
    session: &SessionRef,
    key: &str,
) -> Result<Result<usize, HeldFact>, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    if let Some(held) = busy::held_fact_on(&tx, &session.harness, &session.session)? {
        return Ok(Err(held));
    }
    let reserved = tx
        .execute(
            &format!(
                "UPDATE memory_pending_facts SET state = 'in_flight', reserved_stage_key = ?3
                 WHERE state = 'retryable' AND publication_id IN ({})",
                moved::publications()
            ),
            params![session.session, session.harness, key],
        )
        .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(Ok(reserved))
}

/// Make every fact reserved under `key` `retryable` again. One statement,
/// so it is one transaction, and repeating it changes nothing.
fn release_reservation(conn: &mut Connection, key: &str) -> Result<usize, String> {
    conn.execute(
        "UPDATE memory_pending_facts SET state = 'retryable', reserved_stage_key = NULL
         WHERE state = 'in_flight' AND reserved_stage_key = ?1",
        params![key],
    )
    .map_err(|error| error.to_string())
}

/// Run `work` on a blocking thread over a `context.db` connection of its
/// own.
async fn blocking<T: Send + 'static>(
    db: &Path,
    work: impl FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
) -> Result<T, ErrorBody> {
    let db = db.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut conn = connect(&db)?;
        work(&mut conn)
    })
    .await
    .map_err(|error| unavailable(format!("a context.db task of the move stopped: {error}")))?
    .map_err(|error| unavailable(format!("context.db: {error}")))
}

/// A connection opened as `ContextDb::open` opens one, foreign keys left
/// off. It syncs every commit, even in WAL mode: a reservation, or its
/// release, must be on disk before the journal records what follows from
/// it, or a power loss could leave facts reserved under a cut the journal
/// says was aborted.
fn connect(db: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("{}: {error}", db.display()))?;
    conn.busy_timeout(BUSY_TIMEOUT)
        .map_err(|error| error.to_string())?;
    conn.execute_batch("PRAGMA synchronous=FULL")
        .map_err(|error| error.to_string())?;
    Ok(conn)
}

/// The SHA-256 of a snapshot's body, after its header.
fn body_digest(bytes: &[u8]) -> Option<String> {
    let length = u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
    let body = bytes.get(4usize.checked_add(length)?..)?;
    Some(snapshot::sha256_hex(body))
}

fn same_rows(a: &SessionRef, b: &SessionRef) -> bool {
    a.harness == b.harness && a.session == b.session
}

fn label(session: &SessionRef) -> String {
    format!("{}/{}/{}", session.runner, session.harness, session.session)
}

fn no_store() -> ErrorBody {
    unavailable("ck-mc has no context.db here, so it holds no session rows to move.")
}

fn unavailable(message: impl Into<String>) -> ErrorBody {
    ErrorBody::new(RefusalCode::Unavailable, message)
}
