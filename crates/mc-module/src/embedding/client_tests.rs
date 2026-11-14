//! Requests to one endpoint share one HTTP client, so they reuse its open
//! connections.

use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// An embeddings endpoint that keeps each connection open for further
/// requests, as a hosted endpoint does, and counts the connections made.
async fn keep_alive_endpoint() -> (String, Arc<AtomicUsize>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let connections = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&connections);
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            counted.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                loop {
                    let mut chunk = [0; 8192];
                    let Ok(read) = socket.read(&mut chunk).await else {
                        return;
                    };
                    if read == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&bytes).into_owned();
                    let Some(end) = text.find("\r\n\r\n") else {
                        continue;
                    };
                    let length = text[..end]
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|length| length.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if bytes.len() < end + 4 + length {
                        continue;
                    }
                    bytes.drain(..end + 4 + length);
                    let body = json!({"data": [{"embedding": [1, 0]}]}).to_string();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                        body.len()
                    );
                    if socket.write_all(response.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    (format!("http://{address}/v1"), connections)
}

#[tokio::test]
async fn requests_to_one_endpoint_reuse_a_connection_across_providers() {
    let (endpoint, connections) = keep_alive_endpoint().await;
    // Settings build a new provider for each session and pass.
    for _ in 0..3 {
        let provider = Provider::from_tiers(
            &json!({"embedding": {
                "provider": "openai-compatible",
                "endpoint": endpoint,
                "model": "test-model"
            }}),
            &json!({}),
            Path::new("unused"),
        )
        .unwrap();
        assert_eq!(provider.embed_query("query").await, Some(vec![1.0, 0.0]));
    }
    assert_eq!(connections.load(Ordering::SeqCst), 1);
}
