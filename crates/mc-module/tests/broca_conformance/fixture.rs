use super::{harness::*, *};
use std::{collections::BTreeMap, fs};

fn exchange(
    name: &str,
    call: &str,
    method: &str,
    params: Value,
    answer: Value,
    expected_view: Value,
) -> Value {
    json!({"name":name,"call":call,"request":{"method":method,"params":params},"answer":answer,"expected_view":expected_view})
}

fn lf_json(value: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec_pretty(value).unwrap();
    bytes.push(b'\n');
    bytes
}

const FIXTURE_ID: &str = "mc-joint-v1";

// Compaction IDs are opaque but include the real temporary root in their hash.
// Normalize only that identifier; message, range and operation bytes stay real.
fn map_id(value: &mut Value, from: &str, to: &str) {
    match value {
        Value::Array(values) => values.iter_mut().for_each(|v| map_id(v, from, to)),
        Value::Object(values) => {
            for (key, value) in values {
                if key == "compaction_id" && value == from {
                    *value = json!(to);
                } else {
                    map_id(value, from, to);
                }
            }
        }
        _ => {}
    }
}

async fn generate() -> BTreeMap<&'static str, Vec<u8>> {
    let rig = Rig::start(None, false).await;
    let identity = rig.identity(SESSION);
    let mixed: Vec<_> = hooks::mixed_parts()
        .into_iter()
        .filter(|p| p["type"] != "image")
        .collect();
    let mut messages = vec![
        user(0, "joint user"),
        message(1, "assistant", json!(mixed)),
        message(
            2,
            "tool",
            json!([{"type":"tool_result","tool_call_id":"untouched","output":{"kind":"text","text":"joint tool result"},"is_error":false}]),
        ),
    ];
    let transcript =
        json!({"project_root":PROJECT,"session":SESSION,"harness":"broca","messages":messages});
    let mut cases = Vec::new();
    let ready = rig
        .method(&identity, "compaction.setup", setup(SESSION))
        .await;
    assert_eq!(ready["answer"], "ready");
    let native_id = ready["initial"]["compaction_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let view = ready["initial"].clone();
    cases.push(exchange(
        "setup-initial",
        "setup",
        "compaction.setup",
        setup(SESSION),
        ready,
        serde_json::from_slice(&render(&view, &[])).unwrap(),
    ));
    let request = hooks::post_assistant(SESSION);
    let answer = rig
        .method(&identity, "transform.hook", request.clone())
        .await;
    let parts = hooks::apply(&mixed, &answer);
    messages[1]["message"]["content"] = json!(parts);
    cases.push(exchange(
        "tag-strip-mixed",
        "step",
        "transform.hook",
        request,
        answer,
        messages[1]["message"].clone(),
    ));
    let request = hooks::pre_user(SESSION);
    let answer = rig
        .method(&identity, "transform.hook", request.clone())
        .await;
    let subjects = vec![
        json!({"type":"text","text":"first new block"}),
        json!({"type":"text","text":"last new block"}),
    ];
    let updated = hooks::apply(&subjects, &answer);
    cases.push(exchange(
        "reminder-last-text-block",
        "step",
        "transform.hook",
        request,
        answer,
        json!({"role":"user","content":updated}),
    ));
    rig.script.transcript(messages.clone());
    let request = step(SESSION, "noop", &messages, 1000, &view);
    let answer = rig
        .method(&identity, "compaction.step", request.clone())
        .await;
    assert_eq!(answer["answer"], "noop");
    cases.push(exchange(
        "noop-keeps-view",
        "step",
        "compaction.step",
        request,
        answer,
        serde_json::from_slice(&render(&view, &messages)).unwrap(),
    ));
    let disabled = Rig::start(None, true).await;
    let mut request = setup(SESSION);
    request["request_id"] = json!("known-refusal");
    let answer = disabled
        .method(
            &disabled.identity(SESSION),
            "compaction.setup",
            request.clone(),
        )
        .await;
    assert_eq!(answer["answer"], "refuse");
    cases.push(exchange(
        "known-refusal",
        "setup",
        "compaction.setup",
        request.clone(),
        answer,
        json!([]),
    ));
    request["request_id"] = json!("unknown-refusal");
    // MC does not emit unknown refusal codes. Construct one for the caller's
    // decoder test, using the same serialized answer type as MC's refusals.
    let unknown = compact::setup::SetupAnswer::Refuse {
        request_id: "unknown-refusal".into(),
        code: compact::errors::RefuseCode::Unknown("future_provider_reason".into()),
        reason: "Caller compatibility control".into(),
        provider_code: Some("joint_unknown_control".into()),
    };
    cases.push(exchange(
        "unknown-refusal-control",
        "setup",
        "compaction.setup",
        request,
        serde_json::to_value(unknown).unwrap(),
        json!([]),
    ));
    let oversized = user(3, &"large-text ".repeat(820));
    messages.push(oversized);
    let request = step(SESSION, "oversized", &messages, 1000, &view);
    let answer = rig
        .method(&identity, "compaction.step", request.clone())
        .await;
    assert_eq!(answer["answer"], "noop");
    cases.push(exchange(
        "oversized-text-keeps-view",
        "step",
        "compaction.step",
        request,
        answer,
        serde_json::from_slice(&render(&view, &messages)).unwrap(),
    ));
    rig.script.transcript(messages.clone());
    let page = rig
        .consumer
        .call(
            subc_protocol::RouteTarget::ManagementSurface {
                module_id: "broca".into(),
            },
            identity,
            serde_json::to_vec(
                &json!({"method":"session.read","params":{"from_ordinal":3,"max_bytes":256}}),
            )
            .unwrap(),
            options(),
        )
        .await
        .unwrap();
    let page: Value = serde_json::from_slice(&page).unwrap();
    assert_eq!(
        page["messages"].as_array().unwrap().len(),
        1,
        "a message beyond the cap is sent alone"
    );
    assert_eq!(page["messages"][0], messages[3]);
    assert!(serde_json::to_vec(&page["messages"][0]).unwrap().len() > 256);
    assert!(page.get("next_from_ordinal").is_none());
    let mut cases = json!(cases);
    map_id(&mut cases, &native_id, FIXTURE_ID);
    BTreeMap::from([
        ("transcript.json",lf_json(&transcript)),
        ("exchanges.json",lf_json(&cases)),
        ("README.md",concat!(
            "setup-initial: Fresh runner-bound Setup produces the real ck-mc initial view.\n",
            "tag-strip-mixed: Step transform replaces one text block; reasoning, signature and tool-call bytes stay unchanged.\n",
            "reminder-last-text-block: Step transform appends the reminder to the last existing text block.\n",
            "noop-keeps-view: A below-threshold compaction step preserves the rendered view.\n",
            "known-refusal: Disabled compaction returns misconfigured at Setup without retryable.\n",
            "unknown-refusal-control: Pinned role encoder supplies a forward-compatible caller control; ck-mc does not emit this code.\n",
            "oversized-text-keeps-view: A 9020-byte text exceeds the 256-byte paging control cap; the real provider accepts it and preserves the view.\n"
        ).as_bytes().to_vec()),
    ])
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn joint_fixture_committed_bytes_match_real_encoder() {
    let generated = generate().await;
    let dir = fixture_dir();
    if std::env::var_os("MC_WRITE_JOINT_FIXTURE").as_deref() == Some(std::ffi::OsStr::new("1")) {
        fs::create_dir_all(&dir).unwrap();
        for (name, bytes) in &generated {
            fs::write(dir.join(name), bytes).unwrap();
        }
    }
    for (name, bytes) in generated {
        assert!(!bytes.contains(&b'\r'), "{name} must use LF endings");
        assert!(
            fs::read(dir.join(name)).unwrap() == bytes,
            "{name} differs; run the documented fixture generator"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn joint_fixture_replays_real_routes_and_unknown_refusal_decodes_without_retry() {
    let dir = fixture_dir();
    let transcript: Value =
        serde_json::from_slice(&fs::read(dir.join("transcript.json")).unwrap()).unwrap();
    let cases: Vec<Value> =
        serde_json::from_slice(&fs::read(dir.join("exchanges.json")).unwrap()).unwrap();
    assert_eq!(transcript["project_root"], PROJECT);
    assert_eq!(transcript["session"], SESSION);
    assert_eq!(transcript["harness"], "broca");
    let rig = Rig::start(None, false).await;
    let disabled = Rig::start(None, true).await;
    let identity = rig.identity(SESSION);
    rig.script
        .transcript(transcript["messages"].as_array().unwrap().clone());
    let mut view = Value::Null;
    let mut native_id = String::new();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let mut request = case["request"].clone();
        map_id(&mut request, FIXTURE_ID, &native_id);
        let mut actual = match name {
            "unknown-refusal-control" => {
                let answer: compact::setup::SetupAnswer =
                    serde_json::from_value(case["answer"].clone()).unwrap();
                let compact::setup::SetupAnswer::Refuse { code, .. } = answer else {
                    panic!("unknown refusal control");
                };
                assert!(matches!(code, compact::errors::RefuseCode::Unknown(_)));
                assert!(
                    !code.retryable(),
                    "an unknown refusal must never enter retry policy"
                );
                case["answer"].clone()
            }
            "known-refusal" => {
                disabled
                    .call(&disabled.identity(SESSION), request.clone())
                    .await
            }
            _ => rig.call(&identity, request.clone()).await,
        };
        if actual["answer"] == "ready" {
            native_id = actual["initial"]["compaction_id"].as_str().unwrap().into();
        }
        map_id(&mut actual, &native_id, FIXTURE_ID);
        assert_eq!(actual, case["answer"], "{name}");
        assert!(
            actual.get("retryable").is_none(),
            "retryability belongs to the role code, not the wire answer"
        );
        let expected = match request["method"].as_str().unwrap() {
            "compaction.setup" if actual["answer"] == "ready" => {
                view = actual["initial"].clone();
                serde_json::from_slice(&render(&view, &[])).unwrap()
            }
            "compaction.setup" => json!([]),
            "compaction.step" => serde_json::from_slice(&render(
                &view,
                request["params"]["messages"].as_array().unwrap(),
            ))
            .unwrap(),
            "transform.hook" if name == "tag-strip-mixed" => {
                json!({"role":"assistant","content":hooks::apply(transcript["messages"][1]["message"]["content"].as_array().unwrap(),&actual)})
            }
            "transform.hook" => {
                json!({"role":"user","content":hooks::apply(&[json!({"type":"text","text":"first new block"}),json!({"type":"text","text":"last new block"})],&actual)})
            }
            _ => panic!("unexpected fixture method"),
        };
        assert_eq!(expected, case["expected_view"], "{name}: view");
    }
}
