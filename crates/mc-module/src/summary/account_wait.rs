//! A runner's account or person-owned wait during a summarizer send.
//!
//! A runner that picks the provider account when a send arrives refuses the
//! send with `account_limit_exhausted` or `account_selection_refused` when no
//! account has room (llm-runner contract §12.1). A run can also end `error`
//! with one of those codes as its `provider_code`: a send queued behind
//! another run and refused at its own admission, or a runner that picks an
//! account per model request. A runner may also pause a run for an account
//! limit and resume it by itself: ck-mc waits through the pause, and a run
//! still paused at its deadline whose reason or run error names an account wait is
//! cancelled and ends as that wait. In every case the contract forbids failing the
//! work for it and forbids asking the same account again before the time
//! the runner names, so a summary that meets it waits instead of counting as
//! failed. `account_selection_final` is no wait: waiting cannot change it,
//! and it fails as any other refusal does.
//!
//! The wait lasts the runner's named time, at least a minute and at most six
//! hours after the refusal, so a hint of zero or a stale reset cannot start
//! a new run on every notice.
//! A typed person-owned wait also uses this machinery, but always with the
//! default duration: a sign-in or approval has no known completion time.
//!
//! A wait never sends the same prompt into a child whose run began, which
//! would put it in that child's transcript twice: the summary's first turn
//! starts again later in a new child, and a second turn or fact check gives
//! its facts back to a later second turn in that run's own child.

use cortexkit_role_llm_runner::awaits::AwaitParty;
use cortexkit_role_llm_runner::errors;
use cortexkit_role_llm_runner::run::{RunError, RunResult};
use serde_json::Value;

/// How long summaries wait when the runner names no time. The contract
/// leaves that wait to the caller and only forbids sending again at once.
pub const DEFAULT_WAIT_MS: i64 = 5 * 60 * 1000;
/// The longest wait honoured. A runner may name a weekly quota reset days
/// away, while the account can be topped up or switched long before that:
/// once this has passed, one run is tried, and its answer names the next
/// time if the account is still out.
pub const MAX_WAIT_MS: i64 = 6 * 60 * 60 * 1000;
/// Routing probes reach no model and create no child. They may be retried
/// sooner than runner sends, since a manual reset or sign-in can restore a
/// route before its stated reset time.
pub const MAX_ROUTING_WAIT_MS: i64 = 60 * 60 * 1000;
/// The shortest wait. A hint of zero, or a reset time already past (a
/// runner with a stale clock or quota record), would otherwise let every
/// notice start a new summarizer run against the same accounts, with no
/// failure ever counted to slow it down.
pub const MIN_WAIT_MS: i64 = 60 * 1000;

/// Which summarizer send met the refusal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendKind {
    /// The send that asks for the summary itself: the two-pass historian's
    /// first turn.
    TurnOne,
    /// The two-pass historian's second turn, which reconciles candidate
    /// facts with project memory.
    TurnTwo,
    /// A narrow check the second turn runs before revising a memory.
    FactCheck,
}

impl SendKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::TurnOne => "summary turn one",
            Self::TurnTwo => "summary turn two",
            Self::FactCheck => "memory fact check",
        }
    }
}

/// A send the runner held back until an account has room.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountWait {
    /// The contract code that named the wait.
    pub code: String,
    /// No summarizer send goes out before this, in milliseconds since the
    /// Unix epoch.
    pub until_ms: i64,
    /// When the refusal was received, in milliseconds since the Unix epoch.
    /// A session ignores a refusal older than its last served summarizer
    /// run: the accounts had room again by then.
    pub at_ms: i64,
    pub send: SendKind,
}

impl AccountWait {
    /// Routing can refuse before any child starts. A stated recovery time
    /// wins for any reason; only quota or blocked accounts wait without one.
    pub fn of_routing(
        error: &crate::routing::RouteError,
        send: SendKind,
        now_ms: i64,
    ) -> Option<Self> {
        use cortexkit_role_routing::errors::NoRouteReason;

        let detail = error.detail.as_ref().unwrap_or(&Value::Null);
        // Decode independently: a malformed reason must not discard a usable
        // reset, nor a malformed reset hide a known temporary reason.
        let reason = detail
            .get("reason")
            .cloned()
            .and_then(|reason| serde_json::from_value::<NoRouteReason>(reason).ok());
        let reset = detail.get("reset_at_ms").and_then(Value::as_u64);
        if reset.is_none()
            && !matches!(
                reason,
                Some(NoRouteReason::QuotaOrCooldown | NoRouteReason::AccountsBlocked)
            )
        {
            return None;
        }
        let code = match reason {
            Some(reason) => format!("{}:{}", error.code, reason.as_str()),
            None => error.code.clone(),
        };
        Some(Self {
            code,
            until_ms: until(now_ms, None, reset).min(now_ms.saturating_add(MAX_ROUTING_WAIT_MS)),
            at_ms: now_ms,
            send,
        })
    }

    /// The wait a refused `session.send` names, from the error body's outer
    /// `code` and its `detail`. Only the outer code decides whether it is an
    /// account wait; the detail only says how long.
    pub fn of_refusal(
        code: &str,
        detail: Option<&Value>,
        send: SendKind,
        now_ms: i64,
    ) -> Option<Self> {
        if !errors::is_account_wait(code) {
            return None;
        }
        let detail = detail.unwrap_or(&Value::Null);
        // `retry_after_secs` is the float twin of the whole seconds in
        // `retry_after_s`; the contract sends both or neither.
        let seconds = detail
            .get("retry_after_secs")
            .and_then(Value::as_f64)
            .or_else(|| detail.get("retry_after_s").and_then(Value::as_f64));
        let reset = detail.get("resets_at_ms").and_then(Value::as_u64);
        Some(Self {
            code: code.to_owned(),
            until_ms: until(now_ms, seconds, reset),
            at_ms: now_ms,
            send,
        })
    }

    /// The wait the error of a run that ended `error` names: a send the
    /// runner accepted and then refused at the run's own admission, or a run
    /// whose account ran out on the way.
    pub fn of_run_error(error: &RunError, send: SendKind, now_ms: i64) -> Option<Self> {
        if !errors::is_account_wait(&error.provider_code) {
            return None;
        }
        Some(Self {
            code: error.provider_code.clone(),
            until_ms: until(now_ms, error.retry_after_secs, error.resets_at_ms),
            at_ms: now_ms,
            send,
        })
    }

    /// A person cannot be given a retry deadline. Reuse the bounded default
    /// account wait so a sign-in never spends a summary attempt.
    pub fn of_person(run: &RunResult, send: SendKind, now_ms: i64) -> Option<Self> {
        (run.awaits.as_ref()?.party == AwaitParty::Person).then(|| Self {
            code: run
                .error
                .as_ref()
                .map_or_else(|| "person".to_owned(), |error| error.provider_code.clone()),
            until_ms: until(now_ms, None, None),
            at_ms: now_ms,
            send,
        })
    }

    /// A caller-owned transient that cannot be retried in this call still
    /// names a floor for the next summary, rather than a failed attempt.
    pub fn retry_at(next_ms: u64, send: SendKind, now_ms: i64) -> Self {
        Self {
            code: errors::TRANSIENT.to_owned(),
            until_ms: until(now_ms, None, Some(next_ms)),
            at_ms: now_ms,
            send,
        }
    }

    pub fn of_ended_run(run: &RunResult, send: SendKind, now_ms: i64) -> Option<Self> {
        Self::of_person(run, send, now_ms).or_else(|| {
            let mut wait = Self::of_run_error(run.error.as_ref()?, send, now_ms)?;
            if let Some(next) = caller_next_ms(run) {
                wait.until_ms = until(now_ms, None, Some(next));
            }
            Some(wait)
        })
    }

    /// A pause still present at the caller's deadline. The runner's exact
    /// resume floor takes priority over the error's retry hint or reset.
    /// Older runners name only the provider code, so keep accepting it.
    pub fn of_paused_run(
        paused: &RunResult,
        resume_not_before_ms: Option<u64>,
        send: SendKind,
        now_ms: i64,
    ) -> Option<Self> {
        if let Some(wait) = Self::of_person(paused, send, now_ms) {
            return Some(wait);
        }
        let fallback = paused
            .error
            .as_ref()
            .and_then(|error| Self::of_run_error(error, send, now_ms));
        let wait = fallback.or_else(|| {
            (paused.reason.as_deref() == Some("account_limit")).then(|| Self {
                code: errors::ACCOUNT_LIMIT_EXHAUSTED.to_owned(),
                until_ms: until(
                    now_ms,
                    paused
                        .error
                        .as_ref()
                        .and_then(|error| error.retry_after_secs),
                    paused.error.as_ref().and_then(|error| error.resets_at_ms),
                ),
                at_ms: now_ms,
                send,
            })
        });
        wait.map(|mut wait| {
            if let Some(resume) = caller_next_ms(paused).or(resume_not_before_ms) {
                wait.until_ms = until(now_ms, None, Some(resume));
            }
            wait
        })
    }
}

/// Only a caller-owned wait changes the caller's retry floor. Runner-owned
/// times describe work the runner will do, not permission to send again.
pub fn caller_next_ms(run: &RunResult) -> Option<u64> {
    run.awaits
        .as_ref()
        .filter(|wait| wait.party == AwaitParty::Caller)
        .and_then(|wait| wait.next_ms)
}

/// When summaries may be sent again after a refusal received at `now_ms`.
/// The contract puts the relative hint first, because routing names when to
/// ask again and a quota reset can be later than a useful probe; then the
/// reset instant; then the caller's own wait. The result is at least
/// [`MIN_WAIT_MS`] and at most [`MAX_WAIT_MS`] after `now_ms`.
pub fn until(now_ms: i64, retry_after_secs: Option<f64>, resets_at_ms: Option<u64>) -> i64 {
    let named = match (
        retry_after_secs.filter(|seconds| seconds.is_finite() && *seconds >= 0.0),
        resets_at_ms,
    ) {
        (Some(seconds), _) => {
            now_ms.saturating_add((seconds * 1000.0).ceil().min(i64::MAX as f64) as i64)
        }
        (None, Some(reset)) => i64::try_from(reset).unwrap_or(i64::MAX),
        (None, None) => now_ms.saturating_add(DEFAULT_WAIT_MS),
    };
    named.clamp(
        now_ms.saturating_add(MIN_WAIT_MS),
        now_ms.saturating_add(MAX_WAIT_MS),
    )
}

/// What a session keeps while its summaries wait for an account. It lives in
/// memory only: after a restart the wait is forgotten, and the next trigger
/// tries once and gets a fresh answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Waiting {
    pub refusal: AccountWait,
    /// A run skipped because of this wait has been logged.
    pub skip_logged: bool,
    /// The newest message when a run last started inside this wait at
    /// emergency usage. Another such run needs newer history, so a session
    /// whose turns cannot proceed does not ask again on every pass.
    pub emergency_at: Option<String>,
}

impl Waiting {
    pub fn new(refusal: AccountWait, emergency_at: Option<String>) -> Self {
        Self {
            refusal,
            skip_logged: false,
            emergency_at,
        }
    }

    pub fn holds(&self, now_ms: i64) -> bool {
        now_ms < self.refusal.until_ms
    }
}

/// The wall clock in milliseconds since the Unix epoch, the clock the
/// runner's reset times use.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

#[cfg(test)]
#[path = "account_wait_vectors_tests.rs"]
mod vectors_tests;
