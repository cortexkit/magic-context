//! Summary boundaries must remain readable after the runner drops host rows.

use std::sync::{Arc, Mutex};

use cortexkit_role_compaction::read::{
    Cursor, Entry, Head, ReadPage, ReadRequest, Role, Select, SessionRef,
};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};
use cortexkit_role_compaction::view::{
    AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest, EditOp,
};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};
use mc_module::client::{Child, ClientError, RunnerClient};
use mc_module::context_db::ContextDb;
use mc_module::move_in::{move_in, MoveRequest, Moved};
use mc_module::move_renumber::HostMessage;
use mc_module::pass::Settings;
use mc_module::route::Route;
use mc_module::session::Session;
use mc_module::store::Store;
use rusqlite::{params, Connection};

struct Fixture {
    dir: tempfile::TempDir,
    conn: Connection,
    store: Store,
    request: MoveRequest,
}

impl Fixture {
    fn new(rows: &[(&str, Option<u64>)], ranges: &[(i64, i64)]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
        let conn = Connection::open(dir.path().join("context.db")).unwrap();
        for (seq, &(start, end)) in ranges.iter().enumerate() {
            conn.execute(
                "INSERT INTO compartments (session_id, sequence, start_message, end_message,
                    start_message_id, end_message_id, title, content, p1, created_at, harness)
                 VALUES ('s1', ?1, ?2, ?3, ?4, ?5, 'history', 'history', 'history', 1, 'opencode')",
                params![
                    seq as i64,
                    start,
                    end,
                    rows[start as usize - 1].0,
                    rows[end as usize - 1].0
                ],
            )
            .unwrap();
        }
        let &(mid, entry) = rows
            .iter()
            .rev()
            .find(|(_, entry)| entry.is_some())
            .unwrap();
        let request = MoveRequest {
            session: SessionRef::new("mock-runner", "opencode2", "s1"),
            preset: "head".into(),
            project: None,
            model: ModelRef::new("test", "model"),
            context_window: 100_000,
            output_reserve: 1000,
            rules: ProviderRules::new(SignedParts::None, EditCost::Suffix),
            newest: Cursor::new(entry.unwrap(), mid, "d"),
            now: 1,
            messages: Some(
                rows.iter()
                    .map(|&(mid, entry)| HostMessage {
                        source_entry: None,
                        mid: mid.into(),
                        entry,
                        finished_summary: false,
                        added: false,
                        pi: None,
                    })
                    .collect(),
            ),
            source_harness: Some("opencode".into()),
            source_session: None,
            source_runner_entries: false,
            tag_floor: None,
            before_newest: None,
        };
        let store = Store::open(&dir.path().join("mode3.db")).unwrap();
        Self {
            dir,
            conn,
            store,
            request,
        }
    }

    fn db(&self) -> ContextDb {
        ContextDb::open(&self.dir.path().join("context.db")).unwrap()
    }

    fn run(&self) -> Result<Moved, String> {
        move_in(
            self.db(),
            &self.store,
            &Settings::default().into(),
            &self.request,
        )
    }

    fn strings(&self, sql: &str) -> Vec<String> {
        self.conn
            .prepare(sql)
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    fn boundaries(&self) -> Vec<String> {
        self.strings("SELECT start_message || ':' || start_message_id || '-' || end_message || ':' || end_message_id FROM compartments ORDER BY sequence")
    }

    fn session(&self) -> (Session, Route, SetupRequest) {
        let r = &self.request;
        let setup = SetupRequest::new(
            r.preset.clone(),
            r.model.clone(),
            r.context_window,
            r.output_reserve,
            r.rules.clone(),
            vec![],
            r.now,
        )
        .with_newest(r.newest.clone());
        let route = Route {
            session: r.session.clone(),
            project: None,
            workdir: None,
            agent_id: None,
        };
        let mut session = Session::new(
            &route,
            &setup,
            mc_module::preset::features("head").unwrap(),
            Some(Arc::new(self.db())),
        );
        session.load_summaries();
        (session, route, setup)
    }

    fn references(&self, start: i64, end: i64) {
        self.conn.execute_batch("INSERT INTO memory_publications(publication_id, project_path, source_session_id) VALUES ('pub', '/fixture', 's1');").unwrap();
        self.conn.execute("INSERT INTO memory_fact_blocks(publication_id, source_session_id, start_ordinal, end_ordinal, role, parts_json, joined_text) VALUES ('pub', 's1', ?1, ?2, 'user', '[]', 'fact')", params![start, end]).unwrap();
        self.conn.execute("INSERT INTO compartment_chunk_embeddings(compartment_id, session_id, project_path, start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at, harness) SELECT id, session_id, '/fixture', ?1, ?2, 'hash', 'model', 1, zeroblob(4), 1, harness FROM compartments ORDER BY sequence DESC LIMIT 1", params![start, end]).unwrap();
    }

    fn assert_reference_range(&self, expected: &str) {
        for table in ["memory_fact_blocks", "compartment_chunk_embeddings"] {
            assert_eq!(
                self.strings(&format!(
                    "SELECT start_ordinal || '-' || end_ordinal FROM {table}"
                )),
                [expected],
                "{table}"
            );
        }
    }
}

fn tail() -> Vec<(&'static str, Option<u64>)> {
    vec![
        ("u1", Some(1)),
        ("a2", Some(2)),
        ("u3", Some(3)),
        ("u4", Some(4)),
        ("empty5", None),
        ("empty6", None),
    ]
}

struct MockRunner {
    entries: Vec<Entry>,
    reads: Mutex<Vec<ReadRequest>>,
    applied: AppliedViewAnswer,
}

impl RunnerClient for MockRunner {
    async fn read(&self, _: &SessionRef, request: ReadRequest) -> Result<ReadPage, ClientError> {
        self.reads.lock().unwrap().push(request.clone());
        let entries = self
            .entries
            .iter()
            .filter(|entry| match &request.select {
                Select::Mids { mids } => mids.contains(&entry.mid),
                Select::After { after_ordinal, .. } => entry.ordinal > after_ordinal.unwrap_or(0),
                _ => false,
            })
            .cloned()
            .collect();
        let mut head = Head::new();
        head.applied_view = self.applied.view.as_ref().map(|view| view.applied());
        head.newest = self
            .entries
            .last()
            .map(|e| Cursor::new(e.ordinal, &e.mid, &e.digest));
        Ok(ReadPage::new(entries, head))
    }

    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        Ok(self.applied.clone())
    }

    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        Ok(ApplyViewAnswer::Accepted)
    }

    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        Err(ClientError::new("unexpected send"))
    }

    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        Err(ClientError::new("unexpected child"))
    }

    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        Err(ClientError::new("unexpected child result"))
    }
}

#[tokio::test]
async fn trailing_left_out_summary_end_snaps_and_survives_setup() {
    let f = Fixture::new(&tail(), &[(1, 2), (3, 6)]);
    f.references(3, 6);
    let moved = f.run().unwrap();
    assert_eq!(f.boundaries(), ["1:u1-2:a2", "3:u3-4:u4"]);
    f.assert_reference_range("3-4");
    let cut = f.store.load(&f.request.session).unwrap().cut.unwrap();
    assert!(cut <= 4, "first view cut {cut} exceeds summary coverage");
    assert!(moved
        .view
        .edits
        .iter()
        .any(|e| matches!(&e.op, EditOp::Cut { through } if through == "u3")));

    let (mut session, route, mut setup) = f.session();
    session.restore(f.store.load(&f.request.session).unwrap());
    setup.applied_view = Some(moved.view.applied());
    let runner = MockRunner {
        entries: tail()
            .iter()
            .filter_map(|&(mid, entry)| entry.map(|n| Entry::new(n, mid, Role::User, n, vec![])))
            .collect(),
        reads: Mutex::new(vec![]),
        applied: {
            let mut answer = AppliedViewAnswer::new();
            answer.view = Some(moved.view.clone());
            answer
        },
    };
    setup.newest = runner
        .entries
        .last()
        .map(|e| Cursor::new(e.ordinal, &e.mid, &e.digest));
    session
        .setup(
            &runner,
            &Settings::default(),
            &route,
            &setup,
            mc_module::preset::features("head").unwrap(),
        )
        .await;
    assert!(runner
        .reads
        .lock()
        .unwrap()
        .iter()
        .any(|r| matches!(&r.select, Select::Mids { mids } if mids == &["u4"])));
    assert_eq!(
        f.boundaries(),
        ["1:u1-2:a2", "3:u3-4:u4"],
        "Setup discarded a summary"
    );
    assert_eq!(session.last_summary_ordinal(), Some(4));
    assert_eq!(session.durable().cut, Some(cut));
}

#[test]
fn left_out_summary_start_snaps_forward_with_cited_ranges() {
    let rows = [
        ("u1", Some(1)),
        ("a2", Some(2)),
        ("empty3", None),
        ("u4", Some(3)),
        ("a5", Some(4)),
    ];
    let f = Fixture::new(&rows, &[(1, 2), (3, 5)]);
    f.references(3, 5);
    f.run().unwrap();
    assert_eq!(f.boundaries(), ["1:u1-2:a2", "3:u4-4:a5"]);
    f.assert_reference_range("3-4");
}

#[test]
fn left_out_summary_end_in_the_middle_snaps_backward() {
    let rows = [
        ("u1", Some(1)),
        ("a2", Some(2)),
        ("empty3", None),
        ("u4", Some(3)),
        ("a5", Some(4)),
    ];
    let f = Fixture::new(&rows, &[(1, 3), (4, 5)]);
    f.run().unwrap();
    assert_eq!(f.boundaries(), ["1:u1-2:a2", "3:u4-4:a5"]);
}

fn snapshot(conn: &Connection) -> Vec<(String, Vec<String>)> {
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    tables
        .into_iter()
        .map(|table| {
            let mut stmt = conn
                .prepare(&format!("SELECT * FROM \"{}\"", table.replace('"', "\"\"")))
                .unwrap();
            let cols = stmt.column_count();
            let mut rows: Vec<String> = stmt
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
            (table, rows)
        })
        .collect()
}

#[test]
fn summary_covering_only_left_out_rows_refuses_without_changing_either_store() {
    let f = Fixture::new(&tail(), &[(1, 4), (5, 6)]);
    f.references(5, 6);
    let mode3 = Connection::open(f.dir.path().join("mode3.db")).unwrap();
    let before_context = snapshot(&f.conn);
    let before_mode3 = snapshot(&mode3);
    let error = f.run().unwrap_err();
    assert!(
        error.starts_with("summary_covers_no_runner_entry:"),
        "{error}"
    );
    assert!(error.contains("summary 1 of s1"), "{error}");
    assert_eq!(snapshot(&f.conn), before_context);
    assert_eq!(snapshot(&mode3), before_mode3);
}

#[test]
fn first_move_view_cut_stops_at_summary_coverage() {
    let mut f = Fixture::new(&tail(), &[(1, 2)]);
    f.request.session.harness = "opencode".into();
    let (mut session, _, _) = f.session();
    let view = session
        .first_view_after_move(&Settings::default(), Some((3, "u3")))
        .unwrap();
    assert_eq!(session.durable().cut, Some(2));
    assert!(view
        .edits
        .iter()
        .any(|e| matches!(&e.op, EditOp::Cut { through } if through == "a2")));
}

#[test]
fn saved_renumber_plan_with_left_out_endpoint_refuses_without_writes() {
    for (state, harness) in [
        ("done", "opencode"),
        ("applying", "opencode"),
        ("done", "opencode2"),
    ] {
        let mut f = Fixture::new(&tail(), &[(1, 2), (3, 6)]);
        let numbering = mc_module::move_renumber::Numbering::opencode(
            f.request.messages.as_ref().unwrap(),
            &f.request.newest,
        )
        .unwrap();
        mc_module::move_renumber::renumber(&mut f.conn, "opencode", "s1", &numbering).unwrap();
        // Older plans converted the ordinal but retained the omitted row's id.
        f.conn
            .execute_batch("UPDATE compartments SET end_message_id='empty6' WHERE sequence=1;")
            .unwrap();
        f.conn.execute("UPDATE schema_migrations_meta SET value=json_set(json_remove(value, '$.summary_endpoints'), '$.state', ?1) WHERE key='mode3_renumber:opencode:s1'", params![state]).unwrap();
        f.conn
            .execute("UPDATE compartments SET harness=?1", params![harness])
            .unwrap();
        let mode3 = Connection::open(f.dir.path().join("mode3.db")).unwrap();
        let before_context = snapshot(&f.conn);
        let before_mode3 = snapshot(&mode3);
        let error = f.run().unwrap_err();
        assert!(
            error.starts_with("renumber_plan_has_left_out_endpoint:"),
            "{state}: {error}"
        );
        assert_eq!(snapshot(&f.conn), before_context, "{state}");
        assert_eq!(snapshot(&mode3), before_mode3, "{state}");
    }
}

#[test]
fn saved_plan_checks_only_the_moving_harnesses() {
    let mut f = Fixture::new(&tail(), &[(1, 2), (3, 6)]);
    let numbering = mc_module::move_renumber::Numbering::opencode(
        f.request.messages.as_ref().unwrap(),
        &f.request.newest,
    )
    .unwrap();
    mc_module::move_renumber::renumber(&mut f.conn, "opencode", "s1", &numbering).unwrap();
    f.conn.execute_batch("INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, created_at, harness) VALUES ('s1', 100, 1, 2, 'foreign-user', 'foreign-assistant', 'foreign', 'foreign', 'foreign', 1, 'other-host');").unwrap();
    f.run().unwrap();
    assert_eq!(f.strings("SELECT start_message_id || ':' || end_message_id FROM compartments WHERE harness='other-host'"), ["foreign-user:foreign-assistant"]);
}
