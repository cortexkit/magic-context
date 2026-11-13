use super::fixture_tests::{Fixture, EMPTY, PROJECT, T};
use super::*;

fn read(replica: &mut Replica, method: &str, params: Value) -> Result<Value, Refusal> {
    replica.read(method, &params)
}

fn ids(page: &Value, list: &str) -> Vec<i64> {
    page[list]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_i64().unwrap())
        .collect()
}

#[test]
fn stats_count_the_whole_owner_and_only_the_person_has_pending_observations() {
    let fixture = Fixture::new();
    let mut replica = fixture.replica();
    let stats = read(
        &mut replica,
        "memories.stats",
        json!({"level":"project","owner":PROJECT}),
    )
    .unwrap();
    assert_eq!(stats["total"], 8);
    assert_eq!(
        stats["by_category"]["swe:config-values"],
        json!({"active": 1, "permanent": 0, "archived": 1})
    );
    assert_eq!(
        stats["by_category"]["swe:project-rules"],
        json!({"active": 1, "permanent": 1, "archived": 0})
    );
    assert!(stats.get("pending_observations").is_none());
    let global = read(&mut replica, "memories.stats", json!({"level":"global"})).unwrap();
    assert_eq!(global["owner"], "self");
    assert_eq!(global["total"], 2);
    assert_eq!(global["pending_observations"], 3);
    let empty = read(
        &mut replica,
        "memories.stats",
        json!({"level":"project","owner":EMPTY}),
    )
    .unwrap();
    assert_eq!(
        (empty["total"].clone(), empty["by_category"].clone()),
        (json!(0), json!({}))
    );
    for (params, code) in [
        (
            json!({"level":"project","owner":"pj-never"}),
            "project_unknown",
        ),
        (json!({"level":"project"}), "invalid_params"),
        (
            json!({"level":"global","owner":"someone"}),
            "invalid_params",
        ),
        (json!({"level":"agent","owner":"a"}), "invalid_params"),
        (
            json!({"level":"project","owner":PROJECT,"status":"live"}),
            "invalid_params",
        ),
    ] {
        assert_eq!(
            read(&mut replica, "memories.stats", params)
                .unwrap_err()
                .code,
            code
        );
    }
}

#[test]
fn a_page_orders_by_category_importance_and_update_and_continues_after_its_last_row() {
    let fixture = Fixture::new();
    let mut replica = fixture.replica();
    let all = read(
        &mut replica,
        "memories.page",
        json!({"level":"project","owner":PROJECT}),
    )
    .unwrap();
    // Live rows only by default: 5 (merged away) and 8 (archived) are left out.
    assert_eq!(ids(&all, "memories"), [2, 6, 3, 4, 7, 1]);
    assert!(all.get("next").is_none());
    assert_eq!(
        (all["level"].clone(), all["owner"].clone()),
        (json!("project"), json!(PROJECT))
    );
    let first = &all["memories"][5];
    assert_eq!(first["cue"], "release from root");
    assert_eq!(first["embedded"], true);
    assert_eq!(first["source"], json!({"type":"agent","session":"s"}));
    assert_eq!(first["revision"], 2);
    assert_eq!(all["memories"][0]["embedded"], false);
    // A sensitive memory is returned with its flag; the apps hide it.
    let sensitive = &all["memories"][4];
    assert_eq!(
        (
            sensitive["sensitive"].clone(),
            sensitive["status"].clone(),
            sensitive["safety_critical"].clone()
        ),
        (json!(true), json!("permanent"), json!(true))
    );
    assert!(all["memories"][1].get("expires_at").is_none());
    assert_eq!(
        all["memories"][0]["expires_at"],
        super::fixture_tests::FUTURE
    );
    // The same list two rows at a time.
    let mut seen = Vec::new();
    let mut params = json!({"level":"project","owner":PROJECT,"limit":2});
    loop {
        let page = read(&mut replica, "memories.page", params.clone()).unwrap();
        seen.extend(ids(&page, "memories"));
        match page.get("next") {
            Some(next) => params["cursor"] = next.clone(),
            None => break,
        }
    }
    assert_eq!(seen, [2, 6, 3, 4, 7, 1]);
    let archived = read(
        &mut replica,
        "memories.page",
        json!({"level":"project","owner":PROJECT,"status":"archived"}),
    )
    .unwrap();
    assert_eq!(ids(&archived, "memories"), [8, 5]);
    let all_statuses = read(
        &mut replica,
        "memories.page",
        json!({"level":"project","owner":PROJECT,"status":"all","category":"swe:config-values"}),
    )
    .unwrap();
    assert_eq!(ids(&all_statuses, "memories"), [6, 5]);
    let empty = read(
        &mut replica,
        "memories.page",
        json!({"level":"project","owner":EMPTY}),
    )
    .unwrap();
    assert_eq!(
        empty,
        json!({"memories": [], "level": "project", "owner": EMPTY, "schema": 1, "op": "memories.page", "as_of_ms": empty["as_of_ms"]})
    );
}

#[test]
fn cursors_belong_to_their_read_and_filters_and_limits_are_bounded() {
    let fixture = Fixture::new();
    let mut replica = fixture.replica();
    let page = read(
        &mut replica,
        "memories.page",
        json!({"level":"project","owner":PROJECT,"limit":1}),
    )
    .unwrap();
    let cursor = page["next"].clone();
    for params in [
        json!({"level":"project","owner":PROJECT,"limit":1,"status":"all","cursor":cursor}),
        json!({"level":"global","cursor":cursor}),
        json!({"level":"project","owner":PROJECT,"cursor":"mcc1.not-base64!"}),
        json!({"level":"project","owner":PROJECT,"cursor":"garbage"}),
        json!({"level":"project","owner":PROJECT,"cursor":7}),
    ] {
        assert_eq!(
            read(&mut replica, "memories.page", params)
                .unwrap_err()
                .code,
            "bad_cursor"
        );
    }
    assert_eq!(
        read(
            &mut replica,
            "dreamer.runs",
            json!({"project":PROJECT,"cursor":cursor})
        )
        .unwrap_err()
        .code,
        "bad_cursor"
    );
    for limit in [json!(0), json!(201), json!(-1), json!("2")] {
        assert_eq!(
            read(
                &mut replica,
                "memories.page",
                json!({"level":"project","owner":PROJECT,"limit":limit})
            )
            .unwrap_err()
            .code,
            "invalid_params"
        );
    }
    assert!(read(
        &mut replica,
        "memories.page",
        json!({"level":"project","owner":PROJECT,"limit":200})
    )
    .is_ok());
}

#[test]
fn search_uses_the_index_for_projects_and_a_substring_for_the_person() {
    let fixture = Fixture::new();
    let mut replica = fixture.replica();
    let found = read(
        &mut replica,
        "memories.page",
        json!({"level":"project","owner":PROJECT,"text":"execute THRESHOLD"}),
    )
    .unwrap();
    assert_eq!(ids(&found, "memories"), [6]);
    // Query syntax the person types is searched for as words.
    let quoted = read(
        &mut replica,
        "memories.page",
        json!({"level":"project","owner":PROJECT,"text":"\"head\" OR NOT"}),
    )
    .unwrap();
    assert_eq!(ids(&quoted, "memories"), Vec::<i64>::new());
    assert_eq!(
        read(
            &mut replica,
            "memories.page",
            json!({"level":"project","owner":PROJECT,"text":"- !"})
        )
        .unwrap_err()
        .code,
        "invalid_params"
    );
    let global = read(
        &mut replica,
        "memories.page",
        json!({"level":"global","text":"istan"}),
    )
    .unwrap();
    assert_eq!(ids(&global, "memories"), [21]);
    assert_eq!(global["memories"][0]["sensitive"], true);
    let person = read(&mut replica, "memories.page", json!({"level":"global"})).unwrap();
    // A memory of the person names the project it came from.
    assert_eq!(person["memories"][1]["source"]["project"], PROJECT);
    assert!(person["memories"][1].get("embedded").is_none());
}

#[test]
fn get_names_the_writer_of_each_history_entry() {
    let fixture = Fixture::new();
    let mut replica = fixture.replica();
    let get = |replica: &mut Replica, id: i64| {
        read(replica, "memories.get", json!({"id":id})).unwrap()["memory"].clone()
    };
    let agent = get(&mut replica, 1);
    assert_eq!(agent["history"].as_array().unwrap().len(), 1);
    let entry = &agent["history"][0];
    assert_eq!(entry["writer"], "agent");
    assert_eq!(entry["revision"], 2);
    assert_eq!(entry["at"], T + 100_000);
    assert_eq!(entry["reason"], "ctx_memory_update");
    assert_eq!(
        entry["before"],
        "Run the release script from the repository root."
    );
    assert_eq!(
        entry["after"],
        "Run the release script from the repository root, never from a package."
    );
    assert_eq!(agent["embedded"], true);
    assert_eq!(agent["merged_from"], json!([]));
    assert!(agent.get("superseded_by").is_none());
    assert_eq!(get(&mut replica, 2)["history"][0]["writer"], "summary");
    let dreamer = &get(&mut replica, 3)["history"][0];
    assert_eq!(
        (
            dreamer["writer"].clone(),
            dreamer["run_id"].clone(),
            dreamer["task"].clone()
        ),
        (json!("dreamer"), json!(2), json!("swe:classify-memories"))
    );
    assert_eq!(get(&mut replica, 4)["history"][0]["writer"], "person");
    // The 0.49 dreamer recorded its task but no run.
    let verify = &get(&mut replica, 8)["history"][0];
    assert_eq!(
        (verify["writer"].clone(), verify["task"].clone()),
        (json!("dreamer"), json!("verify"))
    );
    assert!(verify.get("run_id").is_none());
    let merged = get(&mut replica, 6);
    assert_eq!(merged["merged_from"], json!([5, 6]));
    assert_eq!(get(&mut replica, 5)["superseded_by"], 6);
    assert_eq!(get(&mut replica, 7)["history"], json!([]));
    assert_eq!(
        read(&mut replica, "memories.get", json!({"id":999}))
            .unwrap_err()
            .code,
        "memory_not_found"
    );
    assert_eq!(
        read(&mut replica, "memories.get", json!({"id":"1"}))
            .unwrap_err()
            .code,
        "invalid_params"
    );
}

#[test]
fn history_the_memory_tool_writes_reads_as_the_agents() {
    let fixture = Fixture::new();
    let db = crate::context_db::ContextDb::open(&fixture.dir.path().join("context.db")).unwrap();
    let who = crate::memory_writes::Writer {
        harness: "opencode2",
        session: "s",
        project: PROJECT,
        authority: None,
    };
    let saved = db
        .with_connection(|conn| {
            crate::memory_writes::save(conn, &who, "NAMING", "Name views by number.")
        })
        .unwrap();
    let id = saved.memory_id.unwrap();
    db.with_connection(|conn| {
        crate::memory_writes::mutate(
            conn,
            &who,
            &crate::memory_writes::Change {
                operation: crate::memory_writes::Operation::Update,
                targets: &[(id, 1)],
                content: Some("Name views by their version number."),
                category: None,
                reason: None,
            },
        )
    })
    .unwrap();
    let mut replica = fixture.replica();
    let memory = read(&mut replica, "memories.get", json!({"id":id})).unwrap()["memory"].clone();
    let entry = &memory["history"][0];
    assert_eq!(
        (
            entry["writer"].clone(),
            entry["before"].clone(),
            entry["after"].clone(),
            entry["revision"].clone()
        ),
        (
            json!("agent"),
            json!("Name views by number."),
            json!("Name views by their version number."),
            json!(2)
        )
    );
}

#[test]
fn observations_page_newest_first_and_leaves_reviewed_ones_out() {
    let fixture = Fixture::new();
    let mut replica = fixture.replica();
    let first = read(&mut replica, "observations.page", json!({"limit":2})).unwrap();
    assert_eq!(ids(&first, "observations"), [3, 2]);
    assert_eq!(
        first["observations"][1],
        json!({"id":2,"content":"Reviews diffs before merging.","proposed_category":"swe:engineering-practice","session":"s","project":PROJECT,"created_at":1_700_000_700_000_i64})
    );
    assert!(first["observations"][0].get("project").is_none());
    let second = read(
        &mut replica,
        "observations.page",
        json!({"limit":2,"cursor":first["next"]}),
    )
    .unwrap();
    assert_eq!(ids(&second, "observations"), [1]);
    assert!(second.get("next").is_none());
    assert_eq!(
        read(&mut replica, "observations.page", json!({"level":"global"}))
            .unwrap_err()
            .code,
        "invalid_params"
    );
}

#[test]
fn facts_page_lists_the_queue_in_order_and_leaves_settled_facts_out() {
    let fixture = Fixture::new();
    let mut replica = fixture.replica();
    let first = read(
        &mut replica,
        "facts.page",
        json!({"project":PROJECT,"limit":2}),
    )
    .unwrap();
    assert_eq!(ids(&first, "facts"), [1, 2]);
    assert_eq!(
        first["facts"][0],
        json!({"id":1,"content":"The runner retries a refused view once.","category":"CONSTRAINTS","state":"retryable","attempts":1,"reason":"cas_loss"})
    );
    let second = read(
        &mut replica,
        "facts.page",
        json!({"project":PROJECT,"limit":2,"cursor":first["next"]}),
    )
    .unwrap();
    assert_eq!(ids(&second, "facts"), [3]);
    assert!(second.get("next").is_none());
    assert_eq!(
        read(&mut replica, "facts.page", json!({"project":EMPTY})).unwrap()["facts"],
        json!([])
    );
    assert_eq!(
        read(&mut replica, "facts.page", json!({"project":"pj-never"}))
            .unwrap_err()
            .code,
        "project_unknown"
    );
}

#[test]
fn a_page_stops_before_its_reply_outgrows_the_frame() {
    let fixture = Fixture::new();
    let conn = fixture.context();
    let long = "x".repeat(100 * 1024);
    for id in 100..110 {
        conn.execute(
            "INSERT INTO memories (id, level, owner_id, category, origin_category, content,
                 normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES (?1, 'project', ?2, 'swe:naming', 'NAMING', ?3, ?4, 1, 1, 1, 1)",
            params![id, EMPTY, format!("{long}{id}"), format!("hash{id}")],
        )
        .unwrap();
    }
    let mut replica = fixture.replica();
    let mut params = json!({"level":"project","owner":EMPTY});
    let mut seen = 0;
    loop {
        let page = read(&mut replica, "memories.page", params.clone()).unwrap();
        let bytes = result_bytes(page.clone()).len();
        assert!(bytes <= REPLY_BUDGET, "{bytes}");
        let count = page["memories"].as_array().unwrap().len();
        assert!(count > 0 && count < 10);
        seen += count;
        match page.get("next") {
            Some(next) => params["cursor"] = next.clone(),
            None => break,
        }
    }
    assert_eq!(seen, 10);
    conn.execute(
        // The first row in the page's order.
        "UPDATE memories SET content = ?1 WHERE id = 109",
        params!["y".repeat(REPLY_BUDGET)],
    )
    .unwrap();
    assert_eq!(
        read(
            &mut replica,
            "memories.page",
            json!({"level":"project","owner":EMPTY})
        )
        .unwrap_err()
        .code,
        "reply_too_large"
    );
}
