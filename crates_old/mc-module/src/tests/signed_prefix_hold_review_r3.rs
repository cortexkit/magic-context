// A signed reasoning block is bound to the request bytes preceding it. Removing
// every reasoning block permits a prefix rewrite without retaining invalid signatures.
// These tests check that such removals persist, that unchanged heads do not cause
// needless removals, and that signed requests fit or are refused. Included after the
// earlier review files in transform.rs's test module to share their temporary-session
// helpers. No provider, daemon, or live session is contacted.

fn review_r3_reasoning_count(response: &TransformResponse) -> usize {
    response
        .messages()
        .iter()
        .flat_map(|message| &message.content)
        .filter(|block| is_reasoning_block(block))
        .count()
}

fn review_r3_delete_m1(sim: &ReviewSession) {
    let mut loaded = sim.s().load(&sim.session).unwrap();
    loaded.core.frozen_units.retain(|unit| unit.key != "m1");
    sim.s()
        .commit(&sim.session, loaded.row_version, &loaded.core, &loaded.meta)
        .unwrap();
}

#[test]
fn review_r3_reset_replays_original_ingress_after_restart_and_next_turn() {
    let mut sim = ReviewSession::new(REVIEW_BOUND, true, false, "r3-persist");
    sim.messages[1]
        .ck
        .content
        .insert(0, review_reasoning("older turn"));
    sim.run(false).unwrap();
    for step in 0..3 {
        sim.tool_step();
        if step == 0 {
            let assistant = &mut sim.messages[3];
            assistant.ck.content.insert(
                1,
                CkWireBlock::bare(ck_wire::CkKind::RedactedReasoning {
                    data: "opaque-signed-thinking".to_string(),
                }),
            );
        }
        sim.run(false).unwrap();
    }
    let mut rng = ReviewRng(7);
    assert!(sim.publish(&mut rng));
    sim.used = 66_000;
    let before = sim.run(false).unwrap();
    assert_eq!(review_r3_reasoning_count(&before), 5);
    review_r3_delete_m1(&sim);
    let reset = sim.run(false).unwrap();
    assert!(reset.signed_thinking_reset);
    assert_eq!(review_r3_reasoning_count(&reset), 0);
    let removed: BTreeSet<_> = sim
        .s()
        .load(&sim.session)
        .unwrap()
        .core
        .frozen_units
        .iter()
        .filter_map(|unit| {
            unit.key
                .strip_prefix("strip:reasoning_age:")
                .map(str::to_owned)
        })
        .collect();
    let expected: BTreeSet<_> = sim
        .messages
        .iter()
        .filter(|message| message.ck.content.iter().any(is_reasoning_block))
        .map(|message| message.mid.clone())
        .collect();
    assert_eq!(removed, expected);
    for restart in [false, true] {
        if restart {
            sim.reopen();
        }
        let replay = sim.run(false).unwrap();
        assert_eq!(review_bytes(&reset), review_bytes(&replay));
        assert_eq!(review_r3_reasoning_count(&replay), 0);
    }
    sim.user_turn();
    let next_turn = sim.run(false).unwrap();
    assert_eq!(review_r3_reasoning_count(&next_turn), 0);
    sim.reopen();
    let replay = sim.run(false).unwrap();
    assert_eq!(review_bytes(&next_turn), review_bytes(&replay));
    // Reasoning added after the reset must remain; earlier removed blocks stay absent.
    sim.tool_step();
    let continued = sim.run(false).unwrap();
    assert_eq!(review_r3_reasoning_count(&continued), 1);
    sim.reopen();
    assert_eq!(
        review_bytes(&continued),
        review_bytes(&sim.run(false).unwrap())
    );
    eprintln!("r3 persistence: all 4 strips durable at return (5 reasoning/redacted blocks); same-turn/reopen/next-turn replay exact; fresh thinking kept");
}

#[test]
fn review_r3_interruption_before_reset_commit_retries_without_mixed_state() {
    let (mut sim, _) = review_open_turn_with_publication("r3-crash");
    review_r3_delete_m1(&sim);
    let before = sim.s().load(&sim.session).unwrap();
    install_transform_attempt_hook(&sim.session, || {
        panic!("simulated interruption before reset commit")
    });
    let interrupted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sim.run(false)));
    assert!(interrupted.is_err());
    let after = sim.s().load(&sim.session).unwrap();
    assert_eq!(before.row_version, after.row_version);
    assert_eq!(before.core, after.core);
    sim.reopen();
    let reset = sim.run(false).unwrap();
    assert!(reset.signed_thinking_reset);
    assert_eq!(review_r3_reasoning_count(&reset), 0);
    sim.reopen();
    assert_eq!(review_bytes(&reset), review_bytes(&sim.run(false).unwrap()));
    eprintln!("r3 interruption: no partial state at precommit hook; reopened retry strips all and replays");
}

#[test]
fn review_r3_identical_served_head_after_missing_m1_must_not_reset() {
    let mut sim = ReviewSession::new(REVIEW_BOUND, true, false, "r3-identical");
    sim.run(false).unwrap();
    for _ in 0..3 {
        sim.tool_step();
        sim.run(false).unwrap();
    }
    let before = sim.run(false).unwrap();
    review_r3_delete_m1(&sim);
    let after = sim.run(false).unwrap();
    let head_same = review_head(&before) == review_head(&after);
    eprintln!("r3 H1 identical rebuild: head_same={head_same} reset={} reasoning_before={} reasoning_after={}", after.signed_thinking_reset, review_r3_reasoning_count(&before), review_r3_reasoning_count(&after));
    assert!(
        head_same,
        "fixture must rebuild the actual previously served head identically"
    );
    assert!(
        !after.signed_thinking_reset,
        "loss of cached m1 reset thinking even though served head bytes are identical"
    );
}

fn review_r3_over_window_prompt(subagent: bool, label: &str) -> ReviewSession {
    let mut sim = ReviewSession::new(REVIEW_BOUND, true, subagent, label);
    sim.ctx.protected_tools.clear();
    let prompt = (0..17_000)
        .map(|n| format!("entry{n:05} value{n:05}\n"))
        .collect::<String>();
    sim.messages[2] = item("u3", 3, &prompt);
    sim.run(false).unwrap();
    for _ in 0..2 {
        sim.tool_step();
        sim.run(false).unwrap();
    }
    sim
}

#[test]
fn review_r3_untrusted_or_below_force_evidence_cannot_reset() {
    for (used, trusted) in [(95_000, false), (66_000, true)] {
        let mut sim = review_r3_over_window_prompt(false, &format!("r3-trust-{used}"));
        sim.used = used;
        let before = sim.run(false).unwrap();
        let mut request = sim.request(false);
        let usage = request.usage.as_mut().unwrap();
        usage.final_wire_trusted = trusted;
        usage.final_wire_input_tokens = 120_000;
        let after = transform(sim.s(), &request, &sim.ctx).unwrap();
        assert!(!after.signed_thinking_reset);
        let kept = sim.last_kept_reasoning_mid().unwrap();
        assert!(
            review_r2_prefix_through(&before, &kept) == review_r2_prefix_through(&after, &kept),
            "kept signed prefix changed"
        );
        assert_eq!(review_r3_reasoning_count(&after), 2);
        eprintln!("r3 M1 gate used={used} trusted={trusted}: no reset, signed prefix exact");
    }
}

#[test]
fn review_r3_fit_final_wire_evidence_must_not_be_overruled_by_text_estimate() {
    let mut sim = review_r3_over_window_prompt(false, "r3-fit-evidence");
    sim.used = 86_000;
    let mut request = sim.request(false);
    let usage = request.usage.as_mut().unwrap();
    usage.final_wire_trusted = true;
    usage.final_wire_input_tokens = 80_000;
    let response = transform(sim.s(), &request, &sim.ctx);
    eprintln!(
        "r3 M1 trusted count=80000 limit=100000: result={:?}",
        response
            .as_ref()
            .map(|r| (&r.action, r.signed_thinking_reset))
    );
    assert!(response.is_ok(), "a trusted fitting final-wire count was ignored in favor of an uncalibrated text estimate: {response:?}");
    assert!(!response.unwrap().signed_thinking_reset);
}

#[test]
fn review_r3_subagent_signed_tool_loop_at_wall_must_fit_or_refuse() {
    let mut sim = ReviewSession::new(REVIEW_BOUND, true, true, "r3-subagent-wall");
    sim.ctx.protected_tools.clear();
    sim.run(false).unwrap();
    let payload = (0..700)
        .map(|n| format!("entry{n:04} value{n:04}\n"))
        .collect::<String>();
    for _ in 0..22 {
        sim.tool_step();
        if let ck_wire::CkKind::ToolResult { output, .. } =
            &mut sim.messages.last_mut().unwrap().ck.content[0].kind
        {
            output.kind = ck_wire::CkOutputKind::Text {
                text: payload.clone(),
            };
        }
        sim.run(false).unwrap();
    }
    sim.tool_step();
    let baseline = sim.run(false).unwrap();
    let bound = review_r2_result_token_lower_bound(&baseline);
    assert!(bound > 100_000);
    let protected = active_thinking_prefix_edit_ids(
        &sim.s().load(&sim.session).unwrap().core,
        &sim.request(false),
    );
    assert!(sim.tool_results[..22]
        .iter()
        .all(|id| protected.contains(id)));
    sim.s()
        .append_pending_agent_drops(&sim.session, &sim.tool_results[..22], 1)
        .unwrap();
    sim.used = 95_000;
    let mut request = sim.request(false);
    let usage = request.usage.as_mut().unwrap();
    usage.final_wire_trusted = true;
    usage.final_wire_input_tokens = bound as u64;
    match transform(sim.s(), &request, &sim.ctx) {
        Err(error) => eprintln!("r3 subagent refused: {error:?}"),
        Ok(response) => {
            let remaining = review_r2_result_token_lower_bound(&response);
            eprintln!(
                "r3 subagent: action={} reset={} tool_tokens={remaining} pending={} reasoning={}",
                response.action,
                response.signed_thinking_reset,
                review_pending(sim.s(), &sim.session).len(),
                review_r3_reasoning_count(&response)
            );
            assert!(remaining <= 100_000, "subagent returned at least {remaining} tool-result tokens against 100000 instead of fitting or refusing");
        }
    }
}

#[test]
fn review_r3_new_seed_round_one_and_extended_drivers() {
    for steps in [70, 240] {
        let mut total = ReviewHeldStats::default();
        for (index, seed) in [
            0xCBBB_9D5D_C105_9ED8u64,
            0x629A_292A_367C_D507,
            0x9159_015A_3070_DD17,
            0x152F_ECD8_F70E_5939,
            0x6733_2667_FFC0_0B31,
            0x8EB4_4A87_6858_1511,
        ]
        .into_iter()
        .enumerate()
        {
            let model = if index % 2 == 0 {
                REVIEW_BOUND
            } else {
                REVIEW_BOUND_ALT
            };
            let stats = review_held_driver(seed ^ steps as u64, model, false, steps);
            total.passes += stats.passes;
            total.held += stats.held;
            total.releases += stats.releases;
            total.releases_with_work += stats.releases_with_work;
            total.pressure += stats.pressure;
            total.idle += stats.idle;
            total
                .in_turn_head_rewrites
                .extend(stats.in_turn_head_rewrites);
        }
        eprintln!("r3 held driver steps={steps}: {total:#?}");
        assert!(total.passes >= steps * 6);
        assert!(total.held >= steps * 4);
        assert!(total.releases_with_work >= 6);
        assert!(total.in_turn_head_rewrites.is_empty());
    }
}

#[test]
fn review_r3_signed_tool_call_input_over_window_must_fit_or_refuse() {
    let mut violations = Vec::new();
    for force_reset in [false, true] {
        let mut sim = ReviewSession::new(
            REVIEW_BOUND,
            true,
            false,
            &format!("r3-tool-input-{force_reset}"),
        );
        sim.ctx.protected_tools.clear();
        sim.run(false).unwrap();
        sim.tool_step();
        let payload = (0..17_000)
            .map(|n| format!("entry{n:05} value{n:05}\n"))
            .collect::<String>();
        let assistant = sim
            .messages
            .iter_mut()
            .find(|message| message.mid == "a4")
            .unwrap();
        let call = assistant
            .ck
            .content
            .iter_mut()
            .find(|block| matches!(block.kind, ck_wire::CkKind::ToolCall { .. }))
            .unwrap();
        if let ck_wire::CkKind::ToolCall { input, .. } = &mut call.kind {
            *input = json!({"content": payload});
        }
        sim.run(false).unwrap();
        sim.tool_step();
        sim.run(false).unwrap();
        sim.used = 95_000;
        let mut request = sim.request(false);
        let usage = request.usage.as_mut().unwrap();
        usage.final_wire_trusted = true;
        usage.final_wire_input_tokens = 120_000;
        if force_reset {
            review_r3_delete_m1(&sim);
        }
        match transform(sim.s(), &request, &sim.ctx) {
            Err(error) => eprintln!("r3 tool-input force_reset={force_reset} refused: {error:?}"),
            Ok(response) => {
                let inputs: usize = response
                    .messages()
                    .iter()
                    .flat_map(|message| &message.content)
                    .filter_map(|block| {
                        if let ck_wire::CkKind::ToolCall { input, .. } = &block.kind {
                            Some(mc_tokenizer::estimate_tokens(&input.to_string()))
                        } else {
                            None
                        }
                    })
                    .sum();
                eprintln!("r3 tool-input force_reset={force_reset}: action={} reset={} input_tokens={inputs} reasoning={}", response.action, response.signed_thinking_reset, review_r3_reasoning_count(&response));
                if inputs > 100_000 {
                    violations.push((force_reset, inputs));
                }
            }
        }
    }
    assert!(violations.is_empty(), "returned tool-call input tokens alone over 100000 instead of fitting or refusing: {violations:?}");
}
