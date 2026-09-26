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

/// Runtime selection for module routes. A hosted historian runner has no cross-module target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteTargetConfig {
    runner_module_id: Option<String>,
}

impl Default for RouteTargetConfig {
    fn default() -> Self {
        Self::runner_module(DEFAULT_RUNNER_MODULE_ID)
    }
}

impl RouteTargetConfig {
    pub fn runner_module(module_id: impl Into<String>) -> Self {
        Self {
            runner_module_id: Some(module_id.into()),
        }
    }

    /// Select the host-owned runner path. The module must not advertise Broca in this mode.
    pub fn host_runner() -> Self {
        Self {
            runner_module_id: None,
        }
    }

    /// The route selection a resolved historian runner implies: Broca's route for
    /// the Broca runner, no runner route at all for the host runner.
    pub fn for_historian_runner(runner: HistorianRunnerKind) -> Self {
        match runner {
            HistorianRunnerKind::Broca => Self::default(),
            HistorianRunnerKind::Host => Self::host_runner(),
        }
    }

    /// The route selection the user tier's runner settings imply for the whole
    /// process. A role left unconfigured is decided per request by the harness, and
    /// a Claude Code request with nothing configured goes to Broca, so the Broca
    /// route stays declared unless every role that uses it is configured to the host
    /// runner.
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

    pub(crate) fn target(&self, route: RegisteredRoute) -> Option<RouteTarget> {
        route
            .module_id(self)
            .map(|module_id| RouteTarget::ManagementSurface {
                module_id: module_id.to_string(),
            })
    }
}

/// Every route-opening purpose in this crate. Callers must select one of these instead of
/// constructing a `RouteTarget` directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RegisteredRoute {
    SessionResolve,
    HistorianRunner,
}

impl RegisteredRoute {
    const ALL: [Self; 2] = [Self::SessionResolve, Self::HistorianRunner];

    fn module_id(self, config: &RouteTargetConfig) -> Option<&str> {
        match self {
            Self::SessionResolve => Some(DEFAULT_THALAMUS_MODULE_ID),
            Self::HistorianRunner => config.runner_module_id(),
        }
    }

    /// Behaviors that run through this route and change an external surface, declared
    /// in the manifest only while the route resolves to a module. The match is
    /// exhaustive so a new route has to state its own behaviors here.
    fn self_signals(self) -> Vec<SelfSignalDeclaration> {
        match self {
            // A lookup on the session registry: it spends nothing and shapes no surface.
            Self::SessionResolve => Vec::new(),
            // The runner route carries every model call this module makes, so both
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
/// configuration drops them together with the runner target. An empty list still means
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

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use super::*;

    #[test]
    fn route_targets_follow_the_resolved_runner() {
        assert_eq!(
            route_targets(&RouteTargetConfig::default()),
            vec!["thalamus".to_string(), "broca".to_string()]
        );
        assert_eq!(
            route_targets(&RouteTargetConfig::runner_module("custom-runner")),
            vec!["thalamus".to_string(), "custom-runner".to_string()]
        );
        assert_eq!(
            route_targets(&RouteTargetConfig::host_runner()),
            vec!["thalamus".to_string()]
        );
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

    /// Drift guard: a route's behaviors are declared exactly while its target is
    /// declared consumed, and every declaration names the surface it shapes.
    #[test]
    fn a_host_runner_declares_no_runner_route_and_no_quota_signals() {
        let hosted = RouteTargetConfig::for_historian_runner(HistorianRunnerKind::Host);
        assert_eq!(hosted, RouteTargetConfig::host_runner());
        assert!(self_signals(&hosted).is_empty());
        assert!(!route_targets(&hosted).contains(&DEFAULT_RUNNER_MODULE_ID.to_string()));
        let broca = RouteTargetConfig::for_historian_runner(HistorianRunnerKind::Broca);
        assert_eq!(broca, RouteTargetConfig::default());
        assert_eq!(self_signals(&broca).len(), 2);
    }

    /// Drift guard for the per-harness default: the manifest is built once per
    /// process, before any request says which harness it comes from. With nothing
    /// configured a Claude Code request still routes to Broca, so the Broca edge and
    /// its quota signals stay declared. Only a configuration that sends every role
    /// to the host drops them, and a configuration that keeps either role on Broca
    /// keeps them.
    #[test]
    fn the_broca_edge_is_dropped_only_when_every_role_is_configured_to_the_host() {
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
        for (historian, dreamer, keeps_broca) in cases {
            let config =
                RouteTargetConfig::for_configured_runners(ConfiguredRunners { historian, dreamer });
            let label = format!("historian={historian:?} dreamer={dreamer:?}");
            assert_eq!(
                route_targets(&config).contains(&DEFAULT_RUNNER_MODULE_ID.to_string()),
                keeps_broca,
                "{label}"
            );
            assert_eq!(
                self_signals(&config).len(),
                if keeps_broca { 2 } else { 0 },
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
        assert_eq!(edges(&path), vec!["thalamus".to_string()]);
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
                let RouteTarget::ManagementSurface { module_id } = target else {
                    panic!("registered module routes must use the management surface");
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
                if source.contains("RouteTarget::") {
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
