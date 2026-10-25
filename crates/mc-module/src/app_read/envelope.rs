//! Shared wire validation. Operation handlers supply their own object allowlists.

use serde_json::{json, Map, Value};
use subc_client_rs::HandlerOutcome;

pub const REQUEST_LIMIT: usize = 64 * 1024;
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "paging is implemented by the read operations")
)]
pub const ROW_BUDGET: usize = 448 * 1024;
pub const REPLY_LIMIT: usize = 512 * 1024;

#[derive(Debug)]
pub struct Request {
    pub method: String,
    pub params: Map<String, Value>,
}

pub fn invalid_field(field: &str, reason: &str, limit: Option<usize>) -> HandlerOutcome {
    let mut detail = json!({"field": field, "reason": reason});
    if let Some(limit) = limit {
        detail["limit"] = json!(limit);
    }
    HandlerOutcome::ErrorWithDetail {
        code: "invalid_params".into(),
        message: format!("Parameter {field} is invalid ({reason})."),
        detail,
    }
}

pub fn object<'a>(value: &'a Value, field: &str) -> Result<&'a Map<String, Value>, HandlerOutcome> {
    value
        .as_object()
        .ok_or_else(|| invalid_field(field, "type", None))
}

/// Apply this allowlist to each object before decoding its values. Keeping the
/// path separate from serde's error text makes nested refusal names stable.
/// Each operation owns its parameter schema and must call this at every object depth.
pub fn refuse_unknown(
    object: &Map<String, Value>,
    allowed: &[&str],
    path: &str,
) -> Result<(), HandlerOutcome> {
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            let field = if path.is_empty() {
                key.clone()
            } else {
                format!("{path}.{key}")
            };
            return Err(invalid_field(&field, "unknown", None));
        }
    }
    Ok(())
}

pub fn unknown_method(method: &str) -> HandlerOutcome {
    HandlerOutcome::ErrorWithDetail {
        code: "app_op_unknown".into(),
        message: format!("App read method {method:?} is not available."),
        detail: json!({"method": method}),
    }
}

pub fn parse(body: &[u8]) -> Result<Request, HandlerOutcome> {
    if body.len() > REQUEST_LIMIT {
        return Err(HandlerOutcome::ErrorWithDetail {
            code: "request_too_large".into(),
            message: "App read request exceeds 64 KiB.".into(),
            detail: json!({"limit": REQUEST_LIMIT}),
        });
    }
    let value: Value = serde_json::from_slice(body).map_err(|_| invalid_request())?;
    let envelope = value.as_object().ok_or_else(invalid_request)?;
    refuse_unknown(envelope, &["method", "params"], "")?;
    let method = envelope
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_field("method", "type", None))?;
    if !super::APP_READ_METHODS.contains(&method) {
        return Err(unknown_method(method));
    }
    let params = object(envelope.get("params").unwrap_or(&Value::Null), "params")?.clone();
    Ok(Request {
        method: method.into(),
        params,
    })
}

fn invalid_request() -> HandlerOutcome {
    HandlerOutcome::Error {
        code: "invalid_request".into(),
        message: "App read request must be a JSON object.".into(),
    }
}

/// Serialize the complete escaped JSON, not an estimate of the unescaped fields.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "successful replies arrive with the read operations"
    )
)]
pub fn reply(op: &str, as_of_ms: i64, mut fields: Map<String, Value>) -> HandlerOutcome {
    fields.insert("schema".into(), json!(1));
    fields.insert("op".into(), json!(op));
    fields.insert("as_of_ms".into(), json!(as_of_ms));
    let bytes = serde_json::to_vec(&fields).expect("JSON values serialize");
    if bytes.len() > REPLY_LIMIT {
        return HandlerOutcome::ErrorWithDetail {
            code: "reply_too_large".into(),
            message: "App read reply exceeds 512 KiB.".into(),
            detail: json!({"bytes": bytes.len()}),
        };
    }
    HandlerOutcome::Response(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detail(outcome: HandlerOutcome) -> (String, Value) {
        match outcome {
            HandlerOutcome::ErrorWithDetail { code, detail, .. } => (code, detail),
            other => panic!("expected detail, got {other:?}"),
        }
    }

    #[test]
    fn unknown_top_level_and_nested_keys_have_dotted_names() {
        let (code, field) = detail(
            parse(br#"{"method":"context.states","params":{},"accept_reply_pages":true}"#)
                .unwrap_err(),
        );
        assert_eq!(code, "invalid_params");
        assert_eq!(
            field,
            json!({"field":"accept_reply_pages","reason":"unknown"})
        );
        let params = json!({"filters":{"statuss":"active"}});
        let params = object(&params, "params").unwrap();
        refuse_unknown(params, &["filters"], "params").unwrap();
        let filters = object(&params["filters"], "params.filters").unwrap();
        let (code, field) =
            detail(refuse_unknown(filters, &["status"], "params.filters").unwrap_err());
        assert_eq!(code, "invalid_params");
        assert_eq!(
            field,
            json!({"field":"params.filters.statuss","reason":"unknown"})
        );
    }

    #[test]
    fn request_bounds_and_types_are_checked_before_dispatch() {
        let (code, d) = detail(parse(&vec![b'!'; REQUEST_LIMIT + 1]).unwrap_err());
        assert_eq!(code, "request_too_large");
        assert_eq!(d, json!({"limit":65536}));
        for body in [b"[1]".as_slice(), b"null", b"broken", b"1"] {
            assert!(
                matches!(parse(body), Err(HandlerOutcome::Error { code, .. }) if code == "invalid_request")
            );
        }
        for params in [
            "",
            ",\"params\":null",
            ",\"params\":[]",
            ",\"params\":false",
        ] {
            let body = format!("{{\"method\":\"context.states\"{params}}}");
            assert_eq!(
                detail(parse(body.as_bytes()).unwrap_err()).1,
                json!({"field":"params","reason":"type"})
            );
        }
        let mut body = br#"{"method":"context.states","params":{}}"#.to_vec();
        body.resize(REQUEST_LIMIT, b' ');
        assert_eq!(parse(&body).unwrap().method, "context.states");
    }

    #[test]
    fn reply_envelope_preserves_null_and_measures_escaped_bytes() {
        assert_eq!(ROW_BUDGET, 458752);
        let fields = json!({"tokens":null,"complete":false})
            .as_object()
            .unwrap()
            .clone();
        match reply("context.states", 123, fields) {
            HandlerOutcome::Response(bytes) => assert_eq!(
                serde_json::from_slice::<Value>(&bytes).unwrap(),
                json!({"schema":1,"op":"context.states","as_of_ms":123,"tokens":null,"complete":false})
            ),
            other => panic!("{other:?}"),
        }
        let fields = json!({"text":"\n".repeat(REPLY_LIMIT / 2)})
            .as_object()
            .unwrap()
            .clone();
        let (code, d) = detail(reply("context.states", 1, fields));
        assert_eq!(code, "reply_too_large");
        assert!(d["bytes"].as_u64().unwrap() > REPLY_LIMIT as u64);
    }
}
