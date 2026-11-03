use super::*;
use std::sync::{Arc, Mutex};

fn database() -> (tempfile::TempDir, ContextDb) {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    db.with_connection(|conn| conn.execute(
        "INSERT OR REPLACE INTO message_fts_rowid_map_backfill_state(id, watermark_rowid, completed) VALUES (1, 0, 1)", [],
    ).unwrap());
    (dir, db)
}

fn compartment(db: &ContextDb, session: &str, content: &str) -> i64 {
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO compartments(session_id, harness, sequence, start_message, end_message, title, p1, content, created_at)
             VALUES (?1, 'opencode', 1, 1, 3, 'History', ?2, ?2, 1)", params![session, content],
        ).unwrap();
        conn.last_insert_rowid()
    })
}

type DuringRequest = Box<dyn FnMut() + Send>;

async fn endpoint(action: DuringRequest) -> (Provider, Arc<Mutex<Vec<Vec<String>>>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider = Provider::for_test(
        &format!("http://{}", listener.local_addr().unwrap()),
        "mock-embed",
    );
    let inputs = Arc::new(Mutex::new(Vec::new()));
    let captured = inputs.clone();
    tokio::spawn(async move {
        let mut action = action;
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut bytes = Vec::new();
            let body = loop {
                let mut chunk = [0; 8192];
                let read = socket.read(&mut chunk).await.unwrap();
                assert_ne!(read, 0);
                bytes.extend_from_slice(&chunk[..read]);
                let text = String::from_utf8_lossy(&bytes);
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text[..end]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|s| s.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        break bytes[end + 4..end + 4 + length].to_vec();
                    }
                }
            };
            let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let texts: Vec<String> = serde_json::from_value(request["input"].clone()).unwrap();
            assert_eq!(request["model"], "mock-embed");
            let data: Vec<_> = texts
                .iter()
                .enumerate()
                .map(|(index, _)| serde_json::json!({"index": index, "embedding": [3.0, 4.0]}))
                .collect();
            captured.lock().unwrap().push(texts);
            action();
            let body = serde_json::json!({"model": "mock-embed", "data": data}).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    (provider, inputs)
}

async fn upkeep(
    db: &ContextDb,
    provider: Option<Provider>,
    owned: &(impl Fn() -> Vec<(String, String)> + Sync),
) -> Report {
    run_project_scoped(
        db,
        "project",
        Path::new("."),
        &Plan {
            memory: false,
            embedding: provider,
            git: None,
        },
        &|| 1234,
        owned,
    )
    .await
}

fn row_dump(db: &ContextDb, id: i64) -> Vec<String> {
    db.with_connection(|conn| {
        conn.prepare("SELECT json_array(id, compartment_id, session_id, project_path, harness, window_index, start_ordinal, end_ordinal, chunk_hash, model_id, dims, hex(vector), created_at) FROM compartment_chunk_embeddings WHERE compartment_id = ?1 ORDER BY id").unwrap()
            .query_map([id], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
    })
}

#[tokio::test]
async fn upkeep_chunk_rows_match_search_and_leave_standalone_sessions_untouched() {
    let (_dir, db) = database();
    let own = compartment(&db, "managed", "Fallback body.");
    let plugin = compartment(
        &db,
        "standalone",
        "Plugin summary changed after its vector.",
    );
    let other_project = compartment(&db, "other-project", "Not this project's history.");
    let (provider, inputs) = endpoint(Box::new(|| {})).await;
    let model = provider.chunk_model_id();
    db.with_connection(|conn| conn.execute(
        "INSERT INTO compartment_chunk_embeddings(compartment_id, session_id, project_path, harness, window_index, start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at)
         VALUES (?1, 'standalone', 'project', 'opencode', 0, 1, 3, 'plugin-hash', ?2, 2, ?3, 7)", params![plugin, model, encode(&[0., 1.])],
    ).unwrap());
    let before = row_dump(&db, plugin);
    let owned = || vec![("opencode".into(), "managed".into())];
    assert_eq!(upkeep(&db, None, &owned).await, Report::default());
    assert!(row_dump(&db, own).is_empty());
    assert_eq!(
        upkeep(&db, Some(provider.clone()), &owned)
            .await
            .chunks_embedded,
        1
    );
    assert_eq!(before, row_dump(&db, plugin));
    assert!(row_dump(&db, other_project).is_empty());
    assert_eq!(
        *inputs.lock().unwrap(),
        vec![vec!["History\nFallback body.".to_string()]]
    );
    db.with_connection(|conn| {
        let fields: (String, String, String, i64, i64, i64, String, i64, Vec<u8>, i64) = conn.query_row(
            "SELECT session_id, project_path, harness, window_index, start_ordinal, end_ordinal, model_id, dims, vector, created_at FROM compartment_chunk_embeddings WHERE compartment_id = ?1",
            [own], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?)),
        ).unwrap();
        assert_eq!((&fields.0, &fields.1, &fields.2), (&"managed".to_string(), &"project".to_string(), &"opencode".to_string()));
        assert_eq!((fields.3, fields.4, fields.5), (0, 1, 3));
        assert_eq!(fields.6, model);
        assert_eq!(fields.7, 2);
        assert_eq!(fields.9, 1234);
        let vector = crate::embedding::decode(&fields.8).unwrap();
        assert_eq!(vector, vec![3.0, 4.0]);
        let hits = crate::search::sources::search_chunks(conn, "managed", "project", 10, 3, None, crate::search::sources::Semantic { vector: &vector, model_id: &provider.model_id(), chunk_model_id: &model });
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].compartment_id, own);
    });
    assert_eq!(upkeep(&db, Some(provider), &owned).await.chunks_embedded, 0);
    assert_eq!(inputs.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn upkeep_changed_summary_replaces_windows_and_deletes_surplus() {
    let (_dir, db) = database();
    let own = compartment(
        &db,
        "managed",
        &"Detailed history of the SQLite store. ".repeat(2000),
    );
    let (provider, inputs) = endpoint(Box::new(|| {})).await;
    let owned = || vec![("opencode".into(), "managed".into())];
    let first = upkeep(&db, Some(provider.clone()), &owned)
        .await
        .chunks_embedded;
    assert!(first > VECTOR_BATCH);
    assert_eq!(inputs.lock().unwrap()[0].len(), VECTOR_BATCH);
    let old = row_dump(&db, own);
    db.with_connection(|conn| {
        conn.execute(
            "UPDATE compartments SET title = 'Updated', p1 = 'Replacement.' WHERE id = ?1",
            [own],
        )
        .unwrap()
    });
    assert_eq!(
        upkeep(&db, Some(provider.clone()), &owned)
            .await
            .chunks_embedded,
        1
    );
    assert_eq!(row_dump(&db, own).len(), 1);
    assert_ne!(old[0], row_dump(&db, own)[0]);
    assert_eq!(
        inputs.lock().unwrap().last().unwrap(),
        &["Updated\nReplacement.".to_string()]
    );
    assert_eq!(upkeep(&db, Some(provider), &owned).await.chunks_embedded, 0);
}

#[tokio::test]
async fn upkeep_does_not_save_a_summary_edited_during_http() {
    let (_dir, db) = database();
    let own = compartment(&db, "managed", "Original.");
    let path = db.path.clone();
    let mut requests = 0;
    let (provider, _) = endpoint(Box::new(move || {
        requests += 1;
        // A second connection can take the write lock while the request is in flight.
        let conn = Connection::open(&path).unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        if requests == 2 {
            tx.execute(
                "UPDATE compartments SET p1 = 'Edited during request.' WHERE id = ?1",
                [own],
            )
            .unwrap();
        } else {
            tx.execute(
                "UPDATE compartments SET importance = importance WHERE id = ?1",
                [own],
            )
            .unwrap();
        }
        tx.commit().unwrap();
    }))
    .await;
    let owned = || vec![("opencode".into(), "managed".into())];
    assert_eq!(
        upkeep(&db, Some(provider.clone()), &owned)
            .await
            .chunks_embedded,
        1
    );
    let original = row_dump(&db, own);
    db.with_connection(|c| {
        c.execute(
            "UPDATE compartments SET p1 = 'Before request.' WHERE id = ?1",
            [own],
        )
        .unwrap()
    });
    assert_eq!(
        upkeep(&db, Some(provider.clone()), &owned)
            .await
            .chunks_embedded,
        0
    );
    assert_eq!(row_dump(&db, own), original);
    assert_eq!(upkeep(&db, Some(provider), &owned).await.chunks_embedded, 1);
    assert_ne!(row_dump(&db, own), original);
}

#[tokio::test]
async fn upkeep_revalidates_managed_session_scope_after_http() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let (_dir, db) = database();
    let own = compartment(&db, "managed", "Original.");
    let active = Arc::new(AtomicBool::new(true));
    let live = active.clone();
    let mut requests = 0;
    let (provider, _) = endpoint(Box::new(move || {
        requests += 1;
        if requests == 2 {
            live.store(false, Ordering::SeqCst);
        }
    }))
    .await;
    let owned = || {
        if active.load(Ordering::SeqCst) {
            vec![("opencode".into(), "managed".into())]
        } else {
            Vec::new()
        }
    };
    assert_eq!(
        upkeep(&db, Some(provider.clone()), &owned)
            .await
            .chunks_embedded,
        1
    );
    let original = row_dump(&db, own);
    db.with_connection(|c| {
        c.execute(
            "UPDATE compartments SET p1 = 'Moved project.' WHERE id = ?1",
            [own],
        )
        .unwrap()
    });
    assert_eq!(upkeep(&db, Some(provider), &owned).await.chunks_embedded, 0);
    assert_eq!(row_dump(&db, own), original);
}

#[tokio::test]
async fn upkeep_uses_mapped_raw_conversation_before_summary_fallback() {
    let (_dir, db) = database();
    let own = compartment(&db, "managed", "Do not embed this paraphrase.");
    db.with_connection(|conn| {
        conn.execute("UPDATE message_fts_rowid_map_backfill_state SET completed = 0", []).unwrap();
        for (ordinal, role, text) in [(1, "user", "  Find\n the history. "), (2, "user", "Group adjacent roles."), (3, "assistant", "Read the raw chunks.")] {
            conn.execute("INSERT INTO message_history_fts(session_id, message_ordinal, message_id, role, content) VALUES ('managed', ?1, ?2, ?3, ?4)", params![ordinal, ordinal.to_string(), role, text]).unwrap();
            let rowid = conn.last_insert_rowid();
            conn.execute("INSERT INTO message_fts_rowid_map(session_id, message_ordinal, fts_rowid) VALUES ('managed', ?1, ?2)", params![ordinal, rowid]).unwrap();
            conn.execute("INSERT INTO message_history_source(session_id, message_id, message_ordinal, source_version, normalized_content_hash, role, harness, updated_at) VALUES ('managed', ?1, ?2, 'v1', 'not-empty', ?3, 'opencode', 1)", params![ordinal.to_string(), ordinal, role]).unwrap();
        }
    });
    let (provider, inputs) = endpoint(Box::new(|| {})).await;
    let owned = || vec![("opencode".into(), "managed".into())];
    assert_eq!(
        upkeep(&db, Some(provider.clone()), &owned)
            .await
            .chunks_embedded,
        1
    );
    assert_eq!(
        inputs.lock().unwrap()[0],
        vec!["[1-2] U: Find the history. / Group adjacent roles.\n[3] A: Read the raw chunks."]
    );
    let first = row_dump(&db, own);
    db.with_connection(|conn| {
        conn.execute("UPDATE message_history_fts SET content = 'Changed raw text.' WHERE session_id = 'managed' AND message_ordinal = 3", []).unwrap();
        conn.execute("DELETE FROM message_fts_rowid_map WHERE session_id = 'managed' AND message_ordinal = 3", []).unwrap();
    });
    assert_eq!(
        upkeep(&db, Some(provider.clone()), &owned)
            .await
            .chunks_embedded,
        0
    );
    assert_eq!(row_dump(&db, own), first);
    db.with_connection(|conn| conn.execute("INSERT INTO message_fts_rowid_map(session_id, message_ordinal, fts_rowid) SELECT 'managed', 3, rowid FROM message_history_fts WHERE session_id = 'managed' AND message_ordinal = 3", []).unwrap());
    assert_eq!(upkeep(&db, Some(provider), &owned).await.chunks_embedded, 1);
    assert_ne!(row_dump(&db, own), first);
    assert!(inputs.lock().unwrap()[1][0].ends_with("[3] A: Changed raw text."));
}
