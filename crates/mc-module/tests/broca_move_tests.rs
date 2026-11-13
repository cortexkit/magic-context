//! Runner-to-runner moves use the recorded THALAMUS and Broca coordinates,
//! rather than rebuilding the standalone plugins' different numberings.

use cortexkit_role_compaction::read::{Cursor, SessionRef};
use cortexkit_role_compaction::view::EditOp;
use mc_module::context_db::ContextDb;
use mc_module::move_in::{move_in, MoveRequest, Moved};
use mc_module::move_renumber::HostMessage;
use mc_module::pass::Settings;
use mc_module::store::{Durable, Store};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

const DATA: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/broca-move");
const SOURCE: &str = "thalamus-session";
const TARGET: &str = "broca-session";

fn sample(host: &str, kind: &str, file: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{DATA}/{kind}/{host}/{file}")).unwrap()).unwrap()
}

fn messages(host: &str) -> Vec<HostMessage> {
    let source = sample(host, "thalamus", "entries-1.json");
    let imported = sample(host, "broca", "import-reply.json");
    let target = sample(host, "broca", "entries-unadmitted-1.json");
    let mut rows = imported["moves"]["rows"].as_array().unwrap().clone();
    for row in &mut rows {
        let entry = source["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["mid"] == row["mid"]);
        row["source_entry"] = entry.map_or(Value::Null, |e| e["ordinal"].clone());
    }
    // The import reply predates added-row reporting. The recorded entries and
    // comparison identify the split results; append them to their owning row.
    for entry in target["entries"].as_array().unwrap() {
        if !rows.iter().any(|r| r["mid"] == entry["mid"]) {
            rows.push(json!({"mid":entry["mid"], "entry":entry["ordinal"], "source_entry":null, "added":true}));
        }
    }
    rows.sort_by_key(|row| row["entry"].as_u64().unwrap_or(0));
    serde_json::from_value(json!(rows)).unwrap()
}

struct Fixture {
    dir: tempfile::TempDir,
    conn: Connection,
    store: Store,
    request: MoveRequest,
    source_key: SessionRef,
}

impl Fixture {
    fn new(host: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
        let conn = Connection::open(dir.path().join("context.db")).unwrap();
        let store = Store::open(&dir.path().join("mode3.db")).unwrap();
        let rows = messages(host);
        let last = rows.iter().rev().find(|r| r.entry.is_some()).unwrap();
        let request: MoveRequest = serde_json::from_value(json!({
            "session":{"runner":"broca", "harness":"broca", "session":TARGET},
            "preset":"head", "model":{"provider":"test","model":"model"},
            "context_window":100_000, "output_reserve":1000,
            "rules":cortexkit_role_compaction::rules::ProviderRules::new(
                cortexkit_role_compaction::rules::SignedParts::None,
                cortexkit_role_compaction::rules::EditCost::Suffix),
            "newest":Cursor::new(last.entry.unwrap(), &last.mid, "digest"), "now":10,
            "messages":rows, "source_harness":host, "source_session":SOURCE,
            "source_runner_entries":true, "tag_floor":700,
        }))
        .unwrap();
        let source_key = SessionRef::new("thalamus", host, SOURCE);
        store
            .save(
                &source_key,
                &Durable {
                    version: 42,
                    queued: [("old-mid".into(), "old-part".into())].into(),
                    cut: Some(2),
                    ..Durable::default()
                },
            )
            .unwrap();
        let incoming = json!({"version":3,"state":"moved","harness":host,"session":SOURCE});
        for harness in [host, "plugin-host"] {
            conn.execute(
                "INSERT INTO schema_migrations_meta(key,value) VALUES (?1,?2)",
                params![
                    format!("mode3_move:{harness}:{SOURCE}"),
                    incoming.to_string()
                ],
            )
            .unwrap();
        }
        let fixture = Self {
            dir,
            conn,
            store,
            request,
            source_key,
        };
        fixture.seed(host);
        fixture
    }

    fn seed(&self, host: &str) {
        let rows = self.request.messages.as_ref().unwrap();
        let source: Vec<_> = rows
            .iter()
            .filter(|r| r.source_entry.flatten().is_some())
            .collect();
        for (seq, from, to) in [(1, 1, 3), (2, 4, 8)] {
            let first = source
                .iter()
                .find(|r| r.source_entry.flatten() == Some(from))
                .unwrap();
            let last = source
                .iter()
                .find(|r| r.source_entry.flatten() == Some(to))
                .unwrap();
            self.conn.execute("INSERT INTO compartments(session_id,harness,sequence,start_message,end_message,start_message_id,end_message_id,title,content,p1,created_at)
                VALUES (?1,?2,?3,?4,?5,?6,?7,'Summary','Useful history','Useful history',1)",
                params![SOURCE,host,seq,from,to,first.mid,last.mid]).unwrap();
        }
        self.conn.execute("INSERT INTO compartment_chunk_embeddings(compartment_id,session_id,harness,project_path,start_ordinal,end_ordinal,chunk_hash,model_id,dims,vector,created_at)
            SELECT id,session_id,harness,'/fixture',start_message,end_message,'hash','model',4,zeroblob(16),1 FROM compartments", []).unwrap();
        self.conn.execute("INSERT INTO memory_publications(publication_id,project_path,source_session_id) VALUES ('publication','/fixture',?1)",params![SOURCE]).unwrap();
        for row in source {
            let n = row.source_entry.flatten().unwrap();
            if row.entry.is_some() {
                self.conn.execute("INSERT INTO memory_fact_blocks(publication_id,source_session_id,start_ordinal,end_ordinal,role,parts_json,joined_text) VALUES ('publication',?1,?2,?2,'user','[]',?3)",params![SOURCE,n,row.mid]).unwrap();
            }
            self.conn.execute("INSERT INTO notes(type,content,session_id,harness,anchor_ordinal,created_at,updated_at) VALUES ('session',?1,?2,?3,?4,1,1)",params![row.mid,SOURCE,host,n]).unwrap();
            self.conn.execute("INSERT INTO compression_depth(session_id,harness,message_ordinal,depth) VALUES (?1,?2,?3,1)",params![SOURCE,host,n]).unwrap();
            self.conn.execute("INSERT INTO message_history_source(session_id,harness,message_id,message_ordinal,source_version,normalized_content_hash,role,updated_at) VALUES (?1,?2,?3,?4,'v','hash','user',1)",params![SOURCE,host,row.mid,n]).unwrap();
            self.conn.execute("INSERT INTO message_history_fts(rowid,session_id,message_id,message_ordinal,role,content) VALUES (?1,?2,?3,?1,'user','searchable history')",params![n,SOURCE,row.mid]).unwrap();
            self.conn.execute("INSERT INTO message_fts_rowid_map(session_id,message_ordinal,fts_rowid,message_time_ms) VALUES (?1,?2,?2,1)",params![SOURCE,n]).unwrap();
        }
        self.conn.execute("INSERT INTO tags(session_id,harness,message_id,type,tag_number) VALUES (?1,?2,'tagged','text',500)",params![SOURCE,host]).unwrap();
        self.conn.execute("INSERT INTO message_history_index(session_id,harness,last_indexed_ordinal,dirty_floor_ordinal,updated_at) VALUES (?1,?2,10,2,1)",params![SOURCE,host]).unwrap();
        self.conn.execute("INSERT INTO memory_observations(content,session_id,source_start_ordinal,source_end_ordinal,created_at) VALUES ('Preference',?1,5,6,1)",params![SOURCE]).unwrap();
        let provenance = json!([{"session_id":SOURCE,"harness":host,"source_compartment_start":5,"source_compartment_end":6}]).to_string();
        self.conn.execute("INSERT INTO memories(level,owner_id,category,origin_category,content,normalized_hash,first_seen_at,created_at,updated_at,last_seen_at,status,metadata_json) VALUES ('global','self','mc:user-unsorted','USER_MEMORY','Preference','Preference',1,1,1,1,'active',json_object('promoted_at',1,'source_candidate_provenance',?1))",params![provenance]).unwrap();
        self.conn.execute("INSERT INTO primer_candidates(project_path,harness,session_id,question,normalized_question,source_compartment_start,source_compartment_end,source_start_message_id,source_end_message_id,source_message_time,created_at) VALUES ('/fixture',?1,?2,'Question','question',5,6,'first','last',1,1)",params![host,SOURCE]).unwrap();
        self.conn.execute("INSERT INTO primers(project_path,question,source_candidate_provenance,created_at,updated_at) VALUES ('/fixture','Question',?1,1,1)",params![provenance]).unwrap();
        self.conn
            .execute(
                "INSERT INTO schema_migrations_meta(key,value) VALUES (?1,'{\"ordinal\":10}')",
                params![format!(
                    "message_index_skip:{}",
                    json!([SOURCE, "skip-mid"])
                )],
            )
            .unwrap();
        // Use a real message identity for the skipped-message metadata.
        let mid = rows
            .iter()
            .find(|r| r.source_entry.flatten() == Some(10))
            .unwrap()
            .mid
            .as_str();
        self.conn
            .execute(
                "UPDATE schema_migrations_meta SET key=?1 WHERE key LIKE 'message_index_skip:%'",
                params![format!("message_index_skip:{}", json!([SOURCE, mid]))],
            )
            .unwrap();
    }

    fn run(&self) -> Result<Moved, String> {
        move_in(
            ContextDb::open(&self.dir.path().join("context.db")).unwrap(),
            &self.store,
            &Settings::default().into(),
            &self.request,
        )
    }

    fn scalar<T: rusqlite::types::FromSql>(&self, sql: &str) -> T {
        self.conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn dumps(&self) -> (String, String) {
        (
            dump(&self.conn),
            dump(&Connection::open(self.dir.path().join("mode3.db")).unwrap()),
        )
    }

    fn refuses_unchanged(&self, code: &str) {
        let before = self.dumps();
        let error = self.run().unwrap_err();
        assert!(error.starts_with(code), "{error}");
        assert_eq!(self.dumps(), before, "{code} changed a database");
    }
}

/// Compare every table, including FTS shadow tables and externalized state
/// text. Selected row counts would miss partial writes to another move phase.
fn dump(conn: &Connection) -> String {
    let mut out = String::new();
    let schema: Vec<(String, Option<String>)> = conn
        .prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    out.push_str(&format!("{schema:?}\n"));
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for table in tables {
        let mut s = conn
            .prepare(&format!("SELECT * FROM \"{}\"", table.replace('"', "\"\"")))
            .unwrap();
        let cols = s.column_count();
        let mut rows: Vec<String> = s
            .query_map([], |r| {
                Ok(format!(
                    "{:?}",
                    (0..cols)
                        .map(|i| r.get::<_, rusqlite::types::Value>(i))
                        .collect::<Result<Vec<_>, _>>()?
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        rows.sort();
        out.push_str(&format!("{table}: {rows:?}\n"));
    }
    out
}

#[test]
fn runner_moves_use_source_entries_for_opencode2_and_pi() {
    for host in ["opencode2", "pi"] {
        let fixture = Fixture::new(host);
        let source_state = fixture.store.load(&fixture.source_key).unwrap();
        let plugin_fence: String = fixture.scalar(
            "SELECT value FROM schema_migrations_meta WHERE key LIKE 'mode3_move:plugin-host:%'",
        );
        let moved = fixture.run().unwrap();
        assert_eq!(moved.tag_checkpoint, 700);
        assert_eq!(moved.source_state_kept, Some(true));
        assert_eq!(
            fixture.store.load(&fixture.source_key).unwrap(),
            source_state
        );
        let destination = fixture.store.load(&fixture.request.session).unwrap();
        assert!(destination.queued.is_empty());
        assert_eq!(destination.version, 1);
        assert_eq!(
            destination.cut,
            Some(if host == "opencode2" { 9 } else { 7 })
        );
        assert_eq!(fixture.scalar::<String>("SELECT value FROM schema_migrations_meta WHERE key LIKE 'mode3_move:plugin-host:%'"), plugin_fence);

        let imports = sample(host, "broca", "import-reply.json");
        let expected = |mid: &str| {
            imports["moves"]["rows"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["mid"] == mid)
                .unwrap()["entry"]
                .as_u64()
        };
        let through = |entry: u64| {
            if host == "opencode2" && [2, 11].contains(&entry) {
                entry + 1
            } else {
                entry
            }
        };
        let ranges: Vec<(u64, u64)> = fixture
            .conn
            .prepare("SELECT start_message,end_message FROM compartments ORDER BY sequence")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            ranges,
            if host == "opencode2" {
                vec![(1, 4), (5, 9)]
            } else {
                vec![(1, 2), (3, 7)]
            }
        );
        let chunks: Vec<(u64, u64)> = fixture
            .conn
            .prepare(
                "SELECT start_ordinal,end_ordinal FROM compartment_chunk_embeddings ORDER BY id",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(chunks, ranges);
        for (sql, position, range) in [
            ("SELECT joined_text,start_ordinal,end_ordinal FROM memory_fact_blocks", false, true),
            ("SELECT content,anchor_ordinal,anchor_ordinal FROM notes", true, false),
            ("SELECT message_id,message_ordinal,message_ordinal FROM message_history_source", false, false),
            ("SELECT message_id,message_ordinal,message_ordinal FROM message_history_fts", false, false),
            ("SELECT f.message_id,m.message_ordinal,m.message_ordinal FROM message_fts_rowid_map m JOIN message_history_fts f ON f.rowid=m.fts_rowid", false, false),
        ] {
            let rows: Vec<(String,u64,u64)> = fixture.conn.prepare(sql).unwrap().query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap().collect::<Result<_,_>>().unwrap();
            for (mid,start,end) in rows {
                let entry = expected(&mid).unwrap_or(0);
                assert_eq!(start,if position {through(entry)} else {entry},"{host}: {sql}: {mid}");
                assert_eq!(end,if range || position {through(entry)} else {entry},"{host}: {sql}: {mid}");
            }
        }
        let depths: Vec<u64> = fixture
            .conn
            .prepare("SELECT message_ordinal FROM compression_depth ORDER BY message_ordinal")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let mut expected_depths: Vec<_> = imports["moves"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|r| r["entry"].as_u64())
            .collect();
        expected_depths.sort();
        assert_eq!(depths, expected_depths);
        for (table, query) in [
            (
                "user_memories",
                "SELECT json_extract(metadata_json, '$.source_candidate_provenance') FROM memories WHERE level = 'global'",
            ),
            ("primers", "SELECT source_candidate_provenance FROM primers"),
        ] {
            let text: String = fixture.scalar(query);
            let list: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(list[0]["session_id"], TARGET);
            assert_eq!(
                list[0]["source_compartment_start"],
                if host == "opencode2" { 6 } else { 4 }
            );
            assert_eq!(
                list[0]["source_compartment_end"],
                if host == "opencode2" { 7 } else { 5 }
            );
            if table == "primers" {
                assert_eq!(list[0]["harness"], "broca");
            }
        }
        for (table, start, end) in [
            (
                "memory_observations",
                "source_start_ordinal",
                "source_end_ordinal",
            ),
            (
                "primer_candidates",
                "source_compartment_start",
                "source_compartment_end",
            ),
        ] {
            assert_eq!(
                fixture.scalar::<String>(&format!("SELECT session_id FROM {table}")),
                TARGET
            );
            assert_eq!(
                fixture.scalar::<u64>(&format!("SELECT {start} FROM {table}")),
                if host == "opencode2" { 6 } else { 4 }
            );
            assert_eq!(
                fixture.scalar::<u64>(&format!("SELECT {end} FROM {table}")),
                if host == "opencode2" { 7 } else { 5 }
            );
        }
        assert_eq!(
            fixture.scalar::<u64>("SELECT last_indexed_ordinal FROM message_history_index"),
            if host == "opencode2" { 12 } else { 9 }
        );
        assert_eq!(
            fixture.scalar::<u64>("SELECT dirty_floor_ordinal FROM message_history_index"),
            if host == "opencode2" { 3 } else { 1 }
        );
        assert_eq!(
            fixture.scalar::<String>("SELECT source_session_id FROM memory_publications"),
            TARGET
        );
        assert_eq!(
            fixture.scalar::<String>("SELECT source_session_id FROM memory_fact_blocks LIMIT 1"),
            TARGET
        );
        let skip: String = fixture.scalar(
            "SELECT value FROM schema_migrations_meta WHERE key LIKE 'message_index_skip:%'",
        );
        assert_eq!(
            serde_json::from_str::<Value>(&skip).unwrap()["ordinal"],
            if host == "opencode2" { 11 } else { 9 }
        );
        let key: String = fixture
            .scalar("SELECT key FROM schema_migrations_meta WHERE key LIKE 'message_index_skip:%'");
        assert!(key.contains(TARGET));
        for table in [
            "compartments",
            "notes",
            "tags",
            "message_history_index",
            "message_history_source",
            "compression_depth",
        ] {
            assert_eq!(
                fixture.scalar::<u64>(&format!(
                    "SELECT count(*) FROM {table} WHERE session_id='{SOURCE}'"
                )),
                0,
                "{table}"
            );
            assert_eq!(
                fixture.scalar::<u64>(&format!(
                    "SELECT count(*) FROM {table} WHERE harness!='broca'"
                )),
                0,
                "{table}"
            );
        }
        assert_eq!(
            fixture.scalar::<u64>(&format!(
                "SELECT count(*) FROM message_history_fts WHERE session_id='{SOURCE}'"
            )),
            0
        );
    }
}

#[test]
fn runner_cut_includes_added_results_but_never_the_raw_tail() {
    let fixture = Fixture::new("opencode2");
    // Source entry 2 is an assistant call; Broca split its result into entry 3.
    fixture
        .conn
        .execute("DELETE FROM compartments WHERE sequence=2", [])
        .unwrap();
    let mid = fixture
        .request
        .messages
        .as_ref()
        .unwrap()
        .iter()
        .find(|r| r.source_entry.flatten() == Some(2))
        .unwrap()
        .mid
        .as_str();
    fixture
        .conn
        .execute(
            "UPDATE compartments SET end_message=2,end_message_id=?1",
            params![mid],
        )
        .unwrap();
    let moved = fixture.run().unwrap();
    let added = fixture
        .request
        .messages
        .as_ref()
        .unwrap()
        .iter()
        .find(|r| r.entry == Some(3))
        .unwrap();
    assert!(moved
        .view
        .edits
        .iter()
        .any(|edit| matches!(&edit.op,EditOp::Cut{through} if through==&added.mid)));
    assert_eq!(
        fixture.store.load(&fixture.request.session).unwrap().cut,
        Some(3)
    );
}

#[test]
fn runner_without_summaries_starts_without_a_cut_and_keeps_the_plugin_tag_floor() {
    let mut fixture = Fixture::new("pi");
    fixture.request.tag_floor = Some(10);
    fixture
        .conn
        .execute("DELETE FROM compartments", [])
        .unwrap();
    let moved = fixture.run().unwrap();
    assert_eq!(moved.tag_checkpoint, 500);
    assert!(!moved
        .view
        .edits
        .iter()
        .any(|e| matches!(e.op, EditOp::Cut { .. })));
    assert_eq!(
        fixture.store.load(&fixture.request.session).unwrap().cut,
        None
    );
}

#[test]
fn runner_refusals_leave_both_full_database_dumps_unchanged() {
    let mut fixture = Fixture::new("opencode2");
    fixture
        .request
        .messages
        .as_mut()
        .unwrap()
        .iter_mut()
        .find(|r| r.source_entry.flatten() == Some(6))
        .unwrap()
        .source_entry = Some(None);
    fixture.refuses_unchanged("ordinal_unmapped:");

    let fixture = Fixture::new("pi");
    fixture.conn.execute("INSERT INTO notes(content,session_id,harness,created_at,updated_at) VALUES ('Destination',?1,'broca',1,1)",params![TARGET]).unwrap();
    fixture.refuses_unchanged("target_exists:");

    let fixture = Fixture::new("pi");
    let system = fixture.request.messages.as_ref().unwrap()[0].mid.as_str();
    fixture.conn.execute("UPDATE compartments SET start_message=1,end_message=1,start_message_id=?1,end_message_id=?1 WHERE sequence=1",params![system]).unwrap();
    fixture.refuses_unchanged("summary_covers_no_runner_entry: summary 1");

    let mut fixture = Fixture::new("opencode2");
    fixture.run().unwrap();
    fixture.refuses_unchanged("session_already_moved:");
    fixture.request.source_harness = Some("broca".into());
    fixture.request.source_session = Some(TARGET.into());
    fixture.request.session.session = "third-session".into();
    fixture.refuses_unchanged("session_already_moved:");
}

#[test]
fn runner_move_list_requires_explicit_source_entries_and_every_target_entry() {
    let mut fixture = Fixture::new("opencode2");
    fixture
        .request
        .messages
        .as_mut()
        .unwrap()
        .retain(|r| !r.added);
    fixture.refuses_unchanged("invalid_messages:");
    let mut fixture = Fixture::new("pi");
    fixture.request.messages.as_mut().unwrap()[0].source_entry = None;
    fixture.refuses_unchanged("invalid_messages:");
}

#[test]
fn plugin_numbering_refuses_a_different_source_session_before_writing() {
    let mut fixture = Fixture::new("pi");
    fixture.request.source_runner_entries = false;
    fixture.refuses_unchanged("invalid_request: source_session");
}

#[test]
fn runner_move_resumes_after_the_destination_state_save_fails() {
    let fixture = Fixture::new("opencode2");
    let state = Connection::open(fixture.dir.path().join("mode3.db")).unwrap();
    state.execute_batch("CREATE TRIGGER fail_destination BEFORE INSERT ON sessions WHEN NEW.harness='broca' BEGIN SELECT RAISE(FAIL,'destination unavailable'); END;").unwrap();
    let refused = fixture.run().unwrap_err();
    assert!(refused.starts_with("state_save_failed:"), "{refused}");
    assert_eq!(
        fixture.scalar::<u64>("SELECT count(*) FROM compartments WHERE harness='broca'"),
        2
    );
    assert_eq!(
        fixture.scalar::<u64>(
            "SELECT count(*) FROM schema_migrations_meta WHERE key LIKE 'mode3_move:broca:%'"
        ),
        0
    );
    state
        .execute_batch("DROP TRIGGER fail_destination")
        .unwrap();
    fixture.run().unwrap();
    assert_eq!(
        fixture.store.load(&fixture.request.session).unwrap().cut,
        Some(9)
    );
}

#[test]
fn runner_move_can_keep_the_source_session_name() {
    let mut fixture = Fixture::new("pi");
    fixture.request.session.session = SOURCE.into();
    let source = fixture.store.load(&fixture.source_key).unwrap();
    fixture.run().unwrap();
    assert_eq!(
        fixture.scalar::<u64>("SELECT count(*) FROM compartments WHERE harness='broca'"),
        2
    );
    assert_eq!(fixture.store.load(&fixture.source_key).unwrap(), source);
    assert_eq!(
        fixture.store.load(&fixture.request.session).unwrap().cut,
        Some(7)
    );
}

#[test]
fn runner_move_refuses_corrupt_or_auxiliary_only_destination_state() {
    let fixture = Fixture::new("pi");
    fixture
        .store
        .save(&fixture.request.session, &Durable::default())
        .unwrap();
    let state = Connection::open(fixture.dir.path().join("mode3.db")).unwrap();
    state
        .execute(
            "UPDATE sessions SET state='{' WHERE runner='broca' AND harness='broca'",
            [],
        )
        .unwrap();
    assert!(fixture.store.load(&fixture.request.session).is_none());
    fixture.refuses_unchanged("target_exists:");

    let fixture = Fixture::new("pi");
    fixture
        .store
        .save_head_mural(&fixture.request.session, "fixture", b"mural")
        .unwrap();
    assert!(fixture.store.load(&fixture.request.session).is_none());
    fixture.refuses_unchanged("target_exists:");

    let fixture = Fixture::new("pi");
    let state = Connection::open(fixture.dir.path().join("mode3.db")).unwrap();
    state
        .execute_batch(
            "CREATE TABLE future_state(runner TEXT,harness TEXT,session TEXT,payload BLOB)",
        )
        .unwrap();
    state
        .execute(
            "INSERT INTO future_state VALUES ('broca','broca',?1,X'01')",
            params![TARGET],
        )
        .unwrap();
    fixture.refuses_unchanged("target_exists:");
}
