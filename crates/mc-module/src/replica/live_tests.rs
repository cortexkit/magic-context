//! The replica task ([`super::live`]): it waits while the hub is refused,
//! starts again from the stored position on each new connection, logs each
//! change of state once, and stops with the module. The hub is a stream
//! held in memory that delivers to its consumers as a server does.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::{watch, Notify};
use tokio::time::Instant;

use super::hub::{Ack, HubMessage};
use super::live::{
    retry_after, round_retry, Connect, Link, Live, Refusal, ReplicaTask, IDLE, RETRY_MAX,
};
use super::nats::{Delivered, Delivery, Fault, Following, HubStream, NatsHub, HEARTBEAT};
use super::test_support::{box_of, TestSealer, KEY};
use super::Replica;
use crate::context_db::ContextDb;

/// A stream held in memory.
struct Server {
    state: Mutex<ServerState>,
    /// The start of each consumer the task under test made, in order (the
    /// other computer's consumers are not counted).
    follows: Arc<Mutex<Vec<u64>>>,
    /// The newest stored sequence, which consumers wait on.
    stored: watch::Sender<u64>,
    /// Whether publishes are refused as a full stream's are.
    full: AtomicBool,
    publishes: AtomicUsize,
    closed: AtomicUsize,
}

#[derive(Default)]
struct ServerState {
    messages: Vec<HubMessage>,
    ids: HashMap<String, u64>,
}

impl Server {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::default(),
            follows: Arc::default(),
            stored: watch::channel(0).0,
            full: AtomicBool::new(false),
            publishes: AtomicUsize::new(0),
            closed: AtomicUsize::new(0),
        })
    }

    fn messages(&self) -> usize {
        self.state.lock().unwrap().messages.len()
    }

    fn follows(&self) -> Vec<u64> {
        self.follows.lock().unwrap().clone()
    }

    /// The stream as the task under test reaches it.
    fn stream(self: &Arc<Self>) -> Arc<dyn HubStream> {
        Arc::new(Stream(Arc::clone(self), Arc::clone(&self.follows)))
    }

    /// The stream as the other computer reaches it.
    fn other_stream(self: &Arc<Self>) -> Arc<dyn HubStream> {
        Arc::new(Stream(Arc::clone(self), Arc::default()))
    }
}

/// The stream, and where the consumers made on it are recorded.
struct Stream(Arc<Server>, Arc<Mutex<Vec<u64>>>);

#[async_trait]
impl HubStream for Stream {
    async fn publish(
        &self,
        subject: &str,
        message_id: &str,
        payload: Vec<u8>,
    ) -> Result<Ack, Fault> {
        self.0.publishes.fetch_add(1, Ordering::SeqCst);
        let mut state = self.0.state.lock().unwrap();
        if let Some(seq) = state.ids.get(message_id) {
            return Ok(Ack {
                seq: *seq,
                duplicate: true,
            });
        }
        if self.0.full.load(Ordering::SeqCst) {
            return Err(Fault::Full("maximum bytes exceeded".into()));
        }
        let seq = state.messages.len() as u64 + 1;
        state.messages.push(HubMessage {
            seq,
            subject: subject.to_owned(),
            message_id: Some(message_id.to_owned()),
            payload,
        });
        state.ids.insert(message_id.to_owned(), seq);
        drop(state);
        self.0.stored.send_replace(seq);
        Ok(Ack {
            seq,
            duplicate: false,
        })
    }

    async fn last_seq(&self) -> Result<u64, Fault> {
        Ok(self.0.messages() as u64)
    }

    async fn follow(&self, start: u64) -> Result<Following, Fault> {
        self.1.lock().unwrap().push(start);
        let state = self.0.state.lock().unwrap();
        let pending = state.messages.iter().filter(|m| m.seq >= start).count() as u64;
        Ok(Following {
            pending,
            delivery: Box::new(Consumer {
                server: Arc::clone(&self.0),
                stored: self.0.stored.subscribe(),
                next_seq: start,
                consumer_seq: 0,
                quiet_since: Instant::now(),
            }),
        })
    }
}

/// A consumer of [`Server`]: every message from its start on, then a
/// heartbeat each [`HEARTBEAT`] it has nothing to send.
struct Consumer {
    server: Arc<Server>,
    stored: watch::Receiver<u64>,
    next_seq: u64,
    consumer_seq: u64,
    quiet_since: Instant,
}

impl Consumer {
    fn take(&mut self) -> Option<Delivered> {
        let state = self.server.state.lock().unwrap();
        let message = state
            .messages
            .iter()
            .find(|m| m.seq >= self.next_seq)?
            .clone();
        self.next_seq = message.seq + 1;
        self.consumer_seq += 1;
        self.quiet_since = Instant::now();
        let pending = state
            .messages
            .iter()
            .filter(|m| m.seq >= self.next_seq)
            .count() as u64;
        Some(Delivered::Message {
            message,
            consumer_seq: self.consumer_seq,
            pending,
        })
    }
}

#[async_trait]
impl Delivery for Consumer {
    async fn next(&mut self, wait: Duration) -> Result<Option<Delivered>, Fault> {
        let deadline = Instant::now() + wait;
        loop {
            if let Some(delivered) = self.take() {
                return Ok(Some(delivered));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            let beat = self.quiet_since + HEARTBEAT;
            tokio::select! {
                _ = self.stored.changed() => {}
                () = tokio::time::sleep_until(deadline.min(beat)) => {
                    if Instant::now() >= beat {
                        self.quiet_since = Instant::now();
                        return Ok(Some(Delivered::Heartbeat {
                            last_consumer_seq: Some(self.consumer_seq),
                            flow_control: None,
                        }));
                    }
                }
            }
        }
    }

    async fn answer(&mut self, _subject: &str) -> Result<(), Fault> {
        Ok(())
    }

    async fn close(self: Box<Self>) {
        self.server.closed.fetch_add(1, Ordering::SeqCst);
    }
}

/// One connection handed out, which a test can replace or close.
struct LinkState {
    changes: Mutex<Option<watch::Sender<u64>>>,
    refused: Mutex<Option<Refusal>>,
}

impl LinkState {
    /// The bus client replaced the connection.
    fn replace(&self) {
        if let Some(changes) = self.changes.lock().unwrap().as_ref() {
            changes.send_modify(|count| *count += 1);
        }
    }

    /// The connection's credential maintenance stopped after `refusal`.
    fn close(&self, refusal: Refusal) {
        *self.refused.lock().unwrap() = Some(refusal);
        self.changes.lock().unwrap().take();
    }
}

struct FakeLink {
    state: Arc<LinkState>,
    changes: watch::Receiver<u64>,
    server: Arc<Server>,
}

impl Link for FakeLink {
    fn stream(&self) -> Result<Arc<dyn HubStream>, Refusal> {
        match self.state.refused.lock().unwrap().clone() {
            Some(refusal) => Err(refusal),
            None => Ok(self.server.stream()),
        }
    }

    fn changes(&self) -> watch::Receiver<u64> {
        self.changes.clone()
    }
}

/// ck-bus as a script: the refusals to answer first, then connections.
struct Fake {
    server: Arc<Server>,
    refusals: Mutex<VecDeque<Refusal>>,
    /// When each ask came, and how many messages the stream held then.
    asked: Mutex<Vec<(Instant, usize)>>,
    links: Mutex<Vec<Arc<LinkState>>>,
}

impl Fake {
    fn new(server: &Arc<Server>, refusals: Vec<Refusal>) -> Arc<Self> {
        Arc::new(Self {
            server: Arc::clone(server),
            refusals: Mutex::new(refusals.into()),
            asked: Mutex::default(),
            links: Mutex::default(),
        })
    }

    fn asks(&self) -> usize {
        self.asked.lock().unwrap().len()
    }

    /// The time between one ask and the next.
    fn gaps(&self) -> Vec<Duration> {
        let asked = self.asked.lock().unwrap();
        asked.windows(2).map(|pair| pair[1].0 - pair[0].0).collect()
    }

    fn link(&self, n: usize) -> Arc<LinkState> {
        Arc::clone(&self.links.lock().unwrap()[n])
    }
}

#[async_trait]
impl Connect for Fake {
    async fn box_id(&self) -> Result<String, String> {
        Ok(box_of(1))
    }

    async fn connect(&self) -> Result<Box<dyn Link>, Refusal> {
        self.asked
            .lock()
            .unwrap()
            .push((Instant::now(), self.server.messages()));
        if let Some(refusal) = self.refusals.lock().unwrap().pop_front() {
            return Err(refusal);
        }
        let (changes, receiver) = watch::channel(0);
        let state = Arc::new(LinkState {
            changes: Mutex::new(Some(changes)),
            refused: Mutex::new(None),
        });
        self.links.lock().unwrap().push(Arc::clone(&state));
        Ok(Box::new(FakeLink {
            state,
            changes: receiver,
            server: Arc::clone(&self.server),
        }))
    }
}

fn store() -> (Arc<ContextDb>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap());
    (db, dir)
}

/// Write a project memory of `pj-a` as a writer outside the engine would.
fn remember(db: &ContextDb, content: &str) {
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO memories (level, owner_id, category, origin_category, content,
                 normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES ('project', 'pj-a', 'swe:architecture', 'ARCHITECTURE', ?1, ?2, 1, 1, 1, 1)",
            rusqlite::params![content, crate::memory_writes::normalized_hash(content)],
        )
        .unwrap()
    });
}

fn memories(db: &ContextDb) -> i64 {
    db.with_connection(|conn| {
        conn.query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))
            .unwrap()
    })
}

fn outbox(db: &ContextDb) -> Vec<String> {
    db.with_connection(|conn| {
        conn.prepare("SELECT state FROM replica_outbox ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    })
}

/// Whether every outbox row was sent: published, or settled and gone
/// once the stream delivered it back.
fn sent(db: &ContextDb) -> bool {
    outbox(db).iter().all(|state| state == "published")
}

/// Wait, in the test's paused time, until `what` holds.
async fn until(what: impl Fn() -> bool) {
    let start = Instant::now();
    while !what() {
        assert!(
            start.elapsed() < Duration::from_secs(3600),
            "never happened"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn start(fake: &Arc<Fake>, db: &Arc<ContextDb>, wake: &Arc<Notify>) -> ReplicaTask {
    ReplicaTask::spawn(Live {
        connect: Arc::clone(fake) as Arc<dyn Connect>,
        db: Arc::clone(db),
        sealer: TestSealer::new(KEY, 1),
        wake: Arc::clone(wake),
    })
}

/// Another computer on the same stream, publishing through the hub
/// without a task of its own.
async fn other_computer_shares(server: &Arc<Server>, db: &Arc<ContextDb>) {
    let replica = Replica::new(
        Arc::clone(db),
        Arc::new(NatsHub::new(server.other_stream())),
        TestSealer::new(KEY, 1),
        box_of(2),
    );
    while replica.round().await.unwrap() > 0 {}
}

#[test]
fn the_hub_is_asked_again_after_five_seconds_doubling_to_five_minutes() {
    let seconds = |refusal: &Refusal| {
        (0..8)
            .map(|attempt| retry_after(refusal, attempt).as_secs())
            .collect::<Vec<_>>()
    };
    for refusal in [
        Refusal::Unavailable,
        Refusal::Failed("timed out".into()),
        Refusal::NoBox("no bus".into()),
    ] {
        assert_eq!(seconds(&refusal), [5, 10, 20, 40, 80, 160, 300, 300]);
    }
    assert_eq!(seconds(&Refusal::NotGranted), [300; 8]);
    assert_eq!(
        (1..8).map(|n| round_retry(n).as_secs()).collect::<Vec<_>>(),
        [2, 4, 8, 16, 32, 60, 60]
    );
}

#[tokio::test(start_paused = true)]
async fn while_the_hub_is_unavailable_nothing_is_sent_and_the_wait_is_logged_once() {
    let log = crate::test_log::capture();
    let server = Server::new();
    let fake = Fake::new(&server, vec![Refusal::Unavailable; 4]);
    let (db, _dir) = store();
    remember(&db, "Tabs, not spaces.");
    let task = start(&fake, &db, &Arc::new(Notify::new()));
    until(|| fake.asks() == 5).await;
    assert_eq!(
        fake.gaps(),
        [5, 10, 20, 40].map(Duration::from_secs),
        "five seconds, doubling"
    );
    assert!(
        fake.asked
            .lock()
            .unwrap()
            .iter()
            .all(|(_, stored)| *stored == 0),
        "nothing was sent before the hub was there"
    );
    until(|| server.messages() == 1).await;
    task.stop().await;
    assert!(sent(&db), "{:?}", outbox(&db));
    assert_eq!(log.count("the hub is not available"), 1, "{}", log.text());
    assert_eq!(log.count("connected to the hub"), 1, "{}", log.text());
}

#[tokio::test(start_paused = true)]
async fn a_refused_grant_is_asked_about_every_five_minutes_and_stopping_does_not_wait_for_it() {
    let log = crate::test_log::capture();
    let server = Server::new();
    let fake = Fake::new(&server, vec![Refusal::NotGranted; 3]);
    let (db, _dir) = store();
    remember(&db, "Tabs, not spaces.");
    let task = start(&fake, &db, &Arc::new(Notify::new()));
    until(|| fake.asks() == 3).await;
    assert_eq!(fake.gaps(), [RETRY_MAX, RETRY_MAX]);
    let stopping = Instant::now();
    task.stop().await;
    assert!(stopping.elapsed() < Duration::from_secs(1));
    tokio::time::sleep(RETRY_MAX * 2).await;
    assert_eq!(fake.asks(), 3, "a stopped task asks no more");
    assert_eq!(server.messages(), 0);
    assert_eq!(outbox(&db), ["pending"]);
    assert_eq!(
        log.count("does not grant magic-context the hub"),
        1,
        "{}",
        log.text()
    );
}

#[tokio::test(start_paused = true)]
async fn a_new_connection_reads_on_from_the_stored_position() {
    let server = Server::new();
    let (b, _b_dir) = store();
    for content in ["One.", "Two.", "Three."] {
        remember(&b, content);
    }
    other_computer_shares(&server, &b).await;
    assert_eq!(server.messages(), 3);
    let fake = Fake::new(&server, Vec::new());
    let (a, _a_dir) = store();
    let task = start(&fake, &a, &Arc::new(Notify::new()));
    until(|| memories(&a) == 3).await;
    assert_eq!(server.follows(), [1]);
    fake.link(0).replace();
    until(|| server.follows().len() == 2).await;
    assert_eq!(server.follows(), [1, 4], "the new consumer starts after 3");
    remember(&b, "Four.");
    other_computer_shares(&server, &b).await;
    until(|| memories(&a) == 4).await;
    task.stop().await;
    assert_eq!(server.follows(), [1, 4]);
    assert_eq!(memories(&a), 4, "nothing applied twice");
    assert_eq!(fake.asks(), 1, "a replaced connection needs no new ask");
    assert_eq!(server.closed.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn when_the_connections_maintenance_stops_the_hub_is_asked_for_again() {
    let log = crate::test_log::capture();
    let server = Server::new();
    let fake = Fake::new(&server, Vec::new());
    let (db, _dir) = store();
    let task = start(&fake, &db, &Arc::new(Notify::new()));
    until(|| server.follows().len() == 1).await;
    let closed = Instant::now();
    fake.link(0).close(Refusal::Unavailable);
    until(|| server.follows().len() == 2).await;
    task.stop().await;
    assert_eq!(fake.asks(), 2);
    assert_eq!(
        fake.asked.lock().unwrap()[1].0 - closed,
        Duration::from_secs(5)
    );
    assert_eq!(log.count("the hub is not available"), 1, "{}", log.text());
    assert_eq!(log.count("connected to the hub"), 2, "{}", log.text());
}

#[tokio::test(start_paused = true)]
async fn a_memory_change_here_starts_the_next_round_at_once() {
    let server = Server::new();
    let fake = Fake::new(&server, Vec::new());
    let (db, _dir) = store();
    let wake = Arc::new(Notify::new());
    db.wake_replica_on_memory_changes(Arc::clone(&wake));
    let task = start(&fake, &db, &wake);
    until(|| server.follows().len() == 1).await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let written = Instant::now();
    remember(&db, "Tabs, not spaces.");
    db.changed(crate::app_read::Change::project_memories("pj-a"));
    until(|| server.messages() == 1).await;
    assert!(written.elapsed() < IDLE / 10, "{:?}", written.elapsed());
    task.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_full_stream_is_logged_once_and_its_end_once() {
    let log = crate::test_log::capture();
    let server = Server::new();
    server.full.store(true, Ordering::SeqCst);
    let fake = Fake::new(&server, Vec::new());
    let (db, _dir) = store();
    remember(&db, "Tabs, not spaces.");
    let task = start(&fake, &db, &Arc::new(Notify::new()));
    until(|| server.publishes.load(Ordering::SeqCst) >= 5).await;
    assert_eq!(outbox(&db), ["sending"], "the row waits");
    assert_eq!(server.messages(), 0);
    server.full.store(false, Ordering::SeqCst);
    until(|| server.messages() == 1).await;
    until(|| sent(&db)).await;
    task.stop().await;
    assert_eq!(log.count(super::nats::STREAM_FULL), 1, "{}", log.text());
    assert_eq!(log.count("rounds succeed again"), 1, "{}", log.text());
}

#[tokio::test(start_paused = true)]
async fn stopping_ends_the_task_and_removes_the_consumer() {
    let server = Server::new();
    let fake = Fake::new(&server, Vec::new());
    let (db, _dir) = store();
    let task = start(&fake, &db, &Arc::new(Notify::new()));
    until(|| server.follows().len() == 1).await;
    let stopping = Instant::now();
    task.stop().await;
    assert!(stopping.elapsed() < Duration::from_secs(1));
    assert_eq!(server.closed.load(Ordering::SeqCst), 1);
    tokio::time::sleep(IDLE * 10).await;
    assert_eq!(server.follows(), [1], "a stopped task reads no more");
    assert_eq!(fake.asks(), 1);
}
