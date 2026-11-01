fn stale_reduce_minting_fixture(role: &str) -> TransformRequest {
    let reduce = |mid: &str, ordinal| {
        let mut message = if role == "user" {
            wire_tool_result(
                mid,
                ordinal,
                json!({"kind":{"type":"text","text":"queued"}}),
            )
        } else {
            wire_tool_call(mid, ordinal, &format!("call-{mid}"))
        };
        match &mut message.ck.content[0].kind {
            ck_wire::CkKind::ToolCall { name, .. } => *name = "ctx_reduce".into(),
            ck_wire::CkKind::ToolResult { tool_name, .. } => *tool_name = "ctx_reduce".into(),
            _ => unreachable!(),
        }
        message.ck.content.insert(
            0,
            CkWireBlock::bare(ck_wire::CkKind::Text {
                text: "note".into(),
            }),
        );
        message
    };
    let mut messages = vec![
        reduce("before", 1),
        item("boundary", 2, "kept"),
        reduce("tail", 3),
    ];
    messages.extend((0..45).map(|n| item(&format!("later-{n}"), n + 4, "later work")));
    let mut request = opencode_req("stale-reduce", "cfg", messages);
    request.provider_id = Some("anthropic".into());
    request.model_key = Some("claude-opus-5-5".into());
    request
}

fn stale_reduce_minting_keys(
    request: &TransformRequest,
    held: bool,
    core: &CoreState,
) -> Vec<String> {
    use crate::edit_admission::{EditAdmission, Message, Part};
    // Supply a signed boundary separately from the request so the older target-protection
    // walk cannot reject the candidate first. This isolates admission when saving a removal.
    let admission = EditAdmission::new(
        &[
            Message {
                id: Some("boundary".into()),
                real_user: !held,
                parts: vec![Part {
                    retained: held,
                    anchor: Some("signed".into()),
                }],
            },
            Message {
                id: Some("tail".into()),
                real_user: false,
                parts: vec![],
            },
        ],
        true,
    );
    new_frozen_strip_units(
        core,
        request,
        &BTreeMap::new(),
        None,
        true,
        StripSelectionScope {
            reasoning: ReasoningBudgetScope::default(),
            image_watermark: 0,
            image_protected_cutoff: None,
            image_emergency: false,
        },
        &HashSet::new(),
        &admission,
    )
    .into_iter()
    .filter(|u| u.key.starts_with("strip:stale_reduce:"))
    .map(|u| u.key)
    .collect()
}

#[test]
fn stale_reduce_admission_holds_assistant_unit_minting() {
    assert_stale_reduce_minting("assistant");
}

#[test]
fn stale_reduce_admission_holds_user_result_unit_minting() {
    assert_stale_reduce_minting("user");
}

fn assert_stale_reduce_minting(role: &str) {
    let request = stale_reduce_minting_fixture(role);
    let mut core = CoreState::default();
    assert_eq!(
        stale_reduce_minting_keys(&request, true, &core),
        vec!["strip:stale_reduce:tail"]
    );
    core.frozen_units
        .push(strip_unit("stale_reduce", "tail", ""));
    assert!(
        stale_reduce_minting_keys(&request, true, &core).is_empty(),
        "a repeat never freezes the held id"
    );
    assert_eq!(
        stale_reduce_minting_keys(&request, false, &core),
        vec!["strip:stale_reduce:before"],
        "the next permitted bust discovers held work"
    );
    core.frozen_units
        .push(strip_unit("stale_reduce", "before", ""));
    assert!(
        stale_reduce_minting_keys(&request, true, &core).is_empty(),
        "frozen units remain replay-only"
    );
}
