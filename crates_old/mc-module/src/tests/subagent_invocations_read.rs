// Handler-level tests for `subagent_invocations.read`, included into lib.rs's test
// module so they can use its store-backed handler fixtures. The query logic itself
// is tested in `subagent_invocations_read.rs`.

fn subagent_context_db(dir: &tempfile::TempDir) -> rusqlite::Connection {
    let descriptor = dev_descriptor_at(dir.path().join("data").to_str().unwrap());
    let StorageBackend::Sqlite { path } = descriptor.backend else {
        panic!("test store is SQLite");
    };
    rusqlite::Connection::open(PathBuf::from(path).parent().unwrap().join("context.db")).unwrap()
}

/// The route identity basal's flow routes carry: carrier `reserved:basal` and an
/// owner-authorized `reserved:prefrontal-core` scope naming the flow and its author.
fn flow_stamp(agent_id: Option<&str>, flow_id: Option<&str>) -> subc_protocol::scope::ScopeStamp {
    subc_protocol::scope::ScopeStamp::new(
        subc_protocol::Principal::Reserved {
            module_id: "prefrontal-core".into(),
        },
        "flow-run",
        1,
        subc_protocol::scope::ScopeKind::Ephemeral,
    )
    .with_attributes(
        subc_protocol::scope::ScopeAttributes::new()
            .with_agent_id(agent_id.map(str::to_string))
            .with_flow_id(flow_id.map(str::to_string)),
    )
    .with_owner_authorized(true)
}

/// Rebinds channel 7 with `principal` and `scope`, keeping its project and session.
fn rebind(
    handler: &McHandler,
    principal: Option<subc_protocol::Principal>,
    scope: Option<subc_protocol::scope::ScopeStamp>,
) {
    let mut binding = handler.bindings.lock().unwrap().get(&7).unwrap().clone();
    binding.principal = principal;
    binding.scope = scope;
    handler.bind_route(7, binding);
}

fn basal() -> Option<subc_protocol::Principal> {
    Some(subc_protocol::Principal::Reserved {
        module_id: "basal".into(),
    })
}

/// Channel 7 bound as a flow MC authored, which passes the op's caller check.
fn bind_mc_flow(handler: &McHandler) {
    rebind(
        handler,
        basal(),
        Some(flow_stamp(
            Some(subagent_invocations_read::MC_AGENT_ID),
            Some("mc-subagent-failure-sentinel"),
        )),
    );
}

const WINDOW_READ: &str =
    r#"{"method": "subagent_invocations.read", "params": {"query": "window", "after": 0, "until": 1000}}"#;

async fn read_refusal(handler: &McHandler) -> (String, String) {
    error_frame(
        handler
            .dispatch_value(7, serde_json::from_str(WINDOW_READ).unwrap())
            .await,
    )
}

#[tokio::test]
async fn subagent_invocations_read_answers_in_the_management_envelope() {
    let (handler, _store, dir, _) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    bind_mc_flow(&handler);
    let conn = subagent_context_db(&dir);
    conn.execute(
        "INSERT INTO subagent_invocations (session_id, harness, subagent, task, started_at, ended_at, status, error) \
         VALUES ('ses', 'opencode', 'historian', NULL, 90, 100, 'failed', 'quota exhausted')",
        [],
    )
    .unwrap();
    let reply = call_dispatch_request(
        &handler,
        json!({"method": "subagent_invocations.read", "params": {"query": "window", "after": 0, "until": 1_000}}),
    )
    .await;
    assert_eq!(
        reply,
        json!({"result": {"rows": [{
            "id": 1, "session_id": "ses", "subagent": "historian", "task": null,
            "started_at": 90, "ended_at": 100, "status": "failed", "error": "quota exhausted",
            "parent_invocation_id": null
        }], "more": false}})
    );
    let after_cursor = call_dispatch_request(
        &handler,
        json!({"method": "subagent_invocations.read", "params": {
            "query": "after_cursor", "cursor": {"ended_at": 100, "id": 1}, "settled_before": 1_000
        }}),
    )
    .await;
    assert_eq!(after_cursor, json!({"result": {"rows": [], "more": false}}));
}

#[tokio::test]
async fn subagent_invocations_read_refuses_an_unknown_argument_by_name() {
    let (handler, _store, _dir, _) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    bind_mc_flow(&handler);
    let (code, message) = error_frame(
        handler
            .dispatch_value(
                7,
                json!({"method": "subagent_invocations.read", "params": {
                    "query": "window", "after": 0, "until": 1, "session_id": "ses"
                }}),
            )
            .await,
    );
    assert_eq!(code, "invalid_params");
    assert!(message.contains("unknown argument `session_id`"), "{message}");
}

#[test]
fn manifest_declares_subagent_invocations_read_as_a_management_query() {
    let manifest = crate::manifest(DEFAULT_MODULE_ID);
    let operations: Vec<_> = manifest
        .provides
        .iter()
        .filter_map(|role| match role {
            ProviderRole::ManagementSurface { operations, .. } => Some(operations),
            _ => None,
        })
        .flatten()
        .collect();
    assert_eq!(operations.len(), 5, "{operations:?}");
    assert_eq!(operations[0].name, "subagent_invocations.read");
    assert_eq!(operations[4].name, "context.watch");
    assert_eq!(operations[4].kind, subc_protocol::manifest::ManagementOperationKind::Query);
    assert_eq!(
        operations[0].kind,
        subc_protocol::manifest::ManagementOperationKind::Query
    );
    // Other tests in this crate read the tool provider as `provides[0]`, so it stays first.
    assert!(matches!(manifest.provides[0], ProviderRole::ToolProvider { .. }));
}

#[tokio::test]
async fn subagent_invocations_read_refuses_a_flow_authored_by_another_agent() {
    let (handler, _store, _dir, _) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    rebind(
        &handler,
        basal(),
        Some(flow_stamp(Some("agent_0000000000000000"), Some("someone-elses-flow"))),
    );
    let (code, message) = read_refusal(&handler).await;
    assert_eq!(code, "caller_forbidden");
    assert!(message.contains("`agent_id`"), "{message}");
    // A flow with no author is not MC's either.
    rebind(&handler, basal(), Some(flow_stamp(None, Some("anonymous-flow"))));
    let (code, message) = read_refusal(&handler).await;
    assert_eq!(code, "caller_forbidden");
    assert!(message.contains("`agent_id`"), "{message}");
}

#[tokio::test]
async fn subagent_invocations_read_refuses_a_scope_without_flow_id() {
    let (handler, _store, _dir, _) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    rebind(
        &handler,
        basal(),
        Some(flow_stamp(Some(subagent_invocations_read::MC_AGENT_ID), None)),
    );
    let (code, message) = read_refusal(&handler).await;
    assert_eq!(code, "caller_forbidden");
    assert!(message.contains("`flow_id`"), "{message}");
}

#[tokio::test]
async fn subagent_invocations_read_refuses_non_flow_callers() {
    let (handler, _store, _dir, _) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    // The fixture's own route: the in-process plugin, with no principal and no scope.
    let (code, message) = read_refusal(&handler).await;
    assert_eq!(code, "caller_forbidden");
    assert!(message.contains("reserved:basal"), "{message}");
    // A harness head route: an authorized prefrontal-core scope, but a classic call.
    rebind(
        &handler,
        Some(subc_protocol::Principal::Reserved {
            module_id: "thalamus-harness".into(),
        }),
        Some(flow_stamp(Some(subagent_invocations_read::MC_AGENT_ID), None)),
    );
    let (code, message) = read_refusal(&handler).await;
    assert_eq!(code, "caller_forbidden");
    assert!(message.contains("reserved:basal"), "{message}");
    // basal carrying an agent run is a codemode call, even with a flow id beside it.
    let run = flow_stamp(
        Some(subagent_invocations_read::MC_AGENT_ID),
        Some("mc-subagent-failure-sentinel"),
    );
    let run = run.clone().with_attributes(run.attributes.clone().with_run_id(Some("run-1".into())));
    rebind(&handler, basal(), Some(run));
    let (code, message) = read_refusal(&handler).await;
    assert_eq!(code, "caller_forbidden");
    assert!(message.contains("call mode `flow`"), "{message}");
    // basal with no scope at all.
    rebind(&handler, basal(), None);
    let (code, message) = read_refusal(&handler).await;
    assert_eq!(code, "caller_forbidden");
    assert!(message.contains("scope stamp"), "{message}");
}

#[tokio::test]
async fn subagent_invocations_read_refuses_a_scope_not_owner_authorized() {
    let (handler, _store, _dir, _) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    let stamp = flow_stamp(
        Some(subagent_invocations_read::MC_AGENT_ID),
        Some("mc-subagent-failure-sentinel"),
    )
    .with_owner_authorized(false);
    rebind(&handler, basal(), Some(stamp));
    let (code, message) = read_refusal(&handler).await;
    assert_eq!(code, "caller_forbidden");
    assert!(message.contains("owner_authorized"), "{message}");
    // Another scope owner is refused by name too.
    let mut stamp = flow_stamp(
        Some(subagent_invocations_read::MC_AGENT_ID),
        Some("mc-subagent-failure-sentinel"),
    );
    stamp.owner = subc_protocol::Principal::Reserved {
        module_id: "thalamus-harness".into(),
    };
    rebind(&handler, basal(), Some(stamp));
    let (code, message) = read_refusal(&handler).await;
    assert_eq!(code, "caller_forbidden");
    assert!(message.contains("reserved:prefrontal-core"), "{message}");
}

#[tokio::test]
async fn a_flow_scoped_route_reaches_only_the_flow_ops() {
    let (handler, _store, _dir, _) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    bind_mc_flow(&handler);
    for (what, request) in [
        (
            "a memory write",
            json!({"name": "ctx_memory", "arguments": {"action": "write", "category": "WORKFLOW_RULES", "content": "flows write here"}}),
        ),
        ("ctx_reduce", json!({"name": "ctx_reduce", "arguments": {"drop": "1"}})),
        (
            "a user command",
            json!({"name": "user_command.invoke", "call_key": "k", "arguments": {"command": "ctx-status", "input": ""}}),
        ),
        (
            "a state write",
            json!({"method": "state_sync", "session_id": "ses", "messages": []}),
        ),
        ("an unknown method", json!({"method": "no.such.method"})),
        ("an echo", json!({"method": "echo"})),
    ] {
        let (code, message) = error_frame(handler.dispatch_value(7, request).await);
        assert_eq!(code, "flow_route_not_admitted", "{what}: {message}");
    }
    // The read op is admitted and answers.
    let reply = call_dispatch_request(&handler, serde_json::from_str(WINDOW_READ).unwrap()).await;
    assert_eq!(reply, json!({"result": {"rows": [], "more": false}}));
    // Any flow scope is fenced, MC's or not: the dispatcher refuses this foreign flow's `echo` too.
    rebind(&handler, basal(), Some(flow_stamp(Some("agent_0000000000000000"), Some("other"))));
    let (code, _) = error_frame(handler.dispatch_value(7, json!({"method": "echo"})).await);
    assert_eq!(code, "flow_route_not_admitted");
}

#[test]
fn manifest_declares_flow_scopes_v1() {
    let manifest = crate::manifest(DEFAULT_MODULE_ID);
    let provides = &manifest.capabilities.as_ref().unwrap().provides;
    assert!(
        provides.iter().any(|capability| capability == "flow-scopes/v1"),
        "{provides:?}"
    );
}
