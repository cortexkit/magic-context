//! The replica task: the engine run against the user's hub, in production.
//!
//! A build with the `memory-replica` feature ([`super::FEATURE`]) starts it
//! with the module ([`start`]); a build without it never does, and nothing
//! contacts the hub. The task:
//! - learns this computer's box id from the module's bus account and asks
//!   ck-bus for a connection to the hub (`HubClient::connect`, a credential
//!   from `ckbus.hub_credential` that the bus client renews). While ck-bus
//!   answers that the hub is unavailable (no hub link, or the vault's
//!   federation signer, the key that signs credentials for the user's
//!   federation account on the hub, isn't there yet), that magic-context
//!   isn't granted the hub, or the connection fails, nothing is sent: the
//!   outbox keeps every change, and the task asks again after
//!   [`retry_after`].
//! - runs the engine's rounds ([`Replica::round`]: join, follow, publish)
//!   over [`NatsHub`] on that connection. Each connection gets a new engine,
//!   which reads the stream to its end before it sends anything, and a new
//!   consumer, made from the stored position. A round that read or sent
//!   something is followed by the next at once; otherwise the next one
//!   waits for a message on the consumer, a memory change on this computer,
//!   or [`IDLE`]. A failed round (the connection lost, a gap in the
//!   consumer's delivery, a busy store, the stream full) is tried again
//!   after [`round_retry`].
//! - starts again on the new connection when the bus client replaces the
//!   connection, and from the connect step when the connection's credential
//!   maintenance stops (the hub refused it, or it can't be renewed).
//! - logs once per change of state, never per retry: the hub's refusals by
//!   kind, the connection, a round failing for a new reason, and rounds
//!   succeeding again.
//! - stops when the module does ([`ReplicaTask::stop`]): the round under way
//!   is dropped at its next wait, which loses nothing, because every message
//!   is applied in its own transaction with its stream position and an
//!   unconfirmed publish is sent again under the same message id. The
//!   consumer is removed and the hub connection closed.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::{watch, Notify};

use super::hub::Hub;
use super::nats::{HubStream, JetStream, NatsHub};
use super::seal::Sealer;
use super::Replica;
use crate::context_db::ContextDb;

/// How long the task waits between rounds that found nothing to do, when
/// no message and no local change wakes it first.
pub const IDLE: Duration = Duration::from_secs(30);

/// The first wait before asking ck-bus for the hub again. A refusal at
/// start is often ck-bus or the vault still starting, so the first retries
/// come soon.
pub const RETRY_FIRST: Duration = Duration::from_secs(5);

/// The longest wait between asks. What else keeps the hub away (no hub
/// link yet, no signer in the vault for hub credentials yet, the grant
/// missing) changes when the person pairs a computer or ck-bus is updated,
/// so five minutes is soon enough, and each ask is one call to ck-bus.
pub const RETRY_MAX: Duration = Duration::from_secs(300);

/// The first wait after a failed round, and the longest.
pub const ROUND_RETRY_FIRST: Duration = Duration::from_secs(2);
pub const ROUND_RETRY_MAX: Duration = Duration::from_secs(60);

/// How long stopping may wait for the task to end.
const STOP_WAIT: Duration = Duration::from_secs(5);

/// Why the task has no hub to work with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// This computer's box id couldn't be learned from the bus.
    NoBox(String),
    /// ck-bus has no hub link, or the vault's federation signer isn't
    /// there yet.
    Unavailable,
    /// ck-bus doesn't grant magic-context the hub.
    NotGranted,
    /// Anything else on the way to a connection.
    Failed(String),
}

/// How long to wait before asking for the hub again, after `attempt`
/// asks in a row were refused (0 for the first): 5 s, doubling to 5 min.
/// A refused grant waits the longest from the start: only a change to
/// ck-bus lifts it.
pub(crate) fn retry_after(refusal: &Refusal, attempt: u32) -> Duration {
    match refusal {
        Refusal::NotGranted => RETRY_MAX,
        _ => RETRY_FIRST
            .saturating_mul(1 << attempt.min(16))
            .min(RETRY_MAX),
    }
}

/// How long to wait before the next round, after `failures` rounds in a
/// row failed (1 for the first): 2 s, doubling to a minute.
pub(crate) fn round_retry(failures: u32) -> Duration {
    ROUND_RETRY_FIRST
        .saturating_mul(1 << failures.saturating_sub(1).min(16))
        .min(ROUND_RETRY_MAX)
}

/// Where the hub connection comes from: ck-bus, or a test's script.
#[async_trait]
pub(crate) trait Connect: Send + Sync {
    /// This computer's box id.
    async fn box_id(&self) -> Result<String, String>;

    /// A connection to the hub.
    async fn connect(&self) -> Result<Box<dyn Link>, Refusal>;
}

/// One connection to the hub, kept up by its credential maintenance.
pub(crate) trait Link: Send + Sync {
    /// The JetStream calls on the current connection.
    fn stream(&self) -> Result<Arc<dyn HubStream>, Refusal>;

    /// Changes when the connection was replaced; closes when the
    /// connection's credential maintenance stopped.
    fn changes(&self) -> watch::Receiver<u64>;
}

/// The hub through ck-bus: the box id from the module's bus account, and a
/// hub connection from the bus client, over ck-mc's SDK consumer.
struct Ckbus {
    consumer: crate::transport::SharedConsumer,
    bus: Arc<crate::bus::Bus>,
}

fn refusal(error: cortexkit_bus_client::Error) -> Refusal {
    match error {
        cortexkit_bus_client::Error::HubUnavailable => Refusal::Unavailable,
        cortexkit_bus_client::Error::HubNotGranted => Refusal::NotGranted,
        other => Refusal::Failed(other.to_string()),
    }
}

#[async_trait]
impl Connect for Ckbus {
    async fn box_id(&self) -> Result<String, String> {
        self.bus.box_id().await
    }

    async fn connect(&self) -> Result<Box<dyn Link>, Refusal> {
        let consumer = Arc::clone(self.consumer.get().await.map_err(Refusal::Failed)?);
        let options = cortexkit_bus_client::BusClientOptions::new(crate::MODULE_ID)
            .map_err(|error| Refusal::Failed(error.to_string()))?;
        let client = cortexkit_bus_client::HubClient::connect(consumer, options)
            .await
            .map_err(refusal)?;
        Ok(Box::new(HubLink(client)))
    }
}

struct HubLink(cortexkit_bus_client::HubClient);

impl Link for HubLink {
    fn stream(&self) -> Result<Arc<dyn HubStream>, Refusal> {
        Ok(Arc::new(JetStream::new(
            self.0.jetstream().map_err(refusal)?,
        )))
    }

    fn changes(&self) -> watch::Receiver<u64> {
        self.0.connection_changes()
    }
}

/// The running task, until it is stopped.
pub struct ReplicaTask {
    stop: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl ReplicaTask {
    pub(crate) fn spawn(live: Live) -> Self {
        let (stop, stopped) = watch::channel(false);
        Self {
            stop,
            handle: tokio::spawn(live.run(stopped)),
        }
    }

    /// Stop the task and wait for it to end, at most [`STOP_WAIT`].
    pub async fn stop(self) {
        let _ = self.stop.send(true);
        let mut handle = self.handle;
        if tokio::time::timeout(STOP_WAIT, &mut handle).await.is_err() {
            handle.abort();
            tracing::warn!("ck-mc: replica: the task did not stop in time and was ended");
        }
    }
}

/// Start the replica task on `db`, in a build with the `memory-replica`
/// feature; `None` without it. Memory changes this computer's writers
/// report wake the task's next round.
pub fn start(
    db: Arc<ContextDb>,
    consumer: crate::transport::SharedConsumer,
    bus: Arc<crate::bus::Bus>,
) -> Option<ReplicaTask> {
    if !super::switch_from_build() {
        return None;
    }
    let wake = Arc::new(Notify::new());
    db.wake_replica_on_memory_changes(Arc::clone(&wake));
    let sealer = super::seal::Claustrum::over(consumer.clone());
    Some(ReplicaTask::spawn(Live {
        connect: Arc::new(Ckbus { consumer, bus }),
        db,
        sealer,
        wake,
    }))
}

/// What the task works with.
pub(crate) struct Live {
    pub(crate) connect: Arc<dyn Connect>,
    pub(crate) db: Arc<ContextDb>,
    pub(crate) sealer: Arc<dyn Sealer>,
    /// Signalled by a memory change on this computer.
    pub(crate) wake: Arc<Notify>,
}

/// Where the task stands, for logging each change once.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Starting,
    NoBox,
    Unavailable,
    NotGranted,
    Failed,
    Connected,
}

/// Logs each change of the task's state once.
struct Reporter {
    phase: Phase,
    /// The reason the last round failed, while rounds keep failing.
    failing: Option<String>,
}

impl Reporter {
    fn new() -> Self {
        Self {
            phase: Phase::Starting,
            failing: None,
        }
    }

    fn refused(&mut self, refusal: &Refusal) {
        let phase = match refusal {
            Refusal::NoBox(_) => Phase::NoBox,
            Refusal::Unavailable => Phase::Unavailable,
            Refusal::NotGranted => Phase::NotGranted,
            Refusal::Failed(_) => Phase::Failed,
        };
        if phase == self.phase {
            return;
        }
        self.phase = phase;
        self.failing = None;
        match refusal {
            Refusal::NoBox(why) => tracing::warn!(
                "ck-mc: replica: this computer's box id is unknown ({why}); memories are not shared and changes wait in the outbox until the bus names it"
            ),
            Refusal::Unavailable => tracing::info!(
                "ck-mc: replica: the hub is not available (no hub link yet, or the vault's federation signer is not there yet); changes wait in the outbox, and ck-bus is asked again"
            ),
            Refusal::NotGranted => tracing::warn!(
                "ck-mc: replica: ck-bus does not grant magic-context the hub; changes wait in the outbox, and ck-bus is asked again every {} minutes",
                RETRY_MAX.as_secs() / 60
            ),
            Refusal::Failed(why) => tracing::warn!(
                "ck-mc: replica: connecting to the hub failed: {why}; changes wait in the outbox, and it is tried again"
            ),
        }
    }

    fn connected(&mut self) {
        if self.phase != Phase::Connected {
            self.phase = Phase::Connected;
            tracing::info!(
                "ck-mc: replica: connected to the hub; this computer follows and publishes the memory stream"
            );
        }
    }

    fn round(&mut self, outcome: &Result<usize, String>) {
        match outcome {
            Ok(_) => {
                if self.failing.take().is_some() {
                    tracing::info!("ck-mc: replica: rounds succeed again");
                }
            }
            Err(error) => {
                if self.failing.as_deref() != Some(error.as_str()) {
                    tracing::warn!("ck-mc: replica: a round failed: {error}; it is tried again");
                    self.failing = Some(error.clone());
                }
            }
        }
    }
}

/// Wait until the task is told to stop, or its handle is gone.
async fn stopped(stop: &mut watch::Receiver<bool>) {
    let _ = stop.wait_for(|stop| *stop).await;
}

/// `work`'s output, or `None` if the task is told to stop first.
async fn unless_stopped<T>(
    stop: &mut watch::Receiver<bool>,
    work: impl std::future::Future<Output = T>,
) -> Option<T> {
    tokio::select! {
        biased;
        () = stopped(stop) => None,
        output = work => Some(output),
    }
}

/// How one connection's rounds ended.
enum Ended {
    Stopped,
    /// The connection was replaced: start again on the new one.
    Replaced,
    /// The connection's credential maintenance stopped.
    Closed,
}

impl Live {
    pub(crate) async fn run(self, mut stop: watch::Receiver<bool>) {
        let mut report = Reporter::new();
        let mut box_id: Option<String> = None;
        let mut attempt = 0;
        loop {
            let refusal = match unless_stopped(&mut stop, self.connect(&mut box_id)).await {
                None => return,
                Some(Err(refusal)) => refusal,
                Some(Ok((box_id, link))) => {
                    attempt = 0;
                    match self
                        .serve(&box_id, link.as_ref(), &mut report, &mut stop)
                        .await
                    {
                        None => return,
                        Some(refusal) => refusal,
                    }
                }
            };
            report.refused(&refusal);
            let pause = retry_after(&refusal, attempt);
            attempt = attempt.saturating_add(1);
            if unless_stopped(&mut stop, tokio::time::sleep(pause))
                .await
                .is_none()
            {
                return;
            }
        }
    }

    /// The box id, learned once, and a hub connection.
    async fn connect(
        &self,
        box_id: &mut Option<String>,
    ) -> Result<(String, Box<dyn Link>), Refusal> {
        let id = match box_id {
            Some(id) => id.clone(),
            None => {
                let id = self.connect.box_id().await.map_err(Refusal::NoBox)?;
                box_id.insert(id).clone()
            }
        };
        Ok((id, self.connect.connect().await?))
    }

    /// Run rounds on `link` until the task is told to stop (`None`) or the
    /// link ends, with what refused it.
    async fn serve(
        &self,
        box_id: &str,
        link: &dyn Link,
        report: &mut Reporter,
        stop: &mut watch::Receiver<bool>,
    ) -> Option<Refusal> {
        let mut changes = link.changes();
        changes.borrow_and_update();
        loop {
            let stream = match link.stream() {
                Ok(stream) => stream,
                Err(refusal) => return Some(refusal),
            };
            report.connected();
            let hub = Arc::new(NatsHub::new(stream));
            let replica = Replica::new(
                Arc::clone(&self.db),
                Arc::clone(&hub) as Arc<dyn Hub>,
                Arc::clone(&self.sealer),
                box_id.to_owned(),
            );
            let ended = self
                .rounds(&replica, &hub, report, &mut changes, stop)
                .await;
            hub.close().await;
            match ended {
                Ended::Stopped => return None,
                Ended::Replaced => {
                    tracing::debug!("ck-mc: replica: the hub connection was replaced");
                }
                Ended::Closed => {
                    return Some(link.stream().err().unwrap_or_else(|| {
                        Refusal::Failed(
                            "the hub connection's credential maintenance stopped".into(),
                        )
                    }))
                }
            }
        }
    }

    /// Rounds on one connection until it is replaced or closed, or the
    /// task is told to stop.
    async fn rounds(
        &self,
        replica: &Replica,
        hub: &NatsHub,
        report: &mut Reporter,
        changes: &mut watch::Receiver<u64>,
        stop: &mut watch::Receiver<bool>,
    ) -> Ended {
        let ended = |changed: Result<(), watch::error::RecvError>| match changed {
            Ok(()) => Ended::Replaced,
            Err(_) => Ended::Closed,
        };
        let mut failures = 0;
        loop {
            let outcome = tokio::select! {
                biased;
                () = stopped(stop) => return Ended::Stopped,
                changed = changes.changed() => return ended(changed),
                outcome = replica.round() => outcome,
            };
            report.round(&outcome);
            // After a failed round only time brings the next one, so a
            // stream that stays full or a store that stays busy is not
            // retried at the pace of local writes.
            let retry = match outcome {
                Ok(0) => {
                    failures = 0;
                    None
                }
                Ok(_) => {
                    failures = 0;
                    continue;
                }
                Err(_) => {
                    failures += 1;
                    Some(round_retry(failures))
                }
            };
            tokio::select! {
                biased;
                () = stopped(stop) => return Ended::Stopped,
                changed = changes.changed() => return ended(changed),
                () = self.wake.notified(), if retry.is_none() => {}
                () = hub.arrival(), if retry.is_none() => {}
                () = tokio::time::sleep(retry.unwrap_or(IDLE)) => {}
            }
        }
    }
}
