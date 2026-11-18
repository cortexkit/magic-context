//! The live hub: [`Hub`] over JetStream in the hub's domain.
//!
//! ck-mc reaches the hub on a connection of its own (`cortexkit-bus-client`'s
//! `HubClient`), as the federation account's magic-context user. That user
//! may publish on `ck.fleet.memory.>`, read `HUB_MEMORY`'s information, make
//! and delete consumers on it, and subscribe only under its own inbox
//! prefix. [`NatsHub`] serves the engine's four needs with those calls:
//! - **Publish** sets `Nats-Msg-Id` to the message id the engine formed and
//!   waits for the stream's acknowledgement. A duplicate acknowledgement is
//!   passed on as one, and the engine counts it as sent. The stream refuses
//!   new messages once it holds 1 GiB (it discards new messages, never old
//!   ones). For the engine that refusal is an unconfirmed publish like any
//!   other, so the outbox row waits and is sent again later; its error text
//!   is always [`STREAM_FULL`], so the replica task logs it once for as long
//!   as the stream stays full.
//! - **Follow** reads an ordered push consumer: an ephemeral consumer, with
//!   no acknowledgements, that delivers every subject in stream order to a
//!   subject under the connection's inbox prefix, starting after the
//!   engine's position. ck-mc keeps its own position and commits it with each
//!   applied message, so the consumer needs no durable name and no acks. One
//!   consumer serves read after read as long as each read starts where the
//!   last one ended.
//! - **The last sequence** comes from `STREAM.INFO`, for the engine's
//!   catch-up.
//! - **Ack** does nothing: the position the engine stores is the
//!   acknowledgement.
//!
//! Anything that could break the order of delivery fails the read and drops
//! the consumer: a message that skips a consumer sequence, a heartbeat that
//! names a sequence this side never got, three heartbeats missed, the
//! connection lost or made again (a restarted server has forgotten the
//! consumer), or any JetStream error. The engine's round ends there, and the
//! next read makes a new consumer from the stored position, so no message is
//! skipped and none is applied twice.
//!
//! [`HubStream`] is the seam between these decisions and the server: the few
//! JetStream calls they need. [`JetStream`] makes them against a server; the
//! unit tests answer them from a script.

use std::sync::atomic::Ordering;
use std::time::Duration;

use async_nats::jetstream;
use async_trait::async_trait;
use futures_util::StreamExt;
use tokio::sync::Mutex;
use tokio::time::Instant;

use super::hub::{Ack, Hub, HubError, HubMessage};

/// The hub's memory stream.
pub const STREAM: &str = cortexkit_bus_naming::federation::HUB_MEMORY_STREAM;

/// How often the consumer sends an idle heartbeat when it has nothing to
/// deliver.
pub const HEARTBEAT: Duration = Duration::from_secs(5);

/// How long the consumer may stay silent (no message, no heartbeat) before
/// it counts as gone: three heartbeats.
pub const SILENCE: Duration = Duration::from_secs(15);

/// How long a read waits for the next message while the stream still holds
/// messages the consumer has not delivered.
pub const PENDING_WAIT: Duration = Duration::from_secs(5);

/// How long a read waits for a first message when the consumer had nothing
/// more to deliver.
pub const QUIET_WAIT: Duration = Duration::from_millis(250);

/// How long a read that has messages already waits for one more, when the
/// consumer had nothing more to deliver.
pub const NEXT_WAIT: Duration = Duration::from_millis(20);

/// How long removing a consumer may take. The server removes one anyway
/// once nothing has subscribed to its subject for [`INACTIVE`].
const CLOSE_WAIT: Duration = Duration::from_secs(1);

/// How long the server keeps a consumer whose subject has no subscriber.
const INACTIVE: Duration = Duration::from_secs(30);

/// The error of a publish the stream refused because it is full.
pub const STREAM_FULL: &str =
    "the hub's memory stream is full, so changes wait in the outbox until it has room";

/// Why a JetStream call failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fault {
    /// The stream refused to store a message because it is full; the
    /// server's words.
    Full(String),
    /// Anything else: the connection, a timeout, a refusal.
    Failed(String),
}

impl std::fmt::Display for Fault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Full(why) | Self::Failed(why) => f.write_str(why),
        }
    }
}

/// One delivery on a consumer's subject.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Delivered {
    /// A stored message, with its consumer sequence and how many more
    /// messages the stream held for the consumer when it was sent.
    Message {
        message: HubMessage,
        consumer_seq: u64,
        pending: u64,
    },
    /// An idle heartbeat: the last consumer sequence the server sent, and
    /// the subject to answer when the server waits on flow control.
    Heartbeat {
        last_consumer_seq: Option<u64>,
        flow_control: Option<String>,
    },
    /// A flow control request, answered on this subject.
    FlowControl(String),
    /// A status after which the consumer delivers nothing more (it was
    /// deleted, for one), as the server described it.
    Ended(String),
}

/// A consumer just made: what it delivers, and how many messages the
/// stream held for it then.
pub struct Following {
    pub delivery: Box<dyn Delivery>,
    pub pending: u64,
}

/// The JetStream calls [`NatsHub`] makes.
#[async_trait]
pub trait HubStream: Send + Sync {
    /// Publish `payload` on `subject` with `Nats-Msg-Id: message_id` and
    /// wait for the stream's acknowledgement.
    async fn publish(
        &self,
        subject: &str,
        message_id: &str,
        payload: Vec<u8>,
    ) -> Result<Ack, Fault>;

    /// `HUB_MEMORY`'s last stored sequence, from `STREAM.INFO`.
    async fn last_seq(&self) -> Result<u64, Fault>;

    /// Make an ordered push consumer that delivers every message from
    /// stream sequence `start` on, and subscribe to its subject.
    async fn follow(&self, start: u64) -> Result<Following, Fault>;
}

/// What one consumer delivers.
#[async_trait]
pub trait Delivery: Send {
    /// The next delivery, waiting at most `wait`; `None` if none came.
    async fn next(&mut self, wait: Duration) -> Result<Option<Delivered>, Fault>;

    /// Answer a flow control request on `subject`.
    async fn answer(&mut self, subject: &str) -> Result<(), Fault>;

    /// Remove the consumer from the server, as far as it can be done
    /// quickly.
    async fn close(self: Box<Self>);
}

/// The consumer the engine reads, and where its delivery stands.
struct Follower {
    delivery: Box<dyn Delivery>,
    /// The stream sequence of the last message the engine read from this
    /// consumer, or the one before the first it delivers. A read after
    /// another position needs a new consumer.
    read_to: u64,
    /// The last stream and consumer sequence delivered.
    stream_seq: u64,
    consumer_seq: u64,
    /// How many more messages the stream held for the consumer at the last
    /// delivery.
    pending: u64,
    /// When the consumer last sent anything.
    heard: Instant,
    /// A message that arrived while the task waited for one, for the next
    /// read.
    held: Option<HubMessage>,
}

impl Follower {
    fn new(following: Following, after: u64) -> Self {
        Self {
            delivery: following.delivery,
            read_to: after,
            stream_seq: after,
            consumer_seq: 0,
            pending: following.pending,
            heard: Instant::now(),
            held: None,
        }
    }

    /// The next message, waiting at most `wait`, after the heartbeats and
    /// flow control requests that come first. An error means the delivery
    /// can't be trusted to continue in order.
    async fn next_message(&mut self, wait: Duration) -> Result<Option<HubMessage>, String> {
        let deadline = Instant::now() + wait;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let delivered = self
                .delivery
                .next(left)
                .await
                .map_err(|fault| fault.to_string())?;
            let Some(delivered) = delivered else {
                if self.heard.elapsed() >= SILENCE {
                    return Err(format!(
                        "the memory consumer sent nothing for {} seconds",
                        SILENCE.as_secs()
                    ));
                }
                return Ok(None);
            };
            self.heard = Instant::now();
            match delivered {
                Delivered::Message {
                    message,
                    consumer_seq,
                    pending,
                } => {
                    if consumer_seq != self.consumer_seq + 1 {
                        return Err(format!(
                            "the memory consumer skipped from delivery {} to {consumer_seq}",
                            self.consumer_seq
                        ));
                    }
                    if message.seq <= self.stream_seq {
                        return Err(format!(
                            "the memory consumer delivered message {} after {}",
                            message.seq, self.stream_seq
                        ));
                    }
                    self.consumer_seq = consumer_seq;
                    self.stream_seq = message.seq;
                    self.pending = pending;
                    return Ok(Some(message));
                }
                Delivered::Heartbeat {
                    last_consumer_seq,
                    flow_control,
                } => {
                    if let Some(subject) = flow_control {
                        self.answer(&subject).await?;
                    }
                    if let Some(last) = last_consumer_seq.filter(|last| *last != self.consumer_seq)
                    {
                        return Err(format!(
                            "the memory consumer sent {last} deliveries and {} arrived",
                            self.consumer_seq
                        ));
                    }
                }
                Delivered::FlowControl(subject) => self.answer(&subject).await?,
                Delivered::Ended(why) => return Err(format!("the memory consumer ended: {why}")),
            }
        }
    }

    async fn answer(&mut self, subject: &str) -> Result<(), String> {
        self.delivery
            .answer(subject)
            .await
            .map_err(|fault| format!("answering the memory consumer's flow control: {fault}"))
    }
}

/// [`Hub`] on the hub's memory stream, through [`HubStream`].
pub struct NatsHub {
    stream: std::sync::Arc<dyn HubStream>,
    follower: Mutex<Option<Follower>>,
}

impl NatsHub {
    pub fn new(stream: std::sync::Arc<dyn HubStream>) -> Self {
        Self {
            stream,
            follower: Mutex::new(None),
        }
    }

    /// Wait until the consumer delivers a message, keeping it for the next
    /// read, and answer its heartbeats and flow control meanwhile. Returns
    /// also when the consumer fails: it is dropped, and the next read makes
    /// a new one. With no consumer (none made yet, or one dropped) this
    /// never returns.
    pub async fn arrival(&self) {
        let mut slot = self.follower.lock().await;
        let Some(follower) = slot.as_mut() else {
            drop(slot);
            return std::future::pending().await;
        };
        if follower.held.is_some() {
            return;
        }
        loop {
            match follower.next_message(HEARTBEAT).await {
                Ok(None) => {}
                Ok(Some(message)) => {
                    follower.held = Some(message);
                    return;
                }
                Err(error) => {
                    tracing::debug!("ck-mc: replica: {error}; the consumer is made again");
                    if let Some(follower) = slot.take() {
                        follower.delivery.close().await;
                    }
                    return;
                }
            }
        }
    }

    /// Remove the consumer, if there is one.
    pub async fn close(&self) {
        if let Some(follower) = self.follower.lock().await.take() {
            follower.delivery.close().await;
        }
    }

    /// Whether a consumer is open, for the tests.
    #[cfg(test)]
    pub(crate) async fn following(&self) -> bool {
        self.follower.lock().await.is_some()
    }
}

#[async_trait]
impl Hub for NatsHub {
    async fn publish(
        &self,
        subject: &str,
        message_id: &str,
        payload: Vec<u8>,
    ) -> Result<Ack, HubError> {
        self.stream
            .publish(subject, message_id, payload)
            .await
            .map_err(|fault| match fault {
                Fault::Full(why) => {
                    tracing::debug!("ck-mc: replica: the hub refused {message_id}: {why}");
                    HubError(STREAM_FULL.to_owned())
                }
                Fault::Failed(why) => HubError(why),
            })
    }

    async fn fetch(&self, after: u64, max: usize) -> Result<Vec<HubMessage>, HubError> {
        if max == 0 {
            return Ok(Vec::new());
        }
        let mut slot = self.follower.lock().await;
        if slot
            .as_ref()
            .is_none_or(|follower| follower.read_to != after)
        {
            if let Some(old) = slot.take() {
                old.delivery.close().await;
            }
            let following = self
                .stream
                .follow(after + 1)
                .await
                .map_err(|fault| HubError(format!("making the memory consumer: {fault}")))?;
            *slot = Some(Follower::new(following, after));
        }
        let follower = slot.as_mut().expect("a consumer was just made");
        let mut messages: Vec<HubMessage> = follower.held.take().into_iter().collect();
        while messages.len() < max {
            let wait = if follower.pending > 0 {
                PENDING_WAIT
            } else if messages.is_empty() {
                QUIET_WAIT
            } else {
                NEXT_WAIT
            };
            match follower.next_message(wait).await {
                Ok(Some(message)) => messages.push(message),
                Ok(None) => break,
                Err(error) => {
                    if let Some(follower) = slot.take() {
                        follower.delivery.close().await;
                    }
                    return Err(HubError(error));
                }
            }
        }
        if let Some(last) = messages.last() {
            follower.read_to = last.seq;
        }
        Ok(messages)
    }

    async fn last_seq(&self) -> Result<u64, HubError> {
        self.stream
            .last_seq()
            .await
            .map_err(|fault| HubError(format!("reading {STREAM}'s last sequence: {fault}")))
    }

    async fn ack(&self, _seq: u64) -> Result<(), HubError> {
        Ok(())
    }
}

/// The server's error codes for a stream that can store nothing more: a
/// store refused at the stream's limits (`JSStreamStoreFailedF`, which also
/// covers storage failures, so its description decides), the server out of
/// resources, and the account's storage spent.
const STORE_FAILED: u64 = 10077;
const INSUFFICIENT_RESOURCES: u64 = 10023;
const ACCOUNT_RESOURCES_EXCEEDED: u64 = 10002;

/// Whether a refused publish says the stream or the account is full.
pub fn full(error: &jetstream::Error) -> bool {
    match error.error_code().0 {
        STORE_FAILED => error.to_string().starts_with("maximum"),
        INSUFFICIENT_RESOURCES | ACCOUNT_RESOURCES_EXCEEDED => true,
        _ => false,
    }
}

fn publish_fault(error: jetstream::context::PublishError) -> Fault {
    let refusal = std::error::Error::source(&error)
        .and_then(|source| source.downcast_ref::<jetstream::Error>())
        .cloned();
    match refusal {
        Some(refusal) if full(&refusal) => Fault::Full(refusal.to_string()),
        Some(refusal) => Fault::Failed(format!("the hub refused the message: {refusal}")),
        None => Fault::Failed(format!("publishing to the hub: {error}")),
    }
}

/// [`HubStream`] against a JetStream server.
pub struct JetStream {
    context: jetstream::Context,
}

impl JetStream {
    /// JetStream calls in `context`, which names the hub's domain. Its
    /// client's inbox prefix is where consumers deliver.
    pub fn new(context: jetstream::Context) -> Self {
        Self { context }
    }
}

#[async_trait]
impl HubStream for JetStream {
    async fn publish(
        &self,
        subject: &str,
        message_id: &str,
        payload: Vec<u8>,
    ) -> Result<Ack, Fault> {
        let mut headers = async_nats::HeaderMap::new();
        headers.insert(async_nats::header::NATS_MESSAGE_ID, message_id);
        let ack = self
            .context
            .publish_with_headers(subject.to_owned(), headers, payload.into())
            .await
            .map_err(publish_fault)?
            .await
            .map_err(publish_fault)?;
        Ok(Ack {
            seq: ack.sequence,
            duplicate: ack.duplicate,
        })
    }

    async fn last_seq(&self) -> Result<u64, Fault> {
        let stream = self
            .context
            .get_stream(STREAM)
            .await
            .map_err(|error| Fault::Failed(error.to_string()))?;
        Ok(stream.cached_info().state.last_sequence)
    }

    async fn follow(&self, start: u64) -> Result<Following, Fault> {
        use jetstream::consumer::{push, AckPolicy, DeliverPolicy, ReplayPolicy};
        let client = self.context.client();
        let subject = client.new_inbox();
        // Subscribe first, so nothing the consumer sends is missed.
        let subscriber = client
            .subscribe(subject.clone())
            .await
            .map_err(|error| Fault::Failed(format!("subscribing: {error}")))?;
        let connects = client.statistics().connects.load(Ordering::Relaxed);
        let consumer = self
            .context
            .create_consumer_on_stream(
                push::Config {
                    deliver_subject: subject,
                    description: Some("ck-mc memory follower".to_owned()),
                    deliver_policy: DeliverPolicy::ByStartSequence {
                        start_sequence: start.max(1),
                    },
                    ack_policy: AckPolicy::None,
                    max_deliver: 1,
                    replay_policy: ReplayPolicy::Instant,
                    flow_control: true,
                    idle_heartbeat: HEARTBEAT,
                    inactive_threshold: INACTIVE,
                    memory_storage: true,
                    num_replicas: 1,
                    ..Default::default()
                },
                STREAM,
            )
            .await
            .map_err(|error| Fault::Failed(error.to_string()))?;
        let info = consumer.cached_info();
        Ok(Following {
            pending: info.num_pending,
            delivery: Box::new(Subscription {
                subscriber,
                context: self.context.clone(),
                client,
                consumer: info.name.clone(),
                connects,
            }),
        })
    }
}

/// A consumer's subject, as subscribed on the hub connection.
struct Subscription {
    subscriber: async_nats::Subscriber,
    context: jetstream::Context,
    client: async_nats::Client,
    consumer: String,
    /// The client's connect count when the consumer was made: a higher one
    /// means the connection was lost and made again, and a restarted server
    /// has forgotten the consumer.
    connects: u64,
}

#[async_trait]
impl Delivery for Subscription {
    async fn next(&mut self, wait: Duration) -> Result<Option<Delivered>, Fault> {
        if self.client.statistics().connects.load(Ordering::Relaxed) != self.connects {
            return Err(Fault::Failed(
                "the connection to the hub was made again".to_owned(),
            ));
        }
        if self.client.connection_state() != async_nats::connection::State::Connected {
            return Err(Fault::Failed(
                "the connection to the hub is down".to_owned(),
            ));
        }
        match tokio::time::timeout(wait, self.subscriber.next()).await {
            Err(_) => Ok(None),
            Ok(None) => Err(Fault::Failed("the connection to the hub closed".to_owned())),
            Ok(Some(message)) => delivered(&self.context, message).map(Some),
        }
    }

    async fn answer(&mut self, subject: &str) -> Result<(), Fault> {
        self.client
            .publish(subject.to_owned(), Default::default())
            .await
            .map_err(|error| Fault::Failed(error.to_string()))
    }

    async fn close(self: Box<Self>) {
        let Self {
            subscriber,
            context,
            consumer,
            ..
        } = *self;
        drop(subscriber);
        let _ = tokio::time::timeout(
            CLOSE_WAIT,
            context.delete_consumer_from_stream(&consumer, STREAM),
        )
        .await;
    }
}

/// The value of header `name`, if the message has it.
fn header(
    message: &async_nats::Message,
    name: impl async_nats::header::IntoHeaderName,
) -> Option<String> {
    message
        .headers
        .as_ref()
        .and_then(|headers| headers.get(name))
        .map(|value| value.as_str().to_owned())
}

/// One message on a consumer's subject, as [`Delivered`].
fn delivered(
    context: &jetstream::Context,
    message: async_nats::Message,
) -> Result<Delivered, Fault> {
    match message.status {
        Some(async_nats::StatusCode::IDLE_HEARTBEAT) => Ok(match message.reply.as_ref() {
            // A flow control request carries the subject to answer as its
            // reply; a heartbeat carries none.
            Some(reply) => Delivered::FlowControl(reply.to_string()),
            None => Delivered::Heartbeat {
                last_consumer_seq: header(&message, async_nats::header::NATS_LAST_CONSUMER)
                    .and_then(|seq| seq.parse().ok()),
                flow_control: header(&message, "Nats-Consumer-Stalled"),
            },
        }),
        Some(status) => Ok(Delivered::Ended(format!(
            "{status} {}",
            message.description.as_deref().unwrap_or_default()
        ))),
        None => {
            let message_id = header(&message, async_nats::header::NATS_MESSAGE_ID);
            let message = jetstream::message::Message {
                message,
                context: context.clone(),
            };
            let info = message.info().map_err(|error| {
                Fault::Failed(format!("a delivery without its stream sequence: {error}"))
            })?;
            let (seq, consumer_seq, pending) =
                (info.stream_sequence, info.consumer_sequence, info.pending);
            Ok(Delivered::Message {
                message: HubMessage {
                    seq,
                    subject: message.message.subject.to_string(),
                    message_id,
                    payload: message.message.payload.to_vec(),
                },
                consumer_seq,
                pending,
            })
        }
    }
}
