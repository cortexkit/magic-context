//! A session `ck-mc move-in --copy` started from another session's history
//! reads memories but never writes them: no memory tool writes, no facts
//! kept for a second summary turn, no second turn, and no retrieval counts.
//! With an injection project, its memory reads go to that project.

use super::*;
use crate::move_in::CopyOrigin;

/// A store with one memory in the injection project and one in the project
/// the runner stamps; both match the query `zebra parser`.
fn store(dir: &std::path::Path) -> Arc<ContextDb> {
    let path = dir.join("context.db");
    ContextDb::create_for_tests(&path).unwrap();
    let db = ContextDb::open(&path).unwrap();
    db.with_connection(|conn| {
        conn.execute_batch(
            "INSERT INTO memories(id,project_path,category,content,normalized_hash,first_seen_at,created_at,updated_at,last_seen_at)
             VALUES (1,'alf-project','ARCHITECTURE','zebra parser lives in the alf project','h1',1,1,1,1),
                    (2,'scratch-project','ARCHITECTURE','zebra parser lives in the scratch project','h2',1,1,1,1);",
        )
        .unwrap();
    });
    Arc::new(db)
}

fn project(dir: &std::path::Path, id: &str) -> Project {
    Project {
        id: id.into(),
        root: dir.join(id).to_string_lossy().into_owned(),
    }
}

/// A session in the scratch project, copied from `alf` with the alf
/// project as its injection project.
fn copied(dir: &std::path::Path) -> (Session, Client, Settings) {
    let (mut session, client, _, _, mut settings) = fixture();
    session.db = Some(store(dir));
    session.project = Some(project(dir, "scratch-project"));
    session.workdir = session.project.as_ref().map(|project| project.root.clone());
    session.copied_from(CopyOrigin {
        harness: "opencode".into(),
        session: "alf".into(),
        injection_project: Some(project(dir, "alf-project")),
    });
    settings.rerank = crate::search::rerank::Reranker::Off;
    (session, client, settings)
}

/// Every column of every memory row.
fn memory_rows(session: &Session) -> Vec<String> {
    session.db.as_ref().unwrap().with_connection(|conn| {
        let mut statement = conn.prepare("SELECT * FROM memories ORDER BY id").unwrap();
        let columns = statement.column_count();
        statement
            .query_map([], |row| {
                Ok(format!(
                    "{:?}",
                    (0..columns)
                        .map(|i| row.get::<_, rusqlite::types::Value>(i))
                        .collect::<Result<Vec<_>, _>>()?
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    })
}

#[tokio::test]
async fn a_copy_refuses_memory_writes_and_reads_the_injection_projects_memories() {
    let dir = tempfile::tempdir().unwrap();
    let (mut session, client, settings) = copied(dir.path());
    let before = memory_rows(&session);
    for input in [
        serde_json::json!({"action": "write", "category": "NAMING", "content": "Call it the probe."}),
        serde_json::json!({"action": "update", "ids": [1], "content": "changed"}),
        serde_json::json!({"action": "archive", "ids": [1]}),
        serde_json::json!({"action": "merge", "ids": [1, 2], "content": "merged"}),
    ] {
        let refused = session
            .tool(&client, &settings, "ctx_memory", &input)
            .await
            .unwrap_err();
        assert!(refused.contains("read-only copy"), "{input}: {refused}");
    }
    assert_eq!(memory_rows(&session), before);
    // The ids the copy's head shows are the injection project's, and they
    // resolve; the stamped project's don't.
    let shown = session
        .tool(
            &client,
            &settings,
            "ctx_memory",
            &serde_json::json!({"action": "get", "ids": [1, 2]}),
        )
        .await
        .unwrap();
    assert!(shown.contains("lives in the alf project"), "{shown}");
    assert!(shown.contains("id 2: not found"), "{shown}");
}

#[test]
fn a_copy_keeps_no_facts_for_a_second_turn_and_runs_none() {
    let dir = tempfile::tempdir().unwrap();
    let (mut copy, _, settings) = copied(dir.path());
    let mut own = copy.clone();
    own.copy = None;
    let continuation = || crate::summary::run::Continuation {
        child: crate::client::Child {
            session: SessionRef::new("test", "mock", "s1:summary"),
            project_root: None,
        },
        model: ModelRef::new("test", "model"),
        decision_id: "decision".into(),
        output_tokens: 1000,
        language: None,
        publication_id: "publication".into(),
    };
    // The same session, not a copy, asks for facts, keeps the records a
    // second turn reads, and runs that turn.
    let request = own.begin_summary(&settings, 1, 2, false, false);
    assert!(request.memory_enabled);
    assert_eq!(request.project.as_deref(), Some("scratch-project"));
    assert!(own.turn_two_job(&settings, continuation()).is_some());
    // The copy still summarizes its own messages, under its own id, but with
    // no memory level: no facts, no records, no second turn.
    let request = copy.begin_summary(&settings, 1, 2, false, false);
    assert_eq!(request.session, copy.key);
    assert!(!request.memory_enabled);
    assert_eq!(request.project, None);
    assert!(copy.turn_two_job(&settings, continuation()).is_none());
}

#[tokio::test]
async fn a_copy_searches_the_injection_project_and_leaves_its_memory_rows_as_they_were() {
    let dir = tempfile::tempdir().unwrap();
    let (mut session, client, settings) = copied(dir.path());
    let input = serde_json::json!({"query": "zebra parser", "sources": ["memory"]});
    let before = memory_rows(&session);
    let found = session
        .tool(&client, &settings, "ctx_search", &input)
        .await
        .unwrap();
    assert!(found.contains("lives in the alf project"), "{found}");
    assert!(!found.contains("lives in the scratch project"), "{found}");
    assert_eq!(memory_rows(&session), before);
    // A session that is not a copy counts the retrieval in the memory's row.
    session.copy = None;
    let found = session
        .tool(&client, &settings, "ctx_search", &input)
        .await
        .unwrap();
    assert!(found.contains("lives in the scratch project"), "{found}");
    assert_ne!(memory_rows(&session), before);
}
