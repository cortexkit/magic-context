//! A receiver's fence on dreamer changes: a dreamer change of a row is
//! recorded and skipped when the stream already holds a change of that
//! same row, for the same role, under a newer lease generation. The fence
//! comes from the stream alone, never from the receiver's own leases.

use super::hub::InMemoryHub;
use super::test_support::{memory, Computer};

const ROLE: &str = "dreamer.pj-a";

/// Run `sql` on `computer` as a dreamer run holding generation `gen` of
/// `pj-a`'s role does, in one transaction.
fn dreamer_writes(computer: &Computer, gen: i64, sql: &str) {
    computer.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        super::name_writer(&tx, "dreamer", Some(1), &[(ROLE.to_owned(), gen)]).unwrap();
        tx.execute_batch(sql).unwrap();
        super::unname_writer(&tx).unwrap();
        tx.commit().unwrap();
    });
}

/// A memory of `pj-a` that the dreamer writes on `computer`, under
/// generation `gen` of the project's role.
fn dreamed(computer: &Computer, content: &str, gen: i64) {
    dreamer_writes(
        computer,
        gen,
        &format!(
            "INSERT INTO memories (level, owner_id, category, origin_category, content,
                 normalized_hash, first_seen_at, created_at, updated_at, last_seen_at, source_type)
             VALUES ('project', 'pj-a', 'swe:architecture', 'ARCHITECTURE', '{content}', '{}',
                     1, 1, 1, 1, 'dreamer')",
            crate::memory_writes::normalized_hash(content)
        ),
    );
}

fn importance(computer: &Computer, content: &str) -> i64 {
    computer.value(&format!(
        "SELECT COALESCE(importance, -1) FROM memories WHERE content = '{content}'"
    ))
}

fn rejects(computer: &Computer) -> Vec<String> {
    computer.texts("SELECT reason FROM replica_rejects ORDER BY id")
}

/// The holder changes a memory under generation 5 of the role; a change of
/// the same memory written afterwards under generation 4, by a computer
/// that had lost the role, is counted as a skip, not a refusal. The former holder's
/// change of another memory, which the stream holds no newer change of,
/// applies, and so does a person's change of the fenced memory.
#[tokio::test]
async fn a_receiver_skips_a_dreamer_change_of_a_row_the_stream_holds_a_newer_generation_of() {
    let hub = InMemoryHub::new();
    let (holder, receiver, stale) = (
        Computer::new(&hub, 1),
        Computer::new(&hub, 2),
        Computer::new(&hub, 3),
    );
    memory(&holder, "pj-a", "Releases need two reviewers.");
    memory(&holder, "pj-a", "Builds use cargo.");
    for computer in [&holder, &receiver, &stale] {
        computer.sync().await;
    }
    dreamer_writes(
        &holder,
        5,
        "UPDATE memories SET importance = 50 WHERE content = 'Releases need two reviewers.'",
    );
    holder.publish_all().await;
    stale.follow_all().await;
    dreamer_writes(
        &stale,
        4,
        "UPDATE memories SET importance = 40 WHERE content = 'Releases need two reviewers.';
         UPDATE memories SET importance = 41 WHERE content = 'Builds use cargo.';",
    );
    stale.publish_all().await;
    receiver.follow_all().await;

    assert_eq!(importance(&receiver, "Releases need two reviewers."), 50);
    assert_eq!(
        importance(&receiver, "Builds use cargo."),
        41,
        "no newer generation of this row is in the stream"
    );
    assert!(rejects(&receiver).is_empty());
    assert_eq!(
        receiver.value::<i64>("SELECT CAST(value AS INTEGER) FROM schema_migrations_meta WHERE key = 'replica_routine_skips'"),
        1
    );
    assert_eq!(
        receiver.texts(
            "SELECT m.content || ' ' || f.epoch FROM replica_fences f
               JOIN memories m ON m.global_id = f.global_id
              WHERE f.role = 'dreamer.pj-a' ORDER BY m.content"
        ),
        ["Builds use cargo. 4", "Releases need two reviewers. 5"],
        "each row's fence is the newest generation the stream holds a change of it under"
    );

    stale.follow_all().await;
    assert_eq!(
        importance(&stale, "Releases need two reviewers."),
        50,
        "the former holder ends with what every other computer holds"
    );
    assert_eq!(importance(&stale, "Builds use cargo."), 41);
    stale.execute(
        "UPDATE memories SET importance = 77 WHERE content = 'Releases need two reviewers.'",
    );
    stale.publish_all().await;
    receiver.follow_all().await;
    assert_eq!(
        importance(&receiver, "Releases need two reviewers."),
        77,
        "a change no dreamer wrote is never fenced"
    );
}

/// A receiver whose own dreamer journaled a newer generation of the role
/// than a change arriving from another computer still applies that change,
/// as a computer without such a journal does: the receiver's own leases
/// never decide the fence, so every computer decides the same.
#[tokio::test]
async fn a_receivers_own_dreamer_journal_never_fences_an_arrival() {
    let hub = InMemoryHub::new();
    let (a, b, c) = (
        Computer::new(&hub, 1),
        Computer::new(&hub, 2),
        Computer::new(&hub, 3),
    );
    for computer in [&a, &b, &c] {
        computer.replica.join().await.unwrap();
    }
    b.execute(&format!(
        "INSERT INTO dream_task_runs (task, kind, level, owner_id, profile, started_at, leases_json)
         VALUES ('swe:curate', 'curate', 'project', 'pj-a', 'swe', 1, '{{\"{ROLE}\": 7}}')"
    ));
    dreamed(&a, "Written under generation six.", 6);
    a.publish_all().await;
    b.follow_all().await;
    c.follow_all().await;
    assert_eq!(b.live(), ["Written under generation six."]);
    assert_eq!(b.live(), c.live());
    assert!(rejects(&b).is_empty());
}
