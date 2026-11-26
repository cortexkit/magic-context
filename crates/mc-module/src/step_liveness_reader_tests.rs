use crate::runner_capabilities::RunnerCapabilities;
use cortexkit_role_llm_runner::awaits::AwaitParty;
use cortexkit_role_llm_runner::finish::Finish;
use cortexkit_role_llm_runner::run::{states, RunReason, RunStatus, RunStatusStep};
use cortexkit_role_llm_runner::wire::read_reply;

const STREAMING: &str = include_str!("../testdata/step-liveness-1126/streaming.json");

fn assert_usage(status: &RunStatus, steps: u64) {
    let usage = status.usage.as_ref().expect("reported run usage");
    assert_eq!(usage.steps, steps);
    assert_eq!(usage.unreported_steps, steps);
    if steps == 0 {
        assert!(usage.by_model.is_empty());
    } else {
        let [model] = usage.by_model.as_slice() else {
            panic!("expected one model in run usage, got {:?}", usage.by_model);
        };
        assert_eq!(model.provider, "fake");
        assert_eq!(model.model, "fake");
        assert_eq!(model.steps, steps);
        assert_eq!(model.unreported_steps, steps);
    }
}

fn assert_active<'a>(status: &'a RunStatus, phase: &str, steps: u64) -> &'a RunStatusStep {
    assert_eq!(status.state, states::ACTIVE);
    assert_usage(status, steps);
    let step = status.step.as_ref().expect("active model step");
    assert_eq!(step.phase.as_str(), phase);
    step
}

#[test]
fn awaiting_response() {
    let status = read_reply(include_bytes!(
        "../testdata/step-liveness-1126/awaiting_response.json"
    ))
    .expect("awaiting_response.json");
    let step = assert_active(&status, "awaiting_response", 0);
    assert_eq!(step.idle_deadline_ms, Some(1_795_728_791_001));
    assert_eq!(step.content_deadline_ms, Some(1_795_728_791_001));
    assert_eq!(step.last_event_at_ms, None);
}

#[test]
fn completed() {
    let status: RunStatus = read_reply(include_bytes!(
        "../testdata/step-liveness-1126/completed.json"
    ))
    .expect("completed.json");
    assert_eq!(status.state, states::COMPLETED);
    assert_eq!(status.finish, Some(Finish::Stop));
    assert!(status.step.is_none());
    assert_usage(&status, 2);
}

#[test]
fn preparing() {
    let status = read_reply(include_bytes!(
        "../testdata/step-liveness-1126/preparing.json"
    ))
    .expect("preparing.json");
    let step = assert_active(&status, "preparing", 0);
    assert_eq!(step.idle_deadline_ms, None);
    assert_eq!(step.content_deadline_ms, None);
    assert_eq!(step.last_event_at_ms, None);
}

#[test]
fn retrying() {
    let status = read_reply(include_bytes!(
        "../testdata/step-liveness-1126/retrying.json"
    ))
    .expect("retrying.json");
    assert_active(&status, "retrying", 0);
    assert_eq!(status.reason, Some(RunReason::ServerBusy));
    let wait = status.awaits.expect("runner-owned retry wait");
    assert_eq!(wait.party, AwaitParty::Runner);
    assert_eq!(wait.reason, Some(RunReason::ServerBusy));
    assert_eq!(wait.next_ms, Some(1_795_727_011_016));
    assert_eq!(wait.attempt, Some(2));
}

#[test]
fn running_tools() {
    let status = read_reply(include_bytes!(
        "../testdata/step-liveness-1126/running_tools.json"
    ))
    .expect("running_tools.json");
    let step = assert_active(&status, "running_tools", 1);
    assert_eq!(step.last_event_at_ms, Some(1_795_726_991_113));
    assert_eq!(step.idle_deadline_ms, None);
    assert_eq!(step.content_deadline_ms, None);
}

#[test]
fn streaming() {
    let status = read_reply(STREAMING.as_bytes()).expect("streaming.json");
    let step = assert_active(&status, "streaming", 0);
    assert_eq!(step.last_event_at_ms, Some(1_795_726_991_086));
    assert_eq!(step.idle_deadline_ms, Some(1_795_727_291_086));
    assert_eq!(step.content_deadline_ms, Some(1_795_728_791_086));
}

#[test]
fn unknown_phase() {
    let body = STREAMING.replacen(
        "\"phase\":\"streaming\"",
        "\"phase\":\"reading_response_headers\"",
        1,
    );
    let status = read_reply(body.as_bytes()).expect("an unknown phase must not refuse status");
    assert_active(&status, "reading_response_headers", 0);
}

#[tokio::test]
async fn role_describe_with_step_liveness_keeps_known_capabilities() {
    // The capture set contains only run.status replies.
    let body = br#"{"result":{"capabilities":["run_status","step_liveness","run_cancel"]}}"#;
    let describe = read_reply(body).expect("wrapped role.describe reply");
    assert!(
        RunnerCapabilities::default()
            .run_cancel("broca", 1, async { Ok(describe) })
            .await
    );
}
