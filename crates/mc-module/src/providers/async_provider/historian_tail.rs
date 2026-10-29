//! Selects transcript rows for historian checks, not for the engine or view.
use super::*;

/// Projection clears pending calls at the start of each assistant message and
/// after any message whose role is neither assistant nor tool. Remember those
/// restart points during ingestion,
/// so reading at/before applied coverage preserves the original tool calls
/// for results after coverage without decoding the rest of the transcript.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct InputIndex {
    starts: BTreeMap<u64, u64>,
    reset_next: bool,
    count: u64,
    /// For a lineage that begins at a cut: its first ordinal and the messages
    /// below it. Before the engine has folded anything (no coverage), the
    /// historian input starts there, the earliest row the lineage has.
    floor: Option<(u64, u64)>,
}

impl InputIndex {
    pub(super) fn add(&mut self, message: &ck_wire::CkIngressMessage) {
        let role = message.ck.role.as_str();
        if self.starts.is_empty() || self.reset_next || role == "assistant" {
            self.starts.insert(message.ordinal, self.count);
        }
        self.reset_next = role != "assistant" && role != "tool";
        self.count += 1;
    }

    pub(super) fn window(&self, applied: Option<u64>) -> InputWindow {
        applied
            .and_then(|cut| self.starts.range(..=cut).next_back())
            .map(|(&from, &ordinal_base)| InputWindow {
                from,
                ordinal_base,
                through: None,
            })
            .or_else(|| {
                self.floor.map(|(from, ordinal_base)| InputWindow {
                    from,
                    ordinal_base,
                    through: None,
                })
            })
            .unwrap_or_default()
    }

    pub(super) fn retained_bytes(&self) -> usize {
        self.starts.len() * 48
    }

    /// The index of a lineage that begins at `first` after `count` messages
    /// it does not hold: its first message is a restart point, numbered after
    /// them.
    pub(super) fn seeded(first: u64, count: u64) -> Self {
        Self {
            starts: BTreeMap::new(),
            reset_next: false,
            count,
            floor: Some((first, count)),
        }
    }

    pub(super) fn seed_prelude(&mut self, from: u64, ordinal_base: u64, reset_next: bool) {
        self.keep_prelude_start(from, ordinal_base);
        self.reset_next = reset_next;
    }

    pub(super) fn keep_prelude_start(&mut self, from: u64, ordinal_base: u64) {
        self.starts.insert(from, ordinal_base);
        self.floor = Some((from, ordinal_base));
    }

    /// Messages indexed so far, including any a seed stands for.
    // Only cut capture and pruning (`cut_seed`) call this; only tests drive them so far.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn count(&self) -> u64 {
        self.count
    }

    // Only cut capture and pruning (`cut_seed`) call this; only tests drive them so far.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn is_start(&self, ordinal: u64) -> bool {
        self.starts.contains_key(&ordinal)
    }

    /// The newest restart point at or below `ordinal`: where a cut can put
    /// its first window message without moving the historian's input.
    // Only cut capture and pruning (`cut_seed`) call this; only tests drive them so far.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn restart_at_or_below(&self, ordinal: u64) -> Option<u64> {
        self.starts.range(..=ordinal).next_back().map(|(n, _)| *n)
    }

    /// Forget the restart points below `first`, whose rows are gone.
    // Only cut capture and pruning (`cut_seed`) call this; only tests drive them so far.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn truncate_below(&mut self, first: u64) {
        self.starts = self.starts.split_off(&first);
        self.floor = self.starts.get(&first).map(|count| (first, *count));
    }
}

#[derive(Clone, Copy, Default)]
pub(super) struct InputWindow {
    pub(super) from: u64,
    pub(super) ordinal_base: u64,
    through: Option<u64>,
}

impl InputWindow {
    pub(super) fn through(self, through: Option<u64>) -> Self {
        Self { through, ..self }
    }
}

pub(super) fn applied_window(
    store: &McStore,
    namespace: &str,
    index: &InputIndex,
) -> Result<(Option<u64>, InputWindow), HandlerOutcome> {
    let coverage = store
        .load_meta(namespace)
        .map_err(transient)?
        .meta
        .coverage_ordinal;
    Ok((coverage, index.window(coverage)))
}

#[cfg(test)]
pub(super) fn prepare_input(
    store: &McStore,
    reference: &str,
    window: InputWindow,
    codec: codec::Codec,
    parsed: &mut TransformRequest,
    echoes: &reminder_echoes::ReminderEchoes,
) -> Result<ck_wire::FlatProjection, HandlerOutcome> {
    prepare_cut_input(store, reference, window, codec, parsed, echoes, None)
}

pub(super) fn prepare_cut_input(
    store: &McStore,
    reference: &str,
    window: InputWindow,
    codec: codec::Codec,
    parsed: &mut TransformRequest,
    echoes: &reminder_echoes::ReminderEchoes,
    prelude: Option<&cut_seed::HistorianPrelude>,
) -> Result<ck_wire::FlatProjection, HandlerOutcome> {
    let live_from = prelude
        .and_then(|p| p.messages.last())
        .map_or(0, |m| m.ordinal.saturating_add(1));
    let rows = match window.through {
        Some(through) => store
            .load_async_compaction_entries_range(reference, window.from.max(live_from), through)
            .map_err(transient)?,
        None => Vec::new(),
    };
    #[cfg(test)]
    DECODED_ROWS.with(|count| count.set(count.get() + rows.len()));
    let mut messages = prelude
        .into_iter()
        .flat_map(|p| &p.messages)
        .filter(|m| {
            m.ordinal >= window.from && window.through.is_some_and(|through| m.ordinal <= through)
        })
        .cloned()
        .collect::<Vec<_>>();
    messages.extend(
        rows.into_iter()
            .map(|(_, raw)| HeldEntry::from_stored(raw)?.inbound())
            .collect::<Result<Vec<_>, _>>()?,
    );
    echoes.prepare_with(codec, parsed, &messages, true, |parsed, messages| {
        codec.prepare_request(parsed, messages)?;
        if codec == codec::Codec::Pi {
            let ordinals = (0..messages.len())
                .map(|index| window.ordinal_base.saturating_add(index as u64 + 1))
                .collect::<Vec<_>>();
            parsed.messages =
                super::super::codec_pi::decode_messages_with_ordinals(messages, &ordinals)?
                    .messages;
        }
        Ok(())
    })?;
    ck_wire::project_messages(&parsed.messages).map_err(transient)
}

#[cfg(test)]
thread_local! {
    pub(super) static DECODED_ROWS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boundary::{BoundaryContext, TriggerContext, TriggerDecision, TriggerReason};
    use crate::historian_chunk::{
        assemble_provider_historian_firing, AssembleHistorianFiringOutcome,
        HistorianAssemblerConfig,
    };
    use crate::test_support::FixtureBuilder;

    fn request() -> TransformRequest {
        decode(&json!({
            "v":2,"kind":"compaction.async","serializer_profile":"claude-code:anthropic",
            "session_id":"tail-oracle","model_key":"fixture","render_config":"fixture",
            "messages":[],"tool_present":false,"auto_search_enabled":false
        }))
        .unwrap()
    }

    fn text(n: u64, role: &str, content: String) -> ReadMessage {
        ReadMessage::new(n, format!("m{n}"), json!({"role":role,"content":content}))
    }

    fn native_entries(codec: codec::Codec, entries: &mut [ReadMessage]) {
        for entry in entries {
            let role = entry.message["role"].as_str().unwrap().to_owned();
            let blocks = if let Some(text) = entry.message["content"].as_str() {
                vec![json!({"type":"text","text":text})]
            } else {
                entry.message["content"].as_array().unwrap().clone()
            };
            entry.message = match codec {
                codec::Codec::AnthropicMessages => entry.message.clone(),
                codec::Codec::OwnedBroca => {
                    let has_result = blocks.iter().any(|b| b["type"] == "tool_result");
                    let content = blocks.into_iter().map(|b| match b["type"].as_str().unwrap() {
                        "tool_use" => json!({"type":"tool_call","tool_call_id":b["id"],"tool_name":b["name"],"input":b["input"]}),
                        "tool_result" => json!({"type":"tool_result","tool_call_id":b["tool_use_id"],"output":{"kind":"text","text":b["content"]},"is_error":false}),
                        _ => b,
                    }).collect::<Vec<_>>();
                    json!({"role":if has_result {"tool"} else {&role},"content":content})
                }
                codec::Codec::Pi => {
                    let result = blocks.iter().find(|b| b["type"] == "tool_result");
                    let body = if let Some(result) = result {
                        json!({"role":"toolResult","toolCallId":result["tool_use_id"],"toolName":"read","content":[{"type":"text","text":result["content"]}],"isError":false})
                    } else {
                        let content = blocks.into_iter().map(|b| if b["type"] == "tool_use" {
                            json!({"type":"toolCall","id":b["id"],"name":b["name"],"arguments":b["input"]})
                        } else {b}).collect::<Vec<_>>();
                        json!({"role":role,"content":content})
                    };
                    json!({"type":"message","id":entry.mid,"timestamp":"2026-01-01T00:00:00Z","message":body})
                }
                codec::Codec::OpencodeAiSdk => {
                    json!({"info":{"id":entry.mid,"role":role},"parts":blocks})
                }
            };
        }
    }

    fn save(store: &McStore, entries: &[ReadMessage], codec: codec::Codec) -> InputIndex {
        let mut index = InputIndex::default();
        let mut write = store.async_compaction_save("tail-ref", "key", "session", "{}");
        for entry in entries {
            let held = HeldEntry::from_read(entry).unwrap();
            index.add(&decoded_entry(codec, &held.inbound().unwrap()).unwrap());
            write.append_entry(entry.ordinal, held.raw().into(), "[]".into());
        }
        write.commit().unwrap();
        index
    }

    // This oracle reads all stored rows and uses the unbounded boundary check,
    // independently of the production suffix selection/index.
    fn full_input(
        store: &McStore,
        codec: codec::Codec,
    ) -> (TransformRequest, ck_wire::FlatProjection) {
        let messages = store
            .load_async_compaction_entries("tail-ref", i64::MAX as u64)
            .unwrap()
            .into_iter()
            .map(|(_, raw)| HeldEntry::from_stored(raw).unwrap().inbound().unwrap())
            .collect::<Vec<_>>();
        let mut parsed = request();
        reminder_echoes::ReminderEchoes::default()
            .prepare(codec, &mut parsed, &messages, true)
            .unwrap();
        let projection = ck_wire::project_messages(&parsed.messages).unwrap();
        (parsed, projection)
    }

    fn evaluate(
        parsed: &TransformRequest,
        projection: &ck_wire::FlatProjection,
        ctx: &TriggerContext,
        bounded: bool,
    ) -> TriggerDecision {
        let messages = boundary_messages(
            parsed,
            projection,
            &Mutex::new(BoundaryTokenCache::new(16_000_000)),
        )
        .messages;
        let mut estimate = |s: &str| mc_tokenizer::estimate_tokens(s);
        if bounded {
            boundary::check_compartment_trigger_tail_with_token_estimator(
                &messages,
                ctx,
                &mut estimate,
            )
        } else {
            boundary::check_compartment_trigger_with_token_estimator(&messages, ctx, &mut estimate)
        }
    }

    fn firing_bytes(
        store: &McStore,
        parsed: &TransformRequest,
        projection: &ck_wire::FlatProjection,
        decision: &TriggerDecision,
    ) -> Value {
        let Some(boundary) = decision.boundary.clone() else {
            return Value::Null;
        };
        let outcome = assemble_provider_historian_firing(
            store,
            &parsed.messages,
            &projection.blocks,
            &projection.identity_by_mid,
            HistorianAssemblerConfig {
                expand_tools: BTreeMap::new(),
                session_id: parsed.session_id.clone(),
                project_path: "/proj".into(),
                project_slug: "proj".into(),
                model_chain: vec!["fixture".into()],
                model_limits: Default::default(),
                model_variants: Default::default(),
                token_budget: 8_000,
                historian_context_limit_tokens: None,
                max_output_tokens: 32_000,
                boundary,
                memory_enabled: false,
                auto_promote: false,
                user_memory_collection_enabled: false,
                user_observations_requested: false,
                extraction_free: false,
                in_emergency: false,
                force_keep_last_compartment: false,
                fold_is_only_reclaim: true,
                failure_backoff_at_ms: 100,
                min_chunk_tokens: 0,
            },
            1,
        )
        .unwrap();
        match outcome {
            AssembleHistorianFiringOutcome::NoFire(reason) => {
                json!({"no_fire":format!("{reason:?}")})
            }
            AssembleHistorianFiringOutcome::Fire(firing) => {
                let request = firing.as_fire_request(
                    store,
                    &parsed.session_id,
                    "/proj",
                    "runner",
                    "proj",
                    None,
                    false,
                );
                json!({"system":request.system,"prompt":request.prompt,"raw_chunk_messages":request.raw_chunk_messages,
                    "range":[firing.chunk.chunk.start_index,firing.chunk.chunk.end_index,firing.chunk.chunk.end_index.saturating_add(1)],
                    "fingerprint":request.chunk_fingerprint,"identities":request.selected_range_identities})
            }
        }
    }

    #[test]
    fn historian_tail_randomized_differential() {
        let mut reasons = BTreeSet::new();
        let mut fired = 0;
        let mut pending = 0;
        let mut no_compartments = 0;
        for seed in 0..80u64 {
            let codec = codec::Codec::ALL[seed as usize % 4];
            let fixture = FixtureBuilder::store();
            let store = &fixture.store;
            let mut rng = seed + 1;
            let mut next = || {
                rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
                rng >> 32
            };
            let count = 240 + next() % 40;
            let cut = count - 70 - next() % 30;
            let mut entries = (0..count)
                .map(|n| {
                    let role = if n % 2 == 0 { "user" } else { "assistant" };
                    let commit = if role == "assistant" {
                        " committed abc1234 and def5678 "
                    } else {
                        " investigate "
                    };
                    text(
                        n,
                        role,
                        format!(
                            "turn {n} {commit}{}",
                            "source context for the next change. "
                                .repeat((next() % 45 + 12) as usize)
                        ),
                    )
                })
                .collect::<Vec<_>>();
            // A call at the covered boundary pairs with a result after it;
            // the result is in a user message that also contains text, matching
            // Anthropic's mixed-content message shape.
            if seed % 3 == 0 && codec != codec::Codec::OpencodeAiSdk {
                entries[cut as usize] = ReadMessage::new(
                    cut,
                    format!("m{cut}"),
                    json!({"role":"assistant","content":[
                        {"type":"tool_use","id":"crossing","name":"read","input":{"path":"src/main.rs"}}
                    ]}),
                );
                entries[cut as usize + 1] = ReadMessage::new(
                    cut + 1,
                    format!("m{}", cut + 1),
                    json!({"role":"user","content":[
                        {"type":"tool_result","tool_use_id":"crossing","content":"tool output"},
                        {"type":"text","text":"please continue investigating"}
                    ]}),
                );
            }
            native_entries(codec, &mut entries);
            if codec == codec::Codec::Pi {
                let message = &mut entries[cut as usize + 4].message["message"];
                message["role"] = json!("assistant");
                message["content"].as_array_mut().unwrap().push(
                    json!({"type":"toolCall","name":"read","arguments":{"path":"no-native-id"}}),
                );
            }
            let index = save(store, &entries, codec);
            let applied = if seed % 7 == 0 {
                no_compartments += 1;
                None
            } else {
                Some(if seed % 11 == 0 { 0 } else { cut })
            };
            if let Some(cut) = applied {
                let end = if seed % 5 == 0 {
                    pending += 1;
                    cut + 8
                } else {
                    cut
                };
                store
                    .replace_compartments(
                        "tail-oracle",
                        &[mc_store::StoredCompartment {
                            sequence: 1,
                            start_message: 0,
                            end_message: end as i64,
                            start_message_id: "m0#0".into(),
                            end_message_id: format!("m{end}#0"),
                            title: "prior history".into(),
                            content: "completed summary".into(),
                            p1: Some("completed summary".into()),
                            ..Default::default()
                        }],
                    )
                    .unwrap();
            }
            let mut meta = store.load_meta("tail-oracle").unwrap();
            meta.meta.coverage_ordinal = applied;
            store
                .commit_meta("tail-oracle", meta.row_version, &meta.meta)
                .unwrap();
            let (captured, window) = applied_window(store, "tail-oracle", &index).unwrap();
            assert_eq!(captured, applied);
            let (full, full_projection) = full_input(store, codec);
            let mut tail = request();
            let projection = prepare_input(
                store,
                "tail-ref",
                window.through(Some(count - 1)),
                codec,
                &mut tail,
                &Default::default(),
            )
            .unwrap();
            assert_eq!(
                serde_json::to_vec(&tail.messages).unwrap(),
                serde_json::to_vec(
                    &full
                        .messages
                        .iter()
                        .filter(|m| m.ordinal >= window.from)
                        .collect::<Vec<_>>()
                )
                .unwrap(),
                "CK bytes seed {seed} {codec:?}"
            );
            let pressure = [10.0, 65.0, 80.0, 96.0][(seed as usize / 4) % 4];
            let ctx = TriggerContext {
                boundary: BoundaryContext {
                    context_limit: 32_000.0,
                    execute_threshold_percentage: 65.0,
                    usage_percentage: pressure,
                    usage_input_tokens: pressure * 320.0,
                    last_compartment_end_ordinal: applied,
                    prior_boundary_ordinal: applied.unwrap_or(0),
                    migration_floor_active: applied.is_some(),
                    fold_is_only_reclaim: seed % 2 == 0,
                    trigger_budget: Some(800.0),
                    calibration: Some(crate::decision_calibration::DecisionCalibration::neutral()),
                    ..Default::default()
                },
                commit_cluster_trigger_enabled: true,
                min_commit_clusters: 2,
                reclaim_ride_available: false,
                projected_post_drop_percentage: Some(0.0),
                ..Default::default()
            };
            let expected = evaluate(&full, &full_projection, &ctx, false);
            let actual = evaluate(&tail, &projection, &ctx, true);
            assert_eq!(
                (actual.fire, actual.reason, actual.no_fire_cause),
                (expected.fire, expected.reason, expected.no_fire_cause),
                "seed {seed}"
            );
            let range = |d: &TriggerDecision| {
                d.boundary
                    .as_ref()
                    .map(|b| (b.eligible_head.clone(), b.protected_start_ordinal))
            };
            assert_eq!(range(&actual), range(&expected), "seed {seed}");
            assert_eq!(
                firing_bytes(store, &tail, &projection, &actual),
                firing_bytes(store, &full, &full_projection, &expected),
                "request bytes seed {seed}"
            );
            if let Some(reason) = actual.reason {
                reasons.insert(reason.as_str());
            }
            fired += usize::from(actual.fire);
        }
        assert!(fired > 0 && pending > 0 && no_compartments > 0);
        assert!(
            reasons.contains(TriggerReason::CommitClusters.as_str()),
            "{reasons:?}"
        );
        assert!(
            reasons.contains(TriggerReason::ForceBand.as_str()),
            "{reasons:?}"
        );
    }

    #[test]
    fn historian_tail_bounded_work() {
        for size in [500, 5_000] {
            let fixture = FixtureBuilder::store();
            let entries = (0..size)
                .map(|n| {
                    text(
                        n,
                        if n % 2 == 0 { "user" } else { "assistant" },
                        "short source text".into(),
                    )
                })
                .collect::<Vec<_>>();
            let index = save(&fixture.store, &entries, codec::Codec::AnthropicMessages);
            let applied = Some(size - 25);
            DECODED_ROWS.with(|c| c.set(0));
            boundary::TOKEN_INDEX_ROWS.with(|c| c.set(0));
            let mut parsed = request();
            let projection = prepare_input(
                &fixture.store,
                "tail-ref",
                index.window(applied).through(Some(size - 1)),
                codec::Codec::AnthropicMessages,
                &mut parsed,
                &Default::default(),
            )
            .unwrap();
            evaluate(
                &parsed,
                &projection,
                &TriggerContext {
                    boundary: BoundaryContext {
                        last_compartment_end_ordinal: applied,
                        ..Default::default()
                    },
                    ..Default::default()
                },
                true,
            );
            assert!(
                DECODED_ROWS.with(|c| c.get()) <= 26,
                "decoded rows must track the tail"
            );
            assert!(
                boundary::TOKEN_INDEX_ROWS.with(|c| c.get()) <= 26,
                "token index must track the tail"
            );
        }
    }
}
