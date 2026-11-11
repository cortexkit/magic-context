//! Memory list/stats queries must stay correct when `memory_embeddings` holds
//! multiple rows per memory (one per embedding model).
#[path = "support/isolated_home.rs"]
mod isolated_home;
use isolated_home::isolated_home;

use std::sync::{Mutex, OnceLock};

use magic_context_dashboard_lib::db;
use rusqlite::{params, Connection};

static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn make_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open test db");
    conn.execute_batch(
        "CREATE TABLE memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'CONSTRAINTS',
            content TEXT NOT NULL,
            normalized_hash TEXT NOT NULL DEFAULT '',
            source_session_id TEXT,
            source_type TEXT DEFAULT 'dashboard-test',
            seen_count INTEGER DEFAULT 1,
            retrieval_count INTEGER DEFAULT 0,
            first_seen_at INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT 0,
            updated_at INTEGER DEFAULT 0,
            last_seen_at INTEGER DEFAULT 0,
            last_retrieved_at INTEGER,
            status TEXT DEFAULT 'active',
            expires_at INTEGER,
            verification_status TEXT DEFAULT 'unverified',
            verified_at INTEGER,
            superseded_by_memory_id INTEGER,
            merged_from TEXT,
            metadata_json TEXT
        );
        CREATE TABLE memory_embeddings (
            memory_id INTEGER NOT NULL,
            embedding BLOB NOT NULL,
            model_id TEXT NOT NULL,
            PRIMARY KEY (memory_id, model_id)
        );
        CREATE TABLE project_state (
            project_path TEXT PRIMARY KEY,
            project_memory_epoch INTEGER NOT NULL DEFAULT 0,
            project_user_profile_version INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        );",
    )
    .expect("create schema");
    conn
}

const EMBED_BLOB: &[u8] = &[0u8; 8];

#[test]
fn get_memories_dedupes_when_multiple_model_embeddings_exist() {
    isolated_home();
    let _g = env_lock();
    let conn = make_db();
    conn.execute(
        "INSERT INTO memories (project_path, category, content, normalized_hash, status, created_at, updated_at, first_seen_at, last_seen_at)
         VALUES ('git:p', 'C', 'coexistence probe', 'h1', 'active', 1, 1, 1, 1)",
        [],
    )
    .unwrap();
    let memory_id: i64 = conn.last_insert_rowid();
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
    conn.execute(
        "INSERT INTO memories (project_path, category, content, normalized_hash, status, created_at, updated_at, first_seen_at, last_seen_at)
         VALUES ('git:p', 'C', 'one', 'h1', 'active', 1, 1, 1, 1),
                ('git:p', 'C', 'two', 'h2', 'active', 1, 1, 1, 1)",
        [],
    )
    .unwrap();
    let id1: i64 = memory_id_after(&conn, "one");
    let id2: i64 = memory_id_after(&conn, "two");
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

fn memory_id_after(conn: &Connection, content: &str) -> i64 {
    conn.query_row(
        "SELECT id FROM memories WHERE content = ?1",
        [content],
        |r| r.get(0),
    )
    .unwrap()
}
