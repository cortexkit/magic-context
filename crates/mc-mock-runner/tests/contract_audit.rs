//! Runner obligations of the compaction contract (CONTRACT.md in the
//! `cortexkit-role-compaction` crate) that the mock runner once broke, one
//! test each, named by the rule it checks.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use cortexkit_role_compaction::notice::{Event, NoticeAnswer, NoticeRequest};
use cortexkit_role_compaction::read::SessionRef;
use cortexkit_role_compaction::ride::{RideAnswer, RideRequest};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::{ModelRef, SetupAnswer, SetupRequest};
use cortexkit_role_compaction::view::{ApplyViewAnswer, ApplyViewRequest, Edit, EditOp, View};
use cortexkit_role_compaction::wire::codes;
use mc_mock_runner::model::Kind;
use mc_mock_runner::runner::{CallError, Provider, Runner, SessionConfig, UserEdit};
use mc_mock_runner::script::{Step, Turn};
use serde_json::Value;

/// A provider that records what it gets and misbehaves as told.
#[derive(Default)]
struct Recording {
    notices: Mutex<Vec<NoticeRequest>>,
    setups: AtomicU64,
    rides: AtomicU64,
    /// Answer rides with a view, after the ride's deadline.
    late_ride: bool,
    /// Refuse rides as a provider that lost the session.
    unknown_session: bool,
    /// Refuse Setup as a provider without the preset.
    unknown_preset: bool,
}

impl Provider for Recording {
    async fn setup(&self, _: SetupRequest) -> Result<SetupAnswer, CallError> {
        self.setups.fetch_add(1, Ordering::SeqCst);
        if self.unknown_preset {
            return Err(CallError::refused(codes::UNKNOWN_PRESET, "no such preset"));
        }
        Ok(SetupAnswer::Ready)
    }

    async fn notice(&self, request: NoticeRequest) -> Result<NoticeAnswer, CallError> {
        self.notices.lock().unwrap().push(request);
        Ok(NoticeAnswer::Received)
    }

    async fn ride(&self, request: RideRequest) -> Result<RideAnswer, CallError> {
        self.rides.fetch_add(1, Ordering::SeqCst);
        if self.unknown_session {
            return Err(CallError::refused(codes::UNKNOWN_SESSION, "no Setup"));
        }
        if self.late_ride {
            tokio::time::sleep(Duration::from_millis(request.deadline_ms + 20)).await;
            return Ok(RideAnswer::View {
                view: View::seal(1, Vec::new()),
            });
        }
        Ok(RideAnswer::Nothing)
    }

    async fn tool(&self, _: &str, _: &Value) -> Result<String, CallError> {
        Ok(String::new())
    }

    async fn pre_user(&self, _: &str, _: u64) -> Result<UserEdit, CallError> {
        Ok(UserEdit::default())
    }
}

fn config(context_window: u64) -> SessionConfig {
    SessionConfig {
        session: SessionRef::new("mock-runner", "mock", "s1"),
        preset: "head".into(),
        model: ModelRef::new("anthropic", "claude-test"),
        context_window,
        output_reserve: 100,
        rules: ProviderRules::new(SignedParts::None, EditCost::Suffix),
        kind: Kind::Anthropic,
        cache_ttl_ms: 300_000,
        system_tokens: 500,
        tag_checkpoint: 0,
        moved_in: None,
        start_ms: 1_000_000,
        project: None,
        model_latency_ms: 0,
        templates: Vec::new(),
    }
}

fn user(text: &str) -> Step {
    Step::User { text: text.into() }
}

/// Every Setup restarts the notice count (compaction contract S3, W5.2).
#[tokio::test]
async fn setup_restarts_the_notice_count() {
    let mut runner = Runner::start(config(100_000), Recording::default())
        .await
        .unwrap();
    runner
        .play(&[user("before"), Step::RestartRunner, user("after")])
        .await;
    let seqs: Vec<u64> = runner
        .provider()
        .notices
        .lock()
        .unwrap()
        .iter()
        .map(|notice| notice.seq)
        .collect();
    assert_eq!(seqs, [1, 1]);
}

/// A view arriving after the ride's deadline is not applied (compaction contract RD2).
#[tokio::test]
async fn a_view_after_the_ride_deadline_is_not_applied() {
    let provider = Recording {
        late_ride: true,
        ..Recording::default()
    };
    let mut runner = Runner::start(config(100_000), provider).await.unwrap();
    let script = [
        user("hello"),
        Step::RestartRunner,
        Step::Model(Turn::default()),
    ];
    tokio::time::timeout(Duration::from_secs(40), runner.play(&script))
        .await
        .expect("the runner stops waiting at the deadline");
    assert_eq!(runner.provider().rides.load(Ordering::SeqCst), 1);
    assert_eq!(runner.host().applied_version(), None);
}

/// A ride refused with `unknown_session` counts as nothing, and Setup goes
/// before the next notice (compaction contract S1, F2).
#[tokio::test]
async fn a_lost_session_gets_setup_before_the_next_notice() {
    let provider = Recording {
        unknown_session: true,
        ..Recording::default()
    };
    let mut runner = Runner::start(config(1_000), provider).await.unwrap();
    runner
        .play(&[
            user(&"large prompt ".repeat(2_000)),
            Step::Model(Turn::default()),
        ])
        .await;
    assert!(runner.provider().rides.load(Ordering::SeqCst) >= 1);
    let before = runner.provider().setups.load(Ordering::SeqCst);
    runner.play(&[user("next")]).await;
    assert_eq!(runner.provider().setups.load(Ordering::SeqCst), before + 1);
    let last = runner
        .provider()
        .notices
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .seq;
    assert_eq!(last, 1, "the notice after the new Setup is its first");
}

/// Once a view with a cut applies, the runner writes its marker and reports
/// it in the next notice (compaction contract M1).
#[tokio::test]
async fn an_applied_cut_writes_a_marker_and_the_next_notice_reports_it() {
    let mut runner = Runner::start(config(100_000), Recording::default())
        .await
        .unwrap();
    runner.play(&[user("old"), user("kept")]).await;
    let through = runner.host().entries()[0].mid.clone();
    assert_eq!(
        runner.host().apply_view(ApplyViewRequest::new(View::seal(
            1,
            vec![Edit::new(1, EditOp::Cut { through })],
        ))),
        ApplyViewAnswer::Accepted
    );
    runner.play(&[Step::Model(Turn::default())]).await;
    assert_eq!(runner.host().applied_version(), Some(1));
    let notices = runner.provider().notices.lock().unwrap();
    assert!(notices
        .last()
        .unwrap()
        .events
        .iter()
        .any(|event| matches!(event, Event::MarkerWritten { version: 1 })));
}

/// A provider without the session's preset leaves the session running
/// without compaction: no notices, no rides (compaction contract W1.3).
#[tokio::test]
async fn an_unknown_preset_runs_the_session_without_compaction() {
    let provider = Recording {
        unknown_preset: true,
        ..Recording::default()
    };
    let mut runner = Runner::start(config(100_000), provider)
        .await
        .expect("the session starts");
    runner
        .play(&[user("hello"), Step::Model(Turn::default())])
        .await;
    assert!(runner.provider().notices.lock().unwrap().is_empty());
    assert_eq!(runner.provider().rides.load(Ordering::SeqCst), 0);
}
