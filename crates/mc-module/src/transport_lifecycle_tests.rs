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
