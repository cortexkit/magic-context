//! Replication cases around a stream made anew, a fact's surviving memory
//! and deletes no subject reaches. Each test describes the case and checks
//! how the engine must behave.
//!
//! - The hub's stream made anew while a computer's engine keeps running on
//!   the same connection.
//! - A stream made anew, after one computer missed a change of a row whose
//!   revision it had raised with nothing replicated changed.
//! - A stream made anew while a send waits for its acknowledgement, and an
//!   edit of the same row before the next send.
//! - The person's delete of the memory that holds a fact for two computers'
//!   memories, on the computer that wrote it.
//! - The delete of a memory that this computer had filed under an owner no
//!   hub subject can name, and a round's worth of such deletes.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use super::hub::{Ack, Hub, HubError, HubMessage, InMemoryHub, StreamInfo};
use super::test_support::{box_of, memory, Computer, TestSealer, KEY};
use super::Replica;

fn contents(computer: &Computer) -> Vec<String> {
    computer.texts("SELECT content FROM memories ORDER BY content")
}

/// An owner no hub subject can name: a folder path, as legacy project
/// memories were keyed by.
const FOLDER: &str = "/Users/someone/project";

/// Delete memories `ids` on `computer` as the person's delete does.
fn purge(computer: &Computer, ids: &[i64]) {
    computer.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        for id in ids {
            crate::memory_writes::person::purge(&tx, *id).unwrap();
        }
        tx.commit().unwrap();
    });
}

/// The hub as one engine sees it for as long as its connection lasts, with
/// the stream behind it replaceable. It stands for a hub server that
/// restarts with its storage lost and makes the stream again while the
/// client reconnects on the same connection: the live engine is made anew
/// only when ck-bus replaces the connection ([`super::live`]), and a
/// restarted server only ends the consumer, which the next read makes again
/// from the stored position ([`super::nats`]).
struct SameConnection(Mutex<Arc<InMemoryHub>>);

impl SameConnection {
    fn stream(&self) -> Arc<InMemoryHub> {
        Arc::clone(&self.0.lock().unwrap())
    }

    /// The stream is made anew as `stream`.
    fn make_anew(&self, stream: &Arc<InMemoryHub>) {
        *self.0.lock().unwrap() = Arc::clone(stream);
    }
}

#[async_trait]
impl Hub for SameConnection {
    async fn publish(
        &self,
        subject: &str,
        message_id: &str,
        payload: Vec<u8>,
    ) -> Result<Ack, HubError> {
        self.stream().publish(subject, message_id, payload).await
    }

    async fn fetch(&self, after: u64, max: usize) -> Result<Vec<HubMessage>, HubError> {
        self.stream().fetch(after, max).await
    }

    async fn info(&self) -> Result<StreamInfo, HubError> {
        self.stream().info().await
    }

    async fn get(&self, seq: u64) -> Result<Option<HubMessage>, HubError> {
        self.stream().get(seq).await
    }

    async fn ack(&self, seq: u64) -> Result<(), HubError> {
        self.stream().ack(seq).await
    }
}

/// A's engine reads and sends on one hub connection, and has read the
/// stream to position 3. The hub's server restarts with its storage lost
/// and the stream is made again, empty; the client reconnects on the same
/// connection, so A's engine goes on and never reads the stream's
/// information again. B joins the new stream and writes a memory, which is
/// message 1 there. A must read the new stream from its start and send its
/// rows to it again, as an engine that starts on a stream made anew does:
/// otherwise A never reads B's memory, and B never gets A's, until A's
/// engine happens to start again.
#[tokio::test]
async fn a_stream_made_anew_under_a_running_engine_is_read_from_its_start() {
    let old = InMemoryHub::new();
    let hub = Arc::new(SameConnection(Mutex::new(Arc::clone(&old))));
    let mut a = Computer::new(&old, 1);
    a.replica = Replica::new(
        Arc::clone(&a.db),
        Arc::clone(&hub) as Arc<dyn Hub>,
        TestSealer::new(KEY, 1),
        box_of(1),
    );
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
    hub.make_anew(&new);
    let b = Computer::new(&new, 2);
    memory(&b, "pj-a", "Written on B on the new stream.");
    b.sync().await;

    // A's rounds go on, on the same engine.
    for _ in 0..3 {
        a.replica.round().await.unwrap();
    }
    b.follow_all().await;
    let all = [
        "First memory on A.",
        "Second memory on A.",
        "Third memory on A.",
        "Written on B on the new stream.",
    ];
    assert_eq!(a.live(), all, "A reads B's memory from the new stream");
    assert_eq!(b.live(), all, "A's memories reach the new stream");
}

/// A memory is on A and B. B's summarizer sees its fact again twice, which
/// raises B's revision of it twice with nothing replicated changed: a
/// revision held as `raised`, never sent by itself. Then a person on A
/// edits the memory, and the edit reaches the stream while B is away. On
/// that stream, B would read the edit and apply it. Instead the hub's
/// stream is made anew. A starts on it first and sends the edited memory
/// again; B starts on it later and sends its copy again. The person's edit
/// is the newest change of the memory, so both computers must end with it,
/// not with the older text B never changed.
#[tokio::test]
async fn after_the_stream_is_made_anew_an_edit_beats_an_older_copy_that_missed_it() {
    let old = InMemoryHub::new();
    let (a, b) = (Computer::new(&old, 1), Computer::new(&old, 2));
    memory(&a, "pj-a", "Releases need one reviewer.");
    a.sync().await;
    b.sync().await;
    for _ in 0..2 {
        b.execute("UPDATE memories SET revision = revision + 1");
    }
    a.execute("UPDATE memories SET content = 'Releases need two reviewers.'");
    a.sync().await;

    let new = InMemoryHub::new();
    let a = Computer::open(&new, 1, a.copy());
    a.sync().await;
    let b = Computer::open(&new, 2, b.copy());
    b.sync().await;
    a.follow_all().await;
    assert_eq!(
        contents(&a),
        ["Releases need two reviewers."],
        "the person's edit holds on A"
    );
    assert_eq!(
        contents(&b),
        ["Releases need two reviewers."],
        "B applies the person's edit"
    );
}

/// A memory is on A and B. A person edits it on A, and A's send of the edit
/// is never acknowledged: the hub lost its storage, and the stream is made
/// anew. When A starts on the new stream it queues every row to be sent
/// again, at each row's revision, beside that send still waiting at the
/// same revision. A person then edits the memory again on A, before A's
/// next send. That edit is a change like any other, and both computers
/// must end with it.
#[tokio::test]
async fn an_edit_made_after_the_stream_is_made_anew_reaches_every_computer() {
    let old = InMemoryHub::new();
    let (a, b) = (Computer::new(&old, 1), Computer::new(&old, 2));
    memory(&a, "pj-a", "Releases need one reviewer.");
    a.sync().await;
    b.sync().await;
    a.execute("UPDATE memories SET content = 'Releases need two reviewers.'");
    old.refuse_next(1);
    assert!(
        a.replica.publish().await.is_err(),
        "the send is unconfirmed"
    );

    let new = InMemoryHub::new();
    let a = Computer::open(&new, 1, a.copy());
    a.replica.join().await.unwrap();
    a.execute("UPDATE memories SET content = 'Releases need three reviewers.'");
    a.sync().await;
    let b = Computer::open(&new, 2, b.copy());
    b.sync().await;
    a.follow_all().await;
    assert_eq!(
        contents(&a),
        ["Releases need three reviewers."],
        "the second edit holds on A"
    );
    assert_eq!(
        contents(&b),
        ["Releases need three reviewers."],
        "B gets the second edit"
    );
}

/// A and B each write the same fact before either hears of the other's
/// memory. Every computer keeps the one with the lower global id (A's) live
/// and archives the other (B's) for it, keeping B's own state aside. Then
/// the person deletes A's memory on A. Every computer that applies the
/// delete from the stream decides the fact again, and B's memory, the one
/// left holding it, is live there. A must decide the same for its own
/// delete.
#[tokio::test]
async fn deleting_the_surviving_memory_of_a_fact_on_its_own_computer_brings_the_other_back_there_too(
) {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    a.sync().await;
    b.sync().await;
    // Fixed store ids, so A's global ids are the lower ones.
    a.execute("UPDATE replica_state SET store_id = '11111111111111111111111111111111'");
    b.execute("UPDATE replica_state SET store_id = 'ffffffffffffffffffffffffffffffff'");
    let survivor = memory(&a, "pj-a", "Releases need two reviewers.");
    memory(&b, "pj-a", "Releases need two reviewers.");
    a.sync().await;
    b.sync().await;
    a.follow_all().await;
    assert_eq!(a.live(), ["Releases need two reviewers."]);
    assert_eq!(b.live(), ["Releases need two reviewers."]);
    assert_eq!(a.value::<i64>("SELECT COUNT(*) FROM memories"), 2);

    purge(&a, &[survivor]);
    a.sync().await;
    b.sync().await;
    a.follow_all().await;
    assert_eq!(
        b.live(),
        ["Releases need two reviewers."],
        "B's memory holds the fact on B"
    );
    assert_eq!(a.live(), b.live(), "and on A");
}

/// A memory is on A and B. A writer on A files it under a folder path,
/// which no hub subject can name, so that change stays on A. Then the
/// person deletes the memory on A. Deletes are final everywhere: B, which
/// still holds the memory under the owner it was sent under, must delete it
/// too.
#[tokio::test]
async fn a_delete_of_a_memory_filed_where_no_subject_reaches_still_reaches_every_computer() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    let id = memory(&a, "pj-a", "Filed under a folder path, then deleted.");
    a.sync().await;
    b.sync().await;
    a.execute(&format!("UPDATE memories SET owner_id = '{FOLDER}'"));
    assert_eq!(a.replica.publish().await.unwrap().unaddressable, 1);
    purge(&a, &[id]);
    a.sync().await;
    b.follow_all().await;
    assert_eq!(
        b.value::<i64>("SELECT COUNT(*) FROM memories"),
        0,
        "B deletes the memory too"
    );
}

/// The same for a round's worth of memories: A holds [`super::BATCH`]
/// deletes, each waiting to be sent and none sendable. A person then writes
/// a new memory on A. It must still reach B: deletes that can never be sent
/// must not keep every later change from being sent.
#[tokio::test]
async fn deletes_that_can_never_be_sent_dont_stop_later_changes_from_being_sent() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    let ids: Vec<i64> = (0..super::BATCH)
        .map(|n| {
            memory(
                &a,
                "pj-a",
                &format!("Memory {n}, filed under a folder path, then deleted."),
            )
        })
        .collect();
    a.sync().await;
    a.execute(&format!("UPDATE memories SET owner_id = '{FOLDER}'"));
    assert_eq!(
        a.replica.publish().await.unwrap().unaddressable,
        super::BATCH
    );
    purge(&a, &ids);
    memory(&a, "pj-a", "Written after the deletes.");
    a.sync().await;
    b.sync().await;
    assert!(
        b.live().contains(&"Written after the deletes.".to_owned()),
        "the new memory reaches B"
    );
}
