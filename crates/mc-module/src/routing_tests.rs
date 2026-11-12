use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

fn request() -> SelectRequest {
    summary_select("runner", "claude-code", &["provider/tried".into()])
}

#[tokio::test]
async fn select_harness_requires_the_exact_declared_group() {
    for (declaration, expected) in [
        (
            json!({"capabilities": ["select_harness", "future_group", 7]}),
            Some("claude-code"),
        ),
        (
            json!({"capabilities": ["select_prefer", "select_hold_control"]}),
            None,
        ),
        (json!({"capabilities": "select_harness"}), None),
        (json!({"select_harness": true}), None),
        (json!({}), None),
    ] {
        let request = Capabilities::default()
            .select_request("routing", 1, request(), async { Ok(declaration) })
            .await;
        let wire = serde_json::to_value(&request).unwrap();
        assert_eq!(request.harness.as_deref(), expected);
        assert_eq!(wire.get("harness").and_then(Value::as_str), expected);
        if expected.is_none() {
            assert!(wire.get("harness").is_none(), "omit, do not send null");
        }
        assert_eq!(request.runners, Some(vec!["runner".into()]));
        assert_eq!(request.exclude, Some(vec!["provider/tried".into()]));
    }
}

#[tokio::test]
async fn declarations_are_shared_by_provider_and_connection_epoch() {
    let capabilities = Capabilities::default();
    let reads = AtomicUsize::new(0);
    let describe = || async {
        reads.fetch_add(1, Ordering::SeqCst);
        tokio::task::yield_now().await;
        Ok(json!({"capabilities": ["select_harness"]}))
    };
    let (first, second) = tokio::join!(
        capabilities.select_request("routing", 1, request(), describe()),
        capabilities.select_request("routing", 1, request(), describe()),
    );
    assert_eq!(first.harness, second.harness);
    assert_eq!(first.harness.as_deref(), Some("claude-code"));
    assert_eq!(reads.load(Ordering::SeqCst), 1);

    let other = capabilities
        .select_request("other-routing", 1, request(), async { Ok(json!({})) })
        .await;
    assert!(
        other.harness.is_none(),
        "providers do not share declarations"
    );
    let reconnected = capabilities
        .select_request("routing", 2, request(), async { Ok(json!({})) })
        .await;
    assert!(
        reconnected.harness.is_none(),
        "a reconnect expires discovery"
    );
}

#[tokio::test]
async fn a_missing_capability_is_cached_until_reconnect() {
    let capabilities = Capabilities::default();
    let first = capabilities
        .select_request("routing", 1, request(), async {
            Ok(json!({"capabilities": []}))
        })
        .await;
    assert!(first.harness.is_none());
    let cached = capabilities
        .select_request("routing", 1, request(), async { panic!("cached") })
        .await;
    assert!(cached.harness.is_none());
    let reconnected = capabilities
        .select_request("routing", 2, request(), async {
            Ok(json!({"capabilities": ["select_harness"]}))
        })
        .await;
    assert_eq!(reconnected.harness.as_deref(), Some("claude-code"));
}

/// A describe call that fails tells nothing about the provider, so it is not
/// cached: a provider that was still starting gets asked again on the next
/// select, without waiting for a reconnect.
#[tokio::test]
async fn a_failed_discovery_is_asked_again_on_the_next_select() {
    let capabilities = Capabilities::default();
    let failed = capabilities
        .select_request("routing", 1, request(), async {
            Err(RouteError {
                code: "routing_unavailable".into(),
                message: "role.describe failed".into(),
                detail: None,
            })
        })
        .await;
    assert!(failed.harness.is_none());
    let next = capabilities
        .select_request("routing", 1, request(), async {
            Ok(json!({"capabilities": ["select_harness"]}))
        })
        .await;
    assert_eq!(next.harness.as_deref(), Some("claude-code"));
}
