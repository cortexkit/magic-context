//! Optional runner features are discovered on the session's runner route. A
//! missing or unreadable declaration keeps older runners usable.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::OnceCell;

use crate::client::ClientError;
use cortexkit_role_llm_runner::session_retention::{Keep, RetentionPolicy};

type Declaration = (u64, Arc<OnceCell<Features>>);

#[derive(Clone, Default)]
struct Features {
    capabilities: HashSet<String>,
    delivery_order_modes: HashSet<String>,
    /// `session_retention.max_days` from the describe, when it is readable.
    retention_max_days: Option<u32>,
}

/// What a runner declaring the `session_retention` group lets the send that
/// creates a child ask for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionRetention {
    /// The most days a policy may keep a session, when the runner states a
    /// usable limit. The contract requires one with the group; a declaration
    /// without it still gets a policy, unfitted, because a runner declaring
    /// the group expects one on every send that creates a session.
    pub max_days: Option<u32>,
}

impl SessionRetention {
    /// A policy keeping the session `days` days after its last activity, or
    /// the runner's maximum when that is shorter: a longer keep is refused.
    /// Nothing is archived, backed up or dumped; the transcript only has to
    /// stay readable for that long.
    pub fn keep_for(self, days: u32) -> RetentionPolicy {
        let days = self.max_days.map_or(days, |max| days.min(max));
        RetentionPolicy::new(Keep::days(days), 0, false, false)
    }

    /// A policy for a session nobody reads after its run: the runner deletes
    /// it once released, or once its hold for unreleased sessions ends.
    pub fn keep_none(self) -> RetentionPolicy {
        RetentionPolicy::new(Keep::none(), 0, false, false)
    }
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

    pub async fn temperature(
        &self,
        runner: &str,
        connection_epoch: u64,
        describe: impl Future<Output = Result<Value, ClientError>>,
    ) -> bool {
        self.declared(runner, connection_epoch, describe)
            .await
            .capabilities
            .contains(cortexkit_role_llm_runner::capabilities::TEMPERATURE)
    }

    /// A child created with a fetch plan (tools from providers, system text
    /// from a provider) needs a runner declaring `plans`.
    pub async fn plans(
        &self,
        runner: &str,
        connection_epoch: u64,
        describe: impl Future<Output = Result<Value, ClientError>>,
    ) -> bool {
        self.declared(runner, connection_epoch, describe)
            .await
            .capabilities
            .contains(cortexkit_role_llm_runner::capabilities::PLANS)
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

    /// `Some` only for a runner declaring the `session_retention` group. Any
    /// other runner refuses a `retention_policy` member, so it is sent
    /// nothing new.
    pub async fn session_retention(
        &self,
        runner: &str,
        connection_epoch: u64,
        describe: impl Future<Output = Result<Value, ClientError>>,
    ) -> Option<SessionRetention> {
        let declared = self.declared(runner, connection_epoch, describe).await;
        declared
            .capabilities
            .contains(cortexkit_role_llm_runner::capabilities::SESSION_RETENTION)
            .then_some(SessionRetention {
                max_days: declared.retention_max_days,
            })
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
                            // The contract's limits start at one day, so a
                            // zero can't be fitted to and counts as unstated.
                            retention_max_days: value["session_retention"]["max_days"]
                                .as_u64()
                                .filter(|days| *days > 0)
                                .map(|days| u32::try_from(days).unwrap_or(u32::MAX)),
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
