use super::*;
use cortexkit_bus_trait::{
    BusResult, ContentDigest, Headers, PublishReceipt, StreamCursor, StreamDelivery,
};

struct ClockedStream(Arc<InMemoryBus>);
struct ClockedCursor(<InMemoryBus as Stream>::Cursor);

#[async_trait]
impl Stream for ClockedStream {
    type Cursor = ClockedCursor;

    async fn publish(
        &self,
        subject: &str,
        id: &str,
        digest: ContentDigest,
        headers: Headers,
    ) -> BusResult<PublishReceipt> {
        self.0.publish(subject, id, digest, headers).await
    }

    async fn consumer(&self, owner: DurableOwner<'_>) -> BusResult<Self::Cursor> {
        Ok(ClockedCursor(self.0.consumer(owner).await?))
    }
}

#[async_trait]
impl StreamCursor for ClockedCursor {
    async fn next(&mut self) -> BusResult<Option<StreamDelivery>> {
        self.0.next().await
    }

    async fn ack(&mut self) -> BusResult<()> {
        self.0.ack().await
    }

    async fn nak(&mut self, delay: Duration) -> BusResult<()> {
        // InMemoryBus schedules NAKs with std::time::Instant, which a paused
        // Tokio clock cannot advance. Wait on that clock here, then make the
        // real cursor's redelivery immediately available.
        tokio::time::sleep(delay).await;
        self.0.nak(Duration::ZERO).await
    }

    async fn term(&mut self, reason: Option<&str>) -> BusResult<()> {
        self.0.term(reason).await
    }

    async fn in_progress(&mut self) -> BusResult<()> {
        self.0.in_progress().await
    }
}

fn transcript() -> Vec<ReadMessage> {
    let mut transcript = entries(&GOLDENS[2]);
    // Keep the fixture's first four numbered tags, then append the captured
    // call/result pair with fresh transcript identities. The runner
    // numbers the result, never the tool call.
    for (index, mut entry) in entries(&GOLDENS[3]).into_iter().skip(1).take(2).enumerate() {
        entry.ordinal = 4 + index as u64;
        entry.mid = format!("m{}", entry.ordinal);
        entry.tags[0].part = format!("{}#0", entry.mid);
        entry.tags[0].tag = (index == 1).then(|| "§5§".into());
        transcript.push(entry);
    }
    transcript
}

async fn rig(dir: &Path, transcript: &[ReadMessage]) -> Rig {
    let mut rig = Rig::open(
        dir,
        "broca",
        "broca",
        json!({"serializer_profile":"owned-broca"}),
    )
    .await;
    // Replace the idle consumer before publishing any notices. Publishers keep
    // the same bus; only its retry delay needs the simulated clock.
    rig.task.abort();
    while !rig.task.is_finished() {
        tokio::task::yield_now().await;
    }
    rig.task = rig
        .h
        .clone()
        .start_compaction_bus(Arc::new(ClockedStream(rig.bus.clone())), "fixture".into())
        .await
        .unwrap();
    *rig.runner.entries.lock().unwrap() = transcript.to_vec();
    rig
}

async fn publish(rig: &Rig, seq: u64) {
    let last = rig.runner.entries.lock().unwrap().last().unwrap().clone();
    let notice = notice::AdvanceNotice::new(
        &rig.reference,
        seq,
        "L",
        last.ordinal,
        contract::digest::content_digest(&last.message),
        1_000,
        "fixture",
    )
    .with_window(100_000);
    let receipt = rig
        .bus
        .publish(
            &notice::event_subject("fixture", "broca", notice::ADVANCED_EVENT),
            &bus_id(&rig.reference, "advanced", seq),
            notice.digest().parse().unwrap(),
            notice.to_headers(),
        )
        .await
        .unwrap();
    assert!(!receipt.duplicate());
}

async fn settle() {
    // The in-memory bus and handler run on this test's single-thread runtime.
    // Yield without advancing the clock so each simulated second can redeliver
    // a NAK, rather than jumping straight over all the retry deadlines.
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test(start_paused = true)]
async fn open_tool_ten_minutes_has_bounded_reads_and_passes() {
    let dir = tempfile::tempdir().unwrap();
    let transcript = transcript();
    let rig = rig(dir.path(), &transcript[..5]).await;
    let before = resident::counters::read().engine_passes;
    publish(&rig, 1).await;
    settle().await;
    for _ in 0..600 {
        tokio::time::advance(Duration::from_secs(1)).await;
        settle().await;
    }
    let reads = rig.runner.reads.lock().unwrap().len();
    let passes = resident::counters::read().engine_passes - before;
    eprintln!("open tool held 600 seconds: reads={reads}, passes={passes}");
    assert_eq!(
        (reads, passes),
        (1, 1),
        "an open tool must wait for a notice"
    );
    // The notice is accepted and completes; the engine pass stays marked
    // failed so the result's notice runs it.
    assert!(rig.state().engine_failed);
    assert_eq!(rig.state().completed_seq, 1);
    assert_eq!(numbers(&rig.state()), [1, 2, 3, 4]);
}

#[tokio::test(start_paused = true)]
async fn open_tool_result_notice_completes_without_changing_tags_or_view() {
    let dir = tempfile::tempdir().unwrap();
    let transcript = transcript();
    let rig = rig(dir.path(), &transcript[..5]).await;
    publish(&rig, 1).await;
    settle().await;
    assert_eq!(rig.state().completed_seq, 1);
    *rig.runner.entries.lock().unwrap() = transcript.clone();
    rig.notice(2, 1_000, None).await;
    let state = rig.state();
    assert_eq!(state.completed_seq, 2);
    assert!(!state.engine_failed && state.failure.is_none());
    assert_eq!(numbers(&state), [1, 2, 3, 4, 5]);
    assert_eq!(
        state.entries.get(&4).unwrap().read().unwrap().tags[0].tag,
        None
    );
    assert_eq!(rig.runner.reads.lock().unwrap().len(), 2);

    // A lane that first sees the complete transcript is the independent
    // scheduling control: waiting must not alter the eventual pass or bytes.
    let control_dir = tempfile::tempdir().unwrap();
    let control = self::rig(control_dir.path(), &transcript).await;
    control.notice(2, 1_000, None).await;
    let engine_header = |state: &State| {
        let mut header = serde_json::to_value(&state.engine).unwrap();
        // Separate sessions have different ids; the pass state must agree.
        header.as_object_mut().unwrap().remove("compaction_id");
        header
    };
    assert_eq!(engine_header(&state), engine_header(&control.state()));
    assert_eq!(rig.newest(), control.newest());
    // This low-usage pass needs no replacement in either lane. With no view,
    // the runner serves the original transcript, including the same numbers.
    assert_eq!(rig.newest(), None);
    let source_bytes = |state: &State| {
        let messages = inbound_messages(state.entries.values()).unwrap();
        serde_json::to_vec(
            &messages
                .iter()
                .map(|entry| &entry.message)
                .collect::<Vec<_>>(),
        )
        .unwrap()
    };
    assert_eq!(source_bytes(&state), source_bytes(&control.state()));
    assert_eq!(
        source_bytes(&state),
        serde_json::to_vec(
            &transcript
                .iter()
                .map(|entry| &entry.message)
                .collect::<Vec<_>>()
        )
        .unwrap()
    );
}

#[tokio::test(start_paused = true)]
async fn open_tool_lost_result_notice_recovers_on_unrelated_notice() {
    let dir = tempfile::tempdir().unwrap();
    let transcript = transcript();
    let rig = rig(dir.path(), &transcript[..5]).await;
    publish(&rig, 1).await;
    settle().await;
    *rig.runner.entries.lock().unwrap() = transcript;
    // Sequence 2, the result's notice, is lost. A later surface-change notice
    // still reads the pending call and result and completes the same engine pass.
    tokio::time::advance(Duration::from_secs(600)).await;
    settle().await;
    assert_eq!(rig.runner.reads.lock().unwrap().len(), 1);
    rig.notice_with(3, 1_000, None, None, vec![notice::Event::SurfaceChange])
        .await;
    let state = rig.state();
    assert_eq!(state.completed_seq, 3);
    assert!(!state.resync && !state.engine_failed && state.failure.is_none());
    assert_eq!(numbers(&state), [1, 2, 3, 4, 5]);
    let reads = rig.runner.reads.lock().unwrap();
    assert_eq!(reads.len(), 2);
    assert_eq!(reads[1]["from_ordinal"], 4);
}

#[test]
fn open_tool_wait_does_not_settle_other_retry_reasons() {
    assert!(waiting_for_tool_result(&engine_error(
        transform::TransformError::LineageProtocol(
            "compaction range ends inside a tool arc".into()
        )
    )));
    for error in [
        transient("runner transport failed"),
        transient("retry_later"),
        transient("async read incomplete; resuming from ordinal 10"),
        engine_error(transform::TransformError::LineageProtocol(
            "compaction range starts inside a tool arc".into(),
        )),
    ] {
        assert!(!waiting_for_tool_result(&error));
    }
}
