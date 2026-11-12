use super::*;
use std::time::Duration;

#[tokio::test]
async fn app_read_summary_reduce_publication_and_all_six_methods() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config("head", Kind::OpenAi, free());
    let key = cfg.session.clone();
    let mut settings = one_pass();
    settings.protected_tokens = Some(0);
    let mut runner = start_full(cfg, settings, Some(dir.path().to_owned())).await;
    for prompt in ["Look at the appneedle in a.rs.", "Now b.rs.", "And c.rs."] {
        runner.play(&turn(prompt)).await;
    }
    assert_clean(&runner);
    assert!(!runner.host().child_runs().is_empty());
    let app = runner.provider().module().app_read().clone();
    let meta = app
        .read("session_data.read", json!({"section":"meta","session":key}))
        .await
        .unwrap();
    assert!(meta["row"]["compartment_count"].as_u64().unwrap() > 0);
    assert_eq!(meta["row"]["compartment_in_progress"], false);
    // The latest three tool calls are always protected. Use a fresh raw part
    // after the summary, then put three small calls behind it before reducing.
    for path in ["app-drop-target", "guard-a", "guard-b", "guard-c"] {
        runner
            .play(&[step(
                "Inspecting a small file.",
                vec![ToolCall::ok(
                    "read",
                    json!({"path":path}),
                    "small file contents",
                )],
            )])
            .await;
    }
    let (mid, tag) = runner
        .host()
        .entries()
        .iter()
        .find_map(|entry| {
            entry.parts.iter().find_map(|part| match &part.body {
                PartBody::Tool(tool)
                    if tool.name == "read"
                        && tool
                            .input
                            .get("path")
                            .as_ref()
                            .and_then(serde_json::Value::as_str)
                            == Some("app-drop-target") =>
                {
                    part.tag
                        .filter(|tag| {
                            seen(runner.host(), *tag).is_some_and(|text| !text.contains("[dropped"))
                        })
                        .map(|tag| (entry.mid.clone(), tag))
                }
                _ => None,
            })
        })
        .unwrap();
    runner.play(&[reduce(&tag.to_string())]).await;
    let queued = app
        .read("context.states", json!({"session":key,"message_ids":[mid]}))
        .await
        .unwrap();
    assert_eq!(queued["messages"][0]["stamped_parts"][0]["stage"], "queued");
    assert!(queued["messages"][0]["stamped_parts"][0]["stamped_at_ms"].is_u64());
    let mut watch = app
        .watch("direct".into(), json!({"sessions":[key]}))
        .await
        .unwrap();
    assert_eq!(watch.recv().await.unwrap().unwrap()["kind"], "resync");
    let before = runner.host().applied_version();
    runner
        .play(&[switch_model("head"), answer(), answer()])
        .await;
    assert_clean(&runner);
    assert_ne!(runner.host().applied_version(), before);
    assert!(
        seen(runner.host(), tag).is_some_and(|text| text.contains("[dropped")),
        "the requested part must actually be dropped"
    );
    let notice = tokio::time::timeout(Duration::from_secs(5), watch.recv())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(notice["sessions"], json!([key]));
    let breakdown = app
        .read(
            "session_data.read",
            json!({"session":key,"section":"token_breakdown"}),
        )
        .await
        .unwrap();
    assert_eq!(breakdown["state"], "ready");
    assert_eq!(breakdown["row"]["managed"]["value"], true);
    assert_eq!(breakdown["row"]["total"]["source"], "provider");
    let labels: Vec<_> = breakdown["row"]["parts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|part| {
            (
                part["part"].as_str().unwrap(),
                part["estimate"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        labels,
        [
            ("system_prompt", true),
            ("tool_definitions", true),
            ("memory", false),
            ("project_docs", false),
            ("user_profile", false),
            ("history_summaries", false),
            ("history_raw", false),
            ("tool_calls_results", true),
            ("reasoning", true),
            ("last_user_message", false),
            ("user_messages", false),
            ("notices", false),
        ]
    );
    let first_mid = runner.host().entries().first().unwrap().mid.clone();
    let states = app
        .read(
            "context.states",
            json!({"session":key,"message_ids":[mid,first_mid]}),
        )
        .await
        .unwrap();
    assert_eq!(states["messages"][0]["state"], "raw");
    assert_eq!(states["messages"][0]["stamped_parts"], json!([]));
    assert!(!states["messages"][0]["dropped_parts"]
        .as_array()
        .unwrap()
        .is_empty());
    let id = states["compartments"][0]["compartment_id"].clone();
    let summary_mid = states["compartments"][0]["first_message_id"].clone();
    let summarized = app
        .read(
            "context.states",
            json!({"session":key,"message_ids":[summary_mid]}),
        )
        .await
        .unwrap();
    assert_eq!(summarized["messages"][0]["state"], "summarized");
    let compartment = app
        .read(
            "context.compartment",
            json!({"session":key,"compartment_id":id}),
        )
        .await
        .unwrap();
    assert!(compartment["compartment"]["summary_markdown"]
        .as_str()
        .is_some_and(|s| !s.is_empty()));
    assert!(compartment["compartment"]["tiers"]["p1"].is_string());
    let cache = app
        .read(
            "context.cache_why",
            json!({"session":key,"producers":[{"producer_ref":mid}]}),
        )
        .await
        .unwrap();
    assert_eq!(cache["join"], "unavailable");
    let search = app
        .read(
            "context.search",
            json!({"query":"appneedle","scope":{"session":key},"sources":["message"]}),
        )
        .await
        .unwrap();
    assert_eq!(search["hits"].as_array().unwrap().len(), 1);
    let hit = &search["hits"][0];
    assert_eq!(hit["source"], "message");
    assert_eq!(hit["session"]["runner"], "mock-runner");
    let range = &hit["match_ranges"][0];
    assert_eq!(
        &hit["snippet"].as_str().unwrap()
            [range[0].as_u64().unwrap() as usize..range[1].as_u64().unwrap() as usize],
        "appneedle"
    );
    let conn = rusqlite::Connection::open(dir.path().join("mode3.db")).unwrap();
    let state: String = conn
        .query_row(
            "SELECT state FROM sessions WHERE session=?1",
            [&key.session],
            |row| row.get(0),
        )
        .unwrap();
    let state: Value = serde_json::from_str(&state).unwrap();
    assert!(state["app"].get("decisions").is_none());
    let decisions: String = conn
        .query_row(
            "SELECT decisions FROM app_read_decisions WHERE session=?1",
            [&key.session],
            |row| row.get(0),
        )
        .unwrap();
    let decisions: Value = serde_json::from_str(&decisions).unwrap();
    assert!(decisions
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d["status"] == "accepted" || d["status"] == "applied"));
}
