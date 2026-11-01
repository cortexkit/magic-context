//! Published vector bytes exercise the adapter's decoder, durable replay/step
//! preconditions, and the role types that decode its request and reply bodies.
use super::*;
use role::errors::DriverAction;
use serde::de::DeserializeOwned;
fn file(name: &str) -> Value {
    serde_json::from_str(role::vectors::file(name).unwrap()).unwrap()
}
fn rows<'a>(v: &'a Value, key: &str) -> &'a Vec<Value> {
    v[key].as_array().unwrap()
}
fn canonical(v: &Value) -> String {
    serde_jcs::to_string(v).unwrap()
}
fn expanded(case: &Value) -> Value {
    let mut p = case["params"].clone();
    if let Some(n) = case["expand_refs"].as_u64() {
        p["refs"] = json!((0..n)
            .map(|i| json!({"ref_kind":"broca.session","ref":format!("ses_{i}")}))
            .collect::<Vec<_>>());
    }
    p
}
fn decoded(method: &str, p: &Value) -> Result<Request, ErrorBody> {
    decode(
        Some(&Principal::Reserved {
            module_id: "entorhinal".into(),
        }),
        method,
        p,
    )
}
fn round<T: DeserializeOwned + Serialize>(v: &Value) -> Result<Value, serde_json::Error> {
    serde_json::to_value(serde_json::from_value::<T>(v.clone())?)
}
fn reply_type(method: &str, v: &Value) -> Result<Value, serde_json::Error> {
    match Op::from_method(method).unwrap() {
        Op::Describe => round::<role::describe::DescribeReply>(v),
        Op::Busy => round::<role::busy::BusyReply>(v),
        Op::Status => round::<role::status::StatusReply>(v),
        Op::Prepare => round::<role::prepare::PrepareReply>(v),
        Op::Export => round::<role::export::ExportReply>(v),
        Op::Diverged => round::<role::diverged::DivergedReply>(v),
        Op::Import => round::<role::import::ImportReply>(v),
        Op::Activate | Op::Abort => round::<role::EmptyReply>(v),
        Op::Release => round::<role::release::ReleaseReply>(v),
    }
}
#[test]
fn published_vectors_bytes_and_all_request_reply_shapes() {
    for line in role::vectors::SHA256SUMS.lines() {
        let (hash, name) = line.split_once("  ").unwrap();
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(role::vectors::file(name).unwrap().as_bytes())
            ),
            hash,
            "{name}"
        );
    }
    let requests = file("requests.json");
    let mut seen = BTreeSet::new();
    for case in rows(&requests, "requests") {
        let p = expanded(case);
        let method = case["method"].as_str().unwrap();
        let request = decoded(method, &p).unwrap();
        assert_eq!(
            canonical(&request.params()),
            canonical(&p),
            "{}",
            case["name"]
        );
        seen.insert(method);
    }
    assert_eq!(seen.len(), 10);
    for case in rows(&requests, "refused") {
        assert_eq!(
            decoded(case["method"].as_str().unwrap(), &expanded(case))
                .unwrap_err()
                .code
                .as_str(),
            case["code"],
            "{}",
            case["name"]
        );
    }
    let replies = file("replies.json");
    seen.clear();
    for case in rows(&replies, "replies") {
        let method = case["method"].as_str().unwrap();
        assert_eq!(
            canonical(&reply_type(method, &case["reply"]).unwrap()),
            canonical(&case["reply"]),
            "{}",
            case["name"]
        );
        seen.insert(method);
    }
    assert_eq!(seen.len(), 10);
    for case in rows(&replies, "refused") {
        assert!(
            reply_type(case["method"].as_str().unwrap(), &case["reply"]).is_err(),
            "{}",
            case["name"]
        );
    }
}
#[test]
fn published_vectors_run_adapter_step_ref_set_and_repeat_checks() {
    let steps = file("steps.json");
    assert_eq!(rows(&steps, "transitions").len(), 70);
    for row in rows(&steps, "transitions") {
        let method = format!("agent_data.{}", row["op"].as_str().unwrap());
        let op = Op::from_method(&method).unwrap();
        let p = match op {
            Op::Describe => json!({}),
            Op::Busy => json!({"refs":[]}),
            Op::Release => json!({"refs":[],"cutId":CUT,"holder":"h"}),
            _ => params(&[]),
        };
        let request = decoded(&method, &p).unwrap();
        let cut = Cut {
            step: serde_json::from_value(row["from"].clone()).unwrap(),
            ..Cut::default()
        };
        let actual = transition(&request, &cut);
        if let Some(to) = row.get("to") {
            assert_eq!(
                actual.unwrap().0,
                serde_json::from_value::<Step>(to.clone()).unwrap(),
                "{row}"
            );
        } else {
            let error = actual.unwrap_err();
            assert_eq!(error.code.as_str(), row["refused"], "{row}");
            if let Some(step) = row.get("step") {
                assert_eq!(error.detail.unwrap()["step"], *step, "{row}");
            }
        }
    }
    for case in rows(&file("ref-sets.json"), "cases") {
        let method = format!("agent_data.{}", case["op"].as_str().unwrap());
        let op = Op::from_method(&method).unwrap();
        let refs: Refs = serde_json::from_value(case["refs"].clone()).unwrap();
        let p = match op {
            Op::Describe => json!({}),
            Op::Busy => json!({"refs":refs}),
            Op::Release => json!({"refs":refs,"cutId":CUT,"holder":"h"}),
            _ => json!({"refs":refs,"cutId":CUT}),
        };
        let request = decoded(&method, &p).unwrap();
        let cut = Cut {
            step: serde_json::from_value(case["step"].clone()).unwrap(),
            refs: serde_json::from_value(case["started_with"].clone()).unwrap(),
            ..Cut::default()
        };
        let actual = transition(&request, &cut);
        if case["outcome"] == "ok" {
            assert!(actual.is_ok(), "{case}: {actual:?}");
        } else {
            let error = actual.unwrap_err();
            assert_eq!(error.code.as_str(), case["outcome"]["code"], "{case}");
            assert_eq!(error.detail.unwrap(), case["outcome"]["detail"], "{case}");
        }
    }
    for case in rows(&file("idempotency.json"), "cases") {
        let part = |key: &str| {
            let v = &case[key];
            decoded(v["method"].as_str().unwrap(), &v["params"]).unwrap()
        };
        let first = part("first");
        let again = part("again");
        let step = match again.op() {
            Op::Export => Step::Prepared,
            Op::Release => Step::Exported,
            Op::Activate => Step::Imported,
            _ => Step::None,
        };
        let mut cut = Cut {
            step,
            ..Cut::default()
        };
        cut.receipts.insert(
            first.op().method().into(),
            Receipt {
                params: first.params(),
                reply: json!({"first_reply":true}),
            },
        );
        let actual = transition(&again, &cut);
        match case["outcome"].as_str().unwrap() {
            "replay" => assert_eq!(
                actual.unwrap().1,
                Some(json!({"first_reply":true})),
                "{case}"
            ),
            "id_reused" => assert_eq!(actual.unwrap_err().code, RefusalCode::IdReused, "{case}"),
            "new_key" | "exempt" => assert_eq!(actual.unwrap().1, None, "{case}"),
            _ => panic!("{case}"),
        }
    }
}
#[test]
fn published_refusal_rows_details_and_session_refs() {
    let refusals = file("refusals.json");
    let mut known = BTreeSet::new();
    for case in rows(&refusals, "refusals") {
        let body: ErrorBody = serde_json::from_value(case["body"].clone()).unwrap();
        assert_eq!(
            canonical(&serde_json::to_value(&body).unwrap()),
            canonical(&case["body"])
        );
        assert_eq!(body.code.is_known(), case["named"].as_bool().unwrap());
        assert_eq!(body.code.retryable(), case["retryable"].as_bool().unwrap());
        let driver = match case["driver"].as_str().unwrap() {
            "abort" => DriverAction::Abort,
            "retry_within_step" => DriverAction::RetryWithinStep,
            "retry_later" => DriverAction::RetryLater,
            "retry_after_operator" => DriverAction::RetryAfterOperator,
            "retry" => DriverAction::Retry,
            "terminal_for_step" => DriverAction::TerminalForStep,
            _ => panic!("{case}"),
        };
        assert_eq!(body.code.driver_action(), driver);
        let detail = body.typed_detail().unwrap();
        assert_eq!(detail.is_some(), body.detail.is_some());
        if let Some(detail) = detail {
            let (code, value) = detail.into_parts();
            assert_eq!(code, body.code);
            assert_eq!(canonical(&value), canonical(body.detail.as_ref().unwrap()));
        }
        if let Some(op) = case["op"].as_str() {
            assert!(role::errors::may_refuse(
                Op::from_method(&format!("agent_data.{op}")).unwrap(),
                &body.code
            ));
        }
        if body.code.is_known() {
            known.insert(body.code.as_str().to_owned());
        }
    }
    assert_eq!(known.len(), RefusalCode::KNOWN.len());
    for case in rows(&refusals, "tolerated") {
        assert_eq!(
            round::<ErrorBody>(&case["body"]).unwrap(),
            case["decodes_as"]
        );
    }
    for case in rows(&refusals, "detail_refused") {
        assert!(
            serde_json::from_value::<ErrorBody>(case["body"].clone())
                .unwrap()
                .typed_detail()
                .is_err(),
            "{case}"
        );
    }
    let allowed = file("op-refusals.json");
    let amendments = file("digest-mismatch.json");
    let additions = rows(&amendments, "op_additions");
    assert_eq!(additions.len(), 2);
    let mut amended = BTreeSet::new();
    assert_eq!(rows(&allowed, "ops").len(), 10);
    for row in rows(&allowed, "ops") {
        let op = Op::from_method(&format!("agent_data.{}", row["op"].as_str().unwrap())).unwrap();
        let mut codes = serde_json::from_value::<Vec<RefusalCode>>(row["codes"].clone()).unwrap();
        for addition in additions
            .iter()
            .filter(|addition| addition["op"] == row["op"])
        {
            assert!(amended.insert(op.method()), "duplicate refusal amendment");
            codes.extend(
                serde_json::from_value::<Vec<RefusalCode>>(addition["codes"].clone()).unwrap(),
            );
        }
        assert_eq!(codes, role::errors::allowed_refusals(op));
    }
    assert_eq!(amended.len(), additions.len());
    for case in rows(&allowed, "cases") {
        let op = Op::from_method(&format!("agent_data.{}", case["op"].as_str().unwrap())).unwrap();
        let code: RefusalCode = serde_json::from_value(case["code"].clone()).unwrap();
        assert_eq!(
            role::errors::may_refuse(op, &code),
            case["allowed"].as_bool().unwrap(),
            "{case}"
        );
    }
    for case in rows(&file("session-refs.json"), "cases") {
        let tuple = BindTuple {
            runner: case["runner"].as_str().unwrap().into(),
            harness: case["harness"].as_str().unwrap().into(),
            project_root: String::new(),
            session: case["session"].as_str().unwrap().into(),
        };
        assert_eq!(tuple.reference(), case["sessionRef"]);
        assert!(role::refs::is_session_ref(&tuple.reference()));
    }
}

#[tokio::test]
async fn published_digest_mismatch_vectors_pin_adapter_refusals_and_driver_actions() {
    let vectors = file("digest-mismatch.json");
    let cases = rows(&vectors, "refusals");
    assert_eq!(cases.len(), 2);
    for (case, op) in cases.iter().zip([Op::Activate, Op::Abort]) {
        let body: ErrorBody = serde_json::from_value(case["body"].clone()).unwrap();
        assert_eq!(
            canonical(&serde_json::to_value(&body).unwrap()),
            canonical(&case["body"])
        );
        assert_eq!(body.code, RefusalCode::DigestMismatch);
        assert_eq!(body.code.is_known(), case["named"].as_bool().unwrap());
        assert!(role::errors::may_refuse(op, &body.code));
        assert_eq!(
            op.method(),
            format!("agent_data.{}", case["op"].as_str().unwrap())
        );
        let action = role::errors::driver_action_for(op, &body.code);
        let expected = match case["driver"].as_str().unwrap() {
            "terminal_for_step" => DriverAction::TerminalForStep,
            "retry_after_operator" => DriverAction::RetryAfterOperator,
            _ => panic!("{case}"),
        };
        assert_eq!(action, expected);
        assert_eq!(action.retryable(), case["retryable"].as_bool().unwrap());
        let detail = body.digest_mismatch_detail().unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(&detail).unwrap(),
            case["body"]["detail"]
        );
        assert_eq!(body.typed_detail().unwrap(), None);
        let built = ErrorBody::with_digest_mismatch_detail(
            detail,
            case["body"]["message"].as_str().unwrap(),
        );
        assert_eq!(serde_json::to_value(built).unwrap(), case["body"]);
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let door = Arc::new(FakeDoor::default());
        let s = make(source.path(), door.clone()).await;
        let d = make(destination.path(), door.clone()).await;
        seed(&s, SESSION);
        observe(&s, SESSION).await;
        let refs = vec![reference(SESSION)];
        prepared(&s, &door, &refs).await;
        reply(call(&d, role::ops::IMPORT, params(&refs)).await);
        let root = d.agent_data.as_ref().unwrap().root().unwrap();
        let directory = directory(&root, CUT, &refs[0].r#ref);
        let path = if op == Op::Abort {
            *d.agent_data.as_ref().unwrap().crash_after.lock().unwrap() = Some(1);
            assert_eq!(
                refusal(call(&d, role::ops::ACTIVATE, params(&refs)).await),
                "unavailable"
            );
            directory.join("undo/context-0.bin")
        } else {
            directory.join("context-0.bin")
        };
        let mut bytes = std::fs::read(&path).unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        std::fs::write(&path, bytes).unwrap();
        let refusal = call(&d, op.method(), params(&refs)).await;
        match refusal {
            HandlerOutcome::ErrorWithDetail { code, detail, .. } => {
                assert_eq!(code, body.code.as_str(), "{}", case["name"]);
                assert_eq!(detail, case["body"]["detail"]);
            }
            other => panic!("{}: expected vector refusal, got {other:?}", case["name"]),
        }
    }
}
