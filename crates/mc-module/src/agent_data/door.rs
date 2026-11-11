//! The source's calls to Engram's session door: `session.cover`,
//! `session.admit` and `session.read`.
//!
//! The door keeps one append-only stream per caller and session. It names
//! the stream after the route's attested caller (`reserved:<module id>`)
//! and the session by its llm-runner `sessionRef`, so no request carries a
//! stream of its own. Each move of a session appends its snapshot to the
//! session's stream, and a cut is the stream's length and the SHA-256 of
//! every byte up to it, earlier moves' snapshots included.
//!
//! Bytes travel as lowercase hex, at most one MiB of raw bytes per call.

use std::time::Duration;

use cortexkit_role_agent_data::errors::{ErrorBody, RefusalCode};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::service::Host;
use crate::client::DoorRefusal;

/// The most raw bytes one `session.admit` or `session.read` carries: the
/// door refuses more with `record_too_large`.
pub const PAGE: usize = 1024 * 1024;

/// How long one door call may take.
pub const DEADLINE: Duration = Duration::from_secs(30);

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
}

/// `session.cover`: what the door holds of the session's stream, after it
/// has pushed what it can to the cloud.
pub async fn cover<H: Host>(host: &H, session_ref: &str) -> Result<Position, ErrorBody> {
    let answer = host
        .door("session.cover", json!({"sessionRef": session_ref}))
        .await
        .map_err(|refusal| refused("session.cover", &refusal))?;
    position("session.cover", answer)
}

/// Admit `bytes` as the stream's bytes from `start` on, resuming from what
/// the door already holds: a repeat after a lost reply or a crash sends
/// only the pages the door does not have yet. The stream must hold no byte
/// past `start + bytes.len()`, and none before `start` that this export did
/// not write, so another writer's bytes are never taken for ours.
pub async fn admit<H: Host>(
    host: &H,
    session_ref: &str,
    start: u64,
    bytes: &[u8],
) -> Result<(), ErrorBody> {
    let end = start + bytes.len() as u64;
    let mut offset = cover(host, session_ref).await?.durable_offset;
    loop {
        if offset < start || offset > end {
            return Err(unavailable(format!(
                "the door's stream for session {session_ref} ends at byte {offset}, outside the prepared snapshot's bytes {start}..{end}; abort the move and prepare it again"
            )));
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
            )
            .await;
        match answer {
            Ok(answer) => {
                let admitted = position("session.admit", answer)?.durable_offset;
                if admitted != offset + page.len() as u64 {
                    return Err(unavailable(format!(
                        "the door admitted session {session_ref}'s bytes {offset}..{} but reports its stream ending at {admitted}",
                        offset + page.len() as u64
                    )));
                }
                offset = admitted;
            }
            // Another call already moved the stream on, for example a
            // reply lost after the door wrote it: start again from where
            // the door is now.
            Err(refusal) if refusal.code == "offset_mismatch" => {
                let now = cover(host, session_ref).await?.durable_offset;
                if now == offset {
                    return Err(refused("session.admit", &refusal));
                }
                offset = now;
            }
            Err(refusal) => return Err(refused("session.admit", &refusal)),
        }
    }
}

/// The SHA-256 of the session's stream with `snapshot` appended at
/// `start`: the bytes before `start` read back from the door, which holds
/// them from earlier moves, then the snapshot.
pub async fn digest<H: Host>(
    host: &H,
    session_ref: &str,
    start: u64,
    snapshot: &[u8],
) -> Result<String, ErrorBody> {
    let mut hash = Sha256::new();
    let mut offset = 0;
    while offset < start {
        let limit = (start - offset).min(PAGE as u64);
        let answer = host
            .door(
                "session.read",
                json!({"sessionRef": session_ref, "fromOffset": offset, "limit": limit}),
            )
            .await
            .map_err(|refusal| refused("session.read", &refusal))?;
        let page: Page = serde_json::from_value(answer).map_err(|error| {
            unavailable(format!(
                "the door's session.read answer does not decode: {error}"
            ))
        })?;
        let bytes = unhex(&page.bytes).ok_or_else(|| {
            unavailable("the door's session.read answer carries bytes that are not hex")
        })?;
        if page.from_offset != offset
            || bytes.is_empty()
            || bytes.len() as u64 > limit
            || page.end_offset != offset + bytes.len() as u64
        {
            return Err(unavailable(format!(
                "the door answered session {session_ref}'s bytes from {offset} with another range"
            )));
        }
        hash.update(&bytes);
        offset = page.end_offset;
    }
    hash.update(snapshot);
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn position(method: &str, answer: Value) -> Result<Position, ErrorBody> {
    serde_json::from_value(answer).map_err(|error| {
        unavailable(format!(
            "the door's {method} answer does not decode: {error}"
        ))
    })
}

/// A door refusal, as the driver should read it: the move can go on once
/// the door can, so the same request is worth sending again.
fn refused(method: &str, refusal: &DoorRefusal) -> ErrorBody {
    unavailable(format!(
        "Engram's session door refused {method}: {} ({})",
        refusal.code, refusal.message
    ))
}

fn unavailable(message: impl Into<String>) -> ErrorBody {
    ErrorBody::new(RefusalCode::Unavailable, message)
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
