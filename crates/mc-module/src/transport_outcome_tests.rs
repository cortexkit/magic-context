//! Which failed runner calls may still have reached the runner. A caller
//! that hands the runner a view must not undo it when only the answer was
//! lost, so the error has to say so.

use super::*;

#[test]
fn outcome_a_lost_answer_says_the_request_may_have_arrived() {
    let error = call_error(
        "session.apply_view",
        &subc_client_rs::CallError::OutcomeUnknown(
            "request on channel 16 timed out at its deadline".into(),
        ),
    );
    assert!(error.outcome_unknown, "{error:?}");
    assert_eq!(error.code, None);
    assert!(error.message.starts_with("session.apply_view: "), "{error}");
    // A `NotSent` that can't prove the request stayed unsent. subc-client-rs
    // builds such an error only inside its own crate, so the fact it reports
    // (`never_forwarded() == Some(false)`) is passed to the classifier here.
    assert!(may_have_arrived(false, Some(false)));
}

#[test]
fn outcome_a_call_that_never_left_or_was_answered_is_known() {
    // The runner's own error answer.
    let answered = call_error(
        "session.apply_view",
        &subc_client_rs::CallError::Module(subc_protocol::ErrorBody::new(
            "compaction_not_permitted",
            "another provider",
        )),
    );
    assert!(!answered.outcome_unknown, "{answered:?}");
    // A `NotSent` the client proved never reached the runner.
    assert!(!may_have_arrived(false, Some(true)));
    // Errors other than `NotSent` report nothing about forwarding.
    assert!(!may_have_arrived(false, None));
}

#[test]
fn established_route_death_keeps_the_runner_refusal_and_known_outcome() {
    use subc_client_rs::CallError;
    let body = subc_protocol::ErrorBody::new("stale_route_epoch", "route changed")
        .with_detail(serde_json::json!({"retry_after_ms": 250}));
    let module = call_error(ops::SESSION_SEND, &CallError::Module(body.clone()));
    let dead = call_error(ops::SESSION_SEND, &CallError::RouteDead(Box::new(body)));
    assert_eq!(dead.code.as_deref(), Some("stale_route_epoch"));
    assert_eq!(
        dead.detail,
        Some(serde_json::json!({"retry_after_ms": 250}))
    );
    assert!(!dead.outcome_unknown);
    assert_eq!(dead.message, module.message);
}

#[test]
fn established_route_death_keeps_the_lease_refusal() {
    use subc_client_rs::CallError;
    let body = subc_protocol::ErrorBody::new("stale_route_epoch", "route changed");
    let module = lease_error(&CallError::Module(body.clone()));
    let dead = lease_error(&CallError::RouteDead(Box::new(body)));
    assert_eq!(dead.code, "stale_route_epoch");
    assert_eq!(dead.message, module.message);
    assert_eq!(dead.to_string(), module.to_string());
}

#[tokio::test]
async fn terminal_route_open_returns_the_same_core_unavailable_answer_without_retry() {
    use serde_json::json;
    use subc_protocol::{Flags, Frame, FrameType, Priority, PROTOCOL_VERSION};
    use subc_transport::{authenticate_server, read_frame, write_frame, ConnectionInfo, Endpoint};
    use tokio::net::TcpListener;

    let scratch = tempfile::tempdir().unwrap();
    let path = scratch.path().join("connection.json");
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
        daemon_ver: "0.54.0".into(),
    };
    subc_transport::connection_file::write_atomic(&path, &info).unwrap();
    let (consumer, wire) = tokio::join!(
        SubcConsumer::connect(&path, ConsumerOptions::default()),
        async {
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
            wire
        }
    );
    let consumer = consumer.unwrap();
    let mut wire = wire;
    for expected_back in [Some(false), None] {
        let mut opens = 0;
        let start = tokio::time::Instant::now();
        let call = consumer.call(
            RouteTarget::ManagementSurface {
                module_id: "prefrontal".into(),
            },
            BindIdentity::new("test", "core"),
            br#"{"method":"persona.workspace_document"}"#.to_vec(),
            CallOptions {
                route_retry_deadline: Duration::from_secs(2),
                ..CallOptions::default()
            },
        );
        tokio::pin!(call);
        let result = loop {
            tokio::select! {
                result = &mut call => break result,
                frame = read_frame(&mut wire) => {
                    let request = frame.unwrap().unwrap();
                    let body: Value = serde_json::from_slice(&request.body).unwrap();
                    let (ty, reply) = match body["op"].as_str() {
                        Some("server.describe") => (FrameType::Response, json!({"op":"server.describe", "protocol_ver":PROTOCOL_VERSION, "subc_ops":[], "capabilities":[], "connected_clients":1})),
                        Some("route.open") => {
                            opens += 1;
                            let mut refusal = json!({"code":"target_unavailable", "message":"core is disabled"});
                            if let Some(expected) = expected_back {
                                refusal["detail"] = json!({"expected_back":expected});
                            }
                            (FrameType::Error, refusal)
                        }
                        _ => panic!("unexpected request: {body}"),
                    };
                    let flags = Flags::new(false, Priority::Interactive, false).with_daemon_origin();
                    let reply = Frame::build(ty, flags, 0, 0, request.header.corr, serde_json::to_vec(&reply).unwrap()).unwrap();
                    write_frame(&mut wire, &reply).await.unwrap();
                }
            }
        };
        let error = result.unwrap_err();
        assert_eq!(
            error.never_forwarded(),
            Some(true),
            "{error:?}; opens={opens}"
        );
        assert_eq!(
            error.route_open_refusal().unwrap().code,
            "target_unavailable"
        );
        match core_attempt("persona.workspace_document", Err(error)) {
            crate::prefrontal::Attempt::Settled(Err(refusal)) => {
                assert_eq!(refusal.code, "unavailable")
            }
            other => panic!("{other:?}"),
        }
        if expected_back.is_some() {
            assert_eq!(opens, 1);
            assert!(
                start.elapsed() < Duration::from_secs(1),
                "took {:?}",
                start.elapsed()
            );
        } else {
            assert!(opens > 1);
            assert!(start.elapsed() >= Duration::from_secs(2));
        }
    }
}
