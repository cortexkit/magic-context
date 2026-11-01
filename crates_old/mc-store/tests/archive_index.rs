// These #[path] declarations compile store.rs, fts.rs and ordinals.rs directly:
// archive_index/mod.rs does not yet declare those source files as public modules.
// testdata/archive_index/integration.patch supplies the three pub mod declarations.
#[path = "../src/archive_index/fts.rs"]
mod fts;
#[path = "../src/archive_index/ordinals.rs"]
mod ordinals;
#[path = "../src/archive_index/store.rs"]
mod store;

use std::{fs, path::Path, process::Command, sync::OnceLock};

use mc_store::{
    context_schema::{BOOTSTRAP, BOOTSTRAP_VERSION},
    parity_schema_manifest::{
        CapabilityResult, ContextSchemaRequest, ContextSchemaStore, Generation,
    },
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use store::{IngestBatch, RawMessage};
use tempfile::TempDir;

fn temp() -> TempDir {
    let root = std::env::temp_dir().join("magic-context/archive-index-2b");
    fs::create_dir_all(&root).unwrap();
    tempfile::Builder::new()
        .prefix("rust-")
        .tempdir_in(root)
        .unwrap()
}

fn database(path: &Path) -> Connection {
    match BOOTSTRAP.bootstrap(&ContextSchemaRequest {
        database_path: path.to_str().unwrap().to_owned(),
        expected_schema_version: BOOTSTRAP_VERSION,
        writer_generation: Generation(1),
    }) {
        CapabilityResult::Available { .. } => {}
        other => panic!("bootstrap failed: {other:?}"),
    }
    let db = Connection::open(path).unwrap();
    store::install(&db).unwrap();
    db
}

fn golden() -> &'static Value {
    static GOLDEN: OnceLock<Value> = OnceLock::new();
    GOLDEN.get_or_init(|| {
        let temp = temp();
        let output = temp.path().join("typescript.json");
        let script =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/archive_index/generate.ts");
        let result = Command::new("bun")
            .arg(script)
            .arg(&output)
            .output()
            .expect("Bun is required for the real TypeScript differential indexer");
        assert!(
            result.status.success(),
            "TypeScript generator failed:\n{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        println!("{}", String::from_utf8_lossy(&result.stdout).trim());
        serde_json::from_slice(&fs::read(output).unwrap()).unwrap()
    })
}

fn fixture() -> Value {
    serde_json::from_str(include_str!("../testdata/archive_index/sequences.json")).unwrap()
}

fn message(id: &str, ordinal: i64, text: &str) -> RawMessage {
    RawMessage {
        id: id.to_owned(),
        ordinal,
        role: "user".into(),
        parts: vec![json!({"type":"text","text":text})],
        created_at: Some(ordinal * 100),
        completed_at: None,
        version: json!(1),
    }
}

fn batch<'a>(session: &'a str, revision: &'a str, messages: &'a [RawMessage]) -> IngestBatch<'a> {
    IngestBatch {
        session_id: session,
        source_revision: revision,
        messages,
        revert_from: None,
        index_limit: 100,
        now_ms: 1000,
        harness: "opencode",
    }
}

fn rows(db: &Connection, sql: &str, session: &str) -> Value {
    let mut statement = db.prepare(sql).unwrap();
    let names: Vec<String> = statement
        .column_names()
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    let rows = statement
        .query_map([session], |row| {
            let mut object = serde_json::Map::new();
            for (column, name) in names.iter().enumerate() {
                let value = match row.get_ref(column)? {
                    rusqlite::types::ValueRef::Null => Value::Null,
                    rusqlite::types::ValueRef::Integer(value) => json!(value),
                    rusqlite::types::ValueRef::Text(value) => {
                        json!(std::str::from_utf8(value).unwrap())
                    }
                    other => panic!("unexpected value {other:?}"),
                };
                object.insert(name.clone(), value);
            }
            Ok(Value::Object(object))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    json!(rows)
}

fn snapshot(db: &Connection, session: &str) -> Value {
    let state = store::progress(db, session).unwrap();
    json!({
        "fts": rows(db, "SELECT CAST(fts.message_ordinal AS INTEGER) AS ordinal,
            fts.message_id AS id,fts.role,fts.content,map.message_time_ms AS time
            FROM message_history_fts AS fts JOIN message_fts_rowid_map AS map ON map.fts_rowid=fts.rowid
            WHERE fts.session_id=?1 ORDER BY ordinal", session),
        "source": rows(db, "SELECT message_id AS id,message_ordinal AS ordinal,source_version AS version,
            normalized_content_hash AS hash,role FROM message_history_source WHERE session_id=?1 ORDER BY ordinal", session),
        "watermark": state.watermark, "dirty": state.dirty_floor,
    })
}

#[test]
fn raw_sequences_match_the_real_typescript_indexer() {
    let temp = temp();
    let mut db = database(&temp.path().join("context.db"));
    let fixture = fixture();
    let session = fixture["session"].as_str().unwrap();
    for (step_number, step) in fixture["steps"].as_array().unwrap().iter().enumerate() {
        let messages: Vec<RawMessage> = serde_json::from_value(step["messages"].clone()).unwrap();
        let revision = step["revision"].as_str().unwrap();
        let mut request = batch(session, revision, &messages);
        request.revert_from = step["revertFrom"].as_i64();
        store::ingest(&mut db, &request).unwrap();
        let mut actual = snapshot(&db, session);
        actual["ordinals"] = Value::Array(rows(&db,
            "SELECT message_id AS id,message_ordinal AS ordinal FROM raw_archive_ordinals WHERE session_id=?1 ORDER BY ordinal",
            session).as_array().unwrap().iter().map(|row| json!([row["id"], row["ordinal"]])).collect());
        assert_eq!(
            actual,
            golden()["snapshots"][step_number],
            "sequence step {step_number}"
        );
        assert_eq!(store::progress(&db, session).unwrap().revision, revision);
        if step_number == 0 {
            for case in golden()["queries"].as_array().unwrap() {
                let matches = fts::search(
                    &db,
                    session,
                    case["query"].as_str().unwrap(),
                    case["cutoff"].as_i64().unwrap(),
                    case["start"].as_i64(),
                    case["end"].as_i64(),
                    case["limit"].as_u64().unwrap() as usize,
                )
                .unwrap();
                assert_eq!(
                    json!(matches.iter().map(|row| row.ordinal).collect::<Vec<_>>()),
                    case["ordinals"],
                    "FTS case {case}"
                );
            }
            assert_eq!(
                golden()["queries"][0]["ordinals"],
                json!([1]),
                "porter stemming must find running for run"
            );
            assert_eq!(
                golden()["queries"][1]["ordinals"].as_array().unwrap().len(),
                2,
                "unicode61 must remove accents"
            );
            assert!(
                golden()["queries"][3]["ordinals"]
                    .as_array()
                    .unwrap()
                    .is_empty(),
                "role is not searched"
            );
        }
    }
    let expanded = store::read_by_id(&db, session, "a1").unwrap().unwrap();
    assert_eq!(expanded.ordinal, 2);
    assert_eq!(
        expanded.parts[1]["state"]["input"]["secret"],
        "revised expand only"
    );
    assert!(store::read_by_id(&db, session, "u2").unwrap().is_none());
    assert_eq!(
        store::read_range(&db, session, 2, 4, 64 * 1024)
            .unwrap()
            .len(),
        3
    );
    assert!(store::read_range(&db, session, 2, 4, 1).is_err());
    let config: Vec<(String, Value)> = db
        .prepare("SELECT k,v FROM message_history_fts_config ORDER BY k")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, json!(row.get::<_, i64>(1)?))))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let actual = config
        .iter()
        .map(|(k, v)| json!({"k":k,"v":v}))
        .collect::<Vec<_>>();
    assert_eq!(
        json!(actual),
        golden()["config"],
        "FTS5 merge settings are untouched"
    );
}

#[test]
fn unclosed_system_reminder_body_is_not_searchable() {
    let parts = [json!({
        "type": "text",
        "text": "  searchable <system-reminder>injected tail without a closing tag"
    })];
    assert_eq!(store::indexable_content("assistant", &parts), "searchable");
}

#[test]
fn content_projection_and_oversize_policy_match_typescript() {
    let fixture = fixture();
    let messages: Vec<RawMessage> =
        serde_json::from_value(fixture["normalizations"].clone()).unwrap();
    let actual: Vec<String> = messages
        .iter()
        .map(|m| store::indexable_content(&m.role, &m.parts))
        .collect();
    assert_eq!(json!(actual), golden()["normalizations"]);
    let temp = temp();
    let mut db = database(&temp.path().join("context.db"));
    for case in golden()["versions"].as_array().unwrap() {
        let m: RawMessage = serde_json::from_value(case["message"].clone()).unwrap();
        let id = m.id.clone();
        store::ingest(&mut db, &batch("versions", "r1", &[m])).unwrap();
        let version: String = db.query_row(
            "SELECT source_version FROM message_history_source WHERE session_id='versions' AND message_id=?1",
            [id], |row| row.get(0),
        ).unwrap();
        assert_eq!(json!(version), case["expected"]);
    }
    let mut oversized = message("oversized", 1, &"é".repeat(32769));
    oversized.created_at = Some(123);
    oversized.version = Value::Null;
    store::ingest(&mut db, &batch("oversized", "r1", &[oversized.clone()])).unwrap();
    assert_eq!(snapshot(&db, "oversized"), golden()["oversized"]);
    let skip: String = db
        .query_row(
            "SELECT value FROM schema_migrations_meta WHERE key=?1",
            ["message_index_skip:[\"oversized\",\"oversized\"]"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&skip).unwrap(),
        golden()["skip"]
    );
    assert_eq!(
        store::read_by_id(&db, "oversized", "oversized").unwrap(),
        Some(oversized)
    );
    fts::backfill_rowid_map(&mut db, 100, 2).unwrap();
    store::ingest(
        &mut db,
        &batch("oversized", "r2", &[message("oversized", 1, "short now")]),
    )
    .unwrap();
    assert_eq!(
        fts::search(&db, "oversized", "short", 1, None, None, 10)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM schema_migrations_meta WHERE key LIKE 'message_index_skip:%'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn mutation_contract_identity_ordinals_ignore_request_position() {
    let temp = temp();
    let mut db = database(&temp.path().join("context.db"));
    store::ingest(
        &mut db,
        &batch(
            "identity",
            "r1",
            &[message("first", 0, "first"), message("second", 0, "second")],
        ),
    )
    .unwrap();
    // The second ID is first in this partial request. Retaining its old ordinal
    // prevents a later search/expand from pointing at the wrong original message.
    store::ingest(
        &mut db,
        &batch(
            "identity",
            "r2",
            &[
                message("second", 1, "edited"),
                message("second", 0, "edited"),
            ],
        ),
    )
    .unwrap();
    assert_eq!(
        ordinals::ordinal_for_id(&db, "identity", "second").unwrap(),
        Some(2)
    );
    assert_eq!(
        ordinals::ordinal_for_id(&db, "identity", "first").unwrap(),
        Some(1)
    );
    assert_eq!(
        store::read_by_id(&db, "identity", "second")
            .unwrap()
            .unwrap()
            .ordinal,
        2
    );
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM message_history_fts WHERE session_id='identity'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
}

#[test]
fn mutation_contract_watermark_is_committed_with_source_rows() {
    let temp = temp();
    let mut db = database(&temp.path().join("context.db"));
    store::ingest(
        &mut db,
        &batch("watermark", "r1", &[message("only", 1, "watermark needle")]),
    )
    .unwrap();
    assert_eq!(store::progress(&db, "watermark").unwrap().watermark, 1);
    assert_eq!(store::progress(&db, "watermark").unwrap().dirty_floor, None);
    assert_eq!(
        fts::search(&db, "watermark", "needle", 1, None, None, 10)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn bounded_archive_backfill_resumes_after_reopen_and_never_crosses_a_hole() {
    let temp = temp();
    let path = temp.path().join("context.db");
    let mut db = database(&path);
    let messages: Vec<_> = (1..=7)
        .map(|n| message(&format!("id{n}"), n, "resume needle"))
        .collect();
    let mut request = batch("resume", "r1", &messages);
    request.index_limit = 2;
    assert_eq!(
        store::ingest(&mut db, &request).unwrap().progress.watermark,
        2
    );
    assert_eq!(snapshot(&db, "resume"), golden()["bounded"][0]);
    drop(db);
    let mut db = Connection::open(&path).unwrap();
    assert_eq!(store::progress(&db, "resume").unwrap().dirty_floor, Some(3));
    for (step, expected) in [4, 6, 7].into_iter().enumerate() {
        let mut request = batch("resume", "r1", &[]);
        request.index_limit = 2;
        let receipt = store::ingest(&mut db, &request).unwrap();
        assert!(receipt.inserted <= 2);
        assert_eq!(receipt.progress.watermark, expected);
        let count: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM message_history_source WHERE session_id='resume'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, expected);
        assert_eq!(snapshot(&db, "resume"), golden()["bounded"][step + 1]);
    }
    assert_eq!(store::progress(&db, "resume").unwrap().dirty_floor, None);
    assert_eq!(
        store::read_range(&db, "resume", 1, 7, 65536).unwrap(),
        messages
    );

    store::ingest(
        &mut db,
        &batch("hole", "h1", &[message("third", 3, "future")]),
    )
    .unwrap();
    assert_eq!(store::progress(&db, "hole").unwrap().watermark, 0);
    assert_eq!(store::progress(&db, "hole").unwrap().dirty_floor, Some(1));
    assert_eq!(snapshot(&db, "hole"), golden()["holes"][0]);
    store::ingest(
        &mut db,
        &batch("hole", "h2", &[message("first", 1, "first")]),
    )
    .unwrap();
    assert_eq!(store::progress(&db, "hole").unwrap().watermark, 1);
    assert_eq!(store::progress(&db, "hole").unwrap().dirty_floor, Some(2));
    assert_eq!(snapshot(&db, "hole"), golden()["holes"][1]);
    store::ingest(
        &mut db,
        &batch("hole", "h3", &[message("second", 2, "second")]),
    )
    .unwrap();
    assert_eq!(store::progress(&db, "hole").unwrap().watermark, 3);
    assert_eq!(store::progress(&db, "hole").unwrap().dirty_floor, None);
    assert_eq!(snapshot(&db, "hole"), golden()["holes"][2]);
}

#[test]
fn identity_collisions_and_oversized_batches_roll_back() {
    let temp = temp();
    let mut db = database(&temp.path().join("context.db"));
    store::ingest(
        &mut db,
        &batch("rollback", "r1", &[message("first", 1, "original")]),
    )
    .unwrap();
    let before = snapshot(&db, "rollback");
    let messages = [
        message("new", 2, "would be written"),
        message("collision", 1, "wrong identity"),
    ];
    assert!(store::ingest(&mut db, &batch("rollback", "r2", &messages)).is_err());
    assert_eq!(snapshot(&db, "rollback"), before);
    assert_eq!(ordinals::last_assigned(&db, "rollback").unwrap(), 1);
    assert!(store::read_by_id(&db, "rollback", "new").unwrap().is_none());
    assert_eq!(store::progress(&db, "rollback").unwrap().revision, "r1");
    let large: Vec<_> = (2..=102)
        .map(|n| message(&format!("id{n}"), n, "large"))
        .collect();
    assert!(store::ingest(&mut db, &batch("rollback", "r3", &large)).is_err());
    assert_eq!(snapshot(&db, "rollback"), before);
}

#[test]
fn legacy_rowid_map_backfill_is_bounded_and_durable() {
    let temp = temp();
    let path = temp.path().join("context.db");
    let mut db = database(&path);
    // Model pending maintenance for rows inserted before canonical rowid mapping.
    db.execute(
        "UPDATE message_fts_rowid_map_backfill_state SET completed = 0 WHERE id = 1",
        [],
    )
    .unwrap();
    for ordinal in 1..=205 {
        db.execute(
            "INSERT INTO message_history_fts(session_id,message_ordinal,message_id,role,content)
            VALUES ('legacy',?1,?2,'user','legacy needle')",
            params![ordinal, format!("id{ordinal}")],
        )
        .unwrap();
    }
    let first = fts::backfill_rowid_map(&mut db, 1000, 1).unwrap();
    assert_eq!(first.processed, 100);
    assert_eq!(first.watermark_rowid, 100);
    assert!(!first.completed);
    drop(db);
    let mut db = Connection::open(path).unwrap();
    let second = fts::backfill_rowid_map(&mut db, 1000, 2).unwrap();
    assert_eq!(second.processed, 100);
    assert_eq!(second.watermark_rowid, 200);
    let last = fts::backfill_rowid_map(&mut db, 100, 3).unwrap();
    assert_eq!(last.processed, 5);
    assert!(last.completed);
    assert_eq!(last.watermark_rowid, 205);
    assert_eq!(
        fts::backfill_rowid_map(&mut db, 100, 4).unwrap().processed,
        0
    );
    assert_eq!(
        fts::search(&db, "legacy", "needle", 205, None, None, 300)
            .unwrap()
            .len(),
        205
    );
}

#[test]
fn legacy_unmapped_revision_defers_until_backfill_is_complete() {
    let temp = temp();
    let mut db = database(&temp.path().join("context.db"));
    store::ingest(
        &mut db,
        &batch("legacy-edit", "r1", &[message("id", 1, "original")]),
    )
    .unwrap();
    db.execute("DELETE FROM message_fts_rowid_map", []).unwrap();
    // Removing canonical mappings models an unfinished legacy backfill.
    db.execute(
        "UPDATE message_fts_rowid_map_backfill_state SET completed = 0 WHERE id = 1",
        [],
    )
    .unwrap();
    let edit = message("id", 1, "replacement");
    store::ingest(
        &mut db,
        &batch("legacy-edit", "r2", std::slice::from_ref(&edit)),
    )
    .unwrap();
    assert_eq!(
        store::progress(&db, "legacy-edit").unwrap().dirty_floor,
        Some(1)
    );
    let content: String = db
        .query_row(
            "SELECT content FROM message_history_fts WHERE session_id='legacy-edit'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(content, "original");
    assert!(!fts::range_is_mapped(&db, "legacy-edit", 1, 1).unwrap());
    fts::backfill_rowid_map(&mut db, 100, 2).unwrap();
    store::ingest(&mut db, &batch("legacy-edit", "r2", &[])).unwrap();
    assert_eq!(
        fts::search(&db, "legacy-edit", "replacement", 1, None, None, 10)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store::progress(&db, "legacy-edit").unwrap().dirty_floor,
        None
    );
    assert_eq!(
        store::read_by_id(&db, "legacy-edit", "id").unwrap(),
        Some(edit)
    );
}

#[test]
fn crash_probe() {
    let Some(path) = std::env::var_os("RAW_ARCHIVE_CRASH_DATABASE") else {
        return;
    };
    let mut db = Connection::open(path).unwrap();
    db.create_scalar_function(
        "crash_mid_ingest",
        0,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8,
        |_| -> rusqlite::Result<i64> { std::process::exit(77) },
    )
    .unwrap();
    store::ingest(
        &mut db,
        &batch("crash", "r2", &[message("new", 2, "uncommitted needle")]),
    )
    .unwrap();
    panic!("the transaction never reached its crash trigger");
}

#[test]
fn process_crash_during_ingest_preserves_the_previous_committed_state() {
    let temp = temp();
    let path = temp.path().join("context.db");
    let mut db = database(&path);
    store::ingest(
        &mut db,
        &batch("crash", "r1", &[message("old", 1, "committed")]),
    )
    .unwrap();
    let before = snapshot(&db, "crash");
    db.execute_batch(
        "CREATE TRIGGER archive_crash BEFORE UPDATE ON message_history_index
        BEGIN SELECT crash_mid_ingest(); END;",
    )
    .unwrap();
    drop(db);
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "crash_probe", "--nocapture"])
        .env("RAW_ARCHIVE_CRASH_DATABASE", &path)
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(77),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let db = Connection::open(&path).unwrap();
    assert_eq!(snapshot(&db, "crash"), before);
    assert_eq!(store::progress(&db, "crash").unwrap().revision, "r1");
    assert_eq!(ordinals::ordinal_for_id(&db, "crash", "new").unwrap(), None);
    assert!(store::read_by_id(&db, "crash", "new").unwrap().is_none());
    assert_eq!(
        fts::search(&db, "crash", "uncommitted", 2, None, None, 10)
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn existing_typescript_source_identities_are_adopted_without_renumbering() {
    let temp = temp();
    let mut db = database(&temp.path().join("context.db"));
    store::ingest(
        &mut db,
        &batch(
            "adopt",
            "r1",
            &[
                message("first", 1, "original"),
                message("second", 2, "original"),
            ],
        ),
    )
    .unwrap();
    db.execute_batch("DELETE FROM raw_archive_messages; DELETE FROM raw_archive_ordinals; DELETE FROM raw_archive_state;").unwrap();
    store::ingest(
        &mut db,
        &batch(
            "adopt",
            "r2",
            &[message("second", 0, "edit"), message("third", 0, "append")],
        ),
    )
    .unwrap();
    assert_eq!(
        ordinals::ordinal_for_id(&db, "adopt", "second").unwrap(),
        Some(2)
    );
    assert_eq!(
        ordinals::ordinal_for_id(&db, "adopt", "third").unwrap(),
        Some(3)
    );
    assert_eq!(store::progress(&db, "adopt").unwrap().watermark, 3);
    assert_eq!(
        fts::search(&db, "adopt", "original", 3, None, None, 10).unwrap()[0].ordinal,
        1
    );
}
