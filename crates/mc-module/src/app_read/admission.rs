//! App identity is daemon-stamped; session identity never authorizes this lane.

use subc_client_rs::{BindDecision, HandlerOutcome, RouteBindRequest};
use subc_protocol::{
    call_mode::{derive_call_mode, CallMode},
    Principal,
};

#[derive(Clone, Debug)]
pub struct AppCaller {
    principal: Option<Principal>,
    harness: String,
}

fn caller_allowed(principal: Option<&Principal>, allow_direct: bool) -> bool {
    match principal {
        Some(Principal::Direct) => allow_direct,
        Some(Principal::Reserved { module_id }) => module_id == "callosum",
        _ => false,
    }
}

pub fn admit(
    req: &RouteBindRequest,
    registered_id: &str,
    allow_direct: bool,
) -> Result<AppCaller, BindDecision> {
    if !matches!(&req.target, subc_protocol::RouteTarget::InternalService {module_id, service_id}
        if module_id == registered_id && service_id == super::SERVICE_ID)
    {
        return Err(BindDecision::reject(
            "app_target_mismatch",
            "App read target differs from the registered module.",
        ));
    }
    if !caller_allowed(req.principal.as_ref(), allow_direct) {
        return Err(BindDecision::reject(
            "app_caller_forbidden",
            "App read requires Callosum or Direct with app_read.allow_direct enabled.",
        ));
    }
    if let Some(scope) = &req.scope {
        let a = &scope.attributes;
        let attribute = if matches!(req.principal, Some(Principal::Direct)) {
            Some("scope")
        } else if a.agent_id.is_some() {
            Some("agent_id")
        } else if a.on_behalf_of_agent.is_some() {
            Some("on_behalf_of_agent")
        } else if a.delegates {
            Some("delegates")
        } else if a.flow_id.is_some() {
            Some("flow_id")
        } else if a.run_id.is_some() {
            Some("run_id")
        } else if derive_call_mode(Some(scope)) != CallMode::Classic {
            Some("call_mode")
        } else {
            None
        };
        if let Some(attribute) = attribute {
            return Err(BindDecision::reject(
                "app_route_agent_scope",
                format!("App read does not admit scope attribute {attribute}."),
            ));
        }
    }
    if matches!(&req.principal, Some(Principal::Reserved { .. }))
        && !req.identity.harness.starts_with("fed-phone:")
    {
        return Err(BindDecision::reject(
            "app_route_not_operator",
            "Callosum must stamp the fed-phone: device class.",
        ));
    }
    if let Some(version) = req
        .role_versions
        .as_ref()
        .and_then(|versions| versions.get(super::SERVICE_ID))
    {
        if version != "v1" {
            return Err(BindDecision::reject(
                "app_role_version_unsupported",
                format!("App read role version {version:?} is unsupported; expected v1."),
            ));
        }
    }
    Ok(AppCaller {
        principal: req.principal.clone(),
        harness: req.identity.harness.clone(),
    })
}

impl AppCaller {
    pub fn recheck(&self, allow_direct: bool) -> Result<(), HandlerOutcome> {
        if !caller_allowed(self.principal.as_ref(), allow_direct)
            || (matches!(self.principal, Some(Principal::Reserved { .. }))
                && !self.harness.starts_with("fed-phone:"))
        {
            return Err(HandlerOutcome::Error {
                code: "app_caller_forbidden".into(),
                message: "App read requires Callosum or Direct with app_read.allow_direct enabled."
                    .into(),
            });
        }
        Ok(())
    }

    pub fn is_direct(&self) -> bool {
        matches!(self.principal, Some(Principal::Direct))
    }
}

#[cfg(test)]
pub(super) mod tests {
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
            BindIdentity::new(
                std::path::PathBuf::from("caller-chosen"),
                "fed-phone:peer-key",
                "ignored-session",
            ),
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
                let expected = if !permitted
                    || (matches!(principal, Some(Principal::Direct)) && !allow_direct)
                {
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
}
