//! Decoding run-end events, matching them to waits, acknowledging each one,
//! and the poll interval the reader's state sets.

use std::sync::atomic::AtomicUsize;

use cortexkit_role_llm_runner::SessionIdentity;
use serde::Deserialize;
use tokio::sync::mpsc;

use super::*;

/// A real THALAMUS `event.thalamus-harness.turn_ended.v1` body, from one of
/// ck-mc's summary children. The bus carries only its digest; it is here
/// for that digest and to show what the headers stand for.
const THALAMUS_TURN_ENDED_BODY: &str = r#"{"session_ref":"eb8bf929f6705f1c7fa2a5851f23b690","scope":{"owner":"reserved:magic-context","ref":"mc-child-project-…","epoch":1},"harness":"opencode2","seq":49152,"at_ms":1794787713711,"turn_id":"65e146a9823e8db4fc73bd8fc2666840","quality":"strong","source":"protocol_event","outcome":"completed","ended_at_ms":1794787713711}"#;

/// That event as the reader gets it: THALAMUS's headers on an empty payload.
fn thalamus_turn_ended() -> Delivery {
    let session_ref = "eb8bf929f6705f1c7fa2a5851f23b690";
    Delivery {
        id: Some(format!("{session_ref}:turn_ended:49152")),
        subject: "ck.box_test.event.thalamus-harness.turn_ended.v1".into(),
        headers: Headers::from([
            (
                "Nats-Msg-Id".to_owned(),
                format!("{session_ref}:turn_ended:49152"),
            ),
            (
                "Ck-Content-Digest".to_owned(),
                cortexkit_bus_trait::ContentDigest::of_bytes(THALAMUS_TURN_ENDED_BODY.as_bytes())
                    .to_string(),
            ),
            (SESSION_REF_HEADER.to_owned(), session_ref.to_owned()),
        ]),
    }
}

/// What one pull of a [`Feed`] gives the reader.
pub(crate) enum Pull {
    /// A pull that found no event.
    Empty,
    Event(Delivery),
    /// The pull failed, which ends the binding.
    Fail(String),
}

/// A durable whose pulls the test sends, and that records each
/// acknowledgement. It binds once; every later bind finds no durable.
pub(crate) struct Feed {
    pulls: Mutex<Option<mpsc::UnboundedReceiver<Pull>>>,
    /// The id of each acknowledged event, in order.
    pub(crate) acked: Arc<Mutex<Vec<Option<String>>>>,
    /// Notified after each acknowledgement.
    pub(crate) ack: Arc<Notify>,
    pub(crate) binds: AtomicUsize,
}

impl Feed {
    pub(crate) fn new() -> (Arc<Self>, mpsc::UnboundedSender<Pull>) {
        let (send, pulls) = mpsc::unbounded_channel();
        let feed = Self {
            pulls: Mutex::new(Some(pulls)),
            acked: Arc::default(),
            ack: Arc::default(),
            binds: AtomicUsize::new(0),
        };
        (Arc::new(feed), send)
    }

    /// A durable that was never provisioned: every bind fails.
    fn missing() -> Arc<Self> {
        let (feed, _) = Self::new();
        lock(&feed.pulls).take();
        feed
    }

    pub(crate) fn acked(&self) -> Vec<Option<String>> {
        lock(&self.acked).clone()
    }
}

#[async_trait]
impl Durable for Feed {
    async fn bind(&self) -> Result<Box<dyn Cursor>, String> {
        self.binds.fetch_add(1, Ordering::SeqCst);
        let pulls = lock(&self.pulls)
            .take()
            .ok_or("the durable is not provisioned")?;
        Ok(Box::new(FeedCursor {
            pulls,
            acked: self.acked.clone(),
            ack: self.ack.clone(),
            in_flight: None,
        }))
    }
}

struct FeedCursor {
    pulls: mpsc::UnboundedReceiver<Pull>,
    acked: Arc<Mutex<Vec<Option<String>>>>,
    ack: Arc<Notify>,
    in_flight: Option<Option<String>>,
}

#[async_trait]
impl Cursor for FeedCursor {
    async fn next(&mut self) -> Result<Option<Delivery>, String> {
        assert!(self.in_flight.is_none(), "the last event was acknowledged");
        match self.pulls.recv().await {
            Some(Pull::Empty) => Ok(None),
            Some(Pull::Event(delivery)) => {
                self.in_flight = Some(delivery.id.clone());
                Ok(Some(delivery))
            }
            Some(Pull::Fail(reason)) => Err(reason),
            None => Err("the feed ended".into()),
        }
    }

    async fn ack(&mut self) -> Result<(), String> {
        let id = self.in_flight.take().expect("an event to acknowledge");
        lock(&self.acked).push(id);
        self.ack.notify_one();
        Ok(())
    }
}

/// The run-end event of `session`'s run, as Broca publishes it, under the
/// bus id `id`.
pub(crate) fn ended(id: &str, session: &SessionRef) -> Pull {
    Pull::Event(Delivery {
        id: Some(id.into()),
        subject: "ck.box_test.event.broca.run.ended.v1".into(),
        headers: Headers::from([
            ("Nats-Msg-Id".to_owned(), id.to_owned()),
            ("kind".to_owned(), "run.ended".to_owned()),
            (
                SESSION_REF_HEADER.to_owned(),
                crate::agent_data::source::session_ref(session),
            ),
        ]),
    })
}

fn broca_child() -> SessionRef {
    SessionRef::new("broca", "broca", "mc-dream:run-1:0:0")
}

#[test]
fn both_runners_events_name_their_session_in_a_header() {
    assert_eq!(
        session_ref_of(&thalamus_turn_ended().headers),
        Some("eb8bf929f6705f1c7fa2a5851f23b690")
    );
    // A turn of a session nobody waits on is handled and wakes nobody.
    assert_eq!(
        handle(&RunEnds::new(), &thalamus_turn_ended()),
        Outcome::Ended(Woke::Nobody)
    );
    assert_eq!(
        session_ref_of(&broca_sample("03-run.ended.json").headers),
        Some(BROCA_STORE_SESSION_REF)
    );
}

#[test]
fn headers_without_a_session_ref_decode_to_none() {
    for headers in [
        Headers::new(),
        Headers::from([("Nats-Msg-Id".to_owned(), "id".to_owned())]),
        Headers::from([(SESSION_REF_HEADER.to_owned(), String::new())]),
        Headers::from([("session-ref".to_owned(), "abc".to_owned())]),
    ] {
        assert_eq!(session_ref_of(&headers), None, "{headers:?}");
    }
    // Header names are matched without regard to case.
    let headers = Headers::from([("Session_Ref".to_owned(), "abc".to_owned())]);
    assert_eq!(session_ref_of(&headers), Some("abc"));
}

#[test]
fn a_wait_is_found_by_the_runners_session_ref_of_its_child() {
    let ends = RunEnds::new();
    let broca = broca_child();
    let thalamus = SessionRef::new("thalamus-harness", "opencode2", "parent:mc-summary:0");
    let _broca = ends.watch(&broca);
    let _thalamus = ends.watch(&thalamus);
    // The runners hash the runner, the harness and the session ck-mc named.
    for (index, child) in [broca, thalamus].iter().enumerate() {
        let session_ref = cortexkit_role_llm_runner::session_ref(&SessionIdentity {
            runner: &child.runner,
            harness: &child.harness,
            session: &child.session,
        });
        assert_eq!(
            ends.wake(Some(&format!("event-{index}")), &session_ref),
            Woke::Waits(1)
        );
    }
}

#[test]
fn an_event_wakes_only_the_waits_on_its_session_and_only_once() {
    let ends = RunEnds::new();
    let child = broca_child();
    let session_ref = crate::agent_data::source::session_ref(&child);
    let watch = ends.watch(&child);
    let second = ends.watch(&child);
    assert_eq!(ends.wake(Some("a"), &session_ref), Woke::Waits(2));
    // Redelivered under the same id.
    assert_eq!(ends.wake(Some("a"), &session_ref), Woke::Again);
    assert_eq!(
        ends.wake(Some("b"), "0123456789abcdef0123456789abcdef"),
        Woke::Nobody
    );
    drop(second);
    assert_eq!(ends.wake(Some("c"), &session_ref), Woke::Waits(1));
    drop(watch);
    assert_eq!(ends.wake(Some("d"), &session_ref), Woke::Nobody);
    // An event without an id can't be told from a redelivery, so each one
    // is handled.
    let _watch = ends.watch(&child);
    assert_eq!(ends.wake(None, &session_ref), Woke::Waits(1));
    assert_eq!(ends.wake(None, &session_ref), Woke::Waits(1));
}

#[test]
fn handled_ids_are_remembered_up_to_a_bound() {
    let ends = RunEnds::new();
    for id in 0..=REMEMBERED {
        assert_eq!(ends.wake(Some(&id.to_string()), "ref"), Woke::Nobody);
    }
    // The oldest id was forgotten to make room; the newest is still known.
    assert_eq!(ends.wake(Some("0"), "ref"), Woke::Nobody);
    assert_eq!(ends.wake(Some(&REMEMBERED.to_string()), "ref"), Woke::Again);
}

#[tokio::test(start_paused = true)]
async fn every_event_is_acknowledged_once_handled_and_an_unnamed_one_stops_nothing() {
    let mut log = crate::test_log::capture();
    let ends = Arc::new(RunEnds::new());
    let child = broca_child();
    let watch = ends.watch(&child);
    let (feed, pulls) = Feed::new();
    let reader = tokio::spawn({
        let (ends, feed) = (ends.clone(), feed.clone());
        async move { read_bound(&ends, feed.as_ref()).await }
    });
    // A run-end event without a `session_ref` header.
    let unnamed = |id: &str| {
        Pull::Event(Delivery {
            id: Some(id.into()),
            subject: "ck.box_test.event.broca.run.ended.v1".into(),
            headers: Headers::from([("Nats-Msg-Id".to_owned(), id.to_owned())]),
        })
    };
    pulls.send(ended("mine", &child)).unwrap();
    pulls
        .send(ended(
            "other",
            &SessionRef::new("broca", "broca", "mc-dream:other:0:0"),
        ))
        .unwrap();
    pulls.send(unnamed("unnamed-1")).unwrap();
    pulls.send(unnamed("unnamed-2")).unwrap();
    pulls.send(ended("mine", &child)).unwrap();
    pulls.send(Pull::Fail("nats_pull_failed".into())).unwrap();
    assert_eq!(reader.await.unwrap(), "nats_pull_failed");
    assert_eq!(
        feed.acked(),
        ["mine", "other", "unnamed-1", "unnamed-2", "mine"].map(|id| Some(id.to_owned()))
    );
    log.stop();
    assert_eq!(log.count("has no session_ref header"), 1, "logged once");
    // The redelivered event found its id handled already.
    assert_eq!(ends.wake(Some("mine"), "any"), Woke::Again);
    // The first one woke the wait: its pause ends without sleeping.
    let start = tokio::time::Instant::now();
    watch.pause(start + Duration::from_secs(60)).await;
    assert_eq!(tokio::time::Instant::now(), start);
}

#[tokio::test(start_paused = true)]
async fn waits_poll_fast_until_the_reader_has_read_and_again_once_it_stops() {
    let mut log = crate::test_log::capture();
    let ends = Arc::new(RunEnds::new());
    assert_eq!(ends.poll_interval(), FAST_POLL);
    let (feed, pulls) = Feed::new();
    let reader = tokio::spawn({
        let (ends, feed) = (ends.clone(), feed.clone());
        async move { read_bound(&ends, feed.as_ref()).await }
    });
    tokio::task::yield_now().await;
    // Bound, but nothing read yet: a poll relaxes only after its reader ran.
    assert_eq!(feed.binds.load(Ordering::SeqCst), 1);
    assert_eq!(ends.poll_interval(), FAST_POLL);
    pulls.send(Pull::Empty).unwrap();
    pulls.send(Pull::Empty).unwrap();
    pulls.send(ended("e", &broca_child())).unwrap();
    feed.ack.notified().await;
    assert_eq!(ends.poll_interval(), BACKSTOP_POLL);
    pulls.send(Pull::Fail("nats_pull_failed".into())).unwrap();
    let reason = reader.await.unwrap();
    ends.stopped(&reason);
    assert_eq!(ends.poll_interval(), FAST_POLL);
    log.stop();
    assert_eq!(
        log.count("ck-mc: run ends: reading m_magic-context_runs"),
        1
    );
    assert_eq!(
        log.count("ck-mc: run ends: not reading m_magic-context_runs (nats_pull_failed)"),
        1
    );
}

#[tokio::test(start_paused = true)]
async fn a_missing_durable_is_logged_once_and_leaves_the_fast_poll() {
    let mut log = crate::test_log::capture();
    let ends = Arc::new(RunEnds::new());
    let feed = Feed::missing();
    let reader = tokio::spawn(read(ends.clone(), feed.clone()));
    tokio::time::sleep(RETRY * 3 + RETRY / 2).await;
    reader.abort();
    assert_eq!(
        feed.binds.load(Ordering::SeqCst),
        4,
        "it binds again each RETRY"
    );
    assert_eq!(ends.poll_interval(), FAST_POLL);
    log.stop();
    assert_eq!(
        log.count(
            "ck-mc: run ends: not reading m_magic-context_runs (the durable is not provisioned)"
        ),
        1
    );
    assert_eq!(log.count("ck-mc: run ends: not reading"), 1);
    assert_eq!(log.count("ck-mc: run ends: reading"), 0);
}

/// The naming crate's consumer table decides which subjects the durable
/// carries. Once the pinned `cortexkit-bus-naming` release lists the durable
/// in that table, it must list exactly the subjects this module expects.
/// Until a release that adds it is pinned, the table has no entry to compare,
/// and the test checks nothing.
#[test]
fn the_durable_matches_the_naming_table_once_the_table_lists_it() {
    let Some(entry) = cortexkit_bus_naming::EVENT_CONSUMERS
        .iter()
        .find(|entry| entry.durable == DURABLE)
    else {
        return;
    };
    assert_eq!(entry.module_id, crate::MODULE_ID);
    let mut listed = entry.filter_subjects.to_vec();
    listed.sort_unstable();
    let mut expected = SUBJECTS.to_vec();
    expected.sort_unstable();
    assert_eq!(listed, expected);
}

/// Broca's run events from sessions in its new storage, as its publisher
/// sends them, copied byte for byte with their checksums.
const BROCA_STORE_SAMPLES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/testdata/broca-run-events-store-1116"
);
/// The session all five samples name: runner `broca`, harness
/// `store-actor`, session `s1`.
const BROCA_STORE_SESSION_REF: &str = "32db1a5342168526c10b5dedf01c1760";

/// One sample publication: its subject, `Nats-Msg-Id`, headers, and the
/// body Broca serves on request, which the bus never carries.
#[derive(Deserialize)]
struct Publication {
    subject: String,
    nats_msg_id: String,
    headers: Headers,
    body: String,
}

fn broca_publication(name: &str) -> Publication {
    let text = std::fs::read(format!("{BROCA_STORE_SAMPLES}/{name}")).unwrap();
    serde_json::from_slice(&text).unwrap()
}

/// The sample `name` as the reader gets it from the durable: its id,
/// subject and headers, without a payload.
fn broca_sample(name: &str) -> Delivery {
    let publication = broca_publication(name);
    Delivery {
        id: Some(publication.nats_msg_id),
        subject: publication.subject,
        headers: publication.headers,
    }
}

#[test]
fn the_broca_samples_are_the_bytes_broca_published() {
    use sha2::{Digest, Sha256};
    let sums = std::fs::read_to_string(format!("{BROCA_STORE_SAMPLES}/SHA256SUMS")).unwrap();
    let mut checked = 0;
    for line in sums.lines() {
        let (sum, name) = line.split_once("  ").unwrap();
        let bytes = std::fs::read(format!("{BROCA_STORE_SAMPLES}/{name}")).unwrap();
        let actual: String = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(actual, sum, "{name}");
        checked += 1;
    }
    assert_eq!(checked, 6);
}

#[test]
fn broca_new_storage_run_ended_sample_wakes_the_wait_on_its_session() {
    let ends = RunEnds::new();
    let child = SessionRef::new("broca", "store-actor", "s1");
    assert_eq!(
        crate::agent_data::source::session_ref(&child),
        BROCA_STORE_SESSION_REF
    );
    let _watch = ends.watch(&child);
    let ended = broca_sample("03-run.ended.json");
    assert_eq!(
        session_ref_of(&ended.headers),
        Some(BROCA_STORE_SESSION_REF)
    );
    assert_eq!(handle(&ends, &ended), Outcome::Ended(Woke::Waits(1)));
    // The same publication again is a redelivery.
    assert_eq!(handle(&ends, &ended), Outcome::Ended(Woke::Again));
}

#[test]
fn the_session_comes_from_the_header_never_the_body() {
    let ends = RunEnds::new();
    let _watch = ends.watch(&SessionRef::new("broca", "store-actor", "s1"));
    let publication = broca_publication("03-run.ended.json");
    // The body Broca serves names the session too, but the bus doesn't
    // carry it: without the header, the event names no session.
    assert!(publication.body.contains(BROCA_STORE_SESSION_REF));
    let mut ended = broca_sample("03-run.ended.json");
    ended.headers.remove(SESSION_REF_HEADER);
    assert_eq!(handle(&ends, &ended), Outcome::NoSession);
}

#[test]
fn broca_samples_of_its_other_run_events_wake_nothing() {
    let ends = RunEnds::new();
    let _watch = ends.watch(&SessionRef::new("broca", "store-actor", "s1"));
    for name in [
        "01-run.started.json",
        "02-run.steer_consumed.json",
        "04-run.started.json",
        "05-run.paused.json",
    ] {
        let event = broca_sample(name);
        // They name the waited-on session, yet are not a run's end.
        assert_eq!(
            session_ref_of(&event.headers),
            Some(BROCA_STORE_SESSION_REF)
        );
        let relative = event.subject.splitn(3, '.').nth(2).unwrap();
        assert!(!SUBJECTS.contains(&relative), "{name}");
        assert_eq!(handle(&ends, &event), Outcome::NotARunEnd, "{name}");
    }
}

#[tokio::test(start_paused = true)]
async fn the_reader_acknowledges_every_broca_sample_and_wakes_the_wait_once() {
    let ends = Arc::new(RunEnds::new());
    let watch = ends.watch(&SessionRef::new("broca", "store-actor", "s1"));
    let (feed, pulls) = Feed::new();
    let names = [
        "01-run.started.json",
        "02-run.steer_consumed.json",
        "03-run.ended.json",
        "04-run.started.json",
        "05-run.paused.json",
    ];
    let mut ids = Vec::new();
    for name in names {
        let event = broca_sample(name);
        ids.push(event.id.clone());
        pulls.send(Pull::Event(event)).unwrap();
    }
    pulls.send(Pull::Fail("done".into())).unwrap();
    assert_eq!(read_bound(&ends, feed.as_ref()).await, "done");
    assert_eq!(feed.acked(), ids);
    // The run's end woke the wait: its pause ends without sleeping.
    let start = tokio::time::Instant::now();
    watch.pause(start + Duration::from_secs(60)).await;
    assert_eq!(tokio::time::Instant::now(), start);
    // Only the run's end was handled as one: the other ids are unknown.
    for (index, id) in ids.iter().enumerate() {
        let again = ends.wake(id.as_deref(), BROCA_STORE_SESSION_REF) == Woke::Again;
        assert_eq!(again, index == 2, "{}", names[index]);
    }
}
