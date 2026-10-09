//! Pure declarations, write-time hooks and runner-bound reduction tools.
use super::*;

pub fn declaration(params: &Value) -> Result<hooks::subscription::Declaration, HandlerOutcome> {
    use hooks::subscription::{Declaration, DeclaredSubscription as Sub, Hook, OnUnavailable, Op};
    let request: hooks::subscription::DeclareRequest = decode(params)?;
    preset(request.preset.as_deref())?;
    // These edits optimise a single new subject. Broca freezes unavailable
    // outcomes too, so a missed tag, strip or reminder must pass through rather
    // than fail the user's turn; any still-due append targets a later subject.
    let mut subscriptions = vec![
        Sub::new(Hook::PreUser, vec![Op::Append], HOOK_BUDGET_MS)
            .with_on_unavailable(OnUnavailable::Pass),
        Sub::new(
            Hook::PostTool,
            vec![Op::Prepend, Op::Append],
            HOOK_BUDGET_MS,
        )
        .with_on_unavailable(OnUnavailable::Pass),
    ];
    let reduction_owner = request.composition.is_none()
        || request
            .composition
            .as_ref()
            .and_then(|c| c.get("compaction"))
            .and_then(|c| c.get("provider"))
            .and_then(Value::as_str)
            == Some(DEFAULT_MODULE_ID);
    if reduction_owner {
        subscriptions.push(
            Sub::new(Hook::PostAssistant, vec![Op::Replace], HOOK_BUDGET_MS)
                .with_on_unavailable(OnUnavailable::Pass),
        );
    }
    Ok(Declaration { subscriptions })
}

impl McHandler {
    pub(super) async fn provider_hook(
        &self,
        binding: SessionBinding,
        params: &Value,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        use hooks::{
            answer::{HookAnswer, Operation},
            subscription::Hook,
        };
        let deadline = Instant::now() + Duration::from_millis(HOOK_BUDGET_MS);
        let call: hooks::hook::HookCall = decode(params)?;
        preset(call.preset.as_deref())?;
        let key = Key::new(&binding, &call.session, &call.harness)?;
        if call.lineage_id.is_none() && call.subject.hook() != Hook::PreUser {
            return Err(invalid("lineage_id is required after the first pre_user"));
        }
        let _store = self
            .store_for_request()
            .await
            .map_err(StoreRefusal::into_outcome)?;
        let _serial = self.provider_serial.lock().await;
        let mut record = self.provider_store.load(&key)?;
        record.hook.get_or_insert_with(HookState::default);
        if record.catalog.is_none() {
            record.catalog = self.provider_store.catalog(&SessionBinding {
                session: key.session.clone(),
                ..binding.clone()
            })?;
        }
        let mut declaration_params = json!({"preset":call.preset,"params":call.params});
        let compacting =
            record.setup.is_some() || record.catalog.as_ref().is_some_and(|c| c.compacting);
        if compacting {
            declaration_params["composition"] =
                json!({"compaction":{"provider":DEFAULT_MODULE_ID}});
        }
        let declared = declaration(&declaration_params)?;
        let subscription = declared
            .subscriptions
            .iter()
            .find(|s| s.hook == call.subject.hook() && s.phase == call.subject.phase());
        let Some(subscription) = subscription else {
            self.provider_store.save(&key, &record)?;
            return Err(error(
                "not_subscribed",
                "hook is not declared for this plan item",
            ));
        };
        let hook_kind = call.subject.hook();
        let reminder_every = call
            .params
            .get("reminder_every")
            .and_then(Value::as_u64)
            .unwrap_or(5)
            .max(1);
        let nudge_every = call
            .params
            .get("nudge_every")
            .and_then(Value::as_u64)
            .unwrap_or(5)
            .max(1);
        let due = |record: &Record| {
            let state = record.hook.as_ref().expect("hook state");
            match hook_kind {
                Hook::PostTool => {
                    state
                        .observed_tools
                        .saturating_add(1)
                        .saturating_sub(state.last_reminder_at.unwrap_or(0))
                        >= reminder_every
                }
                Hook::PreUser => {
                    state.last_nudge_at.is_none()
                        || state
                            .observed_users
                            .saturating_add(1)
                            .saturating_sub(state.last_nudge_at.unwrap_or(0))
                            >= nudge_every
                }
                _ => false,
            }
        };
        let mut observed = true;
        if due(&record)
            && call.lineage_id.is_some()
            && !call.subject.blocks().unwrap_or_default().is_empty()
        {
            observed = scan(
                &self.provider_store,
                self.provider_runner.as_ref(),
                &key,
                &mut record,
                call.lineage_id.as_deref(),
                &[],
                deadline,
            )
            .await
            .is_ok();
        }
        let mut ops = Vec::new();
        let mut tags = Vec::new();
        let blocks = call.subject.blocks().unwrap_or_default();
        if hook_kind == Hook::PostAssistant {
            static TAG: OnceLock<regex::Regex> = OnceLock::new();
            let regex = TAG.get_or_init(|| regex::Regex::new(r"§[0-9]+§ ?").expect("tag regex"));
            for (index, text) in blocks.iter().enumerate() {
                let clean = regex.replace_all(text, "").into_owned();
                if clean != *text {
                    ops.push(Operation::Replace {
                        block: index as u32,
                        value: clean,
                        note: None,
                    });
                }
            }
        } else if hook_kind == Hook::PostTool && !blocks.is_empty() {
            let state = record.hook.as_mut().expect("hook state");
            state.high_water = state
                .high_water
                .checked_add(1)
                .filter(|n| *n <= i64::MAX as u64)
                .ok_or_else(|| transient("tag numbers exhausted"))?;
            tags.push(state.high_water);
            ops.push(Operation::Prepend {
                block: 0,
                text: format!("§{}§ ", state.high_water),
                note: None,
            });
        }
        let cadence = observed && Instant::now() < deadline && due(&record) && !blocks.is_empty();
        if cadence {
            let text = if hook_kind == Hook::PostTool {
                "\n\n<system-reminder>Release tool output you no longer need with ctx_reduce; queued content remains visible until a compaction pass.</system-reminder>"
            } else {
                "\n\n<system-reminder>Keep useful context and release obsolete tool output with ctx_reduce when available.</system-reminder>"
            };
            ops.push(Operation::Append {
                block: (blocks.len() - 1) as u32,
                text: text.into(),
                note: None,
            });
        }
        let answer = if ops.is_empty() {
            HookAnswer::Pass
        } else {
            HookAnswer::Ops { ops: ops.clone() }
        };
        hooks::answer::check_answer(&call.subject, &subscription.ops, None, &answer)
            .map_err(|e| transient(e.name()))?;
        let rendered = hooks::answer::apply_ops(blocks, &ops).map_err(|e| transient(e.name()))?;
        let subject = sha256_hex(&serde_json::to_vec(&call.subject).map_err(transient)?);
        let state = record.hook.as_mut().expect("hook state");
        for old in &state.answers {
            if old.subject == subject && !old.observed {
                state.burned.extend(old.tags.iter().copied());
            }
        }
        let tool_call_id = match &call.subject {
            hooks::hook::Subject::PostTool { tool_call_id, .. } => Some(tool_call_id.clone()),
            _ => None,
        };
        state.answers.push(HookRecord {
            subject,
            lineage: call.lineage_id,
            answer: answer.clone(),
            rendered,
            tags,
            cadence,
            observed: false,
            tool_call_id,
        });
        self.provider_store.save(&key, &record)?;
        fault("HookStateRecorded");
        bytes(&answer)
    }

    pub(crate) async fn handle_provider_reduce(
        &self,
        channel: u16,
        requested: &[u64],
    ) -> HandlerOutcome {
        let result:Result<HandlerOutcome,HandlerOutcome>=async {
            let binding=self.facade_binding(channel).map_err(|_|session_unresolved_error())?;
            let _serial=self.provider_serial.lock().await;
            let key=self.provider_store.tool_key(&binding)?;
            let mut record=self.provider_store.load(&key)?;
            let needs_read=requested.iter().any(|n|record.hook.as_ref().is_none_or(|h|!h.live.contains_key(n)&&!h.burned.contains(n)));
            if needs_read {
                let lineage=record.messages.keys().next_back().cloned();
                scan(&self.provider_store,self.provider_runner.as_ref(),&key,&mut record,lineage.as_deref(),requested,Instant::now()+Duration::from_millis(HOOK_BUDGET_MS)).await?;
            }
            let live=record.hook.as_ref().map(|h|&h.live);
            let (known,unknown):(Vec<_>,Vec<_>)=requested.iter().copied().partition(|n|live.is_some_and(|l|l.contains_key(n)));
            let already=known.iter().copied().filter(|n|record.pending_drops.contains(n)).collect::<Vec<_>>();
            let queue=known.iter().copied().filter(|n|!record.pending_drops.contains(n)).collect::<Vec<_>>();
            record.pending_drops.extend(queue.iter().copied());
            self.provider_store.save(&key,&record)?;
            let detail=ctx_reduce_ack_details(&unknown,&already);
            if queue.is_empty() {return Ok(tool_error_result(format!("Refused: no valid tags to queue. {detail}")));}
            let store = self.store_for_request().await.map_err(StoreRefusal::into_outcome)?;
            let engine_key = key.engine_key();
            let meta = store.load_meta(&engine_key).map_err(transient)?.meta;
            let tags = store.load_tags_for_session(&engine_key).map_err(transient)?;
            let floor = meta.protected_tokens_effective.unwrap_or_else(|| {
                binding.config.resolve_protected_tokens(
                    record.setup.as_ref().and_then(|s| s.request.context_window).unwrap_or(200_000),
                ).floor
            });
            let ratio = meta.decision_calibration.as_ref()
                .and_then(decision_calibration::DecisionCalibration::from_frozen)
                .unwrap_or_else(decision_calibration::DecisionCalibration::neutral).tools_ratio;
            let window = protection_window::ProtectionWindow::from_persisted_rows_calibrated(&tags, floor, ratio);
            let (held, immediate): (Vec<_>, Vec<_>) = queue.iter().copied().partition(|number| {
                window.tag_numbers.tag_numbers.contains(&protection_window::TagNumber(*number as i64))
                    || live.and_then(|tags| tags.get(number)).is_some_and(|tag| meta.protected_tool_block_ids.contains(&tag.block_id))
            });
            // Queue protected targets durably, but do not promise release on the
            // next compaction: newer work must first displace their protection.
            let mut reply = String::new();
            if !immediate.is_empty() { reply = format!("Queued: drop {}. ", format_tag_numbers(&immediate)); }
            if !held.is_empty() { reply.push_str(&ctx_reduce_held_reply(&held)); reply.push(' '); }
            reply.push_str(&detail);
            reply.push_str(" Marking QUEUES content for release. It stays fully visible until it is actually released, which may be the next turn or many turns later.");
            Ok(mcp_text_result(reply,false))
        }.await;
        match result {
            Ok(answer) => answer,
            Err(error) => {
                let message =
                    format!("Transcript observation incomplete; retry ctx_reduce: {error:?}");
                let HandlerOutcome::Response(bytes) = tool_error_result(message) else {
                    unreachable!()
                };
                let mut value: Value = serde_json::from_slice(&bytes).expect("tool error JSON");
                value["retryable"] = json!(true);
                respond(value)
            }
        }
    }
}
