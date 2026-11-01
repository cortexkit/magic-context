//! Exact reminder sends and bounded reads against the pre-optimization oracle.
use super::*;
use crate::runner_reminders::{self, ReminderConditions, ReminderState};
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Default)]
struct CaptureRunner {
    sends: Mutex<Vec<Value>>,
    refuse: bool,
}

#[async_trait]
impl session_resolver::ProviderRunner for CaptureRunner {
    async fn call_for_identity(
        &self,
        _: &crate::route_targets::SessionRunnerRoute,
        identity: &session_resolver::RunnerBindIdentity,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        self.call(
            &identity.project_root,
            &identity.session,
            method,
            params,
            budget,
        )
        .await
    }

    async fn call(
        &self,
        _: &Path,
        _: &str,
        method: &str,
        params: Value,
        _: Duration,
    ) -> Result<Value, SessionResolveError> {
        match method {
            "role.describe" => Ok(json!({
                "majors":[{"version":"llm-runner/v1","ops":["role.describe","session.baseline","session.send"]}],
                "implementation_version":"fixture", "session_capabilities_from":"baseline",
                "capabilities":["delivery_order"]
            })),
            "session.send" => {
                self.sends.lock().unwrap().push(params);
                Ok(if self.refuse {
                    json!({"error":{"code":"invalid_params"}})
                } else {
                    json!({"state":"pending","submission_id":"q"})
                })
            }
            _ => panic!("unexpected reminder method: {method}"),
        }
    }
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

/// Build held entries and persisted rows without running the unrelated view engine.
async fn fixture(
    size: u64,
    seed: u64,
    reordered: bool,
) -> (tempfile::TempDir, Rig, State, mc_store::LoadedState) {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let mut state = rig.state();
    let mut rng = Rng(seed);
    for n in 0..size {
        let tool = ["read", "bash", "grep", "ctx_reduce", "ask", "task", "write"]
            [(rng.next() % 7) as usize];
        let part = if n % 5 == 0 {
            json!({"type":"text","text":"next task"})
        } else {
            json!({"type":"tool","tool":tool,"callID":format!("call{n}"),"state":{"status":"completed","input":{},"output":"spent words ".repeat((rng.next() % 240 + 20) as usize)}})
        };
        // Reverse the numeric ordering while preserving unique tag/part identities.
        let number = 100 + if reordered { size - n } else { n } * 3;
        let entry = ReadMessage::new(n, format!("m{n}"), json!({"info":{"id":format!("m{n}"),"role":if n%5==0 {"user"} else {"assistant"}},"parts":[part]}))
            .with_tags(vec![tags::PartTag::tagged("0", format!("§{number}§"))]);
        state
            .entries
            .insert(n, Arc::new(HeldEntry::from_read(&entry).unwrap()));
    }
    state.reindex().unwrap();
    let namespace = state.namespace();
    let rows = tag_rows(&state, codec::Codec::OpencodeAiSdk).unwrap();
    let mut sql = String::from("BEGIN;");
    for row in rows {
        sql.push_str(&format!("INSERT INTO mc_tags(session_id,tag_number,block_id,kind,token_count,created_at_ms) VALUES ('{namespace}',{},'{}','{}',{},0);", row.tag_number, row.block_id, row.kind, row.token_count));
    }
    // Persisted rows can outlive held entries, and still affect protection.
    for n in 0..5 {
        sql.push_str(&format!("INSERT INTO mc_tags(session_id,tag_number,block_id,kind,token_count,created_at_ms) VALUES ('{namespace}',{},'stale{n}','tool_result',{},0);", 10_000_000+n, if n%2==0 { 150 } else { 0 }));
    }
    sql.push_str("COMMIT;");
    rig.store().execute_tag_sql_for_test(&sql).unwrap();
    let mut loaded = rig.store().load(&namespace).unwrap();
    loaded.meta.coverage_ordinal = Some(size - 25);
    let messages = state
        .entries
        .values()
        .map(|entry| decoded_entry(codec::Codec::OpencodeAiSdk, &entry.inbound().unwrap()).unwrap())
        .collect::<Vec<_>>();
    loaded.meta.block_identity_by_mid = ck_wire::project_messages(&messages)
        .unwrap()
        .identity_by_mid;
    loaded
        .meta
        .protected_tool_block_ids
        .insert(format!("m{}#1", size - 22));
    let frozen = mc_core::FrozenUnit {
        key: format!("red:m{}#1", size - 21),
        kind: "tool_result".into(),
        frozen_payload: "kept reduction".into(),
        durability_class: mc_core::DurabilityClass::Lineage,
        reset_rule: String::new(),
    };
    // Keep an unrelated engine field populated to catch accidental metadata replacement.
    loaded.meta.last_render_config = format!("render-{seed}");
    loaded.core.frozen_units.push(frozen);
    loaded.row_version = Some(
        rig.store()
            .commit(&namespace, loaded.row_version, &loaded.core, &loaded.meta)
            .unwrap(),
    );
    (dir, rig, state, loaded)
}

#[tokio::test]
async fn reminder_randomized_exact_send_and_cadence_oracle() {
    let mut hint_calls = [0usize; 2];
    let mut sent = 0;
    for seed in 1..=12 {
        for size in [64, 384, 2048] {
            let (_dir, rig, state, mut loaded) = fixture(size, seed, seed % 2 == 0).await;
            let namespace = state.namespace();
            let mut actual = ReminderState::default();
            actual.meta = loaded.meta.clone();
            let mut expected = actual.clone();
            let config = McModuleConfig {
                protected_tokens_user: Some(if seed % 3 == 0 { u64::MAX } else { 500 }),
                ..Default::default()
            };
            let mut rng = Rng(seed * size);
            let mut cached = None;
            for step in 0..8 {
                match step {
                    1 | 5 => {
                        loaded.meta.historian.last_no_fire = Some(format!("bookkeeping-{step}"))
                    }
                    2 => {
                        let mut reduction = loaded.core.frozen_units[0].clone();
                        reduction.key = format!("red:m{}#1", size - 1);
                        loaded.core.frozen_units.push(reduction);
                    }
                    3 => loaded.meta.coverage_ordinal = Some(size - 24),
                    4 => {
                        loaded
                            .meta
                            .protected_tool_block_ids
                            .insert(format!("m{}#1", size - 2));
                    }
                    6 => loaded.core.frozen_units[0]
                        .frozen_payload
                        .push_str(" updated"),
                    7 => loaded.meta.protected_tool_block_ids.clear(),
                    _ => {}
                }
                if step > 0 {
                    loaded.row_version = Some(if step == 2 || step == 6 {
                        rig.store()
                            .commit(&namespace, loaded.row_version, &loaded.core, &loaded.meta)
                            .unwrap()
                    } else {
                        rig.store()
                            .commit_meta(&namespace, loaded.row_version, &loaded.meta)
                            .unwrap()
                    });
                }
                // Measure the production cache read, not the full oracle's independent load.
                let before_loads = rig.store().state_load_query_count_for_test();
                let snapshot =
                    load_reminder_hint_state(rig.store(), &namespace, None, &mut cached).unwrap();
                let hydrated = rig.store().state_load_query_count_for_test() - before_loads;
                assert_eq!(
                    hydrated,
                    usize::from(step != 1 && step != 5),
                    "hint-key invalidation seed={seed},size={size},step={step}"
                );
                loaded = rig.store().load(&namespace).unwrap();
                if step % 2 == 1 {
                    rig.store().execute_tag_sql_for_test(&format!("INSERT INTO pending_agent_drops(session_id,target_id,queued_at) VALUES ('{namespace}','m{}#1',1);", size - 23)).unwrap();
                } else {
                    rig.store()
                        .execute_tag_sql_for_test(&format!(
                            "DELETE FROM pending_agent_drops WHERE session_id='{namespace}';"
                        ))
                        .unwrap();
                }
                let baseline = mc_store::TailHygieneBaseline {
                    baseline_u: if step % 4 == 0 {
                        0
                    } else {
                        (rng.next() % 60_000 + 5_000) as i64
                    },
                    baseline_t: 100_000,
                    baseline_generation: step,
                    evaluable: true,
                    content_signature: format!("signature-{seed}-{step}"),
                    ..Default::default()
                };
                loaded.meta.tail_hygiene_baseline = Some(baseline.clone());
                let calls = AtomicUsize::new(0);
                let hints = || {
                    calls.fetch_add(1, Ordering::Relaxed);
                    async_reminder_hints(
                        rig.store(),
                        &state,
                        codec::Codec::OpencodeAiSdk,
                        snapshot,
                        &config,
                        100_000,
                    )
                    .map_err(|e| format!("{e:?}"))
                };
                let oracle_hints = || {
                    async_reminder_hints_oracle(
                        rig.store(),
                        &state,
                        codec::Codec::OpencodeAiSdk,
                        &loaded,
                        &config,
                        100_000,
                    )
                    .map_err(|e| format!("{e:?}"))
                };
                // Also compare hints when no send is due, so empty/misordered selection is observable.
                assert_eq!(
                    hints().unwrap(),
                    oracle_hints().unwrap(),
                    "seed={seed},size={size},step={step}"
                );
                calls.store(0, Ordering::Relaxed);
                let conditions = ReminderConditions {
                    notice_id: "fixed-notice",
                    now_ms: 1_234_567,
                    real_user_turn_count: step * 5,
                    baseline: Some(&baseline),
                    newest_tool_tag: Some(900 + step),
                    hints: &hints,
                    drops_applied: step == 3,
                    baseline_refreshed: true,
                    hard_fold_coverage_advanced: step == 6,
                    user_message_id: Some("last-user"),
                    temporal_enabled: true,
                    gap_ms: Some(86_400_000),
                    ready_search_hint: Some("ready search"),
                };
                let oracle_conditions = ReminderConditions {
                    hints: &oracle_hints,
                    ..conditions
                };
                let runner = CaptureRunner {
                    refuse: step == 5,
                    ..Default::default()
                };
                let oracle_runner = CaptureRunner {
                    refuse: step == 5,
                    ..Default::default()
                };
                let a = runner_reminders::send_due_reminders(
                    &runner,
                    Path::new("/fixture"),
                    "s",
                    &mut actual,
                    &conditions,
                )
                .await;
                let b = runner_reminders::send_due_reminders_oracle(
                    &oracle_runner,
                    Path::new("/fixture"),
                    "s",
                    &mut expected,
                    &oracle_conditions,
                )
                .await;
                let sends = runner.sends.lock().unwrap();
                assert_eq!(
                    *sends,
                    *oracle_runner.sends.lock().unwrap(),
                    "seed={seed},size={size},step={step}"
                );
                assert_eq!(
                    actual.meta, expected.meta,
                    "seed={seed},size={size},step={step}"
                );
                assert_eq!(
                    serde_json::to_value(&actual).unwrap(),
                    serde_json::to_value(&expected).unwrap()
                );
                assert_eq!(format!("{a:?}"), format!("{b:?}"));
                hint_calls[usize::from(calls.load(Ordering::Relaxed) > 0)] += 1;
                sent += sends.len();
            }
        }
    }
    assert!(
        hint_calls[0] > 0 && hint_calls[1] > 0 && sent > 0,
        "both lazy and due hints must execute: {hint_calls:?}"
    );
}

#[tokio::test]
async fn reminder_quiet_notice_bounds_decoded_entries_and_loaded_tags() {
    for size in [64, 512, 4096] {
        let (_dir, rig, state, loaded) = fixture(size, 17, false).await;
        let snapshot = ReminderHintState::of(state.namespace(), &loaded, None);
        let config = McModuleConfig {
            protected_tokens_user: Some(500),
            ..Default::default()
        };
        let mut cadence = ReminderState::default();
        cadence.meta = loaded.meta.clone();
        let baseline = mc_store::TailHygieneBaseline {
            baseline_u: 80_000,
            baseline_t: 100_000,
            evaluable: true,
            ..Default::default()
        };
        for due in [true, false] {
            cadence.meta.channel2_pressure_latched = !due;
            let hints = || {
                async_reminder_hints(
                    rig.store(),
                    &state,
                    codec::Codec::OpencodeAiSdk,
                    &snapshot,
                    &config,
                    100_000,
                )
                .map_err(|e| format!("{e:?}"))
            };
            let conditions = ReminderConditions {
                notice_id: "bounded",
                now_ms: 100,
                real_user_turn_count: 1,
                baseline: Some(&baseline),
                newest_tool_tag: None,
                hints: &hints,
                drops_applied: false,
                baseline_refreshed: false,
                hard_fold_coverage_advanced: false,
                user_message_id: None,
                temporal_enabled: false,
                gap_ms: None,
                ready_search_hint: None,
            };
            let before = resident::counters::read();
            let tags = reminder_work::tags();
            let outcome = runner_reminders::send_due_reminders(
                &CaptureRunner::default(),
                Path::new("/fixture"),
                "s",
                &mut cadence,
                &conditions,
            )
            .await;
            assert!(outcome.hints_failed.is_none());
            let decoded = resident::counters::read().decoded - before.decoded;
            let tags = reminder_work::tags() - tags;
            assert_eq!(
                decoded,
                if due { 24 } else { 0 },
                "size={size},due={due}: only uncovered entries may be decoded"
            );
            assert!(
                tags <= if due { 56 } else { 0 },
                "size={size},due={due}: loaded {tags} tags"
            );
        }
    }
}
