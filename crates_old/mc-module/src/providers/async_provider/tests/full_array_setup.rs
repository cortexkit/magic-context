//! A Claude Code conversation ck-mc served on the full-array `transform`
//! route answers its first async Setup with a checkpoint above every tag
//! number that route allocated for it (`full_array_floor`). The full-array
//! state here is written by the real route, `transform::transform`, under the
//! keys the gateway gave it.
use super::*;
use crate::transform::tests::{item, pctx, req};
use contract::{errors::RefuseCode, setup::SetupAnswer};

const MODULE: &str = "thalamus-harness";
const SESSION: &str = "0b6a1e9e-1c55-4c6e-9d43-3f0f5a3e2b11";
const AGENT: &str = "a063e1f2";
const SEP: char = '\u{241f}';

fn epoch_key(epoch: u64) -> String {
    if epoch == 0 {
        SESSION.to_owned()
    } else {
        format!("{SESSION}{SEP}{epoch}")
    }
}

fn agent_key(epoch: u64) -> String {
    format!("{SESSION}{SEP}{AGENT}{SEP}{epoch}")
}

fn subagent_session() -> String {
    format!("{SESSION}/{AGENT}")
}

/// One full-array pass of a Claude Code request holding `messages` text
/// messages under store key `key`, with ctx_reduce present so the route tags
/// parts. The first pass of a key only switches its tag surface on, so each
/// request is sent twice; every message is tagged by the second.
fn full_array_pass(store: &McStore, key: &str, messages: u64) {
    let mut request = req(
        key,
        "cfg0",
        (1..=messages)
            .map(|n| {
                item(
                    &format!("{key}-m{n}"),
                    n,
                    &format!("message {n} with durable words"),
                )
            })
            .collect(),
    );
    request.serializer_profile = crate::healing::SerializerProfile::ClaudeCodeAnthropic
        .wire_id()
        .to_string();
    request.tool_present = true;
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    for _ in 0..2 {
        crate::transform::transform(store, &request, &ctx).expect("full-array pass");
    }
}

/// The highest tag number the full-array route stored under `key`, read
/// straight from its rows.
fn allocated(store: &McStore, key: &str) -> u64 {
    store
        .load_tag_numbers_for_session(key)
        .unwrap()
        .last()
        .map_or(0, |row| row.tag_number as u64)
}

/// Build a rig whose store holds what `seed` writes, then send the first
/// Setup for `session` from a Claude Code runner.
async fn cc_setup(dir: &Path, session: &str, seed: impl FnOnce(&McStore)) -> (Rig, Value) {
    Rig::try_setup_with_model(
        dir,
        MODULE,
        ("runner", session),
        ("claude-code", session),
        "fixture",
        json!({"serializer_profile":"anthropic-messages"}),
        |h| seed(h.store.get().unwrap()),
    )
    .await
}

fn cc_setup_request(session: &str, request_id: &str) -> Value {
    json!({"session":session,"harness":"claude-code","request_id":request_id,"model":"fixture","context_window":100_000,"composition":{"render_tags":true},"params":{"serializer_profile":"anthropic-messages"},"lineage_id":"L","now":1})
}

fn checkpoint_of(answer: &Value) -> Option<contract::setup::SetupCheckpoint> {
    assert_eq!(answer["answer"], "ready", "{answer}");
    serde_json::from_value::<SetupAnswer>(answer.clone())
        .unwrap()
        .checkpoint()
        .cloned()
}

/// The head's floor is the highest number allocated in any of its epochs,
/// not the latest one; its subagents' keys are not its own.
#[tokio::test]
async fn the_head_floor_is_the_highest_number_allocated_in_any_epoch() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, answer) = cc_setup(dir.path(), SESSION, |store| {
        full_array_pass(store, &epoch_key(0), 30);
        full_array_pass(store, &epoch_key(1), 10);
        full_array_pass(store, &epoch_key(2), 5);
        // A subagent allocated more than the head ever did.
        full_array_pass(store, &agent_key(0), 40);
    })
    .await;
    let store = rig.h.store.get().unwrap();
    assert_eq!(allocated(store, &epoch_key(0)), 30);
    assert_eq!(allocated(store, &epoch_key(2)), 5);
    assert_eq!(allocated(store, &agent_key(0)), 40);
    let checkpoint = checkpoint_of(&answer).expect("a full-array floor");
    assert_eq!(checkpoint.tag_checkpoint, 30, "{answer}");
    // The cut is the conversation's first message: the message of epoch 0's
    // lowest tag.
    assert_eq!(checkpoint.cut, format!("{SESSION}-m1"));
}

/// A subagent's floor is taken across its own epochs only.
#[tokio::test]
async fn a_subagent_floor_is_taken_across_its_own_epochs() {
    let dir = tempfile::tempdir().unwrap();
    let session = subagent_session();
    let (_rig, answer) = cc_setup(dir.path(), &session, |store| {
        full_array_pass(store, &epoch_key(0), 50);
        full_array_pass(store, &agent_key(0), 8);
        full_array_pass(store, &agent_key(1), 3);
        full_array_pass(store, &format!("{SESSION}{SEP}ffff{SEP}0"), 70);
    })
    .await;
    let checkpoint = checkpoint_of(&answer).expect("a full-array floor");
    assert_eq!(checkpoint.tag_checkpoint, 8, "{answer}");
    assert_eq!(checkpoint.cut, format!("{}-m1", agent_key(0)));
}

/// The floor is what the route allocated, not what it last rendered: a
/// rewind leaves allocated numbers the last served array no longer shows,
/// and the model saw them before the rewind.
#[tokio::test]
async fn the_floor_counts_numbers_allocated_but_no_longer_rendered() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, answer) = cc_setup(dir.path(), SESSION, |store| {
        full_array_pass(store, &epoch_key(0), 12);
        full_array_pass(store, &epoch_key(0), 7);
    })
    .await;
    assert_eq!(allocated(rig.h.store.get().unwrap(), &epoch_key(0)), 12);
    let checkpoint = checkpoint_of(&answer).expect("a full-array floor");
    assert_eq!(checkpoint.tag_checkpoint, 12, "{answer}");
}

/// A number at or below the floor names nothing in the async conversation,
/// so `ctx_reduce` refuses it; the runner numbers new parts above it.
#[tokio::test]
async fn old_numbers_are_refused_and_new_parts_land_above_the_floor() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, answer) = cc_setup(dir.path(), SESSION, |store| {
        full_array_pass(store, &epoch_key(0), 30);
        full_array_pass(store, &epoch_key(1), 10);
    })
    .await;
    let checkpoint = checkpoint_of(&answer).expect("a full-array floor");
    assert_eq!(checkpoint.tag_checkpoint, 30);
    // The runner anchors at the cut and numbers from the checkpoint, as
    // llm-runner's own numbering does.
    let anchor =
        tags::anchor(SESSION, &[], Some(&checkpoint), |mid| mid == checkpoint.cut).unwrap();
    assert_eq!(
        anchor,
        tags::Anchor::Setup {
            checkpoint: 30,
            cut: checkpoint.cut.clone()
        }
    );
    let kinds = (0..4)
        .map(|n| {
            let kind = if n % 2 == 0 {
                tags::PartKind::UserText
            } else {
                tags::PartKind::AssistantText
            };
            tags::RenderedPart::new(kind, n)
        })
        .collect::<Vec<_>>();
    let numbers = tags::try_number_parts(checkpoint.tag_checkpoint, &kinds).unwrap();
    assert_eq!(numbers, vec![Some(31), Some(32), Some(33), Some(34)]);
    *rig.runner.entries.lock().unwrap() = numbers
        .iter()
        .enumerate()
        .map(|(n, number)| {
            let mid = if n == 0 {
                checkpoint.cut.clone()
            } else {
                format!("m{n}")
            };
            let role = if n % 2 == 0 { "user" } else { "assistant" };
            ReadMessage::new(
                n as u64,
                mid,
                json!({"role":role,"content":[{"type":"text","text":format!("turn {n} words")}]}),
            )
            .with_tags(vec![tags::PartTag::tagged(
                "0",
                format!("§{}§", number.unwrap()),
            )])
        })
        .collect();
    for old in ["30", "12", "1"] {
        let answer = rig.tool(7, "ctx_reduce", json!({ "drop": old })).await;
        assert_eq!(answer["isError"], true, "{old}: {answer}");
        assert_eq!(
            answer["content"][0]["text"],
            format!("Refused: no valid tags to queue. tags {old} not found")
        );
    }
    assert!(rig.pending_targets().is_empty());
    let answer = rig.tool(7, "ctx_reduce", json!({"drop":"31"})).await;
    assert_ne!(answer["isError"], true, "{answer}");
    assert_eq!(rig.pending_targets().len(), 1);
}

/// With no full-array state the Setup answer is the one ck-mc gave before
/// floors existed: the stored initial answer, no checkpoint, and no
/// `role.describe` call. Keys of other conversations change nothing.
#[tokio::test]
async fn no_full_array_state_answers_exactly_as_before() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, answer) = cc_setup(dir.path(), SESSION, |store| {
        full_array_pass(store, "another-session", 5);
        full_array_pass(store, &format!("another-session{SEP}1"), 5);
        // A subagent's keys are not the head's.
        full_array_pass(store, &agent_key(0), 5);
    })
    .await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert!(answer.get("checkpoint").is_none(), "{answer}");
    let store = rig.h.store.get().unwrap();
    assert_eq!(allocated(store, "another-session"), 5);
    assert_eq!(allocated(store, &agent_key(0)), 5);
    let state = rig.state();
    assert!(state.full_array_floor.is_none());
    let mut expected = state.initial.clone();
    expected["request_id"] = json!("setup");
    assert_eq!(
        serde_json::to_vec(&answer).unwrap(),
        serde_json::to_vec(&with_checkpoint(expected, None)).unwrap()
    );
    assert_eq!(
        rig.runner
            .describes
            .load(std::sync::atomic::Ordering::Relaxed),
        0
    );
}

/// A stored key that starts like one of the conversation's keys but does not
/// parse refuses Setup by name, and nothing is stored.
#[tokio::test]
async fn an_unparseable_key_refuses_setup_by_name() {
    for key in [
        format!("{SESSION}{SEP}latest"),
        format!("{SESSION}{SEP}{AGENT}{SEP}x"),
        format!("{SESSION}{SEP}{SEP}3"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let (rig, answer) = cc_setup(dir.path(), SESSION, |store| {
            full_array_pass(store, &epoch_key(0), 4);
            full_array_pass(store, &key, 4);
        })
        .await;
        assert_eq!(answer["answer"], "refuse", "{key:?}: {answer}");
        assert_eq!(
            answer["code"],
            full_array_floor::FULL_ARRAY_KEY_AMBIGUOUS,
            "{key:?}: {answer}"
        );
        assert!(load_head(rig.h.store.get().unwrap(), &rig.reference)
            .unwrap()
            .is_none());
    }
    // The same goes for a subagent.
    let dir = tempfile::tempdir().unwrap();
    let (_rig, answer) = cc_setup(dir.path(), &subagent_session(), |store| {
        full_array_pass(store, &agent_key(0), 4);
        full_array_pass(store, &format!("{}{SEP}9", agent_key(0)), 4);
    })
    .await;
    assert_eq!(
        answer["code"],
        full_array_floor::FULL_ARRAY_KEY_AMBIGUOUS,
        "{answer}"
    );
}

/// Full-array state that cannot be read refuses Setup by name rather than
/// setting the conversation up without a floor.
#[tokio::test]
async fn unreadable_full_array_state_refuses_setup_by_name() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    let (rig, answer) = cc_setup(dir.path(), SESSION, |store| {
        full_array_pass(store, &epoch_key(0), 4);
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch("ALTER TABLE mc_tags RENAME TO mc_tags_lost;")
            .unwrap();
    })
    .await;
    assert_eq!(answer["answer"], "refuse", "{answer}");
    assert_eq!(
        answer["code"],
        full_array_floor::FULL_ARRAY_STATE_UNREADABLE,
        "{answer}"
    );
    assert!(load_head(rig.h.store.get().unwrap(), &rig.reference)
        .unwrap()
        .is_none());
}

/// A repeated Setup and a Setup after a restart answer the stored floor,
/// even when the full-array state changed since: it is never read again.
#[tokio::test]
async fn a_repeated_setup_and_a_restart_answer_the_same_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    let (mut rig, answer) = cc_setup(dir.path(), SESSION, |store| {
        full_array_pass(store, &epoch_key(0), 20);
    })
    .await;
    let first = checkpoint_of(&answer).expect("a full-array floor");
    assert_eq!(first.tag_checkpoint, 20);
    full_array_pass(rig.h.store.get().unwrap(), &epoch_key(3), 45);
    let again = rig
        .op("compaction.setup", cc_setup_request(SESSION, "again"))
        .await;
    assert_eq!(checkpoint_of(&again), Some(first.clone()), "{again}");
    // A restart: the module and its store go away, and a new one opens the
    // same store.
    rig.task.abort();
    let _ = (&mut rig.task).await;
    drop(rig);

    let (restarted, answer) = cc_setup(dir.path(), SESSION, |_| {}).await;
    assert_eq!(checkpoint_of(&answer), Some(first.clone()), "{answer}");
    assert_eq!(
        restarted.state().full_array_floor.map(|f| f.checkpoint()),
        Some(first)
    );
}

/// A runner that does not declare `tag_checkpoint` is refused, as for a
/// moved session, and nothing is stored.
#[tokio::test]
async fn a_runner_without_tag_checkpoint_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, answer) = Rig::try_setup_with_model(
        dir.path(),
        MODULE,
        ("runner", SESSION),
        ("claude-code", SESSION),
        "fixture",
        json!({"serializer_profile":"anthropic-messages"}),
        |h| {
            full_array_pass(h.store.get().unwrap(), &epoch_key(0), 6);
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
    match serde_json::from_value::<SetupAnswer>(answer.clone()).unwrap() {
        SetupAnswer::Refuse { code, .. } => {
            assert_eq!(code, RefuseCode::TagCheckpointUnsupported, "{answer}")
        }
        other => panic!("{other:?}"),
    }
    assert!(answer["reason"]
        .as_str()
        .unwrap()
        .contains("full-array route"));
    assert!(load_head(rig.h.store.get().unwrap(), &rig.reference)
        .unwrap()
        .is_none());
}
