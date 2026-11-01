// These vectors specify MC's UI contract before its implementation. The hashes
// identify the reviewed thalamus-harness-mc-ui-surfaces.md and bridge-specs-for-
// thalamus.md design documents. The THALAMUS document's refreshed NDJSON contract
// supersedes its 86c854f8 digest. That streaming transport belongs to the host
// bridge; ck-mc supplies bounded event pages through authenticated method calls.
#[cfg(test)]
const OPS_VECTORS: &str = r#"
{
  "provenance": {
    "thalamus_sha256": "15c49d01a67ade1736d18c1c1ceb80d7ac0ab963be153018ff6fcefc408022c2",
    "bridge_sha256": "28bbe2780131017452feb4002ff3886374c1d763448181772b6ad31b572b2fc2",
    "sources": ["THALAMUS section 2 operation table", "THALAMUS section 4", "bridge items 3 and 4"],
    "oracle": "MC schemas specified before Rust implementation; not generated from Rust",
    "flush_correction":"Owner-authorized deferred-drop semantics: next transform performs protected/live-input checked reductions; the bridge must act on refresh obligations."
  },
  "partial": {"v":1,"ok":false,"state":"partial","reason":"store_unavailable","authority":"unknown","data":null},
  "authorization": [
    {"case":"missing_version","code":"bad_request"},
    {"case":"missing_session","code":"bad_request"},
    {"case":"empty_session","code":"bad_request"},
    {"case":"unbound","code":"route_unbound"},
    {"case":"foreign_session","code":"session_mismatch"}
  ],
  "reads": [
    {"method":"mc.read_sidebar","fields":["usage_percentage","input_tokens","context_limit","native_context_usage_percentage","compaction_enabled","system_prompt_tokens","compartment_count","archived_compartment_count","memory_count","memory_block_count","pending_ops_count","historian_running","compartment_in_progress","session_note_count","ready_smart_note_count","cache_ttl","last_transform_error","historian_failure_count","last_dreamer_run_at","project_identity","compartment_tokens","fact_tokens","memory_tokens","docs_tokens","profile_tokens","conversation_tokens","tool_call_tokens","tool_definition_tokens","host_limitations","tail_hygiene","execute_threshold","execute_threshold_clamped","boundary_present","coverage_ordinal","new_work_tokens","total_input_tokens","dreamer_backlog","dreamer_progress","dreamer_failures","dreamer_skipped","jobs"]},
    {"method":"mc.read_status","fields":["sidebar","compartment_scores","memory_importance","storage_schema_version","plugin_version","config_generation","config_warnings","tag_counts","tag_counts_authoritative","last_response_time","last_nudge_time","is_subagent","window_geometry","protected_tokens","history_budget","compression_budget","cache_ttl_ms","cache_remaining_ms","cache_expired","cache_ttl_source","cache_ttl_model","marker_retry_health","host_health","mc_health","embedding_summary","mural_age","rust_runner","memory_authority","mirror_frontier","unsupported_tasks","tick_failure","last_compartment","historian","reasoning_budget"]},
    {"method":"mc.read_embed","fields":["enabled","model","provider","synapse_descriptor","session","memories","commits","drain","status_text"]},
    {"method":"mc.read_compartment_count","fields":["count"]},
    {"method":"mc.read_todos","fields":["items","source"]}
  ],
  "read_envelope": {"v":1,"ok":true,"state":"ready","authority":"mc","session_id":"ops-a","project_identity":"project-a"},
  "unknown": {"value":null,"authority":"unknown","source":"not_ingested"},
  "known_empty_todos": {"items":[],"source":"todo_state.set"},
  "unported": ["mc.dream","mc.wrapup","mc.recomp_preview","mc.recomp_start","mc.rescore","mc.embed"],
  "refusal_code":"route_not_ported",
  "refusal_route_field":"message",
  "capabilities": {
    "schema_version":1,
    "emits_push":false,
    "manual_tasks":[],
    "full_recomp":false,
    "partial_recomp":false,
    "unified_wrapup":false,
    "manual_dream":false,
    "event_retention":256,
    "event_page_limit":64,
    "currentness_policy":"current_until_withdrawn",
    "command_retention":"session_lifetime",
    "job_scope_end":"retained_until_session_retirement"
  },
  "flush": {
    "command_id":"flush-1",
    "effect_count":1,
    "job_state":"armed",
    "result":{"queued_drops":{"state":"pending","count":2,"target_tag_ids":["tag-a","tag-b"]},"soft_refresh_pending":true,"bridge_refresh_obligations":["materialization","history","system"],"history_rebuilt":false},
    "duplicate":"same_job_same_result",
    "parameter_mismatch":"command_parameter_mismatch",
    "completion_hook":"deferred; no drained claim without transform acknowledgement",
    "superseding_flush":"superseded",
    "compaction_off":{"queued_drops":{"state":"pending","count":2,"target_tag_ids":["tag-a","tag-b"]},"soft_refresh_pending":false,"bridge_refresh_obligations":[],"history_rebuilt":false,"reason":"compaction_off"}
  },
  "jobs": {"lookup":"job_id_or_command_id","cancel_terminal":"too_late","cancel_armed":"cancel_unsupported","missing":"job_not_found","foreign_session":"job_not_found"},
  "events": {
    "acked_position":1,
    "through_sequence":3,
    "expected_sequences":[2,3],
    "currentness":{"policy":"current_until_withdrawn","current":true},
    "gap":"resync_required",
    "future_ack":"invalid_ack",
    "zero_limit":"bad_request",
    "unknown_currentness":{"policy":"current_until_withdrawn","current":false},
    "emits_push":false
  },
  "served_unchanged":["health","status","diagnostics","session.status","session.flush","session.recomp","session.wrapup","/ctx-status"]
}
"#;

use crate::HandlerOutcome;
use crate::{non_served_contract, non_served_route_refusal, respond, McHandler};
use mc_store::command_ledger::{EVENT_PAGE_LIMIT, EVENT_RETENTION};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(super) const IMPLEMENTED: &[&str] = &[
    "mc.ui_capabilities",
    "mc.read_sidebar",
    "mc.read_status",
    "mc.read_embed",
    "mc.read_compartment_count",
    "mc.read_todos",
    "mc.flush",
    "mc.job_read",
    "mc.job_cancel",
    "mc.ui_events",
    "mc.notice_currentness",
];
pub(super) const UNPORTED: &[&str] = &[
    "mc.dream",
    "mc.wrapup",
    "mc.recomp_preview",
    "mc.recomp_start",
    "mc.rescore",
    "mc.embed",
];

fn error(code: &str) -> HandlerOutcome {
    HandlerOutcome::Error {
        code: code.into(),
        message: code.into(),
    }
}

fn unknown() -> Value {
    json!({"value":null,"authority":"unknown","source":"not_ingested"})
}

fn respond_ui(body: Value) -> HandlerOutcome {
    let bytes = serde_json::to_vec(&body).expect("JSON value");
    if bytes.len() > 1024 * 1024 {
        error("ui_reply_too_large")
    } else {
        HandlerOutcome::Response(bytes)
    }
}
fn known(value: Value, source: &str) -> Value {
    json!({"value":value,"authority":"mc","source":source})
}
fn fields(names: &[&str]) -> Value {
    Value::Object(
        names
            .iter()
            .map(|name| ((*name).into(), unknown()))
            .collect(),
    )
}
fn put(data: &mut Value, key: &str, value: &Value, source: &str) {
    if !value.is_null() {
        data[key] = known(value.clone(), source);
    }
}

const SIDEBAR_FIELDS: &[&str] = &[
    "usage_percentage",
    "input_tokens",
    "context_limit",
    "native_context_usage_percentage",
    "compaction_enabled",
    "system_prompt_tokens",
    "compartment_count",
    "archived_compartment_count",
    "memory_count",
    "memory_block_count",
    "pending_ops_count",
    "historian_running",
    "compartment_in_progress",
    "session_note_count",
    "ready_smart_note_count",
    "cache_ttl",
    "last_transform_error",
    "historian_failure_count",
    "last_dreamer_run_at",
    "project_identity",
    "compartment_tokens",
    "fact_tokens",
    "memory_tokens",
    "docs_tokens",
    "profile_tokens",
    "conversation_tokens",
    "tool_call_tokens",
    "tool_definition_tokens",
    "host_limitations",
    "tail_hygiene",
    "execute_threshold",
    "execute_threshold_clamped",
    "boundary_present",
    "coverage_ordinal",
    "new_work_tokens",
    "total_input_tokens",
    "dreamer_backlog",
    "dreamer_progress",
    "dreamer_failures",
    "dreamer_skipped",
    "jobs",
];
const STATUS_FIELDS: &[&str] = &[
    "sidebar",
    "compartment_scores",
    "memory_importance",
    "storage_schema_version",
    "plugin_version",
    "config_generation",
    "config_warnings",
    "tag_counts",
    "tag_counts_authoritative",
    "last_response_time",
    "last_nudge_time",
    "is_subagent",
    "window_geometry",
    "protected_tokens",
    "history_budget",
    "compression_budget",
    "cache_ttl_ms",
    "cache_remaining_ms",
    "cache_expired",
    "cache_ttl_source",
    "cache_ttl_model",
    "marker_retry_health",
    "host_health",
    "mc_health",
    "embedding_summary",
    "mural_age",
    "rust_runner",
    "memory_authority",
    "mirror_frontier",
    "unsupported_tasks",
    "tick_failure",
    "last_compartment",
    "historian",
    "reasoning_budget",
];

fn capabilities() -> Value {
    json!({"schema_version":1,"emits_push":false,"manual_tasks":[],"full_recomp":false,
        "partial_recomp":false,"unified_wrapup":false,"manual_dream":false,
        "event_retention":EVENT_RETENTION,"event_page_limit":EVENT_PAGE_LIMIT,
        "currentness_policy":"current_until_withdrawn","command_retention":"session_lifetime",
        "job_scope_end":"retained_until_session_retirement","implemented":IMPLEMENTED,
        "unsupported":UNPORTED,"error_source":"module","release_metadata":null})
}

impl McHandler {
    fn ops_binding_project(
        &self,
        channel: u16,
        store: &mc_store::McStore,
        binding: &crate::SessionBinding,
    ) -> Result<String, HandlerOutcome> {
        // Session history can keep its previously recorded project after a
        // directory change. Do not expose that project's saved UI jobs to a
        // caller whose current bound checkout belongs to a different project.
        #[cfg(test)]
        let root = if !self
            .resolve_project_identity_for_test
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            Ok(store
                .route_identity_for_test(&binding.project_root.to_string_lossy())
                .unwrap_or_else(|| binding.project_root.to_string_lossy().into_owned()))
        } else {
            self.project_identities.resolve(&binding.project_root)
        };
        #[cfg(not(test))]
        let root = self.project_identities.resolve(&binding.project_root);
        let root = root.map_err(|e| HandlerOutcome::Error {
            code: e.code().into(),
            message: e.to_string(),
        })?;
        let recorded = self.route_project_identity(channel, store, binding)?;
        if root != recorded {
            return Err(error("project_scope_mismatch"));
        }
        Ok(root)
    }

    pub(super) fn handle_ops_facade(
        &self,
        channel: u16,
        request: &Value,
        method: &str,
    ) -> HandlerOutcome {
        let (session, binding) = match self.management_binding(channel, request, method) {
            Ok(scope) => scope,
            Err(outcome) => return outcome,
        };
        if let Err(outcome) = authorize_harness_scope(&binding) {
            return outcome;
        }
        let Some(store) = self.store.get() else {
            return if non_served_contract::UI_READ_METHODS.contains(&method)
                || IMPLEMENTED.contains(&method)
            {
                respond(non_served_contract::partial_state_body())
            } else {
                non_served_route_refusal(method)
            };
        };
        let project = match self.ops_binding_project(channel, store, &binding) {
            Ok(project) => Some(project),
            Err(HandlerOutcome::Error { code, .. })
                if code == "store_load_failed"
                    && non_served_contract::UI_READ_METHODS.contains(&method) =>
            {
                return respond(non_served_contract::partial_state_body());
            }
            Err(outcome) => return outcome,
        };
        let project = project.expect("admitted project");
        match store.ops_check_project(&project, &session) {
            Ok(true) => {}
            Ok(false) => return error("project_scope_mismatch"),
            Err(_) => return respond(non_served_contract::partial_state_body()),
        }
        if method == "mc.dream" {
            return self.dream_control_entry(&binding, request);
        }
        if UNPORTED.contains(&method) {
            return non_served_route_refusal(method);
        }
        let result = match method {
            "mc.ui_capabilities" => {
                store
                    .ops_snapshot_in_project(&project, &session)
                    .map(|snapshot| {
                        if snapshot.get("error").is_some() {
                            snapshot
                        } else {
                            capabilities()
                        }
                    })
            }
            "mc.read_sidebar"
            | "mc.read_status"
            | "mc.read_embed"
            | "mc.read_compartment_count"
            | "mc.read_todos" => {
                store.ops_snapshot_in_project(&project,&session).and_then(|snapshot| {
                    if snapshot.get("error").is_some() { return Ok(snapshot); }
                    let config = self.effective_config(&binding.project_root);
                    let mut sidebar = fields(SIDEBAR_FIELDS);
                    sidebar["jobs"] = known(json!(store.ops_jobs_in_project(&project,&session)?),"mc_ops_commands");
                    sidebar["compaction_enabled"] = known(json!(config.compaction_enabled),"mc_config");
                    sidebar["project_identity"] = known(json!(project),"admitted_binding");
                    let meta = &snapshot["meta"];
                    if !snapshot["row_version"].is_null() {
                        put(&mut sidebar,"compartment_count",&snapshot["compartment_count"],"context_compartments");
                        put(&mut sidebar,"boundary_present",&snapshot["boundary_present"],"mc_cache_state");
                        put(&mut sidebar,"coverage_ordinal",&meta["coverage_ordinal"],"mc_cache_state");
                        // Older records encode an omitted token count as zero and
                        // do not retain whether zero was measured. Publish input
                        // and percentages only when positive input was recorded.
                        if meta["last_usage"]["current_total_input_tokens"].as_u64().is_some_and(|v| v > 0) {
                            put(&mut sidebar,"input_tokens",&meta["last_usage"]["current_total_input_tokens"],"admitted_usage");
                        }
                        if meta["last_usage"]["context_limit_tokens"].as_u64().is_some_and(|v| v > 0) {
                            put(&mut sidebar,"context_limit",&meta["last_usage"]["context_limit_tokens"],"admitted_usage");
                        }
                        if let (Some(input),Some(limit)) = (meta["last_usage"]["current_total_input_tokens"].as_f64(),meta["last_usage"]["context_limit_tokens"].as_f64()) {
                            if limit > 0.0 && input > 0.0 && input <= limit {
                                let percent = json!(input / limit * 100.0);
                                sidebar["usage_percentage"] = known(percent.clone(),"admitted_usage");
                                sidebar["native_context_usage_percentage"] = known(percent,"admitted_usage");
                            }
                        }
                    }
                    put(&mut sidebar,"cache_ttl",&meta["cache_ttl_policy"]["value"],"mc_cache_state");
                    let data = match method {
                        "mc.read_sidebar" => sidebar,
                        "mc.read_status" => {
                            let mut data = fields(STATUS_FIELDS);
                            data["sidebar"] = known(sidebar,"mc_read_sidebar");
                            if !snapshot["row_version"].is_null() {
                                put(&mut data,"historian",&meta["historian"],"mc_cache_state");
                                put(&mut data,"protected_tokens",&meta["protected_tokens_effective"],"mc_cache_state");
                                put(&mut data,"cache_ttl_source",&meta["cache_ttl_policy"]["source"],"mc_cache_state");
                                put(&mut data,"cache_ttl_model",&meta["cache_ttl_policy"]["model_key"],"mc_cache_state");
                                if let Some(ttl) = meta["cache_ttl_policy"]["value"].as_str().and_then(|s| crate::scheduler::parse_cache_ttl(s).ok()) {
                                    data["cache_ttl_ms"] = known(if ttl == u64::MAX {json!(-1)} else {json!(ttl)},"mc_cache_state");
                                }
                            }
                            data
                        }
                        "mc.read_embed" => fields(&["enabled","model","provider","synapse_descriptor","session","memories","commits","drain","status_text"]),
                        "mc.read_compartment_count" => json!({"count":sidebar["compartment_count"]}),
                        "mc.read_todos" => {
                            let mut data = fields(&["items","source"]);
                            if let Some(text) = meta["last_todo_state"].as_str() {
                                if let Ok(items) = serde_json::from_str::<Value>(text) {
                                    data["items"] = known(items,"todo_state.set");
                                    data["source"] = known(json!("todo_state.set"),"mc_cache_state");
                                }
                            }
                            data
                        }
                        _ => unreachable!(),
                    };
                    let generation = format!("{:x}",Sha256::digest(serde_json::to_vec(&data).expect("JSON value")));
                    Ok(json!({"v":1,"ok":true,"state":"ready","authority":"mc","session_id":binding.session,
                        "project_identity":project,"generation":generation,"as_of_ms":crate::now_ms(),"data":data}))
                })
            }
            "mc.flush" => {
                let Some(command) = request
                    .get("command_id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.trim().is_empty() && id.len() <= 256)
                else {
                    return error("bad_request");
                };
                let config = self.effective_config(&binding.project_root);
                store.ops_flush_in_project(
                    &project,
                    &session,
                    command,
                    config.compaction_enabled,
                    crate::now_ms(),
                )
            }
            "mc.job_read" | "mc.job_cancel" => {
                let command = request.get("command_id").and_then(Value::as_str);
                let job = request.get("job_id").and_then(Value::as_str);
                if command.is_none() && job.is_none() {
                    return error("bad_request");
                }
                store
                    .ops_job_in_project(&project, &session, command, job)
                    .map(|job| match job {
                        Some(job) if method == "mc.job_cancel" && job["state"] == "armed" => {
                            json!({"error":"cancel_unsupported"})
                        }
                        Some(job) if method == "mc.job_cancel" => {
                            json!({"v":1,"state":"too_late","job":job})
                        }
                        Some(job) => json!({"v":1,"job":job}),
                        None => json!({"error":"job_not_found"}),
                    })
            }
            "mc.ui_events" => {
                let Some(ack) = request
                    .get("acked_position")
                    .and_then(Value::as_i64)
                    .filter(|v| *v >= 0)
                else {
                    return error("bad_request");
                };
                let limit = match request.get("limit") {
                    None => EVENT_PAGE_LIMIT,
                    Some(v) => match v
                        .as_u64()
                        .filter(|v| *v > 0 && *v <= EVENT_PAGE_LIMIT as u64)
                    {
                        Some(v) => v as usize,
                        None => return error("bad_request"),
                    },
                };
                store.ops_events_in_project(&project, &session, ack, limit)
            }
            "mc.notice_currentness" => {
                let Some(id) = request.get("event_id").and_then(Value::as_str) else {
                    return error("bad_request");
                };
                store.ops_currentness_in_project(&project,&session,id).map(|current| json!({"v":1,"policy":"current_until_withdrawn","current":current}))
            }
            _ => return non_served_route_refusal(method),
        };
        match result {
            Ok(body) => match body.get("error").and_then(Value::as_str) {
                Some(code) => error(code),
                None => respond_ui(body),
            },
            Err(_) => respond(non_served_contract::partial_state_body()),
        }
    }
}

#[cfg(test)]
pub(crate) fn attest_ui_fixture(
    handler: &McHandler,
    store: Option<&mc_store::McStore>,
    project: &str,
) {
    let mut binding = handler.bindings.lock().unwrap().get(&7).unwrap().clone();
    binding.principal = Some(subc_protocol::Principal::Reserved {
        module_id: "thalamus-harness".into(),
    });
    binding.scope = Some(
        subc_protocol::scope::ScopeStamp::new(
            subc_protocol::Principal::Reserved {
                module_id: "prefrontal-core".into(),
            },
            "ui-session",
            1,
            subc_protocol::scope::ScopeKind::Head,
        )
        .with_owner_authorized(true),
    );
    if let Some(store) = store {
        store.with_context_conn_for_test(|conn| {
            for session in [&binding.session,"ops-b"] {
                conn.execute("INSERT OR REPLACE INTO session_projects(session_id,harness,project_path,updated_at) VALUES(?1,'opencode',?2,1)",rusqlite::params![session,project])?;
            }
            Ok(())
        }).unwrap();
    }
    handler.bind_route(7, binding);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::McModuleConfig, SessionBinding};
    use mc_store::{McStore, ModuleMeta, StoredCompartment};
    use std::sync::Arc;

    fn vectors() -> Value {
        serde_json::from_str(OPS_VECTORS).unwrap()
    }
    pub(super) fn fixture() -> (McHandler, Arc<McStore>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(
            McStore::open_for_test(&crate::dev_descriptor_at(dir.path().to_str().unwrap()))
                .unwrap(),
        );
        let mut handler = McHandler::new();
        let config = McModuleConfig {
            compaction_enabled: true,
            ..Default::default()
        };
        handler.fixed_config = Some(config.clone());
        handler.store.set(store.clone()).ok().unwrap();
        handler.bind_route(
            7,
            SessionBinding {
                principal: None,
                scope: None,
                project_root: dir.path().to_path_buf(),
                harness: "mc-module-test".into(),
                session: "ops-a".into(),
                model_key: None,
                config,
                history_budget_tokens: crate::memory_render::DEFAULT_HISTORY_BUDGET_TOKENS,
            },
        );
        store.set_route_identity_for_test(dir.path().to_str().unwrap(), "project-a");
        attest_ui_fixture(&handler, Some(&store), "project-a");
        store
            .commit(
                "ops-a",
                None,
                &Default::default(),
                &ModuleMeta {
                    initialized: true,
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .replace_compartments(
                "ops-a",
                &[StoredCompartment {
                    sequence: 1,
                    start_message: 1,
                    end_message: 2,
                    end_message_id: "a2".into(),
                    title: "owned".into(),
                    content: "own".into(),
                    ..Default::default()
                }],
            )
            .unwrap();
        store
            .replace_compartments(
                "ops-b",
                &[StoredCompartment {
                    sequence: 1,
                    start_message: 1,
                    end_message: 9,
                    end_message_id: "b9".into(),
                    title: "secret".into(),
                    content: "foreign-private".into(),
                    ..Default::default()
                }],
            )
            .unwrap();
        (handler, store, dir)
    }
    fn request(method: &str) -> Value {
        json!({"method":method,"v":1,"session_id":"ops-a"})
    }
    async fn call(handler: &McHandler, req: Value) -> Value {
        match handler.dispatch_value(7, req).await {
            HandlerOutcome::Response(bytes) => serde_json::from_slice(&bytes).unwrap(),
            other => panic!("unexpected outcome: {other:?}"),
        }
    }
    fn code(outcome: HandlerOutcome) -> String {
        match outcome {
            HandlerOutcome::Error { code, .. } => code,
            other => panic!("expected error: {other:?}"),
        }
    }
    async fn read_vector(method: &str) -> Value {
        let (handler, _store, _dir) = fixture();
        let mut req = request(method);
        req["project"] = json!("project-b");
        req["directory"] = json!("/forged");
        let body = call(&handler, req).await;
        let expected = vectors();
        assert_eq!(body["v"], 1);
        assert_eq!(body["authority"], "mc");
        assert_eq!(body["session_id"], "ops-a");
        assert_eq!(body["state"], "ready");
        let schema = expected["reads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["method"] == method)
            .unwrap();
        assert_eq!(
            body["data"]
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>(),
            schema["fields"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect()
        );
        assert!(!body.to_string().contains("foreign-private"));
        assert!(!body.to_string().contains("project-b"));
        assert_eq!(body["generation"].as_str().unwrap().len(), 64);
        body
    }
    #[tokio::test]
    async fn ops_sidebar_vector() {
        let body = read_vector("mc.read_sidebar").await;
        assert_eq!(body["project_identity"], "project-a");
        assert_eq!(body["data"]["compartment_count"]["value"], 1);
        assert_eq!(body["data"]["input_tokens"], vectors()["unknown"]);
        assert_eq!(body["data"]["compaction_enabled"]["value"], true);
    }
    #[tokio::test]
    async fn ops_status_vector() {
        let body = read_vector("mc.read_status").await;
        assert_eq!(
            body["data"]["sidebar"]["value"]["compartment_count"]["value"],
            1
        );
        assert_eq!(body["data"]["plugin_version"], vectors()["unknown"]);
        assert_eq!(
            body["data"]["tag_counts_authoritative"],
            vectors()["unknown"]
        );
    }
    #[tokio::test]
    async fn ops_embed_vector() {
        let body = read_vector("mc.read_embed").await;
        for field in ["enabled", "session", "memories", "commits", "drain"] {
            assert_eq!(body["data"][field], vectors()["unknown"]);
        }
    }
    #[tokio::test]
    async fn ops_compartment_count_vector() {
        assert_eq!(
            read_vector("mc.read_compartment_count").await["data"]["count"]["value"],
            1
        );
    }
    #[tokio::test]
    async fn ops_todos_vector_distinguishes_unknown_from_known_empty() {
        assert_eq!(
            read_vector("mc.read_todos").await["data"]["items"],
            vectors()["unknown"]
        );
        let (handler, store, _dir) = fixture();
        store
            .set_todo_state("ops-a", "[]", "owner-a", "empty-hash")
            .unwrap();
        let body = call(&handler, request("mc.read_todos")).await;
        assert_eq!(
            body["data"]["items"]["value"],
            vectors()["known_empty_todos"]["items"]
        );
        assert_eq!(
            body["data"]["source"]["value"],
            vectors()["known_empty_todos"]["source"]
        );
    }
    #[tokio::test]
    async fn ops_capabilities_vector() {
        let (handler, _store, _dir) = fixture();
        let body = call(&handler, request("mc.ui_capabilities")).await;
        for (key, value) in vectors()["capabilities"].as_object().unwrap() {
            assert_eq!(body[key], *value, "{key}");
        }
    }
    #[tokio::test]
    async fn ops_unported_routes_vector() {
        let (handler, store, _dir) = fixture();
        let before = store.load_meta("ops-a").unwrap().row_version;
        for method in vectors()["unported"].as_array().unwrap() {
            let name = method.as_str().unwrap();
            let mut req = request(name);
            req["range"] = json!({"start":1,"end":2});
            match handler.dispatch_value(7, req).await {
                HandlerOutcome::Error { code, message } => {
                    assert_eq!(code, vectors()["refusal_code"].as_str().unwrap());
                    assert_eq!(message, name);
                }
                _ => panic!("unported route must not succeed"),
            }
        }
        assert_eq!(store.load_meta("ops-a").unwrap().row_version, before);
    }
    #[tokio::test]
    async fn ops_flush_vector_is_one_atomic_arm_and_never_claims_drained() {
        let (handler, store, _dir) = fixture();
        store
            .append_pending_agent_drops("ops-a", &["tag-a".into(), "tag-b".into()], 1)
            .unwrap();
        let mut req = request("mc.flush");
        req["command_id"] = vectors()["flush"]["command_id"].clone();
        let first = call(&handler, req.clone()).await;
        let version = store.load_meta("ops-a").unwrap().row_version;
        assert_eq!(first["state"], vectors()["flush"]["job_state"]);
        assert_eq!(first["result"], vectors()["flush"]["result"]);
        assert_eq!(call(&handler, req).await, first);
        assert_eq!(store.load_meta("ops-a").unwrap().row_version, version);
        assert!(store.load_meta("ops-a").unwrap().meta.soft_refresh_pending);
        assert_eq!(store.load_pending_agent_drops("ops-a").unwrap().len(), 2);
        let mut lookup = request("mc.job_read");
        lookup["command_id"] = first["command_id"].clone();
        assert_eq!(call(&handler, lookup).await["job"], first);
        let sidebar = call(&handler, request("mc.read_sidebar")).await;
        assert_eq!(sidebar["data"]["jobs"]["value"][0], first);
    }
    #[tokio::test]
    async fn ops_flush_off_vector_does_not_arm_or_drop_work() {
        let (mut handler, store, _dir) = fixture();
        handler.fixed_config.as_mut().unwrap().compaction_enabled = false;
        store
            .append_pending_agent_drops("ops-a", &["tag-a".into(), "tag-b".into()], 1)
            .unwrap();
        let mut req = request("mc.flush");
        req["command_id"] = json!("off");
        let body = call(&handler, req).await;
        assert_eq!(body["result"], vectors()["flush"]["compaction_off"]);
        assert!(!store.load_meta("ops-a").unwrap().meta.soft_refresh_pending);
        assert_eq!(store.load_pending_agent_drops("ops-a").unwrap().len(), 2);
    }
    #[tokio::test]
    async fn ops_job_lookup_and_cancel_vectors_are_session_scoped() {
        let (handler, store, _dir) = fixture();
        let job = store.ops_flush("ops-a", "first", true, 1).unwrap();
        let mut req = request("mc.job_read");
        req["job_id"] = job["job_id"].clone();
        assert_eq!(call(&handler, req).await["job"], job);
        let mut req = request("mc.job_cancel");
        req["job_id"] = job["job_id"].clone();
        assert_eq!(
            code(handler.dispatch_value(7, req.clone()).await),
            vectors()["jobs"]["cancel_armed"].as_str().unwrap()
        );
        store.ops_flush("ops-a", "newer", true, 2).unwrap();
        assert_eq!(
            call(&handler, req).await["state"],
            vectors()["jobs"]["cancel_terminal"]
        );
        let foreign = store.ops_flush("ops-b", "foreign", true, 1).unwrap();
        let mut req = request("mc.job_read");
        req["job_id"] = foreign["job_id"].clone();
        assert_eq!(
            code(handler.dispatch_value(7, req).await),
            vectors()["jobs"]["foreign_session"].as_str().unwrap()
        );
    }
    #[tokio::test]
    async fn ops_events_vector_replays_after_ack_and_names_gaps() {
        let (handler, store, _dir) = fixture();
        for id in ["a", "b", "c"] {
            store.ops_flush("ops-a", id, true, 1).unwrap();
        }
        let mut req = request("mc.ui_events");
        req["acked_position"] = vectors()["events"]["acked_position"].clone();
        let page = call(&handler, req.clone()).await;
        assert_eq!(
            page["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e["sequence"].clone())
                .collect::<Vec<_>>(),
            vectors()["events"]["expected_sequences"]
                .as_array()
                .unwrap()
                .clone()
        );
        assert_eq!(
            page["through_sequence"],
            vectors()["events"]["through_sequence"]
        );
        assert_eq!(page["currentness"], vectors()["events"]["currentness"]);
        assert_eq!(page["emits_push"], false);
        assert_eq!(call(&handler, req.clone()).await, page);
        req["acked_position"] = json!(0);
        assert_eq!(
            code(handler.dispatch_value(7, req.clone()).await),
            vectors()["events"]["gap"].as_str().unwrap()
        );
        req["acked_position"] = json!(4);
        assert_eq!(
            code(handler.dispatch_value(7, req.clone()).await),
            vectors()["events"]["future_ack"].as_str().unwrap()
        );
        req["acked_position"] = json!(1);
        req["limit"] = json!(0);
        assert_eq!(
            code(handler.dispatch_value(7, req).await),
            vectors()["events"]["zero_limit"].as_str().unwrap()
        );
    }
    #[tokio::test]
    async fn ops_currentness_vector_withdraws_superseded_and_unknown_notices() {
        let (handler, store, _dir) = fixture();
        store.ops_flush("ops-a", "one", true, 1).unwrap();
        let page = store.ops_events("ops-a", 0, 64).unwrap();
        let mut req = request("mc.notice_currentness");
        req["event_id"] = page["events"][0]["event_id"].clone();
        assert_eq!(call(&handler, req.clone()).await["current"], true);
        store.ops_flush("ops-a", "two", true, 2).unwrap();
        assert_eq!(call(&handler, req.clone()).await["current"], false);
        req["event_id"] = json!("unknown");
        assert_eq!(
            call(&handler, req).await["current"],
            vectors()["events"]["unknown_currentness"]["current"]
        );
    }
    struct ReadFailure(i32);
    impl mc_store::single_store_domain::ContextDomain for ReadFailure {
        fn read(
            &self,
            _read: &mut dyn FnMut(&rusqlite::Connection) -> rusqlite::Result<()>,
        ) -> Result<(), mc_store::McStoreError> {
            Err(mc_store::single_store_domain::context_sql_error(
                rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(self.0),
                    Some("fixture lock contention".into()),
                ),
            ))
        }
        fn write(
            &self,
            _tables: &[&str],
            _write: &mut dyn FnMut(&rusqlite::Transaction<'_>) -> rusqlite::Result<()>,
        ) -> Result<(), mc_store::McStoreError> {
            panic!("UI reads must never invoke a domain writer")
        }
    }
    #[tokio::test]
    async fn ops_absent_and_busy_reads_vector_never_succeed_with_fake_zeros() {
        let (handler, store, _dir) = fixture();
        let absent = McHandler::new();
        absent.bind_route(7, handler.bindings.lock().unwrap().get(&7).unwrap().clone());
        for sqlite_code in [rusqlite::ffi::SQLITE_BUSY, rusqlite::ffi::SQLITE_LOCKED] {
            store.install_context_domain(Arc::new(ReadFailure(sqlite_code)));
            for method in non_served_contract::UI_READ_METHODS {
                assert_eq!(call(&absent, request(method)).await, vectors()["partial"]);
                assert_eq!(
                    call(&handler, request(method)).await,
                    vectors()["partial"],
                    "{method}"
                );
            }
        }
    }
    use mc_store::SessionCacheTtlPolicy;

    #[tokio::test]
    async fn ops_ttl_sentinels_and_unknown_usage_are_preserved() {
        let (handler, store, _dir) = fixture();
        for (policy, expected) in [("never", -1), ("0", 0)] {
            let mut loaded = store.load_meta("ops-a").unwrap();
            loaded.meta.cache_ttl_policy = Some(SessionCacheTtlPolicy {
                value: policy.into(),
                source: "host_observation".into(),
                model_key: Some("model-a".into()),
                built_in_default: "5m".into(),
            });
            store
                .commit_meta("ops-a", loaded.row_version, &loaded.meta)
                .unwrap();
            let body = call(&handler, request("mc.read_status")).await;
            assert_eq!(body["data"]["cache_ttl_ms"]["value"], expected);
            assert_eq!(
                body["data"]["sidebar"]["value"]["input_tokens"],
                vectors()["unknown"]
            );
        }
    }

    #[tokio::test]
    async fn ops_every_arm_authorizes_before_touching_the_ledger() {
        let (handler, store, _dir) = fixture();
        let before = store.load_meta("ops-a").unwrap().row_version;
        for method in non_served_contract::UI_METHODS {
            for case in vectors()["authorization"].as_array().unwrap() {
                let mut req = request(method);
                req["command_id"] = json!("unauthorized");
                req["acked_position"] = json!(0);
                let mut channel = 7;
                match case["case"].as_str().unwrap() {
                    "missing_version" => {
                        req.as_object_mut().unwrap().remove("v");
                    }
                    "missing_session" => {
                        req.as_object_mut().unwrap().remove("session_id");
                    }
                    "empty_session" => req["session_id"] = json!(""),
                    "unbound" => channel = 8,
                    "foreign_session" => req["session_id"] = json!("ops-b"),
                    _ => unreachable!(),
                }
                assert_eq!(
                    code(handler.dispatch_value(channel, req).await),
                    case["code"].as_str().unwrap(),
                    "{method}"
                );
            }
        }
        assert_eq!(store.load_meta("ops-a").unwrap().row_version, before);
        assert!(store
            .ops_job("ops-a", Some("unauthorized"), None)
            .unwrap()
            .is_none());
        assert!(store.ops_events("ops-a", 0, 64).unwrap()["events"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    #[ignore = "requires the before/after dispatcher harness with a baseline capture"]
    async fn ops_served_dispatch_reply_differential() {
        let mut replies = serde_json::Map::new();
        for method in [
            "health",
            "status",
            "diagnostics",
            "session.status",
            "session.flush",
            "session.recomp",
            "session.wrapup",
        ] {
            let (handler, _store, _dir) = fixture();
            let mut req = request(method);
            req["command_id"] = json!("served-command");
            let reply = match handler.dispatch_value(7, req).await {
                HandlerOutcome::Response(bytes) => {
                    json!({"response":serde_json::from_slice::<Value>(&bytes).unwrap()})
                }
                HandlerOutcome::Error { code, message } => json!({"code":code,"message":message}),
                other => panic!("unrecorded served outcome: {other:?}"),
            };
            replies.insert(method.into(), reply);
        }
        let actual = Value::Object(replies);
        if let Ok(path) = std::env::var("OPS_BASELINE_PATH") {
            let expected: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert_eq!(actual, expected, "served dispatcher replies changed");
            println!(
                "7 served route replies equal owner-prep baseline; /ctx-status uses session.status"
            );
        } else {
            let path = std::env::var("OPS_CAPTURE_PATH").expect("explicit baseline capture path");
            std::fs::write(path, serde_json::to_vec_pretty(&actual).unwrap()).unwrap();
            println!("captured 7 owner-prep served dispatcher replies");
        }
    }

    #[test]
    fn ops_concurrent_duplicate_flushes_return_one_job_and_effect() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(
            McStore::open_for_test(&crate::dev_descriptor_at(dir.path().to_str().unwrap()))
                .unwrap(),
        );
        store.with_context_conn_for_test(|conn| conn.execute("INSERT INTO session_projects(session_id,harness,project_path,updated_at) VALUES('ops-a','opencode','project-a',1)",[]).map(|_|())).unwrap();
        store
            .commit("ops-a", None, &Default::default(), &ModuleMeta::default())
            .unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(4));
        let handles = (0..4)
            .map(|now| {
                let store = store.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store.ops_flush("ops-a", "race", true, now).unwrap()
                })
            })
            .collect::<Vec<_>>();
        let jobs = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect::<Vec<_>>();
        assert!(jobs.iter().all(|job| job == &jobs[0]));
        assert_eq!(
            store.ops_events("ops-a", 0, 64).unwrap()["events"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(store.load_meta("ops-a").unwrap().meta.soft_refresh_pending);
    }

    mod review {
        use super::*;
        include!("tests/ops_facade_review.rs");
    }
}

#[cfg(test)]
mod repair_tests {
    use super::*;

    #[tokio::test]
    async fn ui_arms_reuse_harness_scope_attestation_for_every_harness() {
        let (handler, store, _dir) = super::tests::fixture();
        let original = handler.bindings.lock().unwrap().get(&7).unwrap().clone();
        let before = store.load_meta("ops-a").unwrap().row_version;
        for harness in ["opencode", "pi"] {
            let mut binding = original.clone();
            binding.harness = harness.into();
            handler.bind_route(7, binding.clone());
            assert!(matches!(
                handler
                    .dispatch_value(
                        7,
                        json!({"v":1,"session_id":"ops-a","method":"mc.ui_capabilities"})
                    )
                    .await,
                HandlerOutcome::Response(_)
            ));
            for failure in [
                "no_scope",
                "unauthorized_owner",
                "foreign_owner",
                "gateway_principal",
            ] {
                let mut denied = binding.clone();
                match failure {
                    "no_scope" => denied.scope = None,
                    "unauthorized_owner" => denied.scope.as_mut().unwrap().owner_authorized = false,
                    "foreign_owner" => {
                        denied.scope.as_mut().unwrap().owner = subc_protocol::Principal::Reserved {
                            module_id: "foreign".into(),
                        }
                    }
                    "gateway_principal" => {
                        denied.principal = Some(subc_protocol::Principal::Reserved {
                            module_id: "thalamus".into(),
                        })
                    }
                    _ => unreachable!(),
                }
                handler.bind_route(7, denied);
                for method in non_served_contract::UI_METHODS {
                    let reply = handler.dispatch_value(7,json!({"v":1,"session_id":"ops-a","method":method,"command_id":"denied","acked_position":0})).await;
                    match reply {
                        HandlerOutcome::Error { code, .. } => assert!(
                            code == "host_lane_requires_harness_module"
                                || code == "host_lane_scope_missing",
                            "{code}"
                        ),
                        other => panic!("{failure} reached {method}: {other:?}"),
                    }
                }
            }
        }
        assert_eq!(store.load_meta("ops-a").unwrap().row_version, before);
        assert!(store
            .ops_job("ops-a", Some("denied"), None)
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn oversized_todo_snapshot_is_explicitly_refused_before_projection() {
        let (handler, store, _dir) = super::tests::fixture();
        let text = json!([{"content":"x".repeat(600 * 1024),"status":"pending"}]).to_string();
        store
            .set_todo_state("ops-a", &text, "owner", "large")
            .unwrap();
        for method in ["mc.read_todos", "mc.read_status", "mc.read_sidebar"] {
            let reply = handler
                .dispatch_value(7, json!({"v":1,"session_id":"ops-a","method":method}))
                .await;
            match reply {
                HandlerOutcome::Error { code, .. } => assert_eq!(code, "ui_snapshot_too_large"),
                other => panic!("oversized snapshot was not refused: {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn historian_credentials_never_enter_any_ui_projection() {
        let (handler, store, _dir) = super::tests::fixture();
        let mut loaded = store.load_meta("ops-a").unwrap();
        loaded.meta.historian.coordinator_token = Some("private-claim-token".into());
        loaded.meta.historian.producer_run_id = Some("private-producer-state".into());
        store
            .commit_meta("ops-a", loaded.row_version, &loaded.meta)
            .unwrap();
        store.ops_flush("ops-a", "public-job", true, 1).unwrap();
        for method in ["mc.read_status", "mc.read_sidebar", "mc.ui_events"] {
            let req = json!({"v":1,"session_id":"ops-a","method":method,"acked_position":0});
            let HandlerOutcome::Response(bytes) = handler.dispatch_value(7, req).await else {
                panic!("read failed")
            };
            let text = String::from_utf8(bytes).unwrap();
            for secret in [
                "private-claim-token",
                "private-producer-state",
                "coordinator_token",
                "producer_run_id",
            ] {
                assert!(!text.contains(secret), "{method}: {secret}");
            }
        }
        assert!(!store
            .ops_snapshot("ops-a")
            .unwrap()
            .to_string()
            .contains("private-claim-token"));
    }
}

pub(crate) fn authorize_harness_scope(
    binding: &crate::SessionBinding,
) -> Result<(), subc_client_rs::HandlerOutcome> {
    if !matches!(&binding.principal, Some(subc_protocol::Principal::Reserved { module_id }) if module_id == "thalamus-harness")
    {
        return Err(crate::providers::error(
            "host_lane_requires_harness_module",
            "Host lane requires reserved:thalamus-harness",
        ));
    }
    if !binding.scope.as_ref().is_some_and(|scope| scope.owner_authorized && matches!(&scope.owner, subc_protocol::Principal::Reserved { module_id } if module_id == "prefrontal-core")) {
        return Err(crate::providers::error("host_lane_scope_missing", "Host lane requires an authorized reserved:prefrontal-core scope"));
    }
    Ok(())
}
