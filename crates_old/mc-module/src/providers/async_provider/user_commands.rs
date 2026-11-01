//! Commands issued only by people, with durable replies scoped to the session.
use super::*;
use cortexkit_role_tool_provider::{errors, late_results as late, user_command as command};
use serde::{Deserialize, Serialize};
use subc_protocol::{scope::ScopeKind, Principal};

use super::wrapup::{AsyncWrapupAdmission, AsyncWrapupTarget};

const RECEIPT_RETENTION_MS: u64 = 24 * 60 * 60 * 1_000;
const MAX_RECEIPTS: usize = 1024;
const DEFAULT_WRAPUP_KEEP: usize = 20;

fn parse_wrapup_keep(input: &str) -> Result<usize, HandlerOutcome> {
    if input.trim().is_empty() {
        return Ok(DEFAULT_WRAPUP_KEEP);
    }
    let Some(value) = input.trim().strip_prefix("keep-") else {
        return Err(wire_error(errors::invalid_request(
            "keep",
            "expected no argument or keep-N with a positive integer",
        )));
    };
    match value.parse::<usize>() {
        Ok(keep) if keep > 0 => Ok(keep),
        _ => Err(wire_error(errors::invalid_request(
            "keep",
            "expected no argument or keep-N with a positive integer",
        ))),
    }
}

#[derive(Default, Serialize, Deserialize)]
pub(super) struct Ledger(BTreeMap<String, Log>);
impl Ledger {
    pub(super) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn evict_expired(&mut self, now_ms: u64) -> bool {
        let mut changed = false;
        let mut expired = Vec::new();
        for (who, log) in &mut self.0 {
            for (key, receipt) in &mut log.calls {
                // Older records have no timestamp. Set and persist `created_at_ms` on first
                // observation so their retry window does not restart after a module restart.
                let created_at_ms = *receipt.created_at_ms.get_or_insert_with(|| {
                    changed = true;
                    now_ms
                });
                if now_ms.saturating_sub(created_at_ms) > RECEIPT_RETENTION_MS {
                    expired.push((created_at_ms, who.clone(), key.clone()));
                }
            }
        }
        expired.sort_unstable();
        changed |= !expired.is_empty();
        for (_, who, key) in expired {
            self.0
                .get_mut(&who)
                .expect("recorded command log")
                .calls
                .remove(&key);
        }
        changed
    }
}
#[derive(Default, Serialize, Deserialize)]
struct Log {
    calls: BTreeMap<String, Receipt>,
    entries: Vec<(u64, late::LateEntry)>,
    head: u64,
}
#[derive(Serialize, Deserialize)]
struct Receipt {
    first: command::UserCommandReply,
    incarnation: String,
    terminal: bool,
    #[serde(default)]
    created_at_ms: Option<u64>,
}

fn incarnation(reference: &str) -> String {
    static START: OnceLock<String> = OnceLock::new();
    let start =
        START.get_or_init(|| format!("{}-{:?}", std::process::id(), std::time::SystemTime::now()));
    crate::sha256_hex(format!("{start}:{reference}").as_bytes())
}
fn principal_name(principal: &Principal) -> String {
    match principal {
        Principal::Reserved { module_id } => format!("reserved:{module_id}"),
        Principal::Direct => "direct".into(),
        Principal::Unverified => "unverified".into(),
    }
}
fn wire_error(body: subc_protocol::ErrorBody) -> HandlerOutcome {
    HandlerOutcome::ErrorWithDetail {
        code: body.code,
        message: body.message,
        detail: body.detail.unwrap_or(Value::Null),
    }
}
fn refused(code: &str, name: &str) -> HandlerOutcome {
    HandlerOutcome::ErrorWithDetail {
        code: code.into(),
        message: format!("{name}: {code}"),
        detail: json!({"command":name}),
    }
}
fn identity(binding: &SessionBinding) -> Result<String, HandlerOutcome> {
    let scope = binding
        .scope
        .as_ref()
        .ok_or_else(|| refused("user_command_not_admitted", "user_command.invoke"))?;
    let principal = binding
        .principal
        .as_ref()
        .ok_or_else(|| refused("user_command_not_admitted", "user_command.invoke"))?;
    Ok(json!([scope.owner, scope.scope_ref, scope.scope_epoch, principal]).to_string())
}

impl Log {
    fn append(
        &mut self,
        binding: &SessionBinding,
        call_key: &str,
        kind: &str,
        reply: command::UserCommandReply,
    ) {
        let scope = binding.scope.as_ref().expect("admitted scope");
        let custodian = principal_name(binding.principal.as_ref().expect("attested caller"));
        let event_id = crate::sha256_hex(
            json!([
                scope.owner,
                scope.scope_ref,
                scope.scope_epoch,
                custodian,
                call_key,
                kind
            ])
            .to_string()
            .as_bytes(),
        );
        let mut entry = late::LateEntry::new(
            kind,
            principal_name(&scope.owner),
            &scope.scope_ref,
            scope.scope_epoch,
            custodian,
            call_key,
            event_id,
            now_ms().max(0) as u64,
        );
        if kind == late::kinds::PROGRESS {
            entry = entry.with_text(reply.text);
        } else {
            entry = entry.with_result(json!(reply));
        }
        self.head += 1;
        self.entries.push((self.head, entry));
    }
}

impl McHandler {
    fn command_head(&self, binding: &SessionBinding) -> Result<State, HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let rows = super::route_records(store, binding)?;
        match rows.as_slice() {
            [] => Err(refused("async_compaction_required", "user_command.invoke")),
            [raw] => serde_json::from_str(raw).map_err(transient),
            _ => Err(session_unresolved_error()),
        }
    }

    pub(crate) async fn handle_user_command_op(
        &self,
        channel: u16,
        op: &str,
        request: &Value,
    ) -> HandlerOutcome {
        let binding = match self.facade_binding(channel) {
            Ok(binding) => binding,
            Err(_) => return refused("user_command_not_admitted", op),
        };
        if !command::admitted(binding.scope.as_ref()) {
            return refused(errors::USER_COMMAND_NOT_ADMITTED, op);
        }
        if binding
            .scope
            .as_ref()
            .is_some_and(|scope| scope.kind != ScopeKind::Head)
        {
            return refused("no_person", op);
        }
        let who = match identity(&binding) {
            Ok(who) => who,
            Err(error) => return error,
        };
        let arguments = if op == "user_command.invoke" {
            let call = match serde_json::from_value(request.clone()) {
                Ok(call) => call,
                Err(error) => {
                    return wire_error(errors::invalid_request("arguments", error.to_string()))
                }
            };
            match command::check_invoke(&call) {
                Ok(arguments) => Some(arguments),
                Err(error) => return wire_error(error),
            }
        } else {
            None
        };
        let head = match self.command_head(&binding) {
            Ok(head) => head,
            Err(error) => return error,
        };
        let _serial = match tokio::time::timeout(
            Duration::from_secs(4),
            self.provider_serial.lock_for(&head.key),
        )
        .await
        {
            Ok(serial) => serial,
            Err(_) => return refused("user_command_busy", op),
        };
        let store = self.store.get().expect("command store");
        let mut state = match self.checkout(store, &head.reference()) {
            Ok(Some(state)) => state,
            Ok(None) => return session_unresolved_error(),
            Err(error) => return error,
        };
        let outcome = self.command_locked(&binding, &who, op, request, arguments, &mut state);
        self.checkin(state);
        outcome
    }

    fn command_locked(
        &self,
        binding: &SessionBinding,
        who: &str,
        op: &str,
        request: &Value,
        arguments: Option<command::UserCommandArguments>,
        state: &mut State,
    ) -> HandlerOutcome {
        if state.engine.preset != transform::compaction::Preset::Head {
            return refused("no_person", op);
        }
        let store = self.store.get().expect("command store");
        let reference = state.reference();
        let current = incarnation(&format!("{reference}:{who}"));
        if op != "user_command.invoke" {
            return self.command_late(binding, who, op, request, state, &current);
        }
        let arguments = arguments.expect("validated invoke");
        let key = request["call_key"].as_str().expect("validated key");
        let now = now_ms().max(0) as u64;
        if state.commands.evict_expired(now) {
            if let Err(error) = state.save(store, &[]) {
                return error;
            }
        }
        if let Some(receipt) = state.commands.0.get(who).and_then(|log| log.calls.get(key)) {
            return respond(json!(receipt.first));
        }
        if !matches!(
            arguments.command.as_str(),
            "ctx-status" | "ctx-flush" | "ctx-wrapup"
        ) {
            return wire_error(errors::unknown_user_command(&arguments.command));
        }
        let wrapup = if arguments.command == "ctx-wrapup" {
            let keep = match parse_wrapup_keep(&arguments.input) {
                Ok(keep) => keep,
                Err(error) => return error,
            };
            Some((
                keep,
                AsyncWrapupTarget {
                    reference: reference.clone(),
                    lineage: state.lineage.clone().unwrap_or_default(),
                },
            ))
        } else {
            if !arguments.input.trim().is_empty() {
                return wire_error(errors::invalid_request(
                    "input",
                    format!("{} takes no arguments", arguments.command),
                ));
            }
            None
        };
        if state
            .commands
            .0
            .values()
            .map(|log| log.calls.len())
            .sum::<usize>()
            >= MAX_RECEIPTS
        {
            return refused("user_command_capacity", &arguments.command);
        }
        let reply = if arguments.command == "ctx-status" {
            match self.command_status(state) {
                Ok(text) => command::UserCommandReply::new("done", text),
                Err(error) => return error,
            }
        } else if arguments.command == "ctx-wrapup" {
            if state.resync || state.failed() {
                return refused("async_compaction_not_ready", &arguments.command);
            }
            command::UserCommandReply::new(
                "accepted",
                "Wrapup accepted; summarizing the current session history.",
            )
            .with_job(format!(
                "ctx-wrapup-{}",
                crate::sha256_hex(json!([who, key]).to_string().as_bytes())
            ))
        } else {
            if state.resync || state.failed() || state.conditions.is_none() {
                return refused("async_compaction_not_ready", &arguments.command);
            }
            match self.command_pending(state) {
                Ok(false) => command::UserCommandReply::new(
                    "done",
                    "Nothing to flush: no queued drops or pending history.",
                ),
                Ok(true) => command::UserCommandReply::new(
                    "accepted",
                    "Flushing queued drops and pending history.",
                )
                .with_job(format!(
                    "ctx-flush-{}",
                    crate::sha256_hex(json!([who, key]).to_string().as_bytes())
                )),
                Err(error) => return error,
            }
        };
        let accepted = reply.state == "accepted";
        let log = state.commands.0.entry(who.into()).or_default();
        log.calls.insert(
            key.into(),
            Receipt {
                first: reply.clone(),
                incarnation: current,
                terminal: !accepted,
                created_at_ms: Some(now),
            },
        );
        if accepted {
            let progress = if arguments.command == "ctx-wrapup" {
                "Preparing a wrapup of the current session history."
            } else {
                "Applying the user-permitted rebuild."
            };
            log.append(
                binding,
                key,
                late::kinds::PROGRESS,
                command::UserCommandReply::new("accepted", progress),
            );
        }
        if let Err(error) = state.save(store, &[]) {
            let log = state.commands.0.get_mut(who).expect("command log");
            log.calls.remove(key);
            if accepted {
                log.entries.pop();
                log.head -= 1;
            }
            return error;
        }
        if accepted {
            let worker = self.provider_historian_worker();
            let binding = binding.clone();
            let who = who.to_owned();
            let key = key.to_owned();
            if let Some((keep, target)) = wrapup {
                tokio::spawn(async move {
                    worker
                        .run_command_wrapup(binding, reference, who, key, target, keep)
                        .await;
                });
            } else {
                tokio::spawn(async move {
                    worker.run_command_flush(binding, reference, who, key).await;
                });
            }
        }
        respond(json!(reply))
    }

    fn command_pending(&self, state: &State) -> Result<bool, HandlerOutcome> {
        let store = self.store.get().expect("command store");
        let snapshot = store
            .load_session_status_snapshot(&state.namespace())
            .map_err(transient)?;
        let compartments = store
            .load_compartments(&state.namespace())
            .map_err(transient)?;
        Ok(snapshot.pending_drop_count > 0
            || compartments.iter().any(|comp| {
                comp.end_message >= 0
                    && snapshot
                        .loaded
                        .meta
                        .coverage_ordinal
                        .is_none_or(|coverage| comp.end_message as u64 > coverage)
            }))
    }

    fn command_status(&self, state: &State) -> Result<String, HandlerOutcome> {
        let store = self.store.get().expect("command store");
        let snapshot = store
            .load_session_status_snapshot(&state.namespace())
            .map_err(transient)?;
        let meta = &snapshot.loaded.meta;
        let notice = state
            .conditions
            .as_ref()
            .and_then(|headers| notice::AdvanceNotice::from_headers(headers).ok());
        let pressure = match notice {
            Some(notice) => {
                let window = state
                    .usage_policy
                    .as_ref()
                    .and_then(|policy| policy.limit_for(&notice.model))
                    .or(notice.window.or(state.setup.context_window));
                match window {
                    Some(window) if window > 0 => format!(
                        "{} / {} estimated tokens ({:.1}%)",
                        notice.est_tokens,
                        window,
                        notice.est_tokens as f64 * 100.0 / window as f64
                    ),
                    _ => format!("{} estimated tokens; window unknown", notice.est_tokens),
                }
            }
            None => "unknown (no advance notice yet)".into(),
        };
        let mut status = format!("Magic Context\nPressure: {pressure}\nQueued drops: {}\nRebuild: refresh_pending={}, resync={}, failed={}\nCache expiry: runner-owned; last applied view: {}\nHistory: {} compartments; coverage: {}; {}", snapshot.pending_drop_count, meta.soft_refresh_pending, state.resync, state.failed() || state.engine_failed, state.applied.map_or_else(|| "none".into(), |version| version.to_string()), snapshot.compartment_count, meta.coverage_ordinal.map_or_else(|| "none".into(), |n| n.to_string()), compact_status_detail(&historian_status_summary(&meta.historian)));
        if let Some(failure) = &state.failure {
            status.push_str(&format!("\nFailure: {}: {}", failure.code, failure.reason));
        }
        if let Some(outcome) = &state.read_outcome {
            status.push_str(&format!("\nTranscript read: {outcome}"));
        }
        Ok(status)
    }
}

impl McHandler {
    async fn run_command_flush(
        &self,
        binding: SessionBinding,
        reference: String,
        who: String,
        key: String,
    ) {
        let Some(store) = self.store.get() else {
            return;
        };
        let Ok(Some(head)) = load_head(store, &reference) else {
            return;
        };
        let _serial = self.provider_serial.lock_for(&head.key).await;
        let Ok(Some(mut state)) = self.checkout(store, &reference) else {
            return;
        };
        let result = (|| {
            if !self.command_pending(&state)? {
                return Ok("Nothing to flush: no queued drops or pending history.".to_owned());
            }
            if state.resync || state.failed() {
                return Err(transient("async conversation is not ready"));
            }
            let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone()))?;
            // The shared engine uses this one-shot flag to authorize a user
            // flush; publishing a view alone does not grant that permission.
            store
                .arm_soft_refresh(&state.namespace())
                .map_err(transient)?;
            match self.publish_async(0, &mut state, codec, false)? {
                Some(view) => Ok(format!(
                    "Flushed queued drops and pending history; published view {}.",
                    view.view_version
                )),
                None => Err(transient(
                    "user flush did not publish a view; refresh remains pending",
                )),
            }
        })();
        let reply = match result {
            Ok(text) => command::UserCommandReply::new("done", text),
            Err(error) => command::UserCommandReply::new(
                "failed",
                format!(
                    "ctx-flush failed: {}",
                    compact_status_detail(&format!("{error:?}"))
                ),
            ),
        };
        let log = state
            .commands
            .0
            .get_mut(&who)
            .expect("accepted command log");
        if let Some(receipt) = log.calls.get_mut(&key) {
            if !receipt.terminal {
                receipt.terminal = true;
                log.append(&binding, &key, late::kinds::RESULT, reply);
            }
        }
        if let Err(error) = state.save(store, &[]) {
            tracing::warn!(?error, "user-command result could not be saved");
        }
        self.checkin(state);
        drop(_serial);
        if let Err(error) = self.announce_async_views().await {
            tracing::warn!(?error, "user-command view announcement failed");
        }
    }

    async fn run_command_wrapup(
        &self,
        binding: SessionBinding,
        reference: String,
        who: String,
        key: String,
        target: AsyncWrapupTarget,
        keep: usize,
    ) {
        let result = self
            .execute_async_wrapup_command(&binding, &target, keep)
            .await;
        let reply = match result {
            Ok(AsyncWrapupAdmission::Accepted) => command::UserCommandReply::new(
                "done",
                "Wrapup completed; the updated history is ready for the next permitted view.",
            ),
            Ok(AsyncWrapupAdmission::UnknownConversation) => command::UserCommandReply::new(
                "failed",
                "ctx-wrapup failed: the conversation or its lineage is no longer available.",
            ),
            Ok(AsyncWrapupAdmission::AlreadyRunning) => command::UserCommandReply::new(
                "failed",
                "ctx-wrapup failed: another historian or wrapup is already running.",
            ),
            Ok(AsyncWrapupAdmission::Ceiling) => command::UserCommandReply::new(
                "failed",
                "ctx-wrapup failed: the historian work budget is full.",
            ),
            Err(error) => command::UserCommandReply::new(
                "failed",
                format!(
                    "ctx-wrapup failed: {}",
                    compact_status_detail(&format!("{error:?}"))
                ),
            ),
        };
        let Some(store) = self.store.get() else {
            return;
        };
        let Ok(Some(head)) = load_head(store, &reference) else {
            return;
        };
        let _serial = self.provider_serial.lock_for(&head.key).await;
        let Ok(Some(mut state)) = self.checkout(store, &reference) else {
            return;
        };
        let log = state
            .commands
            .0
            .get_mut(&who)
            .expect("accepted command log");
        if let Some(receipt) = log.calls.get_mut(&key) {
            if !receipt.terminal {
                receipt.terminal = true;
                log.append(&binding, &key, late::kinds::RESULT, reply);
            }
        }
        if let Err(error) = state.save(store, &[]) {
            tracing::warn!(?error, "user-command result could not be saved");
        }
        self.checkin(state);
        drop(_serial);
        if let Err(error) = self.announce_async_views().await {
            tracing::warn!(?error, "user-command view announcement failed");
        }
    }

    fn command_late(
        &self,
        binding: &SessionBinding,
        who: &str,
        op: &str,
        request: &Value,
        state: &mut State,
        current: &str,
    ) -> HandlerOutcome {
        let log = state.commands.0.entry(who.into()).or_default();
        // If a restart interrupts a pending command, record a failed result instead
        // of rerunning it; the command's acceptance is already durable.
        let interrupted: Vec<_> = log
            .calls
            .iter()
            .filter(|(_, receipt)| !receipt.terminal && receipt.incarnation != current)
            .map(|(key, _)| key.clone())
            .collect();
        for key in interrupted {
            log.calls.get_mut(&key).expect("recorded command").terminal = true;
            log.append(binding, &key, late::kinds::RESULT, command::UserCommandReply::new("failed", "Module restarted before this command's result was recorded. Check status before issuing a new command."));
        }
        let arguments = request.get("arguments").unwrap_or(&Value::Null);
        let outcome = if op == "late_results.ack" {
            let ack: late::AckRequest = match serde_json::from_value(arguments.clone()) {
                Ok(ack) => ack,
                Err(error) => {
                    return wire_error(errors::invalid_request("through", error.to_string()))
                }
            };
            if let Err(error) = late::check_since(current, log.head, Some(&ack.through)) {
                return wire_error(error);
            }
            log.entries.retain(|(seq, _)| *seq > ack.through.seq);
            respond(json!({"ok":true}))
        } else {
            let pull: late::LateResultsRequest = match serde_json::from_value(arguments.clone()) {
                Ok(pull) => pull,
                Err(error) => {
                    return wire_error(errors::invalid_request("since", error.to_string()))
                }
            };
            if let Err(error) = late::check_since(current, log.head, pull.since.as_ref()) {
                return wire_error(error);
            }
            let limit = pull.limit.unwrap_or(64).min(64) as usize;
            if limit == 0 {
                return wire_error(errors::invalid_request("limit", "must be positive"));
            }
            let since = pull.since.as_ref().map_or(0, |cursor| cursor.seq);
            let waiting: Vec<_> = log.entries.iter().filter(|(seq, _)| *seq > since).collect();
            let more = waiting.len() > limit;
            let selected: Vec<_> = waiting.into_iter().take(limit).collect();
            let seq = if more {
                selected.last().map_or(since, |(seq, _)| *seq)
            } else {
                log.head
            };
            respond(json!(late::LateResultsReply {
                entries: selected
                    .into_iter()
                    .map(|(_, entry)| entry.clone())
                    .collect(),
                cursor: late::Cursor {
                    provider_incarnation: current.into(),
                    seq
                },
                more
            }))
        };
        match state.save(self.store.get().expect("command store"), &[]) {
            Ok(()) => outcome,
            Err(error) => error,
        }
    }
}
