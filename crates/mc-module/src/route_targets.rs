//! Registry for every cross-module route opened by `mc-module`.
//!
//! Runtime clients and the manifest both resolve through this registry so adding a route target
//! cannot silently leave the module's `consumes` declaration behind.

use subc_protocol::manifest::{
    SelfSignalDeclaration, SelfSignalEffect, SelfSignalKind, SignalAnchor, SignalCadence,
};
use subc_protocol::RouteTarget;

use crate::config::ConfiguredRunners;
use crate::historian_runner::HistorianRunnerKind;

pub const DEFAULT_THALAMUS_MODULE_ID: &str = "thalamus";
pub const DEFAULT_RUNNER_MODULE_ID: &str = "broca";

/// Static module targets. Hosting background completions does not disable the provider runner
/// route: a runner may still call this module for compaction or step-transform work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteTargetConfig {
    runner_module_id: Option<String>,
    provider_runner_module_id: String,
}

impl Default for RouteTargetConfig {
    fn default() -> Self {
        Self::runner_module(DEFAULT_RUNNER_MODULE_ID)
    }
}

impl RouteTargetConfig {
    pub fn runner_module(module_id: impl Into<String>) -> Self {
        let module_id = module_id.into();
        Self {
            runner_module_id: Some(module_id.clone()),
            provider_runner_module_id: module_id,
        }
    }

    /// Host-owned background completions spend no quota through a module route. The provider
    /// runner target remains available, but is used only when a runner calls us as a provider.
    pub fn host_runner() -> Self {
        Self {
            runner_module_id: None,
            provider_runner_module_id: DEFAULT_RUNNER_MODULE_ID.to_string(),
        }
    }

    /// The route selection a resolved historian runner implies: Broca's route for
    /// the Broca runner, no background-completion route for the host runner.
    pub fn for_historian_runner(runner: HistorianRunnerKind) -> Self {
        match runner {
            HistorianRunnerKind::Broca => Self::default(),
            HistorianRunnerKind::Host => Self::host_runner(),
        }
    }

    /// The route selection the user tier's runner settings imply for the whole
    /// process. A role left unconfigured is decided per request by the harness, and
    /// a Claude Code request with nothing configured goes to Broca, so the Broca
    /// background-completion route stays declared unless both roles are configured to the host
    /// runner. Provider callbacks and transcript reads have a separate, static target.
    pub fn for_configured_runners(runners: ConfiguredRunners) -> Self {
        let host = Some(HistorianRunnerKind::Host);
        if runners.historian == host && runners.dreamer == host {
            Self::host_runner()
        } else {
            Self::default()
        }
    }

    pub fn runner_module_id(&self) -> Option<&str> {
        self.runner_module_id.as_deref()
    }

    /// Select the one runner served by the compaction and step-transform providers. This is
    /// process configuration, never a module id supplied by a session's plan or request.
    pub fn with_provider_runner_module(mut self, module_id: impl Into<String>) -> Self {
        self.provider_runner_module_id = module_id.into();
        self
    }

    pub fn provider_runner_module_id(&self) -> &str {
        &self.provider_runner_module_id
    }

    pub(crate) fn target(&self, route: RegisteredRoute) -> Option<RouteTarget> {
        if route == RegisteredRoute::EngramDeviceStreams {
            return Some(RouteTarget::InternalService {
                module_id: "engram".into(),
                service_id: "device-streams".into(),
            });
        }
        if route == RegisteredRoute::EngramDoor {
            return crate::agent_data::ENABLED.then(|| RouteTarget::InternalService {
                module_id: "engram".into(),
                service_id: "session-door".into(),
            });
        }
        if route == RegisteredRoute::FusiformCatalog {
            return Some(RouteTarget::ToolProvider {
                module_id: "fusiform".into(),
            });
        }
        route
            .module_id(self)
            .map(|module_id| RouteTarget::ManagementSurface {
                module_id: module_id.to_string(),
            })
    }
}

/// The runner module that owns OpenCode and Pi sessions on a runner lane.
pub const THALAMUS_HARNESS_MODULE_ID: &str = "thalamus-harness";

/// Runner modules that can run a session's background model calls (historian and
/// dreamer) as hidden children of that same session, inside the session's own host.
/// A conversation is on a runner lane when the daemon stamped one of these modules as
/// the principal of the route that admitted it. `thalamus` is the Claude Code
/// gateway serving its sessions as a runner (`anthropic-messages`).
pub const SESSION_RUNNER_MODULE_IDS: [&str; 3] = [
    THALAMUS_HARNESS_MODULE_ID,
    DEFAULT_RUNNER_MODULE_ID,
    DEFAULT_THALAMUS_MODULE_ID,
];

/// Where a runner-lane conversation's background model calls go: the llm-runner
/// management surface of the module that runs the conversation. Child routes bind their
/// own generated sessions; the child routes' project root and harness come from the
/// conversation's recorded identity. Child sends currently omit the parent session
/// from the payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRunnerRoute {
    module_id: String,
    parent_session: String,
}

impl SessionRunnerRoute {
    /// The route for a conversation admitted under `principal` with runner session
    /// `parent_session`. `None` when the principal is not a session runner module:
    /// such a conversation keeps the process-configured routes.
    pub fn for_principal(
        principal: Option<&subc_protocol::Principal>,
        parent_session: &str,
    ) -> Option<Self> {
        let Some(subc_protocol::Principal::Reserved { module_id }) = principal else {
            return None;
        };
        (SESSION_RUNNER_MODULE_IDS.contains(&module_id.as_str()) && !parent_session.is_empty())
            .then(|| Self {
                module_id: module_id.clone(),
                parent_session: parent_session.to_string(),
            })
    }

    /// The route a background model call (historian firing, dream child, classify)
    /// for this conversation takes, or `None` when it keeps the process-configured
    /// runner: the conversation is not on a runner lane, or the user explicitly chose
    /// `broca` (`resolved` is the role's runner, e.g.
    /// `McModuleConfig::historian_runner_for(harness)`). Depends only on the
    /// conversation's daemon-stamped principal and session, never on how the
    /// conversation reports its progress.
    pub fn for_background_call(
        principal: Option<&subc_protocol::Principal>,
        parent_session: &str,
        resolved: crate::historian_runner::ResolvedRunner,
    ) -> Option<Self> {
        crate::historian_runner::uses_session_runner(resolved)
            .then(|| Self::for_principal(principal, parent_session))
            .flatten()
    }

    pub fn module_id(&self) -> &str {
        &self.module_id
    }

    pub fn parent_session(&self) -> &str {
        &self.parent_session
    }

    pub(crate) fn target(&self) -> RouteTarget {
        RouteTarget::ManagementSurface {
            module_id: self.module_id.clone(),
        }
    }
}

/// The management surface of a module routing named at run time: the
/// `routing/v1` provider a summary selects with, or the runner module its
/// answer names. Like a session's own runner, the module id is not known when
/// the manifest is built, so it is not a registered static route.
pub(crate) fn routed_module_target(module_id: &str) -> RouteTarget {
    RouteTarget::ManagementSurface {
        module_id: module_id.to_string(),
    }
}

/// Every route-opening purpose in this crate. Callers must select one of these instead of
/// constructing a `RouteTarget` directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RegisteredRoute {
    EngramDeviceStreams,
    EngramDoor,
    EntorhinalSessionRef,
    SessionResolve,
    HistorianRunner,
    ProviderRunner,
    FusiformCatalog,
    CompactionBus,
    EntorhinalResolve,
    SynapseRerank,
}

impl RegisteredRoute {
    const ALL: [Self; 10] = [
        Self::EngramDeviceStreams,
        Self::SessionResolve,
        Self::HistorianRunner,
        Self::ProviderRunner,
        Self::FusiformCatalog,
        Self::CompactionBus,
        Self::EngramDoor,
        Self::EntorhinalSessionRef,
        Self::EntorhinalResolve,
        Self::SynapseRerank,
    ];

    fn module_id(self, config: &RouteTargetConfig) -> Option<&str> {
        match self {
            Self::EngramDeviceStreams => Some("engram"),
            Self::EngramDoor => crate::agent_data::ENABLED.then_some("engram"),
            Self::EntorhinalSessionRef => crate::agent_data::ENABLED.then_some("entorhinal"),
            Self::SessionResolve => Some(DEFAULT_THALAMUS_MODULE_ID),
            Self::HistorianRunner => config.runner_module_id(),
            Self::ProviderRunner => Some(config.provider_runner_module_id()),
            Self::FusiformCatalog => Some("fusiform"),
            Self::CompactionBus => Some("ckbus"),
            Self::EntorhinalResolve => Some("entorhinal"),
            Self::SynapseRerank => Some("synapse"),
        }
    }

    /// Behaviors that run through this route and change an external surface, declared
    /// in the manifest only while the route resolves to a module. The match is
    /// exhaustive so a new route has to state its own behaviors here.
    fn self_signals(self) -> Vec<SelfSignalDeclaration> {
        match self {
            Self::EngramDeviceStreams => Vec::new(),
            Self::EngramDoor | Self::EntorhinalSessionRef => Vec::new(),
            // A lookup on the session registry: it spends nothing and shapes no surface.
            Self::SessionResolve => Vec::new(),
            // Project lookup is read-only and optional, not a startup dependency.
            Self::EntorhinalResolve => Vec::new(),
            // Callbacks and transcript reads spend no provider quota. Declaring this target
            // does not open a connection or require the runner to be registered at startup.
            Self::ProviderRunner => Vec::new(),
            // Model limits are a read-only catalog lookup and spend no provider quota.
            Self::FusiformCatalog => Vec::new(),
            Self::CompactionBus => Vec::new(),
            // Explicit mc.retrieval searches may call Synapse. Declaring this target
            // neither connects to Synapse nor starts automatic retrieval work.
            Self::SynapseRerank => Vec::new(),
            // The background runner route carries every model call this module makes, so both
            // callers of it spend the user's provider quota.
            Self::HistorianRunner => vec![
                SelfSignalDeclaration {
                    name: "historian_firing".to_string(),
                    kind: SelfSignalKind::Other("historian".to_string()),
                    effect: SelfSignalEffect::Mutate,
                    anchored_to: SignalAnchor::Event {
                        event: "transform request that passes the historian trigger".to_string(),
                    },
                    cadence: Some(SignalCadence::Derived {
                        source: "historian trigger config (execute threshold / commit clusters / tail size)"
                            .to_string(),
                    }),
                    domain: Some(PROVIDER_USAGE_DOMAIN.to_string()),
                    note: Some(
                        "spends quota only when the resolved model chain routes through the runner module"
                            .to_string(),
                    ),
                },
                SelfSignalDeclaration {
                    name: "dreamer_classify".to_string(),
                    kind: SelfSignalKind::Cron,
                    effect: SelfSignalEffect::Mutate,
                    anchored_to: SignalAnchor::Event {
                        event: "host dreamer.run_task request".to_string(),
                    },
                    cadence: Some(SignalCadence::Derived {
                        source: "host dreamer.tasks.classify-memories.schedule".to_string(),
                    }),
                    domain: Some(PROVIDER_USAGE_DOMAIN.to_string()),
                    note: Some("host-scheduled; the module does not own the interval".to_string()),
                },
            ],
        }
    }
}

/// The external surface the runner-backed behaviors shape: the user's provider quota.
pub const PROVIDER_USAGE_DOMAIN: &str = "provider-usage";

/// Self-signals for the manifest under the resolved runner configuration. They come from
/// the same registry that opens routes and fills `consumes`, so a host-runner
/// configuration drops them together with the background-completion target, not the optional
/// provider runner target. An empty list still means
/// "examined, none to register".
pub fn self_signals(config: &RouteTargetConfig) -> Vec<SelfSignalDeclaration> {
    RegisteredRoute::ALL
        .iter()
        .filter(|route| route.module_id(config).is_some())
        .flat_map(|route| route.self_signals())
        .collect()
}

/// Module ids this module may open a route to under the resolved runner configuration.
pub fn route_targets(config: &RouteTargetConfig) -> Vec<String> {
    let mut targets = Vec::new();
    for module_id in RegisteredRoute::ALL
        .iter()
        .filter_map(|route| route.module_id(config))
    {
        if !targets.iter().any(|target| target == module_id) {
            targets.push(module_id.to_string());
        }
    }
    targets
}

/// A real test caller opens MC's incoming tool route, not one of MC's consumed
/// runner/gateway routes. Keep the wire construction here without advertising
/// a production self-consume edge.
#[cfg(test)]
pub(crate) fn catalog_provider_target_for_test() -> RouteTarget {
    RouteTarget::ToolProvider {
        module_id: crate::DEFAULT_MODULE_ID.to_string(),
    }
}

/// Inbound app binds are fixtures, not routes this module consumes.
#[cfg(test)]
pub(crate) fn app_read_target_for_test(module_id: &str) -> RouteTarget {
    RouteTarget::InternalService {
        module_id: module_id.to_string(),
        service_id: crate::app_read::SERVICE_ID.to_string(),
    }
}

#[cfg(test)]
pub(crate) fn expected_routes_for_tests(runner: &str) -> Vec<String> {
    let routes = vec![
        "engram",
        "thalamus",
        runner,
        "fusiform",
        "ckbus",
        "entorhinal",
        "synapse",
    ];
    routes.into_iter().map(str::to_owned).collect()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use super::*;

    #[test]
    fn every_session_runner_module_gets_its_own_route() {
        for module in ["thalamus-harness", "broca", "thalamus"] {
            let principal = subc_protocol::Principal::Reserved {
                module_id: module.into(),
            };
            let route = SessionRunnerRoute::for_principal(Some(&principal), "s")
                .unwrap_or_else(|| panic!("{module} is a session runner"));
            assert_eq!(route.module_id(), module);
            assert_eq!(
                route.target(),
                RouteTarget::ManagementSurface {
                    module_id: module.into()
                }
            );
        }
        let other = subc_protocol::Principal::Reserved {
            module_id: "fusiform".into(),
        };
        assert!(SessionRunnerRoute::for_principal(Some(&other), "s").is_none());
    }

    #[test]
    fn route_targets_follow_the_resolved_runner() {
        assert_eq!(
            route_targets(&RouteTargetConfig::default()),
            expected_routes_for_tests("broca")
        );
        assert_eq!(
            route_targets(&RouteTargetConfig::runner_module("custom-runner")),
            expected_routes_for_tests("custom-runner")
        );
        assert_eq!(
            route_targets(&RouteTargetConfig::host_runner()),
            expected_routes_for_tests("broca")
        );
    }

    #[test]
    fn provider_runner_target_is_static_and_spends_no_quota() {
        for (config, expected) in [
            (RouteTargetConfig::default(), "broca"),
            (
                RouteTargetConfig::runner_module("scripted-runner"),
                "scripted-runner",
            ),
            (RouteTargetConfig::host_runner(), "broca"),
            (
                RouteTargetConfig::host_runner().with_provider_runner_module("scripted-runner"),
                "scripted-runner",
            ),
        ] {
            assert_eq!(
                config.target(RegisteredRoute::ProviderRunner),
                Some(RouteTarget::ManagementSurface {
                    module_id: expected.to_string()
                }),
                "{config:?}"
            );
            assert!(RegisteredRoute::ProviderRunner.self_signals().is_empty());
        }
        let host = RouteTargetConfig::host_runner().with_provider_runner_module("scripted-runner");
        assert_eq!(
            route_targets(&host),
            expected_routes_for_tests("scripted-runner")
        );
        assert!(host.target(RegisteredRoute::HistorianRunner).is_none());
        assert!(self_signals(&host).is_empty());
    }

    #[test]
    fn fusiform_catalog_is_a_static_read_only_tool_provider_route() {
        let config = RouteTargetConfig::host_runner();
        assert_eq!(
            config.target(RegisteredRoute::FusiformCatalog),
            Some(RouteTarget::ToolProvider {
                module_id: "fusiform".to_string()
            })
        );
        assert!(RegisteredRoute::FusiformCatalog.self_signals().is_empty());
        assert!(route_targets(&config).contains(&"fusiform".to_string()));
    }

    #[test]
    fn entorhinal_lookup_is_a_read_only_management_route() {
        let config = RouteTargetConfig::host_runner();
        assert_eq!(
            config.target(RegisteredRoute::EntorhinalResolve),
            Some(RouteTarget::ManagementSurface {
                module_id: "entorhinal".to_string()
            })
        );
        assert!(RegisteredRoute::EntorhinalResolve.self_signals().is_empty());
        let manifest = crate::manifest_with_route_targets(crate::DEFAULT_MODULE_ID, &config);
        let capabilities = manifest
            .capabilities
            .expect("provider roles remain declared");
        assert_eq!(
            capabilities.provides,
            vec![
                cortexkit_role_compaction_provider::PROVIDES.to_string(),
                crate::MCP_CONVERSATION_BINDING_V1.to_string(),
                subc_protocol::scope::FLOW_SCOPES_CAPABILITY.to_string(),
            ]
        );
        assert!(capabilities.requires.is_empty());
        assert!(capabilities.must_never_reach.is_empty());
        assert!(manifest.consumes.iter().any(|role| matches!(role,
            subc_protocol::manifest::ConsumerRole::ServiceClient { of } if of.iter().any(|module| module == "entorhinal")
        )));
    }

    #[test]
    fn self_signals_follow_the_resolved_runner_target() {
        let names = |config: &RouteTargetConfig| {
            self_signals(config)
                .into_iter()
                .map(|signal| signal.name)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            names(&RouteTargetConfig::default()),
            ["historian_firing", "dreamer_classify"]
        );
        assert_eq!(
            names(&RouteTargetConfig::runner_module("custom-runner")),
            ["historian_firing", "dreamer_classify"]
        );
        assert!(names(&RouteTargetConfig::host_runner()).is_empty());
    }

    /// Hosting completions still needs no background runner, even though an optional
    /// provider runner route is declared for callbacks and transcript reads.
    #[test]
    fn a_host_runner_declares_no_completion_route_and_no_quota_signals() {
        let hosted = RouteTargetConfig::for_historian_runner(HistorianRunnerKind::Host);
        assert_eq!(hosted, RouteTargetConfig::host_runner());
        assert!(self_signals(&hosted).is_empty());
        assert!(hosted.target(RegisteredRoute::HistorianRunner).is_none());
        assert!(hosted.target(RegisteredRoute::ProviderRunner).is_some());
        let broca = RouteTargetConfig::for_historian_runner(HistorianRunnerKind::Broca);
        assert_eq!(broca, RouteTargetConfig::default());
        assert_eq!(self_signals(&broca).len(), 2);
    }

    /// Drift guard for the per-harness default: the manifest is built once per
    /// process, before any request says which harness it comes from. With nothing
    /// configured a Claude Code request still routes to Broca, so the Broca edge and
    /// its quota signals stay declared. Only a configuration that sends both background roles
    /// to the host drops their route and signals; the optional provider route stays available.
    #[test]
    fn the_completion_route_is_dropped_only_when_both_roles_are_configured_to_the_host() {
        use HistorianRunnerKind::{Broca, Host};
        let cases = [
            (None, None, true),
            (Some(Host), None, true),
            (None, Some(Host), true),
            (Some(Host), Some(Broca), true),
            (Some(Broca), Some(Host), true),
            (Some(Broca), Some(Broca), true),
            (Some(Host), Some(Host), false),
        ];
        for (historian, dreamer, keeps_completion_route) in cases {
            let config =
                RouteTargetConfig::for_configured_runners(ConfiguredRunners { historian, dreamer });
            let label = format!("historian={historian:?} dreamer={dreamer:?}");
            assert_eq!(
                config.target(RegisteredRoute::HistorianRunner).is_some(),
                keeps_completion_route,
                "{label}"
            );
            assert_eq!(
                route_targets(&config),
                expected_routes_for_tests("broca"),
                "{label}: provider runner remains an optional target"
            );
            assert_eq!(
                self_signals(&config).len(),
                if keeps_completion_route { 2 } else { 0 },
                "{label}"
            );
        }
    }

    /// The end-to-end form of the same guard: a user config file on disk, read the
    /// way `main` reads it, produces the manifest edges the test above expects.
    #[test]
    fn the_manifest_edges_follow_the_user_config_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("magic-context.jsonc");
        let edges = |path: &Path| {
            route_targets(&RouteTargetConfig::for_configured_runners(
                crate::config::user_configured_runners_at(path),
            ))
        };
        assert!(
            edges(&path).contains(&DEFAULT_RUNNER_MODULE_ID.to_string()),
            "no config: Claude Code still needs Broca"
        );
        fs::write(&path, r#"{ "historian": { "runner": "host" } }"#).expect("write");
        assert_eq!(edges(&path), expected_routes_for_tests("broca"));
        let hosted = RouteTargetConfig::for_configured_runners(
            crate::config::user_configured_runners_at(&path),
        );
        assert!(hosted.target(RegisteredRoute::HistorianRunner).is_none());
        assert!(self_signals(&hosted).is_empty());
        fs::write(
            &path,
            r#"{ "historian": { "runner": "host" }, "dreamer": { "runner": "broca" } }"#,
        )
        .expect("write");
        assert!(edges(&path).contains(&DEFAULT_RUNNER_MODULE_ID.to_string()));
    }

    #[test]
    fn every_self_signal_rides_a_consumed_route() {
        for config in [
            RouteTargetConfig::default(),
            RouteTargetConfig::runner_module("custom-runner"),
            RouteTargetConfig::host_runner(),
        ] {
            let consumed = route_targets(&config);
            let declared = self_signals(&config);
            let mut expected = Vec::new();
            for route in RegisteredRoute::ALL {
                match route.module_id(&config) {
                    Some(module_id) => {
                        assert!(consumed.iter().any(|target| target == module_id));
                        expected.extend(route.self_signals());
                    }
                    None => {
                        for signal in route.self_signals() {
                            assert!(
                                !declared.contains(&signal),
                                "{route:?} is unresolved but {} is declared",
                                signal.name
                            );
                        }
                    }
                }
            }
            assert_eq!(declared, expected, "{config:?}");
            for signal in &declared {
                assert!(signal.domain.is_some(), "{} names no domain", signal.name);
            }
        }
    }

    #[test]
    fn every_registered_route_target_is_declared_consumed() {
        for config in [
            RouteTargetConfig::default(),
            RouteTargetConfig::runner_module("custom-runner"),
            RouteTargetConfig::host_runner(),
        ] {
            let consumed = route_targets(&config);
            for route in RegisteredRoute::ALL {
                let Some(target) = config.target(route) else {
                    continue;
                };
                let module_id = match target {
                    RouteTarget::ManagementSurface { module_id } => module_id,
                    RouteTarget::ToolProvider { module_id } => {
                        assert_eq!(route, RegisteredRoute::FusiformCatalog);
                        module_id
                    }
                    RouteTarget::InternalService {
                        module_id,
                        service_id,
                    } => {
                        match route {
                            RegisteredRoute::EngramDoor => assert_eq!(service_id, "session-door"),
                            RegisteredRoute::EngramDeviceStreams => {
                                assert_eq!(service_id, "device-streams")
                            }
                            _ => panic!("unexpected internal service route {route:?}"),
                        }
                        module_id
                    }
                };
                assert!(
                    consumed.contains(&module_id),
                    "{route:?} target {module_id:?} is absent from route_targets()"
                );
            }
        }
    }

    #[test]
    fn route_open_constructions_are_confined_to_the_registry() {
        fn visit(path: &Path, offenders: &mut Vec<String>) {
            for entry in fs::read_dir(path).expect("read source directory") {
                let entry = entry.expect("read source entry");
                let path = entry.path();
                if path.is_dir() {
                    visit(&path, offenders);
                    continue;
                }
                if path.extension().and_then(|value| value.to_str()) != Some("rs")
                    || path.file_name().and_then(|value| value.to_str()) == Some("route_targets.rs")
                {
                    continue;
                }
                let source = fs::read_to_string(&path).expect("read Rust source");
                // Matching an existing RouteTarget does not open a route. Check
                // expressions that construct new targets, not match patterns.
                struct Constructors(bool);
                impl<'ast> syn::visit::Visit<'ast> for Constructors {
                    fn visit_expr_struct(&mut self, node: &'ast syn::ExprStruct) {
                        if node.path.segments.iter().any(|s| s.ident == "RouteTarget") {
                            self.0 = true;
                        }
                        syn::visit::visit_expr_struct(self, node);
                    }
                }
                if path
                    .file_name()
                    .and_then(|v| v.to_str())
                    .is_some_and(|name| name == "tests.rs" || name.ends_with("_tests.rs"))
                {
                    continue;
                }
                let parsed = syn::parse_file(&source).expect("parse Rust route constructors");
                let mut constructors = Constructors(false);
                syn::visit::Visit::visit_file(&mut constructors, &parsed);
                if constructors.0 {
                    offenders.push(
                        path.strip_prefix(env!("CARGO_MANIFEST_DIR"))
                            .unwrap_or(&path)
                            .display()
                            .to_string(),
                    );
                }
            }
        }

        let mut offenders = Vec::new();
        visit(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut offenders,
        );
        assert!(
            offenders.is_empty(),
            "route targets must be registered before opening: {offenders:?}"
        );
    }
}
