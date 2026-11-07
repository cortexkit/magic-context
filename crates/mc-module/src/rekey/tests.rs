use super::*;
use crate::store::{Durable, Store};
use cortexkit_role_compaction::read::SessionRef;

const TABLES: [&str; 9] = [
    "app_read_decisions",
    "app_read_headers",
    "app_read_message_index",
    "app_read_messages",
    "app_read_summaries",
    "head_murals",
    "memory_contexts",
    "sessions",
    "state_text_refs",
];

fn rekey_runner(path: &Path, request: &Request) -> Result<Summary, String> {
    super::rekey_with_check(
        path,
        &path.with_file_name("context.db"),
        request,
        |_| Ok(()),
    )
}

fn request() -> Request {
    Request {
        from: "thalamus-pi".into(),
        to: "thalamus-harness".into(),
        harness: "pi".into(),
        sessions: vec!["head-one".into(), "head-two".into()],
        dry_run: false,
    }
}

fn key(runner: &str, session: &str) -> SessionRef {
    SessionRef::new(runner, "pi", session)
}

fn basic_fixture(path: &Path) {
    let store = Store::open(path).unwrap();
    for session in &request().sessions {
        store
            .save(&key(&request().from, session), &Durable::default())
            .unwrap();
    }
}

// Include the schema, version, every column and every row, including shared
// text blobs. Counts alone would miss a refusal that changed a stored value.
fn dump(path: &Path) -> String {
    let connection = Connection::open(path).unwrap();
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    let mut result = format!("user_version={version}\n");
    let mut stmt = connection
        .prepare("SELECT name,type,sql FROM sqlite_schema ORDER BY name")
        .unwrap();
    let schema = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    for (name, kind, sql) in schema {
        result.push_str(&format!("{name:?} {kind:?} {sql:?}\n"));
        if kind != "table" {
            continue;
        }
        let mut stmt = connection
            .prepare("SELECT name FROM pragma_table_info(?1)")
            .unwrap();
        let columns = stmt
            .query_map([&name], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let expressions = columns
            .iter()
            .map(|column| format!("quote({})", quoted(column)))
            .collect::<Vec<_>>()
            .join(",");
        let mut stmt = connection
            .prepare(&format!("SELECT {expressions} FROM {}", quoted(&name)))
            .unwrap();
        let mut rows = stmt
            .query_map([], |row| {
                (0..columns.len())
                    .map(|index| row.get::<_, String>(index))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        rows.sort();
        for row in rows {
            result.push_str(&format!("{row:?}\n"));
        }
    }
    result
}

fn loaded_session(
    store: &Store,
    key: SessionRef,
    db: std::sync::Arc<crate::context_db::ContextDb>,
) -> crate::session::Session {
    use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
    use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};
    let route = crate::route::Route {
        session: key.clone(),
        project: None,
        workdir: None,
        agent_id: None,
    };
    let setup = SetupRequest::new(
        "worker",
        ModelRef::new("test", "model"),
        100_000,
        1000,
        ProviderRules::new(SignedParts::None, EditCost::Suffix),
        Vec::new(),
        1,
    );
    let mut session =
        crate::session::Session::new(&route, &setup, crate::preset::Features::NONE, Some(db));
    session.load_summaries();
    session.restore(
        store
            .load(&key)
            .expect("durable session under requested runner"),
    );
    session.set_memory_context(store.memory_context(&key).expect("stored memory context"));
    session
}

#[test]
fn rekey_preserves_every_table_and_restores_session_state() {
    use crate::app_read::{IndexRow, Message, Snapshot};
    use crate::context_db::ContextDb;
    use crate::summary::head::Baseline;
    use cortexkit_role_compaction::read::Role;
    use cortexkit_role_compaction::view::{Edit, EditOp, InsertAt, InsertedMessage, View};
    use serde_json::json;
    use std::sync::Arc;

    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("mode3.db");
    let context_path = root.path().join("context.db");
    let db = Arc::new(ContextDb::create_for_tests(&context_path).unwrap());
    let store = Store::open(&path).unwrap();
    let request = request();
    let baseline = Baseline {
        m0: "Historical text mentions thalamus-pi. ".repeat(1000),
        through_sequence: 1,
        ..Baseline::default()
    };
    let view = View::seal(
        7,
        vec![Edit::new(
            7,
            EditOp::Insert {
                at: InsertAt::Start,
                message: InsertedMessage::new("history", Role::User, vec![baseline.m0.clone()]),
            },
        )],
    );
    let pending = serde_json::from_value(json!({"view":view,"covered":[],"before":{
        "latest":null,"queued":[],"refused_once":[],"emergency_latched":false,
        "baseline":baseline,"fold_due":false,"caveman":{"depths":[],"english_word_rules":null},"cut":19,"pruned_turns":3
    }})).unwrap();
    let mut durable = Durable {
        version: 7,
        cut: Some(19),
        baseline: Some(Arc::new(baseline)),
        queued: BTreeSet::from([("m20".into(), "p".into())]),
        pending_keep: Some(BTreeSet::from([("m21".into(), "p".into())])),
        reminder_counter: 42,
        reclaim_bookmark: 18,
        pruned_turns: 3,
        unconfirmed: vec![pending],
        ..Durable::default()
    };
    durable.app.stamps.insert(("m20".into(), "p".into()), 1234);
    let memory: crate::memory_profile::MemoryContext = serde_json::from_value(json!({
        "profile":{"name":"head","version":"1.0.0","digest":"d","resolution":"frozen","state":"resolved","parity":true},
        "category_ids":{"facts":"legacy-facts"},"project_id":"project","workspace_id":"workspace","domain":"test", "members_digest":"members",
        "stamp":{"note":"thalamus-pi"},"snapshot_digest":"snapshot"
    })).unwrap();
    let decisions =
        vec![json!({"decision_id":"d1","reason":"thalamus-pi remains historical text"})];
    let mut before_sessions = Vec::new();
    for id in &request.sessions {
        let key = key(&request.from, id);
        db.with_connection(|conn| {
            conn.execute("INSERT INTO compartments (session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,p1,created_at,harness) VALUES (?1,1,1,19,'m1','m19','Earlier work','summary','summary',1,'pi')", [id])?;
            conn.execute("INSERT INTO tags (session_id,message_id,type,tag_number,harness) VALUES (?1,'m20','tool',730,'pi')", [id])?;
            Ok::<_, rusqlite::Error>(())
        }).unwrap();
        store.save(&key, &durable).unwrap();
        store
            .save_head_mural(&key, "mural", &[137, 80, 78, 71])
            .unwrap();
        assert_eq!(store.keep_memory_context(&key, memory.clone()), memory);
        let messages = BTreeMap::from_iter((20..=21).map(|ordinal| {
            let mid = format!("m{ordinal}");
            (mid.clone(), Message { ordinal, at_ms: ordinal * 10, row: json!({"message_id":mid,"state":"raw","parts":{"tagged":1,"stamped":0,"dropped":0}}) })
        }));
        let snapshot = Snapshot {
            key: key.clone(),
            base: 19,
            newest: 21,
            ready: true,
            meta: json!({"model":"test"}),
            breakdown: json!({"total":{"tokens":123}}),
            compartments: vec![json!({"compartment_id":"1","summary_markdown":"summary"})],
            messages,
            decisions: decisions.clone(),
        };
        let index: Vec<_> = snapshot
            .messages
            .iter()
            .map(|(mid, message)| IndexRow {
                mid: mid.clone(),
                ordinal: message.ordinal,
                at_ms: message.at_ms,
            })
            .collect();
        store.save_app_index(&key, &index, None).unwrap();
        store.save_app_snapshot(&snapshot).unwrap();
        let session = loaded_session(&store, key, Arc::clone(&db));
        assert!(session.has_memory_context());
        let restored = session.durable();
        assert_eq!(restored.cut, Some(19));
        assert_eq!(restored.unconfirmed, durable.unconfirmed);
        before_sessions.push(restored);
    }
    // These keys must not be mistaken for either selected runner/harness/session.
    for key in [
        key(&request.from, "unselected"),
        SessionRef::new(&request.from, "other", "head-one"),
        key("other", "head-one"),
    ] {
        store.save(&key, &Durable::default()).unwrap();
    }
    drop(store);
    let context_before = dump(&context_path);
    let before = dump(&path);
    let connection = Connection::open(&path).unwrap();
    let mut projection = crate::app_read::persistence::load(&connection).unwrap();
    let texts: Vec<(String, String)> = connection
        .prepare("SELECT id,text FROM state_texts ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(!texts.is_empty());
    drop(connection);

    let dry = Request {
        dry_run: true,
        ..request.clone()
    };
    let dry_summary = rekey_runner(&path, &dry).unwrap();
    assert_eq!(dump(&path).as_bytes(), before.as_bytes());
    let summary = rekey_runner(&path, &request).unwrap();
    assert_eq!(
        Summary {
            dry_run: false,
            ..dry_summary
        },
        summary
    );
    assert_eq!(summary.sessions_rekeyed, 2);
    assert_eq!(
        summary.rows_per_table,
        BTreeMap::from_iter(TABLES.map(|table| (
            table.to_owned(),
            if matches!(table, "app_read_messages" | "app_read_message_index") {
                4
            } else {
                2
            }
        )))
    );
    assert_eq!(dump(&context_path).as_bytes(), context_before.as_bytes());

    let connection = Connection::open(&path).unwrap();
    for table in TABLES {
        let old: u64 = connection.query_row(&format!("SELECT count(*) FROM {} WHERE runner=?1 AND harness=?2 AND session IN ('head-one','head-two')", quoted(table)), params![request.from,request.harness], |row| row.get(0)).unwrap();
        assert_eq!(old, 0, "old rows in {table}");
    }
    for snapshot in &mut projection {
        snapshot.key.runner.clone_from(&request.to);
    }
    assert_eq!(
        crate::app_read::persistence::load(&connection).unwrap(),
        projection
    );
    let after_texts: Vec<(String, String)> = connection
        .prepare("SELECT id,text FROM state_texts ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(after_texts, texts);
    drop(connection);
    let store = Store::open(&path).unwrap();
    for (id, before) in request.sessions.iter().zip(before_sessions) {
        let key = key(&request.to, id);
        assert_eq!(store.load(&key), Some(durable.clone()));
        assert_eq!(store.memory_context(&key), Some(memory.clone()));
        assert_eq!(store.head_mural(&key, "mural"), Some(vec![137, 80, 78, 71]));
        assert_eq!(store.app_index_tip(&key), Some((21, "m21".into())));
        assert_eq!(store.app_decisions(&key), decisions);
        let session = loaded_session(&store, key, Arc::clone(&db));
        assert!(session.has_memory_context());
        assert_eq!(session.durable(), before);
        // Confirmed views and the highest tag belong to the runner and shared
        // context, not to a second copy inside mode3.db. The pending view and
        // its checksum must still restore verbatim for the runner to settle.
        assert_eq!(
            serde_json::to_value(&session.durable().unconfirmed).unwrap()[0]["view"],
            serde_json::to_value(&view).unwrap()
        );
        let checkpoint: u64 = db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT MAX(tag_number) FROM tags WHERE session_id=?1 AND harness='pi'",
                    [id],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(checkpoint, 730);
    }
    for key in [
        key(&request.from, "unselected"),
        SessionRef::new(&request.from, "other", "head-one"),
        key("other", "head-one"),
    ] {
        assert_eq!(store.load(&key), Some(Durable::default()));
    }
}

#[test]
fn rekey_refuses_unfinished_historian_attempts_without_changing_either_dump() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("mode3.db");
    let context = root.path().join("context.db");
    basic_fixture(&path);
    drop(crate::context_db::ContextDb::create_for_tests(&context).unwrap());
    let conn = Connection::open(&context).unwrap();
    for state in [
        "reserved",
        "dispatched",
        "sending",
        "replied",
        "future_open_state",
    ] {
        conn.execute("INSERT INTO memory_stage_attempts (stage_key,project_path,publication_id,run_attempt,stage,session_id,harness,carrier,state,request_json,started_at) VALUES (?1,'project',?1,1,'turn_two','head-two','pi','ck-mc:thalamus-pi',?1,'{}',1)", [state]).unwrap();
        let before_store = dump(&path);
        let before_context = dump(&context);
        for dry_run in [false, true] {
            let request = Request {
                dry_run,
                ..request()
            };
            let error = rekey_runner(&path, &request).unwrap_err();
            assert!(error.starts_with("summary_in_flight"), "{state}: {error}");
            assert_eq!(dump(&path).as_bytes(), before_store.as_bytes());
            assert_eq!(dump(&context).as_bytes(), before_context.as_bytes());
        }
        conn.execute("DELETE FROM memory_stage_attempts", [])
            .unwrap();
    }
    for state in [
        "published",
        "superseded",
        "resolved",
        "revoked",
        "envelope_failed",
        "expired",
        "transport_failed",
        "parse_failed",
        "counter_reset",
    ] {
        conn.execute("INSERT INTO memory_stage_attempts (stage_key,project_path,publication_id,run_attempt,stage,session_id,harness,carrier,state,request_json,started_at) VALUES (?1,'project',?1,1,'turn_two','head-one','pi','ck-mc:thalamus-pi',?1,'{}',1)", [state]).unwrap();
    }
    for (id, harness, carrier) in [
        ("unselected", "pi", "ck-mc:thalamus-pi"),
        ("head-one", "other", "ck-mc:thalamus-pi"),
        ("head-one", "pi", "ck-mc:other"),
    ] {
        conn.execute("INSERT INTO memory_stage_attempts (stage_key,project_path,publication_id,run_attempt,stage,session_id,harness,carrier,state,request_json,started_at) VALUES (?1,'project',?1,1,'turn_two',?2,?3,?4,'sending','{}',1)", params![format!("{id}:{harness}:{carrier}"),id,harness,carrier]).unwrap();
    }
    let before = dump(&context);
    rekey_runner(&path, &request()).unwrap();
    assert_eq!(dump(&context), before);
}

#[test]
fn rekey_table_list_equals_current_store_schema() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("mode3.db");
    basic_fixture(&path);
    let connection = Connection::open(path).unwrap();
    assert_eq!(session_tables(&connection).unwrap(), TABLES);
}

#[test]
fn rekey_discovers_future_session_tables_and_quotes_their_names() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("mode3.db");
    basic_fixture(&path);
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TABLE \"future\"\"table\" (runner TEXT,harness TEXT,session TEXT,value BLOB); INSERT INTO \"future\"\"table\" VALUES ('thalamus-pi','pi','head-one',X'ABCD');").unwrap();
    drop(connection);
    let result = rekey_runner(&path, &request()).unwrap();
    assert_eq!(result.rows_per_table["future\"table"], 1);
    let connection = Connection::open(path).unwrap();
    let row: (String, Vec<u8>) = connection
        .query_row("SELECT runner,value FROM \"future\"\"table\"", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!(row, (request().to, vec![0xab, 0xcd]));
}

#[test]
fn rekey_refusals_preserve_the_full_dump() {
    for reason in [
        "session_unknown",
        "target_exists",
        "same_runner",
        "schema_unversioned",
        "schema_old",
        "schema_new",
    ] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("mode3.db");
        basic_fixture(&path);
        let mut request = request();
        let expected = match reason {
            "session_unknown" => {
                request.sessions.push("missing".into());
                "session_unknown"
            }
            "target_exists" => {
                // A collision in a side table matters even without a target sessions row.
                let connection = Connection::open(&path).unwrap();
                connection
                    .execute(
                        "INSERT INTO state_text_refs VALUES (?1,?2,?3,'orphan')",
                        params![request.to, request.harness, request.sessions[1]],
                    )
                    .unwrap();
                "target_exists"
            }
            "same_runner" => {
                request.to = request.from.clone();
                "same_runner"
            }
            _ => {
                let version = match reason {
                    "schema_unversioned" => 0,
                    "schema_old" => SCHEMA_VERSION - 1,
                    _ => SCHEMA_VERSION + 1,
                };
                Connection::open(&path)
                    .unwrap()
                    .pragma_update(None, "user_version", version)
                    .unwrap();
                "schema_mismatch"
            }
        };
        let before = dump(&path);
        let error = rekey_runner(&path, &request).unwrap_err();
        assert!(error.starts_with(expected), "{reason}: {error}");
        assert_eq!(dump(&path).as_bytes(), before.as_bytes(), "{reason}");
    }
}

#[test]
fn rekey_a_late_update_error_rolls_back_every_session_and_table() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("mode3.db");
    basic_fixture(&path);
    Connection::open(&path).unwrap().execute_batch(
        "CREATE TRIGGER forbid_second_rekey BEFORE UPDATE ON sessions WHEN OLD.session='head-two' BEGIN SELECT RAISE(ABORT, 'blocked second rekey'); END;"
    ).unwrap();
    let before = dump(&path);
    assert!(rekey_runner(&path, &request())
        .unwrap_err()
        .contains("blocked second rekey"));
    assert_eq!(dump(&path), before);
}

#[test]
fn rekey_shared_store_leases_refuse_offline_rekey_but_allow_two_stores() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("mode3.db");
    basic_fixture(&path);
    let first = Store::open(&path).unwrap();
    let second = Store::open(&path).unwrap();
    let before = dump(&path);
    assert!(rekey_runner(&path, &request())
        .unwrap_err()
        .starts_with("store_in_use"));
    assert_eq!(dump(&path), before);
    drop(first);
    assert!(rekey_runner(&path, &request())
        .unwrap_err()
        .starts_with("store_in_use"));
    drop(second);
    let exclusive = lock_store(&path, true).unwrap();
    assert!(Store::open(&path)
        .err()
        .unwrap()
        .starts_with("store_in_use"));
    drop(exclusive);
    rekey_runner(&path, &request()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(root.path().join("mode3.db.lock"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn rekey_injected_open_file_check_refuses_without_changing_the_dump() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("mode3.db");
    basic_fixture(&path);
    let before = dump(&path);
    let error = super::rekey_with_check(
        &path,
        &path.with_file_name("context.db"),
        &request(),
        |checked| {
            assert_eq!(checked, path.canonicalize().unwrap());
            Err("store_in_use: fake process holds the store".into())
        },
    )
    .unwrap_err();
    assert!(error.starts_with("store_in_use"));
    assert_eq!(dump(&path), before);
    rekey_runner(&path, &request()).unwrap();
}

#[test]
fn rekey_parse_requires_complete_unambiguous_arguments() {
    let parse = |args: &[&str]| Request::parse(args.iter().map(|arg| (*arg).to_owned()));
    for args in [
        vec![],
        vec!["--from"],
        vec!["--wat"],
        vec!["--from", "a", "--from", "b"],
    ] {
        assert!(parse(&args).unwrap_err().starts_with("invalid_arguments"));
    }
    let request = parse(&[
        "--from",
        "a",
        "--to",
        "b",
        "--harness",
        "pi",
        "--session",
        "one",
        "--session",
        "two",
        "--dry-run",
    ])
    .unwrap();
    assert_eq!(request.sessions, ["one", "two"]);
    assert!(request.dry_run);
}
