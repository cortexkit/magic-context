use super::*;
use crate::embedding::circuit_tests::Endpoint;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

#[tokio::test]
async fn ctx_search_returns_keyword_results_within_the_query_embedding_budget() {
    let server = Endpoint::hanging().await;
    let provider = crate::embedding::Provider::for_test(&server.url, "test-model");
    let (mut session, client, _, _, mut settings) = fixture();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("context.db");
    ContextDb::create_for_tests(&path).unwrap();
    let db = ContextDb::open(&path).unwrap();
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO memories(id,level, owner_id,category, origin_category,content,normalized_hash,first_seen_at,created_at,updated_at,last_seen_at)
             VALUES(1,'project', 'test-project','swe:architecture', 'ARCHITECTURE','zebra parser survives keyword fallback','h',1,1,1,1)",
            [],
        ).unwrap();
    });
    session.db = Some(Arc::new(db));
    session.project = Some(Project {
        id: "test-project".into(),
        root: dir.path().to_string_lossy().into_owned(),
    });
    settings.embedding = Some(provider.clone());
    settings.rerank = crate::search::rerank::Reranker::Off;
    let input = serde_json::json!({"query": "zebra parser", "sources": ["memory"]});
    let started = Instant::now();
    let output = tokio::time::timeout(
        Duration::from_secs(6),
        session.tool(&client, &settings, "ctx_search", &input),
    )
    .await
    .expect("search must not wait for the 30-second background timeout")
    .unwrap();
    assert!(started.elapsed() < Duration::from_secs(6));
    assert!(
        output.contains("zebra parser survives keyword fallback"),
        "{output}"
    );
    assert!(!output.contains("match=semantic"), "{output}");
    assert_eq!(server.connections.load(Ordering::SeqCst), 1);

    // The search budget expiry is one endpoint failure, shared with upkeep.
    let short =
        provider.with_timeouts_for_test(Duration::from_millis(100), Duration::from_millis(100));
    for _ in 0..2 {
        assert!(short.embed_documents(&["upkeep".into()]).await.is_none());
    }
    let output = tokio::time::timeout(
        Duration::from_millis(50),
        session.tool(&client, &settings, "ctx_search", &input),
    )
    .await
    .expect("three failures must open the shared endpoint circuit")
    .unwrap();
    assert!(
        output.contains("zebra parser survives keyword fallback"),
        "{output}"
    );
    assert_eq!(server.connections.load(Ordering::SeqCst), 3);
}
