//! Everything a routed dream run asks of the outside world, behind one trait:
//! Entorhinal's project lookup, the daemon's `scope.sync`, the routing/v1
//! provider and the chosen runner's llm-runner ops on a route under the run's
//! scope. Tests drive the dreamer with a fake; production uses
//! [`ProductionWire`].

use std::path::Path;

use cortexkit_role_routing::{
    errors::Refusal,
    report::{ReportAnswer, ReportRequest},
    select::SelectRequest,
};
use serde_json::Value;
use subc_client_rs::async_trait;

use super::fetch_plan::Provider;
use super::scope::{DreamScope, EntorhinalProjectId};
use crate::dream_dispatch::broca_carrier::PortError;
use crate::model_work::RoutingCatalog;

/// No registered module connection has proven project-scope support yet.
pub const SCOPE_UNSUPPORTED: &str = "mc_dream_scope_unsupported";

/// A refusal from the scope seam, by name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireRefusal {
    pub code: String,
    pub detail: String,
}

/// The identity a runner run is bound to: the runner module, the harness that
/// runner hosts the session on, and the session name ck-mc minted. The project
/// root of the binding is the run scope's `workdir`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerBind {
    pub module: String,
    pub harness: String,
    pub session: String,
}

#[async_trait]
pub trait DreamWire: Send + Sync {
    /// Whether this build can register a project scope at all. A run takes the
    /// routed path only when it can; the refusal names what is missing.
    fn scope_support(&self) -> Result<(), WireRefusal>;
    /// A refused folder must not disable routing for unrelated projects.
    fn scope_support_for(&self, _workdir: &Path) -> Result<(), WireRefusal> {
        self.scope_support()
    }
    /// Entorhinal's project id for exactly this folder, or `None` when it has no
    /// registered answer. Never a derived identity.
    async fn lookup_project(&self, workdir: &Path) -> Option<EntorhinalProjectId>;
    /// Register (or update) `scope` with the daemon, ck-mc as its owner.
    async fn sync_scope(&self, scope: &DreamScope) -> Result<(), WireRefusal>;
    /// End `scope`; nothing more runs under it.
    async fn end_scope(&self, scope: &DreamScope) -> Result<(), WireRefusal>;
    /// The routing/v1 providers in the module catalog right now.
    async fn routing_catalog(&self) -> RoutingCatalog;
    /// Resolve tags against providers reachable under this scope. The resolved
    /// provider modules also restrict which modules the runner may call here.
    async fn tool_providers(
        &self,
        scope: &DreamScope,
        capabilities: &[&str],
    ) -> Result<Vec<Provider>, WireRefusal>;
    /// `route.select` on a route opened under `scope`. Answers the provider's
    /// answer as sent, so members this crate version does not decode (such as a
    /// runner's hosted harness) are still visible to the caller.
    async fn select(
        &self,
        scope: &DreamScope,
        provider: &str,
        request: &SelectRequest,
    ) -> Result<Value, Refusal>;
    /// `route.report` on a route opened under `scope`.
    async fn report(
        &self,
        scope: &DreamScope,
        provider: &str,
        request: &ReportRequest,
    ) -> Result<ReportAnswer, Refusal>;
    /// One llm-runner op on a route to `bind.module` under `scope`, bound to
    /// `bind`'s harness and session with `scope.workdir` as the project root.
    async fn runner_call(
        &self,
        scope: &DreamScope,
        bind: &RunnerBind,
        op: &str,
        params: Value,
    ) -> Result<Value, PortError>;
    /// The next unit of the bound session's `session.subscribe` stream.
    async fn runner_next_unit(
        &self,
        scope: &DreamScope,
        bind: &RunnerBind,
    ) -> Result<Option<Value>, PortError>;
    /// Close the bound session's routes. Never a deletion.
    async fn runner_release(&self, scope: &DreamScope, bind: &RunnerBind);
}

pub use super::production::ProductionWire;
