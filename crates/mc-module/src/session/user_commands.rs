use super::*;
use cortexkit_role_user_commands::{
    ErrorBody, Fact, FactValue, Figure, ModuleRunRequest, Preview, RunReply,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const ANSWER_RETENTION_MS: i64 = 24 * 60 * 60 * 1000;
// A person would have to flush more than ten times an hour to fill this in a
// day. The cap bounds each session document without retiring a live answer.
const MAX_ANSWERS: usize = 256;

fn wall_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |time| time.as_millis() as i64)
}

fn outcome_unknown() -> ErrorBody {
    ErrorBody::new(
        "unavailable",
        "The command outcome could not be recorded; retry with the same request_id.",
    )
}

fn number(label: &str, value: u64, unit: &str, noun: Option<&str>, approx: bool) -> Fact {
    let mut data = FactValue::number(value as f64);
    data.unit = Some(unit.into());
    data.noun = noun.map(str::to_owned);
    data.approx = approx.then_some(true);
    Fact::new(label, data)
}

fn ratio(label: &str, value: f64) -> Fact {
    let mut data = FactValue::number(value);
    data.unit = Some("ratio".into());
    Fact::new(label, data)
}

struct Plan {
    preview: Preview,
    built: Option<(View, BuildState)>,
    parts: u64,
    removed: u64,
    after: u64,
}

// The builder's mutable decisions travel with its planned view. A run installs
// these exact decisions, rather than re-reading inputs and building twice.
macro_rules! build_state {
    ($($field:ident: $kind:ty),+ $(,)?) => {
        struct BuildState { $($field: $kind,)+ }
        impl BuildState {
            fn capture(session: &Session) -> Self {
                Self { $($field: session.$field.clone(),)+ }
            }
            fn install(self, session: &mut Session) {
                $(session.$field = self.$field;)+
            }
        }
    };
}
build_state! {
    app_cause: String,
    next_keep: Option<BTreeSet<lanes::PartKey>>,
    head_summaries: Option<HeadSummaries>,
    next_baseline: Option<Arc<Baseline>>,
    next_flush: bool,
    mural_image: Option<(String, String)>,
    next_latch: bool,
    next_rearm: bool,
    emergency_latched: bool,
    next_caveman: Option<lanes::CavemanState>,
    next_reclaim_bookmark: Option<u64>,
    next_notice_reclaim_bookmark: Option<u64>,
    pending_keep: Option<BTreeSet<lanes::PartKey>>,
    move_floor_held: bool,
    version: u64,
    next_covered: Vec<lanes::PartKey>,
    reclaim_bookmark: u64,
    notice_reclaim_bookmark: u64,
    queued: BTreeSet<lanes::PartKey>,
    baseline: Option<Arc<Baseline>>,
    fold_due: bool,
    caveman: lanes::CavemanState,
    failed_parts: BTreeSet<lanes::PartKey>,
}

impl Session {
    /// Request ids are scoped to this session subject. The full body digest
    /// still detects changed args, preview versions and forwarded caller facts.
    fn command_replay(&mut self, request: &ModuleRunRequest, digest: &str) -> Option<RunReply> {
        self.command_answers = self.command_answers_for_save();
        self.command_answers
            .iter()
            .find(|answer| answer.request_id == request.request_id)
            .map(|answer| {
                if answer.request_digest == digest {
                    answer.answer.clone()
                } else {
                    RunReply::new("request_conflict")
                }
            })
    }

    /// Every persistence path uses this projection, including ordinary worker
    /// checkpoints. Empty lists stay absent so sessions without commands keep
    /// their previous JSON shape and need no database migration.
    pub(super) fn command_answers_for_save(&self) -> Arc<Vec<crate::store::CommandAnswer>> {
        let cutoff = wall_now().saturating_sub(ANSWER_RETENTION_MS);
        if self
            .command_answers
            .iter()
            .all(|answer| answer.stored_at >= cutoff)
        {
            return Arc::clone(&self.command_answers);
        }
        Arc::new(
            self.command_answers
                .iter()
                .filter(|answer| answer.stored_at >= cutoff)
                .cloned()
                .collect(),
        )
    }
    fn command_managed(&self) -> bool {
        self.compacting()
            && !self.suspended
            && self.index_ready
            && !self.latest_unknown
            && self.transcript_behind.is_none()
            && !self.short_of_move_floor()
    }

    pub(crate) fn command_preview(&mut self, settings: &Settings, id: &str) -> Preview {
        if !self.command_managed() {
            return crate::user_commands::unavailable();
        }
        if id == "status" {
            self.command_status(settings)
        } else {
            self.flush_plan(settings).preview
        }
    }

    fn flush_reason(&self, settings: &Settings) -> Option<&'static str> {
        if pass::signed_thinking_hold(
            self.index.entries(),
            &self.pressure(),
            settings,
            self.signed_floor(),
        ) {
            Some("thinking_hold")
        } else if self.summarizing {
            Some("summary_running")
        } else {
            None
        }
    }

    /// Plan with the ordinary builder, then put back every decision it may
    /// advance. Only its validation cache is retained; preview publishes no
    /// view, drains no queue, and performs no runner or model call.
    fn planned_flush(&mut self, settings: &Settings) -> Option<(View, BuildState)> {
        let before = BuildState::capture(self);
        let (view, _) = self.build_for(settings, None, false, None, true);
        let after = BuildState::capture(self);
        before.install(self);
        view.map(|view| (view, after))
    }

    fn flush_plan(&mut self, settings: &Settings) -> Plan {
        let reason = self.flush_reason(settings);
        let built = if reason.is_none() {
            self.planned_flush(settings)
        } else {
            None
        };
        let view = built.as_ref().map(|(view, _)| view);
        let covered = built
            .as_ref()
            .map(|(_, state)| state.next_covered.as_slice())
            .unwrap_or_default();
        let (old, old_head) = self.command_costs(self.latest.as_ref());
        let (new, new_head) = self.command_costs(view.or(self.latest.as_ref()));
        let queued: BTreeSet<_> = covered
            .iter()
            .filter(|key| self.queued.contains(*key))
            .collect();
        let queued_tokens: u64 = queued
            .iter()
            .map(|key| {
                old.get(*key)
                    .copied()
                    .unwrap_or(0)
                    .saturating_sub(new.get(*key).copied().unwrap_or(0))
            })
            .sum();
        let old_total = old.values().sum::<u64>() + old_head;
        let new_total = new.values().sum::<u64>() + new_head;
        let removed: u64 = old
            .iter()
            .map(|(key, tokens)| tokens.saturating_sub(new.get(key).copied().unwrap_or(0)))
            .sum();
        let now = self.pressure().last_prompt_tokens.unwrap_or(old_total);
        let after = now.saturating_add(new_total).saturating_sub(old_total);
        let reason = reason.or_else(|| view.is_none().then_some("nothing_to_land"));
        let rewrites = self.rewrite_tokens(view, &old, old_head);
        // Include protected queued parts too: even a drop that cannot land
        // yet invalidates a confirmation of the previous queue.
        let stamp = serde_json::json!({
            "applied": self.newest_applied, "version": self.version,
            "latest": self.latest.as_ref().map(|v| &v.checksum),
            "plan": view.map(|v| &v.checksum), "queue": self.queued,
            "summaries": self.summaries.revision(), "reason": reason,
            "summary_running": self.summarizing, "summary_unshown": self.summary_unshown,
            "summary_wait": self.account_wait.as_ref().map(|w| (&w.refusal.code, w.refusal.until_ms)),
            "usable": pass::usable_window(&self.conditions),
            "queued_tokens": queued_tokens, "rewrites": rewrites,
            "now": now, "after": after, "parts": queued.len(), "removed": removed,
        });
        let version = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&stamp).expect("stamp"))
        );
        let mut preview = Preview::new(version, reason.is_none());
        preview.reason = reason.map(str::to_owned);
        if reason.is_none() {
            preview.effect = Some("Lands queued drops and cleanup in one rebuild".into());
            preview.facts = Some(vec![
                number(
                    "Queued drops",
                    queued.len() as u64,
                    "count",
                    Some("parts"),
                    false,
                ),
                number("Drops remove", queued_tokens, "tokens", None, true),
                number(
                    "Cleanup removes",
                    removed.saturating_sub(queued_tokens),
                    "tokens",
                    None,
                    true,
                ),
                number("Rewrites once", rewrites, "tokens", None, true),
            ]);
            let usable = pass::usable_window(&self.conditions).max(1) as f64;
            let mut figure = Figure::new("Context after", after as f64 / usable, "ratio");
            figure.was = Some(now as f64 / usable);
            preview.figure = Some(figure);
        }
        let parts = queued.len() as u64;
        Plan {
            preview,
            built,
            parts,
            removed,
            after,
        }
    }

    pub(crate) async fn command_run<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        request: &ModuleRunRequest,
    ) -> Result<RunReply, ErrorBody> {
        let digest = format!(
            "{:x}",
            Sha256::digest(
                serde_jcs::to_vec(request).map_err(|_| crate::user_commands::invalid("request"))?
            )
        );
        if let Some(answer) = self.command_replay(request, &digest) {
            return Ok(answer);
        }
        if !self.command_managed() {
            return Ok(RunReply::new(if request.preview_version == "unmanaged" {
                "not_managed"
            } else {
                "preview_stale"
            }));
        }
        let mut plan = self.flush_plan(settings);
        if plan.preview.version != request.preview_version {
            return Ok(RunReply::new("preview_stale"));
        }
        if let Some(reason) = plan.preview.reason {
            return Ok(RunReply::new(reason));
        }
        if self.command_answers.len() >= MAX_ANSWERS {
            return Err(ErrorBody::new(
                "command_capacity",
                "Command answer storage is full for this session.",
            ));
        }
        let Some((view, state)) = plan.built.take() else {
            return Err(outcome_unknown());
        };
        state.install(self);
        let version = view.version;
        let mut reply = RunReply::new("scheduled");
        reply.facts = Some(vec![
            number("Parts dropped", plan.parts, "count", Some("parts"), false),
            number("Tokens removed", plan.removed, "tokens", None, true),
            number("Prompt after", plan.after, "tokens", None, true),
            number("View", version, "count", Some("views"), false),
        ]);
        Arc::make_mut(&mut self.command_answers).push(crate::store::CommandAnswer {
            request_id: request.request_id.clone(),
            request_digest: digest,
            answer: reply.clone(),
            stored_at: wall_now(),
            principal: cortexkit_role_user_commands::ADMITTED_CALLER.into(),
            caller: request.caller.clone(),
        });
        self.app_cause = "explicit_flush".into();
        // Publication saves the scheduled answer and its possibly-delivered
        // view in one document, before the runner can receive the view.
        let (delivered, durable) = self.publish_recorded(client, view).await;
        if delivered {
            return Ok(reply);
        }
        self.next_flush = false;
        let answer = Arc::make_mut(&mut self.command_answers)
            .last_mut()
            .expect("new command answer");
        answer.answer = RunReply::new("failed");
        answer.stored_at = wall_now();
        let failed = answer.answer.clone();
        if self.save().is_err() {
            // Do not expose a failed answer that was never saved. Restore the
            // last durable view and answer together; retries then see exactly
            // the same recovery state as a restarted worker.
            if let Some(durable) = durable {
                self.restore(durable);
            } else {
                Arc::make_mut(&mut self.command_answers).pop();
            }
            return Err(outcome_unknown());
        }
        Ok(failed)
    }

    fn command_status(&self, settings: &Settings) -> Preview {
        let wall_now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |time| time.as_millis() as i64);
        let (costs, head) = self.command_costs(self.latest.as_ref());
        let now = self
            .pressure()
            .last_prompt_tokens
            .unwrap_or(costs.values().sum::<u64>() + head);
        let usable = pass::usable_window(&self.conditions).max(1) as f64;
        let queued_tokens: u64 = self.queued.iter().filter_map(|key| costs.get(key)).sum();
        let summarized = self.summarized_through();
        let remaining = self
            .index
            .entries()
            .iter()
            .filter(|e| summarized.is_none_or(|through| e.ordinal > through))
            .count();
        let facts = vec![
            ratio("Context share", now as f64 / usable),
            ratio(
                "Rebuild threshold",
                settings.execute_threshold_percentage / 100.0,
            ),
            number(
                "Queued drops",
                self.queued.len() as u64,
                "count",
                Some("parts"),
                false,
            ),
            number(
                "Unsummarized",
                remaining as u64,
                "count",
                Some("messages"),
                false,
            ),
        ];
        let mut page = vec![
            number("Context now", now, "tokens", None, true),
            number("Queued tokens", queued_tokens, "tokens", None, true),
            number(
                "History",
                self.summaries.len() as u64,
                "count",
                Some("summaries"),
                false,
            ),
        ];
        let wait = self.account_wait.as_ref().filter(|w| w.holds(wall_now));
        let (state, effect) = if self.summarizing {
            ("building", "Summaries are running")
        } else if let Some(wait) = wait {
            let effect = if matches!(
                wait.refusal.code.as_str(),
                "account_limit_exhausted" | "account_selection_refused"
            ) {
                "Summaries wait for an account limit"
            } else {
                "Summaries wait for a model route"
            };
            page.push(number(
                "Summary wait",
                wait.refusal.until_ms.saturating_sub(wall_now) as u64,
                "duration",
                None,
                false,
            ));
            ("paused", effect)
        } else {
            ("ready", "Summaries are idle")
        };
        page.push(Fact::new("Summaries", FactValue::state(state)));
        page.push(number(
            "Applied view",
            self.newest_applied,
            "count",
            Some("views"),
            false,
        ));
        let memories = self.db.as_ref().zip(self.project.as_ref()).and_then(|(db, project)| {
            db.with_connection(|conn| conn.query_row(
                "SELECT COUNT(*) FROM memories WHERE project_path = ?1 AND status IN ('active', 'permanent') AND (expires_at IS NULL OR expires_at > ?2)",
                rusqlite::params![project.id, wall_now], |row| row.get::<_, u64>(0),
            )).ok()
        });
        if let Some(memories) = memories {
            page.push(number(
                "Project memories",
                memories,
                "count",
                Some("memories"),
                false,
            ));
        } else {
            page.push(Fact::new(
                "Project memories",
                FactValue::state("unavailable"),
            ));
        }
        let stamp = serde_json::to_vec(&(
            &facts,
            &page,
            effect,
            self.newest_applied,
            self.summaries.revision(),
        ))
        .expect("facts");
        let mut preview = Preview::new(format!("{:x}", Sha256::digest(stamp)), true);
        preview.effect = Some(effect.into());
        preview.facts = Some(facts);
        preview.table = Some(cortexkit_role_user_commands::Table::new(
            vec!["Value".into()],
            page.into_iter()
                .map(|f| cortexkit_role_user_commands::TableRow::new(f.label, vec![f.data]))
                .collect(),
        ));
        preview
    }

    fn command_costs(&self, view: Option<&View>) -> (BTreeMap<lanes::PartKey, u64>, u64) {
        let mut drops = BTreeSet::new();
        let mut messages = BTreeSet::new();
        let mut replacements: BTreeMap<lanes::PartKey, Vec<(&str, &Value)>> = BTreeMap::new();
        let mut cut = None;
        let mut head = 0;
        for edit in view.into_iter().flat_map(|v| &v.edits) {
            match &edit.op {
                EditOp::Drop {
                    mid,
                    part: Some(part),
                } => {
                    drops.insert((mid.clone(), part.clone()));
                }
                EditOp::Drop { mid, part: None } => {
                    messages.insert(mid.as_str());
                }
                EditOp::Replace {
                    mid,
                    part,
                    field,
                    value,
                    ..
                } => {
                    replacements
                        .entry((mid.clone(), part.clone()))
                        .or_default()
                        .push((field, value));
                }
                EditOp::Cut { through } => {
                    cut = self
                        .index
                        .entries()
                        .iter()
                        .find(|e| e.mid == *through)
                        .map(|e| e.ordinal);
                }
                EditOp::Insert { message, .. } => {
                    head += message
                        .texts
                        .iter()
                        .map(|t| self.counter().count(t))
                        .sum::<u64>();
                    head += message.images.len() as u64 * tokens::IMAGE_TOKENS;
                }
                _ => {}
            }
        }
        let mut costs = BTreeMap::new();
        let signed_floor = self.signed_floor();
        for entry in self.index.entries() {
            for part in &entry.parts {
                let key = (entry.mid.clone(), part.id.clone());
                let mut cost = tokens::part(part);
                if let Some(edits) = replacements.get(&key) {
                    for (field, value) in edits {
                        let text = value.as_str().unwrap_or("");
                        match (*field, &part.body) {
                            ("output", PartBody::Tool(tool)) => {
                                cost = cost.saturating_sub(tokens::tool_result(part, tool))
                                    + self.counter().count(text);
                            }
                            ("text", _) => cost = self.counter().count(text),
                            _ => {}
                        }
                    }
                }
                if cut.is_some_and(|cut| entry.ordinal <= cut) {
                    cost = cost.saturating_sub(tokens::removed_by_summary(part));
                }
                if messages.contains(entry.mid.as_str())
                    || drops.contains(&key)
                    || (signed_floor.is_some_and(|floor| entry.ordinal <= floor)
                        && matches!(part.body, PartBody::Reasoning { .. }))
                {
                    cost = 0;
                }
                costs.insert(key, cost);
            }
        }
        (costs, head)
    }

    fn rewrite_tokens(
        &self,
        view: Option<&View>,
        old: &BTreeMap<lanes::PartKey, u64>,
        old_head: u64,
    ) -> u64 {
        let Some(view) = view else {
            return 0;
        };
        let changed: Vec<_> = view
            .edits
            .iter()
            .filter(|edit| {
                !self
                    .latest
                    .as_ref()
                    .is_some_and(|v| v.edits.iter().any(|e| e.op == edit.op))
            })
            .collect();
        if changed
            .iter()
            .any(|e| matches!(e.op, EditOp::Insert { .. } | EditOp::Cut { .. }))
        {
            // The baseline stays cached. The delta and conversation after it
            // are the suffix rewritten by a head refresh.
            let m0 = self
                .latest
                .as_ref()
                .into_iter()
                .flat_map(|v| &v.edits)
                .filter_map(|e| match &e.op {
                    EditOp::Insert { message, .. } if message.id == head::M0_ID => Some(
                        message
                            .texts
                            .iter()
                            .map(|t| self.counter().count(t))
                            .sum::<u64>()
                            + message.images.len() as u64 * tokens::IMAGE_TOKENS,
                    ),
                    _ => None,
                })
                .sum::<u64>();
            return old.values().sum::<u64>() + old_head.saturating_sub(m0);
        }
        let ordinals: std::collections::HashMap<_, _> = self
            .index
            .entries()
            .iter()
            .map(|entry| (entry.mid.as_str(), entry.ordinal))
            .collect();
        let first = changed
            .iter()
            .filter_map(|e| match &e.op {
                EditOp::Drop { mid, .. } | EditOp::Replace { mid, .. } => {
                    ordinals.get(mid.as_str()).copied()
                }
                _ => None,
            })
            .min()
            .unwrap_or(u64::MAX);
        self.index
            .entries()
            .iter()
            .filter(|e| e.ordinal >= first)
            .flat_map(|e| {
                e.parts.iter().map(|p| {
                    old.get(&(e.mid.clone(), p.id.clone()))
                        .copied()
                        .unwrap_or(0)
                })
            })
            .sum()
    }
}
