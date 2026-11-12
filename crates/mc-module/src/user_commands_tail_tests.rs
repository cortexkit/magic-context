use super::*;

pub(super) fn ready_with_recent_tail() -> (Session, Client, Settings) {
    let (mut session, client, settings) = ready();
    let entries = (3..=5).map(|tag| {
        let id = format!("tool-{tag}");
        let mut part: Part = serde_json::from_value(json!({
            "id": "p", "kind": "tool", "call_id": id, "name": "read",
            "input": {"path": id}, "status": "completed",
            "output": "recent output ".repeat(40), "digest": ""
        }))
        .unwrap();
        part.tag = Some(tag);
        Entry::new(tag, id, Role::Assistant, tag, vec![part])
    });
    session.index.extend(entries);
    session.index.extend(vec![text(6, "next prompt")]);
    session.queued.insert(("tool-3".into(), "p".into()));
    session.queued.insert(("tool-5".into(), "p".into()));
    (session, client, settings)
}

fn assert_status(status: &wire::Preview, queued: f64, tokens: f64, held: f64) {
    let facts = status.facts.as_ref().unwrap();
    assert_eq!(facts.len(), 4);
    assert_eq!(facts[2].label, "Queued drops");
    assert_eq!(facts[2].data.value, Some(queued));
    let rows = &status.table.as_ref().unwrap().rows;
    let value = |label| &rows.iter().find(|row| row.label == label).unwrap().cells[0];
    assert_eq!(value("Queued tokens").value, Some(tokens));
    let held_value = value("Held in recent tail");
    assert_eq!(held_value.value, Some(held));
    assert_eq!(held_value.unit.as_deref(), Some("count"));
    assert_eq!(held_value.noun.as_deref(), Some("parts"));
}

#[tokio::test]
async fn user_commands_queue_only_in_recent_tail_reports_held_without_mutating() {
    for protected_tokens in [Some(0), None] {
        let (mut session, client, mut settings) = ready_with_recent_tail();
        settings.protected_tokens = protected_tokens;
        session.queued.remove(&("old".into(), "p".into()));
        let before = serde_json::to_vec(&session.durable()).unwrap();
        let flush = preview(&mut session, &client, &settings, "flush").await;
        assert!(!flush.available);
        assert_eq!(flush.reason.as_deref(), Some("queued_in_recent_tail"));
        let status = preview(&mut session, &client, &settings, "status").await;
        assert_status(&status, 0.0, 0.0, 2.0);
        assert_eq!(serde_json::to_vec(&session.durable()).unwrap(), before);
        assert!(client.reads.lock().unwrap().is_empty());
        assert!(client.offered.lock().unwrap().is_empty());

        session.queued.insert(("tool-4".into(), "p".into()));
        let changed = preview(&mut session, &client, &settings, "flush").await;
        assert_eq!(changed.reason, flush.reason);
        assert_ne!(changed.version, flush.version);
        let request = wire::ModuleRunRequest::new(
            preview_request(&session, "flush"),
            flush.version,
            "held-queue-changed",
        );
        assert_eq!(
            session
                .command_run(&client, &settings, &request)
                .await
                .unwrap()
                .outcome,
            "preview_stale"
        );
        assert!(client.offered.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn user_commands_queue_across_recent_tail_counts_and_lands_only_older_parts() {
    let (mut session, client, settings) = ready_with_recent_tail();
    let before = serde_json::to_vec(&session.durable()).unwrap();
    let status = preview(&mut session, &client, &settings, "status").await;
    // The old text is 4,800 ASCII bytes: its queued price is 1,200 tokens,
    // while the two recent tool outputs contribute only to the held count.
    assert_status(&status, 1.0, 1200.0, 2.0);
    let flush = preview(&mut session, &client, &settings, "flush").await;
    assert!(flush.available, "{flush:?}");
    let facts = flush.facts.as_ref().unwrap();
    assert_eq!(facts[0].data.value, Some(1.0));
    assert_eq!(facts[1].data.value, Some(1194.0));
    assert_eq!(serde_json::to_vec(&session.durable()).unwrap(), before);

    let request = wire::ModuleRunRequest::new(
        preview_request(&session, "flush"),
        flush.version,
        "mixed-tail",
    );
    let answer = session
        .command_run(&client, &settings, &request)
        .await
        .unwrap();
    assert_eq!(answer.outcome, "scheduled");
    assert_eq!(answer.facts.unwrap()[0].data.value, Some(1.0));
    assert_eq!(
        session.queued,
        BTreeSet::from([("tool-3".into(), "p".into()), ("tool-5".into(), "p".into())])
    );
    {
        let offers = client.offered.lock().unwrap();
        assert_eq!(offers.len(), 1);
        assert_eq!(offers[0].edits.len(), 1);
        assert!(matches!(&offers[0].edits[0].op,
            EditOp::Replace { mid, part, value, .. }
            if mid == "old" && part == "p" && value == "[dropped §1§]"));
    }
    let status = preview(&mut session, &client, &settings, "status").await;
    assert_status(&status, 0.0, 0.0, 2.0);
    let flush = preview(&mut session, &client, &settings, "flush").await;
    assert_eq!(flush.reason.as_deref(), Some("queued_in_recent_tail"));
}
