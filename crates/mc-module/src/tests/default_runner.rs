//! The default runner for a full-array transform when no runner is configured by the user.
//!
//! The harness that bound the route decides: OpenCode 1 and OpenCode 2 hosts run
//! the completion themselves through the claim lane, while Claude Code (which
//! reaches this module through the Thalamus gateway with no host that could run
//! a completion) and anything unrecognised keep Broca. An explicit user-tier
//! runner wins on every harness. Each test drives a real transform pass through
//! the dispatcher and the real store, then reads which side actually ran the
//! completion and what the status surface says about it.

use super::*;

/// Poll `historian.pending` through the wire until the pass's run shows up.
async fn queued_run(handler: &McHandler) -> Value {
    let deadline = std::time::Instant::now() + TEST_WAIT_BUDGET;
    loop {
        let listed =
            call_dispatch_request(handler, json!({ "method": "historian.pending", "v": 1 })).await;
        if let Some(run) = listed["runs"].as_array().and_then(|runs| runs.first()) {
            return run.clone();
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the pass must queue its run for a claimant"
        );
        tokio::time::sleep(TEST_WAIT_POLL).await;
    }
}

/// Claim the queued run and answer it the way a host's pull loop would.
async fn answer_as_the_host(handler: &McHandler) {
    let queued = queued_run(handler).await;
    let run_id = queued["run_id"].as_str().unwrap().to_string();
    let claimed = call_dispatch_request(
        handler,
        json!({
            "method": "historian.claim", "v": 1,
            "run_id": run_id, "claimant_instance_id": "install-default-runner",
        }),
    )
    .await;
    assert_eq!(claimed["ok"], json!(true), "{claimed}");
    let output = historian_output_for_prompt(claimed["prompt"]["user"].as_str().unwrap());
    let completed = call_dispatch_request(
        handler,
        json!({
            "method": "historian.complete", "v": 1,
            "run_id": run_id, "token": claimed["token"],
            "output": { "text": output, "length_capped": false },
        }),
    )
    .await;
    assert_eq!(completed["ok"], json!(true), "{completed}");
}

async fn session_status(handler: &McHandler) -> Value {
    call_dispatch_request(
        handler,
        json!({ "method": "session.status", "v": 1, "session_id": "ses" }),
    )
    .await
}

async fn wait_for_historian_failure(store: &McStore) {
    let deadline = std::time::Instant::now() + TEST_WAIT_BUDGET;
    while std::time::Instant::now() < deadline {
        if store
            .load("ses")
            .unwrap()
            .meta
            .historian
            .last_failure
            .is_some()
        {
            return;
        }
        tokio::time::sleep(TEST_WAIT_POLL).await;
    }
    panic!("the historian recorded no failure");
}

fn runner_status(runner: &str, source: &str, harness: &str, observed: &str) -> Value {
    json!({ "runner": runner, "source": source, "harness": harness, "observed": observed })
}

/// A gateway principal does not turn a full-array transform into the asynchronous
/// provider lane. With no host claimant, Claude Code must still reach Broca and
/// publish its summary; only provider-lane children follow the session's runner.
#[tokio::test(flavor = "current_thread")]
async fn a_thalamus_gateway_full_array_session_folds_through_broca() {
    for configured in [None, Some(HistorianRunnerKind::Broca)] {
        let mut config = default_test_config();
        config.historian_runner = configured;
        let producer = Arc::new(ProducerState::default());
        let (handler, store, _dir, project) =
            handler_with_store(Arc::clone(&producer), config.clone());
        let mut binding = binding_with_harness(project.to_str().unwrap(), "claude-code", "ses");
        binding.principal = Some(subc_protocol::Principal::Reserved {
            module_id: "thalamus".into(),
        });
        binding.config = config;
        handler.bind_route(7, binding);

        let wire = request(big_messages());
        assert_eq!(wire["serializer_profile"], "owned-llmrunner");
        assert_eq!(wire["historian_model_chain"], json!([TEST_HISTORIAN_MODEL]));
        assert!(wire["messages"].is_array());
        assert!(wire.get("tail_delta").is_none());
        let fired = call_dispatch_request(&handler, wire).await;
        assert_eq!(fired["historian"]["fired"], json!(true), "{fired}");
        wait_for_count(&producer.starts, 1).await;
        wait_for_idle(&store).await;

        assert_eq!(producer.connects.load(Ordering::SeqCst), 1);
        assert_eq!(producer.session_runner_connects.load(Ordering::SeqCst), 0);
        assert_eq!(store.load_compartments("ses").unwrap().len(), 1);
        assert_eq!(
            producer.models.lock().unwrap().as_slice(),
            &[TEST_HISTORIAN_MODEL.to_string()]
        );
        assert!(store
            .list_pending_historian_runs(project.to_str().unwrap(), Some("ses"), now_ms())
            .unwrap()
            .is_empty());
        let status = session_status(&handler).await;
        assert_eq!(
            status["historian"]["runner"],
            runner_status(
                "broca",
                if configured.is_some() {
                    "configured"
                } else {
                    "default_for_harness"
                },
                "claude-code",
                "last_completion",
            ),
            "{status}"
        );
    }
}

/// The dreamer's module-routed classify follows the same default: an OpenCode
/// route with nothing configured is asked to run the completion on the host, and
/// a configured `dreamer.runner` wins over both the historian setting and the
/// harness.
#[tokio::test(flavor = "current_thread")]
async fn classify_defaults_to_the_host_on_opencode_and_follows_a_configured_dreamer_runner() {
    for (historian, dreamer, harness, expect_host) in [
        (None, None, "opencode", true),
        (None, None, "opencode2", true),
        (None, None, "claude-code", false),
        (Some(HistorianRunnerKind::Host), None, "claude-code", true),
        (
            Some(HistorianRunnerKind::Host),
            Some(HistorianRunnerKind::Broca),
            "opencode",
            false,
        ),
    ] {
        let label = format!("historian={historian:?} dreamer={dreamer:?} harness={harness}");
        let producer = Arc::new(ProducerState::default());
        let mut config = default_test_config();
        config.historian_runner = historian;
        config.dreamer_runner = dreamer;
        let (handler, store, _dir, project) = handler_with_store(Arc::clone(&producer), config);
        let route_root = project.to_str().unwrap();
        // The binding's own config is what `management_binding` hands the dreamer
        // path, so it has to carry the same runner settings as the handler.
        let mut bound = binding_with_harness(route_root, harness, "ses");
        bound.config.historian_runner = historian;
        bound.config.dreamer_runner = dreamer;
        handler.bind_route(7, bound);
        activate_module_authority(&store, "context", "git:identity", route_root, "memories");
        let generation = 1u64;
        let outcome = handler
            .handle_dreamer_run_task(
                7,
                &json!({
                    "v": 1,
                    "session_id": "ses",
                    "task": CLASSIFY_TASK,
                    "command_id": "default-runner-classify",
                    "authority_generation": generation,
                    "model_chain": ["test/first"],
                    "payload": { "prompt_body": "classify", "items": [] },
                }),
            )
            .await;
        let asked_host = match &outcome {
            HandlerOutcome::Response(bytes) => {
                serde_json::from_slice::<Value>(bytes).unwrap()["code"]
                    == json!(HOST_COMPLETION_REQUIRED)
            }
            _ => false,
        };
        assert_eq!(asked_host, expect_host, "{label}: {outcome:?}");
        assert_eq!(
            producer.starts.load(Ordering::SeqCst) == 0,
            expect_host,
            "{label}: the module's own runner starts only when the host is not asked"
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn memory_off_classify_refuses_before_loading_memories_or_starting_a_provider() {
    let producer = Arc::new(ProducerState::default());
    let (handler, store, _dir, project) =
        handler_with_store(Arc::clone(&producer), default_test_config());
    let mut bound = binding_with_harness(project.to_str().unwrap(), "opencode2", "ses");
    bound.config.memory_enabled = false;
    handler.bind_route(7, bound);
    activate_module_authority(
        &store,
        "context",
        "git:identity",
        project.to_str().unwrap(),
        "memories",
    );
    let outcome = handler
        .handle_dreamer_run_task(
            7,
            &json!({
                "v": 1,
                "session_id": "ses",
                "task": CLASSIFY_TASK,
                "command_id": "memory-off-classify",
                "model_chain": ["test/first"],
                "payload": { "prompt_body": "classify", "items": [] },
            }),
        )
        .await;
    assert!(
        matches!(outcome, HandlerOutcome::Error { ref code, .. } if code == "memory_disabled"),
        "{outcome:?}"
    );
    assert_eq!(producer.starts.load(Ordering::SeqCst), 0);
}
