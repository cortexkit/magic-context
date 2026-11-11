//! The receiver side of a move: `diverged`, `import`, `activate`, and
//! `abort` before `activate`.
//!
//! A session's copy on this machine is the `context.db` rows the move
//! selects for it ([`snapshot`]), and its baseline is the digest of the
//! snapshot body it last exported or installed here. The copy is at the cut
//! when it holds no rows, or when its rows still encode to that baseline.
//! Rows outside the session's selection that hold a key the install would
//! write (another harness's summaries under the same session id, a
//! publication id already here) count as local rows no baseline covers:
//! the install never touches them, so a move must not go ahead over them.
//!
//! `import` reads the cut through Engram's session door, checks it, and
//! stages it in a private file; nothing of it is live until `activate`.
//! `activate` then takes these steps, each for every ref before the next
//! step starts:
//!
//! 1. Check each staged snapshot against the digest `import` recorded.
//! 2. Check divergence again, and refuse `local_advanced` touching nothing
//!    when a copy here changed since.
//! 3. Write an undo image of each session that has rows here.
//! 4. Record every ref as being installed, in one journal write. From here
//!    on the install is finished, never undone.
//! 5. Install each snapshot with the offline mover's write plan.
//! 6. Per ref, once every install is done: drop what this process keeps for
//!    the session, clear what `mode3.db` holds for it, and make the facts
//!    the cut holds reserved in its own publications `retryable`.
//! 7. Record every ref activated with its new baseline, and the receipt, in
//!    one journal write.
//! 8. Delete the cut's files. The gate lifts with step 7.
//!
//! A ref recorded as being installed resumes at step 5, on a repeat of
//! `activate` or at startup ([`super::Service::recover`]), and its install
//! goes on from its cursor. No receipt exists before step 7, so a repeat
//! after a failure finishes the remaining work instead of replaying success.
//!
//! Reads and writes of `context.db` run on a blocking thread over a
//! connection of their own, as on the source.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use cortexkit_role_agent_data::diverged::{DivergedEntry, DivergedReply, DivergedState};
use cortexkit_role_agent_data::errors::{
    digest_mismatch_reason, Detail, DigestMismatchDetail, ErrorBody, IncompatibleVersionDetail,
    InvalidStateDetail, ParticipantFailedDetail, RefusalCode,
};
use cortexkit_role_agent_data::import::{ImportReply, ImportedItem};
use cortexkit_role_agent_data::refs::{Ref, Refs};
use cortexkit_role_agent_data::step::Step;
use cortexkit_role_agent_data::{EmptyReply, Op};
use cortexkit_role_compaction::read::SessionRef;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

use super::door::{self, CutAnswer, DoorError};
use super::journal::{Contents, Cut, Moving, MovingState, Prepared};
use super::service::{canonical, journal_unreadable, After, Done, Host};
use super::snapshot::{self, Local, Snapshot};
use super::source::{
    blocking, busy_refusal, cut_folder, label, no_store, session_ref, unavailable,
};
use super::{install, moved, resolve};
use crate::context_db::SCHEMA_VERSION;

/// The refusal reason for a session whose project `context.db` still
/// guards against writes.
pub const PROJECT_WRITES_GUARDED: &str = "project_writes_guarded";

/// The undo image's format name.
pub const UNDO_FORMAT: &str = "mc-agent-data-undo/1";

/// The snapshot `import` staged for one session of a cut.
pub fn staged_file(context_db: &Path, cut: &str, session_ref: &str) -> PathBuf {
    cut_folder(context_db, cut).join(format!("{session_ref}.staged"))
}

/// The undo image `activate` wrote for one session of a cut.
pub fn undo_file(context_db: &Path, cut: &str, session_ref: &str) -> PathBuf {
    cut_folder(context_db, cut).join(format!("{session_ref}.undo"))
}

/// One ref's incoming snapshot, read through the door and checked.
struct Incoming {
    session: SessionRef,
    session_ref: String,
    /// Where the snapshot starts and the cut ends the session's stream, and
    /// the digest the cut recorded for the stream up to that end.
    start: u64,
    end: u64,
    digest: String,
    bytes: Vec<u8>,
    snapshot: Snapshot,
}

/// `diverged {refs, cutId}`: per ref, in request order, whether this
/// machine's copy is at the cut. A read: it records nothing.
pub(crate) async fn diverged<H: Host>(
    host: &H,
    cut: &str,
    refs: &Refs,
) -> Result<Vec<u8>, ErrorBody> {
    let db = host.context_db().ok_or_else(no_store)?;
    let contents = host.journal().contents().ok_or_else(journal_unreadable)?;
    let mut entries = Vec::with_capacity(refs.len());
    for r in refs.iter() {
        let incoming = read(host, &db, Op::Diverged, cut, r).await?;
        let baseline = baseline(&contents, &incoming.session);
        let snapshot = incoming.snapshot;
        let state = match blocking(&db, move |conn| snapshot::local(conn, &snapshot)).await {
            Ok(local) => verdict(&local, baseline.as_deref()),
            Err(error) => {
                tracing::warn!(
                    cut = %cut,
                    "ck-mc: agent-data cut {cut}: the rows of session {} here cannot be read ({}); diverged answers unknown",
                    label(&incoming.session),
                    error.message
                );
                DivergedState::Unknown
            }
        };
        entries.push(DivergedEntry::new(state));
    }
    Ok(canonical(&DivergedReply::new(entries)))
}

/// Whether a copy here is at the cut. Rows another session holds under a
/// key the install would write are never covered by a baseline; a copy
/// with rows and no baseline was never moved, so it is this machine's own.
pub(crate) fn verdict(local: &Local, baseline: Option<&str>) -> DivergedState {
    if local.colliding > 0 {
        DivergedState::Advanced
    } else if local.fingerprint.rows == 0 || baseline == Some(local.fingerprint.digest.as_str()) {
        DivergedState::AtCut
    } else {
        DivergedState::Advanced
    }
}

/// The baseline the journal records for the session.
fn baseline(contents: &Contents, session: &SessionRef) -> Option<String> {
    contents
        .session(&session.runner, &session.harness, &session.session)
        .and_then(|entry| entry.baseline.clone())
}

/// `import {refs, cutId}`: read each ref's snapshot through the door, check
/// it, and stage it in a private file. The reply's journal write records
/// every ref staged, which gates the session until `activate` or `abort`.
pub(crate) async fn import<H: Host>(host: &H, cut: &str, refs: &Refs) -> Result<Done, ErrorBody> {
    let db = host.context_db().ok_or_else(no_store)?;
    let result = stage_each(host, &db, cut, refs).await;
    if result.is_err() {
        // Nothing is recorded for a refused import, so its files are
        // nobody's: a later import of the cut writes them afresh.
        let _ = std::fs::remove_dir_all(cut_folder(&db, cut));
    }
    let staged = result?;
    let items = staged
        .iter()
        .map(|(one, dropped)| {
            let item = ImportedItem::new(&one.session_ref, one.end, &one.digest);
            if dropped.is_empty() {
                Ok(item)
            } else {
                item.with_dropped(dropped.clone()).map_err(|rule| {
                    unavailable(format!(
                        "the rows session {} left behind cannot be reported ({rule})",
                        label(&SessionRef::new(&one.runner, &one.harness, &one.session))
                    ))
                })
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    let reply = canonical(&ImportReply::new(items));
    for (one, _) in &staged {
        tracing::info!(
            cut = %cut,
            "ck-mc: session {}/{}/{} is staged by agent-data cut {cut} and refused session_moving until the move is activated or aborted",
            one.runner,
            one.harness,
            one.session
        );
    }
    let cut = cut.to_owned();
    Ok(Done {
        reply,
        edit: Box::new(move |contents| {
            let mut imported = Vec::with_capacity(staged.len());
            let mut digests = BTreeMap::new();
            for (one, _) in staged {
                contents
                    .session_mut(&one.runner, &one.harness, &one.session)
                    .moving = Some(Moving {
                    cut: cut.clone(),
                    state: MovingState::Staged,
                });
                digests.insert(one.session_ref.clone(), one.digest_of_file.clone());
                imported.push(one.prepared);
            }
            if let Some(record) = contents.cuts.get_mut(&cut) {
                record.imported = imported;
                record.snapshots = digests;
            }
        }),
        after: Vec::new(),
    })
}

/// A ref `import` staged: what the journal records for it, and the digest
/// of its staging file.
struct Staged {
    prepared: Prepared,
    digest_of_file: String,
}

impl std::ops::Deref for Staged {
    type Target = Prepared;
    fn deref(&self) -> &Prepared {
        &self.prepared
    }
}

/// Resolve and check every ref, then read, check and stage each one's
/// snapshot. Returns each staged ref with the rows its source left out.
async fn stage_each<H: Host>(
    host: &H,
    db: &Path,
    cut: &str,
    refs: &Refs,
) -> Result<Vec<(Staged, BTreeMap<String, u64>)>, ErrorBody> {
    let mut sessions = Vec::with_capacity(refs.len());
    for r in refs.iter() {
        sessions.push(lookup(host, r).await?);
    }
    for (index, session) in sessions.iter().enumerate() {
        if let Some(earlier) = sessions[..index].iter().position(|earlier| {
            earlier.harness == session.harness && earlier.session == session.session
        }) {
            let (first, second) = (&refs.as_slice()[earlier], &refs.as_slice()[index]);
            return Err(invalid_state(
                Step::None,
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
            held_elsewhere(&contents, cut, r, session)?;
            if host.active(session) && !released(&contents, session) {
                return Err(busy_refusal(
                    r,
                    cortexkit_role_agent_data::busy::reason_codes::RUN_ACTIVE,
                    "The session runs on this machine; it can be replaced only while it does not.",
                ));
            }
        }
    }
    let mut staged = Vec::with_capacity(refs.len());
    for r in refs.iter() {
        let incoming = read(host, db, Op::Import, cut, r).await?;
        let contents = host.journal().contents().ok_or_else(journal_unreadable)?;
        let baseline = baseline(&contents, &incoming.session);
        check_local(db, r, &incoming, baseline, Op::Import).await?;
        let file = staged_file(db, cut, &incoming.session_ref);
        crate::private_permissions::write_file_atomic(&file, &incoming.bytes).map_err(|error| {
            unavailable(format!(
                "the snapshot of {} could not be staged in {} ({error})",
                label(&incoming.session),
                file.display()
            ))
        })?;
        let dropped = incoming.snapshot.header.dropped.clone();
        staged.push((
            Staged {
                digest_of_file: snapshot::sha256_hex(&incoming.bytes),
                prepared: Prepared {
                    ref_kind: r.ref_kind.clone(),
                    reference: r.r#ref.clone(),
                    runner: incoming.session.runner.clone(),
                    harness: incoming.session.harness.clone(),
                    session: incoming.session.session.clone(),
                    session_ref: incoming.session_ref,
                    start: incoming.start,
                    end: incoming.end,
                    digest: incoming.digest,
                    body: incoming.snapshot.header.body_sha256,
                },
            },
            dropped,
        ));
    }
    Ok(staged)
}

/// The checks `import` and `activate` make against this machine's rows
/// before anything of the session changes: no project guard refuses the
/// install's writes, the copy here is at the cut, and this store can hold
/// every row.
async fn check_local(
    db: &Path,
    r: &Ref,
    incoming: &Incoming,
    baseline: Option<String>,
    op: Op,
) -> Result<Local, ErrorBody> {
    let snapshot = incoming.snapshot.clone();
    let (guarded, local, fits) = blocking(db, move |conn| {
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let guarded = guarded_project(&tx, &snapshot)?;
        let local = snapshot::local_on(&tx, &snapshot)?;
        let fits = install::check_store(&tx, &snapshot);
        tx.finish().map_err(|error| error.to_string())?;
        Ok((guarded, local, fits))
    })
    .await?;
    if let Some(project) = guarded {
        tracing::warn!(
            "ck-mc: session {} cannot be installed: context.db still guards project {project} against writes (authority_managed or authority_repair_pending) from the removed Rust transform mode",
            label(&incoming.session)
        );
        let message = format!(
            "context.db still has write guards from the removed Rust transform mode for project {project} (authority_managed or authority_repair_pending), and they refuse the install's note writes; session {} cannot be installed here until they are removed",
            label(&incoming.session)
        );
        return Err(if op == Op::Activate {
            // An older driver reads participant_failed on activate as an
            // unknown code and aborts instead of holding the cut; see the
            // source's door refusals.
            invalid_state(Step::Imported, message)
        } else {
            ErrorBody::with_participant_failed_detail(
                ParticipantFailedDetail::new(PROJECT_WRITES_GUARDED),
                message,
            )
        });
    }
    if verdict(&local, baseline.as_deref()) != DivergedState::AtCut {
        return Err(ErrorBody::new(
            RefusalCode::LocalAdvanced,
            format!(
                "{}/{}: session {} gained rows here that the cut does not hold ({} rows in its selection, {} other rows under keys the install would write); they are left untouched",
                r.ref_kind,
                r.r#ref,
                label(&incoming.session),
                local.fingerprint.rows,
                local.colliding
            ),
        ));
    }
    if let Err(why) = fits {
        return Err(incompatible(
            &incoming.snapshot,
            format!(
                "the snapshot of session {} cannot be installed in this context.db: {why}",
                label(&incoming.session)
            ),
        ));
    }
    Ok(local)
}

/// The first project, among those the install's note writes concern, that
/// `context.db` still guards against writes: the snapshot's project link,
/// its notes' projects, and this store's own links and notes of the
/// session. The guards are triggers on `notes` and `memories` that the
/// removed Rust transform mode left for projects it managed, and they abort
/// a note write for such a project unless a switch nothing sets is on.
fn guarded_project(conn: &Connection, incoming: &Snapshot) -> Result<Option<String>, String> {
    let header = &incoming.header;
    let mut projects: BTreeSet<String> = header.project.iter().cloned().collect();
    projects.extend(
        incoming
            .rows
            .table("notes")
            .iter()
            .filter_map(|row| row.get("project_path").and_then(Value::as_str))
            .map(str::to_owned),
    );
    let mut here = conn
        .prepare(
            "SELECT project_path FROM session_projects WHERE session_id = ?1
             UNION SELECT project_path FROM notes WHERE session_id = ?1 AND harness = ?2",
        )
        .map_err(|error| error.to_string())?;
    let local: Vec<Option<String>> = here
        .query_map(params![header.session, header.harness], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|error| error.to_string())?;
    projects.extend(local.into_iter().flatten());
    let mut guarded = conn
        .prepare(
            "SELECT EXISTS (SELECT 1 FROM authority_managed WHERE project_path = ?1)
                 OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = ?1)",
        )
        .map_err(|error| error.to_string())?;
    for project in projects {
        let held: bool = guarded
            .query_row(params![project], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if held {
            return Ok(Some(project));
        }
    }
    Ok(None)
}

/// Resolve a ref on the receiver by Entorhinal's binding, whatever this
/// machine holds of the session. A ref Entorhinal does not resolve here is
/// answered `unavailable`: the receiver accepts refs it holds nothing of,
/// so only Entorhinal's own binding can be missing, and it may be there on
/// the next attempt.
async fn lookup<H: Host>(host: &H, r: &Ref) -> Result<SessionRef, ErrorBody> {
    resolve::lookup(host, r).await.map_err(|refusal| {
        if refusal.code == RefusalCode::UnknownRef {
            unavailable(refusal.message)
        } else {
            refusal
        }
    })
}

/// Read one ref's snapshot of the cut through the door, and check that this
/// build can install it: the snapshot decodes and checks against the moved
/// list, names the ref's session, and was read at the schema version both
/// this build and this machine's `context.db` are at.
async fn read<H: Host>(
    host: &H,
    db: &Path,
    op: Op,
    cut: &str,
    r: &Ref,
) -> Result<Incoming, ErrorBody> {
    let session = lookup(host, r).await?;
    let session_ref = session_ref(&session);
    let stream = door::read_cut(host, &session_ref, cut)
        .await
        .map_err(|error| cut_refusal(op, &error))?;
    let start = snapshot::last_in_stream(&stream.bytes).map_err(|why| {
        ErrorBody::with_typed_detail(
            Detail::IncompatibleVersion(IncompatibleVersionDetail::new(
                "unreadable",
                required(SCHEMA_VERSION.into()),
            )),
            format!(
                "Cut {cut} holds no snapshot of session {session_ref} this build can read: {why}."
            ),
        )
    })?;
    let bytes = stream.bytes[start..].to_vec();
    let snapshot = snapshot::decode(&bytes).map_err(|why| {
        ErrorBody::with_typed_detail(
            Detail::IncompatibleVersion(IncompatibleVersionDetail::new(
                found_format(&bytes),
                required(SCHEMA_VERSION.into()),
            )),
            format!("The snapshot of session {session_ref} in cut {cut} cannot be installed by this build: {why}."),
        )
    })?;
    let header = &snapshot.header;
    if (
        header.runner.as_str(),
        header.harness.as_str(),
        header.session.as_str(),
    ) != (
        session.runner.as_str(),
        session.harness.as_str(),
        session.session.as_str(),
    ) {
        return Err(incompatible(
            &snapshot,
            format!(
                "the snapshot in cut {cut} is of session {}/{}/{}, and {}/{} names session {}",
                header.runner,
                header.harness,
                header.session,
                r.ref_kind,
                r.r#ref,
                label(&session)
            ),
        ));
    }
    let live = blocking(db, |conn| {
        crate::context_db::live_schema_version(conn).map_err(|error| error.to_string())
    })
    .await?;
    for (version, whose) in [
        (i64::from(SCHEMA_VERSION), "this ck-mc"),
        (live, "context.db here"),
    ] {
        if header.schema_version != version {
            return Err(ErrorBody::with_typed_detail(
                Detail::IncompatibleVersion(IncompatibleVersionDetail::new(
                    required(header.schema_version),
                    required(version),
                )),
                format!(
                    "The snapshot of session {} was read at context.db schema version {}, and {whose} is at version {version}; both machines must run the same schema version.",
                    label(&session),
                    header.schema_version
                ),
            ));
        }
    }
    let start = stream.floor + start as u64;
    Ok(Incoming {
        session,
        session_ref,
        start,
        end: stream.end,
        digest: stream.digest,
        bytes,
        snapshot,
    })
}

/// The snapshot format and schema version this build installs, or a
/// snapshot carries, as `incompatible_version` names them.
fn required(version: i64) -> String {
    format!("{}+context.db/{version}", snapshot::FORMAT)
}

/// What a snapshot that does not decode says it is, as far as it says.
fn found_format(bytes: &[u8]) -> String {
    let header = bytes.get(..4).and_then(|length| {
        let length = u32::from_be_bytes(length.try_into().ok()?) as usize;
        serde_json::from_slice::<Value>(bytes.get(4..4usize.checked_add(length)?)?).ok()
    });
    match header {
        Some(header) => format!(
            "{}+context.db/{}",
            header["format"].as_str().unwrap_or("unknown"),
            header["schemaVersion"]
        ),
        None => "unreadable".to_owned(),
    }
}

/// `incompatible_version` for a snapshot that decodes but cannot be
/// installed here.
fn incompatible(snapshot: &Snapshot, message: String) -> ErrorBody {
    ErrorBody::with_typed_detail(
        Detail::IncompatibleVersion(IncompatibleVersionDetail::new(
            required(snapshot.header.schema_version),
            required(SCHEMA_VERSION.into()),
        )),
        format!("{message}."),
    )
}

fn invalid_state(step: Step, message: String) -> ErrorBody {
    ErrorBody::with_typed_detail(Detail::InvalidState(InvalidStateDetail::new(step)), message)
}

/// What `op` answers for a failed read of the cut, by the door's table.
/// `diverged` may answer only `cut_not_ready`, `incompatible_version` and
/// `unavailable`, so every other answer is `unavailable` there.
fn cut_refusal(op: Op, error: &DoorError) -> ErrorBody {
    let said = error.message.trim_end_matches('.');
    match door::cut_answer(&error.code) {
        CutAnswer::NotReady => ErrorBody::new(
            RefusalCode::CutNotReady,
            format!("{said}. The cut is not readable through the door yet."),
        ),
        CutAnswer::Mismatch if op == Op::Import => ErrorBody::new(
            RefusalCode::DigestMismatch,
            format!("{said}. The cut's bytes do not check out; import it again only once the cut is sealed anew."),
        ),
        CutAnswer::Fault(fix) if op == Op::Import => ErrorBody::with_participant_failed_detail(
            ParticipantFailedDetail::new(format!("session_door:{} at none", error.code)),
            format!("{said}. Fix this on this machine before the session can move here: {fix}."),
        ),
        CutAnswer::Fault(fix) => unavailable(format!("{said}. {fix}.")),
        CutAnswer::Mismatch | CutAnswer::Unavailable => unavailable(error.message.clone()),
    }
}

/// Refuse a ref whose session another move holds here.
fn held_elsewhere(
    contents: &Contents,
    cut: &str,
    r: &Ref,
    session: &SessionRef,
) -> Result<(), ErrorBody> {
    for entry in contents
        .sessions
        .iter()
        .filter(|entry| entry.harness == session.harness && entry.session == session.session)
    {
        if let Some(moving) = entry.moving.as_ref().filter(|moving| moving.cut != cut) {
            return Err(invalid_state(
                Step::None,
                format!(
                    "{}/{} names session {}/{}, which agent-data cut {} holds {}; a session is in one move at a time.",
                    r.ref_kind,
                    r.r#ref,
                    session.harness,
                    session.session,
                    moving.cut,
                    moving.state.describe()
                ),
            ));
        }
    }
    Ok(())
}

/// Whether the session was released from here to another machine.
fn released(contents: &Contents, session: &SessionRef) -> bool {
    contents
        .session(&session.runner, &session.harness, &session.session)
        .is_some_and(|entry| entry.released.is_some())
}

/// `activate {refs, cutId}`: install every staged snapshot (steps 1-8 of
/// the module doc). `request` is the digest of the request, which step 4
/// records as the activation in progress.
pub(crate) async fn activate<H: Host>(
    host: &H,
    cut: &str,
    record: &Cut,
    request: String,
) -> Result<Done, ErrorBody> {
    let db = host.context_db().ok_or_else(no_store)?;
    let contents = host.journal().contents().ok_or_else(journal_unreadable)?;
    let mut staged = Vec::new();
    for one in &record.imported {
        match contents
            .session(&one.runner, &one.harness, &one.session)
            .and_then(|entry| entry.moving.as_ref())
        {
            Some(moving) if moving.cut == cut && moving.state == MovingState::Staged => {
                staged.push(one)
            }
            Some(moving) if moving.cut == cut && moving.state == MovingState::Activating => {}
            _ => {
                return Err(unavailable(format!(
                    "session {} is not staged by cut {cut} as its import left it; the journal was changed by hand",
                    label(&key(one))
                )))
            }
        }
    }
    if !staged.is_empty() {
        prepare_install(host, &db, cut, record, &staged, &contents, request).await?;
    }
    // 5. Every install, before any session's step 6.
    for one in &record.imported {
        install_one(&db, cut, record, one).await?;
    }
    // 6. Per ref: what this process and mode3.db keep for the session, and
    // the facts the cut holds reserved in its own publications.
    for one in &record.imported {
        release_one(host, &db, cut, one).await?;
    }
    let imported = record.imported.clone();
    let mut after = vec![After::Remove(cut_folder(&db, cut))];
    after.extend(
        imported
            .iter()
            .map(|one| After::Activated(key(one), cut.to_owned())),
    );
    let cut = cut.to_owned();
    Ok(Done {
        edit: Box::new(move |contents| {
            // 7. Every ref activated, with the installed snapshot's body as
            // its baseline, which the installed rows encode to.
            for one in imported {
                let entry = contents.session_mut(&one.runner, &one.harness, &one.session);
                entry.moving = None;
                entry.released = None;
                entry.baseline = Some(one.body);
            }
            if let Some(record) = contents.cuts.get_mut(&cut) {
                record.activate_request = None;
            }
        }),
        // 8. The staged snapshots and undo images; the gate lifts with the
        // journal write.
        after,
        ..Done::reply(&EmptyReply::new())
    })
}

/// Steps 1 to 4 for the refs still staged.
async fn prepare_install<H: Host>(
    host: &H,
    db: &Path,
    cut: &str,
    record: &Cut,
    staged: &[&Prepared],
    contents: &Contents,
    request: String,
) -> Result<(), ErrorBody> {
    // 1. The staged bytes, against the digest import recorded.
    let mut snapshots = Vec::with_capacity(staged.len());
    for one in staged {
        snapshots.push(staged_snapshot(db, cut, record, one)?);
    }
    // 2. Divergence again, with every ref checked before any is touched.
    let mut locals = Vec::with_capacity(staged.len());
    for (one, (bytes, snapshot)) in staged.iter().zip(&snapshots) {
        let session = key(one);
        let r = Ref::new(&one.ref_kind, &one.reference);
        if host.historian_running(&session) {
            return Err(busy_refusal(
                &r,
                cortexkit_role_agent_data::busy::reason_codes::HISTORIAN_RUNNING,
                "A summarizer run or its second turn is in flight for this session.",
            ));
        }
        let incoming = Incoming {
            session_ref: one.session_ref.clone(),
            start: one.start,
            end: one.end,
            digest: one.digest.clone(),
            bytes: bytes.clone(),
            snapshot: snapshot.clone(),
            session,
        };
        let baseline = baseline(contents, &incoming.session);
        locals.push(check_local(db, &r, &incoming, baseline, Op::Activate).await?);
    }
    // 3. An undo image of each session with rows here, in either store.
    let mut images = BTreeMap::new();
    for (one, local) in staged.iter().zip(&locals) {
        let session = key(one);
        let state = host.state_rows(&session).map_err(|error| {
            unavailable(format!(
                "the mode3.db rows of session {} cannot be read for its undo image ({error}); send activate again",
                label(&session)
            ))
        })?;
        let has_state = state.as_object().is_some_and(|tables| !tables.is_empty());
        if local.fingerprint.rows == 0 && !has_state {
            continue;
        }
        let owner = session.clone();
        let rows = blocking(db, move |conn| snapshot::read(conn, &owner)).await?;
        let image = canonical(&json!({
            "format": UNDO_FORMAT,
            "cut": cut,
            "runner": session.runner,
            "harness": session.harness,
            "session": session.session,
            "context": door::hex(&rows.bytes),
            "mode3": state,
            "journal": contents.session(&session.runner, &session.harness, &session.session),
        }));
        let file = undo_file(db, cut, &one.session_ref);
        crate::private_permissions::write_file_atomic(&file, &image).map_err(|error| {
            unavailable(format!(
                "the undo image of session {} could not be written to {} ({error}); send activate again",
                label(&session),
                file.display()
            ))
        })?;
        images.insert(one.session_ref.clone(), snapshot::sha256_hex(&image));
    }
    // 4. One journal write: every ref is being installed. From here on the
    // install is finished, never undone.
    let sessions: Vec<SessionRef> = staged.iter().map(|one| key(one)).collect();
    host.journal()
        .change(|contents| {
            for session in &sessions {
                contents
                    .session_mut(&session.runner, &session.harness, &session.session)
                    .moving = Some(Moving {
                    cut: cut.to_owned(),
                    state: MovingState::Activating,
                });
            }
            if let Some(record) = contents.cuts.get_mut(cut) {
                record.undo_images.extend(images);
                record.activate_request = Some(request);
            }
        })
        .map_err(|error| {
            unavailable(format!(
                "the start of cut {cut}'s install could not be recorded ({error}); nothing was installed, send activate again"
            ))
        })?;
    for session in &sessions {
        tracing::info!(
            cut = %cut,
            "ck-mc: session {} is being installed by agent-data cut {cut}; it stays refused session_moving until the install is finished, by a repeat of activate or at the next start",
            label(session)
        );
    }
    Ok(())
}

/// A staged snapshot, checked against the digest `import` recorded for it.
fn staged_snapshot(
    db: &Path,
    cut: &str,
    record: &Cut,
    one: &Prepared,
) -> Result<(Vec<u8>, Snapshot), ErrorBody> {
    let file = staged_file(db, cut, &one.session_ref);
    let mismatch = |why: String| {
        ErrorBody::with_digest_mismatch_detail(
            DigestMismatchDetail::new(digest_mismatch_reason::STAGING_DIGEST_MISMATCH),
            format!(
                "The snapshot staged for session {} at {} {why}; it is not the one import checked, so it is not installed.",
                label(&key(one)),
                file.display()
            ),
        )
    };
    let bytes =
        std::fs::read(&file).map_err(|error| mismatch(format!("cannot be read ({error})")))?;
    if record.snapshots.get(&one.session_ref) != Some(&snapshot::sha256_hex(&bytes)) {
        return Err(mismatch("does not match its recorded digest".to_owned()));
    }
    let snapshot =
        snapshot::decode(&bytes).map_err(|why| mismatch(format!("no longer decodes ({why})")))?;
    Ok((bytes, snapshot))
}

/// Step 5 for one ref: apply what is left of its install's plan, or, when
/// no plan is staged or its staging was cut short, build the plan from the
/// staged snapshot and apply it. A plan already done passes straight
/// through, so its own rows are never judged as changes here.
async fn install_one(db: &Path, cut: &str, record: &Cut, one: &Prepared) -> Result<(), ErrorBody> {
    let key = install::key(cut, &one.harness, &one.session);
    let resumed = {
        let key = key.clone();
        blocking(db, move |conn| install::resume(conn, &key)).await?
    };
    if !resumed {
        let (_, snapshot) = staged_snapshot(db, cut, record, one)?;
        let cut = cut.to_owned();
        blocking(db, move |conn| install::stage(conn, &snapshot, &cut)).await?;
    }
    let done = blocking(db, move |conn| install::done(conn, &key)).await?;
    if !done {
        return Err(unavailable(format!(
            "the install of session {} for cut {cut} did not finish; send activate again",
            label(&self::key(one))
        )));
    }
    Ok(())
}

/// Step 6 for one ref. Each part is safe to repeat: the session is still
/// gated, so nothing has written its `mode3.db` rows since, and the facts
/// a second turn of another session took after an earlier pass are under
/// that turn's key, not the cut's.
async fn release_one<H: Host>(
    host: &H,
    db: &Path,
    cut: &str,
    one: &Prepared,
) -> Result<(), ErrorBody> {
    let session = key(one);
    // First, so no worker of the session writes mode3.db after it is
    // cleared. Context reads prefer a cached project to the installed
    // project link, so a stale one would serve the old project.
    host.reset(&session, cut);
    host.clear_state(&session).map_err(|error| {
        unavailable(format!(
            "mode3.db could not clear the rows of session {} ({error}); its install is done, send activate again to finish the move",
            label(&session)
        ))
    })?;
    let owner = session.clone();
    let reservation = moved::reservation(cut);
    let released = blocking(db, move |conn| {
        conn.execute(
            &format!(
                "UPDATE memory_pending_facts SET state = 'retryable', reserved_stage_key = NULL
                 WHERE state = 'in_flight' AND reserved_stage_key = ?3 AND publication_id IN ({})",
                moved::publications()
            ),
            params![owner.session, owner.harness, reservation],
        )
        .map_err(|error| error.to_string())
    })
    .await?;
    tracing::info!(
        cut = %cut,
        "ck-mc: session {} is installed by agent-data cut {cut}: its mode3.db rows are cleared and {released} waiting facts are retryable; it is served once the cut is recorded activated",
        label(&session)
    );
    Ok(())
}

/// `abort {refs, cutId}` for a cut `import` staged here. Before `activate`
/// records the install, the staged files are deleted and the staged gate is
/// lifted; the cut's record, any tombstone and the baseline stay, so a
/// session released from here before is still refused `session_moved`
/// with the holder it had. Once the install is recorded it is finished,
/// never undone, so the abort is refused.
pub(crate) async fn abort<H: Host>(host: &H, cut: &str, record: &Cut) -> Result<Done, ErrorBody> {
    let db = host.context_db();
    let contents = host.journal().contents().ok_or_else(journal_unreadable)?;
    let mut staged = Vec::new();
    for one in &record.imported {
        let session = key(one);
        match contents
            .session(&session.runner, &session.harness, &session.session)
            .and_then(|entry| entry.moving.as_ref())
        {
            Some(moving) if moving.cut == cut && moving.state == MovingState::Activating => {
                return Err(invalid_state(
                    Step::Imported,
                    format!(
                        "Session {} is being installed by cut {cut}; an install once started is finished, never undone, so send activate again.",
                        label(&session)
                    ),
                ))
            }
            Some(moving) if moving.cut == cut => staged.push(session),
            _ => {}
        }
    }
    let mut after = Vec::new();
    if let Some(db) = &db {
        after.push(After::Remove(cut_folder(db, cut)));
    }
    for session in &staged {
        tracing::info!(
            cut = %cut,
            "ck-mc: agent-data cut {cut} was aborted before its install; its staged snapshot of session {} is deleted and the session's rows here are as they were",
            label(session)
        );
        after.push(After::Resume(session.clone()));
    }
    let cut = cut.to_owned();
    Ok(Done {
        edit: Box::new(move |contents| {
            contents.sessions.retain_mut(|entry| {
                let lifted = staged.iter().any(|session| {
                    entry.runner == session.runner
                        && entry.harness == session.harness
                        && entry.session == session.session
                }) && entry
                    .moving
                    .as_ref()
                    .is_some_and(|moving| moving.cut == cut && moving.state == MovingState::Staged);
                if lifted {
                    entry.moving = None;
                    return entry.released.is_some() || entry.baseline.is_some();
                }
                true
            });
        }),
        after,
        ..Done::reply(&EmptyReply::new())
    })
}

fn key(one: &Prepared) -> SessionRef {
    SessionRef::new(&one.runner, &one.harness, &one.session)
}
