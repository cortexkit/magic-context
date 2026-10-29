// Additional parity witnesses for inputs outside `pass_decision_vector_tests.rs`.

/// Extra decision vectors whose expected outputs were produced by calling the TypeScript
/// generator's own `decideVector` (packages/plugin/scripts/generate-pass-decision-vectors.ts)
/// on inputs the shipped 41 vectors do not cover. Each one goes through the same ck-mc
/// composition the shipped vector test uses (`ck_mc_pass_decision`).
#[test]
fn review_extra_pass_decision_vectors_match_the_typescript_reference() {
    let file: PassDecisionVectorFile = serde_json::from_str(include_str!(
        "review_extra_pass_decision_vectors.json"
    ))
    .expect("extra vectors parse");
    let mut mismatches = Vec::new();
    for vector in &file.vectors {
        let actual = ck_mc_pass_decision(&vector.inputs);
        if actual != vector.expected {
            mismatches.push(format!(
                "{}: TypeScript {:?}, ck-mc {:?}",
                vector.name, vector.expected, actual
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "ck-mc disagrees with the TypeScript reference on {} extra vector(s):\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}

/// TypeScript resets the held execute-pass count on every pass that is not a primary
/// execute pass holding queued work (`decideExecuteReclaim`), so the third-pass rule
/// counts consecutive execute passes. A scheduler Defer pass between two held execute
/// passes must replay its bytes and reset the count end to end, not only in the vector
/// composition.
#[test]
fn review_defer_pass_between_held_execute_passes_replays_and_resets_the_count() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let messages = vec![item("a", 1, "raw"), item("tail", 2, "small pending drop")];
    s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
        .unwrap();
    let execute = with_usage(req("ses", "cfg0", messages.clone()), 70_000, 100_000);
    let defer = with_usage(req("ses", "cfg0", messages), 20_000, 100_000);
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    transform(&s, &execute, &ctx).unwrap();
    let baseline = transform(&s, &execute, &ctx).unwrap();
    s.append_pending_agent_drops("ses", &["tail#0".to_string()], 1)
        .unwrap();
    for held in 1..=2u64 {
        let pass = transform(&s, &execute, &ctx).unwrap();
        assert_eq!(pass.ck_messages, baseline.ck_messages);
        assert_eq!(s.load("ses").unwrap().meta.execute_reclaim_held_passes, held);
    }
    let deferred = transform(&s, &defer, &ctx).unwrap();
    assert_eq!(deferred.scheduler_decision.as_deref(), Some("defer"));
    assert_eq!(
        serde_json::to_vec(&deferred.ck_messages).unwrap(),
        serde_json::to_vec(&baseline.ck_messages).unwrap(),
        "a defer pass holding queued drops replays its bytes"
    );
    assert_eq!(
        s.load("ses").unwrap().meta.execute_reclaim_held_passes,
        0,
        "a defer pass resets the held count, as TypeScript does"
    );
    // The count starts again: the next execute pass is the first held pass, not the third.
    let next = transform(&s, &execute, &ctx).unwrap();
    assert_eq!(next.ck_messages, baseline.ck_messages);
    assert_eq!(s.load("ses").unwrap().meta.execute_reclaim_held_passes, 1);
    assert_eq!(s.load_pending_agent_drops("ses").unwrap().len(), 1);
}

/// The held count survives a process restart (a new store handle over the same files),
/// so the third held pass still rebuilds after a restart in the middle of the count.
#[test]
fn review_held_count_survives_a_store_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let messages = vec![item("a", 1, "raw"), item("tail", 2, "small pending drop")];
    let request = with_usage(req("ses", "cfg0", messages), 70_000, 100_000);
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let baseline = {
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
            .unwrap();
        transform(&s, &request, &ctx).unwrap();
        let baseline = transform(&s, &request, &ctx).unwrap();
        s.append_pending_agent_drops("ses", &["tail#0".to_string()], 1)
            .unwrap();
        transform(&s, &request, &ctx).unwrap();
        transform(&s, &request, &ctx).unwrap();
        assert_eq!(s.load("ses").unwrap().meta.execute_reclaim_held_passes, 2);
        baseline
    };
    let s = store(dir.path());
    assert_eq!(s.load("ses").unwrap().meta.execute_reclaim_held_passes, 2);
    let third = transform(&s, &request, &ctx).unwrap();
    assert_ne!(third.ck_messages, baseline.ck_messages);
    assert!(s.load_pending_agent_drops("ses").unwrap().is_empty());
    assert_eq!(s.load("ses").unwrap().meta.execute_reclaim_held_passes, 0);
}

/// A stored record written before the field existed decodes to zero, and a zero count is
/// omitted on write, so sessions that never held keep their stored bytes.
#[test]
fn review_held_count_is_absent_from_old_and_zero_records() {
    let meta = mc_store::ModuleMeta::default();
    let encoded = serde_json::to_value(&meta).unwrap();
    assert!(encoded.get("execute_reclaim_held_passes").is_none());
    let decoded: mc_store::ModuleMeta = serde_json::from_value(encoded).unwrap();
    assert_eq!(decoded.execute_reclaim_held_passes, 0);
    let held = mc_store::ModuleMeta {
        execute_reclaim_held_passes: 2,
        ..Default::default()
    };
    let round = serde_json::to_value(&held).unwrap();
    assert_eq!(round["execute_reclaim_held_passes"], 2);
}

/// The rewritten `force_episode_empty_tool_lane_and_pressure_escape_controls` now ends
/// every escape with a flush below the force band, which applies the aged arc whatever
/// the escape did. This keeps the escape's own claim: a priced escape (a flush, a render
/// identity change or a published fold) re-arms the spent force episode on that pass, as
/// the TypeScript `emergencyEpisodeRearms` does.
#[test]
fn review_priced_escape_rearms_the_spent_force_episode() {
    for escape in ["refresh", "hard", "fold"] {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        bootstrap_covering_a(&s);
        let context = smart_pctx();
        let mut request = with_usage(
            req(
                "ses",
                "cfg0",
                vec![
                    item("a", 1, "raw"),
                    item("old", 3, &caveman_test_source("old")),
                ],
            ),
            90_000,
            100_000,
        );
        request.caveman_enabled = true;
        request.caveman_min_chars = 1;
        request.protected_tokens_effective = Some(0);
        transform(&s, &request, &context).unwrap();
        request
            .messages
            .push(assistant_tool_call("late", 4, "late"));
        request
            .messages
            .push(tool_result("late-result", 5, "late", &"x".repeat(20_000)));
        for usage in [90_200, 90_300] {
            request = with_usage(request, usage, 100_000);
            transform(&s, &request, &context).unwrap();
        }
        age_episode_tools_past_newest_three(&s);
        let mut loaded = s.load("ses").unwrap();
        assert!(
            loaded.meta.has_prior_emergency_drop,
            "escape {escape}: the episode is spent before the escape"
        );
        loaded.meta.last_execute_ordinal = 5;
        if escape == "refresh" {
            loaded.meta.soft_refresh_pending = true;
        }
        s.commit("ses", loaded.row_version, &loaded.core, &loaded.meta)
            .unwrap();
        match escape {
            "hard" => request.render_config = "cfg-changed".to_string(),
            "fold" => s
                .append_compartments("ses", &[comp(2, 2, 3, "old#0", "published fold")])
                .unwrap(),
            _ => {}
        }
        transform(&s, &request, &context).unwrap();
        assert!(
            !s.load("ses").unwrap().meta.has_prior_emergency_drop,
            "escape {escape}: a priced escape re-arms the spent force episode"
        );
    }
}
