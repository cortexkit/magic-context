//! The summarizer has one shape: every run sends the two-turn historian's
//! first turn, with or without a project, after any number of failed runs.
//!
//! The bytes that first turn sends are pinned too. A fixed run is made with
//! memory on and with memory off, and every `session.send` it makes to its
//! summarizer child is compared, field for field and byte for byte, with
//! `testdata/turn-one-request.json`. A change that alters what the
//! first turn sends (system prompt, user prompt, child name, run parameters
//! or cache request) fails there. When such a change is intended, set
//! `MC_RECORD_TURN_ONE_REQUEST=1` once to write the new recording, and
//! review its diff.

use super::*;
use crate::client::ClientError;
use cortexkit_role_compaction::read::{ReadPage, ReadRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::FinalMessage;
use cortexkit_role_llm_runner::send::SendReply;
use cortexkit_role_routing::report::ReportRequest;
use cortexkit_role_routing::select::{RouteRef, RunnerRef, SelectAnswer, SelectRequest};
use std::sync::Mutex;

const RECORDING: &str = "testdata/turn-one-request.json";
const ROUTE: &str = "test/model";

/// A runner that declares every optional send member, so the recording
/// holds them. Routing offers one model under one decision every time it is
/// asked, and none once that model is excluded. Each send is answered with
/// a valid first-turn reply, or with text that is no reply at all.
struct Client {
    runner: account_wait_send_tests::Client,
    valid: bool,
    sends: Mutex<Vec<(Child, SendRequest)>>,
}

impl Client {
    fn new(valid: bool) -> Self {
        Self {
            runner: account_wait_send_tests::Client::new(
                account_wait_send_tests::Answer::RefuseSend,
            ),
            valid,
            sends: Mutex::new(Vec::new()),
        }
    }
}

impl RunnerClient for Client {
    async fn child_cache_policy(&self, _: &Child) -> bool {
        true
    }
    async fn child_session_class(&self, _: &Child) -> bool {
        true
    }
    async fn child_temperature(&self, _: &Child) -> bool {
        true
    }
    async fn read(
        &self,
        session: &SessionRef,
        request: ReadRequest,
    ) -> Result<ReadPage, ClientError> {
        self.runner.read(session, request).await
    }
    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        unreachable!()
    }
    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        unreachable!()
    }
    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        unreachable!()
    }
    async fn send_child(
        &self,
        child: &Child,
        request: SendRequest,
    ) -> Result<SendReply, ClientError> {
        self.sends.lock().unwrap().push((child.clone(), request));
        let mut reply = SendReply::new(states::ACTIVE);
        reply.run_id = Some("run".into());
        Ok(reply)
    }
    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        let prompt = self
            .sends
            .lock()
            .unwrap()
            .last()
            .and_then(|(_, request)| request.prompt.clone())
            .unwrap_or_default();
        let mut result = RunResult::new("run", states::COMPLETED);
        result.final_message = Some(FinalMessage {
            ordinal: 1,
            mid: "answer".into(),
            text: if self.valid {
                mc_mock_runner::child::turn_one_reply(&mc_mock_runner::child::summarize(&prompt))
            } else {
                "not a summary".into()
            },
        });
        Ok(result)
    }
}

impl Router for Client {
    async fn select(&self, request: SelectRequest) -> Result<SelectAnswer, routing::RouteError> {
        if request
            .exclude
            .as_ref()
            .is_some_and(|excluded| excluded.iter().any(|route| route == ROUTE))
        {
            return Err(routing::RouteError {
                code: "no_route".into(),
                message: "every route excluded".into(),
                detail: None,
            });
        }
        let route = RouteRef::new("test", "model");
        let runner = RunnerRef::new(
            request.runners.unwrap_or_default()[0].clone(),
            route.clone(),
        );
        Ok(SelectAnswer::new(
            "decision",
            route,
            runner,
            400_000,
            32_000,
            u64::MAX,
            "test",
        ))
    }
    async fn report(&self, request: ReportRequest) {
        self.runner.report(request).await;
    }
}

/// A job for project `pj-test`. Run with a store, it records each
/// first-turn send in the store before the send goes out.
fn project_job() -> Request {
    let mut job = account_wait_send_tests::job();
    job.project = Some("pj-test".into());
    job
}

/// Every send one run makes, as JSON: the child it went to and the request.
async fn sends_of(job: Request) -> Value {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    let client = Client::new(true);
    let summarized = run(&client, Some(&db), &job)
        .await
        .expect("the run succeeds")
        .expect("the run has messages to summarize");
    assert!(!summarized.validated.compartments.is_empty());
    let sends = client.sends.lock().unwrap();
    Value::Array(
        sends
            .iter()
            .map(|(child, request)| {
                json!({
                    "child": {
                        "runner": child.session.runner,
                        "harness": child.session.harness,
                        "session": child.session.session,
                        "project_root": child.project_root,
                    },
                    "request": request,
                })
            })
            .collect(),
    )
}

#[tokio::test]
async fn a_two_turn_first_turn_sends_the_recorded_bytes() {
    let mut memory_on = project_job();
    memory_on.memory_enabled = true;
    memory_on.auto_promote = true;
    let mut memory_off = project_job();
    memory_off.language = Some("de".into());
    let actual = serde_json::to_string_pretty(&json!({
        "memory_on": sends_of(memory_on).await,
        "memory_off_german": sends_of(memory_off).await,
    }))
    .unwrap()
        + "\n";
    let path = format!("{}/{RECORDING}", env!("CARGO_MANIFEST_DIR"));
    if std::env::var_os("MC_RECORD_TURN_ONE_REQUEST").is_some() {
        std::fs::write(&path, &actual).expect(&path);
    }
    let expected = std::fs::read_to_string(&path).expect(&path);
    // The recording is long: name where it first differs instead of
    // printing both.
    if actual != expected {
        let at = actual
            .bytes()
            .zip(expected.bytes())
            .position(|(a, b)| a != b)
            .unwrap_or(actual.len().min(expected.len()));
        let window = |text: &str| {
            let mut start = at.saturating_sub(200).min(text.len());
            while !text.is_char_boundary(start) {
                start -= 1;
            }
            let mut end = (at + 200).min(text.len());
            while !text.is_char_boundary(end) {
                end += 1;
            }
            text[start..end].to_owned()
        };
        panic!(
            "the first turn's sends differ from {RECORDING} at byte {at} (lengths {} and {}):\nactual:   {:?}\nrecorded: {:?}",
            actual.len(),
            expected.len(),
            window(&actual),
            window(&expected)
        );
    }
}

/// A failed run is an ordinary summary failure: the next run, however many
/// failed before it, sends the same two-turn first turn again, never a
/// one-turn prompt or a repair of its reply.
#[tokio::test]
async fn runs_after_failed_runs_still_send_the_two_turn_first_turn() {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    let client = Client::new(false);
    let job = project_job();
    for _ in 0..5 {
        let error = run(&client, Some(&db), &job)
            .await
            .expect_err("no reply is a summary");
        assert!(matches!(error, SummaryError::Failed(_)), "{error:?}");
    }
    let sends = client.sends.lock().unwrap();
    // One send per run: the one model fails, and routing has no other.
    assert_eq!(sends.len(), 5);
    let system = two_pass_system(None);
    for (child, request) in sends.iter() {
        assert!(
            child.session.session.ends_with(":turn-one"),
            "{}",
            child.session.session
        );
        assert_eq!(request.runner_params["system"], json!(system));
        assert!(request
            .prompt
            .as_deref()
            .is_some_and(|prompt| prompt.ends_with(turn_one::FORMAT_INSTRUCTION)));
    }
}
