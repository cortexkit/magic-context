//! Named points right after each durable write of a move's ops, where a
//! test can stop an op the way a crash of the process would stop it.
//!
//! A crash ends an op between two writes: every write before it is on disk,
//! nothing after it happens, and nothing kept in memory survives. The tests
//! reproduce that by stopping the op at one of these points, dropping the
//! module, and starting a new one over the same files. Each write a move
//! makes (a journal change, a `context.db` or `mode3.db` transaction, a file
//! it stages, a page it admits to Engram's session door) is followed by a
//! point, so stopping at every point a run reaches covers a crash after
//! every one of its writes. The install's own transactions are covered by
//! [`after_commit`], which the offline mover's write loop calls after each
//! commit.
//!
//! In a build that is not a test, a point does nothing.

/// A point an op passes right after a durable write.
pub(crate) async fn point(name: &str) {
    #[cfg(test)]
    testing::reach(name).await;
    #[cfg(not(test))]
    let _ = name;
}

#[cfg(test)]
pub(crate) use testing::{after_commit, current, enter, Mode, Plan, PLAN};

#[cfg(test)]
mod testing {
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    use tokio::sync::Notify;

    tokio::task_local! {
        /// The plan of the op a test runs, for the task that runs it.
        pub(crate) static PLAN: Arc<Plan>;
    }

    thread_local! {
        /// The plan of the op whose `context.db` work runs on this blocking
        /// thread, set by [`enter`].
        static ON_THREAD: RefCell<Option<Arc<Plan>>> = const { RefCell::new(None) };
    }

    /// What happens at the point a plan stops at.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum Mode {
        /// The op never goes on, as if the process had died there.
        Crash,
        /// The op waits until the test lets it go on, so the test can change
        /// something outside it first.
        Pause,
    }

    /// Where a test stops one op, and every point that op passed.
    pub(crate) struct Plan {
        /// The point to stop at, by name and by how many times it was passed
        /// before (0 for the first time). `None` stops nowhere and only
        /// records the points passed.
        target: Option<(String, usize)>,
        mode: Mode,
        passed: Mutex<Vec<String>>,
        stopped: AtomicBool,
        stopping: Notify,
        go_on: Notify,
    }

    impl Plan {
        /// A plan that stops nowhere and records the points an op passes.
        pub(crate) fn record() -> Arc<Self> {
            Self::new(None, Mode::Crash)
        }

        /// A plan that stops the op at the `occurrence`th pass of `name`.
        pub(crate) fn at(name: &str, occurrence: usize, mode: Mode) -> Arc<Self> {
            Self::new(Some((name.to_owned(), occurrence)), mode)
        }

        fn new(target: Option<(String, usize)>, mode: Mode) -> Arc<Self> {
            Arc::new(Self {
                target,
                mode,
                passed: Mutex::default(),
                stopped: AtomicBool::new(false),
                stopping: Notify::new(),
                go_on: Notify::new(),
            })
        }

        /// Every point passed so far, in order.
        pub(crate) fn passed(&self) -> Vec<String> {
            self.passed.lock().unwrap().clone()
        }

        /// Whether the op reached the point this plan stops at.
        pub(crate) fn stopped(&self) -> bool {
            self.stopped.load(Ordering::SeqCst)
        }

        /// Wait until the op reaches the point this plan stops at.
        pub(crate) async fn reached(&self) {
            self.stopping.notified().await;
        }

        /// Let a paused op go on.
        pub(crate) fn go_on(&self) {
            self.go_on.notify_one();
        }

        /// Record one pass of `name`; true when this is the pass to stop at.
        fn pass(&self, name: &str) -> bool {
            let mut passed = self.passed.lock().unwrap();
            let before = passed.iter().filter(|seen| *seen == name).count();
            passed.push(name.to_owned());
            let stop = self
                .target
                .as_ref()
                .is_some_and(|(target, occurrence)| target == name && *occurrence == before);
            if stop {
                self.stopped.store(true, Ordering::SeqCst);
                self.stopping.notify_one();
            }
            stop
        }
    }

    pub(super) async fn reach(name: &str) {
        let Ok(plan) = PLAN.try_with(Arc::clone) else {
            return;
        };
        if plan.pass(name) {
            match plan.mode {
                Mode::Crash => std::future::pending::<()>().await,
                Mode::Pause => plan.go_on.notified().await,
            }
        }
    }

    /// The plan of the op running on this task, to carry onto a blocking
    /// thread.
    pub(crate) fn current() -> Option<Arc<Plan>> {
        PLAN.try_with(Arc::clone).ok()
    }

    /// Make `plan` the plan of this thread until the guard is dropped.
    pub(crate) fn enter(plan: Option<Arc<Plan>>) -> impl Drop {
        struct Left;
        impl Drop for Left {
            fn drop(&mut self) {
                ON_THREAD.with_borrow_mut(|plan| *plan = None);
            }
        }
        ON_THREAD.with_borrow_mut(|current| *current = plan);
        Left
    }

    /// Called after each commit of the offline mover's write loop, which
    /// installs a moved session. At the commit a plan stops at, the
    /// install fails as the process's exit would leave it: that commit is
    /// on disk and nothing after it ran. The op then fails without writing
    /// anything more, so the test restarts from exactly that state.
    pub(crate) fn after_commit(phase: &str) -> Result<(), String> {
        let stop = ON_THREAD.with_borrow(|plan| {
            plan.as_ref()
                .is_some_and(|plan| plan.pass(&format!("commit {phase}")))
        });
        if stop {
            return Err("simulated process exit after commit".into());
        }
        Ok(())
    }
}
