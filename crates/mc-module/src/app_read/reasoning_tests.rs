use super::*;
use cortexkit_role_compaction::{part::Seal, read::StepUsage, tokens::ReasoningTokens};

fn reasoning(id: &str, bytes: Option<u64>) -> Part {
    Part::new(
        id,
        PartBody::Reasoning {
            text: None,
            text_bytes: bytes,
        },
    )
}

fn assistant(ordinal: u64, parts: Vec<Part>) -> Entry {
    Entry::new(
        ordinal,
        format!("m{ordinal}"),
        Role::Assistant,
        ordinal,
        parts,
    )
}

fn part_tokens(snapshot: &Snapshot, name: &str) -> u64 {
    snapshot.breakdown["parts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|part| part["part"] == name)
        .unwrap_or_else(|| panic!("missing breakdown part {name}"))["tokens"]
        .as_u64()
        .unwrap()
}

fn items(snapshot: &Snapshot, mid: &str) -> Vec<Value> {
    snapshot.messages[mid].row["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["kind"] == "reasoning")
        .cloned()
        .collect()
}

#[test]
fn app_read_breakdown_labels_follow_count_sources() {
    let mut session = session();
    let mut measured = assistant(201, vec![reasoning("r", Some(4))]);
    measured.reasoning_tokens = Some(ReasoningTokens::new(9_000, true));
    session.index.extend_counted([measured], Some("claude-v5/1"));
    let snapshot = session.app_snapshot();
    let estimate = |snapshot: &Snapshot, name: &str| snapshot.breakdown["parts"].as_array().unwrap().iter().find(|part| part["part"] == name).unwrap()["estimate"].clone();
    assert_eq!(estimate(&snapshot, "history_raw"), false);
    assert_eq!(estimate(&snapshot, "reasoning"), false);
    assert_eq!(snapshot.breakdown["estimation_source"], "runner");
    assert!(session.app_update().rows.is_empty());

    session.index.extend([assistant(202, vec![reasoning("estimated", Some(80))])]);
    let mixed = session.app_snapshot();
    assert_eq!(estimate(&mixed, "reasoning"), true);
    assert_eq!(mixed.breakdown["estimation_source"], "runner");
    session.index.extend([assistant(202, vec![reasoning("estimated", Some(36_000))])]);
    let tied = session.app_snapshot();
    assert_eq!(tied.breakdown["estimation_source"], "estimate");
    session.index.truncate(202);
    let restored = session.app_snapshot();
    assert_eq!(estimate(&restored, "reasoning"), false);
    assert_eq!(restored.breakdown["estimation_source"], "runner");
}

#[test]
fn app_read_reasoning_runner_counts_are_separate_and_update_only_the_changed_entry() {
    let mut session = session();
    let before = session.app_snapshot();
    let raw = part_tokens(&before, "history_raw");
    let mut entry = assistant(
        201,
        vec![
            reasoning("a", Some(4)),
            reasoning("b", Some(8)),
            Part::new(
                "text",
                PartBody::Text {
                    text: "reply".into(),
                },
            ),
        ],
    );
    entry.usage = Some(StepUsage::default().with_reasoning_tokens(900));
    entry.reasoning_tokens = Some(ReasoningTokens::new(101, true));
    session
        .index
        .extend_counted([entry.clone()], Some("claude-v5/1"));
    session.conditions.last_prompt_tokens = Some(raw + 103);
    let snapshot = session.app_snapshot();
    assert_eq!(part_tokens(&snapshot, "reasoning"), 101);
    assert_eq!(snapshot.breakdown["unattributed"], 0);
    assert_eq!(snapshot.breakdown["total"]["source"], "provider");
    assert_eq!(part_tokens(&snapshot, "history_raw"), raw + 2);
    // The old raw estimate included one and two tokens of visible reasoning.
    assert_eq!(raw + 5 - part_tokens(&snapshot, "history_raw"), 3);
    assert_eq!(items(&snapshot, "m201"), json!([
        {"part_ref":{"part_key":"a"},"kind":"reasoning","tokens":33,"source":"runner","state":"live"},
        {"part_ref":{"part_key":"b"},"kind":"reasoning","tokens":68,"source":"runner","state":"live"}
    ]).as_array().unwrap().clone());
    let names: Vec<_> = snapshot.breakdown["parts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|part| part["part"].as_str().unwrap())
        .collect();
    assert_eq!(
        &names[7..],
        ["tool_calls_results", "reasoning", "last_user_message", "user_messages", "notices"]
    );
    assert!(session.app_update().rows.is_empty());
    entry.reasoning_tokens = Some(ReasoningTokens::new(103, false));
    session
        .index
        .extend_counted([entry.clone()], Some("claude-v5/1"));
    let changed = session.app_update();
    assert_eq!(changed.rows.len(), 1);
    assert_eq!(changed.rows[0].0, "m201");
    assert_eq!(session.app_projection.rebuilt_rows, 1);
    assert_eq!(changed.rows[0].1.row["items"][0]["tokens"], 34);
    assert_eq!(changed.rows[0].1.row["items"][1]["tokens"], 69);
    assert_eq!(changed.header.breakdown["parts"][8]["tokens"], 103);
    // A runner's zero is authoritative even when the step reports reasoning.
    entry.reasoning_tokens = Some(ReasoningTokens::new(0, true));
    session.index.extend_counted([entry], Some("claude-v5/1"));
    assert_eq!(part_tokens(&session.app_snapshot(), "reasoning"), 0);

    let mut late = assistant(202, vec![reasoning("late", Some(12))]);
    late.usage = Some(StepUsage::default().with_reasoning_tokens(77));
    session
        .index
        .extend_counted([late.clone()], Some("claude-v5/1"));
    assert_eq!(
        items(&session.app_snapshot(), "m202")[0]["source"],
        "reported"
    );
    late.reasoning_tokens = Some(ReasoningTokens::new(77, true));
    session.index.extend_counted([late], Some("claude-v5/1"));
    let changed = session.app_update();
    assert_eq!(changed.rows.len(), 1);
    assert_eq!(changed.rows[0].1.row["items"][0]["source"], "runner");
    assert!(session.app_update().rows.is_empty());
}

#[test]
fn app_read_reasoning_without_counts_matches_clearing_fallbacks() {
    let mut session = session();
    let mut reported = assistant(201, vec![reasoning("a", Some(4)), reasoning("b", Some(8))]);
    reported.usage = Some(StepUsage::default().with_reasoning_tokens(101));
    let mut visible = assistant(202, vec![reasoning("a", Some(5)), reasoning("b", Some(7))]);
    visible.usage = Some(StepUsage::default().with_reasoning_tokens(0));
    let opaque = assistant(
        203,
        ["first", "second", "last"]
            .into_iter()
            .map(|id| {
                let mut part = reasoning(id, None);
                part.seal = Seal::Encrypted;
                part
            })
            .collect(),
    );
    let empty = assistant(204, vec![reasoning("empty", Some(0))]);
    session.index.extend([reported, visible, opaque, empty]);
    let snapshot = session.app_snapshot();
    assert_eq!(part_tokens(&snapshot, "reasoning"), 1_105);
    for (mid, weights, source) in [
        ("m201", vec![33, 68], "reported"),
        ("m202", vec![1, 3], "estimate"),
        ("m203", vec![333, 333, 334], "estimate"),
        ("m204", vec![0], "estimate"),
    ] {
        let attributed = items(&snapshot, mid);
        assert_eq!(
            attributed
                .iter()
                .map(|item| item["tokens"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            weights
        );
        assert!(attributed.iter().all(|item| item["source"] == source));
    }
}

#[test]
fn app_read_reasoning_drops_and_applied_summary_cuts_cost_zero() {
    let mut session = session();
    let raw = part_tokens(&session.app_snapshot(), "history_raw");
    let mut entry = assistant(201, vec![reasoning("a", Some(4)), reasoning("b", Some(8))]);
    entry.reasoning_tokens = Some(ReasoningTokens::new(101, true));
    session.index.extend_counted([entry], Some("claude-v5/1"));
    session.app_update();
    session.summaries.push(StoredCompartment {
        sequence: 1,
        start_message: 201,
        end_message: 201,
        start_message_id: "m201".into(),
        end_message_id: "m201".into(),
        ..Default::default()
    });
    session.app_projection.summaries_dirty = true;
    assert_eq!(
        part_tokens(&session.app_snapshot(), "reasoning"),
        101,
        "published history is not removed until the served cut moves"
    );
    let view = session.seal_unchecked(vec![EditOp::Drop {
        mid: "m201".into(),
        part: Some("b".into()),
    }]);
    session.accept(view.clone());
    session.settle_unconfirmed(Some(&AppliedView::new(view.version, view.checksum)), &[]);
    let snapshot = session.app_snapshot();
    assert_eq!(part_tokens(&snapshot, "reasoning"), 33);
    assert_eq!(items(&snapshot, "m201")[0]["tokens"], 33);
    assert_eq!(items(&snapshot, "m201")[1]["tokens"], 0);
    let view = session.seal_unchecked(vec![
        EditOp::Replace {
            mid: "m201".into(),
            part: "a".into(),
            field: "text".into(),
            value: json!("[cleared]"),
            expect: session.index.at(201).unwrap().parts[0].digest.clone(),
        },
        EditOp::Drop {
            mid: "m201".into(),
            part: Some("b".into()),
        },
    ]);
    session.accept(view.clone());
    assert_eq!(part_tokens(&session.app_snapshot(), "reasoning"), 33);
    session.settle_unconfirmed(Some(&AppliedView::new(view.version, view.checksum)), &[]);
    let snapshot = session.app_snapshot();
    assert_eq!(part_tokens(&snapshot, "reasoning"), 0);
    assert_eq!(part_tokens(&snapshot, "history_raw"), raw);
    for item in items(&snapshot, "m201") {
        assert_eq!(item["tokens"], 0);
        assert_eq!(item["state"], "dropped");
    }
    session.latest = None;
    session.cut = Some(201);
    let snapshot = session.app_snapshot();
    assert_eq!(part_tokens(&snapshot, "reasoning"), 0);
    assert_eq!(part_tokens(&snapshot, "history_raw"), 0);
    assert!(items(&snapshot, "m201")
        .iter()
        .all(|item| item["tokens"] == 0));
    assert_eq!(snapshot.compartments[0]["last_message_id"], "m201");
    session.cut = None;
    assert_eq!(part_tokens(&session.app_snapshot(), "reasoning"), 101);
    session.index.truncate(201);
    assert_eq!(part_tokens(&session.app_snapshot(), "reasoning"), 0);
}
