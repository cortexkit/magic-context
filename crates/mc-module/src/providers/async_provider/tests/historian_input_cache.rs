use super::super::historian_cache as input_cache;
use super::*;

fn entry(codec: codec::Codec, ordinal: u64, text: &str) -> ReadMessage {
    let mid = format!("m{ordinal}");
    let role = if ordinal.is_multiple_of(2) {
        "user"
    } else {
        "assistant"
    };
    let call = ordinal % 14 == 3;
    let result = ordinal % 14 == 4;
    let message = match codec {
        codec::Codec::OpencodeAiSdk => {
            let part = if call {
                json!({"type":"tool","tool":"read","callID":format!("call{ordinal}"),"state":{"status":"completed","input":{"path":"file"},"output":text}})
            } else {
                json!({"type":"text","text":text})
            };
            json!({"info":{"id":mid,"role":role},"parts":[part]})
        }
        codec::Codec::Pi => {
            let body = if call {
                json!({"role":"assistant","content":[{"type":"toolCall","id":format!("call{ordinal}"),"name":"read","arguments":{"path":"file"}}]})
            } else if result {
                json!({"role":"toolResult","toolCallId":format!("call{}",ordinal-1),"toolName":"read","content":[{"type":"text","text":text}],"isError":false})
            } else {
                json!({"role":role,"content":[{"type":"text","text":text}]})
            };
            json!({"type":"message","id":mid,"timestamp":"2026-01-01T00:00:00Z","message":body})
        }
        codec::Codec::OwnedBroca => {
            if call {
                json!({"role":"assistant","content":[{"type":"tool_call","tool_call_id":format!("call{ordinal}"),"tool_name":"read","input":{"path":"file"}}]})
            } else if result {
                json!({"role":"tool","content":[{"type":"tool_result","tool_call_id":format!("call{}",ordinal-1),"output":{"kind":"text","text":text},"is_error":false}]})
            } else {
                json!({"role":role,"content":[{"type":"text","text":text}]})
            }
        }
        codec::Codec::AnthropicMessages => {
            if call {
                json!({"role":"assistant","content":[{"type":"tool_use","id":format!("call{ordinal}"),"name":"read","input":{"path":"file"}}]})
            } else if result {
                json!({"role":"user","content":[{"type":"tool_result","tool_use_id":format!("call{}",ordinal-1),"content":text}]})
            } else {
                json!({"role":role,"content":[{"type":"text","text":text}]})
            }
        }
    };
    ReadMessage::new(ordinal, mid, message).with_tags(vec![tags::PartTag::tagged(
        "0",
        format!("§{}§", ordinal + 1),
    )])
}

fn put(state: &mut State, codec: codec::Codec, ordinal: u64, text: &str) {
    if state.entries.contains_key(&ordinal) {
        state.journal.replaced.insert(ordinal);
    }
    state.entries.insert(
        ordinal,
        Arc::new(HeldEntry::from_read(&entry(codec, ordinal, text)).unwrap()),
    );
}

fn request(state: &State, codec: codec::Codec) -> TransformRequest {
    decode(
        &json!({"v":2,"kind":"compaction.async","session_id":state.namespace(),
        "serializer_profile":codec.wire_id(),"model_key":"fixture","render_config":"fixture",
        "messages":[],"tool_present":false,"auto_search_enabled":false}),
    )
    .unwrap()
}

#[tokio::test]
async fn review_historian_cache_caps_large_tool_fanout_frontiers() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let store = rig.h.store.get().unwrap();
    let mut state = rig.state();
    let calls = 1024u64;
    let content = (0..calls)
        .map(|index| {
            json!({"type":"tool_call","tool_call_id":format!("call-{index}"),
                "tool_name":"read","input":{"path":"file"}})
        })
        .collect::<Vec<_>>();
    let first = ReadMessage::new(0, "fanout", json!({"role":"assistant","content":content}))
        .with_tags(
            (0..calls)
                .map(|index| {
                    tags::PartTag::tagged(index.to_string(), format!("§{}§", 100_000 + index))
                })
                .collect(),
        );
    state
        .entries
        .insert(0, Arc::new(HeldEntry::from_read(&first).unwrap()));
    for index in 0..calls {
        let result = ReadMessage::new(
            index + 1,
            format!("result-{index}"),
            json!({
                "role":"tool","content":[{"type":"tool_result",
                    "tool_call_id":format!("call-{index}"),
                    "output":{"kind":"text","text":"result"},"is_error":false}]
            }),
        )
        .with_tags(vec![tags::PartTag::tagged(
            "0",
            format!("§{}§", 200_000 + index),
        )]);
        state
            .entries
            .insert(index + 1, Arc::new(HeldEntry::from_read(&result).unwrap()));
    }
    state.save(store, &[]).unwrap();
    let window = historian_tail::InputWindow {
        from: 0,
        ordinal_base: 0,
        through: Some(calls),
    };
    let codec = codec::Codec::OwnedBroca;
    let mut parsed = request(&state, codec);
    let mut cache = input_cache::Cache::default();
    let input = cache
        .prepare(
            input_cache::Source {
                store,
                reference: &state.reference(),
                window,
                codec,
                echoes: &state.reminder_echoes,
                prelude: None,
                stamp: input_cache::Stamp::of(&state, codec, window).unwrap(),
            },
            &mut parsed,
        )
        .unwrap();
    cache.finish(input, &mut parsed, None);
    let accounted = cache.retained_bytes();
    let projection = cache.projection_bytes();
    eprintln!("fanout={calls} accounted_bytes={accounted} projection_bytes={projection}");
    // The projection retains a cloned tool-pairing state after every message.
    // Those owned allocations alone must fit the per-session cache cap.
    assert!(
        projection <= 128 * 1024 * 1024,
        "retained projection alone exceeds 128 MiB: {projection}; LRU charged only {accounted}"
    );
}

#[tokio::test]
async fn historian_cache_matches_uncached_inputs_across_notice_lifecycle() {
    for codec in [
        codec::Codec::OwnedBroca,
        codec::Codec::AnthropicMessages,
        codec::Codec::Pi,
        codec::Codec::OpencodeAiSdk,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let rig = Rig::new(dir.path()).await;
        let store = rig.h.store.get().unwrap();
        let mut state = rig.state();
        let reference = state.reference();
        let mut next = 0;
        let mut from = 0;
        let token_cache = Mutex::new(crate::BoundaryTokenCache::new(
            crate::BOUNDARY_TOKEN_CACHE_BUDGET_BYTES,
        ));
        let oracle_tokens = Mutex::new(crate::BoundaryTokenCache::new(
            crate::BOUNDARY_TOKEN_CACHE_BUDGET_BYTES,
        ));
        for notice in 0..180 {
            match notice {
                30 => state.generation += 1,
                60 => {
                    state.reasoning_pruned =
                        Some(pruned_reasoning::PruneState::new(1, 0, 1_767_312_000_000));
                    put(&mut state, codec, 0, "copy after archive pruning");
                }
                90 => put(&mut state, codec, 5, "non-append replacement"),
                120 => {
                    let old = Arc::downgrade(&state.historian_cache);
                    drop(state);
                    assert!(old.upgrade().is_none(), "restart retained resident buffers");
                    state = load(store, &reference).unwrap().unwrap();
                    assert_eq!(state.historian_cache.lock().unwrap().retained_bytes(), 0);
                }
                150 => {
                    let old = Arc::downgrade(&state.historian_cache);
                    state.truncate_entries(None);
                    assert!(
                        old.upgrade().is_none(),
                        "lineage reset retained old buffers"
                    );
                    state.lineage = Some("reset-lineage".into());
                    state.generation += 1;
                    next = 0;
                    from = 0;
                }
                165 => from = next - 20,
                _ => {}
            }
            for _ in 0..4 {
                put(
                    &mut state,
                    codec,
                    next,
                    &format!("notice {notice}, row {next}"),
                );
                next += 1;
            }
            state.seq = notice + 1;
            state.completed_seq = state.seq;
            state.save(store, &[]).unwrap();
            let window = historian_tail::InputWindow {
                from,
                ordinal_base: from,
                through: Some(next - 1),
            };
            let mut cached = request(&state, codec);
            let cache = Arc::clone(&state.historian_cache);
            let mut cache = cache.lock().unwrap();
            historian_tail::DECODED_ROWS.with(|rows| rows.set(0));
            let mut input = cache
                .prepare(
                    input_cache::Source {
                        store,
                        reference: &reference,
                        window,
                        codec,
                        echoes: &state.reminder_echoes,
                        prelude: None,
                        stamp: input_cache::Stamp::of(&state, codec, window).unwrap(),
                    },
                    &mut cached,
                )
                .unwrap();
            let decoded = historian_tail::DECODED_ROWS.with(|rows| rows.get());
            let rebuild = matches!(notice, 0 | 30 | 60 | 90 | 120 | 150 | 165);
            assert_eq!(input.reused, !rebuild, "{codec:?}, notice {notice}");
            assert_eq!(
                decoded,
                if rebuild { (next - from) as usize } else { 4 },
                "{codec:?}, notice {notice}"
            );
            let mut oracle = request(&state, codec);
            let projection = historian_tail::prepare_cut_input(
                store,
                &reference,
                window,
                codec,
                &mut oracle,
                &state.reminder_echoes,
                None,
            )
            .unwrap();
            assert_eq!(
                cached.messages, oracle.messages,
                "{codec:?}, notice {notice}: cut input"
            );
            assert_eq!(
                cached.native_messages, oracle.native_messages,
                "{codec:?}, notice {notice}: native sidecar"
            );
            assert_eq!(cached.serializer_profile, oracle.serializer_profile);
            assert_eq!(cached.provider_id, oracle.provider_id);
            assert_eq!(cached.serve_native, oracle.serve_native);
            assert_eq!(
                input.projection, projection,
                "{codec:?}, notice {notice}: projection"
            );
            let mut calibration = crate::decision_calibration::DecisionCalibration::neutral();
            if notice >= 75 {
                calibration.prose_ratio = 1.2;
                calibration.tools_ratio = 0.8;
            }
            let ctx = crate::boundary::TriggerContext {
                boundary: crate::boundary::BoundaryContext {
                    calibration: Some(calibration),
                    context_limit: match notice % 3 {
                        0 => 1_000.0,
                        1 => 8_000.0,
                        _ => 1_000_000.0,
                    },
                    execute_threshold_percentage: 0.8,
                    usage_percentage: match notice % 4 {
                        0 => 0.1,
                        1 => 0.7,
                        2 => 0.92,
                        _ => 0.99,
                    },
                    usage_input_tokens: 1000.0,
                    last_compartment_end_ordinal: from.checked_sub(1),
                    prior_boundary_ordinal: from.saturating_sub(1),
                    migration_floor_active: from > 0,
                    fold_is_only_reclaim: true,
                    ..Default::default()
                },
                projected_post_drop_percentage: None,
                reclaim_ride_available: false,
                compartment_in_progress: false,
                commit_cluster_trigger_enabled: true,
                min_commit_clusters: 2,
            };
            let (mut snapshot, _, _) =
                input
                    .boundary
                    .prepare(&cached, &input.projection, &token_cache, false);
            let actual =
                input
                    .boundary
                    .trigger
                    .check(&input.boundary.messages, &ctx, &mut |bytes| {
                        snapshot.formatted_token_count(bytes)
                    });
            token_cache
                .lock()
                .unwrap()
                .replace(&cached.session_id, snapshot);
            let built = crate::boundary_messages(&oracle, &projection, &oracle_tokens);
            let mut snapshot = built.token_cache_snapshot;
            let expected = crate::boundary::check_compartment_trigger_tail_with_token_estimator(
                &built.messages,
                &ctx,
                &mut |bytes| snapshot.formatted_token_count(bytes),
            );
            oracle_tokens
                .lock()
                .unwrap()
                .replace(&oracle.session_id, snapshot);
            assert_eq!(
                actual, expected,
                "{codec:?}, notice {notice}: trigger, progress and firing boundary"
            );
            cache.finish(input, &mut cached, None);
            assert_eq!(cache.message_count(), (next - from) as usize);
        }
    }
}

#[tokio::test]
async fn historian_cache_rebuilds_when_a_waiting_task_meets_a_same_seq_edit() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let store = rig.h.store.get().unwrap();
    let mut state = rig.state();
    let codec = codec::Codec::OpencodeAiSdk;
    for ordinal in 0..12 {
        put(&mut state, codec, ordinal, "before edit");
    }
    state.save(store, &[]).unwrap();
    let reference = state.reference();
    let window = historian_tail::InputWindow {
        from: 0,
        ordinal_base: 0,
        through: Some(11),
    };
    let scheduled = input_cache::Stamp::of(&state, codec, window).unwrap();
    let fence = AsyncHistoryFence {
        reference: reference.clone(),
        generation: state.generation,
        key: state.key.clone(),
        serial: Arc::clone(&rig.h.provider_serial),
    };
    let cache = Arc::clone(&state.historian_cache);
    let writer = rig.h.provider_serial.lock_for(&state.key).await;
    let mut parsed = request(&state, codec);
    let source = input_cache::Source {
        store,
        reference: &reference,
        window,
        codec,
        echoes: &state.reminder_echoes,
        prelude: None,
        stamp: scheduled.clone(),
    };
    let (input, version) = fence
        .prepare_cached_input(source, &mut parsed, &cache)
        .unwrap();
    cache
        .lock()
        .unwrap()
        .finish(input, &mut parsed, Some(version));
    let serial = Arc::clone(&rig.h.provider_serial);
    let reader_store = Arc::clone(store);
    let reader_cache = Arc::clone(&cache);
    let reader_reference = reference.clone();
    let reader_key = state.key.clone();
    let echoes = state.reminder_echoes.clone();
    let mut delayed = request(&state, codec);
    let (ready, waiting) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let _ = ready.send(());
        let _serial = serial.lock_for(&reader_key).await;
        historian_tail::DECODED_ROWS.with(|rows| rows.set(0));
        let source = input_cache::Source {
            store: &reader_store,
            reference: &reader_reference,
            window,
            codec,
            echoes: &echoes,
            prelude: None,
            stamp: scheduled,
        };
        let (input, version) = fence.prepare_cached_input(source, &mut delayed, &reader_cache)?;
        let decoded = historian_tail::DECODED_ROWS.with(|rows| rows.get());
        Ok::<_, HandlerOutcome>((input, version, delayed, decoded))
    });
    waiting.await.unwrap();
    let (seq, revision) = (state.seq, state.input_revision);
    put(
        &mut state,
        codec,
        5,
        "replacement while the older task waits",
    );
    state.save(store, &[]).unwrap();
    assert_eq!(state.seq, seq);
    assert!(state.input_revision > revision);
    drop(writer);
    let (input, _, delayed, decoded) = task.await.unwrap().unwrap();
    assert!(!input.reused);
    assert_eq!(decoded, 12);
    let mut oracle = request(&state, codec);
    let projection = historian_tail::prepare_cut_input(
        store,
        &reference,
        window,
        codec,
        &mut oracle,
        &state.reminder_echoes,
        None,
    )
    .unwrap();
    assert_eq!(delayed.messages, oracle.messages);
    assert_eq!(delayed.native_messages, oracle.native_messages);
    assert_eq!(input.projection, projection);
}

#[tokio::test]
async fn historian_source_revision_rolls_back_with_a_failed_entry_write() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let store = rig.h.store.get().unwrap();
    let codec = codec::Codec::OpencodeAiSdk;
    let mut state = rig.state();
    put(&mut state, codec, 0, "original");
    state.save(store, &[]).unwrap();
    let (revision, raw) = (
        state.input_revision,
        state.entries.get(&0).unwrap().raw().to_owned(),
    );
    put(&mut state, codec, 0, "replacement");
    let conn = guard_async_writes(dir.path().join("store.db"), "entries");
    assert!(state.save(store, &[]).is_err());
    let mut restored = rig.state();
    assert_eq!(restored.input_revision, revision);
    assert_eq!(restored.entries.get(&0).unwrap().raw(), raw);
    conn.execute_batch("DROP TRIGGER fail_historian_source")
        .unwrap();
    put(&mut restored, codec, 0, "replacement");
    restored.save(store, &[]).unwrap();
    let saved = rig.state();
    assert!(saved.input_revision > revision);
    assert_ne!(saved.entries.get(&0).unwrap().raw(), raw);
}

#[tokio::test]
async fn historian_cache_never_treats_a_missing_source_revision_as_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let store = rig.h.store.get().unwrap();
    let codec = codec::Codec::OpencodeAiSdk;
    let mut state = rig.state();
    for ordinal in 0..4 {
        put(&mut state, codec, ordinal, "legacy source");
    }
    state.save(store, &[]).unwrap();
    let reference = state.reference();
    let key = state.key.store_key().conversation_key();
    let mut raw = serde_json::to_value(&state).unwrap();
    raw.as_object_mut().unwrap().remove("input_revision");
    let raw = raw.to_string();
    store
        .async_compaction_save(&reference, &key, &state.key.session, &raw)
        .commit()
        .unwrap();
    let unknown = rig.state();
    assert_eq!(unknown.input_revision, None);
    let window = historian_tail::InputWindow {
        from: 0,
        ordinal_base: 0,
        through: Some(3),
    };
    for _ in 0..2 {
        let mut parsed = request(&unknown, codec);
        let mut cache = unknown.historian_cache.lock().unwrap();
        historian_tail::DECODED_ROWS.with(|rows| rows.set(0));
        let source = input_cache::Source {
            store,
            reference: &reference,
            window,
            codec,
            echoes: &unknown.reminder_echoes,
            prelude: None,
            stamp: input_cache::Stamp::of(&unknown, codec, window).unwrap(),
        };
        let input = cache.prepare(source, &mut parsed).unwrap();
        assert!(!input.reused);
        assert_eq!(historian_tail::DECODED_ROWS.with(|rows| rows.get()), 4);
        cache.finish(input, &mut parsed, None);
    }
}

#[tokio::test]
#[ignore = "isolated resident-buffer measurement; run explicitly for each window"]
async fn historian_cache_memory_child() {
    let window = std::env::var("MC_HISTORIAN_MEMORY_WINDOW")
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let store = rig.h.store.get().unwrap();
    let mut state = rig.state();
    let codec = codec::Codec::OpencodeAiSdk;
    for ordinal in 0..window {
        put(
            &mut state,
            codec,
            ordinal,
            &format!("row {ordinal} {}", "x".repeat(64)),
        );
    }
    state.save(store, &[]).unwrap();
    let reference = state.reference();
    let span = historian_tail::InputWindow {
        from: 0,
        ordinal_base: 0,
        through: Some(window - 1),
    };
    let mut parsed = request(&state, codec);
    let before = scaling_tests::rss().1;
    {
        let mut cache = state.historian_cache.lock().unwrap();
        let mut input = cache
            .prepare(
                input_cache::Source {
                    store,
                    reference: &reference,
                    window: span,
                    codec,
                    echoes: &state.reminder_echoes,
                    prelude: None,
                    stamp: input_cache::Stamp::of(&state, codec, span).unwrap(),
                },
                &mut parsed,
            )
            .unwrap();
        let (mut snapshot, _, _) =
            input
                .boundary
                .prepare(&parsed, &input.projection, &rig.h.boundary_tokens, false);
        let ctx = crate::boundary::TriggerContext {
            boundary: crate::boundary::BoundaryContext {
                context_limit: 1_000_000.0,
                execute_threshold_percentage: 0.8,
                usage_percentage: 0.1,
                usage_input_tokens: 1000.0,
                ..Default::default()
            },
            projected_post_drop_percentage: None,
            reclaim_ride_available: false,
            compartment_in_progress: false,
            commit_cluster_trigger_enabled: true,
            min_commit_clusters: 2,
        };
        let _decision =
            input
                .boundary
                .trigger
                .check(&input.boundary.messages, &ctx, &mut |bytes| {
                    snapshot.formatted_token_count(bytes)
                });
        rig.h
            .boundary_tokens
            .lock()
            .unwrap()
            .replace(&parsed.session_id, snapshot);
        cache.finish(input, &mut parsed, None);
        let after = scaling_tests::rss().1;
        assert_eq!(cache.message_count(), window as usize);
        eprintln!("HISTORIAN_CACHE_MEMORY W={window} accounted_bytes={} projection_retained_bytes={} rss_before={before} rss_after={after} rss_net={}",
            cache.retained_bytes(), cache.projection_bytes(), after.saturating_sub(before));
    }
    let old = Arc::downgrade(&state.historian_cache);
    state.truncate_entries(None);
    assert!(old.upgrade().is_none());
    assert_eq!(state.historian_cache.lock().unwrap().retained_bytes(), 0);
}
