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
