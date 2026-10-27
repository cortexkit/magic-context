// Shared per-pass rebuild decision vectors. The TypeScript plugin is the reference: the
// expected outputs in `pass-decision-vectors.json` are generated from its gates by
// `packages/plugin/scripts/generate-pass-decision-vectors.ts`. This test feeds the same
// inputs to ck-mc's decision code (`pass_rides`, `decide_execute_reclaim`,
// `producer_gate`, `selection_pass_class` and `selection::lane_gates`), composed in the
// order `apply_once` composes them, and requires the same outputs.

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

#[derive(Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PassDecisionVectorOutputs {
    busts: bool,
    origin: Option<String>,
    lanes: Vec<String>,
    held_passes_after: u64,
}

/// The execute threshold whose derived force band is the vectors' 85%.
const PASS_DECISION_VECTOR_EXECUTE_THRESHOLD: f64 = 65.0;

fn ck_mc_pass_decision(inputs: &PassDecisionVectorInputs) -> PassDecisionVectorOutputs {
    // The async provider's request shape: every preset except `head` is a subagent.
    let is_subagent = inputs.preset != compaction::Preset::Head;
    let first_render = inputs.cache_loss == "firstRender";
    let idle_ttl_fired = inputs.cache_loss == "idleExpiry";
    if inputs.compaction_off {
        // `apply_once` hands compaction-off passes to `apply_additive_only`, which never
        // selects reductions: only an additive m0/m1 fold changes the head.
        return PassDecisionVectorOutputs {
            busts: inputs.executed_fold,
            origin: inputs.executed_fold.then(|| "executedFold".to_string()),
            lanes: Vec::new(),
            held_passes_after: if inputs.executed_fold {
                0
            } else {
                inputs.queued_drops.held_passes_before
            },
        };
    }
    let usage = inputs.usage_percent;
    let pass = match scheduler::derive_band_with_hard_wall(
        usage,
        usage,
        PASS_DECISION_VECTOR_EXECUTE_THRESHOLD,
    ) {
        scheduler::Band::Emergency95 => scheduler::PassDecision::Emergency95,
        scheduler::Band::Force85 => scheduler::PassDecision::Force85,
        // The scheduler turns an expired cache into Execute.
        scheduler::Band::Normal if inputs.scheduler == "execute" || idle_ttl_fired => {
            scheduler::PassDecision::Execute
        }
        scheduler::Band::Normal => scheduler::PassDecision::Defer,
    };
    let force_band_active = usage >= inputs.force_percent;
    let force_episode = force_episode_available(
        force_band_active,
        inputs.emergency_episode_spent,
        false,
        false,
        false,
    );
    let m1_changed = inputs.published_history;
    let ride_inputs = PassRideInputs {
        is_subagent,
        pass,
        raw_rebuild: false,
        prefix_materialization_enabled: !is_subagent,
        initialized: !first_render,
        render_config_changed: false,
        cached_m1_missing: false,
        hard_fold_prices_mutations: inputs.executed_fold,
        idle_only_hard_fold: idle_ttl_fired && !inputs.executed_fold,
        reconcile_hard_due: false,
        lineage_force_hard: false,
        m1_changed,
        flush_armed: inputs.flush,
        signed_prefix_hold: false,
        idle_ttl_fired,
        open_signed_turn: false,
        head_rebuild_forced: false,
        force_episode_available: force_episode,
    };
    let rides = pass_rides(&ride_inputs);
    let queued = inputs.queued_drops.eligible_tokens > 0.0;
    let execute_reclaim_candidate = !is_subagent
        && pass == scheduler::PassDecision::Execute
        && !rides.supersession_ride_available
        && queued;
    let execute_reclaim = if execute_reclaim_candidate {
        decide_execute_reclaim(&ExecuteReclaimInputs {
            held_passes: inputs.queued_drops.held_passes_before,
            primary_execute: true,
            summary_can_come: inputs.historian_in_flight || inputs.summary_pending,
            already_busting: false,
            reclaimable_tokens: inputs.queued_drops.eligible_tokens,
            usable_window: inputs.usable_window,
        })
    } else {
        ExecuteReclaimDecision {
            held_passes: 0,
            admitted: false,
        }
    };
    let pass_already_busting = rides.supersession_ride_available || execute_reclaim.admitted;
    let pass_class = if producer_gate(pass, producer_hard_advisory(&ride_inputs)) {
        selection_pass_class(pass)
    } else {
        PassClass::Defer
    };
    let selection_ctx = SelectionContext {
        calibration: None,
        pass_class,
        current_total_input_tokens: usage * 1_000.0,
        ceiling_tokens: 100_000.0 * PASS_DECISION_VECTOR_EXECUTE_THRESHOLD / 100.0,
        last_execute_ordinal: 0,
        scheduler_pressure_execute: false,
        prior_input_sample: 0.0,
        has_prior_drop: inputs.emergency_episode_spent,
        agent_drop_ids: Vec::new(),
        agent_drop_command_ids: HashMap::new(),
        first_applied_agent_drop_ids: HashSet::new(),
        pass_already_busting,
        supersession_ride_available: pass_already_busting,
        emergency_minimum_waived: rides.independent_rebuild,
        emergency_window_yields: pass == scheduler::PassDecision::Emergency95,
        tag_window_protected_block_ids: HashSet::new(),
        exempt_message_protected_block_ids: HashSet::new(),
    };
    let mut lanes = Vec::new();
    if pass_class != PassClass::Defer {
        let agent_drops_applied =
            queued && crate::selection::lane_gates(&selection_ctx, false).agent_drops;
        let gates = crate::selection::lane_gates(&selection_ctx, agent_drops_applied);
        let work = &inputs.pending_work;
        for (name, applies) in [
            ("queuedDrops", agent_drops_applied),
            ("emergencyDrop", gates.emergency && work.emergency_drop),
            ("dedup", gates.dedup && work.dedup),
            ("ageSweep", gates.age_sweep && work.age_sweep),
            ("supersession", gates.supersession && work.supersession),
        ] {
            if applies {
                lanes.push(name.to_string());
            }
        }
    }
    // A fold, a first render or an idle fold, and a published m1 refresh rewrite the head
    // by themselves; every other ride only permits lanes that find work.
    let rewrites_by_itself = (!is_subagent
        && (inputs.executed_fold || first_render || idle_ttl_fired))
        || (m1_changed && pass != scheduler::PassDecision::Defer);
    let busts = rewrites_by_itself || !lanes.is_empty();
    let origins = [
        ("cacheLoss", !is_subagent && (first_render || idle_ttl_fired)),
        ("executedFold", !is_subagent && inputs.executed_fold),
        (
            "publishedHistory",
            !is_subagent && m1_changed && pass != scheduler::PassDecision::Defer,
        ),
        ("flush", inputs.flush),
        (
            "force",
            force_episode || pass == scheduler::PassDecision::Emergency95,
        ),
        ("primaryExecuteNoSummary", execute_reclaim.admitted),
        (
            "subagentExecute",
            is_subagent && rides.subagent_execute_permitted,
        ),
    ];
    PassDecisionVectorOutputs {
        busts,
        origin: busts
            .then(|| {
                origins
                    .iter()
                    .find(|(_, active)| *active)
                    .map(|(name, _)| name.to_string())
            })
            .flatten(),
        lanes,
        held_passes_after: if busts { 0 } else { execute_reclaim.held_passes },
    }
}

#[test]
fn pass_decision_vectors_match_the_typescript_reference() {
    let file: PassDecisionVectorFile = serde_json::from_str(include_str!(
        "../../../../packages/plugin/src/hooks/magic-context/pass-decision-vectors.json"
    ))
    .expect("pass decision vectors parse");
    assert_eq!(
        scheduler::escalation_bands(PASS_DECISION_VECTOR_EXECUTE_THRESHOLD)
            .force_materialize_percentage,
        85.0
    );
    let mut checked = 0;
    let mut mismatches = Vec::new();
    for vector in &file.vectors {
        assert_eq!(
            vector.inputs.force_percent, 85.0,
            "{}: the vectors use the default force band",
            vector.name
        );
        // ck-mc reads provider-measured usage only; a local-count reading never reaches it.
        if vector.inputs.usage_from_estimate {
            continue;
        }
        checked += 1;
        let actual = ck_mc_pass_decision(&vector.inputs);
        if actual != vector.expected {
            mismatches.push(format!(
                "{}: expected {:?}, ck-mc {:?}",
                vector.name, vector.expected, actual
            ));
        }
    }
    assert!(checked >= 35, "only {checked} vectors checked");
    assert!(
        mismatches.is_empty(),
        "ck-mc disagrees with the TypeScript reference on {} vector(s):\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}
