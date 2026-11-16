//! A wait on a child run is woken by its runner's run-end event and reads
//! the run once more; the timed poll stays as the backstop, every 15 s while
//! the reader delivers events and every 500 ms while it doesn't.

use super::*;
use crate::client::ClientError;
use crate::run_ends::tests::{ended, Feed, Pull};
use crate::run_ends::{read_bound, RunEnds, BACKSTOP_POLL, FAST_POLL};
use cortexkit_role_compaction::read::{ReadPage, ReadRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::send::SendReply;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::mpsc::UnboundedSender;
use tokio::task::JoinHandle;
use tokio::time::Instant;

/// A runner whose one run stays active until the test ends it, and that
/// counts the reads of its result.
struct Client {
    ends: RunEnds,
    ended: AtomicBool,
    reads: AtomicUsize,
    /// Notified after each read.
    read: tokio::sync::Notify,
}

impl Client {
    fn reads(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }
}

impl RunnerClient for Client {
    fn run_ends(&self) -> Option<&RunEnds> {
        Some(&self.ends)
    }
    async fn read(&self, _: &SessionRef, _: ReadRequest) -> Result<ReadPage, ClientError> {
        unreachable!()
    }
    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        unreachable!()
    }
    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        unreachable!()
    }
    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        unreachable!()
    }
    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        let mut reply = SendReply::new(states::ACTIVE);
        reply.run_id = Some("run".into());
        Ok(reply)
    }
    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.read.notify_one();
        let state = if self.ended.load(Ordering::SeqCst) {
            states::COMPLETED
        } else {
            states::ACTIVE
        };
        Ok(RunResult::new("run", state))
    }
}

fn child() -> Child {
    Child {
        session: SessionRef::new("broca", "broca", "mc-dream:run-1:0:0"),
        project_root: Some("/project".into()),
    }
}

/// A wait on the child's run, started after its first read found the run
/// active.
struct Fixture {
    client: Arc<Client>,
    feed: Arc<Feed>,
    pulls: UnboundedSender<Pull>,
    /// The reader's task, which ends with the reason it stopped.
    reader: Option<JoinHandle<String>>,
    start: Instant,
    wait: JoinHandle<Result<Reply, SummaryError>>,
}

/// Start a wait, with a reader that has read from its durable when `reader`
/// is set, and with none otherwise.
async fn start(reader: bool) -> Fixture {
    let client = Arc::new(Client {
        ends: RunEnds::new(),
        ended: AtomicBool::new(false),
        reads: AtomicUsize::new(0),
        read: tokio::sync::Notify::new(),
    });
    let (feed, pulls) = Feed::new();
    let reader = reader.then(|| {
        let (client, feed) = (client.clone(), feed.clone());
        tokio::spawn(async move { read_bound(&client.ends, feed.as_ref()).await })
    });
    if reader.is_some() {
        pulls.send(Pull::Empty).unwrap();
        while client.ends.poll_interval() != BACKSTOP_POLL {
            tokio::task::yield_now().await;
        }
    }
    let start = Instant::now();
    let wait = tokio::spawn({
        let client = client.clone();
        async move {
            let model = ModelRef::new("provider", "model");
            let how = Model {
                model: &model,
                decision_id: "decision",
                output_tokens: 1000,
                system: "system",
                deadline: Instant::now() + RUN_TIMEOUT,
                continuation: false,
                creates_child: true,
                keep_child: false,
                cache_ttl: cortexkit_role_llm_runner::cache::Ttl::None,
                send: SendKind::Dream,
                plan: None,
            };
            send_and_wait(&*client, &child(), "send", "prompt", &how, &mut None).await
        }
    });
    client.read.notified().await;
    assert_eq!(client.reads(), 1);
    Fixture {
        client,
        feed,
        pulls,
        reader,
        start,
        wait,
    }
}

/// Whether the run is read again within a second.
async fn read_within_a_second(client: &Client) -> bool {
    tokio::time::timeout(Duration::from_secs(1), client.read.notified())
        .await
        .is_ok()
}

#[tokio::test(start_paused = true)]
async fn a_matching_event_wakes_the_wait_for_exactly_one_read() {
    let fixture = start(true).await;
    fixture.client.ended.store(true, Ordering::SeqCst);
    fixture
        .pulls
        .send(ended("ended-1", &child().session))
        .unwrap();
    fixture.wait.await.unwrap().unwrap();
    assert_eq!(fixture.client.reads(), 2);
    assert_eq!(Instant::now() - fixture.start, Duration::ZERO);
    fixture.feed.ack.notified().await;
    assert_eq!(fixture.feed.acked(), [Some("ended-1".to_owned())]);
}

#[tokio::test(start_paused = true)]
async fn an_event_for_another_session_wakes_nothing_and_the_backstop_still_settles() {
    let fixture = start(true).await;
    let other = SessionRef::new("broca", "broca", "mc-dream:run-2:0:0");
    fixture.pulls.send(ended("other", &other)).unwrap();
    fixture.feed.ack.notified().await;
    assert!(!read_within_a_second(&fixture.client).await);
    // No event for this run ever comes: the backstop reads it.
    fixture.client.ended.store(true, Ordering::SeqCst);
    fixture.wait.await.unwrap().unwrap();
    assert_eq!(fixture.client.reads(), 2);
    assert_eq!(Instant::now() - fixture.start, BACKSTOP_POLL);
}

#[tokio::test(start_paused = true)]
async fn a_redelivered_event_wakes_the_wait_no_second_time() {
    let fixture = start(true).await;
    // The event comes while the runner still reports the run active: the
    // wait reads once and keeps waiting.
    fixture
        .pulls
        .send(ended("ended-1", &child().session))
        .unwrap();
    fixture.client.read.notified().await;
    assert_eq!(fixture.client.reads(), 2);
    // The bus delivers it again, as it does when an acknowledgement is lost.
    fixture
        .pulls
        .send(ended("ended-1", &child().session))
        .unwrap();
    assert!(!read_within_a_second(&fixture.client).await);
    assert_eq!(fixture.client.reads(), 2);
    fixture.client.ended.store(true, Ordering::SeqCst);
    fixture
        .pulls
        .send(ended("ended-2", &child().session))
        .unwrap();
    fixture.wait.await.unwrap().unwrap();
    assert_eq!(fixture.client.reads(), 3);
    assert!(Instant::now() - fixture.start < BACKSTOP_POLL);
    assert_eq!(
        fixture.feed.acked(),
        ["ended-1", "ended-1", "ended-2"].map(|id| Some(id.to_owned()))
    );
}

#[tokio::test(start_paused = true)]
async fn without_a_reader_the_wait_reads_every_500_ms() {
    let fixture = start(false).await;
    assert_eq!(fixture.client.ends.poll_interval(), FAST_POLL);
    fixture.client.read.notified().await;
    fixture.client.read.notified().await;
    assert_eq!(Instant::now() - fixture.start, FAST_POLL * 2);
    fixture.client.ended.store(true, Ordering::SeqCst);
    fixture.wait.await.unwrap().unwrap();
    assert_eq!(fixture.client.reads(), 4);
    assert_eq!(Instant::now() - fixture.start, FAST_POLL * 3);
}

#[tokio::test(start_paused = true)]
async fn when_the_reader_stops_a_wait_on_the_backstop_reads_at_once_then_every_500_ms() {
    let mut fixture = start(true).await;
    fixture
        .pulls
        .send(Pull::Fail("nats_pull_failed".into()))
        .unwrap();
    let reason = fixture.reader.take().unwrap().await.unwrap();
    fixture.client.ends.stopped(&reason);
    fixture.client.read.notified().await;
    assert_eq!(Instant::now() - fixture.start, Duration::ZERO);
    fixture.client.read.notified().await;
    assert_eq!(Instant::now() - fixture.start, FAST_POLL);
    fixture.client.ended.store(true, Ordering::SeqCst);
    fixture.wait.await.unwrap().unwrap();
    assert_eq!(fixture.client.reads(), 4);
    assert_eq!(Instant::now() - fixture.start, FAST_POLL * 2);
}
