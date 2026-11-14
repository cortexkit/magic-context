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
