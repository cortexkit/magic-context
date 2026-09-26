//! The runner a request gets when the user tier names none.
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

/// OpenCode 1 and OpenCode 2 with nothing configured: the pass queues the run
/// for the host, the host's report is published, and no Broca route is ever
/// opened. Before the harness default existed the same session connected to
/// Broca, which is what `producer.connects` would count.
#[tokio::test(flavor = "current_thread")]
async fn an_unconfigured_opencode_session_folds_on_the_host_without_broca() {
    for harness in ["opencode", "opencode2"] {
        let producer = Arc::new(ProducerState::default());
        let (handler, store, _dir, project) =
            handler_with_store(Arc::clone(&producer), default_test_config());
        handler.bind_route(
            7,
            binding_with_harness(project.to_str().unwrap(), harness, "ses"),
        );

        // Before the first completion the status names what the route resolves to.
        let before = session_status(&handler).await;
        assert_eq!(
            before["historian"]["runner"],
            runner_status("host", "default_for_harness", harness, "resolved_for_route"),
            "{harness}: {before}"
        );

        let fired = call_transform(&handler, big_messages()).await;
        assert_eq!(
            fired["historian"]["fired"],
            json!(true),
            "{harness}: {fired}"
        );
        answer_as_the_host(&handler).await;
        wait_for_idle(&store).await;

        assert_eq!(
            store.load_compartments("ses").unwrap().len(),
            1,
            "{harness}: the host's report is published"
        );
        assert_eq!(
            producer.connects.load(Ordering::SeqCst),
            0,
            "{harness}: no Broca route is opened"
        );
        let after = session_status(&handler).await;
        assert_eq!(
            after["historian"]["runner"],
            runner_status("host", "default_for_harness", harness, "last_completion"),
            "{harness}: {after}"
        );
        let health = handler.health().await;
        assert!(
            health
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains(&format!(
                    "historian runners: host (default for harness {harness}) x1"
                ))),
            "{harness}: {:?}",
            health.detail
        );
        assert_eq!(
            health.metrics.unwrap()["runner_choices"][0],
            json!({
                "session_id": "ses",
                "role": "historian",
                "runner": "host",
                "source": "default_for_harness",
                "harness": harness,
            })
        );
    }
}

/// Claude Code with nothing configured keeps Broca: the Thalamus gateway has no
/// host that could run the completion, so queueing it for one would stall every
/// fold. So does any harness this module does not recognise, which covers Pi and
/// OMP should they ever bind a Rust route.
#[tokio::test(flavor = "current_thread")]
async fn an_unconfigured_claude_code_session_still_folds_through_broca() {
    for harness in ["claude-code", "pi", "omp"] {
        let producer = Arc::new(ProducerState::default());
        let (handler, store, _dir, project) =
            handler_with_store(Arc::clone(&producer), default_test_config());
        handler.bind_route(
            7,
            binding_with_harness(project.to_str().unwrap(), harness, "ses"),
        );

        let fired = call_transform(&handler, big_messages()).await;
        assert_eq!(
            fired["historian"]["fired"],
            json!(true),
            "{harness}: {fired}"
        );
        // The completion goes to Broca: the firing connects and starts a run there.
        wait_for_count(&producer.starts, 1).await;
        wait_for_idle(&store).await;

        assert_eq!(
            store.load_compartments("ses").unwrap().len(),
            1,
            "{harness}"
        );
        let listed =
            call_dispatch_request(&handler, json!({ "method": "historian.pending", "v": 1 })).await;
        assert_eq!(
            listed["runs"],
            json!([]),
            "{harness}: nothing is queued for a host"
        );
        let status = session_status(&handler).await;
        assert_eq!(
            status["historian"]["runner"],
            runner_status("broca", "default_for_harness", harness, "last_completion"),
            "{harness}: {status}"
        );
    }
}

/// Negative control: an OpenCode user who configured `runner: broca` with no
/// Broca registered gets the refusal Broca's absence has always produced, not a
/// silent fall back to the host. The configured value wins over the harness.
#[tokio::test(flavor = "current_thread")]
async fn a_configured_broca_runner_without_broca_refuses_as_before() {
    let producer = Arc::new(ProducerState::default());
    producer
        .connect_errors
        .lock()
        .expect("connect errors mutex")
        .push_back(HistorianProducerError::Subc(
            historian_producer::ProducerErrorBody::untagged(
                "open_failed",
                "no provider registered for module broca",
            ),
        ));
    let mut config = default_test_config();
    config.historian_runner = Some(HistorianRunnerKind::Broca);
    let (handler, store, _dir, project) = handler_with_store(Arc::clone(&producer), config);
    handler.bind_route(
        7,
        binding_with_harness(project.to_str().unwrap(), "opencode", "ses"),
    );

    let fired = call_transform(&handler, big_messages()).await;
    assert_eq!(fired["historian"]["fired"], json!(true), "{fired}");
    wait_for_count(&producer.connects, 1).await;
    wait_for_historian_failure(&store).await;

    assert!(store.load_compartments("ses").unwrap().is_empty());
    let failure = store.load("ses").unwrap().meta.historian.last_failure;
    assert!(
        failure
            .as_deref()
            .is_some_and(|failure| failure.contains("open_failed")),
        "{failure:?}"
    );
    let listed =
        call_dispatch_request(&handler, json!({ "method": "historian.pending", "v": 1 })).await;
    assert_eq!(listed["runs"], json!([]), "nothing is queued for a host");
    let status = session_status(&handler).await;
    assert_eq!(
        status["historian"]["runner"],
        runner_status("broca", "configured", "opencode", "last_completion"),
        "{status}"
    );
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
        let generation = store
            .authority_status("context", "git:identity", "memories")
            .unwrap()
            .unwrap()
            .generation;
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

/// The emergency pass (usage at or above 95% of the window) under the per-harness
/// default, measured on the tool-bearing fixture the host-runner gate used.
///
/// Claude Code keeps Broca and joins the fold inline; OpenCode now gets the host
/// runner, which serves the emergency reduction and lets the fold land on the
/// next pass after the host reports. The numbers are printed for the release
/// decision; the assertions pin only the shape: the OpenCode emergency pass does
/// not carry the fold, it serves more bytes than the inline join, and the pass
/// after the report serves exactly what the inline join served.
#[tokio::test(flavor = "current_thread")]
async fn the_emergency_pass_under_each_harness_default() {
    let messages = super::gate_a2::tool_bearing_messages();

    let broca_producer = Arc::new(ProducerState::default());
    let (broca_handler, _broca_store, _broca_dir, broca_project) =
        handler_with_store(Arc::clone(&broca_producer), default_test_config());
    broca_handler.bind_route(
        7,
        binding_with_harness(broca_project.to_str().unwrap(), "claude-code", "ses"),
    );
    let broca = call_transform_with_usage(&broca_handler, messages.clone(), 48_000, 50_000).await;
    assert!(
        m0_text(&broca).contains("autonomous summary"),
        "Claude Code's default still joins the fold inline"
    );
    let (broca_dropped, broca_messages, broca_bytes) = served_census(&broca);

    let host_producer = Arc::new(ProducerState::default());
    let (host_handler, host_store, _host_dir, host_project) =
        handler_with_store(Arc::clone(&host_producer), default_test_config());
    host_handler.bind_route(
        7,
        binding_with_harness(host_project.to_str().unwrap(), "opencode", "ses"),
    );
    let host = call_transform_with_usage(&host_handler, messages.clone(), 48_000, 50_000).await;
    assert_eq!(host["historian"]["fired"], json!(true), "{host}");
    assert!(
        !m0_text(&host).contains("autonomous summary"),
        "OpenCode's default serves the emergency reduction instead of waiting"
    );
    let (host_dropped, host_messages, host_bytes) = served_census(&host);

    answer_as_the_host(&host_handler).await;
    wait_for_idle(&host_store).await;
    let second = call_transform_with_usage(&host_handler, messages, 48_000, 50_000).await;
    assert!(
        m0_text(&second).contains("autonomous summary"),
        "the fold lands on the pass after the host reported"
    );
    let (second_dropped, second_messages, second_bytes) = served_census(&second);

    eprintln!(
        "emergency pass under the harness default (tool-bearing fixture, 48000/50000): \
         claude-code/broca dropped_tags={broca_dropped} served_messages={broca_messages} served_bytes={broca_bytes} | \
         opencode/host dropped_tags={host_dropped} served_messages={host_messages} emergency_served_bytes={host_bytes} \
         second_rewrite_dropped_tags={second_dropped} second_rewrite_messages={second_messages} second_rewrite_bytes={second_bytes}"
    );
    assert_eq!(broca_producer.connects.load(Ordering::SeqCst), 1);
    assert_eq!(host_producer.connects.load(Ordering::SeqCst), 0);
    assert!(host_bytes > broca_bytes);
    assert_eq!(
        (second_dropped, second_messages, second_bytes),
        (broca_dropped, broca_messages, broca_bytes),
        "once the fold lands the OpenCode session serves what the inline join served"
    );
}
