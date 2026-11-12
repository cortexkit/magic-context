use super::*;

fn operations(view: &View) -> Vec<&EditOp> {
    view.edits.iter().map(|edit| &edit.op).collect()
}

#[tokio::test]
async fn user_commands_preview_survives_append_notice_and_new_size_reading() {
    let (mut session, client, settings) = ready();
    session.index_ready = true;
    session.view_anchor = true;
    let p = preview(&mut session, &client, &settings, "flush").await;
    assert!(p.available, "{p:?}");
    let expected = session
        .clone()
        .build_for(&settings, None, false, None, true)
        .0
        .unwrap();
    assert_eq!(expected.built_through.as_deref(), Some("new prompt"));
    assert!(matches!(&expected.edits[0].op,
        EditOp::Replace { mid, part, value, .. }
        if mid == "old" && part == "p" && value == "[dropped §1§]"));

    let appended = vec![text(3, "agent continued"), text(4, "latest message")];
    let mut request = notice(&session, 1, appended.last().map(cursor));
    request.entries = appended;
    request.conditions.last_prompt_tokens = Some(12_000);
    session.notice(&client, &settings, request).await;
    assert_eq!(session.seq, 1);
    assert_eq!(session.index.cursor().unwrap().mid, "latest message");
    assert_eq!(session.conditions.last_prompt_tokens, Some(12_000));
    assert!(client.offered.lock().unwrap().is_empty());
    assert_eq!(session.queued.len(), 1);

    let replanned = session
        .clone()
        .build_for(&settings, None, false, None, true)
        .0
        .unwrap();
    assert_eq!(operations(&expected), operations(&replanned));
    assert_eq!(replanned.built_through.as_deref(), Some("latest message"));
    assert_ne!(expected.checksum, replanned.checksum);

    let request = wire::ModuleRunRequest::new(
        preview_request(&session, "flush"),
        p.version,
        "append-and-size",
    );
    let answer = session
        .command_run(&client, &settings, &request)
        .await
        .unwrap();
    assert_eq!(answer.outcome, "scheduled");
    assert_eq!(answer.facts.unwrap()[2].data.value, Some(10_806.0));
    assert!(session.queued.is_empty());
    let offers = client.offered.lock().unwrap();
    assert_eq!(offers.len(), 1);
    assert_eq!(operations(&offers[0]), operations(&expected));
    assert_eq!(offers[0].built_through, replanned.built_through);
}

#[tokio::test]
async fn user_commands_preview_stales_when_queued_drop_leaves_recent_tail() {
    use cortexkit_role_compaction::part::{ToolPart, ToolStatus};

    let tool = |tag| {
        let id = format!("tool-{tag}");
        let mut part = Part::new(
            "p",
            PartBody::Tool(
                ToolPart::new(&id, "read", json!({"path": &id}), ToolStatus::Completed)
                    .with_output("recent output ".repeat(40)),
            ),
        );
        part.tag = Some(tag);
        Entry::new(tag, id, Role::Assistant, tag, vec![part])
    };
    let (mut session, client, settings) = ready();
    // The three newest tool calls protect the text between them too. One
    // more tool call releases that text without adding anything to the queue.
    session.index.extend(vec![
        tool(3),
        text(4, "tail-text"),
        tool(5),
        tool(6),
        text(7, "next prompt"),
    ]);
    session.queued.insert(("tail-text".into(), "p".into()));
    session.index_ready = true;
    let p = preview(&mut session, &client, &settings, "flush").await;
    assert!(p.available, "{p:?}");
    assert_eq!(p.facts.as_ref().unwrap()[0].data.value, Some(1.0));
    let queue = session.queued.clone();

    let appended = vec![tool(8), text(9, "latest prompt")];
    let mut request = notice(&session, 1, appended.last().map(cursor));
    request.entries = appended;
    session.notice(&client, &settings, request).await;
    assert_eq!(session.seq, 1);
    assert_eq!(session.queued, queue);
    assert!(client.offered.lock().unwrap().is_empty());
    let changed = preview(&mut session, &client, &settings, "flush").await;
    assert!(changed.available, "{changed:?}");
    assert_eq!(changed.facts.as_ref().unwrap()[0].data.value, Some(2.0));

    let request =
        wire::ModuleRunRequest::new(preview_request(&session, "flush"), p.version, "tail-moved");
    let answer = session
        .command_run(&client, &settings, &request)
        .await
        .unwrap();
    assert_eq!(answer.outcome, "preview_stale");
    assert_eq!(session.queued, queue);
    assert!(client.offered.lock().unwrap().is_empty());
}
