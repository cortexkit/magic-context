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

#[derive(Clone, Debug)]
pub struct AppRefusal {
    code: &'static str,
    message: String,
}

impl AppRefusal {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn bind_decision(self) -> BindDecision {
        BindDecision::reject(self.code, self.message)
    }

    pub fn outcome(self) -> HandlerOutcome {
        HandlerOutcome::Error {
            code: self.code.into(),
            message: self.message,
        }
    }
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
) -> Result<AppCaller, AppRefusal> {
    let target_matches = match &req.target {
        subc_protocol::RouteTarget::InternalService {
            module_id,
            service_id,
        } => module_id == registered_id && service_id == super::SERVICE_ID,
        subc_protocol::RouteTarget::ManagementSurface { module_id } => module_id == registered_id,
        _ => false,
    };
    if !target_matches {
        return Err(AppRefusal::new(
            "app_target_mismatch",
            "App read target differs from the registered module.",
        ));
    }
    if !caller_allowed(req.principal.as_ref(), allow_direct) {
        return Err(AppRefusal::new(
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
            return Err(AppRefusal::new(
                "app_route_agent_scope",
                format!("App read does not admit scope attribute {attribute}."),
            ));
        }
    }
    if matches!(&req.principal, Some(Principal::Reserved { .. }))
        && !req.identity.harness.starts_with("fed-phone:")
    {
        return Err(AppRefusal::new(
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
            return Err(AppRefusal::new(
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

    /// All Direct routes share one quota; non-Direct routes are grouped by
    /// their stored harness value.
    pub(crate) fn watch_key(&self) -> String {
        if self.is_direct() {
            "direct".into()
        } else {
            self.harness.clone()
        }
    }
}

#[cfg(test)]
#[path = "admission_tests.rs"]
pub(super) mod tests;
