use super::*;
use crate::dream_dispatch::broca_port::SubcBroca;
use crate::dream_dispatch::executor::BrocaPorts;
use crate::historian_producer::tests::held_calls_tests::{capture_server, RESULT_TEXT};
use crate::route_targets::RouteTargetConfig;
use crate::runner_follow::held_calls::cases;

#[tokio::test]
async fn broca_held_calls_dreamer_real_port_and_carrier() {
    for case in cases() {
        let mut outcomes = Vec::new();
        for capture in [&case.before, &case.after] {
            let fixture = Fixture::new(BASE);
            let server = capture_server(capture, child_runner_describe(), true).await;
            let port = SubcBroca {
                connection_file: server.connection_file.clone(),
                route_targets: RouteTargetConfig::runner_module("llm-runner"),
                project_root: fixture.context.config.directory.clone(),
                harness: "mc-test".into(),
                session_runner: None,
            }
            .port();
            let mut carrier = BrocaCarrier::new(
                port,
                fixture.handler.broca_dream_tools(),
                fixture.context.clone(),
                fixture.effects.clone(),
                fixture.effects.clone(),
                fixture.scheduler.clone(),
                policy(),
            );
            let request = fixture.request(&["ctx_memory"], 3);
            let child = carrier.open(&request).await.unwrap();
            carrier.start(&child).await.unwrap();
            // SubcBrocaPort decodes the actual StreamData body. Count all control
            // wakes, including the final status with no event, before allowing a
            // terminal status reply; completion cannot skip the tail of a capture.
            tokio::time::timeout(Duration::from_secs(5), async {
                for _ in 0..capture.controls() {
                    while !carrier.drain(&child).await.unwrap() {
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                    assert!(carrier.result(&child).await.unwrap().is_none());
                }
            })
            .await
            .unwrap_or_else(|_| panic!("{} did not wake for every control", capture.path));
            assert!(!carrier.drain(&child).await.unwrap());
            let text = if capture.listed() {
                let outcome = tokio::time::timeout(
                    Duration::from_millis(30),
                    carrier.complete(&child, &request),
                )
                .await;
                assert!(outcome.is_err(), "{} must remain nonterminal", capture.path);
                assert!(!carrier.attempt.as_ref().unwrap().cancel_sent);
                None
            } else {
                server.complete_capture().await;
                let completion = carrier.complete(&child, &request).await.unwrap();
                assert_eq!(completion.text, RESULT_TEXT, "{}", capture.path);
                Some(completion.text)
            };
            let result_calls = server.result_calls().await;
            assert_eq!(result_calls, usize::from(!capture.listed()));
            outcomes.push((text, result_calls));
        }
        assert_eq!(outcomes[0], outcomes[1], "{}", case.name);
    }
}
