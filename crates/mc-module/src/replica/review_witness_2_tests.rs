//! Replication cases the second review found the engine got wrong. Each
//! test describes the case and checks how the engine must behave.
//!
//! - A store copied to another computer before it first joined the stream.
//! - A person's delete whose message id another computer's change of the
//!   same row already took.
//! - A stream made anew on the hub, shorter than the position a computer
//!   stored.
//! - A dreamer change skipped by every receiver but the computer that wrote
//!   it, and a receiver that fences by its own journal.
//! - A writer's change of a row whose send was left unconfirmed, and a send
//!   queued again past a message id another computer took: clause evidence
//!   left behind at a revision the memory no longer has.
//! - The lookups every applied message makes, on a store of tens of
//!   thousands of memories.

use super::hub::InMemoryHub;
use super::test_support::{memory, Computer};
use crate::memory_writes::normalized_hash;

/// The role of project `pj-a`'s dreamer.
const ROLE: &str = "dreamer.pj-a";

/// Run `sql` on `computer` as the dreamer's change list does: inside one
/// transaction, named as a dreamer run holding generation `gen` of `pj-a`'s
/// role.
fn dreamer_writes(computer: &Computer, gen: i64, sql: &str) {
    computer.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        super::name_writer(&tx, "dreamer", Some(1), &[(ROLE.to_owned(), gen)]).unwrap();
        tx.execute_batch(sql).unwrap();
        super::unname_writer(&tx).unwrap();
        tx.commit().unwrap();
    });
}

/// Record in `computer`'s dreamer journal that a run of its own started a
/// batch under generation `gen` of `pj-a`'s role, as
/// `dreamer::store::journal_leases` does before each paid batch.
fn journal_gen(computer: &Computer, gen: i64) {
    computer.execute(&format!(
        "INSERT INTO dream_task_runs (task, kind, level, owner_id, profile, started_at, leases_json)
         VALUES ('swe:curate', 'curate', 'project', 'pj-a', 'swe', 1, '{{\"{ROLE}\": {gen}}}')"
    ));
}

fn importance(computer: &Computer) -> i64 {
    computer.value("SELECT COALESCE(importance, -1) FROM memories")
}

/// Computer A's store is copied to computer B (a backup restored there, or
/// the folder copied by hand) after migration 112 gave it its store id, but
/// before A ever joined the stream. The store records the box id (the
/// machine id of the computer it last ran on) only when it first joins, so
/// the copy can't tell it was moved. Both copies then hold the same store
/// id, and each writes a memory of its own under the same local id. B must
/// still be able to send its memories, under global ids no other row
/// holds, and both computers must end with every memory.
#[tokio::test]
async fn a_store_copied_before_it_first_joined_sends_under_ids_of_its_own() {
    let hub = InMemoryHub::new();
    let a = Computer::new(&hub, 1);
    memory(&a, "pj-a", "Written before the store was copied.");
    let b = Computer::open(&hub, 2, a.copy());
    assert_eq!(a.store_id(), b.store_id(), "the copy carries the store id");
    memory(&a, "pj-a", "Written on A after the copy.");
    memory(&b, "pj-a", "Written on B after the copy.");
    a.sync().await;

    b.replica.join().await.unwrap();
    let sent = b.replica.publish().await;
    assert!(
        sent.is_ok(),
        "B can send nothing, now or on any later round: {sent:?}"
    );
    b.publish_all().await;
    b.follow_all().await;
    a.follow_all().await;
    assert!(
        a.live()
            .contains(&"Written on B after the copy.".to_owned()),
        "B's memory never reached A"
    );
    assert_eq!(a.live(), b.live(), "the computers hold different memories");
}

/// A and B hold a memory at the same revision. A changes it, and B's person
/// deletes it before B has read A's change. B's tombstone names the next
/// revision, as A's change does, so its message id (`<global id>@<revision>`)
/// is the one A's message already has: the hub (which keeps a message id
/// for its duplicate window; the test hub keeps every id) stores nothing
/// and answers with A's sequence. The delete must still reach A.
#[tokio::test]
async fn a_delete_whose_message_id_another_change_took_still_reaches_every_computer() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    memory(&a, "pj-a", "A memory the person deletes on B.");
    a.sync().await;
    b.sync().await;
    // A's change is in the stream; B hasn't read it yet.
    a.execute("UPDATE memories SET importance = 70");
    a.publish_all().await;
    let id: i64 = b.value("SELECT id FROM memories");
    b.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        crate::memory_writes::person::purge(&tx, id).unwrap();
        tx.commit().unwrap();
    });
    b.publish_all().await;
    b.follow_all().await;
    a.follow_all().await;
    assert_eq!(
        b.value::<i64>("SELECT COUNT(*) FROM memories"),
        0,
        "the delete holds on B"
    );
    assert_eq!(
        a.value::<i64>("SELECT COUNT(*) FROM memories"),
        0,
        "the memory the person deleted on B is still on A, and stays there"
    );
}

/// The hub's memory stream is made anew (the hub's storage lost, the hub
/// moved to another computer), so it starts again at sequence 1, below the
/// position A stored on the old stream. A must read the new stream's
/// messages, not wait until it grows past the old position.
#[tokio::test]
async fn a_stream_made_anew_is_read_from_its_start() {
    let old = InMemoryHub::new();
    let a = Computer::new(&old, 1);
    for text in [
        "First memory on A.",
        "Second memory on A.",
        "Third memory on A.",
    ] {
        memory(&a, "pj-a", text);
    }
    a.sync().await;
    assert_eq!(a.replica.position().unwrap(), 3);

    let new = InMemoryHub::new();
    let c = Computer::new(&new, 3);
    memory(&c, "pj-a", "Written on C after the stream was made anew.");
    c.sync().await;
    // The same computer, on its own store, now following the new stream.
    let a = Computer::open(&new, 1, a.copy());
    a.sync().await;
    assert!(
        a.live()
            .contains(&"Written on C after the stream was made anew.".to_owned()),
        "A never reads the new stream's messages below its old position {}",
        a.replica.position().unwrap()
    );
}

/// The dreamer of a stale holder applied a batch under generation 5 of the
/// project's role, then lost its link (a laptop closed) before sending it.
/// Its lease lapsed, the hub handed the role to another computer at
/// generation 6, and that computer's dreamer changed the same memory and
/// sent it. The stale holder sends its batch afterwards. Every receiver
/// skips the stale batch as fenced; the computer that wrote it must end
/// with the same memory as every other computer, not keep its own batch
/// and pass over the newer holder's change as older than its own.
#[tokio::test]
async fn a_fenced_dreamer_change_does_not_stay_on_the_computer_that_wrote_it() {
    let hub = InMemoryHub::new();
    let (stale, holder, other) = (
        Computer::new(&hub, 1),
        Computer::new(&hub, 2),
        Computer::new(&hub, 3),
    );
    memory(&stale, "pj-a", "Releases need two reviewers.");
    for computer in [&stale, &holder, &other] {
        computer.sync().await;
    }
    // The holder's summarizer saw the fact again twice, raising its revision
    // here only, so its next change goes out at another revision than the
    // stale holder's, as revisions on two computers often differ.
    holder.execute("UPDATE memories SET revision = revision + 1");
    holder.execute("UPDATE memories SET revision = revision + 1");
    journal_gen(&holder, 6);
    dreamer_writes(&holder, 6, "UPDATE memories SET importance = 90");
    holder.publish_all().await;
    dreamer_writes(&stale, 5, "UPDATE memories SET importance = 10");
    stale.publish_all().await;
    for computer in [&stale, &holder, &other] {
        computer.follow_all().await;
    }
    assert_eq!(importance(&holder), 90, "the holder keeps its change");
    assert_eq!(
        importance(&other),
        90,
        "the receiver skipped the stale batch"
    );
    assert_eq!(
        importance(&stale),
        importance(&other),
        "the stale holder keeps the batch every other computer skipped"
    );
}

/// The hub handed the role to B at generation 6, and B's dreamer journaled
/// that generation before its first batch; the batch's answer hasn't come
/// back yet, so B has sent no change under generation 6.
/// The former holder A now sends a change it applied under generation 5.
/// B skips it, as older than its own journal's generation; C has seen no
/// change under generation 6 yet and applies it. Every computer must decide
/// the same for one message, or they hold different memories for good.
#[tokio::test]
async fn every_receiver_decides_the_same_for_a_fenced_dreamer_change() {
    let hub = InMemoryHub::new();
    let (stale, holder, other) = (
        Computer::new(&hub, 1),
        Computer::new(&hub, 2),
        Computer::new(&hub, 3),
    );
    memory(&stale, "pj-a", "Releases need two reviewers.");
    for computer in [&stale, &holder, &other] {
        computer.sync().await;
    }
    journal_gen(&holder, 6);
    dreamer_writes(&stale, 5, "UPDATE memories SET importance = 10");
    stale.publish_all().await;
    holder.follow_all().await;
    other.follow_all().await;
    assert_eq!(
        importance(&holder),
        importance(&other),
        "one computer applied the change and another skipped it"
    );
}

/// A memory's send was left unconfirmed (the hub didn't answer), so its
/// outbox row stays `sending`. A writer then changes the memory the way the
/// summarizer's revision commit does: it raises the revision itself, then
/// writes the new text, and keys the new text's clause evidence by the
/// revision it raised to. One change must raise the revision once, so the
/// evidence is found at the memory's revision.
#[tokio::test]
async fn a_change_of_a_row_whose_send_is_unconfirmed_raises_its_revision_once() {
    let hub = InMemoryHub::new();
    let computer = Computer::new(&hub, 1);
    let id = memory(&computer, "pj-a", "Releases need two reviewers.");
    computer.sync().await;
    computer.execute("UPDATE memories SET importance = 70");
    hub.refuse_next(1);
    assert!(computer.replica.publish().await.is_err());
    assert_eq!(
        computer.value::<String>("SELECT state FROM replica_outbox"),
        "sending",
        "the unconfirmed send waits to be sent again"
    );
    let before: i64 = computer.value("SELECT revision FROM memories");
    let text = "Releases need three reviewers.";
    computer.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        tx.execute(
            "UPDATE memories SET revision = revision + 1 WHERE id = ?1",
            [id],
        )
        .unwrap();
        crate::memory_writes::update_content(&tx, id, text, &normalized_hash(text)).unwrap();
        tx.execute(
            "INSERT INTO memory_clause_evidence (memory_id, revision, clause_ordinal, text_hash, evidence_json)
             VALUES (?1, ?2, 0, 'clause', '[]')",
            rusqlite::params![id, before + 1],
        )
        .unwrap();
        tx.commit().unwrap();
    });
    assert_eq!(
        computer.value::<i64>("SELECT revision FROM memories"),
        before + 1,
        "one change raised the revision twice"
    );
    assert_eq!(
        computer.value::<i64>(
            "SELECT COUNT(*) FROM memory_clause_evidence e JOIN memories m
                ON m.id = e.memory_id AND m.revision = e.revision"
        ),
        1,
        "the writer's clause evidence is not found at the memory's revision"
    );
}

/// A and B hold a memory at the same revision, with clause evidence at that
/// revision on B. Both change only its importance before either reads the
/// other's change, so both changes name the next revision and the same
/// message id. B reads A's change first and passes over it, as its own
/// unsent change is later in the stream; its send then meets A's message
/// id, and B queues its change again at a revision past it. The text never
/// changed, so B's clause evidence must still be found at the revision B's
/// memory ends at.
#[tokio::test]
async fn a_send_requeued_past_a_taken_message_id_keeps_its_clause_evidence() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    let text = "Releases need two reviewers.";
    memory(&a, "pj-a", text);
    a.sync().await;
    b.sync().await;
    b.execute(
        "INSERT INTO memory_clause_evidence (memory_id, revision, clause_ordinal, text_hash, evidence_json)
         SELECT id, revision, 0, 'clause', '[]' FROM memories",
    );
    a.execute("UPDATE memories SET importance = 70");
    a.publish_all().await;
    b.execute("UPDATE memories SET importance = 80");
    b.follow_all().await;
    b.publish_all().await;
    b.follow_all().await;
    assert_eq!(
        b.value::<String>("SELECT content FROM memories"),
        text,
        "the text never changed"
    );
    assert_eq!(
        b.value::<i64>(
            "SELECT COUNT(*) FROM memory_clause_evidence e JOIN memories m
                ON m.id = e.memory_id AND m.revision = e.revision"
        ),
        1,
        "B's clause evidence is not found at its memory's revision"
    );
}

/// The query plan SQLite chooses for `sql` on `computer`'s store.
fn plan(computer: &Computer, sql: &str) -> String {
    computer.db.with_connection(|conn| {
        let mut statement = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let count = statement.parameter_count();
        let values: Vec<rusqlite::types::Value> = (0..count)
            .map(|_| rusqlite::types::Value::Text("x".into()))
            .collect();
        statement
            .query_map(rusqlite::params_from_iter(values), |row| {
                row.get::<_, String>(3)
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
            .join("; ")
    })
}

/// Every applied memory looks up the other memories holding its fact, and
/// every message of this computer's own looks its outbox row up by global
/// id. The statements below are the engine's own (`apply::settle_fact`,
/// `apply::own_known`, `apply::own_changes`). On a store with tens of
/// thousands of memories under one owner, and an outbox holding a create
/// for each of them after a join, each must find its rows through an index,
/// not read the owner's every memory or the whole outbox once per message.
#[tokio::test]
async fn the_lookups_of_every_applied_message_use_an_index() {
    let hub = InMemoryHub::new();
    let computer = Computer::new(&hub, 1);
    let facts = plan(
        &computer,
        "SELECT m.id, m.global_id, m.status, d.local_id IS NOT NULL, d.status
           FROM memories m LEFT JOIN replica_derived d ON d.local_id = m.id
          WHERE m.level = ?1 AND m.owner_id = ?2 AND m.category = ?3 AND m.normalized_hash = ?4
          ORDER BY m.id",
    );
    let own = plan(
        &computer,
        "SELECT EXISTS(SELECT 1 FROM replica_outbox
                        WHERE global_id = ?1 AND revision = ?2 AND sender = ?3
                          AND state IN ('sending', 'published'))",
    );
    let ahead = plan(
        &computer,
        "SELECT id, state, revision, epoch, frozen, actor FROM replica_outbox
          WHERE kind = ?1 AND local_id = ?2 AND change <> 'delete' AND state <> 'raised'
            AND NOT (state = 'published'
                     AND stream_seq <= (SELECT stream_seq FROM replica_state WHERE id = 1))
          ORDER BY id",
    );
    assert!(
        facts.contains("normalized_hash=?"),
        "the same-fact lookup reads every memory of the owner: {facts}"
    );
    assert!(
        !own.contains("SCAN replica_outbox"),
        "an own message's lookup reads the whole outbox: {own}"
    );
    assert!(
        !ahead.contains("SCAN replica_outbox"),
        "an arrival's outbox lookup reads the whole outbox: {ahead}"
    );
}
