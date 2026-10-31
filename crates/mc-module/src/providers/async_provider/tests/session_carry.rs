use super::*;
use crate::offline_move::tests as fixture;

pub(super) fn seed_host_data(path: &Path, session: &str, project: &Path) {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute("INSERT INTO notes(type,status,content,session_id,project_path,created_at,updated_at) VALUES('session','active','prehistoric session note',?1,?2,1,1)",rusqlite::params![session,project.to_str().unwrap()]).unwrap();
    conn.execute("INSERT INTO message_history_fts(session_id,message_ordinal,message_id,role,content) VALUES(?1,1,'pre-move-raw','user','prehistoric narwhal message')",[session]).unwrap();
    conn.execute("INSERT INTO message_fts_rowid_map(session_id,message_ordinal,fts_rowid,message_time_ms) VALUES(?1,1,last_insert_rowid(),123)",[session]).unwrap();
}

fn assert_raw_search(store: &McStore, namespace: &str) {
    store.with_context_read(|conn| {
        assert_eq!(conn.query_row("SELECT count(*) FROM message_history_fts WHERE message_history_fts MATCH 'narwhal' AND session_id=?1",[namespace],|row|row.get::<_,i64>(0))?,1);
        Ok(())
    }).unwrap();
}

#[tokio::test]
async fn carry_move_setup_exposes_pre_move_note_and_raw_message() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, answer) =
        moved_session::moved_rig_stage_with_data(dir.path(), true, true, true).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    let note = rig.tool(7, "ctx_note", json!({"action":"read"})).await;
    assert_eq!(note["isError"], false, "{note}");
    assert!(
        note["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("prehistoric session note"),
        "{note}"
    );
    assert_raw_search(rig.h.store.get().unwrap(), &rig.state().namespace());
}

#[tokio::test]
async fn carry_non_moved_generation_keeps_session_notes() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let written = rig
        .tool(
            7,
            "ctx_note",
            json!({"action":"write","content":"generation durable note"}),
        )
        .await;
    assert_eq!(written["isError"], false, "{written}");
    let old = rig.state().namespace();
    *rig.runner.lineage.lock().unwrap() = "L2".into();
    let mut request = setup_request("s", "new-generation");
    request["lineage_id"] = json!("L2");
    let answer = rig.op("compaction.setup", request).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert_ne!(rig.state().namespace(), old);
    let note = rig.tool(7, "ctx_note", json!({"action":"read"})).await;
    assert!(
        note["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("generation durable note"),
        "{note}"
    );
}

#[tokio::test]
async fn carry_moved_generation_keeps_post_move_summary_and_manifest_precedence() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _) = moved_session::moved_rig(dir.path(), true).await;
    rig.notice(1, 1_000, None).await;
    moved_session::settle_historian(&rig).await;
    let store = rig.h.store.get().unwrap();
    let old = rig.state().namespace();
    let imported = store.load_compartments(&old).unwrap();
    let mut history = imported.clone();
    history[0].content = "old namespace must not overwrite the manifest".into();
    let mut later = history.last().unwrap().clone();
    later.sequence += 1;
    later.start_message = later.end_message + 1;
    later.end_message = later.start_message;
    let held = rig.state();
    let mid = &held.entries.get(&(later.start_message as u64)).unwrap().mid;
    later.start_message_id = format!("{mid}#0");
    later.end_message_id = later.start_message_id.clone();
    later.content = "summary written after the move".into();
    later.p1 = Some(later.content.clone());
    history.push(later);
    store.replace_compartments(&old, &history).unwrap();
    *rig.runner.lineage.lock().unwrap() = "L2".into();
    let mut request = setup_request(&fixture::fixture_session(), "gen2-history");
    request["lineage_id"] = json!("L2");
    let answer = rig.op("compaction.setup", request).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    rig.notice(2, 1_000, None).await;
    moved_session::settle_historian(&rig).await;
    let target = store.load_compartments(&rig.state().namespace()).unwrap();
    assert_eq!(target[0].content, imported[0].content);
    assert!(
        target
            .iter()
            .any(|row| row.content == "summary written after the move"),
        "{target:?}"
    );
}

#[tokio::test]
async fn carry_legacy_moved_record_catches_up_once_without_render_changes() {
    for via_setup in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let (rig, _) = moved_session::moved_rig(dir.path(), true).await;
        rig.notice(1, 1_000, None).await;
        moved_session::settle_historian(&rig).await;
        let store = rig.h.store.get().unwrap();
        let mut state = rig.state();
        let namespace = state.namespace();
        let initial = state.initial.clone();
        let engine = serde_json::to_value(&state.engine).unwrap();
        let meta = serde_json::to_value(store.load_meta(&namespace).unwrap().meta).unwrap();
        state.standalone_move.as_mut().unwrap().carry_version = 0;
        state.save(store, &[]).unwrap();
        rig.h
            .provider_store
            .async_runtime
            .resident
            .lock()
            .unwrap()
            .forget(&rig.reference);
        seed_host_data(
            &dir.path().join("context.db"),
            &fixture::fixture_session(),
            dir.path(),
        );
        if via_setup {
            let answer = rig
                .op(
                    "compaction.setup",
                    setup_request(&fixture::fixture_session(), "catch-up"),
                )
                .await;
            assert_eq!(answer["answer"], "ready", "{answer}");
        } else {
            rig.notice(2, 1_000, None).await;
        }
        let mut caught = rig.state();
        assert_eq!(
            caught.standalone_move.as_ref().unwrap().carry_version,
            mc_store::session_carry::CARRY_VERSION
        );
        assert!(!caught.catch_up_moved_session_data(store).unwrap());
        assert_eq!(caught.initial, initial);
        assert_eq!(serde_json::to_value(&caught.engine).unwrap(), engine);
        assert_eq!(
            serde_json::to_value(store.load_meta(&namespace).unwrap().meta).unwrap(),
            meta
        );
        assert_raw_search(store, &namespace);
        assert_eq!(
            store
                .read_glance_notes(dir.path().to_str().unwrap(), &namespace, &["active"], &[])
                .unwrap()
                .len(),
            1
        );
    }
}
