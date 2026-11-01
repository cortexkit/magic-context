use super::*;
use crate::route_binding::ScopedProject;
use subc_client_rs::{RouteBindRequest, RouteHandle};
use subc_protocol::{
    scope::{ScopeKind, ScopeStamp},
    BindIdentity, Principal,
};

fn stamp(root: &Path, project_id: Option<&str>) -> ScopeStamp {
    ScopeStamp::new(
        Principal::Reserved {
            module_id: "prefrontal-core".into(),
        },
        "head",
        1,
        ScopeKind::Head,
    )
    .with_workdir(Some(root.to_string_lossy().into_owned()))
    .with_project_id(project_id.map(str::to_owned))
    .with_owner_authorized(true)
}

fn route(root: Option<&Path>, session: &str) -> RouteBindRequest {
    let mut request = RouteBindRequest::new(
        RouteHandle::detached(7, 1),
        crate::route_targets::catalog_provider_target_for_test(),
        BindIdentity::new("opencode", session),
    )
    .with_principal(Principal::Reserved {
        module_id: "broca".into(),
    });
    request.scope = root.map(|root| stamp(root, None));
    request
}

async fn bind(handler: &McHandler, req: &RouteBindRequest) {
    let decision = handler.on_bind(req).await;
    assert!(format!("{decision:?}").contains("Accept"), "{decision:?}");
}

#[test]
fn project_resolution_uses_only_scope_workdir_and_optional_project_id() {
    let root = Path::new("/fixture/exact/../spelling/");
    for id in [None, Some("pj-fixture")] {
        let project = ScopedProject::from_stamp(Some(&stamp(root, id))).unwrap();
        assert_eq!(project.workdir.as_os_str(), root.as_os_str());
        assert_eq!(project.project_id.as_deref(), id);
    }
    assert_eq!(ScopedProject::from_stamp(None), None);
    let missing = ScopeStamp::new(Principal::Direct, "head", 1, ScopeKind::Head);
    assert_eq!(ScopedProject::from_stamp(Some(&missing)), None);
}

#[test]
fn project_free_sdk_omits_outgoing_project_fields() {
    let identity = BindIdentity::new("opencode", "s");
    assert_eq!(
        serde_json::to_vec(&identity).unwrap(),
        br#"{"harness":"opencode","session":"s"}"#
    );
}

#[test]
fn declared_project_free_bind_identity_decodes() {
    let raw = br#"{"op":"route.bind","route_channel":7,"epoch":1,"target":{"kind":"tool_provider","module_id":"magic-context"},"identity":{"harness":"opencode","session":"s"}}"#;
    let decoded = serde_json::from_slice::<subc_protocol::session::ModuleControlRequest>(raw);
    assert!(decoded.is_ok(), "{decoded:?}");
    assert_eq!(
        crate::project_bind_capabilities(),
        vec!["bind-no-project/v1", "scope-workdir/v1"]
    );
}

#[tokio::test]
async fn sdk_bind_schema_preserves_scope_project_before_target_binding() {
    let raw = br#"{"op":"route.bind","route_channel":7,"epoch":1,"target":{"kind":"tool_provider","module_id":"magic-context"},"identity":{"project_root":"/caller-store-not-the-project","harness":"opencode","session":"s"},"scope":{"owner":{"kind":"reserved","module_id":"prefrontal-core"},"ref":"head","scope_epoch":1,"kind":"head","owner_authorized":true,"workdir":"/scope/exact/../spelling/","project_id":"pj-wire"}}"#;
    let decoded: subc_protocol::session::ModuleControlRequest =
        serde_json::from_slice(raw).unwrap();
    let subc_protocol::session::ModuleControlRequest::RouteBind {
        route_channel,
        epoch,
        target,
        identity,
        scope,
        ..
    } = decoded
    else {
        panic!("route.bind")
    };
    let scope = scope.unwrap();
    assert_eq!(scope.workdir.as_deref(), Some("/scope/exact/../spelling/"));
    assert_eq!(scope.project_id.as_deref(), Some("pj-wire"));
    let req = RouteBindRequest::new(
        RouteHandle::detached(route_channel, epoch),
        target,
        identity,
    )
    .with_scope(scope);
    let (handler, store, _dir, _) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    bind(&handler, &req).await;
    let binding = handler.facade_binding(7).unwrap();
    assert_eq!(
        binding.project_root.as_os_str(),
        Path::new("/scope/exact/../spelling/").as_os_str()
    );
    assert_eq!(
        handler.route_project(7, &store, &binding).unwrap().key,
        "pj-wire"
    );
}

#[tokio::test]
async fn projectless_flow_routes_keep_their_authorization_fence() {
    let (handler, _, _dir, _) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    let scope = ScopeStamp::new(
        Principal::Reserved {
            module_id: "prefrontal-core".into(),
        },
        "flow",
        1,
        ScopeKind::Ephemeral,
    )
    .with_owner_authorized(true)
    .with_attributes(
        subc_protocol::scope::ScopeAttributes::new()
            .with_agent_id(Some(subagent_invocations_read::MC_AGENT_ID.into()))
            .with_flow_id(Some("sentinel".into())),
    );
    let req = route(None, "s")
        .with_principal(Principal::Reserved {
            module_id: "basal".into(),
        })
        .with_scope(scope);
    bind(&handler, &req).await;
    assert_eq!(
        error_code(handler.dispatch_value(7, json!({"method":"echo"})).await),
        "flow_route_not_admitted"
    );
    assert_eq!(
        error_code(
            handler
                .dispatch_value(7, json!({"method":"subagent_invocations.read","params":{}}))
                .await
        ),
        "invalid_params"
    );
}

#[tokio::test]
async fn old_identity_and_scope_stamp_keep_project_and_persistent_keys_identical() {
    let (handler, store, _dir, root) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    handler
        .resolve_project_identity_for_test
        .store(true, Ordering::Relaxed);
    // The expected keys come from the old caller folder. Incoming BindIdentity
    // still carries a folder for compatibility, but the target must ignore it.
    #[derive(serde::Deserialize)]
    struct OldIdentity {
        project_root: PathBuf,
        harness: String,
        session: String,
    }
    let old: OldIdentity =
        serde_json::from_value(json!({"project_root":root,"harness":"opencode","session":"s"}))
            .unwrap();
    let mut old_binding = binding_with_harness(
        old.project_root.to_str().unwrap(),
        &old.harness,
        &old.session,
    );
    old_binding.principal = Some(Principal::Reserved {
        module_id: "broca".into(),
    });
    let old_project = handler.route_project(8, &store, &old_binding).unwrap().key;
    let old_key = providers::Key::new(&old_binding, "s", "opencode").unwrap();
    bind(&handler, &route(Some(&root), "s")).await;
    let new_binding = handler.facade_binding(7).unwrap();
    let new_key = providers::Key::new(&new_binding, "s", "opencode").unwrap();
    assert_eq!(
        new_binding.project_root.as_os_str(),
        old_binding.project_root.as_os_str()
    );
    assert_eq!(
        handler.route_project(7, &store, &new_binding).unwrap().key,
        old_project
    );
    assert_eq!(new_key.reference(), old_key.reference());
    assert_eq!(new_key.async_namespace(0), old_key.async_namespace(0));
    let catalog = providers::Catalog {
        compacting: true,
        tools: ["ctx_expand".into()].into(),
    };
    handler
        .provider_store
        .save_catalog(&old_binding, &catalog)
        .unwrap();
    assert!(store
        .load_provider_catalog(&new_binding.project_root.to_string_lossy(), "s")
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn scoped_project_id_is_used_without_changing_directory_keys() {
    let (handler, store, _dir, root) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    let req = route(Some(&root), "s").with_scope(stamp(&root, Some("pj-scope")));
    bind(&handler, &req).await;
    let binding = handler.facade_binding(7).unwrap();
    assert_eq!(binding.project_root, root);
    assert_eq!(
        handler.route_project(7, &store, &binding).unwrap().key,
        "pj-scope"
    );
}

#[tokio::test]
async fn unscoped_catalog_preflight_uses_user_config_and_writes_no_catalog() {
    let (handler, store, dir, _) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    bind(&handler, &route(None, "preflight")).await;
    let arguments = json!({"composition":{"providers":[{"provider":"magic-context","tools":[{"name":"ctx_memory"},{"name":"ctx_note"},{"name":"ctx_search"}]}]}});
    let answer = handler
        .handle_tool_catalog_value(7, &json!({"name":"tool.catalog","arguments":arguments}))
        .await;
    let HandlerOutcome::Response(bytes) = answer else {
        panic!("{answer:?}")
    };
    let expected = crate::tool_catalog::catalog_answer_bytes(
        &arguments,
        &crate::tool_catalog::CatalogConfig::from_module_config(&handler.user_config()),
    )
    .unwrap();
    assert_eq!(bytes, expected);
    assert!(handler.bindings.lock().unwrap().is_empty());
    assert!(handler.frozen_tool_catalogs.lock().unwrap().is_empty());
    for root in ["/", "", dir.path().to_str().unwrap()] {
        assert!(store
            .load_provider_catalog(root, "preflight")
            .unwrap()
            .is_none());
    }
}

#[tokio::test]
async fn unscoped_runner_unknown_session_reads_answer_without_a_project() {
    let (handler, _, _dir, _) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    bind(&handler, &route(None, "s")).await;
    let view = tool_body(handler.dispatch_value(7, json!({"method":"view.get","params":{"session_ref":"00000000000000000000000000000000","view_version":1}})).await);
    assert_eq!(view["answer"], "refuse");
    assert_eq!(view["code"], "unknown_session");
    let ride = tool_body(handler.dispatch_value(7, json!({"method":"compaction.ride","params":{"session_ref":"00000000000000000000000000000000","cause":"ceiling","deadline_ms":1000}})).await);
    assert_eq!(ride["answer"], "nothing");
    assert!(handler.bindings.lock().unwrap().is_empty());
}

#[tokio::test]
async fn unscoped_claude_code_instance_token_facade_refuses_before_resolution() {
    let resolver = FakeSessionResolver::with(&[(
        "instance-token",
        FakeResolve::Hit("durable-session".into()),
    )]);
    let (handler, _, _dir, _) = handler_with_store_and_resolver(
        Arc::new(ProducerState::default()),
        default_test_config(),
        resolver.clone(),
    );
    let mut req = route(None, "instance-token");
    req.identity = BindIdentity::new("claude-code", "instance-token");
    req.principal = Some(Principal::Direct);
    bind(&handler, &req).await;
    let outcome = handler
        .dispatch_value(
            7,
            json!({"name":"ctx_note","arguments":{"action":"write","content":"not admitted"}}),
        )
        .await;
    let (code, message) = error_frame(outcome);
    assert_eq!(code, "route_unscoped");
    assert!(message.contains("unscoped Claude Code facade: no project without a scope"));
    assert!(resolver.calls().is_empty());
}

#[tokio::test]
async fn unscoped_project_needing_ops_refuse_by_name_without_making_a_session() {
    let (handler, _, _dir, _) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    bind(&handler, &route(None, "s")).await;
    for method in [
        "guidance.get",
        "manifest.get",
        "dreamer.run_task",
        "dream.ownership",
        "dream.run",
        "todo_state.set",
        "session.flush",
        "session.recomp",
        "session.wrapup",
        "mc.retrieval",
        "mc.ui_capabilities",
        "mc.read_sidebar",
        "mc.read_status",
        "mc.read_embed",
        "mc.read_compartment_count",
        "mc.read_todos",
        "mc.recomp_preview",
        "mc.recomp_start",
        "mc.rescore",
        "mc.wrapup",
        "mc.flush",
        "mc.dream",
        "mc.embed",
        "mc.job_read",
        "mc.job_cancel",
        "mc.ui_events",
        "mc.notice_currentness",
        "mc.memory",
    ] {
        assert_eq!(
            error_code(
                handler
                    .dispatch_value(7, json!({"method":method,"v":1,"session_id":"s"}))
                    .await
            ),
            "route_unscoped",
            "{method}"
        );
    }
    for name in [
        "ctx_reduce",
        "ctx_expand",
        "ctx_search",
        "ctx_note",
        "ctx_memory",
        "memory.set_classification",
        "memory.set_mural_cue",
        "memory.expire",
        "memory.set_verification",
        "memory.set_mapping",
        "memory.history",
        "memory.restore.preview",
        "memory.restore",
        "memory.edit",
        "memory.curate",
        "user_command.invoke",
        "late_results",
        "late_results.ack",
    ] {
        assert_eq!(
            error_code(
                handler
                    .dispatch_value(7, json!({"name":name,"arguments":{}}))
                    .await
            ),
            "route_unscoped",
            "{name}"
        );
    }
    assert_eq!(
        error_code(
            handler
                .dispatch_value(7, json!({"method":"compaction.setup","params":{}}))
                .await
        ),
        "setup_route_unscoped"
    );
    assert!(handler.bindings.lock().unwrap().is_empty());
}

fn seed_project_case(store: &McStore, case: &str) -> Option<&'static str> {
    if case != "none" {
        store.with_context_conn_for_test(|conn| conn.execute(
            "INSERT INTO session_projects(session_id,harness,project_path,updated_at) VALUES('s','opencode','git:shared',1)", []
        )).unwrap();
    }
    if case == "record" {
        let raw = json!({"runner_identity":{"project_root":"/record","harness":"opencode","session":"s"},"dream_target":{"project":"pj-record"}}).to_string();
        store
            .async_compaction_save("record", r#"["broca","opencode","s"]"#, "s", &raw)
            .commit()
            .unwrap();
        Some("pj-record")
    } else if case == "record_without_project_key" {
        let raw = json!({"runner_identity":{"project_root":"/record","harness":"opencode","session":"s"}}).to_string();
        store
            .async_compaction_save("record", r#"["broca","opencode","s"]"#, "s", &raw)
            .commit()
            .unwrap();
        Some("git:shared")
    } else if case == "shared" {
        Some("git:shared")
    } else {
        None
    }
}

async fn legacy_status_case(case: &str) {
    let (handler, store, _dir, _) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    let expected = seed_project_case(&store, case);
    if case == "shared" {
        handler
            .resolve_project_identity_for_test
            .store(true, Ordering::Relaxed);
    }
    bind(&handler, &route(None, "s")).await;
    let request = json!({"v":1,"session_id":"s"});
    let (_, binding, key) = handler
        .management_session_project(7, &request, "session.status")
        .unwrap();
    assert_eq!(
        binding
            .as_ref()
            .map(|binding| binding.project_root.to_str().unwrap()),
        if case.starts_with("record") {
            Some("/record")
        } else {
            expected
        }
    );
    assert_eq!(key.as_deref(), expected);
    if case == "shared" {
        assert_eq!(binding.as_ref().unwrap().config, handler.user_config());
    }
    let answer = tool_body(handler.handle_session_status_value(7, &request));
    assert_eq!(answer["ok"], true);
    if case == "none" {
        assert_eq!(answer["pending_m1_delta"], false);
    }
}

async fn legacy_delete_case(case: &str) {
    let (handler, store, _dir, _) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    let expected = seed_project_case(&store, case);
    let notes = ["pj-record", "git:shared", "/foreign"].map(|project| {
        let note = store
            .insert_note(NoteInput {
                project_path: project,
                route_project_root: None,
                session_id: "s",
                content: "keep the owning project's fence",
                surface_condition: None,
                anchor_block_id: None,
                now_ms: 1,
            })
            .unwrap();
        (project, note.id)
    });
    bind(&handler, &route(None, "s")).await;
    let answer =
        tool_body(handler.handle_session_delete_value(7, &json!({"v":1,"session_id":"s"})));
    assert_eq!(answer["ok"], true);
    for (project, id) in notes {
        assert_eq!(
            store.get_note_by_id(project, "s", id).unwrap().is_some(),
            expected != Some(project),
            "{case}: {project}"
        );
    }
}

#[tokio::test]
async fn stored_project_keeps_its_directory_visible_to_app_config_reads() {
    let (handler, store, _dir, _) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    seed_project_case(&store, "record");
    bind(&handler, &route(None, "s")).await;
    let binding = handler.facade_binding(7).unwrap();
    assert_eq!(
        handler.route_project(7, &store, &binding).unwrap().key,
        "pj-record"
    );
    assert_eq!(
        handler
            .active_project_roots
            .lock()
            .unwrap()
            .get("s")
            .unwrap(),
        Path::new("/record")
    );
}

#[tokio::test]
async fn stored_unresolved_project_keeps_memory_paused() {
    let (handler, store, _dir, _) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    let raw = json!({"runner_identity":{"project_root":"/record","harness":"opencode","session":"s"},"dream_target":{"project":"unresolved:from-old-session"}}).to_string();
    store
        .async_compaction_save("record", r#"["broca","opencode","s"]"#, "s", &raw)
        .commit()
        .unwrap();
    bind(&handler, &route(None, "s")).await;
    let project = handler
        .route_project(7, &store, &handler.facade_binding(7).unwrap())
        .unwrap();
    assert_eq!(project.key, "unresolved:from-old-session");
    assert!(project.memory_paused.is_some());
}

#[tokio::test]
async fn legacy_unscoped_status_uses_ck_mc_record_before_shared_row() {
    legacy_status_case("record").await;
}
#[tokio::test]
async fn legacy_unscoped_status_uses_shared_session_project() {
    legacy_status_case("shared").await;
}
#[tokio::test]
async fn legacy_unscoped_status_without_project_is_session_only() {
    legacy_status_case("none").await;
}
#[tokio::test]
async fn legacy_unscoped_delete_uses_ck_mc_record_before_shared_row() {
    legacy_delete_case("record").await;
}
#[tokio::test]
async fn legacy_unscoped_delete_uses_shared_session_project() {
    legacy_delete_case("shared").await;
}
#[tokio::test]
async fn legacy_unscoped_delete_without_project_keeps_project_notes() {
    legacy_delete_case("none").await;
}

#[tokio::test]
async fn legacy_unscoped_status_keeps_record_directory_when_its_key_is_only_in_shared_store() {
    legacy_status_case("record_without_project_key").await;
}

#[tokio::test]
async fn legacy_unscoped_delete_uses_shared_key_with_an_older_record_directory() {
    legacy_delete_case("record_without_project_key").await;
}
