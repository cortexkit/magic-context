use super::*;
use crate::ck_wire::{CkKind, CkOutputKind, ResultBlockKind};
use codec::{Codec, InboundMessage};

const ON: &str = include_str!("../../testdata/broca-media/on-session-read.jsonl");
const OFF: &str = include_str!("../../testdata/broca-media/off-session-read.jsonl");
const IMAGE: &str =
    "[media not shown: kind=image mime=image/png bytes=4749 sha256=2bb3f6f7eb60 reason=carrier]";
const PDF: &str = "[media not shown: kind=document mime=application/pdf bytes=584 sha256=b7442ba422ac reason=carrier]";

fn rows(bytes: &str) -> Vec<Value> {
    serde_json::from_str::<Value>(bytes).unwrap()["result"]["messages"]
        .as_array()
        .unwrap()
        .clone()
}

fn entry(row: &Value) -> InboundMessage {
    serde_json::from_value(row.clone()).unwrap()
}

fn tool() -> InboundMessage {
    entry(&rows(ON)[4])
}

fn decoded_tool() -> crate::ck_wire::CkWireMessage {
    Codec::OwnedBroca.decode_message(&tool()).unwrap().ck
}

fn tool_output(message: &crate::ck_wire::CkWireMessage) -> &crate::ck_wire::CkToolOutput {
    let CkKind::ToolResult { output, .. } = &message.content[0].kind else {
        panic!("tool result")
    };
    output
}

#[test]
fn broca_media_capture_roundtrips_at_the_value_boundary() {
    for capture in [
        ON,
        OFF,
        include_str!("../../testdata/broca-media-set2/on-session-read-descriptors.jsonl"),
        include_str!("../../testdata/broca-media-set2/off-session-read-descriptors.jsonl"),
        include_str!("../../testdata/broca-media-set2/on-session-read-default.jsonl"),
        include_str!("../../testdata/broca-media-set2/on-session-read.jsonl"),
        include_str!("../../testdata/broca-media-set2/off-session-read.jsonl"),
    ] {
        for row in rows(capture) {
            let entry = entry(&row);
            let decoded = Codec::OwnedBroca.decode_message(&entry).unwrap();
            let encoded = codec::encode_message(&decoded.ck).unwrap();
            assert_eq!(encoded, entry.message, "{}", entry.mid);
            assert_eq!(bytes(&encoded).unwrap(), bytes(&entry.message).unwrap());
            for block in &decoded.ck.content {
                if let CkKind::Media(_) = &block.kind {
                    let text = crate::render_cached_expand_part(block).unwrap();
                    assert_eq!(text, "[media not shown: kind=image mime=image/png bytes=3592 sha256=2d317c5c185e reason=carrier]");
                    assert!(!text.contains(
                        "2d317c5c185e947275cc6005f0da44adb3430cea4c01f5ee6d1eafce0fc017f3"
                    ));
                }
            }
        }
    }
    let mut assistant = entry(&rows(ON)[2]);
    assistant.message["role"] = json!("assistant");
    let decoded = Codec::OwnedBroca.decode_message(&assistant).unwrap();
    assert_eq!(
        codec::encode_message(&decoded.ck).unwrap(),
        assistant.message
    );
}

#[test]
fn broca_media_member_rules_refuse_by_name() {
    Codec::OwnedBroca.decode_message(&tool()).unwrap();
    let reference = tool().message["content"][0]["output"]["parts"][1]["media"].clone();
    let mut cases = Vec::new();
    for (field, value) in [
        ("surprise", json!(true)),
        ("bytes", json!([1, 2])),
        ("base64", json!("AAAA")),
        ("sha256", json!("z".repeat(64))),
        ("sha256", json!("A".repeat(64))),
        ("sha256", json!("a".repeat(63))),
        ("byte_size", json!(-1)),
        ("byte_size", json!(1.5)),
        ("width", json!(4294967296u64)),
        ("height", Value::Null),
        ("mime", json!(42)),
        ("kind", json!("hologram")),
    ] {
        let mut media = reference.clone();
        media[field] = value;
        cases.push((field, media));
    }
    for field in ["kind", "mime", "sha256", "byte_size", "width", "height"] {
        let mut media = reference.clone();
        media.as_object_mut().unwrap().remove(field);
        cases.push((field, media));
    }
    let mut document = reference.clone();
    document["kind"] = json!("document");
    cases.push(("width", document));
    for (field, media) in cases {
        for top_level in [false, true] {
            let mut inbound = tool();
            if top_level {
                let mut block = media.clone();
                block["type"] = json!("media");
                inbound.message = json!({"role":"user","content":[block]});
            } else {
                inbound.message["content"][0]["output"]["parts"][1]["media"] = media.clone();
            }
            let failure = Codec::OwnedBroca.decode_message(&inbound).unwrap_err();
            let printed = format!("{failure:?}");
            assert!(printed.contains("history_unreadable"), "{printed}");
            assert!(printed.contains(field), "{field}: {printed}");
        }
    }
    for (pointer, field) in [
        ("/content/0/output", "parts"),
        ("/content/0/output/parts/0", "text"),
        ("/content/0/output/parts/1", "media"),
    ] {
        let mut inbound = tool();
        inbound
            .message
            .pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(field);
        let printed = format!(
            "{:?}",
            Codec::OwnedBroca.decode_message(&inbound).unwrap_err()
        );
        assert!(
            printed.contains("history_unreadable") && printed.contains(field),
            "{printed}"
        );
    }
    for pointer in [
        "/content/0/output",
        "/content/0/output/parts/0",
        "/content/0/output/parts/1",
    ] {
        let mut inbound = tool();
        inbound.message.pointer_mut(pointer).unwrap()["surprise"] = json!(true);
        let printed = format!(
            "{:?}",
            Codec::OwnedBroca.decode_message(&inbound).unwrap_err()
        );
        assert!(printed.contains("surprise"), "{printed}");
    }
}

#[test]
fn broca_media_unknown_mime_is_opaque_and_integers_are_exact() {
    let mut inbound = tool();
    let media = &mut inbound.message["content"][0]["output"]["parts"][1]["media"];
    media["mime"] = json!("new-format/opaque; untouched=YES");
    media["byte_size"] = json!(u64::MAX);
    media["width"] = json!(u32::MAX);
    media["height"] = json!(0);
    let ck = Codec::OwnedBroca.decode_message(&inbound).unwrap().ck;
    assert_eq!(codec::encode_message(&ck).unwrap(), inbound.message);
}

#[test]
fn broca_media_off_text_is_exact_for_all_text_readers() {
    let message = decoded_tool();
    let expected = format!("before-media\n{IMAGE}\n{PDF}\nafter-media");
    assert_eq!(
        crate::tail_hygiene::tool_output_content(&tool_output(&message).kind),
        expected
    );
    assert_eq!(
        crate::expand_tool_output_text(tool_output(&message)),
        expected
    );
    for secret in [
        "iVBOR",
        "JVBER",
        "2bb3f6f7eb60006453f46d1a1f6fb72cb30be54fbe604d29a31a8a41cc0a5fe7",
        "b7442ba422acb7aa7660b99e95858e049e8fac32dbc1b34a19e285b1adc0ae2f",
    ] {
        assert!(
            !expected.contains(secret),
            "MediaRef rendering must not expose {secret}"
        );
    }
    let off = entry(&rows(OFF)[4]);
    let off = Codec::OwnedBroca.decode_message(&off).unwrap().ck;
    let source = entry(&rows(OFF)[4]);
    let parts = source.message["content"][0]["output"]["parts"]
        .as_array()
        .unwrap();
    let literal_text = parts
        .iter()
        .map(|part| part["text"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(
        crate::tail_hygiene::tool_output_content(&tool_output(&off).kind),
        literal_text
    );
    assert!(
        literal_text.contains("JVBERi0"),
        "Broca's old literal text remains unchanged"
    );
}

#[test]
fn broca_media_capture_checksums() {
    for (directory, manifest, expected_count) in [
        (
            "broca-media",
            include_str!("../../testdata/broca-media/SHA256SUMS"),
            16,
        ),
        (
            "broca-media-set2",
            include_str!("../../testdata/broca-media-set2/SHA256SUMS"),
            22,
        ),
    ] {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("testdata")
            .join(directory);
        let mut count = 0;
        for line in manifest.lines() {
            let (sha, name) = line.split_once("  ").unwrap();
            assert_eq!(
                crate::sha256_hex(&std::fs::read(root.join(name)).unwrap()),
                sha,
                "{name}"
            );
            count += 1;
        }
        assert_eq!(count, expected_count);
    }
}

#[test]
fn broca_media_descriptor_members_are_strict_and_part_is_required() {
    let source = entry(
        &rows(include_str!(
            "../../testdata/broca-media-set2/on-session-read-descriptors.jsonl"
        ))[2],
    );
    Codec::OwnedBroca.decode_message(&source).unwrap();
    for (member, value) in [
        ("bytes", json!([1])),
        ("base64", json!("AA==")),
        ("unknown", json!(true)),
        ("sha256", json!("A".repeat(64))),
        ("part", Value::Null),
        ("part", json!("m2#0")),
    ] {
        let mut inbound = source.clone();
        inbound.message["content"][1][member] = value;
        let printed = format!(
            "{:?}",
            Codec::OwnedBroca.decode_message(&inbound).unwrap_err()
        );
        assert!(
            printed.contains("history_unreadable") && printed.contains(member),
            "{printed}"
        );
    }
    let mut inbound = source;
    inbound.message["content"][1]
        .as_object_mut()
        .unwrap()
        .remove("part");
    let printed = format!(
        "{:?}",
        Codec::OwnedBroca.decode_message(&inbound).unwrap_err()
    );
    assert!(printed.contains("part"), "{printed}");
}

fn find<'a>(value: &'a Value, key: &str, expected: &str) -> Option<&'a Value> {
    match value {
        Value::Object(object) => {
            if object.get(key).and_then(Value::as_str) == Some(expected) {
                return Some(value);
            }
            object.values().find_map(|value| find(value, key, expected))
        }
        Value::Array(values) => values.iter().find_map(|value| find(value, key, expected)),
        _ => None,
    }
}

fn has_tool_text(value: &Value) -> bool {
    match value {
        Value::String(text) => text.starts_with("before-media"),
        Value::Array(values) => values.iter().any(has_tool_text),
        Value::Object(values) => values.values().any(has_tool_text),
        _ => false,
    }
}

#[test]
fn broca_media_text_matches_real_family_request_text() {
    let ck = decoded_tool();
    let projected = crate::tail_hygiene::tool_output_content(&tool_output(&ck).kind);
    assert_eq!(
        projected,
        format!("before-media\n{IMAGE}\n{PDF}\nafter-media")
    );
    let matrix = include_str!("../../testdata/broca-media/on-family-matrix.jsonl");
    let mut families = BTreeSet::new();
    let mut compared = 0;
    for line in matrix.lines() {
        let row: Value = serde_json::from_str(line).unwrap();
        let family = row["family"].as_str().unwrap();
        families.insert(family.to_owned());
        let requests = row["rendered_requests"].as_array().unwrap();
        if family == "GoogleCodeAssist" {
            assert_eq!(row["send_reply"]["code"], "media_unsupported");
            assert_eq!(requests.len(), 1);
            assert!(find(&requests[0], "name", "work").is_some());
            continue;
        }
        let request = requests
            .iter()
            .find(|request| has_tool_text(request))
            .expect("real follow-up with tool output");
        let (actual, carried) = match family {
            "OpenAiChat" => {
                let result = find(request, "role", "tool").unwrap();
                // Chat still has no synthetic user message carrying tool media.
                assert!(!bytes(request)
                    .unwrap()
                    .windows(b"Media from tool call".len())
                    .any(|s| s == b"Media from tool call"));
                (result["content"].as_str().unwrap().to_owned(), Vec::new())
            }
            "Gemini" => {
                let response = find(request, "name", "work")
                    .filter(|v| v.get("response").is_some())
                    .or_else(|| {
                        request["contents"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .rev()
                            .find_map(|message| {
                                message["parts"]
                                    .as_array()
                                    .unwrap()
                                    .iter()
                                    .find_map(|part| part.get("functionResponse"))
                            })
                    })
                    .unwrap();
                assert_eq!(response["parts"].as_array().unwrap().len(), 2);
                (
                    response["response"]["result"].as_str().unwrap().to_owned(),
                    vec![IMAGE, PDF],
                )
            }
            _ => {
                let blocks = match family {
                    "AnthropicMessages" => {
                        &find(request, "type", "tool_result").unwrap()["content"]
                    }
                    "BedrockConverse" => {
                        let message = request["messages"].as_array().unwrap().last().unwrap();
                        &message["content"][0]["toolResult"]["content"]
                    }
                    "OpenAiResponses" | "OpenAiResponsesChatgpt" => {
                        &find(request, "type", "function_call_output").unwrap()["output"]
                    }
                    _ => panic!("uncovered family {family}"),
                }
                .as_array()
                .unwrap();
                let actual = blocks
                    .iter()
                    .filter_map(|block| block["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                let carried = if family == "OpenAiResponsesChatgpt" {
                    vec![IMAGE]
                } else {
                    vec![IMAGE, PDF]
                };
                assert_eq!(blocks.len(), 4);
                (actual, carried)
            }
        };
        // Accepted carriers are not text. Unsupported carriers remain byte-exact markers.
        let expected = projected
            .split('\n')
            .filter(|line| !carried.contains(line))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(actual, expected, "{family}: {}", row["person_kind"]);
        compared += 1;
    }
    assert_eq!(families.len(), 7);
    assert_eq!(compared, 13);
}

#[test]
fn broca_media_only_result_numbers_one_inserted_label_not_media() {
    let mut inbound = tool();
    let parts = inbound.message["content"][0]["output"]["parts"]
        .as_array_mut()
        .unwrap();
    parts.retain(|part| part["kind"] == "media");
    let mut message = Codec::OwnedBroca.decode_message(&inbound).unwrap().ck;
    assert!(crate::transform::apply_tag_prefix_to_block(
        "tool",
        &mut message.content[0],
        crate::transform::TaggableKind::ToolResult,
        8
    ));
    let encoded = codec::encode_message(&message).unwrap();
    let parts = encoded["content"][0]["output"]["parts"].as_array().unwrap();
    assert_eq!(parts.len(), 3);
    assert_eq!(parts[0], json!({"kind":"text","text":"§8§ [media]"}));
    assert_eq!(
        &parts[1..],
        inbound.message["content"][0]["output"]["parts"]
            .as_array()
            .unwrap()
    );
}

#[test]
fn broca_media_drop_is_one_text_output() {
    let mut message = decoded_tool();
    message.content[0] = crate::ck_wire::reduced_block(&message.content[0], "[dropped §8§]");
    let encoded = codec::encode_message(&message).unwrap();
    assert_eq!(
        encoded["content"][0]["output"],
        json!({"kind":"text","text":"[dropped §8§]"})
    );
    assert_eq!(
        encoded["content"][0]["tool_call_id"],
        tool().message["content"][0]["tool_call_id"]
    );
}

#[test]
fn broca_media_text_edits_keep_media_in_place() {
    for capture in [
        ON,
        include_str!("../../testdata/broca-media-set2/on-session-read-descriptors.jsonl"),
    ] {
        let source = entry(&rows(capture)[4]);
        let mut message = Codec::OwnedBroca.decode_message(&source).unwrap().ck;
        assert!(crate::transform::apply_tag_prefix_to_block(
            "tool",
            &mut message.content[0],
            crate::transform::TaggableKind::ToolResult,
            8
        ));
        let CkKind::ToolResult { output, .. } = &mut message.content[0].kind else {
            panic!("result")
        };
        let CkOutputKind::Content { blocks } = &mut output.kind else {
            panic!("parts stay structured")
        };
        for block in blocks {
            if let ResultBlockKind::Text { text } = &mut block.kind {
                *text = format!(
                    "prefix {}",
                    text.strip_prefix("§8§ ")
                        .unwrap_or(text)
                        .chars()
                        .take(3)
                        .collect::<String>()
                );
            }
        }
        let encoded = codec::encode_message(&message).unwrap();
        for index in [1, 2] {
            let mut original = source.message["content"][0]["output"]["parts"][index].clone();
            if let Some(media) = original["media"].as_object_mut() {
                media.remove("type");
            }
            assert_eq!(encoded["content"][0]["output"]["parts"][index], original);
        }
        assert_eq!(
            encoded["content"][0]["output"]["parts"][0]["text"],
            "prefix bef"
        );
        assert_eq!(
            encoded["content"][0]["output"]["parts"][3]["text"],
            "prefix aft"
        );
    }
}

fn view(entries: &[InboundMessage]) -> crate::transform::compaction::View {
    crate::transform::compaction::View {
        compaction_id: "media".into(),
        version: 1,
        range: crate::transform::compaction::Range {
            lineage_id: "L".into(),
            from: 0,
            to: entries.len() as u64,
        },
        replacement: entries
            .iter()
            .map(|entry| Codec::OwnedBroca.decode_message(entry).unwrap().ck)
            .collect(),
    }
}

#[test]
fn broca_media_reference_changes_refuse_before_view_publication() {
    let mut tampered = decoded_tool();
    let CkKind::ToolResult { output, .. } = &mut tampered.content[0].kind else {
        panic!("result")
    };
    let CkOutputKind::Content { blocks } = &mut output.kind else {
        panic!("parts")
    };
    blocks[1]
        .provider_extras
        .get_mut("mc-provider")
        .unwrap()
        .get_mut("native_part")
        .unwrap()["media"]["sha256"] = json!(format!("2bb3f6f7eb60{}", "a".repeat(52)));
    assert!(
        format!("{:?}", codec::encode_message(&tampered).unwrap_err())
            .contains("provider_constraint")
    );
    let entries: Vec<_> = rows(ON).iter().map(entry).collect();
    let mut changed = entries.clone();
    changed[4].message["content"][0]["output"]["parts"][1]["media"]["sha256"] =
        json!("a".repeat(64));
    let forged = view(&changed);
    let failure = Codec::OwnedBroca
        .render_view(&forged, "session", &entries)
        .unwrap_err();
    let printed = format!("{failure:?}");
    assert!(
        printed.contains("provider_constraint") && printed.contains("media"),
        "{printed}"
    );
    let mut request: TransformRequest = decode(&json!({"v":2,"kind":"compaction.step","serializer_profile":"owned-broca","session_id":"media","render_config":"","messages":[],"tool_present":false,"auto_search_enabled":false})).unwrap();
    Codec::OwnedBroca
        .prepare_request(&mut request, &entries)
        .unwrap();
    let failure = Codec::OwnedBroca
        .render_prepared_view(&forged, "media", &request)
        .unwrap_err();
    assert!(format!("{failure:?}").contains("provider_constraint"));
    let mut unpaired = view(&entries);
    unpaired.replacement.remove(3);
    let failure = Codec::OwnedBroca
        .render_view(&unpaired, "media", &entries)
        .unwrap_err();
    let printed = format!("{failure:?}");
    assert!(
        printed.contains("provider_constraint") && printed.contains("tool_call"),
        "{printed}"
    );
}

#[test]
fn review_broca_media_retarget_to_other_captured_reference_is_refused() {
    let entries: Vec<_> = rows(ON).iter().map(entry).collect();
    let mut changed = view(&entries);
    let CkKind::ToolResult { output, .. } = &mut changed.replacement[4].content[0].kind else {
        panic!("tool result")
    };
    let CkOutputKind::Content { blocks } = &mut output.kind else {
        panic!("parts")
    };
    // A captured PDF is not an authorized replacement for the captured image.
    blocks[1] = blocks[2].clone();
    let outcome = Codec::OwnedBroca.render_view(&changed, "review", &entries);
    assert!(
        outcome.is_err(),
        "a view replaced the image with a second copy of the PDF: {outcome:?}"
    );
}

#[test]
fn review_broca_media_tags_match_broca_shared_placement_contract() {
    use cortexkit_role_llm_runner::tags::{
        numbered_block_index, render_counted_text, ToolResultBlock,
    };

    for first in ["", " ", "before"] {
        let mut inbound = tool();
        inbound.message["content"][0]["output"]["parts"][0]["text"] = json!(first);
        let mut message = Codec::OwnedBroca.decode_message(&inbound).unwrap().ck;
        let mut expected = inbound.message.clone();
        // Broca's parts_numbering uses these shared blocks, including empty text.
        let index = numbered_block_index(&[
            ToolResultBlock::Text(first),
            ToolResultBlock::Image,
            ToolResultBlock::Media,
            ToolResultBlock::Text("after-media"),
        ])
        .expect("the nonempty text part is numbered");
        let text = expected["content"][0]["output"]["parts"][index]["text"]
            .as_str()
            .unwrap();
        expected["content"][0]["output"]["parts"][index]["text"] =
            json!(render_counted_text(8, text));
        crate::transform::apply_tag_prefix_to_block(
            "tool",
            &mut message.content[0],
            crate::transform::TaggableKind::ToolResult,
            8,
        );
        assert_eq!(
            codec::encode_message(&message).unwrap(),
            expected,
            "leading text {first:?}"
        );
    }
}

#[test]
fn review_broca_media_nonimage_null_dimensions_are_accepted() {
    let mut inbound = tool();
    let document = &mut inbound.message["content"][0]["output"]["parts"][2]["media"];
    // Broca's MediaRefFields accepts null Option<u32> members on non-images.
    document["width"] = Value::Null;
    document["height"] = Value::Null;
    let decoded = Codec::OwnedBroca
        .decode_message(&inbound)
        .expect("Broca accepts absent or null dimensions on a document reference");
    assert_eq!(codec::encode_message(&decoded.ck).unwrap(), inbound.message);
}

#[test]
fn review_broca_legacy_null_member_rendering_matches_base() {
    let inbound = InboundMessage {
        ordinal: 0,
        mid: "m0".into(),
        message: json!({"role":"assistant","content":[
            {"type":"text","text":"before"},
            {"type":"tool_call","tool_call_id":"call","tool_name":"work",
             "input":{},"thought_signature":null}
        ]}),
    };
    let mut message = Codec::OwnedBroca.decode_message(&inbound).unwrap().ck;
    let CkKind::Text { text } = &mut message.content[0].kind else {
        panic!("text")
    };
    *text = "after".into();
    // Legacy encoding omits a null thought_signature even after an unrelated text edit.
    let expected = json!({"role":"assistant","content":[
        {"type":"text","text":"after"},
        {"type":"tool_call","tool_call_id":"call","tool_name":"work","input":{}}
    ]});
    assert_eq!(codec::encode_message(&message).unwrap(), expected);
}

#[test]
fn broca_media_ordered_occurrences_refuse_partial_removal_duplication_and_reordering() {
    for capture in [
        ON,
        include_str!("../../testdata/broca-media-set2/on-session-read-descriptors.jsonl"),
    ] {
        let entries: Vec<_> = rows(capture).iter().map(entry).collect();
        for edit in [
            "retarget",
            "swap",
            "duplicate",
            "remove",
            "move-text",
            "replace-with-text",
        ] {
            let mut changed = view(&entries);
            let CkKind::ToolResult { output, .. } = &mut changed.replacement[4].content[0].kind
            else {
                panic!("result")
            };
            let CkOutputKind::Content { blocks } = &mut output.kind else {
                panic!("parts")
            };
            match edit {
                "retarget" => blocks[1] = blocks[2].clone(),
                "swap" => blocks.swap(1, 2),
                "duplicate" => blocks.insert(2, blocks[1].clone()),
                "remove" => {
                    blocks.remove(1);
                }
                "move-text" => {
                    let text = blocks.remove(0);
                    blocks.push(text);
                }
                "replace-with-text" => blocks[1] = blocks[0].clone(),
                _ => unreachable!(),
            }
            let refused = Codec::OwnedBroca
                .render_view(&changed, "ordered-media", &entries)
                .unwrap_err();
            assert!(
                format!("{refused:?}").contains("provider_constraint"),
                "{edit}: {refused:?}"
            );
        }
        let mut retargeted = entries.clone();
        retargeted[4].message["content"][0]["output"]["parts"]
            .as_array_mut()
            .unwrap()
            .swap(1, 2);
        let refused = Codec::OwnedBroca
            .render_view(&view(&retargeted), "ordered-media", &entries)
            .unwrap_err();
        assert!(format!("{refused:?}").contains("provider_constraint"));
    }
}

#[test]
fn broca_media_empty_text_media_only_labels_keep_occurrence_positions() {
    use cortexkit_role_llm_runner::tags::{image_label, media_label};
    for image_only in [false, true] {
        let mut entries: Vec<_> = rows(ON).iter().map(entry).collect();
        let parts = entries[4].message["content"][0]["output"]["parts"]
            .as_array_mut()
            .unwrap();
        parts[0]["text"] = json!("");
        parts[3]["text"] = json!("");
        if image_only {
            parts.remove(2);
        }
        let original = entries[4].message["content"][0]["output"]["parts"].clone();
        let mut changed = view(&entries);
        assert!(crate::transform::apply_tag_prefix_to_block(
            "tool",
            &mut changed.replacement[4].content[0],
            crate::transform::TaggableKind::ToolResult,
            8
        ));
        let rendered = Codec::OwnedBroca
            .render_view(&changed, "media-label", &entries)
            .unwrap();
        let parts = rendered.replacement[4]["content"][0]["output"]["parts"]
            .as_array()
            .unwrap();
        assert_eq!(
            parts[0],
            json!({"kind":"text","text":if image_only { image_label(8) } else { media_label(8) }})
        );
        assert_eq!(&parts[1..], original.as_array().unwrap());
    }
}

#[test]
fn broca_media_whole_output_drop_preserves_other_occurrence_identities() {
    let mut entries: Vec<_> = rows(ON).iter().map(entry).collect();
    let mut call = entries[3].message["content"][0].clone();
    call["tool_call_id"] = json!("second");
    entries[3].message["content"]
        .as_array_mut()
        .unwrap()
        .push(call);
    let mut result = entries[4].message["content"][0].clone();
    result["tool_call_id"] = json!("second");
    entries[4].message["content"]
        .as_array_mut()
        .unwrap()
        .push(result.clone());
    let mut changed = view(&entries);
    changed.replacement[4].content[0] =
        crate::ck_wire::reduced_block(&changed.replacement[4].content[0], "[dropped §8§]");
    let rendered = Codec::OwnedBroca
        .render_view(&changed, "media-drop", &entries)
        .unwrap();
    assert_eq!(
        rendered.replacement[4]["content"][0]["output"],
        json!({"kind":"text","text":"[dropped §8§]"})
    );
    assert_eq!(rendered.replacement[4]["content"][1], result);
}

#[test]
fn broca_media_standalone_occurrences_cannot_be_reordered_or_duplicated() {
    let mut entries: Vec<_> = rows(ON).iter().map(entry).collect();
    let first = entries[2].message["content"][1].clone();
    let mut second = first.clone();
    second["sha256"] = json!("a".repeat(64));
    entries[2].message["content"] = json!([first, second]);
    for duplicate in [false, true] {
        let mut changed = view(&entries);
        if duplicate {
            changed.replacement[2].content[0] = changed.replacement[2].content[1].clone();
        } else {
            changed.replacement[2].content.swap(0, 1);
        }
        let refused = Codec::OwnedBroca
            .render_view(&changed, "standalone-media", &entries)
            .unwrap_err();
        assert!(format!("{refused:?}").contains("provider_constraint"));
    }
}
