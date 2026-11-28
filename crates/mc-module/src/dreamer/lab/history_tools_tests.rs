use super::*;

fn stored_summary(
    conn: &rusqlite::Connection,
    session: &str,
    start: i64,
    end: i64,
    title: &str,
    tiers: (&str, &str),
) {
    conn.execute("INSERT INTO compartments (session_id,harness,sequence,start_message,end_message,title,content,p1,created_at)
        VALUES (?1,'mock',?2,?2,?3,?4,?5,?6,1)", params![session,start,end,title,tiers.0,tiers.1]).unwrap();
}

#[test]
fn history_search_fuses_words_and_meaning_without_hiding_the_persons_message() {
    use crate::search::{lab::History, sources::Semantic};
    let fixture = Fixture::new();
    let conn = rusqlite::Connection::open(&fixture.frozen).unwrap();
    let query = "How does the scheduler prevent duplicating periodic cleanup requests?";
    stored_summary(&conn, "session-p", 20, 21, "Conjecture", (query, ""));
    stored_summary(
        &conn,
        "session-p",
        30,
        31,
        "Lease",
        ("A lease serializes cleanup in the background.", ""),
    );
    stored_summary(
        &conn,
        "session-p2",
        30,
        31,
        "Literal",
        ("unique_refresh_guard", ""),
    );
    index_message(&conn, "session-p", 30, "user", query, 1000);
    let vector = [1.0, 0.0];
    conn.execute("INSERT INTO compartment_chunk_embeddings (compartment_id,session_id,project_path,harness,window_index,start_ordinal,end_ordinal,chunk_hash,model_id,dims,vector,created_at)
                  SELECT id,session_id,'p',harness,0,30,31,'hash','model',2,?1,1 FROM compartments WHERE title='Lease'", [crate::embedding::encode(&vector)]).unwrap();
    let semantic = Semantic {
        vector: &vector,
        model_id: "model",
        chunk_model_id: "model",
    };
    let history = History::load(&conn, "p", None).unwrap();
    let answer = history
        .search(&conn, &json!({"query":query}), Some(semantic))
        .unwrap();
    let summaries = group(&answer, "Summaries");
    assert!(
        summaries
            .lines()
            .next()
            .unwrap()
            .contains("match=lexical+semantic title=Lease"),
        "{answer}"
    );
    assert!(
        group(&answer, "The person's messages").contains("ref=s1:30"),
        "{answer}"
    );
    let exact = history
        .search(&conn, &json!({"query":"unique_refresh_guard"}), None)
        .unwrap();
    assert!(
        group(&exact, "Summaries")
            .lines()
            .next()
            .unwrap()
            .contains("title=Literal"),
        "{exact}"
    );
}

#[test]
fn ordinary_message_lane_and_fused_history_keep_their_fixture_output() {
    use crate::search::{self, messages, sources::Semantic};
    let fixture = Fixture::new();
    let conn = rusqlite::Connection::open(&fixture.frozen).unwrap();
    index_message(&conn, "session-p", 2, "assistant", "sharedterm advice", 900);
    let vector = [1.0, 0.0];
    conn.execute("INSERT INTO compartment_chunk_embeddings (compartment_id,session_id,project_path,harness,window_index,start_ordinal,end_ordinal,chunk_hash,model_id,dims,vector,created_at)
                  VALUES (1,'session-p','p','mock',0,1,4,'hash','model',2,?1,1)", [crate::embedding::encode(&vector)]).unwrap();
    let semantic = Semantic {
        vector: &vector,
        model_id: "model",
        chunk_model_id: "model",
    };
    let mut coverage = messages::Coverage::default();
    let reach = messages::reach(&conn, &mut coverage, "session-p", None);
    let short = messages::search_at(
        &conn,
        "session-p",
        &messages::Query {
            text: "sharedterm",
            limit: 3,
            probes: &[],
            dates: None,
            visible: None,
        },
        &[3],
        4,
        true,
        &reach,
    );
    assert_eq!(
        short,
        vec![vec![messages::MessageHit {
            number: 2,
            message_id: "session-p-2".into(),
            role: "assistant".into(),
            content: "sharedterm advice".into(),
            score: 1.0
        }]]
    );
    let scope = search::Scope {
        harness: "mock",
        session: "session-p",
        project: Some("p"),
        workspace: None,
        cutoff: 4,
        visible_messages: None,
        seen: &BTreeMap::new(),
        memory_enabled: false,
        git_commits_enabled: false,
        git_repository: None,
        semantic: Some(semantic),
    };
    let prepared = search::prepare(
        &conn,
        &mut coverage,
        &scope,
        &json!({"query":"sharedterm","sources":["message"]}),
        None,
    )
    .unwrap();
    let answer = search::reply(&scope, prepared);
    assert_eq!(answer, concat!(
        "Found 1 result for \"sharedterm\":\n\n",
        "[1] [message] score=0.80 compartment_id=1 range=1-4 match=hybrid title=A frozen summary\n",
        "Snippet: sharedterm advice\n\n",
        "Message history: 1 raw-message match is newer than the last compartment boundary (already in your context)."
    ));
}

#[tokio::test]
async fn history_read_round_trips_short_refs_and_dates_in_a_single_session() {
    let fixture = Fixture::new();
    let frozen = rusqlite::Connection::open(&fixture.frozen).unwrap();
    frozen
        .execute(
            "UPDATE compartments SET p1='Frozen detailed tier' WHERE session_id='session-p'",
            [],
        )
        .unwrap();
    drop(frozen);
    let live = ContextDb::open(&fixture.live).unwrap();
    live.with_connection(|conn| {
        conn.execute(
            "UPDATE compartments SET p1='LIVE detailed tier' WHERE session_id='session-p'",
            [],
        )
        .unwrap();
    });
    drop(live);
    let mut spec = fixture.spec_value();
    spec["tools"] = json!(["history_read", "history_search"]);
    spec["history_sessions"] = json!(["session-p"]);
    let lab = Arc::new(Lab::load(fixture.start(&spec).await.unwrap(), None).unwrap());
    let read = |input| lab.clone().tool("history_read", input);
    let by_ref = read(json!({"ref":"  1-4\n"})).await.unwrap();
    assert_eq!(
        by_ref,
        "ref=1-4 date=1970-01-01 title=A frozen summary\nFrozen detailed tier"
    );
    assert_eq!(
        read(json!({"from":"1970-01-01","to":"1970-01-01"}))
            .await
            .unwrap(),
        by_ref
    );
    for reference in ["s1:1-4", "session-p2:1-4", "session-p:1-4", "81-83"] {
        assert!(read(json!({"ref":reference}))
            .await
            .unwrap_err()
            .contains("<start>-<end>"));
    }
    assert!(
        read(json!({"session":"session-p2","from":"1970-01-01","to":"1970-01-01"}))
            .await
            .is_err()
    );
    assert!(!by_ref.contains("LIVE"));
}

#[tokio::test]
async fn history_references_stay_short_from_prompt_to_saved_verdict() {
    for mode in ["single", "explicit", "implicit"] {
        let fixture = Fixture::new();
        let db = rusqlite::Connection::open(&fixture.frozen).unwrap();
        db.execute_batch(
            "UPDATE session_projects SET session_id = CASE session_id WHEN 'session-p' THEN 'ses_Z' ELSE 'ses_A' END WHERE project_path = 'p';
             UPDATE compartments SET session_id = 'ses_Z', created_at = 1000, content = 'sharedterm early summary' WHERE session_id = 'session-p';
             UPDATE compartments SET session_id = 'ses_A', created_at = 2000, content = 'sharedterm late summary' WHERE session_id = 'session-p2';
             UPDATE memories SET source_session_id = CASE id WHEN 7 THEN 'ses_Z' ELSE 'ses_A' END,
                 source_ordinals_json = '[[1,4]]' WHERE id IN (7,2);
             INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES ('ses_raw_only', 'mock', 'p', 1);
             INSERT INTO git_commits (sha, project_path, short_sha, message, author, committed_at, indexed_at)
                VALUES ('abc123', 'p', 'abc123', 'sharedterm commit', 'author', 1000, 1000);",
        ).unwrap();
        for session in ["ses_Z", "ses_A", "ses_raw_only"] {
            index_message(
                &db,
                session,
                11,
                "user",
                "sharedterm person's message",
                1000,
            );
            index_message(
                &db,
                session,
                12,
                "assistant",
                "sharedterm agent message",
                1000,
            );
        }
        drop(db);
        let mut spec = fixture.spec_value();
        spec["tools"] = json!([
            "git_read",
            "memory_search",
            "history_search",
            "history_read",
            "submit"
        ]);
        let (prefix, date_label, map, outside) = match mode {
            "single" => {
                spec["history_sessions"] = json!(["ses_Z"]);
                ("", None, json!({"":"ses_Z"}), 1)
            }
            "explicit" => {
                spec["history_sessions"] = json!(["ses_A", "ses_Z"]);
                ("s2:", Some("s2"), json!({"s1":"ses_A","s2":"ses_Z"}), 0)
            }
            _ => ("s1:", Some("s1"), json!({"s1":"ses_Z","s2":"ses_A"}), 0),
        };
        let reference = format!("{prefix}1-4");
        let citation = format!("history:{reference}");
        let mut dates = json!({"from":"1970-01-01","to":"1970-01-01"});
        if let Some(label) = date_label {
            dates["session"] = json!(label);
        }
        let mut verdict = verdict(7, "Spring cleaning");
        verdict["evidence"] =
            json!([{"kind":"history","ref":citation,"quote":"sharedterm early summary"}]);
        let client = fixture.run(spec, Ends::LabTools(vec![
            json!({"name":"history_search", "arguments":{"query":"sharedterm","include_agent":true}}),
            json!({"name":"history_read", "arguments":{"ref":format!("  {reference}\n")}}),
            json!({"name":"history_read", "arguments":dates}),
            submit(&[verdict]),
        ])).await;
        let request = fixture.output("request.json");
        assert!(!request.to_string().contains("ses_"), "{request}");
        let prompt = request["first_message"].as_str().unwrap();
        assert!(
            prompt.contains(&format!("origin: ref={reference} date=")),
            "{prompt}"
        );
        assert_eq!(prompt.matches("origin: ref=").count(), 2 - outside);
        assert_eq!(
            prompt.matches("History session labels:").count(),
            usize::from(date_label.is_some())
        );
        if date_label.is_some() {
            assert!(
                prompt.ends_with("History session labels:\ns1: mock\ns2: mock"),
                "{prompt}"
            );
        }

        let tools = request["lab_tools"].as_array().unwrap();
        let schema = &tools
            .iter()
            .find(|tool| tool["name"] == "history_read")
            .unwrap()["input_schema"];
        assert_eq!(schema["oneOf"][0]["required"], json!(["ref"]));
        if date_label.is_some() {
            assert_eq!(
                schema["oneOf"][1]["required"],
                json!(["session", "from", "to"])
            );
            assert_eq!(schema["properties"]["session"]["enum"], json!(["s1", "s2"]));
        } else {
            assert_eq!(schema["oneOf"][1]["required"], json!(["from", "to"]));
            assert!(schema["properties"].get("session").is_none());
        }

        let results = client.lab_tool_results.lock().unwrap();
        let search = answer(&results, 0);
        assert!(!search.contains("ses_"), "{search}");
        let summaries = group(search, "Summaries");
        assert!(
            summaries.contains(&format!("ref={reference}\n")),
            "{summaries}"
        );
        assert!(
            !summaries.contains("compartment_id=") && !summaries.contains("range="),
            "{summaries}"
        );
        assert!(group(search, "The person's messages").contains(&format!("ref={prefix}11\n")));
        assert_eq!(
            group(search, "The person's messages")
                .matches("ref=")
                .count(),
            2 - outside
        );
        assert!(group(search, "Agent messages").contains(&format!("ref={prefix}12\n")));
        assert!(group(search, "Commits").contains("ref=abc123\n"));
        let read = answer(&results, 1);
        assert_eq!(read, answer(&results, 2));
        assert_eq!(
            read,
            format!(
                "ref={reference} date=1970-01-01 title=A frozen summary\nsharedterm early summary"
            )
        );
        assert_eq!(fixture.output("run.json")["history_session_map"], map);
        assert_eq!(fixture.output("run.json")["origins_outside_scope"], outside);
        assert_eq!(
            fixture.output("verdicts.json")[0]["evidence"][0]["ref"],
            citation
        );
    }
}

#[tokio::test]
async fn history_read_rejects_unlabelled_unknown_and_old_refs_in_a_labelled_scope() {
    let fixture = Fixture::new();
    let mut spec = fixture.spec_value();
    spec["tools"] = json!(["history_read"]);
    spec["history_sessions"] = json!(["session-p2", "session-p"]);
    let lab = Arc::new(Lab::load(fixture.start(&spec).await.unwrap(), None).unwrap());
    for reference in ["1-4", "s3:1-4", "session-p:1-4", "s2:81-83"] {
        let error = lab
            .clone()
            .tool("history_read", json!({"ref":reference}))
            .await
            .unwrap_err();
        assert!(
            error.contains("<label>:<start>-<end>; valid labels: s1, s2"),
            "{error}"
        );
    }
    let error = lab
        .tool(
            "history_read",
            json!({"session":"session-p","from":"1970-01-01","to":"1970-01-01"}),
        )
        .await
        .unwrap_err();
    assert!(error.contains("valid labels: s1, s2"), "{error}");
}

#[tokio::test]
async fn history_read_caps_pages_and_continues_long_unicode_summaries() {
    let fixture = Fixture::new();
    let conn = rusqlite::Connection::open(&fixture.frozen).unwrap();
    let long = format!("{}\n{}", "é".repeat(15_850), "雪".repeat(650));
    for (start, text) in [(20, "Second"), (21, "Third"), (22, "Fourth")] {
        stored_summary(&conn, "session-p", start, start, text, (text, ""));
        index_message(&conn, "session-p", start, "user", text, 1000);
    }
    stored_summary(&conn, "session-p", 30, 30, "Long", ("short tier", &long));
    drop(conn);
    let mut spec = fixture.spec_value();
    spec["tools"] = json!(["history_read"]);
    spec["history_sessions"] = json!(["session-p"]);
    let lab = Arc::new(Lab::load(fixture.start(&spec).await.unwrap(), None).unwrap());
    let read = |input| lab.clone().tool("history_read", input);
    let page = read(json!({"from":"1970-01-01","to":"1970-01-01"}))
        .await
        .unwrap();
    assert_eq!(page.matches("\n\nref=").count(), 2, "{page}");
    assert!(
        page.contains("2 more summaries match. Next: history_read {\"ref\":\"22-22\"}"),
        "{page}"
    );
    let first = read(json!({"ref":"30-30"})).await.unwrap();
    assert!(first.chars().count() <= 16_000);
    let (head, next) = first
        .split_once("\n\nContinue this summary: history_read ")
        .unwrap();
    assert!(head.ends_with('\n'), "cut should be at the nearby line end");
    let next: Value = serde_json::from_str(next).unwrap();
    assert_eq!(next, json!({"ref":"30-30","offset":15_851}));
    let rest = read(next).await.unwrap();
    assert_eq!(
        format!(
            "{}{}",
            head.split_once('\n').unwrap().1,
            rest.split_once('\n').unwrap().1
        ),
        long
    );
}

#[tokio::test]
async fn lab_memory_blocks_locate_origins_by_ordinals_then_time_and_omit_unattributable_sources() {
    let fixture = Fixture::new();
    let conn = rusqlite::Connection::open(&fixture.frozen).unwrap();
    for (ordinal, timestamp) in [(1, 1000), (4, 2000), (5, 4000), (8, 5000)] {
        index_message(
            &conn,
            "session-p",
            ordinal,
            "user",
            "summary source",
            timestamp,
        );
    }
    stored_summary(&conn, "session-p", 5, 8, "Second summary", ("body", ""));
    conn.execute("INSERT INTO session_projects (session_id,harness,project_path,updated_at) VALUES ('session-p2','other','secret',1)", []).unwrap();
    for (id, session, ordinals, time) in [
        (10, Some("session-p"), Some("[[1,2],[3,4]]"), 4500),
        (11, Some("session-p"), Some("[[1,2],[5,6]]"), 4500),
        (12, Some("session-p"), Some("[[100,101]]"), 4500),
        (13, Some("session-p"), None, 3500),
        (14, None, None, 4500),
        (15, Some("session-p2"), Some("[[1,3]]"), 4500),
        (16, Some("session-p"), None, 500),
    ] {
        conn.execute("INSERT INTO memories (id,level,owner_id,category,origin_category,content,normalized_hash,first_seen_at,created_at,updated_at,last_seen_at,source_session_id,source_ordinals_json)
            VALUES (?1,'project','p','swe:architecture','ARCHITECTURE',?1,?1,1,?2,1,1,?3,?4)", params![id,time,session,ordinals]).unwrap();
    }
    drop(conn);
    let mut spec = fixture.spec_value();
    spec["memory_ids"] = json!([10, 11, 12, 13, 14, 15, 16]);
    fixture.run(spec, Ends::LabTools(vec![])).await;
    let request = fixture.output("request.json");
    let prompt = request["first_message"].as_str().unwrap();
    let mut cases = Vec::new();
    for id in 10..=16 {
        let (_, block) = prompt.split_once(&format!("### Memory {id}\n")).unwrap();
        cases.push(
            block
                .split("### Memory ")
                .next()
                .unwrap()
                .lines()
                .find(|line| line.starts_with("origin:")),
        );
    }
    assert_eq!(
        cases,
        [
            Some("origin: ref=s1:1-4 date=1970-01-01 title=A frozen summary"),
            Some("origin: ref=s1:1-4 date=1970-01-01 title=A frozen summary and later"),
            Some("origin: ref=s1:5-8 date=1970-01-01 title=Second summary"),
            Some("origin: ref=s1:1-4 date=1970-01-01 title=A frozen summary"),
            None,
            None,
            None,
        ]
    );
}

fn removal(id: i64, verdict_name: &str) -> Value {
    let mut result = verdict(id, "Checked the record");
    result["verdict"] = json!(verdict_name);
    result["proof"] = json!("record");
    result
}

fn reasoning(value: &mut Value) {
    value["reasoning"] =
        json!("I checked the summary; a later counterexample would change my view.");
}

fn answer(results: &[Value], index: usize) -> &str {
    results[index]["content"][0]["text"].as_str().unwrap()
}

#[tokio::test]
async fn submit_requires_integer_confidence_from_one_to_one_hundred() {
    let fixture = Fixture::new();
    let spec = fixture.spec_value();
    let lab = Arc::new(Lab::load(fixture.start(&spec).await.unwrap(), None).unwrap());
    for confidence in [None, Some(json!(0)), Some(json!(101)), Some(json!(50.5))] {
        let mut entry = verdict(7, "Unaccepted confidence");
        if let Some(value) = confidence {
            entry["confidence"] = value;
        } else {
            entry.as_object_mut().unwrap().remove("confidence");
        }
        let error = lab
            .clone()
            .tool("submit", json!({"verdicts":[entry]}))
            .await
            .unwrap_err();
        assert!(error.contains("confidence"), "{error}");
        assert_eq!(fixture.output("verdicts.json"), json!([]));
    }

    let mut low = verdict(7, "Low confidence");
    low["confidence"] = json!(1);
    let mut high = verdict(2, "High confidence");
    high["confidence"] = json!(100);
    lab.clone()
        .tool("submit", json!({"verdicts":[low,high]}))
        .await
        .unwrap();
    assert_eq!(fixture.output("verdicts.json"), json!([low, high]));

    let tool = lab
        .tools()
        .iter()
        .find(|tool| tool["name"] == "submit")
        .unwrap();
    let schema = &tool["input_schema"]["properties"]["verdicts"]["items"];
    assert!(schema["required"]
        .as_array()
        .unwrap()
        .contains(&json!("confidence")));
    assert_eq!(
        schema["properties"]["confidence"],
        json!({
            "type":"integer", "minimum":1, "maximum":100, "description":"How sure you are that this verdict is right."
        })
    );
}

#[tokio::test]
async fn submit_requires_bounded_reasoning_for_removals_but_not_keep_and_refuses_them_alone() {
    let fixture = Fixture::new();
    let invalid = removal(7, "retire");
    let mut blank = invalid.clone();
    blank["reasoning"] = json!("\t ");
    let mut too_long = invalid.clone();
    too_long["reasoning"] = json!("é".repeat(1201));
    let mut valid = invalid.clone();
    reasoning(&mut valid);
    let keep = verdict(2, "still holds");
    let client = fixture
        .run(
            fixture.spec_value(),
            Ends::LabTools(vec![
                submit(&[invalid, keep.clone()]),
                submit(&[blank]),
                submit(&[too_long]),
                submit(&[valid.clone()]),
            ]),
        )
        .await;
    let replies = client.lab_tool_results.lock().unwrap();
    assert_ne!(replies[0]["isError"], true);
    assert!(answer(&replies, 0).contains("(id 7): reasoning must not be blank"));
    assert!(answer(&replies, 1).contains("reasoning must not be blank"));
    assert!(answer(&replies, 2).contains("reasoning must be at most 1,200 characters"));
    assert_eq!(client.lab_verdicts_after.lock().unwrap()[0], json!([keep]));
    assert_eq!(fixture.output("verdicts.json"), json!([valid, keep]));
}

#[tokio::test]
async fn submit_confirmation_off_preserves_the_reply_and_file_shape() {
    let fixture = Fixture::new();
    let mut retire = removal(7, "retire");
    reasoning(&mut retire);
    let keep = verdict(2, "still relevant");
    let client = fixture
        .run(
            fixture.spec_value(),
            Ends::LabTools(vec![submit(&[retire.clone(), keep.clone()])]),
        )
        .await;
    assert_eq!(
        answer(&client.lab_tool_results.lock().unwrap(), 0),
        "recorded 2; 0 of 2 still open"
    );
    let expected = serde_json::to_string_pretty(&[retire, keep]).unwrap() + "\n";
    assert_eq!(
        fs::read_to_string(fixture.out.join("verdicts.json")).unwrap(),
        expected
    );
}

#[tokio::test]
async fn submit_record_challenges_include_bounded_origins_and_newest_summaries_and_settle_once() {
    let fixture = Fixture::new();
    let conn = rusqlite::Connection::open(&fixture.frozen).unwrap();
    let origin = format!("Origin detail {} not sent", "é".repeat(4050));
    conn.execute(
        "UPDATE compartments SET p1=?1 WHERE session_id='session-p'",
        [&origin],
    )
    .unwrap();
    conn.execute("UPDATE memories SET source_session_id='session-p', source_ordinals_json='[[1,4]]' WHERE id=7", []).unwrap();
    index_message(
        &conn,
        "session-p2",
        50,
        "user",
        "More recorded history",
        86_401_000,
    );
    stored_summary(
        &conn,
        "session-p2",
        50,
        50,
        "Newer decision",
        ("sharedterm from the frozen fixture", ""),
    );
    for id in [10, 11] {
        conn.execute("INSERT INTO memories (id,level,owner_id,category,origin_category,content,normalized_hash,first_seen_at,created_at,updated_at,last_seen_at)
                      VALUES (?1,'project','p','swe:architecture','ARCHITECTURE','sharedterm',?1,1,1,1,1)", [id]).unwrap();
    }
    drop(conn);
    let mut spec = fixture.spec_value();
    spec["memory_ids"] = json!([7, 2, 10, 11]);
    spec["confirm_record_removals"] = json!(true);
    let mut retire = removal(7, "retire");
    let mut merge = removal(2, "merge");
    merge["into"] = json!(7);
    merge["new_text"] = json!("First merge wording");
    let mut repeated = removal(10, "end");
    let mut pending = removal(11, "retire");
    for entry in [&mut retire, &mut merge, &mut repeated, &mut pending] {
        reasoning(entry);
    }
    let mut confirmed = retire.clone();
    confirmed["confirmed"] = json!(true);
    let mut changed = merge.clone();
    changed["new_text"] = json!("Different merge wording");
    let client = fixture
        .run(
            spec,
            Ends::LabTools(vec![
                submit(&[retire, merge, repeated.clone(), pending]),
                submit(&[confirmed, changed, repeated.clone()]),
                submit(&[repeated]),
            ]),
        )
        .await;
    let replies = client.lab_tool_results.lock().unwrap();
    let initial = answer(&replies, 0);
    assert!(
        initial.starts_with("recorded 4; 4 of 4 still open"),
        "{initial}"
    );
    let first = initial.split("### Memory 2:").last().unwrap_or(initial);
    let first = first
        .split_once("### Memory 7:")
        .unwrap()
        .1
        .split("### Memory 10:")
        .next()
        .unwrap();
    assert!(
        first.contains("Origin:\nref=s2:1-4 date=1970-01-01 title=A frozen summary\nOrigin detail")
    );
    assert_eq!(
        first
            .split_once("\nOrigin detail ")
            .unwrap()
            .1
            .split_once("\n[origin text cut")
            .unwrap()
            .0
            .chars()
            .count(),
        4000 - "Origin detail ".len()
    );
    let snippets = first.split_once("## Summaries\n").unwrap().1;
    assert_eq!(snippets.matches("Snippet:").count(), 2, "{snippets}");
    assert!(
        snippets
            .lines()
            .next()
            .unwrap()
            .contains("title=Newer decision date=1970-01-02 ref=s1:50-50"),
        "{snippets}"
    );
    let second = answer(&replies, 1);
    assert!(
        second.starts_with("recorded 3; 2 of 4 still open; missing ids: 10, 11"),
        "{second}"
    );
    assert!(!second.contains("confirmation evidence"), "{second}");
    assert!(second.ends_with("Memory 10 is unconfirmed. Send the same verdict with `confirmed: true`, or send a different verdict."), "{second}");
    assert_eq!(
        answer(&replies, 2),
        "recorded 1; 1 of 4 still open; missing ids: 11"
    );
    let saved = fixture.output("verdicts.json");
    let states: Vec<_> = saved
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["confirmation"].as_str().unwrap())
        .collect();
    assert_eq!(states, ["confirmed", "changed", "repeated", "unconfirmed"]);
    assert_eq!(saved[1]["new_text"], "Different merge wording");
    assert_eq!(fixture.output("run.json")["missing_ids"], json!([11]));
}
