//! Close replaced bus sockets without holding the current session lock.

use std::sync::Mutex;
use std::time::Duration;

use cortexkit_bus_nats::{CloseOutcome, NatsConnection};
use tokio::runtime::Handle;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::Instant;

// A run-end pull has a two-second server expiry. The registry and fleet
// epoch snapshots and a run-end rebind and acknowledgement took under
// ten milliseconds in the loopback test. Give them two more seconds.
const GRACE: Duration = Duration::from_secs(4);
const CLOSE_TRY: Duration = Duration::from_secs(1);
const CLOSE_BUDGET: Duration = Duration::from_secs(10);
const EXPIRY_MARGIN_S: i64 = 30;

pub(super) struct Retirements {
    runtime: Option<Handle>,
    slot: Mutex<Slot>,
}

#[derive(Default)]
struct Slot {
    stopping: bool,
    pending: Option<Retiring>,
}

struct Retiring {
    hurry: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

impl Retiring {
    fn expedite(self) -> JoinHandle<()> {
        let _ = self.hurry.send(());
        self.task
    }
}

impl Retirements {
    pub(super) fn new() -> Self {
        Self {
            runtime: Handle::try_current().ok(),
            slot: Mutex::default(),
        }
    }

    pub(super) fn park(&self, connection: NatsConnection, expires: i64) {
        let mut slot = self.slot.lock().expect("retiring bus slot");
        let previous = slot.pending.take().map(Retiring::expedite);
        let (hurry, expedited) = oneshot::channel();
        let now = Instant::now();
        let remaining = expires.saturating_sub(super::now_ms() / 1000);
        let safe_time =
            Duration::from_secs(remaining.saturating_sub(EXPIRY_MARGIN_S).max(0) as u64);
        let grace = now + GRACE.min(safe_time.saturating_sub(CLOSE_BUDGET));
        let deadline = now + safe_time;
        let stopping = slot.stopping;
        let close = async move {
            if let Some(older) = previous {
                let _ = older.await;
            }
            if !stopping {
                tokio::select! {
                    () = tokio::time::sleep_until(grace) => {}
                    _ = expedited => {}
                }
            }
            close_socket(connection, deadline).await;
        };
        let task = match &self.runtime {
            Some(runtime) => runtime.spawn(close),
            None => tokio::spawn(close),
        };
        slot.pending = Some(Retiring { hurry, task });
    }

    pub(super) fn is_stopping(&self) -> bool {
        self.slot.lock().expect("retiring bus slot").stopping
    }

    pub(super) async fn finish(&self) {
        let pending = {
            let mut slot = self.slot.lock().expect("retiring bus slot");
            slot.stopping = true;
            slot.pending.take().map(Retiring::expedite)
        };
        if let Some(task) = pending {
            let _ = task.await;
        }
    }
}

async fn close_socket(connection: NatsConnection, deadline: Instant) {
    let now = Instant::now();
    let deadline = deadline.min(now + CLOSE_BUDGET);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if matches!(
            connection.close(CLOSE_TRY.min(remaining)).await,
            Ok(CloseOutcome::Closed)
        ) {
            tracing::debug!("ck-mc: bus: retired the previous connection");
            return;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            tracing::warn!("ck-mc: bus: could not confirm retirement of the previous connection");
            return;
        }
        tokio::time::sleep(remaining.min(CLOSE_TRY)).await;
    }
}
