//! The hub's memory stream (`HUB_MEMORY`), as the replica engine uses it.
//!
//! The live stream is a JetStream stream on the hub, in its own domain,
//! that every computer of the user publishes to on
//! `ck.fleet.memory.<kind>.<owner>` and reads in stream order from the
//! position it stored ([`super::nats`]). The engine needs four things from
//! it, which this trait names, so the engine can be tested against
//! [`InMemoryHub`] and wired to the live stream on its own:
//! - a publish whose acknowledgement names the stored sequence, and which
//!   stores a message id once (a retry of an unconfirmed publish is
//!   recognised as the same message);
//! - the stored messages after a sequence, in stream order;
//! - the stream's last sequence, which tells a joining computer when it has
//!   read everyone else's history;
//! - an acknowledgement of each message once it is applied, for a stream
//!   that wants one (the live stream doesn't: the stored position is the
//!   acknowledgement).

use async_trait::async_trait;

/// A message as the stream delivers it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HubMessage {
    pub seq: u64,
    pub subject: String,
    pub message_id: Option<String>,
    pub payload: Vec<u8>,
}

/// The stream's acknowledgement of a publish. `duplicate` means the stream
/// already held a message with that id, at `seq`, and stored nothing new.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ack {
    pub seq: u64,
    pub duplicate: bool,
}

/// The hub could not be reached, or refused. A publish that ends this way
/// is unconfirmed: it may or may not be stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HubError(pub String);

impl std::fmt::Display for HubError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[async_trait]
pub trait Hub: Send + Sync {
    /// Store `payload` on `subject` under `message_id` (`Nats-Msg-Id`).
    async fn publish(
        &self,
        subject: &str,
        message_id: &str,
        payload: Vec<u8>,
    ) -> Result<Ack, HubError>;

    /// Up to `max` stored messages with a sequence above `after`, in order.
    async fn fetch(&self, after: u64, max: usize) -> Result<Vec<HubMessage>, HubError>;

    /// The sequence of the newest stored message, 0 for an empty stream.
    async fn last_seq(&self) -> Result<u64, HubError>;

    /// The message at `seq` is applied (or recorded as rejected).
    async fn ack(&self, seq: u64) -> Result<(), HubError>;
}

/// A stream held in memory, shared by the stores of one test as the hub is
/// shared by a user's computers.
#[cfg(test)]
#[derive(Default)]
pub struct InMemoryHub {
    state: std::sync::Mutex<InMemoryState>,
}

#[cfg(test)]
#[derive(Default)]
struct InMemoryState {
    messages: Vec<HubMessage>,
    ids: std::collections::HashMap<String, u64>,
    acked: Vec<u64>,
    /// Publishes still to fail before storing anything.
    refuse: usize,
    /// Publishes still to store but answer without an acknowledgement, as
    /// when the acknowledgement is lost on the way back.
    lose_acks: usize,
    published: usize,
}

#[cfg(test)]
impl InMemoryHub {
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self::default())
    }

    fn state(&self) -> std::sync::MutexGuard<'_, InMemoryState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Store a message as another writer would, unchecked; for messages a
    /// test builds by hand.
    pub fn inject(&self, subject: &str, message_id: Option<&str>, payload: Vec<u8>) -> u64 {
        let mut state = self.state();
        let seq = state.messages.len() as u64 + 1;
        state.messages.push(HubMessage {
            seq,
            subject: subject.to_owned(),
            message_id: message_id.map(str::to_owned),
            payload,
        });
        if let Some(id) = message_id {
            state.ids.insert(id.to_owned(), seq);
        }
        seq
    }

    pub fn messages(&self) -> Vec<HubMessage> {
        self.state().messages.clone()
    }

    /// How many publish calls reached the hub, duplicates included.
    pub fn publish_calls(&self) -> usize {
        self.state().published
    }

    pub fn acked(&self) -> Vec<u64> {
        self.state().acked.clone()
    }

    /// Fail the next `count` publishes without storing them.
    pub fn refuse_next(&self, count: usize) {
        self.state().refuse = count;
    }

    /// Store the next `count` publishes but answer each with an error.
    pub fn lose_next_acks(&self, count: usize) {
        self.state().lose_acks = count;
    }
}

#[cfg(test)]
#[async_trait]
impl Hub for InMemoryHub {
    async fn publish(
        &self,
        subject: &str,
        message_id: &str,
        payload: Vec<u8>,
    ) -> Result<Ack, HubError> {
        let mut state = self.state();
        state.published += 1;
        if state.refuse > 0 {
            state.refuse -= 1;
            return Err(HubError("hub unreachable".into()));
        }
        // JetStream keeps a message id for its duplicate window; the test
        // stream keeps every id for good.
        let ack = match state.ids.get(message_id) {
            Some(seq) => Ack {
                seq: *seq,
                duplicate: true,
            },
            None => {
                let seq = state.messages.len() as u64 + 1;
                state.messages.push(HubMessage {
                    seq,
                    subject: subject.to_owned(),
                    message_id: Some(message_id.to_owned()),
                    payload,
                });
                state.ids.insert(message_id.to_owned(), seq);
                Ack {
                    seq,
                    duplicate: false,
                }
            }
        };
        if state.lose_acks > 0 {
            state.lose_acks -= 1;
            return Err(HubError("acknowledgement lost".into()));
        }
        Ok(ack)
    }

    async fn fetch(&self, after: u64, max: usize) -> Result<Vec<HubMessage>, HubError> {
        Ok(self
            .state()
            .messages
            .iter()
            .filter(|message| message.seq > after)
            .take(max)
            .cloned()
            .collect())
    }

    async fn last_seq(&self) -> Result<u64, HubError> {
        Ok(self.state().messages.len() as u64)
    }

    async fn ack(&self, seq: u64) -> Result<(), HubError> {
        self.state().acked.push(seq);
        Ok(())
    }
}
