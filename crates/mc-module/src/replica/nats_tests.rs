//! The live hub's decisions ([`super::nats::NatsHub`]), against a script of
//! JetStream answers in place of a server.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio::time::Instant;

use super::hub::{Ack, Hub, HubError, HubMessage};
use super::nats::{
    full, Delivered, Delivery, Fault, Following, HubStream, NatsHub, NEXT_WAIT, PENDING_WAIT,
    QUIET_WAIT, SILENCE, STREAM_FULL,
};

/// One step of a scripted consumer: an answer now, or a delivery after
/// some time.
enum Step {
    Now(Result<Delivered, Fault>),
    After(Duration, Delivered),
}

/// What the script was asked.
#[derive(Default)]
struct Calls {
    published: Vec<(String, String)>,
    follows: Vec<u64>,
    answered: Vec<String>,
    closed: usize,
}

/// JetStream as a script: the answers to publishes, the consumers made in
/// turn (each with its pending count and steps), and the last sequence.
struct Script {
    calls: Arc<Mutex<Calls>>,
    publishes: Mutex<VecDeque<Result<Ack, Fault>>>,
    consumers: Mutex<VecDeque<(u64, Vec<Step>)>>,
    last: Mutex<Result<u64, Fault>>,
}

impl Script {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            calls: Arc::default(),
            publishes: Mutex::default(),
            consumers: Mutex::default(),
            last: Mutex::new(Ok(0)),
        })
    }

    fn answer_publish(&self, answer: Result<Ack, Fault>) {
        self.publishes.lock().unwrap().push_back(answer);
    }

    fn consumer(&self, pending: u64, steps: Vec<Step>) {
        self.consumers.lock().unwrap().push_back((pending, steps));
    }

    fn follows(&self) -> Vec<u64> {
        self.calls.lock().unwrap().follows.clone()
    }

    fn closed(&self) -> usize {
        self.calls.lock().unwrap().closed
    }

    fn hub(self: &Arc<Self>) -> NatsHub {
        NatsHub::new(Arc::clone(self) as Arc<dyn HubStream>)
    }
}

#[async_trait]
impl HubStream for Script {
    async fn publish(
        &self,
        subject: &str,
        message_id: &str,
        _payload: Vec<u8>,
    ) -> Result<Ack, Fault> {
        self.calls
            .lock()
            .unwrap()
            .published
            .push((subject.to_owned(), message_id.to_owned()));
        self.publishes
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Err(Fault::Failed("unscripted publish".into())))
    }

    async fn last_seq(&self) -> Result<u64, Fault> {
        self.last.lock().unwrap().clone()
    }

    async fn follow(&self, start: u64) -> Result<Following, Fault> {
        self.calls.lock().unwrap().follows.push(start);
        let (pending, steps) = self
            .consumers
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or((0, Vec::new()));
        Ok(Following {
            pending,
            delivery: Box::new(Scripted {
                steps: steps.into(),
                calls: Arc::clone(&self.calls),
            }),
        })
    }
}

/// A consumer's deliveries as scripted; silence once the script ends.
struct Scripted {
    steps: VecDeque<Step>,
    calls: Arc<Mutex<Calls>>,
}

#[async_trait]
impl Delivery for Scripted {
    async fn next(&mut self, wait: Duration) -> Result<Option<Delivered>, Fault> {
        let after = match self.steps.front_mut() {
            Some(Step::Now(_)) => {
                let Some(Step::Now(answer)) = self.steps.pop_front() else {
                    unreachable!()
                };
                return answer.map(Some);
            }
            Some(Step::After(left, _)) if *left <= wait => *left,
            Some(Step::After(left, _)) => {
                *left -= wait;
                tokio::time::sleep(wait).await;
                return Ok(None);
            }
            None => {
                tokio::time::sleep(wait).await;
                return Ok(None);
            }
        };
        tokio::time::sleep(after).await;
        let Some(Step::After(_, delivered)) = self.steps.pop_front() else {
            unreachable!()
        };
        Ok(Some(delivered))
    }

    async fn answer(&mut self, subject: &str) -> Result<(), Fault> {
        self.calls.lock().unwrap().answered.push(subject.to_owned());
        Ok(())
    }

    async fn close(self: Box<Self>) {
        self.calls.lock().unwrap().closed += 1;
    }
}

/// Stream message `seq`, delivered as the consumer's `consumer_seq`th with
/// `pending` more after it.
fn message(seq: u64, consumer_seq: u64, pending: u64) -> Delivered {
    Delivered::Message {
        message: HubMessage {
            seq,
            subject: "ck.fleet.memory.project.pj-a".into(),
            message_id: Some(format!("s.m{seq}@1")),
            payload: vec![seq as u8],
        },
        consumer_seq,
        pending,
    }
}

fn now(delivered: Delivered) -> Step {
    Step::Now(Ok(delivered))
}

fn seqs(messages: &[HubMessage]) -> Vec<u64> {
    messages.iter().map(|message| message.seq).collect()
}

fn heartbeat(last: u64, flow_control: Option<&str>) -> Delivered {
    Delivered::Heartbeat {
        last_consumer_seq: Some(last),
        flow_control: flow_control.map(str::to_owned),
    }
}

#[tokio::test(start_paused = true)]
async fn a_publish_carries_the_engines_message_id_and_a_duplicate_acknowledgement_counts_as_sent() {
    let script = Script::new();
    script.answer_publish(Ok(Ack {
        seq: 7,
        duplicate: false,
    }));
    script.answer_publish(Ok(Ack {
        seq: 7,
        duplicate: true,
    }));
    let hub = script.hub();
    let subject = "ck.fleet.memory.project.pj-a";
    let first = hub.publish(subject, "s.m1@2", vec![1]).await.unwrap();
    let again = hub.publish(subject, "s.m1@2", vec![1]).await.unwrap();
    assert_eq!(
        (first, again),
        (
            Ack {
                seq: 7,
                duplicate: false
            },
            Ack {
                seq: 7,
                duplicate: true
            }
        )
    );
    assert_eq!(
        script.calls.lock().unwrap().published,
        vec![
            (subject.to_owned(), "s.m1@2".to_owned()),
            (subject.to_owned(), "s.m1@2".to_owned())
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn a_full_stream_refuses_with_one_unchanging_error_and_other_failures_say_what_failed() {
    let script = Script::new();
    script.answer_publish(Err(Fault::Full(
        "maximum bytes exceeded (code 503, error code 10077)".into(),
    )));
    script.answer_publish(Err(Fault::Full(
        "insufficient resources (code 503, error code 10023)".into(),
    )));
    script.answer_publish(Err(Fault::Failed(
        "publishing to the hub: timed out".into(),
    )));
    let hub = script.hub();
    let subject = "ck.fleet.memory.global.all";
    for _ in 0..2 {
        assert_eq!(
            hub.publish(subject, "s.m1@1", Vec::new()).await,
            Err(HubError(STREAM_FULL.into()))
        );
    }
    assert_eq!(
        hub.publish(subject, "s.m1@1", Vec::new()).await,
        Err(HubError("publishing to the hub: timed out".into()))
    );
}

/// The server's refusal of a full stream, as its error codes say it.
#[test]
fn a_full_stream_is_known_by_the_servers_error_code() {
    let refusal = |err_code: u64, description: &str| -> async_nats::jetstream::Error {
        serde_json::from_value(serde_json::json!({
            "code": 503, "err_code": err_code, "description": description,
        }))
        .unwrap()
    };
    assert!(full(&refusal(10077, "maximum bytes exceeded")));
    assert!(full(&refusal(10077, "maximum messages exceeded")));
    assert!(full(&refusal(10023, "insufficient resources")));
    assert!(full(&refusal(
        10002,
        "resource limits exceeded for account"
    )));
    // The same store error for a disk that failed is not a full stream.
    assert!(!full(&refusal(10077, "error writing to file")));
    assert!(!full(&refusal(10071, "wrong last sequence: 3")));
}

#[tokio::test(start_paused = true)]
async fn the_consumer_starts_after_the_stored_position_and_serves_read_after_read() {
    let script = Script::new();
    script.consumer(
        3,
        vec![
            now(message(5, 1, 2)),
            now(message(6, 2, 1)),
            now(message(7, 3, 0)),
        ],
    );
    let hub = script.hub();
    assert_eq!(seqs(&hub.fetch(4, 2).await.unwrap()), vec![5, 6]);
    assert_eq!(seqs(&hub.fetch(6, 10).await.unwrap()), vec![7]);
    assert_eq!(seqs(&hub.fetch(7, 10).await.unwrap()), Vec::<u64>::new());
    assert_eq!(script.follows(), vec![5]);
    assert_eq!(script.closed(), 0);
}

/// The engine stops a round before a message it can't apply yet; its next
/// read starts at its own position, so the consumer is made again there.
#[tokio::test(start_paused = true)]
async fn a_read_from_another_position_makes_the_consumer_again_from_there() {
    let script = Script::new();
    script.consumer(
        3,
        vec![
            now(message(1, 1, 2)),
            now(message(2, 2, 1)),
            now(message(3, 3, 0)),
        ],
    );
    script.consumer(2, vec![now(message(2, 1, 1)), now(message(3, 2, 0))]);
    let hub = script.hub();
    assert_eq!(seqs(&hub.fetch(0, 10).await.unwrap()), vec![1, 2, 3]);
    assert_eq!(seqs(&hub.fetch(1, 10).await.unwrap()), vec![2, 3]);
    assert_eq!(script.follows(), vec![1, 2]);
    assert_eq!(script.closed(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_skipped_delivery_fails_the_read_and_the_next_starts_again_from_the_stored_position() {
    let script = Script::new();
    script.consumer(2, vec![now(message(1, 1, 1)), now(message(3, 3, 0))]);
    script.consumer(2, vec![now(message(1, 1, 1)), now(message(2, 2, 0))]);
    let hub = script.hub();
    let error = hub.fetch(0, 10).await.unwrap_err();
    assert!(error.0.contains("skipped from delivery 1 to 3"), "{error}");
    assert!(!hub.following().await);
    assert_eq!(script.closed(), 1);
    assert_eq!(seqs(&hub.fetch(0, 10).await.unwrap()), vec![1, 2]);
    assert_eq!(script.follows(), vec![1, 1]);
}

#[tokio::test(start_paused = true)]
async fn a_heartbeat_naming_a_delivery_that_never_arrived_fails_the_read() {
    let script = Script::new();
    script.consumer(0, vec![now(message(1, 1, 0)), now(heartbeat(1, None))]);
    script.consumer(0, vec![now(message(1, 1, 0)), now(heartbeat(2, None))]);
    let hub = script.hub();
    assert_eq!(seqs(&hub.fetch(0, 10).await.unwrap()), vec![1]);
    let error = hub.fetch(0, 10).await.unwrap_err();
    assert!(
        error.0.contains("sent 2 deliveries and 1 arrived"),
        "{error}"
    );
    assert_eq!(script.follows(), vec![1, 1]);
}

#[tokio::test(start_paused = true)]
async fn flow_control_is_answered_and_delivery_goes_on() {
    let script = Script::new();
    script.consumer(
        2,
        vec![
            now(Delivered::FlowControl("$JS.FC.HUB_MEMORY.a.1".into())),
            now(message(1, 1, 1)),
            now(heartbeat(1, Some("$JS.FC.HUB_MEMORY.b.2"))),
            now(message(2, 2, 0)),
        ],
    );
    let hub = script.hub();
    assert_eq!(seqs(&hub.fetch(0, 10).await.unwrap()), vec![1, 2]);
    assert_eq!(
        script.calls.lock().unwrap().answered,
        vec!["$JS.FC.HUB_MEMORY.a.1", "$JS.FC.HUB_MEMORY.b.2"]
    );
}

#[tokio::test(start_paused = true)]
async fn a_consumer_silent_for_three_heartbeats_counts_as_gone() {
    let script = Script::new();
    let hub = script.hub();
    assert_eq!(hub.fetch(0, 10).await.unwrap(), Vec::new());
    tokio::time::sleep(SILENCE).await;
    let error = hub.fetch(0, 10).await.unwrap_err();
    assert!(error.0.contains("sent nothing for 15 seconds"), "{error}");
    assert_eq!(script.closed(), 1);
    assert_eq!(hub.fetch(0, 10).await.unwrap(), Vec::new());
    assert_eq!(script.follows(), vec![1, 1]);
}

#[tokio::test(start_paused = true)]
async fn a_heartbeat_keeps_a_quiet_consumer() {
    let script = Script::new();
    script.consumer(
        0,
        (0..4)
            .map(|_| Step::After(Duration::from_secs(5), heartbeat(0, None)))
            .collect(),
    );
    let hub = script.hub();
    for _ in 0..80 {
        assert_eq!(hub.fetch(0, 10).await.unwrap(), Vec::new());
    }
    // Twenty seconds passed, and a heartbeat came every five.
    assert_eq!(script.follows(), vec![1]);
}

#[tokio::test(start_paused = true)]
async fn a_consumer_that_ends_or_a_connection_made_again_fails_the_read() {
    let script = Script::new();
    script.consumer(
        1,
        vec![now(Delivered::Ended("409 Consumer Deleted".into()))],
    );
    script.consumer(
        1,
        vec![Step::Now(Err(Fault::Failed(
            "the connection to the hub was made again".into(),
        )))],
    );
    script.consumer(1, vec![now(message(1, 1, 0))]);
    let hub = script.hub();
    let error = hub.fetch(0, 10).await.unwrap_err();
    assert!(error.0.contains("ended: 409 Consumer Deleted"), "{error}");
    let error = hub.fetch(0, 10).await.unwrap_err();
    assert!(error.0.contains("made again"), "{error}");
    assert_eq!(seqs(&hub.fetch(0, 10).await.unwrap()), vec![1]);
    assert_eq!(script.follows(), vec![1, 1, 1]);
    assert_eq!(script.closed(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_message_at_or_before_the_position_fails_the_read() {
    let script = Script::new();
    script.consumer(1, vec![now(message(5, 1, 0))]);
    let hub = script.hub();
    let error = hub.fetch(5, 10).await.unwrap_err();
    assert!(error.0.contains("delivered message 5 after 5"), "{error}");
}

#[tokio::test(start_paused = true)]
async fn a_failed_consumer_or_a_failed_lookup_fails_the_read() {
    struct Refusing;
    #[async_trait]
    impl HubStream for Refusing {
        async fn publish(&self, _: &str, _: &str, _: Vec<u8>) -> Result<Ack, Fault> {
            unreachable!()
        }
        async fn last_seq(&self) -> Result<u64, Fault> {
            Err(Fault::Failed("no responders".into()))
        }
        async fn follow(&self, _: u64) -> Result<Following, Fault> {
            Err(Fault::Failed("no responders".into()))
        }
    }
    let hub = NatsHub::new(Arc::new(Refusing));
    assert_eq!(
        hub.fetch(0, 10).await,
        Err(HubError("making the memory consumer: no responders".into()))
    );
    assert_eq!(
        hub.last_seq().await,
        Err(HubError(
            "reading HUB_MEMORY's last sequence: no responders".into()
        ))
    );
}

/// While the stream holds messages the consumer hasn't delivered, a read
/// waits for them; with none known, it gives up soon and the next round
/// asks again.
#[tokio::test(start_paused = true)]
async fn a_read_waits_longer_while_the_stream_holds_undelivered_messages() {
    let late = || {
        vec![Step::After(
            PENDING_WAIT - Duration::from_secs(1),
            message(1, 1, 0),
        )]
    };
    let script = Script::new();
    script.consumer(1, late());
    let start = Instant::now();
    assert_eq!(seqs(&script.hub().fetch(0, 10).await.unwrap()), vec![1]);
    assert_eq!(
        start.elapsed(),
        PENDING_WAIT - Duration::from_secs(1) + NEXT_WAIT
    );

    let script = Script::new();
    script.consumer(0, late());
    let hub = script.hub();
    let start = Instant::now();
    assert_eq!(hub.fetch(0, 10).await.unwrap(), Vec::new());
    assert_eq!(start.elapsed(), QUIET_WAIT);
    let mut reads = 1;
    while hub.fetch(0, 10).await.unwrap().is_empty() {
        reads += 1;
    }
    // Fifteen quarter-second reads find nothing; the sixteenth gets the
    // message when it arrives, four seconds in.
    assert_eq!(reads, 15);
    assert_eq!(script.follows(), vec![1]);
}

#[tokio::test(start_paused = true)]
async fn a_message_that_arrives_while_the_task_waits_is_kept_for_the_next_read() {
    let script = Script::new();
    script.consumer(
        0,
        vec![
            Step::After(Duration::from_secs(5), heartbeat(0, None)),
            Step::After(Duration::from_secs(5), message(1, 1, 0)),
        ],
    );
    let hub = script.hub();
    // No consumer yet: nothing to wait on.
    assert!(
        tokio::time::timeout(Duration::from_secs(3600), hub.arrival())
            .await
            .is_err()
    );
    assert_eq!(hub.fetch(0, 10).await.unwrap(), Vec::new());
    hub.arrival().await;
    let start = Instant::now();
    assert_eq!(seqs(&hub.fetch(0, 10).await.unwrap()), vec![1]);
    assert_eq!(start.elapsed(), NEXT_WAIT);
    assert_eq!(script.follows(), vec![1]);
}

#[tokio::test(start_paused = true)]
async fn a_consumer_failing_while_the_task_waits_is_dropped_and_made_again_on_the_next_read() {
    let script = Script::new();
    script.consumer(
        0,
        vec![Step::After(Duration::from_secs(1), heartbeat(2, None))],
    );
    let hub = script.hub();
    assert_eq!(hub.fetch(0, 10).await.unwrap(), Vec::new());
    hub.arrival().await;
    assert!(!hub.following().await);
    assert_eq!(script.closed(), 1);
    assert_eq!(hub.fetch(0, 10).await.unwrap(), Vec::new());
    assert_eq!(script.follows(), vec![1, 1]);
}

#[tokio::test(start_paused = true)]
async fn acknowledging_does_nothing_and_the_last_sequence_comes_from_the_stream() {
    let script = Script::new();
    *script.last.lock().unwrap() = Ok(42);
    let hub = script.hub();
    assert_eq!(hub.last_seq().await, Ok(42));
    assert_eq!(hub.ack(42).await, Ok(()));
    assert!(script.follows().is_empty());
    assert!(script.calls.lock().unwrap().published.is_empty());
}

/// A stream full refusal through the engine: the outbox row waits as
/// unconfirmed, and is sent under the same message id once the stream
/// takes it.
#[tokio::test(start_paused = true)]
async fn a_full_stream_keeps_the_outbox_row_waiting_until_it_has_room() {
    use super::test_support::{box_of, TestSealer, KEY};
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(
        crate::context_db::ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap(),
    );
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO memories (level, owner_id, category, origin_category, content,
                 normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES ('project', 'pj-a', 'swe:architecture', 'ARCHITECTURE', 'Tabs, not spaces.',
                 ?1, 1, 1, 1, 1)",
            [crate::memory_writes::normalized_hash("Tabs, not spaces.")],
        )
        .unwrap()
    });
    let script = Script::new();
    script.answer_publish(Err(Fault::Full("maximum bytes exceeded".into())));
    script.answer_publish(Ok(Ack {
        seq: 1,
        duplicate: false,
    }));
    let replica = super::Replica::new(
        Arc::clone(&db),
        Arc::new(script.hub()),
        TestSealer::new(KEY, 1),
        box_of(1),
    );
    let state = || {
        db.with_connection(|conn| {
            conn.query_row("SELECT state FROM replica_outbox", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap()
        })
    };
    assert_eq!(
        replica.round().await,
        Err(format!("publishing: {STREAM_FULL}"))
    );
    assert_eq!(state(), "sending");
    assert_eq!(replica.round().await, Ok(1));
    assert_eq!(state(), "published");
    let published = script.calls.lock().unwrap().published.clone();
    assert_eq!(published.len(), 2);
    assert_eq!(published[0], published[1], "sent again under the same id");
}
