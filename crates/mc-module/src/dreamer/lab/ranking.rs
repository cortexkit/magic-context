use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use cortexkit_role_compaction::read::SessionRef;
use serde_json::{json, Value};

use crate::client::RunnerClient;
use crate::search::lab::PreparedHistory;
use crate::search::rerank::{self, Pinned, Reranker, Skipped};

type SynapseFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>;
type SynapseCall = dyn Fn(SessionRef, String, &'static str, Value) -> SynapseFuture + Send + Sync;

pub(super) struct Runtime {
    settings: Reranker,
    synapse: Option<Box<SynapseCall>>,
    session: Mutex<Option<SessionRef>>,
    calls: AtomicU64,
    failures: AtomicU64,
    pin_failures: AtomicU64,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            settings: Reranker::Off,
            synapse: None,
            session: Mutex::default(),
            calls: AtomicU64::default(),
            failures: AtomicU64::default(),
            pin_failures: AtomicU64::default(),
        }
    }
}

impl Runtime {
    #[cfg(test)]
    pub(super) fn scripted(module: &str, call: Box<SynapseCall>) -> Self {
        Self {
            settings: Reranker::Synapse(module.to_owned()),
            synapse: Some(call),
            ..Self::default()
        }
    }

    pub(super) fn new(client: Arc<impl RunnerClient>, settings: Reranker) -> Self {
        let synapse: Box<SynapseCall> = Box::new(move |session, module, method, input| {
            let client = client.clone();
            Box::pin(async move { client.synapse_call(&session, &module, method, input).await })
        });
        Self {
            settings,
            synapse: Some(synapse),
            ..Self::default()
        }
    }

    pub(super) fn bind(&self, child: &SessionRef) {
        if matches!(self.settings, Reranker::Synapse(_)) {
            *self.session.lock().expect("lab rerank session") = Some(child.clone());
        }
    }

    pub(super) fn report(&self, enabled: bool) -> Value {
        json!({"configured":self.settings != Reranker::Off, "enabled":enabled && self.settings != Reranker::Off,
            "calls":self.calls.load(Ordering::Relaxed), "failures":self.failures.load(Ordering::Relaxed),
            "pin_failures":self.pin_failures.load(Ordering::Relaxed)})
    }

    pub(super) async fn prepare(&self, query: &str, deadline: Instant) -> Option<Scorer<'_>> {
        if !rerank::is_prose_query(query) {
            return None;
        }
        let pinned = match &self.settings {
            Reranker::Off => return None,
            Reranker::Remote(_) => None,
            Reranker::Synapse(module) => {
                let call = self.synapse.as_ref()?;
                let session = self.session.lock().expect("lab rerank session").clone()?;
                let catalog = call(session.clone(), module.clone(), "models.list", json!({}));
                let pin_deadline = deadline.min(Instant::now() + rerank::SYNAPSE_DEADLINE);
                let result = tokio::time::timeout_at(
                    pin_deadline.into(),
                    rerank::pin_synapse(module, catalog),
                )
                .await
                .unwrap_or_else(|_| Err(Skipped("timeout".into())));
                match result {
                    Ok(pin) => Some((session, pin)),
                    Err(Skipped(reason)) => {
                        self.pin_failures.fetch_add(1, Ordering::Relaxed);
                        rerank::synapse_fell_back(module, &reason);
                        return None;
                    }
                }
            }
        };
        Some(Scorer {
            runtime: self,
            pinned,
        })
    }
}

pub(super) struct Scorer<'a> {
    runtime: &'a Runtime,
    pinned: Option<(SessionRef, Pinned)>,
}

impl Scorer<'_> {
    pub(super) fn pool(&self) -> usize {
        self.runtime.settings.pool()
    }

    pub(super) async fn apply(
        &self,
        query: &str,
        prepared: &mut PreparedHistory,
        deadline: Instant,
    ) {
        // Each group has its own pool and limit. Score them under the same
        // deadline so a slow group cannot spend the other groups' time.
        futures_util::future::join_all(prepared.groups.iter_mut().map(|group| async move {
            if group.documents.is_empty() || Instant::now() >= deadline {
                return;
            }
            self.runtime.calls.fetch_add(1, Ordering::Relaxed);
            let scored =
                tokio::time::timeout_at(deadline.into(), self.score(query, &group.documents))
                    .await
                    .unwrap_or_else(|_| Err(Skipped("timeout".into())));
            match scored {
                Ok(scores) => {
                    if let Reranker::Synapse(module) = &self.runtime.settings {
                        rerank::synapse_scored(module);
                    }
                    group.reorder(&scores);
                }
                Err(Skipped(reason)) => {
                    self.runtime.failures.fetch_add(1, Ordering::Relaxed);
                    if let Reranker::Synapse(module) = &self.runtime.settings {
                        rerank::synapse_fell_back(module, &reason);
                        rerank::forget_synapse_pin(module);
                    } else {
                        rerank::log_fallback(&reason);
                    }
                }
            }
        }))
        .await;
    }

    async fn score(&self, query: &str, documents: &[String]) -> Result<Vec<f64>, Skipped> {
        match (&self.runtime.settings, &self.pinned) {
            (Reranker::Synapse(module), Some((session, pin))) => {
                let call = self
                    .runtime
                    .synapse
                    .as_ref()
                    .expect("a pinned module has a client");
                let request = rerank::score_request(pin, query, documents);
                let reply = call(session.clone(), module.clone(), "rerank.score", request)
                    .await
                    .map_err(Skipped)?;
                rerank::scores(reply, pin, documents.len())
            }
            (Reranker::Remote(remote), _) => rerank::remote_scores(remote, query, documents).await,
            _ => unreachable!("only configured rerankers make a scoring plan"),
        }
    }
}
