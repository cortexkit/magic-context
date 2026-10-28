use super::*;

#[tokio::test]
async fn descending_setup_uses_kept_head_without_runner_calls() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(180);
    rig.history(130, "completed history");
    rig.notice(1, 90_000, None).await;
    let state = rig.state();
    let cut = state
        .newest_published_cut()
        .expect("published adoptable cut");
    let first = cut.first_ordinal;
    let version = cut.version;
    let view = rig.get(version).await;
    assert_eq!(view.cut.as_ref().unwrap().through_ordinal, first - 1);
    let reads = rig
        .runner
        .routed_reads
        .load(std::sync::atomic::Ordering::Relaxed);
    let describes = rig
        .runner
        .describes
        .load(std::sync::atomic::Ordering::Relaxed);
    let mut request = serde_json::to_value(&state.setup).unwrap();
    request["lineage_id"] = json!("L2");
    request["descends_from"] = json!({"lineage_id":"L","through_ordinal":first - 1});
    request["request_id"] = json!("descent");
    let answer = rig.op("compaction.setup", request.clone()).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert_eq!(answer["initial"]["range"], json!({"from":first,"to":first}));
    assert!(!answer["initial"]["replacement"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(answer.get("checkpoint").is_none());
    assert_eq!(
        rig.runner
            .routed_reads
            .load(std::sync::atomic::Ordering::Relaxed),
        reads
    );
    assert_eq!(
        rig.runner
            .describes
            .load(std::sync::atomic::Ordering::Relaxed),
        describes
    );
    assert!(rig.state().entries.keys().all(|n| *n >= first));
    request["request_id"] = json!("retry");
    let retry = rig.op("compaction.setup", request).await;
    assert_eq!(retry["initial"], answer["initial"]);
}

#[tokio::test]
async fn native_descent_initial_covers_retained_rows_with_drops_no_read_one_rebuild() {
    // A native cut-descent Setup answers `initial` with the history head plus
    // the rows the last applied view rendered, byte for byte with their drops
    // in effect. Rows after that view's last covered ordinal render raw
    // outside the replacement, `session.read` never runs during Setup, and the
    // new lineage's first view renders the same retained range byte-identically
    // with exactly one rebuild.
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.history(20, "history for the native cut");
    rig.notice(1, 90_000, None).await;
    let baseline = rig.newest().expect("history publishes a view");
    // Drop one retained tool part so the retained rows carry an applied edit.
    // Ordinal 26 is a tool output in `Rig::fill` (`26 % 5 == 1`) and lies at
    // or after the cut (`first` is 21 with history 20), with tag `178`.
    rig.queue(&[178]).await;
    rig.notice(2, 90_000, Some(baseline)).await;
    let applied_version = rig.newest().expect("drops publish a view");
    rig.notice(3, 1_000, Some(applied_version)).await;
    let parent = rig.state();
    assert_eq!(parent.applied, Some(applied_version));
    let applied_view = rig.get(applied_version).await;
    let last = applied_view.covers_through.ordinal;
    let cut = parent
        .newest_published_cut()
        .expect("published adoptable cut");
    let first = cut.first_ordinal;
    assert!(
        last >= first,
        "retained rows exist: first={first} last={last}"
    );
    // Horizon: hold one more row after the last applied view before Setup.
    // It must render raw outside the replacement and never extend `L`.
    let extra_ordinal = parent.entries.keys().max().copied().unwrap_or(last) + 1;
    {
        let mut entries = rig.runner.entries.lock().unwrap();
        let part = json!({"id":format!("p{extra_ordinal}"),"type":"text","text":format!("extra message {extra_ordinal} {}", "durable words ".repeat(4))});
        entries.push(
            ReadMessage::new(
                extra_ordinal,
                format!("m{extra_ordinal}"),
                json!({"info":{"id":format!("m{extra_ordinal}"),"role":"assistant","time":{"created":1}},"parts":[part]}),
            )
            .with_tags(vec![tags::PartTag::tagged("0", format!("§{}§", 100 + extra_ordinal * 3))]),
        );
    }
    rig.notice(4, 1_000, Some(applied_version)).await;
    let parent = rig.state();
    assert!(parent.entries.contains_key(&extra_ordinal));
    assert_eq!(parent.applied, Some(applied_version));
    // Debug the retained range before descent: fail here (not unknown_cut)
    // if the held rows do not cover it.
    for ordinal in first..=last {
        assert!(
            parent.entries.contains_key(&ordinal),
            "held rows must cover retained [{first}, {last}]: missing {ordinal}"
        );
    }
    let reads_before = rig
        .runner
        .routed_reads
        .load(std::sync::atomic::Ordering::Relaxed);
    let passes_before = resident::counters::read().engine_passes;
    let mut request = serde_json::to_value(&parent.setup).unwrap();
    request["lineage_id"] = json!("L2");
    request["descends_from"] = json!({"lineage_id":"L","through_ordinal":first - 1});
    request["request_id"] = json!("descent-f");
    let answer = rig.op("compaction.setup", request.clone()).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert_eq!(
        answer["initial"]["range"],
        json!({"from": first, "to": last + 1}),
        "Setup answers exactly through L: {answer}"
    );
    let replacement = answer["initial"]["replacement"].as_array().unwrap();
    let head: Vec<Value> = serde_json::from_str(&cut.head).unwrap();
    assert!(replacement.len() == head.len() + (last - first + 1) as usize);
    assert_eq!(&replacement[..head.len()], &head);
    // The dropped tool part stays dropped: ordinal 26 renders the drop
    // placeholder, never its original output.
    let dropped_at = replacement[head.len() + (26 - first) as usize].clone();
    let dropped_text = serde_json::to_string(&dropped_at).unwrap();
    assert!(
        dropped_text.contains("[dropped §178§]"),
        "dropped edit must stay in effect: {dropped_at}"
    );
    assert!(
        !dropped_text.contains("exact spent output"),
        "dropped content must not be served: {dropped_at}"
    );
    // The horizon row renders raw outside the replacement, never extending L.
    assert!(
        !replacement.iter().any(|message| {
            message["parts"].as_array().is_some_and(|parts| {
                parts.iter().any(|part| {
                    part["text"].as_str().is_some_and(|text| {
                        text.contains(&format!("extra message {extra_ordinal}"))
                    }) || part["id"].as_str() == Some(&format!("p{extra_ordinal}"))
                })
            }) || message
                .to_string()
                .contains(&format!("extra message {extra_ordinal}"))
                || message.to_string().contains(&format!("m{extra_ordinal}"))
        }),
        "row after L must stay outside the replacement"
    );
    assert_eq!(
        rig.runner
            .routed_reads
            .load(std::sync::atomic::Ordering::Relaxed),
        reads_before,
        "native descent records no session.read"
    );
    assert_eq!(
        resident::counters::read().engine_passes,
        passes_before,
        "Setup renders without a rebuild"
    );
    // First view of the new lineage renders `[f, L + 1)` byte-identically with
    // exactly one rebuild, and the horizon row renders raw after it.
    *rig.runner.lineage.lock().unwrap() = "L2".into();
    rig.notice(5, 90_000, None).await;
    let published = rig.newest().expect("first view publishes");
    assert_eq!(
        resident::counters::read().engine_passes,
        passes_before + 1,
        "publishing the first view is the one rebuild"
    );
    let child = rig.state();
    assert_eq!(child.lineage.as_deref(), Some("L2"));
    let first_view = rig.get(published).await;
    let rendered = rig.render(&first_view);
    let rendered_messages: Vec<Value> = serde_json::from_slice(&rendered).unwrap();
    assert_eq!(&rendered_messages[..replacement.len()], replacement);
}

#[tokio::test]
async fn descent_crash_after_begin_at_cut_recovers_with_full_initial() {
    // A lineage start stays incomplete until the validated rows, replayed
    // edits and complete Setup answer commit together. A crash after
    // `begin_at_cut`'s internal save and before the final Setup save must
    // retry from the selected cut with the full `initial`, never `unknown_cut`
    // or a partial answer. This regression test pins that retry behavior.
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(20);
    rig.history(10, "history");
    rig.notice(1, 90_000, None).await;
    let v1 = rig.newest().expect("view");
    rig.notice(2, 1_000, Some(v1)).await;
    let parent = rig.state();
    let cut = parent.newest_published_cut().expect("cut");
    let first = cut.first_ordinal;
    let applied = rig.get(v1).await;
    let last = applied.covers_through.ordinal;
    let mut request = serde_json::to_value(&parent.setup).unwrap();
    request["lineage_id"] = json!("L2");
    request["descends_from"] = json!({"lineage_id":"L","through_ordinal":first - 1});
    request["request_id"] = json!("crash");
    super::super::cut_runtime::crash_after_descent_begin_for_test();
    let crashed = rig
        .h
        .dispatch_value(
            7,
            json!({"method":"compaction.setup","params":request.clone()}),
        )
        .await;
    // The crash is injected as a transient error after the internal save;
    // nothing is answered yet, and the partial lineage must not be served.
    assert!(
        matches!(crashed, HandlerOutcome::Error { ref code, .. } if code == "transient"),
        "injected crash before final save: {crashed:?}"
    );
    super::super::cut_runtime::clear_crash_after_descent_begin_for_test();
    let mut retry = request.clone();
    retry["request_id"] = json!("retry");
    let answer = rig.op("compaction.setup", retry.clone()).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert_ne!(answer["code"], "unknown_cut", "{answer}");
    assert_eq!(
        answer["initial"]["range"],
        json!({"from": first, "to": last + 1}),
        "retry completes with the full initial: {answer}"
    );
    assert!(!answer["initial"]["replacement"]
        .as_array()
        .unwrap()
        .is_empty());
    // A repeated Setup on the same lineage returns the stored answer.
    let mut again = retry.clone();
    again["request_id"] = json!("again");
    let repeated = rig.op("compaction.setup", again).await;
    assert_eq!(repeated["initial"], answer["initial"]);
}

fn anthropic_text(n: u64, text: &str) -> ReadMessage {
    ReadMessage::new(
        n,
        format!("m{n}"),
        json!({"role":"user","content":[{"type":"text","text":text}]}),
    )
    .with_tags(vec![tags::PartTag::tagged(
        "0",
        format!("§{}§", 1000 + n * 4),
    )])
}

#[tokio::test]
async fn descent_crash_after_begin_at_cut_recovers_on_non_opencode_codec() {
    // The one Setup rule and its crash safety hold on every host. The same
    // crash-and-retry on the `anthropic-messages` serializer profile completes
    // from the selected cut with the full `initial`, never `unknown_cut`.
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open(
        dir.path(),
        "thalamus-harness",
        "claude-code",
        json!({"serializer_profile":"anthropic-messages"}),
    )
    .await;
    for n in 0..20u64 {
        rig.runner.entries.lock().unwrap().push(anthropic_text(
            n,
            &format!("anthropic message {n} {}", "durable words ".repeat(4)),
        ));
    }
    rig.history(10, "anthropic history");
    rig.notice(1, 90_000, None).await;
    let v1 = rig.newest().expect("view");
    rig.notice(2, 1_000, Some(v1)).await;
    let parent = rig.state();
    let cut = parent.newest_published_cut().expect("cut");
    let first = cut.first_ordinal;
    let applied = rig.get(v1).await;
    let last = applied.covers_through.ordinal;
    let mut request = serde_json::to_value(&parent.setup).unwrap();
    request["lineage_id"] = json!("L2");
    request["descends_from"] = json!({"lineage_id":"L","through_ordinal":first - 1});
    request["request_id"] = json!("crash");
    super::super::cut_runtime::crash_after_descent_begin_for_test();
    let crashed = rig
        .h
        .dispatch_value(
            7,
            json!({"method":"compaction.setup","params":request.clone()}),
        )
        .await;
    assert!(
        matches!(crashed, HandlerOutcome::Error { ref code, .. } if code == "transient"),
        "injected crash before final save: {crashed:?}"
    );
    super::super::cut_runtime::clear_crash_after_descent_begin_for_test();
    let mut retry = request.clone();
    retry["request_id"] = json!("retry");
    let answer = rig.op("compaction.setup", retry.clone()).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert_ne!(answer["code"], "unknown_cut", "{answer}");
    assert_eq!(
        answer["initial"]["range"],
        json!({"from": first, "to": last + 1}),
        "retry completes with the full initial on a non-OpenCode-1 codec: {answer}"
    );
    let mut again = retry.clone();
    again["request_id"] = json!("again");
    let repeated = rig.op("compaction.setup", again).await;
    assert_eq!(repeated["initial"], answer["initial"]);
}

#[tokio::test]
async fn unknown_cut_setup_is_terminal() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let mut request = serde_json::to_value(&rig.state().setup).unwrap();
    request["lineage_id"] = json!("unknown");
    request["descends_from"] = json!({"lineage_id":"L","through_ordinal":999});
    for _ in 0..2 {
        let answer = rig.op("compaction.setup", request.clone()).await;
        let decoded: compact::setup::SetupAnswer = decode(&answer).unwrap();
        assert_eq!(answer["code"], "unknown_cut", "{answer}");
        assert_eq!(decoded.retryable(), Some(false));
    }
    assert_eq!(rig.state().lineage.as_deref(), Some("L"));
}

#[tokio::test]
async fn setup_ride_wait_is_capped_and_frozen() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.bind_shared_setup_route();
    for (session, cap, expected) in [
        ("short", Some(700), Some(700)),
        ("long", Some(90_000), Some(10_000)),
        ("absent", None, None),
    ] {
        let mut request = serde_json::to_value(&rig.state().setup).unwrap();
        request["session"] = json!(session);
        if let Some(cap) = cap {
            request["ride_wait_max_ms"] = json!(cap);
        }
        let answer = rig.op("compaction.setup", request.clone()).await;
        assert_eq!(answer["answer"], "ready", "{answer}");
        assert_eq!(answer["ride_wait_ms"].as_u64(), expected);
        request["ride_wait_max_ms"] = json!(1);
        assert_eq!(
            rig.op("compaction.setup", request).await["ride_wait_ms"].as_u64(),
            expected
        );
    }
}

#[tokio::test]
async fn model_change_answers_carry_cache_ttl_even_with_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let expected = json!({"model":"fixture","ms":300_000,"configured":false});
    assert_eq!(rig.state().initial["cache_ttl"], expected);
    let answer = rig
        .op(
            "compaction.ride",
            json!({"session_ref":rig.reference,"cause":"model_change","deadline_ms":1000}),
        )
        .await;
    assert_eq!(answer["answer"], "nothing");
    assert_eq!(answer["cache_ttl"], expected);
    rig.fill(180);
    rig.history(130, "history");
    rig.notice(1, 90_000, None).await;
    let reads = rig
        .runner
        .routed_reads
        .load(std::sync::atomic::Ordering::Relaxed);
    let answer = rig
        .op(
            "compaction.ride",
            json!({"session_ref":rig.reference,"cause":"model_change","deadline_ms":10_000}),
        )
        .await;
    assert_eq!(answer["cache_ttl"], expected);
    assert_eq!(
        rig.runner
            .routed_reads
            .load(std::sync::atomic::Ordering::Relaxed),
        reads
    );
    let view = rig.get(rig.newest().unwrap()).await;
    assert_eq!(serde_json::to_value(view.cache_ttl).unwrap(), expected);
}

#[tokio::test]
async fn folded_ctx_expand_reads_session_history_by_summary_mids() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(10);
    rig.notice(1, 1000, None).await;
    let mut state = rig.state();
    state.lineage_first_ordinal = 6;
    state.save(rig.h.store.get().unwrap(), &[]).unwrap();
    let mut summary = mc_store::StoredCompartment {
        start_message: 0,
        end_message: 5,
        start_message_id: "m0".into(),
        end_message_id: "m5#0".into(),
        ..Default::default()
    };
    let binding = rig.h.facade_binding(7).unwrap();
    let recovered = rig
        .h
        .async_history_expand(&binding, &state.namespace(), &[summary.clone()], 1, 4)
        .await
        .unwrap()
        .unwrap();
    let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone())).unwrap();
    let expected = rig
        .runner
        .entries
        .lock()
        .unwrap()
        .iter()
        .filter(|entry| (1..=4).contains(&entry.ordinal))
        .map(|entry| {
            decoded_entry(
                codec,
                &InboundMessage {
                    ordinal: entry.ordinal,
                    mid: entry.mid.clone(),
                    message: entry.message.clone(),
                },
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        crate::render_durable_range_expand(1, 4, &recovered),
        crate::render_durable_range_expand(1, 4, &expected)
    );
    let calls = rig.runner.history_requests.lock().unwrap().clone();
    assert_eq!(calls.len(), 3);
    assert_eq!(calls[0]["from_mid"], "m0");
    assert!(calls[0].get("from_ordinal").is_none());
    summary.start_message_id = "missing".into();
    let refusal = rig
        .h
        .async_history_expand(&binding, &state.namespace(), &[summary], 0, 4)
        .await
        .unwrap_err();
    assert!(matches!(refusal, HandlerOutcome::Error { code, .. } if code == "unknown_mid"));
}

#[test]
fn cache_policy_uses_mc_resolution_and_session_frozen_defaults() {
    let config = McModuleConfig {
        cache_ttl_by_model: BTreeMap::from([
            ("acme/m-1-x".into(), "never".into()),
            ("m-1".into(), "2m".into()),
            ("acme/*".into(), "3m".into()),
            ("default".into(), "4m".into()),
        ]),
        cache_ttl: "4m".into(),
        ..Default::default()
    };
    let policy = contract_policy::CachePolicy::freeze(&config);
    for (model, ms) in [
        ("acme/m-1-x", None),
        ("acme/m-1-y", Some(120_000)),
        ("acme/other", Some(180_000)),
        ("other/model", Some(240_000)),
    ] {
        assert_eq!(
            policy.resolve(model),
            compact::cache_ttl::CacheTtl::new(model, ms, true)
        );
    }
    let defaults = contract_policy::CachePolicy::freeze(&McModuleConfig::default());
    for (model, ms) in [
        ("openai/gpt-5.6", 1_800_000),
        ("gpt-5.7-mini", 1_800_000),
        ("openai/gpt-6-tiny", 1_800_000),
        ("gpt-5.5", 300_000),
        ("acme/model", 300_000),
    ] {
        assert_eq!(
            defaults.resolve(model),
            compact::cache_ttl::CacheTtl::new(model, Some(ms), false)
        );
    }
}

async fn descend_at(rig: &Rig, first: u64, child: &str) -> Value {
    let state = rig.state();
    let mut request = serde_json::to_value(&state.setup).unwrap();
    request["lineage_id"] = json!(child);
    request["descends_from"] = json!({"lineage_id":state.lineage,"through_ordinal":first - 1});
    request["request_id"] = json!(format!("setup-{child}"));
    let answer = rig.op("compaction.setup", request).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    *rig.runner.lineage.lock().unwrap() = child.into();
    answer
}

#[tokio::test]
async fn parent_summary_after_staging_reaches_child_only_in_a_later_view() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(180);
    rig.history(130, "head at the published cut");
    rig.notice(1, 90_000, None).await;
    let before = rig.state();
    let first = before.newest_published_cut().unwrap().first_ordinal;
    let cut_version = before.cached_cut(first).unwrap().version;
    let cut_view = rig.get(cut_version).await;
    let mut exact_head = Vec::<Value>::new();
    for range in cut_view
        .ranges
        .iter()
        .take_while(|range| matches!(range, view::ViewRange::Replace { .. }))
    {
        if let view::ViewRange::Replace { bytes, .. } = range {
            exact_head.extend(serde_json::from_str::<Vec<Value>>(bytes).unwrap());
        }
    }
    rig.history(145, "a later parent summarizer completion");
    let answer = descend_at(&rig, first, "L2").await;
    assert_eq!(answer["initial"]["replacement"], json!(exact_head));
    assert!(!answer
        .to_string()
        .contains("a later parent summarizer completion"));
    let child = rig.state();
    assert_eq!(
        rig.h
            .store
            .get()
            .unwrap()
            .load_compartments(&child.namespace())
            .unwrap()[0]
            .content,
        "head at the published cut"
    );
    let next = rig
        .ride("ceiling")
        .await
        .expect("the normal next view folds the parent completion");
    assert!(next.view_version > cut_version);
    assert!(rig
        .render(&next)
        .windows(b"a later parent summarizer completion".len())
        .any(|bytes| bytes == b"a later parent summarizer completion"));
    assert_eq!(
        rig.state().initial["initial"],
        answer["initial"],
        "a later view must not rewrite the frozen Setup answer"
    );
}

#[tokio::test]
async fn successive_production_cuts_keep_only_the_window() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(180);
    rig.notice(1, 1_000, None).await;
    let mut previous = 0;
    for (index, end) in [130, 145, 160].into_iter().enumerate() {
        rig.history(end, &format!("summary {index}"));
        let view = rig
            .ride("ceiling")
            .await
            .expect("a summary publishes a new cut view");
        let first = view.cut.as_ref().unwrap().through_ordinal + 1;
        assert!(first > previous);
        let answer = descend_at(&rig, first, &format!("child-{index}")).await;
        let state = rig.state();
        assert_eq!(state.lineage_first_ordinal, first);
        assert_eq!(state.cut_seed.as_ref().unwrap().first_ordinal, first);
        assert!(state.entries.keys().all(|ordinal| *ordinal >= first));
        assert!(state
            .produced_view
            .as_ref()
            .unwrap()
            .view()
            .unwrap()
            .replacement
            .iter()
            .all(|message| message.meta.synthetic
                || message.meta.ordinal.is_none_or(|ordinal| ordinal >= first)));
        assert_eq!(answer["initial"]["range"], json!({"from":first,"to":first}));
        previous = first;
    }
}

#[tokio::test]
async fn next_publication_cleans_an_unsaved_stage_without_accumulating_namespaces() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(180);
    rig.history(130, "history");
    rig.notice(1, 90_000, None).await;
    let store = rig.h.store.get().unwrap();
    let original = rig.state();
    let first = original.newest_published_cut().unwrap().first_ordinal;
    let committed_version = original.cached_cut(first).unwrap().version;
    let codec = codec::Codec::from_params(&Value::Object(original.setup.params.clone())).unwrap();
    let mut last_orphan = None::<String>;
    for _ in 0..3 {
        let mut unsaved = load(store, &rig.reference).unwrap().unwrap();
        let version = store
            .reserve_async_compaction_version(&rig.reference, committed_version)
            .unwrap();
        let mut view = rig.get(committed_version).await;
        view.view_version = version;
        view.digest = view.compute_digest();
        let candidate = unsaved.produced_view.clone().unwrap();
        store
            .save_async_compaction_view(
                &rig.reference,
                version,
                &serde_json::to_string(&view).unwrap(),
                &candidate.json,
            )
            .unwrap();
        unsaved.published_engine.insert(version, candidate);
        unsaved
            .keep_published_cut(store, codec, first, &view)
            .unwrap();
        let pending: Value = serde_json::from_str(
            &store
                .load_async_compaction_baseline(&rig.reference, "pending-cut-stage")
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let namespace = pending["namespace"].as_str().unwrap().to_owned();
        assert!(store.load_namespace_head(&namespace).unwrap().is_some());
        if let Some(previous) = last_orphan {
            assert!(
                store.load_namespace_head(&previous).unwrap().is_none(),
                "a retry cleans the previous crash's stage before creating another"
            );
        }
        last_orphan = Some(namespace);
        // Discard the unsaved record, as a crash before the seed save does.
        drop(unsaved);
        rig.h
            .provider_store
            .async_runtime
            .resident
            .lock()
            .unwrap()
            .forget(&rig.reference);
        assert_eq!(
            load_head(store, &rig.reference)
                .unwrap()
                .unwrap()
                .cached_cut(first)
                .unwrap()
                .version,
            committed_version
        );
    }
    rig.history(145, "next successful summary");
    rig.ride("ceiling").await.expect("next publication");
    assert!(store
        .load_namespace_head(&last_orphan.unwrap())
        .unwrap()
        .is_none());
    assert!(store
        .load_async_compaction_baseline(&rig.reference, "pending-cut-stage")
        .unwrap()
        .is_none());
}

#[cfg(unix)]
#[tokio::test]
async fn stage_crash_before_seed_save_is_cleaned_on_next_publication() {
    use std::os::unix::process::ExitStatusExt;
    let dir = tempfile::tempdir().unwrap();
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "providers::async_provider::tests::published_contract::stage_crash_worker",
            "--ignored",
            "--nocapture",
        ])
        .env("MC_TEST_STAGE_ROOT", dir.path())
        .output()
        .unwrap();
    assert_eq!(
        child.status.signal(),
        Some(6),
        "child must abort after staging, not fail a test: {}",
        String::from_utf8_lossy(&child.stderr)
    );
    let rig = Rig::new(dir.path()).await;
    let store = rig.h.store.get().unwrap();
    let pending: Value = serde_json::from_str(
        &store
            .load_async_compaction_baseline(&rig.reference, "pending-cut-stage")
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    let orphan = pending["namespace"].as_str().unwrap();
    assert!(store.load_namespace_head(orphan).unwrap().is_some());
    rig.fill(180);
    rig.notice(2, 90_000, None).await;
    assert!(store.load_namespace_head(orphan).unwrap().is_none());
    assert!(store.load_tags_for_session(orphan).unwrap().is_empty());
    assert!(store.load_compartments(orphan).unwrap().is_empty());
    assert!(store.compartment_source_revision(orphan).unwrap().is_none());
    assert!(store
        .load_async_compaction_baseline(&rig.reference, "pending-cut-stage")
        .unwrap()
        .is_none());
}

#[tokio::test]
#[ignore = "subprocess abort helper, invoked by stage_crash_before_seed_save_is_cleaned_on_next_publication"]
async fn stage_crash_worker() {
    let root = std::env::var_os("MC_TEST_STAGE_ROOT").expect("parent supplies a private store");
    let rig = Rig::new(std::path::Path::new(&root)).await;
    rig.fill(180);
    rig.history(130, "history at the staged cut");
    cut_runtime::crash_after_stage_for_test();
    rig.notice(1, 90_000, None).await;
    panic!("stage crash point did not execute");
}

#[tokio::test]
async fn descending_setup_carries_tags_appended_after_the_cut_was_staged() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(180);
    rig.history(130, "published head");
    rig.notice(1, 90_000, None).await;
    let staged = rig.state();
    let first = staged.newest_published_cut().unwrap().first_ordinal;
    rig.fill(200);
    rig.notice(2, 1_000, None).await;
    let parent = rig.state();
    let store = rig.h.store.get().unwrap();
    let expected = store
        .load_tags_for_session(&parent.namespace())
        .unwrap()
        .into_iter()
        .filter(|row| {
            ck_wire::split_block_id(&row.block_id)
                .and_then(|(mid, _)| parent.mid_index.get(mid))
                .is_some_and(|ordinal| *ordinal >= first)
        })
        .map(|row| (row.tag_number, row.block_id, row.kind, row.token_count))
        .collect::<Vec<_>>();
    assert!(expected.iter().any(|row| row.1.starts_with("m199#")));
    descend_at(&rig, first, "late-child").await;
    let child = rig.state();
    let actual = store
        .load_tags_for_session(&child.namespace())
        .unwrap()
        .into_iter()
        .map(|row| (row.tag_number, row.block_id, row.kind, row.token_count))
        .collect::<Vec<_>>();
    assert_eq!(
        actual, expected,
        "retained entries and their staged tag namespace must have the same frontier"
    );
}

#[tokio::test]
async fn reset_binds_a_split_history_head_to_every_replaced_source() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(180);
    rig.history(130, "history spanning the restart cut");
    rig.notice(1, 90_000, None).await;
    let version = rig.newest().unwrap();
    rig.notice(2, 1_000, Some(version)).await;
    let mut view = rig.get(version).await;
    // Fragment the head explicitly: cut placement now follows the complete
    // summary, but reset must still bind every leading replacement fragment.
    let source_end = view.ranges[0].to();
    if let view::ViewRange::Replace { to, .. } = &mut view.ranges[0] {
        *to = source_end - 1;
    }
    view.ranges.insert(
        1,
        view::ViewRange::replace(source_end - 1, source_end, "[]"),
    );
    let store = rig.h.store.get().unwrap();
    let engine = store
        .load_async_compaction_views(&rig.reference)
        .unwrap()
        .0
        .into_iter()
        .find(|(stored, _, _, _)| *stored == version)
        .unwrap()
        .2
        .unwrap();
    let fragmented = store
        .reserve_async_compaction_version(&rig.reference, version)
        .unwrap();
    view.view_version = fragmented;
    view.digest = view.compute_digest();
    store
        .save_async_compaction_view(
            &rig.reference,
            fragmented,
            &serde_json::to_string(&view).unwrap(),
            &engine,
        )
        .unwrap();
    let end = view
        .ranges
        .iter()
        .take_while(|range| matches!(range, view::ViewRange::Replace { .. }))
        .last()
        .unwrap()
        .to();
    assert!(
        view.ranges[0].to() < end,
        "fixture must split the head's source span at the restart point"
    );
    let mut state = rig.state();
    state.applied = Some(fragmented);
    state.reset(rig.h.store.get().unwrap()).unwrap();
    let source = state
        .resync_sources
        .as_ref()
        .unwrap()
        .head
        .as_ref()
        .unwrap();
    assert_eq!(source.messages.len(), end as usize);
    assert_eq!(source.messages.last().unwrap().mid, format!("m{}", end - 1));
}

#[tokio::test]
async fn explicitly_dropped_then_summarized_part_stays_dropped_when_uncovered() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(180);
    rig.history(100, "initial completed history");
    rig.notice(1, 1_000, None).await;
    rig.queue(&[100 + 146 * 3]).await;
    let dropped = rig.ride("ceiling").await.unwrap();
    let removed = |view: &view::CompactionView| {
        view.ranges.iter().any(|range| match range {
            view::ViewRange::Replace { from, to, bytes } => {
                *from <= 146 && 146 < *to && bytes == "[]"
            }
            view::ViewRange::Keep { edits, .. } => edits
                .iter()
                .any(|edit| edit.ordinal == 146 && edit.part == "0" && edit.drop),
            _ => false,
        })
    };
    assert!(
        removed(&dropped),
        "the fixture must explicitly drop m146 before it is summarized"
    );
    rig.notice(2, 1_000, Some(dropped.view_version)).await;
    rig.history(160, "summary covering the explicitly dropped source");
    let covered = rig.ride("ceiling").await.unwrap();
    rig.notice(3, 1_000, Some(covered.view_version)).await;
    rig.history(130, "shorter summary uncovering the same source");
    let uncovered = rig.ride("ceiling").await.unwrap();
    assert!(
        removed(&uncovered),
        "a shorter summary must not restore an explicitly acknowledged part drop"
    );
    assert!(rig
        .h
        .store
        .get()
        .unwrap()
        .load_meta(&rig.state().namespace())
        .unwrap()
        .meta
        .coverage_ordinal
        .is_some_and(|through| through < 146));
}
