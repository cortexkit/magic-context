use super::*;
use subc_client_rs::{ModuleHandler, RouteBindRequest, RouteHandle};
use subc_protocol::{BindIdentity, Principal};

async fn rebind(rig: &Rig, scope: Option<subc_protocol::scope::ScopeStamp>) {
    rebind_session(rig, scope, "s").await;
}

async fn rebind_session(rig: &Rig, scope: Option<subc_protocol::scope::ScopeStamp>, session: &str) {
    let mut req = RouteBindRequest::new(
        RouteHandle::detached(7, 1),
        crate::route_targets::catalog_provider_target_for_test(),
        BindIdentity::new("runner", session),
    )
    .with_principal(Principal::Reserved {
        module_id: rig.module.clone(),
    });
    req.scope = scope;
    let decision = rig.h.on_bind(&req).await;
    assert!(format!("{decision:?}").contains("Accept"), "{decision:?}");
}

#[tokio::test]
async fn repeated_setup_on_a_new_scoped_route_keeps_the_existing_records_project() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let old = rig.state();
    let foreign = dir.path().join("different-project");
    std::fs::create_dir(&foreign).unwrap();
    let scope = subc_protocol::scope::ScopeStamp::new(
        Principal::Reserved {
            module_id: "prefrontal-core".into(),
        },
        "head",
        1,
        subc_protocol::scope::ScopeKind::Head,
    )
    .with_workdir(Some(foreign.to_string_lossy().into_owned()))
    .with_project_id(Some("pj-different".into()));
    rebind_session(&rig, Some(scope), "").await;
    let request = serde_json::to_value(&old.setup).unwrap();
    assert_eq!(rig.op("compaction.setup", request).await["answer"], "ready");
    let new = rig.state();
    assert_eq!(new.runner_identity(), old.runner_identity());
    assert_eq!(new.dream_target, old.dream_target);
    assert_eq!(new.namespace(), old.namespace());
}

fn setup() -> Value {
    json!({"session":"s","harness":"opencode","request_id":"setup","model":"fixture","context_window":100_000,"composition":{"render_tags":true},"params":{"serializer_profile":"opencode-aisdk"},"lineage_id":"L","now":1})
}

#[tokio::test]
async fn real_unscoped_route_cannot_set_up_a_project_free_session() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::without_setup(
        dir.path(),
        "broca",
        ("runner", "s"),
        ("opencode", "s"),
        |_| {},
    )
    .await;
    rebind(&rig, None).await;
    let outcome = rig
        .h
        .dispatch_value(7, json!({"method":"compaction.setup","params":setup()}))
        .await;
    assert!(
        matches!(outcome, HandlerOutcome::Error { code, .. } if code == "setup_route_unscoped")
    );
    assert!(load(rig.h.store.get().unwrap(), &rig.reference)
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn scoped_setup_records_workdir_and_project_id_for_later_unscoped_ops() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::without_setup(
        dir.path(),
        "broca",
        ("runner", "s"),
        ("opencode", "s"),
        |_| {},
    )
    .await;
    let scope = subc_protocol::scope::ScopeStamp::new(
        Principal::Reserved {
            module_id: "prefrontal-core".into(),
        },
        "head",
        1,
        subc_protocol::scope::ScopeKind::Head,
    )
    .with_workdir(Some(dir.path().to_string_lossy().into_owned()))
    .with_project_id(Some("pj-setup".into()));
    rebind(&rig, Some(scope)).await;
    assert_eq!(rig.op("compaction.setup", setup()).await["answer"], "ready");
    assert_eq!(rig.state().project(), dir.path());
    assert_eq!(
        rig.state().dream_target.as_ref().unwrap()["project"],
        "pj-setup"
    );
    rebind(&rig, None).await;
    let binding = rig.h.facade_binding(7).unwrap();
    assert_eq!(binding.project_root, dir.path());
    assert_eq!(
        rig.h
            .route_project(7, rig.h.store.get().unwrap(), &binding)
            .unwrap()
            .key,
        "pj-setup"
    );
    assert_eq!(
        rig.h.pre_user_context(&binding).unwrap().0,
        rig.state().namespace()
    );
}

#[tokio::test]
async fn old_session_keeps_its_setup_project_on_unscoped_notice_read_ride_view_and_tools() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let original = rig.state();
    let project = original.dream_target.as_ref().unwrap()["project"]
        .as_str()
        .unwrap()
        .to_owned();
    *rig.runner.expected_bind_identity.lock().unwrap() = Some(original.runner_identity());
    rebind(&rig, None).await;
    rig.fill(10);
    rig.notice(1, 1000, None).await;
    assert!(
        rig.runner
            .routed_reads
            .load(std::sync::atomic::Ordering::Relaxed)
            > 0
    );
    let tool = rig.tool(7, "ctx_reduce", json!({"drop":"100"})).await;
    assert_ne!(tool["isError"], true, "{tool}");
    rig.history(4, "completed history from this session");
    rig.notice(2, 1000, None).await;
    let version = rig.newest().unwrap();
    assert_eq!(rig.get(version).await.session_ref, rig.reference);
    let ride = rig
        .op(
            "compaction.ride",
            json!({"session_ref":rig.reference,"cause":"ceiling","deadline_ms":10_000}),
        )
        .await;
    assert!(
        matches!(ride["answer"].as_str(), Some("view" | "nothing")),
        "{ride}"
    );
    let binding = rig.h.facade_binding(7).unwrap();
    assert_eq!(binding.project_root, dir.path());
    assert_eq!(
        rig.h
            .route_project(7, rig.h.store.get().unwrap(), &binding)
            .unwrap()
            .key,
        project
    );
    assert_eq!(rig.state().runner_identity(), original.runner_identity());
}
