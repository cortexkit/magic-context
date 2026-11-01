#[test]
fn temporal_admission_holds_rows_and_frontier_until_release() {
    for timestamps in [true, false] {
        let native = vec![
            json!({"info":{"id":"prior","role":"assistant","time":{"created":1000}},"parts":[{"type":"text","text":"prior"}]}),
            json!({"info":{"id":"question","role":"user","time":{"created":721000}},"parts":[{"type":"text","text":"question"}]}),
            json!({"info":{"id":"boundary","role":"assistant","time":{"created":722000}},"parts":[{"type":"reasoning","text":"kept","metadata":{"anthropic":{"signature":"signed"}}}]}),
        ];
        let mut request = active_opencode_req(
            "temporal-admission",
            "cfg",
            crate::codec::decode_opencode(&native).messages,
        );
        request.provider_id = Some("anthropic".into());
        request.model_key = Some("claude-opus-5-5".into());
        if !timestamps {
            for message in &mut request.messages {
                message.ck.meta.created_at_ms = None;
            }
        }
        let mut ctx = pctx("git:proj", "/nonexistent-docs", 723_000);
        ctx.signed_thinking_hold = crate::config::SignedThinkingHold::On;
        let core = CoreState::default();
        let mut tags = Arc::new(Vec::new());
        let mut rows = Vec::new();
        let compute = |req: &TransformRequest,
                       tags: &mut Arc<Vec<McTagRow>>,
                       rows: &mut Vec<TemporalMarkRow>| {
            compute_active_overlay_decisions(OverlayComputation {
                req,
                ctx: &ctx,
                projection: &project_messages(&req.messages).unwrap(),
                trusted_projection_prefix: None,
                core: &core,
                tag_rows: tags,
                temporal_rows: rows,
                overlay_frontier: None,
                tag_mint_enabled: true,
                temporal_enabled: true,
                rewrite_temporal_marks: true,
                mutation_exempt_mid: None,
                lineage_anchor_mid: None,
            })
            .unwrap()
        };
        let held = compute(&request, &mut tags, &mut rows);
        assert!(
            held.temporal_marks.is_empty(),
            "held marker entered the commit"
        );
        assert!(rows.is_empty(), "held marker entered this pass's renderer");
        assert_eq!(
            held.max_seen_ordinal, None,
            "frontier crossed a held marker"
        );
        assert!(!held.rewrite_temporal_marks);

        let mut released = request.clone();
        released.messages.push(crate::codec::decode_opencode(&[
            json!({"info":{"id":"next","role":"user"},"parts":[{"type":"text","text":"continue"}]})
        ]).messages.remove(0));
        released.messages.last_mut().unwrap().ordinal = 4;
        let applied = compute(&released, &mut tags, &mut rows);
        assert!(applied
            .temporal_marks
            .iter()
            .any(|mark| mark.block_id == "question#0"));
        if timestamps {
            assert_eq!(
                rows.iter()
                    .find(|row| row.block_id == "question#0")
                    .unwrap()
                    .marker_text,
                "<!-- +12m -->\n"
            );
        }
        assert_eq!(applied.max_seen_ordinal, Some(4));
        assert!(applied.rewrite_temporal_marks);

        let saved = rows
            .iter()
            .map(|row| (row.block_id.clone(), row.marker_text.clone()))
            .collect::<Vec<_>>();
        let replay = compute(&request, &mut tags, &mut rows);
        assert!(
            replay.temporal_marks.is_empty(),
            "frozen choices must not ask admission again"
        );
        assert!(!replay.rewrite_temporal_marks);
        assert_eq!(
            saved,
            rows.iter()
                .map(|row| (row.block_id.clone(), row.marker_text.clone()))
                .collect::<Vec<_>>()
        );
    }
}
