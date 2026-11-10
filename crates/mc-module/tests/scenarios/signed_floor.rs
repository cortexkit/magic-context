//! A tool-set change on a route whose signed reasoning is bound to the
//! request prefix: the runner records its signed floor at the newest entry
//! and strips every signed reasoning part at or before it. ck-mc takes the
//! floor from the next conditions and stops treating that reasoning as sent.

use super::*;

/// A read with no reasoning, whose result is about 5,000 tokens.
fn plain_read() -> Step {
    Step::Model(Turn {
        text: Some("Reading the next file.".into()),
        tools: vec![ToolCall::ok(
            "read",
            json!({"path": "b.rs"}),
            "y".repeat(20_000),
        )],
        output_tokens: 20,
        ..Turn::default()
    })
}

#[tokio::test]
async fn a_tool_change_on_a_bound_route_lets_the_next_view_land_without_touching_stripped_reasoning(
) {
    // Three heavy reads (2,000 reasoning tokens each, more than the 1,500
    // that make a step heavy) and a queued drop of the first read's result.
    // Then the tool set changes: the runner strips all three reasoning
    // parts from the next request on. The plain read brings the sixth
    // reading to about 68% of the usable window, over the 65% threshold and
    // under the hold's 75% cap. The heavy reasoning of the turn is all at or
    // before the floor, so there is nothing for the hold to protect: that
    // execute pass lands the drop, and the eighth request is the first under
    // a view.
    let mut runner = start(config("worker", Kind::Anthropic, bound())).await;
    runner
        .play(&[
            user("Review the module."),
            read_file(2_000),
            reduce("3"),
            read_file(2_000),
            read_file(2_000),
            Step::ChangeTools,
            answer(),
            plain_read(),
            answer(),
            answer(),
        ])
        .await;
    // The mock model rejects kept thinking signed under the old tool list,
    // and the runner refuses views it can't apply: neither happened.
    assert_clean(&runner);
    let floor = runner
        .host()
        .signed_floor()
        .expect("the runner set a floor");
    let entries = runner.host().entries();
    let floor_at = entries
        .iter()
        .position(|entry| entry.mid == floor)
        .expect("the floor names an entry");
    // The floor is at the third read, the newest entry at the change.
    assert_eq!(
        entries[floor_at]
            .parts
            .iter()
            .filter(|part| matches!(part.body, PartBody::Reasoning { .. }))
            .count(),
        1
    );
    assert_eq!(reasoning_seen(runner.host()), (0, 3));

    let requests = &runner.report.requests;
    let first_under_view = requests.iter().position(|record| record.view.is_some());
    assert_eq!(first_under_view, Some(7), "{requests:?}");
    assert_eq!(
        seen(runner.host(), 3).as_deref(),
        Some(placeholder(3).as_str())
    );

    // The view drops the queued result and nothing the runner strips: an
    // edit before the floor invalidates no reasoning at or before it.
    let view = runner
        .host()
        .applied_view()
        .view
        .expect("ck-mc's view applies");
    let stripped: Vec<(&str, &str)> = entries[..=floor_at]
        .iter()
        .flat_map(|entry| {
            entry
                .parts
                .iter()
                .filter(|part| matches!(part.body, PartBody::Reasoning { .. }))
                .map(move |part| (entry.mid.as_str(), part.id.as_str()))
        })
        .collect();
    assert_eq!(stripped.len(), 3);
    for edit in &view.edits {
        if let cortexkit_role_compaction::view::EditOp::Drop {
            mid,
            part: Some(part),
        } = &edit.op
        {
            assert!(
                !stripped.contains(&(mid.as_str(), part.as_str())),
                "the view drops stripped reasoning {mid}/{part}"
            );
        }
    }
}
