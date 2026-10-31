//! A runner calls the step-transform `pre_user` hook before it writes a user
//! message. ck-mc answers with operations on that message: the time marker in
//! front, measured from the newest message it holds.

use super::*;

async fn rig(dir: &Path) -> Rig {
    Rig::open(
        dir,
        "thalamus-harness",
        "claude-code",
        json!({"serializer_profile":"anthropic-messages"}),
    )
    .await
}

fn written(mut entry: ReadMessage, written_at: u64) -> ReadMessage {
    entry.written_at = Some(written_at);
    entry
}

fn user(n: u64, text: &str, written_at: u64) -> ReadMessage {
    written(
        ReadMessage::new(
            n,
            format!("m{n}"),
            json!({"role":"user","content":[{"type":"text","text":text}]}),
        )
        .with_tags(vec![tags::PartTag::tagged("0", format!("§{}§", 1000 + n))]),
        written_at,
    )
}

fn reply(n: u64, written_at: u64) -> ReadMessage {
    written(
        ReadMessage::new(
            n,
            format!("m{n}"),
            json!({"role":"assistant","content":[{"type":"text","text":"Done."}]}),
        )
        .with_tags(vec![tags::PartTag::tagged("0", format!("§{}§", 1000 + n))]),
        written_at,
    )
}

/// Hold a two-message conversation whose reply was written `ago_ms` ago.
async fn held(rig: &Rig, ago_ms: u64) {
    let now = now_ms().max(0) as u64;
    *rig.runner.entries.lock().unwrap() = vec![
        user(0, "Start the work", now - ago_ms - 1_000),
        reply(1, now - ago_ms),
    ];
    rig.notice(1, 5000, None).await;
}

async fn hook(rig: &Rig, blocks: &[&str]) -> Value {
    rig.op(
        "transform.hook",
        json!({"session":"s","harness":"claude-code","lineage_id":"L","hook":"pre_user","blocks":blocks}),
    )
    .await
}

fn prepended(answer: &Value) -> Vec<String> {
    answer["ops"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|op| op["op"] == "prepend")
        .map(|op| op["text"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn pre_user_prepends_the_gap_since_the_newest_held_message() {
    let dir = tempfile::tempdir().unwrap();
    let rig = rig(dir.path()).await;
    held(&rig, 20 * 60_000 + 5_000).await;
    let answer = hook(&rig, &["What's next?"]).await;
    assert_eq!(answer["answer"], "ops", "{answer}");
    assert_eq!(prepended(&answer), vec!["<!-- +20m -->\n".to_string()]);
    assert!(answer["ops"]
        .as_array()
        .unwrap()
        .iter()
        .all(|op| op["op"] != "replace"));
}

#[tokio::test]
async fn pre_user_adds_no_marker_under_the_threshold() {
    let dir = tempfile::tempdir().unwrap();
    let rig = rig(dir.path()).await;
    held(&rig, 60_000).await;
    let answer = hook(&rig, &["Quick follow-up"]).await;
    assert!(prepended(&answer).is_empty(), "{answer}");
}

#[tokio::test]
async fn pre_user_leaves_a_reminder_only_message_alone() {
    let dir = tempfile::tempdir().unwrap();
    let rig = rig(dir.path()).await;
    held(&rig, 20 * 60_000).await;
    let answer = hook(
        &rig,
        &["<system-reminder>\nInbox: 1 notice.\n</system-reminder>"],
    )
    .await;
    assert_eq!(answer["answer"], "pass", "{answer}");
}

#[tokio::test]
async fn pre_user_passes_for_a_session_without_a_record() {
    let dir = tempfile::tempdir().unwrap();
    let rig = rig(dir.path()).await;
    let answer = rig
        .op(
            "transform.hook",
            json!({"session":"other","harness":"claude-code","hook":"pre_user","blocks":["Hello"]}),
        )
        .await;
    assert_eq!(answer["answer"], "pass", "{answer}");
}

#[tokio::test]
async fn declare_subscribes_heads_and_workers_to_pre_user() {
    let dir = tempfile::tempdir().unwrap();
    let rig = rig(dir.path()).await;
    let head = rig
        .op("transform.declare", json!({"preset":"head","params":{}}))
        .await;
    assert_eq!(
        head,
        json!({"subscriptions":[{"hook":"pre_user","ops":["prepend","append"],"on_unavailable":"pass","budget_ms":1500}]})
    );
    // Workers get the time marker only, like standalone subagents.
    let worker = rig
        .op("transform.declare", json!({"preset":"worker","params":{}}))
        .await;
    assert_eq!(
        worker,
        json!({"subscriptions":[{"hook":"pre_user","ops":["prepend"],"on_unavailable":"pass","budget_ms":1500}]})
    );
    let reader = rig
        .op("transform.declare", json!({"preset":"reader","params":{}}))
        .await;
    assert_eq!(reader, json!({"subscriptions":[]}));
}
