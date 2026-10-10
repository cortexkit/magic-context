// Transform-level tests for rescored compartment importance (see
// `docs/designs/compartment-rescore.md`).
//
// Terms used below:
// - m0 is the frozen history head of the cached prompt; see "m[0]/m[1] cache
//   layout" in ARCHITECTURE.md.
// - The applied watermark (`ModuleMeta::score_selection_watermark`, "W" in test
//   names and messages) is the highest score selection rendered into m0.
// - A marker HARD is a rebuild requested because content may have changed (here
//   a pending project-memory epoch, set by `mark_epoch`), not because the
//   provider's cache was lost. It must re-render at W and keep the prefix.
// - Each fixture compartment N stores tier text `detail-P<tier>-N;` for tiers
//   P1 (fullest) to P4 (shortest), so the tier the decay curve picked shows up
//   in m0. In this fixture compartment 1 renders at P1 with its original score
//   and at P2 once rescored to importance 1.
//
// Tests prefixed `review_` cover concurrent publication, commit failure,
// pre-rescore stores and downgrade refusal.
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
        // The probe above renders m0 at the applied watermark (score selection 0)
        // and matches the bytes already served. The memory-epoch marker also
        // requests a rebuild. An expired cache TTL or a different model means the
        // provider no longer holds the cached prefix, so keeping the old bytes saves
        // nothing and the rebuild must adopt the pending score.
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
        if let Some(expected_pressure) = step["pressure"].as_f64() {
            let decay_inputs: Vec<_> = scores
                .iter()
                .enumerate()
                .map(|(index, importance)| mc_core::decay::DecayInput {
                    index: (scores.len() - index) as u32,
                    importance: *importance,
                })
                .collect();
            let pressure =
                mc_core::decay::compute_budget_pressure(&decay_inputs, ctx.history_budget_tokens);
            assert!(
                (pressure - expected_pressure).abs() < 1e-10,
                "{}: Rust pressure {pressure} != fixture {expected_pressure}",
                step["name"]
            );
        }
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

#[test]
fn review_marker_publication_between_probe_and_cas_keeps_exact_applied_render() {
    let (_dir, s, request) = scored_fixture();
    let s = std::sync::Arc::new(s);
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    s.publish_score_for_test("ses", 1, 1).unwrap();
    transform(&s, &request, &ctx).unwrap();
    let baseline = transform(&s, &request, &ctx).unwrap();
    assert_applied(&s, 1, 2);
    mark_epoch(&s);
    let publisher = std::sync::Arc::clone(&s);
    s.after_score_snapshot_for_test(move || {
        publisher.publish_score_for_test("ses", 2, 1).unwrap();
    });
    let marker = transform(&s, &request, &ctx).unwrap();
    assert_eq!(marker.action, "HARD");
    assert!(marker.committed);
    assert!(!marker.prefix_bust_permitted);
    assert_eq!(marker.messages(), baseline.messages());
    assert_applied(&s, 1, 2);
    assert_eq!(
        s.load_compartment_score_snapshot("ses", mc_store::ScoreSelector::Latest)
            .unwrap()
            .watermark,
        2
    );
}

#[test]
fn review_score_cas_retry_recomposes_bytes_and_watermark_together() {
    let (_dir, s, mut request) = scored_fixture();
    let s = std::sync::Arc::new(s);
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    transform(&s, &request, &ctx).unwrap();
    let before = s.load("ses").unwrap();
    s.publish_score_for_test("ses", 1, 1).unwrap();
    let competitor = std::sync::Arc::clone(&s);
    s.after_score_snapshot_for_test(move || {
        competitor.publish_score_for_test("ses", 2, 1).unwrap();
        mark_epoch(&competitor);
    });
    request.model_key = Some("provider/model-b".into());
    let hard = transform(&s, &request, &ctx).unwrap();
    assert_eq!(hard.action, "HARD");
    assert!(hard.committed);
    assert_applied(&s, 2, 2);
    assert!(m0_bytes(&hard).contains("detail-P2-2;"));
    assert!(!m0_bytes(&hard).contains("detail-P1-2;"));
    assert_eq!(
        s.load("ses").unwrap().row_version,
        Some(before.row_version.unwrap() + 2)
    );
}

#[test]
fn review_two_score_writers_cannot_commit_stale_render_after_newer_fold() {
    let (_dir, first, mut request) = scored_fixture();
    let first = std::sync::Arc::new(first);
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    transform(&first, &request, &ctx).unwrap();
    first.publish_score_for_test("ses", 1, 1).unwrap();
    let second = std::sync::Arc::clone(&first);
    request.model_key = Some("provider/model-b".into());
    let (arrived_tx, arrived_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    first.after_score_snapshot_for_test(move || {
        arrived_tx.send(()).unwrap();
        resume_rx
            .recv_timeout(std::time::Duration::from_secs(30))
            .unwrap();
    });
    std::thread::scope(|scope| {
        let delayed = scope.spawn(|| transform(&first, &request, &ctx).unwrap());
        arrived_rx
            .recv_timeout(std::time::Duration::from_secs(30))
            .unwrap();
        second.publish_score_for_test("ses", 2, 1).unwrap();
        let winner = transform(&second, &request, &ctx).unwrap();
        assert_eq!(winner.action, "HARD");
        assert_applied(&second, 2, 2);
        let winning_version = second.load("ses").unwrap().row_version;
        resume_tx.send(()).unwrap();
        let retried = delayed.join().unwrap();
        assert_ne!(retried.action, "HARD");
        assert_eq!(retried.messages(), winner.messages());
        assert_eq!(first.load("ses").unwrap().row_version, winning_version);
        assert_applied(&first, 2, 2);
    });
}

#[test]
fn review_score_render_commit_failure_rolls_back_bytes_and_watermark() {
    let (dir, s, mut request) = scored_fixture();
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    transform(&s, &request, &ctx).unwrap();
    let baseline = transform(&s, &request, &ctx).unwrap();
    let before = s.load("ses").unwrap();
    s.publish_score_for_test("ses", 1, 1).unwrap();
    request.model_key = Some("provider/model-b".into());
    mc_store::cache_codec::fail_next_commit_after_section_writes();
    let failure = transform(&s, &request, &ctx).unwrap_err();
    assert!(matches!(failure, TransformError::Store(_)), "{failure}");
    drop(s);
    let s = store(dir.path());
    let recovered = s.load("ses").unwrap();
    assert_eq!(recovered.core, before.core);
    assert_eq!(recovered.meta, before.meta);
    assert_eq!(recovered.row_version, before.row_version);
    assert_applied(&s, 0, 1);
    let retry = transform(&s, &request, &ctx).unwrap();
    assert_eq!(retry.action, "HARD");
    assert_ne!(m0_bytes(&retry), m0_bytes(&baseline));
    assert_applied(&s, 1, 2);
}

#[test]
fn review_pre_v98_session_installing_score_tables_does_not_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    s.replace_compartments("ses", &[comp(1, 1, 1, "m1", "OLD BASE")])
        .unwrap();
    let request = with_usage(
        req(
            "ses",
            "cfg0",
            vec![item("m1", 1, "raw"), item("m2", 2, "tail")],
        ),
        10,
        100,
    );
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    transform(&s, &request, &ctx).unwrap();
    let before = transform(&s, &request, &ctx).unwrap();
    s.install_score_schema_for_test().unwrap();
    let after = transform(&s, &request, &ctx).unwrap();
    assert_ne!(after.action, "HARD");
    assert_eq!(after.messages(), before.messages());
    let meta = s.load("ses").unwrap().meta;
    assert_eq!(meta.score_selection_watermark, 0);
    assert!(!serde_json::to_value(meta)
        .unwrap()
        .as_object()
        .unwrap()
        .contains_key("score_selection_watermark"));
}

#[test]
fn review_downgrade_meta_rewrite_must_not_adopt_unserved_scores_on_marker_hard() {
    let (dir, s, request) = scored_fixture();
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    s.publish_score_for_test("ses", 1, 1).unwrap();
    transform(&s, &request, &ctx).unwrap();
    let baseline = transform(&s, &request, &ctx).unwrap();
    assert_applied(&s, 1, 2);
    s.publish_score_for_test("ses", 2, 1).unwrap();
    assert_eq!(
        s.module_store_schema_version().unwrap(),
        mc_store::LATEST_MIGRATION_VERSION
    );
    drop(s);
    let before = std::fs::read(dir.path().join("store.db")).unwrap();
    // This opener carries only store.db migrations through v63, the newest that
    // the last ck-mc build released before score support knows. That build does
    // not know the `score_selection_watermark` meta key (W), so a metadata rewrite
    // by it would drop W while keeping the rescored m0. It must refuse this store
    // (now at the newest version) before it can rewrite anything. context.db's own
    // table-shape compatibility checks are separate and do not override this
    // store.db refusal.
    let descriptor = crate::test_support::descriptor(dir.path());
    let Err(refusal) = McStore::open_with_schema_ceiling_for_test(&descriptor, 63) else {
        panic!("the pre-rescore writer must be refused before it can discard W");
    };
    assert!(
        matches!(refusal, mc_store::McStoreError::StoreAheadOfBinary {
        db_version, binary_max: 63,
    } if db_version == mc_store::LATEST_MIGRATION_VERSION)
    );
    assert_eq!(std::fs::read(dir.path().join("store.db")).unwrap(), before);
    let reopened = store(dir.path());
    assert_applied(&reopened, 1, 2);
    let replay = transform(&reopened, &request, &ctx).unwrap();
    assert_ne!(replay.action, "HARD");
    assert_eq!(replay.messages(), baseline.messages());
    mark_epoch(&reopened);
    let marker = transform(&reopened, &request, &ctx).unwrap();
    assert_eq!(marker.action, "HARD");
    assert!(!marker.prefix_bust_permitted);
    assert_eq!(marker.messages(), baseline.messages());
    assert_applied(&reopened, 1, 2);
    assert!(m0_bytes(&marker).contains("detail-P1-2;"));
    assert!(!m0_bytes(&marker).contains("detail-P2-2;"));
}

#[test]
fn review_pressure_refold_commits_latest_snapshot_not_late_publication() {
    let (_dir, s, mut request) = scored_fixture();
    let s = std::sync::Arc::new(s);
    let memory_ids = seed_pressure_memory(&s);
    let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
    transform(&s, &request, &ctx).unwrap();
    s.publish_score_for_test("ses", 1, 1).unwrap();
    add_pressure_memory_updates(&s, &memory_ids);
    let publisher = std::sync::Arc::clone(&s);
    s.after_score_snapshot_for_test(move || {
        publisher.publish_score_for_test("ses", 2, 1).unwrap();
    });
    ctx.now_ms = 50;
    request = with_usage(request, 70, 100);
    let refold = transform(&s, &request, &ctx).unwrap();
    assert_eq!(refold.action, "HARD");
    assert_eq!(
        refold.materialize_reason.as_deref(),
        Some("pressure_refold")
    );
    assert!(refold.committed);
    assert_applied(&s, 1, 2);
    assert!(m0_bytes(&refold).contains("detail-P1-2;"));
    assert!(!m0_bytes(&refold).contains("detail-P2-2;"));
    assert_eq!(
        s.load_compartment_score_snapshot("ses", mc_store::ScoreSelector::Latest)
            .unwrap()
            .watermark,
        2
    );
}
