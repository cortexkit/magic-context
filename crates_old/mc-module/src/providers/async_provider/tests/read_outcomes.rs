//! Pages without a lineage: the runner's answer for a session it never wrote
//! is a named outcome, every other one is refused by name, and the identity
//! the read used is logged once per conversation.
use super::*;

/// Publish advance notice `seq` for the runner's newest entry, without
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
    let headers = notice.to_headers();
    let _ = rig
        .bus
        .publish(
            &notice::event_subject("fixture", &rig.module, notice::ADVANCED_EVENT),
            &bus_id(&rig.reference, "advanced", seq),
            notice.digest().parse().unwrap(),
            headers,
        )
        .await
        .unwrap();
}

async fn read_with(rig: &Rig, page: Value) -> (State, Result<ReadProgress, HandlerOutcome>) {
    *rig.runner.page_override.lock().unwrap() = Some(page);
    let mut state = rig.state();
    let read = rig
        .h
        .read_async_resumable(&mut state, 0, Duration::from_secs(5))
        .await;
    (state, read)
}

/// (a) An empty page with no lineage and no next page is the runner's answer
/// for a session it never wrote: a named outcome, not a transient error, and
/// a notice that meets it is acknowledged instead of retried.
#[tokio::test]
async fn a_never_written_session_is_a_named_outcome_not_a_retry() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let (_, read) = read_with(&rig, json!({"messages":[]})).await;
    assert!(matches!(read, Ok(ReadProgress::NeverWritten)));

    // Through a notice: acknowledged once, with the outcome on the record.
    rig.fill(3);
    let reads_before = rig.runner.reads.lock().unwrap().len();
    publish_notice(&rig, 1).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        while rig.state().read_outcome.as_deref() != Some(NEVER_WRITTEN) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the never-written outcome is recorded");
    let state = rig.state();
    assert_eq!(state.seq, 1);
    assert!(state.entries.is_empty());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        rig.runner.reads.lock().unwrap().len() - reads_before,
        1,
        "the notice read once and stopped; it is not retried"
    );
}

/// (b) Any other page without a lineage is a contract violation, refused by
/// name: one holding messages, one naming a next page, and the never-written
/// answer for a session ck-mc already holds messages of.
#[tokio::test]
async fn any_other_page_without_a_lineage_is_refused_by_name() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(3);
    let message =
        serde_json::to_value(serve_descriptors(&rig.runner.entries.lock().unwrap()[0])).unwrap();
    for page in [
        json!({"messages":[message]}),
        json!({"messages":[],"next_from_ordinal":4}),
        json!({"entries":[]}),
    ] {
        let (_, read) = read_with(&rig, page.clone()).await;
        match read {
            Err(HandlerOutcome::Error { code, message }) => {
                assert_eq!(code, PROTOCOL_ERROR, "{page}");
                assert!(message.starts_with(LINEAGELESS_PAGE), "{page}: {message}");
            }
            Err(other) => panic!("{page}: {other:?}"),
            Ok(_) => panic!("{page}: a page without a lineage was accepted"),
        }
    }
    // A conversation that already holds messages cannot be never written.
    *rig.runner.page_override.lock().unwrap() = None;
    rig.notice(1, 1_000, None).await;
    let (_, read) = read_with(&rig, json!({"messages":[]})).await;
    assert!(
        matches!(&read, Err(HandlerOutcome::Error { message, .. }) if message.starts_with(LINEAGELESS_PAGE)),
        "{:?}",
        read.err()
    );
}

/// (c) The identity a read used is logged once per conversation, and a page
/// without a lineage once per outcome with its top-level keys and message
/// count, so a read under the wrong identity shows in one line.
#[tokio::test]
async fn the_read_identity_and_a_lineageless_page_are_logged_once() {
    let dir = tempfile::tempdir().unwrap();
    // The once-per-conversation log is keyed by the session reference across
    // the process, and the reference no longer depends on the folder, so this
    // conversation needs a session no other test sets up.
    let session = "read-identity-logged-once";
    let rig = Rig::setup_with_model(
        dir.path(),
        "thalamus-harness",
        ("runner", session),
        ("opencode", session),
        "fixture",
        json!({"serializer_profile":"opencode-aisdk"}),
        |_| {},
    )
    .await;
    let reference = rig.reference.clone();
    let mine = || {
        READ_LOG.with(|log| {
            log.borrow()
                .iter()
                .filter(|line| line.contains(&format!("session_ref={reference} ")))
                .cloned()
                .collect::<Vec<_>>()
        })
    };
    for _ in 0..3 {
        let _ = read_with(&rig, json!({"messages":[],"head":{}})).await;
    }
    let lines = mine();
    let identity = lines
        .iter()
        .filter(|line| line.starts_with("async_read_identity "))
        .collect::<Vec<_>>();
    let page = lines
        .iter()
        .filter(|line| line.starts_with("async_read_lineageless_page "))
        .collect::<Vec<_>>();
    assert_eq!((identity.len(), page.len()), (1, 1), "{lines:?}");
    let runner = rig.state().runner_identity();
    for line in [identity[0], page[0]] {
        assert!(
            line.contains(&format!(" harness={} ", runner.harness)),
            "{line}"
        );
        assert!(
            line.contains(&format!(" session={}", runner.session)),
            "{line}"
        );
        assert!(
            line.contains(&format!(
                " project={} ",
                runner.project_root.to_string_lossy()
            )),
            "{line}"
        );
    }
    assert!(
        page[0].contains(r#"page_keys=["head", "messages"]"#),
        "{}",
        page[0]
    );
    assert!(page[0].contains(" messages=0 "), "{}", page[0]);
    assert!(page[0].ends_with(" outcome=never_written"), "{}", page[0]);
}
