//! Migration 112 on a populated store at 111: the replicated tables gain
//! their global ids and revisions, the replication tables and capture
//! triggers arrive, the Engram memory sync's tables go, the message search
//! map gets its index on `fts_rowid`, every row stays as it was, and
//! nothing already in the store is queued to send.

use rusqlite::{params, Connection};

use super::*;

const PLUGIN_SCHEMA: &str = include_str!("../testdata/context-schema.sql");

/// The store as the module left it at 111: memories, an observation, a
/// primer, file mappings and links, and the Engram sync's rows.
fn populated_store_at_111() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(&PLUGIN_SCHEMA.replace(":applied_at", "0"))
        .unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    let found = crate::context_db::live_schema_version(&conn).unwrap();
    assert_eq!(upgrade_through(&mut conn, found, 111).unwrap(), 111);
    for (id, content, status) in [
        (1, "The parser rejects empty input.", "active"),
        (2, "The parser rejected blank lines.", "archived"),
    ] {
        conn.execute(
            "INSERT INTO memories(id, level, owner_id, category, origin_category, content,
                                  normalized_hash, first_seen_at, created_at, updated_at,
                                  last_seen_at, status, revision)
             VALUES (?1, 'project', 'pj-store', 'swe:architecture', 'ARCHITECTURE', ?2, ?3,
                     1, 1, 1, 1, ?4, 3)",
            params![
                id,
                content,
                crate::memory_writes::normalized_hash(content),
                status
            ],
        )
        .unwrap();
    }
    conn.execute_batch(
        "INSERT INTO memory_verifications (memory_id, file_path, verified_at) VALUES (1, 'src/p.rs', 5);
         INSERT INTO memory_successor_links (source_id, successor_id, decision_key) VALUES (2, 1, 'k');
         INSERT INTO memory_observations (content, session_id, created_at) VALUES ('Likes tea.', 's1', 1);
         INSERT INTO primers (project_path, question, answer, created_at, updated_at)
             VALUES ('pj-store', 'How is it built?', 'With cargo.', 1, 1);
         INSERT INTO memory_sync_state (device, account, enrollment_state, next_local_id,
             hlc_wall_ms, hlc_logical) VALUES ('d', 'a', 'enrolled', 2, 0, 0);
         INSERT INTO memory_ops (account, device, local_id, memory_id, op_digest, canonical, kind,
             created_at) VALUES ('a', 'd', 1, 1, 'x', x'00', 'create', 1);
         INSERT INTO memory_outbox (account, device, local_id) VALUES ('a', 'd', 1);",
    )
    .unwrap();
    conn
}

fn objects(conn: &Connection) -> Vec<(String, String)> {
    conn.prepare(
        "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .unwrap()
    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
    .unwrap()
    .collect::<rusqlite::Result<_>>()
    .unwrap()
}

/// Every row of `table` as quoted values, without the columns migration
/// 112 adds.
fn rows(conn: &Connection, table: &str) -> Vec<String> {
    let columns: Vec<String> = conn
        .prepare(&format!(
            "SELECT name FROM pragma_table_info('{table}')
              WHERE name NOT IN ('global_id') AND NOT ('{table}' IN ('memory_observations', 'primers') AND name = 'revision')
              ORDER BY cid"
        ))
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let select = columns
        .iter()
        .map(|column| format!("quote({column})"))
        .collect::<Vec<_>>()
        .join(" || '|' || ");
    conn.prepare(&format!("SELECT {select} FROM {table} ORDER BY rowid"))
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn migration_112_adds_replication_drops_the_engram_sync_and_keeps_every_row() {
    let mut conn = populated_store_at_111();
    let before = objects(&conn);
    let tables = [
        "memories",
        "memory_observations",
        "primers",
        "memory_verifications",
        "memory_successor_links",
    ];
    let kept: Vec<Vec<String>> = tables.iter().map(|table| rows(&conn, table)).collect();

    assert_eq!(upgrade(&mut conn, 111).unwrap(), 112);
    assert_eq!(SCHEMA_VERSION, 112);

    let after = objects(&conn);
    let added: Vec<String> = after
        .iter()
        .filter(|object| !before.contains(object))
        .map(|(kind, name)| format!("{kind} {name}"))
        .collect();
    let mut expected = vec![
        "index idx_memories_fact",
        "index idx_memories_global_id",
        "index idx_memory_observations_global_id",
        "index idx_message_fts_rowid_map_fts_rowid",
        "index idx_primers_global_id",
        "index idx_replica_derived_survivor",
        "index idx_replica_ids_local",
        "index idx_replica_outbox_global",
        "index idx_replica_outbox_local",
        "index idx_replica_outbox_row",
        "index idx_replica_outbox_state",
        "index idx_replica_pending_links_target",
        "table replica_applying",
        "table replica_derived",
        "table replica_epochs",
        "table replica_fences",
        "table replica_ids",
        "table replica_outbox",
        "table replica_passed",
        "table replica_pending_links",
        "table replica_rejects",
        "table replica_restore",
        "table replica_state",
        "table replica_writer",
    ];
    let mut triggers: Vec<String> = [
        "memories",
        "memory_observations",
        "primers",
        "memory_verifications",
        "memory_successor_links",
        "memory_conflict_links",
    ]
    .iter()
    .flat_map(|table| ["ai", "au", "ad"].map(|when| format!("trigger {table}_replica_{when}")))
    .collect();
    triggers.push("trigger memories_replica_raised".into());
    let mut wanted: Vec<String> = expected.drain(..).map(str::to_owned).collect();
    wanted.append(&mut triggers);
    wanted.sort();
    assert_eq!(added, wanted);
    let removed: Vec<String> = before
        .iter()
        .filter(|object| !after.contains(object))
        .map(|(kind, name)| format!("{kind} {name}"))
        .collect();
    assert_eq!(
        removed,
        [
            "table memory_ops",
            "table memory_outbox",
            "table memory_sync_state"
        ]
    );
    for (table, rows_before) in tables.iter().zip(kept) {
        assert_eq!(rows(&conn, table), rows_before, "{table}");
    }
    let fresh: (i64, i64, i64) = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM memories WHERE global_id IS NULL),
                    (SELECT revision FROM memory_observations),
                    (SELECT revision FROM primers)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(fresh, (2, 1, 1));
    let state: (i64, Option<String>, Option<i64>, String, Option<String>) = conn
        .query_row(
            "SELECT stream_seq, box_id, joined_at, store_id, stream_created FROM replica_state",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!((state.0, state.1, state.2, state.4), (0, None, None, None));
    assert!(
        state.3.len() == 32
            && state
                .3
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')),
        "the store id is 32 lowercase hex characters"
    );
    let queued: i64 = conn
        .query_row("SELECT COUNT(*) FROM replica_outbox", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        queued, 0,
        "rows already in the store are sent when the computer joins"
    );
}

#[test]
fn after_migration_112_a_change_to_an_existing_row_is_captured_once() {
    let mut conn = populated_store_at_111();
    upgrade(&mut conn, 111).unwrap();
    conn.execute_batch(
        "UPDATE memories SET importance = 70 WHERE id = 1;
         UPDATE memories SET seen_count = 4, last_seen_at = 9 WHERE id = 2;
         UPDATE primers SET answer = 'With cargo and bun.';",
    )
    .unwrap();
    let queued: Vec<String> = conn
        .prepare("SELECT kind || ':' || local_id || '@' || revision || ':' || change FROM replica_outbox ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    // Never sent, so still creates at the revisions the rows had.
    assert_eq!(queued, ["memory:1@3:create", "primer:1@1:create"]);
}

#[test]
fn a_store_ck_mc_creates_has_the_replication_tables_and_no_engram_sync() {
    let dir = tempfile::tempdir().unwrap();
    let db =
        crate::context_db::ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    let (version, names) = db.with_connection(|conn| {
        (
            crate::context_db::live_schema_version(conn).unwrap(),
            objects(conn)
                .into_iter()
                .map(|(_, name)| name)
                .collect::<Vec<_>>(),
        )
    });
    assert_eq!(version, i64::from(SCHEMA_VERSION));
    assert!(names.iter().any(|name| name == "replica_outbox"));
    assert!(names
        .iter()
        .any(|name| name == "idx_message_fts_rowid_map_fts_rowid"));
    assert!(names.iter().any(|name| name == "memories_replica_au"));
    assert!(!names
        .iter()
        .any(|name| name == "memory_ops" || name == "memory_sync_state"));
    // Each store ck-mc creates forms its global ids under a store id of its own.
    let other = tempfile::tempdir().unwrap();
    let second =
        crate::context_db::ContextDb::create_for_tests(&other.path().join("context.db")).unwrap();
    let ids: Vec<String> = [&db, &second]
        .iter()
        .map(|db| {
            db.with_connection(|conn| crate::replica::store_id(conn))
                .unwrap()
        })
        .collect();
    assert_ne!(ids[0], ids[1]);
}
