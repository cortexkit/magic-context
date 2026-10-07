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
    ProviderRunner,
}

impl RegisteredRoute {
    const ALL: [Self; 3] = [
        Self::SessionResolve,
        Self::HistorianRunner,
        Self::ProviderRunner,
    ];

    fn module_id(self, config: &RouteTargetConfig) -> Option<&str> {
        match self {
            Self::SessionResolve => Some(DEFAULT_THALAMUS_MODULE_ID),
            Self::HistorianRunner => config.runner_module_id(),
            Self::ProviderRunner => Some(config.provider_runner_module_id()),
        }
    }

    /// Behaviors that run through this route and change an external surface, declared
    /// in the manifest only while the route resolves to a module. The match is
    /// exhaustive so a new route has to state its own behaviors here.
    fn self_signals(self) -> Vec<SelfSignalDeclaration> {
        match self {
            // A lookup on the session registry: it spends nothing and shapes no surface.
            Self::SessionResolve => Vec::new(),
            // Callbacks and transcript reads spend no provider quota. Declaring this target
            // does not open a connection or require the runner to be registered at startup.
            Self::ProviderRunner => Vec::new(),
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
            vec!["thalamus".to_string(), "broca".to_string()]
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
        assert_eq!(route_targets(&host), vec!["thalamus", "scripted-runner"]);
        assert!(host.target(RegisteredRoute::HistorianRunner).is_none());
        assert!(self_signals(&host).is_empty());
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
                vec!["thalamus".to_string(), "broca".to_string()],
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
        assert_eq!(
            edges(&path),
            vec!["thalamus".to_string(), "broca".to_string()]
        );
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

    /// Run after building ck-mc and ck-subc from the workspace and Cargo.lock's subc revision
    /// into the workspace's debug target directory. No installed daemon or runner is used.
    /// ServiceClient declares possible route targets; unlike required capabilities, it
    /// must not make startup, health, tools, or host completions depend on Broca.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires the workspace's ck-mc and ck-subc debug binaries"]
    async fn a_host_runner_starts_and_serves_without_broca_through_real_subc() {
        use std::process::{Child, Command, Stdio};
        use std::time::Duration;

        use serde_json::{json, Value};
        use subc_client_rs::{CallOptions, ConsumerOptions, SubcConsumer};
        use subc_protocol::BindIdentity;

        struct Process(Child);
        impl Drop for Process {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        async fn call(consumer: &SubcConsumer, identity: &BindIdentity, request: Value) -> Value {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
            loop {
                let result = consumer
                    .call(
                        RouteTarget::ToolProvider {
                            module_id: crate::DEFAULT_MODULE_ID.to_string(),
                        },
                        identity.clone(),
                        serde_json::to_vec(&request).unwrap(),
                        CallOptions {
                            timeout: Duration::from_secs(60),
                            ..CallOptions::default()
                        },
                    )
                    .await;
                match result {
                    Ok(bytes) => return serde_json::from_slice(&bytes).unwrap(),
                    Err(error)
                        if error.code() == Some("store_opening")
                            && tokio::time::Instant::now() < deadline =>
                    {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                    Err(error) => panic!(
                        "{}: {error:?}",
                        request["kind"]
                            .as_str()
                            .or(request["method"].as_str())
                            .or(request["name"].as_str())
                            .unwrap_or("call")
                    ),
                }
            }
        }

        let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        let target = std::env::var_os("CARGO_TARGET_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| workspace.join("target"));
        let binaries = target.join("debug");
        for name in ["ck-subc", "ck-mc"] {
            assert!(
                binaries.join(name).is_file(),
                "build {name} before running this test"
            );
        }
        let dir = tempfile::tempdir_in(&target).unwrap();
        let root = dir.path();
        for name in ["config/cortexkit", "data", "runtime", "project"] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        fs::write(
            root.join("config/cortexkit/subc.jsonc"),
            r#"{"version":1,"modules":{}}"#,
        )
        .unwrap();
        fs::write(
            root.join("config/cortexkit/magic-context.jsonc"),
            r#"{
            "historian":{"runner":"host","protected_tokens":0},
            "dreamer":{"runner":"host"}
        }"#,
        )
        .unwrap();
        // A fresh Rust-mode installation provisions context.db through the public CLI,
        // independently of any running host or runner module.
        let provisioned = Command::new("bun")
            .args([
                "run",
                "packages/cli/src/index.ts",
                "doctor",
                "store",
                "init",
            ])
            .current_dir(workspace)
            .env("HOME", root.join("config"))
            .env("XDG_CONFIG_HOME", root.join("config"))
            .env("XDG_DATA_HOME", root.join("data"))
            .env_remove("MAGIC_CONTEXT_TEST_DATA_DIR")
            .env_remove("MAGIC_CONTEXT_STORAGE_DIR")
            .output()
            .unwrap();
        assert!(
            provisioned.status.success(),
            "store init failed: {} {}",
            String::from_utf8_lossy(&provisioned.stdout),
            String::from_utf8_lossy(&provisioned.stderr)
        );
        let command = |name: &str| {
            let mut command = Command::new(binaries.join(name));
            command
                .current_dir(workspace)
                .env("XDG_CONFIG_HOME", root.join("config"))
                .env("XDG_DATA_HOME", root.join("data"))
                .env("XDG_RUNTIME_DIR", root.join("runtime"))
                .env("HOME", root.join("config"))
                .env_remove("MAGIC_CONTEXT_TEST_DATA_DIR")
                .env_remove("MAGIC_CONTEXT_STORAGE_DIR")
                .env_remove(subc_protocol::SUBC_MODULE_ID_ENV)
                .env_remove(subc_protocol::SUBC_LAUNCH_NONCE_ENV)
                .env_remove(subc_os::LAUNCH_NONCE_FD_ENV)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit());
            command
        };
        let mut daemon = Process(
            command("ck-subc")
                .env("SUBC_PORT", "0")
                .env("SUBC_CGROUP_PLACEMENT", "disabled")
                .spawn()
                .unwrap(),
        );
        let connection_file = root.join("runtime/subc-connection.json");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        while !connection_file.is_file() {
            assert!(
                daemon.0.try_wait().unwrap().is_none(),
                "daemon exited before startup"
            );
            assert!(
                tokio::time::Instant::now() < deadline,
                "daemon did not start"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let mut module = Process(
            command("ck-mc")
                .arg("--subc")
                .arg(&connection_file)
                .spawn()
                .unwrap(),
        );
        let consumer = SubcConsumer::connect(&connection_file, ConsumerOptions::default())
            .await
            .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        let registered = loop {
            let catalog = consumer.catalog_list().await.unwrap();
            if let Some(module) = catalog
                .modules
                .iter()
                .find(|module| module.module_id == crate::DEFAULT_MODULE_ID)
            {
                assert_eq!(
                    catalog.modules.len(),
                    1,
                    "no runner or gateway may be registered"
                );
                break module.clone();
            }
            assert!(
                module.0.try_wait().unwrap().is_none(),
                "ck-mc exited before registering"
            );
            assert!(
                tokio::time::Instant::now() < deadline,
                "ck-mc did not register without Broca"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert!(registered.ready, "{registered:?}");
        assert!(registered.not_ready.is_none(), "{registered:?}");
        assert_eq!(registered.self_signals, Some(vec![]));
        assert!(
            registered.capabilities.is_none(),
            "no required runner capability"
        );
        let identity = BindIdentity::new(
            fs::canonicalize(root.join("project")).unwrap(),
            "opencode",
            "ses",
        );
        let tools = call(
            &consumer,
            &identity,
            json!({"name":"tool.catalog","arguments":{"preset":"head"}}),
        )
        .await;
        assert!(
            tools["tools"]
                .as_array()
                .is_some_and(|tools| !tools.is_empty()),
            "{tools}"
        );
        // HELLO can precede the asynchronous store open. Wait for actual readiness,
        // not just registration, before exercising the transform and historian.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        loop {
            let health = call(
                &consumer,
                &identity,
                json!({"kind":"health","session_id":"ses"}),
            )
            .await;
            if health["store_open"] == true {
                assert_eq!(health["ok"], true, "{health}");
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "store did not open: {health}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let transformed = call(
            &consumer,
            &identity,
            crate::tests::request(crate::tests::big_messages()),
        )
        .await;
        assert_eq!(transformed["status"], "ok", "{transformed}");
        assert_eq!(transformed["historian"]["fired"], true, "{transformed}");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let run = loop {
            let pending = call(
                &consumer,
                &identity,
                json!({"method":"historian.pending","v":1}),
            )
            .await;
            if let Some(run) = pending["runs"].as_array().and_then(|runs| runs.first()) {
                break run.clone();
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "host historian did not queue work: {pending}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let claimed = call(
            &consumer,
            &identity,
            json!({"method":"historian.claim","v":1,
            "run_id":run["run_id"],"claimant_instance_id":"runner-route-test"}),
        )
        .await;
        assert_eq!(claimed["ok"], true, "{claimed}");
        let completed = call(&consumer, &identity, json!({"method":"historian.complete","v":1,
            "run_id":run["run_id"],"token":claimed["token"],"output":{
                "text":crate::tests::historian_output_for_prompt(claimed["prompt"]["user"].as_str().unwrap()),
                "length_capped":false}})).await;
        assert_eq!(completed["ok"], true, "{completed}");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let status = call(
                &consumer,
                &identity,
                json!({"method":"session.status","v":1,"session_id":"ses"}),
            )
            .await;
            assert_eq!(status["historian"]["runner"]["runner"], "host", "{status}");
            if status["compartment_count"].as_u64().unwrap() > 0 {
                assert!(status["historian"]["last_failure"].is_null(), "{status}");
                assert_eq!(
                    status["historian"]["publish_health_degraded"], false,
                    "{status}"
                );
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "host historian did not finish: {status}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let health = call(
            &consumer,
            &identity,
            json!({"kind":"health","session_id":"ses"}),
        )
        .await;
        assert_eq!(health["ok"], true, "{health}");
        assert_eq!(health["store_open"], true, "{health}");
        assert_eq!(consumer.catalog_list().await.unwrap().modules.len(), 1);
        assert!(
            module.0.try_wait().unwrap().is_none(),
            "ck-mc must keep serving without Broca"
        );
        consumer.close().await;
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
