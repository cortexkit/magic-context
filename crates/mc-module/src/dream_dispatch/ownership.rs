//! Which dream tasks Rust runs on a host: the single published list.
//!
//! A route reads this list over `dream.ownership`. No TypeScript dreamer reads it:
//! what keeps a TypeScript dreamer on the same project from repeating a Rust run
//! is the shared dream-domain lease and schedule rows in the store (see
//! `dispatcher::Dispatcher::dispatch`). A task is published for a project only
//! when Rust can actually run it there:
//!
//! 1. the user enabled `rust_background_enabled`;
//! 2. a production executor for the task is wired (see [`Wiring::production`]);
//! 3. the carrier the user's runner choice selects can carry every child the
//!    task opens: the conversation's own runner on a runner lane, or a Broca
//!    runner the user configured and this build wired. Off a runner lane the Host
//!    runner has no carrier (its claim routes are retired), so it publishes nothing.
//!
//! Anything else stays with TypeScript, so a host without ck-mc keeps running
//! every dreamer task as it does today.

use crate::config::McModuleConfig;
use crate::dream_runner::{resolve_task_models, DreamRole};
use crate::historian_runner::{HistorianRunnerKind, ResolvedRunner, RunnerSource};
use mc_store::dream_scheduler::schedules::{TaskName, CANONICAL_TASKS};
use serde_json::{json, Value};

/// The child roles each task's Rust host opens. `None` means no Rust host exists
/// for the task, whatever is wired. A source test pins this table to the hosts.
pub fn task_roles(task: TaskName) -> Option<&'static [DreamRole]> {
    match task {
        TaskName::Classify => Some(&[DreamRole::Classifier]),
        TaskName::Map | TaskName::Verify | TaskName::VerifyBroad => {
            Some(&[DreamRole::MemoryMapper])
        }
        TaskName::Curate => Some(&[DreamRole::Curate]),
        TaskName::Retrospective => Some(&[DreamRole::Reviewer, DreamRole::Retrospective]),
        TaskName::ReviewUserMemories => Some(&[DreamRole::Reviewer]),
        TaskName::PromotePrimers | TaskName::RefreshPrimers => {
            Some(&[DreamRole::PrimerInvestigator])
        }
        TaskName::CompressCues | TaskName::MaintainDocs | TaskName::EvaluateSmartNotes => None,
    }
}

/// Which executors this binary has wired for production work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wiring {
    /// Tasks with a production executor. Publication never names any other task.
    pub tasks: Vec<TaskName>,
    /// Whether a Broca transport is wired for dream children.
    pub broca: bool,
    /// Whether the wired Broca runner is known to admit AFT's read tools
    /// (read, grep, glob, aft_outline, aft_zoom, aft_search) for a dream child.
    /// map-memories, verify and verify-broad read the repository, so a Broca run
    /// publishes them only when this holds.
    ///
    /// Production leaves it false: Broca has no way to declare which tools it
    /// admits. llm-runner/v1 `role.describe` lists capability groups only, and
    /// whether Broca admits the `aft` plan item is decided by Broca's own
    /// allowlist, which Magic Context cannot see. The real fix is Broca declaring
    /// its tool capability in `role.describe`; until then those three tasks stay
    /// with TypeScript for Broca users.
    pub broca_file_read: bool,
}

impl Wiring {
    /// The wiring of this build. It names no task until a production executor
    /// runs them, so publication stays empty and TypeScript keeps every task.
    pub fn production() -> Self {
        Self {
            tasks: super::dispatcher::OPERATIONAL_TASKS.to_vec(),
            broca: false,
            broca_file_read: false,
        }
    }
}

pub struct OwnershipInput<'a> {
    pub config: &'a McModuleConfig,
    /// The trusted dreamer settings (user profile applied), used to see whether a
    /// task's child would ask for the session's default model. `None` when the
    /// trusted config could not be resolved; nothing is published then.
    pub settings: Option<&'a Value>,
    pub harness: &'a str,
    pub wiring: &'a Wiring,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ownership {
    pub activated: bool,
    /// The runner this project's dream children would use, and why.
    pub runner: ResolvedRunner,
    pub published: Vec<TaskName>,
    /// Every canonical task that is not published, with the first reason found.
    pub withheld: Vec<(TaskName, String)>,
}

impl Ownership {
    pub fn owns(&self, task: TaskName) -> bool {
        self.published.contains(&task)
    }

    pub fn to_json(&self) -> Value {
        let runner = self.runner;
        json!({
            "ok": true,
            "v": 1,
            "activated": self.activated,
            "runner": {"kind": runner.kind.as_str(), "source": runner.source.as_str()},
            // Kept for readers of the v1 answer; no route can declare a claimant.
            "claimant_declared": false,
            "published": self.published.iter().map(|t| t.as_str()).collect::<Vec<_>>(),
            "withheld": self.withheld.iter().map(|(t, reason)| json!({"task": t.as_str(), "reason": reason})).collect::<Vec<_>>(),
        })
    }
}

/// Why `task` is not published for this input, or `None` when Rust runs it.
/// `session_runner` is set when the project's children go to a runner-lane
/// conversation's own runner (see `historian_runner::uses_session_runner`); its
/// value says whether this process can open routes to that runner at all.
fn withheld_reason(
    task: TaskName,
    input: &OwnershipInput<'_>,
    session_runner: Option<bool>,
) -> Option<String> {
    if !input.config.rust_background_enabled() {
        return Some("inactive".into());
    }
    let Some(roles) = task_roles(task) else {
        return Some("no_rust_host".into());
    };
    if !input.wiring.tasks.contains(&task) {
        return Some("host_unwired".into());
    }
    let Some(settings) = input.settings else {
        return Some("config_unavailable".into());
    };
    if let Some(wired) = session_runner {
        // The child runs in the session's own runner through the same llm-runner
        // carrier as Broca, so it needs the same model and file-read guarantees,
        // but not a configured Broca runner.
        if !wired {
            return Some("session_runner_unwired".into());
        }
        if resolve_task_models(settings, input.harness, task.as_str())
            .primary
            .is_none()
        {
            return Some("session_runner_model_required".into());
        }
        if reads_repository(roles) && !input.wiring.broca_file_read {
            return Some("session_runner_file_read".into());
        }
        return None;
    }
    let runner = input.config.dreamer_runner_for(input.harness);
    match runner.kind {
        HistorianRunnerKind::Broca => {
            // Broca is used only when the user named it (`dreamer.runner` or
            // `historian.runner`); a harness that merely defaults to Broca stays
            // with TypeScript, so Rust background work never requires Broca.
            if runner.source != RunnerSource::Configured {
                return Some("broca_not_configured".into());
            }
            if !input.wiring.broca {
                return Some("broca_unwired".into());
            }
            // BrocaCarrier refuses to open a child whose request names no model.
            if resolve_task_models(settings, input.harness, task.as_str())
                .primary
                .is_none()
            {
                return Some("broca_model_required".into());
            }
            // A child whose tools are not all served by Magic Context itself reads
            // files through AFT, which only a runner declaring file reads carries.
            if reads_repository(roles) && !input.wiring.broca_file_read {
                return Some("broca_file_read".into());
            }
            None
        }
        // The host runner's children were carried by a claimant over the
        // `dream.child.*` routes, which are retired.
        HistorianRunnerKind::Host => Some("no_claimant".into()),
    }
}

/// Whether any of these roles opens a child with a tool Magic Context does not
/// serve itself: such a tool reads the repository through AFT.
fn reads_repository(roles: &[DreamRole]) -> bool {
    roles.iter().any(|role| {
        role.tools()
            .iter()
            .any(|tool| !super::broca_carrier::MC_TOOLS.contains(tool))
    })
}

/// Compute the published list. Pure: the caller supplies every input.
pub fn publish(input: &OwnershipInput<'_>) -> Ownership {
    publish_on(input, None)
}

/// Compute the published list. With `session_runner` set, the project's children
/// run on a runner-lane conversation's own runner, and the value says whether this
/// process can reach it; with `None` they run on the configured runner.
pub fn publish_on(input: &OwnershipInput<'_>, session_runner: Option<bool>) -> Ownership {
    let mut published = Vec::new();
    let mut withheld = Vec::new();
    for task in CANONICAL_TASKS {
        match withheld_reason(task, input, session_runner) {
            None => published.push(task),
            Some(reason) => withheld.push((task, reason)),
        }
    }
    Ownership {
        activated: input.config.rust_background_enabled(),
        runner: input.config.dreamer_runner_for(input.harness),
        published,
        withheld,
    }
}

#[cfg(test)]
pub(crate) mod tests;
