#[test]
fn todo_admission_holds_replacement_clear_and_captured_state_then_releases() {
    use crate::edit_admission::{EditAdmission, Message, Part};
    let old_state =
        json!([{"content":"Inspect parser","status":"pending","priority":"high"}]).to_string();
    let new_state =
        json!([{"content":"Repair parser","status":"pending","priority":"high"}]).to_string();
    let done_state = json!([{"content":"Done","status":"completed","priority":"high"}]).to_string();
    let native = vec![
        json!({"info":{"id":"old","role":"assistant"},"parts":[{"type":"text","text":"History"}]}),
        json!({"info":{"id":"boundary","role":"assistant"},"parts":[{"type":"reasoning","text":"Kept","metadata":{"anthropic":{"signature":"signed"}}}]}),
        json!({"info":{"id":"tail","role":"assistant"},"parts":[{"type":"text","text":"Tail"}]}),
    ];
    let mut req = active_opencode_req(
        "todo-admission",
        "cfg",
        crate::codec::decode_opencode(&native).messages,
    );
    req.todo_tool_present = Some(true);
    let frame = EditAdmission::new(
        &[
            Message {
                id: Some("boundary".into()),
                real_user: false,
                parts: vec![Part {
                    retained: true,
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
    let release = EditAdmission::new(&[], true);
    let mut persisted = ModuleMeta {
        last_todo_state: Some(old_state),
        ..ModuleMeta::default()
    };
    let seed = persisted.clone();
    advance_synthetic_todo(&mut persisted, true, None, false, &req, &release, &seed).unwrap();
    persisted.synthetic_todo.as_mut().unwrap().anchor_mid = Some("old".into());
    for (state, available) in [
        (new_state.clone(), true),
        (done_state, true),
        (new_state, false),
    ] {
        let mut meta = persisted.clone();
        meta.last_todo_state = Some(state.clone());
        meta.last_todo_state_hash = Some("captured".into());
        meta.last_todo_state_owner_message_id = Some("tail".into());
        req.todo_tool_present = Some(available);
        advance_synthetic_todo(&mut meta, true, None, false, &req, &frame, &persisted).unwrap();
        assert_eq!(meta.synthetic_todo, persisted.synthetic_todo);
        assert_eq!(meta.last_todo_state, persisted.last_todo_state);
        assert_eq!(meta.last_todo_state_hash, persisted.last_todo_state_hash);
        assert_eq!(
            meta.last_todo_state_owner_message_id,
            persisted.last_todo_state_owner_message_id
        );
        advance_synthetic_todo(&mut meta, false, None, false, &req, &frame, &persisted).unwrap();
        assert_eq!(meta.synthetic_todo, persisted.synthetic_todo);
        meta.last_todo_state = Some(state);
        advance_synthetic_todo(&mut meta, true, None, false, &req, &release, &persisted).unwrap();
        assert_ne!(meta.synthetic_todo, persisted.synthetic_todo);
    }
}

#[test]
fn todo_admission_prices_both_anchors_and_missing_anchor_clears() {
    use crate::edit_admission::{EditAdmission, Message, Part};
    let frame = EditAdmission::new(
        &[
            Message {
                id: Some("boundary".into()),
                real_user: false,
                parts: vec![Part {
                    retained: true,
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
    let meta = ModuleMeta {
        last_todo_state: Some(
            json!([{"content":"Work","status":"pending","priority":"high"}]).to_string(),
        ),
        ..ModuleMeta::default()
    };
    let InjectionOutcome::Replace(pair) =
        advance_injection_from_meta(&meta, None, true, Some(true))
    else {
        panic!("active todo must render")
    };
    let tail = (*pair).clone().freeze_at(Some("tail".into()));
    let boundary = (*pair).clone().freeze_at(Some("boundary".into()));
    let missing = (*pair).freeze_at(Some("missing".into()));
    assert!(admit_todo_change(&frame, None, Some(&boundary)));
    assert!(admit_todo_change(&frame, Some(&tail), None));
    assert!(admit_todo_change(&frame, Some(&tail), Some(&boundary)));
    assert!(!admit_todo_change(&frame, Some(&boundary), Some(&tail)));
    assert!(!admit_todo_change(&frame, Some(&missing), None));
    assert!(!admit_todo_change(&frame, Some(&missing), Some(&tail)));
}
