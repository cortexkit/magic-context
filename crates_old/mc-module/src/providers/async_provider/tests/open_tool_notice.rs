//! A notice through an assistant `tool_use` whose result is not written yet.
//! compaction-provider §5 has the runner send a notice after every durable
//! write, that one included, so the notice is accepted like any other: it
//! completes without an error, and nothing compacts through the open arc.
use super::*;

fn decision_line(rig: &Rig, seq: u64) -> String {
    let marker = format!(" notice seq={seq} ");
    rig.h
        .provider_store
        .async_runtime
        .decision_lines
        .lock()
        .unwrap()
        .iter()
        .rfind(|line| line.contains(&marker))
        .cloned()
        .unwrap_or_default()
}

#[tokio::test]
async fn a_notice_through_an_open_tool_use_completes_and_compacts_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open(
        dir.path(),
        "thalamus",
        "claude-code",
        json!({"serializer_profile":"anthropic-messages"}),
    )
    .await;
    // Six messages: the last is an assistant turn ending in `tool_use`.
    *rig.runner.entries.lock().unwrap() = anthropic_transcript(6);
    let last = rig
        .runner
        .entries
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .message
        .clone();
    assert_eq!(last["content"][2]["type"], "tool_use", "{last}");
    // Usage far past the execute threshold: only the open arc holds the
    // pass back.
    rig.notice(1, 90_000, None).await;
    let state = rig.state();
    assert_eq!(state.completed_seq, 1, "the notice completes");
    assert!(state.failure.is_none());
    assert_eq!(rig.newest(), None, "nothing compacts through the open arc");
    let line = decision_line(&rig, 1);
    assert!(
        line.starts_with("async decision defer ") && line.contains("why=waiting_for_tool_result"),
        "{line}"
    );
    // The tool result is written; its notice runs the pass.
    *rig.runner.entries.lock().unwrap() = anthropic_transcript(7);
    rig.notice(2, 90_000, None).await;
    let state = rig.state();
    assert_eq!(state.completed_seq, 2);
    assert!(!state.engine_failed && state.failure.is_none());
    assert!(
        !decision_line(&rig, 2).contains("waiting_for_tool_result"),
        "{}",
        decision_line(&rig, 2)
    );
}
