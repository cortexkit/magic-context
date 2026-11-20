//! Prefrontal serves the workspace guidance shown by the dreamer's curate
//! tasks and owns the scopes flows run under.

use std::future::Future;

use serde_json::Value;

use crate::client::CoreRefusal;

/// Prefrontal's module id.
pub(crate) const MODULE_ID: &str = "prefrontal";

/// How a call to prefrontal's management surface ended.
#[derive(Debug)]
pub(crate) enum Attempt {
    /// The daemon refused to open a route to prefrontal because it is not installed.
    NotInstalled,
    /// Prefrontal's answer or refusal, or a failure to get either.
    Settled(Result<Value, CoreRefusal>),
}

/// Call prefrontal's management surface under its module id.
pub(crate) async fn call<F, Fut>(attempt: F) -> Result<Value, CoreRefusal>
where
    F: FnOnce(&'static str) -> Fut,
    Fut: Future<Output = Attempt>,
{
    match attempt(MODULE_ID).await {
        Attempt::NotInstalled => Err(CoreRefusal::not_installed()),
        Attempt::Settled(answer) => answer,
    }
}

#[cfg(test)]
#[path = "prefrontal_tests.rs"]
mod tests;
