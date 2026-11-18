//! The replicated tables' columns are all classified, and the capture
//! triggers record exactly the changes they should.

use std::collections::BTreeSet;

use rusqlite::Connection;

use super::schema::{CHILDREN, TABLES, WIRE};
use super::test_support::{memory, Computer};
use crate::context_db::ContextDb;

fn columns(conn: &Connection, table: &str) -> BTreeSet<String> {
    conn.prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

/// Every column of every replicated table is listed exactly once, as
/// replicated, local or a message field. A column added without a decision
/// fails here.
#[test]
fn every_column_of_a_replicated_table_is_replicated_or_local() {
    let conn = ContextDb::fresh_in_memory();
    for table in TABLES {
        let listed: Vec<&str> = table
            .replicated
            .iter()
            .chain(table.local)
            .chain(WIRE.iter())
            .copied()
            .collect();
        let unique: BTreeSet<String> = listed.iter().map(|name| (*name).to_owned()).collect();
        assert_eq!(
            unique.len(),
            listed.len(),
            "{} lists a column twice",
            table.name
        );
        let actual = columns(&conn, table.name);
        let unlisted: Vec<&String> = actual.difference(&unique).collect();
        assert!(
            unlisted.is_empty(),
            "{}: decide whether these columns replicate: {unlisted:?}",
            table.name
        );
        let missing: Vec<&String> = unique.difference(&actual).collect();
        assert!(
            missing.is_empty(),
            "{}: no such columns: {missing:?}",
            table.name
        );
    }
    for child in &CHILDREN {
        assert_eq!(
            columns(&conn, child.name),
            child
                .replicated
                .iter()
                .map(|name| (*name).to_owned())
                .collect(),
            "{}: every column travels in its owner's snapshot",
            child.name
        );
    }
}

fn outbox(computer: &Computer) -> Vec<String> {
    computer.texts(
        "SELECT kind || ':' || local_id || '@' || revision || ':' || change || ':' || state
           FROM replica_outbox ORDER BY id",
    )
}

#[test]
fn a_new_row_is_queued_once_and_later_changes_share_its_unsent_revision() {
    let hub = super::hub::InMemoryHub::new();
    let computer = Computer::new(&hub, 1);
    let id = memory(&computer, "pj-a", "The parser rejects empty input.");
    computer.execute(&format!(
        "UPDATE memories SET importance = 80 WHERE id = {id};
         UPDATE memories SET status = 'archived' WHERE id = {id};"
    ));
    assert_eq!(outbox(&computer), [format!("memory:{id}@1:create:pending")]);
    assert_eq!(
        computer.value::<i64>(&format!("SELECT revision FROM memories WHERE id = {id}")),
        1
    );
}

#[test]
fn a_read_counter_update_or_an_unchanged_value_fires_nothing() {
    let hub = super::hub::InMemoryHub::new();
    let computer = Computer::new(&hub, 1);
    let id = memory(&computer, "pj-a", "The parser rejects empty input.");
    computer.execute("DELETE FROM replica_outbox");
    computer.execute(&format!(
        "UPDATE memories SET seen_count = seen_count + 1, last_seen_at = 9, updated_at = 9 WHERE id = {id};
         UPDATE memories SET retrieval_count = retrieval_count + 1, last_retrieved_at = 9, updated_at = 9 WHERE id = {id};
         UPDATE memories SET status = status, content = content WHERE id = {id};
         UPDATE primers SET updated_at = 5;"
    ));
    assert!(outbox(&computer).is_empty());
}

/// Once a row was sent, the first change raises its revision; more changes
/// before the next send keep that one.
#[test]
fn a_sent_row_gets_one_new_revision_per_unsent_change() {
    let hub = super::hub::InMemoryHub::new();
    let computer = Computer::new(&hub, 1);
    let id = memory(&computer, "pj-a", "The parser rejects empty input.");
    computer.execute(&format!(
        "UPDATE memories SET global_id = 'g.{id}' WHERE id = {id};
         UPDATE replica_outbox SET state = 'published', stream_seq = 1;"
    ));
    computer.execute(&format!(
        "UPDATE memories SET importance = 70 WHERE id = {id};
         UPDATE memories SET mural_cue = 'parser: no empty input' WHERE id = {id};"
    ));
    assert_eq!(
        outbox(&computer),
        [
            format!("memory:{id}@1:create:published"),
            format!("memory:{id}@2:metadata:pending")
        ]
    );
    // A writer that raises the revision itself is not raised again.
    computer.execute("DELETE FROM replica_outbox");
    computer.execute(&format!(
        "UPDATE memories SET revision = revision + 1 WHERE id = {id};
         UPDATE memories SET content = 'The parser rejects blank input.' WHERE id = {id};"
    ));
    assert_eq!(outbox(&computer), [format!("memory:{id}@3:update:pending")]);
    // A file mapping is a change of its memory.
    computer.execute("DELETE FROM replica_outbox");
    computer.execute(&format!(
        "INSERT INTO memory_verifications (memory_id, file_path, verified_at) VALUES ({id}, 'src/a.rs', 0)"
    ));
    assert_eq!(
        outbox(&computer),
        [format!("memory:{id}@4:metadata:pending")]
    );
}

#[test]
fn agent_level_memories_are_never_captured() {
    let hub = super::hub::InMemoryHub::new();
    let computer = Computer::new(&hub, 1);
    let id = memory(&computer, "pj-a", "An agent's own rule.");
    computer.execute(&format!(
        "DELETE FROM replica_outbox;
         UPDATE memories SET level = 'agent', owner_id = 'agent-1' WHERE id = {id};
         UPDATE memories SET importance = 10 WHERE id = {id};"
    ));
    assert!(outbox(&computer).is_empty());
    // Back at a level that replicates, it is captured as a create.
    computer.execute(&format!(
        "UPDATE memories SET level = 'project', owner_id = 'pj-a' WHERE id = {id}"
    ));
    assert_eq!(outbox(&computer), [format!("memory:{id}@1:create:pending")]);
}

#[test]
fn a_delete_of_a_row_never_sent_leaves_nothing_and_of_a_sent_row_a_tombstone() {
    let hub = super::hub::InMemoryHub::new();
    let computer = Computer::new(&hub, 1);
    let unsent = memory(&computer, "pj-a", "Never sent.");
    let sent = memory(&computer, "pj-a", "Sent once.");
    computer.execute(&format!(
        "UPDATE memories SET global_id = 'g.{sent}' WHERE id = {sent};
         DELETE FROM replica_outbox WHERE local_id = {sent};
         DELETE FROM memories WHERE id IN ({unsent}, {sent});"
    ));
    assert_eq!(
        outbox(&computer),
        [format!("memory:{sent}@2:delete:pending")]
    );
    assert_eq!(
        computer.value::<String>(
            "SELECT global_id || ' ' || level || ' ' || owner FROM replica_outbox"
        ),
        format!("g.{sent} project pj-a")
    );
}

/// The apply marker is only visible inside the apply's own transaction: a
/// writer on another connection, waiting for the lock while an apply runs,
/// still has its change captured.
#[test]
fn a_write_waiting_on_another_connection_during_an_apply_is_still_captured() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("context.db");
    drop(ContextDb::create_for_tests(&path).unwrap());
    let mut applying = Connection::open(&path).unwrap();
    let tx = applying
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    tx.execute("INSERT INTO replica_applying (applying) VALUES (1)", [])
        .unwrap();
    tx.execute(
        "INSERT INTO memories (level, owner_id, category, origin_category, content,
             normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
         VALUES ('project', 'pj-a', 'swe:naming', 'NAMING', 'An arrival.', 'h1', 1, 1, 1, 1)",
        [],
    )
    .unwrap();
    let writer = std::thread::spawn(move || {
        let conn = Connection::open(&path).unwrap();
        conn.busy_timeout(std::time::Duration::from_secs(10))
            .unwrap();
        conn.execute(
            "INSERT INTO memories (level, owner_id, category, origin_category, content,
                 normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES ('project', 'pj-a', 'swe:naming', 'NAMING', 'A local write.', 'h2', 1, 1, 1, 1)",
            [],
        )
        .unwrap();
        conn.query_row(
            "SELECT group_concat(m.content) FROM replica_outbox o JOIN memories m ON m.id = o.local_id",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap()
    });
    std::thread::sleep(std::time::Duration::from_millis(200));
    tx.execute("DELETE FROM replica_applying", []).unwrap();
    tx.commit().unwrap();
    assert_eq!(writer.join().unwrap(), "A local write.");
}

/// At the schema version this build reads, every replicated table and
/// every child table has its capture triggers. A migration that rebuilds or
/// alters one of them must create them again, or capture stops silently.
#[test]
fn every_replicated_table_has_its_capture_triggers_at_the_schema_version() {
    let conn = ContextDb::fresh_in_memory();
    assert_eq!(
        crate::context_db::live_schema_version(&conn).unwrap(),
        i64::from(crate::context_migrations::SCHEMA_VERSION)
    );
    let triggers: BTreeSet<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let names = TABLES
        .iter()
        .map(|table| table.name)
        .chain(CHILDREN.iter().map(|child| child.name));
    for name in names {
        for suffix in ["ai", "au", "ad"] {
            let trigger = format!("{name}_replica_{suffix}");
            assert!(triggers.contains(&trigger), "{trigger} is missing");
        }
    }
    assert!(triggers.contains("memories_replica_raised"));
}

/// Mark the row's queued change sent, so its next change raises the
/// revision again.
fn sent(computer: &Computer, seq: i64) {
    computer.execute(&format!(
        "UPDATE replica_outbox SET state = 'published', stream_seq = {seq} WHERE state = 'pending'"
    ));
}

fn evidence_at_revision(computer: &Computer, id: i64) -> (i64, i64) {
    computer
        .value::<String>(&format!(
            "SELECT revision || ' ' || (SELECT COUNT(*) FROM memory_clause_evidence e
                                     WHERE e.memory_id = m.id AND e.revision = m.revision)
           FROM memories m WHERE id = {id}"
        ))
        .split_once(' ')
        .map(|(revision, count)| (revision.parse().unwrap(), count.parse().unwrap()))
        .unwrap()
}

/// A revision the capture raises itself, over text it leaves as it was,
/// keeps the memory's clause evidence, whether the change is the memory's
/// own or one of its child rows'. A change of the text keeps none.
#[test]
fn a_revision_the_capture_raises_keeps_the_clause_evidence_of_unchanged_text() {
    let hub = super::hub::InMemoryHub::new();
    let computer = Computer::new(&hub, 1);
    let id = memory(&computer, "pj-a", "The parser rejects empty input.");
    computer.execute(&format!(
        "UPDATE memories SET global_id = 'g.{id}' WHERE id = {id};
         INSERT INTO memory_clause_evidence (memory_id, revision, clause_ordinal, text_hash, evidence_json)
             VALUES ({id}, 1, 0, 'clause', '[]');"
    ));
    sent(&computer, 1);
    computer.execute(&format!(
        "UPDATE memories SET importance = 80 WHERE id = {id}"
    ));
    assert_eq!(evidence_at_revision(&computer, id), (2, 1));
    sent(&computer, 2);
    computer.execute(&format!(
        "INSERT INTO memory_verifications (memory_id, file_path, verified_at) VALUES ({id}, 'src/a.rs', 0)"
    ));
    assert_eq!(evidence_at_revision(&computer, id), (3, 1));
    sent(&computer, 3);
    computer.execute(&format!(
        "UPDATE memories SET content = 'The parser rejects blank input.' WHERE id = {id}"
    ));
    assert_eq!(evidence_at_revision(&computer, id), (4, 0));
}

/// A revision raised with nothing replicated changed is held as `raised`:
/// never sent by itself, and the revision the next change is sent at.
#[test]
fn a_revision_raised_alone_is_held_and_the_next_change_rides_on_it() {
    let hub = super::hub::InMemoryHub::new();
    let computer = Computer::new(&hub, 1);
    let id = memory(&computer, "pj-a", "The parser rejects empty input.");
    computer.execute(&format!(
        "UPDATE memories SET global_id = 'g.{id}' WHERE id = {id};"
    ));
    sent(&computer, 1);
    computer.execute(&format!(
        "UPDATE memories SET revision = revision + 1, seen_count = seen_count + 1 WHERE id = {id}"
    ));
    assert_eq!(
        outbox(&computer),
        [
            format!("memory:{id}@1:create:published"),
            format!("memory:{id}@2:metadata:raised")
        ]
    );
    computer.execute(&format!(
        "UPDATE memories SET importance = 70 WHERE id = {id}"
    ));
    assert_eq!(
        outbox(&computer),
        [
            format!("memory:{id}@1:create:published"),
            format!("memory:{id}@2:metadata:pending")
        ]
    );
}
