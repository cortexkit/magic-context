use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

#[tokio::test]
async fn temperature_uses_only_the_declared_group_and_shares_discovery() {
    let cache = RunnerCapabilities::default();
    assert!(
        cache
            .temperature("runner", 1, async {
                Ok(json!({"capabilities": ["temperature", "cache_policy", "future_group"]}))
            })
            .await
    );
    assert!(
        cache
            .cache_policy("runner", 1, async {
                panic!("temperature discovery must be shared")
            })
            .await
    );
    for (index, value) in [
        json!({}),
        json!({"temperature": true}),
        json!({"capabilities": "temperature"}),
        json!({"capabilities": [17, {"temperature": true}, "cache_policy"]}),
    ]
    .into_iter()
    .enumerate()
    {
        assert!(
            !cache
                .temperature("runner", index as u64 + 2, async { Ok(value) })
                .await
        );
    }
    assert!(
        !cache
            .temperature("offline", 1, async { Err(ClientError::new("offline")) })
            .await
    );
}

#[tokio::test]
async fn notice_keep_and_cache_policy_share_the_declared_set() {
    let cache = RunnerCapabilities::default();
    assert!(
        cache
            .notice_keep("runner", 1, async {
                Ok(json!({"capabilities": ["message_marks", "notice_keep", "cache_policy"]}))
            })
            .await
    );
    assert!(
        cache
            .cache_policy("runner", 1, async {
                panic!("Setup discovery must be shared with child cache discovery")
            })
            .await
    );
    assert!(
        !cache
            .notice_keep("runner", 2, async {
                Ok(json!({"capabilities": ["cache_policy"]}))
            })
            .await
    );
}

#[tokio::test]
async fn notice_keep_is_false_for_absent_or_unrecognised_declarations() {
    let cache = RunnerCapabilities::default();
    for (epoch, answer) in [
        json!({}),
        json!({"capabilities": "notice_keep"}),
        json!({"capabilities": [17, {"notice_keep": true}, "future_group"]}),
        json!({"capabilities": ["notice_keep"]}),
        json!({"capabilities": ["message_marks"]}),
    ]
    .into_iter()
    .enumerate()
    {
        assert!(
            !cache
                .notice_keep("runner", epoch as u64, async { Ok(answer) })
                .await
        );
    }
}

#[tokio::test]
async fn notice_keep_discovery_failure_is_retried_after_setup() {
    let cache = RunnerCapabilities::default();
    assert!(
        !cache
            .notice_keep("runner", 1, async {
                Err(ClientError::new("describe refused"))
            })
            .await
    );
    assert!(
        !cache
            .notice_keep("runner", 1, async {
                panic!("failed discovery must be cached")
            })
            .await
    );
    cache.forget("runner");
    assert!(
        cache
            .notice_keep("runner", 1, async {
                Ok(json!({"capabilities": ["message_marks", "notice_keep"]}))
            })
            .await
    );
}

#[tokio::test]
async fn discovery_is_lenient_and_shared_per_runner_connection() {
    let cache = RunnerCapabilities::default();
    let reads = AtomicUsize::new(0);
    for _ in 0..2 {
        assert!(
            cache
                .cache_policy("runner", 1, async {
                    reads.fetch_add(1, Ordering::SeqCst);
                    Ok(
                        json!({"capabilities": [17, "future_feature", "cache_policy"],
                "majors": "a future shape", "unrelated": {"anything": true}}),
                    )
                })
                .await
        );
    }
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert!(
        !cache
            .cache_policy("other-runner", 1, async { Ok(json!({})) })
            .await
    );
}

#[tokio::test]
async fn reconnect_discards_the_cached_declaration() {
    let cache = RunnerCapabilities::default();
    assert!(
        !cache
            .cache_policy("runner", 1, async { Ok(json!({"capabilities": []})) })
            .await
    );
    assert!(
        !cache
            .cache_policy("runner", 1, async {
                panic!("cached answer must be reused")
            })
            .await
    );
    assert!(
        cache
            .cache_policy("runner", 2, async {
                Ok(json!({"capabilities": ["cache_policy"]}))
            })
            .await
    );
    cache.forget("runner");
    assert!(
        !cache
            .cache_policy("runner", 2, async { Ok(json!({"capabilities": []})) })
            .await
    );
}

#[tokio::test]
async fn discovery_failures_are_cached_until_setup() {
    let cache = RunnerCapabilities::default();
    assert!(
        !cache
            .cache_policy("runner", 1, async {
                Err(ClientError::new("describe refused"))
            })
            .await
    );
    assert!(
        !cache
            .cache_policy("runner", 1, async {
                panic!("failed discovery must be cached")
            })
            .await
    );
    cache.forget("runner");
    assert!(
        cache
            .cache_policy("runner", 1, async {
                Ok(json!({"capabilities": ["cache_policy"]}))
            })
            .await
    );
}

#[tokio::test]
async fn session_class_uses_only_the_declared_group_and_shares_discovery() {
    let cache = RunnerCapabilities::default();
    assert!(cache.session_class("runner", 1, async {
        Ok(json!({"capabilities": ["session_class", "cache_policy"], "session_class": {"backup_classes": ["summary"]}}))
    }).await);
    assert!(
        cache
            .cache_policy("runner", 1, async { panic!("shared cached declaration") })
            .await
    );
    for (index, value) in [
        json!({}),
        json!({"session_class":{"backup_classes":["summary"]}}),
        json!({"capabilities":["other"]}),
    ]
    .into_iter()
    .enumerate()
    {
        assert!(
            !cache
                .session_class("runner", index as u64 + 2, async { Ok(value) })
                .await
        );
    }
    assert!(
        !cache
            .session_class("unreachable", 1, async { Err(ClientError::new("offline")) })
            .await
    );
}

#[tokio::test]
async fn session_retention_needs_the_declared_group_and_reads_its_maximum() {
    let cache = RunnerCapabilities::default();
    assert_eq!(
        cache
            .session_retention("runner", 1, async {
                Ok(json!({
                    "capabilities": ["session_retention", "cache_policy"],
                    "session_retention": {"max_days": 30, "max_unreleased_hold_ms": 60000, "required": false},
                }))
            })
            .await,
        Some(SessionRetention { max_days: Some(30) })
    );
    assert!(
        cache
            .cache_policy("runner", 1, async { panic!("shared cached declaration") })
            .await
    );
    // Declared without a usable limit: still declared, with nothing to fit to.
    for (index, limits) in [
        json!(null),
        json!({"max_days": 0}),
        json!({"max_days": "7"}),
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            cache
                .session_retention("runner", index as u64 + 2, async {
                    Ok(json!({"capabilities": ["session_retention"], "session_retention": limits}))
                })
                .await,
            Some(SessionRetention { max_days: None })
        );
    }
    // Limits alone, or the legacy `retention` group, are not the group.
    for (index, value) in [
        json!({}),
        json!({"session_retention": {"max_days": 30}}),
        json!({"capabilities": ["retention"], "retention": {"max_seconds": 600}}),
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            cache
                .session_retention("runner", index as u64 + 10, async { Ok(value) })
                .await,
            None
        );
    }
    assert_eq!(
        cache
            .session_retention("unreachable", 1, async { Err(ClientError::new("offline")) })
            .await,
        None
    );
}

#[test]
fn a_retention_policy_keeps_the_days_asked_unless_the_runner_allows_fewer() {
    let wire = |days: u32| json!({"keep": {"days": days}, "archive_after_days": 0, "backup": false, "request_dumps": false});
    for (max_days, kept) in [(Some(30), 7), (Some(7), 7), (Some(3), 3), (None, 7)] {
        let policy = SessionRetention { max_days }.keep_for(7);
        assert_eq!(
            serde_json::to_value(&policy).unwrap(),
            wire(kept),
            "{max_days:?}"
        );
        // A child nobody keeps has no days to fit.
        assert_eq!(
            serde_json::to_value(SessionRetention { max_days }.keep_none()).unwrap(),
            json!({"keep": "none", "archive_after_days": 0, "backup": false, "request_dumps": false})
        );
    }
}
