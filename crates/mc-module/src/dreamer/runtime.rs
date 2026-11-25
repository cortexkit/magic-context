//! Keep maintenance work off the runtime that serves sessions and leases.

use std::future::Future;

use tokio::runtime::{Builder, Handle, Runtime};
use tokio::task::{AbortHandle, JoinError};

/// Build the pool for the dreamer's timer and runs. Independent projects
/// can make progress concurrently without using the session workers.
pub fn build() -> std::io::Result<Runtime> {
    Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("ck-mc-dreamer")
        .enable_all()
        .build()
}

/// Run an I/O operation on its owning runtime, even when maintenance
/// calls it. Unbound clients (such as test doubles) use the caller's runtime.
#[derive(Clone, Default)]
pub(crate) struct OnRuntime(Option<Handle>);

impl OnRuntime {
    pub(crate) fn current() -> Self {
        Self(Some(Handle::current()))
    }

    pub(crate) fn try_current() -> Self {
        Self(Handle::try_current().ok())
    }

    pub(crate) async fn run<F>(&self, operation: F) -> Result<F::Output, JoinError>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        if let Some(runtime) = self.0.as_ref().filter(|runtime| {
            Handle::try_current().map_or(true, |current| current.id() != runtime.id())
        }) {
            let task = runtime.spawn(operation);
            // Dropping the caller (e.g. on timeout) must still cancel its I/O.
            let _abort = AbortOnDrop(task.abort_handle());
            task.await
        } else {
            Ok(operation.await)
        }
    }
}

struct AbortOnDrop(AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}
