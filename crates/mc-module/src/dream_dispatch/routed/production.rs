//! Live daemon discovery and scoped routing for dream work.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use cortexkit_role_routing::{
    errors::{Refusal, RefusalCode},
    report::{ReportAnswer, ReportRequest},
    select::SelectRequest,
};
use serde_json::{json, Value};
use subc_client_rs::{
    async_trait, CallError, CallOptions, CloseRouteOptions, ConsumerOptions, ModuleHandle,
    SubcConsumer,
};
use subc_protocol::{scope::ScopeSelector, BindIdentity, Principal};

use super::{
    fetch_plan::Provider,
    live::Scopes,
    runner_port::RunnerPort,
    scope::{DreamScope, EntorhinalProjectId},
    wire::{DreamWire, RunnerBind, WireRefusal},
};
use crate::{dream_dispatch::broca_carrier::PortError, model_work::RoutingCatalog};

pub struct ProductionWire {
    connection_file: PathBuf,
    module_id: String,
    scopes: Scopes,
    runners: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<RunnerPort>>>>,
}

pub(crate) async fn catalog(connection: &Path) -> Result<subc_client_rs::CatalogList, String> {
    let consumer = connect(connection).await?;
    let result = consumer.catalog_list().await.map_err(|e| e.to_string());
    consumer.close().await;
    result
}

pub(crate) async fn connect(connection: &Path) -> Result<SubcConsumer, String> {
    SubcConsumer::connect(
        connection,
        ConsumerOptions {
            handshake_timeout: Duration::from_secs(2),
            call_timeout: Duration::from_secs(10),
            ..ConsumerOptions::default()
        },
    )
    .await
    .map_err(|e| e.to_string())
}

impl ProductionWire {
    pub fn new(connection_file: PathBuf, module_id: String) -> Self {
        Self {
            connection_file,
            module_id,
            scopes: Scopes::default(),
            runners: tokio::sync::Mutex::default(),
        }
    }

    /// Must be called after polling the registered connection's serve future.
    pub async fn initialize(&self, handle: ModuleHandle) -> Result<(), WireRefusal> {
        self.scopes.initialize(handle).await
    }

    pub(super) fn selector(&self, scope: &DreamScope) -> ScopeSelector {
        ScopeSelector::new(
            Principal::Reserved {
                module_id: self.module_id.clone(),
            },
            scope.scope_ref(),
            Some(scope.record.scope_epoch),
        )
    }

    async fn runner(
        &self,
        scope: &DreamScope,
        bind: &RunnerBind,
    ) -> Arc<tokio::sync::Mutex<RunnerPort>> {
        self.runners
            .lock()
            .await
            .entry(bind.session.clone())
            .or_insert_with(|| {
                Arc::new(tokio::sync::Mutex::new(RunnerPort::new(
                    self.connection_file.clone(),
                    self.selector(scope),
                    scope.workdir.clone(),
                    bind.clone(),
                )))
            })
            .clone()
    }

    async fn routing_call(
        &self,
        scope: &DreamScope,
        provider: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, Refusal> {
        let unavailable = |e: String| Refusal::new(RefusalCode::RoutingUnavailable, e);
        let consumer = connect(&self.connection_file).await.map_err(unavailable)?;
        let options = CallOptions {
            role_versions: Some(BTreeMap::from([("routing".into(), "v1".into())])),
            ..CallOptions::default()
        };
        let result = async {
            let route = consumer
                .open_route_scoped(
                    crate::route_targets::routed_module_target(provider),
                    BindIdentity::new(scope.workdir.clone(), "magic-context", scope.scope_ref()),
                    self.selector(scope),
                    options.clone(),
                )
                .await?;
            let result = consumer
                .request(
                    &route,
                    serde_json::to_vec(&json!({"method": method, "params": params}))
                        .expect("routing JSON"),
                    options,
                )
                .await;
            let _ = consumer
                .close_handle(&route, CloseRouteOptions::default())
                .await;
            result
        }
        .await;
        consumer.close().await;
        match result {
            Ok(bytes) => cortexkit_role_routing::wire::read_reply(&bytes)
                .map_err(|e| unavailable(e.to_string())),
            Err(CallError::Module(body)) => Err(serde_json::to_value(&body)
                .ok()
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_else(|| unavailable(format!("{}: {}", body.code, body.message)))),
            Err(error) => Err(unavailable(error.to_string())),
        }
    }
}

#[async_trait]
impl DreamWire for ProductionWire {
    fn scope_support(&self) -> Result<(), WireRefusal> {
        self.scopes.support()
    }
    fn scope_support_for(&self, workdir: &Path) -> Result<(), WireRefusal> {
        self.scopes.support_for(&workdir.to_string_lossy())
    }
    async fn lookup_project(&self, workdir: &Path) -> Option<EntorhinalProjectId> {
        let id =
            crate::entorhinal_resolve::EntorhinalResolver::new(Some(self.connection_file.clone()))
                .registered_project(workdir)
                .await?;
        EntorhinalProjectId::from_lookup_answer(&id)
    }
    async fn sync_scope(&self, scope: &DreamScope) -> Result<(), WireRefusal> {
        self.scopes.update(&scope.record, false).await
    }
    async fn end_scope(&self, scope: &DreamScope) -> Result<(), WireRefusal> {
        self.scopes.update(&scope.record, true).await
    }
    async fn routing_catalog(&self) -> RoutingCatalog {
        match catalog(&self.connection_file).await {
            Ok(list) => RoutingCatalog {
                generation: list.generation,
                providers: list
                    .modules
                    .iter()
                    .filter(|m| {
                        m.capabilities.as_ref().is_some_and(|c| {
                            c.provides
                                .iter()
                                .any(|p| p == cortexkit_role_routing::PROVIDES)
                        })
                    })
                    .map(|m| m.module_id.clone())
                    .collect(),
            },
            Err(error) => {
                tracing::warn!(%error, "routing catalog unavailable");
                RoutingCatalog {
                    generation: 0,
                    providers: vec![],
                }
            }
        }
    }
    async fn tool_providers(
        &self,
        _: &DreamScope,
        capabilities: &[&str],
    ) -> Result<Vec<Provider>, WireRefusal> {
        let listed = catalog(&self.connection_file)
            .await
            .map_err(|detail| WireRefusal {
                code: "mc_dream_catalog_unavailable".into(),
                detail,
            })?;
        let mut providers = Vec::new();
        for capability in capabilities {
            let matches: Vec<_> = listed
                .modules
                .iter()
                .filter(|m| {
                    m.capabilities
                        .as_ref()
                        .is_some_and(|c| c.provides.iter().any(|p| p == capability))
                })
                .collect();
            if matches.len() != 1 {
                return Err(WireRefusal {
                    code: "tool_unavailable".into(),
                    detail: format!("{capability}: {} providers", matches.len()),
                });
            }
            providers.push(Provider {
                capability: (*capability).into(),
                module: matches[0].module_id.clone(),
            });
        }
        Ok(providers)
    }
    async fn select(
        &self,
        scope: &DreamScope,
        provider: &str,
        request: &SelectRequest,
    ) -> Result<Value, Refusal> {
        self.routing_call(
            scope,
            provider,
            "route.select",
            serde_json::to_value(request).expect("select JSON"),
        )
        .await
    }
    async fn report(
        &self,
        scope: &DreamScope,
        provider: &str,
        request: &ReportRequest,
    ) -> Result<ReportAnswer, Refusal> {
        let value = self
            .routing_call(
                scope,
                provider,
                "route.report",
                serde_json::to_value(request).expect("report JSON"),
            )
            .await?;
        serde_json::from_value(value)
            .map_err(|e| Refusal::new(RefusalCode::RoutingUnavailable, e.to_string()))
    }
    async fn runner_call(
        &self,
        scope: &DreamScope,
        bind: &RunnerBind,
        op: &str,
        params: Value,
    ) -> Result<Value, PortError> {
        self.runner(scope, bind)
            .await
            .lock()
            .await
            .call(op, params)
            .await
    }
    async fn runner_next_unit(
        &self,
        scope: &DreamScope,
        bind: &RunnerBind,
    ) -> Result<Option<Value>, PortError> {
        self.runner(scope, bind).await.lock().await.next().await
    }
    async fn runner_release(&self, _: &DreamScope, bind: &RunnerBind) {
        if let Some(port) = self.runners.lock().await.remove(&bind.session) {
            port.lock().await.close().await;
        }
    }
}
