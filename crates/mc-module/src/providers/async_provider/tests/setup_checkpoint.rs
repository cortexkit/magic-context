//! The Setup checkpoint of a moved session (compaction-provider §4), checked
//! the way llm-runner-conformance 0.9.0's `tags_setup_checkpoint_anchors_at_its_cut`
//! uses it from the provider's side: the answer decodes as the published
//! `SetupAnswer` with its `checkpoint`, and the crate's own anchoring and
//! numbering from it give the cut's first counted part `checkpoint + 1`.
use super::moved_session::moved_rig;
use super::*;
use crate::offline_move::{self, tests as fixture};
use contract::{errors::RefuseCode, setup::SetupAnswer};

#[path = "broca_role_describe.rs"]
pub(super) mod broca_role_describe;

const MODULE: &str = "thalamus-harness";

#[tokio::test]
async fn a_moved_session_answers_setup_with_its_checkpoint_and_the_runner_anchors_at_its_cut() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, answer) = moved_rig(dir.path(), true).await;
    // The selected cut is msg_m007, the newest eligible user carrier
    // immediately after the fold end msg_m006; it has no neighbour at its time
    // or time + 1.
    let cut = "msg_m007";
    let decoded: SetupAnswer = serde_json::from_value(answer.clone()).unwrap();
    let checkpoint = decoded
        .checkpoint()
        .cloned()
        .expect("a moved session's checkpoint");
    assert_eq!(checkpoint, contract::setup::SetupCheckpoint::new(20, cut));
    assert!(answer.get("tag_checkpoint").is_none() && answer.get("cut").is_none());
    assert!(
        rig.runner
            .describes
            .load(std::sync::atomic::Ordering::Relaxed)
            >= 1
    );

    // With no marker carrying a checkpoint, the runner anchors at the cut and
    // numbers the cut's first counted parts checkpoint + 1 and + 2.
    let anchor = tags::anchor(&fixture::fixture_session(), &[], Some(&checkpoint), |mid| {
        mid == cut
    })
    .unwrap();
    assert_eq!(
        anchor,
        tags::Anchor::Setup {
            checkpoint: 20,
            cut: cut.into()
        }
    );
    let numbers = tags::try_number_parts(
        20,
        &[
            tags::RenderedPart::new(tags::PartKind::UserText, 0),
            tags::RenderedPart::new(tags::PartKind::AssistantText, 1),
        ],
    )
    .unwrap();
    assert_eq!(numbers, vec![Some(21), Some(22)]);
}

/// A later Setup for a moved session is refused, with the typed terminal
/// code, once its runner stops declaring `tag_checkpoint`.
#[tokio::test]
async fn a_runner_without_tag_checkpoint_never_gets_the_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _) = moved_rig(dir.path(), true).await;
    rig.runner
        .withholds_tag_checkpoint
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let again = rig
        .op(
            "compaction.setup",
            setup_request(&fixture::fixture_session(), "again"),
        )
        .await;
    assert!(again.get("checkpoint").is_none(), "{again}");
    let decoded: SetupAnswer = serde_json::from_value(again.clone()).unwrap();
    match decoded {
        SetupAnswer::Refuse { code, .. } => {
            assert_eq!(code, RefuseCode::TagCheckpointUnsupported, "{again}")
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(decoded_retryable(&again), Some(false));
}

/// A first Setup of a moved session on a runner without the group is
/// refused before anything is stored.
#[tokio::test]
async fn a_first_setup_without_tag_checkpoint_is_refused_and_stores_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let session = fixture::fixture_session();
    // The fixture puts the marker on the selected cut message; otherwise the
    // move's apply step would refuse with `source_changed`.
    let paths = fixture::write_moved_session_stores(dir.path());
    offline_move::run(&paths, &session, false, &fixture::NoHolders, None).unwrap();
    let (rig, answer) = Rig::try_setup_with_model(
        dir.path(),
        MODULE,
        ("runner", &session),
        ("opencode", &session),
        "fixture",
        json!({"serializer_profile":"opencode-aisdk"}),
        |h| {
            h.provider_runner = Arc::new(Runner {
                module: MODULE.into(),
                lineage: Mutex::new("L".into()),
                withholds_tag_checkpoint: std::sync::atomic::AtomicBool::new(true),
                ..Default::default()
            });
        },
    )
    .await;
    assert!(answer.get("checkpoint").is_none(), "{answer}");
    assert_eq!(
        answer["code"],
        contract::errors::refuse_codes::TAG_CHECKPOINT_UNSUPPORTED,
        "{answer}"
    );
    assert!(load_head(rig.h.store.get().unwrap(), &rig.reference)
        .unwrap()
        .is_none());
}

/// The unmoved-session fence answers the published code, which decodes to
/// its typed, terminal variant; a session never moved gets no checkpoint and
/// costs its Setup no `role.describe`.
#[tokio::test]
async fn unmoved_sessions_are_refused_with_the_published_code_and_fresh_ones_carry_no_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    let (_rig, answer) = moved_rig(dir.path(), false).await;
    match serde_json::from_value::<SetupAnswer>(answer.clone()).unwrap() {
        SetupAnswer::Refuse { code, .. } => {
            assert_eq!(code, RefuseCode::StandaloneSessionNotMigrated)
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(decoded_retryable(&answer), Some(false));

    let fresh = tempfile::tempdir().unwrap();
    let rig = Rig::new(fresh.path()).await;
    let answer = rig
        .op("compaction.setup", setup_request("s", "fresh-again"))
        .await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert!(answer.get("checkpoint").is_none(), "{answer}");
    assert_eq!(
        rig.runner
            .describes
            .load(std::sync::atomic::Ordering::Relaxed),
        0
    );
}

fn decoded_retryable(answer: &Value) -> Option<bool> {
    serde_json::from_value::<SetupAnswer>(answer.clone())
        .unwrap()
        .retryable()
}
