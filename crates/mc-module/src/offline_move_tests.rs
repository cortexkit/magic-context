//! Offline move tests. The source stores come from
//! `testdata/mode3_move_fixture.json`, which the standalone plugin's own writers
//! produce (`packages/plugin/src/features/magic-context/mode3-move-fixture.test.ts`
//! regenerates it and fails when it is stale).
use super::*;
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use std::collections::BTreeSet;

pub(crate) const FIXTURE: &str = include_str!("../testdata/mode3_move_fixture.json");

pub(crate) fn fixture() -> Value {
    serde_json::from_str(FIXTURE).unwrap()
}

pub(crate) fn fixture_session() -> String {
    fixture()["session"].as_str().unwrap().to_owned()
}

/// No other process holds anything: the test's own connections are excluded the
/// same way `Lsof` excludes this process.
pub(crate) struct NoHolders;
impl HolderCheck for NoHolders {
    fn holders(&self, _: &[PathBuf]) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
}

struct Held(&'static str);
impl HolderCheck for Held {
    fn holders(&self, _: &[PathBuf]) -> Result<Vec<String>, String> {
        Ok(vec![self.0.to_owned()])
    }
}

fn sql_value(value: &Value) -> rusqlite::types::Value {
    match value {
        Value::Null => rusqlite::types::Value::Null,
        Value::Bool(flag) => rusqlite::types::Value::Integer(i64::from(*flag)),
        Value::Number(n) if n.is_i64() => rusqlite::types::Value::Integer(n.as_i64().unwrap()),
        Value::Number(n) => rusqlite::types::Value::Real(n.as_f64().unwrap()),
        Value::String(text) => rusqlite::types::Value::Text(text.clone()),
        other => rusqlite::types::Value::Text(other.to_string()),
    }
}

pub(crate) fn insert_rows(conn: &Connection, table: &str, rows: &[Value]) {
    for row in rows {
        let row = row.as_object().unwrap();
        let columns = row.keys().cloned().collect::<Vec<_>>();
        let marks = (1..=columns.len())
            .map(|n| format!("?{n}"))
            .collect::<Vec<_>>()
            .join(",");
        let values = row.values().map(sql_value).collect::<Vec<_>>();
        conn.execute(
            &format!(
                "INSERT INTO {table} ({}) VALUES ({marks})",
                columns.join(",")
            ),
            rusqlite::params_from_iter(values),
        )
        .unwrap_or_else(|error| panic!("{table}: {error}"));
    }
}

pub(crate) fn store_descriptor(dir: &Path) -> StorageDescriptor {
    StorageDescriptor {
        module_id: crate::DEFAULT_MODULE_ID.into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.join("store.db").to_string_lossy().into(),
        },
    }
}

/// Write the fixture's three stores under `dir`: `store.db` and `context.db` from
/// ck-mc's own opener (its context schema is the plugin's current one), then the
/// standalone rows, and an OpenCode 1 `opencode.db`.
pub(crate) fn write_stores(dir: &Path) -> StorePaths {
    let fixture = fixture();
    drop(mc_store::McStore::open_for_test(&store_descriptor(dir)).unwrap());
    let context = Connection::open(dir.join("context.db")).unwrap();
    for (table, rows) in fixture["context"].as_object().unwrap() {
        insert_rows(&context, table, rows.as_array().unwrap());
    }
    let opencode = Connection::open(dir.join("opencode.db")).unwrap();
    // The fixture copies OpenCode's message and part tables; their foreign keys
    // name a session table it does not copy, so a minimal one stands in.
    opencode
        .execute_batch("CREATE TABLE session (id text PRIMARY KEY)")
        .unwrap();
    opencode
        .execute(
            "INSERT INTO session(id) VALUES (?1)",
            [fixture["session"].as_str().unwrap()],
        )
        .unwrap();
    opencode
        .execute_batch(fixture["opencode"]["schema"].as_str().unwrap())
        .unwrap();
    for table in ["message", "part"] {
        insert_rows(
            &opencode,
            table,
            fixture["opencode"][table].as_array().unwrap(),
        );
    }
    StorePaths {
        opencode_db: dir.join("opencode.db"),
        context_db: dir.join("context.db"),
        store_db: dir.join("store.db"),
    }
}

/// The plugin fixture includes a queued file drop. Successful move tests remove
/// that stamp explicitly: files have no runner tag and cannot be carried.
fn write_movable_stores(dir: &Path) -> StorePaths {
    let paths = write_stores(dir);
    Connection::open(&paths.context_db)
        .unwrap()
        .execute("DELETE FROM pending_ops WHERE tag_id=15", [])
        .unwrap();
    paths
}

/// Movable stores with the marker already on the selected cut, including the
/// plugin's summary time at one tick after its boundary user message.
pub(crate) fn write_moved_session_stores(dir: &Path) -> StorePaths {
    let paths = write_movable_stores(dir);
    host_sql(&paths, "UPDATE part SET message_id='msg_m007',time_created=7000,time_updated=7000 WHERE json_extract(data,'$.type')='compaction';
        UPDATE message SET data=json_set(data,'$.parentID','msg_m007','$.time.created',7001,'$.time.completed',7001),time_created=7001,time_updated=7001 WHERE json_extract(data,'$.summary')=1;
        UPDATE part SET time_created=7001,time_updated=7001 WHERE message_id IN (SELECT id FROM message WHERE json_extract(data,'$.summary')=1)");
    context_sql(&paths, "UPDATE session_meta SET compaction_marker_state=json_set(compaction_marker_state,'$.boundaryMessageId','msg_m007','$.boundaryOrdinal',7)");
    paths
}

/// The worked digest vector from SUBC's `message-checkpoint.json`
/// (`cortexkit-role-llm-runner` 0.7.17, `test-vectors/llm-runner-v1`). The
/// digest is opaque to ck-mc: the move checks only `mid` and `message_count`
/// and records the whole cut exactly as certified.
const VECTOR_DIGEST: &str = "189f89a46681c05dac35fe71f4e46c1a8cb5a0c0882b1d5f4cc80ce3f4582ca9";
const VECTOR_WRITTEN_AT: u64 = 1793145600123;

/// Write `certificate` to a temp file for `--head-cut` and return its path.
/// The dir lives as long as the returned path needs it: the caller keeps the
/// tempdir alive across the apply call.
fn write_cert_file(dir: &Path, certificate: &Value) -> PathBuf {
    let path = dir.join("head-cut.json");
    std::fs::write(&path, certificate.to_string()).unwrap();
    path
}

fn valid_cert_value(plan: &Plan) -> Value {
    json!({
        "session": fixture_session(),
        "cut": plan.record.cut,
        "message_count": plan.message_count,
        "head_cut": {
            "mid": plan.p,
            "digest": VECTOR_DIGEST,
            "written_at": VECTOR_WRITTEN_AT,
        },
    })
}

/// Capture every database and WAL, not just the rows the writer currently edits.
/// SQLite's disposable shared-memory index is not persistent store content.
fn all_store_bytes(paths: &StorePaths) -> Vec<(PathBuf, Option<Vec<u8>>)> {
    database_files(paths)
        .into_iter()
        .filter(|path| !path.to_string_lossy().ends_with("-shm"))
        .map(|path| {
            let bytes = std::fs::read(&path).ok();
            (path, bytes)
        })
        .collect()
}

fn relocated_marker_data(paths: &StorePaths, part: &str) -> Value {
    let conn = Connection::open(&paths.opencode_db).unwrap();
    let data: String = conn
        .query_row("SELECT data FROM part WHERE id=?1", [part], |row| {
            row.get(0)
        })
        .unwrap();
    serde_json::from_str(&data).unwrap()
}

fn host_message_row(paths: &StorePaths, mid: &str) -> (String, i64, i64, String) {
    let conn = Connection::open(&paths.opencode_db).unwrap();
    conn.query_row(
        "SELECT id, time_created, time_updated, data FROM message WHERE id=?1",
        [mid],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )
    .unwrap()
}

fn host_part_row(paths: &StorePaths, pid: &str) -> (String, String, String, i64, i64, String) {
    let conn = Connection::open(&paths.opencode_db).unwrap();
    conn.query_row(
        "SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE id=?1",
        [pid],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        },
    )
    .unwrap()
}

fn record(paths: &StorePaths) -> Option<String> {
    let conn = Connection::open(&paths.context_db).unwrap();
    read_move_record_raw(&conn, &fixture_session()).unwrap()
}

/// Every row the move may touch, so two runs can be compared.
fn snapshot(paths: &StorePaths) -> (Vec<(String, String)>, Option<String>) {
    let conn = Connection::open(&paths.opencode_db).unwrap();
    let mut statement = conn
        .prepare("SELECT id, data FROM part UNION ALL SELECT id, data FROM message ORDER BY 1")
        .unwrap();
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    (rows, record(paths))
}

fn moved(paths: &StorePaths) -> Plan {
    // The certified path: plan read-only, then apply with the export
    // certificate. The digest comes from SUBC's vector and is recorded as
    // certified; only `mid` and `message_count` are checked.
    let plan = plan(paths, &fixture_session()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let cert = write_cert_file(dir.path(), &valid_cert_value(&plan));
    match run_with_head_cut(paths, &fixture_session(), &cert, &NoHolders, None).unwrap() {
        Outcome::Moved(plan) => plan,
        other => panic!("{other:?}"),
    }
}

fn refusal(paths: &StorePaths) -> Refusal {
    let before = all_store_bytes(paths);
    let refused = match run(paths, &fixture_session(), false, &NoHolders, None) {
        Err(MoveError::Refused(refusal)) => refusal,
        other => panic!("expected a refusal, got {other:?}"),
    };
    assert_eq!(
        all_store_bytes(paths),
        before,
        "{} wrote a store",
        refused.code
    );
    refused
}

fn pairs(value: &Value) -> BTreeSet<(String, String)> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| {
            (
                pair["mid"].as_str().unwrap().to_owned(),
                pair["part"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn host_position(paths: &StorePaths, mid: &str) -> usize {
    let host = load_host_session(
        &open_read_only(&paths.opencode_db).unwrap(),
        &fixture_session(),
    )
    .unwrap();
    host.position[mid]
}

fn carried(record: &MoveRecord, kind: DropKind) -> BTreeSet<(String, String)> {
    record
        .drops
        .iter()
        .filter(|drop| drop.kind == kind)
        .map(|drop| (drop.mid.clone(), drop.part.clone()))
        .collect()
}

#[test]
fn move_carries_summaries_cut_checkpoint_and_drops_after_the_cut() {
    let dir = tempfile::tempdir().unwrap();
    let paths = write_moved_session_stores(dir.path());
    let fixture = fixture();
    let expected = &fixture["expected"];
    let before = snapshot(&paths);
    let plan = moved(&paths);
    let record = plan.record.clone();
    // The highest number standalone ever allocated: twenty counted parts.
    assert_eq!(record.tag_checkpoint, 20);
    assert_eq!(
        record.tag_checkpoint,
        expected["tag_checkpoint"].as_u64().unwrap()
    );
    assert_eq!(record.cut, "msg_m007");
    assert_eq!(plan.p, "msg_m006");
    assert_eq!(plan.message_count, 6);
    // The move record is versioned with state `moved`: `cut` is `U`,
    // `message_count` is the counted prefix length, and `head_cut` is exactly
    // the certified `P` triple. The digest is opaque and recorded as given.
    assert_eq!(record.version, RECORD_VERSION);
    assert_eq!(record.state, MoveState::Moved);
    assert_eq!(record.p, "msg_m006");
    assert_eq!(record.message_count, 6);
    assert_eq!(record.head_cut.mid, "msg_m006");
    assert_eq!(record.head_cut.digest, VECTOR_DIGEST);
    assert_eq!(record.head_cut.written_at, VECTOR_WRITTEN_AT);
    // The intent holds the codec profile, the three rows before and after with
    // their ids, the imported summaries with positions and CK block ids, the
    // resolved drops and the tag checkpoint.
    assert_eq!(record.old_compaction_part, plan.old_compaction_part);
    assert_eq!(record.old_summary, plan.old_summary);
    assert_eq!(record.new_summary_id, plan.new_summary_id);
    assert_eq!(record.new_summary_part_id, plan.new_summary_part_id);
    assert_eq!(record.u_time, 7000);
    // The relocated marker ids are the plugin generator's output for
    // `resolvedBoundary = U` and `endMessageId = P`.
    assert_eq!(record.marker_part, "prt_000001b580017vSwDweLmvnis8");
    assert_eq!(plan.new_summary_id, "msg_000001b590011TLOnC0hggUweo");
    assert_eq!(plan.new_summary_part_id, "prt_000001b590020zGA8sPgeGCoLV");
    assert_eq!(plan.u_time, 7000);
    assert_eq!(plan.summary_text, "[Compacted by Magic Context]");
    // The codec profile and per-endpoint CK block ids ride the manifest for
    // the import step. Whole-message endpoints cover the decoded range.
    assert_eq!(record.codec_profile.serializer, "opencode-aisdk");
    assert_eq!(record.codec_profile.native_index, "part_index");
    let source = fixture["context"]["compartments"].as_array().unwrap();
    assert_eq!(record.compartments.len(), source.len());
    for (imported, source) in record.compartments.iter().zip(source) {
        assert_eq!(imported.sequence, source["sequence"].as_i64().unwrap());
        assert_eq!(
            imported.start_message_id,
            source["start_message_id"].as_str().unwrap()
        );
        assert_eq!(
            imported.end_message_id,
            source["end_message_id"].as_str().unwrap()
        );
        assert_eq!(imported.content, source["content"].as_str().unwrap());
        assert_eq!(imported.p1.as_deref(), source["p1"].as_str());
        assert_eq!(imported.p2.as_deref(), source["p2"].as_str());
        assert_eq!(
            imported.importance as i64,
            source["importance"].as_i64().unwrap()
        );
        assert_eq!(
            (imported.start_part.as_ref(), imported.end_part.as_ref()),
            (None, None)
        );
        // The intent holds the imported summaries with their counted positions.
        assert_eq!(
            imported.start_position,
            host_position(&paths, &imported.start_message_id)
        );
        assert_eq!(
            imported.end_position,
            host_position(&paths, &imported.end_message_id)
        );
    }
    // msg_m001 holds one text part; msg_m002 holds reasoning, text and a
    // completed tool (call plus result); msg_m006 holds text and a tool.
    assert_eq!(record.compartments[0].start_block, Some(0));
    assert_eq!(record.compartments[0].end_block, Some(3));
    assert_eq!(record.compartments[1].start_block, Some(0));
    assert_eq!(record.compartments[1].end_block, Some(2));
    assert_eq!(
        record.compartments.last().unwrap().end_message_id,
        expected["coverage_end"].as_str().unwrap()
    );
    // The drops land on the parts the generator chose, by OpenCode part id.
    assert_eq!(
        carried(&record, DropKind::Applied),
        pairs(&expected["applied"])
    );
    assert_eq!(
        carried(&record, DropKind::Queued),
        pairs(&expected["queued"])
            .into_iter()
            .filter(|(_, part)| part != "prt_m009_b")
            .collect()
    );
    assert_eq!(
        plan.behind_cut,
        expected["behind_cut"].as_array().unwrap().len()
    );
    assert!(plan.missing.is_empty(), "{:?}", plan.missing);
    // The oracle: the plugin writer's rows for `resolvedBoundary = U` and
    // `endMessageId = P`, plus exactly the four-member `cortexkit` key. Every
    // other SQL column and JSON byte matches; `U` and every unrelated row stay
    // byte-identical.
    let (old_cut, old_summary, old_compaction, old_summary_part) = (
        plan.marker_carrier.clone(),
        plan.old_summary.clone(),
        plan.old_compaction_part.clone(),
        plan.old_summary_part.clone(),
    );
    let conn = Connection::open(&paths.opencode_db).unwrap();
    // The old carrier keeps its own parts but no longer holds a compaction part.
    let old_carrier_compactions: i64 = conn
        .query_row(
            "SELECT count(*) FROM part WHERE message_id=?1 AND json_extract(data,'$.type')='compaction'",
            [&old_cut],
            |row| row.get(0),
        )
        .unwrap();
    if old_cut != record.cut {
        assert_eq!(
            old_carrier_compactions, 0,
            "{old_cut} still carries a compaction part"
        );
    }
    assert!(
        conn.query_row("SELECT 1 FROM message WHERE id=?1", [&old_summary], |_| Ok(
            ()
        ))
        .optional()
        .unwrap()
        .is_none(),
        "old summary was not deleted"
    );
    for old in [&old_compaction, &old_summary_part] {
        if old.is_empty() {
            continue;
        }
        assert!(
            conn.query_row("SELECT 1 FROM part WHERE id=?1", [old], |_| Ok(()))
                .optional()
                .unwrap()
                .is_none(),
            "old part {old} was not deleted"
        );
    }
    // The oracle rows below were generated by running the plugin's own writer
    // under bun on the fixture's messages (`target/scratch/move-oracle-gen.ts`:
    // temp opencode.db from the fixture, old marker moved onto `U` exactly like
    // `write_moved_session_stores`, then `prepareCompactionMarkerCandidates` +
    // `injectCompactionMarker` with `resolvedBoundary = U`, `endMessageId = P`,
    // the old summary text and directory `/repo`). Every column is asserted byte
    // for byte; the only allowed difference is the appended `cortexkit` member
    // on the compaction part, checked exactly.
    const ORACLE_SUMMARY_ID: &str = "msg_000001b590011TLOnC0hggUweo";
    const ORACLE_SUMMARY_DATA: &str = r#"{"role":"assistant","parentID":"msg_m007","summary":true,"finish":"stop","mode":"compaction","agent":"compaction","path":{"cwd":"/repo","root":"/repo"},"cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"modelID":"magic-context","providerID":"magic-context","time":{"created":7001,"completed":7001}}"#;
    const ORACLE_COMPACTION_ID: &str = "prt_000001b580017vSwDweLmvnis8";
    const ORACLE_COMPACTION_BASE: &str = r#"{"type":"compaction","auto":true}"#;
    const ORACLE_TEXT_ID: &str = "prt_000001b590020zGA8sPgeGCoLV";
    const ORACLE_TEXT_DATA: &str = r#"{"type":"text","text":"[Compacted by Magic Context]"}"#;
    const ORACLE_KEY: &str = r#"{"tag_checkpoint":20,"session":"ses_mode3_move_fixture","message_count":6,"head_cut":{"mid":"msg_m006","digest":"189f89a46681c05dac35fe71f4e46c1a8cb5a0c0882b1d5f4cc80ce3f4582ca9","written_at":1793145600123}}"#;
    assert_eq!(plan.new_summary_id, ORACLE_SUMMARY_ID);
    assert_eq!(record.marker_part, ORACLE_COMPACTION_ID);
    assert_eq!(plan.new_summary_part_id, ORACLE_TEXT_ID);
    let (id, message_id, session_id, created, updated, data) =
        host_part_row(&paths, &record.marker_part);
    assert_eq!(id, ORACLE_COMPACTION_ID);
    assert_eq!(message_id, "msg_m007");
    assert_eq!(session_id, fixture_session());
    assert_eq!((created, updated), (7000, 7000));
    assert_eq!(
        data,
        format!(
            "{},\"cortexkit\":{}}}",
            &ORACLE_COMPACTION_BASE[..ORACLE_COMPACTION_BASE.len() - 1],
            ORACLE_KEY
        )
    );
    let (id, session_id, created, updated, data) = conn
        .query_row(
            "SELECT id, session_id, time_created, time_updated, data FROM message WHERE id=?1",
            [&plan.new_summary_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(id, ORACLE_SUMMARY_ID);
    assert_eq!(session_id, fixture_session());
    assert_eq!((created, updated), (7001, 7001));
    assert_eq!(data, ORACLE_SUMMARY_DATA);
    let (id, message_id, session_id, created, updated, data) =
        host_part_row(&paths, &plan.new_summary_part_id);
    assert_eq!(id, ORACLE_TEXT_ID);
    assert_eq!(message_id, ORACLE_SUMMARY_ID);
    assert_eq!(session_id, fixture_session());
    assert_eq!((created, updated), (7001, 7001));
    assert_eq!(data, ORACLE_TEXT_DATA);
    // `U`'s own message row is untouched; only its new compaction part was added.
    let (mid, created, updated, mdata) = host_message_row(&paths, "msg_m007");
    assert_eq!((mid.as_str(), created, updated), ("msg_m007", 7000, 7000));
    assert_eq!(
        serde_json::from_str::<Value>(&mdata).unwrap(),
        json!({"role": "user", "time": {"created": 7000}})
    );
    // Relocating the marker never changes the counted prefix length.
    let host_after = load_host_session(
        &open_read_only(&paths.opencode_db).unwrap(),
        &fixture_session(),
    )
    .unwrap();
    assert_eq!(host_after.position.get("msg_m006"), Some(&6));
    assert_eq!(host_after.position.get("msg_m007"), Some(&7));
    // Every unrelated row is byte-identical: only the three deleted ids and the
    // three inserted ids differ between the before and after images.
    let after = snapshot(&paths);
    let mut before_map: std::collections::HashMap<String, String> = before.0.into_iter().collect();
    let mut after_map: std::collections::HashMap<String, String> = after.0.into_iter().collect();
    for gone in [&old_summary, &old_compaction, &old_summary_part] {
        if gone.is_empty() {
            continue;
        }
        assert!(before_map.remove(gone).is_some(), "{gone} missing before");
        assert!(!after_map.contains_key(gone), "{gone} not deleted");
    }
    for fresh in [
        plan.new_summary_id.clone(),
        record.marker_part.clone(),
        plan.new_summary_part_id.clone(),
    ] {
        assert!(after_map.remove(&fresh).is_some(), "{fresh} missing after");
        assert!(!before_map.contains_key(&fresh), "{fresh} existed before");
    }
    assert_eq!(before_map, after_map, "an unrelated row changed");
    // The moved record is the stored plan.
    let stored: MoveRecord = serde_json::from_str(&record_of(&paths)).unwrap();
    assert_eq!(stored, record);
}

fn record_of(paths: &StorePaths) -> String {
    record(paths).expect("moved record")
}

#[test]
fn move_dry_run_prints_the_plan_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let paths = write_movable_stores(dir.path());
    // Each database and its WAL, byte for byte. The `-shm` file is SQLite's
    // shared-memory index, which any reader may rebuild; it holds no data.
    let bytes = |paths: &StorePaths| {
        database_files(paths)
            .into_iter()
            .filter(|path| !path.to_string_lossy().ends_with("-shm"))
            .map(|path| {
                let digest = std::fs::read(&path)
                    .ok()
                    .map(|bytes| crate::sha256_hex(&bytes));
                (path.display().to_string(), digest)
            })
            .collect::<Vec<_>>()
    };
    let before = bytes(&paths);
    let Outcome::Planned(plan) = run(&paths, &fixture_session(), true, &NoHolders, None).unwrap()
    else {
        panic!("dry run moved the session");
    };
    assert_eq!(bytes(&paths), before);
    let value = plan.to_value();
    assert_eq!(value["tag_checkpoint"], 20);
    assert_eq!(value["drops"]["applied"], 2);
    assert_eq!(value["drops"]["queued"], 2);
    assert_eq!(value["marker_key"], "to_write");
    assert!(record(&paths).is_none());
}

#[test]
fn move_rerun_after_a_crash_at_each_write_step_ends_identical() {
    // The reference is the certified apply: intent, host and `moved` record.
    let finished = tempfile::tempdir().unwrap();
    let finished = write_moved_session_stores(finished.path());
    moved(&finished);
    let reference = snapshot(&finished);
    let stored: MoveRecord = serde_json::from_str(&record(&finished).unwrap()).unwrap();
    assert_eq!(stored.state, MoveState::Moved);

    // A crash after the `relocating` intent, before the host transaction: the
    // host still matches the before-image. Resuming from the persisted intent
    // alone finishes with byte-identical rows and a `moved` record.
    let crashed = tempfile::tempdir().unwrap();
    let crashed = write_moved_session_stores(crashed.path());
    let before = snapshot(&crashed);
    let planned_intent = plan(&crashed, &fixture_session()).unwrap();
    let cert_dir = tempfile::tempdir().unwrap();
    let cert = write_cert_file(cert_dir.path(), &valid_cert_value(&planned_intent));
    let stopped = run_with_head_cut(
        &crashed,
        &fixture_session(),
        &cert,
        &NoHolders,
        Some(StopAfter::Intent),
    );
    assert!(
        matches!(stopped, Err(MoveError::Interrupted(_))),
        "{stopped:?}"
    );
    let intent: MoveRecord =
        serde_json::from_str(&record(&crashed).expect("relocating intent")).unwrap();
    assert_eq!(intent.state, MoveState::Relocating);
    assert_eq!(intent.head_cut.mid, planned_intent.p);
    assert_eq!(intent.message_count, planned_intent.message_count as u64);
    // The host is untouched: only the intent was committed.
    assert_eq!(snapshot(&crashed).0, before.0);
    // Resume without re-planning and without the certificate file: deleting
    // the certificate proves the rerun never re-reads it.
    std::fs::remove_file(&cert).unwrap();
    resume(&crashed, &fixture_session(), &NoHolders, None).unwrap();
    assert_eq!(snapshot(&crashed), reference);

    // A crash after the host COMMIT, before `moved`: the host already carries
    // the after-image and the record is still `relocating`. The rerun only
    // flips the record to `moved`.
    let crashed = tempfile::tempdir().unwrap();
    let crashed = write_moved_session_stores(crashed.path());
    let planned_host = plan(&crashed, &fixture_session()).unwrap();
    let cert_dir = tempfile::tempdir().unwrap();
    let cert = write_cert_file(cert_dir.path(), &valid_cert_value(&planned_host));
    let stopped = run_with_head_cut(
        &crashed,
        &fixture_session(),
        &cert,
        &NoHolders,
        Some(StopAfter::Host),
    );
    assert!(
        matches!(stopped, Err(MoveError::Interrupted(_))),
        "{stopped:?}"
    );
    let intent: MoveRecord =
        serde_json::from_str(&record(&crashed).expect("relocating intent")).unwrap();
    assert_eq!(intent.state, MoveState::Relocating);
    assert_eq!(snapshot(&crashed).0, reference.0);
    resume(&crashed, &fixture_session(), &NoHolders, None).unwrap();
    assert_eq!(snapshot(&crashed), reference);

    // A crash after the moved record is a finished move: rerunning refuses by
    // name and changes nothing. The authoritative record is never cleared.
    assert_eq!(refusal(&crashed).code, "already_moved");
    assert_eq!(snapshot(&crashed), reference);
    assert!(record(&crashed).is_some());
}

fn cert_refusal(paths: &StorePaths, certificate: &Value) -> Refusal {
    let before = all_store_bytes(paths);
    let dir = tempfile::tempdir().unwrap();
    let cert = write_cert_file(dir.path(), certificate);
    let refused = match run_with_head_cut(paths, &fixture_session(), &cert, &NoHolders, None) {
        Err(MoveError::Refused(refusal)) => refusal,
        other => panic!("expected a certificate refusal, got {other:?}"),
    };
    assert_eq!(refused.code, "certificate_mismatch");
    assert_eq!(
        all_store_bytes(paths),
        before,
        "certificate refusal wrote a store"
    );
    // No `relocating` intent and no other write survived the refusal.
    assert!(
        record(paths).is_none(),
        "certificate refusal left an intent"
    );
    refused
}

#[test]
fn apply_checks_the_certificate_before_committing_the_intent() {
    // The SUBC vector's digest is opaque: the apply records it when `mid` and
    // `message_count` match the plan, and no fixture expects a different
    // well-formed digest to be detected.
    let dir = tempfile::tempdir().unwrap();
    let paths = write_moved_session_stores(dir.path());
    let planned = plan(&paths, &fixture_session()).unwrap();
    let valid = valid_cert_value(&planned);
    let cert_dir = tempfile::tempdir().unwrap();
    let cert = write_cert_file(cert_dir.path(), &valid);
    let loaded = load_certificate(&cert).unwrap();
    assert_eq!(loaded.message_count, 6);
    assert_eq!(loaded.head_cut.mid, "msg_m006");
    check_certificate(&planned, &loaded).unwrap();
    // A different well-formed digest with the same `mid` and count is still
    // accepted: the digest is recorded as certified, never recomputed.
    let mut other_digest = valid.clone();
    other_digest["head_cut"]["digest"] = json!("other-digest");
    let cert_dir = tempfile::tempdir().unwrap();
    let cert = write_cert_file(cert_dir.path(), &other_digest);
    let loaded = load_certificate(&cert).unwrap();
    check_certificate(&planned, &loaded).unwrap();

    // A different `mid` refuses before any write.
    let dir = tempfile::tempdir().unwrap();
    let paths = write_moved_session_stores(dir.path());
    let planned_mid = plan(&paths, &fixture_session()).unwrap();
    let mut wrong_mid = valid_cert_value(&planned_mid);
    wrong_mid["head_cut"]["mid"] = json!("msg_m005");
    assert_eq!(
        cert_refusal(&paths, &wrong_mid).code,
        "certificate_mismatch"
    );

    // A different `message_count` refuses before any write.
    let dir = tempfile::tempdir().unwrap();
    let paths = write_moved_session_stores(dir.path());
    let planned_count = plan(&paths, &fixture_session()).unwrap();
    let mut wrong_count = valid_cert_value(&planned_count);
    wrong_count["message_count"] = json!(7);
    assert_eq!(
        cert_refusal(&paths, &wrong_count).code,
        "certificate_mismatch"
    );

    // A malformed certificate (missing field, wrong type) refuses before any
    // write. Each case snapshots all three stores and leaves no intent.
    for malformed in [
        json!({"message_count": 6}),
        json!({"head_cut": {"mid": "msg_m006", "digest": VECTOR_DIGEST, "written_at": VECTOR_WRITTEN_AT}}),
        json!({"message_count": 6, "head_cut": {"digest": VECTOR_DIGEST, "written_at": VECTOR_WRITTEN_AT}}),
        json!({"message_count": 6, "head_cut": {"mid": "msg_m006", "written_at": VECTOR_WRITTEN_AT}}),
        json!({"message_count": 6, "head_cut": {"mid": "msg_m006", "digest": VECTOR_DIGEST}}),
        json!({"message_count": "6", "head_cut": {"mid": "msg_m006", "digest": VECTOR_DIGEST, "written_at": VECTOR_WRITTEN_AT}}),
        json!({"message_count": 6, "head_cut": {"mid": 6, "digest": VECTOR_DIGEST, "written_at": VECTOR_WRITTEN_AT}}),
        json!({"message_count": 6, "head_cut": {"mid": "msg_m006", "digest": 42, "written_at": VECTOR_WRITTEN_AT}}),
        json!({"message_count": 6, "head_cut": {"mid": "msg_m006", "digest": VECTOR_DIGEST, "written_at": "yesterday"}}),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let paths = write_moved_session_stores(dir.path());
        assert_eq!(
            cert_refusal(&paths, &malformed).code,
            "certificate_mismatch"
        );
    }
}

#[test]
fn move_record_and_marker_key_carry_the_certified_cut() {
    // Known-answer: `cut` is `U`, `message_count` is the counted prefix length,
    // and `head_cut` is exactly the certified `P` triple. The marker key is
    // the four-member key with that head cut.
    let dir = tempfile::tempdir().unwrap();
    let paths = write_moved_session_stores(dir.path());
    let planned_move = moved(&paths);
    let rec = planned_move.record.clone();
    assert_eq!(rec.cut, "msg_m007");
    assert_eq!(rec.cut, planned_move.record.cut);
    assert_eq!(rec.message_count, 6);
    assert_eq!(rec.message_count, planned_move.message_count as u64);
    assert_eq!(
        rec.head_cut,
        HeadCut {
            mid: "msg_m006".into(),
            digest: VECTOR_DIGEST.into(),
            written_at: VECTOR_WRITTEN_AT,
        }
    );
    let marker = relocated_marker_data(&paths, &rec.marker_part);
    assert_eq!(
        marker["cortexkit"],
        json!({
            "tag_checkpoint": 20,
            "session": fixture_session(),
            "message_count": 6,
            "head_cut": {"mid": "msg_m006", "digest": VECTOR_DIGEST, "written_at": VECTOR_WRITTEN_AT},
        })
    );
    // The stored record round-trips through the persisted intent.
    let stored: MoveRecord = serde_json::from_str(&record(&paths).unwrap()).unwrap();
    assert_eq!(stored, rec);
}

#[test]
fn host_transaction_applies_only_from_the_recorded_images() {
    let finished = tempfile::tempdir().unwrap();
    let finished = write_moved_session_stores(finished.path());
    moved(&finished);
    let reference = snapshot(&finished);

    // The after-image is already in place: the rerun only flips the record to
    // `moved` and writes nothing else to the host.
    let dir = tempfile::tempdir().unwrap();
    let paths = write_moved_session_stores(dir.path());
    let planned_after = plan(&paths, &fixture_session()).unwrap();
    let cert_dir = tempfile::tempdir().unwrap();
    let cert = write_cert_file(cert_dir.path(), &valid_cert_value(&planned_after));
    run_with_head_cut(
        &paths,
        &fixture_session(),
        &cert,
        &NoHolders,
        Some(StopAfter::Host),
    )
    .unwrap_err();
    let intent: MoveRecord = serde_json::from_str(&record(&paths).unwrap()).unwrap();
    assert_eq!(intent.state, MoveState::Relocating);
    let host_before_resume = snapshot(&paths).0;
    assert_eq!(host_before_resume, reference.0);
    resume(&paths, &fixture_session(), &NoHolders, None).unwrap();
    assert_eq!(snapshot(&paths), reference);

    // A host matching neither image refuses `move_host_state_unknown` with no
    // further writes: the intent stays `relocating` and the host is untouched.
    let dir = tempfile::tempdir().unwrap();
    let paths = write_moved_session_stores(dir.path());
    let planned_neither = plan(&paths, &fixture_session()).unwrap();
    let cert_dir = tempfile::tempdir().unwrap();
    let cert = write_cert_file(cert_dir.path(), &valid_cert_value(&planned_neither));
    run_with_head_cut(
        &paths,
        &fixture_session(),
        &cert,
        &NoHolders,
        Some(StopAfter::Intent),
    )
    .unwrap_err();
    // Corrupt the host so it matches neither the before- nor the after-image.
    host_sql(&paths, "UPDATE part SET data='corrupted' WHERE id IN (SELECT id FROM part WHERE json_extract(data,'$.type')='compaction' LIMIT 1)");
    let before = all_store_bytes(&paths);
    let refused = match resume(&paths, &fixture_session(), &NoHolders, None) {
        Err(MoveError::Refused(refusal)) => refusal,
        other => panic!("expected move_host_state_unknown, got {other:?}"),
    };
    assert_eq!(refused.code, "move_host_state_unknown");
    assert_eq!(all_store_bytes(&paths), before);
    let intent: MoveRecord = serde_json::from_str(&record(&paths).unwrap()).unwrap();
    assert_eq!(intent.state, MoveState::Relocating);
}

#[test]
fn resumes_finish_from_the_persisted_intent_when_planning_would_fail() {
    let finished = tempfile::tempdir().unwrap();
    let finished = write_moved_session_stores(finished.path());
    moved(&finished);
    let reference = snapshot(&finished);

    for stop in [StopAfter::Intent, StopAfter::Host] {
        let dir = tempfile::tempdir().unwrap();
        let paths = write_moved_session_stores(dir.path());
        let planned_break = plan(&paths, &fixture_session()).unwrap();
        let cert_dir = tempfile::tempdir().unwrap();
        let cert = write_cert_file(cert_dir.path(), &valid_cert_value(&planned_break));
        run_with_head_cut(&paths, &fixture_session(), &cert, &NoHolders, Some(stop)).unwrap_err();
        // Break planning: delete the compartments so a fresh plan would refuse
        // `summaries_missing`, and corrupt the marker state. The resume must
        // still finish from the persisted intent alone.
        context_sql(&paths, "DELETE FROM compartments");
        context_sql(
            &paths,
            "UPDATE session_meta SET compaction_marker_state='broken'",
        );
        assert!(plan(&paths, &fixture_session()).is_err());
        resume(&paths, &fixture_session(), &NoHolders, None).unwrap();
        assert_eq!(snapshot(&paths), reference, "stop={stop:?}");
        let stored: MoveRecord = serde_json::from_str(&record(&paths).unwrap()).unwrap();
        assert_eq!(stored.state, MoveState::Moved);
        assert_eq!(stored.head_cut.mid, "msg_m006");
    }
}

#[test]
fn uncertain_commits_rerun_to_the_same_moved_state() {
    let finished = tempfile::tempdir().unwrap();
    let finished = write_moved_session_stores(finished.path());
    moved(&finished);
    let reference = snapshot(&finished);

    // An uncertain host COMMIT: the host may hold the before- or the
    // after-image while the record is still `relocating`. Both resumes end
    // with byte-identical host rows and a `moved` record.
    for stop in [StopAfter::Intent, StopAfter::Host] {
        let dir = tempfile::tempdir().unwrap();
        let paths = write_moved_session_stores(dir.path());
        let planned_uncertain = plan(&paths, &fixture_session()).unwrap();
        let cert_dir = tempfile::tempdir().unwrap();
        let cert = write_cert_file(cert_dir.path(), &valid_cert_value(&planned_uncertain));
        run_with_head_cut(&paths, &fixture_session(), &cert, &NoHolders, Some(stop)).unwrap_err();
        resume(&paths, &fixture_session(), &NoHolders, None).unwrap();
        assert_eq!(snapshot(&paths), reference, "host stop={stop:?}");
    }

    // An uncertain `moved` COMMIT: the host already carries the after-image
    // while the record may still be `relocating` or already `moved`. Either
    // rerun ends `moved` with the same bytes; the record is never cleared.
    let dir = tempfile::tempdir().unwrap();
    let paths = write_moved_session_stores(dir.path());
    let planned_moved = plan(&paths, &fixture_session()).unwrap();
    let cert_dir = tempfile::tempdir().unwrap();
    let cert = write_cert_file(cert_dir.path(), &valid_cert_value(&planned_moved));
    run_with_head_cut(
        &paths,
        &fixture_session(),
        &cert,
        &NoHolders,
        Some(StopAfter::Host),
    )
    .unwrap_err();
    resume(&paths, &fixture_session(), &NoHolders, None).unwrap();
    assert_eq!(snapshot(&paths), reference);
    // A second resume after the `moved` COMMIT refuses by name without writing.
    let before = all_store_bytes(&paths);
    assert_eq!(refusal(&paths).code, "already_moved");
    assert_eq!(all_store_bytes(&paths), before);
    assert!(
        record(&paths).is_some(),
        "the authoritative record was cleared"
    );
}

#[test]
fn move_refuses_each_case_by_name_without_writing() {
    type BreakSource = Box<dyn Fn(&StorePaths)>;
    let cases: Vec<(&str, BreakSource)> = vec![
        (
            "marker_pending_not_in_effect",
            Box::new(|paths| {
                Connection::open(&paths.context_db)
                    .unwrap()
                    .execute(
                        "UPDATE session_meta SET pending_compaction_marker_state='{\"ordinal\":9,\"endMessageId\":\"msg_m010\"}'",
                        [],
                    )
                    .unwrap();
            }),
        ),
        (
            "not_standalone_opencode1",
            Box::new(|paths| {
                Connection::open(&paths.context_db)
                    .unwrap()
                    .execute("UPDATE session_meta SET harness='pi'", [])
                    .unwrap();
            }),
        ),
        (
            "drop_target_ambiguous",
            Box::new(|paths| {
                Connection::open(&paths.opencode_db).unwrap().execute(
                    "INSERT INTO part SELECT 'prt_m010_z', message_id, session_id, time_created, time_updated, data FROM part WHERE id='prt_m010_a'",
                    [],
                ).unwrap();
            }),
        ),
        (
            "fork_unsupported",
            Box::new(|paths| {
                Connection::open(&paths.opencode_db).unwrap().execute(
                    "UPDATE part SET data=json_set(data,'$.cortexkit',json('{\"tag_checkpoint\":20,\"session\":\"ses_parent\"}')) WHERE json_extract(data,'$.type')='compaction'",
                    [],
                ).unwrap();
            }),
        ),
        (
            "checkpoint_conflict",
            Box::new(|paths| {
                let session = fixture_session();
                Connection::open(&paths.opencode_db).unwrap().execute(
                    "UPDATE part SET data=json_set(data,'$.cortexkit',json(?1)) WHERE json_extract(data,'$.type')='compaction'",
                    [json!({"tag_checkpoint":7,"session":session}).to_string()],
                ).unwrap();
            }),
        ),
        (
            "marker_missing",
            Box::new(|paths| {
                Connection::open(&paths.opencode_db)
                    .unwrap()
                    .execute(
                        "DELETE FROM message WHERE json_extract(data,'$.summary')=1",
                        [],
                    )
                    .unwrap();
            }),
        ),
        (
            "address_malformed",
            Box::new(|paths| {
                Connection::open(&paths.context_db)
                    .unwrap()
                    .execute(
                        "UPDATE tags SET message_id='msg_m008#3' WHERE tag_number=13",
                        [],
                    )
                    .unwrap();
            }),
        ),
        (
            "destination_not_empty",
            Box::new(|paths| {
                Connection::open(&paths.store_db).unwrap().execute(
                    "INSERT INTO mc_async_compaction(session_ref,conversation_key,session,state_json) VALUES ('r','k',?1,'{}')",
                    [fixture_session()],
                ).unwrap();
            }),
        ),
        (
            "marker_state_mismatch",
            Box::new(|paths| {
                Connection::open(&paths.context_db)
                    .unwrap()
                    .execute("UPDATE session_meta SET compaction_marker_state='{'", [])
                    .unwrap();
            }),
        ),
        (
            "marker_not_standalone",
            Box::new(|paths| {
                Connection::open(&paths.opencode_db).unwrap().execute(
                    "UPDATE message SET data=json_set(data,'$.providerID','other') WHERE json_extract(data,'$.summary')=1", [],
                ).unwrap();
            }),
        ),
        (
            "summaries_missing",
            Box::new(|paths| {
                Connection::open(&paths.context_db)
                    .unwrap()
                    .execute("DELETE FROM compartments", [])
                    .unwrap();
            }),
        ),
        (
            "queue_invalid",
            Box::new(|paths| {
                Connection::open(&paths.context_db)
                    .unwrap()
                    .execute(
                        "UPDATE pending_ops SET operation='caveman' WHERE tag_id=16",
                        [],
                    )
                    .unwrap();
            }),
        ),
    ];
    for (code, break_source) in cases {
        let dir = tempfile::tempdir().unwrap();
        let paths = write_movable_stores(dir.path());
        break_source(&paths);
        let before = snapshot(&paths);
        let refused = refusal(&paths);
        assert_eq!(refused.code, code, "{refused}");
        assert_eq!(snapshot(&paths), before, "{code} wrote a store");
    }
    // Another session, and a held store.
    let dir = tempfile::tempdir().unwrap();
    let paths = write_moved_session_stores(dir.path());
    let before = all_store_bytes(&paths);
    let other = run(&paths, "ses_other", false, &NoHolders, None);
    assert!(
        matches!(&other, Err(MoveError::Refused(r)) if r.code == "not_standalone_opencode1"),
        "{other:?}"
    );
    assert_eq!(all_store_bytes(&paths), before);
    let held = run(
        &paths,
        &fixture_session(),
        false,
        &Held("opencode/4242"),
        None,
    );
    assert!(
        matches!(&held, Err(MoveError::Refused(r)) if r.code == "stores_in_use" && r.detail.contains("opencode/4242")),
        "{held:?}"
    );
    assert_eq!(all_store_bytes(&paths), before);
    moved(&paths);
    assert_eq!(refusal(&paths).code, "already_moved");
}

/// The real holder check sees another process that holds `context.db` open.
#[test]
fn move_refuses_while_another_process_holds_a_store() {
    let dir = tempfile::tempdir().unwrap();
    let paths = write_movable_stores(dir.path());
    let before = all_store_bytes(&paths);
    let mut child = std::process::Command::new("sh")
        .arg("-c")
        .arg("exec 3<\"$1\"; echo ready; exec sleep 30")
        .arg("sh")
        .arg(&paths.context_db)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut ready = String::new();
    std::io::BufRead::read_line(
        &mut std::io::BufReader::new(child.stdout.as_mut().unwrap()),
        &mut ready,
    )
    .unwrap();
    let held = run(&paths, &fixture_session(), false, &Lsof, None);
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(
        matches!(&held, Err(MoveError::Refused(r)) if r.code == "stores_in_use"),
        "{held:?}"
    );
    assert!(record(&paths).is_none());
    assert_eq!(all_store_bytes(&paths), before);
    // With the holder gone the same check passes.
    check_holders(&paths, &Lsof).unwrap();
}

fn part(id: &str, kind: &str) -> PartRow {
    PartRow {
        id: id.into(),
        kind: kind.into(),
        call_id: None,
        blank_text: false,
        synthetic: false,
        taggable: kind == "text",
        not_served: false,
    }
}

fn context_sql(paths: &StorePaths, sql: &str) {
    Connection::open(&paths.context_db)
        .unwrap()
        .execute_batch(sql)
        .unwrap();
}

fn host_sql(paths: &StorePaths, sql: &str) {
    Connection::open(&paths.opencode_db)
        .unwrap()
        .execute_batch(sql)
        .unwrap();
}

#[test]
fn admission_refusal_codes_are_exact_and_all_three_stores_are_unchanged() {
    let cases = [
        ("block_index", "UPDATE compartments SET start_block_index=0 WHERE sequence=1", ""),
        ("summary_id_missing", "UPDATE compartments SET start_message_id=NULL WHERE sequence=1", ""),
        ("summary_endpoint_missing", "UPDATE compartments SET end_message_id='absent' WHERE sequence=1", ""),
        ("summary_inverted", "UPDATE compartments SET start_message_id='msg_m006',end_message_id='msg_m003' WHERE sequence=2", ""),
        ("prefix_gap", "UPDATE compartments SET start_message_id='msg_m002' WHERE sequence=1", ""),
        ("prefix_not_tiled", "UPDATE compartments SET start_message_id='msg_m002' WHERE sequence=2", ""),
        ("fold_end_missing", "UPDATE session_meta SET compaction_marker_state=json_remove(compaction_marker_state,'$.targetEndMessageId')", ""),
        ("fold_end_missing", "UPDATE session_meta SET compaction_marker_state=json_set(compaction_marker_state,'$.targetEndMessageId','absent')", ""),
        ("fold_end_uncovered", "UPDATE session_meta SET compaction_marker_state=json_set(compaction_marker_state,'$.targetEndMessageId','msg_m012')", ""),
        ("no_eligible_cut", "", "UPDATE message SET data=json_set(data,'$.role','assistant') WHERE id IN ('msg_m001','msg_m003','msg_m007')"),
        ("empty_prefix", "", "UPDATE message SET data=json_set(data,'$.role','assistant') WHERE id IN ('msg_m003','msg_m007')"),
        ("cut_straddled", "UPDATE session_meta SET compaction_marker_state=json_set(compaction_marker_state,'$.targetEndMessageId','msg_m003')", "UPDATE message SET data=json_set(data,'$.role','user') WHERE id='msg_m004'"),
    ];
    for (code, context, host) in cases {
        let dir = tempfile::tempdir().unwrap();
        let paths = write_movable_stores(dir.path());
        context_sql(&paths, context);
        host_sql(&paths, host);
        assert_eq!(refusal(&paths).code, code);
    }
}

#[test]
fn prefix_end_mismatch_defense_is_read_only() {
    let dir = tempfile::tempdir().unwrap();
    let paths = write_movable_stores(dir.path());
    let before = all_store_bytes(&paths);
    // Full admission rejects a gap as prefix_not_tiled first. Exercise the
    // independent prefix guard with a gap ending just before P.
    assert_eq!(
        imported_prefix_len(&[(1, 2), (5, 6)], 4).unwrap_err().code,
        "prefix_end_mismatch"
    );
    assert_eq!(all_store_bytes(&paths), before);
}

fn add_message(paths: &StorePaths, id: &str, time: i64, data: &str) {
    Connection::open(&paths.opencode_db)
        .unwrap()
        .execute(
            "INSERT INTO message VALUES (?1,?2,?3,?3,?4)",
            params![id, fixture_session(), time, data],
        )
        .unwrap();
}

#[test]
fn adjacency_at_u_time_and_u_time_plus_one_refuses_without_writes() {
    for time in [7000, 7001] {
        let dir = tempfile::tempdir().unwrap();
        let paths = write_moved_session_stores(dir.path());
        host_sql(&paths, "UPDATE message SET data=json_set(data,'$.role','assistant') WHERE id IN ('msg_m001','msg_m003')");
        add_message(
            &paths,
            "neighbour",
            time,
            r#"{"role":"assistant","summary":true,"finish":"stop"}"#,
        );
        assert_eq!(refusal(&paths).code, "adjacency_conflict");
    }
}

#[test]
fn marker_on_u_accepts_its_own_summary_at_u_time_plus_one() {
    let dir = tempfile::tempdir().unwrap();
    let paths = write_moved_session_stores(dir.path());
    let host = load_host_session(
        &open_read_only(&paths.opencode_db).unwrap(),
        &fixture_session(),
    )
    .unwrap();
    let (index, summary) = in_effect_marker(&host).unwrap();
    assert_eq!(host.messages[index].id, "msg_m007");
    assert_eq!(host.messages[index].time, 7000);
    assert_eq!(summary.time, 7001);
    let before = all_store_bytes(&paths);
    let plan = plan(&paths, &fixture_session()).unwrap();
    assert_eq!(plan.record.cut, "msg_m007");
    assert_eq!(plan.marker_carrier, "msg_m007");
    assert_eq!(plan.p, "msg_m006");
    assert_eq!(plan.message_count, 6);
    assert_eq!(all_store_bytes(&paths), before);
}

#[test]
fn compaction_only_messages_do_not_take_counted_positions() {
    let dir = tempfile::tempdir().unwrap();
    let paths = write_moved_session_stores(dir.path());
    add_message(&paths, "marker_only", 500, r#"{"role":"user"}"#);
    host_sql(&paths, "INSERT INTO part SELECT 'only_compaction','marker_only',session_id,500,500,'{\"type\":\"compaction\"}' FROM part LIMIT 1");
    let before = all_store_bytes(&paths);
    let host = load_host_session(
        &open_read_only(&paths.opencode_db).unwrap(),
        &fixture_session(),
    )
    .unwrap();
    assert!(!host.position.contains_key("marker_only"));
    assert_eq!(host.position["msg_m001"], 1);
    assert_eq!(host.position["msg_m007"], 7);
    let plan = plan(&paths, &fixture_session()).unwrap();
    assert_eq!(plan.message_count, 6);
    assert_eq!(plan.p, "msg_m006");
    assert_eq!(all_store_bytes(&paths), before);
}

#[test]
fn missing_host_messages_and_missing_queued_tags_are_gone_not_refusals() {
    for queued in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let paths = write_moved_session_stores(dir.path());
        if queued {
            context_sql(&paths, "UPDATE tags SET status='active' WHERE tag_number IN (12,13);
                INSERT INTO pending_ops(session_id,tag_id,operation,queued_at,harness) SELECT session_id,12,'drop',1,'opencode' FROM session_meta;
                INSERT INTO pending_ops(session_id,tag_id,operation,queued_at,harness) SELECT session_id,13,'drop',2,'opencode' FROM session_meta");
        }
        host_sql(
            &paths,
            "DELETE FROM part WHERE message_id='msg_m008'; DELETE FROM message WHERE id='msg_m008'",
        );
        context_sql(&paths, "DELETE FROM tags WHERE tag_number=16");
        let before = all_store_bytes(&paths);
        let plan = plan(&paths, &fixture_session()).unwrap();
        assert_eq!(plan.gone, vec![12, 13, 16]);
        assert_eq!(plan.to_value()["drops"]["gone"], json!([12, 13, 16]));
        assert_eq!(
            plan.record
                .drops
                .iter()
                .map(|drop| drop.source_tag)
                .collect::<Vec<_>>(),
            vec![17]
        );
        assert_eq!(all_store_bytes(&paths), before);
    }
}

#[test]
fn ignored_and_empty_targets_are_not_served_for_applied_and_queued_drops() {
    for (number, part) in [(13, "prt_m008_d"), (17, "prt_m010_b")] {
        for invisible in [
            json!({"type":"text","text":"not exposed","ignored":true}),
            json!({"type":"text","text":""}),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let paths = write_moved_session_stores(dir.path());
            Connection::open(&paths.opencode_db)
                .unwrap()
                .execute(
                    "UPDATE part SET data=?1 WHERE id=?2",
                    params![invisible.to_string(), part],
                )
                .unwrap();
            let before = all_store_bytes(&paths);
            let plan = plan(&paths, &fixture_session()).unwrap();
            assert_eq!(plan.not_served, vec![number]);
            assert_eq!(plan.to_value()["drops"]["not_served"], json!([number]));
            assert!(!plan
                .record
                .drops
                .iter()
                .any(|drop| drop.source_tag == number));
            assert_eq!(all_store_bytes(&paths), before);
        }
    }
}

#[test]
fn nonempty_reasoning_remains_a_visible_untagged_target() {
    let dir = tempfile::tempdir().unwrap();
    let paths = write_moved_session_stores(dir.path());
    host_sql(&paths, "UPDATE part SET data='{\"type\":\"reasoning\",\"text\":\"visible reasoning\"}' WHERE id='prt_m008_d'");
    assert_eq!(refusal(&paths).code, "drop_target_untagged");
}

#[test]
fn a_missing_text_part_cannot_rebind_its_drop_to_a_tool_result() {
    let dir = tempfile::tempdir().unwrap();
    let paths = write_moved_session_stores(dir.path());
    host_sql(&paths, "UPDATE part SET data='{\"type\":\"tool\",\"callID\":\"different_call\",\"state\":{\"status\":\"completed\",\"output\":\"unrelated result\"}}' WHERE id='prt_m008_d'");
    assert_eq!(refusal(&paths).code, "drop_target_missing");
}

#[test]
fn projected_marker_refuses_a_surviving_pair_between_u_and_w() {
    let dir = tempfile::tempdir().unwrap();
    let paths = write_movable_stores(dir.path());
    host_sql(&paths, "UPDATE part SET message_id='msg_m011' WHERE json_extract(data,'$.type')='compaction';
        UPDATE message SET data=json_set(data,'$.parentID','msg_m011'),time_created=11001 WHERE json_extract(data,'$.summary')=1;
        INSERT INTO part SELECT 'shadow_part','msg_m009',session_id,9000,9000,'{\"type\":\"compaction\"}' FROM part LIMIT 1");
    context_sql(&paths, "UPDATE session_meta SET compaction_marker_state=json_set(compaction_marker_state,'$.boundaryMessageId','msg_m011')");
    add_message(
        &paths,
        "shadow_summary",
        9001,
        r#"{"role":"assistant","summary":true,"finish":"stop","parentID":"msg_m009"}"#,
    );
    assert_eq!(refusal(&paths).code, "marker_shadowed");
    let host = load_host_session(
        &open_read_only(&paths.opencode_db).unwrap(),
        &fixture_session(),
    )
    .unwrap();
    assert!(host
        .messages
        .iter()
        .any(|message| message.id == "shadow_summary"));
    assert!(host.parts["msg_m009"]
        .iter()
        .any(|part| part.id == "shadow_part"));
}

#[test]
fn counting_matches_plugin_known_answer_and_is_invariant_under_relocation() {
    let dir = tempfile::tempdir().unwrap();
    let paths = write_movable_stores(dir.path());
    host_sql(&paths, "DELETE FROM part; DELETE FROM message");
    for (id, time, data) in [
        ("b", 10, r#"{"role":"user"}"#),
        ("a", 10, r#"{"role":"assistant"}"#),
        ("skip_bool", 11, r#"{"summary":true,"finish":"stop"}"#),
        ("skip_integer", 12, r#"{"summary":1,"finish":"stop"}"#),
        ("skip_real", 13, r#"{"summary":1.0,"finish":"stop"}"#),
        ("unfinished", 14, r#"{"summary":true}"#),
        ("other_finish", 15, r#"{"summary":true,"finish":"length"}"#),
        ("string_summary", 16, r#"{"summary":"1","finish":"stop"}"#),
        ("malformed", 17, "{"),
        ("ordinary_stop", 18, r#"{"finish":"stop"}"#),
    ] {
        add_message(&paths, id, time, data);
    }
    let expected = [
        "a",
        "b",
        "unfinished",
        "other_finish",
        "string_summary",
        "malformed",
        "ordinary_stop",
    ];
    let read = || {
        let host = load_host_session(
            &open_read_only(&paths.opencode_db).unwrap(),
            &fixture_session(),
        )
        .unwrap();
        let mut counted = host.position.into_iter().collect::<Vec<_>>();
        counted.sort_by_key(|(_, position)| *position);
        counted
    };
    let answer = expected
        .iter()
        .enumerate()
        .map(|(index, id)| ((*id).to_owned(), index + 1))
        .collect::<Vec<_>>();
    assert_eq!(read(), answer);
    host_sql(
        &paths,
        "UPDATE message SET time_created=100 WHERE id LIKE 'skip_%'",
    );
    assert_eq!(read(), answer);
}

#[test]
fn runner_tag_eligibility_matches_text_error_and_media_known_answers() {
    for (name, part, expected) in [
        ("user text", json!({"type":"text","text":"hello"}), true),
        ("empty text", json!({"type":"text","text":""}), false),
        ("whitespace text", json!({"type":"text","text":" "}), true),
        (
            "user file",
            json!({"type":"file","mime":"text/plain","url":"file:///f"}),
            false,
        ),
        (
            "reasoning",
            json!({"type":"reasoning","text":"thought"}),
            false,
        ),
        (
            "tool call",
            json!({"type":"tool","state":{"status":"running","output":"not finished"}}),
            false,
        ),
        (
            "tool result",
            json!({"type":"tool","state":{"status":"completed","output":"result"}}),
            true,
        ),
        (
            "error result",
            json!({"type":"tool","state":{"status":"error","error":"failed"}}),
            true,
        ),
        (
            "whitespace result",
            json!({"type":"tool","state":{"status":"completed","output":" "}}),
            true,
        ),
        (
            "empty result",
            json!({"type":"tool","state":{"status":"completed","output":""}}),
            false,
        ),
        (
            "structured only",
            json!({"type":"tool","state":{"status":"completed","output":{"answer":42}}}),
            false,
        ),
        (
            "image-only result",
            json!({"type":"tool","state":{"status":"completed","output":"","attachments":[{"type":"file","mime":"image/png","url":"data:image/png;base64,AA=="}]}}),
            true,
        ),
        (
            "media-only result",
            json!({"type":"tool","state":{"status":"completed","output":"","attachments":[{"type":"file","mime":"application/pdf","url":"file:///f.pdf"}]}}),
            true,
        ),
        (
            "text attachment",
            json!({"type":"tool","state":{"status":"completed","output":"","attachments":[{"type":"text","text":"attached text"}]}}),
            true,
        ),
        (
            "opaque attachment",
            json!({"type":"tool","state":{"status":"completed","output":"","attachments":[{"unknown":42}]}}),
            false,
        ),
    ] {
        assert_eq!(runner_taggable_part(&part), expected, "{name}");
    }
}

#[test]
fn drops_missing_and_untagged_fail_closed_for_applied_and_queued_targets() {
    for queued in [false, true] {
        for (code, host) in [
            ("drop_target_missing", "DELETE FROM part WHERE message_id='msg_m008'"),
            ("drop_target_untagged", "UPDATE part SET data=json_set(data,'$.state.status','running') WHERE id='prt_m008_c'"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let paths = write_movable_stores(dir.path());
            if queued {
                context_sql(&paths, "UPDATE tags SET status='active' WHERE tag_number=12; INSERT INTO pending_ops(session_id,tag_id,operation,queued_at,harness) SELECT session_id,12,'drop',1,'opencode' FROM session_meta");
            }
            host_sql(&paths, host);
            assert_eq!(refusal(&paths).code, code);
        }
        let dir = tempfile::tempdir().unwrap();
        let paths = write_stores(dir.path());
        if !queued {
            context_sql(&paths, "DELETE FROM pending_ops WHERE tag_id=15; UPDATE tags SET status='dropped' WHERE tag_number=15");
        }
        assert_eq!(refusal(&paths).code, "drop_target_untagged");
    }
    let dir = tempfile::tempdir().unwrap();
    let paths = write_movable_stores(dir.path());
    context_sql(&paths, "UPDATE pending_ops SET tag_id=999 WHERE tag_id=16");
    let before = all_store_bytes(&paths);
    let plan = plan(&paths, &fixture_session()).unwrap();
    assert_eq!(plan.gone, vec![999]);
    assert_eq!(all_store_bytes(&paths), before);
}

#[test]
fn plan_flag_prints_the_certification_inputs_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    let paths = write_movable_stores(dir.path());
    let args = [
        "move-session",
        "--plan",
        "--session",
        &fixture_session(),
        "--opencode-db",
        paths.opencode_db.to_str().unwrap(),
        "--context-db",
        paths.context_db.to_str().unwrap(),
        "--store-db",
        paths.store_db.to_str().unwrap(),
    ]
    .map(str::to_owned);
    let CliArgs {
        paths: parsed,
        session,
        mode,
        shared_context,
    } = parse_args(&args).unwrap();
    assert_eq!(mode, CliMode::Plan);
    assert!(
        !shared_context,
        "exclusive holder check unless the operator opts in"
    );
    let before = all_store_bytes(&paths);
    let Outcome::Planned(plan) = run(&parsed, &session, true, &NoHolders, None).unwrap() else {
        panic!("--plan wrote")
    };
    assert_eq!(plan.to_value()["U"], "msg_m007");
    assert_eq!(plan.to_value()["P"], "msg_m006");
    assert_eq!(plan.to_value()["message_count"], 6);
    assert_eq!(all_store_bytes(&paths), before);
}

#[test]
fn apply_relocates_the_marker_onto_u_in_one_host_transaction() {
    // `write_movable_stores` still carries the old marker on `msg_m005` while
    // the plan selects `U = msg_m007`: apply relocates instead of refusing.
    for keyed in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let paths = write_movable_stores(dir.path());
        if keyed {
            Connection::open(&paths.opencode_db).unwrap().execute(
                "UPDATE part SET data=json_set(data,'$.cortexkit',json(?1)) WHERE json_extract(data,'$.type')='compaction'",
                [json!({"tag_checkpoint":20,"session":fixture_session()}).to_string()],
            ).unwrap();
        }
        let before_plan = plan(&paths, &fixture_session()).unwrap();
        assert_eq!(before_plan.record.cut, "msg_m007");
        assert_eq!(before_plan.marker_carrier, "msg_m005");
        let cert_dir = tempfile::tempdir().unwrap();
        let cert = write_cert_file(cert_dir.path(), &valid_cert_value(&before_plan));
        let Outcome::Moved(plan) =
            run_with_head_cut(&paths, &fixture_session(), &cert, &NoHolders, None).unwrap()
        else {
            panic!("relocation did not move");
        };
        assert_eq!(plan.record.cut, "msg_m007");
        let marker = relocated_marker_data(&paths, &plan.record.marker_part);
        assert_eq!(
            marker["cortexkit"],
            json!({"tag_checkpoint":20,"session":fixture_session(),"message_count":6,"head_cut":{"mid":"msg_m006","digest":VECTOR_DIGEST,"written_at":VECTOR_WRITTEN_AT}})
        );
    }
}

#[test]
fn marker_on_head_cut_refuses_before_any_write() {
    // Moving the old marker onto `U` would delete `P`'s compaction part when
    // the old carrier `W` is `P` itself. The certificate for `P` is taken
    // before apply, so apply must never rewrite `P`'s rows. `P` must be a
    // user message here so the old marker can sit on it: the fixture's `P`
    // (`msg_m006`) is an assistant, so first make it a user.
    let dir = tempfile::tempdir().unwrap();
    let paths = write_movable_stores(dir.path());
    host_sql(
        &paths,
        "UPDATE message SET data=json_set(data,'$.role','user') WHERE id='msg_m006'",
    );
    // The fixture's `P` is `msg_m006` for `U = msg_m007`: move the old marker
    // from `msg_m005` onto `msg_m006`, keeping its summary parented there.
    host_sql(&paths, "UPDATE part SET message_id='msg_m006',time_created=6000,time_updated=6000 WHERE json_extract(data,'$.type')='compaction';
        UPDATE message SET data=json_set(data,'$.parentID','msg_m006','$.time.created',6001,'$.time.completed',6001),time_created=6001,time_updated=6001 WHERE json_extract(data,'$.summary')=1;
        UPDATE part SET time_created=6001,time_updated=6001 WHERE message_id IN (SELECT id FROM message WHERE json_extract(data,'$.summary')=1)");
    context_sql(&paths, "UPDATE session_meta SET compaction_marker_state=json_set(compaction_marker_state,'$.boundaryMessageId','msg_m006','$.boundaryOrdinal',6)");
    assert_eq!(refusal(&paths).code, "marker_on_head_cut");
}

#[test]
fn positional_past_the_end_slot_is_gone_not_missing() {
    // CKDESK's tag 5872 at `<mid>:p1`: the message exists with one text part,
    // so index 1 names no served slot. Nothing at that slot is served.
    let dir = tempfile::tempdir().unwrap();
    let paths = write_moved_session_stores(dir.path());
    host_sql(
        &paths,
        "DELETE FROM part WHERE message_id='msg_m008' AND id != 'prt_m008_b'",
    );
    context_sql(&paths, "UPDATE tags SET message_id='msg_m008:p1', type='message', status='dropped' WHERE tag_number=13");
    context_sql(
        &paths,
        "UPDATE tags SET status='active' WHERE tag_number=12",
    );
    context_sql(&paths, "DELETE FROM pending_ops WHERE tag_id=16");
    let before = all_store_bytes(&paths);
    let plan = plan(&paths, &fixture_session()).unwrap();
    assert!(plan.gone.contains(&13), "{:?}", plan.gone);
    assert!(!plan.record.drops.iter().any(|drop| drop.source_tag == 13));
    assert_eq!(all_store_bytes(&paths), before);
}

#[test]
fn qta_and_synapse_shaped_file_drops_refuse_untagged_without_writes() {
    // SYNAPSE shape: the fixture's single queued file drop after `U`.
    let dir = tempfile::tempdir().unwrap();
    let paths = write_stores(dir.path());
    assert_eq!(refusal(&paths).code, "drop_target_untagged");
    // QTA shape: three dropped file parts after `U`.
    let dir = tempfile::tempdir().unwrap();
    let paths = write_movable_stores(dir.path());
    host_sql(&paths, "INSERT INTO part SELECT 'prt_qta_f1', 'msg_m009', session_id, 9000, 9000, '{\"type\":\"file\",\"mime\":\"text/plain\",\"url\":\"data:text/plain;base64,eA==\"}' FROM part LIMIT 1");
    host_sql(&paths, "INSERT INTO part SELECT 'prt_qta_f2', 'msg_m010', session_id, 10000, 10000, '{\"type\":\"file\",\"mime\":\"text/plain\",\"url\":\"data:text/plain;base64,eQ==\"}' FROM part LIMIT 1");
    // `msg_m009` holds `prt_m009_a` (text, index 0), `prt_m009_b` (file,
    // index 1) and the new file at index 2; `msg_m010` holds two tool parts
    // and text plus the new file. Valid file slots bind to untaggable file
    // parts and refuse, instead of going `gone` as past-the-end slots do.
    context_sql(&paths, "INSERT INTO tags(session_id,message_id,type,status,byte_size,tag_number,harness) VALUES ('ses_mode3_move_fixture','msg_m009:file2','file','dropped',10,101,'opencode'),('ses_mode3_move_fixture','msg_m010:file3','file','dropped',10,102,'opencode')");
    assert_eq!(refusal(&paths).code, "drop_target_untagged");
}

#[test]
fn id_generator_matches_plugin_vectors() {
    // Vectors taken from `packages/plugin/.../compaction-marker.ts` via bun.
    assert_eq!(deterministic_base62("", 5), "HLxI5");
    assert_eq!(deterministic_base62("abc", 14), "7nzH5i6WpR5bav");
    assert_eq!(
        deterministic_base62("msg\0ses-1\0msg_user\0summary-message", 14),
        "zpqyymA9FjZ5Q5"
    );
    assert_eq!(
        generate_message_id(101, 1, "ses-1\0msg_user\0summary-message"),
        "msg_000000065001zpqyymA9FjZ5Q5"
    );
    assert_eq!(
        generate_message_id(1000, 0, "boundary"),
        "msg_0000003e8000Os1l5thYhzI5Sw"
    );
    // The fixture's own old triple pins the generator end to end.
    assert_eq!(
        generate_part_id(5000, 1, "ses_mode3_move_fixture\0msg_m006\0compaction-part"),
        "prt_0000013880017vSwDweLmvnis8"
    );
    assert_eq!(
        generate_message_id(5001, 1, "ses_mode3_move_fixture\0msg_m006\0summary-message"),
        "msg_0000013890011TLOnC0hggUweo"
    );
    assert_eq!(
        generate_part_id(5001, 2, "ses_mode3_move_fixture\0msg_m006\0summary-part"),
        "prt_0000013890020zGA8sPgeGCoLV"
    );
    // The relocated triple for `U = msg_m007`, `P = msg_m006`.
    assert_eq!(
        generate_part_id(7000, 1, "ses_mode3_move_fixture\0msg_m006\0compaction-part"),
        "prt_000001b580017vSwDweLmvnis8"
    );
    assert_eq!(
        generate_message_id(7001, 1, "ses_mode3_move_fixture\0msg_m006\0summary-message"),
        "msg_000001b590011TLOnC0hggUweo"
    );
}

#[test]
fn offline_block_ids_match_edge_block_vectors() {
    // Known-answer CK block ranges for the `edge_block` codec (`opencode-aisdk`
    // with `nativeIndex = part_index`). Whole-message endpoints cover the
    // first through the last decoded block; skipped parts (compaction,
    // ignored or empty text) decode to no block.
    assert_eq!(offline_codec_profile().serializer, "opencode-aisdk");
    assert_eq!(offline_codec_profile().native_index, "part_index");
    for (role, parts, expected) in [
        (
            "user",
            vec![json!({"type":"text","text":"hi"})],
            Some((0, 0)),
        ),
        (
            "assistant",
            vec![
                json!({"type":"reasoning","text":"think"}),
                json!({"type":"text","text":"done"}),
                json!({"type":"tool","callID":"c1","tool":"read","state":{"status":"completed","input":{},"output":"out","title":"t","metadata":{},"time":{"start":1,"end":2}}}),
            ],
            // Reasoning, text, tool call and tool result: four CK blocks.
            Some((0, 3)),
        ),
        ("user", vec![json!({"type":"compaction","auto":true})], None),
        (
            "assistant",
            vec![json!({"type":"text","text":"","ignored":true})],
            None,
        ),
    ] {
        assert_eq!(offline_ck_block_range(role, &parts), expected);
    }
    // The fixture's imported endpoints decode to the manifest's stored ranges.
    let dir = tempfile::tempdir().unwrap();
    let paths = write_moved_session_stores(dir.path());
    let plan = plan(&paths, &fixture_session()).unwrap();
    assert_eq!(plan.record.compartments[0].start_block, Some(0));
    assert_eq!(plan.record.compartments[0].end_block, Some(3));
    assert_eq!(plan.record.compartments[1].start_block, Some(0));
    assert_eq!(plan.record.compartments[1].end_block, Some(2));
}

#[test]
fn carrier_predicate_excludes_all_synthetic_parts_but_admits_no_parts() {
    for field in ["synthetic", "syntheticTodoMarker"] {
        let dir = tempfile::tempdir().unwrap();
        let paths = write_movable_stores(dir.path());
        host_sql(&paths, &format!("UPDATE part SET data=json_set(data,'$.{field}',json('true')) WHERE message_id='msg_m007'"));
        let before = all_store_bytes(&paths);
        let plan = plan(&paths, &fixture_session()).unwrap();
        assert_eq!(plan.record.cut, "msg_m003");
        assert_eq!(plan.message_count, 2);
        assert_eq!(all_store_bytes(&paths), before);
    }
    let dir = tempfile::tempdir().unwrap();
    let paths = write_movable_stores(dir.path());
    host_sql(&paths, "DELETE FROM part WHERE message_id='msg_m007'");
    let before = all_store_bytes(&paths);
    assert_eq!(
        plan(&paths, &fixture_session()).unwrap().record.cut,
        "msg_m007"
    );
    assert_eq!(all_store_bytes(&paths), before);
}

#[test]
fn applied_and_queued_ambiguous_drops_refuse_the_same_code() {
    for target in ["prt_m008_c", "prt_m010_a"] {
        let dir = tempfile::tempdir().unwrap();
        let paths = write_movable_stores(dir.path());
        Connection::open(&paths.opencode_db).unwrap().execute(
            "INSERT INTO part SELECT 'duplicate_tool',message_id,session_id,time_created,time_updated,data FROM part WHERE id=?1",
            [target],
        ).unwrap();
        assert_eq!(refusal(&paths).code, "drop_target_ambiguous");
    }
}

#[test]
fn admission_matches_the_five_frozen_session_shapes() {
    // Synthetic histories isolate distinct cut-selection shapes. The large
    // case checks 2,010 returned rows without copying a live store.
    for shape in [
        "at_fold_end",
        "published_later",
        "raw_back",
        "adjacent_newest",
        "large_raw_back",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let paths = write_movable_stores(dir.path());
        let (u, t, dropped, raw_end) = match shape {
            "at_fold_end" => (7, 6, vec![], 6),
            "published_later" => (7, 6, vec![3], 6),
            "raw_back" => (7, 8, vec![3], 8),
            "adjacent_newest" => (7, 8, vec![3], 8),
            "large_raw_back" => (7, 2016, vec![3], 2016),
            _ => unreachable!(),
        };
        if shape != "at_fold_end" {
            context_sql(&paths, "INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,importance,legacy,created_at,harness)
                SELECT session_id,3,7,12,'msg_m007','msg_m012','late','late summary',50,0,1,'opencode' FROM session_meta");
        }
        if shape == "raw_back" {
            host_sql(
                &paths,
                "UPDATE message SET data=json_set(data,'$.role','assistant') WHERE id='msg_m009'",
            );
        }
        if shape == "adjacent_newest" {
            add_message(
                &paths,
                "neighbour",
                9001,
                r#"{"summary":true,"finish":"stop"}"#,
            );
        }
        if shape == "large_raw_back" {
            for index in 13..=2017 {
                add_message(
                    &paths,
                    &format!("msg_m{index:03}"),
                    index * 1000,
                    r#"{"role":"assistant"}"#,
                );
            }
            context_sql(
                &paths,
                "UPDATE compartments SET end_message_id='msg_m2016' WHERE sequence=3",
            );
        }
        context_sql(&paths, &format!("UPDATE session_meta SET compaction_marker_state=json_set(compaction_marker_state,'$.targetEndMessageId','msg_m{t:03}')"));
        let before = all_store_bytes(&paths);
        let plan = plan(&paths, &fixture_session()).unwrap();
        assert_eq!(plan.record.cut, format!("msg_m{u:03}"), "{shape}");
        assert_eq!(plan.p, "msg_m006", "{shape}");
        assert_eq!(plan.message_count, 6, "{shape}");
        assert_eq!(
            plan.record
                .compartments
                .iter()
                .map(|c| c.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2],
            "{shape}"
        );
        assert_eq!(plan.dropped_summaries, dropped, "{shape}");
        assert_eq!(
            plan.returned_raw,
            (u..=raw_end)
                .map(|index| format!("msg_m{index:03}"))
                .collect::<Vec<_>>(),
            "{shape}"
        );
        assert_eq!(all_store_bytes(&paths), before, "{shape}");
    }
}

#[test]
fn positional_resolution_follows_standalone_exact_then_ordinal_fallback() {
    // Exact addresses bind by part index, not by text ordinal.
    let parts = [
        part("r", "reasoning"),
        part("a", "text"),
        part("t", "tool"),
        part("b", "text"),
    ];
    let bound = resolve_positional_tags(
        &parts,
        &[(PositionalKind::Text, 1, 11), (PositionalKind::Text, 3, 13)],
    );
    assert_eq!(bound.get(&11).map(String::as_str), Some("a"));
    assert_eq!(bound.get(&13).map(String::as_str), Some("b"));
    // A part inserted before the text (the compaction part on the boundary
    // message) shifts the index; the ordinal fallback rebinds the tag.
    let parts = [part("c", "compaction"), part("a", "text")];
    let bound = resolve_positional_tags(&parts, &[(PositionalKind::Text, 0, 7)]);
    assert_eq!(bound.get(&7).map(String::as_str), Some("a"));
    // The fallback never takes an address an earlier part already claimed.
    let parts = [part("x", "text"), part("y", "text")];
    let bound = resolve_positional_tags(
        &parts,
        &[(PositionalKind::Text, 0, 1), (PositionalKind::Text, 5, 2)],
    );
    assert_eq!(bound.get(&1).map(String::as_str), Some("x"));
    assert_eq!(bound.get(&2).map(String::as_str), Some("y"));
    // Files resolve with their own ordinal.
    let parts = [part("t", "text"), part("f", "file")];
    let bound = resolve_positional_tags(&parts, &[(PositionalKind::File, 1, 9)]);
    assert_eq!(bound.get(&9).map(String::as_str), Some("f"));
    assert_eq!(
        parse_positional("msg_a:p12"),
        Some(("msg_a", PositionalKind::Text, 12))
    );
    assert_eq!(
        parse_positional("msg_a:file3"),
        Some(("msg_a", PositionalKind::File, 3))
    );
    assert_eq!(parse_positional("msg_a#3"), None);
}

/// Shape of a synthetic long session for the cost measurements.
pub(crate) struct Synthetic {
    pub messages: usize,
    /// Messages from the cut to the end.
    pub tail: usize,
    pub text_bytes: usize,
    pub compartments: usize,
}

pub(crate) const SYNTHETIC_SESSION: &str = "ses_synthetic_long";

/// Write a standalone OpenCode 1 session shaped like a long head: user and
/// assistant turns, every second assistant turn with a completed tool part,
/// compartments covering everything before the cut and the first assistant turn
/// after it, a standalone marker on the cut, one tag per text and tool part,
/// applied drops on a tenth of the tags and fifty queued stamps after the cut.
pub(crate) fn write_synthetic_stores(dir: &Path, shape: &Synthetic) -> StorePaths {
    drop(mc_store::McStore::open_for_test(&store_descriptor(dir)).unwrap());
    let session = SYNTHETIC_SESSION;
    let mut opencode = Connection::open(dir.join("opencode.db")).unwrap();
    opencode
        .execute_batch(&format!(
            "PRAGMA journal_mode=WAL; CREATE TABLE session (id text PRIMARY KEY); INSERT INTO session VALUES ('{session}'); {}",
            fixture()["opencode"]["schema"].as_str().unwrap()
        ))
        .unwrap();
    let mut context = Connection::open(dir.join("context.db")).unwrap();
    let cut = shape.messages - shape.tail;
    let cut = cut - cut % 2; // a user turn
    let filler = "x".repeat(shape.text_bytes);
    let tx = opencode.transaction().unwrap();
    let ctx = context.transaction().unwrap();
    let mut tag = 0u64;
    {
        let mut message = tx
            .prepare("INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)")
            .unwrap();
        let mut part = tx
            .prepare("INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)")
            .unwrap();
        let mut tags = ctx
            .prepare(
                "INSERT INTO tags(session_id,message_id,type,status,byte_size,tag_number,harness,tool_owner_message_id)
                 VALUES (?1,?2,?3,?4,?5,?6,'opencode',?7)",
            )
            .unwrap();
        let mut queued = ctx
            .prepare("INSERT INTO pending_ops(session_id,tag_id,operation,queued_at,harness) VALUES (?1,?2,'drop',?3,'opencode')")
            .unwrap();
        let mut queued_count = 0;
        for index in 0..shape.messages {
            let mid = format!("msg_{index:07}");
            let time = (index as i64) * 10;
            let user = index % 2 == 0;
            message
                .execute(params![
                    mid,
                    session,
                    time,
                    json!({"role": if user {"user"} else {"assistant"}, "time": {"created": time}})
                        .to_string()
                ])
                .unwrap();
            let mut parts = vec![(
                format!("prt_{index:07}_a"),
                json!({"type":"text","text":format!("turn {index} {filler}")}),
                None,
            )];
            if !user && index % 4 == 1 {
                let call = format!("call_{index}");
                parts.push((
                    format!("prt_{index:07}_b"),
                    json!({"type":"tool","callID":call,"tool":"read","state":{"status":"completed","input":{"filePath":format!("/f{index}")},"output":format!("output {index} {filler}"),"title":"f","metadata":{},"time":{"start":1,"end":2}}}),
                    Some(call),
                ));
            }
            if index == cut {
                parts.push((
                    "prt_0_compaction".into(),
                    json!({"type":"compaction","auto":true}),
                    None,
                ));
            }
            for (position, (id, data, call)) in parts.iter().enumerate() {
                part.execute(params![id, mid, session, time, data.to_string()])
                    .unwrap();
                if data["type"] == "compaction" {
                    continue;
                }
                tag += 1;
                let dropped = tag.is_multiple_of(10);
                let (address, kind, owner) = match call {
                    Some(call) => (call.clone(), "tool", Some(mid.clone())),
                    None => (format!("{mid}:p{position}"), "message", None),
                };
                tags.execute(params![
                    session,
                    address,
                    kind,
                    if dropped { "dropped" } else { "active" },
                    shape.text_bytes as i64,
                    tag as i64,
                    owner
                ])
                .unwrap();
                if index > cut && !dropped && queued_count < 50 && tag.is_multiple_of(7) {
                    queued
                        .execute(params![session, tag as i64, 1_000 + tag as i64])
                        .unwrap();
                    queued_count += 1;
                }
            }
            if index == cut {
                message
                    .execute(params![
                        "msg_summary",
                        session,
                        time + 1,
                        json!({"role":"assistant","parentID":mid,"summary":true,"finish":"stop","modelID":"magic-context","providerID":"magic-context","time":{"created":time+1,"completed":time+1}}).to_string()
                    ])
                    .unwrap();
                part.execute(params![
                    "prt_summary",
                    "msg_summary",
                    session,
                    time + 1,
                    json!({"type":"text","text":"[Compacted by Magic Context]"}).to_string()
                ])
                .unwrap();
            }
        }
        // The compartments tile the counted prefix and end exactly at the message
        // before the cut, so the fold end (the last covered message, index
        // cut - 1) plus one lands on the marker message. The cut is a user
        // message with no neighbour at its time or time + 1 (the relocated
        // summary is excluded), and no summary straddles it. Covering past the
        // cut would straddle it and refuse with `cut_straddled`.
        let covered = cut;
        let per = covered.div_ceil(shape.compartments);
        let mut compartment = ctx
            .prepare(
                "INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,p1,importance,legacy,created_at,harness)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8,50,0,1,'opencode')",
            )
            .unwrap();
        let mut start = 0;
        let mut sequence = 1;
        while start < covered {
            let end = (start + per).min(covered) - 1;
            compartment
                .execute(params![
                    session,
                    sequence,
                    start as i64 + 1,
                    end as i64 + 1,
                    format!("msg_{start:07}"),
                    format!("msg_{end:07}"),
                    format!("part {sequence}"),
                    format!("Summary {sequence} of messages {start}..={end}. ").repeat(8)
                ])
                .unwrap();
            start = end + 1;
            sequence += 1;
        }
        ctx.execute(
            // Tag inserts may already have created the row. The fold end T is the
            // last covered message, a counted row inside the tiled prefix; U is
            // then T + 1, the marker message itself.
            "INSERT INTO session_meta(session_id,harness,counter,compaction_marker_state) VALUES (?1,'opencode',?2,?3)
             ON CONFLICT(session_id) DO UPDATE SET counter=excluded.counter, compaction_marker_state=excluded.compaction_marker_state",
            params![
                session,
                tag as i64,
                json!({
                    "boundaryMessageId": format!("msg_{cut:07}"),
                    "summaryMessageId": "msg_summary",
                    "compactionPartId": "prt_0_compaction",
                    "targetEndMessageId": format!("msg_{:07}", covered - 1),
                })
                .to_string()
            ],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    ctx.commit().unwrap();
    StorePaths {
        opencode_db: dir.join("opencode.db"),
        context_db: dir.join("context.db"),
        store_db: dir.join("store.db"),
    }
}

fn peak_rss_kib() -> Option<u64> {
    std::fs::read_to_string("/proc/self/status")
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("VmHWM:"))?
        .trim()
        .trim_end_matches("kB")
        .trim()
        .parse()
        .ok()
}

/// The move alone, in a child process so its peak memory excludes the fixture.
#[test]
#[ignore = "child of move_175k_message_head_cost"]
fn move_175k_child() {
    let Some(dir) = std::env::var_os("MOVE_175K_DIR") else {
        return;
    };
    let dir = PathBuf::from(dir);
    let paths = StorePaths {
        opencode_db: dir.join("opencode.db"),
        context_db: dir.join("context.db"),
        store_db: dir.join("store.db"),
    };
    let before = peak_rss_kib();
    let started = std::time::Instant::now();
    let outcome = run(&paths, SYNTHETIC_SESSION, false, &Lsof, None).unwrap();
    let elapsed = started.elapsed();
    let Outcome::Moved(plan) = outcome else {
        panic!("not moved")
    };
    let record = record_of_session(&paths, SYNTHETIC_SESSION);
    println!(
        "MOVE_COST wall_ms={} peak_rss_kib={:?} rss_before_kib={:?} checkpoint={} compartments={} drops={} behind_cut={} missing={} record_bytes={}",
        elapsed.as_millis(),
        peak_rss_kib(),
        before,
        plan.record.tag_checkpoint,
        plan.record.compartments.len(),
        plan.record.drops.len(),
        plan.behind_cut,
        plan.missing.len(),
        record.len()
    );
}

fn record_of_session(paths: &StorePaths, session: &str) -> String {
    let conn = Connection::open(&paths.context_db).unwrap();
    read_move_record_raw(&conn, session).unwrap().unwrap()
}

/// Wall time and peak memory of the move on a session shaped like a
/// 175,000-message head, mostly summarized, with about 2,000 visible parts.
#[test]
#[ignore = "cost measurement; run explicitly"]
fn move_175k_message_head_cost() {
    let dir = tempfile::tempdir().unwrap();
    let started = std::time::Instant::now();
    let paths = write_synthetic_stores(
        dir.path(),
        &Synthetic {
            messages: 175_000,
            tail: 1_600,
            text_bytes: 786,
            compartments: 200,
        },
    );
    let sizes = database_files(&paths)
        .iter()
        .filter_map(|path| {
            Some((
                path.file_name()?.to_string_lossy().into_owned(),
                std::fs::metadata(path).ok()?.len(),
            ))
        })
        .collect::<Vec<_>>();
    println!(
        "FIXTURE built_ms={} files={sizes:?}",
        started.elapsed().as_millis()
    );
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "offline_move::tests::move_175k_child",
            "--ignored",
            "--nocapture",
        ])
        .env("MOVE_175K_DIR", dir.path())
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{stdout}{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let line = stdout
        .lines()
        .find(|line| line.starts_with("MOVE_COST"))
        .expect("cost line");
    println!("{line}");
}
