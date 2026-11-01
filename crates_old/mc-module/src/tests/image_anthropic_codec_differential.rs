// The Claude Code leg of `anthropic_image_sessions_match_base_without_new_behavior`,
// entered as `anthropic-messages` runner entries through the provider codec
// instead of as hand-built CK messages. The engine must serve the same messages
// (roles and block kinds, codec sidecars aside) at every step, and the codec must
// render them back to Anthropic messages, unchanged ones as the runner's own values.
#[test]
fn anthropic_image_sessions_through_the_messages_codec_match_the_ck_corpus() {
    use crate::providers::codec::{Codec, InboundMessage};
    use crate::providers::codec_anthropic::encode_message;

    fn shape(messages: &[ServedMessage]) -> Value {
        messages
            .iter()
            .map(|message| {
                let message: &CkWireMessage = message;
                json!({"role": message.role, "content": message.content.iter().map(|b| &b.kind).collect::<Vec<_>>()})
            })
            .collect()
    }
    fn entries(with_image: bool) -> Vec<InboundMessage> {
        let mut old = vec![json!({"type":"text","text":"old user prompt"})];
        if with_image {
            old.push(json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"x".repeat(300)}}));
        }
        [
            ("head", json!({"role":"user","content":[{"type":"text","text":"older history"}]})),
            ("old", json!({"role":"user","content":old})),
            ("answer", json!({"role":"assistant","content":[{"type":"text","text":"processed"}]})),
            ("dropper", json!({"role":"user","content":[{"type":"text","text":"spent"}]})),
        ]
        .into_iter()
        .enumerate()
        .map(|(ordinal, (mid, message))| InboundMessage {
            ordinal: ordinal as u64,
            mid: mid.into(),
            message,
        })
        .collect()
    }
    // One session, four snapshots: baseline, a reduction with a config bust, and two
    // steady passes, exactly as the CK differential runs them.
    fn snapshots(through_codec: bool, with_image: bool) -> Vec<Vec<ServedMessage>> {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let mut request = if through_codec {
            let mut request = req("anthropic-image-differential", "cfg0", Vec::new());
            Codec::AnthropicMessages
                .prepare_request(&mut request, &entries(with_image))
                .unwrap();
            assert_eq!(request.serializer_profile, "claude-code-anthropic");
            request
        } else {
            let mut old = item("old", 1, "old user prompt");
            if with_image {
                old.ck.content.push(CkWireBlock::bare(ck_wire::CkKind::Media(
                    ck_wire::MediaBlock {
                        kind: ck_wire::MediaKind::Image,
                        media_type: "image/png".into(),
                        filename: None,
                        source: json!({"type": "data_base64", "data": "x".repeat(300)}),
                    },
                )));
            }
            let mut request = req(
                "anthropic-image-differential",
                "cfg0",
                vec![
                    item("head", 0, "older history"),
                    old,
                    wire_item("assistant", "answer", 2, &["processed"]),
                    item("dropper", 3, "spent"),
                ],
            );
            request.serializer_profile = "claude-code-anthropic".into();
            request
        };
        request.provider_id = Some("anthropic".into());
        let mut out = vec![run(&s, &request, &spine()).messages().to_vec()];
        s.seed_tags_for_test(
            &request.session_id,
            &[
                mc_store::TagMintInput {
                    block_id: "old#0".into(),
                    kind: "message".into(),
                    token_count: 3,
                    source_bytes: b"old user prompt".to_vec(),
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
        request.render_config = "cfg1".into();
        out.push(run(&s, &request, &[reduce("dropper#0", "drop", "")]).messages().to_vec());
        for _ in 0..2 {
            out.push(run(&s, &request, &spine()).messages().to_vec());
        }
        out
    }
    for with_image in [false, true] {
        let direct = snapshots(false, with_image);
        let through = snapshots(true, with_image);
        assert_eq!(direct.len(), 4);
        for (step, (direct, through)) in direct.iter().zip(&through).enumerate() {
            assert_eq!(shape(direct), shape(through), "image {with_image} step {step}");
        }
        // The codec renders every served message; the untouched history head comes
        // back as the runner's own entry.
        let native = entries(with_image);
        for snapshot in &through {
            let rendered = snapshot
                .iter()
                .map(|message| encode_message(message).unwrap())
                .collect::<Vec<_>>();
            assert!(rendered.contains(&native[0].message), "{rendered:?}");
        }
    }
}
