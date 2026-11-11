//! The `agent-data` service: admission, decoding, idempotency, the per-cut
//! op lock, and the three reads.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use contract::busy::BusyReply;
use contract::describe::DescribeReply;
use contract::errors::{may_refuse, Detail, ErrorBody, RefusalCode};
use contract::refs::{Ref, Refs};
use contract::request::Request;
use contract::status::StatusReply;
use contract::step::Step;
use contract::Op;
use cortexkit_role_agent_data as contract;
use cortexkit_role_compaction::read::SessionRef;
use serde_json::{json, Value};

use super::journal::{self, Cut};
use super::service::{canonical, receipt, Done, Host, Probe, Service};
use super::Journal;
use crate::client::EntorhinalRefusal;

const ENTORHINAL: &str = "reserved:entorhinal";
const CUT: &str = "0123456789abcdef0123456789abcdef";
const OTHER_CUT: &str = "fedcba9876543210fedcba9876543210";

/// A host with stand-ins for the catalog, Entorhinal and the session's
/// worker, counting every read the service makes of them.
struct Stand {
    journal: Journal,
    providers: Mutex<Result<Vec<String>, String>>,
    /// Entorhinal's bindings, by ref: the `result` it answers.
    bindings: Mutex<HashMap<String, Value>>,
    entorhinal_answers: AtomicBool,
    historian: Mutex<HashSet<SessionRef>>,
    probe: Mutex<Probe>,
    db: Option<PathBuf>,
    catalog_reads: AtomicUsize,
    lookups: AtomicUsize,
    probes: AtomicUsize,
}

impl Stand {
    fn new(journal: Journal) -> Self {
        Self {
            journal,
            providers: Mutex::new(Ok(vec!["broca".into(), "magic-context".into()])),
            bindings: Mutex::default(),
            entorhinal_answers: AtomicBool::new(true),
            historian: Mutex::default(),
            probe: Mutex::new(Probe::NoWorker),
            db: None,
            catalog_reads: AtomicUsize::new(0),
            lookups: AtomicUsize::new(0),
            probes: AtomicUsize::new(0),
        }
    }

    /// Entorhinal resolves `reference` of `kind` to this session.
    fn bind(
        &self,
        kind: &str,
        reference: &str,
        runner: Option<&str>,
        harness: &str,
        session: &str,
    ) {
        let mut binding = json!({
            "agent_id": "agent_0000000000000101",
            "ref_kind": kind,
            "ref": reference,
            "harness": harness,
            "session_id": session,
            "project_root": null,
            "incarnation": "0123456789abcdef",
        });
        if let Some(runner) = runner {
            binding["runner"] = json!(runner);
        }
        self.bindings
            .lock()
            .unwrap()
            .insert(reference.to_owned(), binding);
    }

    fn reads(&self) -> usize {
        self.catalog_reads.load(Ordering::SeqCst)
            + self.lookups.load(Ordering::SeqCst)
            + self.probes.load(Ordering::SeqCst)
    }
}

impl Host for Stand {
    fn journal(&self) -> &Journal {
        &self.journal
    }

    fn historian_running(&self, session: &SessionRef) -> bool {
        self.historian.lock().unwrap().contains(session)
    }

    async fn probe(&self, _session: &SessionRef, _budget: Duration) -> Probe {
        self.probes.fetch_add(1, Ordering::SeqCst);
        *self.probe.lock().unwrap()
    }

    fn context_db(&self) -> Option<PathBuf> {
        self.db.clone()
    }

    async fn resolve_providers(&self, capability: &str) -> Result<Vec<String>, String> {
        assert_eq!(capability, contract::PROVIDES);
        self.catalog_reads.fetch_add(1, Ordering::SeqCst);
        self.providers.lock().unwrap().clone()
    }

    async fn entorhinal(&self, body: Vec<u8>) -> Option<Result<Vec<u8>, EntorhinalRefusal>> {
        self.lookups.fetch_add(1, Ordering::SeqCst);
        if !self.entorhinal_answers.load(Ordering::SeqCst) {
            return None;
        }
        let request: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(request["method"], "agent.session_for_ref");
        let reference = request["params"]["ref"].as_str().unwrap();
        let found = self.bindings.lock().unwrap().get(reference).cloned();
        Some(match found {
            Some(binding) => Ok(serde_json::to_vec(&json!({"result": binding})).unwrap()),
            None => Err(EntorhinalRefusal {
                code: "not_found".into(),
                message: "no agent session is registered under this reference".into(),
                detail: None,
            }),
        })
    }
}

fn body(method: &str, params: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"method": method, "params": params})).unwrap()
}

fn refs(names: &[&str]) -> Value {
    Value::Array(
        names
            .iter()
            .map(|name| json!({"ref_kind": "pi-session", "ref": name}))
            .collect(),
    )
}

fn cut_params(cut: &str, names: &[&str]) -> Value {
    json!({"refs": refs(names), "cutId": cut})
}

fn cut_request(op: Op, cut: &str, names: &[&str]) -> Request {
    Request::decode(op.method(), &cut_params(cut, names)).unwrap()
}

async fn call(
    service: &Service,
    host: &Stand,
    method: &str,
    params: Value,
) -> Result<Value, ErrorBody> {
    let reply = service
        .handle(host, ENTORHINAL, &body(method, params))
        .await?;
    Ok(serde_json::from_slice(&reply).unwrap())
}

fn unreadable_journal() -> (tempfile::TempDir, Journal) {
    let dir = tempfile::tempdir().unwrap();
    let path = journal::path(&dir.path().join("context.db"));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"{ not json").unwrap();
    let journal = Journal::load(path);
    (dir, journal)
}

/// Only `reserved:entorhinal` is served, and every other caller is refused
/// before its body is parsed: a body that is not even JSON is refused
/// `caller_forbidden`, not `invalid_request`, and neither the catalog, nor
/// Entorhinal, nor a worker, nor the journal is read.
#[tokio::test]
async fn every_other_caller_is_refused_before_its_request_is_decoded_or_any_state_read() {
    // An unreadable journal answers `unavailable` to any read of it, so a
    // refusal that read it would say so.
    let (_dir, journal) = unreadable_journal();
    let host = Stand::new(journal);
    let service = Service::new(true);
    let requests = [
        b"{ not json".to_vec(),
        body(contract::ops::DESCRIBE, json!({})),
        body(contract::ops::BUSY, json!({"refs": refs(&["r1"])})),
        body(contract::ops::STATUS, cut_params(CUT, &["r1"])),
        body(contract::ops::PREPARE, cut_params(CUT, &["r1"])),
        body(contract::ops::ABORT, cut_params(CUT, &["r1"])),
    ];
    for caller in [
        "direct",
        "unverified",
        "",
        "entorhinal",
        "reserved:broca",
        "reserved:magic-context",
        "session:ses_1",
    ] {
        for request in &requests {
            let refused = service.handle(&host, caller, request).await.unwrap_err();
            assert_eq!(refused.code, RefusalCode::CallerForbidden, "{caller}");
            assert_eq!(refused.detail, None);
        }
    }
    assert_eq!(host.reads(), 0);
    // The same requests from Entorhinal do read state.
    let refused = service
        .handle(&host, ENTORHINAL, &requests[3])
        .await
        .unwrap_err();
    assert_eq!(refused.code, RefusalCode::Unavailable);
    assert!(refused.message.contains("journal"), "{}", refused.message);
}

#[tokio::test]
async fn a_request_that_does_not_decode_is_invalid_request_before_any_state_is_read() {
    let (_dir, journal) = unreadable_journal();
    let host = Stand::new(journal);
    let service = Service::new(true);
    let mut bodies = vec![
        b"{ not json".to_vec(),
        b"[]".to_vec(),
        br#"{"params":{}}"#.to_vec(),
        br#"{"method":"agent_data.describe","params":{},"id":1}"#.to_vec(),
        body("agent_data.resume", cut_params(CUT, &["r1"])),
        body("role.describe", json!({})),
        body(contract::ops::STATUS, cut_params("0123", &["r1"])),
        body(
            contract::ops::ABORT,
            cut_params(&CUT.to_uppercase(), &["r1"]),
        ),
        body(contract::ops::BUSY, json!({"refs": refs(&["r1", "r1"])})),
        body(
            contract::ops::RELEASE,
            json!({"refs": refs(&["r1"]), "cutId": CUT}),
        ),
    ];
    // Every request the contract's vectors refuse.
    let vectors: Value =
        serde_json::from_str(contract::vectors::file("requests.json").unwrap()).unwrap();
    for case in vectors["refused"].as_array().unwrap() {
        bodies.push(body(case["method"].as_str().unwrap(), expanded(case)));
    }
    for request in &bodies {
        let refused = service
            .handle(&host, ENTORHINAL, request)
            .await
            .unwrap_err();
        assert_eq!(
            refused.code,
            RefusalCode::InvalidRequest,
            "{}",
            String::from_utf8_lossy(request)
        );
    }
    assert_eq!(host.reads(), 0);
}

/// A vector case's params, with `expand_refs: N` replaced by N refs, as the
/// vectors' README says.
fn expanded(case: &Value) -> Value {
    let mut params = case["params"].clone();
    if let Some(count) = case.get("expand_refs").and_then(Value::as_u64) {
        params["refs"] = Value::Array(
            (0..count)
                .map(|i| json!({"ref_kind": "broca.session", "ref": format!("ses_{i}")}))
                .collect(),
        );
    }
    params
}

fn vector_file(name: &str) -> Value {
    serde_json::from_str(contract::vectors::file(name).unwrap()).unwrap()
}

/// Seed the journal with a cut at `step`, started with `names`.
fn seed(journal: &Journal, cut: &str, step: Step, names: &[&str]) {
    let started = Refs::new(
        names
            .iter()
            .map(|name| Ref::new("pi-session", *name))
            .collect(),
    )
    .unwrap();
    journal
        .change(|contents| {
            contents.cuts.insert(
                cut.to_owned(),
                Cut {
                    step,
                    refs: Some(started),
                    ..Cut::default()
                },
            );
        })
        .unwrap();
}

/// The contract's published vectors for the three reads: every request
/// vector decodes and gets either a reply that decodes as the op's reply
/// type and is already canonical, or a refusal the op may give with a
/// detail that decodes; the status vectors' replies come back byte for
/// byte.
#[tokio::test]
async fn the_published_describe_busy_and_status_vectors_decode_and_match() {
    let host = Stand::new(Journal::in_memory());
    let service = Service::new(true);
    for case in vector_file("requests.json")["requests"].as_array().unwrap() {
        let method = case["method"].as_str().unwrap();
        let op = Op::from_method(method).unwrap();
        if !matches!(op, Op::Describe | Op::Busy | Op::Status) {
            continue;
        }
        let params = expanded(case);
        let request = Request::decode(method, &params).unwrap();
        match service
            .handle(&host, ENTORHINAL, &body(method, params))
            .await
        {
            Ok(reply) => {
                let value: Value = serde_json::from_slice(&reply).unwrap();
                assert_eq!(reply, canonical(&value), "{}", case["name"]);
                match &request {
                    Request::Describe(_) => {
                        serde_json::from_value::<DescribeReply>(value).unwrap();
                    }
                    Request::Busy(busy) => {
                        let decoded: BusyReply = serde_json::from_value(value).unwrap();
                        assert!(decoded.answers(busy), "{}", case["name"]);
                    }
                    Request::Status(_) => {
                        serde_json::from_value::<StatusReply>(value).unwrap();
                    }
                    _ => unreachable!(),
                }
            }
            Err(refused) => {
                // The vectors' refs are of kinds ck-mc never holds.
                assert!(
                    may_refuse(op, &refused.code),
                    "{}: {refused:?}",
                    case["name"]
                );
                assert_eq!(refused.code, RefusalCode::UnknownRef, "{}", case["name"]);
                let first = &request.refs().unwrap().as_slice()[0];
                match refused.typed_detail().unwrap() {
                    Some(Detail::UnknownRef(detail)) => assert_eq!(
                        serde_json::to_value(detail).unwrap(),
                        json!({"ref_kind": first.ref_kind, "ref": first.r#ref})
                    ),
                    other => panic!("{}: {other:?}", case["name"]),
                }
            }
        }
    }
    let replies = vector_file("replies.json");
    let reply = |name: &str| -> Vec<u8> {
        let case = replies["replies"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == name)
            .unwrap_or_else(|| panic!("no vector {name}"));
        canonical(&case["reply"])
    };
    let status = |cut: &str| body(contract::ops::STATUS, cut_params(cut, &["r1"]));
    assert_eq!(
        service
            .handle(&host, ENTORHINAL, &status(CUT))
            .await
            .unwrap(),
        reply("status of a cutId never seen")
    );
    seed(&host.journal, OTHER_CUT, Step::Prepared, &["r1"]);
    assert_eq!(
        service
            .handle(&host, ENTORHINAL, &status(OTHER_CUT))
            .await
            .unwrap(),
        reply("status after prepare")
    );
    assert_eq!(
        service
            .handle(
                &host,
                ENTORHINAL,
                &body(contract::ops::BUSY, json!({"refs": []}))
            )
            .await
            .unwrap(),
        br#"{"refs":[]}"#
    );
}

#[tokio::test]
async fn describe_declares_its_stores_and_broca_session_only_while_broca_is_a_participant() {
    let host = Stand::new(Journal::in_memory());
    let service = Service::new(true);
    let describe = || call(&service, &host, contract::ops::DESCRIBE, json!({}));
    let stores = json!([
        {"name": "session-history", "sync_class": "agent"},
        {"name": "session-state", "sync_class": "machine_local"},
        {"name": "project-memory", "sync_class": "shared_merged"},
        {"name": "indexes", "sync_class": "machine_local"},
    ]);
    assert_eq!(
        describe().await.unwrap(),
        json!({"ref_kinds": ["broca-session"], "stores": stores, "external": false})
    );
    // Computed on every call: the catalog is read again, and what it lists
    // now is what is declared.
    for (providers, kinds) in [
        // Broca is gone from the catalog.
        (Ok(vec!["magic-context".to_owned()]), json!([])),
        // Broca is in the catalog but is not an agent-data participant
        // (yet), so the lookup does not list it.
        (
            Ok(vec!["entorhinal".to_owned(), "magic-context".to_owned()]),
            json!([]),
        ),
        (Err("connect: refused".to_owned()), json!([])),
        (
            Ok(vec!["broca".to_owned(), "thalamus-harness".to_owned()]),
            json!([
                "broca-session",
                "opencode2-session",
                "pi-session",
                "claude-code-session"
            ]),
        ),
        (Ok(vec!["broca".to_owned()]), json!(["broca-session"])),
    ] {
        *host.providers.lock().unwrap() = providers.clone();
        let reply = describe().await.unwrap();
        assert_eq!(reply["ref_kinds"], kinds, "{providers:?}");
        assert_eq!(reply["stores"], stores);
        assert_eq!(reply["external"], false);
    }
    assert_eq!(host.catalog_reads.load(Ordering::SeqCst), 6);
}

#[tokio::test]
async fn status_answers_the_step_the_journal_records_and_never_refuses_a_ref() {
    let host = Stand::new(Journal::in_memory());
    let service = Service::new(true);
    let status = |cut: &'static str| {
        call(
            &service,
            &host,
            contract::ops::STATUS,
            json!({"refs": [{"ref_kind": "no-such-kind", "ref": "x"}], "cutId": cut}),
        )
    };
    assert_eq!(status(CUT).await.unwrap(), json!({"step": "none"}));
    for step in Step::ALL {
        seed(&host.journal, CUT, step, &["r1"]);
        assert_eq!(status(CUT).await.unwrap(), json!({"step": step.as_str()}));
    }
    assert_eq!(status(OTHER_CUT).await.unwrap(), json!({"step": "none"}));
    // Neither Entorhinal nor the catalog is asked.
    assert_eq!(host.reads(), 0);
    let (_dir, journal) = unreadable_journal();
    let host = Stand::new(journal);
    let refused = call(
        &service,
        &host,
        contract::ops::STATUS,
        cut_params(CUT, &["r1"]),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, RefusalCode::Unavailable);
}

/// A repeat of a state-changing request gets the first reply's bytes; a
/// different request under the same `(cutId, op)` is refused `id_reused`.
/// Both hold after an abort and a restart, because the cut's record and its
/// receipts outlive the cut.
#[tokio::test]
async fn a_repeat_replays_its_bytes_and_another_request_is_id_reused_after_an_abort_and_a_restart()
{
    let dir = tempfile::tempdir().unwrap();
    let path = journal::path(&dir.path().join("context.db"));
    let abort = |names: &[&str]| body(contract::ops::ABORT, cut_params(CUT, names));
    let first = {
        let host = Stand::new(Journal::load(path.clone()));
        let service = Service::new(true);
        // An abort of a cut never seen here succeeds and records it aborted.
        let first = service
            .handle(&host, ENTORHINAL, &abort(&["r1", "r2"]))
            .await
            .unwrap();
        assert_eq!(first, b"{}");
        let refused = call(
            &service,
            &host,
            contract::ops::PREPARE,
            cut_params(CUT, &["r1"]),
        )
        .await
        .unwrap_err();
        assert_eq!(refused.code, RefusalCode::InvalidState);
        assert_eq!(refused.detail, Some(json!({"step": "aborted"})));
        // A prepare a later slice answered, then an abort: seeded as the
        // journal records them.
        let prepare = cut_request(Op::Prepare, OTHER_CUT, &["r1"]);
        let reply = br#"{"external":[],"items":[]}"#;
        host.journal
            .change(|contents| {
                let cut = contents.cuts.entry(OTHER_CUT.to_owned()).or_default();
                cut.step = Step::Aborted;
                cut.refs = Some(prepare.refs().unwrap().clone());
                cut.receipts
                    .insert(Op::Prepare.method().to_owned(), receipt(&prepare, reply));
            })
            .unwrap();
        first
    };
    // A restart: the journal is read back and a new service starts empty.
    let host = Stand::new(Journal::load(path));
    let service = Service::new(true);
    // The same request, its refs in another order and its members in
    // another order on the wire, is the same request.
    let reordered = serde_json::to_vec(&json!({
        "params": {"cutId": CUT, "refs": refs(&["r2", "r1"])},
        "method": contract::ops::ABORT,
    }))
    .unwrap();
    for request in [abort(&["r1", "r2"]), reordered] {
        assert_eq!(
            service.handle(&host, ENTORHINAL, &request).await.unwrap(),
            first
        );
    }
    for names in [&["r1"][..], &["r1", "r2", "r3"], &["r3"]] {
        let refused = service
            .handle(&host, ENTORHINAL, &abort(names))
            .await
            .unwrap_err();
        assert_eq!(refused.code, RefusalCode::IdReused, "{names:?}");
    }
    assert_eq!(
        service
            .handle(
                &host,
                ENTORHINAL,
                &body(contract::ops::PREPARE, cut_params(OTHER_CUT, &["r1"]))
            )
            .await
            .unwrap(),
        br#"{"external":[],"items":[]}"#
    );
    let refused = call(
        &service,
        &host,
        contract::ops::PREPARE,
        cut_params(OTHER_CUT, &["r2"]),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, RefusalCode::IdReused);
    assert_eq!(
        call(
            &service,
            &host,
            contract::ops::STATUS,
            cut_params(OTHER_CUT, &["r1"])
        )
        .await
        .unwrap(),
        json!({"step": "aborted"})
    );
    // Nothing above asked Entorhinal, the catalog or a worker.
    assert_eq!(host.reads(), 0);
}

/// Every op after the first names the ref set the cut started with; a
/// different set is refused `invalid_state` naming the expected refs, and
/// an op that skips a step is refused by the step machine first. A refusal
/// records nothing.
#[tokio::test]
async fn an_op_naming_another_ref_set_than_its_cut_is_refused_with_the_expected_refs() {
    let host = Stand::new(Journal::in_memory());
    let service = Service::new(true);
    seed(&host.journal, CUT, Step::Prepared, &["r1", "r2"]);
    let expected = json!({"step": "prepared", "refs": refs(&["r1", "r2"])});
    for (method, names) in [
        (contract::ops::EXPORT, &["r1"][..]),
        (contract::ops::EXPORT, &["r1", "r2", "r3"]),
        (contract::ops::ABORT, &["r2"]),
    ] {
        let refused = call(&service, &host, method, cut_params(CUT, names))
            .await
            .unwrap_err();
        assert_eq!(
            refused.code,
            RefusalCode::InvalidState,
            "{method} {names:?}"
        );
        assert_eq!(refused.detail, Some(expected.clone()), "{method} {names:?}");
    }
    // The same set in another order passes both checks and reaches the op,
    // which this build does not carry out yet; its refusal records nothing.
    let refused = call(
        &service,
        &host,
        contract::ops::EXPORT,
        cut_params(CUT, &["r2", "r1"]),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, RefusalCode::Unavailable);
    let cut = host.journal.contents().unwrap().cuts[CUT].clone();
    assert_eq!(cut.step, Step::Prepared);
    assert!(cut.receipts.is_empty());
    // Out of order: the step machine answers before the ref set is looked at.
    let refused = call(
        &service,
        &host,
        contract::ops::RELEASE,
        json!({"refs": refs(&["r9"]), "cutId": CUT, "holder": "mac-b"}),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, RefusalCode::InvalidState);
    assert_eq!(refused.detail, Some(json!({"step": "prepared"})));
    let refused = call(
        &service,
        &host,
        contract::ops::EXPORT,
        cut_params(OTHER_CUT, &["r1"]),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, RefusalCode::CutUnknown);
    assert!(!host
        .journal
        .contents()
        .unwrap()
        .cuts
        .contains_key(OTHER_CUT));
}

/// The cut's op lock is taken before the receipt is looked up and held
/// until the reply and its receipt are durable. A second request for the
/// cut waits for the first; a repeat then replays the first reply without
/// running, and another op runs against the state the first left. Another
/// cut never waits.
#[tokio::test]
async fn a_second_request_for_a_cut_waits_then_replays_or_runs_on_the_resulting_state() {
    let journal = Journal::in_memory();
    let service = Service::new(true);
    let prepare = cut_request(Op::Prepare, CUT, &["r1"]);
    let abort = cut_request(Op::Abort, CUT, &["r1"]);
    let elsewhere = cut_request(Op::Abort, OTHER_CUT, &["r1"]);
    let (started, started_rx) = tokio::sync::watch::channel(false);
    let wait_started = || {
        let mut started = started_rx.clone();
        async move {
            started.wait_for(|started| *started).await.unwrap();
        }
    };
    let (go, go_rx) = tokio::sync::oneshot::channel::<()>();
    let repeat_done = AtomicBool::new(false);
    let abort_done = AtomicBool::new(false);
    let abort_saw = Mutex::new(None);
    let first = service.keyed(&journal, &prepare, |cut| async move {
        assert!(cut.is_none());
        started.send(true).unwrap();
        go_rx.await.unwrap();
        Ok(Done::reply(&json!({"items": [], "external": []})))
    });
    let repeat = async {
        wait_started().await;
        let reply = service
            .keyed(&journal, &prepare, |_| async {
                panic!("a repeat never runs the op again")
            })
            .await;
        repeat_done.store(true, Ordering::SeqCst);
        reply
    };
    let later = async {
        wait_started().await;
        let reply = service
            .keyed(&journal, &abort, |cut| async {
                *abort_saw.lock().unwrap() = cut.map(|cut| cut.step);
                Ok(Done::reply(&json!({})))
            })
            .await;
        abort_done.store(true, Ordering::SeqCst);
        reply
    };
    let release = async {
        wait_started().await;
        // Another cut is not held up by this one.
        let other = service
            .keyed(&journal, &elsewhere, |_| async {
                Ok(Done::reply(&json!({})))
            })
            .await;
        assert_eq!(other.unwrap(), b"{}");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!repeat_done.load(Ordering::SeqCst), "the repeat waited");
        assert!(!abort_done.load(Ordering::SeqCst), "the abort waited");
        go.send(()).unwrap();
    };
    let (first, repeat, later, ()) = tokio::join!(first, repeat, later, release);
    let first = first.unwrap();
    assert_eq!(first, br#"{"external":[],"items":[]}"#);
    assert_eq!(repeat.unwrap(), first);
    assert_eq!(later.unwrap(), b"{}");
    assert_eq!(*abort_saw.lock().unwrap(), Some(Step::Prepared));
    let cut = journal.contents().unwrap().cuts[CUT].clone();
    assert_eq!(cut.step, Step::Aborted);
    assert_eq!(
        cut.receipts.keys().collect::<Vec<_>>(),
        vec![Op::Abort.method(), Op::Prepare.method()]
    );
    assert_eq!(cut.refs, Some(prepare.refs().unwrap().clone()));
}

fn busy_request(names: &[&str]) -> Value {
    json!({"refs": refs(names)})
}

fn pi(session: &str) -> SessionRef {
    SessionRef::new("thalamus-harness", "pi", session)
}

/// A session's committed publication with one fact, reserved under `key`.
fn publication(
    db: &crate::context_db::ContextDb,
    id: &str,
    session: &str,
    harness: &str,
    committed: bool,
    key: Option<&str>,
) {
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO memory_publications(publication_id, project_path, source_session_id, commit_order, committed_at)
             VALUES (?1, 'project-1', ?2, CASE WHEN ?3 THEN (SELECT COALESCE(MAX(commit_order), 0) + 1 FROM memory_publications) END, 0)",
            rusqlite::params![id, session, committed],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memory_stage_attempts(stage_key, project_path, publication_id, run_attempt, stage, session_id, harness, carrier, state, request_json, started_at)
             VALUES (?1, 'project-1', ?2, 1, 'turn_one', ?3, ?4, 'ck-mc', 'published', '{}', 0)",
            rusqlite::params![format!("[\"project-1\",\"{id}\",1,\"turn_one\"]"), id, session, harness],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memory_pending_facts(project_path, publication_id, fact_index, category, content, state, reserved_stage_key)
             VALUES ('project-1', ?1, 0, 'decision', 'a fact', CASE WHEN ?2 IS NULL THEN 'retryable' ELSE 'in_flight' END, ?2)",
            rusqlite::params![id, key],
        )
        .unwrap();
    });
}

/// Run `body` with the log captured, and return what it logged.
async fn logged<F: std::future::Future>(body: F) -> (F::Output, String) {
    #[derive(Clone, Default)]
    struct Captured(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Captured {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    use tracing::instrument::WithSubscriber;
    let output = Captured::default();
    let writer = output.clone();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    let result = body.with_subscriber(subscriber).await;
    let text = String::from_utf8(output.0.lock().unwrap().clone()).unwrap();
    (result, text)
}

/// `busy` answers per ref, in request order, with the first cause that
/// holds and its code: a summarizer run, a worker that does not answer, a
/// view the runner has not confirmed, or a fact a second-turn send holds
/// (with a log line naming its stage). A fact the move itself reserved, or
/// a fact of a publication that is not committed, is not a cause.
#[tokio::test]
async fn busy_reports_each_cause_with_its_code_in_request_order() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("context.db");
    let db = crate::context_db::ContextDb::create_for_tests(&path).unwrap();
    let mut host = Stand::new(Journal::in_memory());
    host.db = Some(path);
    for session in ["s1", "s2"] {
        host.bind(
            "pi-session",
            session,
            Some("thalamus-harness"),
            "pi",
            session,
        );
    }
    let service = Service::new(true);
    let entries = |reply: Value| -> Vec<(String, Option<String>)> {
        let reply: BusyReply = serde_json::from_value(reply).unwrap();
        reply
            .refs
            .into_iter()
            .map(|entry| {
                (
                    serde_json::to_value(entry.state)
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .to_owned(),
                    entry.reason_code,
                )
            })
            .collect()
    };
    let idle = || ("idle".to_owned(), None);
    let cause = |state: &str, code: &str| (state.to_owned(), Some(code.to_owned()));
    let busy = |names: &'static [&'static str]| {
        call(&service, &host, contract::ops::BUSY, busy_request(names))
    };
    assert_eq!(
        entries(busy(&["s1", "s2"]).await.unwrap()),
        vec![idle(), idle()]
    );

    host.historian.lock().unwrap().insert(pi("s2"));
    assert_eq!(
        entries(busy(&["s1", "s2"]).await.unwrap()),
        vec![idle(), cause("busy", "historian_running")]
    );
    host.historian.lock().unwrap().clear();

    *host.probe.lock().unwrap() = Probe::Answered {
        view_unconfirmed: true,
    };
    assert_eq!(
        entries(busy(&["s1"]).await.unwrap()),
        vec![cause("busy", "view_unconfirmed")]
    );
    *host.probe.lock().unwrap() = Probe::NoAnswer;
    assert_eq!(
        entries(busy(&["s1"]).await.unwrap()),
        vec![cause("unknown", "unknown")]
    );
    *host.probe.lock().unwrap() = Probe::Answered {
        view_unconfirmed: false,
    };
    assert_eq!(entries(busy(&["s1"]).await.unwrap()), vec![idle()]);

    // Not causes: the move's own reservation, an uncommitted publication,
    // another harness's session with the same id, and a waiting fact.
    publication(
        &db,
        "pub-move",
        "s1",
        "pi",
        true,
        Some(format!("agent-data:{CUT}").as_str()),
    );
    publication(
        &db,
        "pub-open",
        "s1",
        "pi",
        false,
        Some("[\"project-1\",\"pub-x\",1,\"turn_two\"]"),
    );
    publication(
        &db,
        "pub-other",
        "s1",
        "opencode2",
        true,
        Some("[\"project-1\",\"pub-y\",1,\"turn_two\"]"),
    );
    publication(&db, "pub-waiting", "s1", "pi", true, None);
    assert_eq!(entries(busy(&["s1"]).await.unwrap()), vec![idle()]);

    // A fact held by a second-turn send of any session of the project.
    let stage = "[\"project-1\",\"pub-z\",3,\"turn_two\"]";
    publication(&db, "pub-held", "s1", "pi", true, Some(stage));
    let (reply, log) = logged(busy(&["s2", "s1"])).await;
    assert_eq!(
        entries(reply.unwrap()),
        vec![idle(), cause("busy", "facts_in_flight")]
    );
    assert!(log.contains(stage), "{log}");
    assert!(log.contains("thalamus-harness/pi/s1"), "{log}");
    assert!(log.contains("project-1"), "{log}");

    // A summarizer run is reported before a held fact.
    host.historian.lock().unwrap().insert(pi("s1"));
    assert_eq!(
        entries(busy(&["s1"]).await.unwrap()),
        vec![cause("busy", "historian_running")]
    );
}

/// A ref resolves only through Entorhinal, and only to a session of the
/// runner that owns its kind. Anything else is a ref this machine does not
/// hold, refused `unknown_ref` naming the first such ref, before any
/// session is asked anything; a lookup that fails is `unavailable`.
#[tokio::test]
async fn busy_refuses_a_ref_this_machine_does_not_hold_naming_it() {
    let journal = Journal::in_memory();
    let held = pi("held");
    journal
        .change(|contents| {
            contents
                .session_mut(&held.runner, &held.harness, &held.session)
                .released = Some(super::journal::Released {
                cut: CUT.into(),
                holder: "mac-b".into(),
            });
        })
        .unwrap();
    let host = Stand::new(journal);
    host.bind("pi-session", "ok", Some("thalamus-harness"), "pi", "ok");
    host.bind("pi-session", "no-runner", None, "pi", "no-runner");
    host.bind(
        "pi-session",
        "wrong-runner",
        Some("broca"),
        "pi",
        "wrong-runner",
    );
    host.bind("pi-session", "held", Some("thalamus-harness"), "pi", "held");
    host.bind(
        "broca-session",
        "broca-1",
        Some("broca"),
        "broca",
        "broca-1",
    );
    let service = Service::new(true);
    for (kind, reference) in [
        ("magic_context.session", "ok"),
        ("pi-session", "missing"),
        ("pi-session", "no-runner"),
        ("pi-session", "wrong-runner"),
        ("pi-session", "held"),
    ] {
        let probes = host.probes.load(Ordering::SeqCst);
        let refused = call(
            &service,
            &host,
            contract::ops::BUSY,
            json!({"refs": [{"ref_kind": "pi-session", "ref": "ok"}, {"ref_kind": kind, "ref": reference}]}),
        )
        .await
        .unwrap_err();
        assert_eq!(refused.code, RefusalCode::UnknownRef, "{kind}/{reference}");
        assert_eq!(
            refused.detail,
            Some(json!({"ref_kind": kind, "ref": reference})),
            "{kind}/{reference}"
        );
        assert_eq!(
            host.probes.load(Ordering::SeqCst),
            probes,
            "no session was asked"
        );
    }
    let reply = call(
        &service,
        &host,
        contract::ops::BUSY,
        json!({"refs": [{"ref_kind": "broca-session", "ref": "broca-1"}, {"ref_kind": "pi-session", "ref": "ok"}]}),
    )
    .await
    .unwrap();
    assert_eq!(
        reply,
        json!({"refs": [{"state": "idle"}, {"state": "idle"}]})
    );
    host.entorhinal_answers.store(false, Ordering::SeqCst);
    let refused = call(&service, &host, contract::ops::BUSY, busy_request(&["ok"]))
        .await
        .unwrap_err();
    assert_eq!(refused.code, RefusalCode::Unavailable);
}

#[test]
fn only_a_build_with_debug_assertions_or_the_feature_reads_the_switch() {
    use super::switch;
    // A release build without the feature: the variable changes nothing.
    for value in [Some("1"), Some("0"), Some("yes"), None] {
        assert!(!switch(value, false, false), "{value:?}");
    }
    // A build that reads it: 1 and 0 decide, anything else is the default.
    assert!(switch(Some("1"), true, false));
    assert!(!switch(Some("0"), true, true));
    assert!(!switch(Some("yes"), true, false));
    assert!(switch(Some("yes"), true, true));
    assert!(!switch(None, true, false));
    assert!(switch(None, true, true));
}

#[tokio::test]
async fn with_moves_off_no_request_runs() {
    let host = Stand::new(Journal::in_memory());
    let service = Service::new(false);
    assert!(!service.enabled());
    let refused = call(&service, &host, contract::ops::DESCRIBE, json!({}))
        .await
        .unwrap_err();
    assert_eq!(refused.code, RefusalCode::Unavailable);
    assert_eq!(host.reads(), 0);
}
