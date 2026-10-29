//! Exercise production clients against a framed daemon and the routing/v1 and
//! llm-runner/v1 interfaces.

use super::*;
use crate::dream_dispatch::routed::wire::ProductionWire;
use crate::historian_routed::{SubcSummaryRouting, SummaryRouting, SummaryScope};
use crate::route_targets::RouteTargetConfig;
use subc_client_rs::{serve_with_handle, ModuleHandler};
use subc_protocol::{BindIdentity, Flags, Frame, FrameType, ModuleHelloAckBody, Priority};
use subc_transport::{
    auth::authenticate_server,
    connection_file::{
        generate_daemon_id, generate_key, write_atomic, ConnectionInfo, Endpoint, SCHEMA_VERSION,
    },
    frame_io::{read_frame, write_frame},
};
use tokio::net::{TcpListener, TcpStream};

#[derive(Default)]
struct DaemonState {
    scopes: HashMap<String, subc_protocol::scope::ScopeRecord>,
    snapshots: Vec<Value>,
    opens: Vec<Value>,
    calls: Vec<Value>,
    generation: u64,
    catalog_generation: u64,
    providers: Vec<String>,
    refuse_sync: bool,
    scope_error: Option<String>,
    refuse_open: bool,
    hold_control: bool,
    via: String,
}

struct Daemon {
    connection: PathBuf,
    state: Arc<Mutex<DaemonState>>,
    task: tokio::task::JoinHandle<()>,
    _root: tempfile::TempDir,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn reply(stream: &mut TcpStream, request: &Frame, ty: FrameType, body: Value) -> bool {
    let response = Frame::build(
        ty,
        Flags::new(false, Priority::Interactive, false),
        request.header.channel,
        request.header.epoch,
        request.header.corr,
        serde_json::to_vec(&body).unwrap(),
    )
    .unwrap();
    write_frame(stream, &response).await.is_ok()
}

async fn socket(mut stream: TcpStream, state: Arc<Mutex<DaemonState>>, fake: Arc<FakeWire>) {
    let mut routes: HashMap<
        u16,
        (
            String,
            BindIdentity,
            Option<subc_protocol::scope::ScopeSelector>,
        ),
    > = HashMap::new();
    while let Ok(Some(frame)) = read_frame(&mut stream).await {
        if frame.header.ty == FrameType::Hello {
            let ack = ModuleHelloAckBody {
                negotiated_ver: subc_protocol::PROTOCOL_VERSION,
                subc_ops: vec!["scope.sync".into()],
                subc_capabilities: vec!["scope-workdir/v1".into()],
                storage: None,
                machine_id: None,
            };
            if !reply(
                &mut stream,
                &frame,
                FrameType::HelloAck,
                serde_json::to_value(ack).unwrap(),
            )
            .await
            {
                break;
            }
            continue;
        }
        if frame.header.ty != FrameType::Request {
            continue;
        }
        let body: Value = serde_json::from_slice(&frame.body).unwrap();
        if frame.header.channel == 0 {
            let (ty, answer) = {
                let mut s = state.lock().unwrap();
                match body["op"].as_str().unwrap() {
                    "scope.sync" if s.refuse_sync => (
                        FrameType::Error,
                        json!({"code":s.scope_error.as_deref().unwrap_or("scope_sync_not_authority"), "message":"not the launched owner"}),
                    ),
                    "scope.sync" => {
                        let generation = body["generation"].as_u64().unwrap();
                        assert!(generation > s.generation);
                        s.generation = generation;
                        s.snapshots.push(body.clone());
                        let records: Vec<subc_protocol::scope::ScopeRecord> =
                            serde_json::from_value(body["scopes"].clone()).unwrap();
                        let next: HashMap<_, _> = records
                            .into_iter()
                            .map(|r| (r.scope_ref.clone(), r))
                            .collect();
                        let ended: Vec<_> = s
                            .scopes
                            .values()
                            .filter(|r| !next.contains_key(&r.scope_ref))
                            .map(|r| json!({"ref": r.scope_ref, "scope_epoch":r.scope_epoch}))
                            .collect();
                        let results: Vec<_> = next.values().map(|r| {
                            if let Some(code) = &s.scope_error { json!({"ref":r.scope_ref,"scope_epoch":r.scope_epoch,"outcome":"refused","code":code,"message":"record refused"}) } else { json!({"ref":r.scope_ref,"scope_epoch":r.scope_epoch,"outcome":"created","version":1}) }
                        }).collect();
                        if s.scope_error.is_none() {
                            s.scopes = next;
                        }
                        (
                            FrameType::Response,
                            json!({"op":"scope.sync", "generation":generation,"results":results,"ended":ended}),
                        )
                    }
                    "catalog.list" => {
                        let mut modules: Vec<_> = s
                            .providers
                            .iter()
                            .map(|id| {
                                subc_control::CatalogEntry::new(id, vec![], vec![])
                                    .with_capabilities(Some(
                                        subc_protocol::manifest::CapabilityDeclarations {
                                            provides: vec![
                                                cortexkit_role_routing::PROVIDES.into(),
                                                "scope-workdir/v1".into(),
                                            ],
                                            requires: vec![],
                                            must_never_reach: vec![],
                                        },
                                    ))
                                    .with_ready(true)
                            })
                            .collect();
                        modules.push(
                            subc_control::CatalogEntry::new("magic-context", vec![], vec![])
                                .with_capabilities(Some(
                                    subc_protocol::manifest::CapabilityDeclarations {
                                        provides: vec![
                                            "mc.memory/v1".into(),
                                            "mc.search/v1".into(),
                                        ],
                                        requires: vec![],
                                        must_never_reach: vec![],
                                    },
                                ))
                                .with_ready(true),
                        );
                        (
                            FrameType::Response,
                            serde_json::to_value(
                                subc_control::ClientControlResponse::CatalogList {
                                    generation: s.catalog_generation,
                                    modules,
                                    subc_ops: vec![],
                                },
                            )
                            .unwrap(),
                        )
                    }
                    "route.open" if s.refuse_open => (
                        FrameType::Error,
                        json!({"code":"scope_not_carrier","message":"not admitted"}),
                    ),
                    "route.open" => {
                        s.opens.push(body.clone());
                        let channel = 10 + routes.len() as u16;
                        let module = body["target"]["module_id"].as_str().unwrap().to_owned();
                        routes.insert(
                            channel,
                            (
                                module,
                                serde_json::from_value(body["identity"].clone()).unwrap(),
                                body.get("scope")
                                    .filter(|v| !v.is_null())
                                    .map(|v| serde_json::from_value(v.clone()).unwrap()),
                            ),
                        );
                        (
                            FrameType::Response,
                            json!({"op":"route.open","route_channel":channel,"route_epoch":1}),
                        )
                    }
                    other => panic!("unexpected control {other}: {body}"),
                }
            };
            if !reply(&mut stream, &frame, ty, answer).await {
                break;
            }
            continue;
        }
        let (module, identity, selector) = routes.get(&frame.header.channel).unwrap().clone();
        let routing_module = module == PROVIDER;
        let method = body["method"].as_str().unwrap();
        state.lock().unwrap().calls.push(body.clone());
        if method == "resolve" {
            assert_eq!(
                body["params"]["canonicalRoot"],
                json!(identity.project_root)
            );
            let via = state.lock().unwrap().via.clone();
            let id = if via == "implicit" {
                "pj-implicit1-placeholder"
            } else {
                ENTORHINAL_ID
            };
            if !reply(&mut stream, &frame, FrameType::Response, json!({"projectId":id,"via":via,"canonicalRoot":identity.project_root,"gone":false,"generation":1})).await { break; }
            continue;
        }
        let selector = selector.expect("routed work must carry a scope selector");
        let record = state
            .lock()
            .unwrap()
            .scopes
            .get(&selector.scope_ref)
            .cloned()
            .unwrap_or_else(|| {
                let mut scope = DreamScope::new(
                    EntorhinalProjectId::from_lookup_answer(ENTORHINAL_ID).unwrap(),
                    &identity.project_root,
                );
                scope.record.scope_ref = selector.scope_ref.clone();
                scope.record
            });
        let scope = DreamScope {
            project_id: EntorhinalProjectId::from_lookup_answer(
                record.project_id.as_deref().unwrap(),
            )
            .unwrap(),
            workdir: PathBuf::from(record.workdir.as_ref().unwrap()),
            record,
        };
        let result: Result<Value, PortError> = if routing_module {
            match method {
                "role.describe" => {
                    let mut describe =
                        cortexkit_role_routing::describe::RoleDescribe::new(vec![], false);
                    if state.lock().unwrap().hold_control {
                        describe = describe.with_capability(
                            cortexkit_role_routing::capabilities::SELECT_HOLD_CONTROL,
                        );
                    }
                    Ok(serde_json::to_value(describe).unwrap())
                }
                "route.select" => {
                    let request: SelectRequest =
                        serde_json::from_value(body["params"].clone()).unwrap();
                    assert!(
                        request.hold_ok.is_none() || state.lock().unwrap().hold_control,
                        "hold_ok sent without a declaration"
                    );
                    fake.select(&scope, PROVIDER, &request)
                        .await
                        .map(|mut answer| {
                            if let Some(tokens) = request.requirements.max_output_tokens {
                                answer["max_output_tokens"] = json!(tokens);
                            }
                            answer
                        })
                        .map_err(|e| refused(&e.code.to_string(), Value::Null))
                }
                "route.report" => fake
                    .report(
                        &scope,
                        PROVIDER,
                        &serde_json::from_value(body["params"].clone()).unwrap(),
                    )
                    .await
                    .map(|r| serde_json::to_value(r).unwrap())
                    .map_err(|e| refused(&e.code.to_string(), Value::Null)),
                other => panic!("unexpected routing op {other}"),
            }
        } else {
            let bind = RunnerBind {
                module,
                harness: identity.harness.clone(),
                session: identity.session.clone(),
            };
            if method == "session.subscribe" {
                assert_eq!(body["params"], json!({"from":"start"}));
                while let Some(unit) = fake.runner_next_unit(&scope, &bind).await.unwrap() {
                    assert!(reply(&mut stream, &frame, FrameType::StreamData, unit).await);
                }
                if !reply(
                    &mut stream,
                    &frame,
                    FrameType::StreamData,
                    json!({"kind":"control"}),
                )
                .await
                {
                    break;
                }
                continue;
            }
            fake.runner_call(&scope, &bind, method, body["params"].clone())
                .await
        };
        let (ty, value) = match result {
            Ok(v) => (
                FrameType::Response,
                if routing_module {
                    json!({"result":v})
                } else {
                    v
                },
            ),
            Err(e) => (
                FrameType::Error,
                json!({"code":e.code,"message":e.message,"detail":e.detail}),
            ),
        };
        if !reply(&mut stream, &frame, ty, value).await {
            break;
        }
    }
}

impl Daemon {
    async fn new(fake: Arc<FakeWire>) -> Self {
        let root = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let key = generate_key().unwrap();
        let daemon_id = generate_daemon_id().unwrap();
        let connection = root.path().join("connection.json");
        write_atomic(
            &connection,
            &ConnectionInfo {
                schema: SCHEMA_VERSION,
                wire_version: Some(subc_protocol::PROTOCOL_VERSION),
                endpoints: vec![Endpoint {
                    host: address.ip().to_string(),
                    port: address.port(),
                }],
                key: key.clone(),
                daemon_id,
                pid: std::process::id(),
                daemon_ver: "0.36.35-fake".into(),
            },
        )
        .unwrap();
        let state = Arc::new(Mutex::new(DaemonState {
            providers: vec![PROVIDER.into()],
            catalog_generation: 1,
            via: "root".into(),
            ..DaemonState::default()
        }));
        let shared = state.clone();
        let task = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let state = shared.clone();
                let fake = fake.clone();
                let key = key.clone();
                tokio::spawn(async move {
                    if authenticate_server(
                        &mut stream,
                        &key,
                        &daemon_id,
                        "0.36.35-fake",
                        Duration::from_secs(2),
                    )
                    .await
                    .is_ok()
                    {
                        socket(stream, state, fake).await;
                    }
                });
            }
        });
        Self {
            connection,
            state,
            task,
            _root: root,
        }
    }

    async fn owner(
        &self,
    ) -> (
        Arc<ProductionWire>,
        tokio::task::JoinHandle<Result<(), subc_client_rs::SubcModuleError>>,
        Result<(), WireRefusal>,
    ) {
        struct Passive;
        #[async_trait]
        impl ModuleHandler for Passive {
            async fn handle(
                &self,
                _: subc_client_rs::RequestCtx,
                _: Vec<u8>,
            ) -> subc_client_rs::HandlerOutcome {
                panic!("no incoming module calls in this daemon")
            }
        }
        let (handle, serving) =
            serve_with_handle(&self.connection, crate::manifest("magic-context"), Passive)
                .await
                .unwrap();
        let task = tokio::spawn(serving);
        let wire = Arc::new(ProductionWire::new(
            self.connection.clone(),
            "magic-context".into(),
        ));
        let result = wire.initialize(handle).await;
        (wire, task, result)
    }

    fn summary_scope(&self, project: &Path) -> SummaryScope {
        SummaryScope {
            stamp: subc_protocol::scope::ScopeStamp::new(
                Principal::Reserved {
                    module_id: "prefrontal-core".into(),
                },
                "live-session",
                1,
                ScopeKind::Head,
            ),
            identity: crate::session_resolver::RunnerBindIdentity {
                project_root: project.to_path_buf(),
                harness: "claude-code".into(),
                session: "ses".into(),
            },
        }
    }
}

#[tokio::test]
async fn live_dream_gate_requires_the_registered_scope_authority() {
    for refusal_code in [
        Some("scope_sync_not_authority"),
        Some("not_registered"),
        None,
    ] {
        let refused = refusal_code.is_some();
        let rig = CarrierRig::new(vec![candidate("broca", "model-a", Some("claude-code"))]);
        let daemon = Daemon::new(rig.wire.clone()).await;
        {
            let mut state = daemon.state.lock().unwrap();
            state.refuse_sync = refused;
            state.scope_error = refusal_code.map(str::to_owned);
        }
        let (wire, serving, result) = daemon.owner().await;
        assert_eq!(result.is_err(), refused);
        assert_eq!(
            crate::dream_dispatch::routed::choose_path(
                wire.scope_support_for(&rig.f.context.config.directory),
                true
            )
            .unwrap(),
            if refused {
                crate::dream_dispatch::routed::DreamPath::Legacy
            } else {
                crate::dream_dispatch::routed::DreamPath::Routed
            }
        );
        if refused {
            assert_eq!(
                result.unwrap_err().code,
                format!("mc_dream_{}", refusal_code.unwrap())
            );
        }
        serving.abort();
    }
}

#[tokio::test]
async fn live_summary_gate_requires_one_provider_and_an_admitted_scoped_route() {
    let rig = CarrierRig::new(vec![candidate("broca", "model-a", Some("claude-code"))]);
    let daemon = Daemon::new(rig.wire.clone()).await;
    let routing = SubcSummaryRouting::new(daemon.connection.clone(), RouteTargetConfig::default());
    let scope = daemon.summary_scope(&rig.f.context.config.directory);
    for (providers, refuse_open, passed) in [
        (vec![PROVIDER.into()], false, true),
        (vec![], false, false),
        (vec![PROVIDER.into(), "second".into()], false, false),
        (vec![PROVIDER.into()], true, false),
    ] {
        {
            let mut state = daemon.state.lock().unwrap();
            state.providers = providers;
            state.refuse_open = refuse_open;
        }
        routing.observe_scope(&scope).await;
        assert_eq!(
            routing.routing_support_for(Some(&scope.stamp)).is_ok(),
            passed
        );
    }
}

#[tokio::test]
async fn live_entorhinal_lookup_stamps_every_registered_via_and_never_implicit() {
    let rig = CarrierRig::new(vec![candidate("broca", "model-a", Some("claude-code"))]);
    let daemon = Daemon::new(rig.wire.clone()).await;
    let (wire, serving, result) = daemon.owner().await;
    result.unwrap();
    for via in [
        "root",
        "walk",
        "containment",
        "alias",
        "worktree",
        "implicit",
    ] {
        daemon.state.lock().unwrap().via = via.into();
        let project = wire.lookup_project(&rig.f.context.config.directory).await;
        if via == "implicit" {
            assert!(project.is_none());
            continue;
        }
        let scope = DreamScope::new(project.unwrap(), &rig.f.context.config.directory);
        wire.sync_scope(&scope).await.unwrap();
        assert_eq!(
            daemon.state.lock().unwrap().scopes[scope.scope_ref()]
                .project_id
                .as_deref(),
            Some(ENTORHINAL_ID)
        );
        wire.end_scope(&scope).await.unwrap();
    }
    assert!(daemon.state.lock().unwrap().scopes.is_empty());
    serving.abort();
}

#[tokio::test]
async fn live_scope_snapshots_preserve_other_runs_and_release_only_the_finished_run() {
    let rig = CarrierRig::new(vec![candidate("broca", "model-a", Some("claude-code"))]);
    let daemon = Daemon::new(rig.wire.clone()).await;
    let (wire, serving, result) = daemon.owner().await;
    result.unwrap();
    let project = wire
        .lookup_project(&rig.f.context.config.directory)
        .await
        .unwrap();
    let first = DreamScope::new(project.clone(), &rig.f.context.config.directory);
    let second = DreamScope::new(project, &rig.f.context.config.directory);
    let (a, b) = tokio::join!(wire.sync_scope(&first), wire.sync_scope(&second));
    a.unwrap();
    b.unwrap();
    wire.end_scope(&first).await.unwrap();
    assert_eq!(
        daemon
            .state
            .lock()
            .unwrap()
            .scopes
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        vec![second.scope_ref()]
    );
    wire.end_scope(&second).await.unwrap();
    assert!(daemon.state.lock().unwrap().scopes.is_empty());
    serving.abort();
}

#[tokio::test]
async fn live_shape_runs_one_dream_and_one_summary_select_send_report_and_release() {
    let rig = CarrierRig::new(vec![candidate("broca", "model-a", Some("claude-code"))]);
    let daemon = Daemon::new(rig.wire.clone()).await;
    let (wire, serving, result) = daemon.owner().await;
    result.unwrap();
    let c = &rig.f.context;
    let mut carrier = RoutedCarrier::new(RoutedCarrierParts {
        wire: wire.clone(),
        routes: rig.f.handler.broca_dream_tools(),
        context: c.clone(),
        router: rig.f.effects.clone(),
        observer: rig.f.effects.clone(),
        scheduler: rig.f.scheduler.clone(),
        policy: policy(),
        project_id: wire.lookup_project(&c.config.directory).await.unwrap(),
        parks: rig.parks.clone(),
        parked: rig.parked.clone(),
    });
    let request = rig.f.request(&["ctx_memory"], 5);
    let child = carrier.open(&request).await.unwrap();
    assert_eq!(
        carrier.complete(&child, &request).await.unwrap().text,
        "done"
    );
    carrier.close(&child, true).await.unwrap();
    {
        let state = daemon.state.lock().unwrap();
        assert!(
            state.scopes.is_empty(),
            "finished dream scope must be released"
        );
        let carried = state
            .snapshots
            .iter()
            .flat_map(|s| s["scopes"].as_array().unwrap())
            .find(|s| s["carriers"].as_array().is_some_and(|c| !c.is_empty()))
            .unwrap();
        assert_eq!(carried["project_id"], ENTORHINAL_ID);
        assert_eq!(carried["kind"], "ephemeral");
        assert_eq!(carried["scope_epoch"], 1);
        assert!(carried.get("parent").is_none());
        assert!(carried.get("attributes").is_none());
        assert_eq!(carried["carriers"][0]["targets"], json!(["magic-context"]));
    }
    assert_eq!(
        rig.wire.log().plans[0]["items"][0]["provider"],
        "magic-context"
    );
    let routing = Arc::new(SubcSummaryRouting::new(
        daemon.connection.clone(),
        RouteTargetConfig::default(),
    ));
    crate::tests::summary_routing::run_live_summary(routing, |text| {
        rig.wire
            .script(vec![answer(Box::leak(text.into_boxed_str()))])
    })
    .await;
    let log = rig.wire.log();
    assert_eq!(log.reports.len(), 2);
    assert!(log
        .reports
        .iter()
        .all(|(_, r)| r.outcome == Outcome::Completed));
    let sends: Vec<_> = log
        .ops
        .iter()
        .filter(|(_, _, op)| op == "session.send")
        .collect();
    assert_eq!(sends.len(), 2);
    assert!(sends.iter().all(|(_, bind, _)| bind.module == "broca"));
    assert!(
        log.selects[0].1["requirements"]["context_window"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert_eq!(log.selects[0].1["concurrency_slots"][0]["limit"], 2);
    serving.abort();
}

#[tokio::test]
async fn hold_ok_is_sent_only_to_a_declaring_live_provider() {
    for supported in [false, true] {
        let rig = CarrierRig::new(vec![candidate("broca", "model-a", Some("claude-code"))]);
        let daemon = Daemon::new(rig.wire.clone()).await;
        daemon.state.lock().unwrap().hold_control = supported;
        let routing = Arc::new(SubcSummaryRouting::new(
            daemon.connection.clone(),
            RouteTargetConfig::default(),
        ));
        crate::tests::summary_routing::run_live_summary(routing, |text| {
            rig.wire
                .script(vec![answer(Box::leak(text.into_boxed_str()))])
        })
        .await;
        let state = daemon.state.lock().unwrap();
        let select = state
            .calls
            .iter()
            .find(|c| c["method"] == "route.select")
            .unwrap();
        assert_eq!(
            select["params"].get("hold_ok"),
            supported.then_some(&Value::Bool(false))
        );
    }
}

#[tokio::test]
async fn named_registration_refusals_close_the_gate_and_keep_legacy_available() {
    for code in [
        "invalid_workdir",
        "scope_workdir_changed",
        "scope_project_changed",
    ] {
        let rig = CarrierRig::new(vec![candidate("broca", "model-a", Some("claude-code"))]);
        let daemon = Daemon::new(rig.wire.clone()).await;
        let (wire, serving, result) = daemon.owner().await;
        result.unwrap();
        daemon.state.lock().unwrap().scope_error = Some(code.into());
        let scope = DreamScope::new(
            wire.lookup_project(&rig.f.context.config.directory)
                .await
                .unwrap(),
            &rig.f.context.config.directory,
        );
        let refusal = wire.sync_scope(&scope).await.unwrap_err();
        assert_eq!(refusal.code, format!("mc_dream_{code}"));
        assert_eq!(
            crate::dream_dispatch::routed::choose_path(
                wire.scope_support_for(&rig.f.context.config.directory),
                true
            )
            .unwrap(),
            crate::dream_dispatch::routed::DreamPath::Legacy
        );
        wire.end_scope(&scope).await.unwrap();
        assert!(wire
            .scope_support_for(Path::new("/unrelated-project"))
            .is_ok());
        serving.abort();
    }
}

#[tokio::test]
async fn ready_summary_recovers_after_catalog_outages_without_rebind_and_logs_once() {
    use tracing::instrument::WithSubscriber;
    struct Capture(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let logs = Arc::new(Mutex::new(Vec::new()));
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_max_level(tracing::Level::WARN)
        .with_writer(move || Capture(writer.clone()))
        .finish();
    async {
        for (outage, code) in [
            (Vec::new(), "routing_provider_missing"),
            (
                vec![PROVIDER.into(), "duplicate-routing".into()],
                "routing_provider_ambiguous",
            ),
        ] {
            let rig = CarrierRig::new(vec![candidate("broca", "model-a", Some("claude-code"))]);
            let daemon = Daemon::new(rig.wire.clone()).await;
            let routing = Arc::new(SubcSummaryRouting::new(
                daemon.connection.clone(),
                RouteTargetConfig::default(),
            ));
            let session = crate::tests::summary_routing::LiveSummarySession::new(routing).await;
            {
                let mut state = daemon.state.lock().unwrap();
                state.providers = outage;
                state.catalog_generation += 1;
            }
            let mut now = crate::now_ms();
            for _ in 0..2 {
                let error = session
                    .fire_at(now, |text| {
                        rig.wire
                            .script(vec![answer(Box::leak(text.into_boxed_str()))])
                    })
                    .await
                    .unwrap_err();
                assert!(error.to_string().contains(code), "{error}");
                let (failure, backoff) = session.failure();
                assert!(failure.unwrap().starts_with(code));
                assert_eq!(
                    backoff,
                    Some(now + crate::historian::HISTORIAN_FAILURE_BACKOFF_MS)
                );
                now += crate::historian::HISTORIAN_FAILURE_BACKOFF_MS + 1;
            }
            assert!(rig.wire.log().selects.is_empty());
            {
                let mut state = daemon.state.lock().unwrap();
                state.providers = vec![PROVIDER.into()];
                state.catalog_generation += 1;
            }
            let outcome = session
                .fire_at(now, |text| {
                    rig.wire
                        .script(vec![answer(Box::leak(text.into_boxed_str()))])
                })
                .await
                .unwrap();
            assert!(matches!(
                outcome,
                crate::historian::HistorianDriveOutcome::Completed(_)
            ));
            assert_eq!(rig.wire.log().selects.len(), 1);
            assert_eq!(rig.wire.log().reports.len(), 1);
        }
    }
    .with_subscriber(subscriber)
    .await;
    let output = String::from_utf8(logs.lock().unwrap().clone()).unwrap();
    assert_eq!(
        output
            .matches("summary routing provider unavailable;")
            .count(),
        2,
        "{output}"
    );
}

#[tokio::test]
async fn accepted_scope_proof_is_not_evicted_by_other_sessions() {
    let rig = CarrierRig::new(vec![candidate("broca", "model-a", Some("claude-code"))]);
    let daemon = Daemon::new(rig.wire.clone()).await;
    let routing = SubcSummaryRouting::new(daemon.connection.clone(), RouteTargetConfig::default());
    let first = daemon.summary_scope(&rig.f.context.config.directory);
    routing.observe_scope(&first).await;
    for n in 0..256 {
        let mut other = first.clone();
        other.stamp.scope_ref = format!("other-session-{n}");
        routing.observe_scope(&other).await;
        assert!(routing.routing_support_for(Some(&other.stamp)).is_ok());
    }
    assert!(routing.routing_support_for(Some(&first.stamp)).is_ok());
}
