//! Optional runner features are discovered on a child's scoped route. A
//! missing or unreadable declaration keeps older runners usable.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::OnceCell;

use crate::client::ClientError;

type Declaration = (u64, Arc<OnceCell<bool>>);

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

    /// Only the capabilities array matters. Other discovery fields belong to
    /// the runner and may evolve independently of this caller.
    pub async fn cache_policy(
        &self,
        runner: &str,
        connection_epoch: u64,
        describe: impl Future<Output = Result<Value, ClientError>>,
    ) -> bool {
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
        *cell
            .get_or_init(|| async {
                match describe.await {
                    Ok(value) => {
                        let declared = value["capabilities"].as_array().is_some_and(|groups| {
                            groups.iter().any(|group| group.as_str() == Some("cache_policy"))
                        });
                        if !declared {
                            tracing::info!(runner, "summarizer cache omitted: runner does not declare cache_policy");
                        }
                        declared
                    }
                    Err(error) => {
                        tracing::warn!(runner, reason = %error.message, "summarizer cache omitted: runner discovery failed");
                        false
                    }
                }
            })
            .await
    }
}

#[cfg(test)]
#[path = "runner_capabilities_tests.rs"]
mod tests;
