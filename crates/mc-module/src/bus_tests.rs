//! The `docs_proposal` notice: its subject, headers and digest, and the
//! outbox rounds that publish it once and only while its proposal is
//! pending.

use std::sync::atomic::AtomicUsize;

use super::*;
use crate::docs_proposals::tests::proposed;
use crate::dreamer::tasks::maintain_docs::tests::PROJECT;

/// A publisher that records what it was given.
#[derive(Default)]
struct Recording {
    sent: Mutex<Vec<(String, String, ContentDigest, Headers)>>,
    fail: AtomicBool,
}

#[async_trait]
impl EventPublisher for Recording {
    async fn publish(
        &self,
        subject: &str,
        id: &str,
        digest: ContentDigest,
        headers: Headers,
    ) -> Result<PublishReceipt, String> {
        if self.fail.load(Ordering::Relaxed) {
            return Err("nats_publish_failed".into());
        }
        let mut sent = self.sent.lock().unwrap();
        sent.push((subject.into(), id.into(), digest, headers));
        Ok(PublishReceipt::new(sent.len() as u64, false))
    }
}

/// A publisher onto the in-memory bus, as JetStream takes a notice.
struct Memory(cortexkit_bus_inmemory::InMemoryBus);

#[async_trait]
impl EventPublisher for Memory {
    async fn publish(
        &self,
        subject: &str,
        id: &str,
        digest: ContentDigest,
        headers: Headers,
    ) -> Result<PublishReceipt, String> {
        Stream::publish(&self.0, subject, id, digest, headers)
            .await
            .map_err(|error| error.to_string())
    }
}

fn account() -> AccountNames {
    AccountNames::derive("box_test").unwrap()
}

#[test]
fn a_notice_carries_only_its_declared_headers() {
    let (fixture, id) = proposed();
    let proposal = fixture.proposal(id);
    let headers = notice_headers(&proposal).unwrap();
    assert_eq!(
        headers.keys().map(String::as_str).collect::<Vec<_>>(),
        crate::docs_proposals::EVENT_HEADERS
    );
    assert_eq!(headers["event_key"], format!("{PROJECT}:{id}"));
    assert_eq!(headers["project_id"], PROJECT);
}

#[test]
fn a_notice_names_the_event_and_carries_the_digest_events_get_serves() {
    let (fixture, id) = proposed();
    let proposal = fixture.proposal(id);
    let notice = notice(&account(), &proposal).unwrap();
    assert_eq!(
        notice.subject,
        "ck.box_test.event.magic-context.docs_proposal.v1"
    );
    assert_eq!(notice.id, format!("{PROJECT}:{id}"));
    let served = crate::docs_proposals::flow::handle(
        Some(&fixture.db),
        &json!({"method": "events_get", "params": {
            "event_key": notice.id, "event_name": "docs_proposal", "version": 1,
        }}),
    )
    .unwrap();
    assert_eq!(notice.digest.to_string(), served["result"]["digest"]);
    assert_eq!(
        notice.digest,
        ContentDigest::of_bytes(served["result"]["body"].as_str().unwrap().as_bytes())
    );
}

#[tokio::test]
async fn a_pending_proposal_is_published_once_and_marked() {
    let (fixture, id) = proposed();
    let publisher = Recording::default();
    assert_eq!(
        publish_pending(&fixture.db, &account(), &publisher)
            .await
            .unwrap(),
        1
    );
    let published_at = fixture.proposal(id).published_at;
    assert!(published_at.is_some());
    assert_eq!(
        publish_pending(&fixture.db, &account(), &publisher)
            .await
            .unwrap(),
        0,
        "a sent notice is not sent again"
    );
    let sent = publisher.sent.lock().unwrap();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].1, format!("{PROJECT}:{id}"));
    // events_get reports when it went out.
    let served = crate::docs_proposals::flow::events_get(
        Some(&fixture.db),
        &json!({"event_key": format!("{PROJECT}:{id}"), "event_name": "docs_proposal", "version": 1}),
    )
    .unwrap();
    assert_eq!(served["published_at"], json!(published_at));
}

#[tokio::test]
async fn the_in_memory_bus_takes_the_notice_and_a_retry_is_a_duplicate() {
    use cortexkit_bus_inmemory::{InMemoryBus, InMemoryConfig};
    let (fixture, id) = proposed();
    let bus = Memory(InMemoryBus::new(InMemoryConfig::default()));
    assert_eq!(
        publish_pending(&fixture.db, &account(), &bus)
            .await
            .unwrap(),
        1
    );
    // A notice sent again after a crash before its row was marked is the
    // same message to the bus.
    let notice = notice(&account(), &fixture.proposal(id)).unwrap();
    let receipt = bus
        .publish(&notice.subject, &notice.id, notice.digest, notice.headers)
        .await
        .unwrap();
    assert!(receipt.duplicate());
}

#[tokio::test]
async fn a_proposal_that_stopped_being_pending_is_never_sent() {
    let (fixture, id) = proposed();
    fixture
        .repo
        .write(&[("STRUCTURE.md", "# Structure\n\nChanged by hand.\n")]);
    let publisher = Recording::default();
    assert_eq!(
        publish_pending(&fixture.db, &account(), &publisher)
            .await
            .unwrap(),
        0
    );
    assert!(publisher.sent.lock().unwrap().is_empty());
    let proposal = fixture.proposal(id);
    assert_eq!(proposal.status, "stale");
    assert_eq!(proposal.published_at, None);
}

/// Sessions over a shared recording publisher, or none while `down`.
struct Sessions {
    publisher: Arc<Recording>,
    down: AtomicBool,
    opened: AtomicUsize,
}

struct Shared(Arc<Recording>);

#[async_trait]
impl EventPublisher for Shared {
    async fn publish(
        &self,
        subject: &str,
        id: &str,
        digest: ContentDigest,
        headers: Headers,
    ) -> Result<PublishReceipt, String> {
        self.0.publish(subject, id, digest, headers).await
    }
}

#[async_trait]
impl SessionFactory for Sessions {
    async fn open(&self) -> Result<BusSession, String> {
        if self.down.load(Ordering::Relaxed) {
            return Err("ckbus_refused".into());
        }
        self.opened.fetch_add(1, Ordering::Relaxed);
        Ok(BusSession::fixed(
            account(),
            Box::new(Shared(self.publisher.clone())),
        ))
    }

    async fn renew(&self, _session: &mut BusSession) -> Result<(), String> {
        Ok(())
    }
}

#[tokio::test]
async fn a_bus_that_is_down_leaves_the_row_unsent_until_a_later_round() {
    let (fixture, id) = proposed();
    let sessions = Arc::new(Sessions {
        publisher: Arc::new(Recording::default()),
        down: AtomicBool::new(true),
        opened: AtomicUsize::new(0),
    });
    let notices = DocsNotices::with_factory(sessions.clone());
    notices.publish(&fixture.db).await;
    notices.publish(&fixture.db).await;
    assert_eq!(fixture.proposal(id).published_at, None);
    assert!(notices.logged.load(Ordering::Relaxed), "logged once");
    sessions.down.store(false, Ordering::Relaxed);
    notices.publish(&fixture.db).await;
    assert!(fixture.proposal(id).published_at.is_some());
    assert!(!notices.logged.load(Ordering::Relaxed));
    // A failed publish drops the session; the next round opens another.
    sessions.publisher.fail.store(true, Ordering::Relaxed);
    let (second, _) = proposed();
    notices.publish(&second.db).await;
    sessions.publisher.fail.store(false, Ordering::Relaxed);
    notices.publish(&second.db).await;
    assert_eq!(sessions.opened.load(Ordering::Relaxed), 2);
    assert_eq!(sessions.publisher.sent.lock().unwrap().len(), 2);
}

#[test]
fn a_credential_never_shows_its_secrets() {
    let credential: Credential = serde_json::from_value(json!({
        "jwt": "secret-jwt-token",
        "exp": 4_102_444_800_i64,
        "acct": "box_test",
        "account_public": "APUBLIC",
        "inbox_prefix": "_INBOX",
        "server_url": "nats://127.0.0.1:4222",
        "credential_public": "UCREDENTIALPUBLICKEY",
        "user_jwt_id": "jti",
        "spawn_generation": 1,
        "credential_epoch": 1,
    }))
    .unwrap();
    let shown = format!("{credential:?}");
    assert!(!shown.contains("secret-jwt-token"), "{shown}");
    assert!(!shown.contains("UCREDENTIALPUBLICKEY"), "{shown}");
    assert!(shown.contains("box_test"));
}

#[test]
fn only_trusted_ckbus_refusal_codes_leave_the_module() {
    assert_eq!(
        credential_result(
            json!({"error": {"code": "ckbus_credential_revoked", "message": "jwt=abc"}})
        )
        .unwrap_err(),
        "ckbus_credential_revoked"
    );
    assert_eq!(
        credential_result(json!({"error": {"code": "jwt=abc"}})).unwrap_err(),
        "ckbus_refused"
    );
    assert_eq!(
        credential_result(json!({"result": {"a": 1}})).unwrap(),
        json!({"a": 1})
    );
}

/// One notice the test bus's stream took: subject, message id, digest,
/// headers, and whether the stream had it already.
pub(crate) type Sent = (String, String, ContentDigest, Headers, bool);

/// One event with a body the test bus's stream took: subject, headers, body,
/// and whether the stream had a message with its id already.
pub(crate) type SentPayload = (String, Headers, Vec<u8>, bool);

/// A bus for other modules' tests. Notices go to an in-memory stream and are
/// recorded as the bus took them; KV buckets are a second in-memory bus.
/// `down` refuses every session, as a bus that is down or a missing ck-bus
/// does.
pub(crate) struct TestBus {
    pub stream: cortexkit_bus_inmemory::InMemoryBus,
    pub kv: cortexkit_bus_inmemory::InMemoryBus,
    pub sent: Mutex<Vec<Sent>>,
    /// The events with a body the stream acknowledged, in order.
    pub payloads: Mutex<Vec<SentPayload>>,
    /// Fails every publish of an event with a body, as a stream that never
    /// acknowledges it.
    pub refuse_payloads: AtomicBool,
    pub down: AtomicBool,
    pub opened: AtomicUsize,
    /// The bucket names watches were opened on.
    pub watched: Mutex<Vec<String>>,
    /// Signalled to end every watch open now; `true` ends it with a panic.
    cut: tokio::sync::watch::Sender<bool>,
}

impl TestBus {
    pub(crate) fn new() -> Arc<Self> {
        use cortexkit_bus_inmemory::{InMemoryBus, InMemoryConfig};
        Arc::new(Self {
            stream: InMemoryBus::new(InMemoryConfig::default()),
            kv: InMemoryBus::new(InMemoryConfig::default()),
            sent: Mutex::new(Vec::new()),
            payloads: Mutex::new(Vec::new()),
            refuse_payloads: AtomicBool::new(false),
            down: AtomicBool::new(false),
            opened: AtomicUsize::new(0),
            watched: Mutex::new(Vec::new()),
            cut: tokio::sync::watch::channel(false).0,
        })
    }

    /// End every watch open now, as a lost connection does.
    pub(crate) fn cut_watches(&self) {
        self.cut.send_replace(false);
    }

    /// Unwind each watch from its next poll, as a bus client panic does.
    pub(crate) fn panic_watches(&self) {
        self.cut.send_replace(true);
    }

    /// The module's bus over this one.
    pub(crate) fn bus(self: &Arc<Self>) -> Arc<Bus> {
        Arc::new(Bus::with_factory(Arc::new(TestSessions(self.clone()))))
    }

    /// The notices the stream took, in order: message id and headers.
    pub(crate) fn notices(&self) -> Vec<(String, Headers)> {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .map(|(_, id, _, headers, _)| (id.clone(), headers.clone()))
            .collect()
    }
}

struct TestSessions(Arc<TestBus>);

struct TestPublisher(Arc<TestBus>);

#[async_trait]
impl EventPublisher for TestPublisher {
    async fn publish(
        &self,
        subject: &str,
        id: &str,
        digest: ContentDigest,
        headers: Headers,
    ) -> Result<PublishReceipt, String> {
        if self.0.down.load(Ordering::Relaxed) {
            return Err("nats_publish_failed".into());
        }
        let receipt = Stream::publish(&self.0.stream, subject, id, digest, headers.clone())
            .await
            .map_err(|error| error.to_string())?;
        self.0.sent.lock().unwrap().push((
            subject.into(),
            id.into(),
            digest,
            headers,
            receipt.duplicate(),
        ));
        Ok(receipt)
    }
}

struct TestRegisters(Arc<TestBus>);

/// Publishes events with a body to the test bus: refused while the bus is
/// down or refuses them, otherwise recorded, a repeated `Nats-Msg-Id`
/// reported as a duplicate the way JetStream reports it.
struct TestPayloads(Arc<TestBus>);

#[async_trait]
impl PayloadPublisher for TestPayloads {
    async fn publish(&self, subject: &str, headers: &Headers, body: &[u8]) -> Result<bool, String> {
        if self.0.down.load(Ordering::Relaxed) || self.0.refuse_payloads.load(Ordering::Relaxed) {
            return Err("nats_publish_unacknowledged".into());
        }
        let mut payloads = self.0.payloads.lock().unwrap();
        let id = headers.get("Nats-Msg-Id");
        let duplicate = payloads
            .iter()
            .any(|(_, sent, _, _)| sent.get("Nats-Msg-Id") == id);
        payloads.push((subject.into(), headers.clone(), body.to_vec(), duplicate));
        Ok(duplicate)
    }
}

#[async_trait]
impl Registers for TestRegisters {
    async fn watch(&self, bucket: &str, key: &str) -> Result<Box<dyn RegisterWatch>, String> {
        if self.0.down.load(Ordering::Relaxed) {
            return Err("nats_watch_failed".into());
        }
        self.0.watched.lock().unwrap().push(bucket.into());
        let watch = Register::watch(&self.0.kv, key)
            .await
            .map_err(|error| error.to_string())?;
        Ok(Box::new(TestWatch {
            watch,
            cut: self.0.cut.subscribe(),
        }))
    }
}

/// An in-memory watch that ends when the test bus cuts its watches.
struct TestWatch {
    watch: cortexkit_bus_inmemory::InMemoryRegisterWatch,
    cut: tokio::sync::watch::Receiver<bool>,
}

#[async_trait]
impl RegisterWatch for TestWatch {
    async fn next(&mut self) -> cortexkit_bus_trait::BusResult<cortexkit_bus_trait::WatchEvent> {
        tokio::select! {
            event = self.watch.next() => event,
            _ = self.cut.changed() => {
                assert!(!*self.cut.borrow_and_update(), "register watch panicked");
                Err(BusError::unavailable("register watch cut"))
            }
        }
    }

    fn has_snapshot(&self) -> bool {
        self.watch.has_snapshot()
    }
}

#[async_trait]
impl SessionFactory for TestSessions {
    async fn open(&self) -> Result<BusSession, String> {
        if self.0.down.load(Ordering::Relaxed) {
            return Err("ckbus_refused".into());
        }
        self.0.opened.fetch_add(1, Ordering::Relaxed);
        Ok(
            BusSession::fixed(account(), Box::new(TestPublisher(self.0.clone())))
                .with_registers(Box::new(TestRegisters(self.0.clone())))
                .with_payloads(Box::new(TestPayloads(self.0.clone()))),
        )
    }

    async fn renew(&self, _session: &mut BusSession) -> Result<(), String> {
        Ok(())
    }
}

/// ck-bus revokes a module's credential when it issues another, so every
/// user of the bus in the process goes through the one session.
#[tokio::test(start_paused = true)]
async fn every_user_of_the_bus_shares_one_session() {
    let test_bus = TestBus::new();
    let bus = test_bus.bus();
    // The run-end reader opens the session. A test's session has no NATS
    // connection, so binding stops there.
    let refused = run_ends::Durable::bind(&RunEndDurable { bus: bus.clone() })
        .await
        .err()
        .unwrap();
    assert_eq!(refused, "nats_connection_absent");
    // The memory wakes publish on it.
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap());
    let wakes = Arc::new(crate::memory_changed::MemoryWakes::default());
    let mut publisher = crate::memory_changed::publisher_for(&db, bus.clone(), &wakes);
    crate::memory_changed::tests::agent_save(&db, "pj-a", "Views are immutable.");
    assert_eq!(publisher.round(&db, wakes.take()).await.len(), 1);
    // The watch on Entorhinal's changes opens its watch on it.
    let state = Arc::new(crate::entorhinal_changes::WatchState::default());
    let follow = crate::entorhinal_changes::spawn_marker(
        bus.clone(),
        state,
        crate::entorhinal_changes::KEY,
        || {},
    );
    while test_bus.watched.lock().unwrap().is_empty() {
        tokio::task::yield_now().await;
    }
    drop(follow);
    // The docs notices publish on it.
    let (fixture, id) = proposed();
    DocsNotices::over(bus).publish(&fixture.db).await;
    assert!(fixture.proposal(id).published_at.is_some());
    assert_eq!(test_bus.opened.load(Ordering::Relaxed), 1);
}

/// The run-end reader forgets a session whose connection it lost, but never
/// one that got a new connection since it bound, which other users may
/// already be on.
#[tokio::test]
async fn a_lost_connection_forgets_only_the_session_it_was_on() {
    let test_bus = TestBus::new();
    let bus = test_bus.bus();
    drop(bus.session().await.unwrap());
    let first = bus.generation.load(Ordering::SeqCst);
    // Another user dropped the session and the next one opened a new one.
    bus.discard().await;
    drop(bus.session().await.unwrap());
    let second = bus.generation.load(Ordering::SeqCst);
    assert_ne!(first, second);
    bus.forget(first).await;
    drop(bus.session().await.unwrap());
    assert_eq!(test_bus.opened.load(Ordering::Relaxed), 2, "kept");
    bus.forget(second).await;
    drop(bus.session().await.unwrap());
    assert_eq!(test_bus.opened.load(Ordering::Relaxed), 3, "reopened");
}
