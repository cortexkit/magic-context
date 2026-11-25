//! Account refusals and waits shared by the summarizer and dreamer.
//!
//! A runner's `account_limit_exhausted` or `account_selection_refused` is
//! about an account on one route. Whether it refuses the send, ends the run,
//! or pauses a started run (which we cancel), select again on the same ladder.
//! Routing can pick another account for the same model or fall through to
//! another model. Exclude a model only when the fresh decision repeats the
//! refused account, or one unidentifiable same-model send is refused again.
//! At most four distinct routes can refuse before the work parks.
//! Routing's own refusal parks the work until its reset; the runner's time
//! is only a last resort when the bounded re-select cannot find a usable
//! route or a routing reset. `account_selection_final` remains a failure.
//!
//! Capacity holds (`concurrency_full`) still wait, including through a
//! runner's pause, and person-owned waits still use the default duration.
//! Never repeat a prompt in a child whose run began. A first turn or dreamer
//! task starts in a fresh child; a second turn or fact check requeues its
//! unresolved facts for a later summary's second turn without parking the lane.

use cortexkit_role_llm_runner::awaits::AwaitParty;
use cortexkit_role_llm_runner::errors;
use cortexkit_role_llm_runner::run::{RunError, RunReason, RunResult};
use cortexkit_role_routing::report::Outcome;
use cortexkit_role_routing::select::{SelectAnswer, SelectRequest};
use serde_json::Value;
use tokio::time::{timeout_at, Instant};

use crate::routing::{self, Router};

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
const MAX_RESELECT_WAIT_MS: i64 = 15 * 60 * 1000;
const MAX_REFUSED_ROUTES: usize = 4;
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
    /// A dreamer task's run (`crate::dreamer`).
    Dream,
}

impl SendKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::TurnOne => "summary turn one",
            Self::TurnTwo => "summary turn two",
            Self::FactCheck => "memory fact check",
            Self::Dream => "dreamer task",
        }
    }

    /// The `session_class` the send that creates its child asks for, where
    /// the runner declares classes: runners keep and back up a class's
    /// sessions by their own policy for it.
    pub fn session_class(self) -> &'static str {
        match self {
            Self::TurnOne | Self::TurnTwo | Self::FactCheck => "summary",
            Self::Dream => "dream",
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
    /// Present only when a runner refused an account, not when routing or a person is waiting.
    pub(crate) refusal: Option<RunnerAccountRefusal>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RunnerAccountRefusal {
    credential_id: Option<String>,
}

fn runner_refusal(code: &str, credential_id: Option<&str>) -> Option<RunnerAccountRefusal> {
    errors::is_account_wait(code).then(|| RunnerAccountRefusal {
        credential_id: credential_id.map(str::to_owned),
    })
}

impl AccountWait {
    /// Routing can refuse before any child starts. A stated recovery time
    /// wins for any reason; only quota, blocked accounts and full capacity
    /// wait without one. Routing always states a time for full capacity
    /// (`concurrency_full`), but a refusal that leaves it out still means
    /// wait, so it waits [`DEFAULT_WAIT_MS`].
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
                Some(
                    NoRouteReason::QuotaOrCooldown
                        | NoRouteReason::AccountsBlocked
                        | NoRouteReason::ConcurrencyFull
                )
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
            refusal: None,
        })
    }

    /// The wait a refused `session.send` names, from the error body's outer
    /// `code` and its `detail`. Only the outer code decides whether it is a
    /// wait (an account wait or routing's full capacity); the detail only
    /// says how long.
    pub fn of_refusal(
        code: &str,
        detail: Option<&Value>,
        send: SendKind,
        now_ms: i64,
    ) -> Option<Self> {
        if !errors::is_wait(code) {
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
            refusal: runner_refusal(code, detail.get("credential_id").and_then(Value::as_str)),
        })
    }

    /// The wait the error of a run that ended `error` names: a send the
    /// runner accepted and then refused at the run's own admission, or a run
    /// whose account ran out, or whose route was at full capacity, on the
    /// way.
    pub fn of_run_error(error: &RunError, send: SendKind, now_ms: i64) -> Option<Self> {
        if !errors::is_wait(&error.provider_code) {
            return None;
        }
        Some(Self {
            code: error.provider_code.clone(),
            until_ms: until(now_ms, error.retry_after_secs, error.resets_at_ms),
            at_ms: now_ms,
            send,
            // A run error may name an account_ref, but routing's answer
            // names a credential_id. They are not comparable identifiers.
            refusal: runner_refusal(&error.provider_code, None),
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
            refusal: None,
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
            refusal: None,
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

    /// A pause the caller will not wait through. The runner's exact
    /// resume floor takes priority over the error's retry hint or reset.
    /// The typed pause reason distinguishes account limits from capacity.
    /// Older runners that omit it can still name the wait in a provider code.
    pub fn of_paused_run(
        paused: &RunResult,
        resume_not_before_ms: Option<u64>,
        send: SendKind,
        now_ms: i64,
    ) -> Option<Self> {
        if let Some(wait) = Self::of_person(paused, send, now_ms) {
            return Some(wait);
        }
        let error = paused.error.as_ref();
        let code = error.map(|error| error.provider_code.as_str());
        let code = match paused.reason.clone().map(RunReason::from) {
            Some(RunReason::AccountLimit) => code
                .filter(|code| errors::is_account_wait(code))
                .unwrap_or(errors::ACCOUNT_LIMIT_EXHAUSTED),
            Some(RunReason::ConcurrencyFull) => errors::CONCURRENCY_FULL,
            _ => code.filter(|code| errors::is_wait(code))?,
        };
        let until_ms = if let Some(resume) = caller_next_ms(paused).or(resume_not_before_ms) {
            until(now_ms, None, Some(resume))
        } else {
            until(
                now_ms,
                error.and_then(|error| error.retry_after_secs),
                error.and_then(|error| error.resets_at_ms),
            )
        };
        Some(Self {
            code: code.to_owned(),
            at_ms: now_ms,
            until_ms,
            send,
            refusal: runner_refusal(code, None),
        })
    }
}

/// Account recovery for one summary or task batch, independent of ordinary
/// model fallbacks. A new invocation after a wait starts with no refusals.
#[derive(Default)]
pub(crate) struct Reselect {
    refused: Vec<RefusedRoute>,
    excluded: Option<String>,
}

struct RefusedRoute {
    model: String,
    credential_id: Option<String>,
}

impl Reselect {
    fn known_repeat(&self, model: &str, answer: &SelectAnswer) -> bool {
        credential(answer).is_some_and(|credential| {
            self.refused.iter().any(|prior| {
                prior.model == model && prior.credential_id.as_deref() == Some(credential)
            })
        })
    }

    pub(crate) fn exclusions(&self, mut request: SelectRequest) -> SelectRequest {
        if let Some(model) = &self.excluded {
            let exclude = request.exclude.get_or_insert_with(Vec::new);
            if !exclude.contains(model) {
                exclude.push(model.clone());
            }
        }
        request
    }

    /// The caller has settled `refused`. An answer discarded without a send
    /// also needs settling; otherwise its decision can hold routing capacity.
    pub(crate) async fn after_refusal<C: Router>(
        &mut self,
        client: &C,
        request: SelectRequest,
        refused: &SelectAnswer,
        wait: AccountWait,
        deadline: Instant,
    ) -> Result<SelectAnswer, AccountWait> {
        let Some(refusal) = &wait.refusal else {
            return Err(wait);
        };
        if self.excluded.is_some() {
            // The exclusion already gave the ladder one last chance.
            return Err(wait);
        }
        let model = refused.route.route_key();
        let refused_credential = refusal
            .credential_id
            .as_deref()
            .or_else(|| credential(refused));
        let repeats = self.refused.iter().any(|prior| {
            prior.model == model
                && match (prior.credential_id.as_deref(), refused_credential) {
                    (Some(before), Some(after)) => before == after,
                    // The first unknown answer gets one send. A second refusal
                    // of the same model is enough to try the exclusion.
                    _ => true,
                }
        });
        let model = if repeats {
            model
        } else {
            self.refused.push(RefusedRoute {
                model,
                credential_id: refused_credential.map(str::to_owned),
            });
            if self.refused.len() >= MAX_REFUSED_ROUTES {
                return Err(wait);
            }
            let fresh = select_again(client, request.clone(), &wait, deadline).await?;
            let model = fresh.route.route_key();
            if !self.known_repeat(&model, &fresh) {
                return Ok(fresh);
            }
            cancel_decision(client, &fresh, deadline).await;
            model
        };
        self.excluded = Some(model.clone());
        let fresh = select_again(client, self.exclusions(request), &wait, deadline).await?;
        let selected = fresh.route.route_key();
        if selected == model || self.known_repeat(&selected, &fresh) {
            cancel_decision(client, &fresh, deadline).await;
            return Err(wait);
        }
        Ok(fresh)
    }
}

fn credential(answer: &SelectAnswer) -> Option<&str> {
    answer.runner.auth.as_ref()?.credential_id.as_deref()
}

async fn cancel_decision<C: Router>(client: &C, answer: &SelectAnswer, deadline: Instant) {
    let report = routing::report(&answer.decision_id, Outcome::Cancelled, None);
    let _ = timeout_at(deadline, client.report(report)).await;
}

async fn select_again<C: Router>(
    client: &C,
    request: SelectRequest,
    fallback: &AccountWait,
    deadline: Instant,
) -> Result<SelectAnswer, AccountWait> {
    if Instant::now() >= deadline {
        return Err(fallback.clone());
    }
    match timeout_at(deadline, client.select(request)).await {
        Ok(Ok(answer)) => Ok(answer),
        Ok(Err(error)) => {
            let now = now_ms();
            let reset = error
                .detail
                .as_ref()
                .and_then(|detail| detail.get("reset_at_ms"))
                .and_then(Value::as_u64);
            if let (Some(reset), Some(mut wait)) =
                (reset, AccountWait::of_routing(&error, fallback.send, now))
            {
                let reset = i64::try_from(reset).unwrap_or(i64::MAX);
                if reset > now {
                    wait.until_ms = reset.min(now.saturating_add(MAX_RESELECT_WAIT_MS));
                }
                return Err(wait);
            }
            Err(fallback.clone())
        }
        Err(_) => Err(fallback.clone()),
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
