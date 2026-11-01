use super::*;
use cortexkit_bus_trait::{
    BusResult, ContentDigest, Headers, PublishReceipt, StreamCursor, StreamDelivery,
};

#[derive(Default)]
struct Settlements {
    attempts: std::sync::atomic::AtomicU64,
    actions: Mutex<Vec<String>>,
    settled: tokio::sync::Notify,
}

struct ObservedStream(Arc<InMemoryBus>, Arc<Settlements>);
struct ObservedCursor(<InMemoryBus as Stream>::Cursor, Arc<Settlements>);

#[async_trait]
impl Stream for ObservedStream {
    type Cursor = ObservedCursor;
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
        Ok(ObservedCursor(
            self.0.consumer(owner).await?,
            self.1.clone(),
        ))
    }
}

impl ObservedCursor {
    fn record(&self, action: String) {
        self.1.actions.lock().unwrap().push(action);
        self.1.settled.notify_one();
    }
}

#[async_trait]
impl StreamCursor for ObservedCursor {
    async fn next(&mut self) -> BusResult<Option<StreamDelivery>> {
        let next = self.0.next().await?;
        if next.is_some() {
            self.1
                .attempts
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        Ok(next)
    }
    async fn ack(&mut self) -> BusResult<()> {
        self.0.ack().await?;
        self.record("ack".into());
        Ok(())
    }
    async fn nak(&mut self, delay: Duration) -> BusResult<()> {
        self.0.nak(delay).await?;
        self.record("nak".into());
        Ok(())
    }
    async fn term(&mut self, reason: Option<&str>) -> BusResult<()> {
        self.0.term(reason).await?;
        self.record(format!("term:{}", reason.unwrap_or_default()));
        Ok(())
    }
    async fn in_progress(&mut self) -> BusResult<()> {
        self.0.in_progress().await
    }
}

#[tokio::test]
async fn uncertified_cut_notice_is_ended_after_one_attempt_without_generation_churn() {
    let dir = tempfile::tempdir().unwrap();
    let mut rig = Rig::new(dir.path()).await;
    rig.fill(20);
    *rig.runner.head_override.lock().unwrap() = Some(json!({"lineage_id":"L", "first_ordinal":5,
        "cut":{"mid":"missing-parent","digest":"0".repeat(64),"written_at":1}}));
    rig.task.abort();
    let _ = (&mut rig.task).await;
    let observed = Arc::new(Settlements::default());
    rig.task = rig
        .h
        .clone()
        .start_compaction_bus(
            Arc::new(ObservedStream(rig.bus.clone(), observed.clone())),
            "fixture".into(),
        )
        .await
        .unwrap();
    let generation = rig.state().generation;
    let last = rig.runner.entries.lock().unwrap().last().cloned().unwrap();
    let notice = notice::AdvanceNotice::new(
        &rig.reference,
        1,
        "L",
        last.ordinal,
        contract::digest::content_digest(&last.message),
        1_000,
        "fixture",
    );
    let receipt = rig
        .bus
        .publish(
            &notice::event_subject("fixture", &rig.module, notice::ADVANCED_EVENT),
            &bus_id(&rig.reference, "advanced", 1),
            notice.digest().parse().unwrap(),
            notice.to_headers(),
        )
        .await
        .unwrap();
    assert!(!receipt.duplicate());
    tokio::time::timeout(Duration::from_secs(10), observed.settled.notified())
        .await
        .unwrap();
    assert_eq!(
        *observed.actions.lock().unwrap(),
        ["term:cut_rebootstrap_required"]
    );
    assert_eq!(
        observed.attempts.load(std::sync::atomic::Ordering::Relaxed),
        1
    );
    assert!(rig.state().generation <= generation + 1);
}
