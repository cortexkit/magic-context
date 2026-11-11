//! The `agent-data` service on the wire: the manifest, the bind, and the
//! dispatch of its requests, with moves on and off.

use super::*;
use subc_client_rs::RouteHandle;

fn handler(agent_data: bool) -> Handler {
    Handler::new(Module::with_journal(
        SubcRunnerClient::new(
            PathBuf::from("unused-connection-file"),
            Arc::new(ChildScopes::new("ck-mc-test")),
        ),
        crate::pass::Settings::default(),
        None,
        None,
        Arc::new(crate::agent_data::Journal::in_memory()),
        agent_data,
    ))
}

fn bind(channel: u16, service: &str, principal: Option<Principal>) -> RouteBindRequest {
    let mut request = RouteBindRequest::new(
        RouteHandle::detached(channel, 1),
        RouteTarget::InternalService {
            module_id: crate::MODULE_ID.into(),
            service_id: service.into(),
        },
        BindIdentity::new("agent-data", "move"),
    );
    request.principal = principal;
    request
}

fn entorhinal() -> Option<Principal> {
    Some(Principal::Reserved {
        module_id: "entorhinal".into(),
    })
}

fn status() -> Vec<u8> {
    serde_json::to_vec(&json!({
        "method": "agent_data.status",
        "params": {"refs": [], "cutId": "0123456789abcdef0123456789abcdef"},
    }))
    .unwrap()
}

fn agent_data_roles(manifest: &Value) -> Vec<Value> {
    manifest["provides"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|role| role["service_id"] == cortexkit_role_agent_data::SERVICE_ID)
        .cloned()
        .collect()
}

fn claims(manifest: &Value) -> Vec<String> {
    manifest["capabilities"]["provides"]
        .as_array()
        .unwrap()
        .iter()
        .map(|claim| claim.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn the_manifest_declares_the_agent_data_service_and_claim_only_with_moves_on() {
    let on = serde_json::to_value(manifest_for("magic-context", true)).unwrap();
    assert_eq!(
        agent_data_roles(&on),
        vec![json!({
            "role": "internal_service",
            "service_id": "agent-data",
            "transport": "bulk",
            "agent_facing": false,
            "operations": cortexkit_role_agent_data::REQUIRED_OPS,
        })]
    );
    assert_eq!(
        claims(&on)
            .iter()
            .filter(|claim| *claim == cortexkit_role_agent_data::PROVIDES)
            .count(),
        1
    );
    let off = serde_json::to_value(manifest_for("magic-context", false)).unwrap();
    assert_eq!(
        off,
        serde_json::to_value(manifest("magic-context")).unwrap()
    );
    assert!(agent_data_roles(&off).is_empty());
    assert!(!claims(&off).contains(&cortexkit_role_agent_data::PROVIDES.to_owned()));
    // Moves change nothing else the manifest declares.
    let mut without = on.clone();
    without["provides"]
        .as_array_mut()
        .unwrap()
        .retain(|role| role["service_id"] != cortexkit_role_agent_data::SERVICE_ID);
    without["capabilities"]["provides"]
        .as_array_mut()
        .unwrap()
        .retain(|claim| claim != cortexkit_role_agent_data::PROVIDES);
    assert_eq!(without, off);
}

/// With moves on, the agent-data branch comes before app admission, which
/// would otherwise take the route and judge Entorhinal as an app caller.
/// Only `reserved:entorhinal` binds, and a bound route's requests go to the
/// service before any other handler.
#[tokio::test]
async fn with_moves_on_only_entorhinal_binds_agent_data_and_its_requests_go_to_the_service() {
    let handler = handler(true);
    let accepted = handler
        .on_bind(&bind(
            5,
            cortexkit_role_agent_data::SERVICE_ID,
            entorhinal(),
        ))
        .await;
    assert!(
        !format!("{accepted:?}").contains("not_permitted"),
        "{accepted:?}"
    );
    assert_eq!(
        handler
            .agent_data_bound
            .lock()
            .unwrap()
            .get(&5)
            .map(String::as_str),
        Some("reserved:entorhinal")
    );
    assert!(handler.app_bound.lock().unwrap().is_empty());
    assert_eq!(
        handler.agent_data(5, &status()).await.unwrap().unwrap(),
        br#"{"step":"none"}"#
    );
    assert!(handler.agent_data(6, &status()).await.is_none());
    for principal in [
        None,
        Some(Principal::Direct),
        Some(Principal::Unverified),
        Some(Principal::Reserved {
            module_id: "callosum".into(),
        }),
        Some(Principal::Reserved {
            module_id: "broca".into(),
        }),
    ] {
        let refused = handler
            .on_bind(&bind(
                6,
                cortexkit_role_agent_data::SERVICE_ID,
                principal.clone(),
            ))
            .await;
        assert!(
            format!("{refused:?}").contains("caller_forbidden"),
            "{principal:?}: {refused:?}"
        );
        assert!(handler.agent_data(6, &status()).await.is_none());
    }
    // Entorhinal's route to another module's agent-data service is not ours.
    let mut elsewhere = bind(6, cortexkit_role_agent_data::SERVICE_ID, entorhinal());
    elsewhere.target = RouteTarget::InternalService {
        module_id: "broca".into(),
        service_id: cortexkit_role_agent_data::SERVICE_ID.into(),
    };
    assert!(format!("{:?}", handler.on_bind(&elsewhere).await).contains("caller_forbidden"));
    // The app reads are admitted as before.
    handler
        .on_bind(&bind(7, crate::app_read::ROLE.0, Some(Principal::Direct)))
        .await;
    assert!(handler.app_bound.lock().unwrap().contains_key(&7));
    // A channel bound again for something else is no longer an agent-data route.
    handler
        .on_bind(&bind(5, crate::app_read::ROLE.0, Some(Principal::Direct)))
        .await;
    assert!(handler.agent_data(5, &status()).await.is_none());
}

/// With moves off, an agent-data route is refused exactly like a route to
/// a service ck-mc does not declare, so its requests never reach anything.
#[tokio::test]
async fn with_moves_off_an_agent_data_route_is_refused_like_an_unknown_service() {
    let handler = handler(false);
    let refused = format!(
        "{:?}",
        handler
            .on_bind(&bind(
                5,
                cortexkit_role_agent_data::SERVICE_ID,
                entorhinal()
            ))
            .await
    );
    let unknown = format!(
        "{:?}",
        handler
            .on_bind(&bind(6, "no-such-service", entorhinal()))
            .await
    );
    assert_eq!(refused, unknown);
    assert!(refused.contains("not_permitted"), "{refused}");
    assert!(handler.agent_data_bound.lock().unwrap().is_empty());
    assert!(handler.agent_data(5, &status()).await.is_none());
}
