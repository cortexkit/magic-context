//! A transcript read longer than one notice's read budget continues on the
//! notice's retry from the entries already held, instead of starting over.
use super::*;

/// Publish advance notice `seq` for the runner's current newest entry, without
/// waiting for it to be processed.
async fn publish_notice(rig: &Rig, seq: u64) {
    let last = rig.runner.entries.lock().unwrap().last().cloned().unwrap();
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
    let mut headers = notice.to_headers();
    headers.insert("lineage_id".into(), "L".into());
    let notice = notice::AdvanceNotice::from_headers(&headers).unwrap();
    let receipt = rig
        .bus
        .publish(
            &notice::event_subject("fixture", &rig.module, notice::ADVANCED_EVENT),
            &bus_id(&rig.reference, "advanced", seq),
            notice.digest().parse().unwrap(),
            headers,
        )
        .await
        .unwrap();
    assert!(!receipt.duplicate());
}

async fn wait_for(rig: &Rig, what: &str, done: impl Fn(&State) -> bool) {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Some(state) = load(rig.h.store.get().unwrap(), &rig.reference).unwrap() {
                if done(&state) {
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}

fn slow_runner(rig: &Rig, entries: u64) {
    rig.fill(entries);
    rig.runner
        .page_size
        .store(6, std::sync::atomic::Ordering::Relaxed);
    rig.runner
        .read_delay_ms
        .store(30, std::sync::atomic::Ordering::Relaxed);
    *rig.h
        .provider_store
        .async_runtime
        .notice_read_budget
        .lock()
        .unwrap() = Some(Duration::from_millis(100));
}

fn served_messages(rig: &Rig) -> u64 {
    rig.runner.reads.lock().unwrap().len() as u64
}

#[tokio::test]
async fn a_first_read_longer_than_the_budget_resumes_instead_of_starting_over() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    slow_runner(&rig, 60);
    publish_notice(&rig, 1).await;
    wait_for(&rig, "the notice to complete", |state| {
        state.completed_seq >= 1
    })
    .await;
    let state = rig.state();
    assert_eq!(state.entries.len(), 60);
    assert_eq!(
        state.generation, 0,
        "a budget overrun must never reset the conversation"
    );
    // Ten pages of six. Each retry re-reads only the page that starts at the
    // last held entry; a read that started over would read the first pages again.
    let reads = rig.runner.reads.lock().unwrap().clone();
    let starts = reads
        .iter()
        .map(|read| read["from_ordinal"].as_u64().unwrap())
        .collect::<Vec<_>>();
    assert!(
        starts.windows(2).all(|pair| pair[1] >= pair[0]),
        "every read continues where the held entries end: {starts:?}"
    );
    let restarts = starts.iter().filter(|from| **from == 0).count();
    assert_eq!(restarts, 1, "{starts:?}");
    assert!(
        starts.len() > 10,
        "the read took more than one attempt: {starts:?}"
    );
    assert!(served_messages(&rig) < 20, "{starts:?}");
    assert!(state.partial_read_seq.is_none());
}

#[tokio::test]
async fn a_lineage_change_during_a_resumed_read_discards_the_partial_read() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    slow_runner(&rig, 60);
    publish_notice(&rig, 1).await;
    // The first attempt keeps a partial read under lineage L.
    wait_for(&rig, "a partial read", |state| {
        !state.entries.is_empty() && state.entries.len() < 60 && state.completed_seq == 0
    })
    .await;
    let partial = rig.state();
    assert_eq!(partial.lineage.as_deref(), Some("L"));
    assert_eq!(partial.generation, 0);
    // The runner moves to a new lineage before the retry.
    *rig.runner.lineage.lock().unwrap() = "L2".into();
    wait_for(&rig, "the notice to complete", |state| {
        state.completed_seq >= 1
    })
    .await;
    let state = rig.state();
    assert!(
        state.generation > partial.generation,
        "the partial read must be discarded"
    );
    assert_eq!(state.lineage.as_deref(), Some("L2"));
    assert_eq!(state.entries.len(), 60);
    let reads = rig.runner.reads.lock().unwrap().clone();
    assert!(
        reads
            .iter()
            .any(|read| read["from_ordinal"] == 0 && read.get("lineage_id").is_none()),
        "after the reset the transcript is read again from the start under the new lineage"
    );
}
