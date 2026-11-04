use super::*;
use subc_client_rs::RouteHandle;

#[tokio::test]
async fn lifecycle_route_identity_requires_attestation_and_uses_the_attested_runner() {
    let client = SubcRunnerClient::new(
        PathBuf::from("unused-connection-file"),
        Arc::new(ChildScopes::new("ck-mc-test")),
    );
    let handler = Handler::new(Module::new(
        client,
        crate::pass::Settings::default(),
        None,
        None,
    ));
    let mut request = RouteBindRequest::new(
        RouteHandle::detached(7, 1),
        RouteTarget::ToolProvider {
            module_id: "ck-mc-test".into(),
        },
        BindIdentity::new("mock", "host-session"),
    );
    request.role_versions = Some(std::collections::BTreeMap::from([(
        COMPACTION_ROLE.0.into(),
        COMPACTION_ROLE.1.into(),
    )]));
    let rejected = handler.on_bind(&request).await;
    assert!(format!("{rejected:?}").contains("unattested_runner"));
    assert!(handler.bound.lock().unwrap().is_empty());
    request.principal = Some(Principal::Reserved {
        module_id: "attested-runner".into(),
    });
    handler.on_bind(&request).await;
    let bound = handler.bound.lock().unwrap();
    let route = &bound
        .get(&7)
        .expect("attested session route was accepted")
        .route;
    assert_eq!(
        route.session,
        SessionRef::new("attested-runner", "mock", "host-session")
    );
}

/// Core lists the tools of a head that registered no session through a tool
/// route bound to no session: that route answers the catalog, refuses tool
/// calls, and a compaction route still needs a session.
#[tokio::test]
async fn an_unbound_tool_route_answers_the_catalog_and_refuses_tool_calls() {
    let client = SubcRunnerClient::new(
        PathBuf::from("unused-connection-file"),
        Arc::new(ChildScopes::new("ck-mc-test")),
    );
    let handler = Handler::new(Module::new(
        client,
        crate::pass::Settings::default(),
        None,
        None,
    ));
    let mut request = RouteBindRequest::new(
        RouteHandle::detached(8, 1),
        RouteTarget::ToolProvider {
            module_id: "ck-mc-test".into(),
        },
        BindIdentity::new(MODULE_LEVEL_HARNESS, "catalog"),
    );
    request.principal = Some(Principal::Reserved {
        module_id: "prefrontal-core".into(),
    });
    request.role_versions = Some(std::collections::BTreeMap::from([(
        TOOL_ROLE.0.into(),
        TOOL_ROLE.1.into(),
    )]));
    let accepted = handler.on_bind(&request).await;
    assert!(
        !format!("{accepted:?}").contains("route_unbound"),
        "{accepted:?}"
    );
    let route = handler
        .bound
        .lock()
        .unwrap()
        .get(&8)
        .expect("bound")
        .route
        .clone();
    let body = |name: &str| {
        serde_json::to_vec(&ToolCallRequest::new(name, serde_json::json!({}))).unwrap()
    };
    let catalog = handler
        .tool(
            &route,
            &body(cortexkit_role_tool_provider::ops::TOOL_CATALOG),
        )
        .await;
    assert!(catalog.is_ok(), "{:?}", catalog.err());
    let call = handler.tool(&route, &body("ctx_reduce")).await;
    assert_eq!(call.err().unwrap().code, codes::ROUTE_UNBOUND);

    request.handle = RouteHandle::detached(9, 1);
    request.role_versions = Some(std::collections::BTreeMap::from([(
        COMPACTION_ROLE.0.into(),
        COMPACTION_ROLE.1.into(),
    )]));
    let refused = handler.on_bind(&request).await;
    assert!(
        format!("{refused:?}").contains("route_unbound"),
        "{refused:?}"
    );
}

/// Core reads the step-transform declaration for a session it is composing
/// over ck-mc's own management surface, before the session exists. That
/// route answers `role.describe` and `transform.declare` and nothing else;
/// a phone's management route still reaches the app reads.
#[tokio::test]
async fn cores_management_route_reads_the_step_transform_declaration() {
    let client = SubcRunnerClient::new(
        PathBuf::from("unused-connection-file"),
        Arc::new(ChildScopes::new("ck-mc-test")),
    );
    let handler = Handler::new(Module::new(
        client,
        crate::pass::Settings::default(),
        None,
        None,
    ));
    let mut request = RouteBindRequest::new(
        RouteHandle::detached(10, 1),
        RouteTarget::ManagementSurface {
            module_id: crate::MODULE_ID.into(),
        },
        BindIdentity::new("opencode2", "ses_head"),
    );
    request.principal = Some(Principal::Reserved {
        module_id: "prefrontal-core".into(),
    });
    let accepted = handler.on_bind(&request).await;
    assert!(
        !format!("{accepted:?}").contains("not_permitted"),
        "{accepted:?}"
    );
    let route = handler
        .bound
        .lock()
        .unwrap()
        .get(&10)
        .expect("bound")
        .route
        .clone();
    let call = |method: &str, params: serde_json::Value| {
        serde_json::to_vec(&serde_json::json!({"method": method, "params": params})).unwrap()
    };

    let describe = handler
        .hook(
            &route,
            &call(step::ops::ROLE_DESCRIBE, serde_json::json!({})),
        )
        .await
        .expect("role.describe");
    let describe: step::describe::RoleDescribe = serde_json::from_value(describe).unwrap();
    let step_major = describe
        .majors
        .iter()
        .find(|major| major.version == step::PROVIDES)
        .expect("the step-transform major");
    for op in step::REQUIRED_OPS {
        assert!(step_major.ops.iter().any(|served| served == op), "{op}");
    }
    let declared = handler
        .hook(
            &route,
            // No preset named: the declaration defaults to the head preset,
            // the one core asks for when it composes a head.
            &call(step::ops::TRANSFORM_DECLARE, serde_json::json!({})),
        )
        .await
        .expect("transform.declare");
    assert!(declared.to_string().contains("pre_user"), "{declared}");
    let hook = handler
        .hook(
            &route,
            &call(step::ops::TRANSFORM_HOOK, serde_json::json!({})),
        )
        .await;
    assert!(
        hook.is_err(),
        "a hook on core's discovery route must refuse"
    );

    // The tool-provider capability core's compaction gate reads is in the
    // same answer.
    let describe = handler
        .hook(
            &route,
            &call(step::ops::ROLE_DESCRIBE, serde_json::json!({})),
        )
        .await
        .expect("role.describe");
    assert!(
        describe["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|capability| capability == "compacting-preflight/v1"),
        "{describe}"
    );

    // Core binds the route under the head's scope, and may name the role.
    request.handle = RouteHandle::detached(12, 1);
    request.scope = Some(subc_protocol::scope::ScopeStamp::new(
        Principal::Reserved {
            module_id: "prefrontal-core".into(),
        },
        "head-scope",
        1,
        subc_protocol::scope::ScopeKind::Head,
    ));
    request.role_versions = Some(std::collections::BTreeMap::from([(
        step::ROLE.into(),
        step::VERSION.into(),
    )]));
    let scoped = handler.on_bind(&request).await;
    assert!(
        !format!("{scoped:?}").contains("not_permitted"),
        "{scoped:?}"
    );
    request.scope = None;
    request.role_versions = None;

    // A caller the daemon doesn't attest gets nothing on the surface.
    request.handle = RouteHandle::detached(11, 1);
    request.principal = Some(Principal::Unverified);
    let refused = handler.on_bind(&request).await;
    assert!(
        format!("{refused:?}").contains("not_permitted"),
        "{refused:?}"
    );
}
