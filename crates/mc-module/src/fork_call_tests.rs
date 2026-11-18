//! A tool call carrying the tool-provider role's `fork_id` is a quick
//! question a runner forked off the session. It answers as the session's own
//! call would, and changes nothing the person, the session or another
//! session can observe.

use super::*;
use serde_json::json;
use std::collections::BTreeSet;

/// One memory row as the store holds it, every column.
fn memory_row(db: &ContextDb, id: i64) -> Vec<String> {
    db.with_connection(|conn| {
        let mut statement = conn
            .prepare("SELECT * FROM memories WHERE id = ?1")
            .unwrap();
        let columns = statement.column_count();
        statement
            .query_row([id], |row| {
                (0..columns)
                    .map(|at| {
                        row.get::<_, rusqlite::types::Value>(at)
                            .map(|value| format!("{value:?}"))
                    })
                    .collect()
            })
            .unwrap()
    })
}

fn retrieval_count(db: &ContextDb, id: i64) -> i64 {
    db.with_connection(|conn| {
        conn.query_row(
            "SELECT retrieval_count FROM memories WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .unwrap()
    })
}

/// Retrieval counts feed memory ranking and the dreamer's memory curation, so a
/// fork's search answers the same as the session's own and counts nothing;
/// the session's own search still counts.
#[tokio::test]
async fn a_fork_search_answers_the_same_and_counts_no_retrieval() {
    let (mut session, client, _, _, mut settings) = fixture();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("context.db");
    ContextDb::create_for_tests(&path).unwrap();
    let db = Arc::new(ContextDb::open(&path).unwrap());
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO memories(id, level, owner_id, category, origin_category, content,
                                  normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES(1, 'project', 'test-project', 'swe:architecture', 'ARCHITECTURE',
                    'zebra parser keeps its fork quiet', 'h', 1, 1, 1, 1)",
            [],
        )
        .unwrap();
    });
    session.db = Some(Arc::clone(&db));
    session.project = Some(Project {
        id: "test-project".into(),
        root: dir.path().to_string_lossy().into_owned(),
    });
    settings.embedding = None;
    settings.rerank = crate::search::rerank::Reranker::Off;
    let input = json!({"query": "zebra parser", "sources": ["memory"]});
    let row = memory_row(&db, 1);
    let durable = session.durable();

    let forked = session
        .tool_on_fork(&client, &settings, "ctx_search", &input)
        .await
        .unwrap();
    assert!(
        forked.contains("zebra parser keeps its fork quiet"),
        "{forked}"
    );
    assert_eq!(
        memory_row(&db, 1),
        row,
        "the fork's search wrote the memory"
    );
    assert_eq!(retrieval_count(&db, 1), 0);
    assert!(session.durable() == durable, "the fork changed saved state");

    let own = session
        .tool(&client, &settings, "ctx_search", &input)
        .await
        .unwrap();
    assert_eq!(own, forked, "a fork answers as the session's own call");
    assert_eq!(
        retrieval_count(&db, 1),
        1,
        "the session's own search counts"
    );
}

/// A fork's `ctx_expand` answers as the session's own call and leaves the
/// session's saved state as it was.
#[tokio::test]
async fn a_fork_expand_answers_the_same_and_changes_no_saved_state() {
    let (mut session, client, _, _, settings) = fixture();
    let entries = vec![text(1, "alpha"), text(2, "beta")];
    session.index.extend(entries.clone());
    session.index_ready = true;
    *client.entries.lock().unwrap() = entries;
    let page = || Ok(ReadPage::new(vec![text(1, "alpha")], Head::new()));
    let durable = session.durable();
    let queued = session.queued.clone();

    client.pages.lock().unwrap().push_back(page());
    let forked = session
        .tool_on_fork(&client, &settings, "ctx_expand", &json!({"tag": 1}))
        .await;
    assert!(
        forked.as_ref().is_ok_and(|text| text.contains("alpha")),
        "{forked:?}"
    );
    assert!(session.durable() == durable, "the fork changed saved state");
    assert_eq!(session.queued, queued);

    client.pages.lock().unwrap().push_back(page());
    let own = session
        .tool(&client, &settings, "ctx_expand", &json!({"tag": 1}))
        .await;
    assert_eq!(own, forked, "a fork answers as the session's own call");
}

/// The runner's refusal for the session.
fn refused(tags: &[u64]) -> Result<ReadPage, crate::client::ClientError> {
    let mut error = crate::client::ClientError::refused("numbers_unknown", "unknown");
    error.detail = Some(json!({"tags": tags}));
    Err(error)
}

/// A fork that meets a tag number the runner can't place records it like
/// the session's own call: the runner's refusal is permanent for the
/// session, so ck-mc never asks again. The record only caches the runner's
/// answer: the session's `ctx_expand` and `ctx_reduce` answer that tag the
/// same as a session that never saw the refusal, without a second read.
#[tokio::test]
async fn a_fork_records_a_refused_number_without_changing_any_answer_for_it() {
    let fresh = || {
        let (mut session, client, _, _, settings) = fixture();
        session.index.extend([text(1, "a"), text(2, "b")]);
        session.index_ready = true;
        (session, client, settings)
    };
    // What the session answers when it asks the runner itself.
    let (mut session, client, settings) = fresh();
    client.pages.lock().unwrap().push_back(refused(&[7]));
    let expand = session
        .tool(&client, &settings, "ctx_expand", &json!({"tag": 7}))
        .await;
    let (mut session, client, settings) = fresh();
    client.pages.lock().unwrap().push_back(refused(&[7]));
    let reduce = session
        .tool(&client, &settings, "ctx_reduce", &json!({"drop": "7"}))
        .await;
    assert!(expand.is_err() && reduce.is_ok(), "{expand:?} {reduce:?}");

    let (mut session, client, settings) = fresh();
    client.pages.lock().unwrap().push_back(refused(&[7]));
    let forked = session
        .tool_on_fork(&client, &settings, "ctx_expand", &json!({"tag": 7}))
        .await;
    assert_eq!(forked, expand);
    assert_eq!(session.durable().numbers_unknown_tags, BTreeSet::from([7]));
    let reads = client.reads.lock().unwrap().len();
    assert_eq!(
        session
            .tool(&client, &settings, "ctx_expand", &json!({"tag": 7}))
            .await,
        expand
    );
    assert_eq!(
        session
            .tool(&client, &settings, "ctx_reduce", &json!({"drop": "7"}))
            .await,
        reduce
    );
    assert_eq!(
        client.reads.lock().unwrap().len(),
        reads,
        "a refused number was asked for again"
    );
}
