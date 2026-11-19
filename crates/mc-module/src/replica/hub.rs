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
//! - the stream's last sequence and its creation time ([`StreamInfo`]): the
//!   last sequence tells a joining computer when it has read everyone else's
//!   history, and the creation time which stream a stored position belongs
//!   to, since a stream made anew starts at sequence 1 again;
//! - one stored message by its sequence, to read again the message that
//!   decides a row's state ([`super::apply`]);
//! - an acknowledgement of each message once it is applied, for a stream
//!   that wants one (the live stream doesn't: the stored position is the
//!   acknowledgement);
//! - whether a read starts a new consumer, so the engine checks first that
//!   its position still belongs to the stream ([`Hub::starts_consumer`]).

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

/// What the stream says of itself: the sequence of its newest message (0
/// when it is empty), and when it was made, in a form compared only for
/// equality. A stream made again has another creation time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StreamInfo {
    pub created: String,
    pub last_seq: u64,
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

    /// The newest stored sequence and when the stream was made.
    async fn info(&self) -> Result<StreamInfo, HubError>;

    /// The message stored at `seq`; `None` when the stream holds none
    /// there.
    async fn get(&self, seq: u64) -> Result<Option<HubMessage>, HubError>;

    /// The message at `seq` is applied (or recorded as rejected).
    async fn ack(&self, seq: u64) -> Result<(), HubError>;

    /// Whether a read of the messages after `after` starts a new consumer
    /// on the hub, rather than going on with the one the last read used.
    /// The engine checks first that its position still belongs to the
    /// stream, since a stream made anew only ends the consumer. A hub that
    /// keeps no consumer starts one for every read.
    async fn starts_consumer(&self, _after: u64) -> bool {
        true
    }
}

/// A stream held in memory, shared by the stores of one test as the hub is
/// shared by a user's computers. Each one made counts as a stream made
/// anew: it has a creation time of its own.
#[cfg(test)]
pub struct InMemoryHub {
    created: String,
    state: std::sync::Mutex<InMemoryState>,
}

/// Every in-memory stream of a test process takes its creation time from
/// this counter, so no two are taken for the same stream.
#[cfg(test)]
static STREAMS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[cfg(test)]
impl Default for InMemoryHub {
    fn default() -> Self {
        Self {
            created: format!(
                "stream-{}",
                STREAMS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ),
            state: std::sync::Mutex::default(),
        }
    }
}

#[cfg(test)]
#[derive(Default)]
struct InMemoryState {
    messages: Vec<HubMessage>,
    /// The sequence of the newest message stored, removed or not.
    last: u64,
    ids: std::collections::HashMap<String, u64>,
    acked: Vec<u64>,
    /// Publishes still to fail before storing anything.
    refuse: usize,
    /// Publishes still to let through before failing one.
    refuse_after: Option<usize>,
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
        state.last += 1;
        let seq = state.last;
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

    /// Let the next `passing` publishes through, then fail the one after
    /// without storing it.
    pub fn refuse_after(&self, passing: usize) {
        self.state().refuse_after = Some(passing);
    }

    /// Forget every message id stored so far, as JetStream does once its
    /// duplicate window has passed: a publish under one of them is stored
    /// again as a new message.
    pub fn forget_ids(&self) {
        self.state().ids.clear();
    }

    /// A stream made with creation time `created`, as a stream made again
    /// with the same one would be.
    pub fn named(created: &str) -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            created: created.to_owned(),
            state: std::sync::Mutex::default(),
        })
    }

    /// Remove the message at `seq` from the stream, keeping the others'
    /// sequences.
    pub fn forget(&self, seq: u64) {
        self.state().messages.retain(|message| message.seq != seq);
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
        match state.refuse_after {
            Some(0) => {
                state.refuse_after = None;
                return Err(HubError("hub unreachable".into()));
            }
            Some(passing) => state.refuse_after = Some(passing - 1),
            None => {}
        }
        // JetStream keeps a message id for its duplicate window; the test
        // stream keeps every id for good.
        let ack = match state.ids.get(message_id) {
            Some(seq) => Ack {
                seq: *seq,
                duplicate: true,
            },
            None => {
                state.last += 1;
                let seq = state.last;
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

    async fn info(&self) -> Result<StreamInfo, HubError> {
        Ok(StreamInfo {
            created: self.created.clone(),
            last_seq: self.state().last,
        })
    }

    async fn get(&self, seq: u64) -> Result<Option<HubMessage>, HubError> {
        Ok(self
            .state()
            .messages
            .iter()
            .find(|message| message.seq == seq)
            .cloned())
    }

    async fn ack(&self, seq: u64) -> Result<(), HubError> {
        self.state().acked.push(seq);
        Ok(())
    }
}
