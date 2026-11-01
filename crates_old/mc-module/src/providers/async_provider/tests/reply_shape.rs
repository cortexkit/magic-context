//! ck-mc's own compaction-provider replies are the bare answer, exactly as
//! served today: `{"answer": ...}` at the top level, never inside a
//! `{"result": ...}` envelope. (The llm-runner replies ck-mc reads are the
//! other way round; see `session_resolver::read_runner_reply`.)
use super::*;

fn bare(method: &str, reply: &Value) {
    let object = reply
        .as_object()
        .unwrap_or_else(|| panic!("{method}: {reply}"));
    assert!(object.contains_key("answer"), "{method}: {reply}");
    assert!(!object.contains_key("result"), "{method}: {reply}");
    serde_json::from_value::<Value>(reply.clone()).unwrap();
}

#[tokio::test]
async fn compaction_provider_replies_are_the_bare_answer() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let setup = rig
        .op("compaction.setup", setup_request("s", "again"))
        .await;
    bare("compaction.setup", &setup);
    serde_json::from_value::<contract::setup::SetupAnswer>(setup).unwrap();

    rig.fill(12);
    rig.notice(1, 1_000, None).await;
    // The newest published view, or version 1, which then answers `refuse`:
    // either answer is bare.
    let version = rig.newest().unwrap_or(1);
    let got = rig
        .op(
            "view.get",
            json!({"session_ref":rig.reference,"view_version":version}),
        )
        .await;
    bare("view.get", &got);
    serde_json::from_value::<view::ViewGetAnswer>(got).unwrap();

    let ride = rig
        .op(
            "compaction.ride",
            json!({"session_ref":rig.reference,"cause":"ceiling","deadline_ms":10_000}),
        )
        .await;
    bare("compaction.ride", &ride);
    serde_json::from_value::<ride::RideAnswer>(ride).unwrap();
}
