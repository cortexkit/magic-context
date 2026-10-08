//! Setup, step and durable wait work through the compaction engine adapter.
use super::*;

#[derive(Clone)]
struct Work {
    binding: SessionBinding,
    key: Key,
    project_path: String,
    note_project_path: String,
}

fn status(
    params: &Value,
    record: &Record,
) -> Result<transform::compaction::Status, HandlerOutcome> {
    let lineage = params
        .get("lineage_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let window = params
        .get("context_window")
        .and_then(Value::as_u64)
        .filter(|w| *w > 0)
        .or_else(|| record.setup.as_ref().and_then(|s| s.request.context_window))
        .ok_or_else(|| invalid("context_window must be known and positive"))?;
    let previous_usage = params
        .get("previous_usage")
        .filter(|v| v.is_object())
        .map(|u| transform::compaction::PreviousUsage {
            input_tokens: u.get("input").and_then(Value::as_u64),
            cached_input_tokens: u.get("cache_read").and_then(Value::as_u64),
            cache_write_tokens: u.get("cache_write").and_then(Value::as_u64),
        });
    let mut status = transform::compaction::Status {
        lineage_id: lineage.into(),
        newest_ordinal: params.pointer("/newest/ordinal").and_then(Value::as_u64),
        previous_usage,
        request_tokens: params
            .pointer("/estimate/request_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        context_window: window,
        prefix_rebuilding: params
            .get("prefix_rebuilding")
            .is_some_and(|v| !v.is_null()),
        last_applied_version: params
            .pointer("/last_applied/version")
            .and_then(Value::as_u64),
        last_not_applied: params
            .get("last_not_applied")
            .filter(|v| v.is_object())
            .map(|v| {
                Ok(transform::compaction::NotApplied {
                    version: v
                        .get("version")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| invalid("last_not_applied.version is required"))?,
                    structural: v.get("reason").and_then(Value::as_str) == Some("structural"),
                })
            })
            .transpose()?,
    };
    if status.last_not_applied.is_none() {
        if let Some(state) = record.setup.as_ref().map(|s| &s.state) {
            let applied = status
                .last_applied_version
                .or_else(|| state.last_applied.as_ref().map(|v| v.version))
                .unwrap_or(0);
            let fresh_request = record
                .last_answer
                .as_ref()
                .and_then(|a| a.get("request_id"))
                .is_some_and(|id| Some(id) != params.get("request_id"));
            if let Some(view) = state
                .last_produced
                .as_ref()
                .filter(|v| fresh_request && v.version > applied)
            {
                // An allocated-but-unsent answer is invisible to the runner's
                // last_not_applied. A newer issued request fences it anyway;
                // retain its frozen work and retry only on a permitted pass.
                status.last_not_applied = Some(transform::compaction::NotApplied {
                    version: view.version,
                    structural: false,
                });
            }
        }
    }
    Ok(status)
}

fn execute(
    store: &McStore,
    work: &Work,
    record: &mut Record,
    status: &transform::compaction::Status,
    initial: bool,
) -> Result<transform::compaction::Output, HandlerOutcome> {
    let setup = record
        .setup
        .as_ref()
        .ok_or_else(|| error("setup_missing", "compaction.step requires a Setup record"))?;
    let messages = record
        .messages
        .get(&status.lineage_id)
        .map(|m| {
            m.values()
                .map(decode_message)
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    let config = &work.binding.config;
    let template: TransformRequest = decode(
        &json!({"v":2,"kind":"compaction.step","serializer_profile":"owned-broca",
        "session_id":work.key.engine_key(),"render_config":serde_json::to_string(&setup.request.params).map_err(transient)?,
        "model_key":setup.request.model,"messages":messages,"tool_present":false,"auto_search_enabled":false}),
    )?;
    let protected = config.resolve_protected_tokens(status.context_window);
    let ttl = config.resolve_cache_ttl_with_provenance(Some(&setup.request.model));
    let context = transform::ProducerContext {
        project_path: &work.project_path,
        note_project_path: &work.note_project_path,
        project_directory: &work.binding.project_root.to_string_lossy(),
        history_budget_tokens: work.binding.history_budget_tokens,
        memory_budget_tokens: config.memory_budget_tokens,
        user_profile_budget_tokens: config.user_profile_budget_tokens,
        memory_enabled: config.memory_enabled,
        inject_docs: config.inject_docs,
        temporal_awareness: config.temporal_awareness,
        now_ms: now_ms(),
        execute_threshold_percentage: config
            .resolve_execute_threshold(Some(&setup.request.model))
            .percentage,
        protected_tokens_floor: protected.floor,
        protected_tokens_provenance: if protected.provenance == "derived" {
            "derived"
        } else {
            "absolute"
        },
        compaction_enabled: config.compaction_enabled,
        smart_drops: config.smart_drops,
        protected_tools: config.protected_tools.clone(),
        cache_ttl: ttl.value,
        cache_ttl_provenance: ttl.provenance,
        cache_ttl_policy: None,
        model_key: Some(setup.request.model.clone()),
        observed_last_response_at_ms: None,
        guidance_date: None,
        historian_active: false,
        wrapup_active: false,
        caveman_english_word_rules: transform::caveman_english_word_rules(
            config.language.as_deref(),
        ),
        #[cfg(test)]
        injected_reductions: vec![],
    };
    let targets = record
        .pending_drops
        .iter()
        .filter_map(|n| record.hook.as_ref()?.live.get(n))
        .filter(|t| t.lineage == status.lineage_id)
        .map(|t| t.block_id.clone())
        .collect::<Vec<_>>();
    store
        .append_pending_agent_drops(&work.key.engine_key(), &targets, now_ms())
        .map_err(transient)?;
    let state = &mut record.setup.as_mut().expect("setup exists").state;
    // An initial empty insertion had no lineage yet. Attach it to the first
    // actual lineage without inventing an ordinal or rebuilding Setup.
    for view in [&mut state.last_applied, &mut state.last_produced]
        .into_iter()
        .flatten()
    {
        if view.range.lineage_id.is_empty() && view.range.from == view.range.to {
            view.range.lineage_id = status.lineage_id.clone();
        }
    }
    let result = if initial {
        transform::compaction::setup(store, &template, &context, status, state)
    } else {
        transform::compaction::step(store, &template, &context, status, state)
    }
    .map_err(transient)?;
    let pending = store
        .load_pending_agent_drops(&work.key.engine_key())
        .map_err(transient)?;
    if let Some(hook) = &record.hook {
        record.pending_drops.retain(|n| {
            hook.live
                .get(n)
                .is_some_and(|t| pending.iter().any(|p| p.target_id == t.block_id))
        });
    }
    Ok(result)
}

fn wait_bound(config: &McModuleConfig, model: &str) -> u64 {
    let ttl = config.resolve_cache_ttl(Some(model));
    let millis = if let Some(minutes) = ttl.strip_suffix('m') {
        minutes
            .parse::<u64>()
            .ok()
            .map(|n| n.saturating_mul(60_000))
    } else if let Some(hours) = ttl.strip_suffix('h') {
        hours
            .parse::<u64>()
            .ok()
            .map(|n| n.saturating_mul(3_600_000))
    } else if let Some(seconds) = ttl.strip_suffix('s') {
        seconds.parse::<u64>().ok().map(|n| n.saturating_mul(1_000))
    } else {
        None
    };
    millis.unwrap_or(1_000).min(1_000)
}

impl McHandler {
    fn provider_work(
        &self,
        store: &McStore,
        binding: SessionBinding,
        key: Key,
    ) -> Result<Work, HandlerOutcome> {
        let route = self.route_project(store, &binding)?;
        Ok(Work {
            note_project_path: route.key.clone(),
            project_path: route.key,
            binding,
            key,
        })
    }

    pub(super) async fn provider_setup(
        &self,
        binding: SessionBinding,
        params: &Value,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        let request: compact::setup::SetupRequest = decode(params)?;
        let key = Key::new(&binding, &request.session, &request.harness)?;
        let chosen = preset(request.preset.as_deref())?;
        let store = self
            .store_for_request()
            .await
            .map_err(StoreRefusal::into_outcome)?;
        let _serial = self.provider_serial.lock().await;
        let mut record = self.provider_store.load(&key)?;
        if record.catalog.is_none() {
            record.catalog = self.provider_store.catalog(&SessionBinding {
                session: key.session.clone(),
                ..binding.clone()
            })?;
        }
        let work = self.provider_work(&store, binding, key.clone())?;
        if record.setup.is_none() {
            if !work.binding.config.compaction_enabled {
                return bytes(&compact::setup::SetupAnswer::Refuse {
                    request_id: request.request_id,
                    code: compact::errors::RefuseCode::Misconfigured,
                    reason: "Magic Context compaction is disabled".into(),
                    provider_code: None,
                });
            }
            let threshold = work
                .binding
                .config
                .resolve_execute_threshold(Some(&request.model))
                .percentage
                / 100.0;
            let id = format!(
                "mc-{}",
                sha256_hex(
                    format!(
                        "{}:{}:{}",
                        key.engine_key(),
                        request.request_id,
                        request.now
                    )
                    .as_bytes()
                )
            );
            record.setup = Some(Setup {
                request: request.clone(),
                state: transform::compaction::State::new(id, chosen),
                stability: if chosen == transform::compaction::Preset::Head {
                    vec![
                        compact::setup::StabilityRank { index: 0, rank: 2 },
                        compact::setup::StabilityRank { index: 1, rank: 1 },
                    ]
                } else {
                    vec![]
                },
                call_when: compact::setup::CallWhen::new(threshold),
            });
            // Persist the Setup before engine work. Re-entry can finish a Setup
            // killed between recording its inputs and producing its initial view.
            self.provider_store.save(&key, &record)?;
            fault("SetupRecorded");
        }
        if request.newest.is_some() {
            scan(
                &self.provider_store,
                self.provider_runner.as_ref(),
                &key,
                &mut record,
                request.lineage_id.as_deref(),
                &[],
                Instant::now() + Duration::from_millis(HOOK_BUDGET_MS),
            )
            .await?;
        }
        let mut normalized = status(params, &record)?;
        if normalized.lineage_id.is_empty() {
            normalized.lineage_id = request.lineage_id.clone().unwrap_or_default();
        }
        let high = record
            .setup
            .as_ref()
            .expect("setup")
            .state
            .version_high_water
            .checked_add(1)
            .ok_or_else(|| transient("compaction version exhausted"))?;
        record
            .setup
            .as_mut()
            .expect("setup")
            .state
            .version_high_water = high;
        self.provider_store.save(&key, &record)?;
        let initial = if let Some(mut initial) = record
            .setup
            .as_ref()
            .expect("setup")
            .state
            .last_applied
            .clone()
        {
            initial.version = high;
            let state = &mut record.setup.as_mut().expect("setup").state;
            state.last_produced = Some(initial.clone());
            state.last_applied = Some(initial.clone());
            initial
        } else {
            match execute(&store, &work, &mut record, &normalized, true)?.answer {
                transform::compaction::Answer::Replacement(initial) => initial,
                transform::compaction::Answer::Noop => {
                    return Err(transient("Setup did not produce an initial view"))
                }
            }
        };
        let setup = record.setup.as_ref().expect("setup");
        let answer = compact::setup::SetupAnswer::Ready {
            request_id: request.request_id,
            initial: checked_view(&initial, &record)?,
            stability: setup.stability.clone(),
            call_when: Some(setup.call_when.clone()),
        };
        record.last_answer = Some(serde_json::to_value(&answer).map_err(transient)?);
        self.provider_store.save(&key, &record)?;
        fault("AnswerRecorded");
        bytes(&answer)
    }

    pub(super) async fn provider_step(
        &self,
        binding: SessionBinding,
        params: &Value,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        // Usage can omit unreported fields. Decode the remainder with the role
        // type, but normalize the original measurements without filling holes.
        let mut wire = params.clone();
        wire.as_object_mut()
            .ok_or_else(|| invalid("step params must be an object"))?
            .remove("previous_usage");
        let request: compact::status::StepStatus = decode(&wire)?;
        let key = Key::new(&binding, &request.session, &request.harness)?;
        let store = self
            .store_for_request()
            .await
            .map_err(StoreRefusal::into_outcome)?;
        let _serial = self.provider_serial.lock().await;
        let mut record = self.provider_store.load(&key)?;
        if record.setup.is_none() {
            return Err(error(
                "setup_missing",
                "compaction.step requires a Setup record for this project and session",
            ));
        }
        let work = self.provider_work(&store, binding, key.clone())?;
        ingest(&mut record, &request.lineage_id, &request.messages)?;
        self.provider_store.save(&key, &record)?;
        fault("MessagesIngested");
        let normalized = status(params, &record)?;
        let complete = request
            .newest
            .as_ref()
            .is_none_or(|n| frontier(&record, &request.lineage_id) > n.ordinal);
        if !complete {
            let bound = wait_bound(&work.binding.config, &request.model);
            if bound == 0 {
                return Err(transient("prefix cache TTL does not permit waiting"));
            }
            record.wait_request = Some(request.request_id.clone());
            let answer = compact::answer::StepAnswer::Wait {
                request_id: request.request_id.clone(),
                reason: "Reading the remaining transcript".into(),
                bound_ms: bound,
            };
            record.last_answer = Some(serde_json::to_value(&answer).map_err(transient)?);
            self.provider_store.save(&key, &record)?;
            let storage = Arc::clone(&self.provider_store);
            let runner = Arc::clone(&self.provider_runner);
            let serial = Arc::clone(&self.provider_serial);
            tokio::spawn(async move {
                tokio::task::yield_now().await;
                fault("WaitAnswered");
                let _serial = serial.lock().await;
                let result = async {
                    let mut record = storage.load(&key)?;
                    if record.wait_request.as_deref() != Some(&request.request_id) {
                        return Ok(());
                    }
                    scan(
                        &storage,
                        runner.as_ref(),
                        &key,
                        &mut record,
                        Some(&request.lineage_id),
                        &[],
                        Instant::now() + Duration::from_millis(bound),
                    )
                    .await?;
                    let state = &mut record.setup.as_mut().expect("wait setup").state;
                    state.version_high_water = state
                        .version_high_water
                        .max(normalized.last_applied_version.unwrap_or(0))
                        .checked_add(1)
                        .ok_or_else(|| transient("version exhausted"))?;
                    storage.save(&key, &record)?;
                    if let transform::compaction::Answer::Replacement(view) =
                        execute(&store, &work, &mut record, &normalized, false)?.answer
                    {
                        checked_view(&view, &record)?;
                        record.wait_view = Some(view);
                    }
                    record.wait_request = None;
                    storage.save(&key, &record)?;
                    fault("WaitWorkDurable");
                    runner
                        .call(
                            &key.project,
                            &request.session,
                            "compaction.ready",
                            json!({"session":request.session,"request_id":request.request_id}),
                            Duration::from_millis(bound),
                        )
                        .await
                        .map_err(transient)?;
                    Ok::<(), HandlerOutcome>(())
                }
                .await;
                if let Err(error) = result {
                    tracing::warn!("mc-module: provider wait work failed: {error:?}");
                }
            });
            return bytes(&answer);
        }
        let state = &mut record.setup.as_mut().expect("setup").state;
        // Reserve before touching engine state. A crash can skip a number,
        // but cannot let a later answer reuse an allocated number.
        state.version_high_water = state
            .version_high_water
            .max(normalized.last_applied_version.unwrap_or(0))
            .max(normalized.last_not_applied.map_or(0, |n| n.version))
            .checked_add(1)
            .ok_or_else(|| transient("version exhausted"))?;
        self.provider_store.save(&key, &record)?;
        let output = execute(&store, &work, &mut record, &normalized, false)?;
        let produced = output.answer;
        if matches!(produced, transform::compaction::Answer::Replacement(_)) {
            record.wait_view = None;
        }
        let answer = match produced {
            transform::compaction::Answer::Noop => compact::answer::StepAnswer::Noop {
                request_id: request.request_id,
            },
            transform::compaction::Answer::Replacement(view) => {
                compact::answer::StepAnswer::CompactionMessage {
                    request_id: request.request_id,
                    compaction: checked_view(&view, &record)?,
                    coverage: None,
                }
            }
        };
        record.wait_request = None;
        record.last_answer = Some(serde_json::to_value(&answer).map_err(transient)?);
        self.provider_store.save(&key, &record)?;
        fault("AnswerRecorded");
        bytes(&answer)
    }
}
