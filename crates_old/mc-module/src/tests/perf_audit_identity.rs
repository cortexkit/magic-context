//! Independent pre-optimization digest references for the ownership/encoding changes.

use super::*;

#[test]
fn borrowed_overlay_identity_fields_match_owned_reference() {
    let mut overlay = TagOverlayState::default();
    overlay.tag_by_block_id.insert("m#0".into(), 17);
    overlay
        .temporal_by_block_id
        .insert("m#0".into(), "date\0é".into());
    overlay
        .user_hint_by_block_id
        .insert("m#0".into(), "hint\n\"".into());
    overlay
        .channel1_by_block_id
        .insert("m#0".into(), "§17§".into());
    for (overlay, id) in [
        (None, "m#0"),
        (Some(&overlay), "m#0"),
        (Some(&overlay), "absent"),
    ] {
        let mut actual = Sha256::new();
        digest_overlay_identity_fields(&mut actual, overlay, id);
        let mut expected = Sha256::new();
        for value in [
            overlay
                .and_then(|overlay| overlay.tag_by_block_id.get(id))
                .map(ToString::to_string),
            overlay.and_then(|overlay| overlay.temporal_by_block_id.get(id).cloned()),
            overlay.and_then(|overlay| overlay.user_hint_by_block_id.get(id).cloned()),
            overlay.and_then(|overlay| overlay.channel1_by_block_id.get(id).cloned()),
        ] {
            let bytes = value.as_deref().unwrap_or_default().as_bytes();
            expected.update(bytes.len().to_le_bytes());
            expected.update(bytes);
        }
        assert_eq!(actual.finalize(), expected.finalize());
    }
}
