use super::*;
use crate::neutral::part;
use cortexkit_role_compaction::part::{Seal, ToolPart, ToolStatus};
use cortexkit_role_compaction::read::{Entry, Head, ReadPage, ReadRequest, Role};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::ModelRef;
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};
use serde_json::json;
use std::sync::Mutex;

#[derive(Default)]
struct Client {
    sends: Mutex<Vec<SendRequest>>,
    fail: Mutex<bool>,
    history: Vec<Entry>,
}

impl RunnerClient for Client {
    async fn send_child(
        &self,
        _: &crate::client::Child,
        _: SendRequest,
    ) -> Result<SendReply, crate::client::ClientError> {
        panic!("unused")
    }
    async fn child_result(
        &self,
        _: &crate::client::Child,
        _: cortexkit_role_llm_runner::run::RunResultRequest,
    ) -> Result<cortexkit_role_llm_runner::run::RunResult, crate::client::ClientError> {
        panic!("unused")
    }
    async fn read(
        &self,
        _: &SessionRef,
        _: ReadRequest,
    ) -> Result<ReadPage, crate::client::ClientError> {
        Ok(ReadPage::new(self.history.clone(), Head::new()))
    }
    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, crate::client::ClientError> {
        panic!("unused")
    }
    async fn applied_view(
        &self,
        _: &SessionRef,
    ) -> Result<AppliedViewAnswer, crate::client::ClientError> {
        panic!("unused")
    }
    async fn send(
        &self,
        _: &SessionRef,
        request: SendRequest,
    ) -> Result<SendReply, crate::client::ClientError> {
        self.sends.lock().unwrap().push(request);
        if std::mem::take(&mut *self.fail.lock().unwrap()) {
            Err(crate::client::ClientError::new("send failed"))
        } else {
            Ok(SendReply::new("pending"))
        }
    }
}

fn session(preset: &str) -> Session {
    let route = Route {
        session: SessionRef::new("test", "mock", "surface"),
        project: None,
        workdir: None,
        agent_id: None,
    };
    let setup = SetupRequest::new(
        preset,
        ModelRef::new("test", "test"),
        400_000,
        1000,
        ProviderRules::new(SignedParts::None, EditCost::Suffix),
        vec![],
        1,
    );
    Session::new(
        &route,
        &setup,
        crate::preset::features(preset).unwrap(),
        None,
    )
}

fn text(number: u64, role: Role, value: &str) -> Entry {
    Entry::new(
        number,
        format!("m{number}"),
        role,
        0,
        vec![part(
            format!("p{number}"),
            Some(number),
            Seal::None,
            PartBody::Text { text: value.into() },
        )],
    )
}

fn tool(number: u64, name: &str) -> Entry {
    Entry::new(
        number,
        format!("m{number}"),
        Role::Assistant,
        0,
        vec![part(
            format!("p{number}"),
            Some(number),
            Seal::None,
            PartBody::Tool(ToolPart::new(
                format!("c{number}"),
                name,
                json!({}),
                ToolStatus::Completed,
            )),
        )],
    )
}

#[tokio::test]
async fn surface_reduce_uses_plugin_reply_cases() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../../packages/plugin/src/tools/ctx-reduce/reply-cases.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let mut session = session("worker");
        let stamped = case["stamped"].as_u64().unwrap();
        let self_stamps = case["self_stamps"].as_u64().unwrap();
        let total = stamped + self_stamps;
        session
            .index
            .extend((1..=stamped).map(|n| text(n, Role::Assistant, "reply")));
        session
            .index
            .extend((stamped + 1..=total).map(|n| tool(n, "ctx_reduce")));
        let reply = session
            .tool(
                &Client::default(),
                &Settings::default(),
                "ctx_reduce",
                &json!({"drop": format!("1-{total}")}),
            )
            .await;
        assert_eq!(
            reply,
            Ok(case["expected"].as_str().unwrap().into()),
            "{}",
            case["label"]
        );
        assert!(!session
            .queued
            .iter()
            .any(|(_, id)| id[1..].parse::<u64>().unwrap() > stamped));
    }
}

#[tokio::test]
async fn surface_reduce_unknowns_are_atomic_and_errors_are_normal_results() {
    let mut session = session("worker");
    session.index.extend([
        text(1, Role::User, "task"),
        text(2, Role::Assistant, "reply"),
    ]);
    let client = Client::default();
    for (input, expected) in [
        (json!({"drop":"2,999"}), "Error: Unknown tag(s) §999§. Check available tags in conversation."),
        (json!({}), "Error: 'drop' must be provided as a string of tag numbers, for example {\"drop\": \"3-5,8\"}."),
        (json!({"drop":"abc"}), "Error: Invalid range syntax. Invalid integer: \"abc\""),
    ] {
        assert_eq!(session.tool(&client, &Settings::default(), "ctx_reduce", &input).await, Ok(expected.into()));
        assert!(session.queued.is_empty());
    }
}

#[tokio::test]
async fn surface_reduce_rejects_compacted_tags_by_name() {
    let mut session = session("head");
    session.cut = Some(2);
    session.index = Index::starting_at(3);
    let client = Client {
        history: vec![text(1, Role::User, "old")],
        ..Client::default()
    };
    assert_eq!(
        session
            .tool(
                &client,
                &Settings::default(),
                "ctx_reduce",
                &json!({"drop":"1"})
            )
            .await,
        Ok("Error: Conflicting operations — §1§ is from before compaction.".into())
    );
}

#[tokio::test]
async fn surface_reminder_ids_survive_saved_state_and_setup_notice_resets() {
    let (dir, _) = database();
    let store = Arc::new(crate::store::Store::open(&dir.join("store.db")).unwrap());
    let client = Client::default();
    let settings = Settings::default();
    let mut first = session("worker");
    first.set_store(Some(store.clone()));
    first.index.extend([
        text(1, Role::User, "task"),
        text(2, Role::Assistant, &"x".repeat(300_000)),
    ]);
    first.seq = 3;
    first.remind(&client, &settings, false, false).await;
    first.nudges = Default::default();
    first.seq = 3;
    first.remind(&client, &settings, false, false).await;
    let saved = serde_json::to_string(&store.load(&first.key).unwrap()).unwrap();
    let mut restarted = session("worker");
    restarted.restore(serde_json::from_str(&saved).unwrap());
    restarted.index.extend([
        text(1, Role::User, "task"),
        text(2, Role::Assistant, &"x".repeat(300_000)),
    ]);
    restarted.nudges = Default::default();
    restarted.seq = 3;
    restarted.remind(&client, &settings, false, false).await;
    let sends = client.sends.lock().unwrap();
    let ids: BTreeSet<_> = sends.iter().map(|send| send.send_id.clone()).collect();
    assert_eq!(sends.len(), 3);
    assert_eq!(ids.len(), 3, "send ids must never repeat");
    assert!(ids.iter().all(|id| id.contains(":counter:")));
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn surface_failed_ceiling_send_is_retried_in_the_same_cycle() {
    let client = Client {
        fail: Mutex::new(true),
        ..Client::default()
    };
    let mut session = session("worker");
    session.index.extend([
        text(1, Role::User, "task"),
        text(2, Role::Assistant, &"x".repeat(300_000)),
    ]);
    session
        .remind(&client, &Settings::default(), false, false)
        .await;
    session
        .remind(&client, &Settings::default(), false, false)
        .await;
    assert_eq!(client.sends.lock().unwrap().len(), 2);
}

#[test]
fn surface_keep_request_is_wrapped_as_a_system_reminder() {
    let templates = crate::nudges::templates();
    let keep = templates
        .iter()
        .find(|template| template.id == crate::nudges::KEEP_TEMPLATE)
        .unwrap();
    assert!(keep.text.starts_with("<system-reminder>\n"));
    assert!(keep.text.ends_with("\n</system-reminder>"));
}

#[test]
fn surface_injection_cleanup_keeps_runner_marked_notices() {
    let mut session = session("worker");
    let mut notice = text(
        2,
        Role::User,
        "<system-reminder>Call ctx_keep now.</system-reminder>",
    );
    notice.notice = Some(cortexkit_role_compaction::read::NoticeOrigin::new(
        "magic-context",
    ));
    session.index.extend([text(1, Role::User, "task"), notice]);
    let edited = lanes::Edited::default();
    let protected_tools = Default::default();
    let context = lanes::Context {
        index: &session.index,
        edited: &edited,
        protected_tools: &protected_tools,
        keep_first_message: true,
    };
    assert!(lanes::injected_text(&context, None).is_empty());
}

#[test]
fn surface_reclaimable_tokens_exclude_text_in_the_protected_tail() {
    let mut session = session("worker");
    session.index.extend([
        text(1, Role::User, "task"),
        tool(2, "read"),
        text(3, Role::Assistant, &"x".repeat(40_000)),
    ]);
    let edited = lanes::Edited::default();
    let protected_tools = Default::default();
    let context = lanes::Context {
        index: &session.index,
        edited: &edited,
        protected_tools: &protected_tools,
        keep_first_message: true,
    };
    let cutoff = lanes::protected_cutoff(&context, 1);
    assert_eq!(cutoff, Some(2));
    assert_eq!(
        crate::nudges::measure(&context, cutoff, &BTreeSet::new()).u,
        0
    );
}

#[test]
fn surface_keep_retains_later_person_instructions() {
    let mut session = session("worker");
    session.index.extend([
        text(1, Role::User, "task"),
        text(2, Role::Assistant, "old"),
        text(3, Role::User, "Also update the changelog"),
        tool(4, "ctx_keep"),
    ]);
    let edited = lanes::Edited::default();
    let protected_tools = Default::default();
    let context = lanes::Context {
        index: &session.index,
        edited: &edited,
        protected_tools: &protected_tools,
        keep_first_message: true,
    };
    let drops = lanes::keep_drops(&context, &BTreeSet::new(), None);
    assert!(drops.iter().any(|(key, _)| key.0 == "m2"));
    assert!(!drops.iter().any(|(key, _)| key.0 == "m3"));
}

fn database() -> (std::path::PathBuf, Arc<ContextDb>) {
    let path = std::env::temp_dir().join(format!(
        "mc-surface-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&path).unwrap();
    ContextDb::create_for_tests(&path.join("context.db")).unwrap();
    let db = Arc::new(ContextDb::open(&path.join("context.db")).unwrap());
    (path, db)
}

#[tokio::test]
async fn surface_search_without_a_project_still_finds_session_notes_and_messages() {
    let (dir, db) = database();
    let mut session = session("worker");
    session.db = Some(db.clone());
    db.with_connection(|conn| {
        crate::search::messages::index(
            conn,
            "mock",
            "surface",
            &[text(1, Role::Assistant, "zebra parser")],
        )
    })
    .unwrap();
    db.add_session_note(
        &crate::context_db::NoteScope {
            harness: "mock".into(),
            session: "surface".into(),
            project: None,
        },
        "zebra fixture",
        None,
        1,
    )
    .unwrap();
    let client = Client::default();
    let note = session
        .tool(
            &client,
            &Settings::default(),
            "ctx_search",
            &json!({"query":"zebra", "sources":["message","note"]}),
        )
        .await;
    assert!(
        note.as_ref()
            .is_ok_and(|answer| answer.contains("[message]") && answer.contains("[note]")),
        "{note:?}"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn surface_search_returns_fully_dropped_messages_but_not_partially_visible_ones() {
    let (dir, db) = database();
    let mut session = session("worker");
    session.project = Some(Project {
        id: "p".into(),
        root: dir.to_string_lossy().into(),
    });
    session.db = Some(db.clone());
    session.index.extend([
        text(1, Role::User, "task"),
        text(2, Role::Assistant, "zebra parser"),
        {
            let mut entry = text(3, Role::Assistant, "zebra parser");
            entry.parts.push(part(
                "p30",
                Some(30),
                Seal::None,
                PartBody::Text {
                    text: "Still visible".into(),
                },
            ));
            entry
        },
    ]);
    db.with_connection(|conn| {
        crate::search::messages::index(conn, "mock", "surface", session.index.entries())
    })
    .unwrap();
    let view = View::seal(
        1,
        vec![
            cortexkit_role_compaction::view::Edit::new(
                1,
                EditOp::Drop {
                    mid: "m2".into(),
                    part: Some("p2".into()),
                },
            ),
            cortexkit_role_compaction::view::Edit::new(
                1,
                EditOp::Drop {
                    mid: "m3".into(),
                    part: Some("p3".into()),
                },
            ),
        ],
    );
    session.latest = Some(view);
    let result = session
        .tool(
            &Client::default(),
            &Settings::default(),
            "ctx_search",
            &json!({"query":"zebra", "sources":["message"]}),
        )
        .await
        .unwrap();
    assert!(result.contains("ordinal=2"), "{result}");
    assert!(!result.contains("ordinal=3"), "{result}");
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn surface_hint_deadline_includes_waiting_for_the_database() {
    let (dir, db) = database();
    let mut session = session("head");
    session.project = Some(Project {
        id: "p".into(),
        root: dir.to_string_lossy().into(),
    });
    session.db = Some(db.clone());
    db.with_connection(|conn| conn.execute("INSERT INTO git_commits (sha, project_path, short_sha, message, author, committed_at, indexed_at) VALUES ('aaaaaaa', 'p', 'aaaaaaa', 'Fix zebra parser crash on empty input', 'a', 1, 1)", [])).unwrap();
    let (ready, held) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        db.with_connection(|_| {
            ready.send(()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(1300));
        })
    });
    held.recv().unwrap();
    let settings = Settings {
        git_commits_enabled: true,
        ..Settings::default()
    };
    let start = std::time::Instant::now();
    let answer = session
        .pre_user(&settings, "Fix zebra parser crash on empty input", 1000)
        .await;
    let elapsed = start.elapsed();
    handle.join().unwrap();
    assert_eq!(answer.append, None, "{answer:?}; took {elapsed:?}");
    assert!(
        elapsed < std::time::Duration::from_millis(1200),
        "{elapsed:?}"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn surface_verbose_expand_does_not_call_the_end_of_history_truncation() {
    let client = Client {
        history: vec![text(1, Role::User, "task")],
        ..Client::default()
    };
    let answer = crate::expand::run(
        &client,
        &session("head").key,
        &json!({"start":1,"end":10,"verbose":true}),
        None,
        crate::count::Counter::for_model(None),
    )
    .await
    .unwrap();
    assert!(!answer.contains("Truncated"), "{answer}");
}

#[test]
fn surface_search_does_not_promise_an_expand_archive_fallback() {
    let (dir, db) = database();
    let mut session = session("head");
    session.project = Some(Project {
        id: "p".into(),
        root: dir.to_string_lossy().into(),
    });
    db.with_connection(|conn| {
        crate::search::messages::index(
            conn,
            "mock",
            "surface",
            &[text(1, Role::Assistant, "zebra parser")],
        )
    })
    .unwrap();
    let empty = Default::default();
    let mut scope = session.search_scope(&Settings::default(), &empty);
    scope.cutoff = i64::MAX;
    let answer = db
        .with_connection(|conn| {
            crate::search::run(
                conn,
                &scope,
                &json!({"query":"zebra", "sources":["message"]}),
            )
        })
        .unwrap();
    assert!(answer.contains("ordinal=1"), "{answer}");
    assert!(
        !answer.contains("returns indexed text from the search archive"),
        "{answer}"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn surface_session_note_updates_refuse_conditions_without_changing_content() {
    let (dir, db) = database();
    let scope = crate::context_db::NoteScope {
        harness: "mock".into(),
        session: "surface".into(),
        project: None,
    };
    let id = db.add_session_note(&scope, "original", None, 0).unwrap();
    let answer = crate::notes::run(
        &db,
        &scope,
        &json!({"action":"update", "note_ids":[id], "content":"changed", "surface_condition":"when ready"}),
        None,
        1,
    );
    assert_eq!(answer, Ok("Error: Only a note created with a condition can have one. Write a new note with surface_condition, and dismiss this one.".into()));
    assert_eq!(
        db.note_in_scope(id, &scope).unwrap().unwrap().content,
        "original"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn surface_note_batch_dismiss_is_atomic() {
    let (dir, db) = database();
    let scope = crate::context_db::NoteScope {
        harness: "mock".into(),
        session: "surface".into(),
        project: None,
    };
    let one = db.add_session_note(&scope, "one", None, 0).unwrap();
    let two = db.add_session_note(&scope, "two", None, 0).unwrap();
    db.with_connection(|conn| conn.execute_batch(&format!("CREATE TRIGGER fail_dismiss BEFORE UPDATE OF status ON notes WHEN NEW.id = {two} BEGIN SELECT RAISE(ABORT, 'test failure'); END;"))).unwrap();
    assert!(crate::notes::run(
        &db,
        &scope,
        &json!({"action":"dismiss", "note_ids":[one,two]}),
        None,
        1
    )
    .is_err());
    assert_eq!(
        db.note_in_scope(one, &scope).unwrap().unwrap().status,
        "active"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn surface_unknown_note_actions_and_filters_fall_back_to_read() {
    let (dir, db) = database();
    let scope = crate::context_db::NoteScope {
        harness: "mock".into(),
        session: "surface".into(),
        project: None,
    };
    db.add_session_note(&scope, "one", None, 0).unwrap();
    let read = crate::notes::run(&db, &scope, &json!({"action":"read"}), None, 1);
    assert_eq!(
        crate::notes::run(&db, &scope, &json!({"action":"other"}), None, 1),
        read
    );
    assert_eq!(
        crate::notes::run(
            &db,
            &scope,
            &json!({"action":"read", "filter":"other"}),
            None,
            1
        ),
        read
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn surface_memory_accepts_legacy_categories_at_runtime() {
    let (dir, db) = database();
    let who = crate::memory_writes::Writer {
        harness: "mock",
        session: "surface",
        project: "p",
        authority: None,
    };
    for category in [
        "ARCHITECTURE_DECISIONS",
        "CONFIG_DEFAULTS",
        "USER_PREFERENCES",
        "USER_DIRECTIVES",
        "ENVIRONMENT",
        "WORKFLOW_RULES",
        "KNOWN_ISSUES",
    ] {
        let answer = db.with_connection(|conn| crate::memory_tool::run(conn, &who, &json!({"action":"write", "category":category, "content":format!("Remember {category}")})));
        assert!(
            answer
                .as_ref()
                .is_ok_and(|text| text.starts_with("Saved memory")),
            "{answer:?}"
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}
