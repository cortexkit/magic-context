//! The `ctx_reduce` and `ctx_keep` reminders a pass sends.

use super::*;

impl Session {
    /// Send the `ctx_reduce` reminders this pass calls for (see
    /// [`crate::nudges`]), measured on what the model sees now.
    pub(super) async fn remind<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        rebuilt: bool,
        cut_moved: bool,
    ) {
        let _timing = crate::notice_cost_timing::span("session.remind");
        if self.index.entries().is_empty() {
            return;
        }
        let edited = self.edited(None);
        let context = lanes::Context {
            index: &self.index,
            edited: &edited,
            protected_tools: &settings.protected_tools,
            keep_first_message: self.features.keep_first_message,
            signed_floor: self.signed_floor(),
        };
        let floor = settings.protected_tokens.unwrap_or_else(|| {
            lanes::default_protected_tokens(pass::usable_window(&self.conditions))
        });
        let protected_from = lanes::protected_cutoff(&context, floor);
        let measurement = crate::nudges::measure(&context, protected_from, &self.queued);
        let turns = self.pruned_turns + crate::nudges::person_turns(self.index.entries());
        let reminders = self.nudges.decide(&measurement, rebuilt, turns, cut_moved);
        let sends = [
            (reminders.tool_result, crate::nudges::REMINDER_KIND),
            (reminders.ceiling, crate::nudges::CEILING_KIND),
        ];
        for (template, kind) in sends {
            let Some(template) = template else {
                continue;
            };
            if kind == crate::nudges::CEILING_KIND {
                self.nudges.ceiling_sent = false;
            }
            let Some(send_id) = self.next_reminder_id(kind) else {
                continue;
            };
            let request = self.reminder(client, send_id, template, kind).await;
            if let Err(error) = client.send(&self.key, request).await {
                tracing::warn!(
                    "ck-mc: session {}: session.send failed: {error:?}",
                    self.key.session
                );
            } else if kind == crate::nudges::CEILING_KIND {
                self.nudges.ceiling_sent = true;
            }
        }
    }

    /// ck-mc measures usage only from the conditions' `last_prompt_tokens`.
    /// A runner that leaves it out while its steps report usage keeps the
    /// session below every threshold for good, so say so once per session.
    pub(super) fn warn_if_prompt_size_missing(
        &mut self,
        entries: &[cortexkit_role_compaction::read::Entry],
    ) {
        if self.warned_no_prompt || self.conditions.last_prompt_tokens.is_some() {
            return;
        }
        let reported = entries
            .iter()
            .rev()
            .find_map(|entry| entry.usage.as_ref().and_then(|usage| usage.prompt_tokens));
        if let Some(prompt) = reported {
            self.warned_no_prompt = true;
            tracing::warn!(
                "ck-mc: session {}: the runner's conditions carry no last_prompt_tokens, though its steps report usage ({prompt} prompt tokens); no threshold can be reached",
                self.key.session
            );
        }
    }

    /// Reserve the id before delivery: a crash after sending must not let a
    /// restarted process reuse an id the runner already accepted.
    /// The namespace keeps new ids distinct from persisted runner keys that
    /// used notice numbers or view versions instead of a counter.
    fn next_reminder_id(&mut self, kind: &str) -> Option<String> {
        self.reminder_counter = self.reminder_counter.checked_add(1)?;
        if let Some(store) = &self.store {
            if let Err(error) = store.save(&self.key, &self.durable()) {
                tracing::warn!("ck-mc: {error}");
                return None;
            }
        }
        Some(format!("{kind}:counter:{}", self.reminder_counter))
    }

    /// After a pass at the execute threshold, a session with `ctx_keep` whose
    /// lanes freed (or lined up) less than `keep_min_recovery_percentage` of
    /// the usable window is asked, once per stay over the threshold, to call `ctx_keep`.
    /// The request goes as a notice message: the model has to act on it, and
    /// no tool result may come before the context runs out.
    pub(super) async fn ask_for_keep_if_short<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        freed: u64,
    ) {
        let usable = pass::usable_window(&self.conditions);
        // A setting of 100 asks on every such pass.
        let every_pass = settings.keep_min_recovery_percentage >= 100.0;
        if !self.features.ctx_keep
            || (self.keep_requested && !every_pass)
            || usable == 0
            || freed as f64 >= usable as f64 * settings.keep_min_recovery_percentage / 100.0
        {
            return;
        }
        let usage = pass::usage(&self.pressure()).unwrap_or(0.0) * 100.0;
        // One request per stay over the threshold, with a durable send id
        // independent of the view version that crossed it.
        let Some(send_id) = self.next_reminder_id(KEEP_KIND) else {
            return;
        };
        let request = self
            .reminder(
                client,
                send_id,
                crate::nudges::keep_request(usage, freed),
                KEEP_KIND,
            )
            .await;
        match client.send(&self.key, request).await {
            Ok(_) => self.keep_requested = true,
            Err(error) => tracing::warn!(
                "ck-mc: session {}: session.send failed: {error:?}",
                self.key.session
            ),
        }
    }

    /// Resolve delivery at send time through the runner-connection describe
    /// cache; Setup and reconnect can withdraw support between sends.
    pub(super) async fn reminder<C: RunnerClient>(
        &self,
        client: &C,
        send_id: String,
        template: TemplateUse,
        kind: &str,
    ) -> SendRequest {
        let cleared = client.turn_system_cleared(&self.key).await;
        SendRequest::template(
            send_id,
            &DeliveryOrder::new(crate::nudges::delivery(&template.id, cleared))
                .with_dedupe_key(kind)
                .with_template(template),
        )
    }

    /// The runner's soft budget is diagnostic only. Log existing counts at a
    /// crossing without walking or serializing the potentially large index.
    pub(super) fn log_window_budget(&mut self) {
        let flagged = self.conditions.window_over_budget == Some(true);
        if flagged && !self.window_over_budget {
            tracing::info!(
                "ck-mc: session {}: window_over_budget: {} entries; stated budget entries {:?}, bytes {:?} (None means no bound stated)",
                self.key.session, self.index.entries().len(),
                self.limits.window_entries, self.limits.window_bytes
            );
            if self.limits.window_entries.is_none() && self.limits.window_bytes.is_none() {
                tracing::warn!("ck-mc: session {}: runner fault: window_over_budget without a stated window budget", self.key.session);
            }
        }
        self.window_over_budget = flagged;
    }
}
