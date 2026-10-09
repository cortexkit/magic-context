//! Barrier-driven historian evaluation over the provider's durable ingest log.
use super::*;

/// Only scalar/model policy accompanies a pass. Transcript bytes come exclusively
/// from the message log; a host cannot substitute a second history for the trigger.
pub(super) fn checked_inputs(value: &Value) -> Result<Value, HandlerOutcome> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid_field("provider_pass.historian_inputs", "expected an object"))?;
    let mut inputs = json!({});
    for name in [
        "usage",
        "geometry",
        "effective_execute_threshold",
        "historian_model_limits",
        "historian_model_variants",
        "historian_max_output_tokens",
        "historian_timeout_ms",
        "emergency_recovery_armed",
        "reclaim_ride_available",
    ] {
        if let Some(value) = object.get(name) {
            inputs[name] = value.clone();
        }
    }
    let mut request = inputs.clone();
    request["v"] = json!(2);
    request["session_id"] = json!("provider-input-validation");
    request["render_config"] = json!("provider-policy");
    request["serializer_profile"] = json!("opencode-aisdk");
    request["messages"] = json!([]);
    let _: TransformRequest = decode(&request)?;
    if inputs
        .get("reclaim_ride_available")
        .is_some_and(|v| !v.is_boolean())
    {
        return Err(invalid_field(
            "provider_pass.historian_inputs.reclaim_ride_available",
            "expected a boolean",
        ));
    }
    Ok(inputs)
}

pub(super) fn record_barrier(counters: &mut Value) {
    counters["historian_barrier_generation"] = json!(counters
        .get("historian_barrier_generation")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .saturating_add(1));
}

struct LogPublicationFence {
    key: Key,
    lineage: String,
    serial: Arc<ProviderSerial>,
}

pub(crate) struct RunCompletion {
    key: Key,
    generation: u64,
}

impl RunCompletion {
    pub(crate) fn record(
        self,
        store: &McStore,
        session: &str,
        result: &Result<
            crate::historian::HistorianDriveOutcome,
            crate::historian::HistorianDriveError,
        >,
    ) {
        // If admission prevents publishing a completed report, the existing
        // driver returns to Idle without a model-failure backoff. Mark the next
        // completed pass retryable even if its user/tool counts are unchanged.
        // Do not acquire the admission lock: its owner may be waiting for this
        // firing task to return before releasing it.
        let recorded = store.load_meta(session).and_then(|loaded| {
            let retry = result.is_err()
                && loaded.meta.historian.state == HistorianPhase::Idle
                && loaded
                    .meta
                    .historian
                    .failure_backoff_at_ms
                    .is_none_or(|at| at <= now_ms());
            store.finish_provider_historian_run(
                &self.key.store_key(),
                session,
                self.generation,
                retry,
            )
        });
        if let Err(error) = recorded {
            // historian_launch_pending records a prepared fire whose completion
            // has not been acknowledged. Retaining it keeps the next completed
            // pass retryable if this result transaction fails.
            tracing::warn!(
                session,
                ?error,
                "provider historian result could not be recorded"
            );
        }
    }
}

enum EvaluationOutcome {
    Fire,
    Busy,
    Complete { recovering: bool },
}

impl EvaluationOutcome {
    fn of(action: &PreparedHistorianAction) -> Self {
        match action {
            PreparedHistorianAction::FireReady(_) => Self::Fire,
            PreparedHistorianAction::Busy { .. } => Self::Busy,
            PreparedHistorianAction::Complete(d) => Self::Complete {
                recovering: matches!(d.no_fire.as_deref(), Some("recovering" | "reattaching")),
            },
        }
    }
}

impl crate::historian::HistorianPublicationFence for LogPublicationFence {
    fn publish(
        &self,
        store: &McStore,
        request: mc_store::HistorianPublishRequest<'_>,
    ) -> Result<mc_store::HistorianPublishResult, mc_store::HistorianPublishError> {
        use mc_store::HistorianPublishError;
        let reject = |reason: &str| HistorianPublishError::FenceRejected {
            reason: reason.into(),
        };
        // Hold the provider conversation lock across both the lineage check and
        // publication CAS, so a hook or state sync cannot revert the source
        // between them. Contention rejects the publication as a local race;
        // the existing lifecycle releases the run without a model cooldown.
        let _serial = self
            .serial
            .try_lock_for(&self.key)
            .map_err(|_| reject("provider admission in progress"))?;
        let c = store
            .load_provider_conversation(&self.key.store_key())?
            .ok_or_else(|| reject("provider conversation removed"))?;
        let mut lineage = c.lineage_id;
        let mut cut = u64::MAX;
        let mut seen = BTreeSet::new();
        while lineage != self.lineage {
            if !seen.insert(lineage.clone()) {
                return Err(reject("provider ancestry cycle"));
            }
            let row = store
                .load_provider_lineage(&self.key.store_key(), &lineage)?
                .ok_or_else(|| reject("provider ancestry missing"))?;
            cut = cut.min(
                row.through_ordinal
                    .ok_or_else(|| reject("provider lineage replaced"))?,
            );
            lineage = row
                .descends_from
                .ok_or_else(|| reject("provider lineage replaced"))?;
        }
        // The publication floor is the first unprocessed ordinal, one past the
        // selected inclusive range. A cut retaining its last message is valid.
        if cut < request.publication_floor_ordinal.saturating_sub(1) {
            return Err(reject("provider selected range reverted"));
        }
        store.publish_historian_chunk(request)
    }
}

impl McHandler {
    /// Share the single-flight historian claims, host claim ledger, model
    /// refusals, configuration and token estimates with the request handler.
    /// The worker has its own store-open coordinator: dropping this auxiliary
    /// handler shuts down only that coordinator, never the request handler's.
    fn provider_historian_worker(&self) -> Arc<Self> {
        Arc::clone(self.provider_historian_worker.get_or_init(|| {
            let mut worker = Self::new();
            worker.store = Arc::clone(&self.store);
            worker.provider_store = Arc::clone(&self.provider_store);
            worker.provider_serial = Arc::clone(&self.provider_serial);
            worker.producer_factory = Arc::clone(&self.producer_factory);
            worker.session_resolver = Arc::clone(&self.session_resolver);
            worker.config = Arc::clone(&self.config);
            worker.boundary_tokens = Arc::clone(&self.boundary_tokens);
            worker.historian_runner_refusals = Arc::clone(&self.historian_runner_refusals);
            worker.host_runs = Arc::clone(&self.host_runs);
            worker.runner_choices = Arc::clone(&self.runner_choices);
            worker.project_identities = Arc::clone(&self.project_identities);
            worker.memory_paused_routes = Arc::clone(&self.memory_paused_routes);
            worker.reattaching_sessions = Arc::clone(&self.reattaching_sessions);
            worker.live_historian_sessions = Arc::clone(&self.live_historian_sessions);
            worker.transform_snapshots = Arc::clone(&self.transform_snapshots);
            worker.connect_failure_commit_hook = Arc::clone(&self.connect_failure_commit_hook);
            #[cfg(test)]
            {
                worker.fixed_config = self.fixed_config.clone();
            }
            Arc::new(worker)
        }))
    }

    pub(crate) fn schedule_provider_historian(&self, binding: SessionBinding, key: Key) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let worker = self.provider_historian_worker();
        runtime.spawn(async move {
            match worker.prepare_provider_historian(&binding, &key).await {
                Ok(Some(PreparedHistorianAction::FireReady(prepared))) => {
                    worker.spawn_historian_firing(prepared.task);
                }
                Ok(_) => {}
                Err(error) => {
                    worker.retry_provider_historian(&key).await;
                    tracing::warn!(session=%key.session, ?error, "provider historian evaluation failed");
                }
            }
        });
    }

    async fn retry_provider_historian(&self, key: &Key) {
        let Some(store) = self.store.get() else {
            return;
        };
        let _serial = self.provider_serial.lock_for(key).await;
        if let Ok(Some(mut c)) = store.load_provider_conversation(&key.store_key()) {
            if let Ok(mut counters) = serde_json::from_str::<Value>(&c.hook_counters_json) {
                counters["historian_evaluation_due"] = json!(true);
                c.hook_counters_json = counters.to_string();
                let _ = store.save_provider_conversation(&key.store_key(), &c);
            }
        }
    }

    async fn finish_provider_evaluation(
        &self,
        key: &Key,
        generation: u64,
        cadence: Value,
        outcome: EvaluationOutcome,
    ) -> Result<(), HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let _serial = self.provider_serial.lock_for(key).await;
        let Some(mut c) = store
            .load_provider_conversation(&key.store_key())
            .map_err(transient)?
        else {
            return Ok(());
        };
        let mut counters: Value = serde_json::from_str(&c.hook_counters_json).map_err(transient)?;
        if counters["historian_barrier_generation"].as_u64() != Some(generation) {
            return Ok(());
        }
        // The decision is durable before cadence is consumed. A prepared fire
        // still needs a durable run; keep its launch intent across a crash in
        // the gap between returning FireReady and starting the firing task.
        counters["historian_cadence"] = cadence;
        counters["historian_run_retry_due"] = json!(false);
        match outcome {
            EvaluationOutcome::Fire => {
                counters["historian_evaluation_due"] = json!(false);
                counters["historian_launch_pending"] = json!({"generation":generation});
            }
            EvaluationOutcome::Busy => {}
            EvaluationOutcome::Complete { recovering } => {
                counters["historian_evaluation_due"] = json!(recovering);
                if !recovering {
                    counters["historian_launch_pending"] = Value::Null;
                }
            }
        }
        c.hook_counters_json = counters.to_string();
        store
            .save_provider_conversation(&key.store_key(), &c)
            .map_err(transient)
    }

    async fn prepare_provider_historian(
        &self,
        binding: &SessionBinding,
        key: &Key,
    ) -> Result<Option<PreparedHistorianAction>, HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let serial = self.provider_serial.lock_for(key).await;
        let Some(mut conversation) = store
            .load_provider_conversation(&key.store_key())
            .map_err(transient)?
        else {
            return Ok(None);
        };
        let plan: Value = serde_json::from_str(&conversation.params_json).map_err(transient)?;
        if !answer_observation(&plan)
            || matches!(
                conversation.preset.as_deref(),
                Some("worker" | "subagent" | "reader")
            )
        {
            return Ok(None);
        }
        let mut counters: Value =
            serde_json::from_str(&conversation.hook_counters_json).map_err(transient)?;
        let barrier = &counters["pass_complete"];
        if barrier.get("lineage_id").and_then(Value::as_str) != Some(&conversation.lineage_id) {
            return Ok(None);
        }
        let Some(through) = barrier.get("through_ordinal").and_then(Value::as_u64) else {
            return Ok(None);
        };
        let generation = counters["historian_barrier_generation"]
            .as_u64()
            .unwrap_or(0);
        if counters["historian_evaluated_barrier"].as_u64() == Some(generation) {
            return Ok(None);
        }
        let barrier = barrier.clone();
        drop(serial);
        let held = store
            .load_provider_messages(&key.store_key(), &conversation.lineage_id)
            .map_err(transient)?;
        // pass_complete marks the final ingested ordinal. Require every
        // ordinal through it and reject messages beyond it. If a hook failed,
        // evaluation stays deferred until a later complete pass fills the gap.
        if held.last().is_some_and(|m| m.ordinal != through)
            || (!held.is_empty()
                && store
                    .provider_frontier(&key.store_key(), &conversation.lineage_id)
                    .map_err(transient)?
                    != through.saturating_add(1))
        {
            return Ok(None);
        }
        let entries = held
            .into_iter()
            .map(|m| {
                Ok(compact::status::StatusMessage {
                    mid: m.mid,
                    ordinal: m.ordinal,
                    message: serde_json::from_slice(&m.message_bytes).map_err(transient)?,
                })
            })
            .collect::<Result<Vec<_>, HandlerOutcome>>()?;
        let decoded = codec_opencode::decode_messages(&entries)?;
        let user = decoded
            .messages
            .iter()
            .rev()
            .find(|m| m.ck.role == "user" && !m.ck.meta.synthetic)
            .map(|m| json!([m.mid, m.ordinal]))
            .unwrap_or(Value::Null);
        let tools = decoded
            .messages
            .iter()
            .filter(|m| !m.ck.meta.synthetic)
            .flat_map(|m| &m.ck.content)
            .filter(|b| matches!(b.kind, mc_store::CkKind::ToolResult { .. }))
            .count() as u64;
        let meta = store
            .load_meta(&conversation.engine_namespace)
            .map_err(transient)?;
        let recovering = meta.meta.historian.state != HistorianPhase::Idle
            && self
                .live_historian_completion_wait(&conversation.engine_namespace)
                .is_none();
        let serial = self.provider_serial.lock_for(key).await;
        let Some(current) = store
            .load_provider_conversation(&key.store_key())
            .map_err(transient)?
        else {
            return Ok(None);
        };
        let current_counters: Value =
            serde_json::from_str(&current.hook_counters_json).map_err(transient)?;
        // Read and decode the log without holding the conversation lock.
        // Changes to the lineage, synchronized chain or pass-complete marker
        // invalidate this snapshot; another evaluator may also have consumed it.
        if current.lineage_id != conversation.lineage_id
            || current.historian_model_chain_json != conversation.historian_model_chain_json
            || current_counters["pass_complete"] != barrier
            || current_counters["historian_barrier_generation"]
                .as_u64()
                .unwrap_or(0)
                != generation
            || current_counters["historian_evaluated_barrier"].as_u64() == Some(generation)
        {
            return Ok(None);
        }
        conversation = current;
        counters = current_counters;
        let cadence = &counters["historian_cadence"];
        let due = counters["historian_evaluation_due"].as_bool() == Some(true)
            || counters["historian_run_retry_due"].as_bool() == Some(true)
            || counters["historian_launch_pending"].is_object()
            || cadence.is_null()
            || cadence["lineage"].as_str() != Some(&conversation.lineage_id)
            || cadence["user"] != user
            || tools >= cadence["tools"].as_u64().unwrap_or(0).saturating_add(25)
            || recovering;
        counters["historian_evaluated_barrier"] = json!(generation);
        if !due {
            conversation.hook_counters_json = counters.to_string();
            store
                .save_provider_conversation(&key.store_key(), &conversation)
                .map_err(transient)?;
            return Ok(None);
        }
        let mut request = counters
            .get("historian_inputs")
            .filter(|v| v.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        let reclaim_ride_available = request
            .get("reclaim_ride_available")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        request["v"] = json!(2);
        request["session_id"] = json!(conversation.engine_namespace);
        request["render_config"] = json!("provider-policy");
        request["serializer_profile"] = json!("opencode-aisdk");
        request["model_key"] = counters
            .pointer("/pass_context/model_key")
            .cloned()
            .unwrap_or_else(|| json!(binding.model_key));
        request["historian_model_chain"] =
            serde_json::from_str(&conversation.historian_model_chain_json).map_err(transient)?;
        request["messages"] = json!([]);
        let mut parsed: TransformRequest = decode(&request)?;
        // Use the codec's in-memory conversation blocks, as the compaction
        // engine does. Serializing and reparsing them loses retained native
        // block representation, changing the content fingerprints used by CAS.
        parsed.messages = decoded.messages;
        // Claim this barrier for this process, but leave a durable retry marker
        // until the trigger decision and any required launch intent are stored.
        counters["historian_evaluation_due"] = json!(true);
        conversation.hook_counters_json = counters.to_string();
        store
            .save_provider_conversation(&key.store_key(), &conversation)
            .map_err(transient)?;
        // Tokenization, trigger rules, assembly and run driving are never under
        // the conversation lock: a slow historian must not queue a later hook.
        drop(serial);
        #[cfg(test)]
        {
            let gate = self
                .provider_historian_gate
                .lock()
                .expect("historian gate mutex")
                .take();
            if let Some((entered, release)) = gate {
                entered.notify_one();
                release.notified().await;
            }
        }
        let projection = ck_wire::project_messages(&parsed.messages).map_err(transient)?;
        let mut timings = HistorianTriggerTimings::default();
        let mut action = self.prepare_historian_fire(
            Arc::clone(store),
            &parsed,
            binding,
            &binding.project_root.to_string_lossy(),
            &projection,
            HistorianPrepareContext {
                now: now_ms(),
                snapshot_generation: None,
                publication_fence: Some(Arc::new(LogPublicationFence {
                    key: key.clone(),
                    lineage: conversation.lineage_id.clone(),
                    serial: Arc::clone(&self.provider_serial),
                })),
                tag_snapshot: None,
                reclaim_ride_available,
                timings: &mut timings,
            },
        );
        if let PreparedHistorianAction::FireReady(prepared) = &mut action {
            prepared.task.provider_completion = Some(RunCompletion {
                key: key.clone(),
                generation,
            });
            // Persist content fingerprints only for messages this chunk selects.
            // Previously compacted messages are not source for this publication;
            // writing their fingerprints could conflict with a stored rendering.
            let identities = prepared
                .task
                .firing
                .selected_range_identities
                .iter()
                .map(|selected| (selected.mid.clone(), selected.block_identities.clone()))
                .collect();
            let _serial = self.provider_serial.lock_for(key).await;
            store
                .upsert_provider_block_identities(
                    &key.store_key(),
                    &conversation.lineage_id,
                    &identities,
                )
                .map_err(transient)?;
        }
        self.finish_provider_evaluation(
            key,
            generation,
            json!({"user":user,"tools":tools,"lineage":conversation.lineage_id}),
            EvaluationOutcome::of(&action),
        )
        .await?;
        Ok(Some(action))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn prepared_but_unlaunched_fire_retries_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        declare(&h).await;
        let entries = corpus();
        let inputs =
            json!({"usage":{"current_total_input_tokens":45000,"context_limit_tokens":50000}});
        review_sync(&h, &entries, inputs.clone());
        let action = h
            .provider_historian_worker()
            .prepare_provider_historian(&binding(&h), &key(&h))
            .await
            .unwrap();
        assert!(matches!(
            action,
            Some(PreparedHistorianAction::FireReady(_))
        ));
        drop(action);
        drop(h);
        let restarted = handler(dir.path());
        review_sync(&restarted, &[], inputs);
        let action = restarted
            .provider_historian_worker()
            .prepare_provider_historian(&binding(&restarted), &key(&restarted))
            .await
            .unwrap();
        assert!(
            matches!(action, Some(PreparedHistorianAction::FireReady(_))),
            "a persisted decision alone is not a launched run"
        );
    }

    #[tokio::test]
    async fn old_run_completion_preserves_newer_launch_and_sync_inputs() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        declare(&h).await;
        let store = h.store.get().unwrap();
        let k = key(&h).store_key();
        let mut c = store.load_provider_conversation(&k).unwrap().unwrap();
        c.hook_counters_json = json!({"historian_launch_pending":{"generation":2},"historian_evaluation_due":true,"historian_inputs":{"usage":{"current_total_input_tokens":123}}}).to_string();
        store.save_provider_conversation(&k, &c).unwrap();
        store
            .finish_provider_historian_run(&k, "s", 1, false)
            .unwrap();
        assert_eq!(
            store
                .load_provider_conversation(&k)
                .unwrap()
                .unwrap()
                .hook_counters_json,
            c.hook_counters_json
        );
        store
            .finish_provider_historian_run(&k, "s", 2, true)
            .unwrap();
        let counters: Value = serde_json::from_str(
            &store
                .load_provider_conversation(&k)
                .unwrap()
                .unwrap()
                .hook_counters_json,
        )
        .unwrap();
        assert_eq!(counters["historian_evaluation_due"], true);
        assert_eq!(counters["historian_run_retry_due"], true);
        assert_eq!(
            counters.pointer("/historian_inputs/usage/current_total_input_tokens"),
            Some(&json!(123))
        );
    }

    include!("m5_review_tests.rs");

    fn handler(path: &Path) -> McHandler {
        let mut h = McHandler::new();
        h.fixed_config = Some(McModuleConfig {
            inject_docs: false,
            memory_enabled: false,
            historian_runner: Some(HistorianRunnerKind::Host),
            ..Default::default()
        });
        h.store
            .set(Arc::new(
                McStore::open_for_test(&dev_descriptor_at(path.to_str().unwrap())).unwrap(),
            ))
            .ok()
            .unwrap();
        h.bind_route(
            7,
            SessionBinding {
                project_root: path.into(),
                harness: "opencode".into(),
                session: "s".into(),
                model_key: None,
                config: h.fixed_config.clone().unwrap(),
                history_budget_tokens: 4000.0,
            },
        );
        h
    }
    fn binding(h: &McHandler) -> SessionBinding {
        h.facade_binding(7).unwrap()
    }
    fn key(h: &McHandler) -> Key {
        Key::new(&binding(h), "s", "opencode").unwrap()
    }
    fn response(outcome: HandlerOutcome) -> Value {
        match outcome {
            HandlerOutcome::Response(bytes) => serde_json::from_slice(&bytes).unwrap(),
            other => panic!("{other:?}"),
        }
    }
    async fn declare(h: &McHandler) {
        response(
            h.handle_provider_value(
                7,
                "transform.declare",
                &json!({"params":{"serializer_profile":"opencode-aisdk","observation":"answer"}}),
            )
            .await,
        );
    }
    fn text(ordinal: u64, role: &str, words: usize) -> compact::status::StatusMessage {
        let mid = format!("m{ordinal}");
        compact::status::StatusMessage {
            mid: mid.clone(),
            ordinal,
            message: json!({"info":{"id":mid,"role":role,"time":{"created":ordinal*1000}},"parts":[{"id":format!("p{ordinal}"),"type":"text","text":format!("message {ordinal} {}", "word ".repeat(words))}]}),
        }
    }
    fn corpus() -> Vec<compact::status::StatusMessage> {
        (1..=80)
            .map(|n| text(n, if n % 2 == 1 { "user" } else { "assistant" }, 800))
            .collect()
    }
    fn sync(
        h: &McHandler,
        appended: &[compact::status::StatusMessage],
        chain: &[String],
        complete: bool,
        inputs: Value,
    ) {
        let pass = json!({"lineage_id":"L","pass_id":format!("{}-{complete}",appended.last().map_or(0,|m|m.ordinal)),"appended":appended,"historian_inputs":inputs});
        h.sync_provider_pass_inputs(
            &binding(h),
            h.store.get().unwrap(),
            Some(chain),
            complete,
            Some(&pass),
        )
        .unwrap();
    }
    fn hook(entry: &compact::status::StatusMessage, complete: bool) -> Value {
        let mut params = json!({"session":"s","harness":"opencode","lineage_id":"L","subject_mid":entry.mid,"subject_ordinal":entry.ordinal,"message":entry.message,"hook":if entry.message["info"]["role"]=="user" {"pre_user"} else {"post_assistant"},"blocks":[entry.message["parts"][0]["text"]],"step_id":"step"});
        if complete {
            params["pass_complete"] = json!(true);
        }
        params
    }
    fn signature(
        action: &PreparedHistorianAction,
    ) -> (bool, Option<String>, Option<String>, Option<(u64, u64)>) {
        match action {
            PreparedHistorianAction::FireReady(p) => (
                true,
                p.diagnostics.reason.clone(),
                None,
                Some((p.task.firing.from_ordinal, p.task.firing.to_ordinal)),
            ),
            PreparedHistorianAction::Complete(d)
            | PreparedHistorianAction::Busy { diagnostics: d, .. } => {
                (false, d.reason.clone(), d.no_fire_detail.clone(), None)
            }
        }
    }
    fn oracle(
        h: &McHandler,
        entries: &[compact::status::StatusMessage],
        chain: &[String],
        inputs: Value,
    ) -> PreparedHistorianAction {
        let mut value = checked_inputs(&inputs).unwrap();
        value["v"] = json!(2);
        value["serializer_profile"] = json!("opencode-aisdk");
        value["session_id"] = json!("s");
        value["render_config"] = json!("provider-policy");
        value["messages"] = json!([]);
        value["historian_model_chain"] = json!(chain);
        let mut parsed: TransformRequest = decode(&value).unwrap();
        codec::Codec::OpencodeAiSdk
            .prepare_request(&mut parsed, entries)
            .unwrap();
        let projection = ck_wire::project_messages(&parsed.messages).unwrap();
        let mut timings = HistorianTriggerTimings::default();
        h.prepare_historian_fire(
            h.store.get().unwrap().clone(),
            &parsed,
            &binding(h),
            &binding(h).project_root.to_string_lossy(),
            &projection,
            HistorianPrepareContext {
                now: now_ms(),
                snapshot_generation: None,
                publication_fence: None,
                tag_snapshot: None,
                reclaim_ride_available: inputs["reclaim_ride_available"].as_bool().unwrap_or(false),
                timings: &mut timings,
            },
        )
    }

    #[tokio::test]
    async fn trigger_oracle_matches_complete_log_cause_chunk_and_protected_tail() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        declare(&h).await;
        let baseline_dir = tempfile::tempdir().unwrap();
        let baseline = handler(baseline_dir.path());
        let entries = corpus();
        let chain: Vec<String> = vec!["test/model".into()];
        let mut fires = 0;
        for (index, (length, usage, ride)) in [
            (2, 1000, false),
            (40, 20000, false),
            (60, 45000, false),
            (80, 45000, true),
        ]
        .into_iter()
        .enumerate()
        {
            let inputs = json!({"usage":{"current_total_input_tokens":usage,"context_limit_tokens":50000},"reclaim_ride_available":ride});
            let previous = [0, 2, 40, 60][index];
            sync(&h, &entries[previous..length], &chain, true, inputs.clone());
            let actual = h
                .provider_historian_worker()
                .prepare_provider_historian(&binding(&h), &key(&h))
                .await
                .unwrap()
                .expect("new user turn evaluated");
            let expected = oracle(&baseline, &entries[..length], &chain, inputs);
            assert_eq!(signature(&actual), signature(&expected), "pass {index}");
            if let PreparedHistorianAction::FireReady(p) = &actual {
                fires += 1;
                let protected_start = p
                    .diagnostics
                    .progress
                    .as_ref()
                    .unwrap()
                    .protected_start_ordinal;
                assert!(
                    p.task.firing.to_ordinal < protected_start,
                    "selected chunk must not include the protected tail"
                );
            }
        }
        assert!(fires > 0, "the corpus must exercise a real fire");
    }

    #[tokio::test]
    async fn state_sync_and_partial_hooks_wait_for_complete_ingest_and_stored_chain() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        declare(&h).await;
        let entries = corpus();
        let chain: Vec<String> = vec!["test/model".into()];
        sync(
            &h,
            &entries[..78],
            &chain,
            false,
            json!({"usage":{"current_total_input_tokens":45000,"context_limit_tokens":50000}}),
        );
        let worker = h.provider_historian_worker();
        assert!(worker
            .prepare_provider_historian(&binding(&h), &key(&h))
            .await
            .unwrap()
            .is_none());
        response(
            h.handle_provider_value(7, "transform.hook", &hook(&entries[78], false))
                .await,
        );
        assert!(worker
            .prepare_provider_historian(&binding(&h), &key(&h))
            .await
            .unwrap()
            .is_none());
        response(
            h.handle_provider_value(7, "transform.hook", &hook(entries.last().unwrap(), true))
                .await,
        );
        let prepared = worker
            .prepare_provider_historian(&binding(&h), &key(&h))
            .await
            .unwrap()
            .unwrap();
        let PreparedHistorianAction::FireReady(p) = prepared else {
            panic!("complete pass must fire");
        };
        assert_eq!(p.task.firing.model_chain, chain);
        assert!(p.task.firing.raw_chunk_messages.contains("m1"));
        assert_eq!(
            h.store
                .get()
                .unwrap()
                .load_provider_messages(&key(&h).store_key(), "L")
                .unwrap()
                .len(),
            entries.len()
        );
        assert!(
            worker
                .prepare_provider_historian(&binding(&h), &key(&h))
                .await
                .unwrap()
                .is_none(),
            "one evaluation per barrier"
        );
    }

    #[tokio::test]
    async fn empty_to_nonempty_chain_without_append_evaluates_once() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        declare(&h).await;
        let entries = corpus();
        let inputs =
            json!({"usage":{"current_total_input_tokens":45000,"context_limit_tokens":50000}});
        sync(&h, &entries, &[], true, inputs.clone());
        let worker = h.provider_historian_worker();
        let first = worker
            .prepare_provider_historian(&binding(&h), &key(&h))
            .await
            .unwrap()
            .unwrap();
        assert!(!signature(&first).0);
        assert!(signature(&first).2.unwrap().contains("no_models"));
        let chain: Vec<String> = vec!["test/model".into()];
        response(h.handle_state_sync_value(7,json!({"method":"state_sync","session_id":"s","historian_model_chain":chain,"pass_complete":true})));
        let next = worker
            .prepare_provider_historian(&binding(&h), &key(&h))
            .await
            .unwrap()
            .unwrap();
        assert!(
            signature(&next).0,
            "chain-only pass must not be lost to debounce"
        );
        assert!(worker
            .prepare_provider_historian(&binding(&h), &key(&h))
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn identity_upsert_is_idempotent_and_conflicting_batch_is_atomic() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        declare(&h).await;
        let entries = vec![text(1, "user", 10)];
        sync(&h, &entries, &[], false, json!({}));
        let store = h.store.get().unwrap();
        let initial = store.load("s").unwrap();
        store
            .commit("s", initial.row_version, &initial.core, &initial.meta)
            .unwrap();
        let StorageBackend::Sqlite { path } =
            dev_descriptor_at(dir.path().to_str().unwrap()).backend
        else {
            panic!("SQLite fixture required");
        };
        let conn = rusqlite::Connection::open(path).unwrap();
        let digest_count = || {
            conn.query_row(
                "SELECT count(*) FROM mc_cache_state_digest WHERE session_id='s'",
                [],
                |r| r.get::<_, usize>(0),
            )
            .unwrap()
        };
        assert_eq!(digest_count(), 1);
        let projection =
            ck_wire::project_messages(&codec_opencode::decode_messages(&entries).unwrap().messages)
                .unwrap();
        let ids = &projection.identity_by_mid;
        assert_eq!(
            store
                .upsert_provider_block_identities(&key(&h).store_key(), "L", ids)
                .unwrap(),
            1
        );
        assert_eq!(
            digest_count(),
            0,
            "identity insertion must invalidate the stale row-state memo"
        );
        let before = store.load("s").unwrap();
        let data_version: i64 = conn
            .query_row("PRAGMA data_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            store
                .upsert_provider_block_identities(&key(&h).store_key(), "L", ids)
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            data_version,
            "replay must perform no database writes"
        );
        let mut conflict = ids.clone();
        conflict.get_mut("m1").unwrap()[0].byte_fingerprint = "different".into();
        conflict.insert("new".into(), ids["m1"].clone());
        assert!(store
            .upsert_provider_block_identities(&key(&h).store_key(), "L", &conflict)
            .is_err());
        let after = store.load("s").unwrap();
        assert_eq!(before.row_version, after.row_version);
        assert_eq!(before.core, after.core);
        assert_eq!(before.meta, after.meta);
        assert_eq!(
            store
                .upsert_provider_block_identities(
                    &key(&h).store_key(),
                    "L",
                    &BTreeMap::from([("new".into(), ids["m1"].clone())])
                )
                .unwrap(),
            1,
            "conflicting batch must not have inserted its other row"
        );
    }

    async fn dispatch(h: &McHandler, value: Value) -> Value {
        response(h.dispatch_value(7, value).await)
    }
    async fn pending(h: &McHandler) -> Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let value = dispatch(h, json!({"method":"historian.pending","v":1})).await;
                if let Some(run) = value["runs"].as_array().and_then(|runs| runs.first()) {
                    return run.clone();
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("a real historian run must enter the existing claim queue")
    }
    fn step(id: &str, newest: u64) -> Value {
        json!({"session":"s","harness":"opencode","request_id":id,"lineage_id":"L","step_id":"st","step_kind":"user_turn","model":"fixture","context_window":100000,"estimate":{"request_tokens":1000},"messages":[],"newest":{"ordinal":newest,"mid":format!("m{newest}")},"now":2})
    }
    async fn warm(h: &McHandler, entries: &[compact::status::StatusMessage]) -> Value {
        let store = h.store.get().unwrap();
        store
            .replace_compartments(
                "s",
                &[StoredCompartment {
                    sequence: 1,
                    start_message: 1,
                    end_message: 1,
                    end_message_id: "m1#0".into(),
                    title: "previous history".into(),
                    content: "retained history".into(),
                    p1: Some("retained history".into()),
                    importance: 60,
                    ..Default::default()
                }],
            )
            .unwrap();
        response(h.handle_provider_value(7,"compaction.setup",&json!({"session":"s","harness":"opencode","request_id":"setup","preset":"head","params":{"serializer_profile":"opencode-aisdk","observation":"answer"},"composition":{},"model":"fixture","context_window":100000,"now":1,"lineage_id":"L"})).await);
        let mut boot = step("boot", entries.len() as u64);
        boot["messages"] = json!(entries);
        boot["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        let view = response(h.handle_provider_value(7, "compaction.step", &boot).await);
        assert_eq!(view["answer"], "compaction_message");
        let mut ack = step("ack", entries.len() as u64);
        ack["last_applied"] = view["compaction"].clone();
        assert_eq!(
            response(h.handle_provider_value(7, "compaction.step", &ack).await)["answer"],
            "noop"
        );
        view
    }
    async fn prepared_append(
        h: &McHandler,
        entries: &[compact::status::StatusMessage],
    ) -> Box<PreparedHistorianFiring> {
        sync(
            h,
            &entries[3..],
            &["test/model".into()],
            true,
            json!({"usage":{"current_total_input_tokens":45000,"context_limit_tokens":50000}}),
        );
        let action = h
            .provider_historian_worker()
            .prepare_provider_historian(&binding(h), &key(h))
            .await
            .unwrap()
            .unwrap();
        let PreparedHistorianAction::FireReady(p) = action else {
            panic!("ordinary append corpus must fire");
        };
        p
    }
    async fn claim_and_report(h: &McHandler, run: Value, from: u64, to: u64) {
        let claim = dispatch(h,json!({"method":"historian.claim","v":1,"run_id":run["run_id"],"claimant_instance_id":"m5-host"})).await;
        assert_eq!(claim["ok"], true, "{claim}");
        assert_eq!(claim["model_chain"], json!(["test/model"]));
        let output = format!(
            r#"<output><compartments><compartment start="{from}" end="{to}" title="ordinary append" episode_type="feature" importance="60"><p1>published provider history</p1><p2>short summary</p2><p3>arc</p3><p4 /></compartment></compartments><meta><messages_processed>{from}-{to}</messages_processed><unprocessed_from>{}</unprocessed_from></meta></output>"#,
            to + 1
        );
        let complete = dispatch(h,json!({"method":"historian.complete","v":1,"run_id":run["run_id"],"token":claim["token"],"output":{"text":output,"length_capped":false}})).await;
        assert_eq!(complete["ok"], true, "{complete}");
    }

    #[tokio::test]
    async fn ordinary_append_publishes_via_claim_cas_without_nonopportunity_view() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        declare(&h).await;
        let entries = corpus();
        let applied = warm(&h, &entries[..3]).await;
        let p = prepared_append(&h, &entries).await;
        let (from, to) = (p.task.firing.from_ordinal, p.task.firing.to_ordinal);
        assert!(
            to > 3,
            "publication must select ordinary appends, not only bootstrap messages"
        );
        let protected = p
            .diagnostics
            .progress
            .as_ref()
            .unwrap()
            .protected_start_ordinal;
        let worker = h.provider_historian_worker();
        let task = tokio::spawn(McHandler::execute_historian_firing_task(
            worker.producer_factory.clone(),
            p.task,
        ));
        let run = pending(&h).await;
        assert_ne!(
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
        claim_and_report(&h, run, from, to).await;
        let outcome = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let compartments = h.store.get().unwrap().load_compartments("s").unwrap();
        assert_eq!(
            compartments.len(),
            2,
            "the append must publish through the existing CAS: {outcome:?}"
        );
        assert!(compartments[1]
            .content
            .contains("published provider history"));
        assert!(
            (compartments[1].end_message as u64) < protected,
            "no published chunk includes protected tail ordinals"
        );
        let before = h
            .store
            .get()
            .unwrap()
            .load_provider_views(&key(&h).store_key())
            .unwrap();
        let mut low = step("after-publication", 80);
        low["last_applied"] = applied["compaction"].clone();
        assert_eq!(
            response(h.handle_provider_value(7, "compaction.step", &low).await)["answer"],
            "noop",
            "publication alone is not a bust opportunity"
        );
        let after = h
            .store
            .get()
            .unwrap()
            .load_provider_views(&key(&h).store_key())
            .unwrap();
        assert_eq!(before.len(), after.len());
        assert_eq!(before[0].replacement_json, after[0].replacement_json);
    }

    #[tokio::test]
    async fn hook_timing_does_not_wait_for_off_path_trigger_work() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        declare(&h).await;
        let entries = corpus();
        sync(&h, &entries, &[], false, json!({}));
        let worker = h.provider_historian_worker();
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        *worker.provider_historian_gate.lock().unwrap() = Some((entered.clone(), release.clone()));
        let started = Instant::now();
        response(
            h.handle_provider_value(7, "transform.hook", &hook(entries.last().unwrap(), true))
                .await,
        );
        assert!(
            started.elapsed() < Duration::from_millis(150),
            "hook answer must not await trigger evaluation"
        );
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        let next = text(81, "user", 10);
        let started = Instant::now();
        response(
            h.handle_provider_value(7, "transform.hook", &hook(&next, false))
                .await,
        );
        assert!(
            started.elapsed() < Duration::from_millis(150),
            "blocked trigger work must not retain the conversation lock"
        );
        assert!(h
            .store
            .get()
            .unwrap()
            .load_meta("s")
            .unwrap()
            .meta
            .historian
            .recent_decisions
            .is_empty());
        release.notify_one();
    }

    #[tokio::test]
    async fn debounce_counts_ingested_tool_results_not_replayed_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        declare(&h).await;
        sync(&h, &[text(1, "user", 10)], &[], true, json!({}));
        let worker = h.provider_historian_worker();
        assert!(worker
            .prepare_provider_historian(&binding(&h), &key(&h))
            .await
            .unwrap()
            .is_some());
        let tools = (2..=26).map(|ordinal| { let mid = format!("m{ordinal}"); compact::status::StatusMessage { ordinal, mid: mid.clone(), message: json!({"info":{"id":mid,"role":"assistant"},"parts":[{"id":format!("p{ordinal}"),"type":"tool","tool":"read","callID":format!("call{ordinal}"),"state":{"status":"completed","input":{},"output":"result"}}]}) } }).collect::<Vec<_>>();
        sync(&h, &tools[..24], &[], true, json!({}));
        assert!(worker
            .prepare_provider_historian(&binding(&h), &key(&h))
            .await
            .unwrap()
            .is_none());
        sync(&h, &tools[24..], &[], true, json!({}));
        assert!(
            worker
                .prepare_provider_historian(&binding(&h), &key(&h))
                .await
                .unwrap()
                .is_some(),
            "25th ingested result must evaluate"
        );
        sync(&h, &tools, &[], true, json!({}));
        assert!(
            worker
                .prepare_provider_historian(&binding(&h), &key(&h))
                .await
                .unwrap()
                .is_none(),
            "replayed ingestion must not count again"
        );
    }

    fn full_request_during_run(
        h: &McHandler,
        entries: &[compact::status::StatusMessage],
    ) -> transform::TransformWithProjection {
        let b = binding(h);
        let config = &b.config;
        let root = b.project_root.to_string_lossy();
        let mut request: TransformRequest = decode(&json!({"v":2,"kind":"transform","session_id":"s","serializer_profile":"opencode-aisdk","model_key":"fixture","messages":[],"render_config":format!("{}|broca-compaction:0",json!({"serializer_profile":"opencode-aisdk","observation":"answer"})),"tool_present":true,"auto_search_enabled":false,"todo_tool_present":false,"usage":{"current_total_input_tokens":80000,"context_limit_tokens":100000}})).unwrap();
        codec::Codec::OpencodeAiSdk
            .prepare_request(&mut request, entries)
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
            now_ms: now_ms(),
            execute_threshold_percentage: config
                .resolve_execute_threshold(Some("fixture"))
                .percentage,
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
            observed_last_response_at_ms: Some(now_ms()),
            guidance_date: None,
            historian_active: true,
            wrapup_active: false,
            caveman_english_word_rules: transform::caveman_english_word_rules(
                config.language.as_deref(),
            ),
            injected_reductions: vec![],
        };
        transform::transform_with_projection(h.store.get().unwrap(), &request, &context).unwrap()
    }

    #[tokio::test]
    async fn in_flight_step_matches_full_request_veto_and_restart_adopts_report() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        declare(&h).await;
        let entries = corpus();
        let applied = warm(&h, &entries[..3]).await;
        let p = prepared_append(&h, &entries).await;
        let (from, to) = (p.task.firing.from_ordinal, p.task.firing.to_ordinal);
        let worker = h.provider_historian_worker();
        let task = tokio::spawn(McHandler::execute_historian_firing_task(
            worker.producer_factory.clone(),
            p.task,
        ));
        let run = pending(&h).await;
        h.store
            .get()
            .unwrap()
            .append_pending_agent_drops("s", &["m2#0".into()], now_ms())
            .unwrap();
        let oracle_dir = tempfile::tempdir().unwrap();
        let oracle_h = handler(oracle_dir.path());
        declare(&oracle_h).await;
        warm(&oracle_h, &entries[..3]).await;
        oracle_h
            .store
            .get()
            .unwrap()
            .append_pending_agent_drops("s", &["m2#0".into()], now_ms())
            .unwrap();
        let full = full_request_during_run(&oracle_h, &entries);
        assert!(
            !full.response.prefix_bust_permitted,
            "full-request historian veto defers the first application of queued drops"
        );
        let mut status = step("during-run", 80);
        status["estimate"]["request_tokens"] = json!(80000);
        status["last_applied"] = applied["compaction"].clone();
        assert_eq!(
            response(h.handle_provider_value(7, "compaction.step", &status).await)["answer"],
            "noop"
        );
        assert_eq!(
            h.store
                .get()
                .unwrap()
                .load_pending_agent_drops("s")
                .unwrap()
                .len(),
            1
        );
        // Stop the in-memory firing task and host claim ledger. The database
        // keeps the historian phase, claim row and provider message log.
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        drop(worker);
        drop(h);
        let restarted = handler(dir.path());
        assert_ne!(
            restarted
                .store
                .get()
                .unwrap()
                .load_meta("s")
                .unwrap()
                .meta
                .historian
                .state,
            HistorianPhase::Idle
        );
        let mut status = step("after-restart", 80);
        status["estimate"]["request_tokens"] = json!(80000);
        status["last_applied"] = applied["compaction"].clone();
        assert_eq!(
            response(
                restarted
                    .handle_provider_value(7, "compaction.step", &status)
                    .await
            )["answer"],
            "noop"
        );
        assert_eq!(
            restarted
                .store
                .get()
                .unwrap()
                .load_pending_agent_drops("s")
                .unwrap()
                .len(),
            1
        );
        sync(
            &restarted,
            &[],
            &["test/model".into()],
            true,
            json!({"usage":{"current_total_input_tokens":45000,"context_limit_tokens":50000}}),
        );
        restarted
            .provider_historian_worker()
            .prepare_provider_historian(&binding(&restarted), &key(&restarted))
            .await
            .unwrap();
        let offered = pending(&restarted).await;
        assert_eq!(offered["run_id"], run["run_id"]);
        claim_and_report(&restarted, offered, from, to).await;
        sync(
            &restarted,
            &[],
            &["test/model".into()],
            true,
            json!({"usage":{"current_total_input_tokens":45000,"context_limit_tokens":50000}}),
        );
        restarted
            .provider_historian_worker()
            .prepare_provider_historian(&binding(&restarted), &key(&restarted))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if restarted
                    .store
                    .get()
                    .unwrap()
                    .load_meta("s")
                    .unwrap()
                    .meta
                    .historian
                    .state
                    == HistorianPhase::Idle
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(restarted.store.get().unwrap().load_compartments("s").unwrap().len(),2,"parked report uses the log fence and existing CAS, not an absent full-request snapshot");
    }

    #[tokio::test]
    async fn descent_during_run_refuses_publication_before_engine_revert_epoch_changes() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        declare(&h).await;
        let entries = corpus();
        warm(&h, &entries[..3]).await;
        let p = prepared_append(&h, &entries).await;
        let (from, to) = (p.task.firing.from_ordinal, p.task.firing.to_ordinal);
        let worker = h.provider_historian_worker();
        let task = tokio::spawn(McHandler::execute_historian_firing_task(
            worker.producer_factory.clone(),
            p.task,
        ));
        let run = pending(&h).await;
        let before_epoch = h
            .store
            .get()
            .unwrap()
            .load_meta("s")
            .unwrap()
            .meta
            .revert_epoch;
        let mut entry = text(to, "user", 10);
        entry.mid = "replacement".into();
        entry.message["info"]["id"] = json!(entry.mid);
        let mut params = hook(&entry, false);
        params["lineage_id"] = json!("child");
        params["descends_from"] = json!({"lineage_id":"L","through_ordinal":to-1});
        response(h.handle_provider_value(7, "transform.hook", &params).await);
        assert_eq!(
            h.store
                .get()
                .unwrap()
                .load_meta("s")
                .unwrap()
                .meta
                .revert_epoch,
            before_epoch,
            "provider-only descent must exercise the gap before engine recut"
        );
        claim_and_report(&h, run, from, to).await;
        let outcome = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            h.store.get().unwrap().load_compartments("s").unwrap().len(),
            1,
            "selected range was reverted before engine recut: {outcome:?}"
        );
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
    }
    #[tokio::test]
    async fn same_user_pressure_crossing_waits_for_debounce_then_matches_oracle() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        declare(&h).await;
        let mut entries = corpus()[..40].to_vec();
        let chain: Vec<String> = vec!["test/model".into()];
        sync(
            &h,
            &entries,
            &chain,
            true,
            json!({"usage":{"current_total_input_tokens":1000,"context_limit_tokens":100000}}),
        );
        let worker = h.provider_historian_worker();
        let first = worker
            .prepare_provider_historian(&binding(&h), &key(&h))
            .await
            .unwrap()
            .unwrap();
        assert!(
            !signature(&first).0,
            "control begins below the full-request trigger"
        );
        let assistants = (41..=80)
            .map(|n| text(n, "assistant", 800))
            .collect::<Vec<_>>();
        let inputs =
            json!({"usage":{"current_total_input_tokens":90000,"context_limit_tokens":100000}});
        sync(&h, &assistants, &chain, true, inputs.clone());
        entries.extend(assistants);
        assert!(
            worker
                .prepare_provider_historian(&binding(&h), &key(&h))
                .await
                .unwrap()
                .is_none(),
            "same-user assistant passes do not bypass the declared debounce"
        );
        let baseline_dir = tempfile::tempdir().unwrap();
        let baseline = handler(baseline_dir.path());
        assert!(
            signature(&oracle(&baseline, &entries, &chain, inputs.clone())).0,
            "full-request control crosses the trigger before the delayed evaluation"
        );
        let tools = (81..=105).map(|ordinal| { let mid = format!("m{ordinal}"); compact::status::StatusMessage { ordinal, mid: mid.clone(), message: json!({"info":{"id":mid,"role":"assistant"},"parts":[{"id":format!("p{ordinal}"),"type":"tool","tool":"read","callID":format!("call{ordinal}"),"state":{"status":"completed","input":{},"output":"result"}}]}) } }).collect::<Vec<_>>();
        sync(&h, &tools, &chain, true, inputs.clone());
        entries.extend(tools);
        let actual = worker
            .prepare_provider_historian(&binding(&h), &key(&h))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            signature(&actual),
            signature(&oracle(&baseline, &entries, &chain, inputs)),
            "first permitted evaluation uses the complete newest log and current pressure"
        );
    }

    #[tokio::test]
    async fn publication_fence_accepts_surviving_cuts_and_refuses_busy_admission() {
        for offset in [Some(0), Some(1), None] {
            let dir = tempfile::tempdir().unwrap();
            let h = handler(dir.path());
            declare(&h).await;
            let entries = corpus();
            warm(&h, &entries[..3]).await;
            let p = prepared_append(&h, &entries).await;
            let (from, to) = (p.task.firing.from_ordinal, p.task.firing.to_ordinal);
            let worker = h.provider_historian_worker();
            let task = tokio::spawn(McHandler::execute_historian_firing_task(
                worker.producer_factory.clone(),
                p.task,
            ));
            let run = pending(&h).await;
            let guard = if let Some(offset) = offset {
                let cut = to + offset;
                let mut entry = text(cut + 1, "user", 10);
                entry.mid = "replacement".into();
                entry.message["info"]["id"] = json!(entry.mid);
                let mut params = hook(&entry, false);
                params["lineage_id"] = json!("child");
                params["descends_from"] = json!({"lineage_id":"L","through_ordinal":cut});
                response(h.handle_provider_value(7, "transform.hook", &params).await);
                None
            } else {
                Some(h.provider_serial.lock_for(&key(&h)).await)
            };
            claim_and_report(&h, run, from, to).await;
            let outcome = tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                h.store.get().unwrap().load_compartments("s").unwrap().len(),
                if offset.is_some() { 2 } else { 1 },
                "cut={offset:?}, outcome={outcome:?}"
            );
            assert_eq!(
                h.store
                    .get()
                    .unwrap()
                    .load_meta("s")
                    .unwrap()
                    .meta
                    .historian
                    .failure_backoff_at_ms,
                None,
                "local publication contention is not a model failure"
            );
            drop(guard);
        }
    }
}
