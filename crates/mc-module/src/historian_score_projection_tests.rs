// A published rescore changes which compartments the historian prompt picks as
// diverse calibration references and the importance they show, while the recent
// window (last four references, rendered without importance) and the stored
// compartment rows stay unchanged.
#[test]
fn historian_effective_scores_change_diverse_picks_not_recent_or_base_rows() {
    let (_dir, store) = store_for_tests();
    store.install_score_schema_for_test().unwrap();
    let rows: Vec<_> = [50, 10, 20, 30, 40, 50, 70, 90, 70, 90]
        .into_iter()
        .enumerate()
        .map(|(index, importance)| {
            let seq = index as i64 + 1;
            let mut row = stored_compartment(seq, seq, seq, &format!("m{seq}#0"));
            row.title = format!("Reference {seq}");
            row.importance = importance;
            row
        })
        .collect();
    store.replace_compartments("ses-ref", &rows).unwrap();
    let base = store.load_compartments("ses-ref").unwrap();
    let messages = vec![
        msg("m11", 11, "user", vec![text("new discussion")]),
        msg("m12", 12, "assistant", vec![text("new answer")]),
    ];
    let projection = project_messages(&messages).unwrap();
    let config = HistorianAssemblerConfig {
        expand_tools: BTreeMap::new(),
        model_limits: Default::default(),
        model_variants: Default::default(),
        session_id: "ses-ref".into(),
        project_path: "/proj".into(),
        project_slug: "proj".into(),
        model_chain: vec!["prov/model".into()],
        token_budget: 32_000,
        historian_context_limit_tokens: None,
        max_output_tokens: 32_000,
        boundary: crate::boundary::BoundaryResolution {
            protected_start_ordinal: 13,
            eligible_head: 0..13,
            n_tokens: 0.0,
            floored_by_live_prompt: false,
            fenced_by_open_arc: false,
            true_raw_eligible_tokens: 10_000.0,
            oversize_atomic_unit: false,
            raw_message_count: 2,
            boundary_reason: "test".into(),
        },
        memory_enabled: false,
        auto_promote: true,
        user_memory_collection_enabled: false,
        extraction_free: false,
        in_emergency: false,
        force_keep_last_compartment: false,
        fold_is_only_reclaim: false,
        failure_backoff_at_ms: 0,
        min_chunk_tokens: 0,
    };
    let assemble = || {
        let result = assemble_historian_firing(
            &store,
            &messages,
            &projection.blocks,
            &projection.identity_by_mid,
            config.clone(),
            1,
        )
        .unwrap();
        let AssembleHistorianFiringOutcome::Fire(firing) = result else {
            panic!("expected firing: {result:?}")
        };
        firing.prompt
    };
    let before = assemble();
    store.publish_score_for_test("ses-ref", 1, 99).unwrap();
    let after = assemble();
    let references: Vec<_> = base.iter().map(ReferenceCompartment::from).collect();
    let mut expected = references.clone();
    expected[0].importance = Some(99);
    let seeds = crate::historian_prompt::select_seeds("ses-ref", 11, SEED_FLOOR);
    let selected_base =
        crate::historian_prompt::select_session_references(&references, &seeds, "ses-ref", 11);
    let selected_effective =
        crate::historian_prompt::select_session_references(&expected, &seeds, "ses-ref", 11);
    assert_ne!(
        selected_base
            .iter()
            .map(|row| row.start_message)
            .collect::<Vec<_>>(),
        selected_effective
            .iter()
            .map(|row| row.start_message)
            .collect::<Vec<_>>()
    );
    let expected_block =
        crate::historian_prompt::render_session_references_block(&selected_effective);
    assert!(after.contains(&expected_block));
    assert_ne!(after, before);
    assert!(expected_block.contains("importance=\"99\""));
    let recent =
        crate::historian_prompt::render_session_references_block_window(&selected_effective, 4);
    assert!(!recent.contains("importance="));
    assert_eq!(
        selected_base[selected_base.len() - 4..],
        selected_effective[selected_effective.len() - 4..]
    );
    assert_eq!(store.load_compartments("ses-ref").unwrap(), base);
}
