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

use cortexkit_bus_trait::{RegisterUpdate, RegisterWatch, WatchEvent};
use tokio::sync::oneshot;
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
    last: Option<Vec<u8>>,
    retry: Duration,
}

impl Default for Progress {
    fn default() -> Self {
        Self {
            up: None,
            last: None,
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
        self.progress.lock().expect("watch state").up == Some(true)
    }

    /// The watch is up.
    fn up(&self) {
        let previous = {
            let mut progress = self.progress.lock().expect("watch state");
            progress.retry = RETRY_FIRST;
            progress.up.replace(true)
        };
        if previous != Some(true) {
            match self.effect {
                None => tracing::info!(
                    "ck-mc: entorhinal changes: watching the registry marker; workspaces and legacy project rows are read again when it changes"
                ),
                Some(effect) => tracing::info!(
                    "ck-mc: entorhinal changes: watching a marker; when it changes, {effect}"
                ),
            }
        }
    }

    /// The watch couldn't start or ended, because of `why`.
    fn down(&self, why: &str) {
        if self.mark_down() != Some(false) {
            match self.effect {
                None => tracing::info!(
                    "ck-mc: entorhinal changes: no watch on the registry marker ({why}); workspaces are read at each Setup and legacy project rounds run hourly, and the watch is tried again"
                ),
                Some(effect) => tracing::info!(
                    "ck-mc: entorhinal changes: no watch on a marker ({why}); it is tried again, and meanwhile what it would do ({effect}) waits for its timer"
                ),
            }
        }
    }

    fn mark_down(&self) -> Option<bool> {
        self.progress.lock().expect("watch state").up.replace(false)
    }

    fn next_retry(&self) -> Duration {
        backoff(&mut self.progress.lock().expect("watch state").retry)
    }
}

/// Start the watch: open the bus session and watch `key`. A watch the bus
/// refused leaves the session to the others that use it; any other failure
/// drops it, since its connection may be gone.
async fn open(bus: &Bus, key: &str) -> Result<Box<dyn RegisterWatch>, String> {
    let session = bus.session().await?;
    match session.watch(OWNER, BUCKET, key).await {
        Ok(watch) => Ok(watch),
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
                "ck-mc: entorhinal changes: marker task for {key} ended ({reason}); reopening after backoff"
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
        match open(bus, key).await {
            Err(error) => state.down(&error),
            Ok(mut watch) => {
                let ended = loop {
                    let value = match watch.next().await {
                        Ok(WatchEvent::Snapshot { entries, .. }) => {
                            state.up();
                            entries
                                .into_iter()
                                .find(|entry| entry.key == key)
                                .map(|entry| entry.value)
                        }
                        Ok(WatchEvent::Update(RegisterUpdate::Put(entry))) if entry.key == key => {
                            Some(entry.value)
                        }
                        Ok(WatchEvent::Update(_)) => None,
                        Err(_) => break "register watch ended",
                    };
                    let is_new = value.is_some_and(|value| {
                        let mut progress = state.progress.lock().expect("watch state");
                        if progress.last.as_ref() == Some(&value) {
                            return false;
                        }
                        progress.last = Some(value);
                        true
                    });
                    if is_new {
                        changed();
                    }
                };
                // The watch's connection is likely the shared one, and gone.
                bus.discard().await;
                state.down(ended);
            }
        }
        tokio::time::sleep(state.next_retry()).await;
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
