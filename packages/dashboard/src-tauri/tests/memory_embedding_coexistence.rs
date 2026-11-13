//! Memory list/stats queries must stay correct when `memory_embeddings` holds
//! multiple rows per memory (one per embedding model).
#[path = "support/isolated_home.rs"]
mod isolated_home;
use isolated_home::isolated_home;

use std::sync::{Mutex, OnceLock};

use magic_context_dashboard_lib::db;
use rusqlite::{params, Connection};

#[path = "support/context_db.rs"]
mod schema_fixture;

static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn make_db() -> Connection {
    schema_fixture::context_db_in_memory()
}

const EMBED_BLOB: &[u8] = &[0u8; 8];

#[test]
fn get_memories_dedupes_when_multiple_model_embeddings_exist() {
    isolated_home();
    let _g = env_lock();
    let conn = make_db();
    let memory_id = schema_fixture::insert_project_memory(
        &conn,
        "git:p",
        "CONSTRAINTS",
        "coexistence probe",
        "active",
    );
    conn.execute(
        "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?1, ?2, ?3)",
        params![memory_id, EMBED_BLOB, "model-a"],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?1, ?2, ?3)",
        params![memory_id, EMBED_BLOB, "model-b"],
    )
    .unwrap();

    let mems = db::get_memories(&conn, None, None, None, None, None, 50, 0).unwrap();
    assert_eq!(
        mems.len(),
        1,
        "one memory must appear once despite two embedding rows"
    );
    assert!(mems[0].has_embedding);
}

#[test]
fn get_memory_stats_counts_distinct_memories_with_embeddings() {
    isolated_home();
    let _g = env_lock();
    let conn = make_db();
    let id1 = schema_fixture::insert_project_memory(&conn, "git:p", "CONSTRAINTS", "one", "active");
    let id2 = schema_fixture::insert_project_memory(&conn, "git:p", "CONSTRAINTS", "two", "active");
    conn.execute(
        "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?1, ?2, 'm1')",
        params![id1, EMBED_BLOB],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?1, ?2, 'm2')",
        params![id1, EMBED_BLOB],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?1, ?2, 'm1')",
        params![id2, EMBED_BLOB],
    )
    .unwrap();

    let stats = db::get_memory_stats(&conn, None, None).unwrap();
    assert_eq!(stats.total, 2);
    assert_eq!(
        stats.with_embeddings, 2,
        "two memories with embeddings, not four embedding rows"
    );
}
