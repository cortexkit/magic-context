//! Person-facing commands. Relay claims are audit data, never authority.

use cortexkit_role_compaction::read::SessionRef;
use cortexkit_role_user_commands as wire;
use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use wire::{Command, ErrorBody, ModulePreviewRequest, ModuleRunRequest, RunReply, Subject};

pub(crate) fn describe() -> wire::DescribeReply {
    let flush = Command::new(
        "flush",
        "Flush context",
        "Lands queued drops, routine cleanup and new context in one rebuild at the next request.",
        wire::SubjectKind::Session,
        vec![],
        vec!["reversible".into(), "context_change".into()],
        Some(wire::Run::new()),
    );
    let status = Command::new(
        "status",
        "Context status",
        "Shows context usage, queued drops and summary progress.",
        wire::SubjectKind::Session,
        vec![],
        vec!["read".into()],
        None,
    );
    wire::DescribeReply::new(vec![flush, status]).expect("static command declarations")
}

pub(crate) fn invalid(field: &str) -> ErrorBody {
    wire::ValidationError::new(field).refusal()
}

pub(crate) enum Request {
    Preview(ModulePreviewRequest),
    Run(ModuleRunRequest),
}

/// Select by method alone; skipped params are never decoded into command data
/// until the module has checked the daemon-attested caller.
pub(crate) fn method(body: &[u8]) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Method {
        method: String,
    }
    serde_json::from_slice::<Method>(body)
        .ok()
        .map(|m| m.method)
}

impl Request {
    pub(crate) fn key(&self) -> SessionRef {
        let subject = match self {
            Self::Preview(r) => &r.subject,
            Self::Run(r) => &r.subject,
        };
        match subject {
            Subject::Session { session } => SessionRef::new(
                session.runner.clone(),
                session.harness.clone(),
                session.session.clone(),
            ),
            _ => unreachable!("validated session command"),
        }
    }
}

pub(crate) fn decode(body: &[u8]) -> Result<Option<Request>, ErrorBody> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Envelope {
        method: String,
        params: Value,
    }
    if body.len() > 64 * 1024 {
        return Err(invalid("request"));
    }
    let envelope: Envelope = serde_json::from_slice(body).map_err(|_| invalid("request"))?;
    if envelope.method == "commands.describe" {
        serde_json::from_value::<wire::DescribeRequest>(envelope.params)
            .map_err(|_| invalid("params"))?;
        return Ok(None);
    }
    let declarations = describe();
    let id = envelope
        .params
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("id"))?;
    let command = declarations
        .commands
        .iter()
        .find(|c| c.id == id)
        .ok_or_else(|| ErrorBody::new(wire::UNKNOWN_COMMAND, "Unknown command."))?;
    match envelope.method.as_str() {
        "commands.preview" => {
            let request: ModulePreviewRequest =
                serde_json::from_value(envelope.params).map_err(|_| invalid("params"))?;
            request.check(command).map_err(|e| e.refusal())?;
            Ok(Some(Request::Preview(request)))
        }
        "commands.run" => {
            let request: ModuleRunRequest =
                serde_json::from_value(envelope.params).map_err(|_| invalid("params"))?;
            request.check(command).map_err(|e| e.refusal())?;
            Ok(Some(Request::Run(request)))
        }
        _ => Err(ErrorBody::new("unknown_method", "Unknown command method.")),
    }
}

struct Record {
    principal: &'static str,
    at: Instant,
    body: ModuleRunRequest,
    answer: Value,
}

/// A full store refuses new ids rather than evicting answers before 24 hours.
/// These records, including the relay's caller claims, do not survive restart.
#[derive(Default)]
pub(crate) struct Replays {
    records: HashMap<String, Record>,
}

impl Replays {
    fn prepare(&mut self, request: &ModuleRunRequest) -> Result<Option<Value>, ErrorBody> {
        self.records
            .retain(|_, r| r.at.elapsed() < Duration::from_secs(24 * 60 * 60));
        if let Some(record) = self.records.get(&request.request_id) {
            debug_assert_eq!(record.principal, wire::ADMITTED_CALLER);
            return Ok(Some(if record.body == *request {
                record.answer.clone()
            } else {
                serde_json::to_value(RunReply::new("request_conflict")).expect("reply")
            }));
        }
        if self.records.len() >= 4096 {
            return Err(ErrorBody::new(
                "command_capacity",
                "Command answer storage is full.",
            ));
        }
        Ok(None)
    }
}

pub(crate) async fn execute<C: crate::client::RunnerClient>(
    session: Option<&mut crate::session::Session>,
    client: &C,
    settings: &crate::pass::Settings,
    replays: &tokio::sync::Mutex<Replays>,
    request: Request,
) -> Result<Value, ErrorBody> {
    match request {
        Request::Preview(request) => {
            let preview = match session {
                Some(session) => session.command_preview(settings, &request.id),
                None => unavailable(),
            };
            preview.check().map_err(|e| e.refusal())?;
            serde_json::to_value(preview).map_err(|_| invalid("reply"))
        }
        Request::Run(request) => {
            // Held in the worker, not the request future: cancellation of the
            // caller cannot lose the answer after the runner accepted a view.
            let mut replays = replays.lock().await;
            if let Some(answer) = replays.prepare(&request)? {
                return Ok(answer);
            }
            let reply = match session {
                Some(session) => session.command_run(client, settings, &request).await,
                None => RunReply::new(if request.preview_version == "unmanaged" {
                    "not_managed"
                } else {
                    "preview_stale"
                }),
            };
            reply.check().map_err(|e| e.refusal())?;
            let answer = serde_json::to_value(reply).map_err(|_| invalid("reply"))?;
            replays.records.insert(
                request.request_id.clone(),
                Record {
                    principal: wire::ADMITTED_CALLER,
                    at: Instant::now(),
                    body: request,
                    answer: answer.clone(),
                },
            );
            Ok(answer)
        }
    }
}

pub(crate) fn unavailable() -> wire::Preview {
    let mut preview = wire::Preview::new("unmanaged", false);
    preview.reason = Some("not_managed".into());
    preview
}

#[cfg(test)]
mod contract_tests;
