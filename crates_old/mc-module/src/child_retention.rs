//! Retention and release for the child sessions ck-mc starts on an llm-runner
//! (historian summaries and dreamer tasks).
//!
//! A child's result is consumed once and never read again, so ck-mc asks the
//! runner to keep nothing (llm-runner §9.14 `session_retention`) and releases
//! the child once its result is consumed. Which retention member a send
//! carries depends only on the groups the runner's `role.describe` declares:
//!
//! - `session_retention` declared: send `retention_policy` and never
//!   `retention`, whatever the group's `required` limit says;
//! - only the older `retention` group declared: send `retention` seconds as
//!   before;
//! - neither: send no retention member.
//!
//! A runner refuses a send carrying both members, so no send ever does.
//!
//! Release is one `session.release {}` call per child. Its answer (`pending`,
//! `deleted` or `absent`) is final: pending deletion is durable on the runner.
//! A refusal or a call that never answered is logged once and not retried; the
//! runner deletes an unreleased keep-nothing child `max_unreleased_hold_ms`
//! after its last run ends.

use cortexkit_role_llm_runner::capabilities as caps;
use cortexkit_role_llm_runner::session_retention::{
    Keep, ReleaseReply, ReleaseState, RetentionPolicy,
};
use serde_json::Value;

/// The `session.release` op name.
pub(crate) const SESSION_RELEASE: &str = cortexkit_role_llm_runner::ops::SESSION_RELEASE;

/// The retention a child's `session.send` carries: at most one member.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ChildRetention {
    /// `retention_policy`: [`child_policy`].
    Policy,
    /// `retention`, in seconds.
    Seconds(u64),
    /// No retention member.
    Nothing,
}

impl ChildRetention {
    /// The `retention` seconds to send, if any.
    pub(crate) fn seconds(self) -> Option<u64> {
        match self {
            Self::Seconds(seconds) => Some(seconds),
            _ => None,
        }
    }

    /// The `retention_policy` to send, if any.
    pub(crate) fn policy(self) -> Option<RetentionPolicy> {
        (self == Self::Policy).then(child_policy)
    }
}

/// Which retention member a child's sends carry, chosen from the groups the
/// runner declares.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RetentionMember {
    /// `session_retention` is declared: send `retention_policy`.
    Policy,
    /// Only `retention` is declared: send `retention` seconds.
    Seconds,
    /// Neither group is declared: send no retention member.
    Nothing,
}

/// Pick the member from the declared groups. `session_retention` wins when a
/// runner declares both, as llm-runner §9.14 requires of a starter.
pub(crate) fn member(declares: impl Fn(&str) -> bool) -> RetentionMember {
    if declares(caps::SESSION_RETENTION) {
        RetentionMember::Policy
    } else if declares(caps::RETENTION) {
        RetentionMember::Seconds
    } else {
        RetentionMember::Nothing
    }
}

/// [`member`] over a raw `role.describe` answer's `capabilities` array.
pub(crate) fn member_of_describe(answer: &Value) -> RetentionMember {
    let groups = answer.get("capabilities").and_then(Value::as_array);
    member(|group| groups.is_some_and(|groups| groups.iter().any(|g| g.as_str() == Some(group))))
}

/// The policy every ck-mc child is sent: keep nothing, never archive, no
/// backup, no request dumps. The child is deleted when it is released.
pub(crate) fn child_policy() -> RetentionPolicy {
    RetentionPolicy::new(Keep::none(), 0, false, false)
}

/// What a child's one `session.release` call came to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ReleaseOutcome {
    /// The runner answered `pending`, `deleted`, `absent` (or a state newer
    /// than this build knows).
    Answered(ReleaseState),
    /// The runner refused the call with this code and detail.
    Refused { code: String, detail: Value },
    /// No usable answer arrived: a transport failure, a timeout or an answer
    /// that is not a release reply.
    Unanswered(String),
}

impl ReleaseOutcome {
    /// Decode the answer inside the runner's reply envelope.
    pub(crate) fn from_answer(answer: &Value) -> Self {
        match serde_json::from_value::<ReleaseReply>(answer.clone()) {
            Ok(reply) => Self::Answered(reply.state),
            Err(error) => Self::Unanswered(format!("unrecognized release answer: {error}")),
        }
    }
}

/// Log a child's release outcome. Each child is released exactly once, so
/// each outcome is logged once; nothing here retries.
pub(crate) fn log_release(kind: &str, parent: &str, child: &str, outcome: &ReleaseOutcome) {
    let line = match outcome {
        ReleaseOutcome::Answered(state) => {
            let state: String = state.clone().into();
            format!("[mc-module] {kind} child {child} of {parent} released: {state}")
        }
        ReleaseOutcome::Refused { code, detail } => format!(
            "[mc-module] {kind} child {child} of {parent} release refused {code}: {detail}; \
             not retried, the runner's unreleased hold deletes it"
        ),
        ReleaseOutcome::Unanswered(reason) => format!(
            "[mc-module] {kind} child {child} of {parent} release got no answer: {reason}; \
             not retried, the runner's unreleased hold deletes it"
        ),
    };
    match outcome {
        ReleaseOutcome::Answered(_) => tracing::info!("{line}"),
        _ => tracing::warn!("{line}"),
    }
    #[cfg(test)]
    RELEASE_LOG.lock().unwrap().push(line);
}

/// Every release line logged in this test process, so tests can count the
/// lines naming their own child.
#[cfg(test)]
pub(crate) static RELEASE_LOG: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// The release lines logged for `child`.
#[cfg(test)]
pub(crate) fn release_lines(child: &str) -> Vec<String> {
    let needle = format!(" child {child} ");
    RELEASE_LOG
        .lock()
        .unwrap()
        .iter()
        .filter(|line| line.contains(&needle))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_declared_group_picks_the_member() {
        let describe = |groups: &[&str]| json!({ "capabilities": groups });
        assert_eq!(
            member_of_describe(&describe(&["session_retention"])),
            RetentionMember::Policy
        );
        assert_eq!(
            member_of_describe(&describe(&["retention", "session_retention"])),
            RetentionMember::Policy
        );
        assert_eq!(
            member_of_describe(&describe(&["retention"])),
            RetentionMember::Seconds
        );
        assert_eq!(
            member_of_describe(&describe(&["queue"])),
            RetentionMember::Nothing
        );
        assert_eq!(member_of_describe(&json!({})), RetentionMember::Nothing);
    }

    #[test]
    fn the_child_policy_keeps_nothing_and_is_accepted_by_the_crate() {
        assert_eq!(
            serde_json::to_value(child_policy()).unwrap(),
            json!({"keep":"none","archive_after_days":0,"backup":false,"request_dumps":false})
        );
        child_policy().check(1).unwrap();
    }

    #[test]
    fn release_answers_decode_and_anything_else_is_unanswered() {
        for state in ["pending", "deleted", "absent"] {
            assert_eq!(
                ReleaseOutcome::from_answer(&json!({ "state": state })),
                ReleaseOutcome::Answered(ReleaseState::parse(state))
            );
        }
        assert!(matches!(
            ReleaseOutcome::from_answer(&json!({"ok": true})),
            ReleaseOutcome::Unanswered(_)
        ));
    }
}
