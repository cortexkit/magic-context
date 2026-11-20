//! The two read-only operations a Basal flow may call on Magic Context's
//! management surface, and the gate that keeps flows to them.
//!
//! - `events_get {event_key, event_name, version}` serves the body of a
//!   `docs_proposal` event exactly as it was stored when the proposal was
//!   made, with its digest and when its notice went out, whatever the
//!   proposal's status is now. Only an unknown key, or a name or version this
//!   module never published, is refused (`event_not_visible`).
//! - `docs_proposals.state {proposal_id}` says whether the proposal is still
//!   pending, checked against the documents as every read is
//!   ([`super::refresh`]). A flow asks it first and does nothing unless the
//!   proposal is pending.
//!
//! A route the daemon bound under a flow's scope (`flow_id` in the stamp) may
//! call these two and nothing else, on any surface the module serves:
//! [`flow_route_refusal`] refuses every other request as
//! `flow_route_not_admitted` before it is dispatched. Declaring
//! `flow-scopes/v1` promises the daemon that the module never treats a flow
//! as its owner agent for approvals, writes or grants, and keeping flows to a
//! fixed list of reads keeps that true whatever checks the module's other
//! surfaces make. No
//! `ctx_*` tool is reachable from a flow. Each operation also checks the
//! route's stamp before it reads anything ([`authorize_caller`]): the call
//! must come through the module that carries flow calls (Basal), under a
//! flow scope its owner authorized.
//! Any operator-approved flow may read a proposal; the flow's author is not
//! checked.

use serde_json::{json, Map, Value};
use subc_protocol::call_mode::{derive_call_mode, CallMode};
use subc_protocol::scope::ScopeStamp;
use subc_protocol::{ErrorBody, Principal};

use crate::context_db::ContextDb;

/// The event read.
pub(crate) const EVENTS_GET: &str = "events_get";
/// The proposal status read.
pub(crate) const STATE: &str = "docs_proposals.state";
/// The only methods a flow-scoped route may call. A new flow op joins this
/// list deliberately.
pub(crate) const FLOW_ROUTE_METHODS: &[&str] = &[EVENTS_GET, STATE];
/// The module that carries every flow's calls to other modules.
const FLOW_CARRIER: &str = "basal";
/// The module that owns flow scopes and is authorized to set their attributes.
const FLOW_SCOPE_OWNER: &str = crate::prefrontal::MODULE_ID;

fn reserved(principal: &Principal, module: &str) -> bool {
    matches!(principal, Principal::Reserved { module_id } if module_id == module)
}

/// Whether the daemon bound a route under a flow's scope.
pub(crate) fn flow_scoped(scope: Option<&ScopeStamp>) -> bool {
    scope.is_some_and(|scope| scope.attributes.flow_id.is_some())
}

/// The refusal for a request on a flow-scoped route that isn't one of
/// [`FLOW_ROUTE_METHODS`] in the `{"method": ...}` shape, or `None` for one
/// that is. A tool call (`{"name", "arguments"}`) carries no method and is
/// refused too, as is a body that isn't JSON.
pub(crate) fn flow_route_refusal(body: &[u8]) -> Option<ErrorBody> {
    let request: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str);
    if method.is_some_and(|method| FLOW_ROUTE_METHODS.contains(&method)) {
        return None;
    }
    let named = method
        .or_else(|| request.get("name").and_then(Value::as_str))
        .or_else(|| request.get("kind").and_then(Value::as_str))
        .unwrap_or("(no method)");
    Some(ErrorBody::new(
        "flow_route_not_admitted",
        format!("a flow-scoped route may call only {FLOW_ROUTE_METHODS:?}, not `{named}`"),
    ))
}

/// Admits a route only when the daemon stamped it as a flow's: carried by
/// the flow carrier, under an owner-authorized scope the flow-scope owner
/// made for a flow. Every refusal names the field that failed. With only
/// `flow-scopes/v1` declared the daemon sends no explicit call mode, so the
/// mode is derived from the stamp exactly as the SDK derives it for the bind.
pub(crate) fn authorize_caller(
    method: &str,
    principal: Option<&Principal>,
    scope: Option<&ScopeStamp>,
) -> Result<(), String> {
    if !principal.is_some_and(|principal| reserved(principal, FLOW_CARRIER)) {
        return Err(format!(
            "{method} needs the flow carrier reserved:{FLOW_CARRIER}, got {principal:?}"
        ));
    }
    let Some(scope) = scope else {
        return Err(format!("{method} needs a daemon scope stamp"));
    };
    if !reserved(&scope.owner, FLOW_SCOPE_OWNER) {
        return Err(format!(
            "{method} needs a scope owned by reserved:{FLOW_SCOPE_OWNER}, got {:?}",
            scope.owner
        ));
    }
    if !scope.owner_authorized {
        return Err(format!("{method} needs an owner_authorized scope"));
    }
    if scope.attributes.flow_id.is_none() {
        return Err(format!("{method} needs a scope with `flow_id`"));
    }
    let mode = derive_call_mode(Some(scope));
    if mode != CallMode::Flow {
        return Err(format!("{method} needs call mode `flow`, got {mode:?}"));
    }
    Ok(())
}

fn invalid(field: &str) -> ErrorBody {
    ErrorBody::new("invalid_params", format!("Invalid {field}."))
        .with_detail(json!({"field": field}))
}

fn not_visible() -> ErrorBody {
    ErrorBody::new(
        "event_not_visible",
        "Magic Context published no such event.",
    )
}

fn unavailable() -> ErrorBody {
    ErrorBody::new("store_unavailable", "The memory store could not be read.")
}

/// `params` as an object with only `allowed` keys.
fn object<'a>(params: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>, ErrorBody> {
    let object = params.as_object().ok_or_else(|| invalid("params"))?;
    if let Some(unknown) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid(&format!("params.{unknown}")));
    }
    Ok(object)
}

/// One flow request, `{"method", "params"}`, once its route is admitted:
/// the reply in the management envelope, `{"result": ...}`.
pub(crate) fn handle(db: Option<&ContextDb>, request: &Value) -> Result<Value, ErrorBody> {
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("method"))?;
    let params = request.get("params").unwrap_or(&Value::Null);
    let result = match method {
        EVENTS_GET => events_get(db, params)?,
        STATE => state(db, params)?,
        other => {
            return Err(ErrorBody::new(
                "unknown_method",
                format!("{other} isn't a flow operation"),
            ))
        }
    };
    Ok(json!({ "result": result }))
}

/// `events_get {event_key, event_name, version}`.
pub(crate) fn events_get(db: Option<&ContextDb>, params: &Value) -> Result<Value, ErrorBody> {
    let p = object(params, &["event_key", "event_name", "version"])?;
    let key = p
        .get("event_key")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("params.event_key"))?;
    let name = p
        .get("event_name")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("params.event_name"))?;
    let version = p
        .get("version")
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid("params.version"))?;
    if name != super::EVENT_NAME || version != u64::from(super::EVENT_VERSION) {
        return Err(not_visible());
    }
    let Some((project, id)) = key.rsplit_once(':') else {
        return Err(not_visible());
    };
    let Ok(id) = id.parse::<i64>() else {
        return Err(not_visible());
    };
    let db = db.ok_or_else(unavailable)?;
    let proposal = db
        .with_connection(|conn| super::by_id(conn, id))
        .map_err(|error| {
            tracing::warn!("ck-mc: events_get failed: {error}");
            unavailable()
        })?
        .filter(|proposal| proposal.project == project)
        .ok_or_else(not_visible)?;
    Ok(json!({
        "body": proposal.body,
        "digest": super::sha256(proposal.body.as_bytes()),
        "event_key": key,
        "event_name": super::EVENT_NAME,
        "published_at": proposal.published_at,
    }))
}

/// `docs_proposals.state {proposal_id}`.
pub(crate) fn state(db: Option<&ContextDb>, params: &Value) -> Result<Value, ErrorBody> {
    let p = object(params, &["proposal_id"])?;
    let id = p
        .get("proposal_id")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0)
        .ok_or_else(|| invalid("params.proposal_id"))?;
    let db = db.ok_or_else(unavailable)?;
    let proposal = super::refresh_id(db, id)
        .map_err(|error| {
            tracing::warn!("ck-mc: {STATE} failed: {error}");
            unavailable()
        })?
        .ok_or_else(not_visible)?;
    Ok(json!({ "state": proposal.status }))
}
