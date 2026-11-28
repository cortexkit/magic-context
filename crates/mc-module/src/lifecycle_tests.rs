use super::*;
use cortexkit_role_compaction::part::{Part, PartBody};
use cortexkit_role_compaction::read::{Entry, Head, ReadPage, Role};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, RuleBreak, SignedParts};
use cortexkit_role_compaction::setup::ModelRef;
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::SendReply;
use std::collections::VecDeque;
use std::sync::Mutex;

#[path = "cache_sentinel_log_tests.rs"]
mod cache_sentinel_log_tests;

#[path = "pass_decision_tests.rs"]
mod pass_decision_tests;

#[path = "pass_safety_tests.rs"]
mod pass_safety_tests;

#[path = "cleanup_ride_tests.rs"]
mod cleanup_ride_tests;

#[path = "emergency_credit_review_tests.rs"]
mod emergency_credit_review_tests;

#[path = "ride_cause_tests.rs"]
mod ride_cause_tests;

#[path = "stale_reading_tests.rs"]
mod stale_reading_tests;

#[path = "stale_reading_review_tests.rs"]
mod stale_reading_review_tests;

#[path = "stale_reading_accepted_tests.rs"]
mod stale_reading_accepted_tests;

#[path = "spent_reading_tests.rs"]
mod spent_reading_tests;

#[path = "session_count_tests.rs"]
mod count_tests;

#[path = "summary_due_differential_tests.rs"]
mod summary_due_differential_tests;

#[path = "summary_due_review_tests.rs"]
mod summary_due_review_tests;

#[path = "host_parts_tests.rs"]
mod host_parts_tests;

#[path = "host_frame_tests.rs"]
mod host_frame_tests;

#[path = "host_frame_list_tests.rs"]
mod host_frame_list_tests;

#[path = "notes_tokens_tests.rs"]
mod notes_tokens_tests;

#[path = "broca_plan_note_writer_tests.rs"]
mod broca_plan_note_writer_tests;

#[path = "reminder_delivery_tests.rs"]
mod reminder_delivery_tests;

#[path = "session/clock_note_tests.rs"]
mod clock_note_tests;

#[path = "move_floor_tests.rs"]
mod move_floor_tests;

#[path = "signed_floor_tests.rs"]
mod signed_floor_tests;

#[path = "statement_order_tests.rs"]
mod statement_order_tests;

#[path = "statement_order_review_tests.rs"]
mod statement_order_review_tests;

#[path = "restart_offer_tests.rs"]
mod restart_offer_tests;

#[path = "head_bytes_tests.rs"]
mod head_bytes_tests;

#[path = "head_dates_tests.rs"]
mod head_dates_tests;

#[path = "head_dates_review_tests.rs"]
mod head_dates_review_tests;

#[path = "summary_sharing_tests.rs"]
mod summary_sharing_tests;

#[path = "head_cache_differential_tests.rs"]
mod head_cache_differential_tests;

#[path = "session/held_summaries_tests.rs"]
mod held_summaries_tests;

#[path = "session/summaries_index_review_tests.rs"]
mod summaries_index_review_tests;

#[path = "embedding_search_tests.rs"]
mod embedding_search_tests;

#[path = "transcript_behind_tests.rs"]
mod transcript_behind_tests;

#[path = "session_named_read_tests.rs"]
mod named_read_tests;

#[path = "compaction_limits_tests.rs"]
mod compaction_limits_tests;

#[path = "account_wait_session_tests.rs"]
mod account_wait_session_tests;

#[path = "account_wait_review_tests.rs"]
mod account_wait_review_tests;

#[path = "user_commands_tests.rs"]
mod user_commands_tests;

#[path = "tool_output_tests.rs"]
mod tool_output_tests;

#[path = "search_reader_tests.rs"]
mod search_reader_tests;

#[path = "render_failed_tests.rs"]
mod render_failed_tests;

#[path = "render_failed_review_tests.rs"]
mod render_failed_review_tests;

#[path = "render_failed_contract_tests.rs"]
mod render_failed_contract_tests;

#[path = "numbers_unknown_contract_tests.rs"]
mod numbers_unknown_contract_tests;

#[path = "fork_call_tests.rs"]
mod fork_call_tests;

#[path = "apply_view_lost_answer_tests.rs"]
mod apply_view_lost_answer_tests;

#[path = "apply_view_lost_answer_review_tests.rs"]
mod apply_view_lost_answer_review_tests;

#[path = "compaction_undo_tests.rs"]
mod compaction_undo_tests;

#[path = "quiet_resume_review_tests.rs"]
mod quiet_resume_review_tests;

#[derive(Default)]
struct Client {
    applied: Mutex<Option<AppliedViewAnswer>>,
    entries: Mutex<Vec<Entry>>,
    pages: Mutex<VecDeque<Result<ReadPage, crate::client::ClientError>>>,
    reads: Mutex<Vec<ReadRequest>>,
    offered: Mutex<Vec<View>>,
    refuse: Mutex<bool>,
    /// The refusal a refused view gets; `bad_since`, which names no part,
    /// when unset.
    refusal: Mutex<Option<ViewRefusal>>,
    /// `session.apply_view` fails as a call does when the connection to the
    /// runner drops.
    fail_apply: Mutex<bool>,
    /// How many of the next `session.apply_view` calls lose their answer:
    /// the view is offered, and the call fails as one whose deadline passed
    /// after the request was sent, so the runner may or may not hold it.
    lose_apply_answers: Mutex<usize>,
    before_apply: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// `session.applied_view` fails as a call does when the connection to
    /// the runner drops.
    fail_applied_view: Mutex<bool>,
    capabilities: crate::runner_capabilities::RunnerCapabilities,
    descriptions: Mutex<VecDeque<Result<Value, crate::client::ClientError>>>,
    /// Every `session.send` on the session's own route, in order.
    sent: Mutex<Vec<SendRequest>>,
    /// Refusals the next sends get, one each, before sends are accepted.
    send_refusals: Mutex<VecDeque<crate::client::ClientError>>,
}

impl RunnerClient for Client {
    fn runner_setup(&self, runner: &str) {
        self.capabilities.forget(runner);
    }
    /// Entorhinal as a single computer answers: every dreamer role granted
    /// at once.
    fn role_leases(&self) -> std::sync::Arc<dyn crate::dreamer::lease::RoleLeases> {
        crate::dreamer::lease_double::SampleLeases::granting()
    }
    async fn notice_keep(&self, session: &SessionRef) -> bool {
        self.capabilities
            .notice_keep(&session.runner, 1, async {
                self.descriptions
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or_else(|| Ok(serde_json::json!({})))
            })
            .await
    }
    async fn turn_system_cleared(&self, session: &SessionRef) -> bool {
        self.capabilities
            .turn_system_cleared(&session.runner, 1, async {
                self.descriptions
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or_else(|| Ok(serde_json::json!({})))
            })
            .await
    }
    async fn clock_note_delivery(
        &self,
        session: &SessionRef,
    ) -> Option<Vec<cortexkit_role_llm_runner::delivery_order::Mode>> {
        self.capabilities
            .clock_note_delivery(&session.runner, 1, async {
                self.descriptions
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or_else(|| Ok(serde_json::json!({})))
            })
            .await
    }
    async fn read(
        &self,
        _: &SessionRef,
        request: ReadRequest,
    ) -> Result<ReadPage, crate::client::ClientError> {
        self.reads.lock().unwrap().push(request.clone());
        if let Some(page) = self.pages.lock().unwrap().pop_front() {
            return page;
        }
        let entries = self.entries.lock().unwrap();
        let mut head = Head::new();
        head.newest = entries.last().map(cursor);
        let selected = entries
            .iter()
            .filter(|entry| match &request.select {
                Select::After { after_ordinal, .. } => entry.ordinal > after_ordinal.unwrap_or(0),
                Select::Mids { mids } => mids.contains(&entry.mid),
                _ => false,
            })
            .cloned()
            .collect();
        Ok(ReadPage::new(selected, head))
    }
    async fn apply_view(
        &self,
        _: &SessionRef,
        request: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, crate::client::ClientError> {
        self.offered.lock().unwrap().push(request.view);
        let before_apply = self.before_apply.lock().unwrap().take();
        if let Some(before_apply) = before_apply {
            before_apply();
        }
        if *self.fail_apply.lock().unwrap() {
            return Err(crate::client::ClientError::new("connection lost"));
        }
        {
            let mut lose = self.lose_apply_answers.lock().unwrap();
            if *lose > 0 {
                *lose -= 1;
                return Err(crate::client::ClientError::unanswered(
                    "session.apply_view: request on channel 16 timed out at its deadline",
                ));
            }
        }
        Ok(if *self.refuse.lock().unwrap() {
            ApplyViewAnswer::Refused {
                refusal: self
                    .refusal
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or(ViewRefusal::BadSince),
            }
        } else {
            ApplyViewAnswer::Accepted
        })
    }
    async fn applied_view(
        &self,
        _: &SessionRef,
    ) -> Result<AppliedViewAnswer, crate::client::ClientError> {
        if *self.fail_applied_view.lock().unwrap() {
            return Err(crate::client::ClientError::new("connection lost"));
        }
        Ok(self.applied.lock().unwrap().clone().unwrap_or_default())
    }
    async fn send(
        &self,
        _: &SessionRef,
        request: SendRequest,
    ) -> Result<SendReply, crate::client::ClientError> {
        self.sent.lock().unwrap().push(request);
        match self.send_refusals.lock().unwrap().pop_front() {
            Some(refusal) => Err(refusal),
            None => Ok(SendReply::new("pending")),
        }
    }
    async fn send_child(
        &self,
        _: &crate::client::Child,
        _: SendRequest,
    ) -> Result<SendReply, crate::client::ClientError> {
        Err(crate::client::ClientError::new("no child"))
    }
    async fn child_result(
        &self,
        _: &crate::client::Child,
        _: RunResultRequest,
    ) -> Result<RunResult, crate::client::ClientError> {
        Err(crate::client::ClientError::new("no child"))
    }
}

#[path = "contract_update_tests.rs"]
mod contract_update_tests;

fn text(ordinal: u64, name: &str) -> Entry {
    let mut part = Part::new("p", PartBody::Text { text: name.into() });
    part.tag = Some(ordinal);
    Entry::new(ordinal, name, Role::User, ordinal, vec![part])
}

fn cursor(entry: &Entry) -> Cursor {
    Cursor::new(entry.ordinal, entry.mid.clone(), entry.digest.clone())
}

fn fixture() -> (Session, Client, Route, SetupRequest, Settings) {
    let route = Route {
        session: SessionRef::new("test", "mock", "s1"),
        project: None,
        workdir: None,
        agent_id: None,
    };
    let request = SetupRequest::new(
        crate::catalog::Preset::Worker.as_str(),
        ModelRef::new("test", "model"),
        100_000,
        1000,
        ProviderRules::new(SignedParts::None, EditCost::Suffix),
        Vec::new(),
        1,
    );
    let features = Features {
        ctx_keep: true,
        ..Features::NONE
    };
    let session = Session::new(&route, &request, features, None);
    let client = Client::default();
    let settings = Settings {
        protected_tokens: Some(0),
        ..Settings::default()
    };
    (session, client, route, request, settings)
}

/// A notice on the session's conditions, under the statement epoch its
/// Setup named (none for a session set up without one).
fn notice(session: &Session, seq: u64, newest: Option<Cursor>) -> NoticeRequest {
    let mut request = NoticeRequest::new(seq, session.conditions.clone());
    request.conditions.statement_epoch = session.statement_epoch.clone();
    request.newest = newest;
    request
}

#[tokio::test]
async fn audit_views_noop_fold_does_not_authorize_the_next_notice() {
    let (mut session, client, _, _, mut settings) = fixture();
    session.features.summarizer = true;
    settings.memory_enabled = false;
    let entries = vec![text(1, "one"), text(2, "two"), text(3, "latest")];
    session.index.extend(entries.clone());
    *client.entries.lock().unwrap() = entries.clone();
    let first = session.build(&settings, None, false, None).0.unwrap();
    session.accept(first.clone());
    session.settle_unconfirmed(Some(&first.applied()), &[]);
    let below_threshold = |session: &Session, seq| {
        let mut request = notice(session, seq, entries.last().map(cursor));
        request.applied_view = Some(first.applied());
        request.conditions.last_prompt_tokens = Some(10_000);
        request.conditions.last_prompt_view = Some(first.version);
        request
    };

    settings.history_budget_percentage = 0.2;
    assert!(session.head_shape_changed(&settings));
    let request = below_threshold(&session, 1);
    session.notice(&client, &settings, request).await;
    assert!(client.offered.lock().unwrap().is_empty());
    assert!(!session.head_shape_changed(&settings));

    session
        .ctx_reduce(&client, &serde_json::json!({"drop": "2"}))
        .await
        .unwrap();
    let request = below_threshold(&session, 2);
    session.notice(&client, &settings, request).await;
    assert!(
        client.offered.lock().unwrap().is_empty(),
        "a byte-identical fold authorized an unrelated drop"
    );
    assert_eq!(session.latest.as_ref().unwrap().checksum, first.checksum);
    assert!(session.queued.contains(&("two".into(), "p".into())));

    settings.memory_budget_tokens += 1000;
    assert!(
        !session.head_shape_changed(&settings),
        "an inactive memory budget cannot change the head"
    );
}

#[tokio::test]
async fn ctx_reduce_skips_kept_notice_but_stamps_and_drops_unkept_notice() {
    use cortexkit_role_compaction::read::NoticeOrigin;

    let (mut session, client, _, _, settings) = fixture();
    session.index.extend([
        text(1, "owner").with_notice(NoticeOrigin::new("core").with_keep(true)),
        text(2, "peer").with_notice(NoticeOrigin::new("peer")),
        text(3, "latest"),
    ]);
    let reply = session
        .ctx_reduce(&client, &serde_json::json!({"drop": "1-2"}))
        .await
        .unwrap();
    assert_eq!(
        reply,
        "1 tag stamped. Skipped: §1§ is a kept notice from the person."
    );
    assert_eq!(
        session.queued,
        BTreeSet::from([("peer".into(), "p".into())])
    );
    let view = session.build(&settings, None, false, None).0.unwrap();
    assert!(view.edits.iter().any(|edit| matches!(&edit.op,
        EditOp::Replace { mid, field, value, .. }
            if mid == "peer" && field == "text" && value == "[dropped §2§]")));
    assert!(!view.edits.iter().any(|edit| matches!(&edit.op,
        EditOp::Replace { mid, .. } | EditOp::Drop { mid, .. } if mid == "owner")));
}

#[tokio::test]
async fn audit_views_refusal_preserves_later_stamp() {
    let (mut session, client, _, _, settings) = fixture();
    let entries = vec![text(1, "one"), text(2, "two"), text(3, "latest")];
    session.index.extend(entries.clone());
    let stamp = |tag: &str| serde_json::json!({"drop": tag});
    assert_eq!(
        session.ctx_reduce(&client, &stamp("1")).await.unwrap(),
        "1 tag stamped."
    );
    let view = session.build(&settings, None, false, None).0.unwrap();
    assert!(session.publish(&client, view.clone()).await);
    assert_eq!(
        session.ctx_reduce(&client, &stamp("2")).await.unwrap(),
        "1 tag stamped."
    );

    let mut request = notice(&session, 1, entries.last().map(cursor));
    request.entries = entries;
    request.events = vec![Event::ViewRefused {
        version: view.version,
        refusal: ViewRefusal::BadSince,
    }];
    session.notice(&client, &settings, request).await;
    assert_eq!(
        session.queued,
        BTreeSet::from([("one".into(), "p".into()), ("two".into(), "p".into())]),
        "refusing an earlier view must not lose a later stamp"
    );
}

#[tokio::test]
async fn audit_views_no_hold_for_already_dropped_thinking() {
    use cortexkit_role_compaction::part::Seal;
    use cortexkit_role_compaction::read::StepUsage;

    let (mut session, client, _, _, settings) = fixture();
    session.conditions.rules.signed_parts = SignedParts::Bound;
    session.conditions.last_prompt_tokens = Some(70_000);
    let mut thinking = Entry::new(
        2,
        "think",
        Role::Assistant,
        0,
        vec![Part::new(
            "r",
            PartBody::Reasoning {
                text: None,
                text_bytes: Some(12_000),
            },
        )
        .with_seal(Seal::Signed)],
    );
    let mut usage = StepUsage::new();
    usage.reasoning_tokens = Some(3_000);
    thinking.usage = Some(usage);
    let mut last = text(3, "last");
    last.role = Role::Assistant;
    session.index.extend([text(1, "task"), thinking, last]);
    assert!(!session.rebuild_permitted(&settings));

    let view = session
        .seal(
            vec![EditOp::Drop {
                mid: "think".into(),
                part: Some("r".into()),
            }],
            &[],
        )
        .unwrap();
    assert!(session.publish(&client, view.clone()).await);
    assert!(
        !session.rebuild_permitted(&settings),
        "accepted does not mean applied"
    );
    session.settle_unconfirmed(Some(&view.applied()), &[]);
    assert!(
        session.rebuild_permitted(&settings),
        "the applied view dropped the turn's heavy reasoning"
    );
}

#[tokio::test]
async fn review_probe_held_signed_block_survives_an_applied_partial_drop() {
    use cortexkit_role_compaction::part::Seal;
    use cortexkit_role_compaction::read::StepUsage;

    let (mut session, _, _, _, settings) = fixture();
    session.conditions.rules.signed_parts = SignedParts::Bound;
    session.conditions.last_prompt_tokens = Some(70_000);
    let signed = |id| {
        Part::new(
            id,
            PartBody::Reasoning {
                text: None,
                text_bytes: Some(4),
            },
        )
        .with_seal(Seal::Signed)
    };
    let mut thinking = Entry::new(
        2,
        "think",
        Role::Assistant,
        0,
        vec![signed("first"), signed("kept")],
    );
    let mut usage = StepUsage::new();
    usage.reasoning_tokens = Some(3_000);
    thinking.usage = Some(usage);
    let mut last = text(3, "last");
    last.role = Role::Assistant;
    session.index.extend([text(1, "task"), thinking, last]);
    let view = session
        .seal(
            vec![EditOp::Drop {
                mid: "think".into(),
                part: Some("first".into()),
            }],
            &[],
        )
        .unwrap();
    assert!(!view
        .edits
        .iter()
        .any(|edit| matches!(&edit.op, EditOp::Drop { part: Some(part), .. } if part == "kept")));
    session.accept(view.clone());
    session.settle_unconfirmed(Some(&view.applied()), &[]);
    assert!(
        !session.rebuild_permitted(&settings),
        "the applied view still serves a signed block from the heavy step"
    );
}

#[tokio::test]
async fn audit_views_ordinary_rebuild_and_defer_keep_wire_bytes() {
    use cortexkit_role_compaction::view::Edit;

    let (mut session, client, _, _, settings) = fixture();
    let old = text(1, "earlier");
    let pinned = View::seal(
        1,
        vec![Edit::new(
            1,
            EditOp::Replace {
                mid: "earlier".into(),
                part: "p".into(),
                field: "text".into(),
                value: serde_json::json!("[dropped §1§]"),
                expect: old.parts[0].digest.clone(),
            },
        )],
    );
    let bytes = serde_json::to_vec(&pinned).unwrap();
    let entries = vec![old, text(2, "latest")];
    *client.entries.lock().unwrap() = entries.clone();
    session.index.extend(entries.clone());
    session
        .ctx_reduce(&client, &serde_json::json!({"drop":"1"}))
        .await
        .unwrap();
    let mut execute = notice(&session, 1, entries.last().map(cursor));
    execute.conditions.last_prompt_tokens = Some(70_000);
    session.notice(&client, &settings, execute).await;
    assert_eq!(client.offered.lock().unwrap().len(), 1);
    assert_eq!(
        serde_json::to_vec(&client.offered.lock().unwrap()[0]).unwrap(),
        bytes
    );

    let mut defer = notice(&session, 2, entries.last().map(cursor));
    defer.applied_view = Some(pinned.applied());
    defer.conditions.last_prompt_view = Some(pinned.version);
    defer.conditions.last_prompt_tokens = Some(30_000);
    session.notice(&client, &settings, defer).await;
    assert_eq!(client.offered.lock().unwrap().len(), 1);
    assert_eq!(
        serde_json::to_vec(session.latest.as_ref().unwrap()).unwrap(),
        bytes
    );
}

#[tokio::test]
async fn lifecycle_notice_divergence_reads_again_from_the_cut() {
    let (mut session, client, _, _, settings) = fixture();
    let entries = vec![text(1, "a"), text(2, "b"), text(3, "c")];
    session.index.extend(entries.clone());
    let mut replacement = entries;
    replacement[1] = text(2, "replacement");
    *client.entries.lock().unwrap() = replacement.clone();
    let mut request = notice(&session, 1, replacement.last().map(cursor));
    request.entries = vec![replacement[1].clone()];
    session.notice(&client, &settings, request).await;
    assert_eq!(session.index.entries()[1].mid, "replacement");
    assert!(matches!(
        client.reads.lock().unwrap()[0].select,
        Select::After {
            after_ordinal: None,
            ..
        }
    ));
}

#[tokio::test]
async fn lifecycle_failed_catchup_preserves_held_work_and_publishes_nothing() {
    let (mut session, client, _, _, settings) = fixture();
    let entries = vec![text(1, "a"), text(2, "b"), text(3, "c")];
    session.index.extend(entries.clone());
    session.queued.insert(("a".into(), "p".into()));
    session.pending_keep = Some(BTreeSet::from([("missing".into(), "p".into())]));
    client
        .pages
        .lock()
        .unwrap()
        .push_back(Err(crate::client::ClientError::new("read unavailable")));
    let mut request = notice(&session, 1, Some(cursor(&text(4, "d"))));
    request.conditions.last_prompt_tokens = Some(90_000);
    session.notice(&client, &settings, request).await;
    assert!(
        client.offered.lock().unwrap().is_empty(),
        "a failed catch-up published a view"
    );
    assert!(session.queued.contains(&("a".into(), "p".into())));
    assert!(session.pending_keep.is_some());
    *client.entries.lock().unwrap() = entries;
    let request = notice(
        &session,
        2,
        client.entries.lock().unwrap().last().map(cursor),
    );
    session.notice(&client, &settings, request).await;
    assert!(session.pending_keep.is_none());
}

#[tokio::test]
async fn lifecycle_second_divergence_stops_the_pass() {
    let (mut session, client, _, _, settings) = fixture();
    session.index.extend(vec![text(1, "a"), text(2, "b")]);
    session.pending_keep = Some(BTreeSet::from([("a".into(), "p".into())]));
    for entries in [vec![text(1, "replacement")], vec![text(3, "c")]] {
        let mut head = Head::new();
        head.newest = Some(cursor(&text(3, "c")));
        client
            .pages
            .lock()
            .unwrap()
            .push_back(Ok(ReadPage::new(entries, head)));
    }
    let request = notice(&session, 1, Some(cursor(&text(4, "d"))));
    session.notice(&client, &settings, request).await;
    assert!(client.offered.lock().unwrap().is_empty());
    assert!(
        session.pending_keep.is_some(),
        "stopped catch-up consumed held work"
    );
    assert_eq!(client.reads.lock().unwrap().len(), 2);
}

#[test]
fn lifecycle_forget_missing_filters_keep_and_drops_an_empty_list() {
    let (mut session, _, _, _, _) = fixture();
    session.index.extend(vec![text(1, "a")]);
    session.pending_keep = Some(BTreeSet::from([
        ("gone".into(), "p".into()),
        ("a".into(), "p".into()),
    ]));
    session.forget_missing();
    assert_eq!(
        session.pending_keep,
        Some(BTreeSet::from([("a".into(), "p".into())]))
    );
    session.index.truncate(1);
    session.forget_missing();
    assert!(session.pending_keep.is_none());
}

#[test]
fn lifecycle_pending_keep_survives_serialization() {
    let (mut session, _, _, _, _) = fixture();
    session.pending_keep = Some(BTreeSet::from([("a".into(), "p".into())]));
    let bytes = serde_json::to_vec(&session.durable()).unwrap();
    let (mut restored, _, _, _, _) = fixture();
    restored.restore(serde_json::from_slice(&bytes).unwrap());
    assert_eq!(restored.pending_keep, session.pending_keep);
}

#[test]
fn lifecycle_restored_worker_keeps_its_catalog_tool_policy() {
    let (mut session, _, _, _, _) = fixture();
    session.preset = crate::catalog::Preset::Worker;
    let (mut restored, _, _, _, _) = fixture();
    restored.preset = crate::catalog::Preset::Head;
    restored.restore(session.durable());
    let config = crate::config::Config::from(Settings::default()).catalog_config(None);
    assert!(
        restored.serves_tool("ctx_keep", &config),
        "restoring a worker changed its catalog policy"
    );
}

#[test]
fn lifecycle_head_retry_survives_serialization() {
    let (mut session, _, _, _, _) = fixture();
    session.head_stale = true;
    let bytes = serde_json::to_vec(&session.durable()).unwrap();
    let (mut restored, _, _, _, _) = fixture();
    restored.restore(serde_json::from_slice(&bytes).unwrap());
    assert!(restored.head_stale);
}

#[tokio::test]
async fn lifecycle_a_transcript_shorter_than_the_saved_cut_can_grow_again() {
    let (mut session, client, route, mut request, settings) = fixture();
    session.restore(crate::store::Durable {
        cut: Some(20),
        ..Default::default()
    });
    let entries: Vec<_> = (1..=5).map(|n| text(n, &format!("m{n}"))).collect();
    *client.entries.lock().unwrap() = entries.clone();
    request.newest = entries.last().map(cursor);
    session
        .setup(
            &client,
            &settings,
            &route,
            &request,
            Features {
                ctx_keep: true,
                ..Features::NONE
            },
        )
        .await;
    let mut request = notice(&session, 1, Some(cursor(&text(7, "m7"))));
    request.entries = vec![text(6, "m6"), text(7, "m7")];
    session.notice(&client, &settings, request).await;
    let answer = session
        .ctx_reduce(&client, &serde_json::json!({"drop":"6"}))
        .await
        .unwrap();
    assert!(
        session.queued.contains(&("m6".into(), "p".into())),
        "{answer}"
    );
    assert_eq!(session.cut, None);
}

#[tokio::test]
async fn lifecycle_a_second_shrink_below_the_cut_stops_catchup() {
    let (mut session, client, _, _, settings) = fixture();
    let dir = scratch("shrinking-cut");
    with_summary(&mut session, &dir, "b");
    session.cut = Some(20);
    session.pending_keep = Some(BTreeSet::from([("a".into(), "p".into())]));
    for newest in [Some(cursor(&text(5, "m5"))), None] {
        let mut head = Head::new();
        head.newest = newest;
        client
            .pages
            .lock()
            .unwrap()
            .push_back(Ok(ReadPage::new(Vec::new(), head)));
    }
    let request = notice(&session, 1, Some(cursor(&text(5, "m5"))));
    session.notice(&client, &settings, request).await;
    assert!(
        session.pending_keep.is_some(),
        "a repeatedly shrinking transcript consumed held work"
    );
    assert!(client.offered.lock().unwrap().is_empty());
    assert_eq!(client.reads.lock().unwrap().len(), 2);
    drop(session);
    std::fs::remove_dir_all(dir).unwrap();
}

fn scratch(label: &str) -> std::path::PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/scratch")
        .join(format!(
            "lifecycle-{label}-{}-{now}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn with_summary(session: &mut Session, dir: &std::path::Path, end: &str) {
    let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    db.with_connection(|conn| {
        conn.execute("INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, created_at, harness) VALUES ('s1', 1, 1, 2, 'a', ?1, 'undone', 'undone history', 'undone history', 1, 'mock')", [end]).map_err(|e| e.to_string())
    }).unwrap();
    session.db = Some(Arc::new(db));
    session.features.summarizer = true;
    session.load_summaries();
}

#[tokio::test]
async fn lifecycle_setup_reconciles_a_revert_acknowledged_before_a_crash() {
    let (mut session, client, route, mut request, settings) = fixture();
    let dir = scratch("lost-revert");
    with_summary(&mut session, &dir, "removed");
    session.index.extend(vec![text(1, "a"), text(2, "removed")]);
    let (view, _) = session.build(&settings, None, false, None);
    session.accept(view.unwrap());
    let durable = session.durable();
    let (mut restored, _, _, _, _) = fixture();
    restored.db = session.db.clone();
    restored.load_summaries();
    restored.restore(durable);
    *client.entries.lock().unwrap() = vec![text(1, "a"), text(2, "replacement")];
    request.newest = client.entries.lock().unwrap().last().map(cursor);
    restored
        .setup(&client, &settings, &route, &request, session.features)
        .await;
    assert!(
        restored.summaries.is_empty(),
        "Setup retained undone summaries"
    );
    assert!(restored
        .db
        .as_ref()
        .unwrap()
        .compartments("mock", "s1")
        .unwrap()
        .is_empty());
    assert!(restored.head_stale);
    drop((session, restored));
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn lifecycle_setup_preserves_legacy_summaries_without_endpoint_metadata() {
    let (mut session, client, route, mut request, settings) = fixture();
    let dir = scratch("legacy-summary");
    with_summary(&mut session, &dir, "");
    *client.entries.lock().unwrap() = vec![text(1, "a")];
    request.newest = Some(cursor(&text(1, "a")));
    session
        .setup(&client, &settings, &route, &request, session.features)
        .await;
    assert_eq!(
        session.summaries.len(),
        1,
        "missing legacy endpoint metadata is not evidence of a revert"
    );
    drop(session);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn lifecycle_a_delayed_revert_preserves_summaries_of_the_replacement_branch() {
    let (mut session, client, _, _, settings) = fixture();
    let dir = scratch("stale-revert");
    with_summary(&mut session, &dir, "replacement");
    *client.entries.lock().unwrap() = vec![text(1, "a"), text(2, "replacement")];
    session.index.extend(client.entries.lock().unwrap().clone());
    let mut request = notice(
        &session,
        1,
        client.entries.lock().unwrap().last().map(cursor),
    );
    request
        .events
        .push(Event::TranscriptChanged { from_ordinal: 2 });
    session.notice(&client, &settings, request).await;
    assert_eq!(session.summaries.len(), 1);
    assert_eq!(
        session
            .db
            .as_ref()
            .unwrap()
            .compartments("mock", "s1")
            .unwrap()
            .len(),
        1
    );
    drop(session);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn lifecycle_refused_head_rebuild_remains_due_until_a_later_acceptance() {
    let (mut session, client, _, _, settings) = fixture();
    session.features.summarizer = true;
    session.index.extend(vec![text(1, "a")]);
    *client.entries.lock().unwrap() = vec![text(1, "a")];
    session.head_stale = true;
    *client.refuse.lock().unwrap() = true;
    let request = notice(&session, 1, Some(cursor(&text(1, "a"))));
    session.notice(&client, &settings, request).await;
    assert!(session.head_stale, "a refused rebuild consumed the retry");
    *client.refuse.lock().unwrap() = false;
    let request = notice(&session, 2, Some(cursor(&text(1, "a"))));
    session.notice(&client, &settings, request).await;
    assert_eq!(client.offered.lock().unwrap().len(), 2);
    assert!(!session.head_stale);
}

#[test]
fn lifecycle_rolling_back_an_earlier_view_restores_a_later_head_retry() {
    let (mut session, _, _, _, settings) = fixture();
    session.features.summarizer = true;
    let (view, _) = session.build(&settings, None, false, None);
    session.accept(view.unwrap());
    session.head_stale = true;
    session.next_baseline = session.baseline.clone();
    session.accept(View::seal(2, Vec::new()));
    assert!(!session.head_stale);
    session.roll_back(1, false, None);
    assert!(
        session.head_stale,
        "rolling back a chain lost its later rebuild obligation"
    );
}

#[tokio::test]
async fn lifecycle_failed_write_ahead_save_never_hands_over_a_view() {
    let (mut session, client, _, _, settings) = fixture();
    let dir = scratch("write-ahead");
    let store = crate::store::Store::open(&dir.join("sessions.db")).unwrap();
    session.set_store(Some(Arc::new(store)));
    rusqlite::Connection::open(dir.join("sessions.db"))
        .unwrap()
        .execute("DROP TABLE sessions", [])
        .unwrap();
    session.features.summarizer = true;
    session.head_stale = true;
    let request = notice(&session, 1, None);
    session.notice(&client, &settings, request).await;
    assert!(
        client.offered.lock().unwrap().is_empty(),
        "view escaped a failed durable save"
    );
    assert!(session.head_stale);
    drop(session);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn lifecycle_store_save_reports_failure_and_never_waits_on_a_writer() {
    let dir = scratch("locks");
    let store = crate::store::Store::open(&dir.join("sessions.db")).unwrap();
    let blocker = rusqlite::Connection::open(dir.join("sessions.db")).unwrap();
    blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
    let (session, _, _, _, _) = fixture();
    let start = std::time::Instant::now();
    let result = format!("{:?}", store.save(session.key(), &session.durable()));
    assert!(
        start.elapsed() < std::time::Duration::from_millis(100),
        "a locked store stalled its worker"
    );
    assert!(
        result.starts_with("Err("),
        "save swallowed its error: {result}"
    );
    blocker.execute_batch("ROLLBACK").unwrap();
    drop((blocker, store));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn lifecycle_context_writes_wait_briefly_for_an_external_writer() {
    let dir = scratch("context-locks");
    let path = dir.join("context.db");
    let db = ContextDb::create_for_tests(&path).unwrap();
    let blocker = rusqlite::Connection::open(&path).unwrap();
    blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
    let start = std::time::Instant::now();
    let held = db.with_connection(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE; ROLLBACK")
            .map_err(|error| error.to_string())
    });
    let waited = start.elapsed();
    assert!(held.is_err(), "a held write lock was not reported");
    // A collision waits a little, as the plugin's own writes do, instead
    // of failing at once; a stuck writer stalls the thread only that long.
    assert!(
        waited >= std::time::Duration::from_millis(200),
        "gave up after {waited:?}"
    );
    assert!(
        waited < std::time::Duration::from_secs(2),
        "a held lock stalled the worker for {waited:?}"
    );
    blocker.execute_batch("ROLLBACK").unwrap();
    assert!(db
        .with_connection(|conn| conn
            .execute_batch("BEGIN IMMEDIATE; ROLLBACK")
            .map_err(|error| error.to_string()))
        .is_ok());
    drop((blocker, db));
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn lifecycle_refused_automatic_drops_are_not_offered_on_every_pass() {
    let (mut session, client, _, _, settings) = fixture();
    // The old output sits outside the protected tail: three newer calls, and
    // no token floor beyond them.
    let settings = Settings {
        protected_tokens: Some(0),
        ..settings
    };
    let tool_part = |id: &str, tag: u64, output_bytes: u64| -> Part {
        let mut part: Part = serde_json::from_value(serde_json::json!({
            "id":id, "kind":"tool", "call_id":id, "name":"read", "input":{"path": id},
            "status":"completed", "output":"result", "output_bytes":output_bytes, "digest":""
        }))
        .unwrap();
        part.tag = Some(tag);
        part
    };
    session.index.extend(vec![
        text(1, "task"),
        Entry::new(
            2,
            "tool",
            Role::Assistant,
            2,
            vec![tool_part("p", 2, 40000)],
        ),
        text(3, "next"),
        Entry::new(
            4,
            "newer",
            Role::Assistant,
            4,
            vec![
                tool_part("q", 4, 10),
                tool_part("r", 5, 10),
                tool_part("s", 6, 10),
            ],
        ),
    ]);
    session.reclaim_bookmark = 2;
    *client.refuse.lock().unwrap() = true;
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("the automatic age sweep selected the old output");
    assert!(session.next_covered.contains(&("tool".into(), "p".into())));
    session.publish(&client, view).await;
    let (again, _) = session.build(&settings, None, false, None);
    assert!(
        again.is_none(),
        "a refused automatic drop was immediately rebuilt"
    );
}

#[tokio::test]
async fn lifecycle_revert_removes_summary_rows_and_raw_search_rows() {
    let (mut session, client, _, _, settings) = fixture();
    let dir = scratch("search-revert");
    with_summary(&mut session, &dir, "removed");
    session.index.extend(vec![text(1, "a"), text(2, "removed")]);
    session.db.as_ref().unwrap().with_connection(|conn| {
        crate::search::messages::index(conn, "mock", "s1", session.index.entries()).unwrap()
    });
    *client.entries.lock().unwrap() = vec![text(1, "a")];
    let mut request = notice(&session, 1, Some(cursor(&text(1, "a"))));
    request
        .events
        .push(Event::TranscriptChanged { from_ordinal: 2 });
    session.notice(&client, &settings, request).await;
    // Notice invalidates summary state immediately; raw search cleanup now
    // runs on the independent indexer and is fenced only for this assertion.
    let search = crate::search::background::Background::new(
        Arc::new(client),
        dir.join("context.db"),
        session.db.as_ref().unwrap().message_index.clone(),
    );
    let key = session.key().clone();
    search.mark(&key, session.search_mark());
    search.idle(&key).await.unwrap();
    let db = session.db.as_ref().unwrap();
    assert!(db.compartments("mock", "s1").unwrap().is_empty());
    let removed: u64 = db.with_connection(|conn| conn.query_row("SELECT COUNT(*) FROM message_history_source WHERE session_id = 's1' AND message_id = 'removed'", [], |row| row.get(0))).unwrap();
    assert_eq!(removed, 0);
    drop((search, session));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn quiet_durable_snapshots_share_the_unchanged_history_baseline() {
    let (mut session, _, _, _, _) = fixture();
    session.baseline = Some(Arc::new(Baseline {
        m0: "unchanged history ".repeat(12_000).into(),
        ..Baseline::default()
    }));
    let first = session.durable();
    let second = session.durable();
    assert!(Arc::ptr_eq(
        first.baseline.as_ref().unwrap(),
        second.baseline.as_ref().unwrap()
    ));
    let bytes = serde_json::to_vec(&first).unwrap();
    let decoded: crate::store::Durable = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(first, decoded);
    assert_eq!(
        serde_json::to_value(first).unwrap()["baseline"]["m0"],
        *session.baseline.as_ref().unwrap().m0
    );
}

#[test]
fn lifecycle_the_index_keeps_compact_sizes_tags_and_full_checksums() {
    use cortexkit_role_compaction::part::{Seal, ToolPart, ToolStatus};
    let mut transcript = mc_mock_runner::transcript::Transcript::new(40);
    transcript.append(
        Role::Assistant,
        None,
        vec![
            (
                Seal::None,
                PartBody::Text {
                    text: "the full reply".into(),
                },
            ),
            (
                Seal::None,
                PartBody::Tool(ToolPart::new(
                    "c",
                    "read",
                    serde_json::json!({"path":"file.rs"}),
                    ToolStatus::Running,
                )),
            ),
        ],
        None,
        None,
        1,
    );
    transcript
        .complete_tool(
            "c",
            ToolStatus::Completed,
            "output bytes".into(),
            vec![],
            vec![],
        )
        .unwrap();
    let (compact, _) = transcript
        .read(
            &Select::After {
                after_ordinal: None,
                limit: None,
            },
            Detail::Compact,
            None,
        )
        .unwrap();
    let mut index = Index::default();
    assert_eq!(index.extend(compact), Extend::Continued);
    let held = &index.entries()[0];
    assert_eq!(held.digest, transcript.entries()[0].digest);
    assert!(matches!(&held.parts[0].body, PartBody::Text {text} if text == "the full reply"));
    assert_eq!(held.parts[0].tag, Some(41));
    let PartBody::Tool(tool) = &held.parts[1].body else {
        panic!("missing tool")
    };
    assert_eq!(tool.input, serde_json::json!({"path":"file.rs"}));
    assert_eq!(tool.output, None);
    assert_eq!(tool.output_bytes, Some(12));
    assert_eq!(
        held.parts[1].digest,
        transcript.entries()[0].parts[1].digest
    );
    assert_eq!(held.parts[1].tag, Some(42));
}

#[test]
fn a_restarted_session_serves_the_same_mural_image_from_the_store() {
    let dir = scratch("mural-restart");
    let store = Arc::new(crate::store::Store::open(&dir.join("sessions.db")).unwrap());
    let (mut session, _, _, _, _) = fixture();
    session.set_store(Some(store.clone()));
    session.keep_mural(crate::mural::Mural {
        png: vec![0x89, b'P', b'N', b'G', 1, 2, 3],
        content_hash: "layout-1".into(),
        width: 1,
        height: 1,
        memory_ids: vec![1],
    });
    let before = session.mural_png("layout-1").expect("kept in memory");
    // A restarted process has nothing in memory: m[0] must still carry the
    // same bytes, from the store.
    let (mut restarted, _, _, _, _) = fixture();
    restarted.set_store(Some(store));
    assert_eq!(restarted.mural_png("layout-1"), Some(before));
    // A mural the store doesn't hold is left out, not invented.
    assert_eq!(restarted.mural_png("layout-2"), None);
    drop((session, restarted));
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn lifecycle_a_refused_provider_does_no_work_until_the_next_setup() {
    let (mut session, client, route, mut setup, settings) = fixture();
    let entries = vec![text(1, "a"), text(2, "b")];
    session.index.extend(entries.clone());
    *client.entries.lock().unwrap() = entries;
    // The runner's plan no longer names ck-mc as the session's provider.
    client
        .pages
        .lock()
        .unwrap()
        .push_back(Err(crate::client::ClientError::refused(
            cortexkit_role_compaction::wire::codes::COMPACTION_NOT_PERMITTED,
            "provider_mismatch",
        )));
    let request = notice(&session, 1, Some(cursor(&text(3, "c"))));
    session.notice(&client, &settings, request).await;
    assert!(session.suspended);

    // Later notices read nothing and publish nothing, even under pressure,
    // and a ride answers nothing.
    let reads = client.reads.lock().unwrap().len();
    let mut request = notice(&session, 2, Some(cursor(&text(3, "c"))));
    request.conditions.last_prompt_tokens = Some(99_000);
    let conditions = request.conditions.clone();
    session.notice(&client, &settings, request).await;
    let ride = RideRequest::new(vec![RideCause::CacheExpired], 1_000, conditions);
    assert!(session.ride(&settings, &ride).is_none());
    assert_eq!(client.reads.lock().unwrap().len(), reads);
    assert!(client.offered.lock().unwrap().is_empty());

    // The runner's next Setup lifts it, and work resumes from the state kept.
    *client.entries.lock().unwrap() = vec![text(1, "a"), text(2, "b"), text(3, "c")];
    setup.newest = Some(cursor(&text(3, "c")));
    session
        .setup(&client, &settings, &route, &setup, session.features)
        .await;
    assert!(!session.suspended);
    assert!(session.index_ready);
    assert_eq!(session.index.entries().len(), 3);
}

#[tokio::test]
async fn lifecycle_restored_state_ahead_of_context_db_moves_the_cut_back() {
    // A backup can pair a fresh sessions.db with an older context.db. Here the
    // saved state cuts through message d, behind a summary context.db no
    // longer has.
    let (mut session, client, route, mut request, settings) = fixture();
    let dir = scratch("store-ahead");
    let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    db.with_connection(|conn| {
        conn.execute_batch(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, created_at, harness)
             VALUES ('s1', 1, 1, 2, 'a', 'b', 'first', 'first part', 'first part', 1, 'mock'),
                    ('s1', 2, 3, 4, 'c', 'd', 'second', 'second part', 'second part', 1, 'mock');",
        )
        .map_err(|e| e.to_string())
    })
    .unwrap();
    session.db = Some(Arc::new(db));
    session.features.summarizer = true;
    session.load_summaries();
    let entries = vec![
        text(1, "a"),
        text(2, "b"),
        text(3, "c"),
        text(4, "d"),
        text(5, "e"),
    ];
    session.index.extend(entries.clone());
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.unwrap();
    session.accept(view.clone());
    assert_eq!(session.cut, Some(4));
    let durable = session.durable();
    session
        .db
        .as_ref()
        .unwrap()
        .with_connection(|conn| conn.execute("DELETE FROM compartments WHERE sequence = 2", []))
        .unwrap();

    let (mut restored, _, _, _, _) = fixture();
    restored.db = session.db.clone();
    restored.load_summaries();
    restored.restore(durable);
    assert_eq!(
        restored.cut,
        Some(2),
        "the cut follows context.db's summaries"
    );
    assert!(restored.baseline.is_none());
    assert!(restored.head_stale);

    // The runner still applies the old view; adopting it keeps ck-mc's cut,
    // and the next view moves the runner's cut back to message b.
    *client.entries.lock().unwrap() = entries;
    request.newest = client.entries.lock().unwrap().last().map(cursor);
    restored.apply_cut(&view);
    assert_eq!(restored.cut, Some(2));
    restored
        .setup(&client, &settings, &route, &request, session.features)
        .await;
    let notice = notice(&restored, 1, request.newest.clone());
    restored.notice(&client, &settings, notice).await;
    let offered = client.offered.lock().unwrap();
    let cut = offered.last().and_then(|view| {
        view.edits.iter().find_map(|edit| match &edit.op {
            EditOp::Cut { through } => Some(through.clone()),
            _ => None,
        })
    });
    assert_eq!(cut.as_deref(), Some("b"), "{offered:?}");
    drop(offered);
    drop((session, restored));
    std::fs::remove_dir_all(dir).unwrap();
}

/// A summary that reaches the newest message with parts doesn't cut it, even
/// when messages with no parts follow it (a step the runner has opened but
/// not filled): the request ends on that message, so the cut stops one
/// before. Measured from the very last message, the cut went through it and
/// every history view was refused.
#[tokio::test]
async fn lifecycle_the_cut_stops_before_the_message_the_request_ends_on() {
    let (mut session, _, _, _, settings) = fixture();
    let dir = scratch("cut-final-turn");
    let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    db.with_connection(|conn| {
        conn.execute_batch(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, created_at, harness)
             VALUES ('s1', 1, 1, 4, 'a', 'd', 'all of it', 'all of it', 'all of it', 1, 'mock');",
        )
        .map_err(|e| e.to_string())
    })
    .unwrap();
    session.db = Some(Arc::new(db));
    session.features.summarizer = true;
    session.load_summaries();
    let empty =
        |ordinal: u64, mid: &str| Entry::new(ordinal, mid, Role::Assistant, ordinal, vec![]);
    session.index.extend(vec![
        text(1, "a"),
        text(2, "b"),
        text(3, "c"),
        text(4, "d"),
        empty(5, "e"),
        empty(6, "f"),
    ]);
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("a history view");
    let cut = view.edits.iter().find_map(|edit| match &edit.op {
        EditOp::Cut { through } => Some(through.clone()),
        _ => None,
    });
    assert_eq!(cut.as_deref(), Some("c"), "{view:?}");
    drop(session);
    std::fs::remove_dir_all(dir).unwrap();
}

/// Two old outputs outside the protected tail, both picked by the age sweep.
fn two_old_outputs(session: &mut Session) {
    let tool_part = |id: &str, tag: u64, output_bytes: u64| -> Part {
        let mut part: Part = serde_json::from_value(serde_json::json!({
            "id":id, "kind":"tool", "call_id":id, "name":"read", "input":{"path": id},
            "status":"completed", "output":"result", "output_bytes":output_bytes, "digest":""
        }))
        .unwrap();
        part.tag = Some(tag);
        part
    };
    session.index.extend(vec![
        text(1, "task"),
        Entry::new(
            2,
            "old",
            Role::Assistant,
            2,
            vec![tool_part("p", 2, 40000), tool_part("p2", 3, 40000)],
        ),
        text(3, "next"),
        Entry::new(
            4,
            "newer",
            Role::Assistant,
            4,
            vec![
                tool_part("q", 4, 10),
                tool_part("r", 5, 10),
                tool_part("s", 6, 10),
            ],
        ),
    ]);
    session.reclaim_bookmark = 3;
}

/// A refusal that names the part at fault sets aside only that part: the
/// view's other automatic drops are offered again on the next pass.
#[tokio::test]
async fn lifecycle_a_refusal_naming_a_part_sets_aside_only_that_part() {
    let (mut session, client, _, _, settings) = fixture();
    let settings = Settings {
        protected_tokens: Some(0),
        ..settings
    };
    two_old_outputs(&mut session);
    *client.refuse.lock().unwrap() = true;
    *client.refusal.lock().unwrap() = Some(ViewRefusal::StalePart {
        mid: "old".into(),
        part: "p".into(),
    });
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("both old outputs selected");
    assert!(session.next_covered.contains(&("old".into(), "p".into())));
    assert!(session.next_covered.contains(&("old".into(), "p2".into())));
    session.publish(&client, view).await;
    assert!(session.failed_parts.contains(&("old".into(), "p".into())));
    assert!(
        !session.failed_parts.contains(&("old".into(), "p2".into())),
        "a part the refusal did not name was set aside"
    );
}

/// Automatic and requested drops share a view, but only the refused work
/// should be set aside. Three newer tool calls keep the old outputs outside
/// the protected tail, so every old output remains eligible for dropping.
fn refusal_fixture() -> (Session, Client, Settings) {
    let (mut session, client, _, _, settings) = fixture();
    two_old_outputs(&mut session);
    let mut entries = session.index.entries().to_vec();
    entries[1]
        .parts
        .extend([output_part("queued-a", 4), output_part("queued-b", 5)]);
    for (part, tag) in entries[3].parts.iter_mut().zip(6..=8) {
        part.tag = Some(tag);
    }
    session.index = Index::starting_at(1);
    session.index.extend(entries.clone());
    *client.entries.lock().unwrap() = entries;
    session.queued = queued_refusal_parts();
    (session, client, settings)
}

fn queued_refusal_parts() -> BTreeSet<lanes::PartKey> {
    [
        ("old".into(), "queued-a".into()),
        ("old".into(), "queued-b".into()),
    ]
    .into()
}

fn assert_carries_queued_drops(view: &View) {
    for (_, expected) in queued_refusal_parts() {
        assert!(
            view.edits.iter().any(|edit| matches!(
                &edit.op,
                EditOp::Replace { mid, part, field, .. }
                    if mid == "old" && part == &expected && field == "output"
            )),
            "view {} did not carry queued drop {expected}: {:?}",
            view.version,
            view.edits
        );
    }
}

async fn refuse_at_boundary(
    session: &mut Session,
    client: &Client,
    settings: &Settings,
    seq: u64,
    refusal: ViewRefusal,
) {
    let version = session.latest.as_ref().unwrap().version;
    let newest = client.entries.lock().unwrap().last().map(cursor);
    let mut request = notice(session, seq, newest);
    request.events.push(Event::ViewRefused { version, refusal });
    session.notice(client, settings, request).await;
}

#[tokio::test]
async fn lifecycle_boundary_part_refusals_preserve_other_queued_drops() {
    let (mut session, client, settings) = refusal_fixture();
    for (seq, culprit) in [(1, "p"), (2, "p2")] {
        let (view, _) = session.build(&settings, None, false, None);
        let view = view.expect("old outputs remain eligible");
        assert_carries_queued_drops(&view);
        session.publish(&client, view).await;
        refuse_at_boundary(
            &mut session,
            &client,
            &settings,
            seq,
            ViewRefusal::StalePart {
                mid: "old".into(),
                part: culprit.into(),
            },
        )
        .await;
        assert_eq!(session.queued, queued_refusal_parts());
        assert!(session.refused_once.is_empty());
        let expected: BTreeSet<_> = if seq == 1 { vec!["p"] } else { vec!["p", "p2"] }
            .into_iter()
            .map(|part| ("old".into(), part.into()))
            .collect();
        assert_eq!(session.failed_parts, expected);
    }
    let (view, _) = session.build(&settings, None, false, None);
    assert_carries_queued_drops(&view.expect("requested drops still queued"));
}

#[tokio::test]
async fn lifecycle_boundary_part_refusals_forget_only_the_repeated_culprit() {
    let (mut session, client, settings) = refusal_fixture();
    for seq in 1..=2 {
        let (view, _) = session.build(&settings, None, false, None);
        session.publish(&client, view.unwrap()).await;
        refuse_at_boundary(
            &mut session,
            &client,
            &settings,
            seq,
            ViewRefusal::StalePart {
                mid: "old".into(),
                part: "queued-a".into(),
            },
        )
        .await;
        assert!(session.failed_parts.is_empty());
        assert!(session.queued.contains(&("old".into(), "queued-b".into())));
        assert!(!session
            .refused_once
            .contains(&("old".into(), "queued-b".into())));
    }
    assert!(!session.queued.contains(&("old".into(), "queued-a".into())));
}

fn final_turn_refusal() -> ViewRefusal {
    ViewRefusal::Rule(RuleBreak::FinalTurnRemoved { index: 0 })
}

#[tokio::test]
async fn lifecycle_boundary_final_turn_refusal_retries_after_transcript_growth() {
    let (mut session, client, settings) = refusal_fixture();
    let (view, _) = session.build(&settings, None, false, None);
    session.publish(&client, view.unwrap()).await;
    client.entries.lock().unwrap().push(text(5, "grown"));
    refuse_at_boundary(&mut session, &client, &settings, 1, final_turn_refusal()).await;
    assert_eq!(session.queued, queued_refusal_parts());
    assert!(session.failed_parts.is_empty());
    assert!(session.refused_once.is_empty());
    assert_eq!(session.index.cursor().unwrap().mid, "grown");
    let (view, _) = session.build(&settings, None, false, None);
    assert_carries_queued_drops(&view.expect("retry uses the newer transcript"));
}

#[tokio::test]
async fn lifecycle_boundary_final_turn_refusal_bounds_the_immediate_retry() {
    let (mut session, client, settings) = refusal_fixture();
    for seq in 1..=2 {
        let (view, _) = session.build(&settings, None, false, None);
        let view = view.expect("the first boundary refusal allows a retry");
        assert_carries_queued_drops(&view);
        session.publish(&client, view).await;
        if seq == 2 {
            // An accepted retry can outlive ck-mc. Its rollback snapshot must
            // retain the bound without requiring a new store column.
            let durable =
                serde_json::from_slice(&serde_json::to_vec(&session.durable()).unwrap()).unwrap();
            session = fixture().0;
            session.restore(durable);
        }
        refuse_at_boundary(&mut session, &client, &settings, seq, final_turn_refusal()).await;
        assert_eq!(session.queued, queued_refusal_parts());
        if seq == 1 {
            assert!(session.failed_parts.is_empty());
            assert!(session.refused_once.is_empty());
        }
    }
    assert_eq!(session.refused_once, queued_refusal_parts());
    assert_eq!(
        session.failed_parts,
        [("old".into(), "p".into()), ("old".into(), "p2".into())].into()
    );
    let (view, _) = session.build(&settings, None, false, None);
    session.publish(&client, view.unwrap()).await;
    refuse_at_boundary(&mut session, &client, &settings, 3, final_turn_refusal()).await;
    assert!(
        session.queued.is_empty(),
        "the usual second-strike guard applies"
    );
    assert!(session.build(&settings, None, false, None).0.is_none());
}

fn signed_refusal(mid: &str) -> ViewRefusal {
    ViewRefusal::Rule(RuleBreak::SignedPartInvalid {
        mid: mid.into(),
        part: "0".into(),
    })
}

#[tokio::test]
async fn lifecycle_boundary_signed_part_in_a_newer_entry_keeps_queued_drops_on_every_retry() {
    let (mut session, client, settings) = refusal_fixture();
    for seq in 1..=3u64 {
        let (view, _) = session.build(&settings, None, false, None);
        let view = view.expect("queued drops stay eligible");
        assert_carries_queued_drops(&view);
        session.publish(&client, view).await;
        // The reply in flight while ck-mc built the view lands after it,
        // with signed thinking the view's earlier edits invalidate.
        let mid = format!("reply-{seq}");
        client.entries.lock().unwrap().push(text(4 + seq, &mid));
        refuse_at_boundary(&mut session, &client, &settings, seq, signed_refusal(&mid)).await;
        assert_eq!(session.queued, queued_refusal_parts(), "refusal {seq}");
        assert!(session.failed_parts.is_empty(), "refusal {seq}");
        assert!(session.refused_once.is_empty(), "refusal {seq}");
    }
}

#[tokio::test]
async fn lifecycle_boundary_signed_part_the_view_knew_keeps_the_usual_guard() {
    let (mut session, client, settings) = refusal_fixture();
    let (view, _) = session.build(&settings, None, false, None);
    session.publish(&client, view.unwrap()).await;
    refuse_at_boundary(&mut session, &client, &settings, 1, signed_refusal("old")).await;
    assert_eq!(session.refused_once, queued_refusal_parts());
    assert!(!session.failed_parts.is_empty());
}

#[tokio::test]
async fn lifecycle_boundary_unknown_message_has_its_own_bounded_retry() {
    let (mut session, client, settings) = refusal_fixture();
    for (seq, refusal) in [
        (1, final_turn_refusal()),
        (
            2,
            ViewRefusal::UnknownMessage {
                mid: "reverted".into(),
            },
        ),
        (
            3,
            ViewRefusal::UnknownMessage {
                mid: "reverted".into(),
            },
        ),
    ] {
        let (view, _) = session.build(&settings, None, false, None);
        session.publish(&client, view.unwrap()).await;
        refuse_at_boundary(&mut session, &client, &settings, seq, refusal).await;
        assert_eq!(session.queued, queued_refusal_parts());
        if seq < 3 {
            assert!(session.failed_parts.is_empty());
            assert!(session.refused_once.is_empty());
        }
    }
    assert_eq!(session.refused_once, queued_refusal_parts());
    assert_eq!(session.failed_parts.len(), 2);
}

#[tokio::test]
async fn lifecycle_boundary_applied_or_other_refusals_reset_the_retry_bound() {
    for reset in ["applied", "notice", "direct"] {
        let (mut session, client, settings) = refusal_fixture();
        // Empty views isolate outcome tracking from drop penalties: only the
        // final view below carries the requested and automatic work.
        session.publish(&client, View::seal(1, vec![])).await;
        refuse_at_boundary(&mut session, &client, &settings, 1, final_turn_refusal()).await;
        let second = View::seal(2, vec![]);
        if reset == "direct" {
            *client.refuse.lock().unwrap() = true;
        }
        session.publish(&client, second.clone()).await;
        match reset {
            "applied" => session.settle_unconfirmed(
                Some(&AppliedView::new(second.version, second.checksum)),
                &[],
            ),
            "notice" => {
                refuse_at_boundary(&mut session, &client, &settings, 2, ViewRefusal::BadSince)
                    .await;
            }
            "direct" => *client.refuse.lock().unwrap() = false,
            _ => unreachable!(),
        }
        let (view, _) = session.build(&settings, None, false, None);
        let view = view.expect("requested drops were not in the empty views");
        assert_carries_queued_drops(&view);
        session.publish(&client, view).await;
        refuse_at_boundary(&mut session, &client, &settings, 3, final_turn_refusal()).await;
        assert_eq!(session.queued, queued_refusal_parts(), "after {reset}");
        assert!(session.failed_parts.is_empty(), "after {reset}");
        assert!(session.refused_once.is_empty(), "after {reset}");
    }
}

#[tokio::test]
async fn lifecycle_boundary_direct_refusals_keep_the_existing_guard() {
    for refusal in [ViewRefusal::BadSince, final_turn_refusal()] {
        let (mut session, client, settings) = refusal_fixture();
        *client.refuse.lock().unwrap() = true;
        *client.refusal.lock().unwrap() = Some(refusal);
        for _ in 0..2 {
            let (view, _) = session.build(&settings, None, false, None);
            session.publish(&client, view.unwrap()).await;
        }
        assert!(session.queued.is_empty());
        assert!(session.refused_once.is_empty());
        assert_eq!(
            session.failed_parts,
            [("old".into(), "p".into()), ("old".into(), "p2".into())].into()
        );
        assert!(session.build(&settings, None, false, None).0.is_none());
    }
}

/// A refused view puts the age-sweep bookmark back where it was, with
/// everything else it changed: an output first seen far behind on that pass
/// still survives one more rebuild.
#[tokio::test]
async fn lifecycle_a_refused_view_puts_the_age_sweep_bookmark_back() {
    let (mut session, client, _, _, settings) = fixture();
    let settings = Settings {
        protected_tokens: Some(0),
        ..settings
    };
    two_old_outputs(&mut session);
    *client.refuse.lock().unwrap() = true;
    let (view, _) = session.build(&settings, None, false, None);
    session.next_reclaim_bookmark = Some(5);
    session.notice_reclaim_bookmark = 1;
    session.next_notice_reclaim_bookmark = Some(4);
    session
        .publish(&client, view.expect("both old outputs selected"))
        .await;
    assert_eq!(session.reclaim_bookmark, 3);
    assert_eq!(session.notice_reclaim_bookmark, 1);
}

fn old_notice_entries() -> Vec<Entry> {
    let mut old = text(1, "old-notice");
    old.parts[0].body = PartBody::Text {
        text: "worker result ".repeat(1_000).into(),
    };
    old.notice = Some(
        serde_json::from_value(serde_json::json!({
            "sender":"prefrontal", "template":"worker_result"
        }))
        .unwrap(),
    );
    vec![old, text(2, "one"), text(3, "two"), text(4, "three")]
}

fn notice_and_tool_entries() -> Vec<Entry> {
    let mut old_tool = output_part("p", 2);
    if let PartBody::Tool(tool) = &mut old_tool.body {
        tool.output = Some("old file contents ".repeat(5_000).into());
    }
    let mut entries = vec![
        old_notice_entries().remove(0),
        Entry::new(2, "old-tool", Role::Assistant, 2, vec![old_tool]),
        text(3, "one"),
        text(4, "two"),
        text(5, "three"),
    ];
    entries.push(Entry::new(
        6,
        "newer-tools",
        Role::Assistant,
        6,
        (6..=8)
            .map(|tag| {
                let mut part = output_part(&format!("p{tag}"), tag);
                if let PartBody::Tool(tool) = &mut part.body {
                    tool.output_bytes = Some(4);
                }
                part
            })
            .collect(),
    ));
    entries
}

fn assert_notice_stays_and_tool_sweeps(session: &mut Session, settings: &Settings) {
    let original_bookmark = session.notice_reclaim_bookmark;
    let mut tool_swept = false;
    for _ in 0..6 {
        let (view, _) = session.build(settings, None, true, None);
        if let Some(view) = view {
            assert!(!view.edits.iter().any(|edit| matches!(&edit.op,
                EditOp::Drop { mid, .. } | EditOp::Replace { mid, .. } if mid == "old-notice")));
            tool_swept |= view.edits.iter().any(|edit| {
                matches!(&edit.op,
                EditOp::Drop { mid, .. } | EditOp::Replace { mid, .. } if mid == "old-tool")
            });
            session.accept(view);
        } else {
            session.commit_bookmark();
        }
        assert_eq!(session.notice_reclaim_bookmark, original_bookmark);
        assert!(session.next_notice_reclaim_bookmark.is_none());
    }
    assert!(tool_swept, "tool reclaim must not depend on notice_keep");
}

#[tokio::test]
async fn lifecycle_notice_age_sweep_without_notice_keep_preserves_notices_only() {
    for bookmark in [0, u64::MAX] {
        let (mut session, client, route, mut request, settings) = fixture();
        *client.entries.lock().unwrap() = notice_and_tool_entries();
        request.newest = client.entries.lock().unwrap().last().map(cursor);
        session
            .setup(&client, &settings, &route, &request, session.features)
            .await;
        assert!(!session.notice_keep);
        // A bookmark restored from a capable runner cannot authorize reclaim
        // after that runner stops declaring notice_keep.
        session.notice_reclaim_bookmark = bookmark;
        assert_notice_stays_and_tool_sweeps(&mut session, &settings);
    }
}

#[tokio::test]
async fn lifecycle_notice_age_sweep_discovery_failure_retries_on_setup() {
    let (mut session, client, route, mut request, settings) = fixture();
    *client.entries.lock().unwrap() = notice_and_tool_entries();
    request.newest = client.entries.lock().unwrap().last().map(cursor);
    session.notice_keep = true;
    client.descriptions.lock().unwrap().extend([
        Err(crate::client::ClientError::new("describe refused")),
        Ok(serde_json::json!({"capabilities": ["message_marks", "notice_keep"]})),
    ]);
    client.runner_setup(&route.session.runner);
    session
        .setup(&client, &settings, &route, &request, session.features)
        .await;
    assert!(
        !session.notice_keep,
        "failure must revoke an earlier declaration"
    );
    assert_notice_stays_and_tool_sweeps(&mut session, &settings);
    client.runner_setup(&route.session.runner);
    session
        .setup(&client, &settings, &route, &request, session.features)
        .await;
    assert!(session.notice_keep, "the next Setup must retry discovery");
    assert!(client.descriptions.lock().unwrap().is_empty());
    for _ in 0..2 {
        let (view, _) = session.build(&settings, None, true, None);
        if let Some(view) = view {
            session.accept(view);
        } else {
            session.commit_bookmark();
        }
    }
    assert!(session
        .latest
        .as_ref()
        .unwrap()
        .edits
        .iter()
        .any(|edit| matches!(&edit.op,
        EditOp::Replace { mid, field, value, .. }
        if mid == "old-notice" && field == "text" && value == "[dropped §1§]")));
}

#[tokio::test]
async fn lifecycle_notice_age_sweep_waits_two_rebuilds_and_defer_replays_bytes() {
    let (mut session, client, _, _, settings) = fixture();
    session.notice_keep = true;
    let entries = old_notice_entries();
    session.index.extend(entries.clone());
    *client.entries.lock().unwrap() = entries;
    let (first, _) = session.build(&settings, None, true, None);
    if let Some(view) = first {
        assert!(!view.edits.iter().any(|edit| matches!(&edit.op,
            EditOp::Replace { mid, field, .. } if mid == "old-notice" && field == "text")));
        session.accept(view);
    } else {
        session.commit_bookmark();
    }
    assert_eq!(session.notice_reclaim_bookmark, 1);
    let before = serde_json::to_vec(&session.latest).unwrap();
    let mut request = notice(&session, 1, session.index.cursor());
    request.conditions.last_prompt_tokens = Some(1_000);
    session.notice(&client, &settings, request).await;
    assert_eq!(serde_json::to_vec(&session.latest).unwrap(), before);
    assert!(client.offered.lock().unwrap().is_empty());
    assert_eq!(session.notice_reclaim_bookmark, 1);
    let (second, _) = session.build(&settings, None, true, None);
    let view = second.expect("an old notice is reclaimed on the second rebuild");
    assert!(view.edits.iter().any(|edit| matches!(&edit.op,
        EditOp::Replace { mid, field, value, .. }
            if mid == "old-notice" && field == "text" && value == "[dropped §1§]")));
    assert!(!view.edits.iter().any(|edit| matches!(&edit.op,
        EditOp::Drop { mid, .. } if mid == "old-notice")));
}

#[test]
fn lifecycle_notice_age_sweep_restores_old_payload_conservatively() {
    let (mut session, _, _, _, settings) = fixture();
    session.notice_keep = true;
    session.reclaim_bookmark = 100;
    let mut payload = serde_json::to_value(session.durable()).unwrap();
    payload
        .as_object_mut()
        .unwrap()
        .remove("notice_reclaim_bookmark");
    session.restore(serde_json::from_value(payload).unwrap());
    session.index.extend(old_notice_entries());
    session.index_ready = true;
    assert_eq!(session.notice_reclaim_bookmark, 0);
    let (view, _) = session.build(&settings, None, true, None);
    assert!(!view
        .iter()
        .flat_map(|view| &view.edits)
        .any(|edit| matches!(&edit.op,
        EditOp::Replace { mid, field, .. } if mid == "old-notice" && field == "text")));
    session.commit_bookmark();
    assert_eq!(session.notice_reclaim_bookmark, 1);
}

#[test]
fn lifecycle_notice_age_sweep_never_drops_the_persons_words_at_any_size() {
    for size in [1, 1_000, 100_000] {
        let (mut session, _, _, _, settings) = fixture();
        session.notice_keep = true;
        let mut entries = old_notice_entries();
        entries[0].notice = None;
        entries[0].parts[0].body = PartBody::Text {
            text: "word ".repeat(size).into(),
        };
        session.index.extend(entries);
        session.reclaim_bookmark = u64::MAX;
        session.notice_reclaim_bookmark = u64::MAX;
        let (view, _) = session.build(&settings, Some(99_000), true, None);
        assert!(!view
            .iter()
            .flat_map(|view| &view.edits)
            .any(|edit| matches!(&edit.op,
            EditOp::Drop { mid, .. } | EditOp::Replace { mid, .. } if mid == "old-notice")));
    }
}

#[test]
fn lifecycle_notice_age_sweep_counts_notice_wakes_without_aging_tools() {
    let (mut session, _, _, _, settings) = fixture();
    session.notice_keep = true;
    let origin = old_notice_entries().remove(0).notice;
    let notice_entry = |ordinal| {
        let mut entry = text(ordinal, &format!("notice-{ordinal}"));
        entry.notice = origin.clone();
        entry
    };
    let mut old = notice_entry(2);
    old.parts[0].body = PartBody::Text {
        text: "worker result ".repeat(1_000).into(),
    };
    let tiny_output = |id, tag| {
        let mut part = output_part(id, tag);
        if let PartBody::Tool(tool) = &mut part.body {
            tool.output_bytes = Some(4);
        }
        part
    };
    session.index.extend([
        Entry::new(
            1,
            "old-tool",
            Role::Assistant,
            1,
            vec![output_part("p1", 1)],
        ),
        old,
        notice_entry(3),
        notice_entry(4),
        Entry::new(
            5,
            "newer-tools",
            Role::Assistant,
            5,
            vec![
                tiny_output("p5", 5),
                tiny_output("p6", 6),
                tiny_output("p7", 7),
            ],
        ),
    ]);
    // Three newer calls keep the old notice outside the protected tail,
    // without enough output tokens to reach the quarter-window distance.
    assert!(session.build(&settings, None, true, None).0.is_none());
    session.commit_bookmark();
    assert_eq!(
        session.notice_reclaim_bookmark, 0,
        "two newer notices are not enough"
    );
    assert_eq!(session.reclaim_bookmark, 0);

    let mut third = notice_entry(6);
    third.parts[0].tag = Some(8);
    session.index.extend([third]);
    assert!(session
        .index
        .entries()
        .iter()
        .all(|entry| entry.role != Role::User || entry.notice.is_some()));
    assert!(session.build(&settings, None, true, None).0.is_none());
    session.commit_bookmark();
    assert_eq!(
        session.reclaim_bookmark, 0,
        "notice wakes must not age tool outputs"
    );
    assert_eq!(session.notice_reclaim_bookmark, 2);

    let (view, _) = session.build(&settings, None, true, None);
    assert!(
        session.failed_parts.is_empty(),
        "{:?}",
        session.failed_parts
    );
    let view = view.expect("three newer notice wakes qualify the old notice after two rebuilds");
    assert!(view.edits.iter().any(|edit| matches!(&edit.op,
        EditOp::Replace { mid, field, value, .. }
            if mid == "notice-2" && field == "text" && value == "[dropped §2§]")));
    assert!(!view.edits.iter().any(|edit| matches!(&edit.op,
        EditOp::Drop { mid, .. } | EditOp::Replace { mid, .. } if mid == "old-tool")));
    session.accept(view);
    assert_eq!(session.notice_reclaim_bookmark, 2);
    assert_eq!(session.reclaim_bookmark, 0);
}

#[test]
fn lifecycle_notice_age_sweep_keeps_marked_notice_beside_unkept_notice() {
    let (mut session, _, _, _, settings) = fixture();
    session.notice_keep = true;
    let mut kept = old_notice_entries().remove(0);
    kept.notice.as_mut().unwrap().keep = true;
    let mut unkept = text(2, "unkept-notice");
    unkept.notice = old_notice_entries().remove(0).notice;
    unkept.parts[0].body = kept.parts[0].body.clone();
    let mut entries = vec![kept, unkept];
    for ordinal in 3..=5 {
        let mut newer = text(ordinal, &format!("notice-{ordinal}"));
        newer.notice = entries[1].notice.clone();
        entries.push(newer);
    }
    session.index.extend(entries);
    assert!(session.build(&settings, None, true, None).0.is_none());
    session.commit_bookmark();
    let (view, _) = session.build(&settings, None, true, None);
    let view = view.expect("an unkept notice is swept after two permitted rebuilds");
    assert!(view.edits.iter().any(|edit| matches!(&edit.op,
        EditOp::Replace { mid, field, value, .. }
            if mid == "unkept-notice" && field == "text" && value == "[dropped §2§]")));
    assert!(
        !view.edits.iter().any(|edit| matches!(&edit.op,
        EditOp::Drop { mid, .. } | EditOp::Replace { mid, .. } if mid == "old-notice")),
        "the notice marked keep must stay whole beside the swept notice"
    );
}

fn output_part(id: &str, tag: u64) -> Part {
    let mut part: Part = serde_json::from_value(serde_json::json!({
        "id":id, "kind":"tool", "call_id":id, "name":"read", "input":{"path": id},
        "status":"completed", "output":"result", "output_bytes":40000, "digest":""
    }))
    .unwrap();
    part.tag = Some(tag);
    part
}

/// A fold for a changed head shape (a settings or window change) waits out a
/// heavy-thinking turn on a model that binds its thinking to the prefix, as
/// an execute pass does: re-rendering `m[0]` then would drop the thinking.
#[test]
fn lifecycle_a_shape_fold_waits_out_a_heavy_thinking_turn() {
    let (mut session, _, _, _, settings) = fixture();
    session.conditions.rules = ProviderRules::new(SignedParts::Bound, EditCost::Suffix);
    session.conditions.last_prompt_tokens = Some(30_000);
    let reasoning: Part = serde_json::from_value(serde_json::json!({
        "id":"r", "kind":"reasoning", "text_bytes":400, "digest":""
    }))
    .unwrap();
    let mut thinking = Entry::new(
        2,
        "think",
        Role::Assistant,
        2,
        vec![reasoning, output_part("t", 2)],
    );
    thinking.usage =
        Some(cortexkit_role_compaction::read::StepUsage::default().with_reasoning_tokens(2_000));
    session.index.extend(vec![text(1, "task"), thinking]);
    let mut shape = session.head_shape(&settings);
    shape.memory_enabled = !shape.memory_enabled;
    session.baseline = Some(Arc::new(Baseline {
        shape: Some(shape),
        ..Baseline::default()
    }));
    let pass = session.decide_notice(&settings);
    assert!(!pass.rebuild, "the shape fold rebuilt during the hold");
    assert!(!session.fold_due);
}

/// The force-band summary skip projects usage after the drops this pass can
/// land: a queued drop waiting in the protected tail frees nothing yet.
#[test]
fn lifecycle_drops_waiting_in_the_tail_free_nothing_in_the_projection() {
    let (mut session, _, _, _, settings) = fixture();
    session.index.extend(vec![
        text(1, "task"),
        Entry::new(2, "tool", Role::Assistant, 2, vec![output_part("p", 2)]),
    ]);
    session.queued.insert(("tool".into(), "p".into()));
    assert_eq!(session.usage_after_drops(&settings, 0.9), None);
}

/// A `ctx_keep` whose view the runner refuses waits again: the model was
/// told everything else goes, so the next pass must still carry it out.
#[tokio::test]
async fn lifecycle_a_refused_keep_view_waits_again() {
    let (mut session, client, _, _, settings) = fixture();
    two_old_outputs(&mut session);
    let kept: BTreeSet<lanes::PartKey> = BTreeSet::new();
    *client.refuse.lock().unwrap() = true;
    let (view, _) = session.build(&settings, None, false, Some(&kept));
    session
        .publish(&client, view.expect("the keep drops both outputs"))
        .await;
    assert_eq!(session.pending_keep, Some(kept));
}

/// Setup's closing log line reports what Setup read from the runner: the
/// transcript reads and the entries they returned, and whether it read the
/// runner's applied view back (`failed` when that call failed). Checked on
/// the counters the line is made from, not on the log: a log capture in a
/// test can miss a line when another test thread hit the same call site
/// first without a subscriber.
#[tokio::test]
async fn lifecycle_setup_counts_what_it_read() {
    let (mut session, client, route, mut request, settings) = fixture();
    *client.entries.lock().unwrap() = vec![text(1, "older"), text(2, "newest")];
    request.newest = client.entries.lock().unwrap().last().map(cursor);
    let before = session.runner_reads.counts();
    session
        .setup(&client, &settings, &route, &request, session.features)
        .await;
    let read = session.runner_reads.since(before);
    assert_eq!((read.reads, read.entries), (1, 2));
    assert_eq!(read.read_back(), "no");
    // A runner applying a view ck-mc doesn't know is read back.
    request.applied_view = Some(AppliedView::new(5, "unknown"));
    let before = session.runner_reads.counts();
    session
        .setup(&client, &settings, &route, &request, session.features)
        .await;
    assert_eq!(session.runner_reads.since(before).read_back(), "yes");
    // A read-back that fails is not reported as one that happened.
    *client.fail_applied_view.lock().unwrap() = true;
    request.applied_view = Some(AppliedView::new(6, "unknown"));
    let before = session.runner_reads.counts();
    session
        .setup(&client, &settings, &route, &request, session.features)
        .await;
    let read = session.runner_reads.since(before);
    assert_eq!((read.applied_view, read.applied_view_failed), (1, 1));
    assert_eq!(read.read_back(), "failed");
}

/// Thalamus's `length-refusal-v1` samples: once a provider refuses a request
/// for its length, the runner ends the run `error` with `provider_code:
/// context_overflow` and asks ck-mc for a new view (`compaction.ride`, cause
/// `over_limit`). It sends the provider's own count (01) or none (02). Both
/// rides decode through ck-mc's own types and get a smaller view back, and
/// the run status decodes as an ordinary run error.
#[test]
fn thalamus_length_refusal_v1_rides_get_a_view() {
    use cortexkit_role_compaction::ride::{RideCause, RideRequest};
    use sha2::{Digest, Sha256};
    let files: [(&str, &[u8]); 3] = [
        (
            "01-ride-after-refusal-with-count.json",
            include_bytes!("../testdata/length-refusal-v1/01-ride-after-refusal-with-count.json"),
        ),
        (
            "02-ride-after-refusal-without-count.json",
            include_bytes!(
                "../testdata/length-refusal-v1/02-ride-after-refusal-without-count.json"
            ),
        ),
        (
            "03-context-overflow-run-status.json",
            include_bytes!("../testdata/length-refusal-v1/03-context-overflow-run-status.json"),
        ),
    ];
    let sums = include_str!("../testdata/length-refusal-v1/SHA256SUMS");
    for (name, bytes) in files {
        let line = format!("{:x}  {name}", Sha256::digest(bytes));
        assert!(sums.lines().any(|sum| sum == line), "{name}");
    }
    for (name, bytes) in &files[..2] {
        let ride: RideRequest = serde_json::from_slice(bytes).unwrap();
        assert!(ride.has(RideCause::OverLimit), "{name}");
        let (mut session, _, _, _, settings) = fixture();
        two_old_outputs(&mut session);
        session.index_ready = true;
        let view = session.ride(&settings, &ride);
        assert!(view.is_some(), "{name}: a length refusal gets a view back");
    }
    let status: cortexkit_role_llm_runner::run::RunStatus =
        serde_json::from_slice(files[2].1).unwrap();
    let status = serde_json::to_value(&status).unwrap();
    assert_eq!(status["state"], "error");
    assert_eq!(status["error"]["provider_code"], "context_overflow");
}

/// A head session with two summaries, a store and the apps' projection, set
/// up under a statement epoch, whose runner applies the view a notice built
/// and handed over: a session with nothing in flight. Built the same way for
/// every `label`, so two of them are alike.
async fn settled(label: &str) -> (Session, Client, crate::app_read::AppRead, Settings) {
    let (mut session, client, route, mut setup, settings) = fixture();
    let dir = scratch(label);
    let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    db.with_connection(|conn| {
        conn.execute_batch(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, created_at, harness)
             VALUES ('s1', 1, 1, 2, 'a', 'b', 'first', 'first part', 'first part', 1, 'mock'),
                    ('s1', 2, 3, 4, 'c', 'd', 'second', 'second part', 'second part', 1, 'mock');",
        )
        .map_err(|e| e.to_string())
    })
    .unwrap();
    session.db = Some(Arc::new(db));
    let store = Arc::new(crate::store::Store::open(&dir.join("sessions.db")).unwrap());
    session.set_store(Some(Arc::clone(&store)));
    let app = crate::app_read::AppRead::new(Some(store.path.clone()), Some(dir.join("context.db")));
    session.load_summaries();
    *client.entries.lock().unwrap() = vec![
        text(1, "a"),
        text(2, "b"),
        text(3, "c"),
        text(4, "d"),
        text(5, "e"),
    ];
    setup.newest = client.entries.lock().unwrap().last().map(cursor);
    setup.statement_epoch = Some("epoch".into());
    setup.statement_seq = Some(1);
    let features = Features {
        summarizer: true,
        ..session.features
    };
    session
        .setup(&client, &settings, &route, &setup, features)
        .await;
    session.publish_app(&app, true);
    // A head that is due builds and hands over a view with the history and
    // the cut on the next notice.
    session.head_stale = true;
    let mut request = notice(&session, 1, setup.newest.clone());
    request.conditions.statement_seq = Some(2);
    session.notice(&client, &settings, request).await;
    session.publish_app(&app, false);
    let view = session.latest.clone().expect("the notice built a view");
    let mut answer = AppliedViewAnswer::new();
    answer.view = Some(view.clone());
    *client.applied.lock().unwrap() = Some(answer);
    let mut request = notice(&session, 2, setup.newest.clone());
    request.conditions.statement_seq = Some(3);
    request.applied_view = Some(view.applied());
    session.notice(&client, &settings, request).await;
    session.publish_app(&app, false);
    assert!(
        session.unconfirmed.is_empty(),
        "the runner confirmed the view"
    );
    (session, client, app, settings)
}

/// Field for field, what a notice depends on and what it leaves: the saved
/// state, the view, the transcript index, the summaries, the statement order
/// and the apps' projection and decisions. Wall-clock times (`*_ms`) are left
/// out: the two sessions are built a few milliseconds apart.
fn assert_same_session(kept: &mut Session, resumed: &mut Session, step: &str) {
    fn timeless(value: impl serde::Serialize) -> Value {
        fn strip(value: &mut Value) {
            match value {
                Value::Object(members) => {
                    members.retain(|name, _| !name.ends_with("_ms"));
                    members.values_mut().for_each(strip);
                }
                Value::Array(items) => items.iter_mut().for_each(strip),
                _ => {}
            }
        }
        let mut value = serde_json::to_value(value).unwrap();
        strip(&mut value);
        value
    }
    assert_eq!(
        timeless(kept.durable()),
        timeless(resumed.durable()),
        "{step}: saved state"
    );
    assert_eq!(kept.latest, resumed.latest, "{step}: view");
    assert_eq!(kept.version, resumed.version, "{step}: version");
    assert_eq!(kept.cut, resumed.cut, "{step}: cut");
    assert_eq!(kept.index.base(), resumed.index.base(), "{step}: index");
    assert_eq!(
        kept.index.entries(),
        resumed.index.entries(),
        "{step}: index"
    );
    assert_eq!(kept.index_ready, resumed.index_ready, "{step}: index");
    assert_eq!(
        kept.summaries.to_vec(),
        resumed.summaries.to_vec(),
        "{step}: summaries"
    );
    assert_eq!(kept.seq, resumed.seq, "{step}: notice number");
    assert_eq!(kept.statement_epoch, resumed.statement_epoch, "{step}");
    assert_eq!(kept.statement_seq, resumed.statement_seq, "{step}");
    assert_eq!(kept.statement_late, resumed.statement_late, "{step}");
    assert_eq!(kept.late_statements, resumed.late_statements, "{step}");
    assert_eq!(kept.conditions, resumed.conditions, "{step}: conditions");
    assert_eq!(kept.latest_unknown, resumed.latest_unknown, "{step}");
    assert_eq!(
        timeless(&kept.app_decisions),
        timeless(&resumed.app_decisions),
        "{step}"
    );
    // The projection renders its rows as the apps read them; only their
    // wall-clock times may differ.
    let timeless_rendered = |mut rendered: crate::app_read::Rendered| {
        rendered.meta = timeless(&rendered.meta);
        for message in rendered.messages.values_mut() {
            message.at_ms = 0;
            message.row = timeless(&message.row);
        }
        rendered.decisions = rendered.decisions.iter().map(timeless).collect();
        rendered
    };
    assert_eq!(
        timeless_rendered(kept.app_snapshot()),
        timeless_rendered(resumed.app_snapshot()),
        "{step}: apps' projection"
    );
}

#[tokio::test]
async fn lifecycle_a_session_freed_while_quiet_answers_its_next_notices_as_one_never_freed() {
    let (mut kept, kept_client, kept_app, settings) = settled("quiet-kept").await;
    let (freed, client, app, _) = settled("quiet-freed").await;
    let Ok(carry) = Box::new(freed).quiet_carry() else {
        panic!("a session with nothing in flight is quiet");
    };
    // What freeing drops: every held summary row but the newest. The
    // summaries' index, the transcript index and the view stay, so resuming
    // reads nothing from the runner.
    assert!(carry.0.summaries.held() <= 1);
    assert_eq!(carry.0.summaries.len(), kept.summaries.len());
    assert_eq!(carry.0.index.entries(), kept.index.entries());
    assert!(carry.0.index_ready && carry.0.latest.is_some());
    let reads = client.reads.lock().unwrap().len();
    let mut resumed = Session::resume_quiet(carry);
    assert_eq!(
        client.reads.lock().unwrap().len(),
        reads,
        "resuming reads nothing from the runner"
    );
    assert_same_session(&mut kept, &mut resumed, "resumed");

    // A quiet notice with a new message, then one whose last prompt (70,000
    // tokens) reaches the size at which the session may rebuild its view,
    // then one built before a statement already taken.
    let f = text(6, "f");
    for client in [&kept_client, &client] {
        client.entries.lock().unwrap().push(f.clone());
    }
    let applied = kept.latest.as_ref().map(View::applied);
    let steps = [
        ("new message", 3, Some(4), None),
        ("execute threshold", 4, Some(5), Some(70_000)),
        ("late statement", 5, Some(2), Some(10_000)),
    ];
    for (step, seq, stamp, tokens) in steps {
        let mut answers = Vec::new();
        for (session, client, app) in [
            (&mut kept, &kept_client, &kept_app),
            (&mut resumed, &client, &app),
        ] {
            let mut request = notice(session, seq, Some(cursor(&f)));
            request.entries = vec![f.clone()];
            request.applied_view = applied.clone();
            request.conditions.statement_seq = stamp;
            request.conditions.last_prompt_tokens = tokens;
            let summary = session.notice(client, &settings, request).await;
            session.publish_app(app, false);
            answers.push((summary.is_some(), client.offered.lock().unwrap().clone()));
        }
        assert_eq!(answers[0], answers[1], "{step}: decisions and views");
        assert_same_session(&mut kept, &mut resumed, step);
    }
}

/// What a failed read, a runner's refusal or another provider's view leaves
/// in memory doesn't keep a session from being freed. The resumed session
/// keeps it for its next job, as a session never freed does, and reads
/// nothing on resuming.
#[tokio::test]
async fn lifecycle_a_quiet_session_is_freed_whatever_a_failed_read_or_refusal_left() {
    /// What a test leaves in memory before the session is freed.
    type Leave = fn(&mut Session);
    let cases: [(&str, Leave); 3] = [
        ("index and runner's view unknown", |session| {
            session.index_ready = false;
            session.latest_unknown = true;
        }),
        ("refused by the runner", |session| session.suspended = true),
        ("another provider's view applied", |session| {
            session.latest = None;
        }),
    ];
    for (number, (case, leave)) in cases.into_iter().enumerate() {
        let (mut session, client, _app, _) = settled(&format!("quiet-left-{number}")).await;
        leave(&mut session);
        let left = (
            session.index_ready,
            session.latest_unknown,
            session.suspended,
            session.latest.clone(),
        );
        let Ok(carry) = Box::new(session).quiet_carry() else {
            panic!("{case}: a session with nothing in flight is kept");
        };
        let reads = client.reads.lock().unwrap().len();
        let resumed = Session::resume_quiet(carry);
        assert_eq!(
            (
                resumed.index_ready,
                resumed.latest_unknown,
                resumed.suspended,
                resumed.latest.clone(),
            ),
            left,
            "{case}: what the session left for its next job"
        );
        assert_eq!(
            client.reads.lock().unwrap().len(),
            reads,
            "{case}: transcript reads on resuming"
        );
    }
}

#[tokio::test]
async fn adopting_an_older_view_restores_only_stamps_it_does_not_cover() {
    for older_view in [false, true] {
        let (mut session, client, _, _, settings) = fixture();
        let entries: Vec<_> = (1..=6).map(|n| text(n, &format!("m{n}"))).collect();
        session.index.extend(entries.clone());
        *client.entries.lock().unwrap() = entries;
        let mut confirmed = Vec::new();
        for tag in ["1", "2"] {
            session
                .ctx_reduce(&client, &serde_json::json!({ "drop": tag }))
                .await
                .unwrap();
            let view = session.build(&settings, None, false, None).0.unwrap();
            assert!(session.publish(&client, view.clone()).await);
            session.settle_unconfirmed(Some(&view.applied()), &[]);
            confirmed.push(view);
        }
        session
            .ctx_reduce(&client, &serde_json::json!({ "drop": "3" }))
            .await
            .unwrap();
        let pending = session.build(&settings, None, false, None).0.unwrap();
        assert!(session.publish(&client, pending).await);
        assert!(session.queued.is_empty());
        let v1 = older_view.then(|| confirmed.remove(0));
        *client.applied.lock().unwrap() =
            Some(AppliedViewAnswer::new().with_applied_by(crate::MODULE_ID));
        client.applied.lock().unwrap().as_mut().unwrap().view = v1.clone();
        session.adopt_runner_view(&client).await;
        assert_eq!(session.latest, v1);
        assert!(session.unconfirmed.is_empty());
        assert_eq!(
            session.queued,
            BTreeSet::from([("m3".to_owned(), "p".to_owned())])
        );
    }
}

fn keep_call(n: u64, name: &str) -> Entry {
    let tool = cortexkit_role_compaction::part::ToolPart::new(
        format!("call-{n}"),
        name,
        serde_json::json!({"tags": "", "note": "continue"}),
        cortexkit_role_compaction::part::ToolStatus::Completed,
    );
    Entry::new(
        n,
        format!("keep-{n}"),
        Role::Assistant,
        n,
        vec![crate::neutral::part(
            "k",
            Some(n),
            cortexkit_role_compaction::part::Seal::None,
            PartBody::Tool(tool),
        )],
    )
}

fn assistant_text(n: u64, name: &str) -> Entry {
    let mut entry = text(n, name);
    entry.role = Role::Assistant;
    entry
}

#[tokio::test]
async fn pending_keep_waits_for_its_call_during_a_permitted_ride() {
    let (mut session, client, _, _, settings) = fixture();
    let mut entries = vec![
        text(1, "task"),
        assistant_text(2, "drop me"),
        assistant_text(3, "keep me"),
    ];
    session.index.extend(entries.clone());
    *client.entries.lock().unwrap() = entries.clone();
    session
        .tool(
            &client,
            &settings,
            "ctx_keep",
            &serde_json::json!({"tags":"3","note":"continue"}),
        )
        .await
        .unwrap();
    let ride = RideRequest::new(
        vec![RideCause::EffortChange],
        1000,
        session.conditions.clone(),
    );
    assert!(session.ride(&settings, &ride).is_none());
    assert!(
        session.pending_keep.is_some(),
        "the call has not appeared in the index"
    );
    entries.push(keep_call(4, "mcp_ctx_keep"));
    *client.entries.lock().unwrap() = entries.clone();
    let mut request = notice(&session, 1, entries.last().map(cursor));
    request.entries = entries;
    session.notice(&client, &settings, request).await;
    let offered = client.offered.lock().unwrap();
    assert_eq!(offered.len(), 1);
    assert!(view_edits_message(&offered[0], "drop me"));
    assert!(!view_edits_message(&offered[0], "keep me"));
}

#[tokio::test]
async fn pending_keep_uses_an_indexed_call_even_if_its_arguments_differ() {
    let (mut session, client, _, _, settings) = fixture();
    session.index.extend([
        text(1, "task"),
        assistant_text(2, "drop me"),
        assistant_text(3, "keep me"),
        keep_call(4, "ctx_keep"),
    ]);
    session
        .tool(
            &client,
            &settings,
            "ctx_keep",
            &serde_json::json!({"tags":"3","note":"continue"}),
        )
        .await
        .unwrap();
    let ride = RideRequest::new(
        vec![RideCause::EffortChange],
        1000,
        session.conditions.clone(),
    );
    let view = session
        .ride(&settings, &ride)
        .expect("the indexed call can anchor the keep");
    assert!(view_edits_message(&view, "drop me"));
    assert!(!view_edits_message(&view, "keep me"));
    assert!(session.pending_keep.is_none());
}

#[tokio::test]
async fn pending_keep_uses_its_boundary_after_notice_growth_without_a_new_call() {
    let (mut session, client, _, _, settings) = fixture();
    let mut entries = vec![
        text(1, "task"),
        assistant_text(2, "drop me"),
        assistant_text(3, "keep me"),
        keep_call(4, "ctx_keep"),
        text(5, "already indexed"),
    ];
    session.index.extend(entries.clone());
    *client.entries.lock().unwrap() = entries.clone();
    session.handled_keep_call = Some(4);
    session
        .tool(
            &client,
            &settings,
            "ctx_keep",
            &serde_json::json!({"tags":"3","note":"continue"}),
        )
        .await
        .unwrap();
    let ride = RideRequest::new(
        vec![RideCause::EffortChange],
        1000,
        session.conditions.clone(),
    );
    assert!(session.ride(&settings, &ride).is_none());
    let unchanged = notice(&session, 1, entries.last().map(cursor));
    session.notice(&client, &settings, unchanged).await;
    assert!(
        client.offered.lock().unwrap().is_empty(),
        "an unchanged notice has not passed the wait boundary"
    );
    let new = assistant_text(6, "new step");
    entries.push(new.clone());
    *client.entries.lock().unwrap() = entries.clone();
    let mut grown = notice(&session, 2, Some(cursor(&new)));
    grown.entries = vec![new];
    session.notice(&client, &settings, grown).await;
    let offered = client.offered.lock().unwrap();
    let view = offered
        .last()
        .expect("a grown notice must not leave the keep waiting");
    assert!(view_edits_message(view, "drop me"));
    assert!(!view_edits_message(view, "keep me"));
    assert!(!view_edits_message(view, "new step"));
    assert!(session.pending_keep.is_none());
}

#[test]
fn pending_keep_waits_when_a_ride_has_to_reload_the_transcript() {
    let (mut session, _, _, _, settings) = fixture();
    session.cut = Some(2);
    session.index = Index::starting_at(3);
    session
        .index
        .extend([assistant_text(3, "older"), keep_call(4, "ctx_keep")]);
    session.index_ready = true;
    session.pending_keep = Some(BTreeSet::new());
    session.summaries_missing = Some(vec![1]);
    let ride = RideRequest::new(
        vec![RideCause::ModelChange],
        1000,
        session.conditions.clone(),
    );
    assert!(session.ride(&settings, &ride).is_none());
    assert!(!session.index_ready);
    assert_eq!(session.pending_keep, Some(BTreeSet::new()));
}

fn view_edits_message(view: &View, name: &str) -> bool {
    view.edits.iter().any(|edit| {
        matches!(&edit.op,
        EditOp::Drop { mid, .. } | EditOp::Replace { mid, .. } if mid == name)
    })
}

#[tokio::test]
async fn refused_keep_does_not_overwrite_a_newer_acknowledged_keep() {
    let (mut session, client, _, _, settings) = fixture();
    let mut entries = vec![
        text(1, "task"),
        assistant_text(2, "old choice"),
        assistant_text(3, "new choice"),
    ];
    session.index.extend(entries.clone());
    session
        .tool(
            &client,
            &settings,
            "ctx_keep",
            &serde_json::json!({"tags":"2","note":"first"}),
        )
        .await
        .unwrap();
    entries.push(keep_call(4, "ctx_keep"));
    session.index.extend(entries.clone());
    let old = session
        .ride(
            &settings,
            &RideRequest::new(
                vec![RideCause::EffortChange],
                1000,
                session.conditions.clone(),
            ),
        )
        .unwrap();
    session
        .tool(
            &client,
            &settings,
            "ctx_keep",
            &serde_json::json!({"tags":"3","note":"second"}),
        )
        .await
        .unwrap();
    entries.push(keep_call(5, "ctx_keep"));
    *client.entries.lock().unwrap() = entries.clone();
    let refusal = ViewRefusal::StaleVersion {
        version: old.version,
        latest: 0,
    };
    let mut request = notice(&session, 1, entries.last().map(cursor));
    request.entries = entries;
    request.events = vec![Event::ViewRefused {
        version: old.version,
        refusal,
    }];
    session.notice(&client, &settings, request).await;
    let offered = client.offered.lock().unwrap();
    let view = offered.last().expect("the second keep was offered");
    assert!(view_edits_message(view, "old choice"));
    assert!(!view_edits_message(view, "new choice"));
}

#[tokio::test]
async fn restamping_a_failed_automatic_part_still_lands() {
    let (mut session, client, _, _, settings) = fixture();
    session
        .index
        .extend([text(1, "task"), text(2, "requested"), text(3, "latest")]);
    session
        .failed_parts
        .insert(("requested".into(), "p".into()));
    let reply = session
        .ctx_reduce(&client, &serde_json::json!({"drop":"2"}))
        .await
        .unwrap();
    assert!(reply.contains("1 tag stamped"));
    let view = session
        .build(&settings, None, false, None)
        .0
        .expect("the explicit retry lands");
    assert!(view_edits_message(&view, "requested"));
}

#[tokio::test]
async fn stamped_images_and_other_files_leave_the_view() {
    for mime in ["image/png", "text/plain"] {
        let (mut session, client, _, _, settings) = fixture();
        let mut attachment = text(2, "attachment");
        attachment.parts[0].body = PartBody::File(
            cortexkit_role_compaction::part::FileMedia::inline(mime, Some(40_000)),
        );
        let entries = vec![text(1, "task"), attachment, text(3, "latest")];
        *client.entries.lock().unwrap() = entries.clone();
        session.index.extend(entries);
        assert!(
            session.build(&settings, None, false, None).0.is_none(),
            "no automatic drop"
        );
        let reply = session
            .ctx_reduce(&client, &serde_json::json!({"drop":"2"}))
            .await
            .unwrap();
        assert!(reply.contains("1 tag stamped"));
        let view = session
            .build(&settings, None, false, None)
            .0
            .expect("file stamp lands");
        assert!(view_edits_message(&view, "attachment"));
        assert!(view.edits.iter().any(|edit| matches!(&edit.op,
            EditOp::Replace { mid, field, value, .. }
                if mid == "attachment" && field == "text" && value == "[dropped §2§]")));
        session.accept(view);
        let recovered = session
            .tool(
                &client,
                &settings,
                "ctx_expand",
                &serde_json::json!({"message":2}),
            )
            .await
            .unwrap();
        assert!(
            recovered.contains(mime),
            "the original attachment metadata is still available"
        );
    }
}

#[tokio::test]
async fn keep_leaves_user_notices_when_the_runner_cannot_mark_them() {
    let (mut session, client, _, _, settings) = fixture();
    let notice = text(2, "person's words")
        .with_notice(cortexkit_role_compaction::read::NoticeOrigin::new("host"));
    let reminder = text(3, "reminder").with_notice(
        cortexkit_role_compaction::read::NoticeOrigin::new(crate::MODULE_ID),
    );
    session.index.extend([
        text(1, "task"),
        notice,
        reminder,
        assistant_text(4, "discard"),
    ]);
    session
        .tool(
            &client,
            &settings,
            "ctx_keep",
            &serde_json::json!({"tags":"1","note":"continue"}),
        )
        .await
        .unwrap();
    session.index.extend([keep_call(5, "ctx_keep")]);
    let ride = RideRequest::new(
        vec![RideCause::EffortChange],
        1000,
        session.conditions.clone(),
    );
    let view = session
        .ride(&settings, &ride)
        .expect("the keep has work to do");
    assert!(view_edits_message(&view, "discard"));
    assert!(view_edits_message(&view, "reminder"));
    assert!(!view_edits_message(&view, "person's words"));
}

#[tokio::test]
async fn over_limit_keep_selects_an_unkept_fallback_instead_of_stopping_at_the_kept_result() {
    use cortexkit_role_compaction::part::{ToolPart, ToolStatus};
    let (mut session, client, _, _, settings) = fixture();
    let result = |n, mid, bytes| {
        let tool = ToolPart::new(
            format!("call-{n}"),
            "build",
            serde_json::json!({}),
            ToolStatus::Completed,
        )
        .with_output_bytes(bytes);
        Entry::new(
            n,
            mid,
            Role::Assistant,
            n,
            vec![Part::new("p", PartBody::Tool(tool)).with_tag(n)],
        )
    };
    session
        .index
        .extend([text(1, "task"), result(2, "kept", 60_000)]);
    session
        .tool(
            &client,
            &settings,
            "ctx_keep",
            &serde_json::json!({"tags":"2","note":"continue"}),
        )
        .await
        .unwrap();
    session.index.extend([
        keep_call(3, "ctx_keep"),
        result(4, "fallback", 20_000),
        text(5, "latest"),
    ]);
    let ride = RideRequest::new(vec![RideCause::OverLimit], 1000, session.conditions.clone())
        .with_request_tokens(100_000);
    let view = session
        .ride(&settings, &ride)
        .expect("the fallback result can be removed");
    assert!(view_edits_message(&view, "fallback"));
    assert!(!view_edits_message(&view, "kept"));
}

#[tokio::test]
async fn prefixed_reduce_calls_are_recognized_as_self_stamps() {
    let (mut session, client, _, _, _) = fixture();
    session.index.extend([
        text(1, "task"),
        keep_call(2, "MCP_ctx_reduce"),
        text(3, "latest"),
    ]);
    let result = session
        .ctx_reduce(&client, &serde_json::json!({"drop":"2"}))
        .await
        .unwrap();
    assert!(
        session.queued.is_empty(),
        "self-stamp does not queue a drop: {result}"
    );
}

#[test]
fn prefixed_keep_call_anchors_the_same_edits_as_a_plain_call() {
    use cortexkit_role_compaction::read::Role;
    for name in ["ctx_keep", "MCP_ctx_keep"] {
        let mut index = Index::default();
        let mut discarded = text(2, "discarded");
        discarded.role = Role::Assistant;
        index.extend([text(1, "task"), discarded, keep_call(3, name)]);
        let ctx = lanes::Context {
            index: &index,
            edited: &lanes::Edited::default(),
            protected_tools: &std::collections::BTreeMap::new(),
            keep_first_message: true,
            signed_floor: None,
        };
        assert_eq!(
            lanes::keep_drops(&ctx, &BTreeSet::new(), None),
            vec![(("discarded".into(), "p".into()), lanes::Shape::Whole)],
            "{name}"
        );
    }
}
