//! Exercise runner negotiation through the provider's real firing preparation.

use super::*;
use crate::runner_limits::RunnerLimits;

const ALL: RunnerLimits = RunnerLimits {
    max_steps: true,
    max_output_tokens: true,
    no_tools: true,
};

fn stop_after_send(producer: &ProducerState) {
    // These fixtures exercise admission without persisting a runner transcript.
    // Stop before publication, whose message-identity fence needs that transcript.
    producer.await_results.lock().unwrap().push_back(Err(
        HistorianProducerError::context_overflow("fixture stops after send"),
    ));
}

fn prepare(
    handler: &McHandler,
    store: Arc<McStore>,
    project: &Path,
    chain: &[&str],
) -> HistorianFiringTask {
    let mut config = default_test_config();
    config.rust_background_enabled = true;
    let mut binding = binding(project.to_str().unwrap(), "ses");
    binding.config = config;
    binding.principal = Some(subc_protocol::Principal::Reserved {
        module_id: "thalamus-harness".into(),
    });
    let mut raw = request(wrapup_messages(240, 800));
    raw["historian_model_chain"] = json!(chain);
    for model in chain {
        raw["historian_model_limits"][model] = json!({"context":200_000,"output":160_000});
    }
    let parsed: TransformRequest = serde_json::from_value(raw).unwrap();
    let projection = crate::ck_wire::project_messages(&parsed.messages).unwrap();
    let mut timings = HistorianTriggerTimings::default();
    match handler.prepare_historian_fire(
        store,
        &parsed,
        &binding,
        project.to_str().unwrap(),
        &projection,
        HistorianPrepareContext {
            rust_background_enabled: Some(true),
            now: now_ms(),
            publication_fence: None,
            tag_snapshot: None,
            async_coverage: None,
            reclaim_ride_available: false,
            runner_lane: true,
            timings: &mut timings,
        },
    ) {
        PreparedHistorianAction::FireReady(prepared) => prepared.task,
        PreparedHistorianAction::Complete(diagnostics) => {
            panic!("expected firing: {diagnostics:?}")
        }
        PreparedHistorianAction::Busy { .. } => panic!("unexpected busy"),
    }
}

#[tokio::test]
async fn missing_required_groups_are_durable_named_failures_without_a_send() {
    for limits in [
        RunnerLimits {
            no_tools: false,
            ..ALL
        },
        RunnerLimits {
            max_steps: false,
            ..ALL
        },
    ] {
        let producer = Arc::new(ProducerState::default());
        *producer.runner_limits.lock().unwrap() = Some(limits);
        let (handler, store, _dir, project) =
            handler_with_store(producer.clone(), default_test_config());
        let task = prepare(&handler, store.clone(), &project, &["provider/model"]);
        let result =
            McHandler::execute_historian_firing_task(handler.producer_factory.clone(), task).await;
        assert!(result.is_err());
        assert_eq!(producer.starts.load(Ordering::SeqCst), 0);
        let state = store.load_meta("ses").unwrap().meta.historian;
        let reason = state.last_failure.unwrap();
        assert!(
            reason.contains("historian_runner_missing_groups"),
            "{reason}"
        );
        assert!(reason.contains(if limits.no_tools {
            "max_steps"
        } else {
            "no_tools"
        }));
        assert!(state.failure_backoff_at_ms.is_some());
    }
}

#[tokio::test]
async fn uncapped_runner_reassembles_before_send_while_all_groups_keep_prompt_bytes() {
    for configured in [false, true] {
        let mut lengths = Vec::new();
        for max_output_tokens in [true, false] {
            let producer = Arc::new(ProducerState::default());
            stop_after_send(&producer);
            *producer.runner_limits.lock().unwrap() = Some(RunnerLimits {
                max_output_tokens,
                ..ALL
            });
            let mut config = default_test_config();
            if configured {
                config.historian_runner = Some(HistorianRunnerKind::Broca);
            }
            let (handler, store, _dir, project) = handler_with_store(producer.clone(), config);
            let task = prepare(&handler, store, &project, &["provider/model"]);
            assert_eq!(task.session_runner.is_none(), configured);
            let original = task.firing.prompt.clone();
            let error =
                McHandler::execute_historian_firing_task(handler.producer_factory.clone(), task)
                    .await
                    .unwrap_err();
            assert!(
                error.to_string().contains("fixture stops after send"),
                "{error}"
            );
            let prompts = producer.prompts.lock().unwrap();
            assert_eq!(prompts.len(), 1);
            if max_output_tokens {
                assert_eq!(prompts[0].as_bytes(), original.as_bytes());
            } else {
                assert_ne!(prompts[0].as_bytes(), original.as_bytes());
            }
            lengths.push(prompts[0].len());
        }
        assert!(lengths[1] < lengths[0], "{lengths:?}");
    }
}

#[tokio::test]
async fn zen_models_are_skipped_before_send_and_all_zen_failure_is_durable() {
    for chain in [
        vec!["opencode/paid", "provider/model"],
        vec!["opencode/free", "opencode/paid"],
    ] {
        let producer = Arc::new(ProducerState::default());
        stop_after_send(&producer);
        *producer.runner_limits.lock().unwrap() = Some(ALL);
        let (handler, store, _dir, project) =
            handler_with_store(producer.clone(), default_test_config());
        let task = prepare(&handler, store.clone(), &project, &chain);
        let result =
            McHandler::execute_historian_firing_task(handler.producer_factory.clone(), task).await;
        if chain.len() == 2 && chain[1] == "provider/model" {
            let error = result.unwrap_err();
            assert!(
                error.to_string().contains("fixture stops after send"),
                "{error}"
            );
            assert_eq!(*producer.models.lock().unwrap(), ["provider/model"]);
        } else {
            assert!(result.is_err());
            assert_eq!(producer.starts.load(Ordering::SeqCst), 0);
            let reason = store
                .load_meta("ses")
                .unwrap()
                .meta
                .historian
                .last_failure
                .unwrap();
            assert!(
                reason.contains("historian_zen_no_eligible_models"),
                "{reason}"
            );
        }
    }
}

#[tokio::test]
async fn configured_broca_wrapup_refits_its_captured_source_without_an_output_cap() {
    let producer = Arc::new(ProducerState::default());
    stop_after_send(&producer);
    *producer.runner_limits.lock().unwrap() = Some(RunnerLimits {
        max_output_tokens: false,
        ..ALL
    });
    let mut config = default_test_config();
    config.historian_runner = Some(HistorianRunnerKind::Broca);
    config.rust_background_enabled = true;
    let (handler, store, _dir, project) = handler_with_store(producer.clone(), config.clone());
    let mut binding = binding(project.to_str().unwrap(), "ses");
    binding.config = config;
    let mut raw = request(wrapup_messages(240, 800));
    raw["historian_model_chain"] = json!(["provider/model"]);
    raw["historian_model_limits"] = json!({"provider/model":{"context":200_000,"output":160_000}});
    let parsed: TransformRequest = serde_json::from_value(raw).unwrap();
    let projection = crate::ck_wire::project_messages(&parsed.messages).unwrap();
    let boundary = boundary::BoundaryResolution {
        protected_start_ordinal: 241,
        eligible_head: 1..241,
        n_tokens: 0.0,
        floored_by_live_prompt: false,
        fenced_by_open_arc: false,
        true_raw_eligible_tokens: 190_000.0,
        oversize_atomic_unit: false,
        raw_message_count: 240,
        boundary_reason: "test".into(),
    };
    let prepared = handler.prepare_wrapup_fire(
        store,
        &parsed,
        &binding,
        &projection,
        &boundary,
        WrapupPrepareContext {
            now: now_ms(),
            project_path: project.to_string_lossy().into_owned(),
            allow_unknown_module_retry: false,
            publication_fence: None,
        },
    );
    let PreparedWrapupAction::FireReady(task) = prepared else {
        panic!("expected wrapup firing");
    };
    assert!(task.session_runner.is_none());
    assert!(task.runner_refit.is_some());
    let original = task.firing.prompt.len();
    let error = McHandler::execute_historian_firing_task(handler.producer_factory.clone(), *task)
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("fixture stops after send"),
        "{error}"
    );
    let prompts = producer.prompts.lock().unwrap();
    assert_eq!(prompts.len(), 1);
    assert!(prompts[0].len() < original);
}
