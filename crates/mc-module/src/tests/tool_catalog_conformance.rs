//! The commons `tool-provider/v1` conformance suite, run against this module's
//! request handler.
//!
//! The suite is written for a provider reached over a live daemon route. These
//! tests run with no daemon, so the route below hands each request body to the
//! module's own dispatch (the code a daemon route reaches after the transport) and
//! reports its outcome as the frame the transport would send. Everything else the
//! suite checks is the module's real answer.
//!
//! Magic Context holds no call past its reply, keeps no late results and has no
//! config to disable a tool by name, so it declares none of the suite's optional
//! capabilities. The verdict is therefore "conforming for declared capabilities",
//! never a plain pass, and every case that needs no capability must pass.

use std::collections::BTreeSet;
use std::path::Path;

use async_trait::async_trait;
use cortexkit_role_tool_provider_conformance::harness::{
    Harness, HarnessError, KillPoint, KillReport, PointDeclaration, RouteStamp, Trigger,
};
use cortexkit_role_tool_provider_conformance::{
    run_suite, CallSpec, Capability, CaseOutcome, Exchange, ObservedFrame, RouteFailure,
    ScopedPrincipals, SuiteVerdict, ToolProviderSubject, ToolRoute, CASES,
};
use subc_protocol::ErrorBody;

use super::*;

/// The channel every route of a spawned module is bound on.
const CHANNEL: u16 = 7;

struct Subject;

/// One spawned module: its handler, with the store and project it was bound to.
struct Module {
    handler: Arc<McHandler>,
    _store: Arc<McStore>,
    _dir: tempfile::TempDir,
}

struct Route {
    handler: Arc<McHandler>,
}

#[async_trait]
impl Harness for Subject {
    type Handle = Module;
    type Route = Route;

    fn declared_points(&self) -> Vec<PointDeclaration> {
        Vec::new()
    }

    async fn spawn(&self, _state_root: &Path) -> Result<Module, HarnessError> {
        let (handler, store, dir, project) =
            handler_with_store(Arc::new(ProducerState::default()), default_test_config());
        handler.bind_route(
            CHANNEL,
            binding_with_harness(project.to_str().unwrap(), OPENCODE_HARNESS, "ses"),
        );
        Ok(Module {
            handler: Arc::new(handler),
            _store: store,
            _dir: dir,
        })
    }

    async fn route(&self, module: &Module, _stamp: &RouteStamp) -> Result<Route, HarnessError> {
        // The consumer declares the role at bind, as a tool-provider/v1 caller does.
        module.handler.record_route_role_versions(
            CHANNEL,
            Some(&BTreeMap::from([(
                cortexkit_role_tool_provider::ROLE.to_string(),
                cortexkit_role_tool_provider::VERSION.to_string(),
            )])),
        );
        Ok(Route {
            handler: Arc::clone(&module.handler),
        })
    }

    async fn kill_at(
        &self,
        _module: Module,
        point: &KillPoint,
        _trigger: Trigger<'_>,
    ) -> Result<KillReport, HarnessError> {
        Err(HarnessError::new(format!(
            "Magic Context declares no kill points, so none can be cut at {point}"
        )))
    }

    async fn restart(&self, _state_root: &Path) -> Result<Module, HarnessError> {
        Err(HarnessError::new(
            "Magic Context declares no kill points, so nothing is restarted",
        ))
    }
}

#[async_trait]
impl ToolRoute for Route {
    async fn request(&self, body: Value) -> Result<Exchange, RouteFailure> {
        let frame = match self.handler.dispatch_value(CHANNEL, body).await {
            HandlerOutcome::Response(bytes) => {
                ObservedFrame::Response(serde_json::from_slice(&bytes).map_err(|error| {
                    RouteFailure::new(format!("a response that is not JSON: {error}"))
                })?)
            }
            HandlerOutcome::Error { code, message } => {
                ObservedFrame::Error(ErrorBody::new(code, message))
            }
            HandlerOutcome::ErrorWithDetail {
                code,
                message,
                detail,
            } => ObservedFrame::Error(ErrorBody::new(code, message).with_detail(detail)),
            HandlerOutcome::Streamed => ObservedFrame::StreamEnd,
        };
        Ok(Exchange {
            frames: vec![frame],
        })
    }

    async fn request_then_cancel(&self, body: Value) -> Result<Exchange, RouteFailure> {
        // Only the cancellation case uses this, and Magic Context does not
        // declare that capability, so the suite never reaches it.
        self.request(body).await
    }
}

#[async_trait]
impl ToolProviderSubject for Subject {
    fn capabilities(&self) -> BTreeSet<Capability> {
        BTreeSet::new()
    }

    fn plain_stamp(&self) -> RouteStamp {
        RouteStamp {
            principal: "reserved:broca".to_string(),
            scope: None,
        }
    }

    fn scoped_principals(&self) -> Option<ScopedPrincipals> {
        None
    }

    fn catalog_arguments(&self) -> Value {
        json!({"params": {}, "preset": "primary"})
    }

    fn quick_call(&self) -> CallSpec {
        ("ctx_note".to_string(), json!({"action": "read"}))
    }

    fn slow_call(&self) -> Option<CallSpec> {
        None
    }

    fn disabled_tool(&self) -> Option<String> {
        None
    }

    fn held_call(&self, _marker: &Path) -> Option<CallSpec> {
        None
    }

    async fn await_held(&self, _call_key: &str) -> Result<(), HarnessError> {
        Err(HarnessError::new("Magic Context holds no calls"))
    }

    async fn approve(&self, _call_key: &str) -> Result<(), HarnessError> {
        Err(HarnessError::new("Magic Context holds no calls"))
    }

    async fn settle(&self) {}
}

#[tokio::test(flavor = "current_thread")]
async fn the_role_conformance_suite_passes_every_case_magic_context_can_run() {
    let work = tempfile::tempdir().unwrap();
    let report = run_suite(&Subject, work.path()).await.unwrap();
    let rendered = report.render();
    let expected_to_run = [
        "user_commands_catalog",
        "role_describe_shape",
        "role_describe_cacheable",
        "catalog_schemas_flat",
        "catalog_reply_valid",
        "catalog_modes_valid",
        "catalog_emits_events_boolean",
        "catalog_schema_digest_stable",
        "catalog_digest_only",
        "catalog_unknown_preset_refused",
        "terminal_frame_on_success",
        "terminal_frame_on_refusal",
    ];
    for spec in CASES {
        let outcome = report.outcome(spec.name);
        if expected_to_run.contains(&spec.name) {
            assert_eq!(
                outcome,
                Some(&CaseOutcome::Passed),
                "{}\n{rendered}",
                spec.name
            );
        } else {
            assert!(
                matches!(outcome, Some(CaseOutcome::Skipped { .. })),
                "{}\n{rendered}",
                spec.name
            );
        }
    }
    assert!(
        matches!(
            report.verdict,
            SuiteVerdict::ConformingForDeclaredCapabilities { .. }
        ),
        "{rendered}"
    );
    assert!(report.kills.is_empty(), "{rendered}");
}
