use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

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
