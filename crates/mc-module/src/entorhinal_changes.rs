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
//! pause. Ordinary connection changes are logged at INFO; an unexpected
//! task exit is logged at WARN before restarting the task.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use cortexkit_bus_trait::{RegisterEntry, RegisterUpdate, RegisterWatch, Revision, WatchEvent};
use tokio::sync::{oneshot, watch};
use tokio::task::JoinSet;

use crate::bus::Bus;

/// The module that writes the bucket, the bucket's name, and the key.
pub(crate) const OWNER: &str = "entorhinal";
pub(crate) const BUCKET: &str = "changes";
pub(crate) const KEY: &str = "registry";

/// The first pause before trying the watch again; each further try waits
/// twice as long, up to [`RETRY_CAP`]. A watch that came up starts over.
pub(crate) const RETRY_FIRST: Duration = Duration::from_secs(5);
pub(crate) const RETRY_CAP: Duration = Duration::from_secs(5 * 60);

/// The watch's progress survives even when its task unwinds.
struct Progress {
    /// `None` until the first try; then whether the watch is up.
    up: Option<bool>,
    last: Option<(Revision, Vec<u8>)>,
    snapshot_generation: Option<u64>,
    current_generation: Option<watch::Receiver<Option<u64>>>,
    retry: Duration,
}

impl Default for Progress {
    fn default() -> Self {
        Self {
            up: None,
            last: None,
            snapshot_generation: None,
            current_generation: None,
            retry: RETRY_FIRST,
        }
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
        let progress = self.progress.lock().expect("watch state");
        progress.up == Some(true)
            && progress.current_generation.as_ref().is_some_and(|current| {
                *current.borrow() == progress.snapshot_generation
                    && progress.snapshot_generation.is_some()
            })
    }

    /// The watch is up.
    fn up(&self, generation: u64) {
        let previous = {
            let mut progress = self.progress.lock().expect("watch state");
            progress.retry = RETRY_FIRST;
            progress.snapshot_generation = Some(generation);
            progress.up.replace(true)
        };
        if previous != Some(true) {
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
        if self.mark_down() != Some(false) {
            match self.effect {
                None => tracing::info!(
                    reason = %why,
                    "ck-mc: entorhinal changes: no watch on the registry marker; workspaces are read at each Setup and legacy project rounds run hourly, and the watch is tried again"
                ),
                Some(effect) => tracing::info!(
                    reason = %why,
                    %effect,
                    "ck-mc: entorhinal changes: no watch on a marker; it is tried again, and meanwhile its work waits for the timer"
                ),
            }
        }
    }

    fn mark_down(&self) -> Option<bool> {
        let mut progress = self.progress.lock().expect("watch state");
        progress.snapshot_generation = None;
        progress.up.replace(false)
    }

    fn observe(&self, entry: RegisterEntry, snapshot: bool) -> bool {
        let mut progress = self.progress.lock().expect("watch state");
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

/// Start the watch: open the bus session and watch `key`. A watch the bus
/// refused leaves the session to the others that use it; any other failure
/// drops it, since its connection may be gone.
async fn open(bus: &Bus, key: &str) -> Result<(Box<dyn RegisterWatch>, u64), String> {
    let (session, generation) = bus.session_with_generation().await?;
    match session.watch(OWNER, BUCKET, key).await {
        Ok(watch) => Ok((watch, generation)),
        Err(error) => {
            if error == "nats_watch_failed" {
                session.discard();
            }
            Err(error)
        }
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
                _ = tokio::time::sleep(state.next_retry()) => {}
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
        state.down(&error);
        tokio::time::sleep(state.next_retry()).await;
    }
}

async fn follow(
    bus: &Bus,
    state: &WatchState,
    key: &str,
    changed: &(impl Fn() + Sync),
) -> Result<std::convert::Infallible, String> {
    let mut generations = bus.generations();
    let (mut marker, mut generation) = open(bus, key).await?;
    loop {
        tokio::select! {
            biased;
            _ = replacement(&mut generations, generation) => {
                loop {
                    let (mut next, new_generation) = open(bus, key).await?;
                    let snapshot = tokio::select! {
                        biased;
                        _ = replacement(&mut generations, new_generation) => continue,
                        event = next.next() => event,
                    };
                    let Ok(snapshot @ WatchEvent::Snapshot { .. }) = snapshot else {
                        if bus.forget(new_generation).await {
                            return Err("register watch ended before its snapshot".into());
                        }
                        continue;
                    };
                    // A marker requests a reread of current state. Read
                    // the replacement snapshot while the old watch is
                    // still subscribed, then take any later updates there.
                    observe(state, key, new_generation, snapshot, changed);
                    marker = next;
                    generation = new_generation;
                    break;
                }
            }
            event = marker.next() => match event {
                Ok(event) => observe(state, key, generation, event, changed),
                Err(_) => {
                    if bus.forget(generation).await {
                        return Err("register watch ended".into());
                    }
                }
            },
        }
    }
}

async fn replacement(generations: &mut watch::Receiver<Option<u64>>, generation: u64) {
    let _ = generations
        .wait_for(|current| current.is_some_and(|current| current != generation))
        .await;
}

fn observe(
    state: &WatchState,
    key: &str,
    generation: u64,
    event: WatchEvent,
    changed: &(impl Fn() + Sync),
) {
    let (entry, snapshot) = match event {
        WatchEvent::Snapshot { entries, .. } => {
            state.up(generation);
            (entries.into_iter().find(|entry| entry.key == key), true)
        }
        WatchEvent::Update(RegisterUpdate::Put(entry)) if entry.key == key => (Some(entry), false),
        WatchEvent::Update(_) => (None, false),
    };
    if entry.is_some_and(|entry| state.observe(entry, snapshot)) {
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
