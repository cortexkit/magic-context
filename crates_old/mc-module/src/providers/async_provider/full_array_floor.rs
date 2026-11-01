//! Claude Code conversations ck-mc served on the full-array `transform` route
//! before their gateway moved them to this lane.
//!
//! On the full-array route a part's tag number existed only in the bytes
//! ck-mc rendered: neither Claude Code's history nor the gateway's store
//! keeps it, so the gateway admits the conversation here as a new one and,
//! with no Setup checkpoint, its runner would number parts from the start.
//! The model has already seen the full-array numbers and may repeat one many
//! turns later, so a number could then name different content and
//! `ctx_reduce` would drop the wrong part. Setup therefore answers a
//! checkpoint above every number the full-array route ever allocated for the
//! conversation, so old numbers resolve to nothing and are refused.
//!
//! The full-array route keyed its store rows by the transform request's
//! `session_id`, which the gateway built from the Claude Code session, the
//! subagent and the epoch, joined by U+241F: a head at epoch 0 is the bare
//! session id, a head at epoch N > 0 is `<session>␟<N>`, and a subagent is
//! always `<session>␟<agent>␟<epoch>`. This lane's session for the head is
//! the session id and for a subagent `<session>/<agent>`, the same in every
//! epoch. So head `S` covers `S` and every `S␟N`, and subagent `S/A` every
//! `S␟A␟N`.
use super::*;

/// The harness Claude Code conversations are set up under.
const CLAUDE_CODE_HARNESS: &str = "claude-code";
/// Joins the parts of a full-array store key.
const KEY_DELIMITER: char = '\u{241f}';
/// Joins a subagent's parent session and agent id in this lane's session.
const SUBAGENT_DELIMITER: char = '/';
/// Setup refusal when the full-array state cannot be read. Setting the
/// conversation up without a floor could reuse a number the model saw.
pub(super) const FULL_ARRAY_STATE_UNREADABLE: &str = "full_array_state_unreadable";
/// Setup refusal for a stored full-array key that starts like one of this
/// conversation's keys but does not parse as one, so ck-mc cannot tell
/// whether its numbers were shown to this conversation.
pub(super) const FULL_ARRAY_KEY_AMBIGUOUS: &str = "full_array_key_ambiguous";

/// The floor a Claude Code conversation carried over from the full-array
/// route, stored in its async record so every later Setup, after a restart or
/// a resync too, answers the same checkpoint and never reads the full-array
/// state again.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(super) struct FullArrayFloor {
    /// The highest tag number the full-array route allocated under any of
    /// the conversation's keys, in any epoch.
    pub tag_checkpoint: u64,
    /// The message the runner anchors that number at: the conversation's
    /// first message.
    pub cut: String,
}

impl FullArrayFloor {
    /// The Setup checkpoint every Setup answer for this conversation carries.
    pub(super) fn checkpoint(&self) -> contract::setup::SetupCheckpoint {
        contract::setup::SetupCheckpoint::new(self.tag_checkpoint, &self.cut)
    }
}

pub(super) enum Floor {
    /// Not a Claude Code conversation, or no full-array number was ever
    /// allocated for it: set up exactly as before.
    None,
    Carried(FullArrayFloor),
    /// Refuse Setup with this answer.
    Refuse(Value),
}

/// The full-array keys of one async-lane conversation: the exact key (the
/// head's epoch 0) and the prefix every other key of it starts with.
struct KeyFamily<'a> {
    exact: String,
    prefix: String,
    /// The head may share its prefix with its subagents' keys, which are
    /// not its own.
    head: bool,
    session: &'a str,
}

impl<'a> KeyFamily<'a> {
    fn for_session(session: &'a str) -> Self {
        match session.split_once(SUBAGENT_DELIMITER) {
            Some((parent, agent)) => {
                let prefix = format!("{parent}{KEY_DELIMITER}{agent}{KEY_DELIMITER}");
                Self {
                    exact: prefix.clone(),
                    prefix,
                    head: false,
                    session,
                }
            }
            None => Self {
                exact: session.to_owned(),
                prefix: format!("{session}{KEY_DELIMITER}"),
                head: true,
                session,
            },
        }
    }

    /// The epoch of `key` (read from the store as the exact key or under the
    /// prefix) when it is one of this conversation's keys, `None` when it is
    /// another conversation's. `Err` for a key that starts like one of this
    /// conversation's but does not parse.
    fn epoch_of(&self, key: &str) -> Result<Option<u64>, String> {
        if self.head && key == self.exact {
            return Ok(Some(0));
        }
        let Some(rest) = key.strip_prefix(&self.prefix) else {
            return Ok(None);
        };
        let epoch = |part: &str| {
            (!part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
                .then(|| part.parse::<u64>().ok())
                .flatten()
        };
        let parts = rest.split(KEY_DELIMITER).collect::<Vec<_>>();
        match parts.as_slice() {
            [n] if epoch(n).is_some() => Ok(epoch(n)),
            // Another conversation's key: a subagent of this head.
            [agent, n] if self.head && !agent.is_empty() && epoch(n).is_some() => Ok(None),
            _ => Err(format!(
                "stored key {key:?} starts like a full-array key of session {:?} but does not parse as one",
                self.session
            )),
        }
    }
}

/// The floor a first Setup of `session` answers, read from the full-array
/// route's tag rows.
pub(super) fn setup_floor(
    store: &McStore,
    harness: &str,
    session: &str,
    request_id: &str,
) -> Floor {
    if harness != CLAUDE_CODE_HARNESS {
        return Floor::None;
    }
    let family = KeyFamily::for_session(session);
    let refuse = |code: &str, reason: String| {
        tracing::error!(session, code, reason, "full-array floor refused setup");
        Floor::Refuse(
            serde_json::to_value(contract::setup::SetupAnswer::refuse(
                request_id,
                contract::errors::RefuseCode::from_code(code),
                reason,
            ))
            .expect("Setup refusal serializes"),
        )
    };
    let rows = match store.tag_high_water_by_session_prefix(&family.exact, &family.prefix) {
        Ok(rows) => rows,
        Err(error) => {
            return refuse(
                FULL_ARRAY_STATE_UNREADABLE,
                format!("The full-array tag rows of this conversation cannot be read: {error}"),
            )
        }
    };
    // (epoch, key, high-water) of every key of this conversation.
    let mut owned: Vec<(u64, &str, u64)> = Vec::new();
    for (key, high_water) in &rows {
        let epoch = match family.epoch_of(key) {
            Ok(Some(epoch)) => epoch,
            Ok(None) => continue,
            Err(reason) => return refuse(FULL_ARRAY_KEY_AMBIGUOUS, reason),
        };
        let Ok(high_water) = u64::try_from(*high_water) else {
            return refuse(
                FULL_ARRAY_STATE_UNREADABLE,
                format!("stored key {key:?} holds a negative tag number {high_water}"),
            );
        };
        owned.push((epoch, key, high_water));
    }
    // Every epoch's numbers were shown to the model, so the floor is the
    // highest across all of them, not the latest epoch's.
    let Some(&(_, floor_key, tag_checkpoint)) = owned
        .iter()
        .filter(|(_, _, high_water)| *high_water > 0)
        .max_by_key(|(_, _, high_water)| *high_water)
    else {
        return Floor::None;
    };
    let Some(&(_, first_key, _)) = owned.iter().min_by_key(|(epoch, _, _)| *epoch) else {
        return Floor::None;
    };
    let cut = match first_message(store, first_key) {
        Ok(cut) => cut,
        Err(reason) => return refuse(FULL_ARRAY_STATE_UNREADABLE, reason),
    };
    tracing::info!(
        session,
        tag_checkpoint,
        floor_key,
        keys = owned.len(),
        cut,
        "full-array floor carried into async setup"
    );
    Floor::Carried(FullArrayFloor {
        tag_checkpoint,
        cut,
    })
}

/// The conversation's first message: the message holding the lowest tag
/// number of its earliest epoch. The full-array route numbers blocks in the
/// order it first sees them, and a tag row's block id is `<mid>#<block>`.
///
/// When the runner's history no longer starts there (it holds only a later
/// epoch), the runner does not find the cut and numbers from the session
/// start with the same checkpoint (llm-runner §9.6), so the floor holds
/// either way.
fn first_message(store: &McStore, key: &str) -> Result<String, String> {
    let rows = store
        .load_tag_numbers_for_session(key)
        .map_err(|error| format!("the full-array tag rows of {key:?} cannot be read: {error}"))?;
    let first = rows
        .first()
        .ok_or_else(|| format!("stored key {key:?} lost its tag rows during setup"))?;
    match first.block_id.rsplit_once('#') {
        Some((mid, _)) if !mid.is_empty() => Ok(mid.to_owned()),
        _ => Err(format!(
            "tag {} of stored key {key:?} names block {:?}, which holds no message id",
            first.tag_number, first.block_id
        )),
    }
}
