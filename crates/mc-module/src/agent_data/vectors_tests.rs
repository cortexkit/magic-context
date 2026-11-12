//! The contract's published vectors that the service's other tests do not
//! run: every file's bytes against the published checksums, the request,
//! reply and refusal shapes, and the step machine, the one-ref-set rule and
//! the repeat rule as this participant applies them to a cut's record.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};

use contract::errors::{allowed_refusals, driver_action_for, DriverAction};
use contract::import::ImportedItem;
use serde::de::DeserializeOwned;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::*;

fn rows<'a>(file: &'a Value, key: &str) -> &'a Vec<Value> {
    file[key].as_array().unwrap()
}

fn text(value: &Value) -> Vec<u8> {
    canonical(value)
}

fn round<T: DeserializeOwned + Serialize>(value: &Value) -> Result<Value, serde_json::Error> {
    serde_json::to_value(serde_json::from_value::<T>(value.clone())?)
}

/// A reply decoded as its op's reply type and encoded again.
fn reply_round(method: &str, reply: &Value) -> Result<Value, serde_json::Error> {
    match Op::from_method(method).unwrap() {
        Op::Describe => round::<contract::describe::DescribeReply>(reply),
        Op::Busy => round::<contract::busy::BusyReply>(reply),
        Op::Status => round::<contract::status::StatusReply>(reply),
        Op::Prepare => round::<contract::prepare::PrepareReply>(reply),
        Op::Export => round::<contract::export::ExportReply>(reply),
        Op::Diverged => round::<contract::diverged::DivergedReply>(reply),
        Op::Import => round::<contract::import::ImportReply>(reply),
        Op::Activate | Op::Abort => round::<contract::EmptyReply>(reply),
        Op::Release => round::<contract::release::ReleaseReply>(reply),
    }
}

fn driver(name: &str) -> DriverAction {
    match name {
        "abort" => DriverAction::Abort,
        "retry_within_step" => DriverAction::RetryWithinStep,
        "retry_later" => DriverAction::RetryLater,
        "retry_after_operator" => DriverAction::RetryAfterOperator,
        "retry" => DriverAction::Retry,
        "terminal_for_step" => DriverAction::TerminalForStep,
        other => panic!("unknown vector driver action: {other}"),
    }
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[test]
fn every_published_vector_file_has_the_bytes_its_checksum_names() {
    let mut checked = 0;
    for line in contract::vectors::SHA256SUMS.lines() {
        let (hash, name) = line.split_once("  ").unwrap();
        let file = contract::vectors::file(name).unwrap_or_else(|| panic!("no vector {name}"));
        assert_eq!(sha256(file.as_bytes()), hash, "{name}");
        checked += 1;
    }
    assert_eq!(checked, contract::vectors::FILES.len());
}

/// Every request decodes with the contract's types and encodes back to its
/// canonical bytes, one or more per op; every refused one is refused with
/// its code. Every reply decodes as its op's reply type and encodes back,
/// and every refused reply, diverged reason and dropped map fails to
/// decode. The reasons this participant counts in an import's `dropped`
/// are ones the contract accepts.
#[test]
fn every_published_request_and_reply_decodes_with_the_contracts_types() {
    let requests = vector_file("requests.json");
    let mut seen = BTreeSet::new();
    for case in rows(&requests, "requests") {
        let method = case["method"].as_str().unwrap();
        let params = expanded(case);
        let request = Request::decode(method, &params).unwrap();
        assert_eq!(text(&request.params()), text(&params), "{}", case["name"]);
        seen.insert(method);
    }
    assert_eq!(seen.len(), contract::REQUIRED_OPS.len());
    for case in rows(&requests, "refused") {
        let refused =
            Request::decode(case["method"].as_str().unwrap(), &expanded(case)).unwrap_err();
        assert_eq!(refused.code.as_str(), case["code"], "{}", case["name"]);
    }

    let replies = vector_file("replies.json");
    seen.clear();
    for case in rows(&replies, "replies") {
        let method = case["method"].as_str().unwrap();
        assert_eq!(
            text(&reply_round(method, &case["reply"]).unwrap()),
            text(&case["reply"]),
            "{}",
            case["name"]
        );
        seen.insert(method);
    }
    assert_eq!(seen.len(), contract::REQUIRED_OPS.len());
    for case in rows(&replies, "refused") {
        assert!(
            reply_round(case["method"].as_str().unwrap(), &case["reply"]).is_err(),
            "{}",
            case["name"]
        );
    }

    for (file, method) in [
        ("diverged-reasons.json", contract::ops::DIVERGED),
        ("import-drops.json", contract::ops::IMPORT),
    ] {
        let vectors = vector_file(file);
        for case in rows(&vectors, "valid") {
            assert_eq!(
                text(&reply_round(method, &case["reply"]).unwrap()),
                text(&case["reply"]),
                "{}",
                case["name"]
            );
        }
        for case in rows(&vectors, "refused") {
            assert!(
                reply_round(method, &case["reply"]).is_err(),
                "{}",
                case["name"]
            );
        }
    }
    let ours = [
        crate::agent_data::snapshot::UNCOMMITTED_PUBLICATION,
        crate::agent_data::snapshot::DANGLING_REFERENCE,
    ]
    .into_iter()
    .map(|reason| (reason.to_owned(), 1))
    .collect();
    ImportedItem::new("c6ea741d409f833ee60be91d9176e493", 0, "0".repeat(64))
        .with_dropped(ours)
        .unwrap();
}

/// Every published refusal body decodes with its typed detail, its driver
/// action and whether it is retried; the per-op table of the codes an op
/// may refuse with, with both published amendments, is the one this
/// participant checks its refusals against before they leave it.
#[test]
fn every_published_refusal_decodes_and_each_op_may_use_exactly_the_published_codes() {
    let refusals = vector_file("refusals.json");
    let mut known = BTreeSet::new();
    for case in rows(&refusals, "refusals") {
        let body: ErrorBody = serde_json::from_value(case["body"].clone()).unwrap();
        assert_eq!(
            text(&serde_json::to_value(&body).unwrap()),
            text(&case["body"])
        );
        assert_eq!(body.code.is_known(), case["named"].as_bool().unwrap());
        assert_eq!(body.code.retryable(), case["retryable"].as_bool().unwrap());
        assert_eq!(
            body.code.driver_action(),
            driver(case["driver"].as_str().unwrap())
        );
        let detail = body.typed_detail().unwrap();
        assert_eq!(detail.is_some(), body.detail.is_some(), "{}", case["name"]);
        if let Some(op) = case["op"].as_str() {
            let op = Op::from_method(&format!("agent_data.{op}")).unwrap();
            assert!(may_refuse(op, &body.code), "{}", case["name"]);
        }
        if body.code.is_known() {
            known.insert(body.code.as_str().to_owned());
        }
    }
    // `participant_failed`, the code for a fault on this machine that a
    // retry cannot clear, has its refusal bodies in a file of their own,
    // which the service's other tests run.
    for case in rows(&vector_file("participant-failed.json"), "refusals") {
        known.insert(case["body"]["code"].as_str().unwrap().to_owned());
    }
    assert_eq!(known.len(), RefusalCode::KNOWN.len());
    for case in rows(&refusals, "tolerated") {
        assert_eq!(
            round::<ErrorBody>(&case["body"]).unwrap(),
            case["decodes_as"]
        );
    }
    for case in rows(&refusals, "detail_refused") {
        let body: ErrorBody = serde_json::from_value(case["body"].clone()).unwrap();
        assert!(body.typed_detail().is_err(), "{}", case["name"]);
    }

    let digest = vector_file("digest-mismatch.json");
    for case in rows(&digest, "refusals") {
        let op = Op::from_method(&format!("agent_data.{}", case["op"].as_str().unwrap())).unwrap();
        let body: ErrorBody = serde_json::from_value(case["body"].clone()).unwrap();
        assert_eq!(body.code, RefusalCode::DigestMismatch);
        assert!(may_refuse(op, &body.code));
        assert_eq!(
            driver_action_for(op, &body.code),
            driver(case["driver"].as_str().unwrap()),
            "{}",
            case["name"]
        );
        let detail = body.digest_mismatch_detail().unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(&detail).unwrap(),
            case["body"]["detail"]
        );
    }

    let table = vector_file("op-refusals.json");
    let additions: Vec<Value> = ["digest-mismatch.json", "participant-failed.json"]
        .into_iter()
        .flat_map(|file| rows(&vector_file(file), "op_additions").clone())
        .collect();
    assert_eq!(rows(&table, "ops").len(), contract::REQUIRED_OPS.len());
    for row in rows(&table, "ops") {
        let op = Op::from_method(&format!("agent_data.{}", row["op"].as_str().unwrap())).unwrap();
        let mut codes: BTreeSet<String> =
            serde_json::from_value::<Vec<String>>(row["codes"].clone())
                .unwrap()
                .into_iter()
                .collect();
        for addition in additions
            .iter()
            .filter(|addition| addition["op"] == row["op"])
        {
            codes.extend(serde_json::from_value::<Vec<String>>(addition["codes"].clone()).unwrap());
        }
        let allowed: BTreeSet<String> = allowed_refusals(op)
            .iter()
            .map(|code| code.as_str().to_owned())
            .collect();
        assert_eq!(allowed, codes, "{}", op.method());
    }
    for case in rows(&table, "cases") {
        let op = Op::from_method(&format!("agent_data.{}", case["op"].as_str().unwrap())).unwrap();
        let code = RefusalCode::from_code(case["code"].as_str().unwrap());
        assert_eq!(
            may_refuse(op, &code),
            case["allowed"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
}

/// The refs every step-machine request names.
const STARTED: &[&str] = &["r1"];

/// The request `op` makes on `CUT` with `refs`.
fn op_params(op: Op, refs: &Value) -> Value {
    match op {
        Op::Describe => json!({}),
        Op::Busy => json!({"refs": refs}),
        Op::Release => json!({"refs": refs, "cutId": CUT, "holder": "machine-b"}),
        _ => json!({"refs": refs, "cutId": CUT}),
    }
}

/// A journal whose record of `cut` is at `step` and started with `refs`,
/// or that has no record of it when `refs` is `None`.
fn journal_at(cut: &str, step: Step, refs: Option<&Value>) -> Journal {
    let journal = Journal::in_memory();
    if let Some(refs) = refs {
        let refs: Refs = serde_json::from_value(refs.clone()).unwrap();
        journal
            .change(|contents| {
                contents.cuts.insert(
                    cut.to_owned(),
                    Cut {
                        step,
                        refs: Some(refs),
                        ..Cut::default()
                    },
                );
            })
            .unwrap();
    }
    journal
}

/// A state-changing op as the service runs it, with a body that only
/// counts its runs: the service's own receipt, step and ref-set rules
/// decide whether it runs at all.
async fn keyed(
    service: &Service,
    journal: &Journal,
    request: &Request,
    runs: &AtomicUsize,
    reply: Value,
) -> Result<Vec<u8>, ErrorBody> {
    service
        .keyed(journal, request, |_| async move {
            runs.fetch_add(1, Ordering::SeqCst);
            Ok(Done::reply(&reply))
        })
        .await
}

fn step_of(journal: &Journal) -> Step {
    journal
        .contents()
        .unwrap()
        .cuts
        .get(CUT)
        .map_or(Step::None, |cut| cut.step)
}

/// Every published (op, step) pair, as this participant takes it: a
/// state-changing op runs and moves its cut to the published step, or is
/// refused with the published code and step, and then runs nothing. A read
/// changes no cut, and `status` answers the step the cut is at.
#[tokio::test]
async fn every_published_step_is_the_participants_step_machine() {
    let steps = vector_file("steps.json");
    let started = refs(STARTED);
    for row in rows(&steps, "transitions") {
        let op = Op::from_method(&format!("agent_data.{}", row["op"].as_str().unwrap())).unwrap();
        let from: Step = serde_json::from_value(row["from"].clone()).unwrap();
        let journal = journal_at(CUT, from, (from != Step::None).then_some(&started));
        let params = op_params(op, &started);
        if !op.changes_state() {
            assert_eq!(row.get("to"), Some(&row["from"]), "{row}");
            let host = Stand::new(journal);
            let answer = Service::new(true)
                .handle(&host, ENTORHINAL, &body(op.method(), params))
                .await;
            assert_eq!(step_of(&host.journal), from, "{row}");
            if op == Op::Status {
                let reply: Value = serde_json::from_slice(&answer.unwrap()).unwrap();
                assert_eq!(reply["step"], row["from"], "{row}");
            }
            continue;
        }
        let request = Request::decode(op.method(), &params).unwrap();
        let runs = AtomicUsize::new(0);
        let answer = keyed(&Service::new(true), &journal, &request, &runs, json!({})).await;
        match row.get("to") {
            Some(to) => {
                answer.unwrap_or_else(|refused| panic!("{row}: {refused:?}"));
                assert_eq!(runs.load(Ordering::SeqCst), 1, "{row}");
                assert_eq!(
                    serde_json::to_value(step_of(&journal)).unwrap(),
                    *to,
                    "{row}"
                );
            }
            None => {
                let refused = answer.unwrap_err();
                assert_eq!(refused.code.as_str(), row["refused"], "{row}");
                if let Some(step) = row.get("step") {
                    assert_eq!(refused.detail.as_ref().unwrap()["step"], *step, "{row}");
                }
                assert_eq!(runs.load(Ordering::SeqCst), 0, "{row}");
                assert_eq!(step_of(&journal), from, "{row}");
            }
        }
    }
}

/// Every published case of the one-ref-set rule, as this participant takes
/// it. A cut is one move: the id under which the driver freezes a set of
/// sessions on the source and installs them on the receiver. An op naming
/// the set its cut started with runs, whatever the order; any other set is
/// refused `invalid_state` naming the step and the expected refs. The first
/// op a machine receives for a cut fixes the set:
/// `prepare` on the source, `import` on the receiver. The reads are never
/// checked.
#[tokio::test]
async fn every_published_ref_set_case_is_the_participants_rule() {
    for case in rows(&vector_file("ref-sets.json"), "cases") {
        let op = Op::from_method(&format!("agent_data.{}", case["op"].as_str().unwrap())).unwrap();
        let step: Step = serde_json::from_value(case["step"].clone()).unwrap();
        let started = (!case["started_with"].is_null()).then_some(&case["started_with"]);
        let journal = journal_at(CUT, step, started);
        let params = op_params(op, &case["refs"]);
        if !op.changes_state() {
            assert_eq!(case["outcome"], "ok", "{case}");
            let host = Stand::new(journal);
            let answer = Service::new(true)
                .handle(&host, ENTORHINAL, &body(op.method(), params))
                .await;
            if let Err(refused) = answer {
                assert_ne!(refused.code, RefusalCode::InvalidState, "{case}");
            }
            continue;
        }
        let request = Request::decode(op.method(), &params).unwrap();
        let runs = AtomicUsize::new(0);
        let answer = keyed(&Service::new(true), &journal, &request, &runs, json!({})).await;
        if case["outcome"] == "ok" {
            answer.unwrap_or_else(|refused| panic!("{case}: {refused:?}"));
            assert_eq!(runs.load(Ordering::SeqCst), 1, "{case}");
            if matches!(op, Op::Prepare | Op::Import) {
                let recorded = journal.contents().unwrap().cuts[CUT].refs.clone().unwrap();
                assert!(recorded.same_set(request.refs().unwrap()), "{case}");
            }
        } else {
            let refused = answer.unwrap_err();
            assert_eq!(refused.code.as_str(), case["outcome"]["code"], "{case}");
            assert_eq!(refused.detail.unwrap(), case["outcome"]["detail"], "{case}");
            assert_eq!(runs.load(Ordering::SeqCst), 0, "{case}");
        }
    }
}

/// The step a cut must be at for `op` to run, and whether the cut must
/// already have started with the op's refs.
fn step_before(op: Op) -> (Step, bool) {
    match op {
        Op::Export => (Step::Prepared, true),
        Op::Release => (Step::Exported, true),
        Op::Activate => (Step::Imported, true),
        _ => (Step::None, false),
    }
}

/// Every published pair of requests, as this participant takes the second
/// after answering the first: an identical request (members or refs in
/// another order included) gets the first reply's bytes back without
/// running again; another request under the same `(cutId, op)` is refused
/// `id_reused` without running; another cut or op runs on its own; and a
/// read records no receipt.
#[tokio::test]
async fn every_published_repeat_is_answered_by_the_participants_receipts() {
    for case in rows(&vector_file("idempotency.json"), "cases") {
        let decode = |key: &str| {
            Request::decode(case[key]["method"].as_str().unwrap(), &case[key]["params"]).unwrap()
        };
        let (first, again) = (decode("first"), decode("again"));
        if case["outcome"] == "exempt" {
            assert!(
                !first.op().changes_state() && !again.op().changes_state(),
                "{case}"
            );
            let host = Stand::new(Journal::in_memory());
            let service = Service::new(true);
            for key in ["first", "again"] {
                let _ = service
                    .handle(
                        &host,
                        ENTORHINAL,
                        &body(
                            case[key]["method"].as_str().unwrap(),
                            case[key]["params"].clone(),
                        ),
                    )
                    .await;
            }
            assert!(host.journal.contents().unwrap().cuts.is_empty(), "{case}");
            continue;
        }
        let (step, started) = step_before(first.op());
        let first_refs = serde_json::to_value(first.refs().unwrap()).unwrap();
        let cut = first.cut_id().unwrap().as_str();
        let journal = journal_at(cut, step, started.then_some(&first_refs));
        let service = Service::new(true);
        let runs = AtomicUsize::new(0);
        let first_reply = keyed(&service, &journal, &first, &runs, json!({"first": true}))
            .await
            .unwrap_or_else(|refused| panic!("{case}: {refused:?}"));
        let answer = keyed(&service, &journal, &again, &runs, json!({"again": true})).await;
        match case["outcome"].as_str().unwrap() {
            "replay" => {
                assert_eq!(answer.unwrap(), first_reply, "{case}");
                assert_eq!(runs.load(Ordering::SeqCst), 1, "{case}");
            }
            "id_reused" => {
                assert_eq!(answer.unwrap_err().code, RefusalCode::IdReused, "{case}");
                assert_eq!(runs.load(Ordering::SeqCst), 1, "{case}");
            }
            "new_key" => {
                assert_eq!(
                    answer.unwrap(),
                    canonical(&json!({"again": true})),
                    "{case}"
                );
                assert_eq!(runs.load(Ordering::SeqCst), 2, "{case}");
            }
            other => panic!("unknown outcome {other}: {case}"),
        }
    }
}

/// Every published `sessionRef` is the one this participant derives from
/// the session it names, and the door's stream for a session is keyed by.
#[test]
fn every_published_session_ref_is_the_participants() {
    for case in rows(&vector_file("session-refs.json"), "cases") {
        let session = SessionRef::new(
            case["runner"].as_str().unwrap(),
            case["harness"].as_str().unwrap(),
            case["session"].as_str().unwrap(),
        );
        let derived = crate::agent_data::source::session_ref(&session);
        assert_eq!(derived, case["sessionRef"].as_str().unwrap());
        assert!(contract::refs::is_session_ref(&derived));
    }
}
