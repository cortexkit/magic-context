//! Following Entorhinal's change markers. Entorhinal keeps a KV bucket on the
//! bus, `entorhinal.changes`, that magic-context may read. Its key `registry`
//! holds `{"generation": N, "incarnation": "…"}` and changes whenever a
//! project, workspace, root, binding, approval or placement changes.
//!
//! [`spawn_marker`] watches that key. Each new value makes ck-mc read again
//! what it reads from Entorhinal: each live session's `context.project`, for the
//! workspace its project is in now ([`crate::session::Session::follow_workspace`]),
//! and a round of the move of 0.49 project rows ([`crate::legacy_projects`]).
//! A watch delivers the key's current value when it starts, so a value that
//! changed while the watch was down is caught when it comes back.
//!
//! The watch only adds reads. Without it (no bus, ck-bus not installed, or a
//! lost connection) everything runs as it does anyway: the workspace is read
//! at each Setup, and the legacy rounds run at start, on a new project id and
//! hourly. A watch that can't start or ends is tried again after a growing
//! pause. Planned moves log at DEBUG, a watch coming up or recovering at
//! INFO, and an outage or slow move at WARN.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use cortexkit_bus_trait::{RegisterEntry, RegisterUpdate, RegisterWatch, Revision, WatchEvent};
use tokio::sync::{oneshot, watch};
use tokio::task::JoinSet;
use tokio::time::Instant;

use crate::bus::{Bus, BusGeneration, SHUTTING_DOWN};

/// The module that writes the bucket, the bucket's name, and the key.
pub(crate) const OWNER: &str = "entorhinal";
pub(crate) const BUCKET: &str = "changes";
pub(crate) const KEY: &str = "registry";

/// The first pause before trying the watch again; each further try waits
/// twice as long, up to [`RETRY_CAP`]. A watch that came up starts over.
pub(crate) const RETRY_FIRST: Duration = Duration::from_secs(5);
pub(crate) const RETRY_CAP: Duration = Duration::from_secs(5 * 60);
const SLOW_HANDOFF: Duration = Duration::from_secs(5);

/// The watch's progress survives even when its task unwinds.
struct Progress {
    down_reported: bool,
    last: Option<(Revision, Vec<u8>)>,
    snapshot_generation: Option<u64>,
    current_generation: Option<watch::Receiver<Option<BusGeneration>>>,
    retry: Duration,
}

impl Default for Progress {
    fn default() -> Self {
        Self {
            down_reported: false,
            last: None,
            snapshot_generation: None,
            current_generation: None,
            retry: RETRY_FIRST,
        }
    }
}

impl Progress {
    fn is_up(&self) -> bool {
        self.current_generation.as_ref().is_some_and(|current| {
            current
                .borrow()
                .is_some_and(|current| Some(current.id) == self.snapshot_generation)
        })
    }
}

/// Whether the watch is up, and where to resume if it goes down.
#[derive(Default)]
pub(crate) struct WatchState {
    progress: Mutex<Progress>,
    /// What the log lines say a change of the marker does, for a marker
    /// other than [`KEY`]; `None` for the registry marker.
    effect: Option<&'static str>,
}

impl WatchState {
    /// The state of a watch on another marker than [`KEY`], whose change
    /// does `effect` (said in the log lines).
    pub(crate) fn for_marker(effect: &'static str) -> Self {
        Self {
            effect: Some(effect),
            ..Self::default()
        }
    }

    /// Whether the watch is up now.
    #[cfg(test)]
    pub(crate) fn is_up(&self) -> bool {
        self.progress.lock().expect("watch state").is_up()
    }

    /// The watch is up.
    fn up(&self, key: &str, generation: u64, planned: bool) {
        let came_up = {
            let mut progress = self.progress.lock().expect("watch state");
            let was_up = progress.is_up();
            progress.snapshot_generation = Some(generation);
            let is_up = progress.is_up();
            if is_up {
                progress.retry = RETRY_FIRST;
                progress.down_reported = false;
            }
            !was_up && is_up
        };
        if !came_up {
            return;
        }
        if planned {
            tracing::debug!(%key, generation, "ck-mc: entorhinal changes: marker watch moved to the replacement connection");
            tracing::debug!(%key, "ck-mc: entorhinal changes: watching the marker again");
        } else {
            match self.effect {
                None => tracing::info!(
                    "ck-mc: entorhinal changes: watching the registry marker; workspaces and legacy project rows are read again when it changes"
                ),
                Some(effect) => tracing::info!(%effect, "ck-mc: entorhinal changes: watching a marker"),
            }
        }
    }

    /// The watch couldn't start or ended, because of `why`.
    fn down(&self, why: &str) {
        let already_reported = self.mark_down();
        if why == SHUTTING_DOWN {
            tracing::debug!(
                "ck-mc: entorhinal changes: not opening a marker watch during shutdown"
            );
        } else if !already_reported {
            match self.effect {
                None => tracing::warn!(
                    reason = %why,
                    "ck-mc: entorhinal changes: no watch on the registry marker; workspaces are read at each Setup and legacy project rounds run hourly, and the watch is tried again"
                ),
                Some(effect) => tracing::warn!(
                    reason = %why,
                    %effect,
                    "ck-mc: entorhinal changes: no watch on a marker; it is tried again, and meanwhile its work waits for the timer"
                ),
            }
        }
    }

    fn mark_down(&self) -> bool {
        let mut progress = self.progress.lock().expect("watch state");
        progress.snapshot_generation = None;
        std::mem::replace(&mut progress.down_reported, true)
    }

    fn observe(&self, entry: Option<RegisterEntry>, snapshot: bool) -> bool {
        let mut progress = self.progress.lock().expect("watch state");
        let Some(entry) = entry else {
            return progress.last.take().is_some();
        };
        let same = progress.last.as_ref().is_some_and(|(revision, value)| {
            value == &entry.value && (!snapshot || *revision == entry.revision)
        });
        // An identical live put needs no reread. Remember its revision so an
        // unchanged snapshot after renewal doesn't cause a duplicate reread.
        progress.last = Some((entry.revision, entry.value));
        !same
    }

    fn next_retry(&self) -> Duration {
        backoff(&mut self.progress.lock().expect("watch state").retry)
    }
}

/// Capture the watch's binding under the session lock. Release it before
/// reading the bucket so the module's other bus users can publish and read meanwhile.
async fn open(bus: &Bus, key: &str) -> Result<(Box<dyn RegisterWatch>, u64), WatchFailure> {
    let attempted = bus.generation();
    let (bucket, generation) = {
        let (session, generation) =
            bus.session_with_generation()
                .await
                .map_err(|reason| WatchFailure {
                    reason,
                    generation: attempted,
                })?;
        let bucket = session
            .register_bucket(OWNER, BUCKET)
            .map_err(|reason| WatchFailure { reason, generation })?;
        (bucket, generation)
    };
    match bucket.watch(key).await {
        Ok(watch) => Ok((watch, generation)),
        Err(reason) => {
            if reason == "nats_watch_failed" {
                bus.forget(generation).await;
            }
            Err(WatchFailure { reason, generation })
        }
    }
}

async fn open_ready(
    bus: &Bus,
    key: &str,
    generations: &watch::Receiver<Option<BusGeneration>>,
    previous: Option<BusGeneration>,
) -> Result<(Box<dyn RegisterWatch>, BusGeneration, WatchEvent), WatchFailure> {
    loop {
        let (mut marker, generation) = open(bus, key).await?;
        // NATS reads the snapshot in watch(), so next() takes the result
        // already buffered in the newly opened watch.
        let Ok(snapshot @ WatchEvent::Snapshot { .. }) = marker.next().await else {
            return Err(
                ended_watch(bus, generation, "register watch ended before its snapshot").await,
            );
        };
        match (previous, *generations.borrow()) {
            (Some(old), Some(current)) if old.continuity != current.continuity => {
                return Err(discarded_handoff(old.id));
            }
            (_, Some(current)) if current.id == generation => {
                return Ok((marker, current, snapshot))
            }
            (_, Some(_)) => continue,
            (_, None) => return Err(discarded_handoff(generation)),
        }
    }
}

fn discarded_handoff(generation: u64) -> WatchFailure {
    WatchFailure {
        reason: "bus session discarded while opening register watch".into(),
        generation,
    }
}

async fn ended_watch(bus: &Bus, generation: u64, reason: &'static str) -> WatchFailure {
    bus.forget(generation).await;
    WatchFailure {
        reason: reason.into(),
        generation,
    }
}

/// Owns a marker watch. Dropping the handle stops it, including any pending reopen.
#[must_use = "dropping this handle stops the marker watch"]
pub struct MarkerTask {
    _stop: oneshot::Sender<()>,
}

/// Follow `key`, calling `changed` when the value differs from the last one seen.
/// The supervisor joins the watch task so it can recover even from a panic.
pub(crate) fn spawn_marker(
    bus: Arc<Bus>,
    state: Arc<WatchState>,
    key: &'static str,
    changed: impl Fn() + Send + Sync + 'static,
) -> MarkerTask {
    let (stop, mut stopped) = oneshot::channel();
    let changed = Arc::new(changed);
    state
        .progress
        .lock()
        .expect("watch state")
        .current_generation = Some(bus.generations());
    tokio::spawn(async move {
        let mut tasks = JoinSet::new();
        while matches!(stopped.try_recv(), Err(oneshot::error::TryRecvError::Empty)) {
            tasks.spawn({
                let (bus, state, changed) = (bus.clone(), state.clone(), changed.clone());
                async move { run_marker(&bus, &state, key, &*changed).await }
            });
            // Shutdown wins if the stop and the task's exit arrive together.
            let result = tokio::select! {
                biased;
                _ = &mut stopped => break,
                result = tasks.join_next() => result.expect("one marker task"),
            };
            let reason = match result {
                Ok(()) => "returned ()".to_owned(),
                Err(error) => error.to_string(),
            };
            state.mark_down();
            tracing::warn!(
                %key,
                %reason,
                "ck-mc: entorhinal changes: marker task ended; reopening after backoff"
            );
            tokio::select! {
                biased;
                _ = &mut stopped => break,
                () = retry(&bus, &state, bus.generation()) => {}
            }
        }
        tasks.shutdown().await;
        state.mark_down();
    });
    MarkerTask { _stop: stop }
}

async fn run_marker(bus: &Bus, state: &WatchState, key: &str, changed: &(impl Fn() + Sync)) {
    loop {
        let error = follow(bus, state, key, changed).await.unwrap_err();
        state.down(&error.reason);
        retry(bus, state, error.generation).await;
    }
}

#[derive(Debug)]
struct WatchFailure {
    reason: String,
    generation: u64,
}

async fn retry(bus: &Bus, state: &WatchState, failed_generation: u64) {
    let mut generations = bus.generations();
    tokio::select! {
        () = tokio::time::sleep(state.next_retry()) => {}
        _ = replacement(&mut generations, failed_generation) => {}
    }
}

async fn follow(
    bus: &Bus,
    state: &WatchState,
    key: &str,
    changed: &(impl Fn() + Sync),
) -> Result<std::convert::Infallible, WatchFailure> {
    let mut generations = bus.generations();
    let (mut marker, mut generation, snapshot) = open_ready(bus, key, &generations, None).await?;
    state.up(key, generation.id, false);
    observe(state, key, snapshot, changed);
    loop {
        let replacement = tokio::select! {
            biased;
            replacement = replacement(&mut generations, generation.id) => replacement,
            event = marker.next() => match event {
                Ok(event) => {
                    observe(state, key, event, changed);
                    continue;
                }
                Err(_) => return Err(ended_watch(bus, generation.id, "register watch ended").await),
            },
        };
        if replacement.continuity != generation.continuity {
            return Err(discarded_handoff(generation.id));
        }
        // Read the replacement snapshot before dropping the old watch, then
        // take later updates from the new subscription.
        let (next, new_generation, snapshot) = trace_handoff(
            key,
            replacement.installed,
            open_ready(bus, key, &generations, Some(generation)),
        )
        .await?;
        state.up(key, new_generation.id, true);
        observe(state, key, snapshot, changed);
        marker = next;
        generation = new_generation;
    }
}

async fn trace_handoff<F: std::future::Future>(
    key: &str,
    started: Instant,
    opened: F,
) -> F::Output {
    tokio::pin!(opened);
    tokio::select! {
        biased;
        () = tokio::time::sleep_until(started + SLOW_HANDOFF) => {
            log_slow_handoff(key, started.elapsed());
            opened.await
        }
        result = &mut opened => result,
    }
}

fn log_slow_handoff(key: &str, elapsed: Duration) {
    tracing::warn!(%key, elapsed_ms = elapsed.as_millis(), "ck-mc: entorhinal changes: marker watch handoff is taking longer than expected");
}

async fn replacement(
    generations: &mut watch::Receiver<Option<BusGeneration>>,
    generation: u64,
) -> BusGeneration {
    generations
        .wait_for(|current| current.is_some_and(|current| current.id != generation))
        .await
        .expect("the bus still owns its generation sender")
        .expect("a replacement is installed")
}

fn observe(state: &WatchState, key: &str, event: WatchEvent, changed: &(impl Fn() + Sync)) {
    let (entry, snapshot) = match event {
        WatchEvent::Snapshot { entries, .. } => {
            (entries.into_iter().find(|entry| entry.key == key), true)
        }
        WatchEvent::Update(RegisterUpdate::Put(entry)) if entry.key == key => (Some(entry), false),
        WatchEvent::Update(RegisterUpdate::Delete(entry)) if entry.key == key => (None, false),
        WatchEvent::Update(_) => return,
    };
    if state.observe(entry, snapshot) {
        changed();
    }
}

/// The pause before the next try, and the one after it.
fn backoff(retry: &mut Duration) -> Duration {
    let pause = *retry;
    *retry = (*retry * 2).min(RETRY_CAP);
    pause
}

#[cfg(test)]
#[path = "entorhinal_changes_tests.rs"]
pub(crate) mod tests;
