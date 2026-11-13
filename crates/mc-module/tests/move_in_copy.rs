//! `ck-mc move-in --copy`: a new runner session starts from a copy of
//! another session's summaries, renumbered to its own entries, while the
//! source keeps every row as it was. The fixture is an OpenCode 1 session
//! the standalone plugin numbered, copied to a Broca session whose import
//! kept a finished compaction summary as an entry, so the two numberings
//! differ from the third message on.

use cortexkit_role_compaction::read::{Cursor, SessionRef};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};
use cortexkit_role_compaction::view::EditOp;
use mc_module::context_db::ContextDb;
use mc_module::move_in::{copy_in, move_in, InjectionProject, MoveRequest, Moved};
use mc_module::move_renumber::HostMessage;
use mc_module::pass::Settings;
use mc_module::route::{Project, Route};
use mc_module::session::Session;
use mc_module::store::{Durable, Store};
use rusqlite::{params, Connection};

const SOURCE: &str = "alf-source";
const TARGET: &str = "probe-copy-1";

struct Fixture {
    dir: tempfile::TempDir,
    conn: Connection,
    store: Store,
    request: MoveRequest,
    source_key: SessionRef,
}

/// The source transcript in host order with Broca's entry for each row.
/// `s2` is a finished compaction summary: the plugin gives it no number,
/// Broca keeps it as entry 3, so plugin number n is entry n + 1 after it.
fn messages() -> Vec<HostMessage> {
    [
        ("u1", 1, false),
        ("a2", 2, false),
        ("s2", 3, true),
        ("u3", 4, false),
        ("a4", 5, false),
        ("u5", 6, false),
        ("a6", 7, false),
    ]
    .into_iter()
    .map(|(mid, entry, finished_summary)| HostMessage {
        mid: mid.into(),
        entry: Some(entry),
        source_entry: None,
        finished_summary,
        added: false,
        pi: None,
    })
    .collect()
}

impl Fixture {
    /// The source's summaries cover plugin numbers 1-2 and 3-4, and with
    /// `full` also 5-6, its newest message.
    fn new(full: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
        let conn = Connection::open(dir.path().join("context.db")).unwrap();
        let store = Store::open(&dir.path().join("mode3.db")).unwrap();
        let mut summaries = vec![(1, 1, 2, "u1", "a2"), (2, 3, 4, "u3", "a4")];
        if full {
            summaries.push((3, 5, 6, "u5", "a6"));
        }
        for (sequence, start, end, start_id, end_id) in summaries {
            conn.execute(
                "INSERT INTO compartments (session_id, harness, sequence, start_message, end_message,
                    start_message_id, end_message_id, title, content, p1, p2, importance, episode_type, created_at)
                 VALUES (?1, 'opencode', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 'shorter', 70, 'feature', 11)",
                params![
                    SOURCE,
                    sequence,
                    start,
                    end,
                    start_id,
                    end_id,
                    format!("Summary {sequence}"),
                    format!("COPIED-HISTORY-{sequence}")
                ],
            )
            .unwrap();
        }
        // Rows of every other kind a move rewrites, so a copy that touched
        // the source in any way would show.
        conn.execute_batch(&format!(
            "INSERT INTO tags(session_id,harness,message_id,type,tag_number) VALUES ('{SOURCE}','opencode','u1','text',42);
             INSERT INTO notes(type,content,session_id,harness,anchor_ordinal,created_at,updated_at) VALUES ('session','note','{SOURCE}','opencode',3,1,1);
             INSERT INTO compression_depth(session_id,harness,message_ordinal,depth) VALUES ('{SOURCE}','opencode',3,1);
             INSERT INTO message_history_source(session_id,harness,message_id,message_ordinal,source_version,normalized_content_hash,role,updated_at) VALUES ('{SOURCE}','opencode','u3',3,'v','hash','user',1);
             INSERT INTO message_history_index(session_id,harness,last_indexed_ordinal,dirty_floor_ordinal,updated_at) VALUES ('{SOURCE}','opencode',6,2,1);
             INSERT INTO memory_publications(publication_id,project_path,source_session_id) VALUES ('publication','/alf','{SOURCE}');
             INSERT INTO memory_fact_blocks(publication_id,source_session_id,start_ordinal,end_ordinal,role,parts_json,joined_text) VALUES ('publication','{SOURCE}',3,4,'user','[]','fact');
             INSERT INTO user_memory_candidates(content,session_id,source_compartment_start,source_compartment_end,created_at) VALUES ('Preference','{SOURCE}',3,4,1);
             INSERT INTO primer_candidates(project_path,harness,session_id,question,normalized_question,source_compartment_start,source_compartment_end,source_start_message_id,source_end_message_id,source_message_time,created_at) VALUES ('/alf','opencode','{SOURCE}','Question','question',3,4,'u3','a4',1,1);"
        ))
        .unwrap();
        let source_key = SessionRef::new("thalamus", "opencode", SOURCE);
        store
            .save(
                &source_key,
                &Durable {
                    version: 9,
                    cut: Some(4),
                    ..Durable::default()
                },
            )
            .unwrap();
        let request = MoveRequest {
            session: SessionRef::new("broca", "broca", TARGET),
            preset: "head".into(),
            project: None,
            model: ModelRef::new("test", "model"),
            context_window: 100_000,
            output_reserve: 1000,
            rules: ProviderRules::new(SignedParts::None, EditCost::Suffix),
            newest: Cursor::new(7, "a6", "digest"),
            now: 5,
            messages: Some(messages()),
            source_harness: Some("opencode".into()),
            source_session: Some(SOURCE.into()),
            source_runner_entries: false,
            tag_floor: Some(7),
            before_newest: None,
            injection_project: None,
        };
        Self {
            dir,
            conn,
            store,
            request,
            source_key,
        }
    }

    fn db(&self) -> ContextDb {
        ContextDb::open(&self.dir.path().join("context.db")).unwrap()
    }

    fn copy(&self) -> Result<Moved, String> {
        copy_in(
            self.db(),
            &self.store,
            &Settings::default().into(),
            &self.request,
        )
    }

    fn real_move(&self) -> Result<Moved, String> {
        move_in(
            self.db(),
            &self.store,
            &Settings::default().into(),
            &self.request,
        )
    }

    fn target_summaries(&self) -> Vec<(String, i64, i64, String, String, String)> {
        self.conn
            .prepare(
                "SELECT harness, start_message, end_message, start_message_id, end_message_id, content
                 FROM compartments WHERE session_id = ?1 ORDER BY sequence",
            )
            .unwrap()
            .query_map([TARGET], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    fn dumps(&self) -> (String, String) {
        (
            dump(&self.conn, None),
            dump(
                &Connection::open(self.dir.path().join("mode3.db")).unwrap(),
                None,
            ),
        )
    }
}

/// Every table's rows, sorted, with the schema. With `leave_out`, rows that
/// name that session (and SQLite's own id counters) are left out, so what
/// remains is everything a copy to that session must not change.
fn dump(conn: &Connection, leave_out: Option<&str>) -> String {
    let mut out = String::new();
    let schema: Vec<(String, Option<String>)> = conn
        .prepare("SELECT name, sql FROM sqlite_master ORDER BY name")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    out.push_str(&format!("{schema:?}\n"));
    for (table, _) in schema {
        let is_table: bool = conn
            .query_row(
                "SELECT type = 'table' FROM sqlite_master WHERE name = ?1",
                [&table],
                |row| row.get(0),
            )
            .unwrap();
        if !is_table || (leave_out.is_some() && table == "sqlite_sequence") {
            continue;
        }
        let mut statement = conn
            .prepare(&format!("SELECT * FROM \"{}\"", table.replace('"', "\"\"")))
            .unwrap();
        let columns = statement.column_count();
        let mut rows: Vec<String> = statement
            .query_map([], |row| {
                Ok(format!(
                    "{:?}",
                    (0..columns)
                        .map(|i| row.get::<_, rusqlite::types::Value>(i))
                        .collect::<Result<Vec<_>, _>>()?
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        if let Some(session) = leave_out {
            rows.retain(|row| !row.contains(session));
        }
        rows.sort();
        out.push_str(&format!("{table}: {rows:?}\n"));
    }
    out
}

fn cut_through(moved: &Moved) -> Option<&str> {
    moved.view.edits.iter().find_map(|edit| match &edit.op {
        EditOp::Cut { through } => Some(through.as_str()),
        _ => None,
    })
}

#[test]
fn a_copy_leaves_every_source_row_as_it_was() {
    let fixture = Fixture::new(true);
    let context_before = dump(&fixture.conn, Some(TARGET));
    let source_before = fixture.store.session_rows(&fixture.source_key).unwrap();
    let moved = fixture.copy().unwrap();
    assert_eq!(dump(&fixture.conn, Some(TARGET)), context_before);
    assert_eq!(
        fixture.store.session_rows(&fixture.source_key).unwrap(),
        source_before
    );
    // The copy is the source's summaries under the target, renumbered as a
    // move renumbers them: entry 3 (the compaction summary) belongs to the
    // first summary, and every later number is one higher.
    assert_eq!(
        fixture.target_summaries(),
        [
            ("broca", 1, 3, "u1", "a2", "COPIED-HISTORY-1"),
            ("broca", 4, 5, "u3", "a4", "COPIED-HISTORY-2"),
            ("broca", 6, 7, "u5", "a6", "COPIED-HISTORY-3"),
        ]
        .map(|(h, s, e, a, b, c)| (h.into(), s, e, a.into(), b.into(), c.into()))
    );
    // Every other column of a summary travels unchanged.
    let carried: (String, Option<String>, i64, Option<String>, i64) = fixture
        .conn
        .query_row(
            "SELECT title, p2, importance, episode_type, created_at FROM compartments
             WHERE session_id = ?1 AND sequence = 2",
            [TARGET],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        carried,
        (
            "Summary 2".into(),
            Some("shorter".into()),
            70,
            Some("feature".into()),
            11
        )
    );
    // Fully summarized, the cut keeps the newest message shown, as a move's.
    assert_eq!(cut_through(&moved), Some("u5"));
    // New tags continue above the source's, which the copied history shows.
    assert_eq!(moved.tag_checkpoint, 42);
    let saved = fixture.store.load(&fixture.request.session).unwrap();
    assert_eq!(saved.cut, Some(6));
    let origin = saved.copy.unwrap();
    assert_eq!(
        (origin.harness.as_str(), origin.session.as_str()),
        ("opencode", SOURCE)
    );
    assert_eq!(origin.injection_project, None);
}

#[test]
fn a_copy_keeps_the_unsummarized_tail_raw_where_a_move_refuses() {
    let fixture = Fixture::new(false);
    // A real move still requires summaries that reach the newest message.
    let mut moving = Fixture::new(false);
    moving.request.session.session = SOURCE.into();
    moving.request.source_session = None;
    let refused = moving.real_move().unwrap_err();
    assert!(refused.starts_with("session_not_summarized:"), "{refused}");

    let moved = fixture.copy().unwrap();
    // The cut goes through the last summarized entry, a4 (entry 5): u5 and
    // a6 stay plain messages.
    assert_eq!(cut_through(&moved), Some("a4"));
    assert_eq!(
        fixture.store.load(&fixture.request.session).unwrap().cut,
        Some(5)
    );
    assert_eq!(fixture.target_summaries().len(), 2);
}

#[test]
fn a_target_that_already_holds_summaries_or_state_is_refused_untouched() {
    let fixture = Fixture::new(true);
    // Summaries are unique by session id whatever their harness.
    fixture
        .conn
        .execute(
            "INSERT INTO compartments (session_id, harness, sequence, start_message, end_message,
                title, content, created_at) VALUES (?1, 'elsewhere', 1, 1, 1, 'Held', 'held', 1)",
            [TARGET],
        )
        .unwrap();
    let before = fixture.dumps();
    let refused = fixture.copy().unwrap_err();
    assert!(refused.starts_with("target_exists:"), "{refused}");
    assert_eq!(fixture.dumps(), before);

    let fixture = Fixture::new(true);
    fixture
        .store
        .save(&fixture.request.session, &Durable::default())
        .unwrap();
    let before = fixture.dumps();
    let refused = fixture.copy().unwrap_err();
    assert!(refused.starts_with("target_exists:"), "{refused}");
    assert_eq!(fixture.dumps(), before);
}

/// Two projects with their own docs and memories: the one the runner stamps
/// on the probe, and the one the probe copies its view from.
fn projects(fixture: &Fixture) -> (Project, Project) {
    let mut made = Vec::new();
    for (id, marker) in [("scratch-project", "SCRATCH"), ("alf-project", "ALF")] {
        let root = fixture.dir.path().join(id);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("ARCHITECTURE.md"),
            format!("# Architecture\n{marker}-DOCS-MARKER\n"),
        )
        .unwrap();
        fixture
            .conn
            .execute(
                "INSERT INTO memories(project_path,category,content,normalized_hash,first_seen_at,created_at,updated_at,last_seen_at)
                 VALUES (?1,'ARCHITECTURE',?2,?3,1,1,1,1)",
                params![id, format!("{marker}-MEMORY-MARKER is a fact"), format!("hash-{id}")],
            )
            .unwrap();
        made.push(Project {
            id: id.into(),
            root: root.to_string_lossy().into_owned(),
        });
    }
    let alf = made.pop().unwrap();
    (made.pop().unwrap(), alf)
}

fn shows(view: &impl serde::Serialize, marker: &str) -> bool {
    serde_json::to_string(view).unwrap().contains(marker)
}

#[test]
fn the_injection_projects_memories_and_docs_replace_the_stamped_projects() {
    // Without an injection project the copy reads the stamped project.
    let mut plain = Fixture::new(true);
    let (scratch, _) = projects(&plain);
    plain.request.project = Some(scratch);
    let moved = plain.copy().unwrap();
    for marker in ["SCRATCH-DOCS-MARKER", "SCRATCH-MEMORY-MARKER"] {
        assert!(shows(&moved.view, marker), "{marker}");
    }

    let mut fixture = Fixture::new(true);
    let (scratch, alf) = projects(&fixture);
    fixture.request.project = Some(scratch.clone());
    fixture.request.injection_project = Some(InjectionProject {
        id: alf.id.clone(),
        folder: alf.root.clone(),
    });
    let moved = fixture.copy().unwrap();
    let check = |view: &cortexkit_role_compaction::view::View| {
        for marker in ["ALF-DOCS-MARKER", "ALF-MEMORY-MARKER", "COPIED-HISTORY-1"] {
            assert!(shows(view, marker), "{marker}");
        }
        for marker in ["SCRATCH-DOCS-MARKER", "SCRATCH-MEMORY-MARKER"] {
            assert!(!shows(view, marker), "{marker}");
        }
    };
    check(&moved.view);
    let saved = fixture.store.load(&fixture.request.session).unwrap();
    assert_eq!(
        saved
            .copy
            .as_ref()
            .and_then(|copy| copy.injection_project.clone()),
        Some(alf)
    );
    // After a restart the runner stamps the scratch project again; the saved
    // state keeps the head on the injection project.
    let setup = SetupRequest::new(
        "head",
        ModelRef::new("test", "model"),
        100_000,
        1000,
        ProviderRules::new(SignedParts::None, EditCost::Suffix),
        Vec::new(),
        6,
    );
    let route = Route {
        session: fixture.request.session.clone(),
        project: Some(scratch.clone()),
        workdir: Some(scratch.root.clone()),
        agent_id: None,
    };
    let mut restarted = Session::new(
        &route,
        &setup,
        mc_module::preset::features("head").unwrap(),
        Some(std::sync::Arc::new(fixture.db())),
    );
    restarted.load_summaries();
    restarted.restore(saved);
    let view = restarted
        .first_view_after_move(&Settings::default(), None)
        .unwrap();
    check(&view);
}

#[test]
fn a_real_move_is_unchanged_and_refuses_an_injection_project() {
    let mut fixture = Fixture::new(true);
    fixture.request.session.session = SOURCE.into();
    fixture.request.source_session = None;
    fixture.request.injection_project = Some(InjectionProject {
        id: "alf-project".into(),
        folder: "/nowhere".into(),
    });
    let before = fixture.dumps();
    let refused = fixture.real_move().unwrap_err();
    assert!(
        refused.starts_with("invalid_request: injection_project"),
        "{refused}"
    );
    assert_eq!(fixture.dumps(), before);

    // Without it the move moves: the source's own rows become the runner
    // session's, renumbered, and its saved state is not a copy's.
    fixture.request.injection_project = None;
    let moved = fixture.real_move().unwrap();
    assert_eq!(cut_through(&moved), Some("u5"));
    let moved_rows: Vec<(String, i64, i64)> = fixture
        .conn
        .prepare("SELECT harness, start_message, end_message FROM compartments WHERE session_id = ?1 ORDER BY sequence")
        .unwrap()
        .query_map([SOURCE], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        moved_rows,
        [("broca", 1, 3), ("broca", 4, 5), ("broca", 6, 7)].map(|(h, s, e)| (h.into(), s, e))
    );
    assert!(fixture
        .store
        .load(&fixture.request.session)
        .unwrap()
        .copy
        .is_none());
}
