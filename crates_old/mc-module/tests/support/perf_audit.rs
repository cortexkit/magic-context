//! All fixture paths are temporary. No host service or live store is opened.
use rusqlite::params;

#[test]
fn dated_search_reaches_hits_beyond_each_corpus_limit() {
    use crate::memory_tool::{search_available_corpora_for_session, MemorySearchOptions};
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    let dir = tempfile::tempdir().unwrap();
    let store = mc_store::McStore::open_for_test(&StorageDescriptor {
        module_id: "magic-context-test".into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.path().join("store.db").to_string_lossy().into(),
        },
    })
    .unwrap();
    store.with_context_conn_for_test(|tx| {
        for i in 0..102 {
            // The oldest match is exactly on both inclusive endpoints. All 101 newer
            // matches are outside the date range but would fill the SQL candidate cap.
            let date = if i == 0 { 1000 } else { 2000 };
            let content = format!("literal_100% needle {i}");
            tx.execute("INSERT INTO memories(project_path,category,content,normalized_hash,first_seen_at,created_at,updated_at,last_seen_at) VALUES ('p','ARCHITECTURE',?1,?2,?3,?3,?3,?3)", params![content,format!("hash{i}"),date])?;
            tx.execute("INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,created_at) VALUES ('s',?1,?1,?1,'summary',?2,?3)", params![i+1,content,date])?;
            tx.execute("INSERT INTO notes(type,project_path,session_id,content,status,created_at,updated_at) VALUES ('smart','p','s',?1,'active',?2,?2)", params![content,date])?;
        }
        Ok(())
    }).unwrap();
    // Undated candidate identities and ordering come from the original queries,
    // independently of the implementation of inclusive date bounds.
    let query = "literal_100% needle";
    assert_eq!(
        store
            .search_visible_memory_contents("p", query)
            .unwrap()
            .iter()
            .map(|r| r.id)
            .collect::<Vec<_>>(),
        (2..=101).collect::<Vec<_>>()
    );
    assert_eq!(
        store
            .search_compartments_like("s", query)
            .unwrap()
            .iter()
            .map(|r| r.sequence)
            .collect::<Vec<_>>(),
        (3..=102).rev().collect::<Vec<_>>()
    );
    assert_eq!(
        store
            .search_notes_like("p", "s", query)
            .unwrap()
            .iter()
            .map(|r| r.id)
            .collect::<Vec<_>>(),
        (3..=102).rev().collect::<Vec<_>>()
    );
    let excluded = std::collections::BTreeSet::new();
    let options = MemorySearchOptions {
        limit: 100,
        include_memories: true,
        include_messages: true,
        include_notes: true,
        excluded_memory_ids: &excluded,
        from_ms: Some(1000),
        to_ms: Some(1000),
    };
    let hits =
        search_available_corpora_for_session(&store, "p", "s", "literal_100% needle", options)
            .unwrap();
    assert_eq!(
        hits.len(),
        3,
        "each corpus must filter dates before LIMIT 100"
    );
    assert!(hits.iter().all(|hit| hit.snippet.contains("needle 0")));
}
