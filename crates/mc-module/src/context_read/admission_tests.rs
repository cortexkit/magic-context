use crate::transport::*;
use std::path::PathBuf;
use std::sync::Arc;
use subc_client_rs::{ModuleHandler, RouteBindRequest, RouteHandle};
use subc_protocol::{BindIdentity, Principal, RouteTarget};

fn request() -> RouteBindRequest {
    let mut request = RouteBindRequest::new(
        RouteHandle::detached(42, 1),
        RouteTarget::InternalService {
            module_id: crate::MODULE_ID.into(),
            service_id: super::ROLE.0.into(),
        },
        BindIdentity::new("", "colliculus"),
    );
    request.role_versions = Some(std::collections::BTreeMap::from([(
        super::ROLE.0.into(),
        super::ROLE.1.into(),
    )]));
    request
}

#[tokio::test]
async fn context_read_admits_only_attested_colliculus_without_reading() {
    let module = crate::module::Module::new(
        SubcRunnerClient::new(
            PathBuf::from("unused"),
            Arc::new(crate::child_scopes::ChildScopes::new("test")),
        ),
        crate::pass::Settings::default(),
        None,
        None,
    );
    let reader = module.context_read().clone();
    let handler = Handler::new(module);
    let mut request = request();
    request.principal = Some(Principal::Reserved {
        module_id: "colliculus".into(),
    });
    assert_eq!(
        format!("{:?}", handler.on_bind(&request).await),
        format!("{:?}", subc_client_rs::BindDecision::accept())
    );
    for principal in [
        None,
        Some(Principal::Direct),
        Some(Principal::Unverified),
        Some(Principal::Reserved {
            module_id: "callosum".into(),
        }),
        Some(Principal::Reserved {
            module_id: "thalamus".into(),
        }),
    ] {
        request.principal = principal;
        let result = handler.on_bind(&request).await;
        assert!(
            format!("{result:?}").contains("not_permitted"),
            "{result:?}"
        );
    }
    assert_eq!(reader.read_count(), 0);
}

#[test]
fn context_read_manifest_declares_three_read_ops() {
    let manifest = serde_json::to_value(manifest(crate::MODULE_ID)).unwrap();
    let service = manifest["provides"]
        .as_array()
        .unwrap()
        .iter()
        .find(|role| role["service_id"] == super::ROLE.0)
        .expect("context service");
    assert_eq!(
        service["operations"],
        serde_json::json!(["context.memories", "context.summaries", "context.recent"])
    );
    assert_eq!(service["agent_facing"], false);
    assert!(manifest["capabilities"]["provides"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("mc-context-read/v1")));
}

#[tokio::test]
async fn context_read_refuses_other_targets_versions_and_scopes() {
    let handler = Handler::new(crate::module::Module::new(
        SubcRunnerClient::new(
            PathBuf::from("unused"),
            Arc::new(crate::child_scopes::ChildScopes::new("test")),
        ),
        crate::pass::Settings::default(),
        None,
        None,
    ));
    let mut base = request();
    base.principal = Some(Principal::Reserved {
        module_id: "colliculus".into(),
    });
    for target in [
        RouteTarget::InternalService {
            module_id: "other".into(),
            service_id: super::ROLE.0.into(),
        },
        RouteTarget::ManagementSurface {
            module_id: crate::MODULE_ID.into(),
        },
    ] {
        let mut request = base.clone();
        request.target = target;
        assert!(format!("{:?}", handler.on_bind(&request).await).contains("not_permitted"));
    }
    let mut wrong = base.clone();
    wrong
        .role_versions
        .as_mut()
        .unwrap()
        .insert(super::ROLE.0.into(), "v2".into());
    assert!(format!("{:?}", handler.on_bind(&wrong).await).contains("not_permitted"));
    let mut scoped = base;
    scoped.scope = Some(subc_protocol::scope::ScopeStamp::new(
        Principal::Reserved {
            module_id: "colliculus".into(),
        },
        "scope",
        1,
        subc_protocol::scope::ScopeKind::Head,
    ));
    assert!(format!("{:?}", handler.on_bind(&scoped).await).contains("not_permitted"));
}

/// `context.recent` takes the same gate as the other context reads: a
/// session a move holds is refused before any worker starts or restores it.
#[tokio::test]
async fn context_recent_is_refused_for_a_held_session_before_any_worker_starts() {
    use crate::agent_data::journal::{Cut, Moving, MovingState};
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
    let key = cortexkit_role_compaction::read::SessionRef::new("runner", "opencode2", "held");
    store.save(&key, &crate::store::Durable::default()).unwrap();
    let journal = crate::agent_data::Journal::in_memory();
    journal
        .change(|contents| {
            contents.cuts.entry("cut-c".into()).or_insert(Cut {
                step: cortexkit_role_agent_data::step::Step::Prepared,
                ..Cut::default()
            });
            contents
                .session_mut(&key.runner, &key.harness, &key.session)
                .moving = Some(Moving {
                cut: "cut-c".into(),
                state: MovingState::Frozen,
            });
        })
        .unwrap();
    let module = crate::module::Module::with_journal(
        SubcRunnerClient::new(
            PathBuf::from("unused"),
            Arc::new(crate::child_scopes::ChildScopes::new("test")),
        ),
        crate::pass::Settings::default(),
        None,
        Some(store),
        Arc::new(journal),
        false,
    );
    let body = serde_json::to_vec(&serde_json::json!({"method": "context.recent", "params": {
        "session": {"harness": "opencode2", "session": "held"}, "budget_tokens": 1000}}))
    .unwrap();
    let refused = module.context_read().read(&body).await.unwrap_err();
    assert_eq!(refused.code, crate::agent_data::SESSION_MOVING);
    assert!(!crate::agent_data::Host::active(&module, &key));
}

/// A caller other than Colliculus never gets a context route, so it can't
/// make `context.recent` start or restore a session's worker.
#[tokio::test]
async fn context_recent_starts_no_worker_for_a_caller_other_than_colliculus() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
    let key = cortexkit_role_compaction::read::SessionRef::new("runner", "opencode2", "saved");
    store.save(&key, &crate::store::Durable::default()).unwrap();
    let module = crate::module::Module::new(
        SubcRunnerClient::new(
            PathBuf::from("unused"),
            Arc::new(crate::child_scopes::ChildScopes::new("test")),
        ),
        crate::pass::Settings::default(),
        None,
        Some(store),
    );
    let reader = module.context_read().clone();
    let handler = Handler::new(module.clone());
    let mut request = request();
    for module_id in ["callosum", "thalamus", "occipital", "entorhinal"] {
        request.principal = Some(Principal::Reserved {
            module_id: module_id.into(),
        });
        let result = handler.on_bind(&request).await;
        assert!(
            format!("{result:?}").contains("not_permitted"),
            "{result:?}"
        );
    }
    assert_eq!(reader.read_count(), 0);
    assert!(!crate::agent_data::Host::active(&module, &key));
}
