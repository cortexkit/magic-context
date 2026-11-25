use super::*;
use subc_client_rs::config::{
    ConfigGetReply, ConfigLayer, ConfigLayerSnapshot, ConfigStatus, ConfigView,
};
use subc_protocol::{Frame, FrameType, ModuleHelloAckBody, PROTOCOL_VERSION};
use subc_transport::{authenticate_server, read_frame, write_frame, ConnectionInfo, Endpoint};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;

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

#[tokio::test]
async fn cold_scoped_catalog_waits_for_project_settings_without_setup() {
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
        (handle, tokio::spawn(serve))
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
    reply(
        &mut wire,
        &hello,
        FrameType::HelloAck,
        ModuleHelloAckBody {
            negotiated_ver: PROTOCOL_VERSION,
            subc_ops: vec![],
            subc_capabilities: vec!["config.gate".into(), "config.settings.projects/v1".into()],
            storage: None,
            machine_id: None,
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
    reply(
        &mut wire,
        &user,
        FrameType::Response,
        ConfigGetReply::new(Some(view), None),
    )
    .await;

    let handler = Handler::new(module);
    let project_id = "pj-catalog";
    let route = Route {
        session: SessionRef::new("runner", MODULE_LEVEL_HARNESS, "catalog"),
        project: Some(crate::route::Project {
            id: project_id.into(),
            root: dir.path().display().to_string(),
        }),
        workdir: None,
        agent_id: None,
    };
    for (channel, role) in [(1, RouteRole::Tools), (2, RouteRole::Discovery)] {
        handler.bound.lock().unwrap().insert(
            channel,
            Bound {
                route: route.clone(),
                role,
                lab_scope: false,
            },
        );
    }
    let arguments = json!({"preset":"head","params":{"compacting":true},"system_text":{"preset":"head","params":{"compacting":true}}});
    let body = |arguments| {
        serde_json::to_vec(&json!({"name":"tool.catalog","arguments":arguments})).unwrap()
    };
    let request = body(arguments.clone());
    let answer = handler.dispatch_at(1, &request, Instant::now(), Some(&handle));
    tokio::pin!(answer);
    let project = tokio::select! {
        answer = &mut answer => panic!("cold catalog answered before fetching project settings: {:?}", answer.map(|bytes| serde_json::from_slice::<Value>(&bytes).unwrap()["tools"].as_array().unwrap().iter().map(|tool| tool["name"].clone()).collect::<Vec<_>>())),
        project = next(&mut wire) => project,
    };
    assert_eq!(
        serde_json::from_slice::<Value>(&project.body).unwrap(),
        json!({"op":"config.get","project_id":project_id})
    );
    assert!(timeout(Duration::from_millis(20), &mut answer)
        .await
        .is_err());

    let overlay = json!({"memory":{"enabled":false},"prompt_surface":{"default":"light"}});
    let mut view = ConfigView::new(
        2,
        overlay.clone(),
        Default::default(),
        vec![ConfigLayerSnapshot::file(
            crate::MODULE_ID,
            ConfigLayer::Project,
            dir.path().join("project.jsonc").display().to_string(),
            Some(serde_json::to_vec(&overlay).unwrap()),
        )],
        ConfigStatus::Active,
    );
    view.project_id = Some(project_id.into());
    reply(
        &mut wire,
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
            .dispatch_at(2, &body(explicit_light), Instant::now(), Some(&handle))
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
            .dispatch_at(2, &body(composed), Instant::now(), Some(&handle))
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
        &mut wire,
        &Frame::build(FrameType::Goodbye, hello.header.flags, 0, 0, 0, vec![]).unwrap(),
    )
    .await
    .unwrap();
    timeout(Duration::from_secs(2), serve)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}
