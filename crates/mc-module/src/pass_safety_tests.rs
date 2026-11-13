use super::*;
use cortexkit_role_compaction::tokens::PartTokens;
use cortexkit_role_compaction::view::{Edit, InsertAt, InsertedMessage};

fn emergency_floor_session(kind: &str) -> (Session, Settings) {
    let (mut session, _, _, _, settings) = fixture();
    session.conditions.output_reserve = 0;
    session.conditions.last_prompt_tokens = Some(90_000);
    let mut task = text(1, "task");
    task.parts[0].tokens = Some(PartTokens::count(2_000));
    let mut large: Part = serde_json::from_value(serde_json::json!({
        "id":"p", "kind":kind, "text":"old assistant text", "text_bytes":200_000,
        "call_id":"c2", "name":"bash", "input":{}, "status":"completed",
        "output":"result", "output_bytes":200_000, "digest":""
    }))
    .unwrap();
    large.tag = Some(2);
    large.tokens = Some(if kind == "tool" {
        PartTokens::tool(0, 50_000)
    } else {
        PartTokens::count(50_000)
    });
    let mut entries = vec![
        task,
        Entry::new(2, "large", Role::Assistant, 2, vec![large]),
    ];
    for tag in 3..=8 {
        let mut part: Part = serde_json::from_value(serde_json::json!({
            "id":"p", "kind":"tool", "call_id":format!("c{tag}"),
            "name":"bash", "input":{}, "status":"completed", "output":"result",
            "output_bytes":if tag <= 5 { 20_000 } else { 4_000 }, "digest":""
        }))
        .unwrap();
        part.tag = Some(tag);
        part.tokens = Some(PartTokens::tool(0, if tag <= 5 { 5_000 } else { 1_000 }));
        entries.push(Entry::new(
            tag,
            format!("tool-{tag}"),
            Role::Assistant,
            tag,
            vec![part],
        ));
    }
    if kind == "reasoning" {
        // The newest reasoning stays exempt; the large older block can go.
        entries.last_mut().unwrap().parts.push(
            serde_json::from_value(serde_json::json!({
                "id":"new-thinking", "kind":"reasoning", "text_bytes":4, "digest":""
            }))
            .unwrap(),
        );
    }
    session.index.extend_counted(entries, Some("family"));
    session.index_ready = true;
    (session, settings)
}

fn emergency_floor_outputs(view: &View) -> Vec<&str> {
    view.edits
        .iter()
        .filter_map(|edit| match &edit.op {
            EditOp::Replace { mid, field, .. } if field == "output" && mid != "large" => {
                Some(mid.as_str())
            }
            _ => None,
        })
        .collect()
}

fn emergency_floor_build(session: &mut Session, settings: &Settings) -> View {
    let logs = crate::test_log::capture();
    session
        .build(settings, None, false, None)
        .0
        .unwrap_or_else(|| panic!("floor fixture built no view: {}", logs.text()))
}

#[test]
fn emergency_floor_a_large_queued_tool_drop_still_leaves_work_for_emergency() {
    let (mut session, settings) = emergency_floor_session("tool");
    session.queued.insert(("large".into(), "p".into()));
    let view = emergency_floor_build(&mut session, &settings);
    // The 90k request holds 70k of transcript and 20k of fixed overhead.
    // After the queued 50k drop, 40k remains: still above the 33.5k target.
    // Treating the queued output as fixed overhead would instead skip all
    // emergency work because that false 70k floor exceeds the 65k ceiling.
    assert!(view.edits.iter().any(|edit| matches!(&edit.op,
        EditOp::Replace { mid, field, value, .. }
            if mid == "large" && field == "output" && value == "[dropped §2§]"
    )));
    assert_eq!(emergency_floor_outputs(&view), ["tool-3", "tool-4"]);
    assert!(session.next_latch);
}

#[test]
fn emergency_floor_credits_queued_text_before_taking_more_tools() {
    let (mut session, settings) = emergency_floor_session("text");
    session.queued.insert(("large".into(), "p".into()));
    let view = emergency_floor_build(&mut session, &settings);
    assert!(view.edits.iter().any(|edit| matches!(&edit.op,
        EditOp::Replace { mid, field, value, .. }
            if mid == "large" && field == "text" && value == "[dropped §2§]"
    )));
    assert_eq!(emergency_floor_outputs(&view), ["tool-3", "tool-4"]);
}

#[test]
fn emergency_floor_credits_queued_reasoning_removal() {
    let (mut session, mut settings) = emergency_floor_session("reasoning");
    settings.keep_reasoning_tokens = 100_000;
    session.queued.insert(("large".into(), "p".into()));
    let view = emergency_floor_build(&mut session, &settings);
    assert!(view.edits.iter().any(|edit| matches!(&edit.op,
        EditOp::Drop { mid, part: Some(part) } if mid == "large" && part == "p"
    )));
    assert_eq!(emergency_floor_outputs(&view), ["tool-3", "tool-4"]);
}

#[test]
fn emergency_floor_does_not_credit_images_a_previous_view_already_stripped() {
    use cortexkit_role_compaction::part::{Attachment, AttachmentItem, FileMedia};
    use cortexkit_role_compaction::view::Edit;

    let (mut session, settings) = emergency_floor_session("tool");
    let mut entries = session.index.entries().to_vec();
    let PartBody::Tool(tool) = &mut entries[1].parts[0].body else {
        unreachable!()
    };
    tool.output_bytes = Some(40_000);
    tool.set_attachments(
        (0..40)
            .map(|n| {
                Attachment::new(
                    format!("image-{n}"),
                    AttachmentItem::File(FileMedia::inline("image/png", Some(100))),
                )
            })
            .collect(),
    );
    session.index = Index::default();
    session.index.extend_counted(entries, Some("family"));
    session.version = 1;
    session.latest = Some(View::seal(
        1,
        vec![Edit::new(
            1,
            EditOp::Replace {
                mid: "large".into(),
                part: "p".into(),
                field: "attachments".into(),
                value: serde_json::json!([]),
                expect: "".into(),
            },
        )],
    ));
    session.queued.insert(("large".into(), "p".into()));
    let view = emergency_floor_build(&mut session, &settings);
    // The old view already removed 40k of images from the tool's 50k count.
    // Queuing its remaining 10k output cannot take credit for those images.
    // With 60k fixed overhead, the 61.5k target still needs all three outputs.
    assert_eq!(
        emergency_floor_outputs(&view),
        ["tool-3", "tool-4", "tool-5"]
    );
}

#[test]
fn emergency_floor_does_not_credit_standalone_reasoning_cleanup() {
    let (mut session, mut settings) = emergency_floor_session("reasoning");
    settings.keep_reasoning_tokens = 0;
    let view = emergency_floor_build(&mut session, &settings);
    assert!(view.edits.iter().any(|edit| matches!(&edit.op,
        EditOp::Drop { mid, part: Some(part) } if mid == "large" && part == "p"
    )));
    // The plugin plans before its separate reasoning-budget cleanup, so that
    // lane does not reduce the emergency gap even when ck-mc selects it first.
    assert_eq!(
        emergency_floor_outputs(&view),
        ["tool-3", "tool-4", "tool-5"]
    );
}

#[test]
fn emergency_floor_a_new_history_cut_does_not_make_removed_text_fixed() {
    let (mut session, settings) = emergency_floor_session("text");
    let dir = tempfile::tempdir().unwrap();
    with_summary(&mut session, dir.path(), "large");
    let view = emergency_floor_build(&mut session, &settings);
    assert!(view.edits.iter().any(|edit| matches!(&edit.op,
        EditOp::Cut { through } if through == "large"
    )));
    // The cut removes 52k of text, leaving about 38k including the rendered summary.
    // One 5k output reaches the target; a false floor would take none.
    assert_eq!(emergency_floor_outputs(&view), ["tool-3"]);
}

fn emergency_floor_history(through: Option<&str>, summary: &str) -> Vec<EditOp> {
    let mut ops: Vec<_> = [(head::M0_ID, "baseline"), (head::M1_ID, summary)]
        .into_iter()
        .map(|(id, text)| EditOp::Insert {
            at: InsertAt::Start,
            message: InsertedMessage::new(id, Role::User, vec![text.to_owned()]),
        })
        .collect();
    if let Some(through) = through {
        ops.push(EditOp::Cut {
            through: through.into(),
        });
    }
    ops
}

#[test]
fn emergency_floor_an_unchanged_cut_and_head_get_no_credit() {
    let (mut session, _) = emergency_floor_session("text");
    let old_summary = "previous summary ".repeat(20);
    session.latest = Some(View::seal(
        1,
        emergency_floor_history(None, &old_summary)
            .into_iter()
            .map(|op| Edit::new(1, op))
            .collect(),
    ));
    let history = emergency_floor_history(Some("large"), "new summary");
    assert_eq!(
        session.emergency_removed_tokens(&history, &[]),
        52_000 + session.counter().count(&old_summary) - session.counter().count("new summary")
    );
    session.latest = Some(View::seal(
        2,
        history.iter().cloned().map(|op| Edit::new(2, op)).collect(),
    ));
    assert_eq!(session.emergency_removed_tokens(&history, &[]), 0);
    let smaller_head = emergency_floor_history(Some("large"), "");
    assert_eq!(session.emergency_removed_tokens(&smaller_head, &[]), 0);
    let queued = [EditOp::Drop {
        mid: "tool-3".into(),
        part: Some("p".into()),
    }];
    assert_eq!(
        session.emergency_removed_tokens(&smaller_head, &queued),
        5_000
    );
}

#[test]
fn emergency_floor_a_summary_larger_than_its_cut_gets_no_negative_credit() {
    let (session, _) = emergency_floor_session("text");
    let history = emergency_floor_history(Some("large"), "summary");
    let head_tokens = session.counter().count("baseline") + session.counter().count("summary");
    assert_eq!(
        session.emergency_removed_tokens(&history, &[]),
        52_000 - head_tokens
    );
    let large_summary = "summary ".repeat(60_000);
    assert!(session.counter().count(&large_summary) > 52_000);
    let history = emergency_floor_history(Some("large"), &large_summary);
    assert_eq!(session.emergency_removed_tokens(&history, &[]), 0);
}

#[test]
fn emergency_floor_credits_queued_drops_and_a_new_cut_together() {
    let (mut session, settings) = emergency_floor_session("text");
    let history = emergency_floor_history(Some("large"), "summary");
    let head_tokens = session.counter().count("baseline") + session.counter().count("summary");
    let queued = [EditOp::Drop {
        mid: "tool-3".into(),
        part: Some("p".into()),
    }];
    assert_eq!(
        session.emergency_removed_tokens(&history, &queued),
        57_000 - head_tokens
    );
    let dir = tempfile::tempdir().unwrap();
    with_summary(&mut session, dir.path(), "large");
    session.queued.insert(("tool-3".into(), "p".into()));
    let view = emergency_floor_build(&mut session, &settings);
    assert_eq!(emergency_floor_outputs(&view), ["tool-3"]);
    assert!(
        !session.next_latch,
        "the queued drop already reaches the target"
    );
}

#[test]
fn emergency_floor_a_cut_and_queued_tool_drop_credit_the_input_once() {
    let (mut session, _) = emergency_floor_session("tool");
    let mut entries = session.index.entries().to_vec();
    entries[1].parts[0].tokens = Some(PartTokens::tool(10_000, 50_000));
    session.index = Index::default();
    session.index.extend_counted(entries, Some("family"));
    let history = emergency_floor_history(Some("large"), "summary");
    let head_tokens = session.counter().count("baseline") + session.counter().count("summary");
    // The cut removes the whole task and tool message, including the result.
    assert_eq!(
        session.emergency_removed_tokens(&history, &[]),
        62_000 - head_tokens
    );
    let queued = [EditOp::Drop {
        mid: "large".into(),
        part: Some("p".into()),
    }];
    assert_eq!(
        session.emergency_removed_tokens(&history, &queued),
        62_000 - head_tokens
    );
}

#[test]
fn emergency_floor_a_cut_and_queued_text_drop_credit_the_text_once() {
    let (session, _) = emergency_floor_session("text");
    let history = emergency_floor_history(Some("large"), "summary");
    let head_tokens = session.counter().count("baseline") + session.counter().count("summary");
    let queued = [EditOp::Drop {
        mid: "large".into(),
        part: Some("p".into()),
    }];
    assert_eq!(
        session.emergency_removed_tokens(&history, &queued),
        52_000 - head_tokens
    );
}

#[test]
fn an_accepted_lane_or_history_rewrite_rearms_an_emergency_episode_without_a_batch() {
    for history in [false, true] {
        let (mut session, _, _, _, settings) = fixture();
        // Three calls leave no emergency candidate outside the protected tail.
        // The large task keeps the fixed prompt cost below the reclaim target.
        let mut task = text(1, "task");
        task.parts[0].body = PartBody::Text {
            text: "task ".repeat(20_000).into(),
        };
        session.index.extend([
            task,
            text(2, "old-text"),
            Entry::new(3, "tool-3", Role::Assistant, 3, vec![output_part("p", 3)]),
            Entry::new(4, "tool-4", Role::Assistant, 4, vec![output_part("p", 4)]),
            Entry::new(5, "tool-5", Role::Assistant, 5, vec![output_part("p", 5)]),
        ]);
        session.index_ready = true;
        session.conditions.last_prompt_tokens = Some(90_000);
        session.emergency_latched = true;
        let label = if history {
            "history head"
        } else {
            "queued drop"
        };

        assert!(session.build(&settings, None, false, None).0.is_none());
        assert!(
            session.emergency_latched,
            "an unchanged pass rearmed {label}"
        );
        if history {
            session.features.summarizer = true;
        } else {
            session.queued.insert(("old-text".into(), "p".into()));
        }
        let view = session
            .build(&settings, None, false, None)
            .0
            .expect("the independent rewrite has work to land");
        assert!(
            view.edits.iter().any(|edit| match &edit.op {
                EditOp::Insert { message, .. } => history && message.id == head::M0_ID,
                EditOp::Replace { mid, .. } => !history && mid == "old-text",
                _ => false,
            }),
            "the {label} rewrite is missing: {view:?}"
        );
        assert!(!session.next_latch, "the protected calls formed a batch");
        assert!(
            session.emergency_latched,
            "building {label} rearmed before acceptance"
        );
        session.accept(view);
        assert!(
            !session.emergency_latched,
            "accepting {label} did not rearm"
        );

        // A fourth call releases the oldest call from the protected tail.
        // No other lane has work, so only the rearmed emergency lane can take it.
        session.index.extend([Entry::new(
            6,
            "tool-6",
            Role::Assistant,
            6,
            vec![output_part("p", 6)],
        )]);
        let view = session
            .build(&settings, None, false, None)
            .0
            .unwrap_or_else(|| panic!("the {label} rewrite left the emergency lane spent"));
        assert!(
            view.edits.iter().any(|edit| matches!(&edit.op,
                EditOp::Replace { mid, field, value, .. }
                    if mid == "tool-3" && field == "output" && value == "[dropped §3§]"
            )),
            "no emergency drop after {label}: {view:?}"
        );
        session.accept(view);
        assert!(
            session.emergency_latched,
            "the new batch did not spend {label}"
        );
    }
}

#[test]
fn a_view_failing_the_pre_publish_check_logs_the_refusal_reason() {
    let (mut session, client, _, _, _) = fixture();
    session.index.extend([text(1, "final-message")]);
    session.index_ready = true;
    let key = ("final-message".into(), "p".into());
    session.queued.insert(key.clone());
    let output = crate::test_log::capture();

    // Bypass lane selection to model a lane bug: removing the final message
    // is forbidden by the same pre-publish check the runner uses.
    let view = session.seal(
        vec![EditOp::Drop {
            mid: key.0.clone(),
            part: Some(key.1.clone()),
        }],
        std::slice::from_ref(&key),
    );
    assert!(view.is_none(), "the invalid view escaped validation");
    assert!(session.latest.is_none());
    assert!(client.offered.lock().unwrap().is_empty());
    assert!(!session.queued.contains(&key));
    assert!(session.failed_parts.contains(&key));
    let logs = output.text();
    assert!(
        logs.lines().any(|line| {
            line.contains("WARN")
                && line.contains("ck-mc: session s1: no valid view:")
                && line.contains("FinalTurnRemoved")
        }),
        "the validation warning omitted the refusal reason: {logs}"
    );
}
