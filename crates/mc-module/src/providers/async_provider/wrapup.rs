//! Internal explicit-wrapup drive. No runner-facing operation is registered here.
use super::*;
use crate::historian::{HistorianDriveOutcome, HistorianPublicationFence};

/// The setup reference identifies project/session/harness; lineage distinguishes
/// a runner's current transcript from an earlier incarnation of that session.
#[allow(dead_code)] // No public operation supplies an explicit-wrapup target yet.
pub(crate) struct AsyncWrapupTarget {
    pub reference: String,
    pub lineage: String,
}

#[derive(Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum AsyncWrapupAdmission {
    Accepted,
    UnknownConversation,
    AlreadyRunning,
    Ceiling,
}

struct Drive {
    reference: String,
    generation: u64,
    key: Key,
    binding: SessionBinding,
    parsed: TransformRequest,
    window: historian_tail::InputWindow,
    codec: codec::Codec,
    echoes: reminder_echoes::ReminderEchoes,
    cut_seed: Option<Arc<cut_seed::CutSeed>>,
    keep: usize,
    _guard: WrapupSessionGuard,
    permit: Arc<super::super::historian_budget::Permit>,
}

impl McHandler {
    /// Admit only the runner principal that set up this conversation, reserve
    /// bounded capacity, and return without waiting for model discovery,
    /// transcript decoding or the background summarizer session.
    #[allow(dead_code)]
    pub(crate) async fn request_async_wrapup(
        &self,
        binding: &SessionBinding,
        target: &AsyncWrapupTarget,
        keep: usize,
    ) -> Result<AsyncWrapupAdmission, HandlerOutcome> {
        let drive = match self.admit_async_wrapup(binding, target, keep).await? {
            Ok(drive) => drive,
            Err(refusal) => return Ok(refusal),
        };
        let worker = self.provider_historian_worker();
        tokio::spawn(async move {
            if let Err(error) = worker.finish_async_wrapup(&drive).await {
                tracing::warn!(?error, "async wrapup stopped");
            }
        });
        Ok(AsyncWrapupAdmission::Accepted)
    }

    /// Run the user-command wrapup to completion, waiting for the publication notification before returning.
    pub(super) async fn execute_async_wrapup_command(
        &self,
        binding: &SessionBinding,
        target: &AsyncWrapupTarget,
        keep: usize,
    ) -> Result<AsyncWrapupAdmission, HandlerOutcome> {
        let drive = match self.admit_async_wrapup(binding, target, keep).await? {
            Ok(drive) => drive,
            Err(refusal) => return Ok(refusal),
        };
        self.finish_async_wrapup(&drive).await?;
        Ok(AsyncWrapupAdmission::Accepted)
    }

    async fn admit_async_wrapup(
        &self,
        binding: &SessionBinding,
        target: &AsyncWrapupTarget,
        keep: usize,
    ) -> Result<Result<Drive, AsyncWrapupAdmission>, HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let Some(head) = load_head(store, &target.reference)? else {
            return Ok(Err(AsyncWrapupAdmission::UnknownConversation));
        };
        self.authorize_async(binding, &head)?;
        let _serial = self.provider_serial.lock_for(&head.key).await;
        let Some(state) = self.checkout(store, &target.reference)? else {
            return Ok(Err(AsyncWrapupAdmission::UnknownConversation));
        };
        let admitted = (|| {
            self.authorize_async(binding, &state)?;
            if state.lineage.as_deref() != Some(target.lineage.as_str()) {
                return Ok(Err(AsyncWrapupAdmission::UnknownConversation));
            }
            if state.resync || state.failed() {
                return Err(transient("async conversation is not ready for wrapup"));
            }
            let namespace = state.namespace();
            let guard = match self.try_claim_wrapup_session(&namespace) {
                Ok(guard) => guard,
                Err(_) => return Ok(Err(AsyncWrapupAdmission::AlreadyRunning)),
            };
            if self.live_historian_completion_wait(&namespace).is_some()
                || store
                    .load_meta(&namespace)
                    .map_err(transient)?
                    .meta
                    .historian
                    .state
                    != HistorianPhase::Idle
            {
                return Ok(Err(AsyncWrapupAdmission::AlreadyRunning));
            }
            let bytes = state.entries.values().map(|entry| entry.raw().len()).sum();
            let Some(permit) = self.provider_historian_budget.try_acquire(bytes) else {
                return Ok(Err(AsyncWrapupAdmission::Ceiling));
            };
            let (_, window) = historian_tail::applied_window(
                store,
                &namespace,
                &state.aggregates.historian_input,
            )?;
            Ok(Ok(Drive {
                reference: state.reference(),
                generation: state.generation,
                key: state.key.clone(),
                binding: self.async_binding(&state),
                parsed: self.async_historian_request(&state)?,
                window: window.through(state.entries.last_key_value().map(|(ordinal, _)| *ordinal)),
                codec: codec::Codec::from_params(&Value::Object(state.setup.params.clone()))?,
                echoes: state.reminder_echoes.clone(),
                cut_seed: state.cut_seed.clone(),
                keep: keep.max(1),
                _guard: guard,
                permit,
            }))
        })();
        self.checkin(state);
        admitted
    }

    async fn finish_async_wrapup(&self, drive: &Drive) -> Result<(), HandlerOutcome> {
        let reference = drive.reference.clone();
        let namespace = drive.parsed.session_id.clone();
        let store = self.store.get().expect("admitted wrapup has a store");
        let before = store.load_compartments(&namespace).map(|rows| rows.len());
        // Keep the admission guard and memory charge through publication wake.
        let result = self.drive_async_wrapup(drive).await;
        let after = store.load_compartments(&namespace).map(|rows| rows.len());
        if matches!((before, after), (Ok(before), Ok(after)) if after > before) {
            self.publish_async_wake(&reference).await?;
        }
        result
    }
}

impl McHandler {
    async fn drive_async_wrapup(&self, drive: &Drive) -> Result<(), HandlerOutcome> {
        let store = Arc::clone(
            self.store
                .get()
                .ok_or_else(|| transient("store unavailable"))?,
        );
        let deadline = Instant::now()
            .checked_add(self.wrapup_operation_budget())
            .unwrap_or_else(Instant::now);
        let settings = self.historian_settings_loader()(&drive.binding.project_root);
        let configured = super::super::historian_config::resolve_with_model_catalog(
            &settings,
            &drive.key.harness,
            drive.parsed.model_key.as_deref(),
            &drive.binding.project_root,
            &self.historian_model_catalog,
        )
        .await;
        let mut parsed = drive.parsed.clone();
        parsed.historian_model_limits = configured.model_limits;
        let reference = drive.reference.clone();
        let window = drive.window;
        let codec = drive.codec;
        let echoes = drive.echoes.clone();
        let cut_seed = drive.cut_seed.clone();
        let prepare = self.provider_historian_worker();
        let input_store = Arc::clone(&store);
        let binding = drive.binding.clone();
        let keep = drive.keep;
        let permit = Arc::clone(&drive.permit);
        let (parsed, projection, plan, project_path) = tokio::task::spawn_blocking(move || {
            // A blocking decoder can outlive its awaiting task during shutdown.
            let _permit = permit;
            let projection = historian_tail::prepare_cut_input(
                &input_store,
                &reference,
                window,
                codec,
                &mut parsed,
                &echoes,
                cut_seed
                    .as_ref()
                    .and_then(|seed| seed.historian_prelude.as_ref()),
            )?;
            let messages = wrapup_boundary_messages(&parsed, &projection, &prepare.boundary_tokens);
            let end = input_store
                .load_compartments(&parsed.session_id)
                .map_err(transient)?
                .iter()
                .map(|compartment| compartment.end_message as u64)
                .max();
            let config = prepare.effective_config(&binding.project_root);
            let (limit, _, _) = usage_numbers(parsed.usage.as_ref(), parsed.geometry.as_ref());
            let threshold = parsed.execute_threshold_or(
                config
                    .resolve_execute_threshold(parsed.model_key.as_deref())
                    .percentage,
            );
            let plan =
                boundary::resolve_wrapup_boundary(&messages.messages, end, keep, limit, threshold);
            // Fact promotion uses project identity, not the checkout directory.
            // Resolve it once so every chunk in this drain uses the same key.
            let project_path = match input_store
                .session_project_identity(&binding.session)
                .map_err(transient)?
            {
                Some(identity) => identity,
                None => {
                    prepare
                        .binding_fallback_project(
                            &input_store,
                            &binding,
                            &BindingProject::default(),
                        )?
                        .key
                }
            };
            Ok::<_, HandlerOutcome>((Arc::new(parsed), Arc::new(projection), plan, project_path))
        })
        .await
        .map_err(transient)??;
        self.establish_async_wrapup_identities(drive, &projection)
            .await?;
        let fence: Arc<dyn HistorianPublicationFence> = Arc::new(AsyncHistoryFence {
            reference: drive.reference.clone(),
            generation: drive.generation,
            key: drive.key.clone(),
            serial: Arc::clone(&self.provider_serial),
        });
        let mut unknown_module_observed = false;
        loop {
            if Self::remaining_wrapup_budget(deadline).is_none() {
                return Err(transient("async wrapup budget exhausted"));
            }
            let head = load_head(&store, &drive.reference)?
                .ok_or_else(|| transient("async conversation disappeared"))?;
            if head.generation != drive.generation || head.resync {
                return Err(transient("async wrapup lineage changed"));
            }
            let end = store
                .load_compartments(&parsed.session_id)
                .map_err(transient)?
                .iter()
                .map(|compartment| compartment.end_message as u64)
                .max();
            if !wrapup_has_remaining_messages(
                &parsed.messages,
                end,
                plan.target_protected_start_ordinal,
            ) {
                return Ok(());
            }
            let prepare = self.provider_historian_worker();
            let round_store = Arc::clone(&store);
            let round_parsed = Arc::clone(&parsed);
            let projection = Arc::clone(&projection);
            let boundary = plan.boundary.clone();
            let binding = drive.binding.clone();
            let fence = Arc::clone(&fence);
            let permit = Arc::clone(&drive.permit);
            let project_path = project_path.clone();
            let action = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                prepare.prepare_wrapup_fire(
                    round_store,
                    &round_parsed,
                    &binding,
                    &projection,
                    &boundary,
                    WrapupPrepareContext {
                        now: now_ms(),
                        project_path,
                        allow_unknown_module_retry: unknown_module_observed,
                        publication_fence: Some(fence),
                    },
                )
            })
            .await
            .map_err(transient)?;
            match action {
                PreparedWrapupAction::Busy(completion) => {
                    let budget = Self::active_firing_join_budget(
                        parsed.historian_model_chain.as_deref(),
                        parsed.historian_timeout_ms,
                    );
                    self.await_wrapup_historian_completion(completion, deadline, budget)
                        .await
                        .map_err(transient)?;
                    continue;
                }
                PreparedWrapupAction::Nothing(reason) | PreparedWrapupAction::Failed(reason) => {
                    return Err(transient(reason));
                }
                PreparedWrapupAction::FilteredNoiseSkipped => {}
                PreparedWrapupAction::FireReady(task) => {
                    match self.run_wrapup_firing(*task, deadline).await {
                        Ok(HistorianDriveOutcome::Completed(_)) => {}
                        Ok(HistorianDriveOutcome::Busy(_)) => {
                            return Err(transient("historian became busy"));
                        }
                        Err(WrapupFiringError::UnknownModule(detail))
                            if !unknown_module_observed =>
                        {
                            unknown_module_observed = true;
                            let delay = self.unknown_module_retry_delay();
                            let remaining = Self::remaining_wrapup_budget(deadline)
                                .ok_or_else(|| transient("async wrapup budget exhausted"))?;
                            if delay > remaining {
                                return Err(transient(detail));
                            }
                            tokio::time::sleep(delay).await;
                            continue;
                        }
                        Err(
                            WrapupFiringError::Retryable(detail)
                            | WrapupFiringError::Terminal { detail, .. }
                            | WrapupFiringError::UnknownModule(detail),
                        ) => return Err(transient(detail)),
                    }
                }
            }
            let after = store
                .load_compartments(&parsed.session_id)
                .map_err(transient)?
                .iter()
                .map(|compartment| compartment.end_message as u64)
                .max();
            if after <= end {
                return Err(transient("async wrapup made no forward progress"));
            }
        }
    }

    async fn establish_async_wrapup_identities(
        &self,
        drive: &Drive,
        projection: &crate::ck_wire::FlatProjection,
    ) -> Result<(), HandlerOutcome> {
        let _serial = self.provider_serial.lock_for(&drive.key).await;
        let store = Arc::clone(
            self.store
                .get()
                .ok_or_else(|| transient("store unavailable"))?,
        );
        let head = load_head(&store, &drive.reference)?
            .ok_or_else(|| transient("async conversation disappeared"))?;
        if head.generation != drive.generation || head.resync {
            return Err(transient("async wrapup lineage changed"));
        }
        let namespace = drive.parsed.session_id.clone();
        let identities = projection.identity_by_mid.clone();
        let permit = Arc::clone(&drive.permit);
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            // Before a first view, per-message identity vectors may be missing
            // from storage. Persist missing vectors without changing cached
            // messages; the store refuses vectors that conflict with stored values
            // and writes nothing in that case.
            let Some(row_version) = store.load_meta(&namespace).map_err(transient)?.row_version
            else {
                if identities.is_empty() {
                    return Ok(());
                }
                return Err(transient(
                    "async wrapup has no cache state to record identities",
                ));
            };
            match store.commit_block_identities(&namespace, row_version, &identities) {
                Ok(_) => Ok(()),
                Err(mc_store::McStoreError::BlockIdentityConflict { mid, .. }) => Err(transient(
                    format!("async wrapup source identity changed: {mid}"),
                )),
                Err(error) => Err(transient(error)),
            }
        })
        .await
        .map_err(transient)?
    }
}
