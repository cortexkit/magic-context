//! The names prefrontal goes by. Prefrontal (called "core" elsewhere in this
//! crate) serves the workspace guidance the dreamer's curate tasks show, on
//! its management surface, and owns the scopes flows run under. It was
//! installed as `prefrontal-core` and is renamed `prefrontal`. Machines take
//! the new name one by one, so for a while a daemon may have either one
//! installed, and ck-mc accepts both:
//!
//! - a call to prefrontal's management surface tries the id that answered
//!   last, `prefrontal` until one has, and the other id only when the daemon
//!   refuses the first as not installed ([`ManagementIds::call`]);
//! - a flow scope owned by either id is a flow scope, with the same powers
//!   ([`crate::docs_proposals::flow`]).

use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::Value;

use crate::client::CoreRefusal;

/// Prefrontal's module ids, the current name first.
pub(crate) const MODULE_IDS: &[&str] = &["prefrontal", "prefrontal-core"];

/// How one call to prefrontal's management surface under one id ended.
#[derive(Debug)]
pub(crate) enum Attempt {
    /// The daemon refused to open the route because no module of that id is
    /// installed. The other id may still answer.
    NotInstalled,
    /// Anything else: prefrontal's answer, its refusal, or a failure to get
    /// either. The other id is not tried.
    Settled(Result<Value, CoreRefusal>),
}

/// Which of [`MODULE_IDS`] a call to prefrontal's management surface opens
/// first: the one whose route the daemon last opened, kept for the life of
/// the process so a steady call opens one route only.
#[derive(Debug, Default)]
pub(crate) struct ManagementIds {
    /// An index into [`MODULE_IDS`].
    current: AtomicUsize,
}

impl ManagementIds {
    /// One call, made by `attempt` under one id at a time. The remembered id
    /// goes first; the other is tried only when the daemon refuses the
    /// remembered one as not installed, and then becomes the remembered id
    /// unless it is refused too. When both are refused prefrontal is not
    /// installed ([`CoreRefusal::not_installed`]).
    pub(crate) async fn call<F, Fut>(&self, mut attempt: F) -> Result<Value, CoreRefusal>
    where
        F: FnMut(&'static str) -> Fut,
        Fut: Future<Output = Attempt>,
    {
        let first = self.current.load(Ordering::Relaxed);
        for offset in 0..MODULE_IDS.len() {
            let index = (first + offset) % MODULE_IDS.len();
            if let Attempt::Settled(answer) = attempt(MODULE_IDS[index]).await {
                self.current.store(index, Ordering::Relaxed);
                return answer;
            }
        }
        Err(CoreRefusal::not_installed())
    }
}

#[cfg(test)]
#[path = "prefrontal_tests.rs"]
mod tests;
