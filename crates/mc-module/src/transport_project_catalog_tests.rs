use super::*;
use futures_util::FutureExt;
use std::future::Future;
use subc_client_rs::config::{
    ConfigError, ConfigGetReply, ConfigLayer, ConfigLayerSnapshot, ConfigStatus, ConfigView,
};
use subc_protocol::{ErrorBody, Frame, FrameType, ModuleHelloAckBody, PROTOCOL_VERSION};
use subc_transport::{authenticate_server, read_frame, write_frame, ConnectionInfo, Endpoint};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{self, timeout, Instant as TestInstant};

const PROJECT: &str = "pj-catalog";

fn head_catalog() -> Vec<u8> {
    body(json!({"preset":"head","params":{"compacting":true}}))
}

fn assert_busy(answer: Result<Vec<u8>, Refusal>) {
    let refusal = answer.expect_err("catalog must not answer from unknown project settings");
    // The caller, Prefrontal, keeps the previous tools and retries this exact code.
    assert_eq!(refusal.code, "provider_unavailable");
}

fn assert_memory_tool(answer: Result<Vec<u8>, Refusal>, expected: bool) {
    let answer: Value = serde_json::from_slice(&answer.unwrap()).unwrap();
    assert_eq!(
        answer["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "ctx_memory"),
        expected,
        "catalog: {answer}"
    );
}

fn assert_elapsed(start: TestInstant, seconds: u64) {
    let expected = Duration::from_secs(seconds);
    let elapsed = start.elapsed();
    assert!(
        (expected..=expected + Duration::from_millis(1)).contains(&elapsed),
        "catalog took {elapsed:?}, expected {expected:?}"
    );
}

async fn next(wire: &mut TcpStream) -> Frame {
    timeout(Duration::from_secs(2), read_frame(wire))
        .await
        .expect("module frame deadline")
        .unwrap()
        .unwrap()
}

async fn reply(wire: &mut TcpStream, frame: &Frame, ty: FrameType, body: impl serde::Serialize) {
    write_frame(
        wire,
        &Frame::build(
            ty,
            frame.header.flags,
            0,
            0,
            frame.header.corr,
            serde_json::to_vec(&body).unwrap(),
        )
        .unwrap(),
    )
    .await
    .unwrap();
}

struct CatalogFixture {
    dir: tempfile::TempDir,
    handler: Handler,
    handle: subc_client_rs::ModuleHandle,
    wire: TcpStream,
    hello: Frame,
    serve: tokio::task::JoinHandle<()>,
}

impl Drop for CatalogFixture {
    fn drop(&mut self) {
        self.serve.abort();
    }
}

async fn catalog_fixture(advertise_projects: bool) -> CatalogFixture {
    let dir = tempfile::tempdir().unwrap();
    let connection = dir.path().join("connection.json");
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let info = ConnectionInfo {
        schema: 1,
        wire_version: Some(PROTOCOL_VERSION),
        endpoints: vec![Endpoint {
            host: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
        }],
        key: vec![42; 32],
        daemon_id: [43; 16],
        pid: std::process::id(),
        daemon_ver: "test".into(),
    };
    subc_transport::connection_file::write_atomic(&connection, &info).unwrap();
    let module = Module::new(
        SubcRunnerClient::new(
            connection.clone(),
            Arc::new(ChildScopes::new("test-catalog")),
        ),
        crate::config::Config::Files(
            crate::config::Loader::with_user_path(dir.path().join("user.jsonc"))
                .managed(dir.path()),
        ),
        None,
        None,
    );
    let served = Handler::new(module.clone());
    let register = tokio::spawn(async move {
        let (handle, serve) =
            subc_client_rs::serve_with_handle(&connection, manifest(crate::MODULE_ID), served)
                .await
                .unwrap();
        (handle, tokio::spawn(async { serve.await.unwrap() }))
    });
    let (mut wire, _) = listener.accept().await.unwrap();
    authenticate_server(
        &mut wire,
        &info.key,
        &info.daemon_id,
        &info.daemon_ver,
        Duration::from_secs(2),
    )
    .await
    .unwrap();
    let hello = next(&mut wire).await;
    assert_eq!(hello.header.ty, FrameType::Hello);
    let mut capabilities = vec!["config.gate".into()];
    if advertise_projects {
        capabilities.push("config.settings.projects/v1".into());
    }
    reply(
        &mut wire,
        &hello,
        FrameType::HelloAck,
        ModuleHelloAckBody {
            negotiated_ver: PROTOCOL_VERSION,
            subc_ops: vec![],
            subc_capabilities: capabilities,
            storage: None,
            machine_id: None,
            resume_token: None,
        },
    )
    .await;
    let (handle, serve) = register.await.unwrap();
    let declare = next(&mut wire).await;
    assert_eq!(
        serde_json::from_slice::<Value>(&declare.body).unwrap()["op"],
        "config.declare"
    );
    reply(
        &mut wire,
        &declare,
        FrameType::Response,
        json!({"op":"config.declare"}),
    )
    .await;
    let user = next(&mut wire).await;
    assert_eq!(
        serde_json::from_slice::<Value>(&user.body).unwrap(),
        json!({"op":"config.get"})
    );
    let view = ConfigView::new(
        1,
        json!({}),
        Default::default(),
        vec![],
        ConfigStatus::Active,
    );
    let handler = Handler::new(module);
    handler.config_apply(view.clone()).await.unwrap();
    reply(
        &mut wire,
        &user,
        FrameType::Response,
        ConfigGetReply::new(Some(view), None),
    )
    .await;
    let fixture = CatalogFixture {
        dir,
        handler,
        handle,
        wire,
        hello,
        serve,
    };
    fixture.bind(1, RouteRole::Tools, PROJECT);
    fixture.bind(2, RouteRole::Discovery, PROJECT);
    fixture
}

impl CatalogFixture {
    fn bind(&self, channel: u16, role: RouteRole, project: &str) {
        self.handler.bound.lock().unwrap().insert(
            channel,
            Bound {
                route: Route {
                    session: SessionRef::new("runner", MODULE_LEVEL_HARNESS, "catalog"),
                    project: Some(crate::route::Project {
                        id: project.into(),
                        root: self.dir.path().display().to_string(),
                    }),
                    workdir: None,
                    agent_id: None,
                },
                role,
                lab_scope: false,
            },
        );
    }

    fn request<'a>(
        &'a self,
        channel: u16,
        body: &'a [u8],
    ) -> impl Future<Output = Result<Vec<u8>, Refusal>> + 'a {
        self.handler
            .dispatch_at(channel, body, Instant::now(), Some(&self.handle))
    }

    fn project_view(&self, overlay: Option<Value>) -> ConfigView {
        let layers = overlay
            .iter()
            .map(|overlay| {
                ConfigLayerSnapshot::file(
                    crate::MODULE_ID,
                    ConfigLayer::Project,
                    self.dir.path().join("project.jsonc").display().to_string(),
                    Some(serde_json::to_vec(overlay).unwrap()),
                )
            })
            .collect();
        let mut view = ConfigView::new(
            2,
            overlay.unwrap_or_else(|| json!({})),
            Default::default(),
            layers,
            ConfigStatus::Active,
        );
        view.project_id = Some(PROJECT.into());
        view
    }
}

fn body(arguments: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"name":"tool.catalog","arguments":arguments})).unwrap()
}

const IGNORED: &str = "the project's settings file is ignored until it is fixed";
const APPLIES: &str = "the project's settings apply again";

fn refused(message: &str) -> ConfigError {
    ConfigError::Refused(ErrorBody::new("value_invalid", message))
}

#[tokio::test]
async fn refused_project_catalog_wakes_and_answers_without_waiting_again() {
    let fixture = catalog_fixture(true).await;
    let request = head_catalog();
    let capture = crate::test_log::capture();
    time::pause();
    let start = TestInstant::now();
    let mut waiting = Box::pin(fixture.request(1, &request));
    assert!(waiting.as_mut().now_or_never().is_none());
    fixture
        .handler
        .on_project_config_error(PROJECT.into(), refused("/transform_mode is not valid here"))
        .await;
    let answer = waiting.await;
    assert_elapsed(start, 0);
    assert_memory_tool(answer, true);

    for channel in [2, 1] {
        let start = TestInstant::now();
        let answer = fixture.request(channel, &request).await;
        assert_elapsed(start, 0);
        assert_memory_tool(answer, true);
        fixture
            .handler
            .on_project_config_error(PROJECT.into(), refused("/transform_mode is not valid here"))
            .await;
    }
    let logs = capture.text();
    assert_eq!(capture.count(IGNORED), 1, "{logs}");
    for expected in [
        "WARN",
        PROJECT,
        "value_invalid",
        "/transform_mode is not valid here",
    ] {
        assert!(logs.contains(expected), "missing {expected}: {logs}");
    }
}

#[tokio::test]
async fn project_refusal_logs_only_state_changes_and_a_valid_view_applies_again() {
    let fixture = catalog_fixture(true).await;
    let request = head_catalog();
    let capture = crate::test_log::capture();
    time::pause();
    for message in [
        "/a is not valid here",
        "/b is not valid here",
        "/a is not valid here",
    ] {
        fixture
            .handler
            .on_project_config_error(PROJECT.into(), refused(message))
            .await;
    }
    let view = fixture.project_view(Some(json!({"memory":{"enabled":false}})));
    for _ in 0..2 {
        fixture.handler.config_apply(view.clone()).await.unwrap();
        let start = TestInstant::now();
        let answer = fixture.request(2, &request).await;
        assert_elapsed(start, 0);
        assert_memory_tool(answer, false);
    }
    fixture
        .handler
        .on_project_config_error(PROJECT.into(), refused("/a is not valid here"))
        .await;
    let start = TestInstant::now();
    let answer = fixture.request(1, &request).await;
    assert_elapsed(start, 0);
    assert_memory_tool(answer, true);

    let logs = capture.text();
    let changes: Vec<_> = logs
        .lines()
        .filter(|line| line.contains(IGNORED) || line.contains(APPLIES))
        .collect();
    assert_eq!(changes.len(), 5, "{logs}");
    for (line, expected) in changes.iter().zip([
        "/a is not valid here",
        "/b is not valid here",
        "/a is not valid here",
        APPLIES,
        "/a is not valid here",
    ]) {
        assert!(line.contains(expected), "{logs}");
    }
    assert!(
        changes[3].contains("INFO") && changes[3].contains(PROJECT),
        "{logs}"
    );
}

#[tokio::test]
async fn transient_project_errors_do_not_end_the_catalog_wait() {
    let fixture = catalog_fixture(true).await;
    let request = head_catalog();
    let capture = crate::test_log::capture();
    time::pause();
    let start = TestInstant::now();
    let mut waiting = Box::pin(fixture.request(1, &request));
    assert!(waiting.as_mut().now_or_never().is_none());
    for error in [
        ConfigError::Protocol("missing project view".into()),
        ConfigError::ConnectionClosed,
    ] {
        fixture
            .handler
            .on_project_config_error(PROJECT.into(), error)
            .await;
        assert!(waiting.as_mut().now_or_never().is_none());
    }
    assert_busy(waiting.await);
    assert_elapsed(start, 2);
    assert_eq!(capture.count(IGNORED), 0, "{}", capture.text());
}

#[tokio::test]
async fn setup_still_answers_immediately_after_a_project_refusal() {
    use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
    use cortexkit_role_compaction::setup::{ModelRef, SetupAnswer, SetupRequest};

    let fixture = catalog_fixture(true).await;
    fixture.bind(3, RouteRole::Compaction, PROJECT);
    let body = wire::encode(
        ops::COMPACTION_SETUP,
        &SetupRequest::new(
            "worker",
            ModelRef::new("anthropic", "claude-opus-5-5"),
            200_000,
            1_000,
            ProviderRules::new(SignedParts::None, EditCost::Suffix),
            Vec::new(),
            1,
        ),
    );
    fixture
        .handler
        .on_project_config_error(PROJECT.into(), refused("/transform_mode is not valid here"))
        .await;
    time::pause();
    let start = TestInstant::now();
    let reply = fixture.request(3, &body).await.unwrap();
    assert_elapsed(start, 0);
    assert!(matches!(
        serde_json::from_slice(&reply).unwrap(),
        SetupAnswer::Ready
    ));
}

#[tokio::test]
async fn sdk_passes_the_project_refusal_and_later_catalogs_still_queue_a_refresh() {
    let mut fixture = catalog_fixture(true).await;
    let request = head_catalog();
    let CatalogFixture {
        handler,
        handle,
        wire,
        ..
    } = &mut fixture;
    let call = |channel| handler.dispatch_at(channel, &request, Instant::now(), Some(handle));
    let mut waiting = Box::pin(call(1));
    let get = tokio::select! {
        _ = &mut waiting => panic!("catalog answered before the project refresh"),
        get = next(wire) => get,
    };
    let project_get = json!({"op":"config.get", "project_id":PROJECT});
    assert_eq!(
        serde_json::from_slice::<Value>(&get.body).unwrap(),
        project_get
    );
    reply(
        wire,
        &get,
        FrameType::Error,
        ErrorBody::new("value_invalid", "/transform_mode is not valid here"),
    )
    .await;
    assert_memory_tool(waiting.await, true);

    let next_catalog = call(2).now_or_never().expect("known refusal must not wait");
    assert_memory_tool(next_catalog, true);
    let retry = next(wire).await;
    assert_eq!(
        serde_json::from_slice::<Value>(&retry.body).unwrap(),
        project_get
    );
}

#[tokio::test]
async fn cold_scoped_catalog_waits_for_project_settings_without_setup() {
    let mut fixture = catalog_fixture(true).await;
    let view = fixture.project_view(Some(
        json!({"memory":{"enabled":false},"prompt_surface":{"default":"light"}}),
    ));
    let CatalogFixture {
        handler,
        handle,
        wire,
        hello,
        serve,
        ..
    } = &mut fixture;
    let arguments = json!({"preset":"head","params":{"compacting":true},"system_text":{"preset":"head","params":{"compacting":true}}});
    let request = body(arguments.clone());
    let answer = handler.dispatch_at(1, &request, Instant::now(), Some(handle));
    tokio::pin!(answer);
    let project = tokio::select! {
        answer = &mut answer => panic!("cold catalog answered before fetching project settings: {:?}", answer.map(|bytes| serde_json::from_slice::<Value>(&bytes).unwrap()["tools"].as_array().unwrap().iter().map(|tool| tool["name"].clone()).collect::<Vec<_>>())),
        project = next(wire) => project,
    };
    assert_eq!(
        serde_json::from_slice::<Value>(&project.body).unwrap(),
        json!({"op":"config.get","project_id":PROJECT})
    );
    assert!((&mut answer).now_or_never().is_none());
    reply(
        wire,
        &project,
        FrameType::Response,
        ConfigGetReply::new(Some(view), None),
    )
    .await;
    let answer: Value = serde_json::from_slice(&answer.await.unwrap()).unwrap();
    let tools = answer["tools"].as_array().unwrap();
    assert_eq!(
        tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["ctx_reduce", "ctx_expand", "ctx_note", "ctx_search"]
    );
    let mut explicit_light = arguments.clone();
    explicit_light["system_text"]["params"]["surface"] = json!("light");
    let explicit: Value = serde_json::from_slice(
        &handler
            .dispatch_at(2, &body(explicit_light), Instant::now(), Some(handle))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        answer["system_text"]["text"],
        explicit["system_text"]["text"]
    );
    let mut composed = arguments;
    composed["composition"] = json!({"providers":[{"provider":"magic-context","tools":tools.iter().map(|tool|json!({"name":tool["name"]})).collect::<Vec<_>>()}],"compaction":{"provider":"magic-context"}});
    let composed: Value = serde_json::from_slice(
        &handler
            .dispatch_at(2, &body(composed), Instant::now(), Some(handle))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(composed["tools"], answer["tools"]);
    assert_eq!(
        composed["system_text"]["text"],
        answer["system_text"]["text"]
    );

    write_frame(
        wire,
        &Frame::build(FrameType::Goodbye, hello.header.flags, 0, 0, 0, vec![]).unwrap(),
    )
    .await
    .unwrap();
    timeout(Duration::from_secs(2), serve)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn three_overlapping_catalogs_refuse_within_two_seconds() {
    let fixture = catalog_fixture(true).await;
    let request = head_catalog();
    time::pause();
    let start = TestInstant::now();
    let call = |channel| {
        let answer = fixture.request(channel, &request);
        async move {
            let answer = answer.await;
            assert_elapsed(start, 2);
            assert_busy(answer);
        }
    };
    tokio::join!(call(1), call(2), call(1));
}

#[tokio::test]
async fn catalog_retries_share_one_fallback_deadline_per_project() {
    let fixture = catalog_fixture(true).await;
    fixture.bind(3, RouteRole::Tools, "pj-other");
    let request = head_catalog();
    time::pause();
    let start = TestInstant::now();
    assert_busy(fixture.request(1, &request).await);
    assert_elapsed(start, 2);
    assert_busy(fixture.request(2, &request).await);

    let other_start = TestInstant::now();
    let third = async {
        let answer = fixture.request(1, &request).await;
        assert_elapsed(start, 5);
        assert_memory_tool(answer, true);
        let fourth = fixture.request(2, &request).now_or_never();
        assert_memory_tool(fourth.expect("fallback must not wait again"), true);
    };
    let other = async {
        let answer = fixture.request(3, &request).await;
        assert_elapsed(other_start, 2);
        assert_busy(answer);
    };
    tokio::join!(third, other);

    // A late view supersedes the user-only fallback.
    fixture
        .handler
        .config_apply(fixture.project_view(Some(json!({"memory":{"enabled":false}}))))
        .await
        .unwrap();
    let next = fixture.request(1, &request).now_or_never();
    assert_memory_tool(next.expect("delivered settings must not wait"), false);
}

#[tokio::test]
async fn catalog_uses_settings_that_arrive_during_the_wait() {
    let fixture = catalog_fixture(true).await;
    let request = head_catalog();
    time::pause();
    let start = TestInstant::now();
    let mut call = Box::pin(fixture.request(1, &request));
    assert!(call.as_mut().now_or_never().is_none());
    time::advance(Duration::from_secs(1)).await;
    fixture
        .handler
        .config_apply(fixture.project_view(Some(json!({"memory":{"enabled":false}}))))
        .await
        .unwrap();
    assert_memory_tool(call.as_mut().now_or_never().expect("view arrived"), false);
    assert_elapsed(start, 1);
    assert_memory_tool(
        fixture
            .request(2, &request)
            .now_or_never()
            .expect("view is cached"),
        false,
    );
}

#[tokio::test]
async fn catalog_does_not_wait_for_known_absent_or_unsupported_project_settings() {
    let fixture = catalog_fixture(false).await;
    let request = head_catalog();
    fixture
        .handler
        .config_apply(fixture.project_view(None))
        .await
        .unwrap();
    time::pause();
    let no_overlays = fixture.request(1, &request).now_or_never();
    assert_memory_tool(no_overlays.expect("empty project view is known"), true);

    fixture.bind(3, RouteRole::Tools, "pj-unsupported");
    let mut waiting = Box::pin(fixture.request(3, &request));
    assert!(waiting.as_mut().now_or_never().is_none());
    fixture
        .handler
        .on_config_error(ConfigError::Refused(ErrorBody::new(
            "unknown_control_op",
            "project settings are not supported",
        )))
        .await;
    assert_memory_tool(waiting.now_or_never().expect("support is known"), true);
    let unsupported = fixture.request(3, &request).now_or_never();
    assert_memory_tool(unsupported.expect("unsupported daemon must not wait"), true);
}
