#[test]
fn attachment_review_screenshot_history_fits_projection_admission() {
    // 64 screenshots of 576 KiB each become 48 MiB of base64. This is below
    // both the 256 MiB staged-request cap and the stated 288 MiB projection cap.
    // Serialize/deserialize through the real ingress type: bare blocks would miss
    // the retained-original trees installed by the facade's JSON parser.
    let data = "A".repeat(768 * 1024);
    let native = (0..64).map(|i| json!({
        "info": {"id": format!("screen-{i}"), "role": "assistant"},
        "parts": [{"type": "tool", "tool": "computer_use", "callID": format!("call-{i}"), "state": {
            "status": "completed", "input": {}, "output": "Screenshot",
            "attachments": [{"type": "file", "mime": "image/jpeg", "url": format!("data:image/jpeg;base64,{data}"), "filename": "screen.jpg"}]
        }}]
    })).collect::<Vec<_>>();
    let ingress = codec::decode_opencode(&native).messages;
    let request = native_cache_request("attachment-review-memory", ingress, native, "fp");
    let request_bytes = serde_json::to_vec(&request).unwrap().len();
    assert!(request_bytes < TRANSFORM_PAGE_MAX_STAGED_BYTES);
    let mut old_messages = request.messages.clone();
    for message in &mut old_messages {
        let result = &mut message.ck.content[1];
        let CkKind::ToolResult { output, .. } = &mut result.kind else {
            panic!("result")
        };
        *output = CkToolOutput::bare(CkOutputKind::Text {
            text: "Screenshot".into(),
        });
        result.mark_modified();
        message.ck.mark_modified();
    }
    let old_charge = crate::ck_wire::project_messages(&old_messages)
        .unwrap()
        .retained_bytes();
    assert!(
        old_charge < PROJECTION_CACHE_ENTRY_BUDGET_BYTES,
        "the attachment-blind projection must fit as a regression control"
    );
    drop(old_messages);
    let projection = Arc::new(crate::ck_wire::project_messages(&request.messages).unwrap());
    let snapshot = ProjectionCacheSnapshot {
        context: projection_cache_context(&request),
        full_array_fingerprint: request.full_array_fingerprint.clone(),
        message_retained_bytes: Arc::new(vec![0; request.messages.len()]),
        projection,
    };
    let charge = snapshot.retained_bytes(&request.session_id);
    let mut cache = ProjectionCache::default();
    cache.replace(&request.session_id, 0, snapshot);
    eprintln!("screenshot history: request_bytes={request_bytes}, old_projection_charge={old_charge}, projection_charge={charge}, cap={PROJECTION_CACHE_ENTRY_BUDGET_BYTES}");
    assert!(cache.snapshot(&request.session_id, 0).is_some(), "48 MiB screenshot history is no longer delta-admissible: charge={charge}, cap={PROJECTION_CACHE_ENTRY_BUDGET_BYTES}");
}
