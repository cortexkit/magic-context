use super::*;

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
