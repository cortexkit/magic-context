// These Anthropic sessions cover unchanged behavior: old tagged user images may be
// removed, with no child execution, nested tool media, protected range or signed-prefix hold.
#[test]
fn anthropic_image_sessions_match_base_without_new_behavior() {
    let mut captures = Vec::<Vec<u8>>::new();
    for profile in [
        "owned-llmrunner",
        "opencode-ai-sdk",
        "claude-code-anthropic",
        "pi",
    ] {
        for with_image in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let s = store(dir.path());
            let mut old = item("old", 1, "old user prompt");
            if with_image {
                old.ck
                    .content
                    .push(CkWireBlock::bare(ck_wire::CkKind::Media(
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
            request.serializer_profile = profile.into();
            request.provider_id = Some("anthropic".into());
            let baseline = run(&s, &request, &spine());
            captures.push(serde_json::to_vec(baseline.messages()).unwrap());
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
            let bust = run(&s, &request, &[reduce("dropper#0", "drop", "")]);
            captures.push(serde_json::to_vec(bust.messages()).unwrap());
            for _ in 0..2 {
                captures.push(serde_json::to_vec(run(&s, &request, &spine()).messages()).unwrap());
            }
        }
    }
    let bytes = serde_json::to_vec(&captures).unwrap();
    let digest = crate::digest::hex(&Sha256::digest(&bytes));
    println!(
        "Anthropic base differential: {} snapshots, {} bytes, SHA256 {digest}",
        captures.len(),
        bytes.len()
    );
    assert_eq!(captures.len(), 32);
    // Replayed the same corpus with transform.rs and its reasoning-clear tests from
    // 6dec81e7 (0.49.5), then compared all 32 serialized snapshots byte for byte.
    assert_eq!(
        digest,
        "b11d15048cff980a61f012d28c0a0303de7081cd62425f2fb34eabfa6536d1a4"
    );
}
