// These witnesses use isolated stores and native codec projections. They do not
// contact a provider; equality here concerns served request bytes, not cache billing.
fn independent_native_request(
    pi: bool,
    mut request: TransformRequest,
) -> (TransformRequest, crate::codec::DecodeSidecar) {
    let messages: Vec<_> = request.messages.iter().map(|m| m.ck.clone()).collect();
    let raw = if pi {
        crate::codec::encode_pi(&messages, &crate::codec::DecodeSidecar::new("pi"))
    } else {
        crate::codec::encode_opencode_with_session(
            &messages,
            &crate::codec::DecodeSidecar::new("opencode"),
            Some(&request.session_id),
            None,
        )
    };
    let decoded = if pi {
        crate::codec::decode_pi(&raw)
    } else {
        crate::codec::decode_opencode(&raw)
    };
    request.messages = decoded.messages;
    request.serializer_profile = if pi {
        SerializerProfile::Pi
    } else {
        SerializerProfile::OpencodeAiSdk
    }
    .wire_id()
    .into();
    request.serve_native = !pi;
    request.native_messages = (!pi).then_some(raw);
    (request, decoded.sidecar)
}

fn independent_run(
    s: &McStore,
    request: &TransformRequest,
    decisions: &[ReductionDecision],
) -> TransformResponse {
    let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
    ctx.injected_reductions = decisions.to_vec();
    let result = transform_with_projection(s, request, &ctx).unwrap();
    let native = if request.serve_native {
        Some(crate::encode_full_native_messages(
            &result.response,
            request,
            &result.reasoning_clear_units,
            &result.tag_numbers,
            result.mutation_exempt_mid.as_deref(),
            result.lineage_anchor_mid.as_deref(),
            result.transition_consumed,
        ))
    } else {
        None
    };
    let mut response = result.response;
    response.native_messages = native.map(|messages| messages.into_iter().map(Arc::new).collect());
    response
}

fn independent_native_bytes(
    pi: bool,
    response: &TransformResponse,
    sidecar: &crate::codec::DecodeSidecar,
) -> Vec<u8> {
    if pi {
        let messages: Vec<_> = response
            .messages()
            .iter()
            .map(|m| m.deref().clone())
            .collect();
        serde_json::to_vec(&crate::codec::encode_pi(&messages, sidecar)).unwrap()
    } else {
        serde_json::to_vec(
            response
                .native_messages
                .as_ref()
                .expect("native OpenCode output"),
        )
        .unwrap()
    }
}

fn independent_image(large: bool) -> CkWireBlock {
    CkWireBlock::bare(ck_wire::CkKind::Media(ck_wire::MediaBlock {
        kind: ck_wire::MediaKind::Image,
        media_type: "image/png".into(),
        filename: Some("review.png".into()),
        source: json!({"type": "data_base64", "data": if large { "I".repeat(307) } else { "s".repeat(37) }}),
    }))
}

#[test]
fn independent_images_randomized_codec_corpus() {
    let mut captures = Vec::new();
    let mut actions = BTreeMap::<String, usize>::new();
    let mut reopens = 0;
    let mut image_rewrites = [0, 0];
    for pi in [false, true] {
        for seed in [0x1234_u64, 0x5678, 0x9abc] {
            // Lanes 0/1 have no images on Anthropic/OpenAI respectively. Lane 2
            // retains small/remote Anthropic images; lane 3 strips eligible old
            // Anthropic images, exercising the pre-existing empty-marker contract.
            for lane in 0..4 {
                let dir = tempfile::tempdir().unwrap();
                let mut s = store(dir.path());
                let mut rng = ReviewRng(seed);
                let mut messages = vec![
                    item("head", 1, "original prompt"),
                    item("old", 2, "inspect the small icon"),
                    wire_item("assistant", "answer", 3, &["answer"]),
                    item("dropper", 4, "spent text"),
                ];
                if lane == 2 {
                    messages[1].ck.content.push(independent_image(false));
                    let mut remote = independent_image(true);
                    if let ck_wire::CkKind::Media(media) = &mut remote.kind {
                        media.source =
                            json!({"type": "url", "url": "https://example.test/icon.png"});
                    }
                    messages[1].ck.content.push(remote);
                }
                if lane == 3 {
                    messages[1].ck.content.push(independent_image(true));
                }
                let mut config = 0;
                let mut ordinal = 4;
                let mut seeded = false;
                for pass in 0..48 {
                    let event = rng.below(8);
                    if pass > 0 && event <= 2 {
                        ordinal += 1;
                        messages.push(item(
                            &format!("u{ordinal}"),
                            ordinal,
                            &format!("question {}", rng.below(10_000)),
                        ));
                        ordinal += 1;
                        messages.push(wire_item(
                            "assistant",
                            &format!("a{ordinal}"),
                            ordinal,
                            &[&format!("reply {}", rng.below(10_000))],
                        ));
                    }
                    if event == 3 || event == 6 {
                        config += 1;
                    }
                    if event == 4 {
                        drop(s);
                        s = store(dir.path());
                        reopens += 1;
                    }
                    let mut request = with_usage(
                        req(
                            "independent-corpus",
                            &format!("cfg{config}"),
                            messages.clone(),
                        ),
                        20 + rng.below(77),
                        100,
                    );
                    request.provider_id =
                        Some(if lane == 1 { "openai" } else { "anthropic" }.into());
                    request.model_key = Some("anthropic/claude-opus-4-5".into());
                    let (request, sidecar) = independent_native_request(pi, request);
                    if seeded && event == 5 {
                        review_edit_meta(&s, &request.session_id, |meta| {
                            meta.soft_refresh_pending = true
                        });
                    }
                    let decisions = if seeded && event == 6 {
                        vec![reduce(
                            &format!("{}#0", request.messages[3].mid),
                            "drop",
                            "[spent]",
                        )]
                    } else {
                        spine()
                    };
                    let response = independent_run(&s, &request, &decisions);
                    assert_eq!(response.status, TransformStatus::Ok);
                    *actions.entry(response.action.clone()).or_default() += 1;
                    let bytes = independent_native_bytes(pi, &response, &sidecar);
                    if lane == 2 {
                        assert!(
                            String::from_utf8_lossy(&bytes).contains(&"s".repeat(37)),
                            "small image must remain native"
                        );
                    }
                    if lane == 3 {
                        let native: Vec<Value> = serde_json::from_slice(&bytes).unwrap();
                        let decoded = if pi {
                            crate::codec::decode_pi(&native)
                        } else {
                            crate::codec::decode_opencode(&native)
                        };
                        if !decoded
                            .messages
                            .iter()
                            .any(|m| m.ck.content.iter().any(image_block_is_large))
                        {
                            image_rewrites[usize::from(pi)] += 1;
                        }
                    }
                    captures.push(bytes);
                    if !seeded {
                        s.seed_tags_for_test(
                            &request.session_id,
                            &[
                                mc_store::TagMintInput {
                                    block_id: format!("{}#0", request.messages[1].mid),
                                    kind: "message".into(),
                                    token_count: 3,
                                    source_bytes: b"inspect the small icon".to_vec(),
                                },
                                mc_store::TagMintInput {
                                    block_id: format!("{}#0", request.messages[3].mid),
                                    kind: "message".into(),
                                    token_count: 2,
                                    source_bytes: b"spent text".to_vec(),
                                },
                            ],
                            0,
                        )
                        .unwrap();
                        seeded = true;
                    }
                }
            }
        }
    }
    let bytes = serde_json::to_vec(&captures).unwrap();
    let digest = crate::digest::hex(&Sha256::digest(&bytes));
    println!("independent corpus: {} snapshots, {} bytes, SHA256 {digest}; actions {actions:?}; {reopens} reopens", captures.len(), bytes.len());
    println!("old image omissions per codec: {image_rewrites:?}");
    assert_eq!(captures.len(), 1152);
    assert!(
        image_rewrites.into_iter().all(|count| count > 0),
        "both codecs must actually serve old image omissions"
    );
    for action in ["HARD", "SOFT", "SOFT+"] {
        assert!(actions.get(action).copied().unwrap_or(0) > 0);
    }
    if let Ok(path) = std::env::var("MC_IMAGE_REVIEW_CAPTURE") {
        std::fs::write(path, &bytes).unwrap();
    }
    // The digest covers every native request array in pass order. It was
    // recorded with the pre-image-change transform (6dec81e7); matching it
    // rejects byte drift in sessions outside the newly requested behavior.
    assert_eq!(
        digest,
        "03644ff7057ef686a4541145963133f851b5ad5ecb1620af2cd7d063a5982a16"
    );
}

fn independent_seed_watermark(s: &McStore, request: &TransformRequest) {
    let answer = &request.messages[request.messages.len() - 2];
    let dropper = request.messages.last().unwrap();
    s.seed_tags_for_test(
        &request.session_id,
        &[
            mc_store::TagMintInput {
                block_id: format!("{}#0", answer.mid),
                kind: "message".into(),
                token_count: 2,
                source_bytes: b"processed".to_vec(),
            },
            mc_store::TagMintInput {
                block_id: format!("{}#0", dropper.mid),
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
        .push(red_unit(&format!("{}#0", dropper.mid), "drop", "[spent]"));
    s.commit(
        &request.session_id,
        loaded.row_version,
        &loaded.core,
        &loaded.meta,
    )
    .unwrap();
}

#[test]
fn independent_images_defer_restart_and_bidirectional_provider_replay() {
    for pi in [false, true] {
        for provider in ["anthropic", "openai"] {
            for kind in ["direct", "tool", "child"] {
                let dir = tempfile::tempdir().unwrap();
                let mut s = store(dir.path());
                let mut image = item("image", 1, "");
                image.ck.content = vec![independent_image(true)];
                let messages = if kind == "tool" {
                    let decoded = crate::codec::decode_pi(&[
                        json!({"role": "toolResult", "toolCallId": "call", "toolName": "read", "content": [{"type": "image", "mimeType": "image/png", "data": "I".repeat(307)}]}),
                    ]);
                    let mut messages = vec![assistant_tool_call("call", 0, "call")];
                    messages.extend(decoded.messages);
                    messages
                } else {
                    vec![item("head", 0, "older history"), image]
                };
                let mut request = with_usage(req("independent-replay", "cfg0", messages), 20, 100);
                request
                    .messages
                    .push(wire_item("assistant", "answer", 2, &["processed"]));
                request.messages.push(item("dropper", 3, "spent"));
                request.provider_id = Some(provider.into());
                request.is_subagent = kind == "child";
                let (mut request, sidecar) = independent_native_request(pi, request);
                independent_run(&s, &request, &spine());
                independent_seed_watermark(&s, &request);
                let defer = independent_run(&s, &request, &spine());
                assert_eq!(defer.action, "SOFT+", "{pi}/{provider}/{kind}");
                assert!(
                    String::from_utf8_lossy(&independent_native_bytes(pi, &defer, &sidecar))
                        .contains(&"I".repeat(307))
                );
                assert!(
                    !s.load(&request.session_id)
                        .unwrap()
                        .core
                        .frozen_units
                        .iter()
                        .any(|u| u.kind.contains("image")),
                    "defer minted an image decision"
                );
                if kind == "child" {
                    request = with_usage(request, 70, 100);
                } else {
                    request.render_config = "cfg1".into();
                }
                let execute = independent_run(&s, &request, &spine());
                assert_ne!(execute.action, "SOFT+");
                let frozen = s.load(&request.session_id).unwrap().core.frozen_units;
                assert!(
                    frozen.iter().any(|u| u.kind.contains("image")),
                    "non-vacuity: admission froze images"
                );
                let marker = if kind != "tool" && provider == "anthropic" {
                    ""
                } else {
                    "[image stripped]"
                };
                for unit in frozen.iter().filter(|u| u.kind.contains("image")) {
                    assert_eq!(unit.frozen_payload, marker);
                }
                let bytes = independent_native_bytes(pi, &execute, &sidecar);
                let native: Vec<Value> = serde_json::from_slice(&bytes).unwrap();
                let decoded = if pi {
                    crate::codec::decode_pi(&native)
                } else {
                    crate::codec::decode_opencode(&native)
                };
                assert!(
                    !decoded.messages.iter().any(|m| m
                        .ck
                        .content
                        .iter()
                        .any(|b| image_block_is_large(b) || tool_image_block_is_large(b))),
                    "native image kind survived {pi}/{provider}/{kind}"
                );
                if kind == "tool" {
                    assert!(
                        !String::from_utf8_lossy(&bytes).contains(&"I".repeat(307)),
                        "tool payload survived native encode"
                    );
                }
                request = with_usage(request, 20, 100);
                independent_run(&s, &request, &spine());
                let stable = independent_run(&s, &request, &spine());
                assert_eq!(stable.action, "SOFT+");
                assert_eq!(independent_native_bytes(pi, &stable, &sidecar), bytes);
                drop(s);
                s = store(dir.path());
                let restarted = independent_run(&s, &request, &spine());
                assert_eq!(restarted.action, "SOFT+");
                assert_eq!(independent_native_bytes(pi, &restarted, &sidecar), bytes);
                request.provider_id = Some(
                    if provider == "anthropic" {
                        "openai"
                    } else {
                        "anthropic"
                    }
                    .into(),
                );
                let switched = independent_run(&s, &request, &spine());
                assert_eq!(
                    independent_native_bytes(pi, &switched, &sidecar),
                    bytes,
                    "switch {pi}/{provider}/{kind}"
                );
                for unit in frozen.iter().filter(|u| u.kind.contains("image")) {
                    assert!(s
                        .load(&request.session_id)
                        .unwrap()
                        .core
                        .frozen_units
                        .contains(unit));
                }
            }
        }
    }
}

#[test]
fn independent_images_signed_prefix_has_no_tool_image_or_child_gap() {
    for child in [false, true] {
        for tool in [false, true] {
            let mut sim =
                ReviewSession::new(REVIEW_BOUND, true, child, "independent-signed-images");
            if tool {
                sim.tool_step();
                let last = sim.messages.last_mut().unwrap();
                let decoded = crate::codec::decode_pi(&[
                    json!({"role": "toolResult", "toolCallId": "t4", "toolName": "read", "content": [{"type": "image", "mimeType": "image/png", "data": "I".repeat(307)}]}),
                ]);
                last.ck.content = decoded.messages[0].ck.content.clone();
            } else {
                sim.messages[2].ck.content = vec![independent_image(true)];
            }
            sim.run(false).unwrap();
            sim.tool_step();
            let reasoning_mid = sim.messages[sim.messages.len() - 2].mid.clone();
            let held = sim.run(false).unwrap();
            assert!(held.messages().iter().any(|m| m
                .content
                .iter()
                .any(|b| image_block_is_large(b) || tool_image_block_is_large(b))));
            let signature = if tool { "think 6" } else { "think 4" };
            assert!(review_serves_signature(&held, signature));
            sim.s()
                .seed_tags_for_test(
                    &sim.session,
                    &[
                        mc_store::TagMintInput {
                            block_id: format!("{reasoning_mid}#1"),
                            kind: "message".into(),
                            token_count: 3,
                            source_bytes: b"note".to_vec(),
                        },
                        mc_store::TagMintInput {
                            block_id: "u1#0".into(),
                            kind: "message".into(),
                            token_count: 3,
                            source_bytes: b"earlier task".to_vec(),
                        },
                    ],
                    0,
                )
                .unwrap();
            let mut loaded = sim.s().load(&sim.session).unwrap();
            loaded
                .core
                .frozen_units
                .push(red_unit("u1#0", "drop", "[dropped]"));
            sim.s()
                .commit(&sim.session, loaded.row_version, &loaded.core, &loaded.meta)
                .unwrap();
            sim.used = 86_000;
            let response = sim.run(false).unwrap();
            assert_eq!(response.scheduler_decision.as_deref(), Some("execute"));
            assert!(
                review_serves_signature(&response, signature),
                "fixture must actually retain the signature"
            );
            assert!(
                response.messages().iter().any(|m| m
                    .content
                    .iter()
                    .any(|b| image_block_is_large(b) || tool_image_block_is_large(b))),
                "child={child} tool={tool}: edited image before retained signature"
            );
            assert!(
                !sim.s()
                    .load(&sim.session)
                    .unwrap()
                    .core
                    .frozen_units
                    .iter()
                    .any(|u| u.kind.contains("image")),
                "signed prefix must not acquire new image units"
            );
        }
    }
}

#[test]
fn independent_images_tail_without_positive_tag_stays_even_in_emergency() {
    let mut image = item("image", 1, "");
    image.ck.content = vec![independent_image(true)];
    // A reasoning-only answer makes the image processed without supplying a text tag.
    let mut answer = wire_item("assistant", "answer", 2, &["answer"]);
    answer.ck.content = vec![review_reasoning("tail answer")];
    let request = req(
        "independent-tail",
        "cfg",
        vec![item("preceding", 0, "old"), image, answer],
    );
    let tags = BTreeMap::from([("preceding".into(), 1)]);
    for emergency in [false, true] {
        let units = new_frozen_strip_units(
            &CoreState::default(),
            &request,
            &tags,
            None,
            true,
            StripSelectionScope {
                reasoning: ReasoningBudgetScope::default(),
                image_watermark: 100,
                image_protected_cutoff: Some(1),
                image_emergency: emergency,
            },
            &HashSet::new(),
            &crate::edit_admission::EditAdmission::new(&[], false),
        );
        assert!(!units.iter().any(|u| u.kind.contains("image")));
        let output = render_processed_image_plan(&request, units);
        assert!(output
            .iter()
            .any(|m| m.content.iter().any(image_block_is_large)));
    }
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let mut request = request;
    request.provider_id = Some("openai".into());
    run(&s, &request, &spine());
    s.seed_tags_for_test(
        &request.session_id,
        &[mc_store::TagMintInput {
            block_id: "preceding#0".into(),
            kind: "message".into(),
            token_count: 1,
            source_bytes: b"old".to_vec(),
        }],
        0,
    )
    .unwrap();
    let mut loaded = s.load(&request.session_id).unwrap();
    loaded
        .core
        .frozen_units
        .push(red_unit("preceding#0", "drop", "[spent]"));
    s.commit(
        &request.session_id,
        loaded.row_version,
        &loaded.core,
        &loaded.meta,
    )
    .unwrap();
    request.render_config = "cfg1".into();
    request = with_usage(request, 95, 100);
    let response = run(&s, &request, &spine());
    assert_ne!(response.action, "SOFT+");
    assert!(response
        .messages()
        .iter()
        .any(|m| m.content.iter().any(image_block_is_large)));
    assert!(!s
        .load(&request.session_id)
        .unwrap()
        .core
        .frozen_units
        .iter()
        .any(|u| u.kind.contains("image")));
}

#[test]
fn independent_images_cutoff_tie_and_emergency_execute() {
    for percent in [86, 95] {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let mut image = item("image", 1, "");
        image.ck.content = vec![independent_image(true)];
        let mut request = req(
            "independent-cutoff-tie",
            "cfg0",
            vec![
                item("head", 0, "older history"),
                image,
                assistant_tool_call("call", 2, "call"),
                tool_result("tool", 3, "call", "output"),
                wire_item("assistant", "answer", 4, &["processed"]),
                item("dropper", 5, "spent"),
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
            .push(red_unit("dropper#0", "drop", "[spent]"));
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
        assert_ne!(response.action, "SOFT+");
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

#[test]
#[ignore = "known native codec residue: media-to-text conversion retains the original URL field"]
fn independent_images_native_direct_payload_is_removed() {
    let data = "I".repeat(307);
    let raw = vec![
        json!({"info": {"id": "image", "role": "user"}, "parts": [{"type": "file", "mime": "image/png", "url": format!("data:image/png;base64,{data}")}]}),
    ];
    let decoded = crate::codec::decode_opencode(&raw);
    let mut messages: Vec<_> = decoded.messages.into_iter().map(|m| m.ck).collect();
    replace_with_sentinel(&mut messages[0].content[0], "[image stripped]");
    messages[0].mark_modified();
    let encoded = crate::codec::encode_opencode_with_session(
        &messages,
        &decoded.sidecar,
        Some("independent-residue"),
        None,
    );
    assert_eq!(encoded[0]["parts"][0]["type"], "text");
    assert_eq!(encoded[0]["parts"][0]["text"], "[image stripped]");
    assert!(
        !serde_json::to_string(&encoded).unwrap().contains(&data),
        "image data remains in a stale URL field after native conversion to text"
    );
}
