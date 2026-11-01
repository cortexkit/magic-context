// Shared per-pass rebuild decision vectors. The TypeScript plugin is the reference: the
// expected outputs in `pass-decision-vectors.json` are generated from its gates by
// `packages/plugin/scripts/generate-pass-decision-vectors.ts`.
//
// Compaction-on vectors drive `PassDecision`, the decision entry `apply_once` itself calls
// (rides, summary_can_come, the bounded execute exception, the selection permission, the
// rebuild origin and the stored held count), and `selection::lane_gates`, which
// `select_reductions_with_outcome` calls. Compaction-off vectors run a real `transform`
// with compaction disabled. The vector inputs that stand for lane candidates ("this lane has
// work") and exact queued-drop masses cannot be built from transcripts, so the only glue
// here is "a lane applies when it is admitted and has work" and "a pass rebuilds when its
// head is rewritten anyway or a lane applies".

#[derive(serde::Deserialize)]
struct PassDecisionVectorFile {
    vectors: Vec<PassDecisionVector>,
}

#[derive(serde::Deserialize)]
struct PassDecisionVector {
    name: String,
    inputs: PassDecisionVectorInputs,
    expected: PassDecisionVectorOutputs,
}

fn pass_decision_default_true() -> bool {
    true
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PassDecisionVectorInputs {
    preset: compaction::Preset,
    compaction_off: bool,
    scheduler: String,
    usage_percent: f64,
    force_percent: f64,
    usable_window: f64,
    usage_from_estimate: bool,
    historian_in_flight: bool,
    summary_pending: bool,
    queued_drops: PassDecisionQueuedDrops,
    emergency_episode_spent: bool,
    executed_fold: bool,
    flush: bool,
    published_history: bool,
    cache_loss: String,
    #[serde(default)]
    refold_keeps_prefix: bool,
    #[serde(default)]
    signed_thinking_hold: bool,
    #[serde(default = "pass_decision_default_true")]
    force_trigger_permitted: bool,
    #[serde(default)]
    signed_prefix_rewrite: bool,
    #[serde(default)]
    served_shape_repair: bool,
    #[serde(default)]
    already_ran_this_turn: bool,
    #[serde(default)]
    routine_pressure_already_applied: bool,
    pending_work: PassDecisionPendingWork,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PassDecisionQueuedDrops {
    eligible_tokens: f64,
    held_passes_before: u64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PassDecisionPendingWork {
    emergency_drop: bool,
    dedup: bool,
    age_sweep: bool,
    supersession: bool,
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PassDecisionVectorOutputs {
    busts: bool,
    origin: Option<String>,
    lanes: Vec<String>,
    held_passes_after: u64,
}

/// The execute threshold whose derived force band is the vector's force band: 65% for the
/// default 85% band, `force - 2` for a higher band (`scheduler::escalation_bands`).
fn pass_decision_execute_threshold(force_percent: f64) -> f64 {
    if force_percent > 85.0 {
        force_percent - 2.0
    } else {
        65.0
    }
}

fn ck_mc_pass_decision(inputs: &PassDecisionVectorInputs) -> PassDecisionVectorOutputs {
    if inputs.compaction_off {
        return ck_mc_compaction_off_pass(inputs);
    }
    // The async provider's request shape: every preset except `head` is a subagent.
    let is_subagent = inputs.preset != compaction::Preset::Head;
    let hold = inputs.signed_thinking_hold;
    let first_render = inputs.cache_loss == "firstRender";
    let idle_ttl_fired = inputs.cache_loss == "idleExpiry";
    let usage = inputs.usage_percent;
    let threshold = pass_decision_execute_threshold(inputs.force_percent);
    assert_eq!(
        scheduler::escalation_bands(threshold).force_materialize_percentage,
        inputs.force_percent
    );
    let pass = match scheduler::derive_band_with_hard_wall(usage, usage, threshold) {
        scheduler::Band::Emergency95 => scheduler::PassDecision::Emergency95,
        scheduler::Band::Force85 => scheduler::PassDecision::Force85,
        // The scheduler turns an expired cache into Execute.
        scheduler::Band::Normal if inputs.scheduler == "execute" || idle_ttl_fired => {
            scheduler::PassDecision::Execute
        }
        scheduler::Band::Normal => scheduler::PassDecision::Defer,
    };
    let force_band_active = usage >= inputs.force_percent;
    let initialized = !first_render;
    // Inputs with no ck-mc state of their own: a refold that keeps the served prefix prices
    // nothing (it is no ride in either leg); the once-per-execute-stretch routine latch and
    // the served-shape repair lane exist only in TypeScript (see the skip and extra-lane
    // tables below).
    let _no_ck_mc_state = (
        inputs.refold_keeps_prefix,
        inputs.already_ran_this_turn,
        inputs.routine_pressure_already_applied,
        inputs.served_shape_repair,
    );
    // Head facts as `apply_once` derives them. Kept signed thinking under the strict hold
    // protects the prefix and enables trigger parking; a parked force trigger is the
    // `force_episode` held release.
    let head_rebuild_forced = !is_subagent && !initialized;
    let head_replay_impossible = head_rebuild_forced;
    let signed_prefix_hold = hold
        && !signed_drains_released(force_band_active, pass, idle_ttl_fired, false, head_replay_impossible);
    let force_episode_held = hold && !inputs.force_trigger_permitted;
    let force_episode_available = force_episode_available(
        force_band_active,
        inputs.emergency_episode_spent,
        hold,
        hold,
        force_episode_held,
    );
    let decision = PassDecision::new(PassDecisionFacts {
        rides: PassRideInputs {
            is_subagent,
            pass,
            raw_rebuild: false,
            prefix_materialization_enabled: !is_subagent && !hold,
            initialized,
            render_config_changed: false,
            cached_m1_missing: false,
            // A refold that reproduces the served prefix keeps the provider cache, so it
            // prices nothing (`marker_hard_keeps_provider_cache`).
            hard_fold_prices_mutations: inputs.executed_fold,
            idle_only_hard_fold: idle_ttl_fired && !inputs.executed_fold,
            reconcile_hard_due: false,
            lineage_force_hard: false,
            m1_changed: inputs.published_history,
            flush_armed: inputs.flush,
            signed_prefix_hold,
            signed_thinking_reset: inputs.signed_prefix_rewrite,
            idle_ttl_fired,
            open_signed_turn: hold,
            head_rebuild_forced,
            force_episode_available,
        },
        emergency_latched: inputs.emergency_episode_spent || (hold && force_episode_held),
        historian_active: inputs.historian_in_flight,
        wrapup_active: false,
        signed_head_frozen: inputs.summary_pending,
        publication_waiting: inputs.summary_pending,
        has_pending_agent_drops: inputs.queued_drops.eligible_tokens > 0.0,
        held_passes_before: inputs.queued_drops.held_passes_before,
        usable_window: inputs.usable_window,
        tail_reclaim_enabled: true,
    });
    let verdict = decision
        .execute_reclaim_candidate
        .then(|| decision.admit_execute_reclaim(inputs.queued_drops.eligible_tokens));
    let admitted = verdict.is_some_and(|verdict| verdict.admitted);
    let pass_already_busting = decision.pass_already_busting(admitted, false);
    let gates = decision.selection_gates(pass_already_busting, false);
    let selection_ctx = SelectionContext {
        calibration: None,
        pass_class: decision.selection_class(false),
        current_total_input_tokens: usage * 1_000.0,
        ceiling_tokens: 100_000.0 * threshold / 100.0,
        last_execute_ordinal: 0,
        scheduler_pressure_execute: false,
        prior_input_sample: 0.0,
        has_prior_drop: gates.has_prior_drop,
        agent_drop_ids: Vec::new(),
        agent_drop_command_ids: HashMap::new(),
        first_applied_agent_drop_ids: HashSet::new(),
        pass_already_busting: gates.pass_already_busting,
        supersession_ride_available: gates.supersession_ride_available,
        emergency_minimum_waived: gates.emergency_minimum_waived,
        emergency_window_yields: gates.emergency_window_yields,
        tag_window_protected_block_ids: HashSet::new(),
        exempt_message_protected_block_ids: HashSet::new(),
    };
    let mut lanes = Vec::new();
    if selection_ctx.pass_class != PassClass::Defer {
        let queued = inputs.queued_drops.eligible_tokens > 0.0;
        let agent_drops_applied =
            queued && crate::selection::lane_gates(&selection_ctx, false).agent_drops;
        let admitted_lanes = crate::selection::lane_gates(&selection_ctx, agent_drops_applied);
        let work = &inputs.pending_work;
        for (name, applies) in [
            ("queuedDrops", agent_drops_applied),
            ("emergencyDrop", admitted_lanes.emergency && work.emergency_drop),
            ("dedup", admitted_lanes.dedup && work.dedup),
            ("ageSweep", admitted_lanes.age_sweep && work.age_sweep),
            ("supersession", admitted_lanes.supersession && work.supersession),
        ] {
            if applies {
                lanes.push(name.to_string());
            }
        }
    }
    let busts = decision.rewrites_head() || !lanes.is_empty();
    PassDecisionVectorOutputs {
        busts,
        origin: decision.origin(admitted, busts).map(str::to_string),
        lanes,
        held_passes_after: decision.held_passes_after(verdict, busts),
    }
}

/// A compaction-off pass through the real `transform` (`apply_additive_only`). The
/// session holds the vector's queued drop and spent episode; an executed fold is a model
/// switch with new memory, which refolds the additive m0.
fn ck_mc_compaction_off_pass(inputs: &PassDecisionVectorInputs) -> PassDecisionVectorOutputs {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let session = "compaction-off-vector";
    s.insert_memory(memory_input("git:proj", "ARCHITECTURE", "baseline memory", 0))
        .unwrap();
    let mut request = active_opencode_req(
        session,
        "cfg0",
        vec![item("a", 1, "raw"), item("tail", 2, "pending drop")],
    );
    request.is_subagent = inputs.preset != compaction::Preset::Head;
    request.model_key = Some("provider/model-a".to_string());
    let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
    ctx.compaction_enabled = false;
    ctx.execute_threshold_percentage = pass_decision_execute_threshold(inputs.force_percent);
    let usage = |request: TransformRequest| {
        with_usage(request, (inputs.usage_percent * 1_000.0) as u64, 100_000)
    };
    transform(&s, &request, &ctx).unwrap();
    let baseline = transform(&s, &usage(request.clone()), &ctx).unwrap();
    if inputs.queued_drops.eligible_tokens > 0.0 {
        s.append_pending_agent_drops(session, &["tail#0".to_string()], 1)
            .unwrap();
    }
    let mut loaded = s.load(session).unwrap();
    loaded.meta.execute_reclaim_held_passes = inputs.queued_drops.held_passes_before;
    loaded.meta.has_prior_emergency_drop = inputs.emergency_episode_spent;
    loaded.meta.soft_refresh_pending = inputs.flush;
    s.commit(session, loaded.row_version, &loaded.core, &loaded.meta)
        .unwrap();
    if inputs.executed_fold {
        s.insert_memory(memory_input("git:proj", "CONSTRAINTS", "folded memory", 1))
            .unwrap();
        request.model_key = Some("provider/model-b".to_string());
    }
    let pending_before = s.load_pending_agent_drops(session).unwrap().len();
    let pass = transform(&s, &usage(request), &ctx).unwrap();
    let busts = serde_json::to_vec(pass.messages()).unwrap()
        != serde_json::to_vec(baseline.messages()).unwrap();
    let after = s.load(session).unwrap();
    let mut lanes = Vec::new();
    if s.load_pending_agent_drops(session).unwrap().len() < pending_before
        || after
            .core
            .frozen_units
            .iter()
            .any(|unit| unit.key.starts_with("red:"))
    {
        lanes.push("queuedDrops".to_string());
    }
    PassDecisionVectorOutputs {
        busts,
        origin: (busts && pass.action == "HARD").then(|| "executedFold".to_string()),
        lanes,
        held_passes_after: after.meta.execute_reclaim_held_passes,
    }
}

/// Vectors whose TypeScript input ck-mc cannot take. Each names the missing state and why
/// the difference never costs ck-mc a rebuild TypeScript avoids.
const PASS_DECISION_SKIPPED_VECTORS: &[(&str, &str)] = &[
    (
        "subagent-force-band-estimate-only",
        "ck-mc reads provider-measured usage only; a local-count reading never reaches it",
    ),
    (
        "primary-force-band-estimate-only",
        "ck-mc reads provider-measured usage only; a local-count reading never reaches it",
    ),
    (
        "primary-served-shape-repair",
        "ck-mc has no served-shape repair lane (it never serves the OpenCode empty text slot), \
         so it has no such rebuild to share; queued work rides its next ride instead",
    ),
];

/// Vectors where ck-mc applies one extra lane on a pass that rebuilds anyway. The lane adds
/// cleanup to that rebuild; it never makes ck-mc rebuild where TypeScript holds.
const PASS_DECISION_EXTRA_LANES: &[(&str, &str, &str)] = &[
    (
        "primary-idle-expiry-routine-already-applied",
        "dedup",
        "ck-mc has no once-per-execute-stretch routine latch (TypeScript \
         routinePressureAlreadyApplied / alreadyRanThisTurn); the pass is an expired-cache \
         rewrite anyway",
    ),
    (
        "primary-signed-prefix-rewrite",
        "dedup",
        "TypeScript runs heuristics on a signed-prefix rewrite only on an execute pass that has \
         not run them this turn; ck-mc admits dedup on every rebuilding pass, and this pass \
         rewrites the prefix anyway",
    ),
];

#[test]
fn pass_decision_vectors_match_the_typescript_reference() {
    let file: PassDecisionVectorFile = serde_json::from_str(include_str!(
        "../../../../packages/plugin/src/hooks/magic-context/pass-decision-vectors.json"
    ))
    .expect("pass decision vectors parse");
    let mut checked = 0;
    let mut mismatches = Vec::new();
    for vector in &file.vectors {
        if PASS_DECISION_SKIPPED_VECTORS
            .iter()
            .any(|(name, _)| *name == vector.name)
        {
            continue;
        }
        assert!(
            !vector.inputs.usage_from_estimate,
            "{}: estimate-only vectors must be listed as skipped",
            vector.name
        );
        checked += 1;
        let mut expected = vector.expected.clone();
        if let Some((_, lane, _)) = PASS_DECISION_EXTRA_LANES
            .iter()
            .find(|(name, _, _)| *name == vector.name)
        {
            assert!(
                expected.busts,
                "{}: an extra lane may only ride a pass that rebuilds anyway",
                vector.name
            );
            expected.lanes.push((*lane).to_string());
            let order = ["queuedDrops", "emergencyDrop", "dedup", "ageSweep", "supersession"];
            expected
                .lanes
                .sort_by_key(|lane| order.iter().position(|known| known == lane));
        }
        let actual = ck_mc_pass_decision(&vector.inputs);
        if actual != expected {
            mismatches.push(format!(
                "{}: expected {:?}, ck-mc {:?}",
                vector.name, expected, actual
            ));
        }
    }
    assert!(checked >= 50, "only {checked} vectors checked");
    assert!(
        mismatches.is_empty(),
        "ck-mc disagrees with the TypeScript reference on {} vector(s):\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}
