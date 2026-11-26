use super::*;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};

struct FakeSynapse {
    calls: AtomicUsize,
    replies: Mutex<VecDeque<Result<Value, String>>>,
}

impl FakeSynapse {
    fn new(replies: impl IntoIterator<Item = Result<Value, String>>) -> Self {
        Self {
            calls: AtomicUsize::new(0),
            replies: Mutex::new(replies.into_iter().collect()),
        }
    }

    async fn call(&self, method: &str) -> Result<Value, String> {
        assert_eq!(method, "models.list");
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.replies.lock().unwrap().pop_front().unwrap()
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

fn absent() -> Result<Value, String> {
    Err("unknown_module".into())
}

fn catalog() -> Result<Value, String> {
    Ok(json!({"result": {"table_epoch": 7, "models": [
        {"model_id": MODEL, "serving_admission": "enabled", "fingerprints": ["a".repeat(64)]}
    ]}}))
}

#[tokio::test(start_paused = true)]
async fn unknown_module_probes_after_thirty_seconds_then_ten_minutes() {
    let cache = SynapseCatalog::new();
    let client = FakeSynapse::new([absent(), absent(), absent(), absent()]);
    let missing = Err(Skipped("unknown_module".into()));
    assert_eq!(cache.pin(client.call("models.list")).await, missing);
    for _ in 0..2 {
        assert_eq!(cache.pin(client.call("models.list")).await, missing);
    }
    assert_eq!(client.calls(), 1);
    tokio::time::advance(Duration::from_secs(29)).await;
    assert_eq!(cache.pin(client.call("models.list")).await, missing);
    assert_eq!(client.calls(), 1);
    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(cache.pin(client.call("models.list")).await, missing);
    assert_eq!(client.calls(), 2);
    tokio::time::advance(Duration::from_secs(599)).await;
    assert_eq!(cache.pin(client.call("models.list")).await, missing);
    assert_eq!(client.calls(), 2);
    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(cache.pin(client.call("models.list")).await, missing);
    assert_eq!(client.calls(), 3);
    tokio::time::advance(Duration::from_secs(599)).await;
    assert_eq!(cache.pin(client.call("models.list")).await, missing);
    assert_eq!(client.calls(), 3);
    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(cache.pin(client.call("models.list")).await, missing);
    assert_eq!(client.calls(), 4);
}

#[tokio::test(start_paused = true)]
async fn catalog_success_resets_the_next_absence_to_thirty_seconds() {
    let cache = SynapseCatalog::new();
    let client = FakeSynapse::new([absent(), absent(), catalog(), catalog(), absent(), absent()]);
    assert!(cache.pin(client.call("models.list")).await.is_err());
    tokio::time::advance(Duration::from_secs(30)).await;
    assert!(cache.pin(client.call("models.list")).await.is_err());
    tokio::time::advance(Duration::from_secs(600)).await;
    assert!(cache.pin(client.call("models.list")).await.is_ok());
    // Each pin is reused for a minute, so the catalog is asked again only
    // once that has passed.
    tokio::time::advance(PIN_REUSE).await;
    assert!(cache.pin(client.call("models.list")).await.is_ok());
    assert_eq!(client.calls(), 4);
    tokio::time::advance(PIN_REUSE).await;
    assert!(cache.pin(client.call("models.list")).await.is_err());
    tokio::time::advance(Duration::from_secs(29)).await;
    assert!(cache.pin(client.call("models.list")).await.is_err());
    assert_eq!(client.calls(), 5);
    tokio::time::advance(Duration::from_secs(1)).await;
    assert!(cache.pin(client.call("models.list")).await.is_err());
    assert_eq!(client.calls(), 6);
}

#[tokio::test(start_paused = true)]
async fn an_absence_after_an_hour_without_searches_starts_at_thirty_seconds() {
    let cache = SynapseCatalog::new();
    let client = FakeSynapse::new([absent(), absent(), catalog()]);
    assert!(cache.pin(client.call("models.list")).await.is_err());
    tokio::time::advance(Duration::from_secs(3600)).await;
    assert!(cache.pin(client.call("models.list")).await.is_err());
    assert_eq!(client.calls(), 2);
    tokio::time::advance(Duration::from_secs(29)).await;
    assert!(cache.pin(client.call("models.list")).await.is_err());
    assert_eq!(client.calls(), 2);
    tokio::time::advance(Duration::from_secs(1)).await;
    assert!(cache.pin(client.call("models.list")).await.is_ok());
    assert_eq!(client.calls(), 3);
}

#[tokio::test(start_paused = true)]
async fn escalation_requires_a_refusal_less_than_ten_minutes_after_retry_time() {
    for seconds_after_retry in [599, 600] {
        let cache = SynapseCatalog::new();
        let client = FakeSynapse::new([absent(), absent(), catalog()]);
        assert!(cache.pin(client.call("models.list")).await.is_err());
        tokio::time::advance(Duration::from_secs(30 + seconds_after_retry)).await;
        assert!(cache.pin(client.call("models.list")).await.is_err());
        tokio::time::advance(Duration::from_secs(30)).await;
        let answer = cache.pin(client.call("models.list")).await;
        if seconds_after_retry < 600 {
            assert!(answer.is_err());
            assert_eq!(client.calls(), 2);
        } else {
            assert!(answer.is_ok());
            assert_eq!(client.calls(), 3);
        }
    }
}

#[tokio::test(start_paused = true)]
async fn concurrent_initial_refusals_do_not_escalate_before_the_first_probe() {
    let cache = SynapseCatalog::new();
    let barrier = tokio::sync::Barrier::new(2);
    let reply = || async {
        barrier.wait().await;
        absent()
    };
    let (first, second) = tokio::join!(cache.pin(reply()), cache.pin(reply()));
    assert_eq!(first, Err(Skipped("unknown_module".into())));
    assert_eq!(second, first);
    let client = FakeSynapse::new([absent()]);
    tokio::time::advance(Duration::from_secs(29)).await;
    assert!(cache.pin(client.call("models.list")).await.is_err());
    assert_eq!(client.calls(), 0);
    tokio::time::advance(Duration::from_secs(1)).await;
    assert!(cache.pin(client.call("models.list")).await.is_err());
    assert_eq!(client.calls(), 1);
}

#[tokio::test(start_paused = true)]
async fn other_catalog_failures_are_not_remembered_or_matched_by_message() {
    for failure in [
        Err("deadline_exceeded".into()),
        Err("missing_synapse".into()),
        Err("unknown_method".into()),
        Err("transport error: unknown_module".into()),
        Ok(json!({"error": {"code": "busy", "message": "unknown_module"}})),
        Ok(json!({"models": []})),
    ] {
        let cache = SynapseCatalog::new();
        let client = FakeSynapse::new([failure.clone(), failure.clone(), failure]);
        for _ in 0..3 {
            assert!(cache.pin(client.call("models.list")).await.is_err());
        }
        assert_eq!(client.calls(), 3);
    }
}

#[tokio::test(start_paused = true)]
async fn other_failures_do_not_reset_or_extend_an_expired_absence() {
    let cache = SynapseCatalog::new();
    let client = FakeSynapse::new([
        absent(),
        Err("deadline_exceeded".into()),
        Err("unknown_method".into()),
        absent(),
        catalog(),
    ]);
    assert!(cache.pin(client.call("models.list")).await.is_err());
    tokio::time::advance(Duration::from_secs(30)).await;
    for _ in 0..3 {
        assert!(cache.pin(client.call("models.list")).await.is_err());
    }
    assert_eq!(client.calls(), 4);
    tokio::time::advance(Duration::from_secs(599)).await;
    assert!(cache.pin(client.call("models.list")).await.is_err());
    assert_eq!(client.calls(), 4);
    tokio::time::advance(Duration::from_secs(1)).await;
    assert!(cache.pin(client.call("models.list")).await.is_ok());
    assert_eq!(client.calls(), 5);
}

#[tokio::test(start_paused = true)]
async fn absent_synapse_logs_its_fallback_once_even_after_reprobes() {
    let cache = SynapseCatalog::new();
    let client = FakeSynapse::new([
        Ok(json!({"error": {"code": "unknown_module", "message": "not registered"}})),
        absent(),
        absent(),
    ]);
    let output = crate::test_log::capture();
    for delay in [0, 0, 0, 30, 600] {
        tokio::time::advance(Duration::from_secs(delay)).await;
        let Skipped(reason) = cache.pin(client.call("models.list")).await.unwrap_err();
        cache.fell_back(SYNAPSE_MODULE, &reason);
    }
    assert_eq!(client.calls(), 3);
    let text = output.text();
    assert_eq!(
        text.matches(
            "ck-mc: ctx_search rerank fallback from a Synapse module; keeping the original ranking until it scores again reason=unknown_module module=synapse"
        )
        .count(),
        1,
        "{text}"
    );
}

/// A module is logged when it starts falling back and when it scores
/// again, once each, whatever its searches meet in between.
#[test]
fn a_module_is_logged_once_per_change_of_state() {
    let module = "fed:00112233445566778899aabbccddeeff:synapse";
    let cache = SynapseCatalog::new();
    let output = crate::test_log::capture();
    let fell_back = |text: &str| {
        text.lines()
            .filter(|line| {
                line.contains("ctx_search rerank fallback from a Synapse module")
                    && line.contains(&format!("module={module}"))
            })
            .count()
    };
    let scores_again = |text: &str| {
        text.matches(&format!("Synapse module scores again module={module}"))
            .count()
    };
    // Reaching the module from the start logs nothing.
    cache.scored(module);
    assert_eq!(output.text(), "");
    for reason in ["unknown_module", "deadline_exceeded", "unknown_module"] {
        cache.fell_back(module, reason);
    }
    let text = output.text();
    assert_eq!((fell_back(&text), scores_again(&text)), (1, 0), "{text}");
    assert!(text.contains("reason=unknown_module"), "{text}");
    cache.scored(module);
    cache.scored(module);
    let text = output.text();
    assert_eq!((fell_back(&text), scores_again(&text)), (1, 1), "{text}");
    cache.fell_back(module, "deadline_exceeded");
    cache.fell_back(module, "deadline_exceeded");
    let text = output.text();
    assert_eq!((fell_back(&text), scores_again(&text)), (2, 1), "{text}");
}

fn catalog_with(fingerprint: char) -> Result<Value, String> {
    Ok(json!({"result": {"table_epoch": 7, "models": [
        {"model_id": MODEL, "serving_admission": "enabled", "fingerprints": [fingerprint.to_string().repeat(64)]}
    ]}}))
}

/// A remote Synapse's pin never answers for the local one, nor the local
/// one's for it: each module keeps its own pin, its own forgetting and its
/// own absence.
#[tokio::test(start_paused = true)]
async fn each_module_keeps_its_own_pin() {
    let catalogs = SynapseCatalogs::new();
    let remote = "fed:00112233445566778899aabbccddeeff:synapse";
    let local_synapse = FakeSynapse::new([catalog_with('a'), catalog_with('a')]);
    let remote_synapse = FakeSynapse::new([catalog_with('b'), absent()]);
    let local_pin = catalogs
        .module(SYNAPSE_MODULE)
        .pin(local_synapse.call("models.list"))
        .await
        .unwrap();
    let remote_pin = catalogs
        .module(remote)
        .pin(remote_synapse.call("models.list"))
        .await
        .unwrap();
    assert_eq!(local_pin.fingerprint, "a".repeat(64));
    assert_eq!(remote_pin.fingerprint, "b".repeat(64));
    // Each pin is reused for its own module only.
    assert_eq!(
        catalogs
            .module(SYNAPSE_MODULE)
            .pin(local_synapse.call("models.list"))
            .await,
        Ok(local_pin.clone())
    );
    assert_eq!(
        catalogs
            .module(remote)
            .pin(remote_synapse.call("models.list"))
            .await,
        Ok(remote_pin)
    );
    assert_eq!((local_synapse.calls(), remote_synapse.calls()), (1, 1));
    // Forgetting the remote pin leaves the local one in use.
    catalogs.module(remote).forget();
    assert_eq!(
        catalogs
            .module(SYNAPSE_MODULE)
            .pin(local_synapse.call("models.list"))
            .await,
        Ok(local_pin.clone())
    );
    // The remote module is now absent and backed off, while the local one
    // keeps its pin.
    for _ in 0..2 {
        assert_eq!(
            catalogs
                .module(remote)
                .pin(remote_synapse.call("models.list"))
                .await,
            Err(Skipped("unknown_module".into()))
        );
    }
    assert_eq!(
        catalogs
            .module(SYNAPSE_MODULE)
            .pin(local_synapse.call("models.list"))
            .await,
        Ok(local_pin.clone())
    );
    assert_eq!((local_synapse.calls(), remote_synapse.calls()), (1, 2));
    // The local pin runs out on its own clock and is asked for again.
    tokio::time::advance(PIN_REUSE).await;
    assert_eq!(
        catalogs
            .module(SYNAPSE_MODULE)
            .pin(local_synapse.call("models.list"))
            .await,
        Ok(local_pin)
    );
    assert_eq!((local_synapse.calls(), remote_synapse.calls()), (2, 2));
}

#[tokio::test(start_paused = true)]
async fn a_pin_is_reused_for_a_minute_and_then_asked_for_again() {
    let cache = SynapseCatalog::new();
    let client = FakeSynapse::new([catalog(), catalog()]);
    let pinned = cache.pin(client.call("models.list")).await.unwrap();
    tokio::time::advance(PIN_REUSE - Duration::from_millis(1)).await;
    assert_eq!(cache.pin(client.call("models.list")).await, Ok(pinned));
    assert_eq!(client.calls(), 1);
    tokio::time::advance(Duration::from_millis(1)).await;
    assert!(cache.pin(client.call("models.list")).await.is_ok());
    assert_eq!(client.calls(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_failed_pin_is_not_reused() {
    let cache = SynapseCatalog::new();
    let client = FakeSynapse::new([catalog(), Err("deadline_exceeded".into()), catalog()]);
    assert!(cache.pin(client.call("models.list")).await.is_ok());
    tokio::time::advance(PIN_REUSE).await;
    assert!(cache.pin(client.call("models.list")).await.is_err());
    // Neither the failure nor the expired pin answers the next search.
    assert!(cache.pin(client.call("models.list")).await.is_ok());
    assert_eq!(client.calls(), 3);
}

#[tokio::test(start_paused = true)]
async fn a_forgotten_pin_is_asked_for_again_at_once() {
    let cache = SynapseCatalog::new();
    let client = FakeSynapse::new([catalog(), catalog()]);
    assert!(cache.pin(client.call("models.list")).await.is_ok());
    cache.forget();
    assert!(cache.pin(client.call("models.list")).await.is_ok());
    assert_eq!(client.calls(), 2);
}
