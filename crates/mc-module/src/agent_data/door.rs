//! The calls to Engram's session door: on the source `session.offsets`,
//! `session.cover`, `session.admit`, `session.digest` and `session.read`, and
//! on the receiver `session.read` bound to a sealed cut ([`read_cut`]).
//!
//! The door keeps one append-only stream per caller and session. It names
//! the stream after the route's attested caller (`reserved:<module id>`)
//! and the session by its llm-runner `sessionRef`, so no request carries a
//! stream of its own. Each move of a session appends its snapshot to the
//! session's stream, and a cut is the stream's length and the SHA-256 of
//! every byte up to it, earlier moves' snapshots included.
//!
//! Bytes travel as lowercase hex, at most one MiB of raw bytes per call.
//! Replies are read tolerantly: a member this build does not know is
//! ignored, so a newer door never fails a move by saying more.
//!
//! Every refusal is answered by [`answer`], one table keyed by op and door
//! code, which follows Engram's contract: a refusal it says to retry is
//! answered `unavailable`, so the driver sends the same request again; one
//! it says to stop on is answered with a code the driver aborts on.

use std::time::Duration;

use cortexkit_role_agent_data::Op;
use serde::Deserialize;
use serde_json::{json, Value};

use super::midstate::{Midstate, Resumed};
use super::service::Host;
use crate::client::DoorRefusal;

/// The most raw bytes one `session.admit` or `session.read` carries: the
/// door refuses more with `record_too_large`.
pub const PAGE: usize = 1024 * 1024;

/// How long one door call may take, but `session.cover`.
pub const DEADLINE: Duration = Duration::from_secs(30);

/// How long `session.cover` may take: it uploads what the cloud lacks of
/// the stream before it answers, which can take minutes.
pub const COVER_DEADLINE: Duration = Duration::from_secs(10 * 60);

/// How often reading the stream back starts again from a floor a trim
/// moved meanwhile, before the digest gives up.
const FLOOR_RETRIES: usize = 3;

/// A door step that failed: the door's refusal code, or for a check of this
/// module's own, a name for it, and the text for the refusal and the log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DoorError {
    pub code: String,
    pub message: String,
}

impl DoorError {
    fn refused(method: &str, refusal: &DoorRefusal) -> Self {
        Self {
            code: refusal.code.clone(),
            message: format!(
                "Engram's session door refused {method}: {} ({})",
                refusal.code, refusal.message
            ),
        }
    }

    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }

    /// A failure that sending the same request again may clear, such as an
    /// answer that did not decode.
    fn retry(message: impl Into<String>) -> Self {
        Self::new("unavailable", message)
    }
}

/// What an agent-data op answers for a failed door step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    /// `unavailable`: the same request may succeed later.
    Unavailable,
    /// `unknown_ref`: this machine no longer writes the session's stream;
    /// another device holds it or received it.
    UnknownRef,
    /// `invalid_state` at the cut's step: another cut of the session's
    /// container waits for its handoff.
    Handoff,
    /// `participant_failed` for a fault on this machine that
    /// retrying cannot clear: ck-mc's own request, its binding to the door,
    /// or a stream that does not check out. Unlike `invalid_state`, this
    /// does not blame the caller's op order; unlike `unavailable`, it stops
    /// the driver from retrying a permanent fault with the session frozen.
    Fault(&'static str),
}

use Answer::{Fault, Handoff, Unavailable, UnknownRef};

/// What the receiver answers for a failed cut-bound read, after Engram's
/// refusal table for `session.read` with a `cutId`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CutAnswer {
    /// `cut_not_ready`: the door cannot serve the cut yet, because its
    /// manifest is not published or not in the cloud yet. The driver
    /// retries within the step.
    NotReady,
    /// `unavailable`: the same request may succeed later.
    Unavailable,
    /// The cut's bytes do not check out against what the cut recorded:
    /// `digest_mismatch` where the op may say so.
    Mismatch,
    /// A fault on this machine that retrying cannot clear.
    Fault(&'static str),
}

/// Per door code, what the receiver answers for a cut-bound read. A code
/// the table does not name is answered `unavailable`, as on the source.
const CUT_ANSWERS: &[(&str, CutAnswer)] = &[
    ("not_found", CutAnswer::NotReady),
    ("cut_not_published", CutAnswer::NotReady),
    ("unavailable", CutAnswer::Unavailable),
    ("lease_unavailable", CutAnswer::Unavailable),
    ("lease_acquiring", CutAnswer::Unavailable),
    // The source's prepare named this session's stream in the cut, so a
    // manifest without it is one the door may still be catching up on.
    ("cut_item_missing", CutAnswer::Unavailable),
    ("verify_failed", CutAnswer::Mismatch),
    ("stream_digest_mismatch", CutAnswer::Mismatch),
    (
        "invalid_request",
        CutAnswer::Fault(
            "ck-mc sent the door a request it does not accept; update ck-mc or Engram",
        ),
    ),
    (
        "caller_forbidden",
        CutAnswer::Fault(
            "the daemon must bind ck-mc to the door unscoped, as its own attested module",
        ),
    ),
    (
        "stream_label_too_long",
        CutAnswer::Fault(
            "ck-mc's module id is too long for a door stream; run it under a shorter id",
        ),
    ),
    (
        "record_too_large",
        CutAnswer::Fault("ck-mc asked the door for more than a page; update ck-mc"),
    ),
    (
        "response_too_large",
        CutAnswer::Fault("the door's answer did not fit its frame; update Engram"),
    ),
    (
        "offset_out_of_range",
        CutAnswer::Fault("the session's stream is shorter than the cut; check it on Engram"),
    ),
    (
        "below_floor",
        CutAnswer::Fault(
            "the session's stream kept being trimmed while the cut was read; stop its trims",
        ),
    ),
    (
        "midstate_malformed",
        CutAnswer::Fault("the door's running hash cannot be read; update ck-mc or Engram"),
    ),
];

/// What the receiver answers for a cut-bound read that failed with `code`.
pub fn cut_answer(code: &str) -> CutAnswer {
    CUT_ANSWERS
        .iter()
        .find(|(known, _)| *known == code)
        .map_or(CutAnswer::Unavailable, |(_, answer)| *answer)
}

/// Per door code, what `prepare` and what `export` answer, after Engram's
/// stream and retention refusal tables: their Retry rows are answered
/// `unavailable` and their Stop rows stop the move. `prepare` calls
/// `session.offsets`, `session.cover`, `session.digest` and `session.read`;
/// `export` calls `session.offsets` and `session.admit`.
const ANSWERS: &[(&str, Answer, Answer)] = &[
    ("unavailable", Unavailable, Unavailable),
    ("lease_acquiring", Unavailable, Unavailable),
    ("lease_unavailable", Unavailable, Unavailable),
    ("container_handed_off", UnknownRef, UnknownRef),
    ("lease_held_elsewhere", UnknownRef, UnknownRef),
    ("lease_not_writable", UnknownRef, UnknownRef),
    ("cut_pending_handoff", Handoff, Handoff),
    (
        "invalid_request",
        Fault("ck-mc sent the door a request it does not accept; update ck-mc or Engram"),
        Fault("ck-mc sent the door a request it does not accept; update ck-mc or Engram"),
    ),
    (
        "caller_forbidden",
        Fault("the daemon must bind ck-mc to the door unscoped, as its own attested module"),
        Fault("the daemon must bind ck-mc to the door unscoped, as its own attested module"),
    ),
    (
        "stream_label_too_long",
        Fault("ck-mc's module id is too long for a door stream; run it under a shorter id"),
        Fault("ck-mc's module id is too long for a door stream; run it under a shorter id"),
    ),
    (
        "record_too_large",
        Fault("ck-mc sent the door more than a page; update ck-mc"),
        Fault("ck-mc sent the door more than a page; update ck-mc"),
    ),
    (
        "response_too_large",
        Fault("the door's answer did not fit its frame; update Engram"),
        Fault("the door's answer did not fit its frame; update Engram"),
    ),
    (
        "offset_mismatch",
        Fault("the door's stream end does not move on; check the session's stream on Engram"),
        Fault("the door's stream end does not move on; check the session's stream on Engram"),
    ),
    (
        "offset_out_of_range",
        Fault("the session's stream is shorter than the door reported; check it on Engram"),
        Fault("the session's stream is shorter than the door reported; check it on Engram"),
    ),
    (
        "below_floor",
        Fault("the session's stream kept being trimmed while it was read; stop its trims"),
        Fault("the session's stream kept being trimmed while it was read; stop its trims"),
    ),
    (
        "digest_unindexed",
        Fault("the door cannot vouch for the session's stream; check it on Engram"),
        Fault("the door cannot vouch for the session's stream; check it on Engram"),
    ),
    // This module's own checks of what the door answered.
    (
        "stream_diverged",
        Fault("the session's stream holds bytes this cut did not write; check it on Engram"),
        Fault("the session's stream holds bytes this cut did not write; check it on Engram"),
    ),
    (
        "midstate_malformed",
        Fault("the door's running hash cannot be read; update ck-mc or Engram"),
        Fault("the door's running hash cannot be read; update ck-mc or Engram"),
    ),
    (
        "stream_digest_mismatch",
        Fault("the session's stream does not match its recorded digest; check it on Engram"),
        Fault("the session's stream does not match its recorded digest; check it on Engram"),
    ),
];

/// What `op` answers for a door failure with `code`. A code the table does
/// not name is answered `unavailable`: Engram's contract surfaces every
/// failure it does not list as one to retry.
pub fn answer(op: Op, code: &str) -> Answer {
    ANSWERS.iter().find(|(known, _, _)| *known == code).map_or(
        Unavailable,
        |(_, prepare, export)| match op {
            Op::Export => *export,
            _ => *prepare,
        },
    )
}

/// How far the door holds a session's stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    /// The end of what the door has recorded durably on this machine.
    pub durable_offset: u64,
    /// The end of what the door has copied to the cloud, where the
    /// receiver reads from.
    pub cloud_offset: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    bytes: String,
    from_offset: u64,
    end_offset: u64,
    #[serde(default)]
    stream_end: Option<u64>,
}

/// `session.digest`: the stream's SHA-256 up to `end`, and the running
/// hash state at its trim floor.
#[derive(Debug, Deserialize)]
struct StreamDigest {
    end: u64,
    digest: String,
    floor: u64,
    midstate: Midstate,
}

/// `session.offsets`: where the stream ends locally and in the cloud, from
/// the door's local store only, so it answers at once even while an upload
/// of the session runs.
pub async fn offsets<H: Host>(host: &H, session_ref: &str) -> Result<Position, DoorError> {
    let answer = call(
        host,
        "session.offsets",
        json!({"sessionRef": session_ref}),
        DEADLINE,
    )
    .await?;
    decode("session.offsets", answer)
}

/// `session.cover`: upload what the cloud lacks of the stream, then report
/// where it ends. Only for a caller that must wait for the cloud: it runs
/// the door's uploader before it answers.
pub async fn cover<H: Host>(host: &H, session_ref: &str) -> Result<Position, DoorError> {
    let answer = call(
        host,
        "session.cover",
        json!({"sessionRef": session_ref}),
        COVER_DEADLINE,
    )
    .await?;
    decode("session.cover", answer)
}

/// Admit `bytes` as the stream's bytes from `start` on, resuming from what
/// the door already holds: a repeat after a lost reply or a crash sends
/// only the pages the door does not have yet. The stream must hold no byte
/// past `start + bytes.len()`, and must reach `start`, so bytes another
/// writer put there are never taken for ours.
pub async fn admit<H: Host>(
    host: &H,
    session_ref: &str,
    start: u64,
    bytes: &[u8],
) -> Result<(), DoorError> {
    let end = start + bytes.len() as u64;
    let mut offset = offsets(host, session_ref).await?.durable_offset;
    loop {
        if offset < start || offset > end {
            return Err(DoorError::new(
                "stream_diverged",
                format!(
                    "the door's stream for session {session_ref} ends at byte {offset}, outside the prepared snapshot's bytes {start}..{end}; abort the move and prepare it again"
                ),
            ));
        }
        if offset == end {
            return Ok(());
        }
        let from = (offset - start) as usize;
        let page = &bytes[from..bytes.len().min(from + PAGE)];
        let answer = host
            .door(
                "session.admit",
                json!({"sessionRef": session_ref, "fromOffset": offset, "bytes": hex(page)}),
                DEADLINE,
            )
            .await;
        match answer {
            Ok(answer) => {
                let admitted = decode::<Position>("session.admit", answer)?.durable_offset;
                if admitted != offset + page.len() as u64 {
                    return Err(DoorError::retry(format!(
                        "the door admitted session {session_ref}'s bytes {offset}..{} but reports its stream ending at {admitted}",
                        offset + page.len() as u64
                    )));
                }
                offset = admitted;
            }
            // The stream already ends elsewhere, for example after a reply
            // lost once the door wrote the page: go on from where the door
            // says it ends.
            Err(refusal) if refusal.code == "offset_mismatch" => {
                let expected = match refusal
                    .detail
                    .as_ref()
                    .and_then(|detail| detail.get("expectedOffset"))
                    .and_then(Value::as_u64)
                {
                    Some(expected) => expected,
                    None => offsets(host, session_ref).await?.durable_offset,
                };
                if expected == offset {
                    return Err(DoorError::refused("session.admit", &refusal));
                }
                offset = expected;
            }
            // The door's answer did not fit its frame, but the page may
            // have been admitted: go on from where the stream ends now.
            Err(refusal) if refusal.code == "response_too_large" => {
                let now = offsets(host, session_ref).await?.durable_offset;
                if now == offset {
                    return Err(DoorError::refused("session.admit", &refusal));
                }
                offset = now;
            }
            Err(refusal) => return Err(DoorError::refused("session.admit", &refusal)),
        }
    }
}

/// The SHA-256 of the session's stream with `snapshot` appended at
/// `start`, the stream's durable end.
///
/// The door keeps the stream's bytes from its trim floor on, and the hash's
/// running state at that floor (`session.digest`). The digest resumes from
/// that state, reads the bytes from the floor up to `start`, checks them
/// against the door's own digest of `[0, start)`, and then hashes the
/// snapshot. Today the floor is 0 and this reads every earlier move's
/// snapshot back; once the stream is trimmed below its newest snapshot after
/// each completed move, the read is one snapshot long. A stream nothing was
/// admitted to yet hashes the snapshot alone.
pub async fn digest<H: Host>(
    host: &H,
    session_ref: &str,
    start: u64,
    snapshot: &[u8],
) -> Result<String, DoorError> {
    if start == 0 {
        let mut hash = Resumed::default();
        hash.update(snapshot);
        return Ok(hash.finish());
    }
    for _ in 0..FLOOR_RETRIES {
        let answer = call(
            host,
            "session.digest",
            json!({"sessionRef": session_ref, "end": start}),
            DEADLINE,
        )
        .await?;
        let state: StreamDigest = decode("session.digest", answer)?;
        if state.end != start || state.floor > start {
            return Err(DoorError::retry(format!(
                "the door answered session {session_ref}'s digest up to {} with floor {}, asked for {start}",
                state.end, state.floor
            )));
        }
        let mut hash = Resumed::from_midstate(&state.midstate, state.floor).map_err(|why| {
            DoorError::new(
                "midstate_malformed",
                format!(
                    "the door's running hash for session {session_ref} cannot be resumed: {why}"
                ),
            )
        })?;
        match read(host, session_ref, state.floor, start, &mut hash).await {
            Ok(()) => {}
            // A trim raised the floor while the bytes were read: start
            // again from the new floor and its running state.
            Err(Read::BelowFloor) => continue,
            Err(Read::Failed(error)) => return Err(error),
        }
        if hash.clone().finish() != state.digest {
            return Err(DoorError::new(
                "stream_digest_mismatch",
                format!(
                    "session {session_ref}'s stream bytes up to {start} do not hash to the digest the door recorded for them"
                ),
            ));
        }
        hash.update(snapshot);
        return Ok(hash.finish());
    }
    Err(DoorError::new(
        "below_floor",
        format!(
            "session {session_ref}'s stream was trimmed {FLOOR_RETRIES} times while it was read back"
        ),
    ))
}

enum Read {
    /// The read started below the stream's floor, which a trim raised.
    BelowFloor,
    Failed(DoorError),
}

/// Hash the stream's bytes `[from, to)`, read page by page.
async fn read<H: Host>(
    host: &H,
    session_ref: &str,
    from: u64,
    to: u64,
    hash: &mut Resumed,
) -> Result<(), Read> {
    let mut offset = from;
    while offset < to {
        let limit = (to - offset).min(PAGE as u64);
        let answer = host
            .door(
                "session.read",
                json!({"sessionRef": session_ref, "fromOffset": offset, "limit": limit}),
                DEADLINE,
            )
            .await;
        let answer = match answer {
            Ok(answer) => answer,
            Err(refusal) if refusal.code == "below_floor" => return Err(Read::BelowFloor),
            Err(refusal) => return Err(Read::Failed(DoorError::refused("session.read", &refusal))),
        };
        let page: Page = decode("session.read", answer).map_err(Read::Failed)?;
        let bytes = unhex(&page.bytes).ok_or_else(|| {
            Read::Failed(DoorError::retry(
                "the door's session.read answer carries bytes that are not hex",
            ))
        })?;
        if page.from_offset != offset
            || bytes.is_empty()
            || bytes.len() as u64 > limit
            || page.end_offset != offset + bytes.len() as u64
            || page.stream_end.is_some_and(|end| end < page.end_offset)
        {
            return Err(Read::Failed(DoorError::retry(format!(
                "the door answered session {session_ref}'s bytes from {offset} with another range"
            ))));
        }
        hash.update(&bytes);
        offset = page.end_offset;
    }
    Ok(())
}

/// A page of `session.read` bound to a cut: the page, the cut's end and
/// digest for the session's stream, and the stream's floor with the running
/// hash state there.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CutPage {
    bytes: String,
    from_offset: u64,
    end_offset: u64,
    stream_end: u64,
    digest: String,
    floor: u64,
    midstate: Midstate,
}

/// What a sealed cut holds of a session's stream, as the door serves it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CutBytes {
    /// The stream's trim floor: `bytes` start here.
    pub floor: u64,
    /// Where the cut ends the stream.
    pub end: u64,
    /// The SHA-256 the cut recorded for the stream's bytes up to `end`.
    pub digest: String,
    /// The stream's bytes from `floor` to `end`.
    pub bytes: Vec<u8>,
}

/// Read the session's stream as the sealed cut `cut` holds it, from the
/// stream's floor to the cut's end, and check the bytes against the digest
/// the cut recorded: the door's running hash at the floor, resumed over the
/// bytes read, must give it. The first read starts at byte 0; a stream
/// trimmed above that refuses it `below_floor` naming the floor, and the
/// read starts again there. So does a page reporting another floor than
/// the first one, since a trim moved it meanwhile.
pub async fn read_cut<H: Host>(
    host: &H,
    session_ref: &str,
    cut: &str,
) -> Result<CutBytes, DoorError> {
    let mut from = 0;
    'restart: for _ in 0..=FLOOR_RETRIES {
        let mut bytes = Vec::new();
        // The floor, end, digest and running hash the first page reported.
        let mut bound: Option<(u64, u64, String, Midstate)> = None;
        let mut offset = from;
        loop {
            let limit = match &bound {
                Some((_, end, _, _)) if offset == *end => break,
                Some((_, end, _, _)) => (end - offset).min(PAGE as u64),
                None => PAGE as u64,
            };
            let answer = host
                .door(
                    "session.read",
                    json!({"sessionRef": session_ref, "fromOffset": offset, "limit": limit, "cutId": cut}),
                    DEADLINE,
                )
                .await;
            let answer = match answer {
                Ok(answer) => answer,
                Err(refusal) if refusal.code == "below_floor" => {
                    match refusal
                        .detail
                        .as_ref()
                        .and_then(|detail| detail.get("floor"))
                        .and_then(Value::as_u64)
                    {
                        Some(floor) if floor > offset => {
                            from = floor;
                            continue 'restart;
                        }
                        _ => return Err(DoorError::refused("session.read", &refusal)),
                    }
                }
                Err(refusal) => return Err(DoorError::refused("session.read", &refusal)),
            };
            let page: CutPage = decode("session.read", answer)?;
            let read = unhex(&page.bytes).ok_or_else(|| {
                DoorError::retry("the door's session.read answer carries bytes that are not hex")
            })?;
            if page.from_offset != offset
                || read.is_empty()
                || read.len() as u64 > limit
                || page.end_offset != offset + read.len() as u64
                || page.end_offset > page.stream_end
            {
                return Err(DoorError::retry(format!(
                    "the door answered session {session_ref}'s bytes from {offset} in cut {cut} with another range"
                )));
            }
            match &bound {
                None if page.floor != from => {
                    // The read must start at the floor, where the running
                    // hash the door reports stands.
                    from = page.floor;
                    continue 'restart;
                }
                None => {
                    bound = Some((page.floor, page.stream_end, page.digest, page.midstate));
                }
                Some((floor, end, digest, _)) => {
                    if page.stream_end != *end || page.digest != *digest {
                        return Err(DoorError::retry(format!(
                            "the door changed cut {cut}'s end or digest for session {session_ref} between two pages"
                        )));
                    }
                    if page.floor != *floor {
                        from = page.floor;
                        continue 'restart;
                    }
                }
            }
            bytes.extend(read);
            offset = page.end_offset;
        }
        let (floor, end, digest, midstate) = bound.expect("a read ends only after a page");
        let mut hash = Resumed::from_midstate(&midstate, floor).map_err(|why| {
            DoorError::new(
                "midstate_malformed",
                format!(
                    "the door's running hash for session {session_ref} cannot be resumed: {why}"
                ),
            )
        })?;
        hash.update(&bytes);
        if hash.finish() != digest {
            return Err(DoorError::new(
                "stream_digest_mismatch",
                format!(
                    "session {session_ref}'s stream bytes up to {end} do not hash to the digest cut {cut} recorded for them"
                ),
            ));
        }
        return Ok(CutBytes {
            floor,
            end,
            digest,
            bytes,
        });
    }
    Err(DoorError::new(
        "below_floor",
        format!(
            "session {session_ref}'s stream was trimmed {FLOOR_RETRIES} times while cut {cut} was read"
        ),
    ))
}

async fn call<H: Host>(
    host: &H,
    method: &str,
    params: Value,
    deadline: Duration,
) -> Result<Value, DoorError> {
    host.door(method, params, deadline)
        .await
        .map_err(|refusal| DoorError::refused(method, &refusal))
}

fn decode<T: serde::de::DeserializeOwned>(method: &str, answer: Value) -> Result<T, DoorError> {
    serde_json::from_value(answer).map_err(|error| {
        DoorError::retry(format!(
            "the door's {method} answer does not decode: {error}"
        ))
    })
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    text.as_bytes()
        .chunks(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
        .collect()
}
