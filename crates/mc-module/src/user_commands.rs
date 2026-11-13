//! Commands a person runs from the apps. What the relay says about the caller
//! is kept for the audit record only; authorization uses the caller the daemon
//! attested for the route.

use cortexkit_role_compaction::read::SessionRef;
use cortexkit_role_user_commands as wire;
use serde_json::Value;
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
    let mut keep = wire::Arg::new(
        "messages_to_keep",
        wire::ArgKind::Number,
        "Keep the newest N messages",
    );
    keep.default = Some(20.into());
    let wrapup = Command::new(
        "wrapup",
        "Summarize history",
        "Summarizes older history with a model, keeping the newest N messages as they are (default 20). The original text stays recoverable; summaries appear on the next rebuild.",
        wire::SubjectKind::Session,
        vec![keep],
        vec!["reversible".into(), "context_change".into()],
        Some(wire::Run::new()),
    );
    wire::DescribeReply::new(vec![flush, status, wrapup]).expect("static command declarations")
}

pub(crate) fn messages_to_keep(args: &serde_json::Map<String, Value>) -> Result<u64, ErrorBody> {
    let n = match args.get("messages_to_keep") {
        None => 20.0,
        Some(value) => value
            .as_f64()
            .ok_or_else(|| invalid("args.messages_to_keep"))?,
    };
    if !n.is_finite() || n < 0.0 || n.fract() != 0.0 || n > 9_007_199_254_740_991.0 {
        return Err(invalid("args.messages_to_keep"));
    }
    Ok(n as u64)
}

pub(crate) fn invalid(field: &str) -> ErrorBody {
    wire::ValidationError::new(field).refusal()
}

/// Read caller and session labels only after handling the call. They explain
/// who opened a command, but cannot grant admission or change its result.
/// Never log command arguments.
pub(crate) fn audit(body: &[u8], result: &Result<Value, ErrorBody>) {
    let envelope = (body.len() <= 64 * 1024)
        .then(|| serde_json::from_slice::<Value>(body).ok())
        .flatten()
        .unwrap_or(Value::Null);
    let label = |path| envelope.pointer(path).and_then(Value::as_str).unwrap_or("");
    let outcome = match result {
        Err(error) => error.code.as_str(),
        Ok(reply) => reply
            .get("reason")
            .or_else(|| reply.get("outcome"))
            .and_then(Value::as_str)
            .unwrap_or_else(|| match reply.get("available").and_then(Value::as_bool) {
                Some(true) => "available",
                Some(false) => "unavailable",
                None => "ok",
            }),
    };
    tracing::info!(
        op = label("/method"),
        command_id = label("/params/id"),
        runner = label("/params/subject/session/runner"),
        harness = label("/params/subject/session/harness"),
        session = label("/params/subject/session/session"),
        app = label("/params/caller/app"),
        admission = label("/params/caller/admission"),
        device = label("/params/caller/device"),
        outcome,
        "ck-mc: user command"
    );
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
            if request.id == "wrapup" {
                messages_to_keep(&request.args)?;
            }
            Ok(Some(Request::Preview(request)))
        }
        "commands.run" => {
            let request: ModuleRunRequest =
                serde_json::from_value(envelope.params).map_err(|_| invalid("params"))?;
            request.check(command).map_err(|e| e.refusal())?;
            if request.id == "wrapup" {
                messages_to_keep(&request.args)?;
            }
            Ok(Some(Request::Run(request)))
        }
        _ => Err(ErrorBody::new("unknown_method", "Unknown command method.")),
    }
}

pub(crate) async fn execute<C: crate::client::RunnerClient>(
    session: Option<&mut crate::session::Session>,
    client: &C,
    settings: &crate::pass::Settings,
    request: Request,
) -> Result<Value, ErrorBody> {
    match request {
        Request::Preview(request) => {
            let preview = match session {
                Some(session) if request.id == "wrapup" => {
                    session.wrapup_preview(settings, messages_to_keep(&request.args)?)
                }
                Some(session) => session.command_preview(settings, &request.id),
                None => unavailable(),
            };
            preview.check().map_err(|e| e.refusal())?;
            serde_json::to_value(preview).map_err(|_| invalid("reply"))
        }
        Request::Run(request) => {
            let reply = match session {
                Some(session) => session.command_run(client, settings, &request).await?,
                None => RunReply::new(if request.preview_version == "unmanaged" {
                    "not_managed"
                } else {
                    "preview_stale"
                }),
            };
            reply.check().map_err(|e| e.refusal())?;
            serde_json::to_value(reply).map_err(|_| invalid("reply"))
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
