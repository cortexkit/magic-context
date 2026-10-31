//! A view carries only ck-mc's own content (the history head) plus ranges,
//! part references and edits that really change a part. It never sends back a
//! part or a message the runner already holds. A moved head's first view did:
//! every numbered part went back whole just to gain the `§N§ ` prefix the
//! runner renders itself, and every notice the runner persists as synthetic
//! went back as a whole message.

use super::*;

/// A transcript shaped like a long OpenCode head: authored user text, the
/// runner's own synthetic notices, assistant text and tool results, each part
/// numbered by the runner.
fn head_shaped(count: u64) -> Vec<ReadMessage> {
    (0..count)
        .map(|n| {
            let id = format!("p{n}");
            let (role, part) = match n % 6 {
                0 => (
                    "user",
                    json!({"id":id,"type":"text","text":format!("question {n} ")+&"durable words ".repeat(16)}),
                ),
                3 => (
                    "user",
                    json!({"id":id,"type":"text","synthetic":true,"text":format!("<system-reminder>\nnotice {n}\n</system-reminder>")}),
                ),
                1 | 4 => (
                    "assistant",
                    json!({"id":id,"type":"tool","tool":"read","callID":format!("call{n}"),"state":{"status":"completed","input":{"path":format!("file{n}")},"output":"exact spent output ".repeat(500)}}),
                ),
                _ => (
                    "assistant",
                    json!({"id":id,"type":"text","text":format!("answer {n} ")+&"durable words ".repeat(16)}),
                ),
            };
            ReadMessage::new(
                n,
                format!("m{n}"),
                json!({"info":{"id":format!("m{n}"),"role":role,"time":{"created":1}},"parts":[part]}),
            )
            .with_tags(vec![tags::PartTag::tagged("0", format!("§{}§", 100 + n))])
        })
        .collect()
}

/// The runner part a view edit names, from the runner's own transcript.
fn runner_part<'a>(entries: &'a [ReadMessage], edit: &view::PartEdit) -> &'a Value {
    let entry = entries
        .iter()
        .find(|entry| entry.ordinal == edit.ordinal)
        .expect("edit names a held message");
    assert_eq!(entry.mid, edit.mid);
    let index = entry
        .tags
        .iter()
        .position(|row| row.part == edit.part)
        .expect("edit names a served part key");
    &entry.message["parts"][index]
}

#[tokio::test]
async fn a_view_never_resends_runner_content_when_setup_names_no_tag_rendering() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::without_setup(
        dir.path(),
        "thalamus-harness",
        ("runner", "s"),
        ("opencode", "s"),
        |_| {},
    )
    .await;
    // A runner's Setup carries the plan's composition, which has no
    // `render_tags`: the plan member lives on the plan, not in it.
    let answer = rig
        .op(
            "compaction.setup",
            json!({"session":"s","harness":"opencode","request_id":"setup","model":"fixture","context_window":100_000,"composition":{"compaction":{"provider":"magic-context"}},"params":{"serializer_profile":"opencode-aisdk"},"lineage_id":"L","now":1}),
        )
        .await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    *rig.runner.entries.lock().unwrap() = head_shaped(42);
    rig.notice(1, 1_000, None).await;
    rig.history(10, "stable baseline history");
    rig.notice(2, 1_000, None).await;
    let baseline = rig.newest().unwrap();
    // Three tool results past the history, worth well over 2% of the window.
    rig.queue(&[119, 122, 125]).await;
    rig.notice(3, 75_000, Some(baseline)).await;
    let version = rig.newest().unwrap();
    assert!(version > baseline, "the execute pass publishes the drops");
    let view = rig.get(version).await;
    let entries = rig.runner.entries.lock().unwrap().clone();
    let held = entries
        .iter()
        .map(|entry| entry.mid.as_str())
        .collect::<HashSet<_>>();
    let mut kept = BTreeSet::new();
    let mut dropped = 0;
    for range in &view.ranges {
        match range {
            view::ViewRange::Replace { bytes, .. } => {
                for message in serde_json::from_str::<Vec<Value>>(bytes).unwrap() {
                    let id = message.pointer("/info/id").and_then(Value::as_str);
                    assert!(
                        id.is_none_or(|id| !held.contains(id)),
                        "a replace range re-sends runner message {id:?}"
                    );
                }
            }
            view::ViewRange::Keep { from, to, edits } => {
                kept.extend(*from..*to);
                for edit in edits {
                    if edit.drop {
                        dropped += 1;
                        continue;
                    }
                    let bytes: Value = serde_json::from_str(edit.bytes.as_ref().unwrap()).unwrap();
                    assert_ne!(
                        untagged_part(&bytes),
                        untagged_part(runner_part(&entries, edit)),
                        "edit on m{} re-sends a part that only gained its tag",
                        edit.ordinal
                    );
                }
            }
            _ => panic!("unknown range kind"),
        }
    }
    // The runner's own notices past the history stay where they are.
    for notice in (11..42).filter(|n| n % 6 == 3) {
        assert!(
            kept.contains(&notice),
            "notice m{notice} left its keep range"
        );
    }
    assert!(
        dropped + view.ranges.len() > 0,
        "the drops reached the view: {view:?}"
    );
    // The model still receives every runner part with its own tag.
    let _ = rig.render(&view);
}
