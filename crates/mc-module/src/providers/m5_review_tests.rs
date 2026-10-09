// Compare provider historian results with the full engine and inject interruptions
// before launch, during claims, and during publication.

fn review_sync(h: &McHandler, entries: &[compact::status::StatusMessage], inputs: Value) {
    // Synchronize without launching a worker so the test controls crash boundaries.
    h.sync_provider_pass_inputs_locked(
        &binding(h),
        h.store.get().unwrap(),
        Some(&["test/model".into()]),
        true,
        Some(&json!({"lineage_id":"L","pass_id":"review","appended":entries,"historian_inputs":inputs})),
    )
    .unwrap();
}

fn review_byte_diff(label: &str, actual: &[u8], expected: &[u8]) -> Option<String> {
    if actual == expected {
        return None;
    }
    let at = actual
        .iter()
        .zip(expected)
        .position(|(a, b)| a != b)
        .unwrap_or(actual.len().min(expected.len()));
    Some(format!(
        "{label}: byte diff at {at}; actual len={}, expected len={}; actual={:?}; expected={:?}",
        actual.len(),
        expected.len(),
        String::from_utf8_lossy(&actual[at.saturating_sub(40)..actual.len().min(at + 160)]),
        String::from_utf8_lossy(&expected[at.saturating_sub(40)..expected.len().min(at + 160)])
    ))
}

fn review_bytes(label: &str, actual: &[u8], expected: &[u8]) {
    if let Some(diff) = review_byte_diff(label, actual, expected) {
        panic!("{diff}");
    }
}

async fn review_publish(h: &McHandler, p: Box<PreparedHistorianFiring>) {
    let (from, to) = (p.task.firing.from_ordinal, p.task.firing.to_ordinal);
    let task = tokio::spawn(McHandler::execute_historian_firing_task(
        h.producer_factory.clone(),
        p.task,
    ));
    claim_and_report(h, pending(h).await, from, to).await;
    let result = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        h.store
            .get()
            .unwrap()
            .load_meta("s")
            .unwrap()
            .meta
            .historian
            .state,
        HistorianPhase::Idle,
        "{result:?}"
    );
}

fn review_compartment_bytes(h: &McHandler) -> Vec<u8> {
    let mut compartments = h.store.get().unwrap().load_compartments("s").unwrap();
    // Wall-clock publication time is not part of the compartment content contract.
    for compartment in &mut compartments {
        compartment.created_at = 0;
    }
    serde_json::to_vec(&compartments).unwrap()
}

#[tokio::test]
async fn review_m5_randomized_200_complete_inputs_and_publications() {
    let mut seed = 0x51e7_b1f5_41b3_f67bu64;
    let mut random = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let mut fires = 0;
    let mut restarts = 0;
    for case in 0..200 {
        let dir = tempfile::tempdir().unwrap();
        let reference_dir = tempfile::tempdir().unwrap();
        let mut h = handler(dir.path());
        declare(&h).await;
        let reference = handler(reference_dir.path());
        let length = 20 + (random() % 100) as usize;
        let entries: Vec<_> = (1..=length)
            .map(|n| {
                let words = if case % 2 == 0 {
                    500 + random() % 900
                } else {
                    10 + random() % 250
                };
                text(
                    n as u64,
                    if n % 2 == 1 { "user" } else { "assistant" },
                    words as usize,
                )
            })
            .collect();
        let context = [40000, 50000, 100000][(random() % 3) as usize];
        let usage = [20, 60, 80, 90, 99][(random() % 5) as usize] * context / 100;
        let inputs = json!({"usage":{"current_total_input_tokens":usage,"context_limit_tokens":context},
            "reclaim_ride_available": random() % 2 == 0,
            "historian_max_output_tokens": 4000 + random() % 4000});
        let split = length / 2;
        review_sync(&h, &entries[..split], inputs.clone());
        review_sync(&h, &entries[split..], inputs.clone());
        if case % 3 == 0 {
            drop(h);
            h = handler(dir.path());
            restarts += 1;
        }
        let actual = h
            .provider_historian_worker()
            .prepare_provider_historian(&binding(&h), &key(&h))
            .await
            .unwrap()
            .unwrap();
        let expected = oracle(&reference, &entries, &["test/model".into()], inputs);
        review_bytes(
            &format!("case {case} decision"),
            &serde_json::to_vec(&signature(&actual)).unwrap(),
            &serde_json::to_vec(&signature(&expected)).unwrap(),
        );
        if let (PreparedHistorianAction::FireReady(a), PreparedHistorianAction::FireReady(e)) =
            (actual, expected)
        {
            fires += 1;
            let protected = a
                .diagnostics
                .progress
                .as_ref()
                .unwrap()
                .protected_start_ordinal;
            assert!(a.task.firing.to_ordinal < protected, "case {case}");
            review_bytes(
                &format!("case {case} raw chunk"),
                a.task.firing.raw_chunk_messages.as_bytes(),
                e.task.firing.raw_chunk_messages.as_bytes(),
            );
            assert_eq!(
                a.task.firing.chunk_fingerprint, e.task.firing.chunk_fingerprint,
                "case {case}"
            );
            let store = reference.store.get().unwrap();
            let loaded = store.load("s").unwrap();
            let mut meta = loaded.meta.clone();
            for selected in &e.task.firing.selected_range_identities {
                meta.block_identity_by_mid
                    .insert(selected.mid.clone(), selected.block_identities.clone());
            }
            store
                .commit("s", loaded.row_version, &loaded.core, &meta)
                .unwrap();
            review_publish(&h, a).await;
            review_publish(&reference, e).await;
            review_bytes(
                &format!("case {case} compartments"),
                &review_compartment_bytes(&h),
                &review_compartment_bytes(&reference),
            );
            if case % 4 == 0 {
                let before = review_compartment_bytes(&h);
                drop(h);
                h = handler(dir.path());
                restarts += 1;
                review_bytes(
                    &format!("case {case} restart"),
                    &review_compartment_bytes(&h),
                    &before,
                );
            }
        }
    }
    assert!(
        fires >= 25,
        "must exercise publication, not only refusals: {fires}"
    );
    eprintln!("M5_REVIEW randomized sessions=200 fires={fires} restarts={restarts} decision/chunk/compartment byte mismatches=0");
}

#[tokio::test]
async fn review_m5_crash_before_launch_retries_completed_barrier() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path());
    declare(&h).await;
    let entries = corpus();
    review_sync(
        &h,
        &entries,
        json!({"usage":{"current_total_input_tokens":45000,"context_limit_tokens":50000}}),
    );
    let worker = h.provider_historian_worker();
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    *worker.provider_historian_gate.lock().unwrap() = Some((entered.clone(), release));
    let b = binding(&h);
    let k = key(&h);
    let task_worker = worker.clone();
    let task = tokio::spawn(async move { task_worker.prepare_provider_historian(&b, &k).await });
    entered.notified().await;
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    assert_eq!(
        h.store
            .get()
            .unwrap()
            .load_meta("s")
            .unwrap()
            .meta
            .historian
            .state,
        HistorianPhase::Idle
    );
    drop(worker);
    drop(h);
    let restarted = handler(dir.path());
    review_sync(
        &restarted,
        &[],
        json!({"usage":{"current_total_input_tokens":45000,"context_limit_tokens":50000}}),
    );
    let expected = oracle(
        &restarted,
        &entries,
        &["test/model".into()],
        json!({"usage":{"current_total_input_tokens":45000,"context_limit_tokens":50000}}),
    );
    assert!(
        matches!(expected, PreparedHistorianAction::FireReady(_)),
        "full engine must still fire for the completed input"
    );
    drop(expected);
    let action = restarted
        .provider_historian_worker()
        .prepare_provider_historian(&binding(&restarted), &key(&restarted))
        .await
        .unwrap();
    assert!(matches!(action, Some(PreparedHistorianAction::FireReady(_))),
        "a crash after consuming the barrier but before launch must not lose the pending evaluation; actual={:?}", action.map(|a| signature(&a)));
}

#[tokio::test]
async fn review_m5_two_concurrent_evaluations_launch_only_one() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path());
    declare(&h).await;
    review_sync(
        &h,
        &corpus(),
        json!({"usage":{"current_total_input_tokens":45000,"context_limit_tokens":50000}}),
    );
    let worker = h.provider_historian_worker();
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    *worker.provider_historian_gate.lock().unwrap() = Some((entered.clone(), release.clone()));
    let first = worker.clone();
    let b = binding(&h);
    let k = key(&h);
    let task = tokio::spawn(async move { first.prepare_provider_historian(&b, &k).await });
    entered.notified().await;
    let second = worker
        .prepare_provider_historian(&binding(&h), &key(&h))
        .await
        .unwrap();
    assert!(
        second.is_none(),
        "the concurrent pass must not reconsume the barrier"
    );
    release.notify_one();
    let first = task.await.unwrap().unwrap();
    assert!(matches!(first, Some(PreparedHistorianAction::FireReady(_))));
}

#[tokio::test]
async fn review_m5_20000_message_scan_cost() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path());
    declare(&h).await;
    let entries: Vec<_> = (1..=20000)
        .map(|n| text(n, if n == 1 { "user" } else { "assistant" }, 12))
        .collect();
    review_sync(&h, &entries, json!({}));
    let store = h.store.get().unwrap();
    let start = Instant::now();
    let held = store
        .load_provider_messages(&key(&h).store_key(), "L")
        .unwrap();
    let load_ms = start.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(held.len(), 20000);
    let start = Instant::now();
    assert_eq!(
        store.provider_frontier(&key(&h).store_key(), "L").unwrap(),
        20001
    );
    let frontier_ms = start.elapsed().as_secs_f64() * 1000.0;
    let worker = h.provider_historian_worker();
    let start = Instant::now();
    worker
        .prepare_provider_historian(&binding(&h), &key(&h))
        .await
        .unwrap();
    let evaluated_ms = start.elapsed().as_secs_f64() * 1000.0;
    review_sync(&h, &[], json!({}));
    // Synchronous log scanning on this runtime's only thread delays the timer,
    // even though the caller did not await the scheduled historian task.
    let timer_start = Instant::now();
    let timer = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1)).await;
        timer_start.elapsed().as_secs_f64() * 1000.0
    });
    tokio::task::yield_now().await;
    let start = Instant::now();
    h.schedule_provider_historian(binding(&h), key(&h));
    tokio::task::yield_now().await;
    let debounced_ms = start.elapsed().as_secs_f64() * 1000.0;
    let timer_ms = timer.await.unwrap();
    let c = store
        .load_provider_conversation(&key(&h).store_key())
        .unwrap()
        .unwrap();
    let counters: Value = serde_json::from_str(&c.hook_counters_json).unwrap();
    assert_eq!(
        counters["historian_evaluated_barrier"],
        counters["historian_barrier_generation"]
    );
    eprintln!("M5_REVIEW rows=20000 message_payload_rows=20000 frontier_ordinal_rows=20000 payload_bytes={} load_ms={load_ms:.3} frontier_ms={frontier_ms:.3} first_evaluation_ms={evaluated_ms:.3} scheduled_debounced_ms={debounced_ms:.3} same_runtime_1ms_timer_ms={timer_ms:.3}", held.iter().map(|m| m.message_bytes.len()).sum::<usize>());
}

fn review_full_native(
    h: &McHandler,
    entries: &[compact::status::StatusMessage],
    usage: u64,
    active: bool,
) -> (Value, bool) {
    let b = binding(h);
    let config = &b.config;
    let root = b.project_root.to_string_lossy();
    let mut req: TransformRequest = decode(&json!({"v":2,"kind":"transform","session_id":"s","serializer_profile":"opencode-aisdk","model_key":"fixture","messages":[],"render_config":format!("{}|broca-compaction:0",json!({"serializer_profile":"opencode-aisdk","observation":"answer"})),"tool_present":true,"auto_search_enabled":false,"todo_tool_present":false,"usage":{"current_total_input_tokens":usage,"context_limit_tokens":100000}})).unwrap();
    codec::Codec::OpencodeAiSdk
        .prepare_request(&mut req, entries)
        .unwrap();
    let context = transform::ProducerContext {
        project_path: &root,
        note_project_path: &root,
        project_directory: &root,
        history_budget_tokens: b.history_budget_tokens,
        memory_budget_tokens: config.memory_budget_tokens,
        user_profile_budget_tokens: config.user_profile_budget_tokens,
        memory_enabled: false,
        inject_docs: false,
        temporal_awareness: config.temporal_awareness,
        now_ms: 2,
        execute_threshold_percentage: config.resolve_execute_threshold(Some("fixture")).percentage,
        protected_tokens_floor: config.resolve_protected_tokens(100000).floor,
        protected_tokens_provenance: "derived",
        compaction_enabled: config.compaction_enabled,
        smart_drops: config.smart_drops,
        protected_tools: config.protected_tools.clone(),
        cache_ttl: config
            .resolve_cache_ttl_with_provenance(Some("fixture"))
            .value,
        cache_ttl_provenance: config
            .resolve_cache_ttl_with_provenance(Some("fixture"))
            .provenance,
        cache_ttl_policy: None,
        model_key: Some("fixture".into()),
        observed_last_response_at_ms: Some(2),
        guidance_date: None,
        historian_active: active,
        wrapup_active: false,
        caveman_english_word_rules: transform::caveman_english_word_rules(
            config.language.as_deref(),
        ),
        injected_reductions: vec![],
    };
    let output =
        transform::transform_with_projection(h.store.get().unwrap(), &req, &context).unwrap();
    let view = transform::compaction::View {
        compaction_id: "oracle".into(),
        version: 1,
        range: transform::compaction::Range {
            lineage_id: "L".into(),
            from: 1,
            to: entries.last().unwrap().ordinal + 1,
        },
        replacement: output
            .response
            .ck_messages
            .as_ref()
            .unwrap()
            .iter()
            .map(|m| (**m).clone())
            .collect(),
    };
    let native = codec::Codec::OpencodeAiSdk
        .encode_view(
            &view,
            &req,
            &codec_opencode::NativeRenderContext::from(&output),
        )
        .unwrap();
    (
        json!(native.replacement),
        output.response.prefix_bust_permitted,
    )
}

#[tokio::test]
async fn review_m5_served_native_bytes_fire_next_and_published_pass() {
    let dir = tempfile::tempdir().unwrap();
    let reference_dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path());
    let reference = handler(reference_dir.path());
    declare(&h).await;
    declare(&reference).await;
    let entries = corpus();
    review_sync(&h, &entries[..3], json!({}));
    for entry in &entries[..3] {
        review_hook_message(&h, entry).await;
    }
    let applied = warm(&h, &entries[..3]).await;
    warm(&reference, &entries[..3]).await;
    let mut served = applied["compaction"]["replacement"]
        .as_array()
        .unwrap()
        .clone();
    review_sync(&h, &entries[3..], json!({}));
    for entry in &entries[3..] {
        served.push(review_hook_message(&h, entry).await);
    }
    let inputs = json!({"usage":{"current_total_input_tokens":45000,"context_limit_tokens":50000}});
    review_sync(&h, &[], inputs.clone());
    let fire = h
        .provider_historian_worker()
        .prepare_provider_historian(&binding(&h), &key(&h))
        .await
        .unwrap()
        .unwrap();
    let expected_fire = oracle(&reference, &entries, &["test/model".into()], inputs);
    let (PreparedHistorianAction::FireReady(p), PreparedHistorianAction::FireReady(e)) =
        (fire, expected_fire)
    else {
        panic!("must fire")
    };
    let from = p.task.firing.from_ordinal;
    let to = p.task.firing.to_ordinal;
    let mut task = Some(p);
    let mut running = None;
    let mut run = Value::Null;
    for phase in ["fire", "next"] {
        if phase == "next" {
            let p = task.take().unwrap();
            running = Some(tokio::spawn(McHandler::execute_historian_firing_task(
                h.producer_factory.clone(),
                p.task,
            )));
            run = pending(&h).await;
        }
        let mut status = step(phase, 80);
        status["last_applied"] = applied["compaction"].clone();
        assert_eq!(
            response(h.handle_provider_value(7, "compaction.step", &status).await)["answer"],
            "noop"
        );
        let (expected, _) = review_full_native(&reference, &entries, 1000, phase == "next");
        review_bytes(
            phase,
            &serde_json::to_vec(&served).unwrap(),
            &serde_json::to_vec(&expected).unwrap(),
        );
    }
    // The full transform persisted the reference's content fingerprints, which
    // the publication compare-and-swap checks against the selected raw messages.
    claim_and_report(&h, run, from, to).await;
    running.unwrap().await.unwrap().unwrap();
    review_publish(&reference, e).await;
    assert!(to >= from);
    let mut status = step("published", 80);
    status["last_applied"] = applied["compaction"].clone();
    assert_eq!(
        response(h.handle_provider_value(7, "compaction.step", &status).await)["answer"],
        "noop"
    );
    let (expected, _) = review_full_native(&reference, &entries, 1000, false);
    review_bytes(
        "published",
        &serde_json::to_vec(&served).unwrap(),
        &serde_json::to_vec(&expected).unwrap(),
    );
    eprintln!("M5_REVIEW complete native served array: fire/next/published bytes identical");
}

#[tokio::test]
async fn review_m5_identity_conflict_is_atomic_and_background_retries() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path());
    declare(&h).await;
    let entries = corpus();
    review_sync(
        &h,
        &entries,
        json!({"usage":{"current_total_input_tokens":45000,"context_limit_tokens":50000}}),
    );
    let decoded = codec_opencode::decode_messages(&entries).unwrap();
    let projection = ck_wire::project_messages(&decoded.messages).unwrap();
    let store = h.store.get().unwrap();
    let state = store.load("s").unwrap();
    let mut meta = state.meta.clone();
    let mut conflict = projection.identity_by_mid["m1"].clone();
    conflict[0].byte_fingerprint = "conflict".into();
    meta.block_identity_by_mid.insert("m1".into(), conflict);
    store
        .commit("s", state.row_version, &state.core, &meta)
        .unwrap();
    let action = h
        .provider_historian_worker()
        .prepare_provider_historian(&binding(&h), &key(&h))
        .await;
    assert!(
        action.is_err(),
        "conflicting derived identity must refuse before launch"
    );
    assert_eq!(store.load("s").unwrap().meta.block_identity_by_mid.len(), 1);
    assert_eq!(
        store.load_meta("s").unwrap().meta.historian.state,
        HistorianPhase::Idle
    );
    review_sync(
        &h,
        &[],
        json!({"usage":{"current_total_input_tokens":45000,"context_limit_tokens":50000}}),
    );
    // Mark trigger evaluation due again: the direct preparation call above
    // returned an error without running the scheduler's error/retry handler.
    h.retry_provider_historian(&key(&h)).await;
    h.schedule_provider_historian(binding(&h), key(&h));
    tokio::task::yield_now().await;
    let c = store
        .load_provider_conversation(&key(&h).store_key())
        .unwrap()
        .unwrap();
    let counters: Value = serde_json::from_str(&c.hook_counters_json).unwrap();
    assert_eq!(counters["historian_evaluation_due"], true);
    assert_eq!(store.load("s").unwrap().meta.block_identity_by_mid.len(), 1);
    eprintln!("M5_REVIEW identity conflict: direct error; scheduled retry flag=true; no partial insert; wire reply already returned, diagnostic is background-only");
}

async fn review_hook_message(h: &McHandler, entry: &compact::status::StatusMessage) -> Value {
    let mut params = hook(entry, false);
    let tool = entry.message["parts"][0]["type"] == "tool";
    let source = if tool {
        params["hook"] = json!("post_tool");
        params["tool"] = entry.message["parts"][0]["tool"].clone();
        params["tool_call_id"] = entry.message["parts"][0]["callID"].clone();
        params["is_error"] = json!(false);
        params["subject_part"] = entry.message["parts"][0]["id"].clone();
        entry.message["parts"][0]["state"]["output"]
            .as_str()
            .unwrap()
    } else {
        entry.message["parts"][0]["text"].as_str().unwrap()
    };
    let blocks = vec![source.to_owned()];
    params["blocks"] = json!(blocks);
    let answer: hooks::answer::HookAnswer = decode(&response(
        h.handle_provider_value(7, "transform.hook", &params).await,
    ))
    .unwrap();
    let rendered = match answer {
        hooks::answer::HookAnswer::Pass => blocks,
        hooks::answer::HookAnswer::Ops { ops } => hooks::answer::apply_ops(&blocks, &ops).unwrap(),
        other => panic!("{other:?}"),
    };
    let mut message = entry.message.clone();
    if tool {
        message["parts"][0]["state"]["output"] = json!(rendered[0]);
    } else {
        message["parts"][0]["text"] = json!(rendered[0]);
    }
    message
}

#[tokio::test]
async fn review_m5_ingest_identity_scope_and_replay_writes() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path());
    declare(&h).await;
    let entries = corpus();
    review_sync(&h, &entries, json!({}));
    let store = h.store.get().unwrap();
    assert!(
        store
            .load("s")
            .unwrap()
            .meta
            .block_identity_by_mid
            .is_empty(),
        "ingest itself does not write identities"
    );
    let StorageBackend::Sqlite { path } = dev_descriptor_at(dir.path().to_str().unwrap()).backend
    else {
        panic!("sqlite fixture")
    };
    let conn = rusqlite::Connection::open(path).unwrap();
    let version = || {
        conn.query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0))
            .unwrap()
    };
    let before = version();
    let k = key(&h).store_key();
    let lineage = store.load_provider_lineage(&k, "L").unwrap().unwrap();
    let held = store.load_provider_messages(&k, "L").unwrap();
    store
        .commit_provider_status(&k, &lineage, &held, None, &[])
        .unwrap();
    let after = version();
    assert_eq!(store.load_provider_messages(&k, "L").unwrap(), held);
    eprintln!(
        "M5_REVIEW replayed ingest data_version={before}->{after}; identity rows at raw ingest=0"
    );
    let full_dir = tempfile::tempdir().unwrap();
    let full = handler(full_dir.path());
    review_full_native(&full, &entries[..3], 1000, false);
    assert!(!full
        .store
        .get()
        .unwrap()
        .has_provider_namespace("s")
        .unwrap());
    let identities = full
        .store
        .get()
        .unwrap()
        .load("s")
        .unwrap()
        .meta
        .block_identity_by_mid;
    let projection = ck_wire::project_messages(
        &codec_opencode::decode_messages(&entries[..3])
            .unwrap()
            .messages,
    )
    .unwrap();
    assert_eq!(identities, projection.identity_by_mid);
    review_full_native(&full, &entries[..3], 1000, false);
    assert_eq!(
        full.store
            .get()
            .unwrap()
            .load("s")
            .unwrap()
            .meta
            .block_identity_by_mid,
        identities
    );
}

async fn review_wait_idle(h: &McHandler) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while h
            .store
            .get()
            .unwrap()
            .load_meta("s")
            .unwrap()
            .meta
            .historian
            .state
            != HistorianPhase::Idle
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("recovery must release the durable veto");
}

#[tokio::test]
async fn review_m5_provider_crash_claim_report_publish_matrix() {
    for phase in ["queued", "claimed", "reported", "published"] {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        declare(&h).await;
        let entries = corpus();
        review_sync(
            &h,
            &entries,
            json!({"usage":{"current_total_input_tokens":45000,"context_limit_tokens":50000}}),
        );
        let action = h
            .provider_historian_worker()
            .prepare_provider_historian(&binding(&h), &key(&h))
            .await
            .unwrap()
            .unwrap();
        let PreparedHistorianAction::FireReady(p) = action else {
            panic!("must fire")
        };
        let (from, to) = (p.task.firing.from_ordinal, p.task.firing.to_ordinal);
        let task = tokio::spawn(McHandler::execute_historian_firing_task(
            h.producer_factory.clone(),
            p.task,
        ));
        let run = pending(&h).await;
        let mut claim = Value::Null;
        if phase != "queued" {
            claim = dispatch(&h, json!({"method":"historian.claim","v":1,"run_id":run["run_id"],"claimant_instance_id":"first-host"})).await;
            assert_eq!(claim["ok"], true);
        }
        let output = format!(
            r#"<output><compartments><compartment start="{from}" end="{to}" title="crash recovery" episode_type="feature" importance="60"><p1>recovered history</p1><p2>short summary</p2><p3>arc</p3><p4 /></compartment></compartments><meta><messages_processed>{from}-{to}</messages_processed><unprocessed_from>{}</unprocessed_from></meta></output>"#,
            to + 1
        );
        if phase == "published" {
            let reply = dispatch(&h,json!({"method":"historian.complete","v":1,"run_id":run["run_id"],"token":claim["token"],"output":{"text":output,"length_capped":false}})).await;
            assert_eq!(reply["ok"], true);
            task.await.unwrap().unwrap();
        } else {
            task.abort();
            assert!(matches!(task.await, Err(error) if error.is_cancelled()));
        }
        drop(h);
        let restarted = handler(dir.path());
        if phase == "reported" {
            let reply = dispatch(&restarted,json!({"method":"historian.complete","v":1,"run_id":run["run_id"],"token":claim["token"],"output":{"text":output,"length_capped":false}})).await;
            assert_eq!(reply["ok"], true);
        }
        review_sync(&restarted, &[], json!({}));
        restarted
            .provider_historian_worker()
            .prepare_provider_historian(&binding(&restarted), &key(&restarted))
            .await
            .unwrap();
        if phase == "queued" || phase == "claimed" {
            let claimed = if phase == "queued" {
                let offered = pending(&restarted).await;
                assert_eq!(offered["run_id"], run["run_id"]);
                dispatch(&restarted,json!({"method":"historian.claim","v":1,"run_id":run["run_id"],"claimant_instance_id":"second-host"})).await
            } else {
                let store = restarted.store.get().unwrap();
                let project = restarted
                    .route_project(store, &binding(&restarted))
                    .unwrap()
                    .key;
                let takeover = store
                    .claim_historian_run(
                        &project,
                        run["run_id"].as_str().unwrap(),
                        "second-host",
                        claim["claim_deadline_ms"].as_i64().unwrap(),
                    )
                    .unwrap();
                let mc_store::HistorianClaimOutcome::Claimed(takeover) = takeover else {
                    panic!("stale lease must transfer")
                };
                let late = dispatch(&restarted,json!({"method":"historian.complete","v":1,"run_id":run["run_id"],"token":claim["token"],"output":{"text":output,"length_capped":false}})).await;
                assert_eq!(late["refusal"], "superseded_token");
                json!({"ok":true,"token":takeover.token})
            };
            assert_eq!(claimed["ok"], true);
            let reply = dispatch(&restarted,json!({"method":"historian.complete","v":1,"run_id":run["run_id"],"token":claimed["token"],"output":{"text":output,"length_capped":false}})).await;
            assert_eq!(reply["ok"], true);
            review_sync(&restarted, &[], json!({}));
            restarted
                .provider_historian_worker()
                .prepare_provider_historian(&binding(&restarted), &key(&restarted))
                .await
                .unwrap();
        }
        review_wait_idle(&restarted).await;
        assert_eq!(
            restarted
                .store
                .get()
                .unwrap()
                .load_compartments("s")
                .unwrap()
                .len(),
            1,
            "phase={phase}: exactly one publication"
        );
        assert!(
            dispatch(&restarted, json!({"method":"historian.pending","v":1})).await["runs"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        eprintln!(
            "M5_REVIEW crash phase={phase} exactly_one_publication=true in_flight_released=true"
        );
    }
}

#[tokio::test]
async fn review_m5_veto_drop_and_age_heuristic_matrix_matches_full_engine() {
    let mut positive = 0;
    let mut mismatches = Vec::new();
    for (usage, active) in [
        (1000, true),
        (80000, true),
        (80000, false),
        (90000, true),
        (90000, false),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let reference_dir = tempfile::tempdir().unwrap();
        let mut h = handler(dir.path());
        let mut reference = handler(reference_dir.path());
        for handler in [&mut h, &mut reference] {
            let config = {
                let config = handler.fixed_config.as_mut().unwrap();
                config.protected_tokens_user = Some(0);
                config.protected_tools.clear();
                config.clone()
            };
            let mut b = binding(handler);
            b.config = config;
            handler.bind_route(7, b);
        }
        declare(&h).await;
        declare(&reference).await;
        let mut entries = corpus();
        entries[1].message = json!({"info":{"id":"m2","role":"assistant","time":{"created":2000}},"parts":[
            {"id":"p2","type":"tool","callID":"read-old","tool":"read","state":{"status":"completed","input":{"filePath":"old.txt"},"output":"old payload ".repeat(3000)}}]});
        for ordinal in [40, 50, 60] {
            entries[ordinal - 1].message = json!({"info":{"id":format!("m{ordinal}"),"role":"assistant","time":{"created":ordinal*1000}},"parts":[
                {"id":format!("p{ordinal}"),"type":"tool","callID":format!("read-new-{ordinal}"),"tool":"read","state":{"status":"completed","input":{"filePath":"old.txt"},"output":"fresh payload ".repeat(50)}}]});
        }
        for handler in [&h, &reference] {
            review_sync(handler, &entries[..3], json!({}));
            for entry in &entries[..3] {
                review_hook_message(handler, entry).await;
            }
        }
        let applied = warm(&h, &entries[..3]).await;
        warm(&reference, &entries[..3]).await;
        // Age reclaim requires a prior execute watermark, not just old ordinals.
        // Seed that historical input equally; the current pass still needs an
        // independently authorized prefix rebuild before applying the drops.
        for handler in [&h, &reference] {
            let store = handler.store.get().unwrap();
            let loaded = store.load_meta("s").unwrap();
            let mut meta = loaded.meta;
            meta.last_execute_ordinal = 3;
            store.commit_meta("s", loaded.row_version, &meta).unwrap();
        }
        for handler in [&h, &reference] {
            review_sync(handler, &entries[3..], json!({}));
            for entry in &entries[3..] {
                review_hook_message(handler, entry).await;
            }
        }
        let ref_store = reference.store.get().unwrap();
        let ref_key = key(&reference).store_key();
        let ref_lineage = ref_store
            .load_provider_lineage(&ref_key, "L")
            .unwrap()
            .unwrap();
        ref_store
            .commit_provider_status(&ref_key, &ref_lineage, &[], Some(80), &[])
            .unwrap();
        review_sync(
            &h,
            &[],
            json!({"usage":{"current_total_input_tokens":45000,"context_limit_tokens":50000}}),
        );
        let mut task = None;
        let mut run = Value::Null;
        if active {
            let action = h
                .provider_historian_worker()
                .prepare_provider_historian(&binding(&h), &key(&h))
                .await
                .unwrap()
                .unwrap();
            let PreparedHistorianAction::FireReady(p) = action else {
                panic!("must fire")
            };
            task = Some(tokio::spawn(McHandler::execute_historian_firing_task(
                h.producer_factory.clone(),
                p.task,
            )));
            run = pending(&h).await;
        }
        for handler in [&h, &reference] {
            handler
                .store
                .get()
                .unwrap()
                .append_pending_agent_drops("s", &["m3#0".into()], 2)
                .unwrap();
        }
        let (expected, permitted) = review_full_native(&reference, &entries, usage, active);
        let mut status = step("mutation-matrix", 80);
        status["served_through_ordinal"] = json!(80);
        status["estimate"]["request_tokens"] = json!(usage);
        status["last_applied"] = applied["compaction"].clone();
        let actual = response(h.handle_provider_value(7, "compaction.step", &status).await);
        let pending_actual = h
            .store
            .get()
            .unwrap()
            .load_pending_agent_drops("s")
            .unwrap()
            .len();
        let pending_expected = reference
            .store
            .get()
            .unwrap()
            .load_pending_agent_drops("s")
            .unwrap()
            .len();
        assert_eq!(
            pending_actual, pending_expected,
            "usage={usage}, active={active}"
        );
        if actual["answer"] == "compaction_message" {
            if let Some(diff) = review_byte_diff(
                &format!("mutation usage={usage} active={active}"),
                &serde_json::to_vec(&actual["compaction"]["replacement"]).unwrap(),
                &serde_json::to_vec(&expected).unwrap(),
            ) {
                mismatches.push(diff);
            }
        } else {
            assert!(
                !permitted,
                "a full-engine bust was skipped: usage={usage} active={active}"
            );
        }
        let heuristic_dropped = expected
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["info"]["id"] == "m2")
            .any(|m| serde_json::to_string(m).unwrap().contains("[dropped"));
        if usage == 90000 {
            assert!(
                heuristic_dropped,
                "force-band control must actually apply the age heuristic"
            );
            assert_eq!(
                pending_expected, 0,
                "force-band control must actually apply queued drops"
            );
            positive += 1;
        }
        eprintln!("M5_REVIEW veto usage={usage} active={active} answer={} pending_drops={pending_actual} age_tool_dropped={heuristic_dropped}", actual["answer"]);
        if let Some(task) = task {
            task.abort();
            assert!(matches!(task.await, Err(error) if error.is_cancelled()));
            assert!(!run.is_null());
        }
    }
    assert_eq!(positive, 2);
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

#[tokio::test]
async fn review_m5_publication_contention_retries_next_complete_pass() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path());
    declare(&h).await;
    let entries = corpus();
    let inputs = json!({"usage":{"current_total_input_tokens":45000,"context_limit_tokens":50000}});
    review_sync(&h, &entries, inputs.clone());
    let action = h
        .provider_historian_worker()
        .prepare_provider_historian(&binding(&h), &key(&h))
        .await
        .unwrap()
        .unwrap();
    let PreparedHistorianAction::FireReady(p) = action else {
        panic!("must fire")
    };
    let (from, to) = (p.task.firing.from_ordinal, p.task.firing.to_ordinal);
    let task = tokio::spawn(McHandler::execute_historian_firing_task(
        h.producer_factory.clone(),
        p.task,
    ));
    let run = pending(&h).await;
    // Hold the provider serial lock, as a normal admission may do while a
    // completed historian report attempts publication.
    let serial = h.provider_serial.lock_for(&key(&h)).await;
    claim_and_report(&h, run, from, to).await;
    let result = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    assert!(
        result.is_err(),
        "publication must refuse the held admission lock"
    );
    let meta = h.store.get().unwrap().load_meta("s").unwrap().meta;
    assert_eq!(meta.historian.state, HistorianPhase::Idle);
    assert_eq!(meta.historian.failure_backoff_at_ms, None);
    assert!(meta
        .historian
        .last_failure
        .unwrap()
        .contains("provider admission in progress"));
    drop(serial);
    assert!(h
        .store
        .get()
        .unwrap()
        .load_compartments("s")
        .unwrap()
        .is_empty());
    review_sync(&h, &[], inputs.clone());
    let expected = oracle(&h, &entries, &["test/model".into()], inputs);
    assert!(matches!(expected, PreparedHistorianAction::FireReady(_)));
    drop(expected);
    let action = h
        .provider_historian_worker()
        .prepare_provider_historian(&binding(&h), &key(&h))
        .await
        .unwrap();
    assert!(
        matches!(action, Some(PreparedHistorianAction::FireReady(_))),
        "a no-cooldown publication race must retry on the next completed pass; actual={:?}",
        action.map(|a| signature(&a))
    );
}
