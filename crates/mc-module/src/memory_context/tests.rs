use super::ento::{decode_reply, within_deadline};
use super::*;
use cortexkit_agent_identity::{CatalogGenerationState, MoveStep, PinStatusState};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use subc_control::{ClientControlRequest, ClientControlResponse};
use subc_protocol::{BindIdentity, Flags, Frame, FrameType, Priority};
use subc_transport::{
    authenticate_server, generate_daemon_id, generate_key, read_frame, write_atomic, write_frame,
    ConnectionInfo, Endpoint, SCHEMA_VERSION,
};
use tokio::net::TcpListener;

const PROJECTS: &str =
    include_str!("../../testdata/entorhinal-memory-context-v1/context-project.json");
const SESSIONS: &str =
    include_str!("../../testdata/entorhinal-memory-context-v1/context-session.json");
const POPULATED: &str =
    include_str!("../../testdata/entorhinal-memory-context-v1/context-session-populated.json");
const PROJECT_DIGESTS: [&str; 5] = [
    "0135e919d0cbcb525ee3c10fdac3d433e6912d31e09a3ea6e17e2c236810d48a",
    "e660d17bcf6ddac7b2cab962a2f050ef29a616717533428fd3e5f538497f5eec",
    "9580c56029c767b8ec832f19a3c1a7c826eaa8e8d5064b54b438cdbe688036bf",
    "4b2bf814f8e060a82dda8eaffbef6d0c741b1e393aa31657f0748b7b44fe15de",
    "b67e53c8f90814d2cc68ad82fc6d5db99f8124b35c0e9c875693a5dd3c6dc5d5",
];

fn records(text: &str) -> Vec<Value> {
    serde_json::from_str(text).unwrap()
}

fn project_reply() -> Value {
    records(PROJECTS)[1]["reply"].clone()
}

fn project(reply: &Value) -> ProjectContext {
    match decode_reply(&serde_json::to_vec(reply).unwrap()) {
        ContextAnswer::Answer(context) => context,
        other => panic!("expected project, got {other:?}"),
    }
}

fn session(reply: &Value) -> SessionContext {
    match decode_reply(&serde_json::to_vec(reply).unwrap()) {
        ContextAnswer::Answer(context) => context,
        other => panic!("expected session, got {other:?}"),
    }
}

fn assert_not_answering<T: std::fmt::Debug + ContextReply>(reply: &Value) {
    assert!(
        matches!(
            decode_reply::<T>(&serde_json::to_vec(reply).unwrap()),
            ContextAnswer::NotAnswering
        ),
        "accepted invalid reply: {reply}"
    );
}

#[test]
fn project_snapshot_literal_digests() {
    for (record, expected) in records(PROJECTS).iter().zip(PROJECT_DIGESTS) {
        assert_eq!(snapshot_digest(&project(&record["reply"])), expected);
    }
}

#[test]
fn snapshot_ignores_key_order_and_whitespace() {
    // Reverse every object's keys without passing the result through Value's
    // sorted map. The same decoded reply must still name the same authority.
    fn reversed(value: &Value) -> String {
        match value {
            Value::Object(map) => format!(
                "{{ {} }}",
                map.iter()
                    .rev()
                    .map(|(key, value)| format!(
                        "{} : {}",
                        serde_json::to_string(key).unwrap(),
                        reversed(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",\n")
            ),
            _ => serde_json::to_string(value).unwrap(),
        }
    }
    for record in records(PROJECTS) {
        let original = project(&record["reply"]);
        let changed = reversed(&record["reply"]);
        assert_ne!(
            changed.as_bytes(),
            serde_json::to_vec(&record["reply"]).unwrap()
        );
        let ContextAnswer::Answer(decoded) = decode_reply::<ProjectContext>(changed.as_bytes())
        else {
            panic!("reordered reply was rejected")
        };
        assert_eq!(snapshot_digest(&original), snapshot_digest(&decoded));
    }
}

#[test]
fn snapshot_digest_includes_via() {
    let original = project_reply();
    let mut changed = original.clone();
    changed["result"]["via"] = json!("worktree");
    assert_ne!(
        snapshot_digest(&project(&original)),
        snapshot_digest(&project(&changed))
    );
}

#[test]
fn snapshot_digest_includes_document_descriptor() {
    let original = project_reply();
    for field in ["revision", "charter_bytes", "document_bytes", "sha256"] {
        let mut changed = original.clone();
        let leaf = &mut changed["result"]["document"][field];
        *leaf = if field == "sha256" {
            json!("d".repeat(64))
        } else {
            json!(leaf.as_u64().unwrap() + 1)
        };
        assert_ne!(
            snapshot_digest(&project(&original)),
            snapshot_digest(&project(&changed)),
            "descriptor field {field}"
        );
    }
}

#[test]
fn revoked_unblocked_pin_is_usable() {
    let mut reply = records(SESSIONS)[2]["reply"].clone();
    reply["result"]["pins"][0]["status"]["blocked"] = json!(false);
    let context = session(&reply);
    assert_eq!(
        context.pins[0].status.as_ref().unwrap().state,
        PinStatusState::Revoked
    );
    assert!(!pin_blocked(&context.pins[0]));
}

#[test]
fn null_status_is_usable_and_revoked_blocked_is_not() {
    let replies = records(SESSIONS);
    let usable = session(&replies[0]["reply"]);
    assert!(usable.pins[0].status.is_none());
    assert!(matches!(usable.whereabouts.moving, Presence::Missing));
    assert!(!pin_blocked(&usable.pins[0]));
    assert!(pin_blocked(&session(&replies[2]["reply"]).pins[0]));
}

#[test]
fn extra_fields_are_not_answering() {
    for pointer in ["", "/result", "/result/document", "/result/stamp"] {
        let mut reply = project_reply();
        reply
            .pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("extra".into(), json!(true));
        assert_not_answering::<ProjectContext>(&reply);
    }
    for pointer in [
        "",
        "/result",
        "/result/agent",
        "/result/where",
        "/result/stamp",
        "/result/pins/0",
        "/result/pins/0/status",
    ] {
        let mut reply = records(SESSIONS)[2]["reply"].clone();
        reply
            .pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("extra".into(), json!(true));
        assert_not_answering::<SessionContext>(&reply);
    }
}

#[test]
fn missing_fields_are_not_answering_even_when_nullable() {
    fn remove_each<T: std::fmt::Debug + ContextReply>(original: Value, paths: &[&str]) {
        for path in paths {
            for field in original.pointer(path).unwrap().as_object().unwrap().keys() {
                let mut reply = original.clone();
                reply
                    .pointer_mut(path)
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .remove(field);
                assert_not_answering::<T>(&reply);
            }
        }
    }
    remove_each::<ProjectContext>(
        project_reply(),
        &["", "/result", "/result/document", "/result/stamp"],
    );
    remove_each::<SessionContext>(
        records(SESSIONS)[2]["reply"].clone(),
        &[
            "",
            "/result",
            "/result/agent",
            "/result/where",
            "/result/stamp",
            "/result/pins/0",
            "/result/pins/0/status",
        ],
    );
}

#[test]
fn malformed_and_unknown_replies_are_not_answering() {
    for bytes in [
        b"not JSON".as_slice(),
        b"null",
        b"[]",
        b"{}",
        b"{\"result\":null}",
        b"{\"code\":\"unknown_method\",\"message\":\"unknown\",\"detail\":null}",
    ] {
        assert!(matches!(
            decode_reply::<ProjectContext>(bytes),
            ContextAnswer::NotAnswering
        ));
    }
    let mut reply = project_reply();
    reply["result"]["via"] = json!(7);
    assert_not_answering::<ProjectContext>(&reply);
    reply = project_reply();
    reply["result"]["document"]["revision"] = json!("2");
    assert_not_answering::<ProjectContext>(&reply);
}

#[test]
fn refusal_preserves_code() {
    assert_eq!(
        decode_reply::<SessionContext>(
            br#"{"code":"agent_unknown","message":"unknown agent","detail":null}"#
        ),
        ContextAnswer::Refused {
            code: RefusalCode::Other("agent_unknown".into()),
            message: "unknown agent".into(),
            detail: Value::Null,
        }
    );
}

#[test]
fn vendored_checksums_and_one_byte_controls() {
    let files: [(&str, &[u8]); 5] = [
        ("context-project.json", PROJECTS.as_bytes()),
        ("context-session.json", SESSIONS.as_bytes()),
        (
            "README.md",
            include_bytes!("../../testdata/entorhinal-memory-context-v1/README.md"),
        ),
        ("context-session-populated.json", POPULATED.as_bytes()),
        (
            "README-9e1eb8b.md",
            include_bytes!("../../testdata/entorhinal-memory-context-v1/README-9e1eb8b.md"),
        ),
    ];
    let sums = include_str!("../../testdata/entorhinal-memory-context-v1/SHA256SUMS");
    assert_eq!(sums.lines().count(), files.len());
    for (name, bytes) in files {
        let expected = sums
            .lines()
            .find_map(|line| {
                let (digest, file) = line.split_once("  ").unwrap();
                (file == name).then_some(digest)
            })
            .unwrap();
        assert_eq!(
            crate::digest::hex(&Sha256::digest(bytes)),
            expected,
            "{name}"
        );
        let mut changed = bytes.to_vec();
        changed[0] ^= 1;
        assert_ne!(
            crate::digest::hex(&Sha256::digest(changed)),
            expected,
            "{name} one-byte control"
        );
    }
}

#[tokio::test]
async fn deadline_is_not_answering_not_a_bind_error() {
    // Model the bind caller's distinction: absence permits degraded binding,
    // while a provider refusal must retain its code rather than masquerade as absence.
    fn bind_state(answer: ContextAnswer<ProjectContext>) -> Result<&'static str, String> {
        match answer {
            ContextAnswer::NotAnswering => Ok("entorhinal_not_answering"),
            ContextAnswer::Answer(_) => Ok("answered"),
            ContextAnswer::Refused { code, .. } => Err(format!("{code:?}")),
        }
    }
    let start = tokio::time::Instant::now();
    let answer = within_deadline::<ProjectContext>(std::future::pending()).await;
    assert_eq!(
        bind_state(answer.clone()).expect("a deadline must allow binding to continue"),
        "entorhinal_not_answering"
    );
    assert_eq!(answer, ContextAnswer::NotAnswering);
    assert!(start.elapsed() >= Duration::from_millis(500));
    assert!(start.elapsed() < Duration::from_secs(1));
    for mode in [Mode::NoReply, Mode::NoHandshake] {
        let endpoint = fake_endpoint(mode, false).await;
        let start = tokio::time::Instant::now();
        assert_eq!(
            reader(Some(endpoint.connection_file.clone()))
                .project("/fixture/project")
                .await,
            ContextAnswer::NotAnswering
        );
        assert!(start.elapsed() < Duration::from_secs(1));
    }
    let endpoint = fake_endpoint(Mode::NoReply, false).await;
    let slot = crate::entorhinal_resolve::consumer_slot(&endpoint.connection_file);
    let _held = slot.lock().await;
    assert_eq!(
        reader(Some(endpoint.connection_file.clone()))
            .session("agent")
            .await,
        ContextAnswer::NotAnswering
    );
    assert!(
        endpoint.calls.lock().unwrap().is_empty(),
        "the slot wait must consume the same deadline as the call"
    );
}

#[derive(Clone)]
enum Mode {
    Replies(Vec<Vec<u8>>),
    ModuleError(String),
    NoReply,
    NoHandshake,
}

struct FakeEndpoint {
    connection_file: PathBuf,
    calls: Arc<Mutex<Vec<Vec<u8>>>>,
    connections: Arc<AtomicUsize>,
    route_opens: Arc<AtomicUsize>,
    max_live_routes: Arc<AtomicUsize>,
    first_call: Arc<tokio::sync::Notify>,
    release_first: Arc<tokio::sync::Notify>,
    task: tokio::task::JoinHandle<()>,
    _temp: tempfile::TempDir,
}

impl Drop for FakeEndpoint {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn fake_endpoint(mode: Mode, hold_first: bool) -> FakeEndpoint {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let key = generate_key().unwrap();
    let daemon_id = generate_daemon_id().unwrap();
    let connection_file = temp.path().join("connection.json");
    write_atomic(
        &connection_file,
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
            daemon_ver: "fake".into(),
        },
    )
    .unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let log = calls.clone();
    let connections = Arc::new(AtomicUsize::new(0));
    let opened = connections.clone();
    let route_opens = Arc::new(AtomicUsize::new(0));
    let routes = route_opens.clone();
    let max_live_routes = Arc::new(AtomicUsize::new(0));
    let max_live = max_live_routes.clone();
    let first_call = Arc::new(tokio::sync::Notify::new());
    let first_seen = first_call.clone();
    let release_first = Arc::new(tokio::sync::Notify::new());
    let release = release_first.clone();
    let task = tokio::spawn(async move {
        let mut live_routes = 0;
        while let Ok((mut stream, _)) = listener.accept().await {
            if matches!(mode, Mode::NoHandshake) {
                std::future::pending::<()>().await;
            }
            authenticate_server(
                &mut stream,
                &key,
                &daemon_id,
                "fake",
                Duration::from_secs(2),
            )
            .await
            .unwrap();
            opened.fetch_add(1, Ordering::SeqCst);
            while let Ok(Some(frame)) = read_frame(&mut stream).await {
                let (ty, body) = match frame.header.ty {
                    FrameType::Request if frame.header.channel == 0 => {
                        let control: ClientControlRequest =
                            serde_json::from_slice(&frame.body).unwrap();
                        if let ClientControlRequest::RouteOpen {
                            target, identity, ..
                        } = control
                        {
                            assert_eq!(target, crate::entorhinal_resolve::route_target());
                            assert_eq!(identity.session, "instance");
                            live_routes += 1;
                            max_live.fetch_max(live_routes, Ordering::SeqCst);
                            assert_eq!(
                                live_routes, 1,
                                "the previous route must be retired before another opens"
                            );
                            routes.fetch_add(1, Ordering::SeqCst);
                            (
                                FrameType::Response,
                                serde_json::to_vec(&ClientControlResponse::RouteOpen {
                                    route_channel: 10,
                                    route_epoch: 1,
                                })
                                .unwrap(),
                            )
                        } else {
                            continue;
                        }
                    }
                    FrameType::Request => {
                        let index = {
                            let mut log = log.lock().unwrap();
                            let index = log.len();
                            log.push(frame.body.clone());
                            index
                        };
                        if index == 0 {
                            first_seen.notify_one();
                            if hold_first {
                                release.notified().await;
                            }
                        }
                        match &mode {
                            Mode::Replies(replies) => (FrameType::Response, replies[index].clone()),
                            Mode::ModuleError(code) => (FrameType::Error, serde_json::to_vec(&json!({ "code": code, "message": "fake error", "detail": null })).unwrap()),
                            Mode::NoReply => { std::future::pending::<()>().await; unreachable!() }
                            Mode::NoHandshake => unreachable!(),
                        }
                    }
                    FrameType::Goodbye if frame.header.channel == 10 => {
                        assert_eq!(live_routes, 1);
                        live_routes -= 1;
                        continue;
                    }
                    _ => continue,
                };
                let response = Frame::build(
                    ty,
                    Flags::new(false, Priority::Interactive, false),
                    frame.header.channel,
                    frame.header.epoch,
                    frame.header.corr,
                    body,
                )
                .unwrap();
                if write_frame(&mut stream, &response).await.is_err() {
                    break;
                }
            }
        }
    });
    FakeEndpoint {
        connection_file,
        calls,
        connections,
        route_opens,
        max_live_routes,
        first_call,
        release_first,
        task,
        _temp: temp,
    }
}

fn reader(file: Option<PathBuf>) -> MemoryContextReader {
    MemoryContextReader::new(
        file,
        BindIdentity::new(
            PathBuf::from("/fixture/project"),
            "test-harness",
            "instance",
        ),
    )
}

#[tokio::test]
async fn every_vendored_record_replays_exact_request_and_typed_reply() {
    let records = records(PROJECTS)
        .into_iter()
        .chain(records(SESSIONS))
        .chain(records(POPULATED))
        .collect::<Vec<_>>();
    let endpoint = fake_endpoint(
        Mode::Replies(
            records
                .iter()
                .map(|r| serde_json::to_vec(&r["reply"]).unwrap())
                .collect(),
        ),
        false,
    )
    .await;
    let reader = reader(Some(endpoint.connection_file.clone()));
    for record in &records {
        let actual = match record["op"].as_str().unwrap() {
            "context.project" => {
                let answer = reader
                    .project(record["request"]["folder"].as_str().unwrap())
                    .await;
                let ContextAnswer::Answer(context) = answer else {
                    panic!("{answer:?}")
                };
                serde_json::to_value(context).unwrap()
            }
            "context.session" => {
                let answer = reader
                    .session(record["request"]["agent_id"].as_str().unwrap())
                    .await;
                if let Some(code) = record["reply"].get("code") {
                    assert_eq!(
                        answer,
                        ContextAnswer::Refused {
                            code: serde_json::from_value(code.clone()).unwrap(),
                            message: record["reply"]["message"].as_str().unwrap().into(),
                            detail: record["reply"]["detail"].clone(),
                        }
                    );
                    continue;
                }
                let ContextAnswer::Answer(context) = answer else {
                    panic!("{answer:?}")
                };
                serde_json::to_value(context).unwrap()
            }
            other => panic!("unexpected operation {other}"),
        };
        assert_eq!(actual, record["reply"]["result"]);
    }
    let calls = endpoint.calls.lock().unwrap();
    assert_eq!(calls.len(), records.len());
    for (bytes, record) in calls.iter().zip(&records) {
        assert_eq!(
            *bytes,
            serde_json::to_vec(&json!({ "method": record["op"], "params": record["request"] }))
                .unwrap()
        );
    }
    assert_eq!(endpoint.connections.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn transport_failures_and_missing_connection_are_not_answering() {
    assert_eq!(
        reader(None).project("/fixture/project").await,
        ContextAnswer::NotAnswering
    );
    assert_eq!(
        reader(Some(PathBuf::from("missing-connection.json")))
            .session("agent")
            .await,
        ContextAnswer::NotAnswering
    );
    for mode in [
        Mode::Replies(vec![b"not JSON".to_vec()]),
        Mode::ModuleError("unknown_module".into()),
        Mode::ModuleError("unknown_method".into()),
    ] {
        let endpoint = fake_endpoint(mode, false).await;
        let start = tokio::time::Instant::now();
        assert_eq!(
            reader(Some(endpoint.connection_file.clone()))
                .project("/fixture/project")
                .await,
            ContextAnswer::NotAnswering
        );
        assert!(start.elapsed() < Duration::from_secs(1));
    }
    let endpoint = fake_endpoint(Mode::ModuleError("agent_unknown".into()), false).await;
    assert_eq!(
        reader(Some(endpoint.connection_file.clone()))
            .session("agent")
            .await,
        ContextAnswer::Refused {
            code: RefusalCode::Other("agent_unknown".into()),
            message: "fake error".into(),
            detail: Value::Null,
        }
    );
}

#[tokio::test]
async fn resolver_and_context_reads_share_one_consumer_and_serialize_routes() {
    use crate::entorhinal_resolve::{consumer_slot, EntorhinalResolver};
    use crate::project_identity::ProjectIdentityResolver;
    let temp = tempfile::tempdir().unwrap();
    let directory = std::fs::canonicalize(temp.path()).unwrap();
    let resolve_reply = serde_json::to_vec(&json!({"result": { "projectId": "pj-served-project", "via": "root", "canonicalRoot": directory, "gone": false, "generation": 6 }})).unwrap();
    let endpoint = fake_endpoint(
        Mode::Replies(vec![
            resolve_reply,
            serde_json::to_vec(&project_reply()).unwrap(),
        ]),
        true,
    )
    .await;
    let file = endpoint.connection_file.clone();
    let slot = consumer_slot(&file);
    let resolver = EntorhinalResolver::new(Some(file.clone()));
    let identities = ProjectIdentityResolver::with_sidecar_dir(temp.path().join("sidecars"));
    let resolving = tokio::spawn(async move {
        resolver
            .resolve_for_session(&identities, &directory, "test-harness", "instance", None)
            .await
    });
    endpoint.first_call.notified().await;
    assert!(
        slot.try_lock().is_err(),
        "resolver holds the shared slot while awaiting its reply"
    );
    let context_reader = reader(Some(file.clone()));
    let mut context = tokio::spawn(async move { context_reader.project("/fixture/project").await });
    assert!(
        tokio::time::timeout(Duration::from_millis(40), &mut context)
            .await
            .is_err(),
        "context read must wait for resolve to retire its route"
    );
    assert_eq!(endpoint.route_opens.load(Ordering::SeqCst), 1);
    assert_eq!(endpoint.calls.lock().unwrap().len(), 1);
    endpoint.release_first.notify_one();
    assert_eq!(resolving.await.unwrap().unwrap(), "pj-served-project");
    assert!(matches!(context.await.unwrap(), ContextAnswer::Answer(_)));
    assert!(Arc::ptr_eq(&slot, &consumer_slot(&file)));
    assert!(slot.lock().await.is_some());
    assert_eq!(endpoint.connections.load(Ordering::SeqCst), 1);
    // The resolver deliberately retires each bind's route. A subsequent read
    // opens the same target on the cached connection, never a concurrent route.
    assert_eq!(endpoint.route_opens.load(Ordering::SeqCst), 2);
    assert_eq!(endpoint.max_live_routes.load(Ordering::SeqCst), 1);
    let calls = endpoint.calls.lock().unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&calls[0]).unwrap()["method"],
        "resolve"
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&calls[1]).unwrap()["method"],
        "context.project"
    );
}

#[test]
fn populated_session_and_gone_refusal_match_the_owning_handler() {
    let records = records(POPULATED);
    let context = session(&records[0]["reply"]);
    assert_eq!(
        context.whereabouts.holder.as_deref(),
        Some("22222222222222222222222222222222")
    );
    assert_eq!(
        context.whereabouts.holder_name.as_deref(),
        Some("Juniper laptop")
    );
    assert_eq!(
        context.whereabouts.cut_id.as_deref(),
        Some("cut-context-remote")
    );
    assert_eq!(context.whereabouts.epoch, 2);
    assert_eq!(context.whereabouts.read_at_ms, Some(700));
    let Presence::Present(moving) = &context.whereabouts.moving else {
        panic!("populated session must include its move");
    };
    assert_eq!(moving.peer_name.as_deref(), Some("Juniper laptop"));
    assert_eq!(moving.step, MoveStep::Releasing);
    assert_eq!(
        context
            .catalog_generations
            .iter()
            .map(|g| g.state.clone())
            .collect::<Vec<_>>(),
        [
            CatalogGenerationState::Active,
            CatalogGenerationState::Ready
        ]
    );
    assert_eq!(
        decode_reply::<SessionContext>(&serde_json::to_vec(&records[1]["reply"]).unwrap()),
        ContextAnswer::Refused {
            code: RefusalCode::Gone,
            message: "gone".into(),
            detail: json!({"at":10,"reason":"deleted"}),
        }
    );
    let mut invalid = records[0]["reply"].clone();
    invalid["result"]["agent"]["gone"] = records[1]["reply"]["detail"].clone();
    assert_not_answering::<SessionContext>(&invalid);
    invalid = records[0]["reply"].clone();
    invalid["result"]["agent"]["merged_into"] = json!("agent_0000000000000004");
    assert_not_answering::<SessionContext>(&invalid);
}

#[test]
fn future_strings_and_open_participant_payloads_are_preserved() {
    let mut reply = records(POPULATED)[0]["reply"].clone();
    reply["result"]["catalog_generations"][0]["state"] = json!("future-generation-state");
    let moving = &mut reply["result"]["where"]["moving"];
    moving["reason"] = json!("diverged");
    moving["detail"] = json!({"future": {"values": [1, true, null]}});
    moving["hold"] = Value::Null;
    moving["status"] = json!("future-move-status");
    moving["message"] = json!("participant notice");
    moving["waiting_since_ms"] = json!(699);
    moving["diagnostics"] = json!([{"participant": "custom", "fields": [1, 2]}, null]);
    moving["diagnostic"] = json!({"arbitrary": "value"});
    let location = &mut reply["result"]["where"];
    location["moveErrors"] = json!([{"cut_id": "cut-1", "code": "future-error"}]);
    location["moveWarnings"] = json!([{"cut_id": "cut-1", "module_id": "mc", "code": "future-warning", "message": "notice"}]);
    location["moveDiagnostics"] = json!([{"cut_id": "cut-1", "participant": {"unknown": true}}]);
    let decoded = session(&reply);
    assert!(
        matches!(&decoded.whereabouts.moving, Presence::Present(moving)
        if moving.hold == Presence::Present(Value::Null))
    );
    assert_eq!(serde_json::to_value(decoded).unwrap(), reply["result"]);

    let mut pin_reply = records(SESSIONS)[2]["reply"].clone();
    pin_reply["result"]["pins"][0]["kind"] = json!("future-pin-kind");
    for state in [
        json!("future-registry-state"),
        json!({"opaque": "state"}),
        Value::Null,
    ] {
        pin_reply["result"]["pins"][0]["status"]["state"] = state;
        let decoded = session(&pin_reply);
        assert!(pin_blocked(&decoded.pins[0]));
        assert_eq!(serde_json::to_value(decoded).unwrap(), pin_reply["result"]);
    }
    let mut project_reply = project_reply();
    project_reply["result"]["via"] = json!("future-resolution-route");
    assert_eq!(
        serde_json::to_value(project(&project_reply)).unwrap(),
        project_reply["result"]
    );
}

#[test]
fn populated_closed_structures_reject_extra_missing_and_wrong_type_fields() {
    for pointer in ["/result/catalog_generations/0", "/result/where/moving"] {
        let original = records(POPULATED)[0]["reply"].clone();
        let mut reply = original.clone();
        reply
            .pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("extra".into(), json!(true));
        assert_not_answering::<SessionContext>(&reply);
        for field in original
            .pointer(pointer)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
        {
            let mut reply = original.clone();
            reply
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert_not_answering::<SessionContext>(&reply);
        }
    }
    for pointer in [
        "/result/where/moving",
        "/result/where/moving/side",
        "/result/where/moving/step",
        "/result/where/moving/peer",
        "/result/catalog_generations/0/state",
    ] {
        let mut reply = records(POPULATED)[0]["reply"].clone();
        *reply.pointer_mut(pointer).unwrap() = Value::Null;
        assert_not_answering::<SessionContext>(&reply);
    }
    let mut reply = records(POPULATED)[0]["reply"].clone();
    reply["result"]["where"]["moving"]["waiting_ms"] = json!(0);
    assert_not_answering::<SessionContext>(&reply);
    for (field, valid) in [
        ("moveErrors", json!({"cut_id":"cut-1","code":"future"})),
        (
            "moveWarnings",
            json!({"cut_id":"cut-1","module_id":"mc","code":"future","message":"notice"}),
        ),
    ] {
        let mut reply = records(POPULATED)[0]["reply"].clone();
        reply["result"]["where"][field] = json!([valid.clone()]);
        session(&reply);
        reply["result"]["where"][field][0]["extra"] = json!(true);
        assert_not_answering::<SessionContext>(&reply);
        reply["result"]["where"][field] = json!([valid.clone()]);
        reply["result"]["where"][field][0]
            .as_object_mut()
            .unwrap()
            .remove("cut_id");
        assert_not_answering::<SessionContext>(&reply);
        reply["result"]["where"][field] = Value::Null;
        assert_not_answering::<SessionContext>(&reply);
    }
    reply = records(POPULATED)[0]["reply"].clone();
    reply["result"]["where"]["moveDiagnostics"] = json!([{"payload": true}]);
    assert_not_answering::<SessionContext>(&reply);
}

#[test]
fn refusal_without_fixture_only_detail_is_preserved() {
    assert_eq!(
        decode_reply::<SessionContext>(br#"{"code":"future_refusal","message":"refused"}"#),
        ContextAnswer::Refused {
            code: RefusalCode::Other("future_refusal".into()),
            message: "refused".into(),
            detail: Value::Null,
        }
    );
}
