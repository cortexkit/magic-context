//! Following Entorhinal's change markers. Entorhinal keeps a KV bucket on the
//! bus, `entorhinal.changes`, that magic-context may read. Its key `registry`
//! holds `{"generation": N, "incarnation": "…"}` and changes whenever a
//! project, workspace, root, binding, approval or placement changes.
//!
//! [`run`] watches that key. Each new value makes ck-mc read again what it
//! reads from Entorhinal: each live session's `context.project`, for the
//! workspace its project is in now ([`crate::session::Session::follow_workspace`]),
//! and a round of the move of 0.49 project rows ([`crate::legacy_projects`]).
//! A watch delivers the key's current value when it starts, so a value that
//! changed while the watch was down is caught when it comes back.
//!
//! The watch only adds reads. Without it (no bus, ck-bus not installed, or a
//! lost connection) everything runs as it does anyway: the workspace is read
//! at each Setup, and the legacy rounds run at start, on a new project id and
//! hourly. A watch that can't start or ends is tried again after a growing
//! pause, and each change between up and down is logged once at INFO.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use cortexkit_bus_trait::{RegisterUpdate, RegisterWatch, WatchEvent};

use crate::bus::Bus;

/// The module that writes the bucket, the bucket's name, and the key.
pub(crate) const OWNER: &str = "entorhinal";
pub(crate) const BUCKET: &str = "changes";
pub(crate) const KEY: &str = "registry";

/// The first pause before trying the watch again; each further try waits
/// twice as long, up to [`RETRY_CAP`]. A watch that came up starts over.
pub(crate) const RETRY_FIRST: Duration = Duration::from_secs(5);
pub(crate) const RETRY_CAP: Duration = Duration::from_secs(5 * 60);

/// Whether the watch is up, as last logged.
#[derive(Default)]
pub(crate) struct WatchState {
    /// `None` until the first try; then whether the watch is up.
    up: Mutex<Option<bool>>,
}

impl WatchState {
    /// Whether the watch is up now.
    #[cfg(test)]
    pub(crate) fn is_up(&self) -> bool {
        *self.up.lock().expect("watch state") == Some(true)
    }

    /// The watch is up.
    fn up(&self) {
        if self.up.lock().expect("watch state").replace(true) != Some(true) {
            tracing::info!(
                "ck-mc: entorhinal changes: watching the registry marker; workspaces and legacy project rows are read again when it changes"
            );
        }
    }

    /// The watch couldn't start or ended, because of `why`.
    fn down(&self, why: &str) {
        if self.up.lock().expect("watch state").replace(false) != Some(false) {
            tracing::info!(
                "ck-mc: entorhinal changes: no watch on the registry marker ({why}); workspaces are read at each Setup and legacy project rounds run hourly, and the watch is tried again"
            );
        }
    }
}

/// Start the watch: open the bus session and watch [`KEY`]. A watch the bus
/// refused leaves the session to the others that use it; any other failure
/// drops it, since its connection may be gone.
async fn open(bus: &Bus) -> Result<Box<dyn RegisterWatch>, String> {
    let session = bus.session().await?;
    match session.watch(OWNER, BUCKET, KEY).await {
        Ok(watch) => Ok(watch),
        Err(error) => {
            if error == "nats_watch_failed" {
                session.discard();
            }
            Err(error)
        }
    }
}

/// Follow [`KEY`] through `bus` for good, calling `changed` for each value
/// that differs from the last one seen, the first one included. `state`
/// tells whether the watch is up.
pub(crate) async fn run(bus: Arc<Bus>, state: Arc<WatchState>, changed: impl Fn() + Send + Sync) {
    let mut last: Option<Vec<u8>> = None;
    let mut retry = RETRY_FIRST;
    loop {
        match open(&bus).await {
            Err(error) => state.down(&error),
            Ok(mut watch) => {
                let ended = loop {
                    let value = match watch.next().await {
                        Ok(WatchEvent::Snapshot { entries, .. }) => {
                            state.up();
                            retry = RETRY_FIRST;
                            entries
                                .into_iter()
                                .find(|entry| entry.key == KEY)
                                .map(|entry| entry.value)
                        }
                        Ok(WatchEvent::Update(RegisterUpdate::Put(entry))) if entry.key == KEY => {
                            Some(entry.value)
                        }
                        Ok(WatchEvent::Update(_)) => None,
                        Err(_) => break "register watch ended",
                    };
                    if let Some(value) = value.filter(|value| last.as_ref() != Some(value)) {
                        last = Some(value);
                        changed();
                    }
                };
                // The watch's connection is likely the shared one, and gone.
                bus.discard().await;
                state.down(ended);
            }
        }
        tokio::time::sleep(backoff(&mut retry)).await;
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
