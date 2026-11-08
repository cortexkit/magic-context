//! Tests of the runner against an in-process provider whose answers each test
//! scripts.

use std::sync::Mutex;

use cortexkit_compaction_view::rules::invalid_signed_parts;
use cortexkit_role_compaction::notice::{Event, NoticeAnswer, NoticeRequest};
use cortexkit_role_compaction::part::{PartBody, ToolStatus};
use cortexkit_role_compaction::read::SessionRef;
use cortexkit_role_compaction::ride::{RideAnswer, RideCause, RideRequest};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, RuleBreak, SignedParts};
use cortexkit_role_compaction::setup::{ModelRef, SetupAnswer, SetupRequest};
use cortexkit_role_compaction::view::{
    ApplyViewAnswer, ApplyViewRequest, Edit, EditOp, View, ViewRefusal,
};
use serde_json::{json, Value};

use crate::model::{Kind, ModelError};
use crate::runner::{CallError, Host, Provider, Runner, SessionConfig, UserEdit};
use crate::script::{AwaitCondition, SelfTag, Step, ToolCall, Turn};

type Decide = Box<dyn FnMut(&Host) -> Option<Vec<Edit>> + Send>;

/// A decision that fires the first time it returns edits, and never again.
fn once(mut decide: impl FnMut(&Host) -> Option<Vec<Edit>> + Send + 'static) -> Decide {
    let mut fired = false;
    Box::new(move |host: &Host| {
        if fired {
            return None;
        }
        let edits = decide(host);
        fired = edits.is_some();
        edits
    })
}

/// A provider whose decisions are closures over the runner's state. It
/// publishes whatever `on_notice` returns after each notice, and answers a
/// ride with whatever `on_ride` returns.
struct TestProvider {
    host: Mutex<Option<Host>>,
    on_notice: Mutex<Option<Decide>>,
    on_ride: Mutex<Option<Decide>>,
    version: Mutex<u64>,
    published: Mutex<Vec<ApplyViewAnswer>>,
    notices: Mutex<Vec<NoticeRequest>>,
    setups: Mutex<Vec<SetupRequest>>,
    tool_reply: Mutex<Option<tokio::sync::oneshot::Receiver<Result<String, CallError>>>>,
}

impl TestProvider {
    fn new() -> Self {
        Self {
            host: Mutex::new(None),
            on_notice: Mutex::new(None),
            on_ride: Mutex::new(None),
            version: Mutex::new(0),
            published: Mutex::new(Vec::new()),
            notices: Mutex::new(Vec::new()),
            setups: Mutex::new(Vec::new()),
            tool_reply: Mutex::new(None),
        }
    }

    fn attach(&self, host: Host) {
        *self.host.lock().unwrap() = Some(host);
    }

    fn next_view(&self, edits: Vec<Edit>) -> View {
        let mut version = self.version.lock().unwrap();
        *version += 1;
        View::seal(*version, edits)
    }

    fn version(&self) -> u64 {
        *self.version.lock().unwrap()
    }
}

impl Provider for TestProvider {
    async fn setup(&self, request: SetupRequest) -> Result<SetupAnswer, CallError> {
        self.setups.lock().unwrap().push(request);
        Ok(SetupAnswer::Ready)
    }

    async fn notice(&self, request: NoticeRequest) -> Result<NoticeAnswer, CallError> {
        self.notices.lock().unwrap().push(request);
        let host = self.host.lock().unwrap().clone();
        if let Some(host) = host {
            let edits = self
                .on_notice
                .lock()
                .unwrap()
                .as_mut()
                .and_then(|decide| decide(&host));
            if let Some(edits) = edits {
                let view = self.next_view(edits);
                let answer = host.apply_view(ApplyViewRequest::new(view));
                self.published.lock().unwrap().push(answer);
            }
        }
        Ok(NoticeAnswer::Received)
    }

    async fn ride(&self, _: RideRequest) -> Result<RideAnswer, CallError> {
        let host = self.host.lock().unwrap().clone().expect("attached");
        let edits = self
            .on_ride
            .lock()
            .unwrap()
            .as_mut()
            .and_then(|decide| decide(&host));
        Ok(match edits {
            Some(edits) => RideAnswer::View {
                view: self.next_view(edits),
            },
            None => RideAnswer::Nothing,
        })
    }

    async fn tool(&self, name: &str, _: &Value) -> Result<String, CallError> {
        let reply = self.tool_reply.lock().unwrap().take();
        if let Some(reply) = reply {
            assert_eq!(name, "ctx_expand");
            return reply.await.map_err(|_| CallError::new("tool stopped"))?;
        }
        Ok(format!("{name} done"))
    }

    async fn pre_user(&self, _: &str, _: u64) -> Result<UserEdit, CallError> {
        Ok(UserEdit::default())
    }
}

fn anthropic_bound() -> ProviderRules {
    ProviderRules::new(SignedParts::Bound, EditCost::Suffix)
}

fn free() -> ProviderRules {
    ProviderRules::new(SignedParts::None, EditCost::Suffix)
}

fn config(kind: Kind, rules: ProviderRules, window: u64) -> SessionConfig {
    SessionConfig {
        session: SessionRef::new("mock-runner", "mock", "s1"),
        preset: "head".into(),
        model: ModelRef::new("anthropic", "claude-test"),
        context_window: window,
        output_reserve: 1_000,
        rules,
        kind,
        cache_ttl_ms: 300_000,
        system_tokens: 500,
        tag_checkpoint: 0,
        moved_in: None,
        start_ms: 1_000_000,
        project: None,
        model_latency_ms: 0,
        templates: Vec::new(),
        accepts_images: None,
        view_anchor: true,
    }
}

async fn start(config: SessionConfig) -> Runner<TestProvider> {
    let runner = Runner::start(config, TestProvider::new()).await.unwrap();
    runner.provider().attach(runner.host().clone());
    runner
}

#[tokio::test]
async fn contract_update_mock_anchor_opt_in_and_legacy_verification() {
    let mut wire = serde_json::to_value(config(Kind::OpenAi, free(), 40_000)).unwrap();
    wire.as_object_mut().unwrap().remove("view_anchor");
    let defaults: SessionConfig = serde_json::from_value(wire).unwrap();
    assert!(defaults.view_anchor);
    for enabled in [true, false] {
        let mut config = defaults.clone();
        config.view_anchor = enabled;
        let mut runner = start(config).await;
        assert_eq!(
            runner.provider().setups.lock().unwrap()[0].view_anchor,
            enabled.then_some(true)
        );
        runner
            .play(&[Step::User {
                text: "prompt".into(),
            }])
            .await;
        let anchor = runner.host().entries().last().unwrap().mid.clone();
        let anchored = View::seal_with_policy(1, vec![], Some(anchor), None);
        let answer = runner.host().apply_view(ApplyViewRequest::new(anchored));
        assert_eq!(
            answer,
            if enabled {
                ApplyViewAnswer::Accepted
            } else {
                ApplyViewAnswer::Refused {
                    refusal: ViewRefusal::BadChecksum,
                }
            }
        );
        if !enabled {
            assert_eq!(
                runner
                    .host()
                    .apply_view(ApplyViewRequest::new(View::seal(1, vec![]))),
                ApplyViewAnswer::Accepted
            );
        }
    }
}

#[tokio::test]
async fn notice_keep_declaration_controls_kept_notice_marks() {
    let runner = start(config(Kind::OpenAi, free(), 40_000)).await;
    let host = runner.host();
    assert_eq!(host.describe()["capabilities"], json!(["cache_policy"]));
    host.append_notice("unmarked worker result", false);
    assert!(!host.entries().last().unwrap().notice.as_ref().unwrap().keep);
    host.declare_notice_keep(true);
    assert_eq!(
        host.describe()["capabilities"],
        json!(["cache_policy", "message_marks", "notice_keep"])
    );
    host.append_notice("the person's answer", true);
    assert!(host.entries().last().unwrap().notice.as_ref().unwrap().keep);
    host.declare_notice_keep(false);
    assert_eq!(host.describe()["capabilities"], json!(["cache_policy"]));
    assert!(host.entries().last().unwrap().notice.as_ref().unwrap().keep);
}

#[tokio::test]
async fn contract_update_newer_signed_reply_strips_only_with_claude_policy() {
    for (provider, model, strip) in [
        ("anthropic", "claude-opus-5-5", true),
        ("google", "gemini-3-pro", false),
    ] {
        let mut config = config(Kind::Anthropic, anthropic_bound(), 40_000);
        config.model = ModelRef::new(provider, model);
        let mut runner = start(config).await;
        runner
            .play(&[
                Step::User {
                    text: "old request".into(),
                },
                Step::User {
                    text: "current request".into(),
                },
            ])
            .await;
        let entries = runner.host().entries();
        let view = View::seal_with_policy(
            1,
            vec![Edit::new(
                1,
                EditOp::Drop {
                    mid: entries[0].mid.clone(),
                    part: None,
                },
            )],
            entries.last().map(|entry| entry.mid.clone()),
            strip.then(|| "strip".into()),
        );
        runner
            .play(&[Step::Model(Turn {
                reasoning_tokens: Some(50),
                text: Some("Read a file.".into()),
                tools: vec![ToolCall::ok(
                    "read",
                    json!({"path":"a.rs"}),
                    "file contents",
                )],
                ..Turn::default()
            })])
            .await;
        assert!(runner
            .host()
            .entries()
            .iter()
            .flat_map(|entry| &entry.parts)
            .any(|part| part.seal == cortexkit_role_compaction::part::Seal::Signed));
        let known = View::seal_with_policy(
            1,
            view.edits.clone(),
            runner
                .host()
                .entries()
                .last()
                .map(|entry| entry.mid.clone()),
            Some("strip".into()),
        );
        assert!(matches!(
            runner.host().apply_view(ApplyViewRequest::new(known)),
            ApplyViewAnswer::Refused {
                refusal: ViewRefusal::Rule(RuleBreak::SignedPartInvalid { .. })
            }
        ));
        let answer = runner.host().apply_view(ApplyViewRequest::new(view));
        if strip {
            assert_eq!(answer, ApplyViewAnswer::Accepted);
            runner
                .play(&[Step::Model(Turn {
                    text: Some("Done.".into()),
                    ..Turn::default()
                })])
                .await;
            assert_eq!(runner.host().applied_version(), Some(1));
            assert!(runner
                .host()
                .rendered()
                .iter()
                .flat_map(|message| &message.parts)
                .all(|part| part.seal != cortexkit_role_compaction::part::Seal::Signed));
            assert!(
                runner.report.model_errors.is_empty(),
                "{:?}",
                runner.report.model_errors
            );
            assert!(
                runner.report.view_refusals.is_empty(),
                "{:?}",
                runner.report.view_refusals
            );
        } else {
            assert!(
                matches!(
                    answer,
                    ApplyViewAnswer::Refused {
                        refusal: ViewRefusal::Rule(RuleBreak::SignedPartInvalid { .. })
                    }
                ),
                "{answer:?}"
            );
        }
    }
}

#[tokio::test]
async fn await_notices_waits_for_the_session_tool_reply_without_advancing_time() {
    use std::future::Future;
    use std::task::Poll;

    let config = config(Kind::OpenAi, free(), 40_000);
    let before = config.start_ms;
    let mut runner = start(config).await;
    let (reply, answer) = tokio::sync::oneshot::channel();
    *runner.provider().tool_reply.lock().unwrap() = Some(answer);
    let steps = [Step::Await {
        condition: AwaitCondition::NoticesProcessed,
        timeout_ms: 1_000,
    }];
    let mut play = Box::pin(runner.play(&steps));
    std::future::poll_fn(|cx| {
        assert!(play.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    reply.send(Ok("message 1".into())).unwrap();
    play.await;
    assert!(runner.report.call_errors.is_empty());
    assert!(runner.host().entries().is_empty());
    assert!(runner.report.requests.is_empty());
    runner.play(&[user("after the fence")]).await;
    assert_eq!(runner.host().entries()[0].written_at, before);
}

#[tokio::test]
async fn await_notices_reports_a_failed_fence_and_stops_the_script() {
    let mut runner = start(config(Kind::OpenAi, free(), 40_000)).await;
    let (reply, answer) = tokio::sync::oneshot::channel();
    *runner.provider().tool_reply.lock().unwrap() = Some(answer);
    reply.send(Err(CallError::new("worker stopped"))).unwrap();
    runner
        .play(&[
            Step::Await {
                condition: AwaitCondition::NoticesProcessed,
                timeout_ms: 1_000,
            },
            user("must not run"),
        ])
        .await;
    assert_eq!(runner.report.call_errors.len(), 1);
    assert!(runner.report.call_errors[0]
        .message
        .contains("worker stopped"));
    assert!(runner.host().entries().is_empty());
}

#[tokio::test]
async fn await_child_runs_keeps_play_pending_until_a_child_arrives() {
    use std::future::Future;
    use std::task::Poll;

    let mut runner = start(config(Kind::OpenAi, free(), 40_000)).await;
    let host = runner.host().clone();
    let steps = [Step::Await {
        condition: AwaitCondition::ChildRuns { count: 1 },
        timeout_ms: 1_000,
    }];
    let mut play = Box::pin(runner.play(&steps));
    std::future::poll_fn(|cx| {
        assert!(play.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    let mut request = cortexkit_role_llm_runner::send::SendRequest::new("chunk", "send-1");
    request.runner_params = json!({
        "model": {"provider": "test", "model": "summarizer"},
        "system": "Summarize the chunk.",
        "generation": {"max_output_tokens": 100},
        "stop_when": {"max_steps": 1}
    })
    .as_object()
    .unwrap()
    .clone();
    host.send("s1:mc-summary:1", request).unwrap();
    play.await;
    assert!(runner.report.call_errors.is_empty());
    assert_eq!(host.child_runs().len(), 1);
}

#[tokio::test]
async fn await_child_runs_times_out_with_the_condition_and_observation() {
    let mut runner = start(config(Kind::OpenAi, free(), 40_000)).await;
    runner
        .play(&[
            Step::Await {
                condition: AwaitCondition::ChildRuns { count: 1 },
                timeout_ms: 1,
            },
            user("must not run"),
        ])
        .await;
    assert_eq!(runner.report.call_errors.len(), 1);
    let message = &runner.report.call_errors[0].message;
    assert!(message.contains("ChildRuns { count: 1 }"), "{message}");
    assert!(message.contains("timed out"), "{message}");
    assert!(message.contains("observed 0 child runs"), "{message}");
    assert!(runner.host().entries().is_empty());
}

#[tokio::test]
async fn await_an_already_satisfied_condition_does_not_add_a_turn() {
    let mut runner = start(config(Kind::OpenAi, free(), 40_000)).await;
    runner
        .play(&[Step::Await {
            condition: AwaitCondition::ChildRuns { count: 0 },
            timeout_ms: 1_000,
        }])
        .await;
    assert!(runner.report.call_errors.is_empty());
    assert!(runner.host().entries().is_empty());
    assert!(runner.report.requests.is_empty());
}

fn user(text: &str) -> Step {
    Step::User { text: text.into() }
}

/// A model step with reasoning, a sentence, and one tool call returning
/// `output_bytes` bytes.
fn work(reasoning: u64, output_bytes: usize) -> Step {
    Step::Model(Turn {
        reasoning_tokens: Some(reasoning),
        text: Some("Looking at the file.".into()),
        tools: vec![ToolCall::ok(
            "read",
            json!({"path": "a.rs"}),
            "x".repeat(output_bytes),
        )],
        output_tokens: 20,
        ..Turn::default()
    })
}

fn answer() -> Step {
    Step::Model(Turn {
        text: Some("Done.".into()),
        output_tokens: 5,
        ..Turn::default()
    })
}

/// The (mid, part) of every finished tool part in the transcript, oldest
/// first. A running call cannot be dropped.
fn tool_parts(host: &Host) -> Vec<(String, String)> {
    host.entries()
        .iter()
        .flat_map(|entry| {
            entry
                .parts
                .iter()
                .filter(|part| matches!(&part.body, PartBody::Tool(tool) if tool.status != ToolStatus::Running))
                .map(move |part| (entry.mid.clone(), part.id.clone()))
        })
        .collect()
}

fn drop_edit(since: u64, (mid, part): &(String, String)) -> Edit {
    Edit::new(
        since,
        EditOp::Drop {
            mid: mid.clone(),
            part: Some(part.clone()),
        },
    )
}

#[tokio::test]
async fn between_views_every_request_extends_the_previous_one() {
    let mut runner = start(config(Kind::Anthropic, anthropic_bound(), 100_000)).await;
    runner
        .play(&[
            user("start"),
            work(100, 2_000),
            work(100, 2_000),
            answer(),
            user("next"),
            answer(),
        ])
        .await;
    let report = &runner.report;
    assert!(report.model_errors.is_empty(), "{:?}", report.model_errors);
    assert_eq!(report.requests.len(), 4);
    for pair in report.requests.windows(2) {
        let (before, after) = (&pair[0].usage, &pair[1].usage);
        assert_eq!(after.cache_read_tokens, before.prompt_tokens, "{pair:?}");
    }
}

#[tokio::test]
async fn a_view_costs_one_cache_write_and_reading_resumes_after_it() {
    let mut runner = start(config(Kind::OpenAi, free(), 100_000)).await;
    let provider = runner.provider();
    *provider.on_notice.lock().unwrap() = Some(once(|host: &Host| {
        let tools = tool_parts(host);
        // Once three tools exist, drop the first.
        (tools.len() == 3).then(|| vec![drop_edit(1, &tools[0])])
    }));
    runner
        .play(&[
            user("start"),
            work(100, 8_000),
            work(100, 8_000),
            work(100, 8_000),
            answer(),
            answer(),
        ])
        .await;
    let report = &runner.report;
    assert!(report.model_errors.is_empty(), "{:?}", report.model_errors);
    assert_eq!(
        runner.provider().published.lock().unwrap()[..],
        [ApplyViewAnswer::Accepted]
    );
    let after: Vec<_> = report
        .requests
        .iter()
        .filter(|record| record.view == Some(1))
        .collect();
    assert_eq!(after.len(), 2);
    // The first request under the view reads only up to the first changed
    // part: the first request, which ended before the dropped tool. The next
    // one reads all of it again.
    assert_eq!(
        after[0].usage.cache_read_tokens,
        report.requests[0].usage.prompt_tokens
    );
    assert_eq!(
        after[1].usage.cache_read_tokens,
        after[0].usage.prompt_tokens
    );
}

#[tokio::test]
async fn a_view_breaking_signed_reasoning_is_refused_and_its_fixed_form_accepted() {
    let mut runner = start(config(Kind::Anthropic, anthropic_bound(), 100_000)).await;
    let provider = runner.provider();
    *provider.on_notice.lock().unwrap() = Some(once(|host: &Host| {
        let tools = tool_parts(host);
        (tools.len() == 3).then(|| vec![drop_edit(1, &tools[0])])
    }));
    runner
        .play(&[
            user("start"),
            work(100, 4_000),
            work(100, 4_000),
            work(100, 4_000),
        ])
        .await;
    {
        let published = runner.provider().published.lock().unwrap();
        assert!(matches!(
            published[..],
            [ApplyViewAnswer::Refused {
                refusal: ViewRefusal::Rule(RuleBreak::SignedPartInvalid { .. })
            }]
        ));
    }

    // The same drop plus the companion drops the rules require.
    let host = runner.host().clone();
    let tools = tool_parts(&host);
    let version = runner.provider().version() + 1;
    let mut edits = vec![drop_edit(version, &tools[0])];
    loop {
        let invalid = invalid_signed_parts(&host.entries(), &edits, &anthropic_bound());
        if invalid.is_empty() {
            break;
        }
        edits.extend(invalid.iter().map(|target| drop_edit(version, target)));
    }
    let answer_fixed = host.apply_view(ApplyViewRequest::new(runner.provider().next_view(edits)));
    assert_eq!(answer_fixed, ApplyViewAnswer::Accepted);
    *runner.provider().on_notice.lock().unwrap() = None;
    runner.play(&[answer()]).await;
    // The mock provider checks signatures on its own and accepts it.
    assert!(
        runner.report.model_errors.is_empty(),
        "{:?}",
        runner.report.model_errors
    );
    assert_eq!(runner.report.requests.last().unwrap().view, Some(2));
}

#[tokio::test]
async fn the_mock_provider_rejects_a_changed_history_before_signed_reasoning_on_its_own() {
    // The runner declares no signature rule, so only the mock provider can
    // catch the broken view.
    let mut runner = start(config(Kind::Anthropic, free(), 100_000)).await;
    *runner.provider().on_notice.lock().unwrap() = Some(once(|host: &Host| {
        let tools = tool_parts(host);
        (tools.len() == 3).then(|| vec![drop_edit(1, &tools[0])])
    }));
    runner
        .play(&[
            user("start"),
            work(100, 4_000),
            work(100, 4_000),
            work(100, 4_000),
            answer(),
        ])
        .await;
    assert!(
        matches!(
            runner.report.model_errors[..],
            [ModelError::InvalidSignature { .. }]
        ),
        "{:?}",
        runner.report.model_errors
    );
}

#[tokio::test]
async fn over_the_limit_the_runner_rides_and_refuses_rather_than_send() {
    // Window 20,000 with 1,000 reserved: four 24,000-byte outputs are about
    // 24,000 tokens, so the fifth request cannot fit without a view.
    let steps = [
        user("start"),
        work(10, 24_000),
        work(10, 24_000),
        work(10, 24_000),
        work(10, 24_000),
        answer(),
    ];

    let mut runner = start(config(Kind::OpenAi, free(), 20_000)).await;
    runner.play(&steps).await;
    assert!(
        runner.report.model_errors.is_empty(),
        "{:?}",
        runner.report.model_errors
    );
    assert_eq!(runner.report.refusals, ["context_ceiling"]);
    assert!(runner
        .report
        .rides
        .iter()
        .any(|ride| ride.has(RideCause::OverLimit) && !ride.got_view));
    let sent = runner.report.requests.len();

    // With a provider that answers the ride, the same script goes through.
    let mut runner = start(config(Kind::OpenAi, free(), 20_000)).await;
    // The script needs exactly one ride, so this is view 1.
    *runner.provider().on_ride.lock().unwrap() = Some(once(|host: &Host| {
        let tools = tool_parts(host);
        Some(
            tools[..tools.len() - 1]
                .iter()
                .map(|target| drop_edit(1, target))
                .collect(),
        )
    }));
    runner.play(&steps).await;
    assert!(
        runner.report.model_errors.is_empty(),
        "{:?}",
        runner.report.model_errors
    );
    assert!(runner.report.refusals.is_empty());
    assert!(runner.report.requests.len() > sent);
}

#[tokio::test]
async fn an_idle_gap_past_the_cache_lifetime_rides_before_the_next_request() {
    let mut runner = start(config(Kind::Anthropic, anthropic_bound(), 100_000)).await;
    runner
        .play(&[
            user("start"),
            answer(),
            Step::Wait { ms: 300_001 },
            user("back"),
            answer(),
        ])
        .await;
    assert_eq!(runner.report.rides.len(), 1);
    assert_eq!(runner.report.rides[0].causes, [RideCause::CacheExpired]);
    let last = runner.report.requests.last().unwrap();
    assert_eq!(last.usage.cache_read_tokens, Some(0));
}

#[tokio::test]
async fn after_a_revert_the_runner_skips_edits_for_messages_that_are_gone() {
    let mut runner = start(config(Kind::OpenAi, free(), 100_000)).await;
    // The second call is dropped once a third follows it: the call that ends
    // the request must stay, so the plan would refuse dropping the newest.
    *runner.provider().on_notice.lock().unwrap() = Some(once(|host: &Host| {
        let tools = tool_parts(host);
        (tools.len() == 3).then(|| vec![drop_edit(1, &tools[1])])
    }));
    runner
        .play(&[
            user("start"),
            work(10, 1_000),
            work(10, 1_000),
            work(10, 1_000),
            answer(),
        ])
        .await;
    assert_eq!(runner.host().applied_version(), Some(1));
    runner
        .play(&[Step::Revert { ordinal: 3 }, user("again"), answer()])
        .await;
    assert!(
        runner.report.model_errors.is_empty(),
        "{:?}",
        runner.report.model_errors
    );
    let notices = runner.provider().notices.lock().unwrap();
    assert!(notices.iter().any(|notice| notice
        .events
        .contains(&Event::TranscriptChanged { from_ordinal: 3 })));
}

/// A reply that only answers, starting its text the given way.
fn answer_tagged(self_tag: SelfTag) -> Step {
    Step::Model(Turn {
        text: Some("Done.".into()),
        self_tag,
        output_tokens: 5,
        ..Turn::default()
    })
}

/// Whether each request read the whole previous request back from the cache,
/// that is, continued the chain.
fn continued(report: &crate::runner::Report) -> Vec<bool> {
    report
        .requests
        .windows(2)
        .map(|pair| pair[1].usage.cache_read_tokens == pair[0].usage.prompt_tokens)
        .collect()
}

#[tokio::test]
async fn self_tagged_replies_keep_a_chained_route_continuing_across_a_revert() {
    let mut runner = start(config(Kind::OpenAiChained, free(), 100_000)).await;
    runner
        .play(&[
            user("start"),
            work(100, 1_000),
            work(100, 1_000),
            answer(),
            user("next"),
            answer(),
        ])
        .await;
    assert_eq!(continued(&runner.report), [true; 3]);

    // Remove the second user message and the reply to it. Counting continues
    // from what remains, so the next user message takes the first removed
    // number and the model's next self-tag is still the number the runner
    // assigns.
    let removed = runner.host().entries()[4].ordinal;
    runner
        .play(&[
            Step::Revert { ordinal: removed },
            user("instead"),
            answer(),
            work(10, 500),
            answer(),
        ])
        .await;
    assert!(
        runner.report.model_errors.is_empty(),
        "{:?}",
        runner.report.model_errors
    );
    // The first request after the revert is a full resend: the history
    // changed under the chain. Every later one continues again.
    assert_eq!(
        continued(&runner.report),
        [true, true, true, false, true, true]
    );

    // The numbers the model sees have no gap where the removed messages were.
    let rendered = runner.host().rendered();
    let tags: Vec<u64> = rendered
        .iter()
        .flat_map(|message| &message.parts)
        .filter_map(|part| part.tag)
        .collect();
    assert_eq!(tags, (1..=tags.len() as u64).collect::<Vec<_>>());
}

#[tokio::test]
async fn a_reply_without_its_self_tag_breaks_the_chain_every_time() {
    let mut runner = start(config(Kind::OpenAiChained, free(), 100_000)).await;
    runner
        .play(&[
            user("start"),
            answer_tagged(SelfTag::Missing),
            user("next"),
            answer_tagged(SelfTag::Missing),
            user("again"),
            answer_tagged(SelfTag::Missing),
        ])
        .await;
    assert_eq!(continued(&runner.report), [false, false]);
}

#[tokio::test]
async fn a_wrong_self_tag_breaks_the_chain_once() {
    let mut runner = start(config(Kind::OpenAiChained, free(), 100_000)).await;
    runner
        .play(&[
            user("start"),
            answer_tagged(SelfTag::Number(99)),
            user("next"),
            answer(),
            user("again"),
            answer(),
        ])
        .await;
    assert_eq!(continued(&runner.report), [false, true]);
    // The stored reply carries no prefix; the runner renders the number it
    // assigned in front of it.
    let first_reply = &runner.host().rendered()[1];
    let text = first_reply.wire_text(&first_reply.parts[0]).unwrap();
    assert_eq!(
        text,
        format!("§{}§ Done.", first_reply.parts[0].tag.unwrap())
    );
}
