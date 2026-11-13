use super::*;

fn saved(dir: &std::path::Path) -> Value {
    let text: String = rusqlite::Connection::open(dir.join("mode3.db"))
        .unwrap()
        .query_row(
            "SELECT state FROM sessions WHERE session = 's1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_str(&text).unwrap()
}

#[tokio::test]
async fn lifecycle_a_tool_before_setup_restores_compaction_but_not_notice_readiness() {
    let dir = scratch("tool-before-setup");
    let mut runner = start_full(
        config("worker", Kind::OpenAi, free()),
        Settings::default(),
        Some(dir.clone()),
    )
    .await;
    runner
        .play(&[
            user("Review the module."),
            read_file(50),
            read_file(50),
            reduce("3"),
        ])
        .await;
    runner.provider().restart();
    let route = &runner.provider().route;
    runner
        .provider()
        .module()
        .tool(route, "ctx_reduce", json!({"drop":"5"}))
        .await
        .expect("the restored session still compacts");
    runner
        .provider()
        .module()
        .idle(&route.session)
        .await
        .unwrap();
    let state = saved(&dir);
    assert_eq!(state["queued"].as_array().unwrap().len(), 2);
    let conditions = cortexkit_role_compaction::notice::Conditions::new(
        ModelRef::new("test", "test-model"),
        40_000,
        1000,
        free(),
    );
    assert_eq!(
        runner
            .provider()
            .module()
            .notice(&route.session, NoticeRequest::new(1, conditions)),
        Ok(NoticeAnswer::SetupRequired)
    );
    runner
        .play(&[read_file(50), read_file(50), answer(), answer()])
        .await;
    assert_clean(&runner);
    assert_eq!(
        seen(runner.host(), 3).as_deref(),
        Some(placeholder(3).as_str())
    );
    assert_eq!(
        seen(runner.host(), 5).as_deref(),
        Some(placeholder(5).as_str())
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn lifecycle_a_tools_only_worker_still_requires_setup_for_notices() {
    let module = Module::new(HostClient::default(), Settings::default(), None, None);
    let route = Route {
        session: SessionRef::new("mock-runner", "mock", "tools"),
        project: None,
        workdir: None,
        agent_id: None,
    };
    assert!(module
        .tool(&route, "ctx_reduce", json!({"drop":"1"}))
        .await
        .is_err());
    let conditions = cortexkit_role_compaction::notice::Conditions::new(
        ModelRef::new("test", "test-model"),
        40_000,
        1000,
        free(),
    );
    assert_eq!(
        module.notice(&route.session, NoticeRequest::new(1, conditions)),
        Ok(NoticeAnswer::SetupRequired)
    );
}

#[tokio::test]
async fn lifecycle_a_keep_called_before_restart_lands_on_the_next_notice() {
    let dir = scratch("pending-keep");
    let settings = Settings {
        protected_tokens: Some(0),
        ..Settings::default()
    };
    let mut runner = start_full(
        config("worker", Kind::OpenAi, free()),
        settings,
        Some(dir.clone()),
    )
    .await;
    runner
        .play(&[
            user("Review the module."),
            long_reply(1000),
            long_reply(1000),
            long_reply(1000),
        ])
        .await;
    *runner.provider().restart_after_keep.lock().unwrap() = true;
    runner
        .play(&[
            step(
                "Keeping the useful reply.",
                vec![ToolCall::ok(
                    "ctx_keep",
                    json!({"tags":"3", "note":"Keep the task and useful reply."}),
                    "",
                )],
            ),
            answer(),
            answer(),
        ])
        .await;
    assert_clean(&runner);
    assert_eq!(
        seen(runner.host(), 2).as_deref(),
        Some(placeholder(2).as_str())
    );
    assert_ne!(
        seen(runner.host(), 3).as_deref(),
        Some(placeholder(3).as_str())
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn lifecycle_an_unchanged_job_retries_a_failed_state_save() {
    let dir = scratch("retry-save");
    let mut runner = start_full(
        config("worker", Kind::OpenAi, free()),
        Settings::default(),
        Some(dir.clone()),
    )
    .await;
    runner
        .play(&[user("Review the module."), read_file(50), read_file(50)])
        .await;
    let conn = rusqlite::Connection::open(dir.join("mode3.db")).unwrap();
    conn.execute_batch("CREATE TRIGGER fail_save BEFORE UPDATE ON sessions BEGIN SELECT RAISE(FAIL, 'save unavailable'); END;").unwrap();
    runner
        .provider()
        .module()
        .tool(&runner.provider().route, "ctx_reduce", json!({"drop":"3"}))
        .await
        .unwrap();
    runner
        .provider()
        .module()
        .idle(&runner.provider().route.session)
        .await
        .unwrap();
    assert!(saved(&dir)["queued"].as_array().unwrap().is_empty());
    conn.execute_batch("DROP TRIGGER fail_save").unwrap();
    // No compaction decision changes: even an idle job must retry the write.
    runner
        .provider()
        .module()
        .idle(&runner.provider().route.session)
        .await
        .unwrap();
    assert_eq!(saved(&dir)["queued"].as_array().unwrap().len(), 1);
    std::fs::remove_dir_all(dir).unwrap();
}

fn move_request(dir: &std::path::Path) -> mc_module::move_in::MoveRequest {
    mc_module::move_in::MoveRequest {
        session: SessionRef::new("mock-runner", "mock", "s1"),
        preset: "head".into(),
        project: Some(RouteProject {
            id: "pj-test".into(),
            root: dir.to_string_lossy().into_owned(),
        }),
        model: ModelRef::new("test", "model"),
        context_window: 100_000,
        output_reserve: 1000,
        rules: free(),
        newest: cortexkit_role_compaction::read::Cursor::new(2, "m2", "d"),
        now: 1,
        messages: None,
        source_harness: None,
        source_session: None,
        source_runner_entries: false,
        tag_floor: None,
        before_newest: Some("m1".into()),
    }
}

fn fenced(dir: &std::path::Path) -> u64 {
    rusqlite::Connection::open(dir.join("context.db"))
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations_meta WHERE key = 'mode3_move:mock:s1'",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn lifecycle_move_never_fences_a_failed_state_save() {
    let dir = scratch("move-save-failed");
    let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    insert_summary(&dir, "s1", 1, (1, "m1"), (2, "m2"), "History");
    let store = Store::open(&dir.join("mode3.db")).unwrap();
    rusqlite::Connection::open(dir.join("mode3.db"))
        .unwrap()
        .execute("DROP TABLE sessions", [])
        .unwrap();
    let result =
        mc_module::move_in::move_in(db, &store, &Settings::default().into(), &move_request(&dir));
    assert!(
        result
            .as_ref()
            .is_err_and(|error| error.starts_with("state_save_failed:")),
        "{result:?}"
    );
    assert_eq!(fenced(&dir), 0);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn lifecycle_move_refuses_unrenderable_memories_and_profile_without_writes() {
    // Project memories become unreadable when their table is gone; the user
    // profile (the global rows of the same table) when a row's metadata isn't
    // JSON, which only the profile query reads.
    for (case, fault) in [
        ("memories", "ALTER TABLE memories RENAME TO unavailable"),
        (
            "profile",
            "INSERT INTO memories(level, owner_id, category, origin_category, content,
                 normalized_hash, first_seen_at, created_at, updated_at, last_seen_at, status,
                 metadata_json)
             VALUES ('global', 'self', 'mc:user-unsorted', 'USER_MEMORY', 'Unreadable',
                 'h-unreadable', 1, 1, 1, 1, 'active', 'not json')",
        ),
    ] {
        let table = case;
        let dir = scratch(&format!("move-head-{case}"));
        let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
        insert_summary(&dir, "s1", 1, (1, "m1"), (2, "m2"), "History");
        db.with_connection(|conn| conn.execute_batch(fault))
            .unwrap();
        let store = Store::open(&dir.join("mode3.db")).unwrap();
        let result = mc_module::move_in::move_in(
            db,
            &store,
            &Settings::default().into(),
            &move_request(&dir),
        );
        assert!(
            result
                .as_ref()
                .is_err_and(|error| error.starts_with("history_head_unavailable:")),
            "{table}: {result:?}"
        );
        assert!(store.load(&move_request(&dir).session).is_none());
        assert_eq!(fenced(&dir), 0);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn lifecycle_move_refuses_incompatible_message_ordinals() {
    let dir = scratch("move-ordinals");
    let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    insert_summary(&dir, "s1", 1, (1, "m1"), (2, "m2"), "History");
    let store = Store::open(&dir.join("mode3.db")).unwrap();
    let mut request = move_request(&dir);
    request.newest.ordinal = 4;
    let result = mc_module::move_in::move_in(db, &store, &Settings::default().into(), &request);
    assert!(
        result
            .as_ref()
            .is_err_and(|error| error.starts_with("session_not_summarized:")),
        "{result:?}"
    );
    assert_eq!(fenced(&dir), 0);
    assert!(store.load(&request.session).is_none());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn lifecycle_move_converts_the_plugins_numbers_across_a_compaction() {
    use mc_module::move_renumber::HostMessage;
    let dir = scratch("move-renumber");
    let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    // The OpenCode 1 plugin numbered the message opening a compaction (row 3)
    // and left out its finished summary (row 4). The runner leaves out both,
    // so the plugin's 4 and 5 are the runner's 3 and 4.
    insert_summary(&dir, "s1", 0, (1, "m1"), (3, "opener"), "Before");
    insert_summary(&dir, "s1", 1, (4, "m5"), (5, "m6"), "After");
    rusqlite::Connection::open(dir.join("context.db"))
        .unwrap()
        .execute("UPDATE compartments SET harness = 'opencode'", [])
        .unwrap();
    let store = Store::open(&dir.join("mode3.db")).unwrap();
    let mut request = move_request(&dir);
    request.session = SessionRef::new("mock-runner", "opencode", "s1");
    request.newest = cortexkit_role_compaction::read::Cursor::new(4, "m6", "d");
    let row = |mid: &str, entry: Option<u64>, finished_summary: bool| HostMessage {
        source_entry: None,
        mid: mid.into(),
        entry,
        finished_summary,
        added: false,
        pi: None,
    };
    let messages = vec![
        row("m1", Some(1), false),
        row("m2", Some(2), false),
        row("opener", None, false),
        row("summary", None, true),
        row("m5", Some(3), false),
        row("m6", Some(4), false),
    ];
    let config: mc_module::config::Config = Settings::default().into();

    // Without the message rows the stored numbers are taken as the runner's,
    // and they run past its newest entry.
    let refused = mc_module::move_in::move_in(db, &store, &config, &request).unwrap_err();
    assert!(refused.starts_with("session_not_summarized:"), "{refused}");

    // Another host's standalone numbering isn't built.
    let mut other_host = move_request(&dir);
    other_host.messages = Some(messages.clone());
    let db = ContextDb::open(&dir.join("context.db")).unwrap();
    let refused = mc_module::move_in::move_in(db, &store, &config, &other_host).unwrap_err();
    assert!(refused.starts_with("renumbering_unsupported:"), "{refused}");

    request.messages = Some(messages);
    let db = ContextDb::open(&dir.join("context.db")).unwrap();
    mc_module::move_in::move_in(db, &store, &config, &request).unwrap();
    let connection = rusqlite::Connection::open(dir.join("context.db")).unwrap();
    let ranges: Vec<String> = connection
        .prepare(
            "SELECT start_message || '-' || end_message FROM compartments
             WHERE session_id = 's1' ORDER BY sequence",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(ranges, ["1-2", "3-4"]);
    let fence: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations_meta WHERE key IN ('mode3_move:opencode:s1', 'mode3_renumber:opencode:s1')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(fence, 2);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn lifecycle_one_worker_handles_setup_notice_and_tool_in_order() {
    let mut runner = start(config("worker", Kind::OpenAi, free())).await;
    runner.play(&[user("Review."), read_file(50)]).await;
    let client = runner.provider().client.clone();
    let pause = Arc::new(tokio::sync::Semaphore::new(0));
    *client.pause_reads.lock().unwrap() = Some(pause.clone());
    let module = Module::new(client.clone(), Settings::default(), None, None);
    let route = runner.provider().route.clone();
    let last = runner.host().entries().last().cloned().unwrap();
    let newest = cortexkit_role_compaction::read::Cursor::new(last.ordinal, last.mid, last.digest);
    let request = SetupRequest::new(
        "worker",
        ModelRef::new("test", "test-model"),
        40_000,
        1000,
        free(),
        Vec::new(),
        1,
    )
    .with_newest(newest.clone());
    module.setup(route.clone(), request).unwrap();
    client.read_started.notified().await;
    let conditions = cortexkit_role_compaction::notice::Conditions::new(
        ModelRef::new("test", "test-model"),
        40_000,
        1000,
        free(),
    );
    assert_eq!(
        module.notice(
            &route.session,
            NoticeRequest::new(1, conditions).with_newest(newest)
        ),
        Ok(NoticeAnswer::Received)
    );
    let tool_module = module.clone();
    let tool = tokio::spawn(async move {
        tool_module
            .tool(&route, "ctx_reduce", json!({"drop":"3"}))
            .await
    });
    tokio::task::yield_now().await;
    assert!(
        !tool.is_finished(),
        "a tool overtook Setup's transcript read"
    );
    *client.pause_reads.lock().unwrap() = None;
    pause.add_permits(1);
    tokio::time::timeout(std::time::Duration::from_secs(5), tool)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn lifecycle_pre_user_honors_its_budget_behind_a_stuck_job() {
    let module = Module::new(StuckClient, Settings::default(), None, None);
    let route = Route {
        session: SessionRef::new("mock-runner", "mock", "stuck"),
        project: None,
        workdir: None,
        agent_id: None,
    };
    let request = SetupRequest::new(
        "worker",
        ModelRef::new("test", "model"),
        40_000,
        1000,
        free(),
        Vec::new(),
        1,
    )
    .with_newest(cortexkit_role_compaction::read::Cursor::new(1, "m1", "d"));
    module.setup(route.clone(), request).unwrap();
    let start = std::time::Instant::now();
    let answer = tokio::time::timeout(
        mc_module::module::PRE_USER_BUDGET + std::time::Duration::from_millis(500),
        module.pre_user(&route.session, "hello", 1),
    )
    .await
    .expect("pre_user missed its budget");
    assert!(answer.prepend.is_none() && answer.append.is_none());
    assert!(start.elapsed() >= mc_module::module::PRE_USER_BUDGET);
}

#[tokio::test]
async fn lifecycle_tools_answer_while_the_historian_is_still_writing() {
    let client = HostClient::default();
    let pause = Arc::new(tokio::sync::Semaphore::new(0));
    *client.pause_children.lock().unwrap() = Some(pause.clone());
    let mut runner = start_with_client(
        client.clone(),
        config("head", Kind::OpenAi, free()),
        Settings::default(),
        None,
        false,
        |_| {},
    )
    .await;
    let module = runner.provider().module();
    let route = runner.provider().route.clone();
    let play = tokio::spawn(async move {
        let mut steps = turn("Look at a.rs.");
        steps.extend(turn("And b.rs."));
        steps.extend(turn("Then c.rs."));
        steps.push(answer());
        runner.play(&steps).await;
        runner
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.child_started.notified(),
    )
    .await
    .expect("the historian did not start");
    let answer = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        module.tool(&route, "ctx_reduce", json!({"drop":"3"})),
    )
    .await
    .expect("a historian run blocked the worker");
    assert!(answer.is_ok(), "{answer:?}");
    *client.pause_children.lock().unwrap() = None;
    pause.add_permits(1);
    let runner = tokio::time::timeout(std::time::Duration::from_secs(5), play)
        .await
        .unwrap()
        .unwrap();
    assert_clean(&runner);
}

#[tokio::test]
async fn contract_update_setup_child_harness_changes_only_future_children() {
    let client = HostClient::default();
    let pause = Arc::new(tokio::sync::Semaphore::new(0));
    *client.pause_children.lock().unwrap() = Some(pause.clone());
    let mut runner = start_with_client(
        client.clone(),
        config("head", Kind::OpenAi, free()),
        Settings::default(),
        None,
        false,
        |_| {},
    )
    .await;
    let module = runner.provider().module();
    let route = runner.provider().route.clone();
    let setup = |harness: Option<&str>| {
        let mut request = SetupRequest::new(
            "head",
            ModelRef::new("test", "test-model"),
            100_000,
            1_000,
            free(),
            Vec::new(),
            1,
        );
        request.child_harness = harness.map(str::to_owned);
        request
    };
    module.setup(route.clone(), setup(Some("child-a"))).unwrap();
    module.idle(&route.session).await.unwrap();
    let play = tokio::spawn(async move {
        let mut steps = turn("Look at a.rs.");
        steps.extend(turn("And b.rs."));
        steps.extend(turn("Then c.rs."));
        steps.push(answer());
        runner.play(&steps).await;
        runner
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.child_started.notified(),
    )
    .await
    .expect("the historian did not start");
    module.setup(route.clone(), setup(Some("child-b"))).unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        module.tool(&route, "ctx_reduce", json!({"drop":""})),
    )
    .await
    .expect("Setup blocked behind the historian")
    .unwrap();
    *client.pause_children.lock().unwrap() = None;
    pause.add_permits(1);
    let mut runner = tokio::time::timeout(std::time::Duration::from_secs(5), play)
        .await
        .unwrap()
        .unwrap();
    // More history, so a summary runs after the Setup change.
    let mut steps = turn("Then d.rs.");
    steps.extend(turn("Then e.rs."));
    steps.extend(turn("Then f.rs."));
    steps.push(answer());
    runner.play(&steps).await;
    let calls = client.child_harnesses.lock().unwrap().clone();
    assert_eq!(
        calls[..2],
        [
            ("send".into(), "child-a".into()),
            ("result".into(), "child-a".into())
        ]
    );
    assert!(
        calls
            .iter()
            .any(|(op, harness)| op == "send" && harness == "child-b"),
        "{calls:?}"
    );
    assert!(
        calls[2..].iter().all(|(_, harness)| harness == "child-b"),
        "{calls:?}"
    );
    assert_clean(&runner);
}
