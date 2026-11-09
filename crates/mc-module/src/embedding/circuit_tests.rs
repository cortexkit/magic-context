use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

type Reply = Option<(u16, &'static str, bool)>;

/// A real endpoint that can stall before headers or after sending headers.
pub(crate) struct Endpoint {
    pub(crate) url: String,
    pub(crate) connections: Arc<AtomicUsize>,
    reply: Arc<Mutex<Reply>>,
    accepted: tokio::sync::mpsc::UnboundedReceiver<()>,
    task: tokio::task::JoinHandle<()>,
}

impl Endpoint {
    pub(crate) async fn hanging() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let connections = Arc::new(AtomicUsize::new(0));
        let reply: Arc<Mutex<Reply>> = Arc::default();
        let responses = reply.clone();
        let counter = connections.clone();
        let (tx, accepted) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let mut sockets = tokio::task::JoinSet::new();
            while let Ok((mut socket, _)) = listener.accept().await {
                counter.fetch_add(1, Ordering::SeqCst);
                let reply = *responses.lock().unwrap();
                let tx = tx.clone();
                sockets.spawn(async move {
                    let mut buffer = [0; 8192];
                    let _ = socket.read(&mut buffer).await;
                    let _ = tx.send(());
                    if let Some((status, body, stalled)) = reply {
                        let response = format!(
                            "HTTP/1.1 {status} Reply\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(), if stalled { "" } else { body }
                        );
                        let _ = socket.write_all(response.as_bytes()).await;
                        if !stalled {
                            return;
                        }
                    }
                    std::future::pending::<()>().await;
                    drop(socket);
                });
            }
        });
        Self {
            url,
            connections,
            reply,
            accepted,
            task,
        }
    }

    pub(crate) fn provider(&self) -> Provider {
        Provider::for_test(&self.url, "test-model")
            .with_timeouts_for_test(Duration::from_millis(100), Duration::from_millis(100))
    }

    pub(crate) async fn request_seen(&mut self) {
        tokio::time::timeout(Duration::from_secs(2), self.accepted.recv())
            .await
            .unwrap()
            .unwrap();
    }

    fn respond(&self, status: u16, body: &'static str, stalled: bool) {
        *self.reply.lock().unwrap() = Some((status, body, stalled));
    }
}

impl Drop for Endpoint {
    fn drop(&mut self) {
        self.task.abort();
    }
}

const VALID: &str = r#"{"model":"test-model","data":[{"embedding":[1,0]}]}"#;

#[tokio::test]
async fn three_serial_hangs_open_the_circuit_across_provider_reconstruction() {
    let server = Endpoint::hanging().await;
    let provider = server.provider();
    for _ in 0..3 {
        assert!(provider
            .embed_documents(&["document".into()])
            .await
            .is_none());
    }
    assert_eq!(server.connections.load(Ordering::SeqCst), 3);
    drop(provider);
    let rebuilt = Provider::from_tiers(
        &json!({"embedding": {"provider": "openai-compatible", "endpoint": format!("{}/", server.url), "model": "other-model"}}),
        &json!({}), Path::new("unused")
    ).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), rebuilt.embed_query("fourth"))
            .await
            .expect("an open circuit must return without an HTTP request")
            .is_none()
    );
    assert_eq!(server.connections.load(Ordering::SeqCst), 3);
    let other = Endpoint::hanging().await;
    other.respond(200, VALID, false);
    assert!(other
        .provider()
        .embed_query("another endpoint")
        .await
        .is_some());
}

#[tokio::test]
async fn caller_cancellation_is_not_an_endpoint_failure() {
    let mut server = Endpoint::hanging().await;
    let provider = server
        .provider()
        .with_timeouts_for_test(Duration::from_secs(2), Duration::from_secs(2));
    for _ in 0..3 {
        let pending = provider.embed_search_query("cancelled");
        tokio::pin!(pending);
        tokio::select! {
            _ = server.request_seen() => {},
            _ = &mut pending => panic!("hanging endpoint returned before caller cancellation"),
        }
        // The caller drops its future here, after the endpoint saw the request.
    }
    server.respond(200, VALID, false);
    assert_eq!(
        provider.embed_query("still admitted").await,
        Some(vec![1.0, 0.0])
    );
    assert_eq!(server.connections.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn rate_limits_including_stalled_bodies_are_not_endpoint_failures() {
    let server = Endpoint::hanging().await;
    let provider = server.provider();
    for stalled in [false, true] {
        server.respond(429, "rate limited", stalled);
        for _ in 0..3 {
            assert!(provider.embed_query("rate limited").await.is_none());
        }
    }
    server.respond(200, VALID, false);
    assert!(provider.embed_query("still admitted").await.is_some());
    assert_eq!(server.connections.load(Ordering::SeqCst), 7);
}

#[tokio::test]
async fn http_body_and_data_failures_all_trip_the_breaker() {
    for (status, body, stalled) in [
        // An invalid HTTP status makes reqwest report a transport error.
        (0, "", false),
        (500, "server error", false),
        (200, "", false),
        (200, "not json", false),
        (
            200,
            r#"{"model":"substituted","data":[{"embedding":[1]}]}"#,
            false,
        ),
        (200, "{}", false),
        (200, r#"{"data":[]}"#, false),
        (200, r#"{"data":[{"embedding":[]}]}"#, false),
        (200, r#"{"data":[{"embedding":["invalid"]}]}"#, false),
        (200, r#"{"data":[{"embedding":[1e99]}]}"#, false),
        (
            200,
            r#"{"data":[{"index":0,"embedding":[1]},{"index":0,"embedding":[1]}]}"#,
            false,
        ),
        (
            200,
            r#"{"data":[{"index":0,"embedding":[1]},{"embedding":[1]}]}"#,
            false,
        ),
        (200, r#"{"data":[{"index":2,"embedding":[1]}]}"#, false),
        (200, VALID, true),
    ] {
        let server = Endpoint::hanging().await;
        server.respond(status, body, stalled);
        let provider = server.provider();
        for _ in 0..4 {
            assert!(provider.embed_query("failure").await.is_none());
        }
        assert_eq!(
            server.connections.load(Ordering::SeqCst),
            3,
            "{status}: {body}"
        );
    }
}
