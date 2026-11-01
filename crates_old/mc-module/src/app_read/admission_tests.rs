use super::*;
use subc_client_rs::RouteHandle;
use subc_protocol::{
    scope::{ScopeAttributes, ScopeKind, ScopeStamp},
    BindIdentity,
};

pub fn phone_bind() -> RouteBindRequest {
    RouteBindRequest::new(
        RouteHandle::detached(1, 1),
        crate::route_targets::app_read_target_for_test(crate::DEFAULT_MODULE_ID),
        BindIdentity::new("fed-phone:peer-key", "ignored-session"),
    )
    .with_principal(Principal::Reserved {
        module_id: "callosum".into(),
    })
}

pub fn scope(attribute: &str) -> ScopeStamp {
    let mut attributes = ScopeAttributes::new();
    match attribute {
        "agent_id" => attributes.agent_id = Some("agent".into()),
        "on_behalf_of_agent" => attributes.on_behalf_of_agent = Some("agent".into()),
        "delegates" => attributes.delegates = true,
        "flow_id" => attributes.flow_id = Some("flow".into()),
        "run_id" => attributes.run_id = Some("run".into()),
        "classic" => {}
        other => panic!("unknown scope fixture {other}"),
    }
    ScopeStamp::new(
        Principal::Reserved {
            module_id: "prefrontal-core".into(),
        },
        "scope",
        1,
        ScopeKind::Ephemeral,
    )
    .with_attributes(attributes)
    .with_owner_authorized(true)
}

fn principals() -> Vec<(Option<Principal>, bool)> {
    vec![
        (
            Some(Principal::Reserved {
                module_id: "callosum".into(),
            }),
            true,
        ),
        (Some(Principal::Direct), true),
        (
            Some(Principal::Reserved {
                module_id: "thalamus-harness".into(),
            }),
            false,
        ),
        (
            Some(Principal::Reserved {
                module_id: "basal".into(),
            }),
            false,
        ),
        (
            Some(Principal::Reserved {
                module_id: "other".into(),
            }),
            false,
        ),
        (Some(Principal::Unverified), false),
        (None, false),
    ]
}

fn assert_admission(req: &RouteBindRequest, allow_direct: bool, expected: Option<&str>) {
    let mut management = req.clone();
    if let subc_protocol::RouteTarget::InternalService { module_id, .. } = &req.target {
        management.target = subc_protocol::RouteTarget::ManagementSurface {
            module_id: module_id.clone(),
        };
    }
    for req in [req, &management] {
        let result = admit(req, crate::DEFAULT_MODULE_ID, allow_direct);
        match expected {
            None => assert!(result.is_ok(), "{result:?}"),
            Some(code) => match result {
                Err(refusal) => assert!(
                    format!("{refusal:?}").contains(code),
                    "expected {code}, got {refusal:?}"
                ),
                Ok(_) => panic!("expected {code} for {req:?}"),
            },
        }
    }
}

#[test]
fn bind_matrix() {
    for (principal, permitted) in principals() {
        for allow_direct in [false, true] {
            for attribute in [
                None,
                Some("classic"),
                Some("on_behalf_of_agent"),
                Some("delegates"),
                Some("flow_id"),
                Some("run_id"),
            ] {
                let mut req = phone_bind();
                req.principal = principal.clone();
                if matches!(principal, Some(Principal::Direct)) {
                    req.identity.harness = "desktop".into();
                }
                req.scope = attribute.map(scope);
                let expected = if !permitted
                    || (matches!(principal, Some(Principal::Direct)) && !allow_direct)
                {
                    Some("app_caller_forbidden")
                } else if attribute.is_some_and(|a| a != "classic")
                    || (attribute.is_some() && matches!(principal, Some(Principal::Direct)))
                {
                    Some("app_route_agent_scope")
                } else {
                    None
                };
                assert_admission(&req, allow_direct, expected);
            }
        }
    }
}

#[test]
fn bind_matrix_agent_id() {
    for (principal, permitted) in principals() {
        for allow_direct in [false, true] {
            let mut req = phone_bind();
            req.principal = principal.clone();
            req.scope = Some(scope("agent_id"));
            let expected =
                if !permitted || (matches!(principal, Some(Principal::Direct)) && !allow_direct) {
                    "app_caller_forbidden"
                } else {
                    "app_route_agent_scope"
                };
            assert_admission(&req, allow_direct, Some(expected));
        }
    }
}

#[test]
fn bind_target_device_class_and_version() {
    let mut req = phone_bind();
    req.target = crate::route_targets::app_read_target_for_test("wrong-module");
    assert_admission(&req, true, Some("app_target_mismatch"));
    let mut req = phone_bind();
    for harness in [
        "",
        "fed-sim:peer",
        "fed-computer:peer",
        "fed-mac:peer",
        "fed-unknown:peer",
        "fed-phone",
        "opencode",
    ] {
        req.identity.harness = harness.into();
        assert_admission(&req, true, Some("app_route_not_operator"));
    }
    req.identity.harness = "fed-phone:peer".into();
    assert!(req.admission_facts.is_none());
    assert_admission(&req, true, None);
    for version in ["v1", "v2", "v1.1", ""] {
        req.role_versions = Some(
            [(super::super::SERVICE_ID.into(), version.into())]
                .into_iter()
                .collect(),
        );
        assert_admission(
            &req,
            true,
            if version == "v1" {
                None
            } else {
                Some("app_role_version_unsupported")
            },
        );
    }
}

#[test]
fn request_rechecks_principal_and_direct_setting() {
    let mut req = phone_bind();
    req.principal = Some(Principal::Direct);
    let caller = admit(&req, crate::DEFAULT_MODULE_ID, true).unwrap();
    assert!(caller.recheck(true).is_ok());
    assert!(
        matches!(caller.recheck(false), Err(HandlerOutcome::Error {code, message}) if code == "app_caller_forbidden" && message.contains("app_read.allow_direct"))
    );
    let caller = AppCaller {
        principal: Some(Principal::Unverified),
        harness: "fed-phone:spoof".into(),
    };
    assert!(caller.recheck(true).is_err());
}
