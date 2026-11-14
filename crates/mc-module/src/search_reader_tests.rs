//! A search reads on a connection of its own, off the runtime's worker
//! threads, so it holds up neither another session's call to the store nor
//! the runtime's other tasks.

use super::*;
use serde_json::json;
use std::time::{Duration, Instant};

const PROJECT: &str = "dir:search-reader-test";

fn route(session: &str, root: &str) -> Route {
    Route {
        session: SessionRef::new("test", "mock", session),
        project: Some(crate::route::Project {
            id: PROJECT.into(),
            root: root.into(),
        }),
        workdir: None,
        agent_id: None,
    }
}

/// A store with one memory, and a session that searches it.
fn store() -> (tempfile::TempDir, Arc<ContextDb>, String, i64) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap().to_owned();
    let db = Arc::new(ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap());
    let memory = db.with_connection(|conn| {
        crate::memory_writes::save(
            conn,
            &crate::memory_writes::Writer {
                harness: "mock",
                session: "asking",
                project: PROJECT,
                authority: None,
            },
            "PROJECT_RULES",
            "The store keeps one row per memory.",
        )
        .unwrap()
        .memory_id
        .unwrap()
    });
    (dir, db, root, memory)
}

/// Searches while the test holds its read, until `release` lets it go on.
fn held_search(
    db: &Arc<ContextDb>,
    root: &str,
) -> (
    tokio::task::JoinHandle<Result<String, String>>,
    crate::context_db::SearchPause,
) {
    let pause = db.pause_next_search_read();
    let mut searching = Session::tools_only(&route("searching", root), Some(db.clone()));
    let search = tokio::spawn(async move {
        searching
            .tool(
                &Client::default(),
                &Settings::default(),
                "ctx_search",
                &json!({"query": "how does the store keep memories"}),
            )
            .await
    });
    (search, pause)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn another_sessions_memory_read_answers_while_a_search_reads() {
    let (_dir, db, root, memory) = store();
    let (search, crate::context_db::SearchPause { reached, release }) = held_search(&db, &root);
    let reached =
        tokio::task::spawn_blocking(move || reached.recv_timeout(Duration::from_secs(10)))
            .await
            .unwrap();
    assert!(reached.is_ok(), "the search never read");
    // Let the search go on after three seconds, whatever happens here, so a
    // read that waits for it still finishes.
    let releaser = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        let _ = release.send(());
    });
    let mut asking = Session::tools_only(&route("asking", &root), Some(db.clone()));
    let asked = Instant::now();
    let answer = asking
        .tool(
            &Client::default(),
            &Settings::default(),
            "ctx_memory",
            &json!({"action": "get", "ids": [memory]}),
        )
        .await
        .unwrap();
    let waited = asked.elapsed();
    assert!(answer.contains("one row per memory"), "{answer}");
    assert!(waited < Duration::from_secs(2), "waited {waited:?}");
    releaser.join().unwrap();
    assert!(search.await.unwrap().is_ok());
}

#[tokio::test(flavor = "current_thread")]
async fn a_search_waiting_for_the_store_leaves_the_runtime_free() {
    let (_dir, db, root, _) = store();
    let (search, crate::context_db::SearchPause { reached, release }) = held_search(&db, &root);
    let paused = Arc::new(std::sync::atomic::AtomicBool::new(false));
    // Hold the search's read for three seconds after it starts.
    let releaser = {
        let paused = Arc::clone(&paused);
        std::thread::spawn(move || {
            if reached.recv_timeout(Duration::from_secs(10)).is_ok() {
                paused.store(true, std::sync::atomic::Ordering::SeqCst);
                std::thread::sleep(Duration::from_secs(3));
            }
            let _ = release.send(());
        })
    };
    // This runtime has one thread. While the test sleeps, the search starts
    // and waits on its read; the sleep still ends on time.
    let asked = Instant::now();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let slept = asked.elapsed();
    assert!(
        paused.load(std::sync::atomic::Ordering::SeqCst),
        "the search was not waiting during the sleep"
    );
    assert!(slept < Duration::from_secs(1), "slept {slept:?}");
    assert!(search.await.unwrap().is_ok());
    releaser.join().unwrap();
}
