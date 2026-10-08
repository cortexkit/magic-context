//! OpenCode's provider lane uses the same native projection as full requests.
use super::*;
use crate::codec::DecodedHarnessMessages;

/// Status identity is the runner's ordinal space, not the native store's
/// absolute ordinal or the positional fallback used by full-request decoding.
/// Retain the original native values so rendering never authors their metadata.
pub(super) fn decode_messages(
    messages: &[compact::status::StatusMessage],
) -> Result<DecodedHarnessMessages, HandlerOutcome> {
    for message in messages {
        let native = &message.message;
        if !native.get("info").is_some_and(Value::is_object)
            || native.pointer("/info/id").and_then(Value::as_str) != Some(message.mid.as_str())
            || !matches!(
                native.pointer("/info/role").and_then(Value::as_str),
                Some("system" | "user" | "assistant" | "tool")
            )
            || !native.get("parts").is_some_and(Value::is_array)
        {
            return Err(error(
                "history_unreadable",
                "invalid OpenCode {info, parts} message",
            ));
        }
    }
    // Supply ordinals before decoding: tool parts without a call id use the
    // ordinal in their fallback identity. This temporary decode input must
    // never replace the original native bytes in the sidecar.
    let native = messages
        .iter()
        .map(|message| {
            let mut native = message.message.clone();
            native["absolute_ordinal"] = json!(message.ordinal);
            native
        })
        .collect::<Vec<_>>();
    let mut decoded = crate::codec::decode_opencode(&native);
    for message in messages {
        if let Some(meta) = decoded.sidecar.messages.get_mut(&message.mid) {
            Arc::make_mut(meta).raw = message.message.clone();
        }
    }
    Ok(decoded)
}

/// Native finalization needs the engine's committed reasoning decisions and
/// tag baseline, not a new tag mint or a second interpretation of hook ops.
#[allow(dead_code)]
pub(super) struct NativeRenderContext<'a> {
    pub reasoning_clear_units: &'a [mc_core::FrozenUnit],
    pub tag_numbers: &'a BTreeMap<String, u64>,
    pub mutation_exempt_mid: Option<&'a str>,
    pub lineage_anchor_mid: Option<&'a str>,
    pub transition_consumed: bool,
    pub native_reasoning_keep_mids: &'a [String],
}

impl<'a> From<&'a transform::TransformWithProjection> for NativeRenderContext<'a> {
    fn from(engine: &'a transform::TransformWithProjection) -> Self {
        Self {
            reasoning_clear_units: &engine.reasoning_clear_units,
            tag_numbers: &engine.tag_numbers,
            mutation_exempt_mid: engine.mutation_exempt_mid.as_deref(),
            lineage_anchor_mid: engine.lineage_anchor_mid.as_deref(),
            transition_consumed: engine.transition_consumed,
            native_reasoning_keep_mids: &engine.response.native_reasoning_keep_mids,
        }
    }
}

#[allow(dead_code)]
pub(super) fn encode_view(
    view: &transform::compaction::View,
    request: &TransformRequest,
    context: &NativeRenderContext<'_>,
) -> Result<compact::answer::CompactionMessage, HandlerOutcome> {
    if request.serializer_profile != SerializerProfile::OpencodeAiSdk.wire_id()
        || !request.serve_native
        || request.native_messages.is_none()
    {
        return Err(error(
            "history_unreadable",
            "OpenCode view requires matching native ingress",
        ));
    }
    // A compaction view excludes system rows and may rewrite its head roles.
    // Render the view, not the full engine response, while retaining the
    // engine's native-reasoning protection decisions.
    let mut response = transform::TransformResponse::passthrough(view.replacement.clone(), None);
    response.native_reasoning_keep_mids = context.native_reasoning_keep_mids.to_vec();
    crate::attach_native_messages_with_tags(
        &mut response,
        request,
        context.reasoning_clear_units,
        context.tag_numbers,
        context.mutation_exempt_mid,
        context.lineage_anchor_mid,
        context.transition_consumed,
    );
    let replacement = response
        .native_messages
        .ok_or_else(|| transient("native view rendering produced no messages"))?
        .into_iter()
        .map(|message| message.as_ref().clone())
        .collect();
    Ok(compact::answer::CompactionMessage::new(
        &view.compaction_id,
        view.version,
        compact::answer::Range::new(view.range.from, view.range.to),
        replacement,
    ))
}

#[cfg(test)]
mod tests {
    use super::super::codec::Codec;
    use super::*;

    fn entries(messages: &[Value]) -> Vec<compact::status::StatusMessage> {
        messages
            .iter()
            .enumerate()
            .map(|(index, message)| compact::status::StatusMessage {
                mid: message["info"]["id"].as_str().unwrap().into(),
                ordinal: 4_000 + index as u64,
                message: message.clone(),
            })
            .collect()
    }

    fn request(codec: Codec, messages: &[Value]) -> TransformRequest {
        let mut request: TransformRequest = decode(&json!({
            "v":2,"kind":"compaction.step","serializer_profile":"owned-broca",
            "session_id":"ses","model_key":"fixture","render_config":"fixture","messages":[],
            "tool_present":false,"auto_search_enabled":false
        }))
        .unwrap();
        codec
            .prepare_request(&mut request, &entries(messages))
            .unwrap();
        request
    }

    fn view(request: &TransformRequest) -> transform::compaction::View {
        transform::compaction::View {
            compaction_id: "compact".into(),
            version: 7,
            range: transform::compaction::Range {
                lineage_id: "L".into(),
                from: 4_000,
                to: 4_000 + request.messages.len() as u64,
            },
            replacement: request
                .messages
                .iter()
                .map(|message| message.ck.clone())
                .collect(),
        }
    }

    fn render(
        codec: Codec,
        view: &transform::compaction::View,
        request: &TransformRequest,
    ) -> compact::answer::CompactionMessage {
        let tags = BTreeMap::new();
        codec
            .encode_view(
                view,
                request,
                &NativeRenderContext {
                    reasoning_clear_units: &[],
                    tag_numbers: &tags,
                    mutation_exempt_mid: None,
                    lineage_anchor_mid: None,
                    transition_consumed: false,
                    native_reasoning_keep_mids: &[],
                },
            )
            .unwrap()
    }

    fn mixed_message() -> Value {
        json!({
            "info":{"id":"mid-with-hash","role":"assistant","sessionID":"ses","absolute_ordinal":99,"time":{"created":1,"completed":2},"future":{"keep":true}},
            "absolute_ordinal":12,
            "parts":[
                {"id":"ignored","type":"text","text":"ignored","ignored":true},
                {"id":"finish","type":"step-finish","tokens":{"output":1}},
                {"id":"snapshot","type":"snapshot","snapshot":"snap"},
                {"id":"start","type":"step-start","snapshot":"snap"},
                {"id":"thinking","type":"reasoning","text":"thinking","metadata":{"anthropic":{"signature":"sig"}}},
                {"id":"text","type":"text","text":"héllo\n\"世界\"","metadata":{"future":7}},
                {"id":"p1","type":"tool","callID":"reused","tool":"read","state":{"status":"completed","input":{"path":"a"},"output":"one","metadata":{"keep":true}}},
                {"id":"p2","type":"tool","callID":"other","tool":"read","state":{"status":"error","input":{"path":"b"},"error":"two"}},
                {"id":"file","type":"file","mime":"image/png","url":"data:image/png;base64,aA=="},
                {"id":"future","type":"future","value":{"keep":true}}
            ],
            "future_envelope":"preserved"
        })
    }

    #[test]
    fn opencode_fixture_views_round_trip_byte_identically_without_ops_or_engine_changes() {
        let codec = Codec::from_params(&json!({"serializer_profile":"opencode-aisdk"})).unwrap();
        let fixtures: Value =
            serde_json::from_str(include_str!("../../testdata/codec/opencode-golden.json"))
                .unwrap();
        let native: Value = serde_json::from_str(include_str!(
            "../../testdata/codec/serve-native-golden.json"
        ))
        .unwrap();
        let mut cases = fixtures["cases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|case| case["messages"].as_array().unwrap().clone())
            .collect::<Vec<_>>();
        cases.push(native["messages"].as_array().unwrap().clone());
        cases.push(vec![mixed_message()]);
        for messages in cases {
            let request = request(codec, &messages);
            assert_eq!(request.serializer_profile, "opencode-aisdk");
            assert!(request.serve_native);
            assert_eq!(
                bytes(&request.native_messages).unwrap(),
                bytes(&Some(&messages)).unwrap()
            );
            let rendered = render(codec, &view(&request), &request);
            assert_eq!(rendered.compaction_id, "compact");
            assert_eq!(rendered.version, 7);
            assert_eq!(
                bytes(&rendered.replacement).unwrap(),
                bytes(&messages).unwrap()
            );
        }
    }

    #[test]
    fn opencode_ingress_uses_runner_ordinals_and_ck_block_indexes_not_native_part_indexes() {
        let messages = vec![mixed_message()];
        let decoded = decode_messages(&entries(&messages)).unwrap();
        let ingress = &decoded.messages[0];
        assert_eq!(ingress.ordinal, 4_000);
        assert_eq!(ingress.ck.meta.ordinal, Some(4_000));
        let meta = decoded.sidecar.message_by_mid("mid-with-hash").unwrap();
        assert_eq!(meta.ordinal, 4_000);
        assert_eq!(bytes(&meta.raw).unwrap(), bytes(&messages[0]).unwrap());
        assert_eq!(
            meta.blocks
                .iter()
                .map(|block| block.native_index.unwrap())
                .collect::<Vec<_>>(),
            vec![3, 4, 5, 6, 6, 7, 7, 8, 9]
        );
        let projection = ck_wire::project_messages(&decoded.messages).unwrap();
        assert_eq!(
            projection
                .blocks
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "mid-with-hash#0",
                "mid-with-hash#1",
                "mid-with-hash#2",
                "mid-with-hash#3",
                "mid-with-hash#4",
                "mid-with-hash#5",
                "mid-with-hash#6",
                "mid-with-hash#7",
                "mid-with-hash#8",
            ]
        );
        assert!(matches!(
            ingress.ck.content[4].kind,
            ck_wire::CkKind::ToolResult { .. }
        ));
        assert!(matches!(
            ingress.ck.content[6].kind,
            ck_wire::CkKind::ToolResult { .. }
        ));
    }

    #[test]
    fn opencode_ingress_keeps_distinct_parts_with_a_repeated_tool_call_id() {
        let mut native = mixed_message();
        native["parts"][7]["callID"] = json!("reused");
        let decoded = decode_messages(&entries(std::slice::from_ref(&native))).unwrap();
        let ingress = &decoded.messages[0];
        for index in [4, 6] {
            assert!(
                matches!(&ingress.ck.content[index].kind, ck_wire::CkKind::ToolResult { id, .. } if id == "reused")
            );
        }
        let meta = decoded.sidecar.message_by_mid(&ingress.mid).unwrap();
        assert_eq!(meta.blocks[4].raw["id"], "p1");
        assert_eq!(meta.blocks[6].raw["id"], "p2");
        assert_ne!(meta.blocks[4].block_index, meta.blocks[6].block_index);
    }

    #[test]
    fn opencode_rendering_updates_only_unsigned_target_text_and_tool_output() {
        let codec = Codec::OpencodeAiSdk;
        // Signed newest-assistant vectors are protected by the shared renderer.
        // Use an unsigned structural block so these edits are eligible.
        let mut original = mixed_message();
        original["parts"][4]["type"] = json!("subtask");
        let request = request(codec, std::slice::from_ref(&original));
        let mut view = view(&request);
        if let ck_wire::CkKind::Text { text } = &mut view.replacement[0].content[2].kind {
            *text = "changed text".into();
        } else {
            panic!("text block");
        }
        if let ck_wire::CkKind::ToolResult { output, .. } = &mut view.replacement[0].content[4].kind
        {
            output.kind = ck_wire::CkOutputKind::Text {
                text: "changed output".into(),
            };
        } else {
            panic!("tool output");
        }
        view.replacement[0].content[2].mark_modified();
        view.replacement[0].content[4].mark_modified();
        view.replacement[0].mark_modified();
        let mut expected = original;
        expected["parts"][5]["text"] = json!("changed text");
        expected["parts"][6]["state"]["output"] = json!("changed output");
        assert_eq!(render(codec, &view, &request).replacement, vec![expected]);
    }

    #[test]
    fn opencode_ingress_rejects_malformed_envelopes_and_conflicting_native_ids() {
        for native in [
            json!({"role":"user","content":[]}),
            json!({"info":{"id":"m","role":"future"},"parts":[]}),
            json!({"info":{"id":"m","role":"user"},"parts":{}}),
            json!({"info":{"id":"other","role":"user"},"parts":[]}),
        ] {
            let entry = compact::status::StatusMessage {
                mid: "m".into(),
                ordinal: 1,
                message: native,
            };
            assert!(
                matches!(Codec::OpencodeAiSdk.decode_message(&entry), Err(HandlerOutcome::Error { code, .. }) if code == "history_unreadable")
            );
        }
    }

    #[test]
    fn opencode_rendering_rejects_a_mismatched_engine_profile_or_missing_sidecar() {
        let codec = Codec::OpencodeAiSdk;
        let mut request = request(codec, &[mixed_message()]);
        let view = view(&request);
        let tags = BTreeMap::new();
        let context = NativeRenderContext {
            reasoning_clear_units: &[],
            tag_numbers: &tags,
            mutation_exempt_mid: None,
            lineage_anchor_mid: None,
            transition_consumed: false,
            native_reasoning_keep_mids: &[],
        };
        request.serializer_profile = "owned-broca".into();
        assert!(codec.encode_view(&view, &request, &context).is_err());
        request.serializer_profile = "opencode-aisdk".into();
        request.native_messages = None;
        assert!(codec.encode_view(&view, &request, &context).is_err());
    }
}
