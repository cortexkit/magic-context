//! A fake session runner for runner-lane historian tests.
//!
//! It stands in for the runner module that owns a conversation (`thalamus-harness`
//! for OpenCode and Pi): historian producers reach it only through
//! `HistorianProducerFactory::connect_session_runner`, and a producer for the
//! configured runner (`connect`) is refused and counted, so a firing that falls back
//! to the fixed `broca` target fails instead of silently succeeding.
//!
//! One fake is kept per project root, so a handler built again on the same
//! directory (a module restart) reaches the same runner and the runs it already
//! holds, as a real runner outlives a restart of this module. A run stays active
//! until the test finishes it with [`FakeSessionRunner::finish`]. Sends are keyed by
//! `send_id`: repeating one returns the run it already started, as llm-runner's
//! idempotent sends do, while every send is still recorded so a test can count them.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use subc_client_rs::async_trait;
use tokio::sync::Notify;

use crate::historian::HistorianProducerDriver;
use crate::historian_producer::{
    HistorianProducerError, ProducerErrorBody, ProducerOutput, RunHandle, RunState,
};
use crate::route_targets::SessionRunnerRoute;
use crate::HistorianProducerFactory;

/// One `session.send` the fake runner received.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FakeSend {
    pub route: SessionRunnerRoute,
    pub send_id: String,
    pub model: String,
    pub system: String,
    pub prompt: String,
    pub run_id: String,
}

#[derive(Default)]
struct FakeState {
    fixed_connects: usize,
    connects: Vec<SessionRunnerRoute>,
    sends: Vec<FakeSend>,
    runs_by_send: HashMap<String, String>,
    outputs: HashMap<String, String>,
}

#[derive(Default)]
pub(crate) struct FakeSessionRunner {
    state: Mutex<FakeState>,
    changed: Notify,
}

fn registry() -> &'static Mutex<HashMap<PathBuf, Arc<FakeSessionRunner>>> {
    static FAKES: OnceLock<Mutex<HashMap<PathBuf, Arc<FakeSessionRunner>>>> = OnceLock::new();
    FAKES.get_or_init(Mutex::default)
}

impl FakeSessionRunner {
    /// The fake runner serving `project_root`, created on first use.
    pub(crate) fn for_project(project_root: &Path) -> Arc<Self> {
        Arc::clone(
            registry()
                .lock()
                .expect("fake runner registry")
                .entry(project_root.to_path_buf())
                .or_default(),
        )
    }

    pub(crate) fn factory(self: &Arc<Self>) -> Arc<dyn HistorianProducerFactory> {
        self.factory_with_max_output_tokens(false)
    }

    pub(crate) fn factory_with_max_output_tokens(
        self: &Arc<Self>,
        max_output_tokens: bool,
    ) -> Arc<dyn HistorianProducerFactory> {
        Arc::new(FakeSessionRunnerFactory {
            runner: Arc::clone(self),
            max_output_tokens,
        })
    }

    /// Every send received so far, repeats included, in arrival order.
    pub(crate) fn sends(&self) -> Vec<FakeSend> {
        self.state.lock().expect("fake runner").sends.clone()
    }

    /// The routes producers opened to this runner.
    pub(crate) fn connects(&self) -> Vec<SessionRunnerRoute> {
        self.state.lock().expect("fake runner").connects.clone()
    }

    /// How many producers asked for the configured (fixed) runner instead.
    pub(crate) fn fixed_connects(&self) -> usize {
        self.state.lock().expect("fake runner").fixed_connects
    }

    /// Wait for a send whose run has not finished and return the newest one.
    pub(crate) async fn next_unfinished(&self) -> FakeSend {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let state = self.state.lock().expect("fake runner");
                if let Some(send) = state
                    .sends
                    .iter()
                    .rev()
                    .find(|send| !state.outputs.contains_key(&send.run_id))
                {
                    return send.clone();
                }
            }
            changed.await;
        }
    }

    /// End `run_id` with `text`, as the runner's terminal for that run.
    pub(crate) fn finish(&self, run_id: &str, text: String) {
        self.state
            .lock()
            .expect("fake runner")
            .outputs
            .insert(run_id.to_string(), text);
        self.changed.notify_waiters();
    }
}

struct FakeSessionRunnerFactory {
    runner: Arc<FakeSessionRunner>,
    max_output_tokens: bool,
}

#[async_trait]
impl HistorianProducerFactory for FakeSessionRunnerFactory {
    async fn connect(
        &self,
        _project_root: &Path,
    ) -> Result<Box<dyn HistorianProducerDriver + Send>, HistorianProducerError> {
        self.runner
            .state
            .lock()
            .expect("fake runner")
            .fixed_connects += 1;
        Err(HistorianProducerError::Subc(ProducerErrorBody::untagged(
            "unknown_module",
            "a runner-lane firing must not open the configured runner route",
        )))
    }

    async fn connect_session_runner(
        &self,
        _identity: &crate::session_resolver::RunnerBindIdentity,
        route: &SessionRunnerRoute,
    ) -> Result<Box<dyn HistorianProducerDriver + Send>, HistorianProducerError> {
        self.runner
            .state
            .lock()
            .expect("fake runner")
            .connects
            .push(route.clone());
        Ok(Box::new(FakeSessionRunnerDriver {
            runner: Arc::clone(&self.runner),
            route: route.clone(),
            max_output_tokens: self.max_output_tokens,
        }))
    }
}

struct FakeSessionRunnerDriver {
    runner: Arc<FakeSessionRunner>,
    route: SessionRunnerRoute,
    max_output_tokens: bool,
}

#[async_trait]
impl HistorianProducerDriver for FakeSessionRunnerDriver {
    async fn session_runner_limits(
        &mut self,
        _child: &str,
    ) -> Result<Option<crate::runner_limits::RunnerLimits>, HistorianProducerError> {
        Ok(Some(crate::runner_limits::RunnerLimits {
            max_steps: true,
            no_tools: true,
            max_output_tokens: self.max_output_tokens,
        }))
    }

    async fn bind_session(&mut self, _session_id: &str) -> Result<(), HistorianProducerError> {
        Ok(())
    }

    async fn start(
        &mut self,
        session_id: &str,
        system: &str,
        prompt: &str,
        model: &str,
    ) -> Result<RunHandle, HistorianProducerError> {
        let mut state = self.runner.state.lock().expect("fake runner");
        let next = format!("run-{}", state.runs_by_send.len() + 1);
        let run_id = state
            .runs_by_send
            .entry(session_id.to_string())
            .or_insert(next)
            .clone();
        state.sends.push(FakeSend {
            route: self.route.clone(),
            send_id: session_id.to_string(),
            model: model.to_string(),
            system: system.to_string(),
            prompt: prompt.to_string(),
            run_id: run_id.clone(),
        });
        drop(state);
        self.runner.changed.notify_waiters();
        Ok(RunHandle { run_id })
    }

    async fn await_output(
        &mut self,
        run_id: &str,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        loop {
            let changed = self.runner.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if let Some(text) = self
                .runner
                .state
                .lock()
                .expect("fake runner")
                .outputs
                .get(run_id)
                .cloned()
            {
                return Ok(ProducerOutput {
                    text,
                    length_capped: false,
                    usage: None,
                });
            }
            changed.await;
        }
    }

    async fn status(&mut self, run_id: &str) -> Result<RunState, HistorianProducerError> {
        let state = self.runner.state.lock().expect("fake runner");
        Ok(if state.outputs.contains_key(run_id) {
            RunState::Terminal
        } else if state.runs_by_send.values().any(|known| known == run_id) {
            RunState::Active
        } else {
            RunState::Missing { detail: None }
        })
    }

    async fn cancel(&mut self, _run_id: &str) -> Result<(), HistorianProducerError> {
        Ok(())
    }

    async fn close(&mut self) {}
}
