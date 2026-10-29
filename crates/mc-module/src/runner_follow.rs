//! Shared discovery, polling interval and stream-event wake predicate for background runs.

use cortexkit_role_llm_runner::capabilities as caps;
use serde_json::Value;
use std::time::Duration;

#[cfg(test)]
pub(crate) mod held_calls;

/// Four status probes per second while a stream is quiet bound completion latency
/// without a tight polling loop.
pub(crate) const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Treat stream events whose kind is control only as wake hints. Their
/// runner-specific bodies are neither answers nor terminal-state signals.
pub(crate) fn control_wake(event: &Value) -> bool {
    event.get("kind").and_then(Value::as_str) == Some("control")
}

#[derive(Clone, Copy, Default)]
pub(crate) struct FollowCapabilities {
    pub run_ops: bool,
    pub run_status: bool,
    pub streaming: bool,
    pub run_usage: bool,
}

impl FollowCapabilities {
    /// The follow groups `answer` declares. `answer` is the `role.describe`
    /// answer inside the runner's reply envelope: the envelope is read, strictly,
    /// by `session_resolver::read_runner_reply` before this.
    pub fn from_describe(answer: &Value) -> Self {
        let declares = |name| {
            answer["capabilities"]
                .as_array()
                .is_some_and(|groups| groups.iter().any(|group| group.as_str() == Some(name)))
        };
        Self {
            run_ops: declares(caps::RUN_OPS),
            run_status: declares(caps::RUN_STATUS),
            streaming: declares(caps::STREAMING),
            run_usage: declares(caps::RUN_USAGE),
        }
    }

    pub fn missing(self) -> Option<&'static str> {
        if !self.run_ops {
            Some("background_runner_missing_groups: run_ops")
        } else if !self.run_status {
            Some("background_runner_missing_groups: run_status")
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The groups are read from the answer only. A reply envelope is removed,
    /// strictly, before this (a bare reply never gets here: see
    /// `historian_producer`'s `a_bare_role_describe_reply_is_refused_by_name_before_any_send`),
    /// so an envelope that reaches this reader is not peeled.
    #[test]
    fn follow_groups_are_read_from_the_answer_and_an_envelope_is_not_peeled() {
        let answer = json!({"capabilities":["run_ops","run_status","streaming","run_usage"]});
        let read = FollowCapabilities::from_describe(&answer);
        assert!(read.run_ops && read.run_status && read.streaming && read.run_usage);
        assert_eq!(read.missing(), None);
        let enveloped = FollowCapabilities::from_describe(&json!({ "result": answer }));
        assert_eq!(
            enveloped.missing(),
            Some("background_runner_missing_groups: run_ops")
        );
    }
}
