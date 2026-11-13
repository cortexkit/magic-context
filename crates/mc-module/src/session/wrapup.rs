use super::user_commands::{number, outcome_unknown, wall_now, MAX_ANSWERS};
use super::*;
use cortexkit_role_user_commands::{
    ErrorBody, Fact, FactValue, ModuleRunRequest, Preview, RunReply,
};
use sha2::{Digest, Sha256};

/// The exclusive boundary is anchored to a message id so a revert cannot
/// silently redirect a pending wrapup to different history at the same ordinal.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Target {
    pub until: u64,
    pub last_mid: String,
}

impl Session {
    fn wrapup_boundary(&self, settings: &Settings, keep: u64) -> u64 {
        let from = self.summarized_through().map_or(1, |n| n + 1);
        let entries = self.index.entries();
        let raw: Vec<_> = entries.iter().filter(|e| e.ordinal >= from).collect();
        if keep >= raw.len() as u64 {
            return from;
        }
        if keep == 0 {
            return raw.last().map_or(from, |e| e.ordinal + 1);
        }
        let candidate = raw[raw.len() - keep as usize].ordinal;
        let budget = trigger::trigger_budget(
            pass::usable_window(&self.conditions),
            settings.execute_threshold_percentage,
        )
        .clamp(2_000, 48_000);
        let prompt = raw
            .iter()
            .rev()
            .find(|e| e.ordinal <= candidate && trigger::is_meaningful_user(e));
        match prompt {
            Some(prompt)
                if raw
                    .iter()
                    .filter(|e| e.ordinal >= prompt.ordinal && e.ordinal < candidate)
                    .map(|e| entry_tokens(e))
                    .sum::<u64>()
                    <= budget =>
            {
                prompt.ordinal
            }
            _ => candidate,
        }
    }

    pub(crate) fn wrapup_preview(&self, settings: &Settings, keep: u64) -> Preview {
        if !self.command_managed() {
            return crate::user_commands::unavailable();
        }
        let from = self.summarized_through().map_or(1, |n| n + 1);
        let until = self.wrapup_boundary(settings, keep);
        let entries = self.index.entries();
        let head: Vec<_> = entries
            .iter()
            .filter(|e| e.ordinal >= from && e.ordinal < until)
            .collect();
        let raw = entries.iter().filter(|e| e.ordinal >= from).count();
        let reason = if !self.features.summarizer {
            Some("summarizer_disabled")
        } else if raw == 0 {
            Some("nothing_to_summarize")
        } else if keep >= raw as u64 {
            Some("within_keep")
        } else if head.is_empty() {
            Some("no_safe_boundary")
        } else {
            None
        };
        let stamp = serde_json::json!({
            "keep": keep, "from": from, "until": until,
            "entries": entries.iter().filter(|e| e.ordinal >= from).map(|e| (&e.mid, e.ordinal, &e.digest)).collect::<Vec<_>>(),
            "summaries": self.summaries.revision(), "reason": reason,
            "running": self.summarizing, "target": self.wrapup_target,
            "wait": self.account_wait.as_ref().map(|w| (&w.refusal.code, w.refusal.until_ms)),
            "usable": pass::usable_window(&self.conditions),
            "threshold": settings.execute_threshold_percentage,
            "no_progress": self.no_progress, "failure_at": self.drain.failure_at,
        });
        let version = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&stamp).expect("wrapup stamp"))
        );
        let mut preview = Preview::new(version, reason.is_none());
        preview.reason = reason.map(str::to_owned);
        if reason.is_none() {
            preview.effect = Some("Shrinks context on the next rebuild, or at once at its rebuild threshold. flush applies published summaries now.".into());
            let (label, state) = if self.summarizing {
                ("Summary already running; target waits", "building")
            } else if self.summaries_wait_for_account() {
                ("Account wait; target waits too", "paused")
            } else if self.drain.in_failure_backoff(self.clock()) {
                ("Summary failure backoff; target waits", "paused")
            } else {
                ("Summary ready; failures pause remaining work", "ready")
            };
            preview.facts = Some(vec![
                number(
                    "To summarize",
                    head.len() as u64,
                    "count",
                    Some("messages"),
                    false,
                ),
                number(
                    "Raw history",
                    head.iter().map(|e| entry_tokens(e)).sum(),
                    "tokens",
                    None,
                    true,
                ),
                number(
                    "Stay raw",
                    raw as u64 - head.len() as u64,
                    "count",
                    Some("messages"),
                    false,
                ),
                Fact::new(label, FactValue::state(state)),
                Fact::new(
                    "Uses a model; may take several summary runs",
                    FactValue::state("ready"),
                ),
                Fact::new(
                    "Raw text recoverable with ctx_expand",
                    FactValue::state("ready"),
                ),
            ]);
            if let Some(wait) = &self.account_wait {
                preview
                    .facts
                    .as_mut()
                    .expect("available facts")
                    .push(number(
                        "Account wait until (epoch ms)",
                        wait.refusal.until_ms.max(0) as u64,
                        "duration",
                        None,
                        false,
                    ));
            }
        }
        preview
    }

    pub(super) fn wrapup_command_run(
        &mut self,
        settings: &Settings,
        request: &ModuleRunRequest,
        digest: String,
    ) -> Result<RunReply, ErrorBody> {
        let keep = crate::user_commands::messages_to_keep(&request.args)?;
        let preview = self.wrapup_preview(settings, keep);
        if preview.version != request.preview_version {
            return Ok(RunReply::new("preview_stale"));
        }
        if let Some(reason) = preview.reason {
            return Ok(RunReply::new(reason));
        }
        if self.command_answers.len() >= MAX_ANSWERS {
            return Err(ErrorBody::new(
                "command_capacity",
                "Command answer storage is full for this session.",
            ));
        }
        let before = self.command_snapshot();
        let until = self.wrapup_boundary(settings, keep);
        let Some(last) = self
            .index
            .entries()
            .iter()
            .rev()
            .find(|e| e.ordinal < until)
        else {
            return Err(outcome_unknown());
        };
        self.wrapup_target = Some(Target {
            until,
            last_mid: last.mid.clone(),
        });
        self.no_progress = None;
        let mut reply = RunReply::new("scheduled");
        reply.facts = preview.facts;
        Arc::make_mut(&mut self.command_answers).push(crate::store::CommandAnswer {
            request_id: request.request_id.clone(),
            request_digest: digest,
            answer: reply.clone(),
            stored_at: wall_now(),
            principal: cortexkit_role_user_commands::ADMITTED_CALLER.into(),
            caller: request.caller.clone(),
        });
        // Save the target and answer before the worker can start any child.
        if self.save().is_err() {
            self.install_command_snapshot(before);
            return Err(outcome_unknown());
        }
        Ok(reply)
    }

    pub(crate) fn pending_wrapup_summary(&mut self, settings: &Settings) -> Option<run::Request> {
        if !self.command_managed() || self.wrapup_target.is_none() {
            return None;
        }
        self.summary_due(settings)
    }

    pub(super) fn wrapup_summary_due(&mut self, settings: &Settings) -> Option<run::Request> {
        if self.summarizing || !self.features.summarizer {
            return None;
        }
        let target = self.wrapup_target.as_ref()?;
        let from = self.summarized_through().map_or(1, |n| n + 1);
        if from >= target.until
            || !self
                .index
                .entries()
                .iter()
                .any(|e| e.ordinal + 1 == target.until && e.mid == target.last_mid)
        {
            self.wrapup_target = None;
            return None;
        }
        let target_until = target.until;
        if self.waits_for_new_history(false) {
            return None;
        }
        let usage = pass::usage(&self.pressure()).unwrap_or(0.0) * 100.0;
        let admitted = self.account_wait_admits(usage)?;
        let window = pass::usable_window(&self.conditions);
        let cap = trigger::per_run_cap(window, settings.execute_threshold_percentage, usage);
        let until = trigger::cap_run(
            self.index.entries(),
            entry_removed_tokens,
            from,
            target_until,
            cap,
        );
        let requested = self
            .index
            .entries()
            .iter()
            .filter(|e| e.ordinal >= from && e.ordinal < until)
            .map(entry_removed_tokens)
            .sum();
        let quota = crate::summary::drain::Usage {
            now: self.clock(),
            percentage: usage,
            threshold: settings.execute_threshold_percentage,
            force: pass::in_force_band(&self.pressure(), settings),
            usable: window,
            per_run_cap: cap,
        };
        self.reservation = Some(self.drain.reserve_wrapup(&quota, requested)?);
        self.note_account_run(admitted, usage);
        self.run_start = Some(RunStart {
            lift: None,
            emergency: usage >= 95.0,
        });
        Some(self.begin_summary(settings, from, until, false, until == target_until))
    }
}
