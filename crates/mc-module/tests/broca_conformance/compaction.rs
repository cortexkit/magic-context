use super::{harness::*, *};
use compact::{
    answer::StepAnswer,
    fence::{dispose, Disposition, FenceState},
};
use subc_client_rs::{ConsumerOptions, SubcConsumer};
use subc_protocol::{BindIdentity, RouteTarget};

pub async fn tagged_transcript(rig: &Rig, session: &str) -> Vec<Value> {
    let identity = rig.identity(session);
    let tagged = rig
        .method(
            &identity,
            "transform.hook",
            json!({
                "session":session,"harness":"broca","lineage_id":LINEAGE,"hook":"post_tool",
                "step_id":"tool-step","tool":"read","tool_call_id":"call-1",
                "blocks":[format!("RELEASABLE OUTPUT {}", "payload ".repeat(5000))],"is_error":false
            }),
        )
        .await;
    let blocks = vec![format!("RELEASABLE OUTPUT {}", "payload ".repeat(5000))];
    let answer: transform::answer::HookAnswer = serde_json::from_value(tagged).unwrap();
    let transform::answer::HookAnswer::Ops { ops } = answer else {
        panic!("expected tool tag");
    };
    let rendered = transform::answer::apply_ops(&blocks, &ops).unwrap();
    assert!(rendered[0].starts_with("§1§ "));
    // A newer, large tool result pays the configured protected-token floor,
    // leaving the older result eligible for ctx_reduce rather than held.
    let tail = format!("PROTECTED TAIL {}", "tail ".repeat(7000));
    let tagged_tail = rig.method(&identity,"transform.hook",json!({
        "session":session,"harness":"broca","lineage_id":LINEAGE,"hook":"post_tool",
        "step_id":"tail-step","tool":"read","tool_call_id":"call-2","blocks":[tail],"is_error":false
    })).await;
    let transform::answer::HookAnswer::Ops { ops } = serde_json::from_value(tagged_tail).unwrap()
    else {
        panic!("expected tail tag");
    };
    let tail = transform::answer::apply_ops(&[tail], &ops)
        .unwrap()
        .remove(0);
    assert!(tail.starts_with("§2§ "));
    assert!(
        mc_tokenizer::estimate_tokens(&tail) > 4000,
        "the newer result must pay the configured protection floor"
    );
    vec![
        user(0, "old history"),
        message(
            1,
            "assistant",
            json!([{"type":"tool_call","tool_call_id":"call-1","tool_name":"read","input":{"path":"a"}}]),
        ),
        message(
            2,
            "tool",
            json!([{"type":"tool_result","tool_call_id":"call-1","output":{"kind":"text","text":rendered[0]},"is_error":false}]),
        ),
        message(
            3,
            "assistant",
            json!([{"type":"tool_call","tool_call_id":"call-2","tool_name":"read","input":{"path":"b"}}]),
        ),
        message(
            4,
            "tool",
            json!([{"type":"tool_result","tool_call_id":"call-2","output":{"kind":"text","text":tail},"is_error":false}]),
        ),
        user(5, "next turn"),
    ]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fresh_setup_ready_with_initial_view() {
    let rig = Rig::start(None, false).await;
    let ready = rig
        .method(&rig.identity(SESSION), "compaction.setup", setup(SESSION))
        .await;
    let _: compact::setup::SetupAnswer = serde_json::from_value(ready.clone()).unwrap();
    assert_eq!(ready["answer"], "ready");
    assert_eq!(ready["initial"]["range"], json!({"from":0,"to":0}));
    assert_eq!(ready["initial"]["replacement"].as_array().unwrap().len(), 2);
    assert_eq!(
        ready["stability"],
        json!([{"index":0,"rank":2},{"index":1,"rank":1}])
    );
    assert_eq!(ready["call_when"]["default"], 0.65);
    assert!(
        rig.script.callbacks().is_empty(),
        "fresh Setup must not wait for a nonexistent subject"
    );
    let again = rig
        .method(&rig.identity(SESSION), "compaction.setup", setup(SESSION))
        .await;
    assert_eq!(
        again["initial"]["replacement"],
        ready["initial"]["replacement"]
    );
    assert_eq!(
        again["initial"]["compaction_id"],
        ready["initial"]["compaction_id"]
    );
    assert!(
        again["initial"]["version"].as_u64().unwrap()
            > ready["initial"]["version"].as_u64().unwrap()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn below_threshold_noops_crossing_once_history_drops_and_stable_prompts() {
    let rig = Rig::start(None, false).await;
    let identity = rig.identity(SESSION);
    // Setup reads a message already summarized by a history compartment, so
    // the cached head has a real coverage boundary. Empty Setup's first
    // publication must create that boundary, a repair unrelated to threshold.
    rig.publish_history(SESSION);
    rig.script.transcript(vec![user(0, "old history")]);
    let mut setup_request = setup(SESSION);
    setup_request["newest"] = json!({"ordinal":0,"mid":"m0"});
    let ready = rig
        .method(&identity, "compaction.setup", setup_request)
        .await;
    rig.script.calls.lock().unwrap().clear();
    let mut view = ready["initial"].clone();
    let mut transcript = tagged_transcript(&rig, SESSION).await;
    transcript.insert(1, user(1, "recent history"));
    for (ordinal, message) in transcript.iter_mut().enumerate() {
        message["ordinal"] = json!(ordinal);
        message["mid"] = json!(format!("m{ordinal}"));
    }
    rig.script.transcript(transcript.clone());
    *rig.script.page_size.lock().unwrap() = 2;
    let queued = rig
        .call(
            &identity,
            json!({"name":"ctx_reduce","arguments":{"drop":"1"}}),
        )
        .await;
    assert_eq!(queued["isError"], false, "{queued}");
    let calls = rig.script.callbacks();
    assert_eq!(
        calls
            .iter()
            .map(|c| c.request["params"]["from_ordinal"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [1, 3]
    );
    for callback in calls {
        assert_eq!(
            callback.identity, identity,
            "callback must reach default broca target using runner identity"
        );
        assert_eq!(callback.request["method"], "session.read");
    }
    let original = render(&view, &transcript);
    assert!(String::from_utf8(original.clone())
        .unwrap()
        .contains("RELEASABLE OUTPUT"));
    for id in ["below-1", "below-2"] {
        let answer = rig
            .method(
                &identity,
                "compaction.step",
                step(SESSION, id, &transcript, 1000, &view),
            )
            .await;
        assert_eq!(
            answer["answer"], "noop",
            "step {id} must not rewrite the view"
        );
        assert_eq!(answer["request_id"], id);
        assert_eq!(render(&view, &transcript), original);
    }
    let record = rig.record(SESSION);
    assert_eq!(
        record["messages"][LINEAGE].as_object().unwrap().len(),
        7,
        "repeated cursor pages are ingested once"
    );
    assert_eq!(record["pending_drops"], json!([1]));
    assert_eq!(record["hook"]["live"]["1"]["ordinal"], 3);
    rig.publish_more_history(SESSION);
    let mut crossing_request = step(SESSION, "crossing", &transcript, 70_000, &view);
    crossing_request["previous_usage"] =
        json!({"input":40_000,"cache_read":20_000,"cache_write":6_000});
    let crossing = rig
        .method(&identity, "compaction.step", crossing_request)
        .await;
    assert_eq!(crossing["answer"], "compaction_message", "{crossing}");
    view = crossing["compaction"].clone();
    assert_eq!(
        view["range"],
        json!({"from":0,"to":7}),
        "replacement must be the full working range, not a delta"
    );
    let rendered = render(&view, &transcript);
    let text = String::from_utf8(rendered.clone()).unwrap();
    assert!(
        text.contains("JOINT HISTORY"),
        "missing history head: {text}"
    );
    assert!(
        text.contains("SECOND HISTORY"),
        "the pending publication was not folded"
    );

    assert!(text.contains("PROTECTED TAIL"), "working tail was lost");
    for id in ["after-1", "after-2"] {
        let answer = rig
            .method(
                &identity,
                "compaction.step",
                step(SESSION, id, &transcript, 1000, &view),
            )
            .await;
        assert_eq!(
            answer["answer"], "noop",
            "step {id} must not rewrite the view"
        );
        assert_eq!(answer["request_id"], id);
        assert_eq!(render(&view, &transcript), rendered);
    }
    assert!(
        !text.contains("RELEASABLE OUTPUT"),
        "queued drop still served; retained pending tags: {}",
        rig.record(SESSION)["pending_drops"]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pending_history_below_threshold_preserves_last_view() {
    let rig = Rig::start(None, false).await;
    let identity = rig.identity(SESSION);
    rig.publish_history(SESSION);
    rig.script.transcript(vec![user(0, "old history")]);
    let mut setup_request = setup(SESSION);
    setup_request["newest"] = json!({"ordinal":0,"mid":"m0"});
    let ready = rig
        .method(&identity, "compaction.setup", setup_request)
        .await;
    let transcript = vec![
        user(0, "old history"),
        user(1, "recent history"),
        user(2, "current tail"),
    ];
    let view = &ready["initial"];
    let before = rig
        .method(
            &identity,
            "compaction.step",
            step(SESSION, "before-publication", &transcript, 1000, view),
        )
        .await;
    assert_eq!(before["answer"], "noop");
    rig.publish_more_history(SESSION);
    let after = rig
        .method(
            &identity,
            "compaction.step",
            step(SESSION, "pending-publication", &transcript, 1000, view),
        )
        .await;
    assert_eq!(
        after["answer"], "noop",
        "a later historian publication at 1% fill must stay pending until execute"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runner_join_is_project_and_session_bound_not_broca_bound() {
    let rig = Rig::start(None, false).await;
    let identity = rig.identity(SESSION);
    rig.method(&identity, "compaction.setup", setup(SESSION))
        .await;
    let transcript = tagged_transcript(&rig, SESSION).await;
    rig.script.transcript(transcript);
    let joined = rig
        .call(
            &identity,
            json!({"name":"ctx_reduce","arguments":{"drop":"1"}}),
        )
        .await;
    assert_eq!(joined["isError"], false, "{joined}");
    for identity in [
        BindIdentity::new(rig.dir.path().join("another-project"), "runner", SESSION),
        rig.identity("another-session"),
    ] {
        let failure = rig
            .try_call(
                &identity,
                json!({"name":"ctx_reduce","arguments":{"drop":"1"}}),
            )
            .await
            .unwrap_err();
        assert_eq!(failure.code(), Some("session_unresolved"), "{failure:?}");
    }
    let wrong_harness = BindIdentity::new(identity.project_root.clone(), "broca", SESSION);
    let result = rig
        .try_call(
            &wrong_harness,
            json!({"name":"ctx_reduce","arguments":{"drop":"1"}}),
        )
        .await;
    assert!(
        result.is_err(),
        "a broca-bound tool route must not join the runner provider session: {result:?}"
    );
    let mut missing = setup("missing-harness");
    missing.as_object_mut().unwrap().remove("harness");
    let failure = rig
        .try_call(
            &rig.identity("missing-harness"),
            json!({"method":"compaction.setup","params":missing}),
        )
        .await
        .unwrap_err();
    assert_eq!(failure.code(), Some("invalid_params"));
}

#[cfg(feature = "drive-fault")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kill_mid_request_retry_skips_reserved_version_preserves_cursor_and_fences_stale() {
    let mut rig = Rig::start(None, false).await;
    let identity = rig.identity(SESSION);
    let ready = rig
        .method(&identity, "compaction.setup", setup(SESSION))
        .await;
    let catalog_request = json!({"name":"tool.catalog","arguments":{"preset":"head","composition":{"providers":[{"provider":"magic-context","tools":[{"name":"ctx_reduce"},{"name":"ctx_expand"},{"name":"ctx_note"},{"name":"ctx_memory"},{"name":"ctx_search"}]}],"compaction":{"provider":"magic-context"}}}});
    let catalog = rig.call(&identity, catalog_request.clone()).await;
    assert!(tool_names(&catalog).contains(&"ctx_reduce"));
    let transcript = tagged_transcript(&rig, SESSION).await;
    rig.script.transcript(transcript.clone());
    rig.call(
        &identity,
        json!({"name":"ctx_reduce","arguments":{"drop":"1"}}),
    )
    .await;
    rig.publish_history(SESSION);
    rig.module.take();
    rig.spawn(Some("AnswerRecorded"));
    rig.wait_ready().await;
    let mut request = step(
        SESSION,
        "crashed-request",
        &transcript,
        70_000,
        &ready["initial"],
    );
    request["prefix_rebuilding"] = json!({"reason":"flush"});
    let caller = SubcConsumer::connect(&rig.connection, ConsumerOptions::default())
        .await
        .unwrap();
    let pending_identity = identity.clone();
    let pending_request = request.clone();
    let mut pending = tokio::spawn(async move {
        caller
            .call(
                RouteTarget::ToolProvider {
                    module_id: "magic-context".into(),
                },
                pending_identity,
                serde_json::to_vec(&json!({"method":"compaction.step","params":pending_request}))
                    .unwrap(),
                options(),
            )
            .await
    });
    tokio::select! {
        _ = rig.wait_fault("AnswerRecorded") => {},
        response = &mut pending => panic!("step answered before its kill cut: {response:?}; {}",rig.stderr()),
    }
    let durable = rig.record(SESSION);
    let unsent = durable["last_answer"].clone();
    assert_eq!(unsent["answer"], "compaction_message");
    let reserved = unsent["compaction"]["version"].as_u64().unwrap();
    rig.module.take();
    assert!(
        pending.await.unwrap().is_err(),
        "killed request must have no delivered answer"
    );
    rig.spawn(None);
    rig.wait_ready().await;
    let retried = rig
        .method(&identity, "compaction.step", request.clone())
        .await;
    assert_eq!(
        rig.call(&identity, catalog_request).await,
        catalog,
        "the admitted catalog must survive restart"
    );
    assert_eq!(retried["request_id"], "crashed-request");
    assert_eq!(retried["answer"], "compaction_message", "{retried}");
    assert_eq!(
        retried["compaction"]["compaction_id"],
        unsent["compaction"]["compaction_id"]
    );
    assert!(
        retried["compaction"]["version"].as_u64().unwrap() > reserved,
        "allocated-but-unsent versions must never be reused"
    );
    assert_eq!(
        retried["compaction"]["replacement"], unsent["compaction"]["replacement"],
        "same logical request must reproduce the durable working view"
    );
    assert_eq!(retried["compaction"]["range"], json!({"from":0,"to":6}));
    let record = rig.record(SESSION);
    assert_eq!(record["messages"][LINEAGE].as_object().unwrap().len(), 6);
    let raw = record["messages"][LINEAGE].as_object().unwrap();
    assert_eq!(
        raw.keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>(),
        ["0", "1", "2", "3", "4", "5"]
            .into_iter()
            .map(str::to_owned)
            .collect()
    );
    let mut runner = ViewRunner::new(retried["compaction"].clone(), transcript.clone());
    runner.newest_request = "next-request".into();
    let before = runner.prompt();
    assert_eq!(
        runner.accept(serde_json::from_value(retried.clone()).unwrap()),
        "superseded_request"
    );
    assert_eq!(runner.prompt(), before);
    let mut stale = unsent;
    stale["request_id"] = json!("next-request");
    assert_eq!(
        runner.accept(serde_json::from_value(stale).unwrap()),
        "stale_version"
    );
    assert_eq!(runner.prompt(), before);
    request["request_id"] = json!("next-request");
    request["last_applied"] = json!({"compaction_id":retried["compaction"]["compaction_id"],"version":retried["compaction"]["version"]});
    request.as_object_mut().unwrap().remove("prefix_rebuilding");
    request["estimate"]["request_tokens"] = json!(1000);
    let after = rig.method(&identity, "compaction.step", request).await;
    assert_eq!(after["answer"], "noop");
    assert_eq!(runner.accept(serde_json::from_value(after).unwrap()), "act");
    assert_eq!(runner.prompt(), before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_step_keeps_last_view_and_is_not_setup_compaction_unavailable() {
    let rig = Rig::start(None, false).await;
    let identity = rig.identity(SESSION);
    let ready = rig
        .method(&identity, "compaction.setup", setup(SESSION))
        .await;
    let transcript = vec![user(0, "visible user")];
    let mut runner = ViewRunner::new(ready["initial"].clone(), transcript.clone());
    let baseline = runner.prompt();
    let mut request = step(SESSION, "failed-step", &transcript, 1000, &runner.view);
    request.as_object_mut().unwrap().remove("harness");
    let failure = rig
        .try_call(
            &identity,
            json!({"method":"compaction.step","params":request}),
        )
        .await
        .unwrap_err();
    assert_eq!(failure.code(), Some("invalid_params"));
    assert_ne!(failure.code(), Some("compaction_unavailable"));
    assert_eq!(runner.prompt(), baseline);
    runner.newest_request = "recovered-step".into();
    let answer = rig
        .method(
            &identity,
            "compaction.step",
            step(SESSION, "recovered-step", &transcript, 1000, &runner.view),
        )
        .await;
    assert_eq!(
        runner.accept(serde_json::from_value(answer).unwrap()),
        "act"
    );
    assert_eq!(runner.prompt(), baseline);
}

pub struct ViewRunner {
    pub view: Value,
    pub transcript: Vec<Value>,
    pub newest_request: String,
}

impl ViewRunner {
    pub fn new(view: Value, transcript: Vec<Value>) -> Self {
        Self {
            view,
            transcript,
            newest_request: String::new(),
        }
    }
    pub fn prompt(&self) -> Vec<u8> {
        render(&self.view, &self.transcript)
    }
    pub fn accept(&mut self, answer: StepAnswer) -> &'static str {
        let fence = FenceState {
            newest_request_id: self.newest_request.clone(),
            last_applied_version: self.view["version"].as_u64(),
            newest_ordinal: self.transcript.last().and_then(|m| m["ordinal"].as_u64()),
            newest_deadline_ms: None,
        };
        let disposition = dispose(&fence, &answer, 0);
        if disposition == Disposition::Act {
            if let StepAnswer::CompactionMessage { compaction, .. } = answer {
                self.view = serde_json::to_value(compaction).unwrap();
            }
        }
        disposition.name()
    }
}
