use super::*;
use cortexkit_role_tool_provider::result::{
    legacy_model_visible_bytes, model_visible_bytes, ContentPart, ToolResult,
    MAX_MODEL_VISIBLE_BYTES,
};
use serde_json::json;

fn assert_size(tool: &str, text: &str) {
    let mut result = ToolResult::new(vec![ContentPart::text(text)]);
    result.is_error = Some(true);
    let decoded = model_visible_bytes(&result);
    let legacy = legacy_model_visible_bytes(&serde_json::to_value(result).unwrap());
    println!("{tool}: model_visible_bytes={decoded}, legacy_model_visible_bytes={legacy}");
    assert!(decoded <= MAX_MODEL_VISIBLE_BYTES, "{tool}: {decoded}");
    assert!(legacy <= MAX_MODEL_VISIBLE_BYTES, "{tool}: {legacy}");
}

fn large() -> String {
    format!("BEGIN{}END", "🦀界".repeat(30_000))
}

fn stored_fixture() -> (Session, Client, Settings, tempfile::TempDir) {
    let (mut session, client, _, _, settings) = fixture();
    let dir = tempfile::tempdir().unwrap();
    session.db = Some(Arc::new(
        ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap(),
    ));
    session.project = Some(crate::route::Project {
        id: "dir:output-test".into(),
        root: dir.path().to_str().unwrap().into(),
    });
    (session, client, settings, dir)
}

#[tokio::test]
async fn ctx_expand_largest_single_items_fit_without_changing_the_transcript() {
    let (mut session, client, _, _, settings) = fixture();
    let content = large();
    let mut entry = text(1, "oversized");
    entry.parts[0].body = PartBody::Text {
        text: content.clone().into(),
    };
    *client.entries.lock().unwrap() = vec![entry];
    for input in [
        json!({"tag":1}),
        json!({"message":1}),
        json!({"start":1,"end":1}),
    ] {
        if input.get("tag").is_some() {
            client.pages.lock().unwrap().push_back(Ok(ReadPage::new(
                client.entries.lock().unwrap().clone(),
                Head::new(),
            )));
        }
        let answer = session
            .tool(&client, &settings, "ctx_expand", &input)
            .await
            .unwrap();
        assert!(answer.contains("BEGIN"));
        assert!(answer.contains("END"));
        assert!(answer.contains("bytes omitted here"));
        assert_size("ctx_expand", &answer);
    }
    let entries = client.entries.lock().unwrap();
    assert!(matches!(&entries[0].parts[0].body, PartBody::Text { text } if text == &content));
}

#[tokio::test]
async fn ctx_expand_range_stops_at_message_boundary_and_continues() {
    let (mut session, client, _, _, settings) = fixture();
    // The token renderer always admits its first merged line, which can
    // contain several consecutive messages from the same role.
    let mut entries = vec![text(1, "one"), text(2, "two"), text(3, "three")];
    for (i, entry) in entries.iter_mut().enumerate() {
        entry.role = Role::User;
        entry.parts[0].body = PartBody::Text {
            text: format!("MESSAGE_{} {} END_{}", i + 1, " hello".repeat(4_700), i + 1).into(),
        };
    }
    let token_only = crate::summary::chunk::build(&entries, 15_000, session.counter()).unwrap();
    assert_eq!(
        token_only.validation.end_index, 3,
        "fixture must hit the byte cap before the token cap"
    );
    *client.entries.lock().unwrap() = entries;
    let answer = session
        .tool(
            &client,
            &settings,
            "ctx_expand",
            &json!({"start":1,"end":3}),
        )
        .await
        .unwrap();
    assert!(
        answer.contains("END_2"),
        "{}",
        &answer[answer.len().saturating_sub(500)..]
    );
    assert!(!answer.contains("MESSAGE_3"));
    assert!(!answer.contains("bytes omitted here"));
    assert!(answer.contains("start=3 end=3"));
    assert_size("ctx_expand range", &answer);
    let rest = session
        .tool(
            &client,
            &settings,
            "ctx_expand",
            &json!({"start":3,"end":3}),
        )
        .await
        .unwrap();
    assert!(rest.contains("MESSAGE_3") && rest.contains("END_3"));
    assert!(!rest.contains("Truncated"));
    assert_size("ctx_expand continued", &rest);
}

#[tokio::test]
async fn ctx_expand_verbose_range_bounds_one_message_with_many_parts() {
    let (mut session, client, _, _, settings) = fixture();
    let mut entry = text(1, "many parts");
    entry.parts = (0..1_000)
        .map(|i| {
            Part::new(
                i.to_string(),
                PartBody::Text {
                    text: "界".repeat(200).into(),
                },
            )
        })
        .collect();
    *client.entries.lock().unwrap() = vec![entry];
    let answer = session
        .tool(
            &client,
            &settings,
            "ctx_expand",
            &json!({"start":1,"end":1,"verbose":true}),
        )
        .await
        .unwrap();
    assert!(answer.contains("bytes omitted here"));
    assert_size("ctx_expand verbose", &answer);
}

#[tokio::test]
async fn ctx_note_largest_targeted_read_and_update_fit_and_leave_storage_whole() {
    let (mut session, client, settings, _dir) = stored_fixture();
    let scope = crate::context_db::NoteScope {
        harness: session.key.harness.clone(),
        session: session.key.session.clone(),
        project: Some("dir:output-test".into()),
    };
    let db = session.db.as_ref().unwrap().clone();
    let content = large();
    let ids: Vec<_> = (0..50)
        .map(|_| db.add_session_note(&scope, &content, Some(1), 1).unwrap())
        .collect();
    for input in [
        json!({"action":"read", "note_ids":ids}),
        json!({"action":"update", "note_ids":[ids[0]], "content":content}),
    ] {
        let answer = session
            .tool(&client, &settings, "ctx_note", &input)
            .await
            .unwrap();
        assert!(answer.contains("bytes omitted here"));
        assert_size("ctx_note", &answer);
    }
    assert_eq!(
        db.note_in_scope(ids[0], &scope).unwrap().unwrap().content,
        content
    );
}

#[tokio::test]
async fn ctx_memory_largest_get_fits_and_leaves_storage_whole() {
    let (mut session, client, settings, _dir) = stored_fixture();
    let db = session.db.as_ref().unwrap().clone();
    let content = large();
    let ids: Vec<_> = db.with_connection(|conn| {
        (0..20)
            .map(|i| {
                crate::memory_writes::save(
                    conn,
                    &crate::memory_writes::Writer {
                        harness: "mock",
                        session: "s1",
                        project: "dir:output-test",
                        authority: None,
                    },
                    "PROJECT_RULES",
                    &format!("{i} {content}"),
                )
                .unwrap()
                .memory_id
                .unwrap()
            })
            .collect()
    });
    let answer = session
        .tool(
            &client,
            &settings,
            "ctx_memory",
            &json!({"action":"get", "ids":ids}),
        )
        .await
        .unwrap();
    assert!(answer.contains("bytes omitted here"));
    assert_size("ctx_memory", &answer);
    db.with_connection(|conn| {
        assert_eq!(
            crate::memory_writes::get_memory(conn, ids[0])
                .unwrap()
                .unwrap()
                .content,
            format!("0 {content}")
        );
    });
}

#[tokio::test]
async fn ctx_search_largest_query_echo_fits() {
    let (mut session, client, settings, _dir) = stored_fixture();
    let scope = crate::context_db::NoteScope {
        harness: session.key.harness.clone(),
        session: session.key.session.clone(),
        project: Some("dir:output-test".into()),
    };
    for i in 0..25 {
        session
            .db
            .as_ref()
            .unwrap()
            .add_session_note(
                &scope,
                &format!("needle {i} {}", "🦀".repeat(1_000)),
                Some(1),
                i,
            )
            .unwrap();
    }
    let ranked = session
        .tool(
            &client,
            &settings,
            "ctx_search",
            &json!({"query":"needle", "sources":["note"], "limit":25}),
        )
        .await
        .unwrap();
    assert!(ranked.starts_with("Found 25 results"), "{ranked}");
    assert_size("ctx_search 25 ranked hits", &ranked);
    let answer = session
        .tool(
            &client,
            &settings,
            "ctx_search",
            &json!({"query":large(), "sources":["note"]}),
        )
        .await
        .unwrap();
    assert!(answer.contains("bytes omitted here"));
    assert!(answer.contains("BEGIN") && answer.contains("END"));
    assert_size("ctx_search", &answer);
}

fn maximal_tags(session: &mut Session) -> String {
    let mut entry = text(1, "framing");
    entry.role = Role::Assistant;
    entry.parts = (0..crate::reduce::MAX_RANGE)
        .map(|i| {
            let mut part = Part::new(
                i.to_string(),
                PartBody::Text {
                    text: String::new().into(),
                },
            );
            part.tag = Some(u64::MAX - i);
            part
        })
        .collect();
    let tags = entry
        .parts
        .iter()
        .map(|part| part.tag.unwrap().to_string())
        .collect::<Vec<_>>()
        .join(",");
    session.index = crate::index::Index::default();
    session.index.extend([entry]);
    session.index_ready = true;
    tags
}

#[tokio::test]
async fn ctx_reduce_largest_skipped_tag_list_fits() {
    let (mut session, client, _, _, settings) = fixture();
    let tags = maximal_tags(&mut session);
    let answer = session
        .tool(&client, &settings, "ctx_reduce", &json!({"drop":tags}))
        .await
        .unwrap();
    assert!(answer.contains("bytes omitted here"));
    assert_size("ctx_reduce", &answer);
}

#[tokio::test]
async fn ctx_keep_largest_tag_list_fits() {
    let (mut session, client, _, _, settings) = fixture();
    let tags = maximal_tags(&mut session);
    let answer = session
        .tool(
            &client,
            &settings,
            "ctx_keep",
            &json!({"tags":tags, "note":large()}),
        )
        .await
        .unwrap();
    assert!(!answer.contains("bytes omitted here"));
    assert_size("ctx_keep", &answer);
    assert_eq!(session.pending_keep.as_ref().unwrap().len(), 1_000);
}

#[tokio::test]
async fn oversized_tool_error_body_is_bounded() {
    let (mut session, client, _, _, settings) = fixture();
    session.index_ready = true;
    let error = session
        .tool(
            &client,
            &settings,
            "ctx_keep",
            &json!({"tags":large(), "note":"next"}),
        )
        .await
        .unwrap_err();
    assert!(error.contains("bytes omitted here"));
    assert_size("tool error", &error);
}
