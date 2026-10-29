use super::*;
use crate::runner_follow::held_calls::{cases, Capture};

pub(crate) const RESULT_TEXT: &str = "authoritative run.result, not stream text";

pub(crate) async fn capture_server(
    capture: &Capture,
    describe: Value,
    keep_stream_open: bool,
) -> FakeServer {
    let server = fake_server_with_role_describe(
        json!({"state":"active","run_id":"run-1"}),
        capture.frames.clone(),
        describe,
        false,
    )
    .await;
    let mut answers = server.answers.lock().await;
    answers.keep_stream_open = keep_stream_open;
    // The fake sends status and result as separate authoritative replies rather
    // than inferring them from a paused unit in the subscribe stream.
    answers.statuses =
        [json!({"state": if capture.listed() { capture.state() } else { "active" }})].into();
    answers.result = Some(json!({
        "run_id":"run-1", "state":"completed",
        "final_message":{"ordinal":1,"mid":"answer","text":RESULT_TEXT}
    }));
    drop(answers);
    server
}

impl FakeServer {
    pub(crate) async fn complete_capture(&self) {
        self.answers.lock().await.statuses = [json!({"state":"completed"})].into();
    }

    pub(crate) async fn result_calls(&self) -> usize {
        self.log.lock().await.results.len()
    }
}

#[tokio::test]
async fn broca_held_calls_summarizer_wait_and_interleaved() {
    for interleaved in [false, true] {
        for case in cases() {
            let mut outcomes = Vec::new();
            for capture in [&case.before, &case.after] {
                let server =
                    capture_server(capture, session_retention_describe(false), false).await;
                let mut producer = client(&server).await;
                producer
                    .start("held-call-child", "", "prompt", "provider/model")
                    .await
                    .unwrap();
                let route = producer.ensure_subscribe_route().await.unwrap();
                let corr = producer
                    .send_request(
                        route,
                        json!({"method":"session.subscribe","params":{"from":"start"}}),
                    )
                    .await
                    .unwrap();
                let mut subscription = Some((route, corr));
                if interleaved {
                    // The command reply is sent after the complete capture, so
                    // read_terminal_for must decode every intervening StreamData.
                    let command = producer.ensure_command_route().await.unwrap();
                    producer
                        .unary_json(
                            command,
                            json!({"method":"run.status","params":{"run_id":"run-1"}}),
                        )
                        .await
                        .unwrap();
                    assert!(producer.control_pending, "{}", capture.path);
                    producer.wait_for_control(&mut subscription).await.unwrap();
                    assert!(!producer.control_pending);
                    // The unary reader has also consumed the fixture's StreamEnd.
                    subscription = None;
                } else {
                    for index in 0..capture.controls() {
                        producer.wait_for_control(&mut subscription).await.unwrap();
                        assert!(subscription.is_some(), "{} control {index}", capture.path);
                    }
                    // All captures end with a control. Reaching StreamEnd here
                    // proves the last eventless status was a wake, not skipped.
                    producer.wait_for_control(&mut subscription).await.unwrap();
                    assert!(subscription.is_none(), "{}", capture.path);
                }
                if !capture.listed() {
                    server.complete_capture().await;
                }
                let outcome = tokio::time::timeout(
                    Duration::from_millis(30),
                    producer.drain_subscribe(subscription, "run-1"),
                )
                .await;
                let text = if capture.listed() {
                    assert!(outcome.is_err(), "{} must remain nonterminal", capture.path);
                    None
                } else {
                    let output = outcome.unwrap().unwrap();
                    assert_eq!(output.text, RESULT_TEXT, "{}", capture.path);
                    Some(output.text)
                };
                let result_calls = server.result_calls().await;
                assert_eq!(result_calls, usize::from(!capture.listed()));
                outcomes.push((text, result_calls));
                producer.close().await;
            }
            assert_eq!(
                outcomes[0], outcomes[1],
                "{} interleaved={interleaved}",
                case.name
            );
        }
    }
}
