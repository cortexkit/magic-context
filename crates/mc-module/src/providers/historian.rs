//! Barrier-driven historian evaluation over the provider's durable ingest log.
use super::*;

#[cfg(test)]
struct HistorianBlockingProbe {
    stage: &'static str,
    harness: String,
    thread: Option<std::path::PathBuf>,
    started: std::time::Instant,
    cpu_ticks: Option<u64>,
}
#[cfg(test)]
fn thread_cpu_ticks() -> Option<u64> {
    let stat = std::fs::read_to_string("/proc/thread-self/stat").ok()?;
    let fields = stat
        .rsplit_once(')')?
        .1
        .split_whitespace()
        .collect::<Vec<_>>();
    Some(fields.get(11)?.parse::<u64>().ok()? + fields.get(12)?.parse::<u64>().ok()?)
}
#[cfg(test)]
impl HistorianBlockingProbe {
    fn new(stage: &'static str, harness: &str) -> Self {
        let probe = Self {
            stage,
            harness: harness.into(),
            thread: std::fs::read_link("/proc/thread-self").ok(),
            started: std::time::Instant::now(),
            cpu_ticks: thread_cpu_ticks(),
        };
        tracing::info!(stage, harness, thread=?probe.thread, marker="begin", "historian blocking work");
        probe
    }
}
#[cfg(test)]
impl Drop for HistorianBlockingProbe {
    fn drop(&mut self) {
        let cpu_ticks = thread_cpu_ticks()
            .zip(self.cpu_ticks)
            .map(|(after, before)| after.saturating_sub(before));
        tracing::info!(stage=self.stage,harness=%self.harness,thread=?self.thread,marker="end",
            wall_ms=self.started.elapsed().as_secs_f64()*1000.0,cpu_ticks=?cpu_ticks,"historian blocking work");
    }
}

/// Only scalar/model policy accompanies a pass. Transcript bytes come exclusively
/// from the message log; a host cannot substitute a second history for the trigger.
pub fn checked_inputs(value: &Value) -> Result<Value, HandlerOutcome> {
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

pub fn record_barrier(counters: &mut Value) {
    counters["historian_barrier_generation"] = json!(counters
        .get("historian_barrier_generation")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .saturating_add(1));
}

/// Advance raw-ingest cadence only for new contiguous ordinals. A replay is not
/// another user/tool event. Unknown cadence after a gap or descent is rebaselined
/// from the unsummarized range at the next completed evaluation; intact scalar
/// watermarks continue advancing without reading covered messages.
pub fn advance_ingest_watermarks(
    counters: &mut Value,
    lineage: &str,
    messages: &[ck_wire::CkIngressMessage],
) {
    let Some(mut watermark) = counters
        .get("historian_ingest")
        .filter(|v| v.is_object())
        .cloned()
    else {
        return;
    };
    if watermark["lineage"].as_str() != Some(lineage) {
        counters["historian_ingest"] = Value::Null;
        return;
    }
    let mut through = watermark["through"].as_u64().unwrap_or(0);
    let mut tools = watermark["tools"].as_u64().unwrap_or(0);
    for message in messages {
        if message.ordinal <= through {
            continue;
        }
        if message.ordinal != through.saturating_add(1) {
            counters["historian_ingest"] = Value::Null;
            return;
        }
        through = message.ordinal;
        if !message.ck.meta.synthetic {
            if message.ck.role == "user" {
                watermark["user"] = json!([message.mid, message.ordinal]);
            }
            tools = tools.saturating_add(
                message
                    .ck
                    .content
                    .iter()
                    .filter(|b| matches!(b.kind, mc_store::CkKind::ToolResult { .. }))
                    .count() as u64,
            );
        }
    }
    watermark["through"] = json!(through);
    watermark["tools"] = json!(tools);
    counters["historian_ingest"] = watermark;
}

struct EvaluationClaim {
    entries: Arc<Mutex<HashSet<String>>>,
    key: String,
}
impl Drop for EvaluationClaim {
    fn drop(&mut self) {
        self.entries
            .lock()
            .expect("historian evaluations")
            .remove(&self.key);
    }
}

struct IngestSnapshot {
    messages: Vec<ck_wire::CkIngressMessage>,
    user: Value,
    tools: u64,
}

struct LogPublicationFence {
    _budget: Arc<historian_budget::Permit>,
    key: Key,
    lineage: String,
    serial: Arc<ProviderSerial>,
}

pub struct RunCompletion {
    key: Key,
    generation: u64,
}

impl RunCompletion {
    pub fn record(
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
    pub(super) fn provider_historian_worker(&self) -> Arc<Self> {
        Arc::clone(self.provider_historian_worker.get_or_init(|| {
            let mut worker = Self::new();
            worker.store = Arc::clone(&self.store);
            worker.provider_store = Arc::clone(&self.provider_store);
            worker.provider_runner = Arc::clone(&self.provider_runner);
            worker.historian_model_catalog = self.historian_model_catalog.clone();
            worker.provider_serial = Arc::clone(&self.provider_serial);
            worker.provider_historian_budget = Arc::clone(&self.provider_historian_budget);
            worker.provider_historian_evaluations =
                Arc::clone(&self.provider_historian_evaluations);
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
            worker.wrapup_sessions = Arc::clone(&self.wrapup_sessions);
            worker.connect_failure_commit_hook = Arc::clone(&self.connect_failure_commit_hook);
            #[cfg(test)]
            {
                worker.fixed_config = self.fixed_config.clone();
                worker.fixed_historian_settings = self.fixed_historian_settings.clone();
                worker.provider_historian_scan_rows =
                    Arc::clone(&self.provider_historian_scan_rows);
            }
            Arc::new(worker)
        }))
    }

    #[cfg(not(test))]
    pub(super) fn historian_settings_loader(&self) -> Box<dyn FnOnce(&Path) -> Value + Send> {
        let resolver = crate::config_parity::TrustedConfigResolver::from_environment();
        Box::new(move |project_root| {
            super::historian_config::trusted_settings(&resolver, project_root)
        })
    }

    #[cfg(test)]
    pub(super) fn historian_settings_loader(&self) -> Box<dyn FnOnce(&Path) -> Value + Send> {
        let settings = self
            .fixed_historian_settings
            .clone()
            .unwrap_or_else(|| json!({}));
        Box::new(move |_| settings)
    }

    pub fn schedule_provider_historian(&self, binding: SessionBinding, key: Key) {
        // Bulk residency fixtures can isolate serving-cache charges by disabling
        // background historians. This switch does not ship in ck-mc.
        #[cfg(test)]
        if std::env::var_os("MC_TEST_HISTORIAN_HOLD").is_some() {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let worker = self.provider_historian_worker();
        runtime.spawn(async move {
            let mut retry_snapshot = true;
            while retry_snapshot {
                retry_snapshot = false;
                match worker.prepare_provider_historian_snapshot(&binding, &key, &mut retry_snapshot).await {
                Ok(Some(PreparedHistorianAction::FireReady(prepared))) => {
                    worker.spawn_historian_firing(prepared.task);
                }
                Ok(_) => {}
                Err(error) => {
                    worker.retry_provider_historian(&key).await;
                    tracing::warn!(session=%key.session, ?error, "provider historian evaluation failed");
                }
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

    async fn prepare_provider_historian_snapshot(
        &self,
        binding: &SessionBinding,
        key: &Key,
        retry_snapshot: &mut bool,
    ) -> Result<Option<PreparedHistorianAction>, HandlerOutcome> {
        let rust_background_enabled = self
            .effective_config(&binding.project_root)
            .rust_background_enabled();
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let evaluation_key = key.store_key().conversation_key();
        {
            let mut evaluations = self
                .provider_historian_evaluations
                .lock()
                .expect("historian evaluations");
            if !evaluations.insert(evaluation_key.clone()) {
                return Ok(None);
            }
        }
        let _evaluation = EvaluationClaim {
            entries: Arc::clone(&self.provider_historian_evaluations),
            key: evaluation_key,
        };
        let serial = self.provider_serial.lock_for(key).await;
        let Some(mut conversation) = store
            .load_provider_conversation(&key.store_key())
            .map_err(transient)?
        else {
            return Ok(None);
        };
        if matches!(
            conversation.preset.as_deref(),
            Some("worker" | "subagent" | "reader")
        ) {
            return Ok(None);
        }
        let mut counters: Value =
            serde_json::from_str(&conversation.hook_counters_json).map_err(transient)?;
        let barrier = counters["pass_complete"].clone();
        if barrier["lineage_id"].as_str() != Some(&conversation.lineage_id) {
            return Ok(None);
        }
        let Some(through) = barrier["through_ordinal"].as_u64() else {
            return Ok(None);
        };
        let generation = counters["historian_barrier_generation"]
            .as_u64()
            .unwrap_or(0);
        if counters["historian_evaluated_barrier"].as_u64() == Some(generation)
            && counters["historian_evaluation_due"].as_bool() != Some(true)
        {
            return Ok(None);
        }
        // Admission maintains the complete frontier on this small row. A final
        // ordinal cannot authorize a gap or an unbarriered later message.
        if conversation.cursor_frontier != through.saturating_add(1)
            && !(conversation.cursor_frontier == 0 && through == 0)
        {
            return Ok(None);
        }
        let meta = store
            .load_meta(&conversation.engine_namespace)
            .map_err(transient)?;
        let active = meta.meta.historian.state != HistorianPhase::Idle;
        drop(meta);
        let live = self
            .live_historian_completion_wait(&conversation.engine_namespace)
            .is_some();
        let recovering = active && !live;
        let cadence = counters["historian_cadence"].clone();
        let watermark = &counters["historian_ingest"];
        let known = watermark["lineage"].as_str() == Some(&conversation.lineage_id)
            && watermark["through"].as_u64() == Some(through);
        let requested = !known
            || counters["historian_evaluation_due"].as_bool() == Some(true)
            || counters["historian_run_retry_due"].as_bool() == Some(true)
            || counters["historian_launch_pending"].is_object()
            || cadence.is_null()
            || cadence["lineage"].as_str() != Some(&conversation.lineage_id)
            || recovering;
        let cadence_due = !known
            || cadence["user"] != watermark["user"]
            || watermark["tools"].as_u64().unwrap_or(0)
                >= cadence["tools"].as_u64().unwrap_or(0).saturating_add(25);
        // The debounce decision uses only admission watermarks and namespace
        // phase. No transcript or ordinal query belongs to a skipped evaluation.
        if (active && live) || (!requested && !cadence_due) {
            counters["historian_evaluated_barrier"] = json!(generation);
            conversation.hook_counters_json = counters.to_string();
            store
                .save_provider_conversation(&key.store_key(), &conversation)
                .map_err(transient)?;
            return Ok(None);
        }
        counters["historian_evaluated_barrier"] = json!(generation);
        counters["historian_evaluation_due"] = json!(true);
        conversation.hook_counters_json = counters.to_string();
        store
            .save_provider_conversation(&key.store_key(), &conversation)
            .map_err(transient)?;
        drop(serial);

        let covered = store
            .max_compartment_end_ordinal(&conversation.engine_namespace)
            .map_err(transient)?;
        let first = if covered > 0 {
            (covered as u64).saturating_add(1)
        } else {
            0
        };
        let native_bytes = store
            .provider_message_range_bytes(
                &key.store_key(),
                &conversation.lineage_id,
                first,
                through,
            )
            .map_err(transient)?;
        let budget = self.provider_historian_budget.acquire(native_bytes).await;
        // Revalidate after queueing, before allocating a transcript. Hooks and
        // folds may have advanced the barrier or published a newer boundary.
        let current = store
            .load_provider_conversation(&key.store_key())
            .map_err(transient)?;
        if current.as_ref().is_none_or(|current| {
            current.lineage_id != conversation.lineage_id
                || current.hook_counters_json != conversation.hook_counters_json
        }) || store
            .max_compartment_end_ordinal(&conversation.engine_namespace)
            .map_err(transient)?
            != covered
        {
            *retry_snapshot = true;
            return Ok(None);
        }
        let load_budget = Arc::clone(&budget);
        let ingest_watermark = counters["historian_ingest"].clone();
        let load_store = Arc::clone(store);
        let load_key = key.store_key();
        let lineage = conversation.lineage_id.clone();
        #[cfg(test)]
        let scan_rows = Arc::clone(&self.provider_historian_scan_rows);
        #[cfg(test)]
        let mut ingest_pause = self
            .provider_historian_ingest_pause
            .lock()
            .expect("ingest pause")
            .take();
        let ingest = tokio::task::spawn_blocking(
            move || -> Result<Option<IngestSnapshot>, HandlerOutcome> {
                #[cfg(test)]
                let _probe = HistorianBlockingProbe::new("ingest", &load_key.harness);
                let _budget = load_budget;
                let mut messages = Vec::new();
                if messages.is_empty() {
                    let mut next = first;
                    loop {
                        let held = load_store
                            .load_provider_messages_page(&load_key, &lineage, next, through, 256)
                            .map_err(transient)?;
                        #[cfg(test)]
                        scan_rows.fetch_add(held.len() as u64, Ordering::Relaxed);
                        if held.is_empty() {
                            break;
                        }
                        let last = held.last().unwrap().ordinal;
                        for m in held {
                            let entry = codec::InboundMessage {
                                mid: m.mid,
                                ordinal: m.ordinal,
                                message: serde_json::from_slice(&m.message_bytes)
                                    .map_err(transient)?,
                            };
                            messages.push(codec::Codec::OpencodeAiSdk.decode_message(&entry)?);
                            #[cfg(test)]
                            if let Some((entered, release)) = ingest_pause.take() {
                                let _ = entered.send(());
                                release.recv().map_err(transient)?;
                            }
                        }
                        if last >= through {
                            break;
                        }
                        next = last.saturating_add(1);
                    }
                }
                if messages.last().is_some_and(|m| m.ordinal != through) {
                    return Ok(None);
                }
                let user = if known {
                    ingest_watermark["user"].clone()
                } else {
                    messages
                        .iter()
                        .rev()
                        .find(|m| m.ck.role == "user" && !m.ck.meta.synthetic)
                        .map(|m| json!([m.mid, m.ordinal]))
                        .unwrap_or(Value::Null)
                };
                let tools = if known {
                    ingest_watermark["tools"].as_u64().unwrap_or(0)
                } else {
                    messages
                        .iter()
                        .filter(|m| !m.ck.meta.synthetic)
                        .flat_map(|m| &m.ck.content)
                        .filter(|b| matches!(b.kind, mc_store::CkKind::ToolResult { .. }))
                        .count() as u64
                };
                drop(load_store);
                Ok(Some(IngestSnapshot {
                    messages,
                    user,
                    tools,
                }))
            },
        )
        .await
        .map_err(transient)??;
        let Some(ingest) = ingest else {
            return Ok(None);
        };
        let serial = self.provider_serial.lock_for(key).await;
        let Some(current) = store
            .load_provider_conversation(&key.store_key())
            .map_err(transient)?
        else {
            return Ok(None);
        };
        let current_counters: Value =
            serde_json::from_str(&current.hook_counters_json).map_err(transient)?;
        // A blocking snapshot is accepted only for the barrier this evaluator
        // claimed. Opening another pass or changing chain/lineage invalidates it.
        if current.lineage_id != conversation.lineage_id
            || current.historian_model_chain_json != conversation.historian_model_chain_json
            || current_counters["pass_complete"] != barrier
            || current_counters["historian_barrier_generation"]
                .as_u64()
                .unwrap_or(0)
                != generation
            || current_counters["historian_evaluated_barrier"].as_u64() != Some(generation)
        {
            *retry_snapshot = true;
            return Ok(None);
        }
        conversation = current;
        counters = current_counters;
        counters["historian_ingest"] = json!({"lineage":conversation.lineage_id,"through":through,"user":ingest.user,"tools":ingest.tools});
        let due = requested
            || cadence["user"] != ingest.user
            || ingest.tools >= cadence["tools"].as_u64().unwrap_or(0).saturating_add(25);
        if !due {
            counters["historian_evaluation_due"] = json!(false);
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
        let reclaim_ride_available = request["reclaim_ride_available"].as_bool().unwrap_or(false);
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
        // Keep the codec's retained native representation, as the engine does;
        // a JSON round trip changes the fingerprints of those conversation blocks.
        parsed.messages = ingest.messages;
        conversation.hook_counters_json = counters.to_string();
        store
            .save_provider_conversation(&key.store_key(), &conversation)
            .map_err(transient)?;
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
        let worker = self.provider_historian_worker();
        let prepare_store = Arc::clone(store);
        let prepare_binding = binding.clone();
        let prepare_key = key.clone();
        let prepare_lineage = conversation.lineage_id.clone();
        let prepare_budget = Arc::clone(&budget);
        let mut action = tokio::task::spawn_blocking(
            move || -> Result<PreparedHistorianAction, HandlerOutcome> {
                #[cfg(test)]
                let _probe = HistorianBlockingProbe::new("prepare", &prepare_key.harness);
                let _budget = prepare_budget;
                let projection = ck_wire::project_messages(&parsed.messages).map_err(transient)?;
                let mut timings = HistorianTriggerTimings::default();
                Ok(worker.prepare_historian_fire(
                    prepare_store,
                    &parsed,
                    &prepare_binding,
                    &prepare_binding.project_root.to_string_lossy(),
                    &projection,
                    HistorianPrepareContext {
                        rust_background_enabled: Some(rust_background_enabled),
                        now: now_ms(),
                        publication_fence: Some(Arc::new(LogPublicationFence {
                            // Firings and restart adoption retain the fence for
                            // their entire drive, so they retain admission too.
                            _budget: Arc::clone(&_budget),
                            key: prepare_key,
                            lineage: prepare_lineage,
                            serial: Arc::clone(&worker.provider_serial),
                        })),
                        tag_snapshot: None,
                        async_coverage: None,
                        reclaim_ride_available,
                        runner_lane: true,
                        timings: &mut timings,
                    },
                ))
            },
        )
        .await
        .map_err(transient)??;
        if let PreparedHistorianAction::FireReady(prepared) = &mut action {
            prepared.task.provider_completion = Some(RunCompletion {
                key: key.clone(),
                generation,
            });
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
            json!({"user":ingest.user,"tools":ingest.tools,"lineage":conversation.lineage_id}),
            EvaluationOutcome::of(&action),
        )
        .await?;
        Ok(Some(action))
    }
}
