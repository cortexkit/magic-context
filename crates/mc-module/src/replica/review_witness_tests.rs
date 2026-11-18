//! Replication cases that are easy to get wrong: a delete meeting an earlier
//! change from another computer, a store busy for a moment, a store made anew
//! or restored from a copy, a sighting that changes nothing, the same fact
//! written on two computers, and evidence kept across a revision. Each test
//! describes the case and checks how the replica engine must behave.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::hub::{Hub, InMemoryHub};
use super::test_support::{
    assert_changes_captured, box_of, mark_sent, memory, state, Computer, TestSealer, KEY,
};
use super::Replica;
use crate::context_db::ContextDb;
use crate::memory_writes::normalized_hash;

fn contents(computer: &Computer) -> Vec<String> {
    computer.texts("SELECT content FROM memories ORDER BY content")
}

/// Replace the text of every memory on `computer`, as a writer that keeps
/// the text's hash in step does.
fn rewrite(computer: &Computer, text: &str) {
    computer.db.with_connection(|conn| {
        conn.execute(
            "UPDATE memories SET content = ?1, normalized_hash = ?2",
            rusqlite::params![text, normalized_hash(text)],
        )
        .unwrap();
    });
}

/// A deletes a memory for good while B's earlier change of it is in the
/// stream but not yet read on A. The person's delete must hold on A, as it
/// does on every other computer.
#[tokio::test]
async fn a_persons_delete_is_not_undone_by_an_earlier_change_from_another_computer() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    let id = memory(&a, "pj-a", "A memory the person deletes on A.");
    a.sync().await;
    b.sync().await;
    // B's change reaches the stream before A's delete does.
    b.execute("UPDATE memories SET importance = 70");
    b.publish_all().await;
    a.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        crate::memory_writes::person::purge(&tx, id).unwrap();
        tx.commit().unwrap();
    });
    // A reads B's change, then sends its tombstone.
    a.follow_all().await;
    a.publish_all().await;
    a.follow_all().await;
    b.follow_all().await;
    assert_eq!(
        b.value::<i64>("SELECT COUNT(*) FROM memories"),
        0,
        "B applied the tombstone"
    );
    assert_eq!(
        a.value::<i64>("SELECT COUNT(*) FROM memories"),
        0,
        "the computer the person deleted the memory on still has it"
    );
}

/// The computer that sent a memory gets a fresh store (a reinstall, a new
/// disk) but keeps its machine id. Its new memories must not take the
/// global ids its old ones were sent under, and it must get its old
/// memories back from the stream like any computer that joins.
#[tokio::test]
async fn a_store_made_anew_on_the_same_computer_keeps_every_memory_on_every_computer() {
    let hub = InMemoryHub::new();
    let b = Computer::new(&hub, 2);
    {
        let a = Computer::new(&hub, 1);
        memory(&a, "pj-a", "Written before the store was made anew.");
        a.sync().await;
    }
    b.sync().await;
    // The same machine, so the same box id, with an empty store.
    let a = Computer::new(&hub, 1);
    memory(&a, "pj-a", "Written after the store was made anew.");
    a.sync().await;
    b.follow_all().await;
    let both = [
        "Written after the store was made anew.",
        "Written before the store was made anew.",
    ];
    assert_eq!(
        contents(&b),
        both,
        "the new memory overwrote the old one on the other computer"
    );
    assert_eq!(
        contents(&a),
        both,
        "the old memory never came back to its own computer"
    );
}

/// Set by the busy handler the first time it is asked to wait, which tells
/// the other connection to let go of its write lock.
static RELEASE: AtomicBool = AtomicBool::new(false);

/// The first wait gives up at once, as the store's 250 ms wait does when
/// another process holds the write lock for longer; later waits keep
/// waiting until the lock is free.
fn gives_up_once(attempts: i32) -> bool {
    if !RELEASE.swap(true, Ordering::SeqCst) {
        return false;
    }
    std::thread::sleep(Duration::from_millis(5));
    attempts < 2000
}

/// Another process (a plugin host, the dashboard) holds context.db's write
/// lock for a moment while a message arrives. The message is good; the
/// store was only busy. It must apply once the store is free, not be
/// recorded as rejected and skipped for good.
#[tokio::test]
async fn a_store_busy_for_a_moment_never_skips_a_good_message() {
    let hub = InMemoryHub::new();
    let a = Computer::new(&hub, 1);
    memory(&a, "pj-a", "Kept through a busy moment.");
    a.sync().await;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("context.db");
    let db = Arc::new(ContextDb::create_for_tests(&path).unwrap());
    let b = Replica::new(
        Arc::clone(&db),
        Arc::clone(&hub) as Arc<dyn Hub>,
        TestSealer::new(KEY, 1),
        box_of(2),
    );
    db.with_connection(|conn| conn.busy_handler(Some(gives_up_once)))
        .unwrap();
    let (ready, held) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let other = rusqlite::Connection::open(&path).unwrap();
        other.execute_batch("BEGIN IMMEDIATE").unwrap();
        ready.send(()).unwrap();
        while !RELEASE.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(1));
        }
        other.execute_batch("COMMIT").unwrap();
    });
    held.recv().unwrap();
    // A fixed engine may report the busy store and read the message again
    // on its next round.
    for _ in 0..5 {
        if b.follow().await.is_ok() && b.position().unwrap() == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    holder.join().unwrap();
    let (rejected, arrived): (i64, i64) = db.with_connection(|conn| {
        conn.query_row(
            "SELECT (SELECT COUNT(*) FROM replica_rejects), (SELECT COUNT(*) FROM memories)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
    });
    assert_eq!(
        (rejected, arrived),
        (0, 1),
        "the good message was recorded as rejected and never applied"
    );
}

/// The summarizer admits a fact a live memory already holds: the memory is
/// seen once more, which only moves its read counters. Read counters never
/// travel, so nothing is queued for the other computers. The writer still
/// raises the memory's revision, which its own history row is keyed by; that
/// raise is held as `raised` and never sent, so the check counts only rows
/// that would be sent, and a publish round proves the hub receives nothing.
#[tokio::test]
async fn a_fact_seen_again_queues_nothing_for_the_other_computers() {
    let hub = InMemoryHub::new();
    let computer = Computer::new(&hub, 1);
    computer.replica.join().await.unwrap();
    let text = "Releases need two reviewers.";
    computer.db.with_connection(|conn| sighting_of(conn, text));
    computer.replica.publish().await.unwrap();
    assert!(hub.messages().is_empty(), "the hub received nothing");
}

/// Write memory `text` of project `pj-a` as sent, then have the summarizer
/// see it again, checking that the sighting changed nothing replicated.
fn sighting_of(conn: &mut rusqlite::Connection, text: &str) {
    use crate::summary::two_pass::applier::{admit, Admission};
    conn.execute(
        "INSERT INTO memories (level, owner_id, category, origin_category, content,
             normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
         VALUES ('project', 'pj-a', ?1, 'ARCHITECTURE', ?2, ?3, 1, 1, 1, 1)",
        rusqlite::params![
            crate::memory_levels::category_id("ARCHITECTURE", None),
            text,
            normalized_hash(text)
        ],
    )
    .unwrap();
    mark_sent(conn);
    let before = state(conn);
    let receipt = admit(
        conn,
        &Admission {
            key: "fact-seen-again",
            operation: "new",
            project: "pj-a",
            category: "ARCHITECTURE",
            content: text,
            source_session: "ses-1",
            memory_enabled: true,
            auto_promote: true,
            conflict_target: None,
            fact_id: 1,
            reservation: None,
            authority: None,
            owner: None,
            expires: None,
            line: None,
        },
    )
    .map_err(|error| error.to_string())
    .unwrap();
    assert_eq!(receipt.reason, "live_match", "the fact matched the memory");
    let seen: i64 = conn
        .query_row("SELECT seen_count FROM memories", [], |row| row.get(0))
        .unwrap();
    assert!(seen > 0, "the sighting was counted");
    assert_changes_captured(conn, &before);
}

/// A changes a memory's text to a fact B has just written itself and not
/// sent yet. Both computers must end with the same rows.
#[tokio::test]
async fn an_arrival_that_matches_a_local_fact_still_converges() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    memory(&a, "pj-a", "Builds use make.");
    a.sync().await;
    b.sync().await;
    memory(&b, "pj-a", "Builds use cargo.");
    rewrite(&a, "Builds use cargo.");
    a.publish_all().await;
    b.follow_all().await;
    b.sync().await;
    a.follow_all().await;
    assert_eq!(
        contents(&a),
        contents(&b),
        "the computers hold different memories"
    );
}

/// The same fact written on two computers, one of which changes its text
/// before it hears of the other's. Every computer must end with the same
/// rows, whatever order the creates reached it in.
#[tokio::test]
async fn the_same_fact_written_twice_converges_whatever_the_order_it_arrives_in() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    // B follows the empty stream, so it may send before it reads A's create.
    b.replica.join().await.unwrap();
    memory(&a, "pj-a", "Releases need two reviewers.");
    a.sync().await;
    memory(&b, "pj-a", "Releases need two reviewers.");
    b.publish_all().await;
    rewrite(&a, "Releases need three reviewers.");
    a.publish_all().await;
    a.follow_all().await;
    b.follow_all().await;
    assert_eq!(
        contents(&a),
        contents(&b),
        "the computers hold different memories"
    );
}

/// An arrival that changes only a memory's importance leaves its text as it
/// was. `memory_clause_evidence` records, per clause of a memory's text, the
/// session messages that clause came from, keyed by memory and revision.
/// It must still be found at the memory's revision after the arrival, as a
/// local writer that keeps the text copies it to the revision it makes.
#[tokio::test]
async fn an_arrival_that_keeps_the_text_keeps_its_clause_evidence() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    let id = memory(&a, "pj-a", "Releases need two reviewers.");
    a.execute(&format!(
        "INSERT INTO memory_clause_evidence (memory_id, revision, clause_ordinal, text_hash, evidence_json)
         SELECT id, revision, 0, 'clause', '[]' FROM memories WHERE id = {id}"
    ));
    a.sync().await;
    b.sync().await;
    b.execute("UPDATE memories SET importance = 80");
    b.sync().await;
    a.follow_all().await;
    assert_eq!(
        a.value::<i64>("SELECT importance FROM memories"),
        80,
        "the change arrived"
    );
    assert_eq!(
        a.value::<i64>(&format!(
            "SELECT COUNT(*) FROM memory_clause_evidence
              WHERE memory_id = {id} AND revision = (SELECT revision FROM memories WHERE id = {id})"
        )),
        1,
        "the clause evidence is no longer found at the memory's revision"
    );
}
