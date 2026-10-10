fn scored_fixture() -> (tempfile::TempDir, McStore, TransformRequest) {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    s.install_score_schema_for_test().unwrap();
    let compartments: Vec<_> = (1..=16)
        .map(|seq| {
            let mut row = comp(
                seq,
                seq,
                seq,
                &format!("m{seq}"),
                &format!("detail-P1-{seq};"),
            );
            row.p2 = Some(format!("detail-P2-{seq};"));
            row.p3 = Some(format!("detail-P3-{seq};"));
            row.p4 = Some(format!("detail-P4-{seq};"));
            row
        })
        .collect();
    s.replace_compartments("ses", &compartments).unwrap();
    let messages = (1..=17)
        .map(|seq| item(&format!("m{seq}"), seq as u64, "raw"))
        .collect();
    let mut request = with_usage(req("ses", "cfg0", messages), 10, 100);
    request.model_key = Some("provider/model-a".into());
    (dir, s, request)
}

fn mark_epoch(s: &McStore) {
    let mut loaded = s.load("ses").unwrap();
    loaded.meta.project_memory_epoch_pending = true;
    s.commit("ses", loaded.row_version, &loaded.core, &loaded.meta)
        .unwrap();
}

fn assert_applied(s: &McStore, watermark: i64, first_tier: u8) {
    let loaded = s.load("ses").unwrap();
    assert_eq!(loaded.meta.score_selection_watermark, watermark);
    let m0 = &loaded
        .core
        .frozen_units
        .iter()
        .find(|unit| unit.key == "m0")
        .unwrap()
        .frozen_payload;
    assert!(
        m0.contains(&format!("detail-P{first_tier}-1;")),
        "wrong independently expected tier: {m0}"
    );
    for tier in 1..=4 {
        if tier != first_tier {
            assert!(!m0.contains(&format!("detail-P{tier}-1;")));
        }
    }
}

#[test]
fn publication_and_two_epoch_marker_hards_keep_watermark_and_prefix() {
    let (_dir, s, request) = scored_fixture();
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    transform(&s, &request, &ctx).unwrap();
    let baseline = transform(&s, &request, &ctx).unwrap();
    assert_applied(&s, 0, 1);
    let before = s.load("ses").unwrap();
    let base_rows = s.load_compartments("ses").unwrap();
    s.publish_score_for_test("ses", 1, 1).unwrap();
    let published = s.load("ses").unwrap();
    assert_eq!(published.core, before.core);
    assert_eq!(published.meta, before.meta);
    assert_eq!(published.row_version, before.row_version);
    assert_eq!(s.load_compartments("ses").unwrap(), base_rows);
    let pending = transform(&s, &request, &ctx).unwrap();
    assert_ne!(pending.action, "HARD");
    assert_ne!(pending.action, "SOFT");
    assert_eq!(pending.messages(), baseline.messages());
    for _ in 0..2 {
        mark_epoch(&s);
        let hard = transform(&s, &request, &ctx).unwrap();
        assert_eq!(hard.action, "HARD");
        assert!(!hard.prefix_bust_permitted);
        assert_eq!(hard.messages(), baseline.messages());
        assert_applied(&s, 0, 1);
    }
}

#[test]
fn probe_uses_committed_view_and_writes_no_cache_state() {
    let (_dir, s, request) = scored_fixture();
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    transform(&s, &request, &ctx).unwrap();
    s.publish_score_for_test("ses", 1, 1).unwrap();
    let before = s.load("ses").unwrap();
    let probe = compose_hard_fold_m0(
        &s,
        &request,
        &ctx,
        None,
        mc_tokenizer::estimate_tokens,
        false,
        &mut crate::m0_compose::ComposeTimings::default(),
        before.meta.score_selection_watermark,
    )
    .unwrap();
    assert_eq!(probe.score_selection_watermark, 0);
    assert!(probe.m0_bytes.contains("detail-P1-1;"));
    let after = s.load("ses").unwrap();
    assert_eq!(after.core, before.core);
    assert_eq!(after.meta, before.meta);
    assert_eq!(after.row_version, before.row_version);
}

#[test]
fn ttl_and_model_cache_loss_adopt_latest_even_when_w_render_matches() {
    for ttl in [true, false] {
        let (_dir, s, mut request) = scored_fixture();
        let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
        transform(&s, &request, &ctx).unwrap();
        let baseline = transform(&s, &request, &ctx).unwrap();
        s.publish_score_for_test("ses", 1, 1).unwrap();
        let probe = compose_hard_fold_m0(
            &s,
            &request,
            &ctx,
            None,
            mc_tokenizer::estimate_tokens,
            false,
            &mut crate::m0_compose::ComposeTimings::default(),
            0,
        )
        .unwrap();
        assert_eq!(probe.m0_bytes, m0_bytes(&baseline));
        // The memory-epoch marker also requests a rebuild, but an expired cache
        // or a changed model must still adopt the pending score.
        mark_epoch(&s);
        if ttl {
            ctx.now_ms = 600_000;
            ctx.observed_last_response_at_ms = Some(1);
        } else {
            request.model_key = Some("provider/model-b".into());
        }
        let hard = transform(&s, &request, &ctx).unwrap();
        assert_eq!(hard.action, "HARD");
        assert!(hard.prefix_bust_permitted);
        assert_applied(&s, 1, 2);
        assert_ne!(m0_bytes(&hard), m0_bytes(&baseline));
    }
}

#[test]
fn first_fold_and_content_busting_marker_adopt_latest() {
    let (_dir, s, request) = scored_fixture();
    s.publish_score_for_test("ses", 1, 1).unwrap();
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    assert_eq!(transform(&s, &request, &ctx).unwrap().action, "HARD");
    assert_applied(&s, 1, 2);
    s.publish_score_for_test("ses", 2, 1).unwrap();
    s.with_context_conn_for_test(|tx| {
        tx.execute(
            "UPDATE compartments SET p1 = 'CONTENT BUST', content = 'CONTENT BUST'
                    WHERE session_id = 'ses' AND sequence = 16",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    mark_epoch(&s);
    let hard = transform(&s, &request, &ctx).unwrap();
    assert_eq!(hard.action, "HARD");
    assert!(hard.prefix_bust_permitted);
    assert_eq!(s.load("ses").unwrap().meta.score_selection_watermark, 2);
    assert!(m0_bytes(&hard).contains("CONTENT BUST"));
    assert!(m0_bytes(&hard).contains("detail-P2-2;"));
}

#[test]
fn undo_pending_across_restart_keeps_applied_view_until_cache_loss() {
    let (dir, s, request) = scored_fixture();
    s.publish_score_for_test("ses", 1, 1).unwrap();
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let applied = transform(&s, &request, &ctx).unwrap();
    s.with_context_conn_for_test(|tx| {
        tx.execute("INSERT INTO compartment_score_selections (session_id, compartment_id, sequence, origin)
                    SELECT 'ses', compartment_id, 2, 'undo' FROM compartment_score_revisions WHERE id = 1", [])?;
        Ok(())
    }).unwrap();
    drop(s);
    let s = store(dir.path());
    mark_epoch(&s);
    let marker = transform(&s, &request, &ctx).unwrap();
    assert_eq!(marker.action, "HARD");
    assert!(!marker.prefix_bust_permitted);
    assert_eq!(m0_bytes(&marker), m0_bytes(&applied));
    assert_applied(&s, 1, 2);
    let mut changed = request.clone();
    changed.model_key = Some("provider/model-b".into());
    transform(&s, &changed, &ctx).unwrap();
    assert_applied(&s, 2, 1);
}

#[test]
fn soft_new_compartment_stays_p1_and_does_not_adopt_pending_scores() {
    let (_dir, s, mut request) = scored_fixture();
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    transform(&s, &request, &ctx).unwrap();
    let baseline = transform(&s, &request, &ctx).unwrap();
    s.publish_score_for_test("ses", 1, 1).unwrap();
    s.append_compartments("ses", &[comp(17, 17, 17, "m17", "NEW P1")])
        .unwrap();
    request.messages.push(item("m18", 18, "tail"));
    let soft = transform(&s, &with_usage(request, 70, 100), &ctx).unwrap();
    assert_eq!(soft.action, "SOFT");
    assert_eq!(m0_bytes(&soft), m0_bytes(&baseline));
    assert!(m1_bytes(&soft).contains("NEW P1"));
    assert_applied(&s, 0, 1);
}

#[test]
fn compose_snapshot_cas_keeps_late_publication_pending() {
    let (_dir, s, mut request) = scored_fixture();
    let s = std::sync::Arc::new(s);
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    transform(&s, &request, &ctx).unwrap();
    s.publish_score_for_test("ses", 1, 1).unwrap();
    let publisher = std::sync::Arc::clone(&s);
    s.after_score_snapshot_for_test(move || {
        publisher.publish_score_for_test("ses", 2, 1).unwrap();
    });
    request.model_key = Some("provider/model-b".into());
    let hard = transform(&s, &request, &ctx).unwrap();
    assert_eq!(hard.action, "HARD");
    assert!(hard.committed);
    assert_applied(&s, 1, 2);
    assert!(m0_bytes(&hard).contains("detail-P1-2;"));
    assert!(!m0_bytes(&hard).contains("detail-P2-2;"));
    assert_eq!(
        s.load_compartment_score_snapshot("ses", mc_store::ScoreSelector::Latest)
            .unwrap()
            .watermark,
        2
    );
}

#[test]
fn sidecar_tables_have_no_module_write_or_fingerprint_ownership() {
    for table in [
        "compartment_score_revisions",
        "compartment_score_selections",
    ] {
        assert!(!crate::host_store::DOMAIN_TABLES.contains(&table));
    }
}

#[test]
fn fixed_schedule_score_projection_matches_shared_parity_fixture() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../testdata/score-projection-parity.json")).unwrap();
    let (_dir, s, mut request) = scored_fixture();
    let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
    ctx.history_budget_tokens = fixture["historyBudgetTokens"].as_f64().unwrap();
    let mut last_fold = String::new();
    for (index, step) in fixture["steps"].as_array().unwrap().iter().enumerate() {
        match index {
            0 => {
                last_fold = m0_bytes(&transform(&s, &request, &ctx).unwrap()).to_string();
            }
            1 => {
                s.publish_score_for_test("ses", 1, 100).unwrap();
                s.publish_score_for_test("ses", 2, 1).unwrap();
            }
            2 => {
                s.with_context_conn_for_test(|tx| {
                tx.execute("UPDATE compartments SET p1 = 'CHANGED-P1-2;' WHERE session_id = 'ses' AND sequence = 2", [])?;
                Ok(())
            }).unwrap();
            }
            3 => {
                request.model_key = Some("provider/model-b".into());
                let hard = transform(&s, &request, &ctx).unwrap();
                assert_eq!(hard.action, "HARD");
                last_fold = m0_bytes(&hard).to_string();
            }
            4 => {
                s.with_context_conn_for_test(|tx| {
                tx.execute("INSERT INTO compartment_score_selections (session_id, compartment_id, sequence, origin)
                            SELECT 'ses', compartment_id, 3, 'undo' FROM compartment_score_revisions WHERE id = 1", [])?;
                Ok(())
            }).unwrap();
            }
            5 => {
                s.publish_score_for_test("ses", 3, 100).unwrap();
            }
            _ => unreachable!(),
        }
        let snapshot = s
            .load_compartment_score_snapshot("ses", mc_store::ScoreSelector::Latest)
            .unwrap();
        let scores: Vec<_> = snapshot
            .compartments
            .iter()
            .map(|row| {
                snapshot
                    .importance_by_sequence
                    .get(&row.sequence)
                    .copied()
                    .unwrap_or(row.importance)
            })
            .collect();
        assert_eq!(
            serde_json::to_value(scores).unwrap(),
            step["effective"],
            "{}",
            step["name"]
        );
        assert_eq!(snapshot.watermark, step["latest"].as_i64().unwrap());
        assert_eq!(
            s.load("ses").unwrap().meta.score_selection_watermark,
            step["applied"].as_i64().unwrap()
        );
        if let Some(tiers) = step["tiers"].as_array() {
            for (row, tier) in tiers.iter().enumerate() {
                let seq = row + 1;
                let tier = tier.as_u64().unwrap();
                assert!(
                    last_fold.contains(&format!("detail-P{tier}-{seq};")),
                    "{} row {seq}, tier {tier}: {last_fold}",
                    step["name"]
                );
            }
        }
        if index == 1 || index >= 4 {
            let replay = transform(&s, &request, &ctx).unwrap();
            assert_ne!(replay.action, "HARD");
            assert_eq!(m0_bytes(&replay), last_fold);
        }
    }
}
