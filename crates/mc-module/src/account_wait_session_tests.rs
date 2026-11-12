//! A session whose summarizer met the runner's account wait: no failure is
//! recorded, no summary run starts before the runner's time, and the work a
//! summary would have carried lands without it.

use super::*;
use crate::summary::account_wait::{now_ms, AccountWait, SendKind};
use cortexkit_role_compaction::read::StepUsage;
use serde_json::json;

/// A head session at its execute threshold (20% of a 100,000-token usable
/// window) with history worth a summary, and a queued drop on an early
/// message.
fn ready() -> (Session, Client, Settings) {
    let (mut session, client, _, _, _) = fixture();
    let mut settings = crate::config::resolve_for_test(
        json!({"execute_threshold_percentage": 20}),
        json!({}),
        "anthropic/claude-opus-4-1",
        100_000,
    );
    settings.protected_tokens = Some(0);
    session.preset = crate::catalog::Preset::Head;
    session.features = crate::preset::features(session.preset.as_str()).unwrap();
    session.conditions.context_window = 110_000;
    session.conditions.output_reserve = 10_000;
    session.conditions.model = ModelRef::new("anthropic", "claude-opus-4-1");
    at_usage(&mut session, 20.0);
    for ordinal in 1..=16 {
        push(
            &mut session,
            ordinal,
            if ordinal % 2 == 1 {
                Role::User
            } else {
                Role::Assistant
            },
            "history ".repeat(1_000),
        );
    }
    push(&mut session, 17, Role::User, "task".into());
    push(&mut session, 18, Role::Assistant, "step".into());
    session.index_ready = true;
    session.head_stale = false;
    session.queued.insert(("m2".into(), "p".into()));
    (session, client, settings)
}

fn push(session: &mut Session, ordinal: u64, role: Role, text: String) {
    let mut part = Part::new("p", PartBody::Text { text: text.into() });
    part.tag = Some(ordinal);
    let mut entry = Entry::new(ordinal, format!("m{ordinal}"), role, ordinal, vec![part]);
    let mut usage = StepUsage::new();
    usage.reasoning_tokens = Some(0);
    entry.usage = Some(usage);
    session.index.extend([entry]);
}

fn at_usage(session: &mut Session, percentage: f64) {
    session.conditions.last_prompt_tokens = Some((percentage * 1_000.0).round() as u64);
}

/// Case 1's refusal of the summary send, received just now.
fn refusal(send: SendKind) -> AccountWait {
    AccountWait {
        code: "account_limit_exhausted".into(),
        until_ms: now_ms() + 120_000,
        at_ms: now_ms(),
        send,
    }
}

/// Start the due summary run and end it with an account wait.
async fn refused_run(session: &mut Session, client: &Client, settings: &Settings) {
    assert!(session.decide_notice(settings).summary.is_some());
    session
        .summary_finished(
            client,
            settings,
            Err(run::SummaryError::AccountWait(refusal(SendKind::TurnOne))),
            now_ms(),
        )
        .await;
}

#[tokio::test]
async fn account_wait_ends_a_run_waiting_with_no_failure_charged() {
    let (mut session, client, settings) = ready();
    let pass = session.decide_notice(&settings);
    // Without a wait the due summary starts, and the queued drop holds for it.
    assert!(pass.summary.is_some());
    assert!(!pass.rebuild);
    assert!(session.drain.spent > 0);
    let before = now_ms();
    session
        .summary_finished(
            &client,
            &settings,
            Err(run::SummaryError::AccountWait(refusal(SendKind::TurnOne))),
            before,
        )
        .await;
    assert!(!session.summarizing);
    assert_eq!(session.app.failures, 0);
    assert_eq!(session.app.last_error, None);
    assert_eq!(session.drain.failure_at, 0, "no failure backoff");
    assert_eq!(session.drain.spent, 0, "the reservation went back");
    assert_eq!(session.no_progress, None);
    let waiting = session.account_wait.as_ref().expect("the session waits");
    assert!(waiting.refusal.until_ms >= before + 120_000);
    assert_eq!(waiting.refusal.send, SendKind::TurnOne);
}

#[tokio::test]
async fn routing_account_wait_releases_quota_preserves_views_and_stops_repeat_notices() {
    let (mut session, client, settings) = ready();
    assert!(session.decide_notice(&settings).summary.is_some());
    assert!(session.drain.spent > 0);
    let now = now_ms();
    use crate::summary::run::account_wait_send_tests::{job, Answer, Client as SendClient};
    let sender = SendClient::new(Answer::RunEndsFinal).with_route_refusal_after(
        0,
        crate::routing::RouteError {
            code: "no_route".into(),
            message: "blocked routes".into(),
            detail: Some(json!({"reason": "all_inadequate", "reset_at_ms": now + 20 * 60_000})),
        },
    );
    let result = run::run(&sender, None, &job()).await;
    assert!(matches!(result, Err(run::SummaryError::AccountWait(_))));
    session
        .summary_finished(&client, &settings, result, now)
        .await;
    assert_eq!(session.app.failures, 0);
    assert_eq!(session.app.last_error, None);
    assert_eq!(session.drain.spent, 0);
    assert_eq!(session.drain.failure_at, 0);
    assert_eq!(session.no_progress, None);
    for _ in 0..2 {
        let pass = session.decide_notice(&settings);
        assert!(pass.summary.is_none());
        assert!(pass.rebuild);
    }
    assert!(session.account_wait.as_ref().unwrap().holds(now + 4_000));
    let (view, _) = session.build(&settings, None, false, None);
    assert!(serde_json::to_string(&view.unwrap())
        .unwrap()
        .contains("\"m2\""));
    at_usage(&mut session, 96.0);
    assert!(session.decide_notice(&settings).summary.is_some());
    assert!(session.decide_notice(&settings).summary.is_none());
}

#[tokio::test]
async fn routing_account_wait_fallback_refusal_preserves_and_counts_the_first_failure() {
    use crate::summary::run::account_wait_send_tests::{job, Answer, Client as SendClient};

    let (mut session, client, settings) = ready();
    assert!(session.decide_notice(&settings).summary.is_some());
    let spent = session.drain.spent;
    assert!(spent > 0);
    let now = now_ms();
    let sender = SendClient::new(Answer::RunEndsFinal).with_route_refusal_after(
        1,
        crate::routing::RouteError {
            code: "no_route".into(),
            message: "fallback routes are blocked".into(),
            detail: Some(json!({"reason": "all_inadequate", "reset_at_ms": now + 20 * 60_000})),
        },
    );
    let result = run::run(&sender, None, &job()).await;
    session
        .summary_finished(&client, &settings, result, now)
        .await;
    assert_eq!(session.app.failures, 1);
    assert!(session
        .app
        .last_error
        .as_deref()
        .unwrap()
        .starts_with("the run ended error: "));
    assert_eq!(session.drain.spent, spent, "the failed attempt stays spent");
    assert!(session.account_wait.is_none());
}

#[tokio::test]
async fn account_wait_starts_no_run_and_lets_held_drops_land() {
    let (mut session, client, settings) = ready();
    refused_run(&mut session, &client, &settings).await;
    // At the threshold and in the force band alike, no run starts; the pass
    // that would have held its drops for the summary rebuilds instead.
    for percentage in [20.0, 90.0] {
        at_usage(&mut session, percentage);
        let pass = session.decide_notice(&settings);
        assert!(pass.summary.is_none(), "a run started at {percentage}%");
        assert!(pass.rebuild, "the held drops wait at {percentage}%");
    }
    assert!(session.account_wait.as_ref().unwrap().skip_logged);
    at_usage(&mut session, 20.0);
    let (view, _) = session.build(&settings, None, false, None);
    let view = serde_json::to_string(&view.expect("a view")).unwrap();
    assert!(
        view.contains("\"m2\""),
        "the queued drop did not land: {view}"
    );
}

#[tokio::test]
async fn account_wait_a_pending_floor_lift_does_not_hold_drops_during_the_wait() {
    let (mut session, client, settings) = ready();
    session.floor_pending_for = Some((17, "m17".into()));
    assert!(session.summary_on_its_way());
    refused_run(&mut session, &client, &settings).await;
    session.floor_pending_for = Some((17, "m17".into()));
    assert!(!session.summary_on_its_way());
}

#[tokio::test]
async fn account_wait_the_first_trigger_after_the_wait_starts_a_run() {
    let (mut session, client, settings) = ready();
    refused_run(&mut session, &client, &settings).await;
    session.account_wait.as_mut().unwrap().refusal.until_ms = now_ms() - 1;
    assert!(session.decide_notice(&settings).summary.is_some());
    assert_eq!(session.account_wait, None);
}

/// A second turn or a fact check that meets the wait holds the session's
/// summaries just as a first turn does.
#[tokio::test]
async fn account_wait_from_turn_two_holds_the_next_run() {
    let (mut session, _, settings) = ready();
    session.account_refused(refusal(SendKind::TurnTwo));
    assert!(session.decide_notice(&settings).summary.is_none());
}

/// From 95%, a primary session's turns wait for its summary, so one run per
/// newest message may try inside the wait; a refused try does not repeat
/// until newer history arrives.
#[tokio::test]
async fn account_wait_emergency_usage_tries_once_per_history() {
    let (mut session, client, settings) = ready();
    refused_run(&mut session, &client, &settings).await;
    at_usage(&mut session, 96.0);
    refused_run(&mut session, &client, &settings).await;
    assert_eq!(
        session
            .account_wait
            .as_ref()
            .unwrap()
            .emergency_at
            .as_deref(),
        Some("m18")
    );
    assert!(session.decide_notice(&settings).summary.is_none());
    push(&mut session, 19, Role::Assistant, "next step".into());
    assert!(session.decide_notice(&settings).summary.is_some());
}

/// A run the emergency let through that the runner served ends the wait.
#[tokio::test]
async fn account_wait_ends_when_a_run_is_served() {
    let (mut session, client, settings) = ready();
    session.account_refused(refusal(SendKind::FactCheck));
    session.summarizing = true;
    session
        .summary_finished(
            &client,
            &settings,
            Ok(Some(run::Summarized {
                validated: Default::default(),
                publication: None,
                continuation: None,
            })),
            now_ms(),
        )
        .await;
    assert_eq!(session.account_wait, None);
}

/// A second turn's refusal can reach the session after a later first turn
/// was served. Received before that served run, it is stale and ignored; one
/// received after it still holds the summaries.
#[tokio::test]
async fn account_wait_an_older_refusal_after_a_served_run_is_ignored() {
    let (mut session, client, settings) = ready();
    let older = AccountWait {
        at_ms: now_ms() - 1_000,
        ..refusal(SendKind::TurnTwo)
    };
    session.summarizing = true;
    session
        .summary_finished(
            &client,
            &settings,
            Ok(Some(run::Summarized {
                validated: Default::default(),
                publication: None,
                continuation: None,
            })),
            now_ms(),
        )
        .await;
    session.account_refused(older);
    assert_eq!(session.account_wait, None);
    session.account_refused(refusal(SendKind::TurnTwo));
    assert!(session.account_wait.is_some());
}
