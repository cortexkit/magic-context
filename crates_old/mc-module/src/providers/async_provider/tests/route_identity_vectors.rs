use super::*;

const ROUTE_IDENTITY_VECTORS: &[u8] =
    include_bytes!("../../../../testdata/compaction-provider-v1/route-identity.json");
const ROUTE_IDENTITY_VECTORS_SHA256: &str =
    "a9a11e290293c8789a4472067dfe373ad68a2b625d53e579bf9bf7bf6d7d18d4";

fn vectors() -> Value {
    assert_eq!(
        crate::sha256_hex(ROUTE_IDENTITY_VECTORS),
        ROUTE_IDENTITY_VECTORS_SHA256,
        "published route-identity vectors changed without a contract update"
    );
    serde_json::from_slice(ROUTE_IDENTITY_VECTORS).unwrap()
}

fn setup_params(setup: &Value, request_id: &str) -> Value {
    json!({
        "session": setup["session"],
        "harness": setup["harness"],
        "request_id": request_id,
        "model": "fixture",
        "context_window": 100_000,
        "composition": {"render_tags": true},
        "params": {"serializer_profile": "opencode-aisdk"},
        "lineage_id": "L",
        "now": 1
    })
}

fn expected_bind_identity(
    project_root: &Path,
    value: &Value,
) -> session_resolver::RunnerBindIdentity {
    session_resolver::RunnerBindIdentity {
        project_root: project_root.to_path_buf(),
        harness: value["harness"].as_str().unwrap().into(),
        session: value["session"].as_str().unwrap().into(),
    }
}

async fn setup_vector_rig(dir: &Path, bind: &Value, setup: &Value) -> Rig {
    Rig::setup_with_model(
        dir,
        "broca",
        (
            bind["harness"].as_str().unwrap(),
            bind["session"].as_str().unwrap(),
        ),
        (
            setup["harness"].as_str().unwrap(),
            setup["session"].as_str().unwrap(),
        ),
        "fixture",
        json!({"serializer_profile":"opencode-aisdk"}),
        |_| {},
    )
    .await
}

#[tokio::test]
async fn published_route_identity_vectors_match_async_provider_setup_and_reverse_bind() {
    let vectors = vectors();
    for case in vectors["identity_cases"].as_array().unwrap() {
        let bind = &case["incoming_route"]["bind"];
        let setup = &case["setup"];
        let name = case["name"].as_str().unwrap();
        let bind_session = bind["session"].as_str().unwrap();
        let setup_session = setup["session"].as_str().unwrap();
        let setup_harness = setup["harness"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();

        let expected_setup = case["expected"]["setup"].as_str().unwrap_or("accept");
        if expected_setup == "refuse" {
            let mut valid_bind = bind.clone();
            valid_bind["session"] = json!(setup_session);
            let rig = setup_vector_rig(dir.path(), &valid_bind, setup).await;
            let mut mismatched = rig.h.facade_binding(7).unwrap();
            mismatched.harness = bind["harness"].as_str().unwrap().into();
            mismatched.session = bind_session.into();
            rig.h.bind_route(8, mismatched);
            let refused = rig
                .h
                .dispatch_value(
                    8,
                    json!({"method":"compaction.setup","params":setup_params(setup, name)}),
                )
                .await;
            match refused {
                HandlerOutcome::ErrorWithDetail { code, detail, .. } => {
                    assert_eq!(code, "setup_identity_mismatch", "{name}");
                    assert_eq!(detail["route_identity"]["session"], bind_session, "{name}");
                    assert_eq!(detail["setup_identity"]["session"], setup_session, "{name}");
                }
                other => panic!("{name}: expected setup_identity_mismatch, got {other:?}"),
            }
            continue;
        }

        assert_eq!(expected_setup, "accept", "{name}");
        let rig = setup_vector_rig(dir.path(), bind, setup).await;
        let reverse_bind = case["expected"].get("reverse_bind").unwrap_or(setup);
        let expected = expected_bind_identity(dir.path(), reverse_bind);
        let state = rig.state();
        assert_eq!(state.runner_identity(), expected, "{name}");
        let reverse = rig.h.async_binding(&state);
        assert_eq!(reverse.project_root, expected.project_root, "{name}");
        assert_eq!(reverse.harness, setup_harness, "{name}");
        assert_eq!(reverse.session, setup_session, "{name}");

        rig.fill(10);
        rig.notice(1, 1_000, None).await;
        let calls = rig.runner.bind_identities.lock().unwrap().clone();
        assert!(!calls.is_empty(), "{name}: no conversation calls were made");
        assert!(
            calls.iter().all(|identity| identity == &expected),
            "{name}: {calls:?}"
        );
    }

    for fault in vectors["provider_faults"].as_array().unwrap() {
        let bind = &fault["incoming_route"];
        let setup = &fault["setup"];
        let dir = tempfile::tempdir().unwrap();
        let rig = setup_vector_rig(dir.path(), bind, setup).await;
        let actual = rig.state().runner_identity();
        let expected = expected_bind_identity(dir.path(), &fault["expected_reverse_bind"]);
        let faulty = expected_bind_identity(dir.path(), &fault["faulty_reverse_bind"]);
        assert_eq!(actual, expected, "{}", fault["name"]);
        assert_ne!(actual, faulty, "{}", fault["name"]);
    }

    let unauthenticated = vectors["identity_cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["expected"]["runner_authenticated"] == false)
        .unwrap();
    let bind = &unauthenticated["incoming_route"]["bind"];
    let setup = &unauthenticated["setup"];
    let dir = tempfile::tempdir().unwrap();
    let bootstrap = json!({"harness":"broca","session":"bootstrap"});
    let rig = setup_vector_rig(dir.path(), bind, &bootstrap).await;
    let mut caller_chosen = rig.h.facade_binding(7).unwrap();
    caller_chosen.principal = Some(subc_protocol::Principal::Unverified);
    caller_chosen.harness = bind["harness"].as_str().unwrap().into();
    caller_chosen.session = bind["session"].as_str().unwrap().into();
    rig.h.bind_route(8, caller_chosen);
    let refused = rig
        .h
        .dispatch_value(
            8,
            json!({
                "method":"compaction.setup",
                "params":setup_params(setup, "unattested-vector")
            }),
        )
        .await;
    match refused {
        HandlerOutcome::Error { code, .. } => assert_eq!(code, "route_unbound"),
        HandlerOutcome::ErrorWithDetail { detail, .. } => {
            assert_eq!(detail["field"], "compaction_mode");
        }
        other => panic!("unattested route was accepted: {other:?}"),
    }
}

/// The compaction-provider contract makes Setup's session an opaque,
/// caller-chosen string, and every conversation call uses "exactly that
/// identity". So a session with surrounding whitespace is kept byte for byte:
/// the conversation key, its runner route and its reverse-call identity all
/// name the same padded session. The production runner refuses every
/// `session.read` and `session.send` whose identity session differs from the
/// route's parent session, so any disagreement here fails every such call.
#[tokio::test]
async fn stack26_padded_setup_session_keeps_runner_route_and_identity_on_one_session() {
    let dir = tempfile::tempdir().unwrap();
    let rig = setup_vector_rig(
        dir.path(),
        &json!({"harness":"runner","session":""}),
        &json!({"harness":"broca","session":"conversation-1 "}),
    )
    .await;
    let state = rig.state();
    let route = state.runner().unwrap();
    assert_eq!(
        route.parent_session(),
        state.runner_identity().session,
        "route and bind identity address different sessions"
    );
    assert_eq!(state.runner_identity().session, "conversation-1 ");
    assert_eq!(state.key.session, "conversation-1 ");
    assert_eq!(rig.h.async_binding(&state).session, "conversation-1 ");
}

/// A route bound to one session accepts only a Setup naming that exact
/// session: a Setup whose session differs only by surrounding whitespace is a
/// different session and is refused by name, not quietly trimmed into a match.
#[tokio::test]
async fn padded_setup_session_is_refused_on_a_route_bound_to_the_unpadded_session() {
    let dir = tempfile::tempdir().unwrap();
    let rig = setup_vector_rig(
        dir.path(),
        &json!({"harness":"broca","session":"conversation-1"}),
        &json!({"harness":"broca","session":"conversation-1"}),
    )
    .await;
    let mut bound = rig.h.facade_binding(7).unwrap();
    bound.session = "conversation-1".into();
    rig.h.bind_route(8, bound);
    let refused = rig
        .h
        .dispatch_value(
            8,
            json!({
                "method":"compaction.setup",
                "params":setup_params(
                    &json!({"harness":"broca","session":"conversation-1 "}),
                    "padded",
                )
            }),
        )
        .await;
    match refused {
        HandlerOutcome::ErrorWithDetail { code, detail, .. } => {
            assert_eq!(code, "setup_identity_mismatch");
            assert_eq!(detail["route_identity"]["session"], "conversation-1");
            assert_eq!(detail["setup_identity"]["session"], "conversation-1 ");
        }
        other => panic!("expected setup_identity_mismatch, got {other:?}"),
    }
}
