use super::*;
use crate::providers::offline_first_pass_engine as offline;
use crate::session_resolver::ProviderRunner;

fn vector() -> Value {
    serde_json::from_str(
        cortexkit_role_llm_runner::vectors::file("message-checkpoint.json").unwrap(),
    )
    .unwrap()
}

fn moved_paths(dir: &Path) -> offline_move::StorePaths {
    let paths = fixture::write_moved_session_stores(dir);
    super::super::moved_session::apply_certified_move(&paths);
    paths
}

fn change_record(paths: &offline_move::StorePaths, edit: impl FnOnce(&mut Value)) {
    let conn = rusqlite::Connection::open(&paths.context_db).unwrap();
    let raw = offline_move::read_move_record_raw(&conn, &fixture::fixture_session())
        .unwrap()
        .unwrap();
    let mut value = serde_json::from_str(&raw).unwrap();
    edit(&mut value);
    conn.execute(
        "UPDATE schema_migrations_meta SET value=?1 WHERE key=?2",
        rusqlite::params![
            value.to_string(),
            offline_move::move_record_key(&fixture::fixture_session()),
        ],
    )
    .unwrap();
}

// Compare logical contents rather than database file bytes: opening SQLite can
// checkpoint a WAL without changing any stored row.
fn snapshot(dir: &Path) -> Vec<Vec<(String, Vec<String>)>> {
    ["opencode.db", "context.db", "store.db"]
        .iter()
        .map(|name| {
            let conn = rusqlite::Connection::open(dir.join(name)).unwrap();
            let tables = conn
                .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .unwrap()
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            tables
                .into_iter()
                .map(|table| {
                    let mut query = conn
                        .prepare(&format!("SELECT * FROM \"{}\"", table.replace('"', "\"\"")))
                        .unwrap();
                    let columns = query.column_count();
                    let mut rows = query
                        .query_map([], |row| {
                            Ok((0..columns)
                                .map(|column| format!("{:?}", row.get_ref(column).unwrap()))
                                .collect::<Vec<_>>()
                                .join("|"))
                        })
                        .unwrap()
                        .collect::<rusqlite::Result<Vec<_>>>()
                        .unwrap();
                    rows.sort();
                    (table, rows)
                })
                .collect()
        })
        .collect()
}

async fn setup(
    dir: &Path,
    runner: Arc<Runner>,
    params: Value,
) -> (Rig, Value, Vec<Vec<(String, Vec<String>)>>) {
    let session = fixture::fixture_session();
    let mut before = None;
    let (rig, answer) = Rig::try_setup_with_model(
        dir,
        MODULE,
        ("runner", &session),
        ("opencode", &session),
        "fixture",
        params,
        |h| {
            h.provider_runner = runner.clone();
            before = Some(snapshot(dir));
        },
    )
    .await;
    if answer["answer"] == "ready" {
        *runner.setup_checkpoint.lock().unwrap() =
            serde_json::from_value::<SetupAnswer>(answer.clone())
                .unwrap()
                .checkpoint()
                .cloned();
    }
    (rig, answer, before.unwrap())
}

fn runner(dir: &Path) -> Arc<Runner> {
    Arc::new(Runner {
        module: MODULE.into(),
        lineage: Mutex::new("L".into()),
        marker_db: Some(dir.join("opencode.db")),
        ..Default::default()
    })
}

fn assert_no_adoption(
    rig: &Rig,
    runner: &Runner,
    answer: &Value,
    code: &str,
    before: Vec<Vec<(String, Vec<String>)>>,
    dir: &Path,
) {
    assert_eq!(answer["code"], code, "{answer}");
    assert!(load_head(rig.h.store.get().unwrap(), &rig.reference)
        .unwrap()
        .is_none());
    assert!(runner.sent.lock().unwrap().is_empty());
    assert!(runner.reads.lock().unwrap().is_empty());
    assert!(
        crate::providers::session_runner_fake::FakeSessionRunner::for_project(dir)
            .sends()
            .is_empty(),
        "refused Setup started a model request"
    );
    assert_eq!(snapshot(dir), before, "refused Setup wrote a store");
}

#[tokio::test]
async fn published_checkpoint_vector_is_the_unchanged_setup_answer_on_repeated_setups() {
    let dir = tempfile::tempdir().unwrap();
    let paths = moved_paths(dir.path());
    let checkpoint = vector()["setup"][1].clone();
    change_record(&paths, |record| {
        record["tag_checkpoint"] = checkpoint["tag_checkpoint"].clone();
        record["cut"] = checkpoint["cut"].clone();
        record["message_count"] = checkpoint["message_count"].clone();
        record["head_cut"] = checkpoint["head_cut"].clone();
        // The Setup engine pass now renders the imported history head, so the
        // manifest's compartments must cover the certified prefix. Cover the
        // whole `[0, message_count)` prefix with one summary whose boundary
        // is the certified head cut; the checkpoint wire test does not assert
        // history bytes.
        let count = checkpoint["message_count"].as_u64().expect("count");
        let mid = checkpoint["head_cut"]["mid"]
            .as_str()
            .expect("mid")
            .to_owned();
        record["compartments"] = json!([{
            "sequence": 1,
            "start_position": 1,
            "end_position": count,
            "start_message_id": "m0",
            "end_message_id": mid,
            "start_block": 0,
            "end_block": 0,
            "title": "history",
            "content": "vector history",
            "p1": "vector history",
            "p2": null,
            "p3": null,
            "p4": null,
            "importance": 50,
            "episode_type": "summary",
            "legacy": 0,
            "created_at": 1
        }]);
    });
    let runner = runner(dir.path());
    *runner.head_override.lock().unwrap() =
        Some(json!({"lineage_id":"L","first_ordinal":42,"cut":checkpoint["head_cut"]}));
    let (rig, answer, _) = setup(
        dir.path(),
        runner.clone(),
        json!({"serializer_profile":"opencode-aisdk"}),
    )
    .await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert_eq!(answer["checkpoint"], checkpoint);
    let decoded: SetupAnswer = serde_json::from_value(answer).unwrap();
    assert_eq!(
        serde_json::to_value(decoded.checkpoint().unwrap()).unwrap(),
        checkpoint
    );
    for lineage in ["L", "L"] {
        let mut request = setup_request(&fixture::fixture_session(), "again");
        request["lineage_id"] = json!(lineage);
        let again = rig.op("compaction.setup", request).await;
        assert_eq!(again["checkpoint"], checkpoint, "{again}");
    }
}

#[tokio::test]
async fn setup_admits_only_a_readable_completed_move_and_matching_codec() {
    for (field, value, code) in [
        ("state", json!("relocating"), "move_in_progress"),
        ("state", json!("future"), "move_record_state_unknown"),
        (
            "message_count",
            json!("not-a-count"),
            "move_record_unreadable",
        ),
        (
            "codec_profile",
            json!({"serializer":"pi","native_index":"part_index"}),
            "moved_session_codec_mismatch",
        ),
        (
            "codec_profile",
            json!({"serializer":"opencode-aisdk","native_index":"different"}),
            "moved_session_codec_mismatch",
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let paths = moved_paths(dir.path());
        change_record(&paths, |record| record[field] = value);
        let runner = runner(dir.path());
        let (rig, answer, before) = setup(
            dir.path(),
            runner.clone(),
            json!({"serializer_profile":"opencode-aisdk"}),
        )
        .await;
        assert_no_adoption(&rig, &runner, &answer, code, before, dir.path());
    }
}

#[tokio::test]
async fn changed_certified_head_digest_refuses_before_import() {
    let dir = tempfile::tempdir().unwrap();
    moved_paths(dir.path());
    let runner = runner(dir.path());
    let marker = super::super::moved_session::newest_marker_checkpoint(
        &dir.path().join("opencode.db"),
        &fixture::fixture_session(),
    )
    .unwrap();
    let mut head = serde_json::to_value(marker.head_cut.unwrap()).unwrap();
    head["digest"] = json!("changed-digest");
    *runner.head_override.lock().unwrap() =
        Some(json!({"lineage_id":"L","first_ordinal":6,"cut":head}));
    let (rig, answer, before) = setup(
        dir.path(),
        runner.clone(),
        json!({"serializer_profile":"opencode-aisdk"}),
    )
    .await;
    assert_no_adoption(
        &rig,
        &runner,
        &answer,
        "moved_session_head_mismatch",
        before,
        dir.path(),
    );
}

#[tokio::test]
async fn rich_ui_stamp_moved_session_head() {
    let dir = tempfile::tempdir().unwrap();
    moved_paths(dir.path());
    let runner = runner(dir.path());
    *runner.head_override.lock().unwrap() = Some(crate::tests::broca_rich_ui_stamp::answer(
        "session.head.json",
    ));
    let (rig, answer, before) = setup(
        dir.path(),
        runner.clone(),
        json!({"serializer_profile":"opencode-aisdk"}),
    )
    .await;
    // The captured session has no moved prefix. Decoding must reach the
    // certified-prefix check, not reject the added head metadata.
    assert_no_adoption(
        &rig,
        &runner,
        &answer,
        "moved_session_reverted_below_import",
        before,
        dir.path(),
    );
}

#[tokio::test]
async fn setup_checks_the_complete_head_and_prefix_origin() {
    for (first, field, value, code) in [
        (
            5,
            "mid",
            json!("msg_m006"),
            "moved_session_reverted_below_import",
        ),
        (7, "mid", json!("msg_m006"), "moved_session_head_mismatch"),
        (
            6,
            "mid",
            json!("other-message"),
            "moved_session_head_mismatch",
        ),
        (6, "written_at", json!(0), "moved_session_head_mismatch"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        moved_paths(dir.path());
        let runner = runner(dir.path());
        let marker = super::super::moved_session::newest_marker_checkpoint(
            &dir.path().join("opencode.db"),
            &fixture::fixture_session(),
        )
        .unwrap();
        let mut head = serde_json::to_value(marker.head_cut.unwrap()).unwrap();
        head[field] = value;
        *runner.head_override.lock().unwrap() =
            Some(json!({"lineage_id":"L","first_ordinal":first,"cut":head}));
        let (rig, answer, before) = setup(
            dir.path(),
            runner.clone(),
            json!({"serializer_profile":"opencode-aisdk"}),
        )
        .await;
        assert_no_adoption(&rig, &runner, &answer, code, before, dir.path());
    }
}

#[tokio::test]
async fn a_first_live_setup_without_message_checkpoint_stores_nothing() {
    let dir = tempfile::tempdir().unwrap();
    moved_paths(dir.path());
    let runner = runner(dir.path());
    runner
        .withholds_message_checkpoint
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let (rig, answer, before) = setup(
        dir.path(),
        runner.clone(),
        json!({"serializer_profile":"opencode-aisdk"}),
    )
    .await;
    assert_no_adoption(
        &rig,
        &runner,
        &answer,
        "message_checkpoint_unsupported",
        before,
        dir.path(),
    );
    assert_eq!(decoded_retryable(&answer), Some(false));
    assert_eq!(runner.heads.load(std::sync::atomic::Ordering::Relaxed), 0);
}

#[tokio::test]
async fn repeated_setup_still_requires_message_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    moved_paths(dir.path());
    let runner = runner(dir.path());
    let (rig, answer, _) = setup(
        dir.path(),
        runner.clone(),
        json!({"serializer_profile":"opencode-aisdk"}),
    )
    .await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    let before = snapshot(dir.path());
    runner
        .withholds_message_checkpoint
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let answer = rig
        .op(
            "compaction.setup",
            setup_request(&fixture::fixture_session(), "again"),
        )
        .await;
    assert_eq!(answer["code"], "message_checkpoint_unsupported", "{answer}");
    assert!(runner.sent.lock().unwrap().is_empty());
    assert!(
        crate::providers::session_runner_fake::FakeSessionRunner::for_project(dir.path())
            .sends()
            .is_empty()
    );
    assert_eq!(snapshot(dir.path()), before);
}

#[tokio::test]
async fn setup_head_uses_newest_marker_then_stored_checkpoint_and_refuses_neither() {
    let dir = tempfile::tempdir().unwrap();
    let paths = moved_paths(dir.path());
    let runner = runner(dir.path());
    let (rig, first, _) = setup(
        dir.path(),
        runner.clone(),
        json!({"serializer_profile":"opencode-aisdk"}),
    )
    .await;
    assert_eq!(first["answer"], "ready", "{first}");
    assert_eq!(runner.heads.load(std::sync::atomic::Ordering::Relaxed), 1);
    assert!(runner.setup_checkpoint.lock().unwrap().is_some());
    let conn = rusqlite::Connection::open(&paths.opencode_db).unwrap();
    conn.execute("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES('new-marker',?1,999999,999999,'{\"role\":\"user\"}')", [&fixture::fixture_session()]).unwrap();
    conn.execute("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data)
        SELECT 'new-marker-part','new-marker',session_id,999999,999999,json_set(data,'$.cortexkit.head_cut.digest','newest-digest')
        FROM part WHERE json_extract(data,'$.cortexkit.message_count') IS NOT NULL LIMIT 1", []).unwrap();
    let before = snapshot(dir.path());
    let newest = rig
        .op(
            "compaction.setup",
            setup_request(&fixture::fixture_session(), "newest"),
        )
        .await;
    assert_eq!(newest["code"], "moved_session_head_mismatch", "{newest}");
    assert_eq!(snapshot(dir.path()), before);
    conn.execute("DELETE FROM part WHERE id='new-marker-part'", [])
        .unwrap();
    conn.execute("DELETE FROM message WHERE id='new-marker'", [])
        .unwrap();
    conn.execute("UPDATE part SET data=json_remove(data,'$.cortexkit') WHERE json_extract(data,'$.type')='compaction'", []).unwrap();
    let again = rig
        .op(
            "compaction.setup",
            setup_request(&fixture::fixture_session(), "stored"),
        )
        .await;
    assert_eq!(again["answer"], "ready", "{again}");
    *runner.setup_checkpoint.lock().unwrap() = None;
    let before = snapshot(dir.path());
    let neither = rig
        .op(
            "compaction.setup",
            setup_request(&fixture::fixture_session(), "neither"),
        )
        .await;
    assert_eq!(
        neither["code"], "moved_session_reverted_below_import",
        "{neither}"
    );
    assert_eq!(snapshot(dir.path()), before);
}

#[test]
fn served_rows_skip_the_published_uncounted_cases_even_at_a_native_marker() {
    let dir = tempfile::tempdir().unwrap();
    let paths = moved_paths(dir.path());
    let conn = rusqlite::Connection::open(&paths.opencode_db).unwrap();
    let session = fixture::fixture_session();
    let vector = vector();
    for row in vector["opencode1"]["rows"].as_array().unwrap() {
        conn.execute("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?1,?2,?3,?3,?4)", rusqlite::params![
            row["id"].as_str().unwrap(), session, row["time_created"].as_i64().unwrap() + 100_000, row["data"].as_str().unwrap(),
        ]).unwrap();
    }
    for (index, row) in vector["opencode1"]["parts"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        conn.execute("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?1,?2,?3,100000,100000,?4)", rusqlite::params![
            format!("vector_{index:04}"), row["message_id"].as_str().unwrap(), session, row["data"].as_str().unwrap(),
        ]).unwrap();
    }
    // Counting uses stored part types, not the marker's source or whether it
    // carries a checkpoint key.
    conn.execute("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES('numeric-finished',?1,200000,200000,'{\"summary\":1.0,\"finish\":\"stop\"}')", [&session]).unwrap();
    let entries = super::super::moved_session::served_entries(&paths.opencode_db, &session);
    let ids: Vec<_> = entries
        .iter()
        .filter(|entry| !entry.mid.starts_with("msg_"))
        .map(|entry| entry.mid.as_str())
        .collect();
    assert_eq!(
        serde_json::to_value(ids).unwrap(),
        vector["opencode1"]["counted_ids"]
    );
}

#[tokio::test]
async fn offline_first_pass_setup_without_message_checkpoint_stores_nothing() {
    let dir = tempfile::tempdir().unwrap();
    moved_paths(dir.path());
    let runner = runner(dir.path());
    runner
        .withholds_message_checkpoint
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let (rig, answer, _) = setup(
        dir.path(),
        runner.clone(),
        json!({"serializer_profile":"opencode-aisdk"}),
    )
    .await;
    assert_eq!(answer["code"], "message_checkpoint_unsupported");
    let before = snapshot(dir.path());
    let binding = rig.h.facade_binding(7).unwrap();
    let request = setup_request(&fixture::fixture_session(), "offline");
    let setup_answer: Value =
        serde_json::from_slice(&rig.h.async_setup(1, &binding, &request).await.unwrap()).unwrap();
    assert_eq!(
        setup_answer["code"], "message_checkpoint_unsupported",
        "{setup_answer}"
    );
    let description = runner
        .call(
            dir.path(),
            &fixture::fixture_session(),
            "role.describe",
            json!({}),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
    let offline = offline::OfflineSetup {
        project_root: dir.path().into(),
        runner_module: MODULE.into(),
        runner_describe: description,
        request: serde_json::from_value(request).unwrap(),
    };
    match rig.h.offline_first_pass(&offline).await {
        Err(offline::OfflineError::Refused("setup_refused", detail)) => {
            assert!(
                detail.contains("message_checkpoint_unsupported"),
                "{detail}"
            );
        }
        other => panic!("unexpected offline result: {other:?}"),
    }
    assert_no_adoption(
        &rig,
        &runner,
        &setup_answer,
        "message_checkpoint_unsupported",
        before,
        dir.path(),
    );
    assert_eq!(runner.heads.load(std::sync::atomic::Ordering::Relaxed), 0);
}

#[tokio::test]
async fn setup_with_a_different_serializer_refuses_before_import() {
    let dir = tempfile::tempdir().unwrap();
    moved_paths(dir.path());
    let runner = runner(dir.path());
    let (rig, answer, before) = setup(
        dir.path(),
        runner.clone(),
        json!({"serializer_profile":"pi"}),
    )
    .await;
    assert_no_adoption(
        &rig,
        &runner,
        &answer,
        "moved_session_codec_mismatch",
        before,
        dir.path(),
    );
    assert_eq!(runner.heads.load(std::sync::atomic::Ordering::Relaxed), 0);
}
