use super::*;

const CANARY_SESSION: &str = "ses_e82d035a7ffeFAtBg5sNRs6C7C";
const CANARY_ROOT: &str = "/Users/ufukaltinok/Work/Projects/CortexKit-scratch/canary-head";

fn text(answer: &Value) -> &str {
    assert_eq!(answer["isError"], false, "{answer}");
    answer["content"][0]["text"].as_str().unwrap()
}

#[tokio::test]
async fn runner_attested_plain_head_tools_survive_first_setup() {
    for (harness, session) in [("opencode", CANARY_SESSION), ("runner", "plain-session")] {
        let dir = tempfile::tempdir().unwrap();
        let rig = Rig::without_setup(
            dir.path(),
            "thalamus-harness",
            (harness, session),
            (harness, session),
            |h| {
                let mut binding = h.facade_binding(7).unwrap();
                binding.project_root = CANARY_ROOT.into();
                h.bind_route(7, binding);
                h.store
                    .get()
                    .unwrap()
                    .set_route_identity_for_test(CANARY_ROOT, "git:canary");
            },
        )
        .await;
        let store = rig.h.store.get().unwrap();
        assert!(!rig
            .h
            .facade_compaction_record_exists(&rig.h.facade_binding(7).unwrap()));
        let initial_search = rig
            .tool(7, "ctx_search", json!({"query":"canary head"}))
            .await;
        text(&initial_search);
        let scope = rig
            .h
            .resolve_facade_scope(7, None, "memories", false, false)
            .await
            .unwrap_or_else(|error| panic!("{error:?}"));
        assert!(scope.tools_only);
        assert!(!scope.async_conversation);
        assert_eq!(scope.memory_project_path, "git:canary");
        let namespace = scope.conversation_key;
        assert_eq!(
            rig.reference,
            runner_session_ref("thalamus-harness", harness, session)
        );

        let memory = rig.tool(7, "ctx_memory", json!({
            "action":"write", "category":"CONSTRAINTS", "content":"canary head durable memory",
            "command_id":"plain-memory"
        })).await;
        text(&memory);
        let memory_id = memory["memory_operation"]["module_id"].as_i64().unwrap();
        let read = rig
            .tool(7, "ctx_memory", json!({"action":"get", "ids":[memory_id]}))
            .await;
        assert!(text(&read).contains("canary head durable memory"));
        assert_eq!(
            store
                .get_visible_memories_by_ids("git:canary", &[memory_id])
                .unwrap()
                .len(),
            1
        );
        assert!(store
            .get_visible_memories_by_ids(CANARY_ROOT, &[memory_id])
            .unwrap()
            .is_empty());

        let note = rig.tool(7, "ctx_note", json!({
            "action":"write", "content":"canary head follow-up\nInspect the saved evidence.",
            "command_id":"plain-note"
        })).await;
        text(&note);
        let note_id = note["note_operation"]["module_id"].as_i64().unwrap();
        let read_note = rig
            .tool(
                7,
                "ctx_note",
                json!({"action":"read", "note_ids":[note_id]}),
            )
            .await;
        assert!(text(&read_note).contains("Inspect the saved evidence."));
        let search = rig
            .tool(7, "ctx_search", json!({"query":"canary head"}))
            .await;
        assert!(text(&search).contains("canary head durable memory"));
        assert!(text(&search).contains("canary head follow-up"));
        let by_id = rig
            .tool(7, "ctx_search", json!({"query":format!("#{memory_id}")}))
            .await;
        assert!(text(&by_id).contains("canary head durable memory"));
        assert_eq!(
            rig.resolver
                .calls
                .load(std::sync::atomic::Ordering::Relaxed),
            0
        );

        let catalog = rig
            .tool(
                7,
                "tool.catalog",
                serde_json::from_str(include_str!(
                    "../../../tests/fixtures/tool-catalog/head-no-compaction.request.json"
                ))
                .unwrap(),
            )
            .await;
        assert_eq!(
            catalog["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tool| tool["name"].as_str().unwrap())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["ctx_search", "ctx_memory", "ctx_note"])
        );
        let search_description = catalog["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "ctx_search")
            .unwrap()["description"]
            .as_str()
            .unwrap();
        assert!(search_description.contains("not filtered"));
        assert!(!search_description.contains("CANNOT currently see"));
        let guidance = catalog["system_text"]["text"].as_str().unwrap();
        assert!(!guidance.contains("ctx_expand") && !guidance.contains("ctx_reduce"));
        for (name, arguments) in [
            ("ctx_reduce", json!({"drop":"1"})),
            ("ctx_expand", json!({"message":0})),
        ] {
            let refusal = rig.tool(7, name, arguments).await;
            assert_eq!(refusal["code"], "compaction_inactive", "{refusal}");
            assert!(refusal["message"].as_str().unwrap().contains(name));
            assert!(refusal["message"]
                .as_str()
                .unwrap()
                .contains("compaction is not active"));
        }
        assert!(store
            .load_pending_agent_drops(&namespace)
            .unwrap()
            .is_empty());

        let setup = rig.op("compaction.setup", json!({
            "session":session, "harness":harness, "request_id":"first-setup", "model":"fixture",
            "context_window":100_000, "composition":{"render_tags":true},
            "params":{"serializer_profile":"opencode-aisdk"}, "lineage_id":"L", "now":1
        })).await;
        assert_eq!(setup["answer"], "ready", "{setup}");
        assert_eq!(rig.state().generation, 0);
        assert_eq!(rig.state().namespace(), namespace);
        let read_after = rig
            .tool(
                7,
                "ctx_note",
                json!({"action":"read", "note_ids":[note_id]}),
            )
            .await;
        assert_eq!(read_after, read_note);
        let scope = rig
            .h
            .resolve_facade_scope(7, None, "memories", false, false)
            .await
            .unwrap_or_else(|error| panic!("{error:?}"));
        assert!(scope.async_conversation);
        assert!(!scope.tools_only);
        assert_eq!(scope.conversation_key, namespace);
    }
}

/// THALAMUS's runner fetches the head's catalog on the session's own route with
/// provider params only (`{"params":{"compacting":true},"preset":"head"}`, no
/// composition), then calls tools naming `preset: "head"` at the top level.
/// WERNI's first `ctx_reduce` was refused `unknown_tool` on exactly this path.
#[tokio::test]
async fn a_compacting_runner_head_fetched_with_params_only_serves_ctx_reduce() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::without_setup(
        dir.path(),
        "thalamus-harness",
        ("opencode", CANARY_SESSION),
        ("opencode", CANARY_SESSION),
        |h| {
            let mut binding = h.facade_binding(7).unwrap();
            binding.project_root = CANARY_ROOT.into();
            h.bind_route(7, binding);
            h.store
                .get()
                .unwrap()
                .set_route_identity_for_test(CANARY_ROOT, "git:canary");
        },
    )
    .await;
    let setup = rig.op("compaction.setup", json!({
        "session":CANARY_SESSION, "harness":"opencode", "request_id":"first-setup", "model":"fixture",
        "context_window":100_000, "composition":{"render_tags":true},
        "params":{"serializer_profile":"opencode-aisdk"}, "lineage_id":"L", "now":1
    })).await;
    assert_eq!(setup["answer"], "ready", "{setup}");
    let catalog = outcome(
        rig.h
            .dispatch_value(
                7,
                json!({"name":"tool.catalog","arguments":{"params":{"compacting":true},"preset":"head"}}),
            )
            .await,
    );
    let names = catalog["tools"]
        .as_array()
        .unwrap_or_else(|| panic!("{catalog}"))
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_owned())
        .collect::<BTreeSet<_>>();
    assert!(names.contains("ctx_reduce"), "{names:?}");
    for (name, arguments) in [
        ("ctx_reduce", json!({"drop":"1"})),
        ("ctx_expand", json!({"message":0})),
    ] {
        let answer = outcome(
            rig.h
                .dispatch_value(
                    7,
                    json!({"name":name,"arguments":arguments,"tool_call_id":"t1","preset":"head"}),
                )
                .await,
        );
        assert_ne!(answer["code"], "unknown_tool", "{name}: {answer}");
        assert_ne!(answer["code"], "compaction_inactive", "{name}: {answer}");
    }
}

/// WERNI's live refusal (`frozen=false compacting=false record_exists=true`):
/// core fetches the head's catalog through its own preflight session, so the
/// hosted session has no frozen catalog, yet its calls name `preset: "head"`.
/// A session with a compaction record must be served the compacting tools.
#[tokio::test]
async fn a_compacting_runner_head_without_its_own_catalog_serves_ctx_reduce() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::without_setup(
        dir.path(),
        "thalamus-harness",
        ("opencode", CANARY_SESSION),
        ("opencode", CANARY_SESSION),
        |h| {
            let mut binding = h.facade_binding(7).unwrap();
            binding.project_root = CANARY_ROOT.into();
            h.bind_route(7, binding);
            h.store
                .get()
                .unwrap()
                .set_route_identity_for_test(CANARY_ROOT, "git:canary");
        },
    )
    .await;
    let setup = rig.op("compaction.setup", json!({
        "session":CANARY_SESSION, "harness":"opencode", "request_id":"first-setup", "model":"fixture",
        "context_window":100_000, "composition":{"render_tags":true},
        "params":{"serializer_profile":"opencode-aisdk"}, "lineage_id":"L", "now":1
    })).await;
    assert_eq!(setup["answer"], "ready", "{setup}");
    // The live precondition: no catalog was ever fetched for this session.
    let binding = rig.h.facade_binding(7).unwrap();
    assert!(rig.h.provider_store.catalog(&binding).unwrap().is_none());
    assert!(rig.h.frozen_tool_catalogs.lock().unwrap().is_empty());
    assert!(rig.h.facade_compaction_record_exists(&binding));
    for name in ["ctx_reduce", "ctx_expand"] {
        let checked = rig
            .h
            .check_catalog_call(7, name, &json!({"name": name, "preset": "head"}));
        assert!(checked.is_ok(), "{name}: {checked:?}");
    }
}

#[tokio::test]
async fn unattested_plain_head_routes_still_refuse_and_claude_keeps_wrapper_message() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::without_setup(
        dir.path(),
        "thalamus-harness",
        ("opencode", CANARY_SESSION),
        ("opencode", CANARY_SESSION),
        |_| {},
    )
    .await;
    for harness in ["runner", "opencode", "claude-code"] {
        for principal in [
            None,
            Some(subc_protocol::Principal::Reserved {
                module_id: "not-a-runner".into(),
            }),
        ] {
            let mut binding = rig.h.facade_binding(7).unwrap();
            binding.harness = harness.into();
            binding.principal = principal;
            rig.h.bind_route(8, binding);
            for (name, arguments) in [
                ("ctx_search", json!({"query":"canary head"})),
                (
                    "ctx_memory",
                    json!({"action":"write", "category":"CONSTRAINTS", "content":"refused"}),
                ),
                ("ctx_note", json!({"action":"write", "content":"refused"})),
            ] {
                let refusal = rig.tool(8, name, arguments).await;
                assert_eq!(refusal["code"], "session_unresolved", "{refusal}");
                let message = refusal["message"].as_str().unwrap();
                if harness == "claude-code" {
                    assert_eq!(message, SESSION_UNRESOLVED_MESSAGE);
                } else {
                    assert!(!message.contains("Claude Code"), "{message}");
                }
            }
        }
    }
    assert!(rig
        .h
        .store
        .get()
        .unwrap()
        .get_visible_memories_by_ids(dir.path().to_str().unwrap(), &[1])
        .unwrap()
        .is_empty());
}

#[derive(Clone, Default)]
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

#[tokio::test(flavor = "current_thread")]
async fn facade_refusals_log_once_with_route_attestation_and_record_presence() {
    use tracing::instrument::WithSubscriber;

    const CHILD: &str = "MC_FACADE_REFUSAL_LOG_CAPTURE";
    if std::env::var_os(CHILD).is_none() {
        // Run separately so other tests' tracing state cannot affect the log count.
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "providers::async_provider::tests::plain_head_tools::facade_refusals_log_once_with_route_attestation_and_record_presence",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "stdout: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }

    let capture = Capture::default();
    let writer = capture.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_ansi(false)
        .without_time()
        .with_max_level(tracing::Level::INFO)
        .with_writer(move || writer.clone())
        .finish();
    async {
        let dir = tempfile::tempdir().unwrap();
        let rig = Rig::without_setup(
            dir.path(),
            "thalamus-harness",
            ("opencode", "s"),
            ("opencode", "s"),
            |_| {},
        )
        .await;
        rig.bind(8, "opencode", "s");
        assert_eq!(
            rig.tool(8, "ctx_search", json!({"query":"canary"})).await["code"],
            "session_unresolved"
        );
        assert_eq!(
            rig.tool(7, "ctx_expand", json!({"message":0})).await["code"],
            "compaction_inactive"
        );
        let setup = rig
            .op(
                "compaction.setup",
                json!({
                    "session":"s", "harness":"opencode", "request_id":"setup", "model":"fixture",
                    "context_window":100_000, "composition":{"render_tags":true},
                    "params":{"serializer_profile":"opencode-aisdk"}, "lineage_id":"L", "now":1
                }),
            )
            .await;
        assert_eq!(setup["answer"], "ready", "{setup}");
        assert_eq!(rig.tool(7, "ctx_search", json!({})).await["isError"], true);
    }
    .with_subscriber(subscriber)
    .await;
    let logs = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
    let refusals = logs
        .lines()
        .filter(|line| line.contains("mc-module: facade refusal"))
        .collect::<Vec<_>>();
    assert_eq!(refusals.len(), 3, "{logs}");
    for (line, code, attested, record) in [
        (refusals[0], "session_unresolved", false, false),
        (refusals[1], "compaction_inactive", true, false),
        (refusals[2], "tool_error", true, true),
    ] {
        assert!(line.contains(&format!("code={code}")), "{line}");
        assert!(line.contains("harness=opencode"), "{line}");
        assert!(line.contains(&format!("attested={attested}")), "{line}");
        assert!(line.contains(&format!("record_exists={record}")), "{line}");
    }
}
