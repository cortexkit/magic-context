//! The async decision log: one INFO line for every advance notice and every
//! ride, saying what ck-mc decided and why.
//!
//! A notice is decided `execute` (its engine pass published a new view) or
//! `defer` (it published nothing: the engine deferred, or there was no work
//! to run the engine for). A ride is decided `ride` (a rewrite cause:
//! `ttl_expired`, `model_change`, `account_change` or `surface_change`) or
//! `ceiling`. Every line carries the usage figure the decision saw, the
//! execute threshold it was compared with, and whether a finished summary is
//! waiting to be published. The lines are logging only: computing them reads
//! the store but writes nothing and changes no byte ck-mc sends.
//!
//! An account label is opaque and may only be compared, never shown, so a
//! line names the `account_change` event or cause and never its label.
use super::*;

/// What one engine pass decided, kept on the record (not stored) until the
/// decision line for the operation that ran it is written.
#[derive(Clone, Debug)]
pub(super) struct Pass {
    /// The engine's scheduler action for the pass.
    pub action: String,
    /// Why the engine materialized, when it says.
    pub reason: Option<String>,
    /// The pass ran as a rebuild: a ride, or held copies the runner pruned.
    pub rebuild: bool,
    /// The rebuild came from held copies the runner pruned at rest.
    pub pruned_rebuild: bool,
    /// The pass published a new view.
    pub published: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Decision {
    Execute,
    Defer,
    Ride,
    Ceiling,
}

impl Decision {
    fn name(self) -> &'static str {
        match self {
            Self::Execute => "execute",
            Self::Defer => "defer",
            Self::Ride => "ride",
            Self::Ceiling => "ceiling",
        }
    }
}

/// The figures a decision is compared on, read when it is made.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct Facts {
    /// Request tokens as a share of the context window, in percent.
    pub usage_percent: Option<f64>,
    /// The execute threshold for the session's model, in percent.
    pub threshold_percent: Option<f64>,
    /// A finished summary covers messages no published view covers yet.
    pub summary_waiting: Option<bool>,
}

/// The name of a notice event as a decision line shows it: the token, except
/// that `account_change` loses its opaque label.
pub(super) fn event_name(event: &notice::Event) -> String {
    match event {
        notice::Event::AccountChange(_) => "account_change".into(),
        other => other.token(),
    }
}

/// One decision line.
pub(super) fn line(
    session_ref: &str,
    operation: &str,
    decision: Decision,
    why: &str,
    facts: &Facts,
    events: &[String],
) -> String {
    let percent =
        |value: Option<f64>| value.map_or_else(|| "unknown".to_owned(), |v| format!("{v:.1}%"));
    let waiting = facts
        .summary_waiting
        .map_or_else(|| "unknown".to_owned(), |waiting| waiting.to_string());
    let mut line = format!(
        "async decision {decision} session_ref={session_ref} {operation} why={why} usage={usage} threshold={threshold} summary_waiting={waiting}",
        decision = decision.name(),
        usage = percent(facts.usage_percent),
        threshold = percent(facts.threshold_percent),
    );
    if !events.is_empty() {
        line.push_str(&format!(" events=[{}]", events.join(",")));
    }
    line
}

/// Whether a finished summary waits: the newest compartment ends past the
/// last ordinal a published view covers (or nothing is covered yet).
pub(super) fn summary_waiting(newest_end: i64, coverage: Option<u64>) -> bool {
    coverage.is_none_or(|covered| newest_end > covered as i64)
}

/// Why a notice's engine pass decided what it did.
pub(super) fn pass_why(pass: &Pass) -> String {
    let mut why = format!("engine_{}", pass.action);
    if let Some(reason) = &pass.reason {
        why.push(':');
        why.push_str(reason);
    }
    if pass.pruned_rebuild {
        why.push_str("+pruned_reasoning_rebuild");
    } else if pass.rebuild {
        why.push_str("+rebuild");
    }
    why
}

/// Whether decision lines are wanted: INFO is enabled for this module's
/// target. When it is not, no figure is read for them. Test builds always
/// keep them, so tests can read the lines without installing a subscriber.
pub(super) fn enabled() -> bool {
    cfg!(test) || tracing::enabled!(tracing::Level::INFO)
}

impl McHandler {
    /// The usage, threshold and waiting-summary figures for `state` as its
    /// latest notice left them. A figure that cannot be read is `None`; with
    /// decision lines disabled nothing is read and every figure is `None`.
    ///
    /// This runs on every notice, so it reads a fixed amount whatever the
    /// session's size: the record's own conditions, the meta row's coverage,
    /// and the newest compartment's end in one index probe.
    pub(super) fn decision_facts(&self, state: &State) -> Facts {
        if !enabled() {
            return Facts::default();
        }
        let notice = state
            .conditions
            .as_ref()
            .and_then(|headers| notice::AdvanceNotice::from_headers(headers).ok());
        let model = notice
            .as_ref()
            .map_or(state.setup.model.as_str(), |notice| notice.model.as_str());
        let window = state
            .usage_policy
            .as_ref()
            .and_then(|policy| policy.limit_for(model))
            .or(notice.as_ref().and_then(|notice| notice.window))
            .or(state.setup.context_window)
            .filter(|window| *window > 0);
        let usage_percent = notice
            .as_ref()
            .zip(window)
            .map(|(notice, window)| notice.est_tokens as f64 * 100.0 / window as f64);
        let threshold_percent = Some(
            self.effective_config(state.project())
                .resolve_execute_threshold(Some(model))
                .percentage,
        );
        let summary_waiting = self.store.get().and_then(|store| {
            let namespace = state.namespace();
            let Some(end) = store.newest_compartment_end(&namespace).ok()? else {
                return Some(false);
            };
            let coverage = store.load_meta(&namespace).ok()?.meta.coverage_ordinal;
            Some(summary_waiting(end, coverage))
        });
        Facts {
            usage_percent,
            threshold_percent,
            summary_waiting,
        }
    }

    /// Write one decision line at INFO, and keep it for tests.
    pub(super) fn log_decision(&self, line: String) {
        if !enabled() {
            return;
        }
        tracing::info!("{line}");
        #[cfg(test)]
        self.provider_store
            .async_runtime
            .decision_lines
            .lock()
            .expect("decision lines")
            .push(line);
    }
}
