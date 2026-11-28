//! Close replaced bus sockets without holding the current session lock.

use std::sync::Mutex;
use std::time::Duration;

use cortexkit_bus_nats::{CloseOutcome, NatsConnection};
use tokio::runtime::Handle;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::Instant;

// A run-end pull has a two-second server expiry. The registry and fleet
// epoch snapshots and a run-end rebind and acknowledgement took under
// ten milliseconds in the loopback test. Give them two more seconds.
const GRACE: Duration = Duration::from_secs(4);
const CLOSE_TRY: Duration = Duration::from_secs(1);
const CLOSE_BUDGET: Duration = Duration::from_secs(10);
const EXPIRY_MARGIN: Duration = Duration::from_secs(30);

pub(super) struct Retirements {
    runtime: Option<Handle>,
    stopping: watch::Sender<bool>,
    jobs: Mutex<Vec<JoinHandle<()>>>,
}

impl Retirements {
    pub(super) fn new() -> Self {
        Self {
            runtime: Handle::try_current().ok(),
            stopping: watch::channel(false).0,
            jobs: Mutex::default(),
        }
    }

    pub(super) fn park(&self, connection: NatsConnection, expires: i64) {
        let remaining = expires.saturating_sub(super::now_ms() / 1000);
        self.defer(
            Duration::from_secs(remaining.max(0) as u64),
            move |deadline| close_socket(connection, deadline),
        );
    }

    fn defer<F, Close>(&self, remaining: Duration, close: Close)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
        Close: FnOnce(Instant) -> F + Send + 'static,
    {
        let mut jobs = self.jobs.lock().expect("retiring bus jobs");
        // A retirement owns its socket during grace and close retries,
        // normally at most fourteen seconds from parking. Reap completed
        // jobs on the next park or on shutdown.
        jobs.retain(|job| !job.is_finished());
        let mut stop = self.stopping.subscribe();
        let stopping = *stop.borrow();
        let now = Instant::now();
        let safe_time = remaining.saturating_sub(EXPIRY_MARGIN);
        let grace = now + GRACE.min(safe_time.saturating_sub(CLOSE_BUDGET));
        let deadline = now + safe_time;
        let close = async move {
            if !stopping {
                tokio::select! {
                    () = tokio::time::sleep_until(grace) => {}
                    _ = stop.changed() => {}
                }
            }
            close(deadline).await;
        };
        let task = match &self.runtime {
            Some(runtime) => runtime.spawn(close),
            None => tokio::spawn(close),
        };
        jobs.push(task);
    }

    pub(super) fn is_stopping(&self) -> bool {
        *self.stopping.borrow()
    }

    pub(super) async fn finish(&self) {
        let jobs = {
            let mut jobs = self.jobs.lock().expect("retiring bus jobs");
            self.stopping.send_replace(true);
            std::mem::take(&mut *jobs)
        };
        for task in jobs {
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    fn observe_close(
        retirements: &Retirements,
        remaining: Duration,
    ) -> oneshot::Receiver<(Instant, Instant)> {
        let (close, closed) = oneshot::channel();
        retirements.defer(remaining, move |deadline| async move {
            close.send((Instant::now(), deadline)).unwrap();
        });
        closed
    }

    #[tokio::test(start_paused = true)]
    async fn two_retirements_close_at_their_own_deadlines() {
        let retirements = Retirements::new();
        let start = Instant::now();
        let first = observe_close(&retirements, Duration::from_secs(60));
        tokio::time::sleep(Duration::from_secs(1)).await;
        let second_started = Instant::now();
        let mut second = observe_close(&retirements, Duration::from_secs(60));
        assert_eq!(first.await.unwrap().0, start + Duration::from_secs(4));
        assert!(matches!(
            second.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert_eq!(
            second.await.unwrap().0,
            second_started + Duration::from_secs(4)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_park_after_shutdown_starts_skips_grace() {
        let retirements = Retirements::new();
        retirements.finish().await;
        let start = Instant::now();
        let closed = observe_close(&retirements, Duration::from_secs(60));
        assert_eq!(closed.await.unwrap().0, start);
    }

    #[tokio::test(start_paused = true)]
    async fn near_expiry_the_grace_leaves_room_for_closure_and_the_expiry_margin() {
        let retirements = Retirements::new();
        let start = Instant::now();
        let (closed, deadline) = observe_close(&retirements, Duration::from_secs(42))
            .await
            .unwrap();
        assert_eq!(closed, start + Duration::from_secs(2));
        assert_eq!(deadline, start + Duration::from_secs(12));
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_expedites_all_retirements_and_awaits_their_closes() {
        let retirements = Retirements::new();
        let start = Instant::now();
        let (close, closing) = oneshot::channel();
        let (release, released) = oneshot::channel();
        retirements.defer(Duration::from_secs(60), move |_| async move {
            close.send(Instant::now()).unwrap();
            released.await.unwrap();
        });
        let second = observe_close(&retirements, Duration::from_secs(60));
        let finish = retirements.finish();
        tokio::pin!(finish);
        tokio::select! {
            biased;
            () = &mut finish => panic!("shutdown returned with a close pending"),
            first = closing => assert_eq!(first.unwrap(), start),
        }
        assert_eq!(second.await.unwrap().0, start);
        release.send(()).unwrap();
        finish.await;
    }
}
