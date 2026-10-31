//! Pre-write, preserving user-message augmentations for runner sessions.
//!
//! A runner calls `pre_user` before it writes a user message, so what ck-mc adds
//! lands on that message itself and is stored with it: the time marker in front
//! (the gap since the previous message) and auto-memory hits after it. The
//! runner applies the operations once and replays them, so they cost no cache
//! rebuild. Anything uncertain answers `pass`: the turn always goes on.

use super::*;
use cortexkit_role_step_transform_provider as step;
use step::answer::{HookAnswer, Operation};
use step::hook::{HookCall, Subject};
use step::subscription::{
    Declaration, DeclareRequest, DeclaredSubscription, Hook, OnUnavailable, Op,
};

pub(super) fn describe_major() -> step::describe::Major {
    step::describe::Major::new(
        step::PROVIDES,
        vec![
            "role.describe".into(),
            step::ops::TRANSFORM_DECLARE.into(),
            step::ops::TRANSFORM_HOOK.into(),
        ],
        "alpha",
    )
}

pub(crate) fn declare(params: &Value) -> HandlerOutcome {
    let request: DeclareRequest = match decode(params) {
        Ok(request) => request,
        Err(error) => return error,
    };
    let subscriptions = match request.preset.as_deref().unwrap_or("head") {
        "head" => {
            vec![
                DeclaredSubscription::new(Hook::PreUser, vec![Op::Prepend, Op::Append], 1500)
                    .with_on_unavailable(OnUnavailable::Pass),
            ]
        }
        // Workers get the time marker only. Like standalone subagents, they get
        // no automatic memory recall: their prompts come from the agent that
        // launched them, not from a person's question.
        "worker" => {
            vec![
                DeclaredSubscription::new(Hook::PreUser, vec![Op::Prepend], 1500)
                    .with_on_unavailable(OnUnavailable::Pass),
            ]
        }
        "reader" => Vec::new(),
        _ => return invalid_field("preset", "unknown step-transform preset"),
    };
    let declaration = Declaration {
        subscriptions,
        claude_code: None,
    };
    debug_assert!(declaration.check().is_empty());
    match bytes(&declaration) {
        Ok(bytes) => HandlerOutcome::Response(bytes),
        Err(error) => error,
    }
}

impl McHandler {
    pub(crate) async fn handle_step_transform(
        &self,
        channel: u16,
        params: &Value,
    ) -> HandlerOutcome {
        let call: HookCall = match decode(params) {
            Ok(call) => call,
            Err(error) => return error,
        };
        let answer = self
            .pre_user_answer(channel, &call)
            .unwrap_or(HookAnswer::Pass);
        // One line per call, so a runner's hook log can be matched against
        // what ck-mc answered.
        let outcome = match &answer {
            HookAnswer::Ops { ops } => format!("ops:{}", ops.len()),
            _ => "pass".to_string(),
        };
        tracing::info!(
            "step-transform hook session={} outcome={outcome}",
            call.session
        );
        match bytes(&answer) {
            Ok(bytes) => HandlerOutcome::Response(bytes),
            Err(error) => error,
        }
    }

    /// `None` means pass: an unknown route, session or store, a hook ck-mc
    /// doesn't subscribe to, or nothing to add.
    fn pre_user_answer(&self, channel: u16, call: &HookCall) -> Option<HookAnswer> {
        let Subject::PreUser { blocks, .. } = &call.subject else {
            return None;
        };
        let last = u32::try_from(blocks.len().checked_sub(1)?).ok()?;
        let mut binding = self.facade_binding(channel).ok()?;
        let runner = matches!(
            binding.principal.as_ref(),
            Some(subc_protocol::Principal::Reserved { module_id })
                if crate::route_targets::SESSION_RUNNER_MODULE_IDS.contains(&module_id.as_str())
        );
        if !runner {
            return None;
        }
        if binding.session.is_empty() {
            binding.session.clone_from(&call.session);
        } else if binding.session != call.session {
            return None;
        }
        let route = crate::route_binding::RouteIdentity {
            principal: binding.principal.clone(),
            scope: binding.scope.clone(),
            harness: binding.harness.clone(),
            session: binding.session.clone(),
        };
        if let Some(project) = self.stored_async_project(&route).ok()? {
            binding = self.project_binding(&route, &project);
        }
        let text = blocks.join("\n");
        // A message that is only system reminders (a notice, a reminder) or
        // empty is not something the person wrote: no marker, no hint.
        let prompt = crate::transform::sanitize_user_hint_query(&text);
        if prompt.is_empty() {
            return None;
        }
        let store = self.store.get()?;
        let (namespace, newest_written_at, head) = self.pre_user_context(&binding)?;
        let mut ops = Vec::new();

        if binding.config.temporal_awareness {
            // The gap runs from the newest message ck-mc holds, the one this
            // message follows, to now: the message is written right after this
            // call, so now is its creation time.
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok());
            let gap = now
                .zip(newest_written_at)
                .and_then(|(now, previous)| i64::try_from(now.saturating_sub(previous)).ok());
            if let Some(prefix) = gap.and_then(crate::transform::temporal_gap_prefix) {
                ops.push(Operation::Prepend {
                    block: 0,
                    text: prefix,
                    note: Some("time since the previous message".into()),
                });
            }
        }

        let auto = &binding.config.auto_search;
        if head
            && auto.enabled
            && binding.config.memory_enabled
            && !crate::transform::has_stacked_user_hint_augmentation(&text)
            && prompt.encode_utf16().count() >= auto.min_prompt_chars
        {
            // A route without a project identity keeps the time marker; only
            // memory pauses.
            let route = self
                .route_project(channel, store, &binding)
                .ok()
                .filter(|route| route.memory_paused.is_none());
            if let Some(route) = route {
                // Memories already in this session's history head are not repeated.
                let visible = store
                    .fully_visible_memory_ids_for_hint(&namespace)
                    .unwrap_or_default();
                let results = crate::transform::run_user_hint_lexical_search(
                    store,
                    &route.key,
                    &namespace,
                    &prompt,
                    true,
                    auto.score_threshold,
                    &visible,
                )
                .unwrap_or_default();
                if let Some(hint) = crate::transform::render_user_hint(&results, true) {
                    ops.push(Operation::Append {
                        block: last,
                        text: hint,
                        note: Some("auto memory".into()),
                    });
                }
            }
        }
        (!ops.is_empty()).then_some(HookAnswer::Ops { ops })
    }
}
