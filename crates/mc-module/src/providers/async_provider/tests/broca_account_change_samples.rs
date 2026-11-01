//! Broca's `account_change` notice samples (compaction-provider 0.7.2,
//! llm-runner 0.7.7), copied verbatim into
//! `testdata/broca-account-change/`: two real header maps captured through
//! Broca's run loop. One carries `events: "account_change:<label>"`; the
//! other carries no `events` key.
//!
//! The decode check runs each sample through `AdvanceNotice::from_headers`,
//! the same decode the async provider runs on every ingested notice, then
//! ingests each sample's events through the real bus path and runs a
//! `compaction.ride` with the sample's label through the ride path.
//! Production code is unchanged: these tests only prove the bytes Broca
//! sends are bytes ck-mc already accepts, handled the way the account-change
//! contract expects.
use super::*;
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

/// The account label the with-event sample carries: an opaque, stable
/// prompt-cache label, never a secret.
const ACCOUNT: &str = "d5c59eae1d5659b93a20c16522347ad6";

fn dir() -> String {
    format!(
        "{}/testdata/broca-account-change",
        env!("CARGO_MANIFEST_DIR")
    )
}

fn sample_bytes(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/{name}", dir())).unwrap()
}

/// The sample's header map, exactly as captured.
fn sample_headers(name: &str) -> BTreeMap<String, String> {
    serde_json::from_slice(&sample_bytes(name)).unwrap()
}

/// The fixtures are the captured bytes: every file listed in `SHA256SUMS`
/// hashes to its pinned digest, including the two digests Broca published.
#[test]
fn samples_match_sha256sums() {
    let sums = std::fs::read_to_string(format!("{}/SHA256SUMS", dir())).unwrap();
    let mut checked = 0;
    for line in sums.lines() {
        let (digest, name) = line.split_once("  ").unwrap();
        assert_eq!(crate::sha256_hex(&sample_bytes(name)), digest, "{name}");
        checked += 1;
    }
    assert_eq!(checked, 2, "both samples are pinned");
    assert_eq!(
        crate::sha256_hex(&sample_bytes("notice-with-account-change.json")),
        "d772179d44aa4888480b122c28926c6be2b570e89c53f85ce81124b216585c12"
    );
    assert_eq!(
        crate::sha256_hex(&sample_bytes("notice-without-account-change.json")),
        "9e76ab18ce03f13d60942f01a21b3d29be566aa70bdbb47e853005b0164ad48b"
    );
}

/// Both samples decode through the real notice decode, with nothing lost:
/// the with-event sample (seq 5) carries exactly one event, the
/// `account_change` token with the sample's label; the without-event sample
/// (seq 1) carries none.
#[test]
fn samples_decode_through_advance_notice_from_headers() {
    let with = sample_headers("notice-with-account-change.json");
    let notice = notice::AdvanceNotice::from_headers(&with).unwrap();
    assert_eq!(notice.seq, 5);
    assert_eq!(
        notice.events,
        vec![notice::Event::AccountChange(ACCOUNT.into())]
    );
    assert_eq!(notice.to_headers(), with, "the decode loses no header");
    assert_eq!(notice.check(), Ok(()));
    let without = sample_headers("notice-without-account-change.json");
    let notice = notice::AdvanceNotice::from_headers(&without).unwrap();
    assert_eq!(notice.seq, 1);
    assert!(notice.events.is_empty());
    assert!(!notice.to_headers().contains_key("events"));
    assert_eq!(notice.to_headers(), without, "the decode loses no header");
    assert_eq!(notice.check(), Ok(()));
}
fn decision_lines(rig: &Rig) -> Vec<String> {
    rig.h
        .provider_store
        .async_runtime
        .decision_lines
        .lock()
        .unwrap()
        .clone()
}

/// The decision line logged for notice `seq`.
fn notice_line(rig: &Rig, seq: u64) -> String {
    let marker = format!(" notice seq={seq} ");
    decision_lines(rig)
        .into_iter()
        .rfind(|line| line.contains(&marker))
        .unwrap_or_else(|| {
            panic!(
                "no decision line for notice {seq}: {:?}",
                decision_lines(rig)
            )
        })
}

/// Forty messages read at low usage, with three tool results queued for
/// dropping: cleanup a rebuild may land but a low-usage notice defers.
async fn rig_with_pending_cleanup(dir: &Path) -> Rig {
    let rig = Rig::new(dir).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    assert_eq!(rig.newest(), None, "low usage publishes nothing");
    rig.queue(&[163, 166, 169]).await;
    rig
}

/// Publish `name`'s headers for this rig through the bus, the path an
/// ingested notice's headers take. The session-binding headers name the
/// rig's live session (the sample's name Broca's, which this store does not
/// know, and the sample redacts its model while the rig runs `fixture`: a
/// changed model header is its own rebuild trigger, not the account-change
/// signal under test); every other byte is the sample's own, so the
/// `events` token the provider decodes is the captured one.
async fn ingest_sample(rig: &Rig, name: &str) {
    let verbatim = sample_headers(name);
    let last = rig.runner.entries.lock().unwrap().last().cloned().unwrap();
    let seq = rig.state().seq + 1;
    let mut map = verbatim.clone();
    map.insert("session_ref".into(), rig.reference.clone());
    map.insert(
        "lineage_id".into(),
        rig.runner.lineage.lock().unwrap().clone(),
    );
    map.insert("through_ordinal".into(), last.ordinal.to_string());
    map.insert(
        "through_digest".into(),
        contract::digest::content_digest(&last.message),
    );
    map.insert("seq".into(), seq.to_string());
    map.insert("model".into(), rig.state().setup.model.clone());
    for (key, value) in &map {
        if [
            "session_ref",
            "lineage_id",
            "through_ordinal",
            "through_digest",
            "seq",
            "model",
        ]
        .contains(&key.as_str())
        {
            continue;
        }
        assert_eq!(
            Some(value),
            verbatim.get(key),
            "{key} stays the sample's own byte"
        );
    }
    // The decode the async provider runs on every ingested notice.
    let notice = notice::AdvanceNotice::from_headers(&map).unwrap();
    assert_eq!(notice.to_headers(), map);
    let receipt = rig
        .bus
        .publish(
            &notice::event_subject("fixture", &rig.module, notice::ADVANCED_EVENT),
            &bus_id(&rig.reference, "advanced", seq),
            notice.digest().parse().unwrap(),
            map,
        )
        .await
        .unwrap();
    assert!(!receipt.duplicate());
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if rig.state().completed_seq >= seq
                && !rig.state().entries.is_empty()
                && rig
                    .h
                    .provider_store
                    .async_runtime
                    .completed_notice
                    .load(std::sync::atomic::Ordering::Relaxed)
                    >= seq
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("sample notice ingested");
}

/// The with-event sample records the account change exactly as handling for
/// a change learned after a request expects: the notice's event is recorded
/// with the notice and never rebuilds, and the decision line names the event
/// without its label.
#[tokio::test]
async fn sample_with_account_change_is_recorded_and_never_rebuilds() {
    let dir = tempfile::tempdir().unwrap();
    let rig = rig_with_pending_cleanup(dir.path()).await;
    let pending = rig.pending_targets();
    assert!(!pending.is_empty());
    ingest_sample(&rig, "notice-with-account-change.json").await;
    assert_eq!(rig.newest(), None, "the event never rebuilds");
    assert_eq!(rig.pending_targets(), pending, "nothing landed");
    assert_eq!(
        rig.state().acknowledgements,
        vec![format!("account_change:{ACCOUNT}")],
        "the notice's event is recorded with the notice"
    );
    let line = notice_line(&rig, 2);
    assert!(line.starts_with("async decision defer "), "{line}");
    assert!(line.contains("events=[account_change]"), "{line}");
    assert!(!line.contains(ACCOUNT), "the label is never logged: {line}");
}

/// The without-event sample behaves as notices do today: it defers at low
/// usage, records no acknowledgement and logs no event.
#[tokio::test]
async fn sample_without_account_change_behaves_as_today() {
    let dir = tempfile::tempdir().unwrap();
    let rig = rig_with_pending_cleanup(dir.path()).await;
    let pending = rig.pending_targets();
    assert!(!pending.is_empty());
    ingest_sample(&rig, "notice-without-account-change.json").await;
    assert_eq!(rig.newest(), None, "low usage publishes nothing");
    assert_eq!(rig.pending_targets(), pending, "nothing landed");
    assert!(
        rig.state().acknowledgements.is_empty(),
        "no event means no acknowledgement: {:?}",
        rig.state().acknowledgements
    );
    let line = notice_line(&rig, 2);
    assert!(line.starts_with("async decision defer "), "{line}");
    assert!(!line.contains("events="), "{line}");
}
/// A ride with cause `account_change` and the sample's label folds exactly
/// as a `model_change` ride does: one rebuild that also lands the pending
/// cleanup, with the same view and the same bytes. Its decision line names
/// the cause and never the account label.
#[tokio::test]
async fn sample_account_label_rides_exactly_like_model_change() {
    let model_dir = tempfile::tempdir().unwrap();
    let account_dir = tempfile::tempdir().unwrap();
    let model = rig_with_pending_cleanup(model_dir.path()).await;
    let account = rig_with_pending_cleanup(account_dir.path()).await;
    let model_answer = model
        .op(
            "compaction.ride",
            json!({"session_ref":model.reference,"cause":"model_change","deadline_ms":10_000}),
        )
        .await;
    let account_answer = account
        .op(
            "compaction.ride",
            json!({"session_ref":account.reference,"cause":"account_change","account":ACCOUNT,"deadline_ms":10_000}),
        )
        .await;
    assert_eq!(model_answer["answer"], "view", "{model_answer}");
    assert_eq!(account_answer["answer"], "view", "{account_answer}");
    let model_view: view::CompactionView = decode(&model_answer["view"]).unwrap();
    let account_view: view::CompactionView = decode(&account_answer["view"]).unwrap();
    assert_eq!(account_view.view_version, model_view.view_version);
    assert_eq!(account_view.ranges, model_view.ranges);
    assert_eq!(account.render(&account_view), model.render(&model_view));
    assert_eq!(account_answer["cache_ttl"], model_answer["cache_ttl"]);
    // The pending cleanup landed in that one rebuild.
    let dropped = |view: &view::CompactionView| {
        view.ranges.iter().any(|range| match range {
            view::ViewRange::Keep { edits, .. } => edits.iter().any(|edit| edit.ordinal == 21),
            view::ViewRange::Replace { from, to, .. } => *from <= 21 && 21 < *to,
            _ => false,
        })
    };
    assert!(
        dropped(&account_view),
        "the queued drop lands in the rebuild"
    );
    let line = decision_lines(&account)
        .into_iter()
        .find(|line| line.contains("ride cause="))
        .expect("the ride logs its decision");
    assert!(line.starts_with("async decision ride "), "{line}");
    assert!(line.contains("ride cause=account_change"), "{line}");
    assert!(!line.contains(ACCOUNT), "the label is never logged: {line}");
    // The label is stored nowhere: the ride carries no fact ck-mc keeps.
    let store = account.h.store.get().unwrap();
    let raw = store
        .load_async_compaction(&account.reference)
        .unwrap()
        .unwrap();
    assert!(!raw.contains(ACCOUNT), "the ride's label is not stored");
}
