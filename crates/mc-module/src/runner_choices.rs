//! Which completion runner each session actually used, and why.
//!
//! The runner is decided per request from the harness that sent it unless the user
//! tier names one, so two sessions served by the same process can legitimately use
//! different runners. The status surfaces (`session.status`, which `/ctx-status`
//! renders, and the module health report, which `ck health magic-context` renders)
//! read this log to say which runner a session's completions went to and whether
//! that was configured or the harness default.
//!
//! In-memory and bounded: it records what this process did. After a restart a
//! session has no entry until its next completion, and the status surface then
//! reports the runner its route would resolve to instead.

use std::collections::{HashMap, VecDeque};

use serde_json::{json, Value};

use crate::historian_runner::{ResolvedRunner, RunnerSource};

/// Sessions remembered at once. The oldest recorded session is forgotten first.
pub const RUNNER_CHOICE_SESSION_CAP: usize = 256;
/// Sessions listed in the health metrics, newest first.
pub const RUNNER_CHOICE_HEALTH_LIST_CAP: usize = 32;

/// Which completion a runner decision was made for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RunnerRole {
    Historian,
    Dreamer,
}

impl RunnerRole {
    pub fn as_str(self) -> &'static str {
        match self {
            RunnerRole::Historian => "historian",
            RunnerRole::Dreamer => "dreamer",
        }
    }
}

/// One recorded decision: the runner, why it was chosen, and the harness the
/// request came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerChoice {
    pub resolved: ResolvedRunner,
    pub harness: String,
}

impl RunnerChoice {
    pub fn new(resolved: ResolvedRunner, harness: &str) -> Self {
        Self {
            resolved,
            harness: harness.to_string(),
        }
    }

    /// Structured form for status responses. `observed` says whether this is a
    /// completion that actually ran (`last_completion`) or only what the route
    /// would resolve to now (`resolved_for_route`).
    pub fn to_value(&self, observed: &str) -> Value {
        json!({
            "runner": self.resolved.kind.as_str(),
            "source": self.resolved.source.as_str(),
            "harness": self.harness,
            "observed": observed,
        })
    }

    /// Short prose: `host (default for harness opencode)` or `broca (configured)`.
    pub fn describe(&self) -> String {
        match self.resolved.source {
            RunnerSource::Configured => format!(
                "{} ({})",
                self.resolved.kind.as_str(),
                self.resolved.source.describe()
            ),
            RunnerSource::HarnessDefault => format!(
                "{} ({} {})",
                self.resolved.kind.as_str(),
                self.resolved.source.describe(),
                if self.harness.is_empty() {
                    "<unknown>"
                } else {
                    self.harness.as_str()
                }
            ),
        }
    }
}

#[derive(Debug, Default)]
pub struct RunnerChoiceLog {
    choices: HashMap<(RunnerRole, String), RunnerChoice>,
    /// Insertion order of keys, oldest first, for eviction and newest-first listing.
    order: VecDeque<(RunnerRole, String)>,
}

impl RunnerChoiceLog {
    pub fn record(&mut self, role: RunnerRole, session_id: &str, choice: RunnerChoice) {
        let key = (role, session_id.to_string());
        if self.choices.insert(key.clone(), choice).is_some() {
            self.order.retain(|existing| existing != &key);
        }
        self.order.push_back(key);
        while self.order.len() > RUNNER_CHOICE_SESSION_CAP {
            if let Some(evicted) = self.order.pop_front() {
                self.choices.remove(&evicted);
            }
        }
    }

    pub fn get(&self, role: RunnerRole, session_id: &str) -> Option<&RunnerChoice> {
        self.choices.get(&(role, session_id.to_string()))
    }

    /// Health metrics: the newest recorded choices, one row per session and role.
    pub fn health_rows(&self) -> Vec<Value> {
        self.order
            .iter()
            .rev()
            .take(RUNNER_CHOICE_HEALTH_LIST_CAP)
            .filter_map(|key| {
                self.choices.get(key).map(|choice| {
                    json!({
                        "session_id": key.1,
                        "role": key.0.as_str(),
                        "runner": choice.resolved.kind.as_str(),
                        "source": choice.resolved.source.as_str(),
                        "harness": choice.harness,
                    })
                })
            })
            .collect()
    }

    /// Health prose: how many sessions used each runner and why, per role, e.g.
    /// `historian runners: host (default for harness opencode) x2`.
    pub fn health_summary(&self) -> Option<String> {
        let mut counts: Vec<(RunnerRole, String, usize)> = Vec::new();
        for key in &self.order {
            let Some(choice) = self.choices.get(key) else {
                continue;
            };
            let label = choice.describe();
            match counts
                .iter_mut()
                .find(|(role, existing, _)| *role == key.0 && *existing == label)
            {
                Some(entry) => entry.2 += 1,
                None => counts.push((key.0, label, 1)),
            }
        }
        if counts.is_empty() {
            return None;
        }
        let mut parts = Vec::new();
        for role in [RunnerRole::Historian, RunnerRole::Dreamer] {
            let labels = counts
                .iter()
                .filter(|(entry_role, _, _)| *entry_role == role)
                .map(|(_, label, count)| format!("{label} x{count}"))
                .collect::<Vec<_>>();
            if !labels.is_empty() {
                parts.push(format!("{} runners: {}", role.as_str(), labels.join(", ")));
            }
        }
        Some(parts.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::historian_runner::resolve_runner;
    use crate::historian_runner::HistorianRunnerKind;

    fn choice(configured: Option<HistorianRunnerKind>, harness: &str) -> RunnerChoice {
        RunnerChoice::new(resolve_runner(configured, harness), harness)
    }

    #[test]
    fn a_session_reports_the_runner_it_last_used_and_why() {
        let mut log = RunnerChoiceLog::default();
        log.record(RunnerRole::Historian, "ses-a", choice(None, "opencode"));
        log.record(RunnerRole::Historian, "ses-b", choice(None, "claude-code"));
        log.record(
            RunnerRole::Dreamer,
            "ses-a",
            choice(Some(HistorianRunnerKind::Broca), "opencode"),
        );

        let a = log.get(RunnerRole::Historian, "ses-a").unwrap();
        assert_eq!(a.describe(), "host (default for harness opencode)");
        assert_eq!(
            a.to_value("last_completion"),
            json!({
                "runner": "host",
                "source": "default_for_harness",
                "harness": "opencode",
                "observed": "last_completion",
            })
        );
        assert_eq!(
            log.get(RunnerRole::Historian, "ses-b").unwrap().describe(),
            "broca (default for harness claude-code)"
        );
        assert_eq!(
            log.get(RunnerRole::Dreamer, "ses-a").unwrap().describe(),
            "broca (configured)"
        );
        assert_eq!(
            log.health_summary().as_deref(),
            Some(
                "historian runners: host (default for harness opencode) x1, broca (default for harness claude-code) x1; dreamer runners: broca (configured) x1"
            )
        );
        let rows = log.health_rows();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["session_id"], json!("ses-a"));
        assert_eq!(rows[0]["role"], json!("dreamer"));
    }

    #[test]
    fn the_log_forgets_the_oldest_session_first_and_stays_bounded() {
        let mut log = RunnerChoiceLog::default();
        for index in 0..=RUNNER_CHOICE_SESSION_CAP {
            log.record(
                RunnerRole::Historian,
                &format!("ses-{index}"),
                choice(None, "opencode"),
            );
        }
        assert!(log.get(RunnerRole::Historian, "ses-0").is_none());
        assert!(log
            .get(
                RunnerRole::Historian,
                &format!("ses-{RUNNER_CHOICE_SESSION_CAP}")
            )
            .is_some());
        assert_eq!(log.health_rows().len(), RUNNER_CHOICE_HEALTH_LIST_CAP);
        // Re-recording a session moves it to the newest end instead of duplicating it.
        log.record(RunnerRole::Historian, "ses-1", choice(None, "opencode2"));
        assert_eq!(log.health_rows()[0]["session_id"], json!("ses-1"));
        assert_eq!(log.order.len(), RUNNER_CHOICE_SESSION_CAP);
    }
}
