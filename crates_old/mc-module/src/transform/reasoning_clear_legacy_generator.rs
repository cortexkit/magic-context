// Run only against e2109bdc1d1f6fc0dd61c0b995083c12d700fe04, before reasoning-clear units existed.
// The generated database and encodings are input fixtures, not expectations recomputed by the fix.
#[test]
fn generate_pre_fix_reasoning_clear_fixture() {
    let native = vec![
        json!({"info":{"id":"user","role":"user"},"parts":[{"id":"u0","type":"text","text":"initial question"}]}),
        json!({"info":{"id":"already","role":"assistant","modelID":"fixture-model"},"parts":[
            {"id":"a0","type":"reasoning","text":"thinking-already","metadata":{"signature":"signature-already","custom":"retained"}},
            {"id":"a1","type":"text","text":"answer already"}]}),
        json!({"info":{"id":"gap","role":"user"},"parts":[{"id":"gap0","type":"text","text":"next question"}]}),
        json!({"info":{"id":"old","role":"assistant"},"parts":[
            {"id":"o0","type":"reasoning","text":"thinking-old","metadata":{"signature":"signature-old"}},
            {"id":"o1","type":"text","text":"answer old"}]}),
        json!({"info":{"id":"multipart-user","role":"user"},"parts":(0..13).map(|index|json!({"id":format!("m{index}"),"type":"text","text":format!("Additional user text part {index}")})).collect::<Vec<_>>()}),
    ];
    let decoded = crate::codec::decode_opencode(&native);
    let mut request = active_opencode_req("pre-fix-reasoning", "cfg0", decoded.messages);
    request.provider_id = Some("anthropic".to_string());
    request.serve_native = true;
    request.native_messages = Some(native);
    request.clear_reasoning_age = 10;
    request.auto_search_enabled = false;
    request = with_usage(request, 10_000, 100_000);
    let dir = tempfile::tempdir_in(".").unwrap();
    let db = store(dir.path());
    let mut ctx = pctx("git:fixture", "/nonexistent-docs", 0);
    ctx.temporal_awareness = false;
    transform_with_projection(&db, &request, &ctx).unwrap();
    request.render_config = "cfg1".to_string();
    let before = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(before.response.action, "HARD");
    let native_output = crate::encode_full_native_messages(
        &before.response,
        &request,
        before.reasoning_watermark,
        &before.tag_numbers,
        before.mutation_exempt_mid.as_deref(),
        before.lineage_anchor_mid.as_deref(),
        before.transition_consumed,
    );
    let fixture = json!({
        "generating_commit":"e2109bdc1d1f6fc0dd61c0b995083c12d700fe04",
        "request":request,"ck":before.response.messages(),"native":native_output,
        "row_version":before.response.row_version,"cutoff":before.reasoning_watermark
    });
    let output =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("gen/reasoning-clear-legacy");
    std::fs::create_dir_all(&output).unwrap();
    std::fs::write(
        output.join("pre-fix.json"),
        serde_json::to_vec_pretty(&fixture).unwrap(),
    )
    .unwrap();
    std::fs::write(
        output.join("pre-fix.ck.json"),
        serde_json::to_vec(before.response.messages()).unwrap(),
    )
    .unwrap();
    std::fs::write(
        output.join("pre-fix.native.json"),
        serde_json::to_vec(&native_output).unwrap(),
    )
    .unwrap();
    drop(db);
    std::fs::copy(dir.path().join("store.db"), output.join("pre-fix.sqlite")).unwrap();
    println!(
        "PRE-FIX fixture: cutoff={} native={}",
        before.reasoning_watermark, fixture["native"]
    );
}
