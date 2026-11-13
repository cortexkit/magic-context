//! How long one pool holds the shared `context.db` connection, on a pool the
//! size of a large real one. Ignored in ordinary runs; run it by hand:
//! `cargo test --release -p mc-module --lib legacy_projects::pool_size_tests -- --ignored --nocapture`.

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection};

use super::pool::{self, Outcome};
use crate::context_db::ContextDb;
use crate::memory_writes::normalized_hash;

const KEY: &str = "git:0123abcd";
const MEMORIES: usize = 5_000;
const NOTES: usize = 500;

/// A 0.49 project with [`MEMORIES`] memories, each with a history, journal,
/// verification and embedding row (a 384-dimension vector), one in ten
/// archived as superseded by the memory before it, and [`NOTES`] notes, half
/// of them smart notes. The targets already hold a few memories of their own.
fn large_pool(conn: &Connection) {
    let tx = conn.unchecked_transaction().unwrap();
    let embedding = vec![7u8; 384 * 4];
    let mut previous = None;
    for index in 0..MEMORIES {
        let content = format!("Memory number {index} about the project's head and its folds.");
        let archived = index % 10 == 9;
        tx.execute(
            "INSERT INTO memories (level, owner_id, category, origin_category, content, normalized_hash,
                                   first_seen_at, created_at, updated_at, last_seen_at, status,
                                   seen_count, retrieval_count, source_project_id, superseded_by_memory_id)
             VALUES ('project', ?1, ?2, 'NAMING', ?3, ?4, 1, 1, 1, 1, ?5, 1, 0, ?1, ?6)",
            params![
                KEY,
                ["swe:naming", "swe:architecture", "swe:constraints"][index % 3],
                content,
                normalized_hash(&content),
                if archived { "archived" } else { "active" },
                if archived { previous } else { None },
            ],
        )
        .unwrap();
        let id = tx.last_insert_rowid();
        previous = Some(id);
        tx.execute(
            "INSERT INTO memory_history (memory_id, revision, previous_text, applied_at, reason,
                                         evidence_json, source_ids_json, decision_key)
             VALUES (?1, 1, 'an older text', 1, 'edit', '[]', '[]', ?2)",
            params![id, format!("decision-{index}")],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO memory_journal (project_path, decision_key, operation, receipt_json, applied_at)
             VALUES (?1, ?2, 'write', '{}', 1)",
            params![KEY, format!("journal-{index}")],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at)
             VALUES (?1, 'src/head.rs', 1, 1)",
            [id],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?1, ?2, 'model')",
            params![id, embedding],
        )
        .unwrap();
    }
    for index in 0..NOTES {
        tx.execute(
            "INSERT INTO notes (type, content, session_id, project_path, created_at, updated_at)
             VALUES (?1, ?2, 'ses-1', ?3, 1, 1)",
            params![
                if index % 2 == 0 { "smart" } else { "session" },
                format!("Note {index}."),
                KEY
            ],
        )
        .unwrap();
    }
    for target in ["pj-a", "pj-b"] {
        for index in 0..50 {
            let content = format!("{target}'s own memory {index}.");
            tx.execute(
                "INSERT INTO memories (level, owner_id, category, origin_category, content,
                                       normalized_hash, first_seen_at, created_at, updated_at,
                                       last_seen_at, status)
                 VALUES ('project', ?1, 'swe:naming', 'NAMING', ?2, ?3, 1, 1, 1, 1, 'active')",
                params![target, content, normalized_hash(&content)],
            )
            .unwrap();
        }
    }
    tx.commit().unwrap();
}

/// How long each transaction `step` runs held the connection, until the pool
/// is settled.
struct Holds(Vec<Duration>);

impl std::fmt::Display for Holds {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut sorted = self.0.clone();
        sorted.sort();
        let mut longest: Vec<(usize, Duration)> = self.0.iter().copied().enumerate().collect();
        longest.sort_by_key(|(_, held)| std::cmp::Reverse(*held));
        write!(
            f,
            "{} transactions, longest {:?}, median {:?}, total {:?}; the five longest (batch, hold): {:?}",
            sorted.len(),
            sorted.last().copied().unwrap_or_default(),
            sorted[sorted.len() / 2],
            sorted.iter().sum::<Duration>(),
            &longest[..longest.len().min(5)]
        )
    }
}

fn measure(db: &ContextDb, mut step: impl FnMut(&mut Connection) -> Outcome) -> Holds {
    let mut holds = Vec::new();
    loop {
        let started = Instant::now();
        let outcome = db.with_connection(|conn| step(conn));
        holds.push(started.elapsed());
        if !matches!(outcome, Outcome::Done(_)) {
            return Holds(holds);
        }
    }
}

fn store() -> (tempfile::TempDir, ContextDb) {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    db.with_connection(|conn| large_pool(conn));
    (dir, db)
}

/// The memories and smart notes left under the key, which a settled pool
/// has none of.
fn knowledge_left(db: &ContextDb) -> i64 {
    db.with_connection(|conn| {
        conn.query_row(
            "SELECT (SELECT count(*) FROM memories WHERE owner_id = ?1)
                  + (SELECT count(*) FROM notes WHERE project_path = ?1 AND type = 'smart')",
            [KEY],
            |row| row.get(0),
        )
        .unwrap()
    })
}

#[test]
#[ignore = "measures a large pool; run by hand with --release --nocapture"]
fn a_large_pool_holds_the_connection_briefly() {
    let group = BTreeSet::from([KEY.to_owned()]);
    let targets = BTreeSet::from(["pj-a".to_owned(), "pj-b".to_owned()]);
    // The whole pool in one transaction, then in batches of `BATCH`.
    for (label, limit) in [("one transaction", usize::MAX), ("batches", pool::BATCH)] {
        let (_dir, db) = store();
        let mut progress = pool::Progress::default();
        let holds = measure(&db, |conn| {
            pool::move_step(conn, &mut progress, KEY, "pj-a", &group, 1, limit).unwrap()
        });
        eprintln!("move of {MEMORIES} memories and {NOTES} notes, {label}: {holds}");
        assert_eq!(knowledge_left(&db), 0);
        let (_dir, db) = store();
        let mut progress = pool::Progress::default();
        let holds = measure(&db, |conn| {
            pool::copy_step(conn, &mut progress, KEY, &targets, 1, limit).unwrap()
        });
        eprintln!("two-target copy of {MEMORIES} memories and {NOTES} notes, {label}: {holds}");
        assert_eq!(knowledge_left(&db), 0);
    }
}
