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
