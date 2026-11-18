//! The stream's order between computers: a row is decided by the highest
//! revision, and of equal ones the later message; deletes are final; a
//! change of this computer's own that will still win holds an arrival back,
//! and when it can no longer win the row is brought to what every other
//! computer holds.

use super::hub::InMemoryHub;
use super::test_support::{memory, Computer};
use crate::memory_writes::normalized_hash;

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

/// Replace the text of every memory on `computer`, keeping its hash in
/// step, as a person's edit does.
fn rewrite(computer: &Computer, text: &str) {
    computer.db.with_connection(|conn| {
        conn.execute(
            "UPDATE memories SET content = ?1, normalized_hash = ?2",
            rusqlite::params![text, normalized_hash(text)],
        )
        .unwrap();
    });
}

/// The one memory's text and importance (-1 for none).
fn row(computer: &Computer) -> (String, i64) {
    computer.db.with_connection(|conn| {
        conn.query_row(
            "SELECT content, COALESCE(importance, -1) FROM memories",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
    })
}

fn count(computer: &Computer, table: &str) -> i64 {
    computer.value(&format!("SELECT COUNT(*) FROM {table}"))
}

/// Raise the one memory's revision `times` times with nothing replicated
/// changed, as a writer that sees a fact again does, so this computer's
/// next change goes out at a higher revision than another computer's.
fn raise(computer: &Computer, times: usize) {
    for _ in 0..times {
        computer.execute("UPDATE memories SET revision = revision + 1");
    }
}

/// B deletes a memory while A's change of it is still to be sent; A sends
/// its change after B's delete reached the stream, and before reading it.
/// The delete holds on both computers, and A's later change of the deleted
/// row is skipped everywhere.
#[tokio::test]
async fn a_delete_is_final_even_against_a_change_of_this_computers_own_that_comes_later() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    memory(&a, "pj-a", "A memory the person deletes on B.");
    a.sync().await;
    b.sync().await;
    a.execute("UPDATE memories SET importance = 70");
    let id: i64 = b.value("SELECT id FROM memories");
    b.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        crate::memory_writes::person::purge(&tx, id).unwrap();
        tx.commit().unwrap();
    });
    b.publish_all().await;
    a.publish_all().await;
    assert_eq!(
        hub.messages().len(),
        3,
        "A's change is in the stream after the delete"
    );
    a.follow_all().await;
    b.follow_all().await;
    assert_eq!(count(&a, "memories"), 0, "the delete holds on A");
    assert_eq!(
        count(&b, "memories"),
        0,
        "A's later change doesn't bring the row back"
    );
    assert_eq!(count(&a, "replica_outbox"), 0);
}

/// B's unsent change of a memory is at a lower revision than A's change,
/// which reaches the stream first. A's change decides the row: B applies it,
/// its own change is dropped and never sent, and its text stays in B's
/// history.
#[tokio::test]
async fn an_arrival_that_beats_an_unsent_change_applies_and_the_change_is_dropped() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    memory(&a, "pj-a", "Releases need one reviewer.");
    a.sync().await;
    b.sync().await;
    raise(&a, 2);
    rewrite(&a, "Releases need two reviewers.");
    a.publish_all().await;
    rewrite(&b, "Releases need three reviewers.");
    b.follow_all().await;
    assert_eq!(row(&b).0, "Releases need two reviewers.");
    assert_eq!(
        count(&b, "replica_outbox"),
        0,
        "B's beaten change is dropped"
    );
    assert_eq!(
        b.texts("SELECT previous_text FROM memory_history"),
        ["Releases need three reviewers."]
    );
    b.publish_all().await;
    assert_eq!(hub.messages().len(), 2, "B sent nothing");
}

/// Computer X's stale dreamer has a change in flight at revision 4 under
/// generation 5. A person's change at revision 3 arrives (S0): X's own
/// change will win over it, so X passes it over and keeps it. Then the new
/// holder's change under generation 6, at revision 2, arrives (S1): it
/// loses on revision, but the stream now fences X's change. Every other
/// computer holds S0; X must too, and never send its fenced change.
#[tokio::test]
async fn a_change_passed_over_for_one_that_is_then_fenced_is_applied() {
    let hub = InMemoryHub::new();
    let (x, person, holder, other) = (
        Computer::new(&hub, 1),
        Computer::new(&hub, 2),
        Computer::new(&hub, 3),
        Computer::new(&hub, 4),
    );
    memory(&other, "pj-a", "Releases need one reviewer.");
    for computer in [&other, &x, &person, &holder] {
        computer.sync().await;
    }
    raise(&x, 3);
    dreamer_writes(&x, 5, "UPDATE memories SET importance = 10");
    raise(&person, 2);
    rewrite(&person, "Releases need two reviewers.");
    person.publish_all().await;
    dreamer_writes(&holder, 6, "UPDATE memories SET importance = 90");
    holder.publish_all().await;

    x.follow_all().await;
    other.follow_all().await;
    assert_eq!(row(&other), ("Releases need two reviewers.".to_owned(), -1));
    assert_eq!(
        row(&x),
        row(&other),
        "X holds what every other computer holds"
    );
    assert_eq!(count(&x, "replica_passed"), 0);
    x.publish_all().await;
    assert_eq!(hub.messages().len(), 3, "X's fenced change is never sent");
}

/// B's own change of a memory passes over A's change of it, as B's lands
/// later; then B's change turns out too large to send. A's change is what
/// every other computer holds, and B applies it.
#[tokio::test]
async fn a_change_passed_over_for_one_too_large_to_send_is_applied() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    memory(&a, "pj-a", "Releases need one reviewer.");
    a.sync().await;
    b.sync().await;
    rewrite(&a, "Releases need two reviewers.");
    a.publish_all().await;
    rewrite(&b, &"x".repeat(70 * 1024));
    b.follow_all().await;
    assert_eq!(count(&b, "replica_passed"), 1, "A's change is kept aside");
    assert_eq!(b.replica.publish().await.unwrap().too_large, 1);
    assert_eq!(row(&b).0, "Releases need two reviewers.");
    assert_eq!(count(&b, "replica_passed"), 0);
    assert_eq!(count(&b, "replica_outbox"), 0);
}

/// B's own change of a memory moves it to an owner the hub can't name, and
/// passes over A's change of it. B's change can never be sent, so it
/// applies A's change, as every other computer holds.
#[tokio::test]
async fn a_change_passed_over_for_one_that_cant_be_addressed_is_applied() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    memory(&a, "pj-a", "Releases need one reviewer.");
    a.sync().await;
    b.sync().await;
    a.execute("UPDATE memories SET importance = 70");
    a.publish_all().await;
    b.execute("UPDATE memories SET owner_id = '/Users/someone/project'");
    b.follow_all().await;
    assert_eq!(count(&b, "replica_passed"), 1);
    assert_eq!(b.replica.publish().await.unwrap().unaddressable, 1);
    assert_eq!(b.value::<String>("SELECT owner_id FROM memories"), "pj-a");
    assert_eq!(row(&b).1, 70);
    assert_eq!(count(&b, "replica_passed"), 0);
}

/// B's own change passes over A's change at a lower revision; then C's
/// change at a higher revision than B's arrives. C's decides the row: B
/// applies it, drops its own change, and no longer keeps A's.
#[tokio::test]
async fn a_newer_arrival_beats_both_the_own_change_and_the_one_it_passed_over() {
    let hub = InMemoryHub::new();
    let (a, b, c) = (
        Computer::new(&hub, 1),
        Computer::new(&hub, 2),
        Computer::new(&hub, 3),
    );
    memory(&a, "pj-a", "Releases need one reviewer.");
    for computer in [&a, &b, &c] {
        computer.sync().await;
    }
    a.execute("UPDATE memories SET importance = 70");
    a.publish_all().await;
    raise(&b, 1);
    b.execute("UPDATE memories SET importance = 80");
    b.follow_all().await;
    assert_eq!(count(&b, "replica_passed"), 1);
    raise(&c, 3);
    c.execute("UPDATE memories SET importance = 90");
    c.publish_all().await;
    b.follow_all().await;
    assert_eq!(row(&b).1, 90);
    assert_eq!(count(&b, "replica_passed"), 0);
    assert_eq!(count(&b, "replica_outbox"), 0);
}

/// X applies a person's change W, then X's stale dreamer changes the row
/// under generation 5, written over W. The new holder's change under
/// generation 6 arrives at a lower revision than W: it loses, but it fences
/// X's change, and nothing was passed over to bring back. X reads W again
/// from the stream, by its sequence, and applies it, even across a restart
/// of its engine.
#[tokio::test]
async fn a_fenced_change_written_over_an_applied_arrival_reads_that_arrival_again() {
    let hub = InMemoryHub::new();
    let (x, person, holder) = (
        Computer::new(&hub, 1),
        Computer::new(&hub, 2),
        Computer::new(&hub, 3),
    );
    memory(&person, "pj-a", "Releases need one reviewer.");
    for computer in [&person, &x, &holder] {
        computer.sync().await;
    }
    raise(&person, 2);
    rewrite(&person, "Releases need two reviewers.");
    person.publish_all().await;
    x.follow_all().await;
    dreamer_writes(&x, 5, "UPDATE memories SET importance = 10");
    dreamer_writes(&holder, 6, "UPDATE memories SET importance = 90");
    holder.publish_all().await;

    assert_eq!(x.replica.follow().await.unwrap(), 1);
    assert_eq!(
        count(&x, "replica_restore"),
        1,
        "W is queued to be read again"
    );
    assert_eq!(
        count(&x, "replica_outbox"),
        0,
        "the fenced change is never sent"
    );
    // The engine stops here; the queued read survives it.
    let x = Computer::open(&hub, 1, x.copy());
    x.follow_all().await;
    person.follow_all().await;
    assert_eq!(row(&x), ("Releases need two reviewers.".to_owned(), -1));
    assert_eq!(row(&x), row(&person));
    assert_eq!(count(&x, "replica_restore"), 0);
}

/// The same, with W gone from the hub: the row is kept as it is, the read
/// is dropped, and the rest of the stream still applies.
#[tokio::test]
async fn a_message_to_read_again_that_the_hub_no_longer_holds_keeps_the_row() {
    let hub = InMemoryHub::new();
    let (x, person, holder) = (
        Computer::new(&hub, 1),
        Computer::new(&hub, 2),
        Computer::new(&hub, 3),
    );
    memory(&person, "pj-a", "Releases need one reviewer.");
    for computer in [&person, &x, &holder] {
        computer.sync().await;
    }
    raise(&person, 2);
    rewrite(&person, "Releases need two reviewers.");
    person.publish_all().await;
    let w = hub.messages().last().unwrap().seq;
    x.follow_all().await;
    dreamer_writes(&x, 5, "UPDATE memories SET importance = 10");
    dreamer_writes(&holder, 6, "UPDATE memories SET importance = 90");
    holder.publish_all().await;
    assert_eq!(x.replica.follow().await.unwrap(), 1);
    hub.forget(w);
    x.follow_all().await;
    assert_eq!(count(&x, "replica_restore"), 0);
    assert_eq!(row(&x), ("Releases need two reviewers.".to_owned(), 10));
}

/// A person's edit waits to be sent on X when X's stale dreamer changes the
/// same memory under generation 5, after the holder's change under
/// generation 6 reached the stream. The person's edit goes out as its own
/// message, with the row as the person left it, and the dreamer's change as
/// another: every computer applies the person's edit and fences the
/// dreamer's, X included.
#[tokio::test]
async fn a_persons_waiting_edit_is_sent_apart_from_a_later_dreamer_change() {
    let hub = InMemoryHub::new();
    let (x, holder, other) = (
        Computer::new(&hub, 1),
        Computer::new(&hub, 2),
        Computer::new(&hub, 3),
    );
    memory(&other, "pj-a", "Releases need one reviewer.");
    for computer in [&other, &x, &holder] {
        computer.sync().await;
    }
    dreamer_writes(&holder, 6, "UPDATE memories SET importance = 90");
    holder.publish_all().await;
    rewrite(&x, "Releases need two reviewers.");
    dreamer_writes(&x, 5, "UPDATE memories SET importance = 10");
    assert_eq!(
        x.texts("SELECT actor || ' ' || revision || ' ' || COALESCE(epoch, '-') FROM replica_outbox ORDER BY id"),
        ["ck-mc 2 -", "dreamer 3 5"],
        "two messages, each with its writer"
    );
    x.publish_all().await;
    for computer in [&x, &holder, &other] {
        computer.follow_all().await;
    }
    let expected = ("Releases need two reviewers.".to_owned(), -1);
    assert_eq!(
        row(&other),
        expected,
        "the person's edit applies, the stale change is fenced"
    );
    assert_eq!(row(&holder), expected);
    assert_eq!(row(&x), expected);
}

/// The other order: X's stale dreamer change waits to be sent when a person
/// edits the same memory. The person edited the row with the dreamer's
/// change in it, so the person's message carries it, and it isn't fenced;
/// the dreamer's own message is.
#[tokio::test]
async fn a_persons_edit_after_a_waiting_dreamer_change_carries_what_the_person_saw() {
    let hub = InMemoryHub::new();
    let (x, holder, other) = (
        Computer::new(&hub, 1),
        Computer::new(&hub, 2),
        Computer::new(&hub, 3),
    );
    memory(&other, "pj-a", "Releases need one reviewer.");
    for computer in [&other, &x, &holder] {
        computer.sync().await;
    }
    dreamer_writes(&holder, 6, "UPDATE memories SET importance = 90");
    holder.publish_all().await;
    dreamer_writes(&x, 5, "UPDATE memories SET importance = 10");
    rewrite(&x, "Releases need two reviewers.");
    assert_eq!(
        x.texts("SELECT actor || ' ' || revision || ' ' || COALESCE(epoch, '-') FROM replica_outbox ORDER BY id"),
        ["dreamer 2 5", "ck-mc 3 -"]
    );
    x.publish_all().await;
    for computer in [&x, &holder, &other] {
        computer.follow_all().await;
    }
    let expected = ("Releases need two reviewers.".to_owned(), 10);
    assert_eq!(row(&other), expected);
    assert_eq!(row(&holder), expected);
    assert_eq!(row(&x), expected);
    assert_eq!(
        other.value::<i64>("SELECT COUNT(*) FROM replica_rejects"),
        1,
        "the dreamer's own message is fenced"
    );
}

/// A dreamer change without an epoch (a build without the lease, or a run
/// that doesn't hold the row's role) joins a waiting change as any change
/// does: nothing is frozen.
#[tokio::test]
async fn a_dreamer_change_without_an_epoch_joins_a_waiting_change() {
    let hub = InMemoryHub::new();
    let x = Computer::new(&hub, 1);
    memory(&x, "pj-a", "Releases need one reviewer.");
    x.sync().await;
    rewrite(&x, "Releases need two reviewers.");
    x.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        super::name_writer(&tx, "dreamer", Some(1), &[]).unwrap();
        tx.execute_batch("UPDATE memories SET importance = 10")
            .unwrap();
        super::unname_writer(&tx).unwrap();
        tx.commit().unwrap();
    });
    assert_eq!(
        x.texts(
            "SELECT actor || ' ' || revision || ' ' || COALESCE(frozen, '-') FROM replica_outbox"
        ),
        ["dreamer 2 -"]
    );
}
