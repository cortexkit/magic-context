fn processed_image_message(mid: &str, ordinal: u64) -> CkIngressMessage {
    let mut message = item(mid, ordinal, "");
    message.ck.content = vec![CkWireBlock::bare(ck_wire::CkKind::Media(
        ck_wire::MediaBlock {
            kind: ck_wire::MediaKind::Image,
            media_type: "image/png".into(),
            filename: None,
            source: json!({"type": "data_base64", "data": "x".repeat(300)}),
        },
    ))];
    message
}

fn processed_image_plan(
    core: &CoreState,
    request: &TransformRequest,
    tags: &BTreeMap<String, u64>,
    watermark: u64,
    bust: bool,
) -> Vec<FrozenUnit> {
    new_frozen_strip_units(
        core,
        request,
        tags,
        None,
        bust,
        StripSelectionScope {
            reasoning: ReasoningBudgetScope {
                coverage: 0,
                anchor: None,
            },
            image_watermark: watermark,
            image_protected_cutoff: None,
            image_emergency: false,
        },
        &HashSet::new(),
        &crate::edit_admission::EditAdmission::new(&[], false),
    )
}

#[test]
fn processed_images_freeze_provider_marker_and_replay_after_restart() {
    for provider in ["anthropic", "openai", "opencode-zen", "mock"] {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let mut request = req(
            "image-provider",
            "cfg0",
            vec![
                item("head", 0, "older history"),
                processed_image_message("image", 1),
                wire_item("assistant", "answer", 2, &["processed"]),
                item("dropper", 3, "spent"),
            ],
        );
        request.provider_id = Some(provider.into());
        let baseline = run(&s, &request, &spine());
        assert!(baseline
            .messages()
            .iter()
            .any(|m| m.content.iter().any(image_block_is_large)));
        s.seed_tags_for_test(
            &request.session_id,
            &[mc_store::TagMintInput {
                block_id: "dropper#0".into(),
                kind: "message".into(),
                token_count: 1,
                source_bytes: b"spent".to_vec(),
            }],
            0,
        )
        .unwrap();
        request.render_config = "cfg1".into();
        let bust = run(&s, &request, &[reduce("dropper#0", "drop", "")]);
        assert_eq!(bust.action, "HARD");
        let expected = if provider == "anthropic" {
            ""
        } else {
            "[image stripped]"
        };
        assert_eq!(tail_bytes(&bust, "image"), expected);
        let loaded = s.load(&request.session_id).unwrap();
        for key in ["strip:processed_image:image", "red:image#0"] {
            assert_eq!(
                loaded
                    .core
                    .frozen_units
                    .iter()
                    .find(|u| u.key == key)
                    .unwrap()
                    .frozen_payload,
                expected
            );
        }
        drop(s);
        let s = store(dir.path());
        run(&s, &request, &spine());
        let replay = run(&s, &request, &spine());
        assert_eq!(replay.action, "SOFT+");
        assert_eq!(tail_bytes(&replay, "image"), expected);
        // Changing providers must not change the text already served in place of the image.
        request.provider_id = Some(
            if provider == "anthropic" {
                "openai"
            } else {
                "anthropic"
            }
            .into(),
        );
        let switched = run(&s, &request, &spine());
        assert_eq!(tail_bytes(&switched, "image"), expected);
    }
}

#[test]
fn processed_images_discovery_needs_bust_but_legacy_units_replay_on_every_provider() {
    let mut request = req(
        "legacy-image",
        "cfg",
        vec![
            processed_image_message("image", 1),
            wire_item("assistant", "answer", 2, &["processed"]),
        ],
    );
    let tags = BTreeMap::from([("answer".into(), 1)]);
    for provider in [None, Some("anthropic"), Some("openai")] {
        request.provider_id = provider.map(str::to_owned);
        assert!(processed_image_plan(&CoreState::default(), &request, &tags, 1, false).is_empty());
        let mut core = CoreState::default();
        core.frozen_units
            .push(strip_unit("processed_image", "image", ""));
        let projection = project_messages(&request.messages).unwrap();
        let output = build_output(
            &core,
            &ModuleMeta::default(),
            &projection,
            &request,
            None,
            false,
            None,
        )
        .unwrap();
        let image = output
            .iter()
            .find(|m| m.meta.harness_id.as_deref() == Some("image"))
            .unwrap();
        assert_eq!(
            image.content,
            vec![CkWireBlock::bare(ck_wire::CkKind::Text {
                text: String::new()
            })]
        );
    }
}

#[test]
fn processed_images_provider_switch_during_signed_hold_keeps_frozen_bytes() {
    let mut sim = ReviewSession::new(REVIEW_BOUND, true, false, "image-switch-hold");
    sim.messages[2] = processed_image_message("u3", 3);
    sim.run(false).unwrap();
    let mut loaded = sim.s().load(&sim.session).unwrap();
    loaded
        .core
        .frozen_units
        .push(strip_unit("processed_image", "u3", ""));
    sim.s()
        .commit(&sim.session, loaded.row_version, &loaded.core, &loaded.meta)
        .unwrap();
    sim.tool_step();
    let held = sim.run(false).unwrap();
    assert!(review_serves_signature(&held, "think 4"));
    assert!(!held
        .messages()
        .iter()
        .any(|m| m.content.iter().any(image_block_is_large)));
    let mut request = sim.request(false);
    request.provider_id = Some("openai".into());
    let switched = transform(sim.s(), &request, &sim.ctx).unwrap();
    assert_eq!(switched.action, "SOFT+");
    assert_eq!(review_bytes(&held), review_bytes(&switched));
}

fn render_processed_image_plan(
    request: &TransformRequest,
    units: Vec<FrozenUnit>,
) -> Vec<CkWireMessage> {
    let core = CoreState {
        frozen_units: units,
        ..Default::default()
    };
    let projection = project_messages(&request.messages).unwrap();
    build_output(
        &core,
        &ModuleMeta::default(),
        &projection,
        request,
        None,
        false,
        None,
    )
    .unwrap()
}

#[test]
fn processed_images_strip_nested_native_tool_media_without_emptying_results() {
    for provider in ["anthropic", "openai"] {
        for error in [false, true] {
            let data = "x".repeat(300);
            let pi_raw = vec![json!({
                "role": "toolResult", "toolCallId": "call", "toolName": "read", "isError": error,
                "content": [{"type": "image", "mimeType": "image/png", "data": data, "vendor": "image-extra"}]
            })];
            let decoded = crate::codec::pi::decode_pi(&pi_raw);
            let mut request = req("tool-images", "cfg", decoded.messages);
            request
                .messages
                .insert(0, assistant_tool_call("call", 0, "call"));
            request.provider_id = Some(provider.into());
            assert!(request.messages.iter().any(|m| m
                .ck
                .content
                .iter()
                .any(tool_image_block_is_large)));
            assert!(
                processed_image_plan(&CoreState::default(), &request, &BTreeMap::new(), 1, true)
                    .is_empty(),
                "a result needs a later assistant answer"
            );
            request
                .messages
                .push(wire_item("assistant", "answer", 100, &["processed"]));
            let tags = BTreeMap::from([("answer".into(), 1)]);
            let units = processed_image_plan(&CoreState::default(), &request, &tags, 1, true);
            assert!(units
                .iter()
                .any(|u| u.kind == "image" && u.frozen_payload == "[image stripped]"));
            let output = render_processed_image_plan(&request, units);
            let encoded = crate::codec::pi::encode_pi(&output, &decoded.sidecar);
            let result = encoded.iter().find(|m| m["role"] == "toolResult").unwrap();
            assert_eq!(result["isError"], error);
            assert_eq!(
                result["content"],
                json!([{"type": "text", "text": "[image stripped]"}])
            );
            assert!(!serde_json::to_string(&encoded).unwrap().contains(&data));

            let oc_raw = vec![json!({
                "info": {"id": "tool", "role": "assistant"},
                "parts": [{"type": "tool", "callID": "call", "tool": "read", "state": {
                    "status": if error {"error"} else {"completed"}, "input": {},
                    "output": "", "error": "", "attachments": [
                        {"mime": "image/png", "url": format!("data:image/png;base64,{data}")},
                        {"mime": "image/png", "url": "https://example.test/keep.png"},
                        {"mime": "image/png", "url": "data:image/png;base64,small"}
                    ], "time": {"start": 1, "end": 2}
                }}]
            })];
            let decoded = crate::codec::opencode::decode_opencode(&oc_raw);
            let mut request = req("tool-images", "cfg", decoded.messages);
            request.provider_id = Some(provider.into());
            assert!(
                processed_image_plan(&CoreState::default(), &request, &tags, 1, true).is_empty(),
                "the assistant containing the result is not a later answer"
            );
            request
                .messages
                .push(wire_item("assistant", "answer", 100, &["processed"]));
            let units = processed_image_plan(&CoreState::default(), &request, &tags, 1, true);
            assert!(units
                .iter()
                .any(|u| u.key == "strip:processed_tool_image:tool"));
            let output = render_processed_image_plan(&request, units);
            let encoded = crate::codec::opencode::encode_opencode(&output, &decoded.sidecar, None);
            let state = &encoded[0]["parts"][0]["state"];
            assert_eq!(state["status"], if error { "error" } else { "completed" });
            assert!(state[if error { "error" } else { "output" }]
                .as_str()
                .unwrap()
                .contains("[image stripped]"));
            assert_eq!(state["attachments"].as_array().unwrap().len(), 2);
            assert!(!serde_json::to_string(&encoded).unwrap().contains(&data));
        }
    }
}

#[test]
fn processed_images_nested_tool_decisions_persist_and_replay_on_defer() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let decoded = crate::codec::pi::decode_pi(&[json!({
        "role": "toolResult", "toolCallId": "call", "toolName": "read",
        "content": [{"type": "image", "mimeType": "image/png", "data": "x".repeat(300)}]
    })]);
    let mut messages = vec![assistant_tool_call("call", 0, "call")];
    messages.extend(decoded.messages);
    messages.push(wire_item("assistant", "answer", 100, &["processed"]));
    messages.push(item("dropper", 101, "spent"));
    let mut request = req("tool-image-replay", "cfg0", messages);
    request.provider_id = Some("anthropic".into());
    run(&s, &request, &spine());
    s.seed_tags_for_test(
        &request.session_id,
        &[mc_store::TagMintInput {
            block_id: "dropper#0".into(),
            kind: "message".into(),
            token_count: 1,
            source_bytes: b"spent".to_vec(),
        }],
        0,
    )
    .unwrap();
    request.render_config = "cfg1".into();
    let bust = run(&s, &request, &[reduce("dropper#0", "drop", "")]);
    assert_eq!(bust.action, "HARD");
    assert!(s
        .load(&request.session_id)
        .unwrap()
        .core
        .frozen_units
        .iter()
        .any(|u| u.key.starts_with("strip:processed_tool_image:")));
    assert!(!bust
        .messages()
        .iter()
        .any(|m| m.content.iter().any(tool_image_block_is_large)));
    run(&s, &request, &spine());
    let replay = run(&s, &request, &spine());
    assert_eq!(replay.action, "SOFT+");
    assert_eq!(
        serde_json::to_vec(bust.messages()).unwrap(),
        serde_json::to_vec(replay.messages()).unwrap()
    );
}

fn child_processed_image_request() -> TransformRequest {
    let mut request = with_usage(
        req(
            "child-image",
            "cfg",
            vec![
                processed_image_message("image", 1),
                wire_item("assistant", "answer", 2, &["processed"]),
                item("dropper", 3, "spent"),
            ],
        ),
        20,
        100,
    );
    request.is_subagent = true;
    request.provider_id = Some("openai".into());
    request
}

fn seed_child_image_watermark(s: &McStore, request: &TransformRequest) {
    s.seed_tags_for_test(
        &request.session_id,
        &[mc_store::TagMintInput {
            block_id: "dropper#0".into(),
            kind: "message".into(),
            token_count: 1,
            source_bytes: b"spent".to_vec(),
        }],
        0,
    )
    .unwrap();
    let mut loaded = s.load(&request.session_id).unwrap();
    loaded
        .core
        .frozen_units
        .push(red_unit("dropper#0", "drop", ""));
    s.commit(
        &request.session_id,
        loaded.row_version,
        &loaded.core,
        &loaded.meta,
    )
    .unwrap();
}

#[test]
fn processed_images_child_discovers_only_on_admitted_execute_then_replays() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let mut request = child_processed_image_request();
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    transform(&s, &request, &ctx).unwrap();
    seed_child_image_watermark(&s, &request);
    let defer = transform(&s, &request, &ctx).unwrap();
    assert_eq!(defer.action, "SOFT+");
    assert!(defer
        .messages()
        .iter()
        .any(|m| m.content.iter().any(image_block_is_large)));
    assert!(!s
        .load(&request.session_id)
        .unwrap()
        .core
        .frozen_units
        .iter()
        .any(|u| u.key == "strip:processed_image:image"));
    request = with_usage(request, 70, 100);
    let execute = transform(&s, &request, &ctx).unwrap();
    assert_eq!(execute.scheduler_decision.as_deref(), Some("execute"));
    assert_eq!(execute.action, "SOFT");
    assert_eq!(tail_bytes(&execute, "image"), "[image stripped]");
    assert!(s
        .load(&request.session_id)
        .unwrap()
        .core
        .frozen_units
        .iter()
        .any(|u| u.key == "strip:processed_image:image"));
    request = with_usage(request, 20, 100);
    let replay = transform(&s, &request, &ctx).unwrap();
    assert_eq!(replay.action, "SOFT+");
    assert_eq!(
        serde_json::to_vec(execute.messages()).unwrap(),
        serde_json::to_vec(replay.messages()).unwrap()
    );
}

#[test]
fn processed_images_child_replays_inherited_frozen_images_without_execute_or_watermark() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let request = child_processed_image_request();
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    transform(&s, &request, &ctx).unwrap();
    let mut loaded = s.load(&request.session_id).unwrap();
    loaded
        .core
        .frozen_units
        .push(strip_unit("processed_image", "image", ""));
    s.commit(
        &request.session_id,
        loaded.row_version,
        &loaded.core,
        &loaded.meta,
    )
    .unwrap();
    let inherited = transform(&s, &request, &ctx).unwrap();
    assert_eq!(inherited.action, "SOFT+");
    assert_eq!(tail_bytes(&inherited, "image"), "");
    assert_eq!(
        serde_json::to_vec(inherited.messages()).unwrap(),
        serde_json::to_vec(transform(&s, &request, &ctx).unwrap().messages()).unwrap()
    );
}

fn processed_image_policy(
    own: Option<u64>,
    next: Option<u64>,
    watermark: u64,
    cutoff: Option<u64>,
    emergency: bool,
) -> bool {
    let message = processed_image_message("image", 1);
    let tags = own
        .map(|tag| BTreeMap::from([("image".into(), tag)]))
        .unwrap_or_default();
    processed_image_eligible(
        &message,
        &tags,
        next,
        true,
        &HashSet::new(),
        StripSelectionScope {
            reasoning: ReasoningBudgetScope::default(),
            image_watermark: watermark,
            image_protected_cutoff: cutoff,
            image_emergency: emergency,
        },
    )
}

#[test]
fn processed_images_position_tag_uses_own_then_next_positive_never_zero() {
    assert!(
        processed_image_policy(Some(2), Some(20), 2, None, false),
        "own tag wins over a later tag"
    );
    assert!(!processed_image_policy(Some(20), Some(2), 2, None, false));
    assert!(processed_image_policy(None, Some(2), 2, None, false));
    assert!(
        !processed_image_policy(Some(0), Some(20), 2, None, false),
        "zero is not a positive own tag"
    );
    assert!(
        !processed_image_policy(None, None, 100, None, false),
        "no own or later tag is ineligible"
    );
    let request = req(
        "image-position",
        "cfg",
        vec![
            item("preceding", 0, "older"),
            processed_image_message("image", 1),
            wire_item("assistant", "untagged-answer", 2, &["processed"]),
            item("nearest", 3, "near"),
            item("farther", 4, "far"),
        ],
    );
    let tags = BTreeMap::from([
        ("preceding".into(), 1),
        ("untagged-answer".into(), 0),
        ("nearest".into(), 20),
        ("farther".into(), 2),
    ]);
    assert!(
        processed_image_plan(&CoreState::default(), &request, &tags, 2, true).is_empty(),
        "first later positive message, not preceding or farther tag"
    );
    let tags = BTreeMap::from([("preceding".into(), 1)]);
    assert!(
        processed_image_plan(&CoreState::default(), &request, &tags, 100, true).is_empty(),
        "no preceding-tag fallback"
    );
}

#[test]
fn processed_images_age_gate_requires_positive_dropped_watermark() {
    assert!(!processed_image_policy(Some(10), None, 0, None, false));
    assert!(!processed_image_policy(Some(10), None, 9, None, false));
    assert!(
        processed_image_policy(Some(10), None, 10, None, false),
        "watermark equality is old enough"
    );
    assert!(processed_image_policy(Some(10), None, 11, None, false));
}

#[test]
fn processed_images_protected_newest_window_includes_cutoff_below_95() {
    assert!(processed_image_policy(Some(9), None, 100, Some(10), false));
    assert!(
        !processed_image_policy(Some(10), None, 100, Some(10), false),
        "cutoff tie is protected"
    );
    assert!(!processed_image_policy(
        Some(11),
        None,
        100,
        Some(10),
        false
    ));
    assert!(
        processed_image_policy(Some(11), None, 100, None, false),
        "absent cutoff does not protect all images"
    );
}

#[test]
fn processed_images_emergency_waives_only_protected_window() {
    assert!(processed_image_policy(Some(10), None, 10, Some(10), true));
    assert!(
        !processed_image_policy(Some(10), None, 9, Some(10), true),
        "age still applies"
    );
    assert!(
        !processed_image_policy(Some(10), None, 0, Some(10), true),
        "positive watermark still required"
    );
    assert!(
        !processed_image_policy(None, None, 100, Some(10), true),
        "position still required"
    );
    let message = processed_image_message("image", 1);
    let tags = BTreeMap::from([("image".into(), 10)]);
    let scope = StripSelectionScope {
        reasoning: ReasoningBudgetScope::default(),
        image_watermark: 10,
        image_protected_cutoff: Some(10),
        image_emergency: true,
    };
    assert!(
        !processed_image_eligible(&message, &tags, None, false, &HashSet::new(), scope),
        "later assistant still required"
    );
    assert!(
        !processed_image_eligible(
            &message,
            &tags,
            None,
            true,
            &HashSet::from(["image#0".into()]),
            scope
        ),
        "retained signed thinking still protects its prefix"
    );
    let request = req(
        "emergency-image",
        "cfg",
        vec![
            message.clone(),
            wire_item("assistant", "answer", 2, &["processed"]),
        ],
    );
    assert!(
        new_frozen_strip_units(
            &CoreState::default(),
            &request,
            &tags,
            None,
            false,
            scope,
            &HashSet::new(),
            &crate::edit_admission::EditAdmission::new(&[], false),
        )
        .is_empty(),
        "emergency does not authorize an unadmitted bust"
    );
    for synthetic in [false, true] {
        let mut excluded = message.clone();
        if synthetic {
            excluded.ck.meta.synthetic = true;
        } else {
            excluded.mid.clear();
        }
        let request = req(
            "emergency-image",
            "cfg",
            vec![
                excluded,
                wire_item("assistant", "answer", 2, &["processed"]),
            ],
        );
        assert!(new_frozen_strip_units(
            &CoreState::default(),
            &request,
            &tags,
            None,
            true,
            scope,
            &HashSet::new(),
            &crate::edit_admission::EditAdmission::new(&[], false),
        )
        .is_empty());
    }
}

#[test]
fn processed_images_window_cutoff_and_emergency_are_wired_to_transform() {
    for percent in [86, 95] {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let mut image = processed_image_message("image", 2);
        image
            .ck
            .content
            .push(CkWireBlock::bare(ck_wire::CkKind::Text {
                text: "look".into(),
            }));
        let mut request = req(
            "image-window",
            "cfg0",
            vec![
                assistant_tool_call("call", 0, "call"),
                tool_result("tool", 1, "call", "output"),
                image,
                wire_item("assistant", "answer", 3, &["processed"]),
                item("dropper", 4, "spent"),
            ],
        );
        request.provider_id = Some("openai".into());
        run(&s, &request, &spine());
        s.seed_tags_for_test(
            &request.session_id,
            &[
                mc_store::TagMintInput {
                    block_id: "tool#0".into(),
                    kind: "tool_result".into(),
                    token_count: 100,
                    source_bytes: b"output".to_vec(),
                },
                mc_store::TagMintInput {
                    block_id: "image#1".into(),
                    kind: "message".into(),
                    token_count: 1,
                    source_bytes: b"look".to_vec(),
                },
                mc_store::TagMintInput {
                    block_id: "dropper#0".into(),
                    kind: "message".into(),
                    token_count: 1,
                    source_bytes: b"spent".to_vec(),
                },
            ],
            0,
        )
        .unwrap();
        let mut loaded = s.load(&request.session_id).unwrap();
        loaded
            .core
            .frozen_units
            .push(red_unit("dropper#0", "drop", ""));
        s.commit(
            &request.session_id,
            loaded.row_version,
            &loaded.core,
            &loaded.meta,
        )
        .unwrap();
        request.render_config = "cfg1".into();
        request = with_usage(request, percent, 100);
        let response = run(&s, &request, &spine());
        assert_eq!(
            response
                .messages()
                .iter()
                .any(|m| m.content.iter().any(image_block_is_large)),
            percent < 95
        );
        assert_eq!(
            s.load(&request.session_id)
                .unwrap()
                .core
                .frozen_units
                .iter()
                .any(|u| u.key == "strip:processed_image:image"),
            percent >= 95
        );
    }
}
