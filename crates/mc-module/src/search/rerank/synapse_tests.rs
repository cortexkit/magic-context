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
        {"model_id": MODEL, "certified": true, "fingerprints": ["a".repeat(64)]}
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
    assert!(cache.pin(client.call("models.list")).await.is_ok());
    assert_eq!(client.calls(), 4);
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

#[derive(Clone, Default)]
struct Captured(std::sync::Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test(start_paused = true)]
async fn absent_synapse_logs_the_existing_fallback_once_even_after_reprobes() {
    let cache = SynapseCatalog::new();
    let client = FakeSynapse::new([
        Ok(json!({"error": {"code": "unknown_module", "message": "not registered"}})),
        absent(),
        absent(),
    ]);
    let output = Captured::default();
    let writer = output.clone();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    for delay in [0, 0, 0, 30, 600] {
        tokio::time::advance(Duration::from_secs(delay)).await;
        let Skipped(reason) = cache.pin(client.call("models.list")).await.unwrap_err();
        log_fallback(&reason);
    }
    assert_eq!(client.calls(), 3);
    let text = String::from_utf8(output.0.lock().unwrap().clone()).unwrap();
    assert_eq!(
        text.matches(
            "ck-mc: ctx_search rerank fallback (unknown_module); keeping the original ranking"
        )
        .count(),
        1,
        "{text}"
    );
}
