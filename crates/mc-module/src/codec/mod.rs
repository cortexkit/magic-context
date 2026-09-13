mod common;
pub mod opencode;
pub mod pi;
pub mod sidecar;

pub use opencode::{
    decode_opencode, decode_opencode_with_sidecar, decode_opencode_with_sidecar_and_base,
    encode_opencode, encode_opencode_with_session, encode_opencode_with_session_exemptions,
    MessageV2Json,
};
pub use pi::{decode_pi, decode_pi_with_sidecar, encode_pi, PiSessionEntryJson};
pub use sidecar::{DecodeSidecar, DecodedHarnessMessages, ExtractedBoundary};

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use serde::Deserialize;
    use serde_json::{json, Value};

    use crate::ck_wire::{CkKind, CkOutputKind, CkWireMessage, ResultBlockKind};
    use crate::injection::build_synthetic_todo_pair;
    use crate::test_support::FixtureBuilder;

    use super::{
        decode_opencode, decode_pi, encode_opencode, encode_opencode_with_session, encode_pi,
    };

    #[derive(Deserialize)]
    struct OpenCodeGolden {
        coverage: Vec<String>,
        #[serde(default)]
        missing_capture_classes: Vec<String>,
        cases: Vec<OpenCodeCase>,
    }

    #[derive(Deserialize)]
    struct OpenCodeCase {
        messages: Vec<Value>,
    }

    #[derive(Deserialize)]
    struct PiGolden {
        coverage: Vec<String>,
        #[serde(default)]
        missing_capture_classes: Vec<String>,
        cases: Vec<PiCase>,
    }

    #[derive(Deserialize)]
    struct PiCase {
        entries: Vec<Value>,
    }

    #[derive(Deserialize)]
    struct ToolResultChildParityGolden {
        opencode_messages: Vec<Value>,
        pi_entries: Vec<Value>,
    }

    #[test]
    fn opencode_golden_round_trips_wire_projected_parts_and_is_deterministic() {
        let golden: OpenCodeGolden =
            serde_json::from_str(include_str!("../../testdata/codec/opencode-golden.json"))
                .unwrap();
        assert_coverage_or_recorded_missing(
            &golden.coverage,
            &golden.missing_capture_classes,
            &[
                "text",
                "ignored_text",
                "empty_text",
                "reasoning_signature",
                "tool_completed",
                "tool_error",
                "file",
                "step_start",
                "compaction",
                "subtask",
                "step_finish",
                "patch",
            ],
        );

        for case in golden.cases {
            let decoded = decode_opencode(&case.messages);
            let decoded_again = decode_opencode(&case.messages);
            assert_eq!(decoded, decoded_again);
            assert!(decoded.boundary.is_some());

            let ck_messages: Vec<_> = decoded.messages.iter().map(|msg| msg.ck.clone()).collect();
            let encoded = encode_opencode(&ck_messages, &decoded.sidecar, None);
            let encoded_again = encode_opencode(&ck_messages, &decoded.sidecar, None);
            assert_eq!(encoded, encoded_again);
            assert_eq!(encoded, strip_opencode_compaction(case.messages));
        }
    }

    #[test]
    fn serve_native_golden_preserves_ingress_and_pins_synthetic_shapes() {
        #[derive(Deserialize)]
        struct ServeNativeGolden {
            session_id: String,
            messages: Vec<Value>,
            m0: Value,
            m1: Value,
            synthetic_todo: Value,
        }

        let golden: ServeNativeGolden = serde_json::from_str(include_str!(
            "../../testdata/codec/serve-native-golden.json"
        ))
        .unwrap();
        let decoded = decode_opencode(&golden.messages);
        let todo = build_synthetic_todo_pair(
            r#"[{"content":"Ship it","status":"in_progress","priority":"high"}]"#,
        )
        .unwrap();
        let mut output = vec![
            CkWireMessage::synthetic_user_text("<session-history>\nP1\n</session-history>"),
            CkWireMessage::synthetic_user_text("session delta"),
            todo.assistant_msg,
            todo.tool_msg,
        ];
        output.extend(decoded.messages.iter().map(|message| message.ck.clone()));

        let encoded =
            encode_opencode_with_session(&output, &decoded.sidecar, Some(&golden.session_id), None);
        assert_eq!(encoded[0], golden.m0);
        assert_eq!(encoded[1], golden.m1);
        assert_eq!(encoded[2], golden.synthetic_todo);
        assert_eq!(&encoded[3..], golden.messages.as_slice());
    }

    #[test]
    fn fresh_boundary_prefix_does_not_borrow_persisted_synthetic_meta() {
        let session_id = "ses_persisted_synthetic";
        let persisted_nudge = json!({
            "info": {
                "id": "msg_persisted_nudge",
                "sessionID": session_id,
                "role": "user"
            },
            "parts": [{
                "type": "text",
                "text": "Persisted channel-2 nudge",
                "synthetic": true
            }]
        });
        let input = vec![
            json!({
                "info": { "id": "msg_boundary", "sessionID": session_id, "role": "user" },
                "parts": [
                    { "type": "text", "text": "covered" },
                    { "type": "compaction", "auto": true }
                ]
            }),
            persisted_nudge.clone(),
            json!({
                "info": { "id": "msg_tail", "sessionID": session_id, "role": "assistant" },
                "parts": [{ "type": "text", "text": "tail" }]
            }),
        ];
        let decoded = decode_opencode(&input);
        assert!(decoded.boundary.is_some());
        let mut output = vec![
            CkWireMessage::synthetic_user_text("<session-history>m0</session-history>"),
            CkWireMessage::synthetic_user_text("m1"),
        ];
        output.extend(decoded.messages.iter().map(|message| message.ck.clone()));

        let encoded =
            encode_opencode_with_session(&output, &decoded.sidecar, Some(session_id), None);
        let m0 = &encoded[0];
        assert_eq!(m0["info"]["role"], "user");
        assert_eq!(m0["info"]["sessionID"], session_id);
        assert!(m0["parts"]
            .as_array()
            .is_some_and(|parts| parts.iter().all(|part| part["synthetic"] == true)));
        assert_ne!(m0["info"]["id"], "msg_persisted_nudge");
        assert_eq!(encoded[3], persisted_nudge);
    }

    #[test]
    fn pi_golden_round_trips_non_compaction_entries_and_is_deterministic() {
        let golden: PiGolden =
            serde_json::from_str(include_str!("../../testdata/codec/pi-golden.json")).unwrap();
        assert_coverage_or_recorded_missing(
            &golden.coverage,
            &golden.missing_capture_classes,
            &[
                "text_signature",
                "thinking_signature",
                "redacted_thinking",
                "image",
                "tool_call_split_pipe",
                "thought_signature",
                "tool_result",
                "tool_result_details",
                "custom_message",
                "compaction",
                "aborted_assistant",
                "response_id_mid",
                "timestamp_fallback_mid",
            ],
        );

        for case in golden.cases {
            let decoded = decode_pi(&case.entries);
            let decoded_again = decode_pi(&case.entries);
            assert_eq!(decoded, decoded_again);
            assert!(decoded.boundary.is_some());

            let ck_messages: Vec<_> = decoded.messages.iter().map(|msg| msg.ck.clone()).collect();
            let encoded = encode_pi(&ck_messages, &decoded.sidecar);
            let encoded_again = encode_pi(&ck_messages, &decoded.sidecar);
            assert_eq!(encoded, encoded_again);
            assert_eq!(encoded, strip_pi_compaction(case.entries));
        }
    }

    #[test]
    fn tool_result_child_classification_matches_across_adapters() {
        let golden: ToolResultChildParityGolden = serde_json::from_str(include_str!(
            "../../testdata/codec/tool-result-child-parity.json"
        ))
        .unwrap();
        let opencode = decode_opencode(&golden.opencode_messages);
        let pi = decode_pi(&golden.pi_entries);

        let result_blocks = |messages: &[crate::ck_wire::CkIngressMessage]| {
            messages
                .iter()
                .flat_map(|message| message.ck.content.iter())
                .find_map(|block| match &block.kind {
                    CkKind::ToolResult { output, .. } => match &output.kind {
                        CkOutputKind::Content { blocks }
                        | CkOutputKind::ErrorContent { blocks } => Some(blocks.clone()),
                        _ => None,
                    },
                    _ => None,
                })
                .expect("fixture must decode to structured tool-result content")
        };
        let opencode_blocks = result_blocks(&opencode.messages);
        let pi_blocks = result_blocks(&pi.messages);
        let kind_vector = |blocks: &[crate::ck_wire::ResultBlock]| {
            blocks
                .iter()
                .map(|block| match &block.kind {
                    ResultBlockKind::Text { .. } => "text",
                    ResultBlockKind::Media { .. } => "media",
                    ResultBlockKind::Opaque { .. } => "opaque",
                })
                .collect::<Vec<_>>()
        };

        assert_eq!(kind_vector(&opencode_blocks), kind_vector(&pi_blocks));
        assert_eq!(
            kind_vector(&opencode_blocks),
            vec!["text", "media", "opaque", "opaque"]
        );
        assert!(matches!(
            (&opencode_blocks[0].kind, &pi_blocks[0].kind),
            (
                ResultBlockKind::Text { text: opencode_text },
                ResultBlockKind::Text { text: pi_text }
            ) if opencode_text == pi_text
        ));

        let mut opencode_message = opencode.messages[0].ck.clone();
        opencode_message
            .content
            .iter_mut()
            .find(|block| matches!(&block.kind, CkKind::ToolResult { .. }))
            .unwrap()
            .mark_modified();
        opencode_message.mark_modified();
        let opencode_encoded = encode_opencode(&[opencode_message], &opencode.sidecar, None);
        let opencode_children = &opencode_encoded[0]["parts"][0]["state"]["attachments"];

        let mut pi_message = pi.messages[0].ck.clone();
        pi_message.content[0].mark_modified();
        pi_message.mark_modified();
        let pi_encoded = encode_pi(&[pi_message], &pi.sidecar);
        let pi_children = &pi_encoded[0]["content"];

        assert_eq!(
            serde_json::to_vec(opencode_children).unwrap(),
            serde_json::to_vec(pi_children).unwrap()
        );
    }

    #[test]
    fn codec_conformance_removes_leading_native_blocks_without_reindex_drift() {
        let opencode_raw = vec![json!({
            "info": { "id": "msg-tools", "role": "assistant" },
            "parts": [
                {
                    "type": "tool",
                    "callID": "call-a",
                    "tool": "first",
                    "state": { "status": "pending", "input": {} }
                },
                { "type": "text", "text": "survivor" }
            ]
        })];
        let opencode_decoded = decode_opencode(&opencode_raw);
        let mut opencode_message = opencode_decoded.messages[0].ck.clone();
        opencode_message.content.remove(0);
        assert_eq!(
            encode_opencode(&[opencode_message], &opencode_decoded.sidecar, None,)[0]["parts"],
            json!([{ "type": "text", "text": "survivor" }])
        );

        let pi_raw = vec![json!({
            "role": "assistant",
            "content": [
                { "type": "toolCall", "id": "call-a", "name": "first", "arguments": {} },
                { "type": "text", "text": "survivor" }
            ],
            "timestamp": 1
        })];
        let pi_decoded = decode_pi(&pi_raw);
        let mut pi_message = pi_decoded.messages[0].ck.clone();
        pi_message.content.remove(0);
        assert_eq!(
            encode_pi(&[pi_message], &pi_decoded.sidecar)[0]["content"],
            json!([{ "type": "text", "text": "survivor" }])
        );
    }

    fn assert_coverage_or_recorded_missing(
        actual: &[String],
        recorded_missing: &[String],
        required: &[&str],
    ) {
        let actual: BTreeSet<&str> = actual.iter().map(String::as_str).collect();
        let recorded_missing: BTreeSet<&str> =
            recorded_missing.iter().map(String::as_str).collect();
        let unresolved: Vec<&str> = required
            .iter()
            .copied()
            .filter(|item| !actual.contains(item) && !recorded_missing.contains(item))
            .collect();
        assert!(
            unresolved.is_empty(),
            "codec golden neither covers nor records missing classes: {unresolved:?}"
        );
    }

    fn strip_opencode_compaction(mut messages: Vec<Value>) -> Vec<Value> {
        for message in &mut messages {
            let Some(parts) = message.get_mut("parts").and_then(Value::as_array_mut) else {
                continue;
            };
            parts.retain(|part| part.get("type").and_then(Value::as_str) != Some("compaction"));
        }
        messages
    }

    fn strip_pi_compaction(entries: Vec<Value>) -> Vec<Value> {
        entries
            .into_iter()
            .filter(|entry| entry.get("type").and_then(Value::as_str) != Some("compaction"))
            .collect()
    }
    #[test]
    fn fixture_builder_drives_synthetic_todo_wire_shape() {
        let fixture = FixtureBuilder::synthetic_todo_armed();
        assert_eq!(fixture.native_messages.len(), 2);
        assert!(fixture
            .native_messages
            .iter()
            .all(|message| message["meta"]["synthetic"] == true));
        assert_eq!(fixture.state_import()["kind"], "state_import");
    }
}
