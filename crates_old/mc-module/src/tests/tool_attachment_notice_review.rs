#[test]
fn attachment_review_empty_synthesized_url_has_a_visible_notice() {
    let block = ResultBlock {
        kind: ResultBlockKind::Media {
            media: MediaBlock {
                kind: MediaKind::Image,
                media_type: "image/png".into(),
                filename: Some("screen.png".into()),
                source: json!({"type": "url", "url": ""}),
            },
        },
        provider_extras: ProviderExtras::new(),
    };
    let output = CkToolOutput::bare(CkOutputKind::Content {
        blocks: vec![block],
    });
    let (status, text) = output_status_text(&output);
    assert_eq!(status, "completed");
    assert_eq!(
        text, "[attachment not shown: image/png (screen.png)]",
        "a synthesized empty URL is not an encodable attachment"
    );
    assert!(output_attachments(&output).is_empty());
}
