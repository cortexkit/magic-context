//! The `dream.ownership` route that publishes which dream tasks Rust runs, and
//! the `dream.run` manual entry. The Host claimant routes (`dream.child.*`) are
//! retired; a `claimant` declaration on `dream.ownership` is refused by name.

use crate::dream_dispatch::ownership::{self, Ownership, OwnershipInput, Wiring};
use crate::dream_dispatch::tick::{DreamHandles, DreamTarget, ManualRun};
use crate::{invalid_params_error, now_ms, ops_facade, respond, McHandler, SessionBinding};
use mc_store::dream_scheduler::schedules::TaskName;
use serde_json::{json, Value};
use subc_client_rs::HandlerOutcome;

/// Harness names whose plugin opens a principal-less route and runs the
/// TypeScript dreamer itself. Any other route needs a daemon-attested principal.
const PLUGIN_HARNESSES: [&str; 4] = ["opencode", "opencode2", "pi", "omp"];

/// True for a route opened by a Magic Context plugin: no principal and a harness
/// in `PLUGIN_HARNESSES`. Such a host runs every dream task itself unless the
/// task is in Rust's published list.
pub(crate) fn plugin_lane(binding: &SessionBinding) -> bool {
    binding.principal.is_none() && PLUGIN_HARNESSES.contains(&binding.harness.as_str())
}

impl McHandler {
    /// Resolve the bound project after checking the v1 envelope and admitting
    /// either a principal-less plugin route or a daemon-attested harness route.
    fn dream_lane(
        &self,
        channel: u16,
        request: &Value,
        method: &str,
    ) -> Result<(SessionBinding, String), HandlerOutcome> {
        if request.get("v").and_then(Value::as_u64) != Some(1) {
            return Err(HandlerOutcome::Error {
                code: "bad_request".into(),
                message: format!("{method} requires v=1"),
            });
        }
        let binding = self
            .facade_binding(channel)
            .map_err(|_| HandlerOutcome::Error {
                code: "route_unbound".into(),
                message: format!("{method} on a channel with no session binding"),
            })?;
        if binding.principal.is_some() {
            ops_facade::authorize_harness_scope(&binding)?;
        } else if !plugin_lane(&binding) {
            return Err(HandlerOutcome::Error {
                code: "host_lane_requires_plugin".into(),
                message: "dream claims require a plugin or attested harness route".into(),
            });
        }
        let Some(store) = self.store.get() else {
            return Err(self.store_refusal());
        };
        let project = self.historian_lane_project(channel, &binding, store)?;
        Ok((binding, project))
    }

    fn dream_wiring(&self) -> Wiring {
        #[cfg(test)]
        if let Some(wiring) = &self.dream_wiring {
            return wiring.clone();
        }
        Wiring {
            broca: self.dream_runs.broca_wired(),
            ..Wiring::production()
        }
    }

    /// The handles a Rust dream run needs, with this handler's wiring.
    pub(crate) fn dream_handles(&self) -> DreamHandles {
        DreamHandles {
            store: self.store.clone(),
            broca_routes: self.broca_dream_tools.clone(),
            runs: self.dream_runs.clone(),
            wiring: self.dream_wiring(),
            module_id: std::env::var("SUBC_MODULE_ID")
                .ok()
                .filter(|id| !id.is_empty())
                .unwrap_or_else(|| crate::DEFAULT_MODULE_ID.to_owned()),
        }
    }

    /// Remember the project of an admitted dream route, so the Rust tick can find
    /// it, and start the tick timer once a project has been seen. Only while the
    /// user has the Rust dreamer switched on: with it off nothing is recorded and
    /// no timer runs, exactly as before the tick existed.
    fn record_dream_target(&self, binding: &SessionBinding, project: &str) {
        if !self
            .effective_config(&binding.project_root)
            .rust_background_enabled()
        {
            return;
        }
        self.dream_runs.record(
            project,
            DreamTarget {
                directory: binding.project_root.clone(),
                session: binding.session.clone(),
                harness: binding.harness.clone(),
                seen_at_ms: now_ms(),
                // A dream management route is the claim protocol's own route; only
                // a runner-lane conversation records a session runner
                // (see `record_session_runner_dream_target`).
                session_runner: None,
            },
        );
        // Tests drive runs explicitly; a background timer would race them.
        #[cfg(not(test))]
        self.dream_handles().ensure_timer();
    }

    /// `dream.run {v:1, task, command_id}`: run one published task now, on the
    /// manual entry, under a durable command id (a replayed id never runs twice).
    /// A task Rust has not published is refused, so it stays with TypeScript.
    pub(crate) fn handle_dream_run(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let (binding, project) = match self.dream_lane(channel, request, "dream.run") {
            Ok(lane) => lane,
            Err(refusal) => return refusal,
        };
        let Some(task) = request
            .get("task")
            .and_then(Value::as_str)
            .and_then(|name| {
                mc_store::dream_scheduler::schedules::CANONICAL_TASKS
                    .into_iter()
                    .find(|t| t.as_str() == name)
            })
        else {
            return invalid_params_error("dream.run requires a canonical task");
        };
        let Some(command_id) = request
            .get("command_id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty() && id.len() <= 256)
        else {
            return invalid_params_error("dream.run command_id must be 1-256 bytes");
        };
        self.record_dream_target(&binding, &project);
        if !self.dream_ownership(&binding).owns(task) {
            return respond(json!({"ok": false, "refusal": "not_published"}));
        }
        let started = self
            .dream_handles()
            .start(
                &project,
                Some(ManualRun {
                    task,
                    command_id: command_id.to_owned(),
                }),
            )
            .is_some();
        respond(json!({"ok": started, "started": started}))
    }

    /// The tasks Rust runs for this project right now, from the route's current
    /// config and this build's wiring. The route's harness selects the runner and
    /// models.
    pub(crate) fn dream_ownership(&self, binding: &SessionBinding) -> Ownership {
        let config = self.effective_config(&binding.project_root);
        // Settings are only read when activation could publish anything; a
        // resolution failure publishes nothing rather than guessing.
        let settings = config
            .rust_background_enabled()
            .then(|| self.dream_task_settings(&binding.project_root).ok())
            .flatten();
        let wiring = self.dream_wiring();
        ownership::publish(&OwnershipInput {
            config: &config,
            settings: settings.as_ref(),
            harness: binding.harness.as_str(),
            wiring: &wiring,
        })
    }

    /// Remember a runner-lane conversation as its project's dream target: the tick
    /// then sends that project's dream children to `route` (the conversation's own
    /// runner, as hidden children of `route.parent_session()`). `project` is the project key the store files the
    /// project's dream schedule under; `directory` is where children work.
    ///
    /// Nothing here reads a pass barrier, a provider plan or a route channel, so
    /// any handler that has admitted the conversation can call it. Returns whether
    /// the target was recorded: only while the Rust dreamer is switched on for
    /// `directory`, as for [`Self::record_dream_target`].
    pub(crate) fn record_session_runner_dream_target(
        &self,
        project: &str,
        directory: &std::path::Path,
        harness: &str,
        route: crate::route_targets::SessionRunnerRoute,
    ) -> bool {
        if !self.effective_config(directory).rust_background_enabled() {
            return false;
        }
        self.dream_runs.record(
            project,
            DreamTarget {
                directory: directory.to_path_buf(),
                session: route.parent_session().to_owned(),
                harness: harness.to_owned(),
                seen_at_ms: now_ms(),
                session_runner: Some(route),
            },
        );
        #[cfg(not(test))]
        self.dream_handles().ensure_timer();
        true
    }

    /// `dream.ownership {v:1}` answers with the published list for the route's
    /// project. Reading is open to plugin and attested harness routes.
    ///
    /// A `claimant` field declared a Host claimant that then pulled children over
    /// the `dream.child.*` routes. Those routes are retired, so a declaration (or a
    /// withdrawal) is refused by name: accepting it would publish tasks whose
    /// children nobody can claim.
    pub(crate) fn handle_dream_ownership(&self, channel: u16, request: &Value) -> HandlerOutcome {
        let (binding, project) = match self.dream_lane(channel, request, "dream.ownership") {
            Ok(lane) => lane,
            Err(refusal) => return refusal,
        };
        self.record_dream_target(&binding, &project);
        if request.get("claimant").is_some() {
            return HandlerOutcome::Error {
                code: crate::RETIRED_ROUTE_CODE.into(),
                message: "dream.ownership claimant".into(),
            };
        }
        respond(self.dream_ownership(&binding).to_json())
    }

    /// Whether Rust publishes `task` for this route; used by `dreamer.run_task`.
    pub(crate) fn dream_task_published(
        &self,
        channel: u16,
        binding: &SessionBinding,
        task: TaskName,
    ) -> bool {
        let Some(store) = self.store.get() else {
            return false;
        };
        // The route must still resolve to a project for Rust to run its tasks.
        if self
            .historian_lane_project(channel, binding, store)
            .is_err()
        {
            return false;
        }
        self.dream_ownership(binding).owns(task)
    }
}

#[cfg(test)]
mod tests;
