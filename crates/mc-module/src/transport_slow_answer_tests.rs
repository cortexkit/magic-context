use super::*;

#[test]
fn slow_answer_logs_operation_elapsed_and_route_at_thresholds() {
    let route = AnswerRoute {
        session: Some("session-42".into()),
        caller: Some("runner-module".into()),
    };
    for (elapsed, body, level, op) in [
        (
            500,
            &br#"{"method":"compaction.notice"}"#[..],
            "INFO",
            "compaction.notice",
        ),
        (
            1499,
            &br#"{"method":"transform.hook"}"#[..],
            "INFO",
            "transform.hook",
        ),
        (
            1500,
            &br#"{"name":"tool.catalog","arguments":{}}"#[..],
            "WARN",
            "tool.catalog",
        ),
    ] {
        let (_, logs) = crate::test_log::logged(|| {
            log_slow_answer(Duration::from_millis(elapsed), body, Some(&route));
        });
        assert_eq!(logs.lines().count(), 1, "{logs}");
        assert!(logs.contains(level), "{logs}");
        assert!(logs.contains(op), "{logs}");
        assert!(logs.contains(&format!("elapsed_ms={elapsed}")), "{logs}");
        assert!(logs.contains("session-42"), "{logs}");
        assert!(logs.contains("runner-module"), "{logs}");
    }
}

#[test]
fn fast_answer_logs_nothing() {
    let (_, logs) = crate::test_log::logged(|| {
        log_slow_answer(
            Duration::from_millis(499),
            br#"{"method":"compaction.ride"}"#,
            None,
        );
    });
    assert!(logs.is_empty(), "{logs}");
}
