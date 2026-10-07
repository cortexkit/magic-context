use super::*;
use std::collections::VecDeque;

#[derive(Default)]
struct Runner {
    pages: Mutex<VecDeque<Value>>,
    calls: Mutex<Vec<(String, Value)>>,
    durable: Mutex<Option<(Arc<Storage>, Key)>>,
    ready: Notify,
}

#[async_trait]
impl session_resolver::ProviderRunner for Runner {
    async fn call(
        &self,
        _: &Path,
        _: &str,
        method: &str,
        params: Value,
        _: Duration,
    ) -> Result<Value, SessionResolveError> {
        self.calls
            .lock()
            .unwrap()
            .push((method.into(), params.clone()));
        if method == "compaction.ready" {
            if let Some((storage, key)) = &*self.durable.lock().unwrap() {
                let record = storage.load(key).unwrap();
                assert!(record.wait_request.is_none());
                assert!(
                    record.wait_view.is_some(),
                    "ready must follow durable replacement work"
                );
                assert_eq!(
                    record.last_answer.as_ref().unwrap()["request_id"],
                    params["request_id"]
                );
            }
            self.ready.notify_one();
            return Ok(json!({}));
        }
        self.pages
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| SessionResolveError::Transport("scripted read failed".into()))
    }
}

fn handler(dir: &Path, runner: Arc<Runner>) -> McHandler {
    let path = dir.join("store.db");
    let descriptor = StorageDescriptor {
        module_id: DEFAULT_MODULE_ID.into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: path.to_string_lossy().into(),
        },
    };
    let store = Arc::new(McStore::open_for_test(&descriptor).unwrap());
    let mut handler = McHandler::new();
    handler.store.set(store).ok().unwrap();
    handler.provider_runner = runner;
    for (channel, session) in [(7, "project-route"), (8, "s"), (9, "unknown")] {
        handler.bind_route(
            channel,
            SessionBinding {
                project_root: dir.to_path_buf(),
                harness: session_resolver::RUNNER_BIND_HARNESS.into(),
                session: session.into(),
                model_key: None,
                config: McModuleConfig {
                    inject_docs: false,
                    protected_tokens_user: Some(0),
                    protected_tools: BTreeMap::new(),
                    ..Default::default()
                },
                history_budget_tokens: 4_000.0,
            },
        );
    }
    handler
}

fn key(handler: &McHandler, session: &str, harness: &str) -> Key {
    Key::new(&handler.facade_binding(7).unwrap(), session, harness).unwrap()
}

fn setup(session: &str, preset: &str) -> Value {
    json!({"session":session,"harness":"broca","request_id":"setup","preset":preset,"params":{},"composition":{},"model":"fixture","context_window":100_000,"now":1,"lineage_id":"L"})
}

fn step(session: &str, messages: Vec<Value>, newest: Option<u64>) -> Value {
    let mut value = json!({"session":session,"harness":"broca","request_id":"step","lineage_id":"L","step_id":"st","step_kind":"user_turn","model":"fixture",
        "context_window":100_000,"estimate":{"request_tokens":1_000},"messages":messages,"now":2});
    if let Some(ordinal) = newest {
        value["newest"] = json!({"ordinal":ordinal,"mid":format!("m{ordinal}")});
    }
    value
}

fn message(ordinal: u64, role: &str, content: Value) -> Value {
    json!({"ordinal":ordinal,"mid":format!("m{ordinal}"),"message":{"role":role,"content":content}})
}

fn user(ordinal: u64, text: &str) -> Value {
    message(ordinal, "user", json!([{"type":"text","text":text}]))
}
fn call(ordinal: u64, id: &str) -> Value {
    message(
        ordinal,
        "assistant",
        json!([{"type":"tool_call","tool_call_id":id,"tool_name":"read","input":{"path":"a"}}]),
    )
}
fn result(ordinal: u64, id: &str, text: &str) -> Value {
    message(
        ordinal,
        "tool",
        json!([{"type":"tool_result","tool_call_id":id,"output":{"kind":"text","text":text},"is_error":false}]),
    )
}
fn page(messages: Vec<Value>, next: Option<u64>, head: u64) -> Value {
    let mut value = json!({"lineage_id":"L","messages":messages,"head":{"ordinal":head,"mid":format!("m{head}")}});
    if let Some(next) = next {
        value["next_from_ordinal"] = json!(next);
    }
    value
}

fn response(outcome: HandlerOutcome) -> Value {
    let HandlerOutcome::Response(bytes) = outcome else {
        panic!("{outcome:?}");
    };
    serde_json::from_slice(&bytes).unwrap()
}

fn code(outcome: HandlerOutcome) -> String {
    match outcome {
        HandlerOutcome::Error { code, .. } | HandlerOutcome::ErrorWithDetail { code, .. } => code,
        _ => panic!("{outcome:?}"),
    }
}

async fn dispatch(handler: &McHandler, method: &str, params: Value) -> HandlerOutcome {
    handler
        .dispatch_value(7, json!({"method":method,"params":params}))
        .await
}

#[tokio::test]
async fn describe_envelopes_are_identical_and_manifest_methods_are_not_tools() {
    let handler = McHandler::new();
    let HandlerOutcome::Response(tool) = handler
        .dispatch_value(1, json!({"name":"role.describe","arguments":{}}))
        .await
    else {
        panic!("tool describe");
    };
    let HandlerOutcome::Response(method) = dispatch(&handler, "role.describe", json!({})).await
    else {
        panic!("method describe");
    };
    assert_eq!(tool, method);
    let answer: Value = serde_json::from_slice(&tool).unwrap();
    compact::describe::check_describe(&answer).unwrap();
    hooks::describe::check_describe(&answer).unwrap();
    assert_eq!(answer["runner_groups"], json!(["transcript_reads"]));
    assert_eq!(answer["majors"].as_array().unwrap().len(), 3);
    let manifest = manifest(DEFAULT_MODULE_ID);
    let caps = manifest.capabilities.as_ref().unwrap();
    assert_eq!(caps.provides, [compact::PROVIDES, hooks::PROVIDES]);
    assert!(caps.requires.is_empty());
    let ProviderRole::ToolProvider { tools, .. } = &manifest.provides[0] else {
        panic!("tool role");
    };
    for method in [
        "role.describe",
        "compaction.setup",
        "compaction.step",
        "transform.declare",
        "transform.hook",
    ] {
        assert!(!tools.iter().any(|t| t.name == method));
    }
}

#[tokio::test]
async fn provider_methods_refuse_unbound_and_empty_handles_and_missing_harness() {
    let dir = tempfile::tempdir().unwrap();
    let handler = handler(dir.path(), Arc::new(Runner::default()));
    for method in [
        "compaction.setup",
        "compaction.step",
        "transform.declare",
        "transform.hook",
    ] {
        assert_eq!(
            code(
                handler
                    .dispatch_value(66, json!({"method":method,"params":{}}))
                    .await
            ),
            "route_unbound"
        );
    }
    let hook = json!({"session":" ","harness":"broca","hook":"pre_user","blocks":["hi"]});
    for (method, params) in [
        ("compaction.setup", setup(" ", "head")),
        ("compaction.step", step(" ", vec![], None)),
        ("transform.hook", hook),
    ] {
        assert_eq!(
            code(dispatch(&handler, method, params.clone()).await),
            "session_unresolved"
        );
        let mut missing = params;
        missing.as_object_mut().unwrap().remove("harness");
        assert_eq!(
            code(dispatch(&handler, method, missing).await),
            "invalid_params"
        );
    }
    assert_eq!(
        code(
            dispatch(
                &handler,
                "compaction.step",
                step("never-setup", vec![], None)
            )
            .await
        ),
        "setup_missing"
    );
}

#[tokio::test]
async fn setup_is_pure_repeatable_project_bound_and_durable() {
    let dir = tempfile::tempdir().unwrap();
    let handler = handler(dir.path(), Arc::new(Runner::default()));
    let a = response(dispatch(&handler, "compaction.setup", setup(" s ", "head")).await);
    let b = response(dispatch(&handler, "compaction.setup", setup("other", "head")).await);
    assert_eq!(a["answer"], "ready");
    assert_eq!(
        a["stability"],
        json!([{"index":0,"rank":2},{"index":1,"rank":1}])
    );
    assert_eq!(a["stability"], b["stability"]);
    assert_eq!(a["call_when"], b["call_when"]);
    assert_eq!(a["initial"]["replacement"], b["initial"]["replacement"]);
    assert_eq!(
        a["initial"]["replacement"][0]["content"][0]["text"],
        transform::compaction::M0_EMPTY_PLACEHOLDER
    );
    assert_eq!(
        a["initial"]["replacement"][1]["content"][0]["text"],
        transform::compaction::M1_EMPTY_PLACEHOLDER
    );
    for preset in ["worker", "reader"] {
        let reply = response(dispatch(&handler, "compaction.setup", setup(preset, preset)).await);
        assert!(reply.get("stability").is_none());
        assert_eq!(reply["initial"]["replacement"], json!([]));
    }
    let again = response(dispatch(&handler, "compaction.setup", setup("s", "head")).await);
    assert!(
        again["initial"]["version"].as_u64().unwrap() > a["initial"]["version"].as_u64().unwrap()
    );
    let key = key(&handler, "s", "broca");
    let reopened = Storage::new(Arc::clone(&handler.store));
    assert_eq!(
        reopened
            .load(&key)
            .unwrap()
            .setup
            .unwrap()
            .state
            .compaction_id,
        again["initial"]["compaction_id"]
    );
    let mut other_key = key.clone();
    other_key.project = dir.path().join("another-project");
    assert!(reopened.load(&other_key).unwrap().setup.is_none());
    other_key = key.clone();
    other_key.harness = "claude-code".into();
    assert!(reopened.load(&other_key).unwrap().setup.is_none());
    assert_eq!(
        code(
            handler
                .dispatch_value(9, json!({"name":"ctx_reduce","arguments":{"drop":"1"}}))
                .await
        ),
        "session_unresolved"
    );
    assert!(handler
        .provider_store
        .tool_key(&handler.facade_binding(8).unwrap())
        .is_ok());
}

#[tokio::test]
async fn declaration_is_pure_and_first_hook_needs_no_setup() {
    let dir = tempfile::tempdir().unwrap();
    let handler = handler(dir.path(), Arc::new(Runner::default()));
    let declaration = response(dispatch(&handler, "transform.declare", json!({"params":{}})).await);
    let other = response(
        handler
            .dispatch_value(
                8,
                json!({"method":"transform.declare","params":{"params":{}}}),
            )
            .await,
    );
    assert_eq!(declaration, other);
    assert!(handler
        .store
        .get()
        .unwrap()
        .provider_records_for_session(&dir.path().to_string_lossy(), "s")
        .unwrap()
        .is_empty());
    let parsed: hooks::subscription::Declaration = serde_json::from_value(declaration).unwrap();
    for hook in [
        hooks::subscription::Hook::PreUser,
        hooks::subscription::Hook::PostTool,
    ] {
        assert!(parsed
            .subscriptions
            .iter()
            .find(|s| s.hook == hook)
            .unwrap()
            .on_unavailable
            .is_some());
    }
    let reply = response(
        dispatch(
            &handler,
            "transform.hook",
            json!({"session":"s","harness":"broca","hook":"pre_user","blocks":["hi"]}),
        )
        .await,
    );
    assert!(matches!(reply["answer"].as_str(), Some("ops" | "pass")));
    let record = handler
        .provider_store
        .load(&key(&handler, "s", "broca"))
        .unwrap();
    assert!(record.setup.is_none());
    assert!(record.hook.is_some());
}

#[tokio::test]
async fn post_assistant_addresses_text_blocks_and_never_nontext_parts() {
    let dir = tempfile::tempdir().unwrap();
    let handler = handler(dir.path(), Arc::new(Runner::default()));
    let answer=response(dispatch(&handler,"transform.hook",json!({"session":"s","harness":"broca","hook":"post_assistant","step_id":"st","lineage_id":"L","blocks":["§1§ alpha","§2§ beta"]})).await);
    assert_eq!(
        answer,
        json!({"answer":"ops","ops":[{"op":"replace","block":0,"value":"alpha"},{"op":"replace","block":1,"value":"beta"}]})
    );
    let parsed: hooks::answer::HookAnswer = serde_json::from_value(answer).unwrap();
    let hooks::answer::HookAnswer::Ops { ops } = parsed else {
        panic!("ops");
    };
    let mut parts = vec![
        json!({"type":"reasoning","text":"§9§ secret","signature":"signed"}),
        json!({"type":"text","text":"§1§ alpha"}),
        json!({"type":"tool_call","tool_call_id":"id","tool_name":"read","input":{}}),
        json!({"type":"text","text":"§2§ beta"}),
    ];
    let original = parts.clone();
    hooks::answer::apply_to_parts(
        &mut parts,
        |v| {
            if v["type"] == "text" {
                v.get_mut("text").and_then(|v| {
                    if let Value::String(s) = v {
                        Some(s)
                    } else {
                        None
                    }
                })
            } else {
                None
            }
        },
        &ops,
    )
    .unwrap();
    assert_eq!(parts[0], original[0]);
    assert_eq!(parts[2], original[2]);
    assert_eq!(parts[1]["text"], "alpha");
    assert_eq!(parts[3]["text"], "beta");
}

#[test]
fn broca_real_messages_round_trip_byte_exactly() {
    let entries: Vec<compact::status::StatusMessage> = serde_json::from_str(include_str!(
        "../../../../docs/designs/mc-tool-catalog-v1/broca-session-read-messages.json"
    ))
    .unwrap();
    assert_eq!(entries.len(), 3);
    for entry in entries {
        let decoded = decode_message(&entry).unwrap();
        let encoded = encode_message(&decoded.ck).unwrap();
        assert_eq!(
            serde_json::to_vec(&encoded).unwrap(),
            serde_json::to_vec(&entry.message).unwrap(),
            "{}",
            entry.mid
        );
    }
}

#[test]
fn codec_rejects_unknown_fields_and_blocks_instead_of_dropping_them() {
    for content in [
        json!([{"type":"future","text":"a"}]),
        json!([{"type":"text","text":"a","future":true}]),
        json!([{"type":"tool_result","tool_call_id":"x","output":{"kind":"text","text":"a","future":true},"is_error":false}]),
    ] {
        let entry = serde_json::from_value(message(0, "user", content)).unwrap();
        assert!(decode_message(&entry).is_err());
    }
}

fn view(messages: Vec<Value>) -> compact::answer::CompactionMessage {
    compact::answer::CompactionMessage::new(
        "compact",
        1,
        compact::answer::Range::new(0, 0),
        messages,
    )
}

#[test]
fn validator_refuses_authored_cache_prefix_blocks() {
    let mut authored = user(0, "summary")["message"].clone();
    authored["cache_prefix_blocks"] = json!(1);
    assert!(validate_replacement(&view(vec![authored]), &Record::default(), "L").is_err());
}

#[test]
fn validator_preserves_carried_origin_and_omits_authored_origin() {
    let mut carried = user(0, "summary");
    carried["message"]["origin"] = json!({"provider_module_id":"fixture","model_id":"m"});
    let entry: compact::status::StatusMessage = serde_json::from_value(carried).unwrap();
    let decoded = decode_message(&entry).unwrap();
    assert_eq!(encode_message(&decoded.ck).unwrap(), entry.message);
    let mut changed = decoded.ck;
    changed.content = vec![ck_wire::CkWireBlock::bare(ck_wire::CkKind::Text {
        text: "changed".into(),
    })];
    changed.mark_modified();
    assert!(encode_message(&changed).unwrap().get("origin").is_none());
    assert!(
        validate_replacement(&view(vec![entry.message.clone()]), &Record::default(), "L").is_err()
    );
    let mut record = Record::default();
    ingest(&mut record, "L", std::slice::from_ref(&entry)).unwrap();
    assert!(validate_replacement(&view(vec![entry.message]), &record, "L").is_ok());
}

#[test]
fn validator_refuses_authored_signed_or_encrypted_reasoning() {
    for block in [
        json!({"type":"reasoning","text":"secret","signature":"sig"}),
        json!({"type":"redacted_reasoning","data":"encrypted"}),
    ] {
        let authored = message(0, "assistant", json!([block]))["message"].clone();
        assert!(validate_replacement(&view(vec![authored]), &Record::default(), "L").is_err());
    }
}

#[test]
fn validator_refuses_system_messages() {
    assert!(validate_replacement(
        &view(vec![
            user(0, "summary")["message"].clone(),
            message(1, "system", json!([{"type":"text","text":"system"}]))["message"].clone()
        ]),
        &Record::default(),
        "L"
    )
    .is_err());
}

#[test]
fn validator_refuses_missing_reversed_and_interrupted_tool_pairs() {
    let call = call(0, "id")["message"].clone();
    let result = result(1, "id", "output")["message"].clone();
    for messages in [
        vec![call.clone()],
        vec![result.clone(), call.clone()],
        vec![
            call.clone(),
            user(1, "interrupt")["message"].clone(),
            result.clone(),
        ],
    ] {
        assert!(validate_replacement(&view(messages), &Record::default(), "L").is_err());
    }
    assert!(validate_replacement(&view(vec![call, result]), &Record::default(), "L").is_ok());
}

#[tokio::test]
async fn tags_become_live_on_second_page_and_drops_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let runner = Arc::new(Runner::default());
    let handler = handler(dir.path(), runner.clone());
    response(dispatch(&handler, "compaction.setup", setup("s", "head")).await);
    let hook=response(dispatch(&handler,"transform.hook",json!({"session":"s","harness":"broca","lineage_id":"L","hook":"post_tool","step_id":"st","tool":"read","tool_call_id":"id","blocks":["payload"],"is_error":false})).await);
    assert_eq!(hook["ops"][0]["text"], "§1§ ");
    assert!(runner.calls.lock().unwrap().is_empty());
    let key = key(&handler, "s", "broca");
    assert!(handler
        .provider_store
        .load(&key)
        .unwrap()
        .hook
        .unwrap()
        .live
        .is_empty());
    runner.pages.lock().unwrap().extend([
        page(vec![user(0, "hi"), call(1, "id")], Some(2), 2),
        page(vec![result(2, "id", "§1§ payload")], None, 2),
    ]);
    let accepted = response(
        handler
            .dispatch_value(8, json!({"name":"ctx_reduce","arguments":{"drop":"1"}}))
            .await,
    );
    assert_eq!(accepted["isError"], false);
    assert_eq!(
        runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|(_, p)| p["from_ordinal"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [0, 2]
    );
    let reopened = Storage::new(Arc::clone(&handler.store));
    let record = reopened.load(&key).unwrap();
    assert_eq!(record.pending_drops, BTreeSet::from([1]));
    assert_eq!(record.hook.unwrap().live[&1].ordinal, 2);
    let low = response(
        dispatch(
            &handler,
            "compaction.step",
            step(
                "s",
                vec![user(0, "hi"), call(1, "id"), result(2, "id", "§1§ payload")],
                Some(2),
            ),
        )
        .await,
    );
    assert_eq!(low["answer"], "noop");
    assert_eq!(
        handler.provider_store.load(&key).unwrap().messages["L"].len(),
        3
    );
    assert!(handler
        .store
        .get()
        .unwrap()
        .load_pending_agent_drops(&key.engine_key())
        .unwrap()
        .iter()
        .any(|p| p.target_id == "m2#0"));
}

#[tokio::test]
async fn incomplete_scan_is_retryable_and_suppresses_cadence_appends() {
    let dir = tempfile::tempdir().unwrap();
    let runner = Arc::new(Runner::default());
    let handler = handler(dir.path(), runner.clone());
    response(
        dispatch(
            &handler,
            "transform.hook",
            json!({"session":"s","harness":"broca","hook":"pre_user","blocks":["hi"]}),
        )
        .await,
    );
    runner
        .pages
        .lock()
        .unwrap()
        .push_back(page(vec![user(0, "hi")], Some(1), 3));
    let error = response(
        handler
            .dispatch_value(8, json!({"name":"ctx_reduce","arguments":{"drop":"999"}}))
            .await,
    );
    assert_eq!(error["isError"], true);
    assert_eq!(error["retryable"], true);
    let hook=response(dispatch(&handler,"transform.hook",json!({"session":"s","harness":"broca","lineage_id":"L","hook":"post_tool","step_id":"st","tool":"read","tool_call_id":"id","blocks":["payload"],"is_error":false,"params":{"reminder_every":1}})).await);
    assert!(hook["ops"]
        .as_array()
        .unwrap()
        .iter()
        .all(|op| op["op"] != "append"));
}

#[tokio::test]
async fn abandoned_hook_tags_are_burned_and_cadence_does_not_advance() {
    let dir = tempfile::tempdir().unwrap();
    let runner = Arc::new(Runner::default());
    let handler = handler(dir.path(), runner.clone());
    runner.pages.lock().unwrap().extend([
        page(vec![user(0, "hi"), call(1, "id")], None, 1),
        page(vec![], None, 1),
    ]);
    let request = json!({"session":"s","harness":"broca","lineage_id":"L","hook":"post_tool","step_id":"st","tool":"read","tool_call_id":"id","blocks":["payload"],"is_error":false,"params":{"reminder_every":1}});
    let first = response(dispatch(&handler, "transform.hook", request.clone()).await);
    let second = response(dispatch(&handler, "transform.hook", request).await);
    assert_eq!(first["ops"][0]["text"], "§1§ ");
    assert_eq!(second["ops"][0]["text"], "§2§ ");
    assert_eq!(first["ops"][1], second["ops"][1]);
    let record = handler
        .provider_store
        .load(&key(&handler, "s", "broca"))
        .unwrap();
    let state = record.hook.unwrap();
    assert!(state.live.is_empty());
    assert!(state.burned.contains(&1));
    assert!(state.last_reminder_at.is_none());
    let error = response(
        handler
            .dispatch_value(8, json!({"name":"ctx_reduce","arguments":{"drop":"1"}}))
            .await,
    );
    assert_eq!(error["isError"], true);
    assert_eq!(runner.calls.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn wait_ready_names_request_only_after_durable_work_and_versions_resume() {
    let dir = tempfile::tempdir().unwrap();
    let runner = Arc::new(Runner::default());
    let handler = handler(dir.path(), runner.clone());
    let initial = response(dispatch(&handler, "compaction.setup", setup("s", "head")).await);
    let key = key(&handler, "s", "broca");
    *runner.durable.lock().unwrap() = Some((Arc::clone(&handler.provider_store), key.clone()));
    handler
        .store
        .get()
        .unwrap()
        .replace_compartments(
            &key.engine_key(),
            &[StoredCompartment {
                sequence: 1,
                start_message: 0,
                end_message: 0,
                end_message_id: "m0#0".into(),
                title: "history".into(),
                content: "PUBLISHED".into(),
                p1: Some("PUBLISHED".into()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
    runner
        .pages
        .lock()
        .unwrap()
        .push_back(page(vec![user(1, "second")], None, 1));
    let mut request = step("s", vec![user(0, "first")], Some(1));
    request["more"] = json!(true);
    request["prefix_rebuilding"] = json!({"reason":"flush"});
    request["last_applied"] =
        json!({"compaction_id":initial["initial"]["compaction_id"],"version":50});
    let waited = response(dispatch(&handler, "compaction.step", request).await);
    assert_eq!(waited["answer"], "wait");
    assert!(waited["bound_ms"].as_u64().unwrap() <= 1_000);
    tokio::time::timeout(Duration::from_secs(5), runner.ready.notified())
        .await
        .unwrap();
    {
        let calls = runner.calls.lock().unwrap();
        assert_eq!(calls.last().unwrap().0, "compaction.ready");
        assert_eq!(calls.last().unwrap().1["request_id"], "step");
    }
    let record = handler.provider_store.load(&key).unwrap();
    assert!(record.setup.unwrap().state.version_high_water > 50);
    let mut request = step("s", vec![], Some(1));
    request["request_id"] = json!("fresh");
    request["prefix_rebuilding"] = json!({"reason":"flush"});
    let reply = response(dispatch(&handler, "compaction.step", request).await);
    assert_eq!(reply["answer"], "compaction_message");
    assert!(reply["compaction"]["version"].as_u64().unwrap() > 50);
}

#[test]
fn fault_points_match_the_pinned_role_vocabulary() {
    let mut expected = compact::points::ALL.to_vec();
    expected.extend_from_slice(hooks::points::ALL);
    assert_eq!(FAULT_POINTS, expected);
}

#[test]
fn every_declared_hook_is_advisory_and_within_broca_budget_cap() {
    use hooks::subscription::OnUnavailable;
    for preset in ["head", "worker", "reader"] {
        for composition in [
            None,
            Some(json!({"compaction":{"provider":DEFAULT_MODULE_ID}})),
            Some(json!({"compaction":{"provider":"another-provider"}})),
        ] {
            let mut request = json!({"preset":preset,"params":{}});
            if let Some(composition) = composition {
                request["composition"] = composition;
            }
            let declared = declaration(&request).unwrap();
            assert!(!declared.subscriptions.is_empty());
            for subscription in declared.subscriptions {
                // Broca refuses plans above 30 seconds. MC edits are advisory:
                // an unavailable hook must leave the subject unchanged, not fail
                // a user turn over tagging, stripping or reminder optimisation.
                assert!(
                    subscription.budget_ms > 0 && subscription.budget_ms <= 30_000,
                    "{preset}: {subscription:?}"
                );
                assert_eq!(
                    subscription.on_unavailable,
                    Some(OnUnavailable::Pass),
                    "{preset}: {subscription:?}"
                );
            }
        }
    }
}

#[tokio::test]
async fn catalog_and_hook_high_water_survive_a_fresh_handler() {
    let dir = tempfile::tempdir().unwrap();
    let runner = Arc::new(Runner::default());
    {
        let handler = handler(dir.path(), runner.clone());
        let request: Value = serde_json::from_str(include_str!(
            "../../../../docs/designs/mc-tool-catalog-v1/worker.request.json"
        ))
        .unwrap();
        let catalog = response(
            handler
                .dispatch_value(8, json!({"name":"tool.catalog","arguments":request}))
                .await,
        );
        assert!(catalog["tools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["name"] != "ctx_memory"));
        response(dispatch(&handler,"transform.hook",json!({"session":"s","harness":"broca","lineage_id":"L","hook":"post_tool","step_id":"st","tool":"read","tool_call_id":"id","blocks":["old"],"is_error":false})).await);
        handler.unbind_route(8);
    }
    let handler = handler(dir.path(), runner);
    assert!(handler.frozen_tool_catalogs.lock().unwrap().is_empty());
    assert_eq!(
        code(
            handler
                .dispatch_value(
                    8,
                    json!({"name":"ctx_memory","arguments":{"action":"list"}})
                )
                .await
        ),
        "unknown_tool"
    );
    let answer=response(dispatch(&handler,"transform.hook",json!({"session":"s","harness":"broca","lineage_id":"L","hook":"post_tool","step_id":"next","tool":"read","tool_call_id":"next-id","blocks":["new"],"is_error":false})).await);
    assert_eq!(answer["ops"][0]["text"], "§2§ ");
    let record = handler
        .provider_store
        .load(&key(&handler, "s", "broca"))
        .unwrap();
    assert_eq!(record.hook.unwrap().answers.len(), 2);
    assert!(record.catalog.unwrap().compacting);
}

#[tokio::test]
async fn reminder_on_second_page_is_observed_once_and_no_read_when_not_due() {
    let dir = tempfile::tempdir().unwrap();
    let runner = Arc::new(Runner::default());
    let handler = handler(dir.path(), runner.clone());
    let key = key(&handler, "s", "broca");
    let mut history = vec![user(0, "hi")];
    for n in 0..4 {
        history.push(call(n * 2 + 1, &format!("old-{n}")));
        history.push(result(n * 2 + 2, &format!("old-{n}"), "old output"));
    }
    history.push(message(
        9,
        "assistant",
        json!([
            {"type":"tool_call","tool_call_id":"id","tool_name":"read","input":{}},
            {"type":"tool_call","tool_call_id":"other","tool_name":"read","input":{}}
        ]),
    ));
    let mut record = Record {
        hook: Some(HookState::default()),
        ..Default::default()
    };
    ingest(
        &mut record,
        "L",
        &decode::<Vec<compact::status::StatusMessage>>(&json!(history)).unwrap(),
    )
    .unwrap();
    handler.provider_store.save(&key, &record).unwrap();
    runner
        .pages
        .lock()
        .unwrap()
        .push_back(page(vec![], None, 9));
    let request = json!({"session":"s","harness":"broca","lineage_id":"L","hook":"post_tool","step_id":"st","tool":"read","tool_call_id":"id","blocks":["payload"],"is_error":false});
    let first = response(dispatch(&handler, "transform.hook", request).await);
    let ops: Vec<hooks::answer::Operation> = serde_json::from_value(first["ops"].clone()).unwrap();
    let rendered = hooks::answer::apply_ops(&["payload".into()], &ops).unwrap();
    runner.pages.lock().unwrap().extend([
        page(vec![result(10, "other", "unrelated")], Some(11), 11),
        page(vec![result(11, "id", &rendered[0])], None, 11),
    ]);
    // A future request can conservatively think the reminder is due. The
    // read discovers the prior applied append before deciding to emit it.
    let request = json!({"session":"s","harness":"broca","lineage_id":"L","hook":"post_tool","step_id":"next","tool":"read","tool_call_id":"next","blocks":["new"],"is_error":false});
    let second = response(dispatch(&handler, "transform.hook", request.clone()).await);
    assert!(second["ops"]
        .as_array()
        .unwrap()
        .iter()
        .all(|op| op["op"] != "append"));
    let count = runner.calls.lock().unwrap().len();
    let third = response(dispatch(&handler, "transform.hook", request).await);
    assert!(third["ops"]
        .as_array()
        .unwrap()
        .iter()
        .all(|op| op["op"] != "append"));
    assert_eq!(runner.calls.lock().unwrap().len(), count);
    let state = handler.provider_store.load(&key).unwrap().hook.unwrap();
    assert_eq!(state.observed_tools, 6);
    assert_eq!(state.last_reminder_at, Some(6));
}

#[test]
fn validator_keeps_carried_cache_markers_but_refuses_unknown_output_fields() {
    let mut entry: compact::status::StatusMessage = serde_json::from_value(user(0, "raw")).unwrap();
    entry.message["cache_prefix_blocks"] = json!(1);
    let mut record = Record::default();
    ingest(&mut record, "L", std::slice::from_ref(&entry)).unwrap();
    let carried = encode_message(&decode_message(&entry).unwrap().ck).unwrap();
    assert_eq!(carried["cache_prefix_blocks"], 1);
    assert!(validate_replacement(&view(vec![carried]), &record, "L").is_ok());
    let mut unknown = user(1, "authored")["message"].clone();
    unknown["content"][0]["future"] = json!(true);
    assert!(validate_replacement(&view(vec![unknown]), &record, "L").is_err());
}

#[tokio::test]
async fn allocated_unsent_work_is_retried_above_its_version_without_runner_rejection() {
    let dir = tempfile::tempdir().unwrap();
    let runner = Arc::new(Runner::default());
    let handler = handler(dir.path(), runner);
    let initial = response(dispatch(&handler, "compaction.setup", setup("s", "head")).await);
    let key = key(&handler, "s", "broca");
    handler
        .store
        .get()
        .unwrap()
        .replace_compartments(
            &key.engine_key(),
            &[StoredCompartment {
                sequence: 1,
                start_message: 0,
                end_message: 0,
                end_message_id: "m0#0".into(),
                title: "history".into(),
                content: "PUBLISHED".into(),
                p1: Some("PUBLISHED".into()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
    let applied = json!({"compaction_id":initial["initial"]["compaction_id"],"version":initial["initial"]["version"]});
    let mut first = step("s", vec![user(0, "old"), user(1, "tail")], Some(1));
    first["prefix_rebuilding"] = json!({"reason":"flush"});
    first["last_applied"] = applied.clone();
    let allocated = response(dispatch(&handler, "compaction.step", first).await);
    assert_eq!(allocated["answer"], "compaction_message");
    // Drop the answer as a runner would at AnswerRecorded: its next
    // status knows only the previously applied view, not this version.
    let mut low = step("s", vec![], Some(1));
    low["request_id"] = json!("after-kill-low");
    low["last_applied"] = applied.clone();
    assert_eq!(
        response(dispatch(&handler, "compaction.step", low).await)["answer"],
        "noop"
    );
    let mut high = step("s", vec![], Some(1));
    high["request_id"] = json!("after-kill-high");
    high["last_applied"] = applied;
    high["previous_usage"] = json!({"input":1,"cache_read":70_000});
    let retried = response(dispatch(&handler, "compaction.step", high).await);
    assert_eq!(retried["answer"], "compaction_message");
    assert!(
        retried["compaction"]["version"].as_u64().unwrap()
            > allocated["compaction"]["version"].as_u64().unwrap()
    );
    assert_eq!(
        retried["compaction"]["replacement"],
        allocated["compaction"]["replacement"]
    );
    assert_eq!(
        handler.provider_store.load(&key).unwrap().messages["L"].len(),
        2
    );
}
