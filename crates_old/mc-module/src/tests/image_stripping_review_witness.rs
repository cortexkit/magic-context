// A signed thinking block can authenticate all earlier conversation content. Removing an
// earlier image while replaying that signed block is therefore unsafe. The force-band
// rewrite must either retain the image or omit the signed block.

#[test]
fn image_stripping_review_witness_force_keeps_image_before_signed_thinking() {
    let mut sim = ReviewSession::new(REVIEW_BOUND, true, false, "image-before-thinking");
    sim.messages[2].ck.content = vec![CkWireBlock::bare(ck_wire::CkKind::Media(
        ck_wire::MediaBlock {
            kind: ck_wire::MediaKind::Image,
            media_type: "image/png".to_string(),
            filename: None,
            source: json!({"type": "data_base64", "data": "x".repeat(300)}),
        },
    ))];
    sim.run(false).unwrap();
    sim.tool_step();
    let held = sim.run(false).unwrap();
    assert!(
        held.messages()
            .iter()
            .any(|message| message.content.iter().any(image_block_is_large)),
        "control: an image was already served before the signed block"
    );
    assert!(
        review_serves_signature(&held, "think 4"),
        "control: the signed block was already served"
    );
    sim.s()
        .seed_tags_for_test(
            &sim.session,
            &[
                mc_store::TagMintInput {
                    block_id: "a4#1".into(),
                    kind: "message".into(),
                    token_count: 3,
                    source_bytes: b"note 4".to_vec(),
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
    let forced = sim.run(false).unwrap();
    let kept = review_serves_signature(&forced, "think 4");
    let image_present = forced
        .messages()
        .iter()
        .any(|message| message.content.iter().any(image_block_is_large));
    assert!(
        !kept || image_present,
        "action {} reason {:?}: image before still-kept signed thinking was stripped",
        forced.action,
        forced.materialize_reason
    );
}
