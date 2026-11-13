use super::session_class_tests::Client;
use super::*;
use crate::runner_capabilities::SessionRetention;

fn child() -> Child {
    Child {
        session: SessionRef::new("retention-test", "mock", "summary-child"),
        project_root: Some("/project".into()),
    }
}

/// The `retention_policy` a declaring runner is sent to keep a child `days`
/// days.
fn kept(days: u32) -> Value {
    json!({"keep": {"days": days}, "archive_after_days": 0, "backup": false, "request_dumps": false})
}

/// The `retention_policy` for a child nobody keeps.
fn not_kept() -> Value {
    json!({"keep": "none", "archive_after_days": 0, "backup": false, "request_dumps": false})
}

/// A first summary turn and its second turn in the same child, as the two
/// sends reach `client`, with the children kept when `keep_child` says so.
async fn turn_one_then_turn_two(client: &Client, keep_child: bool) -> Vec<SendRequest> {
    let model = ModelRef::new("provider", "model");
    let mut how = Model {
        model: &model,
        decision_id: "decision",
        output_tokens: 1000,
        system: "system",
        deadline: tokio::time::Instant::now() + Duration::from_secs(1),
        continuation: false,
        creates_child: true,
        keep_child,
        cache_ttl: cortexkit_role_llm_runner::cache::Ttl::None,
        send: SendKind::TurnOne,
        plan: None,
    };
    send_and_wait(client, &child(), "first", "prompt", &how, &mut None)
        .await
        .unwrap();
    how.continuation = true;
    how.creates_child = false;
    how.send = SendKind::TurnTwo;
    send_and_wait(client, &child(), "second", "follow-up", &how, &mut None)
        .await
        .unwrap();
    let sends = client.sends.lock().unwrap();
    sends.iter().map(|(_, request)| request.clone()).collect()
}

#[tokio::test]
async fn a_declaring_runner_keeps_a_summary_child_only_when_asked_and_only_on_its_creating_send() {
    for (keep_child, max_days, policy) in [
        (true, Some(30), kept(7)),
        (true, Some(3), kept(3)),
        (true, None, kept(7)),
        (false, Some(30), not_kept()),
        (false, None, not_kept()),
    ] {
        let mut client = Client::new(false);
        client.retention = Some(SessionRetention { max_days });
        let sends = turn_one_then_turn_two(&client, keep_child).await;
        assert_eq!(
            serde_json::to_value(&sends[0]).unwrap()["retention_policy"],
            policy,
            "keep {keep_child}, max {max_days:?}"
        );
        // The runner froze the policy with the child; a later send repeats
        // nothing about storage.
        assert_eq!(sends[1].retention_policy, None);
        assert!(!serde_json::to_string(&sends[1])
            .unwrap()
            .contains("retention"));
    }
}

#[tokio::test]
async fn a_runner_without_session_retention_gets_the_same_summary_send_bytes_as_before() {
    for keep_child in [true, false] {
        let client = Client::new(false);
        let sends = turn_one_then_turn_two(&client, keep_child).await;
        // Pinned independently of the request builder under test.
        assert_eq!(
            serde_json::to_string(&sends[0]).unwrap(),
            include_str!("../../testdata/summary-creating-send-0.8.36.json").trim_end()
        );
        assert!(sends.iter().all(|request| !serde_json::to_string(request)
            .unwrap()
            .contains("retention")));
    }
}
