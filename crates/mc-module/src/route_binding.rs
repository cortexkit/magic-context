//! Route project metadata is stamped by the scope owner, not the connection opener.

use crate::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ScopedProject {
    pub workdir: PathBuf,
    pub project_id: Option<String>,
}

impl ScopedProject {
    pub fn from_stamp(stamp: Option<&subc_protocol::scope::ScopeStamp>) -> Option<Self> {
        let stamp = stamp?;
        Some(Self {
            workdir: PathBuf::from(stamp.workdir.as_ref()?),
            project_id: stamp.project_id.clone(),
        })
    }
}

/// A bound route need not have a project or even name an existing session.
/// Keep its authorization separate from project-bearing session bindings.
#[derive(Clone)]
pub(crate) struct RouteIdentity {
    pub principal: Option<subc_protocol::Principal>,
    pub scope: Option<subc_protocol::scope::ScopeStamp>,
    pub harness: String,
    pub session: String,
}

#[derive(Clone)]
pub(crate) struct StoredProject {
    pub workdir: PathBuf,
    pub key: Option<String>,
}

impl McHandler {
    pub(crate) fn unscoped_project_refusal(
        &self,
        channel: u16,
        request: &Value,
    ) -> Option<HandlerOutcome> {
        let route = self.route_identity(channel)?;
        let method = request
            .get("method")
            .or_else(|| request.get("kind"))
            .or_else(|| request.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if method == "compaction.setup" && ScopedProject::from_stamp(route.scope.as_ref()).is_none()
        {
            return Some(HandlerOutcome::Error {
                code: "setup_route_unscoped".into(),
                message: "compaction.setup requires a project in the route scope".into(),
            });
        }
        if ScopedProject::from_stamp(route.scope.as_ref()).is_some()
            || self.facade_binding(channel).is_ok()
            || matches!(
                method,
                "tool.catalog"
                    | "role.describe"
                    | "transform.declare"
                    | "transform.hook"
                    | "view.get"
                    | "compaction.ride"
                    | "session.status"
                    | "session.delete"
                    | "health"
                    | "status"
                    | "diagnostics"
                    | "echo"
                    | "session_data.read"
                    | "context.cache_why"
                    | "context.search"
                    | "context.watch"
                    | "subagent_invocations.read"
            )
        {
            return None;
        }
        Some(HandlerOutcome::Error {
            code: "route_unscoped".into(),
            message: if route.harness == "claude-code" {
                format!("unscoped Claude Code facade: no project without a scope ({method})")
            } else {
                format!("{method} requires a scoped project or an existing session project")
            },
        })
    }
    pub(crate) fn management_session_project(
        &self,
        channel: u16,
        request: &Value,
        operation: &str,
    ) -> Result<(String, Option<SessionBinding>, Option<String>), HandlerOutcome> {
        let Some(route) = self.route_identity(channel) else {
            return self.management_binding(channel, request, operation).map(
                |(session, binding)| {
                    let key = binding.project_root.to_string_lossy().into_owned();
                    (session, Some(binding), Some(key))
                },
            );
        };
        let session = request
            .get("session_id")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty());
        if request.get("v").and_then(Value::as_u64) != Some(1) || session.is_none() {
            return Err(HandlerOutcome::Error {
                code: "bad_request".into(),
                message: format!("{operation} requires v=1 and session_id"),
            });
        }
        let session = session.expect("validated session");
        if session != route.session {
            return Err(HandlerOutcome::Error {
                code: "session_mismatch".into(),
                message: "request session_id does not match the channel's bound session".into(),
            });
        }
        let project = self.stored_project(&route)?;
        if operation == "session.status"
            && project
                .as_ref()
                .is_some_and(|project| !project.workdir.is_absolute())
        {
            project_identity::log_once(
                format!("session-config-directory-missing:{session}"),
                &format!("session.status session {session}: stored project has no directory; skipping project config and using user-only config"),
            );
        }
        let key = project.as_ref().map(|project| {
            project
                .key
                .clone()
                .unwrap_or_else(|| project.workdir.to_string_lossy().into_owned())
        });
        let binding = project.map(|project| self.project_binding(&route, &project));
        if binding.is_none() {
            project_identity::log_once(
                format!("session-project-missing:{session}"),
                &format!("{operation} session {session}: no stored project; skipping project-scoped notes, memory delta and project config"),
            );
        }
        Ok((session.to_string(), binding, key))
    }
    pub(crate) fn route_identity(&self, channel: u16) -> Option<RouteIdentity> {
        self.route_identities
            .lock()
            .expect("route identities")
            .get(&channel)
            .cloned()
    }

    pub(crate) fn user_config(&self) -> McModuleConfig {
        #[cfg(test)]
        if let Some(config) = &self.fixed_config {
            return config.clone();
        }
        self.config
            .lock()
            .expect("config mutex")
            .effective_user_only()
    }

    /// A session keeps the project stored when compaction.setup created its durable state, including records written
    /// before scope-only binds. Standalone hosts record theirs in session_projects.
    pub(crate) fn stored_async_project(
        &self,
        route: &RouteIdentity,
    ) -> Result<Option<StoredProject>, HandlerOutcome> {
        let Some(store) = self.store.get() else {
            return Ok(None);
        };
        let runner = route_targets::SessionRunnerRoute::for_principal(
            route.principal.as_ref(),
            &route.session,
        );
        let mut projects = store
            .async_compaction_projects_for_session(
                runner.as_ref().map(|runner| runner.module_id()),
                &route.session,
            )
            .map_err(|e| HandlerOutcome::Error {
                code: "store_load_failed".into(),
                message: e.to_string(),
            })?;
        match projects.len() {
            0 => Ok(None),
            1 => Ok(projects.pop().map(|(root, key)| StoredProject {
                workdir: PathBuf::from(root),
                key,
            })),
            _ => Err(session_unresolved_error()),
        }
    }

    pub(crate) fn stored_project(
        &self,
        route: &RouteIdentity,
    ) -> Result<Option<StoredProject>, HandlerOutcome> {
        if let Some(mut project) = self.stored_async_project(route)? {
            if project.key.is_none() {
                if let Some(store) = self.store.get() {
                    project.key =
                        store
                            .session_project_identity(&route.session)
                            .map_err(|error| HandlerOutcome::Error {
                                code: "store_load_failed".into(),
                                message: error.to_string(),
                            })?;
                }
            }
            return Ok(Some(project));
        }
        let Some(store) = self.store.get() else {
            return Ok(None);
        };
        store
            .session_project_identity(&route.session)
            .map(|key| {
                key.map(|key| StoredProject {
                    workdir: PathBuf::from(&key),
                    key: Some(key),
                })
            })
            .map_err(|e| HandlerOutcome::Error {
                code: "store_load_failed".into(),
                message: e.to_string(),
            })
    }

    pub(crate) fn project_binding(
        &self,
        route: &RouteIdentity,
        project: &StoredProject,
    ) -> SessionBinding {
        SessionBinding {
            principal: route.principal.clone(),
            scope: route.scope.clone(),
            project_root: project.workdir.clone(),
            harness: route.harness.clone(),
            session: route.session.clone(),
            model_key: None,
            // Shared-store project IDs are storage keys, not filesystem paths.
            config: if project.workdir.is_absolute() {
                self.effective_config(&project.workdir)
            } else {
                self.user_config()
            },
            history_budget_tokens: memory_render::DEFAULT_HISTORY_BUDGET_TOKENS,
        }
    }

    pub(crate) fn scoped_binding(&self, route: &RouteIdentity) -> Option<SessionBinding> {
        let project = ScopedProject::from_stamp(route.scope.as_ref())?;
        Some(self.project_binding(
            route,
            &StoredProject {
                workdir: project.workdir,
                key: project.project_id,
            },
        ))
    }
}
