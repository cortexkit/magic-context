//! Optional runner features are discovered on the session's runner route. A
//! missing or unreadable declaration keeps older runners usable.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::OnceCell;

use crate::client::ClientError;

type Declaration = (u64, Arc<OnceCell<Features>>);

#[derive(Clone, Default)]
struct Features {
    capabilities: HashSet<String>,
    delivery_order_modes: HashSet<String>,
}

/// In-memory declarations, shared by summaries using the same runner and
/// consumer connection. Negative answers are cached too, to avoid repeated
/// discovery calls and warnings on older runners.
#[derive(Default)]
pub struct RunnerCapabilities {
    runners: Mutex<HashMap<String, Declaration>>,
}

impl RunnerCapabilities {
    /// A new Setup may follow a runner restart or upgrade even when the
    /// consumer connection stayed open, so its previous declaration expires.
    pub fn forget(&self, runner: &str) {
        self.runners
            .lock()
            .expect("runner capabilities")
            .remove(runner);
    }

    /// Read only the feature names ck-mc needs, without validating the entire
    /// describe. Unknown capability groups and delivery modes must not disable
    /// unrelated features such as notice_keep (automatic notice reclaim).
    pub async fn cache_policy(
        &self,
        runner: &str,
        connection_epoch: u64,
        describe: impl Future<Output = Result<Value, ClientError>>,
    ) -> bool {
        self.declared(runner, connection_epoch, describe)
            .await
            .capabilities
            .contains("cache_policy")
    }

    pub async fn notice_keep(
        &self,
        runner: &str,
        connection_epoch: u64,
        describe: impl Future<Output = Result<Value, ClientError>>,
    ) -> bool {
        let declared = self.declared(runner, connection_epoch, describe).await;
        // The runner contract requires message_marks alongside notice_keep.
        declared.capabilities.contains("notice_keep")
            && declared.capabilities.contains("message_marks")
    }

    pub async fn session_class(
        &self,
        runner: &str,
        connection_epoch: u64,
        describe: impl Future<Output = Result<Value, ClientError>>,
    ) -> bool {
        self.declared(runner, connection_epoch, describe)
            .await
            .capabilities
            .contains(cortexkit_role_llm_runner::capabilities::SESSION_CLASS)
    }

    /// `run.cancel` is served only by a runner declaring the `run_cancel`
    /// group.
    pub async fn run_cancel(
        &self,
        runner: &str,
        connection_epoch: u64,
        describe: impl Future<Output = Result<Value, ClientError>>,
    ) -> bool {
        self.declared(runner, connection_epoch, describe)
            .await
            .capabilities
            .contains(cortexkit_role_llm_runner::capabilities::RUN_CANCEL)
    }

    /// Clearing system notes are opt-in, never implied by delivery_order.
    pub async fn turn_system_cleared(
        &self,
        runner: &str,
        connection_epoch: u64,
        describe: impl Future<Output = Result<Value, ClientError>>,
    ) -> bool {
        self.declared(runner, connection_epoch, describe)
            .await
            .delivery_order_modes
            .contains("turn_system_cleared")
    }

    async fn declared(
        &self,
        runner: &str,
        connection_epoch: u64,
        describe: impl Future<Output = Result<Value, ClientError>>,
    ) -> Features {
        let cell = {
            let mut runners = self.runners.lock().expect("runner capabilities");
            let declaration = runners
                .entry(runner.to_owned())
                .or_insert_with(|| (connection_epoch, Arc::new(OnceCell::new())));
            if declaration.0 != connection_epoch {
                *declaration = (connection_epoch, Arc::new(OnceCell::new()));
            }
            Arc::clone(&declaration.1)
        };
        cell
            .get_or_init(|| async {
                match describe.await {
                    Ok(value) => {
                        let names = |field: &str| {
                            value[field]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(|name| name.as_str().map(str::to_owned))
                                .collect()
                        };
                        let declared = Features {
                            capabilities: names("capabilities"),
                            delivery_order_modes: names("delivery_order_modes"),
                        };
                        if !declared.capabilities.contains("cache_policy") {
                            tracing::info!(runner, "summarizer cache omitted: runner does not declare cache_policy");
                        }
                        declared
                    }
                    Err(error) => {
                        tracing::warn!(runner, reason = %error.message, "summarizer cache omitted: runner discovery failed");
                        Features::default()
                    }
                }
            })
            .await
            .clone()
    }
}

#[cfg(test)]
#[path = "runner_capabilities_tests.rs"]
mod tests;
