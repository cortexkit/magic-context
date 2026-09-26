//! Which side runs the historian's model call.
//!
//! Everything else about a fold — trigger evaluation, chunk assembly, prompt
//! bytes, validation, discard-last, the publish CAS, marker scheduling and the
//! failure taxonomy — belongs to this module and is identical under both
//! runners. The only pluggable part is the completion itself: prompt in, text
//! out.
//!
//! - [`HistorianRunnerKind::Broca`] opens a route to the `broca` module and
//!   drives the run there. Its requests, retries and published output are the
//!   same as they were before a second runner existed.
//! - [`HistorianRunnerKind::Host`] queues the assembled run for a claimant
//!   outside the module and waits for it to report back. It exists so a project
//!   with no Broca module registered can still fold.
//!
//! Neither runner is a fixed default. When the user tier does not name one, the
//! runner follows the harness that sent the request ([`default_runner_for_harness`]):
//! a harness whose host can run a hidden completion gets the host runner, and
//! anything else keeps Broca.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistorianRunnerKind {
    Broca,
    Host,
}

impl HistorianRunnerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            HistorianRunnerKind::Broca => "broca",
            HistorianRunnerKind::Host => "host",
        }
    }

    /// Parse a configured value. Unknown and empty spellings return `None` so
    /// the caller can warn and keep the default rather than silently rerouting
    /// every completion on a typo.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "broca" => Some(HistorianRunnerKind::Broca),
            "host" => Some(HistorianRunnerKind::Host),
            _ => None,
        }
    }

    /// Named so a config warning can list what the user could have written.
    pub const ACCEPTED_VALUES: [&'static str; 2] = ["broca", "host"];
}

impl fmt::Display for HistorianRunnerKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Route-binding harness names whose host runs the claim-lane pull loop in Rust
/// transform mode: OpenCode 1 (`opencode`) and OpenCode 2 (`opencode2`). Both
/// plugins open their module route with these names.
pub const HOST_RUNNER_HARNESSES: [&str; 2] = ["opencode", "opencode2"];

/// The runner a request gets when the user tier names none.
///
/// Only a harness that can run the completion itself gets the host runner. Claude
/// Code reaches this module through the Thalamus gateway with no host process that
/// could run a hidden completion, so it keeps Broca. Pi and OMP have no Rust
/// transform and open no module route today; if one ever binds, it also keeps
/// Broca rather than queueing runs that nothing on its side would claim. An
/// unknown or empty harness name is treated the same way for the same reason.
pub fn default_runner_for_harness(harness: &str) -> HistorianRunnerKind {
    if HOST_RUNNER_HARNESSES.contains(&harness) {
        HistorianRunnerKind::Host
    } else {
        HistorianRunnerKind::Broca
    }
}

/// Why a request got the runner it got. Reported on the status surfaces so a user
/// can tell a runner they chose from one the harness chose for them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerSource {
    /// The user tier names the runner.
    Configured,
    /// The user tier names none; the harness that sent the request decided.
    HarnessDefault,
}

impl RunnerSource {
    /// Stable wire spelling for structured status fields.
    pub fn as_str(self) -> &'static str {
        match self {
            RunnerSource::Configured => "configured",
            RunnerSource::HarnessDefault => "default_for_harness",
        }
    }

    /// Human wording for status prose.
    pub fn describe(self) -> &'static str {
        match self {
            RunnerSource::Configured => "configured",
            RunnerSource::HarnessDefault => "default for harness",
        }
    }
}

/// A runner decision for one request: which runner, and why.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedRunner {
    pub kind: HistorianRunnerKind,
    pub source: RunnerSource,
}

/// Resolve a runner: an explicit user-tier value always wins; otherwise the
/// harness decides through [`default_runner_for_harness`].
pub fn resolve_runner(configured: Option<HistorianRunnerKind>, harness: &str) -> ResolvedRunner {
    match configured {
        Some(kind) => ResolvedRunner {
            kind,
            source: RunnerSource::Configured,
        },
        None => ResolvedRunner {
            kind: default_runner_for_harness(harness),
            source: RunnerSource::HarnessDefault,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unconfigured_runner_follows_the_harness() {
        for harness in ["opencode", "opencode2"] {
            assert_eq!(
                resolve_runner(None, harness),
                ResolvedRunner {
                    kind: HistorianRunnerKind::Host,
                    source: RunnerSource::HarnessDefault,
                },
                "{harness}"
            );
        }
        // Claude Code has no host that can run a completion; Pi and OMP never
        // bind a Rust route today; anything unrecognised is treated like them.
        for harness in ["claude-code", "pi", "omp", "", "OpenCode", "mc-module-test"] {
            assert_eq!(
                resolve_runner(None, harness),
                ResolvedRunner {
                    kind: HistorianRunnerKind::Broca,
                    source: RunnerSource::HarnessDefault,
                },
                "{harness:?}"
            );
        }
    }

    #[test]
    fn a_configured_runner_wins_on_every_harness() {
        for harness in ["opencode", "opencode2", "claude-code", "pi", ""] {
            for kind in [HistorianRunnerKind::Broca, HistorianRunnerKind::Host] {
                assert_eq!(
                    resolve_runner(Some(kind), harness),
                    ResolvedRunner {
                        kind,
                        source: RunnerSource::Configured,
                    },
                    "{harness:?} {kind}"
                );
            }
        }
    }

    #[test]
    fn runner_values_round_trip_through_their_wire_spelling() {
        for kind in [HistorianRunnerKind::Broca, HistorianRunnerKind::Host] {
            assert_eq!(HistorianRunnerKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(
            HistorianRunnerKind::parse("  HOST "),
            Some(HistorianRunnerKind::Host)
        );
    }

    #[test]
    fn an_unknown_runner_value_is_rejected_rather_than_guessed() {
        for value in ["", "llm-runner", "hosted", "brocaa"] {
            assert_eq!(HistorianRunnerKind::parse(value), None, "value {value:?}");
        }
    }
}
