use super::{drain, queue, store};
use drain::{EmbeddingProvider, FinishOutcome, Registration};
use queue::{EmbeddingEffect, EmbeddingEffectKind};
use rusqlite::{params, Connection};
use store::{ChunkCatalog, Kind, Passage, Source};

struct NoChunks;
impl ChunkCatalog for NoChunks {
    fn pending(
        &self,
        _: &Connection,
        _: &str,
        _: &str,
        _: usize,
    ) -> rusqlite::Result<Vec<Passage>> {
        Ok(Vec::new())
    }

    fn current(&self, _: &Connection, _: &Passage) -> rusqlite::Result<bool> {
        panic!("memory-only fixture must not validate chunks")
    }
}

struct Provider {
    seen: Vec<Passage>,
    fail: bool,
}
impl EmbeddingProvider for Provider {
    fn embed(&mut self, _: &Registration, passages: &[Passage]) -> Result<Vec<Vec<f32>>, String> {
        self.seen.extend_from_slice(passages);
        if self.fail {
            Err("offline".into())
        } else {
            Ok(vec![vec![0.25, 0.75]; passages.len()])
        }
    }
}

fn database() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        &include_str!("../../testdata/context_schema/schema.sql").replace(":applied_at", "1"),
    )
    .unwrap();
    let r = registration();
    db.execute(
        "INSERT INTO embedding_registrations(project_path,model_id,chunk_model_id,fingerprint,
         table_epoch,dims,generation) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![
            r.project,
            r.model_id,
            r.chunk_model_id,
            r.fingerprint,
            r.table_epoch,
            r.dimensions as i64,
            r.generation
        ],
    )
    .unwrap();
    db.execute(
        "INSERT INTO project_state(project_path,project_memory_epoch) VALUES('project-a',17)",
        [],
    )
    .unwrap();
    db
}

fn registration() -> Registration {
    Registration {
        project: "project-a".into(),
        model_id: "provider:fixture".into(),
        chunk_model_id: "provider:fixture:raw".into(),
        fingerprint: "fingerprint".into(),
        table_epoch: 1,
        dimensions: 2,
        generation: 1,
    }
}

fn insert(db: &Connection, id: i64, project: &str, content: &str, status: &str) {
    db.execute(
        "INSERT INTO memories(id,project_path,category,content,normalized_hash,status,
         first_seen_at,created_at,updated_at,last_seen_at) VALUES(?1,?2,'fact',?3,?4,?5,1,1,1,1)",
        params![
            id,
            project,
            content,
            crate::compute_normalized_memory_hash(content),
            status
        ],
    )
    .unwrap();
}

fn effect(id: i64, text: &str, kind: EmbeddingEffectKind) -> EmbeddingEffect {
    EmbeddingEffect {
        project_path: "project-a".into(),
        session_id: "session-a".into(),
        memory_id: id,
        kind,
        content: (kind == EmbeddingEffectKind::Embed).then(|| text.into()),
        content_hash: crate::compute_normalized_memory_hash(text),
        queued_at: 100,
    }
}

fn pending(db: &Connection) -> Vec<Passage> {
    store::pending(
        db,
        &NoChunks,
        "project-a",
        Kind::Memory,
        "provider:fixture",
        64,
    )
    .unwrap()
}

fn scalar(db: &Connection, sql: &str) -> i64 {
    db.query_row(sql, [], |row| row.get(0)).unwrap()
}

fn old_vectors(db: &Connection, id: i64) {
    for model in ["provider:fixture", "another-model"] {
        db.execute(
            "INSERT INTO memory_embeddings(memory_id,embedding,model_id) VALUES(?1,?2,?3)",
            params![id, store::encode(&[1.0, 0.0]), model],
        )
        .unwrap();
    }
}

#[test]
fn memory_effect_row_drains_only_when_activated() {
    let mut db = database();
    insert(&db, 1, "project-a", "old content", "active");
    old_vectors(&db, 1);
    // Recorded JSON shape of mc_module::memory_actions::EmbeddingEffect; the
    // production module adapter is separate from this store-level fixture.
    let row: EmbeddingEffect = serde_json::from_value(serde_json::json!({
        "project_path":"project-a", "session_id":"session-a", "memory_id":1,
        "kind":"embed", "content":"updated content",
        "content_hash":crate::compute_normalized_memory_hash("updated content"), "queued_at":100
    }))
    .unwrap();
    let tx = db.transaction().unwrap();
    tx.execute(
        "UPDATE memories SET content=?1,normalized_hash=?2 WHERE id=1",
        params![row.content, row.content_hash],
    )
    .unwrap();
    queue::enqueue_tx(&tx, &row).unwrap();
    tx.commit().unwrap();
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM memory_embeddings"), 0);
    let before = drain::progress(&db, &registration()).unwrap();
    let mut provider = Provider {
        seen: vec![],
        fail: false,
    };
    assert_eq!(
        queue::drain_once(
            false,
            &mut db,
            &NoChunks,
            &mut provider,
            &registration(),
            1,
            100,
            || panic!("disabled drain called completion clock")
        )
        .unwrap(),
        None
    );
    assert!(provider.seen.is_empty());
    assert_eq!(drain::progress(&db, &registration()).unwrap(), before);
    assert_eq!(pending(&db).len(), 1);
    assert_eq!(
        queue::drain_once(
            true,
            &mut db,
            &NoChunks,
            &mut provider,
            &registration(),
            1,
            100,
            || 101
        )
        .unwrap(),
        Some(FinishOutcome::Published {
            accepted: 1,
            discarded: 0
        })
    );
    assert_eq!(provider.seen.len(), 1);
    assert_eq!(
        provider.seen[0].source,
        Source::Memory { id: row.memory_id }
    );
    assert_eq!(provider.seen[0].text, row.content.unwrap());
    assert_eq!(provider.seen[0].content_hash, row.content_hash);
    let (model, blob): (String, Vec<u8>) = db
        .query_row(
            "SELECT model_id,embedding FROM memory_embeddings WHERE memory_id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(model, registration().model_id);
    assert_eq!(store::decode(&blob, 2).unwrap(), vec![0.25, 0.75]);
    assert!(pending(&db).is_empty());
    assert_eq!(
        scalar(&db, "SELECT project_memory_epoch FROM project_state"),
        17
    );
}

#[test]
fn disabled_drain_does_not_even_require_a_schema_or_valid_batch() {
    let mut db = Connection::open_in_memory().unwrap();
    let mut provider = Provider {
        seen: vec![],
        fail: false,
    };
    assert_eq!(
        queue::drain_once(
            false,
            &mut db,
            &NoChunks,
            &mut provider,
            &registration(),
            0,
            100,
            || panic!("disabled drain called completion clock")
        )
        .unwrap(),
        None
    );
    assert!(provider.seen.is_empty());
}

#[test]
fn enqueue_invalidation_and_source_change_rollback_together() {
    let mut db = database();
    insert(&db, 1, "project-a", "old content", "active");
    old_vectors(&db, 1);
    let row = effect(1, "replacement", EmbeddingEffectKind::Embed);
    let tx = db.transaction().unwrap();
    tx.execute(
        "UPDATE memories SET content=?1,normalized_hash=?2 WHERE id=1",
        params![row.content, row.content_hash],
    )
    .unwrap();
    queue::enqueue_tx(&tx, &row).unwrap();
    assert_eq!(scalar(&tx, "SELECT COUNT(*) FROM memory_embeddings"), 0);
    tx.rollback().unwrap();
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM memory_embeddings"), 2);
    assert!(pending(&db).is_empty());
    assert_eq!(
        db.query_row("SELECT content FROM memories WHERE id=1", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "old content"
    );
}

#[test]
fn enqueue_rejects_foreign_or_stale_effect_without_invalidating() {
    let mut db = database();
    insert(&db, 1, "project-a", "current", "active");
    old_vectors(&db, 1);
    let mut foreign = effect(1, "current", EmbeddingEffectKind::Embed);
    foreign.project_path = "project-b".into();
    let mut wrong_content = effect(1, "current", EmbeddingEffectKind::Embed);
    wrong_content.content = Some("different".into());
    for row in [
        foreign,
        wrong_content,
        effect(1, "stale", EmbeddingEffectKind::Embed),
    ] {
        let tx = db.transaction().unwrap();
        assert!(queue::enqueue_tx(&tx, &row).is_err());
        tx.commit().unwrap();
        assert_eq!(scalar(&db, "SELECT COUNT(*) FROM memory_embeddings"), 2);
    }
}

#[test]
fn archive_rejects_inflight_vector_even_when_content_hash_is_unchanged() {
    let mut db = database();
    insert(&db, 1, "project-a", "unchanged text", "active");
    let drain::ClaimOutcome::Claimed(claim) =
        drain::claim(&mut db, &NoChunks, &registration(), 1, 100, 1_000).unwrap()
    else {
        panic!("expected active memory claim");
    };
    let tx = db.transaction().unwrap();
    tx.execute("UPDATE memories SET status='archived' WHERE id=1", [])
        .unwrap();
    queue::enqueue_tx(
        &tx,
        &effect(1, "unchanged text", EmbeddingEffectKind::Invalidate),
    )
    .unwrap();
    tx.commit().unwrap();
    assert_eq!(
        claim.passages()[0].content_hash,
        crate::compute_normalized_memory_hash("unchanged text")
    );
    assert_eq!(
        drain::finish(&mut db, &NoChunks, &claim, &[vec![0.25, 0.75]], 101).unwrap(),
        FinishOutcome::Published {
            accepted: 0,
            discarded: 1
        }
    );
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM memory_embeddings"), 0);
    assert!(pending(&db).is_empty());
}

#[test]
fn changed_content_discards_old_reply_and_keeps_new_content_pending() {
    let mut db = database();
    insert(&db, 1, "project-a", "old content", "active");
    let drain::ClaimOutcome::Claimed(claim) =
        drain::claim(&mut db, &NoChunks, &registration(), 1, 100, 1_000).unwrap()
    else {
        panic!("expected active memory claim");
    };
    let row = effect(1, "replacement", EmbeddingEffectKind::Embed);
    let tx = db.transaction().unwrap();
    tx.execute(
        "UPDATE memories SET content=?1,normalized_hash=?2 WHERE id=1",
        params![row.content, row.content_hash],
    )
    .unwrap();
    queue::enqueue_tx(&tx, &row).unwrap();
    tx.commit().unwrap();
    assert_eq!(
        drain::finish(&mut db, &NoChunks, &claim, &[vec![0.25, 0.75]], 101).unwrap(),
        FinishOutcome::Published {
            accepted: 0,
            discarded: 1
        }
    );
    assert_eq!(pending(&db)[0].text, "replacement");
}

#[test]
fn bounded_retry_preserves_stable_order_permanent_rows_and_project_isolation() {
    let mut db = database();
    insert(&db, 3, "project-a", "later", "active");
    insert(&db, 1, "project-a", "permanent", "permanent");
    insert(&db, 2, "project-b", "foreign", "active");
    insert(&db, 4, "project-a", "archived", "archived");
    let mut provider = Provider {
        seen: vec![],
        fail: true,
    };
    assert!(matches!(
        queue::drain_once(
            true,
            &mut db,
            &NoChunks,
            &mut provider,
            &registration(),
            1,
            100,
            || 101
        ),
        Err(drain::DrainError::Provider(_))
    ));
    assert_eq!(
        pending(&db)
            .iter()
            .map(|p| p.source.clone())
            .collect::<Vec<_>>(),
        vec![Source::Memory { id: 1 }, Source::Memory { id: 3 }]
    );
    provider.fail = false;
    for (now, expected_id) in [(102, 1), (104, 3)] {
        assert_eq!(
            queue::drain_once(
                true,
                &mut db,
                &NoChunks,
                &mut provider,
                &registration(),
                1,
                now,
                || now + 1
            )
            .unwrap(),
            Some(FinishOutcome::Published {
                accepted: 1,
                discarded: 0
            })
        );
        assert_eq!(
            provider.seen.last().unwrap().source,
            Source::Memory { id: expected_id }
        );
    }
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM memory_embeddings"), 2);
    assert!(pending(&db).is_empty());
    assert_eq!(
        drain::progress(&db, &registration())
            .unwrap()
            .unwrap()
            .failures,
        1
    );
    assert_eq!(
        scalar(&db, "SELECT project_memory_epoch FROM project_state"),
        17
    );
}
